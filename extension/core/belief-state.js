/**
 * Belief State Module
 * Tracks node confidence, variance, and edge probabilities.
 * Implements CV with clamped denominator to prevent infinity explosions.
 */
// Shared namespace for all content scripts — `var` (not window.X) keeps it off the window object
// and invisible to the target website's JavaScript.
var BrowserAgent = (typeof BrowserAgent !== 'undefined') ? BrowserAgent : {};

BrowserAgent.BeliefState = class BeliefState {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.CV_EPSILON = 0.05;
    this.ROLLING_WINDOW = 50;
  }

  getOrCreateNode(nodeId) {
    if (!this.nodes.has(nodeId)) {
      this.nodes.set(nodeId, {
        meanConfidence: 0.5,
        variance: 0.25,
        successes: 0,
        attempts: 0,
        outcomes: [],
        lastUpdated: Date.now()
      });
    }
    return this.nodes.get(nodeId);
  }

  updateNode(nodeId, outcome) {
    const node = this.getOrCreateNode(nodeId);
    node.outcomes.push(outcome);
    node.attempts++;

    // Rolling window for mean and variance
    const window = node.outcomes.slice(-this.ROLLING_WINDOW);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const variance = window.reduce((sum, o) => sum + Math.pow(o - mean, 2), 0) / window.length;

    node.meanConfidence = mean;
    node.variance = variance;
    node.lastUpdated = Date.now();

    if (outcome > 0.5) node.successes++;

    return node;
  }

  /**
   * Coefficient of Variation with clamped denominator.
   * cv = sqrt(variance) / max(meanConfidence, ε)
   */
  getCV(nodeId) {
    const node = this.getOrCreateNode(nodeId);
    const std = Math.sqrt(node.variance);
    return std / Math.max(node.meanConfidence, this.CV_EPSILON);
  }

  getEdge(edgeId) {
    if (!this.edges.has(edgeId)) {
      this.edges.set(edgeId, {
        probability: 0.5,
        attempts: 0,
        lastOutcome: null
      });
    }
    return this.edges.get(edgeId);
  }

  /**
   * Online Bayesian update with explicit alpha learning rate.
   * newProb = (1 - α) * oldProb + (α * outcome)
   */
  updateEdge(edgeId, outcome, alpha) {
    const edge = this.getEdge(edgeId);
    edge.probability = (1 - alpha) * edge.probability + alpha * outcome;
    edge.attempts++;
    edge.lastOutcome = outcome;
    return edge;
  }

  serialize() {
    return JSON.stringify({
      nodes: Array.from(this.nodes.entries()),
      edges: Array.from(this.edges.entries())
    });
  }

  deserialize(data) {
    const parsed = JSON.parse(data);
    this.nodes = new Map(parsed.nodes);
    this.edges = new Map(parsed.edges);
  }
};
