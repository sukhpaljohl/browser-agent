/**
 * KeystrokeEngine — Realistic Keyboard Input Simulation
 * 
 * Replaces CDP's Input.insertText (single event, detectable) with
 * full keyDown → keyPress → keyUp cycles with:
 *   - Per-character hold duration (mean 95ms, variable)
 *   - Inter-keystroke timing (varies by bigram frequency)
 *   - Shift key handling (explicit keyDown before, keyUp after)
 *   - Typo simulation (2-3% error rate, backspace correction)
 *   - Realistic typing rhythm (not metronomic)
 */
class KeystrokeEngine {
  constructor(model) {
    this.model = model;

    // Key code mappings
    this._keyCodes = this._buildKeyCodeMap();

    // Bigram timing modifiers (common pairs are faster)
    this._fastBigrams = new Set([
      'th', 'he', 'in', 'er', 'an', 'on', 'en', 'at', 'es',
      'ed', 'to', 'it', 'ou', 'ea', 'hi', 'is', 'or', 'ti',
      'as', 'te', 'et', 'ha', 'al', 'st', 'si', 'io', 'le',
      'se', 'of', 'ar', 're', 'nd', 'ng', 'nt', 'me', 'no'
    ]);

    // Slow bigrams (finger travel distance)
    this._slowBigrams = new Set([
      'qp', 'pq', 'za', 'zx', 'xz', 'qw', 'pl', 'mk', 'bn',
      'vb', 'yu', 'gh', 'fj', 'dk', 'sl', 'qa', 'ws', 'ed'
    ]);

    // Typo probability
    this.typoRate = 0.025; // 2.5%
  }

  /**
   * Generate a complete keystroke sequence for a text string.
   * Returns array of CDP Input.dispatchKeyEvent commands with timing.
   * 
   * @param {string} text - text to type
   * @param {object} [opts] - options
   * @returns {Array<{action: string, params: object, delay: number}>}
   */
  generateKeystrokes(text, opts = {}) {
    const commands = [];
    let prevChar = null;
    const chars = text.split('');

    for (let i = 0; i < chars.length; i++) {
      const char = chars[i];
      const isUpper = char !== char.toLowerCase() && char !== char.toUpperCase() === false && /[A-Z]/.test(char);
      const needsShift = isUpper || this._isShiftChar(char);

      // Inter-key delay
      const ikiDelay = this._sampleInterKeyInterval(prevChar, char);
      if (i > 0) {
        commands.push({ action: 'wait', delay: ikiDelay });
      }

      // Typo simulation
      if (Math.random() < this.typoRate && i > 0 && i < chars.length - 1) {
        const typoCommands = this._generateTypo(char);
        commands.push(...typoCommands);
        prevChar = char;
        continue;
      }

      // Shift key handling
      if (needsShift) {
        commands.push({
          action: 'keyDown',
          params: { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
          delay: 0
        });
        commands.push({ action: 'wait', delay: this._sampleShiftDelay() });
      }

      // Key press sequence
      const keyInfo = this._getKeyInfo(char);

      // keyDown
      commands.push({
        action: 'keyDown',
        params: {
          type: 'rawKeyDown',
          key: char,
          code: keyInfo.code,
          windowsVirtualKeyCode: keyInfo.vk,
          text: char
        },
        delay: 0
      });

      // char event (text input)
      commands.push({
        action: 'char',
        params: {
          type: 'char',
          key: char,
          code: keyInfo.code,
          text: char
        },
        delay: 0
      });

      // Hold duration
      const holdDuration = this._sampleHoldDuration(char);
      commands.push({ action: 'wait', delay: holdDuration });

      // keyUp
      commands.push({
        action: 'keyUp',
        params: {
          type: 'keyUp',
          key: char,
          code: keyInfo.code,
          windowsVirtualKeyCode: keyInfo.vk
        },
        delay: 0
      });

      // Release shift
      if (needsShift) {
        commands.push({ action: 'wait', delay: this._sampleShiftDelay() * 0.7 });
        commands.push({
          action: 'keyUp',
          params: { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
          delay: 0
        });
      }

      prevChar = char;
    }

    return commands;
  }

  // ═══════════════════════════════════════════════════════════
  //  TIMING SAMPLING
  // ═══════════════════════════════════════════════════════════

  /**
   * Sample inter-keystroke interval (IKI) based on bigram.
   * Fast bigrams: 80-120ms, Normal: 100-180ms, Slow: 150-250ms
   */
  _sampleInterKeyInterval(prevChar, currentChar) {
    const bigram = prevChar ? (prevChar + currentChar).toLowerCase() : '';

    let baseMean, baseStd;
    if (this._fastBigrams.has(bigram)) {
      baseMean = 95;
      baseStd = 20;
    } else if (this._slowBigrams.has(bigram)) {
      baseMean = 190;
      baseStd = 40;
    } else {
      baseMean = 135;
      baseStd = 35;
    }

    // Space bar is typically faster (thumb)
    if (currentChar === ' ') {
      baseMean *= 0.8;
    }

    // Add noise
    const iki = baseMean + baseStd * this._normalRandom();
    return Math.max(40, Math.min(400, Math.round(iki)));
  }

  /**
   * Sample key hold duration.
   * Regular keys: ~80-120ms, Space: ~100-150ms
   */
  _sampleHoldDuration(char) {
    let mean = 95;
    let std = 25;

    if (char === ' ') {
      mean = 120;
      std = 30;
    } else if (char === '\n' || char === '\r') {
      mean = 140;
      std = 35;
    }

    return Math.max(30, Math.min(250, Math.round(mean + std * this._normalRandom())));
  }

  /**
   * Sample shift key coordination delay.
   */
  _sampleShiftDelay() {
    return Math.max(15, Math.round(35 + 15 * this._normalRandom()));
  }

  // ═══════════════════════════════════════════════════════════
  //  TYPO SIMULATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate a typo: wrong key → pause → backspace → correct key.
   */
  _generateTypo(correctChar) {
    const typoChar = this._getAdjacentKey(correctChar);
    const typoKeyInfo = this._getKeyInfo(typoChar);
    const correctKeyInfo = this._getKeyInfo(correctChar);

    const commands = [];

    // Type wrong key
    commands.push({
      action: 'keyDown',
      params: { type: 'rawKeyDown', key: typoChar, code: typoKeyInfo.code, windowsVirtualKeyCode: typoKeyInfo.vk, text: typoChar },
      delay: 0
    });
    commands.push({
      action: 'char',
      params: { type: 'char', key: typoChar, code: typoKeyInfo.code, text: typoChar },
      delay: 0
    });
    commands.push({ action: 'wait', delay: this._sampleHoldDuration(typoChar) });
    commands.push({
      action: 'keyUp',
      params: { type: 'keyUp', key: typoChar, code: typoKeyInfo.code, windowsVirtualKeyCode: typoKeyInfo.vk },
      delay: 0
    });

    // Recognition pause (200-500ms — human notices the error)
    commands.push({ action: 'wait', delay: Math.round(200 + Math.random() * 300) });

    // Backspace
    commands.push({
      action: 'keyDown',
      params: { type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      delay: 0
    });
    commands.push({ action: 'wait', delay: this._sampleHoldDuration('x') });
    commands.push({
      action: 'keyUp',
      params: { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
      delay: 0
    });

    // Brief pause before correction
    commands.push({ action: 'wait', delay: Math.round(50 + Math.random() * 100) });

    // Type correct key
    commands.push({
      action: 'keyDown',
      params: { type: 'rawKeyDown', key: correctChar, code: correctKeyInfo.code, windowsVirtualKeyCode: correctKeyInfo.vk, text: correctChar },
      delay: 0
    });
    commands.push({
      action: 'char',
      params: { type: 'char', key: correctChar, code: correctKeyInfo.code, text: correctChar },
      delay: 0
    });
    commands.push({ action: 'wait', delay: this._sampleHoldDuration(correctChar) });
    commands.push({
      action: 'keyUp',
      params: { type: 'keyUp', key: correctChar, code: correctKeyInfo.code, windowsVirtualKeyCode: correctKeyInfo.vk },
      delay: 0
    });

    return commands;
  }

  /**
   * Get an adjacent key on QWERTY keyboard for realistic typos.
   */
  _getAdjacentKey(char) {
    const adjacency = {
      'q': 'wa', 'w': 'qes', 'e': 'wrd', 'r': 'eft', 't': 'rgy',
      'y': 'thu', 'u': 'yji', 'i': 'uko', 'o': 'ilp', 'p': 'ol',
      'a': 'qsw', 's': 'adwe', 'd': 'sfre', 'f': 'dgrt', 'g': 'fhty',
      'h': 'gjyu', 'j': 'hkui', 'k': 'jlio', 'l': 'kop',
      'z': 'xas', 'x': 'zcsd', 'c': 'xvdf', 'v': 'cbfg', 'b': 'vngh',
      'n': 'bmhj', 'm': 'njk'
    };

    const lower = char.toLowerCase();
    const adj = adjacency[lower];
    if (!adj) return char;
    const typo = adj[Math.floor(Math.random() * adj.length)];
    return char === char.toUpperCase() ? typo.toUpperCase() : typo;
  }

  // ═══════════════════════════════════════════════════════════
  //  KEY CODE MAPPING
  // ═══════════════════════════════════════════════════════════

  _getKeyInfo(char) {
    const code = this._keyCodes[char.toLowerCase()] || this._keyCodes[char];
    if (code) return code;

    // Default fallback
    const vk = char.toUpperCase().charCodeAt(0);
    return { code: `Key${char.toUpperCase()}`, vk: vk };
  }

  _isShiftChar(char) {
    return '~!@#$%^&*()_+{}|:"<>?'.includes(char) || (char >= 'A' && char <= 'Z');
  }

  _buildKeyCodeMap() {
    const map = {};

    // Letters
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(97 + i); // a-z
      map[letter] = { code: `Key${letter.toUpperCase()}`, vk: 65 + i };
    }

    // Numbers
    for (let i = 0; i <= 9; i++) {
      map[String(i)] = { code: `Digit${i}`, vk: 48 + i };
    }

    // Special characters
    Object.assign(map, {
      ' ': { code: 'Space', vk: 32 },
      '.': { code: 'Period', vk: 190 },
      ',': { code: 'Comma', vk: 188 },
      '/': { code: 'Slash', vk: 191 },
      ';': { code: 'Semicolon', vk: 186 },
      "'": { code: 'Quote', vk: 222 },
      '[': { code: 'BracketLeft', vk: 219 },
      ']': { code: 'BracketRight', vk: 221 },
      '\\': { code: 'Backslash', vk: 220 },
      '-': { code: 'Minus', vk: 189 },
      '=': { code: 'Equal', vk: 187 },
      '`': { code: 'Backquote', vk: 192 },
      '\t': { code: 'Tab', vk: 9 },
      '\n': { code: 'Enter', vk: 13 },
      '\r': { code: 'Enter', vk: 13 },
    });

    return map;
  }

  /**
   * Box-Muller normal distribution.
   */
  _normalRandom() {
    let u1, u2;
    do { u1 = Math.random(); } while (u1 === 0);
    u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(KeystrokeEngine);
