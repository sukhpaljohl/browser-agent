/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Stealth Audit — Anti-Bot Detection Scanner
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  Runs 12 environment checks to detect bot-detection exposure.
 *           Returns a structured report with pass/fail, severity, and risk list.
 *
 * Extracted from apple-strategy.js — made fully site-agnostic.
 *
 * Usage:
 *   const report = await BrowserAgent.StealthAudit.run();
 *   // report.checks — array of individual check results
 *   // report.risks  — array of human-readable risk strings
 *   // report.summary — { total, passed, failed, critical, high }
 *   // report.text   — formatted human-readable report string
 *
 * Ref: Implementation Plan — Strategy-to-Brain Migration
 * ═══════════════════════════════════════════════════════════════════════════════
 */

BrowserAgent.StealthAudit = (() => {
  'use strict';

  /**
   * Run all 12 stealth detection checks.
   * @returns {Promise<Object>} Full audit report
   */
  async function run() {
    console.log('[StealthAudit] Running stealth audit...');
    const checks = [];
    const risks = [];

    // ── 1. navigator.webdriver ──
    const webdriver = navigator.webdriver;
    checks.push({
      test: 'navigator.webdriver',
      value: String(webdriver),
      pass: !webdriver,
      severity: 'CRITICAL'
    });
    if (webdriver) risks.push('navigator.webdriver is TRUE — most common bot check');

    // ── 2. Chrome automation flags ──
    const hasAutomation = !!(window.chrome && window.chrome.csi);
    checks.push({
      test: 'chrome.csi() present',
      value: String(hasAutomation),
      pass: true,  // csi is present in normal Chrome too
      severity: 'INFO'
    });

    // ── 3. window.chrome.runtime ──
    const hasRuntime = !!(window.chrome && window.chrome.runtime && window.chrome.runtime.id);
    checks.push({
      test: 'chrome.runtime.id (extension detected)',
      value: String(hasRuntime),
      pass: !hasRuntime,
      severity: hasRuntime ? 'LOW' : 'INFO',
      note: 'Content scripts run in isolated world — page JS cannot see this'
    });

    // ── 4. Headless indicators ──
    const plugins = navigator.plugins?.length || 0;
    const languages = navigator.languages?.length || 0;
    checks.push({
      test: 'navigator.plugins.length',
      value: String(plugins),
      pass: plugins > 0,
      severity: plugins === 0 ? 'HIGH' : 'INFO'
    });
    if (plugins === 0) risks.push('Zero plugins — headless browser indicator');

    checks.push({
      test: 'navigator.languages.length',
      value: String(languages),
      pass: languages > 0,
      severity: 'INFO'
    });

    // ── 5. User agent consistency ──
    const ua = navigator.userAgent;
    const hasHeadless = /HeadlessChrome/i.test(ua);
    checks.push({
      test: 'UserAgent contains HeadlessChrome',
      value: String(hasHeadless),
      pass: !hasHeadless,
      severity: hasHeadless ? 'CRITICAL' : 'INFO'
    });
    if (hasHeadless) risks.push('UserAgent contains "HeadlessChrome"');

    // ── 6. WebGL renderer (detect virtual GPU) ──
    let webglRenderer = 'N/A';
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      if (gl) {
        const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
        if (debugInfo) {
          webglRenderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
        }
      }
    } catch (e) { /* ignore */ }
    const isSoftwareRenderer = /SwiftShader|llvmpipe|Mesa/i.test(webglRenderer);
    checks.push({
      test: 'WebGL renderer',
      value: webglRenderer,
      pass: !isSoftwareRenderer,
      severity: isSoftwareRenderer ? 'HIGH' : 'INFO'
    });
    if (isSoftwareRenderer) risks.push(`Software GPU renderer: ${webglRenderer}`);

    // ── 7. Screen dimensions (detect tiny/zero viewports) ──
    checks.push({
      test: 'Screen dimensions',
      value: `${screen.width}x${screen.height} (viewport: ${window.innerWidth}x${window.innerHeight})`,
      pass: screen.width > 0 && screen.height > 0 && window.innerWidth > 100,
      severity: 'INFO'
    });

    // ── 8. Permissions API fingerprint ──
    let notifPerm = 'N/A';
    try {
      const result = await navigator.permissions.query({ name: 'notifications' });
      notifPerm = result.state;
    } catch (e) { notifPerm = 'error'; }
    checks.push({
      test: 'Notification permission',
      value: notifPerm,
      pass: notifPerm !== 'denied',
      severity: 'INFO'
    });

    // ── 9. Connection/RTT fingerprint ──
    const conn = navigator.connection;
    checks.push({
      test: 'Network connection info',
      value: conn ? `${conn.effectiveType}, rtt=${conn.rtt}ms, downlink=${conn.downlink}Mbps` : 'N/A',
      pass: true,
      severity: 'INFO'
    });

    // ── 10. CDP debugger artifact check ──
    let cdpDetectable = false;
    try {
      const t0 = performance.now();
      // eslint-disable-next-line no-debugger
      debugger;
      const t1 = performance.now();
      cdpDetectable = (t1 - t0) > 100;
    } catch (e) { /* ignore */ }
    checks.push({
      test: 'Debugger statement timing',
      value: cdpDetectable ? 'PAUSED (DevTools/CDP detected)' : 'No pause (clean)',
      pass: !cdpDetectable,
      severity: cdpDetectable ? 'MEDIUM' : 'INFO'
    });
    if (cdpDetectable) risks.push('Debugger statement caused pause — DevTools/CDP may be detectable');

    // ── 11. Automation-specific CSS media queries ──
    let prefersReducedMotion = false;
    try {
      prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { /* ignore */ }
    checks.push({
      test: 'prefers-reduced-motion',
      value: String(prefersReducedMotion),
      pass: true,
      severity: 'INFO'
    });

    // ── 12. document.hasFocus() ──
    const hasFocus = document.hasFocus();
    checks.push({
      test: 'document.hasFocus()',
      value: String(hasFocus),
      pass: hasFocus,
      severity: hasFocus ? 'INFO' : 'LOW',
      note: 'Some bots run in background tabs without focus'
    });

    // ── Summary ──
    const failed = checks.filter(c => !c.pass);
    const critical = failed.filter(c => c.severity === 'CRITICAL');
    const high = failed.filter(c => c.severity === 'HIGH');

    const lines = ['═══ STEALTH AUDIT REPORT ═══', ''];
    for (const c of checks) {
      const icon = c.pass ? '✅' : (c.severity === 'CRITICAL' ? '🚨' : c.severity === 'HIGH' ? '⚠️' : '⚡');
      lines.push(`${icon} ${c.test}: ${c.value}`);
      if (c.note) lines.push(`   ↳ ${c.note}`);
    }
    lines.push('');
    lines.push(`PASSED: ${checks.length - failed.length}/${checks.length}`);
    if (risks.length > 0) {
      lines.push('');
      lines.push('RISKS:');
      risks.forEach(r => lines.push(`  🔴 ${r}`));
    }
    if (risks.length === 0) {
      lines.push('🟢 No significant detection risks found.');
    }

    return {
      checks,
      risks,
      summary: {
        total: checks.length,
        passed: checks.length - failed.length,
        failed: failed.length,
        critical: critical.length,
        high: high.length
      },
      text: lines.join('\n')
    };
  }

  return { run };
})();
