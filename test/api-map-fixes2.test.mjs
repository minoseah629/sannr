// STACKS-1B: live captures use real named stacks. Historical map/view
// controls read an explicit saved legacy projection in a separate directory;
// named-stack map integration belongs to STACKS-2 and is not claimed here.
// MAP-1A fix round 2: the rulings on QA round 2's F1–F9, each pinned.
// Synthetic only: temp projects, an isolated registry home, and real client
// captures against loopback servers that run in their own process (the client
// is driven with spawnSync, which blocks this one).
//
//   node --test test/api-map-fixes2.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "../lib/layout.mjs";
import { HOME_ENV_NAME, ENV_PREFIX } from "../lib/brand.mjs";
import { buildApiMapModel as buildRaw, renderApiMapHtml, escapeText } from "../lib/api-map.mjs";
import { buildViewModel as viewRaw, renderViewHtml } from "../lib/view.mjs";
import { contractMount, loadHttpContract } from "../lib/http-operation-context.mjs";
import { readContract } from "../lib/context.mjs";
import { seedApiMapFixture, AT, MARKERS, CONTRACT } from "./fixtures/api-map/fixture.mjs";

import { createFixtureStack, fixtureContextFile, historicalFixtureProjection, registerHistoricalFixtureProjection } from "./helpers/stack-fixture.mjs";

const buildApiMapModel = (root, options) => buildRaw(historicalFixtureProjection(root), options);
const buildViewModel = (root, options) => viewRaw(historicalFixtureProjection(root), options);
const storePath = root => existsSync(fixtureContextFile(root)) ? fixtureContextFile(root) : join(root, LAYOUT.context);

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs"), REQUEST = join(ROOT, "bin/request.mjs");
const SERVER = join(ROOT, "test/fixtures/api-map/any-server.mjs");
// The literals the loopback server puts in every body (see its source).
const SERVER_MARKERS = ["ANYMARK_BODY_2e8c", "ANYMARK_ITEM_6d1f"];
for (const key of Object.keys(process.env)) if (key.startsWith("API_") || key.startsWith(`${ENV_PREFIX}_`)) delete process.env[key];
process.env.HEARTH_TOKEN = MARKERS.token;

function project(t, name = "api-map-fix2-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  spawnSync("git", ["init", "-q", root]);
  return root;
}
const envFor = root => ({ [HOME_ENV_NAME]: join(root, ".home"), API_USAGE_LOG: join(root, ".usage.jsonl") });
const cliEnv = root => ({ ...process.env, ...envFor(root) });
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ["map", "view"].includes(args[0]) ? historicalFixtureProjection(root) : root, env: cliEnv(root), encoding: "utf8" });
const build = root => buildApiMapModel(root, { now: Date.parse(AT), env: envFor(root) });
const row = (model, op) => model.operations.find(item => item.op === op);
const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const edit = (path, fn) => { const value = readJson(path); fn(value); writeJson(path, value); };
const hearth = t => { const root = project(t); seedApiMapFixture(root); return root; };
const ok200 = summary => ({ summary, responses: { 200: { description: "OK" } } });
// Page text as a reader sees it: the escaper encodes ( = @ ' " so prose stays
// prose under the view's active-content guard.
const pageText = html => html.replaceAll("&#40;", "(").replaceAll("&#61;", "=").replaceAll("&#64;", "@").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
const viewPage = root => {
  const result = run(root, ["view", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return readFileSync(JSON.parse(result.stdout).path, "utf8");
};
// `map` writes the footprint with the API map section; every surface it prints.
const mapSurfaces = root => {
  const map = run(root, ["map", ".", "--no-execute"]);
  assert.equal(map.status, 0, map.stdout + map.stderr);
  assert.doesNotMatch(map.stderr, /API_MAP_UNAVAILABLE/);
  const page = readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8");
  assert.match(page, /id="api-map"/, "the API map section is written");
  const json = run(root, ["map", ".", "--no-execute", "--json"]);
  assert.equal(json.status, 0, json.stderr);
  return { page, receipt: map.stdout + map.stderr, json: json.stdout, text: run(root, ["map", ".", "--no-execute", "--text"]).stdout };
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
function send(root, request) {
  const result = spawnSync(process.execPath, [REQUEST, "envelope", JSON.stringify({ v: 2, on_failure: "continue", requests: [request] })],
    { cwd: root, env: cliEnv(root), encoding: "utf8" });
  assert.equal(result.status === 0 || result.status === 1, true, result.stderr);
  return JSON.parse(result.stdout).results[0];
}
// A consumer project with its own contract and environment, store initialised.
function consumer(t, { baseUrl, paths }) {
  const root = project(t);
  writeJson(join(root, "contracts/c.json"), { openapi: "3.0.3", info: { title: "Items", version: "1" },
    paths: Object.fromEntries(Object.entries(paths).map(([path, value]) => [path, value ?? { get: ok200(path) }])) });
  createFixtureStack(root, { baseUrl, contract: "contracts/c.json" });
  registerHistoricalFixtureProjection(t, root);
  const init = run(root, ["init"]);
  assert.equal(init.status, 0, init.stdout + init.stderr);
  return root;
}
const storedIdentities = root => Object.values(readJson(storePath(root)).api_context?.operations ?? {})
  .map(entry => [entry.identity.operation, entry.identity.endpoint]).sort();
const drift = result => JSON.stringify(result).includes("undeclared-path");
const showConfidence = (root, op) => {
  const shown = run(root, ["show", op]);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  return JSON.parse(shown.stdout);
};

// --- F1, F5 and the earlier refusals: view withholds, never refuses ---------------

const storedLink = (overrides = {}) => ({ param: "id", location: "path", source: { operation: "GET /things", field: "data[].id" },
  first_observed_at: "2026-10-01T00:00:00.000Z", last_observed_at: "2026-10-01T00:00:00.000Z", also_seen: 0,
  evidence: { run_id: "run-aaaa", digest: `sha256:${"a".repeat(64)}` }, ...overrides });

test("MAP-1A fix2 F1: secret- or email-shaped text in a damaged key_sources list never refuses view; map and show agree", t => {
  for (const [label, override, secret] of [
    ["a secret-shaped param", { param: "sk_live_abcdefghijklmnop" }, "sk_live_abcdefghijklmnop"],
    ["a secret-shaped field", { source: { operation: "GET /things", field: "data[].sk_live_abcdefghijklmnop" } }, "sk_live_abcdefghijklmnop"],
    ["an email-shaped field", { source: { operation: "GET /things", field: "data[].person@example.invalid" } }, "person@example.invalid"],
  ]) {
    const root = project(t);
    const seeded = seedApiMapFixture(root);
    edit(storePath(root), store => {
      store.api_context.operations[seeded.operationId("GET /v1/hubs/{hubId}")].key_sources = [storedLink(override)];
    });
    const page = viewPage(root);
    assert.ok(!page.includes(secret), `${label}: the view page`);
    // The damaged list is counted and its links are absent; the operation keeps
    // its standing and nothing else about it is withheld.
    assert.match(pageText(page), /2 operation records have a damaged key-source list; their links are treated as absent\./, label);
    assert.match(page, /<summary><code>GET \/v1\/hubs\/\{hubId\}<\/code> <span class="state">observed · observed · learned unverified<\/span>/, label);
    assert.doesNotMatch(page, /id="withheld"/, `${label}: a damaged list is not rendered, so nothing on the page is withheld`);
    const surfaces = mapSurfaces(root);
    for (const [surface, text] of Object.entries(surfaces)) assert.ok(!text.includes(secret), `${label}: map ${surface}`);
    const shown = showConfidence(root, "GET /v1/hubs/{hubId}");
    assert.equal(shown.confidence, "observed", label);
    assert.ok(!JSON.stringify(shown).includes(secret), `${label}: show`);
  }
});

test("MAP-1A fix2 F5: a secret-shaped environment name reads withheld and is counted; view and map write the page", t => {
  const root = hearth(t);
  const name = "ghp_" + "z".repeat(36);
  edit(join(root, LAYOUT.environments), config => { config.environments[name] = config.environments.production; config.default = name; });
  const model = build(root);
  assert.deepEqual([model.scope.state, model.scope.environment], ["unresolved", "withheld"]);
  assert.match(model.scope.reason, /^the selected environment name cannot be stored/);
  assert.deepEqual(model.withheld, { "environment-name": 1 });
  const page = viewPage(root);
  assert.ok(!page.includes(name), "the view page");
  assert.match(pageText(page), /Scope unresolved: the selected environment name cannot be stored [^<]*\. Environment withheld; no response can be counted\./);
  assert.match(pageText(page), /<p class="basis" id="withheld">Withheld by the secret and promotion scans: 1 environment name\. Each reads withheld where it would render\.<\/p>/);
  const surfaces = mapSurfaces(root);
  assert.match(pageText(surfaces.page), /Withheld by the secret and promotion scans: 1 environment name\./);
  assert.deepEqual(JSON.parse(surfaces.json).api_map.withheld, { "environment-name": 1 });
  for (const [surface, text] of Object.entries(surfaces)) assert.ok(!text.includes(name), `map ${surface}`);
});

test("MAP-1A fix2: a secret-shaped key in the store's operations reads withheld in the map and the details, counted once; view and map write", t => {
  const root = hearth(t);
  const secret = "AKIAIOSFODNN7EXAMPLE";
  edit(storePath(root), store => { store.operations[`GET /v1/keys/${secret}`] = { fields: {}, verified_at: null }; });
  assert.deepEqual(build(root).withheld, { "operation-key": 1 });
  const page = viewPage(root);
  assert.ok(!page.includes(secret));
  assert.match(page, /<summary><code>withheld<\/code> <span class="state">unverified<\/span><\/summary>/, "the details card");
  assert.match(page, /path withheld \(secret-shaped\)/, "the API map row");
  assert.match(pageText(page), /Withheld by the secret and promotion scans: 1 stored operation key\./, "counted once for two sections");
  for (const [surface, text] of Object.entries(mapSurfaces(root))) assert.ok(!text.includes(secret), `map ${surface}`);
});

test("MAP-1A fix2: a secret- or email-shaped declared enum value, response property name or summary reads withheld and is counted; view and map write", t => {
  const email = "support@hearth.example";
  const responseSchema = properties => ({ "application/json": { schema: { type: "object", properties } } });
  for (const [label, change, line, shown] of [
    ["a declared enum value", contract => { contract.paths["/v1/hubs"].get.responses["200"].content = responseSchema({ contact: { type: "string", enum: [email, "none"] } }); },
      "1 declared enum value", /<code>\$\.contact<\/code>: <code>string<\/code>; declared enum \["withheld","none"\]/],
    ["a response property name", contract => { contract.paths["/v1/hubs"].get.responses["200"].content = responseSchema({ [email]: { type: "string" } }); },
      "1 declared field name or type", /<code>withheld<\/code>: <code>string<\/code>/],
    ["a summary", contract => { contract.paths["/v1/hubs"].get.summary = `Mail ${email}`; },
      "1 contract tag or summary", /<td>withheld<\/td>/],
  ]) {
    const root = hearth(t);
    edit(join(root, CONTRACT), change);
    const page = viewPage(root);
    assert.ok(!page.includes(email) && !pageText(page).includes(email), `${label}: the view page`);
    assert.match(pageText(page), new RegExp(`Withheld by the secret and promotion scans: ${line}\\.`), label);
    assert.match(pageText(page), shown, `${label}: withheld where it would render`);
    for (const [surface, text] of Object.entries(mapSurfaces(root))) assert.ok(!pageText(text).includes(email), `${label}: map ${surface}`);
  }
});

test("MAP-1A fix2: a stored parameter name the scan flags reads withheld in the qualifier, counted only where the qualifier is shown", t => {
  const root = hearth(t);
  // Email-shaped by the promotion boundary's rule, though the secret scan's
  // email pattern (a two-letter top-level domain) misses it, so the store keeps
  // it; a secret-shaped name never gets this far (the store's read refuses it).
  const email = "user@host.x";
  // A hand-edited store: the passing tasks read and the 404 member read each
  // record that parameter name, which the contract does not declare.
  edit(storePath(root), store => {
    for (const [op, index] of [["GET /v1/hubs/{hubId}/tasks", 1], ["GET /v1/hubs/{hubId}/members/{memberId}", 0]]) {
      const entry = Object.values(store.api_context.operations).find(item => item.identity.operation === op);
      entry.observations[index].request_shape.properties.params = { type: "object", properties: { [email]: { type: "string" }, page_cursor: { type: "string" } } };
    }
  });
  const model = build(root);
  assert.equal(row(model, "GET /v1/hubs/{hubId}/tasks").standing.qualifiers.at(-1), "using parameters the contract does not declare: page_cursor, withheld");
  assert.equal(row(model, "GET /v1/hubs/{hubId}/members/{memberId}").standing.key, "latest-response");
  assert.deepEqual(model.withheld, { "parameter-name": 1 }, "the 404 read shows no qualifier, so its name is not counted");
  const page = viewPage(root);
  assert.ok(!pageText(page).includes(email));
  assert.match(pageText(page), /Withheld by the secret and promotion scans: 1 parameter name\./);
});

test("MAP-1A fix2: note prose, measured names, verdicts, saved reports and MCP inspections withhold flagged text instead of refusing the page", t => {
  const root = hearth(t);
  const secret = "ghp_" + "w".repeat(36), email = "owner@example.test";
  edit(storePath(root), store => {
    const me = store.operations["GET /v1/me"];
    me.notes.push(`Rotate ${secret} monthly.`);
    Object.assign(me, { verified_at: "2026-09-29T10:00:00.000Z", verified_by: "learn", environment: "production",
      fields: { [email]: { type: "string" }, id: { type: "string" } } });
    // One verdict whose reason a hand edit made secret-shaped, and one whose
    // name and decision compose a credential-shaped line ("…token: rejected").
    store.verdicts = {
      "vendor/billing": { verdict: "rejected", class: "structural", reason: `Rotated after ${secret} leaked.`, last_confirmed: "2026-09-30" },
      "auth/token": { verdict: "rejected", class: "structural", reason: "No refresh flow.", last_confirmed: "2026-09-30" },
    };
    store.mcp_inspections = [{ at: "2026-09-30T00:00:00.000Z", initialized: true,
      server: { name: "tools", label: secret, version: "1", protocolVersion: "2025-06-18", transport: "stdio" },
      capabilities: {}, instructions: `Use ${secret}.`,
      declared: { tools: [], resources: { state: "not_declared" }, resourceTemplates: { state: "not_declared" }, prompts: { state: "not_declared" } }, measured: [] }];
  });
  // An accepted baseline (the audit section shows the saved summary beside it)
  // and a saved audit summary written before the record scan existed. The
  // summary's and the MCP report's own renderers already withhold a flagged
  // cell; what they print passes the scan line by line all the same.
  writeJson(join(root, LAYOUT.baseline), { version: 1, generated_at: "2026-09-29", findings: [
    { key: "GET /v1/hubs:missing", service: secret, op: "GET /v1/hubs", kind: "missing", severity: "high", where: "hearth" }] });
  writeJson(join(root, LAYOUT.evidence, "view", "records", "audit.json"), { version: 1, kind: "audit", source: "audit", basis: "Recorded CLI result",
    at: "2026-09-30T00:00:00.000Z", head: null, model: { added: [{ op: "GET /v1/me", service: secret, kind: "missing", severity: "high" }], resolved: [], unchanged: 0 } });
  const page = viewPage(root);
  assert.ok(!page.includes(secret) && !pageText(page).includes(email), "nothing flagged reaches the page");
  const line = pageText(page).match(/<p class="basis" id="withheld">([^<]*)<\/p>/)?.[1];
  assert.equal(line, "Withheld by the secret and promotion scans: 1 measured field name or type; 1 note; 2 verdict fields or lines; "
    + "1 saved report field or line; 1 MCP inspection field or line. Each reads withheld where it would render.");
  assert.match(page, /<code>withheld<\/code>: <code>string<\/code>/, "the measured name");
  assert.equal(page.split("<li><p>withheld</p><p>Last confirmed: 2026-09-30.</p></li>").length - 1, 2, "both composed verdict lines read withheld");
  assert.match(page, /<li>withheld · GET \/v1\/hubs · missing · high<\/li>/, "the baseline finding's service");
  assert.match(page, /<summary>withheld · 2026-09-30T00:00:00\.000Z<\/summary>/, "the MCP label");
});

test("MAP-1A fix2: the last guard reads the rendered page with its entities decoded and names the section a missed value reached", t => {
  const root = hearth(t);
  const model = buildViewModel(root, { generatedAt: AT, env: envFor(root) });
  assert.match(renderViewHtml(model), /<\/html>/, "the fixture page renders");
  // generated_at is the page's own text, never withheld; planting a value in it
  // stands for a value withholding missed.
  assert.throws(() => renderViewHtml({ ...model, generated_at: `2026-10-01 ${"ghp_" + "g".repeat(36)}` }),
    error => error.code === "VIEW_WITHHOLDING_MISSED" && error.section === "header" && !error.message.includes("ghp_"));
  // An email the escaper encodes ("@" as "&#64;") is still found.
  assert.throws(() => renderViewHtml({ ...model, generated_at: "2026-10-01 owner@example.test" }),
    error => error.code === "VIEW_WITHHOLDING_MISSED" && error.section === "header");
  assert.throws(() => renderViewHtml({ ...model, api_map: { ...model.api_map, name: "Hearth owner@example.test" } }),
    error => error.code === "VIEW_WITHHOLDING_MISSED" && error.section === "api-map");
});

// --- F2: the mount decision is template-aware --------------------------------------

test("MAP-1A fix2 F2: a contract route covers the base path segment by segment, a template segment matching any one segment", () => {
  const contract = (...paths) => ({ routes: paths.map(path => ({ method: "GET", op: `GET ${path}`, path, endpointPath: path })) });
  for (const [base, paths, mount] of [
    ["https://h.test/acme", ["/{tenant}/items"], ""],
    ["https://h.test/ex/jira/abc", ["/ex/jira/{cloudid}/rest/api/3/issue"], ""],
    ["https://h.test/v2", ["/v{major}/items"], ""],
    ["https://h.test/a/b", ["/{x}/{y}/c"], ""],
    ["https://h.test/a/b", ["/{x}"], "/a/b"],
    ["https://h.test/api", ["/v1/items", "/v1/items/{itemId}"], "/api"],
    ["https://h.test/api/", ["/v1/items"], "/api"],
    ["https://h.test/api", ["/api-docs"], "/api"],
    ["https://h.test/api", ["/api/v1/items", "/health"], ""],
    ["https://h.test/caf%C3%A9", ["/café/menu"], ""],
    ["https://h.test", ["/v1/items"], ""],
  ]) assert.equal(contractMount(contract(...paths), base), mount, `${base} over ${paths.join(", ")}`);
  // One decision per contract and base path, shared by every caller.
  const shared = contract("/{tenant}/items");
  assert.equal(contractMount(shared, "https://h.test/acme"), contractMount(shared, "https://h.test/acme"));
});

test("MAP-1A fix2 F2: QA's template-covered base paths capture, report no drift, and the map and show agree", async t => {
  const port = await startServer(t), origin = `http://127.0.0.1:${port}`;
  for (const { base, route, request } of [
    { base: "/acme", route: "/{tenant}/items", request: "/items" },
    { base: "/ex/jira/abc", route: "/ex/jira/{cloudid}/rest/api/3/issue", request: "/rest/api/3/issue" },
  ]) {
    const root = consumer(t, { baseUrl: `${origin}${base}`, paths: { [route]: null } });
    const result = send(root, { method: "GET", path: request, expect: [{ status: 200 }] });
    assert.equal(result.context_capture?.state, "captured", `${base}: ${JSON.stringify(result.context_capture)}`);
    assert.ok(!drift(result), `${base}: the contract declares the path`);
    assert.deepEqual(storedIdentities(root), [[`GET ${route}`, `${origin}${route}`]], base);
    const model = buildApiMapModel(root, { env: envFor(root) });
    assert.equal(row(model, `GET ${route}`).standing.key, "observed", base);
    assert.equal(showConfidence(root, `GET ${route}`).confidence, "observed", base);
  }
});

test("MAP-1A fix2 F2: a base path no route covers mounts the contract below it; an undeclared request drifts; capture, map and show agree", async t => {
  const port = await startServer(t), origin = `http://127.0.0.1:${port}`;
  // Round 1's prefixed case stays mounted.
  const prefixed = consumer(t, { baseUrl: `${origin}/api`, paths: { "/v1/items": null, "/v1/items/{itemId}": null } });
  for (const path of ["/v1/items", "/v1/items/abc123"]) {
    const result = send(prefixed, { method: "GET", path, expect: [{ status: 200 }] });
    assert.equal(result.context_capture?.state, "captured", path);
    assert.ok(!drift(result), path);
  }
  assert.deepEqual(storedIdentities(prefixed), [["GET /v1/items", `${origin}/api/v1/items`], ["GET /v1/items/{itemId}", `${origin}/api/v1/items/{itemId}`]]);
  for (const op of ["GET /v1/items", "GET /v1/items/{itemId}"]) {
    assert.equal(row(buildApiMapModel(prefixed, { env: envFor(prefixed) }), op).standing.key, "observed", op);
    assert.equal(showConfidence(prefixed, op).confidence, "observed", op);
  }
  // A base path no route matches at all: the declared request binds below it;
  // a request the contract does not declare is limited, drifts and is not stored.
  const gateway = consumer(t, { baseUrl: `${origin}/gateway`, paths: { "/v1/items": null } });
  const declared = send(gateway, { method: "GET", path: "/v1/items", expect: [{ status: 200 }] });
  assert.equal(declared.context_capture?.state, "captured");
  assert.ok(!drift(declared));
  const undeclared = send(gateway, { method: "GET", path: "/v2/other", expect: [{ status: 200 }] });
  assert.deepEqual([undeclared.context_capture?.state, undeclared.context_capture?.code], ["limited", "HTTP_CONTEXT_ROUTE_UNRESOLVED"]);
  assert.ok(drift(undeclared), "an undeclared path is reported");
  assert.deepEqual(storedIdentities(gateway), [["GET /v1/items", `${origin}/gateway/v1/items`]]);
  const gatewayModel = buildApiMapModel(gateway, { env: envFor(gateway) });
  assert.deepEqual(gatewayModel.operations.map(item => [item.op, item.standing.key]), [["GET /v1/items", "observed"]]);
  assert.equal(showConfidence(gateway, "GET /v1/items").confidence, "observed");
});

test("MAP-1A fix2 F2: a mixed contract is used as written; capture, drift, the map and show agree on every operation", async t => {
  const port = await startServer(t), origin = `http://127.0.0.1:${port}`;
  const root = consumer(t, { baseUrl: `${origin}/api`, paths: { "/api/v1/items": null, "/health": null } });
  const items = send(root, { method: "GET", path: "/v1/items", expect: [{ status: 200 }] });
  assert.equal(items.context_capture?.state, "captured");
  assert.ok(!drift(items));
  // As written, /health sits outside the base URL's path: a request to it from
  // this base URL is /api/health, which the contract does not declare.
  const health = send(root, { method: "GET", path: "/health", expect: [{ status: 200 }] });
  assert.equal(health.context_capture?.state, "limited");
  assert.ok(drift(health));
  assert.deepEqual(storedIdentities(root), [["GET /api/v1/items", `${origin}/api/v1/items`]]);
  const model = buildApiMapModel(root, { env: envFor(root) });
  assert.equal(row(model, "GET /api/v1/items").standing.key, "observed");
  assert.deepEqual(row(model, "GET /health").standing.qualifiers, ["its path is outside the configured base URL's path"]);
  assert.equal(showConfidence(root, "GET /api/v1/items").confidence, "observed");
  assert.equal(showConfidence(root, "GET /health").observation_summary.scope_reason, "outside-base-path");
});

// --- F3 and F4: query names ----------------------------------------------------------

test("MAP-1A fix2 F3: a query component without '=' is a value and is never recorded as a name", async t => {
  const port = await startServer(t);
  const root = consumer(t, { baseUrl: `http://127.0.0.1:${port}`, paths: { "/v1/items": null } });
  const tokens = ["1696500000", "d41d8cd98f00b204e9800998ecf8427e", "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c"];
  for (const token of tokens) assert.equal(send(root, { method: "GET", path: `/v1/items?${token}`, expect: [{ status: 200 }] }).context_capture?.state, "captured", token);
  assert.equal(send(root, { method: "GET", path: "/v1/items?flag", expect: [{ status: 200 }] }).context_capture?.state, "captured");
  // Written with "=", a name still passes the promotion field-name scan.
  assert.equal(send(root, { method: "GET", path: "/v1/items?page=2&flag&owner@example.test=1", expect: [{ status: 200 }] }).context_capture?.state, "captured");
  const store = readFileSync(storePath(root), "utf8");
  const entry = Object.values(JSON.parse(store).api_context.operations).find(item => item.identity.operation === "GET /v1/items");
  assert.deepEqual(entry.observations.map(observation => Object.keys(observation.request_shape.properties.params.properties)),
    [[], [], [], [], ["page"]], "only page, written with '=', is a name");
  const page = viewPage(root);
  const map = mapSurfaces(root);
  const shown = run(root, ["show", "GET /v1/items"]);
  for (const value of [...tokens, "owner@example.test", ...SERVER_MARKERS])
    for (const [surface, text] of Object.entries({ store, show: shown.stdout + shown.stderr, view: page, ...map }))
      assert.ok(!text.includes(value), `${surface} holds ${value}`);
  assert.deepEqual(row(buildApiMapModel(root, { env: envFor(root) }), "GET /v1/items").standing.qualifiers,
    ["using parameters the contract does not declare: page"]);
});

test("MAP-1A fix2 F4: a query name the store's own scans refuse is withheld and counted, and the capture proceeds", async t => {
  const port = await startServer(t);
  const root = consumer(t, { baseUrl: `http://127.0.0.1:${port}`, paths: { "/v1/items": null } });
  for (const path of ["/v1/items?basic:abc=1", "/v1/items?oauth:a:b=1", "/v1/items?ok=1&basic:x=2"]) {
    const result = send(root, { method: "GET", path, expect: [{ status: 200 }] });
    assert.equal(result.context_capture?.state, "captured", `${path}: ${JSON.stringify(result.context_capture)}`);
  }
  // A structured params name the store would refuse is dropped the same way.
  const structured = send(root, { method: "GET", path: "/v1/items", params: { "basic:abc": "1", keep: "2" }, expect: [{ status: 200 }] });
  assert.equal(structured.context_capture?.state, "captured", JSON.stringify(structured.context_capture));
  const store = readFileSync(storePath(root), "utf8");
  const entry = Object.values(JSON.parse(store).api_context.operations).find(item => item.identity.operation === "GET /v1/items");
  assert.deepEqual(entry.observations.map(observation => Object.keys(observation.request_shape.properties.params.properties)),
    [[], [], ["ok"], ["keep"]]);
  for (const observation of entry.observations)
    assert.ok(observation.omissions.includes("1 query name withheld by the secret and promotion scans; the names are not recorded."), JSON.stringify(observation.omissions));
  for (const name of ["basic:abc", "oauth:a:b", "basic:x"]) assert.ok(!store.includes(name), `the store holds ${name}`);
});

// --- F6: one comparison form for contract and request paths ---------------------

test("MAP-1A fix2 F6: contract and request paths are compared in one form; a path that still cannot match gets an accurate reason", async t => {
  const port = await startServer(t), origin = `http://127.0.0.1:${port}`;
  const root = consumer(t, { baseUrl: origin, paths: { "/v1/café": null, "/v1/a^b": null, "/v1/plain": null,
    "/v1/zero\u200bwidth": null, "/v1/%2e%2e/x": null } });
  for (const path of ["/v1/café", "/v1/caf%c3%a9", "/v1/a^b"]) {
    const result = send(root, { method: "GET", path, expect: [{ status: 200 }] });
    assert.equal(result.context_capture?.state, "captured", `${path}: ${JSON.stringify(result.context_capture)}`);
    assert.ok(!drift(result), path);
  }
  assert.deepEqual(storedIdentities(root), [["GET /v1/a^b", `${origin}/v1/a^b`], ["GET /v1/café", `${origin}/v1/café`]]);
  const model = buildApiMapModel(root, { env: envFor(root) });
  assert.equal(row(model, "GET /v1/café").standing.key, "observed");
  assert.equal(row(model, "GET /v1/café").responses, 2, "both spellings of the request count for the one operation");
  assert.equal(row(model, "GET /v1/a^b").standing.key, "observed");
  // A format character cannot be held in an identity: unavailable, named.
  assert.deepEqual([row(model, "GET /v1/zero\u200bwidth").standing.key, row(model, "GET /v1/zero\u200bwidth").standing.qualifiers],
    ["unavailable", ["CONTEXT_INPUT_INVALID"]]);
  // An encoded dot segment is removed by the URL parser: built into a request
  // URL, the path matches nothing, and the reason says so.
  assert.deepEqual(row(model, "GET /v1/%2e%2e/x").standing.qualifiers, ["built into a request URL, its path matches no operation in the bound contract"]);
  for (const item of model.operations) assert.ok(!item.standing.qualifiers.some(text => /more than one operation/.test(text)), item.op);
  assert.equal(showConfidence(root, "GET /v1/café").confidence, "observed");
  assert.equal(showConfidence(root, "GET /v1/%2e%2e/x").observation_summary.scope_reason, "route-unmatched");
});

// --- F7: a parse failure is unreadable ---------------------------------------------

test("MAP-1A fix2 F7: a contract that fails to parse reads unreadable, never 'declares no operations'", t => {
  const yaml = "contracts/hearth.yaml";
  const useYaml = (root, text) => {
    writeFileSync(join(root, yaml), text);
    edit(join(root, LAYOUT.environments), config => { for (const environment of Object.values(config.environments)) environment.contract = yaml; });
    edit(storePath(root), store => { store.api.contract = yaml; });
  };
  for (const [label, text] of [
    ["malformed flow", "openapi: 3.0.3\npaths:\n  /v1/hubs: [unclosed\n   - : :\n"],
    ["a scalar", "just a string\n"],
    ["binary garbage", "\u0000\u0001\u0002 garbage that is not YAML"],
    ["an unterminated quote", 'openapi: "3.0.3\npaths: {}\n'],
    ["a top-level sequence", "- openapi: 3.0.3\n- paths: {}\n"],
    ["a mapping value holding ': '", "openapi: 3.0.3\npaths: a: b: c\n"],
    ["JSON-looking text that is not JSON", "{ openapi: 3.0.3, paths: {\n"],
  ]) {
    const root = hearth(t);
    useYaml(root, text);
    const model = build(root);
    assert.equal(model.scope.reason, `contract ${yaml} is unreadable`, label);
    assert.ok(readContract(join(root, yaml)).problems?.length, `${label}: the reader names what it skipped`);
    assert.match(pageText(viewPage(root)), new RegExp(`Scope unresolved: contract ${yaml.replace(".", "\\.")} is unreadable`), label);
  }
  // A clean YAML document keeps its own reason.
  const empty = hearth(t);
  useYaml(empty, "openapi: 3.0.3\ninfo:\n  title: Empty\n  version: '1'\npaths: {}\n");
  assert.equal(build(empty).scope.reason, `contract ${yaml} declares no operations`);
  assert.equal(readContract(join(empty, yaml)).problems, undefined);
  const valid = hearth(t);
  useYaml(valid, "openapi: 3.0.3\ninfo:\n  title: One\n  version: '1'\npaths:\n  /v1/hubs:\n    get:\n      summary: List hubs\n      responses:\n        '200':\n          description: OK\n");
  assert.equal(build(valid).scope.state, "bound");
});

// --- F8: one escaper strips format characters --------------------------------------

test("MAP-1A fix2 F8: the one escaper removes every format character but the joiners real scripts and emoji need", t => {
  const removed = ["\u200b", "\u2060", "\ufeff", "\u00ad", "\u180e", "\u206a", "\u{E0001}", "\u{E0041}", "\u202e", "\u0007"];
  assert.equal(escapeText(`a${removed.join("")}b`), "ab");
  assert.equal(escapeText("می\u200cخواهم 👩\u200d💻"), "می\u200cخواهم 👩\u200d💻", "ZWNJ and ZWJ stay");
  assert.equal(escapeText("tab\tnew\nline"), "tab\tnew\nline");
  const root = hearth(t);
  edit(storePath(root), store => {
    const entry = store.operations["GET /v1/hubs/{hubId}/tasks"];
    entry.notes.push("zero\u200bwidth \ufeffbom tag\u{E0041}\u{E0001}s keep\u200cnon\u200djoiner 👩\u200d💻");
    entry.notes_provenance.push({ by: "agent", at: "2026-09-29" });
    entry.notes_superseded.push(null);
  });
  const view = renderViewHtml(buildViewModel(root, { generatedAt: AT, env: envFor(root) }));
  const map = renderApiMapHtml(build(root));
  for (const [surface, html] of Object.entries({ view, map })) {
    assert.doesNotMatch(html, /[\u200b\u2060\ufeff\u00ad\u{E0000}-\u{E007F}]/u, `${surface}: no zero-width, BOM, soft hyphen or tag character`);
    assert.ok(html.includes("zerowidth bom tags keep\u200cnon\u200djoiner 👩\u200d💻"), `${surface}: the note renders one way, joiners kept`);
  }
});

// --- F9: the unresolved-parameter note says what it counts ------------------------

test("MAP-1A fix2 F9: the note counts parameters that cannot be resolved to a name and location, whatever the cause", t => {
  const root = project(t);
  writeJson(join(root, "c/c.json"), { openapi: "3.0.3", info: { title: "t", version: "1" }, paths: {
    "/a": { get: { parameters: [{ name: "q" }], ...ok200("no location") } },
    "/b": { get: { parameters: { name: "q", in: "query" }, ...ok200("not a list") } },
    "/c": { get: { parameters: [{ $ref: "other.json#/Q" }], ...ok200("an external reference") } },
  } });
  writeJson(storePath(root), { v: 0, api: { name: "t", contract: "c/c.json" }, operations: {} });
  const model = buildApiMapModel(root, { env: envFor(root) });
  assert.equal(model.omissions.declared_parameters_unresolved, 3);
  assert.match(pageText(renderApiMapHtml(model)), /3 operations declare parameters that cannot all be resolved to a name and location \(a reference that cannot be resolved, an entry missing either, or a parameters value that is not a list\), so the undeclared-parameter check is skipped for them/);
  assert.ok(existsSync(join(root, "c/c.json")));
});
