import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planSetupContract } from "../lib/setup-contract.mjs";
import { projectEntry } from "../lib/connect.mjs";
import { setupBindingId } from "../lib/setup-binding.mjs";

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setup-contract-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = { v: 1, default: "prod", defaults: { evidenceDir: "private-evidence" },
    environments: { local: { baseUrl: "http://127.0.0.1:9101", variables: { org: "example" } },
      prod: { baseUrl: "https://api.example.test", production: true, contract: "prod.json" } },
    hosts: { vendor: { baseUrl: "https://vendor.example.test", contract: "vendor.json" } },
    extra: { preserve: true } };
  const file = join(root, LAYOUT.environments);
  writeFileSync(file, JSON.stringify(original));
  const contract = join(root, "openapi.json");
  writeFileSync(contract, '{"openapi":"3.0.0","paths":{"/health":{"get":{}}}}');
  const cfg = { name: "local", file, baseUrlSource: "config", baseUrl: original.environments.local.baseUrl,
    hosts: { vendor: { ...original.hosts.vendor, contract: join(root, "vendor.json") } } };
  return { root, file, original, contract, cfg };
}

test("setup plans one portable environment contract without changing other configuration, and hashes post-write bytes", t => {
  const { root, file, original, contract, cfg } = fixture(t);
  const before = readFileSync(file, "utf8");
  const plan = planSetupContract(root, cfg, { env: {} });
  assert.equal(plan.contract, contract);
  assert.equal(plan.report.action, "bind");
  assert.equal(readFileSync(file, "utf8"), before, "planning is read-only");
  assert.deepEqual(JSON.parse(plan.text), { ...original, environments: { ...original.environments,
    local: { ...original.environments.local, contract: "openapi.json" } } });
  const entry = projectEntry(root, { ...cfg, contract: plan.contract }, { env: {}, configText: plan.text });
  assert.equal(entry.env.API_ENV, "local");
  assert.notEqual(setupBindingId(root, entry), entry.env.API_SETUP_BINDING);
  writeFileSync(file, plan.text);
  assert.equal(setupBindingId(root, entry), entry.env.API_SETUP_BINDING,
    "the generated binding describes the exact config setup materializes");
});

test("shell overrides remain invocation-local and URL overrides cannot inherit the old contract", t => {
  const { root, file, contract, cfg } = fixture(t);
  const before = readFileSync(file, "utf8");
  const override = planSetupContract(root, cfg, { env: { API_CONTRACT: "chosen.json" } });
  assert.equal(override.contract, join(root, "chosen.json"));
  assert.equal(override.text, undefined);
  const disabled = planSetupContract(root, cfg, { env: { API_CONTRACT: "" } });
  assert.equal(disabled.contract, "");
  assert.equal(projectEntry(root, { ...cfg, contract: disabled.contract }, { env: {} }).env.API_CONTRACT, "");
  const target = { ...cfg, baseUrlOverride: true, baseUrlSource: "env", contract,
    baseUrl: "https://another.example.test" };
  const moved = planSetupContract(root, target, { env: {} });
  assert.equal(moved.contract, null);
  assert.equal(moved.text, undefined);
  const entry = projectEntry(root, { ...target, contract: moved.contract }, { env: {} });
  assert.equal(entry.env.API_BASE_URL, target.baseUrl);
  assert.equal(entry.env.API_CONTRACT, undefined);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("fallback, external config, and a named provider's contract do not become primary bindings", t => {
  const { root, contract, cfg } = fixture(t);
  const offline = planSetupContract(root, { ...cfg, baseUrlSource: "fallback" }, { env: {} });
  assert.equal(offline.contract, contract, "offline inventory keeps one selected document");
  assert.equal(offline.file, undefined, "fallback discovery never persists a provider binding");
  assert.equal(offline.text, undefined);
  for (const candidate of [
    { ...cfg, file: join(root, "..", "shared-config.json") },
    { ...cfg, hosts: { vendor: { contract } } },
  ]) {
    const plan = planSetupContract(root, candidate, { env: {} });
    assert.equal(plan.contract, null);
    assert.equal(plan.text, undefined);
  }
});

test("ambiguous discovery is not resolved by an old unscoped inventory pointer; explicit bindings remain authoritative", t => {
  const { root, contract, cfg } = fixture(t);
  writeFileSync(join(root, "openapi.yaml"), "openapi: 3.0.0\npaths: {}\n");
  const ambiguous = planSetupContract(root, cfg, { env: {}, contextContract: "openapi.json" });
  assert.equal(ambiguous.error.code, "CONTRACT_DISCOVERY_AMBIGUOUS");
  assert.equal(ambiguous.text, undefined);
  assert.equal(planSetupContract(root, { ...cfg, contract }, { env: {} }).contract, contract);
});

test("an explicit empty or null contract declaration is preserved", t => {
  const { root, file, original, cfg } = fixture(t);
  for (const contract of ["", null]) {
    original.environments.local.contract = contract;
    writeFileSync(file, JSON.stringify(original));
    const plan = planSetupContract(root, cfg, { env: {} });
    assert.equal(plan.contract, null);
    assert.equal(plan.text, undefined);
  }
});
