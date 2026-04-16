/**
 * Convergence Engine Module
 * Implements hysteresis-based convergence detection and explicit drift detection.
 *
 * Enter CONVERGED if successRate > 0.90 && aggregateCV < 0.15
 * Exit  CONVERGED if successRate < 0.85
 *
 * Drift detected if shortTermSuccess < (longTermSuccess - δ)
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.ConvergenceEngine = class ConvergenceEngine {
  constructor() {
    this.isConverged = false;
    this.enterThreshold = 0.90;
    this.exitThreshold = 0.85;
    this.cvThreshold = 0.15;
    this.driftDelta = 0.10;

    this.shortTermWindow = 20;
    this.longTermWindow = 100;
    this.outcomes = [];
    this.maxHistory = 200;
  }

  recordOutcome(outcome) {
    this.outcomes.push(outcome);
    if (this.outcomes.length > this.maxHistory) {
      this.outcomes = this.outcomes.slice(-this.maxHistory);
    }
  }

  getRollingSuccessRate(windowSize) {
    const window = this.outcomes.slice(-windowSize);
    if (window.length === 0) return 0;
    const successes = window.filter(o => o > 0.5).length;
    return successes / window.length;
  }

  /**
   * Hysteresis-based convergence check.
   * Prevents flickering between CONVERGED and NOT_CONVERGED states.
   */
  checkConvergence(aggregateCV) {
    const rollingSuccess = this.getRollingSuccessRate(this.shortTermWindow);

    if (!this.isConverged && rollingSuccess > this.enterThreshold && aggregateCV < this.cvThreshold) {
      this.isConverged = true;
    }
    if (this.isConverged && rollingSuccess < this.exitThreshold) {
      this.isConverged = false;
    }

    return this.isConverged;
  }

  /**
   * Explicit drift detection.
   * If short-term performance drops significantly below long-term baseline,
   * force re-exploration to adapt to UI changes / anti-bot measures.
   */
  checkDrift() {
    const shortTerm = this.getRollingSuccessRate(this.shortTermWindow);
    const longTerm = this.getRollingSuccessRate(this.longTermWindow);

    if (shortTerm < (longTerm - this.driftDelta)) {
      this.isConverged = false;
      return true;
    }
    return false;
  }

  getState() {
    return {
      isConverged: this.isConverged,
      shortTermSuccess: this.getRollingSuccessRate(this.shortTermWindow),
      longTermSuccess: this.getRollingSuccessRate(this.longTermWindow),
      totalOutcomes: this.outcomes.length
    };
  }
};
