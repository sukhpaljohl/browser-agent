/**
 * POMDP Engine — Central Orchestrator
 * Ties together all modules: BeliefState, Reward, Exploration,
 * Convergence, CreditAssignment, and PathSelector.
 *
 * Implements context-sensitive α learning rate:
 *   High confidence → lower α (stability)
 *   Low confidence  → higher α (rapid learning)
 */
// BrowserAgent namespace — declared in belief-state.js (first loaded content script)

BrowserAgent.POMDPEngine = class POMDPEngine {
  constructor() {
    this.beliefState = new BrowserAgent.BeliefState();
    this.rewardEngine = new BrowserAgent.RewardEngine();
    this.exploration = new BrowserAgent.ExplorationEngine();
    this.convergence = new BrowserAgent.ConvergenceEngine();
    this.creditAssignment = new BrowserAgent.CreditAssignment();
    this.pathSelector = new BrowserAgent.PathSelector();

    this.alphaBase = 0.1;
    this.alphaMin = 0.03;
    this.alphaMax = 0.3;
  }

  /**
   * Context-sensitive learning rate.
   * α scales with CV: uncertain nodes learn fast, confident nodes resist noise.
   */
  getAlpha(nodeId) {
    const cv = this.beliefState.getCV(nodeId);
    const alpha = this.alphaBase * (1 + cv);
    return Math.max(this.alphaMin, Math.min(this.alphaMax, alpha));
  }

  /**
   * Weighted aggregate CV for a path.
   * aggregateCV = Σ(edgeWeight × CV) / Σ(edgeWeight)
   */
  getAggregateCV(path) {
    let weightedSum = 0;
    let totalWeight = 0;

    for (const step of path) {
      const cv = this.beliefState.getCV(step.nodeId);
      const weight = step.edgeWeight || 1;
      weightedSum += weight * cv;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 1;
  }

  /**
   * Main decision: choose the best action from available strategies.
   * Explores if uncertainty-driven ε triggers, else exploits highest-confidence path.
   */
  selectAction(availableStrategies) {
    if (!availableStrategies || availableStrategies.length === 0) return null;

    const aggregateCV = this.getAggregateCV(
      availableStrategies.map(s => ({ nodeId: s.id, edgeWeight: 1 }))
    );

    this.exploration.updateEpsilon(aggregateCV);

    // Explore: select from diverse Top-K
    if (this.exploration.shouldExplore()) {
      const candidates = availableStrategies.map(s => ({
        ...s,
        pathId: s.id,
        score: this.beliefState.getOrCreateNode(s.id).meanConfidence
      }));
      candidates.sort((a, b) => b.score - a.score);
      const diverse = this.pathSelector.selectDiversePaths(candidates, 3);
      return diverse[Math.floor(Math.random() * diverse.length)];
    }

    // Exploit: pick highest confidence minus uncertainty
    let best = null;
    let bestScore = -Infinity;

    for (const strategy of availableStrategies) {
      const node = this.beliefState.getOrCreateNode(strategy.id);
      const cv = this.beliefState.getCV(strategy.id);
      const score = node.meanConfidence - cv;
      if (score > bestScore) {
        bestScore = score;
        best = strategy;
      }
    }

    return best;
  }

  /**
   * Record the outcome of an executed action sequence.
   * Applies temporal credit assignment, updates belief state, checks convergence & drift.
   */
  recordSequenceOutcome(stepResults, hostname) {
    const adjusted = this.creditAssignment.propagateRewards(stepResults);

    for (const step of adjusted) {
      const alpha = this.getAlpha(step.stepId);
      this.beliefState.updateNode(step.stepId, step.adjustedReward);
      this.beliefState.updateEdge(step.stepId, step.adjustedReward, alpha);
      this.pathSelector.recordPathOutcome(step.stepId, step.adjustedReward);
    }

    // Record final outcome in convergence tracker
    const finalOutcome = adjusted[adjusted.length - 1].adjustedReward;
    this.convergence.recordOutcome(finalOutcome);

    // Check convergence and drift
    const aggregateCV = this.getAggregateCV(
      adjusted.map(s => ({ nodeId: s.stepId, edgeWeight: 1 }))
    );
    this.convergence.checkConvergence(aggregateCV);
    this.convergence.checkDrift();

    return {
      convergenceState: this.convergence.getState(),
      epsilon: this.exploration.getEpsilon(),
      aggregateCV
    };
  }

  getStatus() {
    return {
      convergence: this.convergence.getState(),
      epsilon: this.exploration.getEpsilon(),
      iteration: this.exploration.getIteration(),
      trackedNodes: this.beliefState.nodes.size,
      trackedEdges: this.beliefState.edges.size
    };
  }

  save() {
    return {
      beliefState: this.beliefState.serialize(),
      convergenceOutcomes: this.convergence.outcomes,
      explorationIteration: this.exploration.iteration,
      explorationEpsilon: this.exploration.epsilon
    };
  }

  load(data) {
    if (data.beliefState) this.beliefState.deserialize(data.beliefState);
    if (data.convergenceOutcomes) this.convergence.outcomes = data.convergenceOutcomes;
    if (data.explorationIteration !== undefined) this.exploration.iteration = data.explorationIteration;
    if (data.explorationEpsilon !== undefined) this.exploration.epsilon = data.explorationEpsilon;
  }
};
