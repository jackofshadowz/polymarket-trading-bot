/**
 * FUNDING RATE ORACLE
 *
 * Fetches BTC perpetual funding rate from Binance as sentiment indicator.
 * Positive funding = bullish sentiment (longs paying shorts)
 * Negative funding = bearish sentiment (shorts paying longs)
 *
 * Gemini-recommended alpha signal for 15-minute BTC markets.
 */

const https = require('https');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  CACHE_TTL_MS: 30000,      // 30 seconds (funding updates every 8 hours, so caching is fine)
  TIMEOUT_MS: 3000,         // 3 second timeout
  RATE_LIMIT_MS: 200,       // Minimum time between requests

  // Interpretation thresholds (in percentage points)
  THRESHOLDS: {
    EXTREME_BULLISH: 0.05,   // > 0.05% = overbought, contrarian NO
    BULLISH: 0.01,           // 0.01-0.05% = bullish sentiment
    BEARISH: -0.01,          // -0.01 to -0.05% = bearish sentiment
    EXTREME_BEARISH: -0.05   // < -0.05% = oversold, contrarian YES
  }
};

// ============================================================
// CACHE STATE
// ============================================================

let cachedRate = null;
let lastFetchTime = 0;

// ============================================================
// MAIN FUNCTION
// ============================================================

/**
 * Get current BTC funding rate from Binance
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Object>} Funding rate signal
 */
async function getFundingRate(forceRefresh = false) {
  const now = Date.now();

  // Return cached if valid and not forcing refresh
  if (!forceRefresh && cachedRate && (now - lastFetchTime) < CONFIG.CACHE_TTL_MS) {
    return { ...cachedRate, cached: true };
  }

  // Rate limit check
  if ((now - lastFetchTime) < CONFIG.RATE_LIMIT_MS) {
    return cachedRate ? { ...cachedRate, cached: true } : { signal: 'NEUTRAL', confidence: 0 };
  }

  return new Promise((resolve) => {
    const options = {
      hostname: 'fapi.binance.com',
      path: '/fapi/v1/fundingRate?symbol=BTCUSDT&limit=1',
      method: 'GET',
      timeout: CONFIG.TIMEOUT_MS
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          if (!Array.isArray(parsed) || parsed.length === 0) {
            throw new Error('Invalid response format');
          }

          const rate = parseFloat(parsed[0]?.fundingRate || 0);
          const signal = interpretFundingRate(rate);

          // Update cache
          cachedRate = signal;
          lastFetchTime = now;

          // Log for monitoring
          console.log(JSON.stringify({
            action: 'FUNDING_RATE_FETCHED',
            rate: (rate * 100).toFixed(4) + '%',
            signal: signal.signal,
            confidence: signal.confidence.toFixed(2),
            interpretation: signal.interpretation,
            timestamp: new Date().toISOString()
          }));

          resolve(signal);
        } catch (e) {
          console.log(JSON.stringify({
            action: 'FUNDING_RATE_ERROR',
            error: e.message,
            timestamp: new Date().toISOString()
          }));

          // Return cached or neutral on error
          resolve(cachedRate || { signal: 'NEUTRAL', confidence: 0, error: e.message });
        }
      });
    });

    req.on('error', (e) => {
      console.log(JSON.stringify({
        action: 'FUNDING_RATE_REQUEST_ERROR',
        error: e.message,
        timestamp: new Date().toISOString()
      }));
      resolve(cachedRate || { signal: 'NEUTRAL', confidence: 0, error: e.message });
    });

    req.on('timeout', () => {
      req.destroy();
      console.log(JSON.stringify({
        action: 'FUNDING_RATE_TIMEOUT',
        timestamp: new Date().toISOString()
      }));
      resolve(cachedRate || { signal: 'NEUTRAL', confidence: 0, error: 'Timeout' });
    });

    req.end();
  });
}

// ============================================================
// INTERPRETATION LOGIC
// ============================================================

/**
 * Interpret funding rate as trading signal
 * @param {number} rate - Raw funding rate (decimal, e.g., 0.0001 = 0.01%)
 * @returns {Object} Signal object
 */
function interpretFundingRate(rate) {
  const pct = rate * 100;  // Convert to percentage

  // Extreme positive = overbought, contrarian bearish
  if (pct > CONFIG.THRESHOLDS.EXTREME_BULLISH) {
    return {
      signal: 'BEARISH',
      confidence: 0.7,
      interpretation: `Overbought (${pct.toFixed(3)}%) - contrarian NO`,
      rate: pct,
      rawRate: rate,
      isContrarian: true
    };
  }

  // Moderate positive = bullish sentiment
  if (pct > CONFIG.THRESHOLDS.BULLISH) {
    return {
      signal: 'BULLISH',
      confidence: 0.6,
      interpretation: `Bullish sentiment (${pct.toFixed(3)}%)`,
      rate: pct,
      rawRate: rate,
      isContrarian: false
    };
  }

  // Extreme negative = oversold, contrarian bullish
  if (pct < CONFIG.THRESHOLDS.EXTREME_BEARISH) {
    return {
      signal: 'BULLISH',
      confidence: 0.7,
      interpretation: `Oversold (${pct.toFixed(3)}%) - contrarian YES`,
      rate: pct,
      rawRate: rate,
      isContrarian: true
    };
  }

  // Moderate negative = bearish sentiment
  if (pct < CONFIG.THRESHOLDS.BEARISH) {
    return {
      signal: 'BEARISH',
      confidence: 0.6,
      interpretation: `Bearish pressure (${pct.toFixed(3)}%)`,
      rate: pct,
      rawRate: rate,
      isContrarian: false
    };
  }

  // Neutral range
  return {
    signal: 'NEUTRAL',
    confidence: 0.3,
    interpretation: `No clear bias (${pct.toFixed(3)}%)`,
    rate: pct,
    rawRate: rate,
    isContrarian: false
  };
}

/**
 * Check if funding rate indicates DEGEN-worthy conditions
 * (Extreme values for lottery ticket plays)
 * @returns {Object} DEGEN signal
 */
function checkDegenCondition(rate) {
  const pct = rate * 100;

  // DEGEN triggers on extreme funding only
  if (pct > 0.08) {  // Very overbought
    return {
      trigger: true,
      side: 'NO',
      reason: `Extreme positive funding (${pct.toFixed(3)}%) - short squeeze protection exhausted`
    };
  }

  if (pct < -0.08) {  // Very oversold
    return {
      trigger: true,
      side: 'YES',
      reason: `Extreme negative funding (${pct.toFixed(3)}%) - short squeeze imminent`
    };
  }

  return { trigger: false };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getFundingRate,
  interpretFundingRate,
  checkDegenCondition,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== FUNDING RATE ORACLE SELF-TEST ===\n');

  getFundingRate().then(result => {
    console.log('\nResult:', JSON.stringify(result, null, 2));
    console.log('\n=== TEST COMPLETE ===');
  }).catch(err => {
    console.error('Test failed:', err);
  });
}
