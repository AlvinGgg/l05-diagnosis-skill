# Link and authentication policy

Valid statuses are `not_attempted`, `accessible`, `login_required`,
`unauthorized`, `forbidden`, `not_found`, `timeout`, `network_error`,
`blocked_by_policy`, and `unsupported`.

- Never forward Jira Authorization/Cookie/token material to another origin.
- Redact query parameters named token, signature, sig, auth, key, or secret in
  logs and reports.
- Block `file:`, `javascript:`, localhost/loopback, link-local, cloud metadata,
  multicast/reserved addresses, and unapproved private-network targets.
- Recognize HTTP 200 login/SSO pages and authentication redirects as
  `login_required`, not accessible evidence.
- Inspect only links that can verify/falsify a current hypothesis. Optional link
  failure records a gap and does not fabricate a checked result.
- Rancher Kubernetes observations and resource URLs are not eligible for link
  or browser inspection. Treat them only as offline locator text and continue
  through the read-only Kubectl Provider. Never open the Rancher page, call its
  API, or authenticate. Rancher platform login/account/authorization/role
  issues stop for human SRE handling.
- Use `scripts/link_inspector.py` for offline URL and response classification.
