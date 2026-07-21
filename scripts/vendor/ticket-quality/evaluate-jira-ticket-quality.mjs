#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {evaluatePrivacy} from "./privacy-gate.mjs";
import {decide, evaluateQuality} from "./quality-model.mjs";
import {writeReport} from "./output-writer.mjs";
import {validateBundle} from "../jira-collector/validate-jira-bundle.mjs";

const SCHEMA_VERSION = "1.0.0";
const EXIT = {ok: 0, config: 2, collection: 3, privacy: 4, threshold: 5};

function parse(argv) {
  const args = {command: argv[0], scoringVersion: "1.0.0", json: false};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--bundle") args.bundle = path.resolve(argv[++index]);
    else if (key === "--vault") args.vault = path.resolve(argv[++index]);
    else if (key === "--output-dir") args.outputDir = path.resolve(argv[++index]);
    else if (key === "--scoring-version") args.scoringVersion = argv[++index];
    else if (key === "--fail-on") args.failOn = argv[++index];
    else if (key === "--json") args.json = true;
    else if (key === "--help") args.help = true;
    else throw new Error(`unknown argument: ${key}`);
  }
  if (args.scoringVersion !== "1.0.0") throw new Error(`unsupported scoring version: ${args.scoringVersion}`);
  if (args.failOn && !["blocked", "reject", "hold"].includes(args.failOn)) throw new Error(`invalid --fail-on value: ${args.failOn}`);
  return args;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

function validator(bundle) {
  return validateBundle(bundle);
}

function collectionGate(validation, collection) {
  if (!validation.valid) return {status: "blocked", tags: [...new Set((validation.errors || []).map((item) => item.code || "collector_validation_failed"))].sort()};
  const tags = [];
  const steps = collection?.steps || {};
  if (steps.issue?.status !== "complete") return {status: "blocked", tags: ["core_issue_incomplete"]};
  const comments = steps.comments || {};
  const commentCountsKnown = Number.isFinite(Number(comments.total)) && Number.isFinite(Number(comments.fetched));
  if (["failed", "not_attempted"].includes(comments.status) || (comments.status === "partial" && !commentCountsKnown) || (Number(comments.total) > 0 && Number(comments.fetched) === 0)) return {status: "blocked", tags: ["comments_unavailable"]};
  if (comments.status !== "complete") tags.push("comments_partial");
  for (const name of ["attachments", "links", "changelog"]) if (steps[name]?.status && steps[name].status !== "complete") tags.push(`${name}_partial`);
  if ((collection?.unsupported_adf_nodes || []).length) tags.push("unsupported_adf_nodes");
  if ((collection?.permission_gaps || []).length) tags.push("permission_gaps");
  return {status: tags.length ? "partial" : "pass", tags: tags.sort()};
}

export function evaluateBundle(bundle, {scoringVersion = "1.0.0", outputDir, vault} = {}) {
  const root = path.resolve(bundle);
  const validation = validator(root);
  const manifest = readJson(path.join(root, "manifest.json"));
  const issue = readJson(path.join(root, "issue.normalized.json"));
  const collection = readJson(path.join(root, "collection-status.json"));
  const collectionResult = collectionGate(validation, collection);
  const privacyResult = evaluatePrivacy(root);
  const quality = issue ? evaluateQuality(issue, {collectionStatus: collectionResult.status, privacyStatus: privacyResult.status}) : {
    resolution_quality: {score: 0, level: "failed", tags: ["normalized_issue_missing"]},
    knowledge_value: {score: 0, confidence: "excluded", tags: ["normalized_issue_missing"]},
    facts: {resolved: false, canceled: false, dangerous: false, handoff_heavy: false, prompt_injection: false, probable_diagnosis: false},
    evidence_pointers: [],
  };
  const decisionResult = decide({collectionGate: collectionResult, privacyGate: privacyResult, quality});
  const relativeBundle = vault && root.startsWith(`${path.resolve(vault)}${path.sep}`) ? path.relative(path.resolve(vault), root).split(path.sep).join("/") : root;
  const report = {
    schema_version: SCHEMA_VERSION,
    scoring_version: scoringVersion,
    evaluated_at: new Date().toISOString(),
    issue_key: manifest?.source?.issue_key || issue?.source?.issue_key || validation.issue_key || null,
    ingest_id: manifest?.ingest_id || path.basename(root),
    content_hash: manifest?.content_hash || issue?.content_hash || null,
    bundle_path: relativeBundle,
    collection_gate: collectionResult,
    privacy_gate: privacyResult,
    resolution_quality: quality.resolution_quality,
    knowledge_value: quality.knowledge_value,
    decision: decisionResult.decision,
    source_status: decisionResult.source_status,
    reasons: [...new Set(decisionResult.reasons)].sort(),
    evidence_pointers: quality.evidence_pointers,
  };
  if (outputDir) report.report_files = writeReport(report, outputDir);
  return report;
}

function candidateBundles(root) {
  if (!fs.existsSync(root)) return [];
  const found = [];
  const visit = (directory, depth) => {
    const entries = fs.readdirSync(directory, {withFileTypes: true});
    const files = new Set(entries.filter((item) => item.isFile()).map((item) => item.name));
    const dirs = entries.filter((item) => item.isDirectory());
    if (["ready.marker", "manifest.json", "issue.normalized.json", "collection-status.json"].some((name) => files.has(name)) || (depth >= 3 && dirs.length === 0)) found.push(directory);
    else for (const entry of dirs) visit(path.join(directory, entry.name), depth + 1);
  };
  visit(root, 0);
  return found.sort();
}

function summary(items) {
  const values = {total: items.length, promote_active: 0, promote_needs_review: 0, hold: 0, reject: 0, blocked: 0};
  for (const item of items) {
    if (item.decision === "promote_active" || item.decision === "promote_needs_review") values[item.decision] += 1;
    else if (item.decision === "blocked") values.blocked += 1;
    else if (item.decision.startsWith("reject_")) values.reject += 1;
    else values.hold += 1;
  }
  return values;
}

function failureCode(report, failOn) {
  if (report.collection_gate.status === "blocked") return EXIT.collection;
  if (report.privacy_gate.status === "blocked") return EXIT.privacy;
  if (failOn === "blocked" && report.decision === "blocked") return EXIT.threshold;
  if (failOn === "reject" && (report.decision === "blocked" || report.decision.startsWith("reject_"))) return EXIT.threshold;
  if (failOn === "hold" && !report.decision.startsWith("promote_")) return EXIT.threshold;
  return EXIT.ok;
}

export function run(argv = process.argv.slice(2)) {
  let args;
  try { args = parse(argv); }
  catch (error) { console.error(error.message); console.log(JSON.stringify({schema_version: SCHEMA_VERSION, status: "config_error"})); return EXIT.config; }
  if (args.help) {
    console.error("evaluate-jira-ticket-quality bundle --bundle PATH | inbox --vault PATH");
    console.log(JSON.stringify({schema_version: SCHEMA_VERSION, status: "help"}));
    return EXIT.ok;
  }
  try {
    if (args.command === "bundle") {
      if (!args.bundle) throw new Error("--bundle is required");
      const report = evaluateBundle(args.bundle, args);
      console.log(JSON.stringify({schema_version: SCHEMA_VERSION, status: "ok", mode: "bundle", report}));
      return failureCode(report, args.failOn);
    }
    if (args.command === "inbox") {
      if (!args.vault) throw new Error("--vault is required");
      const root = path.join(args.vault, "inbox/jira");
      const reports = candidateBundles(root).map((bundle) => evaluateBundle(bundle, {...args, outputDir: args.outputDir ? path.join(args.outputDir, new Date().toISOString().slice(0, 10)) : undefined}));
      console.log(JSON.stringify({schema_version: SCHEMA_VERSION, status: "ok", mode: "inbox", vault: args.vault, summary: summary(reports), reports}));
      return EXIT.ok;
    }
    throw new Error("command must be bundle or inbox");
  } catch (error) {
    console.error(error.message);
    console.log(JSON.stringify({schema_version: SCHEMA_VERSION, status: "config_error", mode: args.command || null}));
    return EXIT.config;
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(new URL(import.meta.url).pathname)) process.exitCode = run();
