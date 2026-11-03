import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { importPostman, importPostmanV3, importInsomnia, importBruno, importKong, renderImportReport } from "../lib/import.mjs";
import { secretIn } from "../lib/verdicts.mjs";

const fixture = (name) => readFileSync(new URL(`./fixtures/robustness/${name}`, import.meta.url), "utf8");
const json = (name) => JSON.parse(fixture(name));
const named = (error) => error instanceof Error && error.constructor === Error && typeof error.code === "string" && !/Maximum call stack/.test(error.message);

test("ROB-1 malformed Postman variable field fails by name", () => {
  assert.throws(() => importPostman(json("import-postman-malformed-field.json")), named);
});
test("ROB-1 malformed Insomnia header fails by name", () => {
  assert.throws(() => importInsomnia(json("import-insomnia-null-header.json")), named);
});
test("ROB-1 unknown Insomnia document type reports the location and rule without repeating input", () => {
  assert.throws(() => importInsomnia(json("import-insomnia-type-input.json")), (error) => {
    assert.ok(named(error));
    assert.match(error.message, /document.*type|type.*supported/i);
    assert.ok(!JSON.stringify({ message: error.message, ...error }).includes("ROB1_ENV_VALUE_DO_NOT_PROMOTE"));
    return true;
  });
});
test("ROB-1 valid Kong import renders a declared report without runnable suite instructions", () => {
  const result = importKong(json("import-kong-report.json"));
  const text = renderImportReport(result.report);
  assert.match(text, /1 declared/);
  assert.doesNotMatch(text, /undefined|suite run/);
});
test("ROB-1 Insomnia environment document renders names only without runnable suite instructions", () => {
  const result = importInsomnia(json("import-insomnia-environment.json"));
  const text = renderImportReport(result.report);
  assert.match(text, /environment document/i);
  assert.match(text, /apiKey/);
  assert.doesNotMatch(text, /ROB1_ENV_VALUE_DO_NOT_PROMOTE|undefined|suite run/);
});
test("ROB-1 missing Bruno method and Postman v3 item array fail by name", () => {
  assert.throws(() => importBruno(fixture("import-bruno-empty.bru")), named);
  assert.throws(() => importPostmanV3({}), named);
});
test("ROB-1 deeply nested parsed input is refused before recursive walkers", () => {
  assert.throws(() => importKong(json("import-kong-deep.json")), (error) => named(error) && /depth/.test(error.message));
});
test("ROB-1 cyclic Insomnia parent references fail by name within the worker deadline", async () => {
  const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
    import(workerData.module).then(({ importInsomnia }) => {
      try { importInsomnia(workerData.input); parentPort.postMessage({ result: true }); }
      catch (error) { parentPort.postMessage({ name: error.name, code: error.code, message: error.message }); }
    });`, { eval: true, workerData: { module: new URL("../lib/import.mjs", import.meta.url).href, input: json("import-insomnia-parent-cycle.json") } });
  let timer;
  try {
    const output = await Promise.race([
      new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("ROB-1 parent-cycle worker exceeded 2 s")), 2000); }),
    ]);
    assert.equal(output.name, "Error");
    assert.equal(typeof output.code, "string");
    assert.match(output.message, /cycle|parent/i);
  } finally { clearTimeout(timer); await worker.terminate(); }
});

test("ROB-1 an authorization-scheme value never enters a suite, whatever the header is called", () => {
  // Found by the variation harness (seed 1, postman.json, byte-substitution, index 2): a
  // corrupted header NAME slipped a bearer token past the name-based credential rules.
  const result = importPostman(json("import-postman-renamed-auth-header.json"));
  const surfaces = JSON.stringify({ suite: result.suite, todo: result.todo, report: result.report }) + renderImportReport(result.report);
  assert.doesNotMatch(surfaces, /ROB1_AUTH_VALUE_7f4d9a|Uk9CMV9BVVRI/, "a literal token crossed into an output surface");
  assert.equal(result.suite.requests.length, 0, "omitting authentication must quarantine the request");
  const step = result.todo[0];
  assert.equal(step.headers?.["X-Session"], undefined, "the custom-named bearer header was copied");
  assert.equal(step.headers?.["Accept"], "application/json", "an ordinary header still copies");
  // A template reference is not a value: the scanner must leave it alone so a
  // collection that references its token by name keeps that header.
  assert.equal(secretIn("Bearer {{sessionToken}}"), null);
  assert.equal(typeof secretIn("Bearer ROB1_AUTH_VALUE_7f4d9a"), "string");
  assert.equal(secretIn("a basic understanding of digest authentication"), null, "prose never trips the scheme rule");
  assert.ok(result.report.notes?.some?.((n) => /X-Session/.test(n)) || JSON.stringify(result.report).includes("X-Session"),
    "the omission is reported by header name");
});
