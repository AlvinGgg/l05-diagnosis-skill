# Attachment policy

- Modes: `off`, `metadata-only` (default), `auto`, and `all`.
- The current CLI downloads bounded issue attachments in `all` mode and records
  every Jira attachment id in the Bundle manifest. It enforces per-file and
  total-byte limits, timeout, and finite retries. Distinguish 403 permission
  gaps from 404 missing content.
- Sanitize filenames, stream writes, compute SHA-256, and record declared and
  detected MIME. Keep originals separate from previews.
- Never execute attachments, shell commands, macros, installers, binaries, or
  archive contents. Never automatically extract an archive.
- Images may be viewed without transformation. Text/log/JSON/CSV previews must
  be bounded and disclose truncation. Use `scripts/safe_preview.py`.
- Treat PDF and Office files as read-only artifacts with the relevant document
  skill. Treat unknown binary, executable, and macro-enabled content as
  unsupported unless the user explicitly authorizes a safe inspection path.
- Publish metadata and necessary evidence references by default, not the entire
  temporary attachment cache.

## Canonical download command

Use only the Collector bundled with this Skill:

```bash
node "$SKILL_DIR/scripts/vendor/jira-collector/jira-collect.mjs" issue \
  --issue ABC-12345 \
  --base-url "$JIRA_BASE_URL" \
  --attachment-mode all \
  --raw-policy redacted
```

Do not call or infer legacy-style names such as
`scripts/jira_structured_collector.mjs`; that file is not part of this Skill.

The command emits one JSON envelope. Continue only when `status` is `ok` or
`partial`. Read:

- `output_root`: Collector-owned temporary root;
- `issues[0].bundle_path`: validated Bundle;
- `<bundle_path>/attachments/manifest.json`: attachment metadata and status;
- `<bundle_path>/attachments/files/`: downloaded files.

Inspect only files needed to test the current hypothesis. Images may be viewed
directly. For bounded text previews use:

```bash
python3 "$SKILL_DIR/scripts/safe_preview.py" \
  "<bundle_path>/attachments/files/<safe_filename>"
```

After inspection, remove the Collector-owned temporary root with its guarded
cleanup command:

```bash
node "$SKILL_DIR/scripts/vendor/jira-collector/jira-collect.mjs" cleanup \
  "<output_root>"
```

Never clean an inferred parent directory, and never replace the guarded cleanup
with a broad recursive delete. If collection fails, report the sanitized reason
and do not claim that any attachment was inspected.
