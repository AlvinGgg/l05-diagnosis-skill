import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {
  discoverProviderManifests,
  inferProblemType,
  invokeProvider,
  loadProfile,
  profileProviderEntries,
} from "./provider-loader.mjs";

const execFileAsync = promisify(execFile);
const PLAN_SCHEMA = "l05-evidence-plan/v1";
const REQUEST_SCHEMA = "l05-provider-request/v1";
const TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FORBIDDEN_KEY = /^(?:url|host|server|endpoint|headers?|method|body|query|logql|regex|parser|tls|proxy|retry|concurrency)$/i;
const ROLE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TARGET_ROLES = new Set([
  "primary-application",
  "gateway-access",
  "gateway-plugin",
  "api-management",
  "service-discovery",
  "config-service",
  "upstream",
  "downstream",
]);
const AUTOMATION_AUTHOR = /(?:bot|automation|stackstorm|opsagent|no[-_ ]?reply|noreply|\bim\b|system)/i;
const CORE_BUDGET_CEILINGS = {
  max_log_queries: 13,
  max_tenants: 4,
  max_scan_bytes: 64 * 1024 * 1024,
  max_entries: 200,
};
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

function exactObject(value, allowed) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key) && !FORBIDDEN_KEY.test(key));
}

function safeStrings(value, maximum, length) {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every((item) => typeof item === "string" && item.trim() && item.length <= length && !/[\r\n\0]/.test(item));
}

function parseTimestamp(value) {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function validateEvidencePlan(value) {
  const errors = [];
  const top = new Set(["schema_version", "case_id", "evidence_question", "cluster_alias", "time_anchor", "targets", "budget"]);
  if (!exactObject(value, top) || value.schema_version !== PLAN_SCHEMA) return {valid: false, errors: ["evidence_plan_invalid"]};
  if (typeof value.case_id !== "string" || !value.case_id.trim() || value.case_id.length > 128) errors.push("case_id_invalid");
  if (typeof value.evidence_question !== "string" || !value.evidence_question.trim() || value.evidence_question.length > 300 || /ignore previous|system prompt/i.test(value.evidence_question)) errors.push("evidence_question_invalid");
  if (typeof value.cluster_alias !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.cluster_alias)) errors.push("cluster_alias_invalid");
  const anchor = value.time_anchor;
  if (!exactObject(anchor, new Set(["start", "end", "source"]))) errors.push("time_anchor_invalid");
  else {
    const start = parseTimestamp(anchor.start);
    const end = parseTimestamp(anchor.end);
    const hasAggregation = Array.isArray(value.targets) && value.targets.some((target) => target?.aggregation !== undefined);
    const maximum = hasAggregation ? 3_600_000 : 300_000;
    if (start === null || end === null || end <= start || end - start > maximum || typeof anchor.source !== "string") errors.push("time_anchor_invalid");
  }
  if (!Array.isArray(value.targets) || !value.targets.length || value.targets.length > 4) errors.push("targets_invalid");
  else value.targets.forEach((target, index) => {
    const allowed = new Set(["target_id", "role", "application", "kubernetes_target", "filters", "limit", "triggered_by", "correlation_from", "aggregation", "log_identity"]);
    if (!exactObject(target, allowed)) {
      errors.push(`target_${index}_invalid`);
      return;
    }
    if (!ID_PATTERN.test(target.target_id || "") || !ROLE_PATTERN.test(target.role || "") || !TARGET_ROLES.has(target.role)) errors.push(`target_${index}_identity_invalid`);
    const hasApplication = typeof target.application === "string";
    const hasKubernetesTarget = target.kubernetes_target !== undefined;
    if (hasApplication === hasKubernetesTarget) errors.push(`target_${index}_source_invalid`);
    if (hasApplication && (!TENANT_PATTERN.test(target.application) || [".", ".."].includes(target.application))) errors.push(`target_${index}_application_invalid`);
    if (hasKubernetesTarget) {
      const resource = target.kubernetes_target;
      if (!exactObject(resource, new Set(["kind", "name"])) || !["Deployment", "StatefulSet", "DaemonSet", "Job", "Pod", "Service", "Ingress"].includes(resource.kind) || !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(resource.name || "")) errors.push(`target_${index}_kubernetes_target_invalid`);
    }
    if (target.log_identity !== undefined && (
      !exactObject(target.log_identity, new Set(["value", "source"]))
      || typeof target.log_identity.value !== "string"
      || !target.log_identity.value.trim()
      || target.log_identity.value.length > 256
      || /[\r\n\0]/.test(target.log_identity.value)
      || typeof target.log_identity.source !== "string"
      || !/^[a-z][a-z0-9._-]{0,63}$/.test(target.log_identity.source)
    )) errors.push(`target_${index}_log_identity_invalid`);
    const filters = target.filters;
    if (!exactObject(filters, new Set(["exact_terms", "fuzzy_terms", "error_only"]))
      || !safeStrings(filters.exact_terms || [], 4, 256)
      || !safeStrings(filters.fuzzy_terms || [], 2, 96)
      || (filters.error_only !== undefined && typeof filters.error_only !== "boolean")) errors.push(`target_${index}_filters_invalid`);
    else {
      const hasTerms = (filters.exact_terms || []).length || (filters.fuzzy_terms || []).length;
      const start = parseTimestamp(value.time_anchor?.start);
      const end = parseTimestamp(value.time_anchor?.end);
      if (!hasTerms && !target.correlation_from && target.aggregation === undefined
        && ((end ?? 0) - (start ?? 0) > 60_000 || target.limit > 5)) errors.push(`target_${index}_line_filter_missing`);
    }
    if (target.aggregation !== undefined && (
      !exactObject(target.aggregation, new Set(["kind", "status_code", "top_k"]))
      || target.aggregation.kind !== "topk-api-status"
      || !Number.isInteger(target.aggregation.status_code)
      || target.aggregation.status_code < 100
      || target.aggregation.status_code > 599
      || !Number.isInteger(target.aggregation.top_k)
      || target.aggregation.top_k < 1
      || target.aggregation.top_k > 10
    )) errors.push(`target_${index}_aggregation_invalid`);
    if (!Number.isInteger(target.limit) || target.limit <= 0 || target.limit > 100) errors.push(`target_${index}_limit_invalid`);
    if (!safeStrings(target.triggered_by, 8, 160) || !target.triggered_by.length) errors.push(`target_${index}_trigger_invalid`);
    if (target.correlation_from !== undefined) {
      const priorIds = value.targets.slice(0, index).map((item) => item?.target_id);
      if (!ID_PATTERN.test(target.correlation_from) || !priorIds.includes(target.correlation_from)) {
        errors.push(`target_${index}_correlation_invalid`);
      }
    }
  });
  const aggregationTargets = Array.isArray(value.targets)
    ? value.targets.filter((target) => target?.aggregation !== undefined)
    : [];
  if (aggregationTargets.length && value.targets.length !== 1) errors.push("aggregation_target_ambiguous");
  const budget = value.budget || {};
  if (!exactObject(budget, new Set(Object.keys(CORE_BUDGET_CEILINGS)))) errors.push("budget_invalid");
  else for (const [key, ceiling] of Object.entries(CORE_BUDGET_CEILINGS)) {
    const amount = budget[key] ?? ceiling;
    if (!Number.isInteger(amount) || amount <= 0 || amount > ceiling) errors.push(`budget_${key}_invalid`);
  }
  return {
    valid: errors.length === 0,
    errors,
    plan: errors.length ? null : structuredClone(value),
  };
}

function profileEntry(entries, providerId) {
  const matches = entries.filter((entry) => entry?.provider_id === providerId && entry.enabled !== false);
  return matches.length === 1 ? matches[0] : null;
}

export function resolveKubectlCluster(routes, signal) {
  if (!Array.isArray(routes)) return {status: "missing", route: null, cluster_ref: null};
  const folded = String(signal || "").toLowerCase();
  const matches = routes.filter((route) =>
    route && typeof route === "object"
    && typeof route.cluster_alias === "string"
    && Array.isArray(route.match?.keywords)
    && route.match.keywords.some((value) => typeof value === "string" && value.toLowerCase() === folded));
  if (!matches.length) return {status: "missing", route: null, cluster_ref: null};
  if (matches.length > 1) return {status: "ambiguous", route: null, cluster_ref: null};
  return {status: "matched", route: matches[0], cluster_ref: matches[0].cluster_alias};
}

export function resolveLokiGateway(gateways, clusterRef) {
  if (!Array.isArray(gateways)) return {status: "missing", gateway: null};
  const matches = gateways.filter((gateway) =>
    gateway && typeof gateway === "object" && gateway.cluster_ref === clusterRef);
  if (!matches.length) return {status: "missing", gateway: null};
  if (matches.length > 1) return {status: "ambiguous", gateway: null};
  return {status: "matched", gateway: matches[0]};
}

export function resolveComponentPlacement(placements, component, environmentSignal, routes) {
  if (!Array.isArray(placements)) return {status: "missing", placement: null, cluster_ref: null};
  const foldedComponent = String(component || "").toLowerCase();
  const foldedSignal = String(environmentSignal || "").toLowerCase();
  const componentPlacements = placements.filter((placement) =>
    placement && typeof placement === "object"
    && String(placement.component || "").toLowerCase() === foldedComponent);
  const candidates = componentPlacements.filter((placement) =>
    String(placement.cluster_ref || "").toLowerCase() === foldedSignal
    || (Array.isArray(placement.environment_keywords)
      && placement.environment_keywords.some((keyword) => String(keyword).toLowerCase() === foldedSignal)));
  if (!candidates.length) return {status: "missing", placement: null, cluster_ref: null};
  if (candidates.length > 1) return {status: "ambiguous", placement: null, cluster_ref: null};
  const route = resolveKubectlCluster(routes, environmentSignal);
  if (route.status === "matched" && route.cluster_ref !== candidates[0].cluster_ref) {
    return {status: "conflict", placement: null, cluster_ref: null};
  }
  return {status: "matched", placement: candidates[0], cluster_ref: candidates[0].cluster_ref};
}

function issueProjection(issue) {
  return {
    source: issue.source,
    ticket: issue.ticket,
    custom_fields: issue.custom_fields || [],
    comments: (issue.comments || []).filter((item) =>
      !AUTOMATION_AUTHOR.test(`${item.author?.display_name || ""} ${item.author?.stable_id || ""}`),
    ),
    links: issue.links || [],
  };
}

function requestValue(providerId, capabilities, issue, context, config) {
  return {
    schema_version: REQUEST_SCHEMA,
    request_id: `${issue.source?.issue_key || "issue"}-${Date.now()}`,
    provider_id: providerId,
    capabilities,
    issue: issueProjection(issue),
    context,
    config,
  };
}

function extractRecord(response, capability) {
  const records = (response?.evidence_records || []).filter((record) => record?.capability === capability);
  return records.length === 1 ? records[0] : null;
}

function responseHasGap(response, gap) {
  return (response?.gaps || []).includes(gap);
}

function appendLokiInspectionSteps(steps, response, targets, gatewaySource, includeHealth) {
  if (includeHealth) {
    const record = extractRecord(response, "loki.gateway.health");
    steps.push({
      status: record ? "completed" : response.status === "partial" ? "partial" : "failed",
      capability: "loki.gateway.health",
      target: "gateway",
      gateway_source: gatewaySource,
      result: record?.summary || response.gaps?.join(",") || response.status,
    });
  }
  const aggregationTarget = targets.find((target) => target.aggregation);
  const aggregation = extractRecord(response, "loki.logs.topk_api_status");
  if (aggregationTarget) {
    const resolution = (response.evidence_records || []).find(
      (record) => record?.capability === "loki.stream.selector.resolve"
        && record?.data?.target_id === aggregationTarget.target_id,
    );
    steps.push({
      status: resolution?.data?.selected_label ? "completed" : resolution ? "completed_no_match" : "failed",
      capability: "loki.stream.selector.resolve",
      target: aggregationTarget.target_id,
      gateway_source: gatewaySource,
      result: resolution?.summary || response.gaps?.join(",") || response.status,
    });
    steps.push({
      status: aggregation?.data?.complete ? "completed" : response.status === "partial" ? "partial" : "failed",
      capability: "loki.logs.topk_api_status",
      target: aggregation?.data?.target_id || aggregationTarget.target_id,
      gateway_source: gatewaySource,
      result: aggregation?.summary || response.gaps?.join(",") || response.status,
    });
    return;
  }
  for (const target of targets) {
    for (const capability of ["loki.stream.selector.resolve", "loki.index.stats", "loki.logs.query_excerpt"]) {
      const records = (response.evidence_records || []).filter(
        (record) => record?.capability === capability && record?.data?.target_id === target.target_id,
      );
      const record = records.length === 1 ? records[0] : null;
      steps.push({
        status: capability === "loki.stream.selector.resolve" && record && !record.data?.selected_label
          ? "completed_no_match"
          : record ? "completed" : response.status === "partial" ? "partial" : "failed",
        capability,
        target: target.target_id,
        gateway_source: gatewaySource,
        result: record?.summary || response.gaps?.find((gap) => gap.endsWith(`:${target.target_id}`)) || response.status,
      });
    }
  }
}

function safeReconciliationResult(value) {
  if (!value || typeof value !== "object") return value;
  const {backup, ...safe} = value;
  return {...safe, backup_created: Boolean(backup)};
}

async function applyGatewayReconciliation({kbRoot, evidence, apply}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "l05-loki-reconcile-"));
  const evidenceFile = path.join(temporary, "evidence.json");
  fs.writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, {mode: 0o600});
  const args = [
    path.join(SCRIPT_DIR, "l05_profile.py"),
    "reconcile-loki-gateway",
    "--vault",
    path.resolve(kbRoot),
    "--evidence-file",
    evidenceFile,
    ...(apply ? ["--apply"] : []),
  ];
  try {
    const {stdout} = await execFileAsync("python3", args, {maxBuffer: 1024 * 1024});
    return safeReconciliationResult(JSON.parse(stdout));
  } catch (error) {
    try {
      return safeReconciliationResult(JSON.parse(error.stdout || ""));
    } catch {
      return {status: "blocked", reason: "gateway_profile_update_failed"};
    }
  } finally {
    fs.rmSync(temporary, {recursive: true, force: true});
  }
}

function budgetFromPlan(plan) {
  return Object.fromEntries(
    Object.entries(CORE_BUDGET_CEILINGS).map(([key, ceiling]) => [key, plan.budget?.[key] ?? ceiling]),
  );
}

function consumeBudget(ledger, response) {
  ledger.log_queries += (response.evidence_records || []).reduce((count, record) => {
    if (record.capability === "loki.logs.query_excerpt") return count + 1;
    if (record.capability === "loki.logs.topk_api_status") return count + (record.data?.completed_partitions || 0);
    return count;
  }, 0);
  for (const record of response.evidence_records || []) {
    if (!["loki.logs.query_excerpt", "loki.logs.topk_api_status"].includes(record.capability)) continue;
    const data = record.data || {};
    const bytes = record.capability === "loki.logs.topk_api_status"
      ? data.scan?.actual_bytes_processed
      : data.stats?.totalBytesProcessed;
    if (Number.isFinite(bytes)) ledger.scan_bytes += bytes;
    const entries = record.capability === "loki.logs.topk_api_status" ? data.top_k?.length : data.entry_count;
    if (Number.isInteger(entries)) ledger.entries += entries;
  }
}

async function resolveApplication({target, issue, problemType, clusterRef, kubectlEntry, kubectlManifest, timeoutMs, env}) {
  if (target.application) return {application: target.application, response: null};
  if (!kubectlEntry || !kubectlManifest) return {application: null, response: null, gap: "kubectl_provider_not_available"};
  const response = await invokeProvider(
    kubectlManifest,
    requestValue(
      "kubectl",
      ["k8s.application.identity"],
      issue,
      {problem_type: problemType, resolved_cluster_ref: clusterRef, application_target: target.kubernetes_target},
      kubectlEntry.config || {},
    ),
    {timeoutMs, env},
  );
  const record = extractRecord(response, "k8s.application.identity");
  const application = record?.data?.application;
  if (!TENANT_PATTERN.test(application || "")) return {application: null, response, gap: "application_unresolved"};
  return {application, response};
}

async function discoverGateway({issue, problemType, clusterRef, kubectlEntry, kubectlManifest, timeoutMs, env}) {
  if (!kubectlEntry || !kubectlManifest) return {gap: "gateway_discovery_blocked"};
  const response = await invokeProvider(
    kubectlManifest,
    requestValue(
      "kubectl",
      ["k8s.loki_gateway.resolve"],
      issue,
      {problem_type: problemType, resolved_cluster_ref: clusterRef},
      kubectlEntry.config || {},
    ),
    {timeoutMs, env},
  );
  const record = extractRecord(response, "k8s.loki_gateway.resolve");
  const data = record?.data;
  if (!data) {
    return {response, gap: response.gaps?.[0] || "gateway_candidate_invalid"};
  }
  if (
    !ID_PATTERN.test(data.cluster_alias || "")
    || data.cluster_alias !== clusterRef
  ) return {response, gap: "gateway_candidate_invalid"};
  return {response, record, data};
}

async function healthCandidate({issue, problemType, data, application, tenant, timeAnchor, lokiManifest, timeoutMs, env}) {
  const probeEnd = Date.parse(timeAnchor.end);
  const probeStart = Math.max(Date.parse(timeAnchor.start), probeEnd - 60_000);
  const context = {
    problem_type: problemType,
    resolved_cluster: {
      cluster_alias: data.cluster_alias,
      gateway_source: "kubectl_candidate",
    },
    gateway_candidate: {
      provider_id: "kubectl",
      capability: "k8s.loki_gateway.resolve",
      cluster_alias: data.cluster_alias,
      rule_host: data.rule_host,
      tls_host_match: data.tls_host_match,
      resource_version: data.resource_version,
      ingress_uid_fingerprint: data.ingress_uid_fingerprint,
    },
    gateway_probe: {
      schema_version: "l05-gateway-health-probe/v1",
      application: tenant || application,
      tenant_id: tenant || application,
      time_anchor: {
        start: new Date(probeStart).toISOString(),
        end: new Date(probeEnd).toISOString(),
      },
    },
  };
  return invokeProvider(
    lokiManifest,
    requestValue(
      "loki",
      ["loki.gateway.health"],
      issue,
      context,
      {
        gateways: [{
          cluster_ref: data.cluster_alias,
          gateway_url: `https://${data.rule_host}`,
        }],
      },
    ),
    {timeoutMs, env},
  );
}

export async function executeEvidencePlan({
  kbRoot,
  issue,
  evidencePlan,
  providerDir,
  timeoutMs,
  env = process.env,
  authorizeProfileUpdate = false,
}) {
  const validation = validateEvidencePlan(evidencePlan);
  if (!validation.valid) {
    return {status: "blocked", responses: [], gaps: validation.errors, inspection_steps: [], budget: null};
  }
  const plan = validation.plan;
  const discovery = discoverProviderManifests(providerDir);
  const profile = loadProfile(kbRoot);
  const entries = profileProviderEntries(kbRoot);
  let lokiEntry = profileEntry(entries, "loki");
  const kubectlEntry = profileEntry(entries, "kubectl");
  const lokiManifest = discovery.providers.get("loki");
  const kubectlManifest = discovery.providers.get("kubectl");
  if (!lokiEntry || !lokiManifest) {
    return {status: "blocked", responses: [], gaps: ["loki_provider_not_available"], inspection_steps: [], budget: null};
  }
  if (!kubectlEntry) {
    return {status: "blocked", responses: [], gaps: ["kubectl_cluster_directory_not_available"], inspection_steps: [], budget: null};
  }
  const aggregationTarget = plan.targets.find((target) => target.aggregation !== undefined);
  const requiredCapabilities = aggregationTarget
    ? ["loki.gateway.health", "loki.stream.selector.resolve", "loki.logs.topk_api_status"]
    : ["loki.gateway.health", "loki.stream.selector.resolve", "loki.index.stats", "loki.logs.query_excerpt"];
  for (const required of requiredCapabilities) {
    if (!lokiManifest.capabilities.includes(required) || !lokiEntry.capabilities.includes(required)) {
      return {status: "blocked", responses: [], gaps: [`loki_capability_unavailable:${required}`], inspection_steps: [], budget: null};
    }
  }
  const problemType = inferProblemType(issue);
  const responses = [];
  const gaps = [...discovery.gaps];
  const inspectionSteps = [];
  const budgetLimits = budgetFromPlan(plan);
  const ledger = {log_queries: 0, tenants: new Set(), scan_bytes: 0, entries: 0};
  let profileReconciled = false;
  const placements = profile?.observability?.component_log_placements || [];
  const placementsByTarget = new Map();
  for (const target of plan.targets) {
    const knownComponent = placements.some((item) =>
      String(item?.component || "").toLowerCase() === String(target.application || "").toLowerCase());
    if (!knownComponent && !target.aggregation) continue;
    const placement = resolveComponentPlacement(
      placements,
      target.application,
      plan.cluster_alias,
      kubectlEntry.config?.routes,
    );
    if (placement.status !== "matched") {
      const gap = placement.status === "ambiguous"
        ? "component_log_placement_ambiguous"
        : placement.status === "conflict"
          ? "component_log_placement_conflict"
          : "component_log_placement_unmapped";
      return {status: "blocked", responses, gaps: [gap], inspection_steps: inspectionSteps, budget: null};
    }
    placementsByTarget.set(target.target_id, placement.placement);
  }
  const placementClusterRefs = new Set([...placementsByTarget.values()].map((item) => item.cluster_ref));
  if (placementClusterRefs.size > 1) {
    return {status: "blocked", responses, gaps: ["component_log_placement_conflict"], inspection_steps: inspectionSteps, budget: null};
  }
  const clusterResolution = placementClusterRefs.size
    ? {status: "matched", cluster_ref: [...placementClusterRefs][0]}
    : resolveKubectlCluster(kubectlEntry.config?.routes, plan.cluster_alias);
  if (clusterResolution.status !== "matched") {
    const gap = clusterResolution.status === "ambiguous" ? "cluster_route_ambiguous" : "cluster_route_unmapped";
    return {status: "blocked", responses, gaps: [gap], inspection_steps: inspectionSteps, budget: null};
  }
  const clusterRef = clusterResolution.cluster_ref;
  let resolution = resolveLokiGateway(lokiEntry.config?.gateways, clusterRef);
  if (resolution.status === "ambiguous") {
    return {status: "blocked", responses, gaps: ["gateway_profile_ambiguous"], inspection_steps: inspectionSteps, budget: null};
  }

  async function reconcileGateway(existingGateway = null) {
    const discovered = await discoverGateway({
      issue,
      problemType,
      clusterRef,
      kubectlEntry,
      kubectlManifest,
      timeoutMs,
      env,
    });
    if (discovered.response) responses.push(discovered.response);
    inspectionSteps.push({
      status: discovered.gap ? "failed" : "completed",
      capability: "k8s.loki_gateway.resolve",
      target: clusterRef,
      result: discovered.gap || "one projected Gateway candidate",
    });
    if (discovered.gap) {
      gaps.push(discovered.gap);
      return null;
    }
    const probeTarget = plan.targets.find((target) => typeof target.application === "string");
    if (!probeTarget) {
      gaps.push("gateway_probe_application_missing");
      return null;
    }
    const health = await healthCandidate({
      issue,
      problemType,
      data: discovered.data,
      application: probeTarget.application,
      tenant: placementsByTarget.get(probeTarget.target_id)?.tenant_id,
      timeAnchor: plan.time_anchor,
      lokiManifest,
      timeoutMs,
      env,
    });
    responses.push(health);
    inspectionSteps.push({
      status: health.status === "ok" ? "completed" : "failed",
      capability: "loki.gateway.health",
      target: discovered.data.cluster_alias,
      result: health.status,
    });
    if (health.status !== "ok") {
      gaps.push(...health.gaps);
      return null;
    }
    const candidateUrl = `https://${discovered.data.rule_host}`;
    if (existingGateway?.gateway_url === candidateUrl) return existingGateway;
    const reconciliationEvidence = {
      schema_version: "l05-loki-gateway-reconciliation/v1",
      kubectl_response: discovered.response,
      loki_health_response: health,
    };
    const reconciliation = await applyGatewayReconciliation({
      kbRoot,
      evidence: reconciliationEvidence,
      apply: authorizeProfileUpdate,
    });
    inspectionSteps.push({
      status: reconciliation.status === "updated" || reconciliation.status === "no_change" ? "completed" : "blocked",
      capability: "profile.loki_gateway.reconcile",
      target: discovered.data.cluster_alias,
      result: reconciliation.status,
      diff_fingerprint: reconciliation.new_gateway_fingerprint,
    });
    if (!authorizeProfileUpdate || reconciliation.status !== "updated") {
      gaps.push(reconciliation.reason || "gateway_profile_update_required");
      return null;
    }
    profileReconciled = true;
    lokiEntry = profileEntry(profileProviderEntries(kbRoot), "loki");
    resolution = resolveLokiGateway(lokiEntry.config?.gateways, clusterRef);
    return resolution.status === "matched" ? resolution.gateway : null;
  }

  let gateway = resolution.gateway;
  if (!gateway) gateway = await reconcileGateway();
  if (!gateway) {
    return {
      status: "blocked",
      provider_directory: discovery.directory,
      problem_type: problemType,
      responses,
      gaps: [...new Set(gaps)],
      inspection_steps: inspectionSteps,
      budget: {...ledger, tenants: []},
    };
  }

  let gatewaySource = profileReconciled ? "profile_reconciled" : "profile";
  const resolvedTargets = [];
  for (const target of plan.targets) {
    const identity = await resolveApplication({
      target,
      issue,
      problemType,
      clusterRef,
      kubectlEntry,
      kubectlManifest,
      timeoutMs,
      env,
    });
    if (identity.response) {
      responses.push(identity.response);
      inspectionSteps.push({
        status: identity.application ? "completed" : "failed",
        capability: "k8s.application.identity",
        target: target.target_id,
        result: identity.application ? "one projected Application identity" : identity.gap,
      });
    }
    if (!identity.application) {
      gaps.push(identity.gap || "application_unresolved");
      continue;
    }
    if (target.correlation_from && !resolvedTargets.some((item) => item.target_id === target.correlation_from)) {
      gaps.push(`correlation_source_unresolved:${target.target_id}`);
      continue;
    }
    const placement = placementsByTarget.get(target.target_id) || null;
    const tenantId = placement?.tenant_id || identity.application;
    if (!ledger.tenants.has(tenantId) && ledger.tenants.size >= budgetLimits.max_tenants) {
      gaps.push("query_budget_exceeded");
      break;
    }
    ledger.tenants.add(tenantId);
    const candidateRules = placement?.stream_selector_candidates || [
      {label: "application", value_source: "application"},
    ];
    const streamSelectorCandidates = target.aggregation ? [] : candidateRules.flatMap((candidate) => {
      const value = candidate.value_source === "log_identity"
        ? target.log_identity?.value
        : candidate.value_source === "fixed"
          ? candidate.value
          : identity.application;
      return typeof value === "string" && value ? [{label: candidate.label, match: "exact", value}] : [];
    });
    if (!target.aggregation && !streamSelectorCandidates.length) {
      gaps.push(`log_identity_unresolved:${target.target_id}`);
      continue;
    }
    resolvedTargets.push({
      target_id: target.target_id,
      role: target.role,
      application: identity.application,
      tenant_id: tenantId,
      tenant_source: placement ? "component_placement" : target.application ? "confirmed_application" : "kubectl_application_label",
      filters: target.filters,
      limit: target.limit,
      triggered_by: target.triggered_by,
      ...(target.aggregation && placement ? {stream_selector: placement.stream_selector} : {}),
      ...(!target.aggregation ? {stream_selector_candidates: streamSelectorCandidates} : {}),
      ...(target.aggregation ? {aggregation: target.aggregation} : {}),
      ...(target.correlation_from ? {correlation_from: target.correlation_from} : {}),
    });
  }
  if (!resolvedTargets.length) {
    return {
      status: "blocked",
      provider_directory: discovery.directory,
      problem_type: problemType,
      responses,
      gaps: [...new Set(gaps)],
      inspection_steps: inspectionSteps,
      budget: {limits: budgetLimits, used: {log_queries: 0, tenants: ledger.tenants.size, scan_bytes: 0, entries: 0}},
    };
  }
  const targetPlan = {
    ...plan,
    budget: budgetLimits,
    targets: resolvedTargets,
  };
  const capabilities = aggregationTarget
    ? ["loki.gateway.health", "loki.stream.selector.resolve", "loki.logs.topk_api_status"]
    : ["loki.gateway.health", "loki.stream.selector.resolve", "loki.index.stats", "loki.logs.query_excerpt"];
  const providerContext = () => ({
    problem_type: problemType,
    evidence_plan: targetPlan,
    resolved_cluster: {
      cluster_alias: clusterRef,
      gateway_source: gatewaySource,
    },
    upstream_evidence: {application_identities: responses.flatMap((response) =>
      response.provider_id === "kubectl"
        ? (response.evidence_records || []).filter((record) => record.capability === "k8s.application.identity")
        : [])},
  });
  let response = await invokeProvider(
    lokiManifest,
    requestValue("loki", capabilities, issue, providerContext(), lokiEntry.config),
    {timeoutMs, env},
  );
  responses.push(response);
  appendLokiInspectionSteps(inspectionSteps, response, resolvedTargets, gatewaySource, true);
  if (response.status === "blocked" && responseHasGap(response, "gateway_unreachable")) {
    const reconciled = await reconcileGateway(gateway);
    if (reconciled) {
      gateway = reconciled;
      gatewaySource = "profile_reconciled";
      response = await invokeProvider(
        lokiManifest,
        requestValue("loki", capabilities, issue, providerContext(), lokiEntry.config),
        {timeoutMs, env},
      );
      responses.push(response);
      appendLokiInspectionSteps(inspectionSteps, response, resolvedTargets, gatewaySource, true);
    }
  }
  consumeBudget(ledger, response);
  gaps.push(...response.gaps.map((gap) => `loki:${gap}`));
  return {
    status: responses.some((response) => response.evidence_records?.length) ? (gaps.length ? "partial" : "ok") : "blocked",
    provider_directory: discovery.directory,
    problem_type: problemType,
    responses,
    gaps: [...new Set(gaps)],
    inspection_steps: inspectionSteps,
    budget: {
      limits: budgetLimits,
      used: {
        log_queries: ledger.log_queries,
        tenants: ledger.tenants.size,
        scan_bytes: ledger.scan_bytes,
        entries: ledger.entries,
      },
    },
  };
}
