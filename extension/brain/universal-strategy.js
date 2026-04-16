/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Universal Strategy — Reactive Control Layer (Phase 1B.1)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (loaded after brain-executor.js, before content.js)
 * Purpose:  Converts negative diagnostic signals into immediate corrective
 *           actions. Wraps BrainExecutor via composition — never modifies its
 *           internals.
 *
 * Architecture Role (decided in Phase 1B.1 design sessions):
 *   BrainExecutor  → "Execute what you asked." (step-level mechanics)
 *   UniversalStrategy → "Do something about it." (trajectory-level reaction)
 *
 *   This is a REFLEX LAYER, not a planner or orchestrator.
 *   It converts negative signals into corrective behavior and memory updates.
 *
 * What this module does:
 *   1. Delegates the primary action to BrainExecutor.executeFullFlow()
 *   2. Records negative-progress failures that recordAction() misses
 *      (where effect ≠ 'none' but progressDelta < threshold)
 *   3. Evaluates recovery policy (loop recovery, soft backtracking)
 *   4. Optionally executes ONE recovery action (MAX_ACTIONS = 2)
 *   5. Assembles structured response with trajectory metadata
 *
 * What this module does NOT do:
 *   - Step recording (ProgressEstimator handles via BRAIN_RECORD_STEP_COMPLETE)
 *   - Progress computation (ProgressEstimator handles)
 *   - effect='none' failure recording (recordAction() already handles)
 *   - Commitment on type (recordAction._updateMilestones() already handles)
 *   - Goal decomposition (external controller's job)
 *
 * Ref: Phase 1B.1 Implementation Plan v3.1
 * ═══════════════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  /**
   * Steps before which effect='none' failures are NOT manually recorded.
   * Gives the agent freedom to probe and orient in the first few steps.
   * After this threshold, any non-productive action is aggressively penalized.
   */
  const EXPLORATION_GRACE_STEPS = 3;

  /**
   * Hard cap on actions per command. 1 primary + 1 recovery maximum.
   * Prevents infinite recovery chains and bounds compute per user command.
   */
  const MAX_ACTIONS_PER_COMMAND = 2;

  /**
   * Progress delta threshold below which an action is considered harmful.
   * Triggers failure recording and recovery evaluation.
   */
  const NEGATIVE_PROGRESS_THRESHOLD = -0.05;

  // ─── IPC Helper ────────────────────────────────────────────────────────────

  /**
   * Send a message to the background service worker.
   * Wraps chrome.runtime.sendMessage in a promise with graceful error handling.
   *
   * @param {Object} message - Message to send
   * @returns {Promise<Object|null>} Response or null on failure
   */
  function _sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[UniversalStrategy] IPC error:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(response || null);
        });
      } catch (e) {
        console.warn('[UniversalStrategy] IPC exception:', e.message);
        resolve(null);
      }
    });
  }

  // ─── Failure Detection ─────────────────────────────────────────────────────

  /**
   * Determine whether an action result should be recorded as a failure.
   *
   * Note: effect='none' failures are ALREADY recorded by
   *       taskStateTracker.recordAction() in the service worker.
   *       This function catches the edge case where the effect was NOT 'none'
   *       (e.g., 'state_change') but progress still dropped significantly.
   *
   * @param {Object} result - BrainExecutor result
   * @param {number} stepIndex - Current step index from task state
   * @returns {{ isFailure: boolean, reason: string }}
   */
  function _evaluateFailure(result, stepIndex) {
    // Hard failure — action itself failed mechanically
    if (!result.success) {
      return { isFailure: true, reason: 'action_failed' };
    }

    // No progress data available (non-evaluable actions like 'read', 'status')
    if (!result.progress) {
      return { isFailure: false, reason: 'no_progress_data' };
    }

    const delta = result.progress.progressDelta ?? 0;
    const effect = result.progress.effect;

    // Strong failure — progress regressed significantly
    if (delta < NEGATIVE_PROGRESS_THRESHOLD) {
      return { isFailure: true, reason: 'negative_progress' };
    }

    // Weak failure — effect='none' past grace period
    // This is a safety net. recordAction() handles this for the node that was
    // clicked, but this catches it at the strategy level for logging/recovery.
    if (effect === 'none' && stepIndex >= EXPLORATION_GRACE_STEPS) {
      return { isFailure: true, reason: 'no_effect' };
    }

    return { isFailure: false, reason: 'ok' };
  }

  // ─── Recovery Policy ───────────────────────────────────────────────────────

  /**
   * Determine whether and how to recover from a negative outcome.
   * Evaluates multiple signal sources and returns a recovery intent.
   *
   * Policy gates (any → skip recovery):
   *   - Commitment window active (don't interrupt form filling)
   *   - Near high-water mark (the agent isn't off-track)
   *   - Action was mechanically unsuccessful (nothing to undo)
   *
   * @param {Object} result - BrainExecutor result
   * @param {{ isFailure: boolean, reason: string }} failureInfo - From _evaluateFailure
   * @param {Object|null} context - Service worker context { taskState, loopStatus }
   * @returns {{ shouldRecover: boolean, intent: string, reason: string }|null}
   */
  function _evaluateRecovery(result, failureInfo, context) {
    // No failure → no recovery needed
    if (!failureInfo.isFailure) {
      return null;
    }

    // Can't recover from mechanical failure (no action was taken to undo)
    if (!result.success) {
      return null;
    }

    const taskState = context?.taskState;
    const loopStatus = context?.loopStatus;

    // Gate: commitment window active → don't interrupt
    if (taskState?.commitment?.active) {
      return null;
    }

    // Gate: near high-water mark → not off-track enough to justify recovery
    const hwm = result.progress?.highWaterMark;
    if (hwm && result.progress?.progress >= hwm.progress * 0.9) {
      return null;
    }

    const effect = result.progress?.effect;
    const delta = result.progress?.progressDelta ?? 0;

    // ── Signal 1: Loop recovery ──
    // LoopDetector has already identified a loop and prescribed a recovery.
    // This has highest priority because loops are the most destructive failure.
    if (loopStatus?.lastResult?.loopDetected) {
      const loopType = loopStatus.lastResult.type;

      if (loopType === 'exact') {
        return { shouldRecover: true, intent: 'back', reason: 'loop_exact' };
      }
      if (loopType === 'alternating') {
        // Force a different element — we scroll to expose unseen candidates
        return { shouldRecover: true, intent: 'scroll down', reason: 'loop_alternating' };
      }
      if (loopType === 'action_pattern' || loopType === 'monotone_type') {
        // Change interaction type — scroll introduces a different action
        return { shouldRecover: true, intent: 'scroll down', reason: 'loop_' + loopType };
      }
    }

    // ── Signal 2: Navigation to wrong page ──
    // The agent clicked a link, navigated to a bad page, and progress dropped.
    // Try history.back() — works reliably for SPAs, best-effort for full navs.
    if (effect === 'navigation' && delta < NEGATIVE_PROGRESS_THRESHOLD) {
      return { shouldRecover: true, intent: 'back', reason: 'navigation_failure' };
    }

    // ── Signal 3: Intent drift with high-water mark ──
    // Progress has been drifting down for multiple steps, and we know where
    // peak progress was achieved. Navigate back to that URL.
    const intentDrift = result.progress?.intentDrift;
    if (intentDrift?.drifting && hwm?.url) {
      const currentUrl = window.location.href;
      // Only navigate if we're not already at/near the HWM URL
      if (currentUrl !== hwm.url) {
        return { shouldRecover: true, intent: 'back', reason: 'drift' };
      }
    }

    // ── Signal 4: Negative progress on same page ──
    // Something bad happened but we didn't navigate away — try scrolling
    // to reveal different candidates.
    if (delta < NEGATIVE_PROGRESS_THRESHOLD && effect !== 'navigation') {
      return { shouldRecover: true, intent: 'scroll up', reason: 'negative_progress' };
    }

    return null;
  }

  // ─── Node Info Extraction ──────────────────────────────────────────────────

  /**
   * Extract a node descriptor from BrainExecutor's result, compatible with
   * the service worker's computeNodeSignature() format.
   *
   * @param {Object} result - BrainExecutor result
   * @returns {Object|null} Node descriptor { tag, text, role, boundingBox }
   */
  function _extractNodeInfo(result) {
    const data = result.response?.data;
    if (!data) return null;

    return {
      tag: data.tag || data.nodeType || '',
      text: (data.text || '').slice(0, 50),
      role: data.role || '',
      boundingBox: data.boundingBox || null
    };
  }

  // ─── UniversalStrategy Class ───────────────────────────────────────────────

  class UniversalStrategy {
    /**
     * @param {BrainExecutor} executor - The BrainExecutor instance to wrap
     */
    constructor(executor) {
      if (!executor) {
        throw new Error('[UniversalStrategy] executor is required');
      }
      this.executor = executor;
    }

    /**
     * Execute a command with reactive control.
     *
     * Lifecycle:
     *   1. Primary action (BrainExecutor)
     *   2. Failure evaluation
     *   3. Failure bookkeeping (IPC to service worker, for negative-progress edge case)
     *   4. Recovery evaluation
     *   5. Optional recovery action (max 1)
     *   6. Structured response assembly
     *
     * @param {string} prompt - Natural language command
     * @param {Object[]} [images=[]] - Attached images
     * @returns {Promise<Object>} Structured result with backward-compatible shape
     */
    async executeFullFlow(prompt, images = []) {
      const strategyStart = Date.now();
      let actionsExecuted = 0;

      console.log('[UniversalStrategy] ────────────────────────────────');
      console.log(`[UniversalStrategy] Command: "${prompt}"`);

      // ═════════════════════════════════════════════════════════════
      //  1. PRIMARY ACTION
      // ═════════════════════════════════════════════════════════════

      const primaryResult = await this.executor.executeFullFlow(prompt, images);
      actionsExecuted++;

      // If clarification was triggered, check if we should override with recovery
      if (primaryResult.status === 'needs_clarification') {
        const severity = primaryResult.severity;

        // Hard triggers ALWAYS pass through — never override
        if (severity === 'hard') {
          console.log(`[UniversalStrategy] Hard clarification: ${primaryResult.reason} — passing through`);
          primaryResult.strategyTime = Date.now() - strategyStart;
          return primaryResult;
        }

        // Soft triggers — we COULD attempt recovery, but we need context first.
        // Fetch context to decide if recovery makes sense.
        let context = null;
        try {
          context = await _sendMessage({ type: 'BRAIN_GET_FULL_CONTEXT' });
        } catch (e) { /* non-fatal */ }

        const loopStatus = context?.loopStatus;

        // If there's a loop AND it's soft escalation, try recovery
        if (loopStatus?.lastResult?.loopDetected && actionsExecuted < MAX_ACTIONS_PER_COMMAND) {
          console.log(`[UniversalStrategy] Soft clarification with active loop — attempting recovery`);

          const recovery = _evaluateRecovery(
            // Synthesize a minimal result for recovery evaluation
            { success: true, progress: { effect: 'none', progressDelta: -0.1, intentDrift: { drifting: false } } },
            { isFailure: true, reason: 'loop_detected' },
            context
          );

          if (recovery) {
            const recoveryResult = await this._executeRecovery(recovery, actionsExecuted);
            actionsExecuted++;

            return this._assembleResponse(primaryResult, recoveryResult, recovery, strategyStart);
          }
        }

        // No recovery possible for soft clarification — pass through
        primaryResult.strategyTime = Date.now() - strategyStart;
        return primaryResult;
      }

      // ═════════════════════════════════════════════════════════════
      //  2. FAILURE EVALUATION
      // ═════════════════════════════════════════════════════════════

      // Get current step index from the task state (already updated by
      // ProgressEstimator's BRAIN_RECORD_STEP_COMPLETE call).
      let context = null;
      try {
        context = await _sendMessage({ type: 'BRAIN_GET_FULL_CONTEXT' });
      } catch (e) { /* non-fatal */ }

      const stepIndex = context?.taskState?.step_index || 0;
      const failureInfo = _evaluateFailure(primaryResult, stepIndex);

      if (failureInfo.isFailure) {
        console.log(`[UniversalStrategy] ⚠ Failure detected: ${failureInfo.reason}`);
      }

      // ═════════════════════════════════════════════════════════════
      //  3. FAILURE BOOKKEEPING
      // ═════════════════════════════════════════════════════════════
      //
      //  recordAction() in task-state.js already handles:
      //    - effect='none' → adds to recentFailures
      //    - type actions → auto-enters commitment
      //
      //  We only need to call BRAIN_TASK_RECORD_FAILURE for the edge case:
      //    effect ≠ 'none' BUT progressDelta < threshold
      //    (e.g., state_change that made things worse)

      if (failureInfo.isFailure && failureInfo.reason === 'negative_progress') {
        const nodeInfo = _extractNodeInfo(primaryResult);
        if (nodeInfo && stepIndex >= EXPLORATION_GRACE_STEPS) {
          try {
            await _sendMessage({
              type: 'BRAIN_TASK_RECORD_FAILURE',
              node: nodeInfo
            });
            console.log('[UniversalStrategy] Failure recorded for negative-progress node');
          } catch (e) {
            console.warn('[UniversalStrategy] Failure recording failed (non-fatal):', e.message);
          }
        }
      }

      // ═════════════════════════════════════════════════════════════
      //  4. RECOVERY EVALUATION
      // ═════════════════════════════════════════════════════════════

      let recoveryResult = null;
      let recoveryMeta = null;

      if (failureInfo.isFailure && actionsExecuted < MAX_ACTIONS_PER_COMMAND) {
        const recovery = _evaluateRecovery(primaryResult, failureInfo, context);

        if (recovery && recovery.shouldRecover) {
          console.log(`[UniversalStrategy] Recovery: ${recovery.reason} → "${recovery.intent}"`);

          // ═════════════════════════════════════════════════════════
          //  5. RECOVERY ACTION (max 1)
          // ═════════════════════════════════════════════════════════

          recoveryResult = await this._executeRecovery(recovery, actionsExecuted);
          actionsExecuted++;

          recoveryMeta = {
            reason: recovery.reason,
            intent: recovery.intent,
            success: recoveryResult?.success || false
          };

          // If recovery ALSO failed, record that failure too
          if (recoveryResult && !recoveryResult.success) {
            console.log('[UniversalStrategy] Recovery action also failed');
          } else if (recoveryResult) {
            // Evaluate recovery result as well
            const recoveryFailure = _evaluateFailure(recoveryResult, stepIndex + 1);
            if (recoveryFailure.isFailure && recoveryFailure.reason === 'negative_progress') {
              const recoveryNode = _extractNodeInfo(recoveryResult);
              if (recoveryNode) {
                try {
                  await _sendMessage({
                    type: 'BRAIN_TASK_RECORD_FAILURE',
                    node: recoveryNode
                  });
                } catch (e) { /* non-fatal */ }
              }
            }
          }
        }
      }

      // ═════════════════════════════════════════════════════════════
      //  6. STRUCTURED RESPONSE
      // ═════════════════════════════════════════════════════════════

      return this._assembleResponse(primaryResult, recoveryResult, recoveryMeta, strategyStart);
    }

    /**
     * Execute a recovery action via BrainExecutor with skipClarification.
     *
     * @param {{ intent: string, reason: string }} recovery - Recovery descriptor
     * @param {number} actionsExecuted - Current action count (for logging)
     * @returns {Promise<Object>} BrainExecutor result
     */
    async _executeRecovery(recovery, actionsExecuted) {
      console.log(`[UniversalStrategy] Executing recovery [${actionsExecuted + 1}/${MAX_ACTIONS_PER_COMMAND}]: "${recovery.intent}" (reason: ${recovery.reason})`);

      try {
        const result = await this.executor.executeFullFlow(
          recovery.intent,
          [],
          { skipClarification: true }
        );
        return result;
      } catch (e) {
        // Recovery failure is expected for full-page navigations where the
        // content script is being torn down. Fail gracefully.
        console.warn(`[UniversalStrategy] Recovery threw (expected for full navs):`, e.message);
        return {
          success: false,
          error: e.message,
          response: { text: `Recovery failed: ${e.message}` }
        };
      }
    }

    /**
     * Assemble the final structured response.
     * Maintains backward compatibility: top-level { success, response } fields
     * are preserved so content.js and the bridge server work unchanged.
     *
     * @param {Object} primaryResult - Result from primary action
     * @param {Object|null} recoveryResult - Result from recovery (if any)
     * @param {Object|null} recoveryMeta - Recovery metadata { reason, intent, success }
     * @param {number} strategyStart - Start timestamp for total timing
     * @returns {Object} Structured response
     */
    _assembleResponse(primaryResult, recoveryResult, recoveryMeta, strategyStart) {
      // Use recovery result for top-level success/response if recovery happened
      // and was successful (the recovery "fixed" things).
      const effectiveResult = (recoveryResult?.success && recoveryMeta)
        ? recoveryResult
        : primaryResult;

      const response = {
        // ── Backward-compatible fields (bridge server expects these) ──
        success: effectiveResult.success,
        response: effectiveResult.response,

        // ── Progress data (from the effective result) ──
        progress: effectiveResult.progress || primaryResult.progress,

        // ── Engine/diagnostic passthrough ──
        engineStatus: primaryResult.engineStatus,
        diagnostics: primaryResult.diagnostics,
        totalTime: primaryResult.totalTime,

        // ── Strategy-specific metadata ── (NEW in Phase 1B.1)
        strategy: {
          primaryAction: {
            success: primaryResult.success,
            prompt: primaryResult.response?.text?.substring(0, 100),
            progress: primaryResult.progress ? {
              delta: primaryResult.progress.progressDelta,
              effect: primaryResult.progress.effect,
              score: primaryResult.progress.progress
            } : null
          },
          recoveryAction: recoveryMeta ? {
            ...recoveryMeta,
            progress: recoveryResult?.progress ? {
              delta: recoveryResult.progress.progressDelta,
              effect: recoveryResult.progress.effect,
              score: recoveryResult.progress.progress
            } : null
          } : null,
          strategyTime: Date.now() - strategyStart
        }
      };

      // Pass through clarification fields if present
      if (primaryResult.status) response.status = primaryResult.status;
      if (primaryResult.reason) response.reason = primaryResult.reason;
      if (primaryResult.severity) response.severity = primaryResult.severity;
      if (primaryResult.clarificationContext) response.clarificationContext = primaryResult.clarificationContext;

      console.log('[UniversalStrategy] ────────────────────────────────');
      console.log(`[UniversalStrategy] ✓ Complete (${response.strategy.strategyTime}ms)`);
      if (recoveryMeta) {
        console.log(`[UniversalStrategy] Recovery: ${recoveryMeta.reason} → ${recoveryMeta.success ? '✓' : '✗'}`);
      }

      return response;
    }
  }

  // ─── Export to BrowserAgent namespace ───────────────────────────────────────

  BrowserAgent.UniversalStrategy = UniversalStrategy;

})();
