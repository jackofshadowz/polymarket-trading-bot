// ============================================================
// HOURLY BTC STRATEGY - EMA Trend Following
// ============================================================
// Separate strategy for 1-hour BTC up/down markets
// Uses last 24 hours of hourly candles + EMA crossover
// More signal, less noise than 15-minute windows
//
// ONE bet per window, up to $10, chosen at window open

const https = require('https');

// EMA parameters
const EMA_FAST = 9;   // Fast EMA (9 hours)
const EMA_SLOW = 21;  // Slow EMA (21 hours)
const MAX_BET_SIZE = 10; // $10 max per hourly window

// Cache for hourly candles
let HOURLY_CANDLES = [];
let LAST_CANDLE_FETCH = 0;

/**
 * Fetch hourly candles from Binance
 * @param {number} hours Number of hours to fetch (default 30 for EMA calculation)
 * @returns {Promise<Array>} Hourly OHLCV candles
 */
async function fetchHourlyCandles(hours = 30) {
  return new Promise((resolve) => {
    // Only fetch if cache is stale (>5 minutes old)
    if (Date.now() - LAST_CANDLE_FETCH < 5 * 60 * 1000 && HOURLY_CANDLES.length > 0) {
      resolve(HOURLY_CANDLES);
      return;
    }

    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=${hours}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const klines = JSON.parse(data);

          // Format: [openTime, open, high, low, close, volume, ...]
          const candles = klines.map(k => ({
            timestamp: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5])
          }));

          HOURLY_CANDLES = candles;
          LAST_CANDLE_FETCH = Date.now();

          console.log(JSON.stringify({
            action: 'HOURLY_CANDLES_FETCHED',
            count: candles.length,
            latest: candles[candles.length - 1].close.toFixed(2),
            timestamp: new Date().toISOString()
          }));

          resolve(candles);
        } catch (error) {
          console.error(JSON.stringify({
            action: 'HOURLY_CANDLES_ERROR',
            error: error.message
          }));
          resolve([]);
        }
      });
    }).on('error', (error) => {
      console.error(JSON.stringify({
        action: 'HOURLY_CANDLES_ERROR',
        error: error.message
      }));
      resolve([]);
    });
  });
}

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {Array} prices Array of prices
 * @param {number} period EMA period
 * @returns {number} EMA value
 */
function calculateEMA(prices, period) {
  if (prices.length < period) return null;

  // Start with SMA
  const sma = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

  // Calculate multiplier
  const multiplier = 2 / (period + 1);

  // Calculate EMA
  let ema = sma;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Analyze hourly trend using EMA crossover
 * @returns {Promise<Object>} Trading decision
 */
async function analyzeHourlyTrend() {
  const candles = await fetchHourlyCandles(30);

  if (candles.length < EMA_SLOW + 5) {
    return {
      decision: null,
      reason: 'Insufficient candle data'
    };
  }

  // Get closing prices
  const closes = candles.map(c => c.close);
  const currentPrice = closes[closes.length - 1];

  // Calculate EMAs
  const emaFast = calculateEMA(closes, EMA_FAST);
  const emaSlow = calculateEMA(closes, EMA_SLOW);

  if (!emaFast || !emaSlow) {
    return {
      decision: null,
      reason: 'EMA calculation failed'
    };
  }

  // Calculate trend strength
  const emaDiff = ((emaFast - emaSlow) / emaSlow) * 100;
  const priceVsEMA = ((currentPrice - emaFast) / emaFast) * 100;

  // Additional confirmation: Check last 3 candles momentum
  const last3 = closes.slice(-3);
  const momentum3h = ((last3[2] - last3[0]) / last3[0]) * 100;

  // Additional confirmation: Check last 6 candles momentum
  const last6 = closes.slice(-6);
  const momentum6h = ((last6[5] - last6[0]) / last6[0]) * 100;

  // Additional confirmation: Volume trend (last 3 vs previous 3)
  const volumeLast3 = candles.slice(-3).reduce((sum, c) => sum + c.volume, 0) / 3;
  const volumePrev3 = candles.slice(-6, -3).reduce((sum, c) => sum + c.volume, 0) / 3;
  const volumeTrend = ((volumeLast3 - volumePrev3) / volumePrev3) * 100;

  const reasoning = [];
  let confidence = 0.50; // Start at 50%
  let side = null;

  // BULLISH SIGNALS
  if (emaFast > emaSlow) {
    side = 'YES'; // BTC will be UP
    reasoning.push(`EMA ${EMA_FAST}/${EMA_SLOW} crossover: ${emaDiff.toFixed(2)}% bullish`);

    // Strength of trend
    if (emaDiff > 0.5) {
      confidence += 0.20; // Strong uptrend
      reasoning.push(`Strong uptrend (${emaDiff.toFixed(2)}%)`);
    } else if (emaDiff > 0.2) {
      confidence += 0.10; // Moderate uptrend
      reasoning.push(`Moderate uptrend (${emaDiff.toFixed(2)}%)`);
    } else {
      confidence += 0.05; // Weak uptrend
      reasoning.push(`Weak uptrend (${emaDiff.toFixed(2)}%)`);
    }

    // Price above EMA
    if (currentPrice > emaFast) {
      confidence += 0.10;
      reasoning.push(`Price above EMA ${EMA_FAST} (+${priceVsEMA.toFixed(2)}%)`);
    }

    // 3-hour momentum confirms
    if (momentum3h > 0) {
      confidence += 0.08;
      reasoning.push(`3h momentum: +${momentum3h.toFixed(2)}%`);
    }

    // 6-hour momentum confirms
    if (momentum6h > 0.5) {
      confidence += 0.10;
      reasoning.push(`6h momentum: +${momentum6h.toFixed(2)}%`);
    }

    // Volume increasing (institutions accumulating)
    if (volumeTrend > 10) {
      confidence += 0.07;
      reasoning.push(`Volume +${volumeTrend.toFixed(0)}% (accumulation)`);
    }
  }

  // BEARISH SIGNALS
  else if (emaFast < emaSlow) {
    side = 'NO'; // BTC will be DOWN
    reasoning.push(`EMA ${EMA_FAST}/${EMA_SLOW} crossover: ${Math.abs(emaDiff).toFixed(2)}% bearish`);

    // Strength of trend
    if (emaDiff < -0.5) {
      confidence += 0.20; // Strong downtrend
      reasoning.push(`Strong downtrend (${emaDiff.toFixed(2)}%)`);
    } else if (emaDiff < -0.2) {
      confidence += 0.10; // Moderate downtrend
      reasoning.push(`Moderate downtrend (${emaDiff.toFixed(2)}%)`);
    } else {
      confidence += 0.05; // Weak downtrend
      reasoning.push(`Weak downtrend (${emaDiff.toFixed(2)}%)`);
    }

    // Price below EMA
    if (currentPrice < emaFast) {
      confidence += 0.10;
      reasoning.push(`Price below EMA ${EMA_FAST} (${priceVsEMA.toFixed(2)}%)`);
    }

    // 3-hour momentum confirms
    if (momentum3h < 0) {
      confidence += 0.08;
      reasoning.push(`3h momentum: ${momentum3h.toFixed(2)}%`);
    }

    // 6-hour momentum confirms
    if (momentum6h < -0.5) {
      confidence += 0.10;
      reasoning.push(`6h momentum: ${momentum6h.toFixed(2)}%`);
    }

    // Volume increasing (institutions distributing)
    if (volumeTrend > 10) {
      confidence += 0.07;
      reasoning.push(`Volume +${volumeTrend.toFixed(0)}% (distribution)`);
    }
  }

  return {
    decision: side,
    confidence: Math.min(0.95, confidence), // Cap at 95%
    reasoning: reasoning,
    metadata: {
      emaFast: emaFast.toFixed(2),
      emaSlow: emaSlow.toFixed(2),
      emaDiff: emaDiff.toFixed(2),
      currentPrice: currentPrice.toFixed(2),
      momentum3h: momentum3h.toFixed(2),
      momentum6h: momentum6h.toFixed(2),
      volumeTrend: volumeTrend.toFixed(2)
    }
  };
}

/**
 * Determine bet size for hourly window based on confidence
 * @param {number} confidence Confidence level (0.0-1.0)
 * @param {number} balance Available balance
 * @returns {number} Bet size in dollars
 */
function calculateHourlyBetSize(confidence, balance) {
  // Base size: $5
  let size = 5;

  // Scale up with confidence
  if (confidence > 0.80) {
    size = 10; // Max bet on high conviction
  } else if (confidence > 0.70) {
    size = 8;
  } else if (confidence > 0.60) {
    size = 6;
  }

  // Never exceed max or 10% of balance
  return Math.min(MAX_BET_SIZE, balance * 0.10, size);
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  fetchHourlyCandles,
  calculateEMA,
  analyzeHourlyTrend,
  calculateHourlyBetSize,
  MAX_BET_SIZE
};
