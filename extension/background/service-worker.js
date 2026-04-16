/**
 * Background Service Worker (Manifest V3)
 * Keeps the extension alive and routes messages between popup and content scripts.
 *
 * Phase 1A.1 — The Command Center:
 *   - TaskStateTracker: Cross-page working memory for task lifecycle
 *   - LoopDetector: 4-mode behavioral loop detection + tiered recovery
 *   Both are singletons loaded via importScripts, queried by content scripts
 *   via chrome.runtime.sendMessage with BRAIN_* message types.
 */

// --- Remote Logging Telemetry Hook ---
// MUST come before importScripts so brain module logs are captured by telemetry.
const BRIDGE = 'http://localhost:3847';
const _slog = console.log, _swarn = console.warn, _serror = console.error;
function remoteSLog(level, args) {
  try {
    const msg = '[SW] ' + Array.from(args).map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    fetch(`${BRIDGE}/api/extension-log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ level, msg })
    }).catch(() => {});
  } catch(e) {}
}
console.log = function() { remoteSLog('LOG', arguments); _slog.apply(console, arguments); };
console.warn = function() { remoteSLog('WARN', arguments); _swarn.apply(console, arguments); };
console.error = function() { remoteSLog('ERROR', arguments); _serror.apply(console, arguments); };

// ─── Brain Modules (Phase 1A.1 — The Command Center) ─────────────────────────
// Must be at top level for MV3 service worker importScripts compatibility.
// Loaded AFTER telemetry hook so all brain logs are captured remotely.
try {
  importScripts('../brain/task-state.js', '../brain/loop-detector.js');
  console.log('[Brain] ✓ Command Center modules loaded (TaskState + LoopDetector)');
} catch (e) {
  console.error('[Brain] ✗ Failed to load Command Center modules:', e.message);
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[BrowserAgent] Extension installed');
});

// Keep-alive alarm + Recon polling for MV3 service worker
chrome.alarms.create('keepAlive', { periodInMinutes: 0.5 });
chrome.alarms.create('reconPoll', { periodInMinutes: 0.1 }); // Poll every ~6 seconds
let reconInProgress = false;
let isDispatchingCommand = false;  // CommandRelay: true while dispatching a bridge command

// URL patterns that are NEVER safe to navigate to during scanning
const UNSAFE_URL_PATTERNS = /logout|signout|log-out|sign-out|delete|remove|checkout|payment|pay|purchase|confirm|unsubscribe|deactivate|close-account|reset-password/i;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepAlive') {
    // Heartbeat — prevents service worker termination
  }
  
  // Poll bridge server for pending recon scan requests
  if (alarm.name === 'reconPoll' && !reconInProgress) {
    fetch(`${BRIDGE}/api/recon-pending`)
      .then(res => {
        if (res.status === 204) return null; // no pending request
        return res.json();
      })
      .then(data => {
        if (!data || !data.url) return;
        console.log(`[Recon] Picked up scan request: ${data.url}`);
        reconInProgress = true;
        _executeReconCrawl(data.url, data.depth, data.maxPages, data.probe !== undefined ? data.probe : true)
          .then(result => {
            reconInProgress = false;
            console.log('[Recon] Scan complete:', JSON.stringify(result));
          })
          .catch(err => {
            reconInProgress = false;
            console.error('[Recon] Scan failed:', err.message);
          });
      })
      .catch(() => {}); // bridge not running, ignore
  }

  // Poll bridge server for pending observer mode commands
  if (alarm.name === 'reconPoll') {
    fetch(`${BRIDGE}/api/observe-pending`)
      .then(res => {
        if (res.status === 204) return null;
        return res.json();
      })
      .then(cmd => {
        if (!cmd || !cmd.type) return;
        console.log(`[Observer] Picked up command: ${cmd.type}`);

        // Find the active tab and send the command
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          if (tabs.length === 0) {
            console.warn('[Observer] No active tab found for observer command');
            return;
          }
          const tabId = tabs[0].id;
          chrome.tabs.sendMessage(tabId, { type: cmd.type }, (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[Observer] Message failed:', chrome.runtime.lastError.message);
              return;
            }
            if (response && response.success) {
              // Send observer data back to bridge
              const payload = response.result || response.report || response.diff || response.observations || {};
              fetch(`${BRIDGE}/api/observe-data`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              }).catch(e => console.warn('[Observer] Failed to send data to bridge:', e.message));
            }
          });
        });
      })
      .catch(() => {}); // bridge not running, ignore
  }

  // Command relay: fallback poll (supplements setInterval for SW restart resilience)
  if (alarm.name === 'reconPoll' && !isDispatchingCommand) {
    pollBridgeForCommands();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Bridge Command Relay (Navigation-Resilient Command Delivery)
// ═══════════════════════════════════════════════════════════════════════════════
// The Service Worker polls the bridge for pending commands and dispatches them
// to the active tab's content script via chrome.tabs.sendMessage(). This design
// survives page navigations because:
//
//   1. The SW is persistent — it never dies when a tab navigates
//   2. Chrome reports content script death via lastError ("message port closed")
//   3. After navigation, the SW retries delivery to the new page's content script
//
// Previous architecture had content.js polling the bridge directly via fetch().
// That broke on navigation: the content script died before posting the response,
// leaving activeJob stuck in the bridge forever.
//
// Flow:
//   Bridge ←poll── SW ──sendMessage──→ Content Script
//                  SW ←──sendResponse── Content Script
//   Bridge ←post── SW
// ═══════════════════════════════════════════════════════════════════════════════

const COMMAND_POLL_MS = 3000;
const COMMAND_POLL_URL = `${BRIDGE}/api/pending?mode=browser`;

/**
 * Poll the bridge server for pending commands.
 * Called on a 3-second interval (setInterval) and as a fallback from the
 * reconPoll alarm (~6 seconds) in case the SW restarts.
 */
async function pollBridgeForCommands() {
  if (isDispatchingCommand) return;

  try {
    const res = await fetch(COMMAND_POLL_URL);
    if (!res.ok || res.status === 204) return;

    const data = await res.json();
    if (!data || !data.prompt) return;

    isDispatchingCommand = true;
    console.log(`[CommandRelay] Received: "${data.prompt.substring(0, 60)}..."`);
    if (data.images && data.images.length > 0) {
      console.log(`[CommandRelay] Images: ${data.images.length}`);
    }

    dispatchToContentScript(data);
  } catch (e) {
    // Bridge not running — silently ignore
  }
}

/**
 * Dispatch a command to the active tab's content script.
 * Handles three outcomes:
 *   1. Content script not loaded yet   → retry with backoff
 *   2. Content script dies (navigation) → report synthetic success
 *   3. Content script completes        → forward result to bridge
 */
function dispatchToContentScript(data, retryCount = 0) {
  const MAX_RETRIES = 10;
  const RETRY_DELAY_MS = 1500;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs || tabs.length === 0) {
      console.warn('[CommandRelay] No active tab found');
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => dispatchToContentScript(data, retryCount + 1), RETRY_DELAY_MS);
      } else {
        postResponseToBridge(data.id, { success: false, error: 'No active tab after retries' });
        isDispatchingCommand = false;
      }
      return;
    }

    const tabId = tabs[0].id;
    if (retryCount === 0) {
      console.log(`[CommandRelay] Dispatching to tab ${tabId}`);
    }

    chrome.tabs.sendMessage(tabId, {
      type: 'EXECUTE_PROMPT',
      prompt: data.prompt,
      images: data.images || [],
      id: data.id
    }, (response) => {
      if (chrome.runtime.lastError) {
        const errMsg = chrome.runtime.lastError.message || '';

        // Case 1: Content script not loaded yet (page still loading after nav).
        if (errMsg.includes('Could not establish connection') ||
            errMsg.includes('Receiving end does not exist')) {
          if (retryCount < MAX_RETRIES) {
            console.log(`[CommandRelay] Content script not ready (retry ${retryCount + 1}/${MAX_RETRIES})`);
            setTimeout(() => dispatchToContentScript(data, retryCount + 1), RETRY_DELAY_MS);
          } else {
            console.error('[CommandRelay] Content script never loaded after max retries');
            postResponseToBridge(data.id, { success: false, error: 'Content script unavailable' });
            isDispatchingCommand = false;
          }
          return;
        }

        // Case 2: Content script died mid-execution (page navigated).
        // The action DID execute — the navigation proves the click worked.
        // Chrome uses different error messages depending on how the page unloaded:
        //   - "message port closed" — standard navigation
        //   - "back/forward cache" — BFCache-enabled navigation
        if (errMsg.includes('message port closed') ||
            errMsg.includes('back/forward cache')) {
          console.log('[CommandRelay] Port closed (navigation) — reporting success');
          postResponseToBridge(data.id, {
            success: true,
            response: { text: 'Action executed. Page navigated to a new URL.' }
          });
          isDispatchingCommand = false;
          return;
        }

        // Case 3: Unknown error
        console.error('[CommandRelay] Dispatch error:', errMsg);
        postResponseToBridge(data.id, { success: false, error: errMsg });
        isDispatchingCommand = false;
        return;
      }

      // Happy path: content script completed and returned a result
      console.log(`[CommandRelay] ✓ Complete — success: ${response?.success}`);
      postResponseToBridge(data.id, response || { success: false, error: 'Empty response' });
      isDispatchingCommand = false;
    });
  });
}

/**
 * Post a command result back to the bridge server.
 * Uses AbortController with 5-second timeout to prevent hanging.
 */
async function postResponseToBridge(id, result) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    await fetch(`${BRIDGE}/api/response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, ...result }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    console.log(`[CommandRelay] Response posted [ID: ${id.substring(0, 8)}...]`);
  } catch (e) {
    console.warn(`[CommandRelay] Failed to post response: ${e.message}`);
  }
}

// Start command polling immediately and on a 3-second interval.
// The reconPoll alarm also calls pollBridgeForCommands as a fallback
// in case the SW restarts and loses the setInterval.
setInterval(pollBridgeForCommands, COMMAND_POLL_MS);
pollBridgeForCommands();

// ═══════════════════════════════════════════════════════════════════════════════
// Brain Command Center — Message Router (Phase 1A.1)
// ═══════════════════════════════════════════════════════════════════════════════
// Content scripts query the Task State Tracker and Loop Detector via these
// message types. All BRAIN_* messages are handled here and return synchronous
// responses (no async sendResponse needed for most operations).
// ═══════════════════════════════════════════════════════════════════════════════

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only handle BRAIN_* messages in this listener
  if (!message.type || !message.type.startsWith('BRAIN_')) return false;

  try {
    switch (message.type) {

      // ── Task State: Lifecycle ──────────────────────────────────────────────

      case 'BRAIN_TASK_INIT': {
        // Start a new task. Resets both task state and loop detector.
        const { goal, startUrl } = message;
        if (!goal) {
          sendResponse({ success: false, error: 'goal is required' });
          return false;
        }
        // Reset loop detector when starting a new task
        if (typeof loopDetector !== 'undefined') loopDetector.reset();
        const snapshot = taskStateTracker.initTask(goal, startUrl || '');
        sendResponse({ success: true, state: snapshot });
        return false;
      }

      case 'BRAIN_TASK_RESET': {
        taskStateTracker.resetTask();
        if (typeof loopDetector !== 'undefined') loopDetector.reset();
        sendResponse({ success: true });
        return false;
      }

      case 'BRAIN_TASK_GET': {
        // Get current task state snapshot (serializable)
        const snapshot = taskStateTracker.getSnapshot();
        sendResponse({ success: true, state: snapshot, isActive: taskStateTracker.isActive() });
        return false;
      }

      // ── Task State: Action Recording ───────────────────────────────────────

      case 'BRAIN_TASK_RECORD_ACTION': {
        // Record an action + effect, update milestones, tick commitment
        const { action, effect, currentUrl } = message;
        if (!action || !effect) {
          sendResponse({ success: false, error: 'action and effect are required' });
          return false;
        }
        const updatedState = taskStateTracker.recordAction(action, effect, currentUrl || '');
        sendResponse({ success: true, state: updatedState });
        return false;
      }

      // ── Task State: Progress ───────────────────────────────────────────────

      case 'BRAIN_TASK_UPDATE_PROGRESS': {
        const { progress, currentUrl } = message;
        if (typeof progress !== 'number') {
          sendResponse({ success: false, error: 'progress (number) is required' });
          return false;
        }
        const result = taskStateTracker.updateProgress(progress, currentUrl || '');
        sendResponse({ success: true, ...result });
        return false;
      }

      case 'BRAIN_TASK_UPDATE_SEEN_TOKENS': {
        // Update information gain tracking (Plan §2.4, v2.5)
        const { pageTokens } = message;
        if (!Array.isArray(pageTokens)) {
          sendResponse({ success: false, error: 'pageTokens (array) is required' });
          return false;
        }
        const gainResult = taskStateTracker.updateSeenGoalTokens(pageTokens);
        sendResponse({ success: true, ...gainResult });
        return false;
      }

      // ── Task State: Commitment Window ──────────────────────────────────────

      case 'BRAIN_TASK_ENTER_COMMITMENT': {
        const { targetType, steps } = message;
        taskStateTracker.enterCommitment(targetType || 'form_submission', steps);
        sendResponse({ success: true });
        return false;
      }

      // ── Task State: Failure Memory ─────────────────────────────────────────

      case 'BRAIN_TASK_RECORD_FAILURE': {
        const { node } = message;
        if (!node) {
          sendResponse({ success: false, error: 'node is required' });
          return false;
        }
        taskStateTracker.recordFailure(node);
        sendResponse({ success: true });
        return false;
      }

      case 'BRAIN_TASK_CHECK_FAILURE': {
        const { node } = message;
        if (!node) {
          sendResponse({ success: false, error: 'node is required' });
          return false;
        }
        sendResponse({
          success: true,
          isFailure: taskStateTracker.isKnownFailure(node),
          penalty: taskStateTracker.getFailurePenalty(node)
        });
        return false;
      }

      case 'BRAIN_TASK_GET_GOAL_TOKENS': {
        sendResponse({ success: true, goalTokens: taskStateTracker.getGoalTokens() });
        return false;
      }

      // ── Loop Detector ─────────────────────────────────────────────────────

      case 'BRAIN_LOOP_CHECK': {
        // Check for behavioral loops after an action
        const { url, domFingerprint, nodes, action } = message;
        if (!url || !action) {
          sendResponse({ success: false, error: 'url and action are required' });
          return false;
        }
        // Compute fingerprint from nodes if not provided directly
        const fingerprint = domFingerprint || 
          (typeof computeDomFingerprint === 'function' && nodes ? computeDomFingerprint(nodes) : 'unknown');
        const loopResult = loopDetector.check(url, fingerprint, action);
        
        // If loop detected, also compute recovery action
        let recovery = null;
        if (loopResult.loopDetected) {
          const taskSnapshot = taskStateTracker.getSnapshot();
          recovery = loopDetector.getRecoveryAction(loopResult, taskSnapshot);
        }
        sendResponse({ success: true, ...loopResult, recovery });
        return false;
      }

      case 'BRAIN_LOOP_GET_RECOVERY': {
        // Get recovery action for the last detected loop
        const lastResult = loopDetector.lastResult;
        if (!lastResult || !lastResult.loopDetected) {
          sendResponse({ success: true, recovery: null });
          return false;
        }
        const taskSnapshot = taskStateTracker.getSnapshot();
        const recovery = loopDetector.getRecoveryAction(lastResult, taskSnapshot);
        sendResponse({ success: true, recovery });
        return false;
      }

      case 'BRAIN_LOOP_APPLY_CONSTRAINTS': {
        // Apply enforcement constraints to candidate nodes
        const { candidates, constraints } = message;
        if (!candidates || !constraints) {
          sendResponse({ success: false, error: 'candidates and constraints are required' });
          return false;
        }
        const taskSnapshot = taskStateTracker.getSnapshot();
        const filtered = loopDetector.applyEnforcementConstraints(candidates, constraints, taskSnapshot);
        sendResponse({ success: true, candidates: filtered });
        return false;
      }

      case 'BRAIN_LOOP_GET_STATUS': {
        sendResponse({ success: true, ...loopDetector.getStatus() });
        return false;
      }

      case 'BRAIN_LOOP_RESET': {
        loopDetector.reset();
        sendResponse({ success: true });
        return false;
      }

      // ── DOM Fingerprint Utility ────────────────────────────────────────────

      case 'BRAIN_COMPUTE_FINGERPRINT': {
        const { nodes } = message;
        if (!nodes || !Array.isArray(nodes)) {
          sendResponse({ success: false, error: 'nodes (array) is required' });
          return false;
        }
        const fp = (typeof computeDomFingerprint === 'function')
          ? computeDomFingerprint(nodes)
          : 'unavailable';
        sendResponse({ success: true, fingerprint: fp });
        return false;
      }

      // ── Current Instruction Update (Phase 1A.3b) ─────────────────────────

      case 'BRAIN_TASK_UPDATE_INSTRUCTION': {
        const { instruction } = message;
        if (!instruction) {
          sendResponse({ success: false, error: 'instruction is required' });
          return false;
        }
        if (!taskStateTracker.isActive()) {
          sendResponse({ success: false, error: 'No active task' });
          return false;
        }
        taskStateTracker.updateInstruction(instruction);
        sendResponse({ success: true, state: taskStateTracker.getSnapshot() });
        return false;
      }

      // ── Batched Step Result (Phase 1A.3b) ──────────────────────────────
      // Atomic batch: records action + effect, updates seen tokens, in one
      // IPC call. Prevents race conditions from sequential independent
      // messages, and reduces IPC overhead from 3 calls to 1.
      //
      // Progress is updated separately via BRAIN_TASK_UPDATE_PROGRESS
      // because the Progress Estimator needs the info gain rate from this
      // call's response to compute the final progress score.

      case 'BRAIN_RECORD_STEP_COMPLETE': {
        const { action, effect, currentUrl, pageTokens } = message;
        if (!action || !effect) {
          sendResponse({ success: false, error: 'action and effect are required' });
          return false;
        }
        if (!taskStateTracker.isActive()) {
          sendResponse({ success: false, error: 'No active task' });
          return false;
        }

        // Operation 1: Record action + effect (updates step_index, milestones, etc.)
        const actionResult = taskStateTracker.recordAction(action, effect, currentUrl || '');

        // Operation 2: Update seen goal tokens (for information gain rate)
        let gainResult = { newMatches: 0, gainRate: 0 };
        if (Array.isArray(pageTokens)) {
          gainResult = taskStateTracker.updateSeenGoalTokens(pageTokens);
        }

        // Operation 3: Feed loop detector (Phase 1B.1 — wiring fix)
        // Derives a lightweight fingerprint from pageTokens since DOM nodes
        // aren't available in this handler. For cross-page loops, URL alone
        // is sufficient. For same-page loops, token changes track meaningful
        // DOM differences. Falls back to 'no_tokens' when no tokens present.
        let loopResult = null;
        if (typeof loopDetector !== 'undefined') {
          const tokenFingerprint = (Array.isArray(pageTokens) && pageTokens.length > 0)
            ? fastHash(pageTokens.sort().join('|'))
            : 'no_tokens';
          loopResult = loopDetector.check(currentUrl || '', tokenFingerprint, action);
          if (loopResult.loopDetected) {
            console.warn(`[Brain] Loop detected during step recording: ${loopResult.type} (cycle=${loopResult.cycleLength})`);
          }
        }

        console.log(`[Brain] Step complete: ${action.type} → ${effect} | gain: ${gainResult.newMatches} new tokens (rate: ${gainResult.gainRate.toFixed(3)})`);

        sendResponse({
          success: true,
          state: actionResult,
          gainResult,
          loopResult
        });
        return false;
      }

      // ── Combined State Query (for Context Builder, Phase 1A.2) ────────────

      case 'BRAIN_GET_FULL_CONTEXT': {
        // Returns both task state + loop status in one call.
        // Minimizes message-passing overhead for the Context Builder.
        const taskState = taskStateTracker.getSnapshot();
        const loopStatus = (typeof loopDetector !== 'undefined') ? loopDetector.getStatus() : null;
        sendResponse({
          success: true,
          taskState,
          loopStatus,
          isTaskActive: taskStateTracker.isActive()
        });
        return false;
      }

      default:
        sendResponse({ success: false, error: `Unknown BRAIN message type: ${message.type}` });
        return false;
    }
  } catch (err) {
    console.error(`[Brain] Error handling ${message.type}:`, err.message);
    sendResponse({ success: false, error: err.message });
    return false;
  }
});

// Route messages from popup to the ChatGPT content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'FETCH_JSON') {
    const url = chrome.runtime.getURL(`data/${message.filename}`);
    fetch(url)
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (message.type === 'GET_STATUS') {
    // Route status queries to the active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.sendMessage(tabs[0].id, message, sendResponse);
      } else {
        sendResponse({ status: null, error: 'No active tab found' });
      }
    });
    return true; // async
  }
  
  // Handle Main World execution requests from content scripts
  if (message.type === 'EXEC_MAIN_WORLD') {
    if (!sender.tab || !sender.tab.id) {
      sendResponse({ success: false, error: 'No tab context' });
      return false;
    }
    
    const { action, payload } = message;
    
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      func: (action, payload) => {
        try {
          // Helper: find React fiber/internal instance on an element
          function getReactFiber(el) {
            if (!el) return null;
            const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
            return fiberKey ? el[fiberKey] : null;
          }
          function getReactProps(el) {
            if (!el) return null;
            const propsKey = Object.keys(el).find(k => k.startsWith('__reactProps$'));
            return propsKey ? el[propsKey] : null;
          }

          // --- Radix Click (for Radix UI popovers/buttons) ---
          if (action === 'radix_click') {
            const { id } = payload;
            let el = document.getElementById(id);
            if (!el) {
              const rect = JSON.parse(payload.rect);
              el = document.elementFromPoint(rect.x + rect.width/2, rect.y + rect.height/2);
            }
            if (!el) return { success: false, error: 'Element not found' };
            
            const props = getReactProps(el);
            if (props) {
              const mockEvent = {
                preventDefault: () => {}, stopPropagation: () => {},
                nativeEvent: { type: 'click' }, currentTarget: el, target: el, button: 0, buttons: 1
              };
              if (props.onPointerDown) props.onPointerDown(mockEvent);
              if (props.onMouseDown) props.onMouseDown(mockEvent);
              if (props.onClick) props.onClick(mockEvent);
              if (props.onPointerUp) props.onPointerUp(mockEvent);
              if (props.onMouseUp) props.onMouseUp(mockEvent);
              return { success: true, method: 'react' };
            } else {
              el.click();
              return { success: true, method: 'dom' };
            }
          }

          // --- Flow: Clear textbox ---
          else if (action === 'flow_clear') {
            const el = document.getElementById(payload.id) || document.querySelector('div[role="textbox"]');
            if (!el) return { success: false, error: 'Textbox not found' };
            
            el.focus();
            
            // Try to find the React Fiber to call clear() directly if available
            let fiber = getReactFiber(el);
            let attempts = 0;
            while (fiber && attempts < 10) {
              const stateNode = fiber.stateNode;
              if (stateNode && typeof stateNode.clear === 'function') {
                stateNode.clear();
                return { success: true, method: 'react.clear' };
              }
              fiber = fiber.return;
              attempts++;
            }
            
            // Select all
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            sel.removeAllRanges();
            sel.addRange(range);
            
            // Fire sequence of events to simulate backspace/delete
            el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
            el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true }));
            
            // Only use execCommand delete if the events didn't work natively
            document.execCommand('delete', false, null);
            
            el.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
            el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }));
            
            return { success: true, text: el.textContent };
          }

          // --- Flow: Type a chunk of text (word) ---
          else if (action === 'flow_type_chunk') {
            const { id, text } = payload;
            const el = document.getElementById(id) || document.querySelector('div[role="textbox"]');
            if (!el) return { success: false, error: 'Textbox not found' };
            
            el.focus();
            
            // Position cursor at end of existing content
            const sel = window.getSelection();
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false); // Collapse to end
            sel.removeAllRanges();
            sel.addRange(range);
            
            // METHOD 1: DataTransfer Paste (Best for Slate / ProseMirror / Draft.js)
            // Rich text editors explicitly listen to the paste event to update internal structure
            const dt = new DataTransfer();
            dt.setData('text/plain', text);
            const pasteEvent = new ClipboardEvent('paste', {
              clipboardData: dt,
              bubbles: true,
              cancelable: true
            });
            el.dispatchEvent(pasteEvent);
            
            // If the paste event was cancelled, it means the editor handled it!
            // Wait a microsecond for the editor to render
            
            return { success: true, method: 'clipboard_paste' };
          }

          // --- Legacy: react_type (full text) ---
          else if (action === 'react_type') {
            const { id, text } = payload;
            const el = document.getElementById(id);
            if (!el) return { success: false, error: 'Element not found' };
            
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            const inserted = document.execCommand('insertText', false, text);
            if (inserted) return { success: true, method: 'execCommand' };
            
            el.textContent = text;
            el.dispatchEvent(new InputEvent('input', {
              inputType: 'insertText', data: text,
              bubbles: true, cancelable: false
            }));
            return { success: true, method: 'textContent_fallback' };
          }

          return { success: false, error: 'Unknown action: ' + action };
        } catch(e) {
          return { success: false, error: e.message };
        }
      },
      args: [action, payload]
    }).then(results => {
      sendResponse(results[0]?.result || { success: false });
    }).catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    
    return true; // async
  }
  
  // --- NATIVE OS-LEVEL TYPING VIA CHROME DEBUGGER (CDP) ---
  if (message.type === 'NATIVE_TYPE') {
    if (!sender.tab || !sender.tab.id) {
      sendResponse({ success: false, error: 'No tab context' });
      return false;
    }
    
    const tabId = sender.tab.id;
    const { action, text, key, x, y } = message;
    
    const runCDP = (method, params) => {
      return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({tabId}, method, params || {}, (result) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      });
    };
    
    const executeCommand = async () => {
      try {
        if (action === 'insertText') {
          // Focus a target element before typing.
          // Strategies can pass focusSelector to target specific inputs
          // (e.g., Apple's search input). Defaults to textbox for chat UIs.
          const focusSelector = message.focusSelector || 'div[role="textbox"]';
          const escapedSelector = focusSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const evalRes = await runCDP("Runtime.evaluate", {
            expression: "document.querySelector('" + escapedSelector + "')"
          });
          if (evalRes && evalRes.result && evalRes.result.objectId) {
            await runCDP("DOM.focus", { objectId: evalRes.result.objectId });
          }

          await runCDP("Input.insertText", { text: text });
          sendResponse({ success: true, method: 'cdp_insertText' });
        } else if (action === 'mouseMove') {
          // Move cursor without clicking — for hover effects and pre-click positioning
          await runCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          sendResponse({ success: true, method: 'cdp_mouseMove' });
        } else if (action === 'click') {
          // Many web apps (especially React) ignore clicks if the mouse pointer wasn't physically moved there first
          await runCDP("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
          await new Promise(r => setTimeout(r, 50));
          
          await runCDP("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
          await new Promise(r => setTimeout(r, 50));
          
          await runCDP("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
          
          sendResponse({ success: true, method: 'cdp_click' });
        } else if (action === 'keyEvent') {
          await runCDP("Input.dispatchKeyEvent", { 
            type: "rawKeyDown", key: key || text, windowsVirtualKeyCode: key === 'Backspace' ? 8 : 13 
          });
          await runCDP("Input.dispatchKeyEvent", { 
            type: "keyUp", key: key || text 
          });
          sendResponse({ success: true, method: 'cdp_keyEvent' });
        } else {
          sendResponse({ success: false, error: 'Unknown action' });
        }
      } catch (err) {
        console.error('[Flow] CDP Error:', err.message || JSON.stringify(err));
        sendResponse({ success: false, error: err.message || 'Unknown CDP Error' });
      }
    };

    if (!self.attachedTabs) self.attachedTabs = new Set();

    if (!self.attachedTabs.has(tabId)) {
      chrome.debugger.attach({tabId}, "1.3", () => {
        if (chrome.runtime.lastError) {
          console.error('[Flow] Debugger attach error:', chrome.runtime.lastError.message);
          
          // If it is already attached by some other extension or DevTools, we might still be able to inject?
          // Or we are blocked. We'll proceed anyway and if sendCommand fails, it fails.
          if (chrome.runtime.lastError.message.includes("already attached")) {
             self.attachedTabs.add(tabId);
             executeCommand();
             return;
          }
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        self.attachedTabs.add(tabId);
        executeCommand();
      });
    } else {
      executeCommand();
    }

    return true; // async
  }

  // --- GENERIC CDP COMMAND PASSTHROUGH (used by HumanEngine) ---
  // Accepts any CDP method + params and dispatches via chrome.debugger.
  // This enables the motor engine to send arbitrary Input.dispatch* commands.
  if (message.type === 'cdp_command') {
    if (!sender.tab || !sender.tab.id) {
      sendResponse({ success: false, error: 'No tab context' });
      return false;
    }

    const tabId = sender.tab.id;
    const { method, params } = message;

    const runCDP = (m, p) => {
      return new Promise((resolve, reject) => {
        chrome.debugger.sendCommand({tabId}, m, p || {}, (result) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(result);
        });
      });
    };

    const executeCommand = async () => {
      try {
        const result = await runCDP(method, params);
        sendResponse({ success: true, result });
      } catch (err) {
        console.error('[HumanEngine CDP] Error:', method, err.message);
        sendResponse({ success: false, error: err.message });
      }
    };

    if (!self.attachedTabs) self.attachedTabs = new Set();

    if (!self.attachedTabs.has(tabId)) {
      chrome.debugger.attach({tabId}, "1.3", () => {
        if (chrome.runtime.lastError) {
          if (chrome.runtime.lastError.message.includes("already attached")) {
            self.attachedTabs.add(tabId);
            executeCommand();
            return;
          }
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
          return;
        }
        self.attachedTabs.add(tabId);
        executeCommand();
      });
    } else {
      executeCommand();
    }

    return true; // async
  }

  // ─── Multi-Page Recon Orchestrator (message handler) ─────
  if (message.type === 'TRIGGER_RECON') {
    const { url, depth = 1, maxPages = 20, probe = true } = message;
    
    (async () => {
      const result = await _executeReconCrawl(url, depth, maxPages, probe);
      sendResponse(result);
    })();

    return true; // async
  }
});

// ─── Cross-Page Element Deduplication ─────────────────────
// Identifies elements that appear on every page (navbars, footers, sidebars)
// and moves them to commonElements, removing duplicates from individual pages.
function _deduplicateAcrossPages(pageBlueprints) {
  if (pageBlueprints.length < 2) {
    return { commonElements: [], pages: pageBlueprints };
  }

  // Build selector → count map across all pages
  const selectorCounts = new Map();
  for (const page of pageBlueprints) {
    const pageSelectors = new Set();
    for (const el of (page.interactiveElements || [])) {
      if (el.selector && !pageSelectors.has(el.selector)) {
        pageSelectors.add(el.selector);
        selectorCounts.set(el.selector, (selectorCounts.get(el.selector) || 0) + 1);
      }
    }
  }

  // Common = appears on EVERY page
  const totalPages = pageBlueprints.length;
  const commonSelectors = new Set();
  for (const [sel, count] of selectorCounts) {
    if (count >= totalPages) {
      commonSelectors.add(sel);
    }
  }

  if (commonSelectors.size === 0) {
    return { commonElements: [], pages: pageBlueprints };
  }

  // Extract common elements from first page (they're the same everywhere)
  const commonElements = (pageBlueprints[0].interactiveElements || [])
    .filter(el => commonSelectors.has(el.selector));

  // Remove common elements from each page's list
  const cleanedPages = pageBlueprints.map(page => ({
    ...page,
    interactiveElements: (page.interactiveElements || [])
      .filter(el => !commonSelectors.has(el.selector))
  }));

  console.log(`[Recon] Deduplication: ${commonSelectors.size} elements appear on all ${totalPages} pages → moved to commonElements`);

  return { commonElements, pages: cleanedPages };
}

// ─── Standalone Multi-Page Recon Crawler ──────────────────
async function _executeReconCrawl(url, depth = 1, maxPages = 20, probe = true) {
  console.log(`[Recon] Starting multi-page scan: ${url} (depth=${depth}, maxPages=${maxPages}, probe=${probe})`);

  const visited = new Set();
  const pageBlueprints = [];
  const queue = [{ url, currentDepth: 0 }];

  let targetOrigin;
  try {
    targetOrigin = new URL(url).origin;
  } catch (e) {
    return { success: false, error: 'Invalid URL: ' + url };
  }

  let tab;
  try {
    tab = await chrome.tabs.create({ url, active: false });
  } catch (e) {
    return { success: false, error: 'Failed to create tab: ' + e.message };
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms + Math.floor(Math.random() * 200)));

  const waitForTabLoad = (tabId, timeoutMs = 15000) => {
    return new Promise((resolve) => {
      const startTime = Date.now();
      const check = () => {
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError) { resolve(false); return; }
          if (t.status === 'complete') { resolve(true); return; }
          if (Date.now() - startTime > timeoutMs) { resolve(true); return; }
          setTimeout(check, 500);
        });
      };
      check();
    });
  };

  const scanTab = (tabId) => {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'SCAN_PAGE', probe }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[Recon] Scan message error:', chrome.runtime.lastError.message);
          resolve(null);
          return;
        }
        resolve(response && response.success ? response.blueprint : null);
      });
    });
  };

  const getLinks = (tabId) => {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: 'GET_NAV_LINKS' }, (response) => {
        if (chrome.runtime.lastError) { resolve([]); return; }
        resolve(response && response.success ? response.links : []);
      });
    });
  };

  try {
    while (queue.length > 0 && pageBlueprints.length < maxPages) {
      const { url: pageUrl, currentDepth } = queue.shift();

      let normalizedUrl;
      try {
        const parsed = new URL(pageUrl, targetOrigin);
        if (parsed.origin !== targetOrigin) continue;
        normalizedUrl = parsed.pathname + parsed.search;
      } catch (e) { continue; }

      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      const fullUrl = targetOrigin + normalizedUrl;
      console.log(`[Recon] Scanning page ${pageBlueprints.length + 1}: ${fullUrl} (depth=${currentDepth})`);

      if (pageBlueprints.length > 0) {
        try {
          await chrome.tabs.update(tab.id, { url: fullUrl });
        } catch (e) {
          console.warn('[Recon] Failed to navigate tab:', e.message);
          continue;
        }
      }

      await waitForTabLoad(tab.id);
      await sleep(2000);

      const blueprint = await scanTab(tab.id);
      if (blueprint) {
        pageBlueprints.push(blueprint);
        console.log(`[Recon] ✓ Page scanned: ${blueprint.summary?.totalInteractive || 0} interactive elements`);

        if (currentDepth < depth) {
          const links = await getLinks(tab.id);
          for (const link of links) {
            if (!visited.has(link.href) && link.isInternal) {
              // URL safety filter — never navigate to dangerous pages
              if (UNSAFE_URL_PATTERNS.test(link.href)) {
                console.log(`[Recon] ⛔ Skipping unsafe URL: ${link.href}`);
                continue;
              }
              queue.push({ url: link.href, currentDepth: currentDepth + 1 });
            }
          }
          console.log(`[Recon] Found ${links.length} internal links, queue size: ${queue.length}`);
        }
      } else {
        console.warn('[Recon] ✗ Scan failed for:', fullUrl);
      }

      if (queue.length > 0) {
        await sleep(1500);
      }
    }

    try { chrome.tabs.remove(tab.id); } catch (e) {}

    // Deduplicate elements that appear on every page (nav, footer, etc.)
    const deduplicatedPages = _deduplicateAcrossPages(pageBlueprints);

    const siteBlueprint = {
      siteUrl: url,
      hostname: targetOrigin.replace(/^https?:\/\//, ''),
      scannedAt: new Date().toISOString(),
      totalPagesScanned: pageBlueprints.length,
      maxDepth: depth,
      commonElements: deduplicatedPages.commonElements,
      pages: deduplicatedPages.pages
    };

    try {
      await fetch(`${BRIDGE}/api/recon-site`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(siteBlueprint)
      });
      console.log(`[Recon] ✓ Site blueprint sent to bridge (${pageBlueprints.length} pages, ${deduplicatedPages.commonElements.length} common elements deduplicated)`);
    } catch (e) {
      console.error('[Recon] Failed to send site blueprint:', e.message);
    }

    return { success: true, pagesScanned: pageBlueprints.length };

  } catch (err) {
    console.error('[Recon] Crawl error:', err.message);
    try { chrome.tabs.remove(tab.id); } catch (e) {}
    return { success: false, error: err.message };
  }
}
