const https = require('https');

const MOONSHOT_CONFIG = {
  apiEndpoint: 'api.moonshot.ai',
  apiPath: '/v1/chat/completions',
  model: 'moonshot-v1-128k',
  maxTokens: 2000,
  temperature: 0.6,
  timeout: 30000
};

// ============================================================
// CORE API COMMUNICATION
// ============================================================

async function callMoonshotAPI(messages, options = {}) {
  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: options.model || MOONSHOT_CONFIG.model,
      messages: messages,
      temperature: options.temperature || MOONSHOT_CONFIG.temperature,
      max_tokens: options.maxTokens || MOONSHOT_CONFIG.maxTokens,
      response_format: { type: "json_object" }
    });

    const requestOptions = {
      hostname: MOONSHOT_CONFIG.apiEndpoint,
      path: MOONSHOT_CONFIG.apiPath,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${process.env.MOONSHOT_API_KEY}`
      },
      timeout: MOONSHOT_CONFIG.timeout
    };

    const req = https.request(requestOptions, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const response = JSON.parse(data);

          if (response.error) {
            console.warn(JSON.stringify({
              action: 'MOONSHOT_API_ERROR',
              error: response.error.message || response.error
            }));
            resolve(null);
            return;
          }

          const content = response.choices[0].message.content;
          const usage = response.usage;

          resolve({
            content: content,
            usage: usage
          });

        } catch (error) {
          console.warn(JSON.stringify({
            action: 'MOONSHOT_PARSE_ERROR',
            error: error.message
          }));
          resolve(null);
        }
      });
    });

    req.on('error', (error) => {
      console.warn(JSON.stringify({
        action: 'MOONSHOT_REQUEST_ERROR',
        error: error.message
      }));
      resolve(null);
    });

    req.on('timeout', () => {
      req.destroy();
      console.warn(JSON.stringify({
        action: 'MOONSHOT_TIMEOUT',
        timeout: MOONSHOT_CONFIG.timeout
      }));
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

// ============================================================
// HOURLY STRATEGIC REVIEW
// ============================================================

async function conductHourlyReview(reviewData) {
  console.log(JSON.stringify({
    action: 'MOONSHOT_HOURLY_REVIEW_START',
    tradesLast1hr: reviewData.recentTrades.last1hr.length
  }));

  const prompt = buildHourlyReviewPrompt(reviewData);

  const messages = [
    {
      role: "system",
      content: `You are a strategic trading advisor for an autonomous Polymarket BTC prediction bot.

Your role is to:
- Analyze recent performance trends
- Identify tactical opportunities
- Warn about emerging risks
- Suggest strategic adjustments

Be concise, data-driven, and actionable. Focus on insights that can improve profitability.`
    },
    {
      role: "user",
      content: prompt
    }
  ];

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      urgency: 'low',
      insights: ['LLM supervisor unavailable'],
      tacticalAdjustments: [],
      risks: [],
      confidence: 0.5
    };
  }

  return parseHourlyReviewResponse(response.content, response.usage);
}

function buildHourlyReviewPrompt(data) {
  const {recentTrades, performance, marketContext, externalData, currentState} = data;

  return `# Hourly Strategic Review

## Recent Performance

**Last 1 Hour:**
- Trades: ${performance.last1hr.count} (${performance.last1hr.settled} settled)
- Win Rate: ${(performance.last1hr.winRate * 100).toFixed(1)}%
- P/L: $${performance.last1hr.totalPL.toFixed(2)}

**Last 6 Hours:**
- Trades: ${performance.last6hr.count} (${performance.last6hr.settled} settled)
- Win Rate: ${(performance.last6hr.winRate * 100).toFixed(1)}%
- P/L: $${performance.last6hr.totalPL.toFixed(2)}

**Last 24 Hours:**
- Trades: ${performance.last24hr.count} (${performance.last24hr.settled} settled)
- Win Rate: ${(performance.last24hr.winRate * 100).toFixed(1)}%
- P/L: $${performance.last24hr.totalPL.toFixed(2)}

**Overall:**
- Balance: $${currentState.balance.toFixed(2)}
- Net Profit: $${performance.overall.netProfit.toFixed(2)}
- Total Win Rate: ${(performance.overall.winRate * 100).toFixed(1)}%
- Open Positions: ${currentState.openPositions}
- Exposure: ${(currentState.exposure * 100).toFixed(1)}%

## Market Context

**BTC Price:** $${marketContext.btcPrice.toFixed(2)}
**Volatility:** ${marketContext.volatility || 'unknown'}
**Trend:** ${marketContext.trend || 'unknown'}

## External Data

**News Sentiment:** ${externalData.news?.sentiment || 'neutral'}
**Top Headlines:**
${(externalData.news?.headlines || []).slice(0, 3).map(h => `- ${h}`).join('\n') || 'No headlines available'}

**Social Sentiment:** ${externalData.sentiment?.score > 0 ? 'Bullish' : externalData.sentiment?.score < 0 ? 'Bearish' : 'Neutral'}
**Trending Topics:** ${(externalData.sentiment?.trending_topics || []).slice(0, 3).join(', ') || 'None'}

**On-Chain Metrics:**
- Trend: ${externalData.onchain?.trend || 'unknown'}
- Activity: ${externalData.onchain?.activity || 'unknown'}

## Recent Trades (Last 1hr)

${recentTrades.last1hr.length > 0 ? recentTrades.last1hr.map(t =>
  `- ${t.side} @ ${(t.confidence * 100).toFixed(0)}% | ${t.trigger} | ${t.status} | ${t.profitLoss ? '$' + t.profitLoss.toFixed(2) : 'open'}`
).join('\n') : 'No trades in last hour'}

## Current Configuration

**Position Sizing:**
- Initial: ${(currentState.CONFIG.initialBet.positionSize * 100).toFixed(0)}% of balance
- Follow-on: ${(currentState.CONFIG.followOnBet.positionSize * 100).toFixed(0)}% of balance
- Handoff: ${currentState.CONFIG.handoffBet ? (currentState.CONFIG.handoffBet.positionSize * 100).toFixed(0) : 'N/A'}% of balance

**Confidence Thresholds:**
- Initial: ${(currentState.CONFIG.initialBet.confidenceMin * 100).toFixed(0)}%
- Follow-on: ${(currentState.CONFIG.followOnBet.confidenceMin * 100).toFixed(0)}%
- Handoff: ${currentState.CONFIG.handoffBet ? (currentState.CONFIG.handoffBet.confidenceMin * 100).toFixed(0) : 'N/A'}%

---

**Task:** Analyze this data and provide strategic insights.

Respond with JSON:
{
  "urgency": "low" | "medium" | "high",
  "insights": [
    "Clear, actionable observation...",
    "Performance trend or pattern..."
  ],
  "tacticalAdjustments": [
    {
      "action": "increase_position" | "decrease_position" | "raise_threshold" | "lower_threshold" | "pause_trigger",
      "trigger": "initial" | "follow" | "handoff" | "pyramid",
      "reason": "Why this adjustment is needed..."
    }
  ],
  "risks": [
    "Specific risk to monitor...",
    "Warning about exposure or market condition..."
  ],
  "confidence": 0.0-1.0
}`;
}

function parseHourlyReviewResponse(content, usage) {
  try {
    const parsed = JSON.parse(content);

    return {
      urgency: parsed.urgency || 'low',
      insights: parsed.insights || [],
      tacticalAdjustments: parsed.tacticalAdjustments || [],
      risks: parsed.risks || [],
      confidence: parsed.confidence || 0.5,
      usage: usage
    };
  } catch (error) {
    console.warn(JSON.stringify({
      action: 'HOURLY_REVIEW_PARSE_ERROR',
      error: error.message
    }));
    return {
      urgency: 'low',
      insights: ['Parse error'],
      tacticalAdjustments: [],
      risks: [],
      confidence: 0.3
    };
  }
}

// ============================================================
// PARAMETER ADJUSTMENT VALIDATION
// ============================================================

async function validateAdjustments(validationData) {
  console.log(JSON.stringify({
    action: 'MOONSHOT_VALIDATION_START',
    adjustmentsCount: validationData.adjustments.length
  }));

  const prompt = buildValidationPrompt(validationData);

  const messages = [
    {
      role: "system",
      content: `You are a strategic advisor validating parameter adjustments for an autonomous trading bot.

Your role is to:
- Review proposed parameter changes
- Assess if changes are reasonable given performance data
- Suggest modifications if needed
- Warn about potential risks

Be analytical and conservative. Parameter changes affect real money.`
    },
    {
      role: "user",
      content: prompt
    }
  ];

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      approved: true,
      confidence: 0.5,
      rationale: 'LLM supervisor unavailable, defaulting to approval',
      modifications: [],
      additionalRecommendations: []
    };
  }

  return parseValidationResponse(response.content, validationData.adjustments, response.usage);
}

function buildValidationPrompt(data) {
  const {adjustments, analysisResults, historicalTrades, currentState, externalContext} = data;

  return `# Parameter Adjustment Validation

## Proposed Adjustments

${adjustments.map((adj, i) => `
**Adjustment ${i + 1}:**
- Parameter: ${adj.path}
- Current Value: ${adj.oldValue.toFixed(4)}
- Proposed Value: ${adj.newValue.toFixed(4)}
- Change: ${((adj.newValue / adj.oldValue - 1) * 100).toFixed(1)}%
- Reason: ${adj.reason}
- Supporting Metrics: ${JSON.stringify(adj.metrics || {})}
`).join('\n')}

## Performance Analysis

**Trigger Performance:**
${(analysisResults.triggers || []).map(t => `
- ${t.trigger}: ${(t.winRate * 100).toFixed(1)}% win rate (${t.sampleSize} trades) | Avg P/L: $${t.avgProfitLoss?.toFixed(2) || '0.00'}
`).join('\n')}

**Confidence Calibration:**
${(analysisResults.calibration || []).map(c => `
- ${(c.bucket * 100).toFixed(0)}% confidence → ${(c.actual * 100).toFixed(1)}% actual (error: ${(c.calibrationError * 100).toFixed(1)}%)
`).join('\n')}

**Momentum Correlation:**
${(analysisResults.momentum || []).map(m => `
- ${m.momentum_regime} + ${m.side}: ${(m.win_rate * 100).toFixed(1)}% win rate (${m.sample_size} trades)
`).join('\n')}

## Current State

- Balance: $${currentState.balance.toFixed(2)}
- Net Profit: $${currentState.netProfit.toFixed(2)}
- Win Rate: ${(currentState.winRate * 100).toFixed(1)}%

## Historical Context (Last 100 Trades)

- Total: ${historicalTrades.length} trades
- Settled: ${historicalTrades.filter(t => t.status === 'won' || t.status === 'lost').length}
- Won: ${historicalTrades.filter(t => t.status === 'won').length}
- Lost: ${historicalTrades.filter(t => t.status === 'lost').length}

## External Context

**Market Sentiment:** ${externalContext.news?.sentiment || 'neutral'}
**BTC Trend:** ${externalContext.onchain?.trend || 'unknown'}

---

**Task:** Evaluate these parameter adjustments. Should they be approved, rejected, or modified?

Respond with JSON:
{
  "approved": boolean,
  "confidence": 0.0-1.0,
  "rationale": "Clear explanation of your decision...",
  "modifications": [
    {
      "parameter": "path.to.parameter",
      "suggested_value": number,
      "reason": "Why this modification is better..."
    }
  ],
  "additionalRecommendations": [
    "Strategic suggestion beyond the proposed adjustments...",
    "Pattern or opportunity you noticed..."
  ]
}`;
}

function parseValidationResponse(content, originalAdjustments, usage) {
  try {
    const parsed = JSON.parse(content);

    return {
      approved: parsed.approved !== false,
      confidence: parsed.confidence || 0.5,
      rationale: parsed.rationale || '',
      modifications: parsed.modifications || [],
      additionalRecommendations: parsed.additionalRecommendations || [],
      originalAdjustments: originalAdjustments,
      usage: usage
    };
  } catch (error) {
    console.warn(JSON.stringify({
      action: 'VALIDATION_PARSE_ERROR',
      error: error.message
    }));
    return {
      approved: true,
      confidence: 0.3,
      rationale: 'Parse error, defaulting to approval',
      modifications: [],
      additionalRecommendations: []
    };
  }
}

// ============================================================
// WINDOW-LEVEL TRADING DECISION (WORLD-CLASS TRADER)
// ============================================================

/**
 * World-class trader system prompt
 * Ice-cold, disciplined, data-driven BTC day trader
 */
const WORLD_CLASS_TRADER_SYSTEM_PROMPT = `You are an ice-cold, world-class cryptocurrency day trader with 10+ years of experience. You trade BTC 15-minute prediction markets on Polymarket with a disciplined, data-driven approach.

YOUR PHILOSOPHY:
- "The market doesn't care about your feelings" - pure logic, zero emotion
- "Edge is everything" - only trade when you have a clear statistical advantage
- "Risk management first" - preserve capital, compound wins, cut losses fast
- "Price action tells the story" - order flow and volume never lie

YOUR DECISION FRAMEWORK:
1. Delta Analysis: Is the current BTC delta likely to persist until window close?
2. Order Flow: Are buyers or sellers more aggressive? Does this confirm delta?
3. Momentum: Does short-term momentum support the delta direction?
4. Historical Patterns: Do similar delta patterns have high win rates?
5. Risk/Reward: Is the edge worth the risk given market price?

You are SELECTIVE. You skip trades when:
- Delta is too small (<$30) with too much time remaining (>10 minutes)
- Order flow contradicts delta (bearish delta but YES buying pressure)
- Liquidity is poor (wide spreads, thin order book)
- Market price offers no edge (fair value)
- On a cold streak (3+ consecutive losses)

You are AGGRESSIVE when edge is clear:
- Strong delta (+$100) with momentum confirmation
- Order flow strongly confirms your side
- Market mispriced (asymmetric edge >2:1)
- High conviction (75%+ confidence based on historical patterns)
- On a hot streak (3+ consecutive wins)

You MANAGE RISK with early exits:
- SELL to lock in profits when outcome uncertain (nailbiter with <3 min left)
- SELL to cut losses when thesis invalidated (delta reversed, order flow flipped)
- PARTIAL_SELL to reduce exposure while letting winners run
- Examples:
  * Bought YES @ 30¢, up +$80 delta, 2 min left, YES @ 85¢ → SELL (lock 55¢ profit)
  * Bought NO @ 35¢, down -$60 delta, 4 min left, NO @ 15¢ → SELL (cut loss to -20¢)
  * Bought YES @ 40¢, choppy ±$20 delta, 90s left → PARTIAL_SELL 50% (reduce risk)

CRITICAL: Return ONLY valid JSON with these exact fields:
{
  "decision": "ENTER" | "ADD" | "SKIP" | "SELL" | "PARTIAL_SELL",
  "side": "YES" | "NO" | null,
  "confidence": 0.50-1.00,
  "positionSize": 0.05-0.15,
  "sellPercentage": 0.0-1.0,
  "maxPrice": 0.00-1.00,
  "rationale": "2-3 sentence explanation with specific data points",
  "riskFactors": ["risk 1", "risk 2"],
  "stopLoss": "Condition that would invalidate thesis",
  "urgency": "low" | "medium" | "high"
}`;

// ============================================================
// RISK MANAGER PERSONALITY (SECOND OPINION)
// ============================================================

const RISK_MANAGER_SYSTEM_PROMPT = `You are a seasoned Risk Manager reviewing trading decisions for a BTC 15-minute prediction bot on Polymarket. Your colleague, the "World-Class Trader," has made an initial recommendation.

YOUR ROLE:
- Challenge aggressive positions
- Identify hidden risks the trader may have missed
- Adjust position sizing based on portfolio exposure
- Veto trades with unclear edge or high risk
- "Measure twice, cut once" philosophy

YOUR FRAMEWORK:
1. **Risk/Reward Validation**: Is the edge truly asymmetric or is the trader being overconfident?
2. **Portfolio Context**: What's our total exposure? Are we over-concentrated?
3. **Trap Detection**: Could this be a bull/bear trap? What's the order flow saying?
4. **Historical Calibration**: When we took similar trades, what was the outcome?
5. **Capital Preservation**: If this goes wrong, how much do we lose?

You OVERRIDE the trader when:
- Confidence seems inflated (trader says 85% but data supports 65%)
- Position size too large given uncertainty
- Portfolio already has 3+ open positions
- On a cold streak (3+ losses) - reduce size by 50%
- Order flow contradicts delta (major red flag)

You APPROVE when:
- Clear asymmetric edge with multiple confirmations
- Historical win rate on similar setups >70%
- Position sizing appropriate for confidence
- Good portfolio balance and risk management

You ADJUST by:
- Reducing position size (e.g., trader wants 15%, you approve 10%)
- Adding stop-loss conditions
- Recommending PARTIAL_SELL instead of full position
- Suggesting to SKIP if risk/reward unclear

CRITICAL: Return ONLY valid JSON with these exact fields:
{
  "approved": true | false,
  "decision": "ENTER" | "ADD" | "SKIP" | "SELL" | "PARTIAL_SELL",
  "side": "YES" | "NO" | null,
  "confidence": 0.50-1.00,
  "positionSize": 0.05-0.15,
  "sellPercentage": 0.0-1.0,
  "maxPrice": 0.00-1.00,
  "rationale": "2-3 sentence explanation of your risk assessment",
  "adjustments": "What you changed from trader's recommendation (or 'Approved as-is')",
  "riskFactors": ["risk 1", "risk 2", "risk 3"],
  "stopLoss": "Condition that would invalidate thesis",
  "urgency": "low" | "medium" | "high"
}`;

/**
 * Build comprehensive user prompt with all trading data
 */
function buildWindowDecisionPrompt(data) {
  const wp = data.windowPrice;
  const mp = data.marketPrices;
  const of = data.orderFlow;
  const tech = data.technicals;
  const hist = data.historicalContext;
  const streak = data.streakAnalysis;
  const pos = data.currentPosition;

  let prompt = `# 15-Minute BTC Window Trading Decision

## WINDOW FUNDAMENTALS
- Window: ${data.window.slug}
- Time Elapsed: ${data.window.timeElapsed}s / 900s (${data.window.completionPct} complete)
- Time Remaining: ${data.window.timeLeft}s

## THE CRITICAL NUMBER: WINDOW OPENING PRICE
`;

  if (wp) {
    prompt += `Opening Price: $${wp.openPrice.toFixed(2)}
Current BTC Price: $${wp.currentPrice.toFixed(2)}
Delta: ${wp.delta >= 0 ? '+' : ''}$${wp.delta.toFixed(2)} (${wp.deltaPct >= 0 ? '+' : ''}${wp.deltaPct.toFixed(3)}%)

Settlement Logic:
- YES wins if BTC closes >= $${wp.openPrice.toFixed(2)}
- NO wins if BTC closes < $${wp.openPrice.toFixed(2)}
- Current delta: ${wp.delta >= 0 ? 'POSITIVE (favors YES)' : 'NEGATIVE (favors NO)'}
- Capture Quality: ${wp.captureQuality}

`;
  } else {
    prompt += `⚠️ Window price data unavailable (early in window)\n\n`;
  }

  prompt += `## MARKET PRICES (POLYMARKET)
- YES: ${(mp.yesPrice * 100).toFixed(1)}¢
- NO: ${(mp.noPrice * 100).toFixed(1)}¢
- Spread: ${mp.spread}

Edge Analysis:
- If YES wins: Pay ${(mp.yesPrice * 100).toFixed(1)}¢, win 100¢ = ${((1 / mp.yesPrice) - 1).toFixed(2)}x return
- If NO wins: Pay ${(mp.noPrice * 100).toFixed(1)}¢, win 100¢ = ${((1 / mp.noPrice) - 1).toFixed(2)}x return
`;

  if (wp) {
    prompt += `- Current delta suggests: ${wp.delta >= 0 ? 'YES' : 'NO'} has edge\n`;
  }

  prompt += `\n## ORDER FLOW & LIQUIDITY\n`;
  if (of.available) {
    prompt += `YES Token:
- Bid Volume: $${of.yes.bidVolume} | Ask Volume: $${of.yes.askVolume}
- Imbalance: ${of.yes.imbalanceFormatted} (${of.yes.signal})
- Spread: ${of.yes.spread} | Depth: ${of.yes.depth}

NO Token:
- Bid Volume: $${of.no.bidVolume} | Ask Volume: $${of.no.askVolume}
- Imbalance: ${of.no.imbalanceFormatted} (${of.no.signal})
- Spread: ${of.no.spread} | Depth: ${of.no.depth}

Interpretation: ${of.interpretation}
`;
  } else {
    prompt += `⚠️ Order book data unavailable: ${of.reason}\n`;
  }

  prompt += `\n## TECHNICAL INDICATORS

RSI (14-period): ${tech.rsi.value} - ${tech.rsi.signal}
- ${tech.rsi.interpretation}

Momentum:
- Short-term: ${tech.momentum.short.direction} (${tech.momentum.short.change})
- Medium-term: ${tech.momentum.medium.direction} (${tech.momentum.medium.change})
- Regime: ${tech.momentum.regime}

Volatility: ${tech.volatility.recent} - ${tech.volatility.trend}
- ${tech.volatility.interpretation}

Delta Velocity: $${tech.deltaVelocity.value}/min
- ${tech.deltaVelocity.interpretation}

## HISTORICAL PERFORMANCE
`;

  if (hist.hasHistory) {
    prompt += `- Overall Win Rate: ${hist.overallWinRate} (${hist.totalTrades} trades)
- Last 5 Windows: ${hist.last5WinRate}
- Last 10 Windows: ${hist.last10WinRate}
`;

    if (streak.hasStreak) {
      prompt += `- Current Streak: ${streak.analysis}\n`;
    }

    if (hist.deltaAnalysis && Object.keys(hist.deltaAnalysis).length > 0) {
      prompt += `\nDelta Magnitude Correlations:\n`;
      Object.entries(hist.deltaAnalysis).forEach(([key, data]) => {
        prompt += `- ${key.replace('delta_gte_', 'Delta ≥$')}: ${data.winRate} (${data.wins}/${data.trades} trades)\n`;
      });
    }

    if (hist.recentOutcomes && hist.recentOutcomes.length > 0) {
      prompt += `\nLast 5 Outcomes:\n`;
      hist.recentOutcomes.forEach(outcome => {
        prompt += `- ${outcome.side} @ Δ${outcome.deltaAtEntry}: ${outcome.won ? '✅ WON' : '❌ LOST'} (${outcome.profit > 0 ? '+' : ''}${outcome.profit})\n`;
      });
    }
  } else {
    prompt += `No historical data yet (first trade)\n`;
  }

  prompt += `\n## CURRENT POSITION\n`;
  if (pos.hasPosition) {
    // Calculate current market value and P/L
    const currentPrice = pos.side === 'YES' ? mp.yesPrice : mp.noPrice;
    const entryValue = pos.totalSpent;
    const numShares = entryValue / pos.avgEntryPrice;
    const currentValue = numShares * currentPrice;
    const unrealizedPL = currentValue - entryValue;
    const unrealizedPLPct = (unrealizedPL / entryValue) * 100;
    const exitPrice = currentPrice;
    const lockedProfit = exitPrice;

    prompt += `Already in position: ${pos.side} side
- Orders Placed: ${pos.ordersPlaced}
- Total Spent: $${pos.totalSpent.toFixed(2)} (entry)
- Avg Entry Price: ${(pos.avgEntryPrice * 100).toFixed(1)}¢
- Current Market Price: ${(currentPrice * 100).toFixed(1)}¢
- Shares Held: ~${numShares.toFixed(0)} shares
- Current Value: $${currentValue.toFixed(2)}
- Unrealized P/L: ${unrealizedPL >= 0 ? '+' : ''}$${unrealizedPL.toFixed(2)} (${unrealizedPLPct >= 0 ? '+' : ''}${unrealizedPLPct.toFixed(1)}%)
- If SELL now @ ${(exitPrice * 100).toFixed(1)}¢: Lock in ${unrealizedPL >= 0 ? 'PROFIT' : 'LOSS'} of ${unrealizedPL >= 0 ? '+' : ''}$${unrealizedPL.toFixed(2)}

Decision Options:
1. HOLD: Keep position, outcome at window close
2. SELL: Exit 100% (buy opposite side to lock P/L)
3. PARTIAL_SELL: Exit 50-75% (reduce exposure, let some ride)
4. ADD: Increase position if thesis strengthened
`;
  } else {
    prompt += `No position yet in this window
- Available Budget: $${pos.budgetRemaining.toFixed(2)}

Decision: ENTER if edge exists, or SKIP if no clear thesis
`;
  }

  prompt += `\n## YOUR TASK: MAKE A TRADING DECISION

Analyze this data with your world-class experience. Consider:

1. Delta Persistence: Will the delta persist for the next ${data.window.timeLeft}s?
2. Order Flow Confirmation: Does order flow support or contradict delta?
3. Momentum Alignment: Does momentum support your thesis?
4. Edge Quality: Is the market price offering asymmetric edge?
5. Risk/Reward: Is this trade worth your capital?

Return JSON ONLY (no markdown, no explanation):
{
  "decision": "ENTER" | "ADD" | "SKIP" | "SELL" | "PARTIAL_SELL",
  "side": "YES" | "NO" | null,
  "confidence": 0.50-1.00,
  "positionSize": 0.05-0.15,
  "sellPercentage": 0.0-1.0,
  "maxPrice": 0.00-1.00,
  "rationale": "Explain your thesis with specific data",
  "riskFactors": ["Primary risk", "Secondary risk"],
  "stopLoss": "Condition that would invalidate thesis",
  "urgency": "low" | "medium" | "high"
}

CRITICAL GUIDELINES:
- Confidence < 0.55: SKIP (below breakeven)
- Confidence 0.55-0.65: Small (5-8% position)
- Confidence 0.65-0.75: Medium (8-12% position)
- Confidence > 0.75: Large (12-15% position)
- maxPrice should include 2-3¢ slippage buffer
- SKIP if order flow contradicts delta OR no clear edge

SELL GUIDELINES:
- SELL if: Nailbiter (<$30 delta) with <180s left, lock profit/cut loss
- SELL if: Thesis invalidated (delta reversed, order flow flipped)
- PARTIAL_SELL (0.5-0.75) if: Uncertain but want to reduce risk
- HOLD if: High confidence outcome or too early to exit
- sellPercentage: 0.5 = sell 50%, 0.75 = sell 75%, 1.0 = sell 100%`;

  return prompt;
}

/**
 * Parse Kimi's JSON response
 */
function parseWindowDecisionResponse(content, usage) {
  try {
    const parsed = JSON.parse(content);

    return {
      decision: parsed.decision || 'SKIP',
      side: parsed.side || null,
      confidence: parseFloat(parsed.confidence) || 0.5,
      positionSize: parseFloat(parsed.positionSize) || 0.05,
      sellPercentage: parseFloat(parsed.sellPercentage) || 1.0, // Default 100% sell
      maxPrice: parseFloat(parsed.maxPrice) || 0.50,
      rationale: parsed.rationale || 'No rationale provided',
      riskFactors: parsed.riskFactors || [],
      stopLoss: parsed.stopLoss || 'None specified',
      urgency: parsed.urgency || 'low',
      usage: usage
    };
  } catch (error) {
    console.warn(JSON.stringify({
      action: 'WINDOW_DECISION_PARSE_ERROR',
      error: error.message
    }));
    return {
      decision: 'SKIP',
      side: null,
      confidence: 0.3,
      positionSize: 0,
      sellPercentage: 1.0,
      maxPrice: 0,
      rationale: 'Parse error - defaulting to SKIP for safety',
      riskFactors: ['JSON parse error'],
      stopLoss: 'N/A',
      urgency: 'low'
    };
  }
}

/**
 * Conduct window-level trading decision with world-class trader AI
 * Main entry point called by trading bot
 */
async function conductWindowDecision(decisionData) {
  const prompt = buildWindowDecisionPrompt(decisionData);

  const messages = [
    {
      role: 'system',
      content: WORLD_CLASS_TRADER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_KIMI_WINDOW_DECISION',
    window: decisionData.window.slug,
    timeLeft: decisionData.window.timeLeft,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    // Fallback if LLM unavailable
    console.warn(JSON.stringify({
      action: 'KIMI_UNAVAILABLE',
      fallback: 'SKIP'
    }));
    return {
      decision: 'SKIP',
      side: null,
      confidence: 0.3,
      positionSize: 0,
      maxPrice: 0,
      rationale: 'LLM supervisor unavailable - skip trade for safety',
      riskFactors: ['No AI validation'],
      stopLoss: 'N/A',
      urgency: 'low'
    };
  }

  const decision = parseWindowDecisionResponse(response.content, response.usage);

  console.log(JSON.stringify({
    action: 'KIMI_WINDOW_DECISION',
    decision: decision.decision,
    side: decision.side,
    confidence: decision.confidence,
    positionSize: decision.positionSize,
    maxPrice: decision.maxPrice,
    rationale: decision.rationale,
    urgency: decision.urgency,
    tokensUsed: response.usage ? response.usage.total_tokens : 'N/A',
    timestamp: new Date().toISOString()
  }));

  return decision;
}

/**
 * Conduct Risk Manager review of trader's decision (second opinion)
 * This provides a critical second look with a different personality
 */
async function conductRiskManagerReview(decisionData, traderDecision) {
  const prompt = buildRiskManagerReviewPrompt(decisionData, traderDecision);

  const messages = [
    {
      role: 'system',
      content: RISK_MANAGER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_RISK_MANAGER_REVIEW',
    window: decisionData.window.slug,
    traderDecision: traderDecision.decision,
    traderConfidence: traderDecision.confidence,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    // Fallback: approve trader's decision if risk manager unavailable
    console.warn(JSON.stringify({
      action: 'RISK_MANAGER_UNAVAILABLE',
      fallback: 'APPROVE_TRADER_DECISION'
    }));
    return {
      ...traderDecision,
      approved: true,
      adjustments: 'Risk manager unavailable - approved by default'
    };
  }

  const review = parseRiskManagerResponse(response.content, response.usage);

  console.log(JSON.stringify({
    action: 'RISK_MANAGER_REVIEW',
    approved: review.approved,
    decision: review.decision,
    confidence: review.confidence,
    positionSize: review.positionSize,
    adjustments: review.adjustments,
    tokensUsed: response.usage ? response.usage.total_tokens : 'N/A',
    timestamp: new Date().toISOString()
  }));

  return review;
}

/**
 * Build risk manager review prompt with trader's decision included
 */
function buildRiskManagerReviewPrompt(data, traderDecision) {
  const basePrompt = buildWindowDecisionPrompt(data);

  const reviewPrompt = `${basePrompt}

---

## TRADER'S RECOMMENDATION (FOR YOUR REVIEW)

**Decision**: ${traderDecision.decision}
**Side**: ${traderDecision.side || 'N/A'}
**Confidence**: ${(traderDecision.confidence * 100).toFixed(0)}%
**Position Size**: ${(traderDecision.positionSize * 100).toFixed(1)}% of balance
**Max Price**: ${(traderDecision.maxPrice * 100).toFixed(1)}¢

**Trader's Rationale**:
${traderDecision.rationale}

**Trader's Risk Factors**:
${traderDecision.riskFactors.map(r => `- ${r}`).join('\n')}

**Trader's Stop Loss**: ${traderDecision.stopLoss}

---

## YOUR TASK: RISK MANAGER REVIEW

As the Risk Manager, critically review this recommendation. Consider:

1. **Confidence Calibration**: Is ${(traderDecision.confidence * 100).toFixed(0)}% confidence justified by the data?
2. **Position Sizing**: Is ${(traderDecision.positionSize * 100).toFixed(1)}% appropriate given the edge quality?
3. **Hidden Risks**: What risks did the trader overlook?
4. **Portfolio Context**: Are we over-exposed? On a losing streak?
5. **Trap Detection**: Could this be a false signal?

Return your assessment as JSON with:
- "approved": true/false
- "decision": Your final decision (can override trader)
- "confidence": Your confidence (can adjust down)
- "positionSize": Your position size (can reduce)
- "adjustments": What you changed from trader's recommendation
- All other required fields

If you disagree with the trader, explain why in your rationale.`;

  return reviewPrompt;
}

/**
 * Parse risk manager response (similar to window decision)
 */
function parseRiskManagerResponse(content, usage) {
  try {
    const parsed = JSON.parse(content);

    return {
      approved: parsed.approved !== false,  // Default true if not specified
      decision: parsed.decision || 'SKIP',
      side: parsed.side || null,
      confidence: Math.max(0.5, Math.min(1.0, parsed.confidence || 0.5)),
      positionSize: Math.max(0.05, Math.min(0.15, parsed.positionSize || 0.08)),
      sellPercentage: parsed.sellPercentage || 0,
      maxPrice: Math.max(0, Math.min(1.0, parsed.maxPrice || 0)),
      rationale: parsed.rationale || 'Risk manager review completed',
      adjustments: parsed.adjustments || 'No adjustments made',
      riskFactors: Array.isArray(parsed.riskFactors) ? parsed.riskFactors : ['Unknown risk'],
      stopLoss: parsed.stopLoss || 'Monitor continuously',
      urgency: parsed.urgency || 'medium',
      tokensUsed: usage ? usage.total_tokens : 0
    };
  } catch (error) {
    console.error('Failed to parse risk manager response:', error.message);
    return {
      approved: false,
      decision: 'SKIP',
      side: null,
      confidence: 0.3,
      positionSize: 0,
      maxPrice: 0,
      rationale: 'Failed to parse risk manager response',
      adjustments: 'Parse error - vetoed',
      riskFactors: ['Parse error in risk manager'],
      stopLoss: 'N/A',
      urgency: 'low'
    };
  }
}

// ============================================================
// 5-PLAYER TRADING DESK SYSTEM PROMPTS
// ============================================================

/**
 * Player 1: FARM TRADER (Conservative Institutional + Momentum Continuation)
 * Manages 80% of capital, protects the base, demands 65%+ confidence
 */
const FARM_TRADER_SYSTEM_PROMPT = `You are the FARM TRADER for ASYMMETRIC ALPHA FUND - a conservative institutional trader managing 80% of the fund's capital.

YOUR PHILOSOPHY:
- "Capital preservation first, growth second"
- "Only bet when the house has the edge"
- "Institutions don't gamble" - data-driven, systematic
- "Slow and steady compounds" - target 8-12% monthly returns
- **"Position before the move is obvious"** - front-run momentum continuation

YOUR DECISION FRAMEWORK:

**MODE 1: INSTITUTIONAL SCALPING (New - Be More Active):**
- **"Capital needs to work"** - sitting idle wastes opportunity
- Delta >$50 + confidence >55% = ENTER with smaller position (5-7%)
- Even weak edges compound: 15% gain × 10 trades > 100% × 1 trade
- **Conservative position sizing on weak setups protects downside**
- Target: Trade 60-70% of windows (vs. 20% previously)

**MODE 2: STRONG CONVICTION TRADES (Traditional Farm):**
1. **Delta Persistence**: Will delta hold 10+ minutes?
2. **Order Flow Confirmation**: >10% imbalance confirming delta
3. **Risk/Reward**: Minimum 2:1 edge (e.g., 40¢ for 65%+ confidence)
4. **Historical Win Rate**: Similar setups should have 70%+ win rate
5. **Position Sizing**: 8-12% of Farm balance, never >15%

**MOMENTUM CONTINUATION (Next Window Early Entry):**
When current window shows strong momentum (last 60-120s of window):

EVALUATE MOMENTUM:
1. **Delta Magnitude**: >$150 sustained for >8 minutes?
2. **Direction**: Clear trend (not choppy back-and-forth)?
3. **Delta Velocity**: Accelerating or stable (not decelerating)?
4. **Order Flow**: Confirms move (not diverging)?
5. **Continuation Confidence**: 75%+ that momentum persists into next window?

IF YES → Place EARLY bet on next window at market price (~50¢):
- **The Edge = Timing, not Price**: 50¢ now beats 75¢ in 3 minutes
- **Position Size**: 5-8% of Farm balance
- **Rationale**: "Front-running obvious momentum continuation"
- **This is institutional thinking**: Be early, not cheap

MOMENTUM CONTINUATION TRIGGERS:
- Delta >$150 for >8 minutes (strong)
- Delta >$200 for >5 minutes (explosive)
- RSI not extreme (<30 or >70 - room to run)
- Order flow confirms (>12% imbalance supporting move)
- Farm capital >$25 available

BE MORE ACTIVE - ONLY SKIP IF:
- Confidence <55% (lowered from 65%)
- Order flow strongly contradicts delta (>15% divergence)
- Price >55¢ (lowered from 50¢ - give more room)
- On 3+ loss streak
- Farm capital <$30 available

POSITION SIZING (Current Window):
- **55-60% confidence (weak edge scalp)**: 5% of Farm balance (~$1.90)
- **60-65% confidence (moderate edge)**: 7% of Farm balance (~$2.70)
- 65-70% confidence: 8% of Farm balance
- 70-75% confidence: 10% of Farm balance
- 75-80% confidence: 12% of Farm balance
- 80%+ confidence: 15% of Farm balance (RARE)

POSITION SIZING (Momentum Continuation):
- 75-80% confidence: 5% of Farm balance
- 80-85% confidence: 6% of Farm balance
- 85%+ confidence: 8% of Farm balance

CRITICAL: Return ONLY valid JSON:
{
  "decision": "ENTER" | "SKIP" | "MOMENTUM_CONTINUATION",
  "side": "YES" | "NO" | null,
  "confidence": 0.65-1.00,
  "positionSize": 0.05-0.15,
  "maxPrice": 0.00-0.55,
  "rationale": "Institutional analysis with specific data points",
  "riskFactors": ["risk 1", "risk 2"],
  "stopLoss": "Condition that would invalidate thesis",
  "capitalProtection": "How we protect downside",
  "momentumContinuation": true | false,
  "nextWindowBet": true | false
}`;

/**
 * Player 2: FARM RISK MANAGER (Paranoid Capital Protector + Momentum Clip Enforcer)
 * Protects Farm capital, challenges Farm Trader, vetoes bad trades
 */
const FARM_RISK_MANAGER_SYSTEM_PROMPT = `You are the FARM RISK MANAGER for ASYMMETRIC ALPHA FUND - protecting the 80% Farm capital allocation.

YOUR PHILOSOPHY:
- "No trade is worth blowing up"
- "Question everything" - assume trader overconfident
- "Risk first, return second"
- "The best trade is the one you don't make"
- **"Clip momentum continuation bets immediately"** - they're scalps, not holds

YOUR FRAMEWORK:

**FOR CURRENT WINDOW TRADES:**
1. **Confidence Calibration**: Is trader inflated? Reduce 5-10% if needed
2. **Position Sizing Check**: Weak edge scalps (5-7%) are acceptable for 55-60% confidence
3. **Portfolio Heat Check**: 2+ open positions? Too much exposure?
4. **Trap Detection**: Bull/bear trap? What's smart money doing?
5. **Historical Calibration**: Did we actually win at this confidence level?
6. **Downside Protection**: On weak scalps (5%), max loss is <2% of fund - acceptable

**APPROVE WEAK EDGE SCALPS (NEW):**
- 55-60% confidence + 5-7% position + delta >$50 → APPROVE (institutional scalping)
- Small positions = low risk, high volume strategy
- 15% gain on 5% position = 0.75% fund gain (repeatable)

**FOR MOMENTUM CONTINUATION BETS:**
1. **Momentum Quality Check**: Is momentum REAL or just noise?
   - Delta >$150 for >8 min = REAL
   - Delta $80-150 choppy = NOISE → VETO
2. **Capital Protection**: Do we have >$25 available? Farm balance healthy?
3. **Max Frequency**: Only 1 momentum bet per 5 windows (no spam)
4. **Auto-Clip Requirement**: MUST sell when next window opens (first 60-120s)
   - If profit >10%: SELL immediately
   - If flat (±5%): SELL, momentum didn't continue
   - If loss >10%: SELL, cut loss fast
   - **NEVER hold momentum bets to settlement** - they're timing plays

MOMENTUM CONTINUATION APPROVAL CRITERIA:
- Approve if:
  * Delta >$150 sustained >8 min
  * Order flow confirms (>12% imbalance)
  * Farm capital >$25 available
  * Not on 3+ loss streak
  * Max 1 continuation bet per 5 windows
- Reduce size if:
  * Momentum strong but not explosive: 8% → 5%
  * Farm capital $25-30: 6% → 5%
- Veto if:
  * Delta <$150 (weak momentum)
  * Momentum choppy/decelerating
  * Farm capital <$25
  * Already placed continuation bet in last 4 windows

OVERRIDE TRIGGERS (Current Window):
- Confidence inflated → reduce by 5-10%
- Position too large → reduce (15% → 10%)
- On 3+ loss streak → cut size in HALF
- Order flow contradicts delta → VETO (trap)
- Portfolio >40% exposure → VETO or reduce to 5%

ADJUSTMENTS YOU MAKE:
- Reduce position size
- Lower confidence
- Add stricter stop-loss
- Recommend partial position (50% now, 50% later)
- **Enforce auto-clip on momentum continuation bets**

AUTO-VETO WHEN:
- Confidence <55% (lowered to allow weak edge scalps)
- Order flow strongly contradicts (>15% imbalance against)
- On 3+ loss streak AND confidence <65% (lowered)
- Price >55¢ AND confidence <70% (price + conviction check)
- Portfolio has 4+ open positions
- **DO NOT VETO weak edge scalps**: 55-60% confidence + 5-7% position + delta >$50 are APPROVED

CRITICAL: Return ONLY valid JSON:
{
  "approved": true | false,
  "decision": "ENTER" | "SKIP" | "MOMENTUM_CONTINUATION",
  "side": "YES" | "NO" | null,
  "confidence": 0.60-1.00,
  "positionSize": 0.05-0.15,
  "maxPrice": 0.00-0.55,
  "adjustments": "What you changed from trader's recommendation",
  "rationale": "Risk assessment and capital protection reasoning",
  "riskFactors": ["risk 1", "risk 2", "risk 3"],
  "stopLoss": "Condition that would invalidate thesis",
  "momentumContinuation": true | false,
  "autoClip": true | false,
  "clipWindow": "first_60_120s" | null
}`;

/**
 * Player 3: DEGEN TRADER (Asymmetric Edge Hunter + Prolific Clipper)
 * Manages 20% capital, hunts lotto tickets, aggressive opportunities, clips profits
 */
const DEGEN_TRADER_SYSTEM_PROMPT = `You are the DEGEN TRADER for ASYMMETRIC ALPHA FUND - managing 20% capital, hunting asymmetric edges and ACTIVELY CLIPPING PROFITS.

YOUR TRIPLE STRATEGY:

**MODE 1: EARLY-ENTRY SCALPING - BE ACTIVE, CLIP OFTEN**
- **"Buy early, sell quick"** - even weak deltas create clipping opportunities
- Window opens at ~50¢ → Enter 15-25% even if delta only $20-50
- Target: Clip at 55-65¢ for 10-30% profit in <5 minutes
- High volume beats big wins - trade EVERY window if any edge exists
- **ENTER if**: Confidence >45%, any positive delta, price 45-55¢
- **CLIP if**: Up >15% in first 5 min, lock profit and move on
- **Market-making mindset**: Provide liquidity, take spread, repeat

**MODE 2: MOMENTUM SCALPS - BIGGER POSITIONS**
- Strong delta (>$100) → Enter 30-40%, clip at +50-100%
- Buy @ 35¢ → Hits 70¢ in 5 min → SELL immediately (lock +100%)
- Buy @ 25¢ → Hits 55¢ → PARTIAL_SELL 75% (lock gains, let some ride)
- Trade momentum, volatility, mispricing
- **If unrealized profit >50% → SELL/PARTIAL_SELL**

**MODE 3: LOTTO TICKETS - LET THEM RIDE**
- Price <10¢, $1-2 bets with **high conviction on extreme mispricing**
- These are NOT gambles - conviction plays on asymmetric payoffs
- Small exposure means you can afford to lose
- **NEVER clip lotto tickets** - let them ride to settlement for full 10:1+ payout
- Don't sell at 5¢ → 30¢, let it expire worthless or pay $1.00

YOUR DECISION FRAMEWORK:
1. **Early-Entry Scalp**: Delta >$0, confidence >45%, price 45-55¢ → ENTER 15-25%, plan to clip at +15-30%
2. **Lotto Ticket Detection**: Price <10¢? Throw $1-2 if high conviction (50-55%+ confidence)
3. **Momentum Scalps**: Strong delta (>$100) + volatility → Enter 30-40%, clip at +50-100%
4. **Overlooked Edge**: Farm skipped = maybe mispriced for Degen
5. **Profit-Taking**: Already in position + up >15%? → SELL/PARTIAL_SELL

POSITION SIZING:
- **Lotto tickets (price <10¢)**: $1-2 flat, let ride to settlement
- **Early-entry scalps (weak delta, 45-55¢)**: 15-25% of balance, clip at +15-30%
- **Momentum scalps (strong delta >$100)**: 30-40% of balance, clip at +50-100%
- **High conviction (70%+, <20¢)**: 35-40% - YOLO, but clip at +75%

EXIT LOGIC FOR REGULAR TRADES (NOT LOTTO TICKETS):
- **SELL if**: Unrealized profit >100% (double your money, take it)
- **PARTIAL_SELL 75% if**: Unrealized profit 50-100% (lock most, let some ride)
- **PARTIAL_SELL 50% if**: Unrealized profit 15-50% on early scalp (lock gains, repeat)
- **HOLD if**: High conviction still strong OR it's a lotto ticket

BE AGGRESSIVE - DON'T SKIP:
- **ENTER on weak setups**: Even $20 delta + 47% confidence = 15% scalp opportunity
- **Trade volume over precision**: 10 trades at +15-30% > 1 trade at +100%
- **Only SKIP if**:
  - Price >60¢ (no edge)
  - Confidence <45%
  - On 5+ loss streak
  - Degen balance <$3 (need refuel)

CRITICAL: Return ONLY valid JSON:
{
  "decision": "ENTER" | "SKIP" | "SELL" | "PARTIAL_SELL",
  "side": "YES" | "NO" | null,
  "confidence": 0.50-1.00,
  "positionSize": 0.15-0.40,
  "sellPercentage": 0.0-1.0,
  "maxPrice": 0.00-0.60,
  "rationale": "Asymmetric edge analysis or profit-taking reasoning",
  "riskFactors": ["risk 1", "risk 2"],
  "lottoTicket": true | false,
  "payoffRatio": number,
  "stopLoss": "Condition that would invalidate thesis or 'Lock profit at +X%'"
}`;

/**
 * Player 4: DEGEN RISK MANAGER (Math Checker + Profit Enforcer)
 * Checks Degen's math, enforces profit-taking on regular trades, protects lotto tickets
 */
const DEGEN_RISK_MANAGER_SYSTEM_PROMPT = `You are the DEGEN RISK MANAGER for ASYMMETRIC ALPHA FUND - checking Degen's math and ENFORCING profit-taking discipline.

YOUR PHILOSOPHY:
- "Steel sharpens steel" - challenge math, make Degen better
- **"Clip profits religiously"** - on regular trades, lock gains at +50-100%
- **"Lotto tickets are sacred"** - NEVER clip lotto tickets, let them ride
- "Don't be the fun police" - approve aggressive bets if math checks

YOUR DUAL FRAMEWORK:

**FOR REGULAR TRADES (NOT lotto tickets):**
1. **Entry Check**: Is payoff ratio real? Confidence × payoff > 1.5?
2. **Position Sizing**: Appropriate for confidence and bankroll?
3. **Profit-Taking Enforcement**: If unrealized profit >50% → RECOMMEND SELL/PARTIAL_SELL
   - Up 50-75%: PARTIAL_SELL 50%
   - Up 75-100%: PARTIAL_SELL 75%
   - Up >100%: SELL 100% (lock it, find next trade)
4. **Bankroll Protection**: Balance >$3? Position won't blow up account?

**FOR LOTTO TICKETS (<10¢, $1-2 bets):**
1. **ALWAYS APPROVE if**: Price <10¢, bet $1-2, confidence >50%
2. **NEVER CLIP**: Let lotto tickets ride to settlement (full 10:1+ payout or expire)
3. **Small Bet Enforcement**: If Degen trying $3+ on lotto, reduce to $1-2
4. **High Conviction Only**: Lotto tickets must have conviction rationale, not random

APPROVE WHEN:
- **Lotto tickets**: Price <10¢, bet $1-2, conviction-based → ALWAYS APPROVE
- **Early-entry scalps**: 15-25% size, confidence >45%, price 45-55¢ → APPROVE (low risk, high volume strategy)
- **Momentum scalps**: 30-40% size, good EV, bankroll healthy → APPROVE
- **Profit-taking**: SELL/PARTIAL_SELL on gains >15% → APPROVE IMMEDIATELY (lock profits, move on)

ADJUST WHEN:
- Position too large: 40% → 30% if bankroll <$5
- Confidence inflated: Reduce 5-10%
- Lotto too big: $3 → $1.50 if balance <$6
- **Missing profit-taking**: Degen HOLD on +75% → Change to PARTIAL_SELL 75%

VETO WHEN (RARE):
- **Bankroll catastrophic**: <$2 and bet drops below $1 → VETO, wait for refuel
- **No edge**: >50¢ with <60% confidence
- **Math fails**: Confidence × payoff < 1.2 (negative EV)
- **Emotional chasing**: 5+ loss streak AND 40% at 55% → VETO
- **Clipping lotto ticket**: Degen trying to SELL lotto @ 30¢ → VETO, let it ride

BANKROLL ALERTS:
- $6-8: Healthy, approve normal sizing
- $4-6: Caution, reduce max to 30%
- $2-4: Critical, reduce max to 20%, flag Supervisor for refuel
- <$2: EMERGENCY, veto all except lotto <$1

CRITICAL: Return ONLY valid JSON:
{
  "approved": true | false,
  "decision": "ENTER" | "SKIP" | "SELL" | "PARTIAL_SELL",
  "side": "YES" | "NO" | null,
  "confidence": 0.50-1.00,
  "positionSize": 0.10-0.40,
  "sellPercentage": 0.0-1.0,
  "maxPrice": 0.00-0.60,
  "adjustments": "What you changed from Degen Trader's recommendation",
  "rationale": "Math check, profit-taking enforcement, or lotto ticket approval",
  "riskFactors": ["risk 1", "risk 2"],
  "lottoTicket": true | false,
  "bankrollStatus": "healthy" | "caution" | "critical" | "emergency",
  "stopLoss": "Condition that would invalidate thesis or profit target"
}`;

/**
 * Player 5: SUPERVISOR (Meta-Analyst, Budget Manager, Final Authority)
 * Arbitrates conflicts, manages capital allocation, issues final trading orders
 */
const SUPERVISOR_SYSTEM_PROMPT = `You are the SUPERVISOR for ASYMMETRIC ALPHA FUND - final authority, meta-analyst, capital allocator.

YOUR PHILOSOPHY:
- "Two perspectives > one" - Farm and Degen see different edges
- "Let winners run, refuel losers" - Degen wins → Farm gets 70%, loses → Farm refuels
- "Diversification within limits" - both desks can trade IF theses don't conflict
- "Meta-analysis beats desk bias" - see patterns desks miss

DECISION SCENARIOS:

**SCENARIO 1: Both Same Side**
- Approve BOTH if:
  * Theses complementary (Farm: institutional, Degen: asymmetric)
  * Combined <50% fund exposure
  * Prices different (Farm 40¢, Degen 25¢ = DCA)
- Approve ONE if:
  * Theses conflict
  * Approve higher confidence
- Modify BOTH:
  * Reduce if combined >50%
  * Stagger timing (Farm now, Degen waits 2 min)

**SCENARIO 2: Opposite Sides (CONFLICT)**
- Approve Farm if confidence >70% (trust institutional)
- Approve Degen if lotto ticket (<10¢, small bet)
- Approve BOTH if Farm hedging + Degen speculating (rare)
- Approve NEITHER if uncertain (SKIP, preserve capital)

**SCENARIO 3: Farm SKIP, Degen ENTER**
- Approve Degen if:
  * Lotto ticket (price <10¢, $1-2)
  * Asymmetric >8:1 and Degen balance >$4
  * Farm skipped conservatively, not red flags
- Veto Degen if:
  * Farm flagged trap/divergence
  * Degen balance <$3
  * 5+ combined loss streak

**SCENARIO 4: Farm ENTER, Degen SKIP**
- Approve Farm (institutional edge sufficient)
- Monitor if Degen balance <$3 → flag refuel

**SCENARIO 5: Both SKIP**
- SKIP (no edge)

REBALANCING POLICY:
- **Degen wins big (+$10)**: Transfer 70% to Farm, Degen keeps 30%
- **Degen loses big (-$5)**: Farm refuels Degen to minimum
- **Farm wins**: Reinvest (grows 80%)
- **Farm loses**: Reduce sizing next trade

CRITICAL: Return ONLY valid JSON:
{
  "farmApproved": true | false,
  "degenApproved": true | false,
  "finalPlan": {
    "farm": {
      "side": "YES" | "NO" | null,
      "amount": number,
      "maxPrice": number
    },
    "degen": {
      "side": "YES" | "NO" | null,
      "amount": number,
      "maxPrice": number,
      "lottoTicket": true | false
    }
  },
  "rebalancing": [
    {
      "fromDesk": "FARM" | "DEGEN",
      "toDesk": "FARM" | "DEGEN",
      "amount": number,
      "type": "string",
      "reason": "string"
    }
  ],
  "rationale": "Meta-analysis and final decision reasoning",
  "riskFactors": ["combined risk 1", "combined risk 2"]
}`;

// ============================================================
// 5-PLAYER CONDUCT FUNCTIONS
// ============================================================

/**
 * Build market data prompt (shared by all players)
 */
function buildMarketDataPrompt(marketData, farmBalance, degenBalance) {
  const wp = marketData.windowPrice;
  const mp = marketData.marketPrices;
  const of = marketData.orderFlow;
  const tech = marketData.technicals;

  let prompt = `# 15-Minute BTC Window Trading Decision

## WINDOW FUNDAMENTALS
- Window: ${marketData.window.slug}
- Time Remaining: ${marketData.window.timeLeft}s

## VIRTUAL ACCOUNT BALANCES
- Farm Desk (80%): $${farmBalance.toFixed(2)}
- Degen Desk (20%): $${degenBalance.toFixed(2)}

## WINDOW OPENING PRICE
`;

  if (wp) {
    prompt += `Opening Price: $${wp.openPrice.toFixed(2)}
Current BTC Price: $${wp.currentPrice.toFixed(2)}
Delta: ${wp.delta >= 0 ? '+' : ''}$${wp.delta.toFixed(2)} (${wp.deltaPct >= 0 ? '+' : ''}${wp.deltaPct.toFixed(3)}%)

Settlement Logic:
- YES wins if BTC closes >= $${wp.openPrice.toFixed(2)}
- NO wins if BTC closes < $${wp.openPrice.toFixed(2)}
- Current delta: ${wp.delta >= 0 ? 'POSITIVE (favors YES)' : 'NEGATIVE (favors NO)'}

`;
  } else {
    prompt += `⚠️ Window price data unavailable (early in window)\n\n`;
  }

  prompt += `## MARKET PRICES (POLYMARKET)
- YES: ${(mp.yesPrice * 100).toFixed(1)}¢
- NO: ${(mp.noPrice * 100).toFixed(1)}¢
- Spread: ${mp.spread}

Edge Analysis:
- If YES wins: Pay ${(mp.yesPrice * 100).toFixed(1)}¢, win 100¢ = ${((1 / mp.yesPrice) - 1).toFixed(2)}x return
- If NO wins: Pay ${(mp.noPrice * 100).toFixed(1)}¢, win 100¢ = ${((1 / mp.noPrice) - 1).toFixed(2)}x return
`;

  prompt += `\n## ORDER FLOW & LIQUIDITY\n`;
  if (of.available) {
    prompt += `YES Token:
- Bid Volume: $${of.yes.bidVolume} | Ask Volume: $${of.yes.askVolume}
- Imbalance: ${of.yes.imbalanceFormatted} (${of.yes.signal})
- Spread: ${of.yes.spread} | Depth: ${of.yes.depth}

NO Token:
- Bid Volume: $${of.no.bidVolume} | Ask Volume: $${of.no.askVolume}
- Imbalance: ${of.no.imbalanceFormatted} (${of.no.signal})
- Spread: ${of.no.spread} | Depth: ${of.no.depth}

Interpretation: ${of.interpretation}
`;
  } else {
    prompt += `⚠️ Order book data unavailable: ${of.reason}\n`;
  }

  prompt += `\n## TECHNICAL INDICATORS

RSI (14-period): ${tech.rsi.value} - ${tech.rsi.signal}
- ${tech.rsi.interpretation}

Momentum:
- Short-term: ${tech.momentum.short.direction} (${tech.momentum.short.change})
- Medium-term: ${tech.momentum.medium.direction} (${tech.momentum.medium.change})
- Regime: ${tech.momentum.regime}

Volatility: ${tech.volatility.recent} - ${tech.volatility.trend}
- ${tech.volatility.interpretation}

Delta Velocity: $${tech.deltaVelocity.value}/min
- ${tech.deltaVelocity.interpretation}
`;

  return prompt;
}

/**
 * Conduct Farm Trader Decision (Player 1)
 */
async function conductFarmTraderDecision(marketData, farmBalance) {
  const prompt = buildMarketDataPrompt(marketData, farmBalance, 0) + `

## YOUR TASK: FARM TRADER DECISION

Analyze this data with your conservative institutional approach. Make a decision for the FARM desk.

Return JSON ONLY (no markdown, no explanation).`;

  const messages = [
    {
      role: 'system',
      content: FARM_TRADER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_FARM_TRADER',
    window: marketData.window.slug,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      decision: 'SKIP',
      side: null,
      confidence: 0.00,
      positionSize: 0.00,
      maxPrice: 0.00,
      rationale: 'Farm Trader LLM unavailable',
      riskFactors: [],
      stopLoss: 'N/A',
      capitalProtection: 'N/A'
    };
  }

  try {
    const parsed = JSON.parse(response.content);
    return {
      decision: parsed.decision || 'SKIP',
      side: parsed.side || null,
      confidence: parsed.confidence || 0.00,
      positionSize: parsed.positionSize || 0.00,
      maxPrice: parsed.maxPrice || 0.00,
      rationale: parsed.rationale || '',
      riskFactors: parsed.riskFactors || [],
      stopLoss: parsed.stopLoss || '',
      capitalProtection: parsed.capitalProtection || '',
      tokensUsed: response.usage ? response.usage.total_tokens : 0
    };
  } catch (error) {
    return {
      decision: 'SKIP',
      side: null,
      confidence: 0.00,
      positionSize: 0.00,
      maxPrice: 0.00,
      rationale: 'Parse error',
      riskFactors: [],
      stopLoss: 'N/A',
      capitalProtection: 'N/A'
    };
  }
}

/**
 * Conduct Farm Risk Manager Review (Player 2)
 */
async function conductFarmRiskManagerReview(marketData, farmBalance, farmTraderDecision) {
  const basePrompt = buildMarketDataPrompt(marketData, farmBalance, 0);

  const prompt = `${basePrompt}

## FARM TRADER'S RECOMMENDATION (FOR YOUR REVIEW)

**Decision**: ${farmTraderDecision.decision}
**Side**: ${farmTraderDecision.side || 'N/A'}
**Confidence**: ${(farmTraderDecision.confidence * 100).toFixed(0)}%
**Position Size**: ${(farmTraderDecision.positionSize * 100).toFixed(1)}% of Farm balance
**Max Price**: ${(farmTraderDecision.maxPrice * 100).toFixed(1)}¢

**Trader's Rationale**:
${farmTraderDecision.rationale}

**Trader's Risk Factors**:
${farmTraderDecision.riskFactors.map(r => `- ${r}`).join('\n')}

## YOUR TASK: FARM RISK MANAGER REVIEW

Review the Farm Trader's recommendation. Challenge, adjust, or approve.

Return JSON ONLY (no markdown, no explanation).`;

  const messages = [
    {
      role: 'system',
      content: FARM_RISK_MANAGER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_FARM_RISK_MANAGER',
    window: marketData.window.slug,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      ...farmTraderDecision,
      approved: true,
      adjustments: 'Farm RM unavailable - approved by default'
    };
  }

  try {
    const parsed = JSON.parse(response.content);
    return {
      approved: parsed.approved !== false,
      decision: parsed.decision || 'SKIP',
      side: parsed.side || null,
      confidence: parsed.confidence || 0.00,
      positionSize: parsed.positionSize || 0.00,
      maxPrice: parsed.maxPrice || 0.00,
      adjustments: parsed.adjustments || '',
      rationale: parsed.rationale || '',
      riskFactors: parsed.riskFactors || [],
      stopLoss: parsed.stopLoss || '',
      tokensUsed: response.usage ? response.usage.total_tokens : 0
    };
  } catch (error) {
    return {
      ...farmTraderDecision,
      approved: false,
      adjustments: 'Parse error - vetoed for safety'
    };
  }
}

/**
 * Conduct Degen Trader Decision (Player 3)
 */
async function conductDegenTraderDecision(marketData, degenBalance, farmDecision) {
  const prompt = buildMarketDataPrompt(marketData, 0, degenBalance) + `

## FARM DESK DECISION (FOR YOUR CONTEXT)

**Farm Decision**: ${farmDecision.decision}
**Farm Side**: ${farmDecision.side || 'N/A'}
**Farm Confidence**: ${(farmDecision.confidence * 100).toFixed(0)}%
**Farm Rationale**: ${farmDecision.rationale}

## YOUR TASK: DEGEN TRADER DECISION

You've seen what the conservative Farm desk decided. Now hunt for asymmetric edges and lotto tickets.

**LOTTO TICKET REMINDER**: If price <10¢, consider $1-2 bet even at 50-55% confidence (10:1+ payoff).

Return JSON ONLY (no markdown, no explanation).`;

  const messages = [
    {
      role: 'system',
      content: DEGEN_TRADER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_DEGEN_TRADER',
    window: marketData.window.slug,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      decision: 'SKIP',
      side: null,
      confidence: 0.00,
      positionSize: 0.00,
      maxPrice: 0.00,
      rationale: 'Degen Trader LLM unavailable',
      riskFactors: [],
      lottoTicket: false,
      payoffRatio: 0.00,
      stopLoss: 'N/A'
    };
  }

  try {
    const parsed = JSON.parse(response.content);
    return {
      decision: parsed.decision || 'SKIP',
      side: parsed.side || null,
      confidence: parsed.confidence || 0.00,
      positionSize: parsed.positionSize || 0.00,
      maxPrice: parsed.maxPrice || 0.00,
      rationale: parsed.rationale || '',
      riskFactors: parsed.riskFactors || [],
      lottoTicket: parsed.lottoTicket || false,
      payoffRatio: parsed.payoffRatio || 0.00,
      stopLoss: parsed.stopLoss || '',
      tokensUsed: response.usage ? response.usage.total_tokens : 0
    };
  } catch (error) {
    return {
      decision: 'SKIP',
      side: null,
      confidence: 0.00,
      positionSize: 0.00,
      maxPrice: 0.00,
      rationale: 'Parse error',
      riskFactors: [],
      lottoTicket: false,
      payoffRatio: 0.00,
      stopLoss: 'N/A'
    };
  }
}

/**
 * Conduct Degen Risk Manager Review (Player 4)
 */
async function conductDegenRiskManagerReview(marketData, degenBalance, degenTraderDecision) {
  const basePrompt = buildMarketDataPrompt(marketData, 0, degenBalance);

  const prompt = `${basePrompt}

## DEGEN TRADER'S RECOMMENDATION (FOR YOUR REVIEW)

**Decision**: ${degenTraderDecision.decision}
**Side**: ${degenTraderDecision.side || 'N/A'}
**Confidence**: ${(degenTraderDecision.confidence * 100).toFixed(0)}%
**Position Size**: ${(degenTraderDecision.positionSize * 100).toFixed(1)}% of Degen balance
**Max Price**: ${(degenTraderDecision.maxPrice * 100).toFixed(1)}¢
**Lotto Ticket**: ${degenTraderDecision.lottoTicket}
**Payoff Ratio**: ${degenTraderDecision.payoffRatio.toFixed(2)}:1

**Trader's Rationale**:
${degenTraderDecision.rationale}

**Trader's Risk Factors**:
${degenTraderDecision.riskFactors.map(r => `- ${r}`).join('\n')}

## YOUR TASK: DEGEN RISK MANAGER REVIEW

Check the math. Ensure +EV. Don't be the fun police, but catch reckless plays.

**Current Degen Balance**: $${degenBalance.toFixed(2)}
- If >$6: Healthy
- If $4-6: Caution
- If $2-4: Critical
- If <$2: Emergency

Return JSON ONLY (no markdown, no explanation).`;

  const messages = [
    {
      role: 'system',
      content: DEGEN_RISK_MANAGER_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_DEGEN_RISK_MANAGER',
    window: marketData.window.slug,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      ...degenTraderDecision,
      approved: true,
      adjustments: 'Degen RM unavailable - approved by default',
      bankrollStatus: 'unknown'
    };
  }

  try {
    const parsed = JSON.parse(response.content);
    return {
      approved: parsed.approved !== false,
      decision: parsed.decision || 'SKIP',
      side: parsed.side || null,
      confidence: parsed.confidence || 0.00,
      positionSize: parsed.positionSize || 0.00,
      maxPrice: parsed.maxPrice || 0.00,
      adjustments: parsed.adjustments || '',
      rationale: parsed.rationale || '',
      riskFactors: parsed.riskFactors || [],
      lottoTicket: parsed.lottoTicket || false,
      bankrollStatus: parsed.bankrollStatus || 'unknown',
      stopLoss: parsed.stopLoss || '',
      tokensUsed: response.usage ? response.usage.total_tokens : 0
    };
  } catch (error) {
    return {
      ...degenTraderDecision,
      approved: false,
      adjustments: 'Parse error - vetoed for safety',
      bankrollStatus: 'unknown'
    };
  }
}

/**
 * Conduct Supervisor Arbitration (Player 5)
 */
async function conductSupervisorArbitration(marketData, farmBalance, degenBalance, farmDecision, degenDecision) {
  const basePrompt = buildMarketDataPrompt(marketData, farmBalance, degenBalance);

  const prompt = `${basePrompt}

## FARM DESK FINAL DECISION

**Decision**: ${farmDecision.decision}
**Side**: ${farmDecision.side || 'N/A'}
**Confidence**: ${(farmDecision.confidence * 100).toFixed(0)}%
**Amount**: $${(farmBalance * farmDecision.positionSize).toFixed(2)} (${(farmDecision.positionSize * 100).toFixed(1)}% of Farm)
**Max Price**: ${(farmDecision.maxPrice * 100).toFixed(1)}¢
**Rationale**: ${farmDecision.rationale}

## DEGEN DESK FINAL DECISION

**Decision**: ${degenDecision.decision}
**Side**: ${degenDecision.side || 'N/A'}
**Confidence**: ${(degenDecision.confidence * 100).toFixed(0)}%
**Amount**: $${(degenBalance * degenDecision.positionSize).toFixed(2)} (${(degenDecision.positionSize * 100).toFixed(1)}% of Degen)
**Max Price**: ${(degenDecision.maxPrice * 100).toFixed(1)}¢
**Lotto Ticket**: ${degenDecision.lottoTicket}
**Rationale**: ${degenDecision.rationale}

## YOUR TASK: SUPERVISOR ARBITRATION

Review both desk decisions. Decide:
1. Approve Farm? Approve Degen? Approve BOTH? Approve NEITHER?
2. Any rebalancing needed?

Conflict resolution:
- Same side: Can approve both if complementary
- Opposite sides: Trust higher confidence or approve lotto ticket
- Farm SKIP + Degen ENTER: Approve if lotto ticket or asymmetric edge
- Both SKIP: Approve (no edge)

Return JSON ONLY (no markdown, no explanation).`;

  const messages = [
    {
      role: 'system',
      content: SUPERVISOR_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: prompt
    }
  ];

  console.log(JSON.stringify({
    action: 'CALLING_SUPERVISOR',
    window: marketData.window.slug,
    timestamp: new Date().toISOString()
  }));

  const response = await callMoonshotAPI(messages);

  if (!response) {
    return {
      farmApproved: false,
      degenApproved: false,
      finalPlan: {
        farm: null,
        degen: null
      },
      rebalancing: [],
      rationale: 'Supervisor LLM unavailable - SKIP all for safety',
      riskFactors: []
    };
  }

  try {
    const parsed = JSON.parse(response.content);
    return {
      farmApproved: parsed.farmApproved || false,
      degenApproved: parsed.degenApproved || false,
      finalPlan: parsed.finalPlan || { farm: null, degen: null },
      rebalancing: parsed.rebalancing || [],
      rationale: parsed.rationale || '',
      riskFactors: parsed.riskFactors || [],
      tokensUsed: response.usage ? response.usage.total_tokens : 0
    };
  } catch (error) {
    return {
      farmApproved: false,
      degenApproved: false,
      finalPlan: {
        farm: null,
        degen: null
      },
      rebalancing: [],
      rationale: 'Parse error - SKIP all for safety',
      riskFactors: ['Parse error']
    };
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  conductHourlyReview,
  validateAdjustments,
  conductWindowDecision,
  conductRiskManagerReview,
  callMoonshotAPI,
  // 5-player system
  conductFarmTraderDecision,
  conductFarmRiskManagerReview,
  conductDegenTraderDecision,
  conductDegenRiskManagerReview,
  conductSupervisorArbitration
};
