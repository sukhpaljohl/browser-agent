/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * DOM Stability Watcher — Post-Action Stabilization Gate v2
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  After any HumanEngine action (click, type, navigate), this module
 *           waits for the page to settle before the agent observes the new DOM.
 *           Without this, the agent reads half-loaded pages and makes bad
 *           decisions based on incomplete information.
 *
 * Why blind timeouts fail:
 *   - `await sleep(3000)` wastes 3 seconds on a page that settled in 200ms.
 *   - `await sleep(3000)` is too short for an LLM streaming a 15-second response.
 *   - Naive MutationObserver fires on ads, tracking pixels, and CSS animations.
 *
 * Architecture — 3 Independent Signals + 1 Dynamic Adaptation:
 *
 *   Signal 1 — Filtered DOM Quietness:
 *     MutationObserver that ignores noise (script/style/class changes) and
 *     only resets the debounce timer on meaningful mutations (childList,
 *     characterData, interactive attribute changes like disabled/aria-expanded).
 *
 *   Signal 2 — Visible Impact Loaders (Geometric Gate):
 *     Checks for loading indicators ([aria-busy], .spinner, .skeleton, etc.)
 *     but ONLY counts them if they are geometrically visible to the user
 *     (non-zero rect, opacity > 0, not hidden). Prevents hanging on invisible
 *     cached loaders left in the DOM.
 *
 *   Signal 3 — Optional Expectation Fast-Forward:
 *     The BrainExecutor passes an optional `expectedEffect` (e.g., 'navigation',
 *     'enablement', 'subtree_expansion'). If the expected condition is met early,
 *     the watcher instantly resolves — bypassing the debounce timer entirely.
 *     If the condition is NOT met, it safely falls back to standard DOM/Visual
 *     quiet debouncing. Rule: "Trust expectations... but don't depend on them."
 *
 *   Kinetic Streaming Detection:
 *     Dynamically detects rapid text mutations (e.g., LLM streaming). If >3
 *     characterData mutations occur within 500ms, the debounce window is
 *     auto-extended from 1200ms to 3000ms. No hardcoded hostnames.
 *
 * Ref: Implementation Plan v2.8 §15 Phase 1A.3a
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var BrowserAgent = BrowserAgent || {};

BrowserAgent.DOMStabilityWatcher = class DOMStabilityWatcher {

  // ─── Constants ─────────────────────────────────────────────────────────────

  /** Tags whose mutations are always ignored (framework noise) */
  static IGNORED_TAGS = new Set([
    'script', 'style', 'noscript', 'meta', 'link', 'iframe', 'svg'
  ]);

  /** Attribute mutations we DO care about (interactive state changes) */
  static TRACKED_ATTRIBUTES = new Set([
    'disabled', 'aria-hidden', 'aria-expanded', 'aria-busy',
    'aria-disabled', 'value', 'checked', 'selected', 'open',
    'hidden', 'aria-selected', 'aria-checked'
  ]);

  /** CSS selectors for loading indicators */
  static LOADER_SELECTORS = [
    '[aria-busy="true"]',
    '[role="progressbar"]',
    '.loader',
    '.loading',
    '.spinner',
    '.skeleton',
    '.shimmer',
    'svg.animate-spin'
  ].join(', ');

  /** Default quiet window (ms) — SPA reconciliation margin */
  static DEFAULT_QUIET_WINDOW_MS = 1200;

  /** Quiet window for typing actions (ms) — accounts for debounced search fields */
  static TYPING_QUIET_WINDOW_MS = 2000;

  /** Quiet window for streaming content (ms) — LLMs can pause mid-sentence */
  static STREAMING_QUIET_WINDOW_MS = 3000;

  /** Hard ceiling — never wait longer than this (ms) */
  static MAX_WAIT_MS = 15000;

  /** Threshold for kinetic streaming detection: N text mutations within the window */
  static STREAMING_MUTATION_THRESHOLD = 3;

  /** Window (ms) within which text mutations must occur to trigger streaming mode */
  static STREAMING_DETECTION_WINDOW_MS = 500;

  /** Minimum wait before declaring stability (ms) — prevents premature resolution */
  static MIN_WAIT_MS = 150;

  // ─── Constructor ───────────────────────────────────────────────────────────

  /**
   * @param {Object} context - Action context from BrainExecutor
   * @param {string} [context.lastActionType='click'] - The action that was just performed
   * @param {string|null} [context.expectedEffect=null] - Optional fast-forward hint:
   *   'navigation'        — Short-circuit when window.location.href changes
   *   'enablement'        — Short-circuit when a disabled button becomes enabled
   *   'subtree_expansion' — Short-circuit when a large chunk of nodes is added
   */
  constructor(context = {}) {
    // ── Context ──
    this.lastActionType = context.lastActionType || 'click';
    this.expectedEffect = context.expectedEffect || null;

    // ── Timing Config ──
    this.maxWaitMs = DOMStabilityWatcher.MAX_WAIT_MS;
    this.quietWindowMs = this._calculateQuietWindow();

    // ── Runtime State ──
    this._observer = null;
    this._debounceTimer = null;
    this._timeoutTimer = null;
    this._expectationCheckInterval = null;
    this._resolvePromise = null;
    this._resolved = false;
    this._startTime = 0;
    this._mutationCount = 0;
    this._meaningfulMutationCount = 0;

    // ── Kinetic Streaming State ──
    this._textMutationTimestamps = [];
    this._isStreaming = false;

    // ── Expectation Baseline (captured at construction time) ──
    this._baselineUrl = window.location.href;
    this._baselineDisabledButtons = this._countDisabledButtons();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Wait for the DOM to stabilize after an action.
   *
   * Returns a structured result indicating HOW stability was achieved:
   *   - 'stable'                  — DOM went quiet within the quiet window
   *   - 'semantic_readiness_met'  — Expected effect was observed (fast-forward)
   *   - 'partial_progress'        — Timed out, but DOM DID change
   *   - 'forced_unstable'         — Timed out, DOM did NOT change at all
   *
   * @returns {Promise<StabilityResult>}
   *
   * @typedef {Object} StabilityResult
   * @property {string} status - 'stable' | 'semantic_readiness_met' | 'partial_progress' | 'forced_unstable'
   * @property {number} waitedMs - How long we actually waited
   * @property {number} mutationCount - Total mutations observed (including ignored)
   * @property {number} meaningfulMutationCount - Mutations that reset the debounce timer
   * @property {boolean} streamingDetected - Whether kinetic streaming was detected
   */
  waitForStability() {
    return new Promise((resolve) => {
      this._resolvePromise = resolve;
      this._startTime = Date.now();

      console.log(`[StabilityWatcher] ⏳ Waiting for stability (action: ${this.lastActionType}, quietWindow: ${this.quietWindowMs}ms, expected: ${this.expectedEffect || 'none'})`);

      // 1. Start the filtered MutationObserver (Signal 1)
      this._startObserver();

      // 2. Start the expectation checker (Signal 3) — if an expectation was provided
      if (this.expectedEffect) {
        this._startExpectationChecker();
      }

      // 3. Start the debounce countdown — if nothing resets it, we'll resolve
      this._resetDebounce();

      // 4. Hard timeout safety net — never wait forever
      this._timeoutTimer = setTimeout(() => {
        this._forceExit();
      }, this.maxWaitMs);
    });
  }

  // ─── Signal 1: Filtered DOM Quietness ──────────────────────────────────────

  /**
   * Start a MutationObserver that watches for meaningful DOM changes.
   * Filters out framework noise (script injection, CSS class changes, etc.)
   * and only resets the debounce timer when something interactive changes.
   * @private
   */
  _startObserver() {
    this._observer = new MutationObserver((mutations) => {
      let meaningfulFound = false;

      for (const mutation of mutations) {
        this._mutationCount++;

        // ── Filter: Ignore mutations inside irrelevant tags ──
        const target = mutation.target;
        const tagName = (target.tagName || target.parentElement?.tagName || '').toLowerCase();
        if (DOMStabilityWatcher.IGNORED_TAGS.has(tagName)) continue;

        // ── childList: New nodes added or removed ──
        if (mutation.type === 'childList') {
          // Check if any added/removed nodes are non-trivial
          const hasNonTrivial = this._hasNonTrivialNodes(mutation.addedNodes) ||
                                this._hasNonTrivialNodes(mutation.removedNodes);
          if (hasNonTrivial) {
            meaningfulFound = true;
          }
        }

        // ── characterData: Text content changed ──
        if (mutation.type === 'characterData') {
          // Track for kinetic streaming detection
          this._recordTextMutation();
          meaningfulFound = true;
        }

        // ── attributes: Only track interactive state attributes ──
        if (mutation.type === 'attributes') {
          if (DOMStabilityWatcher.TRACKED_ATTRIBUTES.has(mutation.attributeName)) {
            meaningfulFound = true;
          }
          // All other attribute changes (class, style, data-*) are ignored
        }
      }

      if (meaningfulFound) {
        this._meaningfulMutationCount++;
        this._resetDebounce();
      }
    });

    this._observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: [...DOMStabilityWatcher.TRACKED_ATTRIBUTES, 'class', 'style']
      // Note: We observe class/style attribute mutations too, but filter them
      // out in the callback. This is because MutationObserver's attributeFilter
      // can't do negative filters — we need to observe broadly and filter in JS.
      // However, we ONLY list specific attributes to avoid the cost of observing
      // every single attribute change on every element.
    });
  }

  /**
   * Check if a NodeList contains at least one non-trivial node.
   * Trivial nodes: empty text nodes, script/style elements, comment nodes.
   * @private
   * @param {NodeList} nodes
   * @returns {boolean}
   */
  _hasNonTrivialNodes(nodes) {
    if (!nodes || nodes.length === 0) return false;

    for (const node of nodes) {
      // Skip comment nodes
      if (node.nodeType === Node.COMMENT_NODE) continue;

      // Skip empty text nodes
      if (node.nodeType === Node.TEXT_NODE) {
        if ((node.textContent || '').trim().length > 0) return true;
        continue;
      }

      // Skip ignored tag types
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node.tagName || '').toLowerCase();
        if (DOMStabilityWatcher.IGNORED_TAGS.has(tag)) continue;
        return true; // Any non-ignored element is non-trivial
      }
    }

    return false;
  }

  // ─── Signal 2: Visible Impact Loaders (Geometric Gate) ─────────────────────

  /**
   * Check if any loading indicators are currently visible on the page.
   * Uses geometric checks to avoid blocking on invisible/cached loaders.
   * @private
   * @returns {boolean} True if at least one visible loader is present
   */
  _hasVisibleLoaders() {
    try {
      const loaders = document.querySelectorAll(DOMStabilityWatcher.LOADER_SELECTORS);
      if (loaders.length === 0) return false;

      for (const el of loaders) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;

        const style = window.getComputedStyle(el);
        if (style.visibility === 'hidden') continue;
        if (style.display === 'none') continue;
        if (parseFloat(style.opacity) <= 0) continue;

        // This loader is geometrically visible — page is still loading
        return true;
      }
    } catch (e) {
      // DOM access can fail during navigations — treat as no loaders
      console.warn('[StabilityWatcher] Loader check error:', e.message);
    }

    return false;
  }

  // ─── Signal 3: Optional Expectation Fast-Forward ───────────────────────────

  /**
   * Start polling for the expected effect. If detected, resolve immediately.
   * If not detected, this is a no-op — the standard debounce handles it.
   *
   * Rule: "Trust expectations... but don't depend on them."
   * @private
   */
  _startExpectationChecker() {
    // Poll every 100ms — fast enough to catch navigation, light enough to not burn CPU
    this._expectationCheckInterval = setInterval(() => {
      if (this._resolved) return;

      // Enforce minimum wait to avoid premature resolution
      if (Date.now() - this._startTime < DOMStabilityWatcher.MIN_WAIT_MS) return;

      if (this._checkExpectation()) {
        this._resolve('semantic_readiness_met');
      }
    }, 100);
  }

  /**
   * Check if the expected effect has occurred.
   * @private
   * @returns {boolean} True if the expected condition is met
   */
  _checkExpectation() {
    switch (this.expectedEffect) {
      case 'navigation':
        // URL changed → the navigation happened
        return window.location.href !== this._baselineUrl;

      case 'enablement':
        // A previously disabled button is now enabled
        return this._countDisabledButtons() < this._baselineDisabledButtons;

      case 'subtree_expansion':
        // A large chunk of new DOM nodes appeared (≥ 5 meaningful mutations)
        return this._meaningfulMutationCount >= 5;

      default:
        return false;
    }
  }

  /**
   * Count currently disabled buttons on the page.
   * Used as a baseline to detect enablement changes.
   * @private
   * @returns {number}
   */
  _countDisabledButtons() {
    try {
      return document.querySelectorAll(
        'button[disabled], input[type="submit"][disabled], [role="button"][aria-disabled="true"]'
      ).length;
    } catch (e) {
      return 0;
    }
  }

  // ─── Kinetic Streaming Detection ───────────────────────────────────────────

  /**
   * Record a text mutation timestamp for streaming detection.
   * If rapid text mutations are detected, auto-extend the debounce window.
   * @private
   */
  _recordTextMutation() {
    const now = Date.now();
    this._textMutationTimestamps.push(now);

    // Keep only timestamps within the detection window
    const cutoff = now - DOMStabilityWatcher.STREAMING_DETECTION_WINDOW_MS;
    this._textMutationTimestamps = this._textMutationTimestamps.filter(t => t >= cutoff);

    // If we've crossed the threshold, activate streaming mode
    if (!this._isStreaming &&
        this._textMutationTimestamps.length >= DOMStabilityWatcher.STREAMING_MUTATION_THRESHOLD) {
      this._isStreaming = true;
      this.quietWindowMs = DOMStabilityWatcher.STREAMING_QUIET_WINDOW_MS;
      console.log(`[StabilityWatcher] 📡 Streaming detected — extending quiet window to ${this.quietWindowMs}ms`);
    }
  }

  // ─── Debounce Management ───────────────────────────────────────────────────

  /**
   * Reset the debounce timer. Called every time a meaningful mutation occurs.
   * When the timer finally fires without being reset, the DOM is "quiet."
   * @private
   */
  _resetDebounce() {
    if (this._resolved) return;

    clearTimeout(this._debounceTimer);

    this._debounceTimer = setTimeout(() => {
      if (this._resolved) return;

      // ── Signal 2 check: Are visible loaders still present? ──
      if (this._hasVisibleLoaders()) {
        // Loaders are still showing — don't resolve, wait for next mutation
        console.log('[StabilityWatcher] ⏳ DOM quiet but visible loaders detected — extending wait');
        this._resetDebounce();
        return;
      }

      // DOM is quiet AND no visible loaders → stable
      this._resolve('stable');
    }, this.quietWindowMs);
  }

  // ─── Safety Boundary (Force Exit) ──────────────────────────────────────────

  /**
   * Force exit after maxWaitMs. Determines the final status based on
   * whether any meaningful DOM changes occurred during the wait period.
   * @private
   */
  _forceExit() {
    if (this._resolved) return;

    if (this._meaningfulMutationCount > 0) {
      // DOM changed but never fully settled — still progressing
      console.warn(`[StabilityWatcher] ⚠ Timeout reached (${this.maxWaitMs}ms) with ${this._meaningfulMutationCount} meaningful mutations — partial progress`);
      this._resolve('partial_progress');
    } else {
      // Nothing changed at all — the action may have had no effect
      console.warn(`[StabilityWatcher] ⚠ Timeout reached (${this.maxWaitMs}ms) with NO mutations — forced unstable`);
      this._resolve('forced_unstable');
    }
  }

  // ─── Resolution & Cleanup ──────────────────────────────────────────────────

  /**
   * Resolve the waitForStability() promise and clean up all observers/timers.
   * Guaranteed to only fire once (idempotent).
   * @private
   * @param {string} status - The stability status
   */
  _resolve(status) {
    if (this._resolved) return;
    this._resolved = true;

    const waitedMs = Date.now() - this._startTime;

    // ── Cleanup ──
    this._cleanup();

    // ── Build result ──
    const result = {
      status,
      waitedMs,
      mutationCount: this._mutationCount,
      meaningfulMutationCount: this._meaningfulMutationCount,
      streamingDetected: this._isStreaming
    };

    console.log(`[StabilityWatcher] ✓ Resolved: ${status} (waited ${waitedMs}ms, ${this._meaningfulMutationCount} meaningful mutations${this._isStreaming ? ', streaming detected' : ''})`);

    // ── Record to universal diagnostics buffer ──
    if (BrowserAgent.Diagnostics) {
      BrowserAgent.Diagnostics.record('stability', result);
    }

    this._resolvePromise(result);
  }

  /**
   * Disconnect observer and clear all pending timers.
   * @private
   */
  _cleanup() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    clearTimeout(this._debounceTimer);
    this._debounceTimer = null;
    clearTimeout(this._timeoutTimer);
    this._timeoutTimer = null;
    clearInterval(this._expectationCheckInterval);
    this._expectationCheckInterval = null;
  }

  // ─── Quiet Window Calculation ──────────────────────────────────────────────

  /**
   * Calculate the initial quiet window based on the action context.
   * This is the starting value — kinetic streaming detection may override
   * it upward at runtime.
   * @private
   * @returns {number} Quiet window in milliseconds
   */
  _calculateQuietWindow() {
    switch (this.lastActionType) {
      case 'type':
      case 'search':
        // Typing/search actions have inherent delays (debounced inputs, XHR)
        return DOMStabilityWatcher.TYPING_QUIET_WINDOW_MS;

      default:
        // Clicks, navigations, scrolls — use standard window
        return DOMStabilityWatcher.DEFAULT_QUIET_WINDOW_MS;
    }
  }
};
