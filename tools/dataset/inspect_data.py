"""Quick inspection of dataset structure"""
import json
import numpy as np

sessions = json.load(open('data/sample_1000.json'))
s = sessions[0]
print('Keys:', list(s.keys()))
print()

# Check tickInputs (240Hz physics ticks)
ti = s.get('tickInputs', [])
print(f'tickInputs: {len(ti)} entries')
if ti:
    for i in range(min(10, len(ti))):
        t = ti[i]
        print(f"  tick {i}: x={t['x']:.2f} y={t['y']:.2f} isDown={t.get('isDown', False)}")

    xs = [t['x'] for t in ti]
    ys = [t['y'] for t in ti]
    print(f'\n  X range: {min(xs):.2f} to {max(xs):.2f}')
    print(f'  Y range: {min(ys):.2f} to {max(ys):.2f}')

    x = np.array(xs)
    y = np.array(ys)
    dx = np.diff(x)
    dy = np.diff(y)
    speed = np.sqrt(dx**2 + dy**2)
    print(f'\n  Speed: mean={speed.mean():.4f} max={speed.max():.4f}')
    print(f'  Moving samples: {(speed > 0.1).sum()} / {len(speed)}')

    # Check NaN in inputStream
    import base64, struct
    data = base64.b64decode(s['inputStream'])
    n = min(20, len(data) // 9)
    print(f'\ninputStream first {n} raw samples:')
    for i in range(n):
        offset = i * 9
        xi, yi = struct.unpack('<ff', data[offset:offset+8])
        btn = data[offset+8]
        nan_flag = '*NaN*' if (np.isnan(xi) or np.isnan(yi)) else ''
        print(f'  [{i}] x={xi:.4f} y={yi:.4f} btn={btn} {nan_flag}')
