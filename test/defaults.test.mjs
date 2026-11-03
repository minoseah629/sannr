import { LAYOUT } from "../lib/layout.mjs";
// Client defaults from a project config file, with a three-level precedence:
// an explicit environment variable beats the config file's `defaults` block
// beats the built-in. The point is that a stranger who has exported nothing
// still gets sane project defaults from a file they can read, while every
// existing env-only setup keeps working unchanged because its env vars still win.
//
//   node --test test/defaults.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync,  rmSync, mkdirSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { resolveConfig, resolveDefaults, BUILTIN_DEFAULTS } from "../lib/config.mjs";
import { staleHorizon } from "../lib/context.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A temp dir carrying a config file, with process.env restored afterwards so
// one test's overrides never leak into the next.
const withConfig = (config, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "defaults-"));
  if (config) writeFileSync(join(dir, LAYOUT.environments), JSON.stringify(config));
  const saved = { ...process.env };
  // Clear the knobs under test so an ambient value in the runner's env cannot
  // mask a config-file default we are asserting on.
  for (const k of ["API_BUDGET", "API_TIMEOUT_MS", "API_CONCURRENCY", "API_EVIDENCE",
                   "API_STALE_DAYS", "API_ENV", "API_BASE_URL", "API_AUTH", "API_CONFIG"]) delete process.env[k];
  try { return fn(dir); }
  finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

const WITH_DEFAULTS = {
  v: 1, default: "local",
  defaults: { budget: 1500, timeoutMs: 12000, concurrency: 4, evidenceDir: "./ev-from-file", staleDays: 45 },
  environments: { local: { baseUrl: "http://127.0.0.1:8787", auth: "header:X-API-Key:LOCAL_KEY" } },
};

test("a config-file default is honored when no env var is set", () => {
  withConfig(WITH_DEFAULTS, (dir) => {
    const c = resolveConfig(dir);
    assert.equal(c.defaults.budget, 1500, "budget must come from the file's defaults block");
    assert.equal(c.defaults.timeoutMs, 12000);
    assert.equal(c.defaults.concurrency, 4);
    assert.equal(c.defaults.evidenceDir, "./ev-from-file");
    assert.equal(c.defaults.staleDays, 45);
  });
});

test("an explicit env var overrides the config-file default", () => {
  withConfig(WITH_DEFAULTS, (dir) => {
    process.env.API_BUDGET = "999";
    process.env.API_EVIDENCE = "./ev-from-env";
    process.env.API_STALE_DAYS = "7";
    const c = resolveConfig(dir);
    assert.equal(c.defaults.budget, 999, "env var must beat the file");
    assert.equal(c.defaults.evidenceDir, "./ev-from-env");
    assert.equal(c.defaults.staleDays, 7);
    // Untouched knobs still come from the file.
    assert.equal(c.defaults.timeoutMs, 12000);
  });
});

test("the built-in applies when neither env var nor config file speaks", () => {
  withConfig({ v: 1, default: "local", environments: { local: { baseUrl: "http://x:1" } } }, (dir) => {
    const c = resolveConfig(dir);
    assert.equal(c.defaults.budget, BUILTIN_DEFAULTS.budget);
    assert.equal(c.defaults.timeoutMs, BUILTIN_DEFAULTS.timeoutMs);
    assert.equal(c.defaults.evidenceDir, BUILTIN_DEFAULTS.evidenceDir);
    assert.equal(c.defaults.staleDays, BUILTIN_DEFAULTS.staleDays);
  });
});

test("a per-environment concurrency beats the top-level defaults block", () => {
  withConfig({
    v: 1, default: "local",
    defaults: { concurrency: 2 },
    environments: { local: { baseUrl: "http://x:1", concurrency: 6 } },
  }, (dir) => {
    const c = resolveConfig(dir);
    assert.equal(c.defaults.concurrency, 6, "the environment is more specific than the top-level default");
    assert.equal(c.concurrency, 6, "the legacy concurrency field agrees");
  });
});

test("a junk config-file default falls THROUGH to the built-in, never poisons the client", () => {
  withConfig({
    v: 1, default: "local",
    defaults: { budget: "lots", timeoutMs: -5, staleDays: 0 },
    environments: { local: { baseUrl: "http://x:1" } },
  }, (dir) => {
    const c = resolveConfig(dir);
    assert.equal(c.defaults.budget, BUILTIN_DEFAULTS.budget, "non-numeric budget must not become NaN");
    assert.equal(c.defaults.timeoutMs, BUILTIN_DEFAULTS.timeoutMs, "a negative timeout is not honored");
    assert.equal(c.defaults.staleDays, BUILTIN_DEFAULTS.staleDays, "zero days is not a horizon");
  });
});

test("resolveDefaults is a pure precedence function over a defaults block", () => {
  const saved = process.env.API_BUDGET;
  delete process.env.API_BUDGET;
  try {
    assert.equal(resolveDefaults({ budget: 1234 }).budget, 1234);
    process.env.API_BUDGET = "77";
    assert.equal(resolveDefaults({ budget: 1234 }).budget, 77, "env wins");
  } finally { if (saved === undefined) delete process.env.API_BUDGET; else process.env.API_BUDGET = saved; }
});

// --- staleHorizon (context.mjs) reads the same config-file default ----------
test("the staleness horizon honors the config file, and an env var overrides it", () => {
  withConfig(WITH_DEFAULTS, (dir) => {
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(staleHorizon(), 45, "stale-days must come from the config file's defaults");
      process.env.API_STALE_DAYS = "10";
      assert.equal(staleHorizon(), 10, "env var beats the file");
    } finally { process.chdir(cwd); }
  });
});

// --- end-to-end: the CLIENT actually consumes the resolved default ---------
// The unit tests above prove resolveConfig computes the value; this proves the
// client module reads it at load, so a config-only user's evidence lands where
// the file says and an env var still relocates it.
test("the client's EVIDENCE path reflects the config file, and API_EVIDENCE overrides it", () => {
  const dir = mkdtempSync(join(tmpdir(), "defaults-client-"));
  mkdirSync(join(dir, "proj"));
  writeFileSync(join(dir, "proj", LAYOUT.environments), JSON.stringify({
    v: 1, default: "local",
    defaults: { evidenceDir: "./from-config" },
    environments: { local: { baseUrl: "http://127.0.0.1:1" } },
  }));
  const probe = "import(process.env.CLIENT).then(m => console.log(m.EVIDENCE))";
  // Build a clean env: the knobs under test are DELETED, not blanked, so the
  // child sees exactly what the config-only vs env-override cases intend.
  const run = (evidence) => {
    const env = { ...process.env, CLIENT: join(ROOT, "lib", "client.mjs") };
    delete env.API_BUDGET;
    if (evidence === undefined) delete env.API_EVIDENCE; else env.API_EVIDENCE = evidence;
    return execFileSync("node", ["-e", probe], { cwd: join(dir, "proj"), encoding: "utf8", env }).trim();
  };
  try {
    const fromConfig = run(undefined);
    assert.ok(fromConfig.endsWith("/from-config"), `config evidenceDir not consumed: ${fromConfig}`);
    const fromEnv = run("./from-env");
    assert.ok(fromEnv.endsWith("/from-env"), `env API_EVIDENCE did not override: ${fromEnv}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
