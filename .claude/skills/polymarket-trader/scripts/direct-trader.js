#!/usr/bin/env node

/**
 * Direct Polymarket Trading Bot
 * Uses the CLOB API directly without pmarket-cli
 */

const https = require('https');
const crypto = require('crypto');
const { ethers } = require('ethers');

// Configuration from environment
const CONFIG = {
  apiKey: process.env.POLYMARKET_API_KEY,
  secret: process.env.POLYMARKET_SECRET,
  passphrase: process.env.POLYMARKET_PASSPHRASE,
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  signerAddress: process.env.POLYMARKET_SIGNER_ADDRESS,
  funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS,
  chainId: 137,
  startingBalance: 61.0,
  maxPositionSize: 0.15,
  minPositionSize: 5,
  confidenceThreshold: 0.50,
  scanInterval: 60000,
};

// EIP-712 Domain for Polymarket
const DOMAIN = {
  name: 'ClobAuthDomain',
  version: '1',
  chainId: CONFIG.chainId,
};

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

// Make authenticated API request
function apiRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const timestamp = Math.floor(Date.now() / 1000).toString();

    // Build message for HMAC
    let message = timestamp + method + path;
    if (body) {
      message += JSON.stringify(body);
    }

    // Generate HMAC signature (URL-safe base64)
    const hmac = crypto.createHmac('sha256', Buffer.from(CONFIG.secret, 'base64'));
    hmac.update(message);
    let signature = hmac.digest('base64');
    // Convert to URL-safe base64
    signature = signature.replace(/\+/g, '-').replace(/\//g, '_');

    const options = {
      hostname: 'clob.polymarket.com',
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'POLY_ADDRESS': CONFIG.funderAddress,
        'POLY_SIGNATURE': signature,
        'POLY_TIMESTAMP': timestamp,
        'POLY_API_KEY': CONFIG.apiKey,
        'POLY_PASSPHRASE': CONFIG.passphrase,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          resolve(data);
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

// Sign order with EIP-712
function signOrder(order) {
  const wallet = new ethers.Wallet(CONFIG.privateKey);

  const types = {
    Order: [
      { name: 'salt', type: 'uint256' },
      { name: 'maker', type: 'address' },
      { name: 'signer', type: 'address' },
      { name: 'taker', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
      { name: 'makerAmount', type: 'uint256' },
      { name: 'takerAmount', type: 'uint256' },
      { name: 'expiration', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'feeRateBps', type: 'uint256' },
      { name: 'side', type: 'uint8' },
      { name: 'signatureType', type: 'uint8' },
    ],
  };

  // ethers v5 uses _signTypedData
  return wallet._signTypedData(DOMAIN, types, order);
}

// Get BTC 15-minute markets
async function getBTC15MinMarkets() {
  const now = Math.floor(Date.now() / 1000);
  const markets = [];

  for (let i = 0; i < 16; i++) {
    const timestamp = Math.floor((now + i * 15 * 60) / 900) * 900;
    const slug = `btc-updown-15m-${timestamp}`;

    try {
      const marketData = await new Promise((resolve) => {
        https.get(`https://gamma-api.polymarket.com/markets?slug=${slug}`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              resolve(null);
            }
          });
        }).on('error', () => resolve(null));
      });

      if (Array.isArray(marketData) && marketData.length > 0) {
        const market = marketData[0];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');

        if (tokenIds[0]) {
          // Get order book
          const book = await apiRequest('GET', `/book?token_id=${tokenIds[0]}`);
          const midpoint = book && book.bids && book.asks && book.bids[0] && book.asks[0]
            ? (parseFloat(book.bids[0].price) + parseFloat(book.asks[0].price)) / 2
            : 0.5;

          markets.push({
            question: market.question,
            yesTokenId: tokenIds[0],
            noTokenId: tokenIds[1],
            yesPrice: midpoint,
            noPrice: 1 - midpoint,
            endDate: market.endDate,
            volume: parseFloat(market.volume24hr || 0),
          });
        }
      }
    } catch (e) {
      // Skip this market
    }
  }

  return markets;
}

// Analyze market
function analyzeMarket(market, currentBTCPrice) {
  const now = new Date();
  const endDate = new Date(market.endDate);
  const minutesLeft = (endDate - now) / (1000 * 60);

  const yesPrice = market.yesPrice;
  const noPrice = market.noPrice;

  let expectedProb = 0.50;
  let confidence = 0.51;
  let recommendation = 'BUY';
  let tokenId = market.yesTokenId;

  // Mean reversion strategy
  if (yesPrice > 0.60) {
    expectedProb = 0.50;
    confidence = 0.55 + (yesPrice - 0.60) * 0.5;
    recommendation = 'SELL';
    tokenId = market.noTokenId;
  } else if (yesPrice < 0.40) {
    expectedProb = 0.50;
    confidence = 0.55 + (0.40 - yesPrice) * 0.5;
    recommendation = 'BUY';
    tokenId = market.yesTokenId;
  } else {
    if (market.volume > 100) {
      if (yesPrice >= 0.50) {
        recommendation = 'BUY';
        tokenId = market.yesTokenId;
        confidence = 0.53;
      } else {
        recommendation = 'SELL';
        tokenId = market.noTokenId;
        confidence = 0.53;
      }
    } else {
      if (yesPrice < 0.50) {
        recommendation = 'BUY';
        tokenId = market.yesTokenId;
        confidence = 0.52;
      } else {
        recommendation = 'SELL';
        tokenId = market.noTokenId;
        confidence = 0.52;
      }
    }
  }

  // Time boost
  if (minutesLeft < 10) confidence = Math.min(confidence + 0.05, 0.75);
  if (minutesLeft < 5) confidence = Math.min(confidence + 0.10, 0.80);

  const edge = Math.abs(expectedProb - yesPrice);

  return {
    market,
    tokenId,
    currentBTCPrice,
    minutesLeft,
    yesPrice,
    noPrice,
    expectedProb,
    edge,
    confidence,
    recommendation,
    reasoning: [
      `BTC: $${currentBTCPrice.toFixed(2)}`,
      `Time: ${minutesLeft.toFixed(1)} min`,
      `YES (UP): ${(yesPrice * 100).toFixed(1)}%`,
      `NO (DOWN): ${(noPrice * 100).toFixed(1)}%`,
      `Expected: ${(expectedProb * 100).toFixed(1)}%`,
      `Edge: ${(edge * 100).toFixed(1)}%`,
      `Volume 24h: $${market.volume.toFixed(0)}`,
      minutesLeft < 5 ? 'CLOSING SOON' : '',
    ],
  };
}

// Place trade
async function placeTrade(analysis) {
  const positionSize = Math.max(
    CONFIG.minPositionSize,
    Math.min(CONFIG.startingBalance * CONFIG.maxPositionSize, CONFIG.minPositionSize * 2)
  );

  const isBuyingYes = analysis.tokenId === analysis.market.yesTokenId;
  const price = isBuyingYes ? analysis.yesPrice : analysis.noPrice;

  // Calculate shares (price * shares = USDC amount)
  const shares = positionSize / price;

  // Build order
  const order = {
    salt: Math.floor(Math.random() * 1000000000000).toString(),
    maker: CONFIG.funderAddress,
    signer: CONFIG.signerAddress,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId: analysis.tokenId,
    makerAmount: Math.floor(positionSize * 1e6).toString(), // USDC has 6 decimals
    takerAmount: Math.floor(shares * 1e6).toString(), // Shares also 6 decimals
    expiration: '0',
    nonce: '0',
    feeRateBps: '1000', // Fixed: was 0, now 1000
    side: 0, // BUY
    signatureType: 2, // POLY_GNOSIS_SAFE
  };

  console.log(JSON.stringify({
    action: 'PLACING_TRADE',
    market: analysis.market.question,
    tokenId: analysis.tokenId,
    side: 'BUY',
    outcome: isBuyingYes ? 'YES (UP)' : 'NO (DOWN)',
    price: price.toFixed(4),
    size: positionSize.toFixed(2),
    shares: shares.toFixed(2),
    timestamp: new Date().toISOString(),
  }));

  // Sign order
  const signature = await signOrder(order);
  order.signature = signature;

  // Submit order
  try {
    const result = await apiRequest('POST', '/order', order);

    console.log(JSON.stringify({
      action: 'TRADE_SUCCESS',
      orderId: result.orderID || result.id,
      result: result,
      timestamp: new Date().toISOString(),
    }));
  } catch (error) {
    console.log(JSON.stringify({
      action: 'TRADE_ERROR',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Main scan loop
async function scan() {
  try {
    console.log(JSON.stringify({
      action: 'SCAN_START',
      timestamp: new Date().toISOString(),
    }));

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

    const markets = await getBTC15MinMarkets();

    console.log(JSON.stringify({
      action: 'MARKETS_FOUND',
      count: markets.length,
      timestamp: new Date().toISOString(),
    }));

    for (const market of markets) {
      const analysis = analyzeMarket(market, btcPrice);

      console.log(JSON.stringify({
        action: 'MARKET_ANALYSIS',
        market: market.question,
        yesPrice: analysis.yesPrice,
        noPrice: analysis.noPrice,
        minutesLeft: analysis.minutesLeft,
        confidence: analysis.confidence,
        recommendation: analysis.recommendation,
        reasoning: analysis.reasoning,
        timestamp: new Date().toISOString(),
      }));

      if (analysis.confidence >= CONFIG.confidenceThreshold) {
        console.log(JSON.stringify({
          action: 'TRADE_SIGNAL',
          market: market.question,
          recommendation: analysis.recommendation,
          confidence: analysis.confidence,
          reasoning: analysis.reasoning,
          timestamp: new Date().toISOString(),
        }));

        try {
          await placeTrade(analysis);
          await new Promise(resolve => setTimeout(resolve, 2000));
        } catch (e) {
          console.log(JSON.stringify({
            action: 'TRADE_ERROR',
            error: e.message,
            timestamp: new Date().toISOString(),
          }));
        }
      }
    }

    console.log(JSON.stringify({
      action: 'SCAN_COMPLETE',
      timestamp: new Date().toISOString(),
    }));

  } catch (error) {
    console.error(JSON.stringify({
      action: 'SCAN_ERROR',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Start bot
async function start() {
  console.log(JSON.stringify({
    action: 'BOT_START',
    config: {
      balance: CONFIG.startingBalance,
      confidenceThreshold: CONFIG.confidenceThreshold,
      scanInterval: CONFIG.scanInterval / 1000 + 's',
      tool: 'direct-api',
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
