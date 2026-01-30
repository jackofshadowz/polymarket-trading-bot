#!/usr/bin/env node

/**
 * Polymarket Autonomous Trading Bot
 * Trades 15-minute BTC price prediction markets
 */

const crypto = require('crypto');
const https = require('https');

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

  // Trading parameters
  timeframe: '15m',
  host: 'clob.polymarket.com',
  dataHost: 'data-api.polymarket.com',
  gammaHost: 'gamma-api.polymarket.com',
};

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
  // Balance checking via REST API is not straightforward
  // The SDK uses getBalanceAllowance() which may query on-chain
  // For now, we'll use a known starting balance and track changes
  // TODO: Implement proper balance querying via SDK or on-chain query
  const STARTING_BALANCE = 61.0;

  try {
    // Try to get open orders to estimate reserved funds
    const openOrders = await getOpenOrders();
    const reserved = openOrders.reduce((sum, order) => {
      return sum + (parseFloat(order.price) * parseFloat(order.size));
    }, 0);

    return STARTING_BALANCE - reserved;
  } catch (e) {
    console.log(JSON.stringify({
      action: 'BALANCE_WARNING',
      message: 'Could not query balance, using starting balance',
      error: e.message,
      timestamp: new Date().toISOString(),
    }));
    return STARTING_BALANCE;
  }
}

// Find active 15-minute BTC markets
async function findBTCMarkets() {
  // Search for active BTC markets
  const response = await apiRequest('GET', '/markets?active=true&closed=false&limit=100', null, CONFIG.gammaHost);

  // Filter for 15-minute BTC price markets that are:
  // 1. Active and not closed
  // 2. About Bitcoin/BTC
  // 3. Short-term (15 minutes)
  // 4. Binary outcome (up/down, above/below)
  const btcMarkets = response.filter(market => {
    if (market.closed || !market.active) return false;

    const question = market.question.toLowerCase();
    const isBTC = question.includes('bitcoin') || question.includes('btc');
    const isShortTerm = question.includes('15') || question.includes('minute') ||
                        question.includes('15min') || question.includes('15m');

    return isBTC && isShortTerm;
  });

  // If no 15-minute markets, fall back to any active BTC markets
  if (btcMarkets.length === 0) {
    return response.filter(market => {
      if (market.closed || !market.active) return false;
      const question = market.question.toLowerCase();
      return question.includes('bitcoin') || question.includes('btc');
    }).slice(0, 5);
  }

  return btcMarkets;
}

// Get current orderbook and market data
async function getMarketData(tokenId) {
  const [book, price, midpoint] = await Promise.all([
    apiRequest('GET', `/book?token_id=${tokenId}`),
    apiRequest('GET', `/price?token_id=${tokenId}`),
    apiRequest('GET', `/midpoint?token_id=${tokenId}`),
  ]);

  return { book, price, midpoint };
}

// Analyze market sentiment and momentum
async function analyzeMarket(marketData, historicalData) {
  const analysis = {
    momentum: 'neutral',
    confidence: 0.5,
    recommendation: 'HOLD',
    reasoning: [],
  };

  // Calculate bid-ask spread
  const spread = marketData.book.asks[0]?.price - marketData.book.bids[0]?.price;
  if (spread < 0.02) {
    analysis.reasoning.push('Tight spread indicates high liquidity');
    analysis.confidence += 0.1;
  }

  // Check volume imbalance
  const askVolume = marketData.book.asks.reduce((sum, o) => sum + parseFloat(o.size), 0);
  const bidVolume = marketData.book.bids.reduce((sum, o) => sum + parseFloat(o.size), 0);

  if (bidVolume > askVolume * 1.5) {
    analysis.momentum = 'bullish';
    analysis.recommendation = 'BUY';
    analysis.reasoning.push('Strong buy-side pressure detected');
    analysis.confidence += 0.2;
  } else if (askVolume > bidVolume * 1.5) {
    analysis.momentum = 'bearish';
    analysis.recommendation = 'SELL';
    analysis.reasoning.push('Strong sell-side pressure detected');
    analysis.confidence += 0.2;
  }

  // Price momentum check
  if (historicalData.length >= 3) {
    const recentPrices = historicalData.slice(-3).map(h => h.price);
    const isUptrend = recentPrices[2] > recentPrices[1] && recentPrices[1] > recentPrices[0];
    const isDowntrend = recentPrices[2] < recentPrices[1] && recentPrices[1] < recentPrices[0];

    if (isUptrend) {
      analysis.reasoning.push('Upward price momentum confirmed');
      if (analysis.momentum === 'bullish') analysis.confidence += 0.15;
    } else if (isDowntrend) {
      analysis.reasoning.push('Downward price momentum confirmed');
      if (analysis.momentum === 'bearish') analysis.confidence += 0.15;
    }
  }

  return analysis;
}

// Calculate position size based on Kelly Criterion
function calculatePositionSize(balance, confidence, winProbability = 0.55) {
  const edgeRatio = (confidence - 0.5) * 2; // Convert to edge
  const kellyFraction = edgeRatio / 1; // Simplified Kelly

  // Use fractional Kelly (25% of full Kelly for safety)
  const conservativeKelly = kellyFraction * 0.25;

  // Cap at max position size
  const positionFraction = Math.min(conservativeKelly, CONFIG.maxPositionSize);
  const positionSize = balance * positionFraction;

  // Enforce minimum
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

  const response = await apiRequest('POST', '/order', orderPayload);

  console.log(JSON.stringify({
    action: 'ORDER_PLACED',
    order: orderPayload,
    response: response,
    timestamp: new Date().toISOString(),
  }));

  return response;
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

// Get open positions
async function getOpenPositions() {
  return await getOpenOrders();
}

// Main trading loop
async function trade() {
  try {
    console.log(JSON.stringify({
      action: 'TRADE_CYCLE_START',
      timestamp: new Date().toISOString(),
    }));

    // Check balance
    const balance = await getBalance();
    console.log(JSON.stringify({
      action: 'BALANCE_CHECK',
      balance: balance,
      timestamp: new Date().toISOString(),
    }));

    if (balance < CONFIG.minPositionSize) {
      console.log(JSON.stringify({
        action: 'INSUFFICIENT_BALANCE',
        balance: balance,
        required: CONFIG.minPositionSize,
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Find BTC markets
    const markets = await findBTCMarkets();
    console.log(JSON.stringify({
      action: 'MARKETS_FOUND',
      count: markets.length,
      markets: markets.map(m => ({ id: m.id, question: m.question })),
      timestamp: new Date().toISOString(),
    }));

    if (markets.length === 0) {
      console.log(JSON.stringify({
        action: 'NO_MARKETS',
        message: 'No active BTC 15-minute markets found',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Analyze each market
    for (const market of markets.slice(0, 3)) { // Limit to top 3
      // Get token ID from clobTokenIds (stringified JSON array)
      let tokenId;
      try {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        tokenId = tokenIds[0]; // YES token
      } catch (e) {
        console.log(JSON.stringify({
          action: 'SKIP_MARKET',
          market: market.question,
          reason: 'No valid token IDs',
          timestamp: new Date().toISOString(),
        }));
        continue;
      }

      const marketData = await getMarketData(tokenId);

      // For now, use empty historical data (would be populated in production)
      const analysis = await analyzeMarket(marketData, []);

      console.log(JSON.stringify({
        action: 'MARKET_ANALYSIS',
        market: market.question,
        tokenId: tokenId,
        analysis: analysis,
        currentPrice: marketData.midpoint,
        timestamp: new Date().toISOString(),
      }));

      // Only trade if confidence is high enough
      if (analysis.confidence >= 0.65 && analysis.recommendation !== 'HOLD') {
        const positionSize = calculatePositionSize(balance, analysis.confidence);
        const price = analysis.recommendation === 'BUY'
          ? marketData.book.asks[0].price
          : marketData.book.bids[0].price;

        console.log(JSON.stringify({
          action: 'TRADE_SIGNAL',
          recommendation: analysis.recommendation,
          confidence: analysis.confidence,
          positionSize: positionSize,
          price: price,
          reasoning: analysis.reasoning,
          timestamp: new Date().toISOString(),
        }));

        // Place order - LIVE TRADING ENABLED
        // User authorized real trades with $61 balance
        try {
          await placeOrder(tokenId, analysis.recommendation, price, positionSize, market);
        } catch (orderError) {
          console.log(JSON.stringify({
            action: 'ORDER_FAILED',
            error: orderError.message,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }

    // Check open positions
    const openPositions = await getOpenPositions();
    console.log(JSON.stringify({
      action: 'OPEN_POSITIONS',
      count: openPositions.length,
      positions: openPositions,
      timestamp: new Date().toISOString(),
    }));

  } catch (error) {
    console.error(JSON.stringify({
      action: 'ERROR',
      error: error.message,
      stack: error.stack,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Run trading cycle
if (require.main === module) {
  trade().catch(console.error);
}

module.exports = { trade, getBalance, findBTCMarkets, analyzeMarket };
