#!/bin/bash

# Polymarket Trading Daemon
# Keeps the enhanced trader running continuously with logging and crash recovery

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRADER_SCRIPT="$SCRIPT_DIR/realtime-trader.js"
LOG_DIR="$HOME/.polymarket-trader/logs"
PID_FILE="$HOME/.polymarket-trader/daemon.pid"
CREDENTIALS_FILE="/Users/admin/Documents/Clawdbot/.polymarket-credentials.env"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Create log directory
mkdir -p "$LOG_DIR"

# Generate log filename with timestamp
LOG_FILE="$LOG_DIR/trader-$(date +%Y%m%d-%H%M%S).log"
LATEST_LOG="$LOG_DIR/latest.log"

# Function to log messages
log() {
    echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} $1" | tee -a "$LOG_FILE"
}

log_success() {
    echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ✅ $1" | tee -a "$LOG_FILE"
}

log_error() {
    echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ❌ $1" | tee -a "$LOG_FILE"
}

log_warning() {
    echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')]${NC} ⚠️  $1" | tee -a "$LOG_FILE"
}

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if ps -p "$OLD_PID" > /dev/null 2>&1; then
        log_error "Daemon already running with PID $OLD_PID"
        exit 1
    else
        log_warning "Removing stale PID file"
        rm "$PID_FILE"
    fi
fi

# Save current PID
echo $$ > "$PID_FILE"

# Cleanup on exit
cleanup() {
    log "Cleaning up..."
    rm -f "$PID_FILE"
    log_success "Daemon stopped"
}

trap cleanup EXIT INT TERM

# Check credentials
if [ ! -f "$CREDENTIALS_FILE" ]; then
    log_error "Credentials file not found: $CREDENTIALS_FILE"
    exit 1
fi

# Load credentials
source "$CREDENTIALS_FILE"

# Load Moonshot AI credentials for Kimi consultation
if [ -f "$HOME/.polymarket-trader.env" ]; then
    source "$HOME/.polymarket-trader.env"
fi

if [ -z "$POLYMARKET_API_KEY" ]; then
    log_error "POLYMARKET_API_KEY not set"
    exit 1
fi

if [ -z "$MOONSHOT_API_KEY" ]; then
    log_warning "MOONSHOT_API_KEY not set - Kimi consultation disabled"
fi

log_success "Polymarket Trading Daemon Started"
log "PID: $$"
log "Log file: $LOG_FILE"
log "Trader script: $TRADER_SCRIPT"
echo ""

# Create symlink to latest log
ln -sf "$LOG_FILE" "$LATEST_LOG"

# Continuous operation with crash recovery
RESTART_COUNT=0
MAX_RESTARTS=10
RESTART_WINDOW=3600 # Reset counter after 1 hour

WINDOW_START=$(date +%s)

while true; do
    CURRENT_TIME=$(date +%s)
    TIME_DIFF=$((CURRENT_TIME - WINDOW_START))

    # Reset restart counter if window expired
    if [ $TIME_DIFF -gt $RESTART_WINDOW ]; then
        log "Restart window expired, resetting counter"
        RESTART_COUNT=0
        WINDOW_START=$CURRENT_TIME
    fi

    # Check if too many restarts
    if [ $RESTART_COUNT -ge $MAX_RESTARTS ]; then
        log_error "Too many restarts ($RESTART_COUNT) in the last hour. Exiting for safety."
        exit 1
    fi

    log "Starting trader (attempt $(($RESTART_COUNT + 1)))"

    # Run the trader
    node "$TRADER_SCRIPT" 2>&1 | while IFS= read -r line; do
        echo "[$(date +'%Y-%m-%d %H:%M:%S')] $line" | tee -a "$LOG_FILE"
    done

    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        log_success "Trader exited cleanly (code $EXIT_CODE)"
        # Clean exit (circuit breaker or take profit)
        break
    else
        log_error "Trader crashed with exit code $EXIT_CODE"
        RESTART_COUNT=$((RESTART_COUNT + 1))

        # Wait before restart (exponential backoff)
        WAIT_TIME=$((5 * RESTART_COUNT))
        log_warning "Waiting ${WAIT_TIME}s before restart..."
        sleep $WAIT_TIME
    fi
done

log_success "Daemon shutdown complete"
