/**
 * MULTI-EXCHANGE FUNDING ORACLE
 *
 * Cross-exchange funding rate comparison.
 * Connects to Bybit and OKX for funding rate consensus detection.
 *
 * WebSockets:
 * - Bybit: wss://stream.bybit.com/v5/public/linear (tickers.BTCUSDT)
 * - OKX: wss://ws.okx.com:8443/ws/v5/public (funding-rate channel)
 *
 * NO API KEYS REQUIRED - Free public streams
 */

const { BaseWebSocketOracle } = require('./base-websocket-oracle');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  BYBIT_WS_URL: 'wss://stream.bybit.com/v5/public/linear',
  OKX_WS_URL: 'wss://ws.okx.com:8443/ws/v5/public',

  BYBIT_HEARTBEAT_MS: 20000,  // Bybit requires ping every 20s
  OKX_HEARTBEAT_MS: 25000,    // OKX uses 30s timeout, ping at 25s

  // Funding rate thresholds (as decimal, e.g., 0.0001 = 0.01%)
  THRESHOLDS: {
    EXTREME_FUNDING: 0.0005,     // 0.05% = extreme
    MODERATE_FUNDING: 0.0001,    // 0.01% = moderate
    DIVERGENCE_ALERT: 0.0003     // 0.03% divergence = alert
  }
};

// ============================================================
// STATE
// ============================================================

let fundingRates = {
  bybit: null,
  okx: null
};

let cachedSignal = {
  signal: 'NEUTRAL',
  confidence: 0.3,
  bybitRate: null,
  okxRate: null,
  avgRate: null,
  divergence: 0,
  interpretation: 'Initializing...',
  connected: { bybit: false, okx: false }
};

// ============================================================
// BYBIT ORACLE
// ============================================================

class BybitFundingOracle extends BaseWebSocketOracle {
  constructor() {
    super({
      wsUrl: CONFIG.BYBIT_WS_URL,
      name: 'BYBIT_FUNDING',
      heartbeatIntervalMs: CONFIG.BYBIT_HEARTBEAT_MS
    });
  }

  sendHeartbeat() {
    this.send({ op: 'ping' });
  }

  onConnect() {
    cachedSignal.connected.bybit = true;

    // Subscribe to BTCUSDT ticker (includes funding rate)
    this.send({
      op: 'subscribe',
      args: ['tickers.BTCUSDT']
    });
  }

  onDisconnect() {
    cachedSignal.connected.bybit = false;
    fundingRates.bybit = null;
    updateCachedSignal();
  }

  onMessage(data) {
    // Handle pong
    if (data.op === 'pong' || data.ret_msg === 'pong') return;

    // Handle subscription confirmation
    if (data.op === 'subscribe') return;

    // Handle ticker data
    if (data.topic === 'tickers.BTCUSDT' && data.data) {
      const ticker = data.data;
      const rate = parseFloat(ticker.fundingRate || 0);

      if (rate !== 0 || fundingRates.bybit === null) {
        fundingRates.bybit = rate;
        updateCachedSignal();
      }
    }
  }
}

// ============================================================
// OKX ORACLE
// ============================================================

class OKXFundingOracle extends BaseWebSocketOracle {
  constructor() {
    super({
      wsUrl: CONFIG.OKX_WS_URL,
      name: 'OKX_FUNDING',
      heartbeatIntervalMs: CONFIG.OKX_HEARTBEAT_MS
    });
  }

  sendHeartbeat() {
    // OKX uses text "ping" for heartbeat
    this.sendRaw('ping');
  }

  onConnect() {
    cachedSignal.connected.okx = true;

    // Subscribe to funding rate channel
    this.send({
      op: 'subscribe',
      args: [{
        channel: 'funding-rate',
        instId: 'BTC-USDT-SWAP'
      }]
    });
  }

  onDisconnect() {
    cachedSignal.connected.okx = false;
    fundingRates.okx = null;
    updateCachedSignal();
  }

  onMessage(data) {
    // Handle subscription confirmation
    if (data.event === 'subscribe') {
      console.log(JSON.stringify({
        action: 'OKX_FUNDING_SUBSCRIBED',
        success: true,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    // Handle funding rate data
    if (data.arg?.channel === 'funding-rate' && data.data?.[0]) {
      const rate = parseFloat(data.data[0].fundingRate || 0);

      if (rate !== 0 || fundingRates.okx === null) {
        fundingRates.okx = rate;
        updateCachedSignal();
      }
    }
  }
}

/**
 * Update cached signal based on funding rates from both exchanges
 */
function updateCachedSignal() {
  const rates = [];
  if (fundingRates.bybit !== null) rates.push(fundingRates.bybit);
  if (fundingRates.okx !== null) rates.push(fundingRates.okx);

  if (rates.length === 0) {
    cachedSignal.interpretation = 'Waiting for funding data...';
    return;
  }

  const avgRate = rates.reduce((a, b) => a + b, 0) / rates.length;
  const divergence = rates.length >= 2
    ? Math.abs(fundingRates.bybit - fundingRates.okx)
    : 0;

  let signal = 'NEUTRAL';
  let confidence = 0.3;
  let interpretation = '';

  // Check for extreme funding consensus
  const allExtremeBullish = rates.every(r => r < -CONFIG.THRESHOLDS.EXTREME_FUNDING);
  const allExtremeBearish = rates.every(r => r > CONFIG.THRESHOLDS.EXTREME_FUNDING);

  if (allExtremeBullish && rates.length >= 2) {
    // Extreme negative funding on all exchanges = oversold = contrarian bullish
    signal = 'BULLISH';
    confidence = 0.75;
    interpretation = `Cross-exchange oversold consensus (avg: ${(avgRate * 100).toFixed(4)}%)`;
  } else if (allExtremeBearish && rates.length >= 2) {
    // Extreme positive funding on all exchanges = overbought = contrarian bearish
    signal = 'BEARISH';
    confidence = 0.75;
    interpretation = `Cross-exchange overbought consensus (avg: ${(avgRate * 100).toFixed(4)}%)`;
  } else if (divergence > CONFIG.THRESHOLDS.DIVERGENCE_ALERT) {
    // Significant divergence between exchanges = uncertainty
    signal = 'VOLATILE';
    confidence = 0.4;
    interpretation = `Funding divergence: Bybit ${(fundingRates.bybit * 100).toFixed(4)}% vs OKX ${(fundingRates.okx * 100).toFixed(4)}%`;
  } else if (avgRate > CONFIG.THRESHOLDS.MODERATE_FUNDING) {
    // Moderate positive funding = crowded longs = slightly bearish
    signal = 'BEARISH';
    confidence = 0.5;
    interpretation = `Moderate crowded longs (avg: ${(avgRate * 100).toFixed(4)}%)`;
  } else if (avgRate < -CONFIG.THRESHOLDS.MODERATE_FUNDING) {
    // Moderate negative funding = crowded shorts = slightly bullish
    signal = 'BULLISH';
    confidence = 0.5;
    interpretation = `Moderate crowded shorts (avg: ${(avgRate * 100).toFixed(4)}%)`;
  } else {
    interpretation = `Neutral funding (avg: ${(avgRate * 100).toFixed(4)}%)`;
  }

  cachedSignal = {
    signal,
    confidence,
    bybitRate: fundingRates.bybit,
    okxRate: fundingRates.okx,
    avgRate,
    divergence,
    interpretation,
    connected: { ...cachedSignal.connected },
    exchanges: rates.length
  };
}

// ============================================================
// SINGLETON INSTANCES
// ============================================================

let bybitOracle = null;
let okxOracle = null;

/**
 * Initialize both funding oracles
 */
function initialize() {
  if (!bybitOracle) {
    bybitOracle = new BybitFundingOracle();
    bybitOracle.connect();
  }

  if (!okxOracle) {
    okxOracle = new OKXFundingOracle();
    okxOracle.connect();
  }

  console.log(JSON.stringify({
    action: 'MULTI_FUNDING_ORACLE_INITIALIZED',
    exchanges: ['Bybit', 'OKX'],
    source: 'WebSocket (FREE)',
    timestamp: new Date().toISOString()
  }));
}

/**
 * Get current multi-exchange funding signal
 * @returns {Promise<Object>} Funding signal
 */
async function getMultiFundingSignal() {
  if (!bybitOracle || !okxOracle) {
    initialize();
    // Wait for connections
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  return { ...cachedSignal };
}

/**
 * Check if funding indicates DEGEN-worthy conditions
 * @param {Object} data - Funding signal (optional, uses cached if not provided)
 * @returns {Object} DEGEN trigger status
 */
function checkDegenCondition(data) {
  const signal = data || cachedSignal;

  if (!signal || signal.exchanges < 2) {
    return { trigger: false };
  }

  // Cross-exchange extreme consensus = DEGEN trigger
  if (signal.confidence >= 0.75 && signal.signal !== 'NEUTRAL' && signal.signal !== 'VOLATILE') {
    return {
      trigger: true,
      side: signal.signal === 'BULLISH' ? 'YES' : 'NO',
      reason: signal.interpretation,
      confidence: signal.confidence
    };
  }

  return { trigger: false };
}

/**
 * Shutdown both oracles
 */
function shutdown() {
  if (bybitOracle) {
    bybitOracle.shutdown();
    bybitOracle = null;
  }

  if (okxOracle) {
    okxOracle.shutdown();
    okxOracle = null;
  }

  fundingRates = { bybit: null, okx: null };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initialize,
  getMultiFundingSignal,
  checkDegenCondition,
  shutdown,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== MULTI-EXCHANGE FUNDING ORACLE SELF-TEST ===\n');
  console.log('Connecting to Bybit and OKX WebSockets...');
  console.log('This is FREE - no API keys required!\n');

  initialize();

  // Check status every 5 seconds
  const statusInterval = setInterval(async () => {
    const data = await getMultiFundingSignal();
    console.log('\nMulti-Funding Signal:', JSON.stringify({
      connected: data.connected,
      signal: data.signal,
      bybitRate: data.bybitRate !== null ? (data.bybitRate * 100).toFixed(4) + '%' : 'N/A',
      okxRate: data.okxRate !== null ? (data.okxRate * 100).toFixed(4) + '%' : 'N/A',
      avgRate: data.avgRate !== null ? (data.avgRate * 100).toFixed(4) + '%' : 'N/A',
      divergence: (data.divergence * 100).toFixed(4) + '%',
      exchanges: data.exchanges,
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
    clearInterval(statusInterval);
    shutdown();
    process.exit(0);
  }, 30000);

  console.log('Monitoring funding rates for 30 seconds...\n');
}
