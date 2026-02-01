/**
 * BINANCE ORDER BOOK DEPTH ORACLE
 *
 * Real-time order book imbalance detection.
 * Bid/Ask ratio indicates buying vs selling pressure.
 *
 * WebSocket: wss://fstream.binance.com/ws/btcusdt@depth5@100ms
 * NO API KEY REQUIRED - Free public stream
 */

const { BaseWebSocketOracle } = require('./base-websocket-oracle');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  WS_URL: 'wss://fstream.binance.com/ws/btcusdt@depth5@100ms',
  NAME: 'DEPTH',

  // Imbalance thresholds (bid volume / ask volume)
  THRESHOLDS: {
    STRONG_BID: 1.5,    // 1.5:1 bid:ask = strong buying pressure
    WEAK_BID: 1.2,      // 1.2:1 = moderate buying
    WEAK_ASK: 0.8,      // 1:1.25 = moderate selling
    STRONG_ASK: 0.67    // 1:1.5 = strong selling pressure
  },

  // DEGEN triggers
  DEGEN: {
    EXTREME_BID: 2.0,   // 2:1 bid dominance
    EXTREME_ASK: 0.5    // 1:2 ask dominance
  }
};

// ============================================================
// STATE
// ============================================================

let cachedSignal = {
  signal: 'NEUTRAL',
  confidence: 0.3,
  bidVolume: 0,
  askVolume: 0,
  ratio: 1,
  interpretation: 'Initializing...',
  connected: false
};

// ============================================================
// ORACLE IMPLEMENTATION
// ============================================================

class DepthOracle extends BaseWebSocketOracle {
  constructor() {
    super({
      wsUrl: CONFIG.WS_URL,
      name: CONFIG.NAME
    });
  }

  onConnect() {
    cachedSignal.connected = true;
  }

  onDisconnect() {
    cachedSignal.connected = false;
  }

  onMessage(data) {
    // Binance depth format: { b: [[price, qty], ...], a: [[price, qty], ...] }
    if (!data.b || !data.a) return;

    // Calculate bid volume (top 5 levels, USD value)
    let bidVolume = 0;
    data.b.forEach(([price, qty]) => {
      bidVolume += parseFloat(qty) * parseFloat(price);
    });

    // Calculate ask volume (top 5 levels, USD value)
    let askVolume = 0;
    data.a.forEach(([price, qty]) => {
      askVolume += parseFloat(qty) * parseFloat(price);
    });

    const ratio = bidVolume / (askVolume + 1);  // Avoid divide by zero

    // Determine signal based on ratio
    let signal = 'NEUTRAL';
    let confidence = 0.3;
    let interpretation = '';

    if (ratio >= CONFIG.THRESHOLDS.STRONG_BID) {
      signal = 'BULLISH';
      confidence = 0.7;
      interpretation = `Strong bid pressure (${ratio.toFixed(2)}:1)`;
    } else if (ratio >= CONFIG.THRESHOLDS.WEAK_BID) {
      signal = 'BULLISH';
      confidence = 0.5;
      interpretation = `Moderate bid pressure (${ratio.toFixed(2)}:1)`;
    } else if (ratio <= CONFIG.THRESHOLDS.STRONG_ASK) {
      signal = 'BEARISH';
      confidence = 0.7;
      interpretation = `Strong ask pressure (1:${(1/ratio).toFixed(2)})`;
    } else if (ratio <= CONFIG.THRESHOLDS.WEAK_ASK) {
      signal = 'BEARISH';
      confidence = 0.5;
      interpretation = `Moderate ask pressure (1:${(1/ratio).toFixed(2)})`;
    } else {
      interpretation = `Balanced order book (${ratio.toFixed(2)}:1)`;
    }

    cachedSignal = {
      signal,
      confidence,
      bidVolume,
      askVolume,
      ratio,
      interpretation,
      connected: true
    };
  }

  onError(error) {
    // Error already logged by base class
  }
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let oracle = null;

/**
 * Initialize the depth oracle
 */
function initialize() {
  if (oracle) return;

  oracle = new DepthOracle();
  oracle.connect();

  console.log(JSON.stringify({
    action: 'DEPTH_ORACLE_INITIALIZED',
    source: 'Binance WebSocket (FREE)',
    stream: 'btcusdt@depth5@100ms',
    timestamp: new Date().toISOString()
  }));
}

/**
 * Get current depth signal
 * @returns {Promise<Object>} Depth signal
 */
async function getDepthSignal() {
  if (!oracle) {
    initialize();
    // Wait a moment for initial connection
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  return { ...cachedSignal };
}

/**
 * Check if depth indicates DEGEN-worthy conditions
 * @param {Object} data - Depth signal (optional, uses cached if not provided)
 * @returns {Object} DEGEN trigger status
 */
function checkDegenCondition(data) {
  const signal = data || cachedSignal;

  if (!signal || !signal.connected) {
    return { trigger: false };
  }

  // Extreme bid dominance = DEGEN YES
  if (signal.ratio >= CONFIG.DEGEN.EXTREME_BID) {
    return {
      trigger: true,
      side: 'YES',
      reason: `Extreme bid dominance: ${signal.ratio.toFixed(1)}:1 bid/ask ratio`,
      confidence: 0.75
    };
  }

  // Extreme ask dominance = DEGEN NO
  if (signal.ratio <= CONFIG.DEGEN.EXTREME_ASK) {
    return {
      trigger: true,
      side: 'NO',
      reason: `Extreme ask dominance: 1:${(1/signal.ratio).toFixed(1)} bid/ask ratio`,
      confidence: 0.75
    };
  }

  return { trigger: false };
}

/**
 * Shutdown the oracle
 */
function shutdown() {
  if (oracle) {
    oracle.shutdown();
    oracle = null;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initialize,
  getDepthSignal,
  checkDegenCondition,
  shutdown,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== BINANCE DEPTH ORACLE SELF-TEST ===\n');
  console.log('Connecting to Binance order book stream...');
  console.log('This is FREE - no API key required!\n');

  initialize();

  // Check status every 2 seconds
  const statusInterval = setInterval(async () => {
    const data = await getDepthSignal();
    console.log('\nDepth Signal:', JSON.stringify({
      connected: data.connected,
      signal: data.signal,
      ratio: data.ratio?.toFixed(3),
      bidVol: '$' + (data.bidVolume / 1000).toFixed(0) + 'k',
      askVol: '$' + (data.askVolume / 1000).toFixed(0) + 'k',
      interpretation: data.interpretation
    }, null, 2));

    const degen = checkDegenCondition(data);
    if (degen.trigger) {
      console.log('\n*** DEGEN TRIGGER ***:', degen.reason);
    }
  }, 2000);

  // Run for 15 seconds then exit
  setTimeout(() => {
    console.log('\n=== TEST COMPLETE ===');
    clearInterval(statusInterval);
    shutdown();
    process.exit(0);
  }, 15000);

  console.log('Monitoring order book for 15 seconds...\n');
}
