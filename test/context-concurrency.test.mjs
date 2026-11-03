import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,

} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import * as context from "../lib/context.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worker = join(here, "fixtures", "context-concurrency-worker.mjs");
const activeChildren = new Set();

test.afterEach(async () => {
  const children = [...activeChildren];
  for (const child of activeChildren) {
    child.testCleanup = true;
    child.kill("SIGTERM");
  }
  await Promise.all(children.map((child) => child.testDone.catch(() => {})));
  activeChildren.clear();
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(path, children = [], timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    const exited = children.find((state) => state.closed || state.spawnError);
    if (exited) {
      // Wait for the stderr pipe to close before formatting the final evidence.
      await exited.done.catch(() => {});
      throw new Error(`worker exited before ${path}: ${exited.diagnostic()}`);
    }
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    await delay(5);
  }
}

function launch(args, { execPath = process.execPath } = {}) {
  const argv = [execPath, worker, ...args];
  const child = spawn(execPath, argv.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
  activeChildren.add(child);
  let stderr = "";
  const state = {
    child, argv, spawnError: null, exitCode: null, signal: null, closed: false,
    get stderr() { return stderr; },
    diagnostic() {
      return `exit code=${state.exitCode}; signal=${state.signal}; stderr=${JSON.stringify(stderr)}; argv=${JSON.stringify(argv)}`
        + (state.spawnError ? `; spawn error=${state.spawnError.code}: ${state.spawnError.message}` : "");
    },
  };
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.once("error", (error) => { state.spawnError = error; });
    child.once("exit", (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
    });
    child.once("close", (code, signal) => {
      state.exitCode = code;
      state.signal = signal;
      state.closed = true;
      activeChildren.delete(child);
      return (code === 0 && !state.spawnError) || child.testCleanup
        ? resolve()
        : reject(new Error(`worker failed: ${state.diagnostic()}`));
    });
  });
  // Barrier polling may observe failure before callers reach their final await.
  void done.catch(() => {});
  state.done = child.testDone = done;
  return state;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sannr-context-cas-"));
  const barrier = mkdtempSync(join(tmpdir(), "sannr-context-barrier-"));
  const ctx = {
    version: 0,
    api: { name: "test", contract_digest: "contract-v1", extra: { keep: true } },
    unrelated: { nested: ["must", "survive"] },
    operations: {
      "GET /alpha": { notes: [], fields: { keepAlpha: true }, status_codes: [200] },
      "GET /beta": { notes: [], fields: { keepBeta: true }, status_codes: [201] },
    },
  };
  context.saveContext(dir, ctx);
  return { dir, barrier, ctx };
}

function readResult(barrier, id) {
  return JSON.parse(readFileSync(join(barrier, `${id}.result`), "utf8"));
}

async function startNotePair(targetA, targetB) {
  const state = fixture();
  const first = launch(["note", state.dir, state.barrier, "1", targetA, "first private observation"]);
  const second = launch(["note", state.dir, state.barrier, "2", targetB, "second private observation"]);
  await Promise.all([
    waitFor(join(state.barrier, "1.ready"), [first, second]),
    waitFor(join(state.barrier, "2.ready"), [first, second]),
  ]);
  writeFileSync(join(state.barrier, "1.go"), "go\n");
  await waitFor(join(state.barrier, "1.result"), [first]);
  await first.done;
  writeFileSync(join(state.barrier, "2.go"), "go\n");
  await waitFor(join(state.barrier, "2.result"), [second]);
  await second.done;
  return state;
}

// Keep spawning scenarios serial even when the runner enables test concurrency.
describe("serialized context workers", { concurrency: false }, () => {
test("a worker exiting before output reports its exit code, signal, stderr, and argv", async () => {
  const { dir, barrier } = fixture();
  const early = launch(["reader", dir, barrier, "early", "--exit-early=23"]);
  const done = early.done.catch(() => {});
  try {
    await assert.rejects(waitFor(join(barrier, "early.ready"), [early]), (error) => {
      assert.match(error.message, /exit code=23/);
      assert.match(error.message, /signal=null/);
      assert.match(error.message, /stderr=""/);
      assert.ok(error.message.includes(JSON.stringify([process.execPath, worker,
        "reader", dir, barrier, "early", "--exit-early=23"])));
      return true;
    });
  } finally {
    await done;
  }
});

test("a worker spawn error reports its cause and argv before waiting for output", async () => {
  const { barrier } = fixture();
  const execPath = join(barrier, "missing-node");
  const missing = launch(["--exit-early=23"], { execPath });
  const done = missing.done.catch(() => {});
  try {
    await assert.rejects(waitFor(join(barrier, "missing.ready"), [missing]), (error) => {
      assert.match(error.message, /spawn error=ENOENT/);
      assert.match(error.message, /exit code=/);
      assert.match(error.message, /signal=null/);
      assert.match(error.message, /stderr=""/);
      assert.ok(error.message.includes(JSON.stringify([execPath, worker, "--exit-early=23"])));
      return true;
    });
  } finally {
    await done;
  }
});

test("concurrent note writers on different operations rebase once and preserve unrelated state", async () => {
  const { dir, barrier, ctx: original } = await startNotePair("GET /alpha", "GET /beta");
  const saved = context.loadContext(dir);
  assert.deepEqual(saved.operations["GET /alpha"].notes, ["first private observation"]);
  assert.deepEqual(saved.operations["GET /beta"].notes, ["second private observation"]);
  assert.deepEqual(saved.unrelated, original.unrelated);
  assert.deepEqual(saved.api, original.api);
  assert.deepEqual(saved.operations["GET /alpha"].fields, original.operations["GET /alpha"].fields);
  assert.deepEqual(saved.operations["GET /beta"].fields, original.operations["GET /beta"].fields);
  assert.equal(readResult(barrier, "1").ok, true);
  assert.equal(readResult(barrier, "2").ok, true);
});

test("concurrent note writers on one operation fail loudly with opaque versions", async () => {
  const { dir, barrier } = await startNotePair("GET /alpha", "GET /alpha");
  assert.equal(readResult(barrier, "1").ok, true);
  const conflict = readResult(barrier, "2");
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, "CONTEXT_NOTE_CONFLICT");
  assert.equal(conflict.operation, "GET /alpha");
  assert.match(conflict.expectedVersion, /^sha256:[a-f0-9]{16}$/);
  assert.match(conflict.actualVersion, /^sha256:[a-f0-9]{16}$/);
  assert.notEqual(conflict.expectedVersion, conflict.actualVersion);
  assert.match(conflict.message, new RegExp(conflict.expectedVersion));
  assert.match(conflict.message, new RegExp(conflict.actualVersion));
  assert.doesNotMatch(JSON.stringify(conflict), /first private observation|second private observation/);
  assert.deepEqual(context.loadContext(dir).operations["GET /alpha"].notes,
    ["first private observation"], "the refused writer never clobbers the winner");
});

test("atomic save exposes only complete old/new JSON, preserves mode, and cleans unique opaque temps", async () => {
  const { dir, barrier } = fixture();
  const contextPath = join(dir, context.CONTEXT_FILE);
  writeFileSync(contextPath, `${JSON.stringify({ marker: "old", operations: {} }, null, 2)}\n`);
  chmodSync(contextPath, 0o640);

  const reader = launch(["reader", dir, barrier, "reader"]);
  await waitFor(join(barrier, "reader.ready"), [reader]);
  const writer = launch(["atomic", dir, barrier, "writer"]);
  await waitFor(join(barrier, "writer.prepared"), [writer]);
  const prepared = JSON.parse(readFileSync(join(barrier, "writer.prepared"), "utf8"));
  assert.match(prepared.tempName, new RegExp(`^${basename(context.CONTEXT_FILE).replace(".", "\\.")}\\.tmp-`));
  assert.doesNotMatch(prepared.tempName, /sensitive|payload|value/);
  writeFileSync(join(barrier, "writer.rename"), "rename\n");
  // The writer may finish successfully before the reader observes the rename.
  // Only the reader produces this barrier; a failed writer still rejects promptly.
  await Promise.all([waitFor(join(barrier, "reader.new"), [reader]), writer.done]);
  writeFileSync(join(barrier, "reader.stop"), "stop\n");
  await reader.done;

  const observed = readResult(barrier, "reader");
  assert.deepEqual(observed.invalid, []);
  assert.ok(observed.observed.includes("old"));
  assert.ok(observed.observed.includes("new"));
  assert.equal(readResult(barrier, "writer").hookCalled, true);
  assert.equal(statSync(contextPath).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(dirname(contextPath)).filter((name) => name.includes(".tmp-") || name.endsWith(".lock")), []);

  const names = [];
  context.saveContext(dir, { marker: "third", operations: {} }, {
    beforeRename({ tempName }) { names.push(tempName); },
  });
  context.saveContext(dir, { marker: "fourth", operations: {} }, {
    beforeRename({ tempName }) { names.push(tempName); },
  });
  assert.equal(names.length, 2);
  assert.notEqual(names[0], names[1]);
  assert.deepEqual(readdirSync(dirname(contextPath)).filter((name) => name.includes(".tmp-") || name.endsWith(".lock")), []);
});
});

test("a conflict injected after the one reapply fails without a third attempt", () => {
  assert.equal(typeof context.loadContextSnapshot, "function");
  assert.equal(typeof context.saveContextNote, "function");
  const { dir } = fixture();
  const snapshot = context.loadContextSnapshot(dir);
  const latest = structuredClone(snapshot.ctx);
  latest.operations["GET /beta"].status_codes.push(202);
  context.saveContext(dir, latest);

  let retries = 0;
  let conflict;
  try {
    context.saveContextNote(dir, snapshot, {
      operation: "GET /alpha",
      note: "proposed note must not land",
      stamp: { by: "retry-test", at: "2026-08-26T00:00:00.000Z" },
    }, {
      afterReapply() {
        retries += 1;
        const raced = context.loadContext(dir);
        raced.operations["GET /alpha"].notes.push("other writer won");
        writeFileSync(join(dir, context.CONTEXT_FILE), `${JSON.stringify(raced, null, 2)}\n`);
      },
    });
  } catch (error) {
    conflict = error;
  }

  assert.equal(retries, 1);
  assert.equal(conflict?.code, "CONTEXT_WRITE_CONFLICT");
  assert.equal(conflict?.operation, "GET /alpha");
  assert.equal(conflict?.attempts, 2);
  assert.match(conflict?.expectedVersion, /^sha256:[a-f0-9]{16}$/);
  assert.match(conflict?.actualVersion, /^sha256:[a-f0-9]{16}$/);
  assert.match(conflict?.message, new RegExp(conflict.expectedVersion));
  assert.match(conflict?.message, new RegExp(conflict.actualVersion));
  assert.doesNotMatch(conflict?.message, /proposed note|other writer won/);
  const final = context.loadContext(dir);
  assert.deepEqual(final.operations["GET /alpha"].notes, ["other writer won"]);
});
