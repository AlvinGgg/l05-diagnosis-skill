import os
import json
import hashlib
import re
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_jira_issue import load_missing_l05_env, load_missing_zshrc_env
from inspect_github_actions import inspect, parse_actions_url
from l05_profile import reconcile_loki_gateway, validate_profile
from link_inspector import classify_response, classify_url, redact_url
from safe_preview import preview


class SafetyTests(unittest.TestCase):
    def test_fetcher_prefers_private_l05_config_over_zshrc(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            config = home / ".codex" / "l05-diagnosis.env"
            config.parent.mkdir()
            config.write_text("JIRA_TOKEN='config-token-placeholder'\n", encoding="utf-8")
            (home / ".zshrc").write_text("JIRA_TOKEN='zshrc-token-placeholder'\n", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                token = load_missing_l05_env("JIRA_TOKEN", home)
                self.assertEqual(token, "config-token-placeholder")
                self.assertEqual(os.environ["JIRA_TOKEN"], "config-token-placeholder")

    def test_fetcher_loads_only_literal_token_assignment_from_zshrc(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".zshrc").write_text(
                "export JIRA_TOKEN='fixture-token-placeholder'\n"
                "JIRA_TOKEN=$(read-from-another-file)\n"
                "echo SHOULD_NOT_RUN\n",
                encoding="utf-8",
            )
            with patch.dict(os.environ, {}, clear=True):
                token = load_missing_zshrc_env("JIRA_TOKEN", home)
                self.assertEqual(token, "fixture-token-placeholder")
                self.assertEqual(os.environ["JIRA_TOKEN"], "fixture-token-placeholder")

    def test_http_200_login_page_is_not_accessible(self):
        self.assertEqual(classify_response(200, "https://example.test", "text/html", "Sign in with SSO"), "login_required")

    def test_local_and_metadata_links_are_blocked(self):
        self.assertEqual(classify_url("http://127.0.0.1/admin")["access_status"], "blocked_by_policy")
        self.assertEqual(classify_url("http://169.254.169.254/latest/meta-data")["access_status"], "blocked_by_policy")

    def test_sensitive_query_values_are_redacted(self):
        value = redact_url("https://example.test/path?token=secret-value&view=1")
        self.assertNotIn("secret-value", value)
        self.assertIn("view=1", value)

    def test_binary_preview_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "sample.exe"
            file.write_bytes(b"MZ")
            self.assertEqual(preview(file)["status"], "unsupported")

    def test_github_actions_url_and_secret_alias_routing(self):
        parsed = parse_actions_url("https://github.example.test/example-org/example-app/actions/runs/2972644/job/3400101")
        self.assertEqual(parsed["kind"], "actions_run")
        self.assertEqual(parsed["repository"], "example-app")
        self.assertEqual(parsed["job_id"], "3400101")

        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            subprocess = __import__("subprocess")
            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            workflows = repo / ".github" / "workflows"
            workflows.mkdir(parents=True)
            (workflows / "PROD_DEPLOY.yml").write_text(
                "name: PROD_DEPLOY\n"
                "jobs:\n"
                "  DeployingArtifacts:\n"
                "    name: Deploying Artifacts\n"
                "    steps:\n"
                "      - uses: example-org/platform-actions/.github/actions/file-sync@release-2.2\n"
                "        with:\n"
                "          ARTIFACT_TOKEN: ${{ secrets.ARTIFACT_TOKEN }}\n",
                encoding="utf-8",
            )
            result = inspect(
                repo,
                "https://github.example.test/example-org/example-app/actions/runs/2972644/job/3400101",
                "Deploying Artifacts",
                "deployment artifact sync",
                ["PROD_ARTIFACT_TOKEN"],
                5,
            )
            self.assertEqual(result["matches"][0]["path"], ".github/workflows/PROD_DEPLOY.yml")
            self.assertIn("secret-alias:PROD_ARTIFACT_TOKEN->ARTIFACT_TOKEN", result["matches"][0]["reasons"])
            self.assertEqual(result["matches"][0]["uses_refs"][0]["ref"], "release-2.2")

    def test_new_vault_initialization_is_complete_and_idempotent(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "l05_setup.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = root / "NewVault"
            config = root / "private" / "l05-diagnosis.env"
            first = subprocess.run(
                [sys.executable, str(script), "init", "--vault", str(vault), "--config-file", str(config), "--jira-base-url", "https://jira.example.test"],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(first.returncode, 0, first.stderr)
            result = json.loads(first.stdout)
            self.assertEqual(result["status"], "initialized")
            for relative in ["AGENTS.md", "START_HERE.md", "index.md", "log.md", ".l05-profile.json", "inbox/documents", "inbox/tickets", "inbox/jira", "raw/documents", "raw/tickets", "wiki/sources/documents", "wiki/sources/tickets", "system/templates/source.md"]:
                self.assertTrue((vault / relative).exists(), relative)
            self.assertEqual(config.stat().st_mode & 0o777, 0o600)
            self.assertNotIn("JIRA_TOKEN=", first.stdout)

            agents_before = (vault / "AGENTS.md").read_bytes()
            second = subprocess.run(
                [sys.executable, str(script), "init", "--vault", str(vault), "--config-file", str(config)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(second.returncode, 3)
            self.assertEqual(json.loads(second.stdout)["changed"], False)
            self.assertEqual((vault / "AGENTS.md").read_bytes(), agents_before)

    def test_existing_vault_is_never_modified_by_initializer(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "l05_setup.py"
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory) / "ExistingVault"
            vault.mkdir()
            contract = vault / "AGENTS.md"
            contract.write_text("# existing contract\n", encoding="utf-8")
            before = contract.read_bytes()
            result = subprocess.run(
                [sys.executable, str(script), "init", "--vault", str(vault), "--skip-config"],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 3)
            self.assertEqual(contract.read_bytes(), before)
            self.assertEqual(sorted(item.name for item in vault.iterdir()), ["AGENTS.md"])

    def test_doctor_reports_secret_presence_without_secret_value(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "l05_setup.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = root / "Vault"
            config = root / "l05.env"
            subprocess.run(
                [sys.executable, str(script), "init", "--vault", str(vault), "--config-file", str(config), "--jira-base-url", "https://jira.example.test"],
                text=True,
                capture_output=True,
                check=True,
            )
            config.write_text(config.read_text(encoding="utf-8").replace("JIRA_TOKEN=", "JIRA_TOKEN=fixture-private-value"), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(script), "doctor", "--config-file", str(config)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "ready")
            self.assertEqual(report["jira_token_configured"], True)
            self.assertEqual(report["profile"]["status"], "valid")
            self.assertEqual(report["profile"]["code_routing_configured"], False)
            self.assertEqual(report["providers"]["configured"], [])
            self.assertIn("code_repositories_not_configured", report["warnings"])
            self.assertEqual(report["setup_actions"], [])
            self.assertTrue(all(item["complete"] for item in report["configuration_chain"]))
            self.assertNotIn("fixture-private-value", result.stdout)

    def test_doctor_returns_complete_secret_safe_setup_actions(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "l05_setup.py"
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "l05.env"
            config.write_text(
                "JIRA_BASE_URL=https://jira.example.invalid\n"
                "JIRA_TOKEN=<your-read-only-token>\n"
                "JIRA_AUTH_MODE=basic\n"
                "L05_OBSIDIAN_VAULT=relative-vault\n",
                encoding="utf-8",
            )
            config.chmod(0o644)
            isolated_env = os.environ.copy()
            for name in ("JIRA_BASE_URL", "JIRA_TOKEN", "JIRA_AUTH_MODE", "JIRA_EMAIL", "L05_OBSIDIAN_VAULT", "PAAS_KB_ROOT"):
                isolated_env.pop(name, None)
            result = subprocess.run(
                [sys.executable, str(script), "doctor", "--config-file", str(config)],
                text=True,
                capture_output=True,
                check=False,
                env=isolated_env,
            )
            self.assertEqual(result.returncode, 2, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "needs_setup")
            for blocker in [
                "vault_path_must_be_absolute",
                "profile_missing",
                "jira_token_missing",
                "jira_base_url_missing_or_placeholder",
                "jira_email_missing_for_basic_auth",
                "private_config_permissions_too_open",
            ]:
                self.assertIn(blocker, report["blockers"])
            action_codes = {item["code"] for item in report["setup_actions"]}
            for action in [
                "replace_relative_vault_path",
                "create_vault_profile",
                "configure_jira_connection",
                "set_jira_token_privately",
                "restrict_private_config_permissions",
            ]:
                self.assertIn(action, action_codes)
            self.assertEqual(
                [item["group"] for item in report["setup_actions"]],
                ["knowledge_vault", "regular_configuration", "sensitive_configuration", "sensitive_configuration", "vault_profile"],
            )
            self.assertEqual([item["order"] for item in report["configuration_chain"]], [1, 2, 3, 4, 5, 6])
            self.assertNotIn("<your-read-only-token>", result.stdout)

    def test_public_skill_contains_no_user_bound_absolute_home_paths(self):
        skill = Path(__file__).resolve().parents[1]
        unix_roots = ("/" + "Users" + "/", "/" + "home" + "/")
        windows_root = re.compile(r"[A-Za-z]:\\\\Users\\\\[^\\\\\s]+\\\\")
        violations = []
        for file in skill.rglob("*"):
            if not file.is_file() or any(part in {".git", "__pycache__"} for part in file.parts):
                continue
            try:
                text = file.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                continue
            for root in unix_roots:
                if re.search(re.escape(root) + r"[^/<\s]+/", text):
                    violations.append(file.relative_to(skill).as_posix())
            if windows_root.search(text):
                violations.append(file.relative_to(skill).as_posix())
        self.assertEqual(sorted(set(violations)), [])

    def test_profile_resolves_repository_candidates_without_credentials(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "l05_profile.py"
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
            profile["code"] = {
                "repositories": [
                    {
                        "id": "shared-pipeline",
                        "url": "git@git.example.test:platform/shared-pipeline.git",
                        "roles": ["shared-pipeline"],
                        "default_ref": "main",
                    }
                ],
                "routing_rules": [
                    {
                        "id": "cicd-shared-pipeline",
                        "match": {
                            "problem_types": ["cicd.*"],
                            "keywords": ["pipeline"],
                            "match_mode": "all",
                        },
                        "repositories": ["shared-pipeline"],
                        "reason": "Pipeline execution may depend on shared implementation.",
                    }
                ],
            }
            (vault / ".l05-profile.json").write_text(json.dumps(profile), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(script), "resolve", "--vault", str(vault), "--problem-type", "cicd.pipeline_execution", "--signal", "pipeline failed"],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(output["status"], "matched")
            self.assertEqual(output["candidates"][0]["repository_id"], "shared-pipeline")
            self.assertEqual(output["candidates"][0]["matched_rules"], ["cicd-shared-pipeline"])

    def test_profile_rejects_secret_fields_and_credential_urls(self):
        skill = Path(__file__).resolve().parents[1]
        profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
        profile["code"]["repositories"] = [
            {
                "id": "unsafe-repository",
                "url": "https://user:password@git.example.test/platform/repository.git",
                "roles": ["business-source"],
                "access_token": "fixture-placeholder",
            }
        ]
        validation = validate_profile(profile)
        codes = {item["code"] for item in validation["errors"]}
        self.assertEqual(validation["valid"], False)
        self.assertIn("profile_must_not_contain_secret_fields", codes)
        self.assertIn("repository_url_is_invalid_or_contains_credentials", codes)

    def test_profile_accepts_only_known_non_secret_jira_field_mappings(self):
        skill = Path(__file__).resolve().parents[1]
        profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
        profile["jira"]["field_mappings"] = {
            "request_type": ["customfield_12345", "Customer Request Type"],
            "question_classification": ["customfield_23456"],
            "issue_category": ["customfield_34567"],
            "environment": ["Environment"],
        }
        self.assertTrue(validate_profile(profile)["valid"])

        profile["jira"]["field_mappings"]["unknown_slot"] = ["customfield_99999"]
        profile["jira"]["field_mappings"]["environment"] = []
        validation = validate_profile(profile)
        codes = {item["code"] for item in validation["errors"]}
        self.assertFalse(validation["valid"])
        self.assertIn("jira_field_mapping_slot_is_unknown", codes)
        self.assertIn("jira_field_mapping_selectors_are_invalid", codes)

    def test_profile_accepts_generic_provider_routing_and_rejects_provider_secrets(self):
        skill = Path(__file__).resolve().parents[1]
        profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
        profile["optional_evidence_providers"] = [
            {
                "provider_id": "ci-evidence",
                "enabled": True,
                "capabilities": ["ci.build.resolve"],
                "match": {"problem_types": ["cicd.*"], "match_mode": "any"},
                "config": {"controller": "https://ci.example.test", "tls_verify": True},
            }
        ]
        self.assertTrue(validate_profile(profile)["valid"])
        profile["optional_evidence_providers"][0]["config"]["access_token"] = "fixture-secret"
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn("profile_must_not_contain_secret_fields", {item["code"] for item in validation["errors"]})

    def test_profile_loki_config_contains_only_cluster_gateway_routing(self):
        skill = Path(__file__).resolve().parents[1]
        profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
        provider = {
            "provider_id": "loki",
            "enabled": True,
            "capabilities": [
                "loki.gateway.health",
                "loki.stream.selector.resolve",
                "loki.index.stats",
                "loki.logs.query_excerpt",
            ],
            "match": {"problem_types": ["gateway.*"], "match_mode": "any"},
            "config": {},
        }
        kubectl_provider = {
            "provider_id": "kubectl",
            "enabled": True,
            "capabilities": ["k8s.context.health"],
            "match": {"problem_types": ["gateway.*"], "match_mode": "any"},
            "config": {"routes": [{
                "id": "example-qa-a",
                "match": {"keywords": ["example-qa-a", "qa-a"], "match_mode": "any"},
                "cluster_alias": "example-qa-a",
            }]},
        }
        provider["config"] = {
            "gateways": [{
                "cluster_ref": "example-qa-a",
                "gateway_url": "https://loki.example.test",
            }]
        }
        profile["optional_evidence_providers"] = [kubectl_provider, provider]
        self.assertTrue(validate_profile(profile)["valid"])

        kubectl_provider["config"]["routes"][0]["namespace_hints"] = ["cmp-gr"]
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn("kubectl_route_fields_are_invalid", {item["code"] for item in validation["errors"]})
        kubectl_provider["config"]["routes"][0].pop("namespace_hints")

        provider["config"]["gateways"][0]["cluster_ref"] = "unmapped-cluster"
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn("loki_cluster_ref_is_not_in_kubectl_routes", {item["code"] for item in validation["errors"]})
        provider["config"]["gateways"][0]["cluster_ref"] = "example-qa-a"

        provider["config"]["tenant"] = "apim"
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn("loki_config_must_contain_only_gateways", {item["code"] for item in validation["errors"]})

        provider["config"] = {
            "gateways": [{
                "cluster_ref": "example-qa-a",
                "gateway_url": "http://127.0.0.1:3100",
            }]
        }
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn("loki_gateway_url_is_invalid", {item["code"] for item in validation["errors"]})

    def test_profile_component_log_placement_is_independent_and_cluster_backed(self):
        skill = Path(__file__).resolve().parents[1]
        profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
        profile["optional_evidence_providers"] = [{
            "provider_id": "kubectl",
            "enabled": True,
            "capabilities": ["k8s.context.health"],
            "match": {"problem_types": ["gateway.*"], "match_mode": "any"},
            "config": {"routes": [{
                "id": "example-prod-a",
                "match": {"keywords": ["example-prod-a", "prod"], "match_mode": "any"},
                "cluster_alias": "example-prod-a",
            }]},
        }, {
            "provider_id": "loki",
            "enabled": True,
            "capabilities": ["loki.gateway.health", "loki.stream.selector.resolve", "loki.logs.topk_api_status"],
            "match": {"problem_types": ["gateway.*"], "match_mode": "any"},
            "config": {"gateways": [{
                "cluster_ref": "example-prod-a",
                "gateway_url": "https://loki.example.test",
            }]},
        }]
        profile["observability"] = {"component_log_placements": [{
            "id": "apim-prod",
            "component": "apim",
            "environment_keywords": ["prod"],
            "cluster_ref": "example-prod-a",
            "tenant_id": "apim",
            "stream_selector": {"label": "apiId", "match": "nonempty"},
            "stream_selector_candidates": [
                {"label": "apiId", "value_source": "log_identity"},
                {"label": "application", "value_source": "application"},
            ],
        }]}
        self.assertTrue(validate_profile(profile)["valid"])

        profile["observability"]["component_log_placements"][0]["stream_selector_candidates"].insert(
            0,
            {"label": "plugin_name", "value_source": "fixed", "value": "example-policy-plugin"},
        )
        self.assertTrue(validate_profile(profile)["valid"])
        profile["observability"]["component_log_placements"][0]["stream_selector_candidates"][0].pop("value")
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn(
            "component_log_placement_selector_candidate_is_invalid",
            {item["code"] for item in validation["errors"]},
        )
        profile["observability"]["component_log_placements"][0]["stream_selector_candidates"][0]["value"] = "example-policy-plugin"

        profile["observability"]["component_log_placements"][0]["stream_selector_candidates"][0]["label"] = "backendUrl"
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn(
            "component_log_placement_selector_candidate_is_invalid",
            {item["code"] for item in validation["errors"]},
        )
        profile["observability"]["component_log_placements"][0]["stream_selector_candidates"][0]["label"] = "plugin_name"

        profile["observability"]["component_log_placements"][0]["cluster_ref"] = "other-prod"
        validation = validate_profile(profile)
        self.assertFalse(validation["valid"])
        self.assertIn(
            "component_log_placement_cluster_ref_is_not_in_kubectl_routes",
            {item["code"] for item in validation["errors"]},
        )

    def test_loki_gateway_reconciliation_requires_typed_fresh_health_evidence(self):
        skill = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            profile_file = vault / ".l05-profile.json"
            profile = json.loads((skill / "assets" / "vault-template" / ".l05-profile.json").read_text(encoding="utf-8"))
            profile["optional_evidence_providers"] = [{
                "provider_id": "kubectl",
                "enabled": True,
                "capabilities": ["k8s.context.health"],
                "match": {"problem_types": ["gateway.*"], "match_mode": "any"},
                "config": {"routes": [{
                    "id": "example-qa-a",
                    "match": {"keywords": ["example-qa-a"], "match_mode": "any"},
                    "cluster_alias": "example-qa-a",
                }]},
            }, {
                "provider_id": "loki",
                "enabled": True,
                "capabilities": [
                    "loki.gateway.health",
                    "loki.index.stats",
                    "loki.logs.query_excerpt",
                ],
                "match": {"problem_types": ["gateway.*"], "match_mode": "any"},
                "config": {"gateways": []},
            }]
            profile_file.write_text(json.dumps(profile), encoding="utf-8")
            profile_file.chmod(0o600)
            gateway_url = "https://loki.example.test"
            gateway_fingerprint = hashlib.sha256(gateway_url.encode("utf-8")).hexdigest()
            now = datetime.now(timezone.utc).isoformat()
            evidence = {
                "schema_version": "l05-loki-gateway-reconciliation/v1",
                "kubectl_response": {
                    "schema_version": "l05-provider-response/v1",
                    "provider_id": "kubectl",
                    "status": "ok",
                    "evidence_records": [{
                        "capability": "k8s.loki_gateway.resolve",
                        "evidence_type": "kubernetes_loki_gateway_candidate",
                        "confidence": "confirmed",
                        "data": {
                            "cluster_alias": "example-qa-a",
                            "rule_host": "loki.example.test",
                            "tls_host_match": True,
                            "path": "/",
                            "backend_service": "loki-gateway",
                            "resource_version": "17",
                            "ingress_uid_fingerprint": "sha256:fixture",
                        },
                        "provenance": {
                            "provider": "kubectl",
                            "access_mode": "read-only",
                            "approved_kubeconfig": True,
                            "tls_verified": True,
                            "collected_at": now,
                        },
                    }]
                },
                "loki_health_response": {
                    "schema_version": "l05-provider-response/v1",
                    "provider_id": "loki",
                    "status": "ok",
                    "evidence_records": [{
                        "capability": "loki.gateway.health",
                        "data": {
                            "ready": True,
                            "gateway_entry_fingerprint": gateway_fingerprint,
                        },
                        "provenance": {
                            "provider": "loki",
                            "access_mode": "read-only",
                            "tls_verified": True,
                            "cluster_alias": "example-qa-a",
                            "gateway_source": "kubectl_candidate",
                            "collected_at": now,
                        },
                    }]
                },
            }
            evidence_file = vault / "reconciliation.json"
            evidence_file.write_text(json.dumps(evidence), encoding="utf-8")

            code, preview = reconcile_loki_gateway(
                profile_file,
                evidence_file,
                apply=False,
            )
            self.assertEqual(code, 0)
            self.assertEqual(preview["status"], "change_ready")
            self.assertNotIn(gateway_url, json.dumps(preview))
            self.assertEqual(json.loads(profile_file.read_text())["optional_evidence_providers"][1]["config"]["gateways"], [])

            code, applied = reconcile_loki_gateway(
                profile_file,
                evidence_file,
                apply=True,
            )
            self.assertEqual(code, 0)
            self.assertEqual(applied["status"], "updated")
            updated = json.loads(profile_file.read_text())
            self.assertEqual(updated["optional_evidence_providers"][1]["config"]["gateways"][0]["gateway_url"], gateway_url)
            self.assertTrue(Path(applied["backup"]).exists())

    def test_configure_updates_only_non_secret_values(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "l05_setup.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vault = root / "ExistingVault"
            vault.mkdir()
            config = root / "l05.env"
            config.write_text("JIRA_TOKEN=preserved-fixture-value\nUNRELATED=value\n", encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(script), "configure", "--vault", str(vault), "--jira-base-url", "https://jira.example.test", "--config-file", str(config)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            output = json.loads(result.stdout)
            self.assertEqual(output["credential_values_changed"], False)
            self.assertNotIn("preserved-fixture-value", result.stdout)
            content = config.read_text(encoding="utf-8")
            self.assertIn("JIRA_TOKEN=preserved-fixture-value", content)
            self.assertIn("UNRELATED=value", content)
            self.assertIn("JIRA_BASE_URL=https://jira.example.test", content)
            self.assertIn(f"L05_OBSIDIAN_VAULT={vault.resolve()}", content)

    def test_remote_git_snapshot_does_not_change_source_repository(self):
        skill = Path(__file__).resolve().parents[1]
        script = skill / "scripts" / "git_snapshot.py"
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir()
            subprocess.run(["git", "init", "-b", "main"], cwd=source, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "fixture@example.test"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.name", "Fixture"], cwd=source, check=True)
            (source / "pipeline.yml").write_text("timeout: 30\n", encoding="utf-8")
            subprocess.run(["git", "add", "pipeline.yml"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-m", "fixture"], cwd=source, check=True, capture_output=True)
            before = subprocess.run(["git", "status", "--porcelain=v1", "-b"], cwd=source, text=True, capture_output=True, check=True).stdout
            result = subprocess.run(
                [sys.executable, str(script), "--repo-url", str(source), "--ref", "main", "--query", "timeout", "--cache-dir", str(root / "cache")],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads(result.stdout)
            self.assertEqual(report["status"], "ok")
            self.assertEqual(report["match_count"], 1)
            self.assertIsNone(report["worktree"])
            after = subprocess.run(["git", "status", "--porcelain=v1", "-b"], cwd=source, text=True, capture_output=True, check=True).stdout
            self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
