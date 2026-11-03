// STACKS-1B: live captures use real named stacks. Historical map/view
// controls read an explicit saved legacy projection in a separate directory;
// named-stack map integration belongs to STACKS-2 and is not claimed here.
// MAP-1A integration round, after MAP-1C merged. The API map reads key sources
// only through MAP-1C's validator (the record the store's query returns and
// its per-record `record_issues`), a key-source name the page scans flag reads
// withheld, and the two changes to the HTTP capture block (MAP-1A's base-URL
// mount and inline query names, MAP-1C's key linking) work together.
// Synthetic only: temp projects, an isolated registry home, and real client
// captures against a loopback server running in its own process. Every client
// and CLI run below is an async spawn, so the process hosting the server never
// blocks.
//
//   node --test test/api-map-integration.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { LAYOUT } from "../lib/layout.mjs";
import { HOME_ENV_NAME, ENV_PREFIX } from "../lib/brand.mjs";
import { queryOperationContext as queryRaw } from "../lib/operation-context.mjs";
import { storedLink, DAMAGED_FORMS, DAMAGED_TEXT } from "./fixtures/key-sources/damaged-forms.mjs";

import { createFixtureStack, fixtureContextFile, fixtureEvidencePath, historicalFixtureProjection, registerHistoricalFixtureProjection, inFixtureStack } from "./helpers/stack-fixture.mjs";
const queryOperationContext = (root, ...args) => inFixtureStack(root, () => queryRaw(root, ...args));

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs"), REQUEST = join(ROOT, "bin/request.mjs");
// The loopback servers' own literals (see their sources): values that live in
// response bodies and request paths and must never reach the store or a page.
const SERVER = join(ROOT, "test/fixtures/api-map/server.mjs"), ITEM = "SRVMARK_ITEM_7b2d";
const ANY_SERVER = join(ROOT, "test/fixtures/api-map/any-server.mjs"), THING = "ANYMARK_ITEM_6d1f";
// A query value written into a request path: private evidence only.
const INLINE_VALUE = "INLINEMARK_full_3c9a";
const MARKERS = ["SRVMARK_BODY_4c1e", ITEM, "SRVMARK_ECHO_9f3a", "ANYMARK_BODY_2e8c", THING, INLINE_VALUE];
for (const key of Object.keys(process.env)) if (key.startsWith("API_") || key.startsWith(`${ENV_PREFIX}_`)) delete process.env[key];

// Loaded on first use, so a tree without the API map fails these tests one by
// one instead of failing to load the file.
const apiMap = () => import("../lib/api-map.mjs");
const view = () => import("../lib/view.mjs");

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const ok = summary => ({ summary, responses: { 200: { description: "OK" } } });
const envFor = root => ({ [HOME_ENV_NAME]: join(root, ".home"), API_USAGE_LOG: join(root, ".usage.jsonl") });
const storePath = fixtureContextFile;
const record = (root, operation) => Object.entries(readJson(storePath(root)).api_context.operations)
  .find(([, entry]) => entry.identity.operation === operation);
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
// Page text as a reader sees it: the escaper encodes ( = @ ' in prose.
const pageText = html => html.replaceAll("&#40;", "(").replaceAll("&#61;", "=").replaceAll("&#64;", "@").replaceAll("&#39;", "'");

async function startServer(t, file) {
  const child = spawn(process.execPath, [file], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGTERM"));
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    child.stdout.on("data", chunk => { buffer += chunk; const match = /PORT (\d+)/.exec(buffer); if (match) resolvePort(Number(match[1])); });
    child.on("exit", code => reject(new Error(`loopback server exited ${code}`)));
  });
}

async function node(root, args) {
  try {
    const result = await execute(process.execPath, args, { cwd: args[0] === CLI && ["map", "view"].includes(args[1]) ? historicalFixtureProjection(root) : root, env: { ...process.env, ...envFor(root) },
      encoding: "utf8", timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
const cli = (root, args) => node(root, [CLI, ...args]);
// One real client request through the request CLI's envelope.
async function send(root, request) {
  const result = await node(root, [REQUEST, "envelope", JSON.stringify({ v: 2, on_failure: "continue", requests: [request] })]);
  assert.ok(result.code === 0 || result.code === 1, result.stderr);
  return JSON.parse(result.stdout).results[0];
}

// A consumer project: its contract, its one environment, the store initialised.
async function consumer(t, { baseUrl, paths }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "api-map-int-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await execute("git", ["init", "-q", root]);
  writeJson(join(root, "contracts/c.json"), { openapi: "3.0.3", info: { title: "Items", version: "1" }, paths });
  createFixtureStack(root, { baseUrl, contract: "contracts/c.json" });
  registerHistoricalFixtureProjection(t, root);
  const init = await cli(root, ["init"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  return root;
}

const build = async root => (await apiMap()).buildApiMapModel(historicalFixtureProjection(root), { env: envFor(root) });
const viewPage = async root => {
  const { buildViewModel, renderViewHtml } = await view();
  return renderViewHtml(buildViewModel(historicalFixtureProjection(root), { env: envFor(root) }));
};
// What a standing is made of, for every operation on the map.
const standings = model => model.operations.map(row => ({ op: row.op, standing: row.standing, responses: row.responses,
  latest: row.latest_status_codes, statuses: row.status_codes, learned: row.learned?.confidence ?? null }));
const slots = model => model.key_slots.map(slot => [slot.param, slot.prefix,
  slot.sources.map(source => `${source.operation} · ${source.field} · seen on ${source.seen_on}`), slot.more]);
// The key table as rendered: one [key, path, comes-from text] per row.
function keyTable(html) {
  const start = html.indexOf("<h3>Where each path key comes from</h3>");
  assert.ok(start >= 0, "the page has the key table");
  const table = html.slice(start, html.indexOf("<h3>Notes</h3>", start));
  return { html: table, rows: [...table.matchAll(/<tr><td><code>([^<]*)<\/code><\/td><td><code>([^<]*)<\/code><\/td><td>([\s\S]*?)<\/td><\/tr>/g)]
    .map(([, key, prefix, from]) => [key, prefix, from.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()]) };
}
const detailsFor = (page, op) => {
  const start = page.indexOf(`<summary><code>${op}</code>`);
  assert.ok(start >= 0, `the view has details for ${op}`);
  return page.slice(start, page.indexOf("</details>", start));
};
function writeKeySources(root, operation, value) {
  const store = readJson(storePath(root));
  const [id] = Object.entries(store.api_context.operations).find(([, entry]) => entry.identity.operation === operation);
  if (value === undefined) delete store.api_context.operations[id].key_sources;
  else store.api_context.operations[id].key_sources = value;
  writeFileSync(storePath(root), JSON.stringify(store, null, 2) + "\n");
}

// A list then a detail through the real client: the detail's record links its
// path key to the list's `data[].id`.
async function things(t) {
  const port = await startServer(t, ANY_SERVER);
  const root = await consumer(t, { baseUrl: `http://127.0.0.1:${port}`,
    paths: { "/things": { get: ok("List things") }, "/things/{id}": { get: ok("Get a thing") } } });
  assert.equal((await send(root, { method: "GET", path: "/things" })).context_capture?.state, "captured");
  assert.equal((await send(root, { method: "GET", path: `/things/${THING}` })).context_capture?.state, "captured");
  return root;
}

test("MAP-1A integration: each of MAP-1C's 19 damaged key_sources forms renders no row, is counted from record_issues and leaves every standing unchanged; a valid entry appears under its path-parameter slot", async t => {
  const root = await things(t);
  const [, captured] = record(root, "GET /things/{id}");
  assert.deepEqual(captured.key_sources.map(item => [item.param, item.location, item.source.operation, item.source.field]),
    [["id", "path", "GET /things", "data[].id"]], "positive control: the real capture recorded the link");
  const { renderApiMapHtml } = await apiMap();
  const clean = await build(root);
  assert.deepEqual(clean.operations.map(row => [row.op, row.standing.key]), [["GET /things", "observed"], ["GET /things/{id}", "observed"]]);
  assert.deepEqual(slots(clean), [["id", "/things/{id}", ["GET /things · data[].id · seen on 1"], 0]]);
  assert.equal(clean.omissions.key_source_records_damaged, 0);

  assert.equal(DAMAGED_FORMS.length, 19);
  for (const value of DAMAGED_FORMS) {
    const label = JSON.stringify(value).slice(0, 100);
    writeKeySources(root, "GET /things/{id}", value);
    // The store's own reader names the record and keeps its observations.
    const queried = queryOperationContext(root, { operation: "GET /things/{id}" }, { env: envFor(root) });
    assert.deepEqual(queried.issues, [], label);
    assert.deepEqual(queried.record_issues?.map(issue => issue.code), ["KEY_SOURCES_INVALID"], label);
    const model = await build(root);
    assert.deepEqual(standings(model), standings(clean), `${label}: every standing is unchanged`);
    assert.deepEqual(model.key_sources, [], `${label}: no link renders`);
    assert.deepEqual(slots(model), [["id", "/things/{id}", [], 0]], `${label}: the slot reads not recorded`);
    assert.equal(model.omissions.key_source_records_damaged, 1, `${label}: counted once`);
    assert.deepEqual(model.issues, [{ code: "KEY_SOURCES_INVALID", operation: "GET /things/{id}" }], label);
    const html = renderApiMapHtml(model);
    assert.deepEqual(keyTable(html).rows, [["id", "/things/{id}", "not recorded"]], label);
    assert.equal(html.match(/operation records? ha(?:s|ve) a damaged key-source list/g)?.length, 1, `${label}: one line counts it`);
    assert.match(html, /1 operation record has a damaged key-source list; its links are treated as absent\./, label);
    const page = await viewPage(root);
    assert.deepEqual(keyTable(page).rows, [["id", "/things/{id}", "not recorded"]], label);
    assert.match(pageText(detailsFor(page, "GET /things/{id}")),
      /The stored key-source list is damaged \(KEY_SOURCES_INVALID\); its links are treated as absent\./, label);
    for (const text of DAMAGED_TEXT) assert.ok(!html.includes(text) && !page.includes(text), `${label}: the page never shows ${text}`);
  }

  // A valid entry appears under its path-parameter slot, and nothing is counted.
  writeKeySources(root, "GET /things/{id}", [storedLink()]);
  const valid = await build(root);
  assert.deepEqual(standings(valid), standings(clean));
  assert.equal(valid.omissions.key_source_records_damaged, 0);
  assert.deepEqual(valid.issues, []);
  assert.deepEqual(slots(valid), [["id", "/things/{id}", ["GET /things · data[].id · seen on 1"], 0]]);
  assert.deepEqual(keyTable(renderApiMapHtml(valid)).rows, [["id", "/things/{id}", "GET /things → data[].id seen on 1 operation"]]);

  // The store's projection governs what renders: an unknown key is dropped,
  // and a method outside the map's own list is a source like any other.
  writeKeySources(root, "GET /things/{id}", [{ ...storedLink(), unknown: "dropped by the store" },
    storedLink({ source: { operation: "PROPFIND /things", field: "data[].id" } })]);
  const projected = await build(root);
  assert.equal(projected.omissions.key_source_records_damaged, 0);
  assert.deepEqual(slots(projected), [["id", "/things/{id}", ["GET /things · data[].id · seen on 1", "PROPFIND /things · data[].id · seen on 1"], 0]]);
  assert.deepEqual(standings(projected), standings(clean));

  // Through the CLI: the damaged form with a space in its name writes the page,
  // counts the record and never prints the name.
  writeKeySources(root, "GET /things/{id}", [storedLink({ param: "two words" })]);
  const written = await cli(root, ["view", "--json"]);
  assert.equal(written.code, 0, written.stdout + written.stderr);
  const page = readFileSync(JSON.parse(written.stdout).path, "utf8");
  assert.match(page, /1 operation record has a damaged key-source list; its links are treated as absent\./);
  assert.ok(!page.includes("two words"));
});

test("MAP-1A integration: a key_sources name the store's final lock refuses is a damaged list, never a reason to withdraw the record's observations", async t => {
  const root = await things(t);
  const clean = await build(root);
  const shownClean = JSON.parse((await cli(root, ["show", "GET /things/{id}"])).stdout);
  assert.equal(shownClean.observation_summary.state, "observed");
  // Each passes MAP-1C's schema; each is a credential reference the store's
  // final scan refuses (an auth reference in a name or an operation).
  const forms = { "an auth-reference parameter": [storedLink({ param: "basic:abc" })],
    "an auth-reference source operation": [storedLink({ source: { operation: "GET /things/{basic:abc}", field: "data[].id" } })],
    "an OAuth-reference parameter": [storedLink({ param: "oauth:a:b" })] };
  for (const [label, value] of Object.entries(forms)) {
    writeKeySources(root, "GET /things/{id}", value);
    const queried = queryOperationContext(root, { operation: "GET /things/{id}" }, { env: envFor(root) });
    assert.deepEqual(queried.issues, [], `${label}: the source stays available`);
    assert.deepEqual(queried.record_issues?.map(issue => issue.code), ["KEY_SOURCES_INVALID"], label);
    assert.equal(queried.operations.length, 1, label);
    assert.equal(Object.hasOwn(queried.operations[0], "key_sources"), false, `${label}: no links`);
    const shown = await cli(root, ["show", "GET /things/{id}"]);
    assert.equal(shown.code, 0, label);
    const detail = JSON.parse(shown.stdout);
    assert.equal(detail.observation_summary.state, "observed", label);
    assert.deepEqual(detail.observation_summary.observations.map(item => item.observation_id),
      shownClean.observation_summary.observations.map(item => item.observation_id), label);
    const model = await build(root);
    assert.deepEqual(standings(model), standings(clean), `${label}: every standing is unchanged`);
    assert.equal(model.omissions.key_source_records_damaged, 1, label);
    assert.deepEqual(slots(model), [["id", "/things/{id}", [], 0]], label);
    for (const text of ["basic:abc", "oauth:a:b"]) assert.ok(!shown.stdout.includes(text), `${label}: show never prints ${text}`);
  }
  // The writers replace it: context keys derives the link again from evidence.
  const keys = JSON.parse((await cli(root, ["context", "keys", "--json"])).stdout);
  assert.equal(keys.replaced_damaged, 1);
  assert.deepEqual(record(root, "GET /things/{id}")[1].key_sources.map(item => [item.param, item.source.operation, item.source.field]),
    [["id", "GET /things", "data[].id"]]);
});

test("MAP-1A integration: a key-source name or field the page scans flag reads withheld where it renders and is counted, never refused", async t => {
  const root = await things(t);
  // The store keeps both (MAP-1C's schema and the store's final lock pass
  // them); the promotion boundary's email rule flags the field on a page.
  const field = "data[].user@host.x";
  writeKeySources(root, "GET /things/{id}", [storedLink({ source: { operation: "GET /things", field } })]);
  const queried = queryOperationContext(root, { operation: "GET /things/{id}" }, { env: envFor(root) });
  assert.equal(queried.operations[0].key_sources[0].source.field, field, "positive control: the store accepts it");
  const model = await build(root);
  assert.equal(model.omissions.key_source_records_damaged, 0);
  assert.deepEqual(model.withheld, { "key-source": 1 });
  assert.deepEqual(model.key_sources.map(item => [item.param, item.source_operation, item.source_field]), [["id", "GET /things", "withheld"]]);
  const written = await cli(root, ["view", "--json"]);
  assert.equal(written.code, 0, written.stdout + written.stderr);
  const page = readFileSync(JSON.parse(written.stdout).path, "utf8");
  assert.deepEqual(keyTable(page).rows, [["id", "/things/{id}", "GET /things → withheld seen on 1 operation"]]);
  assert.match(pageText(detailsFor(page, "GET /things/{id}")), /<code>id<\/code> \(path\) from <code>GET \/things<\/code> → <code>withheld<\/code>/);
  assert.match(page, /Withheld by the secret and promotion scans: 1 key-source record\./);
  assert.ok(!pageText(page).includes("user@host"));
  const map = await cli(root, ["map", ".", "--no-execute"]);
  assert.equal(map.code, 0, map.stdout + map.stderr);
  const mapHtml = readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8");
  assert.deepEqual(keyTable(mapHtml).rows, [["id", "/things/{id}", "GET /things → withheld seen on 1 operation"]]);
  assert.ok(!pageText(mapHtml).includes("user@host"));
  // Two distinct flagged fields stay two sources of the key, each withheld and
  // each record counted once, though both read the same on the page.
  writeKeySources(root, "GET /things/{id}", [storedLink({ source: { operation: "GET /things", field } }),
    storedLink({ source: { operation: "GET /things", field: "data[].owner@host.y" } })]);
  const two = await build(root);
  assert.deepEqual(two.withheld, { "key-source": 2 });
  assert.deepEqual(slots(two), [["id", "/things/{id}", ["GET /things · withheld · seen on 1", "GET /things · withheld · seen on 1"], 0]]);
  const twoPage = await viewPage(root);
  assert.ok(!pageText(twoPage).includes("@host"));
});

// The end-to-end witness: list then detail through the real client, the map's
// key table names where the detail key came from, and `context keys` rebuilds
// exactly that table from evidence after the field is stripped. `mount` is the
// base URL's own path; under "/api" the contract's paths are written without
// it, so capture binds through MAP-1A's mount while MAP-1C links the key.
// `inline` is a query written into the detail's path: MAP-1A records its name
// in the request shape in the same capture that MAP-1C links the path key.
async function listThenDetail(t, mount, { inline = "" } = {}) {
  const port = await startServer(t, SERVER);
  const origin = `http://127.0.0.1:${port}`;
  const root = await consumer(t, { baseUrl: `${origin}${mount}`,
    paths: { "/v1/items": { get: ok("List items") }, "/v1/items/{itemId}": { get: ok("Get an item") } } });
  const list = await send(root, { method: "GET", path: "/v1/items" });
  const detail = await send(root, { method: "GET", path: `/v1/items/${ITEM}${inline}` });
  for (const result of [list, detail]) {
    assert.equal(result.status, 200);
    assert.equal(result.context_capture?.state, "captured", JSON.stringify(result.context_capture));
  }
  const [, stored] = record(root, "GET /v1/items/{itemId}");
  assert.equal(stored.identity.endpoint, `${origin}${mount}/v1/items/{itemId}`, "the identity binds through the mount");
  const listEvidence = readFileSync(join(root, fixtureEvidencePath(), `${list.evidence}.json`));
  const detailObserved = JSON.parse(readFileSync(join(root, fixtureEvidencePath(), `${detail.evidence}.json`), "utf8")).origin.observed_at;
  assert.deepEqual(stored.key_sources, [{ param: "itemId", location: "path", source: { operation: "GET /v1/items", field: "data[].id" },
    first_observed_at: detailObserved, last_observed_at: detailObserved, also_seen: 0,
    evidence: { run_id: list.evidence, digest: sha256(listEvidence) } }]);

  const render = async () => {
    const map = await cli(root, ["map", ".", "--no-execute"]);
    assert.equal(map.code, 0, map.stdout + map.stderr);
    const html = readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8");
    const written = await cli(root, ["view", "--json"]);
    assert.equal(written.code, 0, written.stdout + written.stderr);
    const page = readFileSync(JSON.parse(written.stdout).path, "utf8");
    for (const marker of MARKERS) assert.ok(!html.includes(marker) && !page.includes(marker), `no page shows ${marker}`);
    assert.deepEqual(keyTable(page).html, keyTable(html).html, "view and map render one key table");
    return { html, table: keyTable(html), receipt: map.stdout };
  };
  if (inline) {
    // The inline name is in the shape beside the linked key; its value is not.
    const names = [...new URLSearchParams(inline).keys()];
    assert.deepEqual(Object.keys(stored.observations.at(-1).request_shape.properties.params.properties), names);
    const model = await build(root);
    assert.deepEqual(model.operations.find(row => row.op === "GET /v1/items/{itemId}").standing.qualifiers,
      [`using parameters the contract does not declare: ${names.join(", ")}`]);
  }
  const before = await render();
  assert.deepEqual(before.table.rows, [["itemId", "/v1/items/{itemId}", "GET /v1/items → data[].id seen on 1 operation"]]);
  assert.match(before.receipt, /passing response histories\s+2 \(0 after a failed attempt\)/);
  assert.match(before.receipt, /notes · path keys sourced\s+0 · 1 of 1/);
  const showed = await cli(root, ["show", "GET /v1/items/{itemId}"]);
  for (const marker of MARKERS) assert.ok(!showed.stdout.includes(marker) && !showed.stderr.includes(marker), `show never prints ${marker}`);
  const shown = JSON.parse(showed.stdout);
  assert.equal(shown.observation_summary.state, "observed");
  assert.deepEqual(shown.scoped.operations[0].key_sources, stored.key_sources, "show returns the record the map read");

  writeKeySources(root, "GET /v1/items/{itemId}", undefined);
  assert.deepEqual((await render()).table.rows, [["itemId", "/v1/items/{itemId}", "not recorded"]], "control: stripped");
  const keys = await cli(root, ["context", "keys", "--json"]);
  assert.equal(keys.code, 0, keys.stdout + keys.stderr);
  assert.equal(JSON.parse(keys.stdout).state, "recorded");
  for (const marker of MARKERS) assert.ok(!keys.stdout.includes(marker) && !keys.stderr.includes(marker));
  assert.deepEqual(record(root, "GET /v1/items/{itemId}")[1].key_sources, stored.key_sources, "the backfill derives what capture recorded");
  const after = await render();
  assert.equal(after.table.html, before.table.html, "an identical table");
  const text = readFileSync(storePath(root), "utf8");
  for (const marker of MARKERS) assert.ok(!text.includes(marker), `the store never holds ${marker}`);
}

test("MAP-1A integration witness: list then detail through the real client, the map's key table names the source, and context keys rebuilds the same table", async t => {
  await listThenDetail(t, "");
});

test("MAP-1A integration: under a prefixed base URL, capture binds through the mount, records an inline query name and links the key source, so both capture changes work together", async t => {
  await listThenDetail(t, "/api", { inline: `?view=${INLINE_VALUE}` });
});
