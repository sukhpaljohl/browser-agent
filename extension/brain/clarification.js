/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Clarification Engine — "Ask vs Proceed" Escalation Logic
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Determines whether the agent should proceed with an action or
 *           escalate to the user. Implements the third response path:
 *
 *             Act (confident) → Explore (somewhat uncertain) → ASK (stuck)
 *
 *           Without this, the agent explores infinitely when genuinely stuck,
 *           wasting compute and producing garbage data.
 *
 * Architecture:
 *   - Two-tier trigger system: soft (early graceful) + hard (fallback)
 *   - 3-signal heuristic uncertainty (Phase 1, no ML):
 *       uncertainty = 0.4 * marginSignal + 0.3 * novelty + 0.3 * (1 - confidence)
 *   - Dual progress counters:
 *       stepsStuck       — absolute drift (progress < 0.15 for N steps)
 *       noProgressCount  — delta stagnation (delta ≤ 0.02 for N steps)
 *   - Commitment window hard gate — never interrupt a subtask mid-flow
 *   - Early-step suppression — don't escalate in first 2 steps
 *   - Budget shaping — escalation sensitivity increases after step 20
 *
 * Response format when triggered:
 *   { status: "needs_clarification", reason: "...", severity: "soft|hard", context: {...} }
 *
 * Ref: Implementation Plan v2.8 §10, §15 Phase 1A.3c
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.ClarificationEngine = (() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  /** Default max steps per task (matches task-state.js) */
  const MAX_STEPS_PER_TASK = 30;

  /** Step index after which budget shaping activates */
  const BUDGET_SHAPING_THRESHOLD = 20;

  /** Uncertainty threshold for soft escalation trigger */
  const UNCERTAINTY_THRESHOLD = 0.7;

  /** Multiplier for uncertainty threshold during budget shaping */
  const BUDGET_SHAPING_ESCALATION_FACTOR = 0.7;

  /** Progress delta threshold — deltas ≤ this count as "no progress" */
  const NO_PROGRESS_DELTA_THRESHOLD = 0.02;

  /** Absolute progress threshold for "stuck" detection */
  const STUCK_PROGRESS_THRESHOLD = 0.15;

  /** Early-step suppression: multiply uncertainty by this in first N steps */
  const EARLY_STEP_SUPPRESSION = 0.6;

  /** Number of steps considered "early" */
  const EARLY_STEP_COUNT = 2;

  /** Epsilon for margin noise floor (5% relative margin) */
  const MARGIN_EPSILON = 0.05;

  // ─── Novelty Computation ───────────────────────────────────────────────────

  /**
   * Compute a heuristic novelty score for the current page.
   * Phase 1 proxy — uses URL path matching against visited pages.
   *
   * @param {string} currentUrl - Current page URL
   * @param {Object|null} taskState - Task state snapshot
   * @returns {number} 0.0 (familiar) to 1.0 (completely novel)
   */
  function _computeNovelty(currentUrl, taskState) {
    if (!taskState || !taskState.pages_visited || taskState.pages_visited.length === 0) {
      return 1.0; // no history → completely novel
    }

    let currentDomain, currentPath;
    try {
      const parsed = new URL(currentUrl);
      currentDomain = parsed.hostname;
      currentPath = parsed.pathname;
    } catch (e) {
      return 0.5; // unparseable URL → moderate novelty
    }

    // Parse visited pages
    const visited = [];
    for (const url of taskState.pages_visited) {
      try {
        const parsed = new URL(url);
        visited.push({ domain: parsed.hostname, path: parsed.pathname });
      } catch (e) {
        // skip unparseable
      }
    }

    // Check domain-level novelty
    const domainSeen = visited.some(v => v.domain === currentDomain);
    if (!domainSeen) return 1.0; // completely new domain

    // Check path-level novelty
    const pathSeen = visited.some(v => v.domain === currentDomain && v.path === currentPath);
    if (!pathSeen) return 0.6; // known domain, new page type

    // Familiar territory
    return 0.2;
  }

  // ─── Uncertainty Computation ───────────────────────────────────────────────

  /**
   * Compute heuristic uncertainty from candidate scores.
   * 3-signal composite: margin ambiguity + novelty + confidence inverse.
   *
   * Phase 1 approximation of the Phase 2 formula:
   *   uncertainty = entropy + margin_inverse + novelty
   *
   * @param {Object[]} candidates - Scored candidates (must have _prunerScore)
   * @param {string} currentUrl - Current page URL
   * @param {Object|null} taskState - Task state snapshot
   * @param {number} stepIndex - Current step index
   * @returns {{ uncertainty: number, components: Object }}
   */
  function computeUncertainty(candidates, currentUrl, taskState, stepIndex) {
    // ── Edge case: no candidates ──
    if (!candidates || candidates.length === 0) {
      return {
        uncertainty: 1.0,
        components: { marginSignal: 1.0, novelty: 1.0, confidenceInverse: 1.0 }
      };
    }

    // ── Extract scores (sorted descending by pruner) ──
    const scores = candidates
      .map(c => c._prunerScore || 0)
      .sort((a, b) => b - a);

    const top1 = scores[0];
    const top2 = scores.length > 1 ? scores[1] : 0;

    // ── Signal 1: Margin (ambiguity between top-2) ──
    let marginSignal = 0;
    if (scores.length > 1) {
      const margin = top1 - top2;
      const relativeMargin = margin / Math.max(top1, 0.01);

      // Apply epsilon noise floor — differences < 5% are not real ambiguity
      const adjustedMargin = Math.max(relativeMargin - MARGIN_EPSILON, 0);
      marginSignal = 1 - Math.min(adjustedMargin / (1 - MARGIN_EPSILON), 1.0);
    }
    // Single candidate → marginSignal = 0 (no ambiguity, only one choice)

    // ── Signal 2: Novelty (environment familiarity) ──
    const novelty = _computeNovelty(currentUrl, taskState);

    // ── Signal 3: Confidence inverse (absolute quality of best option) ──
    // Normalize top1 score to 0-1 range (pruner scores are ~10-80)
    const normalizedConfidence = Math.min(top1 / 80, 1.0);
    const confidenceInverse = 1 - normalizedConfidence;

    // ── Weighted combination ──
    let uncertainty = 0.4 * marginSignal + 0.3 * novelty + 0.3 * confidenceInverse;

    // ── Early-step suppression ──
    if (stepIndex < EARLY_STEP_COUNT) {
      uncertainty *= EARLY_STEP_SUPPRESSION;
    }

    // Clamp to 0-1
    uncertainty = Math.max(0, Math.min(1, uncertainty));

    return {
      uncertainty,
      components: {
        marginSignal: Math.round(marginSignal * 1000) / 1000,
        novelty: Math.round(novelty * 1000) / 1000,
        confidenceInverse: Math.round(confidenceInverse * 1000) / 1000
      }
    };
  }

  // ─── Progress Counter Computation ──────────────────────────────────────────

  /**
   * Compute the delta-based consecutive-no-progress count from progress history.
   * Counts how many recent consecutive steps had progress delta ≤ threshold.
   *
   * @param {number[]} progressHistory - Array of recent progress scores
   * @returns {number} Count of recent consecutive no-progress steps
   */
  function _computeConsecutiveNoProgress(progressHistory) {
    if (!progressHistory || progressHistory.length < 2) return 0;

    let count = 0;
    for (let i = progressHistory.length - 1; i > 0; i--) {
      const delta = progressHistory[i] - progressHistory[i - 1];
      if (delta <= NO_PROGRESS_DELTA_THRESHOLD) {
        count++;
      } else {
        break; // streak broken
      }
    }

    return count;
  }

  /**
   * Compute absolute stuck count — consecutive steps with progress < threshold.
   *
   * @param {number[]} progressHistory - Array of recent progress scores
   * @returns {number} Count of recent consecutive low-progress steps
   */
  function _computeStepsStuck(progressHistory) {
    if (!progressHistory || progressHistory.length === 0) return 0;

    let count = 0;
    for (let i = progressHistory.length - 1; i >= 0; i--) {
      if (progressHistory[i] < STUCK_PROGRESS_THRESHOLD) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  // ─── Required Input Detection ──────────────────────────────────────────────

  /**
   * Check if there are required empty inputs on the page that the agent
   * can't fill from the goal text.
   *
   * @param {string[]} goalTokens - Tokenized goal text
   * @returns {{ hasEmptyRequired: boolean, goalHasRelevantText: boolean }}
   */
  function _checkRequiredInputs(goalTokens) {
    let hasEmptyRequired = false;
    let goalHasRelevantText = false;

    try {
      const requiredInputs = document.querySelectorAll(
        'input[required]:not([type="hidden"]):not([type="submit"]):not([type="button"]), ' +
        'textarea[required], ' +
        'input[aria-required="true"]:not([type="hidden"]), ' +
        'textarea[aria-required="true"]'
      );

      for (const el of requiredInputs) {
        const value = (el.value || '').trim();
        if (value.length === 0) {
          hasEmptyRequired = true;

          // Check if the input's label/placeholder overlaps with goal tokens
          const label = (
            (el.getAttribute('placeholder') || '') + ' ' +
            (el.getAttribute('aria-label') || '') + ' ' +
            (el.getAttribute('name') || '')
          ).toLowerCase();

          if (goalTokens && goalTokens.length > 0) {
            for (const token of goalTokens) {
              if (label.includes(token)) {
                goalHasRelevantText = true;
                break;
              }
            }
          }

          break; // found at least one empty required input
        }
      }
    } catch (e) {
      // DOM access failure during navigation — not an error
    }

    return { hasEmptyRequired, goalHasRelevantText };
  }

  // ─── Main Evaluation ───────────────────────────────────────────────────────

  /**
   * Evaluate whether the agent should escalate to the user.
   *
   * @param {Object} context - Full evaluation context
   * @param {Object|null} context.taskState - Task state snapshot from service worker
   * @param {Object|null} context.loopStatus - Loop detector status
   * @param {Object[]} context.candidates - Current scored candidates
   * @param {string[]} [context.goalTokens=[]] - Tokenized goal text
   * @returns {EscalationResult}
   *
   * @typedef {Object} EscalationResult
   * @property {boolean} escalate - Whether to escalate
   * @property {string} [status] - "needs_clarification" when escalating
   * @property {string} [reason] - Why we're escalating
   * @property {string} [severity] - "soft" | "hard"
   * @property {Object} [context] - Additional context for the user/bridge
   */
  function evaluate(context) {
    const {
      taskState,
      loopStatus,
      candidates,
      goalTokens = []
    } = context;

    const stepIndex = taskState?.step_index || 0;
    const maxSteps = taskState?.maxStepsPerTask || MAX_STEPS_PER_TASK;
    const progressHistory = taskState?.progressHistory || [];

    // ═══════════════════════════════════════════════════════════════════════
    //  HARD GATE: Commitment Window Suppression
    //  NEVER interrupt the agent mid-subtask (e.g., filling a form)
    // ═══════════════════════════════════════════════════════════════════════

    if (taskState?.commitment?.active) {
      _recordDiagnostic('suppressed', { reason: 'commitment_active', stepIndex });
      return { escalate: false, reason: 'commitment_active' };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  HARD TRIGGER: Budget Exhaustion (fast exit — no pipeline needed)
    // ═══════════════════════════════════════════════════════════════════════

    if (stepIndex >= maxSteps) {
      const result = {
        escalate: true,
        status: 'needs_clarification',
        reason: 'budget_exhausted',
        severity: 'hard',
        context: _buildEscalationContext(taskState, loopStatus, stepIndex)
      };
      _recordDiagnostic('triggered', result);
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  HARD TRIGGER: Persistent Loop (3+ consecutive loop detections)
    // ═══════════════════════════════════════════════════════════════════════

    const loopCycles = loopStatus?.consecutiveLoops || 0;
    if (loopCycles >= 3) {
      const result = {
        escalate: true,
        status: 'needs_clarification',
        reason: 'persistent_loop',
        severity: 'hard',
        context: {
          ..._buildEscalationContext(taskState, loopStatus, stepIndex),
          loopType: loopStatus?.lastResult?.type || 'unknown',
          loopCycles
        }
      };
      _recordDiagnostic('triggered', result);
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  Compute dual progress counters
    // ═══════════════════════════════════════════════════════════════════════

    const consecutiveNoProgress = _computeConsecutiveNoProgress(progressHistory);
    const stepsStuck = _computeStepsStuck(progressHistory);

    // ═══════════════════════════════════════════════════════════════════════
    //  HARD TRIGGER: Stagnant AND Lost
    //  No improvement (delta-based) AND absolute low progress
    // ═══════════════════════════════════════════════════════════════════════

    if (consecutiveNoProgress >= 3 && stepsStuck >= 2) {
      const result = {
        escalate: true,
        status: 'needs_clarification',
        reason: 'no_progress',
        severity: 'hard',
        context: {
          ..._buildEscalationContext(taskState, loopStatus, stepIndex),
          consecutiveNoProgress,
          stepsStuck
        }
      };
      _recordDiagnostic('triggered', result);
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  HARD TRIGGER: Missing Required Input
    // ═══════════════════════════════════════════════════════════════════════

    const { hasEmptyRequired, goalHasRelevantText } = _checkRequiredInputs(goalTokens);
    if (hasEmptyRequired && !goalHasRelevantText) {
      const result = {
        escalate: true,
        status: 'needs_clarification',
        reason: 'missing_input',
        severity: 'hard',
        context: _buildEscalationContext(taskState, loopStatus, stepIndex)
      };
      _recordDiagnostic('triggered', result);
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  SOFT TRIGGER: Uncertain + Stalling
    //  High uncertainty AND recent no-progress
    // ═══════════════════════════════════════════════════════════════════════

    const { uncertainty, components } = computeUncertainty(
      candidates,
      window.location.href,
      taskState,
      stepIndex
    );

    // Budget shaping: after step 20, lower the escalation threshold
    let effectiveThreshold = UNCERTAINTY_THRESHOLD;
    if (stepIndex >= BUDGET_SHAPING_THRESHOLD) {
      effectiveThreshold *= BUDGET_SHAPING_ESCALATION_FACTOR;
    }

    // Intent drift boost: if stepsStuck >= 3, lower threshold further
    if (stepsStuck >= 3) {
      effectiveThreshold *= 0.8;
    }

    if (uncertainty > effectiveThreshold && consecutiveNoProgress >= 2) {
      const result = {
        escalate: true,
        status: 'needs_clarification',
        reason: 'uncertain_and_stalling',
        severity: 'soft',
        context: {
          ..._buildEscalationContext(taskState, loopStatus, stepIndex),
          uncertainty: Math.round(uncertainty * 1000) / 1000,
          uncertaintyComponents: components,
          effectiveThreshold: Math.round(effectiveThreshold * 1000) / 1000,
          consecutiveNoProgress,
          stepsStuck
        }
      };
      _recordDiagnostic('triggered', result);
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  No escalation — proceed with action
    // ═══════════════════════════════════════════════════════════════════════

    _recordDiagnostic('passed', {
      stepIndex,
      uncertainty: Math.round(uncertainty * 1000) / 1000,
      effectiveThreshold: Math.round(effectiveThreshold * 1000) / 1000,
      consecutiveNoProgress,
      stepsStuck,
      loopCycles
    });

    return { escalate: false };
  }

  // ─── Internal Helpers ──────────────────────────────────────────────────────

  /**
   * Build the standard escalation context payload.
   * @private
   */
  function _buildEscalationContext(taskState, loopStatus, stepIndex) {
    return {
      currentUrl: window.location.href,
      stepIndex,
      progress: taskState?.progress_score || 0,
      goal: taskState?.goal || '',
      lastActions: (taskState?.actions_taken || []).slice(-3).map(a => ({
        type: a.type,
        text: (a.text || '').substring(0, 30),
        tag: a.tag || ''
      })),
      loopActive: !!(loopStatus?.lastResult?.loopDetected),
      budgetRemaining: (taskState?.maxStepsPerTask || MAX_STEPS_PER_TASK) - stepIndex
    };
  }

  /**
   * Record diagnostic entry.
   * @private
   */
  function _recordDiagnostic(outcome, data) {
    if (BrowserAgent.Diagnostics) {
      BrowserAgent.Diagnostics.record('clarification', { outcome, ...data });
    }
    if (outcome === 'triggered') {
      console.warn(`[Clarification] ⚠ Escalation: ${data.reason} (${data.severity})`);
    } else if (outcome === 'suppressed') {
      console.log(`[Clarification] ↩ Suppressed: ${data.reason}`);
    } else {
      console.log(
        `[Clarification] ✓ Passed (uncertainty: ${data.uncertainty}, ` +
        `threshold: ${data.effectiveThreshold}, ` +
        `noProgress: ${data.consecutiveNoProgress}, stuck: ${data.stepsStuck})`
      );
    }
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    evaluate,
    computeUncertainty,
    // Exposed for testing
    _computeNovelty,
    _computeConsecutiveNoProgress,
    _computeStepsStuck,
    _checkRequiredInputs,
    // Constants (for test assertions)
    NO_PROGRESS_DELTA_THRESHOLD,
    STUCK_PROGRESS_THRESHOLD,
    UNCERTAINTY_THRESHOLD,
    BUDGET_SHAPING_THRESHOLD,
    MAX_STEPS_PER_TASK
  };
})();
