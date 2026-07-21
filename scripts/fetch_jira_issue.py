#!/usr/bin/env python3
"""Read-only Jira issue fetcher for l05-diagnosis."""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import re
import ssl
import sys
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_FIELDS = [
    "summary",
    "description",
    "status",
    "assignee",
    "reporter",
    "created",
    "updated",
    "comment",
    "labels",
    "components",
    "attachment",
]
DEFAULT_COMMENT_EXCLUDE_RE = (
    r"(?i)(bot|robot|automation|system|stackstorm|jenkins|opsagent|"
    r"no[-_]?reply|(^|[._-])im([._-]|@|$)|\bim\b)"
)
ISSUE_KEY_RE = re.compile(r"\b([A-Z][A-Z0-9]+-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b", re.I)
ENV_ASSIGNMENT_RE = re.compile(
    r'^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s#]*))\s*(?:#.*)?$'
)
L05_CONFIG_NAMES = ["JIRA_BASE_URL", "JIRA_TOKEN", "JIRA_EMAIL", "JIRA_AUTH_MODE", "L05_JIRA_COMMENT_EXCLUDE_REGEX"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("issue", help="Jira issue key or browse URL.")
    parser.add_argument("--base-url", default=os.environ.get("JIRA_BASE_URL"))
    parser.add_argument("--token-env", default="JIRA_TOKEN", help="Environment variable holding the Jira token.")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--ca-file", default=None)
    parser.add_argument("--insecure-skip-verify", action="store_true")
    parser.add_argument(
        "--comment-exclude-regex",
        default=os.environ.get("L05_JIRA_COMMENT_EXCLUDE_REGEX", DEFAULT_COMMENT_EXCLUDE_RE),
        help="Regex matched against author identity to exclude automation/IM comments.",
    )
    parser.add_argument(
        "--comment-include-regex",
        default=None,
        help="Optional regex matched against author identity to include only matching comments.",
    )
    parser.add_argument("--include-filtered-bodies", action="store_true")
    parser.add_argument("--out", help="Write JSON output to this path instead of stdout.")
    return parser.parse_args()


def main() -> int:
    load_missing_l05_config_env(L05_CONFIG_NAMES)
    args = parse_args()
    issue_key = parse_issue_key(args.issue)
    token = load_missing_l05_env(args.token_env)
    if not token:
        print(f"Missing Jira token environment variable: {args.token_env}", file=sys.stderr)
        return 2
    if not args.base_url:
        print("Missing Jira base URL: set JIRA_BASE_URL or pass --base-url", file=sys.stderr)
        return 2

    base_url = args.base_url.rstrip("/")
    issue = fetch_json(
        f"{base_url}/rest/api/2/issue/{urllib.parse.quote(issue_key)}?"
        + urllib.parse.urlencode({"fields": ",".join(DEFAULT_FIELDS)}),
        token,
        args.timeout,
        verify_ssl=not args.insecure_skip_verify,
        ca_file=args.ca_file,
    )

    fields = issue.get("fields") or {}
    comments_field = fields.get("comment") or {}
    comments = comments_field.get("comments") or []
    total_comments = int(comments_field.get("total") or len(comments))
    if total_comments > len(comments):
        comments = fetch_all_comments(base_url, issue_key, token, args.timeout, not args.insecure_skip_verify, args.ca_file)

    output = build_issue_output(
        issue=issue,
        base_url=base_url,
        comments=comments,
        exclude_regex=args.comment_exclude_regex,
        include_regex=args.comment_include_regex,
        include_filtered_bodies=args.include_filtered_bodies,
    )
    text = json.dumps(output, ensure_ascii=False, indent=2, sort_keys=True)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
    else:
        print(text)
    return 0


def default_l05_config_file(home: Path | None = None) -> Path:
    configured = os.environ.get("L05_CONFIG_FILE")
    if configured:
        return Path(configured).expanduser()
    codex_home = Path(os.environ.get("CODEX_HOME") or (home or Path.home()) / ".codex")
    return codex_home / "l05-diagnosis.env"


def load_missing_file_env(names: list[str], file: Path) -> dict[str, str]:
    wanted = set(names)
    loaded: dict[str, str] = {}
    try:
        lines = file.read_text(encoding="utf-8").splitlines()
    except OSError:
        return loaded

    for line in lines:
        match = ENV_ASSIGNMENT_RE.match(line)
        if not match or match.group(1) not in wanted or os.environ.get(match.group(1)):
            continue
        value = next((part for part in match.groups()[1:] if part is not None), "")
        if value:
            os.environ[match.group(1)] = value
            loaded[match.group(1)] = value
    return loaded


def load_missing_l05_config_env(names: list[str], home: Path | None = None, config_file: Path | None = None) -> dict[str, str]:
    """Load missing values from L05's private local configuration file."""
    return load_missing_file_env(names, config_file or default_l05_config_file(home))


def load_missing_zshrc_env(name: str, home: Path | None = None) -> str:
    """Return an existing env value or a literal assignment from ~/.zshrc.

    The shell profile is parsed as text only. Command substitutions, sourced
    files, and other shell expressions are intentionally ignored.
    """
    if os.environ.get(name):
        return os.environ[name]

    return load_missing_file_env([name], (home or Path.home()) / ".zshrc").get(name, "")


def load_missing_l05_env(name: str, home: Path | None = None, config_file: Path | None = None) -> str:
    """Use environment, then the private L05 config, then legacy ~/.zshrc."""
    if os.environ.get(name):
        return os.environ[name]
    loaded = load_missing_l05_config_env([name], home, config_file)
    if loaded.get(name):
        return loaded[name]
    return load_missing_zshrc_env(name, home)


def parse_issue_key(value: str) -> str:
    match = ISSUE_KEY_RE.search(value or "")
    if not match:
        raise SystemExit(f"Cannot find Jira issue key in: {value}")
    return match.group(1).upper()


def fetch_all_comments(base_url: str, issue_key: str, token: str, timeout: int, verify_ssl: bool, ca_file: str | None) -> list[dict[str, Any]]:
    comments: list[dict[str, Any]] = []
    start_at = 0
    max_results = 100
    while True:
        query = urllib.parse.urlencode({"startAt": start_at, "maxResults": max_results})
        payload = fetch_json(
            f"{base_url}/rest/api/2/issue/{urllib.parse.quote(issue_key)}/comment?{query}",
            token,
            timeout,
            verify_ssl=verify_ssl,
            ca_file=ca_file,
        )
        batch = payload.get("comments") or []
        comments.extend(batch)
        start_at = int(payload.get("startAt") or start_at) + len(batch)
        total = int(payload.get("total") or len(comments))
        if start_at >= total or not batch:
            return comments


def fetch_json(url: str, token: str, timeout: int, verify_ssl: bool, ca_file: str | None) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={"Authorization": auth_header(token), "Accept": "application/json"},
        method="GET",
    )
    context = ssl_context(verify_ssl=verify_ssl, ca_file=ca_file)
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return json.loads(response.read().decode("utf-8"))


def auth_header(token: str) -> str:
    try:
        decoded = base64.b64decode(token, validate=True).decode("utf-8", errors="strict")
    except Exception:
        decoded = ""
    if ":" in decoded:
        return f"Basic {token}"
    return f"Bearer {token}"


def ssl_context(verify_ssl: bool, ca_file: str | None) -> ssl.SSLContext | None:
    if ca_file:
        return ssl.create_default_context(cafile=ca_file)
    if verify_ssl:
        return None
    return ssl._create_unverified_context()


def build_issue_output(
    issue: dict[str, Any],
    base_url: str,
    comments: list[dict[str, Any]],
    exclude_regex: str,
    include_regex: str | None,
    include_filtered_bodies: bool,
) -> dict[str, Any]:
    fields = issue.get("fields") or {}
    included, filtered = filter_comments(comments, exclude_regex, include_regex, include_filtered_bodies)
    issue_key = issue.get("key", "")
    return {
        "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "base_url": base_url,
        "issue_key": issue_key,
        "browse_url": f"{base_url}/browse/{issue_key}" if issue_key else "",
        "fields": {
            "summary": normalize_text(fields.get("summary")),
            "description": normalize_text(fields.get("description")),
            "status": named(fields.get("status")),
            "assignee": user_identity(fields.get("assignee")),
            "reporter": user_identity(fields.get("reporter")),
            "created": fields.get("created") or "",
            "updated": fields.get("updated") or "",
            "labels": fields.get("labels") or [],
            "components": [named(component) for component in fields.get("components") or []],
            "attachments_metadata": [
                {
                    "filename": attachment.get("filename", ""),
                    "size": attachment.get("size", 0),
                    "mimeType": attachment.get("mimeType", ""),
                }
                for attachment in fields.get("attachment") or []
            ],
        },
        "comments": {
            "included_count": len(included),
            "filtered_count": len(filtered),
            "included": included,
            "filtered_out": filtered,
        },
    }


def filter_comments(
    comments: list[dict[str, Any]],
    exclude_regex: str,
    include_regex: str | None,
    include_filtered_bodies: bool,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    exclude_re = re.compile(exclude_regex) if exclude_regex else None
    include_re = re.compile(include_regex) if include_regex else None
    included: list[dict[str, Any]] = []
    filtered: list[dict[str, Any]] = []
    for comment in comments:
        body = normalize_text(comment.get("body")).strip()
        if not body:
            continue
        author = comment.get("author") or {}
        identity = author_match_text(author)
        reason = ""
        if include_re and not include_re.search(identity):
            reason = "author_include_regex_not_matched"
        elif exclude_re and exclude_re.search(identity):
            reason = "author_exclude_regex_matched"

        item = {
            "id": comment.get("id", ""),
            "author": user_identity(author),
            "created": comment.get("created", ""),
            "updated": comment.get("updated", ""),
        }
        if reason:
            item["filter_reason"] = reason
            if include_filtered_bodies:
                item["body"] = body
            filtered.append(item)
        else:
            item["body"] = body
            included.append(item)
    return included, filtered


def author_match_text(author: dict[str, Any]) -> str:
    parts = [
        author.get("emailAddress"),
        author.get("name"),
        author.get("displayName"),
        author.get("key"),
        author.get("accountId"),
    ]
    return " ".join(str(part).lower() for part in parts if part)


def user_identity(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {
        "emailAddress": value.get("emailAddress") or "",
        "name": value.get("name") or "",
        "displayName": value.get("displayName") or "",
        "key": value.get("key") or "",
    }


def named(value: Any) -> str:
    if isinstance(value, dict):
        return value.get("name") or value.get("displayName") or ""
    return str(value or "")


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, (int, float, bool)):
        return str(value)
    if isinstance(value, list):
        return " ".join(part for part in (normalize_text(item) for item in value) if part)
    if isinstance(value, dict):
        if "text" in value and isinstance(value["text"], str):
            return value["text"]
        content = value.get("content")
        if content is not None:
            return normalize_text(content)
        return " ".join(part for part in (normalize_text(item) for item in value.values()) if part)
    return str(value)


if __name__ == "__main__":
    raise SystemExit(main())
