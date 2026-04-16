/**
 * SegmentMatcher — Real Trajectory Template Bank
 * 
 * Selects and transforms real trajectory segments extracted from
 * the CaptchaSolve30k dataset to provide authentic human path shapes.
 * 
 * Each segment is stored in normalized form:
 *   - Start = (0, 0), End = (1, 0)
 *   - Points are relative to this unit vector
 * 
 * At runtime, segments are rotated and scaled to fit the actual
 * start→end vector, then augmented with per-instance noise.
 */
class SegmentMatcher {
  constructor(segmentsData) {
    this.segments = segmentsData.segments || [];
    this._index = this._buildIndex();
    console.log(`[SegmentMatcher] Loaded ${this.segments.length} templates across ${Object.keys(this._index).length} categories`);
  }

  /**
   * Build category index for fast lookup.
   */
  _buildIndex() {
    const index = {};
    for (let i = 0; i < this.segments.length; i++) {
      const seg = this.segments[i];
      const key = `${seg.distCat}_${seg.type}`;
      if (!index[key]) index[key] = [];
      index[key].push(i);
    }
    return index;
  }

  /**
   * Find and transform a matching real trajectory template.
   * 
   * @param {number} startX - start X in viewport pixels
   * @param {number} startY - start Y in viewport pixels
   * @param {number} endX - end X in viewport pixels
   * @param {number} endY - end Y in viewport pixels
   * @param {number} [targetSize=40] - target element size
   * @returns {Array<[number, number]>|null} transformed control points, or null
   */
  match(startX, startY, endX, endY, targetSize = 40) {
    const distance = Math.hypot(endX - startX, endY - startY);

    // Categorize the movement
    const distCat = distance < 80 ? 'short' : (distance < 300 ? 'medium' : 'long');

    // Try to find a matching template (prefer curved for natural feel)
    const preferredTypes = ['curved', 'linear', 'with_overshoot', 'precision'];
    let template = null;

    for (const type of preferredTypes) {
      const key = `${distCat}_${type}`;
      const indices = this._index[key];
      if (indices && indices.length > 0) {
        // Pick random template from matching category
        const randomIdx = indices[Math.floor(Math.random() * indices.length)];
        template = this.segments[randomIdx];
        break;
      }
    }

    // Fallback: try any category
    if (!template) {
      for (const key of Object.keys(this._index)) {
        if (this._index[key].length > 0) {
          const randomIdx = this._index[key][Math.floor(Math.random() * this._index[key].length)];
          template = this.segments[randomIdx];
          break;
        }
      }
    }

    if (!template || !template.points) return null;

    // Transform normalized points to actual start→end vector
    return this._transformTemplate(template, startX, startY, endX, endY);
  }

  /**
   * Transform a normalized template to fit an actual movement vector.
   * 
   * The template has start=(0,0), end=(1,0).
   * We rotate and scale to map to the actual start→end.
   */
  _transformTemplate(template, startX, startY, endX, endY) {
    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx);

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const transformed = [];
    for (const [nx, ny] of template.points) {
      // Scale and rotate
      const rx = nx * distance;
      const ry = ny * distance;
      const x = startX + rx * cosA - ry * sinA;
      const y = startY + rx * sinA + ry * cosA;
      transformed.push([
        Math.round(x * 10) / 10,
        Math.round(y * 10) / 10
      ]);
    }

    return transformed;
  }

  /**
   * Get the velocity profile from a matching template.
   * Returns normalized velocity array (peak=1.0) if available.
   */
  getVelocityProfile(distCat, moveType = 'curved') {
    const key = `${distCat}_${moveType}`;
    const indices = this._index[key] || [];
    if (indices.length === 0) return null;

    const randomIdx = indices[Math.floor(Math.random() * indices.length)];
    const template = this.segments[randomIdx];
    return template.velocityProfile || null;
  }

  /**
   * Check if we have templates available.
   */
  hasTemplates() {
    return this.segments.length > 0;
  }

  /**
   * Get statistics about the template bank.
   */
  getStats() {
    const stats = {};
    for (const [key, indices] of Object.entries(this._index)) {
      stats[key] = indices.length;
    }
    return stats;
  }
}

// Exposed via Isolated World scope — invisible to the target website
void(SegmentMatcher);
