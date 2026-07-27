#!/usr/bin/env python3
"""Initialize, validate, and resolve non-secret L05 Vault profiles."""

from __future__ import annotations

import argparse
import fnmatch
import json
import re
import shutil
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse


SKILL_ROOT = Path(__file__).resolve().parents[1]
PROFILE_TEMPLATE = SKILL_ROOT / "assets" / "vault-template" / ".l05-profile.json"
PROFILE_NAME = ".l05-profile.json"
SUPPORTED_PROFILE_MAJOR = 1
ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
SENSITIVE_KEY_PATTERN = re.compile(
    r"(?:^|_)(?:token|password|passwd|secret|private_key|cookie|authorization|api_key)(?:$|_)",
    re.IGNORECASE,
)
KNOWLEDGE_REQUIRED = (
    "contract",
    "index",
    "inbox_documents",
    "inbox_tickets",
    "inbox_jira",
    "raw_documents",
    "raw_tickets",
    "wiki_sources_documents",
    "wiki_sources_tickets",
    "wiki_sources_jira",
    "quality_reports",
)
SELECTOR_KEYS = ("problem_types", "keywords", "components")
PROVIDER_CAPABILITY_PATTERN = re.compile(r"^[a-z][a-z0-9_.-]{1,95}$")
JIRA_FIELD_MAPPING_SLOTS = {
    "request_type",
    "question_classification",
    "issue_category",
    "environment",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    init = subparsers.add_parser("init", help="Create a missing Profile in an existing Vault without overwriting it.")
    init.add_argument("--vault", required=True, help="Obsidian Vault directory.")

    validate = subparsers.add_parser("validate", help="Validate a Vault Profile without changing it.")
    validate.add_argument("--vault", required=True, help="Obsidian Vault directory.")

    resolve = subparsers.add_parser("resolve", help="Resolve candidate code repositories from deterministic Profile rules.")
    resolve.add_argument("--vault", required=True, help="Obsidian Vault directory.")
    resolve.add_argument("--problem-type", help="Normalized problem type, for example cicd.pipeline_execution.")
    resolve.add_argument("--signal", action="append", default=[], help="Current issue signal; repeat as needed.")
    resolve.add_argument("--component", action="append", default=[], help="Current issue component; repeat as needed.")
    return parser.parse_args()


def profile_path(vault: Path) -> Path:
    return vault.expanduser().resolve() / PROFILE_NAME


def error(code: str, path: str) -> dict[str, str]:
    return {"code": code, "path": path}


def safe_relative_path(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip() or "\x00" in value or "\\" in value:
        return False
    candidate = PurePosixPath(value)
    return not candidate.is_absolute() and ".." not in candidate.parts


def safe_repository_url(value: Any) -> bool:
    if not isinstance(value, str) or not value.strip() or any(character in value for character in ("\n", "\r", "\x00")):
        return False
    if any(character.isspace() for character in value):
        return False
    if value.startswith(("http://", "https://", "ssh://")):
        parsed = urlparse(value)
        if parsed.scheme == "ssh":
            return bool(parsed.hostname) and not parsed.password and not parsed.query and not parsed.fragment
        return bool(parsed.hostname) and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
    return bool(re.fullmatch(r"(?:[^@/:\s]+@)?[^/:\s]+:[^\s?#]+", value))


def find_sensitive_keys(value: Any, current_path: str = "$") -> list[dict[str, str]]:
    errors: list[dict[str, str]] = []
    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{current_path}.{key}"
            normalized_key = re.sub(r"(?<!^)(?=[A-Z])", "_", str(key)).lower().replace("-", "_")
            if SENSITIVE_KEY_PATTERN.search(normalized_key):
                errors.append(error("profile_must_not_contain_secret_fields", child_path))
            errors.extend(find_sensitive_keys(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            errors.extend(find_sensitive_keys(child, f"{current_path}[{index}]"))
    return errors


def validate_profile(profile: Any) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if not isinstance(profile, dict):
        return {"valid": False, "errors": [error("profile_must_be_object", "$")], "warnings": []}

    errors.extend(find_sensitive_keys(profile))
    version = profile.get("profile_version")
    if not isinstance(version, str) or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        errors.append(error("profile_version_must_be_semver", "$.profile_version"))
    elif int(version.split(".", 1)[0]) != SUPPORTED_PROFILE_MAJOR:
        errors.append(error("unsupported_profile_major_version", "$.profile_version"))

    if not isinstance(profile.get("language"), str) or not profile["language"].strip():
        errors.append(error("language_is_required", "$.language"))

    knowledge = profile.get("knowledge")
    if not isinstance(knowledge, dict):
        errors.append(error("knowledge_must_be_object", "$.knowledge"))
    else:
        for key in KNOWLEDGE_REQUIRED:
            if key not in knowledge:
                errors.append(error("knowledge_path_is_required", f"$.knowledge.{key}"))
        for key, value in knowledge.items():
            if not safe_relative_path(value):
                errors.append(error("knowledge_path_must_be_safe_relative_path", f"$.knowledge.{key}"))

    jira = profile.get("jira", {})
    if not isinstance(jira, dict):
        errors.append(error("jira_configuration_must_be_object", "$.jira"))
    else:
        field_mappings = jira.get("field_mappings", {})
        if not isinstance(field_mappings, dict):
            errors.append(error("jira_field_mappings_must_be_object", "$.jira.field_mappings"))
        else:
            for slot, selectors in field_mappings.items():
                base = f"$.jira.field_mappings.{slot}"
                if slot not in JIRA_FIELD_MAPPING_SLOTS:
                    errors.append(error("jira_field_mapping_slot_is_unknown", base))
                invalid_selectors = (
                    not isinstance(selectors, list)
                    or not selectors
                    or any(not isinstance(selector, str) or not selector.strip() for selector in selectors)
                )
                if not invalid_selectors and len(selectors) != len(set(selectors)):
                    invalid_selectors = True
                if invalid_selectors:
                    errors.append(error("jira_field_mapping_selectors_are_invalid", base))

    code = profile.get("code")
    if not isinstance(code, dict):
        errors.append(error("code_must_be_object", "$.code"))
        return {"valid": not errors, "errors": errors, "warnings": warnings}

    repositories = code.get("repositories")
    routing_rules = code.get("routing_rules")
    if not isinstance(repositories, list):
        errors.append(error("repositories_must_be_array", "$.code.repositories"))
        repositories = []
    if not isinstance(routing_rules, list):
        errors.append(error("routing_rules_must_be_array", "$.code.routing_rules"))
        routing_rules = []

    repository_ids: set[str] = set()
    for index, repository in enumerate(repositories):
        base = f"$.code.repositories[{index}]"
        if not isinstance(repository, dict):
            errors.append(error("repository_must_be_object", base))
            continue
        repository_id = repository.get("id")
        if not isinstance(repository_id, str) or not ID_PATTERN.fullmatch(repository_id):
            errors.append(error("repository_id_is_invalid", f"{base}.id"))
        elif repository_id in repository_ids:
            errors.append(error("repository_id_must_be_unique", f"{base}.id"))
        else:
            repository_ids.add(repository_id)
        if not safe_repository_url(repository.get("url")):
            errors.append(error("repository_url_is_invalid_or_contains_credentials", f"{base}.url"))
        roles = repository.get("roles")
        if not isinstance(roles, list) or not roles or any(not isinstance(role, str) or not ID_PATTERN.fullmatch(role) for role in roles):
            errors.append(error("repository_roles_are_invalid", f"{base}.roles"))
        default_ref = repository.get("default_ref")
        if default_ref is not None and (not isinstance(default_ref, str) or not default_ref.strip() or any(character in default_ref for character in ("\n", "\r", "\x00"))):
            errors.append(error("repository_default_ref_is_invalid", f"{base}.default_ref"))

    rule_ids: set[str] = set()
    for index, rule in enumerate(routing_rules):
        base = f"$.code.routing_rules[{index}]"
        if not isinstance(rule, dict):
            errors.append(error("routing_rule_must_be_object", base))
            continue
        rule_id = rule.get("id")
        if not isinstance(rule_id, str) or not ID_PATTERN.fullmatch(rule_id):
            errors.append(error("routing_rule_id_is_invalid", f"{base}.id"))
        elif rule_id in rule_ids:
            errors.append(error("routing_rule_id_must_be_unique", f"{base}.id"))
        else:
            rule_ids.add(rule_id)
        match = rule.get("match")
        if not isinstance(match, dict) or not any(match.get(key) for key in SELECTOR_KEYS):
            errors.append(error("routing_rule_requires_a_selector", f"{base}.match"))
        else:
            for key in SELECTOR_KEYS:
                values = match.get(key, [])
                if not isinstance(values, list) or any(not isinstance(value, str) or not value.strip() for value in values):
                    errors.append(error("routing_selector_must_be_string_array", f"{base}.match.{key}"))
            if match.get("match_mode", "all") not in ("all", "any"):
                errors.append(error("routing_match_mode_is_invalid", f"{base}.match.match_mode"))
        targets = rule.get("repositories")
        if not isinstance(targets, list) or not targets:
            errors.append(error("routing_rule_repositories_are_required", f"{base}.repositories"))
        else:
            for target in targets:
                if target not in repository_ids:
                    errors.append(error("routing_rule_repository_is_unknown", f"{base}.repositories"))
        if not isinstance(rule.get("reason"), str) or not rule["reason"].strip():
            errors.append(error("routing_rule_reason_is_required", f"{base}.reason"))

    if not repositories:
        warnings.append(error("code_repositories_not_configured", "$.code.repositories"))
    if repositories and not routing_rules:
        warnings.append(error("code_routing_rules_not_configured", "$.code.routing_rules"))

    providers = profile.get("optional_evidence_providers", [])
    if not isinstance(providers, list):
        errors.append(error("optional_evidence_providers_must_be_array", "$.optional_evidence_providers"))
        providers = []
    provider_ids: set[str] = set()
    for index, provider in enumerate(providers):
        base = f"$.optional_evidence_providers[{index}]"
        if not isinstance(provider, dict):
            errors.append(error("provider_configuration_must_be_object", base))
            continue
        provider_id = provider.get("provider_id")
        if not isinstance(provider_id, str) or not ID_PATTERN.fullmatch(provider_id):
            errors.append(error("provider_id_is_invalid", f"{base}.provider_id"))
        elif provider_id in provider_ids:
            errors.append(error("provider_id_must_be_unique", f"{base}.provider_id"))
        else:
            provider_ids.add(provider_id)
        capabilities = provider.get("capabilities")
        if not isinstance(capabilities, list) or not capabilities or any(not isinstance(item, str) or not PROVIDER_CAPABILITY_PATTERN.fullmatch(item) for item in capabilities):
            errors.append(error("provider_capabilities_are_invalid", f"{base}.capabilities"))
        match = provider.get("match")
        if not isinstance(match, dict) or not any(match.get(key) for key in SELECTOR_KEYS):
            errors.append(error("provider_match_requires_a_selector", f"{base}.match"))
        else:
            for key in SELECTOR_KEYS:
                values = match.get(key, [])
                if not isinstance(values, list) or any(not isinstance(value, str) or not value.strip() for value in values):
                    errors.append(error("provider_selector_must_be_string_array", f"{base}.match.{key}"))
            if match.get("match_mode", "all") not in ("all", "any"):
                errors.append(error("provider_match_mode_is_invalid", f"{base}.match.match_mode"))
        if not isinstance(provider.get("config"), dict):
            errors.append(error("provider_config_must_be_object", f"{base}.config"))
    return {"valid": not errors, "errors": errors, "warnings": warnings}


def load_profile(file: Path) -> tuple[dict[str, Any] | None, dict[str, Any]]:
    if not file.is_file():
        return None, {"valid": False, "errors": [error("profile_not_found", "$")], "warnings": []}
    try:
        profile = json.loads(file.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, {"valid": False, "errors": [error("profile_json_is_invalid", "$")], "warnings": []}
    return profile, validate_profile(profile)


def initialize(vault: Path) -> tuple[int, dict[str, Any]]:
    vault = vault.expanduser().resolve()
    if not vault.is_dir():
        return 2, {"status": "blocked", "reason": "vault_not_found", "vault": str(vault)}
    target = profile_path(vault)
    if target.exists():
        return 3, {"status": "existing_not_modified", "profile": str(target), "changed": False}
    shutil.copyfile(PROFILE_TEMPLATE, target)
    return 0, {
        "status": "created",
        "profile": str(target),
        "changed": True,
        "next": "edit only non-secret knowledge paths, optional Jira semantic field mappings, repository metadata, and routing rules; then run validate",
    }


def selector_matches(patterns: list[str], values: list[str], kind: str) -> bool:
    normalized_values = [value.casefold() for value in values if value]
    if kind == "problem_types":
        return any(fnmatch.fnmatchcase(value, pattern.casefold()) for pattern in patterns for value in normalized_values)
    return any(pattern.casefold() in value for pattern in patterns for value in normalized_values)


def resolve(profile: dict[str, Any], problem_type: str | None, signals: list[str], components: list[str]) -> list[dict[str, Any]]:
    repositories = {repository["id"]: repository for repository in profile["code"]["repositories"]}
    values = {"problem_types": [problem_type] if problem_type else [], "keywords": signals, "components": components}
    candidates: dict[str, dict[str, Any]] = {}
    for rule in profile["code"]["routing_rules"]:
        match = rule["match"]
        checks = [selector_matches(match[key], values[key], key) for key in SELECTOR_KEYS if match.get(key)]
        matched = all(checks) if match.get("match_mode", "all") == "all" else any(checks)
        if not matched:
            continue
        for repository_id in rule["repositories"]:
            repository = repositories[repository_id]
            candidate = candidates.setdefault(
                repository_id,
                {
                    "repository_id": repository_id,
                    "url": repository["url"],
                    "roles": repository["roles"],
                    "default_ref": repository.get("default_ref"),
                    "matched_rules": [],
                    "match_reasons": [],
                },
            )
            candidate["matched_rules"].append(rule["id"])
            candidate["match_reasons"].append(rule["reason"])
    return sorted(candidates.values(), key=lambda item: item["repository_id"])


def main() -> int:
    args = parse_args()
    vault = Path(args.vault)
    if args.command == "init":
        code, result = initialize(vault)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code

    file = profile_path(vault)
    profile, validation = load_profile(file)
    if args.command == "validate":
        print(
            json.dumps(
                {
                    "status": "valid" if validation["valid"] else "invalid",
                    "profile": str(file),
                    **validation,
                    "repository_count": len(profile.get("code", {}).get("repositories", [])) if profile else 0,
                    "routing_rule_count": len(profile.get("code", {}).get("routing_rules", [])) if profile else 0,
                    "provider_count": len(profile.get("optional_evidence_providers", [])) if profile else 0,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0 if validation["valid"] else 2

    if not validation["valid"] or profile is None:
        print(json.dumps({"status": "blocked", "reason": "profile_invalid", **validation}, ensure_ascii=False, indent=2))
        return 2
    candidates = resolve(profile, args.problem_type, args.signal, args.component)
    print(
        json.dumps(
            {
                "status": "matched" if candidates else "no_match",
                "problem_type": args.problem_type,
                "candidate_count": len(candidates),
                "candidates": candidates,
                "evidence_gap": None if candidates else "no_profile_rule_matched_current_issue_signals",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
