// ============================================================
// MOMENTUM SPLITTER STRATEGY
// ============================================================
// Based on successful trader: $402k monthly PNL, 8732 predictions
// Profile: https://polymarket.com/@k9Q2mX4L8A7ZP3R
//
// STRATEGY:
// - $5 fixed budget per 15-min window
// - Split into 5-10 small orders ($0.50-$1.00 each)
// - Follow short-term momentum ONLY
// - Place orders as momentum confirms/strengthens
// - Scale size with confidence
// - NEVER hedge (one direction per window)
// - Focus on repetition & probability edge

const STRATEGY_CONFIG = {
  budgetPerWindow: 5.00,           // $5 total per window
  minOrderSize: 0.50,              // $0.50 minimum per order
  maxOrderSize: 1.50,              // $1.50 maximum per order
  maxOrdersPerWindow: 10,          // Max 10 orders per window

  // Momentum thresholds
  momentumThreshold: 0.10,         // 0.10% = enter position
  strongMomentumThreshold: 0.30,   // 0.30% = increase size
  veryStrongMomentum: 0.50,        // 0.50% = max size

  // Order spacing (seconds between orders)
  minTimeBetweenOrders: 60,        // 1 minute minimum

  // Confidence-based sizing
  lowConfidenceSize: 0.50,         // Low confidence: $0.50
  medConfidenceSize: 0.75,         // Med confidence: $0.75
  highConfidenceSize: 1.00,        // High confidence: $1.00
  veryHighConfidenceSize: 1.50,    // Very high: $1.50
};

// Track state per window
const WINDOW_STATE = {};

/**
 * Calculate short-term momentum (last 5 minutes)
 * @param {Array} priceHistory Recent BTC prices
 * @returns {Object} Momentum metrics
 */
function calculateShortTermMomentum(priceHistory) {
  if (!priceHistory || priceHistory.length < 2) {
    return { direction: null, strength: 0, confidence: 0 };
  }

  // Get prices from last 5 minutes
  const fiveMinAgo = Date.now() - (5 * 60 * 1000);
  const recentPrices = priceHistory.filter(p => p.timestamp >= fiveMinAgo);

  if (recentPrices.length < 2) {
    return { direction: null, strength: 0, confidence: 0 };
  }

  const oldest = recentPrices[0].price;
  const newest = recentPrices[recentPrices.length - 1].price;

  // Calculate momentum %
  const momentum = ((newest - oldest) / oldest) * 100;

  // Determine direction
  let direction = null;
  if (Math.abs(momentum) >= STRATEGY_CONFIG.momentumThreshold) {
    direction = momentum > 0 ? 'YES' : 'NO';
  }

  // Calculate confidence based on momentum strength
  const absMomentum = Math.abs(momentum);
  let confidence = 0.50; // Base 50%

  if (absMomentum >= STRATEGY_CONFIG.veryStrongMomentum) {
    confidence = 0.90; // Very strong momentum
  } else if (absMomentum >= STRATEGY_CONFIG.strongMomentumThreshold) {
    confidence = 0.75; // Strong momentum
  } else if (absMomentum >= STRATEGY_CONFIG.momentumThreshold) {
    confidence = 0.60; // Moderate momentum
  }

  return {
    direction,
    strength: absMomentum,
    momentum: momentum,
    confidence,
    priceChange: newest - oldest,
    samples: recentPrices.length
  };
}

/**
 * Determine order size based on momentum and confidence
 * @param {number} confidence Confidence level 0-1
 * @param {number} momentumStrength Momentum strength %
 * @returns {number} Order size in dollars
 */
function calculateOrderSize(confidence, momentumStrength) {
  if (confidence >= 0.85) {
    return STRATEGY_CONFIG.veryHighConfidenceSize; // $1.50
  } else if (confidence >= 0.70) {
    return STRATEGY_CONFIG.highConfidenceSize; // $1.00
  } else if (confidence >= 0.60) {
    return STRATEGY_CONFIG.medConfidenceSize; // $0.75
  } else {
    return STRATEGY_CONFIG.lowConfidenceSize; // $0.50
  }
}

/**
 * Decide if we should place an order
 * @param {string} windowSlug Current window
 * @param {Object} momentum Momentum analysis
 * @param {number} timeLeft Seconds left in window
 * @returns {Object|null} Order decision or null
 */
function shouldPlaceOrder(windowSlug, momentum, timeLeft) {
  // Initialize window state if needed
  if (!WINDOW_STATE[windowSlug]) {
    WINDOW_STATE[windowSlug] = {
      direction: null,
      ordersPlaced: 0,
      totalSpent: 0,
      lastOrderTime: 0,
      orders: []
    };
  }

  const state = WINDOW_STATE[windowSlug];

  // Check if we have a clear direction
  if (!momentum.direction) {
    return null; // No clear momentum
  }

  // NEVER HEDGE: If we've already chosen a direction, stick to it
  if (state.direction && state.direction !== momentum.direction) {
    return null; // Don't bet opposite direction
  }

  // Check if we've reached max orders
  if (state.ordersPlaced >= STRATEGY_CONFIG.maxOrdersPerWindow) {
    return null; // Max orders reached
  }

  // Check if we've spent the budget
  if (state.totalSpent >= STRATEGY_CONFIG.budgetPerWindow) {
    return null; // Budget exhausted
  }

  // Check timing (don't spam orders)
  const now = Date.now();
  if (state.lastOrderTime > 0) {
    const timeSinceLastOrder = (now - state.lastOrderTime) / 1000;
    if (timeSinceLastOrder < STRATEGY_CONFIG.minTimeBetweenOrders) {
      return null; // Too soon since last order
    }
  }

  // Don't trade in last 2 minutes (too risky)
  if (timeLeft < 120) {
    return null;
  }

  // Calculate order size
  let orderSize = calculateOrderSize(momentum.confidence, momentum.strength);

  // Ensure we don't exceed budget
  const remainingBudget = STRATEGY_CONFIG.budgetPerWindow - state.totalSpent;
  orderSize = Math.min(orderSize, remainingBudget);

  // Ensure minimum size
  if (orderSize < STRATEGY_CONFIG.minOrderSize) {
    return null; // Not enough budget for minimum order
  }

  return {
    side: momentum.direction,
    size: orderSize,
    confidence: momentum.confidence,
    momentum: momentum.momentum,
    reasoning: [
      `Short-term momentum: ${momentum.momentum.toFixed(2)}% (${momentum.direction === 'YES' ? 'UP' : 'DOWN'})`,
      `Order ${state.ordersPlaced + 1}/${STRATEGY_CONFIG.maxOrdersPerWindow}`,
      `Spent: $${state.totalSpent.toFixed(2)}/$${STRATEGY_CONFIG.budgetPerWindow}`,
      `Confidence: ${(momentum.confidence * 100).toFixed(0)}%`,
      `Size: $${orderSize.toFixed(2)}`
    ]
  };
}

/**
 * Record that an order was placed
 * @param {string} windowSlug Window identifier
 * @param {Object} order Order details
 */
function recordOrder(windowSlug, order) {
  if (!WINDOW_STATE[windowSlug]) {
    WINDOW_STATE[windowSlug] = {
      direction: null,
      ordersPlaced: 0,
      totalSpent: 0,
      lastOrderTime: 0,
      orders: []
    };
  }

  const state = WINDOW_STATE[windowSlug];

  // Set direction on first order
  if (!state.direction) {
    state.direction = order.side;
  }

  state.ordersPlaced++;
  state.totalSpent += order.size;
  state.lastOrderTime = Date.now();
  state.orders.push({
    side: order.side,
    size: order.size,
    confidence: order.confidence,
    timestamp: Date.now()
  });

  console.log(JSON.stringify({
    action: 'MOMENTUM_ORDER_RECORDED',
    window: windowSlug,
    orderNumber: state.ordersPlaced,
    totalOrders: STRATEGY_CONFIG.maxOrdersPerWindow,
    spent: state.totalSpent.toFixed(2),
    budget: STRATEGY_CONFIG.budgetPerWindow,
    remaining: (STRATEGY_CONFIG.budgetPerWindow - state.totalSpent).toFixed(2)
  }));
}

/**
 * Get current window state
 * @param {string} windowSlug Window identifier
 * @returns {Object} Window state
 */
function getWindowState(windowSlug) {
  return WINDOW_STATE[windowSlug] || {
    direction: null,
    ordersPlaced: 0,
    totalSpent: 0,
    lastOrderTime: 0,
    orders: []
  };
}

/**
 * Clean up old window states (keep last 10 windows)
 */
function cleanupOldWindows() {
  const windows = Object.keys(WINDOW_STATE);
  if (windows.length > 10) {
    // Sort by window slug (timestamp-based)
    windows.sort();
    // Remove oldest windows
    const toRemove = windows.slice(0, windows.length - 10);
    toRemove.forEach(w => delete WINDOW_STATE[w]);
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  STRATEGY_CONFIG,
  calculateShortTermMomentum,
  calculateOrderSize,
  shouldPlaceOrder,
  recordOrder,
  getWindowState,
  cleanupOldWindows
};
