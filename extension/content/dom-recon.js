/**
 * DOMRecon — Stealth Website Reconnaissance Scanner
 * 
 * Passively scans the DOM to extract all interactive elements, page structure,
 * framework metadata, and navigation links. Designed to be undetectable:
 *   - Runs in the content script's Isolated World (invisible to page JS)
 *   - Uses only standard DOM APIs (querySelectorAll, getBoundingClientRect)
 *   - Batched scanning with requestIdleCallback + timing jitter
 *   - No CDP, no debugger, no eval(), no external network requests
 * 
 * The output is a structured JSON "blueprint" that the AI can consume
 * to build or update automation strategies for any website.
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.DOMRecon = (() => {
  'use strict';

  const BRIDGE_URL = 'http://localhost:3847';

  // Max text length to capture per element (keeps payload small)
  const MAX_TEXT_LENGTH = 120;
  // Max elements to scan per page (safety cap)
  const MAX_ELEMENTS = 2000;
  // Max important elements to keep in final blueprint (keeps payload focussed)
  const MAX_IMPORTANT_ELEMENTS = 150;
  // Batch size for scanning (prevents long-task detection)
  const SCAN_BATCH_SIZE = 60;

  // URL patterns that are NEVER safe to navigate to during crawling
  const UNSAFE_NAV_PATTERNS = /logout|signout|log-out|sign-out|delete|remove|checkout|payment|pay|purchase|confirm|unsubscribe|deactivate|close-account|reset-password/i;

  // ─── Utility ──────────────────────────────────────────

  function _jitteredDelay(baseMs) {
    const jitter = Math.floor(Math.random() * 100);
    return new Promise(resolve => setTimeout(resolve, baseMs + jitter));
  }

  function _truncate(str, max) {
    if (!str) return '';
    const cleaned = str.replace(/\s+/g, ' ').trim();
    return cleaned.length > max ? cleaned.substring(0, max) + '…' : cleaned;
  }

  /**
   * Build a minimal, stable CSS selector for an element.
   * Returns the BEST (primary) selector string.
   * Priority: id > data-testid > unique aria-label > role > tag+class > nth-child chain
   */
  function _buildSelector(el) {
    const all = _buildSelectorWithFallbacks(el);
    return all.primary;
  }

  /**
   * Build a primary selector AND an array of fallback selectors for reliability.
   * Each strategy that produces a valid selector adds to the fallbacks.
   */
  function _buildSelectorWithFallbacks(el) {
    const selectors = [];

    // Strategy 1: ID
    if (el.id && /^[a-zA-Z]/.test(el.id)) {
      selectors.push(`#${CSS.escape(el.id)}`);
    }

    // Strategy 2: data-testid
    const testId = el.getAttribute('data-testid');
    if (testId) {
      selectors.push(`[data-testid="${CSS.escape(testId)}"]`);
    }

    // Strategy 3: Unique aria-label
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) {
      const tag = el.tagName.toLowerCase();
      try {
        const matches = document.querySelectorAll(`${tag}[aria-label="${CSS.escape(ariaLabel)}"]`);
        if (matches.length === 1) {
          selectors.push(`${tag}[aria-label="${CSS.escape(ariaLabel)}"]`);
        }
      } catch (e) { /* skip */ }
    }

    // Strategy 4: role (unique or role + nth-of-type)
    const role = el.getAttribute('role');
    if (role) {
      try {
        const sameRoleEls = document.querySelectorAll(`[role="${role}"]`);
        if (sameRoleEls.length === 1) {
          selectors.push(`[role="${role}"]`);
        } else {
          const tag = el.tagName.toLowerCase();
          const parent = el.parentElement;
          if (parent) {
            const sameTagSiblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            const idx = sameTagSiblings.indexOf(el);
            const candidate = `${parent.tagName.toLowerCase()} > ${tag}:nth-of-type(${idx + 1})`;
            try {
              if (document.querySelectorAll(candidate).length === 1) selectors.push(candidate);
            } catch (e) { /* skip */ }
          }
        }
      } catch (e) { /* skip */ }
    }

    // Strategy 5: Tag + class combination
    const tag = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.split(/\s+/).filter(c => c.length > 0 && c.length < 40 && !/^[0-9]/.test(c));
      if (classes.length > 0) {
        const selector = `${tag}.${classes.slice(0, 3).map(c => CSS.escape(c)).join('.')}`;
        try {
          const matches = document.querySelectorAll(selector);
          if (matches.length === 1) selectors.push(selector);
        } catch (e) { /* invalid selector */ }
      }
    }

    // Strategy 6: nth-child path (last resort, but stable)
    const parts = [];
    let current = el;
    for (let depth = 0; depth < 4 && current && current !== document.body; depth++) {
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
      const idx = siblings.indexOf(current);
      if (siblings.length === 1) {
        parts.unshift(current.tagName.toLowerCase());
      } else {
        parts.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${idx + 1})`);
      }
      current = parent;
    }
    if (parts.length > 0) selectors.push(parts.join(' > '));

    // First valid selector is primary, the rest are fallbacks
    return {
      primary: selectors[0] || tag,
      fallbacks: selectors.slice(1)
    };
  }

  // ─── Intent Classification with Confidence ──────────────
  //
  // Infers the semantic "meaning" of an interactive element + confidence score.
  // Confidence is based on signal strength: aria (0.90+), text (0.70-0.85),
  // role (0.70-0.85), tag fallback (0.30-0.65).

  function _classifyIntentWithConfidence(el, purpose) {
    const text = (el.textContent || '').trim().toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const combined = text + ' ' + ariaLabel;
    const role = el.getAttribute('role');
    const hasPopup = el.getAttribute('aria-haspopup');
    const hasExpanded = el.hasAttribute('aria-expanded');
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute('type');

    // ─── Aria-attribute based (highest confidence: 0.90–0.95) ───
    if (hasPopup === 'menu' || hasPopup === 'true') return { intent: 'open_menu', confidence: 0.95 };
    if (hasPopup === 'dialog') return { intent: 'open_dialog', confidence: 0.95 };
    if (hasPopup === 'listbox') return { intent: 'open_dropdown', confidence: 0.95 };
    if (hasExpanded) return { intent: 'toggle_expand', confidence: 0.90 };

    // ─── Text-match based (confidence: 0.70–0.85) ───
    if (combined.match(/\b(send|submit|generate|create|go|run)\b/)) return { intent: 'submit_form', confidence: 0.85 };
    if (combined.match(/\b(sett|config|option|preference)\b/i)) return { intent: 'open_settings', confidence: 0.80 };
    if (combined.match(/\b(search|find|filter)\b/)) return { intent: 'search', confidence: 0.80 };
    if (combined.match(/\b(upload|attach|file|image)\b/)) return { intent: 'upload_file', confidence: 0.80 };
    if (combined.match(/\b(close|cancel|dismiss|back)\b/)) return { intent: 'dismiss', confidence: 0.80 };
    if (combined.match(/\b(copy|clipboard)\b/)) return { intent: 'copy', confidence: 0.75 };
    if (combined.match(/\b(share|export)\b/)) return { intent: 'share', confidence: 0.75 };
    if (combined.match(/\b(edit|rename|modify)\b/)) return { intent: 'edit', confidence: 0.75 };
    if (combined.match(/\b(delete|remove|trash)\b/)) return { intent: 'delete', confidence: 0.85 };
    if (combined.match(/\b(save|done|apply|confirm)\b/)) return { intent: 'save', confidence: 0.80 };
    if (combined.match(/\b(more|\.\.\.|kebab|dots)\b/)) return { intent: 'open_menu', confidence: 0.70 };
    if (combined.match(/\b(add|plus|new|\+)\b/)) return { intent: 'add_item', confidence: 0.70 };
    if (combined.match(/\b(next|previous|forward|backward|arrow)\b/)) return { intent: 'navigate', confidence: 0.70 };
    if (combined.match(/\b(play|pause|stop)\b/)) return { intent: 'media_control', confidence: 0.80 };
    if (combined.match(/\b(zoom|scale|resize)\b/)) return { intent: 'zoom', confidence: 0.75 };
    if (combined.match(/\b(undo|redo)\b/)) return { intent: 'undo_redo', confidence: 0.80 };
    if (combined.match(/\b(log.?in|sign.?in)\b/)) return { intent: 'login', confidence: 0.85 };
    if (combined.match(/\b(log.?out|sign.?out)\b/)) return { intent: 'logout', confidence: 0.90 };
    // Vertical ellipsis unicode
    if (combined.includes('\u22EE')) return { intent: 'open_menu', confidence: 0.70 };

    // ─── Role-based (confidence: 0.70–0.85) ───
    if (role === 'tab') return { intent: 'switch_tab', confidence: 0.85 };
    if (role === 'radio' || role === 'checkbox' || role === 'switch') return { intent: 'toggle_option', confidence: 0.80 };
    if (role === 'menuitem') return { intent: 'select_menu_item', confidence: 0.80 };
    if (role === 'slider' || role === 'spinbutton') return { intent: 'adjust_value', confidence: 0.80 };
    if (role === 'combobox' || role === 'searchbox') return { intent: 'open_dropdown', confidence: 0.80 };

    // ─── Tag/purpose fallbacks (confidence: 0.30–0.65) ───
    if (tag === 'a') return { intent: 'navigate', confidence: 0.60 };
    if (purpose === 'text-input') return { intent: 'type_text', confidence: 0.70 };
    if (purpose === 'file-upload') return { intent: 'upload_file', confidence: 0.85 };
    if (purpose === 'dropdown') return { intent: 'open_dropdown', confidence: 0.65 };
    if (tag === 'button' || role === 'button') return { intent: 'interact', confidence: 0.40 };

    return { intent: 'interact', confidence: 0.30 };
  }

  // Backward-compatible: returns just the intent string
  function _classifyIntent(el, purpose) {
    return _classifyIntentWithConfidence(el, purpose).intent;
  }


  // ─── Element Importance Filter ──────────────────────────
  //
  // Scores elements to keep only important ones in the blueprint.
  // Returns a numeric score — higher = more important.

  function _importanceScore(data) {
    let score = 0;

    // Not visible → zero importance
    if (!data.visible) return -1;

    // Tiny elements (icons, decorative) → low importance
    if (data.rect && (data.rect.w < 16 || data.rect.h < 16)) return 0;

    // Has meaningful text or label → boost
    if (data.innerText && data.innerText.length > 1) score += 10;
    if (data.ariaLabel) score += 10;
    if (data.placeholder) score += 8;
    if (data.title) score += 5;

    // Is clickable / interactive → boost
    if (data.purpose === 'action') score += 15;
    if (data.purpose === 'text-input') score += 20;
    if (data.purpose === 'tab') score += 18;
    if (data.purpose === 'menu-item') score += 12;
    if (data.purpose === 'toggle') score += 10;
    if (data.purpose === 'dropdown') score += 15;
    if (data.purpose === 'file-upload') score += 20;
    if (data.purpose === 'search') score += 15;
    if (data.purpose === 'navigation') score += 5;

    // Has semantic intent → boost
    if (data.intent && data.intent !== 'interact') score += 8;
    if (data.intent === 'submit_form') score += 15;
    if (data.intent === 'open_settings') score += 12;
    if (data.intent === 'open_menu') score += 12;

    // Has popup / expand behavior → high value
    if (data.ariaHaspopup) score += 15;
    if (data.ariaExpanded !== undefined) score += 10;

    // Has data-testid (designed for automation) → high value
    if (data.selector && data.selector.includes('data-testid')) score += 10;

    // Disabled → low value
    if (data.disabled) score -= 10;

    return score;
  }

  /**
   * Filters elements to keep only the most important ones.
   * Keeps all text inputs, file uploads, and key UI controls.
   * Caps at MAX_IMPORTANT_ELEMENTS.
   */
  function _filterImportantElements(elements) {
    // Score everything
    const scored = elements.map(el => ({ el, score: _importanceScore(el) }));

    // Remove invisible and tiny decorative elements
    const meaningful = scored.filter(s => s.score > 0);

    // Sort by importance
    meaningful.sort((a, b) => b.score - a.score);

    // Cap and return
    return meaningful.slice(0, MAX_IMPORTANT_ELEMENTS).map(s => s.el);
  }

  // ─── Framework Detection ─────────────────────────────

  /**
   * Extracts React component names by walking the fiber tree.
   * Returns an array of unique component display names found on the page.
   */
  function _extractReactComponentNames() {
    const names = new Set();
    const sampleEls = document.querySelectorAll('button, [role="button"], [role="tab"], [role="textbox"], [role="dialog"], [role="menu"], [contenteditable], input, textarea, [data-radix-collection-item]');
    for (const el of sampleEls) {
      try {
        const fiberKey = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        if (!fiberKey) continue;
        let fiber = el[fiberKey];
        const visited = new Set();
        let depth = 0;
        while (fiber && depth < 15) {
          if (visited.has(fiber)) break;
          visited.add(fiber);
          const type = fiber.type;
          if (type) {
            if (typeof type === 'string') {
              // Skip intrinsic HTML elements
            } else if (type.displayName) {
              names.add(type.displayName);
            } else if (type.name && type.name !== '_' && type.name.length > 1) {
              names.add(type.name);
            } else if (type.render && type.render.displayName) {
              names.add(type.render.displayName);
            }
          }
          fiber = fiber.return;
          depth++;
        }
      } catch (e) { /* skip */ }
    }
    return Array.from(names).sort();
  }

  function detectFramework() {
    const result = {
      ui: 'Unknown',
      css: [],
      editor: null,
      customElements: [],
      reactComponents: []
    };

    // Check a sample of elements for framework keys
    const sampleEls = document.querySelectorAll('body *');
    const sampleSize = Math.min(sampleEls.length, 200);
    let reactCount = 0, angularCount = 0, vueCount = 0;

    for (let i = 0; i < sampleSize; i++) {
      const el = sampleEls[Math.floor(i * sampleEls.length / sampleSize)];
      const keys = Object.keys(el);

      if (keys.some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'))) reactCount++;
      if (keys.some(k => k.startsWith('__ngContext__') || k.startsWith('__zone_symbol'))) angularCount++;
      // Vue scoped attributes are 'data-v-HASH' (e.g. data-v-7ba5bd90), NOT literal 'data-v-'
      const hasVueAttr = el.hasAttribute && Array.from(el.attributes).some(a => a.name.startsWith('data-v-'));
      if (hasVueAttr || keys.some(k => k.startsWith('__vue'))) vueCount++;
    }

    if (reactCount > angularCount && reactCount > vueCount && reactCount > 5) {
      result.ui = 'React';
      // Extract React component names from fiber tree
      try { result.reactComponents = _extractReactComponentNames(); } catch (e) {}
    }
    else if (angularCount > reactCount && angularCount > vueCount && angularCount > 5) result.ui = 'Angular';
    else if (vueCount > 3) result.ui = 'Vue';

    // Detect Angular by custom elements (e.g., model-response, input-area-v2)
    const allTags = new Set();
    document.querySelectorAll('body *').forEach(el => {
      const tag = el.tagName.toLowerCase();
      if (tag.includes('-') && !tag.startsWith('x-')) {
        allTags.add(tag);
      }
    });
    result.customElements = Array.from(allTags).sort();

    // CSS framework detection
    if (document.querySelector('[data-radix-popper-content-wrapper], [data-radix-portal], [data-radix-collection-item]')) {
      result.css.push('Radix UI');
    }
    if (document.querySelector('.MuiButton-root, .MuiPaper-root, .MuiTypography-root')) {
      result.css.push('Material UI');
    }
    // Tailwind: use strict word-boundary regex on class strings (avoids false positives
    // from classes like "background-hero" or "flexible-layout")
    {
      const twSample = Array.from(document.querySelectorAll('[class]')).slice(0, 100);
      const twRegex = /(?:^|\s)(p-\d|m-\d|px-\d|py-\d|mx-\d|my-\d|gap-\d|w-\d|h-\d|text-(?:sm|base|lg|xl|2xl|3xl)|bg-(?:gray|blue|red|green|white|black|slate|zinc)|rounded(?:-\w+)?|shadow(?:-\w+)?|flex(?:$|\s)|grid(?:$|\s)|justify-|items-)(?:$|\s)/;
      const twMatches = twSample.filter(el => {
        const cls = el.className;
        return typeof cls === 'string' && twRegex.test(cls);
      });
      if (twMatches.length > 10) result.css.push('Tailwind CSS');
    }
    if (document.querySelector('.btn, .container, .row, .col-')) {
      result.css.push('Bootstrap');
    }
    if (document.querySelector('mat-button, mat-card, mat-toolbar')) {
      result.css.push('Angular Material');
    }

    // Rich text editor detection
    if (document.querySelector('.ProseMirror')) result.editor = 'ProseMirror';
    else if (document.querySelector('.ql-editor')) result.editor = 'Quill';
    else if (document.querySelector('[data-slate-editor]')) result.editor = 'Slate';
    else if (document.querySelector('.DraftEditor-root')) result.editor = 'Draft.js';
    else if (document.querySelector('.cm-editor, .CodeMirror')) result.editor = 'CodeMirror';
    else if (document.querySelector('.tiptap, .ProseMirror')) result.editor = 'TipTap/ProseMirror';

    return result;
  }

  // ─── Interactive Element Scanner ──────────────────────

  const INTERACTIVE_SELECTORS = [
    'button', 'a[href]', 'input', 'textarea', 'select',
    '[role="button"]', '[role="tab"]', '[role="radio"]', '[role="checkbox"]',
    '[role="menuitem"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
    '[role="textbox"]', '[role="slider"]', '[role="switch"]',
    '[role="combobox"]', '[role="searchbox"]', '[role="spinbutton"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])',
    '[data-testid]',
    '[onclick]', '[onmousedown]', '[onkeydown]'
  ].join(', ');

  function _scanElement(el, index) {
    const rect = el.getBoundingClientRect();

    // Compute style ONCE — reuse for visibility, cursor, and position detection.
    // This is critical: calling getComputedStyle multiple times per element
    // during the same read phase is wasteful but safe. Calling it in a
    // separate write/read cycle (like CandidatePruner) would cause layout thrashing.
    const computedStyle = window.getComputedStyle(el);

    // Skip invisible or zero-size elements
    const isVisible = el.offsetParent !== null || 
      (computedStyle.position === 'fixed' && rect.width > 0);

    // ── Affordance flags (Phase 1A.2) ─────────────────────────────────────
    // Extracted here in the read phase so CandidatePruner is zero-cost.
    // cursor:pointer catches modern framework div-buttons (React/Vue/Angular)
    // that lack semantic tags/roles but have click handlers.
    const hasPointerCursor = computedStyle.cursor === 'pointer';
    const computedTabIndex = el.tabIndex;  // -1 if not focusable

    const tag = el.tagName.toLowerCase();
    const text = _truncate(el.textContent, MAX_TEXT_LENGTH);
    const innerText = _truncate(el.innerText, MAX_TEXT_LENGTH);

    // Determine element purpose
    let purpose = 'unknown';
    const role = el.getAttribute('role');
    const type = el.getAttribute('type');
    const ariaLabel = el.getAttribute('aria-label') || '';
    const placeholder = el.getAttribute('placeholder') || '';

    if (tag === 'button' || role === 'button') purpose = 'action';
    else if (tag === 'a') purpose = 'navigation';
    else if (tag === 'input' && ['text', 'search', 'email', 'password', 'url', 'tel', 'number'].includes(type)) purpose = 'text-input';
    else if (tag === 'input' && ['checkbox', 'radio'].includes(type)) purpose = 'toggle';
    else if (tag === 'input' && type === 'file') purpose = 'file-upload';
    else if (tag === 'textarea' || role === 'textbox' || el.getAttribute('contenteditable') === 'true') purpose = 'text-input';
    else if (tag === 'select' || role === 'combobox') purpose = 'dropdown';
    else if (role === 'tab') purpose = 'tab';
    else if (role === 'radio' || role === 'checkbox' || role === 'switch') purpose = 'toggle';
    else if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') purpose = 'menu-item';
    else if (role === 'slider' || role === 'spinbutton') purpose = 'range-input';
    else if (role === 'searchbox') purpose = 'search';

    // Classify semantic intent + confidence (e.g., {intent:"submit_form", confidence:0.85})
    const intentInfo = _classifyIntentWithConfidence(el, purpose);

    // Build selector with fallbacks
    const selectorInfo = _buildSelectorWithFallbacks(el);

    // Collect relevant data-* attributes
    const dataAttrs = {};
    for (const attr of el.attributes) {
      if (attr.name.startsWith('data-') && attr.name !== 'data-reactid') {
        dataAttrs[attr.name] = _truncate(attr.value, 60);
      }
    }

    // Framework hints (checked quickly)
    const elKeys = Object.keys(el);
    const hasReactFiber = elKeys.some(k => k.startsWith('__reactFiber$') || k.startsWith('__reactProps$'));

    // Basic hierarchy — detect which semantic container this element is inside
    let parentRegion = undefined;
    const regionEl = el.closest('header, [role="banner"], nav, [role="navigation"], main, [role="main"], aside, [role="complementary"], footer, [role="contentinfo"], [role="dialog"], [role="menu"], [role="toolbar"]');
    if (regionEl) {
      parentRegion = regionEl.getAttribute('role') || regionEl.tagName.toLowerCase();
    }

    return {
      i: index,
      tag,
      selector: selectorInfo.primary,
      fallbacks: selectorInfo.fallbacks.length > 0 ? selectorInfo.fallbacks : undefined,
      purpose,
      intent: intentInfo.intent,
      confidence: intentInfo.confidence,
      text: text !== innerText ? text : undefined,
      innerText,
      role: role || undefined,
      ariaLabel: ariaLabel || undefined,
      ariaHaspopup: el.getAttribute('aria-haspopup') || undefined,
      ariaExpanded: el.getAttribute('aria-expanded') || undefined,
      ariaSelected: el.getAttribute('aria-selected') || undefined,
      ariaDisabled: el.getAttribute('aria-disabled') || undefined,
      ariaControls: el.getAttribute('aria-controls') || undefined,
      placeholder: placeholder || undefined,
      title: el.getAttribute('title') || undefined,
      href: tag === 'a' ? el.getAttribute('href') : undefined,
      type: tag === 'input' ? type : undefined,
      disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
      readonly: el.readOnly || undefined,
      visible: isVisible,
      parentRegion,
      rect: isVisible ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height)
      } : undefined,
      data: Object.keys(dataAttrs).length > 0 ? dataAttrs : undefined,
      react: hasReactFiber || undefined,
      // ── Affordance flags (Phase 1A.2) ──
      hasPointerCursor: hasPointerCursor || undefined,
      computedTabIndex: computedTabIndex >= 0 ? computedTabIndex : undefined
    };
  }

  /**
   * Scans interactive elements with scroll scanning for lazy-loaded content.
   * Scrolls through top/middle/bottom of the page to reveal elements that
   * only render when scrolled into view (virtualized lists, infinite scroll).
   */
  async function scanInteractiveElements() {
    const seen = new Set();
    const allResults = [];

    // Helper: collect elements currently in DOM
    const collectElements = () => {
      const els = Array.from(document.querySelectorAll(INTERACTIVE_SELECTORS));
      return els.filter(el => {
        if (seen.has(el)) return false;
        seen.add(el);
        return true;
      });
    };

    // Phase 1: Scan current viewport (top)
    let batch = collectElements();
    for (const el of batch.slice(0, MAX_ELEMENTS)) {
      try {
        const data = _scanElement(el, allResults.length);
        if (data.visible || data.innerText || data.ariaLabel || data.placeholder) {
          allResults.push(data);
        }
      } catch (e) { /* skip */ }
    }

    // Phase 2: Scroll scan — middle and bottom (reveals lazy-loaded UI)
    const scrollHeight = document.documentElement.scrollHeight;
    const viewportHeight = window.innerHeight;

    // Only scroll if page is taller than viewport
    if (scrollHeight > viewportHeight * 1.5) {
      const scrollPositions = [
        Math.floor(scrollHeight * 0.5),  // middle
        Math.max(0, scrollHeight - viewportHeight)  // bottom
      ];

      for (const scrollY of scrollPositions) {
        window.scrollTo({ top: scrollY, behavior: 'instant' });
        await _jitteredDelay(400);  // Wait for lazy elements to load

        batch = collectElements();
        for (const el of batch.slice(0, MAX_ELEMENTS - allResults.length)) {
          try {
            const data = _scanElement(el, allResults.length);
            if (data.visible || data.innerText || data.ariaLabel || data.placeholder) {
              allResults.push(data);
            }
          } catch (e) { /* skip */ }
        }
      }

      // Scroll back to top
      window.scrollTo({ top: 0, behavior: 'instant' });
      await _jitteredDelay(100);
    }

    console.log(`[DOMRecon] Raw scan: ${allResults.length} elements found`);

    // Phase 3: Apply importance filter — keep only the ~150 most important
    const filtered = _filterImportantElements(allResults);
    console.log(`[DOMRecon] After importance filter: ${filtered.length} elements kept`);

    // Re-index
    filtered.forEach((el, i) => { el.i = i; });

    return filtered;
  }

  // ─── Page Structure Scanner ───────────────────────────

  function scanPageStructure() {
    const regions = [];

    // Semantic regions
    const regionSelectors = [
      { selector: 'header, [role="banner"]', role: 'header' },
      { selector: 'nav, [role="navigation"]', role: 'navigation' },
      { selector: 'main, [role="main"]', role: 'main' },
      { selector: 'aside, [role="complementary"]', role: 'sidebar' },
      { selector: 'footer, [role="contentinfo"]', role: 'footer' },
      { selector: '[role="dialog"]', role: 'dialog' },
      { selector: '[role="alertdialog"]', role: 'alert-dialog' },
      { selector: '[role="search"]', role: 'search' },
      { selector: '[role="tablist"]', role: 'tablist' },
      { selector: '[role="toolbar"]', role: 'toolbar' },
      { selector: '[role="menu"]', role: 'menu' },
      { selector: '[role="menubar"]', role: 'menubar' },
    ];

    for (const { selector, role } of regionSelectors) {
      const els = document.querySelectorAll(selector);
      for (const el of els) {
        if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10) continue;
        regions.push({
          role,
          selector: _buildSelector(el),
          rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
          text: _truncate(el.textContent, 60)
        });
      }
    }

    // Active overlays / modals
    const overlays = [];
    const overlaySelectors = '[role="dialog"], [role="presentation"], [data-radix-portal], [data-radix-popper-content-wrapper], [data-state="open"]';
    document.querySelectorAll(overlaySelectors).forEach(el => {
      const rect = el.getBoundingClientRect();
      const isVisible = el.offsetParent !== null || window.getComputedStyle(el).position === 'fixed';
      if (!isVisible || rect.width < 50) return;
      overlays.push({
        selector: _buildSelector(el),
        state: el.getAttribute('data-state') || 'visible',
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        childButtons: el.querySelectorAll('button, [role="button"]').length,
        childInputs: el.querySelectorAll('input, textarea, [contenteditable]').length
      });
    });

    return { regions, overlays };
  }

  // ─── Input Field Analyzer ─────────────────────────────

  function scanInputFields() {
    const inputs = [];
    const candidates = document.querySelectorAll(
      'input, textarea, select, [contenteditable="true"], [role="textbox"], [role="combobox"], [role="searchbox"]'
    );

    for (const el of candidates) {
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 10) continue;

      const tag = el.tagName.toLowerCase();
      let inputType = 'text';

      if (tag === 'input') inputType = el.type || 'text';
      else if (tag === 'textarea') inputType = 'textarea';
      else if (tag === 'select') inputType = 'select';
      else if (el.getAttribute('contenteditable') === 'true') inputType = 'contenteditable';

      // Detect editor type
      let editorType = null;
      if (el.classList.contains('ProseMirror')) editorType = 'ProseMirror';
      else if (el.hasAttribute('data-slate-editor')) editorType = 'Slate';
      else if (el.classList.contains('DraftEditor-editorContainer')) editorType = 'Draft.js';
      else if (el.closest('.ProseMirror')) editorType = 'ProseMirror';
      else if (el.closest('[data-slate-editor]')) editorType = 'Slate';

      const entry = {
        selector: _buildSelector(el),
        inputType,
        placeholder: el.getAttribute('placeholder') || el.getAttribute('aria-placeholder') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        role: el.getAttribute('role') || undefined,
        editorType: editorType || undefined,
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
        required: el.required || undefined,
        maxLength: el.maxLength > 0 ? el.maxLength : undefined,
        value: el.value ? _truncate(el.value, 40) : undefined,
        options: tag === 'select' ? Array.from(el.options).map(o => ({ value: o.value, text: o.text })).slice(0, 30) : undefined
      };

      inputs.push(entry);
    }

    return inputs;
  }

  // ─── Navigation Link Extractor ────────────────────────

  function extractNavigationLinks() {
    const currentOrigin = window.location.origin;
    const links = new Map(); // href -> { text, selector, isInternal, safe }

    document.querySelectorAll('a[href]').forEach(a => {
      if (a.offsetParent === null) return; // skip hidden links
      let href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

      // Resolve relative URLs
      try {
        const resolved = new URL(href, window.location.href);
        const isInternal = resolved.origin === currentOrigin;
        const cleanHref = resolved.pathname + resolved.search; // strip hash
        const key = isInternal ? cleanHref : resolved.href;

        // URL safety filter — flag dangerous links
        const isSafe = !UNSAFE_NAV_PATTERNS.test(cleanHref);

        if (!links.has(key)) {
          links.set(key, {
            href: isInternal ? cleanHref : resolved.href,
            text: _truncate(a.textContent, 60),
            isInternal,
            safe: isSafe,
            selector: _buildSelector(a)
          });
        }
      } catch (e) { /* invalid URL */ }
    });

    return Array.from(links.values());
  }

  // ─── Forms Scanner ────────────────────────────────────

  function scanForms() {
    const forms = [];
    document.querySelectorAll('form').forEach(form => {
      if (form.offsetParent === null) return;
      const fields = Array.from(form.querySelectorAll('input, textarea, select, [contenteditable]')).map(f => ({
        tag: f.tagName.toLowerCase(),
        type: f.type || undefined,
        name: f.name || undefined,
        placeholder: f.placeholder || undefined,
        ariaLabel: f.getAttribute('aria-label') || undefined,
        required: f.required || undefined
      }));

      const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');

      forms.push({
        selector: _buildSelector(form),
        action: form.action || undefined,
        method: form.method || undefined,
        fields,
        submitButton: submitBtn ? {
          text: _truncate(submitBtn.textContent, 40),
          selector: _buildSelector(submitBtn)
        } : undefined
      });
    });
    return forms;
  }

  // ─── Interaction Probing ───────────────────────────────
  //
  // After the static scan, this phase CLICKS safe elements to discover
  // what the UI does in response (menus, dialogs, tab panels, dropdowns).
  // For each probe:
  //   1. Snapshot the DOM (overlay count, visible elements, attribute states)
  //   2. Click the element with human-like native events
  //   3. Wait for UI to settle
  //   4. Snapshot again and diff
  //   5. Record: what appeared, what changed, what the element controls
  //   6. Dismiss (Escape) to reset before the next probe

  // Max number of elements to probe per page (don't be greedy)
  const MAX_PROBES = 30;

  /**
   * Words in button text/labels that indicate a destructive or navigation action.
   * We NEVER click these during probing.
   */
  const UNSAFE_KEYWORDS = [
    'delete', 'remove', 'submit', 'send', 'post', 'publish', 'confirm',
    'checkout', 'pay', 'purchase', 'buy', 'order', 'sign out', 'log out',
    'logout', 'signout', 'close account', 'deactivate', 'unsubscribe',
    'reset', 'clear all', 'erase', 'discard', 'leave', 'exit',
    'download', 'install', 'upgrade', 'subscribe'
  ];

  /**
   * Determines if an element is safe to click during probing.
   * Returns true for: menu triggers, tabs, expand/collapse, dropdowns, toggles.
   * Returns false for: links, submit, delete, navigation, form actions.
   */
  function _isSafeToProbe(el) {
    const tag = el.tagName.toLowerCase();
    const text = (el.textContent || '').trim().toLowerCase();
    const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase();
    const role = el.getAttribute('role');
    const type = el.getAttribute('type');
    const href = el.getAttribute('href');

    // NEVER probe links that navigate away
    if (tag === 'a' && href && !href.startsWith('#') && !href.startsWith('javascript:')) return false;

    // NEVER probe form submission elements
    if (tag === 'input' && (type === 'submit' || type === 'reset')) return false;
    if (tag === 'button' && type === 'submit') return false;

    // NEVER probe elements with destructive text
    const combined = text + ' ' + ariaLabel;
    if (UNSAFE_KEYWORDS.some(kw => combined.includes(kw))) return false;

    // NEVER probe disabled elements
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;

    // NEVER probe invisible/off-screen elements
    if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return false;
    if (rect.x + rect.width < 0 || rect.y + rect.height < 0) return false;
    if (rect.x > window.innerWidth || rect.y > window.innerHeight) return false;

    // PRIORITIZE known UI-control elements that reveal hidden content:
    // - aria-haspopup: definitely opens a menu/dialog/listbox
    // - aria-expanded: toggle that shows/hides content
    // - role=tab: switches tab panels
    // - role=radio / role=checkbox / role=switch: toggles
    // - role=menuitem: inside a menu, reveals sub-items
    const hasPopup = el.getAttribute('aria-haspopup');
    const hasExpanded = el.hasAttribute('aria-expanded');
    const isTab = role === 'tab';
    const isToggle = ['radio', 'checkbox', 'switch'].includes(role);
    const isMenuItem = role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio';

    // These are always safe and useful to probe
    if (hasPopup || hasExpanded || isTab || isToggle || isMenuItem) return true;

    // Regular buttons that aren't destructive — probe if they look like a UI control
    if (tag === 'button' || role === 'button') {
      // Skip very long text buttons (likely content, not UI controls)
      if (text.length > 60) return false;
      return true;
    }

    return false;
  }

  /**
   * Ranks probe candidates by how likely they are to reveal important UI structure.
   * Higher score = probe first.
   */
  function _probeScore(el) {
    let score = 0;
    if (el.getAttribute('aria-haspopup')) score += 50;        // Definitely opens something
    if (el.hasAttribute('aria-expanded')) score += 40;        // Expand/collapse trigger
    if (el.getAttribute('role') === 'tab') score += 35;       // Tab switching
    if (el.getAttribute('role') === 'combobox') score += 30;  // Dropdown
    if ((el.textContent || '').toLowerCase().includes('setting')) score += 25;
    if ((el.textContent || '').toLowerCase().includes('menu')) score += 20;
    if ((el.textContent || '').toLowerCase().includes('option')) score += 20;
    if ((el.getAttribute('aria-label') || '').toLowerCase().includes('more')) score += 15;
    if (el.getAttribute('role') === 'button') score += 5;
    // Penalize elements far down the page (less likely to be primary UI)
    const rect = el.getBoundingClientRect();
    if (rect.y > window.innerHeight * 1.5) score -= 20;
    return score;
  }

  /**
   * Takes a lightweight snapshot of floating/overlay content for diffing.
   */
  function _takeSnapshot() {
    const overlaySelectors = [
      '[role="dialog"]', '[role="menu"]', '[role="listbox"]', '[role="tooltip"]',
      '[role="alertdialog"]', '[role="presentation"]',
      '[data-radix-popper-content-wrapper]', '[data-radix-portal]',
      '[data-state="open"]', '[aria-expanded="true"]',
      '[class*="popover"]', '[class*="dropdown"]', '[class*="modal"]',
      '[class*="overlay"]', '[class*="tooltip"]'
    ];

    const snapshot = {
      overlayCount: 0,
      overlays: [],
      expandedIds: [],
      visibleMenuItems: 0,
      bodyChildCount: document.body.children.length
    };

    for (const sel of overlaySelectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const isVis = el.offsetParent !== null || window.getComputedStyle(el).position === 'fixed';
          if (!isVis) return;
          const rect = el.getBoundingClientRect();
          if (rect.width < 20 || rect.height < 20) return;
          snapshot.overlayCount++;
          snapshot.overlays.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role'),
            state: el.getAttribute('data-state'),
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            innerButtons: el.querySelectorAll('button, [role="button"], [role="menuitem"]').length,
            innerInputs: el.querySelectorAll('input, textarea, [contenteditable]').length,
            innerText: _truncate(el.innerText, 200),
            childElements: _scanOverlayChildren(el)
          });
        });
      } catch (e) { /* skip invalid selectors on this page */ }
    }

    // Track all currently expanded elements
    document.querySelectorAll('[aria-expanded="true"]').forEach(el => {
      snapshot.expandedIds.push(_buildSelector(el));
    });

    // Count visible menu items
    snapshot.visibleMenuItems = document.querySelectorAll('[role="menuitem"]:not([aria-hidden="true"])').length;

    return snapshot;
  }

  /**
   * Scans the interactive children of an overlay/dialog/menu so we know
   * what options are inside the thing that appeared.
   */
  function _scanOverlayChildren(container) {
    const children = [];
    const els = container.querySelectorAll(
      'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], ' +
      '[role="option"], [role="tab"], [role="radio"], [role="checkbox"], ' +
      'a[href], input, textarea, select, [role="textbox"]'
    );
    const seen = new Set();
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      if (children.length >= 40) break; // cap
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;
      children.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: _truncate(el.textContent, 80),
        ariaLabel: el.getAttribute('aria-label') || undefined,
        ariaSelected: el.getAttribute('aria-selected') || undefined,
        ariaChecked: el.getAttribute('aria-checked') || undefined,
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || undefined,
        selector: _buildSelector(el)
      });
    }
    return children;
  }

  /**
   * Diffs two snapshots to determine what changed after an interaction.
   */
  function _diffSnapshots(before, after) {
    const diff = {
      overlaysAppeared: [],
      overlaysDisappeared: 0,
      newExpandedElements: [],
      menuItemsDelta: after.visibleMenuItems - before.visibleMenuItems,
      bodyChildDelta: after.bodyChildCount - before.bodyChildCount
    };

    // Find new overlays (in after but not before)
    // We compare by position+size since selectors may not be stable
    const beforeKeys = new Set(before.overlays.map(o => `${o.role}:${o.rect.x},${o.rect.y}:${o.rect.w}x${o.rect.h}`));
    for (const overlay of after.overlays) {
      const key = `${overlay.role}:${overlay.rect.x},${overlay.rect.y}:${overlay.rect.w}x${overlay.rect.h}`;
      if (!beforeKeys.has(key)) {
        diff.overlaysAppeared.push(overlay);
      }
    }

    diff.overlaysDisappeared = Math.max(0, before.overlayCount - after.overlayCount);

    // New expanded elements
    const beforeExpanded = new Set(before.expandedIds);
    diff.newExpandedElements = after.expandedIds.filter(id => !beforeExpanded.has(id));

    return diff;
  }
  /**
   * Native click — dispatches the full human event sequence on an element.
   * ALWAYS scrolls into view first.
   */
  async function _probeClick(el) {
    // ✅ Always scroll into view before any interaction
    el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    await _jitteredDelay(60);

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y
    };

    // Pointer/mouse enter
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));
    await _jitteredDelay(15);

    // Press
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, button: 0, buttons: 1, pressure: 0.5 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0, buttons: 1, detail: 1 }));
    if (el.focus) el.focus();
    await _jitteredDelay(30);

    // Release
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, button: 0, buttons: 0, pressure: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0, buttons: 0, detail: 1 }));
    await _jitteredDelay(5);

    // Click
    el.dispatchEvent(new MouseEvent('click', { ...opts, button: 0, buttons: 0, detail: 1 }));
  }

  /**
   * Hover probe — dispatches pointerover + mouseenter without clicking.
   * Waits 300ms and checks for tooltips, menus, or other hover-triggered UI.
   * Returns the diff if something appeared, or null if nothing changed.
   */
  async function _probeHover(el) {
    // Always scroll into view first
    el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    await _jitteredDelay(50);

    const before = _takeSnapshot();

    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y,
      screenX: window.screenX + x, screenY: window.screenY + y
    };

    // Hover (no press/click)
    el.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1 }));
    el.dispatchEvent(new MouseEvent('mouseenter', opts));

    // Wait for hover effects (tooltips, dropdown reveals)
    await _jitteredDelay(300);

    const after = _takeSnapshot();
    const diff = _diffSnapshots(before, after);

    const somethingAppeared = diff.overlaysAppeared.length > 0 || diff.newExpandedElements.length > 0;

    if (somethingAppeared) {
      // Leave hover position — move mouse away
      el.dispatchEvent(new PointerEvent('pointerout', { ...opts, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent('mouseout', opts));
      el.dispatchEvent(new PointerEvent('pointerleave', { ...opts, pointerId: 1 }));
      el.dispatchEvent(new MouseEvent('mouseleave', opts));
      await _jitteredDelay(200);
      return diff;
    }

    return null;
  }

  /**
   * Re-find an element using primary selector + fallback selectors.
   * Returns the DOM element or null.
   */
  function _findElementWithFallbacks(data) {
    // Try primary selector
    try {
      if (data.selector) {
        const el = document.querySelector(data.selector);
        if (el) return el;
      }
    } catch (e) { /* skip */ }

    // Try each fallback
    if (data.fallbacks && data.fallbacks.length > 0) {
      for (const fallback of data.fallbacks) {
        try {
          const el = document.querySelector(fallback);
          if (el) {
            console.log(`[DOMRecon] Found element via fallback: "${fallback}"`);
            return el;
          }
        } catch (e) { /* skip */ }
      }
    }

    return null;
  }

  /**
   * Infer a semantic state name from the probe results.
   * Examples: "menu_open", "dropdown_expanded", "tab_selected", "tooltip_shown"
   */
  function _inferStateName(data, diff, stateAfter) {
    const role = data.role || '';
    const haspopup = data.ariaHaspopup || '';
    const intent = data.intent || '';

    // Overlay/popup appeared
    if (diff.overlaysAppeared.length > 0) {
      const overlayRole = diff.overlaysAppeared[0].role || '';
      if (overlayRole === 'menu' || haspopup === 'menu') return 'menu_open';
      if (overlayRole === 'dialog') return 'dialog_open';
      if (overlayRole === 'listbox') return 'dropdown_open';
      if (overlayRole === 'tooltip') return 'tooltip_shown';
      return 'overlay_open';
    }

    // Expand/collapse
    if (diff.newExpandedElements.length > 0 || stateAfter === 'open') return 'panel_expanded';

    // Tab selected
    if (role === 'tab') return 'tab_selected';

    // Toggle
    if (role === 'checkbox' || role === 'radio' || role === 'switch') return 'option_toggled';

    // Menu items
    if (diff.menuItemsDelta > 0) return 'submenu_open';

    // Intent-based fallbacks
    if (intent === 'open_settings') return 'settings_open';
    if (intent === 'open_dialog') return 'dialog_open';
    if (intent === 'toggle_expand') return 'panel_expanded';

    return 'state_changed';
  }

  /**
   * Main probing function.
   * For each safe candidate:
   *   1. Scroll into view
   *   2. Hover probe (discover tooltips/hover menus)
   *   3. Click probe with retry (up to 2 retries if nothing happens)
   *   4. Record effect with state name + intent
   *   5. Dismiss and verify cleanup
   */
  async function probeInteractions(staticElements) {
    console.log('[DOMRecon] Starting interaction probing phase...');
    const results = [];

    // Build candidate list from the static scan
    const candidates = [];
    for (const elData of staticElements) {
      const el = _findElementWithFallbacks(elData);
      if (!el) continue;
      if (!_isSafeToProbe(el)) continue;
      candidates.push({ el, data: elData, score: _probeScore(el) });
    }

    // Sort by score (highest priority first) and cap
    candidates.sort((a, b) => b.score - a.score);
    const toProbe = candidates.slice(0, MAX_PROBES);

    console.log(`[DOMRecon] ${candidates.length} safe candidates found, probing top ${toProbe.length}`);

    for (let i = 0; i < toProbe.length; i++) {
      const { el, data } = toProbe[i];

      // Verify element is still in DOM and visible
      if (!document.body.contains(el)) continue;
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;

      const label = data.innerText || data.ariaLabel || data.selector;
      console.log(`[DOMRecon] Probing ${i + 1}/${toProbe.length}: "${_truncate(label, 40)}"`);

      try {
        // ── Phase A: Hover probe (discover tooltips, hover menus) ──
        const hoverDiff = await _probeHover(el);
        if (hoverDiff) {
          results.push({
            trigger: {
              selector: data.selector,
              fallbacks: data.fallbacks || undefined,
              text: _truncate(data.innerText || data.ariaLabel || '', 60),
              role: data.role,
              purpose: data.purpose,
              intent: data.intent,
              ariaHaspopup: data.ariaHaspopup
            },
            probeType: 'hover',
            state: _inferStateName(data, hoverDiff, null),
            effect: {
              overlaysAppeared: hoverDiff.overlaysAppeared,
              newExpandedElements: hoverDiff.newExpandedElements,
              menuItemsDelta: hoverDiff.menuItemsDelta || undefined
            }
          });
          console.log(`[DOMRecon]   → Hover revealed ${hoverDiff.overlaysAppeared.length} overlays`);
          await _dismissProbeResult();
          await _jitteredDelay(150);
        }

        // ── Phase B: Click probe with retry logic ──
        let clickWorked = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          // Verify element is still visible (might have changed after hover dismiss)
          if (!document.body.contains(el)) break;
          if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') break;

          // 1. Snapshot before
          const before = _takeSnapshot();

          // 2. Scroll into view + click with human-like events
          await _probeClick(el);

          // 3. Wait for UI to react (longer wait on first attempt)
          await _jitteredDelay(attempt === 0 ? 400 : 600);

          // 4. Snapshot after
          const after = _takeSnapshot();

          // 5. Compute diff
          const diff = _diffSnapshots(before, after);

          // 6. Re-read the element's own state
          const expandedAfter = el.getAttribute('aria-expanded');
          const selectedAfter = el.getAttribute('aria-selected');
          const checkedAfter = el.getAttribute('aria-checked');
          const stateAfter = el.getAttribute('data-state');

          const somethingHappened = (
            diff.overlaysAppeared.length > 0 ||
            diff.newExpandedElements.length > 0 ||
            diff.menuItemsDelta !== 0 ||
            diff.bodyChildDelta !== 0 ||
            expandedAfter !== data.ariaExpanded ||
            stateAfter !== (data.data && data.data['data-state'])
          );

          if (somethingHappened) {
            const stateName = _inferStateName(data, diff, stateAfter);
            results.push({
              trigger: {
                selector: data.selector,
                fallbacks: data.fallbacks || undefined,
                text: _truncate(data.innerText || data.ariaLabel || '', 60),
                role: data.role,
                purpose: data.purpose,
                intent: data.intent,
                ariaHaspopup: data.ariaHaspopup
              },
              probeType: 'click',
              state: stateName,
              effect: {
                overlaysAppeared: diff.overlaysAppeared,
                newExpandedElements: diff.newExpandedElements,
                menuItemsDelta: diff.menuItemsDelta || undefined,
                bodyChildDelta: diff.bodyChildDelta || undefined,
                elementStateAfter: {
                  ariaExpanded: expandedAfter || undefined,
                  ariaSelected: selectedAfter || undefined,
                  ariaChecked: checkedAfter || undefined,
                  dataState: stateAfter || undefined
                }
              }
            });
            console.log(`[DOMRecon]   → [click] state="${stateName}", ${diff.overlaysAppeared.length} overlays, ${diff.newExpandedElements.length} expanded`);
            clickWorked = true;
            break;  // Success — don't retry
          }

          if (attempt === 0) {
            console.log(`[DOMRecon]   → No effect on click, retrying...`);
          }
        }

        if (!clickWorked) {
          console.log(`[DOMRecon]   → No visible effect after 2 click attempts`);
        }

        // 7. Dismiss/cleanup before next probe
        await _dismissProbeResult();
        await _jitteredDelay(200);

      } catch (e) {
        console.warn(`[DOMRecon] Probe failed for "${_truncate(label, 30)}":`, e.message);
        await _dismissProbeResult();
        await _jitteredDelay(100);
      }
    }

    console.log(`[DOMRecon] Probing complete. ${results.length} interactions recorded.`);
    return results;
  }

  // ─── Editor Input Method Probing ───────────────────────
  //
  // Tests which text input method the page's editor actually accepts.
  // Tries (in order): execCommand, ClipboardEvent paste, native InputEvent,
  // and records which one the editor responds to.

  async function probeEditorInput(inputFields) {
    const editors = inputFields.filter(f =>
      f.editorType || f.inputType === 'contenteditable' ||
      f.role === 'textbox' || f.inputType === 'textarea'
    );
    if (editors.length === 0) return [];

    console.log(`[DOMRecon] Probing editor input methods for ${editors.length} editor(s)...`);
    const results = [];
    const TEST_TEXT = 'DOMRecon_test';

    for (const editorData of editors) {
      let el = null;
      try {
        if (editorData.selector) el = document.querySelector(editorData.selector);
      } catch (e) { /* skip */ }
      if (!el) continue;

      const methods = [];
      const getContent = () => (el.value !== undefined ? el.value : el.textContent).trim();

      // Save original content
      const original = getContent();

      // Method 1: document.execCommand('insertText')
      try {
        el.focus();
        await _jitteredDelay(50);
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        const inserted = document.execCommand('insertText', false, TEST_TEXT);
        await _jitteredDelay(100);
        const content = getContent();
        if (inserted && content.includes(TEST_TEXT)) {
          methods.push({ method: 'execCommand', works: true });
        } else {
          methods.push({ method: 'execCommand', works: false });
        }
        // Clean up
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        await _jitteredDelay(50);
      } catch (e) {
        methods.push({ method: 'execCommand', works: false, error: e.message });
      }

      // Method 2: ClipboardEvent paste
      try {
        el.focus();
        await _jitteredDelay(50);
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        const dt = new DataTransfer();
        dt.setData('text/plain', TEST_TEXT);
        el.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: dt, bubbles: true, cancelable: true
        }));
        await _jitteredDelay(150);
        const content = getContent();
        methods.push({ method: 'clipboardEvent', works: content.includes(TEST_TEXT) });
        // Clean up
        if (content.includes(TEST_TEXT)) {
          const sel2 = window.getSelection();
          const r2 = document.createRange();
          r2.selectNodeContents(el);
          sel2.removeAllRanges();
          sel2.addRange(r2);
          const dtEmpty = new DataTransfer();
          dtEmpty.setData('text/plain', '');
          el.dispatchEvent(new ClipboardEvent('paste', {
            clipboardData: dtEmpty, bubbles: true, cancelable: true
          }));
          await _jitteredDelay(50);
        }
      } catch (e) {
        methods.push({ method: 'clipboardEvent', works: false, error: e.message });
      }

      // Method 3: Native InputEvent
      try {
        el.focus();
        await _jitteredDelay(50);
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
        el.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText', data: TEST_TEXT, bubbles: true, cancelable: true
        }));
        el.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: TEST_TEXT, bubbles: true
        }));
        await _jitteredDelay(150);
        const content = getContent();
        methods.push({ method: 'inputEvent', works: content.includes(TEST_TEXT) });
        // Clean up
        if (content.includes(TEST_TEXT)) {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
          await _jitteredDelay(50);
        }
      } catch (e) {
        methods.push({ method: 'inputEvent', works: false, error: e.message });
      }

      // Restore blurred state
      el.blur();
      await _jitteredDelay(50);

      // Determine recommended method
      const working = methods.filter(m => m.works);
      const recommended = working.length > 0 ? working[0].method : 'cdp_insertText';

      results.push({
        selector: editorData.selector,
        editorType: editorData.editorType || null,
        inputType: editorData.inputType,
        methods,
        recommended,
        needsCDP: working.length === 0
      });

      console.log(`[DOMRecon] Editor "${editorData.selector}": recommended=${recommended}, needsCDP=${working.length === 0}`);
    }

    return results;
  }

  // ─── Input Interaction Probing ─────────────────────────
  //
  // For each input field: focus → type "test" → wait → observe:
  //   - Did a dropdown/suggestion list appear?
  //   - Did validation messages appear?
  //   - Did the UI change (overlays, expanding panels)?
  // Then cleans up and records findings.

  async function probeInputInteractions(inputFields) {
    const candidates = inputFields.filter(f =>
      f.inputType === 'text' || f.inputType === 'search' ||
      f.inputType === 'textarea' || f.inputType === 'contenteditable' ||
      f.role === 'textbox' || f.role === 'combobox' || f.role === 'searchbox'
    );

    if (candidates.length === 0) return [];

    console.log(`[DOMRecon] Input interaction probing: ${candidates.length} fields to test...`);
    const results = [];
    const TEST_INPUT = 'test';

    for (const fieldData of candidates.slice(0, 12)) {
      let el = null;
      try {
        el = _findElementWithFallbacks(fieldData);
      } catch (e) { /* skip */ }
      if (!el || !document.body.contains(el)) continue;
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;

      const label = fieldData.ariaLabel || fieldData.placeholder || fieldData.selector;
      console.log(`[DOMRecon] Input probe: "${_truncate(label, 40)}"`);

      try {
        el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        await _jitteredDelay(80);

        // Snapshot before
        const before = _takeSnapshot();
        const validationBefore = document.querySelectorAll('[role="alert"], [role="status"], .error, .validation, [aria-live]').length;

        // Focus the field
        el.focus();
        el.dispatchEvent(new FocusEvent('focus', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        await _jitteredDelay(200);

        // Check if focus alone triggered anything
        const afterFocus = _takeSnapshot();
        const focusDiff = _diffSnapshots(before, afterFocus);

        // Type test text character by character
        for (const ch of TEST_INPUT) {
          el.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: ch, bubbles: true, cancelable: true }));
          if (el.value !== undefined) {
            el.value += ch;
          } else {
            document.execCommand('insertText', false, ch);
          }
          el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
          await _jitteredDelay(40);
        }

        // Wait for autocomplete / suggestions
        await _jitteredDelay(500);

        // Snapshot after typing
        const afterTyping = _takeSnapshot();
        const typingDiff = _diffSnapshots(before, afterTyping);

        // Check for newly appeared suggestions/dropdowns
        const suggestionLists = document.querySelectorAll(
          '[role="listbox"], [role="option"], [role="menu"], ' +
          '.suggestions, .autocomplete, .dropdown-menu, [data-autocomplete], ' +
          'ul[id*="suggest"], ul[id*="option"], div[id*="autocomplete"]'
        );
        const visibleSuggestions = Array.from(suggestionLists).filter(s => {
          try { return s.offsetParent !== null || window.getComputedStyle(s).position === 'fixed'; }
          catch (e) { return false; }
        });

        // Check for new validation messages
        const validationAfter = document.querySelectorAll('[role="alert"], [role="status"], .error, .validation, [aria-live]').length;
        const validationAppeared = validationAfter > validationBefore;

        // Check for aria-invalid
        const isInvalid = el.getAttribute('aria-invalid') === 'true';

        const somethingHappened = (
          typingDiff.overlaysAppeared.length > 0 ||
          focusDiff.overlaysAppeared.length > 0 ||
          visibleSuggestions.length > 0 ||
          validationAppeared ||
          isInvalid
        );

        if (somethingHappened) {
          const record = {
            field: {
              selector: fieldData.selector,
              fallbacks: fieldData.fallbacks || undefined,
              inputType: fieldData.inputType,
              ariaLabel: fieldData.ariaLabel || undefined,
              placeholder: fieldData.placeholder || undefined
            },
            onFocus: {
              overlaysAppeared: focusDiff.overlaysAppeared.length,
              expandedElements: focusDiff.newExpandedElements.length
            },
            onType: {
              suggestionsAppeared: visibleSuggestions.length > 0,
              suggestionsCount: visibleSuggestions.length,
              overlaysAppeared: typingDiff.overlaysAppeared.length,
              validationAppeared,
              ariaInvalid: isInvalid || undefined
            }
          };

          // Scan suggestion options if they appeared
          if (visibleSuggestions.length > 0) {
            record.onType.suggestions = [];
            for (const listEl of visibleSuggestions.slice(0, 3)) {
              const options = listEl.querySelectorAll('[role="option"], li, [role="menuitem"]');
              const items = Array.from(options).slice(0, 10).map(o => ({
                text: _truncate(o.textContent, 60),
                role: o.getAttribute('role') || undefined,
                selector: _buildSelector(o)
              }));
              record.onType.suggestions.push({
                container: _buildSelector(listEl),
                role: listEl.getAttribute('role') || undefined,
                itemCount: options.length,
                items
              });
            }
          }

          results.push(record);
          console.log(`[DOMRecon]   → Suggestions: ${visibleSuggestions.length}, overlays: ${typingDiff.overlaysAppeared.length}, validation: ${validationAppeared}`);
        } else {
          console.log(`[DOMRecon]   → No reactions observed`);
        }

        // Clean up: clear the input and blur
        if (el.value !== undefined) {
          el.value = el.value.replace(TEST_INPUT, '');
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          document.execCommand('selectAll', false, null);
          document.execCommand('delete', false, null);
        }
        el.blur();
        await _dismissProbeResult();
        await _jitteredDelay(150);

      } catch (e) {
        console.warn(`[DOMRecon] Input probe failed for "${_truncate(label, 30)}":`, e.message);
        try { el.blur(); } catch (ex) {}
        await _dismissProbeResult();
        await _jitteredDelay(100);
      }
    }

    console.log(`[DOMRecon] Input probing complete. ${results.length} reactive inputs found.`);
    return results;
  }

  // ─── Keyboard Interaction Layer ────────────────────────
  //
  // Tests keyboard shortcuts on key elements:
  //   Enter → submit or activate
  //   ArrowDown → open dropdown or move focus
  //   Tab → move to next element
  //   Escape → dismiss overlays
  // Records which key caused which DOM changes.

  async function probeKeyboardInteractions(interactiveElements, inputFields) {
    console.log('[DOMRecon] Starting keyboard interaction probing...');
    const results = [];

    // Key tests to perform
    const KEY_TESTS = [
      { key: 'Enter', code: 'Enter', keyCode: 13, description: 'activate/submit' },
      { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, description: 'open dropdown/navigate' },
      { key: 'Escape', code: 'Escape', keyCode: 27, description: 'dismiss' }
    ];

    // Focus candidates: buttons with popups, comboboxes, search inputs, primary textboxes
    const candidates = [];

    // From interactive elements: comboboxes, search, buttons with haspopup
    for (const data of interactiveElements) {
      if (data.role === 'combobox' || data.role === 'searchbox' ||
          data.ariaHaspopup || data.purpose === 'dropdown' ||
          data.intent === 'open_dropdown' || data.intent === 'open_menu' ||
          data.intent === 'submit_form') {
        const el = _findElementWithFallbacks(data);
        if (el && document.body.contains(el)) {
          candidates.push({ el, data, label: data.innerText || data.ariaLabel || data.selector });
        }
      }
    }

    // From input fields: text inputs and search inputs
    for (const data of inputFields.slice(0, 6)) {
      const el = _findElementWithFallbacks(data);
      if (el && document.body.contains(el) && !candidates.some(c => c.el === el)) {
        candidates.push({ el, data, label: data.ariaLabel || data.placeholder || data.selector });
      }
    }

    // Cap candidates
    const toTest = candidates.slice(0, 10);
    console.log(`[DOMRecon] Testing ${KEY_TESTS.length} keys on ${toTest.length} elements`);

    for (const { el, data, label } of toTest) {
      if (!document.body.contains(el)) continue;
      if (el.offsetParent === null && window.getComputedStyle(el).position !== 'fixed') continue;

      const elementResults = [];

      for (const keyTest of KEY_TESTS) {
        el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
        await _jitteredDelay(50);
        el.focus();
        await _jitteredDelay(80);

        const before = _takeSnapshot();

        // Dispatch keydown + keyup
        el.dispatchEvent(new KeyboardEvent('keydown', {
          key: keyTest.key, code: keyTest.code, keyCode: keyTest.keyCode,
          bubbles: true, cancelable: true
        }));
        await _jitteredDelay(100);
        el.dispatchEvent(new KeyboardEvent('keyup', {
          key: keyTest.key, code: keyTest.code, keyCode: keyTest.keyCode,
          bubbles: true, cancelable: true
        }));

        await _jitteredDelay(300);

        const after = _takeSnapshot();
        const diff = _diffSnapshots(before, after);

        const expandedAfter = el.getAttribute('aria-expanded');
        const stateAfter = el.getAttribute('data-state');

        const somethingHappened = (
          diff.overlaysAppeared.length > 0 ||
          diff.newExpandedElements.length > 0 ||
          diff.menuItemsDelta !== 0 ||
          expandedAfter !== (data.ariaExpanded || null) ||
          stateAfter !== ((data.data && data.data['data-state']) || null)
        );

        if (somethingHappened) {
          elementResults.push({
            key: keyTest.key,
            description: keyTest.description,
            effect: {
              overlaysAppeared: diff.overlaysAppeared.length,
              expandedElements: diff.newExpandedElements.length,
              menuItemsDelta: diff.menuItemsDelta || undefined,
              ariaExpandedAfter: expandedAfter || undefined,
              dataStateAfter: stateAfter || undefined
            }
          });
        }

        // Dismiss any overlays before next key test
        await _dismissProbeResult();
        await _jitteredDelay(100);
      }

      if (elementResults.length > 0) {
        results.push({
          element: {
            selector: data.selector,
            fallbacks: data.fallbacks || undefined,
            text: _truncate(label, 60),
            role: data.role || undefined,
            intent: data.intent || undefined
          },
          keyResponses: elementResults
        });
        console.log(`[DOMRecon] "${_truncate(label, 30)}": responds to ${elementResults.map(r => r.key).join(', ')}`);
      }
    }

    console.log(`[DOMRecon] Keyboard probing complete. ${results.length} responsive elements found.`);
    return results;
  }

  // ─── Interaction Merger ────────────────────────────────
  //
  // Groups interactions that do the same thing (same intent + state)
  // into merged groups with multiple selectors.
  // Reduces redundancy and helps AI pick the best selector.

  function _mergeInteractionsByIntent(interactions) {
    if (!interactions || interactions.length === 0) return [];

    const groups = new Map();

    for (const ix of interactions) {
      const intent = (ix.trigger && ix.trigger.intent) || 'unknown';
      const state = ix.state || 'unknown';
      const probeType = ix.probeType || 'click';
      const key = `${probeType}:${intent}:${state}`;

      if (!groups.has(key)) {
        groups.set(key, {
          intent,
          probeType,
          state,
          selectors: [],
          triggerCount: 0,
          bestConfidence: 0,
          representativeEffect: ix.effect
        });
      }

      const group = groups.get(key);
      group.triggerCount++;

      // Collect selectors (with fallbacks) avoiding duplicates
      if (ix.trigger && ix.trigger.selector) {
        const existing = group.selectors.find(s => s.primary === ix.trigger.selector);
        if (!existing) {
          group.selectors.push({
            primary: ix.trigger.selector,
            fallbacks: ix.trigger.fallbacks || [],
            text: ix.trigger.text || '',
            role: ix.trigger.role || undefined,
            purpose: ix.trigger.purpose || undefined
          });
        }
      }

      // Track highest confidence across group members
      // (confidence is on the element's intent, not the interaction itself)
      // We approximate from the intent signal strength
      const conf = _estimateGroupConfidence(intent, ix);
      if (conf > group.bestConfidence) {
        group.bestConfidence = conf;
      }
    }

    // Convert map to sorted array
    return Array.from(groups.values())
      .filter(g => g.triggerCount > 0)
      .sort((a, b) => b.bestConfidence - a.bestConfidence || b.triggerCount - a.triggerCount);
  }

  /**
   * Approximate confidence for a merged group.
   */
  function _estimateGroupConfidence(intent, interaction) {
    // Known strong intents
    const strongIntents = ['submit_form', 'open_settings', 'open_menu', 'open_dialog', 'switch_tab', 'upload_file', 'delete', 'logout'];
    if (strongIntents.includes(intent)) return 0.85;

    // Intents that reliably produce observed behavior
    const state = interaction.state || '';
    if (state.includes('_open') || state.includes('_expanded') || state.includes('_selected')) return 0.80;

    // Hover interactions are observational
    if (interaction.probeType === 'hover') return 0.70;

    return 0.55;
  }

  // ─── State Machine Probing ────────────────────────────
  //
  // After clicking tabs/modes in the interactions list, re-scans the page
  // to capture which new elements appeared. This maps the state transitions
  // (e.g., "clicking Video tab reveals Frames/Ingredients sub-tabs").

  async function probeStateMachine(interactions) {
    // Only probe interactions that opened overlays with tabs/options inside
    const tabTriggers = interactions.filter(ix =>
      ix.trigger.role === 'tab' ||
      ix.trigger.ariaHaspopup ||
      (ix.effect.overlaysAppeared && ix.effect.overlaysAppeared.length > 0)
    );

    if (tabTriggers.length === 0) return [];

    console.log(`[DOMRecon] State machine probing: ${tabTriggers.length} tab/overlay triggers to explore...`);
    const stateMap = [];

    for (let i = 0; i < Math.min(tabTriggers.length, 8); i++) {
      const ix = tabTriggers[i];
      let triggerEl = null;
      try {
        if (ix.trigger.selector) triggerEl = document.querySelector(ix.trigger.selector);
      } catch (e) { /* skip */ }
      if (!triggerEl || !document.body.contains(triggerEl)) continue;
      if (triggerEl.offsetParent === null && window.getComputedStyle(triggerEl).position !== 'fixed') continue;

      const label = ix.trigger.text || ix.trigger.selector;
      console.log(`[DOMRecon] State probe ${i + 1}: clicking "${_truncate(label, 30)}"...`);

      // Snapshot elements before
      const beforeEls = new Set(
        Array.from(document.querySelectorAll('button, [role="tab"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="option"]'))
          .filter(el => el.offsetParent !== null)
          .map(el => _buildSelector(el))
      );

      // Click the trigger
      await _probeClick(triggerEl);
      await _jitteredDelay(600);

      // Snapshot elements after
      const afterEls = Array.from(document.querySelectorAll(
        'button, [role="tab"], [role="radio"], [role="checkbox"], [role="menuitem"], [role="option"]'
      )).filter(el => el.offsetParent !== null);

      const newElements = [];
      for (const el of afterEls) {
        const sel = _buildSelector(el);
        if (!beforeEls.has(sel)) {
          newElements.push({
            selector: sel,
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || undefined,
            text: _truncate(el.textContent, 60),
            ariaLabel: el.getAttribute('aria-label') || undefined,
            ariaSelected: el.getAttribute('aria-selected') || undefined
          });
        }
      }

      if (newElements.length > 0) {
        stateMap.push({
          trigger: {
            selector: ix.trigger.selector,
            text: ix.trigger.text,
            role: ix.trigger.role
          },
          newElementsRevealed: newElements.slice(0, 30),
          totalNewElements: newElements.length
        });
        console.log(`[DOMRecon]   → ${newElements.length} new elements appeared after clicking "${_truncate(label, 30)}"`);
      }

      // Dismiss and restore
      await _dismissProbeResult();
      await _jitteredDelay(300);
    }

    console.log(`[DOMRecon] State machine probing complete. ${stateMap.length} state transitions recorded.`);
    return stateMap;
  }

  // ═══════════════════════════════════════════════════════
  // ─── PASSIVE OBSERVER MODE ────────────────────────────
  // ═══════════════════════════════════════════════════════
  //
  // Zero-footprint observation system. Instead of dispatching events
  // (which are detectable via isTrusted), the observer silently watches
  // DOM mutations caused by real user or browser subagent interactions.
  //
  // Flow:
  //   1. startObserving()  — initial static scan + MutationObserver setup
  //   2. User/subagent interacts with the page naturally
  //   3. Observer records all DOM changes as they happen
  //   4. rescan()          — re-runs static scan, diffs against baseline
  //   5. stopObserving()   — tear down, return accumulated observations
  //
  // Everything here is READ-ONLY. No events dispatched. Undetectable.

  let _observer = null;          // MutationObserver instance
  let _observing = false;        // Is observation active?
  let _baselineSnapshot = null;  // Initial scan result (for diffing)
  let _observationLog = [];      // Accumulated change events
  let _mutationBuffer = [];      // Raw mutation buffer (coalesced periodically)
  let _coalesceTimer = null;     // Timer for coalescing mutations
  let _baselineElements = null;  // Baseline interactiveElements (for diff)
  let _baselineInputFields = null;
  let _lastScanTimestamp = 0;
  let _scanCounter = 0;

  /**
   * Start observing the page. Performs an initial static scan (baseline),
   * then sets up MutationObserver to track all DOM changes silently.
   *
   * @returns {object} The initial baseline scan result
   */
  async function startObserving() {
    if (_observing) {
      console.log('[DOMRecon Observer] Already observing. Call stopObserving() first.');
      return { alreadyObserving: true };
    }

    console.log('[DOMRecon Observer] Starting observation session...');
    const startTime = Date.now();

    // Phase 1: Capture baseline (static scan — no probing)
    const framework = detectFramework();
    await _jitteredDelay(20);
    const interactiveElements = await scanInteractiveElements();
    await _jitteredDelay(10);
    const structure = scanPageStructure();
    const inputFields = scanInputFields();
    const forms = scanForms();
    const navLinks = extractNavigationLinks();

    _baselineElements = interactiveElements;
    _baselineInputFields = inputFields;
    _lastScanTimestamp = Date.now();
    _scanCounter = 1;

    _baselineSnapshot = {
      url: window.location.href,
      title: document.title,
      timestamp: new Date().toISOString(),
      framework,
      structure,
      interactiveElements,
      inputFields,
      forms,
      navigation: {
        internalLinks: navLinks.filter(l => l.isInternal && l.safe !== false),
        unsafeLinks: navLinks.filter(l => l.safe === false)
      },
      summary: {
        totalInteractive: interactiveElements.length,
        totalInputFields: inputFields.length,
        totalForms: forms.length
      }
    };

    // Phase 2: Set up MutationObserver
    _observationLog = [];
    _mutationBuffer = [];
    _observing = true;

    _observer = new MutationObserver((mutations) => {
      if (!_observing) return;

      // Buffer mutations for coalescing (don't process every single one)
      for (const m of mutations) {
        _mutationBuffer.push({
          type: m.type,
          target: m.target,
          addedNodes: m.addedNodes ? Array.from(m.addedNodes) : [],
          removedNodes: m.removedNodes ? Array.from(m.removedNodes) : [],
          attributeName: m.attributeName,
          oldValue: m.oldValue,
          timestamp: Date.now()
        });
      }

      // Coalesce: process buffer after 300ms of quiet
      if (_coalesceTimer) clearTimeout(_coalesceTimer);
      _coalesceTimer = setTimeout(() => _processMutationBuffer(), 300);
    });

    _observer.observe(document.body, {
      childList: true,       // Track added/removed nodes
      subtree: true,         // Watch entire DOM tree
      attributes: true,      // Track attribute changes
      attributeFilter: [     // Only care about meaningful attributes
        'aria-expanded', 'aria-selected', 'aria-checked', 'aria-hidden',
        'aria-disabled', 'aria-pressed', 'aria-current',
        'data-state', 'data-active', 'data-open', 'data-selected',
        'class', 'style', 'hidden', 'disabled', 'open'
      ],
      attributeOldValue: true // Capture what the value was before
    });

    const scanTimeMs = Date.now() - startTime;
    console.log(`[DOMRecon Observer] Baseline captured in ${scanTimeMs}ms — ${interactiveElements.length} elements. Now watching for changes...`);

    return {
      status: 'observing',
      scanTimeMs,
      baseline: _baselineSnapshot
    };
  }

  /**
   * Process buffered mutations into semantic change events.
   * This runs after 300ms of mutation quiet to coalesce rapid changes.
   */
  function _processMutationBuffer() {
    if (_mutationBuffer.length === 0) return;

    const batch = _mutationBuffer.splice(0);
    const timestamp = new Date().toISOString();
    const firstTs = batch[0].timestamp;
    const lastTs = batch[batch.length - 1].timestamp;

    // ─── Categorize mutations ───

    // 1. New visible elements added
    const addedElements = [];
    const removedElements = [];
    for (const m of batch) {
      if (m.type !== 'childList') continue;
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue; // Only elements
        // Check if it's something interesting (overlay, menu, dialog, form, etc.)
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute ? node.getAttribute('role') : null;
        const isInteractive = node.querySelector && node.querySelector('button, input, a, [role="menuitem"], [role="option"]');
        const isOverlay = role === 'dialog' || role === 'menu' || role === 'listbox' ||
                         role === 'tooltip' || role === 'alertdialog' ||
                         tag === 'dialog' ||
                         (node.classList && (node.classList.contains('modal') || node.classList.contains('popup') ||
                          node.classList.contains('dropdown') || node.classList.contains('overlay')));

        if (isOverlay || isInteractive || ['dialog', 'menu', 'nav', 'form', 'aside'].includes(tag)) {
          const selector = _buildSelector(node);
          addedElements.push({
            selector,
            tag,
            role: role || undefined,
            isOverlay,
            hasInteractiveChildren: !!isInteractive,
            text: _truncate(node.textContent, 80),
            rect: (() => {
              try {
                const r = node.getBoundingClientRect();
                return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
              } catch (e) { return null; }
            })()
          });
        }
      }
      for (const node of m.removedNodes) {
        if (node.nodeType !== 1) continue;
        const tag = node.tagName ? node.tagName.toLowerCase() : '?';
        const role = node.getAttribute ? node.getAttribute('role') : null;
        if (role === 'dialog' || role === 'menu' || role === 'listbox' || role === 'tooltip' ||
            tag === 'dialog' || (node.classList && (node.classList.contains('modal') || node.classList.contains('popup')))) {
          removedElements.push({ tag, role: role || undefined });
        }
      }
    }

    // 2. Attribute changes (state transitions)
    const stateChanges = [];
    const seenSelectors = new Set();
    for (const m of batch) {
      if (m.type !== 'attributes') continue;
      const el = m.target;
      if (!el || el.nodeType !== 1) continue;

      const selector = _buildSelector(el);
      const key = `${selector}:${m.attributeName}`;
      if (seenSelectors.has(key)) continue; // Deduplicate
      seenSelectors.add(key);

      const newValue = el.getAttribute(m.attributeName);
      if (m.oldValue === newValue) continue; // No actual change

      stateChanges.push({
        selector,
        attribute: m.attributeName,
        oldValue: m.oldValue,
        newValue: newValue,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        text: _truncate(el.textContent, 40)
      });
    }

    // Only log if something meaningful happened
    if (addedElements.length === 0 && removedElements.length === 0 && stateChanges.length === 0) return;

    const changeEvent = {
      id: _observationLog.length + 1,
      timestamp,
      durationMs: lastTs - firstTs,
      mutationCount: batch.length,
      addedElements,
      removedElements,
      stateChanges,
      summary: _summarizeChange(addedElements, removedElements, stateChanges)
    };

    _observationLog.push(changeEvent);
    console.log(`[DOMRecon Observer] Change #${changeEvent.id}: ${changeEvent.summary}`);
  }

  /**
   * Generate a human-readable summary of a change event.
   */
  function _summarizeChange(added, removed, stateChanges) {
    const parts = [];
    if (added.length > 0) {
      const overlays = added.filter(e => e.isOverlay);
      if (overlays.length > 0) parts.push(`${overlays.length} overlay(s) appeared`);
      const others = added.length - overlays.length;
      if (others > 0) parts.push(`${others} element(s) added`);
    }
    if (removed.length > 0) parts.push(`${removed.length} element(s) removed`);
    if (stateChanges.length > 0) {
      const expanded = stateChanges.filter(s => s.attribute === 'aria-expanded');
      if (expanded.length > 0) parts.push(`${expanded.length} expand/collapse`);
      const other = stateChanges.length - expanded.length;
      if (other > 0) parts.push(`${other} state change(s)`);
    }
    return parts.join(', ') || 'minor DOM change';
  }

  /**
   * Re-scan the page and diff against the baseline.
   * Call this after the user/subagent has interacted with the page.
   * Returns what's new/changed since the last scan.
   *
   * This is READ-ONLY — no events dispatched.
   */
  async function rescan() {
    if (!_observing) {
      return { error: 'Not observing. Call startObserving() first.' };
    }

    console.log('[DOMRecon Observer] Re-scanning page...');
    const startTime = Date.now();
    _scanCounter++;

    // Run static scanners again
    const currentElements = await scanInteractiveElements();
    const currentInputFields = scanInputFields();
    const currentStructure = scanPageStructure();

    // Diff: elements present now but not in baseline
    const baselineSelectors = new Set(_baselineElements.map(e => e.selector));
    const currentSelectors = new Set(currentElements.map(e => e.selector));

    const newElements = currentElements.filter(e => !baselineSelectors.has(e.selector));
    const removedSelectors = [...baselineSelectors].filter(s => !currentSelectors.has(s));

    // Diff: elements whose state changed (aria-expanded, aria-selected, etc.)
    const changedElements = [];
    for (const curr of currentElements) {
      const prev = _baselineElements.find(e => e.selector === curr.selector);
      if (!prev) continue;
      const changes = {};
      if (curr.ariaExpanded !== prev.ariaExpanded) changes.ariaExpanded = { was: prev.ariaExpanded, now: curr.ariaExpanded };
      if (curr.ariaSelected !== prev.ariaSelected) changes.ariaSelected = { was: prev.ariaSelected, now: curr.ariaSelected };
      if (curr.ariaChecked !== prev.ariaChecked) changes.ariaChecked = { was: prev.ariaChecked, now: curr.ariaChecked };
      if (curr.visible !== prev.visible) changes.visible = { was: prev.visible, now: curr.visible };
      if (Object.keys(changes).length > 0) {
        changedElements.push({
          selector: curr.selector,
          intent: curr.intent,
          confidence: curr.confidence,
          text: curr.innerText || curr.ariaLabel || '',
          changes
        });
      }
    }

    // Diff input fields
    const baselineInputSelectors = new Set(_baselineInputFields.map(f => f.selector));
    const newInputFields = currentInputFields.filter(f => !baselineInputSelectors.has(f.selector));

    // Diff structure (new overlays)
    const baselineOverlayCount = _baselineSnapshot.structure.overlays.length;
    const currentOverlayCount = currentStructure.overlays.length;
    const overlayDelta = currentOverlayCount - baselineOverlayCount;

    const scanTimeMs = Date.now() - startTime;
    _lastScanTimestamp = Date.now();

    // Update baseline for next diff
    _baselineElements = currentElements;
    _baselineInputFields = currentInputFields;

    const diff = {
      scanNumber: _scanCounter,
      timestamp: new Date().toISOString(),
      scanTimeMs,
      currentUrl: window.location.href,
      currentTitle: document.title,

      // What's different from baseline
      diff: {
        newElements,
        removedSelectors,
        changedElements,
        newInputFields,
        overlayDelta,
        elementCountDelta: currentElements.length - _baselineSnapshot.summary.totalInteractive
      },

      // Current state
      current: {
        totalInteractive: currentElements.length,
        totalInputFields: currentInputFields.length,
        overlayCount: currentOverlayCount
      },

      // Observation log since last rescan
      observationsSinceLastScan: _observationLog.length,
      recentChanges: _observationLog.slice(-10) // Last 10 change events
    };

    console.log(`[DOMRecon Observer] Rescan #${_scanCounter}: +${newElements.length} new, -${removedSelectors.length} removed, ${changedElements.length} changed, ${_observationLog.length} observed changes`);

    return diff;
  }

  /**
   * Get all accumulated observations without rescanning.
   * Useful for checking what the MutationObserver has recorded.
   */
  function getObservations() {
    return {
      observing: _observing,
      scanCounter: _scanCounter,
      lastScanTimestamp: _lastScanTimestamp,
      totalChanges: _observationLog.length,
      changes: _observationLog,
      baseline: _baselineSnapshot ? {
        url: _baselineSnapshot.url,
        totalInteractive: _baselineSnapshot.summary.totalInteractive,
        timestamp: _baselineSnapshot.timestamp
      } : null
    };
  }

  /**
   * Stop observing. Tears down the MutationObserver and returns
   * the full observation report including a final rescan diff.
   */
  async function stopObserving() {
    if (!_observing) {
      return { error: 'Not observing.' };
    }

    console.log('[DOMRecon Observer] Stopping observation...');

    // Process any remaining buffered mutations
    if (_coalesceTimer) clearTimeout(_coalesceTimer);
    _processMutationBuffer();

    // Final rescan
    const finalDiff = await rescan();

    // Tear down observer
    if (_observer) {
      _observer.disconnect();
      _observer = null;
    }
    _observing = false;

    const report = {
      status: 'stopped',
      sessionDuration: Date.now() - new Date(_baselineSnapshot.timestamp).getTime(),
      totalScans: _scanCounter,
      totalChangesObserved: _observationLog.length,
      baseline: _baselineSnapshot,
      allChanges: _observationLog,
      finalDiff,
      summary: {
        overlaysDiscovered: _observationLog.reduce((sum, c) => sum + c.addedElements.filter(e => e.isOverlay).length, 0),
        stateTransitionsObserved: _observationLog.reduce((sum, c) => sum + c.stateChanges.length, 0),
        totalMutationsProcessed: _observationLog.reduce((sum, c) => sum + c.mutationCount, 0)
      }
    };

    // Clean up state
    _observationLog = [];
    _mutationBuffer = [];
    _baselineSnapshot = null;
    _baselineElements = null;
    _baselineInputFields = null;
    _scanCounter = 0;

    console.log(`[DOMRecon Observer] Session ended. ${report.totalChangesObserved} changes, ${report.totalScans} scans, ${report.summary.overlaysDiscovered} overlays discovered.`);

    return report;
  }

  // ─── Full Blueprint Generator ─────────────────────────

  async function generateBlueprint(options = {}) {
    const { probe = false } = options;
    console.log(`[DOMRecon] Starting page scan... (probe=${probe})`);
    const startTime = Date.now();

    // Run all static scanners
    const framework = detectFramework();
    await _jitteredDelay(20);

    const interactiveElements = await scanInteractiveElements();
    await _jitteredDelay(20);

    const structure = scanPageStructure();
    await _jitteredDelay(10);

    const inputFields = scanInputFields();
    const forms = scanForms();
    const navLinks = extractNavigationLinks();

    // Run interaction probing if requested
    let interactions = [];
    let editorCapabilities = [];
    let stateTransitions = [];
    let inputInteractions = [];
    let keyboardInteractions = [];
    let mergedInteractions = [];
    if (probe) {
      await _jitteredDelay(300);
      interactions = await probeInteractions(interactiveElements);

      // Probe editor input methods
      await _jitteredDelay(200);
      editorCapabilities = await probeEditorInput(inputFields);

      // Probe input field interactions (focus → type → observe)
      await _jitteredDelay(200);
      inputInteractions = await probeInputInteractions(inputFields);

      // Probe keyboard interactions (Enter, ArrowDown, Escape)
      await _jitteredDelay(200);
      keyboardInteractions = await probeKeyboardInteractions(interactiveElements, inputFields);

      // Probe state machine (what appears after clicking tabs/overlays)
      await _jitteredDelay(200);
      stateTransitions = await probeStateMachine(interactions);

      // Merge similar interactions by intent + state
      mergedInteractions = _mergeInteractionsByIntent(interactions);
    }

    const scanTimeMs = Date.now() - startTime;

    // Build hierarchy grouping: elements organized by parentRegion
    const hierarchy = {};
    for (const el of interactiveElements) {
      const region = el.parentRegion || '_root';
      if (!hierarchy[region]) hierarchy[region] = [];
      hierarchy[region].push({
        selector: el.selector,
        intent: el.intent,
        confidence: el.confidence,
        text: el.innerText || el.ariaLabel || '',
        purpose: el.purpose
      });
    }

    // Count interactions by type
    const hoverInteractions = interactions.filter(ix => ix.probeType === 'hover').length;
    const clickInteractions = interactions.filter(ix => ix.probeType === 'click').length;
    const unsafeLinks = navLinks.filter(l => l.safe === false).length;

    const blueprint = {
      url: window.location.href,
      hostname: window.location.hostname,
      pathname: window.location.pathname,
      title: document.title,
      timestamp: new Date().toISOString(),
      scanTimeMs,
      probed: probe,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight
      },
      framework,
      structure,
      interactiveElements,
      inputFields,
      forms,
      interactions,
      mergedInteractions,
      inputInteractions,
      keyboardInteractions,
      editorCapabilities,
      stateTransitions,
      hierarchy,
      navigation: {
        internalLinks: navLinks.filter(l => l.isInternal && l.safe !== false),
        unsafeLinks: navLinks.filter(l => l.safe === false),
        externalLinks: navLinks.filter(l => !l.isInternal).slice(0, 20)
      },
      summary: {
        totalInteractive: interactiveElements.length,
        totalInputFields: inputFields.length,
        totalForms: forms.length,
        totalInternalLinks: navLinks.filter(l => l.isInternal).length,
        totalExternalLinks: navLinks.filter(l => !l.isInternal).length,
        unsafeLinksFiltered: unsafeLinks,
        customElements: framework.customElements.length,
        reactComponents: framework.reactComponents ? framework.reactComponents.length : 0,
        hasOverlays: structure.overlays.length > 0,
        interactionsRecorded: interactions.length,
        hoverInteractions,
        clickInteractions,
        mergedInteractionGroups: mergedInteractions.length,
        reactiveInputs: inputInteractions.length,
        keyboardResponsiveElements: keyboardInteractions.length,
        stateTransitionsRecorded: stateTransitions.length,
        editorsTested: editorCapabilities.length,
        hierarchyRegions: Object.keys(hierarchy).length
      }
    };

    console.log(`[DOMRecon] Scan complete in ${scanTimeMs}ms — ${interactiveElements.length} elements, ${interactions.length} interactions (${hoverInteractions} hover, ${clickInteractions} click), ${mergedInteractions.length} merged groups, ${inputInteractions.length} reactive inputs, ${keyboardInteractions.length} keyboard-responsive, ${stateTransitions.length} state transitions`);

    return blueprint;
  }

  // ─── Send Blueprint to Bridge ─────────────────────────

  async function sendBlueprint(blueprint) {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/recon`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(blueprint)
      });
      if (res.ok) {
        console.log('[DOMRecon] Blueprint sent to bridge server');
      } else {
        console.error('[DOMRecon] Bridge rejected blueprint:', res.status);
      }
    } catch (e) {
      console.error('[DOMRecon] Failed to send blueprint:', e.message);
    }
  }

  // ─── Public API ───────────────────────────────────────

  return {
    // Blueprint (full scan)
    generateBlueprint,
    sendBlueprint,

    // Observer mode (passive — zero footprint)
    startObserving,
    stopObserving,
    rescan,
    getObservations,

    // Active probing (opt-in — dispatches events)
    probeInteractions,
    probeInputInteractions,
    probeKeyboardInteractions,
    probeEditorInput,
    probeStateMachine,

    // Static scanners (safe — read-only)
    detectFramework,
    scanInteractiveElements,
    scanPageStructure,
    scanInputFields,
    extractNavigationLinks,
    scanForms
  };
})();

