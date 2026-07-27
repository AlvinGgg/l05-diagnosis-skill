import fs from "node:fs";
import path from "node:path";

const SENSITIVE = /(?:token|secret|password|passwd|authorization|cookie|signature|\bsig=|\bsign=|nonce|api[_-]?key|subscription[_-]?key|redacted)/i;
const URL_WITH_SECRET = /https?:\/\/[^\s<>)\]]*[?&](?:token|sig|sign|signature|secret|key|auth|sas|nonce)=/i;
const STOP_WORDS = new Set(["the", "and", "with", "from", "that", "this", "please", "error", "issue", "http", "https", "curl", "header", "request", "ticket", "support", "assigned", "engineer", "config", "gateway", "consumer", "path", "page", "timestamp", "thumbnail", "服务", "问题", "用户", "需要", "无法", "请问", "help"]);
const AUTOMATION_AUTHOR = /(?:bot|automation|stackstorm|opsagent|no[-_ ]?reply|noreply|\bim\b|system)/i;
const DEFAULT_KNOWLEDGE_PATHS = Object.freeze({
  contract: "AGENTS.md",
  index: "index.md",
  raw_tickets: "raw/tickets",
  wiki_sources_documents: "wiki/sources/documents",
  wiki_sources_tickets: "wiki/sources/tickets",
  wiki_sources_jira: "wiki/sources/jira",
  wiki_howtos: "wiki/howtos",
  wiki_systems: "wiki/systems",
  wiki_topics: "wiki/topics",
  wiki_concepts: "wiki/concepts",
  quality_reports: "system/reports/jira-quality",
});

function safeRelative(value) {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) return false;
  return !value.split("/").includes("..");
}

export function loadVaultProfile(kbRoot) {
  const file = path.join(path.resolve(kbRoot), ".l05-profile.json");
  if (!fs.existsSync(file)) return {status: "missing", paths: {...DEFAULT_KNOWLEDGE_PATHS}, field_mappings: {}, errors: ["profile_not_found"]};
  try {
    const profile = JSON.parse(readText(file));
    const configured = profile?.knowledge;
    if (typeof configured !== "object" || configured === null) throw new Error("knowledge_mapping_missing");
    const invalid = Object.entries(configured).filter(([, value]) => !safeRelative(value)).map(([key]) => `unsafe_knowledge_path:${key}`);
    const fieldMappings = profile?.jira?.field_mappings || {};
    if (typeof fieldMappings !== "object" || fieldMappings === null || Array.isArray(fieldMappings)) invalid.push("jira_field_mappings_invalid");
    else if (Object.values(fieldMappings).some((values) => !Array.isArray(values) || !values.length || values.some((value) => typeof value !== "string" || !value.trim()))) invalid.push("jira_field_mappings_invalid");
    if (invalid.length) return {status: "invalid", paths: {...DEFAULT_KNOWLEDGE_PATHS}, field_mappings: {}, errors: invalid};
    return {status: "valid", paths: {...DEFAULT_KNOWLEDGE_PATHS, ...configured}, field_mappings: fieldMappings, errors: []};
  } catch {
    return {status: "invalid", paths: {...DEFAULT_KNOWLEDGE_PATHS}, field_mappings: {}, errors: ["profile_json_is_invalid"]};
  }
}

function walk(root, predicate, values = []) {
  if (!fs.existsSync(root)) return values;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) walk(target, predicate, values);
    else if (predicate(target)) values.push(target);
  }
  return values;
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); }
  catch { return ""; }
}

function frontmatterValue(text, key) {
  return new RegExp(`^${key}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim().replace(/^['"]|['"]$/g, "") || "";
}

function sourceField(text, label) {
  return new RegExp(`^- ${label}:\\s*(.+)$`, "m").exec(text)?.[1]?.trim() || "";
}

function relative(root, file) { return path.relative(root, file).split(path.sep).join("/"); }

function safeSeed(value) {
  const text = String(value || "").trim();
  if (text.length < 3 || text.length > 120 || SENSITIVE.test(text) || URL_WITH_SECRET.test(text)) return "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return "";
  if (/\b[A-F0-9]{16,}\b/i.test(text)) return "";
  return text;
}

function seedSafeText(value) {
  return String(value || "")
    .replace(/\b(cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, "$1: [redacted]")
    .replace(/\b(token|password|passwd|secret|client[_-]?secret|api[_-]?key|subscription[_-]?key|sas|sign|signature|nonce(?:[_-]?str)?|nonce-sign)\s*[:=]\s*[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/(https?:\/\/[^\s<>)\]]*[?&](?:token|sig|sign|signature|secret|key|auth|sas|nonce)=)[^&\s)]+/gi, "$1[redacted]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip-redacted]");
}

function addSeed(target, value, kind) {
  const safe = safeSeed(value);
  if (!safe || STOP_WORDS.has(safe.toLowerCase())) return;
  const key = `${kind}|${safe.toLowerCase()}`;
  if (!target.has(key)) target.set(key, {value: safe, kind});
}

export function extractRetrievalSeedDetails(issue) {
  const seeds = new Map();
  const userComments = (issue.comments || []).filter((item) => !AUTOMATION_AUTHOR.test(`${item.author?.display_name || ""} ${item.author?.stable_id || ""}`));
  const fields = seedSafeText([issue.ticket?.summary, issue.ticket?.description_markdown, ...userComments.map((item) => item.body_markdown || "")].join("\n"));
  addSeed(seeds, issue.source?.issue_key, "issue_key");
  for (const value of [...(issue.ticket?.components || []), ...(issue.ticket?.versions || []), ...(issue.ticket?.fix_versions || []), ...(issue.ticket?.labels || [])]) addSeed(seeds, value, "metadata");
  for (const match of fields.matchAll(/\b(?:[45]\d\d|[A-Z][A-Z0-9_]+-[0-9]{2,}|(?:ERR|ORA|E)[-_]?[0-9]{3,})\b/g)) addSeed(seeds, match[0], "error_code");
  for (const match of fields.matchAll(/\b[A-Za-z_$][\w$]*(?:Exception|Error|Throwable)\b/g)) addSeed(seeds, match[0], "exception");
  for (const match of fields.matchAll(/\bat\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){1,})/g)) addSeed(seeds, match[1], "stack_frame");
  for (const match of fields.matchAll(/\b(?:[A-Za-z][\w-]*\.)+(?:url|uri|host|endpoint|timeout|version|config|enabled|path)\b/gi)) addSeed(seeds, match[0], "config_key");
  for (const match of fields.matchAll(/\/(?:api|v[0-9]+|[A-Za-z0-9._-]+)(?:\/[A-Za-z0-9._{}-]+){1,}/g)) addSeed(seeds, match[0], "endpoint");
  for (const match of fields.matchAll(/\b[A-Za-z][A-Za-z0-9_.-]{3,}\b|[\p{Script=Han}]{2,10}/gu)) addSeed(seeds, match[0], "term");
  return [...seeds.values()].sort((left, right) => left.kind.localeCompare(right.kind) || left.value.localeCompare(right.value)).slice(0, 60);
}

export function retrievalSeeds(issue) {
  return extractRetrievalSeedDetails(issue).map((item) => item.value);
}

export function compareFreshness(kbUpdated, jiraUpdated) {
  const kb = Date.parse(kbUpdated || "");
  const jira = Date.parse(jiraUpdated || "");
  if (!Number.isFinite(kb) || !Number.isFinite(jira)) return "unknown";
  return kb + 1000 < jira ? "stale" : "fresh";
}

function redactSnippet(value) {
  return String(value || "")
    .replace(/\b(?:Bearer|Basic)\s+[^\s"']+/gi, "[redacted]")
    .replace(/\b(token|password|secret|api[_-]?key|sas|signature)\s*[:=]\s*[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/(https?:\/\/[^\s<>)\]]*[?&](?:token|sig|signature|secret|key|auth|sas)=)[^&\s)]+/gi, "$1[redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function snippetFor(text, values) {
  const lower = text.toLowerCase();
  const match = values.map((value) => ({value, index: lower.indexOf(value.toLowerCase())})).find((item) => item.index >= 0);
  if (!match) return redactSnippet(text).slice(0, 280);
  return redactSnippet(text.slice(Math.max(0, match.index - 90), match.index + match.value.length + 180)).slice(0, 280);
}

function classify(text) {
  const value = text.toLowerCase();
  const service = /apim|api gateway|swagger/.test(value) ? "apim" : /cicd|pipeline|jenkins|github actions/.test(value) ? "ci-cd" : /kubernetes|\bk8s\b|pod|helm/.test(value) ? "kubernetes" : /vault|secret|certificate/.test(value) ? "identity-secrets" : "unknown";
  const requestType = /deploy|发布|release/.test(value) ? "deployment_issue" : /访问|permission|权限|whitelist|白名单/.test(value) ? "access_request" : /配置|config/.test(value) ? "configuration" : "incident_or_question";
  const environment = /\bprod(?:uction)?\b|生产/.test(value) ? "prod" : /\bqa\b|测试/.test(value) ? "qa" : /\bdev\b|开发/.test(value) ? "dev" : "unknown";
  const riskLevel = /delete|删除|restart|重启|secret|certificate|token|生产/.test(value) ? "high" : /permission|权限|config|配置/.test(value) ? "medium" : "low";
  return {service, request_type: requestType, environment, risk_level: riskLevel};
}

function qualityLevel(report) {
  if (!report) return "unknown";
  if (report.decision === "promote_active") return "high";
  if (report.decision === "promote_needs_review") return "medium";
  return "rejected";
}

function loadQualityReports(kbRoot, knowledgePaths) {
  const reports = new Map();
  for (const file of walk(path.join(kbRoot, knowledgePaths.quality_reports), (item) => item.endsWith(".json"))) {
    try {
      const report = JSON.parse(readText(file));
      if (report.ingest_id && report.content_hash) reports.set(`${report.ingest_id}|${report.content_hash}`, {...report, _path: relative(kbRoot, file)});
    } catch {}
  }
  return reports;
}

function candidateFromSourcePage(kbRoot, file, reports) {
  const text = readText(file);
  const contentHash = sourceField(text, "Content hash");
  const rawBundle = sourceField(text, "Raw bundle");
  const reportPath = sourceField(text, "Quality report");
  const report = reportPath && fs.existsSync(path.join(kbRoot, reportPath)) ? (() => { try { return {...JSON.parse(readText(path.join(kbRoot, reportPath))), _path: reportPath}; } catch { return null; } })() : null;
  const ingestId = rawBundle ? path.basename(rawBundle) : report?.ingest_id || "";
  return {
    id: `source:${relative(kbRoot, file)}`,
    source_type: "jira_source_page",
    source_ref: sourceField(text, "Issue key") || frontmatterValue(text, "title"),
    path: relative(kbRoot, file),
    title: frontmatterValue(text, "title") || path.basename(file, ".md"),
    source_updated_at: sourceField(text, "Source updated at") || frontmatterValue(text, "updated"),
    content_hash: contentHash,
    ingest_id: ingestId,
    report: report || reports.get(`${ingestId}|${contentHash}`) || null,
    text,
    curated_rank: 8,
  };
}

function candidateFromRawBundle(kbRoot, manifestFile, reports) {
  try {
    const manifest = JSON.parse(readText(manifestFile));
    const root = path.dirname(manifestFile);
    const normalized = JSON.parse(readText(path.join(root, "issue.normalized.json")));
    return {
      id: `raw:${manifest.ingest_id}|${manifest.content_hash}`,
      source_type: "raw_ticket",
      source_ref: manifest.source?.issue_key || "unknown",
      path: relative(kbRoot, root),
      title: normalized.ticket?.summary || manifest.source?.issue_key || "raw ticket",
      source_updated_at: normalized.source?.issue_updated_at || manifest.source?.issue_updated_at || "",
      content_hash: manifest.content_hash,
      ingest_id: manifest.ingest_id,
      report: reports.get(`${manifest.ingest_id}|${manifest.content_hash}`) || null,
      text: `${normalized.ticket?.summary || ""}\n${normalized.ticket?.description_markdown || ""}\n${(normalized.comments || []).map((item) => item.body_markdown || "").join("\n")}`,
      curated_rank: 0,
    };
  } catch { return null; }
}

function candidateFromWiki(kbRoot, file, sourceType, rank) {
  const text = readText(file);
  return {id: `wiki:${relative(kbRoot, file)}`, source_type: sourceType, source_ref: frontmatterValue(text, "title") || path.basename(file, ".md"), path: relative(kbRoot, file), title: frontmatterValue(text, "title") || path.basename(file, ".md"), source_updated_at: frontmatterValue(text, "updated"), content_hash: "", ingest_id: "", report: null, text, curated_rank: rank};
}

function scoreCandidate(candidate, seedDetails, jiraUpdated) {
  const lower = candidate.text.toLowerCase();
  const matched = seedDetails.filter((seed) => lower.includes(seed.value.toLowerCase()));
  if (!matched.length) return null;
  const hasSpecificMatch = matched.some((seed) => ["endpoint", "config_key", "exception", "metadata"].includes(seed.kind) || (seed.kind === "term" && seed.value.length >= 7));
  if (!hasSpecificMatch) return null;
  const quality = qualityLevel(candidate.report);
  if (["low", "rejected", "excluded"].includes(quality)) return null;
  const freshness = compareFreshness(candidate.source_updated_at, jiraUpdated);
  const qualityWeight = {high: 18, medium: 8, unknown: 3}[quality];
  const freshnessWeight = {fresh: 40, unknown: 12, stale: 0}[freshness];
  const matchReason = [...new Set(matched.map((item) => item.kind))].sort();
  const rank = matchReason.length * 25 + qualityWeight + freshnessWeight + candidate.curated_rank;
  return {
    id: candidate.id,
    source_type: candidate.source_type,
    source_ref: candidate.source_ref,
    path: candidate.path,
    evidence_path: candidate.path,
    title: candidate.title,
    ...classify(candidate.text),
    quality_level: quality,
    resolution_quality_score: candidate.report?.resolution_quality?.score ?? null,
    knowledge_value_score: candidate.report?.knowledge_value?.score ?? null,
    freshness,
    source_updated_at: candidate.source_updated_at || null,
    match_reason: matchReason,
    snippet: snippetFor(candidate.text, matched.map((item) => item.value)),
    _rank: rank,
    _content_hash: candidate.content_hash,
  };
}

export function findKbMatches(kbRoot, issueOrKey, jiraUpdated = "") {
  const root = path.resolve(kbRoot);
  const knowledgePaths = loadVaultProfile(root).paths;
  const issue = typeof issueOrKey === "string" ? {source: {issue_key: issueOrKey}, ticket: {summary: issueOrKey, description_markdown: "", components: [], versions: [], fix_versions: [], labels: []}, comments: []} : issueOrKey;
  const seeds = extractRetrievalSeedDetails(issue);
  const reports = loadQualityReports(root, knowledgePaths);
  const candidates = [];
  for (const file of walk(path.join(root, knowledgePaths.wiki_sources_jira), (item) => item.endsWith(".md"))) candidates.push(candidateFromSourcePage(root, file, reports));
  for (const [folder, type, rank] of [[knowledgePaths.wiki_sources_tickets, "ticket_source", 7], [knowledgePaths.wiki_sources_documents, "document_source", 6], [knowledgePaths.wiki_howtos, "wiki_howto", 5], [knowledgePaths.wiki_systems, "wiki_system", 5], [knowledgePaths.wiki_topics, "wiki_topic", 5], [knowledgePaths.wiki_concepts, "wiki_concept", 4]]) for (const file of walk(path.join(root, folder), (item) => item.endsWith(".md"))) candidates.push(candidateFromWiki(root, file, type, rank));
  for (const file of walk(path.join(root, knowledgePaths.raw_tickets), (item) => path.basename(item) === "manifest.json")) {
    const candidate = candidateFromRawBundle(root, file, reports);
    if (candidate) candidates.push(candidate);
  }
  const scored = candidates.map((item) => scoreCandidate(item, seeds, jiraUpdated)).filter(Boolean);
  const deduped = new Map();
  for (const item of scored) {
    const key = item._content_hash || item.id;
    const previous = deduped.get(key);
    if (!previous || item._rank > previous._rank || (item._rank === previous._rank && item.source_type < previous.source_type)) deduped.set(key, item);
  }
  return [...deduped.values()]
    .sort((left, right) => right._rank - left._rank || left.path.localeCompare(right.path))
    .slice(0, 12)
    .map(({_rank, _content_hash, ...item}) => item);
}
