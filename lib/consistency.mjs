// Consistency with yourself: the one check a generic linter
// structurally cannot do, because it requires having observed THIS API.
//
// General best practices are already in every model's baseline, so shipping
// them would duplicate the model. The inversion is the moat: the audit has seen
// all of a service's endpoints, so it can cluster the conventions they actually
// follow — pagination style, error envelope, timestamp format, collection
// envelope — and flag the minority. "4 of 6 collections wrap rows in {data:[]},
// but this one returns a bare array" is a sentence only accumulated observation
// can produce.
//
// Everything here is derived from observed responses; nothing fires without a
// majority to disagree with. The corpus scores 1.00 on day one and real repos
// then cry wolf (see audit-routes for the shadow-route version of this lesson),
// so every classifier is gated:
//   - an entity (path ending in a parameter) is never a collection, so its
//     nested arrays (an order's `items`) cannot masquerade as an envelope;
//   - an object body only counts as a collection when its single array sits
//     under a known envelope key or a key named after the resource — a
//     receipt's `lines` is an attribute, not a collection;
//   - two pagination styles only conflict when their marker sets are DISJOINT.
//     A real API that returns offset+limit+next_cursor together (editorial-api
//     does) is a superset, not a contradiction;
//   - a minority is only flagged against a majority of >=2 endpoints out of
//     >=3, and ties flag nothing.

// --- classifying one response ------------------------------------------------

const ENVELOPE_KEYS = new Set(["data", "items", "results", "records", "entries"]);

const PAGE_KEYS = new Set(["page", "per_page", "page_size", "pagesize", "current_page", "total_pages"]);
const OFFSET_KEYS = new Set(["offset"]);
const CURSOR_KEYS = new Set(["next_cursor", "cursor", "prev_cursor", "next_token", "next_page_token", "after", "before"]);
// `limit` and `total` appear in every style, so they identify none.

const FAMILY_LABEL = { page: "page/per_page", offset: "offset/limit", cursor: "cursor" };

const TS_KEY = /(_at|_on|_time|_ts|timestamp|date)$/i;
const TS_LABEL = { "iso-8601": "ISO-8601 timestamps", "epoch-millis": "epoch-millisecond timestamps",
  "epoch-seconds": "epoch-second timestamps" };

const isRow = (r) => r !== null && typeof r === "object" && !Array.isArray(r);
const singular = (s) => s.toLowerCase().replace(/s$/, "");
const lastSegment = (p) => p.split("/").filter(Boolean).pop() ?? "";

function timestampFormat(value) {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) return "iso-8601";
  // Magnitude windows, not key names, tell millis from seconds: 1e12..1e13 is
  // 2001–2286 in millis, 1e9..1e10 the same era in seconds. Outside both, the
  // number is an id or a counter and proves nothing.
  if (typeof value === "number" && value >= 1e12 && value < 1e13) return "epoch-millis";
  if (typeof value === "number" && value >= 1e9 && value < 1e10) return "epoch-seconds";
  return null;
}

/** Collection envelope of a 2xx body, or null when the response is not a collection. */
export function envelopeOf(path, body) {
  if (path.endsWith("}")) return null;                       // an entity, never a collection
  if (Array.isArray(body)) return { family: "bare-array" };
  if (!isRow(body)) return null;
  const arrays = Object.entries(body).filter(([, v]) => Array.isArray(v));
  if (arrays.length !== 1) return null;                      // composite (search) or no rows at all
  const [key, rows] = arrays[0];
  if (rows.length && !rows.every(isRow)) return null;        // an array of scalars is an attribute
  if (ENVELOPE_KEYS.has(key)) return { family: `{${key}:[]}`, key };
  if (singular(key) === singular(lastSegment(path.replace(/\{[^}]*\}$/, ""))))
    return { family: "resource-named", key };                // {events:[]} under /events is one convention
  return null;                                               // unknown wrapper: no evidence either way
}

/** Pagination marker families echoed beside the rows. Empty set = unpaginated. */
function paginationOf(body) {
  const fams = new Set();
  if (!isRow(body)) return fams;
  for (const k of Object.keys(body)) {
    const key = k.toLowerCase();
    if (PAGE_KEYS.has(key)) fams.add("page");
    else if (OFFSET_KEYS.has(key)) fams.add("offset");
    else if (CURSOR_KEYS.has(key)) fams.add("cursor");
  }
  return fams;
}

/** Timestamp formats in a body: top-level values, first row, one nested object. */
function timestampsOf(body) {
  const formats = new Set();
  const scan = (obj) => {
    if (!isRow(obj)) return;
    for (const [k, v] of Object.entries(obj)) {
      if (!TS_KEY.test(k)) continue;
      const f = timestampFormat(v);
      if (f) formats.add(f);
    }
  };
  scan(body);
  if (isRow(body)) {
    for (const v of Object.values(body)) {
      if (Array.isArray(v) && isRow(v[0])) scan(v[0]);
      else if (isRow(v)) scan(v);
    }
  } else if (Array.isArray(body) && isRow(body[0])) scan(body[0]);
  return formats;
}

/** Error-envelope family of a 4xx JSON body; null when unrecognisable. */
export function errorShapeOf(body) {
  if (typeof body === "string") return "a bare string";
  if (!isRow(body)) return null;
  for (const k of ["errors", "error", "detail", "details", "message", "fault", "problem"])
    if (k in body && body[k] !== null && body[k] !== undefined) return `{${k}: …}`;
  return null;
}

/**
 * One observation per executed response. 2xx bodies yield envelope, pagination
 * and timestamp facts; 4xx bodies yield the error envelope. 5xx is excluded —
 * a crash handler's shape is not the service's convention.
 */
export function observeResponse({ op, path, status, body }) {
  if (body === undefined) return null;
  if (status >= 200 && status < 300) {
    const envelope = envelopeOf(path, body);
    return { op, envelope,
      pagination: envelope ? paginationOf(body) : new Set(),
      timestamps: timestampsOf(body),
      // A 2xx that carries a populated error envelope is a failure every caller
      // will treat as success — the corpus's retired invoice exporter. Empty
      // {errors: []} is the opposite convention ("no errors") and never fires.
      errorBody: isRow(body) &&
        ((typeof body.error === "string" && body.error.length > 0) || isRow(body.error) ||
         (Array.isArray(body.errors) && body.errors.length > 0))
        ? (typeof body.error === "string" ? body.error : "error") : null };
  }
  if (status >= 400 && status < 500) {
    const shape = errorShapeOf(body);
    return shape ? { op, errorShape: shape } : null;
  }
  return null;
}

// --- clustering one service's observations -----------------------------------

const MIN_TOTAL = 3;      // fewer than 3 comparable endpoints is not a convention
const MIN_MAJORITY = 2;   // a majority of one is an anecdote

const countBy = (items, keyOf) => {
  const m = new Map();
  for (const it of items) { const k = keyOf(it); m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
};
const majorityOf = (counts) => {
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted[1] && sorted[1][1] === sorted[0][1])) return null;   // a tie flags nothing
  return sorted[0];
};

const showEnvelope = (family) =>
  family === "bare-array" ? "a bare array"
    : family === "resource-named" ? "an envelope named after the resource"
    : `rows wrapped in ${family}`;

const showFamilies = (set) => [...set].map((f) => FAMILY_LABEL[f]).join("+");
const disjoint = (a, b) => ![...a].some((x) => b.has(x));

// One op can contribute BOTH a 2xx observation (its shape) and a 4xx one (how
// it says "no" to a nonexistent id), so deduplication is per dimension, never
// per op — collapsing them would discard the error evidence of every endpoint
// that also answered a sampled read.
const dedup = (list) => { const seen = new Set(); return list.filter((o) => o && !seen.has(o.op) && seen.add(o.op)); };
const split = (observations) => ({
  successes: dedup(observations.filter((o) => o && o.errorShape === undefined)),
  errors: dedup(observations.filter((o) => o?.errorShape)),
});

/** Intra-service findings: the minority endpoint on each convention axis. */
export function serviceConsistency(observations) {
  const findings = [];
  const { successes: obs, errors: errored } = split(observations);

  // 200-with-an-error-body needs no clustering: one response is the evidence.
  for (const o of obs)
    if (o.errorBody)
      findings.push({ op: o.op, kind: "inconsistency",
        detail: `answers 200 while the body carries an error envelope` +
                (typeof o.errorBody === "string" && o.errorBody !== "error" ? ` ("${o.errorBody.slice(0, 60)}")` : "") +
                ` — every caller will treat this failure as success` });

  // Collection envelope: bare array vs {data:[]} vs resource-named vs …
  const collections = obs.filter((o) => o.envelope);
  const envCounts = countBy(collections, (o) => o.envelope.family);
  const envMaj = majorityOf(envCounts);
  if (envMaj && collections.length >= MIN_TOTAL && envMaj[1] >= MIN_MAJORITY) {
    for (const o of collections)
      if (o.envelope.family !== envMaj[0])
        findings.push({ op: o.op, kind: "inconsistency",
          detail: `${envMaj[1]} of ${collections.length} collection endpoints here return ` +
                  `${showEnvelope(envMaj[0])}, but this one returns ${showEnvelope(o.envelope.family)}` });
  }

  // Pagination style, among collections that paginate at all. An unpaginated
  // collection (roles, categories) is legitimate and is not an outlier.
  const paginated = collections.filter((o) => o.pagination.size);
  const pagCounts = countBy(paginated, (o) => [...o.pagination].sort().join("+"));
  const pagMaj = majorityOf(pagCounts);
  if (pagMaj && paginated.length >= MIN_TOTAL && pagMaj[1] >= MIN_MAJORITY) {
    const majSet = new Set(pagMaj[0].split("+"));
    for (const o of paginated)
      if (disjoint(o.pagination, majSet))     // supersets never conflict
        findings.push({ op: o.op, kind: "inconsistency",
          detail: `${pagMaj[1]} of ${paginated.length} paginated endpoints here use ` +
                  `${showFamilies(majSet)}, but this one paginates with ${showFamilies(o.pagination)}` });
  }

  // Timestamp format. An endpoint carrying the majority format anywhere is
  // compatible; only an endpoint that timestamps EXCLUSIVELY another way flags.
  const stamped = obs.filter((o) => o.timestamps?.size);
  const perFormat = countBy(stamped.flatMap((o) => [...o.timestamps]), (f) => f);
  const tsMaj = majorityOf(perFormat);
  if (tsMaj && stamped.length >= MIN_TOTAL && tsMaj[1] >= MIN_MAJORITY) {
    for (const o of stamped)
      if (!o.timestamps.has(tsMaj[0]))
        findings.push({ op: o.op, kind: "inconsistency",
          detail: `${tsMaj[1]} of ${stamped.length} endpoints here return ${TS_LABEL[tsMaj[0]]}, ` +
                  `but this one returns ${[...o.timestamps].map((f) => TS_LABEL[f]).join(" and ")}` });
  }

  // Error envelope, from 4xx responses.
  const errCounts = countBy(errored, (o) => o.errorShape);
  const errMaj = majorityOf(errCounts);
  if (errMaj && errored.length >= MIN_TOTAL && errMaj[1] >= MIN_MAJORITY) {
    for (const o of errored)
      if (o.errorShape !== errMaj[0])
        findings.push({ op: o.op, kind: "inconsistency",
          detail: `${errMaj[1]} of ${errored.length} erroring endpoints here return ${errMaj[0]}, ` +
                  `but this one returns ${o.errorShape}` });
  }

  return findings;
}

/** Compact per-service summary, for the cross-service pass. */
export function serviceSummary(observations) {
  const { successes: obs, errors } = split(observations);
  const dim = (items, valuesOf) => {
    const set = new Set(items.flatMap(valuesOf));
    return items.length >= 2 && set.size ? { values: [...set].sort(), ops: items.length } : null;
  };
  const collections = obs.filter((o) => o.envelope);
  return {
    pagination: dim(collections.filter((o) => o.pagination.size), (o) => [...o.pagination]),
    timestamps: dim(obs.filter((o) => o.timestamps?.size), (o) => [...o.timestamps]),
    errorShape: dim(errors, (o) => [o.errorShape]),
  };
}

// --- the platform: services that call each other -----------------------------
//
// Each corpus service is internally consistent about pagination, timestamps and
// errors; the drift is BETWEEN them (identity pages, catalog cursors, orders
// offsets). That is only an inconsistency inside a platform — services in one
// repo, or joined by derived call edges. Two unrelated repos that
// disagree are just two products, and comparing them is how this check would
// cry wolf on every laptop with more than one project on it.

const DIMENSIONS = [
  ["pagination", (v) => `${FAMILY_LABEL[v]}`, "paginate with"],
  ["timestamps", (v) => TS_LABEL[v], "return"],
  ["errorShape", (v) => v, "shape errors as"],
];

export function platformConsistency(results, edges) {
  // Union-find over surfaces: same git repo, or an edge between their names.
  // An edge only groups when BOTH ends are documented API surfaces — services
  // calling each other are a platform. A contractless consumer that names two
  // upstreams (this very tool's repo points at both live fixtures) is just a
  // client of two products, and comparing its vendors to each other was the
  // first false positive this check produced on a real tree.
  const parent = results.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  const documented = (i) => Boolean(results[i].contract);
  const byRepo = new Map(), byName = new Map();
  results.forEach((r, i) => {
    if (r.repoRoot) { if (byRepo.has(r.repoRoot)) union(i, byRepo.get(r.repoRoot)); else byRepo.set(r.repoRoot, i); }
    (byName.get(r.name) ?? byName.set(r.name, []).get(r.name)).push(i);
  });
  for (const e of edges ?? [])
    for (const a of (byName.get(e.from) ?? []).filter(documented))
      for (const b of (byName.get(e.to) ?? []).filter(documented)) union(a, b);

  const components = new Map();
  results.forEach((r, i) => {
    if (!r.conventions) return;                       // never probed: no evidence
    const root = find(i);
    (components.get(root) ?? components.set(root, []).get(root)).push(r);
  });

  const findings = [];
  for (const members of components.values()) {
    if (members.length < 2) continue;
    for (const [dimension, label, verb] of DIMENSIONS) {
      // Exclusive groups only: a service using ONE style joins that style's
      // group; a service mixing styles (a gateway proxying everyone) is named
      // but dissolves nothing — merging through it would union cursor with
      // page and hide the split entirely.
      const exclusive = new Map(); const mixed = [];
      for (const r of members) {
        const d = r.conventions[dimension];
        if (!d) continue;
        if (d.values.length === 1)
          (exclusive.get(d.values[0]) ?? exclusive.set(d.values[0], []).get(d.values[0])).push(r.name);
        else mixed.push({ name: r.name, values: d.values });
      }
      if (exclusive.size < 2) continue;
      const groups = [...exclusive.entries()].sort((a, b) => b[1].length - a[1].length);
      const total = groups.reduce((n, [, names]) => n + names.length, 0);
      const [majValue, majNames] = groups[0];
      const conj = (names) => (names.length === 1 ? verb.replace(/^(\w+)/, "$1s") : verb);
      const rest = groups.slice(1)
        .map(([v, names]) => `${names.join(" and ")} ${conj(names)} ${label(v)}`).join("; ");
      // With a real majority the outlier form reads best; when every service
      // follows its own style there is no majority to anchor on, only a split.
      const detail = majNames.length >= 2
        ? `${majNames.length} of ${total} services ${verb} ${label(majValue)} (${majNames.join(", ")}), but ${rest}`
        : `${total} services follow ${groups.length} different styles: ` +
          groups.map(([v, names]) => `${names.join(" and ")} ${conj(names)} ${label(v)}`).join("; ");
      findings.push({ kind: "platform-inconsistency", dimension,
        services: groups.flatMap(([, names]) => names).concat(mixed.map((m) => m.name)),
        detail: detail +
                (mixed.length ? ` (${mixed.map((m) => `${m.name} mixes ${m.values.map(label).join(" and ")}`).join("; ")})` : "") });
    }
  }
  return findings;
}
