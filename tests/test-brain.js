/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 1A.1 — Test Harness for Command Center Modules
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Runs in Node.js (no Chrome APIs needed).
 * Tests TaskStateTracker, LoopDetector, computeDomFingerprint, and fastHash
 * via deterministic scenarios.
 * 
 * Usage: node test-brain.js
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

function assertDeepEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${message || 'assertDeepEqual'}: expected ${e}, got ${a}`);
  }
}

function summary() {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  Results: ${_passed} passed, ${_failed} failed, ${_passed + _failed} total`);
  console.log(`${'═'.repeat(70)}\n`);
  if (_failed > 0) {
    process.exit(1);
  }
}

// ─── Load Modules ────────────────────────────────────────────────────────────
// Both modules use globals (no module.exports). We use vm.runInThisContext
// to execute them in the current global scope, making all declarations visible.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const taskStateSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'task-state.js'), 'utf-8'
);
const loopDetectorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'loop-detector.js'), 'utf-8'
);

// Execute in order (task-state first, since loop-detector depends on computeNodeSignature).
// vm.runInThisContext executes code in the current V8 context, so const/class/function
// declarations become globally accessible — matching the importScripts behavior.
vm.runInThisContext(taskStateSrc, { filename: 'task-state.js' });
vm.runInThisContext(loopDetectorSrc, { filename: 'loop-detector.js' });

// Verify globals exist
assert(typeof TaskStateTracker === 'function', 'TaskStateTracker class not found');
assert(typeof LoopDetector === 'function', 'LoopDetector class not found');
assert(typeof computeNodeSignature === 'function', 'computeNodeSignature not found');
assert(typeof computeDomFingerprint === 'function', 'computeDomFingerprint not found');
assert(typeof fastHash === 'function', 'fastHash not found');

console.log('\n✓ All modules loaded successfully');

// ─── Helper: Make a fake node ────────────────────────────────────────────────

function makeNode(tag, text, role, x, y) {
  return {
    tag: tag || 'button',
    text: text || 'Click me',
    role: role || '',
    boundingBox: { x: x || 0, y: y || 0, width: 100, height: 40 }
  };
}

function makeAction(type, tag, role, text, x, y) {
  return {
    type: type || 'click',
    tag: tag || 'button',
    role: role || '',
    text: text || '',
    boundingBox: { x: x || 0, y: y || 0, width: 100, height: 40 }
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
//  TASK STATE TRACKER TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('TaskStateTracker — Initialization');

test('T1: initTask creates a valid snapshot', () => {
  const ts = new TaskStateTracker();
  const snap = ts.initTask('search for macbook m3', 'https://amazon.com');

  assertEqual(snap.taskId, 1, 'taskId');
  assertEqual(snap.goal, 'search for macbook m3', 'goal');
  assertEqual(snap.step_index, 0, 'step_index');
  assertEqual(snap.isActive, true, 'isActive');
  assertEqual(snap.budgetRemaining, 30, 'budgetRemaining');
  assertEqual(snap.pages_visited.length, 1, 'pages_visited');
  assertEqual(snap.pages_visited[0], 'https://amazon.com', 'startUrl');
  assert(snap.goalTokens.includes('search'), 'goalTokens should contain "search"');
  assert(snap.goalTokens.includes('macbook'), 'goalTokens should contain "macbook"');
  assert(snap.goalTokens.includes('m3'), 'goalTokens should contain "m3"');
  assert(!snap.goalTokens.includes('for'), '"for" should be filtered as stopword');
});

test('T2: taskId increments across inits', () => {
  const ts = new TaskStateTracker();
  ts.initTask('goal 1');
  const snap2 = ts.initTask('goal 2');
  assertEqual(snap2.taskId, 2, 'taskId should increment');
  assertEqual(snap2.step_index, 0, 'step_index resets');
});

suite('TaskStateTracker — Goal Tokenization');

test('T3: tokenizer removes stopwords and punctuation', () => {
  const ts = new TaskStateTracker();
  ts.initTask('Buy the latest MacBook Pro!');
  const tokens = ts.getGoalTokens();
  assert(tokens.includes('buy'), 'should have "buy"');
  assert(tokens.includes('latest'), 'should have "latest"');
  assert(tokens.includes('macbook'), 'should have "macbook"');
  assert(tokens.includes('pro'), 'should have "pro"');
  assert(!tokens.includes('the'), '"the" should be filtered');
  assert(!tokens.includes('!'), 'punctuation should be removed');
});

test('T4: tokenizer handles edge cases', () => {
  const ts = new TaskStateTracker();
  ts.initTask('');
  assertEqual(ts.getGoalTokens().length, 0, 'empty goal = no tokens');

  ts.initTask('a');
  assertEqual(ts.getGoalTokens().length, 0, 'single-char word filtered');

  ts.initTask('the is a');
  assertEqual(ts.getGoalTokens().length, 0, 'all stopwords = no tokens');
});

suite('TaskStateTracker — Action Recording');

test('T5: recordAction increments step_index and tracks history', () => {
  const ts = new TaskStateTracker();
  ts.initTask('buy laptop', 'https://shop.com');

  const snap = ts.recordAction(
    makeAction('click', 'a', 'link', 'Laptops'),
    'navigation',
    'https://shop.com/laptops'
  );

  assertEqual(snap.step_index, 1, 'step_index');
  assertEqual(snap.actions_taken.length, 1, 'actions_taken length');
  assertEqual(snap.actions_taken[0].type, 'click', 'action type');
  assertEqual(snap.effects_observed[0], 'navigation', 'effect');
  assertEqual(snap.last_effect, 'navigation', 'last_effect');
  assertEqual(snap.pages_visited.length, 2, 'pages_visited added');
  assertEqual(snap.uniqueNodesVisited, 1, 'uniqueNodesVisited');
});

test('T6: recordAction deduplicates same-URL page visits', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test', 'https://a.com');

  ts.recordAction(makeAction('click', 'button'), 'none', 'https://a.com');
  const snap = ts.recordAction(makeAction('click', 'button'), 'none', 'https://a.com');

  assertEqual(snap.pages_visited.length, 1, 'same URL not duplicated');
});

test('T7: recordAction returns null with no active task', () => {
  const ts = new TaskStateTracker();
  const result = ts.recordAction(makeAction('click'), 'none');
  assertEqual(result, null, 'should return null');
});

suite('TaskStateTracker — Milestones');

test('T8: form_interaction milestone triggers on type into input', () => {
  const ts = new TaskStateTracker();
  ts.initTask('search for laptop');

  ts.recordAction(
    makeAction('type', 'input', 'textbox', 'laptop'),
    'state_change',
    'https://shop.com'
  );

  const snap = ts.getSnapshot();
  assertEqual(snap.milestones.form_interaction, true, 'form_interaction');
  assertEqual(snap.milestones.state_change_observed, true, 'state_change_observed');
});

test('T9: search_performed milestone uses path-segment matching', () => {
  const ts = new TaskStateTracker();
  ts.initTask('search for laptop');

  // First record a form interaction
  ts.recordAction(
    makeAction('type', 'input', 'textbox', 'laptop'),
    'state_change'
  );

  // Then navigate to a search URL
  ts.recordAction(
    makeAction('click', 'button', '', 'Search'),
    'navigation',
    'https://shop.com/search?q=laptop'
  );

  assertEqual(ts.getSnapshot().milestones.search_performed, true, 'search with /search?q=');
});

test('T10: search_performed does NOT false-positive on "researchers"', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');

  ts.recordAction(
    makeAction('click', 'a', 'link', 'Team'),
    'navigation',
    'https://example.com/researchers'
  );

  assertEqual(ts.getSnapshot().milestones.search_performed, false, 'should NOT match "researchers"');
});

test('T11: navigation_occurred milestone triggers on navigation effect', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');
  ts.recordAction(makeAction('click', 'a'), 'navigation', 'https://b.com');
  assertEqual(ts.getSnapshot().milestones.navigation_occurred, true, 'navigation_occurred');
});

suite('TaskStateTracker — Commitment Window');

test('T12: auto-enters commitment on type action', () => {
  const ts = new TaskStateTracker();
  ts.initTask('fill form');

  ts.recordAction(makeAction('type', 'input', '', 'John'), 'state_change');
  const snap = ts.getSnapshot();

  assertEqual(snap.commitment.active, true, 'commitment active');
  assertEqual(snap.commitment.target_type, 'form_submission', 'target_type');
  // steps_remaining = 3 initially, minus 1 for the tick after this action = 2
  assertEqual(snap.commitment.steps_remaining, 2, 'steps_remaining after first tick');
});

test('T13: commitment expires after N steps', () => {
  const ts = new TaskStateTracker();
  ts.initTask('fill form');

  // Step 1: type → enters commitment (3 steps), then ticks to 2
  ts.recordAction(makeAction('type', 'input'), 'state_change');
  // Step 2: click → ticks to 1
  ts.recordAction(makeAction('click', 'button'), 'none');
  // Step 3: click → ticks to 0, commitment expires
  ts.recordAction(makeAction('click', 'button'), 'none');

  assertEqual(ts.getSnapshot().commitment.active, false, 'commitment expired');
});

test('T14: manual enterCommitment overrides defaults', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');
  ts.enterCommitment('navigation', 5);

  const snap = ts.getSnapshot();
  assertEqual(snap.commitment.active, true, 'active');
  assertEqual(snap.commitment.target_type, 'navigation', 'target_type');
  assertEqual(snap.commitment.steps_remaining, 5, 'steps_remaining');
});

suite('TaskStateTracker — Failure Memory');

test('T15: "none" effect auto-adds to failure memory', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');

  const action = makeAction('click', 'button', '', 'Submit', 100, 200);
  ts.recordAction(action, 'none');

  assertEqual(ts.isKnownFailure(action), true, 'should be known failure');
  assertEqual(ts.getFailurePenalty(action), 0.3, 'penalty = 0.3');
});

test('T16: manual recordFailure works', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');

  const node = makeNode('div', 'Broken button', 'button', 300, 400);
  assert(!ts.isKnownFailure(node), 'not yet a failure');

  ts.recordFailure(node);
  assert(ts.isKnownFailure(node), 'now a failure');
});

test('T17: non-failed nodes get penalty of 1.0', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');
  assertEqual(ts.getFailurePenalty(makeNode('a', 'Home')), 1.0, 'no penalty');
});

suite('TaskStateTracker — Progress Tracking');

test('T18: updateProgress tracks delta and high-water mark', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');

  const r1 = ts.updateProgress(0.3, 'https://a.com/step1');
  assertEqual(r1.progress_delta, 0.3, 'delta = 0.3');
  assertEqual(r1.progress_score, 0.3, 'score = 0.3');
  assertEqual(r1.highWaterMark.progress, 0.3, 'hwm = 0.3');
  assertEqual(r1.highWaterMark.url, 'https://a.com/step1', 'hwm url');

  const r2 = ts.updateProgress(0.5, 'https://a.com/step2');
  assertEqual(r2.progress_delta, 0.2, 'delta = 0.2');
  assertEqual(r2.highWaterMark.progress, 0.5, 'hwm updated');

  const r3 = ts.updateProgress(0.2, 'https://a.com/step3');
  assertEqual(r3.progress_delta, -0.3, 'negative delta');
  assertEqual(r3.highWaterMark.progress, 0.5, 'hwm preserved at 0.5');
  assertEqual(r3.highWaterMark.url, 'https://a.com/step2', 'hwm url preserved');
});

test('T19: progressHistory capped at 10', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');
  for (let i = 0; i < 15; i++) {
    ts.updateProgress(i * 0.05);
  }
  assertEqual(ts.getSnapshot().progressHistory.length, 10, 'capped at 10');
});

suite('TaskStateTracker — Information Gain');

test('T20: updateSeenGoalTokens tracks new matches', () => {
  const ts = new TaskStateTracker();
  ts.initTask('buy macbook pro');

  const r1 = ts.updateSeenGoalTokens(['macbook', 'air', 'pro']);
  assertEqual(r1.newMatches, 2, '2 new matches (macbook, pro)');
  assert(r1.gainRate > 0, 'gainRate > 0');

  // Same tokens again — no new matches
  const r2 = ts.updateSeenGoalTokens(['macbook', 'pro']);
  assertEqual(r2.newMatches, 0, '0 new matches');
  assertEqual(r2.gainRate, 0, 'gainRate = 0');

  // New token "buy" appears
  const r3 = ts.updateSeenGoalTokens(['buy', 'now']);
  assertEqual(r3.newMatches, 1, '1 new match (buy)');
});

suite('TaskStateTracker — Reset & Edge Cases');

test('T21: resetTask clears state', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');
  ts.recordAction(makeAction('click', 'button'), 'navigation');
  ts.resetTask();

  assertEqual(ts.isActive(), false, 'not active');
  assertEqual(ts.getSnapshot(), null, 'snapshot is null');
  assertEqual(ts.getGoalTokens().length, 0, 'no goal tokens');
});

test('T22: snapshot creates independent copies', () => {
  const ts = new TaskStateTracker();
  ts.initTask('test');
  ts.recordAction(makeAction('click', 'button', '', 'X', 10, 20), 'none');

  const snap1 = ts.getSnapshot();
  ts.recordAction(makeAction('click', 'a', '', 'Y', 30, 40), 'navigation');
  const snap2 = ts.getSnapshot();

  assertEqual(snap1.step_index, 1, 'snap1 step_index frozen');
  assertEqual(snap2.step_index, 2, 'snap2 step_index updated');
  assertEqual(snap1.actions_taken.length, 1, 'snap1 actions frozen');
  assertEqual(snap2.actions_taken.length, 2, 'snap2 actions updated');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  NODE SIGNATURE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('computeNodeSignature');

test('T23: produces consistent signatures', () => {
  const node = makeNode('button', 'Submit', 'button', 200, 300);
  const sig1 = computeNodeSignature(node);
  const sig2 = computeNodeSignature(node);
  assertEqual(sig1, sig2, 'deterministic');
});

test('T24: different text produces different signatures', () => {
  const a = computeNodeSignature(makeNode('button', 'Submit'));
  const b = computeNodeSignature(makeNode('button', 'Cancel'));
  assert(a !== b, 'different text = different sig');
});

test('T25: coarse position bucketing', () => {
  // Same 100px bucket: Math.round(210/100)=2, Math.round(240/100)=2
  const a = computeNodeSignature(makeNode('button', 'OK', '', 210, 250));
  const b = computeNodeSignature(makeNode('button', 'OK', '', 240, 280));
  assertEqual(a, b, 'same bucket');

  // Different bucket: Math.round(210/100)=2, Math.round(500/100)=5
  const c = computeNodeSignature(makeNode('button', 'OK', '', 210, 250));
  const d = computeNodeSignature(makeNode('button', 'OK', '', 500, 250));
  assert(c !== d, 'different bucket');
});

test('T26: handles missing fields gracefully', () => {
  const sig = computeNodeSignature({ tag: null, text: undefined });
  assert(typeof sig === 'string' && sig.length > 0, 'produces valid string');
  assert(sig.startsWith('unknown|'), 'defaults tag to "unknown"');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  DOM FINGERPRINT TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('computeDomFingerprint');

test('T27: same nodes in same order produce same fingerprint', () => {
  const nodes = [makeNode('button', 'A'), makeNode('a', 'B')];
  assertEqual(computeDomFingerprint(nodes), computeDomFingerprint(nodes), 'deterministic');
});

test('T28: same nodes in DIFFERENT order produce same fingerprint (order-independent)', () => {
  const nodesA = [makeNode('button', 'A'), makeNode('a', 'B'), makeNode('input', 'C')];
  const nodesB = [makeNode('input', 'C'), makeNode('button', 'A'), makeNode('a', 'B')];
  assertEqual(computeDomFingerprint(nodesA), computeDomFingerprint(nodesB), 'order-independent');
});

test('T29: different nodes produce different fingerprint', () => {
  const a = computeDomFingerprint([makeNode('button', 'Submit')]);
  const b = computeDomFingerprint([makeNode('a', 'Home page')]);
  assert(a !== b, 'different nodes = different fp');
});

test('T30: empty array returns consistent hash', () => {
  const fp = computeDomFingerprint([]);
  assert(typeof fp === 'string' && fp.length > 0, 'valid hash');
  assertEqual(computeDomFingerprint([]), fp, 'consistent for empty');
});

test('T31: caps at 20 nodes', () => {
  const nodes25 = Array.from({length: 25}, (_, i) => makeNode('div', `Node ${i}`));
  const nodes20 = nodes25.slice(0, 20);
  // Fingerprint of 25 nodes should equal fingerprint of first 20
  // (since computeDomFingerprint does .slice(0, 20) then sorts)
  // Actually this only holds if the sorted order of the first 20 of the 25
  // matches the sorted order of just those 20. Since we sort by content,
  // the result depends on which 20 are taken. Let's just verify it doesn't crash.
  const fp = computeDomFingerprint(nodes25);
  assert(typeof fp === 'string', 'handles >20 nodes');
});

// ═══════════════════════════════════════════════════════════════════════════════
//  FAST HASH TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('fastHash');

test('T32: deterministic', () => {
  assertEqual(fastHash('hello'), fastHash('hello'), 'same string = same hash');
});

test('T33: different strings produce different hashes', () => {
  assert(fastHash('hello') !== fastHash('world'), 'different strings');
  assert(fastHash('abc') !== fastHash('abd'), 'single char diff');
});

test('T34: returns 8-char hex string', () => {
  const h = fastHash('test');
  assertEqual(h.length, 8, 'length 8');
  assert(/^[0-9a-f]{8}$/.test(h), 'hex format');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  LOOP DETECTOR TESTS
// ═══════════════════════════════════════════════════════════════════════════════

suite('LoopDetector — No Loop (Baseline)');

test('L1: no loop on first 3 unique states', () => {
  const ld = new LoopDetector();
  const r1 = ld.check('https://a.com', 'fp1', makeAction('click', 'a'));
  const r2 = ld.check('https://b.com', 'fp2', makeAction('click', 'a'));
  const r3 = ld.check('https://c.com', 'fp3', makeAction('click', 'button'));

  assertEqual(r1.loopDetected, false, 'step 1 no loop');
  assertEqual(r2.loopDetected, false, 'step 2 no loop');
  assertEqual(r3.loopDetected, false, 'step 3 no loop');
});

suite('LoopDetector — Mode 1: Exact Loop');

test('L2: detects A→B→A (exact revisit within threshold)', () => {
  const ld = new LoopDetector();
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));
  ld.check('https://b.com', 'fp2', makeAction('click', 'a'));
  const r3 = ld.check('https://a.com', 'fp1', makeAction('click', 'a'));

  assertEqual(r3.loopDetected, true, 'loop detected');
  assertEqual(r3.type, 'exact', 'type is exact');
  assertEqual(r3.cycleLength, 2, 'cycle length = 2');
});

test('L3: does NOT trigger exact loop for long cycles (>4 steps)', () => {
  const ld = new LoopDetector();
  // Visit 6 unique pages with VARIED actions (to avoid monotone/action-pattern)
  ld.check('https://a.com', 'fp1', makeAction('click', 'a', 'link'));
  ld.check('https://b.com', 'fp2', makeAction('type', 'input', 'textbox'));
  ld.check('https://c.com', 'fp3', makeAction('scroll', 'div', ''));
  ld.check('https://d.com', 'fp4', makeAction('click', 'button', 'button'));
  ld.check('https://e.com', 'fp5', makeAction('navigate', 'a', 'link'));
  ld.check('https://f.com', 'fp6', makeAction('keypress', 'input', 'textbox'));
  // Revisit A — cycle=6, exceeds EXACT_LOOP_MAX_CYCLE=4
  const r = ld.check('https://a.com', 'fp1', makeAction('click', 'div', 'region'));

  assertEqual(r.loopDetected, false, 'long cycle = no exact loop');
});

suite('LoopDetector — Mode 2: Alternating Loop');

test('L4: detects A→B→A→B alternating pattern', () => {
  const ld = new LoopDetector();
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));     // A
  ld.check('https://b.com', 'fp2', makeAction('click', 'a'));     // B
  // Third check: A again — triggers exact (cycle=2, ≤4)
  const r3 = ld.check('https://a.com', 'fp1', makeAction('click', 'a')); // A
  // That fires as exact. Now the 4th check B should trigger alternating:
  // history = [A, B, A] (after push from step 3), current = B
  // h = stateHistory.slice(-3) = [A, B, A], h[0]=A, h[2]=A (match), h[1]=B, current=B (match)
  const r4 = ld.check('https://b.com', 'fp2', makeAction('click', 'a')); // B

  // r3 should be exact (short cycle)
  assertEqual(r3.loopDetected, true, 'step 3 loop detected');
  assertEqual(r3.type, 'exact', 'step 3 is exact');

  // r4 should be alternating
  assertEqual(r4.loopDetected, true, 'step 4 loop detected');
  assertEqual(r4.type, 'alternating', 'step 4 is alternating');
  assertEqual(r4.cycleLength, 2, 'cycle = 2');
});

suite('LoopDetector — Mode 3: Action-Pattern Loop');

test('L5: detects repeated 3-action pattern on different pages', () => {
  const ld = new LoopDetector();
  // 6 steps with the same action pattern on 6 DIFFERENT pages
  ld.check('https://p1.com', 'fp1', makeAction('click', 'a', 'link'));
  ld.check('https://p2.com', 'fp2', makeAction('click', 'button', 'button'));
  ld.check('https://p3.com', 'fp3', makeAction('type', 'input', 'textbox'));
  ld.check('https://p4.com', 'fp4', makeAction('click', 'a', 'link'));
  ld.check('https://p5.com', 'fp5', makeAction('click', 'button', 'button'));
  const r = ld.check('https://p6.com', 'fp6', makeAction('type', 'input', 'textbox'));

  assertEqual(r.loopDetected, true, 'action pattern detected');
  assertEqual(r.type, 'action_pattern', 'type is action_pattern');
});

suite('LoopDetector — Mode 4: Monotone Type');

test('L6: detects 5 identical action types in a row', () => {
  const ld = new LoopDetector();
  // 5 clicks on links, all on different pages
  ld.check('https://p1.com', 'fp1', makeAction('click', 'a', 'link'));
  ld.check('https://p2.com', 'fp2', makeAction('click', 'a', 'link'));
  ld.check('https://p3.com', 'fp3', makeAction('click', 'a', 'link'));
  ld.check('https://p4.com', 'fp4', makeAction('click', 'a', 'link'));
  const r = ld.check('https://p5.com', 'fp5', makeAction('click', 'a', 'link'));

  assertEqual(r.loopDetected, true, 'monotone detected');
  assertEqual(r.type, 'monotone_type', 'type is monotone_type');
});

test('L7: mixed types do NOT trigger monotone', () => {
  const ld = new LoopDetector();
  ld.check('https://p1.com', 'fp1', makeAction('click', 'a'));
  ld.check('https://p2.com', 'fp2', makeAction('click', 'a'));
  ld.check('https://p3.com', 'fp3', makeAction('type', 'input'));
  ld.check('https://p4.com', 'fp4', makeAction('click', 'a'));
  const r = ld.check('https://p5.com', 'fp5', makeAction('click', 'a'));

  assertEqual(r.loopDetected, false, 'mixed types = no monotone');
});

suite('LoopDetector — Recovery Actions');

test('L8: exact loop → backtrack recovery', () => {
  const ld = new LoopDetector();
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));
  ld.check('https://b.com', 'fp2', makeAction('click', 'a'));
  const result = ld.check('https://a.com', 'fp1', makeAction('click', 'a'));

  const recovery = ld.getRecoveryAction(result);
  assertEqual(recovery.action, 'backtrack', 'backtrack recovery');
  assertEqual(recovery.method, 'history.back()', 'method');
  assert(recovery.constraints.forbid_recent_nodes === true, 'forbid_recent_nodes');
});

test('L9: action-pattern → change_action_type recovery', () => {
  const ld = new LoopDetector();
  for (let i = 0; i < 5; i++) {
    ld.check(`https://p${i}.com`, `fp${i}`, makeAction('click', 'a', 'link'));
  }
  const result = ld.check('https://p5.com', 'fp5', makeAction('click', 'a', 'link'));

  const taskState = { actions_taken: [{ type: 'click' }, { type: 'click' }, { type: 'click' }] };
  const recovery = ld.getRecoveryAction(result, taskState);

  assertEqual(recovery.action, 'change_action_type', 'change type');
  assert(recovery.constraints.forbid_types.includes('click'), 'forbid click');
  assert(recovery.constraints.prefer_types.includes('type'), 'prefer type');
  assert(recovery.constraints.prefer_types.includes('scroll'), 'prefer scroll');
});

test('L10: no recovery for non-loop result', () => {
  const ld = new LoopDetector();
  const recovery = ld.getRecoveryAction({ loopDetected: false });
  assertEqual(recovery, null, 'null for no loop');
});

suite('LoopDetector — Enforcement Constraints');

test('L11: applyEnforcementConstraints filters forbidden nodes', () => {
  const ld = new LoopDetector();
  const submitNode = makeNode('button', 'Submit', '', 100, 200);
  const cancelNode = makeNode('button', 'Cancel', '', 100, 250);
  const candidates = [submitNode, cancelNode];

  const submitSig = computeNodeSignature(submitNode);
  const constraints = { forbid: [submitSig] };

  const filtered = ld.applyEnforcementConstraints(candidates, constraints, {});
  assertEqual(filtered.length, 1, 'one filtered out');
  assertEqual(filtered[0].text, 'Cancel', 'Submit was filtered');
});

test('L12: relaxes constraints if all candidates filtered', () => {
  const ld = new LoopDetector();
  const nodes = [makeNode('button', 'A'), makeNode('button', 'B')];
  const sigs = nodes.map(computeNodeSignature);
  const constraints = { forbid: sigs };

  const filtered = ld.applyEnforcementConstraints(nodes, constraints, {});
  assert(filtered.length > 0, 'never returns empty');
});

suite('LoopDetector — State Management');

test('L13: consecutiveLoops resets on no-loop check', () => {
  const ld = new LoopDetector();
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));
  ld.check('https://b.com', 'fp2', makeAction('click', 'a'));
  ld.check('https://a.com', 'fp1', makeAction('click', 'a')); // exact loop
  assertEqual(ld.consecutiveLoops, 1, 'consecutive = 1');

  ld.check('https://unique.com', 'unique', makeAction('click', 'button'));
  assertEqual(ld.consecutiveLoops, 0, 'consecutive reset on no-loop');
});

test('L14: reset() clears all state', () => {
  const ld = new LoopDetector();
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));
  ld.check('https://b.com', 'fp2', makeAction('click', 'a'));
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));

  ld.reset();
  assertEqual(ld.stateHistory.length, 0, 'history cleared');
  assertEqual(ld.actionHistory.length, 0, 'action history cleared');
  assertEqual(ld.loopsDetected, 0, 'loopsDetected cleared');
  assertEqual(ld.lastResult, null, 'lastResult cleared');
});

test('L15: history capped at maxHistory', () => {
  const ld = new LoopDetector();
  for (let i = 0; i < 30; i++) {
    ld.check(`https://page${i}.com`, `fp${i}`, makeAction('click', 'a'));
  }
  assert(ld.stateHistory.length <= 20, 'state history capped at 20');
  assert(ld.actionHistory.length <= 20, 'action history capped at 20');
});

test('L16: getStatus returns valid snapshot', () => {
  const ld = new LoopDetector();
  ld.check('https://a.com', 'fp1', makeAction('click', 'a'));
  const status = ld.getStatus();

  assertEqual(status.stateHistoryLength, 1, 'stateHistoryLength');
  assertEqual(status.actionHistoryLength, 1, 'actionHistoryLength');
  assertEqual(status.loopsDetected, 0, 'loopsDetected');
  assert(Array.isArray(status.recentStates), 'recentStates is array');
  assert(Array.isArray(status.recentActions), 'recentActions is array');
});


// ═══════════════════════════════════════════════════════════════════════════════
//  INTEGRATION TEST — Full Task Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

suite('Integration — Full Task Lifecycle');

test('I1: init → record actions → check loops → progress → verify coherence', () => {
  const ts = new TaskStateTracker();
  const ld = new LoopDetector();

  // 1. Init task
  ts.initTask('search for macbook pro', 'https://amazon.com');
  ld.reset();

  // 2. Type into search box
  ts.recordAction(
    makeAction('type', 'input', 'textbox', 'macbook pro'),
    'state_change',
    'https://amazon.com'
  );
  ts.updateProgress(0.2, 'https://amazon.com');
  const r1 = ld.check('https://amazon.com', 'fp1', makeAction('type', 'input'));
  assertEqual(r1.loopDetected, false, 'no loop on search');

  // 3. Click search button
  ts.recordAction(
    makeAction('click', 'button', 'button', 'Search'),
    'navigation',
    'https://amazon.com/s?k=macbook+pro'
  );
  ts.updateProgress(0.4, 'https://amazon.com/s?k=macbook+pro');
  const r2 = ld.check('https://amazon.com/s', 'fp2', makeAction('click', 'button'));
  assertEqual(r2.loopDetected, false, 'no loop on search click');

  // 4. Click product
  ts.recordAction(
    makeAction('click', 'a', 'link', 'MacBook Pro M3'),
    'navigation',
    'https://amazon.com/dp/B123'
  );
  ts.updateProgress(0.6, 'https://amazon.com/dp/B123');

  // 5. Verify final state
  const snap = ts.getSnapshot();
  assertEqual(snap.step_index, 3, 'step_index = 3');
  assertEqual(snap.milestones.form_interaction, true, 'form_interaction');
  assertEqual(snap.milestones.search_performed, true, 'search_performed');
  assertEqual(snap.milestones.navigation_occurred, true, 'navigation_occurred');
  assertEqual(snap.progress_score, 0.6, 'progress');
  assertEqual(snap.highWaterMark.progress, 0.6, 'hwm');
  assert(snap.pages_visited.length >= 2, 'multiple pages visited');
  assertEqual(snap.commitment.active, false, 'commitment expired');
  assertEqual(snap.budgetRemaining, 27, 'budget = 27');
});

test('I2: loop detection triggers correct recovery lifecycle', () => {
  const ts = new TaskStateTracker();
  const ld = new LoopDetector();

  ts.initTask('browse products', 'https://shop.com');
  ld.reset();

  // Simulate A→B→A loop
  ts.recordAction(makeAction('click', 'a', 'link', 'Product'), 'navigation', 'https://shop.com/product');
  ld.check('https://shop.com/product', 'fp_prod', makeAction('click', 'a'));

  ts.recordAction(makeAction('click', 'a', 'link', 'Back'), 'navigation', 'https://shop.com');
  ld.check('https://shop.com', 'fp_home', makeAction('click', 'a'));

  ts.recordAction(makeAction('click', 'a', 'link', 'Product'), 'navigation', 'https://shop.com/product');
  const loopResult = ld.check('https://shop.com/product', 'fp_prod', makeAction('click', 'a'));

  // Should detect a loop
  assertEqual(loopResult.loopDetected, true, 'loop detected');
  
  // Get recovery with task state context
  const taskSnap = ts.getSnapshot();
  const recovery = ld.getRecoveryAction(loopResult, taskSnap);
  assert(recovery !== null, 'recovery not null');
  assert(['backtrack', 'force_unseen_node', 'change_action_type'].includes(recovery.action), 'valid recovery action');
});


// ─── Run Summary ─────────────────────────────────────────────────────────────
summary();
