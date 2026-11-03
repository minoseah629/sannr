// Disagreement detectors: every check here compares something the contract
// CLAIMS against something the server or the source code DOES.
//
// The prime directive is precision. The corpus hands out 1.00 on the first try
// and real repos then cry wolf, so every detector is gated on evidence a spec
// author actually asserted: a `required` list, a declared status set, a
// Deprecation header, a recorded baseline. A finding that fires on an
// incomplete-but-honest spec trains readers to ignore the audit, and an
// ignored audit never surfaces the break it exists to catch.
//
// Nothing in this file mutates server state. Reads are GETs; the one write-path
// probe sends a body the upstream's own contract guarantees it must refuse.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { deref, responseSchema, opNode } from "./context.mjs";
import { CLI_NAME } from "./brand.mjs";
import { keepObjectKey, structuralMap } from "./key-sources.mjs";

// --- contract lookups -------------------------------------------------------
// opNode comes from context.mjs: it resolves an operation by its REAL path,
// including the Swagger 2.0 basePath prefix a direct doc.paths index misses.

/** Status codes an operation declares, as strings; null when it declares none. */
export function declaredStatuses(doc, method, path) {
  const responses = opNode(doc, method, path)?.responses;
  if (!responses || typeof responses !== "object") return null;
  const keys = Object.keys(responses);
  return keys.length ? keys : null;
}

export const queryParams = (doc, method, path) =>
  (opNode(doc, method, path)?.parameters ?? []).filter((p) => p && p.in === "query");

export function requestBodySchema(doc, method, path) {
  const schema = opNode(doc, method, path)?.requestBody?.content?.["application/json"]?.schema;
  return schema ? deref(doc, schema) : undefined;
}

// --- response body vs declared schema ---------------------------------------
//
// Three signals, in descending order of author intent:
//   1. a field the schema REQUIRES that the response does not carry
//   2. a declared type the response contradicts (string vs number vs object…)
//   3. a field the response carries that the schema omits — but only inside an
//      object whose schema carries a `required` list, because that list is the
//      author asserting "this shape is complete". Without it, an undeclared
//      field is indistinguishable from an honest, partial spec.
// null never contradicts anything: absent data is commonplace and nullability
// annotations are too inconsistently written to trust.

const KIND = (v) =>
  v === null || v === undefined ? "null"
    : Array.isArray(v) ? "array"
    : typeof v === "object" ? "object"
    : typeof v;   // string | number | boolean

const declaredKind = (schema) => {
  let t = schema?.type;
  if (Array.isArray(t)) t = t.find((x) => x !== "null");
  if (t === "integer") return "number";
  if (!t && schema?.properties) return "object";
  return t;
};

export function compareShape(body, schema, path = "", out = [], depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 6 || out.length >= 5) return out;
  const kind = declaredKind(schema);
  const got = KIND(body);
  if (got === "null") return out;

  if (kind === "object") {
    if (got !== "object") { out.push({ at: path || "$", detail: `declared object, server returns ${got}` }); return out; }
    const props = schema.properties ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const k of required)
      if (typeof k === "string" && !(k in body))
        out.push({ at: join$(path, k), detail: `declared required, absent from the response` });
    for (const [k, v] of Object.entries(body)) {
      if (props[k]) compareShape(v, props[k], join$(path, k), out, depth + 1);
      else if (required.length && Object.keys(props).length && schema.additionalProperties !== true)
        out.push({ at: join$(path, k), detail: `server returns it, the schema omits it` });
    }
  } else if (kind === "array") {
    if (got !== "array") out.push({ at: path || "$", detail: `declared array, server returns ${got}` });
    else if (body.length) compareShape(body[0], schema.items, `${path || "$"}[0]`, out, depth + 1);
  } else if (kind === "string" || kind === "number" || kind === "boolean") {
    if (got !== kind && got !== "null")
      out.push({ at: path || "$", detail: `declared ${schema.type}, server returns ${got}` });
  }
  return out;
}
const join$ = (p, k) => (p ? `${p}.${k}` : k);

// --- per-response checks ----------------------------------------------------

/**
 * Findings derivable from one executed 2xx response: schema disagreement,
 * an undocumented success status, a Deprecation header on a live operation.
 */
export function responseFindings({ op, method, path, doc, status, headers, body }) {
  const findings = [];

  // deprecated-but-live: the header is the server saying "stop", the 2xx is the
  // server still answering. Either the runtime header or the contract's own
  // deprecated flag plus a live 200 is a disagreement worth surfacing.
  const dep = headers?.get?.("deprecation");
  const contractDeprecated = opNode(doc, method, path)?.deprecated === true;
  if (dep || contractDeprecated) {
    const sunset = headers?.get?.("sunset");
    findings.push({ op, kind: "deprecated-but-live",
      detail: `serves ${status} while ${dep ? "sending a Deprecation header" : "the contract marks it deprecated"}` +
              (sunset ? ` (sunset ${sunset})` : "") });
  }

  // status-code-mismatch, runtime side: a 2xx the contract never documents.
  // Skipped when the operation declares a `default` response, which documents
  // everything by definition.
  const declared = declaredStatuses(doc, method, path);
  if (declared && !declared.includes("default") && !declared.includes(String(status)))
    findings.push({ op, kind: "status-mismatch",
      detail: `server returns ${status}; the contract documents only ${declared.join("/")}` });

  // response-schema-mismatch, on the shape the schema actually claims.
  if (body !== undefined) {
    const schema = responseSchema(doc, method, path);
    if (schema) {
      const mis = compareShape(body, schema);
      for (const m of mis.slice(0, 3))
        findings.push({ op, kind: "schema-mismatch", detail: `${m.at}: ${m.detail}` });
    }
  }
  return findings;
}

// --- root-cause dedup for schema-mismatch -----------------------------------
//
// One service's schema-mismatch findings are all TRUE and all the SAME break
// seen twice. A renamed field surfaces as two halves — the contract's required
// name "declared … absent" and the server's new name "server returns it, the
// schema omits it" — and a break in a shared model shows once on the collection
// (GET /accounts) and again on its detail sibling (GET /accounts/{id}). Eight
// findings, three causes. A reader wants the cause once, with the operations it
// touches listed. Grouping keys off the model FIELD and the NATURE of the
// disagreement, never the operation, so siblings collapse; the two rename
// halves are re-joined when an "absent A" and an "omits B" cover the identical
// operation set. This only ever MERGES findings — it can neither invent one nor
// drop a real break — so a repo that produced zero schema-mismatch findings
// still produces zero, and every planted defect stays inside its group.

const parseMismatch = (detail) => {
  const m = /^(.*?): (.+)$/.exec(String(detail));
  if (!m) return null;
  const leaf = m[1].replace(/\[\d+\]/g, "").split(".").pop();   // model field, wrapper/index-stripped
  const body = m[2];
  if (body === "declared required, absent from the response") return { leaf, nature: "absent" };
  if (body === "server returns it, the schema omits it") return { leaf, nature: "omits" };
  const t = /^declared (.+), server returns (.+)$/.exec(body);
  if (t) return { leaf, nature: "type", declared: t[1], got: t[2] };
  return null;   // an unrecognised detail rides through untouched
};

export function dedupeSchemaMismatch(findings) {
  const sm = findings.filter((f) => f.kind === "schema-mismatch");
  if (sm.length < 2) return findings;

  const parsed = new Map();   // finding -> {leaf, nature, …}
  for (const f of sm) { const p = parseMismatch(f.detail); if (p) parsed.set(f, p); }
  if (parsed.size < 2) return findings;

  const absent = new Map(), omits = new Map(), types = new Map();   // key -> {ops:Set, members:[], …}
  const bucket = (map, key, extra, f) => {
    let g = map.get(key);
    if (!g) map.set(key, (g = { ops: new Set(), members: [], ...extra }));
    g.ops.add(f.op); g.members.push(f);
  };
  for (const f of sm) {
    const p = parsed.get(f);
    if (!p) continue;
    if (p.nature === "absent") bucket(absent, p.leaf, { field: p.leaf }, f);
    else if (p.nature === "omits") bucket(omits, p.leaf, { field: p.leaf }, f);
    else bucket(types, `${p.leaf}|${p.declared}|${p.got}`, { leaf: p.leaf, declared: p.declared, got: p.got }, f);
  }

  const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
  const groupOf = new Map();   // finding -> groupId
  const collapsed = new Map(); // groupId -> deduped finding
  let gid = 0;
  const emit = (members, detail, ops) => {
    const operations = [...ops].sort();
    const id = gid++;
    // The op column still names one operation; the list makes the blast radius
    // visible when a single cause spans siblings.
    collapsed.set(id, { op: operations[0], kind: "schema-mismatch", operations,
      detail: operations.length > 1 ? `${detail}; affects ${operations.join(", ")}` : detail });
    for (const m of members) groupOf.set(m, id);
  };

  // Rename pairing first: an absent A and an omits B over the identical op set
  // are one rename, not two breaks. One omits half is consumed per absent half.
  const usedOmit = new Set();
  for (const [A, ga] of absent) {
    const hit = [...omits].find(([B, gb]) => !usedOmit.has(B) && setEq(ga.ops, gb.ops));
    if (!hit) continue;
    const [B, gb] = hit;
    usedOmit.add(B); ga.paired = true;
    emit([...ga.members, ...gb.members],
      `${A} renamed to ${B}: contract requires ${A}, server returns ${B} instead`, ga.ops);
  }
  for (const [A, ga] of absent) if (!ga.paired)
    emit(ga.members, `${A}: declared required, absent from the response`, ga.ops);
  for (const [B, gb] of omits) if (!usedOmit.has(B))
    emit(gb.members, `${B}: server returns it, the schema omits it`, gb.ops);
  for (const [, gt] of types)
    emit(gt.members, `${gt.leaf}: declared ${gt.declared}, server returns ${gt.got}`, gt.ops);

  // Rebuild in place: non-schema findings untouched, each group emitted once at
  // its first member's position, an unparsed schema finding passed straight on.
  const out = [], done = new Set();
  for (const f of findings) {
    if (f.kind !== "schema-mismatch") { out.push(f); continue; }
    const id = groupOf.get(f);
    if (id === undefined) { out.push(f); continue; }
    if (done.has(id)) continue;
    done.add(id);
    out.push(collapsed.get(id));
  }
  return out;
}

/**
 * required-param-documented-optional: a bare GET (every declared query param is
 * optional, so bare is a documented call) that the server refuses with 400/422.
 * The error text must NAME a declared parameter — a bare 400 alone could be
 * auth, throttling, or anything else, and naming is what separates "the
 * contract lied about this parameter" from noise.
 */
export function bareRejectionFinding({ op, method, path, doc, status, bodyText }) {
  if (status !== 400 && status !== 422) return null;
  const params = queryParams(doc, method, path);
  if (!params.length || params.some((p) => p.required === true)) return null;
  const text = String(bodyText ?? "").slice(0, 500);
  const named = params.find((p) => p.name && new RegExp(`\\b${escapeRe(p.name)}\\b`).test(text));
  if (!named) return null;
  return { op, kind: "required-param-optional",
    detail: `contract marks ?${named.name} optional; the bare call returns ${status} demanding it` };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// --- status codes in the handler source -------------------------------------
//
// Writes are not probed (a probe that creates rows is worse than a blind spot),
// so the write-path status check reads the handler instead: slice the source
// from one route definition to the next, collect the literal 2xx codes it
// sends, and compare against the contract. Flagged only when the two sets are
// BOTH non-empty and share nothing — a handler with no explicit status, or a
// partial overlap, proves nothing.

// The optional <…> absorbs a Fastify/TS generic (`app.get<{ Params: … }>("/x"`),
// which otherwise hides the route and lets a neighbouring handler's slice
// swallow this one's status codes — the exact way the first real-repo false
// positive happened.
const ROUTE_DEFS = [
  /\b(?:app|router|api|route[rs]?|server)\s*\.\s*(get|post|put|patch|delete)\s*(?:<[\s\S]{0,300}?>)?\s*\(\s*['"`](\/[^'"`]*)['"`]/gi,
  /@\s*(?:app|router|blueprint|bp)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`](\/[^'"`]*)['"`]/gi,
];
// Anything that even looks like the start of another handler ends the current
// slice, parseable or not. Attributing a status to the wrong handler is how
// this check would cry wolf.
const NEXT_DEF = /\b(?:app|router|api|route[rs]?|server)\s*\.\s*(?:get|post|put|patch|delete|all|options|head|use)\s*[<(]|@\s*(?:app|router|blueprint|bp)\s*\.\s*(?:get|post|put|patch|delete)\s*\(/gi;
// Literal success codes a handler emits: res.status(201), c.json(x, 201),
// reply.code(201), sendStatus(201), FastAPI's status_code=201. The `[}\])],`
// guard on the bare `, 201)` form keeps `.slice(0, 200)` out of the net.
const CODE_IN_HANDLER = /(?:\.status\s*\(\s*|\.code\s*\(\s*|sendStatus\s*\(\s*|status_code\s*=\s*|[}\])]\s*,\s*)(2\d\d)\s*[),]/g;

const TEST_FILE = /(\.|\/|^)(test|spec)\.|\/(tests?|__tests__|spec|e2e)\//i;
const canon = (p) => p.replace(/:[A-Za-z0-9_]+/g, "{}").replace(/\{[^}]+\}/g, "{}").replace(/\/+$/, "") || "/";

function* sourceFiles(dir, depth = 0) {
  if (depth > 6) return;
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".") || ["node_modules", "venv", ".venv", "dist", "build", "__pycache__", "coverage", "vendor"].includes(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* sourceFiles(p, depth + 1);
    else if (/\.(py|ts|js|mjs|tsx|jsx)$/.test(e.name) && !TEST_FILE.test(String(p).replace(/\\/g, "/"))) yield p;
  }
}

// A FastAPI router prefix or Hono basePath shifts every route in the file.
const filePrefix = (src) =>
  src.match(/APIRouter\s*\(\s*[^)]*?prefix\s*=\s*['"](\/[^'"]*)['"]/)?.[1]?.replace(/\/+$/, "")
  ?? src.match(/\.basePath\s*\(\s*['"`](\/[^'"`]*)['"`]/)?.[1]?.replace(/\/+$/, "")
  ?? "";

export function staticStatusFindings(dir, doc) {
  const declared = new Map();   // "METHOD /canon/path" -> string[] statuses
  for (const [p, methods] of Object.entries(doc?.paths ?? {}))
    for (const m of Object.keys(methods ?? {})) {
      const s = declaredStatuses(doc, m, p);
      if (s) declared.set(`${m.toUpperCase()} ${canon(p)}`, s);
    }
  if (!declared.size) return [];

  const findings = [];
  for (const f of sourceFiles(dir)) {
    let src; try { if (statSync(f).size > 400_000) continue; src = readFileSync(f, "utf8"); } catch { continue; }
    const prefix = filePrefix(src);
    const defs = [];
    for (const re of ROUTE_DEFS) {
      re.lastIndex = 0;
      for (const m of src.matchAll(re)) defs.push({ method: m[1].toUpperCase(), path: `${prefix}${m[2]}`, index: m.index });
    }
    defs.sort((a, b) => a.index - b.index);
    for (let i = 0; i < defs.length; i += 1) {
      const d = defs[i];
      const decl = declared.get(`${d.method} ${canon(d.path)}`);
      const decl2xx = decl?.filter((s) => s.startsWith("2"));
      if (!decl2xx?.length || decl.includes("default")) continue;
      NEXT_DEF.lastIndex = d.index + 8;   // past this definition's own head
      const next = NEXT_DEF.exec(src)?.index ?? src.length;
      const slice = src.slice(d.index, Math.min(next, d.index + 4000));
      const sent = new Set();
      CODE_IN_HANDLER.lastIndex = 0;
      for (const m of slice.matchAll(CODE_IN_HANDLER)) sent.add(m[1]);
      if (!sent.size || decl.some((s) => sent.has(s))) continue;
      findings.push({ op: `${d.method} ${d.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}")}`, kind: "status-mismatch",
        detail: `handler returns ${[...sent].join("/")} (${relative(dir, f)}); the contract documents ${decl2xx.join("/")}` });
    }
  }
  return findings;
}

// --- sampling ids for parameterised reads -----------------------------------
//
// GET /orders/{id} is unreachable to a blind probe, but the id is sitting in
// the collection the audit just fetched. Substituting a listed id keeps the
// probe read-only and factual. What a sampled probe reports, and why its 404
// is trustworthy, is in lib/audit.mjs probe(). The id is a response value: it
// goes into the probe request only, and a finding names where it was listed.

// The rows of a list response and the key that holds them (null when the body
// is itself the array).
function rowsWithKey(body) {
  if (Array.isArray(body)) return { rows: body, key: null };
  if (body && typeof body === "object")
    for (const [k, v] of Object.entries(body))
      if (Array.isArray(v) && v[0] && typeof v[0] === "object") return { rows: v, key: k };
  return null;
}

export function rowsAnywhere(body) {
  return rowsWithKey(body)?.rows ?? null;
}

/**
 * The listed id a parameterised probe substitutes, and where it was listed:
 * the collection's GET operation and the names-only path of the field
 * (`data[].id`, or `[].id` when the body is the array). The key that holds the
 * rows follows the key-source naming rule (lib/key-sources.mjs keepObjectKey):
 * a key that may carry data reads `{}`. The id goes into the probe request
 * only; a finding names the operation, this source and this field, never the
 * id. `declared` is the contract's declared property names.
 */
export function sampledId(path, bodies, { declared } = {}) {
  const cut = path.indexOf("/{");
  if (cut <= 0) return null;
  const parent = path.slice(0, cut);
  const body = bodies.get(parent);
  const listed = rowsWithKey(body);
  const raw = listed?.rows?.[0]?.id;
  if (raw === undefined || raw === null || typeof raw === "object") return null;
  const id = urishId(String(raw), parent);
  if (id === null) return null;
  const key = listed.key === null ? ""
    : keepObjectKey(listed.key, { declared, wanted: new Set([String(raw), id]), parentIsMap: structuralMap(body) }) ? listed.key : "{}";
  return { id, operation: `GET ${parent}`, field: `${key}[].id` };
}

export function sampleIdFor(path, bodies) {
  return sampledId(path, bodies)?.id ?? null;
}

/** Where a sampled id came from, as finding text: `GET /hubs → data[].id`. */
export const listedIdSource = sample => `${sample.operation} → ${sample.field}`;

// JSON-LD style APIs (api.weather.gov) publish `id` as the row's own URI, not
// an opaque scalar. Substituting that URI whole into the template guarantees a
// 404 and flags a healthy documented route as missing — the external yardstick
// (test/external.mjs) caught the audit doing exactly this on eight live
// weather.gov operations. When the id is URI-shaped, the real id is the single
// segment extending the parent collection's own path; a URI that points
// anywhere else proves nothing and samples nothing.
function urishId(id, parent) {
  if (!/^(https?:)?\/\//.test(id) && !id.startsWith("/")) return id;   // an opaque scalar, as sampled
  let p; try { p = id.startsWith("/") ? id : new URL(id).pathname; } catch { return null; }
  const tail = p.startsWith(`${parent}/`) ? p.slice(parent.length + 1).replace(/\/+$/, "") : null;
  return tail && !tail.includes("/") ? tail : null;
}

// --- request-field-now-required, across repos --------------------------------
//
// The canonical cross-repo break: an upstream made a body field required and
// the consumer's repo never got a commit. Neither side alone disagrees with
// itself — upstream contract and upstream server agree, consumer code and
// consumer contract agree — so this is the one check that needs the edge.
//
// Detection is static-first: find a call site in the consumer whose object
// literal omits a field the upstream contract requires. That candidate is then
// CONFIRMED against the upstream with exactly the consumer's fields and marker
// values — a body the upstream's own contract requires it to refuse, so the
// probe cannot create anything. No confirmation, no finding.

const BODY_KEYS = (literal) => [...literal.matchAll(/(?:^|[,{]\s*)["']?([A-Za-z_]\w*)["']?\s*:/g)].map((m) => m[1]);
const hostPortOf = (u) => { try { const x = new URL(u); return `${x.hostname}:${x.port || (x.protocol === "https:" ? 443 : 80)}`; } catch { return null; } };

export function consumerCallSites(dir, upstreamNames) {
  const sites = [];
  if (!upstreamNames.length) return sites;
  const call = new RegExp(String.raw`\b(${upstreamNames.map(escapeRe).join("|")})\s*\(\s*[\`'"](/[^\`'"?]*)[\`'"?]`, "g");
  for (const f of sourceFiles(dir)) {
    let src; try { if (statSync(f).size > 400_000) continue; src = readFileSync(f, "utf8"); } catch { continue; }
    const matches = [...src.matchAll(call)];
    for (let i = 0; i < matches.length; i += 1) {
      const m = matches[i];
      // The window ends where the next call site begins: an option bag read
      // past that boundary would attribute one call's method and body to another.
      const window = src.slice(m.index, Math.min(matches[i + 1]?.index ?? src.length, m.index + 400));
      const method = window.match(/method\s*:\s*['"`](POST|PUT|PATCH)['"`]/i)?.[1]?.toUpperCase();
      if (!method) continue;                                       // reads carry no body
      const literal = window.match(/body\s*:\s*(?:JSON\.stringify\(\s*)?\{([^{}]*)\}/)?.[1];
      if (literal === undefined) continue;                         // body not a flat literal: unknowable
      sites.push({ upstream: m[1], method, path: m[2], keys: BODY_KEYS(`{${literal}}`), file: relative(dir, f) });
    }
  }
  return sites;
}

export async function crossRepoRequiredFieldFindings(results, { readContract, baseUrlFor, upstreamUrls, timeoutMs = 4000 } = {}) {
  const documented = results.filter((r) => r.contract);
  for (const consumer of results) {
    // A helper named `identity(...)` is resolved to a surface by name AND by a
    // base URL the consumer's own source actually points at — two audited
    // checkouts of the same service (monorepo + microservices topology) share a
    // name, and only the host:port says which one this consumer calls.
    let referenced;
    try {
      referenced = new Set(upstreamUrls(consumer.dir, baseUrlFor(consumer.dir)).map((u) => u.hostPort));
    } catch { continue; }
    const candidates = documented.filter((r) => r.name !== consumer.name &&
      referenced.has(hostPortOf(baseUrlFor(r.dir))));
    if (!candidates.length) continue;
    let sites; try { sites = consumerCallSites(consumer.dir, [...new Set(candidates.map((r) => r.name))]); } catch { continue; }
    for (const site of sites) {
      const up = candidates.find((r) => r.name === site.upstream);
      let doc; try { doc = readContract(up.contract).doc; } catch { continue; }
      // Look the path up canonically so a templated `/accounts/${id}` still
      // finds `/accounts/{id}` in the contract.
      const declaredPath = Object.keys(doc?.paths ?? {}).find((p) => canon(p) === canon(site.path));
      if (!declaredPath) continue;
      const schema = requestBodySchema(doc, site.method, declaredPath);
      const required = Array.isArray(schema?.required) ? schema.required : [];
      const missing = required.filter((k) => !site.keys.includes(k));
      if (!missing.length) continue;

      const base = baseUrlFor(up.dir);
      if (!base) continue;
      let res, text;
      try {
        res = await fetch(new URL(base + site.path.replace(/\$\{[^}]*\}/g, "x")), {
          method: site.method, redirect: "manual",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(Object.fromEntries(site.keys.map((k) => [k, "x-api-audit-probe"]))),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = (await res.text()).slice(0, 500);
      } catch { continue; }
      const confirmed = (res.status === 400 || res.status === 422) &&
        missing.find((k) => new RegExp(`\\b${escapeRe(k)}\\b`).test(text));
      if (!confirmed) continue;
      (consumer.findings ??= []).push({
        op: `${site.method} ${site.path}`, kind: "request-field-now-required",
        detail: `sends {${site.keys.join(", ")}} to ${site.upstream}, which now requires ${confirmed} ` +
                `(${res.status} without it; call site ${site.file})`,
      });
    }
  }
}

// --- shape-hash baseline ------------------------------------------------------
//
// A recorded shape hash is the only way "the response changed shape since last
// time" is detectable at all; without a baseline every audit run is day one.
// Baselines live in sannr.json and the audit only writes them where that
// file already exists — the audit surveys other people's repos, and a surveyor
// does not leave files behind in them. A diverged hash is flagged and NOT
// overwritten: the stale baseline is the evidence, and `learn` re-baselines.
//
// Page size gets its own signal because shapeOf() deliberately samples one
// array element, so a 20-row page and a 10-row page hash identically. Row
// count only means "page size" when the server said the page was FULL (a
// non-null cursor / more-marker), which is also what makes it safe on live
// data: a collection that merely gained rows does not move a full page.

const MORE_MARKERS = ["next_cursor", "next", "has_more", "more"];
export const pageFull = (body) =>
  Boolean(body && typeof body === "object" && !Array.isArray(body) &&
    MORE_MARKERS.some((k) => body[k] !== undefined && body[k] !== null && body[k] !== false));

export function baselineFindings(ctx, observed) {
  const findings = [];
  let dirty = false;
  for (const o of observed) {
    const entry = ctx.operations[o.op];
    if (!entry) continue;
    if (entry.shape_hash && o.hash && entry.shape_hash !== o.hash) {
      findings.push({ op: o.op, kind: "shape-drift",
        detail: `response shape diverged from the recorded baseline` +
                (entry.verified_at ?? entry.baselined_at ? ` of ${entry.verified_at ?? entry.baselined_at}` : "") +
                `; re-baseline with ${CLI_NAME} learn` });
      // The divergence itself is remembered (not the new hash — the stale
      // baseline stays as evidence) so freshnessFor can grade the operation
      // suspect on later runs that never probe. Re-learning clears it.
      if (!entry.shape_diverged_at) {
        entry.shape_diverged_at = new Date().toISOString().slice(0, 10);
        dirty = true;
      }
    } else if (!entry.shape_hash && o.hash) {
      entry.shape_hash = o.hash;
      entry.baselined_at = new Date().toISOString().slice(0, 10);
      dirty = true;
    }
    if (o.full && o.rows != null) {
      if (entry.page_rows != null && entry.page_full && entry.page_rows !== o.rows) {
        findings.push({ op: o.op, kind: "page-size-change",
          detail: `a full default page now carries ${o.rows} rows; the recorded baseline was ${entry.page_rows}` });
      } else if (entry.page_rows == null) {
        entry.page_rows = o.rows; entry.page_full = true;
        dirty = true;
      }
    }
  }
  return { findings, dirty };
}
