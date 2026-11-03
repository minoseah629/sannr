import { LAYOUT } from "../lib/layout.mjs";
// Unit tests for named environments. node --test test/config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,  rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfig, productionGuard, loadEnvFile } from "../lib/config.mjs";

const withConfig = (config, fn) => {
  const dir = mkdtempSync(join(tmpdir(), "apienv-"));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify(config));
  const saved = { ...process.env };
  try { return fn(dir); }
  finally {
    rmSync(dir, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
};

const BASIC = {
  v: 1, default: "local",
  environments: {
    local: { baseUrl: "http://127.0.0.1:8787", auth: "header:X-API-Key:LOCAL_KEY",
             variables: { orgId: "1" }, concurrency: 3 },
    staging: { baseUrl: "https://staging.example.com", auth: "bearer:STAGING_TOKEN" },
    prod: { baseUrl: "https://api.example.com", auth: "bearer:PROD_TOKEN", production: true },
  },
};

test("the default environment is used when none is requested", () => {
  withConfig(BASIC, (dir) => {
    delete process.env.API_ENV; delete process.env.API_BASE_URL; delete process.env.API_AUTH;
    const c = resolveConfig(dir);
    assert.equal(c.name, "local");
    assert.equal(c.baseUrl, "http://127.0.0.1:8787");
    assert.equal(c.concurrency, 3);
    assert.deepEqual(c.variables, { orgId: "1" });
  });
});

test("API_ENV selects a different environment", () => {
  withConfig(BASIC, (dir) => {
    delete process.env.API_BASE_URL; delete process.env.API_AUTH;
    process.env.API_ENV = "staging";
    const c = resolveConfig(dir);
    assert.equal(c.name, "staging");
    assert.equal(c.baseUrl, "https://staging.example.com");
    assert.equal(c.auth, "bearer:STAGING_TOKEN");
  });
});

test("an explicit requested environment outranks API_ENV and reports URL override provenance", () => {
  withConfig(BASIC, (dir) => {
    process.env.API_ENV = "local";
    process.env.API_BASE_URL = "http://override.local";
    const c = resolveConfig(dir, { environment: "staging" });
    assert.equal(c.name, "staging");
    assert.equal(c.baseUrl, "http://override.local");
    assert.equal(c.baseUrlOverride, true);
  });
});

test("an explicit environment without a config is a named refusal", () => {
  const dir = mkdtempSync(join(tmpdir(), "apienv-explicit-empty-"));
  try {
    delete process.env.API_CONFIG;
    const c = resolveConfig(dir, { environment: "tunnel" });
    assert.equal(c.problems[0]?.code, "ENVIRONMENT_CONFIG_REQUIRED");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("explicit environment variables override the config file", () => {
  withConfig(BASIC, (dir) => {
    process.env.API_ENV = "staging";
    process.env.API_BASE_URL = "http://override.local";
    const c = resolveConfig(dir);
    assert.equal(c.baseUrl, "http://override.local", "env var must win over the file");
  });
});

test("an unknown environment is a named problem, not a silent default", () => {
  withConfig(BASIC, (dir) => {
    process.env.API_ENV = "nope";
    const c = resolveConfig(dir);
    assert.equal(c.name, null);
    const p = c.problems.find((x) => x.code === "ENVIRONMENT_NOT_FOUND");
    assert.ok(p, "expected ENVIRONMENT_NOT_FOUND");
    assert.deepEqual(p.details.available, ["local", "staging", "prod"]);
  });
});

test("malformed config reports invalid JSON rather than throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "apienv-"));
  writeFileSync(join(dir, LAYOUT.environments), "{ not json");
  try {
    delete process.env.API_ENV;
    const c = resolveConfig(dir);
    assert.equal(c.problems[0].code, "CONFIG_INVALID");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no config file at all still yields a usable default", () => {
  const dir = mkdtempSync(join(tmpdir(), "apienv-empty-"));
  const saved = process.env.API_BASE_URL;
  try {
    delete process.env.API_ENV; delete process.env.API_BASE_URL; delete process.env.API_CONFIG;
    const c = resolveConfig(dir);
    assert.equal(c.name, null);
    assert.equal(c.baseUrl, "http://127.0.0.1:8000");
    assert.deepEqual(c.problems, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (saved !== undefined) process.env.API_BASE_URL = saved;
  }
});

test("production refuses writes but permits reads", () => {
  const prod = { name: "prod", production: true, baseUrl: "https://api.example.com" };
  assert.equal(productionGuard(prod, "GET"), null);
  assert.equal(productionGuard(prod, "HEAD"), null);
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    const g = productionGuard(prod, m);
    assert.ok(g, `${m} should be refused`);
    assert.equal(g.code, "PRODUCTION_WRITE_REFUSED");
    assert.match(g.next, /API_ALLOW_PRODUCTION_WRITES/);
  }
});

test("an explicit override unlocks production writes", () => {
  const saved = process.env.API_ALLOW_PRODUCTION_WRITES;
  process.env.API_ALLOW_PRODUCTION_WRITES = "1";
  try {
    assert.equal(productionGuard({ name: "prod", production: true }, "POST"), null);
  } finally {
    if (saved === undefined) delete process.env.API_ALLOW_PRODUCTION_WRITES;
    else process.env.API_ALLOW_PRODUCTION_WRITES = saved;
  }
});

test("a non-production environment is never guarded", () => {
  assert.equal(productionGuard({ name: "local", production: false }, "DELETE"), null);
});

test("envFile populates a variable but never overwrites an existing one", () => {
  const dir = mkdtempSync(join(tmpdir(), "apienv-secret-"));
  const f = join(dir, "creds.env");
  writeFileSync(f, 'export FROM_FILE=file-value\nALREADY_SET="should not win"\n# comment\n');
  const saved = process.env.ALREADY_SET;
  try {
    process.env.ALREADY_SET = "env-wins";
    delete process.env.FROM_FILE;
    loadEnvFile(f);
    assert.equal(process.env.FROM_FILE, "file-value");
    assert.equal(process.env.ALREADY_SET, "env-wins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.FROM_FILE;
    if (saved === undefined) delete process.env.ALREADY_SET; else process.env.ALREADY_SET = saved;
  }
});

// --- per-host auth (F1): the hosts map ------------------------------------
test("hosts are parsed, normalised, and env-level entries win over top-level", () => {
  withConfig({
    v: 1, default: "local",
    hosts: {
      stripe: { baseUrl: "https://api.stripe.com/", auth: "bearer:STRIPE_KEY" },
      clerk: { baseUrl: "https://api.clerk.com", auth: "header:X-API-Key:CLERK_KEY" },
    },
    environments: {
      local: { baseUrl: "http://127.0.0.1:8787",
               // The environment re-declares stripe: ITS credential applies here.
               hosts: { stripe: { baseUrl: "https://api.stripe.com", auth: "bearer:STRIPE_TEST_KEY" } } },
    },
  }, (dir) => {
    delete process.env.API_ENV; delete process.env.API_BASE_URL; delete process.env.API_AUTH;
    const c = resolveConfig(dir);
    assert.equal(c.hosts.stripe.auth, "bearer:STRIPE_TEST_KEY", "the environment's entry must win");
    assert.equal(c.hosts.clerk.auth, "header:X-API-Key:CLERK_KEY", "top-level entries still apply");
    assert.equal(c.hosts.stripe.baseUrl, "https://api.stripe.com",
      "trailing slash is normalised once, here, so both adapters agree on origins");
  });
});

test("a config without hosts yields an empty map, and single auth is untouched", () => {
  withConfig(BASIC, (dir) => {
    delete process.env.API_ENV; delete process.env.API_BASE_URL; delete process.env.API_AUTH;
    const c = resolveConfig(dir);
    assert.deepEqual(c.hosts, {}, "no hosts map means no upstreams, not a crash");
    assert.equal(c.auth, "header:X-API-Key:LOCAL_KEY", "the single-credential path is unchanged");
  });
});

test("upstream contracts resolve beside configuration and do not inherit a different environment's binding", () => {
  withConfig({ v: 1, default: "staging", hosts: {
    billing: { baseUrl: "https://billing.example.test", contract: "contracts/live.json" },
    catalog: { baseUrl: "https://catalog.example.test/v2", contract: "contracts/catalog.yaml", contractPathPrefix: "/v2" },
  }, environments: { staging: { baseUrl: "https://primary.example.test", contract: "primary.json",
    hosts: { billing: { baseUrl: "https://billing-staging.example.test" } } } } }, dir => {
    delete process.env.API_CONFIG; delete process.env.API_ENV;
    process.env.API_CONTRACT = "primary-override.json";
    const config = resolveConfig(dir);
    assert.equal(config.contract, "primary-override.json");
    assert.equal(config.hosts.catalog.contract, join(dir, "contracts/catalog.yaml"));
    assert.equal(config.hosts.catalog.contractPathPrefix, "/v2");
    assert.equal(config.hosts.billing.contract, undefined);
    assert.equal(config.hosts.billing.baseUrl, "https://billing-staging.example.test");
  });
});

// --- adversarial batch (2026-08-14): numeric coercion and prototype keys
test("a non-numeric API_CONCURRENCY falls back to 1, never NaN", () => {
  const saved = process.env.API_CONCURRENCY;
  process.env.API_CONCURRENCY = "abc";
  try {
    const c = resolveConfig();
    assert.equal(c.concurrency, 1, "NaN would silently disable the lane limiter");
    assert.ok(Number.isFinite(c.concurrency));
  } finally { if (saved === undefined) delete process.env.API_CONCURRENCY; else process.env.API_CONCURRENCY = saved; }
});

test("API_ENV=__proto__ is ENVIRONMENT_NOT_FOUND, not a junk prototype env", () => {
  const dir = mkdtempSync(join(tmpdir(), "cfg-proto-"));
  writeFileSync(join(dir, LAYOUT.environments),
    JSON.stringify({ default: "local", environments: { local: { baseUrl: "http://x:1" } } }));
  const saved = process.env.API_ENV; process.env.API_ENV = "__proto__";
  const cwd = process.cwd(); process.chdir(dir);
  try {
    const c = resolveConfig();
    assert.ok(c.problems.some((p) => p.code === "ENVIRONMENT_NOT_FOUND"),
      "a prototype-shaped env name must not resolve to Object.prototype");
  } finally { process.chdir(cwd); if (saved === undefined) delete process.env.API_ENV; else process.env.API_ENV = saved; }
});
