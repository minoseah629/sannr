// STACKS-1B: live captures use real named stacks. Historical map/view
// controls read an explicit saved legacy projection in a separate directory;
// named-stack map integration belongs to STACKS-2 and is not claimed here.
// MAP-1A fix round 1: the rulings on QA's B1–B9 and notes, each pinned.
// Synthetic only: temp projects, an isolated registry home, and real client
// captures against a loopback server that runs in its own process (the client
// is driven with spawnSync, which blocks this one).
//
//   node --test test/api-map-fixes.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "../lib/layout.mjs";
import { HOME_ENV_NAME, ENV_PREFIX } from "../lib/brand.mjs";
import { buildApiMapModel as buildRaw, renderApiMapHtml, renderApiMapText } from "../lib/api-map.mjs";
import { buildViewModel as viewRaw, renderViewHtml } from "../lib/view.mjs";
import { seedApiMapFixture, AT, MARKERS, CONTRACT } from "./fixtures/api-map/fixture.mjs";

import { createFixtureStack, fixtureContextFile, historicalFixtureProjection, registerHistoricalFixtureProjection } from "./helpers/stack-fixture.mjs";

const buildApiMapModel = (root, options) => buildRaw(historicalFixtureProjection(root), options);
const buildViewModel = (root, options) => viewRaw(historicalFixtureProjection(root), options);
const storePath = root => existsSync(fixtureContextFile(root)) ? fixtureContextFile(root) : join(root, LAYOUT.context);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs"), REQUEST = join(ROOT, "bin/request.mjs");
const SERVER = join(ROOT, "test/fixtures/api-map/server.mjs");
// The literals the loopback server puts in every body (see its source).
const SERVER_MARKERS = ["SRVMARK_BODY_4c1e", "SRVMARK_ITEM_7b2d", "SRVMARK_ECHO_9f3a"];
for (const key of Object.keys(process.env)) if (key.startsWith("API_") || key.startsWith(`${ENV_PREFIX}_`)) delete process.env[key];
process.env.HEARTH_TOKEN = MARKERS.token;

function project(t, name = "api-map-fix-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", root]);
  return root;
}
const envFor = root => ({ [HOME_ENV_NAME]: join(root, ".home"), API_USAGE_LOG: join(root, ".usage.jsonl") });
const cliEnv = (root, extra = {}) => ({ ...process.env, ...envFor(root), ...extra });
const run = (root, args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: ["map", "view"].includes(args[0]) ? historicalFixtureProjection(root) : root, env: cliEnv(root, extra), encoding: "utf8" });
const build = (root, options = {}) => buildApiMapModel(root, { now: Date.parse(AT), env: envFor(root), ...options });
const row = (model, op) => model.operations.find(item => item.op === op);
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const edit = (path, fn) => { const value = readJson(path); fn(value); writeJson(path, value); };
const contractFile = root => join(root, CONTRACT);
const hearth = t => { const root = project(t); seedApiMapFixture(root); return root; };
const ok200 = summary => ({ summary, responses: { 200: { description: "OK" } } });
// Page text as a reader sees it: the escaper encodes ( = @ ' so prose stays
// prose under the view's active-content guard.
const pageText = html => html.replaceAll("&#40;", "(").replaceAll("&#61;", "=").replaceAll("&#64;", "@").replaceAll("&#39;", "'");
const viewPage = (root, extra) => {
  const result = run(root, ["view", "--json"], extra);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return readFileSync(JSON.parse(result.stdout).path, "utf8");
};

async function startServer(t) {
  const child = spawn(process.execPath, [SERVER], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGTERM"));
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    child.stdout.on("data", chunk => { buffer += chunk; const match = /PORT (\d+)/.exec(buffer); if (match) resolvePort(Number(match[1])); });
    child.on("exit", code => reject(new Error(`loopback server exited ${code}`)));
  });
}
// One real client request through the CLI envelope, captured by the client.
function send(root, request, extra = {}) {
  const result = spawnSync(process.execPath, [REQUEST, "envelope", JSON.stringify({ v: 2, on_failure: "continue", requests: [request] })],
    { cwd: root, env: cliEnv(root, extra), encoding: "utf8" });
  assert.equal(result.status === 0 || result.status === 1, true, result.stderr);
  return JSON.parse(result.stdout).results[0];
}
// A consumer project with its own contract and environment, store initialised.
function consumer(t, { baseUrl, paths, extra = {} }) {
  const root = project(t);
  writeJson(join(root, "contracts/c.json"), { openapi: "3.0.3", info: { title: "Items", version: "1" }, paths });
  createFixtureStack(root, { baseUrl, contract: "contracts/c.json", environmentConfig: extra });
  registerHistoricalFixtureProjection(t, root);
  const init = run(root, ["init"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return root;
}

// --- B1: one operation never takes a page down --------------------------------

test("MAP-1A fix B1a: an operation over the identity bound gets its own unavailable row; view and map still write", t => {
  // Adding a path changes the contract digest, so both projects add one: a
  // control with an ordinary path and the one under test with a 509-character
  // path (a 513-character operation; the identity bound is 512).
  const standings = (path) => {
    const root = hearth(t);
    edit(contractFile(root), contract => { contract.paths[path] = { get: ok200("Extra") }; });
    return { root, model: build(root) };
  };
  const long = `/v1/${"a".repeat(505)}`;
  const control = standings("/v1/extra"), { root, model } = standings(long);
  assert.equal(row(model, `GET ${long}`).standing.key, "unavailable");
  assert.deepEqual(row(model, `GET ${long}`).standing.qualifiers, ["CONTEXT_INPUT_INVALID"]);
  const others = item => item.op !== `GET ${long}` && item.op !== "GET /v1/extra";
  assert.deepEqual(model.operations.filter(others).map(item => [item.op, item.standing]),
    control.model.operations.filter(others).map(item => [item.op, item.standing]), "every other operation keeps its standing");
  viewPage(root);
  const map = run(root, ["map", ".", "--no-execute"]);
  assert.equal(map.status, 0, map.stderr);
  assert.doesNotMatch(map.stderr, /API_MAP_UNAVAILABLE/);
  assert.match(map.stdout, /API map — Hearth API: 18 operations/);
});

test("MAP-1A fix B1b: a secret-shaped contract path is withheld and counted, never shown and never a refusal", t => {
  const root = hearth(t);
  const secret = "AKIAIOSFODNN7EXAMPLE";
  edit(contractFile(root), contract => { contract.paths[`/v1/keys/${secret}`] = { get: { tags: ["Hubs"], ...ok200("Key lookup") } }; });
  const model = build(root);
  assert.equal(model.omissions.contract_paths_withheld, 1);
  const withheld = model.operations.filter(item => item.withheld);
  assert.equal(withheld.length, 1);
  assert.deepEqual([withheld[0].op, withheld[0].path, withheld[0].method, withheld[0].standing.key], [null, null, "GET", "unavailable"]);
  const html = renderApiMapHtml(model);
  // Round 2: everything withheld is counted by kind in one line.
  assert.match(html, /Withheld by the secret and promotion scans: 1 contract path\. Each reads withheld where it would render\./);
  assert.match(html, /path withheld \(secret-shaped\)/);
  const map = run(root, ["map", ".", "--no-execute"]);
  assert.equal(map.status, 0, map.stderr);
  const surfaces = { model: JSON.stringify(model), html, text: renderApiMapText(model), view: viewPage(root),
    receipt: map.stdout + map.stderr, mapHtml: readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8"),
    json: run(root, ["map", ".", "--no-execute", "--json"]).stdout, mapText: run(root, ["map", ".", "--no-execute", "--text"]).stdout };
  for (const [surface, text] of Object.entries(surfaces)) assert.ok(!text.includes(secret), `${surface} shows the withheld path`);
});

test("MAP-1A fix B1b: a secret-shaped contract version is withheld and counted; view and map still write", t => {
  const root = hearth(t);
  const secret = "ghp_" + "c".repeat(36);
  edit(contractFile(root), contract => { contract.info.version = secret; });
  const model = build(root);
  assert.deepEqual([model.contract.version, model.omissions.contract_version_withheld], [null, 1]);
  assert.match(renderApiMapHtml(model), /Withheld by the secret and promotion scans: 1 contract version\./);
  assert.ok(!viewPage(root).includes(secret));
  const map = run(root, ["map", ".", "--no-execute"]);
  assert.equal(map.status, 0, map.stderr);
  assert.doesNotMatch(map.stderr, /API_MAP_UNAVAILABLE/);
  assert.ok(!readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8").includes(secret));
});

test("MAP-1A fix B1c: an environment name the store cannot hold is a named scope reason, not a failed page", t => {
  for (const name of ["prod‮eu", "e".repeat(2100)]) {
    const root = hearth(t);
    edit(join(root, LAYOUT.environments), config => { config.environments[name] = config.environments.production; config.default = name; });
    const model = build(root);
    assert.equal(model.scope.state, "unresolved");
    assert.match(model.scope.reason, /the selected environment name cannot be stored/);
    assert.equal(model.counts["scope-unresolved"], model.counts.operations);
    const page = viewPage(root);
    assert.ok(!page.includes("‮"), "no bidirectional control reaches the page");
    // show names the same reason instead of failing.
    const shown = run(root, ["show", "GET /v1/hubs"]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).observation_summary.scope_reason, "environment-unusable");
  }
});

test("MAP-1A fix B1d: a provider whose contract gains a secret-shaped path still gets its footprint, and view still writes", t => {
  const root = project(t);
  for (const file of ["app.ts", "openapi.json", "identity/identity.routes.ts", "photos/photo.routes.ts"]) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), readFileSync(join(ROOT, "test/fixtures/audit-live-shapes", file)));
  }
  assert.equal(run(root, ["init"]).status, 0);
  edit(join(root, "openapi.json"), contract => { contract.paths["/v1/keys/AKIAIOSFODNN7EXAMPLE"] = { get: ok200("Key") }; });
  const map = run(root, ["map", ".", "--no-execute"]);
  assert.equal(map.status, 0, map.stdout + map.stderr);
  assert.doesNotMatch(map.stdout + map.stderr, /API_MAP_SECRET_REFUSED|API_MAP_UNAVAILABLE/);
  assert.ok(existsSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput)), "the footprint is written");
  assert.ok(!readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8").includes("AKIAIOSFODNN7EXAMPLE"));
  assert.ok(!viewPage(root).includes("AKIAIOSFODNN7EXAMPLE"));
});

test("MAP-1A fix B1: when the API map cannot be built, map drops only that section, names it and exits 0", t => {
  const root = project(t);
  seedApiMapFixture(root, { withSource: false });
  writeFileSync(storePath(root), "{");
  const map = run(root, ["map", ".", "--no-execute"]);
  assert.equal(map.status, 0, map.stdout + map.stderr);
  const note = JSON.parse(map.stderr.trim().split("\n").find(line => line.includes("API_MAP_UNAVAILABLE")));
  assert.deepEqual([note.code, note.reason], ["API_MAP_UNAVAILABLE", "API_MAP_CONTEXT_INVALID"]);
  assert.ok(existsSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput)), "the footprint is written");
  assert.doesNotMatch(readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8"), /id="api-map"/);
});

// --- B2: bind the way the client builds a request ------------------------------

test("MAP-1A fix B2: a base URL with a path prefix binds contract paths written without it; captures, show and the map agree", async t => {
  const port = await startServer(t);
  const root = consumer(t, { baseUrl: `http://127.0.0.1:${port}/api`, paths: {
    "/v1/items": { get: ok200("List items") }, "/v1/items/{itemId}": { get: ok200("Get item") }, "/v1/health": { get: ok200("Health") } } });
  const list = send(root, { method: "GET", path: "/v1/items", expect: [{ status: 200 }] });
  const item = send(root, { method: "GET", path: "/v1/items/abc123", expect: [{ status: 200 }] });
  for (const result of [list, item]) {
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.context_capture?.state, "captured", JSON.stringify(result.context_capture));
    assert.ok(!JSON.stringify(result).includes("undeclared-path"), "a bound request is not also an undeclared path");
  }
  const stored = Object.values(readJson(storePath(root)).api_context.operations).map(entry => entry.identity);
  assert.deepEqual(stored.map(identity => [identity.operation, identity.endpoint]).sort(), [
    ["GET /v1/items", `http://127.0.0.1:${port}/api/v1/items`],
    ["GET /v1/items/{itemId}", `http://127.0.0.1:${port}/api/v1/items/{itemId}`],
  ]);
  const model = buildApiMapModel(root, { env: envFor(root) });
  assert.equal(model.scope.state, "bound");
  assert.deepEqual(model.operations.map(item => [item.op, item.standing.key]), [
    ["GET /v1/items", "observed"], ["GET /v1/items/{itemId}", "observed"], ["GET /v1/health", "no-response"]]);
  for (const op of ["GET /v1/items", "GET /v1/items/{itemId}"]) {
    const shown = run(root, ["show", op]);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).confidence, "observed", op);
  }
});

test("MAP-1A fix B2: a contract that includes the mount for some operations binds as written and names the others' reason", t => {
  const root = hearth(t);
  edit(join(root, LAYOUT.environments), config => { config.environments.production.baseUrl += "/api"; });
  edit(contractFile(root), contract => { contract.paths = { "/api/v1/items": { get: ok200("Items") }, "/health": { get: ok200("Health") } }; });
  const model = build(root);
  assert.equal(row(model, "GET /api/v1/items").standing.key, "no-response");
  assert.deepEqual(row(model, "GET /health").standing.qualifiers, ["its path is outside the configured base URL's path"]);
  assert.equal(row(model, "GET /v1/hubs").standing.qualifiers[0], "not in the bound contract");
});

// --- B3: damaged key_sources fail closed per record -----------------------------

test("MAP-1A fix B3: a damaged key_sources list is absent and counted for its record only; the store and its observations stay readable", t => {
  const root = project(t);
  const seeded = seedApiMapFixture(root);
  const id = seeded.operationId("GET /v1/hubs/{hubId}");
  const valid = readJson(storePath(root)).api_context.operations[id].key_sources[0];
  // MAP-1C's validator governs (integration round): it projects only the
  // schema's keys, so an entry with an unknown key is a valid entry without it
  // (pinned in test/api-map-integration.test.mjs), not a damaged list.
  const forms = {
    "duplicate entries": [valid, { ...valid }],
    "17 entries": [valid, ...Array.from({ length: 16 }, (_, i) => ({ ...valid, param: `key${i}` }))],
    "three sources for one key": [valid, { ...valid, source: { ...valid.source, field: "a" } }, { ...valid, source: { ...valid.source, field: "b" } }],
    "first seen after last seen": [{ ...valid, first_observed_at: "2026-10-02T00:00:00.000Z", last_observed_at: "2026-10-01T00:00:00.000Z" }],
    "location header": [{ ...valid, location: "header" }],
    "lowercase method": [{ ...valid, source: { ...valid.source, operation: "get /v1/hubs" } }],
    "257-character field": [{ ...valid, source: { ...valid.source, field: "f".repeat(257) } }],
    "date that is not a date": [{ ...valid, first_observed_at: "yesterday" }],
    "negative also_seen": [{ ...valid, also_seen: -1 }],
    "fractional also_seen": [{ ...valid, also_seen: 1.5 }],
    "run id that escapes": [{ ...valid, evidence: { ...valid.evidence, run_id: "../run-1" } }],
    "short digest": [{ ...valid, evidence: { ...valid.evidence, digest: "sha256:short" } }],
    "null entry": [null],
    "null source": [{ ...valid, source: null }],
    "secret-shaped key": [{ ...valid, param: "ghp_" + "a".repeat(36) }],
    "secret-shaped field": [{ ...valid, source: { ...valid.source, field: "ghp_" + "b".repeat(36) } }],
    "email-shaped field": [{ ...valid, source: { ...valid.source, field: "owner@example.test" } }],
    "not an array": "not-an-array",
    "an object": { ...valid },
  };
  for (const [form, value] of Object.entries(forms)) {
    edit(storePath(root), store => { store.api_context.operations[id].key_sources = value; });
    const model = build(root);
    // The fixture already carries one damaged list (GET …/members/{memberId}).
    assert.equal(model.omissions.key_source_records_damaged, 2, form);
    assert.deepEqual(model.key_sources.filter(key => key.op === "GET /v1/hubs/{hubId}"), [], form);
    assert.ok(model.issues.some(issue => issue.code === "KEY_SOURCES_INVALID" && issue.operation === "GET /v1/hubs/{hubId}"), form);
    assert.equal(row(model, "GET /v1/hubs/{hubId}").standing.key, "observed", `${form}: observations stay readable`);
    assert.equal(model.counts.observed_total, 4, form);
    const html = renderApiMapHtml(model);
    assert.match(html, /2 operation records have a damaged key-source list; their links are treated as absent\./, form);
    assert.ok(!html.includes("ghp_") && !html.includes("owner@example.test"), form);
  }
});

// --- B4: the undeclared-parameter qualifier claims only what the store holds ---

test("MAP-1A fix B4: an unresolved parameter reference skips the qualifier; names written into the path are recorded, values never", async t => {
  const port = await startServer(t);
  const root = consumer(t, { baseUrl: `http://127.0.0.1:${port}`, paths: {
    "/v1/items": { get: { parameters: [{ $ref: "params.json#/Limit" }], ...ok200("List items") } },
    "/v1/inline": { get: { parameters: [{ name: "q", in: "query" }], ...ok200("Inline") } } } });
  writeJson(join(root, "contracts/params.json"), { Limit: { name: "limit", in: "query" } });
  const longName = "n".repeat(70);
  assert.equal(send(root, { method: "GET", path: "/v1/items", params: { limit: 5 }, expect: [{ status: 200 }] }).context_capture?.state, "captured");
  const inline = send(root, { method: "GET", path: `/v1/inline?q=INLINEVALUE1&undeclaredInline=INLINEVALUE2&owner@example.test=INLINEVALUE3&${longName}=INLINEVALUE4`, expect: [{ status: 200 }] });
  assert.equal(inline.context_capture?.state, "captured", JSON.stringify(inline.context_capture));
  const model = buildApiMapModel(root, { env: envFor(root) });
  assert.equal(row(model, "GET /v1/items").standing.key, "observed");
  assert.deepEqual(row(model, "GET /v1/items").standing.qualifiers, [], "an unresolved $ref leaves the declared set incomplete");
  assert.equal(model.omissions.declared_parameters_unresolved, 1);
  assert.match(pageText(renderApiMapHtml(model)), /1 operation declares parameters that cannot all be resolved to a name and location \(a reference that cannot be resolved, an entry missing either, or a parameters value that is not a list\), so the undeclared-parameter check is skipped for it/);
  assert.deepEqual(row(model, "GET /v1/inline").standing.qualifiers, ["using parameters the contract does not declare: undeclaredInline"]);
  const store = readFileSync(storePath(root), "utf8");
  const inlineEntry = Object.values(JSON.parse(store).api_context.operations).find(entry => entry.identity.operation === "GET /v1/inline");
  const params = inlineEntry.observations[0].request_shape.properties.params.properties;
  assert.deepEqual(Object.keys(params).sort(), ["q", "undeclaredInline"], "names only, through the promotion field-name scan");
  assert.deepEqual(params.undeclaredInline, { type: "string" });
  for (const value of ["INLINEVALUE1", "INLINEVALUE2", "INLINEVALUE3", "INLINEVALUE4", "owner@example.test", longName, ...SERVER_MARKERS])
    assert.ok(!store.includes(value), `the store holds ${value}`);
  const page = renderApiMapHtml(model);
  assert.match(page, /names the query parameter names recorded in the request shape/);
  for (const value of ["INLINEVALUE1", "INLINEVALUE2", ...SERVER_MARKERS]) assert.ok(!page.includes(value));
});

// --- B5: one row per path key ---------------------------------------------------

test("MAP-1A fix B5: the key table has one row per path key of the contract, most-seen source first, not recorded otherwise", t => {
  const root = hearth(t);
  const model = build(root);
  assert.deepEqual(model.key_slots.map(slot => [slot.param, slot.prefix,
    slot.sources.map(source => `${source.operation} ${source.field} ${source.seen_on}`), slot.more]), [
    ["hubId", "/v1/hubs/{hubId}", ["GET /v1/hubs data[].id 3", "GET /v1/me hub_id 1"], 1],
    ["memberId", "/v1/hubs/{hubId}/members/{memberId}", [], 0],
    ["taskId", "/v1/hubs/{hubId}/tasks/{taskId}", ["GET /v1/hubs/{hubId}/tasks data[].id 1"], 0],
    ["listId", "/v1/hubs/{hubId}/lists/{listId}", [], 0],
  ]);
  assert.deepEqual([model.counts.key_slots, model.counts.key_slots_sourced], [4, 2]);
  const html = renderApiMapHtml(model);
  const table = html.slice(html.indexOf("<h3>Where each path key comes from</h3>"), html.indexOf("<h3>Notes</h3>"));
  const rows = [...table.matchAll(/<tr><td><code>([^<]*)<\/code><\/td><td><code>([^<]*)<\/code><\/td><td>([\s\S]*?)<\/td><\/tr>/g)];
  assert.deepEqual(rows.map(([, key, prefix]) => `${key} ${prefix}`), ["hubId /v1/hubs/{hubId}", "memberId /v1/hubs/{hubId}/members/{memberId}",
    "taskId /v1/hubs/{hubId}/tasks/{taskId}", "listId /v1/hubs/{hubId}/lists/{listId}"]);
  assert.match(rows[0][3], /^<code>GET \/v1\/hubs<\/code> → <code>data\[\]\.id<\/code> <span class="am-q">seen on 3 operations<\/span><br><code>GET \/v1\/me<\/code> → <code>hub_id<\/code> <span class="am-q">seen on 1 operation<\/span><br>and 1 more$/);
  assert.equal(rows[1][3], "not recorded");
  assert.equal(rows[3][3], "not recorded");
  assert.match(html, /<b>2<\/b><span>of 4 path keys with a recorded source<\/span>/);
  // Every operation's own records, query keys included, stay in its details.
  const view = renderViewHtml(buildViewModel(root, { generatedAt: AT, env: envFor(root) }));
  const card = view.slice(view.indexOf("<summary><code>GET /v1/hubs/{hubId}/tasks</code>"));
  const details = card.slice(0, card.indexOf("</details>"));
  assert.match(details, /<h3>Key sources<\/h3>/);
  assert.match(details, /<code>page_cursor<\/code> \(query\) from <code>GET \/v1\/hubs\/\{hubId\}\/tasks<\/code> → <code>meta\.page_cursor<\/code>/);
  const member = view.slice(view.indexOf("<summary><code>GET /v1/hubs/{hubId}/members/{memberId}</code>"));
  assert.match(pageText(member.slice(0, member.indexOf("</details>"))), /The stored key-source list is damaged \(KEY_SOURCES_INVALID\); its links are treated as absent\./);
});

// --- B6: the contract's state is named, never a refusal ------------------------

test("MAP-1A fix B6: a missing, unreadable or empty contract renders the page from the store and says which", t => {
  const cases = [
    ["malformed JSON", root => writeFileSync(contractFile(root), "{ not json"), "unreadable", "is unreadable"],
    ["a directory", root => { rmSync(contractFile(root)); mkdirSync(contractFile(root)); }, "unreadable", "is unreadable"],
    ["no operations", root => writeJson(contractFile(root), { openapi: "3.0.3", info: { title: "Empty", version: "1" }, paths: {} }), "declares no operations", "declares no operations"],
    ["missing", root => unlinkSync(contractFile(root)), "missing", "is missing"],
  ];
  if (process.getuid?.() !== 0) cases.push(["no read permission", root => chmodSync(contractFile(root), 0o000), "unreadable", "is unreadable"]);
  for (const [label, damage, basisWord, reason] of cases) {
    const root = hearth(t);
    damage(root);
    const page = viewPage(root);
    const file = CONTRACT.replaceAll(".", "\\.");
    assert.match(page, new RegExp(`contract <code>${file}</code>(?: \\(version [^)]*\\))? — ${basisWord}`), label);
    const model = build(root);
    assert.equal(model.scope.reason, `contract ${CONTRACT} ${reason}`, label);
    assert.match(page, new RegExp(`Scope unresolved: contract ${file} ${reason}`), label);
    if (label === "no read permission") chmodSync(contractFile(root), 0o600);
  }
  const unnamed = hearth(t);
  edit(join(unnamed, LAYOUT.environments), config => { for (const environment of Object.values(config.environments)) delete environment.contract; });
  edit(join(unnamed, LAYOUT.context), store => { delete store.api.contract; });
  unlinkSync(contractFile(unnamed));
  assert.equal(build(unnamed).scope.reason, "no contract is named for the selected environment");
});

// --- B7: a vanished granted provider -------------------------------------------

test("MAP-1A fix B7: a granted provider whose directory is gone is skipped and named once; show agrees", t => {
  const root = hearth(t);
  const provider = project(t, "provider-");
  writeJson(join(provider, "openapi.json"), { openapi: "3.0.3", info: { title: "p", version: "1" }, paths: { "/x": { get: ok200("X") } } });
  const home = envFor(root);
  assert.equal(spawnSync(process.execPath, [CLI, "init"], { cwd: provider, env: { ...process.env, ...home }, encoding: "utf8" }).status, 0);
  assert.equal(run(root, ["grant", provider]).status, 0);
  rmSync(provider, { recursive: true, force: true });
  const model = build(root);
  assert.equal(model.counts.unavailable, 0, "local standings render normally");
  assert.equal(row(model, "GET /v1/hubs").standing.key, "observed");
  assert.equal(model.sources.length, 1);
  assert.deepEqual([model.sources[0].kind, model.sources[0].name], ["provider-missing", basename(provider)]);
  assert.match(pageText(renderApiMapHtml(model)), new RegExp(`History sources: granted provider ${basename(provider)} \\([0-9a-f]+\\): directory missing; its history is not included\\.`));
  const shown = run(root, ["show", "GET /v1/hubs"]);
  assert.equal(shown.status, 0, shown.stderr);
  const detail = JSON.parse(shown.stdout);
  assert.equal(detail.observation_summary.state, "observed");
  assert.deepEqual(detail.observation_summary.skipped.map(item => [item.name, item.reason]), [[basename(provider), "directory-missing"]]);
});

test("MAP-1A fix B7: a granted provider whose store cannot be read withholds labels and is named once at page level", t => {
  const root = hearth(t);
  const provider = project(t, "provider-");
  writeJson(join(provider, "openapi.json"), { openapi: "3.0.3", info: { title: "p", version: "1" }, paths: { "/x": { get: ok200("X") } } });
  assert.equal(spawnSync(process.execPath, [CLI, "init"], { cwd: provider, env: { ...process.env, ...envFor(root) }, encoding: "utf8" }).status, 0);
  assert.equal(run(root, ["grant", provider]).status, 0);
  writeFileSync(join(provider, LAYOUT.context), "{");
  const model = build(root);
  assert.equal(row(model, "GET /v1/hubs").standing.key, "unavailable");
  assert.equal(model.sources[0].kind, "provider-unreadable");
  const html = pageText(renderApiMapHtml(model));
  assert.match(html, new RegExp(`granted provider ${basename(provider)} \\([0-9a-f]+\\): its store cannot be read \\([A-Z_]+\\); labels are withheld`));
  assert.equal(html.match(/its store cannot be read/g).length, 1, "named once");
});

// --- B8: grouping ------------------------------------------------------------------

function grouped(t, paths) {
  const root = project(t);
  writeJson(join(root, "c/c.json"), { openapi: "3.0.3", info: { title: "t", version: "1" },
    paths: Object.fromEntries(paths.map(path => [path, { get: ok200(path) }])) });
  writeJson(storePath(root), { v: 0, api: { name: "t", contract: "c/c.json" }, operations: {} });
  const model = buildApiMapModel(root, { env: envFor(root) });
  return { model, html: renderApiMapHtml(model), groupOf: path => model.groups.find(group => group.operations.some(index => model.operations[index].path === path)) };
}

test("MAP-1A fix B8: no // headings, a hub's collection stays with its items, a root operation does not collapse the groups", t => {
  const root = grouped(t, ["/{tenant}", "/{tenant}/a", "/{tenant}/b"]);
  assert.doesNotMatch(root.html, /<h4><code>\/\/<\/code>/);
  assert.match(root.html, /<h4><code>\/<\/code> <span class="am-n">1<\/span><\/h4>/);
  const item = grouped(t, ["/v1/a", "/v1/a/{id}", "/v1/a/{id}/x", "/v2/z"]);
  assert.equal(item.model.hub.prefix, "/v1/a/{id}");
  assert.equal(item.groupOf("/v1/a"), item.groupOf("/v1/a/{id}"), "the collection and its items share a group");
  const common = grouped(t, ["/api/v3", "/api/v3/users", "/api/v3/orgs"]);
  assert.deepEqual(common.model.groups.map(group => group.name), ["v3", "users", "orgs"]);
});

// --- B9: an earlier failure, counted or not -----------------------------------------

test("MAP-1A fix B9: an earlier failed response retained in scope marks after-a-failed-attempt even when it cannot be counted", t => {
  const missing = hearth(t);
  unlinkSync(join(missing, LAYOUT.evidence, "run-0a1b2c3d-0003.json")); // the 400 before the passing 200
  const tasks = row(build(missing), "GET /v1/hubs/{hubId}/tasks");
  assert.equal(tasks.standing.key, "observed-after-failure");
  assert.deepEqual(tasks.standing.qualifiers, ["an earlier failure is retained; its evidence is missing or changed",
    "using parameters the contract does not declare: page_cursor"]);
  const stale = hearth(t);
  edit(join(stale, LAYOUT.context), store => {
    const entry = Object.values(store.api_context.operations).find(item => item.identity.operation === "GET /v1/hubs/{hubId}/tasks");
    Object.assign(entry.observations[0], { observed_at: "2026-01-02T00:00:00.000Z", recorded_at: "2026-01-02T00:00:00.000Z" });
  });
  assert.deepEqual(row(build(stale), "GET /v1/hubs/{hubId}/tasks").standing.qualifiers[0],
    "an earlier failure is retained; it is older than the 180-day staleness horizon");
  // show's observed label is unchanged by the after-a-failure distinction.
  const shown = run(missing, ["show", "GET /v1/hubs/{hubId}/tasks"], {});
  assert.equal(shown.status, 0, shown.stderr);
});

// --- Notes taken as changes -----------------------------------------------------------

test("MAP-1A fix notes: definitions say what the scope records, 2xx-not-counted is neutral, and a consumer's coverage line names the API it calls", t => {
  const root = hearth(t);
  const model = build(root);
  const html = renderApiMapHtml(model);
  assert.match(html, /It may or may not have been sent; nothing in this scope records it\./);
  assert.doesNotMatch(html, /nothing in the store records it/);
  assert.match(html, /This is the label show prints; show also prints observed for an operation observed after a failed attempt\./);
  const chip = op => {
    const index = model.operations.findIndex(item => item.op === op);
    return [...html.matchAll(/<tr class="am-r [^"]*">([\s\S]*?)<\/tr>/g)][index][1].match(/<span class="(am-chip am-s-[^"]*)">/)[1];
  };
  assert.equal(chip("GET /v1/hubs/{hubId}/members"), "am-chip am-s-latest-response am-tone-neutral", "2xx, evidence missing: neutral");
  assert.equal(chip("GET /v1/hubs/{hubId}/lists"), "am-chip am-s-latest-response am-tone-neutral", "2xx, stale: neutral");
  assert.equal(chip("GET /v1/hubs/{hubId}/members/{memberId}"), "am-chip am-s-latest-response", "404: the failure marker");
  assert.equal(chip("GET /v1/me"), "am-chip am-s-latest-response", "a failed assertion: the failure marker");
  const receipt = run(root, ["map", ".", "--no-execute"]);
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.match(receipt.stdout, /\/\/ COVERAGE · this repository serves no documented API; the API map below is the one it calls/);
  const page = readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8");
  assert.doesNotMatch(page, /no documented operations to probe/);
  assert.match(page, /this repository serves no documented API; the API map below is the one it calls/);
  assert.match(run(root, ["map", ".", "--no-execute", "--text"]).stdout, /this repository serves no documented API; the API map below is the one it calls/);
});

// --- Rules QA's mutations found unpinned ------------------------------------------

test("MAP-1A fix pins: bidirectional and format controls are removed everywhere on the view page", t => {
  const root = hearth(t);
  edit(storePath(root), store => {
    const entry = store.operations["GET /v1/hubs/{hubId}/tasks"];
    entry.notes.push("Reversed ‮etats‬ with ⁦isolate⁩ and ‏marks‎ here.");
    entry.notes_provenance.push({ by: "agent", at: "2026-09-29" });
    entry.notes_superseded.push(null);
  });
  const view = renderViewHtml(buildViewModel(root, { generatedAt: AT, env: envFor(root) }));
  assert.doesNotMatch(view, /[‪-‮⁦-⁩‎‏؜]/u, "no bidirectional control anywhere on the page");
  assert.equal(view.split("Reversed etats with isolate and marks here.").length - 1, 2, "the API map and the operation details render the note the same way");
});

test("MAP-1A fix pins: a hub must cover at least a quarter of the operations", t => {
  const paths = n => ["/h/{id}/a", "/h/{id}/b", ...Array.from({ length: n - 2 }, (_, i) => `/other${i}`)];
  assert.deepEqual(grouped(t, paths(8)).model.hub, { prefix: "/h/{id}", operations: 2 }, "2 of 8 is a quarter");
  assert.equal(grouped(t, paths(9)).model.hub, null, "2 of 9 is under a quarter");
});

test("MAP-1A fix pins: the undeclared-parameter qualifier belongs to a passing newest response only", t => {
  const root = hearth(t);
  edit(storePath(root), store => {
    // The 404 member read sent a parameter its operation does not declare.
    const entry = Object.values(store.api_context.operations).find(item => item.identity.operation === "GET /v1/hubs/{hubId}/members/{memberId}");
    entry.observations[0].request_shape = { type: "object", properties: { params: { type: "object", properties: { expand: { type: "string" } } }, body: { type: "null" } } };
  });
  const model = build(root);
  const member = row(model, "GET /v1/hubs/{hubId}/members/{memberId}");
  assert.equal(member.standing.key, "latest-response");
  assert.deepEqual(member.undeclared_parameters, []);
  assert.ok(!member.standing.qualifiers.some(text => /does not declare/.test(text)));
  assert.equal(model.counts.undeclared_parameters, 1, "only the passing GET …/tasks counts");
});

test("MAP-1A fix pins: a base URL with userinfo, a query or a fragment is named as unable to scope responses", t => {
  for (const baseUrl of ["https://api.hearth.test/?page=1", "https://api.hearth.test/#part", "https://reader@api.hearth.test"]) {
    const root = hearth(t);
    edit(join(root, LAYOUT.environments), config => { config.environments.production.baseUrl = baseUrl; });
    const model = build(root);
    assert.equal(model.scope.state, "unresolved", baseUrl);
    assert.equal(model.scope.reason, "the configured base URL cannot scope responses", baseUrl);
    assert.equal(row(model, "GET /v1/hubs").standing.qualifiers[0], "the configured base URL cannot scope responses", baseUrl);
  }
});

test("MAP-1A fix pins: show and the map bind the contract in one order: API_CONTRACT, environment, store, conventional file", t => {
  const root = hearth(t);
  // Every variant declares GET /v1/hubs, so the operation binds under each and
  // its identity carries that variant's digest.
  const variant = (file, title) => writeJson(join(root, file), { openapi: "3.0.3", info: { title, version: title },
    paths: { "/v1/hubs": { get: ok200("Hubs") }, [`/${title}`]: { get: ok200(title) } } });
  variant("contracts/override.json", "override"); variant("contracts/environment.json", "environment");
  variant("contracts/store.json", "store"); variant("openapi.json", "conventional");
  edit(join(root, LAYOUT.environments), config => { config.environments.production.contract = "contracts/environment.json"; });
  edit(storePath(root), store => { store.api.contract = "contracts/store.json"; });
  const agree = (expected, extra = {}) => {
    const model = build(root);
    assert.equal(model.scope.contract, expected);
    const shown = run(root, ["show", "GET /v1/hubs"], extra);
    assert.equal(shown.status, 0, shown.stderr);
    assert.equal(JSON.parse(shown.stdout).observation_summary.scope.contractDigest, model.scope.contract_digest, `show binds ${expected}`);
  };
  process.env.API_CONTRACT = join(root, "contracts/override.json");
  try { agree("contracts/override.json"); } finally { delete process.env.API_CONTRACT; }
  agree("contracts/environment.json");
  edit(join(root, LAYOUT.environments), config => { delete config.environments.production.contract; });
  agree("contracts/store.json");
  edit(storePath(root), store => { delete store.api.contract; });
  agree("openapi.json");
});
