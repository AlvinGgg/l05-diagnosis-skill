# L0.5 知识库：从这里开始

请按下面的顺序完成首次配置。

## 1. 完成本地 Jira 配置

让 Codex 使用 L05 的 `configure` 命令设置 `JIRA_BASE_URL`、`JIRA_AUTH_MODE` 和 `L05_OBSIDIAN_VAULT`，再由你在本机编辑 `~/.codex/l05-diagnosis.env` 填写 `JIRA_TOKEN`。该文件必须保存在知识库之外，权限设置为 `0600`。不要在对话中粘贴 Token，也不要把 Token 写入知识库。

让 Codex 执行：

```text
$l05-diagnosis 检查我的本地 L05 配置是否就绪，暂时不要诊断工单。
```

## 2. 安装 Obsidian 官方 Web Clipper

按照 <https://obsidian.md/help/web-clipper> 安装官方浏览器扩展，并选择当前 Vault。

创建两个模板：

- `L05 Document` -> `inbox/documents`
- `L05 Ticket` -> `inbox/tickets`

模板至少保留标题、来源 URL、采集日期和有用正文。对需要登录或内容噪声较多的页面，只选择与问题相关的 Summary、Description、用户评论、处理结论和验证证据。不要采集凭据、Cookie、Token、私钥、带秘密参数的 URL 或无关个人信息。

## 3. 保持 Inbox 边界

新文档和工单页面必须先进入 `inbox/`，不要直接写入 `raw/` 或 `wiki/`。

## 4. 让 Obsidian Agent 整理内容

将当前 Vault 作为 Agent 工作目录打开，然后发送：

```text
请按照当前 Vault 根目录 AGENTS.md 处理 inbox 下的所有新文件。
先预览并列出每个来源、敏感信息风险、计划写入的 raw/wiki 路径和需要补充的信息；不要覆盖或删除文件。
得到我确认后，保留原始证据、生成可追溯 source 页面，只在证据充分时更新 howto/system/topic，最后更新 index.md 和 log.md。
```

先检查 Agent 给出的计划，再授权持久化写入。删除 Inbox 或 Raw 文件始终需要单独确认。

## 5. 检查知识检索

确认 `index.md` 已链接到审核后的 Wiki 页面，并且 Source 页面能够追溯到 Raw 证据或安全的来源 URL。

## 6. 使用 L05 诊断工单

新建 Codex 任务并输入：

```text
$l05-diagnosis 诊断 ABC-12345
```

L05 会先获取当前 Jira 事实，再查询当前 Vault；只有在能够验证具体假设时才检查代码或浏览器证据。L05 不写入 Jira；生成知识候选也需要明确授权。
