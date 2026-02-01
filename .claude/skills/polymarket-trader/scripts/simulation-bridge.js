/**
 * SIMULATION BRIDGE - Exchange Emulator for Shadow Mode
 *
 * Mimics Polymarket CLOB and Settlement logic for realistic testing
 * without touching real money.
 *
 * Features:
 * 1. Mock execution with realistic fills
 * 2. Shadow position tracking
 * 3. Settlement emulation based on BTC price
 * 4. P&L calculation at window expiry
 */

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  SHADOW_VAULT_PATH: '/tmp/shadow-vault.json',
  SHADOW_MODE: process.env.SHADOW_MODE === 'true',
  MIN_SHARES: 5,
  SLIPPAGE_RANGE: [0, 0.005],  // 0-0.5% random slippage
  FILL_PROBABILITY: 0.95       // 95% chance of fill (realistic)
};

// ============================================================
// STATE MANAGEMENT
// ============================================================

/**
 * Initialize the shadow vault if it doesn't exist
 */
function initVault() {
  if (!fs.existsSync(CONFIG.SHADOW_VAULT_PATH)) {
    const initialState = {
      virtualUSDC: 14.15,  // Match actual Polymarket balance
      positions: [],
      closedTrades: [],
      stats: {
        totalTrades: 0,
        wins: 0,
        losses: 0,
        totalPnL: 0,
        windowsSimulated: 0
      },
      createdAt: new Date().toISOString()
    };
    saveVault(initialState);
    console.log(JSON.stringify({
      action: 'SHADOW_VAULT_CREATED',
      balance: initialState.virtualUSDC,
      path: CONFIG.SHADOW_VAULT_PATH,
      timestamp: new Date().toISOString()
    }));
  }
}

/**
 * Load vault state
 */
function loadVault() {
  initVault();
  try {
    return JSON.parse(fs.readFileSync(CONFIG.SHADOW_VAULT_PATH, 'utf8'));
  } catch (e) {
    console.log(JSON.stringify({
      action: 'SHADOW_VAULT_LOAD_ERROR',
      error: e.message,
      timestamp: new Date().toISOString()
    }));
    return null;
  }
}

/**
 * Save vault state
 */
function saveVault(state) {
  fs.writeFileSync(CONFIG.SHADOW_VAULT_PATH, JSON.stringify(state, null, 2));
}

// ============================================================
// MOCK EXECUTION ENGINE
// ============================================================

/**
 * Mock buy order execution
 * Intercepts pmarket-cli calls and simulates realistic fills
 *
 * @param {string} tokenId - Token to buy
 * @param {number} amountUSDC - Amount to spend
 * @param {number} price - Limit price
 * @param {string} side - 'YES' or 'NO'
 * @param {string} slug - Window slug for tracking
 * @param {number} btcOpenPrice - BTC price at window open
 * @param {string} desk - Which desk is trading (FARM/DEGEN/CLIPPER)
 * @returns {Object} Simulated order result
 */
function mockExecution(tokenId, amountUSDC, price, side, slug, btcOpenPrice, desk = 'UNKNOWN') {
  const vault = loadVault();
  if (!vault) {
    return { success: false, error: 'VAULT_LOAD_ERROR' };
  }

  // Validate sufficient balance
  if (amountUSDC > vault.virtualUSDC) {
    console.log(JSON.stringify({
      action: 'SHADOW_INSUFFICIENT_BALANCE',
      requested: amountUSDC.toFixed(2),
      available: vault.virtualUSDC.toFixed(2),
      timestamp: new Date().toISOString()
    }));
    return {
      success: false,
      error: 'INSUFFICIENT_VIRTUAL_BALANCE',
      requested: amountUSDC,
      available: vault.virtualUSDC
    };
  }

  // Simulate random slippage (realistic market behavior)
  const slippage = CONFIG.SLIPPAGE_RANGE[0] +
    Math.random() * (CONFIG.SLIPPAGE_RANGE[1] - CONFIG.SLIPPAGE_RANGE[0]);
  const actualPrice = Math.min(price * (1 + slippage), 0.99);

  // Calculate shares received
  const shares = amountUSDC / actualPrice;
  const actualCost = amountUSDC;  // Full amount spent

  // Check minimum share requirement
  if (shares < CONFIG.MIN_SHARES) {
    console.log(JSON.stringify({
      action: 'SHADOW_UNDER_MIN_SHARES',
      shares: shares.toFixed(2),
      minimum: CONFIG.MIN_SHARES,
      timestamp: new Date().toISOString()
    }));
    return {
      success: false,
      error: 'UNDER_MIN_SHARES',
      shares: shares,
      minimum: CONFIG.MIN_SHARES
    };
  }

  // Simulate fill probability (sometimes orders don't fill)
  if (Math.random() > CONFIG.FILL_PROBABILITY) {
    console.log(JSON.stringify({
      action: 'SHADOW_ORDER_NOT_FILLED',
      reason: 'Simulated market moved away',
      timestamp: new Date().toISOString()
    }));
    return {
      success: false,
      error: 'ORDER_NOT_FILLED',
      reason: 'Price moved during execution'
    };
  }

  // Create simulated position
  const position = {
    id: `shadow_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
    tokenId: tokenId,
    side: side,
    slug: slug,
    desk: desk,
    entryPrice: actualPrice,
    shares: shares,
    actualCost: actualCost,
    btcOpenPrice: btcOpenPrice,
    status: 'OPEN',
    timestamp: new Date().toISOString(),
    txHash: `0xSHADOW_${Date.now().toString(16)}`
  };

  // Update vault
  vault.positions.push(position);
  vault.virtualUSDC -= actualCost;
  vault.stats.totalTrades++;
  saveVault(vault);

  console.log(JSON.stringify({
    action: 'SHADOW_EXECUTION_SUCCESS',
    positionId: position.id,
    side: side,
    shares: shares.toFixed(2),
    entryPrice: actualPrice.toFixed(4),
    cost: actualCost.toFixed(2),
    btcOpen: btcOpenPrice.toFixed(2),
    desk: desk,
    remainingBalance: vault.virtualUSDC.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  // Return result matching pmarket-cli format
  return {
    success: true,
    status: 'matched',
    orderID: position.id,
    takingAmount: shares.toString(),
    makingAmount: actualCost.toString(),
    avgPrice: actualPrice,
    transactionHash: position.txHash,
    _shadow: true  // Flag indicating this is a shadow trade
  };
}

/**
 * Mock sell order execution
 * For early exits / clipping
 */
function mockSellExecution(positionId, sellPrice) {
  const vault = loadVault();
  if (!vault) {
    return { success: false, error: 'VAULT_LOAD_ERROR' };
  }

  const posIndex = vault.positions.findIndex(p => p.id === positionId);
  if (posIndex === -1) {
    return { success: false, error: 'POSITION_NOT_FOUND' };
  }

  const position = vault.positions[posIndex];
  const proceeds = position.shares * sellPrice;
  const pnl = proceeds - position.actualCost;

  // Update position
  position.status = 'SOLD';
  position.exitPrice = sellPrice;
  position.exitTimestamp = new Date().toISOString();
  position.proceeds = proceeds;
  position.pnl = pnl;

  // Move to closed trades
  vault.closedTrades.push(position);
  vault.positions.splice(posIndex, 1);

  // Update balance and stats
  vault.virtualUSDC += proceeds;
  vault.stats.totalPnL += pnl;
  if (pnl > 0) vault.stats.wins++;
  else vault.stats.losses++;

  saveVault(vault);

  console.log(JSON.stringify({
    action: 'SHADOW_SELL_EXECUTION',
    positionId: positionId,
    sellPrice: sellPrice.toFixed(4),
    proceeds: proceeds.toFixed(2),
    pnl: pnl.toFixed(2),
    newBalance: vault.virtualUSDC.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  return {
    success: true,
    status: 'matched',
    proceeds: proceeds,
    pnl: pnl,
    _shadow: true
  };
}

// ============================================================
// SETTLEMENT EMULATOR
// ============================================================

/**
 * Emulate settlement for a window
 * Called at the 901st second of each window
 *
 * @param {string} windowSlug - The window slug to settle
 * @param {number} btcClosePrice - BTC price at window close
 * @returns {Object} Settlement results
 */
function emulateSettlement(windowSlug, btcClosePrice) {
  const vault = loadVault();
  if (!vault) {
    return { success: false, error: 'VAULT_LOAD_ERROR' };
  }

  // Find positions for this window
  // FIX: Also match by 'unknown' slug or positions older than 15 minutes
  // This handles cases where slug wasn't passed correctly
  const fifteenMinutesAgo = Date.now() - (16 * 60 * 1000); // 16 min to allow for settlement timing
  const windowPositions = vault.positions.filter(p => {
    if (p.status !== 'OPEN') return false;
    // Match by slug if available
    if (p.slug === windowSlug) return true;
    // Match unknown slugs that are old enough (likely from this window)
    if (p.slug === 'unknown' && new Date(p.timestamp).getTime() < fifteenMinutesAgo) return true;
    // Match any position older than 15 minutes (should have settled)
    if (new Date(p.timestamp).getTime() < fifteenMinutesAgo) return true;
    return false;
  });

  if (windowPositions.length === 0) {
    console.log(JSON.stringify({
      action: 'SHADOW_NO_POSITIONS_TO_SETTLE',
      windowSlug: windowSlug,
      openPositions: vault.positions.length,
      timestamp: new Date().toISOString()
    }));
    return { settled: 0, pnl: 0 };
  }

  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  const settlements = [];

  for (const position of windowPositions) {
    // Determine win/loss based on BTC price movement
    const btcMoved = btcClosePrice - position.btcOpenPrice;
    const didWin =
      (position.side === 'YES' && btcMoved > 0) ||
      (position.side === 'NO' && btcMoved < 0);

    // Calculate payout
    // Win: shares * $1.00
    // Lose: $0
    const payout = didWin ? position.shares * 1.00 : 0;
    const pnl = payout - position.actualCost;

    // Update position
    position.status = 'SETTLED';
    position.btcClosePrice = btcClosePrice;
    position.btcDelta = btcMoved;
    position.didWin = didWin;
    position.payout = payout;
    position.pnl = pnl;
    position.settledAt = new Date().toISOString();

    // Move to closed trades
    vault.closedTrades.push(position);
    const posIndex = vault.positions.indexOf(position);
    vault.positions.splice(posIndex, 1);

    // Update totals
    totalPnL += pnl;
    if (didWin) wins++;
    else losses++;

    settlements.push({
      positionId: position.id,
      side: position.side,
      desk: position.desk,
      btcOpen: position.btcOpenPrice,
      btcClose: btcClosePrice,
      btcDelta: btcMoved.toFixed(2),
      shares: position.shares.toFixed(2),
      cost: position.actualCost.toFixed(2),
      payout: payout.toFixed(2),
      pnl: pnl.toFixed(2),
      result: didWin ? 'WIN' : 'LOSS'
    });

    console.log(JSON.stringify({
      action: 'SHADOW_POSITION_SETTLED',
      positionId: position.id,
      side: position.side,
      desk: position.desk,
      btcOpen: position.btcOpenPrice.toFixed(2),
      btcClose: btcClosePrice.toFixed(2),
      btcDelta: (btcMoved > 0 ? '+' : '') + btcMoved.toFixed(2),
      result: didWin ? 'WIN' : 'LOSS',
      payout: payout.toFixed(2),
      pnl: (pnl >= 0 ? '+' : '') + pnl.toFixed(2),
      timestamp: new Date().toISOString()
    }));
  }

  // Update vault stats
  vault.virtualUSDC += totalPnL + windowPositions.reduce((sum, p) => sum + p.actualCost, 0);
  vault.stats.totalPnL += totalPnL;
  vault.stats.wins += wins;
  vault.stats.losses += losses;
  vault.stats.windowsSimulated++;
  saveVault(vault);

  console.log(JSON.stringify({
    action: 'SHADOW_WINDOW_SETTLEMENT_COMPLETE',
    windowSlug: windowSlug,
    positionsSettled: settlements.length,
    wins: wins,
    losses: losses,
    windowPnL: (totalPnL >= 0 ? '+' : '') + totalPnL.toFixed(2),
    newBalance: vault.virtualUSDC.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  return {
    success: true,
    settled: settlements.length,
    wins: wins,
    losses: losses,
    pnl: totalPnL,
    settlements: settlements,
    newBalance: vault.virtualUSDC
  };
}

/**
 * Settle all expired positions
 * Call this periodically to clean up positions that should have settled
 *
 * @param {number} currentBtcPrice - Current BTC price for settlement
 */
function settleExpiredPositions(currentBtcPrice) {
  const vault = loadVault();
  if (!vault) return { settled: 0 };

  // Find positions older than 15 minutes
  const fifteenMinutesAgo = Date.now() - (15 * 60 * 1000);
  const expiredPositions = vault.positions.filter(p =>
    p.status === 'OPEN' &&
    new Date(p.timestamp).getTime() < fifteenMinutesAgo
  );

  if (expiredPositions.length === 0) {
    return { settled: 0 };
  }

  let totalSettled = 0;
  for (const position of expiredPositions) {
    const result = emulateSettlement(position.slug, currentBtcPrice);
    totalSettled += result.settled || 0;
  }

  return { settled: totalSettled };
}

// ============================================================
// STATUS AND REPORTING
// ============================================================

/**
 * Get current shadow mode status
 */
function getStatus() {
  const vault = loadVault();
  if (!vault) {
    return { enabled: CONFIG.SHADOW_MODE, error: 'VAULT_ERROR' };
  }

  return {
    enabled: CONFIG.SHADOW_MODE,
    virtualBalance: vault.virtualUSDC,
    openPositions: vault.positions.length,
    closedTrades: vault.closedTrades.length,
    stats: vault.stats,
    positions: vault.positions.map(p => ({
      id: p.id,
      side: p.side,
      desk: p.desk,
      shares: p.shares?.toFixed(2),
      cost: p.actualCost?.toFixed(2),
      btcOpen: p.btcOpenPrice?.toFixed(2),
      slug: p.slug
    }))
  };
}

/**
 * Get open positions for a specific window
 */
function getOpenPositions(windowSlug = null) {
  const vault = loadVault();
  if (!vault) return [];

  if (windowSlug) {
    return vault.positions.filter(p => p.slug === windowSlug);
  }
  return vault.positions;
}

/**
 * Check if shadow mode is enabled
 */
function isShadowMode() {
  return CONFIG.SHADOW_MODE;
}

/**
 * Reset shadow vault (for starting fresh)
 */
function resetVault(initialBalance = 14.15) {
  const state = {
    virtualUSDC: initialBalance,
    positions: [],
    closedTrades: [],
    stats: {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      windowsSimulated: 0
    },
    createdAt: new Date().toISOString(),
    resetAt: new Date().toISOString()
  };
  saveVault(state);

  console.log(JSON.stringify({
    action: 'SHADOW_VAULT_RESET',
    newBalance: initialBalance,
    timestamp: new Date().toISOString()
  }));

  return state;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  // Core functions
  mockExecution,
  mockSellExecution,
  emulateSettlement,
  settleExpiredPositions,

  // Status and reporting
  getStatus,
  getOpenPositions,
  isShadowMode,
  resetVault,

  // Config access
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== SIMULATION BRIDGE SELF-TEST ===\n');

  // Reset vault for clean test
  resetVault(50.00);

  // Test 1: Mock execution
  console.log('Test 1: Mock buy execution');
  const buyResult = mockExecution(
    'test_token_123',
    5.00,
    0.45,
    'YES',
    'btc-updown-15m-test',
    98500.00,
    'CLIPPER'
  );
  console.log('Buy result:', JSON.stringify(buyResult, null, 2));

  // Test 2: Check status
  console.log('\nTest 2: Check status');
  const status = getStatus();
  console.log('Status:', JSON.stringify(status, null, 2));

  // Test 3: Emulate settlement (WIN scenario)
  console.log('\nTest 3: Settlement emulation (BTC went UP)');
  const settleResult = emulateSettlement('btc-updown-15m-test', 98600.00);
  console.log('Settlement result:', JSON.stringify(settleResult, null, 2));

  // Test 4: Final status
  console.log('\nTest 4: Final status');
  const finalStatus = getStatus();
  console.log('Final status:', JSON.stringify(finalStatus, null, 2));

  console.log('\n=== SELF-TEST COMPLETE ===');
}
