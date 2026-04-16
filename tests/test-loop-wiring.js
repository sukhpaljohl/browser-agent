/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Test: Loop Detector Wiring via BRAIN_RECORD_STEP_COMPLETE
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Verifies that the loop detector is correctly fed as a side-effect of step
 * recording (Patch 1 from Phase 1B.1 wiring fix).
 *
 * Run: node tests/test-loop-wiring.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ─── Load Source Files ───────────────────────────────────────────────────────

const taskStateSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'task-state.js'), 'utf-8'
);
const loopDetectorSrc = fs.readFileSync(
  path.join(__dirname, '..', 'extension', 'brain', 'loop-detector.js'), 'utf-8'
);

// Execute in Node context
vm.runInThisContext(taskStateSrc, { filename: 'task-state.js' });
vm.runInThisContext(loopDetectorSrc, { filename: 'loop-detector.js' });

// Verify classes loaded
assert(typeof TaskStateTracker === 'function', 'TaskStateTracker not found');
assert(typeof LoopDetector === 'function', 'LoopDetector not found');
assert(typeof fastHash === 'function', 'fastHash not found');

// ─── Test Helpers ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    failed++;
  }
}

/**
 * Simulates the BRAIN_RECORD_STEP_COMPLETE handler logic from service-worker.js.
 * This is the exact code path we patched.
 */
function simulateStepComplete(taskStateTracker, loopDetector, message) {
  const { action, effect, currentUrl, pageTokens } = message;

  // Operation 1: Record action
  const actionResult = taskStateTracker.recordAction(action, effect, currentUrl || '');

  // Operation 2: Update seen goal tokens
  let gainResult = { newMatches: 0, gainRate: 0 };
  if (Array.isArray(pageTokens)) {
    gainResult = taskStateTracker.updateSeenGoalTokens(pageTokens);
  }

  // Operation 3: Feed loop detector (THE PATCH WE'RE TESTING)
  let loopResult = null;
  const tokenFingerprint = (Array.isArray(pageTokens) && pageTokens.length > 0)
    ? fastHash(pageTokens.sort().join('|'))
    : 'no_tokens';
  loopResult = loopDetector.check(currentUrl || '', tokenFingerprint, action);

  return { state: actionResult, gainResult, loopResult };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\n═══════════════════════════════════════════');
console.log(' Loop Detector Wiring Tests');
console.log('═══════════════════════════════════════════\n');

// ── Test 1: No loop on first step ──

test('No loop detected on first step', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  const result = simulateStepComplete(tst, ld, {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Mac' },
    effect: 'navigation',
    currentUrl: 'https://apple.com/mac/',
    pageTokens: ['mac', 'apple']
  });

  assert.strictEqual(result.loopResult.loopDetected, false, 'Should not detect loop on first step');
});

// ── Test 2: Exact loop on repeated identical steps ──

test('Exact loop detected on identical repeated steps', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  const stepMsg = {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Mac' },
    effect: 'navigation',
    currentUrl: 'https://apple.com/mac/',
    pageTokens: ['mac', 'apple']
  };

  // Step 1 — no loop
  const r1 = simulateStepComplete(tst, ld, stepMsg);
  assert.strictEqual(r1.loopResult.loopDetected, false, 'Step 1 should not loop');

  // Step 2 — exact loop (same URL + same fingerprint)
  const r2 = simulateStepComplete(tst, ld, stepMsg);
  assert.strictEqual(r2.loopResult.loopDetected, true, 'Step 2 should detect exact loop');
  assert.strictEqual(r2.loopResult.type, 'exact', 'Should be exact loop type');
});

// ── Test 3: No loop when URL changes ──

test('No loop when URL changes between steps', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  simulateStepComplete(tst, ld, {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Mac' },
    effect: 'navigation',
    currentUrl: 'https://apple.com/mac/',
    pageTokens: ['mac', 'apple']
  });

  const r2 = simulateStepComplete(tst, ld, {
    action: { type: 'click', tag: 'a', role: 'link', text: 'iPad' },
    effect: 'navigation',
    currentUrl: 'https://apple.com/ipad/',  // different URL
    pageTokens: ['ipad', 'apple']
  });

  assert.strictEqual(r2.loopResult.loopDetected, false, 'Different URLs should not loop');
});

// ── Test 4: No loop when tokens change (same URL, different DOM) ──

test('No loop when tokens change on same URL', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  simulateStepComplete(tst, ld, {
    action: { type: 'click', tag: 'button', role: 'button', text: 'Next' },
    effect: 'state_change',
    currentUrl: 'https://example.com/app',
    pageTokens: ['step 1', 'next']
  });

  const r2 = simulateStepComplete(tst, ld, {
    action: { type: 'click', tag: 'button', role: 'button', text: 'Next' },
    effect: 'state_change',
    currentUrl: 'https://example.com/app',  // same URL
    pageTokens: ['step 2', 'next']           // different tokens → different fingerprint
  });

  assert.strictEqual(r2.loopResult.loopDetected, false, 'Different tokens should prevent exact loop');
});

// ── Test 5: Alternating loop (A→B→A→B) ──

test('Alternating loop detected on A→B→A→B pattern', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  const pageA = {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Products' },
    effect: 'navigation',
    currentUrl: 'https://example.com/products',
    pageTokens: ['products', 'catalog']
  };

  const pageB = {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Home' },
    effect: 'navigation',
    currentUrl: 'https://example.com/home',
    pageTokens: ['home', 'welcome']
  };

  simulateStepComplete(tst, ld, pageA);  // A
  simulateStepComplete(tst, ld, pageB);  // B
  simulateStepComplete(tst, ld, pageA);  // A

  const r4 = simulateStepComplete(tst, ld, pageB);  // B — alternating!
  assert.strictEqual(r4.loopResult.loopDetected, true, 'Should detect alternating loop');
  assert.strictEqual(r4.loopResult.type, 'alternating', 'Should be alternating type');
});

// ── Test 6: consecutiveLoops increments properly ──

test('consecutiveLoops counter increments across loop detections', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  const stepMsg = {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Mac' },
    effect: 'navigation',
    currentUrl: 'https://apple.com/mac/',
    pageTokens: ['mac', 'apple']
  };

  simulateStepComplete(tst, ld, stepMsg); // step 1: no loop
  simulateStepComplete(tst, ld, stepMsg); // step 2: loop #1
  simulateStepComplete(tst, ld, stepMsg); // step 3: loop #2

  const status = ld.getStatus();
  assert(status.consecutiveLoops >= 2, `Expected >=2 consecutive loops, got ${status.consecutiveLoops}`);
  assert.strictEqual(status.lastResult.loopDetected, true, 'Should report last result as loop detected');
});

// ── Test 7: loopResult is included in step response ──

test('loopResult is included in step complete response', () => {
  const tst = new TaskStateTracker();
  const ld = new LoopDetector();
  tst.initTask('test goal', 'https://example.com');

  const result = simulateStepComplete(tst, ld, {
    action: { type: 'click', tag: 'a', role: 'link', text: 'Test' },
    effect: 'navigation',
    currentUrl: 'https://example.com/',
    pageTokens: ['test']
  });

  assert(result.loopResult !== null, 'loopResult should be present');
  assert(typeof result.loopResult.loopDetected === 'boolean', 'loopDetected should be boolean');
});

// ── Summary ──

console.log(`\n═══════════════════════════════════════════`);
console.log(` Results: ${passed} passed, ${failed} failed`);
console.log(`═══════════════════════════════════════════\n`);

process.exit(failed > 0 ? 1 : 0);
