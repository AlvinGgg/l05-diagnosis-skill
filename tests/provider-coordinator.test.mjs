import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {executeEvidencePlan, resolveComponentPlacement, resolveKubectlCluster, resolveLokiGateway, validateEvidencePlan} from "../scripts/provider-coordinator.mjs";

function issue() {
  return {
    source: {issue_key: "DEMO-1"},
    ticket: {
      summary: "APIM request failed",
      description_markdown: "Investigate request req-123456",
      environment: "example-qa-a",
      components: ["apim"],
    },
    comments: [
      {author: {display_name: "Automation Bot"}, body_markdown: "ignore this generated comment"},
      {author: {display_name: "Requester"}, body_markdown: "request failed"},
    ],
    custom_fields: [],
    links: [],
  };
}

function plan(overrides = {}) {
  return {
    schema_version: "l05-evidence-plan/v1",
    case_id: "DEMO-1",
    evidence_question: "Did the request reach APIM?",
    cluster_alias: "example-qa-a",
    time_anchor: {
      start: "2026-07-28T02:00:00Z",
      end: "2026-07-28T02:02:00Z",
      source: "jira_event_timestamp",
    },
    targets: [{
      target_id: "apim",
      role: "primary-application",
      application: "demo-app",
      filters: {exact_terms: ["req-123456"], fuzzy_terms: [], error_only: false},
      limit: 5,
      triggered_by: ["jira:request_id"],
    }],
    budget: {
      max_log_queries: 2,
      max_tenants: 2,
      max_scan_bytes: 1048576,
      max_entries: 10,
    },
    ...overrides,
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "l05-coordinator-"));
  const providerDir = path.join(root, "providers");
  fs.mkdirSync(providerDir);
  const providerScript = path.join(providerDir, "fixture-provider.mjs");
  fs.writeFileSync(providerScript, `
import crypto from "node:crypto";
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(input);
  const records = [];
  if (request.provider_id === "loki") {
    if (request.issue.comments.some((item) => /Automation Bot/.test(item.author?.display_name || ""))) process.exit(9);
    const cluster = request.context.resolved_cluster.cluster_alias;
    const source = request.context.resolved_cluster.gateway_source;
    if (source === "kubectl_candidate") {
      const probe = request.context.gateway_probe;
      const start = Date.parse(probe?.time_anchor?.start);
      const end = Date.parse(probe?.time_anchor?.end);
      if (probe?.schema_version !== "l05-gateway-health-probe/v1"
        || probe?.tenant_id !== probe?.application
        || !Number.isFinite(start)
        || !Number.isFinite(end)
        || end <= start
        || end - start > 60_000) process.exit(10);
    }
    const provenance = {provider:"loki",access_mode:"read-only",cluster_alias:cluster,gateway_source:source,tls_verified:true,collected_at:new Date().toISOString()};
    const gateway = request.config.gateways.find((item) => item.cluster_ref === cluster).gateway_url;
    if (request.capabilities.includes("loki.gateway.health")) records.push({capability:"loki.gateway.health",evidence_type:"loki_gateway_health",summary:"healthy",confidence:"confirmed",data:{ready:true,gateway_entry_fingerprint:crypto.createHash("sha256").update(gateway).digest("hex")},provenance});
    for (const target of request.context.evidence_plan?.targets || []) {
      if (target.application === "apigw-access"
        && (target.tenant_id !== "gateway-access-logs" || !Array.isArray(target.stream_selector_candidates))) process.exit(12);
      if (target.application === "gateway-plugin-logs"
        && (target.tenant_id !== "gateway-plugin-logs"
          || target.stream_selector_candidates?.[0]?.label !== "plugin_name"
          || target.stream_selector_candidates?.[0]?.value !== "example-policy-plugin")) process.exit(13);
      if (request.capabilities.includes("loki.stream.selector.resolve")) records.push({capability:"loki.stream.selector.resolve",evidence_type:"loki_stream_selector_resolution",summary:"selector resolved",confidence:"confirmed",data:{target_id:target.target_id,candidate_labels:(target.stream_selector_candidates || [target.stream_selector]).map((item) => item.label),attempts:[{label:(target.stream_selector_candidates || [target.stream_selector])[0].label,outcome:"selected"}],selected_label:(target.stream_selector_candidates || [target.stream_selector])[0].label,cache_scope:"provider_process_memory"},provenance});
      if (request.capabilities.includes("loki.index.stats")) records.push({capability:"loki.index.stats",evidence_type:"loki_index_stats",summary:"bounded estimate",confidence:"confirmed",data:{target_id:target.target_id,bytes:512},provenance});
      if (request.capabilities.includes("loki.logs.query_excerpt")) records.push({capability:"loki.logs.query_excerpt",evidence_type:"loki_log_excerpt",summary:"one redacted entry",confidence:"confirmed",data:{target_id:target.target_id,entry_count:1,entries:[{message:"[matched-token]"}],stats:{totalBytesProcessed:512}},provenance});
      if (request.capabilities.includes("loki.logs.topk_api_status")) {
        if (target.tenant_id !== "apim" || target.stream_selector?.label !== "apiId") process.exit(11);
        records.push({capability:"loki.logs.topk_api_status",evidence_type:"loki_topk_api_status",summary:"top three APIs",confidence:"confirmed",data:{target_id:target.target_id,complete:true,completed_partitions:13,total_partitions:13,matched_entries:3850,top_k:[{api_id:"example-api-one",count:2350},{api_id:"example-api-two",count:960},{api_id:"example-api-three",count:430}],scan:{actual_bytes_processed:4096}},provenance});
      }
    }
  } else if (request.provider_id === "kubectl") {
    const cluster = request.context.resolved_cluster_ref;
    if (cluster === "example-blocked-qa") {
      process.stdout.write(JSON.stringify({schema_version:"l05-provider-response/v1",provider_id:"kubectl",status:"blocked",evidence_records:[],candidates:[],gaps:["gateway_discovery_blocked"]}));
      return;
    }
    const ruleHost = cluster === "example-new-qa" ? "new-loki.example.test" : "loki.example.test";
    const provenance = {provider:"kubectl",access_mode:"read-only",context_alias:cluster,approved_kubeconfig:true,tls_verified:true,collected_at:new Date().toISOString()};
    records.push({capability:"k8s.loki_gateway.resolve",evidence_type:"kubernetes_loki_gateway_candidate",summary:"one candidate",confidence:"confirmed",data:{cluster_alias:cluster,namespace:"loki",ingress_name:"loki-gateway",ingress_uid_fingerprint:"sha256:fixture",resource_version:"17",rule_host:ruleHost,tls_host_match:true,path:"/",backend_service:"loki-gateway",ingress_class:"nginx"},provenance});
  }
  process.stdout.write(JSON.stringify({schema_version:"l05-provider-response/v1",provider_id:request.provider_id,status:"ok",evidence_records:records,candidates:[],gaps:[]}));
});
`);
  const capabilities = {
    loki: ["loki.gateway.health", "loki.stream.selector.resolve", "loki.index.stats", "loki.logs.query_excerpt", "loki.logs.topk_api_status"],
    kubectl: ["k8s.loki_gateway.resolve", "k8s.application.identity"],
  };
  for (const [providerId, values] of Object.entries(capabilities)) {
    fs.writeFileSync(path.join(providerDir, `${providerId}.json`), JSON.stringify({
      schema_version: "l05-provider-manifest/v1",
      provider_id: providerId,
      display_name: providerId,
      command: [process.execPath, providerScript],
      capabilities: values,
      request_schema: "l05-provider-request/v1",
      response_schema: "l05-provider-response/v1",
    }));
  }
  const profile = JSON.parse(fs.readFileSync(path.join(path.dirname(new URL(import.meta.url).pathname), "../assets/vault-template/.l05-profile.json"), "utf8"));
  profile.optional_evidence_providers = [{
      provider_id: "loki",
      enabled: true,
      capabilities: capabilities.loki,
      match: {problem_types: ["gateway.*"], match_mode: "any"},
      config: {
        gateways: [{
          cluster_ref: "example-qa-a",
          gateway_url: "https://loki.example.test",
        }, {
          cluster_ref: "example-prod-a",
          gateway_url: "https://prod-loki.example.test",
        }, {
          cluster_ref: "example-prod-b",
          gateway_url: "https://devops-loki.example.test",
        }],
      },
    }, {
      provider_id: "kubectl",
      enabled: true,
      capabilities: capabilities.kubectl,
      match: {problem_types: ["gateway.*"], match_mode: "any"},
      config: {routes: [{
        id: "example-qa-a",
        match: {keywords: ["example-qa-a", "qa-a"], match_mode: "any"},
        cluster_alias: "example-qa-a",
      }, {
        id: "example-prod-a",
        match: {keywords: ["example-prod-a"], match_mode: "any"},
        cluster_alias: "example-prod-a",
      }, {
        id: "example-prod-b",
        match: {keywords: ["example-prod-b"], match_mode: "any"},
        cluster_alias: "example-prod-b",
      }, {
        id: "example-new-qa",
        match: {keywords: ["example-new-qa"], match_mode: "any"},
        cluster_alias: "example-new-qa",
      }, {
        id: "example-blocked-qa",
        match: {keywords: ["example-blocked-qa"], match_mode: "any"},
        cluster_alias: "example-blocked-qa",
      }]},
    }];
  profile.observability = {
    component_log_placements: [{
      id: "apim-prod",
      component: "apim",
      environment_keywords: ["prod"],
      cluster_ref: "example-prod-a",
      tenant_id: "apim",
      stream_selector: {label: "apiId", match: "nonempty"},
      stream_selector_candidates: [
        {label: "apiId", value_source: "log_identity"},
        {label: "application", value_source: "application"},
      ],
    }, {
      id: "apigw-access-prod",
      component: "apigw-access",
      environment_keywords: ["prod"],
      cluster_ref: "example-prod-b",
      tenant_id: "gateway-access-logs",
      stream_selector: {label: "apiId", match: "nonempty"},
      stream_selector_candidates: [
        {label: "apis", value_source: "log_identity"},
        {label: "apiId", value_source: "log_identity"},
        {label: "application", value_source: "application"},
      ],
    }, {
      id: "apigw-plugin-prod",
      component: "gateway-plugin-logs",
      environment_keywords: ["prod"],
      cluster_ref: "example-prod-b",
      tenant_id: "gateway-plugin-logs",
      stream_selector: {label: "apiId", match: "nonempty"},
      stream_selector_candidates: [
        {label: "plugin_name", value_source: "fixed", value: "example-policy-plugin"},
        {label: "application", value_source: "application"},
      ],
    }],
  };
  fs.writeFileSync(path.join(root, ".l05-profile.json"), JSON.stringify(profile));
  return {root, providerDir};
}

test("Evidence Plan rejects transport fields and unsafe broad unfiltered queries", () => {
  assert.equal(validateEvidencePlan({...plan(), url: "https://other.example.test"}).valid, false);
  const broad = plan();
  broad.targets[0].filters.exact_terms = [];
  broad.targets[0].limit = 6;
  const validation = validateEvidencePlan(broad);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes("target_0_line_filter_missing"));
});

test("Evidence Plan accepts only backward correlation dependencies", () => {
  const correlated = plan();
  correlated.targets.push({
    target_id: "plugin",
    role: "gateway-plugin",
    application: "gateway-plugin-logs",
    correlation_from: "apim",
    filters: {exact_terms: [], fuzzy_terms: [], error_only: false},
    limit: 5,
    triggered_by: ["provider:apim/correlation"],
  });
  assert.equal(validateEvidencePlan(correlated).valid, true);
  correlated.targets[1].correlation_from = "future-target";
  assert.equal(validateEvidencePlan(correlated).valid, false);
});

test("Evidence Plan accepts a label-independent log identity but rejects caller label selection", () => {
  const value = plan();
  value.targets[0].log_identity = {value: "example-backend", source: "url_path"};
  assert.equal(validateEvidencePlan(value).valid, true);
  value.targets[0].log_identity.label = "apis";
  assert.equal(validateEvidencePlan(value).valid, false);
});

test("Kubectl owns aliases and Loki resolves only the canonical cluster ref", () => {
  const routes = [{
    id: "example-qa-a",
    match: {keywords: ["example-qa-a", "QA-A"], match_mode: "any"},
    cluster_alias: "example-qa-a",
  }];
  const gateways = [{
    cluster_ref: "example-qa-a",
    gateway_url: "https://loki.example.test",
  }];
  assert.equal(resolveKubectlCluster(routes, "qa-a").cluster_ref, "example-qa-a");
  assert.equal(resolveKubectlCluster([...routes, {...routes[0], id: "other", cluster_alias: "other"}], "QA-A").status, "ambiguous");
  assert.equal(resolveLokiGateway(gateways, "example-qa-a").gateway.cluster_ref, "example-qa-a");
  assert.equal(resolveLokiGateway(gateways, "qa-a").status, "missing");
});

test("component placement resolves a broad environment only for the named component", () => {
  const routes = [
    {match: {keywords: ["prod"]}, cluster_alias: "example-prod-a"},
    {match: {keywords: ["prod"]}, cluster_alias: "example-prod-b"},
  ];
  const placements = [{
    component: "apim",
    environment_keywords: ["prod"],
    cluster_ref: "example-prod-a",
    tenant_id: "apim",
  }];
  assert.equal(resolveKubectlCluster(routes, "prod").status, "ambiguous");
  assert.equal(resolveComponentPlacement(placements, "apim", "prod", routes).cluster_ref, "example-prod-a");
  assert.equal(resolveComponentPlacement(placements, "apim", "example-prod-b", routes).status, "missing");
});

test("coordinator resolves APIM prod placement and records fixed TopK capability", async () => {
  const {root, providerDir} = fixture();
  const evidencePlan = plan({
    cluster_alias: "prod",
    time_anchor: {
      start: "2026-07-27T16:00:00Z",
      end: "2026-07-27T17:00:00Z",
      source: "user_time_window",
    },
    targets: [{
      target_id: "apim",
      role: "api-management",
      application: "apim",
      filters: {exact_terms: [], fuzzy_terms: [], error_only: false},
      limit: 3,
      triggered_by: ["user:apim-400-alert"],
      aggregation: {kind: "topk-api-status", status_code: 400, top_k: 3},
    }],
    budget: {
      max_log_queries: 13,
      max_tenants: 1,
      max_scan_bytes: 1048576,
      max_entries: 200,
    },
  });
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan,
    providerDir,
    timeoutMs: 5000,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual(result.inspection_steps.map((item) => item.capability), [
    "loki.gateway.health",
    "loki.stream.selector.resolve",
    "loki.logs.topk_api_status",
  ]);
  const record = result.responses[0].evidence_records.find((item) => item.capability === "loki.logs.topk_api_status");
  assert.equal(record.provenance.cluster_alias, "example-prod-a");
  assert.equal(result.budget.used.log_queries, 13);
  assert.equal(result.budget.used.scan_bytes, 4096);
});

test("ordinary APIGW request-id query uses the component tenant and devops cluster", async () => {
  const {root, providerDir} = fixture();
  const evidencePlan = plan({
    cluster_alias: "prod",
    targets: [{
      target_id: "apigw-access",
      role: "gateway-access",
      application: "apigw-access",
      filters: {exact_terms: ["request-123456"], fuzzy_terms: [], error_only: false},
      limit: 5,
      triggered_by: ["jira:request_id"],
    }],
  });
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan,
    providerDir,
    timeoutMs: 5000,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  const record = result.responses[0].evidence_records.find((item) => item.capability === "loki.logs.query_excerpt");
  assert.equal(record.provenance.cluster_alias, "example-prod-b");
});

test("APIGW URL identity expands to Profile-owned apis fallback candidates", async () => {
  const {root, providerDir} = fixture();
  const evidencePlan = plan({
    cluster_alias: "prod",
    targets: [{
      target_id: "apigw-access",
      role: "gateway-access",
      application: "apigw-access",
      log_identity: {value: "example-backend", source: "url_path"},
      filters: {exact_terms: ["example-backend"], fuzzy_terms: [], error_only: false},
      limit: 1,
      triggered_by: ["user:url"],
    }],
  });
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan,
    providerDir,
    timeoutMs: 5000,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  const record = result.responses[0].evidence_records.find((item) => item.capability === "loki.stream.selector.resolve");
  assert.deepEqual(record.data.candidate_labels, ["apis", "apiId", "application"]);
  assert.equal(record.data.selected_label, "apis");
});

test("APIGW plugin expands the private fixed plugin_name candidate", async () => {
  const {root, providerDir} = fixture();
  const evidencePlan = plan({
    cluster_alias: "prod",
    targets: [{
      target_id: "apigw-plugin",
      role: "gateway-plugin",
      application: "gateway-plugin-logs",
      filters: {exact_terms: ["req-123456"], fuzzy_terms: [], error_only: false},
      limit: 5,
      triggered_by: ["provider:apigw-access/correlation"],
    }],
  });
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan,
    providerDir,
    timeoutMs: 5000,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  const record = result.responses[0].evidence_records.find(
    (item) => item.capability === "loki.stream.selector.resolve",
  );
  assert.deepEqual(record.data.candidate_labels, ["plugin_name", "application"]);
  assert.equal(record.data.selected_label, "plugin_name");
});

test("coordinator serially runs the Profile-selected Loki route and records every step", async () => {
  const {root, providerDir} = fixture();
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan: plan(),
    providerDir,
    timeoutMs: 5000,
  });
  assert.equal(result.status, "ok");
  assert.equal(result.responses.length, 1);
  assert.deepEqual(result.inspection_steps.map((item) => item.capability), [
    "loki.gateway.health",
    "loki.stream.selector.resolve",
    "loki.index.stats",
    "loki.logs.query_excerpt",
  ]);
  assert.equal(result.budget.used.log_queries, 1);
  assert.equal(result.budget.used.tenants, 1);
  assert.equal(result.budget.used.scan_bytes, 512);
  assert.equal(result.budget.used.entries, 1);
});

test("authorized typed discovery adds a Gateway for a known canonical cluster before querying Loki", async () => {
  const {root, providerDir} = fixture();
  const evidencePlan = plan({cluster_alias: "example-new-qa"});
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan,
    providerDir,
    timeoutMs: 5000,
    authorizeProfileUpdate: true,
  });
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.deepEqual(result.inspection_steps.slice(0, 3).map((item) => item.capability), [
    "k8s.loki_gateway.resolve",
    "loki.gateway.health",
    "profile.loki_gateway.reconcile",
  ]);
  const profile = JSON.parse(fs.readFileSync(path.join(root, ".l05-profile.json"), "utf8"));
  assert.equal(profile.optional_evidence_providers[0].config.gateways.at(-1).cluster_ref, "example-new-qa");
  assert.equal(result.responses.at(-1).evidence_records.some((record) => record.capability === "loki.logs.query_excerpt"), true);
});

test("known cluster without a Gateway stops after bounded Kubectl discovery and never calls Loki", async () => {
  const {root, providerDir} = fixture();
  const result = await executeEvidencePlan({
    kbRoot: root,
    issue: issue(),
    evidencePlan: plan({cluster_alias: "example-blocked-qa"}),
    providerDir,
    timeoutMs: 5000,
  });
  assert.equal(result.status, "blocked");
  assert.deepEqual(result.responses.map((response) => response.provider_id), ["kubectl"]);
  assert.ok(result.gaps.includes("gateway_discovery_blocked"));
  assert.deepEqual(result.inspection_steps.map((item) => item.capability), ["k8s.loki_gateway.resolve"]);
});
