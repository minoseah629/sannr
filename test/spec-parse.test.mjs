// Spec-parser robustness (Tier 0 F2) — a stranger's spec must load, or fail
// with a NAMED reason, never a silent empty inventory.
//
//   node --test test/spec-parse.test.mjs
//
// The regex-era YAML reader silently inventoried 0 operations from a normal
// inline-flow OpenAPI document (2026-08 field report). These tests pin the
// three spec dialects the tool claims — OpenAPI 3.0, 3.1, Swagger 2.0 — in
// JSON and YAML, flow and block styles, plus the named-failure contract.
// Every test here was confirmed to FAIL against the pre-rewrite parser except
// where marked as a pin on behaviour that already held.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseYaml, readContract, operationsFrom, responseSchema, deref,
  noOperationsReason, opNode,
} from "../lib/context.mjs";

const tmpSpec = (name, content) => {
  const dir = mkdtempSync(join(tmpdir(), "spec-"));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

// --- inline-flow YAML: the defect that opened this ticket --------------------

test("multi-line inline-flow paths inventory correctly (the field failure)", () => {
  // A converted spec commonly emits flow collections spanning lines. The old
  // parser read flow only within one line, fell back to the block line-scan,
  // and reported 0 operations without a word.
  const doc = parseYaml(`openapi: 3.0.3
info: {title: Inline, version: "1.0"}
paths: {
  /widgets: {
    get: {
      summary: list widgets,
      responses: {"200": {description: ok}}
    },
    post: {responses: {"201": {description: created}}}
  },
  # a comment inside the flow must not derail it
  /widgets/{id}: {get: {responses: {"200": {description: ok}}}}
}
`);
  const ops = operationsFrom(doc).map((o) => o.op).sort();
  assert.deepEqual(ops, ["GET /widgets", "GET /widgets/{id}", "POST /widgets"]);
});

test("a whole-document flow body (JSON saved as .yaml) inventories", () => {
  // JSON is valid YAML flow; people rename files. The old parser saw a line
  // "{", matched no key, and returned an empty map.
  const json = JSON.stringify({
    openapi: "3.0.0",
    info: { title: "Renamed", version: "1" },
    paths: { "/a": { get: { responses: { 200: { description: "ok" } } } },
             "/b": { delete: { responses: { 204: { description: "gone" } } } } },
  }, null, 2);
  const { doc } = readContract(tmpSpec("openapi.yaml", json));
  assert.equal(operationsFrom(doc).length, 2);
});

test("escaped quotes and commas inside flow strings survive", () => {
  const doc = parseYaml(`info: {description: "a \\"quoted\\" word, with comma", x: 'it''s'}`);
  assert.equal(doc.info.description, 'a "quoted" word, with comma');
  assert.equal(doc.info.x, "it's");
});

// --- anchors, aliases, merge keys -------------------------------------------

test("anchors, aliases, and merge keys resolve", () => {
  const doc = parseYaml(`openapi: 3.0.0
components:
  schemas:
    Base: &base
      type: object
      properties:
        id: {type: integer}
    Extended:
      <<: *base
      description: extended
paths:
  /a:
    get:
      responses: {"200": {description: ok}}
`);
  const ext = doc.components.schemas.Extended;
  assert.equal(ext.type, "object", "merge key must pull the anchored map in");
  assert.equal(ext.properties.id.type, "integer");
  assert.equal(ext.description, "extended", "explicit keys must survive the merge");
  assert.equal(operationsFrom(doc).length, 1);
});

test("only the first YAML document is read", () => {
  const doc = parseYaml(`---
openapi: 3.0.0
paths:
  /first:
    get:
      responses: {"200": {description: ok}}
---
paths:
  /second:
    get:
      responses: {"200": {description: ok}}
`);
  assert.deepEqual(operationsFrom(doc).map((o) => o.path), ["/first"]);
});

test("a block sequence at the SAME indent as its key parses (Twilio style)", () => {
  // Legal YAML that real specs emit ("servers:" then "- url:" at equal
  // indent). The old parser treated the dash line as a foreign sequence,
  // broke out of the map, and silently dropped every following key — the
  // Twilio v2010 spec inventoried 0 operations because of exactly this.
  const doc = parseYaml(`openapi: 3.0.0
paths:
  /accounts:
    servers:
    - url: https://api.example.com
    description: accounts
    get:
      responses:
        "200":
          description: ok
`);
  const item = doc.paths["/accounts"];
  assert.deepEqual(item.servers, [{ url: "https://api.example.com" }]);
  assert.equal(item.description, "accounts");
  assert.deepEqual(operationsFrom(doc).map((o) => o.op), ["GET /accounts"]);
});

test("an explicit key (? path / : value) parses (Twilio long-path style)", () => {
  // yaml emitters switch to the explicit form when a key passes 128 chars;
  // Twilio's deepest route ships this way and was the one operation the old
  // parser dropped from the whole document.
  const doc = parseYaml(`openapi: 3.0.0
paths:
  ? /a/very/long/{Sid}.json
  : servers:
    - url: https://api.example.com
    get:
      responses:
        "200":
          description: ok
`);
  assert.deepEqual(operationsFrom(doc).map((o) => o.op), ["GET /a/very/long/{Sid}.json"]);
  assert.deepEqual(doc.paths["/a/very/long/{Sid}.json"].servers, [{ url: "https://api.example.com" }]);
});

// --- Swagger 2.0 -------------------------------------------------------------

const SWAGGER2 = `swagger: "2.0"
info: {title: Legacy, version: "1.0"}
basePath: /v2
paths:
  /pets:
    get:
      responses:
        "200":
          description: ok
          schema:
            $ref: "#/definitions/Pets"
definitions:
  Pets:
    type: array
    items: {$ref: "#/definitions/Pet"}
  Pet:
    type: object
    required: [id]
    properties:
      id: {type: integer}
      name: {type: string}
`;

test("Swagger 2.0: basePath prefixes the inventoried operations", () => {
  const doc = parseYaml(SWAGGER2);
  assert.deepEqual(operationsFrom(doc).map((o) => o.op), ["GET /v2/pets"]);
});

test("Swagger 2.0: responseSchema reads responses.schema and derefs #/definitions", () => {
  const doc = parseYaml(SWAGGER2);
  // The op is addressed by its REAL path (basePath included), as operationsFrom
  // reports it; responseSchema must resolve that back to the paths entry.
  const schema = responseSchema(doc, "GET", "/v2/pets");
  assert.equal(schema.type, "array");
  assert.equal(schema.items.properties.id.type, "integer");
  assert.deepEqual(schema.items.required, ["id"]);
});

test("deref unescapes JSON-pointer tokens (~1 -> /, ~0 -> ~)", () => {
  const doc = { components: { schemas: { "a/b": { type: "string" } } } };
  const r = deref(doc, { $ref: "#/components/schemas/a~1b" });
  assert.equal(r.type, "string");
});

// --- OpenAPI 3.1 -------------------------------------------------------------

test("OpenAPI 3.1: type arrays and components schemas inventory and deref", () => {
  const doc = parseYaml(`openapi: 3.1.0
info: {title: Modern, version: "1.0"}
paths:
  /users:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: {$ref: "#/components/schemas/User"}
components:
  schemas:
    User:
      type: object
      required: [id]
      properties:
        id: {type: integer}
        nickname:
          type: [string, "null"]
`);
  assert.equal(operationsFrom(doc).length, 1);
  const schema = responseSchema(doc, "GET", "/users");
  assert.deepEqual(schema.properties.nickname.type, ["string", "null"]);
});

test("a json-ish content type (charset suffix, +json) still yields the schema", () => {
  const mk = (ct) => ({ openapi: "3.0.0", paths: { "/x": { get: { responses: {
    200: { content: { [ct]: { schema: { type: "object" } } } } } } } } });
  assert.equal(responseSchema(mk("application/json; charset=utf-8"), "GET", "/x").type, "object");
  assert.equal(responseSchema(mk("application/vnd.api+json"), "GET", "/x").type, "object");
  // A non-JSON media type must stay invisible: the schema describes bytes the
  // client will never promote values from.
  assert.equal(responseSchema(mk("application/xml"), "GET", "/x"), undefined);
});

// --- named failure, never a silent zero --------------------------------------

test("noOperationsReason names WHY a document yields nothing", () => {
  assert.match(noOperationsReason(null), /did not parse/);
  assert.match(noOperationsReason(parseYaml("openapi: 3.0.0\ninfo:\n  title: x")),
    /no "paths"/);
  assert.match(noOperationsReason(parseYaml("info:\n  title: x")),
    /openapi\/swagger version/i);
  assert.match(noOperationsReason(parseYaml("openapi: 3.0.0\npaths: {}")),
    /empty/);
  const methodless = parseYaml(("openapi: 3.0.0\npaths:\n  /a:" + "\n    summary: no verbs here"));
  assert.match(noOperationsReason(methodless), /HTTP method/);
});

test("operationsFrom tolerates a null document instead of crashing", () => {
  assert.deepEqual(operationsFrom(null), []);
});

test("malformed JSON still throws a real error for the caller to name", () => {
  // Pin: audit discovery relies on readContract throwing (it catches and
  // skips); init catches it and dies PARSE_ERROR. Silence is the only bug.
  assert.throws(() => readContract(tmpSpec("openapi.json", "{ not json")));
});

test("path-level keys that are not methods are not operations", () => {
  const doc = parseYaml(`openapi: 3.0.0
paths:
  /a:
    summary: about /a
    parameters:
      - {name: q, in: query}
    get:
      responses: {"200": {description: ok}}
`);
  assert.deepEqual(operationsFrom(doc).map((o) => o.op), ["GET /a"]);
});

// --- F2 follow-up: parser hardening edges ------------------------------------
// Three low-severity edges the adversarial pass found contained only by
// readContract's try/catch. Each test below was confirmed to FAIL against the
// pre-fix parser: a stack crash, a 16-second parse, and a wrong node.

test("a pathologically deep block document is depth-capped, not a stack crash", () => {
  // 20k indent levels, one key per level. Pre-fix: block()->map()->block()
  // recursion blew the call stack (RangeError), and only readContract's catch
  // stood between that and the caller.
  const lines = ["openapi: 3.0.0"];
  for (let d = 0; d < 20_000; d += 1) lines.push(" ".repeat(d) + `k${d}:`);
  const doc = parseYaml(lines.join("\n"));
  assert.equal(doc.openapi, "3.0.0");
  // Walk down: past the cap the subtree is summarised ("…", shapeOf's
  // spelling), never descended.
  let node = doc, depth = 0;
  while (node && typeof node === "object") { node = node[`k${depth}`]; depth += 1; }
  assert.equal(node, "…");
  assert.ok(depth < 300, `descended ${depth} levels; the cap did not hold`);
});

test("a depth bomb beside paths still yields full contract detail", () => {
  // Pre-fix the RangeError voided the WHOLE parse and the line-scan fallback
  // took over — paths survived but schemas (which the fallback cannot see)
  // silently vanished. Post-fix only the bombed subtree is summarised.
  const bomb = [];
  for (let d = 0; d < 20_000; d += 1) bomb.push(" ".repeat(d + 2) + `b${d}:`);
  const spec = `openapi: 3.0.0
info: {title: Bombed, version: "1"}
paths:
  /widgets:
    get:
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: {type: object, properties: {id: {type: integer}}}
x-bomb:
${bomb.join("\n")}
`;
  const { doc } = readContract(tmpSpec("bombed.yaml", spec));
  assert.deepEqual(operationsFrom(doc).map((o) => o.op), ["GET /widgets"]);
  const schema = responseSchema(doc, "GET", "/widgets");
  assert.equal(schema?.properties?.id?.type, "integer",
    "schema lost — the parse fell back to the blind line-scan");
});

test("a 40k-line inline-flow value parses in linear time", () => {
  // Pre-fix flowValue rescanned the whole joined text once per absorbed line
  // (quadratic): this exact input took ~16s — a slow-parse DoS in a document
  // we merely opened. Linear is under 100ms; 3s absorbs a loaded CI box.
  const lines = ["openapi: 3.0.0", "big: ["];
  for (let n = 0; n < 40_000; n += 1) lines.push(`  ${n},`);
  lines.push("]");
  const t0 = Date.now();
  const doc = parseYaml(lines.join("\n"));
  const elapsed = Date.now() - t0;
  assert.equal(doc.big[0], 0);
  assert.equal(doc.big[39_999], 39_999);
  assert.ok(elapsed < 3000, `flow join took ${elapsed}ms; the quadratic is back`);
});

test("an unclosed flow value is capped, parsed truncated, and the document survives", () => {
  // A "[" that never closes absorbs lines to EOF. Pre-fix that absorption was
  // quadratic (minutes at this size); post-fix the join is linear AND capped,
  // so the value comes back truncated and the rest of the document still
  // answers — bounded work, never a hang.
  const lines = ["openapi: 3.0.0", "big: ["];
  for (let n = 0; n < 5_000; n += 1) lines.push(`  "${"a".repeat(1000)}",`);
  const t0 = Date.now();
  const doc = parseYaml(lines.join("\n"));
  const elapsed = Date.now() - t0;
  assert.equal(doc.openapi, "3.0.0");
  assert.ok(Array.isArray(doc.big));
  assert.ok(doc.big.length < 5_000, "the join cap did not bite");
  assert.ok(elapsed < 5000, `unclosed flow took ${elapsed}ms`);
});

test("Swagger 2.0: a literal path colliding with the basePath resolves to the right node", () => {
  // Under basePath /v1 the REAL URL of "/users" is /v1/users — the same string
  // an adversarial spec can list literally. Pre-fix opNode tried the raw path
  // first and handed back the literal "/v1/users" entry (whose real URL is
  // /v1/v1/users) for BOTH operations: one node answering for two routes.
  const doc = { swagger: "2.0", basePath: "/v1", paths: {
    "/users": { get: { marker: "prefixed" } },
    "/v1/users": { get: { marker: "literal" } },
  } };
  assert.deepEqual(operationsFrom(doc).map((o) => o.op).sort(),
    ["GET /v1/users", "GET /v1/v1/users"]);
  assert.equal(opNode(doc, "GET", "/v1/users")?.marker, "prefixed");
  assert.equal(opNode(doc, "GET", "/v1/v1/users")?.marker, "literal");
  // Segment boundary pin: /apidocs merely SHARES a prefix with basePath /api —
  // stripping would look up "docs". It must resolve directly.
  const doc2 = { swagger: "2.0", basePath: "/api",
    paths: { "/apidocs": { get: { marker: "direct" } } } };
  assert.equal(opNode(doc2, "GET", "/apidocs")?.marker, "direct");
});
