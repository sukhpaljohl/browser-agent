"""
CaptchaSolve30k inputStream Decoder

Decodes the base64-encoded binary mouse trajectory data.
Format per sample (9 bytes):
  - 4 bytes: X position (float32, little-endian), range 0-200
  - 4 bytes: Y position (float32, little-endian), range 0-200
  - 1 byte:  Button state (0 = up, 1 = down)

Sampling rate: 1000 Hz (1 sample per millisecond)
Coordinate space: 200x200 normalized grid
"""
import base64
import struct
import numpy as np


def decode_input_stream(b64_stream, sample_count):
    """
    Decode a base64-encoded inputStream into a list of samples.

    Returns list of dicts: [{x, y, isDown, t}, ...]
    where t is timestamp in milliseconds (at 1000Hz, t = sample index)
    """
    data = base64.b64decode(b64_stream)
    expected_size = sample_count * 9
    if len(data) < expected_size:
        # Some sessions may have fewer bytes than expected
        sample_count = len(data) // 9

    samples = []
    for i in range(sample_count):
        offset = i * 9
        x, y = struct.unpack('<ff', data[offset:offset + 8])
        is_down = data[offset + 8] == 1
        samples.append({
            'x': float(x),
            'y': float(y),
            'isDown': is_down,
            't': i  # ms at 1000Hz
        })

    return samples


def decode_to_numpy(b64_stream, sample_count):
    """
    Decode inputStream into numpy arrays for efficient vectorized analysis.

    Returns:
        x: np.array of X positions
        y: np.array of Y positions
        is_down: np.array of button states (bool)
        t: np.array of timestamps (ms)
    """
    data = base64.b64decode(b64_stream)
    actual_count = min(sample_count, len(data) // 9)

    x = np.zeros(actual_count, dtype=np.float32)
    y = np.zeros(actual_count, dtype=np.float32)
    is_down = np.zeros(actual_count, dtype=bool)

    for i in range(actual_count):
        offset = i * 9
        x[i], y[i] = struct.unpack('<ff', data[offset:offset + 8])
        is_down[i] = data[offset + 8] == 1

    t = np.arange(actual_count, dtype=np.float32)  # ms at 1000Hz

    return x, y, is_down, t


def decode_tick_inputs(tick_inputs):
    """
    Decode the tickInputs array (240Hz physics ticks) into numpy arrays.
    tickInputs format: [{x, y, isDown, sampleIndex}, ...]
    """
    n = len(tick_inputs)
    x = np.array([t['x'] for t in tick_inputs], dtype=np.float32)
    y = np.array([t['y'] for t in tick_inputs], dtype=np.float32)
    is_down = np.array([t.get('isDown', False) for t in tick_inputs], dtype=bool)
    sample_idx = np.array([t.get('sampleIndex', i) for i, t in enumerate(tick_inputs)], dtype=np.int32)

    return x, y, is_down, sample_idx


def segment_movements(x, y, t, min_move_dist=1.0, min_pause_ms=50):
    """
    Segment a trajectory into individual movements separated by pauses.

    A movement starts when the cursor begins moving (velocity > threshold)
    and ends when it stops (velocity drops below threshold for > min_pause_ms).

    Returns list of movement dicts:
    [{start_idx, end_idx, start_x, start_y, end_x, end_y, distance, duration_ms}, ...]
    """
    if len(x) < 3:
        return []

    # Compute instantaneous velocity
    dx = np.diff(x)
    dy = np.diff(y)
    velocity = np.sqrt(dx**2 + dy**2)

    # Threshold: movement vs. stationary
    # In 200x200 grid at 1000Hz, a very slow movement is ~0.5 units/ms
    move_threshold = 0.3

    is_moving = velocity > move_threshold

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
                if pause_count >= min_pause_ms:
                    end_idx = i - pause_count + 1
                    dist = np.sqrt(
                        (x[end_idx] - x[start_idx])**2 +
                        (y[end_idx] - y[start_idx])**2
                    )
                    if dist >= min_move_dist:
                        movements.append({
                            'start_idx': int(start_idx),
                            'end_idx': int(end_idx),
                            'start_x': float(x[start_idx]),
                            'start_y': float(y[start_idx]),
                            'end_x': float(x[end_idx]),
                            'end_y': float(y[end_idx]),
                            'distance': float(dist),
                            'duration_ms': int(end_idx - start_idx)
                        })
                    in_movement = False
                    pause_count = 0

    # Handle movement that extends to end of data
    if in_movement:
        end_idx = len(x) - 1
        dist = np.sqrt(
            (x[end_idx] - x[start_idx])**2 +
            (y[end_idx] - y[start_idx])**2
        )
        if dist >= min_move_dist:
            movements.append({
                'start_idx': int(start_idx),
                'end_idx': int(end_idx),
                'start_x': float(x[start_idx]),
                'start_y': float(y[start_idx]),
                'end_x': float(x[end_idx]),
                'end_y': float(y[end_idx]),
                'distance': float(dist),
                'duration_ms': int(end_idx - start_idx)
            })

    return movements
