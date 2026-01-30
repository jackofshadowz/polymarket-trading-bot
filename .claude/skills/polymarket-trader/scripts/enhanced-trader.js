#!/usr/bin/env node

/**
 * Enhanced Polymarket Autonomous Trading Bot
 * Trades ANY markets with statistical edge, arbitrage, or inefficiencies
 */

const crypto = require('crypto');
const https = require('https');
const path = require('path');

// Import information edge detection
let infoEdge;
try {
  infoEdge = require('./info-edge.js');
} catch (e) {
  console.log('Warning: info-edge module not loaded');
}

// Configuration from environment
const CONFIG = {
  apiKey: process.env.POLYMARKET_API_KEY,
  secret: process.env.POLYMARKET_SECRET,
  passphrase: process.env.POLYMARKET_PASSPHRASE,
  address: process.env.POLYMARKET_ADDRESS,

  // Risk management
  maxPositionSize: 0.20, // Max 20% of balance per trade
  minPositionSize: 5,    // Minimum $5 per trade
  maxLoss: 0.30,         // Stop trading if down 30%
  takeProfitTarget: 2.5, // Take profit at 2.5x
  maxConcurrentPositions: 3, // Max 3 open positions

  // Trading parameters
  confidenceThreshold: 0.65, // Minimum confidence to trade
  arbitrageThreshold: 0.02,  // 2% arbitrage opportunity
  host: 'clob.polymarket.com',
  dataHost: 'data-api.polymarket.com',
  gammaHost: 'gamma-api.polymarket.com',

  // Monitoring
  scanInterval: 120000, // Scan every 2 minutes
  startingBalance: 61.0,
};

// Trade history tracking
const tradeHistory = [];
let totalProfit = 0;
let totalLoss = 0;

// HMAC signature for L2 authentication
function signRequest(timestamp, method, path, body = '') {
  const message = timestamp + method + path + body;
  const hmac = crypto.createHmac('sha256', CONFIG.secret);
  return hmac.update(message).digest('base64');
}

// Make authenticated API request
async function apiRequest(method, path, body = null, host = CONFIG.host) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyStr = body ? JSON.stringify(body) : '';

    const headers = {
      'POLY_ADDRESS': CONFIG.address,
      'POLY_API_KEY': CONFIG.apiKey,
      'POLY_PASSPHRASE': CONFIG.passphrase,
      'POLY_SIGNATURE': signRequest(timestamp, method, path, bodyStr),
      'POLY_TIMESTAMP': timestamp,
      'Content-Type': 'application/json',
    };

    const options = {
      hostname: host,
      path: path,
      method: method,
      headers: headers,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// Get account balance
async function getBalance() {
  try {
    const openOrders = await getOpenOrders();
    const reserved = openOrders.reduce((sum, order) => {
      return sum + (parseFloat(order.price) * parseFloat(order.size));
    }, 0);

    return CONFIG.startingBalance + totalProfit - totalLoss - reserved;
  } catch (e) {
    return CONFIG.startingBalance + totalProfit - totalLoss;
  }
}

// Get open orders
async function getOpenOrders() {
  try {
    const orders = await apiRequest('GET', '/orders');
    return Array.isArray(orders) ? orders.filter(o => o.status === 'OPEN' || o.status === 'LIVE') : [];
  } catch (e) {
    return [];
  }
}

// Find ALL active markets with potential opportunities
async function findTradableMarkets() {
  let allMarkets = [];

  // First, search for BTC 15-minute markets specifically
  try {
    const btcSearches = [
      '/markets?slug=btc-updown-15m',
      '/markets?active=true&closed=false',
    ];

    for (const search of btcSearches) {
      const response = await apiRequest('GET', search, null, CONFIG.gammaHost);
      if (Array.isArray(response)) {
        allMarkets = allMarkets.concat(response);
      }
    }

    // Deduplicate by ID
    const seen = new Set();
    allMarkets = allMarkets.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });
  } catch (e) {
    console.log(JSON.stringify({
      action: 'MARKET_SEARCH_ERROR',
      error: e.message,
      timestamp: new Date().toISOString(),
    }));
    return [];
  }

  const now = new Date();
  const maxDaysOut = 7; // Only trade markets closing within 7 days

  // Filter for active, liquid, SHORT-TERM markets with binary outcomes
  const tradableMarkets = allMarkets.filter(market => {
    if (market.closed || !market.active) return false;

    // Must close within maxDaysOut days (short-term only)
    if (market.endDate) {
      const endDate = new Date(market.endDate);
      const daysUntilClose = (endDate - now) / (1000 * 60 * 60 * 24);

      // Skip if closes too far in future or already past
      if (daysUntilClose < 0 || daysUntilClose > maxDaysOut) return false;

      // Prefer markets closing within hours/days
      market._hoursUntilClose = daysUntilClose * 24;
    } else {
      // Skip markets without end date
      return false;
    }

    // Must have reasonable volume (at least $1000)
    const volume = parseFloat(market.volume24hr || market.volume || 0);
    if (volume < 1000) return false;

    // Must have liquidity
    const liquidity = parseFloat(market.liquidity || 0);
    if (liquidity < 100) return false;

    // Binary markets only (Yes/No)
    try {
      const outcomes = JSON.parse(market.outcomes || '[]');
      if (outcomes.length !== 2) return false;
    } catch (e) {
      return false;
    }

    return true;
  });

  // Sort by time to close (shortest first)
  tradableMarkets.sort((a, b) => a._hoursUntilClose - b._hoursUntilClose);

  return tradableMarkets;
}

// Get current orderbook and market data
async function getMarketData(tokenId) {
  try {
    const [book, price, midpoint] = await Promise.all([
      apiRequest('GET', `/book?token_id=${tokenId}`),
      apiRequest('GET', `/price?token_id=${tokenId}`),
      apiRequest('GET', `/midpoint?token_id=${tokenId}`),
    ]);

    return { book, price, midpoint };
  } catch (e) {
    return null;
  }
}

// Detect arbitrage opportunities
function detectArbitrage(marketData) {
  if (!marketData || !marketData.book || !marketData.book.bids || !marketData.book.asks) {
    return null;
  }

  const bestBid = marketData.book.bids[0];
  const bestAsk = marketData.book.asks[0];

  if (!bestBid || !bestAsk) return null;

  const bidPrice = parseFloat(bestBid.price);
  const askPrice = parseFloat(bestAsk.price);

  // Check for crossed orderbook (instant arbitrage)
  if (bidPrice > askPrice) {
    return {
      type: 'CROSSED_ORDERBOOK',
      buyPrice: askPrice,
      sellPrice: bidPrice,
      profit: bidPrice - askPrice,
      confidence: 0.95,
    };
  }

  // Check for mispricing vs fair value
  const midpoint = parseFloat(marketData.midpoint?.mid || 0.5);
  const spread = askPrice - bidPrice;

  // If spread is very tight and price is far from 0.5, potential edge
  if (spread < 0.02) {
    if (midpoint < 0.3) {
      return {
        type: 'UNDERVALUED',
        buyPrice: askPrice,
        expectedValue: 0.5,
        edge: 0.5 - askPrice,
        confidence: 0.7,
      };
    } else if (midpoint > 0.7) {
      return {
        type: 'OVERVALUED',
        sellPrice: bidPrice,
        expectedValue: 0.5,
        edge: bidPrice - 0.5,
        confidence: 0.7,
      };
    }
  }

  return null;
}

// Analyze market for statistical edges
function analyzeMarketEdge(market, marketData) {
  const analysis = {
    hasEdge: false,
    confidence: 0.5,
    recommendation: 'HOLD',
    reasoning: [],
    type: null,
  };

  if (!marketData || !marketData.book) {
    return analysis;
  }

  // Check for arbitrage first
  const arbitrage = detectArbitrage(marketData);
  if (arbitrage && arbitrage.confidence >= CONFIG.confidenceThreshold) {
    analysis.hasEdge = true;
    analysis.confidence = arbitrage.confidence;
    analysis.type = arbitrage.type;
    analysis.recommendation = arbitrage.type === 'OVERVALUED' ? 'SELL' : 'BUY';
    analysis.reasoning.push(`${arbitrage.type} detected with ${(arbitrage.profit || arbitrage.edge * 100).toFixed(2)}% edge`);
    analysis.price = arbitrage.type === 'OVERVALUED' ? arbitrage.sellPrice : arbitrage.buyPrice;
    return analysis;
  }

  // Orderbook imbalance analysis
  const bids = marketData.book.bids || [];
  const asks = marketData.book.asks || [];

  const bidVolume = bids.reduce((sum, o) => sum + parseFloat(o.size || 0), 0);
  const askVolume = asks.reduce((sum, o) => sum + parseFloat(o.size || 0), 0);

  const totalVolume = bidVolume + askVolume;
  if (totalVolume > 0) {
    const bidRatio = bidVolume / totalVolume;
    const askRatio = askVolume / totalVolume;

    // Strong imbalance = potential edge
    if (bidRatio > 0.75) {
      analysis.hasEdge = true;
      analysis.confidence = Math.min(0.60 + (bidRatio - 0.75) * 0.4, 0.85);
      analysis.recommendation = 'BUY';
      analysis.type = 'ORDERBOOK_IMBALANCE';
      analysis.reasoning.push(`Strong buy pressure: ${(bidRatio * 100).toFixed(1)}% bids`);
      analysis.price = asks[0]?.price || 0.5;
    } else if (askRatio > 0.75) {
      analysis.hasEdge = true;
      analysis.confidence = Math.min(0.60 + (askRatio - 0.75) * 0.4, 0.85);
      analysis.recommendation = 'SELL';
      analysis.type = 'ORDERBOOK_IMBALANCE';
      analysis.reasoning.push(`Strong sell pressure: ${(askRatio * 100).toFixed(1)}% asks`);
      analysis.price = bids[0]?.price || 0.5;
    }
  }

  // Volume spike analysis
  const volume24h = parseFloat(market.volume24hr || 0);
  const volume1w = parseFloat(market.volume1wk || 0) / 7; // Daily average

  if (volume1w > 0 && volume24h > volume1w * 3) {
    analysis.reasoning.push(`Volume spike: ${(volume24h / volume1w).toFixed(1)}x average`);
    analysis.confidence += 0.1;
  }

  // Price momentum
  const priceChange24h = parseFloat(market.oneDayPriceChange || 0);
  if (Math.abs(priceChange24h) > 0.1) {
    const direction = priceChange24h > 0 ? 'bullish' : 'bearish';
    analysis.reasoning.push(`Strong ${direction} momentum: ${(priceChange24h * 100).toFixed(1)}%`);

    if (!analysis.hasEdge && Math.abs(priceChange24h) > 0.2) {
      analysis.hasEdge = true;
      analysis.confidence = 0.65;
      analysis.recommendation = priceChange24h > 0 ? 'BUY' : 'SELL';
      analysis.type = 'MOMENTUM';
      analysis.price = priceChange24h > 0 ? asks[0]?.price : bids[0]?.price;
    }
  }

  return analysis;
}

// Calculate position size based on confidence and balance
function calculatePositionSize(balance, confidence, edge = 0) {
  // Kelly Criterion with safety factor
  const kellyFraction = (edge > 0 ? edge : (confidence - 0.5)) * 0.25; // 25% Kelly
  const positionFraction = Math.min(kellyFraction, CONFIG.maxPositionSize);
  const positionSize = balance * positionFraction;

  return Math.max(positionSize, CONFIG.minPositionSize);
}

// Place an order
async function placeOrder(tokenId, side, price, size, market) {
  const orderPayload = {
    tokenID: tokenId,
    price: price.toFixed(2),
    size: Math.floor(size),
    side: side.toUpperCase(),
    orderType: 'GTC',
  };

  try {
    const response = await apiRequest('POST', '/order', orderPayload);

    const trade = {
      market: market.question,
      tokenId: tokenId,
      side: side,
      price: price,
      size: size,
      timestamp: new Date().toISOString(),
      response: response,
    };

    tradeHistory.push(trade);

    console.log(JSON.stringify({
      action: 'ORDER_PLACED',
      trade: trade,
      timestamp: new Date().toISOString(),
    }));

    return response;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'ORDER_FAILED',
      error: error.message,
      market: market.question,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

// Main trading scan
async function scanAndTrade() {
  try {
    console.log(JSON.stringify({
      action: 'SCAN_START',
      timestamp: new Date().toISOString(),
    }));

    // Check balance and circuit breaker
    const balance = await getBalance();
    console.log(JSON.stringify({
      action: 'BALANCE_CHECK',
      balance: balance,
      profit: totalProfit,
      loss: totalLoss,
      netPL: totalProfit - totalLoss,
      timestamp: new Date().toISOString(),
    }));

    // Circuit breaker - stop if down 30%
    if (balance < CONFIG.startingBalance * (1 - CONFIG.maxLoss)) {
      console.log(JSON.stringify({
        action: 'CIRCUIT_BREAKER',
        message: 'Maximum loss threshold reached',
        balance: balance,
        maxAllowed: CONFIG.startingBalance * (1 - CONFIG.maxLoss),
        timestamp: new Date().toISOString(),
      }));
      process.exit(0);
    }

    // Take profit - exit if target reached
    if (balance >= CONFIG.startingBalance * CONFIG.takeProfitTarget) {
      console.log(JSON.stringify({
        action: 'TAKE_PROFIT',
        message: 'Profit target reached!',
        balance: balance,
        target: CONFIG.startingBalance * CONFIG.takeProfitTarget,
        return: ((balance / CONFIG.startingBalance - 1) * 100).toFixed(2) + '%',
        timestamp: new Date().toISOString(),
      }));
      process.exit(0);
    }

    // Check position limits
    const openPositions = await getOpenOrders();
    if (openPositions.length >= CONFIG.maxConcurrentPositions) {
      console.log(JSON.stringify({
        action: 'POSITION_LIMIT',
        openPositions: openPositions.length,
        maxAllowed: CONFIG.maxConcurrentPositions,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Find tradable markets
    const markets = await findTradableMarkets();
    console.log(JSON.stringify({
      action: 'MARKETS_SCANNED',
      count: markets.length,
      timestamp: new Date().toISOString(),
    }));

    // Analyze top markets for opportunities
    const opportunities = [];

    for (const market of markets.slice(0, 50)) {
      // Get token ID
      let tokenId;
      try {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        tokenId = tokenIds[0];
      } catch (e) {
        continue;
      }

      // Get market data
      const marketData = await getMarketData(tokenId);
      if (!marketData) continue;

      // First check for information-based arbitrage
      let analysis = null;
      if (infoEdge) {
        analysis = await infoEdge.analyzeWithExternalInfo(market, marketData);
      }

      // If no info edge found, use standard analysis
      if (!analysis || !analysis.confidence || analysis.confidence < CONFIG.confidenceThreshold) {
        analysis = analyzeMarketEdge(market, marketData);
      }

      if (analysis.hasEdge && analysis.confidence >= CONFIG.confidenceThreshold) {
        opportunities.push({
          market: market,
          tokenId: tokenId,
          analysis: analysis,
          marketData: marketData,
        });
      }

      // Rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(JSON.stringify({
      action: 'OPPORTUNITIES_FOUND',
      count: opportunities.length,
      timestamp: new Date().toISOString(),
    }));

    // Sort by confidence and trade the best
    opportunities.sort((a, b) => b.analysis.confidence - a.analysis.confidence);

    for (const opp of opportunities.slice(0, CONFIG.maxConcurrentPositions - openPositions.length)) {
      const { market, tokenId, analysis, marketData } = opp;

      const positionSize = calculatePositionSize(balance, analysis.confidence);
      const price = parseFloat(analysis.price);

      console.log(JSON.stringify({
        action: 'TRADE_OPPORTUNITY',
        market: market.question,
        type: analysis.type,
        recommendation: analysis.recommendation,
        confidence: analysis.confidence,
        price: price,
        size: positionSize,
        reasoning: analysis.reasoning,
        timestamp: new Date().toISOString(),
      }));

      // Place the order
      try {
        await placeOrder(tokenId, analysis.recommendation, price, positionSize, market);
      } catch (error) {
        console.log(JSON.stringify({
          action: 'TRADE_ERROR',
          error: error.message,
          timestamp: new Date().toISOString(),
        }));
      }
    }

  } catch (error) {
    console.error(JSON.stringify({
      action: 'SCAN_ERROR',
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Continuous monitoring loop
async function startMonitoring() {
  console.log(JSON.stringify({
    action: 'MONITORING_START',
    config: {
      startingBalance: CONFIG.startingBalance,
      confidenceThreshold: CONFIG.confidenceThreshold,
      maxPositionSize: CONFIG.maxPositionSize,
      maxConcurrentPositions: CONFIG.maxConcurrentPositions,
      scanInterval: CONFIG.scanInterval / 1000 + 's',
    },
    timestamp: new Date().toISOString(),
  }));

  // Run first scan immediately
  await scanAndTrade();

  // Then run on interval
  setInterval(async () => {
    await scanAndTrade();
  }, CONFIG.scanInterval);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(JSON.stringify({
    action: 'SHUTDOWN',
    totalTrades: tradeHistory.length,
    totalProfit: totalProfit,
    totalLoss: totalLoss,
    netPL: totalProfit - totalLoss,
    timestamp: new Date().toISOString(),
  }));
  process.exit(0);
});

// Start if run directly
if (require.main === module) {
  startMonitoring().catch(console.error);
}

module.exports = { scanAndTrade, startMonitoring };
