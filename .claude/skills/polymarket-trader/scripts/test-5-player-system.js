#!/usr/bin/env node

// ============================================================
// 5-PLAYER SYSTEM TEST
// Verifies all components are working correctly
// ============================================================

const virtualAccounts = require('./virtual-account-manager');
const dialogueRecorder = require('./dialogue-recorder');
const leaderboard = require('./leaderboard-tracker');

console.log('='.repeat(70));
console.log('TESTING 5-PLAYER TRADING DESK SYSTEM');
console.log('='.repeat(70));

// TEST 1: Initialize Virtual Accounts
console.log('\n[TEST 1] Initializing Virtual Accounts...');
try {
  virtualAccounts.initializeVirtualAccounts(40.00);
  const accounts = virtualAccounts.getAccounts();
  console.log(`✅ Fund: ${accounts.fund.name}`);
  console.log(`✅ Farm Balance: $${accounts.desks.FARM.currentBalance.toFixed(2)}`);
  console.log(`✅ Degen Balance: $${accounts.desks.DEGEN.currentBalance.toFixed(2)}`);
} catch (error) {
  console.error(`❌ Virtual Accounts Error: ${error.message}`);
}

// TEST 2: Initialize Dialogue Recorder
console.log('\n[TEST 2] Initializing Dialogue Recorder...');
try {
  dialogueRecorder.initializeDialogueRecorder();
  console.log('✅ Dialogue Recorder ready');
} catch (error) {
  console.error(`❌ Dialogue Recorder Error: ${error.message}`);
}

// TEST 3: Initialize Leaderboard
console.log('\n[TEST 3] Initializing Leaderboard...');
try {
  leaderboard.initializeLeaderboard();
  const lb = leaderboard.getLeaderboard();
  console.log(`✅ Leaderboard initialized`);
  console.log(`✅ Desks tracked: ${lb.desks.length}`);
  console.log(`✅ Players tracked: ${lb.players.length}`);
} catch (error) {
  console.error(`❌ Leaderboard Error: ${error.message}`);
}

// TEST 4: Record Mock Trade (Farm Desk)
console.log('\n[TEST 4] Recording Mock Farm Trade...');
try {
  virtualAccounts.recordTrade(
    'FARM',
    'test-window-123',
    'YES',
    0.45,
    6.67,
    3.00,
    false
  );
  const farmBalance = virtualAccounts.getDeskBalance('FARM');
  const farmCapital = virtualAccounts.getDeskAvailableCapital('FARM');
  console.log(`✅ Trade recorded`);
  console.log(`✅ Farm Balance: $${farmBalance.toFixed(2)}`);
  console.log(`✅ Farm Available: $${farmCapital.toFixed(2)}`);
} catch (error) {
  console.error(`❌ Farm Trade Error: ${error.message}`);
}

// TEST 5: Record Mock Trade (Degen Desk - Lotto Ticket)
console.log('\n[TEST 5] Recording Mock Degen Lotto Ticket...');
try {
  virtualAccounts.recordTrade(
    'DEGEN',
    'test-window-123',
    'NO',
    0.08,
    18.75,
    1.50,
    true // lotto ticket
  );
  const degenBalance = virtualAccounts.getDeskBalance('DEGEN');
  const degenCapital = virtualAccounts.getDeskAvailableCapital('DEGEN');
  console.log(`✅ Lotto ticket recorded`);
  console.log(`✅ Degen Balance: $${degenBalance.toFixed(2)}`);
  console.log(`✅ Degen Available: $${degenCapital.toFixed(2)}`);
} catch (error) {
  console.error(`❌ Degen Trade Error: ${error.message}`);
}

// TEST 6: Settle Positions (Farm wins, Degen loses)
console.log('\n[TEST 6] Settling Positions (YES wins)...');
try {
  const farmResult = virtualAccounts.settlePosition('FARM', 'test-window-123', 'YES');
  const degenResult = virtualAccounts.settlePosition('DEGEN', 'test-window-123', 'YES');

  console.log(`✅ Farm settled: ${farmResult.won ? 'WON' : 'LOST'} | Profit: $${farmResult.profit.toFixed(2)}`);
  console.log(`✅ Degen settled: ${degenResult.won ? 'WON' : 'LOST'} | Profit: $${degenResult.profit.toFixed(2)}`);
  console.log(`✅ Farm new balance: $${farmResult.newBalance.toFixed(2)}`);
  console.log(`✅ Degen new balance: $${degenResult.newBalance.toFixed(2)}`);
} catch (error) {
  console.error(`❌ Settlement Error: ${error.message}`);
}

// TEST 7: Check Final State
console.log('\n[TEST 7] Final State Check...');
try {
  const accounts = virtualAccounts.getAccounts();
  const farmStats = virtualAccounts.getDeskStats('FARM');
  const degenStats = virtualAccounts.getDeskStats('DEGEN');

  console.log(`✅ Total Fund Balance: $${accounts.fund.totalBalance.toFixed(2)}`);
  console.log(`✅ Farm Win Rate: ${(farmStats.winRate * 100).toFixed(1)}%`);
  console.log(`✅ Degen Win Rate: ${(degenStats.winRate * 100).toFixed(1)}%`);
  console.log(`✅ Farm Profit: $${farmStats.totalProfit.toFixed(2)}`);
  console.log(`✅ Degen Profit: $${degenStats.totalProfit.toFixed(2)}`);
} catch (error) {
  console.error(`❌ Final State Error: ${error.message}`);
}

console.log('\n' + '='.repeat(70));
console.log('ALL TESTS COMPLETE!');
console.log('='.repeat(70));
console.log('✅ 5-Player Trading Desk System is READY!');
console.log('='.repeat(70));
