#!/bin/bash

# Quick Start Script for Polymarket Trading Bot
# This script starts the autonomous trading system

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                                                           ║"
echo "║   🦞 POLYMARKET AUTONOMOUS TRADING BOT                    ║"
echo "║                                                           ║"
echo "║   Capital: \$61 | Target: \$152.50 (2.5x)                  ║"
echo "║   Strategy: Multi-dimensional arbitrage                  ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"
echo ""

# Check credentials
if [ -z "$POLYMARKET_API_KEY" ]; then
    echo -e "${YELLOW}Loading credentials...${NC}"
    source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env
fi

if [ -z "$POLYMARKET_API_KEY" ]; then
    echo -e "❌ Error: Credentials not found"
    exit 1
fi

echo -e "${GREEN}✅ Credentials loaded${NC}"
echo ""

# Test external data
echo -e "${YELLOW}Testing external data sources...${NC}"
node /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts/info-edge.js

echo ""
echo -e "${GREEN}✅ External data sources operational${NC}"
echo ""

# Show configuration
echo -e "${BLUE}Configuration:${NC}"
echo "  • Starting Balance: \$61"
echo "  • Max Position: 15% (\$9.15)"
echo "  • Min Position: \$5.00"
echo "  • Confidence Threshold: 50%"
echo "  • Markets: BTC 15-minute Up/Down"
echo "  • Scan Interval: 60 seconds"
echo "  • Trading Tool: pmarket-cli"
echo ""

echo -e "${BLUE}Trading Strategy:${NC}"
echo "  • Mean Reversion (fade extremes >60% or <40%)"
echo "  • Momentum Bias (high volume markets)"
echo "  • Time Boost (closing soon <10 min)"
echo "  • Live BTC price monitoring"
echo ""

echo -e "${YELLOW}⚠️  WARNING: This will place REAL trades with REAL money!${NC}"
echo ""
read -p "Type 'START' to begin autonomous trading: " confirm

if [ "$confirm" != "START" ]; then
    echo "Cancelled."
    exit 0
fi

echo ""
echo -e "${GREEN}🚀 Starting autonomous trading...${NC}"
echo ""

# Start the daemon
exec /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts/daemon.sh
