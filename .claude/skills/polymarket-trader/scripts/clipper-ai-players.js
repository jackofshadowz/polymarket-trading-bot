// ============================================================
// CLIPPER AI PLAYERS
// AI employee prompts and decision logic for Clipper Desk
// ============================================================

const moonshotSupervisor = require('./moonshot-supervisor');
const clipperDeskManager = require('./clipper-desk-manager');
const virtualAccounts = require('./virtual-account-manager');

// ============================================================
// PLAYER 6: CLIPPER TRADER - "Vibes Reader" + Momentum Hunter
// ============================================================

const CLIPPER_TRADER_SYSTEM_PROMPT = `You are the CLIPPER TRADER for ASYMMETRIC ALPHA FUND - managing 15% capital with a STRADDLE + CLIP strategy.

## CORE STRATEGY: PRE-WINDOW STRADDLE
- Buy BOTH YES + NO at 180-120s before window close
- One side wins → start next window with clippable position
- Goal: Clip for 30-125% profit within 5-10 minutes

## YOUR ROLE: VIBES ASSESSMENT

Analyze market volatility to set clip targets:

### HIGH VIBES (Volatile Market):
Indicators:
- Delta >$100 swings within 5 min
- RSI extremes (>70 or <30)
- Order flow imbalance >15%
- Fast price movement (Δ price >10¢ in 2 min)

→ **Clip Targets**: 80-125% profit (e.g., buy @ 50¢, sell @ 90¢-$1.00)
→ **Rationale**: High volatility = big swings = hold for moon shots

### MEDIUM VIBES (Trending Market):
Indicators:
- Delta $50-100, sustained direction
- RSI 60-70 or 30-40
- Order flow imbalance 10-15%
- Steady price movement

→ **Clip Targets**: 50-80% profit
→ **Rationale**: Moderate momentum, clip on strong moves

### LOW VIBES (Choppy Market):
Indicators:
- Delta <$50, oscillating
- RSI 40-60 (neutral)
- Order flow balanced (<10% imbalance)
- Slow, grinding price action

→ **Clip Targets**: 30-50% profit (e.g., buy @ 50¢, sell @ 65-75¢)
→ **Rationale**: Choppy = quick clips, avoid getting chopped

## DECISION OUTPUT

You must return ONLY valid JSON with this structure:

{
  "decision": "VIBES_ONLY" | "MOMENTUM_TRADE",
  "vibesScore": 0.0-1.0,
  "clipTargetLow": 0.30-0.50,
  "clipTargetHigh": 0.80-1.25,
  "marketRegime": "CHOPPY" | "TRENDING" | "EXPLOSIVE",
  "rationale": "Detailed vibes assessment reasoning with specific data points",
  "confidence": 0.50-1.00
}

CRITICAL: Return ONLY the JSON object, no other text.`;

/**
 * Conduct Clipper Trader decision - assess vibes and set clip targets
 * @param {string} windowSlug - Window identifier
 * @param {Object} marketData - Market data with prices, technicals, order flow
 * @param {number} clipperBalance - Current Clipper desk balance
 * @returns {Promise<Object>} Decision object
 */
async function conductClipperTraderDecision(windowSlug, marketData, clipperBalance) {
  try {
    console.log(JSON.stringify({
      action: 'CALLING_CLIPPER_TRADER',
      window: windowSlug,
      clipperBalance: clipperBalance.toFixed(2),
      timestamp: new Date().toISOString()
    }));

    // First, calculate vibes using local algorithm
    const vibesAssessment = clipperDeskManager.assessMarketVibes(marketData);

    // Prepare user prompt with market context
    const userPrompt = `Analyze this market and assess volatility (vibes) to set clip targets:

WINDOW: ${windowSlug}
CLIPPER BALANCE: $${clipperBalance.toFixed(2)}

MARKET DATA:
- BTC Delta: ${marketData.windowPrice ? '$' + marketData.windowPrice.delta.toFixed(2) : 'N/A'}
- YES Price: ${marketData.marketPrices ? (marketData.marketPrices.yesPrice * 100).toFixed(1) + '¢' : 'N/A'}
- NO Price: ${marketData.marketPrices ? (marketData.marketPrices.noPrice * 100).toFixed(1) + '¢' : 'N/A'}
- RSI: ${marketData.technicals && marketData.technicals.rsi ? (typeof marketData.technicals.rsi.value === 'string' ? marketData.technicals.rsi.value : marketData.technicals.rsi.value.toFixed(0)) : 'N/A'}
- Momentum: ${marketData.technicals && marketData.technicals.momentum ? marketData.technicals.momentum.regime : 'N/A'}
- Order Flow YES: ${marketData.orderFlow && marketData.orderFlow.yes ? marketData.orderFlow.yes.imbalanceFormatted : 'N/A'}
- Order Flow NO: ${marketData.orderFlow && marketData.orderFlow.no ? marketData.orderFlow.no.imbalanceFormatted : 'N/A'}

LOCAL VIBES CALCULATION:
- Vibes Score: ${(vibesAssessment.vibesScore * 100).toFixed(0)}%
- Regime: ${vibesAssessment.regime}
- Suggested Targets: ${(vibesAssessment.clipTargetLow * 100).toFixed(0)}-${(vibesAssessment.clipTargetHigh * 100).toFixed(0)}%
- Factors: ${vibesAssessment.factors.join(', ')}

Analyze the market and return your vibes assessment with clip targets.`;

    // Call AI
    const decision = await moonshotSupervisor.conductClipperVibesAssessment(
      CLIPPER_TRADER_SYSTEM_PROMPT,
      userPrompt,
      clipperBalance
    );

    console.log(JSON.stringify({
      action: 'CLIPPER_TRADER_DECISION',
      window: windowSlug,
      vibesScore: decision.vibesScore ? (decision.vibesScore * 100).toFixed(0) + '%' : 'N/A',
      regime: decision.marketRegime,
      clipTargets: decision.clipTargetLow && decision.clipTargetHigh ?
        `${(decision.clipTargetLow * 100).toFixed(0)}-${(decision.clipTargetHigh * 100).toFixed(0)}%` : 'N/A',
      confidence: decision.confidence ? (decision.confidence * 100).toFixed(0) + '%' : 'N/A',
      timestamp: new Date().toISOString()
    }));

    return decision;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CLIPPER_TRADER_ERROR',
      window: windowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));

    // Fallback to local vibes assessment
    const fallbackVibes = clipperDeskManager.assessMarketVibes(marketData);
    return {
      decision: 'VIBES_ONLY',
      vibesScore: fallbackVibes.vibesScore,
      clipTargetLow: fallbackVibes.clipTargetLow,
      clipTargetHigh: fallbackVibes.clipTargetHigh,
      marketRegime: fallbackVibes.regime,
      rationale: 'AI error - using fallback local vibes assessment',
      confidence: 0.50
    };
  }
}

// ============================================================
// PLAYER 7: CLIPPER MONITOR - "Exit Assassin" + Cross-Desk Advisor
// ============================================================

const CLIPPER_MONITOR_SYSTEM_PROMPT = `You are the CLIPPER MONITOR for ASYMMETRIC ALPHA FUND - your job is EXECUTION + CROSS-DESK OVERSIGHT.

## DUAL ROLE

### ROLE 1: CLIPPER POSITION MANAGEMENT

Execute clips when targets hit or emergencies arise.

**CLIP OPTIONS**:
- **FULL_CLIP**: Sell 100% (lock all profit)
- **PARTIAL_CLIP_75**: Sell 75% (lock most, let 25% ride)
- **PARTIAL_CLIP_50**: Sell 50% (take profit, keep exposure)
- **HOLD**: Don't clip yet, target not reached

**EMERGENCY CLIP RULES**:
- Position up >100%: PARTIAL_CLIP_75 (lock profit, let some ride)
- Position up >150%: FULL_CLIP (exit completely, don't get greedy)
- Time <120s + choppy market + profit >15%: FULL_CLIP (avoid reversal)

### ROLE 2: CROSS-DESK ADVISORY

Monitor Farm + Degen positions for huge unrealized gains.

**FORCE CLIP CRITERIA**:
- Farm/Degen position up >100% + <180s remaining: FORCE_CLIP 50%
- Any desk position up >150% anytime: FORCE_CLIP 75%
- Rationale: "Lock guaranteed profit, don't risk reversal"

**NEVER CLIP**:
- Degen lotto tickets (isLottoTicket: true) - let them ride to settlement

## DECISION OUTPUT

You must return ONLY valid JSON with this structure:

{
  "clipperActions": [
    {
      "position": "windowSlug",
      "action": "FULL_CLIP" | "PARTIAL_CLIP_75" | "PARTIAL_CLIP_50" | "HOLD",
      "targetPrice": number,
      "currentPrice": number,
      "gainPercent": number,
      "rationale": "Why clip or hold"
    }
  ],
  "crossDeskAdvisories": [
    {
      "desk": "FARM" | "DEGEN",
      "windowSlug": "string",
      "recommendation": "FORCE_CLIP" | "MONITOR",
      "clipPercentage": 0.50-1.00,
      "urgency": "EMERGENCY" | "HIGH" | "MEDIUM",
      "rationale": "Emergency profit protection reasoning"
    }
  ],
  "vibesConfirmation": "AGREE" | "ADJUST_UP" | "ADJUST_DOWN",
  "vibesRationale": "Agreement or adjustment reasoning"
}

CRITICAL: Return ONLY the JSON object, no other text.`;

/**
 * Conduct Clipper Monitor review - decide on clips and cross-desk oversight
 * @param {string} windowSlug - Window identifier
 * @param {Object} marketData - Market data
 * @param {Object} clipperTraderDecision - Clipper Trader's vibes assessment
 * @param {number} timeLeftInWindow - Time remaining in window (seconds)
 * @returns {Promise<Object>} Review object
 */
async function conductClipperMonitorReview(windowSlug, marketData, clipperTraderDecision, timeLeftInWindow) {
  try {
    console.log(JSON.stringify({
      action: 'CALLING_CLIPPER_MONITOR',
      window: windowSlug,
      timeLeft: timeLeftInWindow,
      timestamp: new Date().toISOString()
    }));

    // Get all open positions
    const clipperPositions = virtualAccounts.getOpenPositions('CLIPPER') || [];
    const farmPositions = virtualAccounts.getOpenPositions('FARM') || [];
    const degenPositions = virtualAccounts.getOpenPositions('DEGEN') || [];

    // Calculate cross-desk advisories
    const crossDeskAdvisories = clipperDeskManager.monitorCrossDeskPositions(
      farmPositions,
      degenPositions,
      marketData.marketPrices || {},
      timeLeftInWindow
    );

    // Prepare user prompt
    const userPrompt = `Review Clipper positions and monitor cross-desk emergencies:

WINDOW: ${windowSlug}
TIME LEFT: ${timeLeftInWindow}s

CLIPPER TRADER VIBES:
- Vibes Score: ${clipperTraderDecision.vibesScore ? (clipperTraderDecision.vibesScore * 100).toFixed(0) + '%' : 'N/A'}
- Regime: ${clipperTraderDecision.marketRegime}
- Clip Targets: ${clipperTraderDecision.clipTargetLow && clipperTraderDecision.clipTargetHigh ?
    `${(clipperTraderDecision.clipTargetLow * 100).toFixed(0)}-${(clipperTraderDecision.clipTargetHigh * 100).toFixed(0)}%` : 'N/A'}

CLIPPER POSITIONS (${clipperPositions.length}):
${clipperPositions.map(p => {
  const currentPrice = p.side === 'YES' ?
    (marketData.marketPrices ? marketData.marketPrices.yesPrice : 0) :
    (marketData.marketPrices ? marketData.marketPrices.noPrice : 0);
  const gainPercent = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(0) : 0;
  return `  - ${p.side} @ ${p.entryPrice.toFixed(3)} → ${currentPrice.toFixed(3)} (${gainPercent}% gain)`;
}).join('\n') || '  (none)'}

FARM POSITIONS (${farmPositions.length}):
${farmPositions.map(p => {
  const currentPrice = p.side === 'YES' ?
    (marketData.marketPrices ? marketData.marketPrices.yesPrice : 0) :
    (marketData.marketPrices ? marketData.marketPrices.noPrice : 0);
  const gainPercent = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(0) : 0;
  return `  - ${p.side} @ ${p.entryPrice.toFixed(3)} → ${currentPrice.toFixed(3)} (${gainPercent}% gain)`;
}).join('\n') || '  (none)'}

DEGEN POSITIONS (${degenPositions.length}):
${degenPositions.map(p => {
  const currentPrice = p.side === 'YES' ?
    (marketData.marketPrices ? marketData.marketPrices.yesPrice : 0) :
    (marketData.marketPrices ? marketData.marketPrices.noPrice : 0);
  const gainPercent = p.entryPrice > 0 ? ((currentPrice - p.entryPrice) / p.entryPrice * 100).toFixed(0) : 0;
  const lottoFlag = p.isLottoTicket ? ' [LOTTO - NEVER CLIP]' : '';
  return `  - ${p.side} @ ${p.entryPrice.toFixed(3)} → ${currentPrice.toFixed(3)} (${gainPercent}% gain)${lottoFlag}`;
}).join('\n') || '  (none)'}

CROSS-DESK EMERGENCIES DETECTED: ${crossDeskAdvisories.length}
${crossDeskAdvisories.map(a =>
  `  - ${a.desk} ${a.side} up ${(a.gainPercent * 100).toFixed(0)}% → ${a.recommendation} ${(a.clipPercentage * 100).toFixed(0)}%`
).join('\n') || '  (none)'}

Decide: Which Clipper positions to clip? Any cross-desk emergency clips needed?`;

    // Call AI
    const review = await moonshotSupervisor.conductCrossDeskEmergencyReview(
      CLIPPER_MONITOR_SYSTEM_PROMPT,
      userPrompt
    );

    console.log(JSON.stringify({
      action: 'CLIPPER_MONITOR_REVIEW',
      window: windowSlug,
      clipperActions: review.clipperActions ? review.clipperActions.length : 0,
      crossDeskAdvisories: review.crossDeskAdvisories ? review.crossDeskAdvisories.length : 0,
      vibesConfirmation: review.vibesConfirmation,
      timestamp: new Date().toISOString()
    }));

    return review;
  } catch (error) {
    console.log(JSON.stringify({
      action: 'CLIPPER_MONITOR_ERROR',
      window: windowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));

    // Fallback: return empty review
    return {
      clipperActions: [],
      crossDeskAdvisories: [],
      vibesConfirmation: 'AGREE',
      vibesRationale: 'AI error - no actions taken'
    };
  }
}

// ============================================================
// MODULE EXPORTS
// ============================================================

module.exports = {
  conductClipperTraderDecision,
  conductClipperMonitorReview,
  CLIPPER_TRADER_SYSTEM_PROMPT,
  CLIPPER_MONITOR_SYSTEM_PROMPT
};
