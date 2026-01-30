// ============================================================
// BINANCE ORACLE - Real-time BTC price for latency arbitrage
// ============================================================
// Polymarket prices lag 1-5 seconds behind Binance.
// This module fetches the "true" price so we can front-run slow updates.
// ============================================================

const https = require('https');

// ============================================================
// NEXT MARKET DISCOVERY - Find future BTC 15-min markets
// ============================================================

/**
 * Fetch the next BTC 15-minute market from Polymarket Gamma API
 * This finds markets that haven't started yet
 *
 * @returns {Promise<Object|null>} Next market info or null
 */
async function getNextBtcMarket() {
  return new Promise((resolve) => {
    const options = {
      hostname: 'gamma-api.polymarket.com',
      path: '/markets?active=true&closed=false&limit=20',
      method: 'GET',
      timeout: 5000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const markets = JSON.parse(data);
          const now = Date.now();

          // Filter for BTC 15-minute markets that haven't closed yet
          const btcMarkets = markets.filter(m => {
            const question = (m.question || '').toLowerCase();
            const slug = (m.slug || '').toLowerCase();

            // Must be a BTC 15-minute market
            const isBtcMarket = (question.includes('bitcoin') || question.includes('btc') ||
                                slug.includes('bitcoin') || slug.includes('btc'));
            const is15Min = (question.includes('15') || slug.includes('15m') ||
                           slug.includes('15-min') || slug.includes('updown'));

            // Must not be closed
            const endTime = new Date(m.endDate).getTime();
            const notClosed = endTime > now;

            return isBtcMarket && is15Min && notClosed;
          });

          // Sort by end time ascending (soonest first)
          btcMarkets.sort((a, b) => {
            const aEnd = new Date(a.endDate).getTime();
            const bEnd = new Date(b.endDate).getTime();
            return aEnd - bEnd;
          });

          // Find the NEXT market (one that starts after current window)
          // Current window ends at the 15-minute boundary
          const currentWindowEnd = Math.ceil(now / (15 * 60 * 1000)) * (15 * 60 * 1000);

          for (const market of btcMarkets) {
            const marketEnd = new Date(market.endDate).getTime();
            const marketStart = marketEnd - (15 * 60 * 1000); // 15 minutes before end

            // This market starts at or after current window ends = it's the "next" market
            if (marketStart >= currentWindowEnd - 60000) { // 1 min tolerance
              const tokenIds = JSON.parse(market.clobTokenIds || '[]');
              resolve({
                question: market.question,
                slug: market.slug,
                conditionId: market.conditionId,
                yesTokenId: tokenIds[0],
                noTokenId: tokenIds[1],
                startTime: marketStart,
                endTime: marketEnd,
                endDate: market.endDate
              });
              return;
            }
          }

          resolve(null); // No next market found
        } catch (e) {
          console.warn('Failed to parse Gamma API response:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.warn('Gamma API request failed:', e.message);
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

// Cache for rate limiting
let lastPrice = null;
let lastFetchTime = 0;
const MIN_FETCH_INTERVAL_MS = 200; // Max 5 requests/second

/**
 * Fetch current BTC price from Binance (fastest public feed)
 * @returns {Promise<{price: number, timestamp: number}>}
 */
async function getBinancePrice() {
  const now = Date.now();

  // Rate limiting - return cached price if fetched recently
  if (lastPrice && (now - lastFetchTime) < MIN_FETCH_INTERVAL_MS) {
    return { price: lastPrice, timestamp: lastFetchTime, cached: true };
  }

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.binance.com',
      path: '/api/v3/ticker/price?symbol=BTCUSDT',
      method: 'GET',
      timeout: 2000 // 2 second timeout - speed is critical
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const price = parseFloat(parsed.price);
          lastPrice = price;
          lastFetchTime = Date.now();
          resolve({ price, timestamp: lastFetchTime, cached: false });
        } catch (e) {
          reject(new Error('Failed to parse Binance response: ' + e.message));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      // Return cached price on timeout if available
      if (lastPrice) {
        resolve({ price: lastPrice, timestamp: lastFetchTime, cached: true, stale: true });
      } else {
        reject(new Error('Binance request timeout'));
      }
    });

    req.end();
  });
}

/**
 * Compare Binance price to Polymarket's reference price
 * Detects latency arbitrage opportunities
 *
 * @param {number} polymarketOpenPrice - The price BTC was at when the 15m window opened
 * @param {number} polymarketYesAsk - Current ask price for YES tokens
 * @param {number} polymarketNoAsk - Current ask price for NO tokens
 * @returns {Promise<Object>} Arbitrage analysis
 */
async function detectLatencyEdge(polymarketOpenPrice, polymarketYesAsk, polymarketNoAsk) {
  try {
    const binance = await getBinancePrice();

    // Calculate TRUE delta using Binance (the "future" that Polymarket hasn't priced in)
    const trueDelta = binance.price - polymarketOpenPrice;
    const trueDeltaPct = (trueDelta / polymarketOpenPrice) * 100;

    // Strong signal thresholds
    const STRONG_UP = 0.15;    // +0.15% = strong upward momentum
    const STRONG_DOWN = -0.15; // -0.15% = strong downward momentum

    // Implied probability from Polymarket prices
    // YES at $0.60 implies market thinks 60% chance of UP
    const impliedUpProb = polymarketYesAsk;
    const impliedDownProb = polymarketNoAsk;

    // What the TRUE probability should be based on Binance delta
    // Simplified model: delta of 0.15% = ~65% probability, 0.3% = ~75%, etc.
    const trueProbUp = 0.50 + Math.tanh(trueDeltaPct * 3) * 0.40;
    const trueProbDown = 1 - trueProbUp;

    // Edge = True probability - Market implied probability
    const yesEdge = trueProbUp - impliedUpProb;
    const noEdge = trueProbDown - impliedDownProb;

    // Determine if there's an arbitrage opportunity
    let opportunity = null;
    const MIN_EDGE = 0.05; // 5% edge minimum
    const MAX_PRICE = 0.85; // Never pay more than $0.85

    if (trueDeltaPct > STRONG_UP && yesEdge > MIN_EDGE && polymarketYesAsk < MAX_PRICE) {
      opportunity = {
        action: 'BUY_YES',
        limitPrice: Math.min(polymarketYesAsk + 0.02, MAX_PRICE),
        edge: yesEdge,
        confidence: trueDeltaPct > 0.25 ? 'HIGH' : 'MEDIUM',
        reason: `Binance shows +${trueDeltaPct.toFixed(2)}% but YES only priced at ${(impliedUpProb * 100).toFixed(0)}%`
      };
    } else if (trueDeltaPct < STRONG_DOWN && noEdge > MIN_EDGE && polymarketNoAsk < MAX_PRICE) {
      opportunity = {
        action: 'BUY_NO',
        limitPrice: Math.min(polymarketNoAsk + 0.02, MAX_PRICE),
        edge: noEdge,
        confidence: trueDeltaPct < -0.25 ? 'HIGH' : 'MEDIUM',
        reason: `Binance shows ${trueDeltaPct.toFixed(2)}% but NO only priced at ${(impliedDownProb * 100).toFixed(0)}%`
      };
    }

    return {
      binancePrice: binance.price,
      polymarketOpen: polymarketOpenPrice,
      trueDelta: trueDelta,
      trueDeltaPct: trueDeltaPct,
      impliedUpProb: impliedUpProb,
      impliedDownProb: impliedDownProb,
      trueProbUp: trueProbUp,
      trueProbDown: trueProbDown,
      yesEdge: yesEdge,
      noEdge: noEdge,
      opportunity: opportunity,
      timestamp: binance.timestamp,
      cached: binance.cached
    };
  } catch (error) {
    return {
      error: error.message,
      opportunity: null
    };
  }
}

/**
 * Quick price check - just get delta without full analysis
 * Use this for fast decisions in the main loop
 */
async function quickDeltaCheck(polymarketOpenPrice) {
  try {
    const binance = await getBinancePrice();
    const delta = binance.price - polymarketOpenPrice;
    const deltaPct = (delta / polymarketOpenPrice) * 100;
    return { delta, deltaPct, binancePrice: binance.price, success: true };
  } catch (error) {
    return { delta: 0, deltaPct: 0, error: error.message, success: false };
  }
}

module.exports = {
  getBinancePrice,
  detectLatencyEdge,
  quickDeltaCheck,
  getNextBtcMarket
};
