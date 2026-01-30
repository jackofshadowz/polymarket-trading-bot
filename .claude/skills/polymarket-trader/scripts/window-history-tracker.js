#!/usr/bin/env node
// ============================================================
// WINDOW HISTORY TRACKER
// ============================================================
// Tracks outcomes of past windows to provide historical context
// for AI-powered trading decisions
//
// Key insights captured:
// - Win/loss record for each side (YES/NO)
// - Delta magnitude at decision time vs. final outcome
// - Price paid vs. final outcome
// - Streaks (consecutive wins/losses)
// - Correlation patterns (e.g., "delta >$100 wins 85% of time")

const fs = require('fs');
const path = require('path');

// History database file
const HISTORY_FILE = '/tmp/polymarket-window-history.json';

// In-memory history cache
const WINDOW_HISTORY = {
  windows: [],           // Array of window records
  totalTrades: 0,
  totalWins: 0,
  totalLosses: 0,
  currentStreak: 0,      // Positive = win streak, negative = loss streak
  streakType: null,      // 'WIN' | 'LOSS'
  maxHistory: 200        // Keep last 200 windows
};

/**
 * Load history from disk
 */
function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = fs.readFileSync(HISTORY_FILE, 'utf8');
      const loaded = JSON.parse(data);
      Object.assign(WINDOW_HISTORY, loaded);
      console.log(JSON.stringify({
        action: 'HISTORY_LOADED',
        totalTrades: WINDOW_HISTORY.totalTrades,
        winRate: WINDOW_HISTORY.totalTrades > 0
          ? (WINDOW_HISTORY.totalWins / WINDOW_HISTORY.totalTrades * 100).toFixed(1) + '%'
          : 'N/A',
        currentStreak: WINDOW_HISTORY.currentStreak,
        timestamp: new Date().toISOString()
      }));
    }
  } catch (err) {
    console.error('Failed to load history:', err.message);
  }
}

/**
 * Save history to disk
 */
function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(WINDOW_HISTORY, null, 2));
  } catch (err) {
    console.error('Failed to save history:', err.message);
  }
}

/**
 * Record a trade decision (called when placing orders)
 */
function recordTradeDecision(windowSlug, side, priceData, marketData, reasoning) {
  const existing = WINDOW_HISTORY.windows.find(w => w.slug === windowSlug);

  if (existing) {
    // Add to existing window record
    existing.side = side;
    existing.avgEntryPrice = marketData.price;
    existing.deltaAtEntry = priceData.delta;
    existing.deltaPctAtEntry = priceData.deltaPct;
    existing.timeLeftAtEntry = marketData.timeLeft;
    existing.reasoning = reasoning;
    existing.entryTime = Date.now();
  } else {
    // Create new window record
    WINDOW_HISTORY.windows.push({
      slug: windowSlug,
      side: side,
      avgEntryPrice: marketData.price,
      deltaAtEntry: priceData.delta,
      deltaPctAtEntry: priceData.deltaPct,
      timeLeftAtEntry: marketData.timeLeft,
      openPrice: priceData.openPrice,
      reasoning: reasoning,
      entryTime: Date.now(),
      outcome: null,         // Will be filled when window closes
      won: null,
      profit: null,
      closePrice: null,
      finalDelta: null
    });
  }

  saveHistory();
}

/**
 * Record window outcome (called when window closes)
 */
function recordWindowOutcome(windowSlug, closePrice, finalDelta, winner) {
  const window = WINDOW_HISTORY.windows.find(w => w.slug === windowSlug);

  if (!window || !window.side) {
    // No trade in this window, skip
    return;
  }

  // Record outcome
  window.closePrice = closePrice;
  window.finalDelta = finalDelta;
  window.outcome = winner;
  window.won = window.side === winner;

  // Calculate profit/loss
  // If won: profit = (1.00 - avgEntryPrice) per share
  // If lost: loss = -avgEntryPrice per share
  window.profit = window.won
    ? (1.00 - window.avgEntryPrice)
    : -window.avgEntryPrice;

  // Update global stats
  WINDOW_HISTORY.totalTrades++;
  if (window.won) {
    WINDOW_HISTORY.totalWins++;
    if (WINDOW_HISTORY.streakType === 'WIN') {
      WINDOW_HISTORY.currentStreak++;
    } else {
      WINDOW_HISTORY.streakType = 'WIN';
      WINDOW_HISTORY.currentStreak = 1;
    }
  } else {
    WINDOW_HISTORY.totalLosses++;
    if (WINDOW_HISTORY.streakType === 'LOSS') {
      WINDOW_HISTORY.currentStreak++;
    } else {
      WINDOW_HISTORY.streakType = 'LOSS';
      WINDOW_HISTORY.currentStreak = 1;
    }
  }

  console.log(JSON.stringify({
    action: 'WINDOW_OUTCOME_RECORDED',
    window: windowSlug,
    side: window.side,
    outcome: winner,
    won: window.won,
    profit: window.profit.toFixed(3),
    totalWinRate: (WINDOW_HISTORY.totalWins / WINDOW_HISTORY.totalTrades * 100).toFixed(1) + '%',
    currentStreak: `${WINDOW_HISTORY.currentStreak} ${WINDOW_HISTORY.streakType}`,
    timestamp: new Date().toISOString()
  }));

  saveHistory();

  // Cleanup old windows (keep last maxHistory)
  if (WINDOW_HISTORY.windows.length > WINDOW_HISTORY.maxHistory) {
    WINDOW_HISTORY.windows = WINDOW_HISTORY.windows.slice(-WINDOW_HISTORY.maxHistory);
    saveHistory();
  }
}

/**
 * Get historical context for decision making
 */
function getHistoricalContext() {
  const recentWindows = WINDOW_HISTORY.windows.slice(-10).filter(w => w.outcome !== null);

  if (recentWindows.length === 0) {
    return {
      hasHistory: false,
      message: 'No historical data yet (first trade)'
    };
  }

  // Last 5 windows win rate
  const last5 = recentWindows.slice(-5);
  const last5Wins = last5.filter(w => w.won).length;
  const last5WinRate = (last5Wins / last5.length * 100).toFixed(1);

  // Last 10 windows win rate
  const last10Wins = recentWindows.filter(w => w.won).length;
  const last10WinRate = (last10Wins / recentWindows.length * 100).toFixed(1);

  // Overall win rate
  const overallWinRate = WINDOW_HISTORY.totalTrades > 0
    ? (WINDOW_HISTORY.totalWins / WINDOW_HISTORY.totalTrades * 100).toFixed(1)
    : '0.0';

  // Analyze delta magnitude correlations
  const deltaAnalysis = analyzeDeltaMagnitudeCorrelation(recentWindows);

  // Recent outcomes
  const recentOutcomes = last5.map(w => ({
    window: w.slug,
    side: w.side,
    deltaAtEntry: w.deltaAtEntry.toFixed(0),
    outcome: w.outcome,
    won: w.won,
    profit: w.profit.toFixed(3)
  }));

  return {
    hasHistory: true,
    totalTrades: WINDOW_HISTORY.totalTrades,
    overallWinRate: overallWinRate + '%',
    last5WinRate: last5WinRate + '%',
    last10WinRate: last10WinRate + '%',
    currentStreak: WINDOW_HISTORY.currentStreak,
    streakType: WINDOW_HISTORY.streakType,
    recentOutcomes: recentOutcomes,
    deltaAnalysis: deltaAnalysis,
    lastWindow: recentWindows[recentWindows.length - 1]
  };
}

/**
 * Analyze correlation between delta magnitude and win rate
 */
function analyzeDeltaMagnitudeCorrelation(windows) {
  const thresholds = [30, 50, 100, 150];
  const results = {};

  thresholds.forEach(threshold => {
    const trades = windows.filter(w => Math.abs(w.deltaAtEntry) >= threshold);
    if (trades.length > 0) {
      const wins = trades.filter(w => w.won).length;
      const winRate = (wins / trades.length * 100).toFixed(1);
      results[`delta_gte_${threshold}`] = {
        trades: trades.length,
        wins: wins,
        winRate: winRate + '%'
      };
    }
  });

  return results;
}

/**
 * Get last window outcome (for quick reference)
 */
function getLastWindowOutcome() {
  const completed = WINDOW_HISTORY.windows.filter(w => w.outcome !== null);
  if (completed.length === 0) return null;

  const last = completed[completed.length - 1];
  return {
    window: last.slug,
    side: last.side,
    outcome: last.outcome,
    won: last.won,
    profit: last.profit
  };
}

/**
 * Check if we're on a hot/cold streak
 */
function getStreakAnalysis() {
  if (!WINDOW_HISTORY.streakType) {
    return { hasStreak: false };
  }

  const streakLength = Math.abs(WINDOW_HISTORY.currentStreak);
  let analysis = '';

  if (WINDOW_HISTORY.streakType === 'WIN') {
    if (streakLength >= 5) {
      analysis = `🔥 HOT STREAK - ${streakLength} consecutive wins! High confidence.`;
    } else if (streakLength >= 3) {
      analysis = `On a roll - ${streakLength} wins in a row. Maintain discipline.`;
    } else {
      analysis = `${streakLength} win streak. Keep going.`;
    }
  } else {
    if (streakLength >= 5) {
      analysis = `❄️ COLD STREAK - ${streakLength} consecutive losses. Reduce position sizes and re-evaluate strategy.`;
    } else if (streakLength >= 3) {
      analysis = `Rough patch - ${streakLength} losses. Stay disciplined, don't chase losses.`;
    } else {
      analysis = `${streakLength} loss streak. Normal variance.`;
    }
  }

  return {
    hasStreak: true,
    type: WINDOW_HISTORY.streakType,
    length: streakLength,
    analysis: analysis
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  loadHistory,
  saveHistory,
  recordTradeDecision,
  recordWindowOutcome,
  getHistoricalContext,
  getLastWindowOutcome,
  getStreakAnalysis,
  WINDOW_HISTORY  // For debugging
};

// Auto-load on import
loadHistory();
