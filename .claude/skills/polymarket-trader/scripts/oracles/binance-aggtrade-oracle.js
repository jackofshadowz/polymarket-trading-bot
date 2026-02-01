/**
 * BINANCE AGGREGATE TRADE ORACLE (Whale Detection)
 *
 * Real-time tracking of large trades ($250k+).
 * Detects whale accumulation vs distribution.
 *
 * WebSocket: wss://fstream.binance.com/ws/btcusdt@aggTrade
 * NO API KEY REQUIRED - Free public stream
 */

const { BaseWebSocketOracle } = require('./base-websocket-oracle');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  WS_URL: 'wss://fstream.binance.com/ws/btcusdt@aggTrade',
  NAME: 'WHALE',

  // Whale detection
  WHALE_THRESHOLD_USD: 250000,     // $250k per Gemini recommendation
  ROLLING_WINDOW_MS: 5 * 60 * 1000,  // 5 minute rolling window
  CLEANUP_INTERVAL_MS: 30000,       // Clean old trades every 30s

  // Signal thresholds
  THRESHOLDS: {
    MIN_WHALE_TRADES: 2,        // Need at least 2 whale trades for signal
    STRONG_IMBALANCE: 3.0,      // 3:1 buy:sell = strong signal
    MODERATE_IMBALANCE: 1.5     // 1.5:1 = moderate signal
  },

  // DEGEN triggers
  DEGEN: {
    MIN_VOLUME: 5000000,        // $5M minimum whale volume
    EXTREME_RATIO: 4.0          // 4:1 buy/sell ratio
  }
};

// ============================================================
// STATE
// ============================================================

let whaleTrades = [];  // Array of { timestamp, side, size, price }
let cleanupInterval = null;

let cachedSignal = {
  signal: 'NEUTRAL',
  confidence: 0.3,
  whaleBuyVolume: 0,
  whaleSellVolume: 0,
  whaleCount: 0,
  ratio: 1,
  interpretation: 'Initializing...',
  connected: false
};

// ============================================================
// ORACLE IMPLEMENTATION
// ============================================================

class AggTradeOracle extends BaseWebSocketOracle {
  constructor() {
    super({
      wsUrl: CONFIG.WS_URL,
      name: CONFIG.NAME
    });
  }

  onConnect() {
    cachedSignal.connected = true;

    // Start cleanup interval
    cleanupInterval = setInterval(cleanupOldTrades, CONFIG.CLEANUP_INTERVAL_MS);
  }

  onDisconnect() {
    cachedSignal.connected = false;

    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }

  onMessage(data) {
    // Binance aggTrade format: { e, E, s, a, p, q, f, l, T, m }
    // m = true means buyer is market maker (i.e., this trade is a SELL to taker)
    // m = false means buyer is taker (i.e., this trade is a BUY from taker)
    if (!data.p || !data.q) return;

    const price = parseFloat(data.p);
    const qty = parseFloat(data.q);
    const usdValue = price * qty;

    // Only track whale trades
    if (usdValue < CONFIG.WHALE_THRESHOLD_USD) return;

    const isBuy = !data.m;  // m=false means aggressive buyer (taker buy)

    whaleTrades.push({
      timestamp: Date.now(),
      side: isBuy ? 'BUY' : 'SELL',
      size: usdValue,
      price
    });

    // Log whale trade
    console.log(JSON.stringify({
      action: 'WHALE_TRADE_DETECTED',
      side: isBuy ? 'BUY' : 'SELL',
      size: '$' + (usdValue / 1000).toFixed(0) + 'k',
      price: price.toFixed(2),
      timestamp: new Date().toISOString()
    }));

    updateCachedSignal();
  }

  onError(error) {
    // Error already logged by base class
  }
}

/**
 * Clean old trades outside rolling window
 */
function cleanupOldTrades() {
  const cutoff = Date.now() - CONFIG.ROLLING_WINDOW_MS;
  const before = whaleTrades.length;
  whaleTrades = whaleTrades.filter(t => t.timestamp > cutoff);

  if (before !== whaleTrades.length) {
    updateCachedSignal();
  }
}

/**
 * Update cached signal based on current whale trades
 */
function updateCachedSignal() {
  const cutoff = Date.now() - CONFIG.ROLLING_WINDOW_MS;
  const recent = whaleTrades.filter(t => t.timestamp > cutoff);

  let buyVolume = 0;
  let sellVolume = 0;

  recent.forEach(t => {
    if (t.side === 'BUY') {
      buyVolume += t.size;
    } else {
      sellVolume += t.size;
    }
  });

  const ratio = buyVolume / (sellVolume + 1);  // Avoid divide by zero

  let signal = 'NEUTRAL';
  let confidence = 0.3;
  let interpretation = '';

  if (recent.length >= CONFIG.THRESHOLDS.MIN_WHALE_TRADES) {
    if (ratio >= CONFIG.THRESHOLDS.STRONG_IMBALANCE) {
      signal = 'BULLISH';
      confidence = 0.75;
      interpretation = `Strong whale buying (${ratio.toFixed(1)}:1 buy/sell, ${recent.length} whales)`;
    } else if (ratio >= CONFIG.THRESHOLDS.MODERATE_IMBALANCE) {
      signal = 'BULLISH';
      confidence = 0.55;
      interpretation = `Moderate whale buying (${ratio.toFixed(1)}:1, ${recent.length} whales)`;
    } else if (ratio <= 1 / CONFIG.THRESHOLDS.STRONG_IMBALANCE) {
      signal = 'BEARISH';
      confidence = 0.75;
      interpretation = `Strong whale selling (1:${(1/ratio).toFixed(1)} buy/sell, ${recent.length} whales)`;
    } else if (ratio <= 1 / CONFIG.THRESHOLDS.MODERATE_IMBALANCE) {
      signal = 'BEARISH';
      confidence = 0.55;
      interpretation = `Moderate whale selling (1:${(1/ratio).toFixed(1)}, ${recent.length} whales)`;
    } else {
      interpretation = `Mixed whale activity (${recent.length} trades in 5min)`;
    }
  } else {
    interpretation = `Insufficient whale data (${recent.length} trades)`;
  }

  cachedSignal = {
    signal,
    confidence,
    whaleBuyVolume: buyVolume,
    whaleSellVolume: sellVolume,
    whaleCount: recent.length,
    ratio,
    interpretation,
    connected: cachedSignal.connected,
    windowMinutes: CONFIG.ROLLING_WINDOW_MS / 60000
  };
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let oracle = null;

/**
 * Initialize the whale oracle
 */
function initialize() {
  if (oracle) return;

  oracle = new AggTradeOracle();
  oracle.connect();

  console.log(JSON.stringify({
    action: 'WHALE_ORACLE_INITIALIZED',
    source: 'Binance WebSocket (FREE)',
    stream: 'btcusdt@aggTrade',
    whaleThreshold: '$' + (CONFIG.WHALE_THRESHOLD_USD / 1000) + 'k',
    rollingWindow: (CONFIG.ROLLING_WINDOW_MS / 60000) + ' minutes',
    timestamp: new Date().toISOString()
  }));
}

/**
 * Get current whale signal
 * @returns {Promise<Object>} Whale signal
 */
async function getWhaleSignal() {
  if (!oracle) {
    initialize();
    // Wait a moment for initial connection
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return { ...cachedSignal };
}

/**
 * Check if whale activity indicates DEGEN-worthy conditions
 * @param {Object} data - Whale signal (optional, uses cached if not provided)
 * @returns {Object} DEGEN trigger status
 */
function checkDegenCondition(data) {
  const signal = data || cachedSignal;

  if (!signal || !signal.connected) {
    return { trigger: false };
  }

  const totalVolume = signal.whaleBuyVolume + signal.whaleSellVolume;

  // Massive whale buying = DEGEN YES
  if (totalVolume > CONFIG.DEGEN.MIN_VOLUME && signal.ratio >= CONFIG.DEGEN.EXTREME_RATIO) {
    return {
      trigger: true,
      side: 'YES',
      reason: `Whale accumulation: $${(signal.whaleBuyVolume/1000000).toFixed(1)}M bought in 5min (${signal.ratio.toFixed(1)}:1 ratio)`,
      confidence: 0.8
    };
  }

  // Massive whale selling = DEGEN NO
  if (totalVolume > CONFIG.DEGEN.MIN_VOLUME && signal.ratio <= 1 / CONFIG.DEGEN.EXTREME_RATIO) {
    return {
      trigger: true,
      side: 'NO',
      reason: `Whale distribution: $${(signal.whaleSellVolume/1000000).toFixed(1)}M sold in 5min (1:${(1/signal.ratio).toFixed(1)} ratio)`,
      confidence: 0.8
    };
  }

  return { trigger: false };
}

/**
 * Get raw whale trade history
 * @returns {Array} Recent whale trades
 */
function getWhaleHistory() {
  return [...whaleTrades];
}

/**
 * Shutdown the oracle
 */
function shutdown() {
  if (oracle) {
    oracle.shutdown();
    oracle = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  whaleTrades = [];
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initialize,
  getWhaleSignal,
  checkDegenCondition,
  getWhaleHistory,
  shutdown,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== BINANCE WHALE DETECTION ORACLE SELF-TEST ===\n');
  console.log('Connecting to Binance aggTrade stream...');
  console.log('Whale threshold: $' + (CONFIG.WHALE_THRESHOLD_USD / 1000) + 'k');
  console.log('This is FREE - no API key required!\n');

  initialize();

  // Check status every 5 seconds
  const statusInterval = setInterval(async () => {
    const data = await getWhaleSignal();
    console.log('\nWhale Signal:', JSON.stringify({
      connected: data.connected,
      signal: data.signal,
      whaleCount: data.whaleCount,
      buyVol: '$' + (data.whaleBuyVolume / 1000).toFixed(0) + 'k',
      sellVol: '$' + (data.whaleSellVolume / 1000).toFixed(0) + 'k',
      ratio: data.ratio?.toFixed(2),
      interpretation: data.interpretation
    }, null, 2));

    const degen = checkDegenCondition(data);
    if (degen.trigger) {
      console.log('\n*** DEGEN TRIGGER ***:', degen.reason);
    }
  }, 5000);

  // Run for 30 seconds then exit
  setTimeout(() => {
    console.log('\n=== TEST COMPLETE ===');
    console.log('Total whale trades detected:', whaleTrades.length);
    clearInterval(statusInterval);
    shutdown();
    process.exit(0);
  }, 30000);

  console.log('Monitoring for whale trades for 30 seconds...');
  console.log('(Whale trades $250k+ will be logged as they occur)\n');
}
