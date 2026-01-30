// ============================================================
// TECHNICAL INDICATORS FOR BTC PRICE PREDICTION
// ============================================================
// Implements RSI, Bollinger Bands, EMA, and order book analysis
// for short-term (15-minute) BTC prediction markets

const https = require('https');

// Price history for indicator calculations (stores last 100 prices)
const PRICE_HISTORY = {
  prices: [],
  maxLength: 100,
  lastUpdate: 0
};

// CVD (Cumulative Volume Delta) tracking
const CVD_HISTORY = {
  deltas: [], // {timestamp, price, delta, cvd}
  maxLength: 100,
  currentCVD: 0
};

/**
 * Add price to history
 * @param {number} price BTC price
 * @param {number} timestamp Timestamp in ms
 */
function addPriceToHistory(price, timestamp) {
  PRICE_HISTORY.prices.push({ price, timestamp });

  // Keep only last 100 prices
  if (PRICE_HISTORY.prices.length > PRICE_HISTORY.maxLength) {
    PRICE_HISTORY.prices.shift();
  }

  PRICE_HISTORY.lastUpdate = timestamp;
}

/**
 * Get recent price history for calculations
 * @param {number} count Number of prices to return
 * @returns {Array} Recent prices
 */
function getRecentPrices(count = 14) {
  return PRICE_HISTORY.prices.slice(-count).map(p => p.price);
}

// ============================================================
// RSI (RELATIVE STRENGTH INDEX)
// ============================================================
// Momentum oscillator that measures speed and change of price movements
// RSI > 70 = overbought (potential reversal DOWN)
// RSI < 30 = oversold (potential reversal UP)
// RSI 40-60 = neutral zone

/**
 * Calculate RSI (Relative Strength Index)
 * @param {number} period Period for RSI calculation (default 14)
 * @returns {Object} RSI value and signal
 */
function calculateRSI(period = 14) {
  const prices = getRecentPrices(period + 1);

  if (prices.length < period + 1) {
    return { value: 50, signal: 'neutral', confidence: 0 };
  }

  // Calculate price changes
  const gains = [];
  const losses = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) {
      gains.push(change);
      losses.push(0);
    } else {
      gains.push(0);
      losses.push(Math.abs(change));
    }
  }

  // Calculate average gain and loss
  const avgGain = gains.reduce((sum, g) => sum + g, 0) / period;
  const avgLoss = losses.reduce((sum, l) => sum + l, 0) / period;

  // Calculate RS and RSI
  if (avgLoss === 0) {
    return { value: 100, signal: 'extreme_overbought', confidence: 0.90 };
  }

  const rs = avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));

  // Generate signal based on RSI value
  let signal, confidence;

  if (rsi > 75) {
    signal = 'extreme_overbought'; // Strong sell signal
    confidence = 0.85;
  } else if (rsi > 70) {
    signal = 'overbought'; // Moderate sell signal
    confidence = 0.70;
  } else if (rsi < 25) {
    signal = 'extreme_oversold'; // Strong buy signal
    confidence = 0.85;
  } else if (rsi < 30) {
    signal = 'oversold'; // Moderate buy signal
    confidence = 0.70;
  } else if (rsi > 55 && rsi <= 70) {
    signal = 'bullish'; // Mild bullish momentum
    confidence = 0.55;
  } else if (rsi < 45 && rsi >= 30) {
    signal = 'bearish'; // Mild bearish momentum
    confidence = 0.55;
  } else {
    signal = 'neutral';
    confidence = 0;
  }

  return { value: rsi, signal, confidence };
}

// ============================================================
// BOLLINGER BANDS
// ============================================================
// Volatility bands placed above and below a moving average
// Price touching upper band = overbought
// Price touching lower band = oversold
// Bands widening = increasing volatility

/**
 * Calculate Bollinger Bands
 * @param {number} period Period for SMA calculation (default 20)
 * @param {number} stdDev Number of standard deviations (default 2)
 * @returns {Object} Bollinger Bands values and signal
 */
function calculateBollingerBands(period = 20, stdDev = 2) {
  const prices = getRecentPrices(period);

  if (prices.length < period) {
    return {
      upper: 0,
      middle: 0,
      lower: 0,
      signal: 'neutral',
      confidence: 0,
      percentB: 0.5
    };
  }

  // Calculate SMA (middle band)
  const sma = prices.reduce((sum, p) => sum + p, 0) / period;

  // Calculate standard deviation
  const squaredDiffs = prices.map(p => Math.pow(p - sma, 2));
  const variance = squaredDiffs.reduce((sum, d) => sum + d, 0) / period;
  const standardDeviation = Math.sqrt(variance);

  // Calculate bands
  const upper = sma + (stdDev * standardDeviation);
  const lower = sma - (stdDev * standardDeviation);
  const currentPrice = prices[prices.length - 1];

  // Calculate %B (where price is within bands)
  // %B = (Price - Lower Band) / (Upper Band - Lower Band)
  // %B > 1.0 = above upper band (overbought)
  // %B < 0.0 = below lower band (oversold)
  const percentB = (currentPrice - lower) / (upper - lower);

  // Calculate bandwidth (volatility indicator)
  const bandwidth = (upper - lower) / sma;

  // Generate signal
  let signal, confidence;

  if (percentB > 1.05) {
    signal = 'extreme_overbought'; // Price way above upper band
    confidence = 0.85;
  } else if (percentB > 0.95) {
    signal = 'overbought'; // Price near/at upper band
    confidence = 0.70;
  } else if (percentB < -0.05) {
    signal = 'extreme_oversold'; // Price way below lower band
    confidence = 0.85;
  } else if (percentB < 0.05) {
    signal = 'oversold'; // Price near/at lower band
    confidence = 0.70;
  } else if (percentB > 0.7) {
    signal = 'bullish'; // Price in upper portion
    confidence = 0.55;
  } else if (percentB < 0.3) {
    signal = 'bearish'; // Price in lower portion
    confidence = 0.55;
  } else {
    signal = 'neutral';
    confidence = 0;
  }

  return {
    upper,
    middle: sma,
    lower,
    currentPrice,
    percentB,
    bandwidth,
    signal,
    confidence
  };
}

// ============================================================
// EMA (EXPONENTIAL MOVING AVERAGE)
// ============================================================
// Trend-following indicator that gives more weight to recent prices
// Price > EMA = uptrend
// Price < EMA = downtrend

/**
 * Calculate EMA (Exponential Moving Average)
 * @param {number} period Period for EMA calculation
 * @returns {number} EMA value
 */
function calculateEMA(period = 12) {
  const prices = getRecentPrices(period * 2); // Get extra data for warmup

  if (prices.length < period) {
    return prices[prices.length - 1] || 0;
  }

  // Start with SMA
  const sma = prices.slice(0, period).reduce((sum, p) => sum + p, 0) / period;

  // Calculate smoothing factor
  const multiplier = 2 / (period + 1);

  // Calculate EMA
  let ema = sma;
  for (let i = period; i < prices.length; i++) {
    ema = (prices[i] - ema) * multiplier + ema;
  }

  return ema;
}

/**
 * Analyze EMA crossover signals
 * @returns {Object} EMA analysis and signal
 */
function analyzeEMA() {
  const ema9 = calculateEMA(9);   // Fast EMA
  const ema21 = calculateEMA(21); // Slow EMA
  const currentPrice = getRecentPrices(1)[0] || 0;

  if (!ema9 || !ema21 || !currentPrice) {
    return { signal: 'neutral', confidence: 0 };
  }

  // Price position relative to EMAs
  const priceVsEMA9 = ((currentPrice - ema9) / ema9) * 100;
  const priceVsEMA21 = ((currentPrice - ema21) / ema21) * 100;

  // EMA crossover
  const emaDiff = ((ema9 - ema21) / ema21) * 100;

  let signal, confidence;

  // Strong bullish: price above both EMAs and EMAs aligned bullish
  if (currentPrice > ema9 && ema9 > ema21 && emaDiff > 0.1) {
    signal = 'strong_bullish';
    confidence = 0.80;
  }
  // Moderate bullish: price above fast EMA
  else if (currentPrice > ema9 && priceVsEMA9 > 0.1) {
    signal = 'bullish';
    confidence = 0.65;
  }
  // Strong bearish: price below both EMAs and EMAs aligned bearish
  else if (currentPrice < ema9 && ema9 < ema21 && emaDiff < -0.1) {
    signal = 'strong_bearish';
    confidence = 0.80;
  }
  // Moderate bearish: price below fast EMA
  else if (currentPrice < ema9 && priceVsEMA9 < -0.1) {
    signal = 'bearish';
    confidence = 0.65;
  }
  // Neutral
  else {
    signal = 'neutral';
    confidence = 0;
  }

  return {
    ema9,
    ema21,
    currentPrice,
    priceVsEMA9: priceVsEMA9.toFixed(2),
    priceVsEMA21: priceVsEMA21.toFixed(2),
    emaDiff: emaDiff.toFixed(2),
    signal,
    confidence
  };
}

// ============================================================
// ORDER BOOK IMBALANCE
// ============================================================
// Analyzes order book to detect buying/selling pressure

/**
 * Analyze order book imbalance
 * @param {string} orderBookOutput Raw order book data from pmarket-cli
 * @returns {Object} Order book analysis and signal
 */
function analyzeOrderBookImbalance(orderBookOutput) {
  if (!orderBookOutput) {
    return { signal: 'neutral', confidence: 0, imbalance: 0 };
  }

  try {
    const bookData = JSON.parse(orderBookOutput);

    if (!bookData.bids || !bookData.asks) {
      return { signal: 'neutral', confidence: 0, imbalance: 0 };
    }

    // Calculate total bid and ask volume (top 5 levels)
    const bidVolume = bookData.bids.slice(0, 5).reduce((sum, bid) => sum + parseFloat(bid.size || 0), 0);
    const askVolume = bookData.asks.slice(0, 5).reduce((sum, ask) => sum + parseFloat(ask.size || 0), 0);

    // Calculate imbalance ratio
    // Positive = more bids (buying pressure)
    // Negative = more asks (selling pressure)
    const totalVolume = bidVolume + askVolume;

    if (totalVolume === 0) {
      return { signal: 'neutral', confidence: 0, imbalance: 0 };
    }

    const imbalance = (bidVolume - askVolume) / totalVolume;

    let signal, confidence;

    if (imbalance > 0.4) {
      signal = 'strong_buying_pressure';
      confidence = 0.75;
    } else if (imbalance > 0.2) {
      signal = 'buying_pressure';
      confidence = 0.60;
    } else if (imbalance < -0.4) {
      signal = 'strong_selling_pressure';
      confidence = 0.75;
    } else if (imbalance < -0.2) {
      signal = 'selling_pressure';
      confidence = 0.60;
    } else {
      signal = 'neutral';
      confidence = 0;
    }

    return {
      bidVolume: bidVolume.toFixed(2),
      askVolume: askVolume.toFixed(2),
      imbalance: imbalance.toFixed(3),
      signal,
      confidence
    };

  } catch (error) {
    return { signal: 'neutral', confidence: 0, imbalance: 0 };
  }
}

// ============================================================
// CVD (CUMULATIVE VOLUME DELTA)
// ============================================================
// Tracks aggressive market buys vs sells to detect divergences
// Price makes lower low + CVD makes higher low = Bear Trap (BUY signal)
// Price makes higher high + CVD makes lower high = Bull Trap (SELL signal)

/**
 * Add volume data to CVD history
 * @param {number} price Current price
 * @param {number} delta Volume delta (positive = buying, negative = selling)
 * @param {number} timestamp Timestamp in ms
 */
function addVolumeDelta(price, delta, timestamp) {
  CVD_HISTORY.currentCVD += delta;

  CVD_HISTORY.deltas.push({
    timestamp,
    price,
    delta,
    cvd: CVD_HISTORY.currentCVD
  });

  // Keep only last 100 samples
  if (CVD_HISTORY.deltas.length > CVD_HISTORY.maxLength) {
    CVD_HISTORY.deltas.shift();
  }
}

/**
 * Detect CVD divergences (price vs volume disagreement)
 * @returns {Object} Divergence signal and confidence
 */
function detectCVDDivergence() {
  if (CVD_HISTORY.deltas.length < 20) {
    return { signal: 'neutral', confidence: 0 };
  }

  const recent = CVD_HISTORY.deltas.slice(-20); // Last 20 samples

  // Find recent highs and lows
  const prices = recent.map(d => d.price);
  const cvds = recent.map(d => d.cvd);

  const currentPrice = prices[prices.length - 1];
  const currentCVD = cvds[cvds.length - 1];

  // Look for divergence in last 10 vs previous 10
  const prev10Prices = prices.slice(0, 10);
  const prev10CVD = cvds.slice(0, 10);
  const last10Prices = prices.slice(-10);
  const last10CVD = cvds.slice(-10);

  const prevPriceLow = Math.min(...prev10Prices);
  const lastPriceLow = Math.min(...last10Prices);
  const prevCVDLow = Math.min(...prev10CVD);
  const lastCVDLow = Math.min(...last10CVD);

  const prevPriceHigh = Math.max(...prev10Prices);
  const lastPriceHigh = Math.max(...last10Prices);
  const prevCVDHigh = Math.max(...prev10CVD);
  const lastCVDHigh = Math.max(...last10CVD);

  // BULLISH DIVERGENCE (Bear Trap)
  // Price making lower lows BUT CVD making higher lows = Absorption/Buying
  if (lastPriceLow < prevPriceLow && lastCVDLow > prevCVDLow) {
    const priceDrop = ((lastPriceLow - prevPriceLow) / prevPriceLow) * 100;
    const cvdRise = ((lastCVDLow - prevCVDLow) / Math.abs(prevCVDLow)) * 100;

    return {
      signal: 'bullish_divergence',
      confidence: Math.min(0.85, 0.60 + (Math.abs(cvdRise) * 0.01)),
      type: 'bear_trap',
      details: `Price: ${priceDrop.toFixed(2)}% down, CVD: ${cvdRise.toFixed(2)}% up`
    };
  }

  // BEARISH DIVERGENCE (Bull Trap)
  // Price making higher highs BUT CVD making lower highs = Distribution/Selling
  if (lastPriceHigh > prevPriceHigh && lastCVDHigh < prevCVDHigh) {
    const priceRise = ((lastPriceHigh - prevPriceHigh) / prevPriceHigh) * 100;
    const cvdDrop = ((lastCVDHigh - prevCVDHigh) / Math.abs(prevCVDHigh)) * 100;

    return {
      signal: 'bearish_divergence',
      confidence: Math.min(0.85, 0.60 + (Math.abs(cvdDrop) * 0.01)),
      type: 'bull_trap',
      details: `Price: ${priceRise.toFixed(2)}% up, CVD: ${cvdDrop.toFixed(2)}% down`
    };
  }

  // No divergence
  return { signal: 'neutral', confidence: 0 };
}

// ============================================================
// AGGREGATE TECHNICAL ANALYSIS
// ============================================================

/**
 * Run all technical indicators and generate consensus signal
 * @param {string} orderBookOutput Optional order book data
 * @returns {Object} Aggregated technical analysis
 */
function analyzeTechnicalIndicators(orderBookOutput = null) {
  // Calculate all indicators
  const rsi = calculateRSI(14);
  const bollinger = calculateBollingerBands(20, 2);
  const ema = analyzeEMA();
  const orderBook = analyzeOrderBookImbalance(orderBookOutput);
  const cvd = detectCVDDivergence();

  // Aggregate signals
  const signals = [
    { name: 'RSI', ...rsi },
    { name: 'Bollinger', signal: bollinger.signal, confidence: bollinger.confidence },
    { name: 'EMA', ...ema },
    { name: 'OrderBook', ...orderBook },
    { name: 'CVD', ...cvd }
  ];

  // Calculate consensus
  let bullishScore = 0;
  let bearishScore = 0;
  let totalConfidence = 0;

  for (const sig of signals) {
    if (!sig.signal || sig.signal === 'neutral') continue;

    const conf = sig.confidence || 0;
    totalConfidence += conf;

    if (sig.signal.includes('bullish') || sig.signal.includes('oversold') || sig.signal.includes('buying') || sig.signal.includes('divergence') && sig.type === 'bear_trap') {
      bullishScore += conf;
    } else if (sig.signal.includes('bearish') || sig.signal.includes('overbought') || sig.signal.includes('selling') || sig.signal.includes('divergence') && sig.type === 'bull_trap') {
      bearishScore += conf;
    }
  }

  // Determine consensus
  let consensus, consensusConfidence;
  const scoreDiff = Math.abs(bullishScore - bearishScore);

  if (bullishScore > bearishScore && scoreDiff > 0.5) {
    consensus = 'bullish';
    consensusConfidence = Math.min(0.85, bullishScore / signals.length);
  } else if (bearishScore > bullishScore && scoreDiff > 0.5) {
    consensus = 'bearish';
    consensusConfidence = Math.min(0.85, bearishScore / signals.length);
  } else {
    consensus = 'neutral';
    consensusConfidence = 0;
  }

  return {
    consensus,
    consensusConfidence,
    bullishScore: bullishScore.toFixed(2),
    bearishScore: bearishScore.toFixed(2),
    signals: signals.map(s => ({
      indicator: s.name,
      signal: s.signal,
      confidence: s.confidence?.toFixed(2) || '0.00',
      details: s.details || s.type || ''
    })),
    rsi: rsi.value.toFixed(1),
    bollingerPercentB: bollinger.percentB.toFixed(2),
    emaSignal: ema.signal,
    orderBookImbalance: orderBook.imbalance,
    cvdDivergence: cvd.signal !== 'neutral' ? cvd.type : 'none'
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  addPriceToHistory,
  calculateRSI,
  calculateBollingerBands,
  calculateEMA,
  analyzeEMA,
  analyzeOrderBookImbalance,
  addVolumeDelta,
  detectCVDDivergence,
  analyzeTechnicalIndicators,

  // Expose histories for debugging
  getPriceHistory: () => PRICE_HISTORY.prices,
  getCVDHistory: () => CVD_HISTORY.deltas
};
