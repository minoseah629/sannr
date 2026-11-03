import { LAYOUT } from "../lib/layout.mjs";
// Setup specimens use disposable projects and execute no API requests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONTEXT_FILE, MAX_CONTEXT_BYTES, emptyContext, readContract, saveContext } from "../lib/context.mjs";
import { HOME_ENV_NAME, CONTEXT_BASENAME } from "../lib/brand.mjs";
import { planSetupContract } from "../lib/setup-contract.mjs";
import { stackCatalog } from "../lib/stacks.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "start-boundary-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, "project"), home = join(base, "home");
  mkdirSync(root); mkdirSync(home);
  execFileSync("git", ["init", "-q"], { cwd: root });
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("API_") || key === HOME_ENV_NAME) delete env[key];
  Object.assign(env, { HOME: home, [HOME_ENV_NAME]: join(home, "registry") });
  return { base, root, env };
}
const contract = (count) => JSON.stringify({ openapi: "3.0.0", info: { title: "Bound fixture", version: "1" },
  paths: Object.fromEntries(Array.from({ length: count }, (_, i) => [`/inventory/collection/items/category/${i}`, { get: {} }])) });
function start(f, ...args) {
  return spawnSync(process.execPath, [join(ROOT, "bin", "cli.mjs"), "start", ...args],
    { cwd: f.root, env: f.env, encoding: "utf8", timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
}

test("AH-2 legacy context writes obey the same byte bound as extended contexts", t => {
  const f = fixture(t);
  const original = emptyContext({ name: "Bound fixture" });
  saveContext(f.root, original);
  const before = readFileSync(join(f.root, CONTEXT_FILE), "utf8");
  const oversized = { ...original, notes: "x".repeat(MAX_CONTEXT_BYTES) };
  assert.throws(() => saveContext(f.root, oversized), { code: "CONTEXT_CAPACITY_REACHED" });
  assert.equal(readFileSync(join(f.root, CONTEXT_FILE), "utf8"), before);
});

test("AH-2 start refuses a near-capacity context before writing any agent wiring", t => {
  const f = fixture(t), path = join(f.root, "openapi.json");
  writeFileSync(path, contract(1));
  const ctx = emptyContext({ name: "Bound fixture", contractPath: "openapi.json",
    contractDigest: readContract(path).digest });
  ctx.fixture_padding = "";
  ctx.fixture_padding = "x".repeat(MAX_CONTEXT_BYTES - 20 - Buffer.byteLength(`${JSON.stringify(ctx, null, 2)}\n`));
  saveContext(f.root, ctx);
  const file = join(f.root, CONTEXT_FILE), before = readFileSync(file);
  assert.equal(before.length, MAX_CONTEXT_BYTES - 20);
  const result = start(f, "--json");
  assert.equal(result.status, 1);
  assert.deepEqual(readFileSync(file), before);
  for (const output of [".mcp.json", ".codex/config.toml", "AGENTS.md", "CLAUDE.md"])
    assert.equal(existsSync(join(f.root, output)), false, `${output} must not be partially installed`);
  const report = JSON.parse(result.stdout);
  assert.equal(report.setup.context.problem.code, "CONTEXT_CAPACITY_REACHED");
  assert.equal(report.setup.wiring.state, "blocked");
});

test("AH-2 static inventory hashes the live contract once for all operation confidence rows", t => {
  const f = fixture(t), path = join(f.root, "openapi.json");
  writeFileSync(path, contract(3));
  const ctx = emptyContext({ name: "Bound fixture", contractPath: "openapi.json" });
  for (let i = 0; i < 3; i++) ctx.operations[`GET /inventory/collection/items/category/${i}`] = { verified_at: null };
  saveContext(f.root, ctx);
  const script = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const read = fs.readFileSync; let reads = 0;
    fs.readFileSync = function (...args) {
      if (new Error().stack.includes('liveContractDigest')) reads += 1;
      return read.apply(this, args);
    };
    syncBuiltinESMExports();
    const { buildMapModel } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "lib/map.mjs")).href)});
    await buildMapModel(${JSON.stringify(f.root)}, { execute: false });
    console.log(reads);`;
  const count = execFileSync(process.execPath, ["--input-type=module", "--eval", script],
    { cwd: f.root, env: f.env, encoding: "utf8" }).trim();
  assert.equal(Number(count), 1);
});

test("AH-2 start bounds 70000 operation context and completes within 30 seconds", t => {
  const f = fixture(t);
  writeFileSync(join(f.root, "openapi.json"), contract(70_000));
  const began = performance.now();
  const result = start(f);
  const elapsed = performance.now() - began;
  // STACKS-1A fresh setup stores the same bounded inventory in its first stack.
  const selected = stackCatalog(f.root).stacks[0];
  const file = selected ? join(selected.folder, CONTEXT_BASENAME) : join(f.root, CONTEXT_FILE);
  const bytes = existsSync(file) ? statSync(file).size : 0;
  t.diagnostic(`70000-operation start: ${(elapsed / 1000).toFixed(3)} seconds; context ${bytes} bytes; bound 30 seconds / ${MAX_CONTEXT_BYTES} bytes`);
  assert.equal(result.error, undefined, "start must complete before its 30 second wall-clock bound");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(bytes <= MAX_CONTEXT_BYTES, `context exceeds storage bound: ${bytes}`);
  const ctx = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of Object.values(ctx.operations)) {
    assert.equal(entry.note_integrity?.v, 1, "capacity planning must include each empty note-history baseline");
    assert.match(entry.note_integrity.digest, /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(ctx.inventory.contract_operations, 70_000);
  assert.equal(ctx.inventory.retained_operations + ctx.inventory.omitted_operations, 70_000);
  assert.ok(ctx.inventory.omitted_operations > 0);
  assert.match(result.stdout, /70000 operations/);
  assert.match(result.stdout, /omitted.*storage limit/);
});

test("AH-2 start names an outside symlink contract while the static inventory still counts its operations", t => {
  const f = fixture(t), target = join(f.base, "outside.json");
  writeFileSync(target, contract(2));
  symlinkSync(target, join(f.root, "openapi.json"));
  const result = start(f);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Static API inventory:.*2 operations/);
  assert.match(result.stdout, /CONTRACT_SYMLINK_OUTSIDE_PROJECT.*openapi\.json/);
  assert.doesNotMatch(result.stdout, /no OpenAPI contract found/i);
  assert.equal(existsSync(join(f.root, CONTEXT_FILE)), false);
  const json = start(f, "--json");
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.deepEqual(report.setup.context.omissions, [{ code: "CONTRACT_SYMLINK_OUTSIDE_PROJECT", file: "openapi.json" }]);
  assert.equal(report.inventory.summary.operations, 2);
});

test("AH-2 outside prior contract paths are omitted without claiming a symbolic link", t => {
  const f = fixture(t);
  writeFileSync(join(f.base, "outside.json"), contract(1));
  const plan = planSetupContract(f.root, { name: "local", baseUrlSource: "config",
    file: join(f.root, LAYOUT.environments) }, { env: {}, contextContract: "../outside.json" });
  assert.equal(plan.contract, null);
  assert.deepEqual(plan.report.omissions, [{ code: "CONTRACT_OUTSIDE_PROJECT", file: "outside.json" }]);
});
