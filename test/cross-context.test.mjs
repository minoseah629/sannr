import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
// Cross-repo knowledge in the MCP answer path — global understanding at the
// local level.
//
//   node --test test/cross-context.test.mjs
//
// The registry (test/registry.test.mjs) pinned what a grant MEANS; these tests
// pin what a grant DELIVERS: an agent working in a consumer repo, mid
// api_request call, receives a granted provider's knowledge in the envelope's
// `known` block, labelled with where it came from. The promises here are the
// ones the whole design hangs on, exercised against the REAL stdio server:
//
//   1. fallback only — local knowledge always wins; a provider is consulted
//      solely on a local miss, and the answer carries `from: {repo, root}`
//   2. query time, per request — a grant made or revoked while the server is
//      RUNNING changes the very next call. No restart, no daemon, no cache.
//   3. the provider's history grades the provider's claim — confidence is
//      computed against the provider's root, never the consumer's
//   4. damage degrades, never breaks — corrupt registry, unregistered
//      consumer, vanished provider, unreadable provider file: the request
//      itself must succeed with local-only enrichment
//   5. the token budget binds cross-repo content exactly as it binds local
//
// Everything drives server.mjs over JSON-RPC because that is the surface an
// agent actually touches; a library-level pass here could go green while the
// server (which loads local context at module scope) served stale grants.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync,  readFileSync, rmSync, realpathSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_ENV_NAME, TOOL_NAME } from "../lib/brand.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { emptyRegistry, registerRepo, saveRegistry, grant as addGrant } from "../lib/registry.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// --- scratch worlds ---------------------------------------------------------

// An isolated global home per test: grants live machine-wide, so a test that
// used the real one would entangle with the developer's actual registry.
const freshHome = () => realpathSync(mkdtempSync(join(tmpdir(), "cross-home-")));
const homeEnv = (home) => ({ [HOME_ENV_NAME]: home });

// A scratch repo with a knowledge file. git init because both the CLI and the
// freshness grading locate history there. realpath because /tmp is a symlink
// on macOS and registry identity is canonical-by-realpath.
function repo({ name = "svc", ops = {}, context = true } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "cross-repo-")));
  const dir = join(parent, name);       // controlled basename → controlled registry name
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (context) {
    writeFileSync(join(dir, CONTEXT_FILE), `${JSON.stringify({
      v: 0,
      api: { name, contract: null, contract_digest: null },
      generated_at: "2026-08-21",
      operations: ops,
    }, null, 2)}\n`);
  }
  return dir;
}

const op = (overrides = {}) => ({
  source_file: null,
  verified_at: "2026-08-21T10:00:00.000Z",
  contract_digest: null,
  shape_hash: "abc",
  status_codes: [200],
  effect: "read",
  fields: { id: { type: "string" } },
  ...overrides,
});

// A commit whose date we control, so "changed since verification" is exact.
function commitAll(dir, date) {
  const env = { ...process.env,
    GIT_AUTHOR_DATE: `${date}T12:00:00`, GIT_COMMITTER_DATE: `${date}T12:00:00` };
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "."], { cwd: dir, env });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", `at ${date}`],
    { cwd: dir, env });
}

// Run the CLI (grant / revoke) in a scratch repo, never throwing.
function cli(cwd, args, env = {}) {
  try {
    const out = execFileSync("node", [CLI, ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// --- a local origin, so nothing here depends on a third party ---------------

function httpFixture(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch((error) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

const jsonReply = (res, body) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(200, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
};

// --- the live server --------------------------------------------------------

// The environment the ambient shell must not reach into: every API_* override
// is dropped (a developer's API_CONTEXT_OFF or API_BUDGET would silently
// change what these tests measure), and the global home is always the test's
// own. What remains (PATH, HOME, git config) is the substrate.
function isolatedEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("API_")) delete env[key];
  delete env[HOME_ENV_NAME];
  return { ...env, ...overrides };
}

/**
 * One long-lived stdio server, driven interactively. The point of the shape:
 * requests are sent ONE AT A TIME against the same process, so a test can
 * grant, revoke, or edit a provider BETWEEN calls and prove the next answer
 * reflects it — the exact promise a batch-of-messages helper cannot exercise.
 */
function mcp({ consumer, home, base, extraEnv = {} }) {
  const scratch = mkdtempSync(join(tmpdir(), "cross-mcp-"));
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: consumer,
    env: isolatedEnv({
      API_BASE_URL: base,
      API_CONTEXT_DIR: consumer,
      API_EVIDENCE: join(scratch, "evidence"),
      API_USAGE_LOG: join(scratch, "usage.jsonl"),
      ...homeEnv(home),
      ...extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();   // id -> resolve
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 0;
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`no reply to ${method} (id ${id}); stderr: ${stderr}`));
    }, 15_000);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  return {
    child,
    request,
    init: () => request("initialize", { protocolVersion: "2025-06-18", capabilities: {} }),
    // A tools/call, returning BOTH the parsed envelope and the wire text: the
    // budget is a promise about the text an agent is billed for, so the text
    // must stay assertable.
    call: async (args) => {
      const reply = await request("tools/call", { name: TOOL_NAME, arguments: args });
      const text = reply.result.content[0].text;
      return { env: JSON.parse(text), text };
    },
    close: () => child.kill(),
  };
}

// Spawn, one call, tear down — for the tests where mid-session state is not
// the point.
async function oneCall({ consumer, home, base, extraEnv }, args) {
  const s = mcp({ consumer, home, base, extraEnv });
  try {
    await s.init();
    return await s.call(args);
  } finally { s.close(); }
}

// --- 1. fallback with provenance; local always wins --------------------------

test("a local miss is answered from a granted provider, labelled `from`; local knowledge wins unlabelled", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront", ops: {
    "GET /local": op(),
    "GET /both": op({ shape_hash: "local" }),
  } });
  const b = repo({ name: "billing-api", ops: {
    "GET /invoices": op({
      notes: ["cursor is opaque; do not parse it"],
      fields: { id: { type: "string" }, status: { type: "string", values: ["draft", "open", "paid"] } },
      shape_hash: "sha256:remote",
    }),
    "GET /both": op({ shape_hash: "remote" }),
  } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin });
  try {
    await s.init();

    // The cross answer: the provider's whole known block, plus its origin.
    const invoices = (await s.call({ path: "/invoices" })).env;
    assert.equal(invoices.status, 200);
    assert.equal(invoices.known?.op, "GET /invoices");
    assert.deepEqual(invoices.known?.from, { repo: "billing-api", root: b },
      "a granted answer must say which repo it came from");
    assert.deepEqual(invoices.known?.notes, ["cursor is opaque; do not parse it"]);
    assert.deepEqual(invoices.known?.enums, { status: ["draft", "open", "paid"] });
    assert.equal(invoices.known?.shape_hash, "sha256:remote");
    assert.equal(invoices.known?.confidence, "verified");

    // Local knowledge carries no provenance banner — `from` MEANS "not yours".
    const local = (await s.call({ path: "/local" })).env;
    assert.equal(local.known?.op, "GET /local");
    assert.equal(local.known?.from, undefined,
      "a local answer must not be dressed as a cross-repo one");

    // Both repos know the op: local wins, provider is never consulted for it.
    const both = (await s.call({ path: "/both" })).env;
    assert.equal(both.known?.shape_hash, "local");
    assert.equal(both.known?.from, undefined);

    // Nobody knows the op: the block is null, exactly as before the feature.
    const nowhere = (await s.call({ path: "/nowhere" })).env;
    assert.equal(nowhere.known, null);
  } finally { s.close(); await f.close(); }
});

test("a consumer with no knowledge file of its own still receives granted knowledge", async () => {
  // The storefront that never ran init is the first repo that NEEDS the
  // billing repo's gotchas — an empty local file must not be a precondition.
  const home = freshHome();
  const a = repo({ name: "frontend", context: false });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
    assert.equal(env.status, 200);
    assert.equal(env.known?.from?.repo, "billing-api");
  } finally { await f.close(); }
});

// --- 2. the provider's history grades the provider's claim -------------------

test("confidence for a granted answer is graded against the provider's root, not the consumer's", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });   // clean history; nothing here ever moved
  // The provider's claim depends on a source file that CHANGED after the
  // verification. Graded against the provider's history: suspect. Graded
  // against the consumer's (where the file does not even exist): verified —
  // which would be a confident label derived from the wrong repo's git log,
  // the precise class of wrong this tool exists to kill.
  const b = repo({ name: "billing-api", ops: {
    "GET /invoices": op({ source_file: "src/billing.mjs", verified_at: "2026-08-01T00:00:00.000Z" }),
  } });
  mkdirSync(join(b, "src"));
  writeFileSync(join(b, "src", "billing.mjs"), "export const v = 2;\n");
  commitAll(b, "2026-08-10");
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
    assert.equal(env.known?.from?.repo, "billing-api");
    assert.equal(env.known?.confidence, "suspect",
      "the provider's source moved after verification; only the provider's git log can say so");
  } finally { await f.close(); }
});

test("provider confidence observes a HEAD change during a live server session", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  const b = repo({ name: "billing-api", ops: {
    "GET /invoices": op({ source_file: "src/billing.mjs", verified_at: "2026-08-01T00:00:00.000Z" }),
  } });
  mkdirSync(join(b, "src"));
  writeFileSync(join(b, "src", "billing.mjs"), "export const version = 1;\n");
  commitAll(b, "2026-07-01");
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin });
  try {
    await s.init();
    assert.equal((await s.call({ path: "/invoices" })).env.known?.confidence, "verified",
      "the provider is fresh before its later commit");

    writeFileSync(join(b, "src", "billing.mjs"), "export const version = 2;\n");
    commitAll(b, "2026-08-10");
    const after = (await s.call({ path: "/invoices" })).env;
    assert.equal(after.known?.confidence, "suspect",
      "a provider HEAD change must invalidate cached confidence without restart");
  } finally { s.close(); await f.close(); }
});

// --- 3. query time, against a LIVE server ------------------------------------

test("grant, provider edits, and revoke are each visible on the very next call of a running server", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront", ops: {} });
  const b = repo({ name: "billing-api", ops: { "GET /widgets": op({ notes: ["v1: ids are not stable"] }) } });

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin });
  try {
    await s.init();

    // Before any grant: default deny, from inside a server that is ALREADY
    // running — proving the registry was not captured at module load.
    assert.equal((await s.call({ path: "/widgets" })).env.known, null,
      "no grant, no answer");

    // Grant while the server runs. No restart between here and the next call.
    assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
    const granted = (await s.call({ path: "/widgets" })).env;
    assert.equal(granted.known?.from?.repo, "billing-api",
      "a grant must be live on the first call after it is made");
    assert.deepEqual(granted.known?.notes, ["v1: ids are not stable"]);

    // The provider learns something new. The next call must carry it: the
    // knowledge never moves, so a read is always of the provider's CURRENT file.
    const ctx = JSON.parse(readFileSync(join(b, CONTEXT_FILE), "utf8"));
    ctx.operations["GET /widgets"].notes.push("v2: added mid-session");
    writeFileSync(join(b, CONTEXT_FILE), JSON.stringify(ctx));
    assert.deepEqual((await s.call({ path: "/widgets" })).env.known?.notes,
      ["v1: ids are not stable", "v2: added mid-session"],
      "a provider's new learning must be visible without any restart");

    // Revoke. THE promise: dead on the very next query of the same process.
    assert.equal(cli(a, ["revoke", b], homeEnv(home)).code, 0);
    assert.equal((await s.call({ path: "/widgets" })).env.known, null,
      "a revoked grant must stop answering on the first call after revoke");

    assert.equal(s.child.exitCode, null, "one server process lived through all of it");
  } finally { s.close(); await f.close(); }
});

// --- 4. damage degrades to local-only; the request itself is untouchable -----

test("registry damage, an unknown consumer, a vanished provider, or a broken provider file never break the request", async () => {
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    // The request must SUCCEED in every scenario; `known` simply stays null.
    const expectLocalOnly = async (home, consumer, note) => {
      const { env } = await oneCall({ consumer, home, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, `${note}: the request must still execute`);
      assert.equal(env.ok, true, `${note}: the request must still succeed`);
      assert.equal(env.known, null, `${note}: degradation is silent, local-only`);
      return env;
    };

    // (a) corrupt registry: evidence, not a casualty — and never a crash here.
    {
      const home = freshHome();
      writeFileSync(join(home, "registry.json"), "{ not json");
      await expectLocalOnly(home, repo({ name: "storefront" }), "corrupt registry");
    }

    // (b) a consumer the registry has never heard of, in a registry that DOES
    // hold repos and grants — none of them this one's.
    {
      const home = freshHome();
      const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
      const c = repo({ name: "someone-else" });
      const reg = emptyRegistry();
      addGrant(reg, registerRepo(reg, c).id, registerRepo(reg, b).id);
      saveRegistry(reg, homeEnv(home));
      await expectLocalOnly(home, repo({ name: "storefront" }), "unregistered consumer");
    }

    // (c) a granted provider whose root has vanished from disk.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
      rmSync(b, { recursive: true, force: true });
      await expectLocalOnly(home, a, "vanished provider root");
    }

    // (d) a granted provider whose knowledge file no longer parses.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
      writeFileSync(join(b, CONTEXT_FILE), "{ this is not json");
      await expectLocalOnly(home, a, "unreadable provider context");
    }
  } finally { await f.close(); }
});

test("API_CONTEXT_OFF=1 disables the cross-repo consult along with the local one", async () => {
  // Off means off: the control arm of every measurement runs with the
  // treatment disabled, and a granted provider leaking through would quietly
  // contaminate the arm that exists to measure the tool's absence.
  const home = freshHome();
  const a = repo({ name: "storefront", ops: { "GET /local": op() } });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin, extraEnv: { API_CONTEXT_OFF: "1" } });
  try {
    await s.init();
    assert.equal((await s.call({ path: "/invoices" })).env.known, null,
      "cross-repo knowledge must not survive the off switch");
    assert.equal((await s.call({ path: "/local" })).env.known, null,
      "the off switch still disables local knowledge too");
  } finally { s.close(); await f.close(); }
});

// --- 5. the budget binds cross content exactly as local ----------------------

test("the envelope token budget applies to cross-repo content exactly as to local content", async () => {
  const home = freshHome();
  const notes = ["page size caps at 100 even when per_page asks for more",
    "the cursor expires after 60 seconds of inactivity"];
  // The same operation knowledge on both sides of the seam: /big-cross is only
  // in the provider, /big-local only in the consumer, and the response behind
  // both is far larger than the budget.
  const a = repo({ name: "storefront", ops: { "GET /big-local": op({ notes }) } });
  const b = repo({ name: "billing-api", ops: { "GET /big-cross": op({ notes }) } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);

  const rows = Array.from({ length: 80 }, (_, i) => ({
    id: `row-${i}`, name: `widget number ${i}`, padding: "x".repeat(48),
  }));
  const f = await httpFixture((req, res) => jsonReply(res, rows));
  // Current consumer traffic uses a real stack. The granted provider remains
  // a saved historical read-only snapshot, as this cross-repo seam promises.
  createFixtureStack(a, { baseUrl: f.origin });
  writeFileSync(fixtureContextFile(a), readFileSync(join(a, CONTEXT_FILE)));
  const BUDGET = 300;   // tokens; the wire text is what the budget is measured on
  const s = mcp({ consumer: a, home, base: f.origin, extraEnv: { API_BUDGET: String(BUDGET) } });
  try {
    await s.init();
    const cross = await s.call({ path: "/big-cross" });
    const local = await s.call({ path: "/big-local" });
    for (const [label, { env, text }] of [["cross", cross], ["local", local]]) {
      assert.equal(env.status, 200);
      assert.deepEqual(env.known?.notes, notes, `${label}: the knowledge itself must arrive`);
      assert.ok(env.discovery?.truncated, `${label}: the oversized body was trimmed to make room`);
      assert.ok(text.length <= BUDGET * 4,
        `${label}: ${text.length} chars exceeds the ${BUDGET}-token budget the agent was promised`);
    }
    assert.deepEqual(cross.env.known?.from, { repo: "billing-api", root: b },
      "provenance must survive budget pressure");
    assert.equal(local.env.known?.from, undefined);
  } finally { s.close(); await f.close(); }
});
