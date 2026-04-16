/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 1A.3a — Test Harness for DOM Stability Watcher
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Runs in Node.js with minimal DOM mocks (no real browser needed).
 * Tests all sub-functions of DOMStabilityWatcher in isolation:
 *   - Constants validation (IGNORED_TAGS, TRACKED_ATTRIBUTES, etc.)
 *   - Quiet window calculation per action type
 *   - Non-trivial node filtering
 *   - Visible loader detection (geometric gate)
 *   - Expectation fast-forward logic (navigation, enablement, subtree)
 *   - Kinetic streaming detection (text mutation → auto-extend)
 *   - Constructor baseline capture
 *   - Force-exit status determination
 *   - Idempotent resolution guarantee
 *   - Full lifecycle integration tests (with fake timers)
 *
 * Usage: node tests/test-stability-watcher.js
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Minimal Test Framework ──────────────────────────────────────────────────

let _passed = 0, _failed = 0, _currentSuite = '';
let _asyncPassed = 0, _asyncFailed = 0;

function suite(name) {
  _currentSuite = name;
  console.log(`\n${'═'.repeat(70)}\n  ${name}\n${'═'.repeat(70)}`);
}

function test(name, fn) {
  try {
    fn();
    _passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    _failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    if (e.stack) {
      const lines = e.stack.split('\n').slice(1, 3);
      lines.forEach(l => console.error(`     ${l.trim()}`));
    }
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    _asyncPassed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    _asyncFailed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    if (e.stack) {
      const lines = e.stack.split('\n').slice(1, 3);
      lines.forEach(l => console.error(`     ${l.trim()}`));
    }
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertInRange(value, min, max, message) {
  if (value < min || value > max) {
    throw new Error(`${message || 'assertInRange'}: expected ${min}–${max}, got ${value}`);
  }
}

// ─── DOM Mocks ───────────────────────────────────────────────────────────────
// Minimal mocks to satisfy the DOMStabilityWatcher's constructor and methods.
// We don't need a full DOM — just enough to test the logic.

// Node type constants
const NODE_TYPES = {
  ELEMENT_NODE: 1,
  TEXT_NODE: 3,
  COMMENT_NODE: 8
};

global.Node = NODE_TYPES;

// Mock element factory
function makeElement(tagName, attrs = {}, rect = { x: 0, y: 0, width: 100, height: 40 }) {
  const el = {
    nodeType: NODE_TYPES.ELEMENT_NODE,
    tagName: tagName.toUpperCase(),
    textContent: attrs.textContent || '',
    getAttribute: (name) => attrs[name] !== undefined ? attrs[name] : null,
    getBoundingClientRect: () => rect,
    parentElement: null,
    id: attrs.id || '',
    // Minimal computed style
    _style: {
      visibility: attrs._visibility || 'visible',
      display: attrs._display || 'block',
      opacity: attrs._opacity !== undefined ? String(attrs._opacity) : '1'
    }
  };
  return el;
}

function makeTextNode(text) {
  return {
    nodeType: NODE_TYPES.TEXT_NODE,
    textContent: text,
    tagName: undefined,
    parentElement: null
  };
}

function makeCommentNode() {
  return {
    nodeType: NODE_TYPES.COMMENT_NODE,
    textContent: 'comment',
    tagName: undefined,
    parentElement: null
  };
}

// Mock MutationObserver
class MockMutationObserver {
  constructor(callback) {
    this._callback = callback;
    MockMutationObserver._lastInstance = this;
  }
  observe() {}
  disconnect() {}

  // Test helper: simulate mutations
  _fire(mutations) {
    this._callback(mutations);
  }
}
MockMutationObserver._lastInstance = null;
global.MutationObserver = MockMutationObserver;

// Mock document
let _mockDisabledButtons = [];
let _mockLoaders = [];

global.document = {
  documentElement: makeElement('html'),
  title: 'Test Page',
  body: { innerText: 'Test content' },
  querySelectorAll: (selector) => {
    if (selector.includes('disabled') || selector.includes('aria-disabled')) {
      return _mockDisabledButtons;
    }
    if (selector.includes('aria-busy') || selector.includes('spinner') ||
        selector.includes('loader') || selector.includes('loading')) {
      return _mockLoaders;
    }
    return [];
  },
  querySelector: () => null
};

// Mock window
global.window = {
  location: { href: 'https://example.com/page1' },
  getComputedStyle: (el) => el._style || {
    visibility: 'visible',
    display: 'block',
    opacity: '1'
  }
};

// Mock BrowserAgent namespace
global.BrowserAgent = {};

// ─── Load Module ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'stability-watcher.js'), 'utf-8'
);
vm.runInThisContext(src, { filename: 'stability-watcher.js' });

const DSW = BrowserAgent.DOMStabilityWatcher;
assert(typeof DSW === 'function', 'DOMStabilityWatcher class not found');

console.log('\n✓ DOMStabilityWatcher loaded successfully');


// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════

suite('Constants — Tag & Attribute Lists');

test('S1: IGNORED_TAGS contains framework noise tags', () => {
  const expected = ['script', 'style', 'noscript', 'meta', 'link', 'iframe', 'svg'];
  for (const tag of expected) {
    assertEqual(DSW.IGNORED_TAGS.has(tag), true, `should ignore "${tag}"`);
  }
});

test('S2: IGNORED_TAGS does NOT contain interactive tags', () => {
  const interactive = ['button', 'a', 'input', 'select', 'textarea', 'form', 'div', 'span'];
  for (const tag of interactive) {
    assertEqual(DSW.IGNORED_TAGS.has(tag), false, `should NOT ignore "${tag}"`);
  }
});

test('S3: TRACKED_ATTRIBUTES covers interactive state attributes', () => {
  const expected = ['disabled', 'aria-hidden', 'aria-expanded', 'aria-busy',
                    'value', 'checked', 'selected', 'open', 'hidden',
                    'aria-selected', 'aria-checked', 'aria-disabled'];
  for (const attr of expected) {
    assertEqual(DSW.TRACKED_ATTRIBUTES.has(attr), true, `should track "${attr}"`);
  }
});

test('S4: TRACKED_ATTRIBUTES does NOT track cosmetic attributes', () => {
  const cosmetic = ['class', 'style', 'data-testid', 'data-reactid', 'title', 'alt'];
  for (const attr of cosmetic) {
    assertEqual(DSW.TRACKED_ATTRIBUTES.has(attr), false, `should NOT track "${attr}"`);
  }
});

test('S5: LOADER_SELECTORS is a non-empty comma-separated string', () => {
  assert(typeof DSW.LOADER_SELECTORS === 'string', 'is string');
  assert(DSW.LOADER_SELECTORS.length > 0, 'non-empty');
  assert(DSW.LOADER_SELECTORS.includes('aria-busy'), 'includes aria-busy');
  assert(DSW.LOADER_SELECTORS.includes('.spinner'), 'includes .spinner');
  assert(DSW.LOADER_SELECTORS.includes('.skeleton'), 'includes .skeleton');
  assert(DSW.LOADER_SELECTORS.includes('.loading'), 'includes .loading');
});

suite('Constants — Timing Values');

test('S6: timing constants are reasonable', () => {
  assertEqual(DSW.DEFAULT_QUIET_WINDOW_MS, 1200, 'default quiet = 1200ms');
  assertEqual(DSW.TYPING_QUIET_WINDOW_MS, 2000, 'typing quiet = 2000ms');
  assertEqual(DSW.STREAMING_QUIET_WINDOW_MS, 3000, 'streaming quiet = 3000ms');
  assertEqual(DSW.MAX_WAIT_MS, 80000, 'max wait = 80s');
  assertEqual(DSW.MIN_WAIT_MS, 150, 'min wait = 150ms');
});

test('S7: timing hierarchy is correct', () => {
  assert(DSW.MIN_WAIT_MS < DSW.DEFAULT_QUIET_WINDOW_MS, 'min < default');
  assert(DSW.DEFAULT_QUIET_WINDOW_MS < DSW.TYPING_QUIET_WINDOW_MS, 'default < typing');
  assert(DSW.TYPING_QUIET_WINDOW_MS < DSW.STREAMING_QUIET_WINDOW_MS, 'typing < streaming');
  assert(DSW.STREAMING_QUIET_WINDOW_MS < DSW.MAX_WAIT_MS, 'streaming < max');
});

test('S8: streaming detection constants', () => {
  assertEqual(DSW.STREAMING_MUTATION_THRESHOLD, 3, 'threshold = 3 mutations');
  assertEqual(DSW.STREAMING_DETECTION_WINDOW_MS, 500, 'window = 500ms');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  QUIET WINDOW CALCULATION
// ═══════════════════════════════════════════════════════════════════════════════

suite('Quiet Window Calculation');

test('S9: click action → default quiet window', () => {
  const watcher = new DSW({ lastActionType: 'click' });
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'click = default');
});

test('S10: type action → typing quiet window', () => {
  const watcher = new DSW({ lastActionType: 'type' });
  assertEqual(watcher.quietWindowMs, DSW.TYPING_QUIET_WINDOW_MS, 'type = typing');
});

test('S11: search action → typing quiet window', () => {
  const watcher = new DSW({ lastActionType: 'search' });
  assertEqual(watcher.quietWindowMs, DSW.TYPING_QUIET_WINDOW_MS, 'search = typing');
});

test('S12: navigate action → default quiet window', () => {
  const watcher = new DSW({ lastActionType: 'navigate' });
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'navigate = default');
});

test('S13: scroll action → default quiet window', () => {
  const watcher = new DSW({ lastActionType: 'scroll' });
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'scroll = default');
});

test('S14: no action type → default quiet window', () => {
  const watcher = new DSW({});
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'empty = default');
  assertEqual(watcher.lastActionType, 'click', 'defaults to click');
});

test('S15: unknown action type → default quiet window', () => {
  const watcher = new DSW({ lastActionType: 'expand' });
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'expand = default');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  NON-TRIVIAL NODE FILTERING
// ═══════════════════════════════════════════════════════════════════════════════

suite('Non-Trivial Node Detection (_hasNonTrivialNodes)');

test('S16: empty/null NodeList returns false', () => {
  const watcher = new DSW();
  assertEqual(watcher._hasNonTrivialNodes(null), false, 'null');
  assertEqual(watcher._hasNonTrivialNodes([]), false, 'empty array');
});

test('S17: comment nodes are trivial', () => {
  const watcher = new DSW();
  assertEqual(watcher._hasNonTrivialNodes([makeCommentNode()]), false, 'comment is trivial');
});

test('S18: empty text nodes are trivial', () => {
  const watcher = new DSW();
  assertEqual(watcher._hasNonTrivialNodes([makeTextNode('')]), false, 'empty text');
  assertEqual(watcher._hasNonTrivialNodes([makeTextNode('   ')]), false, 'whitespace text');
  assertEqual(watcher._hasNonTrivialNodes([makeTextNode('\n\t')]), false, 'newline/tab text');
});

test('S19: non-empty text nodes are non-trivial', () => {
  const watcher = new DSW();
  assertEqual(watcher._hasNonTrivialNodes([makeTextNode('Hello')]), true, 'text with content');
  assertEqual(watcher._hasNonTrivialNodes([makeTextNode('  a  ')]), true, 'padded text');
});

test('S20: script/style/svg elements are trivial (ignored tags)', () => {
  const watcher = new DSW();
  assertEqual(watcher._hasNonTrivialNodes([makeElement('script')]), false, 'script');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('style')]), false, 'style');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('svg')]), false, 'svg');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('noscript')]), false, 'noscript');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('meta')]), false, 'meta');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('link')]), false, 'link');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('iframe')]), false, 'iframe');
});

test('S21: interactive elements are non-trivial', () => {
  const watcher = new DSW();
  assertEqual(watcher._hasNonTrivialNodes([makeElement('div')]), true, 'div');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('button')]), true, 'button');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('a')]), true, 'a');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('input')]), true, 'input');
  assertEqual(watcher._hasNonTrivialNodes([makeElement('span')]), true, 'span');
});

test('S22: mixed list — returns true if ANY node is non-trivial', () => {
  const watcher = new DSW();
  const nodes = [
    makeCommentNode(),
    makeTextNode(''),
    makeElement('script'),
    makeElement('button')  // ← non-trivial
  ];
  assertEqual(watcher._hasNonTrivialNodes(nodes), true, 'one non-trivial is enough');
});

test('S23: mixed list — returns false if ALL nodes are trivial', () => {
  const watcher = new DSW();
  const nodes = [
    makeCommentNode(),
    makeTextNode('  '),
    makeElement('script'),
    makeElement('style')
  ];
  assertEqual(watcher._hasNonTrivialNodes(nodes), false, 'all trivial');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  VISIBLE LOADER DETECTION (GEOMETRIC GATE)
// ═══════════════════════════════════════════════════════════════════════════════

suite('Visible Loader Detection (_hasVisibleLoaders)');

test('S24: no loaders on page → false', () => {
  _mockLoaders = [];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), false, 'no loaders');
});

test('S25: visible loader → true', () => {
  _mockLoaders = [
    makeElement('div', {
      textContent: 'Loading...',
      'aria-busy': 'true',
      _visibility: 'visible',
      _display: 'block',
      _opacity: 1
    }, { x: 100, y: 200, width: 50, height: 50 })
  ];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), true, 'visible loader');
});

test('S26: zero-size loader → false (geometric gate)', () => {
  _mockLoaders = [
    makeElement('div', { 'aria-busy': 'true' }, { x: 0, y: 0, width: 0, height: 0 })
  ];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), false, 'zero-size');
});

test('S27: hidden loader (visibility: hidden) → false', () => {
  _mockLoaders = [
    makeElement('div', {
      'aria-busy': 'true',
      _visibility: 'hidden',
      _display: 'block',
      _opacity: 1
    }, { x: 0, y: 0, width: 100, height: 100 })
  ];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), false, 'visibility hidden');
});

test('S28: hidden loader (display: none) → false', () => {
  _mockLoaders = [
    makeElement('div', {
      'aria-busy': 'true',
      _visibility: 'visible',
      _display: 'none',
      _opacity: 1
    }, { x: 0, y: 0, width: 100, height: 100 })
  ];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), false, 'display none');
});

test('S29: hidden loader (opacity: 0) → false', () => {
  _mockLoaders = [
    makeElement('div', {
      'aria-busy': 'true',
      _visibility: 'visible',
      _display: 'block',
      _opacity: 0
    }, { x: 0, y: 0, width: 100, height: 100 })
  ];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), false, 'opacity 0');
});

test('S30: mixed visible and invisible loaders → true (any visible wins)', () => {
  _mockLoaders = [
    // Invisible (zero size)
    makeElement('div', { 'aria-busy': 'true' }, { x: 0, y: 0, width: 0, height: 0 }),
    // Visible
    makeElement('div', {
      _visibility: 'visible',
      _display: 'block',
      _opacity: 1
    }, { x: 50, y: 50, width: 30, height: 30 })
  ];
  const watcher = new DSW();
  assertEqual(watcher._hasVisibleLoaders(), true, 'any visible = true');
  _mockLoaders = []; // cleanup
});


// ═══════════════════════════════════════════════════════════════════════════════
//  EXPECTATION FAST-FORWARD
// ═══════════════════════════════════════════════════════════════════════════════

suite('Expectation Checking (_checkExpectation)');

test('S31: navigation expectation — URL unchanged → false', () => {
  window.location.href = 'https://example.com/page1';
  const watcher = new DSW({ expectedEffect: 'navigation' });
  assertEqual(watcher._checkExpectation(), false, 'URL same');
});

test('S32: navigation expectation — URL changed → true', () => {
  window.location.href = 'https://example.com/page1';
  const watcher = new DSW({ expectedEffect: 'navigation' });
  // Simulate navigation
  window.location.href = 'https://example.com/page2';
  assertEqual(watcher._checkExpectation(), true, 'URL changed');
  // Restore
  window.location.href = 'https://example.com/page1';
});

test('S33: enablement expectation — no change → false', () => {
  _mockDisabledButtons = [makeElement('button', { disabled: 'true' })];
  const watcher = new DSW({ expectedEffect: 'enablement' });
  // Still same count
  assertEqual(watcher._checkExpectation(), false, 'count same');
});

test('S34: enablement expectation — button became enabled → true', () => {
  _mockDisabledButtons = [
    makeElement('button', { disabled: 'true' }),
    makeElement('button', { disabled: 'true' })
  ];
  const watcher = new DSW({ expectedEffect: 'enablement' });
  // Now one is enabled (removed from disabled list)
  _mockDisabledButtons = [makeElement('button', { disabled: 'true' })];
  assertEqual(watcher._checkExpectation(), true, 'count decreased');
  _mockDisabledButtons = [];
});

test('S35: subtree_expansion — not enough mutations → false', () => {
  const watcher = new DSW({ expectedEffect: 'subtree_expansion' });
  watcher._meaningfulMutationCount = 2;
  assertEqual(watcher._checkExpectation(), false, '2 < 5');
});

test('S36: subtree_expansion — enough mutations → true', () => {
  const watcher = new DSW({ expectedEffect: 'subtree_expansion' });
  watcher._meaningfulMutationCount = 5;
  assertEqual(watcher._checkExpectation(), true, '5 >= 5');
});

test('S37: unknown expectation → false', () => {
  const watcher = new DSW({ expectedEffect: 'something_weird' });
  assertEqual(watcher._checkExpectation(), false, 'unknown = false');
});

test('S38: null expectation → false', () => {
  const watcher = new DSW({ expectedEffect: null });
  assertEqual(watcher._checkExpectation(), false, 'null = false');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  KINETIC STREAMING DETECTION
// ═══════════════════════════════════════════════════════════════════════════════

suite('Kinetic Streaming Detection (_recordTextMutation)');

test('S39: single text mutation does NOT trigger streaming', () => {
  const watcher = new DSW({ lastActionType: 'click' });
  assertEqual(watcher._isStreaming, false, 'not streaming initially');
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'default quiet');

  watcher._recordTextMutation();
  assertEqual(watcher._isStreaming, false, 'still not streaming after 1');
  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'unchanged quiet');
});

test('S40: 2 rapid text mutations NOT enough', () => {
  const watcher = new DSW({ lastActionType: 'click' });
  watcher._recordTextMutation();
  watcher._recordTextMutation();
  assertEqual(watcher._isStreaming, false, 'not streaming after 2');
});

test('S41: 3 rapid text mutations triggers streaming mode', () => {
  const watcher = new DSW({ lastActionType: 'click' });
  // All within the detection window (since Date.now() is deterministic in fast tests)
  watcher._recordTextMutation();
  watcher._recordTextMutation();
  watcher._recordTextMutation();

  assertEqual(watcher._isStreaming, true, 'streaming after 3');
  assertEqual(watcher.quietWindowMs, DSW.STREAMING_QUIET_WINDOW_MS, 'quiet extended to streaming');
});

test('S42: streaming mode sticks (no downgrade)', () => {
  const watcher = new DSW({ lastActionType: 'click' });
  // Trigger streaming
  watcher._recordTextMutation();
  watcher._recordTextMutation();
  watcher._recordTextMutation();
  assertEqual(watcher._isStreaming, true, 'streaming on');

  // More mutations — shouldn't change anything
  watcher._recordTextMutation();
  watcher._recordTextMutation();
  assertEqual(watcher._isStreaming, true, 'still streaming');
  assertEqual(watcher.quietWindowMs, DSW.STREAMING_QUIET_WINDOW_MS, 'still extended');
});

test('S43: streaming detection respects time window (old mutations expire)', () => {
  const watcher = new DSW({ lastActionType: 'click' });

  // Manually set up timestamps that are older than the detection window
  const now = Date.now();
  watcher._textMutationTimestamps = [
    now - 1000, // 1s ago — outside 500ms window
    now - 900   // 0.9s ago — outside 500ms window
  ];

  // This is the only one actually in the window
  watcher._recordTextMutation();

  // Should NOT trigger — effectively only 1 mutation in-window
  assertEqual(watcher._isStreaming, false, 'old mutations expired');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTRUCTOR & BASELINE
// ═══════════════════════════════════════════════════════════════════════════════

suite('Constructor & Baseline Capture');

test('S44: constructor captures baseline URL', () => {
  window.location.href = 'https://test.com/abc';
  const watcher = new DSW();
  assertEqual(watcher._baselineUrl, 'https://test.com/abc', 'captured URL');
  window.location.href = 'https://example.com/page1'; // restore
});

test('S45: constructor captures baseline disabled button count', () => {
  _mockDisabledButtons = [
    makeElement('button', { disabled: 'true' }),
    makeElement('button', { disabled: 'true' }),
    makeElement('button', { disabled: 'true' })
  ];
  const watcher = new DSW();
  assertEqual(watcher._baselineDisabledButtons, 3, '3 disabled buttons');
  _mockDisabledButtons = [];
});

test('S46: constructor initializes runtime state', () => {
  const watcher = new DSW();

  assertEqual(watcher._observer, null, 'no observer yet');
  assertEqual(watcher._debounceTimer, null, 'no debounce timer');
  assertEqual(watcher._timeoutTimer, null, 'no timeout timer');
  assertEqual(watcher._resolved, false, 'not resolved');
  assertEqual(watcher._mutationCount, 0, 'mutation count = 0');
  assertEqual(watcher._meaningfulMutationCount, 0, 'meaningful = 0');
  assertEqual(watcher._isStreaming, false, 'not streaming');
  assertEqual(watcher._startTime, 0, 'start time = 0');
  assert(Array.isArray(watcher._textMutationTimestamps), 'timestamps is array');
  assertEqual(watcher._textMutationTimestamps.length, 0, 'timestamps empty');
});

test('S47: constructor uses provided context', () => {
  const watcher = new DSW({
    lastActionType: 'type',
    expectedEffect: 'navigation'
  });
  assertEqual(watcher.lastActionType, 'type', 'action type from context');
  assertEqual(watcher.expectedEffect, 'navigation', 'expected effect from context');
  assertEqual(watcher.quietWindowMs, DSW.TYPING_QUIET_WINDOW_MS, 'type → typing window');
});

test('S48: constructor defaults without context', () => {
  const watcher = new DSW();
  assertEqual(watcher.lastActionType, 'click', 'defaults to click');
  assertEqual(watcher.expectedEffect, null, 'defaults to null');
  assertEqual(watcher.maxWaitMs, DSW.MAX_WAIT_MS, 'max wait');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  FORCE EXIT LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

suite('Force Exit (_forceExit)');

test('S49: forceExit with mutations → partial_progress', () => {
  const watcher = new DSW();
  let resolvedResult = null;
  watcher._resolvePromise = (result) => { resolvedResult = result; };
  watcher._startTime = Date.now();
  watcher._meaningfulMutationCount = 5;

  watcher._forceExit();

  assertEqual(resolvedResult.status, 'partial_progress', 'partial with mutations');
  assertEqual(resolvedResult.meaningfulMutationCount, 5, 'mutation count in result');
  assertEqual(watcher._resolved, true, 'marked as resolved');
});

test('S50: forceExit with NO mutations → forced_unstable', () => {
  const watcher = new DSW();
  let resolvedResult = null;
  watcher._resolvePromise = (result) => { resolvedResult = result; };
  watcher._startTime = Date.now();
  watcher._meaningfulMutationCount = 0;

  watcher._forceExit();

  assertEqual(resolvedResult.status, 'forced_unstable', 'forced unstable');
  assertEqual(resolvedResult.meaningfulMutationCount, 0, 'zero mutations');
});

test('S51: forceExit is idempotent (no-op if already resolved)', () => {
  const watcher = new DSW();
  let callCount = 0;
  watcher._resolvePromise = () => { callCount++; };
  watcher._startTime = Date.now();

  watcher._forceExit(); // First call
  watcher._forceExit(); // Second call — should be no-op

  assertEqual(callCount, 1, 'resolve called only once');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  RESOLUTION & CLEANUP
// ═══════════════════════════════════════════════════════════════════════════════

suite('Resolution (_resolve) & Cleanup');

test('S52: _resolve produces correct result structure', () => {
  const watcher = new DSW();
  let resolvedResult = null;
  watcher._resolvePromise = (result) => { resolvedResult = result; };
  watcher._startTime = Date.now() - 500; // pretend we started 500ms ago
  watcher._mutationCount = 10;
  watcher._meaningfulMutationCount = 3;
  watcher._isStreaming = true;

  watcher._resolve('stable');

  assertEqual(resolvedResult.status, 'stable', 'status');
  assertEqual(resolvedResult.mutationCount, 10, 'mutationCount');
  assertEqual(resolvedResult.meaningfulMutationCount, 3, 'meaningfulMutationCount');
  assertEqual(resolvedResult.streamingDetected, true, 'streamingDetected');
  assertInRange(resolvedResult.waitedMs, 450, 600, 'waitedMs approx 500');
});

test('S53: _resolve is idempotent', () => {
  const watcher = new DSW();
  let callCount = 0;
  watcher._resolvePromise = () => { callCount++; };
  watcher._startTime = Date.now();

  watcher._resolve('stable');
  watcher._resolve('partial_progress');
  watcher._resolve('forced_unstable');

  assertEqual(callCount, 1, 'only called once');
  assertEqual(watcher._resolved, true, 'resolved flag set');
});

test('S54: _cleanup disconnects observer and clears timers', () => {
  const watcher = new DSW();

  // Simulate active state
  watcher._observer = new MockMutationObserver(() => {});
  watcher._debounceTimer = setTimeout(() => {}, 10000);
  watcher._timeoutTimer = setTimeout(() => {}, 10000);
  watcher._expectationCheckInterval = setInterval(() => {}, 100);

  watcher._cleanup();

  assertEqual(watcher._observer, null, 'observer nulled');
  assertEqual(watcher._debounceTimer, null, 'debounce cleared');
  assertEqual(watcher._timeoutTimer, null, 'timeout cleared');
  assertEqual(watcher._expectationCheckInterval, null, 'interval cleared');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  MUTATION OBSERVER CALLBACK LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

suite('Mutation Observer Filtering');

test('S55: childList mutation with non-trivial added node → meaningful', () => {
  const watcher = new DSW();
  // Manually set resolved=false and provide debounce reset tracking
  let debounceResetCount = 0;
  const origReset = watcher._resetDebounce.bind(watcher);
  watcher._resetDebounce = () => { debounceResetCount++; };

  // Start observer to get the callback reference
  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  // Fire a childList mutation with a non-trivial added node
  observer._fire([{
    type: 'childList',
    target: makeElement('div'),
    addedNodes: [makeElement('button', { textContent: 'Submit' })],
    removedNodes: []
  }]);

  assertEqual(watcher._mutationCount, 1, 'total mutation count');
  assertEqual(watcher._meaningfulMutationCount, 1, 'meaningful mutation counted');
  assertEqual(debounceResetCount, 1, 'debounce was reset');

  watcher._cleanup();
});

test('S56: childList mutation with only trivial nodes → NOT meaningful', () => {
  const watcher = new DSW();
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  // Only script and empty text nodes
  observer._fire([{
    type: 'childList',
    target: makeElement('div'),
    addedNodes: [makeElement('script'), makeTextNode('')],
    removedNodes: []
  }]);

  assertEqual(watcher._mutationCount, 1, 'counted');
  assertEqual(watcher._meaningfulMutationCount, 0, 'NOT meaningful');
  assertEqual(debounceResetCount, 0, 'debounce NOT reset');

  watcher._cleanup();
});

test('S57: attribute mutation on TRACKED attribute → meaningful', () => {
  const watcher = new DSW();
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  observer._fire([{
    type: 'attributes',
    target: makeElement('button'),
    attributeName: 'disabled'
  }]);

  assertEqual(watcher._meaningfulMutationCount, 1, 'disabled is meaningful');
  assertEqual(debounceResetCount, 1, 'debounce reset');

  watcher._cleanup();
});

test('S58: attribute mutation on class/style → NOT meaningful', () => {
  const watcher = new DSW();
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  observer._fire([{
    type: 'attributes',
    target: makeElement('div'),
    attributeName: 'class'
  }]);

  observer._fire([{
    type: 'attributes',
    target: makeElement('div'),
    attributeName: 'style'
  }]);

  assertEqual(watcher._mutationCount, 2, '2 mutations counted');
  assertEqual(watcher._meaningfulMutationCount, 0, 'none are meaningful');
  assertEqual(debounceResetCount, 0, 'debounce NOT reset');

  watcher._cleanup();
});

test('S59: characterData mutation → meaningful + streaming tracking', () => {
  const watcher = new DSW();
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  observer._fire([{
    type: 'characterData',
    target: makeTextNode('Hello'),
    attributeName: null
  }]);

  assertEqual(watcher._meaningfulMutationCount, 1, 'text change is meaningful');
  assertEqual(debounceResetCount, 1, 'debounce reset');
  assertEqual(watcher._textMutationTimestamps.length, 1, 'text mutation tracked');

  watcher._cleanup();
});

test('S60: mutation inside ignored tag (script) → NOT meaningful', () => {
  const watcher = new DSW();
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  observer._fire([{
    type: 'childList',
    target: makeElement('script'),
    addedNodes: [makeElement('div')], // would be meaningful if not inside script
    removedNodes: []
  }]);

  assertEqual(watcher._mutationCount, 1, 'counted');
  assertEqual(watcher._meaningfulMutationCount, 0, 'NOT meaningful (inside script)');
  assertEqual(debounceResetCount, 0, 'debounce NOT reset');

  watcher._cleanup();
});

test('S61: multiple mutations in one batch — counts correctly', () => {
  const watcher = new DSW();
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  // Batch of 4 mutations, only 2 are meaningful
  observer._fire([
    { type: 'attributes', target: makeElement('div'), attributeName: 'class' },        // ignored
    { type: 'attributes', target: makeElement('button'), attributeName: 'disabled' },   // meaningful
    { type: 'childList', target: makeElement('div'),
      addedNodes: [makeElement('script')], removedNodes: [] },                           // ignored (trivial)
    { type: 'characterData', target: makeTextNode('updated'), attributeName: null }     // meaningful
  ]);

  assertEqual(watcher._mutationCount, 4, 'all counted');
  assertEqual(watcher._meaningfulMutationCount, 1, 'meaningful incremented once per batch');
  assertEqual(debounceResetCount, 1, 'debounce reset once');

  watcher._cleanup();
});


// ═══════════════════════════════════════════════════════════════════════════════
//  INTEGRATION — Expectation Baseline + Check Together
// ═══════════════════════════════════════════════════════════════════════════════

suite('Integration — Baseline → Mutation → Expectation');

test('S62: enablement workflow — baseline 2 disabled → 1 enabled → satisfied', () => {
  // Capture baseline with 2 disabled buttons
  _mockDisabledButtons = [
    makeElement('button', { disabled: 'true' }),
    makeElement('button', { disabled: 'true' })
  ];
  const watcher = new DSW({ expectedEffect: 'enablement' });
  assertEqual(watcher._baselineDisabledButtons, 2, 'baseline = 2');

  // Check before change — not satisfied
  assertEqual(watcher._checkExpectation(), false, 'before enablement');

  // Simulate one button becoming enabled
  _mockDisabledButtons = [makeElement('button', { disabled: 'true' })];

  // Now check — satisfied
  assertEqual(watcher._checkExpectation(), true, 'after enablement');

  _mockDisabledButtons = [];
});

test('S63: navigation workflow — baseline URL → new URL → satisfied', () => {
  window.location.href = 'https://shop.com/products';
  const watcher = new DSW({ expectedEffect: 'navigation' });

  assertEqual(watcher._checkExpectation(), false, 'same URL');

  window.location.href = 'https://shop.com/products/123';
  assertEqual(watcher._checkExpectation(), true, 'new URL');

  window.location.href = 'https://example.com/page1'; // restore
});

test('S64: subtree_expansion workflow — accumulate mutations → satisfied', () => {
  const watcher = new DSW({ expectedEffect: 'subtree_expansion' });

  assertEqual(watcher._checkExpectation(), false, '0 mutations');

  watcher._meaningfulMutationCount = 3;
  assertEqual(watcher._checkExpectation(), false, '3 mutations');

  watcher._meaningfulMutationCount = 5;
  assertEqual(watcher._checkExpectation(), true, '5 mutations = threshold');

  watcher._meaningfulMutationCount = 10;
  assertEqual(watcher._checkExpectation(), true, '10 mutations > threshold');
});

test('S65: streaming mode extends quiet window through mutation callback', () => {
  const watcher = new DSW({ lastActionType: 'click' });
  let debounceResetCount = 0;
  watcher._resetDebounce = () => { debounceResetCount++; };

  assertEqual(watcher.quietWindowMs, DSW.DEFAULT_QUIET_WINDOW_MS, 'starts default');

  watcher._startObserver();
  const observer = MockMutationObserver._lastInstance;

  // Send 3 rapid characterData mutations → triggers streaming
  observer._fire([
    { type: 'characterData', target: makeTextNode('a'), attributeName: null },
    { type: 'characterData', target: makeTextNode('b'), attributeName: null },
    { type: 'characterData', target: makeTextNode('c'), attributeName: null }
  ]);

  assertEqual(watcher._isStreaming, true, 'streaming detected via observer');
  assertEqual(watcher.quietWindowMs, DSW.STREAMING_QUIET_WINDOW_MS, 'quiet extended');

  watcher._cleanup();
});


// ═══════════════════════════════════════════════════════════════════════════════
//  FULL LIFECYCLE ASYNC TESTS 
// ═══════════════════════════════════════════════════════════════════════════════

suite('Full Lifecycle — Async (waitForStability)');

async function runAsyncTests() {
  _mockLoaders = [];
  _mockDisabledButtons = [];

  await asyncTest('S66: resolves as stable when no mutations occur', async () => {
    // Override quiet window to be very short for test speed
    const origDefault = DSW.DEFAULT_QUIET_WINDOW_MS;
    DSW.DEFAULT_QUIET_WINDOW_MS = 50;

    const watcher = new DSW({ lastActionType: 'click' });
    watcher.quietWindowMs = 50;

    const result = await watcher.waitForStability();

    assertEqual(result.status, 'stable', 'stable status');
    assertEqual(result.meaningfulMutationCount, 0, 'no mutations');
    assertEqual(result.streamingDetected, false, 'no streaming');
    assertInRange(result.waitedMs, 30, 500, 'waited ~50ms');

    DSW.DEFAULT_QUIET_WINDOW_MS = origDefault;
  });

  await asyncTest('S67: resolves as semantic_readiness_met for navigation', async () => {
    window.location.href = 'https://example.com/before';
    const watcher = new DSW({ expectedEffect: 'navigation' });

    // Simulate navigation after 100ms
    setTimeout(() => {
      window.location.href = 'https://example.com/after';
    }, 100);

    const result = await watcher.waitForStability();

    assertEqual(result.status, 'semantic_readiness_met', 'expectation met');
    assertInRange(result.waitedMs, DSW.MIN_WAIT_MS, 1000, 'fast-forwarded');

    window.location.href = 'https://example.com/page1'; // restore
  });

  await asyncTest('S68: result has all required fields', async () => {
    const watcher = new DSW({ lastActionType: 'click' });
    watcher.quietWindowMs = 50;

    const result = await watcher.waitForStability();

    assert('status' in result, 'has status');
    assert('waitedMs' in result, 'has waitedMs');
    assert('mutationCount' in result, 'has mutationCount');
    assert('meaningfulMutationCount' in result, 'has meaningfulMutationCount');
    assert('streamingDetected' in result, 'has streamingDetected');
    assertEqual(typeof result.status, 'string', 'status is string');
    assertEqual(typeof result.waitedMs, 'number', 'waitedMs is number');
    assertEqual(typeof result.mutationCount, 'number', 'mutationCount is number');
    assertEqual(typeof result.streamingDetected, 'boolean', 'streamingDetected is boolean');
  });

  // Print combined sync + async results
  const totalPassed = _passed + _asyncPassed;
  const totalFailed = _failed + _asyncFailed;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Results: ${totalPassed} passed, ${totalFailed} failed, ${totalPassed + totalFailed} total`);
  console.log(`  (Sync: ${_passed}p/${_failed}f, Async: ${_asyncPassed}p/${_asyncFailed}f)`);
  console.log(`${'═'.repeat(70)}\n`);
  if (totalFailed > 0) {
    process.exit(1);
  }
}

runAsyncTests();
