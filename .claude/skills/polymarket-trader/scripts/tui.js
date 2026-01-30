#!/usr/bin/env node

/**
 * Terminal UI for Polymarket Trading Bot
 * Real-time dashboard with treasury management
 */

const blessed = require('blessed');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const MEMORY_FILE = path.join(process.env.HOME, '.polymarket-trader', 'memory.json');
const LOG_FILE = path.join(process.env.HOME, '.polymarket-trader', 'logs', 'latest.log');

// Create screen
const screen = blessed.screen({
  smartCSR: true,
  title: 'Polymarket Trading Bot Dashboard'
});

// Header
const header = blessed.box({
  top: 0,
  left: 0,
  width: '100%',
  height: 3,
  content: '{center}{bold}🦞 POLYMARKET AUTONOMOUS TRADING BOT{/bold}{/center}',
  tags: true,
  style: {
    fg: 'white',
    bg: 'blue',
    bold: true
  }
});

// BTC Price Box
const btcBox = blessed.box({
  top: 3,
  left: 0,
  width: '50%',
  height: 5,
  border: { type: 'line' },
  label: ' BTC Price ',
  tags: true,
  style: {
    border: { fg: 'cyan' }
  }
});

// Window Status Box
const windowBox = blessed.box({
  top: 3,
  left: '50%',
  width: '50%',
  height: 5,
  border: { type: 'line' },
  label: ' Current Window ',
  tags: true,
  style: {
    border: { fg: 'cyan' }
  }
});

// Treasury Box
const treasuryBox = blessed.box({
  top: 8,
  left: 0,
  width: '100%',
  height: 7,
  border: { type: 'line' },
  label: ' Treasury & P/L ',
  tags: true,
  style: {
    border: { fg: 'green' }
  }
});

// Recent Bets Log
const betsLog = blessed.log({
  top: 15,
  left: 0,
  width: '60%',
  height: '100%-15',
  border: { type: 'line' },
  label: ' Recent Bets ',
  tags: true,
  scrollable: true,
  alwaysScroll: true,
  scrollbar: {
    style: { bg: 'yellow' }
  },
  style: {
    border: { fg: 'yellow' }
  }
});

// Bot Status
const statusBox = blessed.box({
  top: 15,
  left: '60%',
  width: '40%',
  height: '100%-15',
  border: { type: 'line' },
  label: ' Bot Status ',
  tags: true,
  style: {
    border: { fg: 'magenta' }
  }
});

// Add all to screen
screen.append(header);
screen.append(btcBox);
screen.append(windowBox);
screen.append(treasuryBox);
screen.append(betsLog);
screen.append(statusBox);

// Quit on Escape, q, or Control-C
screen.key(['escape', 'q', 'C-c'], () => process.exit(0));

// Load memory
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

// Parse log line
function parseLogLine(line) {
  try {
    return JSON.parse(line.replace(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /, ''));
  } catch (e) {
    return null;
  }
}

// Get recent logs
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

// Update dashboard
function updateDashboard() {
  const memory = loadMemory();
  const logs = getRecentLogs();

  // BTC Price
  const btcLogs = logs.filter(l => l.action === 'BTC_PRICE');
  const latestBTC = btcLogs[btcLogs.length - 1];
  if (latestBTC) {
    const price = parseFloat(latestBTC.price);
    const color = btcLogs.length > 1 && price > parseFloat(btcLogs[btcLogs.length - 2].price) ? 'green' : 'red';
    btcBox.setContent(`{center}{${color}-fg}{bold}$${price.toFixed(2)}{/bold}{/${color}-fg}{/center}\n{center}Sources: ${latestBTC.sources.join(', ')}{/center}`);
  }

  // Window Status
  const windowLogs = logs.filter(l => l.action === 'NEW_WINDOW' || l.action === 'STATUS');
  const latestWindow = windowLogs[windowLogs.length - 1];
  if (latestWindow) {
    const timeLeft = latestWindow.timeLeft || 0;
    const minutes = Math.floor(timeLeft / 60);
    const seconds = timeLeft % 60;
    windowBox.setContent(`{center}${latestWindow.window || 'N/A'}{/center}\n{center}{bold}Time: ${minutes}m ${seconds}s{/bold}{/center}`);
  }

  // Treasury
  if (memory) {
    const activeBalance = memory.activeBalance || 61;
    const lockedProfits = memory.lockedProfits || 0;
    const totalValue = activeBalance + lockedProfits;
    const netPL = memory.totalProfit - memory.totalLoss;
    const winRate = memory.trades.length > 0 ? ((memory.winCount / memory.trades.length) * 100).toFixed(1) : '0.0';

    const plColor = netPL >= 0 ? 'green' : 'red';
    treasuryBox.setContent(
      `  Active Balance: {bold}$${activeBalance.toFixed(2)}{/bold}\n` +
      `  Locked Profits: {green-fg}{bold}$${lockedProfits.toFixed(2)}{/bold}{/green-fg}\n` +
      `  Total Value: {bold}$${totalValue.toFixed(2)}{/bold}\n` +
      `  Net P/L: {${plColor}-fg}{bold}$${netPL.toFixed(2)}{/bold}{/${plColor}-fg}\n` +
      `  Win Rate: {bold}${winRate}%{/bold}  |  Total Trades: {bold}${memory.trades.length}{/bold}`
    );
  }

  // Recent Bets
  const betLogs = logs.filter(l => l.action === 'PLACING_BET' || l.action === 'BET_SUCCESS' || l.action === 'BET_FAILED');
  betLogs.slice(-10).forEach(bet => {
    if (bet.action === 'PLACING_BET') {
      betsLog.log(`{yellow-fg}[BET]{/yellow-fg} ${bet.side} @$${bet.price} x${bet.size} - ${bet.confidence} conf`);
      betsLog.log(`  → ${bet.reasoning.join(', ')}`);
    } else if (bet.action === 'BET_SUCCESS') {
      betsLog.log(`{green-fg}  ✓ SUCCESS{/green-fg}`);
    } else if (bet.action === 'BET_FAILED') {
      betsLog.log(`{red-fg}  ✗ FAILED{/red-fg}`);
    }
  });

  // Bot Status
  const statusLogs = logs.filter(l => l.action === 'STATUS');
  const latestStatus = statusLogs[statusLogs.length - 1];
  if (latestStatus) {
    statusBox.setContent(
      `  Mode: {bold}REAL-TIME{/bold}\n` +
      `  Open Positions: {bold}${latestStatus.openPositions}{/bold}\n` +
      `  Total Trades: {bold}${latestStatus.totalTrades}{/bold}\n` +
      `  Active Balance: {bold}$${latestStatus.activeBalance}{/bold}\n` +
      `  Next Bet In: {bold}${latestStatus.nextBetIn}s{/bold}\n\n` +
      `{center}{green-fg}Bot is RUNNING{/green-fg}{/center}`
    );
  }

  screen.render();
}

// Update every 1 second
setInterval(updateDashboard, 1000);

// Initial update
updateDashboard();

// Render screen
screen.render();
