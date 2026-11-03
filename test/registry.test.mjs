// The cross-repo registry — global understanding at the local level.
//
//   node --test test/registry.test.mjs
//
// One machine, many repos, each with its own committed knowledge file. The
// registry (~/.<product>/registry.json) is the engine-owned index of which
// repos exist and WHO MAY READ WHOM: directional, default-deny grants, read
// from disk at query time. No daemon, no cache, no background process — a
// grant revoked is a grant gone on the very next query.
//
// The tests here pin the four promises the fleet harness and other registry
// grid will both build on:
//   1. default deny — no grant, no answer, in BOTH directions independently
//   2. query-time truth — reads hit the provider's file fresh, every time
//   3. isolation — the home dir obeys the env override, so parallel
//      experiments (and Docker generations) never share state by accident
//   4. honesty under damage — a corrupt registry refuses mutation loudly and
//      degrades reads to local-only; it never silently clobbers or invents

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync, existsSync, readdirSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { GLOBAL_DIR_NAME, HOME_ENV_NAME, PRODUCT } from "../lib/brand.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { globalHome, registryPath, emptyRegistry, loadRegistry, saveRegistry,
         registerRepo, resolveRef, grant, revoke, allowed, crossLookup } from "../lib/registry.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// Run the CLI in a scratch repo, capturing output and exit code, never throwing.
function cli(cwd, args, env = {}) {
  try {
    const out = execFileSync("node", [CLI, ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// An isolated global home per test: the env override IS the isolation story
// (fleet containers and parallel experiments point instances at their own
// home), so the tests exercise it rather than redirecting $HOME.
const freshHome = () => realpathSync(mkdtempSync(join(tmpdir(), "registry-home-")));
const homeEnv = (home) => ({ [HOME_ENV_NAME]: home });

// A scratch repo with a knowledge file. git init because the CLI locates the
// project by `git rev-parse`. realpath because /tmp is a symlink on macOS.
function repo({ name = "svc", ops = {}, context = true } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "registry-repo-")));
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

// --- the home: derived through the brand seam, overridable for isolation ----

test("global home derives from the product name and honours the env override", () => {
  assert.equal(GLOBAL_DIR_NAME, `.${PRODUCT}`);
  assert.equal(HOME_ENV_NAME, `${PRODUCT.toUpperCase()}_HOME`);

  const home = freshHome();
  assert.equal(globalHome({ [HOME_ENV_NAME]: home }), home);
  assert.equal(registryPath({ [HOME_ENV_NAME]: home }), join(home, "registry.json"));
  // Without the override the home sits under the user's home directory.
  assert.ok(globalHome({}).endsWith(GLOBAL_DIR_NAME));
});

// --- registration: idempotent by realpath, opaque stable ids ----------------

test("registering the same root twice yields one entry with a stable id", () => {
  const a = repo({ name: "alpha" });
  const reg = emptyRegistry();
  const first = registerRepo(reg, a);
  const second = registerRepo(reg, a);
  assert.equal(first.id, second.id);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(Object.keys(reg.repos).length, 1);
  assert.equal(reg.repos[first.id].name, "alpha");
  assert.equal(reg.repos[first.id].root, a);
});

test("the registry file holds exactly the declared schema — nothing extra, no values", () => {
  const home = freshHome();
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta" });
  const reg = emptyRegistry();
  const ida = registerRepo(reg, a).id;
  const idb = registerRepo(reg, b).id;
  grant(reg, ida, idb);
  saveRegistry(reg, homeEnv(home));

  const onDisk = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
  assert.deepEqual(Object.keys(onDisk).sort(), ["grants", "repos", "v"]);
  assert.equal(onDisk.v, 1);
  for (const entry of Object.values(onDisk.repos))
    assert.deepEqual(Object.keys(entry).sort(), ["last_seen_at", "name", "registered_at", "root"]);
  for (const g of onDisk.grants)
    assert.deepEqual(Object.keys(g).sort(), ["consumer", "granted_at", "provider"]);
  // Atomic write leaves no droppings.
  assert.deepEqual(readdirSync(home).filter((f) => f.includes(".tmp")), []);
});

// --- grants: directional, default-deny, idempotent --------------------------

test("grants are directional and default-deny", () => {
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta" });
  const reg = emptyRegistry();
  const ida = registerRepo(reg, a).id;
  const idb = registerRepo(reg, b).id;

  assert.equal(allowed(reg, ida, idb), false);            // default deny
  assert.equal(grant(reg, ida, idb).changed, true);
  assert.equal(grant(reg, ida, idb).changed, false);      // idempotent
  assert.equal(reg.grants.length, 1);
  assert.equal(allowed(reg, ida, idb), true);             // alpha may read beta
  assert.equal(allowed(reg, idb, ida), false);            // beta may NOT read alpha
  assert.equal(revoke(reg, ida, idb).changed, true);
  assert.equal(allowed(reg, ida, idb), false);
});

test("a repo cannot grant itself, and refs resolve by id, name, or path", () => {
  const a = repo({ name: "alpha" });
  const reg = emptyRegistry();
  const ida = registerRepo(reg, a).id;
  assert.equal(grant(reg, ida, ida).changed, false);
  assert.equal(reg.grants.length, 0);

  assert.equal(resolveRef(reg, ida, a).id, ida);          // by id
  assert.equal(resolveRef(reg, "alpha", a).id, ida);      // by name
  assert.equal(resolveRef(reg, a, a).id, ida);            // by path
  assert.equal(resolveRef(reg, "nope", a), null);
});

test("an ambiguous name reports the candidates instead of guessing", () => {
  const a = repo({ name: "twin" });
  const b = repo({ name: "twin" });
  const reg = emptyRegistry();
  registerRepo(reg, a);
  registerRepo(reg, b);
  const r = resolveRef(reg, "twin", a);
  assert.ok(r.ambiguous);
  assert.equal(r.ambiguous.length, 2);
});

// --- the CLI: grant / revoke / repos ----------------------------------------

test("the first grant creates the registry and says who may read whom", () => {
  const home = freshHome();
  const a = repo({ name: "consumer-app" });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });

  const r = cli(a, ["grant", b], homeEnv(home));
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(home, "registry.json")), "grant creates the registry file");
  assert.match(r.out, /consumer-app/);
  assert.match(r.out, /billing-api/);

  const reg = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
  assert.equal(Object.keys(reg.repos).length, 2, "both sides auto-registered");
  assert.equal(reg.grants.length, 1);
});

test("repos --json lists repos and grants; a vanished root is reported missing", () => {
  const home = freshHome();
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta" });
  cli(a, ["grant", b], homeEnv(home));

  const r = cli(a, ["repos", "--json"], homeEnv(home));
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.repos.length, 2);
  assert.equal(parsed.grants.length, 1);
  assert.ok(parsed.repos.every((x) => x.present === true));
  assert.equal(parsed.grants[0].consumer_name, "alpha");
  assert.equal(parsed.grants[0].provider_name, "beta");
});

test("revoke by name withdraws the grant on the next query", () => {
  const home = freshHome();
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta", ops: { "GET /widgets": op() } });
  cli(a, ["grant", b], homeEnv(home));
  assert.equal(cli(a, ["show", "GET /widgets"], homeEnv(home)).code, 0);

  const r = cli(a, ["revoke", "beta"], homeEnv(home));
  assert.equal(r.code, 0, r.out);
  assert.equal(cli(a, ["show", "GET /widgets"], homeEnv(home)).code, 1,
    "revoked means gone on the very next query — no daemon to lag behind");
});

// --- query time: show reaches granted providers, with provenance ------------

test("show falls back to a granted provider and labels the answer's origin", () => {
  const home = freshHome();
  const a = repo({ name: "storefront", ops: { "GET /local": op() } });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op({ notes: ["cursor is opaque"] }) } });
  cli(a, ["grant", b], homeEnv(home));

  const r = cli(a, ["show", "GET /invoices"], homeEnv(home));
  assert.equal(r.code, 0, r.out);
  const parsed = JSON.parse(r.out);
  assert.equal(parsed.op, "GET /invoices");
  assert.equal(parsed.from.repo, "billing-api");
  assert.equal(parsed.from.root, b);
  assert.deepEqual(parsed.notes, ["cursor is opaque"]);
});

test("without a grant, a provider's operations do not exist", () => {
  const home = freshHome();
  const a = repo({ name: "storefront", ops: { "GET /local": op() } });
  repo({ name: "billing-api", ops: { "GET /invoices": op() } }); // registered? no — and even registration alone must not leak
  const r = cli(a, ["show", "GET /invoices"], homeEnv(home));
  assert.equal(r.code, 1);
  assert.match(r.out, /OPERATION_NOT_FOUND/);
});

test("registration alone leaks nothing — only a grant opens the read", () => {
  const home = freshHome();
  const a = repo({ name: "storefront", ops: { "GET /local": op() } });
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
  // Register both sides without granting: grant then revoke leaves both registered.
  cli(a, ["grant", b], homeEnv(home));
  cli(a, ["revoke", b], homeEnv(home));
  const r = cli(a, ["show", "GET /invoices"], homeEnv(home));
  assert.equal(r.code, 1);
  assert.match(r.out, /OPERATION_NOT_FOUND/);
});

test("a local operation always wins over a provider's", () => {
  const home = freshHome();
  const a = repo({ name: "alpha", ops: { "GET /both": op({ shape_hash: "local" }) } });
  const b = repo({ name: "beta", ops: { "GET /both": op({ shape_hash: "remote" }) } });
  cli(a, ["grant", b], homeEnv(home));
  const parsed = JSON.parse(cli(a, ["show", "GET /both"], homeEnv(home)).out);
  assert.equal(parsed.shape_hash, "local");
  assert.equal(parsed.from, undefined, "a local answer carries no provenance banner");
});

test("a consumer with no knowledge file of its own can still read its grants", () => {
  const home = freshHome();
  const a = repo({ name: "frontend", context: false });   // no sannr.json at all
  const b = repo({ name: "billing-api", ops: { "GET /invoices": op() } });
  cli(a, ["grant", b], homeEnv(home));
  const r = cli(a, ["show", "GET /invoices"], homeEnv(home));
  assert.equal(r.code, 0, r.out);
  assert.equal(JSON.parse(r.out).from.repo, "billing-api");
});

// --- honesty under damage ---------------------------------------------------

test("a corrupt registry refuses mutation loudly and never clobbers", () => {
  const home = freshHome();
  writeFileSync(join(home, "registry.json"), "{ not json");
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta" });

  const r = cli(a, ["grant", b], homeEnv(home));
  assert.equal(r.code, 1);
  assert.match(r.out, /REGISTRY_INVALID/);
  assert.equal(readFileSync(join(home, "registry.json"), "utf8"), "{ not json",
    "the damaged file is untouched — evidence, not casualty");
});

test("valid JSON with junk shapes is refused as REGISTRY_INVALID, naming exactly what is malformed", () => {
  // The third damage state (QA BUG-1). JSON.parse accepting a file says
  // nothing about its shape: grants-as-object, a null grant entry, a null
  // repos value all parsed clean and then detonated as TypeErrors inside
  // whichever consumer touched them first — doctor mid-report, grant
  // mid-mutation. The refusal lives HERE, in the one loader every consumer
  // shares, so doctor, grant, revoke, and crossLookup cannot disagree about
  // what a damaged file is. And it REFUSES rather than filters: silently
  // dropping the junk would let the next save rewrite the file minus the
  // evidence.
  const shapes = [
    [{ v: 1, repos: {}, grants: {} }, /grants is not an array/],
    [{ v: 1, repos: {}, grants: [null] }, /grants\[0\] is not an object/],
    [{ v: 1, repos: { aa: null }, grants: [] }, /repos entry 'aa' is not an object/],
    // The same class, one level down: wrong container, wrong field types.
    [{ v: 1, repos: [], grants: [] }, /repos is not an object/],
    [{ v: 1, repos: { aa: { name: "x" } }, grants: [] }, /repos entry 'aa' has no string root/],
    // The junk-typed root the Feature-1 QA pass planted (root: 12345) — it
    // used to be skipped downstream by existsSync's own error-swallowing;
    // now it is named at the gate like every other shape.
    [{ v: 1, repos: { aa: { name: "x", root: 12345 } }, grants: [] }, /repos entry 'aa' has no string root/],
    [{ v: 1, repos: {}, grants: [{ consumer: "aa" }] }, /grants\[0\] has no string consumer and provider/],
  ];
  for (const [junk, why] of shapes) {
    const home = freshHome();
    const body = JSON.stringify(junk);
    writeFileSync(join(home, "registry.json"), body);
    const { registry, problem } = loadRegistry(homeEnv(home));
    assert.equal(problem?.code, "REGISTRY_INVALID", `${body} must be refused, not returned`);
    assert.match(problem.message, why, `the message must name the damage: ${problem.message}`);
    assert.ok(problem.next, "every refusal says what to do next");
    assert.deepEqual(registry, emptyRegistry(), "the caller degrades to empty, never to junk");
    assert.equal(readFileSync(join(home, "registry.json"), "utf8"), body,
      "a read never touches the damaged file — evidence, not casualty");
  }
});

test("a sound registry with a dangling grant id is ALLOWED — shape damage, not referential damage", () => {
  // Soundness is structure, not referential integrity: a grant naming an id
  // with no repos entry is the separately-pinned observation (see the QA
  // doctor suite), and the readers already skip it. Refusing it here would
  // brick a registry over a wrinkle every consumer survives.
  const home = freshHome();
  writeFileSync(join(home, "registry.json"), JSON.stringify(
    { v: 1, repos: {}, grants: [{ consumer: "aa", provider: "bb", granted_at: "2026-08-21" }] }));
  const { problem, registry } = loadRegistry(homeEnv(home));
  assert.equal(problem, undefined);
  assert.equal(registry.grants.length, 1, "the dangling grant is preserved, not filtered");
});

test("grant and revoke refuse a junk-shaped registry loudly and never rewrite it", () => {
  // Same promise the '{ not json' test above pins, for damage JSON.parse
  // cannot see. Before the shape gate this was a bare TypeError from inside
  // registerRepo — a crash, not a refusal, and a crash that named no file.
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta" });
  const home = freshHome();
  const body = JSON.stringify({ v: 1, repos: { aa: null }, grants: [] });
  writeFileSync(join(home, "registry.json"), body);
  for (const args of [["grant", b], ["revoke", b]]) {
    const r = cli(a, args, homeEnv(home));
    assert.equal(r.code, 1, `${args[0]} must refuse, got:\n${r.out}`);
    assert.match(r.out, /REGISTRY_INVALID/, `${args[0]} must name the refusal:\n${r.out}`);
    assert.ok(!/TypeError/.test(r.out), `${args[0]} crashed instead of refusing:\n${r.out}`);
    assert.equal(readFileSync(join(home, "registry.json"), "utf8"), body,
      `${args[0]} touched a file it could not parse`);
  }
});

test("a corrupt registry degrades show to local-only instead of breaking it", () => {
  const home = freshHome();
  writeFileSync(join(home, "registry.json"), "{ not json");
  const a = repo({ name: "alpha", ops: { "GET /local": op() } });
  const r = cli(a, ["show", "GET /local"], homeEnv(home));
  assert.equal(r.code, 0, "the primary path must survive registry damage");
});

test("a provider whose root vanished is skipped with a reason, not a crash", () => {
  const home = freshHome();
  const a = repo({ name: "alpha", ops: { "GET /local": op() } });
  const b = repo({ name: "beta", ops: { "GET /gone": op() } });
  cli(a, ["grant", b], homeEnv(home));
  execFileSync("rm", ["-rf", b]);
  const r = cli(a, ["show", "GET /gone"], homeEnv(home));
  assert.equal(r.code, 1);
  assert.match(r.out, /OPERATION_NOT_FOUND/);
  const list = cli(a, ["repos", "--json"], homeEnv(home));
  const gone = JSON.parse(list.out).repos.find((x) => x.name === "beta");
  assert.equal(gone.present, false);
});

// --- the library-level cross lookup (what the MCP path will reuse) ----------

test("crossLookup answers from granted providers only, at query time", () => {
  const home = freshHome();
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta", ops: { "GET /invoices": op() } });
  const env = homeEnv(home);
  const reg = emptyRegistry();
  const ida = registerRepo(reg, a).id;
  const idb = registerRepo(reg, b).id;
  saveRegistry(reg, env);
  assert.equal(crossLookup(a, "GET /invoices", env), null, "no grant, no answer");

  grant(reg, ida, idb);
  saveRegistry(reg, env);
  const hit = crossLookup(a, "GET /invoices", env);
  assert.equal(hit.key, "GET /invoices");
  assert.equal(hit.provider.name, "beta");

  // Query-time means CURRENT file content: a provider edit is visible with no
  // re-registration and no restart.
  const ctx = JSON.parse(readFileSync(join(b, CONTEXT_FILE), "utf8"));
  ctx.operations["GET /invoices"].status_codes = [200, 429];
  writeFileSync(join(b, CONTEXT_FILE), JSON.stringify(ctx));
  assert.deepEqual(crossLookup(a, "GET /invoices", env).entry.status_codes, [200, 429]);
});

test("crossLookup matches provider templates and trailing slashes before substrings", () => {
  const home = freshHome();
  const a = repo({ name: "storefront" });
  const loose = repo({ name: "loose-api", ops: {
    "GET /invoices/history": op({ notes: ["loose substring"] }),
  } });
  const templated = repo({ name: "billing-api", ops: {
    "GET /invoices/{invoice_id}": op({ notes: ["provider template"] }),
  } });
  const env = homeEnv(home);
  const reg = emptyRegistry();
  const aId = registerRepo(reg, a).id;
  const looseId = registerRepo(reg, loose).id;
  const templatedId = registerRepo(reg, templated).id;
  grant(reg, aId, looseId);
  grant(reg, aId, templatedId);
  saveRegistry(reg, env);

  const hit = crossLookup(a, "GET /invoices/42", env);
  assert.equal(hit.key, "GET /invoices/{invoice_id}");
  assert.equal(hit.provider.name, "billing-api",
    "a template in a later provider outranks a substring in an earlier provider");
  assert.deepEqual(hit.entry.notes, ["provider template"]);
  assert.equal(crossLookup(a, "GET /invoices/42/", env).key,
    "GET /invoices/{invoice_id}", "trailing slash follows the same template rule");

  // The CLI uses the same crossLookup path, so this also pins the human-facing
  // `show` output rather than only the library helper.
  const shown = cli(a, ["show", "GET /invoices/42/"], env);
  assert.equal(shown.code, 0, shown.out);
  assert.equal(JSON.parse(shown.out).op, "GET /invoices/{invoice_id}");
});

// --- the rename seam --------------------------------------------------------

test("the global home follows a product rename through the seam", () => {
  const home = freshHome();
  const a = repo({ name: "alpha" });
  const b = repo({ name: "beta", ops: { "GET /x": op() } });
  // Renamed product: the override env var is derived from the new name too.
  const renamed = { API_CONTEXT_PRODUCT_NAME: "zzyzx", ZZYZX_HOME: home };
  const r = cli(a, ["grant", b], renamed);
  assert.equal(r.code, 0, r.out);
  assert.ok(existsSync(join(home, "registry.json")),
    "the renamed product writes its registry into the renamed home");
  assert.ok(!r.out.includes(PRODUCT), "no output of the renamed product says the old name");
});

// --- connect registers the repo ---------------------------------------------

test("connect registers the repo in the machine registry", () => {
  const home = freshHome();
  const userHome = freshHome();     // keep host detection away from the real ~
  const a = repo({ name: "alpha" });
  writeFileSync(join(a, "openapi.json"), JSON.stringify({
    openapi: "3.0.0", info: { title: "t", version: "1" }, paths: { "/x": { get: { summary: "s" } } } }));
  const r = cli(a, ["connect"], { ...homeEnv(home), HOME: userHome });
  assert.equal(r.code, 0, r.out);
  const reg = JSON.parse(readFileSync(join(home, "registry.json"), "utf8"));
  const entry = Object.values(reg.repos).find((x) => x.root === a);
  assert.ok(entry, "connect adds the repo to the registry");
  assert.equal(reg.grants.length, 0, "connect grants NOTHING — registration is inert");
});

test("connect --dry-run writes no registry", () => {
  const home = freshHome();
  const userHome = freshHome();
  const a = repo({ name: "alpha" });
  const r = cli(a, ["connect", "--dry-run"], { ...homeEnv(home), HOME: userHome });
  assert.equal(r.code, 0, r.out);
  assert.ok(!existsSync(join(home, "registry.json")), "a dry run is a preview, not a write");
});
