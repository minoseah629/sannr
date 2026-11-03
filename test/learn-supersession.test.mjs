import { LAYOUT } from "../lib/layout.mjs";
import { createFixtureStack, fixtureContextFile, inFixtureStack } from "./helpers/stack-fixture.mjs";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorMarker, isValidSupersessionMarker, loadContextSnapshot, acceptNoteHistory, inspectNoteHistory } from "../lib/context.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const REQUEST = join(ROOT, "bin", "request.mjs");

function run(dir, command, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [command, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        API_AUTHOR: "supersession-test",
        API_USAGE_LOG: join(dir, "usage.jsonl"),
        API_EVIDENCE: join(dir, "evidence"),
        ...extraEnv,
      },
    }, (error, stdout, stderr) => resolve({
      code: error?.code ?? 0,
      stdout,
      stderr,
      out: `${stdout}${stderr}`,
    }));
  });
}

function sandbox(origin) {
  const dir = mkdtempSync(join(tmpdir(), "sannr-supersession-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0",
    "info: { title: supersession, version: '1' }",
    "paths:",
    "  /items/:",
    "    get:",
    "      responses:",
    "        '200':",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: object",
    "                properties:",
    "                  data:",
    "                    type: array",
    "                    items:",
    "                      type: object",
    "                      properties:",
    "                        id: { type: integer }",
    "                        tier: { type: string, enum: [basic, pro] }",
    "                        secret_value: { type: string }",
    "",
  ].join("\n"));
  createFixtureStack(dir, { baseUrl: origin, contract: "openapi.yaml" });
  return dir;
}

const contextAt = (dir) => JSON.parse(readFileSync(fixtureContextFile(dir), "utf8"));
const acknowledgeNotes = dir => {
  const snapshot = inFixtureStack(dir, () => loadContextSnapshot(dir)), operation = 'GET /items/';
  inFixtureStack(dir, () => acceptNoteHistory(dir, snapshot, { operation, expectedDigest: inspectNoteHistory(snapshot.ctx.operations[operation]).digest,
    stamp: { by: 'fixture-review', at: '2026-09-30' } }));
};
const writeContext = (dir, ctx) =>
  writeFileSync(fixtureContextFile(dir), `${JSON.stringify(ctx, null, 2)}\n`);

function startApi(port, { gated = false } = {}) {
  let seenResolve;
  let releaseResolve;
  const seen = new Promise((resolve) => { seenResolve = resolve; });
  const release = new Promise((resolve) => { releaseResolve = resolve; });
  const server = createServer(async (req, res) => {
    seenResolve?.();
    if (gated) await release;
    const body = JSON.stringify({ data: [{ id: 731, tier: "pro", secret_value: "must-never-land" }] });
    res.writeHead(req.url === "/items/" ? 200 : 404, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({
      server,
      origin: `http://127.0.0.1:${server.address().port}`,
      seen,
      release: () => releaseResolve(),
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}

async function unusedOrigin() {
  const reserved = await startApi(0);
  const { origin } = reserved;
  await reserved.close();
  return origin;
}

let state;

test("supersession markers require a plain own-data record with a safe timestamp and author", () => {
  const valid = { at: "2026-08-26T12:34:56.789Z", by: "agent", reason: "successful_verification" };
  assert.equal(isValidSupersessionMarker(valid), true);
  for (const at of [
    "2000-02-29",
    "2024-02-29",
    "2024-02-29T00:00:00Z",
    "2026-06-15T12:30:45.12Z",
    "2026-01-31T23:59:59.1+23:59",
    "2026-12-01T01:02:03.123-00:00",
  ]) assert.equal(isValidSupersessionMarker({ ...valid, at }), true, at);
  assert.equal(isValidSupersessionMarker({ ...valid, by: "Agent Δ" }), true);
  const inherited = Object.create(valid);
  const nullPrototype = Object.assign(Object.create(null), valid);
  const accessor = { reason: "successful_verification" };
  Object.defineProperty(accessor, "at", { enumerable: true, get: () => valid.at });
  for (const invalid of [
    null,
    "legacy-corrupt-truthy-cell",
    [valid],
    inherited,
    nullPrototype,
    accessor,
    { ...valid, reason: "manual" },
    { ...valid, at: "yesterday" },
    { ...valid, at: "2026-00-01" },
    { ...valid, at: "2026-13-01" },
    { ...valid, at: "2026-01-00" },
    { ...valid, at: "2026-01-32" },
    { ...valid, at: "2026-04-31" },
    { ...valid, at: "1900-02-29" },
    { ...valid, at: "2026-02-29" },
    { ...valid, at: "2026-02-30" },
    { ...valid, at: "2026-08-26T24:00:00Z" },
    { ...valid, at: "2026-08-26T23:60:00Z" },
    { ...valid, at: "2026-08-26T23:59:60Z" },
    { ...valid, at: "2026-08-26T23:59:59.Z" },
    { ...valid, at: "2026-08-26T23:59:59.1234Z" },
    { ...valid, at: "2026-08-26T23:59:59" },
    { ...valid, at: "2026-08-26T23:59:59z" },
    { ...valid, at: "2026-08-26T23:59:59+24:00" },
    { ...valid, at: "2026-08-26T23:59:59+00:60" },
    { ...valid, by: "person@example.com" },
    { ...valid, by: "x".repeat(40) },
    { ...valid, by: "agent\nspoof" },
    { ...valid, by: "agent\rspoof" },
    { ...valid, by: "agent\tspoof" },
    { ...valid, by: "agent\u0000spoof" },
    { ...valid, by: "agent\u007fspoof" },
    { ...valid, by: "agent\u2028spoof" },
    { ...valid, by: "agent\u2029spoof" },
  ]) assert.equal(isValidSupersessionMarker(invalid), false);
});

test("authorMarker cannot generate a by value the supersession predicate rejects", () => {
  const before = process.env.API_AUTHOR;
  try {
    for (const unsafe of ["agent\nspoof", "agent\u0000spoof", "agent\u2028spoof"]) {
      process.env.API_AUTHOR = unsafe;
      assert.equal(authorMarker("."), "agent", JSON.stringify(unsafe));
    }
  } finally {
    if (before === undefined) delete process.env.API_AUTHOR;
    else process.env.API_AUTHOR = before;
  }
});

before(async () => {
  const origin = await unusedOrigin();
  const dir = sandbox(origin);
  assert.equal((await run(dir, CLI, ["init"])).code, 0);

  const cold = contextAt(dir);
  const op = cold.operations["GET /items/"];
  op.notes = ["manual auth handshake remains required"];
  op.notes_provenance = [null];
  writeContext(dir, cold);
  acknowledgeNotes(dir);

  const failed = await run(dir, CLI, ["learn"]);
  assert.equal(failed.code, 0, failed.out);
  const afterFailure = contextAt(dir);
  const failedSnapshot = structuredClone(afterFailure);

  const failedEntry = afterFailure.operations["GET /items/"];
  failedEntry.notes.push(`Unreachable at http://127.0.0.1:9: ECONNREFUSED`);
  failedEntry.notes.push("Manual run saw ECONNREFUSED at an optional proxy; the endpoint itself works.");
  failedEntry.notes_provenance ??= [];
  failedEntry.notes_provenance.push(null, null);
  failedEntry.notes_superseded.push(null, null);
  writeContext(dir, afterFailure);
  acknowledgeNotes(dir);

  const api = await startApi(Number(new URL(origin).port));
  const success = await run(dir, CLI, ["learn"]);
  assert.equal(success.code, 0, success.out);
  const afterSuccess = contextAt(dir);
  const show = await run(dir, CLI, ["show", "GET /items"]);
  const agent = await run(dir, REQUEST, ["GET", "/items/"], {
    API_BASE_URL: origin,
    API_CONTEXT_DIR: dir,
    API_CONTRACT: join(dir, "openapi.yaml"),
  });
  const repeat = await run(dir, CLI, ["learn"]);
  assert.equal(repeat.code, 0, repeat.out);
  const afterRepeat = contextAt(dir);
  state = { dir, origin, api, afterFailure: failedSnapshot, afterSuccess, afterRepeat, show, agent };
});

after(async () => {
  await state?.api?.close();
});

test("successful learn marks generated failures while retaining unattributed legacy text and alignment", () => {
  const failed = state.afterFailure.operations["GET /items/"];
  assert.equal(failed.verified_at, null, "a failed learn is not verification");
  assert.deepEqual(failed.notes_superseded, failed.notes.map(() => null),
    "failed verification never supersedes anything");

  const entry = state.afterSuccess.operations["GET /items/"];
  assert.equal(entry.notes.length, 4, "the down learn preserves the pre-existing manual note");
  assert.equal(entry.notes_provenance.length, entry.notes.length);
  assert.equal(entry.notes_superseded.length, entry.notes.length);
  assert.equal(entry.notes[0], "manual auth handshake remains required");
  assert.equal(entry.notes_superseded[0], null);
  assert.match(entry.notes[1], new RegExp(`^Unreachable at ${state.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: ECONNREFUSED$`));
  assert.equal(entry.notes_provenance[1].kind, "learn_reachability_failure");
  assert.equal(entry.notes_provenance[1].code, "ECONNREFUSED");
  assert.equal(entry.notes_superseded[1].reason, "successful_verification");
  assert.equal(entry.notes[2], "Unreachable at http://127.0.0.1:9: ECONNREFUSED");
  assert.equal(entry.notes_provenance[2], null, "legacy notes retain their provenance hole");
  assert.equal(entry.notes_superseded[2], null, "legacy resemblance does not prove machine ownership");
  assert.equal(entry.notes_superseded[3], null,
    "arbitrary user prose containing ECONNREFUSED is never inferred to be generated");
});

test("show presents verified state while retaining explicit active/historical note markers", () => {
  assert.equal(state.show.code, 0, state.show.out);
  const shown = JSON.parse(state.show.stdout);
  assert.equal(shown.confidence, "verified");
  assert.equal(shown.notes.length, 4, "show retains the raw historical note text");
  assert.equal(shown.notes_superseded[1].reason, "successful_verification");
  const active = shown.notes.filter((_, index) =>
    !isValidSupersessionMarker(shown.notes_superseded[index]));
  const historical = shown.notes.filter((_, index) =>
    isValidSupersessionMarker(shown.notes_superseded[index]));
  assert.deepEqual(active, [
    "manual auth handshake remains required",
    "Unreachable at http://127.0.0.1:9: ECONNREFUSED",
    "Manual run saw ECONNREFUSED at an optional proxy; the endpoint itself works.",
  ]);
  assert.equal(historical.length, 1);
  assert.ok(historical.every((note) => note.startsWith("Unreachable at")));
});

test("agent context excludes superseded failures but keeps unrelated active notes", () => {
  assert.equal(state.agent.code, 0, state.agent.out);
  const envelope = JSON.parse(state.agent.stdout);
  assert.equal(envelope.known.confidence, "verified");
  assert.deepEqual(envelope.known.notes, [
    "manual auth handshake remains required",
    "Unreachable at http://127.0.0.1:9: ECONNREFUSED",
    "Manual run saw ECONNREFUSED at an optional proxy; the endpoint itself works.",
  ]);
  assert.ok(!envelope.known.notes.some(note => note.startsWith(`Unreachable at ${state.origin}:`)),
    "only the attributable generated failure is superseded");
});

test("repeat success is marker-idempotent and promotion still withholds undeclared values", () => {
  const first = state.afterSuccess.operations["GET /items/"];
  const repeat = state.afterRepeat.operations["GET /items/"];
  assert.deepEqual(repeat.notes, first.notes);
  assert.deepEqual(repeat.notes_provenance, first.notes_provenance);
  assert.deepEqual(repeat.notes_superseded, first.notes_superseded,
    "a second success neither duplicates nor rewrites the supersession event");
  assert.deepEqual(repeat.fields.tier, { distinct: 1, values: ["pro"] },
    "only the contract-declared enum value is promotable");
  assert.deepEqual(repeat.fields.id, { distinct: 1 },
    "an undeclared numeric value promotes cardinality, never the observed value");
  assert.deepEqual(repeat.fields.secret_value, { distinct: 1 },
    "an undeclared string promotes cardinality, never the observed value");
  assert.ok(repeat.withheld >= 1);
});

test("a manual note added after supersession keeps text, provenance, and marker indices aligned", async () => {
  const noted = await run(state.dir, CLI, ["note", "GET /items", "post-verification manual note", "--alongside"]);
  assert.equal(noted.code, 0, noted.out);
  const entry = contextAt(state.dir).operations["GET /items/"];
  assert.equal(entry.notes.length, entry.notes_provenance.length);
  assert.equal(entry.notes.length, entry.notes_superseded.length);
  assert.equal(entry.notes.at(-1), "post-verification manual note");
  assert.equal(entry.notes_superseded.at(-1), null);
  assert.equal(entry.notes_provenance.at(-1).by, "supersession-test");
});

test("a malformed marker refuses learning without hiding text or repairing saved history", async () => {
  const api = await startApi(0), dir = sandbox(api.origin);
  try {
    assert.equal((await run(dir, CLI, ["init"])).code, 0);
    const ctx = contextAt(dir), entry = ctx.operations["GET /items/"];
    entry.notes = ["valid manual note survives malformed marker data"];
    entry.notes_provenance = [null];
    entry.notes_superseded = ["legacy-corrupt-truthy-cell"];
    writeContext(dir, ctx);
    const before = readFileSync(fixtureContextFile(dir), "utf8");
    const learned = await run(dir, CLI, ["learn", "--agents"]);
    assert.notEqual(learned.code, 0);
    assert.match(learned.out, /NOTE_HISTORY_INVALID/);
    assert.equal(readFileSync(fixtureContextFile(dir), "utf8"), before);
    const shown = JSON.parse((await run(dir, CLI, ["show", "GET /items"])).stdout);
    assert.deepEqual(shown.notes, entry.notes);
    assert.equal(shown.notes_superseded[0], "legacy-corrupt-truthy-cell");
    assert.equal(shown.note_history.state, "invalid");
    assert.equal(shown.note_history.history.length, 0);
    const request = await run(dir, REQUEST, ["GET", "/items/"], {
      API_BASE_URL: api.origin, API_CONTEXT_DIR: dir, API_CONTRACT: join(dir, "openapi.yaml"),
    });
    assert.ok(JSON.parse(request.stdout).known.notes.includes(entry.notes[0]));
  } finally { await api.close(); }
});

test("calendar-impossible markers remain visible and unchanged; invalid history is not normalized", async () => {
  const api = await startApi(0), dir = sandbox(api.origin);
  try {
    assert.equal((await run(dir, CLI, ["init"])).code, 0);
    const ctx = contextAt(dir), entry = ctx.operations["GET /items/"];
    entry.notes = ["February overflow must stay active", "Hour overflow must stay active", "Valid leap-day history"];
    entry.notes_provenance = [null, null, null];
    entry.notes_superseded = [
      { at: "2026-02-30", by: "agent", reason: "successful_verification" },
      { at: "2026-08-26T24:00:00Z", by: "agent", reason: "successful_verification" },
      { at: "2024-02-29T23:59:59Z", by: "agent", reason: "successful_verification" },
    ];
    writeContext(dir, ctx);
    const before = readFileSync(fixtureContextFile(dir), "utf8");
    const learned = await run(dir, CLI, ["learn", "--agents"]);
    assert.notEqual(learned.code, 0);
    assert.match(learned.out, /NOTE_HISTORY_INVALID/);
    assert.equal(readFileSync(fixtureContextFile(dir), "utf8"), before);
    const shown = JSON.parse((await run(dir, CLI, ["show", "GET /items"])).stdout);
    assert.deepEqual(shown.notes_superseded, entry.notes_superseded);
    assert.equal(isValidSupersessionMarker(shown.notes_superseded[2]), true,
      "strict leap-day grammar still accepts the valid marker");
    assert.equal(shown.note_history.state, "invalid");
    assert.deepEqual(shown.note_history.active.map(record => record.text), entry.notes,
      "suspect history remains inspectable instead of allowing any marker to hide text");
    const request = await run(dir, REQUEST, ["GET", "/items/"], {
      API_BASE_URL: api.origin, API_CONTEXT_DIR: dir, API_CONTRACT: join(dir, "openapi.yaml"),
    });
    assert.deepEqual(JSON.parse(request.stdout).known.notes, entry.notes);
  } finally { await api.close(); }
});

test("a note written while learn is in flight survives because learn preserves it or fails loudly", async () => {
  const api = await startApi(0, { gated: true });
  const dir = sandbox(api.origin);
  try {
    assert.equal((await run(dir, CLI, ["init"])).code, 0);
    const learning = run(dir, CLI, ["learn"]);
    await api.seen;
    const noted = await run(dir, CLI, ["note", "GET /items", "concurrent operator note"]);
    assert.equal(noted.code, 0, noted.out);
    api.release();
    const learned = await learning;
    const entry = contextAt(dir).operations["GET /items/"];
    assert.ok(entry.notes?.includes("concurrent operator note"),
      "the stale learn must never erase the concurrent note");
    assert.notEqual(learned.code, 0, "the snapshot-guarded learn refuses its stale deposit");
    assert.match(learned.out, /CONTEXT_WRITE_CONFLICT/);
    assert.doesNotMatch(learned.out, /node:internal|triggerUncaughtException|\n\s+at /,
      "a normal concurrency conflict is a named remediation, not a stack trace");
  } finally {
    api.release();
    await api.close();
  }
});
