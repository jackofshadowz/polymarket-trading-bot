const fs = require('fs');
const path = require('path');

// ============================================================
// LEADERBOARD TRACKER
// Tracks desk/player performance, rankings, and milestones
// ============================================================

const LEADERBOARD_FILE = '/tmp/polymarket-leaderboard.json';

let LEADERBOARD = {
  desks: [],
  players: [],
  milestones: []
};

// ============================================================
// INITIALIZATION
// ============================================================

function initializeLeaderboard() {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const data = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
      LEADERBOARD = JSON.parse(data);

      console.log(JSON.stringify({
        action: 'LEADERBOARD_LOADED',
        desks: LEADERBOARD.desks.length,
        players: LEADERBOARD.players.length,
        milestones: LEADERBOARD.milestones.length,
        timestamp: new Date().toISOString()
      }));
    } else {
      // Initialize empty leaderboard
      LEADERBOARD = {
        desks: [
          {
            rank: 1,
            desk: 'FARM',
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0.000,
            totalProfit: 0.00,
            roi: 0.000,
            sharpeRatio: 0.00,
            longestWinStreak: 0,
            currentStreak: 0,
            streakType: null,
            badge: null
          },
          {
            rank: 2,
            desk: 'DEGEN',
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRate: 0.000,
            totalProfit: 0.00,
            roi: 0.000,
            sharpeRatio: 0.00,
            longestWinStreak: 0,
            currentStreak: 0,
            streakType: null,
            lottoTicketWins: 0,
            lottoTicketHitRate: 0.000,
            badge: null
          }
        ],
        players: [
          {
            rank: 1,
            player: 'FARM_TRADER',
            desk: 'FARM',
            decisionsProposed: 0,
            decisionsApproved: 0,
            approvalRate: 0.000,
            avgConfidence: 0.000,
            badge: null
          },
          {
            rank: 2,
            player: 'FARM_RISK_MANAGER',
            desk: 'FARM',
            reviewsCompleted: 0,
            vetoesIssued: 0,
            vetoRate: 0.000,
            adjustmentsMade: 0,
            badge: null
          },
          {
            rank: 3,
            player: 'DEGEN_TRADER',
            desk: 'DEGEN',
            decisionsProposed: 0,
            decisionsApproved: 0,
            approvalRate: 0.000,
            avgConfidence: 0.000,
            lottoTicketsProposed: 0,
            badge: null
          },
          {
            rank: 4,
            player: 'DEGEN_RISK_MANAGER',
            desk: 'DEGEN',
            reviewsCompleted: 0,
            vetoesIssued: 0,
            vetoRate: 0.000,
            adjustmentsMade: 0,
            badge: null
          },
          {
            rank: 5,
            player: 'SUPERVISOR',
            desk: 'SUPERVISOR',
            arbitrationsCompleted: 0,
            bothDesksApproved: 0,
            conflictsResolved: 0,
            rebalancingActions: 0,
            badge: null
          }
        ],
        milestones: []
      };

      saveLeaderboard();

      console.log(JSON.stringify({
        action: 'LEADERBOARD_INITIALIZED',
        timestamp: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      action: 'LEADERBOARD_INIT_ERROR',
      error: error.message
    }));
  }
}

function saveLeaderboard() {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(LEADERBOARD, null, 2), 'utf8');
  } catch (error) {
    console.error(JSON.stringify({
      action: 'LEADERBOARD_SAVE_ERROR',
      error: error.message
    }));
  }
}

// ============================================================
// DESK STATS UPDATE
// ============================================================

function updateDeskStats(desk, stats) {
  const deskEntry = LEADERBOARD.desks.find(d => d.desk === desk);

  if (!deskEntry) {
    console.error(JSON.stringify({
      action: 'DESK_UPDATE_ERROR',
      error: `Desk ${desk} not found`
    }));
    return;
  }

  // Update stats
  deskEntry.totalTrades = stats.totalTrades;
  deskEntry.wins = stats.wins;
  deskEntry.losses = stats.losses;
  deskEntry.winRate = stats.winRate;
  deskEntry.totalProfit = stats.totalProfit;
  deskEntry.roi = stats.roi;
  deskEntry.sharpeRatio = stats.sharpeRatio || 0.00;
  deskEntry.longestWinStreak = stats.longestWinStreak;
  deskEntry.currentStreak = stats.currentStreak;
  deskEntry.streakType = stats.streakType;

  if (desk === 'DEGEN') {
    deskEntry.lottoTicketWins = stats.lottoTicketWins || 0;
    deskEntry.lottoTicketHitRate = stats.lottoTicketHitRate || 0.000;
  }

  // Assign badges
  assignDeskBadge(deskEntry);

  // Re-rank desks
  rankDesks();

  saveLeaderboard();

  console.log(JSON.stringify({
    action: 'DESK_STATS_UPDATED',
    desk: desk,
    rank: deskEntry.rank,
    winRate: (deskEntry.winRate * 100).toFixed(1) + '%',
    roi: (deskEntry.roi * 100).toFixed(1) + '%',
    badge: deskEntry.badge,
    timestamp: new Date().toISOString()
  }));
}

function assignDeskBadge(deskEntry) {
  // Farm badges
  if (deskEntry.desk === 'FARM') {
    if (deskEntry.winRate >= 0.75) {
      deskEntry.badge = '🏆 Capital Protector';
    } else if (deskEntry.winRate >= 0.65) {
      deskEntry.badge = '🛡️ Steady Hand';
    } else if (deskEntry.longestWinStreak >= 10) {
      deskEntry.badge = '🔥 Streak Master';
    } else {
      deskEntry.badge = '🏦 Institutional';
    }
  }

  // Degen badges
  if (deskEntry.desk === 'DEGEN') {
    if (deskEntry.lottoTicketWins >= 10) {
      deskEntry.badge = '🎰 Lotto King';
    } else if (deskEntry.roi >= 1.00) {
      deskEntry.badge = '💎 Diamond Hands';
    } else if (deskEntry.winRate >= 0.60) {
      deskEntry.badge = '🚀 Moon Mission';
    } else if (deskEntry.lottoTicketHitRate >= 0.20) {
      deskEntry.badge = '🎯 Sharp Shooter';
    } else {
      deskEntry.badge = '🎲 Risk Taker';
    }
  }
}

function rankDesks() {
  // Sort by ROI (primary) and win rate (secondary)
  LEADERBOARD.desks.sort((a, b) => {
    if (Math.abs(a.roi - b.roi) > 0.05) {
      return b.roi - a.roi; // Higher ROI = better rank
    }
    return b.winRate - a.winRate; // Higher win rate = better rank
  });

  // Update ranks
  LEADERBOARD.desks.forEach((desk, index) => {
    desk.rank = index + 1;
  });
}

// ============================================================
// PLAYER STATS UPDATE
// ============================================================

function updatePlayerStats(player, updates) {
  const playerEntry = LEADERBOARD.players.find(p => p.player === player);

  if (!playerEntry) {
    console.error(JSON.stringify({
      action: 'PLAYER_UPDATE_ERROR',
      error: `Player ${player} not found`
    }));
    return;
  }

  // Merge updates
  Object.assign(playerEntry, updates);

  // Recalculate rates
  if (playerEntry.decisionsProposed > 0) {
    playerEntry.approvalRate = playerEntry.decisionsApproved / playerEntry.decisionsProposed;
  }

  if (playerEntry.reviewsCompleted > 0) {
    playerEntry.vetoRate = playerEntry.vetoesIssued / playerEntry.reviewsCompleted;
  }

  // Assign badges
  assignPlayerBadge(playerEntry);

  // Re-rank players
  rankPlayers();

  saveLeaderboard();

  console.log(JSON.stringify({
    action: 'PLAYER_STATS_UPDATED',
    player: player,
    rank: playerEntry.rank,
    badge: playerEntry.badge,
    timestamp: new Date().toISOString()
  }));
}

function assignPlayerBadge(playerEntry) {
  const player = playerEntry.player;

  if (player === 'FARM_TRADER') {
    if (playerEntry.approvalRate >= 0.90) {
      playerEntry.badge = '🧠 Institutional Mind';
    } else if (playerEntry.avgConfidence >= 0.75) {
      playerEntry.badge = '💪 High Conviction';
    } else {
      playerEntry.badge = '📊 Analyst';
    }
  }

  if (player === 'FARM_RISK_MANAGER') {
    if (playerEntry.vetoRate >= 0.30) {
      playerEntry.badge = '🚨 Strict Gatekeeper';
    } else if (playerEntry.adjustmentsMade >= 20) {
      playerEntry.badge = '⚖️ Fine Tuner';
    } else {
      playerEntry.badge = '🛡️ Risk Guardian';
    }
  }

  if (player === 'DEGEN_TRADER') {
    if (playerEntry.lottoTicketsProposed >= 15) {
      playerEntry.badge = '🎰 Lotto Hunter';
    } else if (playerEntry.avgConfidence >= 0.70) {
      playerEntry.badge = '🔥 Aggressive Alpha';
    } else {
      playerEntry.badge = '🎲 Edge Seeker';
    }
  }

  if (player === 'DEGEN_RISK_MANAGER') {
    if (playerEntry.vetoRate <= 0.10) {
      playerEntry.badge = '✅ Green Light';
    } else if (playerEntry.vetoRate >= 0.30) {
      playerEntry.badge = '🛑 Fun Police';
    } else {
      playerEntry.badge = '🔍 Math Checker';
    }
  }

  if (player === 'SUPERVISOR') {
    if (playerEntry.bothDesksApproved >= 10) {
      playerEntry.badge = '🤝 Dual Approver';
    } else if (playerEntry.conflictsResolved >= 5) {
      playerEntry.badge = '⚖️ Arbiter';
    } else {
      playerEntry.badge = '👔 Overseer';
    }
  }
}

function rankPlayers() {
  // Traders ranked by approval rate
  // Risk managers ranked by balance of vetos/adjustments
  // Supervisor ranked by successful arbitrations

  // For now, keep default order
  LEADERBOARD.players.forEach((player, index) => {
    player.rank = index + 1;
  });
}

// ============================================================
// MILESTONE TRACKING
// ============================================================

function checkMilestones(desk, event, data) {
  const milestones = [];

  // 10-win streak
  if (event === 'WIN_STREAK' && data.streak >= 10) {
    milestones.push({
      date: new Date().toISOString(),
      desk: desk,
      event: `${desk} hit ${data.streak}-win streak`,
      profit: data.totalProfit || 0.00,
      badge: '🔥 STREAK MASTER'
    });
  }

  // 50:1 lotto ticket hit
  if (event === 'LOTTO_HIT' && data.payoffRatio >= 50.0) {
    milestones.push({
      date: new Date().toISOString(),
      desk: desk,
      event: `${desk} hit ${data.payoffRatio.toFixed(1)}:1 lotto ticket`,
      profit: data.profit,
      badge: '💰 JACKPOT'
    });
  }

  // Double account (100% ROI)
  if (event === 'DOUBLE_ACCOUNT' && data.roi >= 1.00) {
    milestones.push({
      date: new Date().toISOString(),
      desk: desk,
      event: `${desk} doubled account (${(data.roi * 100).toFixed(0)}% ROI)`,
      profit: data.totalProfit,
      badge: '💎 DOUBLED'
    });
  }

  // 10+ trades with 80%+ win rate
  if (event === 'HIGH_WIN_RATE' && data.trades >= 10 && data.winRate >= 0.80) {
    milestones.push({
      date: new Date().toISOString(),
      desk: desk,
      event: `${desk} achieved ${(data.winRate * 100).toFixed(0)}% win rate over ${data.trades} trades`,
      profit: data.totalProfit || 0.00,
      badge: '🏆 ELITE TRADER'
    });
  }

  // Emergency refuel survived
  if (event === 'EMERGENCY_REFUEL' && data.refuelAmount > 0) {
    milestones.push({
      date: new Date().toISOString(),
      desk: desk,
      event: `${desk} survived emergency refuel ($${data.refuelAmount.toFixed(2)})`,
      profit: -data.refuelAmount,
      badge: '🚨 SURVIVOR'
    });
  }

  // Big single win (+$20+)
  if (event === 'BIG_WIN' && data.profit >= 20.00) {
    milestones.push({
      date: new Date().toISOString(),
      desk: desk,
      event: `${desk} hit +$${data.profit.toFixed(2)} single trade`,
      profit: data.profit,
      badge: '🚀 BIG WIN'
    });
  }

  // Record milestones
  for (const milestone of milestones) {
    LEADERBOARD.milestones.push(milestone);

    console.log(JSON.stringify({
      action: 'MILESTONE_ACHIEVED',
      desk: desk,
      event: milestone.event,
      badge: milestone.badge,
      profit: milestone.profit.toFixed(2),
      timestamp: milestone.date
    }));
  }

  if (milestones.length > 0) {
    saveLeaderboard();
  }
}

// ============================================================
// QUERY FUNCTIONS
// ============================================================

function getLeaderboard() {
  return LEADERBOARD;
}

function getDeskRank(desk) {
  return LEADERBOARD.desks.find(d => d.desk === desk);
}

function getPlayerRank(player) {
  return LEADERBOARD.players.find(p => p.player === player);
}

function getRecentMilestones(count = 10) {
  return LEADERBOARD.milestones.slice(-count).reverse();
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initializeLeaderboard,
  updateDeskStats,
  updatePlayerStats,
  checkMilestones,
  getLeaderboard,
  getDeskRank,
  getPlayerRank,
  getRecentMilestones
};
