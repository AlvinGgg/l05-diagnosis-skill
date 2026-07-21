# Obsidian Agent Query Contract

Read the configured Vault's own `AGENTS.md` as the source of truth. The bundled Contract is only an initializer for a new empty Vault and must never replace an existing Contract automatically.

## Required query flow

1. Read `<vault>/AGENTS.md` and `<vault>/index.md`.
2. Follow the Vault's path mapping and quality rules.
3. Prefer reviewed How-to, System, Topic, and Source pages.
4. Check curated ticket source pages before Raw historical tickets.
5. Use Raw only to audit a source or fill an explicit Evidence Gap.
6. Cite Vault-relative paths and include freshness, quality, and match reason.
7. Treat historical tickets as precedent, never as proof of the current root cause.

Use `scripts/search_obsidian.py` only as a mechanical search helper:

```bash
python3 scripts/search_obsidian.py "namespace" "quota" --vault /absolute/path/to/vault
```

## Maintenance and writes

Ordinary L05 diagnosis does not modify the Vault. A durable Inbox Candidate requires explicit user authorization. When the user asks to organize Web Clipper content, open the Vault as the Agent workspace and follow its root `AGENTS.md`; do not invent a parallel folder contract.

Read `getting-started.md` for Web Clipper paths and the recommended Agent conversation.
