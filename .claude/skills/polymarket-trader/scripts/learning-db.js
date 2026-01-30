const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const os = require('os');

// Database location
const DB_DIR = path.join(os.homedir(), '.polymarket-trader');
const DB_PATH = path.join(DB_DIR, 'trading_data.db');

/**
 * Initialize SQLite database and create tables
 * @returns {Promise<Database>} Database connection
 */
async function initDatabase() {
  // Ensure directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
        return;
      }

      // Create tables
      db.serialize(() => {
        // Trades table with full decision trace
        db.run(`
          CREATE TABLE IF NOT EXISTS trades (
            id INTEGER PRIMARY KEY,
            timestamp TEXT NOT NULL,
            window TEXT NOT NULL,
            bet_number INTEGER,
            market TEXT,
            side TEXT,
            token_id TEXT,
            entry_price REAL,
            position_size REAL,
            execution_price REAL,

            -- Momentum analysis
            momentum_short REAL,
            momentum_medium REAL,
            momentum_hourly REAL,
            momentum_daily REAL,
            momentum_composite REAL,

            -- Market state
            yes_price REAL,
            no_price REAL,
            btc_price REAL,
            time_left_in_window INTEGER,

            -- Decision
            confidence REAL,
            trigger TEXT,
            max_price REAL,
            reasoning_json TEXT,

            -- Environment
            flash_crash_active INTEGER DEFAULT 0,
            exposure_pct REAL,
            open_positions INTEGER,
            window_bets INTEGER,

            -- Outcome (populated after settlement)
            status TEXT DEFAULT 'open',
            settled_at TEXT,
            window_start_price REAL,
            window_end_price REAL,
            window_outcome TEXT,
            profit_loss REAL
          )
        `);

        // Indexes for fast queries
        db.run(`CREATE INDEX IF NOT EXISTS idx_trigger ON trades(trigger)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_status ON trades(status)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_timestamp ON trades(timestamp)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_window ON trades(window)`);

        // Learning metrics table
        db.run(`
          CREATE TABLE IF NOT EXISTS learning_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            analysis_timestamp TEXT NOT NULL,
            analysis_type TEXT NOT NULL,
            metric_name TEXT NOT NULL,
            metric_value REAL,
            sample_size INTEGER,
            metadata_json TEXT
          )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_analysis_type ON learning_metrics(analysis_type)`);

        // Parameter adjustments table
        db.run(`
          CREATE TABLE IF NOT EXISTS parameter_adjustments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            adjustment_timestamp TEXT NOT NULL,
            parameter_path TEXT NOT NULL,
            old_value REAL,
            new_value REAL,
            reason TEXT,
            supporting_metrics_json TEXT
          )
        `);

        // Supervisor insights table
        db.run(`
          CREATE TABLE IF NOT EXISTS supervisor_insights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            review_type TEXT NOT NULL,
            urgency TEXT,
            confidence REAL,
            insights_json TEXT,
            tactical_adjustments_json TEXT,
            risks_json TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER
          )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_supervisor_timestamp ON supervisor_insights(timestamp)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_supervisor_type ON supervisor_insights(review_type)`);

        // Supervisor decisions table
        db.run(`
          CREATE TABLE IF NOT EXISTS supervisor_decisions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            decision_type TEXT NOT NULL,
            approved INTEGER NOT NULL,
            confidence REAL,
            rationale TEXT,
            original_adjustments_json TEXT,
            modified_adjustments_json TEXT,
            additional_recommendations_json TEXT,
            external_context_json TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER,
            total_tokens INTEGER
          )
        `);

        db.run(`CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_timestamp ON supervisor_decisions(timestamp)`);

        resolve(db);
      });
    });
  });
}

/**
 * Insert a trade with full decision trace
 * @param {Database} db Database connection
 * @param {Object} trade Trade object with decisionTrace
 */
async function insertTrade(db, trade) {
  return new Promise((resolve, reject) => {
    // Extract decision trace fields (gracefully handle missing trace)
    const trace = trade.decisionTrace || {};
    const momentum = trace.momentumAnalysis || {};
    const marketState = trace.marketState || {};
    const decision = trace.decision || {};
    const environment = trace.environment || {};

    const stmt = db.prepare(`
      INSERT INTO trades (
        id, timestamp, window, bet_number, market, side, token_id,
        entry_price, position_size, execution_price,
        momentum_short, momentum_medium, momentum_hourly, momentum_daily, momentum_composite,
        yes_price, no_price, btc_price, time_left_in_window,
        confidence, trigger, max_price, reasoning_json,
        flash_crash_active, exposure_pct, open_positions, window_bets,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      trade.id,
      trade.timestamp,
      trade.window,
      trade.betNumber || null,
      trade.market || null,
      trade.side,
      trade.tokenId || null,
      trade.price,
      trade.size,
      decision.executionPrice || trade.price,

      momentum.short || null,
      momentum.medium || null,
      momentum.hourly || null,
      momentum.daily || null,
      momentum.composite || null,

      marketState.yesPrice || null,
      marketState.noPrice || null,
      marketState.btcPrice || trade.btcPriceAtEntry || null,
      marketState.timeLeftInWindow || null,

      trade.confidence,
      trade.trigger,
      decision.maxPrice || null,
      JSON.stringify(trade.reasoning || []),

      environment.flashCrashActive ? 1 : 0,
      environment.exposurePct || null,
      environment.openPositions || null,
      environment.windowBets || null,

      trade.status || 'open'
    ], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    stmt.finalize();
  });
}

/**
 * Update trade with settlement outcome
 * @param {Database} db Database connection
 * @param {Object} trade Trade object with settlement data
 */
async function updateTradeSettlement(db, trade) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      UPDATE trades
      SET status = ?,
          settled_at = ?,
          window_start_price = ?,
          window_end_price = ?,
          window_outcome = ?,
          profit_loss = ?
      WHERE id = ?
    `);

    stmt.run([
      trade.status,
      trade.settledAt || null,
      trade.windowStartPrice || null,
      trade.windowEndPrice || null,
      trade.windowOutcome || null,
      trade.profitLoss || null,
      trade.id
    ], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    stmt.finalize();
  });
}

/**
 * Insert a learning metric
 * @param {Database} db Database connection
 * @param {string} analysisType 4hr, 12hr, 24hr, weekly
 * @param {string} metricName Name of metric
 * @param {number} metricValue Value
 * @param {number} sampleSize Sample size
 * @param {Object} metadata Additional metadata
 */
async function insertMetric(db, analysisType, metricName, metricValue, sampleSize, metadata = {}) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO learning_metrics (
        analysis_timestamp, analysis_type, metric_name, metric_value, sample_size, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      new Date().toISOString(),
      analysisType,
      metricName,
      metricValue,
      sampleSize,
      JSON.stringify(metadata)
    ], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    stmt.finalize();
  });
}

/**
 * Insert a parameter adjustment record
 * @param {Database} db Database connection
 * @param {string} parameterPath CONFIG path (e.g., CONFIG.initialBet.confidenceMin)
 * @param {number} oldValue Previous value
 * @param {number} newValue New value
 * @param {string} reason Explanation for adjustment
 * @param {Object} supportingMetrics Metrics that drove the decision
 */
async function insertAdjustment(db, parameterPath, oldValue, newValue, reason, supportingMetrics = {}) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO parameter_adjustments (
        adjustment_timestamp, parameter_path, old_value, new_value, reason, supporting_metrics_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      new Date().toISOString(),
      parameterPath,
      oldValue,
      newValue,
      reason,
      JSON.stringify(supportingMetrics)
    ], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    stmt.finalize();
  });
}

/**
 * Query trades with filters
 * @param {Database} db Database connection
 * @param {Object} filters Query filters
 * @returns {Promise<Array>} Matching trades
 */
async function queryTrades(db, filters = {}) {
  return new Promise((resolve, reject) => {
    let query = 'SELECT * FROM trades WHERE 1=1';
    const params = [];

    if (filters.status) {
      query += ' AND status = ?';
      params.push(filters.status);
    }

    if (filters.trigger) {
      query += ' AND trigger = ?';
      params.push(filters.trigger);
    }

    if (filters.limit) {
      query += ' LIMIT ?';
      params.push(filters.limit);
    }

    db.all(query, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

/**
 * Insert a supervisor insight from hourly review
 * @param {Database} db Database connection
 * @param {string} reviewType hourly or validation
 * @param {Object} insight Insight object from supervisor
 */
async function insertSupervisorInsight(db, reviewType, insight) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO supervisor_insights (
        timestamp, review_type, urgency, confidence,
        insights_json, tactical_adjustments_json, risks_json,
        prompt_tokens, completion_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      new Date().toISOString(),
      reviewType,
      insight.urgency || null,
      insight.confidence || null,
      JSON.stringify(insight.insights || []),
      JSON.stringify(insight.tacticalAdjustments || []),
      JSON.stringify(insight.risks || []),
      insight.usage?.prompt_tokens || null,
      insight.usage?.completion_tokens || null,
      insight.usage?.total_tokens || null
    ], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    stmt.finalize();
  });
}

/**
 * Insert a supervisor decision on parameter adjustments
 * @param {Database} db Database connection
 * @param {Object} decision Decision object from supervisor
 */
async function insertSupervisorDecision(db, decision) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(`
      INSERT INTO supervisor_decisions (
        timestamp, decision_type, approved, confidence, rationale,
        original_adjustments_json, modified_adjustments_json,
        additional_recommendations_json, external_context_json,
        prompt_tokens, completion_tokens, total_tokens
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run([
      new Date().toISOString(),
      decision.decisionType || 'approve',
      decision.approved ? 1 : 0,
      decision.confidence || null,
      decision.rationale || null,
      JSON.stringify(decision.originalAdjustments || []),
      JSON.stringify(decision.modifications || []),
      JSON.stringify(decision.additionalRecommendations || []),
      JSON.stringify(decision.externalContext || {}),
      decision.usage?.prompt_tokens || null,
      decision.usage?.completion_tokens || null,
      decision.usage?.total_tokens || null
    ], (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });

    stmt.finalize();
  });
}

/**
 * Close database connection
 * @param {Database} db Database connection
 */
async function closeDatabase(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  initDatabase,
  insertTrade,
  updateTradeSettlement,
  insertMetric,
  insertAdjustment,
  insertSupervisorInsight,
  insertSupervisorDecision,
  queryTrades,
  closeDatabase,
};
