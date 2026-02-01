// ============================================================
// BLACK BOX RECORDER - Flight Data Recorder for Trading
// ============================================================
// This module acts as a passive observer, recording:
// 1. High-resolution tick data (price, volatility every second)
// 2. Decision traces (WHY we bought AND WHY we didn't)
// 3. Actual actions taken (real money trades)
// 4. Counterfactual analysis (what WOULD have happened)
// 5. Performance metrics for backtesting
//
// After 50 windows, you can ask:
// "What volatility threshold yields highest win rate for Lotto?"
// ============================================================

const fs = require('fs');
const path = require('path');

class BlackBoxRecorder {
  constructor() {
    this.currentWindow = null;
    this.logsDir = path.join(__dirname, 'flight_data');
    this.indexFile = path.join(this.logsDir, 'index.json');
    this.statsFile = path.join(this.logsDir, 'aggregate_stats.json');

    // Ensure directory exists
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    // Load or initialize index
    this.index = this.loadIndex();
    this.aggregateStats = this.loadAggregateStats();

    console.log(JSON.stringify({
      action: 'BLACK_BOX_RECORDER_INITIALIZED',
      logsDir: this.logsDir,
      totalEpisodes: this.index.episodes.length,
      timestamp: new Date().toISOString()
    }));
  }

  // ============================================================
  // INDEX MANAGEMENT
  // ============================================================

  loadIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        return JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      }
    } catch (e) {
      console.warn('Black Box: Could not load index:', e.message);
    }

    return {
      version: '1.0',
      createdAt: new Date().toISOString(),
      episodes: [],
      totalWindows: 0,
      totalWins: 0,
      totalLosses: 0,
      totalPnL: 0
    };
  }

  saveIndex() {
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
    } catch (e) {
      console.warn('Black Box: Could not save index:', e.message);
    }
  }

  loadAggregateStats() {
    try {
      if (fs.existsSync(this.statsFile)) {
        return JSON.parse(fs.readFileSync(this.statsFile, 'utf8'));
      }
    } catch (e) {
      console.warn('Black Box: Could not load stats:', e.message);
    }

    return {
      strategies: {
        SNIPER: { attempts: 0, executions: 0, wins: 0, totalPnL: 0 },
        OPENER: { attempts: 0, executions: 0, wins: 0, totalPnL: 0 },
        DIP_SCALPER: { attempts: 0, executions: 0, wins: 0, totalPnL: 0 },
        LOTTO: { attempts: 0, executions: 0, wins: 0, totalPnL: 0 },
        EMERGENCY: { triggers: 0, savedCapital: 0 }
      },
      counterfactuals: {
        missedLottos: 0,
        missedDips: 0,
        potentialMissedProfit: 0
      },
      volatilityBuckets: {
        // Bucket volatility ranges to find optimal thresholds
        '0.00-0.02': { windows: 0, wins: 0, lottoHits: 0 },
        '0.02-0.05': { windows: 0, wins: 0, lottoHits: 0 },
        '0.05-0.10': { windows: 0, wins: 0, lottoHits: 0 },
        '0.10-0.20': { windows: 0, wins: 0, lottoHits: 0 },
        '0.20+': { windows: 0, wins: 0, lottoHits: 0 }
      },
      deltaRanges: {
        // Track performance by delta magnitude
        'small (0-0.1%)': { windows: 0, correctPredictions: 0 },
        'medium (0.1-0.3%)': { windows: 0, correctPredictions: 0 },
        'large (0.3%+)': { windows: 0, correctPredictions: 0 }
      }
    };
  }

  saveAggregateStats() {
    try {
      fs.writeFileSync(this.statsFile, JSON.stringify(this.aggregateStats, null, 2));
    } catch (e) {
      console.warn('Black Box: Could not save stats:', e.message);
    }
  }

  // ============================================================
  // 1. START NEW EPISODE (Called at window open)
  // ============================================================

  startNewEpisode(marketDetails) {
    // Save previous episode if exists
    if (this.currentWindow) {
      console.warn('Black Box: Previous episode not finalized, auto-saving...');
      this.autoSaveIncomplete();
    }

    const episodeId = marketDetails.slug || `window_${Date.now()}`;

    this.currentWindow = {
      // Identification
      id: episodeId,
      startTime: Date.now(),
      startTimeISO: new Date().toISOString(),
      marketSlug: marketDetails.slug,

      // Initial State Snapshot
      initialState: {
        btcOpenPrice: marketDetails.btcOpenPrice || null,
        polyYesPrice: marketDetails.yesPrice || 0.50,
        polyNoPrice: marketDetails.noPrice || 0.50,
        windowDuration: 900, // 15 minutes
        timeLeft: marketDetails.timeLeft || 900
      },

      // Wealth Fortress State at Start
      fortressState: {
        phase: marketDetails.fortressPhase || 'UNKNOWN',
        totalEquity: marketDetails.totalEquity || 0,
        vault: marketDetails.vault || 0,
        warChest: marketDetails.warChest || 0,
        principalSecured: marketDetails.principalSecured || false
      },

      // High-Resolution Timeline (tick-by-tick)
      timeline: [],

      // Decision Traces (WHY we did or didn't act)
      decisions: [],

      // Actual Actions Taken (real money)
      actions: [],

      // Strategy-Specific State
      strategies: {
        sniper: { checked: false, executed: false, edge: null },
        opener: { checked: false, executed: false, confidence: null },
        dipScalper: { checked: false, executed: false, entryPrice: null, exitPrice: null },
        lotto: { checked: false, executed: false, tickets: 0 },
        emergency: { triggered: false, reason: null }
      },

      // Market Conditions Summary
      marketConditions: {
        avgVolatility: 0,
        maxVolatility: 0,
        minVolatility: Infinity,
        avgDelta: 0,
        maxDelta: 0,
        minDelta: Infinity,
        trendDirection: null, // 'UP', 'DOWN', 'CHOPPY'
        priceRange: { high: 0, low: Infinity }
      },

      // Performance (filled at end)
      performance: {
        pnl: 0,
        roi: 0,
        winner: null, // 'YES' or 'NO'
        ourSide: null,
        won: null,
        correctPrediction: null
      },

      // Counterfactual Analysis (filled at end)
      counterfactuals: {},

      // Episode Status
      status: 'RECORDING',
      endTime: null
    };

    console.log(JSON.stringify({
      action: 'BLACK_BOX_EPISODE_START',
      episodeId: episodeId,
      btcOpen: this.currentWindow.initialState.btcOpenPrice,
      polyOpen: this.currentWindow.initialState.polyYesPrice,
      fortress: this.currentWindow.fortressState.phase,
      timestamp: new Date().toISOString()
    }));
  }

  // ============================================================
  // 2. RECORD TICK (Called every 1-5 seconds)
  // ============================================================

  recordTick(data) {
    if (!this.currentWindow) return;

    const tick = {
      t: Math.floor((Date.now() - this.currentWindow.startTime) / 1000), // Seconds since open
      ts: Date.now(),
      // Prices
      btc: data.btcPrice || null,
      yes: data.yesPrice || null,
      no: data.noPrice || null,
      // Delta from open
      delta: data.delta || 0,
      deltaPct: data.deltaPct || 0,
      // Volatility
      vol: data.volatility || 0,
      // Oracle data
      oracleDelta: data.oracleDelta || null,
      // Time remaining
      timeLeft: data.timeLeft || 0
    };

    this.currentWindow.timeline.push(tick);

    // Update market conditions summary
    this.updateMarketConditions(tick);

    // Keep timeline reasonable (max 1000 ticks = ~16 min at 1/sec)
    if (this.currentWindow.timeline.length > 1000) {
      // Downsample: keep every other tick
      this.currentWindow.timeline = this.currentWindow.timeline.filter((_, i) => i % 2 === 0);
    }
  }

  updateMarketConditions(tick) {
    const mc = this.currentWindow.marketConditions;
    const n = this.currentWindow.timeline.length;

    // Volatility
    mc.avgVolatility = ((mc.avgVolatility * (n - 1)) + tick.vol) / n;
    mc.maxVolatility = Math.max(mc.maxVolatility, tick.vol);
    mc.minVolatility = Math.min(mc.minVolatility, tick.vol);

    // Delta
    mc.avgDelta = ((mc.avgDelta * (n - 1)) + Math.abs(tick.deltaPct)) / n;
    mc.maxDelta = Math.max(mc.maxDelta, Math.abs(tick.deltaPct));
    mc.minDelta = Math.min(mc.minDelta, Math.abs(tick.deltaPct));

    // Price range
    if (tick.yes) {
      mc.priceRange.high = Math.max(mc.priceRange.high, tick.yes);
      mc.priceRange.low = Math.min(mc.priceRange.low, tick.yes);
    }
  }

  // ============================================================
  // 3. LOG DECISION TRACE (The "Why")
  // ============================================================

  logDecision(strategy, outcome, reason, context = {}) {
    if (!this.currentWindow) return;

    const decision = {
      timestamp: new Date().toISOString(),
      secondsIn: Math.floor((Date.now() - this.currentWindow.startTime) / 1000),
      strategy: strategy,        // e.g., 'LOTTO_SCAN', 'DIP_CHECK', 'SNIPER_EDGE'
      outcome: outcome,          // 'EXECUTED', 'REJECTED', 'SKIPPED', 'PENDING'
      reason: reason,            // Human-readable explanation
      context: {
        ...context,
        // Auto-capture current market state
        currentYesPrice: this.getLastTick()?.yes,
        currentVolatility: this.getLastTick()?.vol,
        currentDelta: this.getLastTick()?.deltaPct,
        timeLeft: this.getLastTick()?.timeLeft
      }
    };

    this.currentWindow.decisions.push(decision);

    // Update strategy state
    const strategyKey = this.normalizeStrategyKey(strategy);
    if (strategyKey && this.currentWindow.strategies[strategyKey]) {
      this.currentWindow.strategies[strategyKey].checked = true;
      if (outcome === 'EXECUTED') {
        this.currentWindow.strategies[strategyKey].executed = true;
      }
    }

    // Update aggregate stats
    this.updateDecisionStats(strategy, outcome);

    // Log significant decisions
    if (outcome === 'EXECUTED' || (outcome === 'REJECTED' && context.significant)) {
      console.log(JSON.stringify({
        action: 'BLACK_BOX_DECISION',
        strategy: strategy,
        outcome: outcome,
        reason: reason,
        price: context.price || context.currentPrice,
        vol: context.volatility || context.vol,
        timestamp: new Date().toISOString()
      }));
    }
  }

  normalizeStrategyKey(strategy) {
    const map = {
      'SNIPER': 'sniper',
      'SNIPER_EDGE': 'sniper',
      'SNIPER_CHECK': 'sniper',
      'OPENER': 'opener',
      'OPENER_CHECK': 'opener',
      'OPENER_BET': 'opener',
      'DIP': 'dipScalper',
      'DIP_SCALPER': 'dipScalper',
      'DIP_CHECK': 'dipScalper',
      'DIP_BUY': 'dipScalper',
      'DIP_FLIP': 'dipScalper',
      'LOTTO': 'lotto',
      'LOTTO_SCAN': 'lotto',
      'LOTTO_BUY': 'lotto',
      'EMERGENCY': 'emergency',
      'EMERGENCY_BRAKE': 'emergency'
    };
    return map[strategy] || null;
  }

  updateDecisionStats(strategy, outcome) {
    const key = strategy.split('_')[0]; // Extract base strategy
    if (this.aggregateStats.strategies[key]) {
      this.aggregateStats.strategies[key].attempts++;
      if (outcome === 'EXECUTED') {
        this.aggregateStats.strategies[key].executions++;
      }
    }
  }

  // ============================================================
  // 4. LOG ACTION (Real Money Trade)
  // ============================================================

  logAction(actionType, details) {
    if (!this.currentWindow) return;

    const action = {
      timestamp: new Date().toISOString(),
      secondsIn: Math.floor((Date.now() - this.currentWindow.startTime) / 1000),
      type: actionType,         // 'BUY', 'SELL', 'CLIP', 'CANCEL'
      side: details.side,       // 'YES' or 'NO'
      price: details.price,
      shares: details.shares,
      cost: details.cost,
      strategy: details.strategy,
      tokenId: details.tokenId ? details.tokenId.substring(0, 16) + '...' : null,
      orderId: details.orderId,
      desk: details.desk,       // 'FARM', 'DEGEN', 'CLIPPER'
      estimatedPnL: details.estimatedPnL || 0,
      metadata: details.metadata || {}
    };

    this.currentWindow.actions.push(action);

    // Track our side for outcome calculation
    if (actionType === 'BUY' && !this.currentWindow.performance.ourSide) {
      this.currentWindow.performance.ourSide = details.side;
    }

    console.log(JSON.stringify({
      action: 'BLACK_BOX_TRADE_LOGGED',
      type: actionType,
      side: details.side,
      price: details.price,
      cost: details.cost,
      strategy: details.strategy,
      timestamp: new Date().toISOString()
    }));
  }

  // ============================================================
  // 5. FINALIZE EPISODE (The Hindsight Engine)
  // ============================================================

  async finalizeEpisode(outcomeData) {
    if (!this.currentWindow) {
      console.warn('Black Box: No episode to finalize');
      return;
    }

    const episode = this.currentWindow;
    episode.status = 'COMPLETE';
    episode.endTime = Date.now();
    episode.endTimeISO = new Date().toISOString();

    // ========================================
    // A. CALCULATE PERFORMANCE
    // ========================================

    const winner = outcomeData.winner; // 'YES' or 'NO'
    const finalYesPrice = outcomeData.finalYesPrice || (winner === 'YES' ? 1.0 : 0.0);
    const finalNoPrice = outcomeData.finalNoPrice || (winner === 'NO' ? 1.0 : 0.0);
    const finalBtcPrice = outcomeData.finalBtcPrice;
    const finalDelta = outcomeData.finalDelta;

    episode.performance.winner = winner;
    episode.performance.finalBtcPrice = finalBtcPrice;
    episode.performance.finalDelta = finalDelta;

    // Calculate P&L from actions
    let totalCost = 0;
    let totalValue = 0;

    for (const action of episode.actions) {
      if (action.type === 'BUY') {
        totalCost += action.cost || 0;
        const wonTrade = action.side === winner;
        if (wonTrade) {
          totalValue += action.shares || 0; // Shares worth $1 each if won
        }
      }
    }

    episode.performance.totalCost = totalCost;
    episode.performance.totalValue = totalValue;
    episode.performance.pnl = totalValue - totalCost;
    episode.performance.roi = totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0;
    episode.performance.won = episode.performance.pnl > 0;

    // Did we predict correctly?
    if (episode.performance.ourSide) {
      episode.performance.correctPrediction = episode.performance.ourSide === winner;
    }

    // ========================================
    // B. COUNTERFACTUAL ANALYSIS ("What If?")
    // ========================================

    const timeline = episode.timeline;
    const yesPrices = timeline.filter(t => t.yes).map(t => t.yes);
    const noPrices = timeline.filter(t => t.no).map(t => t.no);
    const volatilities = timeline.map(t => t.vol || 0);

    const minYesPrice = yesPrices.length > 0 ? Math.min(...yesPrices) : 1;
    const maxYesPrice = yesPrices.length > 0 ? Math.max(...yesPrices) : 0;
    const minNoPrice = noPrices.length > 0 ? Math.min(...noPrices) : 1;
    const maxNoPrice = noPrices.length > 0 ? Math.max(...noPrices) : 0;
    const maxVolatility = volatilities.length > 0 ? Math.max(...volatilities) : 0;

    episode.counterfactuals = {
      // LOTTO ANALYSIS
      lotto: {
        // Did a YES lotto ticket ($0.025) actually print?
        yesLottoAvailable: minYesPrice <= 0.025,
        yesLottoWouldWin: minYesPrice <= 0.025 && winner === 'YES',
        yesLottoPotentialROI: minYesPrice <= 0.025 && winner === 'YES'
          ? ((1.0 - minYesPrice) / minYesPrice * 100).toFixed(0) + '%'
          : null,

        // Did a NO lotto ticket print?
        noLottoAvailable: minNoPrice <= 0.025,
        noLottoWouldWin: minNoPrice <= 0.025 && winner === 'NO',
        noLottoPotentialROI: minNoPrice <= 0.025 && winner === 'NO'
          ? ((1.0 - minNoPrice) / minNoPrice * 100).toFixed(0) + '%'
          : null,

        // Did we actually buy one?
        weBoughtLotto: episode.strategies.lotto.executed,
        missedLotto: (minYesPrice <= 0.025 && winner === 'YES' && !episode.strategies.lotto.executed) ||
                     (minNoPrice <= 0.025 && winner === 'NO' && !episode.strategies.lotto.executed),

        // What was volatility when lotto was available?
        volatilityAtLottoPrice: this.findVolatilityAtPrice(timeline, 0.025)
      },

      // DIP SCALP ANALYSIS
      dipScalp: {
        // Did YES dip to $0.47 and rebound to $0.75+?
        yesDipAvailable: minYesPrice <= 0.47,
        yesDipScalpable: minYesPrice <= 0.47 && maxYesPrice >= 0.75,
        yesDipProfit: minYesPrice <= 0.47 && maxYesPrice >= 0.75
          ? ((0.75 - 0.47) / 0.47 * 100).toFixed(0) + '%'
          : null,

        // Same for NO
        noDipAvailable: minNoPrice <= 0.47,
        noDipScalpable: minNoPrice <= 0.47 && maxNoPrice >= 0.75,

        // Did we execute?
        weExecutedDip: episode.strategies.dipScalper.executed,
        missedDip: ((minYesPrice <= 0.47 && maxYesPrice >= 0.75) ||
                   (minNoPrice <= 0.47 && maxNoPrice >= 0.75)) &&
                   !episode.strategies.dipScalper.executed
      },

      // SNIPER ANALYSIS
      sniper: {
        // Was there edge available?
        maxEdgeAvailable: this.calculateMaxEdge(timeline, winner),
        weExecutedSniper: episode.strategies.sniper.executed,
        edgeWhenWeEntered: episode.strategies.sniper.edge
      },

      // OPENER ANALYSIS
      opener: {
        strongMomentum: Math.abs(finalDelta || 0) > 0.08,
        momentumContinued: null, // Would need next window data
        weExecutedOpener: episode.strategies.opener.executed
      },

      // VOLATILITY PROFILE
      volatilityProfile: {
        average: (volatilities.reduce((a, b) => a + b, 0) / volatilities.length) || 0,
        max: maxVolatility,
        wasHighVolatility: maxVolatility > 0.10,
        optimalForLotto: maxVolatility > 0.05 && maxVolatility < 0.20
      },

      // PRICE DYNAMICS
      priceDynamics: {
        yesPriceRange: { low: minYesPrice, high: maxYesPrice },
        noPriceRange: { low: minNoPrice, high: maxNoPrice },
        priceSwing: maxYesPrice - minYesPrice,
        wasChoppy: (maxYesPrice - minYesPrice) > 0.30
      }
    };

    // ========================================
    // C. UPDATE AGGREGATE STATISTICS
    // ========================================

    this.updateAggregateStats(episode);

    // ========================================
    // D. SAVE EPISODE TO DISK
    // ========================================

    const filename = `${episode.marketSlug}_${episode.startTime}.json`;
    const filepath = path.join(this.logsDir, filename);

    try {
      fs.writeFileSync(filepath, JSON.stringify(episode, null, 2));

      // Update index
      this.index.episodes.push({
        id: episode.id,
        file: filename,
        startTime: episode.startTimeISO,
        winner: winner,
        pnl: episode.performance.pnl,
        won: episode.performance.won,
        strategies: Object.keys(episode.strategies).filter(k => episode.strategies[k].executed),
        missedLotto: episode.counterfactuals.lotto.missedLotto,
        missedDip: episode.counterfactuals.dipScalp.missedDip
      });

      this.index.totalWindows++;
      if (episode.performance.won) this.index.totalWins++;
      else if (episode.performance.pnl < 0) this.index.totalLosses++;
      this.index.totalPnL += episode.performance.pnl;

      this.saveIndex();
      this.saveAggregateStats();

      console.log(JSON.stringify({
        action: 'BLACK_BOX_EPISODE_SAVED',
        file: filename,
        winner: winner,
        pnl: '$' + episode.performance.pnl.toFixed(2),
        won: episode.performance.won,
        missedLotto: episode.counterfactuals.lotto.missedLotto,
        missedDip: episode.counterfactuals.dipScalp.missedDip,
        avgVolatility: episode.counterfactuals.volatilityProfile.average.toFixed(4),
        timestamp: new Date().toISOString()
      }));

    } catch (e) {
      console.error('Black Box: Could not save episode:', e.message);
    }

    // Clear current window
    this.currentWindow = null;
  }

  // ============================================================
  // HELPER METHODS
  // ============================================================

  getLastTick() {
    if (!this.currentWindow || this.currentWindow.timeline.length === 0) return null;
    return this.currentWindow.timeline[this.currentWindow.timeline.length - 1];
  }

  findVolatilityAtPrice(timeline, targetPrice) {
    // Find volatility when price was near target
    for (const tick of timeline) {
      if (tick.yes && tick.yes <= targetPrice + 0.01) {
        return tick.vol;
      }
      if (tick.no && tick.no <= targetPrice + 0.01) {
        return tick.vol;
      }
    }
    return null;
  }

  calculateMaxEdge(timeline, winner) {
    // Find the maximum edge that was available
    let maxEdge = 0;
    for (const tick of timeline) {
      if (winner === 'YES' && tick.yes) {
        const edge = 1.0 - tick.yes; // Profit if won
        maxEdge = Math.max(maxEdge, edge);
      } else if (winner === 'NO' && tick.no) {
        const edge = 1.0 - tick.no;
        maxEdge = Math.max(maxEdge, edge);
      }
    }
    return maxEdge;
  }

  updateAggregateStats(episode) {
    const stats = this.aggregateStats;
    const cf = episode.counterfactuals;

    // Update counterfactual counters
    if (cf.lotto.missedLotto) stats.counterfactuals.missedLottos++;
    if (cf.dipScalp.missedDip) stats.counterfactuals.missedDips++;

    // Update volatility buckets
    const avgVol = cf.volatilityProfile.average;
    let bucket;
    if (avgVol < 0.02) bucket = '0.00-0.02';
    else if (avgVol < 0.05) bucket = '0.02-0.05';
    else if (avgVol < 0.10) bucket = '0.05-0.10';
    else if (avgVol < 0.20) bucket = '0.10-0.20';
    else bucket = '0.20+';

    if (stats.volatilityBuckets[bucket]) {
      stats.volatilityBuckets[bucket].windows++;
      if (episode.performance.won) stats.volatilityBuckets[bucket].wins++;
      if (cf.lotto.yesLottoWouldWin || cf.lotto.noLottoWouldWin) {
        stats.volatilityBuckets[bucket].lottoHits++;
      }
    }

    // Update delta ranges
    const finalDelta = Math.abs(episode.performance.finalDelta || 0);
    let deltaRange;
    if (finalDelta < 0.1) deltaRange = 'small (0-0.1%)';
    else if (finalDelta < 0.3) deltaRange = 'medium (0.1-0.3%)';
    else deltaRange = 'large (0.3%+)';

    if (stats.deltaRanges[deltaRange]) {
      stats.deltaRanges[deltaRange].windows++;
      if (episode.performance.correctPrediction) {
        stats.deltaRanges[deltaRange].correctPredictions++;
      }
    }

    // Update strategy P&L
    for (const action of episode.actions) {
      const stratKey = action.strategy?.split('_')[0];
      if (stratKey && stats.strategies[stratKey]) {
        if (episode.performance.won) {
          stats.strategies[stratKey].wins++;
        }
        stats.strategies[stratKey].totalPnL += episode.performance.pnl / episode.actions.length;
      }
    }
  }

  autoSaveIncomplete() {
    if (!this.currentWindow) return;

    this.currentWindow.status = 'INCOMPLETE';
    this.currentWindow.endTime = Date.now();

    const filename = `INCOMPLETE_${this.currentWindow.marketSlug}_${this.currentWindow.startTime}.json`;
    const filepath = path.join(this.logsDir, filename);

    try {
      fs.writeFileSync(filepath, JSON.stringify(this.currentWindow, null, 2));
    } catch (e) {
      console.warn('Black Box: Could not auto-save:', e.message);
    }

    this.currentWindow = null;
  }

  // ============================================================
  // QUERY METHODS (For Analysis)
  // ============================================================

  getEpisodeSummary() {
    return {
      totalWindows: this.index.totalWindows,
      totalWins: this.index.totalWins,
      totalLosses: this.index.totalLosses,
      winRate: this.index.totalWindows > 0
        ? (this.index.totalWins / this.index.totalWindows * 100).toFixed(1) + '%'
        : 'N/A',
      totalPnL: '$' + this.index.totalPnL.toFixed(2),
      missedLottos: this.aggregateStats.counterfactuals.missedLottos,
      missedDips: this.aggregateStats.counterfactuals.missedDips,
      volatilityStats: this.aggregateStats.volatilityBuckets,
      deltaStats: this.aggregateStats.deltaRanges
    };
  }

  getMissedOpportunities() {
    // Return list of missed opportunities for review
    return this.index.episodes
      .filter(e => e.missedLotto || e.missedDip)
      .slice(-20); // Last 20
  }

  isRecording() {
    return this.currentWindow !== null;
  }

  getCurrentEpisodeId() {
    return this.currentWindow?.id || null;
  }
}

// Export singleton instance
module.exports = new BlackBoxRecorder();
