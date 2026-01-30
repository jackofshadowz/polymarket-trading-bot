#!/usr/bin/env node

/**
 * Simple Real-Time Dashboard for Polymarket Trading Bot
 * No external dependencies - pure Node.js
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const MEMORY_FILE = path.join(process.env.HOME, '.polymarket-trader', 'memory.json');
const LOG_FILE = path.join(process.env.HOME, '.polymarket-trader', 'logs', 'latest.log');

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
};

function clearScreen() {
  console.clear();
}

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    }
  } catch (e) {
    return null;
  }
  return null;
}

function parseLogLine(line) {
  try {
    return JSON.parse(line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /, '').replace(/^\x1b\[\d+m/g, ''));
  } catch (e) {
    return null;
  }
}

function getRecentLogs() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const logs = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
      return logs.slice(-100).map(parseLogLine).filter(l => l !== null);
    }
  } catch (e) {
    return [];
  }
  return [];
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function renderDashboard() {
  clearScreen();

  const memory = loadMemory();
  const logs = getRecentLogs();

  // Header
  console.log(colors.bgBlue + colors.bold + colors.white);
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('                  🦞 POLYMARKET AUTONOMOUS TRADING BOT                          ');
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log(colors.reset);
  console.log();

  // BTC Price & Window (side by side)
  const btcLogs = logs.filter(l => l.action === 'BTC_PRICE');
  const latestBTC = btcLogs[btcLogs.length - 1];
  const windowLogs = logs.filter(l => l.action === 'NEW_WINDOW' || l.action === 'STATUS');
  const latestWindow = windowLogs[windowLogs.length - 1];

  console.log(colors.cyan + '┌─────────────────────────────────────┬─────────────────────────────────────┐' + colors.reset);
  console.log(colors.cyan + '│' + colors.reset + colors.bold + '  BTC PRICE                          ' + colors.cyan + '│' + colors.reset + colors.bold + '  CURRENT WINDOW                     ' + colors.cyan + '│' + colors.reset);
  console.log(colors.cyan + '├─────────────────────────────────────┼─────────────────────────────────────┤' + colors.reset);

  if (latestBTC) {
    const price = parseFloat(latestBTC.price);
    const priceColor = btcLogs.length > 1 && price > parseFloat(btcLogs[btcLogs.length - 2].price) ? colors.green : colors.red;
    console.log(colors.cyan + '│  ' + priceColor + colors.bold + `$${price.toFixed(2).padEnd(32)}` + colors.reset + colors.cyan + '│  ' + colors.white + (latestWindow?.window || 'N/A').substring(12, 44).padEnd(33) + colors.cyan + '│' + colors.reset);
    console.log(colors.cyan + '│  ' + colors.white + `Sources: ${latestBTC.sources.join(', ')}`.padEnd(33) + colors.cyan + '│  ' + colors.bold + colors.yellow + `Time: ${latestWindow ? formatTime(latestWindow.timeLeft || 0) : 'N/A'}`.padEnd(33) + colors.reset + colors.cyan + '│' + colors.reset);
  } else {
    console.log(colors.cyan + '│  ' + colors.white + 'Waiting for data...'.padEnd(33) + colors.cyan + '│  ' + colors.white + 'Waiting for data...'.padEnd(33) + colors.cyan + '│' + colors.reset);
    console.log(colors.cyan + '│  '.padEnd(38) + '│  '.padEnd(38) + '│' + colors.reset);
  }

  console.log(colors.cyan + '└─────────────────────────────────────┴─────────────────────────────────────┘' + colors.reset);
  console.log();

  // Treasury & P/L
  console.log(colors.green + '┌───────────────────────────────────────────────────────────────────────────┐' + colors.reset);
  console.log(colors.green + '│' + colors.reset + colors.bold + '  TREASURY & P/L                                                            ' + colors.green + '│' + colors.reset);
  console.log(colors.green + '├───────────────────────────────────────────────────────────────────────────┤' + colors.reset);

  if (memory) {
    const activeBalance = memory.activeBalance || 61;
    const lockedProfits = memory.lockedProfits || 0;
    const totalValue = activeBalance + lockedProfits;
    const netPL = memory.totalProfit - memory.totalLoss;
    const winRate = memory.trades.length > 0 ? ((memory.winCount / memory.trades.length) * 100).toFixed(1) : '0.0';
    const plColor = netPL >= 0 ? colors.green : colors.red;

    console.log(colors.green + '│  ' + colors.white + `Active Balance: ${colors.bold}$${activeBalance.toFixed(2)}${colors.reset}`.padEnd(76) + colors.green + '│' + colors.reset);
    console.log(colors.green + '│  ' + colors.white + `Locked Profits: ${colors.green}${colors.bold}$${lockedProfits.toFixed(2)}${colors.reset}`.padEnd(91) + colors.green + '│' + colors.reset);
    console.log(colors.green + '│  ' + colors.white + `Total Value: ${colors.bold}$${totalValue.toFixed(2)}${colors.reset}`.padEnd(76) + colors.green + '│' + colors.reset);
    console.log(colors.green + '│  ' + colors.white + `Net P/L: ${plColor}${colors.bold}$${netPL.toFixed(2)}${colors.reset}`.padEnd(87) + colors.green + '│' + colors.reset);
    console.log(colors.green + '│  ' + colors.white + `Win Rate: ${colors.bold}${winRate}%${colors.reset}  |  Total Trades: ${colors.bold}${memory.trades.length}${colors.reset}`.padEnd(83) + colors.green + '│' + colors.reset);
  } else {
    console.log(colors.green + '│  ' + colors.white + 'Loading treasury data...'.padEnd(73) + colors.green + '│' + colors.reset);
  }

  console.log(colors.green + '└───────────────────────────────────────────────────────────────────────────┘' + colors.reset);
  console.log();

  // Recent Bets
  console.log(colors.yellow + '┌───────────────────────────────────────────────────────────────────────────┐' + colors.reset);
  console.log(colors.yellow + '│' + colors.reset + colors.bold + '  RECENT BETS                                                               ' + colors.yellow + '│' + colors.reset);
  console.log(colors.yellow + '├───────────────────────────────────────────────────────────────────────────┤' + colors.reset);

  const betLogs = logs.filter(l => l.action === 'PLACING_BET' || l.action === 'BET_SUCCESS' || l.action === 'BET_FAILED');
  const recentBets = betLogs.slice(-5);

  if (recentBets.length > 0) {
    recentBets.forEach(bet => {
      if (bet.action === 'PLACING_BET') {
        const time = new Date(bet.timestamp).toLocaleTimeString();
        const betLabel = bet.betNumber ? `BET #${bet.betNumber}` : 'BET';
        const trigger = bet.trigger && bet.trigger !== 'initial' ? ` [${bet.trigger}]` : '';
        console.log(colors.yellow + '│  ' + colors.cyan + `[${time}] ${betLabel}${trigger}` + colors.white + ` ${bet.side} @$${bet.price} x${bet.size}`.padEnd(50) + colors.yellow + '│' + colors.reset);
        if (bet.reasoning && bet.reasoning.length > 0) {
          console.log(colors.yellow + '│  ' + colors.white + `  → ${bet.reasoning[0]}`.substring(0, 71).padEnd(71) + colors.yellow + '│' + colors.reset);
        }
      } else if (bet.action === 'BET_SUCCESS') {
        console.log(colors.yellow + '│  ' + colors.green + colors.bold + '  ✓ SUCCESS'.padEnd(82) + colors.reset + colors.yellow + '│' + colors.reset);
      } else if (bet.action === 'BET_FAILED') {
        console.log(colors.yellow + '│  ' + colors.red + colors.bold + '  ✗ FAILED'.padEnd(81) + colors.reset + colors.yellow + '│' + colors.reset);
      }
    });
  } else {
    console.log(colors.yellow + '│  ' + colors.white + 'Waiting for bets...'.padEnd(73) + colors.yellow + '│' + colors.reset);
  }

  console.log(colors.yellow + '└───────────────────────────────────────────────────────────────────────────┘' + colors.reset);
  console.log();

  // Bot Status
  console.log(colors.magenta + '┌───────────────────────────────────────────────────────────────────────────┐' + colors.reset);
  console.log(colors.magenta + '│' + colors.reset + colors.bold + '  BOT STATUS                                                                ' + colors.magenta + '│' + colors.reset);
  console.log(colors.magenta + '├───────────────────────────────────────────────────────────────────────────┤' + colors.reset);

  const statusLogs = logs.filter(l => l.action === 'STATUS');
  const latestStatus = statusLogs[statusLogs.length - 1];

  if (latestStatus) {
    const betStatus = latestStatus.betStatus || 'Waiting...';
    console.log(colors.magenta + '│  ' + colors.white + `Mode: ${colors.bold}REAL-TIME${colors.reset}`.padEnd(81) + colors.magenta + '│' + colors.reset);
    console.log(colors.magenta + '│  ' + colors.white + `Strategy: ${colors.bold}ONE BET PER WINDOW${colors.reset}`.padEnd(81) + colors.magenta + '│' + colors.reset);
    console.log(colors.magenta + '│  ' + colors.white + `Open Positions: ${colors.bold}${latestStatus.openPositions}${colors.reset}`.padEnd(81) + colors.magenta + '│' + colors.reset);
    console.log(colors.magenta + '│  ' + colors.white + `Total Trades: ${colors.bold}${latestStatus.totalTrades}${colors.reset}`.padEnd(81) + colors.magenta + '│' + colors.reset);
    console.log(colors.magenta + '│  ' + colors.white + `Status: ${colors.bold}${betStatus}${colors.reset}`.padEnd(81) + colors.magenta + '│' + colors.reset);
    console.log(colors.magenta + '│  '.padEnd(76) + colors.magenta + '│' + colors.reset);
    console.log(colors.magenta + '│  ' + colors.green + colors.bold + 'Bot is RUNNING ✓'.padEnd(87) + colors.reset + colors.magenta + '│' + colors.reset);
  } else {
    console.log(colors.magenta + '│  ' + colors.white + 'Initializing...'.padEnd(73) + colors.magenta + '│' + colors.reset);
  }

  console.log(colors.magenta + '└───────────────────────────────────────────────────────────────────────────┘' + colors.reset);
  console.log();
  console.log(colors.cyan + 'Press Ctrl+C to exit' + colors.reset);
}

// Handle exit gracefully
process.on('SIGINT', () => {
  clearScreen();
  console.log(colors.green + '\n👋 Dashboard stopped\n' + colors.reset);
  process.exit(0);
});

// Update every 1 second
setInterval(renderDashboard, 1000);

// Initial render
renderDashboard();
