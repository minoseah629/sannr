// context.mjs — the untrusted-spec parser and $ref resolver, finally tested.
//
//   node --test test/context.test.mjs
//
// This module had ~18 exported functions and ZERO direct tests, while being the
// one thing fed someone else's OpenAPI document. The 2026-08-15 adversarial pass
// went straight here (the earlier session's silent $ref bug was here too). These
// tests pin the two defects it found AND the boundaries that held, so the blind
// spot stops being blind.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deref, shapeOf, shapeHash, rowsOf, emptyContext, loadContext, saveContext } from "../lib/context.mjs";

// --- deref: resolving refs in an untrusted document -------------------------

test("deref resolves a normal $ref", () => {
  const doc = { components: { schemas: { Piece: { type: "object", properties: { id: { type: "integer" } } } } } };
  const r = deref(doc, { $ref: "#/components/schemas/Piece" });
  assert.equal(r.type, "object");
  assert.equal(r.properties.id.type, "integer");
});

test("deref DEGRADES a dangling $ref to {} instead of undefined", () => {
  // Fixed 2026-08-15: an unresolvable ref (a spec referencing a model it never
  // defines) returned undefined, handing downstream code a value it did not
  // expect. It now degrades to an empty schema, which authorises nothing.
  const r = deref({ components: { schemas: {} } }, { $ref: "#/components/schemas/Nope" });
  assert.deepEqual(r, {}, "a dangling ref must not become undefined");
});

test("deref stops on a $ref cycle instead of looping forever", () => {
  const doc = { components: { schemas: {
    A: { properties: { b: { $ref: "#/components/schemas/B" } } },
    B: { properties: { a: { $ref: "#/components/schemas/A" } } },
  } } };
  const started = Date.now();
  const r = deref(doc, { $ref: "#/components/schemas/A" });
  assert.ok(Date.now() - started < 1000, "a cycle must not hang");
  assert.equal(typeof r, "object");
});

// --- shapeOf / shapeHash: describing an untrusted response ------------------

test("shapeOf is depth-bounded and does not overflow on deep nesting", () => {
  // Fixed 2026-08-15: unbounded recursion blew the stack on a deeply-nested
  // response, and shapeHash runs on every response the drift detector sees.
  let deep = 1; for (let i = 0; i < 20_000; i += 1) deep = { x: deep };
  assert.doesNotThrow(() => shapeHash(deep), "a deeply-nested body must not crash the hasher");
  assert.ok(JSON.stringify(shapeOf(deep)).length < 200, "the shape is summarised past the cap, not descended");
});

test("shapeOf handles bare and empty values", () => {
  assert.equal(shapeOf(null), "null");
  assert.equal(shapeOf("s"), "string");
  assert.equal(shapeOf(42), "number");
  assert.deepEqual(shapeOf([]), []);
  assert.deepEqual(shapeOf({ a: 1, b: "x" }), { a: "number", b: "string" });
});

test("shapeHash is deterministic and structural, not value-sensitive", () => {
  assert.equal(shapeHash({ a: 1, b: "x" }), shapeHash({ a: 999, b: "different" }),
    "the same SHAPE hashes the same regardless of values");
  assert.notEqual(shapeHash({ a: 1 }), shapeHash({ a: 1, b: 2 }));
});

test("rowsOf finds the collection under common envelope keys", () => {
  assert.deepEqual(rowsOf([1, 2]), [1, 2]);
  assert.deepEqual(rowsOf({ data: [1] }), [1]);
  assert.deepEqual(rowsOf({ results: [2] }), [2]);
  assert.equal(rowsOf({ nope: [1] }), null);
});

// --- save/load: a __proto__ operation key must not pollute -----------------

test("a __proto__ operation key round-trips without polluting Object.prototype", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-proto-"));
  const ctx = emptyContext({ name: "t", contractPath: "x", contractDigest: "d" });
  ctx.operations = JSON.parse('{"__proto__":{"polluted":true},"GET /x":{"notes":["ok"]}}');
  saveContext(dir, ctx);
  loadContext(dir);
  assert.notEqual(({}).polluted, true, "loading a crafted context must not pollute the prototype");
});
