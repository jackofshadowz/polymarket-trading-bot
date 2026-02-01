/**
 * BASE WEBSOCKET ORACLE
 *
 * Shared utilities for all WebSocket-based oracles.
 * Provides reconnection logic, heartbeat management, and error handling.
 */

const WebSocket = require('ws');

class BaseWebSocketOracle {
  constructor(config) {
    this.config = {
      reconnectDelayMs: 5000,
      maxReconnectAttempts: 10,
      heartbeatIntervalMs: null,  // Set for exchanges that require ping (Bybit: 20000, OKX: 25000)
      ...config
    };

    this.ws = null;
    this.isConnected = false;
    this.reconnectAttempts = 0;
    this.heartbeatInterval = null;
    this.name = config.name || 'BaseOracle';
  }

  /**
   * Connect to the WebSocket
   */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    console.log(JSON.stringify({
      action: `${this.name}_WS_CONNECTING`,
      url: this.config.wsUrl,
      timestamp: new Date().toISOString()
    }));

    this.ws = new WebSocket(this.config.wsUrl);

    this.ws.on('open', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;

      console.log(JSON.stringify({
        action: `${this.name}_WS_CONNECTED`,
        timestamp: new Date().toISOString()
      }));

      // Start heartbeat if configured
      if (this.config.heartbeatIntervalMs) {
        this.startHeartbeat();
      }

      // Call subclass handler
      this.onConnect();
    });

    this.ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        this.onMessage(parsed);
      } catch (e) {
        // Some exchanges send non-JSON pongs
        const text = data.toString();
        if (text === 'pong' || text.includes('pong')) {
          return;  // Ignore pong responses
        }
      }
    });

    this.ws.on('close', () => {
      this.isConnected = false;
      this.stopHeartbeat();

      console.log(JSON.stringify({
        action: `${this.name}_WS_DISCONNECTED`,
        timestamp: new Date().toISOString()
      }));

      this.onDisconnect();
      this.scheduleReconnect();
    });

    this.ws.on('error', (error) => {
      console.log(JSON.stringify({
        action: `${this.name}_WS_ERROR`,
        error: error.message,
        timestamp: new Date().toISOString()
      }));

      this.onError(error);
    });
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect() {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.log(JSON.stringify({
        action: `${this.name}_WS_MAX_RECONNECTS`,
        attempts: this.reconnectAttempts,
        timestamp: new Date().toISOString()
      }));
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelayMs * Math.pow(1.5, this.reconnectAttempts - 1);

    console.log(JSON.stringify({
      action: `${this.name}_WS_RECONNECTING`,
      attempt: this.reconnectAttempts,
      delayMs: Math.round(delay),
      timestamp: new Date().toISOString()
    }));

    setTimeout(() => this.connect(), delay);
  }

  /**
   * Start heartbeat interval for exchanges that require ping
   */
  startHeartbeat() {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.sendHeartbeat();
      }
    }, this.config.heartbeatIntervalMs);
  }

  /**
   * Stop heartbeat interval
   */
  stopHeartbeat() {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  /**
   * Send heartbeat - override in subclass for exchange-specific ping format
   */
  sendHeartbeat() {
    // Default: WebSocket ping frame
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.ping();
    }
  }

  /**
   * Send JSON data to the WebSocket
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  /**
   * Send raw string to the WebSocket
   */
  sendRaw(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  /**
   * Graceful shutdown
   */
  shutdown() {
    this.stopHeartbeat();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;

    console.log(JSON.stringify({
      action: `${this.name}_SHUTDOWN`,
      timestamp: new Date().toISOString()
    }));
  }

  // Override in subclasses
  onConnect() {}
  onDisconnect() {}
  onMessage(data) {}
  onError(error) {}
}

module.exports = { BaseWebSocketOracle };
