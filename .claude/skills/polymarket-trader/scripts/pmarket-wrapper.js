#!/usr/bin/env node

/**
 * Polymarket CLI Wrapper Bot
 * Automatically trades BTC 15-minute markets using pmarket-cli
 */

const { execSync } = require('child_process');
const https = require('https');

// Configuration
const CONFIG = {
  startingBalance: 61.0,
  maxPositionSize: 0.15, // 15% per trade (~$9)
  minPositionSize: 5,
  confidenceThreshold: 0.50,
  scanInterval: 60000, // Scan every 60 seconds
};

let totalProfit = 0;
let totalLoss = 0;

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

// Execute pmarket-cli command
function runPmarketCLI(args) {
  try {
    const output = execSync(`pmarket-cli ${args}`, {
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return output;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CLI_ERROR',
      command: args,
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
    return null;
  }
}

// Get BTC 15-minute markets using direct API
async function getBTC15MinMarkets() {
  console.log(JSON.stringify({
    action: 'FETCHING_MARKETS',
    timestamp: new Date().toISOString(),
  }));

  const now = Math.floor(Date.now() / 1000);
  const markets = [];

  // Check next 16 possible 15-minute windows
  for (let i = 0; i < 16; i++) {
    const timestamp = Math.floor((now + i * 15 * 60) / 900) * 900;
    const slug = `btc-updown-15m-${timestamp}`;

    try {
      const marketData = await new Promise((resolve, reject) => {
        const url = `https://gamma-api.polymarket.com/markets?slug=${slug}`;
        https.get(url, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json);
            } catch (e) {
              resolve(null);
            }
          });
        }).on('error', () => resolve(null));
      });

      if (Array.isArray(marketData) && marketData.length > 0) {
        const market = marketData[0];

        // Get token IDs
        let yesTokenId, noTokenId;
        try {
          const tokenIds = JSON.parse(market.clobTokenIds || '[]');
          yesTokenId = tokenIds[0];
          noTokenId = tokenIds[1];
        } catch (e) {
          continue;
        }

        if (!yesTokenId) continue;

        // Get current price using pmarket-cli
        const orderBookOutput = runPmarketCLI(`-o ${yesTokenId}`);
        let yesPrice = 0.5;

        if (orderBookOutput) {
          try {
            // Parse JSON output from pmarket-cli
            const bookData = JSON.parse(orderBookOutput);
            if (bookData.midpoint) {
              yesPrice = parseFloat(bookData.midpoint);
            }
          } catch (e) {
            // Try parsing text output
            const priceMatch = orderBookOutput.match(/midpoint[:\s]+([\d.]+)/i);
            if (priceMatch) {
              yesPrice = parseFloat(priceMatch[1]);
            }
          }
        }

        markets.push({
          question: market.question,
          yesTokenId: yesTokenId,
          noTokenId: noTokenId,
          yesPrice: yesPrice,
          noPrice: 1 - yesPrice,
          endDate: market.endDate,
          volume: parseFloat(market.volume24hr || 0),
        });
      }
    } catch (e) {
      // Skip this market
    }
  }

  return markets;
}

// Analyze market and generate signal
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

  // Fade extremes, mean reversion strategy
  if (yesPrice > 0.60) {
    expectedProb = 0.50;
    confidence = 0.55 + (yesPrice - 0.60) * 0.5;
    recommendation = 'SELL';
    tokenId = market.noTokenId; // Buy NO when YES is overpriced
  } else if (yesPrice < 0.40) {
    expectedProb = 0.50;
    confidence = 0.55 + (0.40 - yesPrice) * 0.5;
    recommendation = 'BUY';
    tokenId = market.yesTokenId; // Buy YES when YES is underpriced
  } else {
    // Near fair value - check volume
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

  // Boost confidence if close to expiry
  if (minutesLeft < 10) confidence = Math.min(confidence + 0.05, 0.75);
  if (minutesLeft < 5) confidence = Math.min(confidence + 0.10, 0.80);

  const edge = Math.abs(expectedProb - yesPrice);

  return {
    market: market,
    tokenId: tokenId,
    currentBTCPrice: currentBTCPrice,
    minutesLeft: minutesLeft,
    yesPrice: yesPrice,
    noPrice: noPrice,
    expectedProb: expectedProb,
    edge: edge,
    confidence: confidence,
    recommendation: recommendation,
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

// Place trade using pmarket-cli
async function placeTrade(analysis) {
  const balance = CONFIG.startingBalance + totalProfit - totalLoss;
  const positionSize = Math.max(
    CONFIG.minPositionSize,
    Math.min(balance * CONFIG.maxPositionSize, CONFIG.minPositionSize * 2)
  );

  // Determine which token and price to use
  const isBuyingYes = analysis.tokenId === analysis.market.yesTokenId;
  const price = isBuyingYes ? analysis.yesPrice : analysis.noPrice;

  console.log(JSON.stringify({
    action: 'PLACING_TRADE',
    market: analysis.market.question,
    tokenId: analysis.tokenId,
    side: 'BUY',
    outcome: isBuyingYes ? 'YES (UP)' : 'NO (DOWN)',
    price: price,
    size: positionSize,
    timestamp: new Date().toISOString(),
  }));

  // Always use BUY since we're buying shares (not selling short)
  // Buy: pmarket-cli -b <token_id> <amount_in_usdc> <price>
  const command = `-b ${analysis.tokenId} ${positionSize.toFixed(2)} ${price.toFixed(4)}`;

  console.log(JSON.stringify({
    action: 'EXECUTING_CLI_COMMAND',
    command: `pmarket-cli ${command}`,
    timestamp: new Date().toISOString(),
  }));

  const output = runPmarketCLI(command);

  if (output && !output.includes('error') && !output.includes('Error')) {
    console.log(JSON.stringify({
      action: 'TRADE_SUCCESS',
      output: output,
      timestamp: new Date().toISOString(),
    }));
  } else {
    console.log(JSON.stringify({
      action: 'TRADE_FAILED',
      output: output || 'No output',
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
        const balance = CONFIG.startingBalance + totalProfit - totalLoss;
        const positionSize = Math.max(
          CONFIG.minPositionSize,
          Math.min(balance * CONFIG.maxPositionSize, CONFIG.minPositionSize * 2)
        );

        console.log(JSON.stringify({
          action: 'TRADE_SIGNAL',
          market: market.question,
          recommendation: analysis.recommendation,
          confidence: analysis.confidence,
          size: positionSize,
          reasoning: analysis.reasoning,
          timestamp: new Date().toISOString(),
        }));

        try {
          await placeTrade(analysis);

          // Add small delay between trades
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
      balance: CONFIG.startingBalance + totalProfit - totalLoss,
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
      tool: 'pmarket-cli',
    },
    timestamp: new Date().toISOString(),
  }));

  // Run initial scan
  await scan();

  // Run on interval
  setInterval(scan, CONFIG.scanInterval);
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { scan, start };
