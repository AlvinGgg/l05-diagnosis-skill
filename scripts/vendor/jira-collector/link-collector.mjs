import {redactUrl} from "./privacy-redactor.mjs";

const URL_RE = /https?:\/\/[^\s<>)\]]+/g;

export {redactUrl};

export class LinkCollector {
  constructor() { this.links = new Map(); }

  add(url, source, type = "web") {
    if (!url) return;
    const key = redactUrl(String(url));
    const current = this.links.get(key) || {url: key, sources: [], type, access_status: "not_attempted"};
    if (!current.sources.includes(source)) current.sources.push(source);
    this.links.set(key, current);
  }

  fromText(text, source) { for (const match of String(text || "").match(URL_RE) || []) this.add(match, source); }
  values() { return [...this.links.values()]; }
}
