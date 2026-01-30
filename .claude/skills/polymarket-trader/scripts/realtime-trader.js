#!/usr/bin/env node

/**
 * Real-Time Polymarket Trading Bot
 * Places bets WITHIN each 15-minute BTC window as price moves
 */

const { execSync } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const ethers = require('ethers');

// Learning system (graceful degradation)
let learningDB = null;
let learningEngine = null;
let DB = null;
try {
  learningDB = require('./learning-db');
  learningEngine = require('./learning-engine');
} catch (e) {
  console.warn('Learning system unavailable, continuing with memory.json only');
}

// Moonshot AI Supervisor (graceful degradation)
let moonshotSupervisor = null;
let externalDataFetcher = null;
try {
  moonshotSupervisor = require('./moonshot-supervisor');
  externalDataFetcher = require('./external-data-fetcher');
} catch (e) {
  console.warn('Moonshot supervisor unavailable, continuing without LLM oversight');
}

// Technical Indicators (RSI, Bollinger, EMA, Order Book)
let technicalIndicators = null;
try {
  technicalIndicators = require('./technical-indicators');
} catch (e) {
  console.warn('Technical indicators unavailable, continuing with basic momentum');
}

// Oracle Lag Sniper (HIGHEST ALPHA - Exploits Binance->Oracle delay)
let oracleLagSniper = null;
try {
  oracleLagSniper = require('./oracle-lag-sniper');
} catch (e) {
  console.warn('Oracle lag sniper unavailable, continuing without arbitrage edge');
}

// Hourly Strategy (EMA Trend Following for 1-hour windows)
let hourlyStrategy = null;
try {
  hourlyStrategy = require('./hourly-strategy');
} catch (e) {
  console.warn('Hourly strategy unavailable, continuing with 15-min only');
}

// Polygon USDC contract address
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)'
];

// Configuration
const CONFIG = {
  memoryFile: path.join(process.env.HOME, '.polymarket-trader', 'memory.json'),
  priceCheckInterval: 5000, // Check BTC price every 5 seconds
  maxBetsPerWindow: 3,      // Allow up to 3 adaptive bets
  maxTotalExposure: 0.20,   // Max 20% of balance per window
  initialBet: {
    timing: 60,             // 60 seconds after window opens
    positionSize: 0.08,     // 8% of active balance
    confidenceMin: 0.52,    // 52% minimum confidence (beats 51.5% breakeven with 3% fees)
  },
  followOnBet: {
    minTiming: 120,         // Wait at least 2min after initial bet
    positionSize: 0.08,     // 6-10% adaptive sizing
    confidenceMin: 0.65,    // 65% for follow-on (need strong conviction)
  },
  arbitrage: {
    minProfit: 0.15,        // Initial bet must be up ≥15% to consider hedging
    minSpread: 0.05,        // Total cost must be <0.95 for guaranteed profit
  },
  handoffBet: {
    positionSize: 0.08,     // 8% of balance (same as initial)
    confidenceMin: 0.52,    // 52% threshold (same as initial)
    maxExposure: 0.05,      // Max 5% total handoff exposure
  },
};

// Bot memory
let MEMORY = {
  trades: [],
  totalProfit: 0,
  totalLoss: 0,
  winCount: 0,
  lossCount: 0,
  lockedProfits: 0,
  activeBalance: 0, // Will be fetched live from Polymarket
  currentWindow: null,
  lastBetTime: 0,
  bet1Time: 0,        // Track Bet #1 timestamp
  bet2Time: 0,        // Track Bet #2 timestamp
  priceHistory: [],
  flashCrashDetected: false,
  lastFlashCrashTime: 0,
  handoffPlacedForWindow: {},  // Track handoff bets by window slug
  learnedConfig: null,          // Store learned parameter adjustments
  // Hourly strategy tracking
  hourlyTrades: [],
  lastHourlyBetWindow: null,    // Track which hourly window we last bet on
};

// Real-time price state
let CURRENT_PRICE = null;
let DAILY_CONTEXT = null;
let WS_BINANCE = null;
let WS_COINBASE = null;

// Get live USDC balance from Polygon blockchain
async function getLiveBalance() {
  try {
    // Load config
    const configPath = path.join(process.env.HOME, '.pmarket-cli', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    // Connect to Polygon
    const provider = new ethers.providers.JsonRpcProvider(config.rpcProvider);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, USDC_ABI, provider);

    // Get balance
    const balance = await usdcContract.balanceOf(config.funderAddress);
    const decimals = await usdcContract.decimals();

    // Convert from wei to USDC (6 decimals)
    const balanceInUSDC = parseFloat(ethers.utils.formatUnits(balance, decimals));

    console.log(JSON.stringify({
      action: 'BALANCE_FETCHED',
      balance: balanceInUSDC.toFixed(2),
      address: config.funderAddress,
      timestamp: new Date().toISOString(),
    }));

    return balanceInUSDC;
  } catch (e) {
    console.error(JSON.stringify({
      action: 'BALANCE_FETCH_ERROR',
      error: e.message,
      timestamp: new Date().toISOString(),
    }));
    return MEMORY.activeBalance || 61; // Fallback to memory
  }
}

// Load/save memory
function loadMemory() {
  try {
    if (fs.existsSync(CONFIG.memoryFile)) {
      MEMORY = { ...MEMORY, ...JSON.parse(fs.readFileSync(CONFIG.memoryFile, 'utf8')) };
      console.log(JSON.stringify({
        action: 'MEMORY_LOADED',
        trades: MEMORY.trades.length,
        netPL: MEMORY.totalProfit - MEMORY.totalLoss,
        timestamp: new Date().toISOString(),
      }));
    }
  } catch (e) {
    console.error(JSON.stringify({ action: 'MEMORY_ERROR', error: e.message }));
  }
}

function saveMemory() {
  try {
    const dir = path.dirname(CONFIG.memoryFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG.memoryFile, JSON.stringify(MEMORY, null, 2));
  } catch (e) {
    console.error(JSON.stringify({ action: 'SAVE_ERROR', error: e.message }));
  }
}

// Get CURRENT 15-minute window (the one we want to bet on)
function getCurrentWindow() {
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 900) * 900;
  const currentWindowEnd = currentWindowStart + 900;

  return {
    start: currentWindowStart,
    end: currentWindowEnd,
    slug: `btc-updown-15m-${currentWindowEnd}`,
    timeUntilStart: currentWindowStart - now, // Will be negative if window already started
    timeLeft: currentWindowEnd - now,
  };
}

// Get NEXT 15-minute window (for handoff bets)
function getNextWindow(currentWindow) {
  const nextWindowEnd = currentWindow.end + 900;
  return {
    start: currentWindow.end,
    end: nextWindowEnd,
    slug: `btc-updown-15m-${nextWindowEnd}`,
    timeUntilStart: currentWindow.end - Math.floor(Date.now() / 1000),
    timeLeft: nextWindowEnd - Math.floor(Date.now() / 1000),
  };
}

// ============================================================
// HOURLY WINDOW DETECTION
// ============================================================

// Get current hourly window (00:00, 01:00, 02:00, etc.)
function getCurrentHourlyWindow() {
  const now = Math.floor(Date.now() / 1000);

  // Round down to current hour
  const currentHourStart = Math.floor(now / 3600) * 3600;
  const currentHourEnd = currentHourStart + 3600; // 1 hour = 3600 seconds

  return {
    start: currentHourStart,
    end: currentHourEnd,
    slug: `btc-updown-1h-${currentHourEnd}`,
    timeUntilStart: currentHourStart - now,
    timeLeft: currentHourEnd - now,
  };
}

// Get next hourly window
function getNextHourlyWindow(currentWindow) {
  const nextWindowEnd = currentWindow.end + 3600;
  return {
    start: currentWindow.end,
    end: nextWindowEnd,
    slug: `btc-updown-1h-${nextWindowEnd}`,
    timeUntilStart: currentWindow.end - Math.floor(Date.now() / 1000),
    timeLeft: nextWindowEnd - Math.floor(Date.now() / 1000),
  };
}

// ============================================================
// HOURLY TRADING LOOP
// ============================================================

async function hourlyTradingLoop() {
  console.log(JSON.stringify({
    action: 'HOURLY_LOOP_START',
    strategy: 'EMA 9/21 Trend Following',
    maxBetSize: '$10',
  }));

  while (true) {
    try {
      const currentHourly = getCurrentHourlyWindow();

      // Only bet if:
      // 1. We haven't bet on this window yet
      // 2. We're within first 5 minutes of the window (give time to fetch data)
      if (MEMORY.lastHourlyBetWindow !== currentHourly.slug && currentHourly.timeLeft > 3300) {

        // Run EMA strategy
        const analysis = await hourlyStrategy.analyzeHourlyTrend();

        if (analysis.decision) {
          console.log(JSON.stringify({
            action: 'HOURLY_ANALYSIS',
            window: currentHourly.slug,
            decision: analysis.decision,
            confidence: (analysis.confidence * 100).toFixed(1) + '%',
            reasoning: analysis.reasoning,
            metadata: analysis.metadata,
          }));

          // Calculate bet size
          const betSize = hourlyStrategy.calculateHourlyBetSize(
            analysis.confidence,
            MEMORY.activeBalance
          );

          // Fetch hourly market from Polymarket
          // Note: Need to search for hourly markets (e.g., "Will BTC close higher this hour?")
          // For now, we'll log the decision and implement market fetching next

          console.log(JSON.stringify({
            action: 'HOURLY_BET_READY',
            window: currentHourly.slug,
            side: analysis.decision,
            betSize: betSize.toFixed(2),
            confidence: (analysis.confidence * 100).toFixed(1) + '%',
            timeLeft: formatTime(currentHourly.timeLeft),
          }));

          // TODO: Fetch hourly market and place bet
          // For now, mark window as processed
          MEMORY.lastHourlyBetWindow = currentHourly.slug;

          // Track in hourly trades
          MEMORY.hourlyTrades.push({
            window: currentHourly.slug,
            timestamp: Date.now(),
            side: analysis.decision,
            confidence: analysis.confidence,
            betSize: betSize,
            reasoning: analysis.reasoning,
            metadata: analysis.metadata,
            status: 'pending', // Will update when market found
          });

        } else {
          console.log(JSON.stringify({
            action: 'HOURLY_NO_DECISION',
            window: currentHourly.slug,
            reason: analysis.reason || 'Insufficient confidence',
          }));
        }
      }

      // Check every 5 minutes
      await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'HOURLY_LOOP_ERROR',
        error: error.message,
        stack: error.stack,
      }));

      // Wait 5 minutes on error
      await new Promise(resolve => setTimeout(resolve, 5 * 60 * 1000));
    }
  }
}

// Connect to Binance WebSocket for real-time BTC prices
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
      const price = parseFloat(ticker.c); // Current price

      // Update daily context
      DAILY_CONTEXT = {
        priceChange24h: parseFloat(ticker.p),
        priceChangePct24h: parseFloat(ticker.P) / 100,
        high24h: parseFloat(ticker.h),
        low24h: parseFloat(ticker.l),
        volume24h: parseFloat(ticker.v),
      };

      updatePrice(price, 'Binance');
    } catch (e) {
      // Ignore parse errors
    }
  });

  WS_BINANCE.on('error', (error) => {
    console.error(JSON.stringify({
      action: 'WEBSOCKET_ERROR',
      source: 'Binance',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
  });

  WS_BINANCE.on('close', () => {
    console.log(JSON.stringify({
      action: 'WEBSOCKET_CLOSED',
      source: 'Binance',
      timestamp: new Date().toISOString(),
    }));
    // Reconnect after 5 seconds
    setTimeout(connectBinanceWebSocket, 5000);
  });
}

// Connect to Coinbase WebSocket for redundancy
function connectCoinbaseWebSocket() {
  WS_COINBASE = new WebSocket('wss://ws-feed.exchange.coinbase.com');

  WS_COINBASE.on('open', () => {
    // Subscribe to BTC-USD ticker
    WS_COINBASE.send(JSON.stringify({
      type: 'subscribe',
      product_ids: ['BTC-USD'],
      channels: ['ticker']
    }));

    console.log(JSON.stringify({
      action: 'WEBSOCKET_CONNECTED',
      source: 'Coinbase',
      timestamp: new Date().toISOString(),
    }));
  });

  WS_COINBASE.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'ticker' && msg.price) {
        const price = parseFloat(msg.price);
        updatePrice(price, 'Coinbase');
      }
    } catch (e) {
      // Ignore parse errors
    }
  });

  WS_COINBASE.on('error', (error) => {
    console.error(JSON.stringify({
      action: 'WEBSOCKET_ERROR',
      source: 'Coinbase',
      error: error.message,
      timestamp: new Date().toISOString(),
    }));
  });

  WS_COINBASE.on('close', () => {
    console.log(JSON.stringify({
      action: 'WEBSOCKET_CLOSED',
      source: 'Coinbase',
      timestamp: new Date().toISOString(),
    }));
    // Reconnect after 5 seconds
    setTimeout(connectCoinbaseWebSocket, 5000);
  });
}

// Update price from streaming sources
function updatePrice(price, source) {
  CURRENT_PRICE = price;

  // Add to price history
  MEMORY.priceHistory.push({
    price: price,
    timestamp: Date.now(),
    dailyChange: DAILY_CONTEXT?.priceChangePct24h || 0,
    source: source,
  });

  // Keep last 1000 samples (at ~1-2s per sample = ~15-30 min of data)
  if (MEMORY.priceHistory.length > 1000) MEMORY.priceHistory.shift();

  // Feed to technical indicators
  if (technicalIndicators) {
    technicalIndicators.addPriceToHistory(price, Date.now());
  }

  // Flash crash detection
  detectFlashCrash();
}

// Detect flash crashes (>2% drop in <60 seconds)
function detectFlashCrash() {
  if (MEMORY.priceHistory.length < 30) return;

  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  // Get prices from last 60 seconds
  const recentPrices = MEMORY.priceHistory.filter(p => p.timestamp >= oneMinuteAgo);
  if (recentPrices.length < 10) return;

  // Find highest price in last 60 seconds
  const highPrice = Math.max(...recentPrices.map(p => p.price));
  const currentPrice = recentPrices[recentPrices.length - 1].price;

  const drop = (highPrice - currentPrice) / highPrice;

  // Flash crash detected: >2% drop in <60s
  if (drop > 0.02 && !MEMORY.flashCrashDetected) {
    MEMORY.flashCrashDetected = true;
    MEMORY.lastFlashCrashTime = now;

    console.log(JSON.stringify({
      action: 'FLASH_CRASH_DETECTED',
      dropPct: (drop * 100).toFixed(2) + '%',
      highPrice: highPrice.toFixed(2),
      currentPrice: currentPrice.toFixed(2),
      duration: Math.floor((now - recentPrices[0].timestamp) / 1000) + 's',
      timestamp: new Date().toISOString(),
    }));
  }

  // Reset flash crash flag after 5 minutes
  if (MEMORY.flashCrashDetected && (now - MEMORY.lastFlashCrashTime) > 300000) {
    MEMORY.flashCrashDetected = false;
  }
}

// Get current BTC price (from streaming WebSocket data)
function getBTCPrice() {
  if (!CURRENT_PRICE) return null;

  return {
    price: CURRENT_PRICE,
    sources: ['Binance', 'Coinbase'],
    context: DAILY_CONTEXT,
  };
}

// Calculate multi-timeframe momentum
function calculateMomentum() {
  if (MEMORY.priceHistory.length < 5) return { short: 0, medium: 0, hourly: 0, daily: 0 };

  // Short-term: Last 25 seconds (5 samples × 5s)
  const recent = MEMORY.priceHistory.slice(-5);
  const shortMomentum = (recent[4].price - recent[0].price) / recent[0].price;

  // Medium-term: Last 5 minutes (60 samples)
  const mediumSamples = Math.min(60, MEMORY.priceHistory.length);
  const medium = MEMORY.priceHistory.slice(-mediumSamples);
  const mediumMomentum = medium.length >= 10 ?
    (medium[medium.length - 1].price - medium[0].price) / medium[0].price : 0;

  // Hourly: Last hour (720 samples @ 5s = 1 hour)
  const hourlySamples = Math.min(720, MEMORY.priceHistory.length);
  const hourly = MEMORY.priceHistory.slice(-hourlySamples);
  const hourlyMomentum = hourly.length >= 100 ?
    (hourly[hourly.length - 1].price - hourly[0].price) / hourly[0].price : 0;

  // Daily: From context (24h change)
  const dailyMomentum = MEMORY.priceHistory.length > 0 ?
    (MEMORY.priceHistory[MEMORY.priceHistory.length - 1].dailyChange || 0) : 0;

  return {
    short: shortMomentum,      // Last 25 seconds
    medium: mediumMomentum,    // Last 5 minutes
    hourly: hourlyMomentum,    // Last hour
    daily: dailyMomentum,      // Last 24 hours
  };
}

// Execute pmarket-cli
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

// Get market for current window
async function getCurrentMarket(window) {
  return new Promise((resolve) => {
    https.get(`https://gamma-api.polymarket.com/markets?slug=${window.slug}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (Array.isArray(json) && json.length > 0) {
            const market = json[0];
            const tokenIds = JSON.parse(market.clobTokenIds || '[]');

            if (tokenIds[0]) {
              resolve({
                question: market.question,
                yesTokenId: tokenIds[0],
                noTokenId: tokenIds[1],
                endDate: market.endDate,
                volume: parseFloat(market.volume24hr || 0),
              });
              return;
            }
          }
          resolve(null);
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => resolve(null));
  });
}

// Get real-time price from order book (for display/analysis)
async function getRealTimePrice(tokenId) {
  const orderBookOutput = runPmarketCLI(`-o ${tokenId}`);

  if (orderBookOutput) {
    try {
      const bookData = JSON.parse(orderBookOutput);
      if (bookData.midpoint) {
        return parseFloat(bookData.midpoint);
      }
    } catch (e) {
      const priceMatch = orderBookOutput.match(/midpoint[:\s]+([\d.]+)/i);
      if (priceMatch) {
        return parseFloat(priceMatch[1]);
      }
    }
  }

  return 0.5;
}

// Get best execution price with dynamic pricing based on confidence
// Higher confidence = willing to pay more (higher expected value)
function getBestAskPrice(tokenId, confidence) {
  const orderBookOutput = runPmarketCLI(`-o ${tokenId}`);

  // Calculate max price we're willing to pay based on confidence
  // Formula: confidence - 0.03 (leave 3% edge for fees and profit)
  // Examples: 53% conf → $0.50 max, 70% conf → $0.67 max, 80% conf → $0.77 max
  const maxPrice = Math.min(0.99, confidence - 0.03);

  if (orderBookOutput) {
    try {
      const bookData = JSON.parse(orderBookOutput);
      // Get best ask (lowest price someone is selling at)
      if (bookData.asks && bookData.asks.length > 0) {
        const bestAsk = parseFloat(bookData.asks[0].price);

        // Use the LOWER of: (best ask + 1 tick) OR (our max based on confidence)
        // This ensures we get good prices when available, but pay up when confident
        const targetPrice = Math.min(bestAsk + 0.01, maxPrice);

        return Math.min(0.99, targetPrice);
      }
    } catch (e) {
      // Fallback to confidence-based price
    }
  }

  // Fallback: use conservative price based on confidence
  return Math.min(0.99, maxPrice);
}

// Get historical BTC price at specific timestamp using Binance Klines API
async function getBTCPriceAtTime(timestamp) {
  return new Promise((resolve) => {
    // Convert to milliseconds for Binance API
    const timestampMs = timestamp * 1000;

    // Request 1-minute candles around this timestamp
    const startTime = timestampMs - 60000;
    const url = `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&startTime=${startTime}&limit=2`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const klines = JSON.parse(data);
          if (Array.isArray(klines) && klines.length > 0) {
            // Find the kline that contains our timestamp
            for (const kline of klines) {
              const openTime = kline[0];
              const closeTime = kline[6];

              if (timestampMs >= openTime && timestampMs <= closeTime) {
                const closePrice = parseFloat(kline[4]); // Close price at index 4
                console.log(JSON.stringify({
                  action: 'HISTORICAL_PRICE_FETCHED',
                  timestamp: timestamp,
                  price: closePrice.toFixed(2),
                  source: 'Binance Klines',
                  timestampISO: new Date(timestamp * 1000).toISOString(),
                }));
                resolve(closePrice);
                return;
              }
            }

            // Fallback: use first kline's close price
            const closePrice = parseFloat(klines[0][4]);
            resolve(closePrice);
          } else {
            console.error(JSON.stringify({
              action: 'HISTORICAL_PRICE_ERROR',
              error: 'No klines returned',
              timestamp: timestamp,
            }));
            resolve(null);
          }
        } catch (e) {
          console.error(JSON.stringify({
            action: 'HISTORICAL_PRICE_ERROR',
            error: e.message,
            timestamp: timestamp,
          }));
          resolve(null);
        }
      });
    }).on('error', (error) => {
      console.error(JSON.stringify({
        action: 'HISTORICAL_PRICE_ERROR',
        error: error.message,
        timestamp: timestamp,
      }));
      resolve(null);
    });
  });
}

// Settle an individual trade by determining outcome and calculating P&L
async function settleTrade(trade) {
  // Handle legacy trades without window field
  if (!trade.window) {
    console.error(JSON.stringify({
      action: 'SETTLEMENT_SKIPPED',
      tradeId: trade.id,
      reason: 'legacy_trade_no_window_field',
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  // Extract window timestamps from slug
  // Slug format: btc-updown-15m-{endTimestamp}
  const endTimestamp = parseInt(trade.window.split('-').pop());
  const startTimestamp = endTimestamp - 900; // 15 minutes before

  // Fetch historical BTC prices at window start and end
  const startPrice = await getBTCPriceAtTime(startTimestamp);
  const endPrice = await getBTCPriceAtTime(endTimestamp);

  if (!startPrice || !endPrice) {
    console.error(JSON.stringify({
      action: 'SETTLEMENT_SKIPPED',
      tradeId: trade.id,
      reason: 'price_fetch_failed',
      window: trade.window,
      timestamp: new Date().toISOString(),
    }));
    return; // Skip this trade, will retry next cycle
  }

  // Determine outcome: if endPrice >= startPrice → UP (YES wins), else DOWN (NO wins)
  const priceChange = endPrice - startPrice;
  const priceChangePct = (priceChange / startPrice) * 100;
  const outcome = endPrice >= startPrice ? 'UP' : 'DOWN';

  // Determine if this trade won
  const won = (trade.side === 'YES' && outcome === 'UP') ||
               (trade.side === 'NO' && outcome === 'DOWN');

  // Calculate P&L
  let profitLoss = 0;
  if (won) {
    // Win: You get 1 USDC per share, minus what you paid
    // Profit = (1 - entryPrice) * positionSize
    profitLoss = (1 - trade.price) * trade.size;
  } else {
    // Loss: You lose what you paid
    // Loss = -entryPrice * positionSize
    profitLoss = -(trade.price * trade.size);
  }

  // Update trade record
  trade.status = won ? 'won' : 'lost';
  trade.settledAt = new Date().toISOString();
  trade.windowStartPrice = startPrice;
  trade.windowEndPrice = endPrice;
  trade.windowOutcome = outcome;
  trade.profitLoss = profitLoss;

  // Update MEMORY counters
  if (won) {
    MEMORY.totalProfit += profitLoss;
    MEMORY.winCount += 1;
  } else {
    MEMORY.totalLoss += Math.abs(profitLoss);
    MEMORY.lossCount += 1;
  }

  // Update database (non-blocking, graceful failure)
  if (DB && learningDB) {
    learningDB.updateTradeSettlement(DB, trade).catch(err => {
      console.warn(JSON.stringify({
        action: 'DB_UPDATE_FAILED',
        error: err.message,
        timestamp: new Date().toISOString(),
      }));
    });
  }

  console.log(JSON.stringify({
    action: 'TRADE_SETTLED',
    tradeId: trade.id,
    window: trade.window,
    side: trade.side,
    outcome: outcome,
    result: won ? 'WON' : 'LOST',
    btcPriceStart: startPrice.toFixed(2),
    btcPriceEnd: endPrice.toFixed(2),
    btcChange: priceChangePct.toFixed(3) + '%',
    profitLoss: profitLoss.toFixed(2),
    netPL: (MEMORY.totalProfit - MEMORY.totalLoss).toFixed(2),
    winRate: ((MEMORY.winCount / (MEMORY.winCount + MEMORY.lossCount)) * 100).toFixed(1) + '%',
    timestamp: new Date().toISOString(),
  }));
}

// Check all open trades and settle those whose windows have closed
async function settleCompletedWindows() {
  const now = Math.floor(Date.now() / 1000);

  // Find all trades with status 'open' whose endDate has passed
  const openTrades = MEMORY.trades.filter(t => t.status === 'open');
  const settleableTrades = openTrades.filter(t => {
    const endDate = new Date(t.endDate).getTime() / 1000;
    return now >= endDate + 60; // Wait 60 seconds after close for price to settle
  });

  if (settleableTrades.length === 0) {
    return; // Nothing to settle
  }

  console.log(JSON.stringify({
    action: 'SETTLEMENT_CHECK',
    settleableCount: settleableTrades.length,
    totalOpen: openTrades.length,
    timestamp: new Date().toISOString(),
  }));

  // Process each settleable trade
  for (const trade of settleableTrades) {
    try {
      await settleTrade(trade);
      await new Promise(resolve => setTimeout(resolve, 500)); // Rate limit: 500ms between requests
    } catch (e) {
      console.error(JSON.stringify({
        action: 'SETTLEMENT_ERROR',
        tradeId: trade.id,
        error: e.message,
        timestamp: new Date().toISOString(),
      }));
    }
  }

  // Save memory after all settlements
  saveMemory();
}

// Display unclaimed winnings summary for user awareness
function displayUnclaimedWinnings() {
  const wonTrades = MEMORY.trades.filter(t => t.status === 'won');

  if (wonTrades.length === 0) {
    return; // No wins yet, don't spam logs
  }

  // Calculate unclaimed winnings
  // Each winning share is worth $1, so total value = sum of all winning shares
  const unclaimedShares = wonTrades.reduce((sum, t) => sum + t.size, 0);
  const totalInvested = wonTrades.reduce((sum, t) => sum + (t.price * t.size), 0);
  const unclaimedValue = unclaimedShares - totalInvested; // Net profit from wins

  console.log(JSON.stringify({
    action: 'UNCLAIMED_WINNINGS',
    wonTradesCount: wonTrades.length,
    unclaimedShares: unclaimedShares.toFixed(2),
    totalInvested: totalInvested.toFixed(2),
    netUnclaimedProfit: unclaimedValue.toFixed(2),
    message: 'Claim winnings manually at https://polymarket.com/positions',
    timestamp: new Date().toISOString(),
  }));
}

// Settlement loop - runs in parallel with main trading loop
async function settlementLoop() {
  console.log(JSON.stringify({
    action: 'SETTLEMENT_LOOP_START',
    checkInterval: '45s',
    timestamp: new Date().toISOString(),
  }));

  while (true) {
    try {
      await settleCompletedWindows();

      // Check for profit-taking after settlements
      takeProfits();

      // Display unclaimed winnings summary
      displayUnclaimedWinnings();

      // Wait 45 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 45000));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'SETTLEMENT_LOOP_ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, 45000));
    }
  }
}

// Learning loop - analyze performance and adjust parameters
async function learningLoop(db) {
  console.log(JSON.stringify({
    action: 'LEARNING_LOOP_START',
    checkInterval: '30min',
    timestamp: new Date().toISOString(),
  }));

  const lastAnalysis = {
    '4hr': 0,
    '12hr': 0,
    '24hr': 0,
    'weekly': 0,
  };

  while (true) {
    try {
      const now = Date.now();

      // Check each analysis interval
      if (now - lastAnalysis['4hr'] >= 4 * 60 * 60 * 1000) {
        await learningEngine.runAnalysisCycle(db, CONFIG, '4hr');
        lastAnalysis['4hr'] = now;
      }

      if (now - lastAnalysis['12hr'] >= 12 * 60 * 60 * 1000) {
        await learningEngine.runAnalysisCycle(db, CONFIG, '12hr');
        lastAnalysis['12hr'] = now;
      }

      if (now - lastAnalysis['24hr'] >= 24 * 60 * 60 * 1000) {
        const adjustments = await learningEngine.runAnalysisCycle(db, CONFIG, '24hr');
        if (adjustments.length > 0) {
          await applyParameterAdjustments(db, adjustments);
        }
        lastAnalysis['24hr'] = now;
      }

      if (now - lastAnalysis['weekly'] >= 7 * 24 * 60 * 60 * 1000) {
        const adjustments = await learningEngine.runAnalysisCycle(db, CONFIG, 'weekly');
        if (adjustments.length > 0) {
          await applyParameterAdjustments(db, adjustments);
        }
        lastAnalysis['weekly'] = now;
      }

      // Check every 30 minutes
      await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'LEARNING_LOOP_ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));
      await new Promise(resolve => setTimeout(resolve, 30 * 60 * 1000));
    }
  }
}

// Supervisor helper: Calculate metrics for a set of trades
function calculateMetrics(trades) {
  if (trades.length === 0) {
    return {count: 0, settled: 0, wins: 0, losses: 0, winRate: 0, totalPL: 0, avgPL: 0};
  }

  const settled = trades.filter(t => t.status === 'won' || t.status === 'lost');
  const wins = settled.filter(t => t.status === 'won').length;
  const losses = settled.filter(t => t.status === 'lost').length;
  const totalPL = settled.reduce((sum, t) => sum + (t.profitLoss || 0), 0);

  return {
    count: trades.length,
    settled: settled.length,
    wins,
    losses,
    winRate: settled.length > 0 ? wins / settled.length : 0,
    totalPL,
    avgPL: settled.length > 0 ? totalPL / settled.length : 0
  };
}

// Supervisor loop - hourly strategic reviews
async function supervisorLoop(db) {
  if (!moonshotSupervisor) return;

  console.log(JSON.stringify({
    action: 'SUPERVISOR_LOOP_START',
    interval: '1hr',
    model: 'moonshot-v1-128k',
    timestamp: new Date().toISOString(),
  }));

  let lastHourlyReview = 0;

  while (true) {
    try {
      const now = Date.now();

      // Hourly strategic review
      if (now - lastHourlyReview >= 60 * 60 * 1000) {
        await conductStrategicReview(db);
        lastHourlyReview = now;
      }

      // Check every 10 minutes
      await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'SUPERVISOR_LOOP_ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));
      await new Promise(resolve => setTimeout(resolve, 10 * 60 * 1000));
    }
  }
}

// Conduct strategic review with Moonshot AI
async function conductStrategicReview(db) {
  if (!moonshotSupervisor || !externalDataFetcher) return;

  console.log(JSON.stringify({action: 'HOURLY_REVIEW_START'}));

  // Gather performance data
  const oneHourAgo = Date.now() - (60 * 60 * 1000);
  const sixHoursAgo = Date.now() - (6 * 60 * 60 * 1000);
  const oneDayAgo = Date.now() - (24 * 60 * 60 * 1000);

  const recentTrades = {
    last1hr: MEMORY.trades.filter(t => new Date(t.timestamp).getTime() >= oneHourAgo),
    last6hr: MEMORY.trades.filter(t => new Date(t.timestamp).getTime() >= sixHoursAgo),
    last24hr: MEMORY.trades.filter(t => new Date(t.timestamp).getTime() >= oneDayAgo),
  };

  // Calculate metrics
  const performance = {
    last1hr: calculateMetrics(recentTrades.last1hr),
    last6hr: calculateMetrics(recentTrades.last6hr),
    last24hr: calculateMetrics(recentTrades.last24hr),
    overall: {
      totalProfit: MEMORY.totalProfit,
      totalLoss: MEMORY.totalLoss,
      winRate: MEMORY.winCount / (MEMORY.winCount + MEMORY.lossCount),
      netProfit: MEMORY.totalProfit - MEMORY.totalLoss
    }
  };

  // Fetch external context
  const externalData = await externalDataFetcher.getMarketContext();

  // Get current BTC price data
  const btcData = await getBTCPrice();

  // Calculate current exposure
  const openTrades = MEMORY.trades.filter(t => t.status === 'open');
  const totalExposure = openTrades.reduce((sum, t) => sum + t.size, 0);
  const exposurePct = MEMORY.activeBalance > 0 ? totalExposure / MEMORY.activeBalance : 0;

  // Conduct LLM review
  const review = await moonshotSupervisor.conductHourlyReview({
    recentTrades,
    performance,
    marketContext: {
      btcPrice: btcData.price,
      volatility: btcData.context?.volatility || 'unknown',
      trend: btcData.context?.trend || 'unknown'
    },
    externalData,
    currentState: {
      balance: MEMORY.activeBalance,
      exposure: exposurePct,
      openPositions: openTrades.length,
      CONFIG: CONFIG
    }
  });

  // Log results
  console.log(JSON.stringify({
    action: 'HOURLY_REVIEW_COMPLETE',
    urgency: review.urgency,
    insights: review.insights,
    confidence: review.confidence,
    timestamp: new Date().toISOString()
  }));

  // Store in database
  if (db && learningDB) {
    await learningDB.insertSupervisorInsight(db, 'hourly', review);
  }

  // Note: Tactical adjustments would be applied here if urgency is high
  // For now, we just log them for review
  if (review.urgency === 'high' && review.tacticalAdjustments.length > 0) {
    console.log(JSON.stringify({
      action: 'URGENT_SUPERVISOR_RECOMMENDATION',
      adjustments: review.tacticalAdjustments,
      timestamp: new Date().toISOString()
    }));
  }
}

// Apply parameter adjustments from learning system
async function applyParameterAdjustments(db, adjustments) {
  // Supervisor validation (if available)
  if (moonshotSupervisor && externalDataFetcher && adjustments.length > 0) {
    try {
      console.log(JSON.stringify({
        action: 'SUPERVISOR_VALIDATION_START',
        adjustmentsCount: adjustments.length,
        timestamp: new Date().toISOString(),
      }));

      // Gather context for validation
      const last100Trades = MEMORY.trades.slice(-100);
      const analysisResults = await learningEngine.getAnalysisSnapshot(db);
      const externalData = await externalDataFetcher.getMarketContext();

      // Get supervisor decision
      const supervisorDecision = await moonshotSupervisor.validateAdjustments({
        adjustments,
        analysisResults,
        historicalTrades: last100Trades,
        currentState: {
          balance: MEMORY.activeBalance,
          netProfit: MEMORY.totalProfit - MEMORY.totalLoss,
          winRate: MEMORY.winCount / (MEMORY.winCount + MEMORY.lossCount),
          CONFIG
        },
        externalContext: externalData
      });

      if (!supervisorDecision.approved) {
        console.log(JSON.stringify({
          action: 'SUPERVISOR_REJECTED_ADJUSTMENTS',
          rationale: supervisorDecision.rationale,
          confidence: supervisorDecision.confidence,
          timestamp: new Date().toISOString(),
        }));

        // Log decision to database
        if (learningDB) {
          await learningDB.insertSupervisorDecision(db, {
            decisionType: 'reject',
            ...supervisorDecision,
            externalContext: externalData
          });
        }

        return; // Don't apply any adjustments
      }

      // Apply modifications if suggested
      if (supervisorDecision.modifications && supervisorDecision.modifications.length > 0) {
        console.log(JSON.stringify({
          action: 'SUPERVISOR_MODIFIED_ADJUSTMENTS',
          originalCount: adjustments.length,
          modifiedCount: supervisorDecision.modifications.length,
          timestamp: new Date().toISOString(),
        }));

        // Replace adjustments with supervisor's modifications
        adjustments = supervisorDecision.modifications.map(mod => ({
          path: mod.parameter,
          oldValue: getConfigValue(mod.parameter),
          newValue: mod.suggested_value,
          reason: `[LLM Modified] ${mod.reason}`,
          metrics: {supervised: true}
        }));
      }

      // Log supervisor approval
      console.log(JSON.stringify({
        action: 'SUPERVISOR_APPROVED_ADJUSTMENTS',
        rationale: supervisorDecision.rationale,
        confidence: supervisorDecision.confidence,
        additionalRecommendations: supervisorDecision.additionalRecommendations,
        timestamp: new Date().toISOString(),
      }));

      // Log decision to database
      if (learningDB) {
        await learningDB.insertSupervisorDecision(db, {
          decisionType: supervisorDecision.modifications.length > 0 ? 'modify' : 'approve',
          ...supervisorDecision,
          externalContext: externalData
        });
      }

    } catch (error) {
      console.warn(JSON.stringify({
        action: 'SUPERVISOR_VALIDATION_ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));
      // Continue with original adjustments if supervisor fails
    }
  }

  // Apply adjustments (original or supervisor-modified)
  for (const adj of adjustments) {
    try {
      // Parse path (e.g., "initialBet.confidenceMin")
      const parts = adj.path.split('.');
      let target = CONFIG;
      for (let i = 0; i < parts.length - 1; i++) {
        target = target[parts[i]];
      }
      const key = parts[parts.length - 1];

      // Apply adjustment
      target[key] = adj.newValue;

      // Log
      console.log(JSON.stringify({
        action: 'PARAMETER_ADJUSTED',
        parameter: adj.path,
        oldValue: adj.oldValue.toFixed(4),
        newValue: adj.newValue.toFixed(4),
        reason: adj.reason,
        metrics: adj.metrics,
        timestamp: new Date().toISOString(),
      }));

      // Store in database
      if (learningDB) {
        await learningDB.insertAdjustment(db, adj.path, adj.oldValue, adj.newValue, adj.reason, adj.metrics);
      }

      // Update learned config in memory
      if (!MEMORY.learnedConfig) MEMORY.learnedConfig = {};
      MEMORY.learnedConfig[adj.path] = adj.newValue;
      saveMemory();

    } catch (e) {
      console.error(JSON.stringify({
        action: 'ADJUSTMENT_FAILED',
        path: adj.path,
        error: e.message,
        timestamp: new Date().toISOString(),
      }));
    }
  }
}

// Helper function to get config value by path
function getConfigValue(path) {
  const parts = path.split('.');
  let value = CONFIG;
  for (const part of parts) {
    value = value[part];
  }
  return value;
}

// Analyze and decide trade (multi-timeframe)
function analyzeTrade(btcPrice, yesPrice, momentum, timeLeft, orderBookOutput = null) {
  const reasoning = [];
  let confidence = 0.52; // AGGRESSIVE: Start at threshold (was 0.50)
  let side = 'YES';

  // Get technical indicators analysis (RSI, Bollinger, EMA, Order Book)
  let techAnalysis = null;
  if (technicalIndicators) {
    techAnalysis = technicalIndicators.analyzeTechnicalIndicators(orderBookOutput);
  }

  // Multi-timeframe momentum weighting
  // Short-term (25s): 20% weight
  // Medium-term (5min): 30% weight
  // Hourly: 30% weight
  // Daily: 20% weight
  const compositeMomentum =
    (momentum.short * 0.20) +
    (momentum.medium * 0.30) +
    (momentum.hourly * 0.30) +
    (momentum.daily * 0.20);

  // AGGRESSIVE: Detect ANY momentum (lowered from 0.003 to 0.0018)
  if (Math.abs(compositeMomentum) > 0.0018) {
    if (compositeMomentum > 0) {
      reasoning.push(`Multi-TF momentum +${(compositeMomentum * 100).toFixed(2)}% → UP bias`);
      side = 'YES';
      confidence += 0.15; // AGGRESSIVE: Increased from 0.12

      // Extra confidence if all timeframes agree
      if (momentum.short > 0 && momentum.medium > 0 && momentum.hourly > 0) {
        reasoning.push(`All timeframes bullish → high conviction`);
        confidence += 0.10; // AGGRESSIVE: Increased from 0.08
      }
    } else {
      reasoning.push(`Multi-TF momentum ${(compositeMomentum * 100).toFixed(2)}% → DOWN bias`);
      side = 'NO';
      confidence += 0.15; // AGGRESSIVE: Increased from 0.12

      // Extra confidence if all timeframes agree
      if (momentum.short < 0 && momentum.medium < 0 && momentum.hourly < 0) {
        reasoning.push(`All timeframes bearish → high conviction`);
        confidence += 0.10; // AGGRESSIVE: Increased from 0.08
      }
    }
  }

  // AGGRESSIVE: Detect weak momentum signals
  else if (Math.abs(compositeMomentum) > 0.001) {
    if (compositeMomentum > 0) {
      reasoning.push(`Weak upward momentum detected`);
      side = 'YES';
      confidence += 0.08;
    } else {
      reasoning.push(`Weak downward momentum detected`);
      side = 'NO';
      confidence += 0.08;
    }
  }

  // Daily context (trend bias)
  if (Math.abs(momentum.daily) > 0.02) {
    if (momentum.daily > 0) {
      reasoning.push(`BTC +${(momentum.daily * 100).toFixed(1)}% today → bullish context`);
      if (side === 'YES') confidence += 0.08; // AGGRESSIVE: Increased from 0.05
    } else {
      reasoning.push(`BTC ${(momentum.daily * 100).toFixed(1)}% today → bearish context`);
      if (side === 'NO') confidence += 0.08; // AGGRESSIVE: Increased from 0.05
    }
  }

  // Mean reversion (stronger signal)
  if (yesPrice > 0.65) {
    reasoning.push(`YES overpriced at ${(yesPrice * 100).toFixed(1)}% → fade to NO`);
    side = 'NO';
    confidence += 0.10;
  } else if (yesPrice < 0.35) {
    reasoning.push(`YES underpriced at ${(yesPrice * 100).toFixed(1)}% → buy YES`);
    side = 'YES';
    confidence += 0.10;
  }

  // Medium mean reversion
  if (yesPrice > 0.55 && yesPrice <= 0.65) {
    reasoning.push(`YES slightly high at ${(yesPrice * 100).toFixed(1)}%`);
    if (side === 'NO') confidence += 0.08; // AGGRESSIVE: Increased from 0.05
  } else if (yesPrice < 0.45 && yesPrice >= 0.35) {
    reasoning.push(`YES slightly low at ${(yesPrice * 100).toFixed(1)}%`);
    if (side === 'YES') confidence += 0.08; // AGGRESSIVE: Increased from 0.05
  }

  // Time pressure
  if (timeLeft < 300) {
    reasoning.push(`Only ${Math.floor(timeLeft / 60)}min left → urgency`);
    confidence += 0.12; // AGGRESSIVE: Increased from 0.10
  } else if (timeLeft < 600) {
    reasoning.push(`${Math.floor(timeLeft / 60)}min left`);
    confidence += 0.06; // AGGRESSIVE: Increased from 0.03
  }

  // ============================================================
  // TECHNICAL INDICATORS (Advanced ML signals)
  // ============================================================
  if (techAnalysis && techAnalysis.consensus !== 'neutral') {
    const techConf = parseFloat(techAnalysis.consensusConfidence) || 0;

    if (techAnalysis.consensus === 'bullish') {
      reasoning.push(`📊 Tech indicators BULLISH (RSI:${techAnalysis.rsi}, BB:${techAnalysis.bollingerPercentB})`);

      // If tech aligns with our side, boost confidence
      if (side === 'YES') {
        confidence += techConf * 0.8; // Strong reinforcement
        reasoning.push(`✅ Tech confirms UP bias → high conviction`);
      }
      // If tech conflicts, consider switching or lowering confidence
      else {
        // Tech says bullish but we're bearish - conflict!
        if (techConf > 0.65) {
          reasoning.push(`⚠️ Tech disagrees strongly → switching to YES`);
          side = 'YES';
          confidence = Math.max(confidence, 0.52 + techConf * 0.6);
        }
      }
    }
    else if (techAnalysis.consensus === 'bearish') {
      reasoning.push(`📊 Tech indicators BEARISH (RSI:${techAnalysis.rsi}, BB:${techAnalysis.bollingerPercentB})`);

      // If tech aligns with our side, boost confidence
      if (side === 'NO') {
        confidence += techConf * 0.8; // Strong reinforcement
        reasoning.push(`✅ Tech confirms DOWN bias → high conviction`);
      }
      // If tech conflicts, consider switching or lowering confidence
      else {
        // Tech says bearish but we're bullish - conflict!
        if (techConf > 0.65) {
          reasoning.push(`⚠️ Tech disagrees strongly → switching to NO`);
          side = 'NO';
          confidence = Math.max(confidence, 0.52 + techConf * 0.6);
        }
      }
    }

    // Check for asymmetric opportunities from individual indicators
    for (const signal of techAnalysis.signals || []) {
      const sigConf = parseFloat(signal.confidence) || 0;

      // RSI extreme oversold/overbought = high conviction reversal
      if (signal.indicator === 'RSI' && sigConf > 0.75) {
        if (signal.signal === 'extreme_oversold' && side === 'YES') {
          reasoning.push(`🎯 RSI EXTREME OVERSOLD → asymmetric BUY opportunity`);
          confidence += 0.12;
        } else if (signal.signal === 'extreme_overbought' && side === 'NO') {
          reasoning.push(`🎯 RSI EXTREME OVERBOUGHT → asymmetric SELL opportunity`);
          confidence += 0.12;
        }
      }

      // Bollinger Band extremes = mean reversion opportunity
      if (signal.indicator === 'Bollinger' && sigConf > 0.75) {
        if (signal.signal === 'extreme_oversold' && side === 'YES') {
          reasoning.push(`🎯 BB EXTREME LOW → sniper BUY`);
          confidence += 0.10;
        } else if (signal.signal === 'extreme_overbought' && side === 'NO') {
          reasoning.push(`🎯 BB EXTREME HIGH → sniper SELL`);
          confidence += 0.10;
        }
      }

      // Order book imbalance = asymmetric edge
      if (signal.indicator === 'OrderBook' && sigConf > 0.60) {
        if (signal.signal.includes('buying_pressure') && side === 'YES') {
          reasoning.push(`📈 Order book buying pressure → front-run momentum`);
          confidence += 0.08;
        } else if (signal.signal.includes('selling_pressure') && side === 'NO') {
          reasoning.push(`📉 Order book selling pressure → front-run momentum`);
          confidence += 0.08;
        }
      }

      // CVD DIVERGENCE = TRAP DETECTION (Gemini's recommendation!)
      // Bear Trap: Price down + CVD up = Absorption/buying → BUY
      // Bull Trap: Price up + CVD down = Distribution/selling → SELL
      if (signal.indicator === 'CVD' && sigConf > 0.60) {
        if (signal.details && signal.details.includes('bear_trap')) {
          // Price looks weak but smart money is buying
          reasoning.push(`🐻 BEAR TRAP DETECTED: ${signal.details}`);
          if (side === 'YES') {
            confidence += sigConf * 0.9; // Very strong signal for reversals
            reasoning.push(`✨ CVD says institutions are absorbing → HIGH CONVICTION`);
          } else {
            // CVD disagrees with bearish bias - switch!
            side = 'YES';
            confidence = 0.52 + sigConf * 0.7;
            reasoning.push(`🔄 Switching to YES - bear trap detected`);
          }
        } else if (signal.details && signal.details.includes('bull_trap')) {
          // Price looks strong but smart money is selling
          reasoning.push(`🐂 BULL TRAP DETECTED: ${signal.details}`);
          if (side === 'NO') {
            confidence += sigConf * 0.9; // Very strong signal for reversals
            reasoning.push(`✨ CVD says institutions are distributing → HIGH CONVICTION`);
          } else {
            // CVD disagrees with bullish bias - switch!
            side = 'NO';
            confidence = 0.52 + sigConf * 0.7;
            reasoning.push(`🔄 Switching to NO - bull trap detected`);
          }
        }
      }
    }
  }

  // Default to composite momentum if no strong signal
  if (reasoning.length === 0) {
    if (compositeMomentum >= 0) {
      side = 'YES';
      reasoning.push('Slight upward bias from momentum');
    } else {
      side = 'NO';
      reasoning.push('Slight downward bias from momentum');
    }
    confidence = 0.53; // AGGRESSIVE: Increased from 0.51
  }

  return { side, confidence, reasoning, technicalAnalysis: techAnalysis };
}

// Check for arbitrage hedge opportunity
async function checkArbitrageHedge(previousBets, market) {
  if (!previousBets || previousBets.length === 0) return null;

  // Check most recent bet for arbitrage
  const lastBet = previousBets[previousBets.length - 1];

  try {
    const currentPrice = await getRealTimePrice(lastBet.tokenId);
    const priceDelta = currentPrice - lastBet.price;
    const profitPct = priceDelta / lastBet.price;

    // Only hedge if we're profitable ≥15%
    if (profitPct < CONFIG.arbitrage.minProfit) return null;

    // Get opposite side price
    const oppositeSide = lastBet.side === 'YES' ? 'NO' : 'YES';
    const oppositeTokenId = lastBet.side === 'YES' ? market.noTokenId : market.yesTokenId;
    const oppositePrice = await getRealTimePrice(oppositeTokenId);

    // Check if arbitrage exists: initialPrice + oppositePrice < 0.95
    const totalCost = lastBet.price + oppositePrice;

    if (totalCost < (1.0 - CONFIG.arbitrage.minSpread)) {
      const guaranteedProfit = ((1.0 - totalCost) / totalCost) * 100;

      return {
        trigger: 'arbitrage_hedge',
        confidence: 0.99, // Guaranteed profit!
        side: oppositeSide,
        positionSize: CONFIG.followOnBet.positionSize, // Match bet size
        reasoning: [
          `🔒 ARBITRAGE: ${lastBet.side}@${lastBet.price.toFixed(2)} + ${oppositeSide}@${oppositePrice.toFixed(2)} = ${totalCost.toFixed(2)}`,
          `Guaranteed profit: ${guaranteedProfit.toFixed(1)}% locked 🎯`
        ],
      };
    }
  } catch (e) {
    // Continue to other triggers
  }

  return null;
}

// Check if we should place a follow-on bet (adaptive conviction-based)
async function shouldPlaceFollowOn(window, previousBets, market, btcPrice, betNumber) {
  const momentum = calculateMomentum();

  // Get what sides we've already bet in this window
  const betSides = new Set(previousBets.map(b => b.side));
  const hasYES = betSides.has('YES');
  const hasNO = betSides.has('NO');
  const primarySide = previousBets[0]?.side; // First bet's direction

  // PRIORITY 0: Oracle Lag Arbitrage (HOLY GRAIL - exploits Binance->Oracle delay)
  // This is checked FIRST because it's the highest-alpha opportunity
  // Binance moves 5-30s before Polymarket oracle updates = free money
  if (oracleLagSniper) {
    const oracleLag = await oracleLagSniper.detectOracleLagOpportunity(
      window,
      market,
      MEMORY.priceHistory
    );

    if (oracleLag) {
      // Oracle lag is allowed to override existing positions
      // because it's arbitrage with information asymmetry
      console.log(JSON.stringify({
        action: 'ORACLE_LAG_DETECTED',
        binancePrice: oracleLag.metadata.binancePrice,
        polymarketPrice: oracleLag.metadata.polymarketPrice,
        momentum: (oracleLag.metadata.recentMomentum * 100).toFixed(2) + '%',
        latency: oracleLag.metadata.dataLatency + 'ms',
        confidence: (oracleLag.confidence * 100).toFixed(0) + '%',
        timestamp: new Date().toISOString()
      }));
      return oracleLag;
    }
  }

  // PRIORITY 1: Arbitrage Hedge (guaranteed profit lock)
  const arbitrage = await checkArbitrageHedge(previousBets, market);
  if (arbitrage) return arbitrage; // Only allowed opposite-side bet

  // Get current market prices
  const yesPrice = await getRealTimePrice(market.yesTokenId);

  // PRIORITY 2: Flash crash fade (>2% BTC drop in <60s)
  // ONLY if it matches our existing position or we haven't bet yet
  if (MEMORY.flashCrashDetected) {
    // If YES is cheap after flash crash, buy it (panic selling created value)
    if (yesPrice < 0.40 && !hasNO) { // Don't bet YES if we already bet NO
      return {
        trigger: 'flash_crash_fade',
        confidence: 0.78,
        side: 'YES',
        positionSize: 0.12, // 12% on flash crash fades (high conviction)
        reasoning: [`🚨 Flash crash detected → YES at ${(yesPrice * 100).toFixed(1)}% is PANIC SELLING`, `Fading emotional overreaction`],
      };
    }
  }

  // PRIORITY 3: Extreme reversion (>75% or <25%)
  // ONLY pyramid in the direction we already committed to
  if (yesPrice > 0.75 && !hasYES) { // Don't bet NO if we already bet YES
    return {
      trigger: 'extreme_fade',
      confidence: 0.75,
      side: 'NO',
      positionSize: 0.10, // 10% on extremes
      reasoning: [`YES extremely overpriced at ${(yesPrice * 100).toFixed(1)}% → aggressive fade to NO`],
    };
  }
  if (yesPrice < 0.25 && !hasNO) { // Don't bet YES if we already bet NO
    return {
      trigger: 'extreme_fade',
      confidence: 0.75,
      side: 'YES',
      positionSize: 0.10,
      reasoning: [`YES extremely underpriced at ${(yesPrice * 100).toFixed(1)}% → aggressive buy YES`],
    };
  }

  // PRIORITY 4: Pyramid winner (previous bet up ≥15%)
  if (previousBets && previousBets.length > 0) {
    const lastBet = previousBets[previousBets.length - 1];
    try {
      const currentPrice = await getRealTimePrice(lastBet.tokenId);
      const profit = (currentPrice - lastBet.price) / lastBet.price;

      if (profit >= 0.15) {
        return {
          trigger: 'pyramid',
          confidence: 0.72,
          side: lastBet.side,
          positionSize: Math.min(0.10, 0.06 + (profit * 0.2)), // Scale with profit
          reasoning: [`Previous bet profitable +${(profit * 100).toFixed(1)}% → pyramid winner`],
        };
      }
    } catch (e) {
      // Continue
    }
  }

  // PRIORITY 5: Strong momentum (>1% BTC move on short OR medium timeframe)
  // ONLY pyramid in same direction as initial bet
  const strongShort = Math.abs(momentum.short) > 0.01;
  const strongMedium = Math.abs(momentum.medium) > 0.01;

  if (strongShort || strongMedium) {
    const primaryMomentum = strongShort ? momentum.short : momentum.medium;
    const timeframe = strongShort ? 'short-term' : '5min';
    const momentumSide = primaryMomentum > 0 ? 'YES' : 'NO';

    // Don't bet opposite side of existing position
    if ((momentumSide === 'YES' && hasNO) || (momentumSide === 'NO' && hasYES)) {
      // Skip this trigger - would hedge our position
    } else {
      return {
        trigger: 'strong_momentum',
        confidence: 0.70,
        side: momentumSide,
        positionSize: 0.08,
        reasoning: [`BTC strong ${timeframe} momentum ${(primaryMomentum * 100).toFixed(2)}% → conviction ${primaryMomentum > 0 ? 'UP' : 'DOWN'}`],
      };
    }
  }

  // PRIORITY 6: High conviction spike (≥80%)
  // ONLY pyramid in same direction as initial bet
  // Get order book for technical analysis
  const orderBookOutput = runPmarketCLI(`-o ${market.yesTokenId}`);
  const analysis = analyzeTrade(btcPrice, yesPrice, momentum, window.timeLeft, orderBookOutput);

  if (analysis.confidence >= 0.80) {
    // Don't bet opposite side of existing position
    if ((analysis.side === 'YES' && hasNO) || (analysis.side === 'NO' && hasYES)) {
      // Skip - would hedge our position
    } else {
      return {
        trigger: 'high_conviction',
        confidence: analysis.confidence,
        side: analysis.side,
        positionSize: 0.06,
        reasoning: [`Conviction spike: ${(analysis.confidence * 100).toFixed(0)}%`, ...analysis.reasoning],
      };
    }
  }

  // PRIORITY 7: Lottery ticket (ridiculous odds, low risk, high upside)
  // If price < 0.05 and time left < 5min and we think it's >10% likely
  // ONLY if it doesn't hedge our existing position
  if (window.timeLeft < 300) {
    const cheapSide = yesPrice < 0.05 ? 'YES' : (yesPrice > 0.95 ? 'NO' : null);

    if (cheapSide) {
      const cheapPrice = cheapSide === 'YES' ? yesPrice : (1 - yesPrice);
      const potentialReturn = (1 / cheapPrice) - 1; // How much we make if it hits

      // Only take lottery ticket if our analysis suggests >10% chance
      // AND it doesn't hedge our position
      if (analysis.confidence >= 0.55 &&
          ((cheapSide === 'YES' && analysis.side === 'YES') ||
           (cheapSide === 'NO' && analysis.side === 'NO')) &&
          !((cheapSide === 'YES' && hasNO) || (cheapSide === 'NO' && hasYES))) {

        return {
          trigger: 'lottery_ticket',
          confidence: 0.65,
          side: cheapSide,
          positionSize: 0.02, // Only risk 2% on lottery tickets
          reasoning: [
            `🎰 LOTTERY: ${cheapSide}@${cheapPrice.toFixed(3)} → ${potentialReturn.toFixed(0)}x upside`,
            `Low risk, massive upside if hits`
          ],
        };
      }
    }
  }

  // PRIORITY 8: Time pressure (<5 min left + 70% confidence)
  // ONLY if it doesn't hedge our existing position
  if (window.timeLeft < 300 && analysis.confidence >= 0.70) {
    // Don't bet opposite side
    if ((analysis.side === 'YES' && hasNO) || (analysis.side === 'NO' && hasYES)) {
      // Skip - would hedge
    } else {
      return {
        trigger: 'time_pressure',
        confidence: analysis.confidence,
        side: analysis.side,
        positionSize: 0.05,
        reasoning: [`<5min left + ${(analysis.confidence * 100).toFixed(0)}% confidence → urgency`],
      };
    }
  }

  return null;
}

// Place bet
async function placeBet(market, btcPrice, analysis, window, betNumber, positionPct) {
  // Fetch live balance from blockchain before every bet
  const balance = await getLiveBalance();
  MEMORY.activeBalance = balance;

  const positionSize = balance * positionPct;

  const tokenId = analysis.side === 'YES' ? market.yesTokenId : market.noTokenId;

  // Use dynamic pricing based on confidence - higher confidence = willing to pay more
  const price = getBestAskPrice(tokenId, analysis.confidence);

  console.log(JSON.stringify({
    action: 'PLACING_BET',
    window: window.slug,
    betNumber: betNumber,
    timeLeft: window.timeLeft,
    market: market.question,
    side: analysis.side,
    price: price.toFixed(4),
    maxPrice: Math.min(0.99, analysis.confidence - 0.03).toFixed(4),
    size: positionSize.toFixed(2),
    confidence: analysis.confidence.toFixed(2),
    btcPrice: btcPrice.toFixed(2),
    reasoning: analysis.reasoning,
    trigger: analysis.trigger || 'initial',
    timestamp: new Date().toISOString(),
  }));

  const command = `-b ${tokenId} ${positionSize.toFixed(2)} ${price.toFixed(4)}`;
  const output = runPmarketCLI(command);

  if (output && output.includes('success')) {
    // Calculate current exposure and open positions for decision trace
    const openTrades = MEMORY.trades.filter(t => t.status === 'open');
    const currentExposure = openTrades.reduce((sum, t) => sum + t.size, 0);
    const exposurePct = currentExposure / balance;
    const windowBets = MEMORY.trades.filter(t => t.window === window.slug && t.status === 'open').length;

    const trade = {
      id: Date.now(),
      window: window.slug,
      betNumber: betNumber,
      market: market.question,
      side: analysis.side,
      tokenId: tokenId,
      price: price,
      size: positionSize,
      confidence: analysis.confidence,
      reasoning: analysis.reasoning,
      trigger: analysis.trigger || 'initial',
      btcPriceAtEntry: btcPrice,
      timestamp: new Date().toISOString(),
      endDate: market.endDate,
      status: 'open',

      // Decision trace (for learning system)
      decisionTrace: {
        momentumAnalysis: analysis.momentum || null,
        marketState: {
          btcPrice: btcPrice,
          timeLeftInWindow: window.timeLeft,
        },
        factors: analysis.reasoning,
        decision: {
          side: analysis.side,
          confidence: analysis.confidence,
          trigger: analysis.trigger || 'initial',
          maxPrice: analysis.confidence - 0.03,
          executionPrice: price,
        },
        environment: {
          flashCrashActive: MEMORY.flashCrashDetected,
          exposurePct: exposurePct,
          openPositions: openTrades.length,
          windowBets: windowBets,
        },
        windowContext: {
          windowId: window.slug,
          betNumber: betNumber,
          timestamp: Date.now(),
        },
      },
    };

    // Add handoff-specific metadata if this is a handoff bet
    if (analysis.trigger === 'window_handoff') {
      trade.handoffFromWindow = analysis.handoffFromWindow;
      trade.handoffMomentum = analysis.handoffMomentum;
    }

    MEMORY.trades.push(trade);
    MEMORY.lastBetTime = Date.now();
    if (betNumber === 1) MEMORY.bet1Time = Date.now();
    if (betNumber === 2) MEMORY.bet2Time = Date.now();
    saveMemory();

    // Save to database (non-blocking, graceful failure)
    if (DB && learningDB) {
      learningDB.insertTrade(DB, trade).catch(err => {
        console.warn(JSON.stringify({
          action: 'DB_INSERT_FAILED',
          error: err.message,
          timestamp: new Date().toISOString(),
        }));
      });
    }

    console.log(JSON.stringify({
      action: 'BET_SUCCESS',
      tradeId: trade.id,
      timestamp: new Date().toISOString(),
    }));
  } else {
    console.log(JSON.stringify({
      action: 'BET_FAILED',
      output: output ? output.substring(0, 200) : 'No output',
      timestamp: new Date().toISOString(),
    }));
  }
}

// Take profits with DYNAMIC threshold based on balance
function takeProfits() {
  const netProfit = MEMORY.totalProfit - MEMORY.totalLoss;

  // DYNAMIC THRESHOLD: 15% of current active balance
  const dynamicThreshold = MEMORY.activeBalance * 0.15;

  // Only lock profits if net profit exceeds dynamic threshold
  if (netProfit >= dynamicThreshold) {
    const profitToLock = netProfit * 0.5; // Lock 50% of profits
    MEMORY.lockedProfits += profitToLock;

    // Reset profit/loss counters after locking (start fresh)
    MEMORY.totalProfit = netProfit - profitToLock;
    MEMORY.totalLoss = 0;

    console.log(JSON.stringify({
      action: 'PROFIT_LOCKED',
      netProfit: netProfit.toFixed(2),
      threshold: dynamicThreshold.toFixed(2),
      lockedAmount: profitToLock.toFixed(2),
      totalLocked: MEMORY.lockedProfits.toFixed(2),
      newActiveProfit: (MEMORY.totalProfit - MEMORY.totalLoss).toFixed(2),
      activeBalance: MEMORY.activeBalance.toFixed(2),
      nextThreshold: (MEMORY.activeBalance * 0.15).toFixed(2),
      compoundingEnabled: true,
      timestamp: new Date().toISOString(),
    }));

    saveMemory();
  }
}

// Check for window handoff bet opportunity
async function checkHandoffOpportunity(window, btcData, momentum) {
  // Only trigger in last 30-60 seconds of current window
  if (window.timeLeft >= 60 || window.timeLeft <= 30) {
    return null;
  }

  // Check if already placed handoff for this transition
  if (MEMORY.handoffPlacedForWindow[window.slug]) {
    return null;
  }

  // Calculate composite momentum
  const compositeMomentum =
    (momentum.short * 0.20) +
    (momentum.medium * 0.30) +
    (momentum.hourly * 0.30) +
    (momentum.daily * 0.20);

  // Need strong momentum for handoff
  if (Math.abs(compositeMomentum) < 0.002) {
    return null;
  }

  // Check handoff exposure limits
  const handoffTrades = MEMORY.trades.filter(
    t => t.status === 'open' && t.trigger === 'window_handoff'
  );
  const handoffExposure = handoffTrades.reduce((sum, t) => sum + t.size, 0);

  if (handoffExposure >= MEMORY.activeBalance * CONFIG.handoffBet.maxExposure) {
    console.log(JSON.stringify({
      action: 'HANDOFF_SKIPPED',
      reason: 'max_exposure_reached',
      handoffExposure: handoffExposure.toFixed(2),
      maxExposure: (MEMORY.activeBalance * CONFIG.handoffBet.maxExposure).toFixed(2),
      timestamp: new Date().toISOString(),
    }));
    return null;
  }

  // Get next window
  const nextWindow = getNextWindow(window);

  // Try to fetch next window market
  let nextMarket;
  try {
    nextMarket = await getCurrentMarket(nextWindow);
    if (!nextMarket) {
      return null; // Market not available yet
    }
  } catch (e) {
    return null; // Market not available yet
  }

  // Analyze next window with current momentum
  const yesPrice = await getRealTimePrice(nextMarket.yesTokenId);
  const orderBookOutput = runPmarketCLI(`-o ${nextMarket.yesTokenId}`);
  const analysis = analyzeTrade(btcData.price, yesPrice, momentum, nextWindow.timeLeft, orderBookOutput);

  // Attach momentum data for decision trace
  analysis.momentum = momentum;

  // Check confidence threshold
  if (analysis.confidence < CONFIG.handoffBet.confidenceMin) {
    return null;
  }

  // Return handoff signal
  return {
    market: nextMarket,
    window: nextWindow,
    side: analysis.side,
    confidence: analysis.confidence,
    trigger: 'window_handoff',
    reasoning: [
      ...analysis.reasoning,
      `Handoff from ${window.slug}`,
      `Momentum continuation: ${(compositeMomentum * 100).toFixed(2)}%`
    ],
    positionSize: MEMORY.activeBalance * CONFIG.handoffBet.positionSize,
    handoffFromWindow: window.slug,
    handoffMomentum: compositeMomentum,
  };
}

// Main real-time loop
async function realtimeLoop() {
  while (true) {
    try {
      // Get CURRENT window (the one we're betting on)
      const window = getCurrentWindow();

      // Check if new window
      if (!MEMORY.currentWindow || MEMORY.currentWindow !== window.slug) {
        MEMORY.currentWindow = window.slug;
        MEMORY.lastBetTime = 0; // Reset bet timer for new window

        console.log(JSON.stringify({
          action: 'NEW_WINDOW',
          window: window.slug,
          duration: '15min',
          timeLeft: window.timeLeft,
          timestamp: new Date().toISOString(),
        }));
      }

      // Get BTC price from streaming data
      const btcData = getBTCPrice();
      if (!btcData) {
        // Wait for WebSocket connection to establish
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      console.log(JSON.stringify({
        action: 'BTC_PRICE',
        price: btcData.price.toFixed(2),
        sources: btcData.sources.map(s => s.source),
        context: btcData.context ? {
          daily: (btcData.context.priceChangePct24h * 100).toFixed(2) + '%',
          high24h: btcData.context.high24h.toFixed(0),
          low24h: btcData.context.low24h.toFixed(0),
        } : null,
        timeLeft: window.timeLeft,
        timestamp: new Date().toISOString(),
      }));

      // Calculate momentum
      const momentum = calculateMomentum();

      // Window timing
      const windowActive = window.timeUntilStart <= 0; // Window has started (or is starting)
      const timeIntoWindow = windowActive ? Math.abs(window.timeUntilStart) : 0;

      // Get all bets for this window
      const windowBets = MEMORY.trades.filter(t => t.window === window.slug);
      const betCount = windowBets.length;

      // Calculate total exposure for this window
      const totalExposure = windowBets.reduce((sum, t) => sum + t.size, 0);
      const balance = MEMORY.activeBalance || CONFIG.startingBalance;
      const exposurePct = totalExposure / balance;

      // PLACE INITIAL BET
      // Conditions: Window started + T+60s passed + no bets yet + >8min left
      if (betCount === 0 && windowActive && timeIntoWindow >= CONFIG.initialBet.timing && window.timeLeft > 480) {
        const market = await getCurrentMarket(window);

        if (market) {
          const yesPrice = await getRealTimePrice(market.yesTokenId);
          const orderBookOutput = runPmarketCLI(`-o ${market.yesTokenId}`);
          const analysis = analyzeTrade(btcData.price, yesPrice, momentum, window.timeLeft, orderBookOutput);

          if (analysis.confidence >= CONFIG.initialBet.confidenceMin) {
            await placeBet(market, btcData.price, analysis, window, 1, CONFIG.initialBet.positionSize);
            takeProfits();
          } else {
            console.log(JSON.stringify({
              action: 'INITIAL_BET_SKIPPED',
              reason: 'confidence_too_low',
              confidence: analysis.confidence.toFixed(2),
              threshold: CONFIG.initialBet.confidenceMin,
              timestamp: new Date().toISOString(),
            }));
          }
        } else {
          console.log(JSON.stringify({
            action: 'MARKET_NOT_FOUND',
            window: window.slug,
            timestamp: new Date().toISOString(),
          }));
        }
      }

      // PLACE FOLLOW-ON BETS (Adaptive, 1-2 additional bets)
      // Conditions: Have initial bet + waited 2min + haven't hit max bets + haven't hit max exposure + >1min left
      if (betCount > 0 &&
          betCount < CONFIG.maxBetsPerWindow &&
          exposurePct < CONFIG.maxTotalExposure &&
          windowActive &&
          timeIntoWindow >= CONFIG.followOnBet.minTiming &&
          window.timeLeft > 60) {

        const market = await getCurrentMarket(window);

        if (market) {
          const trigger = await shouldPlaceFollowOn(window, windowBets, market, btcData.price, betCount + 1);

          if (trigger) {
            // Check if this follow-on bet would exceed max exposure
            const proposedSize = balance * (trigger.positionSize || CONFIG.followOnBet.positionSize);
            const newExposure = (totalExposure + proposedSize) / balance;

            if (newExposure <= CONFIG.maxTotalExposure) {
              if (trigger.confidence >= CONFIG.followOnBet.confidenceMin) {
                await placeBet(market, btcData.price, trigger, window, betCount + 1, trigger.positionSize || CONFIG.followOnBet.positionSize);
                takeProfits();
              } else {
                console.log(JSON.stringify({
                  action: 'FOLLOW_ON_SKIPPED',
                  reason: 'confidence_too_low',
                  trigger: trigger.trigger,
                  confidence: trigger.confidence.toFixed(2),
                  threshold: CONFIG.followOnBet.confidenceMin,
                  timestamp: new Date().toISOString(),
                }));
              }
            } else {
              console.log(JSON.stringify({
                action: 'FOLLOW_ON_SKIPPED',
                reason: 'max_exposure_reached',
                currentExposure: (exposurePct * 100).toFixed(1) + '%',
                maxExposure: (CONFIG.maxTotalExposure * 100) + '%',
                timestamp: new Date().toISOString(),
              }));
            }
          }
        }
      }

      // WINDOW HANDOFF BET (momentum continuation to next window)
      if (window.timeLeft < 60 && window.timeLeft > 30) {
        const handoff = await checkHandoffOpportunity(window, btcData, momentum);

        if (handoff) {
          await placeBet(
            handoff.market,
            btcData.price,
            handoff,
            handoff.window,
            1, // betNumber for next window
            CONFIG.handoffBet.positionSize
          );

          MEMORY.handoffPlacedForWindow[window.slug] = true;

          // Prune old entries (keep last 5)
          const handoffWindows = Object.keys(MEMORY.handoffPlacedForWindow);
          if (handoffWindows.length > 5) {
            handoffWindows.sort();
            delete MEMORY.handoffPlacedForWindow[handoffWindows[0]];
          }

          saveMemory();
          takeProfits();
        }
      }

      // Status update
      const betStatus = betCount === 0 ?
                       (windowActive && timeIntoWindow >= CONFIG.initialBet.timing ? 'Ready for initial bet' :
                        windowActive ? `Waiting ${CONFIG.initialBet.timing - timeIntoWindow}s for initial` :
                        'Waiting for window start') :
                       betCount >= CONFIG.maxBetsPerWindow ? `Max bets (${betCount}) placed` :
                       exposurePct >= CONFIG.maxTotalExposure ? `Max exposure (${(exposurePct * 100).toFixed(0)}%) reached` :
                       `${betCount} bet(s) placed, monitoring for follow-ons`;

      console.log(JSON.stringify({
        action: 'STATUS',
        window: window.slug,
        timeUntilStart: window.timeUntilStart,
        timeLeft: window.timeLeft,
        betStatus: betStatus,
        windowBets: betCount,
        windowExposure: (exposurePct * 100).toFixed(1) + '%',
        activeBalance: MEMORY.activeBalance.toFixed(2),
        openPositions: MEMORY.trades.filter(t => t.status === 'open').length,
        totalTrades: MEMORY.trades.length,
        timestamp: new Date().toISOString(),
      }));

      // Wait before next check
      await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));

    } catch (error) {
      console.error(JSON.stringify({
        action: 'LOOP_ERROR',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));

      await new Promise(resolve => setTimeout(resolve, CONFIG.priceCheckInterval));
    }
  }
}

// Start bot
async function start() {
  loadMemory();

  // Initialize learning database
  if (learningDB) {
    try {
      DB = await learningDB.initDatabase();
      console.log(JSON.stringify({
        action: 'DATABASE_INITIALIZED',
        path: '~/.polymarket-trader/trading_data.db',
        timestamp: new Date().toISOString(),
      }));
    } catch (e) {
      console.warn('DB init failed: ' + e.message);
    }
  }

  // Restore learned config if exists
  if (MEMORY.learnedConfig) {
    Object.assign(CONFIG, MEMORY.learnedConfig);
    console.log(JSON.stringify({
      action: 'LEARNED_CONFIG_RESTORED',
      adjustments: Object.keys(MEMORY.learnedConfig).length,
      timestamp: new Date().toISOString(),
    }));
  }

  // Fetch live balance from Polymarket
  const liveBalance = await getLiveBalance();
  MEMORY.activeBalance = liveBalance;

  // Connect WebSocket streams for real-time BTC prices
  console.log(JSON.stringify({
    action: 'CONNECTING_WEBSOCKETS',
    timestamp: new Date().toISOString(),
  }));

  connectBinanceWebSocket();
  connectCoinbaseWebSocket();

  // Start Oracle Lag Sniper (HIGHEST ALPHA - exploits Binance->Oracle delay)
  if (oracleLagSniper) {
    oracleLagSniper.startBinanceWebSocket();
    console.log(JSON.stringify({
      action: 'ORACLE_SNIPER_ENABLED',
      strategy: 'Exploit 5-30s delay between Binance spot and Polymarket oracle',
      edge: 'Information asymmetry arbitrage',
      timestamp: new Date().toISOString(),
    }));
  }

  // Wait 2 seconds for WebSocket connections to establish
  await new Promise(resolve => setTimeout(resolve, 2000));

  console.log(JSON.stringify({
    action: 'BOT_START',
    mode: 'REAL-TIME ADAPTIVE WITH SETTLEMENT',
    strategy: 'ARBITRAGE HEDGING + CONVICTION PYRAMIDING',
    settlement: {
      checkInterval: '45s',
      profitLocking: 'DYNAMIC (15% of balance)',
      lockPercentage: '50% of profits',
      claiming: 'MANUAL via Polymarket web UI',
    },
    config: {
      priceCheckInterval: CONFIG.priceCheckInterval / 1000 + 's',
      maxBetsPerWindow: CONFIG.maxBetsPerWindow,
      maxTotalExposure: (CONFIG.maxTotalExposure * 100) + '%',
      initialBet: (CONFIG.initialBet.positionSize * 100) + '% @ T+' + CONFIG.initialBet.timing + 's',
      followOnBet: (CONFIG.followOnBet.positionSize * 100) + '% adaptive',
    },
    triggers: [
      '0. 🔮 Oracle Lag (Binance->Oracle 5-30s delay arbitrage) ← HIGHEST ALPHA',
      '1. Arbitrage Hedge (guaranteed profit lock)',
      '2. Flash Crash Fade (>2% drop in <60s)',
      '3. Extreme Reversion (>75% or <25%)',
      '4. Pyramid Winner (prev bet +15%)',
      '5. Strong Momentum (BTC >1%)',
      '6. High Conviction (≥80%)',
      '7. Lottery Ticket (<5¢, <5min, 50x+ upside)',
      '8. Time Pressure (<5min + 70%)',
    ],
    memory: {
      totalTrades: MEMORY.trades.length,
      openTrades: MEMORY.trades.filter(t => t.status === 'open').length,
      settledTrades: MEMORY.trades.filter(t => t.status !== 'open').length,
      activeBalance: MEMORY.activeBalance.toFixed(2),
      lockedProfits: MEMORY.lockedProfits.toFixed(2),
      netPL: (MEMORY.totalProfit - MEMORY.totalLoss).toFixed(2),
      winRate: MEMORY.winCount + MEMORY.lossCount > 0 ?
        ((MEMORY.winCount / (MEMORY.winCount + MEMORY.lossCount)) * 100).toFixed(1) + '%' : '0%',
    },
    timestamp: new Date().toISOString(),
  }));

  // Start settlement loop in parallel (non-blocking)
  settlementLoop().catch(console.error);

  // Start learning loop if database available
  if (DB && learningEngine) {
    learningLoop(DB).catch(console.error);
  }

  // Start supervisor loop if available
  if (DB && moonshotSupervisor) {
    supervisorLoop(DB).catch(console.error);
    console.log(JSON.stringify({
      action: 'SUPERVISOR_ENABLED',
      model: 'moonshot-v1-128k',
      reviewInterval: '1hr',
      timestamp: new Date().toISOString(),
    }));
  }

  // Start hourly trading loop (EMA strategy for 1-hour windows)
  if (hourlyStrategy) {
    hourlyTradingLoop().catch(console.error);
    console.log(JSON.stringify({
      action: 'HOURLY_STRATEGY_ENABLED',
      strategy: 'EMA 9/21 Trend Following',
      maxBetSize: '$10',
      checkInterval: '5min',
      timestamp: new Date().toISOString(),
    }));
  }

  // Small delay to let loops initialize
  await new Promise(resolve => setTimeout(resolve, 100));

  // Start main real-time trading loop
  await realtimeLoop();
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = { start };
