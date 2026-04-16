/**
 * MotorModel — Statistical Motor Model
 * 
 * Loads the dataset-extracted motor fingerprint and provides
 * sampling functions that draw from real human distributions.
 * 
 * All distributions are calibrated from CaptchaSolve30k (10,505
 * real movements from 874 sessions at 240Hz).
 */
class MotorModel {
  constructor(fingerprint) {
    this.fp = fingerprint;
    this._cache = {};
    console.log(`[MotorModel] Loaded: ${fingerprint._meta.total_movements} movements from ${fingerprint._meta.sessions_analyzed} sessions`);
  }

  // ═══════════════════════════════════════════════════════════
  //  DISTRIBUTION SAMPLING
  //  Draws from fitted distributions (lognormal, gamma, normal)
  //  using the parameters extracted from real human data.
  // ═══════════════════════════════════════════════════════════

  /**
   * Sample from a fitted distribution object.
   * Supports: lognormal, gamma, normal (with percentile fallback).
   */
  _sampleDistribution(dist) {
    if (!dist || !dist.mean) return 0;

    const type = dist.distribution || 'normal';
    const params = dist.fit_params;

    try {
      if (type === 'lognormal' && params && params.length >= 3) {
        // scipy lognorm params: (shape, loc, scale)
        const shape = params[0];
        const loc = params[1];
        const scale = params[2];
        return loc + scale * Math.exp(shape * this._normalRandom());
      }

      if (type === 'gamma' && params && params.length >= 3) {
        // scipy gamma params: (a, loc, scale)
        return this._gammaRandom(params[0]) * params[2] + params[1];
      }
    } catch (e) {
      // Fall through to normal sampling
    }

    // Normal distribution fallback (always works)
    return dist.mean + dist.std * this._normalRandom();
  }

  /**
   * Sample from distribution, clamped to [min, max] percentile range.
   */
  _sampleClamped(dist, minPercentile = 'p5', maxPercentile = 'p95') {
    const value = this._sampleDistribution(dist);
    const lo = dist[minPercentile] ?? (dist.mean - 2 * dist.std);
    const hi = dist[maxPercentile] ?? (dist.mean + 2 * dist.std);
    return Math.max(lo, Math.min(hi, value));
  }

  // ═══════════════════════════════════════════════════════════
  //  PUBLIC SAMPLING API
  // ═══════════════════════════════════════════════════════════

  /**
   * Sample peak velocity for a movement of given distance.
   * Returns velocity in grid-units per ms (200x200 grid).
   * Scales from dataset coordinate space to screen pixels at runtime.
   */
  samplePeakVelocity() {
    return Math.abs(this._sampleClamped(this.fp.velocity.peak));
  }

  /**
   * Sample movement duration using Fitts' Law + noise.
   * @param {number} distance - movement distance in pixels
   * @param {number} targetWidth - target element width in pixels (default 40)
   * @returns {number} duration in ms
   */
  sampleDuration(distance, targetWidth = 40) {
    const fl = this.fp.fittsLaw;

    // Fitts' Law: MT = a + b × log₂(1 + D/W)
    const id = Math.log2(1 + distance / Math.max(targetWidth, 10));
    let mt = fl.a + fl.b * id;

    // Add Gaussian noise (±15% of predicted duration)
    mt += mt * 0.15 * this._normalRandom();

    // Clamp to reasonable range
    return Math.max(80, Math.min(3000, mt));
  }

  /**
   * Sample the velocity profile shape parameters.
   * Returns fraction of movement time at which peak velocity occurs,
   * and the deceleration/acceleration asymmetry ratio.
   */
  sampleVelocityProfile() {
    const ttp = this._sampleClamped(this.fp.velocityProfile.time_to_peak_fraction);
    const asym = this._sampleClamped(this.fp.velocityProfile.asymmetry);
    return {
      timeToPeakFraction: Math.max(0.15, Math.min(0.6, ttp)),
      asymmetry: Math.max(1.0, Math.min(5.0, asym))
    };
  }

  /**
   * Sample whether this movement overshoots, and by how much.
   * @param {number} distance - movement distance
   * @returns {{ willOvershoot: boolean, magnitude: number }}
   */
  sampleOvershoot(distance) {
    const prob = this.fp.overshoot.probability || 0.094;
    const willOvershoot = Math.random() < prob;

    if (!willOvershoot) return { willOvershoot: false, magnitude: 0 };

    const magDist = this.fp.overshoot.magnitude;
    // Scale overshoot magnitude proportional to distance
    const baseMag = magDist.mean || 3.0;
    const mag = Math.abs(baseMag + (magDist.std || 1.5) * this._normalRandom());
    // Convert from grid units (200x200) to fraction of distance
    const fraction = (mag / 200) * (distance / 100);

    return {
      willOvershoot: true,
      magnitude: Math.max(2, Math.min(distance * 0.15, fraction * distance))
    };
  }

  /**
   * Sample path curvature (perpendicular deviation from straight line).
   * Returns curvature as a fraction of movement distance to use
   * as Bézier control point offset.
   */
  sampleCurvature() {
    // Path efficiency from dataset: mean 0.843, meaning ~16% deviation
    const efficiency = this._sampleClamped(this.fp.pathEfficiency);
    // Convert efficiency to curvature offset
    // efficiency = 1.0 = perfectly straight, 0.5 = very curved
    const curvatureOffset = (1 - efficiency) * 0.5;
    // Random direction (positive or negative perpendicular)
    const sign = Math.random() > 0.5 ? 1 : -1;
    return sign * Math.max(0, curvatureOffset + 0.02 * this._normalRandom());
  }

  /**
   * Sample number of submovements (ballistic + corrective phases).
   * For short movements: typically 1-2
   * For long movements: 2-4
   */
  sampleSubmovementCount(distance) {
    if (distance < 50) return 1;
    if (distance < 150) return Math.random() < 0.6 ? 1 : 2;
    if (distance < 400) return Math.random() < 0.4 ? 2 : (Math.random() < 0.5 ? 1 : 3);
    return Math.random() < 0.3 ? 2 : 3;
  }

  /**
   * Sample jitter amplitude for micro-tremor noise.
   * @param {number} fatigue - fatigue level 0-1 (amplifies tremor)
   * @returns {number} jitter amplitude in pixels
   */
  sampleJitter(fatigue = 0) {
    const baseAmp = this.fp.jitter.amplitude.mean || 0.3;
    const amp = Math.abs(baseAmp + (this.fp.jitter.amplitude.std || 0.1) * this._normalRandom());
    // Fatigue increases tremor by up to 50%
    return amp * (1 + fatigue * 0.5);
  }

  /**
   * Sample click hold duration (mouseDown → mouseUp).
   * @returns {number} duration in ms
   */
  sampleClickHold() {
    const hold = this.fp.clickTiming.hold_duration;
    // The dataset has long holds due to drag operations
    // For normal clicks, cap at reasonable values
    const raw = Math.abs(hold.mean + hold.std * this._normalRandom());
    return Math.max(50, Math.min(200, raw * 0.05)); // Scale down from drag-heavy data
  }

  /**
   * Sample pre-click hesitation pause.
   * @returns {number} pause duration in ms
   */
  samplePreClickPause() {
    // Small pause before committing to click (30-120ms)
    return 30 + Math.abs(this._normalRandom() * 30);
  }

  // ═══════════════════════════════════════════════════════════
  //  RANDOM NUMBER GENERATORS
  // ═══════════════════════════════════════════════════════════

  /**
   * Box-Muller transform for normal distribution sampling.
   */
  _normalRandom() {
    let u1, u2;
    do { u1 = Math.random(); } while (u1 === 0);
    u2 = Math.random();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Gamma distribution sampling (Marsaglia & Tsang's method).
   */
  _gammaRandom(shape) {
    if (shape < 1) {
      return this._gammaRandom(shape + 1) * Math.pow(Math.random(), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    while (true) {
      let x, v;
      do {
        x = this._normalRandom();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = Math.random();
      if (u < 1 - 0.0331 * (x * x) * (x * x)) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(MotorModel);
