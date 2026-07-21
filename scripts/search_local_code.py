#!/usr/bin/env python3
"""Search explicitly configured local repositories for L0.5 diagnosis."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from fetch_jira_issue import load_missing_l05_config_env


DEFAULT_EXCLUDES = [
    "!**/.git/**",
    "!**/node_modules/**",
    "!**/target/**",
    "!**/dist/**",
    "!**/build/**",
    "!**/coverage/**",
    "!**/.terraform/**",
    "!**/.gradle/**",
    "!**/.idea/**",
    "!**/vendor/**",
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--query", help="Regex or literal search pattern. Omit with --sync-only.")
    parser.add_argument("--root", action="append", help="Code root. May be passed multiple times.")
    parser.add_argument("--repo", action="append", help="Repository basename or root-relative substring to include.")
    parser.add_argument("--branch", default=os.environ.get("L05_DEFAULT_BRANCH"))
    parser.add_argument("--max-depth", type=int, default=4)
    parser.add_argument("--max-results", type=int, default=100)
    parser.add_argument("--max-text-chars", type=int, default=500)
    parser.add_argument("--case-sensitive", action="store_true")
    parser.add_argument("--sync", action="store_true", help="Explicitly fetch, checkout, and fast-forward clean repositories.")
    parser.add_argument("--no-sync", action="store_true", help="Deprecated compatibility flag; local search is read-only by default.")
    parser.add_argument("--sync-only", action="store_true")
    parser.add_argument("--skip-dirty-search", action="store_true")
    parser.add_argument("--literal", action="store_true", help="Treat query as a literal string.")
    return parser.parse_args()


def main() -> int:
    load_missing_l05_config_env(["L05_CODE_ROOTS", "L05_DEFAULT_BRANCH"])
    args = parse_args()
    if args.sync and not args.branch:
        print(json.dumps({"status": "blocked", "reason": "--sync requires an explicit --branch"}, indent=2))
        return 2
    roots = configured_roots(args.root)
    repos = discover_repos(roots, args.max_depth)
    repos = filter_repos(repos, roots, args.repo or [])
    sync_results: list[dict[str, Any]] = []
    all_matches: list[dict[str, Any]] = []

    for repo in repos:
        sync_result = inspect_repo(repo, roots, args.branch, do_sync=args.sync and not args.no_sync)
        sync_results.append(sync_result)
        if args.sync_only or not args.query:
            continue
        if sync_result["dirty"] and args.skip_dirty_search:
            continue
        remaining = args.max_results - len(all_matches)
        if remaining <= 0:
            break
        all_matches.extend(search_repo(repo, roots, args.query, args.literal, args.case_sensitive, remaining, args.max_text_chars))

    output = {
        "roots": [str(root) for root in roots],
        "requested_branch": args.branch,
        "repo_count": len(repos),
        "sync_enabled": args.sync and not args.no_sync,
        "sync": sync_results,
        "matches": all_matches,
        "match_count": len(all_matches),
    }
    print(json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


def configured_roots(cli_roots: list[str] | None) -> list[Path]:
    values = cli_roots
    if not values:
        env_value = os.environ.get("L05_CODE_ROOTS")
        values = env_value.split(os.pathsep) if env_value else []
    roots = [Path(value).expanduser().resolve() for value in values if value]
    return [root for root in roots if root.exists()]


def discover_repos(roots: list[Path], max_depth: int) -> list[Path]:
    repos: list[Path] = []
    for root in roots:
        if (root / ".git").exists():
            repos.append(root)
            continue
        for current, dirs, _files in os.walk(root):
            current_path = Path(current)
            depth = len(current_path.relative_to(root).parts)
            dirs[:] = [d for d in dirs if not d.startswith(".") or d == ".git"]
            if ".git" in dirs:
                repos.append(current_path)
                dirs[:] = []
                continue
            if depth >= max_depth:
                dirs[:] = []
    return sorted(set(repos))


def filter_repos(repos: list[Path], roots: list[Path], filters: list[str]) -> list[Path]:
    if not filters:
        return repos
    lowered = [item.lower() for item in filters]
    selected: list[Path] = []
    for repo in repos:
        labels = [repo.name.lower()]
        labels.extend(rel_to_any_root(repo, roots).lower().split(os.sep))
        labels.append(rel_to_any_root(repo, roots).lower())
        if any(any(token in label for label in labels) for token in lowered):
            selected.append(repo)
    return selected


def inspect_repo(repo: Path, roots: list[Path], branch: str | None, do_sync: bool) -> dict[str, Any]:
    result: dict[str, Any] = {
        "repo": rel_to_any_root(repo, roots),
        "path": str(repo),
        "requested_branch": branch,
        "branch_before": git_output(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
        "branch_after": "",
        "dirty": bool(git_output(repo, ["status", "--porcelain"])),
        "sync_status": "not_requested" if not do_sync else "pending",
        "errors": [],
    }
    if not do_sync:
        result["branch_after"] = result["branch_before"]
        return result
    if result["dirty"]:
        result["sync_status"] = "dirty_skip_checkout_pull"
        result["branch_after"] = result["branch_before"]
        return result

    fetch = git_run(repo, ["fetch", "--prune", "origin"])
    if fetch.returncode != 0:
        result["errors"].append(short_error(fetch))

    checkout = checkout_branch(repo, branch)
    if checkout.returncode != 0:
        result["sync_status"] = "checkout_failed"
        result["errors"].append(short_error(checkout))
        result["branch_after"] = git_output(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
        return result

    pull = git_run(repo, ["pull", "--ff-only"])
    if pull.returncode != 0:
        result["sync_status"] = "pull_failed"
        result["errors"].append(short_error(pull))
    else:
        result["sync_status"] = "synced"
    result["branch_after"] = git_output(repo, ["rev-parse", "--abbrev-ref", "HEAD"])
    return result


def checkout_branch(repo: Path, branch: str) -> subprocess.CompletedProcess[str]:
    local = git_run(repo, ["show-ref", "--verify", "--quiet", f"refs/heads/{branch}"])
    if local.returncode == 0:
        return git_run(repo, ["checkout", branch])
    remote = git_run(repo, ["show-ref", "--verify", "--quiet", f"refs/remotes/origin/{branch}"])
    if remote.returncode == 0:
        return git_run(repo, ["checkout", "-b", branch, f"origin/{branch}"])
    return subprocess.CompletedProcess(args=["git", "checkout", branch], returncode=1, stdout="", stderr=f"branch not found: {branch}")


def search_repo(
    repo: Path,
    roots: list[Path],
    query: str,
    literal: bool,
    case_sensitive: bool,
    max_results: int,
    max_text_chars: int,
) -> list[dict[str, Any]]:
    if not shutil.which("rg"):
        return []
    cmd = ["rg", "--json", "-n", "--hidden"]
    for glob in DEFAULT_EXCLUDES:
        cmd.extend(["--glob", glob])
    if not case_sensitive:
        cmd.append("-i")
    if literal:
        cmd.append("-F")
    cmd.extend(["-e", query, str(repo)])
    proc = subprocess.run(cmd, text=True, capture_output=True, check=False)
    if proc.returncode not in (0, 1):
        return [
            {
                "repo": rel_to_any_root(repo, roots),
                "type": "search_error",
                "error": (proc.stderr or proc.stdout).strip()[:500],
            }
        ]
    matches: list[dict[str, Any]] = []
    for line in proc.stdout.splitlines():
        if len(matches) >= max_results:
            break
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") != "match":
            continue
        data = event.get("data") or {}
        path = Path(data.get("path", {}).get("text", ""))
        matches.append(
            {
                "repo": rel_to_any_root(repo, roots),
                "path": relpath(path, repo),
                "line_number": data.get("line_number"),
                "text": truncate_text((data.get("lines") or {}).get("text", "").rstrip("\n"), max_text_chars),
            }
        )
    return matches


def git_run(repo: Path, args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=repo, text=True, capture_output=True, check=False)


def git_output(repo: Path, args: list[str]) -> str:
    proc = git_run(repo, args)
    if proc.returncode != 0:
        return ""
    return proc.stdout.strip()


def short_error(proc: subprocess.CompletedProcess[str]) -> str:
    return " | ".join((proc.stderr or proc.stdout or "").strip().splitlines()[0:3])


def rel_to_any_root(path: Path, roots: list[Path]) -> str:
    for root in roots:
        try:
            return str(path.resolve().relative_to(root))
        except ValueError:
            continue
    return str(path)


def relpath(path: Path, root: Path) -> str:
    try:
        return str(path.resolve().relative_to(root))
    except ValueError:
        return str(path)


def truncate_text(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    return text[:max_chars].rstrip() + "...[truncated]"


if __name__ == "__main__":
    raise SystemExit(main())
