/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Experience Buffer — Content Script Serialization Layer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (loaded via manifest.json after universal-strategy.js)
 * Purpose:  Serialize candidates, compute uncertainty, package step records,
 *           and transmit to the Service Worker's ExperienceStore via IPC.
 *
 * Phase 1B.5 — Thin serializer. All persistence logic is in experience-store.js.
 *
 * Architecture:
 *   UniversalStrategy calls ExperienceBuffer.log() after _assembleResponse()
 *   → Serializes all candidates (strip DOM refs, normalize geometry)
 *   → Computes uncertainty metadata (entropy, margin)
 *   → Packages complete step record
 *   → Sends BRAIN_LOG_EXPERIENCE IPC to Service Worker
 *   → ExperienceStore applies quality gates and persists to IndexedDB
 *
 * Ref: Implementation Plan v4 §4, §9, §12
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var BrowserAgent = BrowserAgent || {};

(function () {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  const SCHEMA_VERSION = 1;
  const CANDIDATE_SCHEMA_VERSION = 'cs_v1';
  const PIPELINE_VERSION = '1b5_v1';

  /** Max characters for text fields in serialized candidates */
  const TEXT_TRUNCATE_LENGTH = 80;

  // ─── Entropy Function (swappable for future softmax migration) ─────────────

  /**
   * Compute Shannon entropy of a score distribution using direct normalization.
   * Parameter-free: no temperature hyperparameter needed.
   * Computed over ALL scored candidates (tail matters for uncertainty).
   *
   * @param {number[]} scores - Array of positive scores
   * @returns {number} Shannon entropy (bits), rounded to 3 decimal places
   */
  const _entropyFn = function _directNormalizationEntropy(scores) {
    if (!scores || scores.length < 2) return 0;

    const positiveScores = scores.filter(s => s > 0);
    if (positiveScores.length < 2) return 0;

    const total = positiveScores.reduce((sum, s) => sum + s, 0);
    if (total <= 0) return 0;

    let entropy = 0;
    for (const s of positiveScores) {
      const p = s / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return Math.round(entropy * 1000) / 1000;
  };

  // ─── Candidate Serialization ───────────────────────────────────────────────

  /**
   * Serialize a single candidate for the step record.
   * Strips DOM references, normalizes geometry, maps pipeline fields.
   *
   * Field mapping (from Implementation Plan v4 §12.2):
   *   20 fields KEPT for training
   *   5 fields moved to debug sub-object
   *   12 fields STRIPPED entirely
   *
   * @param {Object} candidate - Raw pipeline candidate (from DOMRecon + enrichment)
   * @param {number} index - Position in the scored array
   * @param {Object|null} viewport - { width, height }
   * @param {number} finalScore - Score from _findBestMatch
   * @returns {Object} Serialized candidate
   */
  function _serializeCandidate(candidate, index, viewport, finalScore) {
    const rect = candidate.rect || {};
    const hasRect = rect.w > 0 && rect.h > 0 && viewport;

    return {
      index,

      // ── Identity ──
      tag: candidate.tag || null,
      role: candidate.role || null,
      text: _truncate(candidate.innerText, TEXT_TRUNCATE_LENGTH),
      nodeType: candidate.nodeType || candidate._nc_type || null,
      purpose: candidate.purpose || null,
      intent: candidate.intent || null,
      intentConfidence: candidate.confidence || null,

      // ── Accessibility text (truncated for enterprise app protection) ──
      ariaLabel: _truncate(candidate.ariaLabel, TEXT_TRUNCATE_LENGTH),
      ariaExpanded: candidate.ariaExpanded ?? null,
      ariaHaspopup: candidate.ariaHaspopup || null,
      ariaSelected: candidate.ariaSelected || null,
      placeholder: _truncate(candidate.placeholder, TEXT_TRUNCATE_LENGTH),
      type: candidate.type || null,

      // ── Normalized geometry (viewport-relative, device-invariant) ──
      rectNorm: hasRect ? {
        centerXNorm: Math.round(((rect.x + rect.w / 2) / viewport.width) * 10000) / 10000,
        centerYNorm: Math.round(((rect.y + rect.h / 2) / viewport.height) * 10000) / 10000,
        widthNorm: Math.round((rect.w / viewport.width) * 10000) / 10000,
        heightNorm: Math.round((rect.h / viewport.height) * 10000) / 10000,
      } : null,

      // ── 13 framework-invariant features (primary training input) ──
      features: {
        is_primary_button: candidate._ac_is_primary_button || false,
        distance_to_filled_input: candidate._ac_distance_to_filled_input ?? -1,
        is_last_in_form: candidate._ac_is_last_in_form || false,
        recently_enabled: candidate._ac_recently_enabled || false,
        distance_to_nearest_clickable: candidate._ac_distance_to_nearest_clickable ?? -1,
        is_in_form: candidate._ac_is_in_form || false,
        relative_position_to_center: candidate._ac_relative_position_to_center ?? 0,
        is_in_nav_region: candidate._ac_is_in_nav_region || false,
        nav_region_goal_relevance: candidate._ac_nav_region_goal_relevance ?? 0,
        parent_card_heading: candidate._ac_parent_card_heading || null,
        page_region: candidate._ac_page_region || null,
        block_type: candidate._ac_block_type || null,
      },

      // ── Context enrichment (from ContextBuilder) ──
      contextFlags: {
        failurePenalty: candidate._failurePenalty ?? 1.0,
        commitmentBonus: candidate._commitmentBonus ?? 1.0,
        diversityPenalty: candidate._diversityPenalty ?? 1.0,
        visitedBefore: candidate._visitedBefore || false,
      },

      // ── Score decomposition (from _findBestMatch) ──
      scoreBreakdown: candidate._scoreBreakdown || null,
      scoreModifiers: candidate._scoreModifiers || null,
      expectedOutcome: candidate._expectedOutcome ?? 0.4,
      finalScore: finalScore || 0,

      // ── Debug-only (stripped during training export) ──
      debug: {
        selector: candidate.selector || null,
        fallbacks: candidate.fallbacks || null,
        rect: candidate.rect || null,
        href: candidate.href || null,
      },
    };
  }

  /**
   * Truncate a string safely, returning null for empty/missing values.
   * @param {string|null|undefined} str
   * @param {number} maxLen
   * @returns {string|null}
   */
  function _truncate(str, maxLen) {
    if (!str || typeof str !== 'string') return null;
    const trimmed = str.substring(0, maxLen);
    return trimmed.length > 0 ? trimmed : null;
  }

  // ─── ExperienceBuffer Class ────────────────────────────────────────────────

  class ExperienceBuffer {
    constructor() {
      /** @type {boolean} True if a log call is in-flight (prevents double-send) */
      this._logging = false;
    }

    /**
     * Log a complete decision step to the Experience Buffer.
     * Called by UniversalStrategy after _assembleResponse().
     *
     * @param {Object} data - Decision context from the pipeline
     * @param {Object[]} data.candidates - Raw pipeline candidates (from BrainExecutor._lastCandidates)
     * @param {Object[]} data.scoredMatches - Scored matches (from BrainExecutor._lastScoredMatches)
     * @param {number} data.chosenIndex - Index of the chosen candidate in scoredMatches
     * @param {string} data.actionType - "click" | "type" | "scroll" | "navigate" | "keypress"
     * @param {string} data.actionIntent - The original parsed intent
     * @param {string|null} data.typedText - Text typed (for type actions)
     * @param {Object} data.result - The assembled response from UniversalStrategy
     * @param {Object|null} data.goalCompletion - GoalCompletionEvaluator result
     * @param {Object} data.timing - { totalCycleMs, stabilizationTimeMs }
     * @param {Object} data.viewport - { width, height }
     * @param {Object} data.taskState - TaskState snapshot (from context builder)
     * @param {number} data.candidateMargin - Score gap between top-1 and top-2
     */
    async log(data) {
      if (this._logging) {
        console.warn('[ExperienceBuffer] Log already in-flight, skipping');
        return;
      }

      this._logging = true;

      try {
        const stepRecord = this._buildStepRecord(data);
        if (!stepRecord) {
          console.warn('[ExperienceBuffer] Failed to build step record, skipping');
          return;
        }

        // Send to Service Worker via IPC (fire-and-forget with error logging)
        chrome.runtime.sendMessage(
          { type: 'BRAIN_LOG_EXPERIENCE', stepRecord },
          (response) => {
            if (chrome.runtime.lastError) {
              console.warn('[ExperienceBuffer] IPC failed:', chrome.runtime.lastError.message);
              return;
            }
            if (response?.recorded) {
              console.log(`[ExperienceBuffer] ✓ Step logged [${response.priority}]`);
            } else {
              console.log(`[ExperienceBuffer] Step filtered: ${response?.reason || 'unknown'}`);
            }
          }
        );
      } catch (e) {
        console.error('[ExperienceBuffer] Log error:', e.message);
      } finally {
        this._logging = false;
      }
    }

    /**
     * Pre-register and log a decision step via Two-Phase Commit.
     *
     * Phase 1 (this method): Builds the step record and sends it to the
     * Service Worker with `preRegister: true`. The SW parks the record in
     * memory and responds immediately. This method AWAITS the acknowledgment,
     * guaranteeing the data has crossed the process boundary before
     * executeFullFlow() returns (and before sendResponse() can be called).
     *
     * Phase 2 (Service Worker): When the content script's EXECUTE_PROMPT
     * response arrives normally, the SW commits the parked record to IndexedDB
     * via the 4-gate pipeline. If the content script dies (navigation), the
     * Dead Man's Switch commits the parked record instead.
     *
     * This solves the race condition where fire-and-forget BRAIN_LOG_EXPERIENCE
     * messages were lost during navigation teardown.
     *
     * @param {Object} data - Decision context (same params as log())
     * @returns {Promise<void>} Resolves when SW acknowledges receipt
     */
    async preRegisterAndLog(data) {
      if (this._logging) {
        console.warn('[ExperienceBuffer] Log already in-flight, skipping');
        return;
      }

      this._logging = true;

      try {
        const stepRecord = this._buildStepRecord(data);
        if (!stepRecord) {
          console.warn('[ExperienceBuffer] Failed to build step record, skipping');
          return;
        }

        // Await the pre-registration IPC — guarantees data crosses process boundary
        await new Promise((resolve) => {
          chrome.runtime.sendMessage(
            { type: 'BRAIN_LOG_EXPERIENCE', stepRecord, preRegister: true },
            (response) => {
              if (chrome.runtime.lastError) {
                console.warn('[ExperienceBuffer] Pre-register IPC failed:', chrome.runtime.lastError.message);
              } else if (response?.preRegistered) {
                console.log('[ExperienceBuffer] ✓ Step pre-registered (awaiting commit)');
              } else {
                console.log('[ExperienceBuffer] Pre-register response:', response);
              }
              resolve();  // Always resolve — never block the pipeline on IPC failure
            }
          );
        });
      } catch (e) {
        console.error('[ExperienceBuffer] PreRegisterAndLog error:', e.message);
      } finally {
        this._logging = false;
      }
    }

    /**
     * Send trajectory finalization signal to the Service Worker.
     * Called by UniversalStrategy on goal completion, safety block, or budget exhaustion.
     *
     * @param {string} trajectoryId - The trajectory to finalize
     * @param {string} status - "completed" | "safety_blocked" | "budget_exhausted"
     * @param {number} terminalReward - Reward value
     */
    finalizeTrajectory(trajectoryId, status, terminalReward) {
      if (!trajectoryId) return;

      chrome.runtime.sendMessage(
        { type: 'BRAIN_FINALIZE_TRAJECTORY', trajectoryId, status, terminalReward },
        (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[ExperienceBuffer] Finalize IPC failed:', chrome.runtime.lastError.message);
            return;
          }
          if (response?.success) {
            console.log(`[ExperienceBuffer] ✓ Trajectory finalized: ${status}`);
          }
        }
      );
    }

    // ─── Step Record Builder ─────────────────────────────────────────────────

    /**
     * Build the complete step record from pipeline decision context.
     *
     * @param {Object} data - See log() params
     * @returns {Object|null} Complete step record or null on failure
     */
    _buildStepRecord(data) {
      try {
        const {
          candidates, scoredMatches, chosenIndex, actionType, actionIntent,
          typedText, result, goalCompletion, timing, viewport, taskState,
          candidateMargin,
        } = data;

        // Serialize candidates with scores
        const serializedCandidates = this._serializeCandidates(
          candidates, scoredMatches, viewport
        );

        if (!serializedCandidates || serializedCandidates.length === 0) {
          return null;
        }

        // Extract scores for entropy computation
        const scores = (scoredMatches || []).map(s => s.score).filter(s => s > 0);
        const scoreEntropy = _entropyFn(scores);

        // Extract behavioral signals from result
        const strategy = result?.strategy || {};
        const progress = result?.progress || strategy?.primaryAction?.progress || {};

        // Extract goal completion data
        const gc = goalCompletion || {};

        // Compute domain from current URL
        let domain = '';
        try { domain = new URL(window.location.href).hostname; } catch (e) { /* ignore */ }

        // Feature vector from goal completion evaluator
        // GCE produces featureVector as a named Object (e.g. {f_targetPresence: 0.3, ...})
        // ExperienceStore Gate 0 requires featureVector to be a plain number[] for ML training
        // featureMap preserves the named Object for interpretability and debugging
        const rawFV = gc.featureVector || null;
        const featureVector = rawFV ? Object.values(rawFV) : null;
        const featureMap = rawFV || null;
        const featureVectorVersion = rawFV ? 'gce_v1' : null;

        // Build the post-action DOM fingerprint (lightweight)
        let postActionDomFingerprint = null;
        try {
          const interactiveCount = document.querySelectorAll(
            'a, button, input, select, textarea, [role="button"], [role="link"]'
          ).length;
          postActionDomFingerprint = `ic:${interactiveCount}|url:${window.location.pathname}`;
        } catch (e) { /* ignore */ }

        const stepRecord = {
          // ═══ Identity ═══
          id: crypto.randomUUID(),
          trajectoryId: taskState?.trajectoryId || 'unknown',
          stepIndex: taskState?.step_index || 0,
          timestamp: Date.now(),

          // ═══ Versioning ═══
          schemaVersion: SCHEMA_VERSION,
          candidateSchemaVersion: CANDIDATE_SCHEMA_VERSION,
          featureVectorVersion: featureVectorVersion,
          pipelineVersion: PIPELINE_VERSION,

          // ═══ Computed Signals Availability (Option B) ═══
          computedSignals: {
            effectConfidence: false,
            decisionLatencyMs: false,
            executionLatencyMs: false,
          },

          // ═══ Context ═══
          url: window.location.href,
          domain: domain,
          goal: taskState?.goal || '',
          parsedGoal: taskState?.parsedGoal || null,
          viewport: viewport || { width: window.innerWidth, height: window.innerHeight },

          // ═══ Decision State ═══
          domFingerprint: postActionDomFingerprint,
          candidateCount: serializedCandidates.length,
          candidates: serializedCandidates,

          // ═══ Action ═══
          chosenIndex: chosenIndex ?? null,
          actionType: actionType || null,
          actionIntent: actionIntent || null,
          typedText: typedText || null,

          // ═══ Outcome ═══
          effect: progress?.effect || result?.progress?.effect || null,
          effectConfidence: null,
          progressDelta: progress?.delta ?? result?.progress?.progressDelta ?? null,
          progressAfter: progress?.score ?? result?.progress?.progress ?? null,
          reward: result?.progress?.progress ?? null,

          // ═══ Post-Action State ═══
          postActionUrl: window.location.href,
          postActionDomFingerprint: postActionDomFingerprint,

          // ═══ Goal Completion ═══
          goalCompletionScore: gc.completionScore ?? 0,
          isTerminal: gc.isTerminal || false,
          safetyBlocked: gc.safetyBlocked || false,
          featureVector: featureVector,
          featureMap: featureMap,

          // ═══ Uncertainty Metadata ═══
          uncertainty: {
            candidateMargin: candidateMargin ?? 0,
            scoreEntropy: scoreEntropy,
            ambiguityDetected: false, // Will be set by caller if clarification triggered
          },

          // ═══ Behavioral Signals ═══
          loopDetected: false,
          loopType: null,
          recoveryTriggered: strategy?.recoveryAction != null,
          recoveryAction: strategy?.recoveryAction?.reason || null,
          clarificationTriggered: false,

          // ═══ Timing ═══
          totalCycleMs: timing?.totalCycleMs ?? strategy?.strategyTime ?? null,
          stabilizationTimeMs: timing?.stabilizationTimeMs ?? null,
          decisionLatencyMs: null,
          executionLatencyMs: null,

          // ═══ Task State Snapshot ═══
          taskSnapshot: {
            stepIndex: taskState?.step_index || 0,
            milestones: taskState?.milestones || {},
            commitmentActive: taskState?.commitment?.active || false,
            pagesVisitedCount: taskState?.pages_visited?.length || 0,
            recentFailureCount: taskState?.recentFailures?.length || 0,
          },

          // ═══ Training Labels (updated on trajectory finalization) ═══
          priority: null, // Set by ExperienceStore Gate 1
          discountedReward: null, // Set by credit assignment
          humanCorrected: false,
          correctedOutcome: null,
        };

        return stepRecord;
      } catch (e) {
        console.error('[ExperienceBuffer] Build step record failed:', e.message);
        return null;
      }
    }

    /**
     * Serialize all candidates with their scores.
     *
     * @param {Object[]} rawCandidates - Pipeline candidates
     * @param {Object[]} scoredMatches - Scored matches from _findBestMatch
     * @param {Object} viewport - { width, height }
     * @returns {Object[]} Serialized candidates
     */
    _serializeCandidates(rawCandidates, scoredMatches, viewport) {
      if (!rawCandidates || rawCandidates.length === 0) return [];

      // Build a score lookup from scoredMatches
      const scoreMap = new Map();
      if (scoredMatches) {
        for (const sm of scoredMatches) {
          if (sm.candidate) {
            scoreMap.set(sm.candidate, sm.score || 0);
          }
        }
      }

      const serialized = [];
      for (let i = 0; i < rawCandidates.length; i++) {
        const c = rawCandidates[i];
        const score = scoreMap.get(c) || 0;
        serialized.push(_serializeCandidate(c, i, viewport, score));
      }

      return serialized;
    }
  }

  // ─── Export to BrowserAgent namespace ───────────────────────────────────────

  BrowserAgent.ExperienceBuffer = new ExperienceBuffer();

})();
