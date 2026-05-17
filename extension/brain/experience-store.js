/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * Experience Store — IndexedDB Persistence Layer for the Experience Buffer
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Lives in: background/service-worker.js (via importScripts)
 * Purpose:  Manages IndexedDB persistence, quality gates, trajectory lifecycle,
 *           credit assignment, and data export for the POMDP Experience Buffer.
 *
 * Phase 1B.5 — The agent's autobiographical memory.
 *
 * Architecture:
 *   - Content script (experience-buffer.js) serializes and sends step records
 *   - This module receives them via BRAIN_LOG_EXPERIENCE IPC
 *   - Applies 4-gate quality filter before IndexedDB write
 *   - Manages trajectory lifecycle (create/finalize/credit-assign)
 *   - Provides export, stats, and RLHF correction endpoints
 *
 * IndexedDB Stores:
 *   steps        — Individual action step records (primary training data)
 *   trajectories — Grouped behavioral sequences
 *   corrections  — RLHF human corrections
 *   schemas      — Version → field list mappings
 *   meta         — Global counters, domain caps, migration log
 *
 * Ref: Implementation Plan v4 §4-§12
 * ═══════════════════════════════════════════════════════════════════════════════
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const EXPERIENCE_DB_NAME = 'pomdp-experience-buffer';
const EXPERIENCE_DB_VERSION = 1;

/** Configurable — will likely increase in future phases */
const DIVERSITY_WINDOW_SIZE = 10;

/** Maximum steps stored per domain before eviction triggers */
const DOMAIN_CAP = 500;

/** Number of entries to evict at once (avoids per-step eviction queries) */
const EVICTION_BATCH_SIZE = 10;

/** Discount factor for credit assignment (backward from terminal reward) */
const CREDIT_DISCOUNT_GAMMA = 0.9;

/** Terminal reward values by trajectory outcome */
const TERMINAL_REWARDS = {
  completed: 1.0,
  abandoned: -0.3,
  safety_blocked: -1.0,
  budget_exhausted: -0.5,
};

// ─── ExperienceStore Class ───────────────────────────────────────────────────

class ExperienceStore {
  constructor() {
    /** @type {IDBDatabase|null} Lazy-opened IndexedDB connection */
    this._db = null;

    /**
     * Recent diversity fingerprints (in-memory, lost on SW restart).
     * Losing this on restart means ≤2 redundant entries — acceptable.
     * @type {Object[]}
     */
    this._recentFingerprints = [];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DATABASE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Lazy-open the IndexedDB connection. Auto-reconnects after SW restart.
   * @returns {Promise<IDBDatabase>}
   */
  async _getDB() {
    if (this._db) {
      try {
        // Verify connection is alive (accessing .name throws if closed)
        void this._db.name;
        return this._db;
      } catch (e) {
        this._db = null;
      }
    }

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(EXPERIENCE_DB_NAME, EXPERIENCE_DB_VERSION);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;

        if (!db.objectStoreNames.contains('steps')) {
          const steps = db.createObjectStore('steps', { keyPath: 'id' });
          steps.createIndex('trajectoryId', 'trajectoryId', { unique: false });
          steps.createIndex('domain', 'domain', { unique: false });
          steps.createIndex('timestamp', 'timestamp', { unique: false });
          steps.createIndex('priority', 'priority', { unique: false });
        }

        if (!db.objectStoreNames.contains('trajectories')) {
          const traj = db.createObjectStore('trajectories', { keyPath: 'id' });
          traj.createIndex('domain', 'domain', { unique: false });
          traj.createIndex('status', 'status', { unique: false });
          traj.createIndex('startTime', 'startTime', { unique: false });
        }

        if (!db.objectStoreNames.contains('corrections')) {
          const corr = db.createObjectStore('corrections', { keyPath: 'id' });
          corr.createIndex('stepId', 'stepId', { unique: false });
          corr.createIndex('timestamp', 'timestamp', { unique: false });
        }

        if (!db.objectStoreNames.contains('schemas')) {
          db.createObjectStore('schemas', { keyPath: 'version' });
        }

        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }

        console.log('[ExperienceStore] ✓ IndexedDB schema created/upgraded');
      };

      req.onsuccess = () => {
        this._db = req.result;
        this._db.onclose = () => {
          console.warn('[ExperienceStore] IndexedDB connection closed unexpectedly');
          this._db = null;
        };
        console.log('[ExperienceStore] ✓ IndexedDB connection opened');
        resolve(this._db);
      };

      req.onerror = () => {
        console.error('[ExperienceStore] ✗ IndexedDB open failed:', req.error);
        reject(req.error);
      };
    });
  }

  /**
   * Helper: promisify an IDBRequest.
   * @param {IDBRequest} request
   * @returns {Promise<any>}
   */
  _promisify(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Helper: promisify an IDBTransaction completion.
   * @param {IDBTransaction} tx
   * @returns {Promise<void>}
   */
  _txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  TRAJECTORY LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new trajectory record in IndexedDB.
   * Called synchronously after BRAIN_TASK_INIT generates a UUID.
   *
   * @param {string} trajectoryId - Pre-generated UUID
   * @param {string} goal - User's goal text
   * @param {Object|null} parsedGoal - From GoalParser (may be null at init time)
   * @param {string} domain - Hostname (e.g., "apple.com")
   * @param {string} startUrl - Starting URL
   * @returns {Promise<string>} The trajectory ID
   */
  async createTrajectory(trajectoryId, goal, parsedGoal, domain, startUrl) {
    try {
      const db = await this._getDB();
      const record = {
        id: trajectoryId,
        parentTrajectoryId: null,
        goal,
        parsedGoal: parsedGoal || null,
        domain,
        startUrl,
        startTime: Date.now(),
        endTime: null,
        status: 'active',
        terminalReward: null,
        totalSteps: 0,
        stepsLogged: 0,
        totalRecoveries: 0,
        loopsDetected: 0,
        clarificationsTriggered: 0,
        efficiency: null,
        pathUrls: startUrl ? [startUrl] : [],
        pipelineVersion: '1b5_v1',
        schemaVersion: 1,
      };

      const tx = db.transaction('trajectories', 'readwrite');
      tx.objectStore('trajectories').put(record);
      await this._txDone(tx);

      console.log(`[ExperienceStore] ✓ Trajectory created: ${trajectoryId.substring(0, 8)}...`);
      return trajectoryId;
    } catch (e) {
      console.error('[ExperienceStore] Failed to create trajectory:', e.message);
      return trajectoryId;
    }
  }

  /**
   * Finalize a trajectory: set status, terminal reward, and apply credit assignment.
   *
   * @param {string} trajectoryId
   * @param {string} status - "completed" | "abandoned" | "safety_blocked" | "budget_exhausted"
   * @param {number} terminalReward - From TERMINAL_REWARDS
   * @returns {Promise<Object|null>} Finalization summary or null on failure
   */
  async finalizeTrajectory(trajectoryId, status, terminalReward) {
    if (!trajectoryId) return null;

    try {
      const db = await this._getDB();

      // Read trajectory
      const tx1 = db.transaction('trajectories', 'readonly');
      const trajectory = await this._promisify(
        tx1.objectStore('trajectories').get(trajectoryId)
      );

      if (!trajectory) {
        console.warn(`[ExperienceStore] Trajectory not found: ${trajectoryId.substring(0, 8)}...`);
        return null;
      }

      if (trajectory.status !== 'active') {
        console.warn(`[ExperienceStore] Already finalized: ${trajectoryId.substring(0, 8)}... (${trajectory.status})`);
        return null;
      }

      // Count logged steps
      const tx2 = db.transaction('steps', 'readonly');
      const stepsLogged = await this._promisify(
        tx2.objectStore('steps').index('trajectoryId').count(trajectoryId)
      );

      // Update trajectory
      trajectory.status = status;
      trajectory.terminalReward = terminalReward;
      trajectory.endTime = Date.now();
      trajectory.stepsLogged = stepsLogged;

      const tx3 = db.transaction('trajectories', 'readwrite');
      tx3.objectStore('trajectories').put(trajectory);
      await this._txDone(tx3);

      // Apply credit assignment
      if (stepsLogged > 0 && terminalReward !== null) {
        await this._applyCreditAssignment(
          trajectoryId, terminalReward, trajectory.totalSteps
        );
      }

      console.log(`[ExperienceStore] ✓ Finalized: ${trajectoryId.substring(0, 8)}... → ${status} (reward=${terminalReward}, steps=${stepsLogged})`);
      return { status, stepsLogged, terminalReward };
    } catch (e) {
      console.error('[ExperienceStore] Finalize failed:', e.message);
      return null;
    }
  }

  /**
   * Apply discounted credit assignment to all steps in a trajectory.
   * Uses real stepIndex for gamma distance (handles filtered gaps correctly).
   *
   * @param {string} trajectoryId
   * @param {number} terminalReward
   * @param {number} totalSteps - Real trajectory length (including unlogged steps)
   */
  async _applyCreditAssignment(trajectoryId, terminalReward, totalSteps) {
    try {
      const db = await this._getDB();

      const tx1 = db.transaction('steps', 'readonly');
      const steps = await this._promisify(
        tx1.objectStore('steps').index('trajectoryId').getAll(trajectoryId)
      );

      if (!steps || steps.length === 0) return;

      const effectiveTotal = Math.max(totalSteps, steps.length);

      for (const step of steps) {
        const dist = effectiveTotal - 1 - step.stepIndex;
        step.discountedReward = terminalReward * Math.pow(
          CREDIT_DISCOUNT_GAMMA, Math.max(0, dist)
        );
      }

      const tx2 = db.transaction('steps', 'readwrite');
      const store = tx2.objectStore('steps');
      for (const step of steps) {
        store.put(step);
      }
      await this._txDone(tx2);

      console.log(`[ExperienceStore] ✓ Credit assigned: ${steps.length} steps, γ=${CREDIT_DISCOUNT_GAMMA}`);
    } catch (e) {
      console.error('[ExperienceStore] Credit assignment failed:', e.message);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  STEP RECORDING (with Quality Gates)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Record a step through the 4-gate quality filter pipeline.
   * Gate 0: Validation → Gate 1: Priority → Gate 2: Diversity → Gate 3: Domain cap
   *
   * @param {Object} stepRecord - Complete step record from ExperienceBuffer
   * @returns {Promise<Object>} { recorded: boolean, reason?: string, priority?: string }
   */
  async recordStep(stepRecord) {
    // Gate 0: Validation (corruption defense)
    const errors = this._validateStepRecord(stepRecord);
    if (errors.length > 0) {
      console.warn('[ExperienceStore] Gate 0 REJECT:', errors);
      return { recorded: false, reason: 'validation_failed', errors };
    }

    // Gate 1: Information gain → priority assignment
    const priority = this._assignPriority(stepRecord);
    stepRecord.priority = priority;

    // Low-priority steps sampled at 10%
    if (priority === 'low' && Math.random() > 0.10) {
      return { recorded: false, reason: 'low_priority_sampled_out' };
    }

    // Gate 2: Structural diversity
    if (stepRecord.candidates && stepRecord.candidates.length > 0) {
      const fp = this._computeDiversityFingerprint(
        stepRecord.candidates, stepRecord.url
      );
      if (this._checkDiversityDuplicate(fp)) {
        return { recorded: false, reason: 'diversity_duplicate' };
      }
      this._recentFingerprints.push(fp);
      if (this._recentFingerprints.length > DIVERSITY_WINDOW_SIZE) {
        this._recentFingerprints.shift();
      }
    }

    // Gate 3: Per-domain cap (fire-and-forget eviction if needed)
    try {
      await this._enforceDomainCap(stepRecord.domain);
    } catch (e) {
      console.warn('[ExperienceStore] Domain cap error (non-blocking):', e.message);
    }

    // All gates passed — write to IndexedDB
    try {
      const db = await this._getDB();
      const tx = db.transaction(['steps', 'trajectories'], 'readwrite');

      // Write step record
      tx.objectStore('steps').put(stepRecord);

      // Update trajectory counters
      const trajReq = tx.objectStore('trajectories').get(stepRecord.trajectoryId);
      trajReq.onsuccess = () => {
        const traj = trajReq.result;
        if (!traj) return;

        traj.totalSteps = Math.max(traj.totalSteps || 0, stepRecord.stepIndex + 1);
        traj.stepsLogged = (traj.stepsLogged || 0) + 1;

        // Track path URLs (deduplicated)
        if (stepRecord.url) {
          traj.pathUrls = traj.pathUrls || [];
          if (!traj.pathUrls.includes(stepRecord.url)) {
            traj.pathUrls.push(stepRecord.url);
          }
        }

        // Aggregate behavioral signals
        if (stepRecord.recoveryTriggered) {
          traj.totalRecoveries = (traj.totalRecoveries || 0) + 1;
        }
        if (stepRecord.loopDetected) {
          traj.loopsDetected = (traj.loopsDetected || 0) + 1;
        }
        if (stepRecord.clarificationTriggered) {
          traj.clarificationsTriggered = (traj.clarificationsTriggered || 0) + 1;
        }

        tx.objectStore('trajectories').put(traj);
      };

      await this._txDone(tx);

      console.log(
        `[ExperienceStore] ✓ Step ${stepRecord.id.substring(0, 8)}... ` +
        `[${priority}] traj:${stepRecord.trajectoryId.substring(0, 8)}...`
      );
      return { recorded: true, priority };
    } catch (e) {
      console.error('[ExperienceStore] Write failed:', e.message);
      return { recorded: false, reason: 'write_failed', error: e.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  QUALITY GATES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Gate 0: Structural validation. Rejects malformed records.
   * @param {Object} record
   * @returns {string[]} Array of error messages (empty = valid)
   */
  _validateStepRecord(record) {
    const errors = [];
    if (!record.id) errors.push('missing id');
    if (!record.trajectoryId) errors.push('missing trajectoryId');
    if (!record.timestamp) errors.push('missing timestamp');
    if (!Array.isArray(record.candidates) || record.candidates.length === 0) {
      errors.push('empty/missing candidates');
    }
    if (!record.schemaVersion) errors.push('missing schemaVersion');
    if (!record.candidateSchemaVersion) errors.push('missing candidateSchemaVersion');
    if (record.featureVector && !Array.isArray(record.featureVector)) {
      errors.push('featureVector not array');
    }
    if (record.chosenIndex != null &&
        (record.chosenIndex < 0 || record.chosenIndex >= (record.candidates?.length || 0))) {
      errors.push('chosenIndex out of bounds');
    }
    if (!record.url) errors.push('missing url');
    if (!record.domain) errors.push('missing domain');
    if (typeof record.stepIndex !== 'number') errors.push('missing/invalid stepIndex');
    return errors;
  }

  /**
   * Gate 1: Assign priority based on information gain signals.
   * @param {Object} record
   * @returns {string} "high" | "medium" | "low"
   */
  _assignPriority(record) {
    if (record.loopDetected) return 'high';
    if (record.isTerminal) return 'high';
    if (record.safetyBlocked) return 'high';
    if (record.clarificationTriggered) return 'high';
    if (typeof record.progressDelta === 'number' && record.progressDelta < -0.05) {
      return 'high';
    }
    if (record.effect && record.effect !== 'none') return 'medium';
    return 'low';
  }

  /**
   * Gate 2a: Compute structural diversity fingerprint from candidates.
   * @param {Object[]} candidates - Serialized candidates
   * @param {string} url - Current page URL
   * @returns {Object} Fingerprint object
   */
  _computeDiversityFingerprint(candidates, url) {
    const typeCounts = {};
    let hasForm = false;
    const regions = new Set();

    for (const c of candidates) {
      const t = c.nodeType || 'unknown';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (c.features?.is_in_form) hasForm = true;
      if (c.features?.page_region) regions.add(c.features.page_region);
    }

    const dominantType = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown';

    let urlPath = '';
    try { urlPath = new URL(url).pathname; } catch (e) { urlPath = url || ''; }

    return { count: candidates.length, dominantType, hasForm, regionSpread: regions.size, urlPath };
  }

  /**
   * Gate 2b: Check if a fingerprint is similar to any recent fingerprint.
   * @param {Object} fp - New fingerprint
   * @returns {boolean} True if duplicate (should skip)
   */
  _checkDiversityDuplicate(fp) {
    for (const recent of this._recentFingerprints) {
      if (this._isSimilarFingerprint(fp, recent)) return true;
    }
    return false;
  }

  /**
   * Gate 2c: Numerical fingerprint comparison with tolerances.
   * @param {Object} fp1
   * @param {Object} fp2
   * @returns {boolean} True if fingerprints represent the same page structure
   */
  _isSimilarFingerprint(fp1, fp2) {
    if (fp1.urlPath !== fp2.urlPath) return false;
    const maxCount = Math.max(fp1.count, fp2.count);
    if (maxCount > 0 && Math.abs(fp1.count - fp2.count) / maxCount > 0.15) return false;
    if (fp1.dominantType !== fp2.dominantType) return false;
    if (fp1.hasForm !== fp2.hasForm) return false;
    if (Math.abs(fp1.regionSpread - fp2.regionSpread) > 1) return false;
    return true;
  }

  /**
   * Gate 3: Enforce per-domain step cap with batch eviction.
   * Uses meta store for O(1) count checks. Evicts lowest-priority oldest entries.
   *
   * @param {string} domain
   */
  async _enforceDomainCap(domain) {
    const db = await this._getDB();

    // Read domain count from meta store
    const metaTx = db.transaction('meta', 'readonly');
    const metaRecord = await this._promisify(
      metaTx.objectStore('meta').get('domainCounts')
    );
    const counts = metaRecord?.counts || {};
    const currentCount = counts[domain] || 0;

    if (currentCount < DOMAIN_CAP) {
      // Under cap — increment counter
      const updateTx = db.transaction('meta', 'readwrite');
      const updatedCounts = { ...(metaRecord || { key: 'domainCounts', counts: {} }) };
      updatedCounts.counts = updatedCounts.counts || {};
      updatedCounts.counts[domain] = currentCount + 1;
      updatedCounts.key = 'domainCounts';
      updateTx.objectStore('meta').put(updatedCounts);
      await this._txDone(updateTx);
      return;
    }

    // Over cap — batch evict
    console.log(`[ExperienceStore] Domain cap hit for ${domain} (${currentCount}/${DOMAIN_CAP}). Evicting ${EVICTION_BATCH_SIZE}...`);

    const readTx = db.transaction('steps', 'readonly');
    const allForDomain = await this._promisify(
      readTx.objectStore('steps').index('domain').getAll(domain)
    );

    // Sort: low priority first, then oldest first
    const priorityOrder = { low: 0, medium: 1, high: 2 };
    allForDomain.sort((a, b) => {
      const pa = priorityOrder[a.priority] ?? 1;
      const pb = priorityOrder[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.timestamp - b.timestamp;
    });

    // Delete bottom N
    const deleteTx = db.transaction('steps', 'readwrite');
    const deleteStore = deleteTx.objectStore('steps');
    const toDelete = Math.min(EVICTION_BATCH_SIZE, allForDomain.length);
    for (let i = 0; i < toDelete; i++) {
      deleteStore.delete(allForDomain[i].id);
    }
    await this._txDone(deleteTx);

    // Update counter
    const counterTx = db.transaction('meta', 'readwrite');
    const counterRecord = { key: 'domainCounts', counts: { ...counts } };
    counterRecord.counts[domain] = Math.max(0, currentCount - toDelete + 1);
    counterTx.objectStore('meta').put(counterRecord);
    await this._txDone(counterTx);

    console.log(`[ExperienceStore] ✓ Evicted ${toDelete} entries for ${domain}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  EXPORT, STATS, CORRECTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get buffer health statistics.
   * @returns {Promise<Object>} Stats summary
   */
  async getStats() {
    try {
      const db = await this._getDB();

      const tx = db.transaction(['steps', 'trajectories', 'corrections'], 'readonly');
      const [stepCount, trajCount, corrCount] = await Promise.all([
        this._promisify(tx.objectStore('steps').count()),
        this._promisify(tx.objectStore('trajectories').count()),
        this._promisify(tx.objectStore('corrections').count()),
      ]);

      // Domain distribution
      const allSteps = await this._promisify(tx.objectStore('steps').getAll());
      const domainDist = {};
      const statusDist = { completed: 0, abandoned: 0, safety_blocked: 0, budget_exhausted: 0, active: 0 };
      let earliest = Infinity, latest = 0;

      for (const s of allSteps) {
        domainDist[s.domain] = (domainDist[s.domain] || 0) + 1;
        if (s.timestamp < earliest) earliest = s.timestamp;
        if (s.timestamp > latest) latest = s.timestamp;
      }

      // Trajectory status distribution
      const allTrajs = await this._promisify(tx.objectStore('trajectories').getAll());
      for (const t of allTrajs) {
        if (statusDist.hasOwnProperty(t.status)) statusDist[t.status]++;
      }

      return {
        totalSteps: stepCount,
        totalTrajectories: trajCount,
        totalCorrections: corrCount,
        domainDistribution: domainDist,
        statusDistribution: statusDist,
        dateRange: stepCount > 0 ? {
          earliest: new Date(earliest).toISOString(),
          latest: new Date(latest).toISOString(),
        } : null,
      };
    } catch (e) {
      console.error('[ExperienceStore] Stats failed:', e.message);
      return { error: e.message };
    }
  }

  /**
   * Export data as a self-describing JSON snapshot.
   *
   * @param {Object} [options]
   * @param {number} [options.limit=100] - Max steps to return
   * @param {number} [options.offset=0] - Pagination offset
   * @param {string} [options.domain] - Filter by domain
   * @param {string} [options.status] - Filter trajectories by status
   * @returns {Promise<Object>} Self-describing export
   */
  async exportData(options = {}) {
    const { limit = 100, offset = 0, domain, status } = options;

    try {
      const db = await this._getDB();
      const tx = db.transaction(['steps', 'trajectories', 'schemas'], 'readonly');

      // Get steps (with optional domain filter)
      let allSteps;
      if (domain) {
        allSteps = await this._promisify(
          tx.objectStore('steps').index('domain').getAll(domain)
        );
      } else {
        allSteps = await this._promisify(tx.objectStore('steps').getAll());
      }

      // Sort by timestamp, apply pagination
      allSteps.sort((a, b) => a.timestamp - b.timestamp);
      const paginatedSteps = allSteps.slice(offset, offset + limit);

      // Get relevant trajectories
      const trajIds = new Set(paginatedSteps.map(s => s.trajectoryId));
      let allTrajs = await this._promisify(tx.objectStore('trajectories').getAll());
      if (status) {
        allTrajs = allTrajs.filter(t => t.status === status);
      }
      const relevantTrajs = allTrajs.filter(t => trajIds.has(t.id));

      // Get schemas
      const schemas = await this._promisify(tx.objectStore('schemas').getAll());
      const schemaRegistry = {};
      for (const s of schemas) {
        schemaRegistry[s.version] = s.fields || s;
      }

      // Build self-describing export
      const exportData = {
        exportVersion: 1,
        exportId: crypto.randomUUID(),
        exportTimestamp: new Date().toISOString(),
        generatedBy: 'pomdp-agent-v1.0.0',

        schemaRegistry,
        pipelineVersionsIncluded: [...new Set(paginatedSteps.map(s => s.pipelineVersion).filter(Boolean))],

        stats: {
          totalStepsInExport: paginatedSteps.length,
          totalStepsInBuffer: allSteps.length,
          totalTrajectories: relevantTrajs.length,
          pagination: { offset, limit, hasMore: offset + limit < allSteps.length },
        },

        trajectories: relevantTrajs,
        steps: paginatedSteps,
      };

      // Compute checksum (simple hash of step IDs for integrity)
      const idString = paginatedSteps.map(s => s.id).join('|');
      exportData.checksum = 'fnv1a:' + this._fnv1aHash(idString);

      return exportData;
    } catch (e) {
      console.error('[ExperienceStore] Export failed:', e.message);
      return { error: e.message };
    }
  }

  /**
   * Record an RLHF correction for a specific step.
   *
   * @param {string} stepId - The step to correct
   * @param {number} correctedOutcome - New outcome value
   * @param {string} reason - Why the correction was made
   * @returns {Promise<Object>} Result
   */
  async recordCorrection(stepId, correctedOutcome, reason) {
    try {
      const db = await this._getDB();
      const tx = db.transaction(['corrections', 'steps'], 'readwrite');

      // Write correction record
      const correction = {
        id: crypto.randomUUID(),
        stepId,
        correctedOutcome,
        reason,
        timestamp: Date.now(),
      };
      tx.objectStore('corrections').put(correction);

      // Update step record
      const stepReq = tx.objectStore('steps').get(stepId);
      stepReq.onsuccess = () => {
        const step = stepReq.result;
        if (step) {
          step.humanCorrected = true;
          step.correctedOutcome = correctedOutcome;
          tx.objectStore('steps').put(step);
        }
      };

      await this._txDone(tx);
      console.log(`[ExperienceStore] ✓ Correction: step ${stepId.substring(0, 8)}... → ${correctedOutcome} (${reason})`);
      return { success: true, correctionId: correction.id };
    } catch (e) {
      console.error('[ExperienceStore] Correction failed:', e.message);
      return { success: false, error: e.message };
    }
  }

  /**
   * Purge data by filter criteria.
   *
   * @param {Object} filter
   * @param {string} [filter.domain] - Delete all for this domain
   * @param {number} [filter.before] - Delete steps before this timestamp
   * @param {string} [filter.trajectoryId] - Delete all steps in this trajectory
   * @returns {Promise<Object>} { deleted: number }
   */
  async purge(filter = {}) {
    try {
      const db = await this._getDB();
      let deleted = 0;

      const tx = db.transaction(['steps', 'trajectories'], 'readwrite');
      const stepStore = tx.objectStore('steps');
      const allSteps = await this._promisify(stepStore.getAll());

      for (const step of allSteps) {
        let shouldDelete = false;

        if (filter.domain && step.domain === filter.domain) shouldDelete = true;
        if (filter.before && step.timestamp < filter.before) shouldDelete = true;
        if (filter.trajectoryId && step.trajectoryId === filter.trajectoryId) shouldDelete = true;

        if (shouldDelete) {
          stepStore.delete(step.id);
          deleted++;
        }
      }

      // Also delete matching trajectories
      if (filter.domain || filter.trajectoryId) {
        const trajStore = tx.objectStore('trajectories');
        const allTrajs = await this._promisify(trajStore.getAll());
        for (const traj of allTrajs) {
          if (filter.domain && traj.domain === filter.domain) trajStore.delete(traj.id);
          if (filter.trajectoryId && traj.id === filter.trajectoryId) trajStore.delete(traj.id);
        }
      }

      await this._txDone(tx);

      // Reset domain counter if purging by domain
      if (filter.domain) {
        const metaTx = db.transaction('meta', 'readwrite');
        const metaRecord = await this._promisify(
          metaTx.objectStore('meta').get('domainCounts')
        );
        if (metaRecord?.counts) {
          delete metaRecord.counts[filter.domain];
          metaTx.objectStore('meta').put(metaRecord);
          await this._txDone(metaTx);
        }
      }

      console.log(`[ExperienceStore] ✓ Purged ${deleted} steps`);
      return { deleted };
    } catch (e) {
      console.error('[ExperienceStore] Purge failed:', e.message);
      return { deleted: 0, error: e.message };
    }
  }

  /**
   * FNV-1a hash for lightweight checksum computation.
   * @param {string} str
   * @returns {string} Hex hash
   */
  _fnv1aHash(str) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
  }
}

// ─── Export Singleton ────────────────────────────────────────────────────────
// In Service Worker context (importScripts), this creates a global singleton.
const experienceStore = new ExperienceStore();
