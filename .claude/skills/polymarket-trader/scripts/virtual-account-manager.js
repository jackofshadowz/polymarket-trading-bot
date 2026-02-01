const fs = require('fs');
const path = require('path');

// ============================================================
// VIRTUAL ACCOUNT MANAGER
// Manages Farm (35%), Degen (15%), and Clipper (50%) virtual accounts
// OPTIMIZED: CLIPPER is highest performer, gets majority allocation
// ============================================================

const ACCOUNTS_FILE = '/tmp/polymarket-virtual-accounts.json';

let VIRTUAL_ACCOUNTS = null; // Initialized dynamically based on current balance

// FIX #2: Settlement lock to prevent race conditions
const settlingPositions = new Set();

// ============================================================
// FIX #3: Unified Capital Calculation (Single Source of Truth)
// ============================================================

/**
 * Recalculate available capital from source of truth
 * Always use this instead of direct subtraction to prevent drift
 */
function recalculateAvailableCapital(deskData) {
  deskData.totalExposure = deskData.openPositions.reduce((sum, p) => sum + (p.costBasis || 0), 0);
  deskData.availableCapital = deskData.currentBalance - deskData.totalExposure;
}

// ============================================================
// INITIALIZATION
// ============================================================

function initializeVirtualAccounts(currentBalance) {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      // Load existing accounts (preserves growing balance)
      const data = fs.readFileSync(ACCOUNTS_FILE, 'utf8');
      VIRTUAL_ACCOUNTS = JSON.parse(data);

      // MIGRATION: Check if CLIPPER desk exists (2-desk → 3-desk migration)
      if (VIRTUAL_ACCOUNTS && VIRTUAL_ACCOUNTS.desks && !VIRTUAL_ACCOUNTS.desks.CLIPPER) {
        console.log(JSON.stringify({
          action: 'MIGRATING_TO_3_DESK_SYSTEM',
          oldAllocation: 'FARM 80%, DEGEN 20%',
          newAllocation: 'FARM 60%, DEGEN 25%, CLIPPER 15%',
          timestamp: new Date().toISOString()
        }));

        const totalBalance = VIRTUAL_ACCOUNTS.fund.totalBalance;
        const newFarmBalance = totalBalance * 0.60;
        const newDegenBalance = totalBalance * 0.25;
        const newClipperBalance = totalBalance * 0.15;

        // Create CLIPPER desk
        VIRTUAL_ACCOUNTS.desks.CLIPPER = {
          allocation: 0.15,
          currentBalance: newClipperBalance,
          startingBalance: newClipperBalance,
          inceptionBalance: newClipperBalance,
          openPositions: [],
          straddlePositions: [],      // NEW: Track active straddles
          totalExposure: 0.00,
          availableCapital: newClipperBalance,
          lifetimeStats: {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0.000,
            totalProfit: 0.00,
            roi: 0.000,
            sharpeRatio: 0.00,
            maxDrawdown: 0.00,
            avgWin: 0.00,
            avgLoss: 0.00,
            longestWinStreak: 0,
            longestLossStreak: 0,
            currentStreak: 0,
            streakType: null,
            clipsExecuted: 0,          // NEW
            avgClipProfit: 0.00,       // NEW
            straddlesCost: 0.00,       // NEW
            emergencyClips: 0,         // NEW
            crossDeskAdvisories: 0     // NEW
          }
        };

        // Adjust existing desks
        VIRTUAL_ACCOUNTS.desks.FARM.currentBalance = newFarmBalance;
        VIRTUAL_ACCOUNTS.desks.FARM.availableCapital = newFarmBalance - VIRTUAL_ACCOUNTS.desks.FARM.totalExposure;
        VIRTUAL_ACCOUNTS.desks.FARM.allocation = 0.60;

        VIRTUAL_ACCOUNTS.desks.DEGEN.currentBalance = newDegenBalance;
        VIRTUAL_ACCOUNTS.desks.DEGEN.availableCapital = newDegenBalance - VIRTUAL_ACCOUNTS.desks.DEGEN.totalExposure;
        VIRTUAL_ACCOUNTS.desks.DEGEN.allocation = 0.25;

        // Add straddlePositions to DEGEN if it doesn't exist (for consistency)
        if (!VIRTUAL_ACCOUNTS.desks.DEGEN.straddlePositions) {
          VIRTUAL_ACCOUNTS.desks.DEGEN.straddlePositions = [];
        }
        if (!VIRTUAL_ACCOUNTS.desks.FARM.straddlePositions) {
          VIRTUAL_ACCOUNTS.desks.FARM.straddlePositions = [];
        }

        saveAccounts();

        console.log(JSON.stringify({
          action: 'MIGRATION_COMPLETE',
          farmBalance: newFarmBalance.toFixed(2) + ' (60%)',
          degenBalance: newDegenBalance.toFixed(2) + ' (25%)',
          clipperBalance: newClipperBalance.toFixed(2) + ' (15%)',
          timestamp: new Date().toISOString()
        }));
      }

      // MIGRATION v2: Reallocate from 60/25/15 to 35/15/50 (CLIPPER-heavy)
      // This runs once when FARM allocation is still at old value
      if (VIRTUAL_ACCOUNTS && VIRTUAL_ACCOUNTS.desks &&
          VIRTUAL_ACCOUNTS.desks.CLIPPER &&
          VIRTUAL_ACCOUNTS.desks.FARM.allocation > 0.40) {  // Detect old 60% allocation

        console.log(JSON.stringify({
          action: 'MIGRATING_TO_CLIPPER_HEAVY_ALLOCATION',
          oldAllocation: 'FARM 60%, DEGEN 25%, CLIPPER 15%',
          newAllocation: 'FARM 35%, DEGEN 15%, CLIPPER 50%',
          reason: 'CLIPPER has 70% win rate vs FARM 28%',
          timestamp: new Date().toISOString()
        }));

        const totalBalance = VIRTUAL_ACCOUNTS.fund.totalBalance;
        const newFarmBalance2 = totalBalance * 0.35;
        const newDegenBalance2 = totalBalance * 0.15;
        const newClipperBalance2 = totalBalance * 0.50;

        // Preserve open positions by keeping their costBasis intact
        const farmExposure = VIRTUAL_ACCOUNTS.desks.FARM.totalExposure || 0;
        const degenExposure = VIRTUAL_ACCOUNTS.desks.DEGEN.totalExposure || 0;
        const clipperExposure = VIRTUAL_ACCOUNTS.desks.CLIPPER.totalExposure || 0;

        // Update allocations and balances
        VIRTUAL_ACCOUNTS.desks.FARM.allocation = 0.35;
        VIRTUAL_ACCOUNTS.desks.FARM.currentBalance = newFarmBalance2;
        VIRTUAL_ACCOUNTS.desks.FARM.availableCapital = newFarmBalance2 - farmExposure;

        VIRTUAL_ACCOUNTS.desks.DEGEN.allocation = 0.15;
        VIRTUAL_ACCOUNTS.desks.DEGEN.currentBalance = newDegenBalance2;
        VIRTUAL_ACCOUNTS.desks.DEGEN.availableCapital = newDegenBalance2 - degenExposure;

        VIRTUAL_ACCOUNTS.desks.CLIPPER.allocation = 0.50;
        VIRTUAL_ACCOUNTS.desks.CLIPPER.currentBalance = newClipperBalance2;
        VIRTUAL_ACCOUNTS.desks.CLIPPER.availableCapital = newClipperBalance2 - clipperExposure;

        saveAccounts();

        console.log(JSON.stringify({
          action: 'CLIPPER_HEAVY_MIGRATION_COMPLETE',
          farmBalance: newFarmBalance2.toFixed(2) + ' (35%)',
          degenBalance: newDegenBalance2.toFixed(2) + ' (15%)',
          clipperBalance: newClipperBalance2.toFixed(2) + ' (50%)',
          timestamp: new Date().toISOString()
        }));
      }

      console.log(JSON.stringify({
        action: 'VIRTUAL_ACCOUNTS_LOADED',
        fundName: VIRTUAL_ACCOUNTS.fund.name,
        farmBalance: VIRTUAL_ACCOUNTS.desks.FARM.currentBalance.toFixed(2),
        degenBalance: VIRTUAL_ACCOUNTS.desks.DEGEN.currentBalance.toFixed(2),
        clipperBalance: VIRTUAL_ACCOUNTS.desks.CLIPPER ? VIRTUAL_ACCOUNTS.desks.CLIPPER.currentBalance.toFixed(2) : '0.00',
        totalTrades: VIRTUAL_ACCOUNTS.desks.FARM.lifetimeStats.totalTrades + VIRTUAL_ACCOUNTS.desks.DEGEN.lifetimeStats.totalTrades +
          (VIRTUAL_ACCOUNTS.desks.CLIPPER ? VIRTUAL_ACCOUNTS.desks.CLIPPER.lifetimeStats.totalTrades : 0),
        timestamp: new Date().toISOString()
      }));
    } else {
      // Initialize fresh with 35/15/50 split (CLIPPER-heavy for best performer)
      const farmBalance = currentBalance * 0.35;
      const degenBalance = currentBalance * 0.15;
      const clipperBalance = currentBalance * 0.50;

      VIRTUAL_ACCOUNTS = {
        fund: {
          name: 'ASYMMETRIC ALPHA FUND',
          totalBalance: currentBalance,
          inceptionBalance: currentBalance,
          inceptionDate: new Date().toISOString(),
          lifetimeProfit: 0.00,
          lifetimeRoi: 0.00
        },
        desks: {
          FARM: {
            allocation: 0.35,
            currentBalance: farmBalance,
            startingBalance: farmBalance,
            inceptionBalance: farmBalance,
            openPositions: [],
            straddlePositions: [],
            totalExposure: 0.00,
            availableCapital: farmBalance,
            lifetimeStats: {
              totalTrades: 0,
              wins: 0,
              losses: 0,
              winRate: 0.000,
              totalProfit: 0.00,
              roi: 0.000,
              sharpeRatio: 0.00,
              maxDrawdown: 0.00,
              avgWin: 0.00,
              avgLoss: 0.00,
              longestWinStreak: 0,
              longestLossStreak: 0,
              currentStreak: 0,
              streakType: null
            }
          },
          DEGEN: {
            allocation: 0.15,
            currentBalance: degenBalance,
            startingBalance: degenBalance,
            inceptionBalance: degenBalance,
            openPositions: [],
            straddlePositions: [],
            totalExposure: 0.00,
            availableCapital: degenBalance,
            lifetimeStats: {
              totalTrades: 0,
              wins: 0,
              losses: 0,
              winRate: 0.000,
              totalProfit: 0.00,
              roi: 0.000,
              sharpeRatio: 0.00,
              maxDrawdown: 0.00,
              avgWin: 0.00,
              avgLoss: 0.00,
              longestWinStreak: 0,
              longestLossStreak: 0,
              currentStreak: 0,
              streakType: null,
              lottoTicketWins: 0,
              lottoTicketHitRate: 0.000
            }
          },
          CLIPPER: {
            allocation: 0.50,
            currentBalance: clipperBalance,
            startingBalance: clipperBalance,
            inceptionBalance: clipperBalance,
            openPositions: [],
            straddlePositions: [],
            totalExposure: 0.00,
            availableCapital: clipperBalance,
            lifetimeStats: {
              totalTrades: 0,
              wins: 0,
              losses: 0,
              winRate: 0.000,
              totalProfit: 0.00,
              roi: 0.000,
              sharpeRatio: 0.00,
              maxDrawdown: 0.00,
              avgWin: 0.00,
              avgLoss: 0.00,
              longestWinStreak: 0,
              longestLossStreak: 0,
              currentStreak: 0,
              streakType: null,
              clipsExecuted: 0,
              avgClipProfit: 0.00,
              straddlesCost: 0.00,
              emergencyClips: 0,
              crossDeskAdvisories: 0
            }
          }
        },
        rebalancingHistory: []
      };

      saveAccounts();

      console.log(JSON.stringify({
        action: 'VIRTUAL_ACCOUNTS_INITIALIZED',
        fundName: VIRTUAL_ACCOUNTS.fund.name,
        totalBalance: currentBalance.toFixed(2),
        farmBalance: farmBalance.toFixed(2) + ' (35%)',
        degenBalance: degenBalance.toFixed(2) + ' (15%)',
        clipperBalance: clipperBalance.toFixed(2) + ' (50%)',
        timestamp: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      action: 'VIRTUAL_ACCOUNTS_INIT_ERROR',
      error: error.message
    }));
  }
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(VIRTUAL_ACCOUNTS, null, 2), 'utf8');
  } catch (error) {
    console.error(JSON.stringify({
      action: 'VIRTUAL_ACCOUNTS_SAVE_ERROR',
      error: error.message
    }));
  }
}

// ============================================================
// ACCOUNT QUERIES
// ============================================================

function getAccounts() {
  return VIRTUAL_ACCOUNTS;
}

function getDeskBalance(desk) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }
  return VIRTUAL_ACCOUNTS.desks[desk].currentBalance;
}

function getDeskAvailableCapital(desk) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }
  return VIRTUAL_ACCOUNTS.desks[desk].availableCapital;
}

function getDeskStats(desk) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }
  return VIRTUAL_ACCOUNTS.desks[desk].lifetimeStats;
}

// ============================================================
// TRADE RECORDING
// ============================================================

function recordTrade(desk, windowSlug, side, entryPrice, shares, costBasis, tokenId, lottoTicket = false, isStraddleOrigin = false) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }

  const deskData = VIRTUAL_ACCOUNTS.desks[desk];

  // Add to open positions
  deskData.openPositions.push({
    windowSlug: windowSlug,
    side: side,
    entryPrice: entryPrice,
    shares: shares,
    costBasis: costBasis,
    currentValue: shares * entryPrice,
    unrealizedPL: 0.00,
    timestamp: new Date().toISOString(),
    lottoTicket: lottoTicket,
    tokenId: tokenId,                  // NEW: For clipping monitor
    slug: windowSlug,                  // NEW: For matching
    isLottoTicket: lottoTicket,        // NEW: Consistent naming
    isStraddleOrigin: isStraddleOrigin // NEW: Track if from straddle
  });

  // FIX #3: Use unified capital calculation instead of direct subtraction
  // This prevents drift between totalExposure and availableCapital
  recalculateAvailableCapital(deskData);

  console.log(JSON.stringify({
    action: 'TRADE_RECORDED',
    desk: desk,
    window: windowSlug,
    side: side,
    entryPrice: entryPrice.toFixed(3),  // Log as entryPrice (clearer)
    costBasis: costBasis.toFixed(2),
    shares: shares.toFixed(2),
    tokenId: tokenId ? tokenId.substring(0, 8) + '...' : 'unknown',
    lottoTicket: lottoTicket,
    remainingCapital: deskData.availableCapital.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  saveAccounts();
}

// ============================================================
// POSITION SETTLEMENT
// ============================================================

function settlePosition(desk, windowSlug, winner) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }

  // FIX #8: Validate winner parameter
  if (winner !== 'YES' && winner !== 'NO') {
    console.log(JSON.stringify({
      action: 'SETTLEMENT_REJECTED',
      reason: 'Invalid winner value',
      winner: winner,
      desk: desk,
      windowSlug: windowSlug,
      timestamp: new Date().toISOString()
    }));
    return null;
  }

  // FIX #2: Lock to prevent concurrent settlement of same position
  const lockKey = `${desk}-${windowSlug}`;
  if (settlingPositions.has(lockKey)) {
    console.log(JSON.stringify({
      action: 'SETTLEMENT_BLOCKED',
      reason: 'Already being settled by another process',
      lockKey: lockKey,
      timestamp: new Date().toISOString()
    }));
    return null;
  }

  settlingPositions.add(lockKey);

  try {
    const deskData = VIRTUAL_ACCOUNTS.desks[desk];

    // ATOMIC SETTLEMENT: Find and IMMEDIATELY remove in one operation
    const positionIndex = deskData.openPositions.findIndex(p => p.windowSlug === windowSlug);
    if (positionIndex === -1) {
      return null; // No position for this desk in this window
    }

    // Remove FIRST (atomic) - position is now "claimed"
    const [position] = deskData.openPositions.splice(positionIndex, 1);

    // FIX #8: Validate position object has required fields
    if (!position.side || !['YES', 'NO'].includes(position.side)) {
      console.error(JSON.stringify({
        action: 'CORRUPTED_POSITION',
        field: 'side',
        value: position.side,
        windowSlug: windowSlug,
        timestamp: new Date().toISOString()
      }));
      return null;
    }

    if (typeof position.shares !== 'number' || position.shares <= 0) {
      console.error(JSON.stringify({
        action: 'CORRUPTED_POSITION',
        field: 'shares',
        value: position.shares,
        windowSlug: windowSlug,
        timestamp: new Date().toISOString()
      }));
      return null;
    }

    if (typeof position.costBasis !== 'number' || position.costBasis <= 0) {
      console.error(JSON.stringify({
        action: 'CORRUPTED_POSITION',
        field: 'costBasis',
        value: position.costBasis,
        windowSlug: windowSlug,
        timestamp: new Date().toISOString()
      }));
      return null;
    }

    // Generate transaction ID for audit trail
    const txId = `settle-${desk}-${windowSlug}-${Date.now()}`;

    // NOW calculate P&L (position already removed, safe from race conditions)
    const won = position.side === winner;

  // Calculate P&L
  const profit = won ?
    position.shares * (1.00 - position.entryPrice) :
    -position.costBasis;

    // Update balance (payout = costBasis + profit)
    deskData.currentBalance += (position.costBasis + profit);

  // Update stats
  deskData.lifetimeStats.totalTrades++;
  deskData.lifetimeStats.totalProfit += profit;

  if (won) {
    deskData.lifetimeStats.wins++;
    deskData.lifetimeStats.avgWin =
      (deskData.lifetimeStats.avgWin * (deskData.lifetimeStats.wins - 1) + profit) / deskData.lifetimeStats.wins;

    // Update streak
    if (deskData.lifetimeStats.streakType === 'WIN') {
      deskData.lifetimeStats.currentStreak++;
    } else {
      deskData.lifetimeStats.streakType = 'WIN';
      deskData.lifetimeStats.currentStreak = 1;
    }

    if (deskData.lifetimeStats.currentStreak > deskData.lifetimeStats.longestWinStreak) {
      deskData.lifetimeStats.longestWinStreak = deskData.lifetimeStats.currentStreak;
    }

    // Lotto ticket tracking (Degen only)
    if (desk === 'DEGEN' && position.lottoTicket) {
      deskData.lifetimeStats.lottoTicketWins++;
      const totalLottos = deskData.openPositions.filter(p => p.lottoTicket).length +
        (position.lottoTicket ? 1 : 0);
      deskData.lifetimeStats.lottoTicketHitRate =
        deskData.lifetimeStats.lottoTicketWins / totalLottos;
    }
  } else {
    deskData.lifetimeStats.losses++;
    deskData.lifetimeStats.avgLoss =
      (deskData.lifetimeStats.avgLoss * (deskData.lifetimeStats.losses - 1) + profit) / deskData.lifetimeStats.losses;

    // Update streak
    if (deskData.lifetimeStats.streakType === 'LOSS') {
      deskData.lifetimeStats.currentStreak++;
    } else {
      deskData.lifetimeStats.streakType = 'LOSS';
      deskData.lifetimeStats.currentStreak = 1;
    }

    if (deskData.lifetimeStats.currentStreak > deskData.lifetimeStats.longestLossStreak) {
      deskData.lifetimeStats.longestLossStreak = deskData.lifetimeStats.currentStreak;
    }
  }

  // Update win rate
  deskData.lifetimeStats.winRate = deskData.lifetimeStats.wins / deskData.lifetimeStats.totalTrades;

  // Update ROI
  deskData.lifetimeStats.roi = deskData.lifetimeStats.totalProfit / deskData.inceptionBalance;

    // FIX #3: Use unified calculation for exposure and available capital
    recalculateAvailableCapital(deskData);

    // Update fund totals (all 3 desks)
  VIRTUAL_ACCOUNTS.fund.totalBalance =
    VIRTUAL_ACCOUNTS.desks.FARM.currentBalance +
    VIRTUAL_ACCOUNTS.desks.DEGEN.currentBalance +
    (VIRTUAL_ACCOUNTS.desks.CLIPPER ? VIRTUAL_ACCOUNTS.desks.CLIPPER.currentBalance : 0);
  VIRTUAL_ACCOUNTS.fund.lifetimeProfit =
    VIRTUAL_ACCOUNTS.desks.FARM.lifetimeStats.totalProfit +
    VIRTUAL_ACCOUNTS.desks.DEGEN.lifetimeStats.totalProfit +
    (VIRTUAL_ACCOUNTS.desks.CLIPPER ? VIRTUAL_ACCOUNTS.desks.CLIPPER.lifetimeStats.totalProfit : 0);
  VIRTUAL_ACCOUNTS.fund.lifetimeRoi = VIRTUAL_ACCOUNTS.fund.lifetimeProfit / VIRTUAL_ACCOUNTS.fund.inceptionBalance;

  console.log(JSON.stringify({
    action: 'POSITION_SETTLED',
    txId: txId,  // Audit trail for atomic settlement
    desk: desk,
    window: windowSlug,
    side: position.side,
    winner: winner,
    won: won,
    profit: profit.toFixed(2),
    roi: (profit / position.costBasis * 100).toFixed(1) + '%',
    newBalance: deskData.currentBalance.toFixed(2),
    winRate: (deskData.lifetimeStats.winRate * 100).toFixed(1) + '%',
    currentStreak: deskData.lifetimeStats.currentStreak + ' ' + deskData.lifetimeStats.streakType,
    timestamp: new Date().toISOString()
  }));

    saveAccounts();

    return {
      won: won,
      profit: profit,
      roi: profit / position.costBasis,
      newBalance: deskData.currentBalance,
      txId: txId  // Return txId for verification
    };
  } finally {
    // FIX #2: Always release lock, even on error
    settlingPositions.delete(lockKey);
  }
}

// ============================================================
// REBALANCING
// ============================================================

function checkRebalancing() {
  const farm = VIRTUAL_ACCOUNTS.desks.FARM;
  const degen = VIRTUAL_ACCOUNTS.desks.DEGEN;

  // SCENARIO 1: Degen wins big (+$10+ in last 5 windows)
  const degenRecent5Profit = calculateRecentProfit('DEGEN', 5);
  if (degenRecent5Profit >= 10.00) {
    const transferAmount = degenRecent5Profit * 0.70; // 70% to Farm
    executeDeskTransfer('DEGEN', 'FARM', transferAmount, 'degen_wins_transfer',
      `Degen won +$${degenRecent5Profit.toFixed(2)} in last 5 windows, transferring 70% to Farm`);
    return;
  }

  // SCENARIO 2: Degen balance critical (below 37.5% of inception)
  const degenCriticalThreshold = degen.inceptionBalance * 0.375; // ~$3 if started at $8
  if (degen.currentBalance < degenCriticalThreshold) {
    const refuelAmount = degen.inceptionBalance - degen.currentBalance;
    if (farm.currentBalance >= refuelAmount) {
      executeDeskTransfer('FARM', 'DEGEN', refuelAmount, 'degen_refuel',
        `Degen balance critical at $${degen.currentBalance.toFixed(2)}, refueling to $${degen.inceptionBalance.toFixed(2)}`);
      return;
    }
  }

  // SCENARIO 3: Emergency refuel (below 25% of inception)
  const degenEmergencyThreshold = degen.inceptionBalance * 0.25; // ~$2 if started at $8
  const emergencyRefuelAmount = degen.inceptionBalance * 0.625; // ~$5 if started at $8
  if (degen.currentBalance < degenEmergencyThreshold && farm.currentBalance >= emergencyRefuelAmount) {
    executeDeskTransfer('FARM', 'DEGEN', emergencyRefuelAmount, 'emergency_refuel',
      `🚨 EMERGENCY: Degen balance dropped to $${degen.currentBalance.toFixed(2)}`);
    return;
  }

  // SCENARIO 4: Maintain 80/20 ratio if imbalance >$5
  const totalBalance = farm.currentBalance + degen.currentBalance;
  const targetFarmBalance = totalBalance * 0.80;
  const targetDegenBalance = totalBalance * 0.20;
  const farmImbalance = Math.abs(farm.currentBalance - targetFarmBalance);
  const degenImbalance = Math.abs(degen.currentBalance - targetDegenBalance);

  if (farmImbalance > 5.00 || degenImbalance > 5.00) {
    if (farm.currentBalance > targetFarmBalance) {
      const transfer = farm.currentBalance - targetFarmBalance;
      executeDeskTransfer('FARM', 'DEGEN', transfer, 'ratio_rebalance',
        `Rebalancing to 80/20 ratio (Farm had $${farmImbalance.toFixed(2)} excess)`);
    } else if (degen.currentBalance > targetDegenBalance) {
      const transfer = degen.currentBalance - targetDegenBalance;
      executeDeskTransfer('DEGEN', 'FARM', transfer, 'ratio_rebalance',
        `Rebalancing to 80/20 ratio (Degen had $${degenImbalance.toFixed(2)} excess)`);
    }
  }

  // FIX #12: SCENARIO 5 - CLIPPER needs refuel
  const clipper = VIRTUAL_ACCOUNTS.desks.CLIPPER;
  if (clipper) {
    const clipperMinBalance = VIRTUAL_ACCOUNTS.fund.totalBalance * 0.05;  // 5% minimum

    if (clipper.currentBalance < clipperMinBalance && farm.availableCapital > clipperMinBalance) {
      const refuelAmount = Math.min(clipperMinBalance, farm.availableCapital * 0.10);
      console.log(JSON.stringify({
        action: 'CLIPPER_REFUEL_TRIGGERED',
        clipperBalance: clipper.currentBalance.toFixed(2),
        threshold: clipperMinBalance.toFixed(2),
        refuelAmount: refuelAmount.toFixed(2),
        timestamp: new Date().toISOString()
      }));
      executeDeskTransfer('FARM', 'CLIPPER', refuelAmount, 'clipper_refuel',
        `CLIPPER below 5% threshold ($${clipper.currentBalance.toFixed(2)} < $${clipperMinBalance.toFixed(2)})`);
    }
  }
}

function executeDeskTransfer(fromDesk, toDesk, amount, type, reason) {
  // FIX #12: Allow CLIPPER desk in transfers
  const validDesks = ['FARM', 'DEGEN', 'CLIPPER'];
  if (!validDesks.includes(fromDesk) || !validDesks.includes(toDesk)) {
    throw new Error(`Invalid desk in transfer: ${fromDesk} → ${toDesk}`);
  }

  const from = VIRTUAL_ACCOUNTS.desks[fromDesk];
  const to = VIRTUAL_ACCOUNTS.desks[toDesk];

  // Ensure sufficient balance
  if (from.currentBalance < amount) {
    console.warn(JSON.stringify({
      action: 'REBALANCING_FAILED',
      reason: `Insufficient balance in ${fromDesk}`,
      available: from.currentBalance.toFixed(2),
      requested: amount.toFixed(2)
    }));
    return;
  }

  // Execute transfer
  const fromBefore = from.currentBalance;
  const toBefore = to.currentBalance;

  from.currentBalance -= amount;
  from.availableCapital = from.currentBalance - from.totalExposure;

  to.currentBalance += amount;
  to.availableCapital = to.currentBalance - to.totalExposure;

  // Record in history
  VIRTUAL_ACCOUNTS.rebalancingHistory.push({
    timestamp: new Date().toISOString(),
    type: type,
    reason: reason,
    fromDesk: fromDesk,
    toDesk: toDesk,
    amount: amount,
    fromBefore: fromBefore,
    fromAfter: from.currentBalance,
    toBefore: toBefore,
    toAfter: to.currentBalance
  });

  const emoji = fromDesk === 'DEGEN' ? '🎰→🏦' : '🏦→🎰';

  console.log(JSON.stringify({
    action: 'REBALANCING_EXECUTED',
    emoji: emoji,
    type: type,
    from: fromDesk,
    to: toDesk,
    amount: amount.toFixed(2),
    reason: reason,
    farmBalance: VIRTUAL_ACCOUNTS.desks.FARM.currentBalance.toFixed(2),
    degenBalance: VIRTUAL_ACCOUNTS.desks.DEGEN.currentBalance.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  saveAccounts();
}

function calculateRecentProfit(desk, numWindows) {
  const deskData = VIRTUAL_ACCOUNTS?.desks?.[desk];
  if (!deskData) return 0.00;

  const stats = deskData.lifetimeStats;

  // If we have fewer trades than requested windows, return total profit
  if (stats.totalTrades < numWindows) {
    return stats.totalProfit;
  }

  // Approximate recent profit from average trade profit and recent streak
  // This is an estimation since we don't track per-window P&L history
  const avgTradeProfit = stats.totalProfit / stats.totalTrades;

  // Weight recent trades more heavily based on streak
  if (stats.streakType === 'WIN' && stats.currentStreak > 0) {
    // Recent wins - estimate recent profit is above average
    const recentMultiplier = 1 + (stats.currentStreak * 0.1);
    return avgTradeProfit * Math.min(numWindows, stats.totalTrades) * recentMultiplier;
  } else if (stats.streakType === 'LOSS' && stats.currentStreak > 0) {
    // Recent losses - estimate recent profit is below average
    const recentMultiplier = 1 - (stats.currentStreak * 0.1);
    return avgTradeProfit * Math.min(numWindows, stats.totalTrades) * recentMultiplier;
  }

  // Default: use average
  return avgTradeProfit * Math.min(numWindows, stats.totalTrades);
}

// ============================================================
// GET OPEN POSITIONS
// ============================================================

function getOpenPositions(desk) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }

  return VIRTUAL_ACCOUNTS.desks[desk].openPositions || [];
}

// ============================================================
// STRADDLE TRACKING (Clipper desk)
// ============================================================

/**
 * Record a straddle position (buying both YES and NO)
 * @param {string} desk - Desk name (typically 'CLIPPER')
 * @param {string} windowSlug - Window identifier
 * @param {Object} straddleData - Straddle details
 */
function recordStraddle(desk, windowSlug, straddleData) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }

  const deskData = VIRTUAL_ACCOUNTS.desks[desk];

  // Add to straddle positions
  deskData.straddlePositions.push({
    windowSlug: windowSlug,
    yesShares: straddleData.yesShares,
    noShares: straddleData.noShares,
    yesCost: straddleData.yesCost,
    noCost: straddleData.noCost,
    totalCost: straddleData.totalCost,
    timestamp: straddleData.timestamp,
    settled: straddleData.settled || false
  });

  // Update Clipper-specific stats
  if (desk === 'CLIPPER') {
    deskData.lifetimeStats.straddlesCost += straddleData.totalCost;
  }

  console.log(JSON.stringify({
    action: 'STRADDLE_RECORDED',
    desk: desk,
    window: windowSlug,
    yesShares: straddleData.yesShares.toFixed(2),
    noShares: straddleData.noShares.toFixed(2),
    totalCost: straddleData.totalCost.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  saveAccounts();
}

/**
 * Get straddle positions for a desk
 * @param {string} desk - Desk name
 * @returns {Array} Array of straddle positions
 */
function getStraddlePositions(desk) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }

  return VIRTUAL_ACCOUNTS.desks[desk].straddlePositions || [];
}

// ============================================================
// CLIP TRACKING (Clipper desk)
// ============================================================

/**
 * Record a clip (profit-taking exit)
 * @param {string} desk - Desk name
 * @param {number} clipProfit - Profit from clip
 * @param {number} clipPercentage - Percentage of position clipped (0-1)
 */
function recordClip(desk, clipProfit, clipPercentage) {
  if (desk !== 'FARM' && desk !== 'DEGEN' && desk !== 'CLIPPER') {
    throw new Error(`Invalid desk: ${desk}`);
  }

  const deskData = VIRTUAL_ACCOUNTS.desks[desk];

  // Update Clipper-specific stats
  if (desk === 'CLIPPER' || deskData.lifetimeStats.clipsExecuted !== undefined) {
    const prevAvgClipProfit = deskData.lifetimeStats.avgClipProfit || 0;
    const prevClipsExecuted = deskData.lifetimeStats.clipsExecuted || 0;

    deskData.lifetimeStats.clipsExecuted = prevClipsExecuted + 1;
    deskData.lifetimeStats.avgClipProfit =
      (prevAvgClipProfit * prevClipsExecuted + clipProfit) / deskData.lifetimeStats.clipsExecuted;

    // Track emergency clips (>100% gain)
    if (clipProfit > 0 && clipPercentage >= 0.50) {
      deskData.lifetimeStats.emergencyClips = (deskData.lifetimeStats.emergencyClips || 0) + 1;
    }
  }

  console.log(JSON.stringify({
    action: 'CLIP_RECORDED',
    desk: desk,
    clipProfit: clipProfit.toFixed(2),
    clipPercentage: (clipPercentage * 100).toFixed(0) + '%',
    totalClipsExecuted: deskData.lifetimeStats.clipsExecuted || 'N/A',
    avgClipProfit: deskData.lifetimeStats.avgClipProfit ? deskData.lifetimeStats.avgClipProfit.toFixed(2) : 'N/A',
    timestamp: new Date().toISOString()
  }));

  saveAccounts();
}

// ============================================================
// STALE POSITION CLEANUP (Self-Healing)
// ============================================================

/**
 * Remove positions from expired windows.
 * Call on startup and periodically during runtime.
 * This makes the bot self-healing - it cleans up after crashes/failures.
 *
 * @returns {Object} { removed: number, remaining: number }
 */
function cleanupExpiredPositions() {
  // Guard: If accounts not initialized yet, nothing to clean
  if (!VIRTUAL_ACCOUNTS || !VIRTUAL_ACCOUNTS.desks) {
    return { removed: 0, remaining: 0 };
  }

  const now = Math.floor(Date.now() / 1000);
  let totalRemoved = 0;

  for (const deskName of Object.keys(VIRTUAL_ACCOUNTS.desks)) {
    const desk = VIRTUAL_ACCOUNTS.desks[deskName];
    const before = desk.openPositions.length;

    desk.openPositions = desk.openPositions.filter(pos => {
      // Extract timestamp from windowSlug: "btc-updown-15m-1769908500"
      const match = pos.windowSlug.match(/(\d+)$/);
      if (!match) return false;  // Invalid slug, remove it

      const windowStart = parseInt(match[1], 10);
      const windowEnd = windowStart + 900;  // 15 minutes
      const isExpired = windowEnd < now;

      if (isExpired) {
        console.log(JSON.stringify({
          action: 'CLEANUP_EXPIRED_POSITION',
          desk: deskName,
          windowSlug: pos.windowSlug,
          side: pos.side,
          costBasis: pos.costBasis,
          expiredSecondsAgo: now - windowEnd,
          timestamp: new Date().toISOString()
        }));
      }

      return !isExpired;  // Keep only non-expired
    });

    totalRemoved += (before - desk.openPositions.length);

    // Recalculate exposure from remaining positions
    desk.totalExposure = desk.openPositions.reduce((sum, p) => sum + p.costBasis, 0);
    desk.availableCapital = desk.currentBalance - desk.totalExposure;
  }

  if (totalRemoved > 0) {
    saveAccounts();
    console.log(JSON.stringify({
      action: 'CLEANUP_COMPLETE',
      positionsRemoved: totalRemoved,
      timestamp: new Date().toISOString()
    }));
  }

  return {
    removed: totalRemoved,
    remaining: VIRTUAL_ACCOUNTS?.desks
      ? Object.values(VIRTUAL_ACCOUNTS.desks).reduce((sum, d) => sum + d.openPositions.length, 0)
      : 0
  };
}

// ============================================================
// DYNAMIC RISK CAP (Fractal Scaling)
// ============================================================

/**
 * Calculate dynamic per-window risk cap (15% of War Chest)
 * This is the maximum dollars we can risk in a single 15-minute window.
 *
 * The bot becomes "fractal" - trades the same way with $50 or $50,000
 *
 * @returns {number} Max exposure in dollars for this window
 */
function getPerWindowRiskCap() {
  // Import wealth fortress to get War Chest
  let wealthFortress;
  try {
    wealthFortress = require('./wealth-fortress');
  } catch (e) {
    // Fallback: use 15% of total balance
    const totalBalance = VIRTUAL_ACCOUNTS?.fund?.totalBalance || 36.00;
    return Math.max(1.00, totalBalance * 0.15);
  }

  const warChest = wealthFortress.getTradeableBalance();
  const RISK_PERCENTAGE = 0.15;  // 15% of War Chest per window

  let cap = warChest * RISK_PERCENTAGE;

  // Safety Floor: At least $1 for lotto tickets if we have funds
  if (cap < 1.00 && warChest > 1.00) {
    cap = 1.00;
  }

  return parseFloat(cap.toFixed(2));
}

/**
 * Get total exposure across ALL desks for current window
 * Used for global cap enforcement - prevents any single window
 * from draining the entire War Chest
 *
 * @returns {number} Total exposure in dollars across all desks
 */
function getTotalWindowExposure() {
  if (!VIRTUAL_ACCOUNTS?.desks) return 0;

  let total = 0;
  for (const deskName of Object.keys(VIRTUAL_ACCOUNTS.desks)) {
    const desk = VIRTUAL_ACCOUNTS.desks[deskName];
    total += desk.totalExposure || 0;
  }
  return total;
}

/**
 * Update all open positions with current market prices
 * Call this before any clipping decision to have accurate unrealizedPL
 *
 * @param {Object} marketData - Current market data with yesPrice and noPrice
 */
function updatePositionValues(marketData) {
  if (!marketData || typeof marketData.yesPrice !== 'number' || typeof marketData.noPrice !== 'number') {
    return;
  }

  if (!VIRTUAL_ACCOUNTS?.desks) return;

  for (const deskName of Object.keys(VIRTUAL_ACCOUNTS.desks)) {
    const desk = VIRTUAL_ACCOUNTS.desks[deskName];

    for (const position of desk.openPositions) {
      const currentPrice = position.side === 'YES' ? marketData.yesPrice : marketData.noPrice;
      position.currentValue = position.shares * currentPrice;
      position.unrealizedPL = position.currentValue - position.costBasis;
      position.lastPriceUpdate = Date.now();
    }
  }
}

/**
 * Mark a straddle as settled after window closes
 *
 * @param {string} desk - Desk name (CLIPPER)
 * @param {string} windowSlug - Window identifier
 * @param {string} winner - Winning side ('YES' or 'NO')
 */
function settleStraddle(desk, windowSlug, winner) {
  const deskData = VIRTUAL_ACCOUNTS?.desks?.[desk];
  if (!deskData?.straddlePositions) return null;

  const straddleIndex = deskData.straddlePositions.findIndex(
    s => s.windowSlug === windowSlug && !s.settled
  );

  if (straddleIndex === -1) return null;

  const straddle = deskData.straddlePositions[straddleIndex];

  // Calculate payout (winner side pays out at $1, loser side is $0)
  const winningShares = winner === 'YES' ? straddle.yesShares : straddle.noShares;
  const payout = winningShares * 1.00;
  const profit = payout - straddle.totalCost;

  // Mark as settled
  straddle.settled = true;
  straddle.settledAt = new Date().toISOString();
  straddle.winner = winner;
  straddle.profit = profit;

  // Update balance
  deskData.currentBalance += payout;
  deskData.availableCapital = deskData.currentBalance - deskData.totalExposure;

  console.log(JSON.stringify({
    action: 'STRADDLE_SETTLED',
    desk: desk,
    window: windowSlug,
    winner: winner,
    profit: profit.toFixed(2),
    newBalance: deskData.currentBalance.toFixed(2),
    timestamp: new Date().toISOString()
  }));

  saveAccounts();

  return { profit, payout };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initializeVirtualAccounts,
  getAccounts,
  getDeskBalance,
  getDeskAvailableCapital,
  getDeskStats,
  getOpenPositions,
  recordTrade,
  settlePosition,
  checkRebalancing,
  executeDeskTransfer,
  recordStraddle,        // Straddle tracking
  getStraddlePositions,  // Get straddles
  recordClip,            // Clip tracking
  saveAccounts,          // Expose save function for clipper-desk-manager
  getPerWindowRiskCap,   // Dynamic risk scaling
  getTotalWindowExposure, // Global cap enforcement
  updatePositionValues,   // Real-time P&L updates
  settleStraddle,         // Straddle settlement
  cleanupExpiredPositions // Self-healing cleanup
};
