// ============================================================
// CLIPPER DESK MANAGER
// Core clipping logic, vibes assessment, and straddle execution
// ============================================================

const virtualAccounts = require('./virtual-account-manager');

// ============================================================
// FAIR VALUE CALCULATION - The heart of profitable trading
// ============================================================

/**
 * Calculate fair value for a YES token based on time remaining and price delta
 *
 * Logic: The closer we are to close, the more "locked in" the current direction is.
 * A 0.1% move with 8 minutes left is worth less than a 0.1% move with 2 minutes left.
 *
 * @param {number} deltaPct - Price delta as percentage (e.g., 0.15 for +0.15%)
 * @param {number} timeLeftSeconds - Seconds until market close
 * @returns {number} Fair value for YES token (0.0 to 1.0)
 */
function calculateFairValue(deltaPct, timeLeftSeconds) {
  // Base probability starts at 50%
  let fairValue = 0.50;

  // Time factor: More time = more uncertainty = closer to 50%
  // Less time = more certainty = bigger swings from 50%
  // timeFactor ranges from 0.3 (8 min left) to 1.0 (1 min left)
  const timeFactor = Math.min(1.0, Math.max(0.3, (480 - timeLeftSeconds) / 420));

  // Delta impact: How much the delta moves fair value
  // Small delta (0.05%) = small impact, Large delta (0.5%) = big impact
  // Use a sigmoid-like curve to prevent extreme values
  const deltaImpact = Math.tanh(deltaPct * 3); // tanh keeps it bounded -1 to 1

  // Combine: delta moves us from 50%, time factor amplifies/dampens
  // At 8 min left with +0.1% delta: fairValue = 0.50 + (0.29 * 0.3) = 0.587
  // At 2 min left with +0.1% delta: fairValue = 0.50 + (0.29 * 0.85) = 0.747
  fairValue = 0.50 + (deltaImpact * 0.40 * timeFactor);

  // Clamp to reasonable bounds (never go above 0.90 or below 0.10)
  // Even with huge moves, there's always reversal risk
  fairValue = Math.min(0.90, Math.max(0.10, fairValue));

  return fairValue;
}

/**
 * Calculate the edge (expected value advantage) of a trade
 *
 * @param {number} fairValue - Our calculated fair value (probability)
 * @param {number} marketPrice - Current market ask price
 * @returns {Object} { hasEdge, edgePct, expectedValue, recommendation }
 */
function calculateEdge(fairValue, marketPrice) {
  // Edge = Fair Value - Market Price
  // Positive edge = we're buying below fair value = good bet
  // Negative edge = market is overpriced = bad bet
  const edge = fairValue - marketPrice;
  const edgePct = (edge / marketPrice) * 100;

  // Expected Value = (winProb * winAmount) - (loseProb * loseAmount)
  // If we buy at $0.60 and fair value is $0.65:
  // Win: 65% chance of making $0.40 = +$0.26
  // Lose: 35% chance of losing $0.60 = -$0.21
  // EV = +$0.05 per share
  const winAmount = 1.0 - marketPrice;  // What we make if we win
  const loseAmount = marketPrice;        // What we lose if we lose
  const expectedValue = (fairValue * winAmount) - ((1 - fairValue) * loseAmount);

  // Minimum edge requirements:
  // - At least 3% edge to overcome fees and slippage
  // - Positive expected value
  const minEdgePct = 3.0;
  const hasEdge = edgePct >= minEdgePct && expectedValue > 0;

  let recommendation;
  if (edgePct >= 10) {
    recommendation = 'STRONG_BUY';
  } else if (edgePct >= 5) {
    recommendation = 'BUY';
  } else if (edgePct >= 3) {
    recommendation = 'MARGINAL_BUY';
  } else if (edgePct >= 0) {
    recommendation = 'NO_EDGE';
  } else {
    recommendation = 'NEGATIVE_EDGE';
  }

  return {
    hasEdge,
    edge: edge,
    edgePct: edgePct,
    expectedValue: expectedValue,
    recommendation,
    analysis: `FairValue=${fairValue.toFixed(3)} vs Market=${marketPrice.toFixed(3)} → Edge=${edgePct.toFixed(1)}% EV=$${expectedValue.toFixed(3)}`
  };
}

// Safety constants
const MAX_PRICE_CAP = 0.85;  // NEVER pay more than $0.85 (risk $0.85 to make $0.15)
const MIN_EDGE_PCT = 3.0;    // Require at least 3% edge to trade

// Opener strategy constants
const OPENER_TARGET_PRICE = 0.51;  // Bid slightly above fair value to get filled
const OPENER_MAX_PRICE = 0.54;     // Never pay more than 54 cents at open
const OPENER_WINDOW_START = 60;    // Start looking 60s before close
const OPENER_WINDOW_END = 10;      // Stop at 10s (need time for order to process)
const OPENER_SCALP_TARGET = 0.60;  // Sell opener positions when they hit 60 cents
const OPENER_SCALP_MIN_PROFIT = 0.08; // Minimum 8 cent profit to scalp

// Dip Scalper (Rebound) strategy constants
const DIP_BUY_PRICE = 0.47;           // Buy when price dips to this level
const DIP_SCALP_TARGET_PCT = 1.60;    // 60% profit target
const DIP_MIN_REBOUND_PRICE = 0.75;   // Minimum sell price ($0.47 * 1.60 = $0.752)
const DIP_STOP_LOSS_PCT = -0.05;      // Stop loss: sell if Binance delta drops below -0.05%
const DIP_TIME_STOP_SECONDS = 60;     // Force sell with 60s remaining

// Track active dip positions (not persisted - runtime only)
let activeDipOrders = {}; // { windowSlug: { side, entryPrice, shares, status, sellOrderPosted } }

// ============================================================
// LOTTO TICKET STRATEGY - Buy extreme tails on high volatility
// ============================================================
// Only buy $0.02 tickets when Binance shows the market is "alive"
// A flat market = guaranteed loss. A volatile market = moonshot potential.

const LOTTO_MAX_PRICE = 0.025;        // Only buy tickets at 2.5 cents or less
const LOTTO_BET_SIZE = 1.00;          // Spend $1 per lotto ticket
const LOTTO_MIN_VOLATILITY = 0.05;    // Minimum 0.05% volatility in last minute
const LOTTO_TIME_WINDOW_START = 180;  // Start scanning at 3 minutes left
const LOTTO_TIME_WINDOW_END = 30;     // Stop at 30 seconds (need time to fill)

// Track lotto tickets purchased this window
let lottoTicketsPurchased = {}; // { windowSlug: { side, entryPrice, shares } }

// ============================================================
// OPENER STRATEGY - Pre-bid on next window based on momentum
// ============================================================

/**
 * Calculate the next window's slug based on current window
 * @param {number} currentWindowStart - Unix timestamp of current window start
 * @returns {Object} { slug, start, end }
 */
function getNextWindowInfo(currentWindowStart) {
  const nextWindowStart = currentWindowStart + 900; // Add 15 minutes
  const nextWindowEnd = nextWindowStart + 900;
  return {
    slug: `btc-updown-15m-${nextWindowStart}`,
    start: nextWindowStart,
    end: nextWindowEnd
  };
}

/**
 * Check if we should place an "opener" bet on the next window
 * Based on current window's momentum (trend continuation)
 *
 * @param {number} timeLeftCurrentWindow - Seconds left in current window
 * @param {Object} currentWindowPriceData - Delta info for current window
 * @param {Object} currentMarket - Current market prices
 * @returns {Object|null} { side, price, rationale } or null if no trade
 */
function evaluateOpenerOpportunity(timeLeftCurrentWindow, currentWindowPriceData, currentMarket) {
  // Only run in the opener window (60-10 seconds before close)
  if (timeLeftCurrentWindow > OPENER_WINDOW_START || timeLeftCurrentWindow < OPENER_WINDOW_END) {
    return null;
  }

  // Need price data to determine momentum
  if (!currentWindowPriceData || currentWindowPriceData.delta === undefined) {
    return null;
  }

  const delta = currentWindowPriceData.delta;
  const deltaPct = currentWindowPriceData.deltaPct;
  const currentYesPrice = currentMarket.yesPrice;

  // Determine current trend strength
  // Strong trend = YES price far from 50 cents
  const trendStrength = Math.abs(currentYesPrice - 0.50);
  const isStrongTrend = trendStrength > 0.10; // YES > 60 or < 40

  // Determine direction based on delta
  // Positive delta = BTC up = current window YES is winning
  // We bet the NEXT window will start the same way (momentum continuation)
  const nextWindowSide = delta > 0 ? 'YES' : 'NO';

  // Calculate confidence based on delta size and trend strength
  const deltaStrength = Math.abs(deltaPct);
  let confidence = 'LOW';
  if (deltaStrength > 0.15 && isStrongTrend) {
    confidence = 'HIGH';
  } else if (deltaStrength > 0.08 || isStrongTrend) {
    confidence = 'MEDIUM';
  }

  // Only trade on MEDIUM or HIGH confidence
  if (confidence === 'LOW') {
    return null;
  }

  return {
    side: nextWindowSide,
    price: OPENER_TARGET_PRICE,
    maxPrice: OPENER_MAX_PRICE,
    confidence: confidence,
    rationale: `Trend continuation: Current window ${delta > 0 ? 'UP' : 'DOWN'} ${Math.abs(deltaPct).toFixed(2)}%, YES at ${(currentYesPrice * 100).toFixed(0)}¢ → bet ${nextWindowSide} on next window`
  };
}

/**
 * Execute the opener strategy - place a pre-bid on next window
 * This is called from the main bot when we're in the opener window
 *
 * @param {string} nextWindowSlug - The next window's market slug
 * @param {Object} nextMarket - Market data for next window (yesTokenId, noTokenId, etc.)
 * @param {Object} openerDecision - Result from evaluateOpenerOpportunity
 * @param {Function} placeMarketOrder - Order placement function
 * @returns {Promise<boolean>} Success status
 */
async function executeOpenerBet(nextWindowSlug, nextMarket, openerDecision, placeMarketOrder) {
  try {
    const clipperBalance = virtualAccounts.getDeskBalance('CLIPPER');

    // Opener bets are smaller (5-8% of balance) - it's a "feeler" position
    const betSizePercent = openerDecision.confidence === 'HIGH' ? 0.08 : 0.05;
    const desiredBetSize = clipperBalance * betSizePercent;

    // Minimum 5 shares at ~50 cents = ~$2.50 minimum
    const minBetSize = 5 * openerDecision.maxPrice;
    const betSize = Math.max(minBetSize, desiredBetSize);

    if (clipperBalance < minBetSize) {
      console.log(JSON.stringify({
        action: 'OPENER_SKIPPED',
        window: nextWindowSlug,
        reason: 'Insufficient balance for opener bet',
        clipperBalance: clipperBalance.toFixed(2),
        minRequired: minBetSize.toFixed(2),
        timestamp: new Date().toISOString()
      }));
      return false;
    }

    const tokenId = openerDecision.side === 'YES' ? nextMarket.yesTokenId : nextMarket.noTokenId;

    console.log(JSON.stringify({
      action: 'OPENER_PLACING_BET',
      window: nextWindowSlug,
      strategy: 'TREND_CONTINUATION_OPEN',
      side: openerDecision.side,
      bidPrice: openerDecision.price.toFixed(3),
      maxPrice: openerDecision.maxPrice.toFixed(3),
      betSize: '$' + betSize.toFixed(2),
      confidence: openerDecision.confidence,
      rationale: openerDecision.rationale,
      timestamp: new Date().toISOString()
    }));

    // Place LIMIT order at opener price (NOT market order!)
    const order = await placeMarketOrder(nextMarket, {
      side: openerDecision.side,
      tokenId: tokenId,
      price: openerDecision.maxPrice, // Use max price for limit order
      betSize: betSize,
      desk: 'CLIPPER'
    }, betSize);

    if (order && order.success) {
      const shares = order.totalShares || (betSize / openerDecision.price);
      const avgPrice = order.avgFillPrice || openerDecision.price;

      virtualAccounts.recordTrade(
        'CLIPPER',
        nextWindowSlug,
        openerDecision.side,
        avgPrice,
        shares,
        betSize,
        tokenId,
        false,
        false
      );

      console.log(JSON.stringify({
        action: 'OPENER_BET_SUCCESS',
        window: nextWindowSlug,
        side: openerDecision.side,
        shares: shares.toFixed(2),
        avgPrice: avgPrice.toFixed(3),
        cost: '$' + betSize.toFixed(2),
        strategy: 'Scalp at $0.60+ or hold to close if trend continues',
        timestamp: new Date().toISOString()
      }));

      return true;
    } else {
      console.log(JSON.stringify({
        action: 'OPENER_BET_FAILED',
        window: nextWindowSlug,
        side: openerDecision.side,
        error: order ? order.error : 'Order returned null',
        timestamp: new Date().toISOString()
      }));
      return false;
    }
  } catch (error) {
    console.log(JSON.stringify({
      action: 'OPENER_ERROR',
      window: nextWindowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return false;
  }
}

// ============================================================
// VIBES ASSESSMENT - Determines market volatility and clip targets
// ============================================================

/**
 * Assess market vibes (volatility) to set dynamic clip targets
 * @param {Object} marketData - Market data with windowPrice, technicals, orderFlow
 * @returns {Object} { vibesScore, regime, clipTargetLow, clipTargetHigh, factors, interpretation }
 */
function assessMarketVibes(marketData) {
  let vibesScore = 0;
  const factors = [];

  // Factor 1: Delta volatility (0-0.3 points)
  if (marketData && marketData.windowPrice && marketData.windowPrice.delta) {
    const deltaAbs = Math.abs(marketData.windowPrice.delta);
    if (deltaAbs > 150) {
      vibesScore += 0.30;
      factors.push(`EXTREME_DELTA (+$${deltaAbs.toFixed(0)}) → +0.30`);
    } else if (deltaAbs > 100) {
      vibesScore += 0.20;
      factors.push(`STRONG_DELTA (+$${deltaAbs.toFixed(0)}) → +0.20`);
    } else if (deltaAbs > 50) {
      vibesScore += 0.10;
      factors.push(`MODERATE_DELTA (+$${deltaAbs.toFixed(0)}) → +0.10`);
    } else {
      factors.push(`WEAK_DELTA (+$${deltaAbs.toFixed(0)}) → +0.0`);
    }
  }

  // Factor 2: RSI extremes (0-0.25 points)
  if (marketData && marketData.technicals && marketData.technicals.rsi) {
    const rsi = typeof marketData.technicals.rsi.value === 'number'
      ? marketData.technicals.rsi.value
      : parseFloat(marketData.technicals.rsi.value);
    if (rsi > 70 || rsi < 30) {
      vibesScore += 0.25;
      factors.push(`RSI_EXTREME (${rsi.toFixed(0)}) → +0.25`);
    } else if (rsi > 60 || rsi < 40) {
      vibesScore += 0.15;
      factors.push(`RSI_ELEVATED (${rsi.toFixed(0)}) → +0.15`);
    } else {
      factors.push(`RSI_NEUTRAL (${rsi.toFixed(0)}) → +0.0`);
    }
  }

  // Factor 3: Order flow imbalance (0-0.25 points)
  if (marketData && marketData.orderFlow && marketData.orderFlow.available) {
    const yesImb = Math.abs(marketData.orderFlow.yes.imbalance || 0);
    const noImb = Math.abs(marketData.orderFlow.no.imbalance || 0);
    const maxImb = Math.max(yesImb, noImb);

    if (maxImb > 0.15) {
      vibesScore += 0.25;
      factors.push(`HEAVY_IMBALANCE (${(maxImb * 100).toFixed(0)}%) → +0.25`);
    } else if (maxImb > 0.10) {
      vibesScore += 0.15;
      factors.push(`MODERATE_IMBALANCE (${(maxImb * 100).toFixed(0)}%) → +0.15`);
    } else {
      factors.push(`BALANCED_FLOW (${(maxImb * 100).toFixed(0)}%) → +0.0`);
    }
  }

  // Factor 4: Momentum regime (0-0.20 points)
  if (marketData && marketData.technicals && marketData.technicals.momentum) {
    const regime = marketData.technicals.momentum.regime;
    if (regime === 'EXPLOSIVE') {
      vibesScore += 0.20;
      factors.push('EXPLOSIVE_MOMENTUM → +0.20');
    } else if (regime === 'TRENDING') {
      vibesScore += 0.10;
      factors.push('TRENDING_MOMENTUM → +0.10');
    } else {
      factors.push('CHOPPY_MOMENTUM → +0.0');
    }
  }

  // Normalize to 0.0-1.0
  vibesScore = Math.min(1.0, Math.max(0.0, vibesScore));

  // Determine regime and clip targets
  let regime, clipTargetLow, clipTargetHigh;
  if (vibesScore >= 0.70) {
    regime = 'EXPLOSIVE';
    clipTargetLow = 0.80;   // 80% min gain
    clipTargetHigh = 1.25;  // 125% max gain
  } else if (vibesScore >= 0.40) {
    regime = 'TRENDING';
    clipTargetLow = 0.50;
    clipTargetHigh = 0.80;
  } else {
    regime = 'CHOPPY';
    clipTargetLow = 0.30;
    clipTargetHigh = 0.50;
  }

  return {
    vibesScore: vibesScore,
    regime: regime,
    factors: factors,
    clipTargetLow: clipTargetLow,
    clipTargetHigh: clipTargetHigh,
    interpretation: `${regime} market (${(vibesScore * 100).toFixed(0)}% vibes) → Clip at ${(clipTargetLow * 100).toFixed(0)}-${(clipTargetHigh * 100).toFixed(0)}% profit`
  };
}

// ============================================================
// STRADDLE EXECUTION - Buy both YES and NO before window close
// ============================================================

/**
 * Execute directional bet using Fair Value edge detection
 * Only trades when we have positive expected value
 *
 * @param {string} windowSlug - Current window identifier
 * @param {Object} market - Market data with prices and tokenIds
 * @param {Function} placeMarketOrder - Order placement function
 * @param {Object} windowPriceData - Price data with delta information
 * @param {number} timeLeftSeconds - Seconds until market close
 * @returns {Promise<boolean>} Success status
 */
async function executeClipperStraddle(windowSlug, market, placeMarketOrder, windowPriceData, timeLeftSeconds = 300) {
  try {
    const clipperBalance = virtualAccounts.getDeskBalance('CLIPPER');

    // Check if balance sufficient (min $3 to have any chance at 5 shares)
    if (clipperBalance < 3.00) {
      console.log(JSON.stringify({
        action: 'CLIPPER_SKIPPED',
        window: windowSlug,
        reason: 'Insufficient balance',
        clipperBalance: clipperBalance.toFixed(2),
        timestamp: new Date().toISOString()
      }));
      return false;
    }

    // Get delta information
    const delta = windowPriceData ? windowPriceData.delta : 0;
    const deltaPct = windowPriceData ? windowPriceData.deltaPct : 0;

    // Determine which side to bet on based on delta direction
    const betSide = delta >= 0 ? 'YES' : 'NO';
    const marketPrice = betSide === 'YES' ? market.yesPrice : market.noPrice;
    const tokenId = betSide === 'YES' ? market.yesTokenId : market.noTokenId;

    // ============================================================
    // FAIR VALUE CALCULATION - The key to profitable trading
    // ============================================================

    // Calculate fair value based on delta and time remaining
    // For NO bets, we invert the delta (negative delta = bullish for NO)
    const adjustedDeltaPct = betSide === 'YES' ? deltaPct : -deltaPct;
    const fairValue = calculateFairValue(adjustedDeltaPct, timeLeftSeconds);

    // For NO side, fair value is 1 - yesFairValue
    const sideFairValue = betSide === 'YES' ? fairValue : (1 - fairValue);

    // Calculate edge
    const edgeInfo = calculateEdge(sideFairValue, marketPrice);

    console.log(JSON.stringify({
      action: 'CLIPPER_EDGE_ANALYSIS',
      window: windowSlug,
      delta: (delta >= 0 ? '+' : '') + delta.toFixed(2),
      deltaPct: (deltaPct >= 0 ? '+' : '-') + Math.abs(deltaPct).toFixed(3) + '%',
      timeLeft: timeLeftSeconds + 's',
      betSide: betSide,
      fairValue: sideFairValue.toFixed(3),
      marketPrice: marketPrice.toFixed(3),
      edge: edgeInfo.edgePct.toFixed(1) + '%',
      expectedValue: '$' + edgeInfo.expectedValue.toFixed(3),
      recommendation: edgeInfo.recommendation,
      timestamp: new Date().toISOString()
    }));

    // ============================================================
    // EDGE CHECK - Only trade if we have positive expected value
    // ============================================================

    if (!edgeInfo.hasEdge) {
      console.log(JSON.stringify({
        action: 'CLIPPER_NO_EDGE',
        window: windowSlug,
        reason: edgeInfo.recommendation,
        analysis: edgeInfo.analysis,
        advice: marketPrice > sideFairValue
          ? `Market overpriced (${marketPrice.toFixed(3)} > fair ${sideFairValue.toFixed(3)})`
          : `Edge too small (${edgeInfo.edgePct.toFixed(1)}% < ${MIN_EDGE_PCT}% required)`,
        timestamp: new Date().toISOString()
      }));
      return false;
    }

    // ============================================================
    // PRICE CAP - Never pay more than $0.85 (risk/reward too bad)
    // ============================================================

    if (marketPrice > MAX_PRICE_CAP) {
      console.log(JSON.stringify({
        action: 'CLIPPER_PRICE_TOO_HIGH',
        window: windowSlug,
        reason: 'Market price exceeds safety cap',
        marketPrice: marketPrice.toFixed(3),
        maxAllowed: MAX_PRICE_CAP.toFixed(2),
        riskReward: `Risk $${marketPrice.toFixed(2)} to make $${(1 - marketPrice).toFixed(2)}`,
        timestamp: new Date().toISOString()
      }));
      return false;
    }

    // ============================================================
    // EXECUTE TRADE - Use limit order at fair value (not market!)
    // ============================================================

    // Bid at fair value or market price, whichever is lower
    // This ensures we don't overpay even with slippage
    const bidPrice = Math.min(sideFairValue, marketPrice + 0.02); // Max 2 cent slippage

    // Calculate bet size
    const minShares = 5;
    const minBetSize = minShares * bidPrice;
    const desiredBetSize = clipperBalance * 0.15; // 15% of balance
    const betSize = Math.max(minBetSize, desiredBetSize);

    // Check if we have enough balance
    if (clipperBalance < minBetSize) {
      console.log(JSON.stringify({
        action: 'CLIPPER_SKIPPED',
        window: windowSlug,
        reason: 'Insufficient balance for minimum 5 shares',
        clipperBalance: clipperBalance.toFixed(2),
        minRequired: minBetSize.toFixed(2),
        timestamp: new Date().toISOString()
      }));
      return false;
    }

    console.log(JSON.stringify({
      action: 'CLIPPER_PLACING_BET',
      window: windowSlug,
      strategy: 'FAIR_VALUE_EDGE',
      betSide: betSide,
      bidPrice: bidPrice.toFixed(3),
      marketPrice: marketPrice.toFixed(3),
      fairValue: sideFairValue.toFixed(3),
      edge: edgeInfo.edgePct.toFixed(1) + '%',
      expectedValue: '$' + edgeInfo.expectedValue.toFixed(3),
      betSize: '$' + betSize.toFixed(2),
      potentialProfit: '$' + ((1 - bidPrice) * (betSize / bidPrice)).toFixed(2),
      timestamp: new Date().toISOString()
    }));

    // Place limit order at our calculated bid price
    const order = await placeMarketOrder(market, {
      side: betSide,
      tokenId: tokenId,
      price: bidPrice,
      betSize: betSize,
      desk: 'CLIPPER'
    }, betSize);

    // Check result
    if (order && order.success) {
      const shares = order.totalShares || (betSize / bidPrice);
      const avgPrice = order.avgFillPrice || bidPrice;

      virtualAccounts.recordTrade(
        'CLIPPER',
        windowSlug,
        betSide,
        avgPrice,
        shares,
        betSize,
        tokenId,
        false,
        false
      );

      console.log(JSON.stringify({
        action: 'CLIPPER_BET_SUCCESS',
        window: windowSlug,
        side: betSide,
        shares: shares.toFixed(2),
        avgPrice: avgPrice.toFixed(3),
        cost: '$' + betSize.toFixed(2),
        edge: edgeInfo.edgePct.toFixed(1) + '%',
        expectedProfit: '$' + (edgeInfo.expectedValue * shares).toFixed(2),
        timestamp: new Date().toISOString()
      }));

      return true;
    } else {
      console.log(JSON.stringify({
        action: 'CLIPPER_BET_FAILED',
        window: windowSlug,
        side: betSide,
        bidPrice: bidPrice.toFixed(3),
        error: order ? order.error : 'Order returned null',
        timestamp: new Date().toISOString()
      }));
      return false;
    }
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CLIPPER_ERROR',
      window: windowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return false;
  }
}

// ============================================================
// CLIPPING LOGIC - Execute profit-taking clips
// ============================================================

/**
 * Execute clip (sell position by buying opposite side)
 * @param {string} desk - Desk name ('CLIPPER', 'FARM', or 'DEGEN')
 * @param {Object} position - Position to clip
 * @param {number} clipPercentage - Percentage to clip (0.0-1.0)
 * @param {string} reason - Reason for clip
 * @param {Object} market - Market data
 * @param {Function} placeMarketOrder - Order placement function
 * @returns {Promise<boolean>} Success status
 */
async function executeClip(desk, position, clipPercentage, reason, market, placeMarketOrder) {
  try {
    const sharesToClip = position.shares * clipPercentage;
    const oppositeSide = position.side === 'YES' ? 'NO' : 'YES';
    const oppositeTokenId = oppositeSide === 'YES' ? market.yesTokenId : market.noTokenId;
    const oppositePrice = oppositeSide === 'YES' ? market.yesPrice : market.noPrice;

    console.log(JSON.stringify({
      action: 'CLIPPER_EXECUTING_CLIP',
      desk: desk,
      window: position.windowSlug,
      side: position.side,
      clipPercentage: (clipPercentage * 100).toFixed(0) + '%',
      sharesToClip: sharesToClip.toFixed(2),
      oppositeSide: oppositeSide,
      oppositePrice: oppositePrice.toFixed(3),
      reason: reason,
      timestamp: new Date().toISOString()
    }));

    // Sell by buying opposite side
    const betSize = sharesToClip * oppositePrice;
    const sellResult = await placeMarketOrder(market, {
      side: oppositeSide,
      tokenId: oppositeTokenId,
      price: oppositePrice,
      betSize: betSize,
      desk: desk
    }, betSize);

    if (sellResult && sellResult.success) {
      const clipProfit = sharesToClip * (oppositePrice - position.entryPrice);

      if (clipPercentage >= 1.0) {
        // Full clip - remove position
        virtualAccounts.settlePosition(desk, position.windowSlug, position.side);
      } else {
        // Partial clip - reduce shares
        const updatedPosition = position;
        updatedPosition.shares *= (1 - clipPercentage);
        updatedPosition.costBasis *= (1 - clipPercentage);
        virtualAccounts.saveAccounts();
      }

      // Record clip stats
      virtualAccounts.recordClip(desk, clipProfit, clipPercentage);

      console.log(JSON.stringify({
        action: 'CLIPPER_CLIP_EXECUTED',
        desk: desk,
        window: position.windowSlug,
        side: position.side,
        clipPercentage: (clipPercentage * 100).toFixed(0) + '%',
        profit: clipProfit.toFixed(2),
        reason: reason,
        remainingShares: clipPercentage < 1.0 ? (position.shares * (1 - clipPercentage)).toFixed(2) : '0',
        timestamp: new Date().toISOString()
      }));

      return true;
    } else {
      console.log(JSON.stringify({
        action: 'CLIPPER_CLIP_FAILED',
        desk: desk,
        window: position.windowSlug,
        reason: 'Order placement failed',
        timestamp: new Date().toISOString()
      }));
      return false;
    }
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CLIPPER_CLIP_ERROR',
      desk: desk,
      window: position.windowSlug || 'unknown',
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return false;
  }
}

// ============================================================
// CROSS-DESK MONITORING - Emergency profit protection
// ============================================================

/**
 * Monitor Farm and Degen positions for emergency clips (>100% gains)
 * @param {Array} farmPositions - Farm desk open positions
 * @param {Array} degenPositions - Degen desk open positions
 * @param {Object} market - Market data with current prices
 * @param {number} timeLeft - Time remaining in window
 * @returns {Array} Array of advisory objects
 */
function monitorCrossDeskPositions(farmPositions, degenPositions, market, timeLeft) {
  const advisories = [];

  // Check Farm positions
  for (const position of farmPositions) {
    const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
    const gainPercent = (currentPrice - position.entryPrice) / position.entryPrice;

    // Emergency: >100% gain
    if (gainPercent >= 1.00) {
      advisories.push({
        desk: 'FARM',
        windowSlug: position.windowSlug,
        side: position.side,
        entryPrice: position.entryPrice,
        currentPrice: currentPrice,
        gainPercent: gainPercent,
        unrealizedPL: position.shares * (currentPrice - position.entryPrice),
        recommendation: 'FORCE_CLIP',
        clipPercentage: gainPercent >= 1.50 ? 0.75 : 0.50,
        urgency: gainPercent >= 1.50 ? 'EMERGENCY' : 'HIGH',
        rationale: `Farm position up ${(gainPercent * 100).toFixed(0)}% - lock profit before reversal`,
        timeLeft: timeLeft
      });
    }
  }

  // Check Degen positions (skip lotto tickets)
  for (const position of degenPositions) {
    if (position.isLottoTicket) continue; // NEVER clip lotto tickets

    const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
    const gainPercent = (currentPrice - position.entryPrice) / position.entryPrice;

    // Emergency: >100% gain
    if (gainPercent >= 1.00) {
      advisories.push({
        desk: 'DEGEN',
        windowSlug: position.windowSlug,
        side: position.side,
        entryPrice: position.entryPrice,
        currentPrice: currentPrice,
        gainPercent: gainPercent,
        unrealizedPL: position.shares * (currentPrice - position.entryPrice),
        recommendation: 'FORCE_CLIP',
        clipPercentage: 0.75,
        urgency: 'EMERGENCY',
        rationale: `Degen position up ${(gainPercent * 100).toFixed(0)}% - emergency override`,
        timeLeft: timeLeft
      });
    }
  }

  return advisories;
}

// ============================================================
// POSITION FILTERING - Get clippable positions
// ============================================================

/**
 * Filter positions ready to clip based on targets
 * @param {Array} clipperPositions - Clipper desk open positions
 * @param {Object} market - Market data with current prices
 * @returns {Array} Positions ready to clip
 */
function getClippablePositions(clipperPositions, market) {
  const clippable = [];

  for (const position of clipperPositions) {
    if (!position.clipTarget) continue;

    const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
    const gainPercent = (currentPrice - position.entryPrice) / position.entryPrice;

    // Check if target reached or emergency threshold hit
    if (gainPercent >= position.clipTarget || gainPercent >= 1.00) {
      clippable.push({
        position: position,
        currentPrice: currentPrice,
        gainPercent: gainPercent,
        shouldClip: true,
        clipPercentage: position.clipPercentage || 1.0
      });
    }
  }

  return clippable;
}

// ============================================================
// MODULE EXPORTS
// ============================================================

// ============================================================
// DIP SCALPER (REBOUND) STRATEGY - Buy panic dips, sell rebounds
// ============================================================

/**
 * Evaluate if we should place a dip fishing order
 * Only buy dips when Binance shows trend is still intact (safety net)
 *
 * @param {Object} market - Current market with prices
 * @param {Object} binanceData - { price, openPrice, deltaPct }
 * @param {string} windowSlug - Current window identifier
 * @param {number} timeLeft - Seconds remaining
 * @returns {Object|null} { action, side, price, rationale } or null
 */
function evaluateDipOpportunity(market, binanceData, windowSlug, timeLeft) {
  // Don't fish for dips in last 2 minutes (not enough time to flip)
  if (timeLeft < 120) {
    return null;
  }

  // Check if we already have a dip position for this window
  if (activeDipOrders[windowSlug]) {
    return null; // Already fishing or holding
  }

  // SAFETY CHECK: Is the trend actually intact?
  // If Binance shows BTC is DOWN, the dip is real - don't buy
  const isBinanceBullish = binanceData && binanceData.deltaPct >= DIP_STOP_LOSS_PCT;

  if (!isBinanceBullish) {
    return {
      action: 'SKIP',
      reason: `Trend broken (Binance delta: ${binanceData ? binanceData.deltaPct.toFixed(2) : 'N/A'}%)`
    };
  }

  // Check if YES price has dipped to our target
  // When YES dips to $0.47, panic sellers are dumping
  if (market.yesPrice <= DIP_BUY_PRICE) {
    return {
      action: 'BUY_DIP_YES',
      side: 'YES',
      price: DIP_BUY_PRICE,
      targetSellPrice: DIP_MIN_REBOUND_PRICE,
      rationale: `YES dipped to ${(market.yesPrice * 100).toFixed(0)}¢ but Binance is ${binanceData.deltaPct >= 0 ? 'UP' : 'FLAT'} - buy the panic`
    };
  }

  // Check if NO price has dipped (when YES pumps, NO panics)
  if (market.noPrice <= DIP_BUY_PRICE) {
    return {
      action: 'BUY_DIP_NO',
      side: 'NO',
      price: DIP_BUY_PRICE,
      targetSellPrice: DIP_MIN_REBOUND_PRICE,
      rationale: `NO dipped to ${(market.noPrice * 100).toFixed(0)}¢ but Binance is ${binanceData.deltaPct < 0 ? 'DOWN' : 'FLAT'} - buy the panic`
    };
  }

  return null; // No dip opportunity
}

/**
 * Execute dip buy order and set up auto-flip sell
 *
 * @param {string} windowSlug - Current window identifier
 * @param {Object} market - Market data
 * @param {Object} dipDecision - Result from evaluateDipOpportunity
 * @param {Function} placeMarketOrder - Order placement function
 * @returns {Promise<boolean>} Success status
 */
async function executeDipBuy(windowSlug, market, dipDecision, placeMarketOrder) {
  try {
    const clipperBalance = virtualAccounts.getDeskBalance('CLIPPER');

    // Dip buys are larger (8-12% of balance) - higher conviction
    const betSizePercent = 0.10; // 10% of balance
    const desiredBetSize = clipperBalance * betSizePercent;
    const minBetSize = 5 * dipDecision.price; // Min 5 shares
    const betSize = Math.max(minBetSize, desiredBetSize);

    if (clipperBalance < minBetSize) {
      return false;
    }

    const tokenId = dipDecision.side === 'YES' ? market.yesTokenId : market.noTokenId;

    console.log(JSON.stringify({
      action: 'DIP_SCALPER_BUYING',
      window: windowSlug,
      strategy: 'REBOUND_SCALP',
      side: dipDecision.side,
      bidPrice: dipDecision.price.toFixed(3),
      targetSellPrice: dipDecision.targetSellPrice.toFixed(3),
      betSize: '$' + betSize.toFixed(2),
      expectedProfit: ((dipDecision.targetSellPrice - dipDecision.price) * (betSize / dipDecision.price)).toFixed(2),
      rationale: dipDecision.rationale,
      timestamp: new Date().toISOString()
    }));

    // Place limit buy order at dip price
    const order = await placeMarketOrder(market, {
      side: dipDecision.side,
      tokenId: tokenId,
      price: dipDecision.price,
      betSize: betSize,
      desk: 'CLIPPER'
    }, betSize);

    if (order && order.success) {
      const shares = order.totalShares || (betSize / dipDecision.price);
      const avgPrice = order.avgFillPrice || dipDecision.price;

      // Track this as an active dip position
      activeDipOrders[windowSlug] = {
        side: dipDecision.side,
        entryPrice: avgPrice,
        shares: shares,
        targetSellPrice: dipDecision.targetSellPrice,
        tokenId: tokenId,
        status: 'HOLDING',
        sellOrderPosted: false,
        entryTime: Date.now()
      };

      // Record in virtual accounts
      virtualAccounts.recordTrade(
        'CLIPPER',
        windowSlug,
        dipDecision.side,
        avgPrice,
        shares,
        betSize,
        tokenId,
        false,
        false
      );

      console.log(JSON.stringify({
        action: 'DIP_SCALPER_FILLED',
        window: windowSlug,
        side: dipDecision.side,
        entryPrice: avgPrice.toFixed(3),
        shares: shares.toFixed(2),
        targetSellPrice: dipDecision.targetSellPrice.toFixed(3),
        expectedProfit: '$' + ((dipDecision.targetSellPrice - avgPrice) * shares).toFixed(2),
        nextStep: 'AUTO_FLIP: Post sell order at target',
        timestamp: new Date().toISOString()
      }));

      return true;
    }

    return false;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'DIP_SCALPER_ERROR',
      window: windowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return false;
  }
}

/**
 * Monitor dip positions for auto-flip (sell at target)
 * Also handles stop loss and time stops
 *
 * @param {Object} market - Current market prices
 * @param {string} windowSlug - Current window
 * @param {number} timeLeft - Seconds remaining
 * @param {Object} binanceData - Real-time Binance data
 * @returns {Object|null} { action, position, price, reason } or null
 */
function checkDipAutoFlip(market, windowSlug, timeLeft, binanceData) {
  const dipPosition = activeDipOrders[windowSlug];
  if (!dipPosition || dipPosition.status !== 'HOLDING') {
    return null;
  }

  const currentPrice = dipPosition.side === 'YES' ? market.yesPrice : market.noPrice;
  const profit = currentPrice - dipPosition.entryPrice;
  const profitPct = (profit / dipPosition.entryPrice) * 100;

  // CHECK 1: Hit target price (60%+ profit) - AUTO FLIP!
  if (currentPrice >= dipPosition.targetSellPrice) {
    return {
      action: 'SELL_AT_TARGET',
      position: dipPosition,
      price: currentPrice,
      profit: profit,
      profitPct: profitPct,
      reason: `TARGET HIT: ${(currentPrice * 100).toFixed(0)}¢ >= ${(dipPosition.targetSellPrice * 100).toFixed(0)}¢ (+${profitPct.toFixed(0)}%)`
    };
  }

  // CHECK 2: Time stop - force sell with <60s remaining
  if (timeLeft < DIP_TIME_STOP_SECONDS) {
    return {
      action: 'SELL_TIME_STOP',
      position: dipPosition,
      price: currentPrice,
      profit: profit,
      profitPct: profitPct,
      reason: `TIME STOP: Only ${timeLeft}s remaining, locking in ${profitPct >= 0 ? 'profit' : 'loss'}`
    };
  }

  // CHECK 3: Stop loss - Binance turned bearish
  if (binanceData && binanceData.deltaPct < DIP_STOP_LOSS_PCT) {
    return {
      action: 'SELL_STOP_LOSS',
      position: dipPosition,
      price: currentPrice,
      profit: profit,
      profitPct: profitPct,
      reason: `STOP LOSS: Binance delta ${binanceData.deltaPct.toFixed(2)}% < ${DIP_STOP_LOSS_PCT}% threshold`
    };
  }

  // CHECK 4: Partial profit take at 30%+ gain
  if (profitPct >= 30 && !dipPosition.partialTaken) {
    return {
      action: 'PARTIAL_TAKE_30PCT',
      position: dipPosition,
      price: currentPrice,
      profit: profit,
      profitPct: profitPct,
      reason: `PARTIAL TAKE: +${profitPct.toFixed(0)}% gain, selling half to lock profit`
    };
  }

  return null; // Keep holding
}

/**
 * Mark dip position as closed
 */
function closeDipPosition(windowSlug) {
  if (activeDipOrders[windowSlug]) {
    activeDipOrders[windowSlug].status = 'CLOSED';
  }
}

/**
 * Get active dip positions for monitoring
 */
function getActiveDipPositions() {
  return Object.entries(activeDipOrders)
    .filter(([slug, pos]) => pos.status === 'HOLDING')
    .map(([slug, pos]) => ({ windowSlug: slug, ...pos }));
}

// ============================================================
// LOTTO TICKET STRATEGY FUNCTIONS
// ============================================================

/**
 * Scan for lotto ticket opportunities
 * Only buy when: cheap price ($0.02) + high volatility + late game
 *
 * @param {Object} market - Current market with prices
 * @param {number} volatility - Oracle volatility (% range in last minute)
 * @param {string} windowSlug - Current window identifier
 * @param {number} timeLeft - Seconds remaining
 * @returns {Object|null} Lotto opportunity or null
 */
function scanForLottoTickets(market, volatility, windowSlug, timeLeft) {
  // CHECK 1: Timing - only late game (3 min to 30 sec)
  if (timeLeft > LOTTO_TIME_WINDOW_START || timeLeft < LOTTO_TIME_WINDOW_END) {
    return null;
  }

  // CHECK 2: Already bought a lotto this window
  if (lottoTicketsPurchased[windowSlug]) {
    return null;
  }

  // CHECK 3: Find a cheap ticket (either YES or NO at $0.025 or less)
  let targetSide = null;
  let entryPrice = 0;
  let tokenId = null;

  if (market.yesPrice <= LOTTO_MAX_PRICE) {
    targetSide = 'YES';
    entryPrice = market.yesPrice;
    tokenId = market.yesTokenId;
  } else if (market.noPrice <= LOTTO_MAX_PRICE) {
    targetSide = 'NO';
    entryPrice = market.noPrice;
    tokenId = market.noTokenId;
  }

  if (!targetSide) {
    return null; // No cheap tickets available
  }

  // CHECK 4: THE VOLATILITY FILTER (Critical!)
  // Only buy if Binance shows BTC is moving FAST
  // A flat market = guaranteed loss. Volatile = moonshot potential.
  if (volatility < LOTTO_MIN_VOLATILITY) {
    return {
      available: true,
      skipped: true,
      reason: `Volatility too low (${volatility.toFixed(3)}% < ${LOTTO_MIN_VOLATILITY}% required)`,
      side: targetSide,
      price: entryPrice
    };
  }

  // JACKPOT! Cheap ticket + high volatility = BUY
  const shares = Math.floor(LOTTO_BET_SIZE / (entryPrice + 0.01)); // Pay 1 cent premium
  const potentialPayout = shares * 1.00; // If it hits, each share pays $1
  const maxLoss = LOTTO_BET_SIZE;

  return {
    available: true,
    skipped: false,
    action: `BUY_${targetSide}`,
    side: targetSide,
    tokenId: tokenId,
    entryPrice: entryPrice,
    bidPrice: entryPrice + 0.01, // Pay 1 cent premium to guarantee fill
    shares: shares,
    cost: LOTTO_BET_SIZE,
    potentialPayout: potentialPayout,
    payoffRatio: (potentialPayout / maxLoss).toFixed(0) + 'x',
    volatility: volatility,
    timeLeft: timeLeft,
    rationale: `LOTTO: ${targetSide} at ${(entryPrice * 100).toFixed(1)}¢ with ${volatility.toFixed(2)}% vol → ${(potentialPayout / maxLoss).toFixed(0)}x potential`
  };
}

/**
 * Execute lotto ticket purchase
 *
 * @param {string} windowSlug - Current window identifier
 * @param {Object} market - Market data
 * @param {Object} lottoOpportunity - Result from scanForLottoTickets
 * @param {Function} placeMarketOrder - Order placement function
 * @returns {Promise<boolean>} Success status
 */
async function executeLottoBuy(windowSlug, market, lottoOpportunity, placeMarketOrder) {
  try {
    const clipperBalance = virtualAccounts.getDeskBalance('CLIPPER');

    // Lotto tickets are tiny - max $1 each
    const betSize = Math.min(LOTTO_BET_SIZE, clipperBalance * 0.03); // Max 3% of balance

    if (betSize < 0.50) {
      return false; // Not enough for a lotto ticket
    }

    console.log(JSON.stringify({
      action: 'LOTTO_TICKET_BUYING',
      window: windowSlug,
      strategy: 'MOONSHOT_50X',
      side: lottoOpportunity.side,
      entryPrice: lottoOpportunity.entryPrice.toFixed(3),
      bidPrice: lottoOpportunity.bidPrice.toFixed(3),
      betSize: '$' + betSize.toFixed(2),
      potentialPayout: '$' + lottoOpportunity.potentialPayout.toFixed(2),
      payoffRatio: lottoOpportunity.payoffRatio,
      volatility: lottoOpportunity.volatility.toFixed(3) + '%',
      timeLeft: lottoOpportunity.timeLeft + 's',
      rationale: lottoOpportunity.rationale,
      timestamp: new Date().toISOString()
    }));

    // Place aggressive buy order
    const order = await placeMarketOrder(market, {
      side: lottoOpportunity.side,
      tokenId: lottoOpportunity.tokenId,
      price: lottoOpportunity.bidPrice,
      betSize: betSize,
      desk: 'CLIPPER'
    }, betSize);

    if (order && order.success) {
      const shares = order.totalShares || (betSize / lottoOpportunity.entryPrice);
      const avgPrice = order.avgFillPrice || lottoOpportunity.entryPrice;

      // Track this lotto ticket
      lottoTicketsPurchased[windowSlug] = {
        side: lottoOpportunity.side,
        entryPrice: avgPrice,
        shares: shares,
        cost: betSize,
        potentialPayout: shares * 1.00,
        purchasedAt: Date.now()
      };

      // Record in virtual accounts (mark as lotto ticket)
      virtualAccounts.recordTrade(
        'CLIPPER',
        windowSlug,
        lottoOpportunity.side,
        avgPrice,
        shares,
        betSize,
        lottoOpportunity.tokenId,
        true,  // IS A LOTTO TICKET - don't auto-clip
        false
      );

      console.log(JSON.stringify({
        action: 'LOTTO_TICKET_PURCHASED',
        window: windowSlug,
        side: lottoOpportunity.side,
        entryPrice: avgPrice.toFixed(3),
        shares: shares.toFixed(0),
        cost: '$' + betSize.toFixed(2),
        potentialPayout: '$' + (shares * 1.00).toFixed(2),
        payoffRatio: ((1.00 / avgPrice)).toFixed(0) + 'x',
        volatility: lottoOpportunity.volatility.toFixed(3) + '%',
        outcome: 'HOLDING_TO_EXPIRY',
        timestamp: new Date().toISOString()
      }));

      return true;
    }

    return false;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'LOTTO_TICKET_ERROR',
      window: windowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return false;
  }
}

/**
 * Get lotto tickets purchased this session
 */
function getLottoTickets() {
  return Object.entries(lottoTicketsPurchased)
    .map(([slug, ticket]) => ({ windowSlug: slug, ...ticket }));
}

/**
 * Clear lotto tickets for a closed window
 */
function clearLottoTicket(windowSlug) {
  delete lottoTicketsPurchased[windowSlug];
}

/**
 * Check if opener positions should be scalped (sold at profit)
 * Called from main loop to monitor opener positions
 *
 * @param {Array} clipperPositions - All clipper positions
 * @param {Object} market - Current market with prices
 * @returns {Array} Positions ready to scalp
 */
function checkOpenerScalps(clipperPositions, market) {
  const scalps = [];

  for (const position of clipperPositions) {
    // Only scalp positions entered at opener prices (around 50 cents)
    if (position.entryPrice > 0.55) continue; // Not an opener position

    const currentPrice = position.side === 'YES' ? market.yesPrice : market.noPrice;
    const profit = currentPrice - position.entryPrice;

    // Scalp if we've hit target OR have minimum profit
    if (currentPrice >= OPENER_SCALP_TARGET || profit >= OPENER_SCALP_MIN_PROFIT) {
      scalps.push({
        position: position,
        currentPrice: currentPrice,
        profit: profit,
        profitPct: (profit / position.entryPrice) * 100,
        recommendation: 'SCALP',
        rationale: currentPrice >= OPENER_SCALP_TARGET
          ? `Hit scalp target (${(currentPrice * 100).toFixed(0)}¢ >= ${(OPENER_SCALP_TARGET * 100).toFixed(0)}¢)`
          : `Min profit reached (+${(profit * 100).toFixed(0)}¢)`
      });
    }
  }

  return scalps;
}

module.exports = {
  assessMarketVibes,
  executeClipperStraddle,
  executeClip,
  monitorCrossDeskPositions,
  getClippablePositions,
  // Fair Value exports
  calculateFairValue,
  calculateEdge,
  MAX_PRICE_CAP,
  MIN_EDGE_PCT,
  // Opener strategy exports
  getNextWindowInfo,
  evaluateOpenerOpportunity,
  executeOpenerBet,
  checkOpenerScalps,
  OPENER_TARGET_PRICE,
  OPENER_MAX_PRICE,
  OPENER_SCALP_TARGET,
  // Dip Scalper (Rebound) strategy exports
  evaluateDipOpportunity,
  executeDipBuy,
  checkDipAutoFlip,
  closeDipPosition,
  getActiveDipPositions,
  DIP_BUY_PRICE,
  DIP_MIN_REBOUND_PRICE,
  DIP_SCALP_TARGET_PCT,
  // Lotto Ticket strategy exports
  scanForLottoTickets,
  executeLottoBuy,
  getLottoTickets,
  clearLottoTicket,
  LOTTO_MAX_PRICE,
  LOTTO_BET_SIZE,
  LOTTO_MIN_VOLATILITY
};
