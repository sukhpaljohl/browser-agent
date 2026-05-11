/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Goal Completion & Terminal State Recognition — Phase 1B.2
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Determines whether the agent's current task goal has been achieved.
 *           Prevents infinite loops by recognizing terminal states, and generates
 *           rich feature vectors for future self-supervised learning (Phase 2).
 *
 * Pipeline position:
 *   Act → [StabilityWatcher] → [ProgressEstimator] → [GoalCompletion] → done?
 *
 * Architecture (Three Components):
 *   1. GoalParser        — Converts goal text → structured intent (runs ONCE per task)
 *   2. PageStateAnalyzer  — 6 structural detectors (runs EVERY step)
 *   3. GoalCompletionEvaluator — Corroboration scoring + terminal decision (EVERY step)
 *
 * Dual-Purpose Design:
 *   - Working System (Now): Hardcoded rules provide ~70-80% accuracy TODAY
 *   - Training Data (Phase 2): Every evaluation emits a 32-feature vector
 *     stored by Experience Buffer (Phase 1B.4) for future model training
 *
 * Ref: Implementation Plan — Phase 1B.2 Design Document
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var BrowserAgent = BrowserAgent || {};

// ═══════════════════════════════════════════════════════════════════════════════
//  GOAL PARSER — Understanding the Goal (runs ONCE per task)
// ═══════════════════════════════════════════════════════════════════════════════

BrowserAgent.GoalParser = (() => {
  'use strict';

  // ─── Verb Classification Patterns ──────────────────────────────────────────
  // Priority-ordered phrase matching. Longer phrases match first within each
  // category. Categories are checked in order: purchase → login → fill →
  // search → navigate → read. 'interact' is the fallback.

  const VERB_PATTERNS = {
    purchase: [
      'add to cart', 'add to bag', 'add to basket',
      'buy', 'purchase', 'order', 'get me', 'shop for'
    ],
    login: [
      'log in', 'login', 'sign in', 'signin', 'authenticate'
    ],
    fill: [
      'fill out', 'fill in', 'complete the form', 'submit the form',
      'register', 'sign up', 'signup', 'subscribe', 'enroll'
    ],
    search: [
      'search for', 'search', 'find', 'look for', 'look up',
      'browse for', 'browse'
    ],
    navigate: [
      'go to', 'navigate to', 'open', 'visit', 'take me to'
    ],
    read: [
      'check', 'show me', 'what is', 'what are', 'how much',
      'how many', 'read', 'view', 'see', 'tell me', 'compare'
    ]
    // 'interact' is the fallback — no patterns needed
  };

  // Verb check order — determines priority when multiple verbs could match
  const VERB_CHECK_ORDER = ['purchase', 'login', 'fill', 'search', 'navigate', 'read'];

  // Site reference patterns to strip from target extraction
  const SITE_REFERENCE_PATTERN = /\b(?:on|at|from)\s+(?:(?:www\.)?[a-z0-9-]+\.(?:com|org|net|io|co|uk|in|edu|gov)(?:\.[a-z]{2})?)\b/gi;

  // Filler phrases to strip from goal before target extraction
  const FILLER_PATTERNS = [
    /^(?:please|pls|kindly)\s+/i,
    /^(?:can you|could you|would you|i want to|i need to|i'd like to|i would like to)\s+/i,
  ];

  // Articles and boundary prepositions to strip
  const STRIPPED_WORDS = new Set(['the', 'a', 'an', 'for', 'to', 'from', 'some', 'any']);

  // Terminal expectation mapping — what "done" looks like for each verb
  const TERMINAL_MAP = {
    search:   { expectation: 'search_results_visible', primaryDetector: 'searchResults',  safeDepth: 'unlimited' },
    purchase: { expectation: 'cart_added',             primaryDetector: 'cartAdded',       safeDepth: 'cart' },
    navigate: { expectation: 'page_arrived',           primaryDetector: 'pageArrival',     safeDepth: 'unlimited' },
    login:    { expectation: 'login_success',          primaryDetector: 'loginSuccess',    safeDepth: 'unlimited' },
    fill:     { expectation: 'form_submitted',         primaryDetector: 'formSuccess',     safeDepth: 'unlimited' },
    read:     { expectation: 'content_visible',        primaryDetector: 'contentVisible',  safeDepth: 'unlimited' },
    interact: { expectation: 'state_changed',          primaryDetector: 'stateChanged',    safeDepth: 'unlimited' },
  };

  /**
   * Tokenize text — MUST match task-state.js and progress-estimator.js exactly.
   * @param {string} text
   * @returns {string[]}
   */
  const STOPWORDS = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'no', 'than', 'too', 'very',
    'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that'
  ]);

  function _tokenize(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && !STOPWORDS.has(t));
  }

  /**
   * Extract site reference from goal text (e.g., "on apple.com" → "apple.com").
   * @param {string} goalText
   * @returns {string|null}
   */
  function _extractSiteReference(goalText) {
    const match = goalText.match(/\b(?:on|at|from)\s+((?:www\.)?([a-z0-9-]+\.(?:com|org|net|io|co|uk|in|edu|gov)(?:\.[a-z]{2})?))\b/i);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Parse a natural language goal into a structured intent.
   *
   * @param {string} goalText - Raw goal text from the user
   * @returns {Object} Parsed goal { verb, target, targetTokens, targetSite, ... }
   */
  function parse(goalText) {
    if (!goalText || typeof goalText !== 'string') {
      return _fallbackParsedGoal(goalText || '');
    }

    const lower = goalText.toLowerCase().trim();
    let verb = 'interact';
    let matchedPhrase = '';
    let confidence = 0.5; // default for fallback

    // Step 1: Classify verb (priority order, longest match within each category)
    for (const category of VERB_CHECK_ORDER) {
      const phrases = VERB_PATTERNS[category];
      // Sort by length descending — longest match wins
      const sorted = [...phrases].sort((a, b) => b.length - a.length);

      for (const phrase of sorted) {
        if (lower.includes(phrase)) {
          verb = category;
          matchedPhrase = phrase;
          confidence = 0.9;
          break;
        }
      }
      if (verb !== 'interact') break;
    }

    // Step 2: Special override — if goal has site + purchase verb, force purchase
    const targetSite = _extractSiteReference(goalText);
    if (targetSite && verb !== 'purchase') {
      // Check if any purchase verb is present
      for (const phrase of VERB_PATTERNS.purchase) {
        if (lower.includes(phrase)) {
          verb = 'purchase';
          matchedPhrase = phrase;
          confidence = 0.95;
          break;
        }
      }
    }

    // Step 3: Extract target entity
    let remaining = goalText.trim();

    // Remove matched verb phrase
    if (matchedPhrase) {
      const idx = remaining.toLowerCase().indexOf(matchedPhrase);
      if (idx !== -1) {
        remaining = remaining.substring(0, idx) + remaining.substring(idx + matchedPhrase.length);
      }
    }

    // Remove site references
    remaining = remaining.replace(SITE_REFERENCE_PATTERN, '');

    // Remove filler phrases
    for (const pattern of FILLER_PATTERNS) {
      remaining = remaining.replace(pattern, '');
    }

    // Remove articles and boundary prepositions (only standalone words)
    remaining = remaining
      .split(/\s+/)
      .filter(w => !STRIPPED_WORDS.has(w.toLowerCase()))
      .join(' ')
      .trim();

    // Clean up multiple spaces and trailing punctuation
    remaining = remaining.replace(/\s{2,}/g, ' ').replace(/[.,!?;:]+$/, '').trim();

    const target = remaining;
    const targetTokens = _tokenize(target);

    // Step 4: Map to terminal expectation
    const terminalInfo = TERMINAL_MAP[verb] || TERMINAL_MAP.interact;

    const parsed = {
      verb,
      target,
      targetTokens,
      targetSite: targetSite || null,
      terminalExpectation: terminalInfo.expectation,
      primaryDetector: terminalInfo.primaryDetector,
      safeDepth: terminalInfo.safeDepth,
      confidence,
      source: 'regex',
      constraints: {},
      raw: goalText
    };

    console.log(`[GoalParser] Parsed: "${goalText}" → verb=${verb}, target="${target}", tokens=[${targetTokens.join(', ')}]`);
    return parsed;
  }

  /**
   * Fallback for unparseable goals.
   */
  function _fallbackParsedGoal(raw) {
    return {
      verb: 'interact',
      target: raw,
      targetTokens: _tokenize(raw),
      targetSite: null,
      terminalExpectation: 'state_changed',
      primaryDetector: 'stateChanged',
      safeDepth: 'unlimited',
      confidence: 0.3,
      source: 'regex',
      constraints: {},
      raw
    };
  }


  // ─── Verb Normalization (JSON schema → TERMINAL_MAP key) ─────────────────
  // The external JSON schema uses verbs that may not exist in TERMINAL_MAP.
  // This map aliases them to the closest existing verb.
  const VERB_ALIASES = {
    compare: 'search',   // comparing = finding results side-by-side
  };

  /**
   * Convert a structured JSON goal object from the external labeling system
   * into the same output shape as parse().
   *
   * The external system (LLM, API, etc.) produces JSON conforming to the
   * labeling_system_prompt.txt schema:
   *   { verb, target, site, constraints, condition, complexity, task_type }
   *
   * This method maps that schema to GoalParser's internal format, ensuring
   * full backward compatibility with all downstream consumers (PageStateAnalyzer,
   * GoalCompletionEvaluator, ProgressEstimator, ClarificationEngine).
   *
   * The `constraints` field is passed through verbatim so that
   * detectDecisionPoints() can use it for auto-resolution (e.g., if the
   * user specified color: "blue", the agent won't ask again).
   *
   * @param {Object} jsonObj - Structured goal from external parser
   * @param {string} jsonObj.verb - Action verb (search, purchase, navigate, etc.)
   * @param {string} jsonObj.target - Product/entity noun phrase
   * @param {string|null} [jsonObj.site] - Target website domain
   * @param {Object} [jsonObj.constraints={}] - Task constraints (color, size, brand, etc.)
   * @param {Object|null} [jsonObj.condition] - Conditional logic (if/then/else)
   * @param {string} [jsonObj.complexity] - simple | constrained
   * @param {string} [jsonObj.task_type] - Semantic task category
   * @returns {Object} Parsed goal in the same shape as parse()
   */
  function fromJSON(jsonObj) {
    if (!jsonObj || typeof jsonObj !== 'object') {
      console.warn('[GoalParser] fromJSON() received non-object input, falling back');
      return _fallbackParsedGoal(JSON.stringify(jsonObj) || '');
    }

    // ── Step 1: Normalize verb ──
    let verb = (jsonObj.verb || 'interact').toLowerCase().trim();

    // Apply aliases for verbs not in TERMINAL_MAP
    if (VERB_ALIASES[verb]) {
      verb = VERB_ALIASES[verb];
    }

    // Validate against known verbs — if unknown, fall back to 'interact'
    if (!TERMINAL_MAP[verb]) {
      console.warn(`[GoalParser] fromJSON: unknown verb "${jsonObj.verb}", falling back to interact`);
      verb = 'interact';
    }

    // ── Step 2: Extract target and tokens ──
    const target = (jsonObj.target || '').trim();
    const targetTokens = _tokenize(target);

    // ── Step 3: Normalize site ──
    // The JSON schema uses "site" while GoalParser uses "targetSite"
    let targetSite = null;
    if (jsonObj.site && typeof jsonObj.site === 'string') {
      targetSite = jsonObj.site.toLowerCase().trim();
      // Remove trailing TLD normalization — keep as-is per schema rules
    }

    // ── Step 4: Constraints pass-through ──
    // These are used by detectDecisionPoints() for auto-resolution.
    // Keys like color, size, storage, brand, etc. map directly to
    // product variant selectors on the page.
    const constraints = (jsonObj.constraints && typeof jsonObj.constraints === 'object')
      ? { ...jsonObj.constraints }
      : {};

    // ── Step 5: Map to terminal expectation ──
    const terminalInfo = TERMINAL_MAP[verb] || TERMINAL_MAP.interact;

    // ── Step 6: Confidence — external parsers are high-confidence ──
    const confidence = 0.95;

    const parsed = {
      verb,
      target,
      targetTokens,
      targetSite,
      terminalExpectation: terminalInfo.expectation,
      primaryDetector: terminalInfo.primaryDetector,
      safeDepth: terminalInfo.safeDepth,
      confidence,
      source: 'json',
      constraints,
      // Preserve optional metadata for diagnostics/logging
      taskType: jsonObj.task_type || null,
      complexity: jsonObj.complexity || null,
      condition: jsonObj.condition || null,
      raw: JSON.stringify(jsonObj)
    };

    console.log(
      `[GoalParser] fromJSON: verb=${verb}, target="${target}", ` +
      `tokens=[${targetTokens.join(', ')}], site=${targetSite}, ` +
      `constraints=${Object.keys(constraints).length} keys`
    );

    return parsed;
  }

  return { parse, fromJSON, _tokenize };
})();


// ═══════════════════════════════════════════════════════════════════════════════
//  PRE-ACTION SNAPSHOT — Delta Detection Foundation
// ═══════════════════════════════════════════════════════════════════════════════
//
// Captured BEFORE the action in UniversalStrategy.executeFullFlow().
// Used to compare pre/post state for delta-based detectors (cart, login, form).
// ═══════════════════════════════════════════════════════════════════════════════

BrowserAgent.GoalCompletionSnapshot = (() => {
  'use strict';

  // ─── Cart Badge Selectors (site-agnostic) ──────────────────────────────────
  const CART_SELECTORS = [
    'a[href*="cart"]', 'a[href*="bag"]', 'a[href*="basket"]', 'a[href*="trolley"]',
    '[aria-label*="cart" i]', '[aria-label*="bag" i]',
    '[aria-label*="basket" i]', '[aria-label*="shopping" i]',
    '[data-testid*="cart" i]', '[data-testid*="bag" i]',
    '[id*="cart" i]', '[id*="bag" i]', '[id*="basket" i]',
  ];

  /**
   * Get cart badge counts from all cart-related elements on page.
   * @returns {Array<{count: number, text: string}>}
   */
  function _getCartBadgeCounts() {
    const results = [];
    const seen = new Set();

    for (const selector of CART_SELECTORS) {
      try {
        for (const el of document.querySelectorAll(selector)) {
          if (seen.has(el)) continue;
          seen.add(el);

          const text = (el.innerText || '').trim();
          const match = text.match(/\d+/);
          const count = match ? parseInt(match[0], 10) : 0;
          results.push({ count, text });
        }
      } catch (e) { /* selector failed */ }
    }
    return results;
  }

  /**
   * Detect if a login form is present on the page.
   * @returns {boolean}
   */
  function _hasLoginForm() {
    try {
      const hasPassword = !!document.querySelector('input[type="password"]');
      if (!hasPassword) return false;
      // Also check for email/username input nearby
      const hasIdentity = !!document.querySelector(
        'input[type="email"], input[type="text"][name*="user" i], ' +
        'input[type="text"][name*="email" i], input[type="text"][name*="login" i], ' +
        'input[autocomplete="username"], input[autocomplete="email"]'
      );
      return hasIdentity;
    } catch (e) {
      return false;
    }
  }

  // Confirmation phrases that might already exist on page from previous actions
  const ALL_CONFIRMATION_PHRASES = [
    'added to cart', 'added to bag', 'added to basket',
    'added to your cart', 'added to your bag', 'added to your basket',
    'item added', 'items added', 'added successfully',
    'in your cart', 'in your bag', 'in your basket',
    'just added', 'cart updated', 'bag updated',
    'has been added', 'have been added',
    'thank you', 'thanks', 'successfully submitted', 'submission received',
    'form submitted', 'registered successfully', 'account created',
    'signed up', 'subscription confirmed', 'enrollment complete',
    'message sent', 'request received',
    'welcome', 'signed in as',
  ];

  /**
   * Get confirmation phrases already present on the page.
   * Used for delta detection — we only react to NEW confirmations.
   * @returns {Set<string>}
   */
  function _getExistingConfirmationPhrases() {
    const existing = new Set();
    try {
      const bodyText = document.body.innerText.substring(0, 8000).toLowerCase();
      for (const phrase of ALL_CONFIRMATION_PHRASES) {
        if (bodyText.includes(phrase)) {
          existing.add(phrase);
        }
      }
    } catch (e) { /* DOM access failure */ }
    return existing;
  }

  /**
   * Capture the pre-action snapshot for goal completion delta detection.
   * Called in UniversalStrategy BEFORE calling BrainExecutor.
   *
   * Cost: ~3-5ms. Six lightweight DOM queries.
   *
   * @returns {Object} Serializable snapshot (except Set which stays in-memory)
   */
  function capture() {
    const snapshot = {
      timestamp: Date.now(),
      url: location.href,

      // Cart state
      cartBadgeCounts: _getCartBadgeCounts(),

      // Login state
      hasPasswordField: !!document.querySelector('input[type="password"]'),
      hasLoginForm: _hasLoginForm(),

      // Confirmation state (Set — stays in content script memory, not serialized)
      confirmationPhrases: _getExistingConfirmationPhrases(),

      // Body text sample for delta text detection
      bodyTextSample: '',

      // Form state
      visibleInputCount: 0,
    };

    try {
      snapshot.bodyTextSample = document.body.innerText.substring(0, 8000).toLowerCase();
    } catch (e) {
      snapshot.bodyTextSample = '';
    }

    try {
      snapshot.visibleInputCount = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]), textarea, select'
      ).length;
    } catch (e) {
      snapshot.visibleInputCount = 0;
    }

    return snapshot;
  }

  return { capture };
})();


// ═══════════════════════════════════════════════════════════════════════════════
//  PAGE STATE ANALYZER — 6 Structural Detectors + Safety + Error + Loading
// ═══════════════════════════════════════════════════════════════════════════════
//
// All detectors are SITE-AGNOSTIC — NO class names, NO site-specific selectors.
// Pure structural/semantic/URL pattern detection.
// ═══════════════════════════════════════════════════════════════════════════════

BrowserAgent.PageStateAnalyzer = (() => {
  'use strict';

  // ─── Cart Confirmation Phrases (covers major retailers globally) ────────────
  const CART_CONFIRMATION_PHRASES = [
    'added to cart', 'added to bag', 'added to basket',
    'added to your cart', 'added to your bag', 'added to your basket',
    'item added', 'items added', 'added successfully',
    'in your cart', 'in your bag', 'in your basket',
    'just added', 'cart updated', 'bag updated',
    'has been added', 'have been added',
    'view cart', 'view bag', 'view basket',
    'go to cart', 'go to bag', 'go to basket',
    'continue shopping',
  ];

  const CART_URL_PATTERNS = ['/cart', '/bag', '/basket', '/shopping-cart', '/shopping-bag', '/trolley'];

  // ─── Login URL Patterns ────────────────────────────────────────────────────
  const LOGIN_URL_PATTERNS = [
    '/login', '/signin', '/sign-in', '/auth',
    '/account/login', '/accounts/login', '/user/login',
    '/session/new', '/sso'
  ];

  // ─── Dashboard Indicators (post-login signals) ─────────────────────────────
  const DASHBOARD_SELECTORS = [
    '[aria-label*="profile" i]', '[aria-label*="account" i]',
    '[aria-label*="inbox" i]', '[aria-label*="dashboard" i]',
    '[aria-label*="my account" i]', '[aria-label*="sign out" i]',
    '[aria-label*="log out" i]', '[aria-label*="logout" i]',
    'a[href*="logout"]', 'a[href*="signout"]',
    'img[alt*="avatar" i]', 'img[alt*="profile" i]',
  ];

  const WELCOME_PHRASES = ['welcome', 'hello', 'hi ', 'my account', 'dashboard', 'inbox', 'signed in as'];

  // ─── Form Success Phrases ──────────────────────────────────────────────────
  const FORM_SUCCESS_PHRASES = [
    'thank you', 'thanks', 'successfully submitted', 'submission received',
    'form submitted', 'registered successfully', 'account created',
    'signed up', 'subscription confirmed', 'enrollment complete',
    'message sent', 'request received', "we'll get back to you",
    'confirmation email', 'verify your email', 'check your inbox'
  ];

  const FORM_SUCCESS_URL_PATTERNS = ['/thank', '/thanks', '/success', '/confirm', '/welcome', '/registered', '/submitted'];

  // ─── Safety Boundary Selectors ─────────────────────────────────────────────
  const PAYMENT_FIELD_SELECTORS = [
    'input[autocomplete="cc-number"]', 'input[autocomplete="cc-exp"]',
    'input[autocomplete="cc-csc"]', 'input[name*="card" i]',
    'input[placeholder*="card number" i]',
  ];

  const PAYMENT_IFRAME_PATTERNS = ['stripe', 'paypal', 'braintree', 'adyen', 'checkout', 'payment'];

  const PAYMENT_ACTION_PHRASES = [
    'place order', 'place your order', 'submit order',
    'confirm purchase', 'complete purchase',
    'pay now', 'submit payment', 'process payment',
    'complete checkout', 'finalize order'
  ];

  const CHECKOUT_URL_PATTERNS = ['/checkout', '/payment', '/billing', '/pay', '/order/confirm'];

  // ─── Error Detection Phrases ───────────────────────────────────────────────
  const ERROR_PHRASES = [
    'error', 'failed', 'invalid', 'try again',
    'something went wrong', 'out of stock', 'unavailable',
    'not found', 'access denied', 'forbidden'
  ];


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR 1: Search Results
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect if the page displays search results containing the target entity.
   *
   * @param {Object} parsedGoal - From GoalParser
   * @param {Object} preSnapshot - Pre-action snapshot (unused for search — not delta)
   * @returns {Object} { detected, confidence, signals }
   */
  function detectSearchResults(parsedGoal, preSnapshot) {
    const signals = {
      urlHasSearchParam: false,
      hasRepeatedItems: false,
      repetitionCount: 0,
      targetPresenceOnPage: 0,
      searchInputHasTarget: false,
    };

    try {
      // Signal 1: URL has search parameters
      const url = location.href;
      try {
        const parsed = new URL(url);
        signals.urlHasSearchParam =
          /\/search(\b|\/|$)/i.test(parsed.pathname) ||
          parsed.searchParams.has('q') ||
          parsed.searchParams.has('query') ||
          parsed.searchParams.has('search') ||
          parsed.searchParams.has('s') ||
          parsed.searchParams.has('k');
      } catch (e) {
        signals.urlHasSearchParam = /[?&](q|query|search|s|k)=/i.test(url);
      }

      // Signal 2: Repeated sibling elements (≥3) with similar DOM structure
      const repetition = _detectRepeatedStructures();
      signals.hasRepeatedItems = repetition.found;
      signals.repetitionCount = repetition.count || 0;

      // Signal 3: Target tokens present in page content (>50% hit rate)
      if (parsedGoal.targetTokens.length > 0) {
        const mainEl = document.querySelector('main, [role="main"], article') || document.body;
        const pageText = (mainEl.innerText || '').slice(0, 10000).toLowerCase();
        let hits = 0;
        for (const token of parsedGoal.targetTokens) {
          if (pageText.includes(token)) hits++;
        }
        signals.targetPresenceOnPage = hits / parsedGoal.targetTokens.length;
      }

      // Signal 4: Search input field contains target text
      const searchInputs = document.querySelectorAll(
        'input[type="search"], input[type="text"][role="searchbox"], ' +
        'input[type="text"][name*="search" i], input[type="text"][name="q"], ' +
        'input[aria-label*="search" i]'
      );
      for (const input of searchInputs) {
        const val = (input.value || '').toLowerCase();
        if (val.length > 0 && parsedGoal.targetTokens.some(t => val.includes(t))) {
          signals.searchInputHasTarget = true;
          break;
        }
      }
    } catch (e) {
      console.warn('[PageStateAnalyzer] searchResults detector error:', e.message);
    }

    // Confidence formula
    const confidence =
      0.30 * (signals.urlHasSearchParam ? 1 : 0) +
      0.30 * (signals.hasRepeatedItems ? 1 : 0) +
      0.20 * (signals.targetPresenceOnPage > 0.5 ? 1 : signals.targetPresenceOnPage * 2) +
      0.20 * (signals.searchInputHasTarget ? 1 : 0);

    return {
      detected: confidence >= 0.45,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }

  /**
   * Detect repeated sibling structures (site-agnostic search result detection).
   * Finds containers where 3+ children share the same structural signature.
   */
  function _detectRepeatedStructures() {
    try {
      const main = document.querySelector('main, [role="main"], #content, .content, article')
                    || document.body;

      const candidates = [main, ...Array.from(main.children).filter(c => c.children.length > 3)];

      for (const container of candidates) {
        const children = Array.from(container.children);
        if (children.length < 3) continue;

        // Create structural "signature": tag + child count rounded to nearest 3
        const signatures = children.map(c => {
          const childCount = c.children.length;
          const roundedCC = Math.round(childCount / 3) * 3;
          return `${c.tagName}_${roundedCC}`;
        });

        // Count matching signatures
        const counts = {};
        for (const sig of signatures) {
          counts[sig] = (counts[sig] || 0) + 1;
        }

        const maxRepeat = Math.max(...Object.values(counts), 0);
        if (maxRepeat >= 3) {
          // Validation: each repeated item should have SOME text
          const dominantSig = Object.entries(counts).find(([, c]) => c === maxRepeat)?.[0];
          const matchingChildren = children.filter((c, i) => signatures[i] === dominantSig);
          const withText = matchingChildren.filter(c => (c.innerText || '').trim().length > 10);

          if (withText.length >= 3) {
            return { found: true, count: maxRepeat, hasText: true };
          }
        }
      }
    } catch (e) { /* DOM access failure */ }

    return { found: false, count: 0 };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR 2: Cart Added (Delta-Based)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detect if an item was just added to cart/bag/basket.
   * Uses DELTA detection — compares pre-snapshot vs current state.
   *
   * @param {Object} parsedGoal
   * @param {Object} preSnapshot - Pre-action snapshot
   * @returns {Object} { detected, confidence, signals }
   */
  function detectCartAdded(parsedGoal, preSnapshot) {
    const signals = {
      badgeDelta: 0,
      badgeIncreased: false,
      confirmationAppeared: false,
      confirmationPhrase: null,
      urlChangedToCart: false,
      targetStillVisible: false,
    };

    try {
      // Signal 1: Cart badge count INCREASED
      const currentBadges = _getCurrentCartBadgeCounts();
      const preBadges = preSnapshot.cartBadgeCounts || [];

      // Compare total counts
      const preTotal = preBadges.reduce((s, b) => s + b.count, 0);
      const currentTotal = currentBadges.reduce((s, b) => s + b.count, 0);
      signals.badgeDelta = currentTotal - preTotal;
      signals.badgeIncreased = signals.badgeDelta > 0;

      // Signal 2: Cart confirmation text APPEARED (not in pre-snapshot)
      const currentText = document.body.innerText.substring(0, 8000).toLowerCase();
      const prevText = preSnapshot.bodyTextSample || '';

      for (const phrase of CART_CONFIRMATION_PHRASES) {
        if (currentText.includes(phrase) && !prevText.includes(phrase)) {
          signals.confirmationAppeared = true;
          signals.confirmationPhrase = phrase;
          break;
        }
      }

      // Signal 3: URL changed to cart/bag/basket page
      const currentPath = location.pathname.toLowerCase();
      const prevPath = _extractPath(preSnapshot.url || '');
      if (currentPath !== prevPath) {
        for (const pattern of CART_URL_PATTERNS) {
          if (currentPath.includes(pattern)) {
            signals.urlChangedToCart = true;
            break;
          }
        }
      }

      // Signal 4: Target tokens still visible on page
      if (parsedGoal.targetTokens.length > 0) {
        let hits = 0;
        for (const token of parsedGoal.targetTokens) {
          if (currentText.includes(token)) hits++;
        }
        signals.targetStillVisible = (hits / parsedGoal.targetTokens.length) > 0.5;
      }
    } catch (e) {
      console.warn('[PageStateAnalyzer] cartAdded detector error:', e.message);
    }

    const confidence =
      0.40 * (signals.badgeIncreased ? 1 : 0) +
      0.40 * (signals.confirmationAppeared ? 1 : 0) +
      0.25 * (signals.urlChangedToCart ? 1 : 0) +
      0.10 * (signals.targetStillVisible ? 1 : 0);

    return {
      detected: confidence >= 0.35,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }

  /** Get current cart badge counts (same logic as snapshot). */
  function _getCurrentCartBadgeCounts() {
    const CART_SELS = [
      'a[href*="cart"]', 'a[href*="bag"]', 'a[href*="basket"]', 'a[href*="trolley"]',
      '[aria-label*="cart" i]', '[aria-label*="bag" i]',
      '[aria-label*="basket" i]', '[aria-label*="shopping" i]',
      '[data-testid*="cart" i]', '[data-testid*="bag" i]',
      '[id*="cart" i]', '[id*="bag" i]', '[id*="basket" i]',
    ];
    const results = [];
    const seen = new Set();
    for (const sel of CART_SELS) {
      try {
        for (const el of document.querySelectorAll(sel)) {
          if (seen.has(el)) continue;
          seen.add(el);
          const text = (el.innerText || '').trim();
          const match = text.match(/\d+/);
          results.push({ count: match ? parseInt(match[0], 10) : 0, text });
        }
      } catch (e) { /* skip */ }
    }
    return results;
  }

  /** Extract pathname from a URL string. */
  function _extractPath(urlStr) {
    try { return new URL(urlStr).pathname.toLowerCase(); }
    catch (e) { return ''; }
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR 3: Login Success (Delta-Based)
  // ═══════════════════════════════════════════════════════════════════════════

  function detectLoginSuccess(parsedGoal, preSnapshot) {
    const signals = {
      passwordFieldDisappeared: false,
      leftLoginPage: false,
      hasDashboardIndicators: false,
      hasWelcomeText: false,
    };

    try {
      // Signal 1: Password field was present, now GONE
      const currentHasPassword = !!document.querySelector('input[type="password"]');
      signals.passwordFieldDisappeared = preSnapshot.hasPasswordField && !currentHasPassword;

      // Signal 2: URL changed AWAY from login/signin path
      const prevPath = _extractPath(preSnapshot.url || '');
      const currentPath = location.pathname.toLowerCase();
      const wasOnLoginPage = LOGIN_URL_PATTERNS.some(p => prevPath.includes(p));
      const isOnLoginPage = LOGIN_URL_PATTERNS.some(p => currentPath.includes(p));
      signals.leftLoginPage = wasOnLoginPage && !isOnLoginPage;

      // Signal 3: Dashboard/profile/inbox indicators appeared
      for (const selector of DASHBOARD_SELECTORS) {
        try {
          if (document.querySelector(selector)) {
            signals.hasDashboardIndicators = true;
            break;
          }
        } catch (e) { /* invalid selector */ }
      }

      // Signal 4: Welcome/greeting text appeared
      const currentText = document.body.innerText.substring(0, 3000).toLowerCase();
      const prevText = preSnapshot.bodyTextSample.substring(0, 3000);
      for (const phrase of WELCOME_PHRASES) {
        if (currentText.includes(phrase) && !prevText.includes(phrase)) {
          signals.hasWelcomeText = true;
          break;
        }
      }
    } catch (e) {
      console.warn('[PageStateAnalyzer] loginSuccess detector error:', e.message);
    }

    const confidence =
      0.35 * (signals.passwordFieldDisappeared ? 1 : 0) +
      0.30 * (signals.leftLoginPage ? 1 : 0) +
      0.20 * (signals.hasDashboardIndicators ? 1 : 0) +
      0.15 * (signals.hasWelcomeText ? 1 : 0);

    return {
      detected: confidence >= 0.45,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR 4: Form Success (Delta-Based)
  // ═══════════════════════════════════════════════════════════════════════════

  function detectFormSuccess(parsedGoal, preSnapshot) {
    const signals = {
      successTextAppeared: false,
      successPhrase: null,
      inputCountDecreased: false,
      inputCountDelta: 0,
      successUrl: false,
      successToastPresent: false,
    };

    try {
      // Signal 1: Success/thank-you text APPEARED
      const currentText = document.body.innerText.substring(0, 8000).toLowerCase();
      const prevText = preSnapshot.bodyTextSample;

      for (const phrase of FORM_SUCCESS_PHRASES) {
        if (currentText.includes(phrase) && !prevText.includes(phrase)) {
          signals.successTextAppeared = true;
          signals.successPhrase = phrase;
          break;
        }
      }

      // Signal 2: Visible input count DECREASED significantly
      const currentInputCount = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]), textarea, select'
      ).length;
      signals.inputCountDelta = (preSnapshot.visibleInputCount || 0) - currentInputCount;
      signals.inputCountDecreased = signals.inputCountDelta >= 2;

      // Signal 3: URL changed to a success/confirmation path
      const currentPath = location.pathname.toLowerCase();
      const prevPath = _extractPath(preSnapshot.url || '');
      if (currentPath !== prevPath) {
        for (const pattern of FORM_SUCCESS_URL_PATTERNS) {
          if (currentPath.includes(pattern)) {
            signals.successUrl = true;
            break;
          }
        }
      }

      // Signal 4: Success toast/alert role element appeared
      const alerts = document.querySelectorAll('[role="alert"], [role="status"]');
      for (const alert of alerts) {
        const alertText = (alert.textContent || '').toLowerCase();
        if (alertText.includes('success') || alertText.includes('thank') || 
            alertText.includes('submitted') || alertText.includes('complete')) {
          signals.successToastPresent = true;
          break;
        }
      }
    } catch (e) {
      console.warn('[PageStateAnalyzer] formSuccess detector error:', e.message);
    }

    const confidence =
      0.40 * (signals.successTextAppeared ? 1 : 0) +
      0.20 * (signals.inputCountDecreased ? 1 : 0) +
      0.25 * (signals.successUrl ? 1 : 0) +
      0.15 * (signals.successToastPresent ? 1 : 0);

    return {
      detected: confidence >= 0.35,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR 5: Page Arrival (Navigate goals)
  // ═══════════════════════════════════════════════════════════════════════════

  function detectPageArrival(parsedGoal, preSnapshot) {
    const signals = {
      titleMatch: 0,
      pathMatch: 0,
      headingMatch: 0,
      hasSubstantialContent: false,
    };

    try {
      const tokens = parsedGoal.targetTokens;
      if (tokens.length === 0) {
        return { detected: false, confidence: 0, signals };
      }

      // Signal 1: Page title contains target tokens
      const title = (document.title || '').toLowerCase();
      let titleHits = 0;
      for (const t of tokens) { if (title.includes(t)) titleHits++; }
      signals.titleMatch = titleHits / tokens.length;

      // Signal 2: URL path contains target tokens
      const path = location.pathname.toLowerCase();
      let pathHits = 0;
      for (const t of tokens) { if (path.includes(t)) pathHits++; }
      signals.pathMatch = pathHits / tokens.length;

      // Signal 3: H1 heading contains target tokens
      const h1 = document.querySelector('h1');
      if (h1) {
        const h1Text = (h1.textContent || '').toLowerCase();
        let h1Hits = 0;
        for (const t of tokens) { if (h1Text.includes(t)) h1Hits++; }
        signals.headingMatch = h1Hits / tokens.length;
      }

      // Signal 4: Substantial content loaded
      const mainEl = document.querySelector('main, [role="main"], article') || document.body;
      signals.hasSubstantialContent = (mainEl.innerText || '').length > 200;
    } catch (e) {
      console.warn('[PageStateAnalyzer] pageArrival detector error:', e.message);
    }

    const confidence =
      0.35 * signals.titleMatch +
      0.30 * signals.pathMatch +
      0.25 * signals.headingMatch +
      0.10 * (signals.hasSubstantialContent ? 1 : 0);

    return {
      detected: confidence >= 0.45,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR 6: Content Visible (Read goals)
  // ═══════════════════════════════════════════════════════════════════════════

  function detectContentVisible(parsedGoal, preSnapshot) {
    const signals = {
      targetPresenceInContent: 0,
      hasSubstantialContent: false,
      hasStructuredContent: false,
      hasPriceNearTarget: false,
      hasRichFormatting: false,
    };

    try {
      const tokens = parsedGoal.targetTokens;
      const mainEl = document.querySelector('main, [role="main"], article') || document.body;
      const contentText = (mainEl.innerText || '').slice(0, 10000).toLowerCase();

      // Signal 1: Target tokens in main content area
      if (tokens.length > 0) {
        let hits = 0;
        for (const t of tokens) { if (contentText.includes(t)) hits++; }
        signals.targetPresenceInContent = hits / tokens.length;
      }

      // Signal 2: Substantial content loaded (>300 chars)
      signals.hasSubstantialContent = contentText.length > 300;

      // Signal 3: Structured content (headings + paragraphs)
      const headings = mainEl.querySelectorAll('h1, h2, h3');
      const paras = mainEl.querySelectorAll('p');
      signals.hasStructuredContent = headings.length > 0 && paras.length > 0;

      // Signal 4: Price/number near target tokens (for price-checking goals)
      const pricePattern = /\$\d+[\d,.]*|\d+[\d,.]*\s*(usd|eur|gbp|inr)/i;
      if (tokens.length > 0 && pricePattern.test(contentText)) {
        // Check if price is within ~200 chars of a target token
        for (const t of tokens) {
          const idx = contentText.indexOf(t);
          if (idx !== -1) {
            const nearby = contentText.substring(Math.max(0, idx - 200), idx + 200);
            if (pricePattern.test(nearby)) {
              signals.hasPriceNearTarget = true;
              break;
            }
          }
        }
      }

      // Signal 5: Rich formatting (images, lists, tables in main)
      const images = mainEl.querySelectorAll('img');
      const lists = mainEl.querySelectorAll('ul, ol');
      const tables = mainEl.querySelectorAll('table');
      signals.hasRichFormatting = images.length > 0 || lists.length > 0 || tables.length > 0;
    } catch (e) {
      console.warn('[PageStateAnalyzer] contentVisible detector error:', e.message);
    }

    const confidence =
      0.35 * signals.targetPresenceInContent +
      0.15 * (signals.hasSubstantialContent ? 1 : 0) +
      0.15 * (signals.hasStructuredContent ? 1 : 0) +
      0.20 * (signals.hasPriceNearTarget ? 1 : 0) +
      0.15 * (signals.hasRichFormatting ? 1 : 0);

    return {
      detected: confidence >= 0.40,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  SAFETY BOUNDARY — Hard Binary Kill Switch
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check for safety boundaries. This is NOT a scored detector.
   * ANY trigger = hard block, completion score forced to 0.
   *
   * @param {Object} parsedGoal
   * @returns {Object} { detected: boolean, signals: Object }
   */
  function detectSafetyBoundary(parsedGoal) {
    const signals = {
      hasPaymentFields: false,
      hasPaymentIframes: false,
      hasPaymentActionPhrases: false,
      isCheckoutUrl: false,
      hasPasswordOnNonLoginGoal: false,
    };

    try {
      // 1. Payment form fields
      for (const sel of PAYMENT_FIELD_SELECTORS) {
        try {
          if (document.querySelector(sel)) {
            signals.hasPaymentFields = true;
            break;
          }
        } catch (e) { /* invalid selector */ }
      }

      // 2. Payment processor iframes
      const iframes = document.querySelectorAll('iframe[src]');
      for (const iframe of iframes) {
        const src = (iframe.src || '').toLowerCase();
        for (const pattern of PAYMENT_IFRAME_PATTERNS) {
          if (src.includes(pattern)) {
            signals.hasPaymentIframes = true;
            break;
          }
        }
        if (signals.hasPaymentIframes) break;
      }

      // 3. Payment action phrases in buttons/links
      const buttons = document.querySelectorAll('button, [role="button"], a');
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase().trim();
        for (const phrase of PAYMENT_ACTION_PHRASES) {
          if (text.includes(phrase)) {
            signals.hasPaymentActionPhrases = true;
            break;
          }
        }
        if (signals.hasPaymentActionPhrases) break;
      }

      // 4. Checkout URL patterns
      const path = location.pathname.toLowerCase();
      for (const pattern of CHECKOUT_URL_PATTERNS) {
        if (path.includes(pattern)) {
          signals.isCheckoutUrl = true;
          break;
        }
      }

      // 5. Password input on non-login goal
      if (parsedGoal.verb !== 'login') {
        signals.hasPasswordOnNonLoginGoal = !!document.querySelector('input[type="password"]');
      }
    } catch (e) {
      console.warn('[PageStateAnalyzer] safetyBoundary detector error:', e.message);
    }

    // ANY signal = blocked
    const detected = signals.hasPaymentFields ||
                     signals.hasPaymentIframes ||
                     signals.hasPaymentActionPhrases ||
                     signals.isCheckoutUrl;
    // Note: hasPasswordOnNonLoginGoal is a softer signal, not a hard block by itself
    // unless combined with checkout url

    return { detected, signals };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  ERROR DETECTION (lightweight)
  // ═══════════════════════════════════════════════════════════════════════════

  function detectErrors() {
    const signals = { detected: false, severity: 0, phrases: [] };

    try {
      // Check role="alert" elements
      const alerts = document.querySelectorAll('[role="alert"]');
      for (const alert of alerts) {
        const text = (alert.textContent || '').toLowerCase();
        for (const phrase of ERROR_PHRASES) {
          if (text.includes(phrase)) {
            signals.detected = true;
            signals.phrases.push(phrase);
          }
        }
      }

      // Check aria-invalid form fields
      const invalidFields = document.querySelectorAll('[aria-invalid="true"]');
      if (invalidFields.length > 0) {
        signals.detected = true;
        signals.phrases.push('aria-invalid fields');
      }

      // Check main content for error text (scoped to avoid footer matches)
      if (!signals.detected) {
        const mainEl = document.querySelector('main, [role="main"], article') || document.body;
        const mainText = (mainEl.innerText || '').slice(0, 3000).toLowerCase();
        for (const phrase of ['out of stock', 'unavailable', 'something went wrong', 'try again']) {
          if (mainText.includes(phrase)) {
            signals.detected = true;
            signals.phrases.push(phrase);
          }
        }
      }

      // Compute severity (0-1)
      if (signals.detected) {
        signals.severity = Math.min(signals.phrases.length * 0.3, 1.0);
      }
    } catch (e) { /* DOM access failure */ }

    return signals;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  LOADING DETECTION (lightweight)
  // ═══════════════════════════════════════════════════════════════════════════

  function detectLoading() {
    const signals = { detected: false };

    try {
      // aria-busy elements
      if (document.querySelector('[aria-busy="true"]')) {
        signals.detected = true;
        return signals;
      }

      // Spinners, loading overlays, progress bars
      const loadingSelectors = '.loading, .spinner, [role="progressbar"], .skeleton, .placeholder';
      const loadingEls = document.querySelectorAll(loadingSelectors);
      for (const el of loadingEls) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          signals.detected = true;
          return signals;
        }
      }
    } catch (e) { /* DOM access failure */ }

    return signals;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DECISION POINT DETECTION (Phase 1B.4 — Structural Variant Selectors)
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Detects mandatory user choices on the current page — product variants,
  // configuration options, exclusive toggles. Uses framework-invariant
  // structural patterns only (no class names, no site-specific selectors).
  //
  // Each detected group is cross-referenced against parsedGoal.constraints
  // for auto-resolution. Groups where a constraint value matches an option
  // label are marked resolved. Unresolved groups trigger escalation.
  //
  // Cost: ~5-10ms. Uses querySelectorAll + getBoundingClientRect.
  // ═══════════════════════════════════════════════════════════════════════════

  // Constraint keys that map to common product variant categories.
  // Used to match parsedGoal.constraints against detected decision point labels.
  const VARIANT_CONSTRAINT_KEYS = [
    'color', 'size', 'storage', 'material', 'style', 'pattern',
    'ram', 'gpu', 'cpu', 'capacity', 'screen_size',
  ];

  /**
   * Detect structural decision points (variant selectors) on the page.
   *
   * Scans for 5 framework-invariant patterns:
   *   1. Radio groups — <input type="radio"> with shared name, or [role="radiogroup"]
   *   2. Toggle button sets — siblings with [aria-pressed]
   *   3. Exclusive selection groups — siblings with [aria-selected]
   *   4. Required selects — <select required> or <select aria-required>
   *   5. Swatch groups — siblings with shared structural signature and label patterns
   *
   * @param {Object} parsedGoal - From GoalParser (includes .constraints)
   * @returns {Object} { detected, decisionPoints[], unresolvedCount, resolvedCount }
   */
  function detectDecisionPoints(parsedGoal) {
    const result = {
      detected: false,
      decisionPoints: [],
      unresolvedCount: 0,
      resolvedCount: 0,
    };

    const constraints = parsedGoal?.constraints || {};

    try {
      // ── Pattern 1: Native Radio Groups ──────────────────────────────────
      _detectRadioGroups(result, constraints);

      // ── Pattern 2: ARIA Radiogroups ─────────────────────────────────────
      _detectAriaRadioGroups(result, constraints);

      // ── Pattern 3: Toggle Button Sets (aria-pressed) ────────────────────
      _detectToggleButtonSets(result, constraints);

      // ── Pattern 4: Exclusive Selection Groups (aria-selected) ───────────
      _detectSelectionGroups(result, constraints);

      // ── Pattern 5: Required Selects at Default ──────────────────────────
      _detectRequiredSelects(result, constraints);

      // ── Cross-Pattern Deduplication ──────────────────────────────────────
      // Different patterns can detect the same physical UI widget (e.g., an
      // Apple swatch picker may match BOTH Pattern 2 ARIA radiogroup AND
      // Pattern 4 aria-selected). Dedup by checking if one decision point's
      // container is the same element or ancestor/descendant of another's.
      _deduplicateDecisionPoints(result);

      // Strip internal _containerElement references — these are live DOM nodes
      // used only for deduplication. They'd cause serialization failures when
      // the result is sent through Chrome's sendResponse() or JSON.stringify().
      for (const dp of result.decisionPoints) {
        delete dp._containerElement;
      }

      // Compute final state
      result.detected = result.decisionPoints.length > 0;
      result.unresolvedCount = result.decisionPoints.filter(dp => !dp.resolved).length;
      result.resolvedCount = result.decisionPoints.filter(dp => dp.resolved).length;

    } catch (e) {
      console.warn('[PageStateAnalyzer] decisionPoints detector error:', e.message);
    }

    if (result.detected) {
      console.log(
        `[PageStateAnalyzer] Decision points: ${result.decisionPoints.length} found, ` +
        `${result.unresolvedCount} unresolved, ${result.resolvedCount} resolved`
      );
    }

    return result;
  }

  /**
   * Pattern 1: Native <input type="radio"> groups.
   * Groups radios by their `name` attribute.
   * @private
   */
  function _detectRadioGroups(result, constraints) {
    const radios = document.querySelectorAll('input[type="radio"]');
    if (radios.length === 0) return;

    // Group by name attribute
    const groups = new Map();
    for (const radio of radios) {
      // Skip hidden radios
      const rect = radio.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const name = radio.getAttribute('name') || '';
      if (!name) continue;

      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(radio);
    }

    for (const [name, groupRadios] of groups) {
      if (groupRadios.length < 2) continue; // not a choice

      const options = groupRadios.map(r => ({
        text: _getRadioLabel(r),
        value: r.value || '',
        selected: r.checked,
      }));

      const hasSelection = options.some(o => o.selected);
      const groupLabel = _inferGroupLabel(groupRadios[0], name);

      const dp = {
        type: 'radio_group',
        label: groupLabel,
        options: options.filter(o => o.text), // only options with visible labels
        hasSelection,
        resolved: false,
        _containerElement: groupRadios[0].closest('fieldset') || groupRadios[0].parentElement,
      };

      // Auto-resolve: check if constraints cover this group
      dp.resolved = hasSelection || _isResolvedByConstraints(dp, constraints);

      result.decisionPoints.push(dp);
    }
  }

  /**
   * Pattern 2: ARIA [role="radiogroup"] containers.
   * Children with [role="radio"] are the options.
   * @private
   */
  function _detectAriaRadioGroups(result, constraints) {
    const containers = document.querySelectorAll('[role="radiogroup"]');

    for (const container of containers) {
      // Skip invisible containers
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const radios = container.querySelectorAll('[role="radio"]');
      if (radios.length < 2) continue;

      const options = [];
      let hasSelection = false;

      for (const radio of radios) {
        const radioRect = radio.getBoundingClientRect();
        if (radioRect.width === 0 && radioRect.height === 0) continue;

        const checked = radio.getAttribute('aria-checked') === 'true';
        if (checked) hasSelection = true;

        options.push({
          text: _getElementLabel(radio),
          value: radio.getAttribute('data-value') || radio.getAttribute('value') || '',
          selected: checked,
        });
      }

      if (options.length < 2) continue;

      const groupLabel = _getElementLabel(container) ||
                          container.getAttribute('aria-label') || '';

      const dp = {
        type: 'aria_radiogroup',
        label: groupLabel,
        options: options.filter(o => o.text),
        hasSelection,
        resolved: false,
        _containerElement: container,
      };

      dp.resolved = hasSelection || _isResolvedByConstraints(dp, constraints);
      result.decisionPoints.push(dp);
    }
  }

  /**
   * Pattern 3: Toggle button sets — sibling elements with [aria-pressed].
   * Groups by parent container.
   * @private
   */
  function _detectToggleButtonSets(result, constraints) {
    const pressed = document.querySelectorAll('[aria-pressed]');
    if (pressed.length < 2) return;

    // Group by parent
    const groups = new Map();
    for (const el of pressed) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const parent = el.parentElement;
      if (!parent) continue;

      const key = _elementId(parent);
      if (!groups.has(key)) groups.set(key, { parent, elements: [] });
      groups.get(key).elements.push(el);
    }

    for (const [, group] of groups) {
      if (group.elements.length < 2) continue;

      let hasSelection = false;
      const options = group.elements.map(el => {
        const isActive = el.getAttribute('aria-pressed') === 'true';
        if (isActive) hasSelection = true;
        return {
          text: _getElementLabel(el),
          value: el.getAttribute('data-value') || el.getAttribute('value') || '',
          selected: isActive,
        };
      });

      const groupLabel = _inferGroupLabel(group.elements[0], '') ||
                          group.parent.getAttribute('aria-label') || '';

      const dp = {
        type: 'toggle_group',
        label: groupLabel,
        options: options.filter(o => o.text),
        hasSelection,
        resolved: false,
        _containerElement: group.parent,
      };

      dp.resolved = hasSelection || _isResolvedByConstraints(dp, constraints);
      result.decisionPoints.push(dp);
    }
  }

  /**
   * Pattern 4: Exclusive selection groups — siblings with [aria-selected].
   * Only detects groups where NOT all items are selected (exclusive choice).
   * @private
   */
  function _detectSelectionGroups(result, constraints) {
    const selected = document.querySelectorAll('[aria-selected]');
    if (selected.length < 2) return;

    // Group by parent
    const groups = new Map();
    for (const el of selected) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const parent = el.parentElement;
      if (!parent) continue;

      // Skip navigation tabs — they're not product variant choices
      const role = (parent.getAttribute('role') || '').toLowerCase();
      if (role === 'tablist') continue;

      const key = _elementId(parent);
      if (!groups.has(key)) groups.set(key, { parent, elements: [] });
      groups.get(key).elements.push(el);
    }

    for (const [, group] of groups) {
      if (group.elements.length < 2) continue;

      let selectedCount = 0;
      const options = group.elements.map(el => {
        const isActive = el.getAttribute('aria-selected') === 'true';
        if (isActive) selectedCount++;
        return {
          text: _getElementLabel(el),
          value: el.getAttribute('data-value') || el.getAttribute('value') || '',
          selected: isActive,
        };
      });

      // Skip if ALL or NONE are selected (not a meaningful choice state)
      // A valid exclusive group has exactly 1 selected or 0 (unselected)
      if (selectedCount === options.length) continue;

      const hasSelection = selectedCount > 0;
      const groupLabel = group.parent.getAttribute('aria-label') ||
                          _inferGroupLabel(group.elements[0], '');

      const dp = {
        type: 'selection_group',
        label: groupLabel,
        options: options.filter(o => o.text),
        hasSelection,
        resolved: false,
        _containerElement: group.parent,
      };

      dp.resolved = hasSelection || _isResolvedByConstraints(dp, constraints);
      result.decisionPoints.push(dp);
    }
  }

  /**
   * Pattern 5: Required <select> elements at default/placeholder value.
   * @private
   */
  function _detectRequiredSelects(result, constraints) {
    const selects = document.querySelectorAll(
      'select[required], select[aria-required="true"]'
    );

    for (const select of selects) {
      const rect = select.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      // Check if the current value is a placeholder/default
      const currentValue = select.value || '';
      const selectedOption = select.options[select.selectedIndex];
      const isPlaceholder = !currentValue ||
        (selectedOption && (
          selectedOption.disabled ||
          selectedOption.value === '' ||
          selectedOption.hasAttribute('hidden')
        ));

      if (!isPlaceholder) continue; // already has a selection

      // Collect non-placeholder options
      const options = [];
      for (const opt of select.options) {
        if (opt.disabled || opt.value === '' || opt.hasAttribute('hidden')) continue;
        options.push({
          text: opt.textContent.trim(),
          value: opt.value,
          selected: false,
        });
      }

      if (options.length < 2) continue; // not a meaningful choice

      const groupLabel = _getSelectLabel(select);

      const dp = {
        type: 'required_select',
        label: groupLabel,
        options,
        hasSelection: false,
        resolved: false,
        _containerElement: select.parentElement || select,
      };

      dp.resolved = _isResolvedByConstraints(dp, constraints);
      result.decisionPoints.push(dp);
    }
  }


  // ─── Decision Point Helpers ────────────────────────────────────────────────

  /**
   * Cross-pattern deduplication.
   *
   * Problem: The same physical widget can be detected by multiple patterns.
   * For example, Apple's color picker uses [role="radiogroup"] > [role="radio"]
   * with [aria-selected] on each child, matching BOTH Pattern 2 and Pattern 4.
   *
   * Solution: Compare each pair of decision points by their _containerElement.
   * If one container is the same element or an ancestor/descendant of another,
   * they represent the same physical choice — keep only the more specific one
   * (the one with the child container, or the one with more options).
   *
   * @private
   */
  function _deduplicateDecisionPoints(result) {
    const dps = result.decisionPoints;
    if (dps.length < 2) return;

    const toRemove = new Set();

    for (let i = 0; i < dps.length; i++) {
      if (toRemove.has(i)) continue;
      const containerA = dps[i]._containerElement;
      if (!containerA) continue;

      for (let j = i + 1; j < dps.length; j++) {
        if (toRemove.has(j)) continue;
        const containerB = dps[j]._containerElement;
        if (!containerB) continue;

        // Same element — exact duplicate
        if (containerA === containerB) {
          // Keep the one with more options (more specific detection)
          const keepI = (dps[i].options?.length || 0) >= (dps[j].options?.length || 0);
          toRemove.add(keepI ? j : i);
          console.log(
            `[PageStateAnalyzer] Dedup: removed ${dps[keepI ? j : i].type} ` +
            `(duplicate of ${dps[keepI ? i : j].type} "${dps[keepI ? i : j].label}")`
          );
          continue;
        }

        // Ancestor/descendant relationship — overlapping containers
        if (containerA.contains(containerB)) {
          // B is inside A — keep B (more specific)
          toRemove.add(i);
          console.log(
            `[PageStateAnalyzer] Dedup: removed ${dps[i].type} "${dps[i].label}" ` +
            `(ancestor of ${dps[j].type} "${dps[j].label}")`
          );
          break; // i is removed, stop comparing against it
        } else if (containerB.contains(containerA)) {
          // A is inside B — keep A (more specific)
          toRemove.add(j);
          console.log(
            `[PageStateAnalyzer] Dedup: removed ${dps[j].type} "${dps[j].label}" ` +
            `(ancestor of ${dps[i].type} "${dps[i].label}")`
          );
        }
      }
    }

    // Remove duplicates (iterate in reverse to preserve indices)
    if (toRemove.size > 0) {
      const sortedIndices = [...toRemove].sort((a, b) => b - a);
      for (const idx of sortedIndices) {
        result.decisionPoints.splice(idx, 1);
      }
    }
  }

  /**
   * Get a stable identifier for an element (for grouping by parent).
   * @private
   */
  function _elementId(el) {
    if (el.id) return `#${el.id}`;
    // Use a positional fingerprint
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const index = Array.from(parent.children).indexOf(el);
    return `${parent.tagName}.${tag}[${index}]`;
  }

  /**
   * Get the visible label for a radio input.
   * Checks: explicit <label>, aria-label, parent label, adjacent text.
   * @private
   */
  function _getRadioLabel(radio) {
    // 1. Explicit label via for/id
    if (radio.id) {
      const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (label) return label.textContent.trim().substring(0, 80);
    }
    // 2. Wrapping label
    const wrapper = radio.closest('label');
    if (wrapper) {
      // Get label text excluding the radio itself
      const clone = wrapper.cloneNode(true);
      const inputs = clone.querySelectorAll('input');
      for (const inp of inputs) inp.remove();
      const text = clone.textContent.trim();
      if (text) return text.substring(0, 80);
    }
    // 3. aria-label
    const ariaLabel = radio.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim().substring(0, 80);
    // 4. Value as fallback
    return (radio.value || '').trim().substring(0, 80);
  }

  /**
   * Get the visible label for a generic element.
   * @private
   */
  function _getElementLabel(el) {
    // aria-label first
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim().substring(0, 80);
    // Visible text
    const text = (el.textContent || '').trim();
    if (text && text.length <= 80) return text;
    if (text) return text.substring(0, 80);
    // title attribute
    return (el.getAttribute('title') || '').trim().substring(0, 80);
  }

  /**
   * Get the label for a <select> element.
   * @private
   */
  function _getSelectLabel(select) {
    // 1. Explicit label via for/id
    if (select.id) {
      const label = document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
      if (label) return label.textContent.trim().substring(0, 80);
    }
    // 2. Wrapping label
    const wrapper = select.closest('label');
    if (wrapper) {
      const clone = wrapper.cloneNode(true);
      const selects = clone.querySelectorAll('select');
      for (const s of selects) s.remove();
      const text = clone.textContent.trim();
      if (text) return text.substring(0, 80);
    }
    // 3. aria-label
    const ariaLabel = select.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel.trim().substring(0, 80);
    // 4. name attribute
    return (select.getAttribute('name') || '').trim().substring(0, 80);
  }

  /**
   * Infer a group label from context — looks at heading siblings,
   * fieldset legends, and aria-label on parent.
   * @private
   */
  function _inferGroupLabel(element, fallbackName) {
    // 1. Fieldset legend
    const fieldset = element.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) return legend.textContent.trim().substring(0, 80);
    }
    // 2. aria-label on parent
    const parent = element.parentElement;
    if (parent) {
      const ariaLabel = parent.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.trim().substring(0, 80);
    }
    // 3. Previous sibling heading or label
    if (parent) {
      const prevSibling = parent.previousElementSibling;
      if (prevSibling) {
        const tag = prevSibling.tagName.toLowerCase();
        if (['h1','h2','h3','h4','h5','h6','label','legend','span','p'].includes(tag)) {
          const text = prevSibling.textContent.trim();
          if (text && text.length <= 40) return text;
        }
      }
    }
    // 4. Fallback to name attribute (humanized)
    if (fallbackName) {
      return fallbackName
        .replace(/[_-]/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .trim();
    }
    return '';
  }

  /**
   * Check if a decision point is resolved by the goal's constraints.
   *
   * Uses token-overlap matching: tokenizes the constraint value and checks
   * if any option's text contains those tokens. This handles fuzzy cases
   * like constraint "blue" matching option "Pacific Blue".
   *
   * @param {Object} dp - Decision point { label, options }
   * @param {Object} constraints - From parsedGoal.constraints
   * @returns {boolean} Whether this decision point is covered by constraints
   * @private
   */
  function _isResolvedByConstraints(dp, constraints) {
    if (!constraints || Object.keys(constraints).length === 0) return false;

    // Try matching against known variant constraint keys
    for (const key of VARIANT_CONSTRAINT_KEYS) {
      const constraintValue = constraints[key];
      if (!constraintValue || typeof constraintValue !== 'string') continue;

      const constraintTokens = constraintValue.toLowerCase().split(/\s+/);

      // Check if any option's text contains the constraint tokens
      for (const option of dp.options) {
        const optionText = option.text.toLowerCase();
        const matches = constraintTokens.every(token => optionText.includes(token));
        if (matches) return true;
      }

      // Also check if the group label matches the constraint key
      // e.g., label "Color" + constraint key "color" with value "blue"
      const labelLower = dp.label.toLowerCase();
      const keyWords = key.replace(/_/g, ' ').toLowerCase();
      if (labelLower.includes(keyWords) || keyWords.includes(labelLower)) {
        // Group label matches the constraint key category — resolved
        return true;
      }
    }

    return false;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  DETECTOR ROUTER — Maps verb → detector function
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Run the appropriate verb-specific detector.
   *
   * @param {Object} parsedGoal
   * @param {Object} preSnapshot
   * @returns {Object} { detected, confidence, signals }
   */
  function runDetector(parsedGoal, preSnapshot) {
    switch (parsedGoal.primaryDetector) {
      case 'searchResults':  return detectSearchResults(parsedGoal, preSnapshot);
      case 'cartAdded':      return detectCartAdded(parsedGoal, preSnapshot);
      case 'loginSuccess':   return detectLoginSuccess(parsedGoal, preSnapshot);
      case 'formSuccess':    return detectFormSuccess(parsedGoal, preSnapshot);
      case 'pageArrival':    return detectPageArrival(parsedGoal, preSnapshot);
      case 'contentVisible': return detectContentVisible(parsedGoal, preSnapshot);
      case 'stateChanged':
        // For 'interact' goals, use the progress estimator's effect categorization
        // State change, navigation, content_load, or modal_open all count
        return _detectStateChanged(parsedGoal, preSnapshot);
      default:
        return { detected: false, confidence: 0, signals: {} };
    }
  }

  /**
   * Fallback detector for 'interact' goals — checks if meaningful DOM changes occurred.
   */
  function _detectStateChanged(parsedGoal, preSnapshot) {
    const signals = {
      urlChanged: false,
      textLengthDelta: 0,
      significantTextChange: false,
    };

    try {
      signals.urlChanged = location.href !== preSnapshot.url;

      const currentTextLen = (document.body.innerText || '').length;
      const preTextLen = (preSnapshot.bodyTextSample || '').length;
      signals.textLengthDelta = currentTextLen - preTextLen;
      signals.significantTextChange = Math.abs(signals.textLengthDelta) > 200;
    } catch (e) { /* DOM access failure */ }

    const confidence =
      0.40 * (signals.urlChanged ? 1 : 0) +
      0.40 * (signals.significantTextChange ? 1 : 0) +
      0.20 * (signals.textLengthDelta > 0 ? 0.5 : 0);

    return {
      detected: confidence >= 0.35,
      confidence: Math.min(confidence, 1.0),
      signals
    };
  }

  // Public API
  return {
    runDetector,
    detectSafetyBoundary,
    detectErrors,
    detectLoading,
    detectDecisionPoints,
    // Individual detectors exposed for testing
    detectSearchResults,
    detectCartAdded,
    detectLoginSuccess,
    detectFormSuccess,
    detectPageArrival,
    detectContentVisible,
  };
})();


// ═══════════════════════════════════════════════════════════════════════════════
//  GOAL COMPLETION EVALUATOR — The Decision Layer
// ═══════════════════════════════════════════════════════════════════════════════
//
// Combines generic signals + type-specific detector signals using the
// corroboration principle: both must agree for high-confidence terminal.
//
// Also extracts a 32-feature vector for Phase 2 training data.
// ═══════════════════════════════════════════════════════════════════════════════

BrowserAgent.GoalCompletionEvaluator = (() => {
  'use strict';

  // ─── Verb-Specific Thresholds ──────────────────────────────────────────────
  const VERB_PROFILES = {
    search: {
      threshold: 0.70,
      minStepsForTerminal: 3,
      earlyStepCap: 0.40,
    },
    purchase: {
      threshold: 0.75,
      minStepsForTerminal: 4,
      earlyStepCap: 0.30,
    },
    navigate: {
      threshold: 0.65,
      minStepsForTerminal: 2,
      earlyStepCap: 0.50,
    },
    login: {
      threshold: 0.75,
      minStepsForTerminal: 3,
      earlyStepCap: 0.35,
    },
    fill: {
      threshold: 0.70,
      minStepsForTerminal: 3,
      earlyStepCap: 0.40,
    },
    read: {
      threshold: 0.65,
      minStepsForTerminal: 2,
      earlyStepCap: 0.50,
    },
    interact: {
      threshold: 0.60,
      minStepsForTerminal: 1,
      earlyStepCap: 0.55,
    },
  };


  // ═══════════════════════════════════════════════════════════════════════════
  //  GENERIC SIGNALS (apply to ALL goal types)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute generic completion signals that apply regardless of verb type.
   *
   * @param {Object} parsedGoal
   * @param {Object} taskState - From service worker
   * @returns {Object} { targetPresence, urlRelevance, taskMaturity, progressConfidence, score }
   */
  function _computeGenericScore(parsedGoal, taskState) {
    let targetPresence = 0;
    let urlRelevance = 0;

    try {
      const pageText = document.body.innerText.substring(0, 10000).toLowerCase();
      const url = location.href.toLowerCase();

      // 1. Target Presence: how many target tokens are visible
      if (parsedGoal.targetTokens.length > 0) {
        const hits = parsedGoal.targetTokens.filter(t => pageText.includes(t));
        targetPresence = hits.length / parsedGoal.targetTokens.length;
      }

      // 2. URL Relevance: target tokens in URL
      if (parsedGoal.targetTokens.length > 0) {
        const urlHits = parsedGoal.targetTokens.filter(t => url.includes(t));
        urlRelevance = urlHits.length / parsedGoal.targetTokens.length;
      }
    } catch (e) { /* DOM access failure */ }

    // 3. Task Maturity: approaches 1.0 around step 8-10
    const taskMaturity = Math.min(1.0, (taskState?.step_index || 0) / 8);

    // 4. Progress Confidence: from ProgressEstimator
    const progressConfidence = taskState?.progress_score || 0;

    const score = 0.30 * targetPresence +
                  0.20 * urlRelevance +
                  0.20 * taskMaturity +
                  0.30 * progressConfidence;

    return { targetPresence, urlRelevance, taskMaturity, progressConfidence, score };
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  MATURITY GATE — Hard Cap on Early Steps
  // ═══════════════════════════════════════════════════════════════════════════

  function _applyMaturityGate(score, stepIndex, verbProfile) {
    if (stepIndex < verbProfile.minStepsForTerminal) {
      return Math.min(score, verbProfile.earlyStepCap);
    }
    return score;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  FEATURE VECTOR EXTRACTION (32 features for Phase 2)
  // ═══════════════════════════════════════════════════════════════════════════

  function _extractFeatureVector(parsedGoal, generic, typeSpecific, safety, errors, loading, taskState, preSnapshot) {
    const fv = {
      // Identity (not features, but needed for labeling)
      taskId: taskState?.taskId || 0,
      stepIndex: taskState?.step_index || 0,
      verb: parsedGoal.verb,
      timestamp: Date.now(),

      // Generic Context Features (4)
      f_targetPresence: generic.targetPresence,
      f_urlRelevance: generic.urlRelevance,
      f_taskMaturity: generic.taskMaturity,
      f_progressConfidence: generic.progressConfidence,

      // Search Results Features (4)
      f_urlHasSearchParam: typeSpecific.signals?.urlHasSearchParam ? 1 : 0,
      f_hasRepeatedItems: typeSpecific.signals?.hasRepeatedItems ? 1 : 0,
      f_repeatedItemCount: typeSpecific.signals?.repetitionCount || 0,
      f_searchInputHasTarget: typeSpecific.signals?.searchInputHasTarget ? 1 : 0,

      // Cart Features (4)
      f_cartBadgeDelta: typeSpecific.signals?.badgeDelta || 0,
      f_cartConfirmAppeared: typeSpecific.signals?.confirmationAppeared ? 1 : 0,
      f_urlIsCartPage: typeSpecific.signals?.urlChangedToCart ? 1 : 0,
      f_cartConfirmPhrase: typeSpecific.signals?.confirmationPhrase || null,

      // Login Features (4)
      f_passwordFieldGone: typeSpecific.signals?.passwordFieldDisappeared ? 1 : 0,
      f_leftLoginUrl: typeSpecific.signals?.leftLoginPage ? 1 : 0,
      f_dashboardVisible: typeSpecific.signals?.hasDashboardIndicators ? 1 : 0,
      f_welcomeTextVisible: typeSpecific.signals?.hasWelcomeText ? 1 : 0,

      // Form Features (3)
      f_successTextAppeared: typeSpecific.signals?.successTextAppeared ? 1 : 0,
      f_inputCountDelta: typeSpecific.signals?.inputCountDelta || 0,
      f_successUrl: typeSpecific.signals?.successUrl ? 1 : 0,

      // Page Structure Features (5)
      f_pageTextLength: 0,
      f_urlChanged: location.href !== (preSnapshot?.url || '') ? 1 : 0,
      f_titleMatchesTarget: typeSpecific.signals?.titleMatch || 0,
      f_h1MatchesTarget: typeSpecific.signals?.headingMatch || 0,
      f_hasSubstantialContent: 0,

      // Negative Features (3)
      f_errorDetected: errors.detected ? 1 : 0,
      f_errorSeverity: errors.severity || 0,
      f_loadingDetected: loading.detected ? 1 : 0,

      // Safety Features (2)
      f_safetyBlocked: safety.detected ? 1 : 0,
      f_hasPaymentFields: safety.signals?.hasPaymentFields ? 1 : 0,

      // Computed Scores (3) — filled in after scoring
      f_genericScore: generic.score,
      f_typeSpecificConfidence: typeSpecific.confidence,
      f_completionScore: null,

      // Labels (ground truth for training) — filled in after scoring
      label_isTerminal: null,
      label_safetyBlocked: null,
      label_verb: parsedGoal.verb,
    };

    // Fill in page structure features that need DOM access
    try {
      fv.f_pageTextLength = (document.body.innerText || '').length;
      fv.f_hasSubstantialContent = fv.f_pageTextLength > 300 ? 1 : 0;
    } catch (e) { /* DOM access failure */ }

    return fv;
  }


  // ═══════════════════════════════════════════════════════════════════════════
  //  MAIN EVALUATION — Complete Evaluation Flow
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Evaluate whether the current task goal has been completed.
   *
   * Pipeline:
   *   1. Safety boundary check (hard override)
   *   2. Compute generic signals
   *   3. Run verb-specific detector
   *   4. Combine scores (30/70 weighting)
   *   5. Apply maturity gate
   *   6. Apply negative gates (errors, loading)
   *   6b. Decision point gate (Phase 1B.4 — structural variant penalty)
   *   7. Terminal decision
   *   8. Extract feature vector
   *
   * @param {Object} parsedGoal - From GoalParser (stored in taskState)
   * @param {Object} taskState - From service worker
   * @param {Object} preSnapshot - Pre-action snapshot from GoalCompletionSnapshot.capture()
   * @param {Object} progressData - From ProgressEstimator (progress score)
   * @returns {Object} Goal completion result with feature vector
   */
  function evaluate(parsedGoal, taskState, preSnapshot, progressData) {
    const evalStart = Date.now();

    if (!parsedGoal || !parsedGoal.verb) {
      return _neutralResult(evalStart);
    }

    // Step 1: Safety boundary — check FIRST, hard override
    const safety = BrowserAgent.PageStateAnalyzer.detectSafetyBoundary(parsedGoal);
    if (safety.detected) {
      console.log('[GoalCompletion] ⛔ SAFETY BOUNDARY — blocking');
      const generic = _computeGenericScore(parsedGoal, taskState);
      const typeSpecific = { detected: false, confidence: 0, signals: {} };
      const errors = BrowserAgent.PageStateAnalyzer.detectErrors();
      const loading = BrowserAgent.PageStateAnalyzer.detectLoading();

      const featureVector = _extractFeatureVector(
        parsedGoal, generic, typeSpecific, safety, errors, loading, taskState, preSnapshot
      );
      featureVector.f_completionScore = 0;
      featureVector.label_isTerminal = false;
      featureVector.label_safetyBlocked = true;

      return {
        completionScore: 0,
        isTerminal: false,
        safetyBlocked: true,
        confidence: 0,
        reason: 'safety_blocked',
        parsedGoal: { verb: parsedGoal.verb, target: parsedGoal.target },
        signals: { generic, typeSpecific, safety, errors, loading },
        featureVector,
        evalTimeMs: Date.now() - evalStart
      };
    }

    // Step 2: Compute generic signals
    const generic = _computeGenericScore(parsedGoal, taskState);

    // Step 3: Run verb-specific detector
    const typeSpecific = BrowserAgent.PageStateAnalyzer.runDetector(parsedGoal, preSnapshot);

    // Step 4: Combine scores — 30% generic + 70% type-specific (corroboration)
    let completionScore = generic.score * 0.30 + typeSpecific.confidence * 0.70;

    // Step 5: Apply maturity gate
    const profile = VERB_PROFILES[parsedGoal.verb] || VERB_PROFILES.interact;
    const stepIndex = taskState?.step_index || 0;
    completionScore = _applyMaturityGate(completionScore, stepIndex, profile);

    // Step 6: Apply negative gates
    const errors = BrowserAgent.PageStateAnalyzer.detectErrors();
    const loading = BrowserAgent.PageStateAnalyzer.detectLoading();

    if (errors.detected) {
      completionScore *= (1 - errors.severity * 0.5);
    }
    if (loading.detected) {
      completionScore *= 0.70;
    }

    // Step 6b: Decision point gate (Phase 1B.4)
    // If there are unresolved structural decision points (variant selectors the
    // user hasn't chosen), penalize completion score. This prevents the agent
    // from declaring "goal complete" before mandatory choices are made.
    //
    // Graduated penalty: scales with the number of unresolved decision points.
    //   1 unresolved → *= 0.85 (15% reduction)
    //   2 unresolved → *= 0.70 (30% reduction)
    //   3 unresolved → *= 0.55 (45% reduction)
    //   4+ unresolved → *= 0.40 (floor — 60% reduction)
    let decisionPoints = null;
    if (typeof BrowserAgent.PageStateAnalyzer.detectDecisionPoints === 'function') {
      try {
        decisionPoints = BrowserAgent.PageStateAnalyzer.detectDecisionPoints(parsedGoal);
        if (decisionPoints.detected && decisionPoints.unresolvedCount > 0) {
          const penaltyMultiplier = Math.max(0.40, 1 - 0.15 * decisionPoints.unresolvedCount);
          completionScore *= penaltyMultiplier;
          console.log(
            `[GoalCompletion] ⚠ Decision point penalty: ${decisionPoints.unresolvedCount} unresolved ` +
            `(score *= ${penaltyMultiplier.toFixed(2)} → ${completionScore.toFixed(3)})`
          );
        }
      } catch (e) {
        console.warn('[GoalCompletion] Decision point detection failed (non-fatal):', e.message);
      }
    }

    // Step 7: Terminal decision
    const isTerminal = completionScore >= profile.threshold;

    // Step 8: Extract feature vector
    const featureVector = _extractFeatureVector(
      parsedGoal, generic, typeSpecific, safety, errors, loading, taskState, preSnapshot
    );
    featureVector.f_completionScore = completionScore;
    featureVector.label_isTerminal = isTerminal;
    featureVector.label_safetyBlocked = false;
    // Phase 1B.4: Decision point feature (field 33)
    featureVector.f_decisionPointsUnresolved = decisionPoints?.unresolvedCount || 0;

    // Determine reason
    let reason;
    if (isTerminal) {
      reason = 'goal_complete';
    } else if (completionScore > profile.threshold * 0.7) {
      reason = 'approaching';
    } else {
      reason = 'in_progress';
    }

    const result = {
      completionScore,
      isTerminal,
      safetyBlocked: false,
      confidence: typeSpecific.confidence,
      reason,
      parsedGoal: { verb: parsedGoal.verb, target: parsedGoal.target },
      signals: {
        generic,
        typeSpecific: { detector: parsedGoal.primaryDetector, ...typeSpecific },
        errors,
        loading,
        decisionPoints,
      },
      featureVector,
      evalTimeMs: Date.now() - evalStart
    };

    console.log(
      `[GoalCompletion] ${isTerminal ? '✅ TERMINAL' : reason === 'approaching' ? '🔶 Approaching' : '⏳ In progress'}`,
      `| Score: ${completionScore.toFixed(3)}`,
      `| Generic: ${generic.score.toFixed(3)}`,
      `| TypeSpecific: ${typeSpecific.confidence.toFixed(3)}`,
      `| Verb: ${parsedGoal.verb}`,
      `| Step: ${stepIndex}`,
      `| ${errors.detected ? '⚠ Errors present' : ''}`,
      `| ${loading.detected ? '⏳ Loading' : ''}`,
      `| ${Date.now() - evalStart}ms`
    );

    return result;
  }

  /**
   * Neutral result when no parsed goal is available.
   */
  function _neutralResult(evalStart) {
    return {
      completionScore: 0,
      isTerminal: false,
      safetyBlocked: false,
      confidence: 0,
      reason: 'no_parsed_goal',
      parsedGoal: null,
      signals: {},
      featureVector: null,
      evalTimeMs: Date.now() - evalStart
    };
  }

  return {
    evaluate,
    VERB_PROFILES,
    // Exposed for testing
    _computeGenericScore,
    _applyMaturityGate,
    _extractFeatureVector,
  };
})();
