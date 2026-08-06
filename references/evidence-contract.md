# L0.5 Case Evidence Contract

Use this contract for the final answer and for any durable notes created from
an investigation or request-fulfillment plan.

## Required Evidence Groups

- Jira: issue key, summary, description signal, status, labels/components when available, relevant user comments, and updated timestamp. This group is mandatory before any diagnosis.
- Intent: `work_intent`, delivery mode, confidence, supporting and counter-signals, planning/execution status, owner, pending confirmations, and the description-first `request_summary` (ask, symptom/goal, safe target identity, structured Domain/Application/Namespace/Environment/Subscription fields when mapped, comparison, and description evidence). This group is mandatory after Jira validates.
- Obsidian: exact vault file paths read, including `wiki/` pages, approved `raw/files/` entry guides when they select a self-service route, and `raw/tickets/` files when historical tickets influenced the answer.
- Resolution channel: when a specifically matched approved self-service or automated entry can resolve the scenario, its source, safe entry URL, required inputs, verification, and failure fallback. This replaces generic manual SRE work only for that initial documented route.
- Code: Repository, requested ref, resolved Commit, resolution basis, file path, symbol/config key, and whether the execution version was confirmed. For an explicitly enabled local Repository, also record branch and dirty/sync state.
- Browser: URL/page state only when Chrome/browser evidence was used.
- Kubernetes: Provider capability, safe context alias, Namespace, Kind/Name, resource version or collection time, projected fields, RBAC/TLS state, truncation/redaction, and gaps. Never include a kubeconfig, raw object, Secret, endpoint address list, or unredacted log.
- Loki: Evidence Plan question and source, canonical Kubectl cluster reference, target role,
  label-independent log identity when present, tenant label/selector-resolution outcome,
  tenant source (never a credential), bounded time range and limit, Gateway
  source, index estimate, projected/redacted excerpt count, safe scan stats,
  aggregation partition completion and final TopK counts when applicable,
  truncation/budget state, and gaps. Record query and tenant fingerprints
  instead of raw LogQL, headers, Gateway URLs, full correlation IDs, or
  unredacted log lines.
- Missing: concrete fields, logs, screenshots, environments, namespaces, pipeline IDs, or owner input still required.
- Token/cache: exact runtime usage only if Codex exposes it for the current run.

## Claim Rules

- If Jira facts are unavailable, produce only a blocked result. Do not include Obsidian/code/browser claims or a preliminary diagnosis.
- Create the intent assessment before Vault, Provider, code, browser, runtime, or web evidence. If intent is `unclear`, return the requester-information draft and stop.
- Treat the Jira description as the baseline request record. A later comment can replace a target only with an explicit correction and must not remove the description-derived target or comparison from the evidence record.
- Tie every non-obvious diagnosis claim to at least one evidence group.
- Separate observed fact from inference.
- Mark historical-ticket lessons as precedent unless current docs or code confirm them.
- Historical quality metadata is a retrieval weight, not proof of the current root cause.
- Do not include low, rejected, blocked, or secret-like historical evidence in ordinary retrieval output.
- Do not present LLM-generated reasoning as an authoritative operational fact.
- Do not claim that Jira, code, or browser state was verified unless the relevant tool was actually run.
- Give the Skill user a mandatory `本次处理链路` containing every evidence source actually inspected or attempted. For each step record status, purpose, safe source/target, query scope, result, effect on the conclusion, and exact safe references such as Repository/ref/file, Jenkins job/build URL, KB path, Provider, or browser URL. Mark failed access as failed and retain the resulting gap; use `not_run` only when an intent or safety gate stopped downstream retrieval. Omit unused evidence types and keep this trail out of the customer-facing Jira draft.
- When Loki is planned, matched, called, skipped by budget, or blocked, retain
  every distinct step: Application identity, Gateway Profile selection,
  Gateway health, tenant label/selector resolution, index estimate, each
  tenant/role query, optional Gateway discovery, and Profile reconciliation. A
  Loki observation remains evidence; it cannot by itself promote root cause or
  fulfillment status.
- Generate a ready-to-paste troubleshooting reply only for a `confirmed` root cause. A consultation reply may be generated when authoritative documentation or current code supports the guidance. Both must distinguish completed actions and observed verification from recommendations and pending verification.
- An exact approved self-service entry is a separate reply gate: generate a ready-to-paste requester instruction containing the entry link, required inputs, verification, and failure fallback. Do not call it a root-cause finding, automated completion, or SRE-performed action. Record generic Provider work as `not_run` unless an explicit Evidence Plan was requested.
- For fulfillment, distinguish `requester_input`, `sre_precheck`, `approval_input`, and `evidence_gap`. Ask the requester only for information they reasonably own; keep internal current-state checks in the SRE runbook.
- A fulfillment runbook must include target/exclusions, current-state snapshot, evidence-backed steps, stop conditions, validation, rollback, and completion evidence. Documentation proves supported product behavior, not current production state.
- While `execution_status=not_executed`, label the completion reply as a template that is not ready to paste. Use completed tense only for actions and validation proven by current execution evidence.
- When a configuration example is supported by the inspected documentation or code, include the smallest useful example with placeholders instead of secret, environment-specific, or invented values.
- When a highly relevant KB document contains an original source URL, include that URL in the customer reply. Do not expose a local Vault path, and do not invent a source URL when metadata is absent.

## Output Template

```markdown
**问题理解**
<one paragraph with issue type>

**证据**
- Jira: <key facts>
- Obsidian: <files and relevant facts>
- Code: <repos/files/branches or not used>
- Missing: <remaining gaps>

**本次处理链路**
1. `<status>` / <safe source or target>
   - 目的：<why this source was queried>
   - 查询范围：<safe query, fields, path, ref, time window, or capability>
   - 结果：<observed result>
   - 对结论的影响：<how this changed or bounded the conclusion>
   - 引用：<exact safe identifiers>

**初步诊断**
<likely cause and confidence>

**建议动作**
<human action plan>

**Jira 回复草稿**
<optional draft, no writeback>

**Token/Cache 用量**
<optional; include only exact runtime prompt/completion/cache values exposed by Codex>
```

Keep conclusions and the Jira draft concise, but never remove `本次处理链路`.
Omit unused source types instead of writing `not used`; retain actual failed
attempts and an intentional gate stop.

## Request fulfillment output

```markdown
**意图判断**
<work intent, confidence, evidence signals, and pending confirmations>

**当前状态**
<planning status, execution status, and whether drafts are ready to paste>

**工单目标与范围**
<current facts, desired state, target, environment, and exclusions>

**用户补充信息草稿**
<only for requester_input; consolidate minimum answerable questions>

**面向 SRE 的处理流程**
<prechecks, snapshot, implementation, stop conditions, validation, rollback>

**完成判定与需回填证据**
<actual change, approval, time, validation, adjacent scope, acceptance>

**处理完成后的回复草稿**
<template until verified_complete; ready to paste only after evidence>

**本次处理链路**
<all actual searches and attempts with status, purpose, scope, result, impact, and safe references>
```

Omit `用户补充信息草稿` when no `requester_input` exists. Do not ask the
requester to discover an `sre_precheck`.

## Blocked Template

Use this shape when Jira facts cannot be fetched or are insufficient:

```markdown
**阻塞**
无法诊断 <issue-key>，因为还没有拿到 Jira 工单事实。

**Jira 访问失败原因**
- 分类：<reason_code 对应的简明原因>
- 技术详情：<sanitized technical_detail>

**请检查**
1. <failure-specific check>
2. <failure-specific check>

**未执行**
未读取 Obsidian、历史工单、代码、浏览器或可选 Provider，也未进行问题推断。

**Token/Cache 用量**
<optional; include only exact runtime prompt/completion/cache values exposed by Codex>
```

For `jira_dns_resolution_failed`, `jira_network_unreachable`, or `jira_request_timeout`, the Collector must perform one to three bounded retries. If the Agent runtime explicitly restricts network access, run the initial read-only Collector command with permitted network access; otherwise rerun the same command with permission after the first restricted failure. Make the permitted command a direct `exec_command` call rather than nesting it in a composition or orchestration wrapper. Do not count a blank, interrupted, pending, or rejected tool result as a completed retry. Return this blocked template only after a permitted command has returned a parseable result with exhausted retries, or after permission was denied. Include `request_attempts`, `retry_count`, and `retries_exhausted` in the internal failure result. Do not retry authentication or permission failures as a network problem.
