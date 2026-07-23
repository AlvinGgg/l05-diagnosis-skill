import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {collectOptionalEvidence, discoverProviderManifests, inferProblemType, providerEntryMatches, validateProviderManifest} from "../scripts/provider-loader.mjs";

function issue(summary = "Jenkins pipeline build failed") {
  return {
    source: {issue_key: "DEMO-1", fetched_at: "2026-07-22T00:00:00Z"},
    ticket: {summary, description_markdown: "Build URL is unavailable", environment: "qa", components: ["cicd"]},
    custom_fields: [],
    comments: [],
    links: [],
  };
}

function vault(profile) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l05-provider-vault-"));
  fs.writeFileSync(path.join(root, ".l05-profile.json"), JSON.stringify(profile));
  return root;
}

function providerDirectory(scriptBody) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l05-provider-dir-"));
  const script = path.join(root, "provider.mjs");
  fs.writeFileSync(script, scriptBody);
  const manifest = {
    schema_version: "l05-provider-manifest/v1",
    provider_id: "fixture",
    display_name: "Fixture provider",
    command: [process.execPath, script],
    capabilities: ["ci.build.resolve"],
    request_schema: "l05-provider-request/v1",
    response_schema: "l05-provider-response/v1",
  };
  fs.writeFileSync(path.join(root, "fixture.json"), JSON.stringify(manifest));
  return root;
}

test("provider manifests are strict and duplicate IDs are rejected", () => {
  const invalid = validateProviderManifest({provider_id: "bad id"}, "bad.json");
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.includes("bad.json:invalid_provider_id"));
  const directory = providerDirectory("process.stdin.resume();");
  fs.copyFileSync(path.join(directory, "fixture.json"), path.join(directory, "duplicate.json"));
  const discovery = discoverProviderManifests(directory);
  assert.equal(discovery.providers.size, 1);
  assert.ok(discovery.gaps.some((item) => item.endsWith("duplicate_provider_id")));
});

test("provider routing is problem-aware and remains generic", () => {
  const current = issue();
  assert.equal(inferProblemType(current), "cicd.pipeline_execution");
  assert.equal(providerEntryMatches({enabled: true, match: {problem_types: ["cicd.*"], match_mode: "any"}}, current), true);
  assert.equal(providerEntryMatches({enabled: true, match: {keywords: ["database"], match_mode: "any"}}, current), false);
});

test("loader invokes a matched local provider and removes exact secret values", async () => {
  const providerDir = providerDirectory(`
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    schema_version: "l05-provider-response/v1",
    provider_id: "fixture",
    status: "ok",
    evidence_records: [{capability: request.capabilities[0], evidence_type: "fixture", summary: process.env.FIXTURE_TOKEN, confidence: "confirmed", provenance: {access_mode: "read-only"}}],
    candidates: [],
    gaps: []
  }));
});
`);
  const kbRoot = vault({
    optional_evidence_providers: [{provider_id: "fixture", enabled: true, capabilities: ["ci.build.resolve"], match: {problem_types: ["cicd.*"], match_mode: "any"}, config: {controller: "https://example.test"}}],
  });
  const result = await collectOptionalEvidence({kbRoot, issue: issue(), providerDir, env: {...process.env, FIXTURE_TOKEN: "private-fixture-token"}});
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].status, "ok");
  assert.equal(result.responses[0].evidence_records[0].summary, "[redacted]");
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-token/);
});

test("missing matched provider becomes an evidence gap", async () => {
  const kbRoot = vault({optional_evidence_providers: [{provider_id: "missing", enabled: true, capabilities: ["ci.build.resolve"], match: {keywords: ["jenkins"], match_mode: "any"}, config: {}}]});
  const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), "l05-empty-providers-"));
  const result = await collectOptionalEvidence({kbRoot, issue: issue(), providerDir});
  assert.deepEqual(result.responses, []);
  assert.ok(result.gaps.includes("provider_not_installed:missing"));
});

