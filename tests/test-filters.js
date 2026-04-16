/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Phase 1A.2 — Unit Tests for Frontend Filters
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * Tests: NodeClassifier, CandidatePruner
 * Run:   node tests/test-filters.js
 * 
 * Note: These tests run in Node.js, NOT in the browser. We mock the
 *       BrowserAgent namespace and test the pure-data logic only.
 *       Context Builder tests require chrome.runtime.sendMessage (browser-only).
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Mock BrowserAgent Namespace ─────────────────────────────────────────────

const BrowserAgent = {};
globalThis.BrowserAgent = BrowserAgent;

// ─── Load Modules ────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

function loadModule(relPath) {
  const fullPath = path.join(__dirname, '..', 'extension', relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  // Wrap in a function to execute in current scope with BrowserAgent available
  const fn = new Function('BrowserAgent', 'console', code);
  fn(BrowserAgent, console);
}

// Load in dependency order
loadModule('brain/node-classifier.js');
loadModule('brain/candidate-pruner.js');

// ─── Test Utilities ──────────────────────────────────────────────────────────

let testCount = 0;
let passCount = 0;
let failCount = 0;

function assert(condition, msg) {
  testCount++;
  if (condition) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    console.error(`  ✗ FAIL: ${msg}`);
  }
}

function assertEqual(actual, expected, msg) {
  testCount++;
  if (actual === expected) {
    passCount++;
    console.log(`  ✓ ${msg}`);
  } else {
    failCount++;
    console.error(`  ✗ FAIL: ${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function section(name) {
  console.log(`\n═══ ${name} ═══`);
}

// ─── Mock Node Factories ─────────────────────────────────────────────────────

function makeNode(overrides = {}) {
  return {
    i: 0,
    tag: 'div',
    selector: '#test-element',
    purpose: 'unknown',
    intent: 'interact',
    confidence: 0.3,
    innerText: 'Test Element',
    visible: true,
    rect: { x: 100, y: 100, w: 50, h: 30 },
    ...overrides
  };
}

function makeButton(text, overrides = {}) {
  return makeNode({
    tag: 'button',
    role: 'button',
    purpose: 'action',
    intent: 'interact',
    confidence: 0.4,
    innerText: text,
    ...overrides
  });
}

function makeInput(overrides = {}) {
  return makeNode({
    tag: 'input',
    purpose: 'text-input',
    intent: 'type_text',
    confidence: 0.7,
    placeholder: 'Enter text...',
    type: 'text',
    ...overrides
  });
}

function makeLink(text, overrides = {}) {
  return makeNode({
    tag: 'a',
    purpose: 'navigation',
    intent: 'navigate',
    confidence: 0.6,
    innerText: text,
    href: '/page',
    ...overrides
  });
}

function makeTrigger(text, overrides = {}) {
  return makeNode({
    tag: 'button',
    purpose: 'action',
    intent: 'open_menu',
    confidence: 0.7,
    innerText: text,
    ariaHaspopup: 'menu',
    ...overrides
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// NodeClassifier Tests
// ═══════════════════════════════════════════════════════════════════════════════

section('NodeClassifier — Basic Classification');

{
  const result = BrowserAgent.NodeClassifier.classify(makeButton('Submit'));
  assertEqual(result.nodeType, 'clickable_action', 'Button classified as clickable_action');
  assert(result.typeConfidence >= 0.85, 'Button confidence >= 0.85');
}

{
  const result = BrowserAgent.NodeClassifier.classify(makeInput());
  assertEqual(result.nodeType, 'input_field', 'Input classified as input_field');
  assert(result.typeConfidence >= 0.90, 'Input confidence >= 0.90');
}

{
  const result = BrowserAgent.NodeClassifier.classify(makeLink('Home'));
  assertEqual(result.nodeType, 'navigation_link', 'Link classified as navigation_link');
  assert(result.typeConfidence >= 0.75, 'Link confidence >= 0.75');
}

{
  const result = BrowserAgent.NodeClassifier.classify(makeTrigger('Settings'));
  assertEqual(result.nodeType, 'dynamic_trigger', 'Menu trigger classified as dynamic_trigger');
  assert(result.typeConfidence >= 0.90, 'Trigger confidence >= 0.90');
}

section('NodeClassifier — Disabled Elements');

{
  const result = BrowserAgent.NodeClassifier.classify(makeButton('Save', { disabled: true }));
  assertEqual(result.nodeType, 'disabled', 'Disabled button classified as disabled');
  assertEqual(result.typeConfidence, 1.0, 'Disabled confidence = 1.0');
}

section('NodeClassifier — Decorative Fallback');

{
  const result = BrowserAgent.NodeClassifier.classify(makeNode({
    tag: 'div',
    purpose: 'unknown',
    intent: null,
    role: undefined,
    hasPointerCursor: false,
    computedTabIndex: undefined
  }));
  assertEqual(result.nodeType, 'decorative', 'Bare div classified as decorative');
}

section('NodeClassifier — Affordance-Only Detection (div-buttons)');

{
  // A div with cursor:pointer but no role/tag — common in React apps
  const result = BrowserAgent.NodeClassifier.classify(makeNode({
    tag: 'div',
    purpose: 'unknown',
    intent: 'interact',
    role: undefined,
    hasPointerCursor: true
  }));
  assertEqual(result.nodeType, 'clickable_action', 'Div with pointer cursor → clickable_action');
  assert(result.typeConfidence >= 0.40, 'Pointer-only confidence >= 0.40');
}

{
  // A div with tabIndex=0 but no pointer cursor
  const result = BrowserAgent.NodeClassifier.classify(makeNode({
    tag: 'div',
    purpose: 'unknown',
    intent: 'interact',
    role: undefined,
    hasPointerCursor: false,
    computedTabIndex: 0
  }));
  assertEqual(result.nodeType, 'clickable_action', 'Div with tabIndex=0 → clickable_action');
}

section('NodeClassifier — Dynamic Triggers (ARIA)');

{
  const result = BrowserAgent.NodeClassifier.classify(makeNode({
    tag: 'button',
    ariaExpanded: 'false'
  }));
  assertEqual(result.nodeType, 'dynamic_trigger', 'aria-expanded element → dynamic_trigger');
}

{
  const result = BrowserAgent.NodeClassifier.classify(makeNode({
    tag: 'div',
    role: 'combobox',
    purpose: 'dropdown'
  }));
  assertEqual(result.nodeType, 'dynamic_trigger', 'combobox → dynamic_trigger');
}

section('NodeClassifier — Batch Classification');

{
  const nodes = [makeButton('OK'), makeInput(), makeLink('About'), makeTrigger('Menu')];
  BrowserAgent.NodeClassifier.classifyAll(nodes);
  assert(nodes.every(n => n.nodeType), 'All nodes classified after classifyAll');
  assertEqual(nodes[0].nodeType, 'clickable_action', 'Batch: button');
  assertEqual(nodes[1].nodeType, 'input_field', 'Batch: input');
  assertEqual(nodes[2].nodeType, 'navigation_link', 'Batch: link');
  assertEqual(nodes[3].nodeType, 'dynamic_trigger', 'Batch: trigger');
  assert(nodes.every(n => n.semanticScore === null), 'All semanticScore = null (Phase 2 placeholder)');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CandidatePruner Tests
// ═══════════════════════════════════════════════════════════════════════════════

section('CandidatePruner — Stage 1: Visibility/Size Filter');

{
  const nodes = [
    makeButton('Visible', { visible: true, rect: { x: 0, y: 0, w: 50, h: 30 } }),
    makeButton('Invisible', { visible: false, rect: { x: 0, y: 0, w: 50, h: 30 } }),
    makeButton('Tiny', { visible: true, rect: { x: 0, y: 0, w: 5, h: 5 } }),
    makeButton('No rect', { visible: true, rect: null })
  ];
  const visible = BrowserAgent.CandidatePruner._filterVisibleAndSized(nodes);
  assertEqual(visible.length, 1, 'Only 1 node survives visibility/size filter');
  assertEqual(visible[0].innerText, 'Visible', 'Correct node survives');
}

section('CandidatePruner — Stage 2: Affordance Gate');

{
  const nodes = [
    { ...makeButton('Action'), nodeType: 'clickable_action' },
    { ...makeInput(), nodeType: 'input_field' },
    { ...makeNode({ tag: 'div' }), nodeType: 'decorative' },
    { ...makeButton('Disabled', { disabled: true }), nodeType: 'disabled' }
  ];
  const affordant = BrowserAgent.CandidatePruner._filterAffordant(nodes);
  assertEqual(affordant.length, 2, '2 nodes survive affordance gate');
  assert(!affordant.some(n => n.nodeType === 'decorative'), 'No decorative nodes');
  assert(!affordant.some(n => n.nodeType === 'disabled'), 'No disabled nodes');
}

section('CandidatePruner — Stage 3: Navigation Penalty');

{
  const footerButton = {
    ...makeButton('Copyright'),
    nodeType: 'clickable_action',
    parentRegion: 'footer'
  };
  const mainButton = {
    ...makeButton('Submit'),
    nodeType: 'clickable_action',
    parentRegion: 'main'
  };
  const navButton = {
    ...makeButton('Home'),
    nodeType: 'clickable_action',
    parentRegion: 'nav'
  };

  const scored = BrowserAgent.CandidatePruner._scoreWithNavPenalty(
    [footerButton, mainButton, navButton], []
  );

  const footerScore = scored.find(s => s.node.innerText === 'Copyright').score;
  const mainScore = scored.find(s => s.node.innerText === 'Submit').score;
  const navScore = scored.find(s => s.node.innerText === 'Home').score;

  assert(footerScore < mainScore, 'Footer button penalized vs main button');
  assert(navScore < mainScore, 'Nav button penalized vs main button');
  assert(footerScore < navScore, 'Footer penalty (0.6) stronger than nav penalty (0.85)');
}

section('CandidatePruner — Stage 3: Goal Token Override');

{
  const navSearch = {
    ...makeButton('Search'),
    nodeType: 'clickable_action',
    parentRegion: 'nav',
    ariaLabel: 'Search products'
  };
  const navAbout = {
    ...makeButton('About'),
    nodeType: 'navigation_link',
    parentRegion: 'nav'
  };

  const scored = BrowserAgent.CandidatePruner._scoreWithNavPenalty(
    [navSearch, navAbout], ['search', 'products']
  );

  const searchScore = scored.find(s => s.node.innerText === 'Search').score;
  const aboutScore = scored.find(s => s.node.innerText === 'About').score;

  assert(searchScore > aboutScore, 'Goal-overlapping nav element retains full score');
}

section('CandidatePruner — Stage 4: Diversity Reservations');

{
  // Create 50 buttons (would flood output) + 3 inputs + 3 triggers
  const nodes = [];
  for (let i = 0; i < 50; i++) {
    nodes.push({ node: { ...makeButton(`Btn ${i}`), nodeType: 'clickable_action' }, score: 100 - i });
  }
  for (let i = 0; i < 3; i++) {
    nodes.push({ node: { ...makeInput({ innerText: `Input ${i}` }), nodeType: 'input_field' }, score: 20 - i });
  }
  for (let i = 0; i < 3; i++) {
    nodes.push({ node: { ...makeTrigger(`Trigger ${i}`), nodeType: 'dynamic_trigger' }, score: 15 - i });
  }

  const selected = BrowserAgent.CandidatePruner._selectDiverse(nodes);

  const inputCount = selected.filter(n => n.nodeType === 'input_field').length;
  const triggerCount = selected.filter(n => n.nodeType === 'dynamic_trigger').length;

  assert(inputCount >= 3, `At least 3 inputs reserved (got ${inputCount})`);
  assert(triggerCount >= 3, `At least 3 triggers reserved (got ${triggerCount})`);
  assert(selected.length <= BrowserAgent.CandidatePruner.MAX_CANDIDATES,
    `Total ≤ ${BrowserAgent.CandidatePruner.MAX_CANDIDATES} (got ${selected.length})`);
}

section('CandidatePruner — Stage 5: Node Signatures');

{
  const nodes = [makeButton('Submit'), makeInput()];
  BrowserAgent.CandidatePruner._attachSignatures(nodes);

  assert(nodes[0].signature, 'Button has signature');
  assert(nodes[1].signature, 'Input has signature');
  assert(nodes[0].signature !== nodes[1].signature, 'Different nodes have different signatures');
  assertEqual(nodes[0].signature.length, 8, 'Signature is 8-char hex');
}

section('CandidatePruner — Full Pipeline');

{
  // Build a realistic mixed node list
  const rawNodes = [];
  // 5 inputs
  for (let i = 0; i < 5; i++) {
    rawNodes.push(makeInput({ innerText: `Field ${i}`, i, selector: `#field-${i}` }));
  }
  // 30 buttons
  for (let i = 0; i < 30; i++) {
    rawNodes.push(makeButton(`Action ${i}`, { i: i + 5, selector: `#btn-${i}` }));
  }
  // 20 nav links
  for (let i = 0; i < 20; i++) {
    rawNodes.push(makeLink(`Link ${i}`, { i: i + 35, selector: `#link-${i}`, parentRegion: 'nav' }));
  }
  // 5 triggers
  for (let i = 0; i < 5; i++) {
    rawNodes.push(makeTrigger(`Menu ${i}`, { i: i + 55, selector: `#menu-${i}` }));
  }
  // 10 decorative divs (invisible)
  for (let i = 0; i < 10; i++) {
    rawNodes.push(makeNode({ visible: false, innerText: '', i: i + 60 }));
  }
  // 5 tiny icons (below area threshold)
  for (let i = 0; i < 5; i++) {
    rawNodes.push(makeButton(`icon-${i}`, { rect: { x: 0, y: 0, w: 8, h: 8 }, i: i + 70 }));
  }

  const { candidates, stats } = BrowserAgent.CandidatePruner.prune(rawNodes);

  assert(stats.rawCount === 75, `Raw count = 75 (got ${stats.rawCount})`);
  assert(stats.afterVisibility < stats.rawCount, 'Visibility reduces count');
  assert(stats.afterAffordance <= stats.afterVisibility, 'Affordance reduces count further');
  assert(candidates.length <= 50, `Output ≤ 50 (got ${candidates.length})`);
  assert(candidates.length >= 20, `Output ≥ 20 (got ${candidates.length})`);

  // Diversity check
  const types = {};
  for (const c of candidates) {
    types[c.nodeType] = (types[c.nodeType] || 0) + 1;
  }
  assert(Object.keys(types).length >= 3, `At least 3 types represented (got ${Object.keys(types).length})`);
  assert((types['input_field'] || 0) >= 3, 'At least 3 input_field nodes in output');
  assert((types['dynamic_trigger'] || 0) >= 3, 'At least 3 dynamic_trigger nodes in output');

  // Signature check
  assert(candidates.every(c => c.signature), 'All candidates have signatures');
  const uniqueSigs = new Set(candidates.map(c => c.signature));
  assert(uniqueSigs.size >= candidates.length * 0.8, 'Most signatures are unique (≥80%)');

  // No garbage check
  assert(!candidates.some(c => c.nodeType === 'decorative'), 'No decorative in output');
  assert(!candidates.some(c => c.nodeType === 'disabled'), 'No disabled in output');
  assert(!candidates.some(c => !c.visible), 'No invisible in output');
}

// ═══════════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\n═══════════════════════════════════════════');
console.log(`  Total: ${testCount} | Passed: ${passCount} | Failed: ${failCount}`);
console.log('═══════════════════════════════════════════');

process.exit(failCount > 0 ? 1 : 0);
