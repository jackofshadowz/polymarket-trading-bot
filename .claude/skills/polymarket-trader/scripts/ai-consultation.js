/**
 * AI CONSULTATION MODULE
 *
 * Automated Gemini + Grok dialogue after every 2 trading windows.
 * Provides scientific analysis and recommendations for continuous improvement.
 *
 * Flow:
 * 1. Compile 2-window summary (trades, signals, P&L, missed opportunities)
 * 2. Send to Gemini for initial analysis
 * 3. Send Gemini's response to Grok for counterpoints
 * 4. Send Grok's response to Gemini for final verdict
 * 5. Save full dialogue to consultations/ directory
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

// Load environment variables
require('@dotenvx/dotenvx').config();

// ============================================================
// API CONFIGURATION
// ============================================================

const CONFIG = {
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  GROK_API_KEY: process.env.GROK_API_KEY,
  GEMINI_URL: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent',
  GROK_URL: 'https://api.x.ai/v1/chat/completions',
  GROK_MODEL: 'grok-3-mini',
  CONSULTATIONS_DIR: path.join(__dirname, 'consultations'),
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 2000
};

// ============================================================
// API HELPERS
// ============================================================

/**
 * Call Gemini API
 */
async function consultGemini(prompt) {
  if (!CONFIG.GEMINI_API_KEY) {
    return { success: false, error: 'GEMINI_API_KEY not configured' };
  }

  const url = `${CONFIG.GEMINI_URL}?key=${CONFIG.GEMINI_API_KEY}`;

  const requestBody = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1200
    }
  };

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const response = await httpPost(url, requestBody);

      if (response.candidates && response.candidates[0]?.content?.parts?.[0]?.text) {
        return {
          success: true,
          response: response.candidates[0].content.parts[0].text,
          model: 'gemini-2.0-flash'
        };
      }

      return {
        success: false,
        error: response.error?.message || 'No response from Gemini'
      };
    } catch (error) {
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(CONFIG.RETRY_DELAY_MS * attempt);
        continue;
      }
      return { success: false, error: error.message };
    }
  }
}

/**
 * Call Grok API
 */
async function consultGrok(prompt) {
  if (!CONFIG.GROK_API_KEY) {
    return { success: false, error: 'GROK_API_KEY not configured' };
  }

  const requestBody = {
    model: CONFIG.GROK_MODEL,
    messages: [{
      role: 'user',
      content: prompt
    }],
    temperature: 0.7,
    max_tokens: 1200
  };

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      const response = await httpPostWithAuth(
        CONFIG.GROK_URL,
        requestBody,
        CONFIG.GROK_API_KEY
      );

      if (response.choices && response.choices[0]?.message?.content) {
        return {
          success: true,
          response: response.choices[0].message.content,
          model: CONFIG.GROK_MODEL
        };
      }

      return {
        success: false,
        error: response.error || 'No response from Grok'
      };
    } catch (error) {
      if (attempt < CONFIG.MAX_RETRIES) {
        await sleep(CONFIG.RETRY_DELAY_MS * attempt);
        continue;
      }
      return { success: false, error: error.message };
    }
  }
}

/**
 * HTTP POST helper (for Gemini - key in URL)
 */
function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * HTTP POST with Authorization header (for Grok)
 */
function httpPostWithAuth(url, body, apiKey) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// CONSULTATION ORCHESTRATION
// ============================================================

/**
 * Run a full 3-turn AI consultation
 *
 * @param {Object} window1Data - Data from first window
 * @param {Object} window2Data - Data from second window
 * @returns {Object} Full consultation dialogue
 */
async function runConsultation(window1Data, window2Data) {
  const sessionId = `consultation_${Date.now()}`;
  const startTime = new Date().toISOString();

  console.log(JSON.stringify({
    action: 'AI_CONSULTATION_STARTING',
    sessionId: sessionId,
    windows: [window1Data?.slug, window2Data?.slug],
    timestamp: startTime
  }));

  // Compile 2-window summary
  const summary = compileWindowSummary(window1Data, window2Data);

  // ═══════════════════════════════════════════════════════════════════
  // TURN 1: Gemini Initial Analysis
  // ═══════════════════════════════════════════════════════════════════
  const geminiPrompt1 = `You are a quantitative trading analyst reviewing a Polymarket BTC 15-minute prediction bot.

RESULTS FROM LAST 2 WINDOWS:
${summary}

Analyze these results and provide:
1. Assessment of performance (ROI, win rate)
2. What the bot did well
3. What needs improvement
4. Specific actionable recommendations

Be direct and quantitative. Another AI (Grok) will respond to your analysis.`;

  const geminiResponse1 = await consultGemini(geminiPrompt1);

  if (!geminiResponse1.success) {
    console.log(JSON.stringify({
      action: 'AI_CONSULTATION_FAILED',
      stage: 'gemini_turn1',
      error: geminiResponse1.error,
      timestamp: new Date().toISOString()
    }));
    return { success: false, error: geminiResponse1.error };
  }

  console.log(JSON.stringify({
    action: 'AI_CONSULTATION_TURN_COMPLETE',
    turn: 1,
    model: 'Gemini',
    responseLength: geminiResponse1.response.length,
    timestamp: new Date().toISOString()
  }));

  // ═══════════════════════════════════════════════════════════════════
  // TURN 2: Grok Response
  // ═══════════════════════════════════════════════════════════════════
  const grokPrompt = `You are Grok, debating Gemini AI about a Polymarket trading bot.

CONTEXT: ${summary}

GEMINI'S ANALYSIS:
${geminiResponse1.response}

YOUR TASK:
1. Where do you agree/disagree with Gemini?
2. What did Gemini miss?
3. Give 3 specific actionable recommendations (different from or enhancing Gemini's)
4. Should this bot continue trading? Yes/No with conditions`;

  const grokResponse = await consultGrok(grokPrompt);

  if (!grokResponse.success) {
    console.log(JSON.stringify({
      action: 'AI_CONSULTATION_PARTIAL',
      stage: 'grok_failed',
      error: grokResponse.error,
      timestamp: new Date().toISOString()
    }));
    // Continue with partial consultation
  } else {
    console.log(JSON.stringify({
      action: 'AI_CONSULTATION_TURN_COMPLETE',
      turn: 2,
      model: 'Grok',
      responseLength: grokResponse.response?.length || 0,
      timestamp: new Date().toISOString()
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // TURN 3: Gemini Final Verdict
  // ═══════════════════════════════════════════════════════════════════
  let geminiResponse2 = { success: false };

  if (grokResponse.success) {
    const geminiPrompt2 = `DEBATE ROUND 2. You are Gemini responding to Grok.

GROK'S RESPONSE:
${grokResponse.response}

Give your FINAL VERDICT:
1. Rebuttals to Grok's points (be specific)
2. TOP 3 PRIORITY FIXES to implement IMMEDIATELY
3. One thing Grok said that changed your view
4. Final recommendation: Continue trading or pause? Why?`;

    geminiResponse2 = await consultGemini(geminiPrompt2);

    if (geminiResponse2.success) {
      console.log(JSON.stringify({
        action: 'AI_CONSULTATION_TURN_COMPLETE',
        turn: 3,
        model: 'Gemini',
        responseLength: geminiResponse2.response.length,
        timestamp: new Date().toISOString()
      }));
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // COMPILE AND SAVE DIALOGUE
  // ═══════════════════════════════════════════════════════════════════
  const dialogue = {
    sessionId: sessionId,
    startedAt: startTime,
    completedAt: new Date().toISOString(),
    windows: {
      window1: window1Data,
      window2: window2Data
    },
    summary: summary,
    turns: [
      {
        turn: 1,
        model: 'Gemini',
        prompt: geminiPrompt1,
        response: geminiResponse1.response,
        success: true
      },
      {
        turn: 2,
        model: 'Grok',
        prompt: grokPrompt,
        response: grokResponse.response || null,
        success: grokResponse.success
      },
      {
        turn: 3,
        model: 'Gemini',
        prompt: grokResponse.success ? geminiPrompt2 : null,
        response: geminiResponse2.response || null,
        success: geminiResponse2.success
      }
    ],
    priorityActions: extractPriorityActions(geminiResponse2.response || geminiResponse1.response)
  };

  // Save dialogue
  saveDialogue(dialogue, sessionId);

  console.log(JSON.stringify({
    action: 'AI_CONSULTATION_COMPLETE',
    sessionId: sessionId,
    turnsCompleted: dialogue.turns.filter(t => t.success).length,
    priorityActions: dialogue.priorityActions.length,
    timestamp: new Date().toISOString()
  }));

  return { success: true, dialogue };
}

/**
 * Compile a summary of 2 windows for the AI prompt
 */
function compileWindowSummary(window1, window2) {
  const formatWindow = (w, num) => {
    if (!w) return `Window ${num}: No data`;

    return `Window ${num} (${w.slug || 'unknown'}):
- Winner: ${w.winner || 'N/A'}
- Our position: ${w.trades?.length ? w.trades.map(t => `${t.side} ${t.shares} shares @ ${t.price}`).join(', ') : 'None'}
- P&L: ${w.pnl !== undefined ? '$' + w.pnl.toFixed(2) : 'N/A'}
- Signals: ${JSON.stringify(w.signals || {})}`;
  };

  const totalPnL = (window1?.pnl || 0) + (window2?.pnl || 0);
  const wins = [window1, window2].filter(w => w?.pnl > 0).length;
  const winRate = `${wins}/2 (${(wins/2*100).toFixed(0)}%)`;

  return `${formatWindow(window1, 1)}

${formatWindow(window2, 2)}

AGGREGATE:
- Total P&L: $${totalPnL.toFixed(2)}
- Win Rate: ${winRate}`;
}

/**
 * Extract priority actions from AI response
 */
function extractPriorityActions(response) {
  if (!response) return [];

  const actions = [];
  const lines = response.split('\n');

  for (const line of lines) {
    // Look for numbered items that look like action items
    const match = line.match(/^\d+[\.\)]\s*\*?\*?(.+)/);
    if (match && (
      line.toLowerCase().includes('fix') ||
      line.toLowerCase().includes('implement') ||
      line.toLowerCase().includes('add') ||
      line.toLowerCase().includes('improve') ||
      line.toLowerCase().includes('priority')
    )) {
      actions.push(match[1].replace(/\*\*/g, '').trim());
    }
  }

  return actions.slice(0, 5); // Max 5 actions
}

/**
 * Save dialogue to file
 */
function saveDialogue(dialogue, sessionId) {
  try {
    // Ensure directory exists
    if (!fs.existsSync(CONFIG.CONSULTATIONS_DIR)) {
      fs.mkdirSync(CONFIG.CONSULTATIONS_DIR, { recursive: true });
    }

    const filename = `${sessionId}.json`;
    const filepath = path.join(CONFIG.CONSULTATIONS_DIR, filename);

    fs.writeFileSync(filepath, JSON.stringify(dialogue, null, 2));

    console.log(JSON.stringify({
      action: 'AI_CONSULTATION_SAVED',
      filename: filename,
      path: filepath,
      timestamp: new Date().toISOString()
    }));

    return { success: true, filepath };
  } catch (error) {
    console.log(JSON.stringify({
      action: 'AI_CONSULTATION_SAVE_FAILED',
      error: error.message,
      timestamp: new Date().toISOString()
    }));
    return { success: false, error: error.message };
  }
}

/**
 * List all saved consultations
 */
function listConsultations() {
  try {
    if (!fs.existsSync(CONFIG.CONSULTATIONS_DIR)) {
      return [];
    }

    return fs.readdirSync(CONFIG.CONSULTATIONS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const filepath = path.join(CONFIG.CONSULTATIONS_DIR, f);
        const stats = fs.statSync(filepath);
        return {
          filename: f,
          size: stats.size,
          created: stats.birthtime
        };
      })
      .sort((a, b) => b.created - a.created);
  } catch (error) {
    return [];
  }
}

/**
 * Get latest consultation
 */
function getLatestConsultation() {
  const consultations = listConsultations();
  if (consultations.length === 0) return null;

  const filepath = path.join(CONFIG.CONSULTATIONS_DIR, consultations[0].filename);
  try {
    return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch {
    return null;
  }
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  runConsultation,
  consultGemini,
  consultGrok,
  compileWindowSummary,
  saveDialogue,
  listConsultations,
  getLatestConsultation,
  CONFIG
};

// ============================================================
// SELF-TEST
// ============================================================

if (require.main === module) {
  console.log('=== AI CONSULTATION SELF-TEST ===\n');

  // Check API keys
  console.log('Gemini API Key:', CONFIG.GEMINI_API_KEY ? 'Configured' : 'MISSING');
  console.log('Grok API Key:', CONFIG.GROK_API_KEY ? 'Configured' : 'MISSING');

  // Test with mock data
  const mockWindow1 = {
    slug: 'btc-updown-15m-test1',
    winner: 'NO',
    trades: [{ side: 'NO', shares: 5.21, price: 0.62 }],
    pnl: 1.97,
    signals: { smartMoney: 'BEARISH', depth: 'BEARISH' }
  };

  const mockWindow2 = {
    slug: 'btc-updown-15m-test2',
    winner: 'YES',
    trades: [],
    pnl: 0,
    signals: { smartMoney: 'NEUTRAL', depth: 'BULLISH' }
  };

  console.log('\nCompiled Summary:');
  console.log(compileWindowSummary(mockWindow1, mockWindow2));

  // Run actual consultation if requested
  if (process.argv.includes('--run')) {
    console.log('\nRunning actual consultation...');
    runConsultation(mockWindow1, mockWindow2)
      .then(result => {
        console.log('\nConsultation result:', result.success ? 'SUCCESS' : 'FAILED');
        if (result.dialogue) {
          console.log('Priority actions:', result.dialogue.priorityActions);
        }
      })
      .catch(err => console.error('Error:', err));
  } else {
    console.log('\nTo run actual consultation: node ai-consultation.js --run');
  }
}
