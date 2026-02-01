# Polymarket Trading Bot - Technical Documentation

## System Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                     ASYMMETRIC EDGE BOT v2.1                        │
│              "Set and Forget" with Profit Protection                │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    WEALTH FORTRESS                           │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐   │   │
│  │  │    VAULT     │    │  WAR CHEST   │    │   RATCHET    │   │   │
│  │  │   (Locked)   │    │ (Tradeable)  │    │    (HWM)     │   │   │
│  │  │  Protected   │    │  Dynamic %   │    │ Auto-Lock    │   │   │
│  │  └──────────────┘    └──────────────┘    └──────────────┘   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│         │                       │                                   │
│         ▼                       ▼                                   │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐               │
│  │   ORACLE    │   │   CLIPPER   │   │  EXECUTION  │               │
│  │    DESK     │──▶│    DESK     │──▶│    DESK     │               │
│  │             │   │             │   │             │               │
│  │ Binance WS  │   │ 5 Strategies│   │ pmarket-cli │               │
│  │ Price Feed  │   │ Fair Value  │   │ Order Mgmt  │               │
│  └─────────────┘   └─────────────┘   └─────────────┘               │
│         │                                   │                       │
│         ▼                                   ▼                       │
│  ┌─────────────┐                    ┌─────────────┐                │
│  │  BINANCE    │                    │  TREASURY   │                │
│  │   ORACLE    │                    │    DESK     │                │
│  │             │                    │             │                │
│  │ REST API    │                    │ Auto-Redeem │                │
│  │ Latency Arb │                    │ Every 5 min │                │
│  └─────────────┘                    └─────────────┘                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

## File Structure

```
scripts/
├── asymmetric-edge-bot.js      # Main entry point & orchestrator
├── wealth-fortress.js          # NEW: Profit protection & capital preservation
├── oracle-desk.js              # Real-time Binance WebSocket stream
├── binance-oracle.js           # REST API fallback + market discovery
├── clipper-desk-manager.js     # All 5 trading strategies
├── execution-desk.js           # Order execution + auto-flip
├── treasury-desk.js            # Auto-redemption system
├── virtual-account-manager.js  # Position & P&L tracking
├── window-price-tracker.js     # Window open/close price tracking
├── window-history-tracker.js   # Historical pattern analysis
├── market-data-aggregator.js   # Data aggregation utilities
├── dialogue-recorder.js        # Trade decision logging
├── leaderboard-tracker.js      # Performance tracking
└── .env                        # API keys (not committed)
```

---

## Wealth Fortress (Capital Preservation System)

### The Problem: "Giving Back the Gains"

```
THE TRADER'S TRAGEDY (Without Protection):

   $180 ────────────────────────────╮
    │                               │
    │  ╭─── WIN STREAK ───╮         │
    │  │  All profits at  │         │  CRASH
    │  │  risk in trading │         │
    │  ╰──────────────────╯         │
   $36 ─────────────────────────────╯─────── Back to start!
        Start                        End

Result: 100% of profits LOST
```

```
THE FORTRESS SOLUTION (With Protection):

   $180 ────────────────────────────╮
    │                               │
    │  ╭─── WIN STREAK ───╮         │  CRASH
    │  │ 50% auto-locked  │         │  (only hits
    │  │   to VAULT       │         │   War Chest)
    │  ╰──────────────────╯         │
   $92 ─────────────────────────────╯─────── Protected!
   $36 ─────────────────────────────────────
        Start                        End

Result: 39% of profits SAVED ($56 of $144)
```

### The Solution: 3-Layer Protection

```
┌─────────────────────────────────────────────────────────────────────┐
│                       WEALTH FORTRESS                                │
│                  Capital Preservation System                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   TOTAL EQUITY ($180)                                               │
│   ════════════════════════════════════════════════════════════════  │
│                                                                      │
│   ┌──────────────────────────┐  ┌──────────────────────────────┐   │
│   │        THE VAULT         │  │        THE WAR CHEST         │   │
│   │     (Locked Savings)     │  │     (Trading Capital)        │   │
│   │                          │  │                              │   │
│   │   ┌──────────────────┐   │  │   ┌──────────────────────┐   │   │
│   │   │  Principal $36   │   │  │   │   FARM DESK (60%)    │   │   │
│   │   │  (if doubled)    │   │  │   │   DEGEN DESK (25%)   │   │   │
│   │   ├──────────────────┤   │  │   │   CLIPPER DESK (15%) │   │   │
│   │   │  Locked Profits  │   │  │   └──────────────────────┘   │   │
│   │   │  $36 (50% of     │   │  │                              │   │
│   │   │   new profits)   │   │  │   Dynamic % based on tier:  │   │
│   │   └──────────────────┘   │  │   BUILDER: 80%              │   │
│   │                          │  │   GROWTH:  50%              │   │
│   │   Total: $72             │  │   WEALTH:  $2.5k + 20%      │   │
│   │   UNTOUCHABLE            │  │                              │   │
│   │                          │  │   Current: $86.40            │   │
│   └──────────────────────────┘  └──────────────────────────────┘   │
│          40% Protected                    48% At Risk               │
│                                                                      │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │                    THE RATCHET (HWM Lock)                     │  │
│   │   At new all-time high: Auto-lock 50% of new profits         │  │
│   │   High Water Mark: $180.00                                    │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### Layer Details

#### 1. THE VAULT (Locked Savings)

| Feature | Description |
|---------|-------------|
| Visibility | **INVISIBLE** to trading desks |
| Access | Manual override only |
| Contents | Principal (if doubled) + Locked profits |
| Protection | Cannot be lost through trading |

#### 2. THE WAR CHEST (Dynamic Trading Capital)

| Phase | Balance Range | War Chest % | Vault % | Strategy |
|-------|---------------|-------------|---------|----------|
| 🏗️ **BUILDER** | $0 - $500 | **80%** | 20% | Aggressive growth |
| 🚀 **GROWTH** | $500 - $5,000 | **50%** | 50% | Balanced 50/50 |
| 🐋 **WEALTH** | $5,000+ | **$2,500 + 20% surplus** | Rest | Conservative power |

**War Chest Examples:**

| Total Equity | Phase | War Chest | Vault | Bot Sees |
|-------------|-------|-----------|-------|----------|
| $100 | BUILDER | $80 | $20 | $80 |
| $500 | GROWTH | $250 | $250 | $250 |
| $1,000 | GROWTH | $500 | $500 | $500 |
| $5,000 | WEALTH | $2,500 | $2,500 | $2,500 |
| $10,000 | WEALTH | $3,500 | $6,500 | $3,500 |
| $50,000 | WEALTH | $11,500 | $38,500 | $11,500 |

#### 3. THE RATCHET (High Water Mark Profit Lock)

```
RATCHET MECHANISM:

Balance hits new ATH ($180)
         │
         ▼
    ╔═══════════════════════════════╗
    ║  Calculate new profit:        ║
    ║  $180 - $36 (previous HWM)    ║
    ║  = $144 new profit            ║
    ╚═══════════════════════════════╝
         │
         ▼
    ╔═══════════════════════════════╗
    ║  Lock 50% to Vault:           ║
    ║  $144 × 0.50 = $72            ║
    ║  → Vault now has $72          ║
    ╚═══════════════════════════════╝
         │
         ▼
    ╔═══════════════════════════════╗
    ║  Update High Water Mark:      ║
    ║  HWM = $180                   ║
    ╚═══════════════════════════════╝
```

### Principal Shield

| Milestone | Action | Result |
|-----------|--------|--------|
| Balance ≥ 2× Initial | Lock initial investment | Original capital SAFE FOREVER |
| $36 → $72+ | Auto-lock $36 | Playing with "house money" |

```
PRINCIPAL SHIELD ACTIVATION:

Before:  $36 initial → at risk
         ├────────────────────┤

After doubling ($72+):
         ├───────┬────────────┤
         │ $36   │  Profits   │
         │LOCKED │  (trade)   │
         └───────┴────────────┘

Result: Cannot lose original investment!
```

### Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    CAPITAL FLOW THROUGH SYSTEM                       │
└─────────────────────────────────────────────────────────────────────┘

   REAL BALANCE (Polymarket API)
         │
         ▼
   ┌─────────────────┐
   │ WEALTH FORTRESS │
   │     sync()      │
   └────────┬────────┘
            │
    ┌───────┴───────┐
    │               │
    ▼               ▼
┌────────┐    ┌──────────┐
│ VAULT  │    │WAR CHEST │
│(locked)│    │(tradeable│
└────────┘    └────┬─────┘
                   │
         ┌─────────┼─────────┐
         │         │         │
         ▼         ▼         ▼
    ┌────────┐ ┌────────┐ ┌────────┐
    │  FARM  │ │ DEGEN  │ │CLIPPER │
    │  60%   │ │  25%   │ │  15%   │
    └────────┘ └────────┘ └────────┘
         │         │         │
         └─────────┴─────────┘
                   │
                   ▼
            ┌─────────────┐
            │  EXECUTION  │
            │    DESK     │
            └─────────────┘
                   │
                   ▼
            ┌─────────────┐
            │  POLYMARKET │
            │   ORDERS    │
            └─────────────┘
```

### Configuration

Edit `wealth-fortress.js`:

```javascript
// Protection ratios
this.PROFIT_SKIM_RATIO = 0.50;    // Lock 50% of profits at HWM

// Tier boundaries
BUILDER: { maxBalance: 500, warChestRatio: 0.80 }
GROWTH:  { maxBalance: 5000, warChestRatio: 0.50 }
WEALTH:  { baseWarChest: 2500, surplusRatio: 0.20 }
```

### Log Output

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

### Monitoring Commands

```bash
# View Wealth Fortress status
grep WEALTH_FORTRESS bot.log | tail -10

# Check profit locks
grep PROFIT_LOCKED bot.log | tail -5

# Check principal shield
grep PRINCIPAL_SHIELD bot.log

# View phase changes
grep WEALTH_PHASE_CHANGE bot.log
```

## The 5 Trading Strategies

### 1. SNIPER (Fair Value Edge)

**Purpose**: Only trade when mathematical edge exists

**Logic**:
```javascript
fairValue = 0.50 + tanh(deltaPct × 3) × 0.40 × timeFactor
edge = fairValue - marketPrice
if (edge >= 0.03) TRADE else SKIP
```

**Parameters**:
- `MAX_PRICE_CAP`: 0.85 (never pay more)
- `MIN_EDGE_PCT`: 3% (minimum advantage)
- `MAX_SLIPPAGE`: 0.02 (2 cents above fair value)

**Files**: `clipper-desk-manager.js:calculateFairValue()`, `calculateEdge()`

---

### 2. OPENER (Trend Continuation)

**Purpose**: Pre-bid on next window based on current momentum

**Logic**:
```
IF current window has strong momentum (YES > 55% or < 45%)
AND delta > 0.08%
THEN bid $0.51 on NEXT window's same direction
```

**Parameters**:
- `OPENER_TARGET_PRICE`: 0.51
- `OPENER_MAX_PRICE`: 0.54
- `OPENER_WINDOW`: 60-10 seconds before close

**Files**: `clipper-desk-manager.js:evaluateOpenerOpportunity()`, `executeOpenerBet()`

---

### 3. DIP SCALPER (Rebound)

**Purpose**: Buy panic dips when Binance says trend is intact

**Logic**:
```
IF polymarket price dips to $0.47
AND binance delta > -0.05% (trend intact)
THEN buy the dip
WHEN price rebounds to $0.75 THEN sell (60% profit)
```

**Parameters**:
- `DIP_BUY_PRICE`: 0.47
- `DIP_SCALP_TARGET_PCT`: 1.60 (60% profit)
- `DIP_TIME_STOP_SECONDS`: 60 (force sell before close)
- `DIP_STOP_LOSS_PCT`: -0.05% (exit if trend breaks)

**Files**: `clipper-desk-manager.js:evaluateDipOpportunity()`, `executeDipBuy()`, `checkDipAutoFlip()`

---

### 4. LOTTO (Moonshot Tickets)

**Purpose**: Buy cheap tickets when volatility suggests possible reversal

**Logic**:
```
IF price <= $0.025 (2.5 cents)
AND volatility > 0.05%
AND 180s > timeLeft > 30s
THEN buy $1 lotto ticket (potential 50x)
```

**Parameters**:
- `LOTTO_MAX_PRICE`: 0.025
- `LOTTO_BET_SIZE`: 1.00 (dollars)
- `LOTTO_MIN_VOLATILITY`: 0.05%

**Files**: `clipper-desk-manager.js:scanForLottoTickets()`, `executeLottoBuy()`

---

### 5. EMERGENCY BRAKE (Capital Preservation)

**Purpose**: Protect capital during market crashes

**Logic**:
```
IF binance delta > +0.40% OR < -0.40%
THEN cancel all open bids
AND panic sell YES positions if crashing
```

**Files**: `execution-desk.js:emergencyCancelAllBuys()`, `emergencyPanicSell()`

---

## Oracle System

### oracle-desk.js (WebSocket)

Real-time price streaming via Binance WebSocket:

```javascript
ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade')
```

**Features**:
- ~200ms faster than REST API
- Calculates: delta, deltaPct, volatility
- Safety flags: isCrashing, isPumping, isChoppy
- Auto-reconnect on disconnect

### binance-oracle.js (REST API)

Fallback for WebSocket + additional features:

**Functions**:
- `getBinancePrice()` - Quick REST price check
- `detectLatencyEdge()` - Compare Binance vs Polymarket pricing
- `quickDeltaCheck()` - Fast delta calculation
- `getNextBtcMarket()` - Discover upcoming markets via Gamma API

---

## Execution System

### execution-desk.js

Interfaces with `pmarket-cli` for order management.

**Order Types**:
- `placeBuyOrder()` - Buy with retry logic
- `placeSellOrder()` - Sell with retry logic
- `placeDipBuyWithAutoFlip()` - Buy + automatic sell at target

**Auto-Flip Logic**:
```javascript
// When buy fills, automatically post sell at target
activeFlipOrders.set(orderId, {
  entryPrice: 0.47,
  targetPrice: 0.75,
  status: 'HOLDING'
})
```

**Emergency Functions**:
- `emergencyCancelAllBuys()` - Cancel all open orders
- `emergencyPanicSell()` - Dump positions at any price

---

## Treasury System

### treasury-desk.js

Automatic redemption of winning positions.

**Heartbeat**: Every 5 minutes

**Process**:
1. Scan for redeemable positions
2. Call `pmarket-cli -r` for each
3. Convert winning shares to USDC
4. Log all redemptions to `treasury-log.json`

**Functions**:
- `redeemAllWinnings()` - Main redemption scan
- `redeemToken(tokenId)` - Redeem specific token
- `getPositions()` - Get current holdings
- `startHeartbeat()` - Start background loop

---

## Decision Flow

```
Every 5 seconds:

1. EMERGENCY CHECK
   │
   ├─ Binance delta > ±0.40%? ──▶ HALT + Cancel + Panic Sell
   │
   ▼
2. LOTTO CHECK (if 180-30s remaining)
   │
   ├─ Price ≤ $0.025 + High volatility? ──▶ Buy $1 ticket
   │
   ▼
3. OPENER CHECK (if 60-10s remaining)
   │
   ├─ Strong momentum? ──▶ Pre-bid $0.51 on next window
   │
   ▼
4. SNIPER CHECK (if 300-120s remaining)
   │
   ├─ Fair value edge ≥ 3%? ──▶ Place limit order
   │
   ▼
5. DIP SCALPER CHECK (continuous)
   │
   ├─ Monitor existing dips for auto-flip
   ├─ Scan for new $0.47 dip opportunities
   │
   ▼
6. Wait 5 seconds, repeat
```

---

## Deployment

### Start Bot

```bash
cd /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts
nohup node asymmetric-edge-bot.js > bot.log 2>&1 &
```

### Stop Bot

```bash
pkill -f asymmetric-edge-bot
```

### View Logs

```bash
tail -f bot.log                    # Live view
grep SUCCESS bot.log | tail -20    # Recent wins
grep ERROR bot.log | tail -10      # Errors
grep TREASURY bot.log | tail -10   # Redemptions
```

---

## Configuration

### Environment Variables

```bash
# .env file
MOONSHOT_API_KEY=sk-xxx  # Optional: AI consultation
```

### Strategy Parameters

Edit `clipper-desk-manager.js`:

```javascript
// Fair Value
MAX_PRICE_CAP = 0.85
MIN_EDGE_PCT = 3.0

// Opener
OPENER_TARGET_PRICE = 0.51
OPENER_MAX_PRICE = 0.54

// Dip Scalper
DIP_BUY_PRICE = 0.47
DIP_MIN_REBOUND_PRICE = 0.75

// Lotto
LOTTO_MAX_PRICE = 0.025
LOTTO_BET_SIZE = 1.00
LOTTO_MIN_VOLATILITY = 0.05

// Treasury
REDEMPTION_INTERVAL_MS = 5 * 60 * 1000
```

### Balance Configuration

Edit `asymmetric-edge-bot.js`:

```javascript
const MANUAL_BALANCE = 36.36;  // Match Polymarket GUI
```

---

## Log Format

All logs are JSON for easy parsing:

```json
{
  "action": "CLIPPER_BET_SUCCESS",
  "window": "btc-updown-15m-1769802300",
  "side": "YES",
  "shares": "10.50",
  "avgPrice": "0.475",
  "cost": "$5.00",
  "edge": "8.2%",
  "expectedProfit": "$0.86",
  "timestamp": "2026-01-30T21:15:30.123Z"
}
```

---

## Troubleshooting

### Bot Not Trading

1. Check logs for `CLIPPER_NO_EDGE` - prices may not have edge
2. Verify `MAX_PRICE_CAP` isn't blocking trades
3. Ensure sufficient balance

### Orders Not Filling

1. Check `EXECUTION_DESK_BUY_UNFILLED` logs
2. Price may have moved too fast
3. Consider adjusting slippage

### Treasury Not Redeeming

1. Check `TREASURY_SCAN_COMPLETE` logs
2. May not have winning positions
3. Markets may not be resolved yet

### WebSocket Disconnects

1. Bot auto-reconnects (see `ORACLE_DISCONNECTED`)
2. Check internet connection
3. Binance may be under maintenance

---

## Security Notes

- API keys stored in `.env` (gitignored)
- No private keys in code
- Uses pmarket-cli for wallet operations
- Emergency brake protects capital

---

## Dependencies

- Node.js v18+
- ws (WebSocket)
- dotenv (env vars)
- pmarket-cli (Polymarket CLI)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| **v2.1** | 2026-01-31 | Wealth Fortress profit protection, tiered allocation, principal shield |
| v2.0 | 2026-01-30 | Fair value system, 5 strategies, auto-redemption, treasury desk |
| v1.x | Legacy | Basic momentum trading (deprecated)

### v2.1 Changelog (Wealth Fortress)

- **NEW:** `wealth-fortress.js` - Capital preservation system
- **NEW:** Vault/War Chest split (dynamic based on balance tier)
- **NEW:** Principal Shield (lock original investment when doubled)
- **NEW:** Ratchet system (auto-lock 50% of profits at new ATH)
- **NEW:** Phase-based risk curve (BUILDER → GROWTH → WEALTH)
- **CHANGED:** Trading desks now see War Chest, not total equity
- **CHANGED:** Balance sync triggers Wealth Fortress protection
- **ADDED:** Wealth Fortress status in STATUS logs
