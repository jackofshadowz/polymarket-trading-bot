# Polymarket Trading Bot - System Architecture

## Overview

This is an autonomous trading bot for Polymarket's 15-minute BTC prediction markets. It bets on whether Bitcoin's price will be UP or DOWN at the end of each 15-minute window compared to the opening price.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        POLYMARKET 15-MIN BTC MARKETS                        │
│                                                                             │
│   Window 1: 15:00-15:15    Window 2: 15:15-15:30    Window 3: 15:30-15:45  │
│   ┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐    │
│   │ Open: $77,000   │      │ Open: $77,150   │      │ Open: $77,200   │    │
│   │ Close: $77,150  │      │ Close: $77,050  │      │ Close: ???      │    │
│   │ Result: YES     │      │ Result: NO      │      │ Result: ???     │    │
│   └─────────────────┘      └─────────────────┘      └─────────────────┘    │
│                                                                             │
│   YES Token: Pays $1 if BTC UP      NO Token: Pays $1 if BTC DOWN         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## System Components

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              MAIN BOT PROCESS                                │
│                         (asymmetric-edge-bot.js)                             │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │   BINANCE   │    │   MARKET    │    │   WINDOW    │    │   GEMINI    │  │
│  │   ORACLE    │───▶│    DATA     │───▶│   PRICE     │───▶│   GATES     │  │
│  │ (WebSocket) │    │ AGGREGATOR  │    │  TRACKER    │    │  (Filters)  │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│        │                  │                  │                  │          │
│        ▼                  ▼                  ▼                  ▼          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        TRADING DECISION ENGINE                       │   │
│  │  • Asymmetric Edge Detection (buy cheap, sell high)                 │   │
│  │  • Sequential Scalping (momentum-based entries)                      │   │
│  │  • Delta Prediction (BTC price vs window open)                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                        │
│                                    ▼                                        │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │  EXECUTION  │    │  VIRTUAL    │    │   WEALTH    │    │   TRADE     │  │
│  │    DESK     │◀──▶│  ACCOUNTS   │◀──▶│  FORTRESS   │    │   LOGGER    │  │
│  │ (Orders)    │    │ (Positions) │    │ (Risk Mgmt) │    │ (Learning)  │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│        │                                                                    │
│        ▼                                                                    │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                          POLYMARKET API                              │   │
│  │                    (pmarket-cli / CLOB API)                          │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Component Details

### 1. Binance Oracle (binance-oracle.js)

**Purpose:** Real-time BTC price feed via WebSocket

```
┌─────────────────────────────────────────────────────────┐
│                    BINANCE WEBSOCKET                     │
│                                                          │
│   wss://stream.binance.com:9443/ws/btcusdt@trade        │
│                         │                                │
│                         ▼                                │
│   ┌─────────────────────────────────────────────────┐   │
│   │  Price Update Every ~100ms                       │   │
│   │  • CURRENT_PRICE = 77,145.23                    │   │
│   │  • PRICE_LAST_UPDATED = 1706799234567           │   │
│   │  • Staleness Check: Max 10 seconds              │   │
│   └─────────────────────────────────────────────────┘   │
│                         │                                │
│                         ▼                                │
│   If price > 10s old → HALT TRADING (stale data)        │
└─────────────────────────────────────────────────────────┘
```

**Example:**
```javascript
// Price arrives from Binance
{ price: "77145.23", timestamp: 1706799234567 }

// Bot calculates delta from window open
Window Open: $77,000.00
Current:     $77,145.23
Delta:       +$145.23 (0.19%)
Prediction:  YES (BTC is UP)
```

---

### 2. Window Price Tracker (window-price-tracker.js)

**Purpose:** Track each 15-minute window's opening price and calculate delta

```
┌─────────────────────────────────────────────────────────┐
│              WINDOW PRICE TRACKING                       │
│                                                          │
│   Window: btc-updown-15m-1769959800                     │
│   ┌─────────────────────────────────────────────────┐   │
│   │  Open Price:  $77,092.80 (captured at start)    │   │
│   │  Current:     $77,145.23                        │   │
│   │  Delta:       +$52.43                           │   │
│   │  Delta %:     +0.068%                           │   │
│   │  Predicted:   YES                               │   │
│   └─────────────────────────────────────────────────┘   │
│                                                          │
│   Delta History (for weighted average):                  │
│   ┌─────────────────────────────────────────────────┐   │
│   │  T-5min: +$20    ──┐                            │   │
│   │  T-4min: +$35      │                            │   │
│   │  T-3min: +$45      ├── Weighted Delta:          │   │
│   │  T-2min: +$48      │   (0.7 × $52) + (0.3 × $35)│   │
│   │  T-1min: +$50      │   = $36.4 + $10.5 = $46.9  │   │
│   │  NOW:    +$52    ──┘                            │   │
│   └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

### 3. Gemini Strategy Gates (NEW - Just Implemented)

**Purpose:** Filter trades based on Gemini AI recommendations

```
┌─────────────────────────────────────────────────────────────────────┐
│                        GEMINI STRATEGY GATES                         │
│                                                                      │
│   Trade Request: BUY YES at 35¢                                     │
│                         │                                            │
│                         ▼                                            │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  GATE 1: TIMING GATE                                         │   │
│   │  ────────────────────                                        │   │
│   │  • Only trade when 240-300 seconds left                      │   │
│   │  • Current: 387s → BLOCKED (too early)                       │   │
│   │  • Current: 270s → ALLOWED                                   │   │
│   │  • Current: 180s → BLOCKED (too late)                        │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                         │ PASS                                       │
│                         ▼                                            │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  GATE 2: DELTA THRESHOLD                                     │   │
│   │  ───────────────────────                                     │   │
│   │  • YES requires delta > +$50                                 │   │
│   │  • NO requires delta < -$50                                  │   │
│   │  • Current: +$52.43 for YES → ALLOWED                        │   │
│   │  • Current: +$30 for YES → BLOCKED (too small)               │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                         │ PASS                                       │
│                         ▼                                            │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  GATE 2B: DELTA MAGNITUDE                                    │   │
│   │  ────────────────────────                                    │   │
│   │  • Absolute delta must be > $25                              │   │
│   │  • |+$52| = $52 > $25 → ALLOWED                              │   │
│   │  • |+$15| = $15 < $25 → BLOCKED (consolidation)              │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                         │ PASS                                       │
│                         ▼                                            │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  GATE 3: ORDERBOOK BAR CONFIRMATION                          │   │
│   │  ──────────────────────────────────                          │   │
│   │  BAR = Bid Volume / Ask Volume                               │   │
│   │                                                              │   │
│   │  • BAR > 1.30: Strong bullish (confirms YES)                 │   │
│   │  • BAR > 1.15: Moderate bullish                              │   │
│   │  • BAR < 0.85: Moderate bearish (confirms NO)                │   │
│   │  • BAR < 0.70: Strong bearish                                │   │
│   │                                                              │   │
│   │  Current: BAR = 1.25 for YES prediction → ALLOWED            │   │
│   │  Current: BAR = 0.75 for YES prediction → BLOCKED            │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                         │ PASS                                       │
│                         ▼                                            │
│                   TRADE APPROVED                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 4. Virtual Account Manager (virtual-account-manager.js)

**Purpose:** Track positions across 3 trading desks without touching real funds

```
┌─────────────────────────────────────────────────────────────────────┐
│                      VIRTUAL ACCOUNT SYSTEM                          │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────┐    │
│   │                    ASYMMETRIC ALPHA FUND                    │    │
│   │                    Total Balance: $21.18                    │    │
│   └────────────────────────────────────────────────────────────┘    │
│                              │                                       │
│            ┌─────────────────┼─────────────────┐                    │
│            ▼                 ▼                 ▼                    │
│   ┌────────────────┐ ┌────────────────┐ ┌────────────────┐         │
│   │   FARM DESK    │ │   DEGEN DESK   │ │  CLIPPER DESK  │         │
│   │     (60%)      │ │     (25%)      │ │     (15%)      │         │
│   ├────────────────┤ ├────────────────┤ ├────────────────┤         │
│   │ Balance: $12.71│ │ Balance: $5.30 │ │ Balance: $3.17 │         │
│   │ Strategy:      │ │ Strategy:      │ │ Strategy:      │         │
│   │ Conservative   │ │ High-risk      │ │ Quick clips    │         │
│   │ edge plays     │ │ lotto tickets  │ │ profit-taking  │         │
│   └────────────────┘ └────────────────┘ └────────────────┘         │
│                                                                      │
│   Position Tracking Example:                                         │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  FARM Desk Open Positions:                                    │  │
│   │  ┌──────────────────────────────────────────────────────┐    │  │
│   │  │ Window: btc-updown-15m-1769959800                     │    │  │
│   │  │ Side: YES                                             │    │  │
│   │  │ Entry Price: $0.35                                    │    │  │
│   │  │ Shares: 7.14                                          │    │  │
│   │  │ Cost Basis: $2.50                                     │    │  │
│   │  │ Current Value: $3.21 (if YES wins: 7.14 × $1)        │    │  │
│   │  │ Unrealized P&L: +$0.71 (+28.4%)                       │    │  │
│   │  └──────────────────────────────────────────────────────┘    │  │
│   └──────────────────────────────────────────────────────────────┘  │
│                                                                      │
│   Settlement (when window closes):                                   │
│   ┌──────────────────────────────────────────────────────────────┐  │
│   │  Window Result: YES (BTC went UP)                             │  │
│   │  Position Side: YES                                           │  │
│   │  OUTCOME: WIN                                                 │  │
│   │                                                               │  │
│   │  Payout = Shares × $1 = 7.14 × $1 = $7.14                    │  │
│   │  Cost Basis = $2.50                                          │  │
│   │  Profit = $7.14 - $2.50 = $4.64                              │  │
│   │  ROI = 185.6%                                                 │  │
│   │                                                               │  │
│   │  FARM Balance: $12.71 + $4.64 = $17.35                       │  │
│   └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 5. Wealth Fortress (wealth-fortress.js)

**Purpose:** Capital protection and profit locking

```
┌─────────────────────────────────────────────────────────────────────┐
│                        WEALTH FORTRESS                               │
│                    "Never Give Back Profits"                         │
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                    TOTAL EQUITY: $21.18                      │   │
│   │              High Water Mark: $101.44                        │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│               ┌──────────────┴──────────────┐                       │
│               ▼                              ▼                       │
│   ┌─────────────────────┐        ┌─────────────────────┐           │
│   │       VAULT         │        │     WAR CHEST       │           │
│   │  (Protected Profits)│        │  (Tradeable Capital)│           │
│   ├─────────────────────┤        ├─────────────────────┤           │
│   │     $3.23 (15%)     │        │    $16.94 (80%)     │           │
│   │                     │        │                     │           │
│   │  UNTOUCHABLE        │        │  Available for      │           │
│   │  Can only GROW      │        │  trading            │           │
│   │  Locks at new HWM   │        │                     │           │
│   └─────────────────────┘        └─────────────────────┘           │
│                                                                      │
│   PHASES:                                                            │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  Phase 1: BUILDER (Current)                                  │   │
│   │  • Vault grows 15% of new profits                           │   │
│   │  • War Chest available for trading                          │   │
│   │  • Principal NOT yet secured                                │   │
│   │                                                              │   │
│   │  Phase 2: PROTECTOR (When balance ≥ 2× initial)             │   │
│   │  • Vault locks 25% of profits                               │   │
│   │  • Principal secured                                        │   │
│   │                                                              │   │
│   │  Phase 3: COMPOUNDER (When balance ≥ 4× initial)            │   │
│   │  • Vault locks 50% of profits                               │   │
│   │  • Aggressive profit protection                             │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   HIGH WATER MARK LOCK:                                              │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  When equity hits new high:                                  │   │
│   │  1. Record new HWM                                          │   │
│   │  2. Calculate profits above previous HWM                    │   │
│   │  3. Lock 15-50% into Vault (based on phase)                 │   │
│   │  4. Vault balance can NEVER decrease                        │   │
│   │                                                              │   │
│   │  Example:                                                    │   │
│   │  • Previous HWM: $100                                       │   │
│   │  • New Balance: $110                                        │   │
│   │  • Profit: $10                                              │   │
│   │  • Vault Lock: $10 × 15% = $1.50 → Vault                   │   │
│   │  • New HWM: $110                                            │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 6. Execution Desk (execution-desk.js)

**Purpose:** Place actual orders on Polymarket

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EXECUTION DESK                               │
│                   "The Bridge to Polymarket"                         │
│                                                                      │
│   Trade Request:                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  Side: YES                                                   │   │
│   │  Amount: $2.50                                              │   │
│   │  Max Price: 0.35 (35¢)                                      │   │
│   │  Token ID: 0x123...abc                                      │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  PRE-FLIGHT CHECKS                                           │   │
│   │  ──────────────────                                          │   │
│   │  1. ✓ Token ID valid                                        │   │
│   │  2. ✓ Amount > 0                                            │   │
│   │  3. ✓ Price within range (0.01 - 0.99)                      │   │
│   │  4. ✓ Sufficient balance in wallet                          │   │
│   │  5. ✓ Not exceeding per-window cap                          │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  MINIMUM SHARE BOOST                                         │   │
│   │  ───────────────────                                         │   │
│   │  Polymarket requires minimum 5 shares per order              │   │
│   │                                                              │   │
│   │  Requested: $2.50 at 35¢ = 7.14 shares ✓ OK                 │   │
│   │  Requested: $1.00 at 35¢ = 2.86 shares ✗ Too few            │   │
│   │                                                              │   │
│   │  If shares < 5:                                              │   │
│   │    Boost amount to: 5 shares × price = $1.75 minimum        │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  ORDER PLACEMENT (via pmarket-cli)                           │   │
│   │  ─────────────────────────────────                           │   │
│   │  $ pmarket order buy 0x123...abc 7.14 0.35                  │   │
│   │                                                              │   │
│   │  Response:                                                   │   │
│   │  {                                                           │   │
│   │    "success": true,                                          │   │
│   │    "orderID": "order_abc123",                               │   │
│   │    "avgFillPrice": 0.342,                                   │   │
│   │    "totalShares": 7.31,                                     │   │
│   │    "actualCost": 2.50                                       │   │
│   │  }                                                           │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                              │                                       │
│                              ▼                                       │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  POST-TRADE RECORDING                                        │   │
│   │  ────────────────────                                        │   │
│   │  1. Record in Virtual Accounts (position tracking)          │   │
│   │  2. Log for adaptive learning (trade log)                   │   │
│   │  3. Update capitalLocked                                    │   │
│   │  4. Update windowState.ordersPlaced                         │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

### 7. Adaptive Position Sizing (Gemini Recommendation)

**Purpose:** Size positions based on confidence and consecutive wins

```
┌─────────────────────────────────────────────────────────────────────┐
│                    ADAPTIVE POSITION SIZING                          │
│                                                                      │
│   Base Rule: 2.5% of War Chest                                      │
│   Scale-Up: 3.5% after 3+ consecutive wins                          │
│   Maximum: 10% per trade                                            │
│   Floor: Minimum 5 shares (Polymarket requirement)                  │
│                                                                      │
│   Example with $20 War Chest:                                        │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  Scenario 1: Normal (0-2 consecutive wins)                   │   │
│   │  ──────────────────────────────────────                      │   │
│   │  Target: $20 × 2.5% = $0.50                                  │   │
│   │  BUT: Min shares = 5 × $0.35 = $1.75                         │   │
│   │  RESULT: Use $1.75 (floor applies)                           │   │
│   │                                                              │   │
│   │  Scenario 2: Confident (3+ consecutive wins)                 │   │
│   │  ───────────────────────────────────────                     │   │
│   │  Target: $20 × 3.5% = $0.70                                  │   │
│   │  BUT: Min shares = 5 × $0.35 = $1.75                         │   │
│   │  RESULT: Use $1.75 (floor still applies)                     │   │
│   │                                                              │   │
│   │  Scenario 3: Large Balance ($100)                            │   │
│   │  ────────────────────────────────                            │   │
│   │  Target: $100 × 2.5% = $2.50                                 │   │
│   │  Min shares = 5 × $0.35 = $1.75                              │   │
│   │  RESULT: Use $2.50 (target > floor)                          │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   Consecutive Wins Tracking:                                         │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  Window 1: WIN  → CONSECUTIVE_WINS = 1                       │   │
│   │  Window 2: WIN  → CONSECUTIVE_WINS = 2                       │   │
│   │  Window 3: WIN  → CONSECUTIVE_WINS = 3 → Scale up to 3.5%   │   │
│   │  Window 4: LOSS → CONSECUTIVE_WINS = 0 → Back to 2.5%       │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Complete Trade Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          COMPLETE TRADE FLOW                                 │
│                                                                              │
│   TIME: 15:08:30 (Window: 15:00-15:15, 390 seconds left)                    │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 1: MARKET DATA COLLECTION                                      │   │
│   │  ────────────────────────────────                                    │   │
│   │  • Binance Price: $77,145.23                                        │   │
│   │  • Window Open: $77,092.80                                          │   │
│   │  • Delta: +$52.43 (+0.068%)                                         │   │
│   │  • YES Price: 50.5¢ | NO Price: 49.5¢                               │   │
│   │  • Orderbook BAR: 1.18 (moderate bullish)                           │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 2: GEMINI GATE CHECKS                                          │   │
│   │  ───────────────────────────                                         │   │
│   │  Gate 1 - Timing: 390s left                                         │   │
│   │           Need 240-300s                                              │   │
│   │           RESULT: ❌ BLOCKED (too early, wait 90s)                   │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│                            [WAIT 90 SECONDS]                                 │
│                                    │                                         │
│   TIME: 15:10:00 (300 seconds left)                                         │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 2 (RETRY): GEMINI GATE CHECKS                                  │   │
│   │  ───────────────────────────────────                                 │   │
│   │  Gate 1 - Timing: 300s left ✓ PASS                                  │   │
│   │  Gate 2 - Delta Threshold: +$52 > +$50 ✓ PASS                       │   │
│   │  Gate 2B - Delta Magnitude: |$52| > $25 ✓ PASS                      │   │
│   │  Gate 3 - BAR Confirmation: 1.18 > 1.00 for YES ✓ PASS              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 3: EDGE DETECTION                                              │   │
│   │  ───────────────────────                                             │   │
│   │  Current YES price: 50.5¢                                           │   │
│   │  Need price < 60¢ for asymmetric edge                               │   │
│   │  RESULT: ❌ NO EDGE (price too close to 50%)                         │   │
│   │                                                                      │   │
│   │  [Price moves... YES drops to 35¢]                                  │   │
│   │                                                                      │   │
│   │  Current YES price: 35¢                                             │   │
│   │  Edge Ratio: (1.00 - 0.35) / 0.35 = 1.86:1                          │   │
│   │  Value Tier: GREAT_VALUE                                            │   │
│   │  RESULT: ✓ EDGE FOUND                                               │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 4: POSITION SIZING                                             │   │
│   │  ───────────────────────────                                         │   │
│   │  War Chest: $16.94                                                  │   │
│   │  Consecutive Wins: 1 (< 3, use 2.5%)                                │   │
│   │  Target: $16.94 × 2.5% = $0.42                                      │   │
│   │  Min Shares Floor: 5 × $0.35 = $1.75                                │   │
│   │  RESULT: $1.75 (floor applies)                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 5: CAPITAL LOCKING                                             │   │
│   │  ───────────────────────────                                         │   │
│   │  Per-Window Cap: $4.00                                              │   │
│   │  Currently Locked: $0.00                                            │   │
│   │  After This Trade: $1.75                                            │   │
│   │  RESULT: ✓ WITHIN CAP                                               │   │
│   │                                                                      │   │
│   │  windowState.capitalLocked += $1.75                                 │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 6: ORDER EXECUTION                                             │   │
│   │  ────────────────────────                                            │   │
│   │  $ pmarket order buy [YES_TOKEN] 5.0 0.35                           │   │
│   │                                                                      │   │
│   │  Response:                                                           │   │
│   │  • Order ID: order_xyz789                                           │   │
│   │  • Fill Price: 34.2¢ (got better price!)                            │   │
│   │  • Shares: 5.12                                                     │   │
│   │  • Cost: $1.75                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 7: RECORD KEEPING                                              │   │
│   │  ───────────────────────                                             │   │
│   │  • Virtual Accounts: Add position to FARM desk                      │   │
│   │  • Trade Log: Record for adaptive learning                          │   │
│   │  • Window State: ordersPlaced++, update chosenSide                  │   │
│   │  • Black Box: Record tick for analysis                              │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   TIME: 15:15:00 (Window Closes)                                            │
│                                                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 8: SETTLEMENT                                                  │   │
│   │  ──────────────────                                                  │   │
│   │  Final BTC Price: $77,180.50                                        │   │
│   │  Window Open: $77,092.80                                            │   │
│   │  Delta: +$87.70 → BTC went UP                                       │   │
│   │  WINNER: YES                                                        │   │
│   │                                                                      │   │
│   │  Our Position: YES                                                  │   │
│   │  OUTCOME: WIN! 🎉                                                   │   │
│   │                                                                      │   │
│   │  Payout: 5.12 shares × $1.00 = $5.12                               │   │
│   │  Cost: $1.75                                                        │   │
│   │  Profit: $5.12 - $1.75 = $3.37                                     │   │
│   │  ROI: +192.6%                                                       │   │
│   │                                                                      │   │
│   │  CONSECUTIVE_WINS: 1 → 2                                            │   │
│   │  Trade Log: outcome = "WIN"                                         │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                    │                                         │
│                                    ▼                                         │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  STEP 9: WEALTH FORTRESS SYNC                                        │   │
│   │  ────────────────────────────                                        │   │
│   │  Previous Balance: $21.18                                           │   │
│   │  New Balance: $21.18 + $3.37 = $24.55                              │   │
│   │                                                                      │   │
│   │  New High Water Mark? YES (was $21.18)                              │   │
│   │  Profit to Lock: $3.37 × 15% = $0.51                               │   │
│   │  New Vault: $3.23 + $0.51 = $3.74                                  │   │
│   │  New War Chest: $24.55 - $3.74 = $20.81                            │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   READY FOR NEXT WINDOW...                                                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Memory & Persistence

```
┌─────────────────────────────────────────────────────────────────────┐
│                        MEMORY ARCHITECTURE                           │
│                                                                      │
│   RUNTIME MEMORY (Lost on restart):                                  │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  MEMORY = {                                                  │   │
│   │    currentWindow: { slug, timeLeft },                       │   │
│   │    windowState: { per-window tracking },                    │   │
│   │    priceHistory: [ last N prices ],                         │   │
│   │    deltaHistory: [ last 5 min deltas ],                     │   │
│   │    activeBalance: 16.94,                                    │   │
│   │    realBalance: 21.18                                       │   │
│   │  }                                                           │   │
│   │                                                              │   │
│   │  CONSECUTIVE_WINS = 2                                        │   │
│   │  CURRENT_PRICE = 77145.23                                   │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│   PERSISTENT FILES (Survive restart):                                │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │  /tmp/polymarket-virtual-accounts.json                       │   │
│   │  ├── Fund total balance                                     │   │
│   │  ├── Desk balances (FARM, DEGEN, CLIPPER)                   │   │
│   │  ├── Open positions                                         │   │
│   │  └── Trade statistics                                       │   │
│   │                                                              │   │
│   │  /tmp/wealth-fortress-state.json                            │   │
│   │  ├── Vault balance                                          │   │
│   │  ├── High water mark                                        │   │
│   │  ├── Current phase                                          │   │
│   │  └── Lifetime locked profits                                │   │
│   │                                                              │   │
│   │  /tmp/polymarket-trade-log.json (NEW - Gemini)              │   │
│   │  ├── Trade entry conditions                                 │   │
│   │  ├── Delta at entry                                         │   │
│   │  ├── BAR at entry                                           │   │
│   │  ├── Outcome (WIN/LOSS)                                     │   │
│   │  └── Used for win rate analysis                             │   │
│   │                                                              │   │
│   │  /tmp/polymarket-leaderboard.json                           │   │
│   │  ├── Per-desk performance                                   │   │
│   │  ├── Win/loss streaks                                       │   │
│   │  └── Milestones achieved                                    │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Key Configuration

```javascript
// Gemini Strategy Configuration (NEW)
CONFIG = {
  // Entry timing: Only trade in last 4-5 minutes
  entryTimingGate: {
    enabled: true,
    minTimeLeftSeconds: 240,  // 4 min
    maxTimeLeftSeconds: 300   // 5 min
  },

  // Delta thresholds: Require significant movement
  deltaThresholds: {
    YES: 50,   // +$50 for YES
    NO: -50    // -$50 for NO
  },

  // Delta magnitude: Skip consolidation
  deltaMagnitudeGate: {
    enabled: true,
    minMagnitude: 25  // |delta| > $25
  },

  // Orderbook confirmation
  orderbook: {
    strongBullish: 1.30,
    moderateBullish: 1.15,
    moderateBearish: 0.85,
    strongBearish: 0.70
  },

  // Position sizing (Gemini conservative)
  positionSizing: {
    targetPercent: 0.025,     // 2.5%
    scaleUpThreshold: 3,      // After 3 wins
    scaleUpPercent: 0.035,    // 3.5%
    maxPercent: 0.10          // Never > 10%
  },

  // Emergency panic sell: DISABLED
  emergencyPanicSell: {
    enabled: false
  }
};
```

---

## Audit Status

| Component | Status | Notes |
|-----------|--------|-------|
| Timing Gate | ✅ Working | Blocks trades outside 240-300s window |
| Delta Threshold | ✅ Working | Requires +$50/-$50 |
| Delta Magnitude | ✅ Working | Blocks when |delta| < $25 |
| BAR Confirmation | ✅ Working | Checks orderbook alignment |
| Position Sizing | ⚠️ Edge Case | Min floor can exceed max % |
| Capital Locking | ✅ Working | Prevents over-betting |
| Settlement | ✅ Working | Race condition protected |
| Trade Logging | ⚠️ Incomplete | Outcomes not updated at settlement |
| Panic Sell | ✅ Disabled | Per Gemini recommendation |

---

*Document generated: 2026-02-01*
*Bot Version: Asymmetric Edge Bot with Gemini Improvements*
