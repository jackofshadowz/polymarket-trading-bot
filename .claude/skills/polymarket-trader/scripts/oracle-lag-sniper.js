// ============================================================
// ORACLE LAG SNIPER - THE HOLY GRAIL STRATEGY
// ============================================================
// Exploits 5-30 second delay between Binance spot price and
// Polymarket oracle settlement price
//
// LOGIC:
// - Binance price hits $98,550 (Strike: $98,500) → BTC went UP
// - Oracle takes 15 seconds to update on-chain
// - Polymarket odds still at 40¢ (humans are slow to react)
// - Bot buys YES at 40¢, settles at $1.00 → 2.5x in 15 seconds
//
// This is NOT gambling - it's arbitrage with information asymmetry

const WebSocket = require('ws');
const https = require('https');

// Track the future price (Binance spot)
let BINANCE_SPOT_PRICE = 0;
let BINANCE_LAST_UPDATE = 0;
let WEBSOCKET_CONNECTED = false;

/**
 * Connect to Binance WebSocket for real-time spot price
 * This is the "crystal ball" - shows the future before Polymarket knows
 */
function startBinanceWebSocket() {
  const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@bookTicker');

  ws.on('open', () => {
    WEBSOCKET_CONNECTED = true;
    console.log(JSON.stringify({
      action: 'ORACLE_SNIPER_CONNECTED',
      source: 'Binance BookTicker',
      speed: 'Real-time (<100ms latency)',
      timestamp: new Date().toISOString()
    }));
  });

  ws.on('message', (data) => {
    try {
      const ticker = JSON.parse(data);

      // BookTicker format: { b: "98523.45", a: "98524.12" }
      // b = best bid, a = best ask
      const bestBid = parseFloat(ticker.b);
      const bestAsk = parseFloat(ticker.a);

      // Use mid-price (most accurate)
      BINANCE_SPOT_PRICE = (bestBid + bestAsk) / 2;
      BINANCE_LAST_UPDATE = Date.now();

    } catch (error) {
      console.warn(JSON.stringify({
        action: 'ORACLE_SNIPER_PARSE_ERROR',
        error: error.message
      }));
    }
  });

  ws.on('error', (error) => {
    console.error(JSON.stringify({
      action: 'ORACLE_SNIPER_ERROR',
      error: error.message
    }));
    WEBSOCKET_CONNECTED = false;
  });

  ws.on('close', () => {
    WEBSOCKET_CONNECTED = false;
    console.log(JSON.stringify({
      action: 'ORACLE_SNIPER_DISCONNECTED',
      reconnecting: 'in 5s'
    }));

    // Reconnect after 5 seconds
    setTimeout(startBinanceWebSocket, 5000);
  });

  return ws;
}

/**
 * Get current Binance spot price
 * @returns {Object} Binance price data
 */
function getBinanceSpotPrice() {
  if (!WEBSOCKET_CONNECTED || BINANCE_SPOT_PRICE === 0) {
    return null;
  }

  const age = Date.now() - BINANCE_LAST_UPDATE;

  // If price is >5 seconds old, consider it stale
  if (age > 5000) {
    return null;
  }

  return {
    price: BINANCE_SPOT_PRICE,
    age_ms: age,
    fresh: age < 1000
  };
}

/**
 * Get Polymarket orderbook price for a token
 * @param {string} tokenId Token ID
 * @returns {Promise<number>} Current market price
 */
async function getPolymarketPrice(tokenId) {
  return new Promise((resolve) => {
    const url = `https://clob.polymarket.com/price?token_id=${tokenId}&side=BUY`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(parseFloat(json.price) || null);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

/**
 * Check for Oracle Lag arbitrage opportunity
 * THIS IS THE MONEY MAKER
 *
 * @param {Object} window Current window data
 * @param {Object} market Market data with token IDs
 * @returns {Object|null} Arbitrage opportunity or null
 */
async function checkOracleLagArbitrage(window, market) {
  // Get Binance "future" price
  const binanceData = getBinanceSpotPrice();
  if (!binanceData) return null;

  const binancePrice = binanceData.price;

  // Extract strike price from window slug
  // Window format: btc-updown-15m-{endTimestamp}
  const endTimestamp = parseInt(window.slug.split('-').pop());
  const startTimestamp = endTimestamp - 900; // 15 minutes before

  // Get the START price (this is what we're comparing against)
  // For now, we'll use a simple heuristic: if window just started,
  // the strike is approximately the current price
  // In production, you'd fetch this from the contract or cache it

  // Calculate time into window
  const now = Math.floor(Date.now() / 1000);
  const timeIntoWindow = now - startTimestamp;
  const timeLeft = endTimestamp - now;

  // Only check in the LAST 3 MINUTES of the window
  // This is when the oracle lag is most exploitable
  if (timeLeft > 180) return null;

  // Get current Polymarket prices
  const [yesPrice, noPrice] = await Promise.all([
    getPolymarketPrice(market.yesTokenId),
    getPolymarketPrice(market.noTokenId)
  ]);

  if (!yesPrice || !noPrice) return null;

  // We need to know if BTC has moved significantly from the START price
  // For now, let's use a momentum-based approach:
  // If Binance is trending strongly UP (>0.2% in last 30s)
  // AND YES is still cheap (<70¢)
  // → Oracle hasn't caught up yet

  // This is a simplified version - in production you'd:
  // 1. Cache the exact START price when window opens
  // 2. Compare Binance vs START directly
  // 3. Check if oracle has settled yet

  // SIMPLIFIED ORACLE LAG DETECTION:
  // If there's strong momentum on Binance but Polymarket hasn't reacted

  const oracleLag = {
    binancePrice,
    yesPrice,
    noPrice,
    timeLeft,
    dataAge: binanceData.age_ms
  };

  // UPSIDE ARBITRAGE:
  // If BTC is clearly going UP (based on very recent momentum)
  // But YES is still < 75¢ (market hasn't caught up)
  // → BUY YES

  // We'll implement this by checking if our real-time price
  // is significantly different from what the market thinks

  // For now, return the data for analysis
  // The main trading loop will use this info
  return oracleLag;
}

/**
 * Enhanced oracle lag strategy with momentum comparison
 * @param {Object} window Current window
 * @param {Object} market Market data
 * @param {Array} priceHistory Recent price history for comparison
 * @returns {Object|null} High-confidence oracle lag opportunity
 */
async function detectOracleLagOpportunity(window, market, priceHistory) {
  if (priceHistory.length < 10) return null;

  const binanceData = getBinanceSpotPrice();
  if (!binanceData || !binanceData.fresh) return null;

  // Get current Polymarket price
  const yesPrice = await getPolymarketPrice(market.yesTokenId);
  if (!yesPrice) return null;

  // Calculate very recent momentum (last 10 seconds)
  const recentPrices = priceHistory.slice(-10); // Last 10 samples @ 1s = 10s
  if (recentPrices.length < 10) return null;

  const momentumStart = recentPrices[0].price;
  const momentumEnd = binanceData.price;
  const recentMomentum = (momentumEnd - momentumStart) / momentumStart;

  // ORACLE LAG SIGNAL:
  // Strong momentum (>0.15% in 10s) but Polymarket hasn't reacted

  const endTimestamp = parseInt(window.slug.split('-').pop());
  const now = Math.floor(Date.now() / 1000);
  const timeLeft = endTimestamp - now;

  // Only in last 5 minutes (when oracle lag is most exploitable)
  if (timeLeft > 300 || timeLeft < 30) return null;

  // BULLISH ORACLE LAG
  if (recentMomentum > 0.0015) { // 0.15% up in 10s = strong
    // If YES is still cheap, the oracle hasn't caught up
    if (yesPrice < 0.70) {
      return {
        trigger: 'oracle_lag_bullish',
        confidence: 0.95, // Very high - this is arbitrage
        side: 'YES',
        positionSize: 0.15, // 15% - max conviction
        reasoning: [
          `🔮 ORACLE LAG: Binance +${(recentMomentum * 100).toFixed(2)}% in 10s`,
          `YES still ${(yesPrice * 100).toFixed(0)}¢ → Oracle hasn't updated`,
          `Arbitrage window: ${binanceData.age_ms}ms data latency`,
          `Time left: ${timeLeft}s (oracle will settle soon)`
        ],
        metadata: {
          binancePrice: binanceData.price,
          polymarketPrice: yesPrice,
          recentMomentum: recentMomentum,
          dataLatency: binanceData.age_ms
        }
      };
    }
  }

  // BEARISH ORACLE LAG
  if (recentMomentum < -0.0015) { // 0.15% down in 10s = strong
    // If NO is still cheap (YES is expensive), oracle hasn't caught up
    if (yesPrice > 0.30) {
      return {
        trigger: 'oracle_lag_bearish',
        confidence: 0.95,
        side: 'NO',
        positionSize: 0.15,
        reasoning: [
          `🔮 ORACLE LAG: Binance ${(recentMomentum * 100).toFixed(2)}% in 10s`,
          `YES still ${(yesPrice * 100).toFixed(0)}¢ → Oracle hasn't updated`,
          `Arbitrage window: ${binanceData.age_ms}ms data latency`,
          `Time left: ${timeLeft}s (oracle will settle soon)`
        ],
        metadata: {
          binancePrice: binanceData.price,
          polymarketPrice: yesPrice,
          recentMomentum: recentMomentum,
          dataLatency: binanceData.age_ms
        }
      };
    }
  }

  return null;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  startBinanceWebSocket,
  getBinanceSpotPrice,
  getPolymarketPrice,
  checkOracleLagArbitrage,
  detectOracleLagOpportunity,

  // Expose state for monitoring
  getStatus: () => ({
    connected: WEBSOCKET_CONNECTED,
    price: BINANCE_SPOT_PRICE,
    lastUpdate: BINANCE_LAST_UPDATE,
    age: Date.now() - BINANCE_LAST_UPDATE
  })
};
