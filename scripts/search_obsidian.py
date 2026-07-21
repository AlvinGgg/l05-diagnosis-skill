#!/usr/bin/env python3
"""Search the configured Obsidian vault for L0.5 diagnosis evidence."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from fetch_jira_issue import load_missing_l05_config_env
from l05_profile import load_profile, profile_path


DEFAULT_PATHS = [
    "index.md",
    "wiki/sources",
    "wiki/projects",
    "wiki/systems",
    "wiki/topics",
    "raw/tickets",
]

PROFILE_SEARCH_KEYS = (
    "index",
    "wiki_sources_documents",
    "wiki_sources_tickets",
    "wiki_sources_jira",
    "wiki_howtos",
    "wiki_systems",
    "wiki_topics",
    "wiki_concepts",
    "raw_tickets",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("terms", nargs="+", help="Search terms or regex.")
    parser.add_argument("--vault", default=os.environ.get("L05_OBSIDIAN_VAULT") or os.environ.get("PAAS_KB_ROOT"))
    parser.add_argument("--path", action="append", dest="paths", help="Vault-relative path to search.")
    parser.add_argument("--regex", action="store_true", help="Treat joined terms as a regex.")
    parser.add_argument("--case-sensitive", action="store_true")
    parser.add_argument("--context", type=int, default=1)
    parser.add_argument("--max-results", type=int, default=80)
    parser.add_argument("--max-text-chars", type=int, default=500)
    parser.add_argument("--json", action="store_true", default=True)
    return parser.parse_args()


def main() -> int:
    load_missing_l05_config_env(["L05_OBSIDIAN_VAULT", "PAAS_KB_ROOT"])
    args = parse_args()
    if not args.vault:
        print("Vault is not configured: set L05_OBSIDIAN_VAULT or pass --vault", file=sys.stderr)
        return 2
    vault = Path(args.vault).expanduser().resolve()
    if not vault.exists():
        print(f"Vault does not exist: {vault}", file=sys.stderr)
        return 2
    configured_paths = profile_search_paths(vault)
    paths = [vault / path for path in (args.paths or configured_paths) if (vault / path).exists()]
    pattern = build_pattern(args.terms, args.regex)
    if shutil.which("rg"):
        matches = rg_search(vault, paths, pattern, args.case_sensitive, args.context, args.max_results, args.max_text_chars)
    else:
        matches = python_search(vault, paths, pattern, args.case_sensitive, args.context, args.max_results, args.max_text_chars)
    output = {
        "vault": str(vault),
        "pattern": pattern,
        "searched_paths": [str(path.relative_to(vault)) for path in paths],
        "matches": matches,
        "match_count": len(matches),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def profile_search_paths(vault: Path) -> list[str]:
    profile, validation = load_profile(profile_path(vault))
    if not profile or not validation["valid"]:
        return DEFAULT_PATHS
    knowledge = profile["knowledge"]
    return list(dict.fromkeys(knowledge[key] for key in PROFILE_SEARCH_KEYS if knowledge.get(key)))


def build_pattern(terms: list[str], is_regex: bool) -> str:
    if is_regex:
        return " ".join(terms)
    expanded: list[str] = []
    for term in terms:
        stripped = term.strip()
        if not stripped:
            continue
        expanded.append(stripped)
        if " " in stripped:
            expanded.extend(token for token in re.split(r"\s+", stripped) if len(token) >= 3)
    if not expanded:
        raise SystemExit("At least one non-empty search term is required.")
    return "|".join(re.escape(term) for term in dict.fromkeys(expanded))


def rg_search(
    vault: Path,
    paths: list[Path],
    pattern: str,
    case_sensitive: bool,
    context: int,
    max_results: int,
    max_text_chars: int,
) -> list[dict[str, Any]]:
    cmd = ["rg", "--json", "-n", "--context", str(context)]
    if not case_sensitive:
        cmd.append("-i")
    cmd.extend(["-e", pattern])
    cmd.extend(str(path) for path in paths)
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if proc.returncode not in (0, 1):
        raise SystemExit(proc.stderr.strip() or "rg failed")

    matches: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        if len(matches) >= max_results:
            break
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") not in {"match", "context"}:
            continue
        data = event.get("data") or {}
        path = Path(data.get("path", {}).get("text", ""))
        if not path:
            continue
        matches.append(
            {
                "type": event.get("type"),
                "path": relpath(path, vault),
                "line_number": data.get("line_number"),
                "text": truncate_text((data.get("lines") or {}).get("text", "").rstrip("\n"), max_text_chars),
                "source_layer": source_layer(relpath(path, vault)),
            }
        )
    return matches


def python_search(
    vault: Path,
    paths: list[Path],
    pattern: str,
    case_sensitive: bool,
    context: int,
    max_results: int,
    max_text_chars: int,
) -> list[dict[str, Any]]:
    flags = 0 if case_sensitive else re.IGNORECASE
    regex = re.compile(pattern, flags)
    files: list[Path] = []
    for path in paths:
        if path.is_file():
            files.append(path)
        else:
            files.extend(child for child in path.rglob("*.md") if child.is_file())
    matches: list[dict[str, Any]] = []
    for file_path in files:
        lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        for index, line in enumerate(lines):
            if not regex.search(line):
                continue
            start = max(0, index - context)
            end = min(len(lines), index + context + 1)
            for number in range(start, end):
                if len(matches) >= max_results:
                    return matches
                rel = relpath(file_path, vault)
                matches.append(
                    {
                        "type": "match" if number == index else "context",
                        "path": rel,
                        "line_number": number + 1,
                        "text": truncate_text(lines[number], max_text_chars),
                        "source_layer": source_layer(rel),
                    }
                )
    return matches


def relpath(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root))
    except ValueError:
        return str(path)


def source_layer(rel: str) -> str:
    if rel == "index.md":
        return "index"
    if rel.startswith("raw/tickets/"):
        return "raw_ticket"
    if rel.startswith("wiki/sources/"):
        return "wiki_source"
    if rel.startswith("wiki/"):
        return "wiki"
    return "other"


def truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "...[truncated]"


if __name__ == "__main__":
    raise SystemExit(main())
