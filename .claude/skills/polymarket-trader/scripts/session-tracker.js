/**
 * SESSION TRACKER - Window Pair and Consultation Orchestrator
 *
 * Tracks trading sessions, window pairs, and triggers AI consultations.
 *
 * Features:
 * 1. Session initialization and tracking
 * 2. Window pair detection (triggers consultation after every 2 windows)
 * 3. Cumulative P&L and stats tracking
 * 4. Integration with AI consultation module
 */

const fs = require('fs');
const path = require('path');
const aiConsultation = require('./ai-consultation');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  SESSIONS_DIR: path.join(__dirname, 'sessions'),
  WINDOWS_PER_CONSULTATION: 2,
  SESSION_FILE: path.join(__dirname, 'sessions', 'current_session.json')
};

// ============================================================
// SESSION STATE
// ============================================================

let currentSession = null;

/**
 * Initialize a new trading session
 */
function startSession() {
  currentSession = {
    sessionId: `session_${Date.now()}`,
    startedAt: new Date().toISOString(),
    windows: [],
    consultations: [],
    stats: {
      totalWindows: 0,
      totalTrades: 0,
      wins: 0,
      losses: 0,
      totalPnL: 0,
      winRate: '0%'
    }
  };

  // Ensure directory exists
  if (!fs.existsSync(CONFIG.SESSIONS_DIR)) {
    fs.mkdirSync(CONFIG.SESSIONS_DIR, { recursive: true });
  }

  saveSession();

  console.log(JSON.stringify({
    action: 'SESSION_STARTED',
    sessionId: currentSession.sessionId,
    timestamp: currentSession.startedAt
  }));

  return currentSession;
}

/**
 * Load existing session or start new one
 */
function loadOrStartSession() {
  try {
    if (fs.existsSync(CONFIG.SESSION_FILE)) {
      const data = fs.readFileSync(CONFIG.SESSION_FILE, 'utf8');
      currentSession = JSON.parse(data);

      // Check if session is stale (> 6 hours old)
      const sessionAge = Date.now() - new Date(currentSession.startedAt).getTime();
      const sixHours = 6 * 60 * 60 * 1000;

      if (sessionAge > sixHours) {
        console.log(JSON.stringify({
          action: 'SESSION_STALE',
          age: Math.round(sessionAge / 1000 / 60) + ' minutes',
          startingNew: true,
          timestamp: new Date().toISOString()
        }));
        return startSession();
      }

      console.log(JSON.stringify({
        action: 'SESSION_RESUMED',
        sessionId: currentSession.sessionId,
        windowsCompleted: currentSession.stats.totalWindows,
        timestamp: new Date().toISOString()
      }));

      return currentSession;
    }
  } catch (e) {
    console.log(JSON.stringify({
      action: 'SESSION_LOAD_FAILED',
      error: e.message,
      timestamp: new Date().toISOString()
    }));
  }

  return startSession();
}

/**
 * Save current session to disk
 */
function saveSession() {
  if (!currentSession) return;

  try {
    if (!fs.existsSync(CONFIG.SESSIONS_DIR)) {
      fs.mkdirSync(CONFIG.SESSIONS_DIR, { recursive: true });
    }

    fs.writeFileSync(CONFIG.SESSION_FILE, JSON.stringify(currentSession, null, 2));

    // Also save a timestamped copy for history
    const historyFile = path.join(
      CONFIG.SESSIONS_DIR,
      `${currentSession.sessionId}.json`
    );
    fs.writeFileSync(historyFile, JSON.stringify(currentSession, null, 2));
  } catch (e) {
    console.log(JSON.stringify({
      action: 'SESSION_SAVE_FAILED',
      error: e.message,
      timestamp: new Date().toISOString()
    }));
  }
}

/**
 * Record a completed window
 *
 * @param {Object} windowData - Data about the completed window
 * @returns {boolean} true if consultation should be triggered
 */
function recordWindow(windowData) {
  if (!currentSession) {
    loadOrStartSession();
  }

  // Add window to session
  const windowRecord = {
    slug: windowData.slug,
    winner: windowData.winner,
    trades: windowData.trades || [],
    signals: windowData.signals || {},
    pnl: windowData.pnl || 0,
    btcOpen: windowData.btcOpen,
    btcClose: windowData.btcClose,
    recordedAt: new Date().toISOString()
  };

  currentSession.windows.push(windowRecord);

  // Update stats
  currentSession.stats.totalWindows++;
  currentSession.stats.totalTrades += windowRecord.trades.length;
  currentSession.stats.totalPnL += windowRecord.pnl;

  if (windowRecord.pnl > 0) {
    currentSession.stats.wins++;
  } else if (windowRecord.pnl < 0) {
    currentSession.stats.losses++;
  }

  const totalDecisions = currentSession.stats.wins + currentSession.stats.losses;
  currentSession.stats.winRate = totalDecisions > 0
    ? `${((currentSession.stats.wins / totalDecisions) * 100).toFixed(1)}%`
    : '0%';

  saveSession();

  console.log(JSON.stringify({
    action: 'WINDOW_RECORDED',
    sessionId: currentSession.sessionId,
    windowSlug: windowRecord.slug,
    winner: windowRecord.winner,
    pnl: windowRecord.pnl.toFixed(2),
    sessionStats: {
      windows: currentSession.stats.totalWindows,
      totalPnL: currentSession.stats.totalPnL.toFixed(2),
      winRate: currentSession.stats.winRate
    },
    timestamp: new Date().toISOString()
  }));

  // Check if we should trigger consultation
  return shouldTriggerConsultation();
}

/**
 * Check if we should trigger an AI consultation
 */
function shouldTriggerConsultation() {
  if (!currentSession) return false;

  const windowCount = currentSession.windows.length;
  const consultationCount = currentSession.consultations.length;

  // Trigger consultation every WINDOWS_PER_CONSULTATION windows
  const windowsSinceLastConsultation = windowCount - (consultationCount * CONFIG.WINDOWS_PER_CONSULTATION);

  return windowsSinceLastConsultation >= CONFIG.WINDOWS_PER_CONSULTATION;
}

/**
 * Get the last N windows for consultation
 */
function getWindowsForConsultation(count = CONFIG.WINDOWS_PER_CONSULTATION) {
  if (!currentSession) return [];

  return currentSession.windows.slice(-count);
}

/**
 * Run AI consultation for the last window pair
 */
async function runConsultationForLastPair() {
  const windows = getWindowsForConsultation(2);

  if (windows.length < 2) {
    console.log(JSON.stringify({
      action: 'CONSULTATION_SKIPPED',
      reason: 'Not enough windows',
      windowCount: windows.length,
      timestamp: new Date().toISOString()
    }));
    return null;
  }

  console.log(JSON.stringify({
    action: 'CONSULTATION_TRIGGERED',
    sessionId: currentSession?.sessionId,
    windowPair: [windows[0].slug, windows[1].slug],
    timestamp: new Date().toISOString()
  }));

  try {
    const result = await aiConsultation.runConsultation(windows[0], windows[1]);

    if (result.success && currentSession) {
      currentSession.consultations.push({
        sessionId: result.dialogue?.sessionId,
        windows: [windows[0].slug, windows[1].slug],
        priorityActions: result.dialogue?.priorityActions || [],
        completedAt: new Date().toISOString()
      });
      saveSession();
    }

    return result;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CONSULTATION_ERROR',
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return { success: false, error: error.message };
  }
}

/**
 * Get current session summary
 */
function getSessionSummary() {
  if (!currentSession) {
    return { active: false };
  }

  return {
    active: true,
    sessionId: currentSession.sessionId,
    startedAt: currentSession.startedAt,
    duration: formatDuration(Date.now() - new Date(currentSession.startedAt).getTime()),
    stats: currentSession.stats,
    consultationsCompleted: currentSession.consultations.length,
    lastWindow: currentSession.windows[currentSession.windows.length - 1] || null
  };
}

/**
 * Format duration in human-readable form
 */
function formatDuration(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  return `${hours}h ${minutes}m`;
}

/**
 * End current session
 */
function endSession() {
  if (!currentSession) return null;

  currentSession.endedAt = new Date().toISOString();
  saveSession();

  const summary = getSessionSummary();

  console.log(JSON.stringify({
    action: 'SESSION_ENDED',
    sessionId: currentSession.sessionId,
    summary: summary,
    timestamp: new Date().toISOString()
  }));

  currentSession = null;
  return summary;
}

/**
 * Get all historical sessions
 */
function listSessions() {
  try {
    if (!fs.existsSync(CONFIG.SESSIONS_DIR)) {
      return [];
    }

    return fs.readdirSync(CONFIG.SESSIONS_DIR)
      .filter(f => f.startsWith('session_') && f.endsWith('.json'))
      .map(f => {
        const filepath = path.join(CONFIG.SESSIONS_DIR, f);
        try {
          const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
          return {
            filename: f,
            sessionId: data.sessionId,
            startedAt: data.startedAt,
            windows: data.stats?.totalWindows || 0,
            pnl: data.stats?.totalPnL || 0,
            winRate: data.stats?.winRate || '0%'
          };
        } catch {
          return { filename: f, error: true };
        }
      })
      .sort((a, b) => new Date(b.startedAt || 0) - new Date(a.startedAt || 0));
  } catch {
    return [];
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  startSession,
  loadOrStartSession,
  recordWindow,
  shouldTriggerConsultation,
  getWindowsForConsultation,
  runConsultationForLastPair,
  getSessionSummary,
  endSession,
  listSessions,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== SESSION TRACKER SELF-TEST ===\n');

  // Start a session
  startSession();
  console.log('Session started:', getSessionSummary());

  // Record mock windows
  console.log('\nRecording mock windows...');

  const triggerAfterWindow1 = recordWindow({
    slug: 'btc-updown-15m-test1',
    winner: 'NO',
    trades: [{ side: 'NO', shares: 5, price: 0.62 }],
    pnl: 1.97,
    signals: { smartMoney: 'BEARISH' }
  });
  console.log('After window 1, trigger consultation:', triggerAfterWindow1);

  const triggerAfterWindow2 = recordWindow({
    slug: 'btc-updown-15m-test2',
    winner: 'YES',
    trades: [],
    pnl: 0,
    signals: { smartMoney: 'NEUTRAL' }
  });
  console.log('After window 2, trigger consultation:', triggerAfterWindow2);

  console.log('\nSession summary:', JSON.stringify(getSessionSummary(), null, 2));
  console.log('\nWindows for consultation:', getWindowsForConsultation());

  // Don't run actual consultation in self-test
  console.log('\nTo run actual consultation: Use runConsultationForLastPair()');

  endSession();
}
