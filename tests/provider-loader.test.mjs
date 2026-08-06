import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {collectOptionalEvidence, discoverProviderManifests, extractKubernetesApplication, extractKubernetesDomain, extractKubernetesLocator, extractKubernetesScope, extractKubernetesTarget, inferProblemType, invokeProvider, providerEntryMatches, rancherPlatformAccessRequiresSre, rancherUseBoundary, validateProviderManifest} from "../scripts/provider-loader.mjs";

const EVIDENCE_QUESTION = {
  source: "Jira DEMO-1",
  locator: "jira:DEMO-1",
  question: "Inspect the current evidence that can narrow this case.",
  expected_effect: "supports_or_contradicts_hypothesis",
};

function issue(summary = "Jenkins pipeline build failed") {
  return {
    source: {issue_key: "DEMO-1", fetched_at: "2026-07-22T00:00:00Z"},
    ticket: {summary, description_markdown: "Jenkins build https://jenkins.example.test/job/demo/3/ failed", environment: "qa", components: ["cicd"]},
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

test("Rancher resource views are Kubernetes locators, while Rancher platform access stays an SRE handoff", () => {
  const resourceView = {
    ...issue("Rancher shows a restarting Pod"),
    ticket: {
      summary: "Rancher shows a restarting Pod",
      description_markdown: "Rancher URL: https://rancher.example.test/k8s/clusters/c-1/api/v1/namespaces/demo/pods/demo-api-7d8f9d5cf5-x2k9p",
      environment: "qa",
      components: ["kubernetes"],
    },
  };
  assert.equal(inferProblemType(resourceView), "kubernetes.runtime");
  assert.deepEqual(extractKubernetesTarget(resourceView), {namespace: "demo", kind: "Pod", name: "demo-api-7d8f9d5cf5-x2k9p"});
  assert.equal(rancherPlatformAccessRequiresSre(resourceView), false);
  assert.deepEqual(rancherUseBoundary(resourceView), {mode: "kubernetes_observation", allow_browser: false, allow_api: false});
  const permissionIssue = {...resourceView, ticket: {...resourceView.ticket, description_markdown: "Rancher 平台提示当前用户没有项目权限，无法登录控制台。"}};
  assert.equal(rancherPlatformAccessRequiresSre(permissionIssue), true);
  assert.deepEqual(rancherUseBoundary(permissionIssue), {mode: "sre_handoff", allow_browser: false, allow_api: false});
  for (const description_markdown of [
    "Rancher 账号不可用。",
    "需要申请 Rancher 项目角色授权。",
    "Rancher 控制面能力不可用。",
  ]) {
    assert.equal(rancherUseBoundary({...resourceView, ticket: {...resourceView.ticket, description_markdown}}).mode, "sre_handoff");
  }
});

test("namespace plus applicationName forms a bounded abnormal-Pod scope when no Pod is named", () => {
  const current = {
    ...issue("application errors after deployment"),
    ticket: {
      summary: "application errors after deployment",
      description_markdown: "namespace: demo; please inspect the abnormal pods",
      environment: "qa",
      components: ["kubernetes"],
    },
    custom_fields: [{name: "applicationName", value: "demo-api"}],
  };
  assert.equal(extractKubernetesTarget(current), null);
  assert.deepEqual(extractKubernetesScope(current), {namespace: "demo", application: "demo-api"});
  const mappedScope = {...current, ticket: {...current.ticket, description_markdown: "please inspect the abnormal pods"}, custom_fields: [{name: "Namespace", value: "demo"}, {name: "applicationName", value: "demo-api"}]};
  assert.deepEqual(extractKubernetesScope(mappedScope, {namespace: ["Namespace"]}), {namespace: "demo", application: "demo-api"});
});

test("structured option-with-child maps Domain and child Application without parent fallback", () => {
  const current = {
    ...issue("Kubernetes application is unhealthy"),
    ticket: {
      summary: "Kubernetes application is unhealthy",
      description_markdown: "Please inspect the abnormal Pods in the approved cluster.",
      environment: "PROD",
      components: ["kubernetes"],
    },
    custom_fields: [{
      name: "Domain Application",
      schema_type: "option-with-child",
      value: {value: "example-domain", child: {value: "example-app"}},
    }],
  };
  const mappings = {
    field_mappings: {domain: ["Domain Application"], application: ["Domain Application"]},
    field_value_paths: {domain: ["value"], application: ["child.value"]},
  };
  assert.equal(extractKubernetesDomain(current, mappings), "example-domain");
  assert.equal(extractKubernetesApplication(current, mappings), "example-app");
  assert.deepEqual(extractKubernetesLocator(current, mappings), {application: "example-app"});
  assert.equal(extractKubernetesApplication(current, {field_mappings: {application: ["Domain Application"]}}), "");
});

test("Locator precedence favors explicit Namespace, Pod name, then Workload name", () => {
  const namespaceIssue = {
    ...issue("Kubernetes Pod is unhealthy"),
    ticket: {summary: "Kubernetes Pod is unhealthy", description_markdown: "namespace is payments; workload: payments-api", environment: "qa", components: ["kubernetes"]},
    custom_fields: [],
  };
  assert.deepEqual(extractKubernetesLocator(namespaceIssue), {namespace: "payments", workload_name: "payments-api"});
  const podIssue = {
    ...namespaceIssue,
    ticket: {...namespaceIssue.ticket, description_markdown: "please inspect pod: payments-api-7f9d8c6b4d-x2k9p"},
  };
  assert.deepEqual(extractKubernetesLocator(podIssue), {pod_name: "payments-api-7f9d8c6b4d-x2k9p"});
});

test("loader routes a Namespace and applicationName scope through the Profile cluster directory", async () => {
  const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), "l05-kubectl-scope-provider-"));
  const script = path.join(providerDir, "kubectl.mjs");
  fs.writeFileSync(script, `
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  process.stdout.write(JSON.stringify({
    schema_version: "l05-provider-response/v1",
    provider_id: "kubectl",
    status: "ok",
    evidence_records: [{capability: "k8s.pod.anomalies", evidence_type: "fixture", summary: "scoped", confidence: "confirmed", data: request.context.kubernetes_scope, provenance: {access_mode: "read-only"}}],
    candidates: [], gaps: []
  }));
});
`);
  fs.writeFileSync(path.join(providerDir, "kubectl.json"), JSON.stringify({
    schema_version: "l05-provider-manifest/v1",
    provider_id: "kubectl",
    display_name: "fixture",
    command: [process.execPath, script],
    capabilities: ["k8s.pod.anomalies"],
    request_schema: "l05-provider-request/v1",
    response_schema: "l05-provider-response/v1",
  }));
  const kbRoot = vault({
    jira: {field_mappings: {application: ["applicationName"]}},
    cluster_directory: {routes: [{
      id: "example-qa",
      match: {environment: ["qa"], subscription: ["example-subscription"], cloud: "azure"},
      cluster_aliases: ["example-qa"],
    }]},
    optional_evidence_providers: [{
      provider_id: "kubectl",
      enabled: true,
      capabilities: ["k8s.pod.anomalies"],
      match: {problem_types: ["kubernetes.*"], match_mode: "any"},
      config: {},
    }],
  });
  const current = {
    ...issue("Kubernetes application is unhealthy"),
    ticket: {summary: "Kubernetes application is unhealthy", description_markdown: "namespace: demo", environment: "qa", components: ["kubernetes"]},
    custom_fields: [{name: "Subscription", value: "example-subscription"}, {name: "applicationName", value: "demo-api"}],
  };
  const result = await collectOptionalEvidence({kbRoot, issue: current, providerDir, evidenceQuestion: EVIDENCE_QUESTION});
  assert.equal(result.responses.length, 1);
  assert.deepEqual(result.responses[0].evidence_records[0].data, {namespace: "demo", application: "demo-api"});
  assert.equal(result.provider_decisions[0].cluster_ref, "example-qa");
});

test("Application locator isolates no-match candidate responses before evidence promotion", async () => {
  const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), "l05-kubectl-candidates-provider-"));
  const script = path.join(providerDir, "kubectl.mjs");
  fs.writeFileSync(script, `
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const matched = request.context.resolved_cluster_ref === "candidate-b";
  process.stdout.write(JSON.stringify(matched ? {
    schema_version: "l05-provider-response/v1",
    provider_id: "kubectl",
    status: "ok",
    locator: {status: "matched", mode: "application_namespace_label", namespace: "example-app"},
    evidence_records: [{capability: "k8s.pod.anomalies", evidence_type: "fixture", summary: "selected", confidence: "confirmed", data: {cluster: "candidate-b"}, provenance: {access_mode: "read-only"}}],
    candidates: [], gaps: []
  } : {
    schema_version: "l05-provider-response/v1",
    provider_id: "kubectl",
    status: "no_match",
    locator: {status: "no_match", mode: "application_namespace_label", gap: "application_not_found_in_candidate"},
    evidence_records: [], candidates: [], gaps: ["application_not_found_in_candidate"]
  }));
});
`);
  fs.writeFileSync(path.join(providerDir, "kubectl.json"), JSON.stringify({
    schema_version: "l05-provider-manifest/v1",
    provider_id: "kubectl",
    display_name: "fixture",
    command: [process.execPath, script],
    capabilities: ["k8s.pod.anomalies"],
    request_schema: "l05-provider-request/v1",
    response_schema: "l05-provider-response/v1",
  }));
  const kbRoot = vault({
    jira: {
      field_mappings: {domain: ["Domain Application"], application: ["Domain Application"], environment: ["Environment for SRE"], subscription: ["Subscription"]},
      field_value_paths: {domain: ["value"], application: ["child.value"]},
    },
    cluster_directory: {routes: [
      {id: "candidate-a", match: {environment: ["example-prod"], subscription: ["example-subscription"], cloud: "azure"}, cluster_aliases: ["candidate-a"]},
      {id: "candidate-b", match: {environment: ["example-prod"], subscription: ["example-subscription"], cloud: "azure"}, cluster_aliases: ["candidate-b"]},
    ]},
    optional_evidence_providers: [{
      provider_id: "kubectl",
      enabled: true,
      capabilities: ["k8s.pod.anomalies"],
      match: {problem_types: ["kubernetes.*"], match_mode: "any"},
      config: {},
    }],
  });
  const current = {
    ...issue("Kubernetes application is unhealthy"),
    ticket: {summary: "Kubernetes application is unhealthy", description_markdown: "inspect abnormal Pods", environment: "PROD", components: ["kubernetes"]},
    custom_fields: [
      {name: "Environment for SRE", value: "example-prod"},
      {name: "Subscription", value: "example-subscription"},
      {name: "Domain Application", schema_type: "option-with-child", value: {value: "example-domain", child: {value: "example-app"}}},
    ],
  };
  const result = await collectOptionalEvidence({kbRoot, issue: current, providerDir, evidenceQuestion: EVIDENCE_QUESTION});
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].evidence_records[0].data.cluster, "candidate-b");
  assert.equal(result.provider_decisions[0].reason, undefined);
  assert.deepEqual(result.provider_decisions[0].candidate_results.map((item) => item.locator_status), ["no_match", "matched"]);
  assert.ok(!JSON.stringify(result.responses).includes("application_not_found_in_candidate"));
});

test("gateway symptoms and resolution comments do not route an unrelated CI Provider", async () => {
  const current = {
    ...issue("Swagger CORS failure"),
    ticket: {summary: "Swagger CORS failure", description_markdown: "https://api.example.test/orders is blocked by CORS preflight access control.", environment: "qa", components: ["apim"]},
    comments: [{id: "resolution", body_markdown: "当前已针对 Swagger 发布完成配置，请等待生效。", author: {display_name: "SRE"}}],
  };
  const kbRoot = vault({optional_evidence_providers: [{provider_id: "fixture", enabled: true, capabilities: ["ci.build.resolve"], match: {keywords: ["发布"], match_mode: "any"}, config: {}}]});
  assert.equal(inferProblemType(current), "gateway.request");
  assert.equal(providerEntryMatches(JSON.parse(fs.readFileSync(path.join(kbRoot, ".l05-profile.json"), "utf8")).optional_evidence_providers[0], current), false);
  const result = await collectOptionalEvidence({kbRoot, issue: current, providerDir: providerDirectory("process.stdin.resume();"), evidenceQuestion: EVIDENCE_QUESTION});
  assert.deepEqual(result.responses, []);
  assert.deepEqual(result.gaps, []);
});

test("CI Provider defers when no exact Job, Build, or Task locator exists", async () => {
  const current = {...issue(), ticket: {summary: "Jenkins pipeline failed", description_markdown: "Jenkins pipeline failed after deployment", environment: "qa", components: ["cicd"]}};
  const kbRoot = vault({optional_evidence_providers: [{provider_id: "fixture", enabled: true, capabilities: ["ci.build.resolve"], match: {problem_types: ["cicd.*"], match_mode: "any"}, config: {}}]});
  const result = await collectOptionalEvidence({kbRoot, issue: current, providerDir: providerDirectory("process.stdin.resume();"), evidenceQuestion: EVIDENCE_QUESTION});
  assert.deepEqual(result.responses, []);
  assert.ok(result.gaps.includes("provider_deferred_missing_exact_locator:fixture"));
  assert.equal(result.provider_decisions[0].reason, "missing_exact_locator");
});

test("Provider invocation requires a bound evidence question", async () => {
  const kbRoot = vault({optional_evidence_providers: [{provider_id: "fixture", enabled: true, capabilities: ["ci.build.resolve"], match: {problem_types: ["cicd.*"], match_mode: "any"}, config: {}}]});
  const result = await collectOptionalEvidence({kbRoot, issue: issue(), providerDir: providerDirectory("process.stdin.resume();")});
  assert.deepEqual(result.responses, []);
  assert.ok(result.gaps.includes("provider_deferred_missing_evidence_question:fixture"));
  assert.equal(result.provider_decisions[0].reason, "missing_evidence_question");
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
  const result = await collectOptionalEvidence({kbRoot, issue: issue(), providerDir, evidenceQuestion: EVIDENCE_QUESTION, env: {...process.env, FIXTURE_TOKEN: "private-fixture-token"}});
  assert.equal(result.responses.length, 1);
  assert.equal(result.responses[0].status, "ok");
  assert.equal(result.responses[0].evidence_records[0].summary, "[redacted]");
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-token/);
});

test("missing matched provider becomes an evidence gap", async () => {
  const kbRoot = vault({optional_evidence_providers: [{provider_id: "missing", enabled: true, capabilities: ["ci.build.resolve"], match: {keywords: ["jenkins"], match_mode: "any"}, config: {}}]});
  const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), "l05-empty-providers-"));
  const result = await collectOptionalEvidence({kbRoot, issue: issue(), providerDir, evidenceQuestion: EVIDENCE_QUESTION});
  assert.deepEqual(result.responses, []);
  assert.ok(result.gaps.includes("provider_not_installed:missing"));
});

test("parseable blocked responses survive a provider non-zero exit", async () => {
  const directory = providerDirectory(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({
    schema_version: "l05-provider-response/v1",
    provider_id: "fixture",
    status: "blocked",
    evidence_records: [],
    candidates: [],
    gaps: ["fixture_blocked"]
  }));
  process.exitCode = 2;
});
`);
  const manifest = discoverProviderManifests(directory).providers.get("fixture");
  const response = await invokeProvider(manifest, {
    schema_version: "l05-provider-request/v1",
    request_id: "fixture",
    provider_id: "fixture",
    capabilities: ["ci.build.resolve"],
    issue: {},
    context: {},
    config: {},
  });
  assert.equal(response.status, "blocked");
  assert.deepEqual(response.gaps, ["fixture_blocked"]);
});

test("generic optional evidence defers Loki until an Evidence Plan exists", async () => {
  const kbRoot = vault({
    optional_evidence_providers: [
      {
        provider_id: "loki",
        enabled: true,
        capabilities: ["loki.logs.query_excerpt"],
        match: {problem_types: ["cicd.*"], match_mode: "any"},
        config: {gateways: []},
      },
    ],
  });
  const result = await collectOptionalEvidence({
    kbRoot,
    issue: issue(),
    providerDir: fs.mkdtempSync(path.join(os.tmpdir(), "l05-empty-providers-")),
    evidenceQuestion: EVIDENCE_QUESTION,
  });
  assert.deepEqual(result.responses, []);
  assert.deepEqual(result.deferred_providers, ["loki"]);
  assert.deepEqual(result.gaps, []);
});
