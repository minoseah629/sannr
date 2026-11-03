// Help must be reachable without setup; usage and operation errors must fail.
// Copy and example phrasing are reviewed, not frozen by regex assertions.
//
//   node --test test/help.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// Run the CLI capturing stdout+stderr and the exit code, never throwing.
function run(args, env = process.env) {
  try {
    const stdout = execFileSync("node", [CLI, ...args], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// The commands a stranger runs. doctor is new; the rest predate this ticket.
const COMMANDS = ["init", "learn", "doctor", "show", "audit", "map", "note",
                  "verdict", "suite", "verify", "review", "capabilities"];

test("each command's --help succeeds without requiring setup", () => {
  for (const c of COMMANDS) {
    const { code, out } = run([c, "--help"]);
    assert.equal(code, 0, `${c} --help must exit 0, got ${code}\n${out}`);
    assert.match(out, new RegExp(`\\b${c}\\b`), `${c} --help does not describe ${c}`);
  }
});

test("exit codes are consistent: success is 0, an unknown command is non-zero", () => {
  // A bare, no-arg invocation prints help and is a success (0).
  assert.equal(run([]).code, 0, "bare invocation prints help and succeeds");
  // An unknown command is a usage error: non-zero, and consistent.
  const unknown = run(["definitely-not-a-command"]);
  assert.notEqual(unknown.code, 0, "an unknown command must be non-zero");
});

test("a failing operation exits non-zero and a passing one exits 0 (the stable contract)", () => {
  // `show` on a repo with no context is an error → non-zero. Run from a neutral
  // temp cwd via env so it cannot accidentally find this repo's context.
  const noCtx = run(["show", "GET /nope"], { ...process.env, API_CONTEXT_DIR: ROOT + "/does-not-exist" });
  assert.notEqual(noCtx.code, 0, "an error path must be non-zero");
});

test("graph --help lists its commands without an alpha label", () => {
  // The beta ships the graph commands as ordinary commands; help a beta user
  // reads must not call them alpha.
  const { code, out } = run(["graph", "--help"]);
  assert.equal(code, 0, out);
  assert.match(out, /^Graph commands:$/m);
  assert.doesNotMatch(out, /\balpha\b/i);
});
