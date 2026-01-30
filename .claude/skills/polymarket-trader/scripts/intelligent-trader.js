#!/usr/bin/env node

/**
 * Intelligent Polymarket Trading Bot
 * - Memory: Persistent trade history
 * - Reasoning: Reflects on P&L and adapts strategy
 * - Multiple data sources: BTC price, sentiment, volatility
 * - Bets on EVERY 15-minute BTC market
 */

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  startingBalance: 61.0,
  maxPositionSize: 0.15, // 15% per trade (~$9)
  minPositionSize: 5,
  scanInterval: 60000, // Scan every 60 seconds
  memoryFile: path.join(process.env.HOME, '.polymarket-trader', 'memory.json'),
  betOnEveryMarket: true, // NEW: Bet on EVERY 15-min BTC market
};

// Bot memory - persists between restarts
let MEMORY = {
  trades: [],
  totalProfit: 0,
  totalLoss: 0,
  winCount: 0,
  lossCount: 0,
  insights: [],
  lockedProfits: 0, // NEW: Profits that are locked/withdrawn
  activeBalance: 61.0, // NEW: Balance actively being traded
  profitTakeThreshold: 15, // NEW: Take profits every $15 gain
  strategyParams: {
    riskLevel: 0.15, // starts conservative, adapts based on performance
    momentumWeight: 0.5,
    meanReversionWeight: 0.5,
  },
  lastBTCPrices: [], // Track BTC price history
};

// Load memory from disk
function loadMemory() {
  try {
    if (fs.existsSync(CONFIG.memoryFile)) {
      MEMORY = JSON.parse(fs.readFileSync(CONFIG.memoryFile, 'utf8'));
      console.log(JSON.stringify({
        action: 'MEMORY_LOADED',
        trades: MEMORY.trades.length,
        netPL: MEMORY.totalProfit - MEMORY.totalLoss,
        winRate: MEMORY.trades.length > 0 ? (MEMORY.winCount / MEMORY.trades.length * 100).toFixed(1) + '%' : 'N/A',
        timestamp: new Date().toISOString(),
      }));
    }
  } catch (e) {
    console.error(JSON.stringify({
      action: 'MEMORY_LOAD_ERROR',
      error: e.message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Save memory to disk
function saveMemory() {
  try {
    const dir = path.dirname(CONFIG.memoryFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG.memoryFile, JSON.stringify(MEMORY, null, 2));
  } catch (e) {
    console.error(JSON.stringify({
      action: 'MEMORY_SAVE_ERROR',
      error: e.message,
      timestamp: new Date().toISOString(),
    }));
  }
}

// Get BTC price from multiple sources
async function getBTCPrice() {
  const sources = [
    { name: 'Coinbase', url: 'https://api.coinbase.com/v2/prices/BTC-USD/spot', parser: (data) => parseFloat(JSON.parse(data).data.amount) },
    { name: 'Binance', url: 'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT', parser: (data) => parseFloat(JSON.parse(data).price) },
  ];

  const prices = await Promise.all(sources.map(source =>
    new Promise((resolve) => {
      https.get(source.url, (res) => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            resolve({ source: source.name, price: source.parser(data) });
          } catch (e) {
            resolve({ source: source.name, price: null });
          }
        });
      }).on('error', () => resolve({ source: source.name, price: null }));
    })
  ));

  const validPrices = prices.filter(p => p.price !== null);
  if (validPrices.length === 0) return null;

  const avgPrice = validPrices.reduce((sum, p) => sum + p.price, 0) / validPrices.length;

  // Track price history for volatility calculation
  MEMORY.lastBTCPrices.push({ price: avgPrice, timestamp: Date.now() });
  if (MEMORY.lastBTCPrices.length > 100) MEMORY.lastBTCPrices.shift();

  return { price: avgPrice, sources: validPrices };
}

// Calculate BTC volatility from recent price history
function calculateVolatility() {
  if (MEMORY.lastBTCPrices.length < 10) return null;

  const prices = MEMORY.lastBTCPrices.map(p => p.price);
  const returns = [];
  for (let i = 1; i < prices.length; i++) {
    returns.push((prices[i] - prices[i-1]) / prices[i-1]);
  }

  const mean = returns.reduce((sum, r) => sum + r, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / returns.length;
  const volatility = Math.sqrt(variance) * Math.sqrt(60); // Annualized

  return volatility;
}

// Get Twitter/social sentiment (placeholder - would need API key)
async function getSocialSentiment() {
  // In production, would query Twitter API, Reddit, etc.
  // For now, return neutral
  return {
    score: 0.5, // 0 = bearish, 1 = bullish
    confidence: 0.3,
    source: 'placeholder',
  };
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

// Get BTC 15-minute markets
async function getBTC15MinMarkets() {
  const now = Math.floor(Date.now() / 1000);
  const markets = [];

  // Check next 16 time windows (4 hours) - start from -1 to include current window
  for (let i = -1; i < 16; i++) {
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
          // Don't fetch order book during scan - too slow
          // Will fetch when placing trade
          markets.push({
            question: market.question,
            yesTokenId: tokenIds[0],
            noTokenId: tokenIds[1],
            yesPrice: 0.5, // Default - will get real price before trading
            noPrice: 0.5,
            endDate: market.endDate,
            volume: parseFloat(market.volume24hr || 0),
            timestamp: timestamp,
          });
        }
      }
    } catch (e) {
      // Skip this market
    }
  }

  return markets;
}

// Intelligent market analysis with reasoning
function analyzeMarketWithReasoning(market, btcData, sentiment, volatility) {
  const now = new Date();
  const endDate = new Date(market.endDate);
  const minutesLeft = (endDate - now) / (1000 * 60);

  const yesPrice = market.yesPrice;
  const noPrice = market.noPrice;

  // Multi-factor analysis
  const factors = [];
  let confidence = 0.50;
  let recommendation = 'BUY';
  let tokenId = market.yesTokenId;
  let reasoning = [];

  // Factor 1: Mean reversion
  const meanReversionSignal = Math.abs(yesPrice - 0.5);
  if (yesPrice > 0.60) {
    factors.push({ name: 'mean_reversion', signal: -1, strength: yesPrice - 0.60 });
    reasoning.push(`YES overpriced at ${(yesPrice * 100).toFixed(1)}% → fade`);
  } else if (yesPrice < 0.40) {
    factors.push({ name: 'mean_reversion', signal: 1, strength: 0.40 - yesPrice });
    reasoning.push(`YES underpriced at ${(yesPrice * 100).toFixed(1)}% → buy`);
  }

  // Factor 2: Momentum from recent BTC price changes
  if (MEMORY.lastBTCPrices.length >= 5) {
    const recentPrices = MEMORY.lastBTCPrices.slice(-5);
    const priceChange = (recentPrices[4].price - recentPrices[0].price) / recentPrices[0].price;
    if (Math.abs(priceChange) > 0.001) {
      const momentumSignal = priceChange > 0 ? 1 : -1;
      factors.push({ name: 'momentum', signal: momentumSignal, strength: Math.abs(priceChange) * 100 });
      reasoning.push(`BTC ${priceChange > 0 ? 'rising' : 'falling'} ${(Math.abs(priceChange) * 100).toFixed(2)}% recently`);
    }
  }

  // Factor 3: Volatility
  if (volatility !== null) {
    if (volatility > 0.5) {
      reasoning.push(`High volatility (${(volatility * 100).toFixed(1)}%) → more uncertainty`);
      confidence += 0.05;
    } else {
      reasoning.push(`Low volatility (${(volatility * 100).toFixed(1)}%) → more predictable`);
    }
  }

  // Factor 4: Time decay
  if (minutesLeft < 5) {
    confidence += 0.15;
    reasoning.push(`CLOSING SOON (${minutesLeft.toFixed(1)}min) → high confidence`);
  } else if (minutesLeft < 10) {
    confidence += 0.08;
    reasoning.push(`Closing soon (${minutesLeft.toFixed(1)}min)`);
  }

  // Factor 5: Volume
  if (market.volume > 1000) {
    reasoning.push(`High volume ($${market.volume.toFixed(0)}) → liquid market`);
    confidence += 0.03;
  } else if (market.volume < 50) {
    reasoning.push(`Low volume ($${market.volume.toFixed(0)}) → thin market`);
    confidence -= 0.05;
  }

  // Weighted decision based on strategy params
  let weightedSignal = 0;
  for (const factor of factors) {
    if (factor.name === 'mean_reversion') {
      weightedSignal += factor.signal * factor.strength * MEMORY.strategyParams.meanReversionWeight;
    } else if (factor.name === 'momentum') {
      weightedSignal += factor.signal * factor.strength * MEMORY.strategyParams.momentumWeight;
    }
  }

  // Determine side
  if (weightedSignal > 0) {
    recommendation = 'BUY';
    tokenId = market.yesTokenId;
    confidence += Math.min(Math.abs(weightedSignal) * 0.1, 0.2);
  } else if (weightedSignal < 0) {
    recommendation = 'SELL';
    tokenId = market.noTokenId;
    confidence += Math.min(Math.abs(weightedSignal) * 0.1, 0.2);
  } else {
    // Default to slight UP bias if neutral
    if (yesPrice < 0.50) {
      recommendation = 'BUY';
      tokenId = market.yesTokenId;
    } else {
      recommendation = 'SELL';
      tokenId = market.noTokenId;
    }
  }

  confidence = Math.max(0.50, Math.min(confidence, 0.85));

  return {
    market,
    tokenId,
    btcPrice: btcData.price,
    minutesLeft,
    yesPrice,
    noPrice,
    confidence,
    recommendation,
    reasoning,
    factors,
    weightedSignal,
  };
}

// Take profits strategy - lock in gains while compounding
function takeProfits() {
  const netProfit = MEMORY.totalProfit - MEMORY.totalLoss;

  if (netProfit >= MEMORY.profitTakeThreshold) {
    // Lock in 50% of profits, compound the other 50%
    const profitToLock = netProfit * 0.5;
    MEMORY.lockedProfits += profitToLock;
    MEMORY.activeBalance = CONFIG.startingBalance + (netProfit - profitToLock);

    console.log(JSON.stringify({
      action: 'PROFIT_TAKING',
      netProfit: netProfit.toFixed(2),
      lockedAmount: profitToLock.toFixed(2),
      totalLocked: MEMORY.lockedProfits.toFixed(2),
      newActiveBalance: MEMORY.activeBalance.toFixed(2),
      strategy: '50% locked, 50% compounded',
      timestamp: new Date().toISOString(),
    }));

    // Reset threshold for next profit-taking event
    MEMORY.profitTakeThreshold += 15;
    saveMemory();
  }
}

// Place trade
async function placeTrade(analysis) {
  // Get real-time order book before trading
  const orderBookOutput = runPmarketCLI(`-o ${analysis.tokenId}`);
  let realPrice = analysis.yesPrice;

  if (orderBookOutput) {
    try {
      const bookData = JSON.parse(orderBookOutput);
      if (bookData.midpoint) {
        realPrice = parseFloat(bookData.midpoint);
      }
    } catch (e) {
      const priceMatch = orderBookOutput.match(/midpoint[:\s]+([\d.]+)/i);
      if (priceMatch) {
        realPrice = parseFloat(priceMatch[1]);
      }
    }
  }

  const balance = MEMORY.activeBalance || (CONFIG.startingBalance + MEMORY.totalProfit - MEMORY.totalLoss);
  const positionSize = Math.max(
    CONFIG.minPositionSize,
    Math.min(balance * CONFIG.maxPositionSize * MEMORY.strategyParams.riskLevel, CONFIG.minPositionSize * 2)
  );

  const isBuyingYes = analysis.tokenId === analysis.market.yesTokenId;
  const price = realPrice;

  console.log(JSON.stringify({
    action: 'PLACING_TRADE',
    market: analysis.market.question,
    tokenId: analysis.tokenId,
    side: 'BUY',
    outcome: isBuyingYes ? 'YES (UP)' : 'NO (DOWN)',
    price: price,
    size: positionSize,
    confidence: analysis.confidence,
    reasoning: analysis.reasoning,
    timestamp: new Date().toISOString(),
  }));

  const command = `-b ${analysis.tokenId} ${positionSize.toFixed(2)} ${price.toFixed(4)}`;

  console.log(JSON.stringify({
    action: 'EXECUTING_CLI_COMMAND',
    command: `pmarket-cli ${command}`,
    timestamp: new Date().toISOString(),
  }));

  const output = runPmarketCLI(command);

  if (output && output.includes('success')) {
    // Record trade in memory
    const trade = {
      id: Date.now(),
      market: analysis.market.question,
      tokenId: analysis.tokenId,
      side: isBuyingYes ? 'YES' : 'NO',
      price: price,
      size: positionSize,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      factors: analysis.factors,
      btcPriceAtEntry: analysis.btcPrice,
      timestamp: new Date().toISOString(),
      endDate: analysis.market.endDate,
      status: 'open',
    };

    MEMORY.trades.push(trade);
    saveMemory();

    console.log(JSON.stringify({
      action: 'TRADE_SUCCESS',
      tradeId: trade.id,
      output: output.substring(0, 200),
      timestamp: new Date().toISOString(),
    }));

    // Check if we should take profits
    takeProfits();
  } else {
    console.log(JSON.stringify({
      action: 'TRADE_FAILED',
      output: output || 'No output',
      timestamp: new Date().toISOString(),
    }));
  }
}

// Reflect on past trades and adapt strategy
function reflectOnPerformance() {
  const recentTrades = MEMORY.trades.slice(-20); // Last 20 trades
  if (recentTrades.length < 5) return;

  const wins = recentTrades.filter(t => t.outcome === 'win');
  const losses = recentTrades.filter(t => t.outcome === 'loss');
  const winRate = wins.length / recentTrades.length;

  const insights = [];

  // Analyze what's working
  if (winRate > 0.55) {
    insights.push(`Good performance (${(winRate * 100).toFixed(1)}% win rate) → increasing risk`);
    MEMORY.strategyParams.riskLevel = Math.min(MEMORY.strategyParams.riskLevel * 1.1, 0.20);
  } else if (winRate < 0.45) {
    insights.push(`Poor performance (${(winRate * 100).toFixed(1)}% win rate) → reducing risk`);
    MEMORY.strategyParams.riskLevel = Math.max(MEMORY.strategyParams.riskLevel * 0.9, 0.10);
  }

  // Analyze which factors work best
  const meanReversionWins = wins.filter(t => t.factors && t.factors.some(f => f.name === 'mean_reversion')).length;
  const momentumWins = wins.filter(t => t.factors && t.factors.some(f => f.name === 'momentum')).length;

  if (meanReversionWins > momentumWins * 1.5) {
    insights.push(`Mean reversion working better → increasing weight`);
    MEMORY.strategyParams.meanReversionWeight = Math.min(MEMORY.strategyParams.meanReversionWeight * 1.1, 0.8);
    MEMORY.strategyParams.momentumWeight = Math.max(MEMORY.strategyParams.momentumWeight * 0.9, 0.2);
  } else if (momentumWins > meanReversionWins * 1.5) {
    insights.push(`Momentum working better → increasing weight`);
    MEMORY.strategyParams.momentumWeight = Math.min(MEMORY.strategyParams.momentumWeight * 1.1, 0.8);
    MEMORY.strategyParams.meanReversionWeight = Math.max(MEMORY.strategyParams.meanReversionWeight * 0.9, 0.2);
  }

  if (insights.length > 0) {
    console.log(JSON.stringify({
      action: 'STRATEGY_REFLECTION',
      winRate: (winRate * 100).toFixed(1) + '%',
      insights: insights,
      newParams: MEMORY.strategyParams,
      timestamp: new Date().toISOString(),
    }));

    MEMORY.insights.push({
      timestamp: new Date().toISOString(),
      winRate,
      insights,
      params: { ...MEMORY.strategyParams },
    });

    saveMemory();
  }
}

// Main scan loop
async function scan() {
  try {
    console.log(JSON.stringify({
      action: 'SCAN_START',
      timestamp: new Date().toISOString(),
    }));

    // Get BTC price from multiple sources
    const btcData = await getBTCPrice();
    if (!btcData) {
      console.log(JSON.stringify({
        action: 'ERROR',
        message: 'Could not fetch BTC price',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    console.log(JSON.stringify({
      action: 'BTC_PRICE',
      price: btcData.price,
      sources: btcData.sources.map(s => s.source),
      timestamp: new Date().toISOString(),
    }));

    // Calculate volatility
    const volatility = calculateVolatility();

    // Get social sentiment
    const sentiment = await getSocialSentiment();

    // Get markets
    const markets = await getBTC15MinMarkets();

    console.log(JSON.stringify({
      action: 'MARKETS_FOUND',
      count: markets.length,
      volatility: volatility ? (volatility * 100).toFixed(2) + '%' : 'N/A',
      sentiment: sentiment.score,
      timestamp: new Date().toISOString(),
    }));

    // BET ON EVERY MARKET (new behavior)
    let tradesPlaced = 0;
    for (const market of markets) {
      // Skip if we already have a trade on this market
      const alreadyTraded = MEMORY.trades.some(t =>
        t.market === market.question && t.status === 'open'
      );

      if (alreadyTraded) {
        continue;
      }

      const analysis = analyzeMarketWithReasoning(market, btcData, sentiment, volatility);

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

      // ALWAYS place trade (if betOnEveryMarket is true)
      if (CONFIG.betOnEveryMarket) {
        try {
          await placeTrade(analysis);
          tradesPlaced++;
          // Small delay between trades
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

    // Reflect on performance every 10 trades
    if (MEMORY.trades.length % 10 === 0 && MEMORY.trades.length > 0) {
      reflectOnPerformance();
    }

    const balance = MEMORY.activeBalance || (CONFIG.startingBalance + MEMORY.totalProfit - MEMORY.totalLoss);
    const netPL = MEMORY.totalProfit - MEMORY.totalLoss;
    console.log(JSON.stringify({
      action: 'SCAN_COMPLETE',
      activeBalance: balance.toFixed(2),
      lockedProfits: MEMORY.lockedProfits.toFixed(2),
      totalValue: (balance + MEMORY.lockedProfits).toFixed(2),
      netPL: netPL.toFixed(2),
      tradesPlaced: tradesPlaced,
      totalTrades: MEMORY.trades.length,
      openPositions: MEMORY.trades.filter(t => t.status === 'open').length,
      winRate: MEMORY.trades.length > 0 ? ((MEMORY.winCount / MEMORY.trades.length) * 100).toFixed(1) + '%' : 'N/A',
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
  // Load memory from previous sessions
  loadMemory();

  console.log(JSON.stringify({
    action: 'BOT_START',
    config: {
      balance: CONFIG.startingBalance,
      scanInterval: CONFIG.scanInterval / 1000 + 's',
      tool: 'pmarket-cli',
      betOnEveryMarket: CONFIG.betOnEveryMarket,
      memory: {
        totalTrades: MEMORY.trades.length,
        netPL: MEMORY.totalProfit - MEMORY.totalLoss,
        winRate: MEMORY.trades.length > 0 ? ((MEMORY.winCount / MEMORY.trades.length) * 100).toFixed(1) + '%' : 'N/A',
      },
      strategyParams: MEMORY.strategyParams,
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
