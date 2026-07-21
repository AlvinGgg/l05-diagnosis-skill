const RESOLVED_STATUS = /^(?:resolved|closed|done|completed|完成|已解决|已关闭)$/i;
const CANCELED = /cancel(?:ed|led)|duplicate|won['’]?t do|取消|重复|不处理/i;
const BOT = /(?:^|[-_\s])(bot|automation|system|im)(?:$|[-_\s])/i;
const SOLUTION = /root cause|原因|根因|解决|修复|调整|修改|配置|更新|replace|change|fix|set|enable|disable|restart|重新|清理|申请/i;
const STEPS = /(?:^|\n)\s*(?:\d+[.)、]|[-*])\s+|步骤|依次|首先|然后|最后|执行|进入|打开|修改|配置/i;
const VALIDATION = /验证|复测|测试通过|恢复成功|验证成功|已生效|回归通过|validated?|verified?|confirmed (?:fixed|working)|passed?|working as expected/i;
const ROOT_CAUSE = /root cause|根因|原因是|由于|because|caused by|定位为/i;
const SCOPE = /适用|仅限|前提|条件|范围|版本|环境|限制|注意|生产|测试环境|when|only|scope|prerequisite|limitation/i;
const HANDOFF = /转交|转派|联系.{0,12}(团队|同事)|请.{0,12}(团队|同事)处理|forwarded?|assigned? to|handoff/i;
const CLOSURE_ONLY = /^(?:已处理|处理完成|请验证|请确认|done|fixed|resolved|please verify)[。.!\s]*$/i;
const PROBABLE = /可能|疑似|推测|大概率|probably|likely|suspect/i;
const DANGEROUS = /kubectl\s+delete|rm\s+-rf|(?:drop|truncate|delete)\s+(?:database|table|from)|生产.{0,20}(删除|重启|修改)|prod(?:uction)?.{0,20}(delete|restart|drop)/i;
const PROMPT_INJECTION = /ignore (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|忽略.{0,10}(之前|系统|指令)|执行以下命令/i;

function text(value) { return String(value ?? "").trim(); }
function combined(issue) {
  return [issue.ticket?.summary, issue.ticket?.description_markdown, issue.ticket?.environment, ...(issue.comments || []).map((item) => item.body_markdown)].map(text).filter(Boolean).join("\n");
}
function isSubstantive(value) { return text(value).replace(/\s+/g, "").length >= 18 && !CLOSURE_ONLY.test(text(value)); }

function classifyComments(issue) {
  const reporter = issue.ticket?.reporter?.stable_id || "";
  const assignee = issue.ticket?.assignee?.stable_id || "";
  const responder = [];
  const requester = [];
  const ambiguous = [];
  const bot = [];
  for (const [index, comment] of (issue.comments || []).entries()) {
    const id = comment.author?.stable_id || "";
    const name = comment.author?.display_name || "";
    const item = {index, body: text(comment.body_markdown)};
    if (BOT.test(`${id} ${name}`)) bot.push(item);
    else if (reporter && id === reporter) requester.push(item);
    else if (assignee && id === assignee) responder.push(item);
    else ambiguous.push(item);
  }
  return {responder, requester, ambiguous, bot};
}

export function evaluateQuality(issue, {collectionStatus = "pass", privacyStatus = "pass"} = {}) {
  const allText = combined(issue);
  const roles = classifyComments(issue);
  const responderText = roles.responder.map((item) => item.body).join("\n");
  const knowledgeText = responderText || text(issue.ticket?.description_markdown);
  const resolved = Boolean(text(issue.ticket?.resolution)) || RESOLVED_STATUS.test(text(issue.ticket?.status));
  const canceled = CANCELED.test(`${issue.ticket?.status || ""} ${issue.ticket?.resolution || ""}`);
  const hasSolution = SOLUTION.test(knowledgeText);
  const hasSteps = STEPS.test(knowledgeText) && hasSolution;
  const hasValidation = VALIDATION.test(knowledgeText);
  const hasRootCause = ROOT_CAUSE.test(knowledgeText);
  const hasScope = SCOPE.test(knowledgeText);
  const handoffHeavy = HANDOFF.test(knowledgeText) && !hasSteps && !hasRootCause;
  const dangerous = DANGEROUS.test(knowledgeText);
  const promptInjection = PROMPT_INJECTION.test(allText);
  const probable = PROBABLE.test(knowledgeText) && !hasValidation;
  const substantiveResponders = roles.responder.filter((item) => isSubstantive(item.body));

  const resolutionTags = [];
  let score = 0;
  if (resolved && (hasSolution || hasRootCause)) { score += 30; resolutionTags.push("has_resolution_signal"); }
  else if (hasSolution || hasRootCause) { score += 20; resolutionTags.push("has_partial_resolution_signal"); }
  else if (resolved) { score += 10; resolutionTags.push("weak_closure_signal"); }
  else resolutionTags.push("no_resolution_signal");

  if (hasSteps) { score += 25; resolutionTags.push("has_solution_steps"); }
  else if (hasSolution) { score += 15; resolutionTags.push("partial_solution_steps"); }
  else resolutionTags.push("no_solution_steps");

  if (hasValidation) { score += 15; resolutionTags.push("has_validation"); }
  else if (resolved) { score += 5; resolutionTags.push("no_validation"); }
  else resolutionTags.push("no_validation");

  if (substantiveResponders.length) { score += 10; resolutionTags.push("substantive_responder_content"); }
  else if (isSubstantive(issue.ticket?.description_markdown) && hasSolution) { score += 5; resolutionTags.push("solution_in_issue_body_only"); }
  else resolutionTags.push(roles.responder.length ? "insufficient_responder_content" : "no_identified_responder_content");

  if (!dangerous && privacyStatus === "pass") score += 10;
  else resolutionTags.push(dangerous ? "high_risk_execution_detail" : "sensitive_content");

  if (hasRootCause && hasScope) { score += 10; resolutionTags.push("clear_reasoning_and_scope"); }
  else if (hasRootCause) { score += 7; resolutionTags.push("has_root_cause"); }
  else if (hasScope) { score += 4; resolutionTags.push("has_scope"); }
  else resolutionTags.push("weak_explanation");

  if (roles.ambiguous.some((item) => isSubstantive(item.body))) resolutionTags.push("ambiguous_comment_role");
  if (roles.bot.length) resolutionTags.push("bot_noise_excluded");
  if (handoffHeavy) resolutionTags.push("handoff_only");
  if (probable) resolutionTags.push("unverified_root_cause");
  if (promptInjection) resolutionTags.push("prompt_injection_ignored");
  if (canceled) resolutionTags.push("canceled_or_duplicate");
  if (collectionStatus === "partial") resolutionTags.push("collection_partial_cap");

  if (roles.ambiguous.some((item) => isSubstantive(item.body)) || collectionStatus === "partial" || !resolved || probable || !hasValidation) score = Math.min(score, 84);
  if (dangerous || handoffHeavy) score = Math.min(score, 69);
  if (canceled) score = Math.min(score, 49);
  score = Math.max(0, Math.min(100, score));
  const level = score >= 85 ? "high" : score >= 70 ? "medium" : score >= 50 ? "low" : "failed";

  const knowledgeTags = [];
  let knowledgeScore = 0;
  if (resolved && !canceled) { knowledgeScore += 2; knowledgeTags.push("clear_closure"); }
  if (hasSteps) { knowledgeScore += 2; knowledgeTags.push("reusable_procedure"); }
  if (substantiveResponders.length >= 1 && [issue.ticket?.description_markdown, ...substantiveResponders.map((item) => item.body)].filter(isSubstantive).length >= 2) { knowledgeScore += 1; knowledgeTags.push("multiple_evidence_points"); }
  if (privacyStatus === "pass" && allText.replace(/\s+/g, "").length >= 80) { knowledgeScore += 1; knowledgeTags.push("context_survives_redaction"); }
  if (hasValidation) { knowledgeScore += 1; knowledgeTags.push("validated_outcome"); }
  if (hasScope) { knowledgeScore += 1; knowledgeTags.push("clear_scope"); }
  if (Array.isArray(issue.provenance) && issue.provenance.length >= 2) { knowledgeScore += 1; knowledgeTags.push("complete_provenance"); }
  if (dangerous) { knowledgeScore -= 2; knowledgeTags.push("high_risk_execution_detail"); }
  if (handoffHeavy) { knowledgeScore -= 1; knowledgeTags.push("handoff_heavy"); }
  if (privacyStatus !== "pass") { knowledgeScore -= 1; knowledgeTags.push("redaction_required"); }
  if (/临时|一次性|temporary|one[- ]off|找.{0,8}(某人|同事)/i.test(knowledgeText)) { knowledgeScore -= 1; knowledgeTags.push("one_off_dependency"); }
  if (promptInjection) knowledgeTags.push("prompt_injection_ignored");
  if (canceled) knowledgeTags.push("canceled_or_duplicate");
  knowledgeScore = Math.max(0, Math.min(9, knowledgeScore));
  const confidence = knowledgeScore >= 7 ? "high" : knowledgeScore >= 4 ? "medium" : "excluded";

  const evidencePointers = [];
  if (issue.ticket?.resolution) evidencePointers.push("issue.normalized.json#ticket.resolution");
  if (issue.ticket?.description_markdown) evidencePointers.push("issue.normalized.json#ticket.description_markdown");
  for (const item of substantiveResponders) evidencePointers.push(`issue.normalized.json#comments[${item.index}]`);

  return {
    resolution_quality: {score, level, tags: [...new Set(resolutionTags)].sort()},
    knowledge_value: {score: knowledgeScore, confidence, tags: [...new Set(knowledgeTags)].sort()},
    facts: {resolved, canceled, dangerous, handoff_heavy: handoffHeavy, prompt_injection: promptInjection, probable_diagnosis: probable},
    evidence_pointers: evidencePointers,
  };
}

export function decide({collectionGate, privacyGate, quality}) {
  const reasons = [];
  if (collectionGate.status === "blocked" || privacyGate.status === "blocked") {
    reasons.push(...collectionGate.tags, ...privacyGate.tags);
    return {decision: "blocked", source_status: null, reasons: [...new Set(reasons)].sort()};
  }
  const {resolution_quality: resolution, knowledge_value: knowledge, facts} = quality;
  if (facts.canceled) return {decision: "reject_low_knowledge_value", source_status: null, reasons: ["canceled_or_duplicate"]};
  if (!facts.resolved || facts.probable_diagnosis) return {decision: "hold_remediation", source_status: null, reasons: [facts.probable_diagnosis ? "unverified_root_cause" : "unresolved"]};
  if (facts.dangerous || facts.handoff_heavy || resolution.score < 70) return {decision: "hold_remediation", source_status: null, reasons: resolution.tags.filter((tag) => ["high_risk_execution_detail", "handoff_only", "no_solution_steps", "no_validation"].includes(tag))};
  if (resolution.score >= 85 && knowledge.score >= 7 && collectionGate.status === "pass") return {decision: "promote_active", source_status: "active", reasons: []};
  if (resolution.score >= 70 && knowledge.score >= 4) return {decision: "promote_needs_review", source_status: "needs-review", reasons: collectionGate.status === "partial" ? collectionGate.tags : []};
  if (resolution.score >= 85 && knowledge.score < 7) return {decision: "hold_not_reusable", source_status: null, reasons: ["knowledge_value_below_active_threshold"]};
  if (knowledge.score < 4) return {decision: "reject_low_knowledge_value", source_status: null, reasons: ["knowledge_value_below_minimum"]};
  return {decision: "hold_remediation", source_status: null, reasons: ["resolution_quality_below_promotion_threshold"]};
}
