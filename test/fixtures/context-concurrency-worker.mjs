import {
  existsSync,
  readFileSync,
  writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as context from "../../lib/context.mjs";

const pause = (ms = 5) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function waitFor(path, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
    pause();
  }
}

// A barrier file is read by the parent the moment it exists, so it must never
// be visible half-written: write beside it, then rename into place (atomic on
// the same directory). The parent polls existence every 5 ms; under host load a
// plain write was caught between create and write as "Unexpected end of JSON".
function record(path, value) {
  const temp = `${path}.${process.pid}.partial`;
  writeFileSync(temp, `${JSON.stringify(value)}\n`);
  renameSync(temp, path);
}

const exitEarly = process.argv.slice(2).find((arg) => arg.startsWith("--exit-early="));
if (exitEarly) process.exit(Number(exitEarly.slice("--exit-early=".length)));

const [mode, dir, barrier, id, operation, note] = process.argv.slice(2);

if (mode === "note") {
  const snapshot = typeof context.loadContextSnapshot === "function"
    ? context.loadContextSnapshot(dir)
    : { ctx: context.loadContext(dir), digest: null };
  record(join(barrier, `${id}.ready`), { pid: process.pid });
  waitFor(join(barrier, `${id}.go`));

  try {
    if (typeof context.saveContextNote === "function") {
      const saved = context.saveContextNote(dir, snapshot, {
        operation,
        note,
        stamp: { by: `worker-${id}`, at: `2026-08-26T00:00:0${id}.000Z` },
      });
      record(join(barrier, `${id}.result`), { ok: true, target: saved.target });
    } else {
      const ctx = snapshot.ctx;
      const key = Object.keys(ctx.operations).find((candidate) => candidate === operation)
        ?? Object.keys(ctx.operations).find((candidate) =>
          candidate.replace(/\/+$/, "") === operation.replace(/\/+$/, ""));
      const target = key ?? operation;
      ctx.operations[target] ??= { notes: [] };
      ctx.operations[target].notes ??= [];
      ctx.operations[target].notes.push(note);
      context.saveContext(dir, ctx);
      record(join(barrier, `${id}.result`), { ok: true, target });
    }
  } catch (error) {
    record(join(barrier, `${id}.result`), {
      ok: false,
      code: error.code,
      operation: error.operation,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
      attempts: error.attempts,
      message: error.message,
    });
  }
} else if (mode === "atomic") {
  const next = {
    marker: "new",
    payload: "sensitive-payload-value".repeat(50_000),
    operations: {},
  };
  let hookCalled = false;
  context.saveContext(dir, next, {
    beforeRename({ tempName }) {
      hookCalled = true;
      record(join(barrier, `${id}.prepared`), { tempName });
      waitFor(join(barrier, `${id}.rename`));
    },
  });
  record(join(barrier, `${id}.result`), { ok: true, hookCalled });
} else if (mode === "reader") {
  const contextPath = join(dir, context.CONTEXT_FILE);
  const invalid = [];
  const observed = new Set();
  let ready = false;
  while (!existsSync(join(barrier, `${id}.stop`))) {
    try {
      const parsed = JSON.parse(readFileSync(contextPath, "utf8"));
      observed.add(parsed.marker);
      if (parsed.marker !== "old" && parsed.marker !== "new") invalid.push(`marker:${parsed.marker}`);
      // Release the writer only after an actual old-state observation.
      if (parsed.marker === "old" && !ready) {
        record(join(barrier, `${id}.ready`), { pid: process.pid });
        ready = true;
      }
      if (parsed.marker === "new" && !existsSync(join(barrier, `${id}.new`))) {
        record(join(barrier, `${id}.new`), { observed: true });
      }
    } catch (error) {
      invalid.push(error.name);
    }
    pause(1);
  }
  record(join(barrier, `${id}.result`), { invalid, observed: [...observed] });
} else {
  throw new Error(`unknown worker mode ${mode}`);
}
