import { proseAuthReferences } from './auth-reference.mjs';
// Verdicts — decisions NOT to use an API, recorded where decisions to use one
// already live.
//
// Accepted integrations leave code; rejected ones leave nothing, and the
// knowledge evaporates. A verdict is one line on top of work that already
// happened: the decision, the reason, the CLASS of reason, its scope, and
// optionally the committed probe envelope that reproduces the reason. The
// probe is what turns trust from a judgement about the author into a
// computation any agent can re-run.
//
// Verdicts live in sannr.json under a top-level `verdicts` block, keyed
// by what was judged ("twilio/verify"). The block is committed, so everything
// written into it goes through the same secret guard as `note` — free text is
// a path around the promotion boundary, and verdicts opened a second one.

export const VERDICT_STATES = ["rejected", "accepted", "deferred"];

// The class taxonomy is closed on purpose: reasons decay at different rates,
// and the class tells a reader HOW to re-check, which an agent cannot infer
// from prose. `contextual` and `judgment` exist precisely because they are the
// reasons prose rejection docs dress up as technical facts — recording them
// honestly is what lets an agent surface them as questions instead of
// enforcing them as constraints.
export const VERDICT_CLASSES = {
  measured:   { recheck: "re-run the probe" },
  documented: { recheck: "re-fetch the docs" },
  priced:     { recheck: "re-check the price against the current budget; the API may be unchanged while the budget moved" },
  structural: { recheck: "re-check the vendor; structural facts move slowly but the stakes are high" },
  contextual: { recheck: "re-check the situation; this was never a property of the API at all" },
  judgment:   { recheck: "ask whoever holds it; this is not re-checkable by machine" },
};

// A verdict forecloses an option, so its staleness matters more than an
// operation's. Past this window an unconfirmed verdict renders as a question,
// never as an answer — staleness cannot be a field the reader is trusted to
// weigh, because the reader is an agent that reads confident sentences as
// facts.
export const VERDICT_TTL_DAYS = 90;

// --- secret guard ----------------------------------------------------------
// One guard, two doors. `note` shipped this list first (bin/cli.mjs); verdicts
// added a second free-text path into the committed file, so the shapes moved
// here and BOTH commands import the same test. Deliberately broad: a false
// refusal costs a rephrase, a false accept is permanent and in every clone.
export const SECRET_SHAPES = [
  [/\b(?:sk|pk|rk|ek|whsec|xox[baprs]|ghp|gho|ghu|ghs|ghr|glpat|npm)[-_][A-Za-z0-9_-]{8,}/, "an API key or token"],
  [/\b(?:PMAK|PMAT)-[A-Za-z0-9_-]{8,}/, "a Postman API key or token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub fine-grained token"],
  [/\bAIza[A-Za-z0-9_-]{20,}/, "a Google API key"],
  [/\bxapp-[A-Za-z0-9-]{10,}/, "an X app token"],
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, "a SendGrid key"],
  [/\b(?:shpat|shpss)_[A-Za-z0-9_-]{10,}/, "a Shopify token"],
  [/\bdop_v1_[A-Za-z0-9_-]{10,}/, "a DigitalOcean token"],
  [/\bAC[0-9a-f]{32}\b/i, "a Twilio account token"],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, "a JWT"],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{12,}/, "an AWS access key id"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b(?:password|passwd|secret|api[_-]?key|token|bearer|basic)\s*[:=]\s*\S{6,}/i, "an inline credential"],
  // An HTTP authentication scheme followed by a literal token is a credential
  // wherever it sits — a header renamed or misspelled must not smuggle it past
  // the name-based rules. A template reference ({{token}}) is not a value.
  [/\b(?:bearer|basic|digest|hmac|negotiate|ntlm)\s+(?!\{\{)[A-Za-z0-9._~+\/=-]{16,}/i, "an authorization scheme value"],
  [/\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i, "an email address, which may identify a customer"],
  [/\bhttps?:\/\/[^\s]*[?&](?:api_?key|access_?token|token|sig|signature)=/i, "a URL carrying a credential"],
  [/\bhttps?:\/\/[^\s\/@]+:[^\s\/@]+@/, "credentials in a URL"],
];

/** What kind of secret a string contains, or null if it looks clean. */
export function secretIn(text, { allowAuthReferences = false } = {}) {
  if (typeof text !== "string") return null;
  if (!allowAuthReferences) {
    for (const [re, what] of SECRET_SHAPES) if (re.test(text)) return what;
    return null;
  }
  const references = proseAuthReferences(text);
  for (const [re, what] of SECRET_SHAPES) {
    if (what !== "an inline credential") {
      // These checks always inspect the original input, including references.
      if (re.test(text)) return what;
      continue;
    }
    let referenceIndex = 0;
    for (const match of text.matchAll(new RegExp(re.source, 'gi'))) {
      const end = match.index + match[0].replace(/[.\'"`!?;,)>\]]+$/, '').length;
      while (references[referenceIndex]?.end < match.index) referenceIndex++;
      const ref = references[referenceIndex];
      if (!ref?.reference || match.index < ref.start || end > ref.end) return what;
    }
  }
  if (references.some(ref => !ref.reference)) return "an invalid credential reference";
  return null;
}

/** Scan projected metadata before it is returned or written. Input payloads
 * must first pass their format-specific projection; this is the final lock. */
export function scanMetadataSecrets(value, code = 'IMPORT_SECRET_REFUSED') {
  const pending = [value], seen = new WeakSet();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string' && secretIn(item, { allowAuthReferences: true }))
      throw Object.assign(new Error('Projected metadata contains a secret-shaped identity; nothing was published.'), { code });
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    for (const [key, child] of Object.entries(item)) pending.push(key, child);
  }
  return value;
}

export function redactMetadataSecrets(value, depth = 0) {
  if (depth > 64) return '[omitted: depth]';
  if (typeof value === 'string') {
    try { scanMetadataSecrets(value); return value; } catch { return '[withheld: secret-shaped metadata]'; }
  }
  if (Array.isArray(value)) return value.map(item => redactMetadataSecrets(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretIn(key, { allowAuthReferences: true })).map(([key, child]) => [key, redactMetadataSecrets(child, depth + 1)]));
  return value;
}

// --- validation ------------------------------------------------------------

/**
 * Validate one verdict's fields. Returns a list of problems; empty means the
 * verdict is recordable. Validation is structural only — the secret guard is
 * a separate, earlier gate, because a refusal for secrets must never be
 * softened into "one problem among several".
 */
export function validateVerdict({ verdict, reason, cls, scope, held_by, revisable } = {}) {
  const problems = [];
  if (!VERDICT_STATES.includes(verdict))
    problems.push(`verdict must be one of ${VERDICT_STATES.join("|")}, got '${verdict ?? ""}'`);
  if (!reason || !String(reason).trim())
    problems.push("a verdict without a reason is an opinion with a date on it; --reason is required");
  // Unknown classes are rejected, not passed through: an untagged reason gets
  // read as a technical fact about the API, which is the exact failure the
  // taxonomy exists to prevent.
  if (!Object.hasOwn(VERDICT_CLASSES, cls ?? ""))
    problems.push(`class must be one of ${Object.keys(VERDICT_CLASSES).join("|")}, got '${cls ?? ""}'`);
  if (scope !== undefined && !String(scope).trim())
    problems.push("scope, when given, cannot be blank");
  if (held_by !== undefined && !String(held_by).trim())
    problems.push("held_by, when given, must be 'org' or a person");
  if (revisable !== undefined && typeof revisable !== "boolean")
    problems.push("revisable must be a boolean");
  return problems;
}

// --- storage ---------------------------------------------------------------

// Keys are attacker-ish input (an agent pastes whatever it evaluated), and
// `obj["__proto__"] = v` on a plain object silently rewrites the prototype
// instead of storing anything. defineProperty always creates an own property,
// so even a target literally named "__proto__" round-trips through JSON
// without polluting Object.prototype.
const setOwn = (obj, key, value) =>
  Object.defineProperty(obj, key, { value, writable: true, enumerable: true, configurable: true });

/**
 * Record a verdict into a loaded context, mutating it. Fields are copied one
 * by one — never spread from caller input — so the stored block is exactly
 * the schema and nothing else, and always JSON-serialisable.
 */
export function recordVerdict(ctx, name, { verdict, reason, cls, scope, probe, held_by, revisable, last_confirmed, decided_by, recorded_by, recorded_at }) {
  if (!ctx.verdicts || typeof ctx.verdicts !== "object" || Array.isArray(ctx.verdicts)) ctx.verdicts = {};
  const entry = {
    verdict,
    reason: String(reason).trim(),
    class: cls,
    ...(scope !== undefined ? { scope: String(scope).trim() } : {}),
    ...(probe !== undefined ? { probe } : {}),
    last_confirmed: last_confirmed ?? new Date().toISOString().slice(0, 10),
    held_by: held_by ?? "org",
    revisable: revisable ?? false,
    ...(decided_by !== undefined ? { decided_by } : {}),
    // Provenance — WHO wrote this verdict and WHEN, distinct from decided_by
    // (who holds it) and last_confirmed (when it was re-checked). Stamped only
    // when supplied, so a direct caller that omits it keeps the exact prior
    // schema and pre-provenance files still load.
    ...(recorded_by !== undefined ? { recorded_by, recorded_at: recorded_at ?? new Date().toISOString().slice(0, 10) } : {}),
  };
  setOwn(ctx.verdicts, name, entry);
  return entry;
}

// --- rendering -------------------------------------------------------------

const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Expired = last_confirmed is set and older than the TTL. A verdict that was
 *  never confirmed carries no date to be past, so it cannot expire — but it
 *  also never claimed freshness. A present-but-unparseable date is the third
 *  case, and the dangerous one: it DID claim a confirmation, we just cannot
 *  place it in time, so it cannot be shown to be fresh. A verdict that cannot
 *  prove its freshness must never render as a confident answer, so an
 *  uncheckable date is treated exactly like a stale one — expired, and asked
 *  as a question. Hand-edited files are the only source of such a date, and
 *  "re-run before relying on this" is the honest thing to say about one. */
export function isExpired(entry, today = new Date().toISOString().slice(0, 10), ttlDays = VERDICT_TTL_DAYS) {
  if (!entry.last_confirmed) return false;
  const age = daysBetween(entry.last_confirmed, today);
  if (!Number.isFinite(age)) return true;
  return age > ttlDays;
}

/**
 * One verdict as a line an agent will read at the start of work. The mode
 * matters more than the wording: fresh renders as an answer, expired renders
 * as a QUESTION — "re-run before relying on this" — because a stale verdict
 * presented confidently is the largest source of confidently wrong context
 * the file could manufacture.
 */
export function renderVerdict(name, entry, today = new Date().toISOString().slice(0, 10)) {
  const who = entry.held_by && entry.held_by !== "org" ? ` (held by ${entry.held_by}${entry.revisable ? ", revisable" : ""})` : "";
  // Provenance suffix — who wrote the verdict, and when — appended only when
  // the file carries it, so pre-provenance and hand-edited entries render
  // unchanged.
  const prov = entry.recorded_by ? ` [recorded by ${entry.recorded_by}${entry.recorded_at ? ` on ${entry.recorded_at}` : ""}]` : "";
  if (isExpired(entry, today)) {
    const recheck = VERDICT_CLASSES[entry.class]?.recheck ?? "re-check";
    return `${name} was ${entry.verdict} for: ${entry.reason}${who}${prov}. ` +
      `That was last confirmed ${entry.last_confirmed}` +
      (entry.probe ? ` and the probe is committed at ${entry.probe}` : "") +
      ` — ${recheck} before relying on this.`;
  }
  return `${name}: ${entry.verdict} [${entry.class}] — ${entry.reason}` +
    (entry.scope ? ` (scope: ${entry.scope})` : "") +
    (entry.probe ? ` (probe: ${entry.probe})` : "") +
    who + prov;
}
