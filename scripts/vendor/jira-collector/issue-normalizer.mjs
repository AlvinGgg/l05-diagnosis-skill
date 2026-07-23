import {convertAdf} from "./adf-converter.mjs";
import {FieldCatalog, clean} from "./field-catalog.mjs";
import {LinkCollector} from "./link-collector.mjs";
import {redactObject} from "./privacy-redactor.mjs";
import {normalizedContentHash} from "./validate-jira-bundle.mjs";

function named(value) { return value?.name || value?.displayName || ""; }
function names(values) { return (values || []).map(named).filter(Boolean); }
function user(value) { return value ? clean({display_name: value.displayName || value.name || "", stable_id: value.accountId || value.key || value.name || ""}) : {}; }

export class IssueNormalizer {
  constructor({baseUrl, deploymentType = "unknown", fieldCatalog = [], collectorName = "jira-weaver", collectorVersion = "0.6.0"} = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.deploymentType = deploymentType;
    this.catalog = new FieldCatalog(fieldCatalog);
    this.collectorName = collectorName;
    this.collectorVersion = collectorVersion;
  }

  normalize({issue, comments = [], commentStatus = {}, attachments = [], remoteLinks = [], changelogStatus = {}, fetchedAt = new Date().toISOString()}) {
    const fields = issue.fields || {};
    const description = convertAdf(fields.description);
    const links = new LinkCollector();
    for (const link of description.links) links.add(link.url, "description", "adf");
    const unsupported = new Set(description.unsupported_nodes);
    const normalizedComments = comments.map((comment) => {
      const body = convertAdf(comment.body);
      for (const link of body.links) links.add(link.url, `comment:${comment.id}`, "adf");
      for (const node of body.unsupported_nodes) unsupported.add(node);
      return {id: String(comment.id || ""), author: user(comment.author), created: comment.created || "", updated: comment.updated || comment.created || "", visibility: comment.visibility ?? null, body_markdown: body.markdown, links: body.links.map((item) => item.url), attachment_refs: [], media_refs: body.media_refs.map((item) => item.id || item.url).filter(Boolean)};
    });
    for (const link of remoteLinks || []) links.add(link.object?.url || link.url, `remote-link:${link.id || "unknown"}`, "jira-remote-link");
    for (const issueLink of fields.issuelinks || []) {
      const target = issueLink.outwardIssue || issueLink.inwardIssue;
      if (target?.key) links.add(`${this.baseUrl}/browse/${target.key}`, "issue-link", "jira-issue-link");
    }
    const source = {base_url: this.baseUrl, deployment_type: this.deploymentType, issue_id: String(issue.id || issue.key), issue_key: issue.key, browse_url: `${this.baseUrl}/browse/${issue.key}`, fetched_at: fetchedAt, issue_created_at: fields.created || "", issue_updated_at: fields.updated || fetchedAt};
    const value = redactObject({
      schema_version: "1.0.0",
      source,
      ticket: {summary: fields.summary || issue.key, description_markdown: description.markdown, environment: typeof fields.environment === "string" ? fields.environment : "", status: named(fields.status) || "Unknown", issue_type: named(fields.issuetype) || "Unknown", priority: named(fields.priority), resolution: named(fields.resolution), reporter: user(fields.reporter), assignee: user(fields.assignee), labels: fields.labels || [], components: names(fields.components), versions: names(fields.versions), fix_versions: names(fields.fixVersions), ...(fields.parent ? {parent: fields.parent} : {}), subtasks: fields.subtasks || [], issue_links: fields.issuelinks || []},
      custom_fields: this.catalog.customFields(fields),
      comments: normalizedComments,
      attachments,
      links: links.values(),
      collection: {steps: {issue: {status: "complete"}, comments: {status: commentStatus.total === comments.length ? "complete" : "partial", ...commentStatus}, attachments: {status: "complete", fetched: attachments.length}, links: {status: "complete", fetched: links.values().length}, changelog: changelogStatus}, unsupported_adf_nodes: [...unsupported].sort(), permission_gaps: []},
      provenance: [{target: "ticket.summary", source: "fields.summary"}, {target: "ticket.description_markdown", source: "fields.description"}, ...normalizedComments.map((comment, index) => ({target: `comments[${index}]`, source: `comment:${comment.id}`}))],
      content_hash: "",
      quality: {evaluator_status: "not_evaluated"},
    });
    value.content_hash = normalizedContentHash(value);
    return value;
  }
}
