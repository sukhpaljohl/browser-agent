/**
 * Exploration Engine Module
 * Implements uncertainty-driven epsilon with floor constraint and periodic probing.
 * ε = max(base * aggregateCV, 0.02)
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.ExplorationEngine = class ExplorationEngine {
  constructor() {
    this.epsilon = 0.1;
    this.epsilonFloor = 0.02;
    this.baseRate = 0.15;
    this.probeInterval = 50;   // every N iterations, force exploration
    this.iteration = 0;
  }

  /**
   * Update epsilon driven by actual uncertainty, not success streaks.
   * ε = max(baseRate * aggregateCV, floor)
   */
  updateEpsilon(aggregateCV) {
    this.epsilon = Math.max(this.baseRate * aggregateCV, this.epsilonFloor);
    return this.epsilon;
  }

  /**
   * Decide whether to explore or exploit.
   * Includes periodic probing pulse for silent-drift detection.
   */
  shouldExplore() {
    this.iteration++;

    // Periodic probing pulse — catches silent UI changes
    if (this.iteration % this.probeInterval === 0) {
      return true;
    }

    return Math.random() < this.epsilon;
  }

  getEpsilon() {
    return this.epsilon;
  }

  getIteration() {
    return this.iteration;
  }

  reset() {
    this.epsilon = 0.1;
    this.iteration = 0;
  }
};
