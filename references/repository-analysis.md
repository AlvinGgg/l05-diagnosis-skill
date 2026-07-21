# Repository Analysis Contract

Use code evidence only when it tests a concrete hypothesis about implementation behavior, platform configuration, deployment, pipeline logic, manifests, scripts, or API/data flow.

## Default provider: isolated remote snapshot

Resolve the relevant Repository from current issue evidence or an organization Profile. A business Repository URL does not exclude a platform pipeline, shared workflow, gateway, or orchestration Repository; route by component role before fetching code.

Use `scripts/git_snapshot.py` with the exact runtime Commit, branch, or tag when available:

```bash
python3 "$SKILL_DIR/scripts/git_snapshot.py" \
  --repo-url https://git.example.com/org/platform.git \
  --ref release-1 \
  --query "distinctive-error"
```

The helper uses a Skill-owned Mirror and temporary detached Worktree. It never checks out, pulls, cleans, or modifies a user's existing Repository. Without an explicit ref it resolves the remote default branch and records the Commit. If runtime evidence points to another Commit or ref, the current remote HEAD cannot be described as the executed code.

Credentials come from SSH Agent or Git Credential Helper. Reject URLs with embedded credentials or secret query values.

## Optional local provider

Use `scripts/search_local_code.py` only when the user explicitly enables local roots. Local search is read-only by default:

```bash
python3 "$SKILL_DIR/scripts/search_local_code.py" \
  --root /absolute/path/to/code \
  --query "distinctive-error" \
  --no-sync
```

Local synchronization requires both `--sync` and an explicit `--branch`. Never discard dirty worktrees or use forced checkout, reset, or clean.

## GitHub Actions routing

When current evidence contains an Actions run/job URL, inspect the calling workflow and every `uses: ...@ref` edge before generic search. Repository locations are supplied by the organization Profile or current evidence, never by public defaults.

Use `scripts/inspect_github_actions.py --repo <snapshot-or-explicit-local-repo>` to distinguish calling secrets, reusable workflow inputs, action inputs, and runtime logs. A name difference alone is not a root cause until the call chain is traced.

## Evidence record

Record Repository identity, requested ref, resolved Commit, resolution basis, fetch time, file path, line number, and whether the execution version is confirmed. Fetch failure or version uncertainty is an Evidence Gap.
