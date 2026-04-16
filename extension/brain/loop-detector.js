/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Loop Detector — Behavioral Loop Detection & Tiered Recovery
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Lives in: background/service-worker.js (via importScripts)
 * Purpose:  Detects 4 types of behavioral loops and provides tiered recovery
 *           strategies. Without this, the agent can cycle endlessly on real
 *           websites: click product → back → click product → back.
 * 
 * Why This Is Non-Negotiable (Plan §17):
 *   "Loops kill everything: An agent that loops generates garbage data,
 *    wastes compute, and never completes tasks."
 * 
 * Detection Modes (Plan §2.3):
 *   Mode 1 — Exact:          Same state (URL::fingerprint) visited within last N steps
 *   Mode 2 — Alternating:    A→B→A→B oscillation (two-page ping-pong)
 *   Mode 3 — Action-pattern: Same *behavior* on different pages (browsing traps)
 *   Mode 4 — Monotone-type:  Clicking the same element type 5+ times in a row
 * 
 * Recovery Strategy (Plan §2.3, v2.5):
 *   Each loop type maps to a specific recovery action:
 *   - Exact         → backtrack (history.back)
 *   - Alternating   → force an unseen node
 *   - Action-pattern → change the TYPE of interaction
 *   - Monotone-type  → change the TYPE of interaction
 * 
 * DOM Fingerprint (Plan §2.3, v2.3):
 *   Layout-stable semantic hash — NOT selector-based. Hashes tag + role +
 *   text[:20] + coarse position bucket. Stable across DOM reordering, dynamic
 *   IDs, and minor layout shifts.
 * 
 * Ref: Implementation Plan v2.7 §2.3, §15 Phase 1A.1
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Constants ───────────────────────────────────────────────────────────────

/** Maximum state/action history entries to retain */
const LOOP_MAX_HISTORY = 20;

/** Minimum novelty threshold for enforcement constraints (Plan §2.3, v2.5) */
const MIN_NOVELTY_THRESHOLD = 0.5;

/** Number of recent actions to analyze for action-pattern detection */
const ACTION_PATTERN_WINDOW = 6;

/** Number of consecutive same-type actions that triggers monotone detection */
const MONOTONE_TYPE_THRESHOLD = 5;

/** Maximum cycle length for Mode 1 (Exact) to trigger.
 *  Revisiting a page from >4 steps ago is likely legitimate navigation,
 *  not a loop. Without this threshold, Mode 1 would always fire before
 *  Mode 2 (Alternating), making Mode 2 dead code. */
const EXACT_LOOP_MAX_CYCLE = 4;

// ─── Dependency Check ────────────────────────────────────────────────────────
// computeNodeSignature is defined in task-state.js, loaded first via importScripts.
// Verify it exists to catch load-order mistakes early.
if (typeof computeNodeSignature === 'undefined') {
  console.warn('[LoopDetector] ⚠ computeNodeSignature not found — task-state.js must be loaded first');
}

// ─── Fast Hash Utility ───────────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash for fast, non-cryptographic string fingerprinting.
 * Produces a hex string suitable for equality comparison.
 * 
 * @param {string} str - Input string to hash
 * @returns {string} 8-character hex hash
 */
function fastHash(str) {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0; // FNV prime, force unsigned 32-bit
  }
  return hash.toString(16).padStart(8, '0');
}

// ─── DOM Fingerprint ─────────────────────────────────────────────────────────

/**
 * Compute a layout-stable DOM fingerprint from a set of interactive nodes.
 * 
 * Design (Plan §2.3, v2.3):
 *   Raw selector hashes break on dynamic IDs, A/B tests, and React's DOM
 *   reordering. Instead, we hash semantic properties and sort to be 
 *   order-independent. Only changes when the actual set of interactive
 *   elements changes meaningfully.
 * 
 * @param {Object[]} nodes - Array of node descriptors from DOM Recon
 * @param {string} nodes[].tag - HTML tag name
 * @param {string} [nodes[].role] - ARIA role
 * @param {string} [nodes[].text] - Visible text content
 * @param {Object} [nodes[].boundingBox] - { x, y, width, height }
 * @returns {string} 8-char hex fingerprint
 */
function computeDomFingerprint(nodes) {
  if (!nodes || nodes.length === 0) return fastHash('empty');

  // Take top 20 nodes (enough to characterize a page, bounded for perf)
  const signatures = nodes.slice(0, 20).map(n => [
    n.tag || 'unknown',
    n.role || '',
    (n.text || '').slice(0, 20).trim().toLowerCase(),
    // Coarse position bucket (100px grid) — stable across minor layout shifts
    n.boundingBox ? Math.round(n.boundingBox.x / 100) : -1,
    n.boundingBox ? Math.round(n.boundingBox.y / 100) : -1
  ].join('|'));

  // Sort to be order-independent (React reordering won't change fingerprint)
  signatures.sort();

  return fastHash(signatures.join('::'));
}

// ─── LoopDetector Class ──────────────────────────────────────────────────────

class LoopDetector {
  constructor() {
    /** @type {string[]} History of state identifiers: "url::fingerprint" */
    this.stateHistory = [];

    /** @type {string[]} History of action signatures: "type_role" or "type_tag" */
    this.actionHistory = [];

    /** @type {number} Max entries before oldest are evicted */
    this.maxHistory = LOOP_MAX_HISTORY;

    /** @type {number} Total loops detected across the current task */
    this.loopsDetected = 0;

    /** @type {Object|null} Last loop detection result for status queries */
    this.lastResult = null;

    /** @type {number} Consecutive loop detections (for escalation) */
    this.consecutiveLoops = 0;
  }

  // ─── Core Detection ────────────────────────────────────────────────────────

  /**
   * Check for behavioral loops after the agent's latest action.
   * 
   * Called after every action with the resulting page state. Returns a loop
   * detection result that includes the loop type and cycle length. If a loop
   * is detected, the caller should use getRecoveryAction() to determine the
   * appropriate recovery strategy.
   * 
   * @param {string} url - Current page URL
   * @param {string} domFingerprint - Fingerprint from computeDomFingerprint()
   * @param {Object} action - The action that was just performed
   * @param {string} action.type - "click" | "type" | "scroll" | "navigate" | "keypress"
   * @param {string} [action.role] - ARIA role of the target element
   * @param {string} [action.tag] - HTML tag of the target element
   * @returns {LoopResult} Detection result
   * 
   * @typedef {Object} LoopResult
   * @property {boolean} loopDetected - Whether a loop was detected
   * @property {number} [cycleLength] - Number of steps in the loop cycle
   * @property {string} [type] - "exact" | "alternating" | "action_pattern" | "monotone_type"
   */
  check(url, domFingerprint, action) {
    const currentState = `${url}::${domFingerprint}`;
    const actionSig = `${action.type}_${action.role || action.tag || 'unknown'}`;

    // ── Mode 2 — Alternating Loop (checked FIRST) ──
    // A→B→A→B pattern (last 3 history states + current form a 2-cycle).
    // Catches: two-page ping-pong (e.g., search results ↔ product page).
    // Checked BEFORE exact because alternating is a more specific diagnosis
    // with a better recovery strategy (force unseen node vs. history.back).
    // If checked after exact, exact's lastIndexOf would always match first.
    if (this.stateHistory.length >= 3) {
      const h = this.stateHistory.slice(-3);
      // Pattern: h[0]=A, h[1]=B, h[2]=A, currentState=B
      if (h[0] === h[2] && h[1] === currentState) {
        const result = { loopDetected: true, cycleLength: 2, type: 'alternating' };
        this._recordDetection(result);
        this._pushState(currentState);
        this._pushAction(actionSig);
        return result;
      }
    }

    // ── Mode 1 — Exact Loop ──
    // Same URL + same DOM fingerprint visited within the last N steps.
    // Only triggers for SHORT cycles (≤ EXACT_LOOP_MAX_CYCLE steps).
    // Longer revisitations are legitimate navigation, not loops.
    const prevIndex = this.stateHistory.lastIndexOf(currentState);
    if (prevIndex !== -1) {
      const cycleLength = this.stateHistory.length - prevIndex;
      if (cycleLength <= EXACT_LOOP_MAX_CYCLE) {
        const result = { loopDetected: true, cycleLength, type: 'exact' };
        this._recordDetection(result);
        this._pushState(currentState);
        this._pushAction(actionSig);
        return result;
      }
      // cycleLength > threshold: fall through to other detection modes
    }

    // Push action BEFORE pattern checks (so the window includes this action)
    this._pushAction(actionSig);

    // ── Mode 3 — Action-Pattern Loop (v2.4) ──
    // Same *behavior pattern* on different pages. Catches semantic loops where
    // the agent visits different URLs but performs the same sequence of actions
    // (e.g., click_link → click_link → click_link on pagination).
    if (this.actionHistory.length >= ACTION_PATTERN_WINDOW) {
      const recent = this.actionHistory.slice(-ACTION_PATTERN_WINDOW);
      const halfLen = ACTION_PATTERN_WINDOW / 2; // 3
      const firstHalf = recent.slice(0, halfLen).join('|');
      const secondHalf = recent.slice(halfLen).join('|');

      if (firstHalf === secondHalf) {
        const result = { loopDetected: true, cycleLength: halfLen, type: 'action_pattern' };
        this._recordDetection(result);
        this._pushState(currentState);
        return result;
      }
    }

    // ── Mode 4 — Monotone Type ──
    // Clicking the exact same element type 5+ times in a row.
    // Catches: recommendation traps, infinite scroll clicking, list item spam.
    if (this.actionHistory.length >= MONOTONE_TYPE_THRESHOLD) {
      const lastTypes = this.actionHistory.slice(-MONOTONE_TYPE_THRESHOLD);
      if (lastTypes.every(t => t === lastTypes[0])) {
        const result = { loopDetected: true, cycleLength: MONOTONE_TYPE_THRESHOLD, type: 'monotone_type' };
        this._recordDetection(result);
        this._pushState(currentState);
        return result;
      }
    }

    // ── No loop detected ──
    this._pushState(currentState);
    this.consecutiveLoops = 0;
    this.lastResult = { loopDetected: false };
    return this.lastResult;
  }

  // ─── Tiered Recovery (Plan §2.3, v2.5) ─────────────────────────────────────

  /**
   * Get the appropriate recovery action for a detected loop.
   * 
   * Different loop types require different recovery strategies (Plan §2.3, v2.5):
   *   - Exact:          Go back — break the revisitation cycle
   *   - Alternating:    Force an unseen node — break the ping-pong
   *   - Action-pattern: Change the TYPE of interaction — break behavioral rut
   *   - Monotone-type:  Change the TYPE of interaction — try something different
   * 
   * @param {LoopResult} loopResult - The detection result from check()
   * @param {Object} [taskState] - Current task state snapshot (for constraint building)
   * @returns {RecoveryAction} Recovery instruction
   * 
   * @typedef {Object} RecoveryAction
   * @property {string} action - "backtrack" | "force_unseen_node" | "change_action_type"
   * @property {string} [method] - Specific method (e.g., "history.back()")
   * @property {Object} [constraints] - Enforcement constraints for the next action
   * @property {string[]} [constraints.forbid] - Node signatures to forbid
   * @property {string[]} [constraints.forbid_types] - Action types to forbid
   * @property {string[]} [constraints.prefer_types] - Action types to prefer
   * @property {boolean} [constraints.forbid_recent_nodes] - Forbid last 6 nodes
   * @property {boolean} [constraints.forbid_recent_action_types] - Forbid recent action types
   * @property {number} [constraints.min_novelty_threshold] - Min novelty score for candidates
   */
  getRecoveryAction(loopResult, taskState = null) {
    if (!loopResult || !loopResult.loopDetected) {
      return null;
    }

    const recentNodes = taskState?.recentNodeSignatures?.slice(-6) || [];
    const recentActionTypes = (taskState?.actions_taken || [])
      .slice(-3)
      .map(a => a.type);

    // Base enforcement constraints (Plan §2.3, v2.5) — applied for ALL loop types
    const baseConstraints = {
      forbid_recent_nodes: true,
      min_novelty_threshold: MIN_NOVELTY_THRESHOLD
    };

    switch (loopResult.type) {
      case 'exact':
        // Same page revisited → go back to break the cycle
        return {
          action: 'backtrack',
          method: 'history.back()',
          constraints: {
            ...baseConstraints,
            forbid: recentNodes
          }
        };

      case 'alternating':
        // A→B→A→B → force a completely unseen node (break the ping-pong)
        return {
          action: 'force_unseen_node',
          constraints: {
            ...baseConstraints,
            forbid: recentNodes
          }
        };

      case 'action_pattern':
      case 'monotone_type':
        // Same behavior on different pages → change the TYPE of interaction
        return {
          action: 'change_action_type',
          constraints: {
            ...baseConstraints,
            forbid_recent_action_types: true,
            forbid_types: [...new Set(recentActionTypes)],
            prefer_types: this._getUntriedTypes(recentActionTypes)
          }
        };

      default:
        return {
          action: 'force_unseen_node',
          constraints: baseConstraints
        };
    }
  }

  // ─── Enforcement Constraints (Plan §2.3, v2.5) ─────────────────────────────

  /**
   * Apply enforcement constraints to a set of candidate nodes.
   * Filters and re-scores candidates based on the recovery action's constraints.
   * 
   * Called by the content script's ranking logic after receiving a recovery action.
   * 
   * @param {Object[]} candidates - Array of candidate node descriptors
   * @param {Object} constraints - Constraints from getRecoveryAction()
   * @param {Object} taskState - Current task state snapshot
   * @returns {Object[]} Filtered/re-scored candidates
   */
  applyEnforcementConstraints(candidates, constraints, taskState) {
    if (!constraints || !candidates) return candidates;

    // Use computeNodeSignature if available (from task-state.js), otherwise
    // build a compatible signature inline as a fallback.
    const getSignature = (typeof computeNodeSignature === 'function')
      ? computeNodeSignature
      : (c) => {
          const tag = c.tag || 'unknown';
          const text = (c.text || '').slice(0, 30).trim().toLowerCase();
          const role = c.role || '';
          const bx = c.boundingBox ? Math.round(c.boundingBox.x / 100) : -1;
          const by = c.boundingBox ? Math.round(c.boundingBox.y / 100) : -1;
          return `${tag}|${role}|${text}|${bx},${by}`;
        };

    let filtered = [...candidates];

    // Forbid specific node signatures
    if (constraints.forbid && constraints.forbid.length > 0) {
      const forbidSet = new Set(constraints.forbid);
      filtered = filtered.filter(c => !forbidSet.has(getSignature(c)));
    }

    // Forbid recent nodes (all visited nodes in this task)
    if (constraints.forbid_recent_nodes && taskState?.nodes_visited) {
      const visitedSet = new Set(taskState.nodes_visited);
      filtered = filtered.filter(c => !visitedSet.has(getSignature(c)));
    }

    // Forbid recent action types
    if (constraints.forbid_recent_action_types && constraints.forbid_types) {
      const forbidTypes = new Set(constraints.forbid_types);
      filtered = filtered.filter(c => {
        const actionType = this._inferActionType(c);
        return !forbidTypes.has(actionType);
      });
    }

    // If everything was filtered out, return top 3 of original (never leave empty)
    if (filtered.length === 0) {
      console.warn('[LoopDetector] All candidates filtered by enforcement — relaxing constraints');
      return candidates.slice(0, 3);
    }

    return filtered;
  }

  // ─── Query Methods ─────────────────────────────────────────────────────────

  /**
   * Get the current status of the loop detector.
   * @returns {Object} Status snapshot
   */
  getStatus() {
    return {
      stateHistoryLength: this.stateHistory.length,
      actionHistoryLength: this.actionHistory.length,
      loopsDetected: this.loopsDetected,
      consecutiveLoops: this.consecutiveLoops,
      lastResult: this.lastResult,
      recentStates: this.stateHistory.slice(-5),
      recentActions: this.actionHistory.slice(-5)
    };
  }

  /**
   * Reset the loop detector. Called when a new task starts.
   */
  reset() {
    this.stateHistory = [];
    this.actionHistory = [];
    this.loopsDetected = 0;
    this.consecutiveLoops = 0;
    this.lastResult = null;
    console.log('[LoopDetector] Reset');
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  /** @private Push a state entry and enforce history cap */
  _pushState(state) {
    this.stateHistory.push(state);
    if (this.stateHistory.length > this.maxHistory) {
      this.stateHistory.shift();
    }
  }

  /** @private Push an action entry and enforce history cap */
  _pushAction(action) {
    this.actionHistory.push(action);
    if (this.actionHistory.length > this.maxHistory) {
      this.actionHistory.shift();
    }
  }

  /** @private Record a detection event */
  _recordDetection(result) {
    this.loopsDetected++;
    this.consecutiveLoops++;
    this.lastResult = result;
    console.warn(`[LoopDetector] 🔄 Loop detected: ${result.type} (cycle=${result.cycleLength}, total=${this.loopsDetected}, consecutive=${this.consecutiveLoops})`);
  }

  /**
   * Determine which action types haven't been tried recently.
   * Returns types not present in the recent action history.
   * @private
   * @param {string[]} recentTypes - Recently used action types
   * @returns {string[]} Untried action types
   */
  _getUntriedTypes(recentTypes) {
    const ALL_TYPES = ['click', 'type', 'scroll', 'navigate', 'keypress'];
    const recentSet = new Set(recentTypes);
    return ALL_TYPES.filter(t => !recentSet.has(t));
  }

  /**
   * Infer the action type that would be used on a candidate node.
   * @private
   * @param {Object} node - Node descriptor
   * @returns {string} Inferred action type
   */
  _inferActionType(node) {
    const tag = (node.tag || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag)) return 'type';
    if (['a'].includes(tag)) return 'navigate';
    return 'click';
  }
}

// ─── Export Singletons ───────────────────────────────────────────────────────

// Global singleton (loaded via importScripts in service worker)
const loopDetector = new LoopDetector();
