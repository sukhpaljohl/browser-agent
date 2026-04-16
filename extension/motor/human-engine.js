/**
 * HumanEngine — Unified Orchestrator
 * 
 * Top-level controller that composes all layers into a single API.
 * The strategy module calls HumanEngine methods instead of raw CDP.
 * 
 * Architecture:
 *   UserProfile (persistent identity)
 *     └─ SessionState (dynamic cognitive state)
 *         └─ AttentionField (spatial perception)
 *             └─ MotorModel (dataset-calibrated distributions)
 *                 └─ TrajectoryGenerator (Bézier paths)
 *                 └─ SegmentMatcher (real template bank)
 *                 └─ KeystrokeEngine (keyDown/keyUp cycles)
 * 
 * All output is dispatched via CDP through the service worker.
 */
class HumanEngine {
  constructor() {
    this._initialized = false;
    this._tickInterval = null;

    // Layers (populated during init)
    this.profile = null;
    this.state = null;
    this.attention = null;
    this.motor = null;
    this.trajectory = null;
    this.segments = null;
    this.keyboard = null;
  }

  /**
   * Initialize the engine by loading data files and constructing all layers.
   * Call this once when the strategy starts.
   */
  async init() {
    if (this._initialized) return;

    console.log('[HumanEngine] Initializing...');

    // Load data files from extension/data/
    const [fingerprintData, segmentsData] = await Promise.all([
      this._loadJSON('motor-fingerprint.json'),
      this._loadJSON('trajectory-segments.json')
    ]);

    if (!fingerprintData) {
      console.error('[HumanEngine] Failed to load motor-fingerprint.json');
      return;
    }

    // === Layer 1: Identity ===
    this.profile = new UserProfile();

    // === Layer 2: Session State ===
    this.state = new SessionState(this.profile);

    // === Layer 3: Attention ===
    this.attention = new AttentionField();

    // === Layer 4: Motor Model ===
    this.motor = new MotorModel(fingerprintData);

    // === Layer 5: Trajectory Generator ===
    this.trajectory = new TrajectoryGenerator(this.motor, this.profile.hardware);

    // === Layer 6: Segment Matcher ===
    if (segmentsData) {
      this.segments = new SegmentMatcher(segmentsData);
    }

    // === Layer 7: Keystroke Engine ===
    this.keyboard = new KeystrokeEngine(this.motor);

    // Start cognitive tick loop (updates state every 500ms)
    this._startTicking();

    this._initialized = true;
    console.log('[HumanEngine] Ready. Profile:', this.profile.id.slice(0, 8),
      'Speed:', this.profile.baseMotorSpeed.toFixed(2),
      'Precision:', this.profile.motorPrecision.toFixed(2));
  }

  /**
   * Load a JSON file from the extension's data/ directory.
   */
  async _loadJSON(filename) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'FETCH_JSON', filename }, (response) => {
        if (!response || !response.success) {
          console.warn(`[HumanEngine] Could not load ${filename}:`, response?.error || 'Unknown error');
          resolve(null);
        } else {
          resolve(response.data);
        }
      });
    });
  }

  /**
   * Start the cognitive tick loop.
   */
  _startTicking() {
    if (this._tickInterval) clearInterval(this._tickInterval);
    this._tickInterval = setInterval(() => {
      if (this.state) this.state.tick();
    }, 500);
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API — MOUSE ACTIONS
  // ═══════════════════════════════════════════════════════════

  /**
   * Move the cursor to a target element and click it.
   * This is the main interaction method.
   * 
   * @param {string} selector - CSS selector for target element
   * @param {object} [opts] - options
   * @returns {Promise<boolean>} success
   */
  async click(selector, opts = {}) {
    if (!this._initialized) await this.init();

    // The selector argument can be a string OR an actual DOM element
    let el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) {
      console.warn(`[HumanEngine] Element not found:`, selector);
      this.state.onError();
      return false;
    }

    // Get initial position
    let rect = await this._getElementRect(el);
    if (!rect) {
      this.state.onError();
      return false;
    }

    // Stealth Scroll: If out of vertical viewport bounds, use human-like mouseWheel scroll
    // Native scrollIntoView() is easily detected by advanced anti-bot scripts.
    const vH = window.innerHeight;
    if (rect.y < 0 || rect.y > vH) {
      // Calculate delta to center the element in the viewport
      const deltaY = rect.y - (vH / 2) + (rect.height / 2);
      
      // Move mouse to center of screen before scrolling (ensures wheel hits the main window)
      await this.moveTo(window.innerWidth / 2, vH / 2);
      
      // Use HumanEngine's built-in stealth CDP scroller
      await this.scroll(deltaY);
      await this._sleep(300 + Math.random() * 200);

      // Recalculate position after human scroll
      rect = await this._getElementRect(el);
      if (!rect || rect.y < 0 || rect.y > vH) {
        console.warn('[HumanEngine] Failed to scroll element into view securely.');
      }
    }

    // Attention: shift focus, calculate search time
    this.attention.shiftFocus(rect);
    const searchTime = this.attention.getSearchTime(rect);
    await this._sleep(searchTime);

    // Calculate click point (not always dead center — human imprecision)
    const precision = this.profile.motorPrecision * (this.state ? this.state.getMotorModifiers().precision : 1);
    const clickX = rect.x + rect.width * (0.3 + Math.random() * 0.4) + (1 - precision) * (Math.random() - 0.5) * 10;
    const clickY = rect.y + rect.height * (0.3 + Math.random() * 0.4) + (1 - precision) * (Math.random() - 0.5) * 6;

    // Maybe do an "almost interaction" first (hover a nearby element)
    if (this.attention.shouldHoverWithoutClick(Math.hypot(clickX - this.trajectory.currentX, clickY - this.trajectory.currentY))) {
      await this._performIdleHover();
    }

    // Get motor modifiers from both profile and state
    const profileMods = this.profile.getMotorModifiers();
    const stateMods = this.state.getMotorModifiers();
    const combinedState = {
      speedMultiplier: profileMods.speedMultiplier * stateMods.speedMultiplier,
      fatigue: stateMods.fatigue,
      precision: stateMods.precision
    };

    // Pre-click hesitation
    if (this.profile.hesitationLevel > 0.1) {
      const hesitationMs = this.profile.hesitationLevel * 200 * stateMods.hesitationDelay;
      await this._sleep(hesitationMs);
    }

    // Generate the trajectory
    const click = this.trajectory.generateClick(clickX, clickY, rect.width, combinedState);

    // Dispatch via CDP
    await this._dispatchTrajectory(click.trajectory);
    await this._sleep(click.preClickPause);
    await this._dispatchClick(clickX, clickY, click.holdDuration);

    // Update state
    this.state.onClick();
    this.state.onSuccess();

    return true;
  }

  /**
   * Move cursor to an element without clicking.
   */
  async hover(selector) {
    if (!this._initialized) await this.init();

    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return false;

    let rect = await this._getElementRect(el);
    if (!rect) return false;

    // Stealth Scroll
    const vH = window.innerHeight;
    if (rect.y < 0 || rect.y > vH) {
      const deltaY = rect.y - (vH / 2) + (rect.height / 2);
      await this.moveTo(window.innerWidth / 2, vH / 2);
      await this.scroll(deltaY);
      await this._sleep(300 + Math.random() * 200);
      rect = await this._getElementRect(el);
      if (!rect) return false;
    }

    this.attention.shiftFocus(rect);
    const searchTime = this.attention.getSearchTime(rect);
    await this._sleep(searchTime);

    const hoverX = rect.x + rect.width * (0.3 + Math.random() * 0.4);
    const hoverY = rect.y + rect.height * (0.3 + Math.random() * 0.4);

    const stateMods = this.state.getMotorModifiers();
    const trajectory = this.trajectory.generateTrajectory(hoverX, hoverY, rect.width, stateMods);
    await this._dispatchTrajectory(trajectory);

    return true;
  }

  /**
   * Move cursor to specific coordinates.
   */
  async moveTo(x, y) {
    if (!this._initialized) await this.init();

    const stateMods = this.state.getMotorModifiers();
    const trajectory = this.trajectory.generateTrajectory(x, y, 40, stateMods);
    await this._dispatchTrajectory(trajectory);
  }

  /**
   * Drag an element to another element natively.
   */
  async drag(sourceSelectorOrEl, targetSelectorOrEl) {
    if (!this._initialized) await this.init();

    const sourceRect = await this._getElementRect(sourceSelectorOrEl);
    const targetRect = await this._getElementRect(targetSelectorOrEl);
    if (!sourceRect || !targetRect) {
      console.warn(`[HumanEngine] Drag elements not found`);
      this.state.onError();
      return false;
    }

    // 1. Move attention and mouse to source
    this.attention.shiftFocus(sourceRect);
    await this._sleep(this.attention.getSearchTime(sourceRect));

    const sourceX = sourceRect.x + sourceRect.width * (0.4 + Math.random() * 0.2);
    const sourceY = sourceRect.y + sourceRect.height * (0.4 + Math.random() * 0.2);
    const stateMods = this.state.getMotorModifiers();

    const pathToSource = this.trajectory.generateTrajectory(sourceX, sourceY, sourceRect.width, stateMods);
    await this._dispatchTrajectory(pathToSource);

    // 2. Mouse DOWN (Grab)
    await this._sendCDP('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: Math.round(sourceX), y: Math.round(sourceY), button: 'left', clickCount: 1
    });
    await this._sleep(150 + Math.random() * 100);

    // 3. Move attention and mouse to target (slower speed for dragging)
    this.attention.shiftFocus(targetRect);
    await this._sleep(100 + Math.random() * 200);

    const targetX = targetRect.x + targetRect.width * (0.4 + Math.random() * 0.2);
    const targetY = targetRect.y + targetRect.height * (0.4 + Math.random() * 0.2);
    
    const dragMods = {
      speedMultiplier: stateMods.speedMultiplier * 0.7, 
      fatigue: stateMods.fatigue,
      precision: stateMods.precision
    };
    const pathToTarget = this.trajectory.generateTrajectory(targetX, targetY, targetRect.width, dragMods);
    await this._dispatchTrajectory(pathToTarget);

    // 4. Mouse UP (Drop)
    await this._sleep(50 + Math.random() * 100);
    await this._sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: Math.round(targetX), y: Math.round(targetY), button: 'left', clickCount: 1
    });

    this.state.onClick(); // Register physical interaction block
    this.state.onSuccess();
    return true;
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API — KEYBOARD ACTIONS
  // ═══════════════════════════════════════════════════════════

  /**
   * Type text with realistic keystroke dynamics.
   */
  async type(text, opts = {}) {
    if (!this._initialized) await this.init();

    // Focus the target if selector provided
    if (opts.selector) {
      await this.click(opts.selector);
      await this._sleep(100 + Math.random() * 200);
    }

    const commands = this.keyboard.generateKeystrokes(text);

    for (const cmd of commands) {
      if (cmd.action === 'wait') {
        // Scale delay by profile typing speed
        const scaledDelay = cmd.delay / this.profile.typingSpeed;
        await this._sleep(scaledDelay);
      } else {
        await this._sendCDP('Input.dispatchKeyEvent', cmd.params);
      }
    }

    this.state.onKeyPress(text.length);
  }

  /**
   * Press a single key (Enter, Tab, Escape, etc.).
   */
  async pressKey(key, code, vk) {
    if (!this._initialized) await this.init();

    await this._sendCDP('Input.dispatchKeyEvent', {
      type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk
    });
    await this._sleep(80 + Math.random() * 40);
    await this._sendCDP('Input.dispatchKeyEvent', {
      type: 'keyUp', key, code, windowsVirtualKeyCode: vk
    });
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API — SCROLL
  // ═══════════════════════════════════════════════════════════

  /**
   * Scroll the page with human-like behavior.
   * @param {number} deltaY - pixels to scroll (positive = down)
   */
  async scroll(deltaY, opts = {}) {
    if (!this._initialized) await this.init();

    // Break large scrolls into multiple wheel events
    const steps = Math.max(3, Math.ceil(Math.abs(deltaY) / 100));
    const stepSize = deltaY / steps;

    for (let i = 0; i < steps; i++) {
      const jitteredStep = stepSize * (0.8 + Math.random() * 0.4);
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: this.trajectory.currentX,
        y: this.trajectory.currentY,
        deltaX: 0,
        deltaY: Math.round(jitteredStep)
      });

      // Variable delay between scroll steps (50-150ms)
      await this._sleep(50 + Math.random() * 100);
    }

    this.state.onScroll();
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC API — COGNITIVE BEHAVIORS
  // ═══════════════════════════════════════════════════════════

  /**
   * Simulate reading a page — cursor idles, occasional micro-movements.
   * @param {number} durationMs - how long to "read"
   */
  async read(durationMs = 2000) {
    if (!this._initialized) await this.init();

    const startTime = Date.now();
    while (Date.now() - startTime < durationMs) {
      // Occasional idle cursor movement
      if (Math.random() < 0.3) {
        const gaze = this.attention.generateIdleGaze();
        const trajectory = this.trajectory.generateTrajectory(
          gaze.x, gaze.y, 100, { speedMultiplier: 0.3, fatigue: this.state.fatigue }
        );
        await this._dispatchTrajectory(trajectory);
      }
      await this._sleep(300 + Math.random() * 700);
    }
  }

  /**
   * Get current engine state for debugging.
   */
  getDebugState() {
    return {
      initialized: this._initialized,
      profile: this.profile ? {
        id: this.profile.id,
        speed: this.profile.baseMotorSpeed,
        precision: this.profile.motorPrecision,
        hardware: this.profile.hardware
      } : null,
      session: this.state ? this.state.snapshot() : null,
      cursor: { x: this.trajectory?.currentX, y: this.trajectory?.currentY }
    };
  }

  // ═══════════════════════════════════════════════════════════
  //  CDP DISPATCH (via chrome.runtime.sendMessage)
  // ═══════════════════════════════════════════════════════════

  /**
   * Dispatch a full trajectory through CDP mouseMoved events.
   */
  async _dispatchTrajectory(points) {
    for (const point of points) {
      await this._sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(point.x),
        y: Math.round(point.y)
      });

      // Use the delay from the trajectory point
      if (point.delay > 0) {
        await this._sleep(point.delay);
      }
    }
  }

  /**
   * Dispatch mousePressed → (hold) → mouseReleased.
   */
  async _dispatchClick(x, y, holdDuration) {
    const rx = Math.round(x);
    const ry = Math.round(y);

    await this._sendCDP('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rx, y: ry,
      button: 'left',
      clickCount: 1
    });

    await this._sleep(holdDuration);

    await this._sendCDP('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rx, y: ry,
      button: 'left',
      clickCount: 1
    });
  }

  /**
   * Send a CDP command via the service worker.
   */
  async _sendCDP(method, params) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'cdp_command',
        method: method,
        params: params
      }, (response) => {
        resolve(response);
      });
    });
  }

  /**
   * Perform an idle hover movement (cursor wanders to nearby element).
   */
  async _performIdleHover() {
    const gaze = this.attention.generateIdleGaze();
    const trajectory = this.trajectory.generateTrajectory(
      gaze.x, gaze.y, 100,
      { speedMultiplier: 0.5, fatigue: this.state.fatigue }
    );
    await this._dispatchTrajectory(trajectory);
    await this._sleep(200 + Math.random() * 400);
  }

  /**
   * Get element bounding rect from the DOM (Accepts string or HTMLElement).
   */
  async _getElementRect(selectorOrEl) {
    try {
      const el = typeof selectorOrEl === 'string' ? document.querySelector(selectorOrEl) : selectorOrEl;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: rect.x, y: rect.y,
        width: rect.width, height: rect.height
      };
    } catch (e) {
      return null;
    }
  }

  /**
   * Async sleep.
   */
  _sleep(ms) {
    return new Promise(r => setTimeout(r, Math.max(1, Math.round(ms))));
  }

  /**
   * Clean up when done.
   */
  destroy() {
    if (this._tickInterval) {
      clearInterval(this._tickInterval);
      this._tickInterval = null;
    }
    if (this.profile) {
      this.profile.evolve({ success: this.state?.errorCount === 0 });
    }
    this._initialized = false;
    console.log('[HumanEngine] Destroyed');
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(HumanEngine);
