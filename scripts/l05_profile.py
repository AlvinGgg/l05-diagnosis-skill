#!/usr/bin/env python3
"""Initialize, validate, and resolve non-secret L05 Vault profiles."""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import ipaddress
import json
import os
import re
import shutil
import stat
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlparse, urlsplit, urlunsplit


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
    "application",
    "event_timestamp",
    "request_type",
    "question_classification",
    "issue_category",
    "environment",
    "request_id",
    "source_environment",
    "subscription",
    "target_environment",
}
LOKI_CAPABILITIES = {
    "loki.gateway.health",
    "loki.labels.list",
    "loki.label.values",
    "loki.stream.selector.resolve",
    "loki.index.stats",
    "loki.logs.query_excerpt",
    "loki.logs.topk_api_status",
}
LOKI_SELECTOR_LABELS = {"application", "apiId", "apis", "plugin_name", "productId", "project", "region", "tenant"}
CLUSTER_KEYWORD_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$")


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

    reconcile = subparsers.add_parser(
        "reconcile-loki-gateway",
        help="Validate a typed Kubectl/Loki reconciliation record and preview or apply one recoverable Profile update.",
    )
    reconcile.add_argument("--vault", required=True, help="Obsidian Vault directory.")
    reconcile.add_argument("--evidence-file", required=True)
    reconcile.add_argument("--apply", action="store_true")
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


def safe_loki_gateway_url(value: Any) -> str | None:
    if not isinstance(value, str) or len(value) > 512 or any(character in value for character in "\r\n\x00"):
        return None
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return None
    host = (parsed.hostname or "").casefold().rstrip(".")
    if (
        parsed.scheme != "https"
        or not host
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or port not in (None, 443)
        or host == "localhost"
        or host.endswith(".localhost")
    ):
        return None
    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        return None
    return urlunsplit(("https", host, "", "", ""))


def validate_kubectl_provider_config(provider: dict[str, Any], base: str) -> tuple[list[dict[str, str]], set[str]]:
    errors: list[dict[str, str]] = []
    config = provider.get("config")
    if not isinstance(config, dict) or set(config) != {"routes"}:
        return [error("kubectl_config_must_contain_only_routes", f"{base}.config")], set()
    routes = config.get("routes")
    if not isinstance(routes, list) or not routes or len(routes) > 100:
        return [error("kubectl_routes_must_be_nonempty_array", f"{base}.config.routes")], set()
    route_ids: set[str] = set()
    cluster_refs: set[str] = set()
    keywords_seen: set[str] = set()
    for index, route in enumerate(routes):
        route_base = f"{base}.config.routes[{index}]"
        if not isinstance(route, dict) or set(route) != {"id", "match", "cluster_alias"}:
            errors.append(error("kubectl_route_fields_are_invalid", route_base))
            continue
        route_id = route.get("id")
        if not isinstance(route_id, str) or not ID_PATTERN.fullmatch(route_id) or route_id in route_ids:
            errors.append(error("kubectl_route_id_is_invalid_or_duplicate", f"{route_base}.id"))
        else:
            route_ids.add(route_id)
        cluster_ref = route.get("cluster_alias")
        if not isinstance(cluster_ref, str) or not ID_PATTERN.fullmatch(cluster_ref) or cluster_ref in cluster_refs:
            errors.append(error("kubectl_cluster_ref_is_invalid_or_duplicate", f"{route_base}.cluster_alias"))
        else:
            cluster_refs.add(cluster_ref)
        match = route.get("match")
        if not isinstance(match, dict) or set(match) != {"keywords", "match_mode"}:
            errors.append(error("kubectl_route_match_fields_are_invalid", f"{route_base}.match"))
            continue
        keywords = match.get("keywords")
        if (
            not isinstance(keywords, list)
            or not keywords
            or len(keywords) > 20
            or len(keywords) != len(set(keywords))
            or any(not isinstance(value, str) or not CLUSTER_KEYWORD_PATTERN.fullmatch(value) for value in keywords)
            or cluster_ref not in keywords
        ):
            errors.append(error("kubectl_route_keywords_are_invalid", f"{route_base}.match.keywords"))
            continue
        if match.get("match_mode") != "any":
            errors.append(error("kubectl_route_match_mode_must_be_any", f"{route_base}.match.match_mode"))
        for keyword in keywords:
            folded = keyword.casefold()
            if folded in keywords_seen:
                errors.append(error("kubectl_route_keywords_conflict", f"{route_base}.match.keywords"))
                break
            keywords_seen.add(folded)
    return errors, cluster_refs


def validate_loki_provider_config(provider: dict[str, Any], base: str) -> tuple[list[dict[str, str]], set[str]]:
    errors: list[dict[str, str]] = []
    capabilities = provider.get("capabilities", [])
    if any(capability not in LOKI_CAPABILITIES for capability in capabilities):
        errors.append(error("loki_capability_is_unknown", f"{base}.capabilities"))
    config = provider.get("config")
    if not isinstance(config, dict) or set(config) != {"gateways"}:
        return [*errors, error("loki_config_must_contain_only_gateways", f"{base}.config")], set()
    gateways = config.get("gateways")
    if not isinstance(gateways, list) or len(gateways) > 100:
        return [*errors, error("loki_gateways_must_be_array", f"{base}.config.gateways")], set()
    cluster_refs: set[str] = set()
    gateway_urls: set[str] = set()
    for index, gateway in enumerate(gateways):
        gateway_base = f"{base}.config.gateways[{index}]"
        if not isinstance(gateway, dict) or set(gateway) != {"cluster_ref", "gateway_url"}:
            errors.append(error("loki_gateway_fields_are_invalid", gateway_base))
            continue
        cluster_ref = gateway.get("cluster_ref")
        if not isinstance(cluster_ref, str) or not ID_PATTERN.fullmatch(cluster_ref) or cluster_ref in cluster_refs:
            errors.append(error("loki_cluster_ref_is_invalid_or_duplicate", f"{gateway_base}.cluster_ref"))
        else:
            cluster_refs.add(cluster_ref)
        gateway_url = safe_loki_gateway_url(gateway.get("gateway_url"))
        if gateway_url is None:
            errors.append(error("loki_gateway_url_is_invalid", f"{gateway_base}.gateway_url"))
        elif gateway_url in gateway_urls:
            errors.append(error("loki_gateway_url_must_be_unique", f"{gateway_base}.gateway_url"))
        else:
            gateway_urls.add(gateway_url)
    return errors, cluster_refs


def validate_observability_config(value: Any) -> tuple[list[dict[str, str]], set[str]]:
    base = "$.observability"
    if value is None:
        return [], set()
    if not isinstance(value, dict) or set(value) != {"component_log_placements"}:
        return [error("observability_must_contain_only_component_log_placements", base)], set()
    placements = value.get("component_log_placements")
    if not isinstance(placements, list) or len(placements) > 50:
        return [error("component_log_placements_must_be_array", f"{base}.component_log_placements")], set()
    errors: list[dict[str, str]] = []
    ids: set[str] = set()
    routes: set[tuple[str, str]] = set()
    cluster_refs: set[str] = set()
    for index, placement in enumerate(placements):
        item_base = f"{base}.component_log_placements[{index}]"
        required = {"id", "component", "environment_keywords", "cluster_ref", "tenant_id", "stream_selector"}
        allowed = {*required, "stream_selector_candidates"}
        if not isinstance(placement, dict) or not required.issubset(placement) or set(placement) - allowed:
            errors.append(error("component_log_placement_fields_are_invalid", item_base))
            continue
        placement_id = placement.get("id")
        component = placement.get("component")
        cluster_ref = placement.get("cluster_ref")
        tenant_id = placement.get("tenant_id")
        if not isinstance(placement_id, str) or not ID_PATTERN.fullmatch(placement_id) or placement_id in ids:
            errors.append(error("component_log_placement_id_is_invalid_or_duplicate", f"{item_base}.id"))
        else:
            ids.add(placement_id)
        if not isinstance(component, str) or not ID_PATTERN.fullmatch(component):
            errors.append(error("component_log_placement_component_is_invalid", f"{item_base}.component"))
        if not isinstance(cluster_ref, str) or not ID_PATTERN.fullmatch(cluster_ref):
            errors.append(error("component_log_placement_cluster_ref_is_invalid", f"{item_base}.cluster_ref"))
        else:
            cluster_refs.add(cluster_ref)
        if not isinstance(tenant_id, str) or not ID_PATTERN.fullmatch(tenant_id):
            errors.append(error("component_log_placement_tenant_id_is_invalid", f"{item_base}.tenant_id"))
        keywords = placement.get("environment_keywords")
        if (
            not isinstance(keywords, list)
            or not keywords
            or len(keywords) > 20
            or len(keywords) != len(set(keywords))
            or any(not isinstance(item, str) or not CLUSTER_KEYWORD_PATTERN.fullmatch(item) for item in keywords)
        ):
            errors.append(error("component_log_placement_keywords_are_invalid", f"{item_base}.environment_keywords"))
        elif isinstance(component, str):
            for keyword in keywords:
                route = (component.casefold(), keyword.casefold())
                if route in routes:
                    errors.append(error("component_log_placement_route_conflicts", f"{item_base}.environment_keywords"))
                    break
                routes.add(route)
        selector = placement.get("stream_selector")
        if (
            not isinstance(selector, dict)
            or set(selector) != {"label", "match"}
            or selector.get("label") != "apiId"
            or selector.get("match") != "nonempty"
        ):
            errors.append(error("component_log_placement_stream_selector_is_invalid", f"{item_base}.stream_selector"))
        candidates = placement.get("stream_selector_candidates")
        if candidates is not None:
            if not isinstance(candidates, list) or not candidates or len(candidates) > 4:
                errors.append(error("component_log_placement_selector_candidates_are_invalid", f"{item_base}.stream_selector_candidates"))
            else:
                labels: set[str] = set()
                for candidate_index, candidate in enumerate(candidates):
                    candidate_base = f"{item_base}.stream_selector_candidates[{candidate_index}]"
                    value_source = candidate.get("value_source") if isinstance(candidate, dict) else None
                    expected_fields = (
                        {"label", "value_source", "value"}
                        if value_source == "fixed"
                        else {"label", "value_source"}
                    )
                    fixed_value = candidate.get("value") if isinstance(candidate, dict) else None
                    if (
                        not isinstance(candidate, dict)
                        or set(candidate) != expected_fields
                        or candidate.get("label") not in LOKI_SELECTOR_LABELS
                        or candidate.get("label") in labels
                        or value_source not in {"application", "log_identity", "fixed"}
                        or (
                            value_source == "fixed"
                            and (
                                not isinstance(fixed_value, str)
                                or not fixed_value
                                or len(fixed_value) > 256
                                or any(char in fixed_value for char in "\r\n\x00")
                            )
                        )
                    ):
                        errors.append(error("component_log_placement_selector_candidate_is_invalid", candidate_base))
                        continue
                    labels.add(candidate["label"])
    return errors, cluster_refs


def validate_profile(profile: Any) -> dict[str, Any]:
    errors: list[dict[str, str]] = []
    warnings: list[dict[str, str]] = []
    if not isinstance(profile, dict):
        return {"valid": False, "errors": [error("profile_must_be_object", "$")], "warnings": []}

    errors.extend(find_sensitive_keys(profile))
    observability_errors, placement_cluster_refs = validate_observability_config(profile.get("observability"))
    errors.extend(observability_errors)
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
    kubectl_cluster_refs: set[str] = set()
    loki_cluster_refs: set[str] = set()
    loki_configured = False
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
        elif provider_id == "kubectl":
            provider_errors, refs = validate_kubectl_provider_config(provider, base)
            errors.extend(provider_errors)
            kubectl_cluster_refs.update(refs)
        elif provider_id == "loki":
            loki_configured = True
            provider_errors, refs = validate_loki_provider_config(provider, base)
            errors.extend(provider_errors)
            loki_cluster_refs.update(refs)
    if loki_configured and "kubectl" not in provider_ids:
        errors.append(error("loki_requires_kubectl_cluster_directory", "$.optional_evidence_providers"))
    for cluster_ref in sorted(loki_cluster_refs - kubectl_cluster_refs):
        errors.append(error("loki_cluster_ref_is_not_in_kubectl_routes", f"$.optional_evidence_providers.loki.config.gateways[{cluster_ref}]"))
    for cluster_ref in sorted(placement_cluster_refs - kubectl_cluster_refs):
        errors.append(error("component_log_placement_cluster_ref_is_not_in_kubectl_routes", f"$.observability.component_log_placements[{cluster_ref}]"))
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


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_write_json(path: Path, value: dict[str, Any], mode: int) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def parse_fresh_timestamp(value: Any, *, max_age_seconds: int = 600) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return False
    age = (datetime.now(timezone.utc) - parsed).total_seconds()
    return -60 <= age <= max_age_seconds


def load_loki_reconciliation_evidence(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > 1024 * 1024:
            raise ValueError("too large")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("reconciliation_evidence_invalid") from error
    if not isinstance(value, dict) or value.get("schema_version") != "l05-loki-gateway-reconciliation/v1":
        raise ValueError("reconciliation_evidence_invalid")
    kubectl = value.get("kubectl_response")
    health = value.get("loki_health_response")
    if (
        not isinstance(kubectl, dict)
        or not isinstance(health, dict)
        or kubectl.get("schema_version") != "l05-provider-response/v1"
        or kubectl.get("provider_id") != "kubectl"
        or kubectl.get("status") not in ("ok", "partial")
        or health.get("schema_version") != "l05-provider-response/v1"
        or health.get("provider_id") != "loki"
        or health.get("status") != "ok"
    ):
        raise ValueError("reconciliation_evidence_invalid")
    candidates = [
        record
        for record in kubectl.get("evidence_records", [])
        if isinstance(record, dict)
        and record.get("capability") == "k8s.loki_gateway.resolve"
        and record.get("evidence_type") == "kubernetes_loki_gateway_candidate"
        and record.get("confidence") == "confirmed"
    ]
    health_records = [
        record
        for record in health.get("evidence_records", [])
        if isinstance(record, dict)
        and record.get("capability") == "loki.gateway.health"
        and record.get("data", {}).get("ready") is True
    ]
    if len(candidates) != 1 or len(health_records) != 1:
        raise ValueError("reconciliation_evidence_invalid")
    candidate = candidates[0]
    health_record = health_records[0]
    data = candidate.get("data", {})
    cluster_alias = data.get("cluster_alias")
    host = data.get("rule_host")
    if (
        not isinstance(cluster_alias, str)
        or not ID_PATTERN.fullmatch(cluster_alias)
        or not isinstance(host, str)
        or data.get("tls_host_match") is not True
        or data.get("path") != "/"
        or not data.get("backend_service")
        or not data.get("resource_version")
        or not data.get("ingress_uid_fingerprint")
    ):
        raise ValueError("reconciliation_evidence_invalid")
    gateway_url = safe_loki_gateway_url(f"https://{host}")
    if gateway_url is None:
        raise ValueError("reconciliation_evidence_invalid")
    gateway_fingerprint = hashlib.sha256(gateway_url.encode("utf-8")).hexdigest()
    candidate_provenance = candidate.get("provenance", {})
    health_provenance = health_record.get("provenance", {})
    if (
        candidate_provenance.get("provider") != "kubectl"
        or candidate_provenance.get("access_mode") != "read-only"
        or candidate_provenance.get("approved_kubeconfig") is not True
        or candidate_provenance.get("tls_verified") is not True
        or health_record.get("data", {}).get("gateway_entry_fingerprint") != gateway_fingerprint
        or health_provenance.get("provider") != "loki"
        or health_provenance.get("access_mode") != "read-only"
        or health_provenance.get("tls_verified") is not True
        or health_provenance.get("cluster_alias") != cluster_alias
        or health_provenance.get("gateway_source") != "kubectl_candidate"
        or not parse_fresh_timestamp(candidate_provenance.get("collected_at"))
        or not parse_fresh_timestamp(health_provenance.get("collected_at"))
    ):
        raise ValueError("reconciliation_evidence_invalid")
    return {
        "cluster_alias": cluster_alias,
        "gateway_url": gateway_url,
        "gateway_fingerprint": gateway_fingerprint,
        "resource_version": str(data["resource_version"]),
        "ingress_uid_fingerprint": str(data["ingress_uid_fingerprint"]),
    }


def reconcile_loki_gateway(
    file: Path,
    evidence_file: Path,
    *,
    apply: bool,
) -> tuple[int, dict[str, Any]]:
    try:
        metadata = file.lstat()
    except OSError:
        return 2, {"status": "blocked", "reason": "profile_invalid"}
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid():
        return 2, {"status": "blocked", "reason": "profile_unsafe_file"}
    profile, validation = load_profile(file)
    if profile is None or not validation["valid"]:
        return 2, {"status": "blocked", "reason": "profile_invalid", **validation}
    try:
        evidence = load_loki_reconciliation_evidence(evidence_file)
    except ValueError as error:
        return 2, {"status": "blocked", "reason": str(error)}
    providers = [
        provider
        for provider in profile.get("optional_evidence_providers", [])
        if isinstance(provider, dict) and provider.get("provider_id") == "loki"
    ]
    if len(providers) != 1:
        return 2, {"status": "blocked", "reason": "loki_provider_not_configured"}
    gateways = providers[0]["config"]["gateways"]
    matches = [gateway for gateway in gateways if gateway.get("cluster_ref") == evidence["cluster_alias"]]
    if len(matches) > 1:
        return 2, {"status": "blocked", "reason": "gateway_profile_ambiguous"}
    before_hash = file_sha256(file)
    if matches:
        target = matches[0]
        old_url = safe_loki_gateway_url(target.get("gateway_url"))
        if old_url != evidence["gateway_url"]:
            change_type = "update"
            target["gateway_url"] = evidence["gateway_url"]
        else:
            change_type = "none"
    else:
        change_type = "add"
        old_url = None
        gateways.append(
            {
                "cluster_ref": evidence["cluster_alias"],
                "gateway_url": evidence["gateway_url"],
            }
        )
    updated_validation = validate_profile(profile)
    if not updated_validation["valid"]:
        return 2, {
            "status": "blocked",
            "reason": "gateway_profile_update_invalid",
            "errors": updated_validation["errors"],
        }
    result = {
        "status": "no_change" if change_type == "none" else "change_ready",
        "change_type": change_type,
        "cluster_ref": evidence["cluster_alias"],
        "old_gateway_fingerprint": hashlib.sha256(old_url.encode("utf-8")).hexdigest() if old_url else None,
        "new_gateway_fingerprint": evidence["gateway_fingerprint"],
        "source_resource_version": evidence["resource_version"],
        "source_ingress_uid_fingerprint": evidence["ingress_uid_fingerprint"],
        "profile_before_sha256": before_hash,
        "applied": False,
    }
    if not apply or change_type == "none":
        return 0, result
    if file_sha256(file) != before_hash:
        return 2, {"status": "blocked", "reason": "profile_changed_during_reconciliation"}
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    backup = file.with_name(f"{file.name}.backup-{timestamp}")
    shutil.copy2(file, backup)
    atomic_write_json(file, profile, stat.S_IMODE(file.stat().st_mode))
    reloaded, reloaded_validation = load_profile(file)
    if reloaded is None or not reloaded_validation["valid"]:
        shutil.copy2(backup, file)
        return 2, {"status": "blocked", "reason": "gateway_profile_update_failed"}
    result.update(
        {
            "status": "updated",
            "applied": True,
            "profile_after_sha256": file_sha256(file),
            "backup": str(backup),
        }
    )
    return 0, result


def main() -> int:
    args = parse_args()
    vault = Path(args.vault)
    if args.command == "init":
        code, result = initialize(vault)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code

    file = profile_path(vault)
    if args.command == "reconcile-loki-gateway":
        code, result = reconcile_loki_gateway(
            file,
            Path(args.evidence_file).expanduser().resolve(),
            apply=args.apply,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return code

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
