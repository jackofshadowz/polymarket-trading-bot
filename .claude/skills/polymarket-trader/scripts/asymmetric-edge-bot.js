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

// ============================================================
// STRATEGY CONFIG
// ============================================================

const CONFIG = {
  // Asymmetric edge thresholds (HYBRID STRATEGY)
  maxEntryPrice: 0.60,         // Never buy above 60¢ (terrible edge)
  stopAddingPrice: 0.70,       // Stop adding if price rises above 70¢

  // Scaled position sizing based on price (for asymmetric edge fallback)
  valueTiers: {
    extremeValue: { max: 0.20, size: 4.00 },   // 10-20¢: $4 bets (9:1 to 4:1 edge)
    greatValue:   { max: 0.30, size: 2.50 },   // 20-30¢: $2.50 bets (2.3:1 to 4:1 edge)
    goodValue:    { max: 0.40, size: 1.50 },   // 30-40¢: $1.50 bets (1.5:1 to 2:1 edge)
    fairValue:    { max: 0.50, size: 1.00 },   // 40-50¢: $1.00 bets (1:1 to 1.5:1 edge)
    minimalEdge:  { max: 0.60, size: 0.75 },   // 50-60¢: $0.75 bets (0.67:1 to 1:1 edge)
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
  maxOrdersPerWindow: 12,      // Max 12 orders per window

  // Timing
  minTimeBetweenOrders: 60,    // 60 seconds between orders
  priceCheckInterval: 5000,    // Check every 5 seconds

  // Consultation timing
  kimiConsultationWindow: {
    initial: { start: 850, end: 800 },  // 50-100s into window (early decision)
    riskManagerDelay: 30                // Wait 30s, then risk manager reviews
  }
};

// ============================================================
// STATE
// ============================================================

let MEMORY = {
  currentWindow: null,
  windowState: {},             // Track state per window
  priceHistory: [],
  activeBalance: 0,
};

let CURRENT_PRICE = null;
let WS_BINANCE = null;

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
 * ⚠️  MANUAL BALANCE - UPDATE THIS AS YOUR BALANCE GROWS!
 * pmarket-cli doesn't have a balance command, so we track manually
 */
function fetchBalance() {
  try {
    // MANUAL BALANCE SETTING (update this number as you grow!)
    // Current as of: 2026-01-29 17:20
    const MANUAL_BALANCE = 40.00; // Your actual Polymarket cash balance

    MEMORY.activeBalance = MANUAL_BALANCE;

    console.log(JSON.stringify({
      action: 'BALANCE_SET',
      balance: MANUAL_BALANCE.toFixed(2),
      source: 'MANUAL (update in code as balance grows)',
      timestamp: new Date().toISOString()
    }));

    return MANUAL_BALANCE;

    // DISABLED: pmarket-cli -w doesn't exist
    // const { execSync } = require('child_process');
    // const output = execSync('pmarket-cli -w', {...});

    /*
    // Parse balance from output
    // Expected format: something with "balance" or "USDC"
    const balanceMatch = output.match(/balance.*?(\d+\.?\d*)/i) || output.match(/(\d+\.?\d*)\s*USDC/i);

    if (balanceMatch) {
      const balance = parseFloat(balanceMatch[1]);
      MEMORY.activeBalance = balance;

      console.log(JSON.stringify({
        action: 'BALANCE_FETCHED',
        balance: balance.toFixed(2),
        timestamp: new Date().toISOString()
      }));

      return balance;
    }
    */

    // Fallback: If no balance found, keep existing or use conservative estimate
    if (MEMORY.activeBalance === 0) {
      MEMORY.activeBalance = 40.00; // REAL balance, not $100 fake!
      console.warn(JSON.stringify({
        action: 'BALANCE_FETCH_FAILED',
        fallback: 'Using $100 default',
        timestamp: new Date().toISOString()
      }));
    }

    return MEMORY.activeBalance;
  } catch (error) {
    console.warn('Balance fetch failed:', error.message);

    // Use REAL default if never set (not fake $100!)
    if (MEMORY.activeBalance === 0) {
      MEMORY.activeBalance = 40.00; // YOUR REAL BALANCE
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

function getWindowState(slug) {
  if (!MEMORY.windowState[slug]) {
    MEMORY.windowState[slug] = {
      chosenSide: null,          // YES or NO (commit to one)
      ordersPlaced: 0,
      totalSpent: 0,
      lastOrderTime: 0,
      orders: [],
      pricesAtEntry: [],
      clipperStraddlePlaced: false,    // NEW: Track if straddle executed
      clipperVibesScore: 0.00,         // NEW: Store vibes assessment
      clipperClipTargets: null         // NEW: Store current clip targets
    };
  }
  return MEMORY.windowState[slug];
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

          const yesPrice = parseFloat(prices[0]);
          const noPrice = parseFloat(prices[1]);

          if (isNaN(yesPrice) || isNaN(noPrice)) {
            console.error(JSON.stringify({
              action: 'PRICE_VALIDATION_ERROR',
              window: window.slug,
              yesPriceRaw: prices[0],
              noPriceRaw: prices[1],
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

          const tokenIds = JSON.parse(market.clobTokenIds || '[]');

          resolve({
            question: market.question,
            yesPrice: yesPrice,
            noPrice: noPrice,
            yesTokenId: tokenIds[0],
            noTokenId: tokenIds[1],
            endDate: market.endDate,
            endDateUnix: marketEndDate,
            closed: market.closed,
            validated: true
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

  // If we already chose a side, check if it's still cheap
  if (windowState.chosenSide) {
    if (windowState.chosenSide !== asymmetricSide) {
      return null; // Never switch sides
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

  // Market order: Use current ask price + 5¢ buffer for instant fill
  const marketMaxPrice = Math.min(0.95, edge.price + 0.05);

  console.log(JSON.stringify({
    action: 'PLACING_MARKET_ORDER',
    side: edge.side,
    tokenId: edge.tokenId.substring(0, 20) + '...',
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
      orderID: result.orderID
    };
  } else {
    console.log(JSON.stringify({
      action: 'MARKET_ORDER_FAILED',
      error: result.error,
      attempts: result.attempts,
      timestamp: new Date().toISOString(),
    }));
    return { success: false, avgFillPrice: 0, totalShares: 0, orderID: null };
  }
}

/**
 * Place LIMIT ORDER (patient fill at specific price)
 * Uses Execution Desk with narrow slippage tolerance
 */
function placeLimitOrder(market, edge, betSize) {
  const { shares, cost } = calculateOrderShares(edge.price, betSize);

  // Limit order: Allow small slippage (1-2¢) for better prices
  const maxPrice = Math.min(0.99, edge.price + 0.015);

  console.log(JSON.stringify({
    action: 'PLACING_LIMIT_ORDER',
    side: edge.side,
    tokenId: edge.tokenId.substring(0, 20) + '...',
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
      orderID: result.orderID
    };
  } else {
    console.log(JSON.stringify({
      action: 'LIMIT_ORDER_FAILED',
      error: result.error,
      attempts: result.attempts,
      timestamp: new Date().toISOString(),
    }));
    return { success: false, avgFillPrice: 0, totalShares: 0, orderID: null };
  }
}

/**
 * HYBRID ORDER PLACEMENT: Market + Limit orders
 * 1. Market order for 35% of position (instant fill)
 * 2. Limit orders for 65% of position (better prices)
 */
function placeBet(market, edge) {
  const totalBetSize = edge.betSize;

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

  const fills = [];

  // 1. Place MARKET order first (instant fill)
  if (marketPortion >= 0.50) { // Only if market portion >= $0.50
    const marketFill = placeMarketOrder(market, edge, marketPortion);
    if (marketFill.success) {
      fills.push(marketFill);
    }
  }

  // 2. Place LIMIT order for remaining (better prices)
  if (limitPortion >= 0.50) { // Only if limit portion >= $0.50
    const limitFill = placeLimitOrder(market, edge, limitPortion);
    if (limitFill.success) {
      fills.push(limitFill);
    }
  }

  // Aggregate results
  if (fills.length === 0) {
    console.log(JSON.stringify({
      action: 'PLACE_BET_FAILED',
      reason: 'No successful orders',
      timestamp: new Date().toISOString()
    }));
    return { success: false, avgFillPrice: 0, totalShares: 0, fills: [] };
  }

  // Calculate weighted average fill price
  const totalValue = fills.reduce((sum, f) =>
    sum + (f.avgFillPrice * f.totalShares), 0
  );
  const totalShares = fills.reduce((sum, f) =>
    sum + f.totalShares, 0
  );

  const aggregatedResult = {
    success: true,
    avgFillPrice: totalValue / totalShares,
    totalShares: totalShares,
    fills: fills
  };

  console.log(JSON.stringify({
    action: 'PLACE_BET_SUCCESS',
    avgFillPrice: aggregatedResult.avgFillPrice.toFixed(4),
    totalShares: aggregatedResult.totalShares.toFixed(2),
    totalValue: totalValue.toFixed(2),
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

  while (true) {
    try {
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

            // SETTLE DESK P&L (7-player system: Farm + Degen + Clipper)
            const windowState = MEMORY.windowState[MEMORY.currentWindow.slug];
            if (windowState && windowState.fivePlayerConsulted) {
              // Settle Farm desk position
              const farmResult = virtualAccounts.settlePosition('FARM', MEMORY.currentWindow.slug, winner);
              if (farmResult) {
                console.log(JSON.stringify({
                  action: 'FARM_DESK_SETTLED',
                  window: MEMORY.currentWindow.slug,
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

              // Settle Degen desk position
              const degenResult = virtualAccounts.settlePosition('DEGEN', MEMORY.currentWindow.slug, winner);
              if (degenResult) {
                console.log(JSON.stringify({
                  action: 'DEGEN_DESK_SETTLED',
                  window: MEMORY.currentWindow.slug,
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

                // Update dialogue if Farm already settled
                if (farmResult) {
                  dialogueRecorder.recordOutcome(MEMORY.currentWindow.slug, winner, farmResult, degenResult);
                } else {
                  dialogueRecorder.recordOutcome(MEMORY.currentWindow.slug, winner, null, degenResult);
                }
              }

              // Settle Clipper desk position
              const clipperResult = virtualAccounts.settlePosition('CLIPPER', MEMORY.currentWindow.slug, winner);
              if (clipperResult) {
                console.log(JSON.stringify({
                  action: 'CLIPPER_DESK_SETTLED',
                  window: MEMORY.currentWindow.slug,
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

              // Check if rebalancing is needed
              virtualAccounts.checkRebalancing();
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

        // Refresh balance for new window
        fetchBalance();
      }

      // UPDATE CURRENT PRICE & DELTA
      if (CURRENT_PRICE) {
        windowPriceTracker.updateWindowPrice(window.slug, CURRENT_PRICE);
      }

      const windowState = getWindowState(window.slug);

      // ============================================================
      // CLIPPER DESK: STRADDLE EXECUTION (180-120s before close)
      // ============================================================
      const inStraddleWindow = window.timeLeft <= 180 && window.timeLeft > 120;
      if (inStraddleWindow && !windowState.clipperStraddlePlaced) {
        try {
          const market = await getCurrentMarket(window);
          if (market && !market.closed) {
            // Get window price data for delta-based directional betting
            const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);

            console.log(JSON.stringify({
              action: 'CLIPPER_DIRECTIONAL_WINDOW',
              window: window.slug,
              timeLeft: window.timeLeft,
              delta: windowPriceData ? windowPriceData.delta.toFixed(2) : 'N/A',
              deltaPct: windowPriceData ? windowPriceData.deltaPct.toFixed(3) + '%' : 'N/A',
              purpose: 'Bet on likely winner based on delta momentum',
              timestamp: new Date().toISOString()
            }));

            // Execute DIRECTIONAL BET (not straddle) based on delta
            await clipperDeskManager.executeClipperStraddle(
              window.slug,
              market,
              placeMarketOrder,
              windowPriceData  // Pass delta data for directional decision
            );

            windowState.clipperStraddlePlaced = true;
          }
        } catch (error) {
          console.error(JSON.stringify({
            action: 'CLIPPER_STRADDLE_ERROR',
            window: window.slug,
            error: error.message,
            timestamp: new Date().toISOString()
          }));
        }
      }

      // Don't trade in last 2 minutes
      if (window.timeLeft < 120) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
      }

      // Get current market
      const market = await getCurrentMarket(window);
      if (!market || market.closed) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
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

        // Execute emergency clips
        for (const advisory of advisories) {
          if (advisory.urgency === 'EMERGENCY' && advisory.recommendation === 'FORCE_CLIP') {
            const position = (advisory.desk === 'FARM' ? farmPositions : degenPositions)
              .find(p => p.windowSlug === advisory.windowSlug);

            if (position) {
              console.log(JSON.stringify({
                action: 'CROSS_DESK_EMERGENCY_CLIP',
                desk: advisory.desk,
                window: advisory.windowSlug,
                side: advisory.side,
                gainPercent: (advisory.gainPercent * 100).toFixed(0) + '%',
                clipPercentage: (advisory.clipPercentage * 100).toFixed(0) + '%',
                rationale: advisory.rationale,
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
      const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);
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
      // WAIT FOR 7-PLAYER ORCHESTRATION IF NEEDED
      // ============================================================

      // If we're in orchestration window but haven't consulted yet, wait
      const inOrchestrationWindow = window.timeLeft <= 850 && window.timeLeft > 750;
      const shouldBlock = inOrchestrationWindow && !windowState.fivePlayerConsulted;

      if (shouldBlock) {
        console.log(JSON.stringify({
          action: 'WAITING_FOR_5_PLAYER_ORCHESTRATION',
          timeLeft: window.timeLeft,
          timestamp: new Date().toISOString()
        }));
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
      }

      // If we're past orchestration window and never ran, mark as attempted to unblock
      if (window.timeLeft < 750 && !windowState.fivePlayerConsulted) {
        windowState.fivePlayerConsulted = true;
        console.log(JSON.stringify({
          action: '5_PLAYER_WINDOW_MISSED',
          reason: 'Past orchestration window, releasing block',
          timeLeft: window.timeLeft,
          timestamp: new Date().toISOString()
        }));
      }

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

      // Get predicted winner based on delta
      const predicted = windowPriceTracker.getPredictedWinner(window.slug);

      // Log status
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
        spent: `$${windowState.totalSpent.toFixed(2)}`,
        balance: `$${MEMORY.activeBalance.toFixed(2)}`,
        timestamp: new Date().toISOString(),
      }));

      // Check if we should place an order
      if (edge) {
        // Dynamic budget check - Kimi already calculated this
        // No hard limit, trust AI's position sizing

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

        // Check if we have sufficient balance for this bet
        if (edge.betSize > MEMORY.activeBalance * 0.20) {
          // Sanity check: Never risk more than 20% of balance in one order
          console.warn(JSON.stringify({
            action: 'BET_SIZE_TOO_LARGE',
            betSize: edge.betSize.toFixed(2),
            maxAllowed: (MEMORY.activeBalance * 0.20).toFixed(2),
            timestamp: new Date().toISOString()
          }));
          await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
          continue;
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

        // Place order with desk attribution
        const orderResult = placeBet(market, edge);

        if (orderResult.success) {
          // RECORD TRADE IN VIRTUAL ACCOUNTS with actual fill data
          if (edge.desk) {
            virtualAccounts.recordTrade(
              edge.desk,           // 'FARM' or 'DEGEN'
              window.slug,
              edge.side,           // 'YES' or 'NO'
              orderResult.avgFillPrice,  // REAL fill price
              orderResult.totalShares,   // REAL shares
              edge.betSize,              // Cost basis
              edge.tokenId,              // For clipping
              edge.lottoTicket || false
            );

            console.log(JSON.stringify({
              action: 'POSITION_RECORDED',
              desk: edge.desk,
              window: window.slug,
              side: edge.side,
              entryPrice: orderResult.avgFillPrice.toFixed(3),
              shares: orderResult.totalShares.toFixed(2),
              cost: edge.betSize.toFixed(2),
              timestamp: new Date().toISOString()
            }));
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

  // Fetch current balance from Polymarket
  fetchBalance();

  // Initialize 7-player trading desk system
  console.log(JSON.stringify({
    action: '7_PLAYER_SYSTEM_INITIALIZING',
    fundName: 'ASYMMETRIC ALPHA FUND',
    timestamp: new Date().toISOString()
  }));

  virtualAccounts.initializeVirtualAccounts(MEMORY.activeBalance);
  dialogueRecorder.initializeDialogueRecorder();
  leaderboard.initializeLeaderboard();

  console.log(JSON.stringify({
    action: '7_PLAYER_SYSTEM_READY',
    desks: ['FARM (60%)', 'DEGEN (25%)', 'CLIPPER (15%)'],
    players: ['Farm Trader', 'Farm RM', 'Degen Trader', 'Degen RM', 'Clipper Trader', 'Clipper Monitor', 'Supervisor'],
    timestamp: new Date().toISOString()
  }));

  // Connect to price feed
  connectBinanceWebSocket();
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Start trading
  await tradingLoop();
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start };
