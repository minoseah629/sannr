import { test } from "node:test";
import assert from "node:assert/strict";
import { importPostman, translateTests, stableStringify } from "../lib/import.mjs";

test("B1-C translates generated assertions and quarantines stateful scripts", () => {
  const translated = translateTests([
    'pm.test("status", () => { const jsonData = pm.response.json(); pm.response.to.have.status(200); pm.expect(jsonData.id).to.exist; });',
    'pm.test("state", () => { pm.collectionVariables.set("id", pm.response.json().id); });',
  ]);
  assert.deepEqual(translated.expect, [{ status: 200 }, { json: "id", exists: true }]);
  assert.match(translated.quarantined[0].reason, /^Postman variable state does not have faithful suite semantics/);
  assert.equal(translated.prerequisites[0].executable, false);
  assert.equal(translated.manual.length, 1, 'the unsupported block does not taint the translated block');
  assert.equal(translated.translatedByPattern.status, 1);
  assert.equal(translated.translatedByPattern.json, 1);
});

test("quarantine is per-script, named, located, and never executes source", () => {
  const collection = { info: { name: "Scripts" }, item: [{ name: "x", request: { method: "GET", url: "/x" }, event: [
    { listen: "prerequest", script: { exec: ["throw new Error('must not run')"] } },
    { listen: "test", script: { exec: ["pm.test('x', () => { pm.environment.set('x', 'value'); });"] } },
  ] }] };
  const out = importPostman(collection, { sourceText: JSON.stringify(collection) });
  assert.equal(out.report.counts.scripts_quarantined.filter((row) => row.source !== "request shape").length, 2);
  assert.equal(out.suite.requests.length, 0);
  assert.match(out.todo[0].todo, /no assertion translatable or derivable/);
  assert.ok(out.todo[0].prerequisites.some(row => row.kind === "request-setup" && row.status === "unverified" && row.executable === false));
  assert.ok(out.report.counts.scripts_quarantined.every((q) => q.script.includes("x" ) && q.source));
  assert.equal(stableStringify(out).includes("must not run"), false);
});

test("B1-C recognizes headers, response-json preludes, chained type checks, and preserves per-assertion translation", () => {
  const out = translateTests([
    'pm.test("shape", () => {',
    '  pm.response.to.have.status(200);',
    '  pm.expect(pm.response.headers.get("Content-Type")).to.include("application/json");',
    '  const responseData = pm.response.json();',
    "  pm.expect(responseData.id).to.exist.and.to.be.a('string');",
    "  pm.expect(responseData.items).to.be.an('array');",
    '  pm.expect(responseData.kind).to.eql("chat");',
    '  pm.expect(responseData.unknown).to.be.deep.equal({});',
  ]);
  assert.deepEqual(out.expect, [
    { status: 200 },
    { header: "Content-Type", matches: "^.*application/json.*$" },
    { json: "id", exists: true },
    { json: "id", type: "string" },
    { json: "items", type: "array" },
    { json: "kind", equals: "chat" },
  ]);
  assert.equal(out.manual.length, 1);
  assert.match(out.quarantined[0].reason, /unrecognized/);
});

test("multi-statement loops remain quarantined and do not leak inner assertions", () => {
  const out = translateTests([
    'pm.test("loop", () => { const responseData = pm.response.json(); responseData.items.forEach((item) => { pm.expect(item.id).to.exist; }); });',
  ]);
  assert.deepEqual(out.expect, []);
  assert.match(out.quarantined[0].reason, /loop execution is outside the static grammar/);
  assert.equal(out.construct_ledger.filter((row) => row.disposition === "translated").length, 0);
});
