// ============================================================
// ORACLE DESK - The Source of Truth (Real-time Binance Data)
// ============================================================
// This desk streams the fastest possible BTC price data.
// Binance WebSocket is ~200-500ms faster than REST API polling.
// The Oracle is the "eyes" - it sees reality before Polymarket does.
// ============================================================

const WebSocket = require('ws');

class OracleDesk {
  constructor() {
    this.currentPrice = null;
    this.openPrice = null;      // Price at start of 15m window
    this.windowStartTime = null; // Timestamp of window start
    this.ws = null;
    this.listeners = [];        // Callbacks to notify on price updates
    this.priceHistory = [];     // Last 60 prices for volatility calc
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.isConnected = false;
  }

  start() {
    this.connect();
  }

  connect() {
    // Use trade stream for fastest updates (individual trades)
    this.ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      console.log(JSON.stringify({
        action: 'ORACLE_CONNECTED',
        source: 'Binance Trade Stream',
        latency: '~200ms faster than REST',
        timestamp: new Date().toISOString()
      }));
    });

    this.ws.on('message', (data) => {
      try {
        const trade = JSON.parse(data);
        const price = parseFloat(trade.p);
        const prevPrice = this.currentPrice;

        this.currentPrice = price;

        // Track price history for volatility analysis
        this.priceHistory.push({
          price: price,
          timestamp: Date.now()
        });

        // Keep only last 60 data points
        if (this.priceHistory.length > 60) {
          this.priceHistory = this.priceHistory.slice(-60);
        }

        // Notify all listeners immediately
        this.listeners.forEach(callback => {
          try {
            callback(price, prevPrice);
          } catch (e) {
            // Listener error shouldn't crash oracle
          }
        });
      } catch (e) {
        // Ignore parse errors
      }
    });

    this.ws.on('error', (err) => {
      console.error(JSON.stringify({
        action: 'ORACLE_ERROR',
        error: err.message,
        timestamp: new Date().toISOString()
      }));
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      console.log(JSON.stringify({
        action: 'ORACLE_DISCONNECTED',
        reconnectAttempt: this.reconnectAttempts + 1,
        timestamp: new Date().toISOString()
      }));

      // Auto-reconnect
      if (this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => this.connect(), 2000 * this.reconnectAttempts);
      }
    });
  }

  /**
   * Lock the window opening price
   * Call this at the exact start of each 15m window
   */
  setWindowOpenPrice(price) {
    this.openPrice = price || this.currentPrice;
    this.windowStartTime = Date.now();

    console.log(JSON.stringify({
      action: 'ORACLE_WINDOW_LOCKED',
      openPrice: this.openPrice.toFixed(2),
      timestamp: new Date().toISOString()
    }));
  }

  /**
   * Auto-detect and lock window open price based on 15m boundaries
   */
  autoLockWindowOpen() {
    const now = Math.floor(Date.now() / 1000);
    const currentWindowStart = Math.floor(now / 900) * 900;

    // If we haven't locked this window yet, lock it
    if (!this.windowStartTime || Math.floor(this.windowStartTime / 1000 / 900) * 900 !== currentWindowStart) {
      this.setWindowOpenPrice(this.currentPrice);
    }
  }

  /**
   * Get current trend analysis
   * This is the core data the Clipper Desk uses for decisions
   */
  getTrend() {
    if (!this.openPrice || !this.currentPrice) {
      return {
        available: false,
        price: this.currentPrice,
        delta: 0,
        deltaPct: 0,
        direction: 'UNKNOWN'
      };
    }

    const delta = this.currentPrice - this.openPrice;
    const deltaPct = (delta / this.openPrice) * 100;

    // Calculate volatility from recent prices
    let volatility = 0;
    if (this.priceHistory.length >= 10) {
      const recentPrices = this.priceHistory.slice(-10).map(p => p.price);
      const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
      const variance = recentPrices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / recentPrices.length;
      volatility = Math.sqrt(variance);
    }

    // Safety flags for emergency brake
    const isCrashing = deltaPct < -0.30;  // -0.3% = danger
    const isPumping = deltaPct > 0.30;    // +0.3% = strong trend
    const isChoppy = volatility > 20;     // High volatility = risky

    return {
      available: true,
      price: this.currentPrice,
      open: this.openPrice,
      delta: delta,
      deltaPct: deltaPct,
      direction: deltaPct > 0.02 ? 'UP' : (deltaPct < -0.02 ? 'DOWN' : 'FLAT'),
      volatility: volatility,
      // Safety flags
      isCrashing: isCrashing,
      isPumping: isPumping,
      isChoppy: isChoppy,
      // Interpreted signals
      isSafeToBuyYes: deltaPct >= -0.10 && !isCrashing,  // OK to buy YES if not crashing
      isSafeToBuyNo: deltaPct <= 0.10 && !isPumping,     // OK to buy NO if not pumping
      // Latency arbitrage signals
      polymarketLagging: null // Set by comparing to Polymarket prices
    };
  }

  /**
   * Compare Oracle price to Polymarket implied price
   * Detects latency arbitrage opportunities
   *
   * @param {number} polyYesPrice - Polymarket YES price
   * @param {number} polyNoPrice - Polymarket NO price
   */
  detectLatencyArb(polyYesPrice, polyNoPrice) {
    const trend = this.getTrend();
    if (!trend.available) return null;

    // Polymarket's implied probability
    const impliedUpProb = polyYesPrice;
    const impliedDownProb = polyNoPrice;

    // Oracle's "true" probability based on Binance delta
    // Simple model: tanh curve maps delta to probability
    const trueProbUp = 0.50 + Math.tanh(trend.deltaPct * 3) * 0.40;

    // Edge = what Oracle says vs what Polymarket says
    const yesEdge = trueProbUp - impliedUpProb;
    const noEdge = (1 - trueProbUp) - impliedDownProb;

    const minEdge = 0.05; // Need 5% edge minimum

    if (yesEdge > minEdge && polyYesPrice < 0.85) {
      return {
        opportunity: true,
        action: 'BUY_YES',
        edge: yesEdge,
        reason: `Oracle: ${(trueProbUp * 100).toFixed(0)}% vs Poly: ${(impliedUpProb * 100).toFixed(0)}%`,
        maxPrice: Math.min(trueProbUp, 0.85)
      };
    }

    if (noEdge > minEdge && polyNoPrice < 0.85) {
      return {
        opportunity: true,
        action: 'BUY_NO',
        edge: noEdge,
        reason: `Oracle: ${((1 - trueProbUp) * 100).toFixed(0)}% vs Poly: ${(impliedDownProb * 100).toFixed(0)}%`,
        maxPrice: Math.min(1 - trueProbUp, 0.85)
      };
    }

    return { opportunity: false };
  }

  /**
   * Register a callback to be notified on every price update
   * Use sparingly - this fires on every trade (~10-50/second)
   */
  onPriceUpdate(callback) {
    this.listeners.push(callback);
  }

  /**
   * Remove a price update listener
   */
  removeListener(callback) {
    this.listeners = this.listeners.filter(cb => cb !== callback);
  }

  /**
   * Get current status for logging
   */
  getStatus() {
    const trend = this.getTrend();
    return {
      connected: this.isConnected,
      currentPrice: this.currentPrice,
      openPrice: this.openPrice,
      delta: trend.delta ? trend.delta.toFixed(2) : 'N/A',
      deltaPct: trend.deltaPct ? trend.deltaPct.toFixed(3) + '%' : 'N/A',
      direction: trend.direction,
      volatility: trend.volatility ? trend.volatility.toFixed(2) : 'N/A',
      isCrashing: trend.isCrashing,
      isPumping: trend.isPumping
    };
  }

  /**
   * Stop the Oracle (cleanup)
   */
  stop() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.listeners = [];
    this.isConnected = false;
  }
}

// Export singleton instance
module.exports = new OracleDesk();
