/**
 * SessionState — Dynamic Cognitive State Layer
 * 
 * Tracks the evolving internal state of the simulated user during
 * a single browsing session. All behavior is derived from this state,
 * not from random noise — ensuring consistency and realism.
 * 
 * States:
 *   - fatigue: 0→1 (increases over time, faster after 30min)
 *   - confidence: 0→1 (increases with successful interactions)
 *   - frustration: 0→1 (increases with failures/slow responses)
 *   - cognitiveLoad: 0→1 (high during complex tasks)
 *   - arousal: 0→1 (attention/alertness level)
 */
class SessionState {
  /**
   * @param {UserProfile} profile - persistent user profile
   */
  constructor(profile) {
    this.profile = profile;
    this.startTime = Date.now();
    this.lastActionTime = Date.now();

    // Core states
    this.fatigue = 0;
    this.confidence = 0.5;
    this.frustration = 0;
    this.cognitiveLoad = 0.3;
    this.arousal = 0.7;  // starts alert

    // Interaction counters
    this.clickCount = 0;
    this.keyPressCount = 0;
    this.scrollCount = 0;
    this.errorCount = 0;
    this.successCount = 0;
    this.idleTimeMs = 0;

    // Tick tracking
    this._lastTickTime = Date.now();
  }

  /**
   * Advance session state by elapsed time.
   * Call this periodically (~every 500ms) to update internal states.
   */
  tick() {
    const now = Date.now();
    const elapsedMs = now - this._lastTickTime;
    this._lastTickTime = now;

    const sessionAgeMs = now - this.startTime;
    const sessionAgeMin = sessionAgeMs / 60000;
    const idleSinceLastAction = now - this.lastActionTime;

    // ─── FATIGUE ───
    // Baseline accumulation: faster with user's fatigue rate
    const fatigueDelta = (this.profile.fatigueRate * elapsedMs) / 3600000;
    this.fatigue = Math.min(1, this.fatigue + fatigueDelta);
    // Accelerate after 30 minutes
    if (sessionAgeMin > 30) {
      this.fatigue = Math.min(1, this.fatigue + fatigueDelta * 0.5);
    }
    // Brief rest during idle periods reduces fatigue slightly
    if (idleSinceLastAction > 10000) { // 10 seconds idle
      this.fatigue = Math.max(0, this.fatigue - 0.001);
    }

    // ─── AROUSAL ───
    // Decays during monotonous activity, recovers after breaks
    if (idleSinceLastAction > 5000) {
      // Becoming disengaged during idle
      this.arousal = Math.max(0.2, this.arousal - 0.002);
    } else {
      // Active use maintains arousal
      this.arousal = Math.min(0.9, this.arousal + 0.0005);
    }
    // Fatigue suppresses arousal
    this.arousal = Math.max(0.2, this.arousal - this.fatigue * 0.001);

    // ─── FRUSTRATION ───
    // Decays naturally over time
    this.frustration = Math.max(0, this.frustration - elapsedMs * 0.00002);

    // ─── COGNITIVE LOAD ───
    // Decays toward baseline during idle
    if (idleSinceLastAction > 3000) {
      this.cognitiveLoad = Math.max(0.1, this.cognitiveLoad - 0.005);
    }
  }

  /**
   * Record a successful interaction.
   */
  onSuccess() {
    this.successCount++;
    this.lastActionTime = Date.now();
    this.confidence = Math.min(1, this.confidence + 0.05);
    this.frustration = Math.max(0, this.frustration - 0.03);
    this.cognitiveLoad = Math.max(0.1, this.cognitiveLoad - 0.02);
    this.arousal = Math.min(0.9, this.arousal + 0.02);
  }

  /**
   * Record a failed interaction (element not found, timeout, etc.).
   */
  onError() {
    this.errorCount++;
    this.lastActionTime = Date.now();
    this.frustration = Math.min(1, this.frustration + 0.1);
    this.confidence = Math.max(0, this.confidence - 0.08);
    this.cognitiveLoad = Math.min(1, this.cognitiveLoad + 0.1);
  }

  /**
   * Record a click.
   */
  onClick() {
    this.clickCount++;
    this.lastActionTime = Date.now();
    this.cognitiveLoad = Math.min(1, this.cognitiveLoad + 0.01);
  }

  /**
   * Record typing activity.
   */
  onKeyPress(count = 1) {
    this.keyPressCount += count;
    this.lastActionTime = Date.now();
  }

  /**
   * Record scrolling.
   */
  onScroll() {
    this.scrollCount++;
    this.lastActionTime = Date.now();
    this.cognitiveLoad = Math.min(1, this.cognitiveLoad + 0.005);
  }

  /**
   * Get motor modifiers derived from current state.
   * These adjust the trajectory generator and keystroke engine.
   */
  getMotorModifiers() {
    return {
      // Fatigue slows everything
      speedMultiplier: 1.0 - (this.fatigue * 0.3),
      // Tremor increases with fatigue
      tremorAmplitude: 1.0 + (this.fatigue * 0.5),
      // Less precise when tired or frustrated
      precision: 1.0 - (this.fatigue * 0.2) - (this.frustration * 0.1),
      // Hesitate more when uncertain
      hesitationDelay: this.confidence < 0.3 ? 1.5 : (this.confidence < 0.5 ? 1.2 : 1.0),
      // Type slower when tired
      typingSpeed: 1.0 - (this.fatigue * 0.25),
      // Current fatigue for jitter sampling
      fatigue: this.fatigue,
      // Frustration may cause impulsive, faster clicks
      impulsivity: this.frustration > 0.7 ? 1.3 : 1.0
    };
  }

  /**
   * Get human-like micro-delays based on current state.
   */
  getReactionTime() {
    // Base reaction time: 200-400ms
    let rt = 250 + 80 * this._normalRandom();

    // Fatigue increases reaction time
    rt *= (1 + this.fatigue * 0.5);

    // High arousal decreases it
    rt *= (1.3 - this.arousal * 0.3);

    // Cognitive load increases it
    rt *= (1 + this.cognitiveLoad * 0.3);

    return Math.max(100, Math.min(800, Math.round(rt)));
  }

  /**
   * Should the agent take a micro-break? (look away, scroll aimlessly)
   */
  shouldMicroBreak() {
    if (this.fatigue > 0.6 && Math.random() < 0.03) return true;
    if (this.frustration > 0.7 && Math.random() < 0.05) return true;
    return false;
  }

  /**
   * Should the agent give up / abandon current task?
   */
  shouldAbandon() {
    if (this.frustration > 0.9 && this.confidence < 0.2) return Math.random() < 0.1;
    return false;
  }

  /**
   * Get a snapshot for debugging.
   */
  snapshot() {
    const age = Date.now() - this.startTime;
    return {
      session_age_min: Math.round(age / 60000 * 10) / 10,
      fatigue: Math.round(this.fatigue * 100) / 100,
      confidence: Math.round(this.confidence * 100) / 100,
      frustration: Math.round(this.frustration * 100) / 100,
      cognitiveLoad: Math.round(this.cognitiveLoad * 100) / 100,
      arousal: Math.round(this.arousal * 100) / 100,
      interactions: {
        clicks: this.clickCount,
        keys: this.keyPressCount,
        scrolls: this.scrollCount,
        errors: this.errorCount,
        successes: this.successCount
      }
    };
  }

  _normalRandom() {
    let u1, u2;
    do { u1 = Math.random(); } while (u1 === 0);
    u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(SessionState);
