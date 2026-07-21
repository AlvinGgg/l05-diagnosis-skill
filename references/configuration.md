# L0.5 Diagnosis Configuration

Keep all organization-specific values outside the public Skill. Do not store secrets in the Skill, Vault, Profile, test fixtures, logs, or commands.

## First-time setup

Read `getting-started.md`, initialize a new empty Vault with `scripts/l05_setup.py init`, update the generated private configuration file, validate the generated Vault Profile, and run `scripts/l05_setup.py doctor`.

## Required configuration

- `JIRA_BASE_URL`: Jira site URL.
- `JIRA_TOKEN`: read-only Jira token or PAT. Never print it.
- `JIRA_AUTH_MODE`: `bearer` or `basic`.
- `JIRA_EMAIL`: required only for Basic authentication.
- `L05_OBSIDIAN_VAULT`: absolute path to the local Vault.

`PAAS_KB_ROOT` remains a legacy-compatible alias for an existing Vault. New installations should use `L05_OBSIDIAN_VAULT`.

## Vault Profile

`<Vault>/.l05-profile.json` contains only non-secret knowledge-path mappings, Repository metadata, and deterministic routing rules. It is separate from the private environment file. A new Vault receives a generic empty Profile; an existing Vault can create one with:

```bash
python3 scripts/l05_profile.py init --vault /absolute/path/to/vault
python3 scripts/l05_profile.py validate --vault /absolute/path/to/vault
```

The internal Schema is `references/schemas/l05-profile.schema.json`; users normally edit the generated example instead of the Schema. Repository URLs must rely on SSH Agent or Git Credential Helper and must not contain credentials, query parameters, or fragments.

Missing Repository entries only limit automatic code routing. Invalid Profile JSON, unsafe paths, unknown routing targets, or secret-shaped fields must be fixed before the Profile is used.

## Optional configuration

- `L05_CODE_ROOTS`: explicitly enabled local code roots, separated by the OS path separator.
- `L05_DEFAULT_BRANCH`: explicit branch used only when the operator requests local Repository synchronization.
- `L05_GITHUB_ACTIONS_WORKFLOW_REPO`: optional local workflow Repository.
- `L05_CACHE_DIR`: cache root for isolated remote Git mirrors.
- `L05_JIRA_COMMENT_EXCLUDE_REGEX`: automation or system-comment filter override.

Do not define a universal Jira URL, Vault path, code root, Repository, or default branch in the public Skill.

## Private configuration file

Use `~/.codex/l05-diagnosis.env`, or set `L05_CONFIG_FILE` to another private file. File permissions should be `0600`.

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

Missing Jira access blocks issue understanding and all later diagnosis steps. Missing Vault configuration blocks retrieval. Missing optional code, browser, or attachment access creates an Evidence Gap but does not authorize a substitute write or guess.
