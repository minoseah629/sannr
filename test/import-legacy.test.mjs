import { test } from "node:test";
import assert from "node:assert/strict";
import { importPostman } from "../lib/import.mjs";

test("legacy Postman assignments import mechanical checks with inferred provenance beside them", () => {
  const collection = { info: { name: "Legacy" }, item: [{ name: "orders", request: { method: "GET", url: "/orders" }, event: [{ listen: "test", script: { exec: [
    'tests["status"] = responseCode.code === 200;',
    'tests["body"] = responseBody.includes("ready");',
    'tests["header"] = responseHeaders["X-Request-Id"] !== undefined;',
    "tests[\"slow\"] = responseTime > 500;",
  ] } }] }] };
  const out = importPostman(collection);
  assert.deepEqual(out.suite.requests[0].expect, [
    { status: 200 }, { header: "X-Request-Id", exists: true },
  ]);
  assert.deepEqual(out.suite.requests[0].assertion_provenance, ["translated", "translated"]);
  assert.equal(out.report.counts.dialects.legacy.translated, 2);
  assert.match(out.report.items[0].notes.join(" "), /reported-only legacy/);
  assert.ok(out.report.counts.scripts_quarantined.some((entry) => entry.script.endsWith(":body")), "raw response text cannot be faithfully checked against decoded JSON");
});

test("legacy environment mutation is named and never executed", () => {
  const collection = { info: { name: "Legacy" }, item: [{ name: "x", request: { method: "GET", url: "/x" }, event: [{ listen: "test", script: { exec: ['postman.setEnvironmentVariable("x", "value");'] } }] }] };
  const out = importPostman(collection);
  assert.equal(out.suite.requests.length, 0);
  assert.match(out.todo[0].todo, /no assertion/);
  assert.match(out.report.counts.scripts_quarantined[0].reason, /environment mutation/);
});

test("legacy environment mutation remains named beside translated assertions", () => {
  const collection = { info: { name: "Legacy" }, item: [{ name: "x", request: { method: "GET", url: "/x" }, event: [{ listen: "test", script: { exec: [
    'tests["status"] = responseCode.code === 200;',
    'postman.setEnvironmentVariable("token", "value");',
  ] } }] }] };
  const out = importPostman(collection);
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.match(out.report.counts.scripts_quarantined[0].script, /postman\.setEnvironmentVariable\(token\)/);
  assert.match(out.report.counts.scripts_quarantined[0].reason, /variable state/);
});
