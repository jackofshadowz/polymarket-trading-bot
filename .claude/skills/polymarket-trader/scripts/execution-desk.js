/**
 * EXECUTION DESK - Order Execution Module
 *
 * The 8th player in the trading system. Handles all order execution via pmarket-cli.
 *
 * Responsibilities:
 * 1. Take approved trades from Supervisor
 * 2. Build and execute pmarket-cli commands
 * 3. Parse CLI output (strip ASCII art, extract JSON)
 * 4. Handle retries and errors
 * 5. Report fills back to position tracker
 */

const { execSync, spawn } = require('child_process');
const https = require('https');

// ============================================================
// SHADOW MODE - Simulation Bridge Integration
// Set SHADOW_MODE=true to test without real money
// ============================================================
const simulationBridge = require('./simulation-bridge');
const SHADOW_MODE = process.env.SHADOW_MODE === 'true';

// Global window context for shadow mode (set by main bot)
let CURRENT_WINDOW_CONTEXT = {
  slug: 'unknown',
  btcOpenPrice: 0,
  desk: 'UNKNOWN'
};

/**
 * Set the current window context for shadow mode trades
 * Call this at the start of each window in the main bot
 */
function setWindowContext(slug, btcOpenPrice, desk = 'UNKNOWN') {
  CURRENT_WINDOW_CONTEXT = { slug, btcOpenPrice, desk };
  if (SHADOW_MODE) {
    console.log(JSON.stringify({
      action: 'SHADOW_WINDOW_CONTEXT_SET',
      slug: slug,
      btcOpenPrice: btcOpenPrice?.toFixed(2) || '0',
      desk: desk,
      timestamp: new Date().toISOString()
    }));
  }
}

/**
 * Get current window context
 */
function getWindowContext() {
  return CURRENT_WINDOW_CONTEXT;
}

// ============================================================
// POST-TRADE VERIFICATION CONFIG (Gemini Recommended)
// ============================================================
const VERIFICATION_CONFIG = {
  enabled: true,
  maxRetries: 3,
  retryDelayMs: 1000,  // Initial delay, doubles each retry
  apiBaseUrl: 'https://clob.polymarket.com',
  tolerance: 0.01,  // 1 cent tolerance for float precision
  timeoutMs: 10000
};

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

// ASCII art pattern to strip from pmarket-cli output
const ASCII_ART_PATTERN = /\s*_\s*_\s*_\s*_\s*_\s*_\s*_\s*_\s*\n.*pmarket.*cli.*\n.*\n.*\n.*\n.*\|_\|.*/s;

/**
 * Convert JavaScript object notation to valid JSON
 * pmarket-cli outputs JS objects (unquoted keys) not JSON
 * Also handles Node.js array truncation ("... N more items")
 */
function jsObjectToJSON(str) {
  return str
    // Remove Node.js array truncation (... N more items)
    .replace(/,?\s*\.\.\.\s*\d+\s*more\s*items?\s*/gi, '')
    // Add quotes around unquoted keys (word followed by colon after { or ,)
    .replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)\s*:/g, '$1"$2":')
    // Convert single-quoted strings to double-quoted
    .replace(/'([^'\\]*(\\.[^'\\]*)*)'/g, '"$1"');
}

/**
 * Parse pmarket-cli output, stripping ASCII banner and extracting JSON
 */
function parseCLIOutput(output) {
  if (!output) return { success: false, error: 'No output' };

  // Strip ASCII art banner - find where data starts
  let cleanOutput = output;

  // Find where the JSON/JS object starts (first '{' character)
  const jsonStart = output.indexOf('{');
  if (jsonStart > 0) {
    cleanOutput = output.substring(jsonStart);
  }

  // Try to parse multiple JSON objects (orderbook + order result)
  const results = {
    orderbook: null,
    orderDetails: null,
    orderResult: null,
    raw: output
  };

  try {
    // Split by newlines and find JSON objects
    const lines = cleanOutput.split('\n');
    let currentJson = '';
    let braceCount = 0;
    let bracketCount = 0;
    let inObject = false;

    for (const line of lines) {
      // Skip non-object lines
      if (!inObject && !line.trim().startsWith('{')) {
        continue;
      }

      currentJson += line + '\n';
      braceCount += (line.match(/{/g) || []).length;
      braceCount -= (line.match(/}/g) || []).length;
      bracketCount += (line.match(/\[/g) || []).length;
      bracketCount -= (line.match(/\]/g) || []).length;
      inObject = braceCount > 0 || bracketCount > 0;

      if (braceCount === 0 && bracketCount === 0 && currentJson.trim()) {
        try {
          // First try direct JSON parse
          let parsed;
          try {
            parsed = JSON.parse(currentJson.trim());
          } catch (jsonError) {
            // Convert JS object notation to JSON
            const jsonStr = jsObjectToJSON(currentJson.trim());
            parsed = JSON.parse(jsonStr);
          }

          // Categorize the parsed object
          if (parsed.bids && parsed.asks) {
            results.orderbook = parsed;
          } else if (parsed.salt && parsed.maker) {
            results.orderDetails = parsed;
          } else if (parsed.orderID || parsed.success !== undefined || parsed.error) {
            results.orderResult = parsed;
          }
        } catch (e) {
          // Not valid JSON/JS object, skip
        }
        currentJson = '';
      }
    }
  } catch (e) {
    results.parseError = e.message;
  }

  return results;
}

// ============================================================
// POST-TRADE VERIFICATION (Gemini Recommended Strategy)
// Verifies actual fill data from Polymarket API after each trade
// ============================================================

/**
 * Make an HTTPS GET request to Polymarket CLOB API
 * @param {string} path - API path (e.g., '/orders/0x123...')
 * @returns {Promise<object>} Parsed JSON response
 */
function apiRequest(path) {
  return new Promise((resolve, reject) => {
    const url = `${VERIFICATION_CONFIG.apiBaseUrl}${path}`;

    const req = https.get(url, {
      timeout: VERIFICATION_CONFIG.timeoutMs,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'polymarket-trader-bot/1.0'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else if (res.statusCode === 404) {
            reject(new Error('ORDER_NOT_FOUND'));
          } else {
            reject(new Error(`API_ERROR_${res.statusCode}`));
          }
        } catch (e) {
          reject(new Error('JSON_PARSE_ERROR: ' + e.message));
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('REQUEST_TIMEOUT'));
    });
  });
}

/**
 * Delay helper for retry backoff
 */
function delay(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait for sync */ }
}

/**
 * Verify a completed trade against Polymarket API
 * This ensures our virtual accounts match actual fill data
 *
 * @param {string} orderId - The order ID from pmarket-cli
 * @param {object} reportedFill - What pmarket-cli reported { shares, cost, avgPrice }
 * @param {number} retryCount - Current retry attempt
 * @returns {object} Verified fill data or error
 */
async function verifyTrade(orderId, reportedFill, retryCount = 0) {
  if (!VERIFICATION_CONFIG.enabled) {
    return { verified: false, skipped: true, reason: 'VERIFICATION_DISABLED' };
  }

  if (!orderId) {
    return { verified: false, error: 'NO_ORDER_ID' };
  }

  console.log(JSON.stringify({
    action: 'TRADE_VERIFICATION_START',
    orderId: maskId(orderId),
    reportedShares: reportedFill.shares?.toFixed(2),
    reportedCost: reportedFill.cost?.toFixed(4),
    attempt: retryCount + 1,
    timestamp: new Date().toISOString()
  }));

  try {
    // Query the order details from Polymarket API
    const orderData = await apiRequest(`/order/${orderId}`);

    // Check order status
    if (!['MATCHED', 'FILLED', 'matched', 'filled'].includes(orderData.status?.toUpperCase())) {
      if (['OPEN', 'LIVE', 'open', 'live'].includes(orderData.status?.toLowerCase())) {
        // Order still open, retry after delay
        if (retryCount < VERIFICATION_CONFIG.maxRetries) {
          const delayMs = VERIFICATION_CONFIG.retryDelayMs * Math.pow(2, retryCount);
          console.log(JSON.stringify({
            action: 'TRADE_VERIFICATION_RETRY',
            reason: 'Order still open',
            status: orderData.status,
            retryIn: delayMs + 'ms',
            attempt: retryCount + 1,
            timestamp: new Date().toISOString()
          }));
          delay(delayMs);
          return verifyTrade(orderId, reportedFill, retryCount + 1);
        }
      }

      return {
        verified: false,
        error: 'ORDER_NOT_FILLED',
        status: orderData.status
      };
    }

    // Extract actual fill data
    let actualShares = 0;
    let actualCost = 0;

    // Try different field names (API response varies)
    if (orderData.size_matched) {
      actualShares = parseFloat(orderData.size_matched);
    } else if (orderData.filledSize) {
      actualShares = parseFloat(orderData.filledSize);
    } else if (orderData.takingAmount) {
      actualShares = parseFloat(orderData.takingAmount);
    }

    if (orderData.price && actualShares > 0) {
      actualCost = actualShares * parseFloat(orderData.price);
    } else if (orderData.makingAmount) {
      actualCost = parseFloat(orderData.makingAmount);
    } else if (orderData.totalCost) {
      actualCost = parseFloat(orderData.totalCost);
    }

    // Calculate average price
    const actualAvgPrice = actualShares > 0 ? actualCost / actualShares : 0;

    // Compare with reported values
    const sharesDiff = Math.abs((reportedFill.shares || 0) - actualShares);
    const costDiff = Math.abs((reportedFill.cost || 0) - actualCost);

    const sharesMatch = sharesDiff <= VERIFICATION_CONFIG.tolerance;
    const costMatch = costDiff <= VERIFICATION_CONFIG.tolerance;

    if (sharesMatch && costMatch) {
      console.log(JSON.stringify({
        action: 'TRADE_VERIFICATION_SUCCESS',
        orderId: maskId(orderId),
        actualShares: actualShares.toFixed(2),
        actualCost: actualCost.toFixed(4),
        actualAvgPrice: actualAvgPrice.toFixed(4),
        status: 'MATCHED',
        timestamp: new Date().toISOString()
      }));

      return {
        verified: true,
        matches: true,
        shares: actualShares,
        cost: actualCost,
        avgPrice: actualAvgPrice,
        status: orderData.status
      };
    } else {
      // DISCREPANCY DETECTED - This is critical!
      console.log(JSON.stringify({
        action: 'TRADE_VERIFICATION_DISCREPANCY',
        orderId: maskId(orderId),
        reportedShares: reportedFill.shares?.toFixed(2),
        actualShares: actualShares.toFixed(2),
        sharesDiff: sharesDiff.toFixed(4),
        reportedCost: reportedFill.cost?.toFixed(4),
        actualCost: actualCost.toFixed(4),
        costDiff: costDiff.toFixed(4),
        USING_ACTUAL: true,
        timestamp: new Date().toISOString()
      }));

      // Return ACTUAL values (not reported) - this fixes the virtual account sync!
      return {
        verified: true,
        matches: false,
        discrepancy: {
          reportedShares: reportedFill.shares,
          actualShares: actualShares,
          reportedCost: reportedFill.cost,
          actualCost: actualCost
        },
        // Use actual values for position tracking
        shares: actualShares,
        cost: actualCost,
        avgPrice: actualAvgPrice,
        status: orderData.status
      };
    }

  } catch (error) {
    console.log(JSON.stringify({
      action: 'TRADE_VERIFICATION_ERROR',
      orderId: maskId(orderId),
      error: error.message,
      attempt: retryCount + 1,
      timestamp: new Date().toISOString()
    }));

    // Retry on transient errors
    if (retryCount < VERIFICATION_CONFIG.maxRetries &&
        !error.message.includes('ORDER_NOT_FOUND')) {
      const delayMs = VERIFICATION_CONFIG.retryDelayMs * Math.pow(2, retryCount);
      delay(delayMs);
      return verifyTrade(orderId, reportedFill, retryCount + 1);
    }

    return {
      verified: false,
      error: error.message,
      fallbackToReported: true,
      shares: reportedFill.shares,
      cost: reportedFill.cost,
      avgPrice: reportedFill.avgPrice
    };
  }
}

/**
 * Synchronous wrapper for verifyTrade (for use in sync code paths)
 */
function verifyTradeSync(orderId, reportedFill) {
  // Since we're in a sync context, we use a blocking approach
  // This is acceptable because verification happens right after the trade

  try {
    const { execSync } = require('child_process');

    // Use curl to make the API request synchronously
    const curlCmd = `curl -s -m 10 "${VERIFICATION_CONFIG.apiBaseUrl}/order/${orderId}"`;
    const result = execSync(curlCmd, { encoding: 'utf8', timeout: 15000 });

    const orderData = JSON.parse(result);

    // Extract actual fill data
    let actualShares = parseFloat(orderData.size_matched || orderData.filledSize || orderData.takingAmount || 0);
    let actualCost = 0;

    if (orderData.price && actualShares > 0) {
      actualCost = actualShares * parseFloat(orderData.price);
    } else {
      actualCost = parseFloat(orderData.makingAmount || orderData.totalCost || 0);
    }

    const actualAvgPrice = actualShares > 0 ? actualCost / actualShares : 0;

    // Check for discrepancy
    const sharesDiff = Math.abs((reportedFill.shares || 0) - actualShares);
    const costDiff = Math.abs((reportedFill.cost || 0) - actualCost);

    if (sharesDiff > VERIFICATION_CONFIG.tolerance || costDiff > VERIFICATION_CONFIG.tolerance) {
      console.log(JSON.stringify({
        action: 'TRADE_VERIFICATION_DISCREPANCY',
        orderId: maskId(orderId),
        reportedShares: reportedFill.shares?.toFixed(2),
        actualShares: actualShares.toFixed(2),
        reportedCost: reportedFill.cost?.toFixed(4),
        actualCost: actualCost.toFixed(4),
        USING_ACTUAL: true,
        timestamp: new Date().toISOString()
      }));
    } else {
      console.log(JSON.stringify({
        action: 'TRADE_VERIFICATION_SUCCESS',
        orderId: maskId(orderId),
        actualShares: actualShares.toFixed(2),
        actualCost: actualCost.toFixed(4),
        timestamp: new Date().toISOString()
      }));
    }

    return {
      verified: true,
      shares: actualShares || reportedFill.shares,
      cost: actualCost || reportedFill.cost,
      avgPrice: actualAvgPrice || reportedFill.avgPrice
    };

  } catch (error) {
    console.log(JSON.stringify({
      action: 'TRADE_VERIFICATION_FAILED',
      orderId: maskId(orderId),
      error: error.message,
      fallbackToReported: true,
      timestamp: new Date().toISOString()
    }));

    // Fall back to reported values if verification fails
    return {
      verified: false,
      error: error.message,
      shares: reportedFill.shares,
      cost: reportedFill.cost,
      avgPrice: reportedFill.avgPrice
    };
  }
}

/**
 * Execute a pmarket-cli command with timeout and error handling
 */
function runPmarketCLI(args, timeoutMs = 60000) {
  const startTime = Date.now();

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_CLI_START',
    command: `pmarket-cli ${args}`,
    timestamp: new Date().toISOString()
  }));

  try {
    const output = execSync(`pmarket-cli ${args}`, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024 // 10MB buffer
    });

    const duration = Date.now() - startTime;
    const parsed = parseCLIOutput(output);

    console.log(JSON.stringify({
      action: 'EXECUTION_DESK_CLI_COMPLETE',
      durationMs: duration,
      hasOrderbook: !!parsed.orderbook,
      hasOrderResult: !!parsed.orderResult,
      success: parsed.orderResult?.success || false,
      timestamp: new Date().toISOString()
    }));

    return {
      success: true,
      output: output,
      parsed: parsed,
      durationMs: duration
    };

  } catch (error) {
    const duration = Date.now() - startTime;

    console.log(JSON.stringify({
      action: 'EXECUTION_DESK_CLI_ERROR',
      error: error.message,
      durationMs: duration,
      timestamp: new Date().toISOString()
    }));

    // Try to parse any output from the error
    const errorOutput = error.stdout || error.stderr || '';
    const parsed = parseCLIOutput(errorOutput);

    return {
      success: false,
      error: error.message,
      output: errorOutput,
      parsed: parsed,
      durationMs: duration
    };
  }
}

/**
 * Get current orderbook for a token
 */
function getOrderbook(tokenId) {
  const result = runPmarketCLI(`-o ${tokenId}`);

  if (result.success && result.parsed.orderbook) {
    const book = result.parsed.orderbook;

    // Extract best bid/ask
    const bestBid = book.bids && book.bids.length > 0
      ? parseFloat(book.bids[book.bids.length - 1].price)
      : 0;
    const bestAsk = book.asks && book.asks.length > 0
      ? parseFloat(book.asks[book.asks.length - 1].price)
      : 1;
    const midpoint = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const lastTrade = book.last_trade_price ? parseFloat(book.last_trade_price) : midpoint;

    return {
      success: true,
      tokenId: tokenId,
      bestBid: bestBid,
      bestAsk: bestAsk,
      midpoint: midpoint,
      spread: spread,
      lastTrade: lastTrade,
      bidDepth: book.bids ? book.bids.length : 0,
      askDepth: book.asks ? book.asks.length : 0,
      raw: book
    };
  }

  return {
    success: false,
    error: result.error || 'Failed to get orderbook',
    tokenId: tokenId
  };
}

/**
 * Place a BUY order
 * @param {string} tokenId - The token to buy
 * @param {number} amountUSDC - Amount in USDC to spend
 * @param {number} price - Limit price (0-1)
 * @param {object} options - Additional options
 */
function placeBuyOrder(tokenId, amountUSDC, price, options = {}) {
  const { maxRetries = 2, retryDelayMs = 2000 } = options;

  // ═══════════════════════════════════════════════════════════════════
  // SHADOW MODE: Intercept and simulate execution
  // ═══════════════════════════════════════════════════════════════════
  if (SHADOW_MODE) {
    console.log(JSON.stringify({
      action: 'SHADOW_MODE_INTERCEPT',
      type: 'BUY',
      tokenId: maskId(tokenId),
      amount: amountUSDC.toFixed(2),
      price: price.toFixed(4),
      timestamp: new Date().toISOString()
    }));

    // Use provided options or fall back to global window context
    const ctx = CURRENT_WINDOW_CONTEXT;
    const shadowResult = simulationBridge.mockExecution(
      tokenId,
      amountUSDC,
      price,
      options.side || 'YES',
      options.windowSlug || ctx.slug || 'unknown',
      options.btcOpenPrice || ctx.btcOpenPrice || 0,
      options.desk || ctx.desk || 'UNKNOWN'
    );

    if (shadowResult.success) {
      return {
        success: true,
        orderID: shadowResult.orderID,
        status: shadowResult.status,
        sharesReceived: parseFloat(shadowResult.takingAmount),
        costUSDC: parseFloat(shadowResult.makingAmount),
        avgFillPrice: shadowResult.avgPrice,
        txHash: shadowResult.transactionHash,
        _shadow: true
      };
    } else {
      return {
        success: false,
        error: shadowResult.error,
        _shadow: true
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // MINIMUM SHARE ENFORCEMENT: Polymarket requires minimum 5 shares
  // If amountUSDC/price < 5, bump up the amount to ensure 5 shares
  // BUT: Only boost up to 20% - beyond that, skip the trade entirely
  // ═══════════════════════════════════════════════════════════════════
  const MIN_SHARES = 5.1;  // Use 5.1 to stay safely above limit
  const MAX_BOOST_RATIO = 1.20;  // Maximum 20% over-leverage tolerance
  const impliedShares = amountUSDC / price;

  if (impliedShares < MIN_SHARES) {
    const requiredAmount = MIN_SHARES * price * 1.02; // Add 2% buffer for rounding
    const boostRatio = requiredAmount / amountUSDC;

    // Check if boost is within tolerance
    if (boostRatio <= MAX_BOOST_RATIO) {
      // FIX #11: Validate boosted amount doesn't exceed available capital
      if (options.availableCapital !== undefined && requiredAmount > options.availableCapital) {
        console.log(JSON.stringify({
          action: 'BOOST_EXCEEDS_CAPITAL',
          requested: amountUSDC.toFixed(2),
          boosted: requiredAmount.toFixed(2),
          available: options.availableCapital.toFixed(2),
          timestamp: new Date().toISOString()
        }));
        return {
          success: false,
          error: 'BOOST_EXCEEDS_CAPITAL',
          reason: `Boosted amount $${requiredAmount.toFixed(2)} exceeds available $${options.availableCapital.toFixed(2)}`
        };
      }

      console.log(JSON.stringify({
        action: 'EXECUTION_DESK_MIN_SHARE_ADJUSTMENT',
        originalAmount: amountUSDC.toFixed(2),
        adjustedAmount: requiredAmount.toFixed(2),
        impliedShares: impliedShares.toFixed(1),
        boostPercent: ((boostRatio - 1) * 100).toFixed(0) + '%',
        price: price.toFixed(4),
        reason: 'Bumped to ensure 5 minimum shares (within 20% tolerance)',
        timestamp: new Date().toISOString()
      }));
      amountUSDC = requiredAmount;
    } else {
      // Boost too large - skip the trade entirely
      console.log(JSON.stringify({
        action: 'EXECUTION_DESK_ORDER_SKIPPED',
        originalAmount: amountUSDC.toFixed(2),
        requiredAmount: requiredAmount.toFixed(2),
        impliedShares: impliedShares.toFixed(1),
        boostPercent: ((boostRatio - 1) * 100).toFixed(0) + '%',
        price: price.toFixed(4),
        reason: 'Order too small - would require >' + ((MAX_BOOST_RATIO - 1) * 100) + '% boost',
        timestamp: new Date().toISOString()
      }));
      return {
        success: false,
        error: 'UNDER_MIN_SHARES',
        reason: `Order requires ${impliedShares.toFixed(1)} shares but minimum is 5. Boost of ${((boostRatio - 1) * 100).toFixed(0)}% exceeds 20% tolerance.`
      };
    }
  }

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_BUY_ORDER',
    tokenId: maskId(tokenId),
    amountUSDC: amountUSDC.toFixed(2),
    price: price.toFixed(4),
    timestamp: new Date().toISOString()
  }));

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = runPmarketCLI(`-b ${tokenId} ${amountUSDC.toFixed(2)} ${price.toFixed(4)}`);

    if (result.parsed.orderResult) {
      const orderResult = result.parsed.orderResult;

      if (orderResult.success) {
        // FIX: Calculate actual cost with proper fallback (prevents cost basis mismatch)
        let actualCost = amountUSDC;  // Default to intended
        if (orderResult.makingAmount) {
          actualCost = parseFloat(orderResult.makingAmount);
        } else if (orderResult.totalCost) {
          actualCost = parseFloat(orderResult.totalCost);
        } else {
          // Log when using fallback - this indicates potential slippage hiding
          console.log(JSON.stringify({
            action: 'COST_BASIS_FALLBACK',
            intended: amountUSDC.toFixed(4),
            usingFallback: true,
            reason: 'API returned null makingAmount',
            timestamp: new Date().toISOString()
          }));
        }

        const fillResult = {
          success: orderResult.status === 'matched', // Only success if actually filled!
          orderID: orderResult.orderID,
          status: orderResult.status,
          sharesReceived: parseFloat(orderResult.takingAmount) || 0,
          costUSDC: Math.max(actualCost, amountUSDC),  // Never undercount cost
          avgFillPrice: 0,
          txHash: orderResult.transactionsHashes?.[0] || null,
          attempt: attempt
        };

        // Calculate average fill price
        if (fillResult.sharesReceived > 0) {
          fillResult.avgFillPrice = fillResult.costUSDC / fillResult.sharesReceived;
        }

        // Log slippage for analysis (comparing actual vs intended cost)
        if (fillResult.costUSDC > amountUSDC) {
          console.log(JSON.stringify({
            action: 'SLIPPAGE_DETECTED',
            intended: amountUSDC.toFixed(4),
            actual: fillResult.costUSDC.toFixed(4),
            premium: (fillResult.costUSDC - amountUSDC).toFixed(4),
            premiumPct: (((fillResult.costUSDC / amountUSDC) - 1) * 100).toFixed(2) + '%',
            timestamp: new Date().toISOString()
          }));
        }

        // Only count as success if order was actually matched/filled
        if (orderResult.status === 'matched') {
          console.log(JSON.stringify({
            action: 'EXECUTION_DESK_BUY_SUCCESS',
            orderID: fillResult.orderID,
            shares: fillResult.sharesReceived,
            cost: fillResult.costUSDC.toFixed(2),
            avgPrice: fillResult.avgFillPrice.toFixed(4),
            status: fillResult.status,
            attempt: attempt,
            timestamp: new Date().toISOString()
          }));

          // POST-TRADE VERIFICATION: Verify against Polymarket API
          // This ensures virtual accounts match actual fill data
          if (VERIFICATION_CONFIG.enabled && fillResult.orderID) {
            const verifyResult = verifyTradeSync(fillResult.orderID, {
              shares: fillResult.sharesReceived,
              cost: fillResult.costUSDC,
              avgPrice: fillResult.avgFillPrice
            });

            if (verifyResult.verified) {
              // Use verified values (corrects any discrepancy automatically)
              fillResult.sharesReceived = verifyResult.shares;
              fillResult.costUSDC = verifyResult.cost;
              fillResult.avgFillPrice = verifyResult.avgPrice;
              fillResult.verified = true;
            } else {
              fillResult.verified = false;
              fillResult.verificationError = verifyResult.error;
            }
          }

          return fillResult;
        } else {
          // Order went "live" but didn't fill - treat as failure and retry
          console.log(JSON.stringify({
            action: 'EXECUTION_DESK_BUY_UNFILLED',
            orderID: fillResult.orderID,
            status: fillResult.status,
            reason: 'Order placed but not matched - price too low',
            attempt: attempt,
            timestamp: new Date().toISOString()
          }));
          lastError = 'Order live but not filled - need higher price';
        }
      } else {
        lastError = orderResult.errorMsg || 'Order failed';
      }
    } else {
      lastError = result.error || 'No order result in response';
    }

    // Log retry
    if (attempt <= maxRetries) {
      console.log(JSON.stringify({
        action: 'EXECUTION_DESK_BUY_RETRY',
        attempt: attempt,
        maxRetries: maxRetries,
        error: lastError,
        retryingIn: retryDelayMs + 'ms',
        timestamp: new Date().toISOString()
      }));

      // Wait before retry
      const waitUntil = Date.now() + retryDelayMs;
      while (Date.now() < waitUntil) {
        // Busy wait (synchronous)
      }
    }
  }

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_BUY_FAILED',
    error: lastError,
    attempts: maxRetries + 1,
    timestamp: new Date().toISOString()
  }));

  return {
    success: false,
    error: lastError,
    attempts: maxRetries + 1
  };
}

/**
 * Place a SELL order
 * @param {string} tokenId - The token to sell
 * @param {number} shares - Number of shares to sell
 * @param {number} price - Limit price (0-1)
 * @param {object} options - Additional options
 */
function placeSellOrder(tokenId, shares, price, options = {}) {
  const { maxRetries = 2, retryDelayMs = 2000 } = options;

  // ═══════════════════════════════════════════════════════════════════
  // SHADOW MODE: Intercept and simulate sell execution
  // ═══════════════════════════════════════════════════════════════════
  if (SHADOW_MODE && options.positionId) {
    console.log(JSON.stringify({
      action: 'SHADOW_MODE_INTERCEPT',
      type: 'SELL',
      positionId: options.positionId,
      shares: shares,
      price: price.toFixed(4),
      timestamp: new Date().toISOString()
    }));

    const shadowResult = simulationBridge.mockSellExecution(options.positionId, price);

    if (shadowResult.success) {
      return {
        success: true,
        status: shadowResult.status,
        sharesSold: shares,
        proceedsUSDC: shadowResult.proceeds,
        avgFillPrice: price,
        pnl: shadowResult.pnl,
        _shadow: true
      };
    } else {
      return {
        success: false,
        error: shadowResult.error,
        _shadow: true
      };
    }
  }

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_SELL_ORDER',
    tokenId: maskId(tokenId),
    shares: shares,
    price: price.toFixed(4),
    timestamp: new Date().toISOString()
  }));

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const result = runPmarketCLI(`-s ${tokenId} ${shares} ${price.toFixed(4)}`);

    if (result.parsed.orderResult) {
      const orderResult = result.parsed.orderResult;

      if (orderResult.success) {
        const fillResult = {
          success: true,
          orderID: orderResult.orderID,
          status: orderResult.status,
          sharesSold: parseFloat(orderResult.takingAmount) || shares,
          proceedsUSDC: parseFloat(orderResult.makingAmount) || 0,
          avgFillPrice: 0,
          txHash: orderResult.transactionsHashes?.[0] || null,
          attempt: attempt
        };

        // Calculate average fill price
        if (fillResult.sharesSold > 0) {
          fillResult.avgFillPrice = fillResult.proceedsUSDC / fillResult.sharesSold;
        }

        console.log(JSON.stringify({
          action: 'EXECUTION_DESK_SELL_SUCCESS',
          orderID: fillResult.orderID,
          shares: fillResult.sharesSold,
          proceeds: fillResult.proceedsUSDC.toFixed(2),
          avgPrice: fillResult.avgFillPrice.toFixed(4),
          status: fillResult.status,
          attempt: attempt,
          timestamp: new Date().toISOString()
        }));

        return fillResult;
      } else {
        lastError = orderResult.errorMsg || 'Order failed';
      }
    } else {
      lastError = result.error || 'No order result in response';
    }

    // Log retry
    if (attempt <= maxRetries) {
      console.log(JSON.stringify({
        action: 'EXECUTION_DESK_SELL_RETRY',
        attempt: attempt,
        maxRetries: maxRetries,
        error: lastError,
        retryingIn: retryDelayMs + 'ms',
        timestamp: new Date().toISOString()
      }));

      // Wait before retry
      const waitUntil = Date.now() + retryDelayMs;
      while (Date.now() < waitUntil) {
        // Busy wait (synchronous)
      }
    }
  }

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_SELL_FAILED',
    error: lastError,
    attempts: maxRetries + 1,
    timestamp: new Date().toISOString()
  }));

  return {
    success: false,
    error: lastError,
    attempts: maxRetries + 1
  };
}

/**
 * Cancel all open orders
 */
function cancelAllOrders() {
  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_CANCEL_ALL',
    timestamp: new Date().toISOString()
  }));

  const result = runPmarketCLI('-c');

  return {
    success: result.success,
    output: result.output
  };
}

/**
 * Refresh API keys (call when getting 401 errors)
 */
function refreshAPIKeys() {
  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_REFRESH_KEYS',
    timestamp: new Date().toISOString()
  }));

  const result = runPmarketCLI('-k');

  if (result.success && result.parsed.orderResult) {
    // The -k command returns the new keys as JSON
    const keys = result.parsed.orderResult;

    if (keys.key && keys.secret && keys.passphrase) {
      // Update config file
      const fs = require('fs');
      const path = require('path');
      const configPath = path.join(process.env.HOME, '.pmarket-cli', 'config.json');

      try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.apiKey = keys.key;
        config.apiSecret = keys.secret;
        config.passphrase = keys.passphrase;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        console.log(JSON.stringify({
          action: 'EXECUTION_DESK_KEYS_REFRESHED',
          newKeyPrefix: keys.key.substring(0, 8) + '...',
          timestamp: new Date().toISOString()
        }));

        return { success: true, newKey: keys.key };
      } catch (e) {
        return { success: false, error: 'Failed to update config: ' + e.message };
      }
    }
  }

  return { success: false, error: 'Failed to get new keys' };
}

/**
 * Execute a trade from the Supervisor's approved plan
 * This is the main entry point for the trading system
 *
 * @param {object} trade - Approved trade from Supervisor
 * @param {string} trade.desk - Which desk approved (FARM or DEGEN)
 * @param {string} trade.side - YES or NO
 * @param {number} trade.amount - Amount in USDC
 * @param {number} trade.maxPrice - Maximum price to pay
 * @param {string} trade.tokenId - Token ID to trade
 * @param {object} market - Current market data
 */
function executeApprovedTrade(trade, market) {
  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_EXECUTING_TRADE',
    desk: trade.desk,
    side: trade.side,
    amount: trade.amount.toFixed(2),
    maxPrice: trade.maxPrice.toFixed(4),
    timestamp: new Date().toISOString()
  }));

  // FIX #1: Ensure we query the correct orderbook for the side we're trading
  // Each outcome (YES/NO) has its own token with its own orderbook
  const correctTokenId = trade.side === 'YES'
    ? (market.yesTokenId || trade.tokenId)
    : (market.noTokenId || trade.tokenId);

  // Validate token ID matches expected
  if (correctTokenId !== trade.tokenId && market.yesTokenId && market.noTokenId) {
    console.warn(JSON.stringify({
      action: 'TOKEN_ID_MISMATCH',
      providedTokenId: trade.tokenId?.substring(0, 20) + '...',
      expectedTokenId: correctTokenId?.substring(0, 20) + '...',
      side: trade.side,
      usingCorrect: true,
      timestamp: new Date().toISOString()
    }));
  }

  const orderbook = getOrderbook(correctTokenId);

  if (!orderbook.success) {
    return {
      success: false,
      error: 'Failed to get orderbook: ' + orderbook.error,
      desk: trade.desk
    };
  }

  // bestAsk is correct for buying (we pay the ask price to acquire tokens)
  const currentPrice = orderbook.bestAsk;

  if (currentPrice > trade.maxPrice) {
    console.log(JSON.stringify({
      action: 'EXECUTION_DESK_PRICE_TOO_HIGH',
      currentPrice: currentPrice.toFixed(4),
      maxPrice: trade.maxPrice.toFixed(4),
      decision: 'SKIP',
      timestamp: new Date().toISOString()
    }));

    return {
      success: false,
      error: 'Price moved above max',
      currentPrice: currentPrice,
      maxPrice: trade.maxPrice,
      desk: trade.desk
    };
  }

  // Execute the buy order - USE correctTokenId (not trade.tokenId!)
  // Pass shadow mode options for simulation bridge
  const result = placeBuyOrder(correctTokenId, trade.amount, trade.maxPrice, {
    side: trade.side,
    windowSlug: trade.windowSlug || market.slug,
    btcOpenPrice: trade.btcOpenPrice || market.btcPrice || 0,
    desk: trade.desk,
    availableCapital: trade.availableCapital
  });

  if (result.success) {
    return {
      success: true,
      desk: trade.desk,
      side: trade.side,
      sharesReceived: result.sharesReceived,
      costUSDC: result.costUSDC,
      avgFillPrice: result.avgFillPrice,
      orderID: result.orderID,
      txHash: result.txHash
    };
  } else {
    // Check if it's an auth error and try refreshing keys
    if (result.error && result.error.includes('401')) {
      console.log(JSON.stringify({
        action: 'EXECUTION_DESK_AUTH_ERROR',
        error: result.error,
        action: 'REFRESHING_KEYS',
        timestamp: new Date().toISOString()
      }));

      const keyRefresh = refreshAPIKeys();

      if (keyRefresh.success) {
        // Retry the order with new keys - USE correctTokenId (not trade.tokenId!)
        const retryResult = placeBuyOrder(correctTokenId, trade.amount, trade.maxPrice, {
          side: trade.side,
          windowSlug: trade.windowSlug || market.slug,
          btcOpenPrice: trade.btcOpenPrice || market.btcPrice || 0,
          desk: trade.desk,
          availableCapital: trade.availableCapital
        });

        if (retryResult.success) {
          return {
            success: true,
            desk: trade.desk,
            side: trade.side,
            sharesReceived: retryResult.sharesReceived,
            costUSDC: retryResult.costUSDC,
            avgFillPrice: retryResult.avgFillPrice,
            orderID: retryResult.orderID,
            txHash: retryResult.txHash,
            keysRefreshed: true
          };
        }
      }
    }

    return {
      success: false,
      error: result.error,
      desk: trade.desk,
      attempts: result.attempts
    };
  }
}

// ============================================================
// ORDER LIFECYCLE MANAGEMENT - Track and auto-flip orders
// ============================================================

// Active orders we're watching
const activeFlipOrders = new Map(); // orderId -> { tokenId, entryPrice, shares, targetPrice, status }

/**
 * Place a dip buy order and set up auto-flip monitoring
 * When the buy fills, automatically post a sell at target price
 *
 * @param {string} tokenId - Token to buy
 * @param {number} buyPrice - Price to bid at (e.g., 0.47)
 * @param {number} targetSellPrice - Price to sell at (e.g., 0.75)
 * @param {number} amountUSDC - Amount to spend
 */
function placeDipBuyWithAutoFlip(tokenId, buyPrice, targetSellPrice, amountUSDC) {
  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_DIP_BUY_INIT',
    tokenId: maskId(tokenId),
    buyPrice: buyPrice.toFixed(3),
    targetSellPrice: targetSellPrice.toFixed(3),
    amountUSDC: amountUSDC.toFixed(2),
    expectedProfit: ((targetSellPrice - buyPrice) * (amountUSDC / buyPrice)).toFixed(2),
    timestamp: new Date().toISOString()
  }));

  // Place the buy order
  const buyResult = placeBuyOrder(tokenId, amountUSDC, buyPrice);

  if (buyResult.success) {
    // Calculate shares received
    const shares = buyResult.sharesReceived || (amountUSDC / buyResult.avgFillPrice);

    // Track this order for auto-flip
    activeFlipOrders.set(buyResult.orderID, {
      tokenId: tokenId,
      entryPrice: buyResult.avgFillPrice,
      shares: shares,
      targetPrice: targetSellPrice,
      status: 'HOLDING',
      buyOrderID: buyResult.orderID,
      sellOrderID: null,
      createdAt: Date.now()
    });

    console.log(JSON.stringify({
      action: 'EXECUTION_DESK_DIP_BUY_FILLED',
      orderID: buyResult.orderID,
      entryPrice: buyResult.avgFillPrice.toFixed(3),
      shares: shares.toFixed(2),
      targetSellPrice: targetSellPrice.toFixed(3),
      potentialProfit: ((targetSellPrice - buyResult.avgFillPrice) * shares).toFixed(2),
      nextStep: 'MONITORING_FOR_AUTO_FLIP',
      timestamp: new Date().toISOString()
    }));

    return {
      success: true,
      orderID: buyResult.orderID,
      entryPrice: buyResult.avgFillPrice,
      shares: shares,
      targetSellPrice: targetSellPrice,
      status: 'HOLDING'
    };
  }

  return {
    success: false,
    error: buyResult.error
  };
}

/**
 * Execute the auto-flip: sell shares at target price
 * Called when price reaches target or on forced exit
 *
 * @param {string} orderId - Original buy order ID
 * @param {number} sellPrice - Price to sell at (optional, defaults to target)
 * @param {string} reason - Why we're flipping (TARGET_HIT, TIME_STOP, STOP_LOSS)
 */
function executeAutoFlip(orderId, sellPrice = null, reason = 'TARGET_HIT') {
  const order = activeFlipOrders.get(orderId);

  if (!order) {
    return { success: false, error: 'Order not found in flip tracking' };
  }

  if (order.status !== 'HOLDING') {
    return { success: false, error: 'Order already flipped or closed' };
  }

  const actualSellPrice = sellPrice || order.targetPrice;
  const profit = (actualSellPrice - order.entryPrice) * order.shares;
  const profitPct = ((actualSellPrice - order.entryPrice) / order.entryPrice) * 100;

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_AUTO_FLIP',
    reason: reason,
    buyOrderID: orderId,
    entryPrice: order.entryPrice.toFixed(3),
    sellPrice: actualSellPrice.toFixed(3),
    shares: order.shares.toFixed(2),
    profit: profit.toFixed(2),
    profitPct: profitPct.toFixed(1) + '%',
    timestamp: new Date().toISOString()
  }));

  // Place the sell order
  const sellResult = placeSellOrder(order.tokenId, order.shares, actualSellPrice);

  if (sellResult.success) {
    // Update tracking
    order.status = 'FLIPPED';
    order.sellOrderID = sellResult.orderID;
    order.sellPrice = sellResult.avgFillPrice;
    order.realizedProfit = (sellResult.avgFillPrice - order.entryPrice) * order.shares;
    order.flippedAt = Date.now();

    console.log(JSON.stringify({
      action: 'EXECUTION_DESK_FLIP_SUCCESS',
      buyOrderID: orderId,
      sellOrderID: sellResult.orderID,
      entryPrice: order.entryPrice.toFixed(3),
      exitPrice: sellResult.avgFillPrice.toFixed(3),
      shares: order.shares.toFixed(2),
      realizedProfit: order.realizedProfit.toFixed(2),
      profitPct: ((sellResult.avgFillPrice - order.entryPrice) / order.entryPrice * 100).toFixed(1) + '%',
      holdTimeMs: order.flippedAt - order.createdAt,
      timestamp: new Date().toISOString()
    }));

    return {
      success: true,
      sellOrderID: sellResult.orderID,
      exitPrice: sellResult.avgFillPrice,
      profit: order.realizedProfit,
      profitPct: (sellResult.avgFillPrice - order.entryPrice) / order.entryPrice * 100
    };
  }

  return {
    success: false,
    error: sellResult.error
  };
}

/**
 * Check all active flip orders and trigger sells at target
 * Call this periodically from main loop
 *
 * @param {Object} currentPrices - { yesPrice, noPrice }
 */
function checkAutoFlips(currentPrices) {
  const triggered = [];

  for (const [orderId, order] of activeFlipOrders.entries()) {
    if (order.status !== 'HOLDING') continue;

    // Determine current price (assume YES tokens for now)
    const currentPrice = currentPrices.yesPrice; // TODO: track which side

    // Check if target hit
    if (currentPrice >= order.targetPrice) {
      console.log(JSON.stringify({
        action: 'EXECUTION_DESK_TARGET_HIT',
        orderID: orderId,
        targetPrice: order.targetPrice.toFixed(3),
        currentPrice: currentPrice.toFixed(3),
        triggering: 'AUTO_FLIP',
        timestamp: new Date().toISOString()
      }));

      const flipResult = executeAutoFlip(orderId, currentPrice, 'TARGET_HIT');
      triggered.push({ orderId, result: flipResult });
    }
  }

  return triggered;
}

/**
 * Get all active flip orders (for monitoring)
 */
function getActiveFlipOrders() {
  const orders = [];
  for (const [orderId, order] of activeFlipOrders.entries()) {
    orders.push({ orderId, ...order });
  }
  return orders;
}

/**
 * Check if there's an active dip buy for a token
 */
function hasActiveDipBuy(tokenId = null) {
  for (const [orderId, order] of activeFlipOrders.entries()) {
    if (order.status === 'HOLDING') {
      if (!tokenId || order.tokenId === tokenId) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Emergency: Cancel all buy orders (for market crash)
 */
function emergencyCancelAllBuys() {
  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_EMERGENCY_CANCEL',
    reason: 'Market crash detected - cancelling all bids',
    timestamp: new Date().toISOString()
  }));

  const result = cancelAllOrders();

  // Mark all holding orders as cancelled
  for (const [orderId, order] of activeFlipOrders.entries()) {
    if (order.status === 'HOLDING') {
      order.status = 'EMERGENCY_CANCELLED';
    }
  }

  return result;
}

/**
 * Emergency: Dump all bags at market price (panic sell)
 */
function emergencyPanicSell() {
  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_PANIC_SELL',
    reason: 'Emergency dump - selling all positions at market',
    timestamp: new Date().toISOString()
  }));

  const results = [];

  for (const [orderId, order] of activeFlipOrders.entries()) {
    if (order.status === 'HOLDING') {
      // Sell at 0.01 to ensure fill (market dump)
      const result = executeAutoFlip(orderId, 0.01, 'PANIC_SELL');
      results.push({ orderId, result });
    }
  }

  return results;
}

// Export all functions
module.exports = {
  parseCLIOutput,
  runPmarketCLI,
  getOrderbook,
  placeBuyOrder,
  placeSellOrder,
  cancelAllOrders,
  refreshAPIKeys,
  executeApprovedTrade,
  // Auto-flip order management
  placeDipBuyWithAutoFlip,
  executeAutoFlip,
  checkAutoFlips,
  getActiveFlipOrders,
  hasActiveDipBuy,
  emergencyCancelAllBuys,
  emergencyPanicSell,
  // Post-trade verification (Gemini recommended)
  verifyTrade,
  verifyTradeSync,
  VERIFICATION_CONFIG,
  // Shadow mode (simulation bridge)
  isShadowMode: () => SHADOW_MODE,
  getShadowStatus: () => SHADOW_MODE ? simulationBridge.getStatus() : null,
  settleShadowWindow: (slug, btcPrice) => SHADOW_MODE ? simulationBridge.emulateSettlement(slug, btcPrice) : null,
  setWindowContext,
  getWindowContext,
  SHADOW_MODE
};

// Self-test if run directly
if (require.main === module) {
  console.log('=== EXECUTION DESK SELF-TEST ===\n');

  // Test 1: Parse sample output
  console.log('Test 1: Output parsing');
  const sampleOutput = `
                             _        _             _ _
  _ __  _ __ ___   __ _ _ __| | _____| |_       ___| (_)
 | '_ |\` _ \` _ \\ / _\` | '__| |/ / _ \\ __|____ / __| | |
 | |_) | | | | | | (_| | |  |   <  __/ ||_____| (__| | |
 | .__/|_| |_| |_|\\__,_|_|  |_|\\_\\___|\\__|     \\___|_|_|
 |_|
{"bids":[{"price":"0.49","size":"100"}],"asks":[{"price":"0.51","size":"100"}]}
BUY
Amount of shares/tokens: 2
Price0.5
{"salt":"123","maker":"0x123"}
{"success":true,"orderID":"0xabc","status":"matched","takingAmount":"2","makingAmount":"0.98"}
`;

  const parsed = parseCLIOutput(sampleOutput);
  console.log('Orderbook found:', !!parsed.orderbook);
  console.log('Order details found:', !!parsed.orderDetails);
  console.log('Order result found:', !!parsed.orderResult);
  console.log('Success:', parsed.orderResult?.success);
  console.log('');

  // Test 2: Get orderbook (if token provided)
  if (process.argv[2]) {
    console.log('Test 2: Get orderbook for token', process.argv[2].substring(0, 20) + '...');
    const book = getOrderbook(process.argv[2]);
    console.log('Success:', book.success);
    if (book.success) {
      console.log('Best bid:', book.bestBid);
      console.log('Best ask:', book.bestAsk);
      console.log('Spread:', book.spread.toFixed(4));
    }
  }

  console.log('\n=== SELF-TEST COMPLETE ===');
}
