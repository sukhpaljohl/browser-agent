/**
 * AttentionField — Spatial Attention Model
 * 
 * Simulates how humans actually perceive and attend to elements
 * on a screen. Not everything is equally visible — attention
 * follows a Gaussian distribution centered on the viewport center,
 * with visual salience (color, size, motion) modifying element weight.
 * 
 * This affects:
 *   - Whether elements are "noticed" at all
 *   - How long it takes to "find" a target
 *   - Whether the user hovers over distractors
 *   - Gaze-aversion patterns (not staring at one spot)
 */
class AttentionField {
  constructor() {
    // Attention center starts at viewport center
    this.focusX = (typeof window !== 'undefined' ? window.innerWidth : 1920) / 2;
    this.focusY = (typeof window !== 'undefined' ? window.innerHeight : 1080) / 2;

    // Attention radius — standard deviation of Gaussian falloff (pixels)
    this.focusRadius = 350;

    // Elements that have been "noticed" (cached)
    this._noticedElements = new Set();

    // Last few gaze targets (for saccade simulation)
    this._gazeHistory = [];
  }

  /**
   * Get the attention weight for an element based on its position.
   * Returns 0-1 where 1 = full attention, 0 = unnoticed.
   */
  getAttentionWeight(rect) {
    if (!rect) return 0;

    const elemCenterX = rect.x + rect.width / 2;
    const elemCenterY = rect.y + rect.height / 2;

    // Distance from attention focus
    const dx = elemCenterX - this.focusX;
    const dy = elemCenterY - this.focusY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Gaussian falloff
    const spatial = Math.exp(-(distance * distance) / (2 * this.focusRadius * this.focusRadius));

    // Size salience: larger elements are more noticeable
    const area = rect.width * rect.height;
    const sizeFactor = Math.min(1, 0.3 + area / 20000);

    // Combine factors
    return Math.min(1, spatial * sizeFactor);
  }

  /**
   * Calculate time needed to "find" an element.
   * Simulates visual search — elements at periphery take longer to find.
   * 
   * @returns {number} milliseconds of "search time"
   */
  getSearchTime(rect) {
    const weight = this.getAttentionWeight(rect);

    // High attention weight = found quickly (100-200ms)
    // Low attention weight = needs visual search (300-800ms)
    const baseTime = 100 + (1 - weight) * 500;

    // Add random variation
    return Math.round(baseTime + Math.random() * 100);
  }

  /**
   * Shift attention focus toward a new element.
   * Simulates saccadic eye movement.
   */
  shiftFocus(targetRect) {
    if (!targetRect) return;

    const targetX = targetRect.x + targetRect.width / 2;
    const targetY = targetRect.y + targetRect.height / 2;

    // Don't snap instantly — smooth transition
    this.focusX = this.focusX * 0.3 + targetX * 0.7;
    this.focusY = this.focusY * 0.3 + targetY * 0.7;

    // Track gaze history
    this._gazeHistory.push({ x: targetX, y: targetY, t: Date.now() });
    if (this._gazeHistory.length > 10) this._gazeHistory.shift();
  }

  /**
   * Determine if the user should "almost interact" — hover without clicking.
   * Happens when attention drifts to a nearby element.
   * 
   * @param {number} distanceToTarget - distance from current cursor to target
   * @returns {boolean}
   */
  shouldHoverWithoutClick(distanceToTarget) {
    // More likely when cursor is far from target (exploring)
    const explorationProb = Math.min(0.12, 0.02 + distanceToTarget / 5000);
    return Math.random() < explorationProb;
  }

  /**
   * Generate "idle gaze" movement — where the cursor drifts when
   * the user is reading or thinking (not targeting anything specific).
   * 
   * @returns {{ x: number, y: number, duration: number }}
   */
  generateIdleGaze() {
    // Random point near current focus (within 200px)
    const angle = Math.random() * Math.PI * 2;
    const radius = 50 + Math.random() * 150;

    return {
      x: this.focusX + Math.cos(angle) * radius,
      y: this.focusY + Math.sin(angle) * radius,
      duration: 500 + Math.random() * 2000
    };
  }

  /**
   * Simulate reading behavior — brief pauses at text elements.
   * @param {number} textLength - approximate text content length
   * @returns {number} reading time in ms
   */
  getReadingTime(textLength) {
    // Average reading speed: ~250 words/min = ~4 words/sec
    // ~5 chars/word → ~20 chars/sec
    const wordsEstimate = textLength / 5;
    const readingMs = (wordsEstimate / 4) * 1000;

    // Humans don't read everything — scan with diminishing returns
    const scanFactor = Math.min(1, 0.3 + 0.7 / (1 + textLength / 200));
    return Math.round(readingMs * scanFactor + Math.random() * 200);
  }

  /**
   * Check if an element is within the current field of view.
   */
  isInView(rect) {
    if (!rect) return false;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1920;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 1080;
    return rect.x < vw && rect.x + rect.width > 0 && rect.y < vh && rect.y + rect.height > 0;
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(AttentionField);
