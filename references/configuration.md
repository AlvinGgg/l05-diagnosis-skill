# L0.5 Diagnosis Configuration

Keep all organization-specific values outside the public Skill. Do not store secrets in the Skill, Vault, Profile, test fixtures, logs, or commands.

## First-time setup

Immediately after installation, run `scripts/l05_setup.py doctor`. If it
returns `needs_setup`, preserve its complete `configuration_chain`, follow the
ordered `setup_actions`, and read `getting-started.md` for the relevant action.
Initialize a new empty Vault with `scripts/l05_setup.py init`, update the
private configuration, validate the Vault Profile, and rerun `doctor`. Do not
handle a real case until it returns `ready`.

When Kubectl is configured, review `doctor`'s Provider capability drift and
Kubernetes Locator migration warnings as part of readiness. A ready result
should include the `k8s.pod.anomalies` capability, the CMDB child-value
mapping, and a Profile `cluster_directory` before Application-only discovery
is used.

## Required configuration

- `JIRA_BASE_URL`: Jira site URL.
- `JIRA_TOKEN`: read-only Jira token or PAT. Never print it.
- `JIRA_AUTH_MODE`: `bearer` or `basic`.
- `JIRA_EMAIL`: required only for Basic authentication.
- `L05_OBSIDIAN_VAULT`: absolute path to the local Vault.

`PAAS_KB_ROOT` remains a legacy-compatible alias for an existing Vault. New installations should use `L05_OBSIDIAN_VAULT`.

Every machine-specific path must stay outside the public Skill. Supply paths
through a CLI argument, process environment, or private local configuration.
Never copy resolved user paths into Skill source, bundled templates, tests,
durable reports, or public documentation.

## Vault Profile

`<Vault>/.l05-profile.json` contains only non-secret knowledge-path mappings,
optional Jira semantic field mappings, Repository metadata, and deterministic
routing rules. It is separate from the private environment file. A new Vault
receives a generic empty Profile; an existing Vault can create one with:

```bash
python3 scripts/l05_profile.py init --vault /absolute/path/to/vault
python3 scripts/l05_profile.py validate --vault /absolute/path/to/vault
```

The internal Schema is `references/schemas/l05-profile.schema.json`; users normally edit the generated example instead of the Schema. Repository URLs must rely on SSH Agent or Git Credential Helper and must not contain credentials, query parameters, or fragments.

Missing Repository entries only limit automatic code routing. Invalid Profile JSON, unsafe paths, unknown routing targets, or secret-shaped fields must be fixed before the Profile is used.

### Retrieval paths and approved entry guides

New Profiles include `knowledge.wiki_sources_general` for top-level curated
Source pages and `knowledge.raw_files` for immutable source documents such as
an approved automation-entry guide. Keep both values Vault-relative and
non-secret. The Core may resolve an explicit `wiki/sources/...` link in
`index.md` even when a legacy Profile does not list the top-level Source folder,
so an existing Vault remains readable without a forced Profile rewrite.

`doctor` emits `indexed_source_outside_search_paths:<path>` when the index
links an existing Source page outside the configured Source paths. It is a
read-only warning, not permission to change the Vault automatically: review the
source and add its logical path to the private Profile only when it is intended
for normal retrieval. Raw entry-guide material must come from a configured
`raw_files` path or be paired with an index-linked Source page, and must supply
an exact, safe self-service match before it can defer SRE work. Its Service
Desk URL must be HTTPS on the current Jira host; a broad keyword or generic
portal link is insufficient.

### Optional Jira semantic field mappings

Map organization custom field IDs or names to public semantic slots without
putting organization identifiers in the Skill:

```json
{
  "jira": {
    "field_mappings": {
      "domain": ["Domain Application"],
      "application": ["Domain Application"],
      "request_type": ["customfield_12345"],
      "question_classification": ["Question Classification"],
      "issue_category": ["customfield_67890"],
      "environment": ["Environment"]
    }
  }
}
```

Allowed slots are `domain`, `application`, `event_timestamp`, `request_type`,
`question_classification`, `issue_category`, `environment`, `request_id`,
`namespace`, `source_environment`, `subscription`, and `target_environment`. Selectors must
be unique, non-empty strings. These mappings are auxiliary intent and Evidence
Plan signals; explicit user environment information takes precedence, and no
mapping proves root cause or current configuration.

For Jira option-with-child fields, add
`field_value_paths` so the parent and child meanings cannot be confused:

```json
{
  "jira": {
    "field_mappings": {
      "domain": ["Domain Application"],
      "application": ["Domain Application"]
    },
    "field_value_paths": {
      "domain": ["value"],
      "application": ["child.value"]
    }
  }
}
```

The Core treats `child.value` as the Application for this field and never
falls back to the parent `value` for Kubernetes lookup. A private Profile may
use other safe dotted paths for organization-specific structured fields.

## Optional Evidence Providers

Providers are local optional packages, not bundled enterprise behavior. Install each Provider Manifest under `~/.codex/l05-diagnosis/providers.d/`, keep its credentials in `~/.codex/l05-diagnosis.env`, and add only non-secret routing and settings to the Vault `.l05-profile.json`.

The Core supports `L05_PROVIDER_DIR` to override the Manifest directory for tests or managed installations. Do not put Tokens, passwords, cookies, private keys, or authenticated URLs in the Profile. See `provider-contract.md` and the independent Provider package instructions.

The local Kubectl Provider is an exception to generic credential discovery:
it accepts only the kubeconfig path pinned by its installer in a private local
policy, stores the non-secret locked policy at
`~/.codex/l05-diagnosis/kubectl-policy.json`, and exposes no kubeconfig
override. Keep context names and Namespace allowlists in that `0600` policy.
Cluster selection belongs to the Profile's top-level `cluster_directory`, not
to the Kubectl Provider. It combines current `Environment for SRE` and
`Subscription`, defaults to Azure, and uses an explicit `aliyun` branch only
for Aliyun/ACK tickets. Each rule may name at most two approved canonical
aliases; the locked Kubectl policy remains the only alias-to-private-context
mapping.

```json
{
  "cluster_directory": {
    "routes": [
      {
        "id": "example-qa",
        "match": {
          "environment": ["qa"],
          "subscription": ["example-subscription"],
          "cloud": "azure"
        },
        "cluster_aliases": ["example-qa"]
      }
    ]
  }
}
```

The Kubectl Provider config is normally empty. It must not contain
Namespace/Application/business hints, kubeconfig, context, server, identity,
TLS, command, argument, selector, template, or raw API override fields.
Legacy `config.routes` is accepted only to keep existing Profiles working while
they migrate to `cluster_directory`.

```json
{
  "provider_id": "kubectl",
  "enabled": true,
  "capabilities": ["k8s.context.health", "k8s.pod.anomalies", "k8s.pod.logs_excerpt", "k8s.loki_gateway.resolve"],
  "match": {
    "problem_types": ["gateway.*", "kubernetes.*"],
    "match_mode": "any"
  },
  "config": {}
}
```

For a Rancher Kubernetes observation or resource URL, Core extracts only safe
locator text and calls the same Kubectl Provider. It never opens Rancher in a
browser, inspects it as a link, calls the Rancher API, or authenticates.
Rancher login, account, authorization, role, project, or cluster-control-plane
permission requests are an SRE handoff instead. Locator resolution follows
this order: an explicit Namespace is a hard boundary; an exact Pod name uses a
structured all-Namespace `metadata.name` lookup when Namespace is absent; a
Workload name uses bounded owner-reference or safe `<workload>-` name matching;
and an Application request first selects Namespace objects with the fixed
`application=<application>` label, requires one unique Namespace, then selects
only Pods in that Namespace with the same fixed label. It never falls back to
unlabeled Pods. Each query is capped and structured (the implementation does
not execute shell `grep`), and no-match/ambiguous candidates are not evidence.

### Loki Provider Profile

Install the independent Loki Provider with a private locked DNS-suffix policy.
The Vault Profile contains only the cluster/Gateway directory:

```json
{
  "provider_id": "loki",
  "enabled": true,
  "capabilities": [
    "loki.gateway.health",
    "loki.stream.selector.resolve",
    "loki.index.stats",
    "loki.logs.query_excerpt",
    "loki.logs.topk_api_status"
  ],
  "match": {
    "problem_types": ["gateway.*", "kubernetes.*", "support.*"],
    "match_mode": "any"
  },
  "config": {
    "auto_gateway_reconciliation": true,
    "gateways": [
      {
        "cluster_ref": "example-qa",
        "gateway_url": "https://logs.example.test"
      }
    ]
  }
}
```

Do not add tenant, component, application, label, query, header, authentication,
or budget mappings to this Provider config. Ordinary application identity comes
from current Jira/user evidence or typed Kubectl evidence. Public component
placement is a separate Core-owned Profile section:

```json
{
  "observability": {
    "component_log_placements": [
      {
        "id": "example-gateway-prod",
        "component": "example-gateway",
        "environment_keywords": ["prod"],
        "cluster_ref": "example-prod",
        "tenant_id": "example-gateway-tenant",
        "stream_selector": {"label": "apiId", "match": "nonempty"},
        "stream_selector_candidates": [
          {"label": "plugin_name", "value_source": "fixed", "value": "example-plugin"},
          {"label": "apis", "value_source": "log_identity"},
          {"label": "apiId", "value_source": "log_identity"},
          {"label": "application", "value_source": "application"}
        ]
      }
    ]
  }
}
```

Each placement must reference a canonical cluster already present in
`cluster_directory` (or a legacy Kubectl route while migrating). Selector candidates are tried in order after Loki reports the
tenant's keys for the exact query window. `log_identity` is a value such as an
API name derived from a URL or Jira evidence; the Evidence Plan cannot choose
the label. A `fixed` value is allowed only in this private enterprise component
placement and is still verified through tenant label-key and label-value
discovery before any log query. Discovery caches remain only in the current
Provider process. The placement is not part of Kubectl routing or Loki Gateway
config.

If a cluster entry is missing or stale, Core may perform one locked Kubectl
Gateway discovery and one fixed readiness check. With
`auto_gateway_reconciliation: true`, Core applies the resulting single-entry
update only after fresh matching evidence, backup, atomic write, validation,
and reload. With the switch absent or false, it stops at the auditable preview
unless the operator explicitly uses:

```bash
python3 scripts/l05_profile.py reconcile-loki-gateway \
  --vault /absolute/path/to/vault \
  --evidence-file /absolute/path/to/typed-reconciliation-evidence.json
```

Apply only after explicit authorization by adding `--apply`. The command
requires fresh matching Kubectl and Loki health evidence, creates a backup,
writes atomically, and validates the reloaded Profile. It never changes the
cluster.

## Optional configuration

- `L05_CODE_ROOTS`: explicitly enabled local code roots, separated by the OS path separator.
- `L05_DEFAULT_BRANCH`: explicit branch used only when the operator requests local Repository synchronization.
- `L05_GITHUB_ACTIONS_WORKFLOW_REPO`: optional local workflow Repository.
- `L05_CACHE_DIR`: cache root for isolated remote Git mirrors.
- `L05_JIRA_COMMENT_EXCLUDE_REGEX`: automation or system-comment filter override.
- `L05_PROVIDER_DIR`: optional local Provider Manifest directory override.

Do not define a universal Jira URL, Vault path, code root, Repository, or default branch in the public Skill.

## Private configuration file

Use `~/.codex/l05-diagnosis.env`, or set `L05_CONFIG_FILE` to another private
file. File permissions must deny group and other access; `0600` is the
recommended mode. `doctor` treats broader permissions as a setup blocker.

Precedence is:

```text
process environment
-> explicit L05_CONFIG_FILE
-> ~/.codex/l05-diagnosis.env
-> literal JIRA_TOKEN assignment in ~/.zshrc (legacy only)
```

Shell profiles are parsed as text only and never executed. Do not use command substitution in the configuration file.

## CLI overrides

```bash
python3 scripts/fetch_jira_issue.py ABC-123 --base-url https://jira.example.com
python3 scripts/search_obsidian.py "timeout" --vault /absolute/path/to/vault
python3 scripts/git_snapshot.py --repo-url https://git.example.com/org/platform.git --ref release-1 --query timeout
python3 scripts/search_local_code.py --query timeout --root /absolute/path/to/code --no-sync
```

Explicit CLI paths apply only to the current case. Never pass credentials as CLI arguments.

## Failure behavior

Missing Jira access blocks issue understanding and all later diagnosis steps. The blocked result must include a sanitized technical detail, a stable failure code, request and retry counts, whether retries were exhausted, and checks specific to configuration, authentication, permission, issue visibility, DNS, TLS, timeout, or service availability.

The Collector retries DNS, connection, timeout, HTTP 429, and HTTP 5xx failures up to three times with bounded exponential backoff. It does not retry local configuration, TLS, HTTP 401, HTTP 403, or HTTP 404 failures.

When the Agent runtime explicitly reports disabled or restricted network access, run the initial read-only Collector command with network permission instead of first executing it in a context known to fail. Issue that permitted shell command through a direct `exec_command` call. Do not nest it inside `functions.exec`, a composition tool, or another orchestration wrapper: an approval may complete without returning the resumed command output to the inner call. If restriction is discovered only after a normal attempt, rerun the same command directly with network permission. Count a network-permitted retry only after the tool returns a non-empty, parseable Collector result; blank, interrupted, approval-pending, or rejected calls are not completed retries. Retry a blank or interrupted permitted command up to three actual executions. Return a blocked result only after the permitted execution completes and its internal retries are exhausted, or after permission is explicitly denied.

Authentication and permission failures must not be misreported as network failures. Missing Vault configuration blocks retrieval. Missing optional code, browser, or attachment access creates an Evidence Gap but does not authorize a substitute write or guess.
