/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Node-Type Classifier — Heuristic Element Classification
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Lives in: content script (Isolated World)
 * Purpose:  Classifies a dom-recon element descriptor into one of 6 semantic
 *           types for the CandidatePruner's affordance gate.
 * 
 * Output types:
 *   - clickable_action:  Buttons, submit triggers, menu items, toggles
 *   - navigation_link:   Anchors, links, router triggers
 *   - input_field:       Text inputs, textareas, selects, contenteditables
 *   - dynamic_trigger:   Elements with aria-haspopup, aria-expanded, dropdowns
 *   - decorative:        Non-interactive elements that slipped through selectors
 *   - disabled:          Elements explicitly disabled or aria-disabled
 * 
 * Design:
 *   Rule-based heuristics only (no ML). Evaluates tag → role → ARIA → purpose.
 *   Includes a `semanticScore` placeholder for Phase 2+ ML classifier hookup.
 * 
 * Ref: Implementation Plan v2.7 §15 Phase 1A.2
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.NodeClassifier = (() => {
  'use strict';

  /**
   * Classify a single dom-recon element descriptor into a semantic type.
   * 
   * @param {Object} node - Element descriptor from DOMRecon._scanElement()
   * @param {string} node.tag - HTML tag name (lowercase)
   * @param {string} [node.role] - ARIA role
   * @param {string} [node.purpose] - Purpose from dom-recon (action, navigation, etc.)
   * @param {string} [node.intent] - Semantic intent from dom-recon
   * @param {boolean} [node.disabled] - Whether element is disabled
   * @param {string} [node.ariaHaspopup] - aria-haspopup value
   * @param {string} [node.ariaExpanded] - aria-expanded value
   * @param {string} [node.type] - input type attribute
   * @param {boolean} [node.hasPointerCursor] - cursor:pointer from computed style
   * @param {number} [node.computedTabIndex] - tabIndex from element
   * @returns {ClassificationResult}
   * 
   * @typedef {Object} ClassificationResult
   * @property {string} nodeType - One of: clickable_action, navigation_link, input_field,
   *                               dynamic_trigger, decorative, disabled
   * @property {number} typeConfidence - 0.0–1.0 confidence in classification
   * @property {null} semanticScore - Reserved for Phase 2+ ML classifier
   */
  function classify(node) {
    // ── Disabled gate (checked first — overrides everything) ──
    if (node.disabled) {
      return { nodeType: 'disabled', typeConfidence: 1.0, semanticScore: null };
    }

    const tag = node.tag || '';
    const role = node.role || '';
    const purpose = node.purpose || 'unknown';
    const intent = node.intent || '';
    const ariaHaspopup = node.ariaHaspopup || '';
    const hasExpanded = node.ariaExpanded !== undefined;

    // ── Dynamic triggers (high priority — control UI state changes) ──
    // Must be checked before clickable_action because triggers ARE clickable,
    // but carry additional semantic weight (they reveal hidden UI).
    if (ariaHaspopup === 'menu' || ariaHaspopup === 'true' || 
        ariaHaspopup === 'dialog' || ariaHaspopup === 'listbox') {
      return { nodeType: 'dynamic_trigger', typeConfidence: 0.95, semanticScore: null };
    }
    if (hasExpanded) {
      return { nodeType: 'dynamic_trigger', typeConfidence: 0.90, semanticScore: null };
    }
    if (role === 'combobox' || role === 'searchbox') {
      return { nodeType: 'dynamic_trigger', typeConfidence: 0.85, semanticScore: null };
    }
    if (purpose === 'dropdown') {
      return { nodeType: 'dynamic_trigger', typeConfidence: 0.80, semanticScore: null };
    }
    // Intent-based dynamic detection (e.g., "open_menu", "open_dialog")
    if (intent === 'open_menu' || intent === 'open_dialog' || 
        intent === 'open_dropdown' || intent === 'toggle_expand') {
      return { nodeType: 'dynamic_trigger', typeConfidence: 0.80, semanticScore: null };
    }

    // ── Input fields ──
    if (purpose === 'text-input' || purpose === 'file-upload' || 
        purpose === 'search' || purpose === 'range-input') {
      return { nodeType: 'input_field', typeConfidence: 0.95, semanticScore: null };
    }
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return { nodeType: 'input_field', typeConfidence: 0.90, semanticScore: null };
    }
    if (role === 'textbox' || role === 'slider' || role === 'spinbutton') {
      return { nodeType: 'input_field', typeConfidence: 0.90, semanticScore: null };
    }

    // ── Navigation links ──
    if (tag === 'a' && purpose === 'navigation') {
      return { nodeType: 'navigation_link', typeConfidence: 0.90, semanticScore: null };
    }
    if (tag === 'a') {
      return { nodeType: 'navigation_link', typeConfidence: 0.75, semanticScore: null };
    }
    if (intent === 'navigate') {
      return { nodeType: 'navigation_link', typeConfidence: 0.70, semanticScore: null };
    }

    // ── Clickable actions ──
    if (tag === 'button' || role === 'button') {
      return { nodeType: 'clickable_action', typeConfidence: 0.90, semanticScore: null };
    }
    if (purpose === 'action' || purpose === 'tab' || purpose === 'menu-item' || purpose === 'toggle') {
      return { nodeType: 'clickable_action', typeConfidence: 0.85, semanticScore: null };
    }
    if (role === 'tab' || role === 'radio' || role === 'checkbox' || role === 'switch') {
      return { nodeType: 'clickable_action', typeConfidence: 0.85, semanticScore: null };
    }
    if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') {
      return { nodeType: 'clickable_action', typeConfidence: 0.85, semanticScore: null };
    }
    // Intent-driven clickable (e.g., "submit_form", "save", "delete")
    if (intent && intent !== 'interact' && intent !== 'navigate') {
      return { nodeType: 'clickable_action', typeConfidence: 0.70, semanticScore: null };
    }

    // ── Affordance-only detection (no tag/role, but has cursor:pointer or tabIndex) ──
    // This catches modern framework div-buttons (React/Vue) that lack semantic markup.
    if (node.hasPointerCursor || (node.computedTabIndex !== undefined && node.computedTabIndex >= 0)) {
      return { nodeType: 'clickable_action', typeConfidence: 0.50, semanticScore: null };
    }

    // ── Decorative fallback ──
    // If nothing matched, this element is likely decorative/structural — a div or span
    // that happened to have a data-testid or onclick but no real interactive purpose.
    return { nodeType: 'decorative', typeConfidence: 0.60, semanticScore: null };
  }

  /**
   * Batch-classify an array of dom-recon element descriptors.
   * Mutates nodes in-place by adding nodeType, typeConfidence, and semanticScore.
   * 
   * @param {Object[]} nodes - Array of element descriptors from DOMRecon
   * @returns {Object[]} Same array with classification fields added
   */
  function classifyAll(nodes) {
    for (const node of nodes) {
      const result = classify(node);
      node.nodeType = result.nodeType;
      node.typeConfidence = result.typeConfidence;
      node.semanticScore = result.semanticScore;
    }
    return nodes;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    classify,
    classifyAll
  };
})();
