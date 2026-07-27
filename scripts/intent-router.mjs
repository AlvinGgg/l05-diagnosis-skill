const TROUBLESHOOTING_SIGNALS = [
  {
    signal: "explicit_investigation_request",
    strength: 2,
    pattern: /(?:请|需要|希望|帮忙|协助).{0,24}(?:排查|分析|定位|查明|确认原因)|\b(?:please|need|request|want)\b.{0,60}\b(?:investigate|diagnose|troubleshoot|find the root cause)\b/i,
  },
  {
    signal: "observed_failure_or_unexpected_behavior",
    strength: 1,
    pattern: /失败|报错|异常|无法|不可用|中断|无响应|错误码|请求.{0,16}超时|超时(?:错误|中断|断开|失败)|为什么|根因|\b(?:failed|failure|error|exception|unavailable|cannot|can't|unable|broken|timed?\s*out|not working|root cause|gateway timeout|request timeout|why)\b/i,
  },
];

const FULFILLMENT_SIGNALS = [
  {
    signal: "explicit_fulfillment_request",
    strength: 2,
    pattern: /(?:请|需要|希望|申请|要求|帮忙|协助).{0,24}(?:创建|新增|开通|配置|修改|变更|授权|扩容|迁移|切换|下线|设置|调整|指向|部署)|\b(?:please|need|request|want|require)\b.{0,60}\b(?:create|add|enable|configure|change|update|grant|provision|migrate|switch|expand|remove|decommission|deploy|set|increase)\b/i,
  },
  {
    signal: "explicit_desired_state",
    strength: 2,
    pattern: /(?:设置|调整|修改|改|变更).{0,24}(?:为|到)|(?:切换|迁移).{0,24}(?:至|到)|指向|新增|开通|授权|扩容|下线|\b(?:change|set|switch|migrate|point|increase|update)\b.{0,60}\b(?:to|from)\b/i,
  },
];

const SEMANTIC_CUSTOM_FIELD_RE = /request[\s_-]*type|question[\s_-]*classification|issue[\s_-]*category/i;
const TROUBLESHOOTING_ISSUE_TYPE_RE = /\b(?:bug|incident|problem|fault)\b|故障|问题/i;
const FULFILLMENT_ISSUE_TYPE_RE = /\b(?:service request|change|access|request|task)\b|服务请求|变更|权限申请|需求/i;
const SUPPRESS_TROUBLESHOOTING_RE = /(?:无需|不用|不需要).{0,16}(?:排查|分析|定位|查明)|\b(?:no need to|do not)\b.{0,30}\b(?:investigate|diagnose|troubleshoot)\b/i;
const SUPPRESS_FULFILLMENT_RE = /(?:无需|不用|不需要).{0,16}(?:创建|配置|修改|变更|实施)|\b(?:no need to|do not)\b.{0,30}\b(?:create|configure|change|implement)\b/i;
const TARGET_RE = /网关|路由|服务|应用|集群|命名空间|入口|权限|账号|证书|域名|数据库|流水线|部署|gateway|route|service|application|cluster|namespace|ingress|access|account|certificate|domain|database|pipeline|deployment/i;
const ENVIRONMENT_SENSITIVE_RE = /网关|路由|集群|命名空间|入口|流水线|部署|gateway|route|cluster|namespace|ingress|pipeline|deployment/i;
const ENVIRONMENT_RE = /生产|测试|开发|预发|灾备|\b(?:prod|production|qa|uat|test|dev|development|staging|dr)\b/i;
const SRE_OWNER_RE = /\bSRE\b|运维|平台团队|platform team/i;

function flattenText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(flattenText).filter(Boolean).join(" ");
  if (typeof value === "object") return Object.values(value).map(flattenText).filter(Boolean).join(" ");
  return "";
}

function mappedSlot(field, fieldMappings) {
  for (const [slot, selectors] of Object.entries(fieldMappings || {})) {
    if ((selectors || []).some((selector) => selector === field.id || selector === field.name)) return slot;
  }
  return SEMANTIC_CUSTOM_FIELD_RE.test(field.name || "") ? field.name : "";
}

function sourceRecords(issue, fieldMappings = {}) {
  const comments = issue.comments || [];
  const records = [
    {source: "jira.summary", kind: "content", text: issue.ticket?.summary || "", weight: 2},
    {source: "jira.description", kind: "content", text: issue.ticket?.description_markdown || "", weight: 3},
  ];
  comments.forEach((comment, index) => {
    records.push({
      source: `jira.comment:${comment.id || index + 1}`,
      kind: "content",
      text: comment.body_markdown || "",
      weight: index === comments.length - 1 ? 4 : 2,
      latest: index === comments.length - 1,
    });
  });
  for (const field of issue.custom_fields || []) {
    const slot = mappedSlot(field, fieldMappings);
    if (!slot) continue;
    records.push({
      source: `jira.custom_field:${slot}`,
      kind: "metadata",
      text: flattenText(field.value),
      weight: 1,
    });
  }
  return records.filter((record) => record.text.trim());
}

function findSignal(definitions, text) {
  return definitions.find((definition) => definition.pattern.test(text));
}

function signalRecord(route, record, definition) {
  return {
    source: record.source,
    signal: definition.signal,
    summary: route === "problem_investigation"
      ? "Current Jira text describes an investigation request or unexpected behavior."
      : "Current Jira text describes an explicit action or desired target state.",
    score: record.weight + definition.strength - 1,
    content_signal: record.kind === "content",
  };
}

function classifySignals(issue, fieldMappings) {
  const records = sourceRecords(issue, fieldMappings);
  const signals = {problem_investigation: [], request_fulfillment: []};
  for (const record of records) {
    const troubleshooting = findSignal(TROUBLESHOOTING_SIGNALS, record.text);
    const fulfillment = findSignal(FULFILLMENT_SIGNALS, record.text);
    if (troubleshooting) signals.problem_investigation.push(signalRecord("problem_investigation", record, troubleshooting));
    if (fulfillment) signals.request_fulfillment.push(signalRecord("request_fulfillment", record, fulfillment));
  }

  const issueType = issue.ticket?.issue_type || "";
  if (TROUBLESHOOTING_ISSUE_TYPE_RE.test(issueType)) {
    signals.problem_investigation.push({
      source: "jira.issue_type",
      signal: "troubleshooting_issue_type",
      summary: "The Jira issue type is an auxiliary troubleshooting signal.",
      score: 1,
      content_signal: false,
    });
  }
  if (FULFILLMENT_ISSUE_TYPE_RE.test(issueType)) {
    signals.request_fulfillment.push({
      source: "jira.issue_type",
      signal: "fulfillment_issue_type",
      summary: "The Jira issue type is an auxiliary fulfillment signal.",
      score: 1,
      content_signal: false,
    });
  }
  for (const record of records.filter((item) => item.kind === "metadata" && !item.source.endsWith(":environment"))) {
    if (TROUBLESHOOTING_ISSUE_TYPE_RE.test(record.text)) {
      signals.problem_investigation.push({
        source: record.source,
        signal: "mapped_troubleshooting_category",
        summary: "A mapped Jira semantic field is an auxiliary troubleshooting signal.",
        score: 1,
        content_signal: false,
      });
    }
    if (FULFILLMENT_ISSUE_TYPE_RE.test(record.text)) {
      signals.request_fulfillment.push({
        source: record.source,
        signal: "mapped_fulfillment_category",
        summary: "A mapped Jira semantic field is an auxiliary fulfillment signal.",
        score: 1,
        content_signal: false,
      });
    }
  }
  return {records, signals};
}

function totalScore(items) {
  return items.reduce((sum, item) => sum + item.score, 0);
}

function hasContentSignal(items) {
  return items.some((item) => item.content_signal);
}

function chooseIntent(issue, records, signals) {
  const troubleshootingScore = totalScore(signals.problem_investigation);
  const fulfillmentScore = totalScore(signals.request_fulfillment);
  const troubleshootingContent = hasContentSignal(signals.problem_investigation);
  const fulfillmentContent = hasContentSignal(signals.request_fulfillment);
  const latestComment = [...records].reverse().find((record) => record.latest);

  if (latestComment && SUPPRESS_TROUBLESHOOTING_RE.test(latestComment.text) && findSignal(FULFILLMENT_SIGNALS, latestComment.text)) {
    return {work_intent: "request_fulfillment", confidence: "high"};
  }
  if (latestComment && SUPPRESS_FULFILLMENT_RE.test(latestComment.text) && findSignal(TROUBLESHOOTING_SIGNALS, latestComment.text)) {
    return {work_intent: "problem_investigation", confidence: "high"};
  }
  if (troubleshootingContent && fulfillmentContent) {
    if (Math.abs(troubleshootingScore - fulfillmentScore) >= 4) {
      return troubleshootingScore > fulfillmentScore
        ? {work_intent: "problem_investigation", confidence: "medium"}
        : {work_intent: "request_fulfillment", confidence: "medium"};
    }
    return {work_intent: "mixed", confidence: "medium"};
  }
  if (troubleshootingContent) {
    return {work_intent: "problem_investigation", confidence: fulfillmentScore ? "medium" : troubleshootingScore >= 4 ? "high" : "medium"};
  }
  if (fulfillmentContent) {
    return {work_intent: "request_fulfillment", confidence: troubleshootingScore ? "medium" : fulfillmentScore >= 4 ? "high" : "medium"};
  }
  return {work_intent: "unclear", confidence: "low"};
}

function pendingConfirmations(issue, workIntent, records) {
  const text = records.map((record) => record.text).join("\n");
  const pending = [];
  if (workIntent === "unclear") {
    pending.push({
      kind: "requester_input",
      item: "Confirm whether the desired outcome is investigation of an unexpected behavior or implementation of a target state.",
      question: "请确认希望我们排查当前异常原因，还是由 SRE 按目标状态实施需求？",
    });
    return pending;
  }
  if (!["request_fulfillment", "mixed"].includes(workIntent)) return pending;

  const hasTarget = (issue.ticket?.components || []).length > 0 || TARGET_RE.test(text);
  const needsEnvironment = ENVIRONMENT_SENSITIVE_RE.test(text);
  const hasEnvironment = Boolean(issue.ticket?.environment) || ENVIRONMENT_RE.test(text);
  if (!hasTarget) {
    pending.push({
      kind: "requester_input",
      item: "The target resource or service is not specific enough to build an implementation plan.",
      question: "请补充需要变更的具体服务或资源标识。",
    });
  }
  if (needsEnvironment && !hasEnvironment) {
    pending.push({
      kind: "requester_input",
      item: "The target environment is required to scope the change and rollback.",
      question: "请补充目标环境（例如生产、测试或预发）。",
    });
  }
  pending.push({
    kind: "sre_precheck",
    item: "Confirm the current target resource, effective configuration, product/version, and control point before implementation.",
  });
  pending.push({
    kind: "approval_input",
    item: "Confirm the change approval, window, rollback owner, and affected scope before any production action.",
  });
  if (workIntent === "mixed") {
    pending.push({
      kind: "evidence_gap",
      item: "Confirm the causal evidence needed to determine whether the requested change depends on the unresolved problem.",
    });
  }
  return pending;
}

export function assessIntent(issue, fieldMappings = {}) {
  const {records, signals} = classifySignals(issue, fieldMappings);
  const decision = chooseIntent(issue, records, signals);
  const pending = pendingConfirmations(issue, decision.work_intent, records);
  const requesterInput = pending.some((item) => item.kind === "requester_input");
  const supportingSignals = decision.work_intent === "mixed"
    ? [...signals.problem_investigation, ...signals.request_fulfillment]
    : signals[decision.work_intent] || [];
  const counterSignals = decision.work_intent === "problem_investigation"
    ? signals.request_fulfillment
    : decision.work_intent === "request_fulfillment"
      ? signals.problem_investigation
      : [];

  let planningStatus = "blocked";
  if (decision.work_intent === "request_fulfillment") planningStatus = requesterInput ? "needs_requester_input" : "needs_sre_current_state";
  else if (decision.work_intent === "unclear") planningStatus = "needs_requester_input";

  return {
    schema_version: "l05-intent/v1",
    work_intent: decision.work_intent,
    delivery_mode: ["request_fulfillment", "mixed"].includes(decision.work_intent) ? "human_runbook" : "answer_only",
    confidence: decision.confidence,
    execution_owner: SRE_OWNER_RE.test(records.map((record) => record.text).join("\n")) ? "sre" : "unknown",
    planning_status: planningStatus,
    execution_status: "not_executed",
    supporting_signals: supportingSignals.map(({score, content_signal, ...item}) => item),
    counter_signals: counterSignals.map(({score, content_signal, ...item}) => item),
    pending_confirmations: pending,
    missing_inputs: pending.map((item) => item.item),
  };
}
