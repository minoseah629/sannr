import { createFixtureStack, fixtureContextFile } from "./helpers/stack-fixture.mjs";
// `sannr note` writes into a committed file, so both of its arguments are
// a path for a secret to reach git.
//
//   node --test test/note.test.mjs
//
// Red-team finding, 2026-08-14: the guard scanned only the note text, leaving
// the operation argument as an unguarded second door. `note "<url-with-token>"
// "..."` wrote a live token into sannr.json, confirmed in git history.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync,  readFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(dirname(fileURLToPath(import.meta.url))), "bin", "cli.mjs");

function repoWithContext() {
  const dir = mkdtempSync(join(tmpdir(), "note-test-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  createFixtureStack(dir);
  writeFileSync(fixtureContextFile(dir),
    JSON.stringify({ version: 0, api: { name: "t" }, operations: {} }));
  return dir;
}

// Returns { code, out } for a note invocation. Never throws on non-zero exit.
function note(dir, op, text) {
  try {
    const out = execFileSync("node", [CLI, "note", op, text], { cwd: dir, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const SECRET = "xoxb-9999-REALSECRETVALUE";

test("a secret in the note TEXT is refused", () => {
  const dir = repoWithContext();
  const r = note(dir, "POST /webhooks", `authenticate with ${SECRET}`);
  assert.equal(r.code, 2);
  assert.match(r.out, /SECRET_IN_NOTE/);
  assert.ok(!readFileSync(fixtureContextFile(dir), "utf8").includes(SECRET));
});

test("a secret in the OPERATION argument is refused", () => {
  // The bypass: paste an endpoint URL carrying a token as the operation.
  const dir = repoWithContext();
  const r = note(dir, `https://api.example.com/hooks?access_token=${SECRET}`, "see the webhook");
  assert.equal(r.code, 2, "the op argument must be scanned too, or it is a second door into git");
  assert.match(r.out, /SECRET_IN_NOTE/);
  assert.ok(!readFileSync(fixtureContextFile(dir), "utf8").includes(SECRET),
    "the token must not reach the committed file through the op position");
});

test("an ordinary operation and note still write", () => {
  const dir = repoWithContext();
  const r = note(dir, "POST /pieces/{id}/transition", "states are strictly sequential; jumping returns 422");
  assert.equal(r.code, 0);
  const ctx = JSON.parse(readFileSync(fixtureContextFile(dir), "utf8"));
  assert.match(ctx.operations["POST /pieces/{id}/transition"].notes[0], /strictly sequential/);
});
