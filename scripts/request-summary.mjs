const AUTOMATION_AUTHOR = /(?:bot|automation|stackstorm|opsagent|no[-_ ]?reply|noreply|\bim\b|system)/i;
const SENSITIVE = /(?:token|secret|password|passwd|authorization|cookie|signature|\bsig=|\bsign=|nonce|api[_-]?key|subscription[_-]?key|sas)/i;
const PROBLEM_SIGNAL = /失败|报错|异常|无法|不可用|中断|无响应|错误码|不生效|未生效|失效|读取不到|读不到|遇到.{0,12}问题|为什么|根因|\b[45]\d{2}\b|\b(?:failed|failure|error|exception|unavailable|cannot|can't|unable|broken|timed?\s*out|not working|not effective|stopped working|regressed|root cause|cors|preflight|access control|blocked by|does(?: not|n't) pass)\b/i;
const FULFILLMENT_SIGNAL = /创建|新增|开通|配置|修改|变更|授权|开放|扩容|迁移|切换|下线|设置|调整|指向|部署|接入|屏蔽|限制|限流|\b(?:create|add|enable|configure|change|update|grant|provision|migrate|switch|expand|remove|decommission|deploy|set|increase|block|restrict|rate limit)\b/i;
const ENVIRONMENT = [
  ["prod", /(?:生产|\b(?:prod|prd|production)\b)/i],
  ["qa", /(?:测试|\bqa\b)/i],
  ["uat", /(?:预发|\buat\b)/i],
  ["dev", /(?:开发|\b(?:dev|development)\b)/i],
];
const EXPLICIT_TARGET_CORRECTION = /(?:更正|修正|更新为|改为|实际(?:应|是)|正确(?:的)?(?:地址|接口|目标)?|不是.{0,48}(?:而是|应为)|instead of|correct(?:ed)? (?:target|url|endpoint)|actual (?:target|url|endpoint))/i;

function isAutomationComment(comment) {
  return AUTOMATION_AUTHOR.test(`${comment?.author?.display_name || ""} ${comment?.author?.stable_id || ""}`);
}

function stripSensitiveText(value) {
  return String(value || "")
    .replace(/\b(cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, "$1: [redacted]")
    .replace(/\b(token|password|passwd|secret|client[_-]?secret|api[_-]?key|subscription[_-]?key|sas|sign|signature|nonce(?:[_-]?str)?)\s*[:=]\s*[^\s,;"']+/gi, "$1=[redacted]")
    .replace(/(https?:\/\/[^\s<>)\]]*[?&](?:token|sig|sign|signature|secret|key|auth|sas|nonce)=)[^&\s)]+/gi, "$1[redacted]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "[ip-redacted]")
    .replace(/\s+/g, " ")
    .trim();
}

function safeClause(value, limit = 320) {
  const text = stripSensitiveText(value);
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

function scalarValues(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object") return [value.value, value.name, value.label].flatMap(scalarValues);
  return [];
}

function sourceRecords(issue) {
  const comments = (issue.comments || []).filter((comment) => !isAutomationComment(comment));
  const records = [
    {source: "summary", text: issue.ticket?.summary || "", rank: 4},
    {source: "description", text: issue.ticket?.description_markdown || "", rank: 12},
  ];
  comments.forEach((comment, index) => {
    const text = comment.body_markdown || "";
    records.push({
      source: `comment:${comment.id || index + 1}`,
      text,
      rank: EXPLICIT_TARGET_CORRECTION.test(text) ? 14 : index === comments.length - 1 ? 8 : 6,
    });
  });
  return records.filter((record) => record.text.trim());
}

function clauseList(value) {
  return String(value || "")
    .split(/[\n\r。！？!?；;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeLocator(value) {
  try {
    const url = new URL(String(value).replace(/[.,;:]+$/, ""));
    if (!/^https?:$/.test(url.protocol)) return "";
    if (url.username || url.password || SENSITIVE.test(url.search)) return "";
    if (/(?:^|\.)(?:jira|atlassian)\./i.test(url.hostname)
      && /\/(?:browse|servicedesk\/customer\/portal)\//i.test(url.pathname)) return "";
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "";
  }
}

function locatorRole(locator) {
  try {
    const url = new URL(locator);
    if (/jenkins/i.test(url.hostname) || /\/job\//i.test(url.pathname)) return {role: "ci_endpoint", score: 90};
    if (/\bapi\b/i.test(url.hostname) || /\/(?:api|v\d+|oauth|oidc|auth|callback|graphql|rest)(?:\/|$)/i.test(url.pathname)) return {role: "api", score: 100};
    if (/\/(?:ingress|service|gateway|route)(?:\/|$)/i.test(url.pathname)) return {role: "service_endpoint", score: 70};
    return {role: "page", score: 10};
  } catch {
    return {role: "page", score: 0};
  }
}

function environmentFor(value) {
  for (const [name, pattern] of ENVIRONMENT) if (pattern.test(value)) return name;
  return "unknown";
}

export function rankedSafeHttpLocators(issue) {
  const locators = new Map();
  for (const record of sourceRecords(issue)) {
    const values = record.text.match(/https?:\/\/[^\s\]|}'"<]+/gi) || [];
    for (const value of values) {
      const locator = safeLocator(value);
      if (!locator) continue;
      const detail = locatorRole(locator);
      const entry = {
        locator,
        source: record.source,
        role: detail.role,
        environment: environmentFor(`${locator}\n${record.text}`),
        score: detail.score + record.rank,
      };
      const previous = locators.get(locator);
      if (!previous || entry.score > previous.score) locators.set(locator, entry);
    }
  }
  return [...locators.values()].sort((left, right) => right.score - left.score || left.locator.localeCompare(right.locator));
}

function targetWithoutLocator(records) {
  const text = records.map((record) => record.text).join("\n");
  if (/confluence|jira|github|账号|account/i.test(text)) return {kind: "account", locator: null, environment: environmentFor(text), source: "description"};
  if (/pipeline|jenkins|cicd|流水线|构建/i.test(text)) return {kind: "build", locator: null, environment: environmentFor(text), source: "description"};
  if (/应用|application|服务|service|网关|gateway/i.test(text)) return {kind: "application", locator: null, environment: environmentFor(text), source: "description"};
  return null;
}

function extractTargetIdentity(issue, records) {
  const candidate = rankedSafeHttpLocators(issue)[0];
  if (candidate) {
    return {
      kind: candidate.role === "api" ? "api" : candidate.role === "ci_endpoint" ? "build" : candidate.role === "service_endpoint" ? "application" : "other",
      locator: candidate.locator,
      environment: candidate.environment,
      source: candidate.source,
    };
  }
  return targetWithoutLocator(records);
}

function firstClause(records, matcher) {
  for (const record of records) {
    const candidate = clauseList(record.text).find((clause) => matcher.test(clause));
    if (candidate) return safeClause(candidate);
  }
  return "";
}

function comparisonEvidence(description) {
  const clauses = clauseList(description);
  const production = /(?:生产|\b(?:prod|prd|production)\b)/i;
  const nonProduction = /(?:测试|\bqa\b|预发|\buat\b|开发|\bdev\b)/i;
  const combined = clauses.filter((clause) => production.test(clause) && nonProduction.test(clause));
  if (combined.length) return combined.map((clause) => safeClause(clause, 240)).slice(0, 3);
  const comparable = clauses.filter((clause) => production.test(clause) || nonProduction.test(clause));
  return comparable.map((clause) => safeClause(clause, 240)).slice(0, 3);
}

function mappingConfig(value = {}) {
  if (value?.field_mappings && typeof value.field_mappings === "object" && !Array.isArray(value.field_mappings)) return value;
  return {field_mappings: value, field_value_paths: {}};
}

function valueAtPath(value, pathValue) {
  if (typeof pathValue !== "string" || !pathValue.trim()) return undefined;
  return pathValue.split(".").reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)];
    return typeof current === "object" ? current[key] : undefined;
  }, value);
}

function semanticFieldValues(issue, jiraConfig = {}, slot) {
  const config = mappingConfig(jiraConfig);
  const selectors = new Set((config.field_mappings?.[slot] || []).map((value) => String(value).trim().toLowerCase()));
  const paths = Array.isArray(config.field_value_paths?.[slot]) ? config.field_value_paths[slot] : [];
  if (!selectors.size) return [];
  const values = [];
  for (const field of issue?.custom_fields || []) {
    const names = [field?.name, field?.id, field?.key].map((value) => String(value || "").trim().toLowerCase());
    if (!names.some((name) => selectors.has(name))) continue;
    const raw = field?.value;
    const structuredParentChild = field?.schema_type === "option-with-child"
      || Boolean(raw && typeof raw === "object" && !Array.isArray(raw) && raw.child);
    if (paths.length) {
      values.push(...paths.flatMap((pathValue) => scalarValues(valueAtPath(raw, pathValue))));
      continue;
    }
    if (slot === "application" && structuredParentChild) continue;
    values.push(...scalarValues(raw));
  }
  return [...new Set(values.filter((value) => typeof value === "string" || typeof value === "number").map(String).map((value) => value.trim()).filter(Boolean))];
}

export function extractRequestSummary(issue, jiraConfig = {}) {
  const records = sourceRecords(issue);
  const description = issue.ticket?.description_markdown || "";
  const descriptionFirst = [
    ...records.filter((record) => record.source === "description"),
    ...records.filter((record) => record.source === "summary"),
    ...records.filter((record) => record.source.startsWith("comment:")),
  ];
  const symptom = firstClause(descriptionFirst, PROBLEM_SIGNAL);
  const requestedAction = firstClause(descriptionFirst, FULFILLMENT_SIGNAL);
  const semanticFields = {};
  for (const slot of ["domain", "application", "namespace", "environment", "subscription"]) {
    const values = semanticFieldValues(issue, jiraConfig, slot);
    if (values.length === 1) semanticFields[slot] = values[0];
  }
  const extractedTarget = extractTargetIdentity(issue, records);
  const targetIdentity = semanticFields.application && (!extractedTarget?.locator && extractedTarget?.kind === "application")
    ? {...extractedTarget, source: "jira.custom_field"}
    : extractedTarget || (semanticFields.application ? {
      kind: "application",
      locator: null,
      environment: semanticFields.environment || environmentFor(description),
      source: "jira.custom_field",
    } : null);
  const descriptionEvidence = firstClause([{source: "description", text: description}], PROBLEM_SIGNAL)
    || safeClause(clauseList(description)[0] || "", 320);
  return {
    schema_version: "l05-request-summary/v1",
    requester_ask: requestedAction || symptom || safeClause(issue.ticket?.summary || "", 240),
    symptom_or_goal: symptom || requestedAction || safeClause(issue.ticket?.summary || "", 240),
    target_identity: targetIdentity,
    comparison_evidence: comparisonEvidence(description),
    description_evidence: descriptionEvidence || null,
    has_concrete_problem: Boolean(targetIdentity && (PROBLEM_SIGNAL.test(description) || PROBLEM_SIGNAL.test(issue.ticket?.summary || ""))),
    semantic_fields: semanticFields,
  };
}

export function isAutomationCommentForRequestSummary(comment) {
  return isAutomationComment(comment);
}
