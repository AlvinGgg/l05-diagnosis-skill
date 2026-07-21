# Diagnosis workflow

## Case layout

`run_l05_case.mjs` creates an isolated directory containing the validated
collector bundle, `issue.normalized.json`, `issue.md`, `diagnosis.md`, and
`case-summary.json`. The directory is removed by default. `--keep-temp` or an
explicit `--case-dir` preserves it for review.

## Freshness

Compare Jira `source.issue_updated_at` with each KB record's
`source_updated_at`. Allow one second for timestamp precision differences.
Classify older KB as `stale`, equal/newer as `fresh`, and missing/unparseable as
`unknown`. Current Jira facts are authoritative for current state; KB evidence
is precedent and context.

## Retrieval

Build safe seeds from summary, description, comments, error/status codes, stack
frames, component, version, endpoint, and configuration keys. Never retain
secret-like values, full IP addresses, or sensitive URL queries as seeds.

Read `<kb>/AGENTS.md`, then `index.md`. Follow the Vault's own mapping and search in this order when those logical paths exist:

1. `wiki/sources/jira`;
2. `wiki/sources/tickets` and `wiki/sources/documents`;
3. relevant `wiki/howtos`, `wiki/systems`, `wiki/topics`, and `wiki/concepts`;
4. `raw/tickets` only as lower-layer source evidence.

Every result carries `source_type`, `quality_level`, `freshness`,
`match_reason`, and `evidence_path`. Quality is loaded only from a report that
matches `ingest_id + content_hash`: high ranks above medium, medium is marked
`needs-review`, and missing metadata is `unknown`. Hold/reject/blocked history
does not enter ordinary retrieval. Fresh evidence outranks an equally matching
stale precedent; a stale high-quality result may lead only when it has clearly
stronger match evidence.

## Evidence order

1. Current Jira normalized facts.
2. Freshness- and quality-labelled KB evidence.
3. Targeted attachments and links that test a hypothesis.
4. Exact isolated Repository Snapshot or explicitly enabled local code/config evidence.
5. Runtime/browser/cluster evidence only when needed and authorized.

Separate fact, inference, and unverified hypothesis. Optional evidence failure
creates a gap; core Jira/schema failure creates a blocked result.

## Jira reply draft

When the agent confirms a root cause from current evidence, append the
ready-to-paste Jira reply defined in `report-format.md`. The reply is a draft
for human review only; it never performs Jira writeback. The command-line
report starts at `unresolved`, so it deliberately does not fabricate a reply
without additional targeted evidence.

## Publication

`--publish-to-kb` creates a new redacted, validated bundle under `inbox/jira`.
It includes normalized facts, provenance, a diagnosis candidate, and attachment
metadata, but excludes downloaded attachment bytes, cached pages, and temporary
logs. The diagnosis status remains `unresolved` or `probable` unless evidence
proves root cause. The bundled quality evaluator writes an independent report,
but publication does not process or promote the inbox.
