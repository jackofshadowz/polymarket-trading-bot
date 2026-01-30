// ============================================================
// TREASURY DESK - Automatic Redemption of Winning Positions
// ============================================================
// This desk runs in the background and converts winning shares
// back into USDC so the bot always has fresh cash to trade.
//
// Without this, profits sit as "zombie" tokens that can't be used
// for new trades until manually redeemed.
// ============================================================

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Config
const REDEMPTION_INTERVAL_MS = 5 * 60 * 1000;  // Check every 5 minutes
const REDEMPTION_LOG_FILE = path.join(__dirname, 'treasury-log.json');

// State
let lastRedemptionTime = 0;
let redemptionHistory = [];
let isProcessing = false;

/**
 * Load redemption history from disk
 */
function loadHistory() {
  try {
    if (fs.existsSync(REDEMPTION_LOG_FILE)) {
      const data = JSON.parse(fs.readFileSync(REDEMPTION_LOG_FILE, 'utf8'));
      redemptionHistory = data.history || [];
      lastRedemptionTime = data.lastRedemptionTime || 0;
    }
  } catch (e) {
    console.warn('Treasury: Could not load history:', e.message);
  }
}

/**
 * Save redemption history to disk
 */
function saveHistory() {
  try {
    fs.writeFileSync(REDEMPTION_LOG_FILE, JSON.stringify({
      lastRedemptionTime: lastRedemptionTime,
      history: redemptionHistory.slice(-100) // Keep last 100
    }, null, 2));
  } catch (e) {
    console.warn('Treasury: Could not save history:', e.message);
  }
}

/**
 * Get current positions using pmarket-cli
 * Returns array of positions with token info
 */
function getPositions() {
  try {
    const output = execSync('pmarket-cli -p 2>&1', {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Parse the output - pmarket-cli -p returns position data
    // Format varies, but we're looking for token IDs and amounts
    const positions = [];

    // Look for JSON in output
    const jsonMatch = output.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed;
      } catch (e) {
        // Not JSON, try to parse text format
      }
    }

    // If not JSON, look for patterns like "Token: XXX, Balance: YYY"
    const lines = output.split('\n');
    for (const line of lines) {
      // Match various position formats
      const tokenMatch = line.match(/token[_id]*[:\s]+([a-fA-F0-9]+)/i);
      const balanceMatch = line.match(/balance[:\s]+(\d+\.?\d*)/i);

      if (tokenMatch && balanceMatch) {
        positions.push({
          tokenId: tokenMatch[1],
          balance: parseFloat(balanceMatch[1])
        });
      }
    }

    return positions;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'TREASURY_POSITIONS_ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return [];
  }
}

/**
 * Attempt to redeem a specific token
 * pmarket-cli -r <tokenId>
 */
function redeemToken(tokenId) {
  try {
    console.log(JSON.stringify({
      action: 'TREASURY_REDEEM_ATTEMPT',
      tokenId: tokenId.substring(0, 20) + '...',
      timestamp: new Date().toISOString()
    }));

    const output = execSync(`pmarket-cli -r ${tokenId}`, {
      encoding: 'utf8',
      timeout: 60000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Check for success indicators
    const success = output.includes('success') ||
                   output.includes('redeemed') ||
                   output.includes('USDC') ||
                   !output.includes('error');

    if (success) {
      // Try to extract amount redeemed
      const amountMatch = output.match(/(\d+\.?\d*)\s*USDC/i);
      const amount = amountMatch ? parseFloat(amountMatch[1]) : 0;

      console.log(JSON.stringify({
        action: 'TREASURY_REDEEM_SUCCESS',
        tokenId: tokenId.substring(0, 20) + '...',
        amountRedeemed: amount > 0 ? '$' + amount.toFixed(2) : 'unknown',
        timestamp: new Date().toISOString()
      }));

      // Record in history
      redemptionHistory.push({
        tokenId: tokenId,
        amount: amount,
        timestamp: Date.now(),
        success: true
      });

      return { success: true, amount: amount };
    } else {
      return { success: false, error: 'No success indicator in output' };
    }

  } catch (error) {
    // Some errors are expected (already redeemed, no balance, market not resolved)
    const isExpectedError = error.message.includes('revert') ||
                           error.message.includes('no position') ||
                           error.message.includes('not resolved') ||
                           error.message.includes('nothing to redeem');

    if (!isExpectedError) {
      console.log(JSON.stringify({
        action: 'TREASURY_REDEEM_ERROR',
        tokenId: tokenId.substring(0, 20) + '...',
        error: error.message.substring(0, 100),
        timestamp: new Date().toISOString()
      }));
    }

    return { success: false, error: error.message };
  }
}

/**
 * Redeem all redeemable positions
 * This is the main function called by the heartbeat
 */
async function redeemAllWinnings() {
  if (isProcessing) {
    return { skipped: true, reason: 'Already processing' };
  }

  isProcessing = true;
  const results = {
    attempted: 0,
    succeeded: 0,
    totalRedeemed: 0,
    errors: []
  };

  try {
    console.log(JSON.stringify({
      action: 'TREASURY_SCAN_START',
      timestamp: new Date().toISOString()
    }));

    // Method 1: Try generic redeem command (may redeem all at once)
    try {
      const output = execSync('pmarket-cli -r 2>&1', {
        encoding: 'utf8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Check if anything was redeemed
      if (output.includes('success') || output.includes('redeemed')) {
        const amountMatch = output.match(/(\d+\.?\d*)\s*USDC/i);
        if (amountMatch) {
          results.totalRedeemed += parseFloat(amountMatch[1]);
          results.succeeded++;
        }

        console.log(JSON.stringify({
          action: 'TREASURY_BULK_REDEEM',
          output: output.substring(0, 200),
          timestamp: new Date().toISOString()
        }));
      }
    } catch (e) {
      // Generic redeem might not be supported, continue with individual tokens
    }

    // Method 2: Get positions and try to redeem each
    const positions = getPositions();

    for (const position of positions) {
      if (position.tokenId && position.balance > 0) {
        results.attempted++;
        const redeemResult = redeemToken(position.tokenId);

        if (redeemResult.success) {
          results.succeeded++;
          results.totalRedeemed += redeemResult.amount || 0;
        } else if (!redeemResult.error.includes('nothing to redeem')) {
          results.errors.push({
            tokenId: position.tokenId.substring(0, 20),
            error: redeemResult.error.substring(0, 50)
          });
        }
      }
    }

    lastRedemptionTime = Date.now();
    saveHistory();

    console.log(JSON.stringify({
      action: 'TREASURY_SCAN_COMPLETE',
      attempted: results.attempted,
      succeeded: results.succeeded,
      totalRedeemed: results.totalRedeemed > 0 ? '$' + results.totalRedeemed.toFixed(2) : '$0.00',
      errors: results.errors.length,
      timestamp: new Date().toISOString()
    }));

    return results;

  } catch (error) {
    console.log(JSON.stringify({
      action: 'TREASURY_SCAN_ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    }));

    return { ...results, error: error.message };

  } finally {
    isProcessing = false;
  }
}

/**
 * Start the treasury heartbeat (background redemption loop)
 */
function startHeartbeat() {
  loadHistory();

  console.log(JSON.stringify({
    action: 'TREASURY_HEARTBEAT_START',
    interval: (REDEMPTION_INTERVAL_MS / 1000 / 60) + ' minutes',
    timestamp: new Date().toISOString()
  }));

  // Run immediately on start
  setTimeout(() => redeemAllWinnings(), 10000); // Wait 10s for bot to initialize

  // Then run on interval
  setInterval(() => {
    redeemAllWinnings().catch(e => {
      console.warn('Treasury heartbeat error:', e.message);
    });
  }, REDEMPTION_INTERVAL_MS);
}

/**
 * Get treasury statistics
 */
function getStats() {
  const recent = redemptionHistory.filter(r =>
    r.timestamp > Date.now() - 24 * 60 * 60 * 1000 // Last 24 hours
  );

  const totalRedeemed24h = recent
    .filter(r => r.success)
    .reduce((sum, r) => sum + (r.amount || 0), 0);

  return {
    lastRedemption: lastRedemptionTime ? new Date(lastRedemptionTime).toISOString() : 'never',
    redemptions24h: recent.filter(r => r.success).length,
    totalRedeemed24h: totalRedeemed24h,
    totalHistorical: redemptionHistory.length
  };
}

module.exports = {
  redeemAllWinnings,
  redeemToken,
  getPositions,
  startHeartbeat,
  getStats,
  REDEMPTION_INTERVAL_MS
};
