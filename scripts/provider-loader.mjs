import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {rankedSafeHttpLocators} from "./request-summary.mjs";
import {resolveProfileCluster} from "./cluster-directory.mjs";

const MANIFEST_SCHEMA = "l05-provider-manifest/v1";
const REQUEST_SCHEMA = "l05-provider-request/v1";
const RESPONSE_SCHEMA = "l05-provider-response/v1";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_.-]{1,95}$/;
const SECRET_ENV_NAME = /(?:^|_)(?:token|password|passwd|secret|private_key|cookie|authorization|api_key)(?:$|_)/i;
const AUTOMATION_AUTHOR = /(?:bot|automation|stackstorm|opsagent|no[-_ ]?reply|noreply|\bim\b|system)/i;
const RESOLUTION_COMMENT = /(?:^|\n)\s*(?:当前)?已.{0,32}(?:发布|配置|处理|修复|增加|调整|完成)|(?:已针对|处理结果|处理方案|建议).{0,48}(?:发布|配置|处理|修复|增加|调整|完成)/i;
const PROVIDER_EVIDENCE_COMMENT = /失败|报错|异常|无法|不可用|中断|超时|排查|原因|根因|\b(?:failed|failure|error|exception|unavailable|cannot|can't|timeout|investigate|root cause)\b/i;
const KUBERNETES_TARGET_KINDS = new Map([
  ["deployment", "Deployment"],
  ["statefulset", "StatefulSet"],
  ["daemonset", "DaemonSet"],
  ["job", "Job"],
  ["pod", "Pod"],
  ["service", "Service"],
  ["ingress", "Ingress"],
]);
const KUBERNETES_LOCATOR_CAPABILITIES = new Set([
  "k8s.context.health",
  "k8s.rbac.check",
  "k8s.pod.anomalies",
  "k8s.pod.status",
  "k8s.events.list",
  "k8s.workload.status",
  "k8s.pod.logs_excerpt",
]);
const KUBERNETES_WORKLOAD_KINDS = new Set(["Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"]);
const KUBERNETES_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?$/i;

function uniqueStrings(values) {
  return [...new Set((values || []).filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
}

function safeCommand(command) {
  return Array.isArray(command) && command.length > 0 && command.length <= 8 && command.every((item) => typeof item === "string" && item.length > 0 && !/[\r\n\0]/.test(item));
}

export function validateProviderManifest(value, source = "manifest") {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {valid: false, errors: [`${source}:not_an_object`]};
  if (value.schema_version !== MANIFEST_SCHEMA) errors.push(`${source}:unsupported_schema_version`);
  if (!ID_PATTERN.test(value.provider_id || "")) errors.push(`${source}:invalid_provider_id`);
  if (!safeCommand(value.command)) errors.push(`${source}:invalid_command`);
  const capabilities = uniqueStrings(value.capabilities);
  if (!capabilities.length || capabilities.some((item) => !CAPABILITY_PATTERN.test(item))) errors.push(`${source}:invalid_capabilities`);
  if (value.request_schema !== REQUEST_SCHEMA) errors.push(`${source}:unsupported_request_schema`);
  if (value.response_schema !== RESPONSE_SCHEMA) errors.push(`${source}:unsupported_response_schema`);
  return {valid: errors.length === 0, errors, manifest: {...value, capabilities}};
}

export function discoverProviderManifests(providerDir = process.env.L05_PROVIDER_DIR || path.join(os.homedir(), ".codex/l05-diagnosis/providers.d")) {
  const directory = path.resolve(providerDir);
  if (!fs.existsSync(directory)) return {directory, providers: new Map(), gaps: []};
  const providers = new Map();
  const gaps = [];
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
    const file = path.join(directory, name);
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const validation = validateProviderManifest(parsed, name);
      if (!validation.valid) {
        gaps.push(...validation.errors);
        continue;
      }
      if (providers.has(validation.manifest.provider_id)) {
        gaps.push(`${name}:duplicate_provider_id`);
        continue;
      }
      providers.set(validation.manifest.provider_id, {...validation.manifest, manifest_path: file});
    } catch {
      gaps.push(`${name}:invalid_json`);
    }
  }
  return {directory, providers, gaps};
}

export function loadProfile(kbRoot) {
  const file = path.join(path.resolve(kbRoot), ".l05-profile.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function profileProviderEntries(kbRoot) {
  const profile = loadProfile(kbRoot);
  return Array.isArray(profile?.optional_evidence_providers) ? profile.optional_evidence_providers : [];
}

function primaryIssueText(issue) {
  const custom = (issue.custom_fields || []).map((item) => `${item.name || ""} ${JSON.stringify(item.value ?? "")}`);
  return [issue.ticket?.summary, issue.ticket?.description_markdown, issue.ticket?.environment, ...(issue.ticket?.components || []), ...custom].filter(Boolean).join("\n");
}

function providerSignalComments(issue) {
  return (issue.comments || []).filter((item) => {
    if (AUTOMATION_AUTHOR.test(`${item.author?.display_name || ""} ${item.author?.stable_id || ""}`)) return false;
    const text = item.body_markdown || "";
    return !RESOLUTION_COMMENT.test(text) && PROVIDER_EVIDENCE_COMMENT.test(text);
  });
}

function issueText(issue) {
  return [primaryIssueText(issue), ...providerSignalComments(issue).map((item) => item.body_markdown || "")].filter(Boolean).join("\n");
}

export function inferProblemType(issue) {
  const text = issueText(issue).toLowerCase();
  if (/apim|api gateway|swagger|网关|cors|preflight|access control/.test(text)) return "gateway.request";
  if (/jenkins|github actions|pipeline|cicd|ci\/cd|构建/.test(text)) return "cicd.pipeline_execution";
  if (/kubernetes|\bk8s\b|pod|helm|容器|rancher/.test(text)) return "kubernetes.runtime";
  return "support.unknown";
}

function selectorMatches(patterns, values, kind) {
  const normalized = values.filter(Boolean).map((value) => String(value).toLowerCase());
  if (kind === "problem_types") {
    return patterns.some((pattern) => {
      const expression = `^${String(pattern).toLowerCase().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`;
      return normalized.some((value) => new RegExp(expression).test(value));
    });
  }
  return patterns.some((pattern) => normalized.some((value) => value.includes(String(pattern).toLowerCase())));
}

export function providerEntryMatches(entry, issue, problemType = inferProblemType(issue)) {
  if (entry?.enabled === false) return false;
  const ciCapability = (entry?.capabilities || []).some((capability) => String(capability).startsWith("ci."));
  if (ciCapability && problemType !== "cicd.pipeline_execution" && !ciLocator(issue)) return false;
  const match = entry?.match;
  if (!match || typeof match !== "object") return true;
  const text = issueText(issue);
  const values = {problem_types: [problemType], keywords: [text], components: issue.ticket?.components || []};
  const checks = ["problem_types", "keywords", "components"]
    .filter((key) => Array.isArray(match[key]) && match[key].length)
    .map((key) => selectorMatches(match[key], values[key], key));
  if (!checks.length) return true;
  return match.match_mode === "all" ? checks.every(Boolean) : checks.some(Boolean);
}

function ciLocator(issue) {
  const evidenceIssue = {...issue, comments: providerSignalComments(issue)};
  const exactUrl = rankedSafeHttpLocators(evidenceIssue).find((item) => item.role === "ci_endpoint")?.locator;
  if (exactUrl) return exactUrl;
  const text = issueText(issue);
  const task = /\btask\s*(?:id)?\s*[:：#]?\s*([0-9]{1,12})\b/i.exec(text)?.[1];
  if (task) return `task:${task}`;
  const build = /\bbuild\s*#?\s*([0-9]{1,12})\b/i.exec(text)?.[1];
  return build ? `build:${build}` : "";
}

function oneValue(values) {
  const unique = uniqueStrings(values);
  return unique.length === 1 ? unique[0] : "";
}

function scalarStrings(value) {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarStrings);
  if (value && typeof value === "object") return [value.value, value.name, value.label].flatMap(scalarStrings);
  return [];
}

function mappingConfig(value = {}) {
  if (value?.field_mappings && typeof value.field_mappings === "object" && !Array.isArray(value.field_mappings)) return value;
  return {field_mappings: value};
}

function mappedSelectors(config, slot) {
  const selectors = mappingConfig(config).field_mappings?.[slot];
  return Array.isArray(selectors) ? selectors : [];
}

function mappedValuePaths(config, slot) {
  const paths = mappingConfig(config).field_value_paths?.[slot];
  return Array.isArray(paths) ? paths : [];
}

function valueAtPath(value, pathValue) {
  if (typeof pathValue !== "string" || !pathValue.trim()) return undefined;
  return pathValue.split(".").reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(key) && Array.isArray(current)) return current[Number(key)];
    return typeof current === "object" ? current[key] : undefined;
  }, value);
}

function fieldNames(field) {
  return [field?.name, field?.id, field?.key]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
}

function isStructuredParentChildField(field) {
  return field?.schema_type === "option-with-child"
    || Boolean(field?.value && typeof field.value === "object" && !Array.isArray(field.value) && field.value.child);
}

function mappedFieldValues(issue, slot, config = {}) {
  const normalized = mappingConfig(config);
  const selectors = new Set(mappedSelectors(normalized, slot).map((value) => String(value).trim().toLowerCase()));
  if (!selectors.size) return [];
  const output = [];
  for (const field of issue?.custom_fields || []) {
    if (!fieldNames(field).some((name) => selectors.has(name))) continue;
    let paths = mappedValuePaths(normalized, slot);
    // A structured parent/child field is organization-defined. Application
    // extraction therefore requires an explicit private value path; otherwise
    // the parent value could be mistaken for a workload identity.
    if (isStructuredParentChildField(field) && slot === "application" && !paths.length) continue;
    if (paths.length) {
      output.push(...paths.flatMap((pathValue) => scalarStrings(valueAtPath(field?.value, pathValue))));
    } else {
      output.push(...scalarStrings(field?.value));
    }
  }
  return output;
}

function customNamedValues(issue, aliases) {
  const selectors = new Set(aliases.map((value) => String(value).trim().toLowerCase()));
  return (issue?.custom_fields || []).flatMap((field) => (
    fieldNames(field).some((name) => selectors.has(name)) ? scalarStrings(field?.value) : []
  ));
}

function extractKubernetesNamespace(issue, fieldMappings = {}) {
  const text = issueText(issue);
  const selectors = new Set([
    "namespace",
    "ns",
    ...mappedSelectors(fieldMappings, "namespace"),
  ].map((value) => String(value).trim().toLowerCase()));
  const fieldValues = (issue?.custom_fields || []).flatMap((field) => {
    const names = fieldNames(field);
    return names.some((name) => selectors.has(name)) ? scalarStrings(field?.value) : [];
  });
  return oneValue([
    ...text.matchAll(/(?:\bnamespace\b|\bns\b)\s*(?:=|:|\/|\bis\b|是|为)\s*([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)/gi),
    ...text.matchAll(/\/namespaces\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)/gi),
  ].map((match) => match[1]).concat([
    ...fieldValues,
    ...mappedFieldValues(issue, "namespace", fieldMappings),
  ].filter((value) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))));
}

export function extractKubernetesTarget(issue, fieldMappings = {}) {
  const text = issueText(issue);
  const urlPod = [...text.matchAll(/\/namespaces\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/(?:workloads\/)?pods\/([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)/gi)];
  const namespace = extractKubernetesNamespace(issue, fieldMappings);
  if (urlPod.length === 1) return namespace === urlPod[0][1] ? {namespace, kind: "Pod", name: urlPod[0][2]} : null;
  // Require an explicit key/value or URL separator. Plain prose such as
  // "Pod is unhealthy" must never turn the word "is" into a resource name.
  const resources = [...text.matchAll(/\b(Deployment|StatefulSet|DaemonSet|Job|Pod|Service|Ingress)\b(?:\s+name)?\s*(?:=|:|\/)\s*([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)/gi)]
    .map((match) => ({kind: KUBERNETES_TARGET_KINDS.get(match[1].toLowerCase()), name: match[2]}))
    .filter((item) => item.kind);
  if (!namespace || resources.length !== 1) return null;
  return {namespace, ...resources[0]};
}

export function extractKubernetesScope(issue, fieldMappings = {}) {
  const namespace = extractKubernetesNamespace(issue, fieldMappings);
  const application = extractKubernetesApplication(issue, fieldMappings);
  return namespace && application ? {namespace, application} : null;
}

export function extractKubernetesApplication(issue, fieldMappings = {}) {
  const text = issueText(issue);
  const fieldValues = [
    ...mappedFieldValues(issue, "application", fieldMappings),
    ...customNamedValues(issue, ["application", "applicationname", "application name"]),
  ];
  const inlineValues = [...text.matchAll(/\bapplication(?:\s*name)?\b\s*(?:=|:|是|为)\s*([A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?)/gi)].map((match) => match[1]);
  return oneValue([...fieldValues, ...inlineValues].filter((value) => /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value)));
}

export function extractKubernetesDomain(issue, fieldMappings = {}) {
  return oneValue(mappedFieldValues(issue, "domain", fieldMappings));
}

function resourceNames(issue, kind) {
  const text = issueText(issue);
  const urlNames = kind === "Pod"
    ? [...text.matchAll(/\/namespaces\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/(?:workloads\/)?pods\/([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)/gi)].map((match) => match[1])
    : [];
  const resources = [...text.matchAll(/\b(Deployment|StatefulSet|DaemonSet|Job|CronJob|Pod)\b\s*(?:=|:|\/)\s*([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)/gi)]
    .filter((match) => kind === "Workload"
      ? KUBERNETES_WORKLOAD_KINDS.has(KUBERNETES_TARGET_KINDS.get(match[1].toLowerCase()) || match[1])
      : KUBERNETES_TARGET_KINDS.get(match[1].toLowerCase()) === kind)
    .map((match) => match[2]);
  const aliases = kind === "Pod"
    ? ["pod", "pod name", "pod_name", "podname"]
    : ["workload", "workload name", "workload_name", "workloadname", "deployment", "deployment name", "statefulset", "statefulset name", "daemonset", "daemonset name", "job", "job name"];
  const explicit = customNamedValues(issue, aliases);
  const pattern = kind === "Pod"
    ? /\b(?:pod(?:\s+name)?)\s*(?:=|:|\/|是|为)\s*([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)/gi
    : /\b(?:workload|deployment|statefulset|daemonset|job)(?:\s+name)?\s*(?:=|:|\/|是|为)\s*([a-z0-9](?:[a-z0-9.-]{0,61}[a-z0-9])?)/gi;
  const inline = [...text.matchAll(pattern)].map((match) => match[1]);
  return uniqueStrings([...urlNames, ...resources, ...explicit, ...inline].filter((value) => KUBERNETES_NAME_PATTERN.test(value)));
}

export function extractKubernetesLocator(issue, fieldMappings = {}) {
  const namespace = extractKubernetesNamespace(issue, fieldMappings);
  const target = extractKubernetesTarget(issue, fieldMappings);
  if (target) return target;
  const podNames = resourceNames(issue, "Pod");
  const workloadNames = resourceNames(issue, "Workload");
  const application = extractKubernetesApplication(issue, fieldMappings);
  if (podNames.length > 1 || workloadNames.length > 1) return null;
  // A named Pod/Workload is the stronger locator. Do not add the CMDB
  // application as a second identity: the Provider intentionally accepts one
  // target identity at a time and the application remains contextual metadata.
  if (podNames.length === 1) return {...(namespace ? {namespace} : {}), pod_name: podNames[0]};
  if (workloadNames.length === 1) return {...(namespace ? {namespace} : {}), workload_name: workloadNames[0]};
  if (namespace) return {namespace, ...(application ? {application} : {})};
  return application ? {application} : null;
}

function capabilitiesForKubernetesLocator(capabilities, locator, target) {
  if (!locator && !target) return capabilities;
  if (target) return capabilities;
  return capabilities.filter((capability) => KUBERNETES_LOCATOR_CAPABILITIES.has(capability));
}

function kubernetesTargetEvidence(response, requested) {
  const targetCapabilities = requested.filter((capability) => !["k8s.context.health", "k8s.rbac.check"].includes(capability));
  return (response?.evidence_records || []).some((record) => targetCapabilities.includes(record?.capability));
}

export function rancherUseBoundary(issue) {
  const text = issueText(issue);
  if (!/rancher/i.test(text)) return {mode: "not_applicable", allow_browser: false, allow_api: false};
  const accessSignal = /(?:账号|账户|account|权限|permission|authorization|authorize|授权|role|角色|登录|login|unauthorized|forbidden)/i;
  const platformCapabilitySignal = /(?:平台|控制台|platform|console|control[ -]?plane|控制面).{0,40}(?:访问|access|能力|capabilit|不可用|unavailable)/i;
  const rancherWindow = [...text.matchAll(/rancher/gi)]
    .map((match) => text.slice(Math.max(0, match.index - 100), match.index + match[0].length + 100))
    .join(" ");
  const platformAccess = accessSignal.test(rancherWindow) || platformCapabilitySignal.test(rancherWindow);
  return {
    mode: platformAccess ? "sre_handoff" : "kubernetes_observation",
    allow_browser: false,
    allow_api: false,
  };
}

export function rancherPlatformAccessRequiresSre(issue) {
  return rancherUseBoundary(issue).mode === "sre_handoff";
}

function requiresExactCiLocator(entry, problemType) {
  return problemType === "cicd.pipeline_execution" || (entry.capabilities || []).some((capability) => capability.startsWith("ci."));
}

function boundEvidenceQuestion(evidenceQuestion, locator, problemType) {
  const question = evidenceQuestion?.question || (problemType === "cicd.pipeline_execution"
    ? "Resolve the exact CI execution and inspect the first failing stage."
    : "Collect one current observation that can support, contradict, or narrow the current evidence gap.");
  return {
    question,
    locator: locator || evidenceQuestion?.locator || "",
    source: evidenceQuestion?.source || "l05-core",
    expected_effect: evidenceQuestion?.expected_effect || "supports_or_contradicts_hypothesis",
  };
}

function hasBoundEvidenceQuestion(value) {
  return Boolean(value?.question && value?.locator);
}

function exactSecretValues(env) {
  return Object.entries(env)
    .filter(([key, value]) => SECRET_ENV_NAME.test(key) && typeof value === "string" && value.length >= 5)
    .map(([, value]) => value)
    .sort((left, right) => right.length - left.length);
}

function redactKnownSecrets(value, secrets) {
  if (typeof value === "string") return secrets.reduce((text, secret) => text.replaceAll(secret, "[redacted]"), value);
  if (Array.isArray(value)) return value.map((item) => redactKnownSecrets(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownSecrets(item, secrets)]));
  return value;
}

export function validateProviderResponse(value, manifest) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return {valid: false, errors: ["response_not_an_object"]};
  if (value.schema_version !== RESPONSE_SCHEMA) errors.push("unsupported_response_schema");
  if (value.provider_id !== manifest.provider_id) errors.push("provider_id_mismatch");
  if (!["ok", "partial", "no_match", "blocked"].includes(value.status)) errors.push("invalid_status");
  if (!Array.isArray(value.evidence_records)) errors.push("evidence_records_must_be_array");
  else if (value.evidence_records.length > 100) errors.push("too_many_evidence_records");
  if (!Array.isArray(value.gaps)) errors.push("gaps_must_be_array");
  return {valid: errors.length === 0, errors};
}

export async function invokeProvider(manifest, request, {timeoutMs = 120000, env = process.env} = {}) {
  try {
    const {stdout, stderr, code} = await new Promise((resolve, reject) => {
      const child = spawn(manifest.command[0], manifest.command.slice(1), {env: {...env}, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
      const stdoutChunks = [];
      const stderrChunks = [];
      let outputSize = 0;
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback(value);
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        const error = new Error("provider timeout");
        error.killed = true;
        finish(reject, error);
      }, timeoutMs);
      const collect = (target) => (chunk) => {
        outputSize += chunk.length;
        if (outputSize > 2 * 1024 * 1024) {
          child.kill("SIGKILL");
          finish(reject, Object.assign(new Error("provider output limit exceeded"), {code: "OUTPUT_LIMIT"}));
          return;
        }
        target.push(chunk);
      };
      child.stdout.on("data", collect(stdoutChunks));
      child.stderr.on("data", collect(stderrChunks));
      child.on("error", (error) => finish(reject, error));
      child.on("close", (code) => {
        finish(resolve, {
          code,
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
        });
      });
      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
    const response = JSON.parse(stdout.trim());
    const sanitized = redactKnownSecrets(response, exactSecretValues(env));
    const validation = validateProviderResponse(sanitized, manifest);
    if (!validation.valid) return {provider_id: manifest.provider_id, status: "blocked", evidence_records: [], gaps: validation.errors.map((item) => `provider_response:${item}`)};
    if (stderr.trim()) sanitized.gaps = [...sanitized.gaps, "provider_wrote_stderr"];
    if (sanitized.status !== "blocked" && code !== 0) sanitized.gaps = [...sanitized.gaps, "provider_exited_nonzero"];
    return sanitized;
  } catch (error) {
    const reason = error.killed ? "timeout" : error.code === "ENOENT" ? "command_not_found" : "execution_failed";
    return {provider_id: manifest.provider_id, status: "blocked", evidence_records: [], gaps: [`provider_${reason}`]};
  }
}

export async function collectOptionalEvidence({kbRoot, issue, retrievalSeedDetails = [], providerDir, timeoutMs, evidenceQuestion = null, env = process.env}) {
  const discovery = discoverProviderManifests(providerDir);
  const problemType = inferProblemType(issue);
  const responses = [];
  const gaps = [...discovery.gaps];
  const deferredProviders = [];
  const providerDecisions = [];
  const profile = loadProfile(kbRoot);
  for (const entry of profileProviderEntries(kbRoot)) {
    if (!entry || typeof entry !== "object" || entry.enabled === false || !providerEntryMatches(entry, issue, problemType)) continue;
    if (entry.provider_id === "loki") {
      deferredProviders.push("loki");
      providerDecisions.push({provider_id: "loki", status: "deferred", reason: "evidence_plan_required"});
      continue;
    }
    if (!hasBoundEvidenceQuestion(evidenceQuestion)) {
      deferredProviders.push(entry.provider_id);
      const reason = `provider_deferred_missing_evidence_question:${entry.provider_id}`;
      gaps.push(reason);
      providerDecisions.push({provider_id: entry.provider_id, status: "deferred", reason: "missing_evidence_question"});
      continue;
    }
    const manifest = discovery.providers.get(entry.provider_id);
    if (!manifest) {
      gaps.push(`provider_not_installed:${entry.provider_id || "unknown"}`);
      continue;
    }
    let requested = uniqueStrings(entry.capabilities || manifest.capabilities).filter((item) => manifest.capabilities.includes(item));
    if (!requested.length) {
      gaps.push(`provider_has_no_requested_capability:${entry.provider_id}`);
      continue;
    }
    const evidenceLocator = requiresExactCiLocator(entry, problemType) ? ciLocator(issue) : evidenceQuestion?.locator || "";
    if (requiresExactCiLocator(entry, problemType) && !evidenceLocator) {
      deferredProviders.push(entry.provider_id);
      const reason = `provider_deferred_missing_exact_locator:${entry.provider_id}`;
      gaps.push(reason);
      providerDecisions.push({provider_id: entry.provider_id, status: "deferred", reason: "missing_exact_locator", evidence_question: boundEvidenceQuestion(evidenceQuestion, "", problemType)});
      continue;
    }
    const question = boundEvidenceQuestion(evidenceQuestion, evidenceLocator, problemType);
    const request = {
      schema_version: REQUEST_SCHEMA,
      request_id: `${issue.source?.issue_key || "issue"}-${Date.now()}`,
      provider_id: entry.provider_id,
      capabilities: requested,
      issue: {
        source: issue.source,
        ticket: issue.ticket,
        custom_fields: issue.custom_fields || [],
        comments: providerSignalComments(issue),
        links: issue.links || [],
      },
      context: {problem_type: problemType, retrieval_seeds: retrievalSeedDetails, evidence_question: question},
      config: entry.config || {},
    };
    if (entry.provider_id === "kubectl") {
      const rancherBoundary = rancherUseBoundary(issue);
      if (rancherBoundary.mode === "sre_handoff") {
        deferredProviders.push("kubectl");
        gaps.push("provider_deferred_rancher_platform_access_requires_sre:kubectl");
        providerDecisions.push({provider_id: "kubectl", status: "deferred", reason: "rancher_platform_access_requires_sre", evidence_question: question});
        continue;
      }
      const jiraConfig = profile?.jira || {};
      const target = extractKubernetesTarget(issue, jiraConfig);
      const kubernetesLocator = target ? null : extractKubernetesLocator(issue, jiraConfig);
      const scope = target || kubernetesLocator?.pod_name || kubernetesLocator?.workload_name
        ? null
        : extractKubernetesScope(issue, jiraConfig);
      const targetRequired = requested.some((capability) => ![
        "k8s.context.health",
        "k8s.rbac.check",
        "k8s.loki_gateway.resolve",
        "k8s.pod.anomalies",
      ].includes(capability) && !KUBERNETES_LOCATOR_CAPABILITIES.has(capability));
      if (targetRequired && !target && !kubernetesLocator) {
        deferredProviders.push("kubectl");
        gaps.push("provider_deferred_missing_kubernetes_target:kubectl");
        providerDecisions.push({provider_id: "kubectl", status: "deferred", reason: "missing_kubernetes_target", evidence_question: question});
        continue;
      }
      if (requested.includes("k8s.pod.anomalies") && !target && !kubernetesLocator?.application && !kubernetesLocator?.namespace) {
        deferredProviders.push("kubectl");
        gaps.push("provider_deferred_missing_kubernetes_locator:kubectl");
        providerDecisions.push({provider_id: "kubectl", status: "deferred", reason: "missing_kubernetes_locator", evidence_question: question});
        continue;
      }
      requested = capabilitiesForKubernetesLocator(requested, kubernetesLocator, target);
      if (!requested.length) {
        gaps.push("provider_has_no_compatible_kubernetes_capability:kubectl");
        providerDecisions.push({provider_id: "kubectl", status: "deferred", reason: "no_compatible_kubernetes_capability", evidence_question: question});
        continue;
      }
      request.capabilities = requested;
      const resolution = resolveProfileCluster({profile, kubectlEntry: entry, issue});
      if (resolution.status === "missing" || resolution.status === "ambiguous") {
        deferredProviders.push("kubectl");
        const reason = resolution.status === "ambiguous" ? "cluster_route_ambiguous" : "cluster_route_unmapped";
        gaps.push(`provider_deferred_${reason}:kubectl`);
        providerDecisions.push({provider_id: "kubectl", status: "deferred", reason, evidence_question: question});
        continue;
      }
      request.context = {
        ...request.context,
        ...(target ? {kubernetes_target: target} : {}),
        ...(scope ? {kubernetes_scope: scope} : {}),
        ...(kubernetesLocator ? {kubernetes_locator: kubernetesLocator} : {}),
      };
      const clusterRefs = resolution.status === "matched" ? [resolution.cluster_ref] : resolution.candidates;
      const candidateResponses = [];
      for (const clusterRef of clusterRefs.slice(0, 2)) {
        const response = await invokeProvider(manifest, {
          ...request,
          context: {...request.context, resolved_cluster_ref: clusterRef},
        }, {timeoutMs, env});
        candidateResponses.push({cluster_ref: clusterRef, response});
      }
      const matchedResponses = kubernetesLocator
        ? candidateResponses.filter(({response}) => response.locator?.status === "matched" || kubernetesTargetEvidence(response, requested))
        : targetRequired
          ? candidateResponses.filter(({response}) => kubernetesTargetEvidence(response, requested))
          : candidateResponses.filter(({response}) => response.status === "ok" || response.status === "partial");
      const candidateResults = candidateResponses.map(({cluster_ref, response}) => ({
        cluster_ref,
        status: response.status,
        locator_status: response.locator?.status || null,
        gaps: (response.gaps || []).slice(0, 8),
      }));
      if (matchedResponses.length !== 1) {
        const locatorGaps = candidateResults.flatMap((item) => item.gaps);
        const reason = matchedResponses.length > 1
          ? kubernetesLocator?.application ? "cluster_application_ambiguous" : "cluster_target_ambiguous"
          : kubernetesLocator?.application && locatorGaps.some((item) => /ambiguous/.test(item))
            ? "cluster_application_ambiguous"
            : kubernetesLocator?.application && locatorGaps.some((item) => /query_truncated/.test(item))
              ? "cluster_application_query_truncated"
              : kubernetesLocator?.application ? "cluster_application_not_found" : "cluster_target_not_found";
        gaps.push(`kubectl:${reason}`);
        providerDecisions.push({provider_id: "kubectl", status: "partial", reason, candidate_clusters: clusterRefs, candidate_results: candidateResults, evidence_question: question});
      } else {
        responses.push(matchedResponses[0].response);
        gaps.push(...(matchedResponses[0].response.gaps || []).map((item) => `kubectl:${item}`));
        providerDecisions.push({provider_id: "kubectl", status: "invoked", cluster_ref: matchedResponses[0].cluster_ref, candidate_results: candidateResults, evidence_question: question});
      }
      continue;
    }
    providerDecisions.push({provider_id: entry.provider_id, status: "invoked", evidence_question: question});
    const response = await invokeProvider(manifest, request, {timeoutMs, env});
    responses.push(response);
    gaps.push(...response.gaps.map((item) => `${entry.provider_id}:${item}`));
  }
  return {
    provider_directory: discovery.directory,
    problem_type: problemType,
    responses,
    gaps,
    deferred_providers: uniqueStrings(deferredProviders),
    provider_decisions: providerDecisions,
  };
}
