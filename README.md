# l05-diagnosis

一个面向 Jira 支持工单的 L0.5 初诊 Skill。它先获取当前工单事实，再结合本地 Obsidian 知识库、历史工单和按需代码证据形成可追溯的诊断结论。

本项目不是自动回复机器人，也不会替代 SRE 做生产变更。它的目标是缩短信息收集和初步排查时间，提高一次解决率，并把经人工审核的处理经验沉淀为后续可复用的知识。

## 核心设计

```mermaid
flowchart TD
    U["用户提供 Jira 工单号或 URL"] --> G["配置与安全检查"]
    G --> J["只读采集当前 Jira 事实"]
    J -->|失败| B["阻塞并返回缺失配置或访问问题"]
    J -->|成功| Q["理解问题并生成安全检索词"]
    Q --> K["检索 Obsidian 知识库"]
    Q --> E["按需检查附件、链接、浏览器或运行时证据"]
    Q --> C["按需获取隔离的远程代码快照"]
    K --> R["证据分级与根因判断"]
    E --> R
    C --> R
    R --> D["结构化诊断报告"]
    R -->|根因已确认| P["生成可直接粘贴到 Jira 的中文回复草稿"]
    D -->|明确授权后| I["生成脱敏的知识库 Inbox 候选"]
```

### 关键原则

- **先理解工单，再诊断**：Jira 采集失败时立即停止，不使用历史相似案例猜测当前问题。
- **当前事实优先**：当前 Jira 内容是现状依据，历史工单和 Wiki 只作为先例或背景。
- **证据可追溯**：区分观察事实、历史先例、推断和缺失信息，并记录来源与新鲜度。
- **默认只读**：不会评论、转派、变更状态或执行其他 Jira 写操作。
- **人工审核**：只有根因得到当前证据确认时，才生成完整 Jira 回复草稿。
- **知识发布受控**：只有用户明确授权后，才在 Vault 的 Inbox 中生成脱敏候选；不会自动晋升为正式知识。
- **代码隔离**：远程仓库使用独立 Mirror 和临时 detached Worktree，不修改用户已有仓库。

## 能力范围

| 能力 | 默认行为 |
| --- | --- |
| Jira 工单 | 只读获取 Summary、Description、用户评论、字段、链接和附件元数据 |
| Obsidian | 检索本地 Vault 中经过整理的文档、Wiki 和历史工单 |
| 历史工单 | 按匹配度、质量和新鲜度排序，不直接视为当前根因 |
| 附件与链接 | 仅在验证具体假设时按安全策略访问 |
| 代码分析 | 优先获取指定分支、Tag 或 Commit 的隔离远程快照 |
| 浏览器与运行时 | 由 Agent 在必要且已授权时使用可用工具补充证据 |
| 诊断输出 | 结构化报告；根因确认后附带 Jira 可粘贴回复草稿 |
| 知识沉淀 | 明确授权后生成脱敏 Inbox 候选，等待人工整理 |

当前版本不内置 CMDB、Jenkins、Loki 或团队 Git 知识库 Provider。这些系统可以作为后续的只读证据源扩展，但不是本地运行依赖。

## 环境要求

- 支持 Agent Skills 的 Codex 或兼容 Agent
- Python 3.9+
- Node.js 18+
- Git
- Obsidian
- Jira 只读 Token 或 PAT
- 可选：`rg`，用于更快的知识库和代码搜索

## 安装

### 让 AI Agent 安装

把下面这段 Prompt 发给具有本地 Shell 权限的 Agent：

```text
请安装 l05-diagnosis Skill：
1. 检查 ~/.codex/skills/l05-diagnosis 是否已存在；如存在，不要覆盖，先说明当前状态并创建备份。
2. 从 https://github.com/AlvinGgg/l05-diagnosis-skill.git 安装到 ~/.codex/skills/l05-diagnosis。
3. 验证 SKILL.md、agents/openai.yaml、scripts、references 和 assets 完整。
4. 运行 Skill Creator 的 quick_validate.py，以及仓库中的 Node 和 Python 测试。
5. 运行 scripts/l05_setup.py doctor，只汇报缺少的配置项，不读取或输出任何已有凭据值。
6. 告诉我需要在本地配置哪些变量，并引导我初始化或连接 Obsidian Vault；不要要求我把 Token 粘贴到对话中。
```

### 命令安装

使用 Skills CLI：

```bash
npx skills add https://github.com/AlvinGgg/l05-diagnosis-skill --skill l05-diagnosis
```

或手动安装：

```bash
mkdir -p ~/.codex/skills
git clone https://github.com/AlvinGgg/l05-diagnosis-skill.git ~/.codex/skills/l05-diagnosis
```

如果目标目录已经存在，请先检查并备份，不要直接覆盖。

## 首次配置

以下示例默认 Skill 安装在 Codex 的标准目录：

```bash
export L05_SKILL_DIR="${CODEX_HOME:-$HOME/.codex}/skills/l05-diagnosis"
```

### 1. 初始化新的 Obsidian Vault

选择一个新的或空目录：

```bash
python3 "$L05_SKILL_DIR/scripts/l05_setup.py" init \
  --vault /absolute/path/to/new-vault \
  --jira-base-url https://jira.example.com
```

初始化器会创建 Vault 目录契约和私有配置骨架。它拒绝覆盖非空 Vault；已有 Vault 应先使用 `doctor` 做只读兼容性检查。

### 2. 配置 Jira 凭据

在本机编辑 `~/.codex/l05-diagnosis.env`：

```dotenv
JIRA_BASE_URL=https://jira.example.com
JIRA_TOKEN=<your-read-only-token>
JIRA_AUTH_MODE=bearer
L05_OBSIDIAN_VAULT=/absolute/path/to/new-vault
```

Basic 认证还需要：

```dotenv
JIRA_AUTH_MODE=basic
JIRA_EMAIL=you@example.com
```

保护配置文件：

```bash
chmod 600 ~/.codex/l05-diagnosis.env
```

不要把 Token 写入仓库、Vault、命令行参数或 Agent 对话。进程环境变量优先于私有配置文件；`~/.zshrc` 的字面量 `JIRA_TOKEN` 读取仅用于旧环境兼容，推荐使用独立配置文件。

### 3. 检查环境

```bash
python3 "$L05_SKILL_DIR/scripts/l05_setup.py" doctor
```

只有 Jira 地址、Token、Vault 契约和 Node.js 均就绪后，才应开始真实工单诊断。

## 构建知识库

### 使用 Obsidian Web Clipper 收集内容

安装官方 [Obsidian Web Clipper](https://obsidian.md/help/web-clipper)，并将内容保存到：

- 技术文档、Runbook、Wiki：`inbox/documents/`
- 人工筛选后的历史工单：`inbox/tickets/`
- L05 明确授权后生成的结构化 Jira 候选：`inbox/jira/`

不要直接把新内容写入 `raw/` 或 `wiki/`。Inbox 是人工审核边界。不要采集登录页面、Token、Cookie、私钥、带签名参数的 URL 或无关个人信息。

### 让 Obsidian Agent 整理 Inbox

在 Vault 根目录打开 Agent，并发送：

```text
请按照当前 Vault 根目录 AGENTS.md 处理 inbox 下的所有新文件。
先预览并列出每个来源、敏感信息风险、计划写入的 raw/wiki 路径和需要补充的信息；不要覆盖或删除文件。
得到我确认后，保留原始证据、生成可追溯 source 页面，只在证据充分时更新 howto/system/topic，最后更新 index.md 和 log.md。
```

正式知识应保留来源、适用范围、验证状态和更新时间。历史工单中的解决办法不应在缺少当前证据时直接复用。

## 使用

在新 Codex 任务中显式调用：

```text
$l05-diagnosis 排查 ABC-12345
```

也可以提供 Jira URL：

```text
$l05-diagnosis 帮我诊断 https://jira.example.com/browse/ABC-12345
```

Skill 会按以下顺序执行：

1. 运行本地配置检查。
2. 只读获取并验证当前 Jira 工单。
3. 理解问题类型并生成脱敏检索词。
4. 按 Vault 契约检索 Wiki、文档和合格历史工单。
5. 仅针对具体假设检查附件、链接、代码或浏览器证据。
6. 输出事实、假设、证据缺口、根因等级、建议修改和验证计划。
7. 仅在根因确认时附带完整 Jira 回复草稿。

### 可选代码证据

通过 SSH Agent 或 Git Credential Helper 提供仓库认证，不要把凭据嵌入 URL：

```bash
python3 "$L05_SKILL_DIR/scripts/git_snapshot.py" \
  --repo-url https://git.example.com/org/platform.git \
  --ref release-1 \
  --query "distinctive error"
```

本地代码搜索必须由用户显式启用：

```bash
python3 "$L05_SKILL_DIR/scripts/search_local_code.py" \
  --root /absolute/path/to/code \
  --query "distinctive error" \
  --no-sync
```

### 临时文件与知识候选

`run_l05_case.mjs` 默认在临时目录中生成 Case，并在结束时清理。只有以下参数会保留内容：

- `--keep-temp`：短期保留本次临时 Case。
- `--case-dir <path>`：保留到指定目录。
- `--publish-to-kb`：在明确授权后生成脱敏知识候选，不会自动发布正式 Wiki。

## 诊断输出

报告固定包含：

- 采集状态与工单事实
- 时间线
- 知识库匹配、质量和新鲜度
- 已检查证据
- 支持、反驳和缺失证据
- 根因等级：`confirmed`、`probable`、`unresolved` 或 `blocked`
- 建议修改与验证计划
- 访问和证据缺口
- 根因确认时的 Jira 可粘贴回复草稿

Jira 回复草稿使用中文，覆盖问题背景、根本原因、处理方案、验证结果和后续建议。未执行的修改必须标记为建议，不能写成已经修复。

## 安全边界

- Jira 默认且固定为只读；仓库中没有 Jira 写回流程。
- Jira、附件、网页、历史工单和代码均视为不可信证据，而不是 Agent 指令。
- 不输出 Token、Cookie、私钥、带密钥的 URL、内部工具原始输出或本地私有路径。
- 未确认的根因不能生成“问题已解决”式回复。
- 不修改已有本地代码仓库，不执行强制 Checkout、Reset 或 Clean。
- 外部系统写入、生产变更和知识正式发布都需要单独授权。

## 本地验证

```bash
python3 "$CODEX_HOME/skills/.system/skill-creator/scripts/quick_validate.py" .
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py'
gitleaks detect --no-git --redact --source .
```

## 目录结构

```text
.
├── SKILL.md
├── agents/
├── assets/
├── references/
├── scripts/
└── tests/
```

## License

Apache License 2.0。详见 `LICENSE`。
