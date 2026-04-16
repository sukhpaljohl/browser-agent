/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Context Builder — Command Center ↔ Content Script Bridge
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Lives in: content script (Isolated World)
 * Purpose:  Enriches the 30-50 pruned candidate nodes with context from the
 *           background service worker's Command Center (TaskStateTracker +
 *           LoopDetector, loaded in Phase 1A.1).
 * 
 * Architecture (critical performance constraint):
 *   ❌ DO NOT call chrome.runtime.sendMessage per-node (30-50 async round-trips)
 *   ✅ DO call BRAIN_GET_FULL_CONTEXT exactly ONCE, then enrich in a pure sync loop
 * 
 * This module is the bridge between:
 *   - CandidatePruner (produces 30-50 nodes with signatures)
 *   - Command Center (knows failure memory, loop status, commitment window)
 * 
 * After enrichment, each candidate node gains context fields prefixed with `_`
 * that downstream rankers/strategies can use for scoring adjustments.
 * 
 * Ref: Implementation Plan v2.7 §15 Phase 1A.2
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.ContextBuilder = (() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  /** Failure penalty multiplier (mirrors task-state.js FAILURE_PENALTY_MULTIPLIER) */
  const FAILURE_PENALTY = 0.3;

  /** Commitment bonus — score multiplier when node type matches active commitment */
  const COMMITMENT_BONUS = 1.4;

  /** Commitment type → nodeType mapping for bonus matching */
  const COMMITMENT_TYPE_MAP = {
    'form_submission': ['input_field', 'clickable_action'],
    'navigation': ['navigation_link'],
    'search': ['input_field', 'dynamic_trigger']
  };

  /** Phase 1B.1: Diversity penalty per repeated action type in the recent window */
  const DIVERSITY_PENALTY_PER_REPEAT = 0.85;

  /** Phase 1B.1: Number of recent actions to check for diversity */
  const DIVERSITY_WINDOW = 5;

  // ─── IPC: Single-Fetch Context ─────────────────────────────────────────

  /**
   * Fetch the full Command Center context from the background service worker.
   * Returns BOTH task state and loop status in a single message round-trip.
   * 
   * @returns {Promise<CommandCenterContext>}
   * 
   * @typedef {Object} CommandCenterContext
   * @property {Object|null} taskState - Serialized TaskStateTracker snapshot
   * @property {Object|null} loopStatus - LoopDetector status snapshot
   * @property {boolean} isTaskActive - Whether a task is currently running
   */
  function _fetchContext() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'BRAIN_GET_FULL_CONTEXT' }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ContextBuilder] Failed to fetch context:', chrome.runtime.lastError.message);
            resolve({ taskState: null, loopStatus: null, isTaskActive: false });
            return;
          }
          if (!response || !response.success) {
            console.warn('[ContextBuilder] Context fetch returned error:', response?.error);
            resolve({ taskState: null, loopStatus: null, isTaskActive: false });
            return;
          }
          resolve({
            taskState: response.taskState || null,
            loopStatus: response.loopStatus || null,
            isTaskActive: response.isTaskActive || false
          });
        });
      } catch (e) {
        // Extension context may be invalidated (e.g., extension reload)
        console.warn('[ContextBuilder] Context fetch exception:', e.message);
        resolve({ taskState: null, loopStatus: null, isTaskActive: false });
      }
    });
  }

  // ─── Enrichment Logic ──────────────────────────────────────────────────

  /**
   * Enrich a single candidate node with Command Center context.
   * Pure synchronous operation — all context is already fetched.
   * 
   * @param {Object} node - Candidate node with `signature` field
   * @param {Object} ctx - Pre-fetched Command Center context
   * @param {Object|null} ctx.taskState - Task state snapshot
   * @param {Object|null} ctx.loopStatus - Loop detector status
   */
  function _enrichNode(node, ctx) {
    const { taskState, loopStatus } = ctx;

    // Default context values (no task active)
    node._failurePenalty = 1.0;
    node._commitmentBonus = 1.0;
    node._visitedBefore = false;
    node._loopActive = false;
    node._loopRecoveryConstraint = null;
    node._stepIndex = 0;
    node._progressScore = 0;
    node._budgetFraction = 0;
    node._goalTokenOverlap = 0;

    if (!taskState) return;

    // ── Failure memory penalty ──
    // If this node's signature appears in the failure memory, it previously
    // produced zero/negative effects. Penalize heavily (0.3x).
    if (taskState.recentFailures && taskState.recentFailures.length > 0) {
      const failureSet = new Set(taskState.recentFailures);
      // Cross-reference using the node's text signature (compatible with task-state.js format)
      const textSig = _buildTaskStateSignature(node);
      if (failureSet.has(textSig)) {
        node._failurePenalty = FAILURE_PENALTY;
      }
    }

    // ── Commitment window bonus ──
    // If the task is in a commitment window (e.g., filling a form),
    // boost nodes that match the commitment type.
    if (taskState.commitment && taskState.commitment.active) {
      const targetType = taskState.commitment.target_type;
      const matchingTypes = COMMITMENT_TYPE_MAP[targetType] || [];
      if (matchingTypes.includes(node.nodeType)) {
        node._commitmentBonus = COMMITMENT_BONUS;
      }
    }

    // ── Visit tracking ──
    // Flag if this node has been interacted with before in this task.
    if (taskState.nodes_visited && taskState.nodes_visited.length > 0) {
      const visitedSet = new Set(taskState.nodes_visited);
      const textSig = _buildTaskStateSignature(node);
      node._visitedBefore = visitedSet.has(textSig);
    }

    // ── Goal token overlap ──
    // Count how many goal tokens appear in this node's visible text.
    if (taskState.goalTokens && taskState.goalTokens.length > 0) {
      const nodeText = ((node.innerText || '') + ' ' + (node.ariaLabel || '') + ' ' + (node.placeholder || '')).toLowerCase();
      let overlap = 0;
      for (const token of taskState.goalTokens) {
        if (nodeText.includes(token)) overlap++;
      }
      node._goalTokenOverlap = overlap;
    }

    // ── Task state scalars ──
    node._stepIndex = taskState.step_index || 0;
    node._progressScore = taskState.progress_score || 0;
    node._budgetFraction = taskState.budgetFraction || 0;

    // ── Loop detector context ──
    if (loopStatus) {
      const isLooping = loopStatus.lastResult && loopStatus.lastResult.loopDetected;
      node._loopActive = !!isLooping;
      if (isLooping) {
        node._loopRecoveryConstraint = loopStatus.lastResult.type || null;
      }
    }

    // ── Phase 1B.1: Exploration diversity penalty ──
    // Penalize candidates whose tag (element type) has been over-represented
    // in recent actions. Encourages the agent to naturally explore different
    // interaction types without requiring explicit scheduling logic.
    node._diversityPenalty = 1.0;
    if (taskState.actions_taken && taskState.actions_taken.length > 0) {
      const recentActions = taskState.actions_taken.slice(-DIVERSITY_WINDOW);
      const nodeTag = (node.tag || '').toLowerCase();
      if (nodeTag) {
        const tagMatches = recentActions.filter(a => (a.tag || '').toLowerCase() === nodeTag).length;
        if (tagMatches > 0) {
          node._diversityPenalty = Math.pow(DIVERSITY_PENALTY_PER_REPEAT, tagMatches);
        }
      }
    }
  }

  /**
   * Build a signature compatible with task-state.js's computeNodeSignature().
   * Format: "tag|role|text[:30]|bx,by" where bx,by are 100px grid buckets.
   * 
   * @param {Object} node - Candidate node
   * @returns {string} Task-state-compatible signature
   */
  function _buildTaskStateSignature(node) {
    const tag = node.tag || 'unknown';
    const text = (node.innerText || '').slice(0, 30).trim().toLowerCase();
    const role = node.role || '';
    const bx = node.rect ? Math.round(node.rect.x / 100) : -1;
    const by = node.rect ? Math.round(node.rect.y / 100) : -1;
    return `${tag}|${role}|${text}|${bx},${by}`;
  }

  // ─── Main Pipeline ─────────────────────────────────────────────────────

  /**
   * Enrich an array of pruned candidate nodes with Command Center context.
   * 
   * This is the main entry point. It:
   *   1. Makes ONE async call to fetch full context from the service worker
   *   2. Iterates candidates in a pure sync loop to inject context fields
   * 
   * @param {Object[]} candidates - Pruned candidates from CandidatePruner.prune()
   * @returns {Promise<EnrichResult>}
   * 
   * @typedef {Object} EnrichResult
   * @property {Object[]} candidates - Same candidates with context fields added
   * @property {Object} context - The raw Command Center context (for logging)
   * @property {boolean} isTaskActive - Whether a task is running
   */
  async function enrich(candidates) {
    // Step 1: Single async fetch
    const ctx = await _fetchContext();

    // Step 2: Pure sync enrichment loop
    for (const node of candidates) {
      _enrichNode(node, ctx);
    }

    // Log summary
    if (ctx.isTaskActive && ctx.taskState) {
      const failureHits = candidates.filter(c => c._failurePenalty < 1.0).length;
      const commitmentHits = candidates.filter(c => c._commitmentBonus > 1.0).length;
      const visitedHits = candidates.filter(c => c._visitedBefore).length;
      console.log(
        `[ContextBuilder] Enriched ${candidates.length} candidates`,
        `| Task #${ctx.taskState.taskId} step ${ctx.taskState.step_index}`,
        `| Failures: ${failureHits}, Committed: ${commitmentHits}, Visited: ${visitedHits}`,
        `| Loop: ${ctx.loopStatus?.lastResult?.loopDetected ? ctx.loopStatus.lastResult.type : 'none'}`,
        `| Diversity penalties: ${candidates.filter(c => c._diversityPenalty < 1.0).length}`
      );
    } else {
      console.log(`[ContextBuilder] No active task — enriched ${candidates.length} candidates with defaults`);
    }

    return {
      candidates,
      context: ctx,
      isTaskActive: ctx.isTaskActive
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    enrich,
    // Exposed for testing
    _fetchContext,
    _enrichNode,
    _buildTaskStateSignature,
    FAILURE_PENALTY,
    COMMITMENT_BONUS,
    COMMITMENT_TYPE_MAP,
    DIVERSITY_PENALTY_PER_REPEAT,
    DIVERSITY_WINDOW
  };
})();
