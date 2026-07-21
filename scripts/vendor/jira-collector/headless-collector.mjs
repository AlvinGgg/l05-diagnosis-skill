import fs from "node:fs";
import path from "node:path";
import {AttachmentDownloader} from "./attachment-downloader.mjs";
import {BundleWriter} from "./bundle-writer.mjs";
import {IssueNormalizer} from "./issue-normalizer.mjs";
import {JiraClient} from "./jira-client.mjs";
import {SyncStateStore} from "./sync-state-store.mjs";
import {redactObject} from "./privacy-redactor.mjs";
import {loadJiraToken} from "./env-loader.mjs";

export const DEFAULT_OUTPUT_MODE = "inbox-bundle";

export async function collectFixture(fixture, options) {
  const downloader = new AttachmentDownloader({mode: options.attachmentMode || "metadata-only", fetchAttachment: async (item) => Buffer.from(item.fixture_content || "")});
  const downloaded = await downloader.collect(fixture.issue.fields?.attachment || []);
  const normalizer = new IssueNormalizer({baseUrl: fixture.base_url, deploymentType: fixture.deployment_type || "unknown", fieldCatalog: fixture.field_catalog || []});
  const normalized = normalizer.normalize({issue: fixture.issue, comments: fixture.comments || [], commentStatus: fixture.comment_status || {pages: 1, fetched: (fixture.comments || []).length, total: (fixture.comments || []).length}, attachments: downloaded.attachments, remoteLinks: fixture.remote_links || [], changelogStatus: fixture.changelog_status || {status: "complete", fetched: 0}, fetchedAt: fixture.fetched_at});
  return persist(fixture.issue, normalized, downloaded.files, options);
}

export async function collectJira(issueKey, options) {
  loadJiraToken({});
  const token = process.env[options.tokenEnv || "JIRA_TOKEN"];
  if (!token) throw new Error(`missing ${options.tokenEnv || "JIRA_TOKEN"}`);
  const authMode = options.authMode || process.env.JIRA_AUTH_MODE || "bearer";
  const email = options.email || process.env.JIRA_EMAIL || "";
  const authorization = authMode === "basic" ? `Basic ${Buffer.from(`${email}:${token}`, "utf8").toString("base64")}` : `Bearer ${token}`;
  const request = async (url, requestOptions) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestOptions.timeoutMs);
    try {
      const response = await fetch(url, {headers: {Accept: "application/json", Authorization: authorization}, signal: controller.signal});
      return {status: response.status, headers: Object.fromEntries(response.headers), text: await response.text(), get json() { try { return JSON.parse(this.text); } catch { return null; } }};
    } finally { clearTimeout(timer); }
  };
  const client = new JiraClient({baseUrl: options.baseUrl, request});
  return collectWithClient(issueKey, {...options, client, fetchAttachment: async (item) => {
    const response = await fetch(item.content, {headers: {Authorization: authorization}});
    if (!response.ok) { const error = new Error(`attachment HTTP ${response.status}`); error.status = response.status; throw error; }
    return Buffer.from(await response.arrayBuffer());
  }});
}

export async function collectWithClient(issueKey, options) {
  const client = options.client;
  const [fieldCatalog, issue, commentsResult] = await Promise.all([client.fieldCatalog(), client.issue(issueKey), client.comments(issueKey)]);
  let remoteLinks = [];
  let changelogStatus = {status: "not_attempted"};
  try { remoteLinks = await client.remoteLinks(issueKey); } catch (error) { remoteLinks = []; }
  try { const result = await client.changelog(issueKey); changelogStatus = {status: "complete", pages: result.pages, fetched: result.values.length, total: result.total}; } catch { changelogStatus = {status: "partial"}; }
  const downloader = new AttachmentDownloader({mode: options.attachmentMode || "metadata-only", fetchAttachment: options.fetchAttachment});
  const downloaded = await downloader.collect(issue.fields?.attachment || []);
  const normalizer = new IssueNormalizer({baseUrl: options.baseUrl, deploymentType: options.deploymentType || "unknown", fieldCatalog});
  const normalized = normalizer.normalize({issue, comments: commentsResult.values, commentStatus: {pages: commentsResult.pages, fetched: commentsResult.values.length, total: commentsResult.total}, attachments: downloaded.attachments, remoteLinks, changelogStatus});
  return persist(issue, normalized, downloaded.files, options);
}

function persist(rawIssue, normalized, attachmentFiles, options) {
  const mode = options.outputMode || DEFAULT_OUTPUT_MODE;
  if (mode === "legacy") {
    const legacyRoot = path.resolve(options.legacyRoot || "raw/tickets");
    fs.mkdirSync(legacyRoot, {recursive: true});
    const file = path.join(legacyRoot, `${normalized.source.issue_key}_${normalized.ticket.summary.replace(/[^\p{L}\p{N}._-]+/gu, "_")}.md`);
    if (!options.dryRun) fs.writeFileSync(file, `---\njira_key: ${normalized.source.issue_key}\nupdated: ${normalized.source.issue_updated_at}\njira_url: ${normalized.source.browse_url}\n---\n\n# ${normalized.ticket.summary}\n\n${normalized.ticket.description_markdown}\n`);
    return {outcome: options.dryRun ? "dry-run" : "legacy-written", mode, file};
  }
  if (mode !== "inbox-bundle") throw new Error(`unsupported output mode: ${mode}`);
  const sourceIdentity = `${normalized.source.base_url}|${normalized.source.issue_id}`;
  const state = options.stateFile ? new SyncStateStore(options.stateFile) : null;
  if (options.dryRun) return {outcome: "dry-run", mode, content_hash: normalized.content_hash};
  const retainedRaw = options.rawPolicy === "omit" ? {issue_key: normalized.source.issue_key, issue_id: normalized.source.issue_id} : options.rawPolicy === "redacted" ? redactObject({id: rawIssue.id, key: rawIssue.key, fields: rawIssue.fields}) : rawIssue;
  const result = new BundleWriter({outputRoot: options.outputRoot}).write({rawIssue: retainedRaw, normalized, attachmentFiles});
  state?.record(sourceIdentity, {content_hash: normalized.content_hash, issue_updated_at: normalized.source.issue_updated_at, bundle: result.bundle});
  return {...result, mode, content_hash: normalized.content_hash};
}
