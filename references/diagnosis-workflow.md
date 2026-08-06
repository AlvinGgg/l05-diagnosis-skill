# Case evidence workflow

## Intent gate

After the current Jira Bundle validates, read `intent-routing.md` and create the
structured `intent_assessment` and description-first `request_summary` before
reading the Vault or invoking a Provider. The summary carries the requester
ask, symptom/goal, exact safe target, comparison evidence, and description
provenance through retrieval and the next evidence question.

- `problem_investigation` enters causal diagnosis.
- `request_fulfillment` enters evidence-backed implementation planning.
- `mixed` keeps separate diagnosis and fulfillment sub-tasks with an explicit
  dependency.
- `unclear` returns the requester-information draft and stops.

Issue type and mapped custom fields are auxiliary signals. Store the derived
assessment in `case-summary.json`, not `issue.normalized.json`.

## Case layout

`run_l05_case.mjs` creates an isolated directory containing the validated
collector bundle, `issue.normalized.json`, `issue.md`, `case-summary.json`, and
one route-specific report: `diagnosis.md`, `fulfillment.md`, or
`clarification.md`. The directory is removed by default. `--keep-temp` or an
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

- For investigation, retrieve evidence that tests a concrete causal hypothesis.
- For fulfillment, retrieve evidence that proves the procedure, parameters,
  limitations, validation, rollback, and current control point.

Read `<kb>/AGENTS.md`, then `index.md`. Resolve explicit `wiki/sources/` links
from the index even when a legacy Profile does not list the top-level Source
folder. When an approved raw entry guide is configured, use it only to identify
an exact self-service or automated route; do not treat it as a historical root
cause. Follow the Vault's own mapping and search in this order when those
logical paths exist:

1. exact approved self-service entry in an index-linked Source page or
   `raw/files` entry guide, when the current scenario is specifically matched;
2. `wiki/sources/jira`;
3. `wiki/sources/tickets` and `wiki/sources/documents`;
4. relevant `wiki/howtos`, `wiki/systems`, `wiki/topics`, and `wiki/concepts`;
5. `raw/tickets` only as lower-layer source evidence.

An exact self-service match wins over generic historical precedent and generic
Provider routing. Return the entry, required inputs, verification, and failure
fallback to the requester, then defer manual investigation. A no-match or an
entry failure returns to the normal evidence order.

Every result carries `source_type`, `quality_level`, `freshness`,
`match_reason`, and `evidence_path`. Quality is loaded only from a report that
matches `ingest_id + content_hash`: high ranks above medium, medium is marked
`needs-review`, and missing metadata is `unknown`. Hold/reject/blocked history
does not enter ordinary retrieval. Fresh evidence outranks an equally matching
stale precedent; a stale high-quality result may lead only when it has clearly
stronger match evidence.

## Evidence order

1. Current Jira normalized facts and description-first request summary.
2. Structured intent assessment with supporting and counter-signals.
3. Exact approved self-service route, when one is specifically matched.
4. Freshness- and quality-labelled KB evidence.
5. Targeted attachments and links that test a hypothesis or implementation step.
6. Exact isolated Repository Snapshot or explicitly enabled local code/config evidence.
7. Current official vendor documentation when internal evidence does not define
   the product behavior or supported procedure.
8. Runtime/browser/cluster evidence only when needed and authorized.

Separate fact, inference, and unverified hypothesis. Optional evidence failure
creates a gap; core Jira/schema failure creates a blocked result.

## Internal source trail

The final answer to the Skill user must list every evidence location actually
inspected or attempted and why it was used. For each step preserve its status,
purpose, safe query or inspection scope, result, effect on the conclusion, and
exact identifiers when available:

- Jira issue plus the fields, comments, attachments, or links reviewed;
- KB document or historical ticket title and local evidence path;
- Repository identity, requested/resolved ref or Commit, file path, and symbol;
- Jenkins controller/job/build URL or other Provider record;
- Browser page, runtime query, cluster target, or attachment inspected.

Keep the trail separate from the customer-facing Jira reply. Record results
briefly rather than dumping raw logs. Omit an evidence type entirely when it was
not used or attempted. Record a failed attempt as `failed` and state the
resulting gap; never present it as completed inspection. The fixed report
captures automated Jira, Vault, and Provider steps. Append later attachment,
link, Repository, browser, web, runtime, and cluster steps to the turn-local
ledger, then reconcile both into the mandatory `本次处理链路` in the final
response. A report link or collapsed commentary is not a substitute. Use
`Investigation trail` for problem diagnosis and `Handling trail and references`
for fulfillment.

## Jira reply draft

Classify the request before drafting:

- For troubleshooting, append the ready-to-paste Jira reply from
  `report-format.md` only after current evidence confirms the causal chain.
- For consultation, a reply may be generated when authoritative documentation
  or current code supports the general guidance. Clearly separate the stable
  product rule from ticket-specific values or actions that still need input.
- For an exact approved self-service route, generate a ready-to-paste requester
  instruction with the entry link, required inputs, verification, and failure
  fallback. This is not a root-cause or completion claim, and it defers manual
  SRE handling until the documented route fails.
- For fulfillment with `requester_input`, generate the requester-information
  draft first. Keep the runbook provisional until the requester answers.
- During fulfillment planning, the post-completion reply is a template that is
  not ready to paste. Promote it only after actual execution and validation
  evidence satisfies `intent-routing.md`.

The reply is a draft for human review only; it never performs Jira writeback.
The command-line diagnosis starts at `unresolved`, and fulfillment starts at
`not_executed`, so neither route fabricates a completed reply.

## Publication

`--publish-to-kb` creates a new redacted, validated bundle under `inbox/jira`.
It includes normalized facts, provenance, the intent assessment, a diagnosis or
fulfillment candidate, and attachment metadata, but excludes downloaded
attachment bytes, cached pages, and temporary logs. Diagnosis remains
`unresolved` or `probable` unless current evidence proves root cause;
fulfillment remains `planned` unless execution evidence proves completion. The
bundled quality evaluator writes an independent report, but publication does
not process or promote the inbox.
