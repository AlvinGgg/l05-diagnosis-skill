const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret|api[_-]?key|apikey|subscription[_-]?key|sas|sig|sign|signature|nonce|nonce[_-]?str|nonce-sign)$/i;
const SENSITIVE_QUERY_KEY = /(?:token|signature|sig|sign|auth|key|secret|password|passwd|code|credential|sas|nonce)/i;

export function redactUrl(value) {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEY.test(key)) url.searchParams.set(key, REDACTED);
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactText(value) {
  let text = String(value ?? "");
  text = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED);
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED);
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, REDACTED);
  text = text.replace(/\b(cookie|authorization|proxy-authorization)\s*:\s*[^\r\n]+/gi, `$1: ${REDACTED}`);
  text = text.replace(/\b(token|password|passwd|secret|client[_-]?secret|api[_-]?key|subscription[_-]?key|sas|sign|signature|nonce(?:[_-]?str)?|nonce-sign)\s*([:=])\s*([^\s,;"']+)/gi, `$1$2${REDACTED}`);
  text = text.replace(/https?:\/\/[^\s<>)\]"']+/gi, (url) => redactUrl(url));
  return text;
}

export function redactObject(value, key = "") {
  if (value == null) return value;
  if (SENSITIVE_KEY.test(key) && ["string", "number", "boolean"].includes(typeof value)) return REDACTED;
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactObject(item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactObject(child, childKey)]));
  }
  return value;
}

export {REDACTED};
