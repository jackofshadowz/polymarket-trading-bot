#!/usr/bin/env node
// ============================================================
// MARKET DATA AGGREGATOR
// ============================================================
// Aggregates comprehensive trading data from multiple sources
// for AI-powered decision making (Kimi world-class trader)
//
// Data Sources:
// 1. Window price tracker (opening, current, delta)
// 2. Order flow (pmarket-cli -o for bid/ask depth)
// 3. Technical indicators (RSI, momentum, volatility)
// 4. Historical context (win rates, streaks, patterns)
// 5. Market context (news, sentiment, BTC trend)
// 6. Current position state

const { execSync } = require('child_process');
const windowPriceTracker = require('./window-price-tracker');
const windowHistoryTracker = require('./window-history-tracker');

// ============================================================
// ORDER FLOW FETCHING
// ============================================================

/**
 * Fetch order book for a token using Polymarket CLOB API
 * Returns: { market, asset_id, bids: [{price, size}], asks: [{price, size}] }
 */
function fetchSingleOrderBook(tokenId) {
  try {
    // Use Polymarket CLOB API directly (much faster than pmarket-cli)
    const output = execSync(`curl -s "https://clob.polymarket.com/book?token_id=${tokenId}"`, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore']
    });

    const orderBook = JSON.parse(output);

    // Check for API error
    if (orderBook.error) {
      console.warn(JSON.stringify({
        action: 'ORDER_BOOK_API_ERROR',
        tokenId: tokenId.substring(0, 20) + '...',
        error: orderBook.error,
        timestamp: new Date().toISOString()
      }));
      return null;
    }

    return orderBook;
  } catch (error) {
    console.warn(JSON.stringify({
      action: 'ORDER_BOOK_FETCH_FAILED',
      tokenId: tokenId.substring(0, 20) + '...',
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return null;
  }
}

/**
 * Fetch order books for both YES and NO tokens
 * Calculate order flow imbalance and market depth
 */
async function fetchOrderFlowData(yesTokenId, noTokenId) {
  const yesBook = fetchSingleOrderBook(yesTokenId);
  const noBook = fetchSingleOrderBook(noTokenId);

  if (!yesBook || !noBook) {
    return {
      available: false,
      reason: 'Order book data unavailable'
    };
  }

  // Calculate order book metrics for YES
  const yesBidVolume = yesBook.bids ? yesBook.bids.reduce((sum, bid) => sum + parseFloat(bid.size || 0), 0) : 0;
  const yesAskVolume = yesBook.asks ? yesBook.asks.reduce((sum, ask) => sum + parseFloat(ask.size || 0), 0) : 0;
  const yesImbalance = yesBidVolume + yesAskVolume > 0
    ? ((yesBidVolume - yesAskVolume) / (yesBidVolume + yesAskVolume) * 100).toFixed(1)
    : '0.0';
  const yesSpread = yesBook.asks && yesBook.bids && yesBook.asks.length > 0 && yesBook.bids.length > 0
    ? (parseFloat(yesBook.asks[0].price) - parseFloat(yesBook.bids[0].price)) * 100
    : 0;

  // Calculate order book metrics for NO
  const noBidVolume = noBook.bids ? noBook.bids.reduce((sum, bid) => sum + parseFloat(bid.size || 0), 0) : 0;
  const noAskVolume = noBook.asks ? noBook.asks.reduce((sum, ask) => sum + parseFloat(ask.size || 0), 0) : 0;
  const noImbalance = noBidVolume + noAskVolume > 0
    ? ((noBidVolume - noAskVolume) / (noBidVolume + noAskVolume) * 100).toFixed(1)
    : '0.0';
  const noSpread = noBook.asks && noBook.bids && noBook.asks.length > 0 && noBook.bids.length > 0
    ? (parseFloat(noBook.asks[0].price) - parseFloat(noBook.bids[0].price)) * 100
    : 0;

  return {
    available: true,
    yes: {
      bidVolume: yesBidVolume.toFixed(0),
      askVolume: yesAskVolume.toFixed(0),
      imbalance: parseFloat(yesImbalance),
      imbalanceFormatted: yesImbalance + '%',
      signal: parseFloat(yesImbalance) > 10 ? 'STRONG_BUYING' :
              parseFloat(yesImbalance) > 5 ? 'BUYING' :
              parseFloat(yesImbalance) < -10 ? 'STRONG_SELLING' :
              parseFloat(yesImbalance) < -5 ? 'SELLING' : 'NEUTRAL',
      spread: yesSpread.toFixed(1) + '¢',
      depth: yesBidVolume + yesAskVolume > 0 ? '$' + (yesBidVolume + yesAskVolume).toFixed(0) : 'N/A'
    },
    no: {
      bidVolume: noBidVolume.toFixed(0),
      askVolume: noAskVolume.toFixed(0),
      imbalance: parseFloat(noImbalance),
      imbalanceFormatted: noImbalance + '%',
      signal: parseFloat(noImbalance) > 10 ? 'STRONG_BUYING' :
              parseFloat(noImbalance) > 5 ? 'BUYING' :
              parseFloat(noImbalance) < -10 ? 'STRONG_SELLING' :
              parseFloat(noImbalance) < -5 ? 'SELLING' : 'NEUTRAL',
      spread: noSpread.toFixed(1) + '¢',
      depth: noBidVolume + noAskVolume > 0 ? '$' + (noBidVolume + noAskVolume).toFixed(0) : 'N/A'
    },
    interpretation: interpretOrderFlow(
      parseFloat(yesImbalance),
      parseFloat(noImbalance),
      null // delta will be added by caller
    )
  };
}

/**
 * Interpret order flow in context of current delta
 */
function interpretOrderFlow(yesImbalance, noImbalance, delta) {
  if (delta === null) {
    return 'Order flow data collected, awaiting delta for interpretation.';
  }

  const deltaDirection = delta >= 0 ? 'positive (bullish for YES)' : 'negative (bearish for NO)';
  const yesSignal = yesImbalance > 5 ? 'buying pressure' : yesImbalance < -5 ? 'selling pressure' : 'neutral';
  const noSignal = noImbalance > 5 ? 'buying pressure' : noImbalance < -5 ? 'selling pressure' : 'neutral';

  // Check for confirmation or divergence
  if (delta >= 50 && yesImbalance > 10) {
    return `✅ STRONG CONFIRMATION: Delta is ${deltaDirection} (+$${delta.toFixed(0)}), and YES shows strong ${yesSignal} (+${yesImbalance.toFixed(1)}%). Order flow confirms delta thesis.`;
  } else if (delta <= -50 && noImbalance > 10) {
    return `✅ STRONG CONFIRMATION: Delta is ${deltaDirection} ($${delta.toFixed(0)}), and NO shows strong ${noSignal} (+${noImbalance.toFixed(1)}%). Order flow confirms delta thesis.`;
  } else if (delta >= 30 && yesImbalance > 5) {
    return `✅ CONFIRMATION: Delta is ${deltaDirection} (+$${delta.toFixed(0)}), and YES shows ${yesSignal} (+${yesImbalance.toFixed(1)}%). Moderate confirmation.`;
  } else if (delta <= -30 && noImbalance > 5) {
    return `✅ CONFIRMATION: Delta is ${deltaDirection} ($${delta.toFixed(0)}), and NO shows ${noSignal} (+${noImbalance.toFixed(1)}%). Moderate confirmation.`;
  } else if (delta >= 30 && noImbalance > 10) {
    return `⚠️ DIVERGENCE: Delta is ${deltaDirection} (+$${delta.toFixed(0)}), but NO shows strong ${noSignal} (+${noImbalance.toFixed(1)}%). Smart money may be positioning for reversal.`;
  } else if (delta <= -30 && yesImbalance > 10) {
    return `⚠️ DIVERGENCE: Delta is ${deltaDirection} ($${delta.toFixed(0)}), but YES shows strong ${yesSignal} (+${yesImbalance.toFixed(1)}%). Smart money may be positioning for reversal.`;
  } else {
    return `NEUTRAL: Delta is ${deltaDirection}, order flow is mixed (YES: ${yesImbalance.toFixed(1)}%, NO: ${noImbalance.toFixed(1)}%). No clear signal.`;
  }
}

// ============================================================
// TECHNICAL INDICATORS
// ============================================================

/**
 * Calculate RSI (Relative Strength Index)
 * 14-period RSI from price history
 */
function calculateRSI(priceHistory, period = 14) {
  if (!priceHistory || priceHistory.length < period + 1) {
    return { value: 50, signal: 'NEUTRAL', interpretation: 'Insufficient data for RSI' };
  }

  const changes = [];
  for (let i = 1; i < priceHistory.length; i++) {
    changes.push(priceHistory[i] - priceHistory[i - 1]);
  }

  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0).reduce((sum, c) => sum + c, 0) / period;
  const losses = Math.abs(recentChanges.filter(c => c < 0).reduce((sum, c) => sum + c, 0)) / period;

  const rs = losses === 0 ? 100 : gains / losses;
  const rsi = 100 - (100 / (1 + rs));

  return {
    value: parseFloat(rsi.toFixed(1)),
    signal: rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'NEUTRAL',
    interpretation: rsi > 70
      ? `RSI ${rsi.toFixed(1)} is overbought - reversal risk`
      : rsi < 30
      ? `RSI ${rsi.toFixed(1)} is oversold - bounce likely`
      : `RSI ${rsi.toFixed(1)} is neutral`
  };
}

/**
 * Calculate short-term momentum
 * Rate of change over last N samples
 */
function calculateMomentum(priceHistory, shortPeriod = 5, mediumPeriod = 20) {
  if (!priceHistory || priceHistory.length < mediumPeriod) {
    return {
      short: { direction: 'UNKNOWN', strength: 0 },
      medium: { direction: 'UNKNOWN', strength: 0 },
      regime: 'SIDEWAYS'
    };
  }

  const current = priceHistory[priceHistory.length - 1];
  const shortAgo = priceHistory[priceHistory.length - shortPeriod];
  const mediumAgo = priceHistory[priceHistory.length - mediumPeriod];

  const shortChange = ((current - shortAgo) / shortAgo) * 100;
  const mediumChange = ((current - mediumAgo) / mediumAgo) * 100;

  return {
    short: {
      direction: shortChange > 0.05 ? 'BULLISH' : shortChange < -0.05 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.abs(shortChange).toFixed(3) + '%',
      change: shortChange.toFixed(3) + '%'
    },
    medium: {
      direction: mediumChange > 0.1 ? 'BULLISH' : mediumChange < -0.1 ? 'BEARISH' : 'NEUTRAL',
      strength: Math.abs(mediumChange).toFixed(3) + '%',
      change: mediumChange.toFixed(3) + '%'
    },
    regime: shortChange > 0.1 && mediumChange > 0.1 ? 'STRONG_BULLISH' :
            shortChange < -0.1 && mediumChange < -0.1 ? 'STRONG_BEARISH' :
            shortChange > 0.05 ? 'BULLISH' :
            shortChange < -0.05 ? 'BEARISH' : 'SIDEWAYS'
  };
}

/**
 * Calculate recent volatility
 * Standard deviation of price changes
 */
function calculateVolatility(priceHistory, period = 20) {
  if (!priceHistory || priceHistory.length < period) {
    return {
      recent: 'N/A',
      trend: 'UNKNOWN',
      interpretation: 'Insufficient data for volatility'
    };
  }

  const recentPrices = priceHistory.slice(-period);
  const changes = [];
  for (let i = 1; i < recentPrices.length; i++) {
    changes.push(((recentPrices[i] - recentPrices[i - 1]) / recentPrices[i - 1]) * 100);
  }

  const mean = changes.reduce((sum, c) => sum + c, 0) / changes.length;
  const squaredDiffs = changes.map(c => Math.pow(c - mean, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / changes.length;
  const stdDev = Math.sqrt(variance);

  // Compare to first half vs second half
  const firstHalf = changes.slice(0, Math.floor(changes.length / 2));
  const secondHalf = changes.slice(Math.floor(changes.length / 2));
  const firstStdDev = Math.sqrt(
    firstHalf.map(c => Math.pow(c - mean, 2)).reduce((sum, d) => sum + d, 0) / firstHalf.length
  );
  const secondStdDev = Math.sqrt(
    secondHalf.map(c => Math.pow(c - mean, 2)).reduce((sum, d) => sum + d, 0) / secondHalf.length
  );

  const trend = secondStdDev > firstStdDev * 1.2 ? 'EXPANDING' :
                secondStdDev < firstStdDev * 0.8 ? 'CONTRACTING' : 'STABLE';

  return {
    recent: stdDev.toFixed(3) + '%',
    recentValue: stdDev,
    trend: trend,
    interpretation: stdDev > 0.5
      ? `HIGH VOLATILITY (${stdDev.toFixed(2)}%) - delta can reverse quickly`
      : `LOW VOLATILITY (${stdDev.toFixed(2)}%) - delta more stable`
  };
}

/**
 * Calculate delta velocity
 * How fast is delta changing ($/min)
 */
function calculateDeltaVelocity(windowPriceData, priceHistory) {
  if (!windowPriceData || !windowPriceData.samples || windowPriceData.samples < 5) {
    return {
      value: 0,
      interpretation: 'Insufficient samples for velocity calculation'
    };
  }

  // Approximate: delta change over time elapsed
  // Rough estimate: if we have N samples over ~30 seconds, velocity = delta / (N * 5s / 60)
  const timeElapsed = windowPriceData.samples * 5 / 60; // minutes (assuming 5s interval)
  const velocity = timeElapsed > 0 ? windowPriceData.delta / timeElapsed : 0;

  return {
    value: velocity.toFixed(1),
    interpretation: Math.abs(velocity) > 15
      ? `Delta ${velocity > 0 ? 'accelerating' : 'decelerating'} at $${Math.abs(velocity).toFixed(1)}/min - strong momentum`
      : Math.abs(velocity) > 5
      ? `Delta ${velocity > 0 ? 'increasing' : 'decreasing'} at $${Math.abs(velocity).toFixed(1)}/min`
      : 'Delta stable'
  };
}

// ============================================================
// MASTER AGGREGATION FUNCTION
// ============================================================

/**
 * Aggregate ALL data sources for comprehensive window analysis
 * This is the main entry point called by the trading bot
 */
async function aggregateWindowDecisionData(window, market, windowState, priceHistory) {
  const timestamp = new Date().toISOString();

  // 1. WINDOW PRICE DATA
  const windowPriceData = windowPriceTracker.getWindowPriceData(window.slug);
  const windowPrice = windowPriceData ? {
    openPrice: windowPriceData.openPrice,
    currentPrice: windowPriceData.currentPrice,
    delta: windowPriceData.delta,
    deltaPct: windowPriceData.deltaPct,
    captureQuality: windowPriceData.captureQuality,
    samples: windowPriceData.samples,
    minPrice: windowPriceData.minPrice,
    maxPrice: windowPriceData.maxPrice,
    priceRange: windowPriceData.priceRange
  } : null;

  // 2. ORDER FLOW DATA
  const orderFlow = await fetchOrderFlowData(market.yesTokenId, market.noTokenId);
  if (orderFlow.available && windowPrice) {
    orderFlow.interpretation = interpretOrderFlow(
      orderFlow.yes.imbalance,
      orderFlow.no.imbalance,
      windowPrice.delta
    );
  }

  // 3. TECHNICAL INDICATORS
  const rsi = calculateRSI(priceHistory);
  const momentum = calculateMomentum(priceHistory);
  const volatility = calculateVolatility(priceHistory);
  const deltaVelocity = windowPrice ? calculateDeltaVelocity(windowPrice, priceHistory) : { value: 0, interpretation: 'N/A' };

  const technicals = {
    rsi,
    momentum,
    volatility,
    deltaVelocity
  };

  // 4. HISTORICAL CONTEXT
  const historicalContext = windowHistoryTracker.getHistoricalContext();
  const streakAnalysis = windowHistoryTracker.getStreakAnalysis();

  // 5. CURRENT POSITION STATE
  const avgEntryPrice = windowState.pricesAtEntry && windowState.pricesAtEntry.length > 0
    ? windowState.pricesAtEntry.reduce((sum, p) => sum + p, 0) / windowState.pricesAtEntry.length
    : 0;

  const currentPosition = {
    side: windowState.chosenSide || null,
    ordersPlaced: windowState.ordersPlaced || 0,
    totalSpent: windowState.totalSpent || 0,
    budgetRemaining: 15 - (windowState.totalSpent || 0), // CONFIG.budgetPerWindow hardcoded for now
    avgEntryPrice: avgEntryPrice,
    hasPosition: !!windowState.chosenSide
  };

  // 6. ASSEMBLE COMPREHENSIVE DATA PACKAGE
  return {
    timestamp,
    window: {
      slug: window.slug,
      timeLeft: window.timeLeft,
      timeElapsed: 900 - window.timeLeft,
      completionPct: ((900 - window.timeLeft) / 900 * 100).toFixed(1) + '%'
    },
    windowPrice,
    marketPrices: {
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      yesTokenId: market.yesTokenId,
      noTokenId: market.noTokenId,
      spread: (Math.abs(1.0 - market.yesPrice - market.noPrice) * 100).toFixed(1) + '¢'
    },
    orderFlow,
    technicals,
    historicalContext,
    streakAnalysis,
    currentPosition
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  aggregateWindowDecisionData,
  fetchOrderFlowData,
  calculateRSI,
  calculateMomentum,
  calculateVolatility,
  calculateDeltaVelocity,
  interpretOrderFlow
};
