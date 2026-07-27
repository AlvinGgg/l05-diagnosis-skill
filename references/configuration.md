# L0.5 Diagnosis Configuration

Keep all organization-specific values outside the public Skill. Do not store secrets in the Skill, Vault, Profile, test fixtures, logs, or commands.

## First-time setup

Immediately after installation, run `scripts/l05_setup.py doctor`. If it
returns `needs_setup`, preserve its complete `configuration_chain`, follow the
ordered `setup_actions`, and read `getting-started.md` for the relevant action.
Initialize a new empty Vault with `scripts/l05_setup.py init`, update the
private configuration, validate the Vault Profile, and rerun `doctor`. Do not
handle a real case until it returns `ready`.

## Required configuration

- `JIRA_BASE_URL`: Jira site URL.
- `JIRA_TOKEN`: read-only Jira token or PAT. Never print it.
- `JIRA_AUTH_MODE`: `bearer` or `basic`.
- `JIRA_EMAIL`: required only for Basic authentication.
- `L05_OBSIDIAN_VAULT`: absolute path to the local Vault.

`PAAS_KB_ROOT` remains a legacy-compatible alias for an existing Vault. New installations should use `L05_OBSIDIAN_VAULT`.

Every machine-specific path must stay outside the public Skill. Supply paths
through a CLI argument, process environment, or private local configuration.
Never copy resolved user paths into Skill source, bundled templates, tests,
durable reports, or public documentation.

## Vault Profile

`<Vault>/.l05-profile.json` contains only non-secret knowledge-path mappings,
optional Jira semantic field mappings, Repository metadata, and deterministic
routing rules. It is separate from the private environment file. A new Vault
receives a generic empty Profile; an existing Vault can create one with:

```bash
python3 scripts/l05_profile.py init --vault /absolute/path/to/vault
python3 scripts/l05_profile.py validate --vault /absolute/path/to/vault
```

The internal Schema is `references/schemas/l05-profile.schema.json`; users normally edit the generated example instead of the Schema. Repository URLs must rely on SSH Agent or Git Credential Helper and must not contain credentials, query parameters, or fragments.

Missing Repository entries only limit automatic code routing. Invalid Profile JSON, unsafe paths, unknown routing targets, or secret-shaped fields must be fixed before the Profile is used.

### Optional Jira semantic field mappings

Map organization custom field IDs or names to public semantic slots without
putting organization identifiers in the Skill:

```json
{
  "jira": {
    "field_mappings": {
      "request_type": ["customfield_12345"],
      "question_classification": ["Question Classification"],
      "issue_category": ["customfield_67890"],
      "environment": ["Environment"]
    }
  }
}
```

Allowed slots are `request_type`, `question_classification`,
`issue_category`, and `environment`. Selectors must be unique, non-empty
strings. These mappings are auxiliary intent signals; they do not override
explicit current requester text or prove root cause/current configuration.

## Optional Evidence Providers

Providers are local optional packages, not bundled enterprise behavior. Install each Provider Manifest under `~/.codex/l05-diagnosis/providers.d/`, keep its credentials in `~/.codex/l05-diagnosis.env`, and add only non-secret routing and settings to the Vault `.l05-profile.json`.

The Core supports `L05_PROVIDER_DIR` to override the Manifest directory for tests or managed installations. Do not put Tokens, passwords, cookies, private keys, or authenticated URLs in the Profile. See `provider-contract.md` and the independent Provider package README.

The local Kubectl Provider is an exception to generic credential discovery:
it accepts only the kubeconfig path pinned by its installer in a private local
policy, stores the non-secret locked policy at
`~/.codex/l05-diagnosis/kubectl-policy.json`, and exposes no kubeconfig
override. Keep context names and Namespace allowlists in that `0600` policy.
The Vault Profile may contain only safe route signals, a `cluster_alias`, and
Namespace hints; it must not contain kubeconfig, context, server, identity,
TLS, command, argument, selector, template, or raw API override fields.

## Optional configuration

- `L05_CODE_ROOTS`: explicitly enabled local code roots, separated by the OS path separator.
- `L05_DEFAULT_BRANCH`: explicit branch used only when the operator requests local Repository synchronization.
- `L05_GITHUB_ACTIONS_WORKFLOW_REPO`: optional local workflow Repository.
- `L05_CACHE_DIR`: cache root for isolated remote Git mirrors.
- `L05_JIRA_COMMENT_EXCLUDE_REGEX`: automation or system-comment filter override.
- `L05_PROVIDER_DIR`: optional local Provider Manifest directory override.

Do not define a universal Jira URL, Vault path, code root, Repository, or default branch in the public Skill.

## Private configuration file

Use `~/.codex/l05-diagnosis.env`, or set `L05_CONFIG_FILE` to another private
file. File permissions must deny group and other access; `0600` is the
recommended mode. `doctor` treats broader permissions as a setup blocker.

Precedence is:

```text
process environment
-> explicit L05_CONFIG_FILE
-> ~/.codex/l05-diagnosis.env
-> literal JIRA_TOKEN assignment in ~/.zshrc (legacy only)
```

Shell profiles are parsed as text only and never executed. Do not use command substitution in the configuration file.

## CLI overrides

```bash
python3 scripts/fetch_jira_issue.py ABC-123 --base-url https://jira.example.com
python3 scripts/search_obsidian.py "timeout" --vault /absolute/path/to/vault
python3 scripts/git_snapshot.py --repo-url https://git.example.com/org/platform.git --ref release-1 --query timeout
python3 scripts/search_local_code.py --query timeout --root /absolute/path/to/code --no-sync
```

Explicit CLI paths apply only to the current case. Never pass credentials as CLI arguments.

## Failure behavior

Missing Jira access blocks issue understanding and all later diagnosis steps. The blocked result must include a sanitized technical detail, a stable failure code, request and retry counts, whether retries were exhausted, and checks specific to configuration, authentication, permission, issue visibility, DNS, TLS, timeout, or service availability.

The Collector retries DNS, connection, timeout, HTTP 429, and HTTP 5xx failures up to three times with bounded exponential backoff. It does not retry local configuration, TLS, HTTP 401, HTTP 403, or HTTP 404 failures.

When the Agent runtime explicitly reports disabled or restricted network access, run the initial read-only Collector command with network permission instead of first executing it in a context known to fail. Issue that permitted shell command through a direct `exec_command` call. Do not nest it inside `functions.exec`, a composition tool, or another orchestration wrapper: an approval may complete without returning the resumed command output to the inner call. If restriction is discovered only after a normal attempt, rerun the same command directly with network permission. Count a network-permitted retry only after the tool returns a non-empty, parseable Collector result; blank, interrupted, approval-pending, or rejected calls are not completed retries. Retry a blank or interrupted permitted command up to three actual executions. Return a blocked result only after the permitted execution completes and its internal retries are exhausted, or after permission is explicitly denied.

Authentication and permission failures must not be misreported as network failures. Missing Vault configuration blocks retrieval. Missing optional code, browser, or attachment access creates an Evidence Gap but does not authorize a substitute write or guess.
