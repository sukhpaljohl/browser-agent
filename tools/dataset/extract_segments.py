"""
Trajectory Segment Extractor

Extracts real human trajectory segments from CaptchaSolve30k and saves
them as a compact JSON "template bank" that the extension uses to
generate new movements from real human path shapes.

Each segment is normalized to a unit vector (0→1) so it can be rotated
and scaled to fit any start→end pair at runtime.

Segments are classified by:
  - Distance category: short (<30), medium (30-100), long (>100)
  - Movement type: linear, curved, precision, with_overshoot
  - Confidence: clean segments with clear start/end

Output: trajectory-segments.json (~200KB) containing ~2000 template segments.

Usage:
  python extract_segments.py
  python extract_segments.py --max-segments 5000
"""
import argparse
import json
import math
import os
import sys

import numpy as np

from analyze import load_tick_inputs, segment_movements


def normalize_segment(x, y, start_idx, end_idx):
    """
    Normalize a trajectory segment so:
      - Start point = (0, 0)
      - End point = (1, 0)
      - All intermediate points transformed accordingly
    
    This allows the segment to be rotated and scaled to any
    actual start→end vector at runtime.
    """
    seg_x = x[start_idx:end_idx + 1].copy()
    seg_y = y[start_idx:end_idx + 1].copy()

    if len(seg_x) < 3:
        return None

    # Translate so start = origin
    sx, sy = seg_x[0], seg_y[0]
    seg_x -= sx
    seg_y -= sy

    # Compute rotation angle to align end point with X axis
    ex, ey = seg_x[-1], seg_y[-1]
    dist = math.sqrt(ex**2 + ey**2)
    if dist < 0.5:
        return None

    angle = -math.atan2(ey, ex)

    # Rotate all points
    cos_a = math.cos(angle)
    sin_a = math.sin(angle)
    rx = seg_x * cos_a - seg_y * sin_a
    ry = seg_x * sin_a + seg_y * cos_a

    # Scale so end point = (1, 0)
    scale = 1.0 / dist
    rx *= scale
    ry *= scale

    # Downsample to ~50 control points for storage efficiency
    n = len(rx)
    if n <= 50:
        indices = range(n)
    else:
        indices = np.linspace(0, n - 1, 50, dtype=int)

    points = [[round(float(rx[i]), 4), round(float(ry[i]), 4)] for i in indices]

    return points


def classify_segment(distance, path_efficiency, max_perp_deviation, has_overshoot, duration):
    """
    Classify a movement segment by type.
    """
    # Distance category
    if distance < 30:
        dist_cat = 'short'
    elif distance < 100:
        dist_cat = 'medium'
    else:
        dist_cat = 'long'

    # Movement type
    if has_overshoot:
        move_type = 'with_overshoot'
    elif path_efficiency > 0.95:
        move_type = 'linear'
    elif duration > 400 and distance < 50:
        move_type = 'precision'
    else:
        move_type = 'curved'

    return dist_cat, move_type


def compute_velocity_profile(x, y, start_idx, end_idx):
    """
    Compute a normalized velocity profile for a segment.
    Returns ~20 velocity samples normalized to peak = 1.0.
    """
    seg_x = x[start_idx:end_idx + 1]
    seg_y = y[start_idx:end_idx + 1]

    if len(seg_x) < 5:
        return None

    dx = np.diff(seg_x)
    dy = np.diff(seg_y)
    speed = np.sqrt(dx**2 + dy**2)

    peak = np.max(speed)
    if peak < 0.01:
        return None

    # Normalize to peak = 1.0
    norm_speed = speed / peak

    # Downsample to 20 points
    n = len(norm_speed)
    if n <= 20:
        return [round(float(v), 3) for v in norm_speed]
    else:
        indices = np.linspace(0, n - 1, 20, dtype=int)
        return [round(float(norm_speed[i]), 3) for i in indices]


def extract_segments_from_session(session, max_per_session=20):
    """
    Extract normalized trajectory segments from a single session.
    Uses tickInputs (240Hz) for clean, reliable data.
    """
    if session.get('touchscreen', False):
        return []  # Mouse only

    loaded = load_tick_inputs(session)
    if loaded is None:
        return []

    x, y, is_down, t, dt_ms = loaded

    # Skip sessions where cursor never moves
    total_displacement = np.sqrt((x[-1] - x[0])**2 + (y[-1] - y[0])**2)
    if total_displacement < 5:
        return []

    # Segment into movements
    movements = segment_movements(x, y, t, dt_ms)
    if not movements:
        return []

    segments = []
    for mov in movements[:max_per_session]:
        # Skip very short or very long movements
        if mov['duration_ms'] < 20 or mov['duration_ms'] > 3000:
            continue
        if mov['distance'] < 3:
            continue

        # Normalize the trajectory
        points = normalize_segment(x, y, mov['start_idx'], mov['end_idx'])
        if not points:
            continue

        # Compute velocity profile
        vel_profile = compute_velocity_profile(x, y, mov['start_idx'], mov['end_idx'])

        # Compute path efficiency and deviation
        start_end_dist = mov['distance']
        actual_dist = sum(
            math.sqrt((x[i+1] - x[i])**2 + (y[i+1] - y[i])**2)
            for i in range(mov['start_idx'], mov['end_idx'])
        )
        efficiency = start_end_dist / max(actual_dist, 0.01)

        # Max perpendicular deviation
        sx, sy = mov['start_x'], mov['start_y']
        ex, ey = mov['end_x'], mov['end_y']
        dx, dy = ex - sx, ey - sy
        dist = math.sqrt(dx**2 + dy**2)
        max_perp = 0
        if dist > 1:
            for i in range(mov['start_idx'], mov['end_idx'] + 1):
                px, py = x[i] - sx, y[i] - sy
                proj = (px * dx + py * dy) / (dist**2)
                cx, cy = sx + proj * dx, sy + proj * dy
                perp = math.sqrt((x[i] - cx)**2 + (y[i] - cy)**2)
                max_perp = max(max_perp, perp)

        # Check overshoot
        max_proj = 0
        if dist > 1:
            for i in range(mov['start_idx'], mov['end_idx'] + 1):
                px, py = x[i] - sx, y[i] - sy
                proj = (px * dx + py * dy) / dist
                max_proj = max(max_proj, proj)
        has_overshoot = max_proj > dist * 1.02

        # Classify
        dist_cat, move_type = classify_segment(
            mov['distance'], efficiency, max_perp, has_overshoot, mov['duration_ms']
        )

        segment = {
            'type': move_type,
            'distCat': dist_cat,
            'distance': round(float(mov['distance']), 1),
            'durationMs': int(mov['duration_ms']),
            'points': points,
            'efficiency': round(float(efficiency), 3),
            'maxPerp': round(float(max_perp), 2),
            'hasOvershoot': has_overshoot,
        }

        if vel_profile:
            segment['velocityProfile'] = vel_profile

        segments.append(segment)

    return segments


def main():
    parser = argparse.ArgumentParser(description='Extract trajectory segments')
    parser.add_argument('--input', type=str, default='data/sample_1000.json')
    parser.add_argument('--output', type=str, default=None)
    parser.add_argument('--max-segments', type=int, default=2000)
    args = parser.parse_args()

    input_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.input)
    if not os.path.exists(input_path):
        print(f"Error: Input file not found: {input_path}")
        sys.exit(1)

    print(f"Loading dataset from: {input_path}")
    with open(input_path, 'r') as f:
        sessions = json.load(f)
    print(f"Loaded {len(sessions)} sessions")

    all_segments = []
    for i, session in enumerate(sessions):
        segs = extract_segments_from_session(session)
        all_segments.extend(segs)

        if (i + 1) % 100 == 0:
            print(f"  Processed {i + 1}/{len(sessions)} sessions ({len(all_segments)} segments)")

    print(f"\nTotal segments extracted: {len(all_segments)}")

    # Balance categories — ensure diversity
    categories = {}
    for seg in all_segments:
        key = f"{seg['distCat']}_{seg['type']}"
        if key not in categories:
            categories[key] = []
        categories[key].append(seg)

    print("\nCategory distribution:")
    for key, segs in sorted(categories.items()):
        print(f"  {key}: {len(segs)}")

    # Sample balanced set up to max_segments
    balanced = []
    per_cat = max(50, args.max_segments // len(categories)) if categories else 0
    for key, segs in categories.items():
        sampled = segs[:per_cat] if len(segs) <= per_cat else [
            segs[i] for i in np.random.choice(len(segs), per_cat, replace=False)
        ]
        balanced.extend(sampled)

    # Trim to max
    if len(balanced) > args.max_segments:
        indices = np.random.choice(len(balanced), args.max_segments, replace=False)
        balanced = [balanced[i] for i in indices]

    print(f"\nFinal segment count: {len(balanced)}")

    # Build output structure
    output = {
        '_meta': {
            'dataset': 'CaptchaSolve30k',
            'total_segments': len(balanced),
            'categories': {k: min(len(v), per_cat) for k, v in categories.items()},
            'coordinate_system': 'normalized: start=(0,0), end=(1,0)',
            'usage': 'Rotate and scale points to fit actual start→end vector'
        },
        'segments': balanced
    }

    # Save
    if args.output:
        output_path = args.output
    else:
        output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'trajectory_segments.json')

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    # Custom encoder for numpy types
    class NumpyEncoder(json.JSONEncoder):
        def default(self, obj):
            if isinstance(obj, (np.bool_, np.bool)):
                return bool(obj)
            if isinstance(obj, np.integer):
                return int(obj)
            if isinstance(obj, np.floating):
                return float(obj)
            if isinstance(obj, np.ndarray):
                return obj.tolist()
            return super().default(obj)

    with open(output_path, 'w') as f:
        json.dump(output, f, cls=NumpyEncoder)

    size_kb = os.path.getsize(output_path) / 1024
    print(f"\nTrajectory segments saved to: {output_path} ({size_kb:.1f} KB)")


if __name__ == '__main__':
    main()
