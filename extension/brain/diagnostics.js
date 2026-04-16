/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Diagnostics — Universal Internal Telemetry Collector
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: content script (Isolated World)
 * Purpose:  A single, lightweight, in-memory log buffer that every brain module
 *           writes to. At the end of each action cycle, the BrainExecutor
 *           flushes this buffer and attaches it to the response that travels
 *           back through the bridge server — making all internal state visible
 *           to the external orchestrator without any extra network requests.
 *
 * Security:
 *   - Pure in-memory JavaScript array. No DOM modifications. No network calls.
 *   - Lives entirely inside the extension's isolated world.
 *   - Anti-bot systems cannot detect or observe this object.
 *   - Automatically cleared after each flush to prevent memory growth.
 *
 * Usage (by any brain module):
 *   BrowserAgent.Diagnostics.record('stability', { status: 'stable', waitedMs: 340 });
 *   BrowserAgent.Diagnostics.record('progress',  { score: 0.65, drift: false });
 *
 * Usage (by BrainExecutor at end of executeFullFlow):
 *   result.diagnostics = BrowserAgent.Diagnostics.flush();
 *
 * Ref: Implementation Plan v2.8 §15 Phase 1A.3
 * ═══════════════════════════════════════════════════════════════════════════════
 */

var BrowserAgent = BrowserAgent || {};

BrowserAgent.Diagnostics = (() => {
  'use strict';

  // ─── Internal Buffer ─────────────────────────────────────────────────────

  /** @type {Array<{module: string, timestamp: number, data: Object}>} */
  let _buffer = [];

  // ─── Public API ──────────────────────────────────────────────────────────

  return {
    /**
     * Record a diagnostic entry from any brain module.
     *
     * @param {string} module - Module name (e.g., 'stability', 'progress', 'clarification')
     * @param {Object} data - Arbitrary diagnostic payload
     */
    record(module, data) {
      _buffer.push({
        module,
        timestamp: Date.now(),
        data
      });
    },

    /**
     * Flush the buffer and return all collected entries.
     * Clears the buffer after reading — each action cycle starts fresh.
     *
     * @returns {Array<{module: string, timestamp: number, data: Object}>}
     */
    flush() {
      const entries = _buffer;
      _buffer = [];
      return entries;
    },

    /**
     * Peek at the buffer without clearing it.
     * Useful for mid-cycle inspection (e.g., clarification engine checking
     * stability results before deciding to escalate).
     *
     * @param {string} [module] - Optional filter by module name
     * @returns {Array<{module: string, timestamp: number, data: Object}>}
     */
    peek(module) {
      if (module) {
        return _buffer.filter(e => e.module === module);
      }
      return [..._buffer];
    },

    /**
     * Get the count of entries in the buffer.
     * @returns {number}
     */
    get length() {
      return _buffer.length;
    }
  };
})();
