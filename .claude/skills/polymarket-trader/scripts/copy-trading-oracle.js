/**
 * COPY TRADING ORACLE
 *
 * Fetches recent trading activity from Polymarket to gauge "smart money" sentiment.
 * Tracks volume distribution between YES and NO in BTC 15-min markets.
 *
 * Gemini-recommended alpha signal for following top traders.
 */

const { execSync } = require('child_process');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  CACHE_TTL_MS: 120000,     // 2 minute cache (activity doesn't change rapidly)
  TIMEOUT_MS: 5000,          // 5 second timeout for curl
  MIN_TRADES_FOR_SIGNAL: 3,  // Minimum trades to form opinion
  CONSENSUS_THRESHOLD: 0.65, // 65% agreement for signal

  // API endpoints
  ENDPOINTS: {
    TRADES: 'https://data-api.polymarket.com/trades'
  },

  // Market filters (slug-based for BTC 15-min markets)
  MARKET_FILTERS: ['btc-updown-15m', 'bitcoin']
};

// ============================================================
// CACHE STATE
// ============================================================

let cachedSignal = null;
let lastFetchTime = 0;

// ============================================================
// MAIN FUNCTION
// ============================================================

/**
 * Get smart money signal from Polymarket activity
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Object>} Smart money signal
 */
async function getSmartMoneySignal(forceRefresh = false) {
  const now = Date.now();

  // Return cached if valid
  if (!forceRefresh && cachedSignal && (now - lastFetchTime) < CONFIG.CACHE_TTL_MS) {
    return { ...cachedSignal, cached: true };
  }

  try {
    // Fetch recent trades from Polymarket
    const cmd = `curl -s "${CONFIG.ENDPOINTS.TRADES}?limit=100" 2>/dev/null`;
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: CONFIG.TIMEOUT_MS
    });

    let trades;
    try {
      trades = JSON.parse(output);
    } catch (e) {
      throw new Error('Failed to parse trades response');
    }

    if (!Array.isArray(trades)) {
      throw new Error('Invalid trades format');
    }

    // Filter to BTC 15-min market trades by slug
    const btcTrades = trades.filter(t => {
      const slug = (t.slug || '').toLowerCase();
      return slug.includes('btc-updown-15m') || slug.includes('bitcoin');
    });

    // If not enough data, return neutral
    if (btcTrades.length < CONFIG.MIN_TRADES_FOR_SIGNAL) {
      const signal = {
        signal: 'NEUTRAL',
        confidence: 0,
        reason: `Insufficient data (${btcTrades.length} trades)`,
        tradeCount: btcTrades.length
      };
      cachedSignal = signal;
      lastFetchTime = now;
      return signal;
    }

    // Calculate YES vs NO volume
    let yesVolume = 0;
    let noVolume = 0;
    let yesCount = 0;
    let noCount = 0;

    btcTrades.forEach(trade => {
      // Polymarket /trades endpoint: outcome is "Up"/"Down", side is "BUY"/"SELL"
      const outcome = (trade.outcome || '').toLowerCase();
      const side = (trade.side || '').toUpperCase();
      const size = parseFloat(trade.size || 0);

      // Map outcome to YES/NO (Up=YES, Down=NO for BTC updown markets)
      // Consider trade direction: BUY increases side's volume, SELL decreases it
      const isBuy = side === 'BUY';

      if (outcome.includes('up') || outcome.includes('yes')) {
        if (isBuy) {
          yesVolume += size;
          yesCount++;
        } else {
          // Selling YES = bearish sentiment
          noVolume += size * 0.5; // Weight sells less
          noCount++;
        }
      } else if (outcome.includes('down') || outcome.includes('no')) {
        if (isBuy) {
          noVolume += size;
          noCount++;
        } else {
          // Selling NO = bullish sentiment
          yesVolume += size * 0.5; // Weight sells less
          yesCount++;
        }
      }
    });

    const total = yesVolume + noVolume;
    const yesRatio = total > 0 ? yesVolume / total : 0.5;
    const noRatio = total > 0 ? noVolume / total : 0.5;

    // Determine signal
    let signal;

    if (yesRatio >= CONFIG.CONSENSUS_THRESHOLD) {
      signal = {
        signal: 'BULLISH',
        confidence: yesRatio,
        interpretation: `${(yesRatio * 100).toFixed(0)}% smart money on YES`,
        consensus: 'YES',
        yesVolume,
        noVolume,
        yesCount,
        noCount,
        tradeCount: btcTrades.length
      };
    } else if (noRatio >= CONFIG.CONSENSUS_THRESHOLD) {
      signal = {
        signal: 'BEARISH',
        confidence: noRatio,
        interpretation: `${(noRatio * 100).toFixed(0)}% smart money on NO`,
        consensus: 'NO',
        yesVolume,
        noVolume,
        yesCount,
        noCount,
        tradeCount: btcTrades.length
      };
    } else {
      signal = {
        signal: 'NEUTRAL',
        confidence: 0.3,
        interpretation: `No consensus (YES: ${(yesRatio * 100).toFixed(0)}%, NO: ${(noRatio * 100).toFixed(0)}%)`,
        consensus: null,
        yesVolume,
        noVolume,
        yesCount,
        noCount,
        tradeCount: btcTrades.length
      };
    }

    // Update cache
    cachedSignal = signal;
    lastFetchTime = now;

    // Log for monitoring
    console.log(JSON.stringify({
      action: 'SMART_MONEY_SIGNAL',
      signal: signal.signal,
      yesVolume: yesVolume.toFixed(2),
      noVolume: noVolume.toFixed(2),
      yesPct: (yesRatio * 100).toFixed(0) + '%',
      noPct: (noRatio * 100).toFixed(0) + '%',
      tradeCount: btcTrades.length,
      interpretation: signal.interpretation,
      timestamp: new Date().toISOString()
    }));

    return signal;

  } catch (e) {
    console.log(JSON.stringify({
      action: 'SMART_MONEY_ERROR',
      error: e.message,
      timestamp: new Date().toISOString()
    }));

    // Return cached or neutral on error
    return cachedSignal || {
      signal: 'NEUTRAL',
      confidence: 0,
      error: e.message
    };
  }
}

/**
 * Get top traders' recent positions (if available from leaderboard)
 * This is a placeholder for future leaderboard integration
 * @returns {Promise<Object>} Top trader positions
 */
async function getTopTraderPositions() {
  try {
    // Try to fetch leaderboard data
    const cmd = `curl -s "https://data-api.polymarket.com/trader-leaderboard-rankings?count=20" 2>/dev/null`;
    const output = execSync(cmd, {
      encoding: 'utf8',
      timeout: CONFIG.TIMEOUT_MS
    });

    const leaderboard = JSON.parse(output);

    if (!Array.isArray(leaderboard)) {
      return { available: false, reason: 'Invalid leaderboard format' };
    }

    // Extract top trader addresses
    const topTraders = leaderboard.slice(0, 10).map(t => ({
      address: t.address || t.wallet,
      profit: t.profit || t.pnl,
      volume: t.volume,
      rank: t.rank
    }));

    return {
      available: true,
      topTraders,
      count: topTraders.length
    };

  } catch (e) {
    return {
      available: false,
      reason: e.message
    };
  }
}

/**
 * Check if smart money indicates DEGEN-worthy conditions
 * @param {Object} signal - Smart money signal
 * @returns {Object} DEGEN condition
 */
function checkDegenCondition(signal) {
  if (!signal || signal.signal === 'NEUTRAL') {
    return { trigger: false };
  }

  // DEGEN triggers on overwhelming consensus (80%+)
  const extremeThreshold = 0.80;

  if (signal.confidence >= extremeThreshold) {
    return {
      trigger: true,
      side: signal.consensus,
      reason: `Extreme smart money consensus: ${(signal.confidence * 100).toFixed(0)}% on ${signal.consensus}`,
      confidence: signal.confidence
    };
  }

  return { trigger: false };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  getSmartMoneySignal,
  getTopTraderPositions,
  checkDegenCondition,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== COPY TRADING ORACLE SELF-TEST ===\n');

  getSmartMoneySignal().then(result => {
    console.log('\nSmart Money Signal:', JSON.stringify(result, null, 2));

    return getTopTraderPositions();
  }).then(result => {
    console.log('\nTop Trader Positions:', JSON.stringify(result, null, 2));
    console.log('\n=== TEST COMPLETE ===');
  }).catch(err => {
    console.error('Test failed:', err);
  });
}
