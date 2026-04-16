/**
 * Temporal Credit Assignment Module
 * Propagates rewards backwards through multi-step flows using discount factor γ.
 * edgeReward = γ * nextReward  (γ ≈ 0.8)
 *
 * Prevents unfair penalization of early steps when later steps fail.
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.CreditAssignment = class CreditAssignment {
  constructor() {
    this.gamma = 0.8;
  }

  /**
   * Propagate rewards backwards through a sequence.
   * @param {Array<{stepId: string, rawOutcome: number}>} stepResults - in execution order
   * @returns {Array<{stepId, rawOutcome, adjustedReward}>}
   */
  propagateRewards(stepResults) {
    if (!stepResults || stepResults.length === 0) return [];

    const rewards = new Array(stepResults.length);

    // Last step gets its own raw outcome
    rewards[stepResults.length - 1] = stepResults[stepResults.length - 1].rawOutcome;

    // Propagate backwards: blend own outcome with discounted future reward
    for (let i = stepResults.length - 2; i >= 0; i--) {
      const ownOutcome = stepResults[i].rawOutcome;
      const futureReward = rewards[i + 1];
      rewards[i] = (ownOutcome + this.gamma * futureReward) / (1 + this.gamma);
    }

    return stepResults.map((step, i) => ({
      stepId: step.stepId,
      rawOutcome: step.rawOutcome,
      adjustedReward: rewards[i]
    }));
  }
};
