#!/usr/bin/env node

/**
 * BTC 15-Minute Markets Trader
 * Specifically targets the btc-updown-15m markets
 */

const crypto = require('crypto');
const https = require('https');

// Configuration
const CONFIG = {
  apiKey: process.env.POLYMARKET_API_KEY,
  secret: process.env.POLYMARKET_SECRET,
  passphrase: process.env.POLYMARKET_PASSPHRASE,
  address: process.env.POLYMARKET_ADDRESS,

  startingBalance: 61.0,
  maxPositionSize: 0.15, // 15% per trade (~$9)
  minPositionSize: 5,
  confidenceThreshold: 0.50, // Trade EVERY market!
  scanInterval: 60000, // Scan every 60 seconds (avoid rate limit)

  host: 'clob.polymarket.com',
  gammaHost: 'gamma-api.polymarket.com',
};

let totalProfit = 0;
let totalLoss = 0;

// HMAC signature
function signRequest(timestamp, method, path, body = '') {
  const message = timestamp + method + path + body;
  const hmac = crypto.createHmac('sha256', CONFIG.secret);
  return hmac.update(message).digest('base64');
}

// API request
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

    https.request({hostname: host, path, method, headers}, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { resolve(data); }
      });
    }).on('error', reject).end(bodyStr);
  });
}

// Get current BTC 15-min markets
async function getCurrentBTC15MinMarkets() {
  const now = Math.floor(Date.now() / 1000);
  const markets = [];

  // Check next 4 hours of 15-min windows
  for (let i = 0; i < 16; i++) {
    const timestamp = Math.floor((now + i * 15 * 60) / 900) * 900;
    const slug = `btc-updown-15m-${timestamp}`;

    try {
      const result = await apiRequest('GET', `/markets?slug=${slug}`, null, CONFIG.gammaHost);
      if (Array.isArray(result) && result.length > 0) {
        markets.push(result[0]);
      }
    } catch (e) {}
  }

  return markets;
}

// Get live BTC price
async function getBTCPrice() {
  return new Promise((resolve) => {
    https.get('https://api.coinbase.com/v2/prices/BTC-USD/spot', (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(parseFloat(json.data.amount));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// Get market data
async function getMarketData(tokenId) {
  try {
    const [book, midpoint] = await Promise.all([
      apiRequest('GET', `/book?token_id=${tokenId}`),
      apiRequest('GET', `/midpoint?token_id=${tokenId}`),
    ]);
    return { book, midpoint };
  } catch (e) {
    return null;
  }
}

// Analyze 15-min BTC market
async function analyze15MinMarket(market, currentBTCPrice) {
  const now = new Date();
  const endDate = new Date(market.endDate);
  const minutesLeft = (endDate - now) / (1000 * 60);

  // Get token IDs
  let yesTokenId, noTokenId;
  try {
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    yesTokenId = tokenIds[0];
    noTokenId = tokenIds[1];
  } catch (e) {
    console.log(JSON.stringify({action:'DEBUG',msg:'Token parse fail',market:market.question}));
    return null;
  }

  if (!yesTokenId) {
    console.log(JSON.stringify({action:'DEBUG',msg:'No token ID',market:market.question}));
    return null;
  }

  // Get market data
  const marketData = await getMarketData(yesTokenId);
  if (!marketData || !marketData.book) {
    console.log(JSON.stringify({action:'DEBUG',msg:'No market data',market:market.question,hasData:!!marketData}));
    return null;
  }

  const yesPrice = parseFloat(marketData.midpoint?.mid || 0.5);
  const noPrice = 1 - yesPrice;

  // These markets resolve based on UP or DOWN from START to END
  // YES = price goes UP (end >= start)
  // NO = price goes DOWN (end < start)

  // AGGRESSIVE: Trade EVERY market!
  // Strategy: 15-min BTC is ~50/50, so fade extremes and bet on reversion to mean

  let expectedProb = 0.50; // Default: 50/50 chance
  let confidence = 0.51; // Just above threshold to ensure we trade
  let recommendation = 'BUY'; // Default to buying YES

  const volume = parseFloat(market.volume24hr || 0);

  // If market is skewed, fade it (bet against the crowd)
  if (yesPrice > 0.60) {
    // Market thinks UP is likely, fade it
    expectedProb = 0.50;
    confidence = 0.55 + (yesPrice - 0.60) * 0.5; // More extreme = higher confidence
    recommendation = 'SELL'; // Sell YES / Buy NO
  } else if (yesPrice < 0.40) {
    // Market thinks DOWN is likely, fade it
    expectedProb = 0.50;
    confidence = 0.55 + (0.40 - yesPrice) * 0.5;
    recommendation = 'BUY'; // Buy YES
  } else {
    // Fairly priced around 50/50
    // Slight preference based on volume
    if (volume > 100) {
      // High volume, follow the trend
      if (yesPrice >= 0.50) {
        recommendation = 'BUY';
        confidence = 0.53;
      } else {
        recommendation = 'SELL';
        confidence = 0.53;
      }
    } else {
      // Low volume, pick the better value
      if (yesPrice < 0.50) {
        recommendation = 'BUY'; // Undervalued
        confidence = 0.52;
      } else {
        recommendation = 'SELL'; // Overvalued
        confidence = 0.52;
      }
    }
  }

  // Boost confidence if close to expiry (less time for price to move against us)
  if (minutesLeft < 10) {
    confidence = Math.min(confidence + 0.05, 0.75);
  }
  if (minutesLeft < 5) {
    confidence = Math.min(confidence + 0.10, 0.80);
  }

  const edge = Math.abs(expectedProb - yesPrice);

  return {
    market: market,
    yesTokenId: yesTokenId,
    noTokenId: noTokenId,
    currentBTCPrice: currentBTCPrice,
    minutesLeft: minutesLeft,
    yesPrice: yesPrice,
    noPrice: noPrice,
    expectedProb: expectedProb,
    edge: edge,
    confidence: confidence,
    recommendation: recommendation,
    volume: volume,
    reasoning: [
      `BTC: $${currentBTCPrice.toFixed(2)}`,
      `Time: ${minutesLeft.toFixed(1)} min`,
      `Market YES (UP): ${(yesPrice * 100).toFixed(1)}%`,
      `Expected: ${(expectedProb * 100).toFixed(1)}%`,
      `Edge: ${(edge * 100).toFixed(1)}%`,
      `Volume 24h: $${volume.toFixed(0)}`,
      minutesLeft < 5 ? 'CLOSING SOON' : '',
    ],
  };
}

// Place order
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

    console.log(JSON.stringify({
      action: 'ORDER_PLACED',
      market: market.question,
      order: orderPayload,
      response: response,
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

// Main scan
async function scan() {
  try {
    console.log(JSON.stringify({
      action: 'SCAN_START',
      timestamp: new Date().toISOString(),
    }));

    // Get BTC price
    const btcPrice = await getBTCPrice();
    if (!btcPrice) {
      console.log(JSON.stringify({
        action: 'ERROR',
        message: 'Could not fetch BTC price',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    console.log(JSON.stringify({
      action: 'BTC_PRICE',
      price: btcPrice,
      timestamp: new Date().toISOString(),
    }));

    // Get 15-min markets
    const markets = await getCurrentBTC15MinMarkets();

    console.log(JSON.stringify({
      action: 'MARKETS_FOUND',
      count: markets.length,
      timestamp: new Date().toISOString(),
    }));

    // Analyze each
    for (const market of markets) {
      const analysis = await analyze15MinMarket(market, btcPrice);

      if (!analysis) {
        console.log(JSON.stringify({
          action: 'ANALYSIS_FAILED',
          market: market.question,
          timestamp: new Date().toISOString(),
        }));
        continue;
      }

      console.log(JSON.stringify({
        action: 'MARKET_ANALYSIS',
        ...analysis,
        timestamp: new Date().toISOString(),
      }));

      // Trade if confident
      if (analysis.confidence >= CONFIG.confidenceThreshold && analysis.recommendation !== 'HOLD') {
        const balance = CONFIG.startingBalance + totalProfit - totalLoss;
        const positionSize = Math.min(balance * CONFIG.maxPositionSize, CONFIG.minPositionSize * 2);

        const tokenId = analysis.recommendation === 'BUY' ? analysis.yesTokenId : analysis.noTokenId;
        const price = analysis.recommendation === 'BUY' ? analysis.yesPrice : analysis.noPrice;

        console.log(JSON.stringify({
          action: 'TRADE_SIGNAL',
          market: market.question,
          recommendation: analysis.recommendation,
          confidence: analysis.confidence,
          price: price,
          size: positionSize,
          reasoning: analysis.reasoning,
          timestamp: new Date().toISOString(),
        }));

        try {
          await placeOrder(tokenId, 'BUY', price, positionSize, market);
        } catch (e) {
          console.log(JSON.stringify({
            action: 'TRADE_ERROR',
            error: e.message,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }

  } catch (error) {
    console.error(JSON.stringify({
      action: 'SCAN_ERROR',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Start monitoring
async function start() {
  console.log(JSON.stringify({
    action: 'BOT_START',
    config: {
      balance: CONFIG.startingBalance,
      confidenceThreshold: CONFIG.confidenceThreshold,
      scanInterval: CONFIG.scanInterval / 1000 + 's',
    },
    timestamp: new Date().toISOString(),
  }));

  await scan();
  setInterval(scan, CONFIG.scanInterval);
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { scan, start };
