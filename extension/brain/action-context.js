/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Action Context Features — 9 Framework-Invariant DOM Signals
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Enriches each pruned candidate node with 9 spatial, relational,
 *           and visual features that resolve intent ambiguity. These features
 *           answer "which button is correct RIGHT NOW?" — not just "which
 *           element looks like a button."
 *
 * Architecture:
 *   - Pure feature extractor. No policy logic. No value estimation.
 *   - All features are framework-invariant: they depend on spatial position,
 *     CSS styling, and DOM structure — NOT on class names or component trees.
 *   - Runs AFTER CandidatePruner (scored nodes) and AFTER ContextBuilder
 *     (task state enrichment). Runs BEFORE BrainExecutor's decision logic.
 *   - Uses lazy DOM resolution with per-cycle caching to minimize DOM access.
 *
 * Features computed per candidate (all prefixed _ac_):
 *   1. is_primary_button      — CSS: solid bg, larger font-weight, prominent
 *   2. distance_to_filled_input — spatial distance to nearest filled input
 *   3. is_last_in_form        — last interactive element in its <form>
 *   4. recently_enabled       — was disabled, now enabled (cross-cycle)
 *   5. distance_to_nearest_clickable — spatial clustering density
 *   6. is_in_form             — inside a <form> ancestor
 *   7. relative_position_to_center — viewport salience (0=center, 1=edge)
 *   8. is_in_nav_region       — inside <nav>/<header>/<footer>/<aside>
 *   9. nav_region_goal_relevance — node text overlaps goal tokens (overrides)
 *
 * Ref: Implementation Plan v2.8 §4, §15 Phase 1A.3c
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.ActionContext = (() => {
  'use strict';

  // ─── Constants ─────────────────────────────────────────────────────────────

  /** Tags considered "nav region" ancestors */
  const NAV_REGION_TAGS = new Set(['nav', 'header', 'footer', 'aside']);

  /** ARIA roles that map to nav region semantics */
  const NAV_REGION_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary'
  ]);

  /** CSS background colors that indicate a primary/CTA button */
  const PRIMARY_BG_PATTERNS = [
    // Avoid transparent/white/very light backgrounds
    (r, g, b, a) => a > 0.5 && !(r > 240 && g > 240 && b > 240),
  ];

  /** Maximum elements to scan for filled inputs (performance bound) */
  const MAX_INPUT_SCAN = 50;

  /** Maximum candidates to process (should always match pruner MAX_CANDIDATES) */
  const MAX_CANDIDATES = 50;

  // ─── Per-Cycle State ───────────────────────────────────────────────────────

  /** @type {Map<string, Element|null>} Element resolution cache (cleared per cycle) */
  let _elementCache = new Map();

  /** @type {Array<{x: number, y: number}>} Cached filled input positions */
  let _filledInputPositions = null;

  /** @type {Array<{x: number, y: number}>} Cached clickable element positions */
  let _clickablePositions = null;

  // ─── DOM Element Resolution ────────────────────────────────────────────────

  /**
   * Resolve a live DOM element for a candidate node.
   * Uses a per-cycle cache to avoid repeated querySelector calls.
   *
   * @param {Object} candidate - Candidate node from pruner
   * @returns {Element|null} Live DOM element, or null if unresolvable
   */
  function _resolveElement(candidate) {
    // Use signature as cache key (stable across cycles)
    const cacheKey = candidate.signature || candidate._candidateIndex || '';

    if (_elementCache.has(cacheKey)) {
      return _elementCache.get(cacheKey);
    }

    let el = null;

    // Priority 1: Direct DOM reference (from DOMRecon or _basicScan)
    if (candidate._domElement) {
      el = candidate._domElement;
    }

    // Priority 2: Selector-based lookup
    if (!el && candidate.selector) {
      try {
        el = document.querySelector(candidate.selector);
      } catch (e) { /* invalid selector — skip */ }
    }

    // Priority 3: Text + tag search (last resort)
    if (!el && candidate.innerText && candidate.tag) {
      const text = candidate.innerText.trim();
      if (text.length > 1) {
        try {
          const all = document.querySelectorAll(candidate.tag);
          for (const node of all) {
            if ((node.textContent || '').trim().substring(0, 100) === text) {
              el = node;
              break;
            }
          }
        } catch (e) { /* ignore */ }
      }
    }

    _elementCache.set(cacheKey, el);
    return el;
  }

  // ─── Spatial Utilities ─────────────────────────────────────────────────────

  /**
   * Get the center point of a candidate's bounding rect.
   * @param {Object} candidate - Candidate with rect { x, y, w, h }
   * @returns {{ x: number, y: number }}
   */
  function _getCenter(candidate) {
    const r = candidate.rect || { x: 0, y: 0, w: 0, h: 0 };
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  /**
   * Euclidean distance between two points.
   * @returns {number}
   */
  function _distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Normalize a distance to 0-1 range using viewport diagonal.
   * @param {number} dist - Raw pixel distance
   * @returns {number} 0 (same position) to 1 (opposite corners)
   */
  function _normalizeDistance(dist) {
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;
    const diagonal = Math.sqrt(vw * vw + vh * vh);
    return Math.min(dist / diagonal, 1.0);
  }

  // ─── Page-Level Scans (Cached Per Cycle) ───────────────────────────────────

  /**
   * Find all filled input positions on the page.
   * Cached per cycle to avoid redundant DOM queries.
   * @returns {Array<{x: number, y: number}>}
   */
  function _getFilledInputPositions() {
    if (_filledInputPositions !== null) return _filledInputPositions;

    _filledInputPositions = [];
    try {
      const inputs = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), ' +
        'textarea, select, [role="textbox"], [role="searchbox"], [role="combobox"]'
      );

      let count = 0;
      for (const el of inputs) {
        if (count >= MAX_INPUT_SCAN) break;
        count++;

        // Check if the input has a value
        const hasValue = (el.value && el.value.trim().length > 0) ||
                         (el.textContent && el.textContent.trim().length > 0 &&
                          el.getAttribute('contenteditable'));

        if (hasValue) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            _filledInputPositions.push({
              x: rect.x + rect.width / 2,
              y: rect.y + rect.height / 2
            });
          }
        }
      }
    } catch (e) {
      console.warn('[ActionContext] Filled input scan error:', e.message);
    }

    return _filledInputPositions;
  }

  /**
   * Find all clickable element center positions on the page.
   * Used for distance_to_nearest_clickable computation.
   * Cached per cycle.
   * @returns {Array<{x: number, y: number}>}
   */
  function _getClickablePositions() {
    if (_clickablePositions !== null) return _clickablePositions;

    _clickablePositions = [];
    try {
      const clickables = document.querySelectorAll(
        'a, button, [role="button"], [role="link"], [role="tab"], ' +
        '[role="menuitem"], input[type="submit"], input[type="button"]'
      );

      let count = 0;
      for (const el of clickables) {
        if (count >= MAX_INPUT_SCAN) break;
        count++;

        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          _clickablePositions.push({
            x: rect.x + rect.width / 2,
            y: rect.y + rect.height / 2
          });
        }
      }
    } catch (e) {
      console.warn('[ActionContext] Clickable scan error:', e.message);
    }

    return _clickablePositions;
  }

  // ─── Individual Feature Computations ───────────────────────────────────────

  /**
   * Feature 1: Is this a primary/CTA button?
   * Checks CSS for solid background, higher font-weight, or explicit primary
   * class patterns. Framework-invariant — uses computed styles only.
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {boolean}
   */
  function _isPrimaryButton(candidate, el) {
    if (!el) return false;

    const tag = (candidate.tag || '').toLowerCase();
    const role = candidate.role || '';

    // Only check elements that could be buttons
    if (!['button', 'a', 'input'].includes(tag) &&
        !['button', 'link'].includes(role) &&
        !candidate.hasPointerCursor) {
      return false;
    }

    try {
      const style = window.getComputedStyle(el);

      // Check font-weight (primary buttons tend to be bolder)
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const isBold = fontWeight >= 600;

      // Check background — primary buttons have solid, non-transparent backgrounds
      const bg = style.backgroundColor || '';
      let hasSolidBg = false;

      // Parse rgba/rgb
      const rgbaMatch = bg.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\s*\)/);
      if (rgbaMatch) {
        const r = parseInt(rgbaMatch[1], 10);
        const g = parseInt(rgbaMatch[2], 10);
        const b = parseInt(rgbaMatch[3], 10);
        const a = rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1.0;

        // Solid = non-transparent AND not white/very-light
        hasSolidBg = a > 0.5 && !(r > 240 && g > 240 && b > 240);
      }

      // Check if element has larger size (area) compared to typical buttons
      const rect = el.getBoundingClientRect();
      const area = rect.width * rect.height;
      const isLarger = area > 2000; // ~40x50px minimum for a CTA

      // Primary = has solid bg AND (bold OR large)
      return hasSolidBg && (isBold || isLarger);
    } catch (e) {
      return false;
    }
  }

  /**
   * Feature 2: Distance to nearest filled input.
   * Normalized 0-1 (0 = on top of a filled input, 1 = far away).
   *
   * @param {Object} candidate
   * @returns {number}
   */
  function _distanceToFilledInput(candidate) {
    const filledPositions = _getFilledInputPositions();
    if (filledPositions.length === 0) return 1.0; // no filled inputs → max distance

    const center = _getCenter(candidate);
    let minDist = Infinity;
    for (const pos of filledPositions) {
      const d = _distance(center, pos);
      if (d < minDist) minDist = d;
    }

    return _normalizeDistance(minDist);
  }

  /**
   * Feature 3: Is this the last interactive element in its <form>?
   * Important for identifying submit buttons.
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {boolean}
   */
  function _isLastInForm(candidate, el) {
    if (!el) return false;

    try {
      const form = el.closest('form');
      if (!form) return false;

      // Get all interactive elements in the form
      const interactives = form.querySelectorAll(
        'input:not([type="hidden"]), button, textarea, select, ' +
        '[role="button"], [role="textbox"], [role="combobox"]'
      );

      if (interactives.length === 0) return false;

      // Check if this element is the last one
      return interactives[interactives.length - 1] === el;
    } catch (e) {
      return false;
    }
  }

  /**
   * Feature 4: Was this element recently enabled (disabled → enabled)?
   * Uses cross-cycle signature memory stored on BrainExecutor.
   *
   * @param {Object} candidate
   * @param {Set<string>|null} previousDisabledSignatures - From previous cycle
   * @returns {boolean}
   */
  function _isRecentlyEnabled(candidate, previousDisabledSignatures) {
    if (!previousDisabledSignatures || previousDisabledSignatures.size === 0) {
      return false;
    }

    // Node was in the disabled set last cycle AND is not disabled now
    const sig = candidate.signature || '';
    const wasDisabled = previousDisabledSignatures.has(sig);
    const isNowEnabled = !candidate.disabled;

    return wasDisabled && isNowEnabled;
  }

  /**
   * Feature 5: Distance to nearest other clickable element.
   * Normalized 0-1. Isolated elements (far from others) get higher values.
   *
   * @param {Object} candidate
   * @returns {number}
   */
  function _distanceToNearestClickable(candidate) {
    const positions = _getClickablePositions();
    if (positions.length <= 1) return 1.0; // only this element → max isolation

    const center = _getCenter(candidate);
    let minDist = Infinity;

    for (const pos of positions) {
      const d = _distance(center, pos);
      // Skip self (distance ≈ 0)
      if (d > 5) {
        if (d < minDist) minDist = d;
      }
    }

    return minDist === Infinity ? 1.0 : _normalizeDistance(minDist);
  }

  /**
   * Feature 6: Is this element inside a <form> ancestor?
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {boolean}
   */
  function _isInForm(candidate, el) {
    if (!el) return false;
    try {
      return el.closest('form') !== null;
    } catch (e) {
      return false;
    }
  }

  /**
   * Feature 7: Relative position to viewport center.
   * 0 = at center, 1 = at edge/corner. Primary content tends to be centered.
   *
   * @param {Object} candidate
   * @returns {number}
   */
  function _relativePositionToCenter(candidate) {
    const center = _getCenter(candidate);
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;
    const viewportCenter = { x: vw / 2, y: vh / 2 };

    // Max distance from center = half the diagonal
    const maxDist = Math.sqrt((vw / 2) ** 2 + (vh / 2) ** 2);
    const dist = _distance(center, viewportCenter);

    return Math.min(dist / maxDist, 1.0);
  }

  /**
   * Feature 8: Is this element inside a navigation region?
   * Checks for <nav>, <header>, <footer>, <aside> ancestors
   * and matching ARIA roles.
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {boolean}
   */
  function _isInNavRegion(candidate, el) {
    // Fast path: pruner already set parentRegion
    if (candidate.parentRegion) {
      const region = candidate.parentRegion.toLowerCase();
      if (NAV_REGION_TAGS.has(region) || NAV_REGION_ROLES.has(region)) {
        return true;
      }
    }

    // Fallback: traverse ancestors if we have the DOM element
    if (!el) return false;
    try {
      let node = el.parentElement;
      let depth = 0;
      while (node && depth < 10) {
        const tag = (node.tagName || '').toLowerCase();
        if (NAV_REGION_TAGS.has(tag)) return true;
        const role = (node.getAttribute('role') || '').toLowerCase();
        if (NAV_REGION_ROLES.has(role)) return true;
        node = node.parentElement;
        depth++;
      }
    } catch (e) { /* ignore */ }

    return false;
  }

  /**
   * Feature 9: Does this nav-region element's text overlap with goal tokens?
   * Only meaningful when is_in_nav_region is true.
   *
   * @param {Object} candidate
   * @param {string[]} goalTokens
   * @returns {boolean}
   */
  function _navRegionGoalRelevance(candidate, goalTokens) {
    if (!goalTokens || goalTokens.length === 0) return false;

    const nodeText = (
      (candidate.innerText || '') + ' ' +
      (candidate.ariaLabel || '') + ' ' +
      (candidate.placeholder || '')
    ).toLowerCase();

    for (const token of goalTokens) {
      if (nodeText.includes(token)) return true;
    }

    return false;
  }

  // ─── Current Disabled Elements Snapshot ────────────────────────────────────

  /**
   * Capture the current set of disabled element signatures.
   * Called by BrainExecutor AFTER each action cycle to store for the next cycle.
   *
   * @param {Object[]} candidates - Current cycle's candidates
   * @returns {Set<string>} Signatures of currently disabled elements
   */
  function captureDisabledSignatures(candidates) {
    const disabled = new Set();
    for (const c of candidates) {
      if (c.disabled) {
        const sig = c.signature || '';
        if (sig) disabled.add(sig);
      }
    }
    return disabled;
  }

  // ─── Main Entry Point ─────────────────────────────────────────────────────

  /**
   * Compute all 9 action context features for each candidate.
   *
   * @param {Object[]} candidates - Pruned, context-enriched candidate nodes
   * @param {Object} [options={}]
   * @param {string[]} [options.goalTokens=[]] - Goal tokens for relevance checks
   * @param {Set<string>|null} [options.previousDisabledSignatures=null] - From previous cycle
   * @returns {Object} { candidates, stats }
   */
  function computeAll(candidates, options = {}) {
    const goalTokens = options.goalTokens || [];
    const previousDisabled = options.previousDisabledSignatures || null;

    // Reset per-cycle caches
    _elementCache = new Map();
    _filledInputPositions = null;
    _clickablePositions = null;

    const stats = {
      total: candidates.length,
      domResolved: 0,
      domMissing: 0,
      primaryButtons: 0,
      inForm: 0,
      inNavRegion: 0,
      recentlyEnabled: 0,
      hasFilledInputs: _getFilledInputPositions().length > 0
    };

    for (const c of candidates) {
      // Resolve DOM element (cached)
      const el = _resolveElement(c);

      // Track resolution success
      if (el) {
        stats.domResolved++;
        c._ac_dom_missing = false;
      } else {
        stats.domMissing++;
        c._ac_dom_missing = true;
      }

      // Feature 1: Primary button detection
      c._ac_is_primary_button = _isPrimaryButton(c, el);
      if (c._ac_is_primary_button) stats.primaryButtons++;

      // Feature 2: Distance to nearest filled input
      c._ac_distance_to_filled_input = _distanceToFilledInput(c);

      // Feature 3: Last interactive element in form
      c._ac_is_last_in_form = _isLastInForm(c, el);

      // Feature 4: Recently enabled (disabled → enabled)
      c._ac_recently_enabled = _isRecentlyEnabled(c, previousDisabled);
      if (c._ac_recently_enabled) stats.recentlyEnabled++;

      // Feature 5: Distance to nearest clickable
      c._ac_distance_to_nearest_clickable = _distanceToNearestClickable(c);

      // Feature 6: Inside a form
      c._ac_is_in_form = _isInForm(c, el);
      if (c._ac_is_in_form) stats.inForm++;

      // Feature 7: Position relative to viewport center
      c._ac_relative_position_to_center = _relativePositionToCenter(c);

      // Feature 8: In navigation region
      c._ac_is_in_nav_region = _isInNavRegion(c, el);
      if (c._ac_is_in_nav_region) stats.inNavRegion++;

      // Feature 9: Nav region goal relevance
      c._ac_nav_region_goal_relevance = _navRegionGoalRelevance(c, goalTokens);
    }

    console.log(
      `[ActionContext] Computed 9 features for ${stats.total} candidates`,
      `| DOM: ${stats.domResolved} resolved, ${stats.domMissing} missing`,
      `| Primary: ${stats.primaryButtons}, InForm: ${stats.inForm}`,
      `| NavRegion: ${stats.inNavRegion}, RecentlyEnabled: ${stats.recentlyEnabled}`,
      `| FilledInputs: ${stats.hasFilledInputs}`
    );

    // Record to diagnostics
    if (BrowserAgent.Diagnostics) {
      BrowserAgent.Diagnostics.record('action_context', stats);
    }

    return { candidates, stats };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    computeAll,
    captureDisabledSignatures,
    // Exposed for testing
    _resolveElement,
    _isPrimaryButton,
    _distanceToFilledInput,
    _isLastInForm,
    _isRecentlyEnabled,
    _distanceToNearestClickable,
    _isInForm,
    _relativePositionToCenter,
    _isInNavRegion,
    _navRegionGoalRelevance,
    _getCenter,
    _distance,
    _normalizeDistance
  };
})();
