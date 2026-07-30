import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";

const MANIFEST_SCHEMA = "l05-provider-manifest/v1";
const REQUEST_SCHEMA = "l05-provider-request/v1";
const RESPONSE_SCHEMA = "l05-provider-response/v1";
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CAPABILITY_PATTERN = /^[a-z][a-z0-9_.-]{1,95}$/;
const SECRET_ENV_NAME = /(?:^|_)(?:token|password|passwd|secret|private_key|cookie|authorization|api_key)(?:$|_)/i;
const AUTOMATION_AUTHOR = /(?:bot|automation|stackstorm|opsagent|no[-_ ]?reply|noreply|\bim\b|system)/i;

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

function issueText(issue) {
  const custom = (issue.custom_fields || []).map((item) => `${item.name || ""} ${JSON.stringify(item.value ?? "")}`);
  return [issue.ticket?.summary, issue.ticket?.description_markdown, issue.ticket?.environment, ...(issue.ticket?.components || []), ...custom, ...(issue.comments || []).map((item) => item.body_markdown || "")].filter(Boolean).join("\n");
}

export function inferProblemType(issue) {
  const text = issueText(issue).toLowerCase();
  if (/jenkins|github actions|pipeline|cicd|ci\/cd|构建|发布/.test(text)) return "cicd.pipeline_execution";
  if (/apim|api gateway|swagger|网关/.test(text)) return "gateway.request";
  if (/kubernetes|\bk8s\b|pod|helm|容器/.test(text)) return "kubernetes.runtime";
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

export async function collectOptionalEvidence({kbRoot, issue, retrievalSeedDetails = [], providerDir, timeoutMs, env = process.env}) {
  const discovery = discoverProviderManifests(providerDir);
  const problemType = inferProblemType(issue);
  const responses = [];
  const gaps = [...discovery.gaps];
  const deferredProviders = [];
  for (const entry of profileProviderEntries(kbRoot)) {
    if (!entry || typeof entry !== "object" || entry.enabled === false || !providerEntryMatches(entry, issue, problemType)) continue;
    if (entry.provider_id === "loki") {
      deferredProviders.push("loki");
      continue;
    }
    const manifest = discovery.providers.get(entry.provider_id);
    if (!manifest) {
      gaps.push(`provider_not_installed:${entry.provider_id || "unknown"}`);
      continue;
    }
    const requested = uniqueStrings(entry.capabilities || manifest.capabilities).filter((item) => manifest.capabilities.includes(item));
    if (!requested.length) {
      gaps.push(`provider_has_no_requested_capability:${entry.provider_id}`);
      continue;
    }
    const request = {
      schema_version: REQUEST_SCHEMA,
      request_id: `${issue.source?.issue_key || "issue"}-${Date.now()}`,
      provider_id: entry.provider_id,
      capabilities: requested,
      issue: {
        source: issue.source,
        ticket: issue.ticket,
        custom_fields: issue.custom_fields || [],
        comments: (issue.comments || []).filter((item) => !AUTOMATION_AUTHOR.test(`${item.author?.display_name || ""} ${item.author?.stable_id || ""}`)),
        links: issue.links || [],
      },
      context: {problem_type: problemType, retrieval_seeds: retrievalSeedDetails},
      config: entry.config || {},
    };
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
  };
}
