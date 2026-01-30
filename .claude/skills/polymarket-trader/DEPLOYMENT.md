# Autonomous Trading System - Deployment Guide

## 🚀 System Overview

This is a fully autonomous trading system for Polymarket that:

✅ **Scans ALL markets** for profitable opportunities (not just BTC)
✅ **Detects arbitrage** between orderbook, external data, and market pricing
✅ **Uses external information** (live BTC prices, news, etc.) to find edges
✅ **Trades short-term markets** (closing within 7 days for quick turnaround)
✅ **Runs continuously** with automatic crash recovery
✅ **Manages risk** with position limits, stop losses, and circuit breakers
✅ **Places REAL trades** with your authorized $61 balance

## 📊 Trading Strategies

### 1. **Information Arbitrage**
- Monitors real-time BTC prices from Coinbase/Binance
- Compares with Polymarket BTC price prediction markets
- Detects mispricing >15% and trades the edge
- Example: BTC at $89,500, market asks "Above $90k?" priced at 20% → BUY (expected 50%)

### 2. **Orderbook Imbalance**
- Analyzes bid/ask volume ratios
- Detects strong directional pressure (>75% one-sided)
- Trades with the flow when imbalance indicates mispricing

### 3. **Time Arbitrage**
- Markets closing within 30 minutes
- Outcome already determined but price not adjusted
- Fast execution before market closes

### 4. **Momentum Trading**
- 24h price changes >10%
- Volume spikes >3x average
- Continuation patterns

### 5. **Statistical Arbitrage**
- Crossed orderbooks (instant profit)
- Tight spreads with extreme pricing
- Expected value vs market price divergence

## 🎯 Risk Management

| Parameter | Value | Description |
|-----------|-------|-------------|
| Starting Balance | $61 | Your authorized capital |
| Max Position Size | 20% ($12) | Per trade limit |
| Min Position Size | $5 | Minimum trade |
| Max Positions | 3 | Concurrent trades |
| Confidence Threshold | 65% | Minimum to trade |
| Stop Loss | -30% ($42.70) | Circuit breaker |
| Take Profit | 2.5x ($152.50) | Auto-exit target |
| Max Time to Close | 7 days | Short-term only |

## 🛠️ Installation & Deployment

### Quick Start (3 Commands)

```bash
# 1. Load credentials
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env

# 2. Test single scan
node /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts/enhanced-trader.js

# 3. Start continuous monitoring
/Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts/daemon.sh
```

### Detailed Setup

#### 1. Verify Credentials

```bash
echo $POLYMARKET_API_KEY  # Should output your API key
```

If empty:
```bash
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env
```

#### 2. Test External Data Sources

```bash
node /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts/info-edge.js
```

Should output current BTC price from multiple sources.

#### 3. Run Single Trading Scan

```bash
cd /Users/admin/Documents/Clawdbot
source .polymarket-credentials.env
node .claude/skills/polymarket-trader/scripts/enhanced-trader.js
```

This will:
- Check balance
- Scan up to 200 markets
- Filter for short-term, liquid markets
- Analyze each for opportunities
- Place trades if confidence ≥65%

#### 4. Start Continuous Daemon

```bash
.claude/skills/polymarket-trader/scripts/daemon.sh
```

This runs FOREVER until:
- Circuit breaker hits (-30% loss)
- Take profit reached (2.5x gain)
- Manual stop (Ctrl+C)
- Too many crashes (10 in 1 hour)

## 📝 Monitoring & Logs

### Real-Time Monitoring

**View live logs:**
```bash
tail -f ~/.polymarket-trader/logs/latest.log
```

**Check if running:**
```bash
cat ~/.polymarket-trader/daemon.pid
ps aux | grep enhanced-trader
```

**View all logs:**
```bash
ls -lh ~/.polymarket-trader/logs/
```

### Log Format

Every action is logged as JSON:

```json
{
  "action": "TRADE_OPPORTUNITY",
  "market": "Will Bitcoin close above $90,000 today?",
  "type": "PRICE_ARBITRAGE",
  "recommendation": "BUY",
  "confidence": 0.78,
  "price": 0.45,
  "size": 10,
  "reasoning": [
    "BTC currently at $91,200",
    "Market threshold: $90,000",
    "Market pricing: 45%",
    "Expected probability: 85%",
    "Mispricing: 40%"
  ],
  "timestamp": "2026-01-28T00:15:32.123Z"
}
```

### Key Log Actions

- `MONITORING_START` - Daemon started
- `SCAN_START` - Beginning market scan
- `BALANCE_CHECK` - Current balance & P/L
- `MARKETS_SCANNED` - How many markets found
- `OPPORTUNITIES_FOUND` - High-confidence trades identified
- `TRADE_OPPORTUNITY` - Details of potential trade
- `ORDER_PLACED` - Real order executed
- `ORDER_FAILED` - Trade attempt failed
- `CIRCUIT_BREAKER` - Stop loss triggered
- `TAKE_PROFIT` - Profit target reached

## 🔍 Understanding Output

### Example Scan Cycle

```json
{"action":"SCAN_START","timestamp":"2026-01-28T00:15:00.000Z"}
{"action":"BALANCE_CHECK","balance":61,"profit":0,"loss":0,"netPL":0}
{"action":"MARKETS_SCANNED","count":47}
{"action":"OPPORTUNITIES_FOUND","count":2}

{"action":"TRADE_OPPORTUNITY",
 "market":"Will BTC hit $100k by Friday?",
 "type":"PRICE_ARBITRAGE",
 "confidence":0.82,
 "recommendation":"BUY",
 "price":0.35,
 "size":12,
 "reasoning":["BTC at $98,500", "Only $1500 away", "Closes in 36 hours"]}

{"action":"ORDER_PLACED",
 "trade":{"market":"...","side":"BUY","price":0.35,"size":12}}
```

### What The Bot Looks For

**High Confidence Signals (≥65%):**

1. **BTC $1000 from threshold, closing in 24h** → 80% confidence
2. **Orderbook 85% buy-side** → 75% confidence
3. **Volume spike 5x + momentum** → 70% confidence
4. **Crossed orderbook** → 95% confidence
5. **Market closes in 15 min, outcome clear** → 90% confidence

**Ignored Signals (<65%):**

- Neutral orderbooks
- Low volume markets
- Uncertain outcomes
- Long time to close (>7 days)
- Insufficient edge

## 📈 Performance Tracking

### Check Current Status

```bash
# View latest balance
tail -1 ~/.polymarket-trader/logs/latest.log | grep BALANCE_CHECK

# Count trades placed
grep ORDER_PLACED ~/.polymarket-trader/logs/latest.log | wc -l

# View all opportunities found
grep TRADE_OPPORTUNITY ~/.polymarket-trader/logs/latest.log
```

### Expected Performance

Based on the ClawdBot $100→$347 experiment:

- **Time horizon**: 8-24 hours
- **Return**: 2-3x
- **Win rate**: 60-70%
- **Avg trade**: 5-15 minutes to close

Your setup:
- **Capital**: $61
- **Target**: $152.50 (2.5x)
- **Strategy**: More aggressive (any profitable market)
- **Edge**: External data integration

## 🛑 Stopping the Bot

### Graceful Stop

```bash
# Find PID
cat ~/.polymarket-trader/daemon.pid

# Send interrupt signal
kill -INT $(cat ~/.polymarket-trader/daemon.pid)
```

Or just press `Ctrl+C` if running in foreground.

### Force Stop

```bash
pkill -9 -f enhanced-trader
rm ~/.polymarket-trader/daemon.pid
```

## 🔧 Troubleshooting

### No Opportunities Found

**Cause**: Markets don't meet criteria (liquidity, time to close, confidence)

**Solutions**:
1. Lower confidence threshold: Edit `enhanced-trader.js`, change `confidenceThreshold: 0.55`
2. Increase time window: Change `maxDaysOut = 14` for longer-term markets
3. Lower volume requirement: Change minimum volume from 1000 to 500

### Authentication Errors

```bash
# Re-source credentials
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env

# Verify loaded
echo $POLYMARKET_API_KEY
```

### Bot Keeps Crashing

Check logs:
```bash
grep ERROR ~/.polymarket-trader/logs/latest.log
```

Common issues:
- API rate limiting (will auto-retry)
- Network timeouts (will auto-restart)
- Insufficient balance (check on Polymarket.com)

### Orders Not Filling

Markets may have:
- Insufficient liquidity
- Price moved away
- Order rejected by exchange

Check Polymarket.com → Orders tab for status.

## 🎛️ Configuration

### Adjust Risk Parameters

Edit `/Users/admin/Documents/Clawdbot/.polymarket-credentials.env`:

```bash
export MAX_POSITION_SIZE=0.15        # More conservative (15%)
export CONFIDENCE_THRESHOLD=0.70     # Higher bar (70%)
export MAX_CONCURRENT_POSITIONS=2    # Fewer positions
```

### Change Scan Frequency

Edit `enhanced-trader.js`:

```javascript
scanInterval: 60000,  // Scan every 1 minute (more aggressive)
// OR
scanInterval: 300000, // Scan every 5 minutes (more conservative)
```

## 📊 Example Profitable Scenarios

### Scenario 1: BTC Price Arbitrage

**Market**: "Will Bitcoin close above $89,000 today?"
**Current BTC Price**: $91,500
**Market Price**: 55% YES
**Time to Close**: 4 hours

**Analysis**:
- BTC is $2,500 above threshold
- Very unlikely to drop $2,500 in 4 hours
- Expected probability: 85%
- Market mispricing: 30%
- **Action**: BUY YES at 55% → Confidence 82%

**Expected Return**: 1.8x (55¢ → $1.00)

### Scenario 2: Time Arbitrage

**Market**: "Will team X win this game?"
**Game Status**: Team X won (final score confirmed)
**Market Price**: 82% YES
**Time to Close**: 12 minutes

**Analysis**:
- Outcome is certain (game over)
- Market not fully adjusted
- Should be 99%+
- **Action**: BUY YES at 82% → Confidence 95%

**Expected Return**: 1.22x (82¢ → $1.00)

### Scenario 3: Orderbook Imbalance

**Market**: "Will inflation report be above 3%?"
**Bids**: $15,000
**Asks**: $2,000
**Ratio**: 88% buy-side

**Analysis**:
- Extreme buy pressure
- Insiders likely know outcome
- Follow the smart money
- **Action**: BUY YES → Confidence 72%

## 🚨 Safety Features

The bot will **automatically stop** if:

1. ❌ Balance drops below $42.70 (-30%)
2. ✅ Balance reaches $152.50 (+150%)
3. ⚠️ More than 10 crashes in 1 hour
4. 🛑 Manual interrupt (Ctrl+C)

All trades are logged with full reasoning for audit.

## 📞 Support & Monitoring

### Health Check

```bash
# Is it running?
ps aux | grep enhanced-trader

# Recent activity?
ls -lt ~/.polymarket-trader/logs/ | head -5

# Any errors?
grep -i error ~/.polymarket-trader/logs/latest.log | tail -10
```

### View P&L

```bash
# Latest balance check
grep BALANCE_CHECK ~/.polymarket-trader/logs/latest.log | tail -1 | jq
```

## 🎯 Optimization Tips

### For More Trades:
- Lower `confidenceThreshold` to 0.60
- Increase `maxDaysOut` to 14 days
- Decrease `minPositionSize` to $3

### For Higher Win Rate:
- Raise `confidenceThreshold` to 0.75
- Decrease `maxDaysOut` to 3 days
- Only trade `PRICE_ARBITRAGE` and `TIME_ARBITRAGE`

### For Faster Turnaround:
- Only trade markets closing < 24 hours
- Focus on event-based markets (sports, announcements)
- Use higher scan frequency (1 minute)

## 🔬 Scientific Experiment Notes

**Duration**: Running for ~3-7 days
**Purpose**: Test autonomous trading strategies
**Capital**: $61 (authorized for scientific purposes)
**Hypothesis**: Information arbitrage + orderbook analysis can generate 2-3x returns

**Data Collection**:
- All trades logged with reasoning
- External market conditions recorded
- Performance metrics tracked
- Edge types categorized

**Expected Outcomes**:
1. Identify which strategies work best
2. Measure win rate by opportunity type
3. Optimize parameters for future runs
4. Validate arbitrage detection algorithms

---

## 🚀 Ready to Deploy

**Final Checklist:**

- [x] Credentials loaded
- [x] External data sources working
- [x] Risk parameters configured
- [x] Logging directory created
- [x] Real trading enabled
- [x] Daemon script ready

**Launch Command:**

```bash
cd /Users/admin/Documents/Clawdbot
source .polymarket-credentials.env
.claude/skills/polymarket-trader/scripts/daemon.sh
```

**Monitor:**

```bash
tail -f ~/.polymarket-trader/logs/latest.log
```

Good luck with your scientific experiment! 🦞📈
