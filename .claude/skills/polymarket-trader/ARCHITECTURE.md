# Polymarket Trading Bot - System Architecture

## Overview

The trading system uses an **8-Player Trading Desk** architecture inspired by institutional trading operations. Each "player" is a specialized module with a distinct role in the decision-making and execution pipeline.

```
                    ┌─────────────────────────────────────────────────────┐
                    │              MARKET DATA AGGREGATOR                  │
                    │   (BTC price, orderbook, historical patterns)        │
                    └─────────────────────────┬───────────────────────────┘
                                              │
                    ┌─────────────────────────▼───────────────────────────┐
                    │           7-PLAYER ORCHESTRATION SYSTEM              │
                    │                                                      │
                    │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  │
                    │  │  FARM DESK  │  │ DEGEN DESK  │  │CLIPPER DESK │  │
                    │  │ (Conservat.)│  │ (Aggressive)│  │  (Exits)    │  │
                    │  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘  │
                    │         │                │                │         │
                    │         └────────┬───────┴────────┬───────┘         │
                    │                  ▼                ▼                  │
                    │         ┌─────────────────────────────────┐         │
                    │         │         SUPERVISOR              │         │
                    │         │  (Final approval & risk check)  │         │
                    │         └─────────────────┬───────────────┘         │
                    └───────────────────────────┼─────────────────────────┘
                                                │
                    ┌───────────────────────────▼─────────────────────────┐
                    │                 EXECUTION DESK                       │
                    │        (Order placement via pmarket-cli)             │
                    └─────────────────────────────────────────────────────┘
```

## The 8 Players

### 1. Market Data Aggregator
**Role**: Data collection and preprocessing

- Aggregates BTC price from Coinbase
- Fetches orderbook data from Polymarket CLOB
- Tracks window price movements (open/high/low/close)
- Calculates delta (price change since window open)
- Provides RSI and momentum indicators

**File**: `scripts/market-data-aggregator.js`

### 2. Farm Desk
**Role**: Conservative, institutional-style trading

- **Risk Profile**: Low (5-8% of balance per trade)
- **Strategy**: Wait for high-confidence setups with 2:1+ edge ratio
- **Entry**: Only when delta confirms direction
- **Exit**: Target 50%+ gains, willing to hold to settlement

**Characteristics**:
- Patient, methodical approach
- Prefers asymmetric risk/reward
- Will pass on marginal opportunities

### 3. Degen Desk
**Role**: Aggressive, opportunistic trading

- **Risk Profile**: Higher (10-15% of balance per trade)
- **Strategy**: Quick scalps, momentum plays, "lotto tickets"
- **Entry**: Any edge >55% confidence
- **Exit**: Quick clips at 30-50% gain

**Characteristics**:
- Prolific clipper (takes profits quickly)
- Places more frequent, smaller bets
- Accepts higher variance for higher potential returns

### 4. Clipper Desk
**Role**: Position management and exit timing

- Monitors open positions for clip opportunities
- Calculates optimal exit targets based on "vibes score"
- Manages time protection (exit before settlement risk)
- Coordinates between Farm and Degen positions

**File**: `scripts/clipper-desk-manager.js`

### 5. Supervisor
**Role**: Final approval and risk management

- Reviews all proposed trades from Farm and Degen
- Enforces portfolio-level risk limits
- Resolves conflicts between desks
- Can veto trades that exceed risk parameters

**File**: `scripts/moonshot-supervisor.js` (uses Moonshot AI for analysis)

### 6. Window Price Tracker
**Role**: Track price movements within trading windows

- Records open price when window starts
- Tracks delta (current price - open price)
- Provides delta percentage for direction confirmation
- Validates trade direction against price movement

**File**: `scripts/window-price-tracker.js`

### 7. Window History Tracker
**Role**: Historical analysis and pattern recognition

- Tracks win/loss history per window
- Identifies streak patterns
- Provides historical context for decisions
- Calculates correlation between delta and outcomes

**File**: `scripts/window-history-tracker.js`

### 8. Execution Desk (NEW)
**Role**: Order execution via pmarket-cli

- Receives approved trades from Supervisor
- Builds and executes pmarket-cli commands
- Parses CLI output (handles ASCII banner)
- Retries failed orders
- Reports fill data back to position tracker

**File**: `scripts/execution-desk.js`

## Data Flow

### Trade Decision Flow

```
1. NEW_WINDOW detected (900 seconds remaining)
   │
2. Market Data Aggregator collects:
   ├── BTC price from Coinbase
   ├── Orderbook from Polymarket
   └── Historical patterns
   │
3. At 850s remaining, 7-Player Orchestration begins:
   │
   ├── Farm Desk analyzes for conservative entry
   ├── Degen Desk looks for aggressive opportunities
   └── Clipper Desk checks existing positions
   │
4. Supervisor reviews all proposals:
   ├── Approves/rejects Farm trade
   ├── Approves/rejects Degen trade
   └── Sets position limits
   │
5. Approved trades sent to Execution Desk:
   │
   └── Execution Desk places orders via pmarket-cli
       ├── Parses orderbook
       ├── Builds order
       ├── Executes
       └── Reports fill
```

### Continuous Monitoring

```
Every 15 seconds:
├── Update BTC price
├── Recalculate delta
├── Check clip opportunities
└── Log status

At 180-120s remaining:
├── Clipper Desk evaluates straddle opportunity
└── Time protection kicks in (avoid settlement risk)

At window close:
├── Record outcome
├── Update history
└── Reset for next window
```

## Key Modules

### execution-desk.js

The Execution Desk provides reliable order placement:

```javascript
const ed = require('./execution-desk');

// Get current orderbook
const book = ed.getOrderbook(tokenId);
console.log('Best bid:', book.bestBid);
console.log('Best ask:', book.bestAsk);

// Place a buy order
const result = ed.placeBuyOrder(tokenId, amountUSDC, maxPrice);
if (result.success) {
  console.log('Filled:', result.sharesReceived, 'shares');
  console.log('Cost:', result.costUSDC);
  console.log('Order ID:', result.orderID);
}

// Execute approved trade from Supervisor
const trade = {
  desk: 'DEGEN',
  side: 'YES',
  amount: 3.50,
  maxPrice: 0.55,
  tokenId: '...'
};
const execution = ed.executeApprovedTrade(trade, market);
```

### Key Functions

| Function | Description |
|----------|-------------|
| `getOrderbook(tokenId)` | Fetch current orderbook for a token |
| `placeBuyOrder(tokenId, amount, price)` | Place a buy order with retries |
| `placeSellOrder(tokenId, shares, price)` | Place a sell order with retries |
| `cancelAllOrders()` | Cancel all open orders |
| `refreshAPIKeys()` | Regenerate API credentials |
| `executeApprovedTrade(trade, market)` | Execute a supervisor-approved trade |

## Configuration

### Risk Parameters (CONFIG)

```javascript
const CONFIG = {
  // Entry limits
  maxEntryPrice: 0.60,      // Never buy above 60 cents
  stopAddingPrice: 0.70,    // Stop adding above 70 cents

  // Position sizing
  positionSizing: {
    minPercentage: 0.10,    // 10% of balance (low confidence)
    maxPercentage: 0.25,    // 25% of balance (high conviction)
  },

  // Order limits
  maxOrdersPerWindow: 12,   // Max orders per 15-min window
  minTimeBetweenOrders: 30, // 30 seconds between orders

  // Window timing
  kimiConsultationWindow: [850, 750], // Orchestration at 850-750s
};
```

### Virtual Account Balances

```javascript
// Starting allocations
FARM:    $10.00  (66% of capital)
DEGEN:   $5.00   (33% of capital)
RESERVE: $3.14   (Safety buffer)
```

## Logging

All actions are logged as JSON for easy parsing:

```json
{"action":"7_PLAYER_ORCHESTRATION_START","window":"btc-updown-15m-1769735700","delta":"42.50","timeLeft":850}
{"action":"FARM_DECISION","approved":true,"side":"YES","amount":"2.50","edge":"0.72"}
{"action":"DEGEN_DECISION","approved":true,"side":"YES","amount":"3.35","lottoTicket":false}
{"action":"SUPERVISOR_APPROVED","farmApproved":true,"degenApproved":true}
{"action":"EXECUTION_DESK_BUY_ORDER","tokenId":"...","amountUSDC":"3.35","price":"0.4900"}
{"action":"EXECUTION_DESK_BUY_SUCCESS","orderID":"0x...","shares":6.84,"cost":"3.35","status":"matched"}
```

## Dependencies

### External
- `pmarket-cli` - Polymarket CLI for order placement
- Coinbase API - BTC price feed
- Polymarket Gamma API - Market discovery
- Moonshot API - AI-powered decision making (optional)

### Internal Modules
```
asymmetric-edge-bot.js          # Main trading loop
├── market-data-aggregator.js   # Data collection
├── trading-desk-orchestrator.js # 7-player coordination
├── virtual-account-manager.js  # Track desk balances
├── window-price-tracker.js     # Delta tracking
├── window-history-tracker.js   # Historical patterns
├── clipper-desk-manager.js     # Exit management
├── moonshot-supervisor.js      # AI supervision
├── execution-desk.js           # Order execution
└── dialogue-recorder.js        # Decision logging
```

## Running the Bot

### Prerequisites

1. Install pmarket-cli and configure credentials:
   ```bash
   npm install -g pmarket-cli
   pmarket-cli -k  # Generate API keys
   ```

2. Set environment variables:
   ```bash
   export MOONSHOT_API_KEY="your-key"  # Optional, for AI supervision
   ```

### Start Trading

```bash
# Navigate to scripts directory
cd ~/.claude/skills/polymarket-trader/scripts

# Run the bot
node asymmetric-edge-bot.js 2>&1 | tee /tmp/trading.log
```

### Monitor Output

```bash
# Watch live output
tail -f /tmp/trading.log | jq '.'

# Check for errors
grep -i error /tmp/trading.log

# View trades only
grep -E "BUY_SUCCESS|SELL_SUCCESS" /tmp/trading.log
```

## Troubleshooting

### "Unauthorized/Invalid api key" (401)

API keys expired. Regenerate:
```bash
pmarket-cli -k
```

### No orders being placed

Check:
1. Is orchestration completing? Look for `7_PLAYER_ORCHESTRATION_COMPLETE`
2. Is the Execution Desk being invoked? Look for `EXECUTION_DESK_BUY_ORDER`
3. Are there edge opportunities? Check `asymmetricSide` in STATUS logs

### Orders failing

1. Check balance: Ensure sufficient USDC in wallet
2. Check allowance: `pmarket-cli -a 1000` to set allowance
3. Check market: Ensure the window hasn't closed

## Version History

- **v1.0**: Basic momentum trading
- **v2.0**: Added asymmetric edge detection
- **v3.0**: 5-player orchestration (Farm, Degen, Clipper)
- **v4.0**: 7-player system (added Supervisor, Window Trackers)
- **v5.0**: 8-player system (added Execution Desk)
