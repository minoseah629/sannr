// Cross-repo knowledge — the ADVERSARIAL pass (QA, 2026-08-21).
//
//   node --test test/cross-context-qa.test.mjs
//
// test/cross-context.test.mjs pins what the feature PROMISES; this file pins
// what it must SURVIVE. Every scenario here is a way a real machine goes wrong
// or a granted repo goes hostile: a registry whose JSON is valid but whose
// shapes are not, grants pointing at repos that were never registered, a
// provider root that became a plain file, knowledge files full of __proto__
// keys and junk-typed entries, a global home that is empty / a file / a path
// with spaces, symlinked knowledge files, would-be transitive grant chains,
// and a provider trying to ride an envelope past the secret scrubber. In every
// case the bar is the containment clause of the spec: request execution never
// breaks; enrichment degrades to local-only (known: null) or answers truthfully.
//
// Everything drives the real stdio server, same as the promise-side tests,
// because module-load state (local context) versus per-request state (the
// registry, the provider file) is exactly what these scenarios stress.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync,  rmSync, realpathSync, symlinkSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_ENV_NAME, TOOL_NAME } from "../lib/brand.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { emptyRegistry, registerRepo, saveRegistry, grant as addGrant } from "../lib/registry.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// --- scratch worlds (same substrate as test/cross-context.test.mjs) ---------

const freshHome = () => realpathSync(mkdtempSync(join(tmpdir(), "qa-home-")));
const homeEnv = (home) => ({ [HOME_ENV_NAME]: home });

function repo({ name = "svc", ops = {}, context = true } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "qa-repo-")));
  const dir = join(parent, name);
  mkdirSync(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (context) writeContext(dir, ops);
  return dir;
}

function writeContext(dir, ops, name = "svc") {
  writeFileSync(join(dir, CONTEXT_FILE), `${JSON.stringify({
    v: 0,
    api: { name, contract: null, contract_digest: null },
    generated_at: "2026-08-21",
    operations: ops,
  })}\n`);
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

function cli(cwd, args, env = {}) {
  try {
    const out = execFileSync("node", [CLI, ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

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

function isolatedEnv(overrides) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("API_")) delete env[key];
  delete env[HOME_ENV_NAME];
  return { ...env, ...overrides };
}

function mcp({ consumer, home, base, extraEnv = {} }) {
  const scratch = mkdtempSync(join(tmpdir(), "qa-mcp-"));
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: consumer,
    env: isolatedEnv({
      API_BASE_URL: base,
      API_CONTEXT_DIR: consumer,
      API_EVIDENCE: join(scratch, "evidence"),
      API_USAGE_LOG: join(scratch, "usage.jsonl"),
      // `home` may legitimately be "" here (the empty-override scenario), so
      // spread an explicit pair rather than homeEnv's truthy convenience.
      [HOME_ENV_NAME]: home,
      ...extraEnv,
    }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
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
    call: async (args) => {
      const reply = await request("tools/call", { name: TOOL_NAME, arguments: args });
      const text = reply.result.content[0].text;
      return { env: JSON.parse(text), text };
    },
    close: () => child.kill(),
  };
}

async function oneCall({ consumer, home, base, extraEnv }, args) {
  const s = mcp({ consumer, home, base, extraEnv });
  try {
    await s.init();
    return await s.call(args);
  } finally { s.close(); }
}

// --- 1. semi-corrupt registries: valid JSON, hostile shapes ------------------

test("a registry whose JSON parses but whose shapes are hostile degrades to local-only, then recovers on the same live server", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op({ notes: ["real note"] }) } });

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin });
  try {
    await s.init();

    // grants as an OBJECT. When this was written, loadRegistry accepted the
    // shape and providersFor threw — the client's belt catch contained it.
    // Since the BUG-1 fix, loadRegistry's shape gate refuses the file as
    // REGISTRY_INVALID and crossLookup degrades before touching grants. The
    // assertions are mechanism-blind on purpose: whichever layer answers,
    // the request must succeed local-only.
    writeFileSync(join(home, "registry.json"),
      JSON.stringify({ v: 1, repos: {}, grants: {} }));
    let r = (await s.call({ path: "/invoices" })).env;
    assert.equal(r.status, 200, "grants-as-object: request must execute");
    assert.equal(r.ok, true);
    assert.equal(r.known, null, "grants-as-object: degrade to local-only");

    // a null entry inside the grants array: same containment clause.
    {
      const reg = emptyRegistry();
      const aId = registerRepo(reg, a).id;
      const bId = registerRepo(reg, b).id;
      addGrant(reg, aId, bId);
      reg.grants.unshift(null);
      saveRegistry(reg, homeEnv(home));
    }
    r = (await s.call({ path: "/invoices" })).env;
    assert.equal(r.status, 200, "null grant entry: request must execute");
    assert.equal(r.known, null, "null grant entry: degrade to local-only");

    // Registry repaired between calls of the SAME process: the very next call
    // answers. Damage must not be cached any more than grants are.
    {
      const reg = emptyRegistry();
      addGrant(reg, registerRepo(reg, a).id, registerRepo(reg, b).id);
      saveRegistry(reg, homeEnv(home));
    }
    r = (await s.call({ path: "/invoices" })).env;
    assert.equal(r.known?.from?.repo, "billing-api",
      "a repaired registry must answer on the very next call — no negative cache");
    assert.deepEqual(r.known?.notes, ["real note"]);

    assert.equal(s.child.exitCode, null, "one server survived all three registries");
  } finally { s.close(); await f.close(); }
});

test("a grant whose provider id was never registered is skipped; a real grant beside it still answers", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op({ notes: ["from b"] }) } });
  const reg = emptyRegistry();
  const aId = registerRepo(reg, a).id;
  const bId = registerRepo(reg, b).id;
  // Dead grants FIRST in grant order, so skipping (not throwing) is what lets
  // the live grant behind it answer. Originally one of these carried a
  // junk-TYPED root (12345) — since the BUG-1 fix, loadRegistry's shape gate
  // refuses that whole file as REGISTRY_INVALID (pinned in registry.test.mjs),
  // so the dead-but-SOUND shapes live here instead: a dangling provider id,
  // and a string root whose path no longer exists.
  reg.grants.push({ consumer: aId, provider: "zzzzzz", granted_at: "2026-08-21T00:00:00Z" });
  reg.repos.badroot = { name: "junk", root: join(a, "no-such-subdir", "gone"),
    registered_at: "x", last_seen_at: "x" };
  reg.grants.push({ consumer: aId, provider: "badroot", granted_at: "2026-08-21T00:00:00Z" });
  addGrant(reg, aId, bId);
  saveRegistry(reg, homeEnv(home));

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
    assert.equal(env.status, 200);
    assert.equal(env.known?.from?.repo, "billing-api",
      "dead grants ahead in grant order must be skipped, not fatal");
    assert.deepEqual(env.known?.notes, ["from b"]);
  } finally { await f.close(); }
});

// --- 2. hostile provider knowledge files -------------------------------------

test("junk-typed and proto-keyed provider files never break the request", async () => {
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    const survives = async (label, fileBody, { expectKnown = null } = {}) => {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", context: false });
      writeFileSync(join(b, CONTEXT_FILE), fileBody);
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0, `${label}: grant`);
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, `${label}: request must execute`);
      assert.equal(env.ok, true, `${label}: request must succeed`);
      if (expectKnown === null) assert.equal(env.known, null, `${label}: degrade to local-only`);
      return env;
    };

    // operations as an ARRAY — Object.keys yields indices, nothing matches.
    await survives("operations-as-array",
      JSON.stringify({ v: 0, api: {}, operations: ["GET /invoices"] }));

    // the matched entry is null — knownBlock cannot even read .fields.
    await survives("null entry",
      JSON.stringify({ v: 0, api: {}, operations: { "GET /invoices": null } }));

    // the whole document is a JSON array.
    await survives("document-as-array", JSON.stringify([1, 2, 3]));

    // __proto__ keys at every level; must neither crash nor pollute. The
    // entry itself is junk-typed (a string): every field probe comes back
    // undefined, so the block that emerges is the inert unverified shell —
    // containment by vacuity, pinned so a change in that posture is loud.
    {
      const env = await survives("proto keys",
        `{"v":0,"api":{"__proto__":{"polluted":1}},"__proto__":{"polluted":1},` +
        `"operations":{"__proto__":{"notes":["boo"]},"GET /invoices":"not an object"}}`,
        { expectKnown: "any" });
      assert.equal(env.known?.op, "GET /invoices");
      assert.equal(env.known?.confidence, "unverified",
        "a junk-typed entry grades unverified — nothing invented");
      assert.equal(env.known?.verified_at, null);
      assert.equal(env.known?.notes, undefined, "the __proto__ sibling's notes must not bleed in");
    }

    // A hostile FIRST provider must not break the request even when its entry
    // MATCHES (crossLookup returns the junk entry; the belt has to catch what
    // knownBlock does with it). Degrading to null here is the documented cost.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const bad = repo({ name: "bad-api" });
      writeFileSync(join(bad, CONTEXT_FILE),
        JSON.stringify({ v: 0, api: {}, operations: { "GET /invoices": null } }));
      const good = repo({ name: "good-api", ops: { "GET /invoices": op() } });
      assert.equal(cli(a, ["grant", bad], homeEnv(home)).code, 0);
      assert.equal(cli(a, ["grant", good], homeEnv(home)).code, 0);
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, "hostile first provider: request must execute");
      assert.equal(env.ok, true);
      // Pinned degradation: the hostile entry matched first (grant order), the
      // belt contained it, and no fallthrough to the later provider happens.
      assert.equal(env.known, null,
        "a matched-but-junk entry degrades this lookup; it must not crash the request");
    }

    // notes as a string instead of an array: today's code passes it through
    // (`entry.notes?.length` is a character count). Contained is the bar; the
    // envelope's exact typing of hostile input is pinned so a change is loud.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api" });
      writeFileSync(join(b, CONTEXT_FILE), JSON.stringify({
        v: 0, api: {},
        operations: { "GET /invoices": { verified_at: "2026-08-21", notes: "just a string" } },
      }));
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200);
      assert.equal(env.ok, true, "string notes: request must succeed");
      assert.equal(env.known?.op, "GET /invoices");
      assert.equal(env.known?.notes, undefined, "malformed cells are not delivered as API guidance");
      assert.equal(env.known?.note_history?.state, 'invalid');
      assert.ok(env.known.note_history.issues.some(issue => issue.code === 'NOTE_ARRAY_INVALID'));
    }
  } finally { await f.close(); }
});

test("a provider root that became a plain FILE, and a knowledge file that is a symlink, both behave", async () => {
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    // Root replaced by a file: existsSync(root) is true, loadContext finds no
    // <root>/sannr.json underneath a non-directory — degrade, never throw.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
      rmSync(b, { recursive: true, force: true });
      writeFileSync(b, "i am a file where a repo used to be\n");
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, "root-as-file: request must execute");
      assert.equal(env.ok, true);
      assert.equal(env.known, null, "root-as-file: degrade to local-only");
    }

    // Knowledge file is a symlink to real content elsewhere: reads follow it.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", context: false });
      const elsewhere = join(realpathSync(mkdtempSync(join(tmpdir(), "qa-elsewhere-"))), "real.json");
      writeFileSync(elsewhere, JSON.stringify({
        v: 0, api: {}, operations: { "GET /invoices": op({ notes: ["via symlink"] }) },
      }));
      mkdirSync(dirname(join(b, CONTEXT_FILE)), { recursive: true });
      symlinkSync(elsewhere, join(b, CONTEXT_FILE));
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.deepEqual(env.known?.notes, ["via symlink"],
        "a symlinked knowledge file is ordinary content");
      assert.equal(env.known?.from?.repo, "billing-api");
    }

    // Dangling symlink: existsSync is false through the link — degrade.
    {
      const home = freshHome();
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", context: false });
      mkdirSync(dirname(join(b, CONTEXT_FILE)), { recursive: true });
      symlinkSync(join(b, "never-existed.json"), join(b, CONTEXT_FILE));
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, "dangling symlink: request must execute");
      assert.equal(env.known, null);
    }
  } finally { await f.close(); }
});

// --- 3. the global home, mis-set ---------------------------------------------

test("a global home that is empty, a file, or a path with spaces never breaks the request", async () => {
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    // Empty override falls back to the REAL ~/.<product>. Read-only there: the
    // scratch consumer cannot be registered in it, so the lookup dead-ends at
    // the unregistered-consumer gate — and must do so quietly.
    {
      const a = repo({ name: "storefront" });
      const { env } = await oneCall({ consumer: a, home: "", base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, "empty home: request must execute");
      assert.equal(env.ok, true);
      assert.equal(env.known, null, "a scratch consumer is unknown to the real registry");
    }

    // Home pointing at a FILE: <file>/registry.json exists for no one.
    {
      const notAHome = join(realpathSync(mkdtempSync(join(tmpdir(), "qa-nothome-"))), "file.txt");
      writeFileSync(notAHome, "not a directory\n");
      const a = repo({ name: "storefront" });
      const { env } = await oneCall({ consumer: a, home: notAHome, base: f.origin }, { path: "/invoices" });
      assert.equal(env.status, 200, "home-as-file: request must execute");
      assert.equal(env.known, null);
    }

    // A home path with spaces must carry the whole happy path.
    {
      const home = join(realpathSync(mkdtempSync(join(tmpdir(), "qa-space-"))), "home with spaces");
      mkdirSync(home);
      const a = repo({ name: "storefront" });
      const b = repo({ name: "billing-api", ops: { "GET /invoices": op({ notes: ["spaced"] }) } });
      assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0, "grant through a spaced home");
      const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices" });
      assert.deepEqual(env.known?.notes, ["spaced"], "spaces in the home path are just characters");
    }
  } finally { await f.close(); }
});

// --- 4. grants do not compose ------------------------------------------------

test("grants are not transitive: A→B and B→C never lets A read C", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  const b = repo({ name: "billing-api", ops: { "GET /b-only": op({ notes: ["b knows"] }) } });
  const c = repo({ name: "ledger-api", ops: { "GET /c-only": op({ notes: ["c knows"] }) } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
  assert.equal(cli(b, ["grant", c], homeEnv(home)).code, 0);

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin });
  try {
    await s.init();
    const direct = (await s.call({ path: "/b-only" })).env;
    assert.equal(direct.known?.from?.repo, "billing-api", "the direct grant answers");
    const chained = (await s.call({ path: "/c-only" })).env;
    assert.equal(chained.status, 200);
    assert.equal(chained.known, null,
      "B's grant on C must be invisible to A — a chain is two independent denials");
  } finally { s.close(); await f.close(); }
});

// --- 5. who wins when several providers could answer ---------------------------

test("exact and template matches outrank substrings across providers", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  // p1 can only answer GET /pieces by SUBSTRING (its key merely contains the
  // op); p2 holds the exact key. p1 was granted first, but match quality is
  // global: the exact key must win regardless of grant order.
  const p1 = repo({ name: "parts-api", ops: {
    "GET /pieces/deep": op({ notes: ["substring, earlier grant"] }),
  } });
  const p2 = repo({ name: "pieces-api", ops: {
    "GET /pieces": op({ notes: ["exact, later grant"] }),
  } });
  assert.equal(cli(a, ["grant", p1], homeEnv(home)).code, 0);
  assert.equal(cli(a, ["grant", p2], homeEnv(home)).code, 0);

  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  const s = mcp({ consumer: a, home, base: f.origin });
  try {
    await s.init();
    const won = (await s.call({ path: "/pieces" })).env;
    assert.equal(won.known?.from?.repo, "pieces-api",
      "an exact match beats an earlier provider's substring");
    assert.equal(won.known?.op, "GET /pieces");

    const templated = repo({ name: "invoice-api", ops: {
      "GET /invoices/{invoice_id}": op({ notes: ["provider template"] }),
    } });
    assert.equal(cli(a, ["grant", templated], homeEnv(home)).code, 0);
    const template = (await s.call({ path: "/invoices/42/" })).env;
    assert.equal(template.known?.from?.repo, "invoice-api",
      "the MCP path uses the same provider-template matcher");
    assert.equal(template.known?.op, "GET /invoices/{invoice_id}");

    // Within ONE provider file the exact key wins even when a substring key
    // sorts first; case-insensitively.
    const both = repo({ name: "both-api", ops: {
      "GET /widgets/extra": op({ notes: ["substring"] }),
      "get /WIDGETS": op({ notes: ["exact, odd case"] }),
    } });
    const a2 = repo({ name: "consumer2" });
    assert.equal(cli(a2, ["grant", both], homeEnv(home)).code, 0);
    const s2 = mcp({ consumer: a2, home, base: f.origin });
    try {
      await s2.init();
      const w = (await s2.call({ path: "/widgets" })).env;
      assert.equal(w.known?.op, "get /WIDGETS", "exact (case-insensitive) beats substring in-file");
      assert.deepEqual(w.known?.notes, ["exact, odd case"]);
    } finally { s2.close(); }
  } finally { s.close(); await f.close(); }
});

test("local template tolerance still wins over a provider's EXACT literal key", async () => {
  // The local matcher is deliberately more generous (slash/template tolerance).
  // A concrete request that local knowledge matches by template must never be
  // answered by a provider holding the literal key — local always wins, even
  // when the provider's match looks 'better'.
  const home = freshHome();
  const a = repo({ name: "storefront", ops: {
    "GET /invoices/{id}": op({ notes: ["local, templated"] }),
  } });
  const b = repo({ name: "billing-api", ops: {
    "GET /invoices/42": op({ notes: ["provider, literal"] }),
  } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);
  const f = await httpFixture((req, res) => jsonReply(res, { ok: true }));
  try {
    const { env } = await oneCall({ consumer: a, home, base: f.origin }, { path: "/invoices/42" });
    assert.equal(env.known?.op, "GET /invoices/{id}", "the templated local entry answers");
    assert.deepEqual(env.known?.notes, ["local, templated"]);
    assert.equal(env.known?.from, undefined, "and carries no provenance banner");
  } finally { await f.close(); }
});

// --- 6. secrets and the provider boundary -------------------------------------

test("a cross-enriched envelope carries the provider file's content and nothing of the environment", async () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  const b = repo({ name: "billing-api", ops: {
    "GET /invoices": op({ notes: [
      "plain note",
      // A provider file that TRIES to read like an expansion. It must arrive
      // as inert text, never resolved against the consumer's environment.
      "try ${QA_CROSS_CANARY} and $QA_CROSS_CANARY and {QA_CROSS_CANARY}",
    ] }),
  } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);

  const SECRET = "qa-super-secret-bearer-value-1234567890";
  const CANARY = "qa-canary-env-value-abcdefghij";
  let sawAuth = null;
  const f = await httpFixture((req, res) => { sawAuth = req.headers.authorization; jsonReply(res, { ok: true }); });
  try {
    const { env, text } = await oneCall({
      consumer: a, home, base: f.origin,
      extraEnv: { API_AUTH: "bearer:QA_CROSS_TOKEN", QA_CROSS_TOKEN: SECRET, QA_CROSS_CANARY: CANARY },
    }, { path: "/invoices" });
    assert.equal(env.status, 200);
    assert.equal(sawAuth, `Bearer ${SECRET}`, "the credential reached the wire");
    assert.equal(env.known?.from?.repo, "billing-api");
    assert.ok(!text.includes(SECRET), "the credential value must never enter the envelope");
    assert.ok(!text.includes(CANARY), "unrelated env values must never enter the envelope");
    assert.ok(text.includes("try ${QA_CROSS_CANARY} and $QA_CROSS_CANARY and {QA_CROSS_CANARY}"),
      "placeholder-looking provider text arrives verbatim, unexpanded");
  } finally { await f.close(); }
});

// --- 7. budget symmetry under provider-inflated knowledge ----------------------

test("an oversized known block is trimmed symmetrically local and cross, with withholding named", async () => {
  const home = freshHome();
  // 60 notes ~55 chars each: far past a 300-token budget on its own. Both
  // delivery arms must apply the same cheapest-value-first known trim rather
  // than letting a provider inflate every matching consumer envelope.
  const notes = Array.from({ length: 60 }, (_, i) =>
    `note ${i}: the pagination cursor invalidates after use ${i}`);
  const a = repo({ name: "storefront", ops: { "GET /big-local": op({ notes }) } });
  const b = repo({ name: "billing-api", ops: { "GET /big-cross": op({ notes }) } });
  assert.equal(cli(a, ["grant", b], homeEnv(home)).code, 0);

  const rows = Array.from({ length: 40 }, (_, i) => ({
    id: `row-${i}`, name: `widget number ${i}`, padding: "x".repeat(48),
  }));
  const BUDGET = 300;
  const f = await httpFixture((req, res) => jsonReply(res, rows));
  const s = mcp({ consumer: a, home, base: f.origin, extraEnv: { API_BUDGET: String(BUDGET) } });
  try {
    await s.init();
    const cross = await s.call({ path: "/big-cross" });
    const local = await s.call({ path: "/big-local" });

    assert.equal(cross.env.status, 200);
    assert.equal(local.env.status, 200);
    for (const [label, env] of [["cross", cross.env], ["local", local.env]]) {
      assert.ok((env.known?.notes?.length ?? 0) < notes.length, `${label}: oversized notes must be trimmed`);
      assert.ok(env.known?.withheld?.notes > 0, `${label}: trimmed notes must be reported as withheld`);
      assert.equal(env.known?.note_history?.state, 'unbaselined');
      assert.ok(env.known.note_history.issues.some(issue => issue.code === 'NOTE_BASELINE_MISSING'));
      assert.ok(cross.text.length <= BUDGET * 4 && local.text.length <= BUDGET * 4,
        `${label}: known trimming must keep the whole envelope within budget`);
    }
    assert.equal(cross.env.known?.from?.repo, "billing-api");

    // Identical trim rule and grading, with provenance allowed to consume
    // extra budget: the shared prefix survives in both arms, while the
    // provenance-bearing arm may withhold additional tail notes.
    const { from, op: crossOp, ...crossRest } = cross.env.known;
    const { op: localOp, ...localRest } = local.env.known;
    assert.equal(crossRest.confidence, localRest.confidence);
    assert.equal(crossRest.verified_at, localRest.verified_at);
    const sharedNotes = Math.min(crossRest.notes?.length ?? 0, localRest.notes?.length ?? 0);
    assert.deepEqual((crossRest.notes ?? []).slice(0, sharedNotes), (localRest.notes ?? []).slice(0, sharedNotes),
      "the same cheapest-value-first note prefix must survive in both arms");

    // Same trim ladder applied to both sides under the same pressure: neither
    // arm can escape the cap or silently drop the reason it trimmed.
    assert.equal(JSON.stringify(cross.env.data), JSON.stringify(local.env.data),
      "budget pressure must trim the payload identically");
    assert.equal(Boolean(cross.env.discovery?.truncated), Boolean(local.env.discovery?.truncated));
    assert.ok(cross.env.known.withheld.notes >= local.env.known.withheld.notes,
      "the provenance-bearing arm may withhold more, never less, under equal pressure");

    // And the wire difference is the provenance block alone (plus op-name
    // difference), within a small tolerance.
    const provenance = JSON.stringify({ from: cross.env.known.from }).length;
    const opDelta = Math.abs(crossOp.length - localOp.length);
    assert.ok(Math.abs(cross.text.length - local.text.length) <= provenance + opDelta + 16,
      `cross ${cross.text.length} vs local ${local.text.length} chars should differ only by provenance (${provenance})`);
  } finally { s.close(); await f.close(); }
});
