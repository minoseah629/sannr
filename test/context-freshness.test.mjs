import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
// Per-request freshness: the client answers from the knowledge file and the
// contract AS THEY ARE NOW, not as they were when its process started.
//
// The CLI never showed this, because every invocation is a new process. The MCP
// server is long-lived and parsed the knowledge file once, so a note written
// mid-session reached every later session and never the one that wrote it; and
// confidence was graded against the digest stored by the last learn, so an
// edited contract still read "verified" from the client while `show`, `audit`
// and `view` — which hash the file on disk — already called the same claim
// suspect. Two surfaces disagreeing about one claim is the failure this
// product exists to prevent, which is why the `show` control below is part of
// the test and not a nicety.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, unlinkSync, writeFileSync as writeRaw } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CONTEXT_FILE, contextReader, contractDigestReader, emptyContext, liveContractDigest,
  loadContextSnapshot, saveContext, saveContextNote, acceptNoteHistory, inspectNoteHistory,
} from "../lib/context.mjs";
import { TOOL_NAME } from "../lib/brand.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OP = "GET /things";

const CONTRACT = {
  openapi: "3.0.0",
  info: { title: "fresh", version: "1" },
  paths: {
    "/things": {
      get: {
        operationId: "listThings",
        responses: {
          200: {
            description: "ok",
            content: { "application/json": { schema: { type: "object", properties: { count: { type: "integer" } } } } },
          },
        },
      },
    },
  },
};

/** An entry shaped like one a learn would leave behind. */
const entryFor = (digest, notes) => ({
  source_file: null,
  verified_at: digest ? new Date().toISOString() : null,
  contract_digest: digest ?? null,
  shape_hash: null,
  status_codes: [200],
  effect: "read",
  fields: {},
  notes,
});

function writeContext(dir, { verified = true, notes = ["first note: date_max is optional"] } = {}) {
  const digest = liveContractDigest(dir, { api: { contract: "openapi.json" } });
  const ctx = emptyContext({ name: "fresh", contractPath: "openapi.json", contractDigest: digest });
  ctx.operations[OP] = entryFor(verified ? digest : null, notes);
  saveContext(dir, ctx);
  // This fixture deliberately starts with legacy prose. Review its baseline
  // before exercising later note writes; freshness is the behavior under test.
  const snapshot = loadContextSnapshot(dir);
  return acceptNoteHistory(dir, snapshot, { operation: OP,
    expectedDigest: inspectNoteHistory(snapshot.ctx.operations[OP]).digest,
    stamp: { by: "freshness-fixture", at: "2026-09-30" } }).ctx;
}

function project({ withContext = true, verified = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "freshness-"));
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(join(dir, "openapi.json"), JSON.stringify(CONTRACT, null, 1));
  if (withContext) writeContext(dir, { verified });
  return dir;
}

// No API_ or SANNR_ variable leaks in from the developer's shell.
function isolatedEnv(dir, overrides = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(API|SANNR)_/.test(k)) env[k] = v;
  return {
    ...env,
    HOME: join(dir, "home"),
    API_CONTEXT_DIR: dir,
    API_USAGE_LOG: "/dev/null",
    API_EVIDENCE: join(dir, "evidence"),
    ...overrides,
  };
}

// One child process per scenario, because the client resolves its context root
// and the API_CONTEXT_OFF switch at module load: a second scenario in the same
// process would inherit the first one's module, which is the very caching this
// file is about. The child runs its own HTTP origin, so nothing here blocks the
// event loop while a request is in flight.
//
// It also counts, by path, every statSync and readFileSync the run performs.
// The shim is installed through createRequire BEFORE any ESM module imports
// node:fs, so the live binding lib/context.mjs holds is the wrapped one — which
// is why this script requires fs instead of importing it. That counter is how
// "API_CONTEXT_OFF=1 reads neither file" is proved: every read failure inside
// loadContextSnapshot is swallowed by design, so no outcome distinguishes "read
// and discarded" from "never read" — only the call itself does.
const SCENARIO = `
import { createRequire } from "node:module";
const [ROOT, DIR, STEPS] = process.argv.slice(1);
const require = createRequire(\`\${ROOT}/package.json\`);
const fs = require("node:fs");
const http = require("node:http");
const { join } = require("node:path");
const calls = { stat: {}, read: {} };
const count = (bucket, p) => { const k = String(p); bucket[k] = (bucket[k] ?? 0) + 1; };
const realStat = fs.statSync, realRead = fs.readFileSync;
fs.statSync = function (p, ...rest) { count(calls.stat, p); return realStat.call(this, p, ...rest); };
fs.readFileSync = function (p, ...rest) { count(calls.read, p); return realRead.call(this, p, ...rest); };

process.chdir(DIR);
const ctxlib = await import(\`\${ROOT}/lib/context.mjs\`);
let requests = 0;
const srv = http.createServer((q, s) => { requests += 1; s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ count: 1 })); });
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
process.env.API_BASE_URL = \`http://127.0.0.1:\${srv.address().port}\`;
const { apiRequest } = await import(\`\${ROOT}/lib/client.mjs\`);
const out = [];
process.stderr.write("SCENARIO_READY\\n");
for (const step of JSON.parse(STEPS)) {
  if (step.kind === "call") {
    // A throw is recorded rather than allowed to kill the child: "the request
    // still answered" is half of what several of these tests assert.
    try {
      const r = await apiRequest({ method: "GET", path: "/things" });
      out.push({ known: r.known ?? null, status: r.status ?? null, threw: null, requests });
    } catch (error) {
      out.push({ known: null, status: null, threw: String(error?.message ?? error), requests });
    }
  } else if (step.kind === "note") {
    ctxlib.saveContextNote(DIR, ctxlib.loadContextSnapshot(DIR),
      { operation: "GET /things", note: step.note, stamp: ctxlib.provenanceStamp(DIR), relation: { alongside: true } });
  } else if (step.kind === "editContract") {
    const spec = JSON.parse(realRead(join(DIR, "openapi.json"), "utf8"));
    spec.paths["/things"].get.responses[200].content["application/json"].schema.properties.total = { type: "integer" };
    fs.writeFileSync(join(DIR, "openapi.json"), JSON.stringify(spec, null, 1));
  } else if (step.kind === "removeContext") {
    fs.unlinkSync(join(DIR, ctxlib.CONTEXT_FILE));
  } else if (step.kind === "createContext") {
    const digest = ctxlib.liveContractDigest(DIR, { api: { contract: "openapi.json" } });
    const ctx = ctxlib.emptyContext({ name: "fresh", contractPath: "openapi.json", contractDigest: digest });
    ctx.operations["GET /things"] = { source_file: null, verified_at: null, contract_digest: null,
      shape_hash: null, status_codes: [200], effect: "read", fields: {}, notes: [step.note] };
    ctxlib.saveContext(DIR, ctx);
  } else if (step.kind === "writeRawContext") {
    // Deliberately not through saveContext: the point is a file the product
    // would never write, arriving mid-session.
    fs.writeFileSync(join(DIR, ctxlib.CONTEXT_FILE), step.bytes);
  } else if (step.kind === "fifoAt") {
    const target = join(DIR, step.path === "context" ? ctxlib.CONTEXT_FILE : "openapi.json");
    try { fs.unlinkSync(target); } catch { /* may not exist */ }
    require("node:child_process").execFileSync("mkfifo", [target]);
  }
}
srv.close();
const total = (bucket, suffix) => Object.entries(bucket)
  .filter(([k]) => k.endsWith(suffix)).reduce((n, [, v]) => n + v, 0);
console.log(JSON.stringify({ steps: out, calls: {
  contextStat: total(calls.stat, ctxlib.CONTEXT_FILE), contextRead: total(calls.read, ctxlib.CONTEXT_FILE),
  contractStat: total(calls.stat, "/openapi.json"), contractRead: total(calls.read, "/openapi.json"),
} }));
`;

function runScenario(dir, steps, { env = {}, timeoutMs = 30_000, afterReadyMs = null } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath,
      ["--input-type=module", "-e", SCENARIO, ROOT, dir, JSON.stringify(steps)],
      { cwd: dir, env: isolatedEnv(dir, env), stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "", settled = false, armed = false;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); child.kill("SIGKILL"); resolve(value); };
    let timer = setTimeout(() => finish({ timedOut: true, stderr: err }), timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => {
      err += d;
      if (afterReadyMs && !armed && err.includes("SCENARIO_READY")) {
        armed = true;
        clearTimeout(timer);
        timer = setTimeout(() => finish({ timedOut: true, stderr: err }), afterReadyMs);
      }
    });
    child.on("close", (code) => {
      let parsed = null;
      try { parsed = JSON.parse(out.trim().split("\n").pop()); } catch { /* reported below */ }
      finish({ timedOut: false, code, steps: parsed?.steps ?? null, calls: parsed?.calls ?? null,
        stdout: out, stderr: err });
    });
  });
}

const stepAt = (result, i) => {
  assert.equal(result.timedOut, false, `scenario timed out; stderr: ${result.stderr}`);
  assert.equal(result.code, 0, `scenario exited ${result.code}; stderr: ${result.stderr}`);
  assert.ok(result.steps, `scenario produced no parseable output:\n${result.stdout}\n${result.stderr}`);
  const step = result.steps[i];
  assert.ok(step, `no call ${i + 1} in the scenario output`);
  assert.equal(step.threw, null, `call ${i + 1} threw out of apiRequest: ${step.threw}`);
  return step;
};
const knownAt = (result, i) => stepAt(result, i).known ?? null;

// (a) --------------------------------------------------------------------
test("a note written mid-process is delivered by the next request of the same process", async () => {
  const dir = project();
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "note", note: "second note: page starts at 1" },
    { kind: "call" },
  ]);
  assert.deepEqual(knownAt(result, 0).notes, ["first note: date_max is optional"]);
  assert.deepEqual(knownAt(result, 1).notes,
    // Both are written claims; CONTEXT-2c ranks the newer authored claim
    // before the older unattributed prose without losing either lesson.
    ["second note: page starts at 1", "first note: date_max is optional"],
    "the second request still carried the knowledge file as it stood at startup");
});

// (b) --------------------------------------------------------------------
test("an edited contract flips confidence in the same process, and the CLI agrees", async () => {
  const dir = project();
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "editContract" },
    { kind: "call" },
  ]);
  assert.equal(knownAt(result, 0).confidence, "verified");
  assert.equal(knownAt(result, 1).confidence, "suspect",
    "the client graded against the digest stored at the last learn, not the contract on disk");

  // The fresh-process control. `show` hashes the contract file; before this fix
  // it said suspect while the client said verified for the same claim.
  const shown = JSON.parse(execFileSync(process.execPath, [join(ROOT, "bin/cli.mjs"), "show", OP],
    { cwd: dir, env: isolatedEnv(dir), encoding: "utf8" }));
  assert.equal(shown.confidence, knownAt(result, 1).confidence,
    "the client and the CLI disagree about the same claim");
  assert.ok(shown.why.some((reason) => /contract/i.test(reason)),
    `no reason named the contract: ${JSON.stringify(shown.why)}`);
});

// (c) --------------------------------------------------------------------
test("a knowledge file removed mid-process stops being delivered", async () => {
  const dir = project();
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "removeContext" },
    { kind: "call" },
  ]);
  assert.ok(knownAt(result, 0), "the first call should carry the file that was there");
  assert.equal(knownAt(result, 1), null, "a deleted knowledge file was still being delivered");
});

test("a knowledge file that appears mid-process is delivered from the next request", async () => {
  const dir = project({ withContext: false });
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "createContext", note: "a fact learned by this very session" },
    { kind: "call" },
  ]);
  assert.equal(knownAt(result, 0), null, "there was nothing on disk to deliver yet");
  assert.deepEqual(knownAt(result, 1)?.notes, ["a fact learned by this very session"],
    "a process that started without a knowledge file never picked one up");
});

// (d) --------------------------------------------------------------------
test("API_CONTEXT_OFF delivers nothing however the knowledge file changes", async () => {
  const dir = project();
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "note", note: "second note: page starts at 1" },
    { kind: "call" },
    { kind: "removeContext" },
    { kind: "call" },
    { kind: "createContext", note: "written while context was off" },
    { kind: "call" },
  ], { env: { API_CONTEXT_OFF: "1" } });
  for (const i of [0, 1, 2, 3]) assert.equal(knownAt(result, i), null,
    `off must mean off: the control arm of a measurement cannot keep half the treatment (call ${i + 1})`);
});

test("API_CONTEXT_OFF stats and reads neither file", async () => {
  // Every read failure inside loadContextSnapshot is swallowed by design, so no
  // OUTCOME can tell "read and discarded" from "never read" — only the call
  // itself can. The child counts statSync and readFileSync by path (see
  // SCENARIO), which is deterministic and, unlike a read that blocks, cannot
  // wedge the suite.
  const dir = project();
  const off = await runScenario(dir, [{ kind: "call" }], { env: { API_CONTEXT_OFF: "1" } });
  assert.equal(knownAt(off, 0), null);
  assert.deepEqual(off.calls, { contextStat: 0, contextRead: 0, contractStat: 0, contractRead: 0 },
    "off must mean off: neither file may be touched when context is disabled");

  // The control, without which the zero above is not evidence: the same counter
  // on the same project, with context on, is not zero.
  const on = await runScenario(dir, [{ kind: "call" }]);
  assert.ok(knownAt(on, 0), "the control delivered nothing, so its counts say nothing");
  assert.ok(on.calls.contextStat > 0 && on.calls.contextRead > 0,
    `the counter never observed the knowledge file being read: ${JSON.stringify(on.calls)}`);
  assert.ok(on.calls.contractStat > 0 && on.calls.contractRead > 0,
    `the counter never observed the contract being read: ${JSON.stringify(on.calls)}`);
});

test("a knowledge file that is valid JSON but not a usable context is refused, not thrown", async () => {
  // contextFor used to reach straight for ctx.operations. Reading the file per
  // request is what makes these shapes arrive mid-session — a truncated write, a
  // hand edit — and enrichment must never break the request it decorates.
  const shapes = {
    "no operations key": '{"v":0,"api":{}}',
    "operations is null": '{"v":0,"api":{},"operations":null}',
    "operations is a string": '{"v":0,"api":{},"operations":"none"}',
    "operations is an array": '{"v":0,"api":{},"operations":[]}',
    "the document is an array": "[1,2,3]",
    "the document is a number": "42",
    "the document is null": "null",
    "truncated json": '{"v":0,"operations":{"GET /things":',
  };
  const dir = project();
  const steps = [{ kind: "call" }];
  for (const bytes of Object.values(shapes)) {
    steps.push({ kind: "writeRawContext", bytes }, { kind: "call" });
  }
  const result = await runScenario(dir, steps);

  assert.ok(knownAt(result, 0), "the good file that opened the run should have been delivered");
  Object.keys(shapes).forEach((label, i) => {
    const step = stepAt(result, i + 1);          // stepAt asserts nothing was thrown
    assert.equal(step.status, 200, `${label}: the request itself must still answer`);
    assert.equal(step.known, null, `${label}: an unusable context must deliver nothing`);
  });
});

for (const [label, contract] of [
  ["number", 123], ["object", {}], ["array", ["openapi.json"]],
  ["true", true], ["false", false],
]) test(`a contract path of type ${label} cannot stop HTTP, and the same client recovers`, async () => {
  const dir = project();
  const ctx = loadContextSnapshot(dir).ctx;
  const alternate = structuredClone(CONTRACT);
  alternate.paths["/things"].get.responses[200].content["application/json"].schema.properties.total = { type: "integer" };
  writeRaw(join(dir, "alternate.json"), JSON.stringify(alternate));
  const contextWith = (path) => JSON.stringify({ ...ctx, api: { ...ctx.api, contract: path } });
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "writeRawContext", bytes: contextWith(contract) },
    { kind: "call" },
    { kind: "writeRawContext", bytes: contextWith("alternate.json") },
    { kind: "call" },
    { kind: "writeRawContext", bytes: contextWith("openapi.json") },
    { kind: "call" },
    { kind: "call" },
  ]);

  for (let i = 0; i < 5; i += 1) {
    const step = stepAt(result, i);
    assert.equal(step.status, 200, `call ${i + 1}: context enrichment must not replace HTTP with an error`);
    assert.equal(step.requests, i + 1, `call ${i + 1}: the fixture must actually receive every request`);
  }
  assert.equal(knownAt(result, 0).confidence, "verified");
  assert.equal(knownAt(result, 1).confidence, "verified",
    "a malformed contract path uses the stored digest, like an unreadable contract");
  assert.equal(knownAt(result, 2).confidence, "suspect",
    "a valid replacement path must be read by the existing client");
  assert.equal(knownAt(result, 3).confidence, "verified",
    "restoring the original path must recover the original confidence");
  assert.equal(knownAt(result, 4).confidence, "verified");
  assert.equal(result.calls.contractRead, 2,
    "the original contract is read once before the path changes and once after recovery, then cached");
});

// A non-regular file at either path used to be read anyway. readFileSync on a
// FIFO blocks the event loop until someone opens the other end, so a named pipe
// left where the knowledge file or the contract belongs wedged the whole
// process — permanently, for a long-lived MCP server. fileIdentity now refuses
// anything that is not a regular file, and both readers treat that as absent.
// Every assertion below is bounded by afterReadyMs: a regression blocks, the
// timer fires, and the test fails in seconds instead of hanging the suite.
const fifoTest = (t, dir) => {
  try { execFileSync("mkfifo", [join(dir, "does-this-host-have-mkfifo")]); return true; }
  catch { t.skip("mkfifo is unavailable on this host"); return false; }
};

test("a FIFO where the knowledge file belongs does not block the request", async (t) => {
  const dir = project();
  if (!fifoTest(t, dir)) return;
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "fifoAt", path: "context" },
    { kind: "call" },
  ], { afterReadyMs: 10_000 });
  assert.equal(result.timedOut, false, "the client opened a FIFO and wedged the process");
  assert.ok(knownAt(result, 0), "the first call, with a real file, should deliver");
  assert.equal(knownAt(result, 1), null, "a knowledge file that is not a file delivers nothing");
  assert.equal(stepAt(result, 1).status, 200, "and the request it decorates still answers");
  assert.equal(result.calls.contextRead, 1, "the FIFO must be refused unopened, so only the real file was read");
});

test("a FIFO where the contract belongs falls back to the stored digest", async (t) => {
  // This path is new in this slice: before it, the client never opened the
  // contract file at all.
  const dir = project();
  if (!fifoTest(t, dir)) return;
  const result = await runScenario(dir, [
    { kind: "call" },
    { kind: "fifoAt", path: "contract" },
    { kind: "call" },
  ], { afterReadyMs: 10_000 });
  assert.equal(result.timedOut, false, "the client opened a FIFO and wedged the process");
  assert.equal(knownAt(result, 0).confidence, "verified");
  assert.equal(stepAt(result, 1).status, 200, "the request still answers");
  assert.equal(knownAt(result, 1).confidence, "verified",
    "an unreadable contract falls back to the stored digest, exactly as liveContractDigest does");
  assert.equal(result.calls.contractRead, 1, "the FIFO must be refused unopened");
});

// (e) --------------------------------------------------------------------
test("the reader parses only when the knowledge file actually changed", () => {
  const dir = project();
  const reader = contextReader(dir);
  for (let i = 0; i < 50; i += 1) assert.ok(reader.current().ctx.operations[OP]);
  assert.equal(reader.loads, 1, "the knowledge file was re-parsed on an unchanged request");

  const snapshot = loadContextSnapshot(dir);
  saveContextNote(dir, snapshot, { operation: OP, note: "a second note",
    stamp: { by: "freshness-fixture", at: "2026-09-30" }, relation: { alongside: true } });
  assert.deepEqual(reader.current().ctx.operations[OP].notes,
    ["first note: date_max is optional", "a second note"]);
  assert.equal(reader.loads, 2, "one change should cost exactly one parse");
  reader.current();
  assert.equal(reader.loads, 2);
});

test("the reader reports a missing or malformed knowledge file as null, and recovers", () => {
  const dir = project({ withContext: false });
  const reader = contextReader(dir);
  assert.equal(reader.current(), null);
  assert.equal(reader.loads, 0, "an absent file costs no parse");

  writeContext(dir);
  assert.ok(reader.current()?.ctx, "a file that appeared later was never picked up");
  assert.equal(reader.loads, 1);

  writeRaw(join(dir, CONTEXT_FILE), "{ this is not json");
  assert.equal(reader.current(), null, "a malformed file must read as null, like loadContext");
  assert.equal(reader.current(), null, "and must not be re-parsed until it changes");
  assert.equal(reader.loads, 2);

  writeContext(dir);
  assert.ok(reader.current()?.ctx, "a repaired file was never re-read");
});

test("the contract digest is re-hashed only when the contract file changed", () => {
  const dir = project();
  const ctx = loadContextSnapshot(dir).ctx;
  const reader = contractDigestReader(dir);
  const first = reader.current(ctx);
  assert.equal(first, liveContractDigest(dir, ctx), "the reader must answer exactly as liveContractDigest does");
  for (let i = 0; i < 20; i += 1) assert.equal(reader.current(ctx), first);
  assert.equal(reader.hashes, 1, "an unchanged contract was hashed more than once");

  const edited = structuredClone(CONTRACT);
  edited.paths["/things"].get.responses[200].content["application/json"].schema.properties.total = { type: "integer" };
  writeRaw(join(dir, "openapi.json"), JSON.stringify(edited, null, 1));
  const second = reader.current(ctx);
  assert.notEqual(second, first, "an edited contract must produce a new digest");
  assert.equal(second, liveContractDigest(dir, ctx));
  assert.equal(reader.hashes, 2);
});

test("an unreadable or undeclared contract falls back to the stored digest", () => {
  const dir = project();
  const ctx = loadContextSnapshot(dir).ctx;
  const stored = ctx.api.contract_digest;
  unlinkSync(join(dir, "openapi.json"));
  const reader = contractDigestReader(dir);
  assert.equal(reader.current(ctx), stored,
    "a deleted contract is its own problem; it must not flip every operation suspect");
  assert.equal(reader.hashes, 0);
  assert.equal(reader.current({ api: { contract: null, contract_digest: stored } }), stored);
  assert.equal(reader.current(null), null);
});

// (f) --------------------------------------------------------------------
test("the long-lived MCP server delivers a note written between two of its calls", async () => {
  // The surface the defect is about: one server process, two tool calls, a note
  // written on disk in between.
  const dir = project();
  const origin = createServer((q, s) => {
    s.setHeader("content-type", "application/json");
    s.end(JSON.stringify({ count: 1 }));
  });
  await new Promise((r) => origin.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${origin.address().port}`;
  // A live CLI note uses the current named-stack store. Earlier cases retain
  // saved legacy snapshots to pin their read-only reader/cache semantics.
  const scope = createFixtureStack(dir, { baseUrl: base, contract: 'openapi.json' });
  const seeded = loadContextSnapshot(dir).ctx;
  seeded.api.contract = scope.config.contract;
  writeFileSync(fixtureContextFile(dir), JSON.stringify(seeded));

  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: dir,
    env: isolatedEnv(dir, { API_BASE_URL: base }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const replies = new Map();
  let buffer = "", stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  child.stdout.on("data", (d) => {
    buffer += d;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try { const message = JSON.parse(line); if (message.id !== undefined) replies.set(message.id, message); }
      catch { /* not every line is a reply */ }
    }
  });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const await_ = async (id) => {
    for (let i = 0; i < 300; i += 1) {
      if (replies.has(id)) return replies.get(id);
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`no reply to ${id}; stderr: ${stderr}`);
  };
  const callTool = async (id) => {
    send({ jsonrpc: "2.0", id, method: "tools/call",
      params: { name: TOOL_NAME, arguments: { method: "GET", path: "/things" } } });
    const reply = await await_(id);
    return JSON.parse(reply.result.content[0].text);
  };

  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await await_(1);
    const before = await callTool(2);
    assert.deepEqual(before.known?.notes, ["first note: date_max is optional"]);

    // Written by another process entirely, as a `sannr note` would be.
    execFileSync(process.execPath,
      [join(ROOT, "bin/cli.mjs"), "note", OP, "second note: page starts at 1", "--alongside"],
      { cwd: dir, env: isolatedEnv(dir), encoding: "utf8" });

    const after = await callTool(3);
    assert.deepEqual(after.known?.notes,
      // Equal evidence class uses recency, including an external CLI write.
      ["second note: page starts at 1", "first note: date_max is optional"],
      "a server that outlives the file delivered the knowledge file it started with");
  } finally {
    child.kill("SIGKILL");
    origin.close();
  }
});
