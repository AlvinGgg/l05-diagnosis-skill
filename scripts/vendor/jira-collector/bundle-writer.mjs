import fs from "node:fs";
import path from "node:path";
import {sha256, validateBundle} from "./validate-jira-bundle.mjs";

function json(value) { return `${JSON.stringify(value, null, 2)}\n`; }
function utcBasic(value) { return new Date(value).toISOString().replaceAll(/[-:]/g, "").replace(".000", "").slice(0, 15) + "Z"; }

export class BundleWriter {
  constructor({outputRoot, collectorName = "jira-weaver", collectorVersion = "0.6.0"}) {
    this.outputRoot = outputRoot;
    this.collectorName = collectorName;
    this.collectorVersion = collectorVersion;
  }

  write({rawIssue, normalized, attachmentFiles = new Map()}) {
    const project = normalized.source.issue_key.split("-")[0];
    const ingestId = `${utcBasic(normalized.source.fetched_at)}-${normalized.content_hash.slice(0, 12)}`;
    const parent = path.join(this.outputRoot, project, normalized.source.issue_key);
    const finalDir = path.join(parent, ingestId);
    const existing = this.readyBundles(parent);
    const unchanged = existing.find((bundle) => {
      try { return JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8")).content_hash === normalized.content_hash; }
      catch { return false; }
    });
    if (unchanged) {
      for (const stale of existing) if (stale !== unchanged) fs.rmSync(stale, {recursive: true, force: true});
      return {outcome: "unchanged", bundle: unchanged, ingest_id: path.basename(unchanged)};
    }
    fs.mkdirSync(parent, {recursive: true});
    const staging = path.join(parent, `.${ingestId}.staging-${process.pid}`);
    fs.rmSync(staging, {recursive: true, force: true});
    fs.mkdirSync(path.join(staging, "attachments/files"), {recursive: true});
    fs.mkdirSync(path.join(staging, "links"), {recursive: true});
    fs.writeFileSync(path.join(staging, "issue.raw.json"), json(rawIssue));
    fs.writeFileSync(path.join(staging, "issue.normalized.json"), json(normalized));
    fs.writeFileSync(path.join(staging, "ticket.md"), this.ticketMarkdown(normalized));
    fs.writeFileSync(path.join(staging, "field-map.json"), json({fields: normalized.custom_fields || [], additional_fields: normalized.additional_fields || []}));
    fs.writeFileSync(path.join(staging, "collection-status.json"), json(normalized.collection));
    fs.writeFileSync(path.join(staging, "attachments/manifest.json"), json({attachments: normalized.attachments}));
    fs.writeFileSync(path.join(staging, "links/manifest.json"), json({links: normalized.links}));
    for (const [relative, bytes] of attachmentFiles) {
      const target = path.join(staging, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.writeFileSync(target, bytes);
    }
    const files = {};
    for (const relative of this.walkFiles(staging)) files[relative] = sha256(fs.readFileSync(path.join(staging, relative)));
    const manifest = {schema_version: "1.0.0", migration_version: "none", collector: {name: this.collectorName, version: this.collectorVersion}, ingest_id: ingestId, created_at: normalized.source.fetched_at, content_hash: normalized.content_hash, source: normalized.source, files};
    fs.writeFileSync(path.join(staging, "manifest.json"), json(manifest));
    const validation = validateBundle(staging, {requireReady: false});
    if (!validation.valid) { fs.rmSync(staging, {recursive: true, force: true}); throw new Error(`bundle validation failed: ${validation.errors.map((item) => item.code).join(", ")}`); }
    fs.renameSync(staging, finalDir);
    fs.writeFileSync(path.join(finalDir, "ready.marker"), "");
    for (const stale of existing) if (stale !== finalDir) fs.rmSync(stale, {recursive: true, force: true});
    return {outcome: "created", bundle: finalDir, ingest_id: ingestId};
  }

  readyBundles(parent) {
    if (!fs.existsSync(parent)) return [];
    return fs.readdirSync(parent, {withFileTypes: true})
      .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(parent, entry.name, "ready.marker")))
      .map((entry) => path.join(parent, entry.name));
  }

  walkFiles(root) {
    const values = [];
    const visit = (dir) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.name !== "manifest.json" && entry.name !== "ready.marker") values.push(path.relative(root, file).split(path.sep).join("/"));
      }
    };
    visit(root);
    return values.sort();
  }

  ticketMarkdown(issue) {
    const comments = issue.comments.map((comment) => `### ${comment.author.display_name || "Unknown"} — ${comment.created}\n\n${comment.body_markdown}`).join("\n\n");
    const attachments = (issue.attachments || []).map((attachment) => {
      const label = attachment.original_filename || attachment.safe_filename || attachment.id;
      if (attachment.download_status === "downloaded" && attachment.relative_path) return `- [${label}](${attachment.relative_path})`;
      return `- ${label} — ${attachment.download_status || "not_requested"}`;
    }).join("\n");
    const diagnosis = issue.diagnosis?.report_markdown ? `\n\n## Diagnosis candidate\n\n${issue.diagnosis.report_markdown}\n` : "";
    return `---\nsource: ${issue.source.browse_url}\nissue_key: ${issue.source.issue_key}\nsource_updated_at: ${issue.source.issue_updated_at}\nschema_version: ${issue.schema_version}\ncontent_hash: ${issue.content_hash}\nindex_tier: raw\n---\n\n# ${issue.source.issue_key}: ${issue.ticket.summary}\n\n## Description\n\n${issue.ticket.description_markdown || "No description."}\n\n## Comments\n\n${comments || "No comments."}\n\n## Attachments\n\n${attachments || "No attachments."}${diagnosis}`.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  }
}
