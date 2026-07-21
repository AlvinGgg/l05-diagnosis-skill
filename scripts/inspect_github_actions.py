#!/usr/bin/env python3
"""Inspect local GitHub Actions workflow evidence for L0.5 diagnosis."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fetch_jira_issue import load_missing_l05_config_env


DEFAULT_EXCLUDES = {".git", "node_modules", "target", "dist", "build"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="GitHub Actions run/job URL from Jira.")
    parser.add_argument("--job", help="Observed job name, for example 'Deploying Airflow DAG'.")
    parser.add_argument("--summary", help="Jira summary or description text.")
    parser.add_argument("--secret", action="append", help="Secret or env key observed in Jira/screenshot. May repeat.")
    parser.add_argument("--repo", default=os.environ.get("L05_GITHUB_ACTIONS_WORKFLOW_REPO"))
    parser.add_argument("--max-results", type=int, default=20)
    return parser.parse_args()


def parse_actions_url(value: str | None) -> dict[str, str]:
    if not value:
        return {}
    parsed = urlparse(value)
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 5 or parts[2] != "actions" or parts[3] != "runs":
        return {"url": value, "kind": "not_actions_run"}
    result = {
        "url": value,
        "kind": "actions_run",
        "host": parsed.netloc,
        "owner": parts[0],
        "repository": parts[1],
        "run_id": parts[4],
    }
    if len(parts) >= 7 and parts[5] == "job":
        result["job_id"] = parts[6]
    return result


def build_terms(url_info: dict[str, str], job: str | None, summary: str | None, secrets: list[str]) -> list[str]:
    terms: list[str] = []
    for value in [job, summary, url_info.get("repository"), *secrets]:
        if not value:
            continue
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_./-]{2,}|[\u4e00-\u9fff]{2,12}", value):
            terms.append(token)
    normalized = []
    for term in terms:
        if term not in normalized:
            normalized.append(term)
    return normalized


def inspect(repo: Path, url: str | None, job: str | None, summary: str | None, secrets: list[str], max_results: int) -> dict[str, Any]:
    url_info = parse_actions_url(url)
    terms = build_terms(url_info, job, summary, secrets)
    workflow_files = sorted((repo / ".github" / "workflows").glob("*.y*ml"))
    matches = []
    for file in workflow_files:
        text = file.read_text(encoding="utf-8", errors="replace")
        score, reasons = score_workflow(file, text, terms, job, secrets)
        if score <= 0:
            continue
        matches.append(
            {
                "path": str(file.relative_to(repo)),
                "score": score,
                "reasons": reasons,
                "jobs": matching_jobs(text, job),
                "uses_refs": uses_refs(text),
                "secret_refs": secret_refs(text, secrets),
            }
        )
    matches.sort(key=lambda item: (-item["score"], item["path"]))
    return {
        "url": url_info,
        "workflow_repo": str(repo),
        "git": git_state(repo),
        "terms": terms,
        "matches": matches[:max_results],
        "match_count": min(len(matches), max_results),
        "total_candidates": len(matches),
    }


def score_workflow(file: Path, text: str, terms: list[str], job: str | None, secrets: list[str]) -> tuple[int, list[str]]:
    haystacks = [file.name, text]
    score = 0
    reasons: list[str] = []
    lower_text = text.lower()
    lower_name = file.name.lower()
    if job and job.lower() in lower_text:
        score += 10
        reasons.append(f"job:{job}")
    for secret in secrets:
        if secret and secret in text:
            score += 6
            reasons.append(f"secret:{secret}")
        stripped = re.sub(r"^(DEV|QA|PROD|APT)_", "", secret or "")
        if stripped and stripped != secret and stripped in text:
            score += 4
            reasons.append(f"secret-alias:{secret}->{stripped}")
    for term in terms:
        if len(term) < 3:
            continue
        lower = term.lower()
        if lower in lower_name:
            score += 5
            reasons.append(f"filename:{term}")
        elif lower in lower_text:
            score += 1
    return score, unique(reasons)


def matching_jobs(text: str, job: str | None) -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    if not job:
        return jobs
    lines = text.splitlines()
    for index, line in enumerate(lines, start=1):
        if re.search(rf"name:\s*['\"]?{re.escape(job)}['\"]?\s*$", line, flags=re.I):
            jobs.append({"line": index, "name": job, "context": nearest_job_key(lines, index)})
    return jobs


def nearest_job_key(lines: list[str], line_number: int) -> str:
    for index in range(line_number - 1, -1, -1):
        match = re.match(r"^\s{2}([A-Za-z0-9_-]+):\s*$", lines[index])
        if match:
            return match.group(1)
    return ""


def uses_refs(text: str) -> list[dict[str, Any]]:
    refs = []
    for index, line in enumerate(text.splitlines(), start=1):
        match = re.search(r"uses:\s*([^@\s]+)@([A-Za-z0-9._/-]+)", line)
        if match:
            refs.append({"line": index, "uses": match.group(1), "ref": match.group(2)})
    return refs


def secret_refs(text: str, secrets: list[str]) -> list[dict[str, Any]]:
    wanted = set(secrets)
    wanted.update(re.sub(r"^(DEV|QA|PROD|APT)_", "", secret) for secret in secrets)
    refs = []
    for index, line in enumerate(text.splitlines(), start=1):
        for match in re.finditer(r"(?:secrets|env)\.([A-Za-z0-9_]+)", line):
            name = match.group(1)
            if not wanted or name in wanted:
                refs.append({"line": index, "name": name, "text": line.strip()})
    return refs


def git_state(repo: Path) -> dict[str, str]:
    return {
        "branch": git_output(repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
        "commit": git_output(repo, ["log", "-1", "--oneline"]),
        "dirty": "true" if git_output(repo, ["status", "--porcelain"]) else "false",
    }


def git_output(repo: Path, args: list[str]) -> str:
    proc = subprocess.run(["git", *args], cwd=repo, text=True, capture_output=True, check=False)
    return proc.stdout.strip() if proc.returncode == 0 else ""


def unique(values: list[str]) -> list[str]:
    result = []
    for value in values:
        if value not in result:
            result.append(value)
    return result


def main() -> int:
    load_missing_l05_config_env(["L05_GITHUB_ACTIONS_WORKFLOW_REPO"])
    args = parse_args()
    if not args.repo:
        print(json.dumps({"status": "blocked", "reason": "workflow repository is not configured; pass --repo or set L05_GITHUB_ACTIONS_WORKFLOW_REPO"}, ensure_ascii=False, indent=2))
        return 2
    repo = Path(args.repo).expanduser().resolve()
    if not repo.exists():
        print(json.dumps({"status": "blocked", "reason": f"workflow repo not found: {repo}"}, ensure_ascii=False, indent=2))
        return 1
    result = inspect(repo, args.url, args.job, args.summary, args.secret or [], args.max_results)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
