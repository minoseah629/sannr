// The map states what it measured, and never calls itself complete.
//
//   node --test test/map-coverage.test.mjs
//
// The map used to print "map complete" the moment rendering finished, and its
// empty states read "Every probed operation matched its contract." with ZERO
// operations probed — vacuously true, and indistinguishable from a verified
// all-clear on a repo whose server was never reachable. The missing number was
// the denominator: how much of the contract was actually put to the server.
// `probe()` measured requests (`checked`), not operations, and `footprintModel`
// dropped even that, so no renderer COULD state coverage.
//
// What is pinned here: the one coverage sentence every view shares, the
// difference between "nothing answered" and "nothing was asked", the refusal to
// invent a zero for a model that never recorded coverage, and the distinction
// between a request and an operation — one documented operation is probed up to
// three times, so `checked` divided by the declared count would overstate what
// was covered.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { footprintModel, renderMapText, renderMapHtml, coverageStatement } from "../lib/map.mjs";
import { recordViewModel } from "../lib/view-records.mjs";
import { buildViewModel, renderViewHtml } from "../lib/view.mjs";
import { renderMapReceipt } from "../lib/map-terminal.mjs";
import { terminalTheme } from "../lib/terminal.mjs";
import { probe } from "../lib/audit.mjs";
import { LAYOUT } from "../lib/layout.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const withoutAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");
// A developer's API override must never redirect these loopback probes.
const inheritedApiEnv = Object.entries(process.env).filter(([key]) => /^(API_|SANNR_)/.test(key));
for (const [key] of inheritedApiEnv) delete process.env[key];
after(() => { for (const [key, value] of inheritedApiEnv) process.env[key] = value; });
const execAsync = promisify(execFile);

async function loopbackProbe(t, paths, respond) {
  const dir = mkdtempSync(join(tmpdir(), "map-comparison-"));
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url);
    const { status = 200, body = {}, headers = {}, raw } = respond(req.url);
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(raw ?? JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "openapi.json"), JSON.stringify({
    openapi: "3.0.0", info: { title: "comparison" }, paths,
  }));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${server.address().port}` } },
  }));
  const surface = svc("comparison", { dir, contract: join(dir, "openapi.json"),
    declared: Object.values(paths).reduce((n, methods) => n + Object.keys(methods).length, 0) });
  const result = await probe(surface);
  const model = mapOf([{ ...surface, ...result }], { probe_execution: "executed" });
  return { dir, hits, result, model };
}

async function cliMap(dir) {
  // Async children leave the parent event loop free to answer fixture requests.
  const { stdout } = await execAsync(process.execPath, [CLI, "map", ".", "--json"], { cwd: dir });
  await execAsync(process.execPath, [CLI, "map", ".", "--out", "./cli.html"], { cwd: dir });
  return { model: JSON.parse(stdout), html: readFileSync(join(dir, "cli.html"), "utf8") };
}

// The claims this slice exists to remove. A renderer may never emit any of
// them again, in any view, however few operations it probed.
const COMPLETENESS_CLAIMS = [/map complete/i, /MAP COMPLETE/, /Every probed operation matched its contract\./];

// An audited-surface-shaped service, as auditSurface returns one: coverage
// counts included, because that is the shape footprintModel now reads.
const svc = (name, over = {}) => ({
  name, dir: `/repo/${name}`, kind: "documented", declared: 100,
  repo: name, owner: "ana", ownerSource: "git",
  reachable: null, attempted: 0, checked: 0, operations_probed: 0,
  findings: [], shadowRoutes: [], shadowCount: 0, ...over,
});

const mapOf = (surfaces, extra = {}) => ({
  ...footprintModel({ root: "/repo", surfaces, edges: [], external: [], platform: [] }), ...extra,
});

// The three views of one model, as a reader meets them.
const views = (model, options = {}) => ({
  text: renderMapText(model),
  html: renderMapHtml(model),
  receipt: withoutAnsi(renderMapReceipt(model,
    { out: ("/" + "tmp/footprint.html"), theme: terminalTheme({ stream: { isTTY: false, columns: 100 }, env: {} }), ...options })),
});

function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd }) };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
}

test("a map that probed nothing states its coverage and never calls itself complete", () => {
  const rendered = views(mapOf([svc("gateway")], { probe_execution: "executed" }));
  for (const [view, output] of Object.entries(rendered)) {
    assert.match(output, /0 of 100 documented operations probed/,
      `the ${view} view must state the denominator it measured against`);
    for (const claim of COMPLETENESS_CLAIMS)
      assert.doesNotMatch(output, claim, `the ${view} view still claims completeness (${claim})`);
  }
  assert.match(rendered.html, /nothing here is verified/,
    "the findings section must say why it is empty, not that everything agreed");
  assert.match(rendered.html, /Point the map at a reachable base URL/,
    "…and what would make it verifiable");
});

test("a partly probed map states how much it covered, in the summary and the empty findings", () => {
  const rendered = views(mapOf([svc("gateway", { reachable: true, attempted: 5, checked: 7, operations_probed: 3 })],
    { probe_execution: "executed" }));
  for (const [view, output] of Object.entries(rendered))
    assert.match(output, /3 of 100 documented operations probed/, `the ${view} view lost the coverage it measured`);
  assert.match(rendered.html, /Every probed operation matched its contract \(3 of 100 documented operations probed\)\./,
    "an empty findings list is a statement about the 3 probed, never about the other 97");
  assert.doesNotMatch(rendered.html, /Every probed operation matched its contract\./,
    "the unqualified sentence is the defect; it may not survive anywhere");
});

test("a model that never recorded coverage says so instead of inventing a zero", () => {
  // A map record retained before coverage existed, or any hand-built model.
  // "0 of 100 probed" would be a measurement claim about a run that never
  // reported one, which is the same class of lie as "complete".
  const model = mapOf([svc("gateway")]);
  delete model.summary.operations_probed;
  delete model.services[0].probe;
  const rendered = views(model);
  for (const [view, output] of Object.entries(rendered)) {
    assert.match(output, /probe coverage not recorded/, `the ${view} view must admit it does not know`);
    assert.doesNotMatch(output, /\d+ of \d+ documented operations probed/,
      `the ${view} view invented a coverage number`);
    for (const claim of COMPLETENESS_CLAIMS) assert.doesNotMatch(output, claim);
  }
  assert.equal(coverageStatement(model), "probe coverage not recorded");
});

test("a source-only scan says no request was executed, not that nothing disagreed", () => {
  // Zero probed has two causes and only the caller knows which: nothing
  // answered, or nothing was asked. --no-execute is the second.
  const model = mapOf([svc("gateway")], { probe_execution: "static" });
  const rendered = views(model);
  for (const [view, output] of Object.entries(rendered)) {
    assert.match(output, /source scan only — no requests executed/, `the ${view} view hid that it asked nothing`);
    assert.doesNotMatch(output, /0 of 100 documented operations probed/,
      `the ${view} view reported an unreachable server where none was contacted`);
  }
  assert.match(rendered.html, /No request was executed, so nothing here is verified/);
  assert.equal(coverageStatement({ summary: { operations: 4 } }, { noExecute: true }),
    "source scan only — no requests executed");
  assert.equal(coverageStatement({ summary: {} }, { noExecute: true }), "no documented operations to probe",
    "nothing declared outranks the mode everywhere: no request could have supplied a denominator");
});

test("coverage counts distinct operations, not the requests spent on them", async (t) => {
  // The real probe(), against a real server. One documented operation is
  // requested up to three times (bare GET, sampled id, id that cannot exist),
  // so `checked` is a request ledger and can exceed the operations covered.
  // A renderer dividing `checked` by the declared count would report 3 of 5.
  const dir = mkdtempSync(join(tmpdir(), "map-coverage-probe-"));
  const ok = { description: "ok", content: { "application/json": { schema: { type: "object" } } } };
  writeFileSync(join(dir, "openapi.json"), JSON.stringify({
    openapi: "3.0.0", info: { title: "coverage" },
    paths: {
      "/items": { get: { responses: { 200: ok } }, post: { responses: { 201: ok } } },
      "/items/{id}": { get: { responses: { 200: ok } }, put: { responses: { 200: ok } } },
      "/rooms/{a}/seats/{b}": { get: { responses: { 200: ok } } },
    },
  }));

  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(req.url.includes("nonexistent") ? 404 : 200, { "content-type": "application/json" });
    res.end(req.url === "/items" ? JSON.stringify([{ id: "a1" }]) : JSON.stringify({ id: "a1" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${server.address().port}` } },
  }));

  const result = await probe({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 5 });
  assert.equal(result.operations_probed, 2, "GET /items and GET /items/{id} answered; the other three were never asked");
  assert.ok(result.checked > result.operations_probed,
    `one operation was requested more than once (${result.checked} requests, ${result.operations_probed} operations)`);
  assert.equal(result.checked, seen.length, "every request the server saw is counted as a request");
  assert.ok(!seen.some((url) => url.startsWith("/rooms/")),
    "a two-parameter path is never probed, so it can never count as covered");
});

test("an operation reached only by the id-that-cannot-exist pass is not counted as covered", async (t) => {
  // probe()'s third pass asks for an id that cannot exist purely to see how the
  // service says "no", and says of itself that the 404 "proves nothing (never a
  // finding)". An operation reached ONLY that way was never compared against
  // the contract, so counting it would let the map say "every probed operation
  // matched its contract (2 of 2 probed)" about an operation it never checked.
  const dir = mkdtempSync(join(tmpdir(), "map-coverage-unsampled-"));
  const ok = { description: "ok", content: { "application/json": { schema: { type: "object" } } } };
  writeFileSync(join(dir, "openapi.json"), JSON.stringify({
    openapi: "3.0.0", info: { title: "venues" },
    paths: { "/venues": { get: { responses: { 200: ok } } },
      "/venues/{id}": { get: { responses: { 200: ok } } } },
  }));
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    // An EMPTY collection: no id can be sampled, so the templated operation is
    // only ever requested with the id that cannot exist.
    res.end(req.url === "/venues" ? "[]" : JSON.stringify({ detail: "absent" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    default: "local", environments: { local: { baseUrl: `http://127.0.0.1:${server.address().port}` } },
  }));

  const result = await probe({ dir, contract: join(dir, "openapi.json"), kind: "documented", declared: 2 });
  assert.deepEqual(seen, ["/venues", "/venues/x-audit-nonexistent-id"]);
  assert.equal(result.checked, 2, "both requests are counted as requests");
  assert.equal(result.operations_probed, 1, "only the operation whose response was compared counts as covered");
  assert.deepEqual(result.observed.map((o) => o.op), ["GET /venues"],
    "…which is exactly the operation the audit took a shape from");
});

for (const status of [401, 403, 429]) test(`bare ${status} answers a request without comparing the operation`, async (t) => {
  const { dir, result, model } = await loopbackProbe(t,
    { "/items": { get: { responses: { 200: { description: "ok" } } } } },
    () => ({ status, body: { error: "blocked" } }));
  assert.equal(result.checked, 1);
  assert.equal(result.reachable, true);
  assert.equal(result.operations_probed, 0);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.observed, []);
  const cli = await cliMap(dir);
  assert.equal(cli.model.summary.operations_probed, 0);
  // MAP-001: the default CLI is now a local projection. The legacy audit
  // comparison above still exercises this response; rendering does not repeat it.
  assert.equal(cli.model.services[0].probe.checked, 0);
  assert.equal(cli.model.probe_execution, "static");
  for (const html of [renderMapHtml(model)]) {
    assert.match(html, /0 of 1 documented operations probed/);
    assert.match(html, /Requests answered, but no operation was compared against its contract/);
    assert.doesNotMatch(html, /Every probed operation matched|Contract and server agree|Point the map at a reachable base URL/);
  }
});

for (const status of [302, 401, 403, 429]) test(`sampled ${status} does not increase comparison coverage`, async (t) => {
  const ok = { description: "ok" };
  const { dir, hits, result, model } = await loopbackProbe(t, {
    "/items": { get: { responses: { 200: ok } } },
    "/items/{id}": { get: { responses: { 200: ok } } },
  }, (url) => url === "/items" ? { body: [{ id: "one" }] }
    : url.includes("nonexistent") ? { status: 404, body: { error: "absent" } }
      : { status, body: { error: "blocked" }, headers: { location: "/elsewhere" } });
  assert.deepEqual(hits, ["/items", "/items/one", "/items/x-audit-nonexistent-id"]);
  assert.equal(result.checked, 3);
  assert.equal(result.operations_probed, 1);
  assert.deepEqual(result.observed.map((x) => x.op), ["GET /items"]);
  assert.deepEqual(result.findings, []);
  const cli = await cliMap(dir);
  assert.equal(cli.model.summary.operations_probed, 0);
  assert.equal(cli.model.services[0].probe.checked, 0);
  assert.equal(cli.model.probe_execution, "static");
  assert.match(cli.html, /source scan only/);
  for (const html of [renderMapHtml(model)]) {
    assert.match(html, /1 of 2 documented operations probed/);
    assert.doesNotMatch(html, /2 of 2 documented operations probed/);
  }
});

const jsonResponse = (schema) => ({ description: "ok", content: { "application/json": { schema } } });
for (const sampled of [false, true]) {
  for (const contractDeprecated of [false, true]) {
    test(`a ${sampled ? "sampled" : "bare"} explicit deprecation finding counts coverage (${contractDeprecated ? "contract" : "header"})`, async (t) => {
      const target = sampled ? "/items/{id}" : "/items";
      const paths = {
        ...(sampled ? { "/items": { get: { responses: { 200: { description: "ok" } } } } } : {}),
        [target]: { get: { deprecated: contractDeprecated, responses: { default: { description: "anything" } } } },
      };
      const { result, model } = await loopbackProbe(t, paths, (url) =>
        sampled && url === "/items" ? { body: [{ id: "one" }] }
          : url.includes("nonexistent") ? { status: 404 }
            : { headers: contractDeprecated ? {} : { deprecation: "true" } });
      assert.equal(result.checked, sampled ? 3 : 1);
      assert.equal(result.operations_probed, sampled ? 2 : 1);
      assert.deepEqual(result.findings.map(({ op, kind }) => ({ op, kind })),
        [{ op: `GET ${target}`, kind: "deprecated-but-live" }]);
      assert.doesNotMatch(renderMapHtml(model), /nothing here is verified|Every probed operation matched/);
    });
  }
}

for (const { name, responses, body = {}, raw, status = 200, expected, finding } of [
  { name: "missing responses", expected: 0 },
  { name: "empty responses", responses: {}, expected: 0 },
  { name: "default without a schema", responses: { default: { description: "anything" } }, expected: 0 },
  { name: "default empty schema", responses: { default: jsonResponse({}) }, expected: 0 },
  { name: "default unsupported-only schema", responses: { default: jsonResponse({ oneOf: [{ type: "object" }] }) }, expected: 0 },
  { name: "default shape with a null body", responses: { default: jsonResponse({ type: "object" }) }, body: null, expected: 0 },
  { name: "default shape with non-JSON bytes", responses: { default: jsonResponse({ type: "object" }) }, raw: "not-json", expected: 0 },
  { name: "declared status only", responses: { 200: { description: "ok" } }, expected: 1 },
  { name: "default supported shape", responses: { default: jsonResponse({ type: "object" }) }, expected: 1 },
  { name: "default inferred object shape", responses: { default: jsonResponse({ properties: { id: { type: "string" } } }) }, expected: 1 },
  { name: "default supported scalar shape", responses: { default: jsonResponse({ type: "string" }) }, body: "value", expected: 1 },
  { name: "status disagreement", responses: { 200: { description: "ok" } }, status: 201, expected: 1, finding: "status-mismatch" },
  { name: "schema disagreement", responses: { default: jsonResponse({ type: "object" }) }, body: [], expected: 1, finding: "schema-mismatch" },
]) test(`2xx coverage requires an actual comparison: ${name}`, async (t) => {
  const { result, model } = await loopbackProbe(t, { "/items": { get: { responses } } },
    () => ({ status, body, raw }));
  assert.equal(result.checked, 1);
  assert.equal(result.operations_probed, expected);
  assert.equal(model.summary.operations_probed, expected);
  if (finding) assert.ok(result.findings.some((x) => x.kind === finding));
  else assert.deepEqual(result.findings, []);
  if (!expected) {
    const html = renderMapHtml(model);
    assert.match(html, /nothing here is verified/);
    assert.doesNotMatch(html, /Every probed operation matched|Contract and server agree/);
  }
});

for (const [status, kind] of [[302, "redirect"], [404, "missing"], [503, "erroring"],
  [400, "required-param-optional"], [422, "required-param-optional"]]) {
  test(`a bare ${status} finding still counts its documented-operation comparison`, async (t) => {
    const { result } = await loopbackProbe(t, { "/items": { get: {
      parameters: [{ in: "query", name: "filter", required: false }],
      responses: { 200: { description: "ok" } },
    } } }, () => ({ status, body: { error: "filter is required" }, headers: { location: "/elsewhere" } }));
    assert.equal(result.checked, 1);
    assert.equal(result.operations_probed, 1);
    assert.deepEqual(result.findings.map((x) => x.kind), [kind]);
  });
}

test("a sampled 2xx with no response claim remains request-only", async (t) => {
  const { result, model } = await loopbackProbe(t, {
    "/items": { get: { responses: { 200: { description: "ok" } } } },
    "/items/{id}": { get: {} },
  }, (url) => url === "/items" ? { body: [{ id: "one" }] }
    : url.includes("nonexistent") ? { status: 404 } : { body: { id: "one" } });
  assert.equal(result.checked, 3);
  assert.equal(result.operations_probed, 1);
  assert.deepEqual(result.observed.map((x) => x.op), ["GET /items", "GET /items/{id}"],
    "recording an observed shape does not imply a contract comparison");
  assert.match(renderMapHtml(model), /1 of 2 documented operations probed/);
});

for (const [status, kind] of [[404, "missing"], [503, "erroring"]]) {
  test(`a sampled ${status} finding retains coverage and excludes the nonexistent-id request`, async (t) => {
    const ok = { description: "ok" };
    const { result } = await loopbackProbe(t, {
      "/items": { get: { responses: { 200: ok } } },
      "/items/{id}": { get: { responses: { 200: ok } } },
    }, (url) => url === "/items" ? { body: [{ id: "one" }] } : { status });
    assert.equal(result.checked, 3);
    assert.equal(result.operations_probed, 2);
    assert.deepEqual(result.findings.map((x) => ({ op: x.op, kind: x.kind })),
      [{ op: "GET /items/{id}", kind }]);
  });
}

test("map --no-execute states the static case end to end, in HTML and in text", () => {
  const root = mkdtempSync(join(tmpdir(), "map-coverage-cli-"));
  const work = mkdtempSync(join(tmpdir(), "map-coverage-cwd-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "openapi.json"), JSON.stringify({
    openapi: "3.0.0", info: { title: "svc" },
    paths: { "/a": { get: { responses: { 200: { description: "ok" } } } },
      "/b": { get: { responses: { 200: { description: "ok" } } } } },
  }));
  writeFileSync(join(root, "src", "server.mjs"), `app.get("/a", h);\napp.get("/b", h);\n`);

  const out = join(work, "footprint.html");
  const receipt = run(["map", root, "--no-execute", "--out", out, "--allow-outside-project"], work);
  assert.equal(receipt.code, 0, receipt.out);
  const html = readFileSync(out, "utf8");
  const text = run(["map", root, "--no-execute", "--text"], work);
  assert.equal(text.code, 0, text.out);

  for (const [view, output] of Object.entries({ html, text: text.out, receipt: receipt.out })) {
    assert.match(output, /source scan only/i, `the ${view} view must say it executed nothing`);
    for (const claim of COMPLETENESS_CLAIMS) assert.doesNotMatch(output, claim, `the ${view} view claims completeness`);
  }
  const json = JSON.parse(run(["map", root, "--no-execute", "--json"], work).out);
  assert.equal(json.probe_execution, "static");
  assert.equal(json.summary.operations_probed, 0);
  assert.deepEqual(json.services[0].probe, { attempted: 0, checked: 0, operations_probed: 0 });
});

test("a service card refuses to claim agreement about operations nobody probed", () => {
  const html = renderMapHtml(mapOf([svc("gateway"),
    svc("identity", { reachable: true, attempted: 4, checked: 4, operations_probed: 4 })], { probe_execution: "executed" }));
  assert.match(html, /No operation was probed, so nothing is verified for this service\./,
    "the unprobed service's disagreements group states why it is empty");
  assert.match(html, /Contract and server agree on every probed operation \(4 of 100 documented operations probed\)\./,
    "the probed service says how much its agreement covers");
  assert.doesNotMatch(html, /Contract and server agree on every probed operation\./,
    "the unqualified sentence is the defect; it may not survive anywhere");
});

test("coverage is stated only when every documented service measured it", () => {
  // Summing a mixture reads as a measurement while understating the estate.
  const partial = svc("legacy");
  delete partial.operations_probed;
  const model = mapOf([svc("gateway", { reachable: true, checked: 9, operations_probed: 9 }), partial],
    { probe_execution: "executed" });
  assert.equal(model.summary.operations_probed, undefined,
    "a partly measured estate reports no estate-wide coverage number");
  assert.equal(model.services.find((x) => x.name === "legacy").probe, undefined);
  assert.deepEqual(model.services.find((x) => x.name === "gateway").probe,
    { attempted: 0, checked: 9, operations_probed: 9 }, "the service that DID measure keeps its own number");
  assert.match(renderMapText(model), /probe coverage not recorded/);
});

test("two checkouts of one service report the coverage reached, not the sum", () => {
  // The copies were probed against the SAME server. Adding them would claim
  // more operations covered than the service declares.
  const checkout = (repo) => svc("catalog", { repo, dir: "/repo/catalog", reachable: true,
    attempted: 60, checked: 60, operations_probed: 60 });
  const model = mapOf([checkout("standalone"), checkout("monorepo")], { probe_execution: "executed" });
  assert.equal(model.services.length, 1, "one advertised identity is one service");
  assert.deepEqual(model.services[0].probe, { attempted: 60, checked: 60, operations_probed: 60 });
  assert.equal(model.summary.operations_probed, 60);
  assert.match(renderMapText(model), /60 of 100 documented operations probed/);
});

test("the receipt still refuses to claim zero requests for a model with no execution metadata", () => {
  // The coverage line must not become a back door around the receipt's own
  // rule (test/map-terminal.test.mjs): absence of metadata is not a ledger.
  const model = mapOf([svc("gateway")]);
  delete model.summary.operations_probed;
  const receipt = withoutAnsi(renderMapReceipt(model,
    { out: ("/" + "tmp/footprint.html"), theme: terminalTheme({ stream: { isTTY: false, columns: 100 }, env: {} }) }));
  assert.doesNotMatch(receipt, /no API requests|zero (?:API )?requests|source scan only|not probed/i);
  assert.match(receipt, /probe coverage not recorded/);
});

test("the model carries knowledge confidence as counts, never as their content", () => {
  const model = mapOf([svc("gateway", { known: { verified: 2, suspect: 1, unverified: 4 } })], { probe_execution: "executed" });
  assert.deepEqual(model.services[0].knowledge, { verified: 2, suspect: 1, unverified: 4 });
  assert.equal(mapOf([svc("bare")]).services[0].knowledge, undefined,
    "a service with no knowledge file carries no confidence block to misread");
  const html = renderMapHtml(model);
  assert.match(html, /Legacy audit classification retained in the report data; it is not a current evidence grade\./);
  assert.doesNotMatch(html, /2 verified, 1 suspect, 4 unverified/);
});

test("a repo with no documented operations says there was nothing to probe", () => {
  const model = { ...footprintModel({ root: "/repo", surfaces: [], edges: [],
    external: [{ from: "src/pay.mjs", url: "https://api.example.invalid", via: "src/pay.mjs" }], platform: [] }),
  probe_execution: "executed" };
  assert.equal(model.summary.operations, 0);
  for (const [view, output] of Object.entries(views(model))) {
    assert.match(output, /no documented operations to probe/, `the ${view} view must not report a coverage ratio`);
    assert.doesNotMatch(output, /0 of 0/, `the ${view} view printed an empty ratio`);
    for (const claim of COMPLETENESS_CLAIMS) assert.doesNotMatch(output, claim);
  }
});

// --- what a service without a contract may be told about itself -------------

test("a service with no contract says it has none, and is never given a coverage ratio", () => {
  // The commonest first-run estate: routes in source, no OpenAPI document. Its
  // `ops` is a ROUTE count, so a ratio over it would relabel undocumented
  // routes as documented operations — and contradict the "not probed — derived
  // from files only" fact printed directly above it on the same card.
  const bare = { name: "widgets", dir: "/repo/widgets", kind: "undocumented", routes: 2,
    framework: "express/hono/fastify", repo: "widgets", owner: "ana", ownerSource: "git",
    reachable: null, attempted: 0, checked: 0, findings: [], shadowRoutes: [], shadowCount: 0 };
  const model = mapOf([bare], { probe_execution: "executed" });

  assert.equal(model.services[0].probe, undefined, "no contract, no coverage block");
  assert.equal(model.summary.operations_probed, undefined);
  const html = renderMapHtml(model);
  assert.match(html, /<dt>coverage<\/dt><dd>no contract to probe against</);
  assert.doesNotMatch(html, /\d+ of \d+ documented operations probed/,
    "an undocumented route is never counted as a documented operation");
  assert.match(html, /This service declares no contract, so there is nothing to compare its responses against\./);
  assert.match(html, /not probed — derived from files only/, "the pre-existing fact is untouched");
});

test("a contract-less service keeps its coverage silence through the real CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "map-coverage-bare-"));
  const work = mkdtempSync(join(tmpdir(), "map-coverage-bare-cwd-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "server.mjs"),
    `app.get("/widgets", h);\napp.post("/widgets", h);\n`);

  const out = join(work, "bare.html");
  assert.equal(run(["map", root, "--out", out, "--allow-outside-project"], work).code, 0);
  const html = readFileSync(out, "utf8");
  assert.match(html, /no contract to probe against/);
  assert.doesNotMatch(html, /\d+ of \d+ documented operations probed/);
  const json = JSON.parse(run(["map", root, "--json"], work).out);
  assert.equal(json.services[0].kind, "undocumented");
  assert.equal(json.services[0].probe, undefined, "the fallback must not synthesize coverage without a contract");
  assert.equal(json.summary.operations_probed, undefined);
});

// --- the ratio's two halves -------------------------------------------------

test("a coverage ratio never exceeds its own denominator", (t) => {
  // Two checkouts of one service — same advertised host, so the product's own
  // grouping makes them one node — CAN carry different contracts; that is the
  // case the grouping exists for. Taking the widest run as numerator and the
  // first checkout's declared count as denominator printed "5 of 3".
  const root = mkdtempSync(join(tmpdir(), "map-coverage-twin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkout = (dirName, declared, probed) => {
    const dir = join(root, dirName);
    writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
      default: "local", environments: { local: { baseUrl: "http://api.internal:8080" } } }));
    return { name: "catalog", dir, kind: "documented", declared, repo: dirName,
      owner: "ana", ownerSource: "git", reachable: true,
      attempted: probed, checked: probed, operations_probed: probed,
      findings: [], shadowRoutes: [], shadowCount: 0 };
  };
  // smaller contract first, so a group[0] denominator would be the small one
  const model = { ...footprintModel({ root,
    surfaces: [checkout("standalone", 3, 0), checkout("monorepo", 5, 5)],
    edges: [], external: [], platform: [] }), probe_execution: "executed" };

  assert.equal(model.services.length, 1, "one advertised identity is one service");
  assert.ok(model.services[0].probe.operations_probed <= model.services[0].ops,
    `a service probed ${model.services[0].probe.operations_probed} of ${model.services[0].ops}`);
  assert.ok(model.summary.operations_probed <= model.summary.operations,
    `the estate probed ${model.summary.operations_probed} of ${model.summary.operations}`);
  assert.equal(coverageStatement(model), "5 of 5 documented operations probed",
    "both halves come from the checkout that was actually probed");
  for (const output of Object.values(views(model)))
    assert.doesNotMatch(output, /5 of 3 documented operations probed/);
});

// --- one reason per situation, in every panel -------------------------------

test("the header and the findings panel give the same reason for the same emptiness", () => {
  const bare = { name: "widgets", dir: "/repo/widgets", kind: "undocumented", routes: 2,
    repo: "widgets", reachable: null, findings: [], shadowRoutes: [], shadowCount: 0 };
  const declaredNothing = svc("empty", { declared: 0 });
  for (const [label, model] of [["undocumented estate", mapOf([bare], { probe_execution: "executed" })],
    ["a contract declaring no operation", mapOf([declaredNothing], { probe_execution: "executed" })]]) {
    assert.equal(coverageStatement(model), "no documented operations to probe", label);
    assert.match(renderMapHtml(model),
      /No contract here declares an operation, so there is nothing to compare against a server\./, label);
    assert.doesNotMatch(renderMapHtml(model), /Probe coverage was not recorded, so nothing here is verified\./,
      `${label}: "not recorded" is wrong when there was nothing to record`);
    assert.doesNotMatch(renderMapHtml(model), /Point the map at a reachable base URL/,
      `${label}: a base URL cannot supply a declaration`);
  }
});

// --- the retained snapshot ---------------------------------------------------

test("a retained map keeps the coverage it measured all the way into the view", () => {
  // The projector runs at WRITE time, so a field it drops is gone from the
  // record for good and every snapshot reads "not recorded" however carefully
  // the map measured. That is this repo's own MAR-632 class: a qualification
  // that exercises a different path than the live one.
  const root = mkdtempSync(join(tmpdir(), "map-coverage-view-"));
  const measured = mapOf([svc("gateway", { declared: 3, reachable: true,
    attempted: 4, checked: 4, operations_probed: 2 })], { probe_execution: "executed" });
  recordViewModel(root, "map", measured, { basis: "Fixture map", at: "2026-09-16T12:00:00.000Z" });
  const html = renderViewHtml(buildViewModel(root, { generatedAt: "2026-09-16T12:00:00.000Z" }));
  assert.match(html, /2 of 3 documented operations probed/,
    "the snapshot states the coverage the map measured");
  assert.doesNotMatch(html, /probe coverage not recorded/);

  // …and a record that genuinely never carried coverage still says so.
  const unmeasured = mapOf([svc("gateway", { declared: 3 })]);
  delete unmeasured.summary.operations_probed;
  delete unmeasured.services[0].probe;
  const older = mkdtempSync(join(tmpdir(), "map-coverage-view-old-"));
  recordViewModel(older, "map", unmeasured, { basis: "Fixture map", at: "2026-09-16T12:00:00.000Z" });
  const olderHtml = renderViewHtml(buildViewModel(older, { generatedAt: "2026-09-16T12:00:00.000Z" }));
  assert.match(olderHtml, /probe coverage not recorded/);
  assert.doesNotMatch(olderHtml, /\d+ of \d+ documented operations probed/);
});

test("the retained record carries each service's own coverage, as counts", () => {
  // An estate line stating coverage while its services cannot is one document
  // disagreeing with itself.
  const root = mkdtempSync(join(tmpdir(), "map-coverage-record-"));
  const model = mapOf([svc("gateway", { declared: 3, reachable: true, attempted: 4, checked: 4,
    operations_probed: 2, known: { verified: 1, suspect: 2, unverified: 0 } })],
  { probe_execution: "executed" });
  const path = recordViewModel(root, "map", model, { basis: "Fixture map", at: "2026-09-16T12:00:00.000Z" });
  const record = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(record.model.probe_execution, "executed");
  assert.equal(record.model.summary.operations_probed, 2);
  assert.deepEqual(record.model.services[0].probe, { attempted: 4, checked: 4, operations_probed: 2 });
  assert.deepEqual(record.model.services[0].knowledge, { verified: 1, suspect: 2, unverified: 0 });
});
