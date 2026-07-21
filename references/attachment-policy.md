# Attachment policy

- Modes: `off`, `metadata-only` (default), `auto`, and `all`.
- Download by Jira attachment id with bounded size, total bytes, timeout, and
  finite retries. Distinguish 403 permission gaps from 404 missing content.
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
