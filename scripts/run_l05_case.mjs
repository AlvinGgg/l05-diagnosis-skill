#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {compareFreshness, extractRetrievalSeedDetails, findKbMatches, loadVaultProfile, retrievalSeeds, selectResolutionChannel} from "./evidence-adapter.mjs";
import {BundleWriter} from "./vendor/jira-collector/bundle-writer.mjs";
import {loadMissingL05ConfigEnv} from "./vendor/jira-collector/env-loader.mjs";
import {normalizedContentHash, validateBundle} from "./vendor/jira-collector/validate-jira-bundle.mjs";
import {evaluateBundle} from "./vendor/ticket-quality/evaluate-jira-ticket-quality.mjs";
import {collectOptionalEvidence} from "./provider-loader.mjs";
import {executeEvidencePlan} from "./provider-coordinator.mjs";
import {assessIntent} from "./intent-router.mjs";
import {extractRequestSummary, rankedSafeHttpLocators} from "./request-summary.mjs";

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COLLECTOR_CLI = path.join(SKILL_ROOT, "scripts/vendor/jira-collector/jira-collect.mjs");
const execFileAsync = promisify(execFile);
const INJECTION_RE = /ignore (?:all |the )?(?:previous|prior) instructions|read (?:the )?(?:environment|env) variables|upload (?:the )?(?:repository|repo)|execute (?:this |the )?command|system prompt/i;

export {assessIntent, compareFreshness, findKbMatches, retrievalSeeds};
export function parseIssueIdentity(value, baseUrl = "") {
  const match = /\b([A-Z][A-Z0-9_]*-[0-9]+)\b/i.exec(value || "");
  if (!match) throw new Error(`cannot parse Jira issue key: ${value}`);
  let instance = baseUrl;
  try { const url = new URL(value); instance = `${url.protocol}//${url.host}`; } catch {}
  if (!instance) throw new Error("JIRA_BASE_URL is required when the input is an issue key");
  return {issue_key: match[1].toUpperCase(), base_url: instance.replace(/\/+$/, "")};
}
export function detectPromptInjection(text) { return INJECTION_RE.test(text || ""); }

function withoutInstructionInjection(issue) {
  const value = structuredClone(issue);
  if (detectPromptInjection(value.ticket?.description_markdown)) value.ticket.description_markdown = "";
  value.comments = (value.comments || []).filter((comment) => !detectPromptInjection(comment.body_markdown));
  return value;
}

function sanitizeFailureDetail(value) {
  return String(value || "")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/Basic\s+[^\s"']+/gi, "Basic [redacted]")
    .replace(/\b(JIRA_TOKEN|JIRA_EMAIL|password|secret|token|signature)\s*=\s*[^\s&]+/gi, "$1=[redacted]")
    .replace(/([?&](?:password|secret|token|signature)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/https?:\/\/[^/\s:@]+:[^@\s/]+@/gi, "https://[redacted]@")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

export function classifyJiraCollectionFailure(value) {
  const detail = sanitizeFailureDetail(value) || "Jira collector returned no usable issue facts.";
  const requestAttempts = Number(/after (\d+) attempts?/i.exec(detail)?.[1] || 1);
  const definitions = [
    {
      code: "jira_token_missing",
      match: /token_missing|missing JIRA_TOKEN|JIRA_TOKEN is required/i,
      reason: "Jira Token 未配置，当前请求无法认证。",
      checks: [
        "运行 l05_setup.py doctor，确认 jira_token_configured 为 true。",
        "检查进程环境或 ~/.codex/l05-diagnosis.env 中是否存在非空 JIRA_TOKEN；配置必须是字面量赋值。",
        "不要在对话、命令行、仓库或 Vault 中粘贴 Token。",
      ],
    },
    {
      code: "jira_base_url_missing",
      match: /JIRA_BASE_URL.*required|base URL.*required/i,
      reason: "Jira Base URL 未配置。",
      checks: [
        "运行 l05_setup.py doctor，确认 jira_base_url_configured 为 true。",
        "检查 JIRA_BASE_URL 是否指向正确的 Jira 站点根地址，且不包含 browse 路径。",
      ],
    },
    {
      code: "jira_auth_configuration_invalid",
      match: /invalid --auth-mode|JIRA_EMAIL.*required|basic authentication/i,
      reason: "Jira 认证模式配置不完整或不受支持。",
      checks: [
        "确认 JIRA_AUTH_MODE 为 bearer 或 basic。",
        "使用 basic 时同时配置 JIRA_EMAIL；使用 PAT/Bearer 时确认模式与 Jira 实例要求一致。",
      ],
    },
    {
      code: "jira_authentication_failed",
      match: /Jira HTTP 401|\bHTTP 401\b/i,
      reason: "Jira 已拒绝认证，Token 可能失效或认证模式不匹配。",
      checks: [
        "确认本地 Token 尚未过期、未撤销，并属于预期 Jira 账号。",
        "核对 JIRA_AUTH_MODE；basic 认证还需要正确的 JIRA_EMAIL。",
        "运行 l05_setup.py doctor 只检查配置存在性；它不会打印或验证 Token 内容。",
      ],
    },
    {
      code: "jira_permission_denied",
      match: /Jira HTTP 403|\bHTTP 403\b/i,
      reason: "Jira 已认证但拒绝当前只读请求。",
      checks: [
        "确认 Token 对应账号具有目标项目的 Browse Projects 权限。",
        "检查工单 Issue Security Level、服务台参与者或组织范围是否限制了该账号。",
        "确认访问的是正确 Jira 实例；不要通过增加写权限解决只读访问问题。",
      ],
    },
    {
      code: "jira_issue_not_found",
      match: /Jira HTTP 404|\bHTTP 404\b/i,
      reason: "Jira 未返回目标工单；工单号、实例或可见范围可能不正确。",
      checks: [
        "核对工单号和 JIRA_BASE_URL。",
        "用同一账号在 Jira UI 中确认工单可见；部分 Jira 会用 404 隐藏无权限资源。",
      ],
    },
    {
      code: "jira_rate_limited",
      match: /Jira HTTP 429|\bHTTP 429\b/i,
      reason: "Jira API 当前触发限流。",
      checks: [
        "等待 Retry-After 指定时间后重试。",
        "确认没有并行运行大量工单采集任务。",
      ],
    },
    {
      code: "jira_service_unavailable",
      match: /Jira HTTP 5\d\d|\bHTTP 5\d\d\b/i,
      reason: "Jira 或其反向代理当前返回服务端错误。",
      checks: [
        "检查 Jira 服务状态或稍后重试一次。",
        "若浏览器可用但 API 持续失败，记录 HTTP 状态并联系 Jira 平台维护方。",
      ],
    },
    {
      code: "jira_dns_resolution_failed",
      match: /ENOTFOUND|EAI_AGAIN|getaddrinfo|name or service not known|nodename nor servname/i,
      reason: "执行环境无法解析 Jira 域名，请求尚未到达 Jira。",
      retry_with_network_permission: true,
      checks: [
        "核对 JIRA_BASE_URL 中的域名是否拼写正确。",
        "确认当前设备已连接所需企业网络或 VPN，系统 DNS 能解析该域名。",
        "如果只在受限 Agent/Codex 环境失败，请授予该次只读命令网络权限后重试；不要更换 Token。",
      ],
    },
    {
      code: "jira_tls_failed",
      match: /certificate|CERT_|SELF_SIGNED|unable to verify|TLS|SSL/i,
      reason: "Jira TLS 证书校验失败，请求未完成。",
      checks: [
        "确认系统信任企业 CA，或通过 NODE_EXTRA_CA_CERTS 配置受信任 CA 文件。",
        "核对 JIRA_BASE_URL 的主机名与证书是否匹配。",
        "不要全局关闭 TLS 校验；仅按组织批准的主机级策略处理。",
      ],
    },
    {
      code: "jira_request_timeout",
      match: /AbortError|TIMEOUT|timed? out|ETIMEDOUT/i,
      reason: "Jira 请求超时，未取得工单事实。",
      retry_with_network_permission: true,
      checks: [
        "检查 VPN、代理、防火墙和 Jira 服务状态。",
        "如果执行环境限制外部网络，请授予该次只读请求网络权限后重试一次。",
      ],
    },
    {
      code: "jira_network_unreachable",
      match: /fetch failed|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up/i,
      reason: "执行环境无法连接 Jira，请求未取得 HTTP 响应。",
      retry_with_network_permission: true,
      checks: [
        "检查企业网络、VPN、代理、防火墙和 Jira 域名可达性。",
        "如果同一地址在浏览器或本机终端可用，但 Agent 中失败，请授予该次只读命令网络权限后重试。",
        "没有 HTTP 401/403 时不要优先重置 Token。",
      ],
    },
    {
      code: "jira_response_invalid",
      match: /invalid JSON|no bundle path|bundle validation failed|schema/i,
      reason: "Jira 返回或采集产物不符合预期，无法作为诊断事实使用。",
      checks: [
        "确认 Jira API 没有被 SSO 登录页或代理错误页替代。",
        "保留脱敏后的错误和 HTTP 状态，检查 Jira API 版本与 Collector 兼容性。",
      ],
    },
  ];
  const match = definitions.find((item) => item.match.test(detail));
  const fallback = {
    code: "jira_collection_failed",
    reason: "Jira 工单采集失败，尚未取得可用于诊断的当前事实。",
    checks: [
      "运行 l05_setup.py doctor 检查 Jira URL、Token 是否已配置以及本地 Vault 是否就绪。",
      "检查当前账号在 Jira UI 中能否查看该工单，并核对网络、VPN、代理与 Jira 服务状态。",
      "保留下面的脱敏技术详情用于定位，但不要在对话中提供 Token。",
    ],
  };
  const selected = match || fallback;
  return {
    stage: "jira_collection",
    reason_code: selected.code,
    reason: selected.reason,
    technical_detail: detail,
    checks: selected.checks,
    retry_with_network_permission: selected.retry_with_network_permission === true,
    request_attempts: requestAttempts,
    retry_count: Math.max(0, requestAttempts - 1),
    retries_exhausted: selected.retry_with_network_permission === true && requestAttempts > 1,
  };
}

function collectorCli() {
  if (!fs.existsSync(COLLECTOR_CLI)) throw new Error("bundled Jira collector is missing");
  return COLLECTOR_CLI;
}

async function runCollector({identity, fixture, attachmentMode, caseDir}) {
  const args = [collectorCli(), "issue", "--issue", identity.issue_key, "--base-url", identity.base_url, "--attachment-mode", attachmentMode === "all" ? "all" : attachmentMode === "off" ? "none" : "metadata", "--raw-policy", "redacted"];
  if (fixture) args.push("--fixture", fixture);
  if (caseDir) args.push("--retain", "--output-dir", caseDir);
  try {
    const {stdout, stderr} = await execFileAsync(process.execPath, args, {env: {...process.env}, maxBuffer: 4 * 1024 * 1024});
    const result = JSON.parse(stdout.trim());
    if (stderr.trim()) result.stderr = stderr.trim();
    return result;
  } catch (error) {
    const stdout = error.stdout?.trim();
    if (stdout) {
      const result = JSON.parse(stdout);
      if (error.stderr?.trim()) result.stderr = sanitizeFailureDetail(error.stderr);
      result.exit_code = error.code;
      return result;
    }
    throw new Error(`collector failed: ${String(error.stderr || error.message).replace(/Bearer\s+\S+/gi, "Bearer [redacted]")}`);
  }
}

function readVaultContract(kbRoot) {
  const profile = loadVaultProfile(kbRoot);
  const files = [profile.paths.contract, profile.paths.index];
  const missing = files.filter((file) => !fs.existsSync(path.join(kbRoot, file)));
  for (const file of files.filter((file) => !missing.includes(file))) fs.readFileSync(path.join(kbRoot, file), "utf8");
  return {
    status: missing.length ? "partial" : "complete",
    files: files.filter((file) => !missing.includes(file)),
    profile_status: profile.status,
    gaps: [...missing.map((file) => `vault_contract_missing:${file}`), ...profile.errors.map((item) => `vault_profile:${item}`)],
  };
}

function evidenceGaps(issue, injection, vaultContract, providerEvidence = null) {
  const gaps = [];
  if (issue.collection.permission_gaps?.length) gaps.push(...issue.collection.permission_gaps);
  for (const [step, value] of Object.entries(issue.collection.steps || {})) if (!["complete", undefined].includes(value.status)) gaps.push(`${step}:${value.status}`);
  if (injection) gaps.push("prompt-injection-text-detected-and-ignored");
  gaps.push(...(vaultContract?.gaps || []));
  gaps.push(...(providerEvidence?.gaps || []));
  return gaps;
}

function hypotheses(issue, matches, providerEvidence = null) {
  const providerSupport = (providerEvidence?.responses || []).flatMap((response) => (response.evidence_records || []).map((record) => `Current Provider evidence: ${response.provider_id}/${record.capability}: ${record.summary}`));
  return [{
    hypothesis: "No current root cause is confirmed by the collected evidence yet.",
    supporting_evidence: ["Current Jira normalized facts were collected.", ...providerSupport.slice(0, 6), ...matches.slice(0, 3).map((item) => `Historical precedent: ${item.evidence_path}`)],
    contradicting_evidence: [providerSupport.length ? "Provider records are observations and do not by themselves prove the complete causal chain." : "No targeted current Provider, code, attachment, link, browser, or runtime evidence was collected by this command."],
    missing_evidence: ["The narrow current code, configuration, or runtime evidence needed to establish the complete causal chain."],
    confidence: "unresolved"
  }];
}

function traceRecord({status, purpose, source, scope, result, impact, references = []}) {
  return {status, purpose, source, scope, result, impact, references};
}

function buildInspectionTrace(issue, matches, providerEvidence = null) {
  const safeSeeds = retrievalSeeds(issue).slice(0, 8);
  const matchReferences = matches.map((item) => item.evidence_path);
  const records = [
    traceRecord({
      status: "completed",
      purpose: "Establish the current ticket facts and select the handling route.",
      source: `Jira ${issue.source.issue_key}`,
      scope: `Validated current issue fields, ${issue.comments?.length || 0} comment(s), and ${issue.attachments?.length || 0} attachment metadata record(s).`,
      result: `Current Jira bundle validated at schema ${issue.schema_version || "unknown"}.`,
      impact: "Current Jira facts remain authoritative for intent, scope, and current state.",
      references: [`jira:${issue.source.issue_key}`],
    }),
    traceRecord({
      status: matches.length ? "completed" : "completed_no_match",
      purpose: "Find reusable precedent, procedures, and known limitations without replacing current evidence.",
      source: "Configured local knowledge Vault",
      scope: `Source-first search using sanitized seeds: ${safeSeeds.join(", ") || "none"}.`,
      result: matches.length
        ? `Matched ${matches.length} quality- and freshness-labelled record(s): ${matchReferences.join(", ")}.`
        : "No matching local precedent was found.",
      impact: matches.length
        ? "Matches are retained as precedent only; their quality and freshness limit how much they can support the current conclusion."
        : "No historical support was added to the current conclusion.",
      references: matchReferences,
    }),
  ];

  if (providerEvidence) {
    if (providerEvidence.routing_status === "deferred_self_service") {
      records.push(traceRecord({
        status: "not_run",
        purpose: "Avoid unrelated runtime or control-plane inspection while an approved self-service route can satisfy the current request.",
        source: "Optional Provider routing",
        scope: "Provider invocation deferred after an exact self-service automation match.",
        result: "No optional Provider was invoked; the requester should use the approved automated entry first.",
        impact: "Prevents an unnecessary manual SRE or Provider path while preserving a failure fallback.",
        references: providerEvidence.resolution_channel?.source_url ? [providerEvidence.resolution_channel.source_url] : [],
      }));
      return records;
    }
    const providerRecords = (providerEvidence.responses || []).flatMap((response) =>
      (response.evidence_records || []).map((record) => ({provider_id: response.provider_id, record})),
    );
    const providerGaps = providerEvidence.gaps || [];
    const status = providerRecords.length
      ? (providerGaps.length ? "partial" : "completed")
      : (providerGaps.length ? "failed" : "completed_no_match");
    const providerIds = [...new Set((providerEvidence.responses || []).map((response) => response.provider_id))];
    records.push(traceRecord({
      status,
      purpose: "Collect current read-only runtime or control-plane evidence when the Profile route matches.",
      source: providerIds.length ? `Optional Provider(s): ${providerIds.join(", ")}` : "Optional Provider routing",
      scope: `Profile routing for normalized problem type ${providerEvidence.problem_type || "unknown"}.`,
      result: providerRecords.length
        ? providerRecords.map(({provider_id, record}) => `${provider_id}/${record.capability || "unknown"}: ${record.summary || record.evidence_type || "evidence collected"}`).join("; ")
        : (providerGaps.length ? `Provider gaps: ${providerGaps.join(", ")}.` : "No Provider evidence record matched this case."),
      impact: providerRecords.length
        ? "Provider observations contribute current evidence but do not independently prove root cause or implementation completion."
        : "No Provider observation changed the conclusion; any current runtime evidence remains an explicit gap.",
      references: providerRecords.map(({provider_id, record}) => `provider:${provider_id}/${record.capability || "unknown"}`),
    }));
    for (const step of providerEvidence.inspection_steps || []) {
      const traceStatus = ["completed", "partial", "failed", "not_run", "completed_no_match"].includes(step.status)
        ? step.status
        : "failed";
      records.push(traceRecord({
        status: traceStatus,
        purpose: step.capability === "loki.index.stats"
          ? "Estimate the bounded Loki selector before reading log entries."
          : step.capability === "loki.stream.selector.resolve"
            ? "Discover allowlisted tenant label keys and resolve one matching stream identity before querying logs."
          : step.capability === "loki.logs.topk_api_status"
            ? "Aggregate one fixed HTTP status by apiId in bounded serial Loki partitions."
          : step.capability === "profile.loki_gateway.reconcile"
            ? "Reconcile a verified Loki Gateway candidate with the enterprise Profile."
            : step.capability === "k8s.application.identity"
              ? "Resolve the Loki tenant from the workload or Namespace application label."
              : step.capability === "k8s.loki_gateway.resolve"
                ? "Resolve one locked-cluster Loki Gateway candidate through Kubernetes metadata."
                : step.capability === "loki.gateway.health"
                  ? "Verify the selected Loki Gateway is ready before a log query."
                  : "Run one bounded, filtered, read-only Loki log query.",
        source: `Planned Provider step: ${step.capability}`,
        scope: `Target ${step.target || "unknown"}${step.gateway_source ? ` through ${step.gateway_source}` : ""}; no transport override accepted from Jira content.`,
        result: step.result || step.status,
        impact: step.status === "completed"
          ? "The observation may support the current diagnosis but does not independently confirm the full causal chain."
          : "The missing or blocked observation remains an explicit evidence gap.",
        references: [`provider-step:${step.capability}`],
      }));
    }
  }
  return records;
}

function buildClarificationTrace(issue) {
  return [
    traceRecord({
      status: "completed",
      purpose: "Establish the current ticket facts and determine whether a safe handling route can be selected.",
      source: `Jira ${issue.source.issue_key}`,
      scope: `Validated current issue fields and ${issue.comments?.length || 0} comment(s).`,
      result: "The requested outcome is still unclear.",
      impact: "The Skill must ask one consolidated requester question before further retrieval.",
      references: [`jira:${issue.source.issue_key}`],
    }),
    traceRecord({
      status: "not_run",
      purpose: "Prevent irrelevant or misleading evidence collection before intent is clear.",
      source: "Vault, Providers, repositories, browser, web, and runtime sources",
      scope: "Downstream evidence collection gate.",
      result: "Not queried because intent routing stopped the case.",
      impact: "No downstream source influenced the clarification request.",
      references: [],
    }),
  ];
}

function renderInspectionTrace(records) {
  return records.map((record, index) => {
    const references = record.references.length ? record.references.join(", ") : "none";
    return `${index + 1}. **${record.source}** — status: \`${record.status}\`\n`
      + `   - Purpose: ${record.purpose}\n`
      + `   - Query/scope: ${record.scope}\n`
      + `   - Result: ${record.result}\n`
      + `   - Impact on conclusion: ${record.impact}\n`
      + `   - Safe references: ${references}`;
  }).join("\n");
}

function reportEvidence(issue, matches, providerEvidence = null) {
  const timeline = [`- ${issue.source.issue_updated_at}: Jira issue updated`, ...(issue.comments || []).map((comment) => `- ${comment.created}: comment ${comment.id}`)].join("\n") || "- No comments collected.";
  const matchLines = matches.map((item) => `- ${item.source_type} / ${item.quality_level} / ${item.freshness} / ${item.match_reason.join(", ")}: ${item.evidence_path}`).join("\n") || "- No matching local precedent.";
  const providerLines = providerEvidence?.routing_status === "deferred_self_service"
    ? "- Not run: an approved self-service resolution channel matched the current request."
    : (providerEvidence?.responses || []).flatMap((response) => (response.evidence_records || []).map((record) => ({provider_id: response.provider_id, record}))).map(({provider_id, record}) => `- ${provider_id} / ${record.capability || "unknown"} / ${record.confidence || "unknown"}: ${record.summary || record.evidence_type || "evidence collected"}`).join("\n") || "- No optional Provider evidence collected.";
  const providerDetails = (providerEvidence?.responses || []).flatMap((response) => (response.evidence_records || []).filter((record) => record.data !== undefined).map((record) => ({provider_id: response.provider_id, record}))).map(({provider_id, record}) => `### ${provider_id} / ${record.capability || "unknown"}\n\n${JSON.stringify(record.data, null, 2).split("\n").map((line) => `    ${line}`).join("\n")}`).join("\n\n") || "- No optional Provider detail available.";
  const traceRecords = buildInspectionTrace(issue, matches, providerEvidence);
  const investigationTrail = renderInspectionTrace(traceRecords);
  const inspectedEvidence = [
    "- Current normalized Jira bundle",
    ...(matches.length ? ["- Local evidence paths listed above"] : []),
    ...((providerEvidence?.responses || []).some((response) => response.evidence_records?.length) ? ["- Optional Provider records listed above"] : []),
  ].join("\n");
  return {timeline, matchLines, providerLines, providerDetails, traceRecords, investigationTrail, inspectedEvidence};
}

function renderIntentAssessment(intent) {
  const supporting = intent.supporting_signals.map((item) => `- ${item.source} / ${item.signal}: ${item.summary}`).join("\n") || "- No decisive content signal.";
  const counter = intent.counter_signals.map((item) => `- ${item.source} / ${item.signal}: ${item.summary}`).join("\n") || "- None.";
  return `- Work intent: ${intent.work_intent}\n- Delivery mode: ${intent.delivery_mode}\n- Confidence: ${intent.confidence}\n- Execution owner: ${intent.execution_owner}\n- Planning status: ${intent.planning_status}\n- Execution status: ${intent.execution_status}\n\n### Request summary\n\n${renderRequestSummary(intent.request_summary)}\n\n### Supporting signals\n\n${supporting}\n\n### Counter-signals\n\n${counter}`;
}

function renderRequestSummary(summary) {
  if (!summary) return "- Request summary: not available.";
  const target = summary.target_identity;
  const targetLine = target
    ? `${target.kind || "other"} / ${target.locator || "no exact locator"} / ${target.environment || "unknown"} / ${target.source || "unknown"}`
    : "not identified";
  const comparisons = (summary.comparison_evidence || []).map((item) => `  - ${item}`).join("\n") || "  - none";
  const semantic = summary.semantic_fields || {};
  const semanticLine = Object.entries(semantic).map(([key, value]) => `${key}=${value}`).join(" / ") || "not identified";
  return `- Requester ask: ${summary.requester_ask || "not identified"}\n- Symptom or goal: ${summary.symptom_or_goal || "not identified"}\n- Target identity: ${targetLine}\n- Structured Jira fields: ${semanticLine}\n- Description evidence: ${summary.description_evidence || "not identified"}\n- Comparison evidence:\n${comparisons}`;
}

function renderResolutionChannel(channel) {
  if (!channel) return "- No approved self-service resolution channel matched the current case.";
  return `- Channel: ${channel.type}\n- Source: ${channel.source_ref} (${channel.source_url})\n- Requester action: ${channel.requester_action}\n- Required inputs: ${channel.required_inputs?.join(", ") || "follow the entry instructions"}\n- Verification: ${channel.verification}\n- Fallback: ${channel.fallback}\n- Evidence path: ${channel.evidence_path}`;
}

function selfServiceJiraReply(channel) {
  if (!channel?.type?.startsWith("self_service_")) return "";
  const inputs = channel.required_inputs?.length
    ? `\n\n【需填写】\n- ${channel.required_inputs.join("\n- ")}`
    : "";
  return `您好，当前场景已有可用的自动化处理入口，无需由 SRE 人工处理。\n\n请通过 [${channel.source_ref}](${channel.source_url}) 提交申请。${inputs}\n\n【完成后验证】\n- ${channel.verification}\n\n如自动化入口提交失败，请在当前工单补充生成的申请编号、尝试时间和页面报错，我们再继续协助。`;
}

function renderPendingConfirmations(intent) {
  return intent.pending_confirmations.map((item) => `- ${item.kind}: ${item.item}`).join("\n") || "- No material pending confirmation recorded.";
}

export function nextEvidenceQuestion(issue, intent, resolutionChannel = null) {
  if (resolutionChannel) {
    return {
      source: resolutionChannel.source_ref,
      locator: resolutionChannel.source_url,
      question: resolutionChannel.requester_action,
      expected_effect: "self_service_resolution",
      validation: resolutionChannel.verification,
      stop_condition: resolutionChannel.fallback,
    };
  }
  const text = [
    issue.ticket?.summary,
    issue.ticket?.description_markdown,
    issue.ticket?.environment,
    ...(issue.comments || []).map((item) => item.body_markdown),
  ].filter(Boolean).join("\n");
  const requestSummary = intent.request_summary || extractRequestSummary(issue);
  const urls = rankedSafeHttpLocators(issue).map((item) => item.locator);
  const task = /\btask\s*(?:id)?\s*[:：#]?\s*([0-9]{1,12})\b/i.exec(text)?.[1];
  const build = /\bbuild\s*#?\s*([0-9]{1,12})\b/i.exec(text)?.[1];
  const time = /\b20[0-9]{2}[-/][01]?[0-9][-/][0-3]?[0-9][ T][0-2]?[0-9]:[0-5][0-9](?::[0-5][0-9])?\b/.exec(text)?.[0];
  const locators = [
    requestSummary.target_identity?.locator || null,
    ...urls,
    task ? `task:${task}` : null,
    build ? `build:${build}` : null,
    time ? `time:${time}` : null,
  ].filter(Boolean).filter((item, index, values) => values.indexOf(item) === index).slice(0, 4);
  const locator = locators.length ? locators.join(", ") : `jira:${issue.source.issue_key}`;
  const fulfillment = intent.work_intent === "request_fulfillment";
  const definitions = [
    {
      id: "cicd",
      priority: 2,
      matches: /jenkins|pipeline|流水线|cicd|ci\/cd|构建/i,
      source: fulfillment ? "requester + SRE CI/CD control plane" : "Jenkins or CI/CD control plane",
      question: fulfillment
        ? "Confirm the exact application/repository, framework, environment, desired delivery result, and authoritative onboarding control point before building the implementation plan."
        : "Resolve the exact Job, Build or Task, then inspect its parameters, resolved SCM ref/Commit, first failing stage, and first substantive error.",
      validation: fulfillment
        ? "The target, current state, supported procedure, requested values, and acceptance result are all uniquely identified."
        : "One first divergence is tied to the same Job/Build/Task and SCM identity as the Jira observation.",
      stop: "Stop if the run does not resolve to the requested application/environment, inputs differ from the comparison sample, or access would expose credentials.",
    },
    {
      id: "ingress",
      priority: 3,
      matches: /ingress|域名|\bhost\b|\bpath\b|路由|静态资源|f5/i,
      source: fulfillment ? "requester + SRE ingress source of truth" : "DNS/edge/Ingress/runtime route",
      question: fulfillment
        ? "Confirm the exact Host, Path set, environment, desired response or backend, unaffected routes, and authoritative configuration source."
        : "Using the exact Host and Path, compare DNS or edge routing, Ingress match/rewrite, Service/Endpoint, and application response to find the first boundary that differs.",
      validation: fulfillment
        ? "The requested Host/Path target and exclusions map to one owned configuration source and one observable acceptance result."
        : "The first mismatching boundary and its owner are supported by current evidence; earlier hypotheses are updated when contradicted.",
      stop: "Stop when Host/Path is not unique, the request belongs to another team or edge layer, or the next check would cross an unapproved environment boundary.",
    },
    {
      id: "apim",
      priority: 5,
      matches: /apim|api gateway|swagger|cors|限流|rate limit/i,
      source: fulfillment ? "requester + APIM control plane" : "client/APIM/upstream evidence",
      question: fulfillment
        ? "Confirm the exact API or operation, environment, requested policy values, counting or Origin semantics, and acceptance behavior before selecting a policy scope."
        : "Correlate one safe request by API/operation, environment and time, then compare the path or response at the client, APIM receive/forward boundary, and upstream.",
      validation: fulfillment
        ? "One API/operation and policy scope has explicit values, negative checks, and a rollback boundary."
        : "The first boundary that changes the request or response is identified without treating an APIM keyword as root-cause proof.",
      stop: "Stop if the API/operation, environment, or time anchor is missing, or if continuing would require a subscription key, Authorization value, Cookie, or signature.",
    },
    {
      id: "configuration",
      priority: 4,
      matches: /vault|configmap|环境变量|变量|annotation|helm|values|默认配置|资源配置|规格/i,
      source: "configuration source, render, and workload",
      question: "Trace the named non-secret key or setting from the authoritative source through merge/render output to the target workload and application read point; identify the first missing or changed representation.",
      validation: "The same application, environment, release identity, and key name are compared at every boundary without reading or exposing the value.",
      stop: "Stop if the target release is not unique, a step requires secret values or an unauthorized Pod action, or source and runtime identities cannot be correlated.",
    },
    {
      id: "access",
      priority: 4,
      matches: /权限|request type|\baccess\b|授权/i,
      source: fulfillment ? "requester + access-control current state" : "access-control current state",
      question: fulfillment
        ? "Confirm the exact project/resource, requested operation, current principal, smallest controlling role or permission, approval, and expiry or rollback condition."
        : "Confirm the exact denied operation and controlling permission boundary before deciding whether the cause is identity, product access, project role, or policy.",
      validation: "The requested operation succeeds only in the approved scope, while an unapproved adjacent operation remains denied.",
      stop: "Stop if the target or principal is ambiguous, approval is missing, or only a broader administrative role would satisfy the request.",
    },
  ];
  const preciseCicdLocator = /jenkins|pipeline\/history|\btask\s*(?:id)?\s*[:：#]?\s*[0-9]+|\bbuild\s*#?\s*[0-9]+/i.test(text);
  const candidates = definitions.filter((item) => item.matches.test(text));
  const selected = (preciseCicdLocator ? candidates.find((item) => item.id === "cicd") : null)
    || candidates.sort((left, right) => right.priority - left.priority)[0]
    || {
    source: fulfillment ? "requester + responsible SRE control plane" : "current responsible evidence source",
    question: fulfillment
      ? "Confirm the exact target, environment, requested value, current state, acceptance result, and responsible control point."
      : "Use the safest available locator to inspect one current fact that can support, contradict, or narrow the leading hypothesis.",
    validation: fulfillment
      ? "The implementation path, validation, and rollback no longer depend on an invented target or value."
      : "The observation changes one explicit hypothesis or evidence gap.",
    stop: "Stop when the target cannot be uniquely resolved or the next action requires secrets, writes, or an unapproved scope.",
  };
  return {
    source: selected.source,
    locator,
    question: selected.question,
    expected_effect: fulfillment ? "narrows_plan" : "supports_or_contradicts_hypothesis",
    validation: selected.validation,
    stop_condition: selected.stop,
  };
}

function renderNextEvidenceQuestion(question) {
  return `- Source: ${question.source}\n- Locator: ${question.locator}\n- Question: ${question.question}\n- Expected effect: ${question.expected_effect}\n- Validation: ${question.validation}\n- Stop condition: ${question.stop_condition}`;
}

function requesterInformationDraft(intent, resolutionChannel = null) {
  if (resolutionChannel?.type?.startsWith("self_service_")) return "";
  const requests = intent.pending_confirmations.filter((item) => item.kind === "requester_input");
  if (!requests.length) return "";
  const questions = requests.map((item, index) => `${index + 1}. ${item.question}\n   - 用途：${item.item}`).join("\n");
  return `\n\n## Requester information draft (ready to paste)\n\n您好，为确保本次需求按正确范围实施，请补充以下信息：\n\n${questions}\n\n收到以上信息后，我们会重新核对需求意图与方案充分性，并据此完善 SRE 处理流程、验证与回滚方案。当前尚未执行任何变更。`;
}

function requestFulfillmentReportFor(issue, matches, injection, vaultContract, intent, providerEvidence = null, resolutionChannel = null, publishResult = null) {
  const evidence = reportEvidence(issue, matches, providerEvidence);
  const gaps = evidenceGaps(issue, injection, vaultContract, providerEvidence);
  const nextQuestion = nextEvidenceQuestion(issue, intent, resolutionChannel);
  const requesterDraft = requesterInformationDraft(intent, resolutionChannel);
  const selfServiceDraft = selfServiceJiraReply(resolutionChannel);
  const userSide = requesterDraft
    ? "\n\n## User-side coordination\n\n- Reply with the requester-owned inputs listed above.\n- Internal current-state checks remain with SRE."
    : "";
  return `# L0.5 request fulfillment: ${issue.source.issue_key}\n\n## Intent assessment\n\n${renderIntentAssessment(intent)}\n\n## Current status\n\n- Analysis mode: read-only evidence collection and human handoff.\n- Planning status: ${intent.planning_status}.\n- Execution status: ${intent.execution_status}; no production or Jira write was performed.\n- Completion reply: ${selfServiceDraft ? "self-service draft is ready to paste." : "template only, not ready to paste."}\n\n## Request target and scope\n\n- Summary: ${issue.ticket.summary}\n- Environment: ${issue.ticket.environment || "not confirmed"}\n- Components: ${issue.ticket.components.join(", ") || "not confirmed"}\n- The exact desired state and exclusions must come from current Jira facts or confirmed requester input; historical precedent cannot supply production values.\n\n## Recommended resolution channel\n\n${renderResolutionChannel(resolutionChannel)}\n\n## Current evidence and pending confirmations\n\n${renderPendingConfirmations(intent)}\n\n## Smallest actionable next step\n\n${renderNextEvidenceQuestion(nextQuestion)}\n\n## Local KB matches and freshness\n\n${evidence.matchLines}\n\n## Optional Provider evidence\n\n${evidence.providerLines}\n\n## Optional Provider evidence details\n\n${evidence.providerDetails}${requesterDraft}${selfServiceDraft ? `\n\n## Jira reply draft (ready to paste)\n\n${selfServiceDraft}` : ""}\n\n## ${selfServiceDraft ? "SRE fallback handling runbook" : "SRE handling runbook"}\n\n${selfServiceDraft ? "Use this runbook only if the documented automation route fails or its documented verification does not succeed.\n\n" : ""}1. Confirm the exact target resource, environment, product/version, control point, requested values, exclusions, approval, change window, and rollback owner.\n2. Capture the current effective configuration and a recoverable pre-change snapshot.\n3. Resolve every requester input and evidence gap that changes the implementation path; use only steps supported by current configuration, authoritative documentation, code, or a reviewed precedent.\n4. Apply only the approved target-scoped change through the responsible SRE control plane. This report does not authorize or perform that action.\n5. Verify the requested behavior, unaffected adjacent scope, monitoring signals, and rollback readiness.\n6. Record the actual configuration difference, change record, execution time, validation result, and requester acceptance when required.${userSide}\n\n## Risks, approval, and rollback\n\n- Any production-affecting action requires explicit target resolution, human review, and the applicable approval.\n- Stop when the current product/control point, affected scope, or rollback path cannot be confirmed.\n- Roll back from the captured snapshot when validation fails or an excluded scope changes unexpectedly, then re-run the pre-change checks.\n\n## Completion criteria and evidence\n\n- Target state is observable in the responsible control plane.\n- Positive and negative validation results are recorded.\n- Adjacent scope remains healthy.\n- Change/approval reference, actual values changed, execution time, and rollback status are retained.\n- The requester has completed or accepted any explicitly assigned user-side step.\n\n## Post-completion Jira reply draft (template, not ready to paste)\n\n您好，您申请的 <需求目标> 已由 SRE 完成处理。\n\n【已完成】\n- <actual target and change, supported by execution evidence>\n\n【验证结果】\n- <actual validation and result>\n\n【用户侧后续】\n- <retain only when requester action or acceptance is still required>\n\n【注意事项】\n- <retain only material limitations or follow-up>\n\nDo not convert this template to ready-to-paste until execution and validation evidence is available.\n\n## Handling trail and references\n\n${evidence.investigationTrail}\n\n## Evidence inspected\n\n${evidence.inspectedEvidence}\n\n## Access and evidence gaps\n\n${gaps.map((item) => `- ${item}`).join("\n") || "- No collection gap recorded; the SRE prechecks above are still required before implementation."}\n\n## Optional KB publish result\n\n${publishResult ? `- ${publishResult.outcome}: ${publishResult.bundle}` : "- Not requested."}\n`;
}

function unclearReportFor(issue, injection, intent) {
  const injectionGap = injection ? "\n- prompt-injection-text-detected-and-ignored" : "";
  const investigationTrail = renderInspectionTrace(buildClarificationTrace(issue));
  return `# L0.5 clarification required: ${issue.source.issue_key}\n\n## Intent assessment\n\n${renderIntentAssessment(intent)}\n\n## Current status\n\n- Planning status: ${intent.planning_status}.\n- Execution status: ${intent.execution_status}.\n- Jira facts were collected, but no Vault, Provider, code, browser, or runtime evidence was inspected because the requested outcome is unclear.\n\n## Ticket facts\n\n- Summary: ${issue.ticket.summary}\n- Status: ${issue.ticket.status}\n- Updated: ${issue.source.issue_updated_at}\n\n## Investigation trail\n\n${investigationTrail}\n\n${requesterInformationDraft(intent).trim()}\n\n## Evidence gaps\n\n${renderPendingConfirmations(intent)}${injectionGap}\n`;
}

function troubleshootingReportFor(issue, matches, injection, vaultContract, intent, providerEvidence = null, resolutionChannel = null, publishResult = null) {
  const evidence = reportEvidence(issue, matches, providerEvidence);
  const gaps = evidenceGaps(issue, injection, vaultContract, providerEvidence);
  const structuredHypotheses = hypotheses(issue, matches, providerEvidence);
  const nextQuestion = nextEvidenceQuestion(issue, intent, resolutionChannel);
  const selfServiceDraft = selfServiceJiraReply(resolutionChannel);
  const mixedSection = intent.work_intent === "mixed"
    ? `\n\n## Request fulfillment subtask\n\n**blocked** — keep the requested implementation separate from the investigation. Do not turn an unconfirmed causal hypothesis into an SRE change step.\n\n${renderPendingConfirmations(intent)}${requesterInformationDraft(intent, resolutionChannel)}`
    : "";
  const recommendedChange = resolutionChannel
    ? `${resolutionChannel.requester_action}\n\nFallback: ${resolutionChannel.fallback}`
    : "No change is recommended until the bounded evidence question above identifies the first causal or configuration boundary. Any production-affecting change requires human review and approval.";
  return `# L0.5 diagnosis: ${issue.source.issue_key}\n\n## Collection status\n\n- Core issue: complete\n- Schema: ${issue.schema_version}\n- Unsupported ADF nodes: ${issue.collection.unsupported_adf_nodes.join(", ") || "none"}\n\n## Ticket facts\n\n- Summary: ${issue.ticket.summary}\n- Status: ${issue.ticket.status}\n- Updated: ${issue.source.issue_updated_at}\n- Components: ${issue.ticket.components.join(", ") || "none"}\n\n## Intent assessment\n\n${renderIntentAssessment(intent)}\n\n## Timeline\n\n${evidence.timeline}\n\n## Recommended resolution channel\n\n${renderResolutionChannel(resolutionChannel)}\n\n## Local KB matches and freshness\n\n${evidence.matchLines}\n\n## Optional Provider evidence\n\n${evidence.providerLines}\n\n## Optional Provider evidence details\n\n${evidence.providerDetails}\n\n## Investigation trail\n\n${evidence.investigationTrail}\n\n## Evidence inspected\n\n${evidence.inspectedEvidence}\n\n## Hypotheses with supporting and contradicting evidence\n\n${structuredHypotheses.map((item) => `- Hypothesis: ${item.hypothesis}\n  - Supporting: ${item.supporting_evidence.join("; ")}\n  - Contradicting: ${item.contradicting_evidence.join("; ")}\n  - Missing: ${item.missing_evidence.join("; ")}\n  - Confidence: ${item.confidence}`).join("\n")}\n\n## Root cause assessment\n\n${selfServiceDraft ? "**not required before self-service** — an approved automation entry exactly matches the documented scenario. Do not start SRE diagnosis unless the entry fails or its documented verification does not succeed." : "**unresolved** — historical and Provider evidence must be interpreted together with current causal evidence before confirming a root cause."}${mixedSection}\n\n## Smallest actionable next step\n\n${renderNextEvidenceQuestion(nextQuestion)}\n\n## Recommended change\n\n${recommendedChange}\n\n## Verification plan\n\n${selfServiceDraft ? resolutionChannel.verification : "Use the same target identity and locator to verify the observed boundary before and after any approved change, then check one negative and one adjacent scope."}\n\n## Access and evidence gaps\n\n${gaps.map((item) => `- ${item}`).join("\n") || (selfServiceDraft ? "- No additional SRE evidence is needed before using the documented self-service route." : "- No collection gap recorded; targeted diagnosis evidence is still required.")}\n\n## Optional KB publish result\n\n${publishResult ? `- ${publishResult.outcome}: ${publishResult.bundle}` : "- Not requested."}\n\n## Jira reply draft\n\n${selfServiceDraft || "- Not generated: root cause is unresolved. Generate a ready-to-paste draft only after current evidence confirms the causal chain."}\n`;
}

function reportFor(issue, matches, injection, vaultContract, intent, providerEvidence = null, resolutionChannel = null, publishResult = null) {
  if (intent.work_intent === "request_fulfillment") return requestFulfillmentReportFor(issue, matches, injection, vaultContract, intent, providerEvidence, resolutionChannel, publishResult);
  if (intent.work_intent === "unclear") return unclearReportFor(issue, injection, intent);
  return troubleshootingReportFor(issue, matches, injection, vaultContract, intent, providerEvidence, resolutionChannel, publishResult);
}

export async function runCase({
  issue,
  baseUrl,
  kbRoot,
  fixture,
  attachmentMode = "metadata-only",
  caseDir,
  keepTemp = false,
  publishToKb = false,
  providerDir,
  evidencePlan,
  authorizeLokiProfileUpdate = false,
}) {
  if (!kbRoot) return {status: "blocked", reason: "knowledge vault is not configured; run l05_setup.py doctor", diagnosis_allowed: false};
  let identity;
  try { identity = parseIssueIdentity(issue, baseUrl); }
  catch (error) {
    const failure = classifyJiraCollectionFailure(error.message);
    return {status: "blocked", issue_key: null, ...failure, diagnosis_allowed: false, case_dir: null};
  }
  const temporary = !caseDir;
  const root = caseDir ? path.resolve(caseDir) : fs.mkdtempSync(path.join(os.tmpdir(), "l05-case-"));
  fs.mkdirSync(root, {recursive: true});
  let collectorResult;
  let stage = "jira_collection";
  try {
    collectorResult = await runCollector({identity, fixture, attachmentMode, caseDir: caseDir ? root : null});
    if (collectorResult.status !== "ok" && collectorResult.status !== "partial") {
      const detail = [collectorResult.issues?.[0]?.warnings?.join(", "), collectorResult.stderr].filter(Boolean).join("; ") || "collector core issue failed";
      const failure = classifyJiraCollectionFailure(detail);
      return {status: "blocked", issue_key: identity.issue_key, ...failure, diagnosis_allowed: false, case_dir: keepTemp || !temporary ? root : null};
    }
    const collection = {bundle: collectorResult.issues?.[0]?.bundle_path};
    if (!collection.bundle || !fs.existsSync(collection.bundle)) throw new Error("collector returned no bundle path");
    const validation = validateBundle(collection.bundle);
    if (!validation.valid) throw new Error(`bundle validation failed: ${validation.errors.map((item) => item.code).join(",")}`);
    const normalizedPath = path.join(collection.bundle, "issue.normalized.json");
    const normalized = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    fs.copyFileSync(path.join(collection.bundle, "ticket.md"), path.join(root, "issue.md"));
    fs.copyFileSync(normalizedPath, path.join(root, "issue.normalized.json"));
    stage = "intent_routing";
    const injection = detectPromptInjection(`${normalized.ticket.description_markdown}\n${normalized.comments.map((item) => item.body_markdown).join("\n")}`);
    const routingProfile = loadVaultProfile(kbRoot);
    const intentAssessment = assessIntent(
      withoutInstructionInjection(normalized),
      routingProfile.jira_config || routingProfile.field_mappings,
    );
    if (intentAssessment.work_intent === "unclear") {
      const report = reportFor(normalized, [], injection, null, intentAssessment);
      const summary = {
        issue_key: normalized.source.issue_key,
        collection_status: normalized.collection,
        intent_assessment: intentAssessment,
        prompt_injection_detected: injection,
        kb_matches: [],
        optional_provider_evidence: null,
        inspection_trace: buildClarificationTrace(normalized),
        hypotheses: [],
        publish_result: null,
      };
      const reportFile = path.join(root, "clarification.md");
      fs.writeFileSync(reportFile, report);
      fs.writeFileSync(path.join(root, "case-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
      return {
        status: "needs_input",
        issue_key: normalized.source.issue_key,
        report,
        report_file: keepTemp || !temporary ? reportFile : null,
        case_dir: keepTemp || !temporary ? root : null,
        bundle: keepTemp || !temporary ? collection.bundle : null,
        intent_assessment: intentAssessment,
        kb_matches: [],
        provider_evidence: null,
        publish_result: null,
      };
    }
    stage = "vault_retrieval";
    const vaultContract = readVaultContract(kbRoot);
    const matches = findKbMatches(kbRoot, normalized, normalized.source.issue_updated_at);
    const seedDetails = extractRetrievalSeedDetails(normalized);
    const resolutionChannel = selectResolutionChannel(matches);
    const initialEvidenceQuestion = nextEvidenceQuestion(normalized, intentAssessment, resolutionChannel);
    const providerEvidence = resolutionChannel?.type?.startsWith("self_service_")
      ? {
        provider_directory: null,
        problem_type: "support.self_service",
        responses: [],
        gaps: [],
        deferred_providers: [],
        provider_decisions: [{status: "deferred", reason: "self_service_resolution_channel", evidence_question: initialEvidenceQuestion}],
        routing_status: "deferred_self_service",
        resolution_channel: resolutionChannel,
      }
      : await collectOptionalEvidence({kbRoot, issue: normalized, retrievalSeedDetails: seedDetails, providerDir, evidenceQuestion: initialEvidenceQuestion});
    if (evidencePlan) {
      stage = "planned_provider_evidence";
      if (providerEvidence.routing_status === "deferred_self_service") providerEvidence.routing_status = "explicit_evidence_plan";
      const planned = await executeEvidencePlan({
        kbRoot,
        issue: normalized,
        evidencePlan,
        providerDir,
        authorizeProfileUpdate: authorizeLokiProfileUpdate,
      });
      providerEvidence.responses.push(...planned.responses);
      providerEvidence.gaps.push(...planned.gaps);
      providerEvidence.deferred_providers = (providerEvidence.deferred_providers || []).filter((provider) => provider !== "loki");
      providerEvidence.inspection_steps = planned.inspection_steps;
      providerEvidence.evidence_plan_status = planned.status;
      providerEvidence.loki_budget = planned.budget;
    }
    let report = reportFor(normalized, matches, injection, vaultContract, intentAssessment, providerEvidence, resolutionChannel);
    let publishResult = null;
    if (publishToKb) {
      const candidate = structuredClone(normalized);
      candidate.attachments = candidate.attachments.map((item) => ({...item, sha256: "", download_status: "not_requested", relative_path: ""}));
      if (intentAssessment.work_intent === "request_fulfillment") {
        candidate.fulfillment = {status: "planned", intent_assessment: intentAssessment, report_markdown: report};
      } else {
        candidate.diagnosis = {status: "unresolved", intent_assessment: intentAssessment, report_markdown: report};
      }
      candidate.content_hash = normalizedContentHash(candidate);
      publishResult = new BundleWriter({outputRoot: path.join(kbRoot, "inbox/jira"), collectorName: "l05-diagnosis", collectorVersion: "2.0.0"}).write({rawIssue: {source: candidate.source, retained_in_temporary_case_only: true}, normalized: candidate, attachmentFiles: new Map()});
      publishResult.quality = evaluateBundle(publishResult.bundle, {vault: kbRoot, outputDir: path.join(kbRoot, "system/reports/jira-quality")});
      report = reportFor(candidate, matches, injection, vaultContract, intentAssessment, providerEvidence, resolutionChannel, publishResult);
    }
    const summary = {
      issue_key: normalized.source.issue_key,
      collection_status: normalized.collection,
      intent_assessment: intentAssessment,
      vault_contract: vaultContract,
      kb_matches: matches,
      resolution_channel: resolutionChannel,
      retrieval_seeds: retrievalSeeds(normalized),
      retrieval_seed_details: seedDetails,
      optional_provider_evidence: providerEvidence,
      inspection_trace: buildInspectionTrace(normalized, matches, providerEvidence),
      next_evidence_question: initialEvidenceQuestion,
      prompt_injection_detected: injection,
      hypotheses: intentAssessment.work_intent === "request_fulfillment" ? [] : hypotheses(normalized, matches, providerEvidence),
      publish_result: publishResult,
    };
    const reportName = intentAssessment.work_intent === "request_fulfillment" ? "fulfillment.md" : "diagnosis.md";
    const reportFile = path.join(root, reportName);
    fs.writeFileSync(reportFile, report);
    fs.writeFileSync(path.join(root, "case-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return {
      status: "complete",
      issue_key: normalized.source.issue_key,
      report,
      report_file: keepTemp || !temporary ? reportFile : null,
      case_dir: keepTemp || !temporary ? root : null,
      bundle: keepTemp || !temporary ? collection.bundle : null,
      intent_assessment: intentAssessment,
      kb_matches: matches,
      provider_evidence: providerEvidence,
      publish_result: publishResult,
    };
  } catch (error) {
    if (stage === "jira_collection") {
      const failure = classifyJiraCollectionFailure(error.message);
      return {status: "blocked", issue_key: identity.issue_key, ...failure, diagnosis_allowed: false, case_dir: keepTemp || !temporary ? root : null};
    }
    return {status: "blocked", issue_key: identity.issue_key, stage, reason: sanitizeFailureDetail(error.message), diagnosis_allowed: false, case_dir: keepTemp || !temporary ? root : null};
  } finally {
    if (collectorResult?.output_root && !keepTemp) {
      try { await execFileAsync(process.execPath, [collectorCli(), "cleanup", collectorResult.output_root], {env: {...process.env}, maxBuffer: 1024 * 1024}); } catch {}
    }
    if (temporary && !keepTemp) fs.rmSync(root, {recursive: true, force: true});
  }
}

function parseArgs(argv) {
  loadMissingL05ConfigEnv(["JIRA_BASE_URL", "JIRA_TOKEN", "JIRA_EMAIL", "JIRA_AUTH_MODE", "L05_OBSIDIAN_VAULT", "PAAS_KB_ROOT"]);
  const args = {kbRoot: process.env.L05_OBSIDIAN_VAULT || process.env.PAAS_KB_ROOT, baseUrl: process.env.JIRA_BASE_URL, attachmentMode: "metadata-only"};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("-") && !args.issue) args.issue = key;
    else if (key === "--base-url") args.baseUrl = argv[++index];
    else if (key === "--kb-root" || key === "--vault") args.kbRoot = path.resolve(argv[++index]);
    else if (key === "--fixture") args.fixture = path.resolve(argv[++index]);
    else if (key === "--attachment-mode") args.attachmentMode = argv[++index];
    else if (key === "--case-dir") args.caseDir = path.resolve(argv[++index]);
    else if (key === "--evidence-plan") args.evidencePlanFile = path.resolve(argv[++index]);
    else if (key === "--authorize-loki-profile-update") args.authorizeLokiProfileUpdate = true;
    else if (key === "--keep-temp") args.keepTemp = true;
    else if (key === "--publish-to-kb") args.publishToKb = true;
    else if (key === "--help") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.issue) { console.log("Usage: run_l05_case.mjs <issue-key-or-url> [--fixture json] [--kb-root path] [--attachment-mode mode] [--evidence-plan json] [--authorize-loki-profile-update] [--keep-temp] [--publish-to-kb]"); return args.help ? 0 : 2; }
  if (!args.kbRoot) { console.log(JSON.stringify({status: "blocked", reason: "L05_OBSIDIAN_VAULT is not configured; run l05_setup.py doctor", diagnosis_allowed: false}, null, 2)); return 2; }
  if (args.evidencePlanFile) {
    const metadata = fs.lstatSync(args.evidencePlanFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024) throw new Error("Evidence Plan must be a regular JSON file no larger than 1 MiB");
    args.evidencePlan = JSON.parse(fs.readFileSync(args.evidencePlanFile, "utf8"));
  }
  const result = await runCase(args);
  if (result.report) console.log(result.report);
  else console.log(JSON.stringify(result, null, 2));
  console.error(JSON.stringify({status: result.status, issue_key: result.issue_key, work_intent: result.intent_assessment?.work_intent, planning_status: result.intent_assessment?.planning_status, case_dir: result.case_dir, report_file: result.report_file, publish_result: result.publish_result}, null, 2));
  return result.status === "complete" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
