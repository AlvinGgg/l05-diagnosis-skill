import fs from "node:fs";
import path from "node:path";

const REDACTED = /^(?:\[?REDACTED\]?|<redacted>|\*+)$/i;
const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|api[_-]?key|apikey|subscription[_-]?key|sas|sig|signature)$/i;
const TEXT_EXTENSIONS = new Set([".json", ".md", ".txt", ".yaml", ".yml", ".log", ".env", ".xml", ".csv"]);

function escapePointer(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function sensitiveUrl(value) {
  for (const match of String(value).matchAll(/https?:\/\/[^\s<>)\]"']+/gi)) {
    try {
      const url = new URL(match[0]);
      for (const [key, queryValue] of url.searchParams) {
        if (/(?:token|signature|sig|auth|key|secret|password|passwd|code|credential|sas)/i.test(key) && queryValue && !REDACTED.test(queryValue)) return true;
      }
    } catch {}
  }
  return false;
}

function patternIds(value) {
  const text = String(value ?? "");
  const ids = [];
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) ids.push("private_key_material");
  if (/\b(?:Bearer|Basic)\s+(?!\[?REDACTED)[A-Za-z0-9._~+/=-]{8,}/i.test(text)) ids.push("authorization_credential");
  if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) ids.push("jwt_value");
  if (/\b(?:token|password|passwd|secret|client[_-]?secret|api[_-]?key|subscription[_-]?key|sas|signature)\s*[:=]\s*(?!\[?REDACTED|%5BREDACTED%5D)[^\s,;"']{8,}/i.test(text)) ids.push("secret_assignment");
  if (sensitiveUrl(text)) ids.push("sensitive_url_query");
  return ids;
}

function scanJson(value, pointer, file, findings, key = "") {
  if (value == null) return;
  if (["string", "number", "boolean"].includes(typeof value)) {
    const text = String(value);
    if (SENSITIVE_KEY.test(key) && text && !REDACTED.test(text)) findings.push({pattern_id: "sensitive_named_field", file, location: pointer || "/", severity: "blocker"});
    for (const patternId of patternIds(text)) findings.push({pattern_id: patternId, file, location: pointer || "/", severity: "blocker"});
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJson(item, `${pointer}/${index}`, file, findings));
    return;
  }
  if (typeof value === "object") {
    for (const [childKey, child] of Object.entries(value)) scanJson(child, `${pointer}/${escapePointer(childKey)}`, file, findings, childKey);
  }
}

function walk(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, {withFileTypes: true})) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

export function evaluatePrivacy(bundlePath) {
  const root = path.resolve(bundlePath);
  const findings = [];
  for (const filePath of walk(root)) {
    if (path.basename(filePath) === "ready.marker" || fs.statSync(filePath).size > 2 * 1024 * 1024) continue;
    const extension = path.extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const relative = path.relative(root, filePath).split(path.sep).join("/");
    const content = fs.readFileSync(filePath, "utf8");
    if (extension === ".json") {
      try { scanJson(JSON.parse(content), "", relative, findings); }
      catch { for (const [index, line] of content.split(/\r?\n/).entries()) for (const patternId of patternIds(line)) findings.push({pattern_id: patternId, file: relative, location: `line:${index + 1}`, severity: "blocker"}); }
    } else {
      for (const [index, line] of content.split(/\r?\n/).entries()) for (const patternId of patternIds(line)) findings.push({pattern_id: patternId, file: relative, location: `line:${index + 1}`, severity: "blocker"});
    }
  }
  const unique = [...new Map(findings.map((item) => [`${item.pattern_id}|${item.file}|${item.location}`, item])).values()]
    .sort((left, right) => `${left.file}|${left.location}|${left.pattern_id}`.localeCompare(`${right.file}|${right.location}|${right.pattern_id}`));
  return {status: unique.length ? "blocked" : "pass", tags: [...new Set(unique.map((item) => item.pattern_id))].sort(), findings: unique};
}
