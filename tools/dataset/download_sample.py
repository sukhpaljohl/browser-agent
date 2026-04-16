"""
CaptchaSolve30k Sample Downloader
Downloads a configurable number of sessions from the HuggingFace dataset.

Usage:
  python download_sample.py              # Download 1000 sessions (default)
  python download_sample.py --count 500  # Download 500 sessions
"""
import argparse
import json
import os
import sys

def main():
    parser = argparse.ArgumentParser(description='Download CaptchaSolve30k sample')
    parser.add_argument('--count', type=int, default=1000, help='Number of sessions to download')
    parser.add_argument('--output', type=str, default='data', help='Output directory')
    args = parser.parse_args()

    try:
        from datasets import load_dataset
    except ImportError:
        print("Installing required packages...")
        os.system(f'"{sys.executable}" -m pip install datasets pyarrow')
        from datasets import load_dataset

    output_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), args.output)
    os.makedirs(output_dir, exist_ok=True)

    print(f"Downloading {args.count} sessions from CaptchaSolve30k...")
    print("This may take a moment on first run (downloading dataset index)...")

    # Load dataset in streaming mode to avoid downloading everything
    dataset = load_dataset("Capycap-AI/CaptchaSolve30k", split="train", streaming=True)

    sessions = []
    for i, sample in enumerate(dataset):
        if i >= args.count:
            break
        sessions.append(sample)
        if (i + 1) % 100 == 0:
            print(f"  Downloaded {i + 1}/{args.count} sessions...")

    print(f"\nDownloaded {len(sessions)} sessions")

    # Save as JSON (the inputStream is already base64, so JSON works fine)
    output_path = os.path.join(output_dir, f'sample_{args.count}.json')
    with open(output_path, 'w') as f:
        json.dump(sessions, f)

    # Print summary statistics
    game_types = {}
    total_duration = 0
    for s in sessions:
        gt = s.get('gameType', 'unknown')
        game_types[gt] = game_types.get(gt, 0) + 1
        total_duration += s.get('duration', 0)

    print(f"\nSaved to: {output_path}")
    print(f"File size: {os.path.getsize(output_path) / 1024 / 1024:.1f} MB")
    print(f"\nGame type distribution:")
    for gt, count in sorted(game_types.items()):
        print(f"  {gt}: {count} sessions")
    print(f"Average duration: {total_duration / len(sessions):.0f}ms")

if __name__ == '__main__':
    main()
