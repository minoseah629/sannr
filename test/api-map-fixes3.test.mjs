// STACKS-1B: live captures use real named stacks. Historical map/view
// controls read an explicit saved legacy projection in a separate directory;
// named-stack map integration belongs to STACKS-2 and is not claimed here.
// MAP-1A fix round 3: the lead's rulings after the integration QA (F1, F2 and
// the wording), each pinned. Synthetic only: temp projects, isolated registry
// homes, real client captures against loopback servers that run in their own
// process, and async spawns for every client and CLI run, so the process
// hosting a server is never blocked.
//
// F1: key sources never cost a record its place in a bounded answer; room for
//     record_issues is reserved; the omission is counted.
// F2: the audit's finding for a probe that substitutes a listed id names the
//     operation, the operation that listed the id and its field, never the id.
// Wording: show and the map describe a record the budget left out alike.
//
//   node --test test/api-map-fixes3.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "../lib/layout.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { HOME_ENV_NAME, ENV_PREFIX } from "../lib/brand.mjs";
import { captureOperationContext as captureRaw, operationId, queryOperationContext as queryRaw } from "../lib/operation-context.mjs";
import { projectKeySources } from "../lib/key-sources.mjs";
import { emptyRegistry, grant, registerRepo, saveRegistry } from "../lib/registry.mjs";
import { ciFindings } from "../lib/ci.mjs";
import { storedLink } from "./fixtures/key-sources/damaged-forms.mjs";

import { createFixtureStack, fixtureContextFile, historicalFixtureProjection, registerHistoricalFixtureProjection, inFixtureStack } from "./helpers/stack-fixture.mjs";
const captureOperationContext = (root, ...args) => inFixtureStack(root, () => captureRaw(root, ...args));
const queryOperationContext = (root, ...args) => inFixtureStack(root, () => queryRaw(root, ...args));

const execute = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs"), REQUEST = join(ROOT, "bin/request.mjs");
const SIZED = join(ROOT, "test/fixtures/api-map/sized-server.mjs");
const LISTED = join(ROOT, "test/fixtures/api-map/listed-id-server.mjs");
// The loopback servers' own literals (see their sources): response values that
// must never reach the store, a finding, a page or a committed file.
const ITEM = "SIZEDMARK_ITEM_5e7a";
const SIZED_MARKERS = [ITEM, "SIZEDMARK_LEAF_8c2d"];
const LISTED_MARKERS = ["LISTEDMARK_HUB_3a9f", "LISTEDMARK_ROOM_6b1d", "LISTEDMARK_DAY_0c4e", "LISTEDMARK_BODY_7e2a", "1999-12-31"];
const MIB = 1024 * 1024;
const READ_BOUND = "history beyond the read bound";
for (const key of Object.keys(process.env)) if (key.startsWith("API_") || key.startsWith(`${ENV_PREFIX}_`)) delete process.env[key];

// Loaded on first use, so a tree without these exports fails the tests that
// use them one by one instead of failing to load the file.
const checks = () => import("../lib/checks.mjs");

const readJson = path => JSON.parse(readFileSync(path, "utf8"));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); };
const ok = summary => ({ summary, responses: { 200: { description: "OK" } } });
const envFor = root => ({ [HOME_ENV_NAME]: join(root, ".home"), API_USAGE_LOG: join(root, ".usage.jsonl") });
const storePath = fixtureContextFile;
const record = (root, operation) => Object.entries(readJson(storePath(root)).api_context.operations)
  .find(([, entry]) => entry.identity.operation === operation);
const size = value => Buffer.byteLength(JSON.stringify(value));
// Page text as a reader sees it: the escaper encodes ( = @ ' in prose.
const pageText = html => html.replaceAll("&#40;", "(").replaceAll("&#61;", "=").replaceAll("&#64;", "@").replaceAll("&#39;", "'").replaceAll("&quot;", '"');

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
      encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}
const cli = (root, args) => node(root, [CLI, ...args]);
async function send(root, request) {
  const result = await node(root, [REQUEST, "envelope", JSON.stringify({ v: 2, on_failure: "continue", requests: [request] })]);
  assert.ok(result.code === 0 || result.code === 1, result.stderr);
  return JSON.parse(result.stdout).results[0];
}
// A consumer project: its contract at the root, its one environment, the store
// initialised.
async function consumer(t, { baseUrl, paths, name, historicalAudit = false }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  await execute("git", ["init", "-q", root]);
  writeJson(join(root, "openapi.json"), { openapi: "3.0.3", info: { title: "Round three", version: "1" }, paths });
  if (historicalAudit) writeJson(join(root, LAYOUT.environments), { v: 1, default: "local", environments: { local: { baseUrl, contract: "openapi.json" } } });
  else {
    createFixtureStack(root, { baseUrl, contract: "openapi.json" });
    registerHistoricalFixtureProjection(t, root);
  }
  const init = await cli(root, ["init"]);
  assert.equal(init.code, 0, init.stdout + init.stderr);
  return root;
}
// Every file under the project except private evidence (where values live).
function committedText(root) {
  const out = [], evidence = join(root, LAYOUT.evidence);
  const walk = dir => { for (const name of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, name.name);
    if (path === evidence || name.name === ".git") continue;
    if (name.isDirectory()) walk(path); else out.push([path, readFileSync(path, "utf8")]);
  } };
  walk(root);
  return out;
}

// --- F1: in-process, at exact budgets ------------------------------------------

const PROVIDER = "http://127.0.0.1:4310";
const identityFor = operation => ({ v: 1, stack: "fixture", provider: PROVIDER, environment: "local", protocol: "http", operation,
  endpoint: `${PROVIDER}${operation.split(" ")[1]}`, contractDigest: `sha256:${"c".repeat(64)}` });
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "api-map-fix3-unit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { [HOME_ENV_NAME]: join(root, "isolated-registry") };
  createFixtureStack(root, { baseUrl: PROVIDER });
  const capture = operation => captureOperationContext(root, { identity: identityFor(operation), source: { tool: "api_request:http" },
    basis: "observed", outcome: "success", complete: true, status: 200 }, { internal: true });
  const edit = fn => { const ctx = readJson(storePath(root)); fn(ctx); writeFileSync(storePath(root), JSON.stringify(ctx)); };
  const setList = (operation, value) => edit(ctx => {
    const entry = ctx.api_context.operations[operationId(identityFor(operation))];
    if (value === undefined) delete entry.key_sources; else entry.key_sources = value;
  });
  const query = (input = {}, options = {}) => queryOperationContext(root, input, { env, ...options });
  return { root, env, capture, setList, query };
}
const A = "GET /things/{id}", B = "GET /widgets/{wid}";
// A valid list the store accepts: a path link and a query link with a long field.
const validList = [storedLink(), storedLink({ param: "sort", location: "query",
  source: { operation: "GET /things", field: `data[].${"s".repeat(60)}.${"t".repeat(60)}.${"u".repeat(60)}` } })];

test("MAP-1A fix3 F1: a record that fits only without its key_sources is returned without them and counted; it is left out only if it still does not fit", t => {
  const f = scratch(t);
  for (let n = 0; n < 3; n++) f.capture(A);
  assert.equal(projectKeySources({ key_sources: validList }).state, "valid", "positive control: the store accepts the list");
  const exactA = identityFor(A);
  const lean = f.query(exactA, { maxBytes: MIB });
  assert.equal(lean.operations.length, 1);
  const leanBytes = size(lean);
  f.setList(A, validList);
  const full = f.query(exactA, { maxBytes: MIB });
  const listBytes = size(full) - leanBytes;
  assert.ok(listBytes > 100);
  assert.deepEqual(full.operations[0].key_sources, validList);
  // With room for the list, nothing changes.
  const roomy = f.query(exactA, { maxBytes: leanBytes + listBytes });
  assert.deepEqual(roomy, full);
  assert.equal(roomy.key_sources_omitted, undefined);
  // The record fits without its list (and the count), not with it: it keeps
  // its place, its observations are unchanged, and the answer counts it.
  const counted = Buffer.byteLength(',"key_sources_omitted":1');
  for (const budget of [leanBytes + counted, leanBytes + listBytes - 1]) {
    const answer = f.query(exactA, { maxBytes: budget });
    assert.equal(answer.operations.length, 1, `budget ${budget}: the record keeps its place`);
    assert.equal(Object.hasOwn(answer.operations[0], "key_sources"), false, `budget ${budget}: returned without its key_sources`);
    assert.deepEqual(answer.operations[0], lean.operations[0], `budget ${budget}: everything else is the record as stored`);
    assert.equal(answer.key_sources_omitted, 1, `budget ${budget}: the omission is counted`);
    assert.equal(answer.omissions.operations, 0);
    assert.ok(size(answer) <= budget);
  }
  // Without room even for that, the record is left out, and counted there.
  const tight = f.query(exactA, { maxBytes: leanBytes + counted - 1 });
  assert.deepEqual([tight.operations.length, tight.omissions.operations, tight.key_sources_omitted], [0, 1, undefined]);
  // The scoped form show and context query use behaves the same.
  const scoped = f.query({ protocol: "http", operation: A }, { maxBytes: leanBytes + counted });
  assert.deepEqual([scoped.operations.length, scoped.key_sources_omitted], [1, 1]);
});

test("MAP-1A fix3 F1: room for record_issues is reserved, so a record near the budget sheds its key_sources and the damaged record is still named", t => {
  const f = scratch(t);
  for (let n = 0; n < 2; n++) f.capture(A);
  f.capture(B);
  f.setList(A, validList);
  f.setList(B, "not-an-array");
  const issueB = { repository: "local", operation_id: operationId(identityFor(B)), code: "KEY_SOURCES_INVALID" };
  const everything = f.query({}, { maxBytes: MIB });
  assert.deepEqual(everything.record_issues, [issueB]);
  const [withA] = everything.operations;
  assert.equal(withA.identity.operation, A);
  // A budget with room for A and its list, B left out, and 10 bytes to spare:
  // no room for B's issue unless A gives up its derived list.
  const onlyA = { ...structuredClone(everything), operations: [withA], omissions: { ...everything.omissions, operations: 1 } };
  delete onlyA.record_issues;
  const budget = size(onlyA) + 10;
  const answer = f.query({}, { maxBytes: budget });
  assert.deepEqual(answer.record_issues, [issueB], "the damaged record is named");
  assert.equal(answer.operations.length, 1);
  assert.equal(answer.operations[0].identity.operation, A, "A keeps its place");
  assert.equal(Object.hasOwn(answer.operations[0], "key_sources"), false, "A gave up its key_sources");
  assert.equal(answer.key_sources_omitted, 1);
  assert.equal(answer.omissions.operations, 1, "B, which does not fit, is counted");
  assert.ok(size(answer) <= budget);

  // With two damaged records the reserved room holds the first one named and
  // the count of the rest: one byte short of A with its list beside both, A
  // gives up its list and the first damaged record is still named.
  const C = "GET /gadgets/{gid}";
  f.capture(C);
  f.setList(C, null);
  const issueC = { repository: "local", operation_id: operationId(identityFor(C)), code: "KEY_SOURCES_INVALID" };
  const all = f.query({}, { maxBytes: MIB });
  assert.deepEqual(all.record_issues, [issueB, issueC]);
  const firstNamed = { ...structuredClone(all), operations: [all.operations[0]], omissions: { ...all.omissions, operations: 2, record_issues: 1 },
    record_issues: [issueB] };
  const tight = f.query({}, { maxBytes: size(firstNamed) - 1 });
  assert.deepEqual(tight.record_issues, [issueB], "the first damaged record is named");
  assert.equal(tight.omissions.record_issues, 1, "the other is counted");
  assert.equal(tight.operations[0].identity.operation, A);
  assert.equal(Object.hasOwn(tight.operations[0], "key_sources"), false);
  assert.ok(size(tight) <= size(firstNamed) - 1);
});

test("MAP-1A fix3 F1: a source issue that arrives after the records were placed sheds key_sources before it costs a record its place", t => {
  const f = scratch(t);
  for (let n = 0; n < 3; n++) f.capture(A);
  f.setList(A, validList);
  // A granted provider whose store cannot be read: its issue is added after
  // the local record was placed.
  const provider = realpathSync(mkdtempSync(join(tmpdir(), "api-map-fix3-provider-")));
  t.after(() => rmSync(provider, { recursive: true, force: true }));
  mkdirSync(dirname(join(provider, CONTEXT_FILE)), { recursive: true });
  writeFileSync(join(provider, CONTEXT_FILE), "{broken json");
  const registry = emptyRegistry();
  const consumerId = registerRepo(registry, f.root).id;
  grant(registry, consumerId, registerRepo(registry, provider).id);
  saveRegistry(registry, f.env);
  const exactA = identityFor(A);
  const full = f.query(exactA, { maxBytes: MIB });
  assert.equal(full.issues.length, 1, "positive control: the provider's store is named as unavailable");
  assert.deepEqual(full.operations[0].key_sources, validList);
  const listBytes = Buffer.byteLength(`,"key_sources":${JSON.stringify(validList)}`);
  // Room for the record with its list before the provider's issue arrives,
  // not after it; room for the record without its list beside the issue.
  const budget = size(full) - 1;
  assert.ok(size(full) - Buffer.byteLength(JSON.stringify(full.issues[0])) <= budget && size(full) - listBytes + 24 <= budget);
  const answer = f.query(exactA, { maxBytes: budget });
  assert.equal(answer.issues.length, 1, "the source issue is reported");
  assert.equal(answer.operations.length, 1, "the record keeps its place");
  assert.equal(Object.hasOwn(answer.operations[0], "key_sources"), false);
  assert.equal(answer.key_sources_omitted, 1);
  assert.ok(size(answer) <= budget);
  // When even the record without its list does not fit beside the issue, it is
  // left out, and nothing claims a list was omitted from a record not returned.
  const leanBeside = size(full) - listBytes;
  const none = f.query(exactA, { maxBytes: leanBeside - 1 });
  assert.deepEqual([none.operations.length, none.omissions.operations, none.key_sources_omitted, none.issues.length], [0, 1, undefined, 1]);
});

// --- F1: QA's two cases, through the real CLI ------------------------------------

// The size of the answer show and context query get for one operation, with
// the stored list removed; the store is restored. `kept` is false when the
// record does not fit even at 1 MiB.
function measureWithout(root, operation) {
  const original = readFileSync(storePath(root), "utf8");
  const store = JSON.parse(original);
  for (const entry of Object.values(store.api_context.operations)) if (entry.identity.operation === operation) delete entry.key_sources;
  writeFileSync(storePath(root), JSON.stringify(store, null, 2));
  try {
    const answer = queryOperationContext(root, { protocol: "http", operation }, { env: envFor(root), maxBytes: MIB });
    return { kept: answer.operations.length === 1, bytes: size(answer) };
  } finally { writeFileSync(storePath(root), original); }
}
const listBytesOf = list => Buffer.byteLength(`,"key_sources":${JSON.stringify(list)}`);
// Grow GET /things/{id} by real captures, then search one last capture's size
// (restoring the store before each try) until the record fits `budget` without
// its list and not with it: exactly the record QA measured being dropped.
async function growToBoundary(root, { budget, list, coarse }) {
  const op = "GET /things/{id}";
  const detail = async query => assert.equal((await send(root, { method: "GET", path: `/things/${ITEM}?${query}` })).context_capture?.state, "captured");
  for (const query of coarse) await detail(query);
  const base = readFileSync(storePath(root), "utf8");
  const plant = () => { if (list) { const store = JSON.parse(readFileSync(storePath(root), "utf8"));
    for (const entry of Object.values(store.api_context.operations)) if (entry.identity.operation === op) entry.key_sources = list(entry.key_sources);
    writeFileSync(storePath(root), JSON.stringify(store, null, 2)); } };
  const inWindow = async query => {
    writeFileSync(storePath(root), base);
    await detail(query);
    plant();
    const stored = record(root, op)[1].key_sources;
    const without = measureWithout(root, op);
    return { without, listBytes: listBytesOf(stored), fits: without.kept && without.bytes <= budget, over: !without.kept || without.bytes + listBytesOf(stored) > budget };
  };
  // m (whole 1.4 KB nodes) first, then pad (characters), each a binary search.
  const search = async (lo, hi, query) => {
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2), state = await inWindow(query(mid));
      if (state.fits && state.over) return { state, value: mid };
      if (state.fits) lo = mid + 1; else hi = mid - 1;
    }
    return { state: null, value: hi };
  };
  let found = await search(0, 49, m => `m=${m}`);
  if (!found.state) found = await search(0, 1300, pad => `m=${Math.max(0, found.value)}&pad=${pad}`);
  assert.ok(found.state, "a final capture lands the record inside the window");
  return found.state;
}
async function surfaces(root) {
  const op = "GET /things/{id}";
  const show = await cli(root, ["show", op, "--json"]);
  assert.equal(show.code, 0, show.stderr);
  const human = await cli(root, ["show", op, "--human"]);
  const queryFile = join(root, ".query.json");
  writeFileSync(queryFile, JSON.stringify({ protocol: "http", operation: op }));
  const query = await cli(root, ["context", "query", queryFile]);
  assert.equal(query.code, 0, query.stderr);
  const map = await cli(root, ["map", "--json"]);
  assert.equal(map.code, 0, map.stderr);
  const mapPage = await cli(root, ["map"]);
  assert.equal(mapPage.code, 0, mapPage.stderr);
  const view = await cli(root, ["view"]);
  assert.equal(view.code, 0, view.stderr);
  const page = readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8"), viewPage = readFileSync(join(historicalFixtureProjection(root), LAYOUT.viewOutput), "utf8");
  const standing = html => /<tr class="am-r [^"]*am-row-([a-z-]+)"><td class="am-nw">.*?<\/td><td><code>\/things\/\{id\}<\/code>/.exec(html)?.[1] ?? null;
  const keyRow = html => /<tr><td><code>id<\/code><\/td><td><code>\/things\/\{id\}<\/code><\/td><td>([\s\S]*?)<\/td><\/tr>/.exec(html)?.[1]
    .replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim() ?? null;
  return { show: JSON.parse(show.stdout), human: human.stdout, query: JSON.parse(query.stdout), map: JSON.parse(map.stdout).api_map,
    page: pageText(page), viewPage: pageText(viewPage), mapStanding: standing(page), viewStanding: standing(viewPage), keyRow: keyRow(pageText(page)),
    outputs: [show.stdout, human.stdout, query.stdout, map.stdout, mapPage.stdout, view.stdout, page, viewPage].join("\n") };
}
function strip(root, operation) {
  const store = readJson(storePath(root));
  for (const entry of Object.values(store.api_context.operations)) if (entry.identity.operation === operation) delete entry.key_sources;
  writeFileSync(storePath(root), JSON.stringify(store, null, 2));
}

test("MAP-1A fix3 F1, QA case 1: at 16,000 bytes a record that fits without its one-entry key_sources list keeps its place in context query and show's scoped history", async t => {
  const port = await startServer(t, SIZED);
  const root = await consumer(t, { name: "api-map-fix3-16k-", baseUrl: `http://127.0.0.1:${port}`,
    paths: { "/things": { get: ok("List things") }, "/things/{id}": { get: ok("Get a thing") } } });
  assert.equal((await send(root, { method: "GET", path: "/things" })).context_capture?.state, "captured");
  // Small observations up to about 4 KB short of the budget, then one sized to
  // land the record where the real one-entry list no longer fits beside it.
  const state = await growToBoundary(root, { budget: 16000, coarse: Array.from({ length: 9 }, () => "m=0") });
  const [, stored] = record(root, "GET /things/{id}");
  assert.deepEqual(stored.key_sources.map(item => [item.param, item.location, item.source.operation, item.source.field]),
    [["id", "path", "GET /things", "data[].id"]], "the capture's own one-entry list");
  assert.ok(state.without.bytes <= 16000 && state.without.bytes + state.listBytes > 16000,
    `fits without the list (${state.without.bytes}), not with it (${state.without.bytes + state.listBytes})`);
  const withList = await surfaces(root);
  strip(root, "GET /things/{id}");
  const withoutList = await surfaces(root);
  for (const [label, s] of [["with the list", withList], ["without the list", withoutList]]) {
    assert.equal(s.query.operations.length, 1, `${label}: context query keeps the record`);
    assert.equal(s.query.omissions.operations, 0, label);
    assert.equal(s.show.scoped.operations.length, 1, `${label}: show's scoped history keeps the record`);
    assert.equal(s.show.confidence, "observed", label);
    assert.equal(s.show.observation_summary.state, "observed", label);
    assert.equal(s.mapStanding, "observed", label);
    assert.equal(s.viewStanding, "observed", label);
    for (const marker of SIZED_MARKERS) assert.ok(!s.outputs.includes(marker), `${label}: ${marker} appears nowhere`);
  }
  assert.equal(withList.show.observation_summary.observation_count, withoutList.show.observation_summary.observation_count);
  assert.equal(withList.map.counts.observed_total, withoutList.map.counts.observed_total);
  // The omission is counted, and only where the list was left out.
  assert.equal(withList.query.key_sources_omitted, 1);
  assert.equal(Object.hasOwn(withList.query.operations[0], "key_sources"), false);
  assert.equal(withList.show.scoped.key_sources_omitted, 1);
  assert.match(withList.human, /Key-source lists beyond the read bound: 1 record\(s\) returned without key_sources; their links are not shown\./);
  assert.equal(withoutList.query.key_sources_omitted, undefined);
  assert.equal(withoutList.show.scoped.key_sources_omitted, undefined);
  // The map reads through the 1 MiB bound, where the list fits: it is shown.
  assert.equal(withList.map.counts.key_sources, 1);
  assert.equal(withList.map.counts.key_sources_omitted, 0);
  assert.equal(withList.keyRow, "GET /things → data[].id seen on 1 operation");
});

test("MAP-1A fix3 F1, QA case 2: at 1 MiB a record that fits without a full key_sources list keeps its standing in show, the map and the view, and the map counts the list it cannot show", async t => {
  const port = await startServer(t, SIZED);
  const root = await consumer(t, { name: "api-map-fix3-1mib-", baseUrl: `http://127.0.0.1:${port}`,
    paths: { "/things": { get: ok("List things") }, "/things/{id}": { get: ok("Get a thing") } } });
  assert.equal((await send(root, { method: "GET", path: "/things" })).context_capture?.state, "captured");
  // A full list: the capture's own path link, then 15 query links with long
  // fields (two per parameter), as QA planted it.
  const field = n => [..."abcd"].map(letter => letter.repeat(60)).join(".").slice(0, 243 - n);
  const letters = i => String.fromCharCode(97 + i);
  const full = captured => [captured[0], ...Array.from({ length: 15 }, (_, i) => storedLink({ param: `p${letters(Math.floor(i / 2))}`, location: "query",
    source: { operation: "GET /things", field: field(i % 2) } }))];
  const state = await growToBoundary(root, { budget: MIB, list: full, coarse: Array.from({ length: 14 }, () => "m=49") });
  const [, stored] = record(root, "GET /things/{id}");
  assert.equal(stored.key_sources.length, 16);
  assert.equal(projectKeySources(stored).state, "valid", "the store accepts the full list");
  assert.ok(state.without.bytes <= MIB && state.without.bytes + state.listBytes > MIB,
    `fits without the list (${state.without.bytes}), not with it (${state.without.bytes + state.listBytes})`);
  const exact = queryOperationContext(root, stored.identity, { env: envFor(root), maxBytes: MIB });
  assert.equal(exact.operations.length, 1, "the 1 MiB query show and the map read keeps the record");
  assert.deepEqual([exact.key_sources_omitted, Object.hasOwn(exact.operations[0], "key_sources")], [1, false]);

  const withList = await surfaces(root);
  strip(root, "GET /things/{id}");
  const withoutList = await surfaces(root);
  for (const [label, s] of [["with the list", withList], ["without the list", withoutList]]) {
    assert.equal(s.show.confidence, "observed", `${label}: show stays observed`);
    assert.equal(s.show.observation_summary.state, "observed", label);
    assert.equal(s.mapStanding, "observed", `${label}: the map row keeps its standing`);
    assert.equal(s.viewStanding, "observed", `${label}: the view row keeps its standing`);
    for (const marker of SIZED_MARKERS) assert.ok(!s.outputs.includes(marker), `${label}: ${marker} appears nowhere`);
  }
  assert.equal(withList.show.observation_summary.observation_count, withoutList.show.observation_summary.observation_count);
  assert.equal(withList.map.counts.observed_total, withoutList.map.counts.observed_total);
  // The omission is counted: the map names the list it cannot show, and the
  // path key it held reads "not shown", never "not recorded".
  assert.equal(withList.map.counts.key_sources_omitted, 1);
  assert.equal(withoutList.map.counts.key_sources_omitted, 0);
  assert.match(withList.page, /1 operation record has a key-source list beyond the read bound; its links are not shown\./);
  assert.equal(withList.keyRow, "not shown (a key-source list under it is beyond the read bound)");
  assert.equal(withoutList.keyRow, "not recorded");
  const details = page => page.slice(page.indexOf("<summary><code>GET /things/{id}</code>"));
  assert.match(details(withList.viewPage), /The stored key-source list is beyond the read bound; its links are not shown\./);
  assert.ok(!withoutList.viewPage.includes("beyond the read bound"), "without a stored list nothing is beyond the bound");
});

test("MAP-1A fix3 wording: a record the read bound leaves out reads unavailable, history beyond the read bound, in show and the map alike, never none", async t => {
  const port = await startServer(t, SIZED);
  const root = await consumer(t, { name: "api-map-fix3-wording-", baseUrl: `http://127.0.0.1:${port}`,
    paths: { "/things": { get: ok("List things") }, "/things/{id}": { get: ok("Get a thing") } } });
  assert.equal((await send(root, { method: "GET", path: "/things" })).context_capture?.state, "captured");
  // Fifteen large observations: past 1 MiB even without its key-source list
  // (the capture's own one-entry list stays in the store).
  for (let n = 0; n < 15; n++)
    assert.equal((await send(root, { method: "GET", path: `/things/${ITEM}?m=49` })).context_capture?.state, "captured");
  assert.equal(record(root, "GET /things/{id}")[1].key_sources.length, 1);
  assert.equal(measureWithout(root, "GET /things/{id}").kept, false, "positive control: the record does not fit the bound");
  const show = await cli(root, ["show", "GET /things/{id}", "--json"]);
  assert.equal(show.code, 0, show.stderr);
  const shown = JSON.parse(show.stdout).observation_summary;
  assert.equal(shown.state, "unavailable", "never none: the record left out could hold a newer response");
  assert.equal(shown.unavailable_reason, READ_BOUND);
  assert.match((await cli(root, ["show", "GET /things/{id}", "--human"])).stdout, /Recorded client observations: unavailable \(history beyond the read bound\);/);
  const model = (await import("../lib/api-map.mjs")).buildApiMapModel(historicalFixtureProjection(root), { env: envFor(root) });
  const row = model.operations.find(item => item.op === "GET /things/{id}");
  assert.deepEqual([row.standing.key, row.standing.label], ["unavailable", "observations unavailable"]);
  assert.ok(row.standing.qualifiers.includes(shown.unavailable_reason), "the map's words are show's words");
  // The list the store holds for the record the bound left out is not shown
  // either, and is counted: its key reads "not shown", never "not recorded".
  assert.equal(row.key_sources_omitted, true);
  assert.equal(model.counts.key_sources_omitted, 1);
  assert.deepEqual(model.key_slots.map(slot => [slot.param, slot.sources.length, slot.beyond_read_bound ?? false]), [["id", 0, true]]);
  // A record that fits is unaffected: the list operation reads observed in both.
  const list = JSON.parse((await cli(root, ["show", "GET /things", "--json"])).stdout);
  assert.deepEqual([list.confidence, list.observation_summary.state, list.observation_summary.unavailable_reason], ["observed", "observed", undefined]);
  assert.equal(model.operations.find(item => item.op === "GET /things").standing.key, "observed");
});

// --- F2: the listed-id finding never carries the id -------------------------------

test("MAP-1A fix3 F2: the sampled id's source is named by operation and names-only field, with the key-source rule for keys that carry data", async () => {
  const { sampledId, sampleIdFor, listedIdSource } = await checks();
  assert.equal(typeof sampledId, "function");
  const bodies = new Map([
    ["/hubs", { data: [{ id: "h-1" }], meta: { total: 1 } }],
    ["/rooms", [{ id: 42 }]],
    ["/days", { "1999-12-31": [{ id: "d-1" }] }],
    ["/codes", { codes2: [{ id: "c-1" }] }],
    ["/stations", { features: [{ id: "https://api.example.test/stations/0007W" }] }],
  ]);
  const at = (path, options) => { const s = sampledId(path, bodies, options); return s && [s.id, s.operation, s.field]; };
  assert.deepEqual(at("/hubs/{hubId}"), ["h-1", "GET /hubs", "data[].id"]);
  assert.deepEqual(at("/rooms/{roomId}"), ["42", "GET /rooms", "[].id"]);
  assert.deepEqual(at("/days/{dayId}"), ["d-1", "GET /days", "{}[].id"], "a date key is data: it reads {}");
  assert.deepEqual(at("/codes/{code}"), ["c-1", "GET /codes", "{}[].id"], "a digit-bearing key reads {} unless declared");
  assert.deepEqual(at("/codes/{code}", { declared: new Set(["codes2"]) }), ["c-1", "GET /codes", "codes2[].id"]);
  assert.deepEqual(at("/stations/{stationId}"), ["0007W", "GET /stations", "features[].id"]);
  assert.equal(at("/missing/{id}"), null);
  assert.equal(listedIdSource(sampledId("/hubs/{hubId}", bodies)), "GET /hubs → data[].id");
  // The id substituted into the probe is the one it always was.
  assert.deepEqual(["/hubs/{hubId}", "/rooms/{roomId}", "/stations/{stationId}"].map(path => sampleIdFor(path, bodies)), ["h-1", "42", "0007W"]);
});

test("MAP-1A fix3 F2: a probe that substitutes a listed id reports the 404 or 5xx with the listing operation and field, and the id appears in no audit, map or view output or committed file", async t => {
  const port = await startServer(t, LISTED);
  const root = await consumer(t, { name: "api-map-fix3-listed-", historicalAudit: true, baseUrl: `http://127.0.0.1:${port}`, paths: {
    "/hubs": { get: ok("List hubs") }, "/hubs/{hubId}": { get: ok("Get a hub") },
    "/rooms": { get: ok("List rooms") }, "/rooms/{roomId}": { get: ok("Get a room") },
    "/days": { get: ok("List days") }, "/days/{dayId}": { get: ok("Get a day") } } });
  const expected = [
    ["GET /hubs/{hubId}", "missing", "documented but the server returns 404 for a listed id (GET /hubs → data[].id)"],
    ["GET /rooms/{roomId}", "erroring", "server returns 500 for a listed id (GET /rooms → items[].id)"],
    ["GET /days/{dayId}", "missing", "documented but the server returns 404 for a listed id (GET /days → {}[].id)"],
  ];
  const listedFindings = findings => findings.filter(item => /listed id/.test(item.detail))
    .map(item => [item.op, item.kind, item.detail]).sort((a, b) => a[0].localeCompare(b[0]));
  const outputs = [];
  const run = async args => { const result = await cli(root, args); outputs.push(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`); return result; };

  const auditJson = await run(["audit", ".", "--json"]);
  assert.equal(auditJson.code, 0, auditJson.stderr);
  const surveyed = JSON.parse(auditJson.stdout).surfaces;
  assert.deepEqual(listedFindings(surveyed.flatMap(surface => surface.findings ?? [])), [...expected].sort((a, b) => a[0].localeCompare(b[0])),
    "each listed-id finding is still reported, naming its source");
  const audit = await run(["audit", "."]);
  for (const [, , detail] of expected) assert.ok(audit.stdout.includes(detail), `audit prints: ${detail}`);
  const baseline = await run(["audit", ".", "--baseline"]);
  assert.equal(baseline.code, 0, baseline.stdout + baseline.stderr);
  const summaryFile = join(root, ".summary.md");
  const ci = await run(["audit", ".", "--ci", "--report-only", "--summary", summaryFile]);
  assert.equal(ci.code, 0, ci.stdout + ci.stderr);
  outputs.push(readFileSync(summaryFile, "utf8"));
  // FIELD-1a keeps audit's listed-ID probes above, but map/view are local by
  // default. A fetch tripwire proves these presentations attempt no traffic;
  // findings are not silently regenerated from identifiers in response bodies.
  const attemptLog = join(root, '.map-network-attempted');
  const guard = join(root, '.map-network-guard.mjs');
  writeFileSync(guard, `import {appendFileSync} from 'node:fs'; globalThis.fetch = () => { appendFileSync(${JSON.stringify(attemptLog)}, 'attempt'); throw new Error('synthetic network blocked'); };`);
  const offline = async args => { const result = await node(root, ["--import", guard, CLI, ...args]); outputs.push(`${args.join(" ")}\n${result.stdout}\n${result.stderr}`); assert.equal(result.code, 0, result.stdout + result.stderr); return result; };
  const mapJson = await offline(["map", "--json"]);
  const mapped = JSON.parse(mapJson.stdout);
  assert.deepEqual(listedFindings(mapped.services.flatMap(service => service.findings ?? [])), [], "default map has no newly executed listed-ID findings");
  assert.equal(mapped.probe_execution, "static");
  assert.equal(mapped.summary.operations_probed, 0);
  const mapText = await offline(["map", "--text"]);
  assert.match(mapText.stdout, /source scan only — no requests executed/);
  await offline(["map"]);
  const page = pageText(readFileSync(join(historicalFixtureProjection(root), LAYOUT.mapOutput), "utf8"));
  assert.match(page, /Use --execute to announce and send declared reads through the API client/);
  assert.match(page, /No request or response values appear on this page/);
  outputs.push(page);
  await offline(["view"]);
  outputs.push(pageText(readFileSync(join(historicalFixtureProjection(root), LAYOUT.viewOutput), "utf8")));
  assert.equal(existsSync(attemptLog), false, "map/view never called fetch");
  const explicit = await run(["map", "--execute", "--json"]);
  assert.equal(explicit.code, 0, explicit.stdout + explicit.stderr);
  const reads = JSON.parse(explicit.stdout).map_execution;
  assert.deepEqual(reads.requests.map(row => `${row.method} ${row.path}`).sort(), ["GET /days", "GET /hubs", "GET /rooms"]);
  assert.equal(reads.responses, 3);
  assert.equal(reads.omitted.find(row => row.reason === "unresolved-path-parameters")?.count, 3,
    "explicit map reads name omitted templates; only audit substitutes listed IDs");
  for (const [path, text] of committedText(root)) outputs.push(`${path}\n${text}`);
  const all = outputs.join("\n");
  for (const marker of LISTED_MARKERS) assert.ok(!all.includes(marker), `${marker} appears in no output and no committed file`);
});

test("MAP-1A fix3 F2 (guard): a finding accepted while its detail printed the id keeps its baseline key", () => {
  const key = detail => ciFindings([{ name: "svc", kind: "documented", findings: [{ op: "GET /hubs/{hubId}", kind: "missing", detail }], shadowRoutes: [] }], [])[0].key;
  assert.equal(key("documented but the server returns 404 for a listed id (GET /hubs → data[].id)"),
    key("documented but the server returns 404 for a listed id (abc-1)"));
  assert.equal(key("server returns 500 for a listed id (GET /rooms → items[].id)"), key("server returns 500 for a listed id (9)"));
});
