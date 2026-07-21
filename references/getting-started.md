# L0.5 Diagnosis Setup and First Use

Use this guide when the Skill is newly installed, `l05_setup.py doctor` reports `needs_setup`, or the user asks how to prepare the local knowledge Vault.

## Required order

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

Run the read-only check:

```bash
python3 "$SKILL_DIR/scripts/l05_setup.py" doctor
```

Do not start diagnosis until `jira_token_configured`, `jira_base_url_configured`, the Vault Contract, and Node.js are ready.

### 3. Install the official Obsidian Web Clipper

Install **Obsidian Web Clipper**, the official browser extension documented at <https://obsidian.md/help/web-clipper>. Configure it to save locally to the initialized Vault.

Create two Web Clipper templates:

- **L05 Document**: note location `inbox/documents`; use it for product documentation, runbooks, Wiki pages, and technical articles.
- **L05 Ticket**: note location `inbox/tickets`; use it for Jira or other support-ticket pages that are safe to retain.

Use a title-based file name and capture at least the page title, source URL, capture date, and selected page content. For authenticated or noisy pages, select only the useful Summary, Description, non-automation comments, resolution, and verification evidence before clipping. Do not capture login pages, credentials, Cookies, Tokens, secret-bearing URLs, or unrelated personal information.

Web Clipper templates support a configurable Note location and custom page variables. Follow the current official template documentation at <https://obsidian.md/help/web-clipper/templates>.

### 4. Put content in the correct Inbox

- General documents: `inbox/documents/`
- Manually clipped tickets: `inbox/tickets/`
- Structured Jira candidates explicitly published by L05: `inbox/jira/`

Do not place new content directly under `raw/` or `wiki/`. Inbox is the review boundary.

### 5. Ask the Obsidian Agent to organize content

Open the Vault as the Agent workspace so the root `AGENTS.md` applies, then use this prompt:

```text
请按照当前 Vault 根目录 AGENTS.md 处理 inbox 下的所有新文件。
先预览并列出每个来源、敏感信息风险、计划写入的 raw/wiki 路径和需要补充的信息；不要覆盖或删除文件。
得到我确认后，保留原始证据、生成可追溯 source 页面，只在证据充分时更新 howto/system/topic，最后更新 index.md 和 log.md。
```

The Agent must preview before durable writes and must ask before deleting Inbox or Raw files.

### 6. Verify retrieval

After the Agent organizes content, confirm that `index.md` links to the new Wiki pages and that every Wiki claim points to a source or Raw path. Then test a narrow query:

```bash
python3 "$SKILL_DIR/scripts/search_obsidian.py" "a distinctive error or product term" \
  --vault /absolute/path/to/new-vault
```

### 7. Use L05 diagnosis

Start a Codex task with:

```text
$l05-diagnosis Diagnose ABC-12345
```

The Agent must run setup checks, fetch current Jira facts first, then query the Vault and inspect targeted code or browser evidence only when it tests a concrete hypothesis. Jira remains read-only. A Knowledge Candidate or any external write requires separate explicit authorization.

## Optional code evidence

Configure remote Repository URLs in the private organization Profile or provide one for the current case. Prefer `scripts/git_snapshot.py` so code is fetched into an isolated cache and temporary Worktree. Do not require or alter the user's existing local repositories.

## Common setup failures

- `jira_token_missing`: update the private configuration file; do not send the Token in chat.
- `jira_base_url_missing_or_placeholder`: replace `jira.example.invalid` with the real Jira base URL.
- `vault_not_configured`: set `L05_OBSIDIAN_VAULT` or pass `--vault`.
- `vault_contract_incomplete`: initialize a new empty Vault, or inspect the existing Vault's `AGENTS.md` compatibility without overwriting it.
- Web Clipper captures incomplete content: select the required page sections or use a site-specific template before clipping again.
