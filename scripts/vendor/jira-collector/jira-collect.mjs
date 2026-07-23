#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {collectFixture, collectJira} from "./headless-collector.mjs";
import {JiraClient} from "./jira-client.mjs";
import {validateBundle} from "./validate-jira-bundle.mjs";
import {loadJiraToken} from "./env-loader.mjs";

const VERSION = "1.0.0";
const TEMP_ROOT = path.join(os.tmpdir(), "jira-structured-collector");
const SENTINEL = ".jira-structured-collector-owned";
const EXIT = {ok: 0, partial: 10, config: 2, token: 3, auth: 4, network: 5, schema: 6, security: 7};
const redact = (value) => String(value || "").replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]").replace(/Basic\s+[^\s"']+/gi, "Basic [redacted]").replace(/(?:token|secret|password|signature)=[^&\s]+/gi, "$1=[redacted]");
function errorDetail(error) {
  const message = String(error?.message || error || "unknown error");
  const code = error?.cause?.code || error?.code || (error?.name === "AbortError" ? "TIMEOUT" : "");
  const host = error?.cause?.hostname || error?.hostname || "";
  const suffix = [code, host].filter(Boolean).join(" ");
  return redact(suffix && !message.includes(suffix) ? `${message} (${suffix})` : message);
}
const envelope = (args) => ({schema_version: "1.0.0", collector_version: VERSION, run_id: args.runId, mode: args.mode, temporary: args.temporary, status: args.status, output_root: args.outputRoot, collection_manifest_path: args.collectionManifestPath || null, issues: args.issues || [], summary: args.summary || {requested: 0, succeeded: 0, partial: 0, failed: 0, skipped: 0}});
function parse(argv) {
  const out = {attachmentMode: "metadata", rawPolicy: "redacted", pageSize: 50, concurrency: 1, timeout: 30000};
  out.command = argv.shift();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!key.startsWith("-") && !out.target) out.target = key;
    else if (key === "--issue") out.issue = argv[++i]; else if (key === "--jql") out.jql = argv[++i]; else if (key === "--limit") out.limit = Number(argv[++i]);
    else if (key === "--output-dir") out.outputDir = path.resolve(argv[++i]); else if (key === "--base-url") out.baseUrl = argv[++i]; else if (key === "--page-size") out.pageSize = Number(argv[++i]);
    else if (key === "--attachment-mode") out.attachmentMode = argv[++i]; else if (key === "--raw-policy") out.rawPolicy = argv[++i]; else if (key === "--auth-mode") out.authMode = argv[++i]; else if (key === "--email") out.email = argv[++i];
    else if (key === "--fixture") out.fixture = path.resolve(argv[++i]); else if (key === "--retain") out.retain = true; else if (key === "--older-than-hours") out.olderThanHours = Number(argv[++i]); else if (key === "--help") out.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  return out;
}
function issueResult(key, bundle, status = "ok", warnings = []) {
  const normalized = bundle ? path.join(bundle, "issue.normalized.json") : null;
  return {issue_key: key, source_updated_at: normalized && fs.existsSync(normalized) ? JSON.parse(fs.readFileSync(normalized)).source.issue_updated_at : null, status, bundle_path: bundle, normalized_issue_path: normalized, markdown_path: bundle ? path.join(bundle, "ticket.md") : null, collection_status_path: bundle ? path.join(bundle, "collection-status.json") : null, warnings};
}
function assertConfig(args, mode) {
  if (mode === "issue" && !args.issue) throw new Error("--issue is required");
  if (mode === "jql" && (!args.jql || !Number.isInteger(args.limit) || args.limit < 1 || !args.outputDir)) throw new Error("--jql, positive --limit and --output-dir are required");
  if (!["none", "metadata", "all"].includes(args.attachmentMode)) throw new Error("invalid --attachment-mode");
  if (!["omit", "redacted", "full"].includes(args.rawPolicy)) throw new Error("invalid --raw-policy");
  if (!args.baseUrl) args.baseUrl = process.env.JIRA_BASE_URL;
  if (!args.baseUrl) throw new Error("JIRA_BASE_URL or --base-url is required");
  if (!args.authMode) args.authMode = process.env.JIRA_AUTH_MODE || "bearer";
  if (!args.email) args.email = process.env.JIRA_EMAIL;
  if (!["bearer", "basic"].includes(args.authMode)) throw new Error("invalid --auth-mode");
  if (args.authMode === "basic" && !args.email && !args.fixture) throw new Error("JIRA_EMAIL or --email is required for basic authentication");
}
async function collectOne(args, issue, outputRoot, stateFile) {
  const result = args.fixture ? await collectFixture(JSON.parse(fs.readFileSync(args.fixture, "utf8")), {outputMode: "inbox-bundle", outputRoot, stateFile, attachmentMode: args.attachmentMode === "metadata" ? "metadata-only" : args.attachmentMode === "none" ? "off" : "all", rawPolicy: args.rawPolicy}) : await collectJira(issue, {baseUrl: args.baseUrl, authMode: args.authMode, email: args.email, outputMode: "inbox-bundle", outputRoot, stateFile, attachmentMode: args.attachmentMode === "metadata" ? "metadata-only" : args.attachmentMode === "none" ? "off" : "all", rawPolicy: args.rawPolicy});
  return result;
}
async function issueMode(args) {
  if (!process.env.JIRA_TOKEN && !args.fixture) { console.error("JIRA_TOKEN is required"); return [envelope({runId: args.runId, mode: "issue", temporary: true, status: "failed", outputRoot: null, issues: [issueResult(args.issue, null, "failed", ["token_missing"])], summary: {requested: 1, succeeded: 0, partial: 0, failed: 1, skipped: 0}}), EXIT.token]; }
  fs.mkdirSync(TEMP_ROOT, {recursive: true});
  const root = args.retain ? path.resolve(args.outputDir || fs.mkdtempSync(path.join(TEMP_ROOT, `${args.issue}-`))) : fs.mkdtempSync(path.join(TEMP_ROOT, `${args.issue}-`));
  fs.mkdirSync(root, {recursive: true}); fs.writeFileSync(path.join(root, SENTINEL), "owned\n");
  try { const result = await collectOne(args, args.issue, path.join(root, "bundles"), path.join(root, "state.json")); const item = issueResult(args.issue, result.bundle); return [envelope({runId: args.runId, mode: "issue", temporary: !args.retain, status: "ok", outputRoot: root, issues: [item], summary: {requested: 1, succeeded: 1, partial: 0, failed: 0, skipped: 0}}), EXIT.ok]; }
  catch (error) { const item = issueResult(args.issue, null, "failed", [errorDetail(error)]); if (!args.retain) fs.rmSync(root, {recursive: true, force: true}); return [envelope({runId: args.runId, mode: "issue", temporary: !args.retain, status: "failed", outputRoot: root, issues: [item], summary: {requested: 1, succeeded: 0, partial: 0, failed: 1, skipped: 0}}), EXIT.network]; }
}
async function jqlMode(args) {
  if (!process.env.JIRA_TOKEN && !args.fixture) { console.error("JIRA_TOKEN is required"); return [envelope({runId: args.runId, mode: "jql", temporary: false, status: "failed", outputRoot: args.outputDir, summary: {requested: 0, succeeded: 0, partial: 0, failed: 1, skipped: 0}}), EXIT.token]; }
  fs.mkdirSync(args.outputDir, {recursive: true}); const state = path.join(args.outputDir, ".collector-state.json"); const client = args.fixture ? null : new JiraClient({baseUrl: args.baseUrl, request: async (url, opts = {}) => { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), opts.timeoutMs || args.timeout); try { const r = await fetch(url, {headers: {Accept: "application/json", Authorization: args.authMode === "basic" ? `Basic ${Buffer.from(`${args.email || process.env.JIRA_EMAIL || ""}:${process.env.JIRA_TOKEN}`, "utf8").toString("base64")}` : `Bearer ${process.env.JIRA_TOKEN}`}, signal: controller.signal}); return {status: r.status, headers: Object.fromEntries(r.headers), text: await r.text(), get json() { try { return JSON.parse(this.text); } catch { return null; } }}; } finally { clearTimeout(timer); } }});
  const search = args.fixture ? {values: [JSON.parse(fs.readFileSync(args.fixture, "utf8")).issue]} : await client.searchAll(args.jql, ["summary", "updated"], args.pageSize); const selected = search.values.slice(0, args.limit); const issues = []; let succeeded = 0, failed = 0;
  for (const [index, issue] of selected.entries()) { try { const result = args.fixture ? await collectOne(args, issue.key, args.outputDir, state) : await collectOne({...args, fixture: null}, issue.key, args.outputDir, state); issues.push(issueResult(issue.key, result.bundle)); succeeded++; console.error(`jira-collect ${index + 1}/${selected.length} ${issue.key}: ${result.outcome}`); } catch (error) { const detail = errorDetail(error); issues.push(issueResult(issue.key, null, "failed", [detail])); failed++; console.error(`jira-collect ${issue.key}: ${detail}`); } }
  const status = failed ? (succeeded ? "partial" : "failed") : "ok"; const result = envelope({runId: args.runId, mode: "jql", temporary: false, status, outputRoot: args.outputDir, issues, summary: {requested: selected.length, succeeded, partial: 0, failed, skipped: 0}}); const manifest = path.join(args.outputDir, `collection-${args.runId}.json`); fs.writeFileSync(manifest, JSON.stringify(result, null, 2) + "\n"); result.collection_manifest_path = manifest; return [result, failed ? (succeeded ? EXIT.partial : EXIT.network) : EXIT.ok];
}
function cleanup(target) { const resolved = path.resolve(target || ""); const temp = path.resolve(TEMP_ROOT); if (!resolved.startsWith(`${temp}${path.sep}`) || fs.existsSync(resolved) && fs.lstatSync(resolved).isSymbolicLink() || !fs.existsSync(path.join(resolved, SENTINEL))) throw new Error("refusing cleanup outside owned temporary root"); fs.rmSync(resolved, {recursive: true, force: true}); return {removed: resolved}; }
function purge(hours) { const cutoff = Date.now() - hours * 3600000; const removed = []; if (!fs.existsSync(TEMP_ROOT)) return removed; for (const name of fs.readdirSync(TEMP_ROOT)) { const p = path.join(TEMP_ROOT, name); if (fs.existsSync(path.join(p, SENTINEL)) && fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, {recursive: true, force: true}); removed.push(p); } } return removed; }
async function main() { const args = parse(process.argv.slice(2)); loadJiraToken(); args.runId = crypto.randomUUID(); if (args.help) { console.error("jira-collect issue --issue KEY | jql --jql QUERY --limit N --output-dir DIR | validate PATH | cleanup PATH | purge-temp --older-than-hours N"); return EXIT.ok; } try { if (args.command === "validate") { const result = validateBundle(path.resolve(args.target || args.outputDir)); console.log(JSON.stringify(result)); return result.valid ? EXIT.ok : EXIT.schema; } if (args.command === "cleanup") { console.log(JSON.stringify(cleanup(args.target || args.outputDir))); return EXIT.ok; } if (args.command === "purge-temp") { console.log(JSON.stringify({removed: purge(args.olderThanHours)})); return EXIT.ok; } assertConfig(args, args.command); const [result, code] = args.command === "issue" ? await issueMode(args) : await jqlMode(args); console.log(JSON.stringify(result)); return code; } catch (error) { console.error(errorDetail(error)); console.log(JSON.stringify(envelope({runId: args.runId, mode: args.command, temporary: args.command === "issue", status: "failed", outputRoot: args.outputDir || null, summary: {requested: 0, succeeded: 0, partial: 0, failed: 1, skipped: 0}}))); return EXIT.config; } }
main().then((code) => { process.exitCode = code; });
