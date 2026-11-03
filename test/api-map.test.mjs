// MAP-1A: the API map is a projection of the knowledge store and the contract
// it names. These tests run against a synthetic consumer (no network, no real
// credentials): every count must trace to a stored record, removing a record
// must remove exactly what it supported, `show` and the map must agree, and no
// value from private evidence or the environment may reach any surface.
//
//   node --test test/api-map.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "../lib/layout.mjs";
import { HOME_ENV_NAME, ENV_PREFIX } from "../lib/brand.mjs";
import { buildApiMapModel, renderApiMapHtml, renderApiMapText, API_MAP_CSS, API_MAP_METHODS, API_MAP_STANDINGS } from "../lib/api-map.mjs";
import { buildViewModel, renderViewHtml } from "../lib/view.mjs";
import { footprintModel, renderMapHtml } from "../lib/map.mjs";
import { observationConfidence } from "../lib/show-observations.mjs";
import { matchHttpOperation } from "../lib/http-operation-context.mjs";
import { registryPath } from "../lib/registry.mjs";
import { seedApiMapFixture, AT, MARKERS, EXPECTED_STANDINGS, CONTRACT, PROVIDER } from "./fixtures/api-map/fixture.mjs";
import { seedLargeStore } from "./fixtures/api-map/large.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs");
const execute = promisify(execFile);
// Scope binding reads the process environment, as `show` does. Nothing from
// the developer's shell may select an environment, base URL or contract here.
for (const key of Object.keys(process.env)) if (key.startsWith("API_") || key.startsWith(`${ENV_PREFIX}_`)) delete process.env[key];
process.env.HEARTH_TOKEN = MARKERS.token;

function project(t, name = "api-map-") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const envFor = root => ({ [HOME_ENV_NAME]: join(root, ".home"), API_USAGE_LOG: join(root, ".usage.jsonl") });
const build = (root, options = {}) => buildApiMapModel(root, { now: Date.parse(AT), env: envFor(root), ...options });
const cliEnv = root => ({ ...process.env, ...envFor(root) });
const run = (root, args) => spawnSync(process.execPath, [CLI, ...args], { cwd: root, env: cliEnv(root), encoding: "utf8" });
const row = (model, op) => model.operations.find(item => item.op === op);
const storePath = root => join(root, LAYOUT.context);
const readStore = root => JSON.parse(readFileSync(storePath(root), "utf8"));
const writeStore = (root, store) => writeFileSync(storePath(root), JSON.stringify(store, null, 2) + "\n");

test("MAP-1A standings follow show's rules and every count traces to a stored record", t => {
  const root = project(t);
  seedApiMapFixture(root);
  const model = build(root);
  assert.equal(model.state, "mapped");
  assert.equal(model.name, "Hearth API");
  assert.deepEqual(Object.fromEntries(model.operations.map(item => [item.op, item.standing.key])), EXPECTED_STANDINGS);
  const qualifiers = op => row(model, op).standing.qualifiers;
  assert.deepEqual(qualifiers("GET /v1/hubs/{hubId}/tasks"), ["using parameters the contract does not declare: page_cursor"]);
  assert.equal(row(model, "GET /v1/hubs/{hubId}/members/{memberId}").standing.label, "latest response 404");
  assert.deepEqual(qualifiers("GET /v1/hubs/{hubId}/members"), ["its evidence is missing or changed"]);
  assert.deepEqual(qualifiers("GET /v1/hubs/{hubId}/lists"), ["older than the 180-day staleness horizon"]);
  assert.deepEqual(qualifiers("GET /v1/me"), ["an assertion failed"]);
  assert.deepEqual(qualifiers("GET /v1/hubs/{hubId}/events"), ["1 response retained outside this scope"]);
  assert.deepEqual(qualifiers("GET /v1/exports/legacy"), ["not in the bound contract"]);
  assert.equal(row(model, "POST /v1/hubs").standing.label, "write — no response recorded");
  // Legacy learn verification travels beside the standing, never merged.
  assert.equal(row(model, "GET /v1/hubs").standing.key, "observed");
  assert.equal(row(model, "GET /v1/hubs").learned.confidence, "verified");
  assert.deepEqual([row(model, "GET /v1/hubs/{hubId}/lists").learned.confidence, row(model, "GET /v1/hubs/{hubId}/lists").learned.stale], ["suspect", true]);
  assert.equal(row(model, "GET /v1/hubs/{hubId}/tasks/{taskId}/history").learned, null);

  // Every count is the number of rows or records that carry it.
  const c = model.counts;
  for (const key of Object.keys(API_MAP_STANDINGS)) assert.equal(c[key], model.operations.filter(item => item.standing.key === key).length, key);
  assert.equal(c.operations, 17);
  assert.equal(c.observed_total, c.observed + c["observed-after-failure"]);
  assert.equal(c.notes, model.notes.length);
  assert.equal(c.notes, model.operations.reduce((n, item) => n + item.notes, 0));
  assert.equal(c.key_sources, model.key_sources.length);
  assert.equal(c.key_sources, model.operations.reduce((n, item) => n + item.key_sources, 0));
  assert.equal(c.learned_verified, 1);
  assert.equal(c.learned_suspect, 1);
  assert.equal(c.contract_only, 1);
  assert.equal(c.store_only, 1);
  assert.equal(model.observations.counted, model.operations.reduce((n, item) => n + item.responses, 0));
  assert.deepEqual(model.observations, { counted: 7, first_observed_at: "2026-09-25T10:00:00.000Z",
    last_observed_at: "2026-09-29T07:00:00.000Z", outside_scope: 1, outside_map: 1 });
  assert.deepEqual(model.omissions, { key_source_records_damaged: 1, non_http_store_keys: 0, contract_text_withheld: 0,
    contract_paths_withheld: 0, declared_parameters_unresolved: 0, contract_version_withheld: 0 });
  assert.deepEqual(model.issues, [{ code: "KEY_SOURCES_INVALID", operation: "GET /v1/hubs/{hubId}/members/{memberId}" }]);
  assert.deepEqual(model.sources, []);
  assert.deepEqual(model.scope, { state: "bound", provider: PROVIDER, environment: "production", production: true,
    contract: CONTRACT, contract_digest: model.scope.contract_digest });
  assert.deepEqual(model.contract, { path: CONTRACT, state: "read", version: "2.4.0" });
  assert.deepEqual(model.hub, { prefix: "/v1/hubs/{hubId}", operations: 13 });
  assert.deepEqual(model.groups.map(group => `${group.source}:${group.name}:${group.operations.length}`),
    ["tag:Hubs:4", "tag:Members:3", "tag:Tasks:5", "tag:Lists:1", "path:lists:1", "path:events:1", "path:me:1", "path:exports:1"]);
  assert.equal(row(model, "GET /v1/hubs/{hubId}/tasks").display_path, "…/tasks");
  assert.equal(row(model, "GET /v1/hubs").display_path, "/v1/hubs");
  // Active authored notes only: the superseded claim and learn's machine note stay out.
  assert.deepEqual(model.notes.map(note => [note.op, note.by, note.at, note.evidence.map(ref => ref.run_id)]), [
    ["GET /v1/hubs", "agent", "2026-09-28", []],
    ["GET /v1/hubs/{hubId}/members/{memberId}", "human", "2026-09-27", ["run-0a1b2c3d-0006"]],
    ["GET /v1/hubs/{hubId}/tasks", "agent", "2026-09-26", ["run-0a1b2c3d-0004"]],
    ["POST /v1/hubs/{hubId}/tasks", "agent", "2026-09-24", []],
    ["GET /v1/me", null, null, []],
  ]);
  // The damaged list on GET …/members/{memberId} contributes nothing.
  assert.deepEqual(model.key_sources.map(key => `${key.op} ${key.param}/${key.location} <- ${key.source_operation} ${key.source_field} +${key.also_seen}`), [
    "GET /v1/hubs/{hubId} hubId/path <- GET /v1/hubs data[].id +0",
    "GET /v1/hubs/{hubId}/members hubId/path <- GET /v1/me hub_id +0",
    "GET /v1/hubs/{hubId}/tasks hubId/path <- GET /v1/hubs data[].id +0",
    "GET /v1/hubs/{hubId}/tasks page_cursor/query <- GET /v1/hubs/{hubId}/tasks meta.page_cursor +0",
    "GET /v1/hubs/{hubId}/tasks/{taskId} hubId/path <- GET /v1/hubs data[].id +0",
    "GET /v1/hubs/{hubId}/tasks/{taskId} taskId/path <- GET /v1/hubs/{hubId}/tasks data[].id +1",
    "GET /v1/hubs/{hubId}/lists hubId/path <- POST /v1/hubs id +0",
  ]);
  // Each path key's row counts the operations whose records name its source.
  assert.deepEqual(c.key_slots, model.key_slots.length);
  assert.deepEqual(c.key_slots_sourced, model.key_slots.filter(slot => slot.sources.length).length);
  for (const slot of model.key_slots) for (const source of slot.sources)
    assert.equal(source.seen_on, new Set(model.key_sources.filter(key => key.location === "path" && key.param === slot.param
      && key.source_operation === source.operation && key.source_field === source.field
      && (key.op.slice(key.op.indexOf(" ") + 1) === slot.prefix || key.op.slice(key.op.indexOf(" ") + 1).startsWith(`${slot.prefix}/`))).map(key => key.op)).size);
  // The rendered tiles state the same numbers.
  const html = renderApiMapHtml(model);
  for (const [n, label] of [[17, "operations"], [4, "passing response histories (1 after a failed attempt)"], [4, "latest response not passing or not counted"],
    [3, "reads — no response recorded"], [5, "writes — no response recorded"], [1, "scope unresolved"], [5, "notes"], [2, "of 4 path keys with a recorded source"]])
    assert.ok(html.includes(`<b>${n}</b><span>${label.replaceAll("(", "&#40;")}</span>`), `${n} ${label}`);
  assert.match(renderApiMapText(model), /passing response histories\s+4 \(1 after a failed attempt\)/);
});

test("MAP-1A golden: the synthetic consumer renders the same fragment", t => {
  const root = project(t);
  seedApiMapFixture(root);
  const html = renderApiMapHtml(build(root));
  assert.equal(html, readFileSync(join(ROOT, "test/fixtures/api-map/golden.html"), "utf8"));
});

// A path-insensitive structural diff: which leaves of the model changed.
function changed(before, after) {
  const flat = (value, path = "", out = new Map()) => {
    if (value && typeof value === "object") {
      const entries = Object.entries(value);
      if (!entries.length) out.set(path, JSON.stringify(value));
      for (const [key, item] of entries) flat(item, `${path}/${key}`, out);
    } else out.set(path, JSON.stringify(value));
    return out;
  };
  const a = flat(before), b = flat(after);
  return [...new Set([...a.keys(), ...b.keys()])].filter(key => a.get(key) !== b.get(key)).sort();
}
const changedLines = (before, after) => {
  const count = text => text.split("\n").reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map());
  const a = count(before), b = count(after);
  return { removed: [...a].filter(([line, n]) => (b.get(line) ?? 0) < n).map(([line]) => line),
    added: [...b].filter(([line, n]) => (a.get(line) ?? 0) < n).map(([line]) => line) };
};

test("MAP-1A removing one stored observation, note or key source removes exactly that element", t => {
  const root = project(t);
  const seeded = seedApiMapFixture(root);
  const original = readStore(root), before = build(root), beforeHtml = renderApiMapHtml(before);

  // One observation: the 404. Only that operation's row, two standing counts,
  // its exclusive observed→written class and the counted-response total move.
  const member = "GET /v1/hubs/{hubId}/members/{memberId}";
  const withoutObservation = structuredClone(original);
  withoutObservation.api_context.operations[seeded.operationId(member)].observations = [];
  writeStore(root, withoutObservation);
  const afterObservation = build(root);
  const index = before.operations.findIndex(item => item.op === member);
  const noteIndex = before.notes.findIndex(item => item.op === member);
  const paths = changed(before, afterObservation);
  assert.ok(paths.length > 0);
  for (const path of paths) assert.ok(path.startsWith(`/operations/${index}/`)
    || path.startsWith(`/notes/${noteIndex}/evidence_class/`)
    || ["/counts/latest-response", "/counts/no-response", "/observations/counted",
      "/counts/evidence_classes/observed", "/counts/evidence_classes/written"].includes(path), path);
  assert.equal(row(afterObservation, member).standing.key, "no-response");
  assert.equal(afterObservation.counts["latest-response"], before.counts["latest-response"] - 1);
  assert.equal(afterObservation.counts["no-response"], before.counts["no-response"] + 1);
  const lines = changedLines(beforeHtml, renderApiMapHtml(afterObservation));
  assert.equal(lines.removed.length, 4, lines.removed.join("\n"));
  for (const line of [...lines.removed, ...lines.added])
    assert.ok(line.includes("/members/{memberId}") || line.startsWith('<div class="am-tiles">') || line.startsWith('<p class="am-basis">Basis: contract'), line);

  // One note: only that note, its operation's note count and the total move.
  const noteOp = "POST /v1/hubs/{hubId}/tasks";
  const withoutNote = structuredClone(original);
  Object.assign(withoutNote.operations[noteOp], { notes: [], notes_provenance: [], notes_superseded: [] });
  writeStore(root, withoutNote);
  const afterNote = build(root);
  const removedNote = before.notes.find(note => note.op === noteOp);
  assert.deepEqual(afterNote.notes, before.notes.filter(note => note !== removedNote));
  const withoutNoteFields = model => ({ ...model, notes: null, counts: { ...model.counts, notes: null },
    operations: model.operations.map(item => item.op === noteOp ? { ...item, notes: null, note_history: null } : item) });
  assert.deepEqual(withoutNoteFields(afterNote), withoutNoteFields(before));
  assert.equal(afterNote.counts.notes, before.counts.notes - 1);
  assert.equal(row(afterNote, noteOp).notes, row(before, noteOp).notes - 1);
  const afterNoteHtml = renderApiMapHtml(afterNote);
  assert.ok(beforeHtml.includes(removedNote.text) && !afterNoteHtml.includes(removedNote.text));
  for (const note of afterNote.notes) assert.ok(afterNoteHtml.includes(note.text.replaceAll("'", "&#39;")), note.text);

  // One key source: only that record, its operation's key count, its path
  // key's row in the key table and the totals move. The only source of the
  // taskId key: that row becomes "not recorded".
  const nonTiles = lines => lines.filter(line => !line.startsWith('<div class="am-tiles">'));
  const removeKey = (keyOp, param) => {
    const withoutKey = structuredClone(original);
    const records = withoutKey.api_context.operations[seeded.operationId(keyOp)].key_sources;
    records.splice(records.findIndex(record => record.param === param && record.location === "path"), 1);
    writeStore(root, withoutKey);
    const afterKey = build(root);
    const removedKey = before.key_sources.find(key => key.op === keyOp && key.param === param && key.location === "path");
    assert.deepEqual(afterKey.key_sources, before.key_sources.filter(key => key !== removedKey));
    const withoutKeyFields = model => ({ ...model, key_sources: null, key_slots: model.key_slots.map(slot => slot.param === param ? null : slot),
      counts: { ...model.counts, key_sources: null, key_slots_sourced: null },
      operations: model.operations.map(item => item.op === keyOp ? { ...item, key_sources: null } : item) });
    assert.deepEqual(withoutKeyFields(afterKey), withoutKeyFields(before));
    assert.equal(afterKey.counts.key_sources, before.counts.key_sources - 1);
    return { afterKey, keyLines: changedLines(beforeHtml, renderApiMapHtml(afterKey)) };
  };
  const onlySource = removeKey("GET /v1/hubs/{hubId}/tasks/{taskId}", "taskId");
  assert.deepEqual(onlySource.afterKey.key_slots.find(slot => slot.param === "taskId").sources, []);
  assert.equal(onlySource.afterKey.counts.key_slots_sourced, before.counts.key_slots_sourced - 1);
  assert.deepEqual(nonTiles(onlySource.keyLines.removed).map(line => line.startsWith("<tr><td><code>taskId</code>") && line.includes("seen on 1 operation")), [true]);
  assert.deepEqual(nonTiles(onlySource.keyLines.added), ["<tr><td><code>taskId</code></td><td><code>/v1/hubs/{hubId}/tasks/{taskId}</code></td><td>not recorded</td></tr>"]);
  // One of three operations that recorded the same hubId source: that source
  // is seen on one operation fewer, and nothing else on the page moves.
  const oneOfThree = removeKey("GET /v1/hubs/{hubId}/tasks", "hubId");
  assert.equal(oneOfThree.afterKey.key_slots.find(slot => slot.param === "hubId").sources[0].seen_on, 2);
  assert.equal(oneOfThree.afterKey.counts.key_slots_sourced, before.counts.key_slots_sourced);
  assert.deepEqual(oneOfThree.keyLines.removed.map(line => line.includes("seen on 3 operations")), [true]);
  assert.deepEqual(oneOfThree.keyLines.added.map(line => line.startsWith("<tr><td><code>hubId</code>") && line.includes("seen on 2 operations")), [true]);
  writeStore(root, original);
  assert.deepEqual(build(root), before, "restoring the store restores the map");
});

test("MAP-1A show and the map agree on every operation's observed label, statuses and counts", async t => {
  const root = project(t);
  seedApiMapFixture(root);
  // show grades staleness against the clock; the map is built at the same moment.
  const model = build(root, { now: Date.now() });
  const shown = [];
  for (let start = 0; start < model.operations.length; start += 6) {
    shown.push(...await Promise.all(model.operations.slice(start, start + 6).map(async item => {
      try {
        const { stdout } = await execute(process.execPath, [CLI, "show", item.op], { cwd: root, env: cliEnv(root), encoding: "utf8", timeout: 30000 });
        return { item, detail: JSON.parse(stdout) };
      } catch (error) { return { item, error: JSON.parse(error.stderr || "{}").error?.code ?? `exit ${error.code}` }; }
    })));
  }
  for (const { item, detail, error } of shown) {
    const observed = ["observed", "observed-after-failure"].includes(item.standing.key);
    if (error) {
      // show reports nothing for an operation with no store entry and no
      // scoped history; the map must not call it observed either.
      assert.equal(error, "OPERATION_NOT_FOUND", item.op);
      assert.equal(item.in_store, false, item.op);
      assert.equal(observed, false, item.op);
      assert.equal(item.responses, 0, item.op);
      continue;
    }
    const summary = detail.observation_summary;
    assert.equal(observationConfidence(null, summary) === "observed", observed, `${item.op}: show and the map disagree about observed`);
    assert.deepEqual(item.latest_status_codes, summary.latest_recorded_status_codes, item.op);
    assert.deepEqual(item.status_codes, summary.observed_status_codes, item.op);
    assert.equal(item.responses, summary.observation_count, item.op);
    assert.equal(item.standing.key === "scope-unresolved", summary.state === "scope-unresolved", item.op);
    if (item.learned) assert.equal(item.learned.confidence, detail.legacy_confidence ?? detail.confidence, item.op);
  }
  assert.ok(shown.filter(entry => !entry.error).length >= 16, "show answered for every stored operation");
});

const pageChecks = (html, { svgMarkers = false } = {}) => {
  assert.doesNotMatch(html, /<script|<link|<iframe|<object|<embed|\bsrc\s*=|@import|\bon[a-z]+\s*=/i);
  // The footprint graph's arrowheads reference an in-document SVG marker; no
  // other url() is allowed, and none at all on the view page.
  const urls = [...html.matchAll(/url\s*\(([^)]*)\)/gi)].map(match => match[1]);
  assert.deepEqual(urls.filter(value => !(svgMarkers && value.startsWith("#"))), []);
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">/);
  assert.doesNotMatch(html, /href="(?!#)/, "no link leaves the page");
};

test("MAP-1A view and map pages carry no script, no external resource and the CSP; filters are CSS-only and the full table renders with CSS off", t => {
  const root = project(t);
  seedApiMapFixture(root);
  const model = build(root);
  const view = renderViewHtml(buildViewModel(root, { generatedAt: AT, env: envFor(root) }));
  const footprint = footprintModel({ root, surfaces: [], edges: [], external: [], platform: [] });
  const map = renderMapHtml(footprint, { apiMap: model });
  pageChecks(view);
  pageChecks(map, { svgMarkers: true });
  for (const html of [view, map]) {
    assert.ok(html.includes(API_MAP_CSS));
    assert.match(html, /@media\s*\(prefers-color-scheme:\s*dark\)/, "the page carries a dark palette");
    // The filters are radio inputs and labels; every selector is fixed CSS.
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      assert.match(html, new RegExp(`<input type="radio" class="am-radio" name="am-method" id="am-method-${method}">`));
      assert.match(html, new RegExp(`<label for="am-method-${method}">`));
      assert.ok(html.includes(`#am-method-${method}:checked~.am-scroll .am-r:not(.am-row-${method}){display:none}`));
    }
    for (const key of ["observed", "latest-response", "write-no-response"])
      assert.ok(html.includes(`#am-standing-${key}:checked~.am-scroll .am-r:not(.am-row-${key}){display:none}`));
    // With CSS off nothing hides a row: every operation is in the full table.
    const plain = html.replace(/<style>[\s\S]*?<\/style>/g, "");
    const rows = [...plain.matchAll(/<tr class="am-r [^"]*">([\s\S]*?)<\/tr>/g)];
    assert.equal(rows.length, 17);
    for (const item of model.operations) assert.ok(rows.some(([, cells]) => cells.includes(`<code>${item.path}</code>`)), item.op);
    assert.doesNotMatch(plain, /<tr[^>]*(?:hidden|style=)/);
  }
  // The API map precedes operations; attention may precede the API map.
  const header = view.slice(view.indexOf("<header>"), view.indexOf("</header>"));
  assert.doesNotMatch(header, /<ul>|<li>/);
  assert.ok(view.indexOf('<section id="api-map"') < view.indexOf('<section id="operations"'));
  assert.match(view.match(/<nav aria-label="Sections">([\s\S]*?)<\/nav>/)?.[1] ?? "", /<a href="#api-map">API map<\/a>/);
});

test("MAP-1A planted values in evidence, URLs and credentials never appear on any surface", t => {
  const root = project(t);
  seedApiMapFixture(root);
  // The markers are really there to be leaked: evidence and environment hold them.
  const evidence = fs.readdirSync(join(root, LAYOUT.evidence)).map(file => readFileSync(join(root, LAYOUT.evidence, file), "utf8")).join("\n");
  for (const key of ["hub", "task", "member", "query", "cursor", "credential", "body"]) assert.ok(evidence.includes(MARKERS[key]), key);
  assert.equal(process.env.HEARTH_TOKEN, MARKERS.token);
  const model = build(root);
  const surfaces = {
    model: JSON.stringify(model), fragment: renderApiMapHtml(model), text: renderApiMapText(model),
    view: renderViewHtml(buildViewModel(root, { generatedAt: AT, env: envFor(root) })),
  };
  const receipt = run(root, ["map", ".", "--no-execute"]);
  assert.equal(receipt.status, 0, receipt.stderr);
  Object.assign(surfaces, { receipt: receipt.stdout + receipt.stderr, mapHtml: readFileSync(join(root, LAYOUT.mapOutput), "utf8"),
    json: run(root, ["map", ".", "--no-execute", "--json"]).stdout, mapText: run(root, ["map", ".", "--no-execute", "--text"]).stdout });
  const viewRun = run(root, ["view", "--json"]);
  assert.equal(viewRun.status, 0, viewRun.stderr);
  surfaces.viewFile = readFileSync(JSON.parse(viewRun.stdout).path, "utf8");
  for (const [surface, text] of Object.entries(surfaces)) {
    assert.ok(text.length > 0, surface);
    for (const [name, value] of Object.entries(MARKERS)) assert.ok(!text.includes(value), `${surface} leaked the ${name} marker`);
  }
});

test("MAP-1A contract text and notes are escaped; class names come only from the fixed vocabulary", t => {
  const root = project(t);
  const seeded = seedApiMapFixture(root);
  const allowed = new Set(["am", "am-basis", "am-tiles", "am-tile", "am-legend", "am-chip", "am-learned", "am-q", "am-group", "am-n",
    "am-scroll", "am-nw", "am-wide", "am-code", "am-m", "am-filters", "am-radio", "am-filter", "am-all", "am-r", "am-tone-neutral",
    ...API_MAP_METHODS.flatMap(method => [`am-m-${method.toLowerCase()}`, `am-row-${method.toLowerCase()}`]),
    ...Object.keys(API_MAP_STANDINGS).flatMap(key => [`am-s-${key}`, `am-row-${key}`])]);
  const vocabulary = html => {
    for (const [, classes] of html.matchAll(/class="([^"]*)"/g))
      for (const name of classes.split(" ")) assert.ok(allowed.has(name), `unexpected class ${name}`);
    for (const [, id] of html.matchAll(/\bid="([^"]*)"/g)) assert.match(id, /^(api-map|am-title|am-(method|standing)-[a-z-]+)$/);
  };
  // Store text first, with the contract untouched so the scope still binds
  // and the key source is rendered.
  const store = readStore(root);
  store.operations["GET /v1/hubs/{hubId}/tasks"].notes.push('</td><script>alert(2)</script><style>body{}</style>');
  store.operations["GET /v1/hubs/{hubId}/tasks"].notes_provenance.push({ by: "agent", at: "2026-09-29" });
  store.operations["GET /v1/hubs/{hubId}/tasks"].notes_superseded.push(null);
  store.api_context.operations[seeded.operationId("GET /v1/hubs/{hubId}")].key_sources[0].source.field = "data[].<i>id</i>";
  writeStore(root, store);
  const stored = renderApiMapHtml(build(root));
  assert.doesNotMatch(stored, /<script|<style|<\/td><script|<i>id/);
  assert.ok(stored.includes("&lt;/td&gt;&lt;script&gt;alert&#40;2)&lt;/script&gt;&lt;style&gt;body{}&lt;/style&gt;"));
  assert.ok(stored.includes("<code>data[].&lt;i&gt;id&lt;/i&gt;</code>"));
  vocabulary(stored);
  // Then contract text: summaries, tags and paths are untrusted too.
  const contract = JSON.parse(readFileSync(join(root, CONTRACT), "utf8"));
  contract.paths["/v1/hubs/{hubId}/members"].get.summary = 'List <script>alert(1)</script> url(x) @import src=y';
  contract.paths["/v1/me"].get.tags = ['Me" class="evil'];
  contract.paths["/v1/<img/src=x/onerror=y>"] = { get: { tags: ["<b>Bold</b>"], summary: "Hostile path" } };
  contract.paths["/v1/hubs/{hubId}/tasks/{taskId}"].get.summary = "Example token ghp_" + "b".repeat(36);
  writeFileSync(join(root, CONTRACT), JSON.stringify(contract));
  const hostile = build(root);
  // Third-party contract text the secret scan flags is withheld and counted;
  // it does not refuse the page.
  assert.equal(hostile.omissions.contract_text_withheld, 1);
  // Withheld where it would render (MAP-1A fix round 2): the summary reads
  // "withheld", and one line counts what was withheld by kind.
  assert.equal(row(hostile, "GET /v1/hubs/{hubId}/tasks/{taskId}").summary, "withheld");
  const html = renderApiMapHtml(hostile);
  assert.ok(!html.includes("ghp_"));
  assert.match(html, /Withheld by the secret and promotion scans: 1 contract tag or summary\./);
  assert.doesNotMatch(html, /<script|<img|<b>Bold|<style|onerror=y>|class="evil/);
  assert.ok(html.includes("List &lt;script&gt;alert&#40;1)&lt;/script&gt; url&#40;x) &#64;import src&#61;y"));
  assert.ok(html.includes("&lt;b&gt;Bold&lt;/b&gt;"));
  assert.ok(html.includes("<code>/v1/&lt;img/src&#61;x/onerror&#61;y&gt;</code>"));
  assert.ok(html.includes("Me&quot; class&#61;&quot;evil"));
  vocabulary(html);
  // The view's active-content guard still accepts the page: hostile text is
  // text, not a reason to refuse it.
  const view = renderViewHtml(buildViewModel(root, { generatedAt: AT, env: envFor(root) }));
  assert.ok(view.includes("&lt;img/src&#61;x/onerror&#61;y&gt;"));
});

function countStoreReads(store, fn) {
  const original = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (path, ...rest) {
    if ((typeof path === "string" || path instanceof URL) && resolve(String(path instanceof URL ? fileURLToPath(path) : path)) === store) reads++;
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try { return { value: fn(), reads }; } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
}

test("MAP-1A a 2,000-operation store meets its CPU budget (Node 22: 3s; newer Node: 2s) with one store read", t => {
  const root = project(t, "api-map-large-");
  const { operations, store } = seedLargeStore(root);
  assert.equal(operations, 2000);
  const env = envFor(root);
  // 2026-10-07 Node 22 / ubuntu-latest evidence (CPU milliseconds):
  // same tree: PR 40 view 1305, merged main 2025 three minutes later;
  // subsequent main/PR runs: 2017–2131; isolated run 37665074144:
  // API map 1702, view 2138 (wall 1464/1674). Node 24 passed that run.
  // Isolation stays, but did not remove Node 22's hosted-runner variance.
  // Use 3000 only on Node 22: 50% over the original ceiling, about 40% over
  // the observed isolated maximum. A 2500 ceiling leaves only 17% above it.
  // Newer Node retains 2000. This is a regression guard, not a speed claim;
  // report raw CPU/wall time and keep the exact one-store-read requirement.
  const cpuBudgetMs = Number(process.versions.node.split(".")[0]) === 22 ? 3000 : 2000;
  const timed = (label, fn) => {
    const cpu = process.cpuUsage(), started = performance.now();
    const { value, reads } = countStoreReads(store, fn);
    const wall = performance.now() - started, used = process.cpuUsage(cpu), cpuMs = (used.user + used.system) / 1000;
    t.diagnostic(`${label}: ${Math.round(cpuMs)} ms CPU, ${Math.round(wall)} ms wall, ${reads} store read; budget ${cpuBudgetMs} ms CPU`);
    assert.equal(reads, 1, `${label} reads the store once`);
    assert.ok(cpuMs <= cpuBudgetMs, `${label} used ${Math.round(cpuMs)} ms of CPU; budget ${cpuBudgetMs} ms`);
    return value;
  };
  const map = timed("API map", () => renderApiMapHtml(buildApiMapModel(root, { now: Date.parse(AT), env })));
  assert.ok(map.includes("<b>2000</b><span>operations</span>"));
  const view = timed("view, API map included", () => renderViewHtml(buildViewModel(root, { generatedAt: AT, env })));
  assert.ok(view.includes('<section id="api-map"'));
});

test("MAP-1A map on a consumer-only repository reports the API map instead of only zeros", t => {
  const root = project(t);
  seedApiMapFixture(root);
  const receipt = run(root, ["map", ".", "--no-execute"]);
  assert.equal(receipt.status, 0, receipt.stderr);
  assert.match(receipt.stdout, /\| 0 +\|[\s\S]*SERVICES/, "the footprint still says it serves nothing");
  assert.match(receipt.stdout, /\/\/ API MAP · projected from the store and contract/);
  assert.match(receipt.stdout, /API map — Hearth API: 17 operations/);
  assert.match(receipt.stdout, /passing response histories\s+4 \(1 after a failed attempt\)/);
  assert.match(receipt.stdout, /writes, no response recorded\s+5/);
  assert.match(receipt.stdout, /scope\s+production, marked production · https:\/\/api\.hearth\.test/);
  const html = readFileSync(join(root, LAYOUT.mapOutput), "utf8");
  assert.match(html, /<section id="api-map" class="am"/);
  pageChecks(html, { svgMarkers: true });
  const json = JSON.parse(run(root, ["map", ".", "--no-execute", "--json"]).stdout);
  assert.equal(json.summary.services, 0);
  assert.equal(json.api_map.counts.operations, 17);
  assert.equal(json.api_map.counts.observed_total, 4);
  assert.equal(json.api_map.scope.environment, "production");
  assert.match(run(root, ["map", ".", "--no-execute", "--text"]).stdout, /API map — Hearth API: 17 operations/);
  // With no outbound reference anywhere the footprint alone is NO_API_FOUND
  // (exit 1 on the parent commit); the store is still a map.
  const bare = project(t);
  seedApiMapFixture(bare, { withSource: false });
  const quiet = run(bare, ["map", ".", "--no-execute"]);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.match(quiet.stdout, /API map — Hearth API: 17 operations/);
  // A repository without a store keeps the named error.
  const empty = project(t);
  writeFileSync(join(empty, "README.md"), "# nothing\n");
  const none = run(empty, ["map", ".", "--no-execute"]);
  assert.equal(none.status, 1);
  assert.equal(JSON.parse(none.stdout || none.stderr).error.code, "NO_API_FOUND");
});

test("MAP-1A provider footprint retains data, offline execution guidance and offline themes", t => {
  // CODE-1 adds a local code index to JSON and HTML; the original footprint
  // fields, text and receipt stay intact. HTML also retains PR 51 themes/CSP
  // and FIELD-1a explicit execution guidance. Inspect the normalized diff
  // before changing a pin; see the fixture's `source`.
  const golden = JSON.parse(readFileSync(join(ROOT, "test/fixtures/api-map/provider-unchanged.json"), "utf8"));
  const root = join(project(t, "provider-"), "provider-fixture");
  cpSync(join(ROOT, "test/fixtures/audit-live-shapes"), root, { recursive: true });
  const env = { ...process.env, [HOME_ENV_NAME]: join(root, ".home") };
  const map = args => spawnSync(process.execPath, [CLI, "map", ".", "--no-execute", ...args], { cwd: root, env, encoding: "utf8" });
  // The page names the CLI as `node <checkout>/bin/cli.mjs`, quoted (and then
  // HTML-escaped) when the checkout path needs quoting; normalize every form.
  const normal = text => text.replaceAll(root, "<ROOT>").replaceAll(ROOT, "<REPO>")
    .replace(/(['"]|&#39;)<REPO>\/bin\/cli\.mjs\1/g, "<REPO>/bin/cli.mjs")
    .replace(/generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, "generated <TIME>").replace(/"generated_at": "[^"]*"/g, '"generated_at": "<TIME>"');
  const digest = text => createHash("sha256").update(text).digest("hex");
  const receipt = map([]);
  assert.equal(receipt.status, golden.status);
  assert.equal(receipt.stderr, golden.stderr);
  assert.equal(normal(receipt.stdout), golden.receipt);
  const mapped = JSON.parse(map(["--json"]).stdout);
  assert.equal(mapped.survey.state, 'not-generated');
  assert.match(mapped.survey.command, /survey generate/u);
  // The explicit survey is additive. Keep the original footprint pin rather
  // than replacing its expected hash with an unchecked new whole-page hash.
  delete mapped.survey;
  assert.equal(digest(normal(JSON.stringify(mapped, null, 2) + '\n')), golden.json_sha256);
  assert.equal(digest(normal(map(["--text"]).stdout)), golden.text_sha256);
  const html = readFileSync(join(root, LAYOUT.mapOutput), "utf8");
  assert.match(html, /data-survey-state="not-generated"/u);
  assert.equal(digest(normal(html.replace(/<section data-survey-state="not-generated">[\s\S]*?<\/section>/u, ''))), golden.html_sha256);
  assert.match(html, /Use --execute to announce and send declared reads through the API client/);
  assert.doesNotMatch(html, /Re-run without --no-execute|id="api-map"|class="api-map/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /id="report-theme-dark" checked/);
});

test("MAP-1A view's per-operation details use the shared standing", t => {
  const root = project(t);
  seedApiMapFixture(root);
  const result = run(root, ["view", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(JSON.parse(result.stdout).path, "utf8");
  const details = op => {
    const start = html.indexOf(`<summary><code>${op}</code>`);
    assert.ok(start >= 0, op);
    return html.slice(start, html.indexOf("</details>", start));
  };
  assert.match(details("GET /v1/hubs/{hubId}/tasks"), /<span class="state">asserted · observed after a failed attempt · learned unverified<\/span>/);
  assert.match(details("GET /v1/hubs/{hubId}/tasks"), /Responses in scope: 2 counted; newest recorded 2026-09-26T10:01:00.000Z; latest status 200\./);
  assert.match(details("GET /v1/hubs"), /<span class="state">verified · observed · learned verified<\/span>/);
  // "Not measured" only where no response is recorded in scope.
  const unmeasured = "Not measured: no executions recorded yet.";
  for (const [op, standing] of Object.entries(EXPECTED_STANDINGS)) {
    if (op === "GET /v1/hubs/{hubId}/tasks/{taskId}/history") continue; // not in the store: no details card
    assert.equal(details(op).includes(unmeasured), ["no-response", "write-no-response"].includes(standing), op);
  }
});

test("MAP-1A a scope that cannot be bound, or history that cannot be read, is named rather than guessed", t => {
  const root = project(t);
  seedApiMapFixture(root);
  unlinkSync(join(root, LAYOUT.environments));
  const unbound = build(root);
  assert.equal(unbound.scope.state, "unresolved");
  assert.match(unbound.scope.reason, /no base URL is configured/);
  assert.equal(unbound.counts["scope-unresolved"], 17);
  assert.match(renderApiMapHtml(unbound), /Scope unresolved: no base URL is configured/);
  // A damaged registry makes granted history unreadable: show withholds the
  // observed label, and so does the map, naming the code.
  const bound = project(t);
  seedApiMapFixture(bound);
  const registry = registryPath(envFor(bound));
  fs.mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(registry, "{damaged");
  const damaged = build(bound);
  assert.equal(row(damaged, "GET /v1/hubs").standing.key, "unavailable");
  assert.deepEqual(row(damaged, "GET /v1/hubs").standing.qualifiers, ["REGISTRY_INVALID"]);
  assert.equal(damaged.counts.observed_total, 0);
  // A malformed store is a named failure, not an empty map.
  writeFileSync(storePath(bound), "{");
  assert.throws(() => build(bound), { code: "API_MAP_CONTEXT_INVALID" });
  assert.equal(existsSync(storePath(bound)), true);
});

test("MAP-1A key-source lists are validated per record; a damaged list is absent and counted, a full valid list is kept", t => {
  const root = project(t);
  const seeded = seedApiMapFixture(root);
  const store = readStore(root);
  const hub = seeded.operationId("GET /v1/hubs/{hubId}");
  const valid = store.api_context.operations[hub].key_sources[0];
  // Sixteen entries, at most two sources per key: the bound, all shown.
  store.api_context.operations[hub].key_sources = [valid, ...Array.from({ length: 15 }, (_, i) => ({ ...valid, param: `key${i}` }))];
  writeStore(root, store);
  const full = build(root);
  assert.equal(full.key_sources.filter(key => key.op === "GET /v1/hubs/{hubId}").length, 16);
  assert.equal(full.omissions.key_source_records_damaged, 1, "only the fixture's own damaged list");
  // One secret-shaped entry damages that record's whole list, nothing else.
  store.api_context.operations[hub].key_sources.push({ ...valid, param: "ghp_" + "a".repeat(36) });
  store.api_context.operations[hub].key_sources.splice(1, 1);
  writeStore(root, store);
  const model = build(root);
  assert.equal(model.omissions.key_source_records_damaged, 2);
  assert.deepEqual(model.key_sources.filter(key => key.op === "GET /v1/hubs/{hubId}"), []);
  assert.equal(row(model, "GET /v1/hubs/{hubId}").standing.key, "observed");
  const html = renderApiMapHtml(model);
  assert.ok(!html.includes("ghp_"));
  assert.match(html, /2 operation records have a damaged key-source list; their links are treated as absent\./);
});

// The route matcher `show` binds identities with, before the index: every
// route of the method is scanned and each segment matched by reachability.
function scanMatch(contract, method, pathname) {
  const segmentMatches = (template, value) => {
    if (template === value) return true;
    if (!template.includes("{")) return false;
    const pattern = [];
    for (let cursor = 0; cursor < template.length;) {
      const open = template.indexOf("{", cursor), close = open < 0 ? -1 : template.indexOf("}", open + 1);
      if (close < 0) { for (const char of template.slice(cursor)) pattern.push(char); break; }
      for (const char of template.slice(cursor, open)) pattern.push(char);
      pattern.push(null);
      cursor = close + 1;
    }
    const chars = Array.from(value);
    if (pattern.length > chars.length) return false;
    let previous = new Uint8Array(chars.length + 1);
    previous[0] = 1;
    for (const token of pattern) {
      const current = new Uint8Array(chars.length + 1);
      for (let end = 1; end <= chars.length; end++)
        current[end] = token === null ? previous[end - 1] || current[end - 1] : previous[end - 1] && token === chars[end - 1] ? 1 : 0;
      previous = current;
    }
    return previous[chars.length] === 1;
  };
  const routeMatches = (route, path) => {
    const segments = route.split("/"), actual = path.split("/");
    if (actual.length === segments.length + 1 && actual.at(-1) === "") actual.pop();
    return actual.length === segments.length && segments.every((segment, index) => segmentMatches(segment, actual[index]));
  };
  const candidates = (contract?.routes ?? []).filter(operation => operation.method === method);
  const exact = candidates.filter(operation => operation.endpointPath === pathname);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const matches = candidates.filter(operation => routeMatches(operation.endpointPath, pathname));
  return matches.length === 1 ? matches[0] : null;
}

test("MAP-1A the indexed route match answers exactly what the full scan answered", () => {
  let seed = 0x5eed;
  const random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = items => items[Math.floor(random() * items.length)];
  const templates = ["a", "b", "v1", "{x}", "{y}", "x{y}", "{a}{b}", "{", "}{", "", "a{x}b", "{x}.json"];
  const values = ["a", "b", "v1", "1", "%7Bx%7D", "", "ab", "x1", "a1b", "12.json", "{x}", "é"];
  let compared = 0;
  for (let round = 0; round < 300; round++) {
    const routes = Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
      const path = "/" + Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(templates)).join("/") + (random() < 0.2 ? "/" : "");
      return { method: pick(["GET", "POST"]), endpointPath: path, op: `${path}#${random()}` };
    });
    const contract = { routes };
    for (let probe = 0; probe < 30; probe++) {
      const path = random() < 0.3 ? pick(routes).endpointPath
        : "/" + Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(values)).join("/") + (random() < 0.25 ? "/" : "");
      const method = pick(["GET", "POST", "PUT"]);
      assert.equal(matchHttpOperation(contract, method, path), scanMatch(contract, method, path), `${method} ${path} over ${JSON.stringify(routes)}`);
      compared++;
    }
  }
  assert.equal(compared, 9000);
  assert.equal(matchHttpOperation(null, "GET", "/a"), null);
  assert.equal(matchHttpOperation({ routes: [{ method: "GET", endpointPath: "/a/{x}" }] }, "GET", "/a/"), null);
});
