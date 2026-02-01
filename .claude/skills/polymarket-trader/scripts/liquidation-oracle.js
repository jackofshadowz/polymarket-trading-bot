/**
 * LIQUIDATION ORACLE (Binance WebSocket - FREE)
 *
 * Real-time BTC liquidation data from Binance Futures WebSocket.
 * Identifies short squeezes and long liquidation cascades.
 *
 * NO API KEY REQUIRED - Uses free public WebSocket stream
 *
 * WebSocket: wss://fstream.binance.com/ws/!forceOrder@arr
 */

const WebSocket = require('ws');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  WS_URL: 'wss://fstream.binance.com/ws/!forceOrder@arr',
  RECONNECT_DELAY_MS: 5000,
  MAX_RECONNECT_ATTEMPTS: 10,

  // Rolling window for aggregation
  ROLLING_WINDOW_MS: 15 * 60 * 1000,  // 15 minutes (matches our trading window)
  CLEANUP_INTERVAL_MS: 60000,          // Clean old data every minute

  // Liquidation thresholds (in USD)
  THRESHOLDS: {
    SIGNIFICANT: 5000000,    // $5M = significant liquidation
    MAJOR: 10000000,         // $10M = major liquidation event
    EXTREME: 25000000        // $25M = extreme volatility
  },

  // Ratio thresholds (short/long ratio)
  RATIO: {
    SHORT_SQUEEZE: 2.0,      // 2:1 short:long = squeeze potential
    LONG_LIQUIDATION: 0.5    // 1:2 short:long = cascade potential
  },

  // Filter for BTC only
  SYMBOLS: ['BTCUSDT', 'BTCUSD_PERP']
};

// ============================================================
// STATE
// ============================================================

let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let liquidationHistory = [];  // Array of { timestamp, side, size, price, symbol }
let cleanupInterval = null;

// Cached signal for synchronous access
let cachedSignal = {
  signal: 'NEUTRAL',
  confidence: 0,
  longLiq: 0,
  shortLiq: 0,
  total: 0,
  ratio: 1,
  event: null,
  interpretation: 'Initializing...',
  connected: false
};

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

/**
 * Connect to Binance liquidation WebSocket
 */
function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log(JSON.stringify({
    action: 'LIQUIDATION_WS_CONNECTING',
    url: CONFIG.WS_URL,
    timestamp: new Date().toISOString()
  }));

  ws = new WebSocket(CONFIG.WS_URL);

  ws.on('open', () => {
    isConnected = true;
    reconnectAttempts = 0;
    cachedSignal.connected = true;

    console.log(JSON.stringify({
      action: 'LIQUIDATION_WS_CONNECTED',
      timestamp: new Date().toISOString()
    }));
  });

  ws.on('message', (data) => {
    try {
      const event = JSON.parse(data.toString());
      handleLiquidationEvent(event);
    } catch (e) {
      // Ignore parse errors
    }
  });

  ws.on('close', () => {
    isConnected = false;
    cachedSignal.connected = false;

    console.log(JSON.stringify({
      action: 'LIQUIDATION_WS_DISCONNECTED',
      timestamp: new Date().toISOString()
    }));

    scheduleReconnect();
  });

  ws.on('error', (error) => {
    console.log(JSON.stringify({
      action: 'LIQUIDATION_WS_ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    }));
  });
}

/**
 * Schedule reconnection with exponential backoff
 */
function scheduleReconnect() {
  if (reconnectAttempts >= CONFIG.MAX_RECONNECT_ATTEMPTS) {
    console.log(JSON.stringify({
      action: 'LIQUIDATION_WS_MAX_RECONNECTS',
      attempts: reconnectAttempts,
      timestamp: new Date().toISOString()
    }));
    return;
  }

  reconnectAttempts++;
  const delay = CONFIG.RECONNECT_DELAY_MS * Math.pow(1.5, reconnectAttempts - 1);

  setTimeout(() => {
    connect();
  }, delay);
}

/**
 * Handle incoming liquidation event from Binance
 * Event format: { e: 'forceOrder', E: timestamp, o: { s: symbol, S: side, q: qty, p: price, ... } }
 */
function handleLiquidationEvent(event) {
  if (!event || !event.o) return;

  const order = event.o;
  const symbol = order.s;

  // Filter for BTC only
  if (!CONFIG.SYMBOLS.includes(symbol)) return;

  const side = order.S;  // 'BUY' or 'SELL'
  const qty = parseFloat(order.q);
  const price = parseFloat(order.p);
  const usdValue = qty * price;

  // BUY liquidation = short position liquidated (bullish)
  // SELL liquidation = long position liquidated (bearish)
  const liquidationSide = side === 'BUY' ? 'SHORT' : 'LONG';

  // Store in history
  liquidationHistory.push({
    timestamp: Date.now(),
    side: liquidationSide,
    size: usdValue,
    price: price,
    symbol: symbol
  });

  // Log significant liquidations
  if (usdValue >= 100000) {  // Log $100k+ liquidations
    console.log(JSON.stringify({
      action: 'LIQUIDATION_EVENT',
      symbol: symbol,
      side: liquidationSide,
      size: '$' + (usdValue / 1000).toFixed(1) + 'k',
      price: price.toFixed(2),
      timestamp: new Date().toISOString()
    }));
  }

  // Update cached signal
  updateCachedSignal();
}

/**
 * Clean old liquidation data outside rolling window
 */
function cleanupOldData() {
  const cutoff = Date.now() - CONFIG.ROLLING_WINDOW_MS;
  const before = liquidationHistory.length;
  liquidationHistory = liquidationHistory.filter(l => l.timestamp > cutoff);

  if (before !== liquidationHistory.length) {
    updateCachedSignal();
  }
}

/**
 * Update the cached signal based on current liquidation data
 */
function updateCachedSignal() {
  const cutoff = Date.now() - CONFIG.ROLLING_WINDOW_MS;
  const recentLiqs = liquidationHistory.filter(l => l.timestamp > cutoff);

  let longLiq = 0;
  let shortLiq = 0;

  recentLiqs.forEach(l => {
    if (l.side === 'LONG') {
      longLiq += l.size;
    } else {
      shortLiq += l.size;
    }
  });

  const total = longLiq + shortLiq;
  const ratio = shortLiq / (longLiq + 1);  // Avoid divide by zero

  // Determine signal
  let signal = 'NEUTRAL';
  let confidence = 0.3;
  let interpretation = '';
  let event = null;

  // SHORT SQUEEZE: High short liquidations = bullish
  if (ratio > CONFIG.RATIO.SHORT_SQUEEZE && shortLiq > CONFIG.THRESHOLDS.SIGNIFICANT) {
    signal = 'BULLISH';
    confidence = Math.min(0.8, 0.5 + (shortLiq / CONFIG.THRESHOLDS.EXTREME) * 0.3);
    interpretation = `Short squeeze (ratio ${ratio.toFixed(1)}:1, $${(shortLiq/1000000).toFixed(1)}M shorts liquidated)`;
    event = 'SHORT_SQUEEZE';
  }
  // LONG LIQUIDATION CASCADE: High long liquidations = bearish
  else if (ratio < CONFIG.RATIO.LONG_LIQUIDATION && longLiq > CONFIG.THRESHOLDS.SIGNIFICANT) {
    signal = 'BEARISH';
    confidence = Math.min(0.8, 0.5 + (longLiq / CONFIG.THRESHOLDS.EXTREME) * 0.3);
    interpretation = `Long liquidation cascade (ratio 1:${(1/ratio).toFixed(1)}, $${(longLiq/1000000).toFixed(1)}M longs liquidated)`;
    event = 'LONG_CASCADE';
  }
  // HIGH VOLATILITY: Large total liquidations
  else if (total > CONFIG.THRESHOLDS.MAJOR) {
    signal = 'VOLATILE';
    confidence = 0.5;
    interpretation = `High liquidation volume ($${(total/1000000).toFixed(1)}M in 15min) - reduce size`;
    event = 'HIGH_VOLATILITY';
  }
  // Normal conditions
  else {
    interpretation = `Normal liquidation levels ($${(total/1000000).toFixed(2)}M in 15min)`;
  }

  cachedSignal = {
    signal,
    confidence,
    longLiq,
    shortLiq,
    total,
    ratio,
    event,
    interpretation,
    connected: isConnected,
    eventCount: recentLiqs.length,
    windowMinutes: CONFIG.ROLLING_WINDOW_MS / 60000
  };
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Initialize the liquidation oracle
 * Call this once at startup to begin collecting data
 */
function initialize() {
  if (ws) return;  // Already initialized

  connect();

  // Start cleanup interval
  cleanupInterval = setInterval(cleanupOldData, CONFIG.CLEANUP_INTERVAL_MS);

  console.log(JSON.stringify({
    action: 'LIQUIDATION_ORACLE_INITIALIZED',
    source: 'Binance WebSocket (FREE)',
    rollingWindow: (CONFIG.ROLLING_WINDOW_MS / 60000) + ' minutes',
    timestamp: new Date().toISOString()
  }));
}

/**
 * Get current liquidation data
 * @param {boolean} forceRefresh - Ignored (data is real-time)
 * @returns {Promise<Object>} Liquidation signal
 */
async function getLiquidationData(forceRefresh = false) {
  // Auto-initialize if not connected
  if (!ws) {
    initialize();
    // Wait a moment for initial connection
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  // Return cached signal (updated in real-time)
  return { ...cachedSignal };
}

/**
 * Check if liquidation data indicates DEGEN-worthy conditions
 * @param {Object} data - Liquidation signal (optional, uses cached if not provided)
 * @returns {Object} DEGEN signal
 */
function checkDegenCondition(data) {
  const signal = data || cachedSignal;

  if (!signal || signal.signal === 'NEUTRAL') {
    return { trigger: false };
  }

  // DEGEN triggers on extreme liquidation events
  if (signal.event === 'SHORT_SQUEEZE' && signal.shortLiq > CONFIG.THRESHOLDS.MAJOR) {
    return {
      trigger: true,
      side: 'YES',
      reason: `Major short squeeze: $${(signal.shortLiq/1000000).toFixed(1)}M shorts liquidated in 15min`,
      confidence: signal.confidence
    };
  }

  if (signal.event === 'LONG_CASCADE' && signal.longLiq > CONFIG.THRESHOLDS.MAJOR) {
    return {
      trigger: true,
      side: 'NO',
      reason: `Major long cascade: $${(signal.longLiq/1000000).toFixed(1)}M longs liquidated in 15min`,
      confidence: signal.confidence
    };
  }

  return { trigger: false };
}

/**
 * Get raw liquidation history for analysis
 * @returns {Array} Recent liquidation events
 */
function getLiquidationHistory() {
  return [...liquidationHistory];
}

/**
 * Shutdown the oracle (cleanup)
 */
function shutdown() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  if (ws) {
    ws.close();
    ws = null;
  }

  isConnected = false;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initialize,
  getLiquidationData,
  checkDegenCondition,
  getLiquidationHistory,
  shutdown,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== LIQUIDATION ORACLE SELF-TEST (Binance WebSocket) ===\n');
  console.log('Connecting to Binance liquidation stream...');
  console.log('This is FREE - no API key required!\n');

  initialize();

  // Check status every 5 seconds
  const statusInterval = setInterval(async () => {
    const data = await getLiquidationData();
    console.log('\nCurrent Status:', JSON.stringify({
      connected: data.connected,
      signal: data.signal,
      longLiq: '$' + (data.longLiq / 1000).toFixed(1) + 'k',
      shortLiq: '$' + (data.shortLiq / 1000).toFixed(1) + 'k',
      eventCount: data.eventCount,
      interpretation: data.interpretation
    }, null, 2));

    const degen = checkDegenCondition(data);
    if (degen.trigger) {
      console.log('\n🚨 DEGEN TRIGGER:', degen.reason);
    }
  }, 5000);

  // Run for 30 seconds then exit
  setTimeout(() => {
    console.log('\n=== TEST COMPLETE ===');
    clearInterval(statusInterval);
    shutdown();
    process.exit(0);
  }, 30000);

  console.log('Listening for liquidations for 30 seconds...');
  console.log('(Large liquidations will be logged as they occur)\n');
}
