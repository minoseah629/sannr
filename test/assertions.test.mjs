// Unit tests for the assertion engine. node --test test/assertions.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { atPath, checkOne, runAssertions } from "../lib/assertions.mjs";
import { assertionSchema } from "../lib/request-input-schema.mjs";
import { driftFrom } from "../lib/verify.mjs";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ctx = {
  status: 201,
  headers: { "x-request-id": "abc123", location: "/operations/op_1" },
  body: { id: 48, status: "idea", title: "A piece", items: [{ n: 1 }, { n: 2 }], nested: { deep: true } },
};

test("atPath walks objects, arrays, and misses", () => {
  assert.equal(atPath(ctx.body, "id"), 48);
  assert.equal(atPath(ctx.body, "nested.deep"), true);
  assert.equal(atPath(ctx.body, "items.1.n"), 2);
  assert.equal(atPath(ctx.body, "items.9.n"), undefined);
  assert.equal(atPath(ctx.body, "nope.deeper"), undefined);
});

test("status shorthand compares the actual status and fails mismatches", () => {
  for (const [expected, passed, failed] of [[201, 1, 0], [200, 0, 1]]) {
    const result = runAssertions([{ status: expected }], ctx);
    assert.equal(result.passed, passed, "status " + expected);
    assert.equal(result.failed, failed, "status " + expected);
  }
});

test("every operator behaves", () => {
  const r = runAssertions([
    { json: "status", equals: "idea" },
    { json: "status", not_equals: "shipped" },
    { json: "id", exists: true },
    { json: "missing", exists: false },
    { json: "status", in: ["idea", "outlined"] },
    { json: "title", matches: "^A " },
    { json: "id", gt: 10 },
    { json: "id", lt: 100 },
    { json: "items", length: 2 },
    { header: "x-request-id", equals: "abc123" },
  ], ctx);
  assert.equal(r.failed, 0, JSON.stringify(r.failures));
  assert.equal(r.passed, 10);
});

test("JSON equality compares structure without coercion or ignoring array order", () => {
  const response = { status: 200, headers: {}, body: {
    blockers: [], config: { enabled: true, limits: [1, { max: 2 }] }, count: 2, value: null,
  } };
  const matching = runAssertions([
    { json: "blockers", equals: [] },
    { json: "config", equals: { limits: [1, { max: 2 }], enabled: true } },
    { json: "config", not_equals: { enabled: true, limits: [{ max: 2 }, 1] } },
    { json: "count", not_equals: "2" },
    { json: "value", equals: null },
  ], response);
  assert.equal(matching.passed, 5); assert.equal(matching.failed, 0);
  const mismatching = runAssertions([
    { json: "blockers", not_equals: [] },
    { json: "blockers", equals: {} },
    { json: "config", equals: { enabled: true, limits: [1, { max: "2" }] } },
    { json: "config", equals: { enabled: true } },
    { json: "missing", equals: null },
  ], response);
  assert.equal(mismatching.failed, 5); assert.equal(mismatching.passed, 0);
  assert.deepEqual(mismatching.failures[0], {
    target: "json", path: "blockers", op: "not_equals", expected: [], actual: [],
  });
});

test("failures report target, op, expected and actual", () => {
  const r = runAssertions([{ json: "status", equals: "shipped" }], ctx);
  assert.equal(r.failed, 1);
  assert.deepEqual(r.failures[0], {
    target: "json", path: "status", op: "equals", expected: "shipped", actual: "idea",
  });
});

test("a missing value reports null rather than vanishing", () => {
  const r = runAssertions([{ json: "nope", equals: 1 }], ctx);
  assert.equal(r.failures[0].actual, null);
});

test("missing, misspelled and stray operators fail closed, including path-equals-value traps", () => {
  const context = { status: 200, headers: {}, body: { state: "state", x: 1 } };
  for (const [clause, reason] of [
    [{ json: "state", eqauls: "state" }, /unknown operator 'eqauls'/],
    [{ json: "state", equal: "state" }, /unknown operator 'equal'/],
    [{ json: "state" }, /needs an operator/],
    [{ json: "x", equals: 1, equal: 2 }, /did you mean one of equals, not_equals/],
    [{ status: 200, foo: 1 }, /unknown operator 'foo'/],
  ]) {
    const label = JSON.stringify(clause), direct = checkOne(clause, context);
    assert.equal(direct.ok, false, label); assert.equal(direct.op, "invalid", label);
    assert.match(direct.error, reason, label);
    const aggregate = runAssertions([clause], context);
    assert.equal(aggregate.failed, 1, label); assert.equal(aggregate.passed, 0, label);
    assert.equal(aggregate.failures[0].op, "invalid", label);
  }
});

test("an invalid regex fails closed instead of throwing", () => {
  const r = runAssertions([{ json: "title", matches: "([" }], ctx);
  assert.equal(r.failed, 1);
  assert.equal(r.failures[0].op, "invalid");
});

test("no expect clause means no assertion block at all", () => {
  assert.equal(runAssertions(undefined, ctx), null);
  assert.equal(runAssertions([], ctx), null);
});

test("huge actual values are truncated in the failure report", () => {
  const big = { status: 200, headers: {}, body: { blob: "x".repeat(5000) } };
  const r = runAssertions([{ json: "blob", equals: "y" }], big);
  assert.ok(String(r.failures[0].actual).length < 300);
});

// --- R3-B (2026-09-16): a clause carrying several operators asserts all of them.
// `ops[0]` alone made {json:"count", gt:0, lt:3} pass on count=10: a green check
// for a false claim, inside the engine that exists to refuse exactly that.
const body = (b) => ({ status: 200, headers: {}, body: b });

test("a conjunction evaluates all operators, counts one clause and reports the first failure", () => {
  const clause = { json: "count", gt: 0, lt: 3 };
  for (const [count, ok, op, expected] of [[2, true, "gt+lt", { gt: 0, lt: 3 }], [0, false, "gt", 0], [10, false, "lt", 3]]) {
    const context = body({ count }), label = "count=" + count;
    assert.deepEqual(checkOne(clause, context), {
      ok, target: "json", path: "count", op, expected, actual: count, ops: ["gt", "lt"],
    }, label);
    const result = runAssertions([clause], context);
    assert.equal(result.passed, Number(ok), label); assert.equal(result.failed, Number(!ok), label);
    if (!ok) assert.deepEqual(result.failures, [{
      target: "json", path: "count", op, expected, actual: count, ops: ["gt", "lt"],
    }], label);
  }
});

test("type + matches, type + length, and a header clause all conjoin", () => {
  assert.equal(checkOne({ json: "name", type: "string", matches: "^a" }, body({ name: "alpha" })).ok, true);
  const wrongPrefix = checkOne({ json: "name", type: "string", matches: "^a" }, body({ name: "beta" }));
  assert.equal(wrongPrefix.ok, false);
  assert.equal(wrongPrefix.op, "matches");
  const wrongType = checkOne({ json: "name", type: "string", matches: "^a" }, body({ name: 7 }));
  assert.equal(wrongType.ok, false);
  assert.equal(wrongType.op, "type");   // a number is not a string, and matches never saw it
  assert.equal(checkOne({ json: "tags", type: "array", length: 2 }, body({ tags: ["a", "b"] })).ok, true);
  assert.equal(checkOne({ json: "tags", type: "array", length: 2 }, body({ tags: ["a"] })).ok, false);
  assert.equal(checkOne({ header: "x-request-id", type: "string", length: 6 }, ctx).ok, true);
  assert.equal(checkOne({ header: "x-request-id", type: "string", length: 7 }, ctx).op, "length");
});

test("a status range clause evaluates every operator against the status", () => {
  const range = { status: true, gt: 199, lt: 300 };
  assert.equal(checkOne(range, { status: 204, headers: {}, body: {} }).ok, true);
  const missed = checkOne(range, { status: 404, headers: {}, body: {} });
  assert.equal(missed.ok, false);
  assert.equal(missed.target, "status");
  assert.equal(missed.op, "lt");
  assert.equal(missed.actual, 404);
  assert.equal(checkOne(range, { status: 100, headers: {}, body: {} }).op, "gt");
});

test("an operator that cannot be evaluated is raised, not skipped by an earlier answer", () => {
  // type passes first; matches over an oversized input can only refuse. Skipping
  // it because type already answered is how the clause used to come back green.
  const r = runAssertions([{ json: "x", type: "string", matches: "a+$" }],
                          body({ x: "a".repeat(5000) + "!" }));
  assert.equal(r.failed, 1);
  // The refusal keeps the clause's own coordinates: which target, which path,
  // which operator could not run. It used to surface as a clause-level
  // `op:"invalid"` that echoed the whole clause into `expected`.
  assert.equal(r.failures[0].target, "json");
  assert.equal(r.failures[0].path, "x");
  assert.equal(r.failures[0].op, "matches");
  assert.deepEqual(r.failures[0].refused_ops, ["matches"]);
  assert.equal(r.failures[0].code, "ASSERTION_INPUT_OVERSIZED");
});

test("a single-operator result keeps its exact shape, with no ops key", () => {
  const r = checkOne({ json: "id", gt: 10 }, ctx);
  assert.deepEqual(r, { ok: true, target: "json", path: "id", op: "gt", expected: 10, actual: 48 });
  assert.equal("ops" in r, false);
  assert.equal("ops" in checkOne({ status: 201 }, ctx), false);
  assert.equal("ops" in runAssertions([{ json: "status", equals: "shipped" }], ctx).failures[0], false);
});

test("a later operator's refusal survives an earlier operator's failure", () => {
  // `equals` already failed, so a short-circuiting engine never reaches
  // `matches` and nothing in the output would differ. The clause-level code and
  // `refused_ops` are the witness that every operator really was evaluated —
  // and the author's own failure is still the one named, not the engine's limit.
  const oversized = body({ s: "a".repeat(5000) });
  const r = runAssertions([{ json: "s", equals: "x", matches: "^a" }], oversized);
  assert.equal(r.failed, 1);
  const [f] = r.failures;
  assert.equal(f.op, "equals");            // the FIRST failing operator
  assert.equal(f.expected, "x");           // ...and ITS expected value
  assert.equal(f.target, "json");
  assert.equal(f.path, "s");
  assert.deepEqual(f.ops, ["equals", "matches"]);
  assert.deepEqual(f.refused_ops, ["matches"]);   // evaluated, refused, reported
  assert.equal(f.code, "ASSERTION_INPUT_OVERSIZED");
  assert.ok(String(f.actual).length < 300, "the value is truncated like any other");
});

test("the first failing operator is named when a later one fails too", () => {
  // A control, green before this round as well: without a refusal, a
  // short-circuiting engine produces the same output, because `ops` comes from
  // the clause rather than the evaluation. The test above is the one that bites.
  const r = checkOne({ json: "tags", gt: 0, length: 2 }, body({ tags: ["a"] }));
  assert.equal(r.ok, false);
  assert.equal(r.op, "gt");
  assert.deepEqual(r.ops, ["gt", "length"]);
  assert.equal("refused_ops" in r, false);
});

// --- the advertised grammar is the grammar the engine runs -------------------
// A validator for exactly the keywords assertionSchema uses. The keyword guard
// below fails if the schema grows one this does not implement, so the pin can
// never quietly stop checking what it claims to check.
const SCHEMA_KEYWORDS = new Set(["type", "enum", "properties", "required", "maxProperties",
  "additionalProperties", "allOf", "anyOf", "oneOf", "not", "description", "minimum"]);
function schemaAccepts(schema, value) {
  if (schema.type === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) return false;
  if (schema.type === "integer" && !Number.isInteger(value)) return false;
  if (schema.type === "string" && typeof value !== "string") return false;
  if (schema.type === "array" && !Array.isArray(value)) return false;
  if (schema.minimum !== undefined && !(typeof value === "number" && value >= schema.minimum)) return false;
  if (schema.enum && !schema.enum.some((e) => e === value)) return false;
  if (schema.required && !schema.required.every((k) => Object.hasOwn(value, k))) return false;
  if (schema.maxProperties !== undefined && Object.keys(value).length > schema.maxProperties) return false;
  if (schema.properties) for (const [k, sub] of Object.entries(schema.properties))
    if (Object.hasOwn(value, k) && !schemaAccepts(sub, value[k])) return false;
  if (schema.additionalProperties === false && schema.properties)
    for (const k of Object.keys(value)) if (!Object.hasOwn(schema.properties, k)) return false;
  if (schema.allOf && !schema.allOf.every((s) => schemaAccepts(s, value))) return false;
  if (schema.anyOf && !schema.anyOf.some((s) => schemaAccepts(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((s) => schemaAccepts(s, value)).length !== 1) return false;
  if (schema.not && schemaAccepts(schema.not, value)) return false;
  return true;
}

test("the advertised assertion grammar uses only keywords this pin evaluates", () => {
  const seen = new Set();
  (function walk(node, inProperties) {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach((x) => walk(x, false));
    for (const [k, v] of Object.entries(node)) {
      if (!inProperties) seen.add(k);
      walk(v, k === "properties");
    }
  })(assertionSchema, false);
  assert.deepEqual([...seen].filter((k) => !SCHEMA_KEYWORDS.has(k)), [],
    "assertionSchema grew a keyword schemaAccepts() does not implement");
});

test("the advertised grammar accepts what the engine conjoins, including the marker", () => {
  for (const clause of [
    { status: 200 },
    { json: "x", equals: 1 },
    { json: "count", gt: 0, lt: 3 },                 // the conjunction the engine runs
    { status: true, not_equals: 500 },               // the marker form (R3-C emits it)
    { status: true, gt: 199, lt: 300 },
    { header: "content-type", exists: true, matches: "^.*json.*$" },
  ]) {
    assert.ok(schemaAccepts(assertionSchema, clause),
      `the schema rejects a clause the engine checks: ${JSON.stringify(clause)}`);
    // and the engine really does treat it as a clause, not a refusal
    if (!("status" in clause) || Object.keys(clause).length > 1)
      assert.notEqual(checkOne(clause, { status: 200, headers: { "content-type": "application/json" },
        body: { x: 1, count: 2 } }).op, "invalid", `the engine refuses ${JSON.stringify(clause)}`);
  }
});

test("the advertised grammar still refuses what the engine refuses", () => {
  for (const clause of [
    { json: "x" },                       // no operator
    { json: "x", equals: 1, equal: 2 },  // stray key
    { status: true },                    // a selector that selects for nobody
    { json: "x", status: 200, equals: 1 },  // two targets
    { status: 200, gt: 100 },            // an integer status is the claim, not a selector
  ]) assert.equal(schemaAccepts(assertionSchema, clause), false,
    `the schema advertises a clause the engine does not honour: ${JSON.stringify(clause)}`);
});

test("a drift record names every operator of a multi-operator clause", () => {
  const drift = driftFrom([{ name: "s", steps: [{ id: "1", op: "GET /things", ok: false,
    failures: [{ target: "json", path: "count", op: "lt", ops: ["gt", "lt"], expected: 3, actual: 10 },
               { target: "json", path: "id", op: "equals", expected: 1, actual: 2 }] }] }]);
  assert.equal(drift[0].check, "lt");
  assert.deepEqual(drift[0].checks, ["gt", "lt"]);
  assert.equal("checks" in drift[1], false, "a single-operator record is unchanged");
});

// --- end to end: what `suite run` PRINTS ------------------------------------
// The engine carried `ops`; the report read only `op` and showed a two-operator
// clause as a single `lt` check. This runs the real CLI against a real server,
// because the renderer is the surface a person and an agent actually read.
const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "cli.mjs");
const execFileP = promisify(execFile);

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "assert-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}
// `suite run` fetches from a server in THIS process, so the CLI must run async.
async function cliRun(dir, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileP("node", [CLI, ...args], { cwd: dir, encoding: "utf8",
      env: { ...process.env, API_USAGE_LOG: "/dev/null", API_CONTEXT_OFF: "1",
             API_EVIDENCE: join(dir, "evidence"), ...env } });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) { return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}
const countingApi = () => new Promise((resolve) => {
  const srv = createServer((_req, res) => {
    const buf = Buffer.from(JSON.stringify({ count: 10 }));
    res.writeHead(200, { "content-type": "application/json", "content-length": buf.length });
    res.end(buf);
  });
  srv.listen(0, "127.0.0.1", () => resolve({ origin: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }));
});

test("committed single and multi-operator failures preserve their distinct CLI and JSON reports", async t => {
  const api = await countingApi(), dir = sandbox(t);
  t.after(() => api.close());
  const suite = { v: 2, requests: [
    { id: "multi", method: "GET", path: "/things", expect: [{ json: "count", gt: 0, lt: 3 }] },
    { id: "single", method: "GET", path: "/things", expect: [{ json: "count", lt: 3 }] },
  ] };
  execFileSync(process.execPath, [CLI, "suite", "save", "checks"],
    { cwd: dir, input: JSON.stringify(suite), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const human = await cliRun(dir, ["suite", "run", "checks"], { API_BASE_URL: api.origin });
  assert.equal(human.code, 1, human.out); assert.match(human.out, /0\/2/);
  assert.ok(human.out.includes("json count gt+lt: lt failed — expected 3, actual 10"), human.out);
  const line = human.out.split("\n").find(line => line.includes("json count lt:"));
  assert.ok(line?.includes("json count lt: expected 3, actual 10"), human.out);
  assert.ok(!line.includes("failed —"), "single checks have no multi-operator decoration");
  const json = await cliRun(dir, ["suite", "run", "checks", "--json"], { API_BASE_URL: api.origin });
  assert.equal(json.code, 1, json.out);
  const [multi, single] = JSON.parse(json.out).suites[0].steps;
  assert.deepEqual(multi.failures[0].ops, ["gt", "lt"]);
  assert.equal("ops" in single.failures[0], false);
});
