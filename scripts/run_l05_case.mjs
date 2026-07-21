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
    if (stdout) return JSON.parse(stdout);
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

function evidenceGaps(issue, injection, vaultContract) {
  const gaps = [];
  if (issue.collection.permission_gaps?.length) gaps.push(...issue.collection.permission_gaps);
  for (const [step, value] of Object.entries(issue.collection.steps || {})) if (!["complete", undefined].includes(value.status)) gaps.push(`${step}:${value.status}`);
  if (injection) gaps.push("prompt-injection-text-detected-and-ignored");
  gaps.push(...(vaultContract?.gaps || []));
  return gaps;
}

function hypotheses(issue, matches) {
  return [{
    hypothesis: "No current root cause is confirmed from collection and historical precedent alone.",
    supporting_evidence: ["Current Jira normalized facts were collected.", ...matches.slice(0, 3).map((item) => `Historical precedent: ${item.evidence_path}`)],
    contradicting_evidence: ["No targeted current code, attachment, link, browser, or runtime evidence was collected by this command."],
    missing_evidence: ["Current error log, exact environment, and the narrow implementation or runtime evidence that tests a hypothesis."],
    confidence: "unresolved"
  }];
}

function reportFor(issue, matches, injection, vaultContract, publishResult = null) {
  const timeline = [`- ${issue.source.issue_updated_at}: Jira issue updated`, ...(issue.comments || []).map((comment) => `- ${comment.created}: comment ${comment.id}`)].join("\n") || "- No comments collected.";
  const matchLines = matches.map((item) => `- ${item.source_type} / ${item.quality_level} / ${item.freshness} / ${item.match_reason.join(", ")}: ${item.evidence_path}`).join("\n") || "- No matching local precedent.";
  const gaps = evidenceGaps(issue, injection, vaultContract);
  const structuredHypotheses = hypotheses(issue, matches);
  return `# L0.5 diagnosis: ${issue.source.issue_key}\n\n## Collection status\n\n- Core issue: complete\n- Schema: ${issue.schema_version}\n- Unsupported ADF nodes: ${issue.collection.unsupported_adf_nodes.join(", ") || "none"}\n\n## Ticket facts\n\n- Summary: ${issue.ticket.summary}\n- Status: ${issue.ticket.status}\n- Updated: ${issue.source.issue_updated_at}\n- Components: ${issue.ticket.components.join(", ") || "none"}\n\n## Timeline\n\n${timeline}\n\n## Local KB matches and freshness\n\n${matchLines}\n\n## Evidence inspected\n\n- Current normalized Jira bundle\n- Local evidence paths listed above\n\n## Hypotheses with supporting and contradicting evidence\n\n${structuredHypotheses.map((item) => `- Hypothesis: ${item.hypothesis}\n  - Supporting: ${item.supporting_evidence.join("; ")}\n  - Contradicting: ${item.contradicting_evidence.join("; ")}\n  - Missing: ${item.missing_evidence.join("; ")}\n  - Confidence: ${item.confidence}`).join("\n")}\n\n## Root cause assessment\n\n**unresolved** — historical evidence is precedent and cannot confirm the current root cause without targeted current evidence.\n\n## Recommended change\n\nCollect the narrow current log, configuration, code, or runtime evidence needed to test the leading hypothesis. Any production-affecting change requires human review and approval.\n\n## Verification plan\n\nReproduce safely, inspect the relevant current configuration/code/runtime evidence, apply a human-reviewed change, and verify regression behavior in the affected environment.\n\n## Access and evidence gaps\n\n${gaps.map((item) => `- ${item}`).join("\n") || "- No collection gap recorded; targeted diagnosis evidence is still required."}\n\n## Optional KB publish result\n\n${publishResult ? `- ${publishResult.outcome}: ${publishResult.bundle}` : "- Not requested."}\n\n## Jira reply draft\n\n- Not generated: root cause is unresolved. Generate a ready-to-paste draft only after current evidence confirms the causal chain.\n`;
}

export async function runCase({issue, baseUrl, kbRoot, fixture, attachmentMode = "metadata-only", caseDir, keepTemp = false, publishToKb = false}) {
  if (!kbRoot) return {status: "blocked", reason: "knowledge vault is not configured; run l05_setup.py doctor", diagnosis_allowed: false};
  const identity = parseIssueIdentity(issue, baseUrl);
  const temporary = !caseDir;
  const root = caseDir ? path.resolve(caseDir) : fs.mkdtempSync(path.join(os.tmpdir(), "l05-case-"));
  fs.mkdirSync(root, {recursive: true});
  let collectorResult;
  try {
    collectorResult = await runCollector({identity, fixture, attachmentMode, caseDir: caseDir ? root : null});
    if (collectorResult.status !== "ok" && collectorResult.status !== "partial") throw new Error(collectorResult.issues?.[0]?.warnings?.join(", ") || "collector core issue failed");
    const collection = {bundle: collectorResult.issues?.[0]?.bundle_path};
    if (!collection.bundle || !fs.existsSync(collection.bundle)) throw new Error("collector returned no bundle path");
    const validation = validateBundle(collection.bundle);
    if (!validation.valid) throw new Error(`bundle validation failed: ${validation.errors.map((item) => item.code).join(",")}`);
    const normalizedPath = path.join(collection.bundle, "issue.normalized.json");
    const normalized = JSON.parse(fs.readFileSync(normalizedPath, "utf8"));
    fs.copyFileSync(path.join(collection.bundle, "ticket.md"), path.join(root, "issue.md"));
    fs.copyFileSync(normalizedPath, path.join(root, "issue.normalized.json"));
    const vaultContract = readVaultContract(kbRoot);
    const matches = findKbMatches(kbRoot, normalized, normalized.source.issue_updated_at);
    const injection = detectPromptInjection(`${normalized.ticket.description_markdown}\n${normalized.comments.map((item) => item.body_markdown).join("\n")}`);
    let report = reportFor(normalized, matches, injection, vaultContract);
    let publishResult = null;
    if (publishToKb) {
      const candidate = structuredClone(normalized);
      candidate.attachments = candidate.attachments.map((item) => ({...item, sha256: "", download_status: "not_requested", relative_path: ""}));
      candidate.diagnosis = {status: "unresolved", report_markdown: report};
      candidate.content_hash = normalizedContentHash(candidate);
      publishResult = new BundleWriter({outputRoot: path.join(kbRoot, "inbox/jira"), collectorName: "l05-diagnosis", collectorVersion: "2.0.0"}).write({rawIssue: {source: candidate.source, retained_in_temporary_case_only: true}, normalized: candidate, attachmentFiles: new Map()});
      publishResult.quality = evaluateBundle(publishResult.bundle, {vault: kbRoot, outputDir: path.join(kbRoot, "system/reports/jira-quality")});
      report = reportFor(candidate, matches, injection, vaultContract, publishResult);
    }
    const summary = {issue_key: normalized.source.issue_key, collection_status: normalized.collection, vault_contract: vaultContract, kb_matches: matches, retrieval_seeds: retrievalSeeds(normalized), retrieval_seed_details: extractRetrievalSeedDetails(normalized), prompt_injection_detected: injection, hypotheses: hypotheses(normalized, matches), publish_result: publishResult};
    fs.writeFileSync(path.join(root, "diagnosis.md"), report);
    fs.writeFileSync(path.join(root, "case-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    return {status: "complete", issue_key: normalized.source.issue_key, report, case_dir: keepTemp || !temporary ? root : null, bundle: keepTemp || !temporary ? collection.bundle : null, kb_matches: matches, publish_result: publishResult};
  } catch (error) {
    return {status: "blocked", issue_key: identity.issue_key, reason: error.message, diagnosis_allowed: false, case_dir: keepTemp || !temporary ? root : null};
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
