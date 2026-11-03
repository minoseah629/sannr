import { LAYOUT } from "../lib/layout.mjs";
// Consistency with yourself (ADR-0035 §2): cluster one service's observed
// conventions and flag the minority.
//
//   node --test test/consistency.test.mjs
//
// The corpus scores 1.00 here by construction — it plants three pagination
// styles, three error shapes, three timestamp formats and four collection
// envelopes. The tests that matter are the FALSE-POSITIVE guards, each taken
// from a live sibling repo: editorial-api returns offset+limit+next_cursor
// together (a superset is not a contradiction), fleet answers every collection
// as a bare array (uniformity is not an outlier), and an order entity carries
// an `items` array that must never read as an {items:[]} envelope.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeResponse, envelopeOf, errorShapeOf, serviceConsistency,
  serviceSummary, platformConsistency } from "../lib/consistency.mjs";
import { auditSurface } from "../lib/audit.mjs";

const ok = (op, path, body) => observeResponse({ op, path, status: 200, body });
const rows = (n = 2) => Array.from({ length: n }, (_, i) => ({ id: `x_${i}` }));
const flagged = (findings, op) =>
  findings.filter((f) => f.kind === "inconsistency" && f.op === op);

// --- collection envelope -----------------------------------------------------

test("the bare-array minority is flagged against a {data:[]} majority", () => {
  const f = serviceConsistency([
    ok("GET /accounts", "/accounts", { data: rows(), page: 1, per_page: 20, total: 2 }),
    ok("GET /api-keys", "/api-keys", { data: rows(), page: 1, per_page: 20, total: 2 }),
    ok("GET /audit-log", "/audit-log", { data: rows(), page: 1, per_page: 20, total: 2 }),
    ok("GET /roles", "/roles", rows()),
  ]);
  const hits = flagged(f, "GET /roles");
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /3 of 4 collection endpoints/);
  assert.match(hits[0].detail, /bare array/);
});

test("a 2-vs-2 envelope tie flags nothing — a tie is not a convention", () => {
  const f = serviceConsistency([
    ok("GET /a", "/a", { data: rows() }),
    ok("GET /b", "/b", { data: rows() }),
    ok("GET /c", "/c", rows()),
    ok("GET /d", "/d", rows()),
  ]);
  assert.equal(f.length, 0);
});

test("two collections are too few to call either one the convention", () => {
  const f = serviceConsistency([
    ok("GET /a", "/a", { data: rows() }),
    ok("GET /b", "/b", rows()),
  ]);
  assert.equal(f.length, 0);
});

test("an entity's nested array is not a collection envelope", () => {
  // GET /orders/{id} carries items:[…]; reading that as an {items:[]} envelope
  // is the false positive every entity with a line-item list would produce.
  assert.equal(envelopeOf("/orders/{id}", { id: "o1", items: rows(), total: 3 }), null);
  // Unknown wrapper keys (a receipt's `lines`) are no evidence either way.
  assert.equal(envelopeOf("/orders/{id}/receipt", { order_id: "o1", lines: rows(), total_cents: 5 }), null);
  // Composite responses (search: two arrays) are not collections.
  assert.equal(envelopeOf("/search", { query: "a", events: rows(), venues: rows() }), null);
});

test("resource-named envelopes are one convention, not many", () => {
  // A BFF that wraps /v1/events in {events:[]} and /v1/venues in {venues:[]}
  // is consistent with itself; keying on the literal wrapper would cry wolf.
  const f = serviceConsistency([
    ok("GET /v1/events", "/v1/events", { events: rows(), next_cursor: "c" }),
    ok("GET /v1/venues", "/v1/venues", { venues: rows(), next_cursor: null }),
    ok("GET /v1/orders", "/v1/orders", { orders: rows(), next_cursor: "c" }),
  ]);
  assert.equal(f.filter((x) => /envelope/.test(x.detail)).length, 0);
});

// --- nothing to be inconsistent WITH -----------------------------------------
// The floor of the whole check: an outlier is a minority against a majority, so
// a service with no majority to disagree with must be silent. These are the
// cases the clustering gates exist for, asserted directly.

test("a single-endpoint service has nothing to be inconsistent with", () => {
  // One endpoint cannot be a minority of anything. Every convention dimension
  // must stay silent, no matter what that one endpoint looks like.
  for (const body of [{ data: rows(), page: 1, per_page: 20 }, rows(),
    { created_at: "2026-01-04T09:00:00Z" }, { orders: rows(), next_cursor: "c" }])
    assert.deepEqual(serviceConsistency([ok("GET /only", "/only", body)]), [],
      `one endpoint (${JSON.stringify(body)}) has no sibling to disagree with`);
});

test("a lone collection among non-collections raises no envelope or pagination finding", () => {
  // The envelope and pagination axes only exist among collections; with exactly
  // one collection there is no majority style, so neither axis may fire even
  // though the service has three endpoints total.
  const f = serviceConsistency([
    ok("GET /widgets", "/widgets", { data: rows(), page: 1, per_page: 20 }),   // the only collection
    ok("GET /health", "/health", { status: "ok", checked_at: "2026-01-01T00:00:00Z" }),
    ok("GET /version", "/version", { version: "1.2.3", built_at: "2026-01-02T00:00:00Z" }),
  ]);
  assert.equal(f.filter((x) => /collection endpoints|paginated endpoints/.test(x.detail)).length, 0);
});

test("a dimension where every endpoint agrees is silent across all four axes", () => {
  // Same envelope, same pagination, same timestamp format, same error shape:
  // agreement is the null result, not a finding about how uniform the service is.
  const f = serviceConsistency([
    ok("GET /a", "/a", { data: rows(), page: 1, per_page: 20, created_at: "2026-01-04T09:00:00Z" }),
    ok("GET /b", "/b", { data: rows(), page: 1, per_page: 20, created_at: "2026-01-05T09:00:00Z" }),
    ok("GET /c", "/c", { data: rows(), page: 2, per_page: 20, created_at: "2026-01-06T09:00:00Z" }),
    observeResponse({ op: "GET /a/{id}", path: "/a/{id}", status: 404, body: { error: "no a" } }),
    observeResponse({ op: "GET /b/{id}", path: "/b/{id}", status: 404, body: { error: "no b" } }),
    observeResponse({ op: "GET /c/{id}", path: "/c/{id}", status: 404, body: { error: "no c" } }),
  ]);
  assert.deepEqual(f, []);
});

test("an outlier finding names the outlier operation and what the majority does", () => {
  const f = serviceConsistency([
    ok("GET /accounts", "/accounts", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /api-keys", "/api-keys", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /audit-log", "/audit-log", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /roles", "/roles", rows()),
  ]);
  const hits = flagged(f, "GET /roles");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].op, "GET /roles", "the finding carries the outlier operation");
  assert.match(hits[0].detail, /3 of 4 collection endpoints here return rows wrapped in \{data:\[\]\}/,
    "and states what the majority does, with the count");
  assert.match(hits[0].detail, /this one returns a bare array/, "and how the outlier differs");
});

test("a genuinely consistent multi-dimension service stays silent (editorial-shaped)", () => {
  // editorial-api in miniature: every collection wraps in {data:[]}, some page
  // with offset+limit and some ALSO carry next_cursor (a superset, not a second
  // style), every timestamp is ISO-8601, every error is {error: …}. A real,
  // healthy API must produce zero findings — this is the false-positive floor.
  const f = serviceConsistency([
    ok("GET /pieces", "/pieces", { data: rows(), total: 9, limit: 50, offset: 0, next_cursor: "c", created_at: "2026-01-04T09:00:00Z" }),
    ok("GET /channels", "/channels", { data: rows(), total: 6, limit: 50, offset: 0, created_at: "2026-01-05T09:00:00Z" }),
    ok("GET /seeds", "/seeds", { data: rows(), total: 5, limit: 50, offset: 0, updated_at: "2026-01-06T09:00:00Z" }),
    ok("GET /operations", "/operations", { data: rows(), total: 45, limit: 50, offset: 0, next_cursor: "d" }),
    observeResponse({ op: "GET /pieces/{id}", path: "/pieces/{id}", status: 404, body: { error: "No piece." } }),
    observeResponse({ op: "GET /channels/{id}", path: "/channels/{id}", status: 404, body: { error: "No channel." } }),
    observeResponse({ op: "GET /seeds/{id}", path: "/seeds/{id}", status: 404, body: { error: "No seed." } }),
  ]);
  assert.deepEqual(f, [], `a consistent API must be silent, got: ${JSON.stringify(f)}`);
});

// --- pagination style --------------------------------------------------------

test("a cursor outlier among page/per_page endpoints is flagged", () => {
  const f = serviceConsistency([
    ok("GET /a", "/a", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /b", "/b", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /c", "/c", { data: rows(), next_cursor: "abc" }),
  ]);
  const hits = flagged(f, "GET /c");
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /2 of 3 paginated endpoints/);
  assert.match(hits[0].detail, /page\/per_page/);
  assert.match(hits[0].detail, /cursor/);
});

test("offset+cursor together is a superset of offset, never a contradiction", () => {
  // Taken verbatim from editorial-api: /pieces returns offset, limit AND
  // next_cursor while its siblings return offset+limit. Flagging that would be
  // a false positive on a real, healthy repo.
  const f = serviceConsistency([
    ok("GET /pieces", "/pieces", { data: rows(), total: 9, limit: 50, offset: 0, next_cursor: "c" }),
    ok("GET /channels", "/channels", { data: rows(), total: 6, limit: 50, offset: 0 }),
    ok("GET /seeds", "/seeds", { data: rows(), total: 5, limit: 50, offset: 0 }),
    ok("GET /operations", "/operations", { data: rows(), total: 45, limit: 50, offset: 0 }),
  ]);
  assert.equal(f.length, 0);
});

test("an unpaginated collection is not a pagination outlier", () => {
  const f = serviceConsistency([
    ok("GET /a", "/a", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /b", "/b", { data: rows(), page: 1, per_page: 20 }),
    ok("GET /c", "/c", { data: rows(), page: 2, per_page: 20 }),
    ok("GET /roles", "/roles", { data: rows() }),   // small fixed list, no markers
  ]);
  assert.equal(f.length, 0);
});

// --- timestamp format --------------------------------------------------------

test("an epoch-millis endpoint among ISO-8601 endpoints is flagged", () => {
  const f = serviceConsistency([
    ok("GET /a", "/a", { created_at: "2026-01-04T09:00:00Z" }),
    ok("GET /b", "/b", { updated_at: "2026-01-05T09:00:00Z" }),
    ok("GET /c", "/c", { placed_at: 1772532000000 }),
  ]);
  const hits = flagged(f, "GET /c");
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /ISO-8601/);
  assert.match(hits[0].detail, /epoch-millisecond/);
});

test("an endpoint carrying BOTH formats is compatible with the majority", () => {
  const f = serviceConsistency([
    ok("GET /a", "/a", { created_at: "2026-01-04T09:00:00Z" }),
    ok("GET /b", "/b", { updated_at: "2026-01-05T09:00:00Z" }),
    ok("GET /mixed", "/mixed", { created_at: "2026-01-04T09:00:00Z", synced_at: 1772532000000 }),
  ]);
  assert.equal(f.length, 0);
});

test("non-timestamp numbers never classify: ids and counters are not epochs", () => {
  const o = ok("GET /stats", "/stats", { orders: 13, revenue_cents: 137500, id: 1772532000000 });
  assert.equal(o.timestamps.size, 0);
});

// --- error envelope ----------------------------------------------------------

test("a bare-string error among {error:…} envelopes is flagged", () => {
  const e = (op, path, body) => observeResponse({ op, path, status: 404, body });
  const f = serviceConsistency([
    e("GET /a/{id}", "/a/{id}", { error: "No a." }),
    e("GET /b/{id}", "/b/{id}", { error: "No b." }),
    e("GET /c/{id}", "/c/{id}", "No c."),
  ]);
  const hits = flagged(f, "GET /c/{id}");
  assert.equal(hits.length, 1);
  assert.match(hits[0].detail, /bare string/);
});

test("a 5xx body is a crash handler, not the service's error convention", () => {
  assert.equal(observeResponse({ op: "GET /x", path: "/x", status: 500, body: { error: "boom" } }), null);
});

test("FastAPI's detail-as-string and detail-as-array are one family", () => {
  // fleet answers 422 with {detail: [...]} and 405 with {detail: "..."}; both
  // are the same convention and must not read as two error shapes.
  assert.equal(errorShapeOf({ detail: [{ msg: "invalid" }] }), "{detail: …}");
  assert.equal(errorShapeOf({ detail: "Method Not Allowed" }), "{detail: …}");
});

// --- 200 with an error body --------------------------------------------------

test("a 200 carrying a populated error envelope fires without clustering", () => {
  const f = serviceConsistency([
    ok("GET /invoices", "/invoices", { error: "invoice export is temporarily unavailable", code: "EXPORTER_RETIRED", data: [] }),
  ]);
  assert.equal(f.length, 1);
  assert.match(f[0].detail, /answers 200/);
  assert.match(f[0].detail, /treat this failure as success/);
});

test("an empty {errors: []} means 'no errors' and never fires", () => {
  const f = serviceConsistency([ok("GET /jobs", "/jobs", { data: rows(), errors: [] })]);
  assert.equal(f.length, 0);
});

// --- the platform ------------------------------------------------------------

const summaryFor = (bodies) => serviceSummary(bodies.map(([op, path, status, body]) =>
  observeResponse({ op, path, status, body })));

const corpusish = () => {
  // The corpus in miniature: each service internally consistent, all three
  // conventions drifting BETWEEN them, gateway mixing what it proxies.
  const identity = summaryFor([
    ["GET /accounts", "/accounts", 200, { data: rows(), page: 1, per_page: 20, total: 2 }],
    ["GET /api-keys", "/api-keys", 200, { data: rows(), page: 1, per_page: 20, total: 2 }],
    ["GET /accounts/{id}", "/accounts/{id}", 404, { errors: [{ code: "NOT_FOUND" }] }],
    ["GET /sessions/{id}", "/sessions/{id}", 404, { errors: [{ code: "NOT_FOUND" }] }],
    ["GET /a", "/a", 200, { created_at: "2026-01-04T09:00:00Z" }],
    ["GET /b", "/b", 200, { updated_at: "2026-01-05T09:00:00Z" }],
  ]);
  const catalog = summaryFor([
    ["GET /events", "/events", 200, { data: rows(), next_cursor: "c" }],
    ["GET /venues", "/venues", 200, { data: rows(), next_cursor: null, cursor: "c" }],
    ["GET /events/{id}", "/events/{id}", 404, { error: "No event." }],
    ["GET /venues/{id}", "/venues/{id}", 404, { error: "No venue." }],
    ["GET /e", "/e", 200, { starts_at: "2026-02-08T12:00:00Z" }],
    ["GET /f", "/f", 200, { created_at: "2025-12-03T12:00:00Z" }],
  ]);
  const orders = summaryFor([
    ["GET /orders", "/orders", 200, { data: rows(), offset: 0, limit: 20, total: 2 }],
    ["GET /refunds", "/refunds", 200, { data: rows(), offset: 0, limit: 20, total: 2 }],
    ["GET /orders/{id}", "/orders/{id}", 404, "No order."],
    ["GET /carts/{id}", "/carts/{id}", 404, "No cart."],
    ["GET /g", "/g", 200, { placed_at: 1772532000000 }],
    ["GET /h", "/h", 200, { updated_at: 1772532000000 }],
  ]);
  const gateway = summaryFor([
    ["GET /v1/events", "/v1/events", 200, { events: rows(), next_cursor: "c", per_page: 20 }],
    ["GET /v1/orders", "/v1/orders", 200, { orders: rows(), page: 1, per_page: 20 }],
    ["GET /v1/i", "/v1/i", 200, { starts_at: "2026-02-08T12:00:00Z" }],
    ["GET /v1/j", "/v1/j", 200, { placed_at: 1772532000000 }],
    ["GET /v1/orders/{id}", "/v1/orders/{id}", 404, { error: { code: "NOT_FOUND" } }],
    ["GET /v1/accounts/{id}", "/v1/accounts/{id}", 404, { error: { code: "NOT_FOUND" } }],
  ]);
  return [
    { name: "identity", repoRoot: "/r/identity", contract: "/r/identity/openapi.yaml", conventions: identity },
    { name: "catalog", repoRoot: "/r/catalog", contract: "/r/catalog/openapi.yaml", conventions: catalog },
    { name: "orders", repoRoot: "/r/orders", contract: "/r/orders/openapi.yaml", conventions: orders },
    { name: "gateway", repoRoot: "/r/gateway", contract: "/r/gateway/openapi.yaml", conventions: gateway },
  ];
};
const corpusEdges = [
  { from: "gateway", to: "identity" }, { from: "gateway", to: "catalog" }, { from: "gateway", to: "orders" },
];

test("the platform surfaces three pagination styles, three error shapes, two timestamp formats", () => {
  const f = platformConsistency(corpusish(), corpusEdges);
  const byDim = Object.fromEntries(f.map((x) => [x.dimension, x]));

  assert.ok(byDim.pagination, "pagination split is surfaced");
  assert.match(byDim.pagination.detail, /page\/per_page/);
  assert.match(byDim.pagination.detail, /cursor/);
  assert.match(byDim.pagination.detail, /offset\/limit/);
  assert.match(byDim.pagination.detail, /gateway mixes/, "the mixing BFF is named, not blamed");

  assert.ok(byDim.timestamps, "timestamp split is surfaced");
  assert.match(byDim.timestamps.detail, /2 of 3 services return ISO-8601/);
  assert.match(byDim.timestamps.detail, /orders returns epoch-millisecond/);

  assert.ok(byDim.errorShape, "error-shape split is surfaced");
  assert.match(byDim.errorShape.detail, /\{errors: …\}|\{error: …\}/);
  assert.match(byDim.errorShape.detail, /bare string/);
});

test("unrelated repos are never compared — two products are not one platform", () => {
  const services = corpusish();
  assert.deepEqual(platformConsistency(services, []), [],
    "different repoRoots and no edges: no platform, no findings");
});

test("surfaces that were never probed contribute no evidence", () => {
  const services = corpusish().map((s) => ({ ...s, conventions: undefined }));
  assert.deepEqual(platformConsistency(services, corpusEdges), []);
});

test("a shared consumer does not fuse two unrelated products into a platform", () => {
  // The first real-tree false positive: this tool's own repo names the base
  // URLs of both live fixture services, which drew an edge to each — and two
  // internally-consistent products got compared to each other. An edge only
  // groups when BOTH ends are documented API surfaces.
  const [a, b] = corpusish().slice(0, 2);   // identity ({errors}) vs catalog ({error})
  const consumer = { name: "tool", repoRoot: "/r/tool", conventions: null };  // no contract
  const f = platformConsistency([a, b, consumer],
    [{ from: "tool", to: "identity" }, { from: "tool", to: "catalog" }]);
  assert.deepEqual(f, [], "a client of two products is not a platform");
});

// --- wired into the audit ----------------------------------------------------
//
// The unit tests above exercise the detector in isolation; this one proves the
// audit actually runs it: a live fixture service whose /things endpoint answers
// with a bare array while three siblings wrap in {data:[]} must produce an
// `inconsistency` finding through auditSurface itself. This test FAILED before
// probe() collected convention observations, which is the point of it.

function fixtureService() {
  const bodies = {
    "/widgets": { data: rows(), page: 1, per_page: 20, total: 2 },
    "/gadgets": { data: rows(), page: 1, per_page: 20, total: 2 },
    "/sprockets": { data: rows(), page: 1, per_page: 20, total: 2 },
    "/things": rows(),
  };
  return createServer((req, res) => {
    const path = new URL(req.url, "http://x").pathname;
    if (bodies[path]) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(bodies[path])); return; }
    if (/^\/widgets\/[^/]+$/.test(path)) {
      res.statusCode = 404; res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: `No widget.` })); return;
    }
    res.statusCode = 404; res.end(JSON.stringify({ error: "no route" }));
  });
}

test("auditSurface reports the outlier endpoint of a live service", async () => {
  const server = fixtureService();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const dir = mkdtempSync(join(tmpdir(), "consistency-audit-"));
  const paths = Object.fromEntries(["/widgets", "/gadgets", "/sprockets", "/things", "/widgets/{id}"]
    .map((p) => [p, { get: { responses: { 200: { description: "ok" } } } }]));
  writeFileSync(join(dir, "openapi.json"), JSON.stringify({ openapi: "3.0.0", info: { title: "fixture" }, paths }));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${port}` } } }));

  try {
    const result = await auditSurface({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 5 });
    const hits = result.findings.filter((f) => f.kind === "inconsistency");
    assert.equal(hits.length, 1, `expected exactly the /things outlier, got: ${JSON.stringify(hits)}`);
    assert.equal(hits[0].op, "GET /things");
    assert.match(hits[0].detail, /3 of 4 collection endpoints/);
    assert.ok(result.conventions, "the surface carries a convention summary for the platform pass");
    assert.deepEqual(result.conventions.pagination.values, ["page"]);
  } finally { server.close(); }
});
