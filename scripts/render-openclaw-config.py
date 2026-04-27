#!/usr/bin/env python3
"""Render openclaw.json.template → ~/.openclaw/openclaw.json using env vars."""
import json, os, pathlib, sys

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
text = src.read_text()
for k, v in os.environ.items():
    text = text.replace(f"<{k}>", v)
    text = text.replace(f"&lt;{k}&gt;", v)
obj = json.loads(text)  # validate
dst.write_text(json.dumps(obj, ensure_ascii=False, indent=2) + "\n")
print(f"rendered → {dst}")
