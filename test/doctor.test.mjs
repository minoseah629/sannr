import { LAYOUT } from "../lib/layout.mjs";
// `sannr doctor` — the stranger's first-hour check. It looks for the
// common first-run mistakes and reports EACH with a concrete remedy, so a
// newcomer is never left staring at a silent "0 operations" or a hung request
// with no idea which of five things is wrong. It also pins the exit-code
// contract: 0 when no check fails (warnings allowed), non-zero when one fails.
//
//   node --test test/doctor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_ENV_NAME } from "../lib/brand.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { emptyRegistry, registerRepo, saveRegistry, loadRegistry } from "../lib/registry.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// A git sandbox so repoRoot() resolves to it and never escapes into the runner's
// own repo. The env is scrubbed of the knobs doctor inspects so an ambient value
// cannot mask what the config file says.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info:", "  title: fixture", '  version: "1"',
    "paths:", "  /json:", "    get:", "      summary: sample", "",
  ].join("\n"));
  return dir;
}

const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const k of ["API_ENV", "API_BASE_URL", "API_AUTH", "API_CONTRACT", "API_CONFIG",
                   "EDITORIAL_API_KEY", "LOCAL_KEY", "MISSING_KEY"]) if (!(k in extra)) delete env[k];
  // Doctor now inspects the machine registry, so it is one of the knobs this
  // scrub exists for: without an override, a developer's real ~/. registry —
  // healthy, corrupt, or carrying dead grants — would leak into every
  // assertion below. Each invocation gets its own empty global home unless the
  // test says otherwise.
  if (!(HOME_ENV_NAME in extra)) env[HOME_ENV_NAME] = freshHome();
  if (!("HOME" in extra)) env.HOME = freshHome();
  return env;
};

// Run doctor ASYNCHRONOUSLY, capturing stdout and the exit code without
// throwing on non-zero. Async matters: the reachability check hits a server
// living in THIS test process, and execFileSync would block the event loop so
// that server could never answer (the same trap cli-freshness.test.mjs notes).
const pexec = promisify(execFile);
async function doctor(cwd, env, ...args) {
  // Registry/wiring-only fixtures must not contact the public onboarding API.
  const localOnly = !env.API_BASE_URL && !env.API_CONFIG && !existsSync(join(cwd, LAYOUT.environments));
  if (localOnly && !args.includes("--offline")) args.push("--offline");
  try {
    const { stdout } = await pexec("node", [CLI, "doctor", ...args], { cwd, encoding: "utf8", env });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.code ?? 1, stdout: (e.stdout ?? "") + (e.stderr ?? "") };
  }
}

// A local server that answers HEAD/GET, so the "reachable" check has something
// real to reach. Returns { origin, close }.
async function up() {
  const server = createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

// The same, on a NAMED port, for the one test that is about the built-in
// fallback URL specifically. If the port is already taken — very likely on a
// developer machine, which is the whole point of that test — the ambient
// listener serves just as well, so a bind failure is a pass, not an error.
async function upOn(port) {
  const server = createServer((req, res) => { res.writeHead(200); res.end("ok"); });
  try {
    await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(port, "127.0.0.1", res);
    });
  } catch { return { close: () => {} }; }
  return { close: () => server.close() };
}

test("a healthy setup passes every check and exits 0", async () => {
  const srv = await up();
  const dir = sandbox();
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local",
    environments: { local: { baseUrl: srv.origin, auth: "header:X-API-Key:LOCAL_KEY" } },
  }));
  try {
    const { code, stdout } = await doctor(dir, cleanEnv({ LOCAL_KEY: "present" }));
    assert.equal(code, 0, `expected exit 0, got ${code}\n${stdout}`);
    assert.match(stdout, /contract/i);
    assert.match(stdout, /reachable|base url/i);
    assert.match(stdout, /auth/i);
    // Every reported check carries a pass marker; none should be a failure here.
    assert.doesNotMatch(stdout, /\bFAIL\b/, `a healthy setup reported a failure:\n${stdout}`);
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// One registry lifecycle replaces overlapping promise/QA setup. Seed registries
// directly: grant mutation has its own suite; doctor must grade the saved state.
const homes = [];
function freshHome() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "doctor-home-")));
  homes.push(home);
  return home;
}
test.after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

function registryFixture(t) {
  const base = freshHome(), home = join(base, "state"), registry = emptyRegistry();
  mkdirSync(home);
  const repo = (name, contents = JSON.stringify({ v: 0, api: { name }, operations: {} })) => {
    const root = join(base, name); mkdirSync(root);
    if (contents !== null) writeFileSync(join(root, CONTEXT_FILE), contents);
    return root;
  };
  const consumer = repo("storefront");
  execFileSync("git", ["init", "-q"], { cwd: consumer });
  const { id } = registerRepo(registry, consumer, { name: "storefront" });
  const env = cleanEnv({ [HOME_ENV_NAME]: home, HOME: base });
  const grant = root => {
    const provider = registerRepo(registry, root).id;
    registry.grants.push({ consumer: id, provider, granted_at: "2026-08-21T00:00:00Z" });
  };
  const persist = () => saveRegistry(registry, { [HOME_ENV_NAME]: home });
  const inspect = async (root = consumer) => {
    const result = await doctor(root, env, "--json");
    const report = JSON.parse(result.stdout);
    assert.equal(report.failed, report.checks.filter(row => row.state === "FAIL").length);
    assert.equal(report.ok, report.failed === 0, "summary must never report green beside a failed check");
    assert.equal(result.code, report.failed ? 1 : 0, result.stdout);
    return report;
  };
  return { home, consumer, registry, env, repo, grant, persist, inspect };
}

test("registry absence, damage and unregistered repos stay distinct and retain actionable diagnostics", async t => {
  const f = registryFixture(t);
  const path = join(f.home, "registry.json");
  const cases = [
    ["absent", undefined, "WARN"],
    ["invalid JSON", "{ not json", "FAIL"],
    ["newer schema", JSON.stringify({ v: 99, repos: {}, grants: [] }), "FAIL"],
    ["grants object", JSON.stringify({ v: 1, repos: {}, grants: {} }), "FAIL"],
    ["null grant", JSON.stringify({ v: 1, repos: {}, grants: [null] }), "FAIL"],
    ["null repo", JSON.stringify({ v: 1, repos: { aa: null }, grants: [] }), "FAIL"],
  ];
  for (const [name, contents, state] of cases) {
    if (contents !== undefined) writeFileSync(path, contents);
    const report = await f.inspect();
    const row = report.checks.find(row => row.name === "registry");
    assert.equal(row.state, state, name);
    assert.match(row.detail, new RegExp(`from ${HOME_ENV_NAME}`), name);
    if (state === "FAIL") assert.ok(row.fix, name);
    assert.ok(report.checks.some(row => row.name === "contract"), "damage must not discard other diagnostics");
    assert.equal(report.checks.some(row => ["grants", "readers"].includes(row.name)), false, name);
  }
  f.persist();
  const unregistered = await f.inspect(f.repo("unregistered", null));
  assert.equal(unregistered.ok, true);
  assert.equal(unregistered.checks.find(row => row.name === "registry").state, "PASS");
  const row = unregistered.checks.find(row => row.name === "grants");
  assert.equal(row.state, "WARN");
  assert.match(row.detail, /not in the machine registry/);
  assert.match(row.detail + row.fix, /connect|grant/);
  assert.equal(unregistered.checks.some(row => row.name === "readers"), false);

  const defaultEnv = { ...f.env }; delete defaultEnv[HOME_ENV_NAME];
  const plain = await doctor(f.consumer, defaultEnv, "--json");
  assert.equal(plain.code, 0, plain.stdout);
  assert.doesNotMatch(JSON.parse(plain.stdout).checks.find(row => row.name === "registry").detail,
    new RegExp(HOME_ENV_NAME), "default location must not be reported as an override");
});

test("registry grant lifecycle reports every failure beside healthy providers and never hides an all-dead estate", async t => {
  const f = registryFixture(t);
  const healthy = ["alpha-api", "beta-api", "gamma-api", "delta-api", "epsilon-api"].map(name => f.repo(name));
  for (const root of healthy) f.grant(root);
  f.persist();
  const first = await doctor(f.consumer, f.env);
  assert.equal(first.code, 0, first.stdout);
  assert.match(first.stdout, /PASS\s+registry.*6 repos, 5 grants/);
  assert.match(first.stdout, /PASS\s+grants.*alpha-api, beta-api, gamma-api, delta-api, epsilon-api/);

  const bad = [
    ["missing-file", null, /has no/], ["broken-json", "{ nope", /does not parse/],
    ...["0", "null", "5", '"hi"', '{"v":0,"api":{}}'].map((body, index) =>
      [`bad-shape-${index}`, body, /unusable shape/]),
  ];
  for (const [name, contents] of bad) f.grant(f.repo(name, contents));
  const vanished = f.repo("vanished-api"); f.grant(vanished); rmSync(vanished, { recursive: true });
  f.registry.grants.push({ consumer: f.registry.grants[0].consumer, provider: "dangling-id", granted_at: "x" });
  f.persist();
  const mixed = await f.inspect();
  const grants = mixed.checks.filter(row => row.name === "grants");
  assert.equal(grants.length, bad.length + 3, "all failures plus one healthy summary survive repeated row names");
  assert.equal(mixed.failed, bad.length + 2);
  assert.equal(grants.filter(row => row.state === "PASS").length, 1);
  for (const [name, , reason] of [...bad, ["vanished-api", null, /no longer exists/], ["dangling-id", null, /dangling grant/]]) {
    const row = grants.find(row => row.state === "FAIL" && row.detail.includes(name));
    assert.ok(row?.fix, name); assert.match(row.detail, reason, name);
  }
  for (const root of healthy) rmSync(root, { recursive: true });
  const dead = await f.inspect();
  assert.equal(dead.checks.some(row => row.name === "grants" && row.state === "PASS"), false);
  assert.equal(dead.failed, f.registry.grants.length);
  assert.ok(dead.checks.some(row => row.name === "readers"));
});

test("providers retain recorded reader identities after consumers disappear", async t => {
  const f = registryFixture(t), provider = f.repo("billing-api");
  f.grant(provider); f.persist();
  rmSync(f.consumer, { recursive: true });
  const report = await f.inspect(provider);
  assert.equal(report.ok, true);
  assert.match(report.checks.find(row => row.name === "readers").detail, /storefront/);
});

test("unknown registry fields survive a real CLI mutation and remain readable by doctor", async t => {
  const f = registryFixture(t), provider = f.repo("billing-api");
  f.registry.future_top_level = { anything: true };
  const consumerId = Object.keys(f.registry.repos)[0];
  f.registry.repos[consumerId].future_repo_key = "kept";
  f.grant(provider); f.registry.grants[0].future_grant_key = 7; f.persist();
  assert.equal(loadRegistry({ [HOME_ENV_NAME]: f.home }).problem, undefined);
  const other = f.repo("other-api");
  const result = await pexec(process.execPath, [CLI, "grant", other], { cwd: f.consumer, env: f.env });
  assert.ok(result.stdout);
  const after = JSON.parse(readFileSync(join(f.home, "registry.json"), "utf8"));
  assert.deepEqual(after.future_top_level, { anything: true });
  assert.equal(after.repos[consumerId].future_repo_key, "kept");
  assert.equal(after.grants[0].future_grant_key, 7);
  assert.equal(after.grants.length, 2);
  assert.equal((await f.inspect()).ok, true);
});

test("a bad base URL is caught, reported as failing, and each failure carries a remedy", async () => {
  const dir = sandbox();
  // Port 1 refuses; the reachability check must FAIL and exit non-zero.
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:1", auth: "header:X-API-Key:LOCAL_KEY" } },
  }));
  const { code, stdout } = await doctor(dir, cleanEnv({ LOCAL_KEY: "present" }));
  assert.notEqual(code, 0, `a broken base URL must exit non-zero\n${stdout}`);
  assert.match(stdout, /\bFAIL\b/);
  assert.match(stdout, /reach|connect|refuse|timeout|econn/i);
  assert.match(stdout, /FAIL\s+base-url/);
  // A failing check without a fix is useless. Every FAIL line must be followed
  // by a remedy the reader can act on.
  assert.match(stdout, /fix:|remedy|try|set |check /i, `no remedy offered:\n${stdout}`);
  rmSync(dir, { recursive: true, force: true });
});

test("a missing auth env var is caught with the variable named and a remedy", async () => {
  const srv = await up();
  const dir = sandbox();
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local",
    environments: { local: { baseUrl: srv.origin, auth: "header:X-API-Key:MISSING_KEY" } },
  }));
  try {
    // MISSING_KEY is deliberately not in the environment.
    const { code, stdout } = await doctor(dir, cleanEnv());
    assert.notEqual(code, 0, `a missing auth var must exit non-zero\n${stdout}`);
    assert.match(stdout, /MISSING_KEY/, "the doctor must name the missing variable");
    assert.match(stdout, /\bFAIL\b/);
    assert.match(stdout, /export|set /i, "must tell the reader how to set it");
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// Missing contracts are optional for installation, regardless of API surfaces.
for (const shape of ["consumer", "service", "monorepo"]) {
  test(`a ${shape} without a selected contract warns and exits 0`, async t => {
    const dir = mkdtempSync(join(tmpdir(), "doctor-no-contract-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const src = join(dir, shape === "monorepo" ? "packages/api/src" : "src");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "fixture", private: true, workspaces: ["packages/*"], dependencies: { express: "^4" },
    }));
    writeFileSync(join(src, "app.js"), shape === "consumer"
      ? 'await fetch("https://api.example.test/orders");\n'
      : 'const app = express();\napp.get("/orders", h);\napp.post("/orders", h);\n');
    const { code, stdout } = await doctor(dir, cleanEnv());
    assert.equal(code, 0, stdout);
    assert.match(stdout, /WARN\s+contract/);
    assert.match(stdout, /map/);
    assert.doesNotMatch(stdout, /serves no API/);
    const json = await doctor(dir, cleanEnv(), "--json");
    assert.equal(json.code, 0, json.stdout);
    assert.equal(JSON.parse(json.stdout).checks.find(c => c.name === "contract").state, "WARN");
  });
}

for (const [label, contents, state] of [
  ["malformed JSON", '{"openapi":', "FAIL"],
  ["non-contract mapping", '{"name":"hello"}', "FAIL"],
  ["array instead of document", '[]', "FAIL"],
  ["invalid paths", '{"openapi":"3.0.3","paths":[]}', "FAIL"],
  ["empty valid paths", '{"openapi":"3.0.3","info":{"title":"empty","version":"1"},"paths":{}}', "PASS"],
  ["Swagger", '{"swagger":"2.0","info":{"title":"legacy","version":"1"},"paths":{}}', "PASS"],
  ["components only", '{"openapi":"3.1.0","info":{"title":"schemas","version":"1"},"components":{}}', "PASS"],
  ["webhooks only", '{"openapi":"3.1.0","info":{"title":"hooks","version":"1"},"webhooks":{}}', "PASS"],
]) {
  test(`doctor grades ${label} without claiming schema or API validation`, async t => {
    const dir = sandbox();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "openapi.json"), contents);
    const { code, stdout } = await doctor(dir, cleanEnv(), "--json");
    const contract = JSON.parse(stdout).checks.find(c => c.name === "contract");
    assert.equal(contract.state, state, stdout);
    assert.equal(code, state === "FAIL" ? 1 : 0, stdout);
    if (state === "PASS") assert.match(contract.detail, /not verified/);
    else assert.ok(contract.fix);
  });
}

test("an explicit missing contract does not fall back to a valid conventional file", async t => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { code, stdout } = await doctor(dir, cleanEnv({ API_CONTRACT: "missing.yaml" }), "--json");
  assert.equal(code, 1, stdout);
  const contract = JSON.parse(stdout).checks.find(c => c.name === "contract");
  assert.equal(contract.state, "FAIL");
  assert.match(contract.detail, /selected.*missing/);
});

test("a directory named as an OpenAPI document fails without crashing doctor", async t => {
  const dir = sandbox();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "openapi.json"));
  const { code, stdout } = await doctor(dir, cleanEnv(), "--json");
  assert.equal(code, 1, stdout);
  const contract = JSON.parse(stdout).checks.find(c => c.name === "contract");
  assert.equal(contract.state, "FAIL");
  assert.match(contract.detail, /regular file/);
});

test("offline doctor never treats the built-in localhost fallback as a probe", async () => {
  // The built-in fallback is http://127.0.0.1:8000. On a developer machine
  // something is very often listening there, so a stranger who has configured
  // NOTHING got `PASS base-url … reachable` — a green check for a coincidence,
  // about an API that is not theirs. The opposite is just as bad: a red
  // `cannot reach http://127.0.0.1:8000` names a URL they never chose and
  // sends them looking for a server they never started.
  //
  // Either way the honest report is the same: nobody has said which API this
  // is yet, and here is where you say it.
  // A listener ON THE FALLBACK PORT, so the coincidence this test is about is
  // actually present rather than assumed: without it the check would go red
  // and the assertion would pass for the wrong reason.
  const srv = await upOn(8000);
  const dir = mkdtempSync(join(tmpdir(), "doctor-nobase-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  try {
    const { stdout } = await doctor(dir, cleanEnv());   // nothing configured at all
    const line = stdout.split("\n").find((l) => /^\s*(PASS|WARN|FAIL) base-url\b/.test(l)) ?? "";
    assert.match(line, /^\s*WARN/);
    assert.match(line, /--offline/);
    assert.doesNotMatch(line, /reachable|127\.0\.0\.1/);
    assert.match(stdout, /no API requests were sent/);
  } finally { srv.close(); rmSync(dir, { recursive: true, force: true }); }
});

// H5 walk, 2026-11-01: on a fresh repository the config row told a stranger to
// add the single-store environments file; following it made `stack add` refuse
// with STACKS_MIGRATION_REQUIRED. A fresh repository's next step is a stack.
test("a fresh repository's doctor points at stack add, never at the single-store config files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "doctor-fresh-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  try {
    const { code, stdout } = await doctor(dir, cleanEnv(), "--offline", "--json");
    assert.equal(code, 0, stdout);
    const rows = JSON.parse(stdout).checks;
    const config = rows.find(row => row.name === "config");
    const contract = rows.find(row => row.name === "contract");
    assert.equal(config.state, "WARN");
    assert.match(config.fix, / stack add <name> --base-url <url>/);
    assert.ok(!`${config.detail} ${config.fix}`.includes(LAYOUT.environments), config.fix);
    assert.ok(!contract.fix.includes("API_CONTRACT"), contract.fix);
    assert.match(contract.fix, /--contract <path>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
