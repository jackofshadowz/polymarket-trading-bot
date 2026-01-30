# Robustness Improvements for Polymarket Trading Bot

## Issues Identified

1. ❌ **API key not loaded on restart**
2. ❌ **Always joins windows late when restarted**
3. ❌ **No graceful degradation when AI unavailable**
4. ❌ **No automatic recovery from crashes**
5. ❌ **Manual restart process error-prone**

---

## Implemented Solutions

### ✅ 1. Startup Script (`start-bot.sh`)
- Automatically loads credentials from `~/.polymarket-trader.env`
- Verifies API keys before starting
- Saves PID for easy management
- Usage: `./start-bot.sh`

### ✅ 2. Stop Script (`stop-bot.sh`)
- Gracefully stops the bot
- Cleans up PID files
- Usage: `./stop-bot.sh`

---

## Recommended Future Improvements

### 🔄 3. **Auto-Restart on Crash** (systemd service)

Create `/etc/systemd/system/polymarket-bot.service`:

```ini
[Unit]
Description=Polymarket Trading Bot
After=network.target

[Service]
Type=simple
User=admin
WorkingDirectory=/Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts
EnvironmentFile=/Users/admin/.polymarket-trader.env
ExecStart=/usr/local/bin/node asymmetric-edge-bot.js
Restart=always
RestartSec=10
StandardOutput=append:/tmp/asymmetric-edge-bot.log
StandardError=append:/tmp/asymmetric-edge-bot.log

[Install]
WantedBy=multi-user.target
```

Enable: `sudo systemctl enable polymarket-bot`

### 🛡️ 4. **Graceful Degradation**

**Add to `asymmetric-edge-bot.js`** (line ~1045):

```javascript
const shouldOrchestrate = (
  process.env.MOONSHOT_API_KEY &&
  !windowState.fivePlayerConsulted &&
  window.timeLeft <= 850 && window.timeLeft > 750
);

if (shouldOrchestrate) {
  // Full 7-player orchestration
  const orchestrationResult = await tradingDeskOrchestrator.orchestrateTradingDecision(...);
} else if (!process.env.MOONSHOT_API_KEY && window.timeLeft <= 850) {
  // FALLBACK: Use simple asymmetric edge strategy
  console.log(JSON.stringify({
    action: 'FALLBACK_MODE',
    reason: 'MOONSHOT_API_KEY not available',
    strategy: 'Simple asymmetric edge (no AI)',
    timestamp: new Date().toISOString()
  }));

  windowState.fivePlayerConsulted = true; // Mark as handled

  // Simple rule: If price < 40¢, buy with Farm desk
  if (market.yesPrice < 0.40 || market.noPrice < 0.40) {
    const side = market.yesPrice < market.noPrice ? 'YES' : 'NO';
    const price = side === 'YES' ? market.yesPrice : market.noPrice;
    windowState.farmDecision = {
      decision: 'ENTER',
      side: side,
      price: price,
      amount: 2.00,
      maxPrice: price * 1.05
    };
  }
}
```

### 📊 5. **Health Monitoring**

Create `scripts/health-check.sh`:

```bash
#!/bin/bash
# Check if bot is alive and trading

LOG_FILE="/tmp/asymmetric-edge-bot.log"
PID_FILE="/tmp/polymarket-bot.pid"

# Check if process running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ! ps -p $PID > /dev/null 2>&1; then
        echo "CRITICAL: Bot process died"
        ./start-bot.sh
        exit 1
    fi
fi

# Check if log updated recently (within 2 minutes)
if [ -f "$LOG_FILE" ]; then
    LAST_UPDATE=$(stat -f %m "$LOG_FILE")
    NOW=$(date +%s)
    AGE=$((NOW - LAST_UPDATE))

    if [ $AGE -gt 120 ]; then
        echo "WARNING: No log activity for $AGE seconds"
        exit 1
    fi
fi

echo "OK: Bot healthy"
exit 0
```

Run via cron every 5 minutes:
```
*/5 * * * * /path/to/health-check.sh
```

### 🔍 6. **Better Error Logging**

Add structured error tracking to `asymmetric-edge-bot.js`:

```javascript
// Global error handler
process.on('uncaughtException', (error) => {
  console.error(JSON.stringify({
    action: 'UNCAUGHT_EXCEPTION',
    error: error.message,
    stack: error.stack,
    timestamp: new Date().toISOString()
  }));

  // Don't exit - try to recover
  // process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(JSON.stringify({
    action: 'UNHANDLED_REJECTION',
    reason: reason,
    timestamp: new Date().toISOString()
  }));
});
```

### ⏰ 7. **Early Window Detection**

Modify `getCurrentWindow()` to look ahead:

```javascript
function getCurrentWindow() {
  const now = Math.floor(Date.now() / 1000);
  const currentWindowStart = Math.floor(now / 900) * 900;
  const currentWindowEnd = currentWindowStart + 900;
  const timeLeftInCurrent = currentWindowEnd - now;

  // If less than 2 minutes left, switch to next window
  if (timeLeftInCurrent < 120) {
    const nextWindowStart = currentWindowStart + 900;
    return {
      start: nextWindowStart,
      end: nextWindowStart + 900,
      slug: `btc-updown-15m-${nextWindowStart}`,
      timeLeft: nextWindowStart + 900 - now,
    };
  }

  return {
    start: currentWindowStart,
    end: currentWindowEnd,
    slug: `btc-updown-15m-${currentWindowStart}`,
    timeLeft: timeLeftInCurrent,
  };
}
```

### 💾 8. **State Persistence**

Save orchestration state to survive restarts:

```javascript
// After orchestration completes
fs.writeFileSync('/tmp/polymarket-bot-state.json', JSON.stringify({
  window: window.slug,
  orchestrationResult: orchestrationResult,
  timestamp: new Date().toISOString()
}, null, 2));

// On startup, check for recent state
if (fs.existsSync('/tmp/polymarket-bot-state.json')) {
  const savedState = JSON.parse(fs.readFileSync('/tmp/polymarket-bot-state.json'));
  // Restore if less than 15 minutes old
  const age = Date.now() - new Date(savedState.timestamp).getTime();
  if (age < 15 * 60 * 1000) {
    console.log('Restored orchestration state from previous session');
    // Apply saved decisions
  }
}
```

### 📈 9. **Performance Metrics**

Track bot performance:

```javascript
const METRICS = {
  totalWindows: 0,
  windowsTraded: 0,
  orchestrationSuccesses: 0,
  orchestrationFailures: 0,
  averageEntryTime: 0, // seconds into window
  clipsExecuted: 0,
  straddlesPlaced: 0
};

// Log metrics every hour
setInterval(() => {
  console.log(JSON.stringify({
    action: 'HOURLY_METRICS',
    metrics: METRICS,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  }));
}, 3600000);
```

### 🔔 10. **Alerts**

Add Telegram/Discord notifications for critical events:

```javascript
async function sendAlert(message) {
  // Telegram example
  const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: `🤖 Polymarket Bot Alert\n\n${message}`
      })
    });
  }
}

// Use for critical events
if (orchestrationFailed) {
  await sendAlert('⚠️ Orchestration failed - using fallback mode');
}

if (METRICS.clipsExecuted % 10 === 0) {
  await sendAlert(`✅ Milestone: ${METRICS.clipsExecuted} clips executed`);
}
```

---

## Priority Implementation Order

1. ✅ **DONE**: Startup/stop scripts
2. 🔴 **HIGH**: Graceful degradation (AI fallback)
3. 🔴 **HIGH**: Better error handling (uncaught exceptions)
4. 🟡 **MEDIUM**: Health monitoring cron job
5. 🟡 **MEDIUM**: Early window detection
6. 🟢 **LOW**: systemd service (for production)
7. 🟢 **LOW**: State persistence
8. 🟢 **LOW**: Performance metrics
9. 🟢 **LOW**: Alerts

---

## Testing Checklist

- [ ] Bot survives restart mid-window
- [ ] Bot trades without AI (fallback mode)
- [ ] Bot recovers from API errors
- [ ] Health check detects hung process
- [ ] Logs capture all errors
- [ ] Metrics track accurately
- [ ] Alerts fire on critical events

---

## Usage

**Start bot:**
```bash
cd /Users/admin/Documents/Clawdbot/.claude/skills/polymarket-trader/scripts
./start-bot.sh
```

**Stop bot:**
```bash
./stop-bot.sh
```

**Check status:**
```bash
tail -f /tmp/asymmetric-edge-bot.log
```

**Restart bot:**
```bash
./stop-bot.sh && sleep 2 && ./start-bot.sh
```
