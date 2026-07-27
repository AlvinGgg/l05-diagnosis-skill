# Route-specific report format

Create `Intent assessment` first as defined in `intent-routing.md`.

## Skill-user final response contract

The final response to the person using this Skill must retain the complete
auditable handling route even when progress commentary is collapsed. This
contract applies to problem investigation, request fulfillment, mixed, and
unclear cases.

Include these user-visible parts in this order:

1. outcome and current confidence or execution status;
2. `本次处理链路`;
3. material evidence gaps, pending input, and next action;
4. the SRE runbook or requester-facing Jira draft required by the selected
   route.

`本次处理链路` is mandatory and must be present in the final response itself.
A link to `diagnosis.md`, `fulfillment.md`, `clarification.md`, or
`case-summary.json` is useful supplementary evidence but is not a substitute.
Do not rely on commentary because it may be collapsed after the final answer.

Build the section by reconciling the fixed report with every supplemental
attachment, link, Repository, browser, web, Provider, runtime, or cluster access
performed later in the turn. For every attempted step include:

- status: `completed`, `completed_no_match`, `partial`, `failed`, or `not_run`;
- purpose;
- safe source or target;
- query, search, or inspection scope;
- observed result;
- effect on the conclusion or plan;
- exact safe references.

Record a failed access as `failed` with its consequence; never describe it as
completed evidence. Use `not_run` only for a route stopped by a gate, not to
enumerate every tool that could hypothetically have been used. This trace
describes observable actions and evidence provenance; it must not expose hidden
reasoning, secrets, raw sensitive logs, or unsafe internal values.

Keep `本次处理链路` outside the requester-facing Jira draft. The draft may remain
compact and include only the decisive evidence the requester needs.

For problem investigation use these sections in order:

1. Collection status
2. Ticket facts
3. Intent assessment
4. Timeline
5. Local KB matches and freshness
6. Investigation trail
7. Evidence inspected
8. Hypotheses with supporting and contradicting evidence
9. Root cause assessment for troubleshooting: `confirmed`, `probable`,
   `unresolved`, or `blocked`; guidance assessment for consultation:
   `supported`, `conditional`, or `unresolved`
10. Recommended change
11. Verification plan
12. Access and evidence gaps
13. Optional KB publish result
14. Jira reply draft, when the reply gate below is satisfied

Every non-obvious claim cites a Jira field/comment, bundle path, KB path, code
path/branch, attachment, link, browser page, or runtime command. Never promote
historical precedent to current truth without fresh evidence. Keep any Jira
reply a clearly labelled draft and do not write it back.

## Investigation trail rules

This section is for the Skill user, not the ticket requester. List each source
actually inspected in the order it contributed to the investigation. Include
the safe exact location, what was checked, and what it established:

```markdown
## Investigation trail

1. Jira `<issue-key>` / `<field, comment, attachment, or link>`: <result>
2. KB `<document or ticket title>` / `<evidence path>`: <result>
3. Repository `<identity>` / `<resolved ref or Commit>` / `<file:symbol>`: <result>
4. Jenkins `<job or build URL>`: <log/stage/result inspected>
5. <Provider, browser URL, runtime query, cluster target, or attachment>: <result>
```

Omit any line whose source was neither inspected nor attempted. Do not list
setup checks, planned follow-up, unsuccessful access, or generic reasoning as
completed investigation. Record an actual unsuccessful access as `failed`,
state what evidence remains unavailable, and keep it out of supporting evidence.
Keep raw logs and secrets out; preserve the exact safe URL for a Jenkins build
or browser page when it is useful to reproduce the investigation. The
customer-facing Jira reply may summarize decisive evidence, but must not copy
this internal trail or expose private local paths.

## Reply gate

Classify the ticket before drafting:

- **Troubleshooting**: generate a reply only when current evidence confirms the
  causal chain. A historical match, an untested hypothesis, or a proposed
  change is not enough.
- **Consultation**: generate a reply when authoritative documentation or
  current code supports the general answer. Ticket-specific values may remain
  open, but they must be labelled as inputs needed for an exact change.
- **Request fulfillment / requester input**: generate one ready-to-paste
  requester-information draft when missing requester-owned facts change the
  target, procedure, risk, rollback, or acceptance result. Do not ask the
  requester for internal SRE current state.
- **Request fulfillment / planning**: generate a human SRE runbook and a
  post-completion template labelled `not ready to paste`. Do not use completed
  tense while `execution_status=not_executed`.
- **Request fulfillment / completion**: generate a ready-to-paste completion
  reply only after actual changes and validation are recorded and
  `execution_status=verified_complete`.
- **Blocked or unsupported**: do not fabricate a customer answer. State the
  evidence gap and the next collection step instead.

The draft must be self-contained, written for the ticket requester, and safe to
retain as future Jira knowledge. Do not include credentials, secret-like
values, local filesystem paths, private repository URLs, raw internal tool
output, or blame-focused wording.

## Writing rules

- Lead with the stable product rule or direct answer. Do not repeat dates,
  event names, environment, or other known ticket background unless it changes
  the recommendation.
- Use professional, friendly language. Technical terms are allowed when they
  improve precision; explain only terms the requester needs to act.
- Keep the response compact. Include the causal or configuration details needed
  to reuse the ticket as knowledge, but omit investigation narration, duplicated
  facts, and evidence that does not affect the conclusion.
- If inspected code or documentation supports a useful configuration, include
  the smallest valid example. Use obvious placeholders for values that depend
  on the application or environment; never invent a production value.
- If a highly relevant KB document contains an original `source`, `source_url`,
  `url`, `canonical_url`, or an explicit original document link, include one to
  three titled source links under `相关参考文档`. Link to the original source,
  not the local Vault file. Do not include weak matches merely to fill the
  section.
- Phrase actions accurately: use past tense only for changes and validation
  proven to have occurred. Otherwise use `建议`、`请`、`完成后验证`.
- Make the answer durable: name the affected product/version, decisive symptom
  or condition, verified mechanism, action, and validation needed to understand
  the answer without the rest of the conversation.

Known failure pattern:

- Avoid: restating a temporary event or date before giving a general product
  rule.
- Prefer: state `对于 <product/version> 的 <operation>, 应 <authoritative
  configuration or procedure>` first; mention the temporary window only when
  it changes rollback or verification.

Use Chinese unless the requester asks for another language.

## Consultation reply

```markdown
## Jira reply draft (ready to paste)

您好，<direct, generally applicable answer supported by documentation/code>。

<brief handling instruction and important condition; do not repeat known ticket background>

<small configuration example when supported and useful>

<only the caveat or verification step that affects safe execution>

相关参考文档：
- [<document title>](<original source URL>)

<only when needed: exact ticket-specific information still required>
```

## Request fulfillment report

Use these sections in order:

1. Intent assessment
2. Current status
3. Request target and scope
4. Current evidence and pending confirmations
5. Requester information draft, only for `requester_input`
6. SRE handling runbook
7. User-side coordination, only when required
8. Risks, approval, and rollback
9. Completion criteria and evidence
10. Post-completion Jira reply draft
11. Handling trail and references
12. Access and evidence gaps
13. Optional KB publish result

The runbook must identify target and exclusions, prechecks, the recoverable
current-state snapshot, evidence-backed steps, stop conditions, positive and
negative validation, adjacent-scope checks, rollback, and the evidence SRE must
record. A procedure from documentation or precedent remains conditional until
the current product/version and control point are confirmed.

### Requester information draft

Generate this only when `pending_confirmations` contains `requester_input`.
Combine all material questions in one message, tell the requester what decision
each answer affects, and rerun intent and plan sufficiency after the answer.

```markdown
## Requester information draft (ready to paste)

您好，为确保本次 <需求目标> 按正确范围实施，请补充以下信息：

1. <requester-owned missing input and fill-in format>
   - 用途：该信息将决定 <target, parameter, risk, or acceptance result>。

收到以上信息后，我们会据此完善 SRE 处理流程、验证与回滚方案。当前尚未执行变更。
```

### Planning-stage completion template

```markdown
## Post-completion Jira reply draft (template, not ready to paste)

您好，您申请的 <需求目标> 已由 SRE 完成处理。

【已完成】
- <actual target and change; fill only from execution evidence>

【验证结果】
- <actual validation and result>

【用户侧后续】
- <retain only when requester action or acceptance is required>

【注意事项】
- <retain only material limitations or follow-up>
```

Keep placeholders visible during planning. This template is not a promise that
the work occurred.

### Verified completion reply

Use only when the actual target/configuration difference, execution time,
change or approval reference, validation, adjacent-scope health, and requester
action are recorded.

```markdown
## Jira reply draft (ready to paste)

您好，您申请的 <需求目标> 已完成。

【已完成】
- <actual target and evidence-backed change>

【验证结果】
- <actual validation result>

【用户侧后续】
- <only remaining requester action or acceptance>

【相关参考文档】
- [<public or requester-accessible source title>](<original source URL>)
```

Omit `用户侧后续` and `相关参考文档` when they add no value. Do not expose the
internal Handling trail, local paths, private Repository URLs, or raw tool
output.

## Troubleshooting reply

Use only sections that add information. `改进建议` and `相关参考文档` are
optional; the other sections are required for a confirmed troubleshooting
reply.

```markdown
## Jira reply draft (ready to paste)

您好，经排查，<one-sentence problem scope and conclusion>。

【问题说明】
<brief background, trigger, affected behavior, and scope; omit facts already implied by the conclusion>

【排查与证据】
- <short route or decisive check and observed evidence>
- <supporting code/config/runtime/document evidence>

【根因与结论】
<specific component/configuration/behavior and the verified causal chain>

【处理方案】
<completed fix, or clearly labelled recommendation with responsible scope>

<small configuration example when supported and useful>

【验证】
<observed result, or a clearly labelled verification plan when remediation is pending>

【改进建议】
<optional concrete prevention or operability improvement supported by evidence>

【相关参考文档】
- [<document title>](<original source URL>)
```

If the root cause is confirmed but the change has not yet been applied, label
it as a handling recommendation and do not state that the issue is resolved.
Do not turn the reply into a chronological tool log: summarize the route and
retain only evidence that makes the root cause auditable.

For every historical match, include `source_type / quality_level / freshness /
match_reason / evidence_path`. For every hypothesis, include supporting,
contradicting, and missing evidence plus a confidence ceiling. A medium or stale
historical ticket cannot independently raise current root cause above
`probable`.
