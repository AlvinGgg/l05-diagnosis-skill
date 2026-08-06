# Obsidian Agent Query Contract

Read the configured Vault's own `AGENTS.md` as the source of truth. The bundled Contract is only an initializer for a new empty Vault and must never replace an existing Contract automatically.

## Required query flow

1. Read `<vault>/AGENTS.md` and `<vault>/index.md`.
2. Follow the Vault's path mapping and quality rules.
3. Resolve explicit `wiki/sources/...` links from `index.md`, then prefer
   reviewed How-to, System, Topic, and Source pages.
4. Before manual SRE guidance, check an approved `raw/files` entry guide for
   an exact self-service or automated route matching the current target or
   symptom. Return its link, required inputs, verification, and failure
   fallback; do not select it from a broad product keyword alone.
5. Check curated ticket source pages before Raw historical tickets.
6. Use Raw historical tickets only to audit a source or fill an explicit
   Evidence Gap; retain immutable entry guides only as procedural source
   evidence.
7. Cite Vault-relative paths and include freshness, quality, and match reason.
8. Treat historical tickets as precedent, never as proof of the current root cause.

Use `scripts/search_obsidian.py` only as a mechanical search helper:

```bash
python3 scripts/search_obsidian.py "namespace" "quota" --vault /absolute/path/to/vault
```

## Maintenance and writes

Ordinary L05 diagnosis does not modify the Vault. A durable Inbox Candidate requires explicit user authorization. When the user asks to organize Web Clipper content, open the Vault as the Agent workspace and follow its root `AGENTS.md`; do not invent a parallel folder contract.

Human-curated supplemental knowledge from ticket handling belongs under
`<vault>/inbox/ticket-additional-knowledge/`, not `inbox/jira/`. Keep it
`needs-review`, preserve its human provenance and evidence gaps, and do not
treat it as a validated Jira Bundle or established retrieval evidence.

Read `getting-started.md` for Web Clipper paths and the recommended Agent conversation.
