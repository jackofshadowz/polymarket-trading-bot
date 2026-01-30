#!/bin/bash
# Polymarket Trading Bot Stop Script

PID_FILE="/tmp/polymarket-bot.pid"

if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p $PID > /dev/null 2>&1; then
        echo "Stopping bot (PID: $PID)..."
        kill $PID
        rm "$PID_FILE"
        echo "✓ Bot stopped"
    else
        echo "✗ Bot not running (stale PID file)"
        rm "$PID_FILE"
    fi
else
    # Fallback: find by process name
    PID=$(ps aux | grep "asymmetric-edge-bot.js" | grep -v grep | awk '{print $2}')
    if [ -n "$PID" ]; then
        echo "Stopping bot (PID: $PID)..."
        kill $PID
        echo "✓ Bot stopped"
    else
        echo "✗ Bot not running"
    fi
fi
