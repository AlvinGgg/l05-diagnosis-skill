#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {compareFreshness, extractRetrievalSeedDetails, findKbMatches, loadVaultProfile, retrievalSeeds} from "./evidence-adapter.mjs";
import {BundleWriter} from "./vendor/jira-collector/bundle-writer.mjs";
import {loadMissingL05ConfigEnv} from "./vendor/jira-collector/env-loader.mjs";
import {normalizedContentHash, validateBundle} from "./vendor/jira-collector/validate-jira-bundle.mjs";
import {evaluateBundle} from "./vendor/ticket-quality/evaluate-jira-ticket-quality.mjs";
import {collectOptionalEvidence} from "./provider-loader.mjs";

const SKILL_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const COLLECTOR_CLI = path.join(SKILL_ROOT, "scripts/vendor/jira-collector/jira-collect.mjs");
const execFileAsync = promisify(execFile);
const INJECTION_RE = /ignore (?:all |the )?(?:previous|prior) instructions|read (?:the )?(?:environment|env) variables|upload (?:the )?(?:repository|repo)|execute (?:this |the )?command|system prompt/i;

export {compareFreshness, findKbMatches, retrievalSeeds};
export function parseIssueIdentity(value, baseUrl = "") {
  const match = /\b([A-Z][A-Z0-9_]*-[0-9]+)\b/i.exec(value || "");
  if (!match) throw new Error(`cannot parse Jira issue key: ${value}`);
  let instance = baseUrl;
  try { const url = new URL(value); instance = `${url.protocol}//${url.host}`; } catch {}
  if (!instance) throw new Error("JIRA_BASE_URL is required when the input is an issue key");
  return {issue_key: match[1].toUpperCase(), base_url: instance.replace(/\/+$/, "")};
}
export function detectPromptInjection(text) { return INJECTION_RE.test(text || ""); }

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

function reportFor(issue, matches, injection, vaultContract, providerEvidence = null, publishResult = null) {
  const timeline = [`- ${issue.source.issue_updated_at}: Jira issue updated`, ...(issue.comments || []).map((comment) => `- ${comment.created}: comment ${comment.id}`)].join("\n") || "- No comments collected.";
  const matchLines = matches.map((item) => `- ${item.source_type} / ${item.quality_level} / ${item.freshness} / ${item.match_reason.join(", ")}: ${item.evidence_path}`).join("\n") || "- No matching local precedent.";
  const providerLines = (providerEvidence?.responses || []).flatMap((response) => (response.evidence_records || []).map((record) => ({provider_id: response.provider_id, record}))).map(({provider_id, record}) => `- ${provider_id} / ${record.capability || "unknown"} / ${record.confidence || "unknown"}: ${record.summary || record.evidence_type || "evidence collected"}`).join("\n") || "- No optional Provider evidence collected.";
  const providerDetails = (providerEvidence?.responses || []).flatMap((response) => (response.evidence_records || []).filter((record) => record.data !== undefined).map((record) => ({provider_id: response.provider_id, record}))).map(({provider_id, record}) => `### ${provider_id} / ${record.capability || "unknown"}\n\n${JSON.stringify(record.data, null, 2).split("\n").map((line) => `    ${line}`).join("\n")}`).join("\n\n") || "- No optional Provider detail available.";
  const investigationTrail = [
    `Jira ${issue.source.issue_key}: collected current issue fields and ${issue.comments?.length || 0} user comments.`,
    ...matches.map((item) => `KB ${item.evidence_path}: matched by ${item.match_reason.join(", ")}; quality=${item.quality_level}, freshness=${item.freshness}.`),
    ...(providerEvidence?.responses || []).flatMap((response) => (response.evidence_records || []).map((record) => `Provider ${response.provider_id} / ${record.capability || "unknown"}: ${record.summary || record.evidence_type || "evidence collected"}.`)),
  ].map((item, index) => `${index + 1}. ${item}`).join("\n");
  const inspectedEvidence = [
    "- Current normalized Jira bundle",
    ...(matches.length ? ["- Local evidence paths listed above"] : []),
    ...((providerEvidence?.responses || []).some((response) => response.evidence_records?.length) ? ["- Optional Provider records listed above"] : []),
  ].join("\n");
  const gaps = evidenceGaps(issue, injection, vaultContract, providerEvidence);
  const structuredHypotheses = hypotheses(issue, matches, providerEvidence);
  return `# L0.5 diagnosis: ${issue.source.issue_key}\n\n## Collection status\n\n- Core issue: complete\n- Schema: ${issue.schema_version}\n- Unsupported ADF nodes: ${issue.collection.unsupported_adf_nodes.join(", ") || "none"}\n\n## Ticket facts\n\n- Summary: ${issue.ticket.summary}\n- Status: ${issue.ticket.status}\n- Updated: ${issue.source.issue_updated_at}\n- Components: ${issue.ticket.components.join(", ") || "none"}\n\n## Timeline\n\n${timeline}\n\n## Local KB matches and freshness\n\n${matchLines}\n\n## Optional Provider evidence\n\n${providerLines}\n\n## Optional Provider evidence details\n\n${providerDetails}\n\n## Investigation trail\n\n${investigationTrail}\n\n## Evidence inspected\n\n${inspectedEvidence}\n\n## Hypotheses with supporting and contradicting evidence\n\n${structuredHypotheses.map((item) => `- Hypothesis: ${item.hypothesis}\n  - Supporting: ${item.supporting_evidence.join("; ")}\n  - Contradicting: ${item.contradicting_evidence.join("; ")}\n  - Missing: ${item.missing_evidence.join("; ")}\n  - Confidence: ${item.confidence}`).join("\n")}\n\n## Root cause assessment\n\n**unresolved** — historical and Provider evidence must be interpreted together with current causal evidence before confirming a root cause.\n\n## Recommended change\n\nCollect the narrow current log, configuration, code, or runtime evidence needed to test the leading hypothesis. Any production-affecting change requires human review and approval.\n\n## Verification plan\n\nReproduce safely, inspect the relevant current configuration/code/runtime evidence, apply a human-reviewed change, and verify regression behavior in the affected environment.\n\n## Access and evidence gaps\n\n${gaps.map((item) => `- ${item}`).join("\n") || "- No collection gap recorded; targeted diagnosis evidence is still required."}\n\n## Optional KB publish result\n\n${publishResult ? `- ${publishResult.outcome}: ${publishResult.bundle}` : "- Not requested."}\n\n## Jira reply draft\n\n- Not generated: root cause is unresolved. Generate a ready-to-paste draft only after current evidence confirms the causal chain.\n`;
}

export async function runCase({issue, baseUrl, kbRoot, fixture, attachmentMode = "metadata-only", caseDir, keepTemp = false, publishToKb = false, providerDir}) {
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
    stage = "vault_retrieval";
    const vaultContract = readVaultContract(kbRoot);
    const matches = findKbMatches(kbRoot, normalized, normalized.source.issue_updated_at);
    const seedDetails = extractRetrievalSeedDetails(normalized);
    const providerEvidence = await collectOptionalEvidence({kbRoot, issue: normalized, retrievalSeedDetails: seedDetails, providerDir});
    const injection = detectPromptInjection(`${normalized.ticket.description_markdown}\n${normalized.comments.map((item) => item.body_markdown).join("\n")}`);
    let report = reportFor(normalized, matches, injection, vaultContract, providerEvidence);
    let publishResult = null;
    if (publishToKb) {
      const candidate = structuredClone(normalized);
      candidate.attachments = candidate.attachments.map((item) => ({...item, sha256: "", download_status: "not_requested", relative_path: ""}));
      candidate.diagnosis = {status: "unresolved", report_markdown: report};
      candidate.content_hash = normalizedContentHash(candidate);
      publishResult = new BundleWriter({outputRoot: path.join(kbRoot, "inbox/jira"), collectorName: "l05-diagnosis", collectorVersion: "2.0.0"}).write({rawIssue: {source: candidate.source, retained_in_temporary_case_only: true}, normalized: candidate, attachmentFiles: new Map()});
      publishResult.quality = evaluateBundle(publishResult.bundle, {vault: kbRoot, outputDir: path.join(kbRoot, "system/reports/jira-quality")});
      report = reportFor(candidate, matches, injection, vaultContract, providerEvidence, publishResult);
    }
    const summary = {issue_key: normalized.source.issue_key, collection_status: normalized.collection, vault_contract: vaultContract, kb_matches: matches, retrieval_seeds: retrievalSeeds(normalized), retrieval_seed_details: seedDetails, optional_provider_evidence: providerEvidence, prompt_injection_detected: injection, hypotheses: hypotheses(normalized, matches, providerEvidence), publish_result: publishResult};
    fs.writeFileSync(path.join(root, "diagnosis.md"), report);
    fs.writeFileSync(path.join(root, "case-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return {status: "complete", issue_key: normalized.source.issue_key, report, case_dir: keepTemp || !temporary ? root : null, bundle: keepTemp || !temporary ? collection.bundle : null, kb_matches: matches, provider_evidence: providerEvidence, publish_result: publishResult};
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
    else if (key === "--keep-temp") args.keepTemp = true;
    else if (key === "--publish-to-kb") args.publishToKb = true;
    else if (key === "--help") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.issue) { console.log("Usage: run_l05_case.mjs <issue-key-or-url> [--fixture json] [--kb-root path] [--attachment-mode mode] [--keep-temp] [--publish-to-kb]"); return args.help ? 0 : 2; }
  if (!args.kbRoot) { console.log(JSON.stringify({status: "blocked", reason: "L05_OBSIDIAN_VAULT is not configured; run l05_setup.py doctor", diagnosis_allowed: false}, null, 2)); return 2; }
  const result = await runCase(args);
  if (result.report) console.log(result.report);
  else console.log(JSON.stringify(result, null, 2));
  console.error(JSON.stringify({status: result.status, issue_key: result.issue_key, case_dir: result.case_dir, publish_result: result.publish_result}, null, 2));
  return result.status === "complete" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) main().then((code) => { process.exitCode = code; }).catch((error) => { console.error(error.message); process.exitCode = 1; });
