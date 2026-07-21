#!/usr/bin/env python3
"""Fetch and search an isolated, immutable remote Git snapshot."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from urllib.parse import urlparse


SENTINEL = ".l05-owned-worktree"
EXCLUDES = (
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
)


def default_cache() -> Path:
    if os.environ.get("L05_CACHE_DIR"):
        return Path(os.environ["L05_CACHE_DIR"]).expanduser() / "git"
    if os.environ.get("XDG_CACHE_HOME"):
        return Path(os.environ["XDG_CACHE_HOME"]).expanduser() / "l05-diagnosis" / "git"
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Caches" / "l05-diagnosis" / "git"
    return Path.home() / ".cache" / "l05-diagnosis" / "git"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-url", required=True, help="HTTPS, SSH, or local repository URL without embedded credentials.")
    parser.add_argument("--ref", help="Branch, tag, or commit. The remote default branch is used when omitted.")
    parser.add_argument("--query", help="Optional rg search expression.")
    parser.add_argument("--literal", action="store_true")
    parser.add_argument("--case-sensitive", action="store_true")
    parser.add_argument("--max-results", type=int, default=100)
    parser.add_argument("--cache-dir", default=str(default_cache()))
    parser.add_argument("--worktree-root", help="Parent directory for the temporary detached Worktree.")
    parser.add_argument("--keep-worktree", action="store_true", help="Keep the owned Worktree for explicit review.")
    return parser.parse_args()


def redact(value: str) -> str:
    return re.sub(r"(?i)(token|password|secret|key|sig|signature)=([^&\s]+)", r"\1=[redacted]", value)


def validate_remote(value: str) -> None:
    if "\x00" in value or "\n" in value or "\r" in value:
        raise ValueError("invalid repository URL")
    if value.startswith(("http://", "https://")):
        parsed = urlparse(value)
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ValueError("repository URL must not contain credentials, query values, or fragments")


def run(args: list[str], cwd: Path | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=False)
    if check and result.returncode != 0:
        message = " | ".join((result.stderr or result.stdout or "command failed").strip().splitlines()[:3])
        raise RuntimeError(redact(message))
    return result


def mirror_path(cache: Path, remote: str) -> Path:
    digest = hashlib.sha256(remote.encode("utf-8")).hexdigest()[:24]
    return cache / f"repo-{digest}.git"


def prepare_mirror(remote: str, cache: Path) -> tuple[Path, str]:
    cache.mkdir(parents=True, exist_ok=True)
    mirror = mirror_path(cache, remote)
    if not mirror.exists():
        run(["git", "clone", "--mirror", remote, str(mirror)])
        status = "cloned"
    else:
        actual = run(["git", "--git-dir", str(mirror), "remote", "get-url", "origin"]).stdout.strip()
        if actual != remote:
            raise RuntimeError("cached mirror remote mismatch")
        run(["git", "--git-dir", str(mirror), "fetch", "--prune", "origin", "+refs/heads/*:refs/heads/*", "+refs/tags/*:refs/tags/*"])
        status = "fetched"
    return mirror, status


def resolve_commit(mirror: Path, requested_ref: str | None) -> tuple[str, str]:
    candidates = []
    if requested_ref:
        candidates.extend((requested_ref, f"refs/heads/{requested_ref}", f"refs/tags/{requested_ref}"))
    else:
        candidates.append("HEAD")
    for candidate in candidates:
        result = run(["git", "--git-dir", str(mirror), "rev-parse", "--verify", f"{candidate}^{{commit}}"], check=False)
        if result.returncode == 0:
            return result.stdout.strip(), candidate
    raise RuntimeError(f"cannot resolve repository ref: {requested_ref or 'remote HEAD'}")


def create_worktree(mirror: Path, commit: str, parent: Path | None) -> Path:
    if parent:
        parent.mkdir(parents=True, exist_ok=True)
        worktree = Path(tempfile.mkdtemp(prefix="l05-code-", dir=parent))
    else:
        worktree = Path(tempfile.mkdtemp(prefix="l05-code-"))
    try:
        run(["git", "--git-dir", str(mirror), "worktree", "add", "--detach", str(worktree), commit])
        (worktree / SENTINEL).write_text("owned\n", encoding="utf-8")
        return worktree
    except Exception:
        shutil.rmtree(worktree, ignore_errors=True)
        raise


def search(worktree: Path, args: argparse.Namespace) -> list[dict[str, object]]:
    if not args.query:
        return []
    if not shutil.which("rg"):
        raise RuntimeError("rg is required when --query is used")
    command = ["rg", "--json", "-n", "--hidden"]
    for pattern in EXCLUDES:
        command.extend(("--glob", pattern))
    if not args.case_sensitive:
        command.append("-i")
    if args.literal:
        command.append("-F")
    command.extend(("-e", args.query, str(worktree)))
    result = run(command, check=False)
    if result.returncode not in (0, 1):
        raise RuntimeError(redact(result.stderr or result.stdout))
    matches: list[dict[str, object]] = []
    for line in result.stdout.splitlines():
        if len(matches) >= args.max_results:
            break
        event = json.loads(line)
        if event.get("type") != "match":
            continue
        data = event["data"]
        file = Path(data["path"]["text"])
        matches.append(
            {
                "path": file.relative_to(worktree).as_posix(),
                "line_number": data.get("line_number"),
                "text": (data.get("lines") or {}).get("text", "").rstrip("\n")[:500],
            }
        )
    return matches


def cleanup(mirror: Path, worktree: Path) -> None:
    if not (worktree / SENTINEL).is_file():
        raise RuntimeError("refusing to clean a Worktree without the L05 owner sentinel")
    run(["git", "--git-dir", str(mirror), "worktree", "remove", "--force", str(worktree)], check=False)
    shutil.rmtree(worktree, ignore_errors=True)


def main() -> int:
    args = parse_args()
    try:
        validate_remote(args.repo_url)
        mirror, fetch_status = prepare_mirror(args.repo_url, Path(args.cache_dir).expanduser().resolve())
        commit, resolution_basis = resolve_commit(mirror, args.ref)
        worktree = create_worktree(mirror, commit, Path(args.worktree_root).expanduser().resolve() if args.worktree_root else None)
        matches = search(worktree, args)
        kept = args.keep_worktree
        result = {
            "status": "ok",
            "repository": redact(args.repo_url),
            "requested_ref": args.ref,
            "resolved_commit": commit,
            "resolution_basis": resolution_basis,
            "fetch_status": fetch_status,
            "mirror": str(mirror),
            "worktree": str(worktree) if kept else None,
            "matches": matches,
            "match_count": len(matches),
        }
        if not kept:
            cleanup(mirror, worktree)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"status": "blocked", "reason": redact(str(error))}, ensure_ascii=False, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
