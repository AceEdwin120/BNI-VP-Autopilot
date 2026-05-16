#!/usr/bin/env python3
"""Render openclaw.json.template → ~/.openclaw/openclaw.json using env vars."""
import json, os, pathlib, sys, re

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
text = src.read_text()
# Only substitute vars whose values are safe for JSON (no control chars, no newlines)
for k, v in os.environ.items():
    if re.search(r'[\x00-\x1f\x7f]', v):
        continue
    text = text.replace(f"<{k}>", v)
    text = text.replace(f"&lt;{k}&gt;", v)
obj = json.loads(text)  # validate
dst.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
print(f"rendered → {dst}")
