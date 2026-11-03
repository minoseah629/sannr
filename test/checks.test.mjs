import { LAYOUT } from "../lib/layout.mjs";
// Disagreement detectors: contract-vs-server and contract-vs-history.
//
//   node --test test/checks.test.mjs
//
// Two families of test, split on purpose:
//   - probe-level tests import only lib/audit.mjs, which predates the
//     detectors. Before the change, probe() returned zero findings for every
//     case here, so each of these failed on its ASSERTION — proof the detector
//     did not exist, not just that a file was missing.
//   - unit tests pin the gates that keep the detectors from crying wolf on
//     real repos: an honest-but-partial spec, a bare 400 that names nothing,
//     a stale sampled id. The corpus scores 1.00 either way; these gates are
//     what real repos demanded.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync,  readFileSync, existsSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probe, auditSurface, baseUrlFor, upstreamUrls } from "../lib/audit.mjs";
import { parseYaml, readContract, responseSchema } from "../lib/context.mjs";
import { compareShape, bareRejectionFinding, staticStatusFindings,
  crossRepoRequiredFieldFindings, consumerCallSites, dedupeSchemaMismatch,
  sampleIdFor } from "../lib/checks.mjs";

// --- one deliberately disagreeable service ----------------------------------

const THINGS = [{ id: "t1", name: "widget", price: 5 }];   // name undeclared, price number
let server, base;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    const routes = {
      "GET /things": () => send(200, { data: THINGS, next_cursor: "abc" }),
      "GET /things/t1": () => send(200, THINGS[0]),
      "GET /things/t1/history": () => send(500, { error: "boom" }),
      "GET /search": () => send(400, { error: "q is required." }),
      "GET /vague": () => send(400, { error: "computer says no" }),
      "GET /old": () => send(200, { ok: true }, { deprecation: "true", sunset: "soon" }),
      "GET /clean": () => send(200, { id: "c1", extra_field: "spec is partial, not wrong" }),
      "POST /widgets": () => {
        let raw = "";
        req.on("data", (c) => { raw += c; });
        req.on("end", () => {
          const body = JSON.parse(raw || "{}");
          if (!body.color) return send(422, { error: "color is required." });
          send(201, { ok: true });
        });
        return "async";
      },
    };
    const hit = routes[`${req.method} ${url.pathname}`];
    if (!hit) return send(404, { error: "no such route" });
    hit();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

// A YAML contract, because parsing YAML deeply enough to see schemas is part
// of what is under test.
const CONTRACT = `openapi: 3.1.0
info:
  title: Disagreeable API
  version: 1.0.0
paths:
  /things:
    get:
      parameters:
        - name: limit
          in: query
          required: false
          schema: { type: integer, default: 10 }
      responses:
        "200":
          description: A page of things
          content:
            application/json:
              schema:
                type: object
                properties:
                  data:
                    type: array
                    items: { $ref: "#/components/schemas/Thing" }
                  next_cursor: { type: [string, "null"] }
  /things/{id}:
    get:
      responses:
        "200":
          description: One thing
          content:
            application/json:
              schema: { $ref: "#/components/schemas/Thing" }
  /things/{id}/history:
    get:
      responses:
        "200":
          description: History
  /search:
    get:
      parameters:
        - name: q
          in: query
          required: false
          schema: { type: string }
      responses:
        "200":
          description: Results
  /vague:
    get:
      parameters:
        - name: filter
          in: query
          required: false
          schema: { type: string }
      responses:
        "200":
          description: Something
  /old:
    get:
      deprecated: true
      responses:
        "200":
          description: Still here
  /clean:
    get:
      responses:
        "200":
          description: Honest but partial
          content:
            application/json:
              schema:
                type: object
                properties:
                  id: { type: string }
components:
  schemas:
    Thing:
      type: object
      required: [id, label]
      properties:
        id: { type: string }
        label: { type: string }
        price:
          type: string
          description: Decimal string; the server disagrees.
`;

function surfaceDir(contract, baseUrl) {
  const dir = mkdtempSync(join(tmpdir(), "checks-test-"));
  writeFileSync(join(dir, "openapi.yaml"), contract);
  writeFileSync(join(dir, LAYOUT.environments),
    JSON.stringify({ default: "local", environments: { local: { baseUrl } } }));
  return dir;
}

const kinds = (findings, kind) => findings.filter((f) => f.kind === kind);

test("probe surfaces every planted disagreement, and only those", async () => {
  const dir = surfaceDir(CONTRACT, base);
  const { findings } = await probe({ dir, contract: join(dir, "openapi.yaml") });

  // response-schema-mismatch, three ways: required-absent, undeclared, type.
  const schema = kinds(findings, "schema-mismatch");
  assert.ok(schema.some((f) => f.op === "GET /things" && /label.*required.*absent/.test(f.detail)),
    "a declared-required field the server never returns");
  assert.ok(schema.some((f) => f.op === "GET /things" && /name.*schema omits/.test(f.detail)),
    "a field the server returns that a required-carrying schema omits");
  assert.ok(schema.some((f) => f.op === "GET /things/{id}" && /price.*declared string.*number/.test(f.detail)),
    "a declared type the server contradicts, reached through a sampled id");

  // required-param-documented-optional: only when the error names the param.
  const params = kinds(findings, "required-param-optional");
  assert.equal(params.length, 1);
  assert.equal(params[0].op, "GET /search");
  assert.ok(!findings.some((f) => f.op === "GET /vague"),
    "a bare 400 that names no declared parameter proves nothing");

  // deprecated-but-live via the runtime header.
  assert.ok(kinds(findings, "deprecated-but-live").some((f) => f.op === "GET /old"));

  // a sampled parameterised probe reports the 5xx its own response proves.
  assert.ok(kinds(findings, "erroring").some((f) => f.op === "GET /things/{id}/history"));

  // the honest-but-partial spec (no required list) is NOT punished for the
  // server's extra field.
  assert.ok(!findings.some((f) => f.op === "GET /clean"), "partial specs must not cry wolf");
});

// A documented templated GET the server has no route for: the id is sampled
// from the live /things collection, so the 404 on the substituted path is the
// missing ROUTE, not a stale row. Before the refinement, probe() skipped `{`
// paths in its missing check and never reported a 404 from a sampled id, so
// this planted missing-op went undetected — the assertion below failed.
const LAYOUT_CONTRACT = `openapi: 3.1.0
info:
  title: Layout API
  version: 1.0.0
paths:
  /things:
    get:
      responses:
        "200": { description: things }
  /things/{id}/layout:
    get:
      responses:
        "200": { description: seat layout }
`;

test("a documented templated GET the server 404s is caught via a sampled id", async () => {
  const dir = surfaceDir(LAYOUT_CONTRACT, base);
  const { findings } = await probe({ dir, contract: join(dir, "openapi.yaml") });
  const missing = kinds(findings, "missing");
  assert.ok(missing.some((f) => f.op === "GET /things/{id}/layout"),
    "a templated GET the server 404s on a listed id is a missing op");
});

// Root-cause dedup: the corpus shape, synthesised. Eight true schema-mismatch
// findings for three causes — a rename split into absent+omits halves, and a
// single break echoed on a collection and its detail sibling. Before the
// refinement dedupeSchemaMismatch did not exist (this import would throw); the
// granular findings were reported one per operation per half.
test("schema-mismatch findings collapse to one per root cause, operations listed", () => {
  const findings = [
    { op: "GET /v1/events", kind: "schema-mismatch", detail: "events[0].venue_name: declared string, server returns object" },
    { op: "GET /v1/home", kind: "schema-mismatch", detail: "featured[0].venue_name: declared string, server returns object" },
    { op: "GET /accounts", kind: "schema-mismatch", detail: "data[0].display_name: declared required, absent from the response" },
    { op: "GET /accounts", kind: "schema-mismatch", detail: "data[0].name: server returns it, the schema omits it" },
    { op: "GET /accounts/{id}", kind: "schema-mismatch", detail: "display_name: declared required, absent from the response" },
    { op: "GET /accounts/{id}", kind: "schema-mismatch", detail: "name: server returns it, the schema omits it" },
    { op: "GET /orders", kind: "schema-mismatch", detail: "data[0].total: declared string, server returns number" },
    { op: "GET /orders/{id}", kind: "schema-mismatch", detail: "total: declared string, server returns number" },
    { op: "POST /events/{id}/publish", kind: "status-mismatch", detail: "unrelated, must pass through" },
  ];
  const out = dedupeSchemaMismatch(findings);
  const sm = out.filter((f) => f.kind === "schema-mismatch");
  assert.equal(sm.length, 3, "eight findings, three root causes");
  assert.ok(out.some((f) => f.kind === "status-mismatch"), "non-schema findings pass through untouched");

  // The rename is rejoined into one finding spanning both sibling operations,
  // and the detail endpoint (the planted schema-001 op) is still covered.
  const rename = sm.find((f) => /display_name renamed to name/.test(f.detail));
  assert.ok(rename, "the two halves of the rename become one finding");
  assert.deepEqual(rename.operations, ["GET /accounts", "GET /accounts/{id}"]);

  // The type change (planted schema-002) is one finding across list + detail.
  const total = sm.find((f) => /total: declared string, server returns number/.test(f.detail));
  assert.ok(total && total.operations.includes("GET /orders/{id}"),
    "the type break collapses across the collection and its detail sibling");

  // Sibling collections with the same field/nature collapse too.
  const venue = sm.find((f) => /venue_name/.test(f.detail));
  assert.deepEqual(venue.operations, ["GET /v1/events", "GET /v1/home"]);
});

test("dedupeSchemaMismatch never invents or drops findings", () => {
  // Zero in, zero out — a repo with no schema-mismatch findings stays clean.
  const clean = [{ op: "GET /x", kind: "redirect", detail: "moved" }];
  assert.deepEqual(dedupeSchemaMismatch(clean), clean);
  // A lone, unpairable absent survives as itself, not silently dropped.
  const lone = [{ op: "GET /a", kind: "schema-mismatch", detail: "foo: declared required, absent from the response" },
    { op: "GET /a", kind: "schema-mismatch", detail: "bar: server returns it, the schema omits it" }];
  // Same op set → these two DO pair into a rename; assert the single result.
  const out = dedupeSchemaMismatch(lone);
  assert.equal(out.filter((f) => f.kind === "schema-mismatch").length, 1);
});

test("shape-hash baseline: divergence and full-page row count are flagged; recording is opt-in", async () => {
  const dir = surfaceDir(CONTRACT, base);
  const ctxPath = join(dir, LAYOUT.context);
  writeFileSync(ctxPath, JSON.stringify({
    v: 0, api: { name: "t", contract: "openapi.yaml", contract_digest: null },
    operations: {
      "GET /things": { shape_hash: "sha256:definitely-not-this", verified_at: "2026-01-01",
        page_rows: 5, page_full: true, status_codes: [], effect: "read", fields: {} },
    },
  }));
  const before = readFileSync(ctxPath, "utf8");
  const r = await auditSurface({ dir, contract: join(dir, "openapi.yaml"), kind: "documented" });
  assert.ok(kinds(r.findings, "shape-drift").some((f) => f.op === "GET /things"),
    "a recorded shape hash that no longer matches is drift");
  assert.ok(kinds(r.findings, "page-size-change").some((f) => f.op === "GET /things" && /1 rows.*was 5/.test(f.detail)),
    "a full default page that changed row count is a page-size change");
  assert.equal(readFileSync(ctxPath, "utf8"), before,
    "a plain audit never writes into a surveyed repo");

  // With recording on, ops WITHOUT a baseline get one; diverged ones keep
  // their evidence.
  const r2 = await auditSurface({ dir, contract: join(dir, "openapi.yaml"), kind: "documented" },
    { recordBaselines: true });
  assert.ok(r2.findings.length);
  const ctx = JSON.parse(readFileSync(ctxPath, "utf8"));
  assert.equal(ctx.operations["GET /things"].shape_hash, "sha256:definitely-not-this",
    "drift is flagged, not silently re-baselined");
});

test("status-code-mismatch is read from the handler source, never by executing the write", () => {
  const dir = mkdtempSync(join(tmpdir(), "checks-static-"));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "server.mjs"), `
    app.post("/things/:id/publish", (c) => {
      if (!ok) return fail(c, 409, "cancelled");
      return c.json({ done: true }, 201);
    });
    app.post("/things", (c) => c.json({}, 201));
    app.get("/things", (c) => c.json({ data: [] }));
  `);
  const doc = parseYaml(`paths:
  /things/{id}/publish:
    post:
      responses:
        "200":
          description: Documented as 200; the handler sends 201
        "409":
          description: Cancelled
  /things:
    post:
      responses:
        "201":
          description: Correctly documented
    get:
      responses:
        "200":
          description: Fine
`);
  const findings = staticStatusFindings(dir, doc);
  assert.equal(findings.length, 1, "only the disagreeing handler is flagged");
  assert.equal(findings[0].op, "POST /things/{id}/publish");
  assert.match(findings[0].detail, /201.*documents 200/);
});

test("a Fastify generic between method and path does not let one handler swallow another's status", () => {
  const dir = mkdtempSync(join(tmpdir(), "checks-generic-"));
  mkdirSync(join(dir, "src"));
  // Pre-fix, app.post<...> was invisible, so GET /widgets' slice ran through
  // the POST handler and inherited its 201 — the first real-repo false positive.
  writeFileSync(join(dir, "src", "app.ts"), `
    app.get("/widgets", async () => ({ items: [] }));
    app.post<{ Body: { name: string } }>("/widgets", async (request, reply) => {
      return reply.code(201).send({});
    });
  `);
  const doc = parseYaml(`paths:
  /widgets:
    get:
      responses:
        "200":
          description: Fine
    post:
      responses:
        "201":
          description: Fine
`);
  assert.deepEqual(staticStatusFindings(dir, doc), []);
});

test("request-field-now-required: consumer call site + upstream contract + one refused probe", async () => {
  const upDir = surfaceDir(`openapi: 3.1.0
paths:
  /widgets:
    post:
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [name, color]
              properties:
                name: { type: string }
                color: { type: string }
      responses:
        "201":
          description: Created
`, base);
  const consumerDir = mkdtempSync(join(tmpdir(), "checks-consumer-"));
  mkdirSync(join(consumerDir, "src"));
  writeFileSync(join(consumerDir, "src", "upstream.mjs"),
    `export const BASES = { upstream: "${base}" };`);
  writeFileSync(join(consumerDir, "src", "server.mjs"), `
    import { upstream } from "./upstream.mjs";
    const res = await upstream("/widgets", { method: "POST", body: { name: body.name } });
  `);

  const results = [
    { name: "upstream", dir: upDir, contract: join(upDir, "openapi.yaml"), findings: [] },
    { name: "consumer", dir: consumerDir, contract: null, findings: [] },
  ];
  await crossRepoRequiredFieldFindings(results, { readContract, baseUrlFor, upstreamUrls });
  const f = kinds(results[1].findings, "request-field-now-required");
  assert.equal(f.length, 1, "the consumer that omits the newly required field is flagged");
  assert.match(f[0].detail, /color/);
  assert.ok(!results[0].findings.length, "the upstream agrees with itself and stays clean");

  // A consumer already sending every required field is never probed into a finding.
  writeFileSync(join(consumerDir, "src", "server.mjs"), `
    import { upstream } from "./upstream.mjs";
    const res = await upstream("/widgets", { method: "POST", body: { name: n, color: c } });
  `);
  results[1].findings = [];
  await crossRepoRequiredFieldFindings(results, { readContract, baseUrlFor, upstreamUrls });
  assert.deepEqual(results[1].findings, []);
});

// --- gates, pinned as units --------------------------------------------------

test("compareShape only trusts a schema that asserts completeness", () => {
  const strict = { type: "object", required: ["id"], properties: { id: { type: "string" } } };
  const partial = { type: "object", properties: { id: { type: "string" } } };
  assert.equal(compareShape({ id: "x", extra: 1 }, strict).length, 1, "required list ⇒ extra field flagged");
  assert.equal(compareShape({ id: "x", extra: 1 }, partial).length, 0, "no required list ⇒ honest partial spec");
  assert.equal(compareShape({ id: null }, strict).length, 0, "null contradicts nothing");
  assert.equal(compareShape({ id: 7 }, strict).length, 1, "a definite type contradiction is flagged");
});

test("bareRejectionFinding demands a named parameter and an all-optional contract", () => {
  const doc = parseYaml(`paths:
  /search:
    get:
      parameters:
        - name: q
          in: query
          required: false
          schema: { type: string }
        - name: mandatory
          in: query
          required: true
          schema: { type: string }
`);
  assert.equal(bareRejectionFinding({ op: "GET /search", method: "GET", path: "/search",
    doc, status: 400, bodyText: '{"error":"q is required"}' }), null,
    "a contract that already requires a param makes the 400 agreement, not drift");
});

// JSON-LD style APIs (api.weather.gov) publish `id` as the row's own URI.
// Substituting that URI whole into the path template guarantees a 404 on a
// healthy documented route — the external yardstick (test/external.mjs) caught
// the audit doing exactly this, flagging eight live weather.gov operations as
// missing. Before the fix sampleIdFor returned the full URI for every case
// below; the first four assertions failed.
test("a URI-shaped sampled id is trimmed to its path tail, never substituted whole", () => {
  const stations = new Map([["/stations",
    { features: [{ id: "https://api.weather.gov/stations/0007W", name: "x" }] }]]);
  assert.equal(sampleIdFor("/stations/{stationId}", stations), "0007W");
  assert.equal(sampleIdFor("/stations/{stationId}/observations", stations), "0007W");
  // A relative self-link with a trailing slash trims the same way.
  const rel = new Map([["/api/v2/ability", { results: [{ id: "/api/v2/ability/1/" }] }]]);
  assert.equal(sampleIdFor("/api/v2/ability/{id}", rel), "1");
  // A URI that does not extend the parent collection's path proves nothing.
  const foreign = new Map([["/stations", { features: [{ id: "https://elsewhere.example/other/1" }] }]]);
  assert.equal(sampleIdFor("/stations/{stationId}", foreign), null);
  // Scalar ids — the corpus case — ride through untouched.
  const plain = new Map([["/things", [{ id: 7 }]]]);
  assert.equal(sampleIdFor("/things/{id}", plain), "7");
});

test("consumerCallSites ignores reads and non-literal bodies", () => {
  const dir = mkdtempSync(join(tmpdir(), "checks-sites-"));
  writeFileSync(join(dir, "a.mjs"), `
    upstream("/things");
    upstream("/things", { method: "POST", body: payload });
    upstream("/things", { method: "POST", body: { a: 1, b: x } });
  `);
  const sites = consumerCallSites(dir, ["upstream"]);
  assert.equal(sites.length, 1, "only the flat object literal is knowable");
  assert.deepEqual(sites[0].keys, ["a", "b"]);
});

test("the YAML subset parser reads what the detectors need", () => {
  const { doc } = readContract(join(surfaceDir(CONTRACT, "http://x"), "openapi.yaml"));
  const schema = responseSchema(doc, "GET", "/things/{id}");
  assert.equal(schema.properties.price.type, "string", "$ref resolved through components");
  assert.deepEqual(schema.required, ["id", "label"]);
  assert.equal(doc.paths["/old"].get.deprecated, true);
  assert.equal(doc.paths["/search"].get.parameters[0].required, false);
  assert.equal(doc.paths["/things"].get.parameters[0].schema.default, 10, "flow maps parse");
  assert.deepEqual(doc.paths["/things"].get.responses["200"].content["application/json"]
    .schema.properties.next_cursor.type, ["string", "null"], "flow sequences parse");
});

test("a YAML document the subset parser cannot beat falls back to the path scan", () => {
  const dir = mkdtempSync(join(tmpdir(), "checks-fallback-"));
  // Anchors and merge keys are outside the subset; the line-scan still sees paths.
  writeFileSync(join(dir, "openapi.yaml"), `defaults: &d\n  x: 1\npaths:\n  /a:\n    get:\n      <<: *d\n`);
  const { doc } = readContract(join(dir, "openapi.yaml"));
  assert.ok(doc.paths["/a"].get, "operations survive whichever parser wins");
});
