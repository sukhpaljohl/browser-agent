"""
Export Motor Fingerprint + Trajectory Segments to Extension

Copies the analysis outputs to the extension/data/ directory where
the browser extension can load them at runtime.

Usage:
  python export_fingerprint.py
"""
import json
import os
import shutil
import sys


def main():
    base_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(base_dir, 'data')
    ext_data_dir = os.path.join(base_dir, '..', '..', 'extension', 'data')
    os.makedirs(ext_data_dir, exist_ok=True)

    files_to_copy = [
        ('motor_fingerprint.json', 'motor-fingerprint.json'),
        ('trajectory_segments.json', 'trajectory-segments.json'),
    ]

    for src_name, dst_name in files_to_copy:
        src = os.path.join(data_dir, src_name)
        dst = os.path.join(ext_data_dir, dst_name)

        if not os.path.exists(src):
            print(f"Warning: {src_name} not found in {data_dir}")
            print(f"  Run analyze.py and extract_segments.py first.")
            continue

        shutil.copy2(src, dst)
        size_kb = os.path.getsize(dst) / 1024
        print(f"[OK] Exported {src_name} -> extension/data/{dst_name} ({size_kb:.1f} KB)")

    # Validate the fingerprint has expected fields
    fp_path = os.path.join(ext_data_dir, 'motor-fingerprint.json')
    if os.path.exists(fp_path):
        with open(fp_path) as f:
            fp = json.load(f)

        required_keys = ['velocity', 'duration', 'curvature', 'velocityProfile',
                         'submovements', 'overshoot', 'jitter', 'clickTiming', 'fittsLaw']
        missing = [k for k in required_keys if k not in fp]
        if missing:
            print(f"\n⚠ Missing keys in fingerprint: {missing}")
        else:
            print(f"\n✓ Fingerprint validated — all {len(required_keys)} required fields present")
            print(f"  Sessions: {fp['_meta']['sessions_analyzed']}")
            print(f"  Movements: {fp['_meta']['total_movements']}")

    # Validate segments
    seg_path = os.path.join(ext_data_dir, 'trajectory-segments.json')
    if os.path.exists(seg_path):
        with open(seg_path) as f:
            segs = json.load(f)
        print(f"✓ Segments validated — {segs['_meta']['total_segments']} templates")
        for cat, count in sorted(segs['_meta']['categories'].items()):
            print(f"    {cat}: {count}")

    print("\n✓ Export complete. Extension can now load data from extension/data/")


if __name__ == '__main__':
    main()
