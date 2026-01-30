#!/usr/bin/env node

/**
 * BTC 15-Minute Markets Trader with EIP-712 Order Signing
 * Properly signs orders before submission
 */

const crypto = require('crypto');
const https = require('https');
const { ethers } = require('./node_modules/ethers');

// Configuration
const CONFIG = {
  apiKey: process.env.POLYMARKET_API_KEY,
  secret: process.env.POLYMARKET_SECRET,
  passphrase: process.env.POLYMARKET_PASSPHRASE,
  privateKey: process.env.POLYMARKET_PRIVATE_KEY,
  signerAddress: process.env.POLYMARKET_SIGNER_ADDRESS,
  funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS,
  address: process.env.POLYMARKET_ADDRESS,

  startingBalance: 61.0,
  maxPositionSize: 0.15, // 15% per trade (~$9)
  minPositionSize: 5,
  confidenceThreshold: 0.50, // Trade EVERY market!
  scanInterval: 60000, // Scan every 60 seconds

  host: 'clob.polymarket.com',
  gammaHost: 'gamma-api.polymarket.com',
  chainId: 137, // Polygon
  exchangeContract: '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
};

// Create wallet (signer)
const wallet = new ethers.Wallet('0x' + CONFIG.privateKey);
console.log(JSON.stringify({
  action: 'WALLET_CONFIG',
  signer: CONFIG.signerAddress,
  funder: CONFIG.funderAddress,
  signerDerived: wallet.address,
  timestamp: new Date().toISOString(),
}));

let totalProfit = 0;
let totalLoss = 0;
let orderNonce = Math.floor(Date.now() / 1000);

// EIP-712 Domain
const DOMAIN = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CONFIG.chainId,
  verifyingContract: CONFIG.exchangeContract,
};

// EIP-712 Order Type
const ORDER_TYPES = {
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
      'POLY_ADDRESS': CONFIG.funderAddress,
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

  let yesTokenId, noTokenId;
  try {
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    yesTokenId = tokenIds[0];
    noTokenId = tokenIds[1];
  } catch (e) {
    return null;
  }

  if (!yesTokenId) return null;

  const marketData = await getMarketData(yesTokenId);
  if (!marketData || !marketData.book) return null;

  const yesPrice = parseFloat(marketData.midpoint?.mid || 0.5);
  const noPrice = 1 - yesPrice;

  let expectedProb = 0.50;
  let confidence = 0.51;
  let recommendation = 'BUY';

  const volume = parseFloat(market.volume24hr || 0);

  // Fade extremes, mean reversion strategy
  if (yesPrice > 0.60) {
    expectedProb = 0.50;
    confidence = 0.55 + (yesPrice - 0.60) * 0.5;
    recommendation = 'SELL';
  } else if (yesPrice < 0.40) {
    expectedProb = 0.50;
    confidence = 0.55 + (0.40 - yesPrice) * 0.5;
    recommendation = 'BUY';
  } else {
    if (volume > 100) {
      if (yesPrice >= 0.50) {
        recommendation = 'BUY';
        confidence = 0.53;
      } else {
        recommendation = 'SELL';
        confidence = 0.53;
      }
    } else {
      if (yesPrice < 0.50) {
        recommendation = 'BUY';
        confidence = 0.52;
      } else {
        recommendation = 'SELL';
        confidence = 0.52;
      }
    }
  }

  // Boost confidence if close to expiry
  if (minutesLeft < 10) confidence = Math.min(confidence + 0.05, 0.75);
  if (minutesLeft < 5) confidence = Math.min(confidence + 0.10, 0.80);

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

// Sign order with EIP-712
async function signOrder(order) {
  try {
    const signature = await wallet._signTypedData(DOMAIN, ORDER_TYPES, order);
    return signature;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'SIGN_ERROR',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    throw error;
  }
}

// Place order
async function placeOrder(tokenId, side, price, size, market) {
  const now = Math.floor(Date.now() / 1000);
  const expiration = now + 86400; // 24 hours
  const salt = Math.floor(Math.random() * 1000000000);

  // Calculate maker and taker amounts
  // All amounts must be INTEGERS in smallest units for EIP-712
  // For BUY: we send USDC (takerAmount), receive tokens (makerAmount)
  // For SELL: we send tokens (makerAmount), receive USDC (takerAmount)
  const isBuy = side === 'BUY';

  // Token amount: whole tokens (no decimals)
  const tokenAmount = Math.floor(size);

  // USDC amount: in smallest USDC units (6 decimals)
  // Convert to integer: multiply by 1e6
  const usdcAmount = Math.floor(size * price * 1000000);

  const order = {
    salt: salt.toString(),
    maker: CONFIG.funderAddress,      // Gnosis Safe Proxy (where money is)
    signer: CONFIG.signerAddress,     // MetaMask account (who signs)
    taker: '0x0000000000000000000000000000000000000000', // Public order
    tokenId: tokenId,
    makerAmount: isBuy ? tokenAmount.toString() : usdcAmount.toString(),
    takerAmount: isBuy ? usdcAmount.toString() : tokenAmount.toString(),
    expiration: expiration.toString(),
    nonce: (orderNonce++).toString(),
    feeRateBps: '0', // 0 basis points fee
    side: isBuy ? 0 : 1, // 0 = BUY, 1 = SELL
    signatureType: 2, // 2 = PROXY WALLET (Gnosis Safe)
  };

  try {
    // Sign the order
    const signature = await signOrder(order);

    // Prepare the order payload with signature
    const orderPayload = {
      ...order,
      signature: signature,
    };

    console.log(JSON.stringify({
      action: 'ORDER_SIGNING',
      market: market.question,
      order: orderPayload,
      timestamp: new Date().toISOString(),
    }));

    // Submit the signed order
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

    const markets = await getCurrentBTC15MinMarkets();

    console.log(JSON.stringify({
      action: 'MARKETS_FOUND',
      count: markets.length,
      timestamp: new Date().toISOString(),
    }));

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
          await placeOrder(tokenId, analysis.recommendation, price, positionSize, market);
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
      funder: CONFIG.funderAddress,
      signer: CONFIG.signerAddress,
      balance: CONFIG.startingBalance,
      confidenceThreshold: CONFIG.confidenceThreshold,
      scanInterval: CONFIG.scanInterval / 1000 + 's',
      signatureType: 2,
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
