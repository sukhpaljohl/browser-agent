/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Action Context Features — 13 Framework-Invariant DOM Signals
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Enriches each pruned candidate node with 13 spatial, relational,
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
 *   - Phase 1B.3 adds a page-level layout model (region map + block cache)
 *     built once per cycle, consumed by per-candidate feature computation.
 *
 * Features computed per candidate (all prefixed _ac_):
 *   1.  is_primary_button        — CSS: solid bg, larger font-weight, prominent
 *   2.  distance_to_filled_input — spatial distance to nearest filled input
 *   3.  is_last_in_form          — last interactive element in its form/workflow
 *   4.  recently_enabled         — was disabled, now enabled (cross-cycle)
 *   5.  distance_to_nearest_clickable — spatial clustering density
 *   6.  is_in_form               — inside a <form> or implicit form workflow
 *   7.  relative_position_to_center — viewport salience (0=center, 1=edge)
 *   8.  is_in_nav_region         — inside nav/header/footer/sidebar (derived from page_region)
 *   9.  nav_region_goal_relevance — node text overlaps goal tokens (overrides)
 *   10. parent_card_heading      — dominant heading of containing visual block [Phase 1B.3]
 *   11. visual_salience          — composite visual prominence score [Phase 1B.3]
 *   12. page_region              — page functional zone classification [Phase 1B.3]
 *   13. block_type               — type of containing visual block [Phase 1B.3]
 *
 * Ref: Implementation Plan v2.14 §4, §15 Phase 1B.3
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

  // ─── Phase 1B.3: Visual Understanding Constants ──────────────────────────

  /** Semantic HTML tags that indicate card/block boundaries */
  const CARD_BOUNDARY_TAGS = new Set([
    'article', 'section', 'li', 'details', 'figure', 'fieldset'
  ]);

  /** ARIA roles that indicate card/block boundaries */
  const CARD_BOUNDARY_ROLES = new Set([
    'article', 'listitem', 'group', 'region', 'gridcell'
  ]);

  /** Tags where upward DOM traversal should stop (too broad to be a card) */
  const STOP_ANCESTOR_TAGS = new Set(['body', 'html']);

  /** Maximum DOM levels to traverse upward for card/region detection */
  const MAX_TRAVERSAL_DEPTH = 8;

  /** CTA keywords for visual salience keyword scoring */
  const CTA_KEYWORDS = new Set([
    'buy', 'submit', 'next', 'learn', 'sign', 'create',
    'start', 'add', 'get', 'shop', 'order', 'download',
    'continue', 'proceed', 'checkout', 'register', 'apply'
  ]);

  /** Generic alt text patterns to ignore when falling back to img alt */
  const GENERIC_ALT_PATTERNS = new Set([
    'image', 'photo', 'picture', 'icon', 'logo', 'banner',
    'product', 'item', 'thumbnail', 'placeholder', 'img'
  ]);

  // ─── Per-Cycle State ───────────────────────────────────────────────────────

  /** @type {Map<string, Element|null>} Element resolution cache (cleared per cycle) */
  let _elementCache = new Map();

  /** @type {Array<{x: number, y: number}>} Cached filled input positions */
  let _filledInputPositions = null;

  /** @type {Array<{x: number, y: number}>} Cached clickable element positions */
  let _clickablePositions = null;

  // ─── Phase 1B.3: Page-Level Cached State ──────────────────────────────────

  /** @type {Map<Element, string>} Page region classification (cleared per cycle) */
  let _pageRegions = new Map();

  /** @type {Map<Element, {heading: string|null, blockType: string|null}>} Block context cache */
  let _blockCache = new Map();

  /** @type {Map<Element, CSSStyleDeclaration>} Computed style cache (avoids redundant calls) */
  let _computedStyleCache = new Map();

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

  // ─── Cached Style Helper ──────────────────────────────────────────────────

  /**
   * Get computed style for a DOM element with per-cycle caching.
   * Avoids redundant getComputedStyle calls across features.
   * @param {Element} el
   * @returns {CSSStyleDeclaration|null}
   */
  function _getCachedStyle(el) {
    if (!el) return null;
    if (_computedStyleCache.has(el)) return _computedStyleCache.get(el);
    try {
      const style = window.getComputedStyle(el);
      _computedStyleCache.set(el, style);
      return style;
    } catch (e) {
      return null;
    }
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  Phase 1B.3: Visual Understanding — Page Layout Analysis
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build a Map of landmark DOM elements to their region type.
   * Called once per cycle at the start of computeAll().
   *
   * Detects: header, nav, main, footer, sidebar, modal
   * Sources: semantic HTML tags + ARIA landmark roles + modal attributes
   *
   * @returns {Map<Element, string>}
   */
  function _classifyPageRegions() {
    const regions = new Map();

    // Semantic HTML landmarks
    const tagToRegion = {
      header: 'header', nav: 'nav', main: 'main',
      footer: 'footer', aside: 'sidebar'
    };
    for (const [tag, type] of Object.entries(tagToRegion)) {
      try {
        document.querySelectorAll(tag).forEach(el => regions.set(el, type));
      } catch (e) { /* ignore */ }
    }

    // ARIA landmark roles
    const roleToRegion = {
      banner: 'header', navigation: 'nav', main: 'main',
      contentinfo: 'footer', complementary: 'sidebar',
      dialog: 'modal'
    };
    for (const [role, type] of Object.entries(roleToRegion)) {
      try {
        document.querySelectorAll(`[role="${role}"]`).forEach(el => {
          if (!regions.has(el)) regions.set(el, type);
        });
      } catch (e) { /* ignore */ }
    }

    // Modal detection
    try {
      document.querySelectorAll('[aria-modal="true"], dialog[open]').forEach(el => {
        if (!regions.has(el)) regions.set(el, 'modal');
      });
    } catch (e) { /* ignore */ }

    return regions;
  }

  // ─── Card/Block Boundary Detection ─────────────────────────────────────────

  /**
   * Check if a DOM node is a card/block boundary.
   * Checks semantic tags, ARIA roles, and styled div indicators.
   *
   * @param {Element} node - DOM element to check
   * @param {string} tag - Lowercase tag name
   * @returns {boolean}
   */
  function _isCardBoundary(node, tag) {
    // Check semantic boundary tags
    if (CARD_BOUNDARY_TAGS.has(tag)) return true;

    // Check ARIA role boundaries
    try {
      const role = (node.getAttribute('role') || '').toLowerCase();
      if (role && CARD_BOUNDARY_ROLES.has(role)) return true;
    } catch (e) { /* ignore */ }

    // Check styled card boundaries for generic divs
    if (tag === 'div') {
      return _isStyledCardBoundary(node);
    }

    return false;
  }

  /**
   * Check if a generic <div> functions as a visual card container
   * based on CSS properties.
   *
   * A div is a card boundary if ANY of:
   *   (a) Has visual separation (border OR box-shadow) AND padding ≥ 12px
   *   (b) Is a direct child of a flex/grid container AND contains BOTH
   *       a heading element AND an interactive element
   *   (c) Has border-radius > 0 AND a background color distinct from its parent
   *
   * @param {Element} node - A <div> element
   * @returns {boolean}
   */
  function _isStyledCardBoundary(node) {
    const style = _getCachedStyle(node);
    if (!style) return false;

    try {
      // Visual separation indicators
      const hasBorder = style.borderStyle !== 'none' &&
                        parseFloat(style.borderWidth) > 0;
      const hasBoxShadow = style.boxShadow && style.boxShadow !== 'none';
      const hasBorderRadius = parseFloat(style.borderRadius) > 0;
      const paddingTop = parseFloat(style.paddingTop) || 0;
      const paddingBottom = parseFloat(style.paddingBottom) || 0;
      const hasPadding = paddingTop >= 12 || paddingBottom >= 12;

      // Rule (a): Visual separation + meaningful padding
      if ((hasBorder || hasBoxShadow) && hasPadding) return true;

      // Rule (c): Border radius + distinct background from parent
      if (hasBorderRadius && hasPadding) {
        const bg = style.backgroundColor || '';
        const parentStyle = node.parentElement ? _getCachedStyle(node.parentElement) : null;
        const parentBg = parentStyle ? (parentStyle.backgroundColor || '') : '';
        if (bg !== parentBg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          return true;
        }
      }

      // Rule (b): Flex/grid child with heading + interactive content
      const parent = node.parentElement;
      if (parent) {
        const parentStyle = _getCachedStyle(parent);
        if (parentStyle) {
          const display = parentStyle.display || '';
          const isFlexGridItem = display.includes('flex') || display.includes('grid');

          if (isFlexGridItem) {
            const hasHeading = node.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
            const hasInteractive = node.querySelector('a, button, [role="button"], [role="link"]');
            if (hasHeading && hasInteractive) return true;
          }
        }
      }

      return false;
    } catch (e) {
      return false;
    }
  }

  // ─── Heading Extraction ───────────────────────────────────────────────────

  /**
   * Extract the dominant heading text from a card container.
   * Uses a tiered strategy: visible headings first, then hidden metadata fallback.
   *
   * Tier order (higher tiers ONLY tried if all lower tiers found nothing):
   *   1. Visible h1-h6 / [role="heading"] — largest font-size wins
   *   2. Visible bold/prominent direct children (font-weight ≥ 600 or font-size ≥ 18px)
   *   3. aria-label on the card container itself (fallback — no visible heading exists)
   *   4. alt text on first prominent <img> inside container (last resort)
   *   5. null (no heading source available)
   *
   * Safety rule: hidden data (tiers 3-4) is only used when visible text is ABSENT.
   * It can never contradict or override visible headings.
   *
   * @param {Element} container - Card boundary element
   * @param {Object} candidate - The candidate we're finding context for
   * @returns {string|null}
   */
  function _extractDominantHeading(container, candidate) {
    const candidateTextLower = (candidate.innerText || '').trim().toLowerCase();

    // ── Strategy 1: Explicit heading elements (highest trust) ──
    let bestHeading = null;
    let bestFontSize = 0;

    try {
      const headings = container.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]');
      for (const h of headings) {
        const text = (h.innerText || h.textContent || '').trim();
        if (!text || text.length < 2 || text.length > 120) continue;

        // Skip self-referential headings
        if (text.toLowerCase() === candidateTextLower) continue;

        // Use font-size as primary ranking — larger headings are more dominant
        const hStyle = _getCachedStyle(h);
        const fs = hStyle ? (parseFloat(hStyle.fontSize) || 0) : 0;

        if (fs > bestFontSize || !bestHeading) {
          bestFontSize = fs;
          bestHeading = text;
        }
      }
    } catch (e) { /* ignore */ }

    if (bestHeading) return bestHeading.substring(0, 100);

    // ── Strategy 2: Bold/prominent direct children (high trust) ──
    try {
      for (const child of container.children) {
        const childTag = (child.tagName || '').toLowerCase();
        // Skip interactive and structural elements — they're not headings
        if (['a', 'button', 'input', 'select', 'textarea', 'nav', 'form',
             'ul', 'ol', 'table', 'img', 'svg', 'picture', 'video'].includes(childTag)) continue;

        const childStyle = _getCachedStyle(child);
        if (!childStyle) continue;

        const fontWeight = parseInt(childStyle.fontWeight, 10) || 400;
        const fontSize = parseFloat(childStyle.fontSize) || 0;

        if (fontWeight >= 600 || fontSize >= 18) {
          const text = (child.innerText || '').trim();
          if (text && text.length >= 2 && text.length <= 100 &&
              text.toLowerCase() !== candidateTextLower) {
            return text.substring(0, 100);
          }
        }
      }
    } catch (e) { /* ignore */ }

    // ── Strategy 3: aria-label on container (medium trust — fallback only) ──
    try {
      const ariaLabel = (container.getAttribute('aria-label') || '').trim();
      if (ariaLabel && ariaLabel.length >= 2 && ariaLabel.length <= 100 &&
          ariaLabel.toLowerCase() !== candidateTextLower) {
        return ariaLabel.substring(0, 100);
      }
    } catch (e) { /* ignore */ }

    // ── Strategy 4: img alt text (low trust — last resort) ──
    try {
      const imgs = container.querySelectorAll('img[alt]');
      for (const img of imgs) {
        const alt = (img.getAttribute('alt') || '').trim();
        if (!alt || alt.length < 4 || alt.length > 100) continue;

        // Skip generic/useless alt text
        const altLower = alt.toLowerCase();
        if (GENERIC_ALT_PATTERNS.has(altLower)) continue;
        // Skip filename-like alt text
        if (/\.\w{2,4}$/.test(altLower)) continue;

        if (altLower !== candidateTextLower) {
          return alt.substring(0, 100);
        }
      }
    } catch (e) { /* ignore */ }

    // ── Strategy 5: No heading found ──
    return null;
  }

  // ─── Block Type Classification ────────────────────────────────────────────

  /**
   * Classify the type of a visual block based on its structure and content.
   *
   * Types: card, form, hero, section, list-item
   *
   * @param {Element} node - Card boundary element
   * @param {string} tag - Lowercase tag name
   * @returns {string}
   */
  function _classifyBlockType(node, tag) {
    // List item detection
    if (tag === 'li') return 'list-item';
    try {
      if (node.getAttribute('role') === 'listitem') return 'list-item';
    } catch (e) { /* ignore */ }

    // Form detection: explicit <form> or 2+ inputs + button
    try {
      if (node.querySelector('form')) return 'form';

      const inputs = node.querySelectorAll(
        'input:not([type="hidden"]), textarea, select, ' +
        '[role="textbox"], [role="searchbox"]'
      );
      if (inputs.length >= 2) {
        const hasButton = node.querySelector(
          'button, [role="button"], input[type="submit"]'
        );
        if (hasButton) return 'form';
      }
    } catch (e) { /* ignore */ }

    // Hero detection: large area, near top, has heading + CTA
    try {
      const rect = node.getBoundingClientRect();
      const vw = window.innerWidth || 1920;
      const vh = window.innerHeight || 1080;
      const areaRatio = (rect.width * rect.height) / (vw * vh);

      if (areaRatio > 0.4 && rect.top < vh * 0.3) {
        const hasHeading = node.querySelector('h1, h2, [role="heading"]');
        const hasCTA = node.querySelector('a, button, [role="button"]');
        if (hasHeading && hasCTA) return 'hero';
      }
    } catch (e) { /* ignore */ }

    // Section detection
    if (tag === 'section') return 'section';

    // Card-like: article, figure, or structured container with heading + interactive
    if (tag === 'article' || tag === 'figure') return 'card';

    try {
      const hasHeading = node.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
      const hasInteractive = node.querySelector('a, button, [role="button"]');
      if (hasHeading && hasInteractive) return 'card';
    } catch (e) { /* ignore */ }

    return 'section'; // generic fallback for detected boundaries
  }

  // ─── Unified Visual Context Traversal ─────────────────────────────────────

  /**
   * Unified upward DOM traversal — the core Phase 1B.3 algorithm.
   * Produces BOTH block context AND region classification in a single walk.
   *
   * Walks up from the candidate element, checking each ancestor for:
   *   1. Region membership (from _pageRegions map built at cycle start)
   *   2. Card/block boundaries (semantic tags, ARIA roles, styled divs)
   *
   * No stop rule for nav regions — menus deserve spatial context too.
   * Only stops at <body>/<html> or when both block + region are found.
   *
   * @param {Object} candidate - Candidate node
   * @param {Element} el - Resolved DOM element
   * @returns {{ heading: string|null, blockType: string|null, pageRegion: string }}
   */
  function _getVisualContext(candidate, el) {
    if (!el) return { heading: null, blockType: null, pageRegion: 'unknown' };

    let node = el.parentElement;
    let depth = 0;
    let pageRegion = 'unknown';
    let foundBlock = null;

    while (node && depth < MAX_TRAVERSAL_DEPTH) {
      const tag = (node.tagName || '').toLowerCase();

      // Stop at document root — too broad
      if (STOP_ANCESTOR_TAGS.has(tag)) break;

      // Check region classification (always, even after finding a block)
      if (pageRegion === 'unknown' && _pageRegions.has(node)) {
        pageRegion = _pageRegions.get(node);
      }

      // Check card boundary (only if no block found yet)
      if (!foundBlock) {
        // Check block cache first (shared containers analyzed once)
        if (_blockCache.has(node)) {
          foundBlock = _blockCache.get(node);
        } else if (_isCardBoundary(node, tag)) {
          const heading = _extractDominantHeading(node, candidate);
          const blockType = _classifyBlockType(node, tag);
          foundBlock = { heading, blockType };
          _blockCache.set(node, foundBlock);
        }
      }

      // Early exit if we have both block + region
      if (foundBlock && pageRegion !== 'unknown') break;

      node = node.parentElement;
      depth++;
    }

    return {
      heading: foundBlock ? foundBlock.heading : null,
      blockType: foundBlock ? foundBlock.blockType : null,
      pageRegion
    };
  }

  // ─── Visual Salience Scoring ──────────────────────────────────────────────

  /**
   * Feature 11: Visual salience — composite score of how visually prominent
   * an element is. Combines size, position, visual weight, and keyword signals.
   *
   * Phase 2 training feature — NOT used in Phase 1 scoring decisions.
   * The GNN will learn salience-to-relevance correlations from outcome data.
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {number} 0-1 (0 = invisible, 1 = maximally prominent)
   */
  function _computeVisualSalience(candidate, el) {
    if (!el) return 0.3; // default for unresolvable elements

    const rect = candidate.rect || { x: 0, y: 0, w: 0, h: 0 };
    const vw = window.innerWidth || 1920;
    const vh = window.innerHeight || 1080;

    // ── Size score (0-1): element area relative to viewport ──
    const area = rect.w * rect.h;
    const sizeScore = Math.min(area / (vw * vh * 0.25), 1.0);

    // ── Position score (0-1): distance from viewport center, inverted ──
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const maxDist = Math.sqrt((vw / 2) ** 2 + (vh / 2) ** 2);
    const dist = Math.sqrt((cx - vw / 2) ** 2 + (cy - vh / 2) ** 2);
    const positionRaw = 1 - Math.min(dist / maxDist, 1.0);
    // Above-fold bonus
    const aboveFold = (rect.y + rect.h <= vh) ? 1.0 : 0.6;
    const positionScore = positionRaw * aboveFold;

    // ── Visual weight score (0-1): font-weight, font-size, background ──
    let weightScore = 0.3; // baseline
    const style = _getCachedStyle(el);
    if (style) {
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      const fontSize = parseFloat(style.fontSize) || 14;
      if (fontWeight >= 600) weightScore += 0.25;
      if (fontSize >= 16) weightScore += 0.15;

      // Colored (non-white, non-transparent) background
      const bg = style.backgroundColor || '';
      const rgbaMatch = bg.match(/rgba?\(\s*(\d+),\s*(\d+),\s*(\d+)/);
      if (rgbaMatch) {
        const r = parseInt(rgbaMatch[1], 10);
        const g = parseInt(rgbaMatch[2], 10);
        const b = parseInt(rgbaMatch[3], 10);
        const isColored = !(r > 240 && g > 240 && b > 240) &&
                          !(r === 0 && g === 0 && b === 0);
        if (isColored) weightScore += 0.3;
      }
      weightScore = Math.min(weightScore, 1.0);
    }

    // ── Keyword score (0 or 1): text contains CTA-like action words ──
    let keywordScore = 0;
    const text = (candidate.innerText || '').toLowerCase();
    const words = text.split(/\s+/);
    for (const word of words) {
      if (CTA_KEYWORDS.has(word)) {
        keywordScore = 1.0;
        break;
      }
    }

    // ── Composite: weighted average ──
    const salience = sizeScore * 0.25 + positionScore * 0.25 +
                     weightScore * 0.30 + keywordScore * 0.20;

    return Math.round(salience * 100) / 100;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  Original Features 1-9 (preserved, some extended for Phase 1B.3)
  // ═══════════════════════════════════════════════════════════════════════════

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
   * Feature 3: Is this the last interactive element in its form/workflow?
   * Important for identifying submit buttons.
   *
   * Phase 1B.3 extension: also checks implicit form workflows (blocks
   * classified as 'form' type that lack explicit <form> tags).
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {boolean}
   */
  function _isLastInForm(candidate, el) {
    if (!el) return false;

    try {
      // Try explicit <form> ancestor first
      let container = el.closest('form');

      // If no explicit form, check implicit form workflow from visual context
      // (requires _ac_block_type to be computed before this — enforced by computeAll order)
      if (!container && candidate._ac_block_type === 'form') {
        let node = el.parentElement;
        let depth = 0;
        while (node && depth < MAX_TRAVERSAL_DEPTH) {
          const tag = (node.tagName || '').toLowerCase();
          if (STOP_ANCESTOR_TAGS.has(tag)) break;
          if (_blockCache.has(node) && _blockCache.get(node).blockType === 'form') {
            container = node;
            break;
          }
          node = node.parentElement;
          depth++;
        }
      }

      if (!container) return false;

      // Get all interactive elements in the form/workflow container
      const interactives = container.querySelectorAll(
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
   * Feature 6: Is this element inside a form workflow?
   *
   * Phase 1B.3 extension: also detects implicit form workflows — blocks
   * classified as 'form' type (contain 2+ inputs + button) without <form> tags.
   *
   * @param {Object} candidate
   * @param {Element|null} el - Resolved DOM element
   * @returns {boolean}
   */
  function _isInForm(candidate, el) {
    if (!el) return false;
    try {
      // Explicit <form> ancestor
      if (el.closest('form')) return true;

      // Implicit form workflow: block type is 'form' (detected by _classifyBlockType)
      if (candidate._ac_block_type === 'form') return true;

      return false;
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
   * Phase 1B.3: Now primarily derived from _ac_page_region in computeAll().
   * This function is preserved for backward compatibility and as a fallback
   * when page_region is 'unknown'.
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
   * Phase 1B.3: Added prefix matching — catches "Mac" → "MacBook" so that
   * nav menu items are correctly identified as goal-relevant even when the
   * nav text is a parent category of the goal target.
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
    ).toLowerCase().trim();

    if (!nodeText) return false;

    // Original check: goal token appears in node text
    for (const token of goalTokens) {
      if (nodeText.includes(token)) return true;
    }

    // Phase 1B.3: Prefix matching — catches "Mac" → "MacBook"
    // Extract individual words from the node text (min 3 chars to avoid noise)
    const nodeWords = nodeText.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    for (const word of nodeWords) {
      for (const token of goalTokens) {
        // Node word is a meaningful prefix of a goal token
        if (token.length > word.length && token.startsWith(word)) return true;
      }
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
   * Compute all 13 action context features for each candidate.
   *
   * Phase 1B.3 changes:
   *   - Builds page region map once at cycle start (_classifyPageRegions)
   *   - Computes visual context (Features 10-13) FIRST per candidate
   *     because Features 3, 6, and 8 now depend on block_type/page_region
   *   - Feature 8 (is_in_nav_region) is derived from page_region with pruner fallback
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

    // Reset ALL per-cycle caches
    _elementCache = new Map();
    _filledInputPositions = null;
    _clickablePositions = null;
    _pageRegions = new Map();
    _blockCache = new Map();
    _computedStyleCache = new Map();

    // ── Phase 1B.3: Build page region map (once per cycle) ──
    _pageRegions = _classifyPageRegions();

    const stats = {
      total: candidates.length,
      domResolved: 0,
      domMissing: 0,
      primaryButtons: 0,
      inForm: 0,
      inNavRegion: 0,
      recentlyEnabled: 0,
      hasFilledInputs: _getFilledInputPositions().length > 0,
      // Phase 1B.3 stats
      withCardHeading: 0,
      regionCounts: {},
      blockTypeCounts: {}
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

      // ══════════════════════════════════════════════════════════════════
      //  Phase 1B.3: Visual Context — computed FIRST (other features depend on it)
      // ══════════════════════════════════════════════════════════════════

      const visualContext = _getVisualContext(c, el);

      // Feature 10: Parent card heading
      c._ac_parent_card_heading = visualContext.heading;
      if (c._ac_parent_card_heading) stats.withCardHeading++;

      // Feature 11: Visual salience (Phase 2 training — not in Phase 1 scoring)
      c._ac_visual_salience = _computeVisualSalience(c, el);

      // Feature 12: Page region
      c._ac_page_region = visualContext.pageRegion;
      stats.regionCounts[c._ac_page_region] = (stats.regionCounts[c._ac_page_region] || 0) + 1;

      // Feature 13: Block type
      c._ac_block_type = visualContext.blockType;
      if (c._ac_block_type) {
        stats.blockTypeCounts[c._ac_block_type] = (stats.blockTypeCounts[c._ac_block_type] || 0) + 1;
      }

      // ══════════════════════════════════════════════════════════════════
      //  Original Features 1-9 (some now use visual context results)
      // ══════════════════════════════════════════════════════════════════

      // Feature 1: Primary button detection
      c._ac_is_primary_button = _isPrimaryButton(c, el);
      if (c._ac_is_primary_button) stats.primaryButtons++;

      // Feature 2: Distance to nearest filled input
      c._ac_distance_to_filled_input = _distanceToFilledInput(c);

      // Feature 3: Last interactive element in form (uses _ac_block_type for implicit workflows)
      c._ac_is_last_in_form = _isLastInForm(c, el);

      // Feature 4: Recently enabled (disabled → enabled)
      c._ac_recently_enabled = _isRecentlyEnabled(c, previousDisabled);
      if (c._ac_recently_enabled) stats.recentlyEnabled++;

      // Feature 5: Distance to nearest clickable
      c._ac_distance_to_nearest_clickable = _distanceToNearestClickable(c);

      // Feature 6: Inside a form (uses _ac_block_type for implicit workflows)
      c._ac_is_in_form = _isInForm(c, el);
      if (c._ac_is_in_form) stats.inForm++;

      // Feature 7: Position relative to viewport center
      c._ac_relative_position_to_center = _relativePositionToCenter(c);

      // Feature 8: In navigation region (derived from page_region, pruner fallback)
      if (c._ac_page_region !== 'unknown') {
        c._ac_is_in_nav_region = ['header', 'nav', 'footer', 'sidebar'].includes(c._ac_page_region);
      } else if (c.parentRegion) {
        const region = c.parentRegion.toLowerCase();
        c._ac_is_in_nav_region = NAV_REGION_TAGS.has(region) || NAV_REGION_ROLES.has(region);
      } else {
        c._ac_is_in_nav_region = _isInNavRegion(c, el);
      }
      if (c._ac_is_in_nav_region) stats.inNavRegion++;

      // Feature 9: Nav region goal relevance
      c._ac_nav_region_goal_relevance = _navRegionGoalRelevance(c, goalTokens);
    }

    // ── Logging ──
    const regionStr = Object.entries(stats.regionCounts)
      .map(([k, v]) => `${k}:${v}`).join(', ') || 'none';
    const blockStr = Object.entries(stats.blockTypeCounts)
      .map(([k, v]) => `${k}:${v}`).join(', ') || 'none';

    console.log(
      `[ActionContext] Computed 13 features for ${stats.total} candidates`,
      `| DOM: ${stats.domResolved} resolved, ${stats.domMissing} missing`,
      `| Primary: ${stats.primaryButtons}, InForm: ${stats.inForm}`,
      `| NavRegion: ${stats.inNavRegion}, RecentlyEnabled: ${stats.recentlyEnabled}`,
      `| FilledInputs: ${stats.hasFilledInputs}`,
      `| CardHeadings: ${stats.withCardHeading}`,
      `| Regions: ${regionStr}`,
      `| Blocks: ${blockStr}`
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
    // Exposed for testing — original features
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
    _normalizeDistance,
    // Exposed for testing — Phase 1B.3 Visual Understanding
    _classifyPageRegions,
    _getVisualContext,
    _isCardBoundary,
    _isStyledCardBoundary,
    _extractDominantHeading,
    _classifyBlockType,
    _computeVisualSalience,
    _getCachedStyle
  };
})();
