const virtualAccounts = require('./virtual-account-manager');
const dialogueRecorder = require('./dialogue-recorder');
const leaderboard = require('./leaderboard-tracker');
const moonshotSupervisor = require('./moonshot-supervisor');
const clipperAIPlayers = require('./clipper-ai-players');

// ============================================================
// TRADING DESK ORCHESTRATOR
// Coordinates 7-player trading desk (Farm, Degen, Clipper, Supervisor)
// ============================================================

// ============================================================
// STAGE 1: FARM DESK DELIBERATION
// ============================================================

async function conductFarmDeskDeliberation(windowSlug, marketData, timeLeftInWindow) {
  console.log(JSON.stringify({
    action: 'FARM_DESK_DELIBERATION_STARTED',
    window: windowSlug,
    timeLeft: timeLeftInWindow,
    timestamp: new Date().toISOString()
  }));

  // STEP 1: Farm Trader analyzes market
  const farmTraderDecision = await conductFarmTraderDecision(
    windowSlug,
    marketData,
    timeLeftInWindow
  );

  // Wait 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));

  // STEP 2: Farm Risk Manager reviews
  const farmRiskManagerReview = await conductFarmRiskManagerReview(
    windowSlug,
    marketData,
    farmTraderDecision,
    timeLeftInWindow - 30
  );

  console.log(JSON.stringify({
    action: 'FARM_DESK_DELIBERATION_COMPLETED',
    decision: farmRiskManagerReview.decision,
    confidence: farmRiskManagerReview.confidence,
    timestamp: new Date().toISOString()
  }));

  return farmRiskManagerReview;
}

async function conductFarmTraderDecision(windowSlug, marketData, timeLeftInWindow) {
  const farmBalance = virtualAccounts.getDeskBalance('FARM');

  const decision = await moonshotSupervisor.conductFarmTraderDecision(
    marketData,
    farmBalance
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    1, // stage
    'FARM',
    'FARM_TRADER',
    timeLeftInWindow,
    { marketData, farmBalance },
    decision,
    decision.tokensUsed || 0
  );

  // Update player stats
  const playerStats = {
    decisionsProposed: 1
  };
  if (decision.decision !== 'SKIP') {
    playerStats.decisionsApproved = 0; // Will be updated by RM
    playerStats.avgConfidence = decision.confidence;
  }
  leaderboard.updatePlayerStats('FARM_TRADER', playerStats);

  return decision;
}

async function conductFarmRiskManagerReview(windowSlug, marketData, farmTraderDecision, timeLeftInWindow) {
  const farmBalance = virtualAccounts.getDeskBalance('FARM');

  const review = await moonshotSupervisor.conductFarmRiskManagerReview(
    marketData,
    farmBalance,
    farmTraderDecision
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    1, // stage
    'FARM',
    'FARM_RISK_MANAGER',
    timeLeftInWindow,
    { marketData, farmTraderDecision },
    review,
    review.tokensUsed || 0
  );

  // Update player stats
  const playerStats = {
    reviewsCompleted: 1,
    vetoesIssued: review.approved ? 0 : 1,
    adjustmentsMade: review.adjustments !== 'Approved as-is' && review.adjustments !== '' ? 1 : 0
  };
  leaderboard.updatePlayerStats('FARM_RISK_MANAGER', playerStats);

  // Update Farm Trader approval rate
  if (review.approved && farmTraderDecision.decision !== 'SKIP') {
    leaderboard.updatePlayerStats('FARM_TRADER', {
      decisionsApproved: 1
    });
  }

  return review;
}

// ============================================================
// STAGE 2: DEGEN DESK DELIBERATION
// ============================================================

async function conductDegenDeskDeliberation(windowSlug, marketData, farmDecision, timeLeftInWindow) {
  console.log(JSON.stringify({
    action: 'DEGEN_DESK_DELIBERATION_STARTED',
    window: windowSlug,
    timeLeft: timeLeftInWindow,
    timestamp: new Date().toISOString()
  }));

  // STEP 1: Degen Trader analyzes (sees Farm's decision)
  const degenTraderDecision = await conductDegenTraderDecision(
    windowSlug,
    marketData,
    farmDecision,
    timeLeftInWindow
  );

  // Wait 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));

  // STEP 2: Degen Risk Manager reviews
  const degenRiskManagerReview = await conductDegenRiskManagerReview(
    windowSlug,
    marketData,
    degenTraderDecision,
    timeLeftInWindow - 30
  );

  console.log(JSON.stringify({
    action: 'DEGEN_DESK_DELIBERATION_COMPLETED',
    decision: degenRiskManagerReview.decision,
    confidence: degenRiskManagerReview.confidence,
    lottoTicket: degenRiskManagerReview.lottoTicket,
    timestamp: new Date().toISOString()
  }));

  return degenRiskManagerReview;
}

async function conductDegenTraderDecision(windowSlug, marketData, farmDecision, timeLeftInWindow) {
  const degenBalance = virtualAccounts.getDeskBalance('DEGEN');

  const decision = await moonshotSupervisor.conductDegenTraderDecision(
    marketData,
    degenBalance,
    farmDecision
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    2, // stage
    'DEGEN',
    'DEGEN_TRADER',
    timeLeftInWindow,
    { marketData, degenBalance, farmDecision },
    decision,
    decision.tokensUsed || 0
  );

  // Update player stats
  const playerStats = {
    decisionsProposed: 1
  };
  if (decision.decision !== 'SKIP') {
    playerStats.decisionsApproved = 0; // Will be updated by RM
    playerStats.avgConfidence = decision.confidence;
  }
  if (decision.lottoTicket) {
    playerStats.lottoTicketsProposed = 1;
  }
  leaderboard.updatePlayerStats('DEGEN_TRADER', playerStats);

  return decision;
}

async function conductDegenRiskManagerReview(windowSlug, marketData, degenTraderDecision, timeLeftInWindow) {
  const degenBalance = virtualAccounts.getDeskBalance('DEGEN');

  const review = await moonshotSupervisor.conductDegenRiskManagerReview(
    marketData,
    degenBalance,
    degenTraderDecision
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    2, // stage
    'DEGEN',
    'DEGEN_RISK_MANAGER',
    timeLeftInWindow,
    { marketData, degenTraderDecision },
    review,
    review.tokensUsed || 0
  );

  // Update player stats
  const playerStats = {
    reviewsCompleted: 1,
    vetoesIssued: review.approved ? 0 : 1,
    adjustmentsMade: review.adjustments !== 'Approved as-is' && review.adjustments !== '' ? 1 : 0
  };
  leaderboard.updatePlayerStats('DEGEN_RISK_MANAGER', playerStats);

  // Update Degen Trader approval rate
  if (review.approved && degenTraderDecision.decision !== 'SKIP') {
    leaderboard.updatePlayerStats('DEGEN_TRADER', {
      decisionsApproved: 1
    });
  }

  return review;
}

// ============================================================
// STAGE 3: CLIPPER DESK DELIBERATION
// ============================================================

async function conductClipperDeskDeliberation(windowSlug, marketData, timeLeftInWindow) {
  console.log(JSON.stringify({
    action: 'CLIPPER_DESK_DELIBERATION_STARTED',
    window: windowSlug,
    timeLeft: timeLeftInWindow,
    timestamp: new Date().toISOString()
  }));

  // STEP 1: Clipper Trader assesses vibes
  const clipperTraderDecision = await conductClipperTraderDecision(
    windowSlug,
    marketData,
    timeLeftInWindow
  );

  // Wait 30 seconds
  await new Promise(resolve => setTimeout(resolve, 30000));

  // STEP 2: Clipper Monitor reviews clips and cross-desk emergencies
  const clipperMonitorReview = await conductClipperMonitorReview(
    windowSlug,
    marketData,
    clipperTraderDecision,
    timeLeftInWindow - 30
  );

  console.log(JSON.stringify({
    action: 'CLIPPER_DESK_DELIBERATION_COMPLETED',
    vibesScore: clipperTraderDecision.vibesScore,
    clipTargets: `${(clipperTraderDecision.clipTargetLow * 100).toFixed(0)}-${(clipperTraderDecision.clipTargetHigh * 100).toFixed(0)}%`,
    clipperActions: clipperMonitorReview.clipperActions ? clipperMonitorReview.clipperActions.length : 0,
    crossDeskAdvisories: clipperMonitorReview.crossDeskAdvisories ? clipperMonitorReview.crossDeskAdvisories.length : 0,
    timestamp: new Date().toISOString()
  }));

  return clipperMonitorReview;
}

async function conductClipperTraderDecision(windowSlug, marketData, timeLeftInWindow) {
  const clipperBalance = virtualAccounts.getDeskBalance('CLIPPER');

  const decision = await clipperAIPlayers.conductClipperTraderDecision(
    windowSlug,
    marketData,
    clipperBalance
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    3, // stage
    'CLIPPER',
    'CLIPPER_TRADER',
    timeLeftInWindow,
    { marketData, clipperBalance },
    decision,
    decision.tokensUsed || 0
  );

  // Update player stats
  const playerStats = {
    vibesAssessments: 1,
    avgVibesScore: decision.vibesScore
  };
  leaderboard.updatePlayerStats('CLIPPER_TRADER', playerStats);

  return decision;
}

async function conductClipperMonitorReview(windowSlug, marketData, clipperTraderDecision, timeLeftInWindow) {
  const review = await clipperAIPlayers.conductClipperMonitorReview(
    windowSlug,
    marketData,
    clipperTraderDecision,
    timeLeftInWindow
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    3, // stage
    'CLIPPER',
    'CLIPPER_MONITOR',
    timeLeftInWindow,
    { marketData, clipperTraderDecision },
    review,
    review.tokensUsed || 0
  );

  // Update player stats
  const playerStats = {
    reviewsCompleted: 1,
    clipperActionsExecuted: review.clipperActions ? review.clipperActions.length : 0,
    crossDeskAdvisoriesIssued: review.crossDeskAdvisories ? review.crossDeskAdvisories.length : 0
  };
  leaderboard.updatePlayerStats('CLIPPER_MONITOR', playerStats);

  return review;
}

// ============================================================
// STAGE 4: SUPERVISOR ARBITRATION
// ============================================================

async function conductSupervisorArbitration(windowSlug, marketData, farmDecision, degenDecision, clipperDecision, timeLeftInWindow) {
  console.log(JSON.stringify({
    action: 'SUPERVISOR_ARBITRATION_STARTED',
    window: windowSlug,
    timeLeft: timeLeftInWindow,
    timestamp: new Date().toISOString()
  }));

  const farmBalance = virtualAccounts.getDeskBalance('FARM');
  const degenBalance = virtualAccounts.getDeskBalance('DEGEN');

  const arbitration = await moonshotSupervisor.conductSupervisorArbitration(
    marketData,
    farmBalance,
    degenBalance,
    farmDecision,
    degenDecision
  );

  // Record in dialogue
  dialogueRecorder.recordPlayerDecision(
    windowSlug,
    4, // stage (updated for 7-player system)
    'SUPERVISOR',
    'SUPERVISOR',
    timeLeftInWindow,
    { marketData, farmDecision, degenDecision, clipperDecision },
    arbitration,
    arbitration.tokensUsed || 0
  );

  // Update supervisor stats
  const playerStats = {
    arbitrationsCompleted: 1,
    bothDesksApproved: arbitration.farmApproved && arbitration.degenApproved ? 1 : 0,
    conflictsResolved: farmDecision.side !== degenDecision.side && (arbitration.farmApproved || arbitration.degenApproved) ? 1 : 0,
    rebalancingActions: arbitration.rebalancing.length
  };
  leaderboard.updatePlayerStats('SUPERVISOR', playerStats);

  console.log(JSON.stringify({
    action: 'SUPERVISOR_ARBITRATION_COMPLETED',
    farmApproved: arbitration.farmApproved,
    degenApproved: arbitration.degenApproved,
    rebalancingActions: arbitration.rebalancing.length,
    timestamp: new Date().toISOString()
  }));

  return arbitration;
}

// ============================================================
// EXECUTION
// ============================================================

async function executeApprovedTrades(windowSlug, supervisorDecision) {
  console.log(JSON.stringify({
    action: 'EXECUTION_STARTED',
    window: windowSlug,
    farmApproved: supervisorDecision.farmApproved,
    degenApproved: supervisorDecision.degenApproved,
    timestamp: new Date().toISOString()
  }));

  const executionResults = {
    farm: null,
    degen: null
  };

  // Execute Farm desk trade
  if (supervisorDecision.farmApproved && supervisorDecision.finalPlan.farm) {
    const farmPlan = supervisorDecision.finalPlan.farm;

    console.log(JSON.stringify({
      action: 'FARM_TRADE_APPROVED',
      side: farmPlan.side,
      amount: farmPlan.amount.toFixed(2),
      maxPrice: (farmPlan.maxPrice * 100).toFixed(1) + '¢',
      message: 'Approved by orchestrator, main loop will execute and record',
      timestamp: new Date().toISOString()
    }));

    // Main loop will place order and record trade with actual fill data
    // No stub recording here

    // Record in dialogue (with planned values, actual fills recorded later)
    dialogueRecorder.recordExecution(
      windowSlug,
      'FARM',
      farmPlan.side,
      farmPlan.amount,
      farmPlan.maxPrice,
      farmPlan.amount / farmPlan.maxPrice,  // Estimated shares
      false
    );

    executionResults.farm = {
      desk: 'FARM',
      side: farmPlan.side,
      amount: farmPlan.amount,
      maxPrice: farmPlan.maxPrice,
      approved: true
    };
  }

  // Execute Degen desk trade
  if (supervisorDecision.degenApproved && supervisorDecision.finalPlan.degen) {
    const degenPlan = supervisorDecision.finalPlan.degen;

    console.log(JSON.stringify({
      action: 'DEGEN_TRADE_APPROVED',
      side: degenPlan.side,
      amount: degenPlan.amount.toFixed(2),
      maxPrice: (degenPlan.maxPrice * 100).toFixed(1) + '¢',
      lottoTicket: degenPlan.lottoTicket,
      message: 'Approved by orchestrator, main loop will execute and record',
      timestamp: new Date().toISOString()
    }));

    // Main loop will place order and record trade with actual fill data
    // No stub recording here

    // Record in dialogue (with planned values, actual fills recorded later)
    dialogueRecorder.recordExecution(
      windowSlug,
      'DEGEN',
      degenPlan.side,
      degenPlan.amount,
      degenPlan.maxPrice,
      degenPlan.amount / degenPlan.maxPrice,  // Estimated shares
      degenPlan.lottoTicket || false
    );

    executionResults.degen = {
      desk: 'DEGEN',
      side: degenPlan.side,
      amount: degenPlan.amount,
      maxPrice: degenPlan.maxPrice,
      lottoTicket: degenPlan.lottoTicket || false,
      approved: true
    };
  }

  // Execute rebalancing if any
  for (const action of supervisorDecision.rebalancing) {
    virtualAccounts.executeDeskTransfer(
      action.fromDesk,
      action.toDesk,
      action.amount,
      action.type,
      action.reason
    );
  }

  console.log(JSON.stringify({
    action: 'EXECUTION_COMPLETED',
    farmExecuted: executionResults.farm !== null,
    degenExecuted: executionResults.degen !== null,
    timestamp: new Date().toISOString()
  }));

  return executionResults;
}

// ============================================================
// MAIN ORCHESTRATION
// ============================================================

async function orchestrateTradingDecision(windowSlug, marketData, timeLeftInWindow) {
  console.log(JSON.stringify({
    action: 'ORCHESTRATION_STARTED',
    window: windowSlug,
    timeLeft: timeLeftInWindow,
    timestamp: new Date().toISOString()
  }));

  // Start window dialogue recording
  dialogueRecorder.startWindowDialogue(windowSlug, marketData);

  try {
    // STAGE 1: Farm Desk (850s → 820s)
    const farmDecision = await conductFarmDeskDeliberation(
      windowSlug,
      marketData,
      timeLeftInWindow
    );

    // STAGE 2: Degen Desk (820s → 780s)
    const degenDecision = await conductDegenDeskDeliberation(
      windowSlug,
      marketData,
      farmDecision,
      timeLeftInWindow - 40
    );

    // STAGE 3: Clipper Desk (780s → 750s)
    const clipperDecision = await conductClipperDeskDeliberation(
      windowSlug,
      marketData,
      timeLeftInWindow - 80
    );

    // STAGE 4: Supervisor (750s → 720s)
    const supervisorDecision = await conductSupervisorArbitration(
      windowSlug,
      marketData,
      farmDecision,
      degenDecision,
      clipperDecision,
      timeLeftInWindow - 120
    );

    // EXECUTION (720s+)
    const executionResults = await executeApprovedTrades(
      windowSlug,
      supervisorDecision
    );

    console.log(JSON.stringify({
      action: 'ORCHESTRATION_COMPLETED',
      window: windowSlug,
      farmApproved: supervisorDecision.farmApproved,
      degenApproved: supervisorDecision.degenApproved,
      clipperActionsExecuted: clipperDecision.clipperActions ? clipperDecision.clipperActions.length : 0,
      crossDeskAdvisoriesIssued: clipperDecision.crossDeskAdvisories ? clipperDecision.crossDeskAdvisories.length : 0,
      timestamp: new Date().toISOString()
    }));

    return {
      farmDecision,
      degenDecision,
      clipperDecision,
      supervisorDecision,
      executionResults
    };
  } catch (error) {
    console.error(JSON.stringify({
      action: 'ORCHESTRATION_ERROR',
      window: windowSlug,
      error: error.message,
      timestamp: new Date().toISOString()
    }));

    throw error;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  orchestrateTradingDecision,
  conductFarmDeskDeliberation,
  conductDegenDeskDeliberation,
  conductClipperDeskDeliberation,  // NEW: Clipper desk
  conductSupervisorArbitration,
  executeApprovedTrades
};
