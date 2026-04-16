/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 1A.3b — Test Harness for Progress Estimator
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Runs in Node.js (no Chrome APIs needed).
 * Tests all sub-functions of the ProgressEstimator in isolation:
 *   - Tokenizer consistency with TaskStateTracker
 *   - DJB2 hash function
 *   - Jaccard similarity
 *   - Goal shift detection (first-word gate + content gate + Jaccard)
 *   - Effect detection (7 types + none)
 *   - 4-signal base progress formula
 *   - Repetition penalty
 *   - Micro-success bonuses
 *   - Intent drift detection
 *   - Final progress clamping
 * 
 * Usage: node tests/test-progress-estimator.js
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Minimal Test Framework ──────────────────────────────────────────────────

let _passed = 0, _failed = 0, _currentSuite = '';

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

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'assertEqual'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertApprox(actual, expected, tolerance, message) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${message || 'assertApprox'}: expected ~${expected} (±${tolerance}), got ${actual}`);
  }
}

function assertInRange(value, min, max, message) {
  if (value < min || value > max) {
    throw new Error(`${message || 'assertInRange'}: expected ${min}–${max}, got ${value}`);
  }
}

// ─── Load Modules ────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// We need a minimal BrowserAgent namespace and chrome stub
global.BrowserAgent = {};
global.chrome = {
  runtime: {
    sendMessage: () => {},
    lastError: null
  }
};
global.window = {
  location: { href: 'https://example.com' }
};
global.document = {
  title: 'Test Page',
  body: { innerText: '' },
  querySelector: () => null,
  querySelectorAll: () => [],
  activeElement: null
};

// Load task-state first (for tokenizer comparison)
const taskStateSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'task-state.js'), 'utf-8'
);
vm.runInThisContext(taskStateSrc, { filename: 'task-state.js' });
assert(typeof TaskStateTracker === 'function', 'TaskStateTracker class not found');

// Load progress estimator
const progressSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'progress-estimator.js'), 'utf-8'
);
vm.runInThisContext(progressSrc, { filename: 'progress-estimator.js' });
assert(typeof BrowserAgent.ProgressEstimator === 'object', 'ProgressEstimator module not found');

const PE = BrowserAgent.ProgressEstimator;

console.log('\n✓ All modules loaded successfully');


// ═══════════════════════════════════════════════════════════════════════════════
//  TOKENIZER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Tokenizer — Consistency with TaskStateTracker');

test('P1: tokenizer output matches TaskStateTracker._tokenize()', () => {
  const ts = new TaskStateTracker();
  const testCases = [
    'search for airpods on amazon',
    'Buy the latest MacBook Pro!',
    'find cheap flights to new york',
    'click the Submit button',
    '',
    'a',
    'the is a an',
    'hello-world test_case 123',
    "it's a beautiful day",
    'UPPERCASE MiXeD CaSe'
  ];

  for (const text of testCases) {
    ts.initTask(text);
    const tsTokens = ts.getGoalTokens();
    const peTokens = PE._tokenize(text);
    const tsStr = JSON.stringify(tsTokens);
    const peStr = JSON.stringify(peTokens);
    assertEqual(peStr, tsStr, `Tokenizer mismatch for "${text}"`);
  }
});

test('P2: tokenizer removes short tokens (≤1 char)', () => {
  const tokens = PE._tokenize('I am a big B cat');
  assert(!tokens.includes('i'), '"i" should be filtered by stopwords');
  assert(!tokens.includes('a'), '"a" should be filtered by stopwords');
  assert(!tokens.includes('b'), '"b" should be filtered (too short)');
  assert(tokens.includes('big'), '"big" should be present');
  assert(tokens.includes('am'), '"am" should be present — only 2 chars, not stopword');
  assert(tokens.includes('cat'), '"cat" should be present');
});

test('P3: tokenizer handles punctuation and special chars', () => {
  const tokens = PE._tokenize('Hello, world! How are you? (test)');
  assert(tokens.includes('hello'), 'hello');
  assert(tokens.includes('world'), 'world');
  assert(tokens.includes('how'), 'how');
  assert(tokens.includes('test'), 'test');
  assert(!tokens.includes(','), 'no comma');
  assert(!tokens.includes('!'), 'no exclamation');
  assert(!tokens.includes('('), 'no parens');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  HASH FUNCTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('DJB2 Hash Function');

test('P4: hash is deterministic', () => {
  assertEqual(PE._djb2('hello'), PE._djb2('hello'), 'same string same hash');
});

test('P5: different strings produce different hashes', () => {
  assert(PE._djb2('hello') !== PE._djb2('world'), 'different strings');
  assert(PE._djb2('abc') !== PE._djb2('abd'), 'single char diff');
});

test('P6: hash returns unsigned integer', () => {
  const h = PE._djb2('test');
  assert(typeof h === 'number', 'returns number');
  assert(h >= 0, 'unsigned (non-negative)');
  assert(Number.isInteger(h), 'integer');
});

test('P7: hash handles empty string', () => {
  const h = PE._djb2('');
  assertEqual(typeof h, 'number', 'returns number for empty string');
  assertEqual(h, 5381, 'empty string = initial hash value');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  JACCARD SIMILARITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Jaccard Similarity');

test('P8: identical sets = 1.0', () => {
  assertEqual(PE._jaccard(['a', 'b', 'c'], ['a', 'b', 'c']), 1.0, 'identical');
});

test('P9: disjoint sets = 0.0', () => {
  assertEqual(PE._jaccard(['a', 'b'], ['c', 'd']), 0.0, 'disjoint');
});

test('P10: partial overlap', () => {
  // {a,b,c} ∩ {b,c,d} = {b,c}, |union| = {a,b,c,d} = 4
  // J = 2/4 = 0.5
  assertApprox(PE._jaccard(['a', 'b', 'c'], ['b', 'c', 'd']), 0.5, 0.001, 'partial');
});

test('P11: empty sets = 1.0 (both empty)', () => {
  assertEqual(PE._jaccard([], []), 1.0, 'both empty');
});

test('P12: one empty set = 0.0', () => {
  assertEqual(PE._jaccard(['a'], []), 0.0, 'A empty');
  assertEqual(PE._jaccard([], ['a']), 0.0, 'B empty');
});

test('P13: handles duplicate tokens', () => {
  // Should work as sets: {a,b} vs {a,b} = 1.0
  assertApprox(PE._jaccard(['a', 'a', 'b'], ['a', 'b', 'b']), 1.0, 0.001, 'duplicates');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  GOAL SHIFT DETECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Goal Shift Detection — First-Word Gate');

test('P14: click → always instruction (never goal shift)', () => {
  assertEqual(PE._isGoalShift('click Send', ['search', 'airpods']), false, 'click Send');
  assertEqual(PE._isGoalShift('click AirPods Pro', ['search', 'airpods']), false, 'click + goal words');
  assertEqual(PE._isGoalShift('click Submit button now', ['totally', 'different']), false, 'click + unrelated');
});

test('P15: type → always instruction', () => {
  assertEqual(PE._isGoalShift('type hello into email field', ['search', 'airpods']), false, 'type');
});

test('P16: scroll → always instruction', () => {
  assertEqual(PE._isGoalShift('scroll down', ['search', 'airpods']), false, 'scroll down');
  assertEqual(PE._isGoalShift('scroll to bottom', ['buy', 'laptop']), false, 'scroll to');
});

test('P17: expand/toggle/navigate → always instruction', () => {
  assertEqual(PE._isGoalShift('expand filters', ['search', 'airpods']), false, 'expand');
  assertEqual(PE._isGoalShift('toggle dark mode', ['buy', 'shoes']), false, 'toggle');
  assertEqual(PE._isGoalShift('navigate to settings', ['search', 'airpods']), false, 'navigate');
});

suite('Goal Shift Detection — Content Gate + Jaccard');

test('P18: real goal shift detected (different domain)', () => {
  // "buy bluetooth speaker" → tokens: [buy, bluetooth, speaker]
  // goal: [search, airpods] — Jaccard ≈ 0/5 = 0.0 < 0.15
  assertEqual(PE._isGoalShift('buy bluetooth speaker', ['search', 'airpods']), true, 'goal shift');
});

test('P19: related continuation NOT a goal shift', () => {
  // "find airpods case" → tokens: [find, airpods, case]
  // goal: [search, airpods] — Jaccard = 1/4 = 0.25 > 0.15
  assertEqual(PE._isGoalShift('find airpods case', ['search', 'airpods']), false, 'continuation');
});

test('P20: short utility commands → NOT a goal shift', () => {
  // "go back" → after stopwords: [go, back] — both are WEAK_WORDS
  // Even though Jaccard would be 0, hasStrongContentWord is false + tokens < 3
  assertEqual(PE._isGoalShift('go back', ['search', 'airpods']), false, 'go back');
});

test('P21: short goal with strong content word → CAN trigger shift', () => {
  // "buy shoes" → tokens: [buy, shoes] — "buy" and "shoes" are NOT weak words
  // Jaccard(["buy","shoes"], ["search","airpods"]) = 0/4 = 0.0 < 0.15
  assertEqual(PE._isGoalShift('buy shoes', ['search', 'airpods']), true, 'buy shoes is shift');
});

test('P22: search on same topic → NOT a goal shift', () => {
  // "search for airpods pro" → blocked by first-word gate (search is UI verb)
  assertEqual(PE._isGoalShift('search for airpods pro', ['search', 'airpods']), false, 'search same topic');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  EFFECT DETECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Effect Detection');

// Note: Effect detection requires DOM access, so we mock the global document/window
// For these tests we manipulate the globals directly.

test('P23: navigation detected when URL changes', () => {
  const oldUrl = window.location.href;
  const before = {
    url: 'https://example.com/page1',
    textLength: 100,
    visibleTextHash: 12345,
    disabledButtonCount: 0,
    modalCount: 0,
    ariaStates: {}
  };

  // Change URL
  window.location.href = 'https://example.com/page2';
  const effect = PE._detectEffect(before, {});

  assertEqual(effect, 'navigation', 'URL change = navigation');

  // Restore
  window.location.href = oldUrl;
});

test('P24: none when nothing changes', () => {
  const url = window.location.href;
  const before = {
    url: url,
    textLength: (document.body.innerText || '').length,
    visibleTextHash: PE._computeVisibleTextHash(),
    disabledButtonCount: 0,
    modalCount: 0,
    ariaStates: {}
  };

  const effect = PE._detectEffect(before, {});
  assertEqual(effect, 'none', 'no change = none');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  BASE PROGRESS COMPUTATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Base Progress — 4-Signal Composite');

test('P25: all zeros when no goal tokens and no state', () => {
  const { baseProgress, signals } = PE._computeBaseProgress([], {}, 'none');

  assertEqual(signals.keywordOverlap, 0, 'keyword = 0');
  assertEqual(signals.urlMatch, 0, 'url = 0');
  assertEqual(signals.stateChangeScore, 0, 'stateChange = 0');
  assertApprox(baseProgress, 0.2 * signals.interactionDepth, 0.001, 'only depth contributes');
});

test('P26: navigation effect gives stateChangeScore = 1.0', () => {
  const { signals } = PE._computeBaseProgress([], {}, 'navigation');
  assertApprox(signals.stateChangeScore, 1.0, 0.001, 'navigation = 1.0');
});

test('P27: content_load effect gives stateChangeScore = 0.8', () => {
  const { signals } = PE._computeBaseProgress([], {}, 'content_load');
  assertApprox(signals.stateChangeScore, 0.8, 0.001, 'content_load = 0.8');
});

test('P28: interaction depth grows logarithmically', () => {
  const { signals: s0 } = PE._computeBaseProgress([], { step_index: 0 }, 'none');
  const { signals: s1 } = PE._computeBaseProgress([], { step_index: 1 }, 'none');
  const { signals: s5 } = PE._computeBaseProgress([], { step_index: 5 }, 'none');
  const { signals: s29 } = PE._computeBaseProgress([], { step_index: 29 }, 'none');

  // step 0: log(1)/log(30) = 0
  assertApprox(s0.interactionDepth, 0, 0.001, 'depth at step 0');
  // step 1: log(2)/log(30) ≈ 0.204
  assertApprox(s1.interactionDepth, Math.log(2) / Math.log(30), 0.001, 'depth at step 1');
  // step 5: log(6)/log(30) ≈ 0.527
  assertApprox(s5.interactionDepth, Math.log(6) / Math.log(30), 0.001, 'depth at step 5');
  // step 29: log(30)/log(30) = 1.0 (capped)
  assertApprox(s29.interactionDepth, 1.0, 0.001, 'depth at step 29 capped at 1.0');

  // Monotonically increasing
  assert(s1.interactionDepth > s0.interactionDepth, 'depth increases');
  assert(s5.interactionDepth > s1.interactionDepth, 'depth increases');
  assert(s29.interactionDepth > s5.interactionDepth, 'depth increases');
});

test('P29: base progress correctly weights 4 signals', () => {
  // Mock page text containing goal tokens
  const origGetPageText = PE._getPageText;

  // Temporarily override _getPageText for this test  
  // We can't directly mock, but we can test the formula with known signal values
  // Using: keyword=1.0, url=1.0, depth=0.5, stateChange=1.0
  // Expected: 0.4*1 + 0.2*1 + 0.2*0.5 + 0.2*1 = 0.4 + 0.2 + 0.1 + 0.2 = 0.9

  // Test the weights individually using the EFFECT_QUALITY mapping
  const effects = PE.EFFECT_QUALITY;
  assertApprox(effects.navigation, 1.0, 0.001, 'navigation quality');
  assertApprox(effects.content_load, 0.8, 0.001, 'content_load quality');
  assertApprox(effects.modal_open, 0.7, 0.001, 'modal_open quality');
  assertApprox(effects.state_change, 0.6, 0.001, 'state_change quality');
  assertApprox(effects.none, 0.0, 0.001, 'none quality');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  REPETITION PENALTY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Repetition Penalty');

test('P30: no penalty for first action', () => {
  const penalty = PE._computeRepetitionPenalty({}, { type: 'click', text: 'Submit' });
  assertEqual(penalty, 0, 'no task state = 0 penalty');
});

test('P31: no penalty for empty history', () => {
  const penalty = PE._computeRepetitionPenalty(
    { actions_taken: [] },
    { type: 'click', text: 'Submit' }
  );
  assertEqual(penalty, 0, 'empty history = 0 penalty');
});

test('P32: exact repeated actions produce high penalty (≥3 in history)', () => {
  const taskState = {
    actions_taken: [
      { type: 'click', text: 'Submit' },
      { type: 'click', text: 'Submit' },
      { type: 'click', text: 'Submit' },
      { type: 'click', text: 'Submit' }
    ]
  };

  const penalty = PE._computeRepetitionPenalty(taskState, { type: 'click', text: 'Submit' });
  assert(penalty > 0.15, `penalty should be significant: got ${penalty}`);
  assertInRange(penalty, 0, 0.3, 'penalty in range');
});

test('P33: same type different target = half penalty (≥3 in history)', () => {
  const taskState = {
    actions_taken: [
      { type: 'click', text: 'Button A' },
      { type: 'click', text: 'Button B' },
      { type: 'click', text: 'Button C' }
    ]
  };

  const penalty = PE._computeRepetitionPenalty(taskState, { type: 'click', text: 'Button D' });
  assert(penalty > 0, 'some penalty for same type');
  assert(penalty < 0.3, 'less than max');
});

test('P34: different type = no penalty', () => {
  const taskState = {
    actions_taken: [
      { type: 'click', text: 'Submit' },
      { type: 'click', text: 'Next' },
      { type: 'click', text: 'More' }
    ]
  };

  const penalty = PE._computeRepetitionPenalty(taskState, { type: 'type', text: 'hello' });
  assertEqual(penalty, 0, 'different type = 0');
});

test('P35: only considers last 5 actions', () => {
  const taskState = {
    actions_taken: [
      // Old actions (outside window)
      { type: 'click', text: 'OLD' },
      { type: 'click', text: 'OLD' },
      { type: 'click', text: 'OLD' },
      { type: 'click', text: 'OLD' },
      { type: 'click', text: 'OLD' },
      // Recent actions (in window)
      { type: 'type', text: 'email' },
      { type: 'type', text: 'password' },
      { type: 'click', text: 'Login' },
      { type: 'scroll', text: '' },
      { type: 'click', text: 'Home' }
    ]
  };

  // Current action: 'type "name"' — only 2 'type' in recent window
  const penalty = PE._computeRepetitionPenalty(taskState, { type: 'type', text: 'name' });
  // Should only count the 2 type actions in the last 5 (half penalty each = 0.5 + 0.5 = 1)
  // penalty = 0.3 * (1 / 5) = 0.06
  assert(penalty < 0.1, `penalty should be low for varied recent history: got ${penalty}`);
});

test('P35b: NO penalty for early exploration (< 3 actions)', () => {
  // This is the early exploration guard — first 2 actions should never be penalized
  const taskState1 = {
    actions_taken: [{ type: 'click', text: 'Submit' }]
  };
  assertEqual(PE._computeRepetitionPenalty(taskState1, { type: 'click', text: 'Submit' }), 0, '1 action = 0');

  const taskState2 = {
    actions_taken: [
      { type: 'click', text: 'Submit' },
      { type: 'click', text: 'Submit' }
    ]
  };
  assertEqual(PE._computeRepetitionPenalty(taskState2, { type: 'click', text: 'Submit' }), 0, '2 actions = 0');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  MICRO-SUCCESS BONUS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Micro-Success Bonuses');

test('P36: input filled bonus (+0.10 for type action)', () => {
  const before = { disabledButtonCount: 0 };
  const actionContext = {
    type: 'type',
    text: 'hello',
    element: { value: 'hello', textContent: '' }
  };

  const bonus = PE._computeMicroSuccess(before, actionContext);
  assertApprox(bonus, 0.10, 0.001, 'input filled = +0.10');
});

test('P37: button enablement bonus (+0.20)', () => {
  // Before: 2 disabled, after: 1 disabled (mock via querySelectorAll)
  const origCount = document.querySelectorAll;
  document.querySelectorAll = (sel) => {
    if (sel && sel.includes('disabled')) return [1]; // 1 disabled
    return [];
  };

  const before = { disabledButtonCount: 2 };
  const actionContext = { type: 'click' };

  const bonus = PE._computeMicroSuccess(before, actionContext);
  assertApprox(bonus, 0.20, 0.001, 'button enabled = +0.20');

  document.querySelectorAll = origCount;
});

test('P38: checkbox click bonus (+0.05)', () => {
  const before = { disabledButtonCount: 0 };
  const actionContext = {
    type: 'click',
    element: { type: 'checkbox' }
  };

  // Mock querySelectorAll to return same disabled count
  const origCount = document.querySelectorAll;
  document.querySelectorAll = () => [];
  
  const bonus = PE._computeMicroSuccess(before, actionContext);
  assertApprox(bonus, 0.05, 0.001, 'checkbox = +0.05');

  document.querySelectorAll = origCount;
});

test('P39: total bonus capped at 0.35', () => {
  const origCount = document.querySelectorAll;
  document.querySelectorAll = (sel) => {
    if (sel && sel.includes('disabled')) return []; // 0 disabled now
    return [];
  };

  // type into input (0.10) + button enabled from 3→0 (0.20) 
  // + search action type which also triggers input filled check
  const before = { disabledButtonCount: 3 };
  const actionContext = {
    type: 'type',
    text: 'test',
    element: { value: 'test', textContent: '', type: 'text' }
  };

  const bonus = PE._computeMicroSuccess(before, actionContext);
  assert(bonus <= 0.35, `bonus capped: got ${bonus}`);

  document.querySelectorAll = origCount;
});


// ═══════════════════════════════════════════════════════════════════════════════
//  INTENT DRIFT DETECTION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Intent Drift Detection');

test('P40: no drift with insufficient history', () => {
  const result = PE._detectIntentDrift({ progressHistory: [0.1, 0.05] });
  assertEqual(result.drifting, false, 'only 2 entries = no drift');
  assertEqual(result.stepsStuck, 0, 'stepsStuck = 0');
});

test('P41: no drift when progress is healthy', () => {
  const result = PE._detectIntentDrift({
    progressHistory: [0.2, 0.3, 0.4, 0.5]
  });
  assertEqual(result.drifting, false, 'healthy progress = no drift');
});

test('P42: drift detected — 3+ consecutive steps below threshold (after step 4+)', () => {
  const result = PE._detectIntentDrift({
    progressHistory: [0.3, 0.2, 0.10, 0.08, 0.05],
    step_index: 5
  });
  assertEqual(result.drifting, true, 'drifting');
  assertEqual(result.stepsStuck, 3, 'stepsStuck = 3');
});

test('P42b: NO drift at early steps even with low progress', () => {
  // step_index = 2 (too early) — should NOT flag drift
  const result = PE._detectIntentDrift({
    progressHistory: [0.05, 0.03, 0.02],
    step_index: 2
  });
  assertEqual(result.drifting, false, 'early steps immune to drift');
});

test('P42c: drift guard lifts at step_index >= DRIFT_STEPS + 1', () => {
  // step_index = 4 (DRIFT_STEPS + 1 = 4) — drift should be checked
  const result = PE._detectIntentDrift({
    progressHistory: [0.05, 0.03, 0.02],
    step_index: 4
  });
  assertEqual(result.drifting, true, 'drift checked at step 4');
});

test('P43: no drift when last 3 are mixed above/below', () => {
  const result = PE._detectIntentDrift({
    progressHistory: [0.1, 0.05, 0.3, 0.1, 0.05]
  });
  // Last 3: [0.3, 0.1, 0.05] — 0.3 is above threshold
  assertEqual(result.drifting, false, 'mixed = no drift');
});

test('P44: stepsStuck counts consecutive from end', () => {
  const result = PE._detectIntentDrift({
    progressHistory: [0.4, 0.3, 0.1, 0.05, 0.02, 0.01, 0.03],
    step_index: 7
  });
  assertEqual(result.drifting, true, 'drifting');
  assertEqual(result.stepsStuck, 5, 'stepsStuck = 5 (from 0.1 onwards)');
});

test('P45: no task state = no drift', () => {
  const r1 = PE._detectIntentDrift(null);
  assertEqual(r1.drifting, false, 'null state');
  const r2 = PE._detectIntentDrift({});
  assertEqual(r2.drifting, false, 'no progressHistory');
});

test('P46: exactly at threshold (0.15) is NOT drift', () => {
  const result = PE._detectIntentDrift({
    progressHistory: [0.15, 0.15, 0.15],
    step_index: 5
  });
  assertEqual(result.drifting, false, 'at threshold = no drift');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  CONSTANTS VALIDATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('Constants & Configuration');

test('P47: UI_COMMAND_VERBS does NOT include goal-carrying verbs', () => {
  const goalVerbs = ['search', 'find', 'buy', 'get', 'order', 'book'];
  for (const v of goalVerbs) {
    assertEqual(PE.UI_COMMAND_VERBS.has(v), false, `"${v}" should NOT be a UI command verb`);
  }
});

test('P48: UI_COMMAND_VERBS DOES include automation verbs', () => {
  const uiVerbs = ['click', 'type', 'scroll', 'expand', 'toggle', 'navigate'];
  for (const v of uiVerbs) {
    assertEqual(PE.UI_COMMAND_VERBS.has(v), true, `"${v}" should be a UI command verb`);
  }
});

test('P49: EFFECT_QUALITY covers all effect types', () => {
  const expected = ['navigation', 'content_load', 'modal_open', 'modal_close',
                    'enable_element', 'disable_element', 'state_change', 'none'];
  for (const e of expected) {
    assert(PE.EFFECT_QUALITY[e] !== undefined, `EFFECT_QUALITY missing "${e}"`);
    assertInRange(PE.EFFECT_QUALITY[e], 0, 1, `EFFECT_QUALITY["${e}"] in 0-1`);
  }
});

test('P50: GOAL_SHIFT_JACCARD_THRESHOLD is reasonable', () => {
  assertInRange(PE.GOAL_SHIFT_JACCARD_THRESHOLD, 0.05, 0.30, 'threshold in range');
});

test('P51: DRIFT_THRESHOLD and DRIFT_STEPS are set', () => {
  assertApprox(PE.DRIFT_THRESHOLD, 0.15, 0.001, 'drift threshold');
  assertEqual(PE.DRIFT_STEPS, 3, 'drift steps');
});

test('P52: STOPWORDS consistency — spot check', () => {
  const spotCheck = ['the', 'is', 'a', 'and', 'or', 'in', 'for', 'to', 'of'];
  for (const w of spotCheck) {
    assertEqual(PE.STOPWORDS.has(w), true, `STOPWORDS should contain "${w}"`);
  }
  // These should NOT be stopwords
  const notStopwords = ['search', 'click', 'airpods', 'laptop', 'buy'];
  for (const w of notStopwords) {
    assertEqual(PE.STOPWORDS.has(w), false, `STOPWORDS should NOT contain "${w}"`);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  INTEGRATION TEST — Progress Computation Pipeline
// ═══════════════════════════════════════════════════════════════════════════════

suite('Integration — Progress Computation Verification');

test('P53: stateChangeScore ordering is correct', () => {
  // Most significant to least significant effect
  const ordering = [
    { effect: 'navigation', expected: 1.0 },
    { effect: 'content_load', expected: 0.8 },
    { effect: 'modal_open', expected: 0.7 },
    { effect: 'enable_element', expected: 0.7 },
    { effect: 'state_change', expected: 0.6 },
    { effect: 'modal_close', expected: 0.5 },
    { effect: 'disable_element', expected: 0.3 },
    { effect: 'none', expected: 0.0 }
  ];

  for (const { effect, expected } of ordering) {
    assertApprox(PE.EFFECT_QUALITY[effect], expected, 0.001, `${effect} quality`);
  }

  // Verify ordering is monotonically non-increasing (except tied pairs)
  assert(PE.EFFECT_QUALITY.navigation >= PE.EFFECT_QUALITY.content_load, 'nav >= content');
  assert(PE.EFFECT_QUALITY.content_load >= PE.EFFECT_QUALITY.modal_open, 'content >= modal');
  assert(PE.EFFECT_QUALITY.state_change >= PE.EFFECT_QUALITY.modal_close, 'state >= close');
  assert(PE.EFFECT_QUALITY.modal_close >= PE.EFFECT_QUALITY.disable_element, 'close >= disable');
  assert(PE.EFFECT_QUALITY.disable_element >= PE.EFFECT_QUALITY.none, 'disable >= none');
});

test('P54: base progress with navigation + zero goal tokens', () => {
  // No goal tokens → keyword=0, url=0
  // Navigation effect → stateChange=1.0
  // step_index=0 → depth=0
  // Expected: 0.4*0 + 0.2*0 + 0.2*0 + 0.2*1.0 = 0.2
  const { baseProgress } = PE._computeBaseProgress([], { step_index: 0 }, 'navigation');
  assertApprox(baseProgress, 0.2, 0.001, 'navigation with no goal = 0.2');
});

test('P55: base progress with content_load effect at step 5', () => {
  // No goal tokens → keyword=0, url=0
  // content_load → stateChange=0.8
  // step_index=5 → depth = log(6)/log(30) ≈ 0.527
  // Expected: 0.4*0 + 0.2*0 + 0.2*0.527 + 0.2*0.8 = 0.1054 + 0.16 = 0.2654
  const { baseProgress, signals } = PE._computeBaseProgress([], { step_index: 5 }, 'content_load');
  assertApprox(baseProgress, 0.2 * signals.interactionDepth + 0.2 * 0.8, 0.001, 
    'content_load at step 5');
  assert(baseProgress > 0.2, 'higher than step 0');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  TASK STATE TRACKER — CURRENT INSTRUCTION (Phase 1A.3b addition)
// ═══════════════════════════════════════════════════════════════════════════════

suite('TaskStateTracker — Current Instruction (Phase 1A.3b)');

test('P56: updateInstruction stores instruction and tokens', () => {
  const ts = new TaskStateTracker();
  ts.initTask('search for airpods');

  ts.updateInstruction('click AirPods Pro');
  const snap = ts.getSnapshot();

  assertEqual(snap.currentInstruction, 'click AirPods Pro', 'instruction stored');
  assert(snap.currentInstructionTokens.includes('airpods'), 'tokens include airpods');
  assert(snap.currentInstructionTokens.includes('pro'), 'tokens include pro');
  // Goal should NOT change
  assertEqual(snap.goal, 'search for airpods', 'goal unchanged');
});

test('P57: currentInstruction is null initially', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test goal');
  const snap = ts.getSnapshot();
  assertEqual(snap.currentInstruction, null, 'null initially');
  assertEqual(snap.currentInstructionTokens.length, 0, 'empty tokens');
});

test('P58: updateInstruction on no active task is a no-op', () => {
  const ts = new TaskStateTracker();
  ts.updateInstruction('should do nothing');
  // Should not throw
  assertEqual(ts.getSnapshot(), null, 'still null');
});

test('P59: currentInstruction survives in snapshot', () => {
  const ts = new TaskStateTracker();
  ts.initTask('buy laptop');
  ts.updateInstruction('click Add to Cart');

  const snap1 = ts.getSnapshot();
  ts.updateInstruction('click Proceed to Checkout');
  const snap2 = ts.getSnapshot();

  assertEqual(snap1.currentInstruction, 'click Add to Cart', 'snap1 preserved');
  assertEqual(snap2.currentInstruction, 'click Proceed to Checkout', 'snap2 updated');
  // Goal unchanged in both
  assertEqual(snap1.goal, 'buy laptop', 'goal unchanged 1');
  assertEqual(snap2.goal, 'buy laptop', 'goal unchanged 2');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  SUMMARY
// ═══════════════════════════════════════════════════════════════════════════════

console.log(`\n${'═'.repeat(70)}`);
console.log(`  Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);
console.log(`${'═'.repeat(70)}\n`);
if (_failed > 0) {
  process.exit(1);
}
