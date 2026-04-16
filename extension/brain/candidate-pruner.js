/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Candidate Pruner — 5-Stage DOM Reduction Pipeline
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Lives in: content script (Isolated World)
 * Purpose:  Reduces the full DOMRecon element list (500+) down to 30-50
 *           high-quality, affordant candidate nodes for the decision engine.
 * 
 * Pipeline:
 *   Stage 1 — Visibility/Size Filter:   Remove invisible + tiny elements
 *   Stage 2 — Affordance Gate:          Remove decorative + disabled via NodeClassifier
 *   Stage 3 — Tiered Navigation Penalty: Score reduction for nav/footer regions
 *   Stage 4 — Diversity-Aware Selection: Top 50 with minimum type reservations
 *   Stage 5 — Node Signature:           Attach stable hash for Command Center tracking
 * 
 * Performance constraint:
 *   This module operates on pre-computed data from dom-recon.js (affordance flags
 *   like hasPointerCursor and computedTabIndex are already extracted). 
 *   Zero DOM access. Zero getComputedStyle calls. Pure array manipulation.
 * 
 * Ref: Implementation Plan v2.7 §15 Phase 1A.2
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.CandidatePruner = (() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  /** Minimum element area (px²) to survive Stage 1 */
  const MIN_AREA_PX = 100;

  /** Maximum candidates to output */
  const MAX_CANDIDATES = 50;

  /** Minimum reserved slots per type (if available on page) */
  const DIVERSITY_RESERVATIONS = {
    input_field: 3,
    dynamic_trigger: 3
  };

  /** Navigation penalty multipliers by parent region (Stage 3).
   *  Lower = more penalty. Override to 1.0 if goal tokens overlap. */
  const REGION_PENALTIES = {
    footer: 0.6,
    contentinfo: 0.6,   // role="contentinfo" = footer
    aside: 0.6,
    complementary: 0.6,  // role="complementary" = aside
    header: 0.85,
    banner: 0.85,        // role="banner" = header
    nav: 0.85,
    navigation: 0.85     // role="navigation" = nav
  };

  // ─── FNV-1a Hash (same implementation as loop-detector.js) ─────────────

  /**
   * FNV-1a 32-bit hash for fast, non-cryptographic string fingerprinting.
   * @param {string} str - Input string
   * @returns {string} 8-character hex hash
   */
  function _fastHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }

  // ─── Stage 1: Visibility/Size Filter ───────────────────────────────────

  /**
   * Remove elements that are invisible or too small to be interactive.
   * @param {Object[]} nodes
   * @returns {Object[]}
   */
  function _filterVisibleAndSized(nodes) {
    return nodes.filter(node => {
      // Must be visible
      if (!node.visible) return false;
      // Must have a bounding rect
      if (!node.rect) return false;
      // Must meet minimum area threshold
      const area = node.rect.w * node.rect.h;
      if (area < MIN_AREA_PX) return false;
      return true;
    });
  }

  // ─── Stage 2: Affordance Gate ──────────────────────────────────────────

  /**
   * Remove elements classified as 'decorative' or 'disabled' by NodeClassifier.
   * Also enforces the broad affordance check for elements that lack classification.
   * 
   * @param {Object[]} nodes - Nodes with nodeType set by NodeClassifier
   * @returns {Object[]}
   */
  function _filterAffordant(nodes) {
    return nodes.filter(node => {
      // Remove classified decorative/disabled
      if (node.nodeType === 'decorative' || node.nodeType === 'disabled') {
        return false;
      }

      // For nodes that somehow bypassed classification,
      // check broad affordance as a safety net
      if (!node.nodeType) {
        const tag = node.tag || '';
        const isAffordant = 
          node.hasPointerCursor ||
          (node.computedTabIndex !== undefined && node.computedTabIndex >= 0) ||
          node.role === 'button' ||
          ['button', 'a', 'input', 'textarea', 'select'].includes(tag) ||
          (node.intent && node.intent !== 'interact');
        return isAffordant;
      }

      return true;
    });
  }

  // ─── Stage 3: Tiered Navigation Penalty ────────────────────────────────

  /**
   * Apply region-based scoring penalties and produce a scored array.
   * Returns [{node, score}] sorted descending by score.
   * 
   * @param {Object[]} nodes - Affordant nodes
   * @param {string[]} [goalTokens=[]] - Goal tokens for override detection
   * @returns {Array<{node: Object, score: number}>}
   */
  function _scoreWithNavPenalty(nodes, goalTokens = []) {
    const goalSet = new Set(goalTokens.map(t => t.toLowerCase()));

    return nodes.map(node => {
      // Base score from DOMRecon's importance heuristic
      let score = _computeBaseScore(node);

      // Apply region penalty
      if (node.parentRegion) {
        const regionKey = node.parentRegion.toLowerCase();
        const penalty = REGION_PENALTIES[regionKey];
        if (penalty !== undefined) {
          // Check goal-token overlap — override penalty to 1.0 if element
          // text contains goal tokens (e.g., a nav "Search" button when goal is "search")
          const nodeText = ((node.innerText || '') + ' ' + (node.ariaLabel || '')).toLowerCase();
          let hasGoalOverlap = false;
          if (goalSet.size > 0) {
            for (const token of goalSet) {
              if (nodeText.includes(token)) {
                hasGoalOverlap = true;
                break;
              }
            }
          }
          if (!hasGoalOverlap) {
            score *= penalty;
          }
        }
      }

      return { node, score };
    });
  }

  /**
   * Compute a base importance score for a node.
   * Similar to DOMRecon._importanceScore but adapted for pruned, classified nodes.
   * @param {Object} node
   * @returns {number}
   */
  function _computeBaseScore(node) {
    let score = 10; // baseline for surviving affordance gate

    // Text/label signals
    if (node.innerText && node.innerText.length > 1) score += 8;
    if (node.ariaLabel) score += 8;
    if (node.placeholder) score += 6;
    if (node.title) score += 4;

    // Type-based scoring
    switch (node.nodeType) {
      case 'input_field':      score += 20; break;
      case 'dynamic_trigger':  score += 18; break;
      case 'clickable_action': score += 15; break;
      case 'navigation_link':  score += 5;  break;
    }

    // Intent specificity bonus
    if (node.intent && node.intent !== 'interact') score += 6;
    if (node.intent === 'submit_form') score += 12;
    if (node.intent === 'open_settings') score += 10;
    if (node.intent === 'open_menu') score += 10;

    // ARIA state indicators (element controls something)
    if (node.ariaHaspopup) score += 12;
    if (node.ariaExpanded !== undefined) score += 8;

    // Confidence from classifier
    if (node.typeConfidence) {
      score *= (0.5 + node.typeConfidence * 0.5); // range: 0.75x to 1.0x
    }

    // Data-testid bonus (designed for automation)
    if (node.selector && node.selector.includes('data-testid')) score += 8;

    return score;
  }

  // ─── Stage 4: Diversity-Aware Selection ────────────────────────────────

  /**
   * Select top candidates with minimum type reservations.
   * 
   * Strategy:
   *   1. Reserve min N slots for each reserved type (if available)
   *   2. Fill remaining slots from highest-scored regardless of type
   *   3. Cap at MAX_CANDIDATES
   * 
   * @param {Array<{node: Object, score: number}>} scored - Score-sorted candidates
   * @returns {Object[]} Final candidate nodes (30-50)
   */
  function _selectDiverse(scored) {
    // Sort descending by score
    scored.sort((a, b) => b.score - a.score);

    const reserved = [];    // Nodes claimed by diversity reservation
    const general = [];     // All other nodes, in score order
    const reservedSet = new Set();  // Track which nodes are reserved

    // Pass 1: Fill reservation slots
    for (const [type, minCount] of Object.entries(DIVERSITY_RESERVATIONS)) {
      const ofType = scored.filter(s => s.node.nodeType === type);
      const toReserve = ofType.slice(0, minCount);
      for (const item of toReserve) {
        reserved.push(item);
        reservedSet.add(item);
      }
    }

    // Pass 2: Fill remaining with highest-scored (skip already-reserved)
    for (const item of scored) {
      if (!reservedSet.has(item)) {
        general.push(item);
      }
    }

    // Merge: reserved first, then general, cap at MAX_CANDIDATES
    const merged = [...reserved, ...general].slice(0, MAX_CANDIDATES);

    // Sort final output by score (so downstream consumers get best-first)
    merged.sort((a, b) => b.score - a.score);

    return merged.map(item => {
      item.node._prunerScore = Math.round(item.score * 100) / 100;
      return item.node;
    });
  }

  // ─── Stage 5: Node Signature ───────────────────────────────────────────

  /**
   * Compute stable node signatures for the Command Center.
   * Only the 30-50 survivors get signatures — raw 500+ nodes never need them.
   * 
   * Compatible with computeNodeSignature() in task-state.js for
   * cross-referencing with failure memory and loop detection.
   * 
   * @param {Object[]} nodes - Final candidate list
   * @returns {Object[]} Same nodes with `signature` field added
   */
  function _attachSignatures(nodes) {
    for (const node of nodes) {
      const tag = node.tag || 'unknown';
      const role = node.role || '';
      const text = (node.innerText || '').slice(0, 20).trim().toLowerCase();
      const selector = node.selector || '';
      node.signature = _fastHash(`${tag}|${role}|${text}|${selector}`);
    }
    return nodes;
  }

  // ─── Main Pipeline ─────────────────────────────────────────────────────

  /**
   * Run the full 5-stage pruning pipeline.
   * 
   * @param {Object[]} rawNodes - Full element list from DOMRecon.scanInteractiveElements()
   * @param {Object} [options={}] - Pipeline options
   * @param {string[]} [options.goalTokens=[]] - Goal tokens for nav penalty override
   * @returns {PruneResult}
   * 
   * @typedef {Object} PruneResult
   * @property {Object[]} candidates - 30-50 pruned, scored, signed candidate nodes
   * @property {Object} stats - Pipeline statistics
   * @property {number} stats.rawCount - Input count
   * @property {number} stats.afterVisibility - Count after Stage 1
   * @property {number} stats.afterAffordance - Count after Stage 2
   * @property {number} stats.finalCount - Output count
   * @property {Object} stats.typeCounts - Count per nodeType in final output
   */
  function prune(rawNodes, options = {}) {
    const goalTokens = options.goalTokens || [];

    // Stage 0: Classify all nodes (NodeClassifier must be loaded)
    if (BrowserAgent.NodeClassifier) {
      BrowserAgent.NodeClassifier.classifyAll(rawNodes);
    } else {
      console.warn('[CandidatePruner] NodeClassifier not loaded — skipping classification');
    }

    const rawCount = rawNodes.length;

    // Stage 1: Visibility + size
    const visible = _filterVisibleAndSized(rawNodes);
    const afterVisibility = visible.length;

    // Stage 2: Affordance gate
    const affordant = _filterAffordant(visible);
    const afterAffordance = affordant.length;

    // Stage 3: Score with nav penalty
    const scored = _scoreWithNavPenalty(affordant, goalTokens);

    // Stage 4: Diversity-aware top-N selection
    const selected = _selectDiverse(scored);

    // Stage 5: Attach signatures
    const candidates = _attachSignatures(selected);

    // Re-index
    candidates.forEach((node, i) => { node._candidateIndex = i; });

    // Compute type distribution for logging
    const typeCounts = {};
    for (const node of candidates) {
      const t = node.nodeType || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    const stats = {
      rawCount,
      afterVisibility,
      afterAffordance,
      finalCount: candidates.length,
      typeCounts
    };

    console.log(
      `[CandidatePruner] Pipeline: ${rawCount} → ${afterVisibility} (vis) → ${afterAffordance} (aff) → ${candidates.length} candidates`,
      `| Types: ${Object.entries(typeCounts).map(([t, c]) => `${t}:${c}`).join(', ')}`
    );

    return { candidates, stats };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    prune,
    // Exposed for testing
    _filterVisibleAndSized,
    _filterAffordant,
    _scoreWithNavPenalty,
    _selectDiverse,
    _attachSignatures,
    _computeBaseScore,
    _fastHash,
    MAX_CANDIDATES,
    REGION_PENALTIES,
    DIVERSITY_RESERVATIONS
  };
})();
