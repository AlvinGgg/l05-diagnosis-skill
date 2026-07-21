# Diagnosis report format

Use these sections in order:

1. Collection status
2. Ticket facts
3. Timeline
4. Local KB matches and freshness
5. Evidence inspected
6. Hypotheses with supporting and contradicting evidence
7. Root cause assessment: `confirmed`, `probable`, `unresolved`, or `blocked`
8. Recommended change
9. Verification plan
10. Access and evidence gaps
11. Optional KB publish result
12. Jira reply draft, only when the root cause assessment is `confirmed`

Every non-obvious claim cites a Jira field/comment, bundle path, KB path, code
path/branch, attachment, link, browser page, or runtime command. Never promote
historical precedent to current truth without fresh evidence. Keep any Jira
reply a clearly labelled draft and do not write it back.

Generate a Jira reply draft only when current evidence confirms the causal
chain. A historical match, an untested hypothesis, or a proposed change is not
enough. The draft must be self-contained, written for the ticket requester, and
safe to retain as future Jira knowledge. Do not include credentials, secret-like
values, local filesystem paths, private repository URLs, internal tool output,
or blame-focused wording.

Use this structure in Chinese unless the requester asks for another language:

```markdown
## Jira reply draft (ready to paste)

【问题背景】
<affected behavior, scope, and user-visible impact from current Jira facts>

【根本原因】
<specific component/configuration/behavior and the verified causal chain>

【处理方案】
<completed fix, or clearly labelled pending action with the responsible scope>

【验证结果】
<observed validation result; if the change is pending, write a verification plan instead>

【后续建议】
<only include concrete prevention or follow-up work supported by evidence>
```

Use past tense only for an action and validation that the current evidence
proves have already occurred. If the root cause is confirmed but the change has
not yet been applied, label it as a handling recommendation and do not state
that the issue is resolved.

For every historical match, include `source_type / quality_level / freshness /
match_reason / evidence_path`. For every hypothesis, include supporting,
contradicting, and missing evidence plus a confidence ceiling. A medium or stale
historical ticket cannot independently raise current root cause above
`probable`.
