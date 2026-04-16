/**
 * TrajectoryGenerator — Human-Like Mouse Path Generation
 * 
 * Generates mouse trajectories that are statistically indistinguishable
 * from real human movements. Combines:
 *   1. Bézier curve paths with dataset-calibrated curvature
 *   2. Asymmetric velocity profiles (peak at ~38% of movement)
 *   3. Submovement decomposition (ballistic + corrective phases)
 *   4. Overshoot-and-correct behavior (9.4% probability)
 *   5. Micro-jitter/tremor noise (dataset-calibrated amplitude)
 *   6. Hardware simulation (DPI quantization, polling rate)
 * 
 * Output: Array of {x, y, timestamp} events ready for CDP dispatch.
 */
class TrajectoryGenerator {
  /**
   * @param {MotorModel} model - calibrated motor model
   * @param {object} [hardware] - hardware simulation params
   */
  constructor(model, hardware = {}) {
    this.model = model;
    this.hardware = {
      dpi: hardware.dpi || 1000,
      pollingRate: hardware.pollingRate || 125, // Hz (events per second)
      acceleration: hardware.acceleration || 1.0,
      ...hardware
    };

    // Current simulated cursor position
    this.currentX = 0;
    this.currentY = 0;

    // Perlin noise state for drift
    this._noisePhase = Math.random() * 1000;
  }

  /**
   * Update current cursor position (call when position is known).
   */
  setPosition(x, y) {
    this.currentX = x;
    this.currentY = y;
  }

  /**
   * Generate a complete trajectory from current position to target.
   * 
   * @param {number} targetX - target X in viewport pixels
   * @param {number} targetY - target Y in viewport pixels
   * @param {number} [targetWidth=40] - target element width
   * @param {object} [state] - session state modifiers
   * @returns {Array<{x: number, y: number, t: number, delay: number}>}
   */
  generateTrajectory(targetX, targetY, targetWidth = 40, state = {}) {
    const startX = this.currentX;
    const startY = this.currentY;
    const distance = Math.hypot(targetX - startX, targetY - startY);

    // Very short distance — just micro-adjust
    if (distance < 3) {
      return this._microAdjust(startX, startY, targetX, targetY);
    }

    // Sample movement parameters from motor model
    const duration = this.model.sampleDuration(distance, targetWidth);
    const profile = this.model.sampleVelocityProfile();
    const curvature = this.model.sampleCurvature();
    const overshoot = this.model.sampleOvershoot(distance);
    const submoveCount = this.model.sampleSubmovementCount(distance);
    const jitterAmp = this.model.sampleJitter(state.fatigue || 0);

    // Speed modifier from state
    const speedMod = state.speedMultiplier || 1.0;
    const adjustedDuration = duration / speedMod;

    // Generate the primary ballistic trajectory
    let points = this._generateBezierPath(
      startX, startY, targetX, targetY,
      adjustedDuration, profile, curvature
    );

    // Add overshoot-and-correct if sampled
    if (overshoot.willOvershoot && distance > 30) {
      points = this._addOvershoot(points, targetX, targetY, overshoot.magnitude, profile);
    }

    // Add corrective submovements
    if (submoveCount > 1 && distance > 50) {
      points = this._addSubmovements(points, targetX, targetY, submoveCount - 1, profile);
    }

    // Apply noise layers
    points = this._applyJitter(points, jitterAmp);
    points = this._applyDrift(points);

    // Hardware simulation: quantize to polling rate
    points = this._quantizeToPollingRate(points);

    // Update current position
    if (points.length > 0) {
      const last = points[points.length - 1];
      this.currentX = last.x;
      this.currentY = last.y;
    }

    return points;
  }

  // ═══════════════════════════════════════════════════════════
  //  BÉZIER PATH GENERATION
  //  Cubic Bézier with control points offset perpendicular
  //  to the straight line by dataset-calibrated curvature.
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate a cubic Bézier path between two points.
   * Points are sampled at ~120 points/second for smooth dispatch.
   */
  _generateBezierPath(x0, y0, x1, y1, duration, profile, curvature) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const dist = Math.hypot(dx, dy);

    // Perpendicular direction for curvature offset
    const perpX = -dy / dist;
    const perpY = dx / dist;

    // Control point offsets (curvature applied perpendicular to movement)
    const offset1 = curvature * dist * (0.8 + 0.4 * Math.random());
    const offset2 = curvature * dist * (0.5 + 0.3 * Math.random()) * (Math.random() > 0.3 ? 1 : -0.5);

    // Cubic Bézier control points
    const cp1x = x0 + dx * 0.3 + perpX * offset1;
    const cp1y = y0 + dy * 0.3 + perpY * offset1;
    const cp2x = x0 + dx * 0.7 + perpX * offset2;
    const cp2y = y0 + dy * 0.7 + perpY * offset2;

    // Number of samples: ~120 points/sec
    const numSamples = Math.max(10, Math.ceil(duration / 8));
    const points = [];

    for (let i = 0; i <= numSamples; i++) {
      const tLinear = i / numSamples;

      // Apply velocity profile: remap linear t to velocity-shaped t
      const tShaped = this._applyVelocityProfile(tLinear, profile);

      // Cubic Bézier interpolation
      const t = tShaped;
      const mt = 1 - t;
      const x = mt*mt*mt*x0 + 3*mt*mt*t*cp1x + 3*mt*t*t*cp2x + t*t*t*x1;
      const y = mt*mt*mt*y0 + 3*mt*mt*t*cp1y + 3*mt*t*t*cp2y + t*t*t*y1;

      const timestamp = tLinear * duration;
      const delay = i === 0 ? 0 : (duration / numSamples);

      points.push({
        x: Math.round(x * 10) / 10,
        y: Math.round(y * 10) / 10,
        t: timestamp,
        delay: Math.max(1, Math.round(delay + (Math.random() - 0.5) * 3))
      });
    }

    return points;
  }

  /**
   * Apply asymmetric velocity profile to parametric t.
   * Real humans reach peak velocity at ~38% of movement time,
   * with deceleration ~2.5x longer than acceleration.
   */
  _applyVelocityProfile(tLinear, profile) {
    const ttp = profile.timeToPeakFraction;

    // Piecewise mapping: accelerate fast, decelerate slow
    if (tLinear <= ttp) {
      // Acceleration phase: quadratic ease-in
      const localT = tLinear / ttp;
      return localT * localT * ttp;
    } else {
      // Deceleration phase: power curve ease-out
      const localT = (tLinear - ttp) / (1 - ttp);
      const decelPower = 1 + (profile.asymmetry - 1) * 0.3; // soften the asymmetry
      return ttp + (1 - ttp) * (1 - Math.pow(1 - localT, decelPower));
    }
  }

  // ═══════════════════════════════════════════════════════════
  //  OVERSHOOT & CORRECTION
  // ═══════════════════════════════════════════════════════════

  /**
   * Add overshoot past the target, then a corrective movement back.
   */
  _addOvershoot(points, targetX, targetY, magnitude, profile) {
    if (points.length < 5) return points;

    const last = points[points.length - 1];
    const secondLast = points[Math.max(0, points.length - 5)];

    // Direction of approach
    const approachDx = last.x - secondLast.x;
    const approachDy = last.y - secondLast.y;
    const approachDist = Math.hypot(approachDx, approachDy);

    if (approachDist < 0.1) return points;

    // Overshoot point — extend past target along approach direction
    const normDx = approachDx / approachDist;
    const normDy = approachDy / approachDist;
    const overshootX = targetX + normDx * magnitude;
    const overshootY = targetY + normDy * magnitude;

    // Modify last few points to curve toward overshoot
    const modifyCount = Math.min(5, Math.floor(points.length * 0.15));
    for (let i = 0; i < modifyCount; i++) {
      const idx = points.length - modifyCount + i;
      const blend = (i + 1) / modifyCount;
      points[idx].x = points[idx].x + (overshootX - targetX) * blend * 0.6;
      points[idx].y = points[idx].y + (overshootY - targetY) * blend * 0.6;
    }

    // Add correction movement back to target
    const correctionDuration = 80 + Math.random() * 100; // 80-180ms
    const correctionSteps = Math.max(5, Math.ceil(correctionDuration / 12));
    const lastTime = points[points.length - 1].t;

    for (let i = 1; i <= correctionSteps; i++) {
      const t = i / correctionSteps;
      // Ease-out for correction (slow approach to target)
      const eased = 1 - Math.pow(1 - t, 2.5);

      points.push({
        x: Math.round((overshootX + (targetX - overshootX) * eased) * 10) / 10,
        y: Math.round((overshootY + (targetY - overshootY) * eased) * 10) / 10,
        t: lastTime + t * correctionDuration,
        delay: Math.max(1, Math.round(correctionDuration / correctionSteps + (Math.random() - 0.5) * 4))
      });
    }

    return points;
  }

  /**
   * Add corrective submovements for fine targeting.
   */
  _addSubmovements(points, targetX, targetY, count, profile) {
    const last = points[points.length - 1];
    let currentX = last.x;
    let currentY = last.y;
    let currentT = last.t;

    for (let s = 0; s < count; s++) {
      // Small pause between submovements (20-80ms)
      const pauseDuration = 20 + Math.random() * 60;
      currentT += pauseDuration;

      // Add a pause point
      points.push({
        x: currentX, y: currentY,
        t: currentT,
        delay: Math.round(pauseDuration)
      });

      // Error from target
      const errorX = targetX - currentX;
      const errorY = targetY - currentY;
      const errorDist = Math.hypot(errorX, errorY);

      if (errorDist < 1) break;

      // Corrective movement: 70-90% of remaining error
      const correction = 0.7 + Math.random() * 0.2;
      const newX = currentX + errorX * correction;
      const newY = currentY + errorY * correction;

      // Duration proportional to error distance
      const subDuration = 30 + errorDist * 2 + Math.random() * 40;
      const subSteps = Math.max(3, Math.ceil(subDuration / 12));

      for (let i = 1; i <= subSteps; i++) {
        const t = i / subSteps;
        const eased = 1 - Math.pow(1 - t, 2);

        const px = currentX + (newX - currentX) * eased;
        const py = currentY + (newY - currentY) * eased;

        currentT += subDuration / subSteps;
        points.push({
          x: Math.round(px * 10) / 10,
          y: Math.round(py * 10) / 10,
          t: currentT,
          delay: Math.max(1, Math.round(subDuration / subSteps))
        });
      }

      currentX = newX;
      currentY = newY;
    }

    return points;
  }

  // ═══════════════════════════════════════════════════════════
  //  NOISE LAYERS
  // ═══════════════════════════════════════════════════════════

  /**
   * Apply micro-jitter (involuntary hand tremor) to all points.
   * Frequency: 5-12 Hz, amplitude from dataset calibration.
   */
  _applyJitter(points, amplitude) {
    if (amplitude < 0.01) return points;

    const freqHz = 7 + Math.random() * 5; // 7-12 Hz tremor
    const phaseX = Math.random() * Math.PI * 2;
    const phaseY = Math.random() * Math.PI * 2;

    for (const p of points) {
      const tSec = p.t / 1000;
      // Sinusoidal tremor + random noise
      const jitterX = amplitude * Math.sin(2 * Math.PI * freqHz * tSec + phaseX)
                     + (Math.random() - 0.5) * amplitude * 0.5;
      const jitterY = amplitude * Math.sin(2 * Math.PI * freqHz * tSec + phaseY + 1.2)
                     + (Math.random() - 0.5) * amplitude * 0.5;

      p.x = Math.round((p.x + jitterX) * 10) / 10;
      p.y = Math.round((p.y + jitterY) * 10) / 10;
    }

    return points;
  }

  /**
   * Apply low-frequency drift (2-4 Hz wandering).
   * Simulates the natural instability of the arm/wrist.
   */
  _applyDrift(points) {
    const driftFreq = 2 + Math.random() * 2; // 2-4 Hz
    const driftAmp = 0.3 + Math.random() * 0.5;
    const phaseX = this._noisePhase;
    const phaseY = this._noisePhase + 2.7;

    for (const p of points) {
      const tSec = p.t / 1000;
      p.x += driftAmp * Math.sin(2 * Math.PI * driftFreq * tSec + phaseX);
      p.y += driftAmp * Math.sin(2 * Math.PI * driftFreq * tSec * 0.8 + phaseY);
      p.x = Math.round(p.x * 10) / 10;
      p.y = Math.round(p.y * 10) / 10;
    }

    // Advance noise phase for next trajectory
    this._noisePhase += 3.14 + Math.random();

    return points;
  }

  // ═══════════════════════════════════════════════════════════
  //  HARDWARE SIMULATION
  // ═══════════════════════════════════════════════════════════

  /**
   * Quantize trajectory to realistic polling rate.
   * Real mice report at 125/500/1000 Hz — we subsample.
   */
  _quantizeToPollingRate(points) {
    if (points.length < 3) return points;

    const intervalMs = 1000 / this.hardware.pollingRate;
    const quantized = [points[0]];
    let nextTime = intervalMs;

    for (let i = 1; i < points.length; i++) {
      if (points[i].t >= nextTime || i === points.length - 1) {
        // Add small timing jitter (±10% of interval)
        const jitteredDelay = intervalMs * (0.9 + Math.random() * 0.2);
        quantized.push({
          ...points[i],
          delay: Math.max(1, Math.round(jitteredDelay))
        });
        nextTime = points[i].t + intervalMs;
      }
    }

    // Ensure last point is the target
    const last = points[points.length - 1];
    if (quantized[quantized.length - 1] !== last) {
      quantized.push({
        ...last,
        delay: Math.max(1, Math.round(intervalMs * 0.5))
      });
    }

    return quantized;
  }

  /**
   * Generate a tiny micro-adjustment (< 3px distance).
   */
  _microAdjust(x0, y0, x1, y1) {
    return [
      { x: x0, y: y0, t: 0, delay: 0 },
      { x: Math.round(((x0 + x1) / 2) * 10) / 10, y: Math.round(((y0 + y1) / 2) * 10) / 10, t: 15, delay: 15 },
      { x: x1, y: y1, t: 30, delay: 15 }
    ];
  }

  // ═══════════════════════════════════════════════════════════
  //  CONVENIENCE: GENERATE CLICK SEQUENCE
  //  Full move → hover → click with all timing
  // ═══════════════════════════════════════════════════════════

  /**
   * Generate a complete move-and-click sequence.
   * Returns { trajectory, preClickPause, holdDuration }.
   */
  generateClick(targetX, targetY, targetWidth = 40, state = {}) {
    const trajectory = this.generateTrajectory(targetX, targetY, targetWidth, state);
    const preClickPause = this.model.samplePreClickPause();
    const holdDuration = this.model.sampleClickHold();

    return {
      trajectory,
      preClickPause: Math.round(preClickPause),
      holdDuration: Math.round(holdDuration),
      totalDuration: (trajectory.length > 0 ? trajectory[trajectory.length - 1].t : 0) + preClickPause + holdDuration
    };
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(TrajectoryGenerator);
