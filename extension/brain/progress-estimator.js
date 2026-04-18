/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Progress Estimator — Post-Action Observation & Evaluation Layer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  After the Stabilization Gate (Phase 1A.3a) resolves, this module
 *           measures whether the action just taken moved the agent closer to
 *           or further from its goal.
 *
 * Pipeline position:
 *   Act → [1A.3a StabilityWatcher] → [1A.3b ProgressEstimator] → next cycle
 *
 * Architecture:
 *   1. captureSnapshot()   — called BEFORE the action to baseline the DOM
 *   2. evaluate()          — called AFTER stability resolves to compute progress
 *
 * Progress is computed from a 4-signal composite:
 *   - Keyword overlap:    How many goal tokens appear on the page? (0.4 weight)
 *   - URL match:          How many goal tokens appear in the URL? (0.2 weight)
 *   - Interaction depth:  How deep into the task are we? (0.2 weight)
 *   - State change score: How significant was the DOM effect? (0.2 weight)
 *
 * Plus modifiers:
 *   - Information gain rate:  Leading indicator — new goal tokens discovered
 *   - Repetition penalty:     Kills fake progress from repeated actions
 *   - Micro-success bonuses:  Rewards form-level progress (input filled, etc.)
 *
 * Intent drift is flagged when progress stays < 0.15 for 3+ consecutive steps.
 *
 * Task lifecycle:
 *   - Tasks are lazily initialized when the first prompt arrives.
 *   - Subsequent prompts are classified as "instructions" (same goal) or
 *     "goal shifts" (new goal → task reset).
 *   - Goal shift detection uses a first-word gate (UI command verbs are always
 *     instructions) + Jaccard similarity for content-bearing prompts.
 *
 * Ref: Implementation Plan v2.8 §2.4, §15 Phase 1A.3b
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var BrowserAgent = BrowserAgent || {};

BrowserAgent.ProgressEstimator = (() => {
  'use strict';

  // ═══════════════════════════════════════════════════════════════
  //  CONSTANTS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Stopwords for tokenization — MUST match task-state.js exactly.
   * Any divergence here will corrupt keyword overlap and info gain rate.
   */
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'than', 'too', 'very',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that'
  ]);

  /**
   * UI command verbs — prompts starting with these are ALWAYS instructions,
   * never goal shifts. These are mechanical browser-automation verbs.
   *
   * Notably absent: 'search', 'find', 'buy', 'get', 'order', 'book'
   * — these carry goal intent and should pass through to Jaccard check.
   */
  const UI_COMMAND_VERBS = new Set([
    'click', 'tap', 'press', 'type', 'scroll', 'read', 'expand',
    'collapse', 'toggle', 'navigate', 'nav', 'goto', 'extract',
    'open', 'close', 'select', 'check', 'uncheck', 'submit',
    'hover', 'focus', 'drag', 'drop', 'wait', 'refresh',
    'back', 'forward', 'status', 'audit', 'stealth', 'images'
  ]);

  /**
   * Weak navigation/utility words — tokens that don't carry domain intent.
   * Used in hasStrongContentWord() to distinguish "scroll down" from "buy shoes".
   */
  const WEAK_WORDS = new Set([
    'up', 'down', 'left', 'right', 'top', 'bottom', 'page',
    'next', 'previous', 'prev', 'back', 'forward', 'home',
    'here', 'there', 'go', 'send', 'enter', 'ok', 'yes', 'no',
    'cancel', 'confirm', 'accept', 'deny', 'dismiss', 'done',
    'menu', 'button', 'link', 'tab', 'input', 'field', 'form'
  ]);

  /** Effect quality scores — maps effect type to state change signal value */
  const EFFECT_QUALITY = {
    'navigation':     1.0,
    'content_load':   0.8,
    'modal_open':     0.7,
    'enable_element': 0.7,
    'state_change':   0.6,
    'modal_close':    0.5,
    'disable_element': 0.3,
    'none':           0.0
  };

  /** Jaccard threshold below which a prompt is considered a goal shift */
  const GOAL_SHIFT_JACCARD_THRESHOLD = 0.15;

  /** CSS selectors for modal/dialog detection */
  const MODAL_SELECTORS = '[role="dialog"], [aria-modal="true"], .modal.show, .modal.active, dialog[open]';

  /** CSS selectors for disabled interactive elements */
  const DISABLED_SELECTORS = 'button[disabled], input[type="submit"][disabled], [role="button"][aria-disabled="true"]';

  /** Maximum number of recent actions to check for repetition penalty */
  const REPETITION_WINDOW = 5;

  /** Intent drift threshold — progress below this for N steps = drift */
  const DRIFT_THRESHOLD = 0.15;

  /** Number of consecutive low-progress steps to trigger drift flag */
  const DRIFT_STEPS = 3;

  // ═══════════════════════════════════════════════════════════════
  //  TOKENIZER — Must produce identical output to task-state.js
  // ═══════════════════════════════════════════════════════════════

  /**
   * Tokenize text into lowercase content words.
   * Splits on whitespace/punctuation, removes stopwords, filters short tokens.
   *
   * This MUST produce identical output to TaskStateTracker._tokenize() in
   * task-state.js. Any divergence corrupts keyword overlap and info gain rate.
   *
   * @param {string} text - Raw text to tokenize
   * @returns {string[]} Array of lowercase content tokens
   */
  function _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t));
  }

  // ═══════════════════════════════════════════════════════════════
  //  HASH FUNCTION — Fast, non-cryptographic change detection
  // ═══════════════════════════════════════════════════════════════

  /**
   * DJB2 hash — fast, well-distributed, sufficient for change detection.
   * We don't need cryptographic strength, just reliable change detection.
   *
   * @param {string} str - String to hash
   * @returns {number} 32-bit hash value
   */
  function _djb2(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash) + str.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash >>> 0; // Ensure unsigned
  }

  // ═══════════════════════════════════════════════════════════════
  //  JACCARD SIMILARITY — Set overlap metric for goal shift detection
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute Jaccard similarity between two token arrays.
   * J(A,B) = |A ∩ B| / |A ∪ B|
   *
   * @param {string[]} tokensA
   * @param {string[]} tokensB
   * @returns {number} 0.0–1.0 similarity
   */
  function _jaccard(tokensA, tokensB) {
    if (tokensA.length === 0 && tokensB.length === 0) return 1.0;
    if (tokensA.length === 0 || tokensB.length === 0) return 0.0;

    const setA = new Set(tokensA);
    const setB = new Set(tokensB);

    let intersection = 0;
    for (const t of setA) {
      if (setB.has(t)) intersection++;
    }

    const union = new Set([...setA, ...setB]).size;
    return intersection / union;
  }

  // ═══════════════════════════════════════════════════════════════
  //  GOAL SHIFT DETECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Check if a new prompt represents a goal shift (new task) or is just
   * an instruction within the current task.
   *
   * Uses a two-gate system:
   *   Gate 1 — First-word gate: If the prompt starts with a UI command verb
   *            (click, type, scroll, etc.), it's ALWAYS an instruction.
   *   Gate 2 — Content gate: If remaining tokens have ≥3 length OR contain
   *            a strong content word, run Jaccard similarity check.
   *
   * @param {string} prompt - The new prompt text
   * @param {string[]} existingGoalTokens - Tokens from the current goal
   * @returns {boolean} True if this is a goal shift (should reset task)
   */
  function _isGoalShift(prompt, existingGoalTokens) {
    // Gate 1: UI command verb first-word gate
    const firstWord = prompt.trim().split(/\s+/)[0].toLowerCase();
    if (UI_COMMAND_VERBS.has(firstWord)) {
      return false; // UI commands are always instructions
    }

    // Tokenize the prompt (removes stopwords)
    const promptTokens = _tokenize(prompt);

    // Gate 2: Does the prompt have enough content to judge?
    const hasEnoughTokens = promptTokens.length >= 3;
    const hasStrongContent = promptTokens.some(t => !WEAK_WORDS.has(t));

    if (!hasEnoughTokens && !hasStrongContent) {
      return false; // Too vague to be a new goal
    }

    // Gate 3: Jaccard similarity — low overlap = different goal
    const similarity = _jaccard(promptTokens, existingGoalTokens);
    return similarity < GOAL_SHIFT_JACCARD_THRESHOLD;
  }

  // ═══════════════════════════════════════════════════════════════
  //  TASK LIFECYCLE — Lazy init with controlled persistence
  // ═══════════════════════════════════════════════════════════════

  /**
   * Ensure a task is active in the service worker. Handles three cases:
   *   1. No task exists → initialize with prompt as goal
   *   2. Task exists, prompt is an instruction → update current instruction
   *   3. Task exists, prompt is a goal shift → reset and initialize new task
   *
   * Returns goalTokens for downstream use (no re-fetch needed).
   *
   * @param {string} prompt - Current prompt text
   * @returns {Promise<{goalTokens: string[], taskState: Object, isNew: boolean}>}
   */
  async function ensureTaskActive(prompt) {
    // Check current task state
    const currentState = await _sendMessage({
      type: 'BRAIN_TASK_GET'
    });

    const isActive = currentState?.isActive;
    const existingGoalTokens = currentState?.state?.goalTokens || [];

    // Case 1: No active task → initialize
    if (!isActive) {
      const initResult = await _sendMessage({
        type: 'BRAIN_TASK_INIT',
        goal: prompt,
        startUrl: window.location.href
      });

      console.log(`[ProgressEstimator] Task initialized — goal: "${prompt}"`);

      // Parse goal for completion evaluation (Phase 1B.2)
      const goalTokens = initResult?.state?.goalTokens || _tokenize(prompt);
      if (typeof BrowserAgent.GoalParser !== 'undefined') {
        const parsedGoal = BrowserAgent.GoalParser.parse(prompt);
        await _sendMessage({
          type: 'BRAIN_TASK_SET_PARSED_GOAL',
          parsedGoal: parsedGoal
        });
        console.log(`[ProgressEstimator] Goal parsed: ${parsedGoal.verb} → "${parsedGoal.target}"`);
      }

      return {
        goalTokens,
        taskState: initResult?.state || null,
        isNew: true
      };
    }

    // Case 2 or 3: Task exists — check for goal shift
    if (_isGoalShift(prompt, existingGoalTokens)) {
      // Goal shift detected — reset and re-initialize
      await _sendMessage({ type: 'BRAIN_TASK_RESET' });

      const initResult = await _sendMessage({
        type: 'BRAIN_TASK_INIT',
        goal: prompt,
        startUrl: window.location.href
      });

      console.log(`[ProgressEstimator] Goal shift detected — new goal: "${prompt}"`);

      // Parse goal for completion evaluation (Phase 1B.2)
      const goalTokens = initResult?.state?.goalTokens || _tokenize(prompt);
      if (typeof BrowserAgent.GoalParser !== 'undefined') {
        const parsedGoal = BrowserAgent.GoalParser.parse(prompt);
        await _sendMessage({
          type: 'BRAIN_TASK_SET_PARSED_GOAL',
          parsedGoal: parsedGoal
        });
        console.log(`[ProgressEstimator] Goal parsed (shift): ${parsedGoal.verb} → "${parsedGoal.target}"`);
      }

      return {
        goalTokens,
        taskState: initResult?.state || null,
        isNew: true
      };
    }

    // Case 3: Same task, new instruction
    await _sendMessage({
      type: 'BRAIN_TASK_UPDATE_INSTRUCTION',
      instruction: prompt
    });

    return {
      goalTokens: existingGoalTokens,
      taskState: currentState?.state || null,
      isNew: false
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PRE-ACTION SNAPSHOT — DOM baseline before action modifies it
  // ═══════════════════════════════════════════════════════════════

  /**
   * Capture a pre-action snapshot of the DOM state.
   * Called BEFORE the action handler executes.
   *
   * This snapshot is compared against the post-action DOM in evaluate()
   * to determine what effect the action had.
   *
   * @returns {Object} Serializable DOM snapshot
   */
  function captureSnapshot() {
    const snapshot = {
      url: window.location.href,
      title: document.title || '',
      timestamp: Date.now()
    };

    try {
      // Text length — catches content additions/removals
      // Scoped to main content area (consistent with _getPageText and _computeVisibleTextHash)
      // to avoid expensive full-body innerText on large pages (~10-30ms on Amazon)
      const mainEl = document.querySelector('main, [role="main"], article') || document.body;
      const mainText = mainEl ? mainEl.innerText || '' : '';
      snapshot.textLength = mainText.length;

      // Visible text hash — catches content SWAPS (same length, different content)
      // Uses bounded semantic fingerprint: title + headings + first 3K of main content
      snapshot.visibleTextHash = _computeVisibleTextHash();

      // Disabled interactive elements — catches enablement changes
      snapshot.disabledButtonCount = _countDisabledElements();

      // Modal/dialog elements — catches modal open/close
      snapshot.modalCount = _countModals();

      // ARIA state of elements near the action target — catches dropdowns, tabs, accordions
      // (captured generically; specific element tracking happens in evaluate)
      snapshot.ariaStates = _captureAriaStates();

    } catch (e) {
      console.warn('[ProgressEstimator] Snapshot capture partial failure:', e.message);
      // Defaults for failed captures
      snapshot.textLength = snapshot.textLength || 0;
      snapshot.visibleTextHash = snapshot.visibleTextHash || 0;
      snapshot.disabledButtonCount = snapshot.disabledButtonCount || 0;
      snapshot.modalCount = snapshot.modalCount || 0;
      snapshot.ariaStates = snapshot.ariaStates || {};
    }

    return snapshot;
  }

  /**
   * Compute a bounded visible text hash for change detection.
   * Uses: title + h1-h3 headings + first 3000 chars of main content.
   * Cost: ~1-2ms even on heavy pages.
   *
   * @returns {number} DJB2 hash of semantic fingerprint
   */
  function _computeVisibleTextHash() {
    try {
      const title = document.title || '';
      const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
        .map(h => (h.textContent || '').trim())
        .join('|');
      const mainEl = document.querySelector('main, [role="main"], article') || document.body;
      const mainContent = mainEl ? (mainEl.innerText || '').slice(0, 3000) : '';
      return _djb2(title + '|' + headings + '|' + mainContent);
    } catch (e) {
      return 0;
    }
  }

  /**
   * Count currently disabled interactive elements.
   * @returns {number}
   */
  function _countDisabledElements() {
    try {
      return document.querySelectorAll(DISABLED_SELECTORS).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Count currently visible modal/dialog elements.
   * @returns {number}
   */
  function _countModals() {
    try {
      const modals = document.querySelectorAll(MODAL_SELECTORS);
      let visibleCount = 0;
      for (const el of modals) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          visibleCount++;
        }
      }
      return visibleCount;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Capture aria-expanded/selected/checked states on interactive elements
   * in the viewport. Used for detecting state_change effects.
   *
   * Returns a map of selector → state for elements that have these attributes.
   * We only track up to 50 elements to bound cost.
   *
   * @returns {Object} Map of element identifiers to their ARIA states
   */
  function _captureAriaStates() {
    const states = {};
    try {
      const tracked = document.querySelectorAll(
        '[aria-expanded], [aria-selected], [aria-checked]'
      );
      let count = 0;
      for (const el of tracked) {
        if (count >= 50) break;
        const key = _elementKey(el);
        if (!key) continue;

        states[key] = {
          expanded: el.getAttribute('aria-expanded'),
          selected: el.getAttribute('aria-selected'),
          checked: el.getAttribute('aria-checked')
        };
        count++;
      }
    } catch (e) {
      // DOM access failure during navigation — return empty
    }
    return states;
  }

  /**
   * Generate a stable identifying key for a DOM element.
   * Uses: tag + id or tag + text + position bucket.
   *
   * @param {Element} el
   * @returns {string|null}
   */
  function _elementKey(el) {
    try {
      const tag = el.tagName.toLowerCase();
      if (el.id) return `${tag}#${el.id}`;
      const text = (el.textContent || '').trim().slice(0, 20);
      const rect = el.getBoundingClientRect();
      const bx = Math.round(rect.x / 100);
      const by = Math.round(rect.y / 100);
      return `${tag}|${text}|${bx},${by}`;
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  EFFECT DETECTION — Diff pre/post snapshots
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detect the effect of an action by comparing pre-action and post-action
   * DOM state. Returns a single effect type string.
   *
   * Detection priority (first match wins):
   *   1. URL changed              → 'navigation'
   *   2. Modal count increased    → 'modal_open'
   *   3. Modal count decreased    → 'modal_close'
   *   4. Disabled count decreased → 'enable_element'
   *   5. Disabled count increased → 'disable_element'
   *   6. Text grew >20% or hash  → 'content_load'
   *   7. ARIA states changed      → 'state_change'
   *   8. Nothing detected         → 'none'
   *
   * @param {Object} before - Pre-action snapshot from captureSnapshot()
   * @param {Object} actionContext - Info about the action (for targeted checks)
   * @returns {string} Effect type
   */
  function _detectEffect(before, actionContext) {
    try {
      const currentUrl = window.location.href;
      const currentTitle = document.title || '';

      // 1. Navigation — URL changed (most significant effect)
      if (currentUrl !== before.url) {
        return 'navigation';
      }

      // 2/3. Modal open/close — modal count changed
      const currentModals = _countModals();
      if (currentModals > before.modalCount) {
        return 'modal_open';
      }
      if (currentModals < before.modalCount) {
        return 'modal_close';
      }

      // 4/5. Enable/disable — disabled element count changed
      const currentDisabled = _countDisabledElements();
      if (currentDisabled < before.disabledButtonCount) {
        return 'enable_element';
      }
      if (currentDisabled > before.disabledButtonCount) {
        return 'disable_element';
      }

      // 6. Content load — significant text growth or content swap
      // Scoped to main content area (consistent with captureSnapshot)
      const currentMainEl = document.querySelector('main, [role="main"], article') || document.body;
      const currentMainText = currentMainEl ? currentMainEl.innerText || '' : '';
      const currentTextLength = currentMainText.length;
      const lengthDiff = currentTextLength - before.textLength;
      const lengthGrowth = before.textLength > 0
        ? lengthDiff / before.textLength
        : (currentTextLength > 100 ? 1.0 : 0);

      if (lengthGrowth > 0.2) {
        return 'content_load';
      }

      // Content swap detection (same length, different content)
      // Requires ≥100 chars absolute difference to filter out tiny noise
      // (timestamp ticking, counter incrementing) while still catching
      // real SPA content swaps (tab switches with same-length content)
      const currentHash = _computeVisibleTextHash();
      if (currentHash !== before.visibleTextHash &&
          before.visibleTextHash !== 0 &&
          Math.abs(lengthDiff) > 100) {
        return 'content_load';
      }

      // 7. State change — ARIA states changed
      // PRIORITY: Check the interacted element first (precise), then fall back
      // to broad diff (may have false positives from unrelated page elements).
      // We capture broadly but compare narrowly when possible.

      // 7a. Targeted check: did the interacted element's ARIA state change?
      if (actionContext && actionContext.element) {
        try {
          const el = actionContext.element;
          if (el.getAttribute) {
            const elKey = _elementKey(el);
            const prevState = elKey ? before.ariaStates[elKey] : null;

            // Case 1: Element had ARIA state before → check if changed
            if (prevState) {
              const currExpanded = el.getAttribute('aria-expanded');
              const currSelected = el.getAttribute('aria-selected');
              const currChecked = el.getAttribute('aria-checked');
              if (prevState.expanded !== currExpanded ||
                  prevState.selected !== currSelected ||
                  prevState.checked !== currChecked) {
                return 'state_change';
              }
            }
            // Case 2: Element gained ARIA state after action (wasn't tracked before)
            else if (
              el.getAttribute('aria-expanded') !== null ||
              el.getAttribute('aria-selected') !== null ||
              el.getAttribute('aria-checked') !== null
            ) {
              return 'state_change';
            }
          }
        } catch (e) {
          // Element may be detached after navigation
        }
      } else {
        // 7b. Fallback: broad diff across all tracked ARIA elements
        // Only used when we don't have a reference to the interacted element
        const currentAria = _captureAriaStates();
        for (const key of Object.keys(before.ariaStates)) {
          const prev = before.ariaStates[key];
          const curr = currentAria[key];
          if (!curr) continue;

          if (prev.expanded !== curr.expanded ||
              prev.selected !== curr.selected ||
              prev.checked !== curr.checked) {
            return 'state_change';
          }
        }
      }

      // 8. Nothing detected
      return 'none';

    } catch (e) {
      console.warn('[ProgressEstimator] Effect detection error:', e.message);
      return 'none';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  PROGRESS COMPUTATION — 4-Signal Composite
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute the base progress score from 4 complementary signals.
   *
   * Formula:
   *   baseProgress = 0.4 * keywordOverlap
   *                + 0.2 * urlMatch
   *                + 0.2 * interactionDepth
   *                + 0.2 * stateChangeScore
   *
   * @param {string[]} goalTokens - Tokenized goal text
   * @param {Object} taskState - Current task state snapshot
   * @param {string} effect - Detected effect type from _detectEffect()
   * @returns {Object} { baseProgress, signals }
   */
  function _computeBaseProgress(goalTokens, taskState, effect) {
    // Signal 1: Keyword overlap (0.4 weight)
    // How many goal tokens appear in the current page content?
    let keywordOverlap = 0;
    if (goalTokens.length > 0) {
      const pageText = _getPageText().toLowerCase();
      let matches = 0;
      for (const token of goalTokens) {
        if (pageText.includes(token)) matches++;
      }
      keywordOverlap = matches / goalTokens.length;
    }

    // Signal 2: URL match (0.2 weight)
    // How many goal tokens appear in the current URL?
    let urlMatch = 0;
    if (goalTokens.length > 0) {
      const urlLower = window.location.href.toLowerCase();
      let urlMatches = 0;
      for (const token of goalTokens) {
        if (urlLower.includes(token)) urlMatches++;
      }
      urlMatch = urlMatches / goalTokens.length;
    }

    // Signal 3: Interaction depth (0.2 weight)
    // Logarithmic — diminishing returns as the task progresses
    const stepIndex = taskState?.step_index || 0;
    const interactionDepth = Math.min(
      Math.log(stepIndex + 1) / Math.log(30),
      1.0
    );

    // Signal 4: State change score (0.2 weight)
    // Quality of the observed DOM effect
    const stateChangeScore = EFFECT_QUALITY[effect] || 0;

    // Composite
    const baseProgress = 0.4 * keywordOverlap
                       + 0.2 * urlMatch
                       + 0.2 * interactionDepth
                       + 0.2 * stateChangeScore;

    return {
      baseProgress,
      signals: {
        keywordOverlap,
        urlMatch,
        interactionDepth,
        stateChangeScore
      }
    };
  }

  /**
   * Extract page text for keyword overlap.
   * Uses main content area to avoid matching against nav/footer boilerplate.
   * Bounded to 10K chars for performance.
   *
   * @returns {string} Page text content
   */
  function _getPageText() {
    try {
      const mainEl = document.querySelector('main, [role="main"], article') || document.body;
      return (mainEl.innerText || '').slice(0, 10000);
    } catch (e) {
      return '';
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  REPETITION PENALTY
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute a repetition penalty based on how many of the last N actions
   * were the same type. Aimless clicking/scrolling produces zero progress.
   *
   * Penalty = 0.3 * (repeatedCount / min(totalActions, REPETITION_WINDOW))
   *
   * A "repeated" action is one where both type AND target text match.
   *
   * @param {Object} taskState - Current task state snapshot
   * @param {Object} actionContext - Current action (type + target text)
   * @returns {number} Penalty value (0.0–0.3)
   */
  function _computeRepetitionPenalty(taskState, actionContext) {
    if (!taskState || !taskState.actions_taken || taskState.actions_taken.length === 0) {
      return 0;
    }

    // Don't penalize early exploration — the first few actions are
    // natural orientation (finding the search box, clicking around).
    // Penalizing repetition at step 1-2 is a false alarm.
    if (taskState.actions_taken.length < 3) {
      return 0;
    }

    const recentActions = taskState.actions_taken.slice(-REPETITION_WINDOW);
    const currentType = actionContext?.type || '';
    const currentText = (actionContext?.text || '').toLowerCase().slice(0, 30);

    let repeatedCount = 0;
    for (const action of recentActions) {
      const isSameType = action.type === currentType;
      const isSameTarget = currentText &&
        (action.text || '').toLowerCase().slice(0, 30) === currentText;

      // Exact repeat: same type AND same target
      if (isSameType && isSameTarget) {
        repeatedCount++;
      }
      // Type-only repeat: same type, different target (milder penalty)
      else if (isSameType) {
        repeatedCount += 0.5;
      }
    }

    const windowSize = Math.min(recentActions.length, REPETITION_WINDOW);
    return 0.3 * (repeatedCount / Math.max(windowSize, 1));
  }

  // ═══════════════════════════════════════════════════════════════
  //  MICRO-SUCCESS BONUSES
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute micro-success bonuses for form-level progress signals.
   * These bonuses stabilize early learning in form-heavy tasks where
   * the 4-signal composite alone would undervalue partial progress.
   *
   * Bonuses:
   *   - Input field filled (was empty → now has value): +0.10
   *   - Button became enabled (was disabled → now enabled): +0.20
   *   - Checkbox/radio changed state: +0.05
   *
   * @param {Object} before - Pre-action snapshot
   * @param {Object} actionContext - What was the action?
   * @returns {number} Total bonus (0.0–0.35)
   */
  function _computeMicroSuccess(before, actionContext) {
    let bonus = 0;
    const actionType = actionContext?.type || '';

    try {
      // Input filled — the action was a 'type' into an input
      if (actionType === 'type' || actionType === 'search') {
        const target = actionContext?.element;
        if (target) {
          const val = target.value || target.textContent || '';
          if (val.trim().length > 0) {
            bonus += 0.10;
          }
        }
      }

      // Button enablement — check if any previously disabled button is now enabled
      const currentDisabled = _countDisabledElements();
      if (currentDisabled < before.disabledButtonCount) {
        bonus += 0.20;
      }

      // Checkbox/radio state change — check near the action target
      if (actionType === 'click' && actionContext?.element) {
        try {
          const el = actionContext.element;
          const inputType = (el.type || '').toLowerCase();
          if (inputType === 'checkbox' || inputType === 'radio') {
            bonus += 0.05;
          }
        } catch (e) {
          // Element may be detached
        }
      }

    } catch (e) {
      console.warn('[ProgressEstimator] Micro-success detection error:', e.message);
    }

    return Math.min(bonus, 0.35); // Cap total bonus
  }

  // ═══════════════════════════════════════════════════════════════
  //  INTENT DRIFT DETECTION
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detect intent drift — the agent is not making meaningful progress
   * toward the goal. Flagged when progress < DRIFT_THRESHOLD for
   * DRIFT_STEPS consecutive steps.
   *
   * @param {Object} taskState - Current task state with progressHistory
   * @returns {Object} { drifting: boolean, stepsStuck: number }
   */
  function _detectIntentDrift(taskState) {
    if (!taskState || !taskState.progressHistory) {
      return { drifting: false, stepsStuck: 0 };
    }

    const history = taskState.progressHistory;
    if (history.length < DRIFT_STEPS) {
      return { drifting: false, stepsStuck: 0 };
    }

    // Don't flag drift during early steps — progress is naturally low
    // at task start (depth signal ≈ 0, agent still orienting, keyword
    // overlap low before first navigation). Wait until the agent has
    // had a real chance to make progress.
    const stepIndex = taskState.step_index || 0;
    if (stepIndex < DRIFT_STEPS + 1) {
      return { drifting: false, stepsStuck: 0 };
    }

    // Check last DRIFT_STEPS entries
    const recent = history.slice(-DRIFT_STEPS);
    const allBelowThreshold = recent.every(p => p < DRIFT_THRESHOLD);

    if (allBelowThreshold) {
      // Count how many consecutive steps have been below threshold
      let stepsStuck = 0;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] < DRIFT_THRESHOLD) stepsStuck++;
        else break;
      }
      return { drifting: true, stepsStuck };
    }

    return { drifting: false, stepsStuck: 0 };
  }

  // ═══════════════════════════════════════════════════════════════
  //  MAIN EVALUATION — Orchestrator
  // ═══════════════════════════════════════════════════════════════

  /**
   * Evaluate the outcome of an action. This is the main entry point called
   * by BrainExecutor AFTER the StabilityWatcher resolves.
   *
   * Pipeline:
   *   1. Detect effect (diff before/after snapshots)
   *   2. Compute 4-signal base progress
   *   3. Compute repetition penalty
   *   4. Compute micro-success bonuses
   *   5. Send batched state update to service worker (atomic IPC)
   *   6. Detect intent drift
   *   7. Record to diagnostics
   *
   * @param {Object} snapshot - Pre-action snapshot from captureSnapshot()
   * @param {Object} actionContext - Action details { type, target, text, element }
   * @param {Object} stabilityResult - Result from StabilityWatcher
   * @param {string[]} goalTokens - Goal tokens (from ensureTaskActive, not re-fetched)
   * @returns {Promise<ProgressResult>} Rich progress evaluation result
   */
  async function evaluate(snapshot, actionContext, stabilityResult, goalTokens) {
    const evalStart = Date.now();

    try {
      // 1. Detect effect
      const effect = _detectEffect(snapshot, actionContext);

      // 2. Base progress (4-signal composite)
      // We need the task state for depth calculation — fetch from batch response
      const preTaskState = await _sendMessage({ type: 'BRAIN_TASK_GET' });
      const taskState = preTaskState?.state || {};

      const { baseProgress, signals } = _computeBaseProgress(goalTokens, taskState, effect);

      // 3. Repetition penalty
      const repetitionPenalty = _computeRepetitionPenalty(taskState, actionContext);

      // 4. Micro-success bonuses
      const microSuccessBonus = _computeMicroSuccess(snapshot, actionContext);

      // 5. Tokenize current page content for info gain computation
      const pageTokens = _tokenize(_getPageText());

      // 6. Atomic batch IPC — record action + update tokens + update progress
      //    Sends all data in one message, gets back unified result
      const batchResult = await _sendMessage({
        type: 'BRAIN_RECORD_STEP_COMPLETE',
        action: {
          type: actionContext?.type || 'unknown',
          tag: actionContext?.tag || '',
          role: actionContext?.role || '',
          text: (actionContext?.text || '').slice(0, 50),
          boundingBox: actionContext?.boundingBox || null
        },
        effect: effect,
        currentUrl: window.location.href,
        pageTokens: pageTokens.slice(0, 200), // Cap to avoid huge messages
        // Progress will be computed after we get the info gain rate back
        progressPlaceholder: true
      });

      // 7. Extract info gain rate from batch response
      const infoGainRate = batchResult?.gainResult?.gainRate || 0;

      // 8. Compute final progress
      const progress = Math.max(0, Math.min(1,
        baseProgress * 0.7
        + infoGainRate * 0.3
        - repetitionPenalty
        + microSuccessBonus
      ));

      // 9. Update progress in the service worker (part of the step result)
      const progressUpdate = await _sendMessage({
        type: 'BRAIN_TASK_UPDATE_PROGRESS',
        progress: progress,
        currentUrl: window.location.href
      });

      // 10. Detect intent drift (uses updated progress history)
      const updatedState = await _sendMessage({ type: 'BRAIN_TASK_GET' });
      const intentDrift = _detectIntentDrift(updatedState?.state);

      // Build result
      const result = {
        progress,
        progressDelta: progressUpdate?.progress_delta || 0,
        effect,
        baseProgress,
        infoGainRate,
        repetitionPenalty,
        microSuccessBonus,
        intentDrift,
        highWaterMark: progressUpdate?.highWaterMark || { progress: 0, url: null },
        signals,
        stabilityStatus: stabilityResult?.status || 'unknown',
        evalTimeMs: Date.now() - evalStart
      };

      // 11. Record to diagnostics
      if (BrowserAgent.Diagnostics) {
        BrowserAgent.Diagnostics.record('progress', result);
      }

      console.log(
        `[ProgressEstimator] ✓ Progress: ${progress.toFixed(3)}`,
        `(Δ${result.progressDelta >= 0 ? '+' : ''}${result.progressDelta.toFixed(3)})`,
        `| Effect: ${effect}`,
        `| Base: ${baseProgress.toFixed(3)}`,
        `| Gain: ${infoGainRate.toFixed(3)}`,
        `| Rep: -${repetitionPenalty.toFixed(3)}`,
        `| Micro: +${microSuccessBonus.toFixed(3)}`,
        `| Drift: ${intentDrift.drifting ? '⚠ YES (' + intentDrift.stepsStuck + ' steps)' : 'no'}`
      );

      return result;

    } catch (e) {
      console.error('[ProgressEstimator] Evaluation failed:', e.message);

      // Graceful degradation — return a neutral result
      const fallback = {
        progress: 0,
        progressDelta: 0,
        effect: 'none',
        baseProgress: 0,
        infoGainRate: 0,
        repetitionPenalty: 0,
        microSuccessBonus: 0,
        intentDrift: { drifting: false, stepsStuck: 0 },
        highWaterMark: { progress: 0, url: null },
        signals: { keywordOverlap: 0, urlMatch: 0, interactionDepth: 0, stateChangeScore: 0 },
        stabilityStatus: stabilityResult?.status || 'unknown',
        evalTimeMs: Date.now() - evalStart,
        error: e.message
      };

      if (BrowserAgent.Diagnostics) {
        BrowserAgent.Diagnostics.record('progress', { ...fallback, error: e.message });
      }

      return fallback;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  IPC HELPER — Chrome message passing
  // ═══════════════════════════════════════════════════════════════

  /**
   * Send a message to the background service worker and await the response.
   * Wraps chrome.runtime.sendMessage in a promise with error handling.
   *
   * @param {Object} message - Message to send
   * @returns {Promise<Object>} Response from service worker
   */
  function _sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ProgressEstimator] IPC error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (e) {
        console.warn('[ProgressEstimator] IPC exception:', e.message);
        resolve(null);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  RETROACTIVE NAVIGATION SCORING (Phase 1B.2.1)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Lightweight page evaluation for retroactive navigation scoring.
   * Called by content.js on init() when the Service Worker has an unscored
   * navigation action from a previous content script that died mid-navigation.
   *
   * Uses only 2 of the 4 base signals:
   *   - Keyword overlap (weight 0.6): How many goal tokens appear on this page?
   *   - URL relevance  (weight 0.4): How many goal tokens appear in the URL?
   *
   * Skips interaction depth (not meaningful for cross-page evaluation) and
   * state change score (no pre-action snapshot available for comparison).
   *
   * Does NOT call BRAIN_RECORD_STEP_COMPLETE — this is purely for scoring,
   * not for recording. The Dead Man's Switch already recorded the action.
   *
   * Performance: ~3-5ms (tokenize page text + check tokens, no IPC, no
   * stability wait).
   *
   * @param {string[]} goalTokens - Goal tokens from the Service Worker
   * @returns {{ progressScore: number, url: string, keywordOverlap: number, urlRelevance: number }}
   */
  function quickEvaluate(goalTokens) {
    if (!goalTokens || goalTokens.length === 0) {
      return { progressScore: 0, url: window.location.href, keywordOverlap: 0, urlRelevance: 0 };
    }

    // Signal 1: Keyword overlap (weight 0.6)
    // How many goal tokens appear in the current page content?
    const pageText = _getPageText().toLowerCase();
    let matches = 0;
    for (const token of goalTokens) {
      if (pageText.includes(token)) matches++;
    }
    const keywordOverlap = matches / goalTokens.length;

    // Signal 2: URL relevance (weight 0.4)
    // How many goal tokens appear in the current URL?
    const urlLower = window.location.href.toLowerCase();
    let urlMatches = 0;
    for (const token of goalTokens) {
      if (urlLower.includes(token)) urlMatches++;
    }
    const urlRelevance = urlMatches / goalTokens.length;

    // Weighted composite (heavier on content than URL)
    const progressScore = 0.6 * keywordOverlap + 0.4 * urlRelevance;

    console.log(`[ProgressEstimator] quickEvaluate: keyword=${keywordOverlap.toFixed(3)}, url=${urlRelevance.toFixed(3)}, score=${progressScore.toFixed(3)}`);

    return {
      progressScore,
      url: window.location.href,
      keywordOverlap,
      urlRelevance
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  PUBLIC API
  // ═══════════════════════════════════════════════════════════════

  return {
    // Main lifecycle
    ensureTaskActive,
    captureSnapshot,
    evaluate,
    quickEvaluate,

    // Exposed for testing
    _tokenize,
    _djb2,
    _jaccard,
    _isGoalShift,
    _detectEffect,
    _computeBaseProgress,
    _computeRepetitionPenalty,
    _computeMicroSuccess,
    _detectIntentDrift,
    _computeVisibleTextHash,
    _getPageText,
    _sendMessage,

    // Constants (for testing validation)
    UI_COMMAND_VERBS,
    WEAK_WORDS,
    STOPWORDS,
    EFFECT_QUALITY,
    GOAL_SHIFT_JACCARD_THRESHOLD,
    DRIFT_THRESHOLD,
    DRIFT_STEPS
  };
})();
