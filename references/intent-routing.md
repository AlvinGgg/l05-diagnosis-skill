# Jira intent routing

Use this contract immediately after the current Jira Issue Bundle is validated
and before Vault retrieval, Provider invocation, code inspection, browser use,
or web research.

## Contents

1. Routing result
2. Evidence priority
3. Decision rules
4. Pending confirmations
5. Route behavior
6. Completion and reply gates

## Routing result

Record a structured `intent_assessment` in `case-summary.json`:

- `work_intent`:
  - `problem_investigation`: explain or restore unexpected behavior;
  - `request_fulfillment`: create or change a desired target state;
  - `mixed`: both are requested;
  - `unclear`: current facts cannot safely select a route.
- `delivery_mode`:
  - `answer_only`;
  - `human_runbook`;
  - `authorized_execution` only after separate explicit authorization.
- `confidence`: `high`, `medium`, or `low`.
- `execution_owner`: `sre`, `requester`, `shared`, or `unknown`.
- `planning_status`:
  - `ready_for_sre_review`;
  - `needs_requester_input`;
  - `needs_sre_current_state`;
  - `needs_approval`;
  - `blocked`.
- `execution_status`: `not_executed`, `in_progress`,
  `verified_complete`, or `rolled_back`.
- `supporting_signals`, `counter_signals`, and
  `pending_confirmations` with exact safe Jira provenance.

This assessment is derived evidence. Keep it out of `issue.normalized.json`,
which represents collected Jira facts.

## Evidence priority

Use:

1. the latest explicit requester outcome or acceptance condition;
2. Jira description symptoms, desired state, target, and environment;
3. relevant current requester comments;
4. issue type and mapped semantic fields;
5. historical precedent only for terminology or procedure.

Issue type, assignee, priority, status, labels, and one user-selected category
are auxiliary signals. None can decide intent alone.

Optional Profile mappings live under `jira.field_mappings` and may map Jira
custom field IDs or names to:

- `request_type`;
- `question_classification`;
- `issue_category`;
- `environment`.

Do not put organization field IDs or names in the public Skill defaults.

## Decision rules

Choose `problem_investigation` when current facts describe a failure,
unexpected behavior, expected/actual difference, causal question, or request
to investigate. A proposed change that depends on an unconfirmed causal chain
remains on this route until the cause is supported.

Choose `request_fulfillment` when current facts define a new target state and
ask to create, configure, grant, resize, migrate, switch, remove, or otherwise
change a named object. Requiring SRE is an ownership signal, not proof of this
intent by itself.

Do not turn a fulfillment request into `mixed` merely because SRE must inspect
the current state before changing it. Treat the missing or undesired current
state as a fulfillment precheck when the requester explicitly asks for the new
state. Add a separate investigation work item only when the requester also asks
why an expected existing state failed, regressed, or behaved unexpectedly, or
when the requested change depends on an unresolved causal explanation.

Examples:

- "Request Type 显示无权限，如何开放权限" is permission fulfillment; current
  access and the exact control point are SRE prechecks.
- "请屏蔽已列出的暴露路径" is security-policy fulfillment; verifying the
  exact exposed paths, control point, and unaffected traffic is a precheck.
- "如何在 Ingress 限制 PUT/DELETE" is configuration fulfillment; ambiguous
  security semantics may block planning but do not by themselves create a
  second investigation outcome.
- "QA 配置之前生效、现在又失效；修复后迁移到生产" is `mixed`: investigate
  the regression first, then fulfill the dependent production migration.

Choose `mixed` when both outcomes remain current:

- split investigation and fulfillment into separate sub-tasks;
- record their dependency;
- block the fulfillment sub-task when its correctness depends on the unresolved
  investigation;
- do not convert a hypothesis into a production step.

Choose `unclear` when neither symptom nor target state is specific enough.
Ask one consolidated question if selecting the wrong route changes the work,
risk, or acceptance result.

Use semantic classification with a visible evidence record. Deterministic
keyword matches may supply a conservative baseline, but must not silently
override explicit current requester language or conflicting evidence.

## Pending confirmations

Classify every material pending item:

- `requester_input`: target, environment, desired value, business validation,
  or another fact the requester reasonably owns;
- `sre_precheck`: current effective configuration, product/version, control
  point, resource existence, or SRE permission;
- `approval_input`: approval, change window, affected scope, and rollback owner;
- `evidence_gap`: authoritative documentation, code, configuration, or runtime
  evidence still needed.

If `requester_input` changes the target, procedure, risk, rollback, or
acceptance:

1. set `planning_status=needs_requester_input`;
2. output one ready-to-paste requester information draft containing only the
   minimum questions;
3. explain briefly what decision each answer affects;
4. do not request secrets or internal SRE state;
5. keep the implementation plan provisional;
6. rerun intent and plan sufficiency after the requester answers.

Put `sre_precheck` in the SRE runbook. Do not transfer internal verification to
the requester.

## Route behavior

### Problem investigation

Follow `diagnosis-workflow.md`. Build and test causal hypotheses. Generate a
ready-to-paste troubleshooting reply only after current evidence confirms the
causal chain.

### Request fulfillment

Use Jira facts to define current/target state, scope, owner, and missing input.
Retrieve evidence to prove procedure, parameters, limits, validation, and
rollback rather than root cause.

The SRE runbook must include:

1. target and exclusions;
2. prechecks, approval, window, and current-state snapshot;
3. evidence-supported implementation steps and stop conditions;
4. requester actions only when required;
5. positive, negative, and adjacent-scope validation;
6. rollback triggers, order, and post-rollback verification;
7. completion evidence to be recorded.

Internal evidence may be supplemented with current official vendor
documentation. Confirm the product, edition, version, region, controller, and
control point before applying a documented field. Official documentation proves
product behavior, not current production configuration.

### Unclear

Return the requester information draft and stop before Vault, Provider, code,
browser, runtime, or web investigation. Do not publish an unclear case.

## Completion and reply gates

During planning:

- state `execution_status=not_executed`;
- label the post-completion reply as a template that is not ready to paste;
- use placeholders for actual changes and validation.

Only mark `verified_complete` and produce a ready-to-paste completion reply when
current evidence records:

- the actual target and configuration difference;
- change/approval reference and execution time;
- positive and negative validation results;
- adjacent-scope health;
- rollback outcome when used;
- requester action or acceptance when required.

For fulfillment use `Handling trail and references`, not `Investigation trail`.
List only sources actually inspected. Keep internal paths and private
Repository URLs out of the requester-facing draft.
