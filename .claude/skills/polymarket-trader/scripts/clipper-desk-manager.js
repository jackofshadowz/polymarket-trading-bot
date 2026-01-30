// ============================================================
// CLIPPER DESK MANAGER
// Core clipping logic, vibes assessment, and straddle execution
// ============================================================

const virtualAccounts = require('./virtual-account-manager');

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
 * Execute straddle on current window to create position for next window
 * @param {string} windowSlug - Current window identifier
 * @param {Object} market - Market data with prices and tokenIds
 * @param {Function} placeMarketOrder - Order placement function
 * @returns {Promise<boolean>} Success status
 */
async function executeClipperStraddle(windowSlug, market, placeMarketOrder) {
  try {
    const clipperBalance = virtualAccounts.getDeskBalance('CLIPPER');

    // Check if balance sufficient (min $5)
    if (clipperBalance < 5.00) {
      console.log(JSON.stringify({
        action: 'CLIPPER_STRADDLE_SKIPPED',
        window: windowSlug,
        reason: 'Insufficient balance',
        clipperBalance: clipperBalance.toFixed(2),
        timestamp: new Date().toISOString()
      }));
      return false;
    }

    // Size: 10-15% of clipper balance
    const straddleSize = clipperBalance * 0.12;
    const yesCost = straddleSize / 2;
    const noCost = straddleSize / 2;

    console.log(JSON.stringify({
      action: 'CLIPPER_STRADDLE_INITIATING',
      window: windowSlug,
      clipperBalance: clipperBalance.toFixed(2),
      straddleSize: straddleSize.toFixed(2),
      yesCost: yesCost.toFixed(2),
      noCost: noCost.toFixed(2),
      timestamp: new Date().toISOString()
    }));

    // Buy YES
    const yesOrder = await placeMarketOrder(market, {
      side: 'YES',
      tokenId: market.yesTokenId,
      price: market.yesPrice,
      betSize: yesCost,
      desk: 'CLIPPER'
    }, yesCost);

    // Buy NO
    const noOrder = await placeMarketOrder(market, {
      side: 'NO',
      tokenId: market.noTokenId,
      price: market.noPrice,
      betSize: noCost,
      desk: 'CLIPPER'
    }, noCost);

    if (yesOrder && yesOrder.success && noOrder && noOrder.success) {
      // Record straddle
      virtualAccounts.recordStraddle('CLIPPER', windowSlug, {
        yesShares: yesOrder.totalShares,
        noShares: noOrder.totalShares,
        yesCost: yesCost,
        noCost: noCost,
        totalCost: straddleSize,
        timestamp: new Date().toISOString(),
        settled: false
      });

      console.log(JSON.stringify({
        action: 'CLIPPER_STRADDLE_PLACED',
        window: windowSlug,
        yesShares: yesOrder.totalShares.toFixed(2),
        yesPrice: yesOrder.avgFillPrice.toFixed(3),
        noShares: noOrder.totalShares.toFixed(2),
        noPrice: noOrder.avgFillPrice.toFixed(3),
        totalCost: straddleSize.toFixed(2),
        purpose: 'Create clippable position for next window',
        timestamp: new Date().toISOString()
      }));

      return true;
    } else {
      console.log(JSON.stringify({
        action: 'CLIPPER_STRADDLE_FAILED',
        window: windowSlug,
        yesSuccess: yesOrder ? yesOrder.success : false,
        noSuccess: noOrder ? noOrder.success : false,
        timestamp: new Date().toISOString()
      }));
      return false;
    }
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CLIPPER_STRADDLE_ERROR',
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

module.exports = {
  assessMarketVibes,
  executeClipperStraddle,
  executeClip,
  monitorCrossDeskPositions,
  getClippablePositions
};
