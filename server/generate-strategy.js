#!/usr/bin/env node
/**
 * Strategy Generator — Auto-generates a browser agent strategy class from a DOMRecon blueprint.
 * 
 * Usage:
 *   node generate-strategy.js <blueprint.json> [--name MySiteStrategy] [--output ./strategies/]
 * 
 * What it generates:
 *   - A complete strategy class with correctly chosen click methods
 *   - Editor input handling based on probed capabilities
 *   - Settings/menu navigation using discovered interactions
 *   - Submit button detection using blueprint data
 *   - State machine awareness for multi-step workflows
 */

const fs = require('fs');
const path = require('path');

// ─── CLI Args ────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('--help')) {
  console.log(`
Strategy Generator — Auto-generate a browser agent strategy from a DOMRecon blueprint.

Usage:
  node generate-strategy.js <blueprint.json> [options]

Options:
  --name <Name>       Strategy class name (e.g., "FlowStrategy"). Auto-derived from hostname if omitted.
  --output <dir>      Output directory. Defaults to ../extension/strategies/
  --dry-run           Print to stdout instead of writing a file.

Examples:
  node generate-strategy.js site_blueprint_labs.google.json
  node generate-strategy.js recon_chatgpt.com__root.json --name ChatGPTStrategy --dry-run
`);
  process.exit(0);
}

const blueprintPath = args[0];
const nameFlag = args.indexOf('--name');
const outputFlag = args.indexOf('--output');
const dryRun = args.includes('--dry-run');

let customName = nameFlag !== -1 ? args[nameFlag + 1] : null;
let outputDir = outputFlag !== -1 ? args[outputFlag + 1] : path.join(__dirname, '..', 'extension', 'strategies');

// ─── Load Blueprint ──────────────────────────────────

let blueprint;
try {
  const raw = fs.readFileSync(path.resolve(blueprintPath), 'utf8');
  blueprint = JSON.parse(raw);
} catch (e) {
  console.error(`Failed to load blueprint: ${e.message}`);
  process.exit(1);
}

// Handle site-level blueprints (use first page)
const page = blueprint.pages ? blueprint.pages[0] : blueprint;
const hostname = blueprint.hostname || page.hostname || 'unknown';

// ─── Derive Strategy Name ────────────────────────────

function deriveClassName(hostname) {
  // labs.google → LabsGoogle → LabsGoogleStrategy
  const parts = hostname.replace(/^www\./, '').split(/[.\-_]+/);
  return parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('') + 'Strategy';
}

const className = customName || deriveClassName(hostname);
const fileName = className.replace(/([A-Z])/g, (m, c, i) => (i > 0 ? '-' : '') + c.toLowerCase()) + '.js';

// ─── Analyze Blueprint ───────────────────────────────

function analyzeBlueprint(page, allPages) {
  const analysis = {
    hostname,
    framework: page.framework || {},
    hasRadixUI: false,
    hasMaterialUI: false,
    editorType: null,
    editorMethod: 'cdp_insertText',  // safest default
    needsCDP: true,
    submitButton: null,
    settingsButton: null,
    textbox: null,
    tabs: [],
    menus: [],
    stateTransitions: [],
    overlayInteractions: [],
    customElements: []
  };

  // Framework
  const css = (page.framework && page.framework.css) || [];
  analysis.hasRadixUI = css.includes('Radix UI');
  analysis.hasMaterialUI = css.includes('Material UI');
  analysis.editorType = page.framework && page.framework.editor;
  analysis.customElements = (page.framework && page.framework.customElements) || [];

  // Editor capabilities (from probe)
  if (page.editorCapabilities && page.editorCapabilities.length > 0) {
    const primary = page.editorCapabilities[0];
    analysis.editorMethod = primary.recommended;
    analysis.needsCDP = primary.needsCDP;
    analysis.editorType = primary.editorType || analysis.editorType;
  }

  // Textbox
  const textboxes = (page.inputFields || []).filter(f =>
    f.role === 'textbox' || f.inputType === 'contenteditable' || f.inputType === 'textarea'
  );
  if (textboxes.length > 0) {
    analysis.textbox = textboxes[0];
  }

  // Submit button — look for elements with submit_form intent first, then text match
  const interactives = page.interactiveElements || [];
  const submitByIntent = interactives.find(el => el.intent === 'submit_form');
  if (submitByIntent) {
    analysis.submitButton = submitByIntent;
  } else {
    const submitCandidates = interactives.filter(el => {
      const text = ((el.innerText || '') + ' ' + (el.ariaLabel || '')).toLowerCase();
      return text.includes('send') || text.includes('submit') || text.includes('generate') ||
             text.includes('create') || text.includes('go');
    });
    if (submitCandidates.length > 0) {
      analysis.submitButton = submitCandidates[0];
    }
  }

  // Settings button — use intent first, then heuristic
  const settingsByIntent = interactives.find(el => el.intent === 'open_settings');
  if (settingsByIntent) {
    analysis.settingsButton = settingsByIntent;
  } else {
    const settingsCandidates = interactives.filter(el => {
      const text = ((el.innerText || '') + ' ' + (el.ariaLabel || '')).toLowerCase();
      return (el.ariaHaspopup && !text.includes('add') && !text.includes('+')) ||
             text.includes('setting') || text.includes('config') || text.includes('option');
    });
    if (settingsCandidates.length > 0) {
      analysis.settingsButton = settingsCandidates[0];
    }
  }

  // File upload — from intent
  analysis.fileUpload = interactives.find(el => el.intent === 'upload_file') || null;

  // Tabs
  analysis.tabs = interactives.filter(el => el.role === 'tab' || el.purpose === 'tab');

  // Menus — from interactions (click + hover)
  analysis.overlayInteractions = (page.interactions || []).filter(ix =>
    ix.effect && ix.effect.overlaysAppeared && ix.effect.overlaysAppeared.length > 0
  );
  analysis.hoverInteractions = (page.interactions || []).filter(ix =>
    ix.probeType === 'hover'
  );

  // State transitions
  analysis.stateTransitions = page.stateTransitions || [];

  // Hierarchy
  analysis.hierarchy = page.hierarchy || {};

  return analysis;
}

const analysis = analyzeBlueprint(page, blueprint.pages || [page]);

// ─── Generate Strategy Code ─────────────────────────

function generateClickMethod(analysis) {
  if (analysis.hasRadixUI) {
    return `
  /**
   * Smart click: native DOM events → Main World fallback.
   * Radix UI portals require full PointerEvent + MouseEvent chain.
   */
  async _smartClick(element) {
    if (!element) return;

    const popoversBefore = document.querySelectorAll(
      '[data-radix-popper-content-wrapper], [role="menu"], [role="listbox"], [role="dialog"]'
    ).length;

    await this._nativeClick(element);
    await this._sleep(300);

    const popoversAfter = document.querySelectorAll(
      '[data-radix-popper-content-wrapper], [role="menu"], [role="listbox"], [role="dialog"]'
    ).length;

    if (popoversAfter > popoversBefore) {
      console.log('[${className}] Native click opened popover successfully');
      return;
    }

    // Fallback: Main World proxy via service worker
    console.log('[${className}] Native click did not open popover, trying Main World fallback...');
    await this._mainWorldClick(element);
    await this._sleep(300);
  }

  async _mainWorldClick(element) {
    if (!element) return;
    if (!element.id) element.id = 'agent-target-' + Math.random().toString(36).substr(2, 9);
    const rect = element.getBoundingClientRect();
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'EXEC_MAIN_WORLD',
        action: 'radix_click',
        payload: { id: element.id, rect: JSON.stringify({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }) }
      }, resolve);
    });
  }`;
  }

  // Non-Radix — simple native click is usually enough
  return `
  /**
   * Native click with full event sequence.
   */
  async _smartClick(element) {
    if (!element) return;
    await this._nativeClick(element);
    await this._sleep(200);
  }`;
}

function generateTypingMethod(analysis) {
  if (analysis.editorMethod === 'cdp_insertText' || analysis.needsCDP) {
    return `
  /**
   * Types text using CDP Input.insertText (native OS-level typing).
   * This is required because the editor rejects non-trusted events.
   */
  async _typePrompt(text) {
    const textbox = document.querySelector('${analysis.textbox ? analysis.textbox.selector : 'div[role="textbox"], textarea'}');
    if (!textbox) { console.error('[${className}] Textbox not found'); return; }

    textbox.focus();
    await this._sleep(100);

    // Clear existing content
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textbox);
    sel.removeAllRanges();
    sel.addRange(range);
    await this._execNativeType('keyEvent', { key: 'Backspace' });
    await this._sleep(200);

    // Type word-by-word with human-like delays
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
      await this._execNativeType('insertText', { text: chunk });
      await this._sleep(40 + Math.random() * 120);
    }

    textbox.blur();
    console.log('[${className}] ✓ Typing complete');
  }

  _execNativeType(action, payload) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'NATIVE_TYPE', action, ...payload }, (r) => {
        if (chrome.runtime.lastError) console.warn('[${className}] CDP error:', chrome.runtime.lastError.message);
        resolve(r || { success: false });
      });
    });
  }`;
  }

  if (analysis.editorMethod === 'execCommand') {
    return `
  /**
   * Types text using document.execCommand('insertText').
   * The editor accepts non-trusted execCommand events.
   */
  async _typePrompt(text) {
    const textbox = document.querySelector('${analysis.textbox ? analysis.textbox.selector : 'div[role="textbox"], textarea'}');
    if (!textbox) { console.error('[${className}] Textbox not found'); return; }

    textbox.focus();
    await this._sleep(100);
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
    await this._sleep(50);

    // Type word-by-word
    const words = text.split(' ');
    for (let i = 0; i < words.length; i++) {
      const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
      document.execCommand('insertText', false, chunk);
      await this._sleep(30 + Math.random() * 80);
    }

    console.log('[${className}] ✓ Typing complete');
  }`;
  }

  if (analysis.editorMethod === 'clipboardEvent') {
    return `
  /**
   * Types text using ClipboardEvent paste.
   * The editor's paste handler updates internal state correctly.
   */
  async _typePrompt(text) {
    const textbox = document.querySelector('${analysis.textbox ? analysis.textbox.selector : 'div[role="textbox"], textarea'}');
    if (!textbox) { console.error('[${className}] Textbox not found'); return; }

    textbox.focus();
    await this._sleep(100);

    // Clear
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(textbox);
    sel.removeAllRanges();
    sel.addRange(range);
    const dtEmpty = new DataTransfer();
    dtEmpty.setData('text/plain', '');
    textbox.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dtEmpty, bubbles: true, cancelable: true }));
    await this._sleep(100);

    // Paste text in chunks for human-like feel
    const words = text.split(' ');
    for (let i = 0; i < words.length; i += 3) {
      const chunk = words.slice(i, Math.min(i + 3, words.length)).join(' ') + (i + 3 < words.length ? ' ' : '');
      const dt = new DataTransfer();
      dt.setData('text/plain', chunk);
      // Position cursor at end
      const sel2 = window.getSelection();
      const r2 = document.createRange();
      r2.selectNodeContents(textbox);
      r2.collapse(false);
      sel2.removeAllRanges();
      sel2.addRange(r2);
      textbox.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      await this._sleep(50 + Math.random() * 100);
    }

    console.log('[${className}] ✓ Typing complete');
  }`;
  }

  // Default: InputEvent
  return `
  /**
   * Types text using native InputEvent dispatch.
   */
  async _typePrompt(text) {
    const textbox = document.querySelector('${analysis.textbox ? analysis.textbox.selector : 'div[role="textbox"], textarea'}');
    if (!textbox) { console.error('[${className}] Textbox not found'); return; }

    textbox.focus();
    await this._sleep(100);

    for (const char of text) {
      textbox.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: char, bubbles: true, cancelable: true }));
      textbox.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: char, bubbles: true }));
      await this._sleep(20 + Math.random() * 60);
    }

    console.log('[${className}] ✓ Typing complete');
  }`;
}

function generateSubmitMethod(analysis) {
  if (analysis.submitButton) {
    const sel = analysis.submitButton.selector;
    const fallbacks = analysis.submitButton.fallbacks || [];
    const text = analysis.submitButton.innerText || analysis.submitButton.ariaLabel || 'submit';
    return `
  /**
   * Submits the prompt.
   * Detected: "${text}" (intent: ${analysis.submitButton.intent || 'submit_form'})
   */
  async _submit() {
    // Primary: use known selector
    let sendBtn = document.querySelector('${sel}');

    // Fallback selectors from scan
    ${fallbacks.map(f => `if (!sendBtn) sendBtn = document.querySelector('${f}');`).join('\n    ')}

    // Heuristic fallback: search by text/aria
    if (!sendBtn) {
      sendBtn = Array.from(document.querySelectorAll('button')).find(btn => {
        if (!btn.offsetParent) return false;
        const text = (btn.textContent + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
        return text.includes('send') || text.includes('submit') || text.includes('generate');
      });
    }

    if (sendBtn) {
      await this._smartClick(sendBtn);
      console.log('[${className}] ✓ Submitted');
    } else {
      console.warn('[${className}] Submit button not found, trying Enter key...');
      const textbox = document.querySelector('div[role="textbox"], textarea');
      if (textbox) {
        textbox.focus();
        textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    }
  }`;
  }

  return `
  /**
   * Submits the prompt (no specific submit button detected — using heuristic search).
   */
  async _submit() {
    const sendBtn = Array.from(document.querySelectorAll('button')).find(btn => {
      if (!btn.offsetParent) return false;
      const text = (btn.textContent + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
      return text.includes('send') || text.includes('submit') || text.includes('generate');
    });

    if (sendBtn) {
      await this._smartClick(sendBtn);
    } else {
      const textbox = document.querySelector('div[role="textbox"], textarea');
      if (textbox) {
        textbox.focus();
        textbox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    }
  }`;
}

function generateSettingsCode(analysis) {
  if (!analysis.settingsButton && analysis.overlayInteractions.length === 0) {
    return '  // No settings menu detected during scan.';
  }

  let code = '';

  if (analysis.settingsButton) {
    const sel = analysis.settingsButton.selector;
    const text = analysis.settingsButton.innerText || analysis.settingsButton.ariaLabel || 'settings';
    code += `
  /**
   * Opens the settings menu. Detected trigger: "${text}"
   */
  async _openSettings() {
    const settingsBtn = document.querySelector('${sel}');
    if (!settingsBtn) {
      console.warn('[${className}] Settings button not found');
      return false;
    }
    await this._smartClick(settingsBtn);
    await this._sleep(800);
    return true;
  }`;
  }

  // Generate tab/option selection helpers from state transitions
  if (analysis.stateTransitions.length > 0) {
    code += `

  /**
   * State transitions discovered during scanning:
${analysis.stateTransitions.map(st => {
    const trigger = st.trigger.text || st.trigger.selector;
    const revealed = st.newElementsRevealed.slice(0, 5).map(e => `"${e.text || e.selector}"`).join(', ');
    return `   *   - Clicking "${trigger}" reveals: ${revealed}${st.totalNewElements > 5 ? ` (+${st.totalNewElements - 5} more)` : ''}`;
  }).join('\n')}
   */
  async _selectOption(optionText, scope = document) {
    const btns = Array.from(scope.querySelectorAll('button, [role="tab"], [role="radio"], [role="menuitem"], [role="option"]'))
      .filter(b => b.offsetParent !== null);
    const match = btns.find(b => b.textContent.trim() === optionText) ||
                  btns.find(b => b.textContent.toLowerCase().includes(optionText.toLowerCase()));
    if (match) {
      await this._smartClick(match);
      await this._sleep(400);
      return true;
    }
    console.warn('[${className}] Option "' + optionText + '" not found');
    return false;
  }`;
  }

  return code;
}

// ─── Assemble Full Strategy Class ────────────────────

const code = `/**
 * ${className} — Auto-generated from DOMRecon blueprint
 * 
 * Target:     ${hostname}
 * Framework:  UI=${analysis.framework.ui || 'Unknown'}, CSS=[${(analysis.framework.css || []).join(', ')}]
 * Editor:     ${analysis.editorType || 'None detected'}
 * Input:      ${analysis.editorMethod} (needsCDP=${analysis.needsCDP})
 * Generated:  ${new Date().toISOString()}
 * 
 * Blueprint summary:
 *   Interactive elements: ${page.summary ? page.summary.totalInteractive : '?'}
 *   Input fields:         ${page.summary ? page.summary.totalInputFields : '?'}
 *   Interactions probed:  ${page.summary ? page.summary.interactionsRecorded : '?'}
 *   Hover interactions:   ${page.summary ? (page.summary.hoverInteractions || 0) : '?'}
 *   Click interactions:   ${page.summary ? (page.summary.clickInteractions || 0) : '?'}
 *   State transitions:    ${page.summary ? (page.summary.stateTransitionsRecorded || 0) : '?'}
 *   Hierarchy regions:    ${page.summary ? (page.summary.hierarchyRegions || 0) : '?'}
 *   React components:     ${(analysis.framework.reactComponents || []).slice(0, 10).join(', ') || 'N/A'}
 *   Custom elements:      ${analysis.customElements.slice(0, 10).join(', ') || 'N/A'}
 */
window.BrowserAgent = window.BrowserAgent || {};

BrowserAgent.${className} = class ${className} {
  constructor(engine) {
    this.engine = engine;
    this.hostname = '${hostname}';
  }

  // ─── Helpers ──────────────────────────────────────────

  _sleep(ms) {
    const jitter = Math.floor(Math.random() * 150);
    return new Promise(resolve => setTimeout(resolve, ms + jitter));
  }

  /**
   * Native click with full PointerEvent → MouseEvent chain.
   * Identical to a real human click event sequence.
   */
  async _nativeClick(element) {
    if (!element) return;
    element.scrollIntoView({ behavior: 'instant', block: 'nearest' });
    await this._sleep(80);

    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const opts = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y,
      screenX: window.screenX + x, screenY: window.screenY + y
    };

    element.dispatchEvent(new PointerEvent('pointerover', { ...opts, pointerId: 1 }));
    element.dispatchEvent(new MouseEvent('mouseover', opts));
    element.dispatchEvent(new PointerEvent('pointerenter', { ...opts, pointerId: 1 }));
    element.dispatchEvent(new MouseEvent('mouseenter', opts));
    await this._sleep(20 + Math.random() * 30);

    element.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, button: 0, buttons: 1, pressure: 0.5 }));
    element.dispatchEvent(new MouseEvent('mousedown', { ...opts, button: 0, buttons: 1, detail: 1 }));
    if (element.focus) element.focus();
    await this._sleep(40 + Math.random() * 60);

    element.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, button: 0, buttons: 0, pressure: 0 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...opts, button: 0, buttons: 0, detail: 1 }));
    await this._sleep(5 + Math.random() * 15);

    element.dispatchEvent(new MouseEvent('click', { ...opts, button: 0, buttons: 0, detail: 1 }));
    await this._sleep(50);
  }
${generateClickMethod(analysis)}

  // ─── Text Input ───────────────────────────────────────
${generateTypingMethod(analysis)}

  // ─── Submit ───────────────────────────────────────────
${generateSubmitMethod(analysis)}

  // ─── Settings / Menu Navigation ───────────────────────
${generateSettingsCode(analysis)}

  // ─── Main Execution Flow ──────────────────────────────

  async executeFullFlow(prompt, images = []) {
    try {
      console.log('[${className}] ═══════════════════════════════════════');
      console.log('[${className}] Executing flow...');
      console.log('[${className}] Prompt: "' + prompt.substring(0, 80) + '..."');
      console.log('[${className}] Images: ' + images.length);

      // Phase 1: Close any existing overlays
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true
      }));
      await this._sleep(500);

      // Phase 2: Type the prompt
      if (prompt) {
        console.log('[${className}] Typing prompt...');
        await this._typePrompt(prompt);
        await this._sleep(300);
      }

      // Phase 3: Submit
      console.log('[${className}] Submitting...');
      await this._submit();

      console.log('[${className}] ═══════════════════════════════════════');
      console.log('[${className}] ✓ Flow execution complete');
      return { success: true, response: { text: '${className} executed successfully' } };
    } catch (e) {
      console.error('[${className}] ✗ Error:', e.message || e);
      return { success: false, error: e.message };
    }
  }
};
`;

// ─── Output ──────────────────────────────────────────

if (dryRun) {
  console.log(code);
  console.log(`\n// ─── Analysis Summary ───`);
  console.log(`// Framework:    ${analysis.framework.ui} + [${(analysis.framework.css || []).join(', ')}]`);
  console.log(`// Editor:       ${analysis.editorType || 'none'} → method: ${analysis.editorMethod}`);
  console.log(`// Needs CDP:    ${analysis.needsCDP}`);
  console.log(`// Submit btn:   ${analysis.submitButton ? analysis.submitButton.selector : 'not found'}`);
  console.log(`// Settings btn: ${analysis.settingsButton ? analysis.settingsButton.selector : 'not found'}`);
  console.log(`// Textbox:      ${analysis.textbox ? analysis.textbox.selector : 'not found'}`);
  console.log(`// Tabs:         ${analysis.tabs.length}`);
  console.log(`// Interactions: ${analysis.overlayInteractions.length} click + ${analysis.hoverInteractions.length} hover`);
  console.log(`// State trans:  ${analysis.stateTransitions.length}`);
  console.log(`// React comps:  ${(analysis.framework.reactComponents || []).length}`);
  console.log(`// Hierarchy:    ${Object.keys(analysis.hierarchy).length} regions: ${Object.keys(analysis.hierarchy).join(', ')}`);
  console.log(`// File upload:  ${analysis.fileUpload ? analysis.fileUpload.selector : 'not found'}`);
} else {
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outPath = path.join(outputDir, fileName);
  fs.writeFileSync(outPath, code);
  console.log(`✓ Strategy generated: ${outPath}`);
  console.log(`  Class: ${className}`);
  console.log(`  Framework: ${analysis.framework.ui} + [${(analysis.framework.css || []).join(', ')}]`);
  console.log(`  Editor method: ${analysis.editorMethod} (needsCDP=${analysis.needsCDP})`);
  console.log(`  Submit: ${analysis.submitButton ? analysis.submitButton.selector : 'heuristic search'}`);
  console.log(`  State transitions: ${analysis.stateTransitions.length}`);
  console.log(`\nRemember to:`);
  console.log(`  1. Add "${fileName}" to manifest.json content_scripts.js array`);
  console.log(`  2. Add strategy routing in content.js init()`);
  console.log(`  3. Customize the executeFullFlow() for site-specific workflows`);
}
