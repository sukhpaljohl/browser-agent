/**
 * Reward Engine Module
 * Implements per-host utility functions and continuous outcome evaluation.
 * Reward = (W1 * Completeness) + (W2 * Validity) - (W3 * Latency)
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.RewardEngine = class RewardEngine {
  constructor() {
    this.hostProfiles = {
      'chatgpt.com': { w1: 0.4, w2: 0.3, w3: 0.3 },
      'chat.openai.com': { w1: 0.4, w2: 0.3, w3: 0.3 },
      'claude.ai': { w1: 0.5, w2: 0.35, w3: 0.15 },
      default: { w1: 0.4, w2: 0.4, w3: 0.2 }
    };
  }

  getWeights(hostname) {
    return this.hostProfiles[hostname] || this.hostProfiles.default;
  }

  calculateReward(hostname, metrics) {
    const { completeness, validity, latency } = metrics;
    const { w1, w2, w3 } = this.getWeights(hostname);
    return (w1 * completeness) + (w2 * validity) - (w3 * latency);
  }

  /**
   * Convert raw interaction result to continuous outcome ∈ [0, 1].
   *   1.0 → perfect success
   *   0.8 → success with delay
   *   0.5 → partial DOM interaction
   *   0.2 → weak signal
   *   0.0 → failure
   */
  evaluateOutcome(result) {
    if (!result.success) return 0;

    let score = 1.0;

    // Latency penalty: < 1s = perfect, > 10s = -0.5
    if (result.latencyMs) {
      const latencyPenalty = Math.min(result.latencyMs / 10000, 0.5);
      score -= latencyPenalty;
    }

    // Partial DOM interaction penalty
    if (result.partial) {
      score *= 0.5;
    }

    // Weak signal penalty (e.g., truncated response)
    if (result.weakSignal) {
      score *= 0.6;
    }

    return Math.max(0, Math.min(1, score));
  }
};
