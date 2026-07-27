#!/usr/bin/env python3
"""Initialize and inspect a portable local knowledge vault for l05-diagnosis."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import stat
import sys
from pathlib import Path
from urllib.parse import urlsplit

from l05_profile import PROFILE_NAME, load_profile, profile_path


SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_ROOT = SKILL_ROOT / "assets" / "vault-template"
DEFAULT_CONFIG = Path(os.environ.get("L05_CONFIG_FILE", Path.home() / ".codex" / "l05-diagnosis.env"))
DEFAULT_PROVIDER_DIR = Path(os.environ.get("L05_PROVIDER_DIR", Path.home() / ".codex" / "l05-diagnosis/providers.d"))
ASSIGNMENT_PREFIXES = ("export ", "")
SECRET_PLACEHOLDERS = {
    "",
    "<token>",
    "<your-token>",
    "<your-read-only-token>",
    "changeme",
    "replace-me",
}

DIRECTORIES = (
    "inbox/documents",
    "inbox/tickets",
    "inbox/jira",
    "raw/documents",
    "raw/tickets",
    "wiki/sources/documents",
    "wiki/sources/tickets",
    "wiki/sources/jira",
    "wiki/howtos",
    "wiki/systems",
    "wiki/topics",
    "wiki/concepts",
    "wiki/questions",
    "system/templates",
    "system/state",
    "system/reports/jira-quality",
    "state",
)

CORE_FILES = ("AGENTS.md", "index.md", "log.md")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="Initialize a new or empty vault without overwriting files.")
    init.add_argument("--vault", required=True, help="New or empty Obsidian vault directory.")
    init.add_argument("--config-file", default=str(DEFAULT_CONFIG), help="Private local L05 environment file.")
    init.add_argument("--jira-base-url", default="https://jira.example.invalid", help="Non-secret Jira base URL placeholder.")
    init.add_argument("--auth-mode", choices=("bearer", "basic"), default="bearer")
    init.add_argument("--skip-config", action="store_true", help="Do not create a local configuration skeleton.")

    configure = subparsers.add_parser("configure", help="Update non-secret local settings without changing credentials.")
    configure.add_argument("--vault", required=True, help="Existing Obsidian vault directory.")
    configure.add_argument("--jira-base-url", required=True, help="Jira base URL.")
    configure.add_argument("--auth-mode", choices=("bearer", "basic"), default="bearer")
    configure.add_argument("--jira-email", help="Email or username for Basic authentication.")
    configure.add_argument("--config-file", default=str(DEFAULT_CONFIG), help="Private local L05 environment file.")

    doctor = subparsers.add_parser("doctor", help="Read configuration and vault state without changing them.")
    doctor.add_argument("--vault", help="Vault directory; otherwise resolve it from configuration.")
    doctor.add_argument("--config-file", default=str(DEFAULT_CONFIG), help="Private local L05 environment file.")
    return parser.parse_args()


def read_literal_env(file: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not file.is_file():
        return values
    for raw_line in file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        for prefix in ASSIGNMENT_PREFIXES:
            if prefix and not line.startswith(prefix):
                continue
            candidate = line[len(prefix) :] if prefix else line
            if "=" not in candidate:
                break
            key, raw_value = candidate.split("=", 1)
            key = key.strip()
            value = raw_value.strip()
            if not key.replace("_", "a").isalnum() or not key[0].isalpha():
                break
            if value.startswith(("'", '"')) and value.endswith(value[0]):
                value = value[1:-1]
            elif any(token in value for token in ("$(", "`", "${")):
                break
            values[key] = value
            break
    return values


def configured_secret(value: str | None) -> bool:
    normalized = value.strip().lower() if value else ""
    return bool(normalized and normalized not in SECRET_PLACEHOLDERS and not (normalized.startswith("<") and normalized.endswith(">")))


def configured_jira_url(value: str | None) -> bool:
    if not value or "example.invalid" in value:
        return False
    parsed = urlsplit(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname) and not parsed.username and not parsed.password


def setup_action(code: str, group: str, instruction: str, command: str | None = None) -> dict[str, str]:
    result = {"code": code, "group": group, "instruction": instruction}
    if command:
        result["command"] = command
    return result


def copy_template_tree(vault: Path) -> list[str]:
    created: list[str] = []
    for source in sorted(TEMPLATE_ROOT.rglob("*")):
        relative = source.relative_to(TEMPLATE_ROOT)
        target = vault / relative
        if source.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        if target.exists():
            raise RuntimeError(f"refusing to overwrite existing file: {target}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
        created.append(relative.as_posix())
    return created


def config_skeleton(vault: Path, jira_base_url: str, auth_mode: str) -> str:
    return (
        "# Private configuration for l05-diagnosis. Keep this file out of repositories.\n"
        f"JIRA_BASE_URL={jira_base_url}\n"
        "JIRA_TOKEN=\n"
        f"JIRA_AUTH_MODE={auth_mode}\n"
        "# JIRA_EMAIL=you@example.com\n"
        f"L05_OBSIDIAN_VAULT={vault}\n"
        "# L05_CODE_REPOSITORIES=https://git.example.invalid/org/platform.git\n"
        "# L05_CONFIG_FILE=/absolute/path/to/this-file\n"
    )


def update_non_secret_config(file: Path, updates: dict[str, str]) -> list[str]:
    for key, value in updates.items():
        if not value or any(character in value for character in ("\n", "\r", "\x00")):
            raise ValueError(f"invalid value for {key}")
    existing = file.read_text(encoding="utf-8").splitlines() if file.is_file() else []
    output: list[str] = []
    changed: list[str] = []
    seen: set[str] = set()
    for line in existing:
        candidate = line.strip()
        if candidate.startswith("export "):
            candidate = candidate[len("export ") :]
        key = candidate.split("=", 1)[0].strip() if "=" in candidate else ""
        if key in updates:
            replacement = f"{key}={updates[key]}"
            output.append(replacement)
            seen.add(key)
            if line != replacement:
                changed.append(key)
        else:
            output.append(line)
    for key, value in updates.items():
        if key not in seen:
            output.append(f"{key}={value}")
            changed.append(key)
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text("\n".join(output).rstrip() + "\n", encoding="utf-8")
    file.chmod(stat.S_IRUSR | stat.S_IWUSR)
    return sorted(set(changed))


def discover_provider_ids(directory: Path = DEFAULT_PROVIDER_DIR) -> set[str]:
    providers: set[str] = set()
    if not directory.is_dir():
        return providers
    for file in directory.glob("*.json"):
        try:
            manifest = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        provider_id = manifest.get("provider_id")
        if manifest.get("schema_version") == "l05-provider-manifest/v1" and isinstance(provider_id, str):
            providers.add(provider_id)
    return providers


def initialize(args: argparse.Namespace) -> int:
    vault = Path(args.vault).expanduser().resolve()
    if vault.exists() and not vault.is_dir():
        print(json.dumps({"status": "blocked", "reason": "vault_path_is_not_directory", "vault": str(vault)}, ensure_ascii=False))
        return 2
    if vault.exists() and any(vault.iterdir()):
        print(
            json.dumps(
                {
                    "status": "existing_vault_detected",
                    "vault": str(vault),
                    "changed": False,
                    "reason": "init only accepts a new or empty vault; run doctor for an existing vault",
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 3

    vault.mkdir(parents=True, exist_ok=True)
    for relative in DIRECTORIES:
        (vault / relative).mkdir(parents=True, exist_ok=True)
    created = copy_template_tree(vault)

    config_result = "skipped"
    config_path = Path(args.config_file).expanduser().resolve()
    if not args.skip_config:
        if config_path.exists():
            config_result = "existing_not_modified"
        else:
            config_path.parent.mkdir(parents=True, exist_ok=True)
            config_path.write_text(config_skeleton(vault, args.jira_base_url, args.auth_mode), encoding="utf-8")
            config_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
            config_result = "created"

    print(
        json.dumps(
            {
                "status": "initialized",
                "vault": str(vault),
                "created_files": created,
                "created_directories": list(DIRECTORIES),
                "config_file": str(config_path),
                "config_result": config_result,
                "next": [
                    "set JIRA_BASE_URL and JIRA_TOKEN in the private configuration file",
                    f"review {PROFILE_NAME}, add non-secret code repositories and routing rules if code diagnosis is needed, then run l05_profile.py validate",
                    "install the official Obsidian Web Clipper and target inbox/documents or inbox/tickets",
                    "ask the Obsidian agent to process inbox files under the vault AGENTS.md contract",
                    "run l05_setup.py doctor, present its complete configuration_chain and setup_actions, and proceed only when status is ready",
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def configure(args: argparse.Namespace) -> int:
    vault = Path(args.vault).expanduser().resolve()
    if not vault.is_dir():
        print(json.dumps({"status": "blocked", "reason": "vault_not_found", "vault": str(vault)}, ensure_ascii=False, indent=2))
        return 2
    config_path = Path(args.config_file).expanduser().resolve()
    if not config_path.exists():
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config_path.write_text(config_skeleton(vault, args.jira_base_url, args.auth_mode), encoding="utf-8")
        config_path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    updates = {
        "JIRA_BASE_URL": args.jira_base_url.rstrip("/"),
        "JIRA_AUTH_MODE": args.auth_mode,
        "L05_OBSIDIAN_VAULT": str(vault),
    }
    if args.jira_email:
        updates["JIRA_EMAIL"] = args.jira_email
    changed = update_non_secret_config(config_path, updates)
    print(
        json.dumps(
            {
                "status": "configured",
                "config_file": str(config_path),
                "changed_keys": changed,
                "credential_values_changed": False,
                "next": "set JIRA_TOKEN locally if it is still missing, then run doctor and follow its complete configuration_chain and setup_actions until status is ready",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


def doctor(args: argparse.Namespace) -> int:
    config_path = Path(args.config_file).expanduser().resolve()
    config = read_literal_env(config_path)
    configured_vault = args.vault or os.environ.get("L05_OBSIDIAN_VAULT") or os.environ.get("PAAS_KB_ROOT") or config.get("L05_OBSIDIAN_VAULT") or config.get("PAAS_KB_ROOT")
    configured_vault_path = Path(configured_vault).expanduser() if configured_vault else None
    vault_path_is_absolute = bool(configured_vault_path and configured_vault_path.is_absolute())
    vault = configured_vault_path.resolve() if configured_vault_path else None
    token_configured = configured_secret(os.environ.get("JIRA_TOKEN") or config.get("JIRA_TOKEN"))
    base_url = os.environ.get("JIRA_BASE_URL") or config.get("JIRA_BASE_URL", "")
    base_url_configured = configured_jira_url(base_url)
    auth_mode = (os.environ.get("JIRA_AUTH_MODE") or config.get("JIRA_AUTH_MODE") or "").strip().lower()
    auth_mode_configured = auth_mode in {"bearer", "basic"}
    jira_email_configured = bool((os.environ.get("JIRA_EMAIL") or config.get("JIRA_EMAIL") or "").strip())
    config_file_mode = stat.S_IMODE(config_path.stat().st_mode) if config_path.is_file() else None
    config_file_permissions_secure = config_file_mode is None or config_file_mode & 0o077 == 0
    tools = {name: bool(shutil.which(name)) for name in ("node", "python3", "git", "rg")}
    blockers = []
    warnings = []

    profile_file = profile_path(vault) if vault else None
    profile = None
    profile_validation = {"valid": False, "errors": [], "warnings": []}
    if profile_file and profile_file.is_file():
        profile, profile_validation = load_profile(profile_file)
        if not profile_validation["valid"]:
            blockers.append("profile_invalid")
        warnings.extend(item["code"] for item in profile_validation["warnings"])
    else:
        blockers.append("profile_missing")

    if profile and profile_validation["valid"]:
        knowledge = profile["knowledge"]
        expected_files = tuple(dict.fromkeys((knowledge["contract"], knowledge["index"], "log.md")))
        expected_directories = tuple(
            dict.fromkeys(value for key, value in knowledge.items() if key not in ("contract", "index"))
        )
    else:
        expected_files = CORE_FILES
        expected_directories = DIRECTORIES
    missing_files = [name for name in expected_files if not vault or not (vault / name).is_file()]
    missing_directories = [name for name in expected_directories if not vault or not (vault / name).is_dir()]

    if not vault:
        blockers.append("vault_not_configured")
    elif not vault_path_is_absolute:
        blockers.append("vault_path_must_be_absolute")
    elif not vault.is_dir():
        blockers.append("vault_not_found")
    if missing_files:
        blockers.append("vault_contract_incomplete")
    if not token_configured:
        blockers.append("jira_token_missing")
    if not base_url_configured:
        blockers.append("jira_base_url_missing_or_placeholder")
    if not auth_mode_configured:
        blockers.append("jira_auth_mode_missing_or_invalid")
    elif auth_mode == "basic" and not jira_email_configured:
        blockers.append("jira_email_missing_for_basic_auth")
    if not config_file_permissions_secure:
        blockers.append("private_config_permissions_too_open")
    if not tools["node"]:
        blockers.append("node_missing")

    repository_count = len(profile.get("code", {}).get("repositories", [])) if profile else 0
    routing_rule_count = len(profile.get("code", {}).get("routing_rules", [])) if profile else 0
    configured_provider_ids = {item.get("provider_id") for item in profile.get("optional_evidence_providers", []) if isinstance(item, dict) and item.get("enabled", True)} if profile else set()
    installed_provider_ids = discover_provider_ids()
    missing_provider_ids = sorted(configured_provider_ids - installed_provider_ids)
    warnings.extend(f"provider_not_installed:{provider_id}" for provider_id in missing_provider_ids)

    setup_actions = []
    if not configured_vault:
        setup_actions.append(
            setup_action(
                "select_and_configure_vault",
                "knowledge_vault",
                "Choose a new empty Vault or an existing compatible Vault, then store its absolute path in the private configuration.",
                'python3 "$SKILL_DIR/scripts/l05_setup.py" init --vault /absolute/path/to/new-vault --jira-base-url https://jira.example.com',
            )
        )
    elif not vault_path_is_absolute:
        setup_actions.append(
            setup_action(
                "replace_relative_vault_path",
                "knowledge_vault",
                "Replace L05_OBSIDIAN_VAULT with an absolute path in the private configuration.",
            )
        )
    elif not vault.is_dir():
        setup_actions.append(
            setup_action(
                "correct_or_create_vault",
                "knowledge_vault",
                "Correct L05_OBSIDIAN_VAULT, or initialize the selected new empty Vault.",
            )
        )
    elif missing_files or missing_directories:
        setup_actions.append(
            setup_action(
                "complete_vault_contract",
                "knowledge_vault",
                "The selected Vault is incomplete. Use init only for a new or empty Vault; inspect an existing non-empty Vault without overwriting it.",
            )
        )
    if not base_url_configured or not auth_mode_configured or (auth_mode == "basic" and not jira_email_configured):
        setup_actions.append(
            setup_action(
                "configure_jira_connection",
                "regular_configuration",
                "Set the Jira base URL and authentication mode in the private configuration; Basic authentication also requires JIRA_EMAIL.",
                'python3 "$SKILL_DIR/scripts/l05_setup.py" configure --vault "$L05_OBSIDIAN_VAULT" --jira-base-url https://jira.example.com',
            )
        )
    if not token_configured:
        setup_actions.append(
            setup_action(
                "set_jira_token_privately",
                "sensitive_configuration",
                "Set a non-placeholder read-only JIRA_TOKEN directly in the private configuration or process environment. Never paste it into chat or pass it on a command line.",
            )
        )
    if not config_file_permissions_secure:
        setup_actions.append(
            setup_action(
                "restrict_private_config_permissions",
                "sensitive_configuration",
                "Restrict the private configuration file so group and other users cannot read it.",
                'chmod 600 "${L05_CONFIG_FILE:-$HOME/.codex/l05-diagnosis.env}"',
            )
        )
    if not profile_file or not profile_file.is_file():
        setup_actions.append(
            setup_action(
                "create_vault_profile",
                "vault_profile",
                "Create the missing non-secret Vault Profile, review its knowledge paths, then validate it.",
                'python3 "$SKILL_DIR/scripts/l05_profile.py" init --vault "$L05_OBSIDIAN_VAULT"',
            )
        )
    elif not profile_validation["valid"]:
        setup_actions.append(
            setup_action(
                "repair_vault_profile",
                "vault_profile",
                "Repair the Profile errors reported by doctor, then validate the Profile again.",
                'python3 "$SKILL_DIR/scripts/l05_profile.py" validate --vault "$L05_OBSIDIAN_VAULT"',
            )
        )
    if not tools["node"]:
        setup_actions.append(
            setup_action(
                "install_node",
                "runtime",
                "Install Node.js 18 or newer, then rerun doctor.",
            )
        )

    configuration_chain = [
        {
            "order": 1,
            "group": "knowledge_vault",
            "complete": bool(vault and vault_path_is_absolute and vault.is_dir() and not missing_files and not missing_directories),
            "requirement": "An externally configured absolute Vault path with the complete local Vault contract.",
        },
        {
            "order": 2,
            "group": "regular_configuration",
            "complete": bool(base_url_configured and auth_mode_configured and (auth_mode != "basic" or jira_email_configured)),
            "requirement": "A valid Jira base URL and authentication mode; Basic authentication also needs JIRA_EMAIL.",
        },
        {
            "order": 3,
            "group": "sensitive_configuration",
            "complete": bool(token_configured and config_file_permissions_secure),
            "requirement": "A non-placeholder read-only Jira Token in a private source; any private configuration file must deny group/other access.",
        },
        {
            "order": 4,
            "group": "vault_profile",
            "complete": bool(profile_file and profile_file.is_file() and profile_validation["valid"]),
            "requirement": "A valid non-secret Vault Profile for knowledge paths and optional routing.",
        },
        {
            "order": 5,
            "group": "runtime",
            "complete": tools["node"],
            "requirement": "Node.js is available for the bundled Jira workflow.",
        },
        {
            "order": 6,
            "group": "verification",
            "complete": not blockers,
            "requirement": "Rerun l05_setup.py doctor and proceed only when status is ready.",
        },
    ]

    result = {
        "status": "ready" if not blockers else "needs_setup",
        "changed": False,
        "vault": str(vault) if vault else None,
        "config_file": str(config_path),
        "config_file_exists": config_path.is_file(),
        "config_file_permissions_secure": config_file_permissions_secure,
        "jira_token_configured": token_configured,
        "jira_base_url_configured": base_url_configured,
        "jira_auth_mode_configured": auth_mode_configured,
        "jira_email_configured_for_basic": auth_mode != "basic" or jira_email_configured,
        "vault_path_is_absolute": vault_path_is_absolute,
        "missing_contract_files": missing_files,
        "missing_directories": missing_directories,
        "profile": {
            "path": str(profile_file) if profile_file else None,
            "status": "valid" if profile_validation["valid"] else "missing" if not profile_file or not profile_file.is_file() else "invalid",
            "repository_count": repository_count,
            "routing_rule_count": routing_rule_count,
            "code_routing_configured": bool(repository_count and routing_rule_count),
            "errors": profile_validation["errors"],
        },
        "providers": {
            "manifest_directory": str(DEFAULT_PROVIDER_DIR),
            "configured": sorted(configured_provider_ids),
            "installed": sorted(installed_provider_ids),
            "missing": missing_provider_ids,
        },
        "tools": tools,
        "blockers": blockers,
        "warnings": sorted(set(warnings)),
        "configuration_chain": configuration_chain,
        "setup_actions": setup_actions,
        "next": "configuration is ready; begin read-only Jira collection" if not blockers else "complete setup_actions in order, then rerun l05_setup.py doctor",
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not blockers else 2


def main() -> int:
    args = parse_args()
    if args.command == "init":
        return initialize(args)
    if args.command == "configure":
        return configure(args)
    return doctor(args)


if __name__ == "__main__":
    raise SystemExit(main())
