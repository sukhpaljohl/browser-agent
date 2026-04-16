/**
 * Bridge Server v2.0
 * Lightweight HTTP server on localhost:3847.
 * Acts as the communication bridge between external tools (Antigravity, AutoGPT, Cursor)
 * and the Chrome extension content script running on browser-based AIs.
 *
 * Endpoints:
 *   POST /api/prompt    — Queue a prompt   { prompt, target? }
 *                         target = "browser" (default) | "headless"
 *   GET  /api/pending   — Content script polls for the next prompt
 *                         Query param ?mode=browser|headless filters jobs
 *   POST /api/response  — Content script posts the AI response
 *   GET  /api/result?id — External tool retrieves a completed response
 *   GET  /api/status    — Health check
 *   POST /v1/chat/completions — OpenAI-compatible endpoint
 *   POST /api/apple-command   — Structured Apple.com command { action, target }
 */
const http = require('http');
const crypto = require('crypto');

// --- State ---
const promptQueue = [];                        // FIFO queue of { id, prompt }
let activeJob = null;                          // Currently processing job (only one at a time)
const responses = new Map();                   // id -> response data (legacy polling)
const waitingClientSockets = new Map();        // id -> res (long-polling OpenAI clients)
const timeouts = new Map();                    // id -> timeout handle
const extensionLogs = [];                      // Last N log entries from extension
const MAX_EXTENSION_LOGS = 2000;
const recentLogs = [];                         // In-memory log buffer for remote diagnostics
const MAX_RECENT_LOGS = 200;
let latestReconBlueprint = null;               // Latest DOMRecon site/page blueprint
let pendingReconRequest = null;                // Pending scan request for extension to pick up
let pendingObserverCommand = null;             // Pending observer mode command (start/stop/rescan)
let latestObserverState = null;                // Latest observer data from extension
let waitingObserverSocket = null;              // HTTP response held open for observer caller (long-poll)
let waitingObserverCmdId = null;               // ID of the observer command being waited on

const server = http.createServer((req, res) => {
  // CORS — allow extension content scripts
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    const body = rawBody.toString('utf8'); // string version for JSON endpoints
    const parsed = new URL(req.url, 'http://127.0.0.1:3847');
    const pathname = parsed.pathname;

    try {
      // =========================================
      // Target /images/*.png endpoints
      // =========================================
      if (pathname.startsWith('/images/') && req.method === 'GET') {
        const fs = require('fs');
        const path = require('path');
        const safeSuffix = path.normalize(pathname.replace('/images/', '')).replace(/^(\.\.[\/\\])+/, '');
        const imgPath = path.join(__dirname, 'images', safeSuffix);
        
        if (fs.existsSync(imgPath)) {
          const extName = path.extname(imgPath).toLowerCase();
          const mimeTypes = {
            '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
            '.webp': 'image/webp', '.gif': 'image/gif',
            '.mp4': 'video/mp4', '.webm': 'video/webm'
          };
          const contentType = mimeTypes[extName] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType });
          fs.createReadStream(imgPath).pipe(res);
        } else {
          res.writeHead(404);
          res.end('Image not found');
        }
        return;
      }

      // =========================================
      // /api/upload - Raw binary image upload
      // =========================================
      else if (pathname === '/api/upload' && req.method === 'POST') {
        const fs = require('fs');
        const path = require('path');
        const imagesDir = path.join(__dirname, 'images');
        if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });

        const cType = (req.headers['content-type'] || '').toLowerCase();
        let ext = 'png'; // safest raw bitstream fallback
        if (cType.includes('jpeg') || cType.includes('jpg')) ext = 'jpg';
        else if (cType.includes('webp')) ext = 'webp';
        else if (cType.includes('gif')) ext = 'gif';
        else if (cType.includes('mp4')) ext = 'mp4';
        else if (cType.includes('webm')) ext = 'webm';

        const filename = `img_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
        const filePath = path.join(imagesDir, filename);

        fs.writeFileSync(filePath, rawBody);
        const url = `http://127.0.0.1:${PORT}/images/${filename}`;
        log(`Image uploaded securely to disk: ${filename} (${rawBody.length} bytes)`);
        
        return json(res, 200, { url });
      }
      // =========================================
      // /api/dump - Developer DOM extraction
      // =========================================
      else if (pathname === '/api/dump' && req.method === 'POST') {
        const data = JSON.parse(body);
        const fs = require('fs');
        const path = require('path');
        fs.writeFileSync(path.join(__dirname, 'gemini_dom_dump.txt'), data.html);
        log(`Developer DOM dump received remotely and saved to disk`);
        return json(res, 200, { success: true });
      }
      // =========================================
      // /api/extension-log - Remote console logs from extension
      // =========================================
      else if (pathname === '/api/extension-log' && req.method === 'POST') {
        try {
          const data = JSON.parse(body);
          const level = (data.level || 'LOG').padEnd(5);
          const msg = data.msg || '';
          // Print to bridge console with prefix
          const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
          console.log(`  [EXT ${level}] ${msg}`);
        } catch (e) { /* ignore parse errors */ }
        res.writeHead(200);
        res.end('ok');
        return;
      }
      // =========================================
      // Legacy: Queue a prompt
      // =========================================
      if (pathname === '/api/prompt' && req.method === 'POST') {
        const data = JSON.parse(body);
        const id = crypto.randomUUID();
        const target = data.target || 'browser'; // default to real browser
        promptQueue.push({ id, prompt: data.prompt, images: data.images || [], target });
        json(res, 200, { id, status: 'queued', target });
        log(`Prompt queued [ID: ${id}] → ${target}: "${data.prompt.substring(0, 60)}..." (${(data.images || []).length} images)`);
      }

      // =========================================
      // Apple.com: Structured command endpoint
      // Translates { action, target } → "navigate target"
      // =========================================
      else if (pathname === '/api/apple-command' && req.method === 'POST') {
        const data = JSON.parse(body);
        const { action } = data;
        const arg = data.target || data.query || data.label || data.heading || data.category || '';
        const commandText = arg ? `${action} ${arg}` : action;
        const id = crypto.randomUUID();
        const routeTarget = data.route || 'browser'; // use 'route' to avoid collision with 'target' field
        promptQueue.push({ id, prompt: commandText, images: [], target: routeTarget });
        json(res, 200, { id, status: 'queued', command: commandText, target: routeTarget });
        log(`Apple command queued [ID: ${id}] → ${routeTarget}: "${commandText}"`);
      }

      // =========================================
      // Extension polls for pending prompt
      // =========================================
      else if (pathname === '/api/pending' && req.method === 'GET') {
        // Stale job detection: if the client that requested the active job has
        // already disconnected and no response was ever received, the content
        // script likely died (e.g., page navigation). Clear it so the next
        // poll can dispatch a new command.
        if (activeJob && !waitingClientSockets.has(activeJob.id) && !responses.has(activeJob.id)) {
          log(`Clearing stale activeJob [ID: ${activeJob.id}] — client disconnected, response lost`);
          activeJob = null;
        }

        // Only dispatch if no active job is running
        if (activeJob) {
          res.writeHead(204);
          res.end();
          return;
        }

        // Route filtering: extension sends ?mode=browser or ?mode=headless
        const callerMode = parsed.searchParams.get('mode') || 'browser';

        // Find the first job in the queue that matches this caller's mode
        const matchIdx = promptQueue.findIndex(job => (job.target || 'browser') === callerMode);

        if (matchIdx !== -1) {
          const job = promptQueue.splice(matchIdx, 1)[0];
          activeJob = job;
          json(res, 200, { id: job.id, prompt: job.prompt, images: job.images || [] });
          log(`Prompt dispatched [ID: ${job.id}] → ${callerMode} (${(job.images || []).length} images)`);
        } else {
          res.writeHead(204);
          res.end();
        }
      }

      // (duplicate /api/dump removed — handled above)

      // =========================================
      // Extension posts response
      // =========================================
      else if (pathname === '/api/response' && req.method === 'POST') {
        const data = JSON.parse(body);
        const id = data.id;

        // Clear active job
        activeJob = null;

        // Check if an OpenAI client is waiting for this ID
        if (waitingClientSockets.has(id)) {
          const clientRes = waitingClientSockets.get(id);
          try {
            if (data.success === false) {
              json(clientRes, 500, {
                error: {
                  message: 'Browser execution failed',
                  type: 'browser_error',
                  code: 'execution_failed'
                }
              });
            } else {
              const content = (data.response && typeof data.response === 'object')
                ? (data.response.text || '')
                : (data.response || '');

              const openaiResponse = {
                id: 'chatcmpl-' + id,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model: 'gpt-4o-browser',
                choices: [{
                  index: 0,
                  message: {
                    role: 'assistant',
                    content: content
                  },
                  finish_reason: 'stop'
                }],
                raw_result: data,
                usage: {
                  prompt_tokens: 0,
                  completion_tokens: 0,
                  total_tokens: 0
                }
              };

              json(clientRes, 200, openaiResponse);
              log(`OpenAI response sent [ID: ${id}] (${content.length} chars)`);
            }
          } catch (relayError) {
            log(`Failed to relay response to client [ID: ${id}]: ${relayError.message}`);
          }

          // Cleanup
          cleanupRequest(id);
        } else {
          // Legacy fallback: store for polling via /api/result
          responses.set(id, data);
          log(`Response received [ID: ${id}] success=${data.success}`);
        }

        // ACKNOWLEDGE THE EXTENSION's REQUEST so its fetch() resolves!
        json(res, 200, { status: 'received' });
      }

      // =========================================
      // External tool retrieves result (legacy)
      // =========================================
      else if (pathname === '/api/result' && req.method === 'GET') {
        const id = parsed.searchParams.get('id');
        if (id && responses.has(id)) {
          const result = responses.get(id);
          responses.delete(id);
          json(res, 200, result);
        } else {
          json(res, 404, { status: 'not_ready' });
        }
      }

      // =========================================
      // Extension posts debug logs
      // =========================================
      else if (pathname === '/api/extension-log' && req.method === 'POST') {
        try {
          const data = JSON.parse(body);
          const entry = { ts: new Date().toISOString(), ...data };
          extensionLogs.push(entry);
          if (extensionLogs.length > MAX_EXTENSION_LOGS) extensionLogs.shift();
          res.writeHead(200);
          res.end('ok');
        } catch(e) {
          res.writeHead(400);
          res.end('bad json');
        }
      }

      // =========================================
      // DOMRecon: Receive single-page blueprint
      // =========================================
      else if (pathname === '/api/recon' && req.method === 'POST') {
        try {
          const data = JSON.parse(body);
          const fs = require('fs');
          const path = require('path');
          const filename = `recon_${(data.hostname || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '_')}_${data.pathname ? data.pathname.replace(/[^a-zA-Z0-9]/g, '_') : 'root'}.json`;
          const filePath = path.join(__dirname, filename);
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          log(`Recon blueprint received: ${data.hostname}${data.pathname || '/'} — ${data.summary?.totalInteractive || 0} elements → ${filename}`);
          latestReconBlueprint = data;
          return json(res, 200, { success: true, file: filename, summary: data.summary });
        } catch (e) {
          return json(res, 400, { error: 'Invalid recon data: ' + e.message });
        }
      }

      // =========================================
      // DOMRecon: Receive multi-page site blueprint
      // =========================================
      else if (pathname === '/api/recon-site' && req.method === 'POST') {
        try {
          const data = JSON.parse(body);
          const fs = require('fs');
          const path = require('path');
          const filename = `site_blueprint_${(data.hostname || 'unknown').replace(/[^a-zA-Z0-9.-]/g, '_')}.json`;
          const filePath = path.join(__dirname, filename);
          fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
          log(`Site blueprint received: ${data.hostname} — ${data.totalPagesScanned} pages → ${filename}`);
          latestReconBlueprint = data;
          return json(res, 200, { success: true, file: filename, pagesScanned: data.totalPagesScanned });
        } catch (e) {
          return json(res, 400, { error: 'Invalid site blueprint: ' + e.message });
        }
      }

      // =========================================
      // DOMRecon: Retrieve latest blueprint
      // =========================================
      else if (pathname === '/api/recon' && req.method === 'GET') {
        if (latestReconBlueprint) {
          return json(res, 200, latestReconBlueprint);
        }
        // Try loading from disk
        const fs = require('fs');
        const path = require('path');
        const files = fs.readdirSync(__dirname).filter(f => f.startsWith('site_blueprint_') || f.startsWith('recon_'));
        if (files.length > 0) {
          // Return the most recently modified blueprint
          files.sort((a, b) => {
            return fs.statSync(path.join(__dirname, b)).mtime - fs.statSync(path.join(__dirname, a)).mtime;
          });
          try {
            const data = JSON.parse(fs.readFileSync(path.join(__dirname, files[0]), 'utf8'));
            latestReconBlueprint = data;
            return json(res, 200, data);
          } catch (e) {
            return json(res, 500, { error: 'Failed to read blueprint file' });
          }
        }
        return json(res, 404, { error: 'No blueprint available. Trigger a scan first.' });
      }

      // =========================================
      // DOMRecon: Trigger a scan via the extension
      // =========================================
      else if (pathname === '/api/recon-trigger' && req.method === 'POST') {
        try {
          const data = JSON.parse(body);
          if (!data.url) {
            return json(res, 400, { error: 'Missing required field: url' });
          }
          // Store the scan request — the extension polls this
          pendingReconRequest = {
            url: data.url,
            depth: data.depth || 1,
            maxPages: data.maxPages || 20,
            probe: data.probe !== undefined ? data.probe : true,
            requestedAt: new Date().toISOString()
          };
          log(`Recon scan requested: ${data.url} (depth=${data.depth || 1}, maxPages=${data.maxPages || 20}, probe=${data.probe !== undefined ? data.probe : true})`);
          return json(res, 200, { success: true, message: 'Scan queued. Extension will process it.' });
        } catch (e) {
          return json(res, 400, { error: 'Invalid request: ' + e.message });
        }
      }

      // =========================================
      // DOMRecon: Extension polls for pending scan request
      // =========================================
      else if (pathname === '/api/recon-pending' && req.method === 'GET') {
        if (pendingReconRequest) {
          const request = pendingReconRequest;
          pendingReconRequest = null; // Clear after dispatch
          return json(res, 200, request);
        }
        res.writeHead(204);
        res.end();
      }

      // =========================================
      // Observer Mode: Start passive observation (SYNCHRONOUS)
      // Holds connection open until extension responds with baseline.
      // =========================================
      else if (pathname === '/api/observe-start' && req.method === 'POST') {
        const cmdId = crypto.randomUUID();
        pendingObserverCommand = { type: 'START_OBSERVING', id: cmdId, requestedAt: new Date().toISOString() };
        waitingObserverSocket = res;
        waitingObserverCmdId = cmdId;
        log(`Observer: start observation [${cmdId}] — holding connection open...`);

        // Timeout after 60 seconds
        const timeout = setTimeout(() => {
          if (waitingObserverSocket === res) {
            json(res, 504, { error: 'Timeout waiting for extension to start observing' });
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
            log(`Observer: start observation timed out [${cmdId}]`);
          }
        }, 60000);

        res.on('close', () => {
          if (waitingObserverSocket === res) {
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
            clearTimeout(timeout);
          }
        });

        // Store timeout for cleanup
        if (!res._observerTimeout) res._observerTimeout = timeout;
      }

      // =========================================
      // Observer Mode: Stop observation (SYNCHRONOUS)
      // Holds connection open until extension responds with report.
      // =========================================
      else if (pathname === '/api/observe-stop' && req.method === 'POST') {
        const cmdId = crypto.randomUUID();
        pendingObserverCommand = { type: 'STOP_OBSERVING', id: cmdId, requestedAt: new Date().toISOString() };
        waitingObserverSocket = res;
        waitingObserverCmdId = cmdId;
        log(`Observer: stop observation [${cmdId}] — holding connection open...`);

        const timeout = setTimeout(() => {
          if (waitingObserverSocket === res) {
            json(res, 504, { error: 'Timeout waiting for extension to stop observing' });
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
          }
        }, 60000);

        res.on('close', () => {
          if (waitingObserverSocket === res) {
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
            clearTimeout(timeout);
          }
        });
      }

      // =========================================
      // Observer Mode: Rescan/diff (SYNCHRONOUS)
      // Holds connection open until extension responds with diff.
      // =========================================
      else if (pathname === '/api/observe-rescan' && req.method === 'POST') {
        const cmdId = crypto.randomUUID();
        pendingObserverCommand = { type: 'RESCAN', id: cmdId, requestedAt: new Date().toISOString() };
        waitingObserverSocket = res;
        waitingObserverCmdId = cmdId;
        log(`Observer: rescan [${cmdId}] — holding connection open...`);

        const timeout = setTimeout(() => {
          if (waitingObserverSocket === res) {
            json(res, 504, { error: 'Timeout waiting for extension to rescan' });
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
          }
        }, 60000);

        res.on('close', () => {
          if (waitingObserverSocket === res) {
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
            clearTimeout(timeout);
          }
        });
      }

      // =========================================
      // Observer Mode: Get observer status (non-blocking)
      // =========================================
      else if (pathname === '/api/observe-status' && req.method === 'GET') {
        return json(res, 200, {
          observing: latestObserverState ? latestObserverState.observing : false,
          lastReport: latestObserverState || null,
          pendingCommand: pendingObserverCommand ? pendingObserverCommand.type : null
        });
      }

      // =========================================
      // Observer Mode: Receive data from extension → relay to waiting caller
      // =========================================
      else if (pathname === '/api/observe-data' && req.method === 'POST') {
        try {
          const data = JSON.parse(body);
          latestObserverState = data;

          // Save to file if it's a stop report or has a baseline
          if (data.status === 'stopped' || data.baseline) {
            const fs = require('fs');
            const hostname = (data.baseline && data.baseline.url) ? new URL(data.baseline.url).hostname : 'unknown';
            const filename = `observer_${hostname.replace(/[^a-zA-Z0-9.-]/g, '_')}_${Date.now()}.json`;
            fs.writeFileSync(require('path').join(__dirname, filename), JSON.stringify(data, null, 2));
            log(`Observer data saved: ${filename}`);
          }

          // If someone is waiting for this result, relay it directly
          if (waitingObserverSocket) {
            const clientRes = waitingObserverSocket;
            waitingObserverSocket = null;
            waitingObserverCmdId = null;
            json(clientRes, 200, data);
            log('Observer: result relayed to waiting caller');
          }

          return json(res, 200, { success: true });
        } catch (e) {
          return json(res, 400, { error: 'Invalid observer data: ' + e.message });
        }
      }

      // =========================================
      // Observer Mode: Extension polls for pending commands
      // =========================================
      else if (pathname === '/api/observe-pending' && req.method === 'GET') {
        if (pendingObserverCommand) {
          const cmd = pendingObserverCommand;
          pendingObserverCommand = null;
          return json(res, 200, cmd);
        }
        res.writeHead(204);
        res.end();
      }

      // =========================================
      // Health check (enhanced with debug info)
      // =========================================
      else if (pathname === '/api/status' && req.method === 'GET') {
        json(res, 200, {
          queueLength: promptQueue.length,
          hasActiveJob: !!activeJob,
          activeJobId: activeJob ? activeJob.id : null,
          activeJobPrompt: activeJob ? activeJob.prompt.substring(0, 60) : null,
          waitingClients: waitingClientSockets.size,
          responseCount: responses.size,
          hasPendingRecon: !!pendingReconRequest,
          latestReconSite: latestReconBlueprint ? (latestReconBlueprint.hostname || latestReconBlueprint.siteUrl || null) : null,
          observerActive: latestObserverState ? !!latestObserverState.observing : false,
          pendingObserverCommand: pendingObserverCommand ? pendingObserverCommand.type : null,
          extensionLogs: extensionLogs.slice(-100),
          recentLogs: recentLogs.slice(-30)
        });
      }

      // =========================================
      // NEW: OpenAI-compatible endpoint
      // =========================================
      else if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        const data = JSON.parse(body);
        const messages = data.messages || [];

        if (messages.length === 0) {
          json(res, 400, {
            error: { message: 'No messages provided', type: 'invalid_request_error' }
          });
          return;
        }

        // Convert messages array into a single prompt string
        const prompt = messages.map(m => m.content).join('\n\n');

        // Generate unique ID
        const id = crypto.randomUUID();

        // 🚨 OVERWRITE QUEUE: We only care about the LATEST prompt. 
        // This prevents timeout retries from stacking ghost prompts!
        if (promptQueue.length > 0) {
          log(`Discarding ${promptQueue.length} old pending prompts in favor of latest`);
        }
        promptQueue.length = 0;
        const images = data.images || [];
        const target = data.target || 'browser'; // default to real browser
        promptQueue.push({ id, prompt, images, target });
        
        // If there's an activeJob, the user sending a new command means the old one
        // is abandoned. Clear it so the content script can pick up the new command.
        // Safety: the content script's isProcessing flag prevents double execution.
        if (activeJob) {
          log(`Clearing abandoned activeJob [ID: ${activeJob.id}] — new command received`);
          cleanupRequest(activeJob.id);
          activeJob = null;
        }

        // Store the waiting client's response object
        waitingClientSockets.set(id, res);

        // If the MCP client disconnects early (e.g. tool timeout), clean up client socket only.
        // Do NOT touch activeJob or promptQueue — the extension is still processing!
        // IMPORTANT: Use res.on('close'), NOT req.on('close')!
        // req 'close' fires when the request body is consumed (immediately after 'end'),
        // but res 'close' fires when the actual TCP connection drops (real client disconnect).
        res.on('close', () => {
          if (waitingClientSockets.has(id)) {
            log(`MCP client disconnected [ID: ${id}] — extension will still process prompt`);
            cleanupRequest(id);
          }
        });

        // Start 5-minute timeout
        const timeout = setTimeout(() => {
          if (waitingClientSockets.has(id)) {
            const clientRes = waitingClientSockets.get(id);
            json(clientRes, 504, {
              error: {
                message: 'Request timed out waiting for browser response',
                type: 'timeout_error',
                code: 'timeout'
              }
            });
            cleanupRequest(id);
            // If this was the active job, clear it
            if (activeJob && activeJob.id === id) {
              activeJob = null;
            }
            log(`Request timed out [ID: ${id}]`);
          }
        }, 5 * 60 * 1000);

        timeouts.set(id, timeout);

        log(`OpenAI request queued [ID: ${id}]: "${prompt.substring(0, 60)}..."`);
      }

      // =========================================
      // 404
      // =========================================
      else {
        json(res, 404, { error: 'Not found' });
      }
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });
});

// --- Helpers ---

function json(res, status, data) {
  try {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  } catch (e) {
    // Client may have already disconnected
    log(`Warning: Could not send response - ${e.message}`);
  }
}

function log(msg) {
  const ts = new Date().toISOString().substring(11, 19);
  console.log(`[${ts}] ${msg}`);
  recentLogs.push(`[${ts}] ${msg}`);
  if (recentLogs.length > MAX_RECENT_LOGS) recentLogs.shift();
}

function cleanupRequest(id) {
  waitingClientSockets.delete(id);
  if (timeouts.has(id)) {
    clearTimeout(timeouts.get(id));
    timeouts.delete(id);
  }
}

// --- Start ---

const PORT = 3847;
server.listen(PORT, '127.0.0.1', () => {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   POMDP Browser Agent — Bridge Server v2.0    ║');
  console.log(`║   http://127.0.0.1:${PORT}                        ║`);
  console.log('║   OpenAI endpoint: /v1/chat/completions        ║');
  console.log('╚════════════════════════════════════════════════╝');
});
