#!/usr/bin/env node
// ============================================================
// ASYMMETRIC EDGE BOT - Based on $402k/month trader
// ============================================================
// Strategy: Only bet when asymmetric edge exists (cheap prices)
// Key Insight: Minimum 5 SHARES (not $5)
//   - At 20¢: 5 shares = $1.00
//   - At 10¢: 5 shares = $0.50
// Profile: https://polymarket.com/@k9Q2mX4L8A7ZP3R

// Load environment variables from .env file
require('dotenv').config();

const WebSocket = require('ws');
const https = require('https');
const { execSync } = require('child_process');
const windowPriceTracker = require('./window-price-tracker');
const windowHistoryTracker = require('./window-history-tracker');
const marketDataAggregator = require('./market-data-aggregator');
const moonshotSupervisor = require('./moonshot-supervisor');

// 8-PLAYER TRADING DESK SYSTEM (Farm + Degen + Clipper + Execution)
const virtualAccounts = require('./virtual-account-manager');
const dialogueRecorder = require('./dialogue-recorder');
const leaderboard = require('./leaderboard-tracker');
const tradingDeskOrchestrator = require('./trading-desk-orchestrator');
const clipperDeskManager = require('./clipper-desk-manager');
const executionDesk = require('./execution-desk');
const binanceOracle = require('./binance-oracle');
const treasuryDesk = require('./treasury-desk');
const wealthFortress = require('./wealth-fortress');
const blackBoxRecorder = require('./black-box-recorder');
const fs = require('fs');
const path = require('path');

// ALPHA SIGNAL ORACLES (Gemini-recommended)
const fundingRateOracle = require('./funding-rate-oracle');
const liquidationOracle = require('./liquidation-oracle');
const copyTradingOracle = require('./copy-trading-oracle');

// NEW REAL-TIME WEBSOCKET ORACLES (Phase 2)
const depthOracle = require('./oracles/binance-depth-oracle');
const whaleOracle = require('./oracles/binance-aggtrade-oracle');
const oiOracle = require('./oracles/bybit-oi-oracle');
const multiFundingOracle = require('./oracles/multi-funding-oracle');

// SESSION TRACKING AND AI CONSULTATION (3-Day Framework)
const sessionTracker = require('./session-tracker');

// ============================================================
// WALLET ORACLE - Dynamic Balance Fetching
// Removes the hardcoded balance tether for full autonomy
// ============================================================

const WALLET_CONFIG_PATH = path.join(process.env.HOME, '.pmarket-cli', 'config.json');
const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e on Polygon
const FALLBACK_BALANCE = 20.00; // Conservative fallback if RPC fails

/**
 * Fetch actual USDC balance from Polygon blockchain
 * Uses JSON-RPC eth_call to query ERC20 balanceOf
 * @returns {Promise<number>} USDC balance in dollars
 */
async function getWalletBalance() {
  try {
    // Load wallet config
    if (!fs.existsSync(WALLET_CONFIG_PATH)) {
      console.warn('[WALLET_ORACLE] Config not found, using fallback');
      return FALLBACK_BALANCE;
    }

    const config = JSON.parse(fs.readFileSync(WALLET_CONFIG_PATH, 'utf8'));
    const walletAddress = config.funderAddress;
    const rpcUrl = config.rpcProvider || 'https://polygon-rpc.com';

    if (!walletAddress) {
      console.warn('[WALLET_ORACLE] No wallet address configured');
      return FALLBACK_BALANCE;
    }

    // Build balanceOf(address) call data
    // Function selector: 0x70a08231
    // Pad address to 32 bytes
    const paddedAddress = walletAddress.toLowerCase().replace('0x', '').padStart(64, '0');
    const callData = '0x70a08231' + paddedAddress;

    // Make JSON-RPC call
    const response = await new Promise((resolve, reject) => {
      const url = new URL(rpcUrl);
      const postData = JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{
          to: USDC_CONTRACT,
          data: callData
        }, 'latest'],
        id: 1
      });

      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': postData.length
        },
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error('Invalid JSON response'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('RPC request timeout'));
      });

      req.write(postData);
      req.end();
    });

    if (response.error) {
      throw new Error(response.error.message);
    }

    // Parse hex result (USDC has 6 decimals)
    const rawBalance = BigInt(response.result);
    const usdcBalance = Number(rawBalance) / 1e6;

    console.log(JSON.stringify({
      action: 'WALLET_ORACLE_SUCCESS',
      balance: usdcBalance.toFixed(2),
      wallet: maskId(walletAddress),
      source: 'POLYGON_RPC',
      timestamp: new Date().toISOString()
    }));

    return usdcBalance;

  } catch (error) {
    console.warn(JSON.stringify({
      action: 'WALLET_ORACLE_FAILED',
      error: error.message,
      fallback: FALLBACK_BALANCE,
      timestamp: new Date().toISOString()
    }));
    return FALLBACK_BALANCE;
  }
}

// Cache for balance (refresh every 5 minutes to reduce RPC calls)
let cachedBalance = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get wallet balance with caching
 * @param {boolean} forceRefresh - Force a fresh RPC call
 * @returns {Promise<number>} USDC balance
 */
async function getCachedWalletBalance(forceRefresh = false) {
  const now = Date.now();

  if (!forceRefresh && cachedBalance !== null && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedBalance;
  }

  cachedBalance = await getWalletBalance();
  cacheTimestamp = now;
  return cachedBalance;
}

// ============================================================
// ALPHA SIGNAL AGGREGATION (Gemini-recommended)
// Combines funding rate, liquidation, and smart money signals
// ============================================================

let cachedAlphaSignals = null;
let alphaSignalsCacheTime = 0;
const ALPHA_SIGNALS_CACHE_TTL = 30000; // 30 seconds

/**
 * Get aggregated alpha signals from all oracles
 * @param {boolean} forceRefresh - Bypass cache
 * @returns {Promise<Object>} Aggregated signals with consensus
 */
async function getAggregatedSignals(forceRefresh = false) {
  const now = Date.now();

  // Return cached if valid
  if (!forceRefresh && cachedAlphaSignals && (now - alphaSignalsCacheTime) < ALPHA_SIGNALS_CACHE_TTL) {
    return { ...cachedAlphaSignals, cached: true };
  }

  try {
    // Fetch all 7 signals in parallel
    const [funding, liquidation, smartMoney, depth, whale, oi, multiFunding] = await Promise.all([
      fundingRateOracle.getFundingRate().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message })),
      liquidationOracle.getLiquidationData().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message })),
      copyTradingOracle.getSmartMoneySignal().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message })),
      depthOracle.getDepthSignal().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message })),
      whaleOracle.getWhaleSignal().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message })),
      oiOracle.getOISignal().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message })),
      multiFundingOracle.getMultiFundingSignal().catch(e => ({ signal: 'NEUTRAL', confidence: 0, error: e.message }))
    ]);

    // Log all signals
    console.log(JSON.stringify({
      action: 'ALPHA_SIGNALS_FETCHED',
      funding: funding.signal,
      liquidation: liquidation.signal,
      smartMoney: smartMoney.signal,
      depth: depth.signal,
      whale: whale.signal,
      oi: oi.signal,
      multiFunding: multiFunding.signal,
      timestamp: new Date().toISOString()
    }));

    // Calculate weighted scores (total = 1.0)
    // Original 3: funding 15%, liquidation 15%, smartMoney 10%
    // New 4: depth 15%, whale 10%, oi 15%, multiFunding 10%
    // Reserved: delta 10%
    const weights = {
      funding: 0.15,
      liquidation: 0.15,
      smartMoney: 0.10,
      depth: 0.15,
      whale: 0.10,
      oi: 0.15,
      multiFunding: 0.10
    };

    let bullishScore = 0;
    let bearishScore = 0;

    // Process all signals
    const signals = [
      { data: funding, weight: weights.funding },
      { data: liquidation, weight: weights.liquidation },
      { data: smartMoney, weight: weights.smartMoney },
      { data: depth, weight: weights.depth },
      { data: whale, weight: weights.whale },
      { data: oi, weight: weights.oi },
      { data: multiFunding, weight: weights.multiFunding }
    ];

    signals.forEach(({ data, weight }) => {
      if (data.signal === 'BULLISH') bullishScore += weight * (data.confidence || 0.5);
      if (data.signal === 'BEARISH') bearishScore += weight * (data.confidence || 0.5);
    });

    // Determine consensus (need 0.1 margin for clear signal)
    let consensus = 'NEUTRAL';
    if (bullishScore > bearishScore + 0.1) consensus = 'BULLISH';
    else if (bearishScore > bullishScore + 0.1) consensus = 'BEARISH';

    const result = {
      funding,
      liquidation,
      smartMoney,
      depth,
      whale,
      oi,
      multiFunding,
      aggregated: {
        bullishScore: parseFloat(bullishScore.toFixed(3)),
        bearishScore: parseFloat(bearishScore.toFixed(3)),
        consensus,
        strength: parseFloat(Math.abs(bullishScore - bearishScore).toFixed(3)),
        signalCount: 7
      },
      timestamp: new Date().toISOString()
    };

    // Cache result
    cachedAlphaSignals = result;
    alphaSignalsCacheTime = now;

    return result;

  } catch (e) {
    console.log(JSON.stringify({
      action: 'ALPHA_SIGNALS_ERROR',
      error: e.message,
      timestamp: new Date().toISOString()
    }));

    return cachedAlphaSignals || {
      aggregated: { consensus: 'NEUTRAL', bullishScore: 0, bearishScore: 0, strength: 0 },
      error: e.message
    };
  }
}

/**
 * Check if alpha signals conflict with chosen side
 * Returns adjustment factor for position size (0.5 = reduce by half, 1.0 = no change)
 * @param {string} chosenSide - 'YES' or 'NO'
 * @param {Object} alphaSignals - Result from getAggregatedSignals()
 * @returns {Object} { conflict: boolean, sizeMultiplier: number, reason: string }
 */
function checkAlphaSignalConflict(chosenSide, alphaSignals) {
  if (!alphaSignals || !alphaSignals.aggregated) {
    return { conflict: false, sizeMultiplier: 1.0, reason: 'No alpha signals available' };
  }

  const consensus = alphaSignals.aggregated.consensus;
  const strength = alphaSignals.aggregated.strength;

  // Map consensus to expected side
  const expectedSide = consensus === 'BULLISH' ? 'YES' : consensus === 'BEARISH' ? 'NO' : null;

  // No conflict if neutral or aligned
  if (!expectedSide || expectedSide === chosenSide) {
    return {
      conflict: false,
      sizeMultiplier: 1.0,
      reason: consensus === 'NEUTRAL' ? 'Neutral alpha signal' : `Alpha confirms ${chosenSide}`
    };
  }

  // Conflict detected - reduce position size based on strength
  const sizeMultiplier = strength > 0.15 ? 0.25 : strength > 0.10 ? 0.50 : 0.75;

  console.log(JSON.stringify({
    action: 'ALPHA_SIGNAL_CONFLICT',
    chosenSide,
    alphaConsensus: consensus,
    strength: strength.toFixed(3),
    sizeMultiplier,
    timestamp: new Date().toISOString()
  }));

  return {
    conflict: true,
    sizeMultiplier,
    reason: `Alpha signals favor ${expectedSide} (strength: ${(strength * 100).toFixed(0)}%)`
  };
}

// ============================================================
// LOG OBFUSCATION - Fix #15: Mask sensitive data in logs
// ============================================================

/**
 * Mask sensitive identifiers for secure logging
 * Shows first 6 and last 4 characters only
 * @param {string} id - Token ID or address to mask
 * @returns {string} Masked identifier
 */
function maskId(id) {
  if (!id || typeof id !== 'string') return id;
  if (id.length <= 10) return id;
  return `${id.substring(0, 6)}...${id.substring(id.length - 4)}`;
}

/**
 * Generate a short hash reference for audit trails
 * @param {string} str - String to hash
 * @returns {string} Short hash reference
 */
function hashRef(str) {
  if (!str) return 'null';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return 'ref-' + Math.abs(hash).toString(16).substring(0, 8);
}

// ============================================================
// STRATEGY CONFIG
// ============================================================

const CONFIG = {
  // ALPHA SIGNAL WEIGHTS (Gemini-recommended)
  // Used for multi-signal confirmation before trading
  signalWeights: {
    funding: 0.30,       // Binance funding rate (sentiment)
    liquidation: 0.25,   // CoinGlass liquidation data (squeeze detection)
    smartMoney: 0.15,    // Polymarket copy trading signal
    delta: 0.30          // BTC price movement (existing)
  },

  // Asymmetric edge thresholds (HYBRID STRATEGY)
  maxEntryPrice: 0.60,         // Never buy above 60¢ (terrible edge)
  stopAddingPrice: 0.70,       // Stop adding if price rises above 70¢

  // Scaled position sizing based on price (for asymmetric edge fallback)
  // AGGRESSIVE MODE: Sized to always buy at least 5 shares at tier's max price
  valueTiers: {
    extremeValue: { max: 0.20, size: 4.00 },   // 10-20¢: $4 bets (20+ shares)
    greatValue:   { max: 0.30, size: 3.00 },   // 20-30¢: $3 bets (10+ shares)
    goodValue:    { max: 0.40, size: 2.50 },   // 30-40¢: $2.50 bets (6+ shares)
    fairValue:    { max: 0.50, size: 3.00 },   // 40-50¢: $3 bets (6+ shares)
    minimalEdge:  { max: 0.60, size: 3.50 },   // 50-60¢: $3.50 bets (5+ shares)
  },

  // Dynamic position sizing (KIMI-driven based on confidence)
  // AGGRESSIVE MODE: Higher % due to small balance ($14.81) - need to grow fast!
  positionSizing: {
    minPercentage: 0.10,       // 10% of balance (low confidence) = $1.48
    maxPercentage: 0.25,       // 25% of balance (high conviction) = $3.70
    confidenceThresholds: {
      skip: 0.55,              // Below 55% = SKIP
      low: 0.65,               // 55-65% = 10-13% ($1.48-1.93)
      medium: 0.75,            // 65-75% = 13-18% ($1.93-2.67)
      high: 0.85,              // 75-85% = 18-22% ($2.67-3.26)
      max: 1.00                // 85%+ = 25% ($3.70 MAX)
    }
  },
  minShares: 5,                // Polymarket minimum
  maxOrdersPerWindow: 4,       // Max 4 orders per window (REDUCED from 12 for safety)

  // Timing
  minTimeBetweenOrders: 60,    // 60 seconds between orders
  priceCheckInterval: 5000,    // Check every 5 seconds

  // Consultation timing
  kimiConsultationWindow: {
    initial: { start: 850, end: 800 },  // 50-100s into window (early decision)
    riskManagerDelay: 30                // Wait 30s, then risk manager reviews
  },

  // ============================================================
  // GEMINI STRATEGY IMPROVEMENTS (Deep Dive Session)
  // ============================================================

  // Entry timing gate: Only trade in last 4-5 minutes of window
  entryTimingGate: {
    enabled: true,
    minTimeLeftSeconds: 240,  // 4 minutes - don't enter with less time
    maxTimeLeftSeconds: 300   // 5 minutes - don't enter with more time
  },

  // Minimum delta thresholds: Require significant price movement
  deltaThresholds: {
    YES: 50,   // Require +$50 for YES bet
    NO: -50    // Require -$50 for NO bet
  },

  // Delta magnitude gate: Skip trades when delta is too small (consolidation)
  deltaMagnitudeGate: {
    enabled: true,
    minMagnitude: 25  // Skip if absolute delta < $25 (market indecision)
  },

  // Orderbook BAR (Bid-Ask Ratio) thresholds - REFINED per Gemini
  orderbook: {
    strongBullish: 1.30,   // BAR > 1.30 = strong buying pressure
    moderateBullish: 1.15, // BAR > 1.15 = moderate buying pressure
    moderateBearish: 0.85, // BAR < 0.85 = moderate selling pressure
    strongBearish: 0.70,   // BAR < 0.70 = strong selling pressure
    barChangeWindow: 30000,  // Track BAR change over 30 seconds
    barChangeThreshold: 0.05 // Significant BAR change
  },

  // Signal weighting: How much to weight each signal type
  signalWeights: {
    delta: 0.60,     // 60% weight to price delta
    orderbook: 0.40  // 40% weight to orderbook signals
  },

  // Position sizing - GEMINI CONSERVATIVE
  positionSizing: {
    targetPercent: 0.025,    // Target 2.5% of balance
    minFloor: true,          // Use minimum share requirement as floor
    maxPercent: 0.10,        // Never exceed 10% per trade
    scaleUpThreshold: 3,     // Scale up to 3.5% after this many consecutive wins
    scaleUpPercent: 0.035    // 3.5% when confident
  },

  // Emergency panic sell: DISABLED per Gemini
  emergencyPanicSell: {
    enabled: false
  },

  // Trade logging for adaptive learning
  tradeLogging: {
    enabled: true,
    logFile: '/tmp/polymarket-trade-log.json'
  }
};

// ============================================================
// STATE
// ============================================================

let MEMORY = {
  currentWindow: null,
  windowState: {},             // Track state per window
  priceHistory: [],
  deltaHistory: [],            // Track delta over time for weighted average
  activeBalance: 0,            // War Chest (tradeable balance from Wealth Fortress)
  realBalance: 0,              // Total equity (real balance including vault)
};

let CURRENT_PRICE = null;
let PRICE_LAST_UPDATED = 0;
const PRICE_MAX_AGE_SECONDS = 10; // 10-second staleness threshold
let WS_BINANCE = null;

/**
 * Get Binance price only if fresh (within TTL)
 * Returns null if price is stale - trading should halt
 */
function getBinancePriceIfFresh() {
  const priceAge = (Date.now() - PRICE_LAST_UPDATED) / 1000;

  if (priceAge > PRICE_MAX_AGE_SECONDS) {
    console.log(JSON.stringify({
      action: 'ORACLE_STALE',
      priceAgeSeconds: priceAge.toFixed(1),
      maxAgeSeconds: PRICE_MAX_AGE_SECONDS,
      reason: 'Skipping analysis - would be gambling on stale data',
      timestamp: new Date().toISOString()
    }));
    return null;
  }
  return CURRENT_PRICE;
}

// ============================================================
// GEMINI STRATEGY HELPER FUNCTIONS
// ============================================================

/**
 * Track delta history for weighted average calculation
 * @param {number} delta - Current price delta
 */
function trackDeltaHistory(delta) {
  const now = Date.now();
  MEMORY.deltaHistory.push({ timestamp: now, delta });
  // Keep last 5 minutes only
  const cutoff = now - 300000;
  MEMORY.deltaHistory = MEMORY.deltaHistory.filter(d => d.timestamp > cutoff);
}

/**
 * Calculate weighted delta using time decay
 * Formula: (0.7 × CurrentDelta) + (0.3 × Delta3MinAgo)
 * @returns {number|null} Weighted delta or null if not enough history
 */
function getWeightedDelta() {
  if (MEMORY.deltaHistory.length < 2) return null;

  const now = Date.now();
  const threeMinAgo = now - 180000;

  const recent = MEMORY.deltaHistory[MEMORY.deltaHistory.length - 1];
  const older = MEMORY.deltaHistory.find(d => d.timestamp <= threeMinAgo) || MEMORY.deltaHistory[0];

  // Formula: (0.7 × CurrentDelta) + (0.3 × Delta3MinAgo)
  return (0.7 * recent.delta) + (0.3 * older.delta);
}

/**
 * Check if current time is within entry timing gate
 * Only allows trading in last 4-5 minutes of window
 * @param {number} timeLeftSeconds - Seconds remaining in window
 * @returns {Object} {allowed: boolean, reason: string}
 */
function isWithinEntryTimingGate(timeLeftSeconds) {
  if (!CONFIG.entryTimingGate.enabled) {
    return { allowed: true, reason: 'Timing gate disabled' };
  }

  const { minTimeLeftSeconds, maxTimeLeftSeconds } = CONFIG.entryTimingGate;

  if (timeLeftSeconds > maxTimeLeftSeconds) {
    return {
      allowed: false,
      reason: `Too early: ${timeLeftSeconds}s left, gate opens at ${maxTimeLeftSeconds}s`
    };
  }

  if (timeLeftSeconds < minTimeLeftSeconds) {
    return {
      allowed: false,
      reason: `Too late: ${timeLeftSeconds}s left, gate closed at ${minTimeLeftSeconds}s`
    };
  }

  return { allowed: true, reason: `Within gate: ${timeLeftSeconds}s (${minTimeLeftSeconds}-${maxTimeLeftSeconds}s)` };
}

/**
 * Validate delta meets minimum threshold for trade direction
 * @param {number} delta - Current price delta
 * @param {string} side - 'YES' or 'NO'
 * @returns {Object} {valid: boolean, reason: string}
 */
function validateDeltaThreshold(delta, side) {
  const thresholds = CONFIG.deltaThresholds;

  if (side === 'YES' && delta < thresholds.YES) {
    return {
      valid: false,
      reason: `Delta $${delta.toFixed(2)} below YES threshold $${thresholds.YES}`
    };
  }

  if (side === 'NO' && delta > thresholds.NO) {
    return {
      valid: false,
      reason: `Delta $${delta.toFixed(2)} above NO threshold $${thresholds.NO}`
    };
  }

  return { valid: true, reason: `Delta meets ${side} threshold` };
}

/**
 * Check orderbook BAR (Bid-Ask Ratio) confirmation - REFINED per Gemini
 * Uses refined thresholds from CONFIG.orderbook
 * @param {string} prediction - 'YES' or 'NO'
 * @param {Object} orderbook - Orderbook data with bidVolume and askVolume
 * @returns {Object} {confirmed: boolean, BAR: number, strength: string, reason: string}
 */
function checkOrderbookConfirmation(prediction, orderbook) {
  if (!orderbook || !orderbook.bidVolume || !orderbook.askVolume) {
    return { confirmed: true, BAR: null, strength: 'unknown', reason: 'No orderbook data - allowing trade' };
  }

  const BAR = orderbook.bidVolume / orderbook.askVolume;
  const thresholds = CONFIG.orderbook;

  // Determine market pressure strength
  let strength = 'neutral';
  if (BAR >= thresholds.strongBullish) strength = 'strong_bullish';
  else if (BAR >= thresholds.moderateBullish) strength = 'moderate_bullish';
  else if (BAR <= thresholds.strongBearish) strength = 'strong_bearish';
  else if (BAR <= thresholds.moderateBearish) strength = 'moderate_bearish';

  // Check for conflicts with prediction
  if (prediction === 'YES' && BAR < thresholds.moderateBearish) {
    return {
      confirmed: false,
      BAR: BAR,
      strength: strength,
      reason: `${strength} pressure (BAR ${BAR.toFixed(2)}) conflicts with YES prediction`
    };
  }

  if (prediction === 'NO' && BAR > thresholds.moderateBullish) {
    return {
      confirmed: false,
      BAR: BAR,
      strength: strength,
      reason: `${strength} pressure (BAR ${BAR.toFixed(2)}) conflicts with NO prediction`
    };
  }

  return {
    confirmed: true,
    BAR: BAR,
    strength: strength,
    reason: `BAR ${BAR.toFixed(2)} (${strength}) confirms ${prediction}`
  };
}

/**
 * Check delta magnitude - Skip when market is indecisive (Gemini)
 * @param {number} delta - Current price delta
 * @returns {Object} {valid: boolean, magnitude: number, reason: string}
 */
function validateDeltaMagnitude(delta) {
  if (!CONFIG.deltaMagnitudeGate.enabled) {
    return { valid: true, magnitude: Math.abs(delta), reason: 'Delta magnitude gate disabled' };
  }

  const magnitude = Math.abs(delta);
  if (magnitude < CONFIG.deltaMagnitudeGate.minMagnitude) {
    return {
      valid: false,
      magnitude: magnitude,
      reason: `Delta magnitude $${magnitude.toFixed(2)} below $${CONFIG.deltaMagnitudeGate.minMagnitude} threshold (market indecision)`
    };
  }

  return { valid: true, magnitude: magnitude, reason: `Delta magnitude $${magnitude.toFixed(2)} sufficient` };
}

/**
 * Calculate adaptive position size using Gemini's recommendations
 * Uses 2.5% target with minimum share floor
 * @param {number} balance - Available balance
 * @param {number} price - Token price
 * @param {number} consecutiveWins - Number of consecutive wins
 * @returns {Object} {betSize: number, percent: number, reason: string}
 */
function calculateAdaptivePositionSize(balance, price, consecutiveWins = 0) {
  const sizing = CONFIG.positionSizing;

  // Calculate target size based on win streak
  let targetPercent = sizing.targetPercent; // 2.5%
  if (consecutiveWins >= sizing.scaleUpThreshold) {
    targetPercent = sizing.scaleUpPercent; // 3.5% after consecutive wins
  }

  let betSize = balance * targetPercent;

  // Calculate minimum required for 5 shares at current price
  const minShareRequirement = CONFIG.minShares * price;

  // Use the higher of target or minimum (if minFloor enabled)
  if (sizing.minFloor && betSize < minShareRequirement) {
    betSize = minShareRequirement;
  }

  // Never exceed max percent
  const maxBet = balance * sizing.maxPercent;
  if (betSize > maxBet) {
    betSize = maxBet;
  }

  const actualPercent = (betSize / balance) * 100;

  return {
    betSize: betSize,
    percent: actualPercent,
    reason: betSize === minShareRequirement
      ? `Min shares floor: $${betSize.toFixed(2)} (${actualPercent.toFixed(1)}%)`
      : `${targetPercent * 100}% target: $${betSize.toFixed(2)}`
  };
}

/**
 * Log trade for adaptive learning (Gemini recommendation)
 * Tracks all data needed to improve strategy over time
 */
function logTradeForLearning(tradeData) {
  if (!CONFIG.tradeLogging.enabled) return;

  try {
    const logFile = CONFIG.tradeLogging.logFile;
    let trades = [];

    // Load existing log
    if (fs.existsSync(logFile)) {
      trades = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    }

    // Add new trade with all Gemini-recommended fields
    trades.push({
      timestamp: new Date().toISOString(),
      windowSlug: tradeData.windowSlug,
      entryPrice: tradeData.entryPrice,
      delta: tradeData.delta,
      deltaPct: tradeData.deltaPct,
      BAR: tradeData.BAR,
      barStrength: tradeData.barStrength,
      timeRemaining: tradeData.timeRemaining,
      betDirection: tradeData.side,
      positionSize: tradeData.positionSize,
      outcome: tradeData.outcome || null, // Filled in at settlement
      closingPrice: tradeData.closingPrice || null,
      notes: tradeData.notes || ''
    });

    // Keep last 1000 trades
    if (trades.length > 1000) {
      trades = trades.slice(-1000);
    }

    fs.writeFileSync(logFile, JSON.stringify(trades, null, 2));
  } catch (e) {
    console.error('[TRADE_LOG] Failed to log trade:', e.message);
  }
}

/**
 * Calculate win rate for a specific condition from trade log
 * @param {string} condition - Condition to filter by (e.g., 'delta>50')
 * @returns {Object} {winRate: number, count: number}
 */
function getWinRateForCondition(condition) {
  if (!CONFIG.tradeLogging.enabled) return { winRate: 0.5, count: 0 };

  try {
    const logFile = CONFIG.tradeLogging.logFile;
    if (!fs.existsSync(logFile)) return { winRate: 0.5, count: 0 };

    const trades = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    const completed = trades.filter(t => t.outcome !== null);

    if (completed.length === 0) return { winRate: 0.5, count: 0 };

    // Simple condition parsing
    let filtered = completed;
    if (condition.startsWith('delta>')) {
      const threshold = parseFloat(condition.split('>')[1]);
      filtered = completed.filter(t => t.delta > threshold);
    } else if (condition.startsWith('BAR>')) {
      const threshold = parseFloat(condition.split('>')[1]);
      filtered = completed.filter(t => t.BAR && t.BAR > threshold);
    }

    if (filtered.length === 0) return { winRate: 0.5, count: 0 };

    const wins = filtered.filter(t => t.outcome === 'WIN').length;
    return { winRate: wins / filtered.length, count: filtered.length };
  } catch (e) {
    return { winRate: 0.5, count: 0 };
  }
}

// ============================================================
// POSITION SIZING & REDEMPTION HELPERS
// ============================================================

/**
 * Calculate dynamic position size based on confidence (8-15% of balance)
 */
function calculateDynamicPositionSize(confidence, balance) {
  const thresholds = CONFIG.positionSizing.confidenceThresholds;

  // Skip trades below 55% confidence
  if (confidence < thresholds.skip) {
    return 0;
  }

  // Low confidence (55-65%): 8-10% of balance
  if (confidence < thresholds.low) {
    const percentage = 0.08 + (confidence - thresholds.skip) / (thresholds.low - thresholds.skip) * 0.02;
    return balance * percentage;
  }

  // Medium confidence (65-75%): 10-13% of balance
  if (confidence < thresholds.medium) {
    const percentage = 0.10 + (confidence - thresholds.low) / (thresholds.medium - thresholds.low) * 0.03;
    return balance * percentage;
  }

  // High confidence (75-85%): 13-15% of balance
  if (confidence < thresholds.high) {
    const percentage = 0.13 + (confidence - thresholds.medium) / (thresholds.high - thresholds.medium) * 0.02;
    return balance * percentage;
  }

  // Max conviction (85%+): 15% of balance
  return balance * CONFIG.positionSizing.maxPercentage;
}

/**
 * Redeem winning positions to free up capital
 * Called after window closes
 */
async function redeemWinningPositions(windowSlug, winner) {
  console.log(JSON.stringify({
    action: 'CHECKING_REDEMPTION',
    window: windowSlug,
    winner: winner,
    timestamp: new Date().toISOString()
  }));

  try {
    const { execSync } = require('child_process');

    // Get current positions using pmarket-cli -p
    const output = execSync('pmarket-cli -p', {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore']
    });

    // Check if we have winning shares for this window
    // (This is simplified - would need to match tokenIds to window in production)
    const hasWinningShares = output.includes(winner) && output.includes(windowSlug.substring(0, 20));

    if (hasWinningShares) {
      console.log(JSON.stringify({
        action: 'REDEEMING_WINNING_POSITION',
        window: windowSlug,
        side: winner,
        timestamp: new Date().toISOString()
      }));

      // Redeem using pmarket-cli -r (would need proper tokenId in production)
      // For now, just log that we should redeem
      console.log(JSON.stringify({
        action: 'REDEMPTION_NEEDED',
        message: 'Manual redemption required - auto-redemption not yet fully implemented',
        window: windowSlug,
        timestamp: new Date().toISOString()
      }));

      // TODO: Implement actual redemption with proper tokenId lookup
      // execSync(`pmarket-cli -r ${tokenId}`, { timeout: 10000 });
    }
  } catch (error) {
    console.warn('Redemption check failed:', error.message);
  }
}

/**
 * Fetch current USDC balance from Polymarket
 *
 * WALLET ORACLE INTEGRATION:
 * - Queries actual USDC balance from Polygon blockchain
 * - Falls back to FALLBACK_BALANCE if RPC fails
 * - Caches result for 5 minutes to reduce RPC calls
 *
 * WEALTH FORTRESS INTEGRATION:
 * - Syncs real balance with Wealth Fortress
 * - Returns WAR CHEST (tradeable) balance, not total equity
 * - Vault balance is hidden from trading desks
 */
async function fetchBalance() {
  try {
    // ============================================================
    // WALLET ORACLE: Fetch actual balance from blockchain
    // This removes the hardcoded tether for full autonomy
    // ============================================================
    const LIVE_BALANCE = await getCachedWalletBalance();

    // ============================================================
    // WEALTH FORTRESS SYNC
    // This is the critical step that protects profits!
    // ============================================================
    wealthFortress.sync(LIVE_BALANCE);

    // FIX: Validate principal matches actual balance (warns if >10% mismatch)
    wealthFortress.validatePrincipal(LIVE_BALANCE);

    // Get the TRADEABLE balance (War Chest), not total equity
    const tradeableBalance = wealthFortress.getTradeableBalance();
    const fortressReport = wealthFortress.getReport();

    // Store both for reference
    MEMORY.realBalance = LIVE_BALANCE;
    MEMORY.activeBalance = tradeableBalance;

    console.log(JSON.stringify({
      action: 'WEALTH_FORTRESS_SYNC',
      phase: fortressReport.phaseEmoji + ' ' + fortressReport.phase,
      totalEquity: '$' + fortressReport.totalEquity,
      vault: '$' + fortressReport.vault + ' (' + fortressReport.protectedPercentage + ' protected)',
      warChest: '$' + fortressReport.warChest + ' (' + fortressReport.riskPercentage + ' at risk)',
      principal: fortressReport.principalStatus,
      highWaterMark: '$' + fortressReport.highWaterMark,
      source: 'WALLET_ORACLE',
      timestamp: new Date().toISOString()
    }));

    return tradeableBalance;

  } catch (error) {
    console.warn('Wealth Fortress sync failed:', error.message);

    // Fallback to basic balance
    if (MEMORY.activeBalance === 0) {
      MEMORY.activeBalance = 36.00;
    }

    return MEMORY.activeBalance;
  }
}

// ============================================================
// PRICE TRACKING
// ============================================================

function connectBinanceWebSocket() {
  WS_BINANCE = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');

  WS_BINANCE.on('open', () => {
    console.log(JSON.stringify({
      action: 'WEBSOCKET_CONNECTED',
      source: 'Binance',
      timestamp: new Date().toISOString(),
    }));
  });

  WS_BINANCE.on('message', (data) => {
    try {
      const ticker = JSON.parse(data);
      CURRENT_PRICE = parseFloat(ticker.c);
      PRICE_LAST_UPDATED = Date.now();  // Track freshness for TTL check

      MEMORY.priceHistory.push({
        price: CURRENT_PRICE,
        timestamp: Date.now()
      });

      if (MEMORY.priceHistory.length > 180) {
        MEMORY.priceHistory = MEMORY.priceHistory.slice(-180);
      }
    } catch (e) {
      // Ignore
    }
  });

  WS_BINANCE.on('close', () => {
    setTimeout(connectBinanceWebSocket, 5000);
  });
}

// ============================================================
// WINDOW MANAGEMENT
// ============================================================

function getCurrentWindow() {
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 900) * 900;
  const currentWindowEnd = currentWindowStart + 900;

  return {
    start: currentWindowStart,
    end: currentWindowEnd,
    slug: `btc-updown-15m-${currentWindowStart}`,  // FIX: Use START not END
    timeLeft: currentWindowEnd - now,
  };
}

// Global consecutive wins counter for adaptive sizing (Gemini)
let CONSECUTIVE_WINS = 0;

function getWindowState(slug) {
  if (!MEMORY.windowState[slug]) {
    MEMORY.windowState[slug] = {
      chosenSide: null,          // YES or NO (commit to one)
      ordersPlaced: 0,
      totalSpent: 0,
      capitalLocked: 0,          // CRITICAL: Capital locked by ALL orders (placed + filled)
      lastOrderTime: 0,
      orders: [],
      pricesAtEntry: [],
      clipperStraddlePlaced: false,    // NEW: Track if straddle executed
      clipperVibesScore: 0.00,         // NEW: Store vibes assessment
      clipperClipTargets: null,        // NEW: Store current clip targets
      consecutiveWins: CONSECUTIVE_WINS // GEMINI: For adaptive position sizing
    };
  }
  return MEMORY.windowState[slug];
}

// FIX #14: Clean up old window states to prevent memory leak
function cleanupOldWindowStates() {
  const now = Math.floor(Date.now() / 1000);
  const maxAge = 3600;  // Keep last hour only
  let cleaned = 0;

  for (const slug of Object.keys(MEMORY.windowState)) {
    const windowStart = parseInt(slug.split('-').pop());
    if (!isNaN(windowStart) && now - windowStart > maxAge) {
      delete MEMORY.windowState[slug];
      cleaned++;
    }
  }

  if (cleaned > 0) {
    console.log(JSON.stringify({
      action: 'WINDOW_STATE_CLEANUP',
      cleaned: cleaned,
      remaining: Object.keys(MEMORY.windowState).length,
      timestamp: new Date().toISOString()
    }));
  }
}

// ============================================================
// MARKET DATA
// ============================================================

async function getCurrentMarket(window) {
  return new Promise((resolve) => {
    https.get(`https://gamma-api.polymarket.com/markets?slug=${window.slug}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const markets = JSON.parse(data);

          // *** VALIDATION 1: Market exists ***
          if (!markets || markets.length === 0) {
            console.warn(JSON.stringify({
              action: 'MARKET_NOT_FOUND',
              window: window.slug,
              error: 'No market returned from API'
            }));
            resolve(null);
            return;
          }

          const market = markets[0];

          // *** VALIDATION 2: outcomePrices array exists ***
          if (!market.outcomePrices) {
            console.error(JSON.stringify({
              action: 'MARKET_VALIDATION_ERROR',
              window: window.slug,
              error: 'outcomePrices is null/undefined'
            }));
            resolve(null);
            return;
          }

          const prices = JSON.parse(market.outcomePrices);
          const tokenIds = JSON.parse(market.clobTokenIds || '[]');

          // *** VALIDATION 3: Prices are valid 2-element array ***
          if (!Array.isArray(prices) || prices.length < 2) {
            console.error(JSON.stringify({
              action: 'PRICE_VALIDATION_ERROR',
              window: window.slug,
              error: 'outcomePrices is not a valid 2-element array',
              outcomePrices: market.outcomePrices
            }));
            resolve(null);
            return;
          }

          // FIX #13: Validate token-price mapping using outcomes array
          // Don't assume prices[0] = YES - check the actual outcome order
          // BTC markets use "Up"/"Down" instead of "Yes"/"No"
          const outcomes = JSON.parse(market.outcomes || '["Yes","No"]');
          let yesIndex = outcomes.findIndex(o => o.toLowerCase() === 'yes');
          let noIndex = outcomes.findIndex(o => o.toLowerCase() === 'no');

          // Handle BTC Up/Down markets (Up = YES/bullish, Down = NO/bearish)
          if (yesIndex === -1) {
            yesIndex = outcomes.findIndex(o => o.toLowerCase() === 'up');
          }
          if (noIndex === -1) {
            noIndex = outcomes.findIndex(o => o.toLowerCase() === 'down');
          }

          if (yesIndex === -1 || noIndex === -1) {
            console.error(JSON.stringify({
              action: 'OUTCOMES_NOT_FOUND',
              window: window.slug,
              outcomes: outcomes,
              error: 'Could not find YES/Up and NO/Down in outcomes array'
            }));
            resolve(null);
            return;
          }

          const yesPrice = parseFloat(prices[yesIndex]);
          const noPrice = parseFloat(prices[noIndex]);
          const yesTokenId = tokenIds[yesIndex];
          const noTokenId = tokenIds[noIndex];

          if (isNaN(yesPrice) || isNaN(noPrice)) {
            console.error(JSON.stringify({
              action: 'PRICE_VALIDATION_ERROR',
              window: window.slug,
              yesPriceRaw: prices[yesIndex],
              noPriceRaw: prices[noIndex],
              yesIndex: yesIndex,
              noIndex: noIndex,
              error: 'Invalid price format (NaN)'
            }));
            resolve(null);
            return;
          }

          // *** VALIDATION 4: Window chronological lock ***
          const now = Math.floor(Date.now() / 1000);
          const marketEndDate = new Date(market.endDate).getTime() / 1000;

          // Market end should match window.end (±60s tolerance)
          const endDateDiff = Math.abs(marketEndDate - window.end);
          if (endDateDiff > 60) {
            console.warn(JSON.stringify({
              action: 'WINDOW_MISMATCH',
              window: window.slug,
              expectedEnd: window.end,
              marketEnd: marketEndDate,
              diff: endDateDiff,
              error: 'Market end date does not match current window'
            }));
            resolve(null);
            return;
          }

          // *** VALIDATION 5: Not trading past windows ***
          if (now > marketEndDate) {
            console.warn(JSON.stringify({
              action: 'WINDOW_CLOSED',
              window: window.slug,
              marketEnd: marketEndDate,
              currentTime: now,
              error: 'Attempting to trade expired window'
            }));
            resolve(null);
            return;
          }

          // *** VALIDATION 6: Not trading future windows (>30min ahead) ***
          if (marketEndDate > now + 1800) {
            console.warn(JSON.stringify({
              action: 'WINDOW_TOO_FAR_FUTURE',
              window: window.slug,
              marketEnd: marketEndDate,
              currentTime: now,
              diff: marketEndDate - now,
              error: 'Market is more than 30 minutes in future'
            }));
            resolve(null);
            return;
          }

          // FIX #13: Use validated token IDs (yesTokenId/noTokenId already defined above)
          resolve({
            question: market.question,
            yesPrice: yesPrice,
            noPrice: noPrice,
            yesTokenId: yesTokenId,
            noTokenId: noTokenId,
            endDate: market.endDate,
            endDateUnix: marketEndDate,
            closed: market.closed,
            validated: true,
            fetchedAt: Date.now()  // Freshness tracking for staleness checks
          });
        } catch (e) {
          console.error(JSON.stringify({
            action: 'MARKET_PARSE_ERROR',
            window: window.slug,
            error: e.message
          }));
          resolve(null);
        }
      });
    }).on('error', (e) => {
      console.error(JSON.stringify({
        action: 'MARKET_API_ERROR',
        window: window.slug,
        error: e.message
      }));
      resolve(null);
    });
  });
}

// ============================================================
// ASYMMETRIC EDGE ANALYSIS
// ============================================================

function analyzeAsymmetricEdge(market, windowState) {
  const { yesPrice, noPrice } = market;

  // Check which side has asymmetric edge
  let asymmetricSide = null;
  let edgePrice = null;
  let edgeRatio = null;

  if (yesPrice < CONFIG.maxEntryPrice) {
    asymmetricSide = 'YES';
    edgePrice = yesPrice;
    edgeRatio = (1 - yesPrice) / yesPrice; // Upside / Downside
  } else if (noPrice < CONFIG.maxEntryPrice) {
    asymmetricSide = 'NO';
    edgePrice = noPrice;
    edgeRatio = (1 - noPrice) / noPrice;
  }

  // If no asymmetric edge, return null
  if (!asymmetricSide) {
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════
  // PREMIUM GATE: Require minimum delta for MINIMAL_EDGE trades (>50¢)
  // Don't pay a premium for coin flips - delta must justify the price
  // ═══════════════════════════════════════════════════════════════════
  if (edgePrice > 0.50) {
    const windowPriceData = windowPriceTracker.getWindowPriceData(windowState.windowSlug);
    const currentDeltaPct = windowPriceData ? Math.abs(windowPriceData.deltaPct) : 0;

    // Calculate minimum delta required based on premium over fair value
    // 51¢ = need 0.02%, 55¢ = need 0.10%, 60¢ = need 0.20%
    const premiumOverFair = edgePrice - 0.50;
    const minDeltaRequired = premiumOverFair * 0.04; // 1¢ premium = 0.04% delta required (realistic for 15-min windows)

    // Check if delta supports the side we're betting
    const deltaFavorsSide = windowPriceData && (
      (asymmetricSide === 'YES' && windowPriceData.deltaPct > 0) ||
      (asymmetricSide === 'NO' && windowPriceData.deltaPct < 0)
    );

    if (!deltaFavorsSide || currentDeltaPct < minDeltaRequired) {
      console.log(JSON.stringify({
        action: 'PREMIUM_GATE_BLOCKED',
        side: asymmetricSide,
        price: (edgePrice * 100).toFixed(1) + '¢',
        premium: (premiumOverFair * 100).toFixed(1) + '¢',
        deltaPct: windowPriceData ? windowPriceData.deltaPct.toFixed(3) + '%' : 'N/A',
        minDeltaRequired: (minDeltaRequired * 100).toFixed(2) + '%',
        deltaFavorsSide: deltaFavorsSide,
        reason: deltaFavorsSide
          ? `Delta ${currentDeltaPct.toFixed(3)}% too weak for ${(premiumOverFair * 100).toFixed(0)}¢ premium`
          : `Delta moving wrong direction for ${asymmetricSide}`,
        timestamp: new Date().toISOString()
      }));
      return null;
    }
  }

  // If we already chose a side, check if it's still cheap
  if (windowState.chosenSide) {
    if (windowState.chosenSide !== asymmetricSide) {
      // DELTA REVERSAL FLIP: Allow switching sides if delta reversed strongly (>0.15%)
      const windowPriceData = windowPriceTracker.getWindowPriceData(windowState.windowSlug);
      const deltaReversalThreshold = 0.15; // 0.15% is a strong reversal

      if (windowPriceData && Math.abs(windowPriceData.deltaPct) >= deltaReversalThreshold) {
        // Check if delta now favors the opposite side
        const deltaFavorsYes = windowPriceData.deltaPct > 0;
        const deltaFavorsNo = windowPriceData.deltaPct < 0;
        const newSideAligned = (asymmetricSide === 'YES' && deltaFavorsYes) ||
                               (asymmetricSide === 'NO' && deltaFavorsNo);

        if (newSideAligned) {
          console.log(JSON.stringify({
            action: 'DELTA_REVERSAL_FLIP',
            oldSide: windowState.chosenSide,
            newSide: asymmetricSide,
            deltaPct: windowPriceData.deltaPct.toFixed(3) + '%',
            reason: 'Strong delta reversal detected, flipping sides',
            timestamp: new Date().toISOString()
          }));

          // Allow the flip - reset chosen side
          windowState.chosenSide = null;
          windowState.flippedSide = true;
        } else {
          return null; // Delta doesn't support the new side either
        }
      } else {
        return null; // Delta not strong enough to justify flip
      }
    }

    // Stop adding if price rose above threshold
    if (edgePrice > CONFIG.stopAddingPrice) {
      return null; // Edge is gone
    }
  }

  // Determine bet size tier based on price
  let betSize = 0;
  let valueTier = '';

  if (edgePrice <= CONFIG.valueTiers.extremeValue.max) {
    betSize = CONFIG.valueTiers.extremeValue.size;
    valueTier = 'EXTREME_VALUE';
  } else if (edgePrice <= CONFIG.valueTiers.greatValue.max) {
    betSize = CONFIG.valueTiers.greatValue.size;
    valueTier = 'GREAT_VALUE';
  } else if (edgePrice <= CONFIG.valueTiers.goodValue.max) {
    betSize = CONFIG.valueTiers.goodValue.size;
    valueTier = 'GOOD_VALUE';
  } else if (edgePrice <= CONFIG.valueTiers.fairValue.max) {
    betSize = CONFIG.valueTiers.fairValue.size;
    valueTier = 'FAIR_VALUE';
  } else if (edgePrice <= CONFIG.valueTiers.minimalEdge.max) {
    betSize = CONFIG.valueTiers.minimalEdge.size;
    valueTier = 'MINIMAL_EDGE';
  }

  return {
    side: asymmetricSide,
    price: edgePrice,
    edgeRatio: edgeRatio,
    tokenId: asymmetricSide === 'YES' ? market.yesTokenId : market.noTokenId,
    betSize: betSize,
    valueTier: valueTier,
  };
}

// ============================================================
// ORDER PLACEMENT
// ============================================================

function calculateOrderShares(price, targetAmount) {
  // Calculate shares needed for target amount
  const idealShares = targetAmount / price;

  // Round up to minimum 5 shares
  const shares = Math.max(CONFIG.minShares, Math.ceil(idealShares));

  // Calculate actual cost
  const cost = shares * price;

  return { shares, cost };
}

/**
 * Place MARKET ORDER (instant fill at best available price)
 * Uses Execution Desk for reliable order placement and parsing
 */
function placeMarketOrder(market, edge, betSize) {
  const { shares, cost } = calculateOrderShares(edge.price, betSize);

  // Market order: Use current ask price + 8¢ buffer for instant fill
  // (Gamma API shows midpoint, actual ask can be 5-8¢ higher due to spread)
  const marketMaxPrice = Math.min(0.95, edge.price + 0.08);

  console.log(JSON.stringify({
    action: 'PLACING_MARKET_ORDER',
    side: edge.side,
    tokenId: maskId(edge.tokenId),
    estimatedPrice: edge.price.toFixed(4),
    shares: shares,
    cost: cost.toFixed(2),
    maxPrice: marketMaxPrice.toFixed(4),
    valueTier: edge.valueTier,
    orderType: 'MARKET (via Execution Desk)',
    timestamp: new Date().toISOString(),
  }));

  // Use Execution Desk for order placement
  const result = executionDesk.placeBuyOrder(edge.tokenId, cost, marketMaxPrice);

  if (result.success) {
    return {
      success: true,
      avgFillPrice: result.avgFillPrice || edge.price,
      totalShares: result.sharesReceived || shares,
      actualCost: result.costUSDC || cost,  // ACTUAL cost (may be boosted for min shares)
      orderID: result.orderID
    };
  } else {
    console.log(JSON.stringify({
      action: 'MARKET_ORDER_FAILED',
      error: result.error,
      attempts: result.attempts,
      timestamp: new Date().toISOString(),
    }));
    return { success: false, avgFillPrice: 0, totalShares: 0, actualCost: 0, orderID: null };
  }
}

/**
 * Place LIMIT ORDER (patient fill at specific price)
 * Uses Execution Desk with narrow slippage tolerance
 */
function placeLimitOrder(market, edge, betSize) {
  const { shares, cost } = calculateOrderShares(edge.price, betSize);

  // Limit order: Allow 5¢ slippage to account for bid-ask spread
  // (Gamma API shows midpoint, actual ask is typically 3-7¢ higher)
  const maxPrice = Math.min(0.99, edge.price + 0.05);

  console.log(JSON.stringify({
    action: 'PLACING_LIMIT_ORDER',
    side: edge.side,
    tokenId: maskId(edge.tokenId),
    price: edge.price.toFixed(4),
    shares: shares,
    cost: cost.toFixed(2),
    valueTier: edge.valueTier,
    edgeRatio: edge.edgeRatio.toFixed(2) + ':1',
    maxPrice: maxPrice.toFixed(4),
    orderType: 'LIMIT (via Execution Desk)',
    timestamp: new Date().toISOString(),
  }));

  // Use Execution Desk for order placement
  const result = executionDesk.placeBuyOrder(edge.tokenId, cost, maxPrice);

  if (result.success) {
    return {
      success: true,
      avgFillPrice: result.avgFillPrice || edge.price,
      totalShares: result.sharesReceived || shares,
      actualCost: result.costUSDC || cost,  // ACTUAL cost (may be boosted for min shares)
      orderID: result.orderID
    };
  } else {
    console.log(JSON.stringify({
      action: 'LIMIT_ORDER_FAILED',
      error: result.error,
      attempts: result.attempts,
      timestamp: new Date().toISOString(),
    }));
    return { success: false, avgFillPrice: 0, totalShares: 0, actualCost: 0, orderID: null };
  }
}

/**
 * HYBRID ORDER PLACEMENT: Market + Limit orders
 * 1. Market order for 35% of position (instant fill)
 * 2. Limit orders for 65% of position (better prices)
 *
 * NOTE: For small bets (<$5), use single market order to meet min share requirements
 */
function placeBet(market, edge) {
  const totalBetSize = edge.betSize;
  const MIN_HYBRID_SIZE = 5.00;  // Minimum bet size for hybrid split

  const fills = [];

  // For small bets, use single market order (hybrid split would create undersized orders)
  if (totalBetSize < MIN_HYBRID_SIZE) {
    console.log(JSON.stringify({
      action: 'SINGLE_ORDER_STRATEGY',
      totalSize: totalBetSize.toFixed(2),
      reason: `Bet under $${MIN_HYBRID_SIZE} - using single market order to meet 5 share minimum`,
      timestamp: new Date().toISOString()
    }));

    const marketFill = placeMarketOrder(market, edge, totalBetSize);
    if (marketFill.success) {
      fills.push(marketFill);
    }
  } else {
    // Split: 35% market (instant), 65% limit (patient)
    const marketPortion = totalBetSize * 0.35;
    const limitPortion = totalBetSize * 0.65;

    console.log(JSON.stringify({
      action: 'HYBRID_ORDER_STRATEGY',
      totalSize: totalBetSize.toFixed(2),
      marketOrder: marketPortion.toFixed(2) + ' (35% - instant fill)',
      limitOrders: limitPortion.toFixed(2) + ' (65% - better prices)',
      timestamp: new Date().toISOString()
    }));

    // 1. Place MARKET order first (instant fill)
    if (marketPortion >= 0.50) {
      const marketFill = placeMarketOrder(market, edge, marketPortion);
      if (marketFill.success) {
        fills.push(marketFill);
      }
    }

    // 2. Place LIMIT order for remaining (better prices)
    if (limitPortion >= 0.50) {
      const limitFill = placeLimitOrder(market, edge, limitPortion);
      if (limitFill.success) {
        fills.push(limitFill);
      }
    }
  }

  // Aggregate results
  if (fills.length === 0) {
    console.log(JSON.stringify({
      action: 'PLACE_BET_FAILED',
      reason: 'No successful orders',
      timestamp: new Date().toISOString()
    }));
    return { success: false, avgFillPrice: 0, totalShares: 0, actualCost: 0, fills: [] };
  }

  // Calculate weighted average fill price and ACTUAL total cost
  const totalValue = fills.reduce((sum, f) =>
    sum + (f.avgFillPrice * f.totalShares), 0
  );
  const totalShares = fills.reduce((sum, f) =>
    sum + f.totalShares, 0
  );
  // CRITICAL: Sum actual costs (may include min share boosts)
  const actualTotalCost = fills.reduce((sum, f) =>
    sum + (f.actualCost || 0), 0
  );

  const aggregatedResult = {
    success: true,
    avgFillPrice: totalValue / totalShares,
    totalShares: totalShares,
    actualCost: actualTotalCost,  // REAL cost (tracks USDC drag)
    fills: fills
  };

  console.log(JSON.stringify({
    action: 'PLACE_BET_SUCCESS',
    avgFillPrice: aggregatedResult.avgFillPrice.toFixed(4),
    totalShares: aggregatedResult.totalShares.toFixed(2),
    actualCost: actualTotalCost.toFixed(2),
    intendedCost: totalBetSize.toFixed(2),
    costDelta: (actualTotalCost - totalBetSize).toFixed(2),
    numFills: fills.length,
    timestamp: new Date().toISOString()
  }));

  return aggregatedResult;
}

// ============================================================
// MAIN TRADING LOOP
// ============================================================

async function tradingLoop() {
  console.log(JSON.stringify({
    action: 'ASYMMETRIC_BOT_START',
    strategy: 'Multi-stage AI consultations (Trader + Risk Manager) with dynamic position sizing',
    positionSizing: '8-15% of balance based on confidence',
    consultationTiming: '800-850s (Stage 1 Trader), 820s (Stage 2 Risk Manager)',
    minShares: CONFIG.minShares,
    maxOrders: CONFIG.maxOrdersPerWindow,
    timestamp: new Date().toISOString(),
  }));

  // Initialize session tracking for AI consultations
  const session = sessionTracker.loadOrStartSession();
  console.log(JSON.stringify({
    action: 'SESSION_TRACKING_INITIALIZED',
    sessionId: session.sessionId,
    windowsCompleted: session.stats?.totalWindows || 0,
    consultationsCompleted: session.consultations?.length || 0,
    timestamp: new Date().toISOString()
  }));

  let loopCounter = 0;

  while (true) {
    try {
      loopCounter++;

      // Periodic cleanup every ~5 minutes (60 iterations at 5s each)
      // This catches any positions that escaped normal settlement
      if (loopCounter % 60 === 0) {
        const cleanupResult = virtualAccounts.cleanupExpiredPositions();
        if (cleanupResult.removed > 0) {
          console.log(JSON.stringify({
            action: 'PERIODIC_CLEANUP',
            removed: cleanupResult.removed,
            remaining: cleanupResult.remaining,
            loopIteration: loopCounter,
            timestamp: new Date().toISOString()
          }));
        }
      }

      const window = getCurrentWindow();

      // DETECT NEW WINDOW
      if (!MEMORY.currentWindow || MEMORY.currentWindow.slug !== window.slug) {
        // CAPTURE WINDOW CLOSING PRICE (for previous window)
        if (MEMORY.currentWindow && CURRENT_PRICE) {
          windowPriceTracker.captureWindowClosingPrice(MEMORY.currentWindow.slug, CURRENT_PRICE);

          // Record window outcome for historical analysis
          const closingData = windowPriceTracker.getWindowPriceData(MEMORY.currentWindow.slug);
          if (closingData && closingData.closePrice) {
            const winner = closingData.closePrice >= closingData.openPrice ? 'YES' : 'NO';
            windowHistoryTracker.recordWindowOutcome(
              MEMORY.currentWindow.slug,
              closingData.closePrice,
              closingData.finalDelta || (closingData.closePrice - closingData.openPrice),
              winner
            );

            // ============================================================
            // BLACK BOX RECORDER: Finalize episode with outcome
            // ============================================================
            blackBoxRecorder.finalizeEpisode({
              winner: winner,
              finalBtcPrice: closingData.closePrice,
              finalDelta: closingData.deltaPct || 0,
              finalYesPrice: winner === 'YES' ? 1.0 : 0.0,
              finalNoPrice: winner === 'NO' ? 1.0 : 0.0
            });

            // ============================================================
            // SHADOW MODE: Settle simulated positions
            // ============================================================
            if (executionDesk.isShadowMode()) {
              const shadowSettlement = executionDesk.settleShadowWindow(
                MEMORY.currentWindow.slug,
                closingData.closePrice
              );
              if (shadowSettlement && shadowSettlement.settled > 0) {
                console.log(JSON.stringify({
                  action: 'SHADOW_SETTLEMENT_COMPLETE',
                  window: MEMORY.currentWindow.slug,
                  positionsSettled: shadowSettlement.settled,
                  wins: shadowSettlement.wins,
                  losses: shadowSettlement.losses,
                  pnl: (shadowSettlement.pnl >= 0 ? '+' : '') + shadowSettlement.pnl.toFixed(2),
                  newBalance: shadowSettlement.newBalance.toFixed(2),
                  timestamp: new Date().toISOString()
                }));
              }
            }

            // SETTLE DESK P&L (7-player system: Farm + Degen + Clipper)
            // NOTE: Gate removed - always settle regardless of orchestration status
            // This prevents positions from accumulating when orchestration fails
            const windowState = MEMORY.windowState[MEMORY.currentWindow.slug];
            if (windowState) {
              // FIX #5: Settlement loop with iteration limit to prevent hangs
              const MAX_SETTLEMENT_ITERATIONS = 50;

              // Settle ALL Farm desk positions (loop handles stacked positions)
              let farmResult;
              let farmSettleCount = 0;
              let farmIterations = 0;
              do {
                farmResult = virtualAccounts.settlePosition('FARM', MEMORY.currentWindow.slug, winner);
                if (farmResult) {
                  farmSettleCount++;
                  console.log(JSON.stringify({
                    action: 'FARM_DESK_SETTLED',
                    window: MEMORY.currentWindow.slug,
                    positionNum: farmSettleCount,
                    won: farmResult.won,
                    profit: farmResult.profit.toFixed(2),
                    roi: (farmResult.roi * 100).toFixed(1) + '%',
                    newBalance: farmResult.newBalance.toFixed(2),
                    timestamp: new Date().toISOString()
                  }));

                  // Update leaderboard
                  const farmStats = virtualAccounts.getDeskStats('FARM');
                  leaderboard.updateDeskStats('FARM', farmStats);

                  // Check for milestones
                  if (farmResult.won && farmStats.currentStreak >= 10) {
                    leaderboard.checkMilestones('FARM', 'WIN_STREAK', {
                      streak: farmStats.currentStreak,
                      totalProfit: farmStats.totalProfit
                    });
                  }

                  // Record outcome in dialogue
                  dialogueRecorder.recordOutcome(MEMORY.currentWindow.slug, winner, farmResult, null);
                }
                farmIterations++;
                if (farmIterations >= MAX_SETTLEMENT_ITERATIONS) {
                  console.error(JSON.stringify({
                    action: 'SETTLEMENT_LOOP_LIMIT',
                    desk: 'FARM',
                    iterations: farmIterations,
                    timestamp: new Date().toISOString()
                  }));
                  break;
                }
              } while (farmResult !== null);

              // Settle ALL Degen desk positions (loop handles stacked positions)
              let degenResult;
              let degenSettleCount = 0;
              let degenIterations = 0;
              do {
                degenResult = virtualAccounts.settlePosition('DEGEN', MEMORY.currentWindow.slug, winner);
                if (degenResult) {
                  degenSettleCount++;
                  console.log(JSON.stringify({
                    action: 'DEGEN_DESK_SETTLED',
                    window: MEMORY.currentWindow.slug,
                    positionNum: degenSettleCount,
                    won: degenResult.won,
                    profit: degenResult.profit.toFixed(2),
                    roi: (degenResult.roi * 100).toFixed(1) + '%',
                    newBalance: degenResult.newBalance.toFixed(2),
                    timestamp: new Date().toISOString()
                  }));

                  // Update leaderboard
                  const degenStats = virtualAccounts.getDeskStats('DEGEN');
                  leaderboard.updateDeskStats('DEGEN', degenStats);

                  // Check for lotto ticket wins
                  if (degenResult.won && degenStats.lottoTicketWins > 0) {
                    leaderboard.checkMilestones('DEGEN', 'LOTTO_HIT', {
                      payoffRatio: degenResult.roi,
                      profit: degenResult.profit
                    });
                  }

                  // Update dialogue
                  dialogueRecorder.recordOutcome(MEMORY.currentWindow.slug, winner, null, degenResult);
                }
                degenIterations++;
                if (degenIterations >= MAX_SETTLEMENT_ITERATIONS) {
                  console.error(JSON.stringify({
                    action: 'SETTLEMENT_LOOP_LIMIT',
                    desk: 'DEGEN',
                    iterations: degenIterations,
                    timestamp: new Date().toISOString()
                  }));
                  break;
                }
              } while (degenResult !== null);

              // Settle ALL Clipper desk positions (loop handles stacked positions)
              let clipperResult;
              let clipperSettleCount = 0;
              let clipperIterations = 0;
              do {
                clipperResult = virtualAccounts.settlePosition('CLIPPER', MEMORY.currentWindow.slug, winner);
                if (clipperResult) {
                  clipperSettleCount++;
                  console.log(JSON.stringify({
                    action: 'CLIPPER_DESK_SETTLED',
                    window: MEMORY.currentWindow.slug,
                    positionNum: clipperSettleCount,
                    won: clipperResult.won,
                    profit: clipperResult.profit.toFixed(2),
                    roi: (clipperResult.roi * 100).toFixed(1) + '%',
                    newBalance: clipperResult.newBalance.toFixed(2),
                    timestamp: new Date().toISOString()
                  }));

                  // Update leaderboard
                  const clipperStats = virtualAccounts.getDeskStats('CLIPPER');
                  leaderboard.updateDeskStats('CLIPPER', clipperStats);

                  // Check for clip milestones
                  if (clipperResult.won && clipperStats.clipsExecuted >= 20) {
                    leaderboard.checkMilestones('CLIPPER', 'CLIP_MASTER', {
                      clipsExecuted: clipperStats.clipsExecuted,
                      avgClipProfit: clipperStats.avgClipProfit
                    });
                  }
                }
                clipperIterations++;
                if (clipperIterations >= MAX_SETTLEMENT_ITERATIONS) {
                  console.error(JSON.stringify({
                    action: 'SETTLEMENT_LOOP_LIMIT',
                    desk: 'CLIPPER',
                    iterations: clipperIterations,
                    timestamp: new Date().toISOString()
                  }));
                  break;
                }
              } while (clipperResult !== null);

              // Log total positions settled
              if (farmSettleCount + degenSettleCount + clipperSettleCount > 0) {
                console.log(JSON.stringify({
                  action: 'WINDOW_POSITIONS_SETTLED',
                  window: MEMORY.currentWindow.slug,
                  farm: farmSettleCount,
                  degen: degenSettleCount,
                  clipper: clipperSettleCount,
                  total: farmSettleCount + degenSettleCount + clipperSettleCount,
                  timestamp: new Date().toISOString()
                }));

                // GEMINI: Track consecutive wins for adaptive position sizing
                // Check if we had any winning positions
                const farmStats = virtualAccounts.getDeskStats('FARM');
                const degenStats = virtualAccounts.getDeskStats('DEGEN');

                // Use window outcome to update consecutive wins
                // Window is a win if most positions won
                const windowWin = (farmStats.wins > farmStats.losses) || (degenStats.wins > degenStats.losses);

                if (windowWin) {
                  CONSECUTIVE_WINS++;
                  console.log(JSON.stringify({
                    action: 'CONSECUTIVE_WINS_UPDATE',
                    consecutiveWins: CONSECUTIVE_WINS,
                    status: 'WIN',
                    nextPositionScale: CONSECUTIVE_WINS >= CONFIG.positionSizing.scaleUpThreshold ? '3.5%' : '2.5%',
                    timestamp: new Date().toISOString()
                  }));
                } else {
                  const previousStreak = CONSECUTIVE_WINS;
                  CONSECUTIVE_WINS = 0;
                  console.log(JSON.stringify({
                    action: 'CONSECUTIVE_WINS_RESET',
                    previousStreak: previousStreak,
                    status: 'LOSS',
                    timestamp: new Date().toISOString()
                  }));
                }

                // GEMINI: Update trade log with outcomes
                try {
                  if (CONFIG.tradeLogging.enabled && fs.existsSync(CONFIG.tradeLogging.logFile)) {
                    const trades = JSON.parse(fs.readFileSync(CONFIG.tradeLogging.logFile, 'utf8'));
                    let updated = false;
                    for (let i = trades.length - 1; i >= 0 && i >= trades.length - 10; i--) {
                      if (trades[i].windowSlug === MEMORY.currentWindow.slug && trades[i].outcome === null) {
                        trades[i].outcome = windowWin ? 'WIN' : 'LOSS';
                        trades[i].closingPrice = CURRENT_PRICE;
                        updated = true;
                      }
                    }
                    if (updated) {
                      fs.writeFileSync(CONFIG.tradeLogging.logFile, JSON.stringify(trades, null, 2));
                    }
                  }
                } catch (e) {
                  console.error('[TRADE_LOG] Failed to update outcomes:', e.message);
                }
              }

              // Check if rebalancing is needed
              virtualAccounts.checkRebalancing();

              // ============================================================
              // SYNC WEALTH FORTRESS AFTER SETTLEMENTS
              // This is critical - it locks profits at new high water marks!
              // ============================================================
              const updatedBalance = virtualAccounts.getAccounts()?.fund?.totalBalance;
              if (updatedBalance) {
                wealthFortress.sync(updatedBalance);
                const report = wealthFortress.getReport();
                console.log(JSON.stringify({
                  action: 'WEALTH_FORTRESS_POST_SETTLEMENT',
                  totalEquity: '$' + report.totalEquity,
                  vault: '$' + report.vault,
                  warChest: '$' + report.warChest,
                  phase: report.phase,
                  hwm: '$' + report.highWaterMark,
                  timestamp: new Date().toISOString()
                }));
              }

              // ============================================================
              // SESSION TRACKER: Record completed window for AI consultation
              // ============================================================
              try {
                const windowPriceData = windowPriceTracker.getWindowPriceData(MEMORY.currentWindow.slug);
                const farmStats = virtualAccounts.getDeskStats('FARM');
                const degenStats = virtualAccounts.getDeskStats('DEGEN');
                const clipperStats = virtualAccounts.getDeskStats('CLIPPER');

                // Calculate window P&L from all desks
                const windowPnL = (farmStats.todayPnL || 0) + (degenStats.todayPnL || 0) + (clipperStats.todayPnL || 0);

                // Collect trade info from window state
                const windowStateData = getWindowState(MEMORY.currentWindow.slug);
                const trades = [];
                if (windowStateData.farmPositionPlaced) trades.push({ desk: 'FARM', type: 'position' });
                if (windowStateData.degenPositionPlaced) trades.push({ desk: 'DEGEN', type: 'position' });
                if (windowStateData.clipperStraddlePlaced) trades.push({ desk: 'CLIPPER', type: 'straddle' });

                // Record window to session tracker
                const shouldConsult = sessionTracker.recordWindow({
                  slug: MEMORY.currentWindow.slug,
                  winner: winner,
                  trades: trades,
                  pnl: windowPnL,
                  btcOpen: windowPriceData?.openPrice || 0,
                  btcClose: CURRENT_PRICE || 0,
                  signals: {
                    farmPositioned: windowStateData.farmPositionPlaced,
                    degenTriggered: windowStateData.degenPositionPlaced,
                    clipperActive: windowStateData.clipperStraddlePlaced
                  }
                });

                // Trigger AI consultation after every 2 windows
                if (shouldConsult) {
                  console.log(JSON.stringify({
                    action: 'AI_CONSULTATION_TRIGGERING',
                    reason: 'Window pair completed',
                    timestamp: new Date().toISOString()
                  }));

                  // Run consultation in background (don't block main loop)
                  sessionTracker.runConsultationForLastPair()
                    .then(result => {
                      if (result?.success) {
                        console.log(JSON.stringify({
                          action: 'AI_CONSULTATION_COMPLETE',
                          priorityActions: result.dialogue?.priorityActions?.length || 0,
                          timestamp: new Date().toISOString()
                        }));
                      }
                    })
                    .catch(err => {
                      console.error('[AI_CONSULTATION] Error:', err.message);
                    });
                }
              } catch (sessionErr) {
                console.error('[SESSION_TRACKER] Recording error:', sessionErr.message);
              }

              // FIX #14: Clean up old window states to prevent memory leak
              cleanupOldWindowStates();
            }

            // AUTO-REDEEM winning positions to free up capital
            await redeemWinningPositions(MEMORY.currentWindow.slug, winner);
          }
        }

        // NEW WINDOW - CAPTURE OPENING PRICE
        MEMORY.currentWindow = window;
        if (CURRENT_PRICE) {
          windowPriceTracker.captureWindowOpeningPrice(window.slug, CURRENT_PRICE);
        }

        console.log(JSON.stringify({
          action: 'NEW_WINDOW',
          window: window.slug,
          timeLeft: window.timeLeft + 's',
          timestamp: new Date().toISOString(),
        }));

        // Set window context for shadow mode (enables proper settlement tracking)
        if (executionDesk.isShadowMode()) {
          executionDesk.setWindowContext(window.slug, CURRENT_PRICE || 0, 'CLIPPER');
        }

        // Refresh balance for new window (force refresh from blockchain)
        await fetchBalance();

        // ============================================================
        // BLACK BOX RECORDER: Start new episode
        // ============================================================
        const fortressReport = wealthFortress.getReport();
        blackBoxRecorder.startNewEpisode({
          slug: window.slug,
          btcOpenPrice: CURRENT_PRICE,
          yesPrice: 0.50, // Will be updated when market data arrives
          noPrice: 0.50,
          timeLeft: window.timeLeft,
          fortressPhase: fortressReport.phase,
          totalEquity: parseFloat(fortressReport.totalEquity),
          vault: parseFloat(fortressReport.vault),
          warChest: parseFloat(fortressReport.warChest),
          principalSecured: fortressReport.principalStatus.includes('SECURED')
        });
      }

      // UPDATE CURRENT PRICE & DELTA
      if (CURRENT_PRICE) {
        windowPriceTracker.updateWindowPrice(window.slug, CURRENT_PRICE);
      }

      // PRICE STALENESS CHECK: Skip trading if Binance data is stale
      const freshPrice = getBinancePriceIfFresh();
      if (freshPrice === null) {
        // Price is stale - skip this iteration to avoid gambling on old data
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
      }

      const windowState = getWindowState(window.slug);

      // ============================================================
      // CLIPPER DESK: FAIR VALUE EDGE BETTING (300-120s = 5-2 min before close)
      // Tighter window for more predictable outcomes + latency arbitrage
      // Uses Binance oracle for "true" price vs Polymarket's lagged pricing
      // ============================================================
      const inClipperWindow = window.timeLeft <= 300 && window.timeLeft > 120;
      if (inClipperWindow && !windowState.clipperStraddlePlaced) {
        try {
          const market = await getCurrentMarket(window);
          if (market && !market.closed) {
            // Get window price data for delta-based directional betting
            const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);

            // LATENCY ARBITRAGE CHECK: Use Binance oracle for "true" delta
            let latencyEdge = null;
            if (windowPriceData && windowPriceData.openPrice) {
              try {
                latencyEdge = await binanceOracle.detectLatencyEdge(
                  windowPriceData.openPrice,
                  market.yesPrice,
                  market.noPrice
                );
              } catch (oracleErr) {
                console.warn('Binance oracle failed, using Polymarket data:', oracleErr.message);
              }
            }

            console.log(JSON.stringify({
              action: 'CLIPPER_EDGE_WINDOW',
              window: window.slug,
              timeLeft: window.timeLeft,
              polyDelta: windowPriceData ? windowPriceData.delta.toFixed(2) : 'N/A',
              polyDeltaPct: windowPriceData ? windowPriceData.deltaPct.toFixed(3) + '%' : 'N/A',
              binanceDelta: latencyEdge ? latencyEdge.trueDelta.toFixed(2) : 'N/A',
              binanceDeltaPct: latencyEdge ? latencyEdge.trueDeltaPct.toFixed(3) + '%' : 'N/A',
              latencyOpportunity: latencyEdge && latencyEdge.opportunity ? latencyEdge.opportunity.action : 'NONE',
              strategy: 'FAIR_VALUE_EDGE + LATENCY_ARBITRAGE',
              timestamp: new Date().toISOString()
            }));

            // Execute edge-based bet with fair value calculation
            // Pass timeLeft so clipper can calculate proper fair value
            await clipperDeskManager.executeClipperStraddle(
              window.slug,
              market,
              placeMarketOrder,
              windowPriceData,
              window.timeLeft  // Critical: time remaining affects fair value!
            );

            windowState.clipperStraddlePlaced = true;
          }
        } catch (error) {
          console.error(JSON.stringify({
            action: 'CLIPPER_ERROR',
            window: window.slug,
            error: error.message,
            timestamp: new Date().toISOString()
          }));
        }
      }

      // ============================================================
      // OPENER STRATEGY: Pre-bid on NEXT window (60-10s before close)
      // Based on current window's momentum (trend continuation)
      // ============================================================
      const inOpenerWindow = window.timeLeft <= 60 && window.timeLeft > 10;
      if (inOpenerWindow && !windowState.openerBetPlaced) {
        try {
          const currentMarket = await getCurrentMarket(window);
          const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);

          if (currentMarket && windowPriceData) {
            // Evaluate if we should place an opener bet
            const openerDecision = clipperDeskManager.evaluateOpenerOpportunity(
              window.timeLeft,
              windowPriceData,
              currentMarket
            );

            if (openerDecision) {
              // Get the NEXT window's market
              const nextWindowInfo = clipperDeskManager.getNextWindowInfo(window.start);

              console.log(JSON.stringify({
                action: 'OPENER_OPPORTUNITY_DETECTED',
                currentWindow: window.slug,
                nextWindow: nextWindowInfo.slug,
                timeLeft: window.timeLeft + 's',
                currentDelta: windowPriceData.delta.toFixed(2),
                currentYesPrice: (currentMarket.yesPrice * 100).toFixed(0) + '¢',
                openerSide: openerDecision.side,
                openerPrice: openerDecision.price.toFixed(2),
                confidence: openerDecision.confidence,
                rationale: openerDecision.rationale,
                timestamp: new Date().toISOString()
              }));

              // Fetch next window's market
              const nextWindow = { slug: nextWindowInfo.slug, start: nextWindowInfo.start, end: nextWindowInfo.end };
              const nextMarket = await getCurrentMarket(nextWindow);

              if (nextMarket && !nextMarket.closed) {
                // Execute opener bet on next window
                const success = await clipperDeskManager.executeOpenerBet(
                  nextWindowInfo.slug,
                  nextMarket,
                  openerDecision,
                  placeMarketOrder
                );

                if (success) {
                  windowState.openerBetPlaced = true;
                  windowState.openerSide = openerDecision.side;
                  windowState.openerNextWindow = nextWindowInfo.slug;
                }
              } else {
                console.log(JSON.stringify({
                  action: 'OPENER_NEXT_MARKET_NOT_READY',
                  nextWindow: nextWindowInfo.slug,
                  reason: nextMarket ? 'Market closed' : 'Market not found yet',
                  timestamp: new Date().toISOString()
                }));
              }
            }
          }
        } catch (error) {
          console.error(JSON.stringify({
            action: 'OPENER_ERROR',
            window: window.slug,
            error: error.message,
            timestamp: new Date().toISOString()
          }));
        }
      }

      // Get current market (needed for lotto + other strategies)
      const market = await getCurrentMarket(window);
      if (!market || market.closed) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
      }

      // ============================================================
      // EMERGENCY BRAKE - Check if Binance is crashing/pumping
      // ============================================================
      const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);
      let oracleVolatility = 0;
      let binanceData = null;

      // Track delta history for weighted average (Gemini strategy)
      if (windowPriceData && windowPriceData.delta !== undefined) {
        trackDeltaHistory(windowPriceData.delta);
      }

      if (windowPriceData && windowPriceData.openPrice) {
        try {
          const quickCheck = await binanceOracle.quickDeltaCheck(windowPriceData.openPrice);
          if (quickCheck.success) {
            binanceData = { deltaPct: quickCheck.deltaPct, price: quickCheck.binancePrice };

            // Calculate volatility from price history
            if (MEMORY.priceHistory.length >= 10) {
              const recentPrices = MEMORY.priceHistory.slice(-10).map(p => p.price);
              const high = Math.max(...recentPrices);
              const low = Math.min(...recentPrices);
              oracleVolatility = ((high - low) / low) * 100;
            }

            // EMERGENCY BRAKE: If BTC moves >0.4% in seconds, halt trading
            const isCrashing = binanceData.deltaPct < -0.40;
            const isPumping = binanceData.deltaPct > 0.40;

            if (isCrashing || isPumping) {
              console.log(JSON.stringify({
                action: 'EMERGENCY_BRAKE_TRIGGERED',
                reason: isCrashing ? 'CRASH_DETECTED' : 'PUMP_DETECTED',
                deltaPct: binanceData.deltaPct.toFixed(2) + '%',
                response: 'CANCELLING_ALL_BIDS',
                timestamp: new Date().toISOString()
              }));

              // Cancel all open orders
              executionDesk.emergencyCancelAllBuys();

              // If we have positions, consider panic sell (DISABLED by default per Gemini)
              if (isCrashing && CONFIG.emergencyPanicSell.enabled) {
                const clipperPositions = virtualAccounts.getOpenPositions('CLIPPER');
                const yesPositions = clipperPositions.filter(p => p.side === 'YES');
                if (yesPositions.length > 0) {
                  console.log(JSON.stringify({
                    action: 'EMERGENCY_PANIC_SELL',
                    reason: 'Holding YES during crash',
                    positions: yesPositions.length,
                    timestamp: new Date().toISOString()
                  }));
                  // Panic sell YES positions
                  executionDesk.emergencyPanicSell();
                }
              } else if (isCrashing) {
                console.log(JSON.stringify({
                  action: 'PANIC_SELL_DISABLED',
                  reason: 'Per Gemini recommendation - positions can recover',
                  yesPositions: virtualAccounts.getOpenPositions('CLIPPER').filter(p => p.side === 'YES').length,
                  timestamp: new Date().toISOString()
                }));
              }

              await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
              continue;
            }
          }
        } catch (e) { /* ignore oracle errors */ }
      }

      // ============================================================
      // BLACK BOX RECORDER: Record tick data (after volatility calculated)
      // ============================================================
      blackBoxRecorder.recordTick({
        btcPrice: CURRENT_PRICE,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        delta: windowPriceData?.delta || 0,
        deltaPct: windowPriceData?.deltaPct || 0,
        volatility: oracleVolatility || 0,
        oracleDelta: binanceData?.deltaPct || null,
        timeLeft: window.timeLeft
      });

      // ============================================================
      // LOTTO TICKET SCANNER - Buy cheap tickets on high volatility
      // Runs in last 3 minutes (180-30 seconds)
      // ============================================================
      const inLottoWindow = window.timeLeft <= 180 && window.timeLeft > 30;
      if (inLottoWindow) {
        try {
          const lottoOpportunity = clipperDeskManager.scanForLottoTickets(
            market,
            oracleVolatility,
            window.slug,
            window.timeLeft
          );

          if (lottoOpportunity && lottoOpportunity.available) {
            if (lottoOpportunity.skipped) {
              // Log why we skipped
              console.log(JSON.stringify({
                action: 'LOTTO_TICKET_SKIPPED',
                window: window.slug,
                side: lottoOpportunity.side,
                price: (lottoOpportunity.price * 100).toFixed(1) + '¢',
                reason: lottoOpportunity.reason,
                volatility: oracleVolatility.toFixed(3) + '%',
                timestamp: new Date().toISOString()
              }));
            } else {
              // Execute lotto buy
              console.log(JSON.stringify({
                action: 'LOTTO_TICKET_OPPORTUNITY',
                window: window.slug,
                side: lottoOpportunity.side,
                entryPrice: (lottoOpportunity.entryPrice * 100).toFixed(1) + '¢',
                payoffRatio: lottoOpportunity.payoffRatio,
                volatility: oracleVolatility.toFixed(3) + '%',
                timeLeft: window.timeLeft + 's',
                timestamp: new Date().toISOString()
              }));

              await clipperDeskManager.executeLottoBuy(
                window.slug,
                market,
                lottoOpportunity,
                placeMarketOrder
              );
            }
          }
        } catch (error) {
          console.warn('Lotto scanner error:', error.message);
        }
      }

      // Don't trade OTHER strategies in last 2 minutes (lotto + opener can run)
      if (window.timeLeft < 120) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
      }

      // ============================================================
      // DIP SCALPER (REBOUND STRATEGY) - Buy panic dips, auto-flip at 60%
      // ============================================================
      try {
        // binanceData already fetched above in emergency brake section

        // CHECK 1: Monitor existing dip positions for auto-flip
        const autoFlip = clipperDeskManager.checkDipAutoFlip(
          market,
          window.slug,
          window.timeLeft,
          binanceData
        );

        if (autoFlip) {
          console.log(JSON.stringify({
            action: 'DIP_SCALPER_AUTO_FLIP',
            window: window.slug,
            flipAction: autoFlip.action,
            side: autoFlip.position.side,
            entryPrice: autoFlip.position.entryPrice.toFixed(3),
            currentPrice: autoFlip.price.toFixed(3),
            profit: '$' + (autoFlip.profit * autoFlip.position.shares).toFixed(2),
            profitPct: autoFlip.profitPct.toFixed(0) + '%',
            reason: autoFlip.reason,
            timestamp: new Date().toISOString()
          }));

          // Execute the sell
          await clipperDeskManager.executeClip(
            'CLIPPER',
            { ...autoFlip.position, windowSlug: window.slug },
            autoFlip.action === 'PARTIAL_TAKE_30PCT' ? 0.50 : 1.0, // Partial or full
            autoFlip.action,
            market,
            placeMarketOrder
          );

          // Mark position as closed (or partial)
          if (autoFlip.action !== 'PARTIAL_TAKE_30PCT') {
            clipperDeskManager.closeDipPosition(window.slug);
          }
        }

        // CHECK 2: Look for new dip opportunities
        const dipOpportunity = clipperDeskManager.evaluateDipOpportunity(
          market,
          binanceData,
          window.slug,
          window.timeLeft
        );

        if (dipOpportunity && dipOpportunity.action !== 'SKIP') {
          console.log(JSON.stringify({
            action: 'DIP_OPPORTUNITY_DETECTED',
            window: window.slug,
            side: dipOpportunity.side,
            dipPrice: (market[dipOpportunity.side.toLowerCase() + 'Price'] * 100).toFixed(0) + '¢',
            targetBuy: (dipOpportunity.price * 100).toFixed(0) + '¢',
            targetSell: (dipOpportunity.targetSellPrice * 100).toFixed(0) + '¢',
            binanceDelta: binanceData ? binanceData.deltaPct.toFixed(2) + '%' : 'N/A',
            rationale: dipOpportunity.rationale,
            timestamp: new Date().toISOString()
          }));

          await clipperDeskManager.executeDipBuy(
            window.slug,
            market,
            dipOpportunity,
            placeMarketOrder
          );
        }
      } catch (error) {
        console.warn('Dip scalper error:', error.message);
      }

      // ============================================================
      // CLIPPER DESK: CONTINUOUS POSITION MONITORING
      // ============================================================
      try {
        // Monitor Clipper positions for clip opportunities
        const clipperPositions = virtualAccounts.getOpenPositions('CLIPPER');
        for (const position of clipperPositions) {
          if (!position.clipTarget) continue;

          const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
          const gainPercent = (currentPrice - position.entryPrice) / position.entryPrice;

          // Normal clip - target reached
          if (gainPercent >= position.clipTarget) {
            console.log(JSON.stringify({
              action: 'CLIPPER_TARGET_HIT',
              window: position.windowSlug,
              side: position.side,
              entryPrice: position.entryPrice.toFixed(3),
              currentPrice: currentPrice.toFixed(3),
              gainPercent: (gainPercent * 100).toFixed(0) + '%',
              targetGain: (position.clipTarget * 100).toFixed(0) + '%',
              timestamp: new Date().toISOString()
            }));

            await clipperDeskManager.executeClip(
              'CLIPPER',
              position,
              position.clipPercentage || 1.0,
              'TARGET_HIT',
              market,
              placeMarketOrder
            );
          }

          // Emergency clip - >150% gain
          if (gainPercent >= 1.50) {
            console.log(JSON.stringify({
              action: 'CLIPPER_EMERGENCY_150PCT',
              window: position.windowSlug,
              side: position.side,
              gainPercent: (gainPercent * 100).toFixed(0) + '%',
              action_taken: 'PARTIAL_CLIP_75',
              timestamp: new Date().toISOString()
            }));

            await clipperDeskManager.executeClip(
              'CLIPPER',
              position,
              0.75,  // Clip 75%, let 25% ride
              'EMERGENCY_150PCT',
              market,
              placeMarketOrder
            );
          }

          // Time protection - <120s + choppy + profit
          if (window.timeLeft < 120 &&
              windowState.clipperVibesScore < 0.40 &&
              gainPercent > 0.15) {
            console.log(JSON.stringify({
              action: 'CLIPPER_TIME_PROTECTION',
              window: position.windowSlug,
              timeLeft: window.timeLeft,
              vibesScore: windowState.clipperVibesScore,
              gainPercent: (gainPercent * 100).toFixed(0) + '%',
              timestamp: new Date().toISOString()
            }));

            await clipperDeskManager.executeClip(
              'CLIPPER',
              position,
              1.0,
              'TIME_PROTECTION',
              market,
              placeMarketOrder
            );
          }
        }

        // Cross-desk emergency monitoring
        const farmPositions = virtualAccounts.getOpenPositions('FARM');
        const degenPositions = virtualAccounts.getOpenPositions('DEGEN');
        const advisories = clipperDeskManager.monitorCrossDeskPositions(
          farmPositions,
          degenPositions,
          market,
          window.timeLeft
        );

        // Execute emergency clips (with rate limiting to avoid spamming failed attempts)
        for (const advisory of advisories) {
          if (advisory.urgency === 'EMERGENCY' && advisory.recommendation === 'FORCE_CLIP') {
            // Rate limit: Max 3 clip attempts per window
            if (!windowState.clipAttempts) windowState.clipAttempts = 0;
            if (windowState.clipAttempts >= 3) {
              console.log(JSON.stringify({
                action: 'CLIP_RATE_LIMITED',
                desk: advisory.desk,
                window: advisory.windowSlug,
                attempts: windowState.clipAttempts,
                reason: 'Max 3 clip attempts per window reached',
                timestamp: new Date().toISOString()
              }));
              continue;
            }

            const position = (advisory.desk === 'FARM' ? farmPositions : degenPositions)
              .find(p => p.windowSlug === advisory.windowSlug);

            if (position) {
              windowState.clipAttempts++;

              console.log(JSON.stringify({
                action: 'CROSS_DESK_EMERGENCY_CLIP',
                desk: advisory.desk,
                window: advisory.windowSlug,
                side: advisory.side,
                gainPercent: (advisory.gainPercent * 100).toFixed(0) + '%',
                clipPercentage: (advisory.clipPercentage * 100).toFixed(0) + '%',
                rationale: advisory.rationale,
                attempt: windowState.clipAttempts,
                timestamp: new Date().toISOString()
              }));

              await clipperDeskManager.executeClip(
                advisory.desk,
                position,
                advisory.clipPercentage,
                'CROSS_DESK_EMERGENCY',
                market,
                placeMarketOrder
              );
            }
          }
        }
      } catch (error) {
        console.error(JSON.stringify({
          action: 'CLIPPER_MONITORING_ERROR',
          window: window.slug,
          error: error.message,
          timestamp: new Date().toISOString()
        }));
      }

      // Get historical context for informed decision making
      const historicalContext = windowHistoryTracker.getHistoricalContext();
      const streakAnalysis = windowHistoryTracker.getStreakAnalysis();

      // Log context for visibility (only if we have history)
      if (historicalContext.hasHistory && windowState.ordersPlaced === 0) {
        console.log(JSON.stringify({
          action: 'HISTORICAL_CONTEXT',
          overallWinRate: historicalContext.overallWinRate,
          last5WinRate: historicalContext.last5WinRate,
          streak: streakAnalysis.hasStreak ? `${streakAnalysis.length} ${streakAnalysis.type}` : 'none',
          deltaCorrelations: historicalContext.deltaAnalysis,
          timestamp: new Date().toISOString()
        }));
      }

      // 7-PLAYER TRADING DESK ORCHESTRATION (Farm + Degen + Clipper)
      // windowPriceData already fetched above
      const consultationWindow = CONFIG.kimiConsultationWindow;

      // AI ORCHESTRATION DISABLED - using simple price-based rules instead
      const shouldOrchestrate = false;

      // ============================================================
      // 7-PLAYER ORCHESTRATION (Farm, Degen, Clipper, Supervisor)
      // ============================================================

      let finalDecision = windowState.finalDecision || null;

      // ORCHESTRATE 7-PLAYER SYSTEM (if conditions met)
      if (shouldOrchestrate) {
        try {
          console.log(JSON.stringify({
            action: '7_PLAYER_ORCHESTRATION_START',
            window: window.slug,
            delta: windowPriceData ? windowPriceData.delta.toFixed(2) : 'N/A',
            timeLeft: window.timeLeft,
            timestamp: new Date().toISOString()
          }));

          // Aggregate all data for 7-player system
          const marketData = await marketDataAggregator.aggregateWindowDecisionData(
            window,
            market,
            windowState,
            MEMORY.priceHistory
          );

          // RUN 7-PLAYER ORCHESTRATION
          const orchestrationResult = await tradingDeskOrchestrator.orchestrateTradingDecision(
            window.slug,
            marketData,
            window.timeLeft
          );

          windowState.fivePlayerConsulted = true; // Keep variable name for backwards compatibility
          windowState.orchestrationResult = orchestrationResult;

          // Extract final decisions
          const farmDecision = orchestrationResult.supervisorDecision.farmApproved ?
            orchestrationResult.supervisorDecision.finalPlan.farm : null;
          const degenDecision = orchestrationResult.supervisorDecision.degenApproved ?
            orchestrationResult.supervisorDecision.finalPlan.degen : null;
          const clipperDecision = orchestrationResult.clipperDecision || null;

          // Store for execution
          windowState.farmDecision = farmDecision;
          windowState.degenDecision = degenDecision;
          windowState.clipperDecision = clipperDecision;

          // Store clipper vibes for time protection logic
          if (clipperDecision && clipperDecision.vibesScore !== undefined) {
            windowState.clipperVibesScore = clipperDecision.vibesScore;
            windowState.clipperClipTargets = {
              low: clipperDecision.clipTargetLow,
              high: clipperDecision.clipTargetHigh
            };
          }

          console.log(JSON.stringify({
            action: '7_PLAYER_ORCHESTRATION_COMPLETE',
            farmApproved: orchestrationResult.supervisorDecision.farmApproved,
            degenApproved: orchestrationResult.supervisorDecision.degenApproved,
            farmSide: farmDecision ? farmDecision.side : null,
            degenSide: degenDecision ? degenDecision.side : null,
            timestamp: new Date().toISOString()
          }));

          // Cache decision data
          windowState.lastKimiDelta = windowPriceData ? windowPriceData.delta : 0;
          windowState.lastKimiTime = Date.now();

          // HANDLE SELL/PARTIAL_SELL DECISIONS (if either desk wants to exit)
          // TODO: Implement exit logic for 5-player system in future version
          if (false) {
            if (!windowState.chosenSide) {
              console.warn(JSON.stringify({
                action: 'DESK_SELL_ERROR',
                error: 'No position to sell',
                timestamp: new Date().toISOString()
              }));
            } else {
              // Execute sell by buying opposite side
              const oppositeSide = windowState.chosenSide === 'YES' ? 'NO' : 'YES';
              const oppositePrice = oppositeSide === 'YES' ? market.yesPrice : market.noPrice;
              const oppositeTokenId = oppositeSide === 'YES' ? market.yesTokenId : market.noTokenId;

              // Calculate shares to sell
              const totalSpent = windowState.totalSpent;
              const avgEntryPrice = windowState.pricesAtEntry.reduce((sum, p) => sum + p, 0) / windowState.pricesAtEntry.length;
              const totalShares = totalSpent / avgEntryPrice;
              const sharesToSell = kimiDecision.decision === 'PARTIAL_SELL'
                ? Math.floor(totalShares * kimiDecision.sellPercentage)
                : Math.floor(totalShares);

              const sellCost = sharesToSell * oppositePrice;

              console.log(JSON.stringify({
                action: 'EXECUTING_KIMI_SELL',
                decision: kimiDecision.decision,
                sellPercentage: kimiDecision.decision === 'PARTIAL_SELL' ? (kimiDecision.sellPercentage * 100).toFixed(0) + '%' : '100%',
                currentSide: windowState.chosenSide,
                oppositeSide: oppositeSide,
                totalShares: totalShares.toFixed(0),
                sharesToSell: sharesToSell,
                oppositePrice: (oppositePrice * 100).toFixed(1) + '¢',
                sellCost: sellCost.toFixed(2),
                rationale: kimiDecision.rationale,
                timestamp: new Date().toISOString()
              }));

              // Place sell order (buy opposite side)
              const sellEdge = {
                side: oppositeSide,
                price: oppositePrice,
                tokenId: oppositeTokenId,
                betSize: sellCost,
                maxPrice: oppositePrice + 0.05, // 5¢ slippage for urgency
                edgeRatio: 0,
                valueTier: 'KIMI_SELL',
                source: 'KIMI_EXIT'
              };

              const sellResult = placeBet(market, sellEdge);

              if (sellResult.success) {
                console.log(JSON.stringify({
                  action: 'KIMI_SELL_SUCCESS',
                  locked: kimiDecision.decision,
                  sharesToSell: sharesToSell,
                  avgSellPrice: sellResult.avgFillPrice.toFixed(3),
                  profitLocked: 'Position hedged/exited',
                  timestamp: new Date().toISOString()
                }));

                // Mark position as partially/fully sold
                if (kimiDecision.decision === 'SELL') {
                  windowState.positionClosed = true;
                } else {
                  windowState.positionPartiallyClosed = (windowState.positionPartiallyClosed || 0) + kimiDecision.sellPercentage;
                }
              }
            }

            // Continue to next iteration after sell
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }

          // If Kimi says SKIP, skip this iteration
          if (kimiDecision.decision === 'SKIP') {
            console.log(JSON.stringify({
              action: 'KIMI_SKIP',
              rationale: kimiDecision.rationale,
              timestamp: new Date().toISOString()
            }));
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }

        } catch (error) {
          console.error(JSON.stringify({
            action: 'KIMI_CONSULTATION_ERROR',
            error: error.message,
            fallback: 'Proceeding with asymmetric edge logic',
            timestamp: new Date().toISOString()
          }));
          kimiDecision = null; // Fall back to normal logic
        }
      }

      // ============================================================
      // TAKE PROFIT AND RUN - Full position exit on strong gains
      // If up 50%+ with <5 min left, SELL EVERYTHING (avoid min-share issues)
      // ============================================================
      if (window.timeLeft <= 300) {  // Less than 5 minutes left
        const allDesks = ['FARM', 'DEGEN', 'CLIPPER'];

        for (const desk of allDesks) {
          const positions = virtualAccounts.getOpenPositions(desk);

          for (const position of positions) {
            // Skip if wrong window (from previous windows)
            if (position.windowSlug !== window.slug) continue;

            // Calculate current gain
            const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
            const gainPercent = (currentPrice - position.entryPrice) / position.entryPrice;

            // TAKE PROFIT: 50%+ gain with <5 min left = SELL ALL
            if (gainPercent >= 0.50) {
              const sellValue = position.shares * currentPrice;
              const profit = sellValue - position.costBasis;

              console.log(JSON.stringify({
                action: 'TAKE_PROFIT_AND_RUN',
                desk: desk,
                window: window.slug,
                side: position.side,
                entryPrice: position.entryPrice.toFixed(3),
                currentPrice: currentPrice.toFixed(3),
                gainPercent: (gainPercent * 100).toFixed(0) + '%',
                shares: position.shares.toFixed(2),
                costBasis: '$' + position.costBasis.toFixed(2),
                sellValue: '$' + sellValue.toFixed(2),
                expectedProfit: '$' + profit.toFixed(2),
                timeLeft: window.timeLeft + 's',
                rationale: 'Locking in 50%+ profit before window end',
                timestamp: new Date().toISOString()
              }));

              // SELL via market order (opposite side)
              const sellSide = position.side === 'YES' ? 'NO' : 'YES';
              const sellTokenId = position.side === 'YES' ? market.noTokenId : market.yesTokenId;
              const sellPrice = position.side === 'YES' ? market.noPrice : market.yesPrice;

              // Use execution desk to sell (buy opposite side)
              const sellResult = executionDesk.placeBuyOrder(
                sellTokenId,
                sellValue,  // Use full value for selling
                sellPrice + 0.10  // Allow 10¢ slippage to ensure fill
              );

              if (sellResult.success) {
                console.log(JSON.stringify({
                  action: 'TAKE_PROFIT_SUCCESS',
                  desk: desk,
                  window: window.slug,
                  side: position.side,
                  soldShares: sellResult.sharesReceived,
                  proceeds: '$' + (sellResult.costUSDC || sellValue).toFixed(2),
                  profit: '$' + profit.toFixed(2),
                  timestamp: new Date().toISOString()
                }));

                // Record as settled win
                virtualAccounts.settlePosition(desk, position.windowSlug, position.side);
              } else {
                console.log(JSON.stringify({
                  action: 'TAKE_PROFIT_FAILED',
                  desk: desk,
                  window: window.slug,
                  error: sellResult.error,
                  timestamp: new Date().toISOString()
                }));
              }
            }
          }
        }
      }

      // ============================================================
      // CONTINUOUS MONITORING (CLIPPING + MOMENTUM CONTINUATION)
      // ============================================================

      // 1. CLIPPING CHECK (Degen prolific clipper)
      // Check every 30s if open positions have appreciated 50%+
      const farmPositions = virtualAccounts.getOpenPositions('FARM');
      const degenPositions = virtualAccounts.getOpenPositions('DEGEN');

      for (const position of degenPositions) {
        // Skip lotto tickets (let them ride to settlement)
        if (position.isLottoTicket) continue;

        // Check current value vs entry price
        const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
        const gainPercent = (currentPrice - position.entryPrice) / position.entryPrice;

        // CLIP if 50%+ appreciation
        if (gainPercent >= 0.50) {
          const clipAmount = position.shares * currentPrice;
          console.log(JSON.stringify({
            action: 'DEGEN_CLIPPING',
            position: position.slug,
            side: position.side,
            entryPrice: position.entryPrice.toFixed(3),
            currentPrice: currentPrice.toFixed(3),
            gainPercent: (gainPercent * 100).toFixed(1) + '%',
            clipAmount: clipAmount.toFixed(2),
            timestamp: new Date().toISOString()
          }));

          // Place SELL order
          try {
            await placeOrder(position.tokenId, 'SELL', position.shares, 0.99);
            // Update virtual account (record clip as win)
            virtualAccounts.settlePosition('DEGEN', position.slug, position.side);
          } catch (error) {
            console.error('Clipping error:', error);
          }
        }
      }

      // 2. MOMENTUM CONTINUATION (Farm next-window bet)
      // At 480-420s window, if strong momentum, place next-window bet at 50¢
      const inMomentumWindow = window.timeLeft <= 480 && window.timeLeft > 420;
      if (inMomentumWindow && !windowState.momentumContinuationPlaced) {
        const delta = windowPriceData ? Math.abs(windowPriceData.delta) : 0;
        const deltaAge = windowPriceData ? (900 - window.timeLeft) : 0; // How long delta has persisted

        // Strong momentum: Delta >$150 for >8 minutes (480s)
        if (delta > 150 && deltaAge >= 480) {
          windowState.momentumContinuationPlaced = true;

          // Determine direction
          const momentumSide = windowPriceData.delta > 0 ? 'YES' : 'NO';
          const nextWindowSlug = `next-window-momentum-${Date.now()}`;

          console.log(JSON.stringify({
            action: 'FARM_MOMENTUM_CONTINUATION',
            delta: delta.toFixed(2),
            deltaAge: deltaAge + 's',
            side: momentumSide,
            targetPrice: '0.50',
            rationale: 'Strong momentum likely to continue into next window',
            timestamp: new Date().toISOString()
          }));

          // Calculate bet size (5-8% of Farm balance for momentum plays)
          const farmBalance = virtualAccounts.getDeskBalance('FARM');
          const momentumBetSize = farmBalance * 0.06; // 6% allocation

          // Record as virtual trade (for next window)
          // We'll place the actual order when the next window opens
          windowState.pendingMomentumBet = {
            desk: 'FARM',
            side: momentumSide,
            amount: momentumBetSize,
            targetPrice: 0.50,
            slug: nextWindowSlug,
            placedAt: Date.now()
          };
        }
      }

      // 3. AUTO-CLIP MOMENTUM BETS (when new window opens)
      // At 850-820s in a NEW window, clip any momentum continuation bets from previous window
      const inAutoClipWindow = window.timeLeft <= 850 && window.timeLeft > 820;
      if (inAutoClipWindow && !windowState.momentumAutoClipped && windowState.pendingMomentumBet) {
        const momentumBet = windowState.pendingMomentumBet;

        // Place the momentum bet first (at current market price, likely ~50¢)
        const tokenId = momentumBet.side === 'YES' ? market.yesTokenId : market.noTokenId;
        const currentPrice = momentumBet.side === 'YES' ? market.yesPrice : market.noPrice;

        console.log(JSON.stringify({
          action: 'FARM_MOMENTUM_BET_PLACEMENT',
          side: momentumBet.side,
          amount: momentumBet.amount.toFixed(2),
          targetPrice: momentumBet.targetPrice.toFixed(2),
          actualPrice: currentPrice.toFixed(3),
          timestamp: new Date().toISOString()
        }));

        try {
          const shares = await placeOrder(tokenId, 'BUY', momentumBet.amount, 0.51); // Max 51¢

          // Record in virtual account
          virtualAccounts.recordTrade(
            'FARM',
            momentumBet.slug,
            momentumBet.side,
            currentPrice,
            shares,
            momentumBet.amount,
            false // not a lotto ticket
          );

          // Now AUTO-CLIP immediately (scalp the pre-bid)
          // Wait 10 seconds, then sell at current price
          await new Promise(resolve => setTimeout(resolve, 10000));

          const clipPrice = momentumBet.side === 'YES' ? market.yesPrice : market.noPrice;

          console.log(JSON.stringify({
            action: 'FARM_MOMENTUM_AUTO_CLIP',
            entryPrice: currentPrice.toFixed(3),
            clipPrice: clipPrice.toFixed(3),
            shares: shares,
            timestamp: new Date().toISOString()
          }));

          await placeOrder(tokenId, 'SELL', shares, 0.99);
          virtualAccounts.settlePosition('FARM', momentumBet.slug, momentumBet.side);

          windowState.momentumAutoClipped = true;
          windowState.pendingMomentumBet = null;

        } catch (error) {
          console.error('Momentum bet placement/clip error:', error);
        }
      }

      // ============================================================
      // LOGIC-BASED TRADING (No AI orchestration - Friday's working approach)
      // Trades throughout the window based on asymmetric edge analysis
      // ============================================================

      // ============================================================
      // BUILD EDGES FROM 7-PLAYER DECISIONS (Farm + Degen approved trades)
      // ============================================================
      let farmEdge = null;
      let degenEdge = null;

      // FARM DESK DECISION
      if (windowState.farmDecision) {
        const decision = windowState.farmDecision;
        const farmPrice = decision.side === 'YES' ? market.yesPrice : market.noPrice;
        const farmTokenId = decision.side === 'YES' ? market.yesTokenId : market.noTokenId;

        farmEdge = {
          desk: 'FARM',
          side: decision.side,
          price: farmPrice,
          tokenId: farmTokenId,
          betSize: decision.amount,
          maxPrice: decision.maxPrice,
          edgeRatio: (1 - farmPrice) / farmPrice,
          valueTier: 'FARM_INSTITUTIONAL',
          source: '7_PLAYER_FARM'
        };

        console.log(JSON.stringify({
          action: 'FARM_EDGE_READY',
          side: farmEdge.side,
          betSize: farmEdge.betSize.toFixed(2),
          maxPrice: (farmEdge.maxPrice * 100).toFixed(1) + '¢',
          timestamp: new Date().toISOString()
        }));
      }

      // DEGEN DESK DECISION
      if (windowState.degenDecision) {
        const decision = windowState.degenDecision;
        const degenPrice = decision.side === 'YES' ? market.yesPrice : market.noPrice;
        const degenTokenId = decision.side === 'YES' ? market.yesTokenId : market.noTokenId;

        degenEdge = {
          desk: 'DEGEN',
          side: decision.side,
          price: degenPrice,
          tokenId: degenTokenId,
          betSize: decision.amount,
          maxPrice: decision.maxPrice,
          edgeRatio: (1 - degenPrice) / degenPrice,
          valueTier: decision.lottoTicket ? 'DEGEN_LOTTO_TICKET' : 'DEGEN_SCALP',
          source: '7_PLAYER_DEGEN',
          lottoTicket: decision.lottoTicket || false
        };

        console.log(JSON.stringify({
          action: 'DEGEN_EDGE_READY',
          side: degenEdge.side,
          betSize: degenEdge.betSize.toFixed(2),
          maxPrice: (degenEdge.maxPrice * 100).toFixed(1) + '¢',
          lottoTicket: degenEdge.lottoTicket,
          timestamp: new Date().toISOString()
        }));
      }

      // Use first available edge (Farm takes priority if both exist)
      let edge = farmEdge || degenEdge;

      // ============================================================
      // SEQUENTIAL SCALPING SYSTEM - Smart Stacking with Dynamic Risk Cap
      // "Fractal" trading: same strategy at $50 or $50,000
      // ============================================================
      if (!edge) {
        // 1. Calculate dynamic risk cap (15% of War Chest)
        const dynamicCap = virtualAccounts.getPerWindowRiskCap();

        // 2. Prepare market data for Sequential Scalping
        const marketDataForSeq = {
          id: window.slug,
          yesPrice: market.yesPrice,
          noPrice: market.noPrice,
          yesTokenId: market.yesTokenId,
          noTokenId: market.noTokenId,
          secondsLeft: window.timeLeft,
          yesBid: market.yesBid || market.yesPrice,
          noBid: market.noBid || market.noPrice
        };

        // 3. Get oracle trend for smart stacking
        const oracleTrend = binanceData ? { deltaPct: binanceData.deltaPct } : { deltaPct: 0 };

        // 4. Check if we should manage existing position (trailing stop, stop loss, time exit)
        const exitSignal = clipperDeskManager.manageActivePosition(marketDataForSeq);
        if (exitSignal) {
          console.log(JSON.stringify({
            action: 'SEQUENTIAL_EXIT_SIGNAL',
            exitType: exitSignal.reason,
            pnl: exitSignal.pnl?.toFixed(2),
            side: exitSignal.action,
            timestamp: new Date().toISOString()
          }));

          // Execute the clip (sell position)
          const clipResult = await clipperDeskManager.executeClip(
            (exitSignal.action || exitSignal.side || '').includes('YES') ? 'YES' : 'NO',
            exitSignal.size,
            exitSignal.price,
            exitSignal.reason,
            market,
            placeMarketOrder
          );

          if (clipResult && clipResult.success) {
            clipperDeskManager.onTradeClosed(exitSignal.pnl || 0);
          }

          await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
          continue;
        }

        // 5. Evaluate new trade opportunity (Smart Stacking + Lotto)
        const seqState = clipperDeskManager.getSequentialState();
        if (!seqState.activePosition) {
          const opportunity = clipperDeskManager.evaluateTradeOpportunity(
            marketDataForSeq,
            oracleTrend,
            oracleVolatility,
            dynamicCap
          );

          if (opportunity.action !== 'HOLD') {
            console.log(JSON.stringify({
              action: 'SEQUENTIAL_OPPORTUNITY',
              strategy: opportunity.strategy,
              side: opportunity.action,
              price: (opportunity.price * 100).toFixed(1) + '¢',
              size: opportunity.size,
              cost: '$' + opportunity.cost?.toFixed(2),
              reason: opportunity.reason,
              dynamicCap: '$' + dynamicCap.toFixed(2),
              timestamp: new Date().toISOString()
            }));

            // Convert to edge format for existing order execution
            edge = {
              side: opportunity.action.includes('YES') ? 'YES' : 'NO',
              tokenId: opportunity.action.includes('YES') ? market.yesTokenId : market.noTokenId,
              price: opportunity.price,
              betSize: opportunity.cost || (opportunity.size * opportunity.price),
              maxPrice: Math.min(0.85, opportunity.price + 0.05),
              edgeRatio: (1 - opportunity.price) / opportunity.price,
              valueTier: opportunity.strategy,
              desk: 'SEQUENTIAL',
              source: 'SEQUENTIAL_SCALPING',
              lottoTicket: opportunity.strategy === 'LOTTO',
              fairValue: opportunity.fairValue,
              sequentialOpportunity: opportunity  // Pass for onTradeOpened callback
            };
          }
        }

        // Log dynamic cap periodically
        if (Math.random() < 0.005) {
          const fortressState = wealthFortress.getReport();
          console.log(JSON.stringify({
            action: 'DYNAMIC_RISK_CAP',
            warChest: '$' + fortressState.warChest,
            perWindowCap: '$' + dynamicCap.toFixed(2),
            phase: fortressState.phase,
            seqExposure: '$' + seqState.totalExposure.toFixed(2),
            seqTradeCount: seqState.tradeCount,
            timestamp: new Date().toISOString()
          }));
        }
      }

      // ============================================================
      // FALLBACK: Simple asymmetric edge if no Sequential Scalping decision
      // This ensures we trade throughout the window, not just during orchestration
      // ============================================================
      if (!edge) {
        const asymmetricEdge = analyzeAsymmetricEdge(market, windowState);
        if (asymmetricEdge) {
          edge = {
            ...asymmetricEdge,
            desk: 'ASYMMETRIC',
            source: 'ASYMMETRIC_EDGE_FALLBACK'
          };

          console.log(JSON.stringify({
            action: 'ASYMMETRIC_EDGE_FOUND',
            side: edge.side,
            price: (edge.price * 100).toFixed(1) + '¢',
            valueTier: edge.valueTier,
            betSize: '$' + edge.betSize.toFixed(2),
            edgeRatio: edge.edgeRatio.toFixed(2) + ':1',
            timestamp: new Date().toISOString()
          }));
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // DEGEN ALPHA TRIGGER - Extreme conditions trigger DEGEN trades
      // Uses oracle checkDegenCondition functions for extreme signals
      // ═══════════════════════════════════════════════════════════════════
      if (!edge && window.timeLeft > 180) {  // Only in first 12 minutes
        try {
          const degenAvailable = virtualAccounts.getDeskAvailableCapital('DEGEN');

          if (degenAvailable >= 2.00) {  // Need at least $2 for DEGEN
            const alphaSignals = await getAggregatedSignals();

            // Check ALL 7 oracles for DEGEN-worthy conditions
            const fundingDegen = alphaSignals.funding?.rawRate ?
              fundingRateOracle.checkDegenCondition(alphaSignals.funding.rawRate) : { trigger: false };
            const liquidationDegen = alphaSignals.liquidation ?
              liquidationOracle.checkDegenCondition(alphaSignals.liquidation) : { trigger: false };
            const smartMoneyDegen = alphaSignals.smartMoney ?
              copyTradingOracle.checkDegenCondition(alphaSignals.smartMoney) : { trigger: false };
            const depthDegen = alphaSignals.depth ?
              depthOracle.checkDegenCondition(alphaSignals.depth) : { trigger: false };
            const whaleDegen = alphaSignals.whale ?
              whaleOracle.checkDegenCondition(alphaSignals.whale) : { trigger: false };
            const oiDegen = alphaSignals.oi ?
              oiOracle.checkDegenCondition(alphaSignals.oi) : { trigger: false };
            const multiFundingDegen = alphaSignals.multiFunding ?
              multiFundingOracle.checkDegenCondition(alphaSignals.multiFunding) : { trigger: false };

            // Take the first triggered DEGEN condition (priority order)
            let degenTrigger = null;
            if (whaleDegen.trigger) degenTrigger = { ...whaleDegen, source: 'whale' };
            else if (depthDegen.trigger) degenTrigger = { ...depthDegen, source: 'depth' };
            else if (liquidationDegen.trigger) degenTrigger = { ...liquidationDegen, source: 'liquidation' };
            else if (oiDegen.trigger) degenTrigger = { ...oiDegen, source: 'oi' };
            else if (multiFundingDegen.trigger) degenTrigger = { ...multiFundingDegen, source: 'multiFunding' };
            else if (fundingDegen.trigger) degenTrigger = { ...fundingDegen, source: 'funding' };
            else if (smartMoneyDegen.trigger) degenTrigger = { ...smartMoneyDegen, source: 'smartMoney' };

            if (degenTrigger) {
              const side = degenTrigger.side;
              const degenPrice = side === 'YES' ? market.yesPrice : market.noPrice;
              const degenTokenId = side === 'YES' ? market.yesTokenId : market.noTokenId;

              // DEGEN lottery bet: Ensure minimum 5 shares, max $5
              // At any price up to 55¢, need $2.81 minimum (5.1 shares * 0.55)
              const MIN_VIABLE_BET = 5.1 * 0.55;  // $2.81 minimum
              const percentageBet = degenAvailable * 0.20;

              // Use minimum viable bet if 20% is too small, but cap at $5
              // Also cap at 80% of DEGEN balance to prevent full wipeout
              const maxDegenBet = degenAvailable * 0.80;
              const betSize = Math.min(Math.max(percentageBet, MIN_VIABLE_BET), 5.00, maxDegenBet);

              edge = {
                desk: 'DEGEN',
                side: side,
                price: degenPrice,
                tokenId: degenTokenId,
                betSize: betSize,
                maxPrice: 0.55,
                edgeRatio: (1 - degenPrice) / degenPrice,
                valueTier: 'DEGEN_ALPHA_LOTTO',
                source: 'ALPHA_SIGNAL_TRIGGER',
                lottoTicket: true
              };

              console.log(JSON.stringify({
                action: 'DEGEN_ALPHA_TRIGGER',
                side: side,
                betSize: '$' + betSize.toFixed(2),
                price: (degenPrice * 100).toFixed(1) + '¢',
                reason: degenTrigger.reason,
                confidence: degenTrigger.confidence,
                triggerSource: degenTrigger.source,
                triggers: {
                  whale: whaleDegen.trigger,
                  depth: depthDegen.trigger,
                  liquidation: liquidationDegen.trigger,
                  oi: oiDegen.trigger,
                  multiFunding: multiFundingDegen.trigger,
                  funding: fundingDegen.trigger,
                  smartMoney: smartMoneyDegen.trigger
                },
                timestamp: new Date().toISOString()
              }));
            }
          }
        } catch (degenErr) {
          // Non-fatal: continue without DEGEN alpha trigger
          console.log(JSON.stringify({
            action: 'DEGEN_ALPHA_CHECK_FAILED',
            error: degenErr.message,
            timestamp: new Date().toISOString()
          }));
        }
      }

      // Get predicted winner based on delta
      const predicted = windowPriceTracker.getPredictedWinner(window.slug);

      // Get Wealth Fortress status for dashboard
      const fortressReport = wealthFortress.getReport();

      // Log status with Wealth Fortress
      console.log(JSON.stringify({
        action: 'STATUS',
        window: window.slug,
        timeLeft: window.timeLeft + 's',
        btcPrice: CURRENT_PRICE ? CURRENT_PRICE.toFixed(2) : 'N/A',
        windowOpen: predicted ? predicted.delta >= 0 ? (CURRENT_PRICE - predicted.delta).toFixed(2) : (CURRENT_PRICE - predicted.delta).toFixed(2) : 'N/A',
        delta: predicted ? (predicted.delta >= 0 ? '+' : '') + predicted.delta.toFixed(2) : 'N/A',
        deltaPct: predicted ? (predicted.delta >= 0 ? '+' : '') + predicted.deltaPct.toFixed(3) + '%' : 'N/A',
        predictedWinner: predicted ? predicted.predicted : 'N/A',
        yesPricePrice: market.yesPrice.toFixed(3),
        noPrice: market.noPrice.toFixed(3),
        asymmetricSide: edge ? edge.side : 'NONE',
        asymmetricPrice: edge ? edge.price.toFixed(3) : 'N/A',
        edgeRatio: edge ? edge.edgeRatio.toFixed(2) + ':1' : 'N/A',
        valueTier: edge ? edge.valueTier : 'NONE',
        betSize: edge ? '$' + edge.betSize.toFixed(2) : 'N/A',
        chosenSide: windowState.chosenSide || 'NONE',
        orders: `${windowState.ordersPlaced}/${CONFIG.maxOrdersPerWindow}`,
        locked: `$${windowState.capitalLocked.toFixed(2)}`,  // Capital committed (placed + filled)
        spent: `$${windowState.totalSpent.toFixed(2)}`,      // Capital in filled orders only
        // WEALTH FORTRESS STATUS
        fortress: {
          phase: fortressReport.phaseEmoji + ' ' + fortressReport.phase,
          total: '$' + fortressReport.totalEquity,
          vault: '$' + fortressReport.vault,
          warChest: '$' + fortressReport.warChest,
          principal: fortressReport.principalStatus,
          hwm: '$' + fortressReport.highWaterMark
        },
        timestamp: new Date().toISOString(),
      }));

      // Check if we should place an order
      if (edge) {
        // ═══════════════════════════════════════════════════════════════════
        // GEMINI STRATEGY GATES - Check timing, delta threshold, orderbook
        // ═══════════════════════════════════════════════════════════════════

        // GATE 1: Entry Timing Gate (only trade in last 4-5 minutes)
        // EXCEPTION: DEGEN alpha triggers bypass timing gate (opportunistic plays)
        const isDEGENTrigger = edge.valueTier === 'DEGEN_ALPHA_LOTTO' && edge.source === 'ALPHA_SIGNAL_TRIGGER';
        const timingGate = isWithinEntryTimingGate(window.timeLeft);
        if (!timingGate.allowed && !isDEGENTrigger) {
          // Log only occasionally to avoid spam
          if (Math.random() < 0.02) {
            console.log(JSON.stringify({
              action: 'TIMING_GATE_BLOCKED',
              timeLeft: window.timeLeft + 's',
              reason: timingGate.reason,
              edge: edge.side,
              timestamp: new Date().toISOString()
            }));
          }
          await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
          continue;
        }

        // Log DEGEN bypass if applicable
        if (isDEGENTrigger && !timingGate.allowed) {
          console.log(JSON.stringify({
            action: 'DEGEN_TIMING_GATE_BYPASS',
            timeLeft: window.timeLeft + 's',
            reason: 'DEGEN alpha trigger - strong signal overrides timing',
            edge: edge.side,
            timestamp: new Date().toISOString()
          }));
        }

        // GATE 2: Delta Threshold (require significant price movement)
        // EXCEPTION: DEGEN alpha triggers bypass delta gates (rely on alpha signals instead)
        const windowPriceDataForGate = windowPriceTracker.getWindowPriceData(window.slug);
        if (windowPriceDataForGate && windowPriceDataForGate.delta && !isDEGENTrigger) {
          const deltaThreshold = validateDeltaThreshold(windowPriceDataForGate.delta, edge.side);
          if (!deltaThreshold.valid) {
            console.log(JSON.stringify({
              action: 'DELTA_THRESHOLD_BLOCKED',
              side: edge.side,
              delta: '$' + windowPriceDataForGate.delta.toFixed(2),
              reason: deltaThreshold.reason,
              timestamp: new Date().toISOString()
            }));
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }

          // GATE 2B: Delta Magnitude (skip when market is indecisive - Gemini)
          const magnitudeCheck = validateDeltaMagnitude(windowPriceDataForGate.delta);
          if (!magnitudeCheck.valid) {
            // Log only occasionally to reduce spam
            if (Math.random() < 0.05) {
              console.log(JSON.stringify({
                action: 'DELTA_MAGNITUDE_BLOCKED',
                side: edge.side,
                delta: '$' + windowPriceDataForGate.delta.toFixed(2),
                magnitude: '$' + magnitudeCheck.magnitude.toFixed(2),
                reason: magnitudeCheck.reason,
                timestamp: new Date().toISOString()
              }));
            }
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }
        }

        // GATE 3: Orderbook BAR Confirmation (check bid-ask ratio)
        try {
          const orderbookData = await marketDataAggregator.fetchOrderFlowData(edge.tokenId);
          if (orderbookData && orderbookData.success) {
            const barCheck = checkOrderbookConfirmation(edge.side, {
              bidVolume: orderbookData.bidVolume || 0,
              askVolume: orderbookData.askVolume || 0
            });
            if (!barCheck.confirmed) {
              console.log(JSON.stringify({
                action: 'ORDERBOOK_BAR_BLOCKED',
                side: edge.side,
                BAR: barCheck.BAR?.toFixed(2),
                reason: barCheck.reason,
                timestamp: new Date().toISOString()
              }));
              await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
              continue;
            }
          }
        } catch (e) { /* Allow trade if orderbook fetch fails */ }

        console.log(JSON.stringify({
          action: 'GEMINI_GATES_PASSED',
          timingGate: timingGate.reason,
          timeLeft: window.timeLeft + 's',
          side: edge.side,
          timestamp: new Date().toISOString()
        }));

        // ═══════════════════════════════════════════════════════════════════
        // HARD SPENDING CAP - CRITICAL PROTECTION
        // This is the LAST LINE OF DEFENSE against runaway spending
        // ═══════════════════════════════════════════════════════════════════
        const perWindowCap = virtualAccounts.getPerWindowRiskCap();
        // CRITICAL FIX: Use capitalLocked (includes unfilled orders) not totalSpent
        if (windowState.capitalLocked >= perWindowCap) {
          console.log(JSON.stringify({
            action: 'HARD_CAP_REACHED',
            locked: '$' + windowState.capitalLocked.toFixed(2),
            spent: '$' + windowState.totalSpent.toFixed(2),
            cap: '$' + perWindowCap.toFixed(2),
            reason: 'Per-window capital locked limit reached - NO MORE ORDERS',
            timestamp: new Date().toISOString()
          }));
          await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
          continue;
        }

        // Check max orders
        if (windowState.ordersPlaced >= CONFIG.maxOrdersPerWindow) {
          await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
          continue;
        }

        // Check timing (don't spam orders)
        const now = Date.now();
        if (windowState.lastOrderTime > 0) {
          const timeSince = (now - windowState.lastOrderTime) / 1000;
          if (timeSince < CONFIG.minTimeBetweenOrders) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }
        }

        // GEMINI ADAPTIVE POSITION SIZING
        // Uses 2.5% target with minimum share requirement as floor
        // Scales up to 3.5% after consecutive wins
        const adaptiveSize = calculateAdaptivePositionSize(
          MEMORY.activeBalance,
          edge.price,
          windowState.consecutiveWins || 0
        );

        // Apply adaptive sizing to edge bet
        if (edge.betSize !== adaptiveSize.betSize) {
          console.log(JSON.stringify({
            action: 'ADAPTIVE_BET_SIZE',
            originalSize: '$' + edge.betSize.toFixed(2),
            adaptiveSize: '$' + adaptiveSize.betSize.toFixed(2),
            percent: adaptiveSize.percent.toFixed(1) + '%',
            balance: '$' + MEMORY.activeBalance.toFixed(2),
            reason: adaptiveSize.reason,
            consecutiveWins: windowState.consecutiveWins || 0,
            timestamp: new Date().toISOString()
          }));
          edge.betSize = adaptiveSize.betSize;
        }

        // ═══════════════════════════════════════════════════════════════════
        // CAP TO REMAINING WINDOW BUDGET - Don't exceed per-window cap
        // CRITICAL FIX: Use capitalLocked (includes unfilled orders)
        // ═══════════════════════════════════════════════════════════════════
        const remainingBudget = perWindowCap - windowState.capitalLocked;
        if (edge.betSize > remainingBudget) {
          console.log(JSON.stringify({
            action: 'BET_SIZE_CAPPED_TO_REMAINING',
            originalSize: '$' + edge.betSize.toFixed(2),
            remainingBudget: '$' + remainingBudget.toFixed(2),
            alreadyLocked: '$' + windowState.capitalLocked.toFixed(2),
            windowCap: '$' + perWindowCap.toFixed(2),
            timestamp: new Date().toISOString()
          }));
          edge.betSize = remainingBudget;

          // If remaining budget is too small for min shares, skip
          if (edge.betSize < 2.50) {
            console.log(JSON.stringify({
              action: 'REMAINING_BUDGET_TOO_SMALL',
              remainingBudget: '$' + remainingBudget.toFixed(2),
              minRequired: '$2.50',
              reason: 'Cannot meet 5-share minimum with remaining budget',
              timestamp: new Date().toISOString()
            }));
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }
        }

        // *** CRITICAL: VALIDATE SIDE AGAINST DELTA ***
        const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);
        if (windowPriceData) {
          const deltaValidation = windowPriceTracker.validateSideForDelta(
            edge.side,
            windowPriceData.delta,
            windowPriceData.deltaPct
          );

          if (!deltaValidation.valid) {
            console.log(JSON.stringify({
              action: 'DELTA_VALIDATION_FAILED',
              side: edge.side,
              price: edge.price.toFixed(3),
              delta: windowPriceData.delta.toFixed(2),
              deltaPct: windowPriceData.deltaPct.toFixed(3) + '%',
              reason: deltaValidation.reason,
              decision: 'SKIP_TRADE',
              timestamp: new Date().toISOString(),
            }));
            await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
            continue;
          }

          console.log(JSON.stringify({
            action: 'DELTA_VALIDATION_PASSED',
            side: edge.side,
            price: edge.price.toFixed(3),
            delta: windowPriceData.delta.toFixed(2),
            deltaPct: windowPriceData.deltaPct.toFixed(3) + '%',
            confidence: deltaValidation.confidence?.toFixed(2),
            reason: deltaValidation.reason,
            decision: 'PROCEED_WITH_TRADE',
            timestamp: new Date().toISOString(),
          }));
        }

        // ═══════════════════════════════════════════════════════════════════
        // ALPHA SIGNAL CONFLICT CHECK (Gemini-recommended)
        // Reduces position size if funding/liquidation/smart money disagree
        // ═══════════════════════════════════════════════════════════════════
        try {
          const alphaSignals = await getAggregatedSignals();
          const conflictCheck = checkAlphaSignalConflict(edge.side, alphaSignals);

          if (conflictCheck.conflict) {
            const originalSize = edge.betSize;
            edge.betSize = edge.betSize * conflictCheck.sizeMultiplier;

            console.log(JSON.stringify({
              action: 'ALPHA_SIGNAL_SIZE_ADJUSTMENT',
              originalSize: '$' + originalSize.toFixed(2),
              adjustedSize: '$' + edge.betSize.toFixed(2),
              multiplier: conflictCheck.sizeMultiplier,
              reason: conflictCheck.reason,
              consensus: alphaSignals.aggregated?.consensus,
              fundingSignal: alphaSignals.funding?.signal,
              liquidationSignal: alphaSignals.liquidation?.signal,
              smartMoneySignal: alphaSignals.smartMoney?.signal,
              timestamp: new Date().toISOString()
            }));

            // Skip if adjusted size is too small
            if (edge.betSize < 1.00) {
              console.log(JSON.stringify({
                action: 'ALPHA_CONFLICT_SKIP',
                reason: 'Position size too small after alpha adjustment',
                adjustedSize: '$' + edge.betSize.toFixed(2),
                timestamp: new Date().toISOString()
              }));
              await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
              continue;
            }
          }
        } catch (alphaErr) {
          // Non-fatal: proceed without alpha signal adjustment
          console.log(JSON.stringify({
            action: 'ALPHA_SIGNAL_CHECK_FAILED',
            error: alphaErr.message,
            decision: 'PROCEEDING_WITHOUT_ALPHA',
            timestamp: new Date().toISOString()
          }));
        }

        // CRITICAL FIX: Lock capital BEFORE placing order
        // Polymarket locks funds immediately when order is submitted
        windowState.capitalLocked += edge.betSize;
        console.log(JSON.stringify({
          action: 'CAPITAL_LOCKED',
          amount: '$' + edge.betSize.toFixed(2),
          totalLocked: '$' + windowState.capitalLocked.toFixed(2),
          windowCap: '$' + perWindowCap.toFixed(2),
          timestamp: new Date().toISOString()
        }));

        // Place order with desk attribution
        const orderResult = placeBet(market, edge);

        if (!orderResult.success) {
          // Order failed - release the capital lock
          windowState.capitalLocked -= edge.betSize;
          console.log(JSON.stringify({
            action: 'CAPITAL_RELEASED',
            amount: '$' + edge.betSize.toFixed(2),
            totalLocked: '$' + windowState.capitalLocked.toFixed(2),
            reason: 'Order failed',
            timestamp: new Date().toISOString()
          }));
        }

        if (orderResult.success) {
          // RECORD TRADE IN VIRTUAL ACCOUNTS with actual fill data
          // Map ASYMMETRIC/SEQUENTIAL desk to FARM for accounting
          const accountingDesk = (edge.desk === 'ASYMMETRIC' || edge.desk === 'SEQUENTIAL') ? 'FARM' : edge.desk;
          if (accountingDesk && (accountingDesk === 'FARM' || accountingDesk === 'DEGEN')) {
            // Use ACTUAL cost (handles min share boost) - fixes USDC drag bug
            const actualCostBasis = orderResult.actualCost || edge.betSize;
            virtualAccounts.recordTrade(
              accountingDesk,           // 'FARM' or 'DEGEN'
              window.slug,
              edge.side,           // 'YES' or 'NO'
              orderResult.avgFillPrice,  // REAL fill price
              orderResult.totalShares,   // REAL shares
              actualCostBasis,           // ACTUAL cost (not intended)
              edge.tokenId,              // For clipping
              edge.lottoTicket || false
            );

            console.log(JSON.stringify({
              action: 'POSITION_RECORDED',
              desk: accountingDesk,
              source: edge.desk,
              window: window.slug,
              side: edge.side,
              entryPrice: orderResult.avgFillPrice.toFixed(3),
              shares: orderResult.totalShares.toFixed(2),
              cost: edge.betSize.toFixed(2),
              timestamp: new Date().toISOString()
            }));

            // ============================================================
            // SEQUENTIAL SCALPING: Track position for trailing stops
            // ============================================================
            if (edge.desk === 'SEQUENTIAL' && edge.sequentialOpportunity) {
              clipperDeskManager.onTradeOpened(
                edge.side,
                orderResult.avgFillPrice,
                orderResult.totalShares,
                edge.betSize,
                edge.tokenId
              );
            }

            // ============================================================
            // BLACK BOX RECORDER: Log the action
            // ============================================================
            blackBoxRecorder.logAction('BUY', {
              side: edge.side,
              price: orderResult.avgFillPrice,
              shares: orderResult.totalShares,
              cost: edge.betSize,
              strategy: edge.valueTier || edge.source,
              tokenId: edge.tokenId,
              orderId: orderResult.orderID,
              desk: edge.desk,
              estimatedPnL: (1.0 - orderResult.avgFillPrice) * orderResult.totalShares,
              metadata: {
                edgeRatio: edge.edgeRatio,
                lottoTicket: edge.lottoTicket || false
              }
            });
          }

          // Update state
          if (!windowState.chosenSide) {
            windowState.chosenSide = edge.side;
          }

          // Track desk-specific state
          if (edge.desk) {
            if (!windowState.deskOrders) windowState.deskOrders = {};
            if (!windowState.deskOrders[edge.desk]) {
              windowState.deskOrders[edge.desk] = {
                ordersPlaced: 0,
                totalSpent: 0,
                side: edge.side
              };
            }
            windowState.deskOrders[edge.desk].ordersPlaced++;
            windowState.deskOrders[edge.desk].totalSpent += edge.betSize;
          }

          windowState.ordersPlaced++;
          windowState.totalSpent += edge.betSize;
          windowState.lastOrderTime = now;
          windowState.pricesAtEntry.push(orderResult.avgFillPrice);  // Use actual fill price

          // Record trade decision for historical analysis with desk attribution
          const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);
          windowHistoryTracker.recordTradeDecision(
            window.slug,
            edge.side,
            {
              delta: windowPriceData ? windowPriceData.delta : 0,
              deltaPct: windowPriceData ? windowPriceData.deltaPct : 0,
              openPrice: windowPriceData ? windowPriceData.openPrice : CURRENT_PRICE
            },
            {
              price: orderResult.avgFillPrice,  // Use actual fill price
              timeLeft: window.timeLeft,
              desk: edge.desk || 'UNKNOWN' // Track which desk placed the order
            },
            {
              valueTier: edge.valueTier,
              edgeRatio: edge.edgeRatio.toFixed(2) + ':1',
              reasoning: `${edge.desk || 'LEGACY'}: ${edge.valueTier} at ${(orderResult.avgFillPrice * 100).toFixed(1)}¢`,
              lottoTicket: edge.lottoTicket || false
            }
          );

          // GEMINI: Log trade for adaptive learning system
          logTradeForLearning({
            windowSlug: window.slug,
            entryPrice: orderResult.avgFillPrice,
            delta: windowPriceData ? windowPriceData.delta : 0,
            deltaPct: windowPriceData ? windowPriceData.deltaPct : 0,
            BAR: edge.orderbook?.BAR || null,
            barStrength: edge.orderbook?.strength || null,
            timeRemaining: window.timeLeft,
            side: edge.side,
            positionSize: edge.betSize,
            notes: `${edge.desk || 'UNKNOWN'}: ${edge.valueTier}`
          });
        }

        // After placing Farm order, check if Degen also has an order to place
        if (edge === farmEdge && degenEdge && !windowState.degenOrderPlaced) {
          // Place Degen order on next iteration
          windowState.pendingDegenOrder = true;
          edge = degenEdge; // Queue Degen order for next iteration
        } else if (windowState.pendingDegenOrder && edge === degenEdge) {
          windowState.degenOrderPlaced = true;
          windowState.pendingDegenOrder = false;
        }
      }

      await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'LOOP_ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));
      await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
    }
  }
}

// ============================================================
// START
// ============================================================

async function start() {
  console.log(JSON.stringify({
    action: 'INITIALIZING',
    strategy: 'HYBRID Asymmetric Edge Bot (Option 1 + Option 2)',
    description: 'Scaled position sizing based on edge quality',
    positionSizing: {
      '10-20¢': '$4.00 (EXTREME_VALUE - 9:1 to 4:1 edge)',
      '20-30¢': '$2.50 (GREAT_VALUE - 4:1 to 2.3:1 edge)',
      '30-40¢': '$1.50 (GOOD_VALUE - 2:1 to 1.5:1 edge)',
      '40-50¢': '$1.00 (FAIR_VALUE - 1.5:1 to 1:1 edge)',
      '50-60¢': '$0.75 (MINIMAL_EDGE - 1:1 to 0.67:1 edge)',
      '60¢+': '$0 (NEVER - terrible edge)',
    },
    rules: [
      'Scale bet size based on price (cheaper = bigger)',
      'Commit to ONE side per window (never hedge)',
      'Place up to 12 orders per window',
      'Stop adding when price > 70¢',
      'Min 5 shares per order',
      '$15 budget per window',
    ],
    timestamp: new Date().toISOString(),
  }));

  // Load window history
  windowHistoryTracker.loadHistory();

  // Fetch current balance from Polymarket (via Wallet Oracle)
  // This syncs with Wealth Fortress and returns tradeable balance
  await fetchBalance();

  // ============================================================
  // WEALTH FORTRESS INITIALIZATION
  // This is your profit protection layer - it sits ABOVE the desks
  // ============================================================
  const fortressStats = wealthFortress.getStats();
  console.log(JSON.stringify({
    action: 'WEALTH_FORTRESS_INITIALIZED',
    phase: wealthFortress.getCurrentPhase(),
    totalEquity: '$' + fortressStats.totalEquity.toFixed(2),
    vault: '$' + fortressStats.vaultBalance.toFixed(2) + ' (PROTECTED)',
    warChest: '$' + fortressStats.warChest.toFixed(2) + ' (TRADEABLE)',
    principalSecured: fortressStats.principalSecured ? '✅ SAFE FOREVER' : '⚠️ Not yet (need 2x)',
    highWaterMark: '$' + fortressStats.highWaterMark.toFixed(2),
    lifetimeLocked: '$' + fortressStats.lifetimeLocked.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  // ═══════════════════════════════════════════════════════════════════
  // ALPHA SIGNAL ORACLES INITIALIZATION
  // Start all WebSocket streams early to collect data
  // ═══════════════════════════════════════════════════════════════════
  liquidationOracle.initialize();
  depthOracle.initialize();
  whaleOracle.initialize();
  oiOracle.initialize();
  multiFundingOracle.initialize();

  console.log(JSON.stringify({
    action: 'ALPHA_ORACLES_INITIALIZED',
    streams: {
      liquidation: 'Binance WebSocket - forceOrder',
      depth: 'Binance WebSocket - depth5@100ms',
      whale: 'Binance WebSocket - aggTrade ($250k+)',
      oi: 'Bybit WebSocket - tickers.BTCUSDT',
      multiFunding: 'Bybit + OKX WebSocket - funding rates',
      funding: 'Binance REST API',
      smartMoney: 'Polymarket trades API'
    },
    totalSignals: 7,
    cost: 'FREE (all public streams)',
    timestamp: new Date().toISOString()
  }));

  // ═══════════════════════════════════════════════════════════════════
  // SHADOW MODE CHECK - Simulation mode for testing
  // ═══════════════════════════════════════════════════════════════════
  if (executionDesk.isShadowMode()) {
    const shadowStatus = executionDesk.getShadowStatus();
    console.log(JSON.stringify({
      action: 'SHADOW_MODE_ACTIVE',
      mode: 'SIMULATION',
      warning: 'NO REAL TRADES WILL BE EXECUTED',
      virtualBalance: shadowStatus?.virtualBalance?.toFixed(2),
      openPositions: shadowStatus?.openPositions || 0,
      stats: shadowStatus?.stats,
      vaultPath: '/tmp/shadow-vault.json',
      timestamp: new Date().toISOString()
    }));
    console.log('\n' + '='.repeat(60));
    console.log('  SHADOW MODE ACTIVE - SIMULATION ONLY');
    console.log('  All trades will be simulated, no real money at risk');
    console.log('  To disable: Remove SHADOW_MODE=true from environment');
    console.log('='.repeat(60) + '\n');
  }

  // ═══════════════════════════════════════════════════════════════════
  // STARTUP CLEANUP - Remove stale positions from crashed sessions
  // This makes the bot self-healing
  // ═══════════════════════════════════════════════════════════════════
  console.log(JSON.stringify({
    action: 'BOT_STARTUP_CLEANUP',
    timestamp: new Date().toISOString()
  }));

  const cleanupResult = virtualAccounts.cleanupExpiredPositions();
  if (cleanupResult.removed > 0) {
    console.log(JSON.stringify({
      action: 'STARTUP_CLEANUP_RESULT',
      removed: cleanupResult.removed,
      remaining: cleanupResult.remaining,
      message: 'Cleared stale positions from expired windows',
      timestamp: new Date().toISOString()
    }));
  } else {
    console.log(JSON.stringify({
      action: 'STARTUP_CLEANUP_RESULT',
      removed: 0,
      message: 'No stale positions found - system clean',
      timestamp: new Date().toISOString()
    }));
  }

  // Initialize 7-player trading desk system
  // IMPORTANT: Desks now receive WAR CHEST balance, not total equity!
  console.log(JSON.stringify({
    action: '7_PLAYER_SYSTEM_INITIALIZING',
    fundName: 'ASYMMETRIC ALPHA FUND',
    capitalSource: 'WAR_CHEST (not total equity)',
    warChest: '$' + MEMORY.activeBalance.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  virtualAccounts.initializeVirtualAccounts(MEMORY.activeBalance);
  dialogueRecorder.initializeDialogueRecorder();
  leaderboard.initializeLeaderboard();

  console.log(JSON.stringify({
    action: '7_PLAYER_SYSTEM_READY',
    desks: ['FARM (35%)', 'DEGEN (15%)', 'CLIPPER (50%)'],
    players: ['Farm Trader', 'Farm RM', 'Degen Trader', 'Degen RM', 'Clipper Trader', 'Clipper Monitor', 'Supervisor'],
    timestamp: new Date().toISOString()
  }));

  // Connect to price feed
  connectBinanceWebSocket();
  await new Promise(resolve => setTimeout(resolve, 2000));

  // ============================================================
  // START TREASURY DESK (Auto-redemption of winnings)
  // Runs every 5 minutes in background to convert winning shares to USDC
  // ============================================================
  treasuryDesk.startHeartbeat();

  console.log(JSON.stringify({
    action: 'TREASURY_DESK_STARTED',
    interval: '5 minutes',
    purpose: 'Auto-redeem winning positions to USDC',
    timestamp: new Date().toISOString()
  }));

  // Start trading
  await tradingLoop();
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start };
