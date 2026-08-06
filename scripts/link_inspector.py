#!/usr/bin/env python3
"""Classify link safety/auth evidence without forwarding Jira credentials."""
from __future__ import annotations
import ipaddress
import json
import re
import socket
import sys
import urllib.parse

LOGIN_RE = re.compile(r"(?i)(sign[ -]?in|log[ -]?in|sso|authentication required)")
RANCHER_HOST_RE = re.compile(r"(^|\.)rancher(?:[-.]|$)", re.IGNORECASE)

def classify_url(url: str) -> dict[str, str]:
    try:
        parsed = urllib.parse.urlparse(url)
    except ValueError:
        return {"url": url, "access_status": "unsupported"}
    if parsed.scheme not in {"http", "https"}:
        return {"url": url, "access_status": "blocked_by_policy"}
    host = (parsed.hostname or "").lower()
    if RANCHER_HOST_RE.search(host):
        return {"url": redact_url(url), "access_status": "blocked_by_policy"}
    if host in {"localhost", "localhost.localdomain"} or host.endswith(".localhost"):
        return {"url": url, "access_status": "blocked_by_policy"}
    try:
        address = ipaddress.ip_address(host)
        if address.is_private or address.is_loopback or address.is_link_local or address.is_multicast or address.is_reserved:
            return {"url": url, "access_status": "blocked_by_policy"}
    except ValueError:
        pass
    if host in {"169.254.169.254", "metadata.google.internal"}:
        return {"url": url, "access_status": "blocked_by_policy"}
    return {"url": redact_url(url), "access_status": "not_attempted"}

def classify_response(status: int, final_url: str, content_type: str, body_preview: str) -> str:
    if status == 401: return "unauthorized"
    if status == 403: return "forbidden"
    if status == 404: return "not_found"
    if 300 <= status < 400 and LOGIN_RE.search(final_url): return "login_required"
    if status == 200 and ("text/html" in content_type.lower()) and LOGIN_RE.search(body_preview): return "login_required"
    if 200 <= status < 300: return "accessible"
    return "network_error"

def redact_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    safe = [(key, "REDACTED" if re.search(r"(?i)(token|signature|sig|auth|key|secret)", key) else item) for key, item in query]
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(safe), parsed.fragment))

if __name__ == "__main__":
    print(json.dumps(classify_url(sys.argv[1]), ensure_ascii=False))
