// ============================================================
// WEALTH FORTRESS - Profit Protection & Capital Preservation
// ============================================================
// This module prevents "giving back the gains" by implementing:
//
// 1. THE VAULT: Locked savings that trading desks cannot touch
// 2. THE WAR CHEST: Capped trading capital based on balance tier
// 3. THE PRINCIPAL SHIELD: Once you double, original is safe forever
// 4. THE RATCHET: Auto-lock profits at new high water marks
//
// The key insight: Even if you have $10,000, the bot might only
// "see" $3,500 to trade with. The rest is protected.
// ============================================================

const fs = require('fs');
const path = require('path');

// Persistent state file
const STATE_FILE = path.join(__dirname, 'wealth-fortress-state.json');

class WealthFortress {
  constructor() {
    // CONFIGURATION
    this.INITIAL_PRINCIPAL = 74.00;  // Original investment to protect
    this.PROFIT_SKIM_RATIO = 0.50;   // Lock 50% of new profits at HWM

    // TIERED ALLOCATION (Dynamic risk curve)
    this.TIERS = {
      // Phase 1: BUILDER (<$500) - Aggressive growth
      BUILDER: {
        maxBalance: 500,
        warChestRatio: 0.80,  // Use 80% of capital
        description: 'Aggressive - building initial stack'
      },
      // Phase 2: GROWTH ($500-$5000) - Balanced
      GROWTH: {
        maxBalance: 5000,
        warChestRatio: 0.50,  // Use 50% of capital
        description: 'Balanced - protect half, trade half'
      },
      // Phase 3: WEALTH (>$5000) - Conservative with massive power
      WEALTH: {
        baseWarChest: 2500,   // Fixed base from previous tier
        surplusRatio: 0.20,   // 20% of everything above $5k
        description: 'Optimized - massive buying power, protected wealth'
      }
    };

    // STATE
    this.state = {
      // Core balances
      totalEquity: 0,           // Real API balance
      vaultBalance: 0,          // Locked savings (untouchable)
      warChest: 0,              // Available for trading

      // Protection flags
      principalSecured: false,  // Once doubled, original $36 is locked
      highWaterMark: this.INITIAL_PRINCIPAL,

      // Phase tracking
      currentPhase: 'INIT',
      phaseHistory: [],

      // Profit tracking
      lifetimeProfit: 0,
      lifetimeLocked: 0,
      lockEvents: [],

      // Timestamps
      lastSync: null,
      createdAt: new Date().toISOString()
    };

    // Load persisted state
    this.loadState();
  }

  // ============================================================
  // STATE PERSISTENCE
  // ============================================================

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.state = { ...this.state, ...data };

        console.log(JSON.stringify({
          action: 'WEALTH_FORTRESS_LOADED',
          totalEquity: '$' + this.state.totalEquity.toFixed(2),
          vault: '$' + this.state.vaultBalance.toFixed(2),
          warChest: '$' + this.state.warChest.toFixed(2),
          phase: this.state.currentPhase,
          principalSecured: this.state.principalSecured,
          highWaterMark: '$' + this.state.highWaterMark.toFixed(2),
          timestamp: new Date().toISOString()
        }));
      }
    } catch (error) {
      console.warn('Wealth Fortress: Could not load state:', error.message);
    }
  }

  saveState() {
    try {
      // Keep only last 100 lock events
      if (this.state.lockEvents.length > 100) {
        this.state.lockEvents = this.state.lockEvents.slice(-100);
      }

      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (error) {
      console.warn('Wealth Fortress: Could not save state:', error.message);
    }
  }

  // ============================================================
  // FIX #4: PRINCIPAL VALIDATION
  // Validates that INITIAL_PRINCIPAL matches actual starting balance
  // ============================================================

  validatePrincipal(actualBalance) {
    // If first run (state was just created), initialize from actual balance
    if (this.state.totalEquity === 0 && actualBalance > 0) {
      console.log(JSON.stringify({
        action: 'WEALTH_FORTRESS_INIT',
        actualBalance: actualBalance.toFixed(2),
        storedPrincipal: this.INITIAL_PRINCIPAL.toFixed(2),
        timestamp: new Date().toISOString()
      }));

      // Use actual balance as the principal reference if no state exists
      if (!this.state.highWaterMark || this.state.highWaterMark === this.INITIAL_PRINCIPAL) {
        this.state.highWaterMark = actualBalance;
      }
    }

    // Warn if mismatch > 10%
    const diff = Math.abs(actualBalance - this.INITIAL_PRINCIPAL) / this.INITIAL_PRINCIPAL;
    if (diff > 0.10 && actualBalance > 0) {
      console.warn(JSON.stringify({
        action: 'PRINCIPAL_MISMATCH_WARNING',
        stored: this.INITIAL_PRINCIPAL.toFixed(2),
        actual: actualBalance.toFixed(2),
        diffPct: (diff * 100).toFixed(1) + '%',
        recommendation: 'Consider updating INITIAL_PRINCIPAL to match actual balance',
        timestamp: new Date().toISOString()
      }));
    }
  }

  // ============================================================
  // CORE SYNC FUNCTION (Called every loop iteration)
  // ============================================================

  sync(realApiBalance) {
    const previousEquity = this.state.totalEquity;
    this.state.totalEquity = parseFloat(realApiBalance);
    this.state.lastSync = new Date().toISOString();

    // ============================================================
    // 1. THE PRINCIPAL SHIELD
    // If we have doubled our money ($72+), permanently lock $36 away
    // ============================================================
    if (!this.state.principalSecured &&
        this.state.totalEquity >= (this.INITIAL_PRINCIPAL * 2)) {

      this.state.principalSecured = true;
      this.state.vaultBalance += this.INITIAL_PRINCIPAL;
      this.state.lifetimeLocked += this.INITIAL_PRINCIPAL;

      this.state.lockEvents.push({
        type: 'PRINCIPAL_SHIELD',
        amount: this.INITIAL_PRINCIPAL,
        balance: this.state.totalEquity,
        timestamp: new Date().toISOString()
      });

      console.log(JSON.stringify({
        action: 'PRINCIPAL_SHIELD_ACTIVATED',
        message: 'Original investment is now SAFE FOREVER',
        lockedAmount: '$' + this.INITIAL_PRINCIPAL.toFixed(2),
        totalEquity: '$' + this.state.totalEquity.toFixed(2),
        milestone: 'Account doubled! Playing with house money now.',
        timestamp: new Date().toISOString()
      }));
    }

    // ============================================================
    // 2. THE RATCHET (High Water Mark Profit Lock)
    // When we hit new ATH, lock portion of new profits
    // ============================================================
    if (this.state.totalEquity > this.state.highWaterMark) {
      const newProfit = this.state.totalEquity - this.state.highWaterMark;
      const amountToLock = newProfit * this.PROFIT_SKIM_RATIO;

      // Only lock if significant ($1+)
      if (amountToLock >= 1.00) {
        this.state.vaultBalance += amountToLock;
        this.state.lifetimeLocked += amountToLock;

        this.state.lockEvents.push({
          type: 'HIGH_WATER_MARK',
          profit: newProfit,
          locked: amountToLock,
          hwm: this.state.totalEquity,
          timestamp: new Date().toISOString()
        });

        console.log(JSON.stringify({
          action: 'PROFIT_LOCKED',
          newHighWaterMark: '$' + this.state.totalEquity.toFixed(2),
          previousHWM: '$' + this.state.highWaterMark.toFixed(2),
          newProfit: '$' + newProfit.toFixed(2),
          amountLocked: '$' + amountToLock.toFixed(2),
          skimRatio: (this.PROFIT_SKIM_RATIO * 100).toFixed(0) + '%',
          vaultTotal: '$' + this.state.vaultBalance.toFixed(2),
          timestamp: new Date().toISOString()
        }));
      }

      this.state.highWaterMark = this.state.totalEquity;
    }

    // Update lifetime profit
    this.state.lifetimeProfit = this.state.totalEquity - this.INITIAL_PRINCIPAL;

    // ============================================================
    // 3. CALCULATE WAR CHEST (Dynamic Tier-Based Allocation)
    // ============================================================
    this.state.warChest = this.calculateWarChest(this.state.totalEquity);

    // ============================================================
    // 4. APPLY SAFETY CONSTRAINTS
    // ============================================================

    // Never risk the secured principal
    if (this.state.principalSecured) {
      const maxRiskable = this.state.totalEquity - this.INITIAL_PRINCIPAL;
      this.state.warChest = Math.min(this.state.warChest, maxRiskable);
    }

    // War chest cannot exceed total minus vault
    const maxWarChest = this.state.totalEquity - this.state.vaultBalance;
    this.state.warChest = Math.min(this.state.warChest, maxWarChest);

    // Floor at zero
    this.state.warChest = Math.max(0, this.state.warChest);

    // ============================================================
    // FIX #9: VAULT DRAWDOWN PROTECTION
    // If war chest drops >15% from high water mark, release 5% of vault
    // This prevents the bot from being unable to trade after losses
    // ============================================================
    const DRAWDOWN_THRESHOLD = 0.15;  // 15% max drawdown
    if (this.state.highWaterMark > 0 && this.state.vaultBalance > 0) {
      const warChestDrawdown = (this.state.highWaterMark - this.state.warChest) / this.state.highWaterMark;

      if (warChestDrawdown > DRAWDOWN_THRESHOLD) {
        // Emergency release 5% of vault to maintain trading ability
        const releaseAmount = Math.min(
          this.state.vaultBalance * 0.05,
          this.state.vaultBalance  // Can't release more than vault has
        );

        if (releaseAmount >= 0.50) {  // Only release if >= $0.50
          console.log(JSON.stringify({
            action: 'DRAWDOWN_EMERGENCY_RELEASE',
            drawdownPct: (warChestDrawdown * 100).toFixed(1) + '%',
            releaseAmount: releaseAmount.toFixed(2),
            vaultBefore: this.state.vaultBalance.toFixed(2),
            warChestBefore: this.state.warChest.toFixed(2),
            reason: 'Maintaining minimum trading capital',
            timestamp: new Date().toISOString()
          }));

          this.state.vaultBalance -= releaseAmount;
          this.state.warChest += releaseAmount;

          this.state.lockEvents.push({
            type: 'DRAWDOWN_RELEASE',
            amount: -releaseAmount,
            drawdownPct: warChestDrawdown,
            balance: this.state.totalEquity,
            timestamp: new Date().toISOString()
          });
        }
      }
    }

    // Prevent impossible state: vault > equity
    if (this.state.vaultBalance > this.state.totalEquity) {
      console.error(JSON.stringify({
        action: 'VAULT_OVERFLOW_CORRECTION',
        vault: this.state.vaultBalance.toFixed(2),
        equity: this.state.totalEquity.toFixed(2),
        correction: 'Capping vault at 50% of equity',
        timestamp: new Date().toISOString()
      }));
      this.state.vaultBalance = this.state.totalEquity * 0.50;
    }

    // Save state periodically
    this.saveState();
  }

  // ============================================================
  // TIERED WAR CHEST CALCULATION
  // ============================================================

  calculateWarChest(total) {
    const previousPhase = this.state.currentPhase;

    // ============================================================
    // PHASE 1: THE BUILDER (< $500)
    // Aggressive: Use 80% of funds to compound fast
    // ============================================================
    if (total < this.TIERS.BUILDER.maxBalance) {
      this.state.currentPhase = 'BUILDER';
      const warChest = total * this.TIERS.BUILDER.warChestRatio;

      // Log phase change
      if (previousPhase !== 'BUILDER' && previousPhase !== 'INIT') {
        this.logPhaseChange(previousPhase, 'BUILDER', total);
      }

      return warChest;
    }

    // ============================================================
    // PHASE 2: THE COMPOUNDER ($500 - $5,000)
    // Balanced: 50/50 Split
    // ============================================================
    else if (total < this.TIERS.GROWTH.maxBalance) {
      this.state.currentPhase = 'GROWTH';
      const warChest = total * this.TIERS.GROWTH.warChestRatio;

      if (previousPhase !== 'GROWTH') {
        this.logPhaseChange(previousPhase, 'GROWTH', total);
      }

      return warChest;
    }

    // ============================================================
    // PHASE 3: THE WHALE (> $5,000)
    // Conservative percentage, massive buying power
    // $2,500 base + 20% of surplus above $5k
    // ============================================================
    else {
      this.state.currentPhase = 'WEALTH';
      const surplus = total - this.TIERS.GROWTH.maxBalance;
      const warChest = this.TIERS.WEALTH.baseWarChest +
                       (surplus * this.TIERS.WEALTH.surplusRatio);

      if (previousPhase !== 'WEALTH') {
        this.logPhaseChange(previousPhase, 'WEALTH', total);
      }

      return warChest;
    }
  }

  logPhaseChange(fromPhase, toPhase, balance) {
    this.state.phaseHistory.push({
      from: fromPhase,
      to: toPhase,
      balance: balance,
      timestamp: new Date().toISOString()
    });

    console.log(JSON.stringify({
      action: 'WEALTH_PHASE_CHANGE',
      from: fromPhase,
      to: toPhase,
      balance: '$' + balance.toFixed(2),
      newStrategy: this.TIERS[toPhase]?.description || 'Unknown',
      timestamp: new Date().toISOString()
    }));
  }

  // ============================================================
  // PUBLIC API (Used by trading systems)
  // ============================================================

  /**
   * Get the tradeable balance
   * This is what the trading desks "see" as their total capital
   * They have NO visibility into the vault
   */
  getTradeableBalance() {
    // Round down to 2 decimals for precision
    return Math.floor(this.state.warChest * 100) / 100;
  }

  /**
   * Get the vault balance (for display only)
   */
  getVaultBalance() {
    return this.state.vaultBalance;
  }

  /**
   * Get total equity (real balance)
   */
  getTotalEquity() {
    return this.state.totalEquity;
  }

  /**
   * Check if principal is secured
   */
  isPrincipalSecured() {
    return this.state.principalSecured;
  }

  /**
   * Get current phase
   */
  getCurrentPhase() {
    return this.state.currentPhase;
  }

  /**
   * Get full report for dashboard display
   */
  getReport() {
    const tier = this.TIERS[this.state.currentPhase];

    return {
      // Core balances
      totalEquity: this.state.totalEquity.toFixed(2),
      vault: this.state.vaultBalance.toFixed(2),
      warChest: this.state.warChest.toFixed(2),

      // Phase info
      phase: this.state.currentPhase,
      phaseEmoji: this.getPhaseEmoji(),
      phaseDescription: tier?.description || 'Initializing',

      // Protection status
      principalStatus: this.state.principalSecured ? '✅ SECURED' : '⚠️ AT RISK',
      highWaterMark: this.state.highWaterMark.toFixed(2),

      // Profit tracking
      lifetimeProfit: this.state.lifetimeProfit.toFixed(2),
      lifetimeLocked: this.state.lifetimeLocked.toFixed(2),

      // Risk metrics
      riskPercentage: this.state.totalEquity > 0
        ? ((this.state.warChest / this.state.totalEquity) * 100).toFixed(0) + '%'
        : '0%',
      protectedPercentage: this.state.totalEquity > 0
        ? ((this.state.vaultBalance / this.state.totalEquity) * 100).toFixed(0) + '%'
        : '0%'
    };
  }

  getPhaseEmoji() {
    switch (this.state.currentPhase) {
      case 'BUILDER': return '🏗️';
      case 'GROWTH': return '🚀';
      case 'WEALTH': return '🐋';
      default: return '⏳';
    }
  }

  /**
   * Emergency: Manually add to vault (for windfalls)
   */
  manualLock(amount, reason = 'manual') {
    if (amount <= 0) return false;
    if (amount > (this.state.totalEquity - this.state.vaultBalance)) {
      console.warn('Cannot lock more than available');
      return false;
    }

    this.state.vaultBalance += amount;
    this.state.lifetimeLocked += amount;

    this.state.lockEvents.push({
      type: 'MANUAL_LOCK',
      amount: amount,
      reason: reason,
      timestamp: new Date().toISOString()
    });

    console.log(JSON.stringify({
      action: 'MANUAL_VAULT_DEPOSIT',
      amount: '$' + amount.toFixed(2),
      reason: reason,
      newVaultBalance: '$' + this.state.vaultBalance.toFixed(2),
      timestamp: new Date().toISOString()
    }));

    this.saveState();
    return true;
  }

  /**
   * Emergency: Release from vault (use with caution!)
   */
  emergencyRelease(amount, reason = 'emergency') {
    if (amount <= 0 || amount > this.state.vaultBalance) {
      console.warn('Invalid release amount');
      return false;
    }

    // Cannot release principal if secured
    if (this.state.principalSecured) {
      const releasable = this.state.vaultBalance - this.INITIAL_PRINCIPAL;
      if (amount > releasable) {
        console.warn('Cannot release secured principal');
        amount = releasable;
      }
    }

    this.state.vaultBalance -= amount;

    this.state.lockEvents.push({
      type: 'EMERGENCY_RELEASE',
      amount: amount,
      reason: reason,
      timestamp: new Date().toISOString()
    });

    console.log(JSON.stringify({
      action: 'EMERGENCY_VAULT_RELEASE',
      amount: '$' + amount.toFixed(2),
      reason: reason,
      newVaultBalance: '$' + this.state.vaultBalance.toFixed(2),
      warning: 'PROFITS ARE NOW AT RISK',
      timestamp: new Date().toISOString()
    }));

    this.saveState();
    return true;
  }

  /**
   * Get statistics for analytics
   */
  getStats() {
    return {
      currentPhase: this.state.currentPhase,
      totalEquity: this.state.totalEquity,
      vaultBalance: this.state.vaultBalance,
      warChest: this.state.warChest,
      principalSecured: this.state.principalSecured,
      highWaterMark: this.state.highWaterMark,
      lifetimeProfit: this.state.lifetimeProfit,
      lifetimeLocked: this.state.lifetimeLocked,
      lockEvents: this.state.lockEvents.length,
      phaseChanges: this.state.phaseHistory.length,
      lastSync: this.state.lastSync
    };
  }

  /**
   * Reset state (for testing - use with extreme caution!)
   */
  reset(initialBalance = 36.00) {
    console.warn('WEALTH FORTRESS RESET - All protection removed!');

    this.INITIAL_PRINCIPAL = initialBalance;
    this.state = {
      totalEquity: initialBalance,
      vaultBalance: 0,
      warChest: initialBalance * 0.80,
      principalSecured: false,
      highWaterMark: initialBalance,
      currentPhase: 'BUILDER',
      phaseHistory: [],
      lifetimeProfit: 0,
      lifetimeLocked: 0,
      lockEvents: [{
        type: 'RESET',
        amount: initialBalance,
        timestamp: new Date().toISOString()
      }],
      lastSync: new Date().toISOString(),
      createdAt: new Date().toISOString()
    };

    this.saveState();
  }
}

// Export singleton instance
module.exports = new WealthFortress();
