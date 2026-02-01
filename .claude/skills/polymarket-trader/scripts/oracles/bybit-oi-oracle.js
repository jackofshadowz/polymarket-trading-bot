/**
 * BYBIT OPEN INTEREST ORACLE
 *
 * Real-time OI + Price correlation for trend strength.
 * OI direction combined with price direction reveals positioning.
 *
 * WebSocket: wss://stream.bybit.com/v5/public/linear
 * REQUIRES PING EVERY 20 SECONDS (Bybit disconnects otherwise)
 * NO API KEY REQUIRED - Free public stream
 */

const { BaseWebSocketOracle } = require('./base-websocket-oracle');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  WS_URL: 'wss://stream.bybit.com/v5/public/linear',
  NAME: 'BYBIT_OI',
  HEARTBEAT_INTERVAL_MS: 20000,  // Bybit requires ping every 20s

  // Sampling
  SAMPLE_INTERVAL_MS: 60000,          // Sample OI every minute
  ROLLING_WINDOW_MS: 10 * 60 * 1000,  // 10 minute window for comparison

  // Change thresholds
  THRESHOLDS: {
    SIGNIFICANT_OI_CHANGE: 0.005,     // 0.5% OI change
    SIGNIFICANT_PRICE_CHANGE: 0.002   // 0.2% price change
  },

  // DEGEN triggers
  DEGEN: {
    EXTREME_OI_CHANGE: 0.02  // 2% OI change
  }
};

// ============================================================
// STATE
// ============================================================

let oiHistory = [];  // Array of { timestamp, openInterest, price }
let latestData = { openInterest: 0, price: 0 };
let sampleInterval = null;

let cachedSignal = {
  signal: 'NEUTRAL',
  confidence: 0.3,
  oiChange: 0,
  priceChange: 0,
  correlation: 'UNKNOWN',
  currentOI: 0,
  currentPrice: 0,
  interpretation: 'Initializing...',
  connected: false
};

// ============================================================
// ORACLE IMPLEMENTATION
// ============================================================

class OIOracle extends BaseWebSocketOracle {
  constructor() {
    super({
      wsUrl: CONFIG.WS_URL,
      name: CONFIG.NAME,
      heartbeatIntervalMs: CONFIG.HEARTBEAT_INTERVAL_MS
    });
  }

  /**
   * Bybit requires JSON ping format
   */
  sendHeartbeat() {
    this.send({ op: 'ping' });
  }

  onConnect() {
    cachedSignal.connected = true;

    // Subscribe to BTCUSDT ticker (includes OI and price)
    this.send({
      op: 'subscribe',
      args: ['tickers.BTCUSDT']
    });

    // Start sampling OI periodically
    sampleInterval = setInterval(() => {
      if (latestData.openInterest > 0) {
        oiHistory.push({
          timestamp: Date.now(),
          openInterest: latestData.openInterest,
          price: latestData.price
        });

        // Cleanup old samples
        const cutoff = Date.now() - CONFIG.ROLLING_WINDOW_MS;
        oiHistory = oiHistory.filter(s => s.timestamp > cutoff);

        updateCachedSignal();
      }
    }, CONFIG.SAMPLE_INTERVAL_MS);

    // Take immediate first sample after a short delay
    setTimeout(() => {
      if (latestData.openInterest > 0) {
        oiHistory.push({
          timestamp: Date.now(),
          openInterest: latestData.openInterest,
          price: latestData.price
        });
        updateCachedSignal();
      }
    }, 2000);
  }

  onDisconnect() {
    cachedSignal.connected = false;

    if (sampleInterval) {
      clearInterval(sampleInterval);
      sampleInterval = null;
    }
  }

  onMessage(data) {
    // Handle pong response
    if (data.op === 'pong' || data.ret_msg === 'pong') {
      return;
    }

    // Handle subscription confirmation
    if (data.op === 'subscribe') {
      console.log(JSON.stringify({
        action: 'BYBIT_OI_SUBSCRIBED',
        success: data.success,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // Handle ticker data
    if (data.topic === 'tickers.BTCUSDT' && data.data) {
      const ticker = data.data;

      // Bybit sends openInterestValue in USD
      const oi = parseFloat(ticker.openInterestValue || ticker.openInterest || 0);
      const price = parseFloat(ticker.lastPrice || ticker.markPrice || 0);

      if (oi > 0 && price > 0) {
        latestData = {
          openInterest: oi,
          price: price
        };
      }
    }
  }

  onError(error) {
    // Error already logged by base class
  }
}

/**
 * Update cached signal based on OI history
 */
function updateCachedSignal() {
  if (oiHistory.length < 2) {
    cachedSignal.interpretation = `Collecting OI data (${oiHistory.length} samples)...`;
    return;
  }

  const oldest = oiHistory[0];
  const newest = oiHistory[oiHistory.length - 1];

  const oiChange = (newest.openInterest - oldest.openInterest) / oldest.openInterest;
  const priceChange = (newest.price - oldest.price) / oldest.price;

  // Determine correlation and signal
  let correlation = 'NEUTRAL';
  let signal = 'NEUTRAL';
  let confidence = 0.3;
  let interpretation = '';

  const oiUp = oiChange > CONFIG.THRESHOLDS.SIGNIFICANT_OI_CHANGE;
  const oiDown = oiChange < -CONFIG.THRESHOLDS.SIGNIFICANT_OI_CHANGE;
  const priceUp = priceChange > CONFIG.THRESHOLDS.SIGNIFICANT_PRICE_CHANGE;
  const priceDown = priceChange < -CONFIG.THRESHOLDS.SIGNIFICANT_PRICE_CHANGE;

  if (oiUp && priceUp) {
    // New longs opening - bullish trend confirmation
    correlation = 'OI_UP_PRICE_UP';
    signal = 'BULLISH';
    confidence = 0.7;
    interpretation = `New longs opening (OI +${(oiChange*100).toFixed(2)}%, Price +${(priceChange*100).toFixed(2)}%)`;
  } else if (oiUp && priceDown) {
    // New shorts opening - bearish trend confirmation
    correlation = 'OI_UP_PRICE_DOWN';
    signal = 'BEARISH';
    confidence = 0.7;
    interpretation = `New shorts opening (OI +${(oiChange*100).toFixed(2)}%, Price ${(priceChange*100).toFixed(2)}%)`;
  } else if (oiDown && priceUp) {
    // Short covering rally - weak bullish
    correlation = 'OI_DOWN_PRICE_UP';
    signal = 'BULLISH';
    confidence = 0.5;
    interpretation = `Short covering rally (OI ${(oiChange*100).toFixed(2)}%, Price +${(priceChange*100).toFixed(2)}%)`;
  } else if (oiDown && priceDown) {
    // Long liquidation - weak bearish
    correlation = 'OI_DOWN_PRICE_DOWN';
    signal = 'BEARISH';
    confidence = 0.5;
    interpretation = `Long liquidation (OI ${(oiChange*100).toFixed(2)}%, Price ${(priceChange*100).toFixed(2)}%)`;
  } else {
    interpretation = `No clear OI/price correlation (OI ${(oiChange*100).toFixed(2)}%, Price ${(priceChange*100).toFixed(2)}%)`;
  }

  cachedSignal = {
    signal,
    confidence,
    oiChange: oiChange * 100,  // Store as percentage
    priceChange: priceChange * 100,
    correlation,
    currentOI: latestData.openInterest,
    currentPrice: latestData.price,
    interpretation,
    connected: cachedSignal.connected,
    sampleCount: oiHistory.length,
    windowMinutes: CONFIG.ROLLING_WINDOW_MS / 60000
  };
}

// ============================================================
// SINGLETON INSTANCE
// ============================================================

let oracle = null;

/**
 * Initialize the OI oracle
 */
function initialize() {
  if (oracle) return;

  oracle = new OIOracle();
  oracle.connect();

  console.log(JSON.stringify({
    action: 'OI_ORACLE_INITIALIZED',
    source: 'Bybit WebSocket (FREE)',
    stream: 'tickers.BTCUSDT',
    sampleInterval: (CONFIG.SAMPLE_INTERVAL_MS / 1000) + 's',
    rollingWindow: (CONFIG.ROLLING_WINDOW_MS / 60000) + ' minutes',
    timestamp: new Date().toISOString()
  }));
}

/**
 * Get current OI signal
 * @returns {Promise<Object>} OI signal
 */
async function getOISignal() {
  if (!oracle) {
    initialize();
    // Wait a moment for initial connection
    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  return { ...cachedSignal };
}

/**
 * Check if OI indicates DEGEN-worthy conditions
 * @param {Object} data - OI signal (optional, uses cached if not provided)
 * @returns {Object} DEGEN trigger status
 */
function checkDegenCondition(data) {
  const signal = data || cachedSignal;

  if (!signal || !signal.connected) {
    return { trigger: false };
  }

  // Extreme OI change with price confirmation
  const extremeOI = Math.abs(signal.oiChange) > CONFIG.DEGEN.EXTREME_OI_CHANGE * 100;

  if (extremeOI && signal.confidence >= 0.7) {
    return {
      trigger: true,
      side: signal.signal === 'BULLISH' ? 'YES' : 'NO',
      reason: `Extreme OI ${signal.oiChange > 0 ? 'surge' : 'drop'}: ${signal.oiChange.toFixed(1)}% - ${signal.interpretation}`,
      confidence: signal.confidence
    };
  }

  return { trigger: false };
}

/**
 * Get OI history for analysis
 * @returns {Array} OI samples
 */
function getOIHistory() {
  return [...oiHistory];
}

/**
 * Shutdown the oracle
 */
function shutdown() {
  if (oracle) {
    oracle.shutdown();
    oracle = null;
  }

  if (sampleInterval) {
    clearInterval(sampleInterval);
    sampleInterval = null;
  }

  oiHistory = [];
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initialize,
  getOISignal,
  checkDegenCondition,
  getOIHistory,
  shutdown,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== BYBIT OPEN INTEREST ORACLE SELF-TEST ===\n');
  console.log('Connecting to Bybit WebSocket...');
  console.log('Heartbeat: ping every 20 seconds (required)');
  console.log('This is FREE - no API key required!\n');

  initialize();

  // Check status every 10 seconds
  const statusInterval = setInterval(async () => {
    const data = await getOISignal();
    console.log('\nOI Signal:', JSON.stringify({
      connected: data.connected,
      signal: data.signal,
      correlation: data.correlation,
      oiChange: data.oiChange?.toFixed(3) + '%',
      priceChange: data.priceChange?.toFixed(3) + '%',
      currentOI: '$' + (data.currentOI / 1000000000).toFixed(2) + 'B',
      currentPrice: '$' + data.currentPrice?.toFixed(2),
      samples: data.sampleCount,
      interpretation: data.interpretation
    }, null, 2));

    const degen = checkDegenCondition(data);
    if (degen.trigger) {
      console.log('\n*** DEGEN TRIGGER ***:', degen.reason);
    }
  }, 10000);

  // Run for 2 minutes then exit (need time to collect samples)
  setTimeout(() => {
    console.log('\n=== TEST COMPLETE ===');
    console.log('OI samples collected:', oiHistory.length);
    clearInterval(statusInterval);
    shutdown();
    process.exit(0);
  }, 120000);

  console.log('Monitoring OI for 2 minutes (sampling every 60s)...\n');
}
