# Polymarket Trading Bot - Quick Start Guide

## Overview

This is a professional-grade autonomous trading bot for Polymarket's 15-minute Bitcoin prediction markets. The bot uses 5 independent profit strategies with automatic cash recycling.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 ASYMMETRIC EDGE BOT v2.1                        │
│            "Set and Forget" with Profit Protection              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ╔═══════════════════════════════════════════════════════════╗  │
│  ║              WEALTH FORTRESS (Profit Protection)           ║  │
│  ║  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐║  │
│  ║  │   VAULT     │  │ WAR CHEST   │  │      RATCHET        │║  │
│  ║  │  (Locked)   │  │ (Tradeable) │  │  (Auto-lock at HWM) │║  │
│  ║  └─────────────┘  └─────────────┘  └─────────────────────┘║  │
│  ╚═══════════════════════════════════════════════════════════╝  │
│                              │                                   │
│                              ▼                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │  ORACLE DESK       Real-time Binance price stream           ││
│  │  CLIPPER DESK      5 trading strategies                     ││
│  │  EXECUTION DESK    Order placement + auto-flip              ││
│  │  TREASURY DESK     Auto-redeem winnings every 5 min         ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
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
| `wealth-fortress.js` | Profit protection & capital preservation |
| `black-box-recorder.js` | **NEW:** Flight data recorder - captures all decisions |
| `oracle-desk.js` | Real-time Binance WebSocket |
| `binance-oracle.js` | REST API + market discovery |
| `clipper-desk-manager.js` | All 5 trading strategies |
| `execution-desk.js` | Order execution + auto-flip |
| `treasury-desk.js` | Auto-redemption every 5 min |
| `virtual-account-manager.js` | Position & P&L tracking |
| `flight_data/` | **NEW:** Episode recordings (JSON files for analysis) |

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

### Why This Matters

```
WITHOUT FORTRESS:                    WITH FORTRESS:

$180 ───╮                           $180 ───╮
        │ WIN                               │ WIN
        │ STREAK                            │ STREAK (50% locked)
        │                                   │
        │ CRASH                            $92 ───── PROTECTED!
        │                                   │
$36 ────╯ Back to start              $36 ──╯

Lost: 100% of profits               Saved: 39% of profits
```

### The 3-Layer System

```
┌─────────────────────────────────────────────────────────────┐
│                    YOUR TOTAL BALANCE                        │
├────────────────────────┬────────────────────────────────────┤
│        VAULT           │           WAR CHEST                │
│     (Protected)        │          (Tradeable)               │
│                        │                                    │
│  ┌──────────────────┐  │  ┌────────────────────────────┐   │
│  │ Principal Shield │  │  │  FARM DESK      (60%)      │   │
│  │ (if 2x reached)  │  │  │  DEGEN DESK     (25%)      │   │
│  │                  │  │  │  CLIPPER DESK   (15%)      │   │
│  │ Locked Profits   │  │  └────────────────────────────┘   │
│  │ (50% of new ATH) │  │                                    │
│  └──────────────────┘  │  Bot only sees this amount!       │
│                        │                                    │
│   CANNOT BE TRADED     │   USED FOR TRADING                │
└────────────────────────┴────────────────────────────────────┘
```

| Layer | Purpose | How It Works |
|-------|---------|--------------|
| **VAULT** | Locked savings | Profits protected from trading |
| **WAR CHEST** | Trading capital | Dynamic % based on balance tier |
| **RATCHET** | Auto-lock profits | 50% of new highs go to vault |

### Balance Tiers (Dynamic Risk Curve)

| Phase | Balance Range | War Chest | Vault | Strategy |
|-------|---------------|-----------|-------|----------|
| 🏗️ **BUILDER** | $0 - $500 | **80%** | 20% | Aggressive growth |
| 🚀 **GROWTH** | $500 - $5k | **50%** | 50% | Balanced 50/50 |
| 🐋 **WEALTH** | $5k+ | **$2.5k + 20%** | Rest | Conservative power |

**Examples at Each Tier:**

| Your Balance | Phase | War Chest (Trades) | Vault (Safe) |
|--------------|-------|-------------------|--------------|
| $100 | BUILDER | $80 | $20 |
| $500 | GROWTH | $250 | $250 |
| $2,000 | GROWTH | $1,000 | $1,000 |
| $10,000 | WEALTH | $3,500 | $6,500 |

### Principal Shield

```
BEFORE DOUBLING:           AFTER DOUBLING ($72+):

├────────────────┤         ├───────┬────────────┤
│  $36 at risk   │    →    │ $36   │  Profits   │
│                │         │LOCKED │  (trade)   │
└────────────────┘         └───────┴────────────┘

                           Original $36 = SAFE FOREVER
                           Trading with "house money"
```

### Example Protection Scenario

**Starting balance:** $36

| Step | What Happens | Total | Vault | War Chest | Bot Sees |
|------|-------------|-------|-------|-----------|----------|
| 1 | Start | $36 | $0 | $28.80 | $28.80 |
| 2 | Win streak → $180 | $180 | $72 | $86.40 | $86.40 |
| 3 | 5 losing trades | $92 | $72 | $20 | $20 |
| 4 | **End result** | **$92** | **$72** | **$20** | **$20** |

**Saved: $56 of original $144 profit (39%)**

### Monitor Status

```bash
# View Wealth Fortress status
grep WEALTH_FORTRESS bot.log | tail -5

# Check if principal is secured
grep PRINCIPAL_SHIELD bot.log

# View profit locks at new ATHs
grep PROFIT_LOCKED bot.log
```

### Log Output Example

```json
{
  "action": "WEALTH_FORTRESS_SYNC",
  "phase": "🏗️ BUILDER",
  "totalEquity": "$180.00",
  "vault": "$72.00 (40% protected)",
  "warChest": "$86.40 (48% at risk)",
  "principal": "✅ SECURED",
  "highWaterMark": "$180.00"
}
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

| # | Feature | Protection |
|---|---------|------------|
| 1 | **No $0.99 bids** | Uses fair value calculation |
| 2 | **Price cap at $0.85** | Won't overpay for low edge |
| 3 | **3% edge minimum** | Skips marginal trades |
| 4 | **Emergency brake** | Halts on ±0.40% crashes |
| 5 | **Auto-redemption** | Cash always available |
| 6 | **Wealth Fortress** | Protects profits in vault |
| 7 | **Principal Shield** | Locks original investment when doubled |
| 8 | **Tiered allocation** | Reduces risk as balance grows |

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

## Black Box Recorder (Data Analysis)

**NEW IN v2.1:** Every window is recorded as a "flight data" episode.

### What Gets Recorded

| Data Type | Description |
|-----------|-------------|
| **Timeline** | Second-by-second BTC, Poly prices, volatility |
| **Decisions** | Every strategy check + why we did/didn't trade |
| **Actions** | Actual trades with prices and P&L |
| **Counterfactuals** | "What if?" analysis at window close |

### Why This Matters

After 50 windows, you can ask:
- *"What volatility yields the best lotto win rate?"*
- *"How many profitable dips did we miss?"*
- *"What's our win rate when delta > 0.2%?"*

### Viewing Episode Data

```bash
# View latest episode
ls -t scripts/flight_data/*.json | head -1 | xargs cat | jq '.'

# Count episodes
ls scripts/flight_data/*.json 2>/dev/null | wc -l

# View aggregate stats
cat scripts/flight_data/aggregate_stats.json | jq '.'

# Find missed opportunities
grep -l '"missedLotto": true' scripts/flight_data/*.json | wc -l
```

### Example Episode Output

```json
{
  "decisions": [
    { "strategy": "LOTTO_SCAN", "outcome": "REJECTED", "reason": "Low volatility" },
    { "strategy": "SNIPER_EDGE", "outcome": "ACCEPTED", "reason": "8% edge found" }
  ],
  "counterfactuals": {
    "missedLotto": false,
    "missedDip": true
  },
  "performance": {
    "pnl": 4.80,
    "won": true
  }
}
```

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────────┐
│                   BOT STATUS CHEAT SHEET                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  START:    nohup node asymmetric-edge-bot.js > bot.log 2>&1 &   │
│  STOP:     pkill -f asymmetric-edge-bot                         │
│  LOGS:     tail -f bot.log                                      │
│                                                                  │
│  CHECK FORTRESS:  grep WEALTH_FORTRESS bot.log | tail -3        │
│  CHECK TRADES:    grep SUCCESS bot.log | tail -10               │
│  CHECK ERRORS:    grep ERROR bot.log | tail -5                  │
│  CHECK EPISODES:  ls scripts/flight_data/*.json | wc -l         │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  PROTECTION TIERS:                                               │
│  ├── BUILDER ($0-$500):   80% tradeable, 20% protected          │
│  ├── GROWTH ($500-$5k):   50% tradeable, 50% protected          │
│  └── WEALTH ($5k+):       $2.5k + 20% surplus tradeable         │
│                                                                  │
│  PRINCIPAL SHIELD: Activated when balance ≥ 2× initial          │
│  RATCHET: Auto-locks 50% of profits at new ATH                  │
│                                                                  │
├─────────────────────────────────────────────────────────────────┤
│  BLACK BOX RECORDER:                                             │
│  ├── Episodes saved to: scripts/flight_data/                    │
│  ├── Tracks: decisions, actions, counterfactuals                │
│  └── Use for: optimization, debugging, backtesting              │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

**Remember**: This is real money. The bot is designed to be conservative (skip bad trades) rather than aggressive (take every opportunity). The Wealth Fortress protects your profits automatically, but monitor the first few hours closely.
