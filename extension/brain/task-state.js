/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Task State Tracker — The Agent's Working Memory
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Lives in: background/service-worker.js (via importScripts)
 * Purpose:  Maintains persistent cross-page state for a single task lifecycle.
 *           Content scripts query this asynchronously via chrome.runtime.sendMessage.
 * 
 * Architecture Decision (Resolved in Plan §18):
 *   "TaskStateTracker and LoopDetector live strictly in background/service-worker.js.
 *    Single Source of Truth; content scripts query asynchronously."
 * 
 * Why Service Worker?
 *   Content scripts are destroyed on every page navigation. The service worker
 *   persists across navigations, so it's the only place that can maintain
 *   cross-page state like "I'm on step 3 of a 5-step task."
 * 
 * Design Decisions (from Plan §2.1):
 *   - Uses abstract state (step_index, effects, milestones), NOT named steps
 *     ("searching", "checkout"). Named steps require a vocabulary the agent
 *     doesn't have on unknown sites.
 *   - Milestones are generic (search_performed, form_interaction, etc.),
 *     NOT domain-specific (product_page, checkout_page).
 *   - Resets on new task, persists across page navigations within a task.
 * 
 * Ref: Implementation Plan v2.7 §2.1, §15 Phase 1A.1
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum actions before forced escalation to user (Plan §10, v2.3) */
const MAX_STEPS_PER_TASK = 30;

/** Score multiplier for nodes in the runtime failure memory (Plan §2.1) */
const FAILURE_PENALTY_MULTIPLIER = 0.3;

/** Default commitment window length in steps (Plan §2.1, v2.4) */
const DEFAULT_COMMITMENT_STEPS = 3;

/** Budget shaping threshold — after this step, escalation sensitivity increases (Plan §10, v2.4) */
const BUDGET_SHAPING_THRESHOLD = 20;

/** Maximum actions_taken entries to retain (prevents unbounded growth) */
const MAX_ACTION_HISTORY = 50;

/** Stopwords for goal tokenization — hoisted to module level for performance */
const TOKENIZER_STOPWORDS = new Set([
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

// ─── Node Signature Utility ──────────────────────────────────────────────────

/**
 * Compute a stable signature for a DOM node that survives across interactions
 * but uniquely identifies the "same" element.
 * Uses tag + truncated text + coarse position — NOT selector (which breaks on
 * dynamic IDs and framework re-renders).
 * 
 * @param {Object} node - Node descriptor from content script
 * @param {string} node.tag - HTML tag name (lowercase)
 * @param {string} [node.text] - Visible text content
 * @param {string} [node.role] - ARIA role
 * @param {Object} [node.boundingBox] - { x, y, width, height }
 * @returns {string} Stable signature string
 */
function computeNodeSignature(node) {
  const tag = node.tag || 'unknown';
  const text = (node.text || '').slice(0, 30).trim().toLowerCase();
  const role = node.role || '';
  // Coarse position bucket (100px grid) — stable across minor layout shifts
  const bx = node.boundingBox ? Math.round(node.boundingBox.x / 100) : -1;
  const by = node.boundingBox ? Math.round(node.boundingBox.y / 100) : -1;
  return `${tag}|${role}|${text}|${bx},${by}`;
}

// ─── TaskStateTracker Class ──────────────────────────────────────────────────

class TaskStateTracker {
  constructor() {
    /** @type {TaskState|null} Current active task state */
    this._state = null;

    /** @type {number} Monotonically increasing task ID for disambiguation */
    this._taskIdCounter = 0;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize a new task. Clears all prior state.
   * Called when the agent receives a new goal from the user/bridge.
   * 
   * @param {string} goal - The user's goal text (e.g., "search for macbook m3")
   * @param {string} [startUrl] - The URL where the task begins
   * @returns {TaskState} The fresh task state
   */
  initTask(goal, startUrl = '') {
    this._taskIdCounter++;

    this._state = {
      // ── Identity ──
      taskId: this._taskIdCounter,
      goal: goal,
      goalTokens: this._tokenize(goal),
      startedAt: Date.now(),

      // ── Core tracking (Plan §2.1) ──
      step_index: 0,
      actions_taken: [],          // { type, tag, role, text, nodeSignature, timestamp }
      effects_observed: [],       // effect type strings
      nodes_visited: new Set(),   // Set<nodeSignature>
      pages_visited: [],          // URL strings (deduplicated on push)
      last_effect: null,
      progress_score: 0,

      // ── Generic milestones (Plan §2.1, v2.3) ──
      milestones: {
        search_performed: false,      // input filled + form submitted OR search URL detected
        form_interaction: false,      // agent typed into any input/textarea/select
        navigation_occurred: false,   // URL changed (different path, not just hash)
        state_change_observed: false  // modal/dropdown/tab changed DOM state
      },

      // ── Commitment window (Plan §2.1, v2.4) ──
      commitment: {
        active: false,
        target_type: null,            // "form_submission" | "navigation" | "search" | null
        steps_remaining: 0            // while > 0, bias toward completing the subtask
      },

      // ── Runtime failure memory (Plan §2.1, v2.4) ──
      // Set<nodeSignature> — elements that produced zero/negative effects
      recentFailures: new Set(),

      // ── Progress tracking (Plan §2.1, v2.4) ──
      highWaterMark: {
        progress: 0,
        url: null                     // URL where peak progress was recorded
      },
      progressHistory: [],            // last N progress scores for drift detection

      // ── Information gain tracking (Plan §2.4, v2.5) ──
      seenGoalTokens: new Set(),      // goal tokens encountered so far (across all pages)

      // ── Recent node signatures for loop recovery (Plan §2.3, v2.5) ──
      recentNodeSignatures: [],       // last N node signatures for loop enforcement

      // ── Current instruction (Plan §2.4, v2.8 — Phase 1A.3b) ──
      // Distinct from goal: goal is the long-lived objective ("search for airpods"),
      // instruction is the current step ("click AirPods Pro").
      currentInstruction: null,
      currentInstructionTokens: [],

      // ── Budget ──
      maxStepsPerTask: MAX_STEPS_PER_TASK
    };

    // Record start URL
    if (startUrl) {
      this._state.pages_visited.push(startUrl);
    }

    console.log(`[TaskState] ✓ New task #${this._state.taskId}: "${goal}"`);
    return this.getSnapshot();
  }

  /**
   * Reset state — alias for starting fresh without a goal.
   * Used when a task completes or is abandoned.
   */
  resetTask() {
    const prevId = this._state?.taskId || 0;
    this._state = null;
    console.log(`[TaskState] Task #${prevId} reset`);
  }

  // ─── Core State Updates ────────────────────────────────────────────────────

  /**
   * Record an action the agent just performed and its observed effect.
   * This is the primary state update method — called after every agent action.
   * 
   * @param {Object} action - What the agent did
   * @param {string} action.type - "click" | "type" | "scroll" | "navigate" | "keypress"
   * @param {string} [action.tag] - HTML tag of the target element
   * @param {string} [action.role] - ARIA role of the target element
   * @param {string} [action.text] - Visible text of the target element
   * @param {Object} [action.boundingBox] - { x, y, width, height }
   * @param {string} effect - Observed effect type from Plan §8.4:
   *   "navigation" | "modal_open" | "modal_close" | "state_change" |
   *   "form_validation" | "content_load" | "enable_element" |
   *   "disable_element" | "none"
   * @param {string} [currentUrl] - Current page URL after the action
   * @returns {Object} Updated state snapshot + computed deltas
   */
  recordAction(action, effect, currentUrl = '') {
    if (!this._state) {
      console.warn('[TaskState] recordAction called with no active task');
      return null;
    }

    const state = this._state;
    const nodeSignature = computeNodeSignature(action);

    // ── Step tracking ──
    state.step_index++;
    state.actions_taken.push({
      type: action.type,
      tag: action.tag || '',
      role: action.role || '',
      text: (action.text || '').slice(0, 50),
      nodeSignature: nodeSignature,
      timestamp: Date.now()
    });
    // Cap actions_taken to prevent unbounded growth
    if (state.actions_taken.length > MAX_ACTION_HISTORY) {
      state.actions_taken = state.actions_taken.slice(-MAX_ACTION_HISTORY);
    }

    // ── Effect tracking ──
    state.effects_observed.push(effect);
    state.last_effect = effect;

    // ── Node visit tracking ──
    state.nodes_visited.add(nodeSignature);
    state.recentNodeSignatures.push(nodeSignature);
    if (state.recentNodeSignatures.length > 20) {
      state.recentNodeSignatures.shift();
    }

    // ── Page tracking (deduplicated) ──
    if (currentUrl && (state.pages_visited.length === 0 ||
        state.pages_visited[state.pages_visited.length - 1] !== currentUrl)) {
      state.pages_visited.push(currentUrl);
    }

    // ── Milestone detection (Plan §2.1, v2.3) ──
    this._updateMilestones(action, effect, currentUrl);

    // ── Runtime failure memory (Plan §2.1, v2.4) ──
    if (effect === 'none') {
      state.recentFailures.add(nodeSignature);
    }

    // ── Commitment window tick (Plan §2.1, v2.4) ──
    if (state.commitment.active) {
      state.commitment.steps_remaining--;
      if (state.commitment.steps_remaining <= 0) {
        state.commitment.active = false;
        state.commitment.target_type = null;
        state.commitment.steps_remaining = 0;
        console.log('[TaskState] Commitment window expired');
      }
    }

    console.log(`[TaskState] Step ${state.step_index}: ${action.type} → ${effect} (${nodeSignature.slice(0, 40)})`);
    return this.getSnapshot();
  }

  // ─── Progress Tracking ─────────────────────────────────────────────────────

  /**
   * Update the progress score. Called by the Progress Estimator (Phase 1A.3).
   * Maintains the high-water mark and progress history for drift detection.
   * 
   * @param {number} newProgress - 0.0–1.0 progress score
   * @param {string} [currentUrl] - Current URL for high-water mark tracking
   * @returns {Object} { progress_delta, at_high_water_mark }
   */
  updateProgress(newProgress, currentUrl = '') {
    if (!this._state) return null;

    const state = this._state;
    const prevProgress = state.progress_score;
    const delta = newProgress - prevProgress;

    state.progress_score = newProgress;
    state.progressHistory.push(newProgress);

    // Keep history bounded
    if (state.progressHistory.length > 10) {
      state.progressHistory.shift();
    }

    // Update high-water mark (Plan §2.1, v2.4)
    if (newProgress > state.highWaterMark.progress) {
      state.highWaterMark.progress = newProgress;
      state.highWaterMark.url = currentUrl || state.highWaterMark.url;
    }

    console.log(`[TaskState] Progress: ${prevProgress.toFixed(3)} → ${newProgress.toFixed(3)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(3)})`);

    return {
      progress_delta: delta,
      progress_score: newProgress,
      at_high_water_mark: newProgress >= state.highWaterMark.progress,
      highWaterMark: { ...state.highWaterMark }
    };
  }

  // ─── Current Instruction (Phase 1A.3b) ─────────────────────────────────────

  /**
   * Update the current instruction without resetting the task.
   * Called by ProgressEstimator.ensureTaskActive() for each new prompt
   * that is NOT a goal shift.
   * 
   * Goal remains the same; only the instruction (current step) changes.
   * 
   * @param {string} instruction - The current prompt/instruction text
   */
  updateInstruction(instruction) {
    if (!this._state) return;

    this._state.currentInstruction = instruction;
    this._state.currentInstructionTokens = this._tokenize(instruction);
    console.log(`[TaskState] Instruction updated: "${instruction.slice(0, 60)}"`);
  }

  // ─── Commitment Window ─────────────────────────────────────────────────────

  /**
   * Enter a commitment window — biases agent toward completing a subtask.
   * Prevents dithering where the agent starts filling a form, gets distracted
   * by a high-scoring nav link, and abandons the form. (Plan §2.1, v2.4)
   * 
   * @param {string} targetType - "form_submission" | "navigation" | "search"
   * @param {number} [steps=DEFAULT_COMMITMENT_STEPS] - How many steps to commit
   */
  enterCommitment(targetType, steps = DEFAULT_COMMITMENT_STEPS) {
    if (!this._state) return;

    this._state.commitment = {
      active: true,
      target_type: targetType,
      steps_remaining: steps
    };
    console.log(`[TaskState] Commitment entered: ${targetType} for ${steps} steps`);
  }

  // ─── Failure Memory ────────────────────────────────────────────────────────

  /**
   * Manually record a node as a failure (for cases where the effect detection
   * categorizes something as a weak positive but the progress delta was negative).
   * 
   * @param {Object} node - Node descriptor
   */
  recordFailure(node) {
    if (!this._state) return;
    const sig = computeNodeSignature(node);
    this._state.recentFailures.add(sig);
    console.log(`[TaskState] Failure recorded: ${sig.slice(0, 40)}`);
  }

  /**
   * Check if a node is in the failure memory.
   * 
   * @param {Object} node - Node descriptor
   * @returns {boolean} True if the node previously produced zero/negative effects
   */
  isKnownFailure(node) {
    if (!this._state) return false;
    return this._state.recentFailures.has(computeNodeSignature(node));
  }

  /**
   * Get the failure penalty multiplier for a node.
   * Returns FAILURE_PENALTY_MULTIPLIER (0.3) for known failures, 1.0 otherwise.
   * 
   * @param {Object} node - Node descriptor
   * @returns {number} Score multiplier (0.3 or 1.0)
   */
  getFailurePenalty(node) {
    return this.isKnownFailure(node) ? FAILURE_PENALTY_MULTIPLIER : 1.0;
  }

  // ─── Query Methods ─────────────────────────────────────────────────────────

  /**
   * Get a serializable snapshot of the current task state.
   * This is what gets sent to content scripts via message response.
   * Sets are converted to arrays for JSON serialization.
   * 
   * @returns {Object|null} Serializable task state, or null if no active task
   */
  getSnapshot() {
    if (!this._state) return null;

    const s = this._state;
    return {
      taskId: s.taskId,
      goal: s.goal,
      goalTokens: s.goalTokens,
      startedAt: s.startedAt,
      step_index: s.step_index,
      actions_taken: s.actions_taken.map(a => ({...a})),
      effects_observed: [...s.effects_observed],
      nodes_visited: Array.from(s.nodes_visited),
      pages_visited: [...s.pages_visited],
      last_effect: s.last_effect,
      progress_score: s.progress_score,
      milestones: { ...s.milestones },
      commitment: { ...s.commitment },
      recentFailures: Array.from(s.recentFailures),
      highWaterMark: { ...s.highWaterMark },
      progressHistory: [...s.progressHistory],
      seenGoalTokens: Array.from(s.seenGoalTokens),
      recentNodeSignatures: [...s.recentNodeSignatures],
      currentInstruction: s.currentInstruction,
      currentInstructionTokens: [...s.currentInstructionTokens],
      maxStepsPerTask: s.maxStepsPerTask,

      // ── Derived / convenience fields ──
      isActive: true,
      elapsedMs: Date.now() - s.startedAt,
      budgetRemaining: s.maxStepsPerTask - s.step_index,
      budgetFraction: s.step_index / s.maxStepsPerTask,
      isBudgetCritical: s.step_index >= BUDGET_SHAPING_THRESHOLD,
      uniquePagesVisited: s.pages_visited.length,
      uniqueNodesVisited: s.nodes_visited.size,
      failureCount: s.recentFailures.size
    };
  }

  /**
   * Check if a task is currently active.
   * @returns {boolean}
   */
  isActive() {
    return this._state !== null;
  }

  /**
   * Get the goal tokens for the current task.
   * Used by content scripts for goal-alignment scoring.
   * @returns {string[]} Array of lowercase goal tokens
   */
  getGoalTokens() {
    return this._state?.goalTokens || [];
  }

  /**
   * Update the set of goal tokens that have been seen on pages so far.
   * Used by the Information Gain Rate calculator (Plan §2.4, v2.5).
   * 
   * @param {string[]} pageTokens - Tokens from the current page content
   * @returns {Object} { newMatches, gainRate }
   */
  updateSeenGoalTokens(pageTokens) {
    if (!this._state) return { newMatches: 0, gainRate: 0 };

    const goalTokens = this._state.goalTokens;
    const seen = this._state.seenGoalTokens;
    let newMatches = 0;

    for (const t of goalTokens) {
      if (pageTokens.includes(t) && !seen.has(t)) {
        seen.add(t);
        newMatches++;
      }
    }

    const gainRate = newMatches / Math.max(goalTokens.length, 1);
    return { newMatches, gainRate };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  /**
   * Update milestones based on an action and its effect.
   * Milestones are generic checkers detected from DOM/URL signals (Plan §2.1, v2.3).
   * @private
   */
  _updateMilestones(action, effect, currentUrl) {
    const ms = this._state.milestones;

    // form_interaction: agent typed into any input/textarea/select
    if (action.type === 'type' &&
        ['input', 'textarea', 'select'].includes(action.tag)) {
      ms.form_interaction = true;
    }

    // search_performed: input filled + form submitted, OR URL contains search params
    // Fixed: use path-segment/query-param matching to avoid false positives
    // (e.g., 'researchers' shouldn't match, but '/search' or '?q=' should)
    if (!ms.search_performed) {
      let hasSearchParams = false;
      if (currentUrl) {
        try {
          const parsed = new URL(currentUrl);
          hasSearchParams = 
            /\/search(\b|\/|$)/i.test(parsed.pathname) ||
            parsed.searchParams.has('q') ||
            parsed.searchParams.has('query') ||
            parsed.searchParams.has('search') ||
            parsed.searchParams.has('s') ||
            parsed.searchParams.has('keyword');
        } catch (e) {
          // Fallback for non-parseable URLs: check for query-param patterns
          hasSearchParams = /[?&](q|query|search|s|keyword)=/i.test(currentUrl);
        }
      }
      const justSubmittedForm = ms.form_interaction &&
        (effect === 'navigation' || effect === 'content_load');
      if (hasSearchParams || justSubmittedForm) {
        ms.search_performed = true;
      }
    }

    // navigation_occurred: URL changed (different path, not just hash)
    if (effect === 'navigation') {
      ms.navigation_occurred = true;
    }

    // state_change_observed: modal/dropdown/tab changed DOM state
    if (['modal_open', 'modal_close', 'state_change', 'enable_element'].includes(effect)) {
      ms.state_change_observed = true;
    }

    // Auto-enter commitment when starting form interaction (Plan §2.1, v2.4)
    if (action.type === 'type' && !this._state.commitment.active) {
      this.enterCommitment('form_submission');
    }
  }

  /**
   * Simple tokenizer for goal text.
   * Splits on whitespace/punctuation, lowercases, removes stopwords.
   * @private
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !TOKENIZER_STOPWORDS.has(t));
  }
}

// ─── Export Singleton ────────────────────────────────────────────────────────

// In Service Worker context (importScripts), this creates a global singleton.
// Content scripts never load this file directly — they query via message passing.
const taskStateTracker = new TaskStateTracker();
