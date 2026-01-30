const fs = require('fs');
const path = require('path');

// ============================================================
// DIALOGUE RECORDER
// Records full 5-player trading desk dialogue for audit trail
// ============================================================

const DIALOGUE_FILE = '/tmp/polymarket-dialogue-history.json';

let DIALOGUE_HISTORY = {
  windows: []
};

// ============================================================
// INITIALIZATION
// ============================================================

function initializeDialogueRecorder() {
  try {
    if (fs.existsSync(DIALOGUE_FILE)) {
      const data = fs.readFileSync(DIALOGUE_FILE, 'utf8');
      DIALOGUE_HISTORY = JSON.parse(data);

      console.log(JSON.stringify({
        action: 'DIALOGUE_HISTORY_LOADED',
        totalWindows: DIALOGUE_HISTORY.windows.length,
        timestamp: new Date().toISOString()
      }));
    } else {
      saveDialogue();

      console.log(JSON.stringify({
        action: 'DIALOGUE_HISTORY_INITIALIZED',
        timestamp: new Date().toISOString()
      }));
    }
  } catch (error) {
    console.error(JSON.stringify({
      action: 'DIALOGUE_INIT_ERROR',
      error: error.message
    }));
  }
}

function saveDialogue() {
  try {
    fs.writeFileSync(DIALOGUE_FILE, JSON.stringify(DIALOGUE_HISTORY, null, 2), 'utf8');
  } catch (error) {
    console.error(JSON.stringify({
      action: 'DIALOGUE_SAVE_ERROR',
      error: error.message
    }));
  }
}

// ============================================================
// WINDOW MANAGEMENT
// ============================================================

function startWindowDialogue(windowSlug, marketData) {
  const windowRecord = {
    windowSlug: windowSlug,
    timestamp: new Date().toISOString(),
    marketData: {
      currentDelta: marketData.currentDelta,
      yesPrice: marketData.yesPrice,
      noPrice: marketData.noPrice,
      orderFlowImbalance: marketData.orderFlowImbalance,
      volatility: marketData.volatility
    },
    stages: [],
    execution: [],
    outcome: null
  };

  DIALOGUE_HISTORY.windows.push(windowRecord);
  saveDialogue();

  console.log(JSON.stringify({
    action: 'WINDOW_DIALOGUE_STARTED',
    window: windowSlug,
    timestamp: new Date().toISOString()
  }));

  return windowRecord;
}

function getCurrentWindow() {
  if (DIALOGUE_HISTORY.windows.length === 0) {
    return null;
  }
  return DIALOGUE_HISTORY.windows[DIALOGUE_HISTORY.windows.length - 1];
}

// ============================================================
// STAGE RECORDING (5 PLAYERS)
// ============================================================

function recordPlayerDecision(windowSlug, stage, desk, player, timeLeftInWindow, input, output, tokensUsed) {
  const currentWindow = getCurrentWindow();

  if (!currentWindow || currentWindow.windowSlug !== windowSlug) {
    console.error(JSON.stringify({
      action: 'DIALOGUE_RECORD_ERROR',
      error: `Window ${windowSlug} not started or mismatch`
    }));
    return;
  }

  const decisionRecord = {
    stage: stage, // 1 = Farm, 2 = Degen, 3 = Supervisor
    desk: desk, // 'FARM', 'DEGEN', or 'SUPERVISOR'
    player: player, // 'FARM_TRADER', 'FARM_RISK_MANAGER', etc.
    timestamp: new Date().toISOString(),
    timeLeftInWindow: timeLeftInWindow,
    input: input, // Market data + previous decisions
    output: output, // Decision object (side, confidence, position size, rationale, etc.)
    tokensUsed: tokensUsed
  };

  currentWindow.stages.push(decisionRecord);
  saveDialogue();

  console.log(JSON.stringify({
    action: 'PLAYER_DECISION_RECORDED',
    window: windowSlug,
    stage: stage,
    player: player,
    decision: output.decision,
    confidence: output.confidence,
    tokensUsed: tokensUsed,
    timestamp: new Date().toISOString()
  }));
}

// ============================================================
// EXECUTION RECORDING
// ============================================================

function recordExecution(windowSlug, desk, side, amount, price, shares, lottoTicket = false) {
  const currentWindow = getCurrentWindow();

  if (!currentWindow || currentWindow.windowSlug !== windowSlug) {
    console.error(JSON.stringify({
      action: 'EXECUTION_RECORD_ERROR',
      error: `Window ${windowSlug} not found`
    }));
    return;
  }

  const executionRecord = {
    desk: desk,
    side: side,
    amount: amount,
    price: price,
    shares: shares,
    lottoTicket: lottoTicket,
    timestamp: new Date().toISOString()
  };

  currentWindow.execution.push(executionRecord);
  saveDialogue();

  console.log(JSON.stringify({
    action: 'EXECUTION_RECORDED',
    window: windowSlug,
    desk: desk,
    side: side,
    amount: amount.toFixed(2),
    price: price.toFixed(3),
    lottoTicket: lottoTicket,
    timestamp: new Date().toISOString()
  }));
}

// ============================================================
// OUTCOME RECORDING
// ============================================================

function recordOutcome(windowSlug, winner, farmResult = null, degenResult = null) {
  const currentWindow = getCurrentWindow();

  if (!currentWindow || currentWindow.windowSlug !== windowSlug) {
    console.error(JSON.stringify({
      action: 'OUTCOME_RECORD_ERROR',
      error: `Window ${windowSlug} not found`
    }));
    return;
  }

  const outcomeRecord = {
    winner: winner,
    farmResult: farmResult,
    degenResult: degenResult,
    timestamp: new Date().toISOString()
  };

  currentWindow.outcome = outcomeRecord;
  saveDialogue();

  console.log(JSON.stringify({
    action: 'OUTCOME_RECORDED',
    window: windowSlug,
    winner: winner,
    farmProfit: farmResult ? farmResult.profit : null,
    degenProfit: degenResult ? degenResult.profit : null,
    timestamp: new Date().toISOString()
  }));
}

// ============================================================
// QUERY FUNCTIONS
// ============================================================

function getWindowDialogue(windowSlug) {
  return DIALOGUE_HISTORY.windows.find(w => w.windowSlug === windowSlug);
}

function getRecentWindows(count = 10) {
  return DIALOGUE_HISTORY.windows.slice(-count);
}

function getPlayerDecisions(player, count = 20) {
  const decisions = [];

  for (let i = DIALOGUE_HISTORY.windows.length - 1; i >= 0 && decisions.length < count; i--) {
    const window = DIALOGUE_HISTORY.windows[i];
    const playerStages = window.stages.filter(s => s.player === player);
    decisions.push(...playerStages.map(s => ({
      windowSlug: window.windowSlug,
      timestamp: s.timestamp,
      decision: s.output.decision,
      confidence: s.output.confidence,
      rationale: s.output.rationale
    })));
  }

  return decisions.slice(0, count);
}

function getDeskPerformance(desk, numWindows = 20) {
  const performance = {
    desk: desk,
    trades: 0,
    wins: 0,
    losses: 0,
    totalProfit: 0.00,
    avgProfit: 0.00,
    winRate: 0.000
  };

  for (let i = DIALOGUE_HISTORY.windows.length - 1; i >= 0 && performance.trades < numWindows; i--) {
    const window = DIALOGUE_HISTORY.windows[i];

    if (!window.outcome) continue;

    const result = desk === 'FARM' ? window.outcome.farmResult : window.outcome.degenResult;

    if (!result) continue;

    performance.trades++;
    if (result.won) {
      performance.wins++;
    } else {
      performance.losses++;
    }
    performance.totalProfit += result.profit;
  }

  if (performance.trades > 0) {
    performance.avgProfit = performance.totalProfit / performance.trades;
    performance.winRate = performance.wins / performance.trades;
  }

  return performance;
}

function calculateRecentProfit(desk, numWindows = 5) {
  let profit = 0.00;
  let windowsChecked = 0;

  for (let i = DIALOGUE_HISTORY.windows.length - 1; i >= 0 && windowsChecked < numWindows; i--) {
    const window = DIALOGUE_HISTORY.windows[i];

    if (!window.outcome) continue;

    const result = desk === 'FARM' ? window.outcome.farmResult : window.outcome.degenResult;

    if (!result) continue;

    profit += result.profit;
    windowsChecked++;
  }

  return profit;
}

function getDialogueStats() {
  const stats = {
    totalWindows: DIALOGUE_HISTORY.windows.length,
    totalStages: 0,
    totalExecutions: 0,
    totalTokensUsed: 0,
    avgTokensPerWindow: 0
  };

  for (const window of DIALOGUE_HISTORY.windows) {
    stats.totalStages += window.stages.length;
    stats.totalExecutions += window.execution.length;
    stats.totalTokensUsed += window.stages.reduce((sum, s) => sum + (s.tokensUsed || 0), 0);
  }

  if (stats.totalWindows > 0) {
    stats.avgTokensPerWindow = stats.totalTokensUsed / stats.totalWindows;
  }

  return stats;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  initializeDialogueRecorder,
  startWindowDialogue,
  getCurrentWindow,
  recordPlayerDecision,
  recordExecution,
  recordOutcome,
  getWindowDialogue,
  getRecentWindows,
  getPlayerDecisions,
  getDeskPerformance,
  calculateRecentProfit,
  getDialogueStats
};
