#!/usr/bin/env node

// ============================================================
// ASYMMETRIC ALPHA FUND - TRADING DESK TUI
// Bloomberg-style terminal interface for 5-player system
// ============================================================

const fs = require('fs');
const path = require('path');

// File paths
const ACCOUNTS_FILE = '/tmp/polymarket-virtual-accounts.json';
const DIALOGUE_FILE = '/tmp/polymarket-dialogue-history.json';
const LEADERBOARD_FILE = '/tmp/polymarket-leaderboard.json';
const LOG_FILE = '/tmp/5-player-bot.log';

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',

  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
};

// State
let accounts = null;
let dialogue = null;
let leaderboard = null;
let recentLogs = [];

// Load data from files
function loadData() {
  try {
    if (fs.existsSync(ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
    }
    if (fs.existsSync(DIALOGUE_FILE)) {
      dialogue = JSON.parse(fs.readFileSync(DIALOGUE_FILE, 'utf8'));
    }
    if (fs.existsSync(LEADERBOARD_FILE)) {
      leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
    }

    // Load recent logs
    if (fs.existsSync(LOG_FILE)) {
      const logContent = fs.readFileSync(LOG_FILE, 'utf8');
      const lines = logContent.split('\n').filter(l => l.trim());
      recentLogs = lines.slice(-50); // Last 50 lines
    }
  } catch (error) {
    // Silently fail - will retry next refresh
  }
}

// Clear screen and reset cursor
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

// Draw header
function drawHeader() {
  const width = process.stdout.columns || 120;
  const line = '═'.repeat(width);

  console.log(colors.bright + colors.cyan + line + colors.reset);
  console.log(colors.bright + colors.white +
    '  🏦 ASYMMETRIC ALPHA FUND - TRADING DESK MONITOR' + colors.reset);

  if (accounts) {
    const totalBalance = accounts.fund.totalBalance.toFixed(2);
    const lifetimeProfit = accounts.fund.lifetimeProfit.toFixed(2);
    const lifetimeRoi = (accounts.fund.lifetimeRoi * 100).toFixed(1);
    const profitColor = accounts.fund.lifetimeProfit >= 0 ? colors.green : colors.red;

    console.log(colors.cyan + '  Balance: ' + colors.white + `$${totalBalance}` +
                colors.cyan + ' | Lifetime P/L: ' + profitColor + `$${lifetimeProfit}` +
                colors.cyan + ' | ROI: ' + profitColor + `${lifetimeRoi}%` + colors.reset);
  }

  console.log(colors.cyan + line + colors.reset);
  console.log('');
}

// Draw desk panels side by side
function drawDesks() {
  if (!accounts) {
    console.log(colors.yellow + '  Waiting for account data...' + colors.reset);
    return;
  }

  const farm = accounts.desks.FARM;
  const degen = accounts.desks.DEGEN;

  const width = process.stdout.columns || 120;
  const halfWidth = Math.floor(width / 2) - 2;

  // Desk headers
  console.log(colors.bright + colors.green + '  FARM DESK (80%)' + ' '.repeat(halfWidth - 16) +
              colors.magenta + 'DEGEN DESK (20%)' + colors.reset);
  console.log(colors.dim + '  ─'.repeat(halfWidth) + '  ─'.repeat(halfWidth) + colors.reset);

  // Balance
  console.log(colors.green + `  Balance: $${farm.currentBalance.toFixed(2)}` + ' '.repeat(halfWidth - 20) +
              colors.magenta + `Balance: $${degen.currentBalance.toFixed(2)}` + colors.reset);

  // Available capital
  console.log(colors.green + `  Available: $${farm.availableCapital.toFixed(2)}` + ' '.repeat(halfWidth - 22) +
              colors.magenta + `Available: $${degen.availableCapital.toFixed(2)}` + colors.reset);

  // Stats
  const farmStats = farm.lifetimeStats;
  const degenStats = degen.lifetimeStats;

  console.log('');
  console.log(colors.cyan + '  PERFORMANCE' + ' '.repeat(halfWidth - 11) + 'PERFORMANCE' + colors.reset);
  console.log(colors.dim + '  ─'.repeat(halfWidth) + '  ─'.repeat(halfWidth) + colors.reset);

  // Win rate
  const farmWR = (farmStats.winRate * 100).toFixed(1);
  const degenWR = (degenStats.winRate * 100).toFixed(1);
  console.log(colors.green + `  Win Rate: ${farmWR}%` + ' '.repeat(halfWidth - 18) +
              colors.magenta + `Win Rate: ${degenWR}%` + colors.reset);

  // Trades
  console.log(colors.green + `  Trades: ${farmStats.totalTrades} (${farmStats.wins}W/${farmStats.losses}L)` +
              ' '.repeat(halfWidth - 25) +
              colors.magenta + `Trades: ${degenStats.totalTrades} (${degenStats.wins}W/${degenStats.losses}L)` + colors.reset);

  // Profit
  const farmProfitColor = farmStats.totalProfit >= 0 ? colors.green : colors.red;
  const degenProfitColor = degenStats.totalProfit >= 0 ? colors.magenta : colors.red;
  console.log(farmProfitColor + `  Profit: $${farmStats.totalProfit.toFixed(2)}` + ' '.repeat(halfWidth - 20) +
              degenProfitColor + `Profit: $${degenStats.totalProfit.toFixed(2)}` + colors.reset);

  // ROI
  const farmROI = (farmStats.roi * 100).toFixed(1);
  const degenROI = (degenStats.roi * 100).toFixed(1);
  console.log(farmProfitColor + `  ROI: ${farmROI}%` + ' '.repeat(halfWidth - 15) +
              degenProfitColor + `ROI: ${degenROI}%` + colors.reset);

  // Streak
  const farmStreak = `${farmStats.currentStreak} ${farmStats.streakType || 'NONE'}`;
  const degenStreak = `${degenStats.currentStreak} ${degenStats.streakType || 'NONE'}`;
  console.log(colors.green + `  Streak: ${farmStreak}` + ' '.repeat(halfWidth - 15 - farmStreak.length) +
              colors.magenta + `Streak: ${degenStreak}` + colors.reset);

  // Lotto tickets (Degen only)
  if (degenStats.lottoTicketWins !== undefined) {
    const lottoHitRate = (degenStats.lottoTicketHitRate * 100).toFixed(1);
    console.log(' '.repeat(halfWidth) + colors.yellow + `  Lotto Wins: ${degenStats.lottoTicketWins} (${lottoHitRate}%)` + colors.reset);
  }

  console.log('');
}

// Draw leaderboard
function drawLeaderboard() {
  if (!leaderboard) return;

  console.log(colors.bright + colors.cyan + '  LEADERBOARD' + colors.reset);
  console.log(colors.dim + '  ─'.repeat(60) + colors.reset);

  // Desk rankings
  if (leaderboard.desks && leaderboard.desks.length > 0) {
    const sorted = [...leaderboard.desks].sort((a, b) => a.rank - b.rank);
    sorted.forEach(desk => {
      const rankColor = desk.rank === 1 ? colors.yellow : colors.white;
      const nameColor = desk.desk === 'FARM' ? colors.green : colors.magenta;
      console.log(rankColor + `  #${desk.rank}` + nameColor + ` ${desk.desk}` +
                  colors.white + ` - ${(desk.winRate * 100).toFixed(1)}% WR` +
                  ` | $${desk.totalProfit.toFixed(2)}` +
                  colors.dim + ` | ${desk.badge || ''}` + colors.reset);
    });
  }

  console.log('');
}

// Draw recent activity
function drawRecentActivity() {
  console.log(colors.bright + colors.cyan + '  RECENT ACTIVITY' + colors.reset);
  console.log(colors.dim + '  ─'.repeat(120) + colors.reset);

  if (recentLogs.length === 0) {
    console.log(colors.dim + '  No activity yet...' + colors.reset);
    return;
  }

  // Show last 15 lines
  const displayLogs = recentLogs.slice(-15);
  displayLogs.forEach(line => {
    try {
      const log = JSON.parse(line);

      // Color code by action
      let actionColor = colors.white;
      if (log.action.includes('5_PLAYER')) actionColor = colors.cyan;
      if (log.action.includes('FARM')) actionColor = colors.green;
      if (log.action.includes('DEGEN')) actionColor = colors.magenta;
      if (log.action.includes('ERROR')) actionColor = colors.red;
      if (log.action.includes('SETTLED')) actionColor = colors.yellow;

      const timestamp = log.timestamp ? new Date(log.timestamp).toLocaleTimeString() : '';
      console.log(colors.dim + `  ${timestamp}` + actionColor + ` ${log.action}` + colors.reset);
    } catch (e) {
      // Not JSON, print raw
      console.log(colors.dim + `  ${line.substring(0, 120)}` + colors.reset);
    }
  });

  console.log('');
}

// Draw footer
function drawFooter() {
  const width = process.stdout.columns || 120;
  console.log(colors.dim + '  ─'.repeat(width) + colors.reset);
  console.log(colors.dim + '  Refreshing every 2s | Press Ctrl+C to exit' + colors.reset);
}

// Main render
function render() {
  clearScreen();
  loadData();
  drawHeader();
  drawDesks();
  drawLeaderboard();
  drawRecentActivity();
  drawFooter();
}

// Start monitoring
console.log(colors.cyan + 'Starting ASYMMETRIC ALPHA FUND TUI...' + colors.reset);
console.log(colors.dim + 'Loading data...' + colors.reset);

// Enable alternate screen buffer (like htop/top)
process.stdout.write('\x1b[?1049h');

// Initial render
render();

// Refresh every 2 seconds
setInterval(render, 2000);

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
  // Restore normal screen buffer
  process.stdout.write('\x1b[?1049l');
  console.log(colors.cyan + '\nASYMMETRIC ALPHA FUND TUI stopped.' + colors.reset);
  process.exit(0);
});
