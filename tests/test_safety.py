import os
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from fetch_jira_issue import load_missing_l05_env, load_missing_zshrc_env
from inspect_github_actions import inspect, parse_actions_url
from l05_profile import validate_profile
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
            self.assertIn("code_repositories_not_configured", report["warnings"])
            self.assertNotIn("fixture-private-value", result.stdout)

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
