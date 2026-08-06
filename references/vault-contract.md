# Portable Vault Contract

The root `AGENTS.md` is the authority for a Vault. The bundled template is only for a new or empty Vault; never replace an existing Contract automatically.

## Required core

- `AGENTS.md`: Agent workflow and safety boundary.
- `index.md`: retrieval router.
- `log.md`: append-only maintenance history.
- `.l05-profile.json`: non-secret logical path mapping plus optional Repository catalog and deterministic routing rules. Validate it with `scripts/l05_profile.py`; never store credentials in it.

## Logical paths

- Inbox: `inbox/documents`, `inbox/tickets`, `inbox/jira`, and optional
  `inbox/ticket-additional-knowledge` for explicitly authorized,
  human-curated supplemental knowledge collected during ticket handling
- Raw: `raw/documents`, `raw/tickets`, and optional immutable `raw/files`
  source documents such as approved automation-entry guides
- Sources: `wiki/sources`, `wiki/sources/documents`, `wiki/sources/tickets`,
  `wiki/sources/jira`
- Synthesis: `wiki/howtos`, `wiki/systems`, `wiki/topics`, `wiki/concepts`
- Review: `wiki/questions`, `system/reports/jira-quality`

Existing Vaults may use different physical paths. Resolve them through local configuration or their Contract; do not move files merely to match this template.

An `index.md` link to an existing `wiki/sources/...` page is a retrieval hint
even for a legacy Profile that omits the top-level Source folder. `doctor` warns
when such a page lies outside configured search paths; it never changes that
Profile or Vault. A raw entry guide may supply a requester self-service route
only when it is configured as an approved raw path or paired with an
index-linked Source page, and when its specific scenario, safe Service Desk
entry, required inputs, and verification match the current Jira facts.

## Initialization rules

1. `l05_setup.py init` accepts only a missing or empty target directory.
2. A non-empty target returns `existing_vault_detected` and changes nothing.
3. Existing local configuration is never overwritten.
4. `doctor` is read-only and never emits credential values.
5. The initializer does not install Obsidian, browser extensions, community plugins, or team synchronization.
