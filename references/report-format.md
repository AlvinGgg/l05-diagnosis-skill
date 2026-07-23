# Diagnosis report format

Use these sections in order:

1. Collection status
2. Ticket facts
3. Timeline
4. Local KB matches and freshness
5. Investigation trail
6. Evidence inspected
7. Hypotheses with supporting and contradicting evidence
8. Root cause assessment for troubleshooting: `confirmed`, `probable`,
   `unresolved`, or `blocked`; guidance assessment for consultation:
   `supported`, `conditional`, or `unresolved`
9. Recommended change
10. Verification plan
11. Access and evidence gaps
12. Optional KB publish result
13. Jira reply draft, when the reply gate below is satisfied

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

Omit any line whose source was not actually inspected. Do not list setup checks,
planned follow-up, unsuccessful access, or generic reasoning as completed
investigation. Keep raw logs and secrets out; preserve the exact safe URL for a
Jenkins build or browser page when it is useful to reproduce the investigation.
The customer-facing Jira reply may summarize decisive evidence, but must not
copy this internal trail or expose private local paths.

## Reply gate

Classify the ticket before drafting:

- **Troubleshooting**: generate a reply only when current evidence confirms the
  causal chain. A historical match, an untested hypothesis, or a proposed
  change is not enough.
- **Consultation**: generate a reply when authoritative documentation or
  current code supports the general answer. Ticket-specific values may remain
  open, but they must be labelled as inputs needed for an exact change.
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
