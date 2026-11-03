import { LAYOUT } from './layout.mjs';
import { CLI_NAME } from './brand.mjs';
// `sannr import` — Postman v2.1 → suites, with an honest loss report.
//
// The verified market fact this exists for (2026-08-20 verification pass):
// Postman deprecated Newman, Newman cannot run the new v3 collection format,
// and no vendor ships migration loss-reporting or rollback. Everyone with a
// Newman CI pipeline is migrating something this year; nobody can tell them
// what survived the trip. This module's deliverable is not the converted
// suite — it is the REPORT: every item classified with a reason, every secret
// counted, every script named that a human still has to look at.
//
// Design rules, each pinned by a test:
//   - The source file is never modified; re-import is always possible.
//   - Deterministic: same source + flags → byte-identical output.
//   - Secrets never cross into a committed file (same guard family as curl/
//     suite save). Values are omitted and COUNTED; names become references.
//   - No imported step may be silently green: suites require expect, so a
//     step with no translatable or derivable assertion goes to the .todo
//     sidecar, not the runnable suite. Honest "needs an assertion" beats a
//     green that means nothing.
//   - Translation is conservative: only provably-equivalent pm.* patterns
//     become assertions. A wrong translated assertion is worse than a counted
//     manual one.
//
// Pure functions; the CLI does the I/O.

import { createHash } from "node:crypto";
import { ENVELOPE_VERSION, unsafePattern } from "./assertions.mjs";
import { scriptUnits, staticString } from "./import-script.mjs";
import { importCaseFingerprint } from "./import-case.mjs";
import { inspectImportDirectory } from "./import-directory.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER, SECRET_PARAMS } from "./curl.mjs";
import { parseYaml } from "./yaml.mjs";
import { secretIn, scanMetadataSecrets, redactMetadataSecrets } from "./verdicts.mjs";
import { summaryCell } from "./ci.mjs";
import { importArray, importBoundary, importFailure, validateImportInput } from "./import-input.mjs";

const sha256 = (s) => createHash("sha256").update(s).digest("hex");
// Adapter bookkeeping is not part of any source format. Private symbols keep
// untrusted JSON keys from impersonating projected prerequisites, credentials,
// source ownership or translated clauses. Only our adapters create these.
const ADAPTER = Object.freeze({
  prerequisites: Symbol('import-prerequisites'),
  inheritedAuthOwner: Symbol('import-inheritedAuthOwner'),
  inheritedAuth: Symbol('import-inheritedAuth'),
  authRef: Symbol('import-authRef'),
  inherited: Symbol('import-inherited'),
  scope: Symbol('import-scope'),
  owner: Symbol('import-owner'),
  insomniaLoss: Symbol('import-insomniaLoss'),
  brunoLoss: Symbol('import-brunoLoss'),
  brunoAssertions: Symbol('import-brunoAssertions'),
  brunoMetadata: Symbol('import-brunoMetadata'),
  brunoLedger: Symbol('import-brunoLedger'),
  quarantined: Symbol('import-quarantined'),
});

/** Stable stringify: sorted keys at every level, 2-space indent — so a
 *  re-import of an unchanged source is a zero-line diff. */
export function stableStringify(value, indent = 2) {
  const seen = new WeakSet();
  const order = (v, depth = 0) => {
    if (depth > 32) return "[quarantined: import nesting exceeds depth 32]";
    if (Array.isArray(v)) return v.map((item) => order(item, depth + 1));
    if (v && typeof v === "object") {
      if (seen.has(v)) return "[circular]";
      seen.add(v);
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, order(v[k], depth + 1)]));
    }
    return v;
  };
  return JSON.stringify(order(value), null, indent);
}

// --- variables ---------------------------------------------------------------

const VAR = /\{\{\s*([^}]+?)\s*\}\}/g;
const secretShapedName = (name) =>
  SECRET_PARAMS.test(name) || CREDENTIAL_SHAPED_HEADER.test(name);

function scrubBody(value, onSecret, path = "body", depth = 0) {
  if (depth > 32) { onSecret(`${path} subtree`); return "{{SANNR_QUARANTINED_DEPTH}}"; }
  if (typeof value === "string") {
    if (!secretIn(value)) return value;
    onSecret(`${path} value`);
    return "{{SANNR_SECRET}}";
  }
  if (Array.isArray(value)) return value.map((v, i) => scrubBody(v, onSecret, `${path}[${i}]`, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, v] of Object.entries(value)) {
      if (secretShapedName(key)) { onSecret(`${path}.${key} key`); continue; }
      out[key] = scrubBody(v, onSecret, `${path}.${key}`, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Resolve {{var}} against the provided values map (a Postman environment
 * export's kv pairs). Returns { text, unresolved:[names], secrets:[names] }.
 * Secret-shaped names are NEVER inlined even when a value is present — the
 * value came from an export that was probably never meant to be committed.
 */
export function resolveVars(text, values = {}) {
  const unresolved = [], secrets = [];
  const out = String(text).replace(VAR, (whole, name) => {
    if (name === "baseUrl") return "";                    // hoisted to the environment
    if (secretShapedName(name)) { secrets.push(name); return whole; }
    if (Object.hasOwn(values, name) && values[name] !== "" && values[name] !== null && values[name] !== undefined) return String(values[name]);
    unresolved.push(name);
    return whole;
  });
  return { text: out, unresolved, secrets };
}

/** Postman environment export → plain name→value map (enabled entries only). */
export function envValues(envExport) {
  const out = {};
  for (const v of envExport?.values ?? [])
    if (v && v.enabled !== false && typeof v.key === "string") out[v.key] = v.value ?? "";
  return out;
}

// --- pm.test translation -----------------------------------------------------
//
// Recognizers, not an interpreter. Each pattern below is provably equivalent
// to a declarative expect clause; anything that does not match whole is
// counted as manual work. The regexes are anchored per-statement so a partial
// match cannot smuggle a wrong assertion through.

const STR = `(?:"([^"]*)"|'([^']*)')`;
const lit = (m, a, b) => (a !== undefined ? a : b);

const pathOfSelector = (selector, aliases) => {
  const value = selector.trim();
  const direct = value.match(/^pm\.response\.json\(\s*\)(.*)$/);
  const alias = value.match(/^([A-Za-z_$][\w$]*)(.*)$/);
  const suffix = direct ? direct[1] : alias && aliases.has(alias[1]) ? alias[2] : null;
  if (suffix === null || (suffix && !/^(?:\.[A-Za-z_$][\w$]*|\[\d+\])+$/.test(suffix))) return null;
  const base = direct ? "" : aliases.get(alias[1]);
  return [base, suffix.replace(/\[(\d+)\]/g, ".$1").replace(/^\./, "")].filter(Boolean).join(".");
};
const literal = (source) => {
  const s = source.trim(), string = staticString(s);
  if (string !== null) return { ok: true, value: string };
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return { ok: true, value: Number(s) };
  if (s === "true" || s === "false") return { ok: true, value: s === "true" };
  if (s === "null") return { ok: true, value: null };
  return { ok: false };
};
const chainClauses = (path, chain) => {
  const clauses = [];
  // A chain is atomic. Unsupported target changes invalidate the whole chain,
  // never leave the next assertion aimed at the previous object.
  for (let part of chain.split(".and.")) {
    part = part.replace(/^to\./, "");
    if (part === "exist") clauses.push({ json: path, exists: true });
    else if (part === "not.exist") clauses.push({ json: path, exists: false });
    else {
      const type = part.match(/^be\.(?:a|an)\(\s*(['"])(string|number|boolean|object|array|null)\1\s*\)$/);
      const eq = part.match(/^(eql|equal|eq|not\.eql|not\.equal)\(\s*([\s\S]*)\s*\)$/);
      const property = part.match(/^have\.property\(\s*([\s\S]*)\s*\)$/);
      if (type) clauses.push({ json: path, type: type[2] });
      else if (eq) {
        const value = literal(eq[2]);
        if (!value.ok) return null;
        clauses.push({ json: path, [eq[1].startsWith("not.") ? "not_equals" : "equals"]: value.value });
      } else if (property) {
        const key = staticString(property[1].trim());
        // Literal dots and empty property keys cannot be expressed in the
        // dotted selector, so do not retarget them to another field.
        if (!key || key.includes(".")) return null;
        path = path ? `${path}.${key}` : key;
        clauses.push({ json: path, exists: true });
      } else return null;
    }
  }
  return clauses.length ? { clauses } : null;
};
function translateStatement(statement, aliases) {
  let m = statement.match(/^pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)$/);
  if (m) return { clauses: [{ status: Number(m[1]) }], label: "status" };
  m = statement.match(/^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:eql|equal)\(\s*(\d{3})\s*\)$/);
  if (m) return { clauses: [{ status: Number(m[1]) }], label: "status" };
  m = statement.match(/^pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:be\.)?(above|below)\(\s*(\d+)\s*\)$/);
  if (m) return { clauses: [{ status: true, [m[1] === "above" ? "gt" : "lt"]: Number(m[2]) }], label: "status" };
  m = statement.match(new RegExp("^pm\\.response\\.to\\.have\\.header\\(\\s*" + STR + "\\s*\\)$"));
  if (m) return { clauses: [{ header: lit(m, m[1], m[2]), exists: true }], label: "header" };
  m = statement.match(new RegExp("^pm\\.expect\\(\\s*pm\\.response\\.headers\\.get\\(\\s*" + STR + "\\s*\\)\\s*\\)\\.to\\.(.+)$"));
  if (m) {
    const header = lit(m, m[1], m[2]), chain = m[3];
    if (chain === "exist") return { clauses: [{ header, exists: true }], label: "header" };
    const include = chain.match(new RegExp("^include\\(\\s*" + STR + "\\s*\\)$"));
    if (include) { const value = lit(include, include[1], include[2]); const escaped = String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); return { clauses: [{ header, matches: "^.*" + escaped + ".*$" }], label: "header" }; }
    const eq = chain.match(/^(?:eql|equal)\(\s*(.*)\s*\)$/);
    if (eq) { const value = literal(eq[1]); if (value.ok) return { clauses: [{ header, equals: value.value }], label: "header" }; }
    return null;
  }
  m = statement.match(/^pm\.expect\(\s*(.+?)\s*\)\.to\.(.+)$/);
  if (!m) return null;
  const path = pathOfSelector(m[1], aliases);
  if (path === null) return null;
  const parsed = chainClauses(path, m[2].replace(/\.and\.to\./g, ".and."));
  return parsed ? { clauses: parsed.clauses, label: "json", partial: parsed.partial } : null;
}
/**
 * Translate a pm test script into expect clauses.
 * Returns { expect:[], manual:[names of pm.test blocks not fully translated] }.
 *
 * Deliberately not a JS parser. Blocks are split at pm.test( boundaries and
 * statements are extracted by pattern, so a one-line
 * `pm.test("x", () => { pm.response.to.have.status(200); })` still yields its
 * inner statement. A block with any unrecognized pm.* statement is counted
 * manual; its recognized statements still translate (partial credit is safe
 * because each translated clause is individually provable — the manual count
 * tells the human the block is not FULLY captured).
 */
export function translateTests(exec) {
  const src = Array.isArray(exec) ? exec.join("\n") : String(exec ?? "");
  const expect = [], manual = [], quarantined = [], translatedByPattern = {}, reportedOnly = [];
  const construct_ledger = [], assertion_metadata = [], prerequisites = [];
  const dialect = /tests\s*\[|responseCode\.code|responseBody|responseHeaders|postman\./.test(src) ? "legacy" : "modern";
  const label = (text) => String(redactMetadataSecrets(String(text))).replace(/[\r\n\x00-\x1f]/g, " ").slice(0, 180);
  const unsupported = (name, source, reason) => {
    const nameSafe = label(name);
    manual.push(nameSafe);
    quarantined.push({ script: nameSafe, reason, source: "test event" });
    construct_ledger.push({ name: nameSafe, disposition: "named-unsupported", reason, source_sha256: sha256(source) });
    const capture = source.match(/^(?:pm\.(?:collectionVariables|environment|variables)\.set|postman\.setEnvironmentVariable)\(\s*(["'])([A-Za-z_$][\w$]*)\1\s*,\s*pm\.response\.json\(\s*\)\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\)$/);
    if (capture) prerequisites.push({ kind: "capture", variable: capture[2], response_path: capture[3], verification: "unverified", executable: false });
  };
  const add = (name, unit, hit) => {
    try { scanMetadataSecrets(hit.clauses); } catch { unsupported(name, unit, "secret-shaped assertion literal omitted"); return; }
    const bad = hit.clauses.find((c) => "matches" in c && unsafePattern(c.matches));
    if (bad) { unsupported(name, unit, `assertion pattern refused: ${unsafePattern(bad.matches)}`); return; }
    const indices = hit.clauses.map((clause) => {
      const index = expect.length;
      expect.push(clause); assertion_metadata.push({ test_name: label(name), construct_sha256: sha256(unit) });
      return index;
    });
    translatedByPattern[hit.label] = (translatedByPattern[hit.label] ?? 0) + hit.clauses.length;
    construct_ledger.push({ name: label(name), disposition: "translated", assertion_indices: indices, source_sha256: sha256(unit) });
  };
  const scan = (body, inherited = new Map(), name = "(script)", depth = 0) => {
    if (depth > 8) { unsupported(name, body, "script nesting exceeds the static translation limit"); return; }
    const aliases = new Map(inherited);
    for (const unit of scriptUnits(body)) {
      const text = unit.trim();
      if (!text) continue;
      const test = text.match(/^pm\.test\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`$]*`))\s*,\s*(?:function\s*\(\s*\)|\(\s*\)\s*=>)\s*\{([\s\S]*)\}\s*\)\s*;?$/);
      if (test) {
        construct_ledger.push({ name: label(staticString(test[1]) ?? "(test)"), disposition: "not-applicable", reason: "test label; assertions classified individually", source_sha256: sha256(test[1]) });
        scan(test[2], aliases, staticString(test[1]) ?? "(test)", depth + 1); aliases.clear(); continue;
      }
      const alias = text.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*)$/);
      if (alias) {
        const path = pathOfSelector(alias[2], aliases);
        if (path !== null) {
          aliases.set(alias[1], path);
          construct_ledger.push({ name: label(`${name}:alias:${alias[1]}`), disposition: "not-applicable", reason: "response selector alias", source_sha256: sha256(text) }); continue;
        }
        aliases.delete(alias[1]);
      }
      const assignment = text.match(/^tests\s*\[\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\]\s*=\s*([\s\S]*)$/);
      if (assignment) {
        const testName = staticString(assignment[1]) ?? name, expr = assignment[2].trim();
        const status = expr.match(/^responseCode\.code\s*(?:===|==)\s*(\d{3})$|^(\d{3})\s*(?:===|==)\s*responseCode\.code$/);
        if (status) { add(testName, text, { label: "status", clauses: [{ status: Number(status[1] ?? status[2]) }] }); continue; }
        const header = expr.match(/^responseHeaders\s*(?:\[\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\]|\.get\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))\s*\))\s*(===|==|!==|!=)\s*([\s\S]+)$/);
        if (header) {
          const key = staticString(header[1] ?? header[2]), op = header[3], value = literal(header[4]);
          if (key && header[4] === "undefined") { add(testName, text, { label: "header", clauses: [{ header: key, exists: op === "!==" || op === "!=" }] }); continue; }
          // Header values are strings. Loose equality to non-strings coerces,
          // and therefore has no faithful strict-equality clause.
          if (key && value.ok && typeof value.value === "string") { add(testName, text, { label: "header", clauses: [{ header: key, [op.startsWith("!") ? "not_equals" : "equals"]: value.value }] }); continue; }
        }
        const has = expr.match(/^responseHeaders\.has\(\s*(["'])([^"']+)\1\s*\)$/);
        if (has) { add(testName, text, { label: "header", clauses: [{ header: has[2], exists: true }] }); continue; }
        if (/responseTime/.test(expr)) reportedOnly.push("response-time comparison (not executed)");
        unsupported(testName, text, /responseTime/.test(expr) ? "response-time comparison has no suite target" : "legacy assertion is outside the complete mechanical grammar"); continue;
      }
      const hit = translateStatement(text, aliases);
      if (hit) { add(name, text, hit); continue; }
      const mutation = text.match(/^(?:postman\.setEnvironmentVariable|pm\.(?:collectionVariables|environment|variables)\.set)\(\s*(["'])([^"']+)\1/);
      const called = text.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(/)?.[1];
      aliases.clear();
      unsupported(mutation ? `${called}(${mutation[2]})` : name === "(script)" && called ? called : name, text,
        mutation ? "Postman variable state does not have faithful suite semantics; environment mutation is quarantined"
        : /setNextRequest|setTimeout/.test(text) ? "runner flow control is unsupported; request order is not verified"
        : /\b(?:if|switch|try|catch|for|while)\b|\.forEach\s*\(/.test(text) ? "conditional, exception or loop execution is outside the static grammar"
        : "unrecognized script statement; no faithful assertion mapping");
    }
  };
  if (src.length > 64 * 1024) unsupported("(script)", src, "script exceeds the 64 KB static translation cap");
  else scan(src);
  if (src.trim() && !construct_ledger.length) construct_ledger.push({ name: "(script)", disposition: "not-applicable", reason: "comments or empty statements only", source_sha256: sha256(src) });
  return { expect, manual, quarantined, translatedByPattern, reportedOnly, dialect, construct_ledger, assertion_metadata, prerequisites };
}

// --- the importer ------------------------------------------------------------

const slug = (s) => String(scanMetadataSecrets(s)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "request";

/** Flatten Postman's folder tree into [{ path:["folder","name"], request, event, response }]. */
function flattenItems(items, prefix = [], inherited = { events: [], auth: null }, lineage = []) {
  const out = [];
  for (const [slot, it] of (Array.isArray(items) ? items : []).entries()) {
    const owner = [...lineage, slot];
    const names = [...prefix, it?.name ?? (it?.item ? "folder" : "request")];
    if (Array.isArray(it?.item)) {
      if (prefix.length >= 32) out.push({ names, item: { [ADAPTER.quarantined]: "import nesting exceeds depth 32" }, inherited });
      else out.push(...flattenItems(it.item, names, { events: [...inherited.events, ...(it.event ?? []).map((event, eventSlot) => ({ event, scope: names.join("/"), owner: `folder:${owner.join(".")}:event:${eventSlot}` }))], auth: it.auth ?? inherited.auth, authOwner: it.auth ? `folder:${owner.join(".")}:auth` : inherited.authOwner }, owner));
    } else if (it?.request && out.length < 10000) out.push({ names, item: it, inherited });
  }
  return out;
}

function urlOf(request) {
  const u = request?.url;
  if (typeof u === "string") return { raw: u, query: [] };
  return { raw: u?.raw ?? "", query: u?.query ?? [] };
}

/** Extract a base-relative path from a raw URL. The query string is split off
 *  and returned as pairs — the emitted `path` NEVER carries a query, so the
 *  secret-param filter has exactly one surface to guard (`params`). */
function pathOf(raw) {
  const t = raw.trim();
  const q = t.indexOf("?");
  const bare = (q === -1 ? t : t.slice(0, q)).split("#")[0];
  const pairs = q === -1 ? [] : [...new URLSearchParams(t.slice(q + 1).split("#")[0])].map(([key, value]) => ({ key, value }));
  const abs = bare.match(/^https?:\/\/([^/?#]+)([^?#]*)/i);
  if (abs) {
    const at = abs[1].lastIndexOf("@");
    if (at !== -1) return { host: abs[1].slice(at + 1), path: abs[2] || "/", pairs, userinfo: true };
    return { host: abs[1], path: abs[2] || "/", pairs };
  }
  return { host: null, path: bare.startsWith("/") ? bare : `/${bare}`, pairs };
}

/**
 * Convert a parsed Postman v2.1 collection into:
 *   { suite, todo, environment, report, provenance }
 * Pure. `values` is the optional Postman-environment map for {{var}}.
 */
function importPostmanUnchecked(collection, { values = {}, suiteName = null, sourceText = "", sourceKind = "postman-v2.1", environmentNames = [], variableNames = [] } = {}) {
  const name = suiteName ?? slug(collection?.info?.name ?? "imported");
  const flat = flattenItems(collection?.item, [], { events: (collection?.event ?? []).map((event, eventSlot) => ({ event, scope: "collection", owner: `collection:event:${eventSlot}` })), auth: collection?.auth ?? null, authOwner: "collection:auth" });
  const sourceDigest = sha256(sourceText || stableStringify(collection));
  const runtimeNames = new Set([...Object.keys(values), ...variableNames,
    ...(collection?.variable ?? []).filter(v => v?.key).map(v => v.key)]);
  // External environment values are intentionally never resolved into saved
  // artifacts. A supplied key remains a named input even if a collection also
  // defines it. Empty collection placeholders are equally unresolved.
  const collectionValues = Object.fromEntries(importArray(collection?.variable, "POSTMAN_INPUT_INVALID", "Postman collection.variable")
    .filter((v) => v?.key && !Object.hasOwn(values, v.key) && v.value !== "" && v.value !== null && v.value !== undefined)
    .map((v) => [v.key, v.value]));
  const steps = [], todo = [], ledger = [], knowledgeCandidates = [], construct_ledger = [];
  const origins = new Map(), ids = new Map();
  let secretsOmitted = 0, manualScripts = 0, derivedAssertions = 0, translatedAssertions = 0, translatedItems = 0;
  const quarantinedScripts = [], translatedByPattern = {};
  const dialects = { modern: { translated: 0, quarantined: 0 }, legacy: { translated: 0, quarantined: 0 } };
  const bounded = (value) => String(redactMetadataSecrets(String(value))).replace(/[\x00-\x1f]/g, " ").slice(0, 180);
  const authReference = (auth) => {
    if (auth?.type === "bearer") return "bearer:POSTMAN_BEARER_TOKEN";
    if (auth?.type !== "apikey" || !Array.isArray(auth.apikey)) return null;
    const fields = auth.apikey.filter((field) => field?.key === "key" || field?.key === "in");
    if (fields.length !== 2 || new Set(fields.map((field) => field.key)).size !== 2) return null;
    const name = fields.find((field) => field.key === "key")?.value;
    const location = fields.find((field) => field.key === "in")?.value;
    // Preserve the authored placement and name; guessing X-API-Key changes
    // authentication. Variable/computed names require explicit conversion.
    if (typeof name !== "string" || !/^[A-Za-z0-9._~-]+$/.test(name) || secretIn(name)) return null;
    return ["header", "query"].includes(location) ? `${location}:${name}:POSTMAN_API_KEY` : null;
  };
  const usedBase = new Map();
  const ownedLosses = new Set();
  const loss = (id, entries, notes, entry, scope = "request", owner = null) => {
    const safe = { name: bounded(entry.name ?? entry.script ?? "(script)"), reason: bounded(entry.reason) };
    if (!owner) entries.push(safe);
    notes.push(`${safe.name} quarantined: ${safe.reason}`);
    const key = owner && stableStringify([owner, safe.name, entry.source_sha256 ?? null]);
    if (key && ownedLosses.has(key)) return;
    if (key) ownedLosses.add(key);
    manualScripts++;
    quarantinedScripts.push({ script: `${owner ?? id}:${safe.name}`, reason: safe.reason, source: scope });
    construct_ledger.push({ ...(owner ? { source_id: bounded(owner) } : { item_id: id }), scope, ...safe, disposition: "named-unsupported", ...(entry.source_sha256 ? { source_sha256: entry.source_sha256 } : {}) });
  };
  const previousWrites = new Map();
  for (const [position, { names, item, inherited }] of flat.entries()) {
    const req = item.request ?? {}, method = String(req.method ?? "GET").toUpperCase();
    const idBase = names.map(slug).join("/"), repeated = ids.get(idBase) ?? 0;
    ids.set(idBase, repeated + 1);
    const id = repeated ? `${idBase}--${sha256(`${method}:${urlOf(req).raw}:${item.id ?? item._postman_id ?? repeated}`).slice(0, 10)}` : idBase;
    const notes = [], losses = [], blockers = [], prerequisites = [...(item[ADAPTER.prerequisites] ?? [])], unresolved = [], assertionMetadata = [];
    const { raw, query } = urlOf(req);
    const queryAt = raw.indexOf("?"), bareRaw = queryAt < 0 ? raw : raw.slice(0, queryAt);
    // Resolve before path parsing. Prepending '/' first used to turn a named
    // base-URL variable into a malformed '/https://host/path' path.
    const resolve = (value, location) => {
      const found = [...String(value).matchAll(VAR)].map((m) => m[1]);
      for (const variable of found) if (variable !== "baseUrl") prerequisites.push({ kind: "variable-use", variable: bounded(variable), location, verification: "unverified", executable: false });
      const resolved = resolveVars(value, collectionValues);
      return { ...resolved, blocking: resolved.unresolved.filter(name => !runtimeNames.has(name)),
        text: resolved.text.replace(VAR, (whole, name) => runtimeNames.has(name) && !secretShapedName(name) ? `{${name}}` : whole) };
    };
    const fullBase = bareRaw.replace(/^\{\{\s*([^}\s]+)\s*\}\}(?=\/|$)/, (whole, name) => {
      if (typeof collectionValues[name] === 'string' && /^https?:\/\//i.test(collectionValues[name])) return collectionValues[name].replace(/\/$/, '');
      if (name === 'baseUrl' || runtimeNames.has(name)) {
        prerequisites.push({ kind: 'runtime-base-url', variable: bounded(name), source: bounded(name), status: 'unverified', executable: false });
        return '';
      }
      return whole;
    });
    const rp = resolve(fullBase, "path"), split = pathOf(rp.text), rawSplit = pathOf(raw);
    let path = split.path.replace(/^\/{2,}/, "/"), provider = null;
    const absolute = rp.text.match(/^(https?):\/\/([^/?#]+)(?:[/?#]|$)/i);
    if (absolute && !split.userinfo && !secretIn(absolute[2])) {
      try { provider = new URL(`${absolute[1]}://${absolute[2]}`).origin; } catch { blockers.push("invalid provider URL"); }
    }
    if (provider) origins.set(provider, (origins.get(provider) ?? 0) + 1);
    if (split.userinfo) { secretsOmitted++; blockers.push("URL userinfo was omitted"); }
    if (secretIn(path)) { secretsOmitted++; path = "/{redacted}"; blockers.push("credential-shaped path was omitted"); }
    unresolved.push(...rp.unresolved, ...rp.secrets); blockers.push(...rp.blocking, ...rp.secrets);
    // Template preserves unresolved IDs without persisting supplied values.
    const pathTemplate = path.replace(VAR, (_, variable) => `{${bounded(variable)}}`);
    const previousWrite = previousWrites.get(`${provider ?? ""}|${pathTemplate}`) ?? null;
    const headers = {}, params = {};
    let authState = "none";
    const ownAuth = req.auth ?? item.auth;
    const explicitNoAuth = ["noauth", "none"].includes(ownAuth?.type);
    const inheritedAuth = item[ADAPTER.inheritedAuth] ?? inherited.auth;
    const inheritedAuthOwner = item[ADAPTER.inheritedAuthOwner] ?? inherited.authOwner ?? "inherited authentication";
    const auth = ownAuth ?? inheritedAuth;
    // An explicit absence requirement overrides the parent auth declaration;
    // ancillary headers and other inherited setup are still recorded below.
    if (inheritedAuth && !explicitNoAuth) prerequisites.push({ kind: 'inherited-auth', source: 'inherited authentication', source_id: bounded(inheritedAuthOwner), status: 'unverified', executable: false });
    let authRef = item[ADAPTER.authRef] ?? authReference(auth);
    if (explicitNoAuth) authRef = 'none';
    if (authRef) authState = authRef === "none" ? "none" : "reference";
    else if (auth && auth.type !== "noauth" && auth.type !== "none") {
      authState = "unknown";
      const reason = auth.type === "basic" ? "Basic authentication needs manual mapping to username/password environment-variable references" : "unsupported authentication or unresolved credential placement/name";
      if (ownAuth) blockers.push(reason);
      else loss(id, losses, notes, { name: 'inherited authentication', reason }, 'inherited authentication', inheritedAuthOwner);
    }
    const seenHeaders = new Set();
    for (const h of req.header ?? []) {
      if (!h?.key || h.disabled) continue;
      if (seenHeaders.has(String(h.key).toLowerCase())) blockers.push(`duplicate header semantics: ${h.key}`);
      seenHeaders.add(String(h.key).toLowerCase());
      if (SECRET_HEADERS.test(h.key) || CREDENTIAL_SHAPED_HEADER.test(h.key)) {
        secretsOmitted++;
        const safeName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(h.key) && !secretIn(h.key);
        const existingHeader = authRef?.startsWith('bearer:') ? 'authorization' : authRef?.startsWith('header:') ? authRef.split(':')[1].toLowerCase() : null;
        const variable = safeName ? `IMPORTED_${h.key.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 100)}_${sha256(h.key.toLowerCase()).slice(0,8).toUpperCase()}` : null;
        const reference = variable ? `header:${h.key}:${variable}` : null;
        if (h[ADAPTER.inherited]) prerequisites.push({ kind: 'inherited-auth', source: `inherited credential header ${bounded(h.key)}`, ...(reference ? { variable, reference_digest: sha256(reference) } : {}), status: 'unverified', executable: false });
        if (h[ADAPTER.inherited] && authRef) {
          // Ancillary inherited setup stays visible, but cannot replace the
          // effective credential binding or veto an otherwise runnable step.
        } else if (!safeName || (authRef && existingHeader !== h.key.toLowerCase())) {
          authState = 'unknown'; blockers.push('credential headers require incompatible or unsupported authentication references');
        } else { authRef ??= reference; authState = 'reference'; }
        notes.push(`header omitted; supply its configured credential reference: ${bounded(h.key)}`); continue;
      }
      const hv = resolve(h.value ?? "", "header");
      if (hv.secrets.length || secretIn(hv.text)) { secretsOmitted++; blockers.push(`secret-shaped header omitted: ${h.key}`); continue; }
      headers[h.key] = hv.text; unresolved.push(...hv.unresolved); blockers.push(...hv.blocking);
    }
    for (const q of (query ?? []).length ? query : rawSplit.pairs) {
      if (!q?.key || q.disabled) continue;
      if (Object.hasOwn(params, q.key)) blockers.push(`duplicate query semantics: ${q.key}`);
      if (SECRET_PARAMS.test(q.key)) { secretsOmitted++; blockers.push(`credential query omitted: ${q.key}`); authState = "omitted"; continue; }
      const qv = resolve(q.value ?? "", "query");
      if (qv.secrets.length || secretIn(qv.text)) { secretsOmitted++; blockers.push(`secret-shaped query omitted: ${q.key}`); continue; }
      params[q.key] = qv.text; unresolved.push(...qv.unresolved); blockers.push(...qv.blocking);
    }
    let body;
    if (req.body?.mode === "raw" && req.body.raw) {
      const rb = resolve(req.body.raw, "body"); unresolved.push(...rb.unresolved, ...rb.secrets); blockers.push(...rb.blocking, ...rb.secrets);
      try {
        body = scrubBody(JSON.parse(rb.text), (where) => { secretsOmitted++; blockers.push(`secret omitted from ${where}`); });
        if (typeof body === "string") blockers.push("JSON string body needs manual conversion: the client sends string bodies as raw text");
      }
      catch { blockers.push("raw non-JSON body requires manual conversion"); }
    } else if (req.body?.mode === "urlencoded") {
      blockers.push("urlencoded body cannot be represented as a JSON body without changing request semantics");
    } else if (req.body?.mode) blockers.push(`unsupported body mode: ${req.body.mode}`);
    if (unresolved.length) notes.push(`unresolved variable(s) retained by name: ${[...new Set(unresolved)].join(", ")}`);
    for (const entry of [...(item[ADAPTER.insomniaLoss] ?? []), ...(item[ADAPTER.brunoLoss] ?? [])]) loss(id, losses, notes, entry, sourceKind, entry.owner ?? null);
    if (item[ADAPTER.quarantined]) blockers.push(item[ADAPTER.quarantined]);
    // Inherited events can alter request state. They are named by scope; never
    // silently applied as unconditional request assertions.
    const inheritedTests = [];
    for (const { event, scope, owner } of inherited.events) {
      const text = Array.isArray(event.script?.exec) ? event.script.exec.join("\n") : String(event.script?.exec ?? "");
      if (text.trim()) {
        if (event.listen === "test") { inheritedTests.push({ ...event, [ADAPTER.scope]: `${scope}:test`, [ADAPTER.owner]: `${owner ?? scope}:test` }); continue; }
        const source = `${scope}:${event.listen ?? 'event'}`;
        loss(id, losses, notes, { name: source, reason: "inherited script is unsupported; setup and runner state are not executed", source_sha256: sha256(text) }, scope, `${owner ?? scope}:${event.listen ?? "event"}`);
        prerequisites.push({ kind: 'inherited-setup', source: bounded(source), source_id: bounded(`${owner ?? scope}:${event.listen ?? 'event'}`), source_sha256: sha256(text), status: 'unverified', executable: false });
      } else construct_ledger.push({ item_id: id, scope, name: `${scope}:${event.listen ?? "event"}`, disposition: "not-applicable", reason: "empty event" });
    }
    let expect = [...(item[ADAPTER.brunoAssertions] ?? [])], reportedOnly = [];
    for (const [index, clause] of expect.entries()) assertionMetadata.push(item[ADAPTER.brunoMetadata]?.[index] ?? { test_name: "Bruno assertion", construct_sha256: sha256(stableStringify(clause)) });
    if (expect.length) {
      translatedAssertions += expect.length;
      if (item[ADAPTER.brunoLedger]?.length) construct_ledger.push(...item[ADAPTER.brunoLedger].filter((entry) => entry.disposition !== "named-unsupported").map((entry) => ({ ...entry, item_id: id, scope: "Bruno tests" })));
      const covered = new Set((item[ADAPTER.brunoLedger] ?? []).flatMap((entry) => entry.assertion_indices ?? []));
      for (const [index] of expect.entries()) if (!covered.has(index)) construct_ledger.push({ item_id: id, scope: "Bruno assert", name: assertionMetadata[index]?.test_name ?? `assertion:${index}`, disposition: "translated", assertion_indices: [index] });
    }
    for (const [eventIndex, event] of [...inheritedTests, ...(item.event ?? [])].entries()) {
      const text = Array.isArray(event.script?.exec) ? event.script.exec.join("\n") : String(event.script?.exec ?? "");
      const scope = event[ADAPTER.scope] ?? `request:${eventIndex}:${event.listen ?? "event"}`;
      if (!text.trim()) { construct_ledger.push({ item_id: id, scope, name: event.listen ?? "event", disposition: "not-applicable", reason: "empty event" }); continue; }
      if (event.listen !== "test") {
        loss(id, losses, notes, { name: event.listen ?? "event", reason: "setup or non-test event is unsupported; scripts are never executed during import", source_sha256: sha256(text) }, scope);
        prerequisites.push({ kind: 'request-setup', source: bounded(scope), source_sha256: sha256(text), status: 'unverified', executable: false }); continue;
      }
      const t = translateTests(event.script?.exec), offset = expect.length;
      expect.push(...t.expect); assertionMetadata.push(...t.assertion_metadata); prerequisites.push(...t.prerequisites);
      reportedOnly.push(...t.reportedOnly); translatedAssertions += t.expect.length;
      dialects[t.dialect].translated += t.expect.length; dialects[t.dialect].quarantined += t.manual.length;
      for (const [pattern, count] of Object.entries(t.translatedByPattern)) translatedByPattern[pattern] = (translatedByPattern[pattern] ?? 0) + count;
      for (const entry of t.construct_ledger) {
        const ownerKey = event[ADAPTER.scope] && entry.disposition === 'named-unsupported' ? stableStringify([event[ADAPTER.owner], entry.name, sha256(text)]) : null;
        if (ownerKey && ownedLosses.has(ownerKey)) continue;
        if (ownerKey) ownedLosses.add(ownerKey);
        construct_ledger.push({ ...entry, ...(ownerKey ? { source_id: event[ADAPTER.owner] } : { item_id: id }), scope, ...(entry.assertion_indices ? { assertion_indices: entry.assertion_indices.map((index) => index + offset) } : {}) });
      }
      for (const entry of t.quarantined) {
        const safe = { name: entry.script, reason: entry.reason };
        const lossKey = event[ADAPTER.scope] ? stableStringify(['loss', event[ADAPTER.owner], entry.script, sha256(text)]) : null;
        if (!event[ADAPTER.scope]) losses.push(safe);
        if (lossKey && ownedLosses.has(lossKey)) continue;
        if (lossKey) ownedLosses.add(lossKey);
        manualScripts++;
        quarantinedScripts.push({ script: `${event[ADAPTER.owner] ?? id}:test:${entry.script}`, reason: entry.reason, source: scope });
        notes.push(`test script quarantined: ${entry.script}`);
      }
    }
    const safeExpect = [], safeMetadata = [];
    for (const [index, clause] of expect.entries()) {
      let secret = false;
      try { scanMetadataSecrets(clause); } catch { secret = true; }
      const bad = secret ? "secret-shaped assertion literal omitted" : "matches" in clause && unsafePattern(clause.matches);
      if (bad) { translatedAssertions--; loss(id, losses, notes, { name: `assertion:${index}`, reason: `assertion pattern refused: ${bad}` }); }
      else { safeExpect.push(clause); safeMetadata.push(assertionMetadata[index]); }
    }
    expect = safeExpect;
    if (expect.length) translatedItems++;
    let derivedHere = false;
    if (!expect.length) {
      const example = (item.response ?? []).find((r) => Number.isInteger(r?.code));
      if (example) { expect = [{ status: example.code }]; derivedHere = true; notes.push(`assertion derived from saved example (status ${example.code})`); }
    }
    if (reportedOnly.length) notes.push(`reported-only legacy fact(s): ${reportedOnly.join("; ")}`);
    const step = { id, method, path, ...(Object.keys(params).length ? { params } : {}), ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body } : {}), ...(authRef ? { auth: authRef } : {}), ...(prerequisites.length ? { prerequisites } : {}), ...(expect.length ? { expect, assertion_provenance: expect.map(() => derivedHere ? "inferred" : "translated") } : {}) };
    const uniqueBlockers = [...new Set(blockers)];
    for (const blocker of uniqueBlockers) loss(id, losses, notes, { name: "request semantics", reason: blocker }, "request shape");
    if (uniqueBlockers.length || !expect.length) {
      todo.push({ ...step, todo: uniqueBlockers.length ? `unresolved request semantics: ${uniqueBlockers.join(", ")}; supply runtime references or edit the source` : "no assertion translatable or derivable — add an expect before this step can prove anything" });
      ledger.push({ id, status: "todo", notes: [...notes, ...uniqueBlockers] });
    } else { steps.push(step); if (derivedHere) derivedAssertions++; ledger.push({ id, status: "imported", notes }); }
    usedBase.set(id, provider);
    knowledgeCandidates.push({ item_id: id, method, path_template: pathTemplate, provider_base_url: provider,
      source_kind: sourceKind, source_sha256: sourceDigest, source_item_id: bounded(item.id ?? item._postman_id ?? id), request_name: bounded(item.name ?? names.at(-1)),
      disposition: uniqueBlockers.length || !expect.length ? "todo" : "imported",
      conditions: { auth: authState, ...(authRef ? { auth_reference_digest: sha256(authRef) } : {}), ...(uniqueBlockers.length || unresolved.length || prerequisites.some(p => /setup|runtime-base|inherited-auth/.test(p.kind)) ? {} : { request_case_digest: importCaseFingerprint({ path, params, body, headers }) }), position, unresolved_variables: [...new Set(unresolved.map(bounded))], preceded_by: previousWrite,
        request_case: Boolean(Object.keys(params).length || body !== undefined || Object.keys(headers).length || uniqueBlockers.length || previousWrite) },
      assertions: derivedHere ? [] : expect.map((clause, index) => ({ clause, index, ...(safeMetadata[index] ?? { test_name: "assertion" }), verification: "unverified" })), losses, prerequisites });
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) previousWrites.set(`${provider ?? ""}|${pathTemplate}`, id);
  }
  // Capture/use links describe authored prerequisites only. Import never runs
  // a chain or marks the link as observed, even when both steps are runnable.
  const captures = new Map();
  for (const candidate of knowledgeCandidates) {
    for (const prerequisite of candidate.prerequisites) {
      if (prerequisite.kind === "variable-use" && captures.has(prerequisite.variable)) Object.assign(prerequisite, captures.get(prerequisite.variable));
      if (prerequisite.kind === "capture") captures.set(prerequisite.variable, { from_item_id: candidate.item_id, from_path: prerequisite.response_path });
    }
  }
  const ranked = [...origins.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const baseUrl = ranked[0]?.[0] ?? null;
  if (ranked.length > 1) {
    // Existing suite runner accepts absolute URLs only for configured origins;
    // preserving identity does not authorize an imported host or cross-host auth.
    for (const step of [...steps, ...todo]) {
      const origin = usedBase.get(step.id);
      if (origin) step.path = origin + step.path;
      else if (steps.includes(step)) {
        steps.splice(steps.indexOf(step), 1); todo.push({ ...step, todo: "multi-origin collection has an unresolved provider; configure or edit explicitly" });
        ledger.find((row) => row.id === step.id).status = "todo";
        knowledgeCandidates.find((row) => row.item_id === step.id).disposition = "todo";
      }
    }
  }
  const suite = { v: ENVELOPE_VERSION, requests: steps };
  const provenance = { imported_at: null, source_sha256: sourceDigest, source_kind: sourceKind,
    items: Object.fromEntries([...steps, ...todo].map((step) => [step.id, sha256(stableStringify(step))])) };
  const report = { suite: name, source_kind: sourceKind,
    counts: { items: flat.length, imported: steps.length, todo: todo.length, assertions_translated: translatedAssertions,
      assertions_derived_from_examples: derivedAssertions, assertions_inferred: derivedAssertions, assertions_without_provenance: 0,
      scripts_needing_manual_conversion: manualScripts, scripts_quarantined: quarantinedScripts, assertions_translated_by_pattern: translatedByPattern,
      translated_quarantined_coverage: { translated: translatedItems, quarantined: Math.max(0, flat.length - translatedItems), ratio: flat.length ? translatedItems / flat.length : 0 },
      dialects, secrets_omitted_by_design: secretsOmitted, hosts_seen: ranked.map(([origin, count]) => `${origin} (${count})`) },
    environment: { baseUrl, auth: authReference(collection?.auth), ...(environmentNames.length || Object.keys(values).length ? { names: [...new Set([...environmentNames, ...Object.keys(values)])].map(bounded) } : {}) },
    required_origins: ranked.map(([origin]) => origin), items: ledger, construct_ledger };
  return { name, suite, todo, report, provenance, construct_ledger, knowledgeCandidates };
}

// --- P2 adapters -------------------------------------------------------------

/** Insomnia's template spelling is `{{ _.name }}`; the shared Postman
 * importer deliberately understands only the neutral `{{name}}` form. */
function insomniaTemplates(value) {
  return typeof value === "string"
    ? value.replace(/\{\{\s*_\.\s*([^}\s]+)\s*\}\}/g, "{{$1}}")
    : value;
}

function insomniaPath(id, groups, seen = new Set()) {
  const group = groups.get(id);
  if (!group || seen.has(id)) return [];
  seen.add(id);
  return [...insomniaPath(group.parentId, groups, seen), group.name ?? "folder"];
}

function insomniaAuth(authentication) {
  const type = String(authentication?.type ?? "").toLowerCase();
  if (!type) return null;
  if (type === "none" || type === "noauth") return null;
  const refs = { bearer: "bearer:POSTMAN_BEARER_TOKEN" };
  return refs[type] ? { ref: refs[type] } : { unsupported: type };
}

function inheritedHeadersBeforeOwn(inherited, own, keyOf = h => h.key) {
  const names = new Set(own.filter(h => !h.disabled).map(h => String(keyOf(h)).toLowerCase()));
  return [...inherited.filter(h => !names.has(String(keyOf(h)).toLowerCase())), ...own];
}
function insomniaRequestItem(request, inherited = {}) {
  const headers = inheritedHeadersBeforeOwn(importArray(inherited.headers, "INSOMNIA_INPUT_INVALID", "Insomnia inherited.headers").map(h => ({ ...h, [ADAPTER.inherited]: true })), importArray(request.headers, "INSOMNIA_INPUT_INVALID", "Insomnia request.headers"), h => h.name ?? h.key).map((h) => {
    if (!h || typeof h !== "object") throw importFailure("INSOMNIA_INPUT_INVALID", "Insomnia request.headers entry", "must be a mapping");
    return ({
    key: h.name ?? h.key,
    ...(h[ADAPTER.inherited] ? { [ADAPTER.inherited]: true } : {}),
    value: insomniaTemplates(h.value ?? ""),
    ...(h.disabled ? { disabled: true } : {}),
  }); });
  const query = (request.parameters ?? request.params ?? []).map((p) => ({
    key: p.name ?? p.key,
    value: insomniaTemplates(p.value ?? ""),
    ...(p.disabled ? { disabled: true } : {}),
  }));
  const rawBody = request.body?.text ?? request.body?.raw;
  const req = {
    method: request.method ?? "GET",
    url: { raw: insomniaTemplates(request.url ?? ""), query },
    header: headers,
    ...(rawBody !== undefined ? { body: { mode: "raw", raw: insomniaTemplates(rawBody) } } : {}),
  };
  const auth = insomniaAuth(request.authentication ?? inherited.auth);
  if (request.authentication && !['inherit', ''].includes(request.authentication.type ?? '')) req.auth = { type: request.authentication.type === 'none' ? 'noauth' : request.authentication.type };
  if (auth?.unsupported && request.authentication) req.auth = { type: auth.unsupported };
  const scripts = { ...(request.scripts ?? {}), ...(request.preRequestScript ? { preRequest: request.preRequestScript } : {}), ...(request.afterResponseScript ? { afterResponse: request.afterResponseScript } : {}) };
  const losses = [], prerequisites = [];
  for (const entry of inherited.scriptEntries ?? []) {
    if (typeof entry.value !== 'string' || !entry.value.trim()) continue;
    const source = `${entry.owner}:script:${entry.name}`, digest = sha256(entry.value);
    losses.push({ name: `script:${entry.name}`, reason: 'Insomnia script is quarantined; scripts are never executed during import', owner: source, source_sha256: digest });
    prerequisites.push({ kind: 'inherited-setup', source, source_sha256: digest, status: 'unverified', executable: false });
  }
  for (const [name, value] of Object.entries(scripts)) if (typeof value === 'string' && value.trim()) {
    losses.push({ name: `script:${name}`, reason: 'Insomnia script is quarantined; scripts are never executed during import', source_sha256: sha256(value) });
    prerequisites.push({ kind: 'request-setup', source: `script:${name}`, source_sha256: sha256(value), status: 'unverified', executable: false });
  }
  if (inherited.auth) prerequisites.push({ kind: 'inherited-auth', source: 'Insomnia inherited authentication', status: 'unverified', executable: false });
  if (auth?.unsupported) losses.push({ name: `auth:${auth.unsupported}`, reason: `Insomnia auth type '${auth.unsupported}' is unsupported`, source: 'authentication' });
  return {
    name: request.name ?? "request",
    request: req,
    ...(auth?.ref ? { [ADAPTER.authRef]: auth.ref } : {}),
    ...(inherited.auth ? { [ADAPTER.inheritedAuth]: { type: inherited.auth.type === 'none' ? 'noauth' : inherited.auth.type }, [ADAPTER.inheritedAuthOwner]: inherited.authOwner ?? 'Insomnia inherited authentication' } : {}),
    ...(losses.length ? { [ADAPTER.insomniaLoss]: losses } : {}),
    ...(prerequisites.length ? { [ADAPTER.prerequisites]: prerequisites } : {}),
    ...(request.responses ? { response: (Array.isArray(request.responses) ? request.responses : [request.responses]).map((r) => ({ code: Number(r.statusCode ?? r.status ?? r.code) })).filter((r) => Number.isInteger(r.code)) } : {}),
    ...(request._response ? { response: [{ code: Number(request._response.statusCode ?? request._response.status) }] } : {}),
  };
}

/** Convert an Insomnia v4 export to the Postman-shaped intermediate used by
 * the importer. Unsupported request semantics remain visible as todo or
 * report notes instead of being approximated. */
export function insomniaCollection(exported, { suiteName = null } = {}) {
  const resources = Array.isArray(exported?.resources) ? exported.resources : [];
  const groups = new Map(resources.filter((r) => r?._type === "request_group").map((r) => [r._id, r]));
  const responses = new Map(resources.filter((r) => r?._type === "response").map((r) => [r.parentId, r]));
  const requests = resources.filter((r) => r?._type === "request");
  const items = requests.map((r) => {
    const inherited = { headers: [], auth: null, scriptEntries: [] };
    const chain = [];
    let parent = groups.get(r.parentId);
    const ancestors = new Set();
    while (parent) {
      if (ancestors.has(parent)) throw importFailure("INSOMNIA_PARENT_CYCLE", "Insomnia request.parentId", "parent references contain a cycle");
      if (chain.length >= 32) throw importFailure("INSOMNIA_DEPTH_EXCEEDED", "Insomnia request.parentId", "parent nesting exceeds depth 32");
      ancestors.add(parent); chain.unshift(parent); parent = groups.get(parent.parentId);
    }
    for (const group of chain) {
      inherited.headers.push(...(group.headers ?? []));
      if (group.authentication) { inherited.auth = group.authentication; inherited.authOwner = `${group._id}:auth`; }
      inherited.scriptEntries.push(...Object.entries({ ...(group.scripts ?? {}), ...(group.preRequestScript ? { preRequest: group.preRequestScript } : {}), ...(group.afterResponseScript ? { afterResponse: group.afterResponseScript } : {}) }).map(([name, value]) => ({ owner: group._id, name, value })));
    }
    const response = responses.get(r._id);
    return { source: r, item: insomniaRequestItem({ ...r, ...(response ? { _response: response } : {}) }, inherited) };
  });
  const nested = [];
  for (const item of items) {
    const names = insomniaPath(item.source.parentId, groups);
    let cursor = nested;
    for (const name of names) {
      let folder = cursor.find((x) => x.name === name && Array.isArray(x.item));
      if (!folder) { folder = { name, item: [] }; cursor.push(folder); }
      cursor = folder.item;
    }
    cursor.push(item.item);
  }
  const name = suiteName ?? resources.find((r) => r?._type === "workspace")?.name ?? "insomnia-import";
  const authTypes = [...new Set(requests.map((r) => String(r.authentication?.type ?? "").toLowerCase()).filter(Boolean))];
  const authType = authTypes.length === 1 ? (authTypes[0] === "apikey" ? "apikey" : authTypes[0]) : null;
  return { info: { name }, item: nested, ...(authType ? { auth: { type: authType } } : {}) };
}

function importInsomniaUnchecked(exported, options = {}) {
  options = { ...options, sourceText: options.sourceText || stableStringify(exported) };
  const kind = exported?.type;
  const refusal = (code, message, documentType) => {
    throw Object.assign(new Error(message), { code, ...(documentType ? { documentType } : {}) });
  };
  if (kind === "environment.insomnia.rest/5.0") {
    const environments = [];
    const addEnvironment = (env) => {
      if (!env || typeof env !== "object" || typeof env.name !== "string") return;
      const vars = Object.keys(env.data ?? {});
      environments.push({ name: env.name, vars, secrets: vars.filter(secretShapedName) });
      for (const child of env.subEnvironments ?? []) addEnvironment(child);
    };
    addEnvironment(exported.environments);
    const environmentFacts = environments.map((fact) => ({ ...fact }));
    const sourceKind = "insomnia-v5-environment";
    const report = {
      suite: slug(exported.name ?? "insomnia-environment"),
      source_kind: sourceKind,
      document: { type: kind, description: "Insomnia environment document; variable names retained and values omitted" },
      environmentFacts,
      counts: { items: 0, imported: 0, todo: 0, assertions_translated: 0, assertions_derived_from_examples: 0,
        assertions_inferred: 0, assertions_without_provenance: 0, scripts_needing_manual_conversion: 0,
        scripts_quarantined: [], secrets_omitted_by_design: Object.values(exported.environments?.data ?? {}).length,
        hosts_seen: [] },
      items: [],
    };
    return { name: report.suite, suite: { v: ENVELOPE_VERSION, requests: [] }, todo: [], report,
      provenance: { imported_at: null, source_kind: sourceKind, items: {} }, environmentFacts };
  }
  if (kind === "mcpClient.insomnia/5.0")
    refusal("INSOMNIA_UNSUPPORTED_DOCUMENT", `Unsupported Insomnia document type: ${kind}`, kind);
  if (kind && kind !== "collection.insomnia.rest/5.0" && kind !== "spec.insomnia.rest/5.0" && kind !== "export")
    refusal("INSOMNIA_UNSUPPORTED_DOCUMENT", "Insomnia document.type: must name a supported document type");
  if (kind === "collection.insomnia.rest/5.0" || kind === "spec.insomnia.rest/5.0") {
    if (kind === "spec.insomnia.rest/5.0" && !exported.collection) {
      const out = importPostman({ info: { name: exported.name ?? "insomnia-import" }, item: [] }, { ...options, sourceKind: "insomnia-v5-spec" });
      const contents = exported.spec?.contents;
      if (contents) out.report.wrapped_spec = { kind: "openapi", version: contents.openapi, title: contents.info?.title };
      return out;
    }
    if (!Array.isArray(exported.collection) && !exported.collection?.item && !exported.collection?.requests)
      refusal("INSOMNIA_UNSUPPORTED_DOCUMENT", `Unsupported Insomnia document type: ${kind}`, kind);
    const tree = exported.collection ?? [];
    const resources = [];
    const walk = (nodes, parentId = "root", inherited = {}) => {
      for (const node of nodes ?? []) {
        const id = node._id ?? node.meta?.id ?? `${parentId}/${node.name ?? "item"}`;
        const isRequest = node.meta?.id?.startsWith("req_") || node.type === "request" || node._type === "request" || (node.method && !node.children);
        const auth = node.authentication ?? inherited.auth;
        const headers = [...(inherited.headers ?? []), ...(node.headers ?? [])];
        const scriptEntries = [...(inherited.scriptEntries ?? []), ...Object.entries({ ...(node.scripts ?? {}), ...(node.preRequestScript ? { preRequest: node.preRequestScript } : {}), ...(node.afterResponseScript ? { afterResponse: node.afterResponseScript } : {}) }).map(([name, value]) => ({ owner: id, name, value }))];
        if (isRequest) resources.push({ ...node, _id: id, _type: 'request', parentId, [ADAPTER.inherited]: inherited });
        else { resources.push({ ...node, _id: id, _type: 'request_group', parentId }); walk(node.children ?? node.item, id, { ...inherited, headers, auth, authOwner: node.authentication ? `${id}:auth` : inherited.authOwner, scriptEntries }); }
      }
    };
    walk(Array.isArray(tree) ? tree : tree.item ?? tree.requests);
    const v5 = { resources, _type: "export", _v5: true };
    const collection5 = { info: { name: exported.name ?? "insomnia-import" }, item: [] };
    const byId = new Map(resources.map((r) => [r._id, r]));
    for (const r of resources.filter((x) => x._type === "request")) {
      const inherited = r[ADAPTER.inherited] ?? {};
      const item = insomniaRequestItem(r, inherited);
      let cursor = collection5.item;
      const path = [];
      let parent = byId.get(r.parentId);
      const ancestors = new Set();
      while (parent && parent._id !== "root") {
        if (ancestors.has(parent)) throw importFailure("INSOMNIA_PARENT_CYCLE", "Insomnia request.parentId", "parent references contain a cycle");
        if (path.length >= 32) throw importFailure("INSOMNIA_DEPTH_EXCEEDED", "Insomnia request.parentId", "parent nesting exceeds depth 32");
        ancestors.add(parent); path.unshift(parent); parent = byId.get(parent.parentId);
      }
      for (const folder of path) { let out = cursor.find((x) => x.name === folder.name && x.item); if (!out) { out = { name: folder.name, item: [] }; cursor.push(out); } cursor = out.item; }
      cursor.push({ ...item, name: r.name ?? "request" });
    }
    const environmentNames = (Array.isArray(exported.environments) ? exported.environments : [exported.environments])
      .filter((x) => x && typeof x === "object" && typeof x.name === "string").map((x) => x.name);
    const sourceKind = kind === "spec.insomnia.rest/5.0" ? "insomnia-v5-spec" : "insomnia-v5";
    const out = importPostman(collection5, { ...options, sourceKind, environmentNames });
    if (kind === "spec.insomnia.rest/5.0" && exported.spec?.contents) {
      const contents = exported.spec.contents;
      out.report.wrapped_spec = { kind: "openapi", version: contents.openapi, title: contents.info?.title };
    }
    return out;
  }
  if (kind === "export" || Array.isArray(exported?.resources)) {
    const collection = insomniaCollection(exported, options);
    return importPostman(collection, { ...options, sourceKind: "insomnia-v4" });
  }
  refusal("INSOMNIA_DOCUMENT_UNRECOGNIZED", "Unsupported Insomnia document: expected v4 export resources or v5 collection");
}

function brunoBlocks(text) {
  const blocks = [];
  const head = /(^|\n)\s*([A-Za-z][\w:-]*)\s*\{/g;
  let match;
  while ((match = head.exec(text))) {
    const open = head.lastIndex - 1;
    let depth = 1, quote = null, escape = false, regexClass = false, line = false, comment = false, end = open + 1;
    for (; end < text.length && depth; end += 1) {
      const c = text[end], next = text[end + 1];
      if (line) { if (c === "\n") line = false; continue; }
      if (comment) { if (c === "*" && next === "/") { comment = false; end++; } continue; }
      if (quote) {
        if (escape) escape = false;
        else if (c === "\\") escape = true;
        else if (quote === "/" && c === "[") regexClass = true;
        else if (quote === "/" && c === "]") regexClass = false;
        else if (c === quote && !regexClass) quote = null;
        continue;
      }
      if (c === "/" && next === "/" && /^(tests|script:)/.test(match[2])) { line = true; end++; continue; }
      if (c === "/" && next === "*" && /^(tests|script:)/.test(match[2])) { comment = true; end++; continue; }
      if (c === "/" && /[(\[=,!&|?;{]$/.test(text.slice(open + 1, end).trimEnd()) && /^(tests|script:)/.test(match[2])) { quote = "/"; regexClass = false; continue; }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
    }
    if (depth && /^(tests|script:)/.test(match[2])) {
      // An unterminated vendor literal still leaves earlier complete statements
      // auditable. A line-aligned final block delimiter bounds this recovery;
      // the malformed tail is classified unsupported by the lexical recognizer.
      const closing = text.lastIndexOf("\n}");
      if (closing > open) end = closing + 2;
    }
    blocks.push({ name: match[2], body: text.slice(open + 1, end - 1) });
    head.lastIndex = end;
  }
  return blocks;
}

function brunoFields(body) {
  const out = {};
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("#")) continue;
    const colon = t.indexOf(":");
    if (colon === -1) continue;
    out[t.slice(0, colon).trim()] = t.slice(colon + 1).trim();
  }
  return out;
}

// Bruno's line-oriented maps deliberately allow repeated keys (assertions are
// the important example). Keep an entry list at the boundary; collapsing to an
// object here silently loses claims.
function brunoEntries(body) {
  const out = [];
  for (const line of body.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("//") || t.startsWith("#") || t.startsWith("@")) continue;
    const colon = t.indexOf(":");
    if (colon !== -1) out.push([t.slice(0, colon).trim(), t.slice(colon + 1).trim()]);
  }
  return out;
}

function brunoLiteral(raw) {
  const s = String(raw).trim();
  if (s === "undefined") return { ok: true, value: undefined };
  if (s === "null") return { ok: true, value: null };
  if (s === "true" || s === "false") return { ok: true, value: s === "true" };
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(s)) return { ok: true, value: Number(s) };
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) return { ok: true, value: s.slice(1, -1) };
  return { ok: true, value: s };
}

// Test arguments are JavaScript literals, unlike declarative Bruno values,
// which may be bare text. Consume the entire quoted token and decode only the
// supported escapes. Stripping the first/last quote used to turn a compound
// predicate into one invented literal, so negations silently passed. Do not
// evaluate source to resolve expressions or unsupported escape syntax.
function brunoTestLiteral(raw) {
  const s = raw.trim(), quote = s[0];
  if (quote !== '"' && quote !== "'") {
    if (/^(?:true|false|null)$/.test(s)) return brunoLiteral(s);
    // Identifiers (including uppercase keywords), undefined, legacy octal and
    // non-finite numbers cannot become faithful JSON expectations. Negative
    // zero also loses its identity through JSON.stringify, so refuse it.
    if (!/^-?(?:(?:0|[1-9]\d*)(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) return { ok: false };
    const value = Number(s);
    return Number.isFinite(value) && !Object.is(value, -0) ? { ok: true, value } : { ok: false };
  }
  let value = "";
  const escapes = { "'": "'", '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  for (let i = 1; i < s.length; i += 1) {
    const c = s[i];
    if (c === quote) return i === s.length - 1 ? { ok: true, value } : { ok: false };
    if (c === "\n" || c === "\r") return { ok: false };
    if (c !== "\\") { value += c; continue; }
    const escape = s[++i];
    if (Object.hasOwn(escapes, escape)) { value += escapes[escape]; continue; }
    if (escape === "0" && !/\d/.test(s[i + 1] ?? "")) { value += "\0"; continue; }
    const digits = escape === "x" ? 2 : escape === "u" ? 4 : 0;
    const hex = s.slice(i + 1, i + 1 + digits);
    if (!digits || hex.length !== digits || !/^[\da-f]+$/i.test(hex)) return { ok: false };
    value += String.fromCharCode(Number.parseInt(hex, 16));
    i += digits;
  }
  return { ok: false };
}

function brunoDeclarativeAssertions(body) {
  const out = [], unsupported = [], reportedOnly = [], refused = [];
  for (const [key, raw] of brunoEntries(body)) {
    const header = key.match(/^res\.headers(?:\.([A-Za-z0-9-]+)|\["([^"]+)"\]|\['([^']+)'\])$/i);
    if (header) {
      const m = raw.match(/^(eq)\s+(.+)$|^(isDefined)$/i);
      if (!m) { unsupported.push(`${key}: ${raw}`); continue; }
      const name = header[1] ?? header[2] ?? header[3];
      if (m[3]) out.push({ header: name, exists: true });
      else out.push({ header: name, equals: brunoLiteral(m[2]).value });
      continue;
    }
    if (/^res\.responseTime$/i.test(key)) {
      // Response time is report-only: the suite has no timing assertion target.
      reportedOnly.push(`${key}: ${raw}`);
      continue;
    }
    // `req.*` and arbitrary locals describe request/setup state, not the
    // response. They cannot become response assertions merely because their
    // spelling resembles a JSON path.
    if (!/^res\.(?:body(?:\.|$)|status$)/i.test(key)) { unsupported.push(`${key}: ${raw}`); continue; }
    const m = raw.match(/^(eq|neq|gt|gte|lt|lte|contains|isDefined|isUndefined|isTruthy|isFalsy|isNull|isNotNull|isArray|isObject|isString|isNumber|isBoolean|isJson|isTruthy)\b(?:\s+(.*))?$/i);
    if (!m) { unsupported.push(`${key}: ${raw}`); continue; }
    const op = m[1].toLowerCase(), target = key.replace(/^res\.body\.?/i, "");
    if (/^res\.status$/i.test(key)) {
      if (op === "eq" && /^\d{3}$/.test(m[2] ?? "")) out.push({ status: Number(m[2]) });
      else unsupported.push(`${key}: ${raw}`);
      continue;
    }
    const value = brunoLiteral(m[2] ?? "");
    // `gte`/`lte` used to map onto `gt`/`lt`. That is not a rounding error: it
    // turns a passing API red at exactly the boundary the author cared about
    // (`count: gte 1` is true at 1, `gt 1` is not), while the report counted
    // the clause translated. The suite has no inclusive comparator, so the
    // assertion is quarantined by name rather than approximated.
    if (op === "gte" || op === "lte") { refused.push({ name: `${key}: ${raw}`, reason: "gte/lte have no exact suite operator; not approximated as gt/lt" }); continue; }
    const map = { eq: "equals", neq: "not_equals", gt: "gt", lt: "lt", contains: "matches" };
    if (op === "isdefined") out.push({ json: target, exists: true });
    else if (op === "isundefined") out.push({ json: target, exists: false });
    else if (op === "isnull") out.push({ json: target, equals: null });
    else if (op === "isnotnull") out.push({ json: target, not_equals: null });
    else if (op === "isarray" || op === "isobject" || op === "isstring" || op === "isnumber" || op === "isboolean") out.push({ json: target, type: op.slice(2) });
    else if (op === "istruthy" || op === "isfalsy") refused.push({ name: `${key}: ${raw}`, reason: "truthiness has no exact suite operator; not approximated as boolean equality" });
    else if (op === "isjson") unsupported.push(`${key}: ${raw}`);
    else if (op === "contains") refused.push({ name: `${key}: ${raw}`, reason: "contains has no exact suite operator across JSON strings and arrays; not approximated as a regex" });
    else if (map[op] && value.ok) out.push({ json: target, [map[op]]: value.value });
    else unsupported.push(`${key}: ${raw}`);
  }
  return { out, unsupported, reportedOnly, refused };
}

function brunoTestAssertions(body) {
  const out = [], unsupported = [], loss = [];
  const safePattern = (pattern) => pattern.length <= 200 && !(/\([^)]*[+*][^)]*\)[+*]/.test(pattern));
  const selector = (raw, aliases) => {
    let value = raw.trim();
    const header = value.match(/^res\.getHeader\(\s*(["'])(.*?)\1\s*\)$/i);
    if (header) return { header: header[2].toLowerCase() };
    const headerMap = value.match(/^(?:res\.headers|res\.getHeaders\(\s*\))\s*\[\s*(["'])(.*?)\1\s*\]$/i);
    if (headerMap) return { header: headerMap[2].toLowerCase() };
    if (/^res\.getStatus\(\s*\)$/i.test(value)) return { status: true };
    value = value.replace(/^res\.getBody\(\s*\)/i, "res.body").replace(/^response\.getBody\(\s*\)/i, "response.body");
    const alias = value.match(/^([A-Za-z_$][\w$]*)\b(.*)$/);
    if (alias && aliases.has(alias[1])) value = aliases.get(alias[1]) + alias[2];
    if (/^res\.status$/i.test(value)) return { status: true };
    if (/^res\.body(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/i.test(value)) return { json: value.replace(/^res\.body\.?/i, "").replace(/\[(\d+)\]/g, ".$1") };
    if (/^response\.body(?:\.[A-Za-z_$][\w$]*|\[\d+\])*$/i.test(value)) return { json: value.replace(/^response\.body\.?/i, "").replace(/\[(\d+)\]/g, ".$1") };
    if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(value) && aliases.has(value.split(".")[0])) return { json: value };
    return null;
  };
  const literalArgument = (raw) => {
    const regex = raw.trim().match(/^\/((?:\\.|[^\/])*)\/([dgimsuvy]*)$/);
    if (regex) return !regex[2] && safePattern(regex[1]) ? { ok: true, value: regex[1], regex: true } : { ok: false };
    return brunoTestLiteral(raw);
  };
  // Chai's chain grammar is target-independent; a suite clause is not. A clause
  // names its target explicitly, so a chain whose operator cannot address the
  // selected target has no faithful translation. Emitting it anyway produced
  // two silent-green shapes: the operator key dropped on a status target
  // (`not.equal(500)` became `{status: 500}`, the exact inverse of the source)
  // and an operator with no target key at all (`{gt: 199}`), a clause that can
  // never pass. Both were counted translated and carried no loss entry.
  //
  // So each form below is translated only where the resulting clause asserts
  // what the source asserted, and a recognized form on a target it cannot
  // address returns `{refused}` — quarantined by name, never retargeted.
  // `null` keeps its meaning: a shape we never recognized at all.
  //
  // A refusal reason names the FORM only, never the chain argument: a loss
  // report is committed and rendered, and an argument can carry a value.
  const translateChain = (target, chain) => {
    // Resolve the target the way `checkOne` does — by key presence, not by
    // truthiness. The whole-body selector is the EMPTY json path, which is a
    // json target and must not be read as a missing one.
    const which = "status" in target ? "status" : "header" in target ? "header" : "json";
    const json = target.json;
    const header = target.header;
    const op = chain.trim();
    const refuse = (form) => ({ refused: `${form} has no exact suite operator on a ${which} target; not approximated` });
    const refuseArgument = (form) => ({ refused: `${form} requires one fully consumed supported literal argument; compound expressions and unsupported literals are not translated` });
    // A header selector can resolve to an EMPTY name (`res.getHeader("")`).
    // No response carries a header with no name, so every clause built from it
    // is unfailable in the other direction — it can never pass. That is the
    // same shape this function exists to refuse, so it is refused here, once,
    // for every form that reaches a target key. The empty JSON path is NOT the
    // same case: it selects the whole body.
    const keyed = (form, rest) => {
      if (which === "header" && !header) return { refused: `${form} names an empty header, which can never match a response header; not translated` };
      return { clauses: [which === "header" ? { header, ...rest } : { json, ...rest }] };
    };
    if (op === "exist") return which === "status" ? refuse("exist") : keyed("exist", { exists: true });
    const eq = op.match(/^(equal|eql|eq|not\.equal|not\.eql)\(\s*([\s\S]*)\s*\)$/i);
    if (eq) {
      const arg = literalArgument(eq[2]);
      if (!arg.ok || arg.regex) return refuseArgument(`${eq[1].toLowerCase()}()`);
      const negated = eq[1].toLowerCase().startsWith("not");
      if (which === "status") {
        // A status clause carries its expected value as the clause value only
        // in the positive sugar form `{status: 200}`. Every other operator
        // needs the marker form `{status: true, <op>: value}`, where `true` is
        // the selector and the operator carries the expectation. A status
        // literal that is not a three-digit code is refused rather than
        // emitted as a comparison that can never hold — the same rule the
        // declarative `assert` block already applies to `res.status: eq`.
        if (typeof arg.value !== "number" || !/^\d{3}$/.test(String(arg.value))) return refuse(negated ? "not.equal()" : "equal()");
        return { clauses: [negated ? { status: true, not_equals: arg.value } : { status: arg.value }] };
      }
      return keyed(negated ? "not.equal()" : "equal()", { [negated ? "not_equals" : "equals"]: arg.value });
    }
    const include = op.match(/^(include|contain)\(\s*([\s\S]*)\s*\)$/i);
    if (include) {
      const arg = literalArgument(include[2]);
      if (!arg.ok || arg.regex) return refuseArgument(`${include[1].toLowerCase()}()`);
      if (which !== "header") return refuse("include()");
      if (typeof arg.value !== "string") return refuseArgument("include()");
      // Header values are strings. JSON selectors may yield arrays or objects,
      // whose Chai containment semantics are not string-regex semantics.
      // The literal is escaped so it matches itself and not the pattern it
      // would otherwise be read as.
      const escaped = String(arg.value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return keyed("include()", { matches: `^.*${escaped}.*$` });
    }
    const bool = op.match(/^be\.(true|false|null)$/i);
    if (bool) return which === "json"
      ? { clauses: [{ json, equals: bool[1].toLowerCase() === "null" ? null : bool[1].toLowerCase() === "true" }] }
      : refuse(`be.${bool[1].toLowerCase()}`);
    const length = op.match(/^have\.length\(\s*(\d+)\s*\)$/i);
    if (length) return which === "json" ? { clauses: [{ json, length: Number(length[1]) }] } : refuse("have.length()");
    const type = op.match(/^be\.(?:a|an)\(\s*(["'])(string|number|boolean|object|array|null)\1\s*\)$/i);
    if (type) return which === "json" ? { clauses: [{ json, type: type[2].toLowerCase() }] } : refuse("be.a()");
    const order = op.match(/^(?:be\.)?(above|below)\(\s*(-?(?:\d+\.?\d*|\.\d+))\s*\)$/i);
    if (order) {
      const name = order[1].toLowerCase(), key = name === "above" ? "gt" : "lt", value = Number(order[2]);
      // A status IS a number, so a range reads truthfully through the marker.
      // A header value is a string, and `gt`/`lt` require a number.
      if (which === "status") return { clauses: [{ status: true, [key]: value }] };
      return which === "json" ? { clauses: [{ json, [key]: value }] } : refuse(`${name}()`);
    }
    const match = op.match(/^match\(\s*([\s\S]*)\s*\)$/i);
    if (match) {
      const arg = literalArgument(match[1]);
      if (!arg.ok) return refuseArgument("match()");
      const pattern = arg.regex ? arg.value : String(arg.value);
      if (!safePattern(pattern)) return null;
      if (which === "status") return refuse("match()");
      return keyed("match()", { matches: pattern });
    }
    return null;
  };
  const assertion_metadata = [], construct_ledger = [];
  const recordLoss = (name, unit, reason) => {
    const safeName = String(redactMetadataSecrets(name)).replace(/[\x00-\x1f]/g, " ").slice(0, 180);
    loss.push({ name: safeName, reason });
    construct_ledger.push({ name: safeName, disposition: "named-unsupported", reason, source_sha256: sha256(unit) });
  };
  const scan = (text, inherited = new Map(), name = "(tests block)", depth = 0) => {
    if (depth > 8) { recordLoss(name, text, "test nesting exceeds the static translation limit"); return; }
    const aliases = new Map(inherited);
    for (const unit of scriptUnits(text)) {
      const wrapper = unit.match(/^test\(\s*((?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`$]*`))\s*,\s*(?:function\s*\(\s*\)|\(\s*\)\s*=>)\s*\{([\s\S]*)\}\s*\)\s*;?$/);
      if (wrapper) {
        const testName = staticString(wrapper[1]) ?? "(test)";
        construct_ledger.push({ name: String(redactMetadataSecrets(testName)).slice(0, 180), disposition: "not-applicable", reason: "test label; assertions classified individually", source_sha256: sha256(wrapper[1]) });
        scan(wrapper[2], aliases, testName, depth + 1); aliases.clear(); continue;
      }
      const alias = unit.match(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*)$/);
      if (alias) {
        const rhs = alias[2].replace(/^res\.getBody\(\s*\)/i, "res.body").replace(/^res\.getHeaders\(\s*\)/i, "res.headers");
        if (selector(rhs, aliases)) {
          aliases.set(alias[1], rhs);
          construct_ledger.push({ name: String(redactMetadataSecrets(`${name}:alias:${alias[1]}`)).slice(0, 180), disposition: "not-applicable", reason: "response selector alias", source_sha256: sha256(unit) }); continue;
        }
        aliases.delete(alias[1]);
      }
      const assertion = unit.match(/^expect\(\s*([\s\S]*?)\s*\)\.to\.([\s\S]*)$/);
      const target = assertion && selector(assertion[1], aliases);
      const hit = target && translateChain(target, assertion[2].trim());
      if (hit?.clauses) {
        const bad = hit.clauses.find((clause) => "matches" in clause && unsafePattern(clause.matches));
        if (bad) { recordLoss(name, unit, `assertion pattern refused: ${unsafePattern(bad.matches)}`); continue; }
        try { scanMetadataSecrets(hit.clauses); } catch { recordLoss(name, unit, "secret-shaped assertion literal omitted"); continue; }
        const indices = hit.clauses.map((clause) => {
          const index = out.length; out.push(clause);
          assertion_metadata.push({ test_name: String(redactMetadataSecrets(name)).slice(0, 180), construct_sha256: sha256(unit) }); return index;
        });
        construct_ledger.push({ name: String(redactMetadataSecrets(name)).slice(0, 180), disposition: "translated", assertion_indices: indices, source_sha256: sha256(unit) }); continue;
      }
      aliases.clear();
      recordLoss(name, unit, hit?.refused ?? (/\b(?:if|switch|try|catch|for|while)\b|\.forEach\s*\(/.test(unit)
        ? "conditional, exception or loop execution is outside the Bruno test grammar"
        : /\bexpect\s*\(/.test(unit) ? "unparsed assertion statement is outside the Bruno mechanical grammar" : "call or assignment outside the Bruno test grammar"));
    }
  };
  if (body.length > 64 * 1024) recordLoss("(tests block)", body, "test source exceeds the 64 KB static translation cap");
  else scan(body);
  return { out, unsupported: [...new Set(unsupported)], loss, assertion_metadata, construct_ledger };
}

function brunoRequest(text, { sourceName = "request.bru", inheritedHeaders = [], inheritedAuth = null } = {}) {
  const blocks = brunoBlocks(text);
  const meta = brunoFields(blocks.find((b) => b.name === "meta")?.body ?? "");
  const methodBlock = blocks.find((b) => /^(get|post|put|patch|delete|head|options|trace)$/i.test(b.name));
  if (!methodBlock) return { meta, item: null, blocks };
  const methodFields = brunoFields(methodBlock.body);
  const ownHeaders = brunoEntries(blocks.find((b) => b.name === "headers")?.body ?? "").map(([key, value]) => ({ key, value }));
  const request = { method: methodBlock.name.toUpperCase(), url: { raw: methodFields.url ?? "", query: brunoEntries(blocks.find((b) => b.name === "params:query")?.body ?? "").map(([key, value]) => ({ key, value })) }, header: inheritedHeadersBeforeOwn(inheritedHeaders.map(h => ({ ...h, [ADAPTER.inherited]: true })), ownHeaders) };
  const ownAuthMode = brunoFields(blocks.find(b => b.name === 'auth')?.body ?? '').mode ?? methodFields.auth;
  if (ownAuthMode && ownAuthMode !== 'inherit') request.auth = { type: ownAuthMode === 'none' ? 'noauth' : ownAuthMode };
  const bodyBlock = blocks.find((b) => /^body(?::|$)/.test(b.name));
  if (bodyBlock) request.body = { mode: bodyBlock.name.split(":")[1] === "json" ? "raw" : "raw", raw: bodyBlock.body.trim() };
  const assertions = brunoDeclarativeAssertions(blocks.find((b) => b.name === "assert")?.body ?? "");
  const tests = brunoTestAssertions(blocks.find((b) => b.name === "tests")?.body ?? "");
  const unsupported = assertions.unsupported;
  const safeDeclarative = [];
  for (const clause of assertions.out) {
    let why = "matches" in clause && unsafePattern(clause.matches);
    try { scanMetadataSecrets(clause); } catch { why = "secret-shaped assertion literal omitted"; }
    if (why) assertions.refused.push({ name: `assert:${clause.header ?? clause.json ?? "status"}`, reason: `assertion pattern refused: ${why}` });
    else safeDeclarative.push(clause);
  }
  const translated = [...tests.out, ...safeDeclarative];
  const special = blocks.filter((b) => !/^(meta|get|post|put|patch|delete|head|options|trace|headers|params:query|body(?::.*)?|auth(?::.*)?|assert|tests)$/.test(b.name));
  return { meta, item: { name: meta.name ?? sourceName.replace(/\.bru$/i, ""), request, [ADAPTER.prerequisites]: special.filter(b => /^(script:|vars|params:path)/.test(b.name)).map(b => ({ kind: 'request-setup', source: b.name, source_sha256: sha256(b.body), status: 'unverified', executable: false })), [ADAPTER.brunoAssertions]: translated, [ADAPTER.brunoMetadata]: [...tests.assertion_metadata, ...safeDeclarative.map((clause) => ({ test_name: `assert:${clause.header ?? clause.json ?? "status"}`, construct_sha256: sha256(stableStringify(clause)) }))], [ADAPTER.brunoLedger]: tests.construct_ledger, [ADAPTER.brunoLoss]: [...unsupported.map((name) => ({ name, reason: "Bruno assertion is outside the declarative/mechanical grammar" })), ...assertions.refused, ...assertions.reportedOnly.map((name) => ({ name, reason: "Bruno response-time comparison is reported-only" })), ...tests.loss, ...special.map((b) => ({ name: b.name, reason: `${b.name} is quarantined; scripts are never executed during import` }))] }, blocks };
}

function finishBrunoImport(out, parsed) {
  // Assertions now enter the common pipeline before disposition is decided.
  // Adding them afterward previously promoted unresolved requests and left the
  // per-item ledger stale even when the summary reported successful imports.
  out.report.counts.translated_assertions = out.report.counts.assertions_translated;
  const id = out.report.items[0]?.id;
  const additional = [];
  for (const block of parsed.blocks ?? []) {
    if (["tests", "assert"].includes(block.name)) continue;
    const unsupported = (parsed.item?.[ADAPTER.brunoLoss] ?? []).some((entry) => entry.name === block.name);
    if (!unsupported) additional.push({ item_id: id, scope: "Bruno block", name: block.name, disposition: "not-applicable", reason: "request metadata; not an assertion", source_sha256: sha256(block.body) });
  }
  out.construct_ledger.push(...additional);
  out.report.construct_ledger = out.construct_ledger;
  for (const step of out.todo) {
    const has = parsed.blocks?.some((block) => ["assert", "tests"].includes(block.name));
    step.notes = has ? `no translatable assertion or unresolved request semantics; ${(parsed.item?.[ADAPTER.brunoLoss] ?? []).map((x) => x.reason).join("; ")}` : "no assert block and no tests block";
    const row = out.report.items.find((entry) => entry.id === step.id);
    if (row) row.notes.push(step.notes);
  }
  return out;
}

function brunoCollection(text, { suiteName = null, sourceName = "request.bru" } = {}) {
  const blocks = brunoBlocks(text);
  const meta = brunoFields(blocks.find((b) => b.name === "meta")?.body ?? "");
  const methodBlock = blocks.find((b) => /^(get|post|put|patch|delete|head|options|trace)$/i.test(b.name));
  if (!methodBlock) throw importFailure("BRUNO_METHOD_MISSING", "Bruno document", "no HTTP method block found");
  const methodFields = brunoFields(methodBlock.body);
  const headersBlock = blocks.find((b) => b.name === "headers");
  const queryBlock = blocks.find((b) => b.name === "params:query");
  const bodyBlock = blocks.find((b) => /^body(?::|$)/.test(b.name));
  const assertBlock = blocks.find((b) => b.name === "assert");
  const headers = Object.entries(brunoFields(headersBlock?.body ?? "")).map(([key, value]) => ({ key, value }));
  const query = Object.entries(brunoFields(queryBlock?.body ?? "")).map(([key, value]) => ({ key, value }));
  const request = { method: methodBlock.name.toUpperCase(), url: { raw: methodFields.url ?? "", query }, header: headers };
  if (bodyBlock) {
    const mode = bodyBlock.name.split(":")[1] ?? "text";
    request.body = { mode: mode === "json" ? "raw" : mode === "form-urlencoded" ? "urlencoded" : "raw",
      raw: bodyBlock.body.trim() };
  }
  const assertFields = brunoFields(assertBlock?.body ?? "");
  const status = Object.entries(assertFields).find(([key, value]) => /^res\.status$/i.test(key) && /^eq\s+\d{3}$/i.test(value));
  const declarative = Object.entries(assertFields).flatMap(([key, value]) => {
    const op = String(value).match(/^(eq|neq|gt|gte|lt|lte|contains|isDefined)\s+(.+)$/i);
    if (!op) return [];
    if (/^res\.status$/i.test(key)) return [{ status: Number(op[2]) }];
    const json = key.replace(/^res\.body\.?/i, "");
    const raw = op[2].replace(/^['"]|['"]$/g, "");
    const parsed = /^-?\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw === "true" ? true : raw === "false" ? false : raw;
    if (op[1].toLowerCase() === "isdefined") return [{ json, exists: true }];
    if (op[1].toLowerCase() === "contains") return [{ json, matches: `^.*${String(parsed).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$` }];
    return [{ json, [op[1].toLowerCase() === "eq" ? "equals" : op[1].toLowerCase()]: parsed }];
  });
  const declScript = declarative.map((clause) => clause.status
    ? `pm.response.to.have.status(${clause.status});`
    : clause.exists ? `pm.expect(jsonData.${clause.json}).to.exist;`
      : `pm.expect(jsonData.${clause.json}).to.eql(${JSON.stringify(clause.equals ?? "")});`);
  const item = { name: meta.name ?? sourceName.replace(/\.bru$/i, ""), request,
    ...(declScript.length ? { event: [{ listen: "test", script: { exec: [`const jsonData = pm.response.json(); ${declScript.join(" ")}`] } }] } : {}),
    ...(status ? { response: [{ code: Number(status[1].match(/\d{3}/)[0]) }] } : {}) };
  const unsupported = blocks.filter((b) => /^(script:|tests$|docs$|settings$)/.test(b.name));
  if (unsupported.length) item.event = [{ listen: "test", script: { exec: [
    `pm.test("manual Bruno semantics", () => { pm.response.json(); }); // ${unsupported.map((b) => b.name).join(", ")}`,
  ] } }];
  return { info: { name: suiteName ?? meta.name ?? sourceName.replace(/\.bru$/i, "") }, item: [item] };
}

function importBrunoUnchecked(text, options = {}) {
  const parsed = brunoRequest(text, options);
  if (!parsed.item) throw importFailure("BRUNO_METHOD_MISSING", "Bruno document", "no HTTP method block found");
  const out = finishBrunoImport(importPostman({ info: { name: parsed.item.name }, item: [parsed.item] }, { ...options, sourceText: options.sourceText || text, sourceKind: "bruno" }), parsed);
  const q = parsed.item[ADAPTER.brunoLoss] ?? [];
  out.report.loss = q;

  return out;
}

/** Import a Bruno collection directory. Values in environments are reduced to names. */
export function importBrunoDirectory(root, options = {}) {
  inspectImportDirectory(root, { bruno: true });
  const files = [], environmentFacts = [], environmentValues = new Set(), collection = { headers: [], auth: null, vars: [] }, loss = [];
  const readBlocks = (full) => brunoBlocks(readFileSync(full, "utf8"));
  const namesOnlyVars = (text, source) => {
    for (const block of brunoBlocks(text).filter((b) => /^vars(?::pre-request)?$/.test(b.name)))
      for (const [name] of brunoEntries(block.body)) collection.vars.push({ name, source });
    for (const block of brunoBlocks(text).filter((b) => b.name === "vars:secret")) {
      for (const match of block.body.matchAll(/[A-Za-z_$][\w.-]*/g)) collection.vars.push({ name: match[0], source, secret: true });
    }
  };
  const walk = (dir, prefix = [], inherited = { headers: [], auth: null, losses: [], vars: [] }) => {
    const folderPath = join(dir, "folder.bru");
    let next = { headers: [...inherited.headers], auth: inherited.auth, authSource: inherited.authSource, losses: [...(inherited.losses ?? [])], vars: [...(inherited.vars ?? [])] };
    if (statSync(dir).isDirectory() && (() => { try { return statSync(folderPath).isFile(); } catch { return false; } })()) {
      const text = readFileSync(folderPath, "utf8"), blocks = brunoBlocks(text);
      next.headers.push(...brunoEntries(blocks.find((b) => b.name === "headers")?.body ?? "").map(([key, value]) => ({ key, value })));
      const mode = brunoFields(blocks.find((b) => b.name === "auth")?.body ?? "").mode;
      const source = [...prefix, 'folder.bru'].join('/');
      if (mode) { next.auth = mode; next.authSource = `${source}:auth`; }
      namesOnlyVars(text, source);
      next.vars.push(...collection.vars.filter(v => v.source === source));
      for (const b of blocks.filter((x) => /^(script:pre-request|script:post-response|vars:post-response|docs|settings|tests)$/.test(x.name))) {
        const entry = { name: [...prefix, "folder.bru", b.name].join("/"), reason: `${b.name} is quarantined; never executed during import`, source_sha256: sha256(b.body) };
        loss.push(entry); next.losses.push(entry);
      }
    }
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), st = statSync(full);
      if (st.isDirectory()) {
        if (name === "environments") {
          for (const env of readdirSync(full).filter((x) => /\.bru$/i.test(x)).sort()) {
            const envText = readFileSync(join(full, env), "utf8");
            const vars = [], secrets = [];
            for (const block of brunoBlocks(envText).filter((x) => x.name === "vars")) {
              for (const [name, value] of brunoEntries(block.body).filter(([key]) => /^[A-Za-z_$][\w.-]*$/.test(key))) {
                vars.push(name);
                if (value && !value.includes("{{")) environmentValues.add(value.replace(/^['"]|['"]$/g, ""));
              }
            }
            for (const match of envText.matchAll(/vars:secret\s*\[([\s\S]*?)\]/gi))
              for (const name of match[1].match(/[A-Za-z_$][\w.-]*/g) ?? []) if (!secrets.includes(name)) secrets.push(name);
            environmentFacts.push({ name: env.replace(/\.bru$/i, ""), vars: [...new Set(vars)], secrets });
          }
        } else walk(full, [...prefix, name], next);
      } else if (/\.bru$/i.test(name) && name !== "collection.bru" && name !== "folder.bru") files.push({ full, prefix, inherited: next });
    }
  };
  const collectionFile = join(root, "collection.bru");
  try {
    const text = readFileSync(collectionFile, "utf8"), blocks = brunoBlocks(text);
    collection.headers = brunoEntries(blocks.find((b) => b.name === "headers")?.body ?? "").map(([key, value]) => ({ key, value }));
    collection.auth = brunoFields(blocks.find((b) => b.name === "auth")?.body ?? "").mode ?? null;
    namesOnlyVars(text, "collection.bru");
    for (const b of blocks.filter((x) => /^(script:pre-request|script:post-response|vars:post-response|docs|settings|tests)$/.test(x.name))) loss.push({ name: `collection.bru:${b.name}`, reason: `${b.name} is quarantined; never executed during import`, source_sha256: sha256(b.body) });
  } catch { /* a directory may be a partial export; requests still get a report */ }
  walk(root, [], { headers: collection.headers, auth: collection.auth, authSource: "collection.bru:auth", losses: [...loss], vars: [...collection.vars] });
  for (const f of files) {
    const parsed = brunoRequest(readFileSync(f.full, "utf8"), { sourceName: [...f.prefix, basename(f.full)].join("/"), inheritedHeaders: f.inherited.headers, inheritedAuth: f.inherited.auth });
    if (!parsed.item) { loss.push({ name: [...f.prefix, basename(f.full)].join("/"), reason: "no HTTP method block found; metadata file is not a request" }); continue; }
    const blocks = parsed.blocks;
    const inheritedLoss = f.inherited.losses ?? [];
    parsed.item[ADAPTER.prerequisites].push(...inheritedLoss.map(entry => ({ kind: 'inherited-setup', source: entry.name, source_sha256: entry.source_sha256, status: 'unverified', executable: false })));
    parsed.item[ADAPTER.prerequisites].push(...f.inherited.vars.map(v => ({ kind: 'inherited-variable', variable: v.name, source: v.source, status: 'unverified', executable: false })));
    if (f.inherited.auth) { parsed.item[ADAPTER.inheritedAuth] = { type: f.inherited.auth === 'none' ? 'noauth' : f.inherited.auth }; parsed.item[ADAPTER.inheritedAuthOwner] = f.inherited.authSource; }
    const inheritedAuth = f.inherited.auth ? { type: f.inherited.auth === 'none' ? 'noauth' : f.inherited.auth } : null;
    const imported = finishBrunoImport(importPostman({ info: { name: parsed.item.name }, ...(inheritedAuth ? { auth: inheritedAuth } : {}), item: [parsed.item] }, { ...options, sourceKind: "bruno", sourceName: undefined, variableNames: [...f.inherited.vars.map(v => v.name), ...environmentFacts.flatMap(e => [...e.vars, ...e.secrets]), ...blocks.filter(b => /^(vars|vars:pre-request|params:path)$/.test(b.name)).flatMap(b => brunoEntries(b.body).map(([name]) => name))], sourceText: readFileSync(f.full, "utf8") }), parsed);
    const requestId = [...f.prefix, basename(f.full, ".bru")].map(slug).join("/");
    for (const step of [...imported.suite.requests, ...imported.todo]) step.id = requestId;
    for (const item of imported.report.items) item.id = requestId;
    for (const candidate of imported.knowledgeCandidates ?? []) { candidate.item_id = requestId; candidate.source_item_id = requestId; }
    for (const entry of imported.construct_ledger ?? []) entry.item_id = requestId;
    const q = parsed.item[ADAPTER.brunoLoss] ?? [];
    loss.push(...q.map((x) => ({ ...x, name: `${[...f.prefix, basename(f.full)].join("/")}:${x.name}` })));
    // A quarantined script/assertion must be visible even if a separate
    // declarative assertion made the request runnable.

    files.find((x) => x.full === f.full).result = imported;
  }
  files.sort((a, b) => Number(brunoFields(brunoBlocks(readFileSync(a.full, "utf8"))[0]?.body ?? "").seq ?? 0) - Number(brunoFields(brunoBlocks(readFileSync(b.full, "utf8"))[0]?.body ?? "").seq ?? 0) || a.full.localeCompare(b.full));
  const results = files.map((f) => f.result).filter(Boolean), merged = results.flatMap((x) => x.suite.requests), todos = results.flatMap((x) => x.todo);
  const report = structuredClone(results[0]?.report ?? { counts: { scripts_quarantined: [] }, environment: {} });
  const directoryOrigins = [...new Set(results.flatMap((result) => result.report.required_origins ?? []))].sort();
  const knowledgeCandidates = results.flatMap((result) => result.knowledgeCandidates ?? []);
  if (directoryOrigins.length > 1) for (const step of [...merged, ...todos]) {
    const provider = knowledgeCandidates.find((candidate) => candidate.item_id === step.id)?.provider_base_url;
    if (provider && !/^https?:\/\//i.test(step.path)) step.path = provider + step.path;
    // A declared runtime base remains relative to the explicitly configured
    // default host. Absolute origins keep their own allowlisted routing.
    // No provider identity or reusable assertion is inferred for this case.
  }
  report.required_origins = directoryOrigins;
  report.construct_ledger = results.flatMap((result) => result.construct_ledger ?? []);
  report.construct_ledger.push(...loss.filter((entry) => /collection\.bru|folder\.bru/.test(entry.name)).map((entry) => ({ ...entry, scope: "Bruno inherited", disposition: "named-unsupported" })));
  report.suite = options.suiteName ?? basename(root);
  report.source_kind = "bruno-directory";
  report.environmentFacts = [...new Map(environmentFacts.map((x) => [x.name, x])).values()];
  report.environment = { ...(report.environment ?? {}), facts: report.environmentFacts, vars: [...new Map(collection.vars.map((x) => [x.name, { name: x.name, secret: Boolean(x.secret) }])).values()] };
  report.proxy = (() => { try { const p = JSON.parse(readFileSync(join(root, "bruno.json"), "utf8")).proxy; return p?.config ? { configured: p.inherit !== false, hostname: typeof p.config.hostname === "string" ? p.config.hostname.replace(/^\{\{\s*|\s*\}\}$/g, "") : null } : { configured: false, hostname: null }; } catch { return { configured: false, hostname: null }; } })();
  report.loss = loss;
  report.items = results.flatMap((x) => x.report.items ?? []);
  const lossHistogram = new Map();
  for (const entry of loss) lossHistogram.set(entry.reason, (lossHistogram.get(entry.reason) ?? 0) + 1);
  report.loss_histogram = [...lossHistogram.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10).map(([shape, count]) => ({ shape, count }));
  const translatedTotal = results.reduce((n, x) => n + (x.report.counts.assertions_translated ?? 0), 0);
  report.counts = { ...report.counts, items: merged.length + todos.length, imported: merged.length, todo: todos.length, quarantined: loss.length, translated: translatedTotal, assertions_translated: translatedTotal, translated_assertions: translatedTotal, scripts_needing_manual_conversion: results.reduce((n, x) => n + (x.report.counts.scripts_needing_manual_conversion ?? 0), 0), scripts_quarantined: loss.map((x) => ({ script: x.name, reason: x.reason, source: "Bruno directory" })) };
  const redactEnvironmentValues = (node) => {
    if (typeof node === "string") return [...environmentValues].some((v) => v && node === v) ? "{{SANNR_ENV_VALUE}}" : node;
    if (Array.isArray(node)) return node.map(redactEnvironmentValues);
    if (node && typeof node === "object") return Object.fromEntries(Object.entries(node).map(([k, v]) => [environmentValues.has(k) ? "{{SANNR_ENV_NAME}}" : k, redactEnvironmentValues(v)]));
    return node;
  };
  const safeSuite = redactEnvironmentValues({ v: ENVELOPE_VERSION, name: report.suite, requests: merged });
  const safeTodo = redactEnvironmentValues(todos);
  const safeReport = redactEnvironmentValues(report);
  safeReport.environmentFacts = report.environmentFacts;
  if (safeReport.environment) {
    safeReport.environment.vars = report.environment.vars;
    safeReport.environment.facts = report.environmentFacts;
  }
  // Digest every source file, including metadata and environment declarations;
  // only hashes cross this boundary, never environment values or absolute paths.
  const sourceFiles = [];
  const hashTree = (dir, prefix = []) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name), entry = statSync(full);
      if (entry.isDirectory()) hashTree(full, [...prefix, name]);
      else if (entry.isFile()) sourceFiles.push({ path: [...prefix, name].join("/"), sha256: sha256(readFileSync(full)) });
    }
  };
  hashTree(root);
  const sourceDigest = sha256(stableStringify(sourceFiles));
  const safeCandidates = redactEnvironmentValues(knowledgeCandidates).map((candidate) => ({ ...candidate, source_kind: "bruno-directory", source_sha256: sourceDigest }));
  return { name: report.suite, suite: safeSuite, todo: safeTodo, report: safeReport, construct_ledger: safeReport.construct_ledger,
    knowledgeCandidates: safeCandidates, provenance: { imported_at: null, source_sha256: sourceDigest, source_kind: "bruno-directory", items: Object.fromEntries(safeSuite.requests.concat(safeTodo).map((x) => [x.id, sha256(stableStringify(x))])) }, environmentFacts: safeReport.environmentFacts };
}

export function postmanV3Collection(text) {
  const parsed = typeof text === "string" ? parseYaml(text) : text;
  validateImportInput(parsed, { code: "POSTMAN_V3_DOCUMENT_INVALID", location: "Postman v3 document" });
  const collection = parsed?.collection && !parsed.item ? parsed.collection : parsed;
  if (!collection || !Array.isArray(collection.item)) throw importFailure("POSTMAN_V3_DOCUMENT_INVALID", "Postman v3 document.item", "no collection items; item must be an array");
  return collection;
}

export function importPostmanV3(text, options = {}) {
  return importPostman(postmanV3Collection(text), { ...options, sourceKind: "postman-v3" });
}

/** Kong decK/declarative configuration is a DECLARED witness, never a suite.
 * Credential-bearing branches are skipped before any value is copied. */
function importKongUnchecked(input, { suiteName = "kong-declared", sourceText = "" } = {}) {
  if (typeof suiteName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(suiteName))
    throw Object.assign(new Error('Declared suite name must be a single safe filename segment.'), { code: 'SUITE_NAME_INVALID' });
  const doc = typeof input === "string" ? parseYaml(input) : input;
  validateImportInput(doc, { code: "KONG_DOCUMENT_INVALID", location: "Kong document" });
  if (!doc || typeof doc !== "object" || Array.isArray(doc))
    throw Object.assign(new Error("Kong declarative document must be a mapping"), { code: "KONG_DOCUMENT_INVALID" });
  if (doc.openapi) throw Object.assign(new Error(`Kong importer received an OpenAPI document; use \`${CLI_NAME} init\` or \`${CLI_NAME} learn\``), { code: "KONG_OPENAPI_DOCUMENT" });
  const formatVersion = String(doc._format_version ?? "");
  if (!/^(?:1|2|3)\./.test(formatVersion))
    throw Object.assign(new Error("Kong declarative document requires _format_version 1.x, 2.x, or 3.x"), { code: "KONG_FORMAT_UNSUPPORTED" });

  const entries = [], loss = [], environments = new Map(), plugins = new Map();
  let skippedBranches = 0;
  const skippedKeys = new Set([
    "consumers", "consumer", "credentials", "keyauth_credentials", "basicauth_credentials",
    "basic_auth_credentials", "jwt_secrets", "hmacauth_credentials", "oauth2_credentials", "acls",
    "keys", "key_sets", "keysets", "certificates", "ca_certificates", "config", "secret", "password",
    "private_key", "client_certificate", "client_secret", "certificate", "ca_certificate",
  ]);
  const skip = (key, path) => { if (!path.includes(".")) skippedBranches += 1; loss.push({ name: key, path, reason: `skipped Kong ${key} branch; values never enter the declared store` }); };
  const walkSkipped = (value, path = "") => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) return value.forEach((v, i) => walkSkipped(v, `${path}[${i}]`));
    for (const [key, child] of Object.entries(value)) {
      const lower = key.toLowerCase();
      if (skippedKeys.has(lower)) { skip(key, path ? `${path}.${key}` : key); continue; }
      walkSkipped(child, path ? `${path}.${key}` : key);
    }
  };
  const routePath = (raw) => {
    const path = String(raw ?? "/").trim().replace(/\\/g, "/");
    const regex = path.startsWith("~") || /^\^|\$$/.test(path) || /[()[\]|+*?]/.test(path);
    const normalized = path.replace(/\\d\+/g, "{}").replace(/:([A-Za-z_$][\w$-]*)/g, "{$1}").replace(/\{\{[^}]+\}\}/g, "{}");
    return { path: normalized || "/", regex };
  };
  const addRoute = (route) => {
    const methods = Array.isArray(route?.methods) && route.methods.length ? route.methods : ["GET"];
    const paths = Array.isArray(route?.paths) && route.paths.length ? route.paths : ["/"];
    const names = Array.isArray(route?.plugins) ? [...new Set(route.plugins.map((p) => typeof p?.name === "string" ? p.name : null).filter(Boolean))] : [];
    for (const rawPath of paths) {
      const normalized = routePath(rawPath);
      if (names.length) plugins.set(normalized.path, names);
      for (const method of methods) entries.push({ method: String(method).toUpperCase(), path: normalized.path, ...(normalized.regex ? { status: "unsupported regex route" } : {}) });
    }
  };
  for (const service of Array.isArray(doc.services) ? doc.services : []) {
    const raw = service?.url ?? service?.host;
    if (typeof raw === "string") {
      try { const url = new URL(raw); environments.set(url.host, { host: url.host }); }
      catch { const host = raw.replace(/^https?:\/\//, "").split("/")[0]; if (host) environments.set(host, { host }); }
    }
    for (const route of Array.isArray(service?.routes) ? service.routes : []) addRoute(route);
  }
  for (const route of Array.isArray(doc.routes) ? doc.routes : []) addRoute(route);
  walkSkipped(doc);
  const report = { source_kind: "kong-declarative", facts: { path_semantics: /^3\./.test(formatVersion) ? "Kong 3.x regex paths require a ~ prefix" : "Kong 1.x/2.x paths use pre-3.0 path semantics" }, counts: { declared: entries.length, skipped: skippedBranches, skipped_items: loss.length }, loss };
  return { name: suiteName, sourceKind: "kong-declarative", declared: entries, environmentFacts: [...environments.values()], pluginFacts: Object.fromEntries(plugins), report, suite: { v: ENVELOPE_VERSION, requests: [] }, provenance: { imported_at: null, source_kind: "kong-declarative", items: Object.fromEntries(entries.map((x, i) => [`${x.method} ${x.path}#${i}`, sha256(stableStringify(x))])) } };
}

/** Compare a fresh import's provenance against a stored one → source drift. */
export function sourceDrift(prev, next) {
  if (!prev?.items) return null;
  const a = prev.items, b = next.items;
  const added = Object.keys(b).filter((k) => !(k in a)).sort();
  const removed = Object.keys(a).filter((k) => !(k in b)).sort();
  const changed = Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort();
  return { same_source: Boolean(prev.source_sha256 && next.source_sha256 && prev.source_sha256 === next.source_sha256), added, removed, changed };
}

/** The human-readable report. Counts first, then the per-item ledger. */
function renderImportReportUnchecked(r, { cli = "sannr", valuesWithheld = false } = {}) {
  if (r.source_kind === "kong-declarative") return [
    "# import report — Kong declarations", "",
    `${r.counts.declared} declared routes; ${r.counts.skipped} credential-bearing branches skipped.`,
    "Declared configuration is a witness; no runnable suite was created.", "",
    "| location | rule |", "|---|---|",
    ...(r.loss ?? []).map((entry) => `| ${summaryCell(entry.path)} | ${summaryCell(entry.reason)} |`),
  ].join("\n");
  if (r.source_kind === "insomnia-v5-environment") return [
    `# import report — ${summaryCell(r.suite)}`, "",
    "Insomnia environment document: variable names retained and values omitted.", "",
    "| environment | variable names |", "|---|---|",
    ...(r.environmentFacts ?? []).map((fact) => `| ${summaryCell(fact.name)} | ${summaryCell(fact.vars.join(", "))} |`),
  ].join("\n");
  const c = { items: 0, imported: 0, todo: 0, assertions_translated: 0, assertions_derived_from_examples: 0,
    scripts_needing_manual_conversion: 0, secrets_omitted_by_design: 0, scripts_quarantined: [],
    translated_quarantined_coverage: { translated: 0, quarantined: 0, ratio: 0 }, ...r.counts };
  r = { environment: {}, items: [], ...r };
  const lines = [
    `# import report — ${r.suite}`,
    "",
    `${c.items} items: **${c.imported} imported**, ${c.todo} in the todo file.`,
    `Assertions: ${c.assertions_translated} translated from tests, ${c.assertions_derived_from_examples} derived from saved examples.`,
    `${c.scripts_needing_manual_conversion} script(s) need manual conversion. ${c.secrets_omitted_by_design} secret(s) omitted by design (references only).`,
    `Dialects: modern ${c.dialects?.modern?.translated ?? 0} translated / ${c.dialects?.modern?.quarantined ?? 0} quarantined; legacy ${c.dialects?.legacy?.translated ?? 0} translated / ${c.dialects?.legacy?.quarantined ?? 0} quarantined.`,
    `Dialect coverage: ${c.translated_quarantined_coverage.translated} translated / ${c.translated_quarantined_coverage.quarantined} quarantined (ratio ${c.translated_quarantined_coverage.ratio}).`,
    ...c.scripts_quarantined.map((q) => `Quarantine: ${summaryCell(q.script)} — ${summaryCell(q.reason)} [${summaryCell(q.source)}]`),
    "",
    valuesWithheld ? "Environment values withheld from this snapshot." : [ r.environment.baseUrl
        ? `Environment: base URL ${r.environment.baseUrl}.`
        : "Environment: no absolute host seen; paths are relative to your configured base URL.",
      r.environment.auth
        ? ` Auth reference \`${r.environment.auth}\` — set the variable; the value never entered any file.`
        : "" ].join(""),
    "",
    "| item | status | notes |", "|---|---|---|",
    ...r.items.map((i) => `| ${summaryCell(i.id)} | ${summaryCell(i.status)} | ${summaryCell(i.notes.join("; ") || "—")} |`),
    "",
    `Run it: \`${cli} suite run ${r.suite}\` — executed through the same engine as everything else, with evidence.`,
    `Todo steps live in ${LAYOUT.suites}/${r.suite}.todo.json; give each an expect and move it over.`,
  ];
  return lines.join("\n");
}

// The public import surface accepts untrusted export data. Keep native engine
// failures inside this boundary, and preserve only named format diagnostics.
export function importPostman(collection, options = {}) {
  return importBoundary("POSTMAN_INPUT_INVALID", "Postman document", collection, () => importPostmanUnchecked(collection, options));
}
export function importInsomnia(exported, options = {}) {
  return importBoundary("INSOMNIA_INPUT_INVALID", "Insomnia document", exported, () => importInsomniaUnchecked(exported, options));
}
export function importBruno(text, options = {}) {
  return importBoundary("BRUNO_INPUT_INVALID", "Bruno document", text, () => importBrunoUnchecked(text, options));
}
export function importKong(input, options = {}) {
  return importBoundary("KONG_DOCUMENT_INVALID", "Kong document", input, () => importKongUnchecked(input, options));
}
export function renderImportReport(report, options = {}) {
  return importBoundary("IMPORT_REPORT_INVALID", "Import report", report, () => renderImportReportUnchecked(report, options));
}
