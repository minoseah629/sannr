// Evidence must never become a committed file.
//
//   node --test test/evidence.test.mjs
//
// The promotion boundary was built, tested twenty-one ways, and documented as
// the highest-stakes decision in the project: nothing reaches a committed file
// unless the contract already declared it.
//
// Meanwhile the client was creating an `evidence/` directory inside the user's
// repo containing COMPLETE request and response pairs, every body and every
// header, with no protection whatsoever. One `git add -A` and all of it is in
// history, in every clone and fork, permanently. The boundary was not defeated,
// it was walked around.
//
// The design notes described evidence as "gitignored, contains everything" from
// the first draft. Nothing implemented it, and nobody checked. These tests exist
// so that stays checked.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "evidence-test-"));
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@example.com");
  git(dir, "config", "user.name", "t");
  return dir;
}

// Drive the real adapter, in the repo, exactly as an agent would.
function request(cwd, base, evidenceDir) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [join(ROOT, "server.mjs")], {
      cwd,
      env: { ...process.env, API_BASE_URL: base, API_USAGE_LOG: "/dev/null",
             API_CONTEXT_OFF: "1", API_EVIDENCE: evidenceDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "", done = false;
    const finish = (fn, v) => { if (done) return; done = true; child.kill(); fn(v); };
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (d) => {
      out += d;
      const lines = out.split("\n"); out = lines.pop() ?? "";
      for (const l of lines) {
        try { if (JSON.parse(l).id === 100) finish(resolve, { stderr: err }); } catch { /* not ours */ }
      }
    });
    child.stdin.write(`${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: { path: "/json" } } },
    ].map((m) => JSON.stringify(m)).join("\n")}\n`);
    setTimeout(() => finish(reject, new Error("timed out")), 20_000);
  });
}

test("a request into a git repo leaves evidence invisible to git", async () => {
  const f = await start();
  const dir = repo();
  try {
    await request(dir, f.origin, join(dir, "evidence"));
    assert.ok(existsSync(join(dir, "evidence", ".gitignore")), "evidence must protect itself on creation");
    // The real assertion: git itself, not our belief about git.
    assert.equal(git(dir, "status", "--porcelain").trim(), "",
      "git must see nothing; anything visible here is one `git add -A` from permanent");
  } finally { await f.close(); }
});

test("even a deliberate `git add -A` cannot stage evidence", async () => {
  const f = await start();
  const dir = repo();
  try {
    await request(dir, f.origin, join(dir, "evidence"));
    git(dir, "add", "-A");
    const staged = git(dir, "diff", "--cached", "--name-only").trim();
    assert.ok(!staged.includes("evidence/"),
      `evidence was staged by an ordinary add: ${staged}`);
  } finally { await f.close(); }
});

test("a pre-existing .gitignore does not leave evidence trackable", async () => {
  // Red-team finding: protectEvidence early-returned if a .gitignore already
  // existed. With API_EVIDENCE pointed at a repo root or project subdir that has
  // one, the `*` rule was never added and `git add -A` staged the response
  // bodies. Confirmed by reproduction.
  const f = await start();
  const dir = repo();
  try {
    // A normal ignore file that says nothing about evidence.
    writeFileSync(join(dir, ".gitignore"), "node_modules/\n*.log\n");
    await request(dir, f.origin, dir);          // evidence written INTO the repo root
    git(dir, "add", "-A");
    const staged = git(dir, "diff", "--cached", "--name-only").trim().split("\n");
    assert.ok(!staged.some((p) => /run-.*\.(json|bin)/.test(p)),
      `evidence was staged despite a pre-existing .gitignore: ${staged.join(", ")}`);
    // The user's own rules must be preserved, not clobbered.
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /node_modules/);
  } finally { await f.close(); }
});

test("the marker is not overwritten if a user already wrote their own", async () => {
  const f = await start();
  const dir = repo();
  try {
    mkdirSync(join(dir, "evidence"), { recursive: true });
    writeFileSync(join(dir, "evidence", ".gitignore"), "# mine\n*\n");
    await request(dir, f.origin, join(dir, "evidence"));
    assert.match(readFileSync(join(dir, "evidence", ".gitignore"), "utf8"), /# mine/,
      "a tool that rewrites files the user authored is a tool people stop trusting");
  } finally { await f.close(); }
});

test("evidence already tracked by git is reported, not silently ignored", async () => {
  const f = await start();
  const dir = repo();
  try {
    // The already-leaked case. Adding a .gitignore now fixes nothing: the
    // contents are in history, and only the user can decide what to do.
    mkdirSync(join(dir, "evidence"), { recursive: true });
    writeFileSync(join(dir, "evidence", "run-old.json"), '{"body":{"email":"someone@example.com"}}');
    git(dir, "add", "-f", "evidence/run-old.json");
    git(dir, "commit", "-qm", "committed evidence");

    const { stderr } = await request(dir, f.origin, join(dir, "evidence"));
    assert.match(stderr, /tracked by git/i, "silence here would let the user believe they are protected");
    assert.match(stderr, /already in history/i, "the remedy is not 'we fixed it going forward'");
  } finally { await f.close(); }
});

test("evidence outside a git repo still gets its marker and does not crash", async () => {
  const f = await start();
  const dir = mkdtempSync(join(tmpdir(), "evidence-nogit-"));
  try {
    await request(dir, f.origin, join(dir, "evidence"));
    assert.ok(existsSync(join(dir, "evidence", ".gitignore")),
      "the directory may be committed later by being moved into a repo");
  } finally { await f.close(); }
});
