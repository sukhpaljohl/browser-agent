"""
Extract all task prompts from WebChain dataset files.
Reads all JSON files, pulls out the 'title' field from each task,
cleans them up, and saves to a single output file.
"""

import json
import os
import re

INPUT_DIR = r"d:\Github n8n\WebChain all_json_files\all_json_files"
OUTPUT_FILE = r"d:\Github n8n\browser-agent\tools\dataset\data\webchain_prompts.txt"

prompts = []
skipped = 0
errors = 0

for filename in os.listdir(INPUT_DIR):
    if not filename.endswith('.json'):
        continue
    
    filepath = os.path.join(INPUT_DIR, filename)
    try:
        with open(filepath, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Each file is an array of task objects
        if isinstance(data, list):
            for task in data:
                title = task.get('title', '')
                if not title or not title.strip():
                    skipped += 1
                    continue
                
                # Clean up the title:
                # Remove "- Task N: " prefix
                cleaned = re.sub(r'^-?\s*Task\s*\d+\s*:\s*', '', title.strip())
                # Remove surrounding quotes
                cleaned = cleaned.strip('"').strip("'").strip('"').strip('"')
                # Remove trailing quotes
                cleaned = cleaned.rstrip('"').rstrip("'")
                # Remove extra whitespace
                cleaned = ' '.join(cleaned.split())
                
                if cleaned and len(cleaned) > 5:  # Skip tiny/empty prompts
                    prompts.append(cleaned)
                else:
                    skipped += 1
    except Exception as e:
        errors += 1

# Remove exact duplicates while preserving order
seen = set()
unique_prompts = []
for p in prompts:
    if p not in seen:
        seen.add(p)
        unique_prompts.append(p)

# Save to file
with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
    for prompt in unique_prompts:
        f.write(prompt + '\n')

print(f"Total prompts found: {len(prompts)}")
print(f"Unique prompts: {len(unique_prompts)}")
print(f"Duplicates removed: {len(prompts) - len(unique_prompts)}")
print(f"Skipped (empty/tiny): {skipped}")
print(f"Files with errors: {errors}")
print(f"Saved to: {OUTPUT_FILE}")
