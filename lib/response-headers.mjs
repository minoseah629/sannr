// The bounded header view an agent sees, and the rate-limit metadata read from
// a header snapshot. Shared by the HTTP client envelope and the HTTP-based
// protocol adapters (GraphQL, JSON-RPC) so both present the same selection.
// The full header snapshot stays in private evidence and remains available to
// header assertions; only the presentation is trimmed. set-cookie is
// deliberately absent: it goes to the jar, never to the agent.
export const USEFUL_HEADERS = Object.freeze(["location", "etag", "link", "content-type", "content-length",
  "last-modified", "retry-after", "x-request-id", "x-correlation-id", "content-disposition"]);

// An empty header value is absent, not zero: beta.1's client parsed it as null
// and a consumer comparing `remaining` with 0 must not see a false exhaustion.
const numeric = value => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

// A Headers instance or a plain name → value object (any case).
const reader = headers => {
  if (typeof headers?.get === "function") return name => headers.get(name);
  const entries = headers && typeof headers === "object" ? Object.entries(headers) : [];
  return name => entries.find(([key]) => key.toLowerCase() === name)?.[1] ?? null;
};

// Both the standard draft (RateLimit-*) and the de-facto X-RateLimit-*.
export function readRateLimit(headers) {
  const get = reader(headers);
  const g = (...names) => { for (const n of names) { const v = get(n); if (v != null) return v; } return null; };
  const limit = numeric(g("ratelimit-limit", "x-ratelimit-limit"));
  const remaining = numeric(g("ratelimit-remaining", "x-ratelimit-remaining"));
  const reset = numeric(g("ratelimit-reset", "x-ratelimit-reset"));
  return (limit === null && remaining === null) ? null : { limit, remaining, reset };
}

// Values are bounded to 200 characters; `redact` says which values must not be
// shown (the HTTP client passes its secret detector).
export function selectUsefulHeaders(headers, { redact = () => false } = {}) {
  const get = reader(headers), out = {};
  for (const name of USEFUL_HEADERS) {
    const value = get(name);
    if (value == null) continue;
    const text = String(value);
    out[name] = redact(text) ? "[redacted]" : (text.length > 200 ? `${text.slice(0, 200)}…` : text);
  }
  return Object.keys(out).length ? out : null;
}
