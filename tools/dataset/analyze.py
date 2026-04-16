"""
CaptchaSolve30k Motor Feature Extraction Pipeline v2

Uses tickInputs (240Hz physics ticks) for reliable, clean data.
The tickInputs have no NaN issues and consistent coordinate space (0-200).

Processes mouse trajectory data and extracts statistical distributions
of human motor behavior, outputting a compact motor-fingerprint.json.

Usage:
  python analyze.py                          # Analyze data/sample_1000.json
  python analyze.py --input data/full.json   # Analyze custom file
"""
import argparse
import json
import os
import sys

import numpy as np
from scipy import stats as scipy_stats


# ═══════════════════════════════════════════════════════════════
#  DATA LOADING
# ═══════════════════════════════════════════════════════════════

def load_tick_inputs(session):
    """
    Load tickInputs from a session into numpy arrays.
    tickInputs are at 240Hz = 4.167ms per tick.
    Coordinate space: 0-200 normalized grid.
    """
    ticks = session.get('tickInputs', [])
    if not ticks or len(ticks) < 50:
        return None

    n = len(ticks)
    x = np.array([t['x'] for t in ticks], dtype=np.float64)
    y = np.array([t['y'] for t in ticks], dtype=np.float64)
    is_down = np.array([t.get('isDown', False) for t in ticks], dtype=bool)

    # Time in ms (240Hz = 1 tick per 4.167ms)
    dt_ms = 1000.0 / 240.0
    t = np.arange(n) * dt_ms

    return x, y, is_down, t, dt_ms


# ═══════════════════════════════════════════════════════════════
#  MOVEMENT SEGMENTATION
# ═══════════════════════════════════════════════════════════════

def segment_movements(x, y, t, dt_ms, min_move_dist=2.0, min_pause_ticks=12):
    """
    Segment trajectory into individual point-to-point movements.
    
    A movement starts when speed exceeds threshold and ends when
    speed drops below threshold for min_pause_ticks (50ms at 240Hz).
    
    min_move_dist: minimum distance in grid units (200x200) to count as movement
    min_pause_ticks: 12 ticks = 50ms at 240Hz
    """
    if len(x) < 10:
        return []

    dx = np.diff(x)
    dy = np.diff(y)
    speed = np.sqrt(dx**2 + dy**2) / dt_ms  # units per ms

    # Movement threshold: 0.02 grid-units/ms = 4 units/sec minimum
    move_threshold = 0.02
    is_moving = speed > move_threshold

    movements = []
    in_movement = False
    start_idx = 0
    pause_count = 0

    for i in range(len(is_moving)):
        if is_moving[i]:
            if not in_movement:
                start_idx = i
                in_movement = True
            pause_count = 0
        else:
            if in_movement:
                pause_count += 1
                if pause_count >= min_pause_ticks:
                    end_idx = i - pause_count + 1
                    dist = np.sqrt(
                        (x[end_idx] - x[start_idx])**2 +
                        (y[end_idx] - y[start_idx])**2
                    )
                    duration_ms = (end_idx - start_idx) * dt_ms
                    if dist >= min_move_dist and duration_ms > 20:
                        movements.append({
                            'start_idx': int(start_idx),
                            'end_idx': int(end_idx),
                            'start_x': float(x[start_idx]),
                            'start_y': float(y[start_idx]),
                            'end_x': float(x[end_idx]),
                            'end_y': float(y[end_idx]),
                            'distance': float(dist),
                            'duration_ms': float(duration_ms)
                        })
                    in_movement = False
                    pause_count = 0

    # Final movement
    if in_movement:
        end_idx = len(x) - 1
        dist = np.sqrt((x[end_idx] - x[start_idx])**2 + (y[end_idx] - y[start_idx])**2)
        duration_ms = (end_idx - start_idx) * dt_ms
        if dist >= min_move_dist and duration_ms > 20:
            movements.append({
                'start_idx': int(start_idx),
                'end_idx': int(end_idx),
                'start_x': float(x[start_idx]),
                'start_y': float(y[start_idx]),
                'end_x': float(x[end_idx]),
                'end_y': float(y[end_idx]),
                'distance': float(dist),
                'duration_ms': float(duration_ms)
            })

    return movements


# ═══════════════════════════════════════════════════════════════
#  KINEMATIC ANALYSIS
# ═══════════════════════════════════════════════════════════════

def compute_kinematics(x, y, dt_ms):
    """
    Compute velocity, acceleration, jerk, curvature from position arrays.
    All values in grid-units per ms (normalized to 200x200 grid).
    """
    n = len(x)
    if n < 5:
        return None

    # Velocity (grid units / ms)
    vx = np.gradient(x, dt_ms)
    vy = np.gradient(y, dt_ms)
    speed = np.sqrt(vx**2 + vy**2)

    # Acceleration (grid units / ms^2)
    ax = np.gradient(vx, dt_ms)
    ay = np.gradient(vy, dt_ms)
    accel = np.sqrt(ax**2 + ay**2)

    # Curvature: |v x a| / |v|^3
    cross = np.abs(vx * ay - ax * vy)
    speed_cubed = speed**3
    safe_denom = np.where(speed_cubed > 1e-15, speed_cubed, 1e-15)
    curvature = cross / safe_denom

    return {
        'speed': speed,
        'accel': accel,
        'curvature': curvature,
        'vx': vx,
        'vy': vy
    }


def analyze_velocity_profile(speed, movement, dt_ms):
    """Analyze velocity profile shape of a single movement."""
    start = movement['start_idx']
    end = movement['end_idx']
    segment = speed[start:end + 1]

    if len(segment) < 5:
        return None

    peak_idx = np.argmax(segment)
    duration = len(segment)

    time_to_peak_frac = peak_idx / max(duration - 1, 1)
    peak_velocity = float(np.max(segment))
    mean_velocity = float(np.mean(segment))

    # Asymmetry: deceleration_time / acceleration_time
    accel_time = peak_idx
    decel_time = duration - peak_idx - 1
    asymmetry = decel_time / max(accel_time, 1) if accel_time > 0 else 1.0

    return {
        'time_to_peak_fraction': float(time_to_peak_frac),
        'peak_velocity': peak_velocity,
        'mean_velocity': mean_velocity,
        'asymmetry': float(min(asymmetry, 10.0)),  # Cap outliers
        'duration_ms': float(duration * dt_ms)
    }


def detect_submovements(speed, movement, dt_ms):
    """Detect ballistic + corrective submovement phases."""
    start = movement['start_idx']
    end = movement['end_idx']
    segment = speed[start:end + 1]

    if len(segment) < 10:
        return {'count': 1, 'ballistic_fraction': 1.0, 'corrective_fraction': 0.0}

    peak = np.max(segment)
    if peak < 1e-10:
        return {'count': 1, 'ballistic_fraction': 1.0, 'corrective_fraction': 0.0}

    threshold = peak * 0.15

    submove_count = 1
    in_trough = False
    for i in range(1, len(segment) - 1):
        if segment[i] < threshold and not in_trough:
            in_trough = True
        elif segment[i] > threshold and in_trough:
            submove_count += 1
            in_trough = False

    return {
        'count': int(submove_count),
        'ballistic_fraction': float(1.0 / submove_count),
        'corrective_fraction': float(max(0, submove_count - 1) / submove_count)
    }


def detect_overshoot(x, y, movement):
    """Detect cursor overshoot past target."""
    start = movement['start_idx']
    end = movement['end_idx']

    sx, sy = movement['start_x'], movement['start_y']
    ex, ey = movement['end_x'], movement['end_y']

    dx, dy = ex - sx, ey - sy
    dist = np.sqrt(dx**2 + dy**2)
    if dist < 1:
        return {'has_overshoot': False, 'magnitude': 0, 'path_efficiency': 1.0}

    # Project each point onto movement axis
    max_proj = 0
    for i in range(start, min(end + 1, len(x))):
        px, py = x[i] - sx, y[i] - sy
        proj = (px * dx + py * dy) / dist
        max_proj = max(max_proj, proj)

    has_overshoot = max_proj > dist * 1.03  # >3% past target
    magnitude = float(max_proj - dist) if has_overshoot else 0.0

    # Path efficiency
    seg_x = x[start:end + 1]
    seg_y = y[start:end + 1]
    actual_dist = float(np.sum(np.sqrt(np.diff(seg_x)**2 + np.diff(seg_y)**2)))
    efficiency = dist / max(actual_dist, 0.01)

    return {
        'has_overshoot': bool(has_overshoot),
        'magnitude': float(magnitude),
        'path_efficiency': float(min(efficiency, 1.0))
    }


def analyze_jitter(x, y, speed, dt_ms):
    """Analyze micro-tremor during stationary periods."""
    # Stationary = speed < 0.01 grid-units/ms for > 100ms
    stationary_threshold = 0.01
    min_stationary_ticks = int(100 / dt_ms)

    is_stationary = speed < stationary_threshold
    jitter_amplitudes = []

    in_stationary = False
    start = 0
    for i in range(len(is_stationary)):
        if is_stationary[i]:
            if not in_stationary:
                start = i
                in_stationary = True
        else:
            if in_stationary and (i - start) > min_stationary_ticks:
                seg_x = x[start:i]
                seg_y = y[start:i]
                if len(seg_x) > 5:
                    amp = float(np.sqrt(np.var(seg_x) + np.var(seg_y)))
                    if np.isfinite(amp):
                        jitter_amplitudes.append(amp)
            in_stationary = False

    if not jitter_amplitudes:
        return {'amplitude_mean': 0.3, 'amplitude_std': 0.1, 'samples': 0}

    return {
        'amplitude_mean': float(np.mean(jitter_amplitudes)),
        'amplitude_std': float(np.std(jitter_amplitudes)),
        'samples': len(jitter_amplitudes)
    }


def analyze_click_timing(is_down, dt_ms):
    """Analyze mouse button hold durations."""
    hold_durations = []
    in_press = False
    press_start = 0

    for i in range(len(is_down)):
        if is_down[i] and not in_press:
            press_start = i
            in_press = True
        elif not is_down[i] and in_press:
            hold_ms = (i - press_start) * dt_ms
            if hold_ms > 5:  # Filter out noise
                hold_durations.append(hold_ms)
            in_press = False

    if not hold_durations:
        return {'mean': 95, 'std': 32, 'median': 88, 'samples': 0}

    return {
        'mean': float(np.mean(hold_durations)),
        'std': float(np.std(hold_durations)),
        'median': float(np.median(hold_durations)),
        'p5': float(np.percentile(hold_durations, 5)),
        'p95': float(np.percentile(hold_durations, 95)),
        'samples': len(hold_durations)
    }


# ═══════════════════════════════════════════════════════════════
#  DISTRIBUTION FITTING
# ═══════════════════════════════════════════════════════════════

def fit_distribution(data, name=""):
    """Fit data to distributions and return best fit parameters."""
    data = np.array(data, dtype=float)
    data = data[np.isfinite(data)]

    if len(data) < 10:
        return {
            'mean': float(np.mean(data)) if len(data) > 0 else 0,
            'std': float(np.std(data)) if len(data) > 0 else 1,
            'samples': len(data),
            'distribution': 'normal'
        }

    result = {
        'mean': float(np.mean(data)),
        'std': float(np.std(data)),
        'median': float(np.median(data)),
        'min': float(np.min(data)),
        'max': float(np.max(data)),
        'p5': float(np.percentile(data, 5)),
        'p25': float(np.percentile(data, 25)),
        'p50': float(np.percentile(data, 50)),
        'p75': float(np.percentile(data, 75)),
        'p95': float(np.percentile(data, 95)),
        'samples': len(data)
    }

    # Try fitting positive-data distributions
    pos_data = data[data > 0]
    best_ks = float('inf')

    if len(pos_data) > 20:
        for dist_name, dist_fn in [
            ('lognormal', scipy_stats.lognorm),
            ('gamma', scipy_stats.gamma),
        ]:
            try:
                params = dist_fn.fit(pos_data)
                ks_stat, _ = scipy_stats.kstest(pos_data, dist_fn.cdf, args=params)
                if ks_stat < best_ks:
                    best_ks = ks_stat
                    result['distribution'] = dist_name
                    result['fit_params'] = [float(p) for p in params]
                    result['ks_statistic'] = float(ks_stat)
            except Exception:
                pass

    # Always try normal
    try:
        params = scipy_stats.norm.fit(data)
        ks_stat, _ = scipy_stats.kstest(data, scipy_stats.norm.cdf, args=params)
        if ks_stat < best_ks:
            result['distribution'] = 'normal'
            result['fit_params'] = [float(p) for p in params]
            result['ks_statistic'] = float(ks_stat)
    except Exception:
        if 'distribution' not in result:
            result['distribution'] = 'normal'

    return result


# ═══════════════════════════════════════════════════════════════
#  SESSION ANALYSIS
# ═══════════════════════════════════════════════════════════════

def analyze_session(session):
    """Analyze a single session and extract all motor features."""
    if session.get('touchscreen', False):
        return None

    loaded = load_tick_inputs(session)
    if loaded is None:
        return None

    x, y, is_down, t, dt_ms = loaded

    # Skip sessions where cursor never moves
    total_displacement = np.sqrt((x[-1] - x[0])**2 + (y[-1] - y[0])**2)
    if total_displacement < 5:
        return None

    # Compute kinematics
    kin = compute_kinematics(x, y, dt_ms)
    if kin is None:
        return None

    # Segment movements
    movements = segment_movements(x, y, t, dt_ms)
    if len(movements) < 1:
        return None

    # Per-movement analysis
    velocity_profiles = []
    submovements = []
    overshoots = []
    all_peak_velocities = []
    all_mean_velocities = []
    all_durations = []
    all_distances = []
    all_efficiencies = []
    all_curvatures = []

    for mov in movements:
        vp = analyze_velocity_profile(kin['speed'], mov, dt_ms)
        if vp:
            velocity_profiles.append(vp)
            all_peak_velocities.append(vp['peak_velocity'])
            all_mean_velocities.append(vp['mean_velocity'])
            all_durations.append(vp['duration_ms'])
            all_distances.append(mov['distance'])

        sm = detect_submovements(kin['speed'], mov, dt_ms)
        submovements.append(sm)

        ov = detect_overshoot(x, y, mov)
        overshoots.append(ov)
        all_efficiencies.append(ov['path_efficiency'])

        # Mean curvature during movement
        start, end = mov['start_idx'], mov['end_idx']
        if end > start + 3:
            seg_curv = kin['curvature'][start:end + 1]
            finite_curv = seg_curv[np.isfinite(seg_curv)]
            if len(finite_curv) > 0:
                # Cap extreme values
                capped = np.clip(finite_curv, 0, 10)
                all_curvatures.append(float(np.mean(capped)))

    # Jitter
    jitter = analyze_jitter(x, y, kin['speed'], dt_ms)

    # Click timing
    click_timing = analyze_click_timing(is_down, dt_ms)

    return {
        'session_id': session.get('index', 0),
        'game_type': session.get('gameType', 'unknown'),
        'duration_ms': session.get('duration', 0),
        'movement_count': len(movements),
        'peak_velocities': all_peak_velocities,
        'mean_velocities': all_mean_velocities,
        'durations': all_durations,
        'distances': all_distances,
        'path_efficiencies': all_efficiencies,
        'curvatures': all_curvatures,
        'velocity_profiles': velocity_profiles,
        'submovements': submovements,
        'overshoots': overshoots,
        'jitter': jitter,
        'click_timing': click_timing
    }


# ═══════════════════════════════════════════════════════════════
#  AGGREGATION
# ═══════════════════════════════════════════════════════════════

def aggregate_results(results):
    """Aggregate per-session results into a motor fingerprint."""
    all_peak_v = []
    all_mean_v = []
    all_durations = []
    all_distances = []
    all_efficiencies = []
    all_curvatures = []
    all_ttp = []
    all_asym = []
    all_submove = []
    overshoot_flags = []
    overshoot_mags = []
    all_jitter = []
    all_hold = []
    movements_per_session = []

    for r in results:
        all_peak_v.extend(r['peak_velocities'])
        all_mean_v.extend(r['mean_velocities'])
        all_durations.extend(r['durations'])
        all_distances.extend(r['distances'])
        all_efficiencies.extend(r['path_efficiencies'])
        all_curvatures.extend(r['curvatures'])
        movements_per_session.append(r['movement_count'])

        for vp in r['velocity_profiles']:
            all_ttp.append(vp['time_to_peak_fraction'])
            all_asym.append(vp['asymmetry'])

        for sm in r['submovements']:
            all_submove.append(sm['count'])

        for ov in r['overshoots']:
            overshoot_flags.append(ov['has_overshoot'])
            if ov['has_overshoot']:
                overshoot_mags.append(ov['magnitude'])

        if r['jitter']['samples'] > 0:
            all_jitter.append(r['jitter']['amplitude_mean'])

        if r['click_timing']['samples'] > 0:
            all_hold.append(r['click_timing']['mean'])

    # Fitts' Law regression
    fitts = _fit_fitts_law(all_distances, all_durations)

    fingerprint = {
        '_meta': {
            'dataset': 'CaptchaSolve30k',
            'sessions_analyzed': len(results),
            'total_movements': len(all_peak_v),
            'movements_per_session_mean': float(np.mean(movements_per_session)),
            'coordinate_space': '200x200 normalized grid',
            'sampling_rate_hz': 240,
            'dt_ms': round(1000 / 240, 3)
        },
        'velocity': {
            'peak': fit_distribution(all_peak_v, 'peak_velocity'),
            'mean': fit_distribution(all_mean_v, 'mean_velocity'),
        },
        'duration': fit_distribution(all_durations, 'duration'),
        'distance': fit_distribution(all_distances, 'distance'),
        'pathEfficiency': fit_distribution(all_efficiencies, 'path_efficiency'),
        'curvature': fit_distribution(all_curvatures, 'curvature'),
        'velocityProfile': {
            'time_to_peak_fraction': fit_distribution(all_ttp, 'ttp'),
            'asymmetry': fit_distribution(all_asym, 'asymmetry'),
        },
        'submovements': {
            'count': fit_distribution(all_submove, 'submove_count'),
            'ballistic_fraction_mean': float(np.mean([1.0 / max(c, 1) for c in all_submove])) if all_submove else 0.65,
        },
        'overshoot': {
            'probability': float(np.mean(overshoot_flags)) if overshoot_flags else 0.2,
            'magnitude': fit_distribution(overshoot_mags, 'overshoot') if len(overshoot_mags) > 5 else {'mean': 3.0, 'std': 1.5, 'samples': len(overshoot_mags)},
            'total_overshoots': int(sum(overshoot_flags)),
            'total_movements': len(overshoot_flags)
        },
        'jitter': {
            'amplitude': fit_distribution(all_jitter, 'jitter') if len(all_jitter) > 5 else {'mean': 0.3, 'std': 0.1, 'samples': len(all_jitter)},
        },
        'clickTiming': {
            'hold_duration': fit_distribution(all_hold, 'hold') if len(all_hold) > 5 else {'mean': 95, 'std': 32, 'samples': len(all_hold)},
        },
        'fittsLaw': fitts
    }

    return fingerprint


def _fit_fitts_law(distances, durations):
    """Fit Fitts' Law: MT = a + b * log2(D)"""
    if len(distances) < 20:
        return {'a': 200, 'b': 150, 'r_squared': 0}

    d = np.array(distances)
    mt = np.array(durations)

    mask = (d > 2) & (mt > 20) & (mt < 3000) & (d < 200)
    d, mt = d[mask], mt[mask]

    if len(d) < 20:
        return {'a': 200, 'b': 150, 'r_squared': 0}

    log_d = np.log2(d + 1)
    try:
        slope, intercept, r_value, _, std_err = scipy_stats.linregress(log_d, mt)
        return {
            'a': float(intercept),
            'b': float(slope),
            'r_squared': float(r_value**2),
            'std_err': float(std_err)
        }
    except Exception:
        return {'a': 200, 'b': 150, 'r_squared': 0}


# ═══════════════════════════════════════════════════════════════
#  MAIN
# ═══════════════════════════════════════════════════════════════

def main():
    parser = argparse.ArgumentParser(description='Analyze CaptchaSolve30k motor features')
    parser.add_argument('--input', type=str, default='data/sample_1000.json')
    parser.add_argument('--output', type=str, default=None)
    args = parser.parse_args()

    input_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.input)
    if not os.path.exists(input_path):
        print(f"Error: {input_path} not found. Run download_sample.py first.")
        sys.exit(1)

    print(f"Loading: {input_path}")
    with open(input_path, 'r') as f:
        sessions = json.load(f)
    print(f"Loaded {len(sessions)} sessions")

    results = []
    errors = 0
    for i, session in enumerate(sessions):
        result = analyze_session(session)
        if result:
            results.append(result)
        else:
            errors += 1
        if (i + 1) % 100 == 0:
            print(f"  {i+1}/{len(sessions)}: {len(results)} valid, {errors} skipped")

    print(f"\nDone: {len(results)} valid sessions, {errors} skipped")

    if not results:
        print("ERROR: No valid sessions!")
        sys.exit(1)

    fingerprint = aggregate_results(results)

    output_path = args.output or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'data', 'motor_fingerprint.json')
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with open(output_path, 'w') as f:
        json.dump(fingerprint, f, indent=2)

    size_kb = os.path.getsize(output_path) / 1024
    print(f"\nSaved: {output_path} ({size_kb:.1f} KB)")

    # Print summary (ASCII only)
    m = fingerprint['_meta']
    print(f"\n=== MOTOR FINGERPRINT SUMMARY ===")
    print(f"Sessions: {m['sessions_analyzed']}, Movements: {m['total_movements']}")
    print(f"Movements/session: {m['movements_per_session_mean']:.1f}")
    v = fingerprint['velocity']
    print(f"\nPeak velocity: {v['peak']['mean']:.4f} +/- {v['peak']['std']:.4f} units/ms ({v['peak'].get('distribution','?')})")
    print(f"Mean velocity: {v['mean']['mean']:.4f} +/- {v['mean']['std']:.4f} units/ms")
    d = fingerprint['duration']
    print(f"Duration: {d['mean']:.0f} +/- {d['std']:.0f} ms")
    print(f"Distance: {fingerprint['distance']['mean']:.1f} +/- {fingerprint['distance']['std']:.1f} units")
    print(f"Path efficiency: {fingerprint['pathEfficiency']['mean']:.3f}")
    print(f"Curvature: {fingerprint['curvature']['mean']:.4f}")
    vp = fingerprint['velocityProfile']
    print(f"\nVelocity profile:")
    print(f"  Time-to-peak: {vp['time_to_peak_fraction']['mean']:.3f}")
    print(f"  Asymmetry: {vp['asymmetry']['mean']:.3f}")
    print(f"Submovements: {fingerprint['submovements']['count']['mean']:.2f}/movement")
    print(f"Overshoot: {fingerprint['overshoot']['probability']:.1%}")
    print(f"Jitter: {fingerprint['jitter']['amplitude']['mean']:.4f}")
    print(f"Click hold: {fingerprint['clickTiming']['hold_duration']['mean']:.0f} ms")
    fl = fingerprint['fittsLaw']
    print(f"Fitts' Law: MT = {fl['a']:.0f} + {fl['b']:.0f} * log2(D), R2={fl['r_squared']:.3f}")


if __name__ == '__main__':
    main()
