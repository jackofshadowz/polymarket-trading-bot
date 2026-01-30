const { insertMetric, insertAdjustment } = require('./learning-db');

// Safety bounds for parameter adjustments
const BOUNDS = {
  confidence: { min: 0.50, max: 0.75 },
  positionSize: { min: 0.02, max: 0.15 },
  momentumWeight: { min: 0.10, max: 0.40 },
  maxAdjustmentPct: 0.10, // Max 10% change per cycle
};

/**
 * Analyze trigger performance (win rate, ROI)
 * @param {Database} db Database connection
 * @returns {Promise<Array>} Trigger performance metrics
 */
async function analyzeTriggerPerformance(db) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        trigger,
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'won' THEN 1 ELSE 0 END) as wins,
        AVG(profit_loss) as avg_pl,
        SUM(profit_loss) as total_pl,
        AVG(confidence) as avg_confidence
      FROM trades
      WHERE status IN ('won', 'lost')
      GROUP BY trigger
      HAVING total_trades >= 5
      ORDER BY total_trades DESC
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const results = rows.map(r => ({
        trigger: r.trigger,
        winRate: r.wins / r.total_trades,
        avgProfitLoss: r.avg_pl,
        totalProfitLoss: r.total_pl,
        avgConfidence: r.avg_confidence,
        sampleSize: r.total_trades,
      }));

      resolve(results);
    });
  });
}

/**
 * Analyze confidence calibration (predicted vs actual win rate)
 * @param {Database} db Database connection
 * @returns {Promise<Array>} Calibration analysis
 */
async function analyzeConfidenceCalibration(db) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        ROUND(confidence * 10) / 10 as bucket,
        AVG(confidence) as predicted,
        AVG(CASE WHEN status='won' THEN 1.0 ELSE 0.0 END) as actual,
        COUNT(*) as sample_size
      FROM trades
      WHERE status IN ('won', 'lost')
      GROUP BY bucket
      HAVING sample_size >= 3
      ORDER BY bucket
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      const results = rows.map(r => ({
        bucket: r.bucket,
        predicted: r.predicted,
        actual: r.actual,
        calibrationError: Math.abs(r.predicted - r.actual),
        sampleSize: r.sample_size,
      }));

      resolve(results);
    });
  });
}

/**
 * Analyze momentum correlation with outcomes
 * @param {Database} db Database connection
 * @returns {Promise<Array>} Momentum correlation analysis
 */
async function analyzeMomentumCorrelation(db) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        CASE
          WHEN momentum_composite > 0.005 THEN 'strong_bullish'
          WHEN momentum_composite > 0 THEN 'weak_bullish'
          WHEN momentum_composite > -0.005 THEN 'weak_bearish'
          ELSE 'strong_bearish'
        END as momentum_regime,
        side,
        AVG(CASE WHEN status='won' THEN 1.0 ELSE 0.0 END) as win_rate,
        COUNT(*) as sample_size
      FROM trades
      WHERE status IN ('won', 'lost')
        AND momentum_composite IS NOT NULL
      GROUP BY momentum_regime, side
      HAVING sample_size >= 3
      ORDER BY momentum_regime, side
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

/**
 * Analyze time-of-entry performance
 * @param {Database} db Database connection
 * @returns {Promise<Array>} Time-based analysis
 */
async function analyzeTimeOfEntry(db) {
  return new Promise((resolve, reject) => {
    const query = `
      SELECT
        CASE
          WHEN time_left_in_window > 600 THEN 'early_10min+'
          WHEN time_left_in_window > 300 THEN 'mid_5-10min'
          WHEN time_left_in_window > 120 THEN 'late_2-5min'
          ELSE 'very_late_<2min'
        END as entry_timing,
        AVG(CASE WHEN status='won' THEN 1.0 ELSE 0.0 END) as win_rate,
        COUNT(*) as sample_size
      FROM trades
      WHERE status IN ('won', 'lost')
        AND time_left_in_window IS NOT NULL
      GROUP BY entry_timing
      HAVING sample_size >= 3
      ORDER BY entry_timing
    `;

    db.all(query, [], (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });
}

/**
 * Generate parameter adjustments based on analysis
 * @param {Object} analysisResults All analysis results
 * @param {Object} CONFIG Current config
 * @returns {Array} Proposed adjustments
 */
function generateAdjustments(analysisResults, CONFIG) {
  const adjustments = [];

  // Adjust confidence thresholds based on trigger performance
  for (const trigger of analysisResults.triggers) {
    if (trigger.sampleSize < 10) continue; // Need more data

    let configPath = null;
    let currentThreshold = null;

    // Map triggers to config paths
    if (trigger.trigger === 'initial') {
      configPath = 'initialBet';
      currentThreshold = CONFIG.initialBet?.confidenceMin || 0.52;
    } else if (trigger.trigger.includes('follow') || trigger.trigger.includes('pyramid')) {
      configPath = 'followOnBet';
      currentThreshold = CONFIG.followOnBet?.confidenceMin || 0.65;
    } else if (trigger.trigger === 'window_handoff') {
      configPath = 'handoffBet';
      currentThreshold = CONFIG.handoffBet?.confidenceMin || 0.52;
    }

    if (!configPath) continue;

    let newThreshold = currentThreshold;

    // Adjustment logic
    if (trigger.winRate > 0.60 && trigger.sampleSize >= 15) {
      // Winning frequently → lower threshold to trade more
      newThreshold = currentThreshold * 0.90; // -10%
    } else if (trigger.winRate < 0.45 && trigger.sampleSize >= 15) {
      // Losing frequently → raise threshold to be selective
      newThreshold = currentThreshold * 1.10; // +10%
    }

    // Apply safety bounds
    newThreshold = Math.max(BOUNDS.confidence.min, Math.min(BOUNDS.confidence.max, newThreshold));

    // Only adjust if meaningful change (>1%)
    if (Math.abs(newThreshold - currentThreshold) > 0.01) {
      adjustments.push({
        path: `${configPath}.confidenceMin`,
        oldValue: currentThreshold,
        newValue: newThreshold,
        reason: `Trigger '${trigger.trigger}' has ${(trigger.winRate * 100).toFixed(1)}% win rate (${trigger.sampleSize} trades) → ${trigger.winRate > 0.55 ? 'lowering' : 'raising'} threshold`,
        metrics: {
          trigger: trigger.trigger,
          winRate: trigger.winRate,
          sampleSize: trigger.sampleSize,
          avgPL: trigger.avgProfitLoss,
        },
      });
    }
  }

  // Adjust position sizes based on ROI
  for (const trigger of analysisResults.triggers) {
    if (trigger.sampleSize < 15) continue;

    let configPath = null;
    let currentSize = null;

    if (trigger.trigger === 'initial') {
      configPath = 'initialBet';
      currentSize = CONFIG.initialBet?.positionSize || 0.08;
    } else if (trigger.trigger.includes('follow')) {
      configPath = 'followOnBet';
      currentSize = CONFIG.followOnBet?.positionSize || 0.08;
    } else if (trigger.trigger === 'window_handoff') {
      configPath = 'handoffBet';
      currentSize = CONFIG.handoffBet?.positionSize || 0.08;
    }

    if (!configPath) continue;

    let newSize = currentSize;

    // If highly profitable with good win rate → increase size
    if (trigger.winRate > 0.60 && trigger.avgProfitLoss > 1.5 && trigger.sampleSize >= 20) {
      newSize = currentSize * 1.10; // +10%
    }
    // If losing money → decrease size
    else if (trigger.totalProfitLoss < 0 && trigger.sampleSize >= 20) {
      newSize = currentSize * 0.90; // -10%
    }

    // Apply safety bounds
    newSize = Math.max(BOUNDS.positionSize.min, Math.min(BOUNDS.positionSize.max, newSize));

    // Only adjust if meaningful change (>0.5%)
    if (Math.abs(newSize - currentSize) > 0.005) {
      adjustments.push({
        path: `${configPath}.positionSize`,
        oldValue: currentSize,
        newValue: newSize,
        reason: `Trigger '${trigger.trigger}' has ${(trigger.winRate * 100).toFixed(1)}% win rate with $${trigger.avgProfitLoss.toFixed(2)} avg P/L → ${trigger.totalProfitLoss > 0 ? 'increasing' : 'decreasing'} position size`,
        metrics: {
          trigger: trigger.trigger,
          winRate: trigger.winRate,
          totalPL: trigger.totalProfitLoss,
          sampleSize: trigger.sampleSize,
        },
      });
    }
  }

  return adjustments;
}

/**
 * Run a full analysis cycle
 * @param {Database} db Database connection
 * @param {Object} CONFIG Current config
 * @param {string} type Analysis type (4hr, 12hr, 24hr, weekly)
 * @returns {Promise<Array>} Adjustments to apply (if any)
 */
async function runAnalysisCycle(db, CONFIG, type) {
  console.log(JSON.stringify({
    action: 'LEARNING_ANALYSIS_START',
    type,
    timestamp: new Date().toISOString(),
  }));

  try {
    // Run all analysis functions
    const [triggers, calibration, momentum, timing] = await Promise.all([
      analyzeTriggerPerformance(db),
      analyzeConfidenceCalibration(db),
      analyzeMomentumCorrelation(db),
      analyzeTimeOfEntry(db),
    ]);

    const results = {
      triggers,
      calibration,
      momentum,
      timing,
    };

    // Log summary
    console.log(JSON.stringify({
      action: 'LEARNING_ANALYSIS_RESULTS',
      type,
      triggerPerformance: triggers.map(t => ({
        trigger: t.trigger,
        winRate: (t.winRate * 100).toFixed(1) + '%',
        avgPL: '$' + t.avgProfitLoss.toFixed(2),
        trades: t.sampleSize,
      })),
      confidenceCalibration: calibration.map(c => ({
        bucket: (c.bucket * 100).toFixed(0) + '%',
        predicted: (c.predicted * 100).toFixed(1) + '%',
        actual: (c.actual * 100).toFixed(1) + '%',
        error: (c.calibrationError * 100).toFixed(1) + '%',
      })),
      momentumSignals: momentum.length,
      timingAnalysis: timing.length,
      timestamp: new Date().toISOString(),
    }));

    // Store metrics in database
    for (const trigger of triggers) {
      await insertMetric(db, type, `trigger_${trigger.trigger}_winrate`, trigger.winRate, trigger.sampleSize, {
        trigger: trigger.trigger,
        avgPL: trigger.avgProfitLoss,
        totalPL: trigger.totalProfitLoss,
      });
    }

    for (const cal of calibration) {
      await insertMetric(db, type, `calibration_${cal.bucket}`, cal.calibrationError, cal.sampleSize, {
        predicted: cal.predicted,
        actual: cal.actual,
      });
    }

    // Generate adjustments only for 24hr+ cycles
    if (type === '24hr' || type === 'weekly') {
      const adjustments = generateAdjustments(results, CONFIG);

      if (adjustments.length > 0) {
        console.log(JSON.stringify({
          action: 'ADJUSTMENTS_GENERATED',
          count: adjustments.length,
          adjustments: adjustments.map(a => ({
            parameter: a.path,
            change: ((a.newValue / a.oldValue - 1) * 100).toFixed(1) + '%',
            reason: a.reason,
          })),
          timestamp: new Date().toISOString(),
        }));
      }

      return adjustments;
    }

    return [];

  } catch (error) {
    console.error(JSON.stringify({
      action: 'LEARNING_ANALYSIS_ERROR',
      type,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    return [];
  }
}

/**
 * Get a snapshot of current analysis for supervisor context
 * @param {Database} db Database connection
 * @returns {Promise<Object>} Analysis snapshot
 */
async function getAnalysisSnapshot(db) {
  try {
    return {
      triggers: await analyzeTriggerPerformance(db),
      calibration: await analyzeConfidenceCalibration(db),
      momentum: await analyzeMomentumCorrelation(db),
      timing: await analyzeTimeOfEntry(db),
    };
  } catch (error) {
    console.warn(JSON.stringify({
      action: 'ANALYSIS_SNAPSHOT_ERROR',
      error: error.message
    }));
    return {
      triggers: [],
      calibration: [],
      momentum: [],
      timing: [],
    };
  }
}

module.exports = {
  analyzeTriggerPerformance,
  analyzeConfidenceCalibration,
  analyzeMomentumCorrelation,
  analyzeTimeOfEntry,
  generateAdjustments,
  runAnalysisCycle,
  getAnalysisSnapshot,
};
