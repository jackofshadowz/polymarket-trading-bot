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

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_BUY_ORDER',
    tokenId: tokenId.substring(0, 20) + '...',
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
        const fillResult = {
          success: orderResult.status === 'matched', // Only success if actually filled!
          orderID: orderResult.orderID,
          status: orderResult.status,
          sharesReceived: parseFloat(orderResult.takingAmount) || 0,
          costUSDC: parseFloat(orderResult.makingAmount) || amountUSDC,
          avgFillPrice: 0,
          txHash: orderResult.transactionsHashes?.[0] || null,
          attempt: attempt
        };

        // Calculate average fill price
        if (fillResult.sharesReceived > 0) {
          fillResult.avgFillPrice = fillResult.costUSDC / fillResult.sharesReceived;
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

  console.log(JSON.stringify({
    action: 'EXECUTION_DESK_SELL_ORDER',
    tokenId: tokenId.substring(0, 20) + '...',
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

  // Get current orderbook to verify price
  const orderbook = getOrderbook(trade.tokenId);

  if (!orderbook.success) {
    return {
      success: false,
      error: 'Failed to get orderbook: ' + orderbook.error,
      desk: trade.desk
    };
  }

  // Check if price is still acceptable
  const currentPrice = trade.side === 'YES' ? orderbook.bestAsk : orderbook.bestAsk;

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

  // Execute the buy order
  const result = placeBuyOrder(trade.tokenId, trade.amount, trade.maxPrice);

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
        // Retry the order with new keys
        const retryResult = placeBuyOrder(trade.tokenId, trade.amount, trade.maxPrice);

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

// Export all functions
module.exports = {
  parseCLIOutput,
  runPmarketCLI,
  getOrderbook,
  placeBuyOrder,
  placeSellOrder,
  cancelAllOrders,
  refreshAPIKeys,
  executeApprovedTrade
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
