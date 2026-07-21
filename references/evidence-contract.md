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
- Generate a ready-to-paste Jira reply only for a `confirmed` root cause. It must distinguish completed remediation and observed verification from a pending recommendation and verification plan.

## Output Template

```markdown
**问题理解**
<one paragraph with issue type>

**证据**
- Jira: <key facts>
- Obsidian: <files and relevant facts>
- Code: <repos/files/branches or not used>
- Missing: <remaining gaps>

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

## Blocked Template

Use this shape when Jira facts cannot be fetched or are insufficient:

```markdown
**阻塞**
无法诊断 <issue-key>，因为还没有拿到 Jira 工单事实：<missing token/permission/fetch error/empty issue content>。

**需要补充**
请在本地配置只读 Jira 访问，或直接提供 summary、description、用户 comments。

**Token/Cache 用量**
<optional; include only exact runtime prompt/completion/cache values exposed by Codex>
```
