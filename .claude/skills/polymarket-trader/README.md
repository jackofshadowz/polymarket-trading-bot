# Polymarket Trading Bot - Clawdbot Skill

Autonomous trading bot for Polymarket's 15-minute Bitcoin price prediction markets.

## Features

- 🤖 AI-driven market analysis
- 📊 Real-time orderbook and sentiment analysis
- 🎯 Conservative risk management with Kelly Criterion position sizing
- 🛡️ Multiple safety controls and circuit breakers
- 📝 Complete trade logging and reasoning
- 🔄 Self-reflection and strategy adjustment

## Setup

### 1. Install Dependencies

No external dependencies required - uses Node.js built-in modules only.

### 2. Configure Credentials

Run the setup script:

```bash
bash .claude/skills/polymarket-trader/scripts/setup.sh
```

Enter your Polymarket API credentials when prompted:
- API Key
- Secret
- Passphrase
- Wallet Address

### 3. Load Environment Variables

```bash
source ~/.polymarket-trader.env
```

Or add to your shell profile:

```bash
echo 'source ~/.polymarket-trader.env' >> ~/.zshrc
```

## Your Credentials

Based on your provided information:

```bash
export POLYMARKET_API_KEY="your-api-key-here"
export POLYMARKET_SECRET="your-secret-here"
export POLYMARKET_PASSPHRASE="your-passphrase-here"
export POLYMARKET_ADDRESS="your-wallet-address-here"
```

## Usage

### Via Clawdbot Skill

Invoke the skill in Clawdbot:

```
/polymarket-trader analyze
```

Actions available:
- `analyze` - Analyze current markets without trading
- `trade` - Execute trades based on analysis (with confirmation)
- `balance` - Check account balance
- `positions` - View open positions
- `monitor` - Continuous monitoring mode

### Direct Script Execution

```bash
# Analyze markets
node .claude/skills/polymarket-trader/scripts/trader.js

# Check balance
POLYMARKET_API_KEY=xxx node trader.js balance

# Monitor continuously
watch -n 300 'node trader.js'  # Every 5 minutes
```

## Trading Strategy

### Objective
Maximize profits on 15-minute BTC price markets while protecting capital.

### Risk Management

| Parameter | Value | Description |
|-----------|-------|-------------|
| Max Position Size | 20% | Maximum % of balance per trade |
| Min Position Size | $5 | Minimum trade size |
| Stop Loss | -30% | Cease trading if down 30% |
| Take Profit | 2.5x | Target return (e.g., $61 → $152.50) |
| Max Positions | 3 | Concurrent open positions |
| Confidence Threshold | 65% | Minimum confidence to trade |

### Analysis Framework

1. **Order Book Analysis**
   - Bid/ask spread and liquidity
   - Volume imbalance (buy vs sell pressure)
   - Market depth

2. **Technical Analysis**
   - 15-minute price momentum
   - Moving averages
   - RSI and volatility indicators

3. **Sentiment Analysis**
   - Twitter/X mentions and sentiment
   - News events
   - Correlation with spot BTC price

4. **Pattern Recognition**
   - Historical 15-min pattern analysis
   - Win rate of similar setups
   - Market behavior patterns

### Position Sizing

Uses **fractional Kelly Criterion** (25% of full Kelly for safety):

```javascript
edgeRatio = (confidence - 0.5) * 2
kellyFraction = edgeRatio / 1
conservativeKelly = kellyFraction * 0.25
positionSize = balance * min(conservativeKelly, MAX_POSITION_SIZE)
```

Example:
- Balance: $61
- Confidence: 70% (0.70)
- Edge: (0.70 - 0.50) * 2 = 0.40
- Kelly: 0.40 * 0.25 = 0.10 (10%)
- Position: $61 * 0.10 = $6.10

## Safety Features

### Automatic Safeguards

1. **Balance Checks** - Verify sufficient funds before trading
2. **Position Limits** - Enforce max position size and count
3. **Confidence Gates** - Only trade when confidence ≥65%
4. **Slippage Protection** - Limit orders at specific prices
5. **Circuit Breakers** - Stop if losses exceed threshold

### Manual Controls

- Order placement is **commented out by default**
- Requires explicit code uncommenting to enable live trading
- All analysis runs in simulation mode first
- Full logging of all decisions and reasoning

## Output Format

All output is structured JSON for easy parsing:

```json
{
  "action": "MARKET_ANALYSIS",
  "market": "Will Bitcoin price be above $89,500 in 15 minutes?",
  "tokenId": "123456",
  "analysis": {
    "momentum": "bullish",
    "confidence": 0.72,
    "recommendation": "BUY",
    "reasoning": [
      "Strong buy-side pressure detected",
      "Upward price momentum confirmed"
    ]
  },
  "currentPrice": 0.58,
  "timestamp": "2026-01-27T18:30:00.000Z"
}
```

## Performance Tracking

The bot logs:
- Every market analysis
- Trade signals and rationale
- Order placements and fills
- Position management decisions
- P&L by trade and cumulative

Review logs to:
- Understand decision-making
- Identify successful patterns
- Refine strategy parameters
- Track performance metrics

## Experimental Results

From the ClawdBot experiment referenced:
- Initial capital: $100
- Final capital: $347
- Return: 2.5x (247% gain)
- Time period: Overnight (~8-12 hours)
- Strategy: Multi-dimensional analysis with compounding

Your setup:
- Initial capital: $61
- Target: 2.5x = $152.50
- Time period: 24 hours
- Strategy: Conservative with strict risk controls

## Risk Warnings

⚠️ **Important Disclaimers**

- Prediction markets involve real financial risk
- Past performance does not guarantee future results
- The bot can lose money, potentially all capital
- Markets can be illiquid or have unfavorable pricing
- Technical issues may prevent proper execution
- This is experimental software - use at your own risk

**Only risk capital you can afford to lose completely.**

## Troubleshooting

### Authentication Errors

```bash
# Verify credentials are loaded
echo $POLYMARKET_API_KEY

# Test connection
node trader.js
```

### No Markets Found

15-minute BTC markets may not always be available. Check Polymarket.com for active markets.

### API Rate Limits

The bot respects rate limits. If you hit limits, reduce polling frequency.

## Advanced Configuration

Edit `trader.js` directly to customize:

```javascript
const CONFIG = {
  maxPositionSize: 0.20,     // 20% max
  minPositionSize: 5,        // $5 min
  maxLoss: 0.30,            // Stop at -30%
  takeProfitTarget: 2.5,    // Exit at 2.5x
  // ... more parameters
};
```

## Contributing

To improve the trading strategy:

1. Modify analysis logic in `analyzeMarket()`
2. Adjust risk parameters in `CONFIG`
3. Add new indicators or data sources
4. Implement machine learning models
5. Test thoroughly before live trading

## Resources

- [Polymarket API Docs](https://docs.polymarket.com/)
- [CLOB API Reference](https://docs.polymarket.com/developers/CLOB/)
- [Clawdbot Skills Guide](https://code.claude.com/docs/en/skills.md)

## Support

For issues or questions:
1. Review logs for error messages
2. Check API credentials are valid
3. Verify sufficient balance in wallet
4. Ensure Node.js version >=18
5. Check network connectivity

## License

This skill is provided as-is for educational and experimental purposes.
