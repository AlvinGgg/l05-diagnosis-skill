import {redactUrl} from "./link-collector.mjs";

export class JiraHttpError extends Error {
  constructor(status, message, url) { super(message); this.status = status; this.url = redactUrl(url); }
}

export class JiraClient {
  constructor({baseUrl, request, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), maxRetries = 3, timeoutMs = 30000, signal} = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.requestImpl = request;
    this.sleep = sleep;
    this.maxRetries = maxRetries;
    this.timeoutMs = timeoutMs;
    this.signal = signal;
    this.fieldsCache = null;
  }

  async request(pathname, options = {}) {
    const url = pathname.startsWith("http") ? pathname : `${this.baseUrl}${pathname}`;
    for (let attempt = 0; ; attempt += 1) {
      if (this.signal?.aborted) throw new Error("collection cancelled");
      const response = await this.requestImpl(url, {...options, timeoutMs: this.timeoutMs, signal: this.signal});
      if (response.status >= 200 && response.status < 300) return response.json ?? JSON.parse(response.text || "null");
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= this.maxRetries) throw new JiraHttpError(response.status, `Jira HTTP ${response.status}`, url);
      const retryAfter = Number(response.headers?.["retry-after"] || 0) * 1000;
      await this.sleep(retryAfter || Math.min(4000, 250 * (2 ** attempt)));
    }
  }

  async fieldCatalog() {
    if (!this.fieldsCache) this.fieldsCache = await this.request("/rest/api/2/field");
    return this.fieldsCache;
  }

  async issue(key) { return this.request(`/rest/api/2/issue/${encodeURIComponent(key)}?expand=names,schema`); }
  async remoteLinks(key) { return this.request(`/rest/api/2/issue/${encodeURIComponent(key)}/remotelink`); }

  async paged(pathname, listKey, {pageSize = 100} = {}) {
    const values = [];
    let startAt = 0;
    let pages = 0;
    while (true) {
      const join = pathname.includes("?") ? "&" : "?";
      const payload = await this.request(`${pathname}${join}startAt=${startAt}&maxResults=${pageSize}`);
      pages += 1;
      const batch = payload[listKey] || [];
      values.push(...batch);
      startAt = Number(payload.startAt || startAt) + batch.length;
      const total = Number(payload.total ?? values.length);
      if (!batch.length || startAt >= total || payload.isLast === true) return {values, pages, total};
    }
  }

  comments(key) { return this.paged(`/rest/api/2/issue/${encodeURIComponent(key)}/comment`, "comments"); }
  changelog(key) { return this.paged(`/rest/api/2/issue/${encodeURIComponent(key)}/changelog`, "values"); }

  async searchAll(jql, fields = ["*all"], pageSize = 100) {
    const query = new URLSearchParams({jql, fields: fields.join(",")}).toString();
    return this.paged(`/rest/api/2/search?${query}`, "issues", {pageSize});
  }
}
