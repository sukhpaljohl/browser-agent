/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Brain Executor — Generic, Site-Agnostic Execution Engine
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Replaces ALL site-specific strategy files with a single unified
 *           execution engine that works on ANY website.
 *
 * How it works:
 *   1. Receives a natural-language prompt from the bridge server
 *   2. Parses intent (click, type, read, scroll, search, etc.)
 *   3. Scans the page with DOMRecon → NodeClassifier → CandidatePruner
 *   4. Enriches candidates with ContextBuilder (failure memory, loop state)
 *   5. Finds the best matching element from the pruned candidates
 *   6. Executes action via HumanEngine (CDP-level, hardware-like events)
 *   7. Returns structured result to the bridge
 *
 * Zero hardcoded selectors. Zero site-specific logic.
 * The Brain decides what to interact with by reading the live DOM.
 *
 * Ref: Implementation Plan — Strategy-to-Brain Migration
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.BrainExecutor = class BrainExecutor {
  constructor(engine) {
    this.engine = engine;       // POMDP engine (belief state, rewards)
    this._humanEngine = null;
    this._humanEngineReady = false;

    // ─── Phase 1A.3c: Cross-Cycle State ───
    // Stores disabled element signatures from the previous action cycle.
    // Used by ActionContext.recently_enabled feature to detect disabled→enabled transitions.
    /** @type {Set<string>|null} */
    this._previousDisabledSignatures = null;

    // Last pipeline candidates — kept for clarification engine scoring
    /** @type {Object[]|null} */
    this._lastCandidates = null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  HUMAN ENGINE — Lazy initialization
  // ═══════════════════════════════════════════════════════════════

  async _ensureHumanEngine() {
    if (this._humanEngineReady && this._humanEngine) return this._humanEngine;

    if (typeof HumanEngine === 'undefined') {
      console.warn('[Brain] HumanEngine not available');
      return null;
    }

    try {
      this._humanEngine = new HumanEngine();
      await this._humanEngine.init();
      this._humanEngineReady = true;
      console.log('[Brain] HumanEngine initialized');
      return this._humanEngine;
    } catch (e) {
      console.warn('[Brain] HumanEngine init failed:', e.message);
      this._humanEngine = null;
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  INTENT PARSER — Maps natural language to action type
  // ═══════════════════════════════════════════════════════════════

  /**
   * Parse a prompt into { intent, target, text }.
   *
   * Supported intents:
   *   click <text>                 → Click element with matching visible text
   *   type "<text>" into <target>  → Type text into a matching input
   *   search <query>              → Find search input, type query, press Enter
   *   scroll [up|down|to <text>]  → Scroll page
   *   read / extract              → Extract full page content
   *   navigate <target>           → Click link matching target text
   *   stealth-audit               → Run stealth detection checks
   *   extract-images              → Extract images from page
   *   status                      → Report agent status
   */
  _parseIntent(prompt) {
    const trimmed = prompt.trim();
    const lower = trimmed.toLowerCase();

    // Stealth audit
    if (lower === 'stealth-audit' || lower === 'audit' || lower === 'stealth') {
      return { intent: 'stealth-audit', target: '', text: '' };
    }

    // Image extraction
    if (lower === 'extract-images' || lower === 'images' || lower === 'get images') {
      return { intent: 'extract-images', target: '', text: '' };
    }

    // Status
    if (lower === 'status' || lower === 'debug') {
      return { intent: 'status', target: '', text: '' };
    }

    // Read / extract page content
    if (lower === 'read' || lower === 'extract' || lower === 'page' || lower === 'content') {
      return { intent: 'read', target: '', text: '' };
    }

    // Type "text" into <target>
    const typeMatch = trimmed.match(/^type\s+"(.*?)"\s+into\s+(.+)/i);
    if (typeMatch) {
      return { intent: 'type', target: typeMatch[2].trim(), text: typeMatch[1] };
    }

    // Search <query>
    if (lower.startsWith('search ') || lower.startsWith('find ')) {
      const query = trimmed.substring(trimmed.indexOf(' ') + 1).trim();
      return { intent: 'search', target: '', text: query };
    }

    // Click <text>
    if (lower.startsWith('click ') || lower.startsWith('press ') || lower.startsWith('tap ')) {
      const target = trimmed.substring(trimmed.indexOf(' ') + 1).trim();
      return { intent: 'click', target, text: '' };
    }

    // Navigate <target>
    if (lower.startsWith('navigate ') || lower.startsWith('nav ') || lower.startsWith('goto ') || lower.startsWith('go to ')) {
      const target = trimmed.replace(/^(navigate|nav|goto|go to)\s+/i, '').trim();
      return { intent: 'navigate', target, text: '' };
    }

    // Back (Phase 1B.1: soft backtracking — go back in browser history)
    if (lower === 'back' || lower === 'go back' || lower === 'history.back') {
      return { intent: 'back', target: '', text: '' };
    }

    // Scroll
    if (lower.startsWith('scroll')) {
      const rest = lower.replace('scroll', '').trim();
      if (rest === 'up') return { intent: 'scroll', target: 'up', text: '' };
      if (rest === 'down' || rest === '') return { intent: 'scroll', target: 'down', text: '' };
      if (rest.startsWith('to ')) return { intent: 'scroll-to', target: rest.replace('to ', ''), text: '' };
      return { intent: 'scroll', target: 'down', text: '' };
    }

    // Expand / toggle
    if (lower.startsWith('expand ') || lower.startsWith('toggle ')) {
      const target = trimmed.substring(trimmed.indexOf(' ') + 1).trim();
      return { intent: 'expand', target, text: '' };
    }

    // Default: treat as a click on matching text
    return { intent: 'click', target: trimmed, text: '' };
  }

  // ═══════════════════════════════════════════════════════════════
  //  BRAIN PIPELINE — Scan → Prune → Enrich → ActionContext → Prior
  // ═══════════════════════════════════════════════════════════════

  /**
   * Run the full brain pipeline to get enriched candidate elements.
   *
   * Pipeline stages:
   *   1. Scan (DOMRecon or basic fallback)
   *   2-5. Classify → Prune → Score → Sign (CandidatePruner)
   *   6. Context enrichment (ContextBuilder — failure memory, loops)
   *   7. Action Context features (ActionContext — 9 DOM signals) [Phase 1A.3c]
   *   8. Expected Outcome prior (heuristic value estimate) [Phase 1A.3c]
   *
   * @param {string[]} [goalTokens=[]] - Tokens for navigation penalty override
   * @returns {Promise<Object[]>} Enriched candidate nodes with _expectedOutcome
   */
  async _runBrainPipeline(goalTokens = []) {
    // Stage 1: Scan the DOM (use DOMRecon's interactive elements scanner)
    let rawNodes = [];
    if (BrowserAgent.DOMRecon && typeof BrowserAgent.DOMRecon.scanInteractiveElements === 'function') {
      rawNodes = await BrowserAgent.DOMRecon.scanInteractiveElements();
    } else {
      // Fallback: use a basic scan
      rawNodes = this._basicScan();
    }

    console.log(`[Brain] DOM scan: ${rawNodes.length} raw elements`);

    // Stage 2-5: Classify → Prune → Score → Sign
    let candidates = rawNodes;
    if (BrowserAgent.CandidatePruner) {
      const pruneResult = BrowserAgent.CandidatePruner.prune(rawNodes, { goalTokens });
      candidates = pruneResult.candidates;
    } else {
      console.warn('[Brain] CandidatePruner not loaded — using raw nodes');
    }

    // Stage 6: Enrich with Command Center context (failure memory, loops)
    if (BrowserAgent.ContextBuilder) {
      const enrichResult = await BrowserAgent.ContextBuilder.enrich(candidates);
      candidates = enrichResult.candidates;
    }

    // Stage 7: Action Context features (Phase 1A.3c)
    // Computes 9 framework-invariant DOM signals per candidate
    if (BrowserAgent.ActionContext) {
      const acResult = BrowserAgent.ActionContext.computeAll(candidates, {
        goalTokens,
        previousDisabledSignatures: this._previousDisabledSignatures
      });
      candidates = acResult.candidates;
    }

    // Stage 8: Expected Outcome prior (Phase 1A.3c)
    // Heuristic value estimate — multiplies pruner scores
    this._applyExpectedOutcomePrior(candidates);

    // Cache for clarification engine
    this._lastCandidates = candidates;

    return candidates;
  }

  /**
   * Basic fallback DOM scan when DOMRecon is not available.
   */
  _basicScan() {
    const selectors = 'a, button, input, textarea, select, [role="button"], [role="tab"], [role="link"], [role="textbox"], [contenteditable="true"]';
    const elements = Array.from(document.querySelectorAll(selectors));

    return elements.map(el => {
      const rect = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        innerText: (el.innerText || el.textContent || '').trim().substring(0, 100),
        ariaLabel: el.getAttribute('aria-label') || '',
        placeholder: el.getAttribute('placeholder') || '',
        ariaHaspopup: el.getAttribute('aria-haspopup') || '',
        ariaExpanded: el.getAttribute('aria-expanded'),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        type: el.getAttribute('type') || '',
        visible: rect.width > 0 && rect.height > 0 && el.offsetParent !== null,
        rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
        selector: el.id ? `#${el.id}` : '',
        _domElement: el   // Direct reference for interaction
      };
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  ELEMENT FINDER — Match text to candidate
  // ═══════════════════════════════════════════════════════════════

  /**
   * Find the best candidate matching a text target.
   * Uses a multi-strategy matching approach:
   *   1. Exact text match
   *   2. Case-insensitive contains
   *   3. aria-label match
   *   4. Placeholder match
   *
   * @param {Object[]} candidates - Pruned candidates
   * @param {string} targetText - Text to search for
   * @returns {Object|null} Best matching candidate (with _domElement)
   */
  _findBestMatch(candidates, targetText) {
    const lower = targetText.toLowerCase().trim();
    if (!lower) return null;

    // Ensure candidates have DOM references
    const withElements = candidates.map(c => {
      if (!c._domElement && c.selector) {
        try { c._domElement = document.querySelector(c.selector); } catch (e) { /* ignore */ }
      }
      return c;
    }).filter(c => c._domElement);

    // Score each candidate
    const scored = withElements.map(c => {
      const text = (c.innerText || '').toLowerCase().trim();
      const ariaLabel = (c.ariaLabel || '').toLowerCase();
      const placeholder = (c.placeholder || '').toLowerCase();
      let score = 0;

      // Exact match (highest priority)
      if (text === lower) score += 100;
      else if (ariaLabel === lower) score += 95;
      else if (placeholder === lower) score += 90;
      // Contains match
      else if (text.includes(lower)) score += 70 - Math.min(text.length, 50); // shorter = better
      else if (ariaLabel.includes(lower)) score += 60;
      else if (placeholder.includes(lower)) score += 55;
      // Reverse contains (target includes element text)
      else if (lower.includes(text) && text.length > 2) score += 40;

      // Boost by pruner score
      if (c._prunerScore) score += c._prunerScore * 0.1;
      // Penalty for failure memory
      if (c._failurePenalty && c._failurePenalty < 1) score *= c._failurePenalty;
      // Boost committed nodes
      if (c._commitmentBonus && c._commitmentBonus > 1) score *= c._commitmentBonus;

      // ─── Phase 1A.3c: Expected Outcome multiplier ───
      // Apply heuristic value prior as a score multiplier.
      // Range 0.1-0.9 — amplifies confident choices, dampens known-bad ones.
      if (c._expectedOutcome) {
        score *= c._expectedOutcome;
      }

      // ─── Phase 1B.1: Diversity penalty ───
      // Applied by ContextBuilder — penalizes candidates whose tag was
      // over-represented in recent actions (0.85^repeats).
      if (c._diversityPenalty && c._diversityPenalty < 1) {
        score *= c._diversityPenalty;
      }

      return { candidate: c, score };
    }).filter(s => s.score > 0);

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const best = scored[0];
      console.log(`[Brain] Best match for "${targetText}": "${(best.candidate.innerText || '').substring(0, 40)}" (score: ${best.score.toFixed(1)})`);
      return best.candidate;
    }

    console.warn(`[Brain] No match found for "${targetText}"`);
    return null;
  }

  /**
   * Find the best input field from candidates.
   * Prioritizes by: search inputs first, then text inputs, then textareas.
   */
  _findInputField(candidates, targetHint = '') {
    const lower = targetHint.toLowerCase();

    const inputs = candidates.filter(c => {
      const type = c.nodeType || '';
      return type === 'input_field' || type === 'dynamic_trigger' ||
             c.tag === 'input' || c.tag === 'textarea' || c.tag === 'select' ||
             c.role === 'textbox' || c.role === 'searchbox' || c.role === 'combobox';
    });

    if (inputs.length === 0) return null;

    // If there's a hint, try to match it
    if (targetHint) {
      const hinted = this._findBestMatch(inputs, targetHint);
      if (hinted) return hinted;
    }

    // Otherwise return the highest-scored input
    inputs.sort((a, b) => (b._prunerScore || 0) - (a._prunerScore || 0));

    // Ensure DOM reference
    const best = inputs[0];
    if (!best._domElement && best.selector) {
      try { best._domElement = document.querySelector(best.selector); } catch (e) { /* ignore */ }
    }
    return best;
  }

  /**
   * Resolve a DOM element from a candidate node.
   * Tries: _domElement → selector → text search
   */
  _resolveElement(candidate) {
    if (candidate._domElement) return candidate._domElement;

    // Try selector
    if (candidate.selector) {
      try {
        const el = document.querySelector(candidate.selector);
        if (el) return el;
      } catch (e) { /* invalid selector */ }
    }

    // Last resort: text-based search
    const text = candidate.innerText || '';
    if (text.length > 1) {
      const tag = candidate.tag || '*';
      const all = Array.from(document.querySelectorAll(tag === '*' ? 'a, button, [role="button"]' : tag));
      for (const el of all) {
        if ((el.textContent || '').trim() === text.trim()) return el;
      }
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  //  PRE-ACTION INTENT REGISTRATION (Phase 1B.2.1)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Register a pre-action intent with the Service Worker's TaskStateTracker.
   * Must be called AFTER element selection but BEFORE the click/action.
   *
   * If the content script dies during navigation (the "Navigation Amnesia"
   * bug), the SW uses this registered intent to record the action via its
   * Dead Man's Switch. Without this, the action is lost forever.
   *
   * Performance: ~2-5ms (one IPC round-trip). Non-blocking on failure —
   * if registration fails, the click proceeds normally.
   *
   * @param {string} intent - Action type ('click', 'navigate', 'search')
   * @param {Object} match - The selected candidate from _findBestMatch()
   * @param {string} prompt - The original command prompt
   * @returns {Promise<void>}
   */
  async _registerIntent(intent, match, prompt) {
    try {
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'BRAIN_REGISTER_INTENT',
          intentData: {
            nodeSignature: `${match.tag || ''}|${match.role || ''}|${(match.innerText || '').slice(0, 30).trim().toLowerCase()}`,
            nodeText: (match.innerText || '').substring(0, 60),
            nodeTag: match.tag || '',
            nodeType: match.nodeType || '',
            url: window.location.href,
            prompt: prompt,
            intent: intent,
            timestamp: Date.now()
          }
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('[Brain] Intent registration failed:', chrome.runtime.lastError.message);
          }
          resolve();
        });
      });
    } catch (e) {
      // Non-fatal — the click will proceed even if registration fails.
      // This happens when the extension context is invalidated.
      console.warn('[Brain] Intent registration error (non-fatal):', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  ACTION HANDLERS
  // ═══════════════════════════════════════════════════════════════

  async _handleClick(target) {
    const candidates = await this._runBrainPipeline([target]);
    const match = this._findBestMatch(candidates, target);

    if (!match) {
      return { success: false, response: { text: `Could not find element with text "${target}" on this page.` } };
    }

    const el = this._resolveElement(match);
    if (!el) {
      return { success: false, response: { text: `Found candidate "${match.innerText}" but couldn't resolve DOM element.` } };
    }

    // Phase 1B.2.1: Register intent before click (survives navigation death)
    await this._registerIntent('click', match, target);

    const engine = await this._ensureHumanEngine();
    if (engine) {
      await engine.click(el);
    } else {
      // Fallback: synthetic click
      el.scrollIntoView({ behavior: 'instant', block: 'nearest' });
      el.click();
    }

    const clickedText = (match.innerText || '').substring(0, 60);
    const isLink = match.tag === 'a';
    const href = isLink ? (el.href || '') : '';

    return {
      success: true,
      response: {
        text: `Clicked "${clickedText}".${isLink && href ? ` Navigating to ${href}.` : ''}`,
        data: { action: 'click', text: clickedText, href, nodeType: match.nodeType }
      }
    };
  }

  async _handleType(target, text) {
    const candidates = await this._runBrainPipeline([target, text]);
    const inputCandidate = this._findInputField(candidates, target);

    if (!inputCandidate) {
      return { success: false, response: { text: `Could not find input field "${target}" on this page.` } };
    }

    const el = this._resolveElement(inputCandidate);
    if (!el) {
      return { success: false, response: { text: `Found input but couldn't resolve DOM element.` } };
    }

    const engine = await this._ensureHumanEngine();
    if (engine) {
      // Click to focus, explicitly focus, then type
      await engine.click(el);
      el.focus();
      await engine._sleep(200);
      await engine.type(text);
    } else {
      // Fallback
      el.focus();
      el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }

    return {
      success: true,
      response: {
        text: `Typed "${text.substring(0, 40)}" into ${target || 'input field'}.`,
        data: { action: 'type', target, text }
      }
    };
  }

  async _handleSearch(query) {
    const candidates = await this._runBrainPipeline(['search', query]);

    // Find search input (or fall back to any major text input area if acting as a generic submit trigger)
    const searchInput = candidates.find(c =>
      c.role === 'searchbox' || c.role === 'combobox' || c.role === 'textbox' ||
      (c.tag === 'input' && (c.type === 'search' || c.type === 'text')) ||
      c.tag === 'textarea' ||
      (c.placeholder || '').toLowerCase().includes('search') ||
      (c.ariaLabel || '').toLowerCase().includes('search')
    );

    if (!searchInput) {
      return { success: false, response: { text: 'No search input or textbox found on this page.' } };
    }

    const el = this._resolveElement(searchInput);
    if (!el) {
      return { success: false, response: { text: 'Found search input candidate but couldn\'t resolve element.' } };
    }

    const engine = await this._ensureHumanEngine();
    if (engine) {
      await engine.click(el);
      await engine._sleep(300);
      await engine.type(query);
      await engine._sleep(200);
      // Phase 1B.2.1: Register intent before Enter (Enter triggers navigation)
      await this._registerIntent('search', searchInput, query);
      await engine.pressKey('Enter', 'Enter', 13);
    } else {
      el.focus();
      el.value = query;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.form?.submit();
    }

    return {
      success: true,
      response: {
        text: `Searched for "${query}". Page will update with results.`,
        data: { action: 'search', query }
      }
    };
  }

  async _handleScroll(direction) {
    const engine = await this._ensureHumanEngine();
    const distance = direction === 'up' ? -500 : 500;

    if (engine) {
      await engine.scroll(distance);
    } else {
      window.scrollBy({ top: distance, behavior: 'smooth' });
    }

    return {
      success: true,
      response: {
        text: `Scrolled ${direction === 'up' ? 'up' : 'down'} ${Math.abs(distance)}px.`,
        data: { action: 'scroll', direction, distance, currentY: window.scrollY }
      }
    };
  }

  async _handleScrollTo(target) {
    const lower = target.toLowerCase();

    // Find heading or section matching target text
    const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    let targetEl = headings.find(h => h.textContent.trim().toLowerCase() === lower);
    if (!targetEl) {
      targetEl = headings.find(h => h.textContent.toLowerCase().includes(lower));
    }

    if (!targetEl) {
      return { success: false, response: { text: `Could not find section "${target}" on this page.` } };
    }

    const engine = await this._ensureHumanEngine();
    if (engine) {
      // Compute scroll distance
      const rect = targetEl.getBoundingClientRect();
      const targetY = window.scrollY + rect.top - window.innerHeight * 0.33;
      const distance = targetY - window.scrollY;
      await engine.scroll(distance);
    } else {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    const sectionText = (targetEl.textContent || '').trim().substring(0, 100);

    return {
      success: true,
      response: {
        text: `Scrolled to "${sectionText}".`,
        data: { action: 'scroll-to', target: sectionText }
      }
    };
  }

  async _handleRead() {
    const title = document.title;
    const url = window.location.href;
    const metaDesc = document.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    // Headings
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(h => ({ level: h.tagName.toLowerCase(), text: (h.textContent || '').trim() }))
      .filter(h => h.text.length > 0);

    // Main content paragraphs
    const mainEl = document.querySelector('[role="main"], #main, main, article') || document.body;
    const paragraphs = Array.from(mainEl.querySelectorAll('p'))
      .map(p => (p.textContent || '').trim())
      .filter(t => t.length > 20)
      .slice(0, 10);

    // Visible links
    const links = Array.from(document.querySelectorAll('a'))
      .filter(a => a.offsetParent !== null && a.href && a.textContent.trim().length > 0)
      .map(a => ({ text: a.textContent.trim().substring(0, 60), href: a.href }))
      .slice(0, 30);

    // Interactive elements summary
    const candidates = await this._runBrainPipeline();
    const typeCounts = {};
    for (const c of candidates) {
      const t = c.nodeType || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
    }

    // Build summary
    const lines = [
      `═ ${title} ═`,
      `URL: ${url}`,
      `Hostname: ${window.location.hostname}`
    ];
    if (metaDesc) lines.push(`Description: ${metaDesc}`);
    lines.push('');

    if (headings.length > 0) {
      lines.push('HEADINGS:');
      headings.forEach(h => lines.push(`  ${h.level}: ${h.text}`));
      lines.push('');
    }

    if (paragraphs.length > 0) {
      lines.push(`CONTENT (${paragraphs.length} paragraphs):`);
      paragraphs.slice(0, 5).forEach(p => lines.push(`  ${p.substring(0, 200)}`));
      lines.push('');
    }

    lines.push(`INTERACTIVE ELEMENTS: ${candidates.length}`);
    lines.push(`  Types: ${Object.entries(typeCounts).map(([t, c]) => `${t}: ${c}`).join(', ')}`);
    lines.push('');

    if (links.length > 0) {
      lines.push(`LINKS (${links.length}):`);
      links.slice(0, 15).forEach(l => lines.push(`  "${l.text}" → ${l.href}`));
    }

    return {
      success: true,
      response: {
        text: lines.join('\n'),
        data: {
          action: 'read', title, url,
          headings, paragraphs: paragraphs.slice(0, 5),
          interactiveCount: candidates.length,
          typeCounts, links: links.slice(0, 30)
        }
      }
    };
  }

  async _handleExpand(target) {
    const candidates = await this._runBrainPipeline([target]);

    // Find expandable element (dynamic_trigger or aria-expanded)
    const expandable = candidates.find(c => {
      const text = (c.innerText || '').toLowerCase();
      const label = (c.ariaLabel || '').toLowerCase();
      return (text.includes(target.toLowerCase()) || label.includes(target.toLowerCase())) &&
             (c.nodeType === 'dynamic_trigger' || c.ariaExpanded !== undefined || c.ariaHaspopup);
    }) || this._findBestMatch(candidates, target);

    if (!expandable) {
      return { success: false, response: { text: `Could not find expandable element "${target}".` } };
    }

    const el = this._resolveElement(expandable);
    if (!el) {
      return { success: false, response: { text: `Found expandable but couldn't resolve element.` } };
    }

    const wasExpanded = el.getAttribute('aria-expanded') === 'true';

    const engine = await this._ensureHumanEngine();
    if (engine) {
      await engine.click(el);
    } else {
      el.click();
    }

    await this._sleep(800);

    const isNowExpanded = el.getAttribute('aria-expanded') === 'true';
    const action = wasExpanded ? 'Collapsed' : 'Expanded';

    // Try to read expanded content
    let expandedContent = '';
    const controlledId = el.getAttribute('aria-controls');
    if (controlledId) {
      const panel = document.getElementById(controlledId);
      if (panel) expandedContent = (panel.textContent || '').trim().substring(0, 500);
    }

    return {
      success: true,
      response: {
        text: `${action} "${target}".${expandedContent ? '\nContent: ' + expandedContent : ''}`,
        data: { action: 'expand', target, wasExpanded, isNowExpanded, expandedContent }
      }
    };
  }

  async _handleNavigate(target) {
    // Navigate = find a link and click it
    const candidates = await this._runBrainPipeline([target]);

    // Prefer navigation_link type
    const navLinks = candidates.filter(c => c.nodeType === 'navigation_link' || c.tag === 'a');
    const match = this._findBestMatch(navLinks.length > 0 ? navLinks : candidates, target);

    if (!match) {
      return { success: false, response: { text: `Could not find navigation target "${target}".` } };
    }

    const el = this._resolveElement(match);
    if (!el) {
      return { success: false, response: { text: `Found link but couldn't resolve element.` } };
    }

    const href = el.href || el.getAttribute('href') || '';
    const linkText = (match.innerText || '').substring(0, 60);

    // Phase 1B.2.1: Register intent before navigation click
    await this._registerIntent('navigate', match, target);

    // Schedule click after response is posted (page may navigate away)
    const engine = await this._ensureHumanEngine();
    setTimeout(async () => {
      if (engine) {
        await engine.click(el);
      } else {
        el.click();
      }
    }, 300);

    return {
      success: true,
      response: {
        text: `Navigating to "${linkText}" → ${href}. Page will reload — send next command after 2-3 seconds.`,
        data: { action: 'navigate', target, href, linkText, willNavigate: true }
      }
    };
  }

  /**
   * Handle 'back' intent — navigate back in browser history.
   * Phase 1B.1: Used by UniversalStrategy for soft backtracking after
   *             bad navigations that decreased progress.
   *
   * For SPAs (pushState/replaceState): works reliably — content script survives.
   * For full page navigations: best-effort — content script may be torn down.
   *
   * @returns {Promise<Object>} Result with action data
   */
  async _handleBack() {
    const previousUrl = window.location.href;

    try {
      history.back();

      // Wait briefly for the navigation to initiate
      // For SPAs this resolves quickly; for full navs the script may die here
      await new Promise(resolve => setTimeout(resolve, 500));

      const newUrl = window.location.href;
      const didNavigate = newUrl !== previousUrl;

      return {
        success: true,
        response: {
          text: didNavigate
            ? `Navigated back from ${previousUrl} to ${newUrl}`
            : `Called history.back() (page may be reloading)`,
          data: {
            action: 'back',
            previousUrl,
            currentUrl: newUrl,
            didNavigate,
            nodeType: 'navigation_link', // For stability watcher effect detection
            tag: 'history',
            role: '',
            text: 'back'
          }
        }
      };
    } catch (e) {
      return {
        success: false,
        response: {
          text: `history.back() failed: ${e.message}`,
          data: { action: 'back', error: e.message }
        }
      };
    }
  }

  async _handleStatus() {
    const engine = await this._ensureHumanEngine();
    const debugState = engine ? engine.getDebugState() : null;

    return {
      success: true,
      response: {
        text: [
          `[Brain Status]`,
          `URL: ${window.location.href}`,
          `Hostname: ${window.location.hostname}`,
          `Title: ${document.title}`,
          `HumanEngine: ${engine ? 'Ready' : 'Not available'}`,
          `DOMRecon: ${BrowserAgent.DOMRecon ? 'Loaded' : 'Not loaded'}`,
          `CandidatePruner: ${BrowserAgent.CandidatePruner ? 'Loaded' : 'Not loaded'}`,
          `ContextBuilder: ${BrowserAgent.ContextBuilder ? 'Loaded' : 'Not loaded'}`,
          `StealthAudit: ${BrowserAgent.StealthAudit ? 'Loaded' : 'Not loaded'}`,
          `ImageExtractor: ${BrowserAgent.ImageExtractor ? 'Loaded' : 'Not loaded'}`,
          `NodeClassifier: ${BrowserAgent.NodeClassifier ? 'Loaded' : 'Not loaded'}`,
          `POMDPEngine: ${this.engine ? 'Active' : 'Not active'}`,
        ].join('\n'),
        data: { engine: debugState }
      }
    };
  }

  // ═══════════════════════════════════════════════════════════════
  //  MAIN ENTRY POINT
  // ═══════════════════════════════════════════════════════════════

  /**
   * Execute a command. This is the single entry point called by content.js.
   *
   * @param {string} prompt - Natural language command
   * @param {Object[]} [images=[]] - Attached images (for future use)
   * @param {Object} [options={}] - Execution options
   * @param {boolean} [options.skipClarification=false] - Skip the pre-action
   *   clarification gate.  Used by UniversalStrategy during recovery actions
   *   to prevent the same escalation from blocking the corrective attempt.
   * @returns {Promise<Object>} Result with { success, response: { text, data } }
   */
  async executeFullFlow(prompt, images = [], options = {}) {
    const flowStart = Date.now();

    try {
      console.log('[Brain] ═══════════════════════════════════════');
      console.log(`[Brain] Command: "${prompt}"`);
      console.log(`[Brain] URL: ${window.location.href}`);

      // ─── Phase 1A.3b: Lazy Task Initialization ───
      // Ensure a task is active in the service worker.
      // First prompt → initializes task (prompt = goal).
      // Subsequent prompts → updates instruction OR detects goal shift.
      let goalTokens = [];
      if (BrowserAgent.ProgressEstimator) {
        try {
          const taskInfo = await BrowserAgent.ProgressEstimator.ensureTaskActive(prompt);
          goalTokens = taskInfo.goalTokens || [];
        } catch (e) {
          console.warn('[Brain] Task init error (non-fatal):', e.message);
        }
      }

      // ─── Phase 1A.3c: Pre-Action Clarification Gate ───
      // Check if the agent should ask the user before acting.
      // Budget exhaustion is checked first (instant, no pipeline needed).
      // Other triggers are checked after the pipeline produces candidates.
      // Phase 1B.1: skipClarification allows recovery actions to bypass this gate.
      if (BrowserAgent.ClarificationEngine && !options.skipClarification) {
        try {
          // Fetch context for clarification evaluation
          const clarCtx = BrowserAgent.ContextBuilder
            ? await BrowserAgent.ContextBuilder._fetchContext()
            : { taskState: null, loopStatus: null, isTaskActive: false };

          const clarResult = BrowserAgent.ClarificationEngine.evaluate({
            taskState: clarCtx.taskState,
            loopStatus: clarCtx.loopStatus,
            candidates: this._lastCandidates || [],
            goalTokens
          });

          if (clarResult.escalate) {
            console.warn(`[Brain] ⚠ Clarification triggered: ${clarResult.reason} (${clarResult.severity})`);
            return {
              success: false,
              status: clarResult.status,
              reason: clarResult.reason,
              severity: clarResult.severity,
              clarificationContext: clarResult.context,
              response: {
                text: `Agent needs clarification: ${clarResult.reason}. ${this._buildClarificationMessage(clarResult)}`,
                data: { clarification: clarResult }
              },
              totalTime: Date.now() - flowStart,
              diagnostics: BrowserAgent.Diagnostics ? BrowserAgent.Diagnostics.flush() : []
            };
          }
        } catch (e) {
          console.warn('[Brain] Clarification check error (non-fatal):', e.message);
        }
      }

      const { intent, target, text } = this._parseIntent(prompt);
      console.log(`[Brain] Intent: ${intent}, Target: "${target}", Text: "${text}"`);

      // ─── Phase 1A.3b: Pre-Action Snapshot ───
      // Capture DOM baseline BEFORE the action modifies it.
      // Used later by the Progress Estimator to detect what changed.
      let preActionSnapshot = null;
      const isEvaluableAction = ['click', 'type', 'search', 'navigate', 'expand', 'back'].includes(intent);
      if (BrowserAgent.ProgressEstimator && isEvaluableAction) {
        preActionSnapshot = BrowserAgent.ProgressEstimator.captureSnapshot();
      }

      let result;

      switch (intent) {
        case 'click':
          result = await this._handleClick(target);
          break;

        case 'type':
          result = await this._handleType(target, text);
          break;

        case 'search':
          result = await this._handleSearch(text);
          break;

        case 'scroll':
          result = await this._handleScroll(target);
          break;

        case 'scroll-to':
          result = await this._handleScrollTo(target);
          break;

        case 'read':
          result = await this._handleRead();
          break;

        case 'expand':
          result = await this._handleExpand(target);
          break;

        case 'navigate':
          result = await this._handleNavigate(target);
          break;

        // Phase 1B.1: History back — soft backtracking after bad navigations
        case 'back':
          result = await this._handleBack();
          break;

        case 'stealth-audit':
          if (BrowserAgent.StealthAudit) {
            const audit = await BrowserAgent.StealthAudit.run();
            result = { success: true, response: { text: audit.text, data: audit } };
          } else {
            result = { success: false, response: { text: 'StealthAudit module not loaded.' } };
          }
          break;

        case 'extract-images':
          if (BrowserAgent.ImageExtractor) {
            const extraction = await BrowserAgent.ImageExtractor.extractFromPage();
            result = { success: true, response: { text: extraction.text, data: extraction } };
          } else {
            result = { success: false, response: { text: 'ImageExtractor module not loaded.' } };
          }
          break;

        case 'status':
          result = await this._handleStatus();
          break;

        default:
          result = {
            success: false,
            response: {
              text: `Unknown command. Available: click, type, search, scroll, read, navigate, back, expand, stealth-audit, extract-images, status`,
              data: { availableCommands: ['click', 'type', 'search', 'scroll', 'read', 'navigate', 'back', 'expand', 'stealth-audit', 'extract-images', 'status'] }
            }
          };
      }

      // ─── Phase 1A.3a: Post-Action Stabilization Gate ───
      // If the action modified the page, wait for the DOM to settle
      let stabilityResult = null;
      if (result.success && isEvaluableAction) {
        let expectedEffect = null;
        if (intent === 'navigate' || (intent === 'click' && result.response.data?.nodeType === 'navigation_link')) {
          expectedEffect = 'navigation';
        }

        const watcher = new BrowserAgent.DOMStabilityWatcher({
          lastActionType: intent,
          expectedEffect: expectedEffect
        });

        stabilityResult = await watcher.waitForStability();
        console.log('[Brain] Stability result:', stabilityResult);

        // ─── Phase 1A.3b: Post-Action Progress Evaluation ───
        // After stability resolves, measure whether the action helped.
        // Uses the pre-action snapshot to detect what changed.
        if (BrowserAgent.ProgressEstimator && preActionSnapshot) {
          try {
            // Build action context from the handler's result data
            const actionContext = this._buildActionContext(intent, target, text, result);
            const progressResult = await BrowserAgent.ProgressEstimator.evaluate(
              preActionSnapshot,
              actionContext,
              stabilityResult,
              goalTokens
            );
            result.progress = progressResult;
          } catch (e) {
            console.warn('[Brain] Progress evaluation error (non-fatal):', e.message);
          }
        }

        // ─── Phase 1A.3c: Capture disabled signatures for next cycle ───
        // After action + evaluation, snapshot which elements are currently
        // disabled. Used by ActionContext.recently_enabled in the next cycle.
        if (BrowserAgent.ActionContext && this._lastCandidates) {
          this._previousDisabledSignatures =
            BrowserAgent.ActionContext.captureDisabledSignatures(this._lastCandidates);
        }
      }

      result.totalTime = Date.now() - flowStart;
      result.engineStatus = this.engine ? this.engine.getStatus() : null;
      result.diagnostics = BrowserAgent.Diagnostics ? BrowserAgent.Diagnostics.flush() : [];

      console.log(`[Brain] ✓ Complete (${result.totalTime}ms) — success: ${result.success}`);
      if (result.progress) {
        console.log(`[Brain] Progress: ${result.progress.progress?.toFixed(3) || 'N/A'} (effect: ${result.progress.effect || 'N/A'})`);
      }
      console.log('[Brain] ═══════════════════════════════════════');

      return result;

    } catch (e) {
      console.error('[Brain] ✗ Error:', e.message);
      console.error('[Brain] Stack:', e.stack);
      return {
        success: false,
        error: e.message,
        response: { text: `Error: ${e.message}` },
        totalTime: Date.now() - flowStart,
        engineStatus: this.engine ? this.engine.getStatus() : null
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  ACTION CONTEXT BUILDER — For Progress Estimator
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build an actionContext object from the handler's result for the
   * Progress Estimator. Extracts the action type, target element info,
   * and DOM element reference (when available) for micro-success detection.
   *
   * @param {string} intent - Parsed intent type
   * @param {string} target - Target text from parsed prompt
   * @param {string} text - Text value from parsed prompt
   * @param {Object} result - Handler result { success, response: { text, data } }
   * @returns {Object} Action context for Progress Estimator
   */
  _buildActionContext(intent, target, text, result) {
    const data = result.response?.data || {};

    const context = {
      type: intent,
      target: target || '',
      text: data.text || text || target || '',
      tag: data.tag || '',
      role: data.role || '',
      nodeType: data.nodeType || '',
      href: data.href || '',
      boundingBox: data.boundingBox || null,
      element: null // DOM element reference (set below if possible)
    };

    // Try to resolve the DOM element for micro-success checks
    // (e.g., checking if an input has been filled, if a checkbox changed)
    if (data.text && result.success) {
      try {
        // For type/search actions, find the input that was typed into
        if (intent === 'type' || intent === 'search') {
          const inputs = document.querySelectorAll('input, textarea, [role="textbox"], [role="searchbox"]');
          for (const el of inputs) {
            if (document.activeElement === el || (el.value && el.value.includes(text))) {
              context.element = el;
              context.tag = el.tagName.toLowerCase();
              break;
            }
          }
        }
        // For click actions, try to find the clicked element by text
        else if (intent === 'click' || intent === 'expand') {
          const clickedText = data.text;
          if (clickedText) {
            const allClickable = document.querySelectorAll('a, button, [role="button"], [role="tab"]');
            for (const el of allClickable) {
              if ((el.textContent || '').trim().substring(0, 60) === clickedText) {
                context.element = el;
                context.tag = el.tagName.toLowerCase();
                break;
              }
            }
          }
        }
      } catch (e) {
        // Element resolution failure is non-fatal for progress estimation
      }
    }

    return context;
  }

  // ═══════════════════════════════════════════════════════════════
  //  EXPECTED OUTCOME PRIOR — Phase 1A.3c Heuristic Value Estimate
  // ═══════════════════════════════════════════════════════════════

  /**
   * Apply heuristic expected outcome prior to candidates.
   * This is DECISION LOGIC — not feature extraction (that's ActionContext).
   *
   * Multiplies each candidate's pruner score by a context-dependent
   * value estimate (0.1 to 0.9). Answers: "If I act on this node,
   * what's the probability of a good outcome?"
   *
   * Rules (from Plan §5, v2.5):
   *   - Primary button + filled inputs nearby → 0.9 (high-value submit)
   *   - Recently enabled element            → 0.85 (state just changed for us)
   *   - Unvisited input field               → 0.7 (productive exploration)
   *   - Goal-relevant element               → 0.6 (aligned with task)
   *   - Nav region, not goal-related        → 0.2 (likely distraction)
   *   - DOM missing (can't resolve element) → 0.15 (can't interact)
   *   - Known failure                       → 0.1 (tried and failed)
   *   - Default                             → 0.4
   *
   * @param {Object[]} candidates - Candidates with ActionContext + Context enrichment
   */
  _applyExpectedOutcomePrior(candidates) {
    // Check if ANY filled inputs exist on the page (from ActionContext stats)
    // This is used for the "primary button + filled input" rule
    const hasFilledInputs = candidates.some(c =>
      c._ac_distance_to_filled_input !== undefined && c._ac_distance_to_filled_input < 0.3
    );

    for (const node of candidates) {
      let outcome = 0.4; // default

      // ── DOM unresolvable → very low (can't interact with it) ──
      if (node._ac_dom_missing) {
        node._expectedOutcome = 0.15;
        continue;
      }

      // ── Known failure → lowest (tried before, produced bad result) ──
      if (node._failurePenalty && node._failurePenalty < 1) {
        node._expectedOutcome = 0.1;
        continue;
      }

      // ── Primary button + filled inputs → highest (submit action) ──
      if (node._ac_is_primary_button && hasFilledInputs) {
        outcome = 0.9;
      }
      // ── Recently enabled → very high (state changed for us) ──
      else if (node._ac_recently_enabled) {
        outcome = 0.85;
      }
      // ── Unvisited input field → high (productive input) ──
      else if ((node.nodeType === 'input_field' || node.nodeType === 'dynamic_trigger') &&
               !node._visitedBefore) {
        outcome = 0.7;
      }
      // ── Goal-relevant → medium-high ──
      else if (node._goalTokenOverlap && node._goalTokenOverlap > 0) {
        outcome = 0.6;
      }
      // ── Primary button (no filled inputs) → moderate ──
      else if (node._ac_is_primary_button) {
        outcome = 0.5;
      }
      // ── In-form element → slightly above default ──
      else if (node._ac_is_in_form) {
        outcome = 0.45;
      }
      // ── Nav region, not goal-related → low (likely distraction) ──
      else if (node._ac_is_in_nav_region && !node._ac_nav_region_goal_relevance) {
        outcome = 0.2;
      }

      // ── Last-in-form bonus: if form has filled inputs, boost ──
      if (node._ac_is_last_in_form && hasFilledInputs) {
        outcome = Math.max(outcome, 0.85);
      }

      node._expectedOutcome = outcome;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  //  CLARIFICATION MESSAGE BUILDER
  // ═══════════════════════════════════════════════════════════════

  /**
   * Build a human-readable clarification message for the bridge response.
   * @param {Object} clarResult - ClarificationEngine.evaluate() result
   * @returns {string}
   */
  _buildClarificationMessage(clarResult) {
    switch (clarResult.reason) {
      case 'budget_exhausted':
        return `Task has reached the maximum step limit (${clarResult.context?.stepIndex || '?'} steps). ` +
               `Please provide new instructions or confirm the task is complete.`;

      case 'persistent_loop':
        return `Agent is stuck in a behavioral loop (${clarResult.context?.loopType || 'unknown'} loop, ` +
               `${clarResult.context?.loopCycles || '?'} cycles). Please clarify what action to take.`;

      case 'no_progress':
        return `Agent has made no meaningful progress for several steps. ` +
               `Please verify the current approach or provide alternative instructions.`;

      case 'missing_input':
        return `There is a required input field on this page that the agent doesn't have ` +
               `information to fill. Please provide the needed data.`;

      case 'uncertain_and_stalling':
        return `Agent is uncertain about the next action and progress has stalled. ` +
               `Uncertainty: ${clarResult.context?.uncertainty || '?'}. ` +
               `Please confirm or clarify the next step.`;

      default:
        return `Agent needs guidance to proceed. Reason: ${clarResult.reason}.`;
    }
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
};
