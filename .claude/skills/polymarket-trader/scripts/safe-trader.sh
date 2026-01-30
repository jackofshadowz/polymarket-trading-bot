#!/bin/bash

# Safe Trader Wrapper Script
# Provides additional safety controls and dry-run mode

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if credentials are loaded
if [ -z "$POLYMARKET_API_KEY" ]; then
    echo -e "${RED}❌ Error: Polymarket credentials not loaded${NC}"
    echo ""
    echo "Please run:"
    echo "  source /Users/admin/Documents/Clawdbot/.polymarket-credentials.env"
    echo ""
    exit 1
fi

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRADER_SCRIPT="$SCRIPT_DIR/trader.js"

# Parse arguments
DRY_RUN=true
ACTION="${1:-analyze}"

if [ "$1" == "--live" ]; then
    DRY_RUN=false
    ACTION="${2:-analyze}"
fi

# Dry run warning
if [ "$DRY_RUN" = true ]; then
    echo -e "${YELLOW}🛡️  DRY RUN MODE - No real trades will be executed${NC}"
    echo ""
else
    echo -e "${RED}⚠️  LIVE TRADING MODE - Real money at risk!${NC}"
    echo ""
    read -p "Are you sure you want to trade with real money? (type YES): " confirm
    if [ "$confirm" != "YES" ]; then
        echo "Cancelled."
        exit 0
    fi
fi

# Export dry run flag
export DRY_RUN="$DRY_RUN"

# Run trader
echo -e "${GREEN}🦞 Starting Polymarket Trader${NC}"
echo "Action: $ACTION"
echo "Dry Run: $DRY_RUN"
echo ""

node "$TRADER_SCRIPT" "$ACTION"

# Check exit code
if [ $? -eq 0 ]; then
    echo ""
    echo -e "${GREEN}✅ Trading cycle completed successfully${NC}"
else
    echo ""
    echo -e "${RED}❌ Trading cycle failed${NC}"
    exit 1
fi
