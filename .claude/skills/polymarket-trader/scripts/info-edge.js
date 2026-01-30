#!/usr/bin/env node

/**
 * Information Edge Detection
 * Monitors external data sources for arbitrage opportunities vs Polymarket prices
 */

const https = require('https');

// Information sources configuration
const INFO_SOURCES = {
  // Crypto price feeds (for BTC, ETH markets)
  crypto: {
    coinbase: 'https://api.coinbase.com/v2/prices/BTC-USD/spot',
    binance: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
  },

  // News APIs (for event-based markets)
  news: {
    // These would require API keys in production
    // newsapi: 'https://newsapi.org/v2/everything',
    // alphaVantage: 'https://www.alphavantage.co/query',
  },

  // Social sentiment (Twitter/X for sentiment analysis)
  social: {
    // Would integrate with Twitter API for real-time sentiment
  },

  // Sports scores (for sports betting markets)
  sports: {
    // Would integrate with sports data APIs
  },
};

// Fetch from external API
async function fetchExternal(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}

// Get current BTC price from multiple sources
async function getBTCPrice() {
  try {
    const [coinbase, binance] = await Promise.all([
      fetchExternal(INFO_SOURCES.crypto.coinbase),
      fetchExternal(INFO_SOURCES.crypto.binance),
    ]);

    const prices = [];

    if (coinbase?.data?.amount) {
      prices.push(parseFloat(coinbase.data.amount));
    }

    if (binance?.price) {
      prices.push(parseFloat(binance.price));
    }

    if (prices.length === 0) return null;

    // Return average of available sources
    const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;

    return {
      price: avgPrice,
      sources: prices.length,
      timestamp: new Date().toISOString(),
    };
  } catch (e) {
    return null;
  }
}

// Detect price-based arbitrage (for BTC price prediction markets)
async function detectPriceArbitrage(market, marketPrice) {
  const question = market.question.toLowerCase();

  // Check if this is a BTC price market
  if (!question.includes('bitcoin') && !question.includes('btc')) {
    return null;
  }

  // Extract price threshold from question
  const priceMatch = question.match(/\$?([\d,]+)/);
  if (!priceMatch) return null;

  const threshold = parseFloat(priceMatch[1].replace(/,/g, ''));

  // Get current BTC price
  const btcData = await getBTCPrice();
  if (!btcData) return null;

  const currentPrice = btcData.price;
  const timeToClose = new Date(market.endDate) - new Date();
  const hoursToClose = timeToClose / (1000 * 60 * 60);

  // Determine if question is "above" or "below"
  const isAbove = question.includes('above') || question.includes('over') ||
                  question.includes('higher') || question.includes('hit');
  const isBelow = question.includes('below') || question.includes('under') ||
                  question.includes('lower');

  if (!isAbove && !isBelow) return null;

  // Calculate expected probability based on current price vs threshold
  let expectedProb = 0.5; // Default

  if (isAbove) {
    // Market asks "will BTC go above $X?"
    if (currentPrice > threshold) {
      // Already above - very likely to stay above if closing soon
      expectedProb = hoursToClose < 1 ? 0.95 : 0.80;
    } else {
      // Below threshold - need to estimate probability of reaching it
      const gap = threshold - currentPrice;
      const gapPercent = gap / currentPrice;

      if (gapPercent > 0.10) {
        expectedProb = 0.20; // Large gap unlikely in short time
      } else if (gapPercent > 0.05) {
        expectedProb = 0.35;
      } else {
        expectedProb = 0.50;
      }
    }
  } else if (isBelow) {
    // Market asks "will BTC stay below $X?"
    if (currentPrice < threshold) {
      expectedProb = hoursToClose < 1 ? 0.95 : 0.80;
    } else {
      const gap = currentPrice - threshold;
      const gapPercent = gap / currentPrice;

      if (gapPercent > 0.10) {
        expectedProb = 0.20;
      } else if (gapPercent > 0.05) {
        expectedProb = 0.35;
      } else {
        expectedProb = 0.50;
      }
    }
  }

  // Compare expected probability with market price
  const priceDiff = Math.abs(expectedProb - marketPrice);

  if (priceDiff > 0.15) { // 15% mispricing
    return {
      type: 'PRICE_ARBITRAGE',
      market: market.question,
      currentBTCPrice: currentPrice,
      threshold: threshold,
      marketPrice: marketPrice,
      expectedProb: expectedProb,
      edge: priceDiff,
      recommendation: expectedProb > marketPrice ? 'BUY' : 'SELL',
      confidence: Math.min(0.7 + (priceDiff - 0.15) * 2, 0.90),
      reasoning: [
        `BTC currently at $${currentPrice.toFixed(0)}`,
        `Market threshold: $${threshold}`,
        `Market pricing: ${(marketPrice * 100).toFixed(1)}%`,
        `Expected probability: ${(expectedProb * 100).toFixed(1)}%`,
        `Mispricing: ${(priceDiff * 100).toFixed(1)}%`,
        `Closes in ${hoursToClose.toFixed(1)} hours`,
      ],
    };
  }

  return null;
}

// Check for time-based arbitrage (markets about to close)
function detectTimeArbitrage(market, marketPrice) {
  const now = new Date();
  const endDate = new Date(market.endDate);
  const minutesToClose = (endDate - now) / (1000 * 60);

  // If market closes in < 30 minutes and price isn't near 0 or 1
  if (minutesToClose < 30 && minutesToClose > 0) {
    const question = market.question.toLowerCase();

    // Try to determine outcome based on current state
    // This would integrate with real-time data sources

    // For demonstration: if market is clearly resolved but price isn't
    if (marketPrice < 0.90 && marketPrice > 0.10) {
      return {
        type: 'TIME_ARBITRAGE',
        market: market.question,
        minutesToClose: minutesToClose,
        marketPrice: marketPrice,
        reasoning: [
          `Market closes in ${minutesToClose.toFixed(1)} minutes`,
          `Price still at ${(marketPrice * 100).toFixed(1)}%`,
          `Potential resolution arbitrage`,
        ],
      };
    }
  }

  return null;
}

// Analyze market using external information
async function analyzeWithExternalInfo(market, marketData) {
  const analyses = [];

  const marketPrice = parseFloat(marketData.midpoint?.mid || 0.5);

  // Check for price-based arbitrage
  const priceArb = await detectPriceArbitrage(market, marketPrice);
  if (priceArb) {
    analyses.push(priceArb);
  }

  // Check for time-based arbitrage
  const timeArb = detectTimeArbitrage(market, marketPrice);
  if (timeArb) {
    analyses.push(timeArb);
  }

  // Return highest confidence opportunity
  if (analyses.length > 0) {
    return analyses.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0];
  }

  return null;
}

module.exports = {
  getBTCPrice,
  detectPriceArbitrage,
  detectTimeArbitrage,
  analyzeWithExternalInfo,
};

// Test if run directly
if (require.main === module) {
  getBTCPrice().then(data => {
    console.log(JSON.stringify({
      action: 'BTC_PRICE_TEST',
      data: data,
      timestamp: new Date().toISOString(),
    }, null, 2));
  });
}
