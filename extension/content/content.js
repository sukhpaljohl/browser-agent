/**
 * Content Script — runs on all pages
 * Initializes the POMDP engine and listens for EXECUTE_PROMPT messages
 * from the Service Worker's CommandRelay system.
 *
 * Command delivery flow:
 *   Bridge ←poll── Service Worker ──sendMessage──→ This script
 *   Bridge ←post── Service Worker ←──sendResponse── This script
 */
(function () {
  'use strict';

  const BRIDGE_URL = 'http://localhost:3847';


  // --- Auto-detect: Are we in a headless/Puppeteer browser or the real one? ---
  // Puppeteer sets navigator.webdriver = true. The Stealth plugin may hide it,
  // but our own launch_extension.js passes a custom flag we can check instead.
  const IS_HEADLESS = (() => {
    try {
      // Our launch script injects this flag via --flag-switches-begin
      // Fallback: check if Puppeteer's webdriver flag leaked through
      return navigator.webdriver === true ||
             /HeadlessChrome/i.test(navigator.userAgent);
    } catch (e) { return false; }
  })();
  const AGENT_MODE = IS_HEADLESS ? 'headless' : 'browser';


  // --- Remote Logging Telemetry Hook ---
  const _log = console.log;
  const _warn = console.warn;
  const _error = console.error;

  function remoteLog(level, args) {
    try {
      const msg = Array.from(args).map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      fetch(`${BRIDGE_URL}/api/extension-log`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ level, msg })
      }).catch(() => {});
    } catch (e) {}
  }

  console.log = function() { remoteLog('LOG', arguments); _log.apply(console, arguments); };
  console.warn = function() { remoteLog('WARN', arguments); _warn.apply(console, arguments); };
  console.error = function() { remoteLog('ERROR', arguments); _error.apply(console, arguments); };

  let engine = null;
  let strategy = null;
  let isProcessing = false;

  function init() {
    engine = new BrowserAgent.POMDPEngine();
    
    // Brain-powered generic executor — works on any website
    // No site-specific strategies needed. Uses DOMRecon → Pruner → HumanEngine.
    const executor = new BrowserAgent.BrainExecutor(engine);

    // Phase 1B.1: Wrap executor with UniversalStrategy (reactive control layer).
    // If UniversalStrategy is not loaded, fall back to raw executor.
    if (BrowserAgent.UniversalStrategy) {
      strategy = new BrowserAgent.UniversalStrategy(executor);
      console.log('[BrowserAgent] UniversalStrategy active (reactive control layer)');
    } else {
      strategy = executor;
      console.warn('[BrowserAgent] UniversalStrategy not loaded — using raw BrainExecutor');
    }

    // ── Phase 1B.2.1: Retroactive Navigation Scoring ──────────────────────
    // Check if the Service Worker has an unscored navigation action from a
    // previous content script that died during a page transition. If so,
    // evaluate this page against the goal and report the score back.
    // This is fire-and-forget — it doesn't block init or command handling.
    try {
      chrome.runtime.sendMessage({ type: 'BRAIN_CHECK_PENDING_NAV' }, (response) => {
        if (chrome.runtime.lastError || !response?.success) return;

        const pendingNav = response.pendingNav;
        if (!pendingNav) return;

        console.log(`[BrowserAgent] Found unscored navigation: "${(pendingNav.nodeText || '').slice(0, 40)}" — evaluating...`);

        const goalTokens = response.goalTokens || [];
        if (goalTokens.length === 0) {
          console.warn('[BrowserAgent] No goal tokens — skipping retroactive scoring');
          return;
        }

        // Run lightweight evaluation (no stability wait, no snapshot)
        if (BrowserAgent.ProgressEstimator && BrowserAgent.ProgressEstimator.quickEvaluate) {
          const evalResult = BrowserAgent.ProgressEstimator.quickEvaluate(goalTokens);

          // Report score to SW for failure penalty decision
          chrome.runtime.sendMessage({
            type: 'BRAIN_SCORE_PENDING_NAV',
            progressScore: evalResult.progressScore,
            url: evalResult.url
          }, (scoreResponse) => {
            if (chrome.runtime.lastError) return;
            if (scoreResponse?.action === 'marked_failure') {
              console.log(`[BrowserAgent] ✗ Retroactive nav failure — node "${scoreResponse.nodeSignature}" penalized`);
            } else if (scoreResponse?.action === 'accepted') {
              console.log(`[BrowserAgent] ✓ Retroactive nav accepted (score: ${evalResult.progressScore.toFixed(3)})`);
            }
          });
        } else {
          console.warn('[BrowserAgent] ProgressEstimator.quickEvaluate not available — skipping retroactive scoring');
        }
      });
    } catch (e) {
      // Non-fatal — retroactive scoring is best-effort
      console.warn('[BrowserAgent] Retroactive scoring check failed (non-fatal):', e.message);
    }

    // Load persisted state
    try {
      const saved = localStorage.getItem('browserAgent_state');
      if (saved) {
        engine.load(JSON.parse(saved));
        console.log('[BrowserAgent] Restored saved state');
      }
    } catch (e) {
      console.warn('[BrowserAgent] Could not restore state:', e);
    }

    console.log(`[BrowserAgent] Initialized on ${window.location.hostname} (mode: ${AGENT_MODE})`);
    // Commands are delivered by the Service Worker via chrome.tabs.sendMessage.
    // No content-script polling needed — see service-worker.js CommandRelay.
  }

  function saveState() {
    try {
      localStorage.setItem('browserAgent_state', JSON.stringify(engine.save()));
    } catch (e) {
      console.warn('[BrowserAgent] Save failed:', e);
    }
  }

  // Command delivery is handled by the Service Worker's CommandRelay.
  // The SW polls the bridge, dispatches via chrome.tabs.sendMessage,
  // and posts results back. See EXECUTE_PROMPT handler below.

  // Expose messaging API for popup & service worker
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'GET_STATUS') {
      sendResponse({
        status: engine ? engine.getStatus() : null,
        isProcessing,
        hostname: window.location.hostname
      });
    } else if (msg.type === 'EXECUTE_PROMPT') {
      (async () => {
        isProcessing = true;
        console.log('[BrowserAgent] Prompt received:', (msg.prompt || '').substring(0, 60) + '...');
        if (msg.images && msg.images.length > 0) {
          console.log('[BrowserAgent] Images attached:', msg.images.length);
        }
        try {
          const result = await strategy.executeFullFlow(msg.prompt, msg.images || []);
          saveState();
          sendResponse(result);
          console.log('[BrowserAgent] === Flow complete. Success:', result.success, '===');
        } catch (e) {
          console.error('[BrowserAgent] EXECUTE_PROMPT error:', e);
          sendResponse({ success: false, error: e.message });
        } finally {
          isProcessing = false;
          console.log('[BrowserAgent] Ready for next prompt (isProcessing = false)');
        }
      })();
      return true; // keep channel open for async response

    // ── DOMRecon: Full page scan (triggered externally) ──
    } else if (msg.type === 'SCAN_PAGE') {
      (async () => {
        try {
          const probe = msg.probe !== undefined ? msg.probe : false;
          console.log('[BrowserAgent] SCAN_PAGE triggered for', window.location.href, '(probe=' + probe + ')');
          const blueprint = await BrowserAgent.DOMRecon.generateBlueprint({ probe });
          // Send to bridge server
          await BrowserAgent.DOMRecon.sendBlueprint(blueprint);
          sendResponse({ success: true, blueprint });
        } catch (e) {
          console.error('[BrowserAgent] SCAN_PAGE error:', e);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async

    // ── DOMRecon: Get navigation links for multi-page crawl ──
    } else if (msg.type === 'GET_NAV_LINKS') {
      try {
        const links = BrowserAgent.DOMRecon.extractNavigationLinks();
        sendResponse({ success: true, links: links.filter(l => l.isInternal) });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }

    // ── Observer Mode: Start passive observation ──
    } else if (msg.type === 'START_OBSERVING') {
      (async () => {
        try {
          console.log('[BrowserAgent] START_OBSERVING triggered');
          const result = await BrowserAgent.DOMRecon.startObserving();
          sendResponse({ success: true, result });
        } catch (e) {
          console.error('[BrowserAgent] START_OBSERVING error:', e);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async

    // ── Observer Mode: Stop and get final report ──
    } else if (msg.type === 'STOP_OBSERVING') {
      (async () => {
        try {
          console.log('[BrowserAgent] STOP_OBSERVING triggered');
          const report = await BrowserAgent.DOMRecon.stopObserving();
          // Send the full report to bridge
          await BrowserAgent.DOMRecon.sendBlueprint(report);
          sendResponse({ success: true, report });
        } catch (e) {
          console.error('[BrowserAgent] STOP_OBSERVING error:', e);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async

    // ── Observer Mode: Re-scan and diff ──
    } else if (msg.type === 'RESCAN') {
      (async () => {
        try {
          const diff = await BrowserAgent.DOMRecon.rescan();
          sendResponse({ success: true, diff });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true; // async

    // ── Observer Mode: Get accumulated observations ──
    } else if (msg.type === 'GET_OBSERVATIONS') {
      try {
        const obs = BrowserAgent.DOMRecon.getObservations();
        sendResponse({ success: true, observations: obs });
      } catch (e) {
        sendResponse({ success: false, error: e.message });
      }
    }
    return false;
  });

  // Boot
  if (document.readyState === 'complete') {
    init();
  } else {
    window.addEventListener('load', init);
  }
})();
