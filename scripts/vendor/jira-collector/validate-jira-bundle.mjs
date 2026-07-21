#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const REQUIRED_FILES = [
  "manifest.json",
  "issue.raw.json",
  "issue.normalized.json",
  "ticket.md",
  "collection-status.json",
  "attachments/manifest.json",
  "links/manifest.json",
];

export function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function normalizedContentHash(issue) {
  const payload = structuredClone(issue);
  delete payload.content_hash;
  delete payload.quality;
  if (payload.source) {
    delete payload.source.fetched_at;
    delete payload.source.issue_updated_at;
  }
  return sha256(stableJson(payload));
}

function readJson(file, errors) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push({code: "invalid_json", path: file, message: error.message});
    return null;
  }
}

function requiredObject(value, key, at, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({code: "schema", path: at, message: `${key} must be an object`});
    return null;
  }
  if (!(key in value)) {
    errors.push({code: "schema", path: at, message: `missing ${key}`});
    return null;
  }
  return value[key];
}

function requireFields(value, fields, at, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push({code: "schema", path: at, message: "must be an object"});
    return;
  }
  for (const field of fields) {
    if (!(field in value)) errors.push({code: "schema", path: at, message: `missing ${field}`});
  }
}

function isSafeRelative(rel) {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return false;
  const normalized = path.posix.normalize(rel.replaceAll("\\", "/"));
  return normalized !== ".." && !normalized.startsWith("../");
}

function validateManifest(manifest, errors) {
  requireFields(manifest, ["schema_version", "collector", "ingest_id", "source", "files", "content_hash", "created_at"], "manifest.json", errors);
  if (!manifest) return;
  if (manifest.schema_version !== "1.0.0") errors.push({code: "schema_version", path: "manifest.json", message: "expected 1.0.0"});
  if (!/^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8,64}$/.test(manifest.ingest_id || "")) errors.push({code: "ingest_id", path: "manifest.json", message: "invalid ingest_id"});
  if (!/^[a-f0-9]{64}$/.test(manifest.content_hash || "")) errors.push({code: "content_hash", path: "manifest.json", message: "invalid content_hash"});
  requireFields(manifest.collector, ["name", "version"], "manifest.json#collector", errors);
  requireFields(manifest.source, ["base_url", "deployment_type", "issue_id", "issue_key", "browse_url", "fetched_at", "issue_updated_at"], "manifest.json#source", errors);
  if (manifest.source && !/^[A-Z][A-Z0-9_]*-[0-9]+$/.test(manifest.source.issue_key || "")) errors.push({code: "issue_key", path: "manifest.json#source", message: "invalid Jira issue key"});
}

function validateNormalized(issue, errors) {
  requireFields(issue, ["schema_version", "source", "ticket", "custom_fields", "comments", "attachments", "links", "collection", "provenance", "content_hash", "quality"], "issue.normalized.json", errors);
  if (!issue) return;
  if (issue.schema_version !== "1.0.0") errors.push({code: "schema_version", path: "issue.normalized.json", message: "expected 1.0.0"});
  requireFields(issue.ticket, ["summary", "status", "issue_type", "labels", "components", "versions", "fix_versions", "subtasks", "issue_links"], "issue.normalized.json#ticket", errors);
  for (const key of ["custom_fields", "comments", "attachments", "links", "provenance"]) {
    if (!Array.isArray(issue[key])) errors.push({code: "schema", path: `issue.normalized.json#${key}`, message: "must be an array"});
  }
  const customIds = new Set();
  for (const [index, field] of (issue.custom_fields || []).entries()) {
    requireFields(field, ["id", "name", "schema_type", "value"], `custom_fields[${index}]`, errors);
    if (customIds.has(field.id)) errors.push({code: "duplicate_custom_field_id", path: `custom_fields[${index}]`, message: field.id});
    customIds.add(field.id);
  }
  for (const [index, comment] of (issue.comments || []).entries()) {
    requireFields(comment, ["id", "author", "created", "updated", "visibility", "body_markdown", "links", "attachment_refs", "media_refs"], `comments[${index}]`, errors);
  }
  for (const [index, attachment] of (issue.attachments || []).entries()) {
    requireFields(attachment, ["id", "original_filename", "safe_filename", "size", "declared_mime", "detected_mime", "sha256", "download_status", "relative_path"], `attachments[${index}]`, errors);
    if (attachment.safe_filename !== path.basename(attachment.safe_filename || "") || /[\\/]/.test(attachment.safe_filename || "")) errors.push({code: "unsafe_attachment_filename", path: `attachments[${index}]`, message: "safe_filename contains a path"});
    if (attachment.relative_path && !isSafeRelative(attachment.relative_path)) errors.push({code: "unsafe_path", path: `attachments[${index}]`, message: attachment.relative_path});
  }
  const actual = normalizedContentHash(issue);
  if (issue.content_hash !== actual) errors.push({code: "normalized_hash_mismatch", path: "issue.normalized.json", message: `expected ${actual}`});
}

export function validateBundle(bundlePath, {requireReady = true} = {}) {
  const root = path.resolve(bundlePath);
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return {valid: false, bundle: root, errors: [{code: "bundle_missing", path: root, message: "bundle directory not found"}], warnings};
  if (requireReady && !fs.existsSync(path.join(root, "ready.marker"))) errors.push({code: "ready_marker_missing", path: "ready.marker", message: "bundle is incomplete"});
  for (const rel of REQUIRED_FILES) if (!fs.existsSync(path.join(root, rel))) errors.push({code: "required_file_missing", path: rel, message: "required file not found"});
  const manifest = fs.existsSync(path.join(root, "manifest.json")) ? readJson(path.join(root, "manifest.json"), errors) : null;
  const issue = fs.existsSync(path.join(root, "issue.normalized.json")) ? readJson(path.join(root, "issue.normalized.json"), errors) : null;
  const collection = fs.existsSync(path.join(root, "collection-status.json")) ? readJson(path.join(root, "collection-status.json"), errors) : null;
  const attachments = fs.existsSync(path.join(root, "attachments/manifest.json")) ? readJson(path.join(root, "attachments/manifest.json"), errors) : null;
  const links = fs.existsSync(path.join(root, "links/manifest.json")) ? readJson(path.join(root, "links/manifest.json"), errors) : null;
  validateManifest(manifest, errors);
  validateNormalized(issue, errors);
  requireFields(collection, ["steps", "unsupported_adf_nodes", "permission_gaps"], "collection-status.json", errors);
  if (!Array.isArray(attachments?.attachments)) errors.push({code: "schema", path: "attachments/manifest.json", message: "attachments must be an array"});
  if (!Array.isArray(links?.links)) errors.push({code: "schema", path: "links/manifest.json", message: "links must be an array"});
  if (manifest?.files && typeof manifest.files === "object") {
    for (const [rel, expected] of Object.entries(manifest.files)) {
      if (!isSafeRelative(rel)) { errors.push({code: "unsafe_path", path: "manifest.json#files", message: rel}); continue; }
      const file = path.join(root, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { errors.push({code: "referenced_file_missing", path: rel, message: "manifest reference missing"}); continue; }
      const actual = sha256(fs.readFileSync(file));
      if (actual !== expected) errors.push({code: "file_hash_mismatch", path: rel, message: `expected ${actual}`});
    }
  }
  if (manifest && issue && manifest.content_hash !== issue.content_hash) errors.push({code: "content_hash_disagreement", path: "manifest.json", message: "manifest and normalized issue differ"});
  for (const attachment of issue?.attachments || []) {
    if (attachment.download_status === "downloaded" && attachment.relative_path) {
      const file = path.join(root, attachment.relative_path);
      if (!fs.existsSync(file)) errors.push({code: "attachment_missing", path: attachment.relative_path, message: "downloaded attachment not found"});
      else if (attachment.sha256 && sha256(fs.readFileSync(file)) !== attachment.sha256) errors.push({code: "attachment_hash_mismatch", path: attachment.relative_path, message: "sha256 differs"});
    }
  }
  return {valid: errors.length === 0, bundle: root, schema_version: manifest?.schema_version || null, issue_key: manifest?.source?.issue_key || null, ingest_id: manifest?.ingest_id || null, errors, warnings};
}

function parseArgs(argv) {
  const args = {json: false, requireReady: true};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--bundle") args.bundle = argv[++i];
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--allow-incomplete") args.requireReady = false;
    else if (argv[i] === "--help") args.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return args;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (error) { console.error(error.message); return 2; }
  if (args.help || !args.bundle) {
    console.log("Usage: validate-jira-bundle.mjs --bundle <path> [--json] [--allow-incomplete]");
    return args.help ? 0 : 2;
  }
  const result = validateBundle(args.bundle, {requireReady: args.requireReady});
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else if (result.valid) console.log(`valid Jira bundle: ${result.issue_key} (${result.ingest_id})`);
  else {
    console.error(`invalid Jira bundle: ${result.errors.length} error(s)`);
    for (const error of result.errors) console.error(`- ${error.code} ${error.path}: ${error.message}`);
  }
  return result.valid ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) process.exitCode = main();
