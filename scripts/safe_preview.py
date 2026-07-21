#!/usr/bin/env python3
"""Create a bounded read-only preview for text-like evidence."""
from __future__ import annotations
import argparse
import json
import mimetypes
from pathlib import Path

ALLOWED = {"text/plain", "text/csv", "application/json", "application/xml", "text/xml"}

def preview(path: Path, max_bytes: int = 65536) -> dict[str, object]:
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if mime not in ALLOWED and not path.suffix.lower() in {".log", ".txt", ".yaml", ".yml", ".md"}:
        return {"path": str(path), "status": "unsupported", "mime": mime, "executed": False}
    data = path.read_bytes()[:max_bytes]
    return {"path": str(path), "status": "previewed", "mime": mime, "truncated": path.stat().st_size > len(data), "text": data.decode("utf-8", errors="replace"), "executed": False}

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("path", type=Path)
    parser.add_argument("--max-bytes", type=int, default=65536)
    args = parser.parse_args()
    print(json.dumps(preview(args.path, args.max_bytes), ensure_ascii=False, indent=2))
