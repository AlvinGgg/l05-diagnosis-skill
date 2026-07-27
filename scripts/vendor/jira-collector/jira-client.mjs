import {redactUrl} from "./link-collector.mjs";

export class JiraHttpError extends Error {
  constructor(status, message, url) { super(message); this.status = status; this.url = redactUrl(url); }
}

export class JiraTransportError extends Error {
  constructor(error, attempts) {
    super(`${error?.message || "Jira transport failed"} after ${attempts} attempts`, {cause: error});
    this.name = "JiraTransportError";
    this.code = error?.cause?.code || error?.code || (error?.name === "AbortError" ? "TIMEOUT" : "");
    this.hostname = error?.cause?.hostname || error?.hostname || "";
    this.attempts = attempts;
  }
}

const RETRYABLE_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function retryableTransportError(error) {
  const code = error?.cause?.code || error?.code || "";
  return error?.name === "AbortError"
    || RETRYABLE_TRANSPORT_CODES.has(code)
    || /fetch failed|socket hang up/i.test(String(error?.message || ""));
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
      let response;
      try {
        response = await this.requestImpl(url, {...options, timeoutMs: this.timeoutMs, signal: this.signal});
      } catch (error) {
        if (!retryableTransportError(error)) throw error;
        if (attempt >= this.maxRetries) throw new JiraTransportError(error, attempt + 1);
        await this.sleep(Math.min(4000, 250 * (2 ** attempt)));
        continue;
      }
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
