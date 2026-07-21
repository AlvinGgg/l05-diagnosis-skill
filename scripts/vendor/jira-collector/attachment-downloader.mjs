import path from "node:path";
import crypto from "node:crypto";

export function safeFilename(id, filename) {
  const base = path.basename(String(filename || "attachment")).replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^\.+/, "") || "attachment";
  return `${id}-${base}`;
}

export class AttachmentDownloader {
  constructor({mode = "metadata-only", maxFileBytes = 10 * 1024 * 1024, maxTotalBytes = 50 * 1024 * 1024, fetchAttachment} = {}) {
    this.mode = mode;
    this.maxFileBytes = maxFileBytes;
    this.maxTotalBytes = maxTotalBytes;
    this.fetchAttachment = fetchAttachment;
  }

  async collect(items = []) {
    const attachments = [];
    const files = new Map();
    let total = 0;
    for (const item of items) {
      const safe = safeFilename(item.id, item.filename);
      const relative = `attachments/files/${safe}`;
      const result = {id: String(item.id), original_filename: item.filename || "", safe_filename: safe, size: Number(item.size || 0), declared_mime: item.mimeType || "application/octet-stream", detected_mime: item.mimeType || "application/octet-stream", sha256: "", download_status: "not_requested", relative_path: ""};
      const shouldDownload = this.mode === "all" || (this.mode === "auto" && result.size <= this.maxFileBytes);
      if (this.mode === "off" || this.mode === "metadata-only" || !shouldDownload) { result.download_status = this.mode === "off" ? "not_requested" : "skipped"; attachments.push(result); continue; }
      if (result.size > this.maxFileBytes || total + result.size > this.maxTotalBytes) { result.download_status = "too_large"; attachments.push(result); continue; }
      try {
        const bytes = Buffer.from(await this.fetchAttachment(item));
        total += bytes.length;
        result.size = bytes.length;
        result.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
        result.download_status = "downloaded";
        result.relative_path = relative;
        files.set(relative, bytes);
      } catch (error) { result.download_status = error.status === 403 ? "forbidden" : error.status === 404 ? "not_found" : "failed"; result.error = error.message; }
      attachments.push(result);
    }
    return {attachments, files};
  }
}
