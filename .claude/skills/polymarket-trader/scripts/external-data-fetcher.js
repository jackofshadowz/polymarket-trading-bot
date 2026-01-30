const https = require('https');

// ============================================================
// BTC NEWS FETCHING
// ============================================================

async function fetchBTCNews() {
  return new Promise((resolve) => {
    const url = 'https://min-api.cryptocompare.com/data/v2/news/?categories=BTC&lang=EN';

    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const articles = json.Data || [];

          const headlines = articles.slice(0, 5).map(a => a.title);
          const sentiment = analyzeSentiment(headlines.join(' '));

          resolve({
            headlines,
            sentiment,
            count: articles.length
          });
        } catch (e) {
          resolve({headlines: [], sentiment: 'neutral', count: 0});
        }
      });
    }).on('error', () => {
      resolve({headlines: [], sentiment: 'neutral', count: 0});
    });
  });
}

function analyzeSentiment(text) {
  const bullishWords = ['rally', 'surge', 'bullish', 'gains', 'rise', 'up', 'high', 'moon', 'pump', 'break', 'soar'];
  const bearishWords = ['crash', 'dump', 'bearish', 'fall', 'down', 'low', 'decline', 'drop', 'plunge', 'tank'];

  const lowerText = text.toLowerCase();

  let score = 0;
  bullishWords.forEach(word => {
    if (lowerText.includes(word)) score++;
  });
  bearishWords.forEach(word => {
    if (lowerText.includes(word)) score--;
  });

  if (score > 2) return 'bullish';
  if (score < -2) return 'bearish';
  return 'neutral';
}

// ============================================================
// ON-CHAIN METRICS (SIMPLIFIED)
// ============================================================

async function fetchBTCOnChainMetrics() {
  // For now, return mock data
  // In production, integrate with Glassnode or CryptoQuant API
  return {
    trend: 'neutral',
    activity: 'moderate',
    note: 'On-chain data integration pending'
  };
}

// ============================================================
// SOCIAL SENTIMENT (SIMPLIFIED)
// ============================================================

async function fetchBTCSentiment() {
  // For now, return neutral
  // In production, integrate with Twitter API or sentiment services
  return {
    score: 0,
    volume: 0,
    trending_topics: [],
    note: 'Social sentiment integration pending'
  };
}

// ============================================================
// AGGREGATE MARKET CONTEXT
// ============================================================

async function getMarketContext() {
  const [news, onchain, sentiment] = await Promise.all([
    fetchBTCNews(),
    fetchBTCOnChainMetrics(),
    fetchBTCSentiment()
  ]);

  return {
    news,
    onchain,
    sentiment,
    timestamp: new Date().toISOString()
  };
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  fetchBTCNews,
  fetchBTCOnChainMetrics,
  fetchBTCSentiment,
  getMarketContext
};
