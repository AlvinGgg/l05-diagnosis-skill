const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CLOUDS = new Set(["azure", "aliyun"]);

function uniqueStrings(values) {
  return [...new Set((values || [])
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim()))];
}

function scalarValues(value) {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (value && typeof value === "object") return [value.value, value.name, value.label].flatMap(scalarValues);
  return [];
}

function normalized(value) {
  return String(value || "").trim().toLowerCase();
}

function configuredSelectors(fieldMappings, slot, defaults) {
  return new Set([...(fieldMappings?.[slot] || []), ...defaults].map(normalized).filter(Boolean));
}

function customFieldValues(issue, selectors) {
  const values = [];
  for (const field of issue?.custom_fields || []) {
    const names = [field?.name, field?.id, field?.key].map(normalized);
    if (!names.some((name) => selectors.has(name))) continue;
    values.push(...scalarValues(field?.value));
  }
  return uniqueStrings(values);
}

function issueText(issue) {
  return [
    issue?.ticket?.summary,
    issue?.ticket?.description_markdown,
    issue?.ticket?.environment,
    ...(issue?.ticket?.components || []),
    ...(issue?.custom_fields || []).flatMap((field) => [field?.name, ...scalarValues(field?.value)]),
  ].filter(Boolean).join("\n");
}

export function issueClusterSignals(issue, fieldMappings = {}, environmentSignal = "") {
  const environmentSelectors = configuredSelectors(
    fieldMappings,
    "environment",
    ["environment for sre", "environment", "source environment", "target environment"],
  );
  for (const slot of ["source_environment", "target_environment"]) {
    for (const selector of configuredSelectors(fieldMappings, slot, [])) environmentSelectors.add(selector);
  }
  const subscriptionSelectors = configuredSelectors(fieldMappings, "subscription", ["subscription"]);
  const environment = uniqueStrings([
    environmentSignal,
    issue?.ticket?.environment,
    ...customFieldValues(issue, environmentSelectors),
  ]);
  const subscription = customFieldValues(issue, subscriptionSelectors);
  const cloud = /(?:\baliyun\b|\back\b|阿里云)/i.test(issueText(issue)) ? "aliyun" : "azure";
  return {environment, subscription, cloud};
}

function valuesOverlap(expected, actual) {
  const actualValues = new Set((actual || []).map(normalized));
  return (expected || []).some((value) => actualValues.has(normalized(value)));
}

function directoryRouteMatches(route, signals) {
  const match = route?.match;
  if (!match || typeof match !== "object") return false;
  if (Array.isArray(match.environment) && !valuesOverlap(match.environment, signals.environment)) return false;
  if (Array.isArray(match.subscription) && !valuesOverlap(match.subscription, signals.subscription)) return false;
  return !match.cloud || match.cloud === signals.cloud;
}

export function resolveClusterDirectory(directory, issue, {fieldMappings = {}, environmentSignal = ""} = {}) {
  const routes = directory?.routes;
  if (!Array.isArray(routes) || !routes.length) {
    return {status: "missing", cluster_ref: null, candidates: [], source: "cluster_directory"};
  }
  const signals = issueClusterSignals(issue, fieldMappings, environmentSignal);
  const directAliases = uniqueStrings(routes.flatMap((route) => route?.cluster_aliases || []));
  if (ID_PATTERN.test(environmentSignal || "") && directAliases.includes(environmentSignal)) {
    return {status: "matched", cluster_ref: environmentSignal, candidates: [environmentSignal], source: "cluster_directory", signals};
  }
  const matches = routes.filter((route) => directoryRouteMatches(route, signals));
  const candidates = uniqueStrings(matches.flatMap((route) => route?.cluster_aliases || []));
  if (!candidates.length) return {status: "missing", cluster_ref: null, candidates: [], source: "cluster_directory", signals};
  if (candidates.length === 1) return {status: "matched", cluster_ref: candidates[0], candidates, source: "cluster_directory", signals};
  if (candidates.length <= 2) return {status: "candidates", cluster_ref: null, candidates, source: "cluster_directory", signals};
  return {status: "ambiguous", cluster_ref: null, candidates, source: "cluster_directory", signals};
}

export function resolveLegacyCluster(routes, signal) {
  if (!Array.isArray(routes)) return {status: "missing", cluster_ref: null, candidates: [], source: "legacy_kubectl_routes"};
  const folded = normalized(signal);
  const matches = routes.filter((route) =>
    route && typeof route === "object"
    && typeof route.cluster_alias === "string"
    && Array.isArray(route.match?.keywords)
    && route.match.keywords.some((value) => normalized(value) === folded));
  if (!matches.length) return {status: "missing", cluster_ref: null, candidates: [], source: "legacy_kubectl_routes"};
  const candidates = uniqueStrings(matches.map((route) => route.cluster_alias));
  if (candidates.length === 1) return {status: "matched", cluster_ref: candidates[0], candidates, source: "legacy_kubectl_routes"};
  return {status: "ambiguous", cluster_ref: null, candidates, source: "legacy_kubectl_routes"};
}

export function resolveProfileCluster({profile, kubectlEntry, issue, environmentSignal = ""}) {
  if (profile?.cluster_directory) {
    const directoryResult = resolveClusterDirectory(profile.cluster_directory, issue, {
      fieldMappings: profile?.jira?.field_mappings || {},
      environmentSignal,
    });
    // During migration a Profile may contain only the routes that have been
    // normalized so far. Preserve the legacy route fallback for signals not
    // covered by that partial directory; a matched/ambiguous directory result
    // remains authoritative.
    if (directoryResult.status !== "missing") return directoryResult;
  }
  const signals = issueClusterSignals(issue, profile?.jira?.field_mappings || {}, environmentSignal);
  // An Evidence Plan's canonical alias is an explicit locator.  It must win
  // over looser ticket environment/subscription signals, which may describe a
  // source environment and otherwise create a false multi-cluster match.
  const explicit = resolveLegacyCluster(kubectlEntry?.config?.routes, environmentSignal);
  if (explicit.status !== "missing") return explicit;
  const values = uniqueStrings([...signals.environment, ...signals.subscription]);
  const candidates = uniqueStrings(values.flatMap((value) => {
    const result = resolveLegacyCluster(kubectlEntry?.config?.routes, value);
    return result.candidates;
  }));
  if (!candidates.length) return {status: "missing", cluster_ref: null, candidates, source: "legacy_kubectl_routes", signals};
  if (candidates.length === 1) return {status: "matched", cluster_ref: candidates[0], candidates, source: "legacy_kubectl_routes", signals};
  return {status: "ambiguous", cluster_ref: null, candidates, source: "legacy_kubectl_routes", signals};
}

export {CLOUDS};
