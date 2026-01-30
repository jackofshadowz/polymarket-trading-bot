#!/usr/bin/env node
// ============================================================
// SIMPLE MOMENTUM BOT - Based on $402k/month trader
// ============================================================
// Strategy: Follow short-term momentum with many small orders
// Budget: $5 per 15-minute window
// Orders: 5-10 small bets ($0.50-$1.50 each)
// Direction: NEVER hedge, commit to one side per window
// Profile: https://polymarket.com/@k9Q2mX4L8A7ZP3R

const WebSocket = require('ws');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const momentumSplitter = require('./momentum-splitter');

// ============================================================
// CONFIGURATION
// ============================================================

const CONFIG = {
  priceCheckInterval: 5000,        // Check every 5 seconds
  budgetPerWindow: 5.00,           // $5 per window
  maxOrdersPerWindow: 10,          // Max 10 orders
};

// ============================================================
// STATE
// ============================================================

let MEMORY = {
  trades: [],
  priceHistory: [],
  activeBalance: 0,
  currentWindow: null,
};

let CURRENT_PRICE = null;
let WS_BINANCE = null;

// ============================================================
// PRICE TRACKING
// ============================================================

function connectBinanceWebSocket() {
  WS_BINANCE = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@ticker');

  WS_BINANCE.on('open', () => {
    console.log(JSON.stringify({
      action: 'WEBSOCKET_CONNECTED',
      source: 'Binance',
      timestamp: new Date().toISOString(),
    }));
  });

  WS_BINANCE.on('message', (data) => {
    try {
      const ticker = JSON.parse(data);
      const price = parseFloat(ticker.c);
      updatePrice(price);
    } catch (e) {
      // Ignore
    }
  });

  WS_BINANCE.on('close', () => {
    console.log(JSON.stringify({action: 'WEBSOCKET_CLOSED', source: 'Binance'}));
    setTimeout(connectBinanceWebSocket, 5000);
  });

  WS_BINANCE.on('error', () => {
    // Will reconnect on close
  });
}

function updatePrice(price) {
  CURRENT_PRICE = price;

  // Add to history
  MEMORY.priceHistory.push({
    price: price,
    timestamp: Date.now()
  });

  // Keep last 15 minutes of prices (180 samples at 5s intervals)
  if (MEMORY.priceHistory.length > 180) {
    MEMORY.priceHistory = MEMORY.priceHistory.slice(-180);
  }
}

// ============================================================
// WINDOW MANAGEMENT
// ============================================================

function getCurrentWindow() {
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 900) * 900;
  const currentWindowEnd = currentWindowStart + 900;

  return {
    start: currentWindowStart,
    end: currentWindowEnd,
    slug: `btc-updown-15m-${currentWindowEnd}`,
    timeUntilStart: currentWindowStart - now,
    timeLeft: currentWindowEnd - now,
  };
}

// ============================================================
// BETTING LOGIC
// ============================================================

async function placeBet(window, decision) {
  const cmd = `pmarket-cli trade "${decision.market}" ${decision.side} ${decision.size} --price ${decision.maxPrice}`;

  return new Promise((resolve) => {
    exec(cmd, (error, stdout) => {
      if (error) {
        console.error(JSON.stringify({
          action: 'BET_FAILED',
          error: error.message,
          window: window.slug
        }));
        resolve(false);
        return;
      }

      console.log(JSON.stringify({
        action: 'BET_SUCCESS',
        window: window.slug,
        side: decision.side,
        size: decision.size,
        confidence: (decision.confidence * 100).toFixed(0) + '%',
        reasoning: decision.reasoning,
        timestamp: new Date().toISOString()
      }));

      // Record order
      momentumSplitter.recordOrder(window.slug, decision);

      // Track in memory
      MEMORY.trades.push({
        window: window.slug,
        side: decision.side,
        size: decision.size,
        confidence: decision.confidence,
        timestamp: Date.now(),
        status: 'open'
      });

      resolve(true);
    });
  });
}

async function fetchCurrentMarket(window) {
  return new Promise((resolve) => {
    exec('pmarket-cli markets --search "Bitcoin Up or Down" --limit 5', (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }

      try {
        const lines = stdout.split('\n');
        for (const line of lines) {
          // Look for current 15-min window
          if (line.includes('Bitcoin Up or Down') && line.includes('15')) {
            // Parse market name and prices
            const match = line.match(/"([^"]+)"/);
            if (match) {
              const marketName = match[1];
              const priceMatch = line.match(/YES:\s*([\d.]+)¢/);
              const yesPrice = priceMatch ? parseFloat(priceMatch[1]) / 100 : null;

              resolve({
                name: marketName,
                yesPrice: yesPrice,
                noPrice: yesPrice ? (1 - yesPrice) : null
              });
              return;
            }
          }
        }
        resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  });
}

// ============================================================
// MAIN TRADING LOOP
// ============================================================

async function tradingLoop() {
  console.log(JSON.stringify({
    action: 'SIMPLE_MOMENTUM_BOT_START',
    strategy: 'Follow short-term momentum with order splitting',
    budget: '$' + CONFIG.budgetPerWindow + ' per window',
    maxOrders: CONFIG.maxOrdersPerWindow,
    minOrderSize: '$' + momentumSplitter.STRATEGY_CONFIG.minOrderSize,
    maxOrderSize: '$' + momentumSplitter.STRATEGY_CONFIG.maxOrderSize,
    timestamp: new Date().toISOString()
  }));

  while (true) {
    try {
      const window = getCurrentWindow();

      // Update current window if changed
      if (!MEMORY.currentWindow || MEMORY.currentWindow.slug !== window.slug) {
        MEMORY.currentWindow = window;
        console.log(JSON.stringify({
          action: 'NEW_WINDOW',
          window: window.slug,
          timeLeft: window.timeLeft + 's',
          timestamp: new Date().toISOString()
        }));

        // Cleanup old window states
        momentumSplitter.cleanupOldWindows();
      }

      // Skip if window hasn't started yet
      if (window.timeUntilStart > 0) {
        await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
        continue;
      }

      // Calculate momentum
      const momentum = momentumSplitter.calculateShortTermMomentum(MEMORY.priceHistory);

      // Get window state
      const windowState = momentumSplitter.getWindowState(window.slug);

      // Log status
      console.log(JSON.stringify({
        action: 'STATUS',
        window: window.slug,
        timeLeft: window.timeLeft + 's',
        btcPrice: CURRENT_PRICE ? CURRENT_PRICE.toFixed(2) : 'N/A',
        momentum: momentum.direction ? `${momentum.direction} ${momentum.momentum.toFixed(2)}%` : 'NEUTRAL',
        confidence: (momentum.confidence * 100).toFixed(0) + '%',
        orders: `${windowState.ordersPlaced}/${CONFIG.maxOrdersPerWindow}`,
        spent: `$${windowState.totalSpent.toFixed(2)}/$${CONFIG.budgetPerWindow}`,
        timestamp: new Date().toISOString()
      }));

      // Decide if we should place an order
      const decision = momentumSplitter.shouldPlaceOrder(window.slug, momentum, window.timeLeft);

      if (decision) {
        // Fetch current market
        const market = await fetchCurrentMarket(window);

        if (market) {
          // Determine max price we're willing to pay
          const maxPrice = decision.side === 'YES' ?
            Math.min(0.95, market.yesPrice + 0.05) :
            Math.min(0.95, market.noPrice + 0.05);

          const betDecision = {
            market: market.name,
            side: decision.side,
            size: decision.size,
            maxPrice: maxPrice.toFixed(4),
            confidence: decision.confidence,
            reasoning: decision.reasoning
          };

          console.log(JSON.stringify({
            action: 'PLACING_ORDER',
            window: window.slug,
            orderNumber: windowState.ordersPlaced + 1,
            ...betDecision,
            timestamp: new Date().toISOString()
          }));

          await placeBet(window, betDecision);
        } else {
          console.log(JSON.stringify({
            action: 'NO_MARKET_FOUND',
            window: window.slug
          }));
        }
      }

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'LOOP_ERROR',
        error: error.message,
        stack: error.stack
      }));
      await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
    }
  }
}

// ============================================================
// FETCH BALANCE
// ============================================================

async function getLiveBalance() {
  return new Promise((resolve) => {
    exec('pmarket-cli balance', (error, stdout) => {
      if (error) {
        console.warn('Balance fetch failed, using fallback');
        resolve(100); // Fallback
        return;
      }

      try {
        const match = stdout.match(/([\d.]+)\s*USDC/);
        if (match) {
          resolve(parseFloat(match[1]));
        } else {
          resolve(100);
        }
      } catch (e) {
        resolve(100);
      }
    });
  });
}

// ============================================================
// START
// ============================================================

async function start() {
  console.log(JSON.stringify({
    action: 'INITIALIZING',
    strategy: 'Simple Momentum Splitter (based on $402k/month trader)',
    profile: 'https://polymarket.com/@k9Q2mX4L8A7ZP3R',
    timestamp: new Date().toISOString()
  }));

  // Fetch balance
  MEMORY.activeBalance = await getLiveBalance();
  console.log(JSON.stringify({
    action: 'BALANCE_LOADED',
    balance: '$' + MEMORY.activeBalance.toFixed(2)
  }));

  // Connect to price feed
  connectBinanceWebSocket();

  // Wait for WebSocket to connect
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Start trading loop
  await tradingLoop();
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start };
