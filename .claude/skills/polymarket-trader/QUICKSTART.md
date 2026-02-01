# Polymarket Trading Bot - Quick Start Guide

## Overview

This is a professional-grade autonomous trading bot for Polymarket's 15-minute Bitcoin prediction markets. The bot uses 5 independent profit strategies with automatic cash recycling.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ASYMMETRIC EDGE BOT                          │
├─────────────────────────────────────────────────────────────────┤
│  ORACLE DESK          Real-time Binance price stream            │
│  CLIPPER DESK         5 trading strategies                      │
│  EXECUTION DESK       Order placement + auto-flip               │
│  TREASURY DESK        Auto-redeem winnings every 5 min          │
└─────────────────────────────────────────────────────────────────┘
```

## The 5 Profit Strategies

| Strategy | Timing | Entry | Exit | Edge |
|----------|--------|-------|------|------|
| **SNIPER** | 5-2 min before close | Fair value | Expiry | Binance latency arb |
| **OPENER** | 60-10s before close | $0.51 | $0.60+ scalp | Trend continuation |
| **DIP SCALPER** | Anytime | $0.47 | $0.75 (60%) | Buy panic, sell rebound |
| **LOTTO** | 3min-30s before close | $0.02 | Expiry | 50x moonshot on volatility |
| **EMERGENCY** | Always | N/A | Panic sell | Capital preservation |

## Quick Start

### Step 1: Navigate to Scripts

```bash
cd /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts
```

### Step 2: Install Dependencies

```bash
npm install
```

### Step 3: Configure Environment

Create `.env` file with your API keys:

```bash
# Copy and edit
echo "MOONSHOT_API_KEY=your-key-here" > .env
```

### Step 4: Start the Bot

```bash
# Start in background with logging
nohup node asymmetric-edge-bot.js > bot.log 2>&1 &

# Check status
tail -f bot.log
```

### Step 5: Monitor

```bash
# View recent activity
tail -100 bot.log

# Check if running
ps aux | grep asymmetric-edge-bot

# Stop the bot
pkill -f asymmetric-edge-bot
```

## Key Files

| File | Purpose |
|------|---------|
| `asymmetric-edge-bot.js` | Main orchestrator |
| `oracle-desk.js` | Real-time Binance WebSocket |
| `binance-oracle.js` | REST API + market discovery |
| `clipper-desk-manager.js` | All 5 trading strategies |
| `execution-desk.js` | Order execution + auto-flip |
| `treasury-desk.js` | Auto-redemption every 5 min |
| `virtual-account-manager.js` | Position & P&L tracking |

## Configuration

Edit `asymmetric-edge-bot.js` to adjust:

```javascript
// Manual balance (update to match Polymarket GUI)
const MANUAL_BALANCE = 36.36;

// Strategy parameters in clipper-desk-manager.js
MAX_PRICE_CAP = 0.85;      // Never pay more than 85 cents
MIN_EDGE_PCT = 3.0;        // Require 3% edge to trade
LOTTO_MAX_PRICE = 0.025;   // Lotto tickets at 2.5 cents max
DIP_BUY_PRICE = 0.47;      // Buy dips at 47 cents
```

## Risk Management

| Parameter | Value | Purpose |
|-----------|-------|---------|
| Max Price Cap | $0.85 | Never risk $0.85 to make $0.15 |
| Min Edge | 3% | Skip trades without clear advantage |
| Emergency Threshold | ±0.40% | Halt trading on violent moves |
| Lotto Budget | $1/ticket | Small bet, huge upside |
| Treasury Interval | 5 min | Auto-redeem winnings |

## Wealth Fortress (Profit Protection)

**NEW IN v2.1:** Prevents "giving back the gains" with automatic profit locking.

### The 3-Layer System

| Layer | Purpose | How It Works |
|-------|---------|--------------|
| **VAULT** | Locked savings | Profits protected from trading |
| **WAR CHEST** | Trading capital | Dynamic % based on balance tier |
| **RATCHET** | Auto-lock profits | 50% of new highs go to vault |

### Balance Tiers

| Phase | Balance | Trading % | Example |
|-------|---------|-----------|---------|
| BUILDER | $0-$500 | 80% | $80 tradeable of $100 |
| GROWTH | $500-$5k | 50% | $500 tradeable of $1k |
| WEALTH | $5k+ | $2.5k + 20% | $3.5k tradeable of $10k |

### Principal Shield

Once you **double your money** ($36 → $72+):
- Original $36 is **locked forever**
- You're now trading with "house money"
- Cannot lose your starting capital

### Example Protection

**Scenario:** $36 → $180 (wins) → losses

| Without Fortress | With Fortress |
|------------------|---------------|
| Back to $36 | Keep $92 |
| Lost 100% profit | Saved 39% |

### Monitor Status

```bash
grep WEALTH_FORTRESS bot.log | tail -5
```

## Autonomous Features

The bot runs fully autonomous:

- **Trades automatically** when edge detected
- **Skips bad trades** (no more $0.99 bids!)
- **Auto-redeems** winnings to USDC every 5 min
- **Emergency brake** on market crashes
- **Multiple strategies** for different conditions

## Monitoring Commands

```bash
# Live log tail
tail -f bot.log

# Recent trades only
grep -E "SUCCESS|FILLED|REDEEM" bot.log | tail -20

# Check errors
grep -i error bot.log | tail -10

# Treasury activity
grep TREASURY bot.log | tail -10

# Strategy activity
grep -E "SNIPER|OPENER|LOTTO|DIP" bot.log | tail -20
```

## Understanding Log Output

```json
{"action":"CLIPPER_EDGE_ANALYSIS",
 "fairValue":"0.650",
 "marketPrice":"0.550",
 "edge":"15.4%",
 "recommendation":"BUY"}
```

Key fields:
- `fairValue`: What the token should be worth
- `marketPrice`: What Polymarket is charging
- `edge`: Your expected advantage
- `recommendation`: BUY, SKIP, or NO_EDGE

## Troubleshooting

### Bot Not Trading
- Check if edge exists: Look for `CLIPPER_NO_EDGE` in logs
- Verify prices aren't too high (>$0.85 = skip)
- Ensure balance is sufficient

### Orders Not Filling
- Check `EXECUTION_DESK_BUY_UNFILLED` logs
- May need to adjust max price slightly

### Balance Not Updating
- Treasury runs every 5 min
- Check `TREASURY_SCAN_COMPLETE` logs
- Verify winning positions exist to redeem

### Emergency Triggered
- Look for `EMERGENCY_BRAKE_TRIGGERED`
- Binance moved >0.4% rapidly
- Bot will resume automatically

## Safety Features

1. **No $0.99 bids** - Uses fair value calculation
2. **Price cap at $0.85** - Won't overpay
3. **3% edge minimum** - Skips marginal trades
4. **Emergency brake** - Halts on crashes
5. **Auto-redemption** - Cash always available

## Updating Balance

When your Polymarket balance changes, update in code:

```javascript
// In asymmetric-edge-bot.js, line ~187
const MANUAL_BALANCE = 36.36; // Update this number
```

Then restart the bot.

## Architecture Deep Dive

See `DEPLOYMENT.md` for full technical documentation.

---

**Remember**: This is real money. The bot is designed to be conservative (skip bad trades) rather than aggressive (take every opportunity). Monitor the first few hours closely.
