# L0.5 Diagnosis Evidence Contract

Use this contract for the final answer and for any durable notes created from an investigation.

## Required Evidence Groups

- Jira: issue key, summary, description signal, status, labels/components when available, relevant user comments, and updated timestamp. This group is mandatory before any diagnosis.
- Obsidian: exact vault file paths read, including `wiki/` pages and `raw/tickets/` files when historical tickets influenced the answer.
- Code: Repository, requested ref, resolved Commit, resolution basis, file path, symbol/config key, and whether the execution version was confirmed. For an explicitly enabled local Repository, also record branch and dirty/sync state.
- Browser: URL/page state only when Chrome/browser evidence was used.
- Missing: concrete fields, logs, screenshots, environments, namespaces, pipeline IDs, or owner input still required.
- Token/cache: exact runtime usage only if Codex exposes it for the current run.

## Claim Rules

- If Jira facts are unavailable, produce only a blocked result. Do not include Obsidian/code/browser claims or a preliminary diagnosis.
- Tie every non-obvious diagnosis claim to at least one evidence group.
- Separate observed fact from inference.
- Mark historical-ticket lessons as precedent unless current docs or code confirm them.
- Historical quality metadata is a retrieval weight, not proof of the current root cause.
- Do not include low, rejected, blocked, or secret-like historical evidence in ordinary retrieval output.
- Do not present LLM-generated reasoning as an authoritative operational fact.
- Do not claim that Jira, code, or browser state was verified unless the relevant tool was actually run.
- Give the Skill user an investigation trail containing every evidence source actually inspected and its purpose/result. Include safe exact identifiers such as Repository/ref/file, Jenkins job/build URL, KB path, Provider, or browser URL. Omit unused evidence types and keep this trail out of the customer-facing Jira draft.
- Generate a ready-to-paste troubleshooting reply only for a `confirmed` root cause. A consultation reply may be generated when authoritative documentation or current code supports the guidance. Both must distinguish completed actions and observed verification from recommendations and pending verification.
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

**排查链路**
1. <actual source/location inspected>：<what was checked and what it established>
2. <actual source/location inspected>：<what was checked and what it established>

**初步诊断**
<likely cause and confidence>

**建议动作**
<human action plan>

**Jira 回复草稿**
<optional draft, no writeback>

**Token/Cache 用量**
<optional; include only exact runtime prompt/completion/cache values exposed by Codex>
```

Keep the final response concise. Expand only when the issue spans multiple systems or conflicting evidence.
In `排查链路`, omit unused source types instead of writing `not used`.

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

For `jira_dns_resolution_failed`, `jira_network_unreachable`, or `jira_request_timeout`, retry the same read-only Collector command once with permitted network access before returning the blocked template. Do not retry authentication or permission failures as a network problem.
