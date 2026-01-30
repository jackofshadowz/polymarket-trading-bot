#!/usr/bin/env node
// ============================================================
// WINDOW PRICE TRACKER
// ============================================================
// Captures BTC prices at exact window boundaries
// Key insight: "last window close = next window open"
// YES wins if: BTC close >= BTC open
// NO wins if: BTC close < BTC open

const WINDOW_PRICES = {
  history: {},               // { windowSlug: { openPrice, currentPrice, delta, ... } }
  previousWindowClose: null, // BTC price at last window boundary (becomes next window's open)
  maxHistory: 100
};

/**
 * Called when new window detected (slug changes)
 * Opening price = PREVIOUS window's closing price
 */
function captureWindowOpeningPrice(windowSlug, currentBTCPrice) {
  // Use previous window's close as opening price (if available)
  const openPrice = WINDOW_PRICES.previousWindowClose || currentBTCPrice;

  WINDOW_PRICES.history[windowSlug] = {
    openPrice: openPrice,
    currentPrice: currentBTCPrice,
    delta: currentBTCPrice - openPrice,
    deltaPct: ((currentBTCPrice - openPrice) / openPrice) * 100,
    captureTime: Date.now(),
    captureQuality: WINDOW_PRICES.previousWindowClose ? 'exact' : 'late_entry',
    samples: 1,
    minPrice: currentBTCPrice,
    maxPrice: currentBTCPrice
  };

  console.log(JSON.stringify({
    action: 'WINDOW_OPENING_PRICE_CAPTURED',
    window: windowSlug,
    openPrice: openPrice.toFixed(2),
    currentPrice: currentBTCPrice.toFixed(2),
    delta: (currentBTCPrice - openPrice).toFixed(2),
    deltaPct: (((currentBTCPrice - openPrice) / openPrice) * 100).toFixed(3) + '%',
    captureQuality: WINDOW_PRICES.history[windowSlug].captureQuality,
    timestamp: new Date().toISOString(),
  }));

  return WINDOW_PRICES.history[windowSlug];
}

/**
 * Called when window closes (end of 15min)
 * Store closing price for next window's opening
 */
function captureWindowClosingPrice(windowSlug, btcPrice) {
  WINDOW_PRICES.previousWindowClose = btcPrice;

  if (WINDOW_PRICES.history[windowSlug]) {
    WINDOW_PRICES.history[windowSlug].closePrice = btcPrice;
    WINDOW_PRICES.history[windowSlug].finalDelta = btcPrice - WINDOW_PRICES.history[windowSlug].openPrice;
    WINDOW_PRICES.history[windowSlug].finalDeltaPct =
      ((btcPrice - WINDOW_PRICES.history[windowSlug].openPrice) / WINDOW_PRICES.history[windowSlug].openPrice) * 100;

    // Determine winner
    WINDOW_PRICES.history[windowSlug].winner =
      btcPrice >= WINDOW_PRICES.history[windowSlug].openPrice ? 'YES' : 'NO';
  }

  console.log(JSON.stringify({
    action: 'WINDOW_CLOSING_PRICE_CAPTURED',
    window: windowSlug,
    closePrice: btcPrice.toFixed(2),
    finalDelta: WINDOW_PRICES.history[windowSlug]?.finalDelta?.toFixed(2),
    winner: WINDOW_PRICES.history[windowSlug]?.winner,
    willBeNextWindowOpen: true,
    timestamp: new Date().toISOString(),
  }));

  // Cleanup old windows (keep last 100)
  const windows = Object.keys(WINDOW_PRICES.history);
  if (windows.length > WINDOW_PRICES.maxHistory) {
    const toDelete = windows.slice(0, windows.length - WINDOW_PRICES.maxHistory);
    toDelete.forEach(slug => delete WINDOW_PRICES.history[slug]);
  }
}

/**
 * Update current price and calculate real-time delta
 */
function updateWindowPrice(windowSlug, currentBTCPrice) {
  if (!WINDOW_PRICES.history[windowSlug]) {
    return captureWindowOpeningPrice(windowSlug, currentBTCPrice);
  }

  const window = WINDOW_PRICES.history[windowSlug];
  window.currentPrice = currentBTCPrice;
  window.delta = currentBTCPrice - window.openPrice;
  window.deltaPct = (window.delta / window.openPrice) * 100;
  window.samples++;
  window.lastUpdate = Date.now();

  // Track price range
  if (currentBTCPrice < window.minPrice) window.minPrice = currentBTCPrice;
  if (currentBTCPrice > window.maxPrice) window.maxPrice = currentBTCPrice;
  window.priceRange = window.maxPrice - window.minPrice;

  return window;
}

/**
 * Get window price data for decision making
 */
function getWindowPriceData(windowSlug) {
  return WINDOW_PRICES.history[windowSlug] || null;
}

/**
 * Check if a side makes sense given current delta
 * Returns: { valid: boolean, reason: string }
 */
function validateSideForDelta(side, delta, deltaPct) {
  // YES wins if BTC closes >= open (positive delta)
  // NO wins if BTC closes < open (negative delta)

  if (side === 'YES') {
    if (delta < -50) {
      return {
        valid: false,
        reason: `Delta is ${delta.toFixed(0)} (${deltaPct.toFixed(2)}%) - BTC is DOWN, NO should win`
      };
    }
    if (delta < 0) {
      return {
        valid: true,
        confidence: 0.3,
        reason: `Delta is ${delta.toFixed(0)} (${deltaPct.toFixed(2)}%) - slightly negative, risky YES bet`
      };
    }
    return {
      valid: true,
      confidence: Math.min(0.95, 0.50 + (Math.abs(deltaPct) * 0.05)),
      reason: `Delta is +${delta.toFixed(0)} (+${deltaPct.toFixed(2)}%) - BTC is UP, YES has edge`
    };
  }

  if (side === 'NO') {
    if (delta > 50) {
      return {
        valid: false,
        reason: `Delta is +${delta.toFixed(0)} (+${deltaPct.toFixed(2)}%) - BTC is UP, YES should win`
      };
    }
    if (delta > 0) {
      return {
        valid: true,
        confidence: 0.3,
        reason: `Delta is +${delta.toFixed(0)} (+${deltaPct.toFixed(2)}%) - slightly positive, risky NO bet`
      };
    }
    return {
      valid: true,
      confidence: Math.min(0.95, 0.50 + (Math.abs(deltaPct) * 0.05)),
      reason: `Delta is ${delta.toFixed(0)} (${deltaPct.toFixed(2)}%) - BTC is DOWN, NO has edge`
    };
  }

  return { valid: false, reason: 'Invalid side' };
}

/**
 * Get predicted winner based on current delta
 */
function getPredictedWinner(windowSlug) {
  const data = getWindowPriceData(windowSlug);
  if (!data) return null;

  return {
    predicted: data.delta >= 0 ? 'YES' : 'NO',
    delta: data.delta,
    deltaPct: data.deltaPct,
    confidence: Math.min(0.95, 0.50 + (Math.abs(data.deltaPct) * 0.05)),
    reasoning: data.delta >= 0
      ? `BTC is +$${data.delta.toFixed(2)} (+${data.deltaPct.toFixed(3)}%) above open - YES should win`
      : `BTC is -$${Math.abs(data.delta).toFixed(2)} (${data.deltaPct.toFixed(3)}%) below open - NO should win`
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  captureWindowOpeningPrice,
  captureWindowClosingPrice,
  updateWindowPrice,
  getWindowPriceData,
  validateSideForDelta,
  getPredictedWinner,
  WINDOW_PRICES  // For debugging
};
