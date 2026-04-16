/**
 * UserProfile — Persistent Identity Layer
 * 
 * Each simulated user has a stable "motor personality" that persists
 * across sessions. Properties drift slowly over time but remain
 * consistent within a session, creating a coherent behavioral signature.
 * 
 * Stored in localStorage to survive extension reloads.
 */
class UserProfile {
  constructor() {
    this._storageKey = '__human_engine_profile';
    const saved = this._load();

    if (saved && saved.id) {
      // Restore existing profile
      Object.assign(this, saved);
      // Apply slight session-to-session drift
      this._drift();
      console.log(`[UserProfile] Restored profile ${this.id.slice(0, 8)}`);
    } else {
      // Generate new profile
      this._generate();
      console.log(`[UserProfile] Generated new profile ${this.id.slice(0, 8)}`);
    }

    this._save();
  }

  /**
   * Generate a new random user profile.
   * All traits are sampled from realistic distributions.
   */
  _generate() {
    this.id = this._uuid();
    this.createdAt = Date.now();
    this.sessionCount = 0;

    // Motor traits (relative to dataset mean = 1.0)
    this.baseMotorSpeed = this._sampleTrait(0.7, 1.3);      // movement speed
    this.motorPrecision = this._sampleTrait(0.6, 1.0);      // targeting accuracy
    this.hesitationLevel = this._sampleTrait(0.0, 0.4);      // pre-action delay
    this.patience = this._sampleTrait(0.4, 0.9);             // tolerance for slow loading
    this.explorationBias = this._sampleTrait(0.1, 0.5);      // tendency to move cursor without purpose
    this.fatigueRate = this._sampleTrait(0.3, 0.8);          // how fast they get tired
    this.typingSpeed = this._sampleTrait(0.7, 1.4);          // WPM relative to average

    // Hardware profile (determines DPI grid, polling rate)
    this.hardware = {
      dpi: this._randomChoice([800, 1000, 1200, 1600]),
      pollingRate: this._randomChoice([125, 500, 1000]),
      acceleration: this._sampleTrait(0.8, 1.2),             // OS mouse acceleration
      screenWidth: screen.width || 1920,
      screenHeight: screen.height || 1080
    };

    // Behavioral personality
    this.readingSpeed = this._sampleTrait(200, 400);         // ms per "paragraph scan"
    this.scrollStyle = this._randomChoice(['smooth', 'chunky', 'mouse-wheel']); // how they scroll
    this.clickStyle = this._randomChoice(['decisive', 'cautious', 'exploratory']);
  }

  /**
   * Apply slight drift between sessions.
   * Simulates day-to-day variation in motor performance.
   */
  _drift() {
    this.sessionCount = (this.sessionCount || 0) + 1;

    // Tiny random walk on motor traits (±2% per session)
    const drift = 0.02;
    this.baseMotorSpeed = this._clamp(this.baseMotorSpeed + this._normalRandom() * drift, 0.5, 1.5);
    this.motorPrecision = this._clamp(this.motorPrecision + this._normalRandom() * drift, 0.4, 1.0);
    this.hesitationLevel = this._clamp(this.hesitationLevel + this._normalRandom() * drift * 0.5, 0.0, 0.6);
  }

  /**
   * Get motor modifiers derived from this profile.
   * Used by TrajectoryGenerator and KeystrokeEngine.
   */
  getMotorModifiers() {
    return {
      speedMultiplier: this.baseMotorSpeed,
      precisionMultiplier: this.motorPrecision,
      hesitationMultiplier: 1 + this.hesitationLevel,
      typingSpeedMultiplier: this.typingSpeed,
      explorationProbability: this.explorationBias
    };
  }

  /**
   * Evolve the profile based on session outcome.
   * Familiarity with a site increases over repeated visits.
   */
  evolve(outcome) {
    if (outcome.success) {
      // Increase confidence slightly
      this.hesitationLevel = Math.max(0, this.hesitationLevel - 0.01);
      this.baseMotorSpeed = Math.min(1.4, this.baseMotorSpeed + 0.005);
    } else {
      // Increase hesitation
      this.hesitationLevel = Math.min(0.5, this.hesitationLevel + 0.02);
    }
    this._save();
  }

  // ═══════════════════════════════════════════════════════════
  //  PERSISTENCE
  // ═══════════════════════════════════════════════════════════

  _save() {
    try {
      const data = {};
      for (const key of Object.keys(this)) {
        if (!key.startsWith('_')) data[key] = this[key];
      }
      localStorage.setItem(this._storageKey, JSON.stringify(data));
    } catch (e) {
      // localStorage may not be available in content scripts
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(this._storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  UTILITIES
  // ═══════════════════════════════════════════════════════════

  _sampleTrait(min, max) {
    // Beta-like distribution (peaks near center of range)
    const u1 = Math.random();
    const u2 = Math.random();
    const beta = (u1 + u2) / 2; // Triangular-ish
    return min + beta * (max - min);
  }

  _randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  _normalRandom() {
    let u1, u2;
    do { u1 = Math.random(); } while (u1 === 0);
    u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  _clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
  }

  _uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(UserProfile);
