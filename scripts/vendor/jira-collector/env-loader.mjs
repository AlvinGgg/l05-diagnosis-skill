import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]*))\s*(?:#.*)?$/;

function loadMissingFileEnv(names, file) {
  const wanted = new Set(names);
  const result = {};
  if (!fs.existsSync(file)) return result;
  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch { return result; }
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(ASSIGNMENT);
    if (!match || !wanted.has(match[1]) || process.env[match[1]]) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!value) continue;
    process.env[match[1]] = value;
    result[match[1]] = value;
  }
  return result;
}

function defaultL05ConfigFile(home) {
  if (process.env.L05_CONFIG_FILE) return process.env.L05_CONFIG_FILE;
  return path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "l05-diagnosis.env");
}

/** Load missing values from L05's private local configuration file. */
export function loadMissingL05ConfigEnv(names, {home = os.homedir(), configFile} = {}) {
  return loadMissingFileEnv(names, configFile || defaultL05ConfigFile(home));
}

/** Load missing credential variables from literal assignments in ~/.zshrc.
 * The file is parsed as text only; shell code is never evaluated.
 */
export function loadMissingZshrcEnv(names, {home = os.homedir()} = {}) {
  return loadMissingFileEnv(names, path.join(home, ".zshrc"));
}

export function loadJiraToken(options = {}) {
  loadMissingL05ConfigEnv(["JIRA_BASE_URL", "JIRA_TOKEN", "JIRA_EMAIL", "JIRA_AUTH_MODE"], options);
  if (!process.env.JIRA_TOKEN) loadMissingZshrcEnv(["JIRA_TOKEN"], options);
  return process.env.JIRA_TOKEN || "";
}
