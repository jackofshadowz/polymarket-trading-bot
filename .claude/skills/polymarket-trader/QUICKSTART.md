# Polymarket Trading Bot - Quick Start Guide

## Installation Complete! ✅

Your Polymarket trading skill has been installed for Clawdbot.

## File Structure

```
/Users/admin/Documents/Clawdbot/
├── .polymarket-credentials.env          # Your API credentials
└── .claude/skills/polymarket-trader/
    ├── SKILL.md                         # Main skill definition
    ├── README.md                        # Full documentation
    ├── QUICKSTART.md                    # This file
    └── scripts/
        ├── trader.js                    # Main trading bot
        ├── safe-trader.sh               # Safety wrapper
        └── setup.sh                     # Setup script
```

## Quick Start (3 Steps)

### Step 1: Load Your Credentials

```bash
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env
```

To make this permanent, add to your `~/.zshrc`:

```bash
echo 'source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env' >> ~/.zshrc
```

### Step 2: Test the Connection

```bash
# Load credentials first (from Step 1)
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env

# Run the trader (dry-run mode by default)
node .claude/skills/polymarket-trader/scripts/trader.js
```

You should see JSON output showing market analysis.

### Step 3: Use in Clawdbot

Once Clawdbot is running, invoke the skill:

```
/polymarket-trader analyze
```

## Your Wallet

- **Balance**: $61
- **Address**: `95e7b13f56fa54c7f8ee26892f08b1078c607ccbf5f98e440269665938d6eee9`
- **Objective**: Grow to $152.50 (2.5x) over 24 hours

## Safety Features 🛡️

### The bot is in DRY-RUN mode by default

- ✅ All analysis runs normally
- ✅ Trade signals are generated
- ❌ NO real orders are placed
- ❌ NO money is risked

### To Enable Live Trading

**⚠️ WARNING: This involves real money! ⚠️**

1. Open `trader.js`
2. Find line ~283: `// await placeOrder(...)`
3. Uncomment the line to enable live trading
4. Save the file

**OR** use the safe wrapper:

```bash
.claude/skills/polymarket-trader/scripts/safe-trader.sh --live analyze
```

## Available Commands

### Via Clawdbot Skill

```
/polymarket-trader analyze     # Analyze markets
/polymarket-trader balance     # Check wallet balance
/polymarket-trader positions   # View open positions
/polymarket-trader monitor     # Continuous monitoring
```

### Direct Script Execution

```bash
# Make sure credentials are loaded first!
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env

# Analyze markets
node .claude/skills/polymarket-trader/scripts/trader.js

# Using safe wrapper (recommended)
.claude/skills/polymarket-trader/scripts/safe-trader.sh analyze

# Continuous monitoring (every 5 minutes)
watch -n 300 '.claude/skills/polymarket-trader/scripts/safe-trader.sh analyze'
```

## Risk Management Parameters

Your current settings:

| Parameter | Value | Description |
|-----------|-------|-------------|
| **Max Position** | 20% | Max $12.20 per trade |
| **Min Position** | $5 | Minimum trade size |
| **Stop Loss** | -30% | Stop at $42.70 |
| **Take Profit** | 2.5x | Exit at $152.50 |
| **Confidence** | 65% | Min confidence to trade |
| **Max Positions** | 3 | Concurrent trades |

## Trading Strategy

The bot analyzes:

1. **Order Book Dynamics** - Bid/ask spread, volume imbalance
2. **Price Momentum** - 15-minute patterns and trends
3. **Market Sentiment** - News and social sentiment
4. **Historical Patterns** - Win rate of similar setups

Only trades when confidence ≥ 65% and conditions are favorable.

## Understanding the Output

The bot outputs structured JSON:

```json
{
  "action": "MARKET_ANALYSIS",
  "market": "Will Bitcoin price be above $89,500 in 15 minutes?",
  "analysis": {
    "momentum": "bullish",
    "confidence": 0.72,
    "recommendation": "BUY",
    "reasoning": [
      "Strong buy-side pressure detected",
      "Upward price momentum confirmed"
    ]
  }
}
```

Key fields:
- `confidence`: 0-1 scale (0.72 = 72% confident)
- `recommendation`: BUY, SELL, or HOLD
- `reasoning`: Why this decision was made

## Monitoring Performance

### View Logs

All decisions are logged to stdout. Redirect to a file:

```bash
node trader.js > trading-log.json 2>&1
```

### Track Metrics

- Balance changes
- Win rate
- Average profit per trade
- Risk-adjusted returns

## Next Steps

Based on the previous Clawdbot experiment results you shared:

> "The bot correctly identified that market conditions weren't optimal and avoided low-probability trades"

This shows the risk management is working! The bot will:

✅ Wait for high-confidence setups (≥65%)
✅ Avoid trading in low-volatility conditions
✅ Preserve capital during unclear markets
✅ Execute when conditions improve

### To Start Trading

1. **Load credentials**: `source .polymarket-credentials.env`
2. **Test dry-run**: `node trader.js`
3. **Review output**: Check confidence scores and reasoning
4. **Enable live trading**: Uncomment order placement in code
5. **Monitor closely**: Watch first few trades carefully
6. **Adjust parameters**: Tune based on performance

### Integration with Your Existing Setup

You mentioned having monitoring systems already running:
- `delta-dune`: Price monitor tracking BTC
- `lucky-sable`: Enhanced monitor generating signals

This new skill can work alongside those or replace them with a unified system.

## Troubleshooting

### "Credentials not loaded"

```bash
source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env
```

### "No markets found"

15-minute BTC markets may not be active. Check Polymarket.com.

### "Insufficient balance"

Ensure your wallet has at least $5 available.

### API Errors

Verify your credentials are correct and haven't expired.

## Safety Checklist

Before enabling live trading:

- [ ] Credentials loaded and verified
- [ ] Test run in dry-run mode successful
- [ ] Understand all risk parameters
- [ ] Comfortable with potential loss
- [ ] Monitoring strategy in place
- [ ] Ready to intervene if needed

## Resources

- **Full Documentation**: See `README.md` in this directory
- **Polymarket API**: https://docs.polymarket.com/
- **Clawdbot Skills**: https://code.claude.com/docs/en/skills.md

## Support

Questions? Issues?

1. Check `README.md` for detailed docs
2. Review JSON output for error messages
3. Verify API credentials
4. Test with smaller position sizes first

---

**Remember**: This involves real money. Start conservatively, monitor closely, and never risk more than you can afford to lose. The 2.5x gain referenced from the ClawdBot experiment is not guaranteed and market conditions vary significantly.

Good luck! 🦞📈
