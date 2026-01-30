const fs = require('fs');
const path = require('path');

// ============================================================
// VIRTUAL ACCOUNT MANAGER
// Manages Farm (60%), Degen (25%), and Clipper (15%) virtual accounts
// ============================================================

const ACCOUNTS_FILE = '/tmp/polymarket-virtual-accounts.json';

let VIRTUAL_ACCOUNTS = null; // Initialized dynamically based on current balance

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
      // Initialize fresh with 60/25/15 split of current balance
      const farmBalance = currentBalance * 0.60;
      const degenBalance = currentBalance * 0.25;
      const clipperBalance = currentBalance * 0.15;

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
            allocation: 0.60,
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
            allocation: 0.25,
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
            allocation: 0.15,
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
        farmBalance: farmBalance.toFixed(2) + ' (60%)',
        degenBalance: degenBalance.toFixed(2) + ' (25%)',
        clipperBalance: clipperBalance.toFixed(2) + ' (15%)',
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

  // Update exposure
  deskData.totalExposure += costBasis;
  deskData.availableCapital -= costBasis;

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

  const deskData = VIRTUAL_ACCOUNTS.desks[desk];
  const positionIndex = deskData.openPositions.findIndex(p => p.windowSlug === windowSlug);

  if (positionIndex === -1) {
    return null; // No position for this desk in this window
  }

  const position = deskData.openPositions[positionIndex];
  const won = position.side === winner;

  // Calculate P&L
  const profit = won ?
    position.shares * (1.00 - position.entryPrice) :
    -position.costBasis;

  // Update balance
  deskData.currentBalance += (position.costBasis + profit);
  deskData.totalExposure -= position.costBasis;
  deskData.availableCapital = deskData.currentBalance - deskData.totalExposure;

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

  // Remove position
  deskData.openPositions.splice(positionIndex, 1);

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
    desk: desk,
    window: windowSlug,
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
    newBalance: deskData.currentBalance
  };
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
}

function executeDeskTransfer(fromDesk, toDesk, amount, type, reason) {
  if ((fromDesk !== 'FARM' && fromDesk !== 'DEGEN') ||
      (toDesk !== 'FARM' && toDesk !== 'DEGEN')) {
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
  // This would need to query dialogue history
  // For now, stub implementation
  return 0.00;
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
  recordStraddle,        // NEW: Straddle tracking
  getStraddlePositions,  // NEW: Get straddles
  recordClip,            // NEW: Clip tracking
  saveAccounts           // NEW: Expose save function for clipper-desk-manager
};
