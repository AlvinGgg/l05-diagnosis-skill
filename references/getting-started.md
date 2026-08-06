# L0.5 Diagnosis Setup and First Use

Use this guide immediately after the Skill is installed, when
`l05_setup.py doctor` reports `needs_setup`, or when the user asks how to
prepare the local knowledge Vault. Run `doctor` first, present its complete
`configuration_chain`, and follow only its ordered `setup_actions`. Do not
start Jira collection until `doctor` returns `ready`.

Optional Evidence Providers are installed only after the Jira and Vault setup below is ready. They are not required for basic diagnosis.

## Required order

### 0. Run the post-install configuration gate

```bash
python3 "$SKILL_DIR/scripts/l05_setup.py" doctor
```

The result checks the externally configured Vault path, Jira connection
settings, credential presence, private-file permissions, Vault Profile, and
required runtime. It never prints credential values. If the result is
`needs_setup`, retain the complete configuration chain in the response and
perform only the listed safe setup actions.

### 1. Install Obsidian and create a Vault

Install Obsidian, create an empty local Vault, and note its absolute path. Do not point initialization at an existing non-empty Vault unless the user only wants a read-only compatibility check.

Initialize the empty Vault and a private configuration skeleton:

```bash
python3 "$SKILL_DIR/scripts/l05_setup.py" init \
  --vault /absolute/path/to/new-vault \
  --jira-base-url https://jira.example.com
```

The initializer refuses to change a non-empty Vault. Use `doctor`, not `init`, for an existing Vault.

### 2. Configure Jira credentials locally

Set or correct the non-secret values without changing an existing Token:

```bash
python3 "$SKILL_DIR/scripts/l05_setup.py" configure \
  --vault /absolute/path/to/new-vault \
  --jira-base-url https://jira.example.com
```

Then edit `~/.codex/l05-diagnosis.env` and set the private Token:

```text
JIRA_BASE_URL=https://jira.example.com
JIRA_TOKEN=<your-read-only-token>
JIRA_AUTH_MODE=bearer
L05_OBSIDIAN_VAULT=/absolute/path/to/new-vault
```

For Jira Basic authentication also set `JIRA_EMAIL` and use `JIRA_AUTH_MODE=basic`. Keep the file permission at `0600`. Never paste the Token into an Agent conversation, commit it, place it in the Vault, or pass it on a command line.

### 3. Configure the non-secret Vault Profile

New Vaults already contain `.l05-profile.json`. For an existing Vault, create only the missing Profile without changing other files:

```bash
python3 "$SKILL_DIR/scripts/l05_profile.py" init \
  --vault /absolute/path/to/existing-vault
```

Review the generated Profile and keep only non-secret values in it:

- map the Vault's existing logical knowledge paths;
- add remote Repository URLs without embedded credentials;
- assign stable Repository roles such as `business-source`, `pipeline-orchestrator`, `shared-workflow`, or `gateway`;
- add deterministic rules that map normalized problem types and current signals to candidate repositories.

The public Skill does not know organization field names, products, domains, or repositories. Do not add Tokens, passwords, Cookies, private keys, authentication headers, or secret-bearing URLs to the Profile.

Validate it:

```bash
python3 "$SKILL_DIR/scripts/l05_profile.py" validate \
  --vault /absolute/path/to/vault
```

An empty Repository catalog is allowed and means automatic code routing is unavailable. Invalid Profile JSON or unsafe mappings must be fixed.

### 4. Run the setup check

```bash
python3 "$SKILL_DIR/scripts/l05_setup.py" doctor
```

Do not start case handling until `doctor` returns `ready`. This requires a
non-placeholder Token, valid Jira URL and authentication mode, Basic email when
applicable, secure private-file permissions, an absolute configured Vault path,
the complete Vault Contract, a valid Profile, and Node.js.
`code_repositories_not_configured` remains a warning rather than a blocker.

### 5. Install the official Obsidian Web Clipper

Install **Obsidian Web Clipper**, the official browser extension documented at <https://obsidian.md/help/web-clipper>. Configure it to save locally to the initialized Vault.

Create two Web Clipper templates:

- **L05 Document**: note location `inbox/documents`; use it for product documentation, runbooks, Wiki pages, and technical articles.
- **L05 Ticket**: note location `inbox/tickets`; use it for Jira or other support-ticket pages that are safe to retain.

Use a title-based file name and capture at least the page title, source URL, capture date, and selected page content. For authenticated or noisy pages, select only the useful Summary, Description, non-automation comments, resolution, and verification evidence before clipping. Do not capture login pages, credentials, Cookies, Tokens, secret-bearing URLs, or unrelated personal information.

Web Clipper templates support a configurable Note location and custom page variables. Follow the current official template documentation at <https://obsidian.md/help/web-clipper/templates>.

### 6. Put content in the correct Inbox

- General documents: `inbox/documents/`
- Manually clipped tickets: `inbox/tickets/`
- Structured Jira candidates explicitly published by L05: `inbox/jira/`
- Human-curated supplemental knowledge explicitly retained while handling a
  ticket: `inbox/ticket-additional-knowledge/`

Do not place new content directly under `raw/` or `wiki/`. Inbox is the review boundary.
Supplemental knowledge is not a structured Jira Bundle or current Jira fact;
record its issue key, capture date, human provenance, fact/inference boundary,
and evidence gaps, and keep it `needs-review` until the Vault's review flow
accepts it.

### 7. Ask the Obsidian Agent to organize content

Open the Vault as the Agent workspace so the root `AGENTS.md` applies, then use this prompt:

```text
请按照当前 Vault 根目录 AGENTS.md 处理 inbox 下的所有新文件。
先预览并列出每个来源、敏感信息风险、计划写入的 raw/wiki 路径和需要补充的信息；不要覆盖或删除文件。
得到我确认后，保留原始证据、生成可追溯 source 页面，只在证据充分时更新 howto/system/topic，最后更新 index.md 和 log.md。
```

The Agent must preview before durable writes and must ask before deleting Inbox or Raw files.

### 8. Verify retrieval

After the Agent organizes content, confirm that `index.md` links to the new Wiki pages and that every Wiki claim points to a source or Raw path. Then test a narrow query:

```bash
python3 "$SKILL_DIR/scripts/search_obsidian.py" "a distinctive error or product term" \
  --vault /absolute/path/to/new-vault
```

### 9. Use L05 diagnosis

Start a Codex task with:

```text
$l05-diagnosis Diagnose ABC-12345
```

The Agent must run setup checks, fetch current Jira facts first, then query the Vault and inspect targeted code or browser evidence only when it tests a concrete hypothesis. Jira remains read-only. A Knowledge Candidate or any external write requires separate explicit authorization.

## Optional code evidence

Configure remote Repository URLs and routing rules in `.l05-profile.json`, then use `scripts/l05_profile.py resolve` after understanding the current issue. Prefer `scripts/git_snapshot.py` so matched code is fetched into an isolated cache and temporary Worktree. Do not require or alter the user's existing local repositories.

## Common setup failures

- `jira_token_missing`: update the private configuration file; do not send the Token in chat.
- `jira_base_url_missing_or_placeholder`: replace `jira.example.invalid` with the real Jira base URL.
- `jira_auth_mode_missing_or_invalid`: set `JIRA_AUTH_MODE` to `bearer` or `basic`.
- `jira_email_missing_for_basic_auth`: set `JIRA_EMAIL` locally when using Basic authentication.
- `private_config_permissions_too_open`: restrict the private file to `0600`.
- `jira_authentication_failed`: confirm Token validity and `JIRA_AUTH_MODE`; Basic authentication also requires `JIRA_EMAIL`.
- `jira_permission_denied`: confirm Browse Projects and Issue Security access for the Token's account.
- `jira_issue_not_found`: check the issue key, Jira instance, and whether Jira masks inaccessible issues as 404.
- `jira_dns_resolution_failed` / `jira_network_unreachable`: check the URL, enterprise network/VPN and DNS; if only the Agent sandbox fails, grant the same read-only collection command network access and let the Collector perform its bounded retries.
- `jira_tls_failed`: install or configure the approved enterprise CA; do not globally disable TLS verification.
- `vault_not_configured`: set `L05_OBSIDIAN_VAULT` or pass `--vault`.
- `vault_path_must_be_absolute`: replace a relative Vault value with its absolute path in the private configuration.
- `vault_contract_incomplete`: initialize a new empty Vault, or inspect the existing Vault's `AGENTS.md` compatibility without overwriting it.
- `profile_missing`: create and validate `.l05-profile.json` before handling a case.
- `profile_invalid`: run `l05_profile.py validate` and fix only the reported non-secret field paths.
- `code_repositories_not_configured`: optional code routing is unavailable; add Repository metadata and rules when needed.
- Web Clipper captures incomplete content: select the required page sections or use a site-specific template before clipping again.
## Optional Evidence Providers

For each independently distributed Provider:

1. Read the Provider package `SKILL.md` and safety reference, then confirm its read-only boundary.
2. Run its local Manifest installer.
3. Add the required credential names to `~/.codex/l05-diagnosis.env` without sharing their values with the Agent.
4. Add the Provider's non-secret Profile object to `.l05-profile.json`.
5. Run `l05_profile.py validate`, then use a sanitized fixture or read-only smoke case.

Do not copy an organization's endpoints, field aliases, resource catalog, or routing rules into the public Core Skill.

For `l05-kubectl-provider`, never configure or pass a kubeconfig through the
Vault Profile. Its installer must pin the approved kubeconfig path in the
private locked policy, and its runtime must use only that path; context and
Namespace admission also live in the private policy. A blocked policy or RBAC
check creates an Evidence Gap and must never fall back to default kubectl
configuration.
