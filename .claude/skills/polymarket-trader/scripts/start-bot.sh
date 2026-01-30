#!/bin/bash
# Polymarket Trading Bot Startup Script

set -e

# Change to script directory
cd "$(dirname "$0")"

# Load credentials
if [ -f ~/.polymarket-trader.env ]; then
    source ~/.polymarket-trader.env
    echo "✓ Credentials loaded"
else
    echo "✗ Error: ~/.polymarket-trader.env not found"
    exit 1
fi

# Verify required environment variables
if [ -z "$MOONSHOT_API_KEY" ]; then
    echo "✗ Error: MOONSHOT_API_KEY not set"
    exit 1
fi

echo "✓ API keys verified"

# Start bot with nohup
nohup node asymmetric-edge-bot.js > /tmp/asymmetric-edge-bot.log 2>&1 &
BOT_PID=$!

echo "✓ Bot started with PID: $BOT_PID"
echo "  Log: tail -f /tmp/asymmetric-edge-bot.log"
echo "  Stop: kill $BOT_PID"

# Save PID for easy stopping
echo $BOT_PID > /tmp/polymarket-bot.pid
