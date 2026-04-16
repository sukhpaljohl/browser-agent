/**
 * Path Selector Module
 * Implements correlated Top-K selection with true structural diversity.
 * Checks outcome correlation between paths: corr > 0.8 → treat as identical.
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.PathSelector = class PathSelector {
  constructor() {
    this.correlationThreshold = 0.8;
    this.pathHistory = new Map();
    this.maxHistory = 100;
  }

  recordPathOutcome(pathId, outcome) {
    if (!this.pathHistory.has(pathId)) {
      this.pathHistory.set(pathId, []);
    }
    const history = this.pathHistory.get(pathId);
    history.push(outcome);

    if (history.length > this.maxHistory) {
      this.pathHistory.set(pathId, history.slice(-this.maxHistory));
    }
  }

  /**
   * Pearson correlation between two paths' outcome histories.
   * Returns 0 if insufficient data (< 5 samples).
   */
  calculateCorrelation(pathIdA, pathIdB) {
    const a = this.pathHistory.get(pathIdA) || [];
    const b = this.pathHistory.get(pathIdB) || [];

    const minLen = Math.min(a.length, b.length);
    if (minLen < 5) return 0;

    const aSlice = a.slice(-minLen);
    const bSlice = b.slice(-minLen);

    const meanA = aSlice.reduce((s, v) => s + v, 0) / minLen;
    const meanB = bSlice.reduce((s, v) => s + v, 0) / minLen;

    let numerator = 0, denomA = 0, denomB = 0;
    for (let i = 0; i < minLen; i++) {
      const da = aSlice[i] - meanA;
      const db = bSlice[i] - meanB;
      numerator += da * db;
      denomA += da * da;
      denomB += db * db;
    }

    const denom = Math.sqrt(denomA * denomB);
    if (denom === 0) return 0;
    return numerator / denom;
  }

  /**
   * Select Top-K diverse paths by filtering out correlated duplicates.
   * Ensures fallback paths are genuinely orthogonal.
   */
  selectDiversePaths(candidates, k) {
    if (candidates.length <= k) return candidates;

    const selected = [candidates[0]]; // best candidate always included

    for (let i = 1; i < candidates.length && selected.length < k; i++) {
      const candidate = candidates[i];
      let isDiverse = true;

      for (const existing of selected) {
        const corr = this.calculateCorrelation(candidate.pathId, existing.pathId);
        if (Math.abs(corr) > this.correlationThreshold) {
          isDiverse = false;
          break;
        }
      }

      if (isDiverse) {
        selected.push(candidate);
      }
    }

    return selected;
  }
};
