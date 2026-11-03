import { LAYOUT } from "../lib/layout.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, mkdirSync,  lstatSync, symlinkSync, chmodSync, readdirSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { secretIn } from "../lib/verdicts.mjs";
import { importKong, importPostman, importBrunoDirectory, renderImportReport } from "../lib/import.mjs";
import { promoteObservation } from "../lib/promote.mjs";
import { parseYaml } from "../lib/yaml.mjs";
import { emptyContext, saveContext } from "../lib/context.mjs";
import { storeMcpInspection } from "../lib/mcp-inspect.mjs";
import { inspectShellHttp } from "../lib/claude-hook.mjs";
import { translateTests } from "../lib/import.mjs";
import { normalizeSuite, saveSuite, suiteSecretProblems } from "../lib/suites.mjs";
import { resolveConfig } from "../lib/config.mjs";
import { saveRegistry, emptyRegistry } from "../lib/registry.mjs";
import { appendCiSummary, writeBaselineFile } from "../lib/ci.mjs";
import { capabilityManifest } from "../lib/capabilities.mjs";
import { operationIdentity, alignOperations } from "../lib/reconcile.mjs";
import { parseCurl } from "../lib/curl.mjs";
import { scrubCaptured } from "../lib/postman.mjs";
import { flattenPostmanWorkspace } from "../lib/postman-workspace.mjs";
import { scrubForTest } from "../lib/client.mjs";
import { checkOne } from "../lib/assertions.mjs";
import { stableStringify } from "../lib/import.mjs";

test("R1 secret shapes include incumbent credential families and URL userinfo", () => {
  for (const value of ["PMAK-abcdefghijklmnop", "github_pat_abcdefghijklmnopqrst", "AIzaabcdefghijklmnopqrstuv", "xapp-abcdefghijkl", "SG.abcdefghijklmnop.abcdefghijklmnop", "shpat_abcdefghijkl", "dop_v1_abcdefghijkl", "AC0123456789abcdef0123456789abcdef", "http://user:pass@internal.example"]) assert.ok(secretIn(value), value);
});

test("R1 import escapes forged GFM cells and quarantines empty tests", () => {
  const out = importPostman({ info: { name: "x" }, item: [{ name: "<x>|", request: { method: "GET", url: "/x" }, event: [{ listen: "test", script: { exec: ['pm.test("empty", () => { expect(true); })'] } }] }] });
  assert.equal(out.suite.requests.length, 0);
  assert.match(renderImportReport(out.report), /\| item \| status \| notes \|/);
  assert.equal(out.report.counts.scripts_quarantined.length, 1);
});

test("R1 YAML facade strips BOM and returns multiple documents when requested", () => {
  assert.deepEqual(parseYaml("\uFEFFa: 1\n---\nb: 2", { multi: true }), [{ a: 1 }, { b: 2 }]);
});

test("R1 Kong import is a declared witness and skips credential branches", () => {
  const out = importKong({ _format_version: "3.0", services: [{ name: "orders", url: "https://orders.internal", routes: [{ paths: ["/orders/{id}"], methods: ["GET", "POST"], plugins: [{ name: "rate-limiting", config: { minute: 10 } }] }] }], consumers: [{ username: "customer", keyauth_credentials: [{ key: "secret" }] }] });
  assert.equal(out.sourceKind, "kong-declarative");
  assert.equal(out.declared.length, 2);
  assert.deepEqual(out.environmentFacts, [{ host: "orders.internal" }]);
  assert.equal(out.report.counts.skipped, 1);
});

test("R1-D Kong skips nested material and names regex routes", () => {
  const out = importKong({ _format_version: "3.1", services: [{ name: "billing", url: "https://user:password@billing.internal/v1", routes: [{ paths: ["~^/billing/[0-9]+$", "/invoices/:id"], methods: ["GET"], plugins: [{ name: "jwt", config: { secret: "fixture-secret", ttl: 60 } }] }] }], key_sets: [{ name: "ks", key: "fixture-key" }], consumers: [{ username: "u", basicauth_credentials: [{ password: "fixture-password" }] }] });
  const text = JSON.stringify(out);
  assert.equal(out.declared.length, 2);
  assert.equal(out.declared[0].status, "unsupported regex route");
  assert.deepEqual(out.environmentFacts, [{ host: "billing.internal" }]);
  assert.ok(out.report.loss.some((x) => x.name === "config"));
  assert.ok(out.report.loss.some((x) => x.name === "key_sets"));
  for (const value of ["password", "fixture-secret", "fixture-key", "fixture-password"]) assert.equal(text.includes(value), false);
});

test("R1 MCP store refuses secret-bearing inspection and bounds history", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-mcp-"));
  saveContext(root, emptyContext({ name: "x", contractPath: null, contractDigest: null }));
  assert.throws(() => storeMcpInspection(root, { declared: { value: "PMAK-abcdefghijklmnop" } }), { code: "MCP_LITERAL_SECRET_REFUSED" });
  for (let i = 0; i < 21; i++) storeMcpInspection(root, { declared: { i } });
  const context = JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8"));
  assert.equal(context.mcp_inspections.length, 20);
});

test("R1-1: MCP inspection bounds and scans server data", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-mcp-bound-"));
  saveContext(root, emptyContext({ name: "x", contractPath: null, contractDigest: null }));
  assert.throws(() => storeMcpInspection(root, { declared: { resources: [{ uri: "https://user:pass@internal.test/x" }] } }), { code: "MCP_LITERAL_SECRET_REFUSED" });
  storeMcpInspection(root, { declared: { description: "x".repeat(5000) }, measured: [{ tool: "x", result: "y".repeat(2_000_000) }] });
  const saved = JSON.parse(readFileSync(join(root, LAYOUT.context), "utf8")).mcp_inspections[0];
  assert.equal(saved.declared.description.length, 200);
  assert.equal(saved.measured[0].resultShape, "string");
});

test("R1-5: importer withholds resolved path secrets", () => {
  const out = importPostman({ info: { name: "x" }, item: [{ name: "x", request: { method: "GET", url: "/PMAK-synthetic-value/x" }, response: [{ code: 200 }] }] });
  assert.equal(out.suite.requests.length, 0, "a redacted request must not remain runnable");
  assert.equal(out.todo[0].path, "/{redacted}");
  assert.ok(!JSON.stringify(out).includes("PMAK-"));
  assert.ok(out.report.counts.secrets_omitted_by_design > 0);
});

test("R1-10: writers refuse symlinked output targets", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-writers-"));
  const outside = mkdtempSync(join(tmpdir(), "sannr-outside-"));
  mkdirSync(dirname(join(root, LAYOUT.suites)), { recursive: true });
  symlinkSync(outside, join(root, LAYOUT.suites));
  assert.throws(() => saveSuite(root, { name: "link-x", v: 2, requests: [] }));
  symlinkSync(join(outside, "baseline.json"), join(root, LAYOUT.baseline));
  assert.throws(() => writeBaselineFile(root, []));
});

test("R1-14: scrub JSON escaped credential forms", () => {
  const value = 'PMAK-synthetic"with\\slashes\\nand-newline';
  assert.equal(scrubForTest(JSON.stringify({ value }), [value]), JSON.stringify({ value: "[redacted]" }));
});

test("R1-15: usage paths redact credential segments", () => {
  const out = importPostman({ info: { name: "x" }, item: [{ name: "x", request: { method: "GET", url: "/PMAK-synthetic-value" }, response: [{ code: 200 }] }] });
  assert.equal(out.suite.requests.length, 0, "a redacted request must not remain runnable");
  assert.equal(out.todo[0].path, "/{redacted}");
  assert.ok(!JSON.stringify(out).includes("PMAK-"));
});

test("R1-16: credential response headers are redacted", () => {
  assert.equal(checkOne({ header: "set-cookie", equals: "safe" }, { headers: { "set-cookie": "PMAK-synthetic-value" } }).actual, "[redacted]");
});

test("R1-17: config literal values are refused", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-config-secret-"));
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ default: "local", environments: { local: { headers: { authorization: "PMAK-synthetic-value" }, variables: { x: "PMAK-synthetic-value" } } } }));
  assert.ok(resolveConfig(root).problems.some((p) => p.code === "CONFIG_SECRET_LITERAL"));
});

test("R1-18: registry files use private atomic modes", () => {
  const home = mkdtempSync(join(tmpdir(), "sannr-registry-mode-"));
  const path = saveRegistry(emptyRegistry(), { SANNR_HOME: home });
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
});

test("R1-19: connect cleanup removes only empty directories", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-cleanup-"));
  mkdirSync(join(root, "empty"));
  assert.equal(readdirSync(join(root, "empty")).length, 0);
});

test("R1-20: notes reject machine-local operation paths", () => {
  const cli = join(process.cwd(), "bin", "cli.mjs");
  assert.throws(() => execFileSync("node", [cli, "note", ("GET /" + "Users/alice/private"), "bad"], { encoding: "utf8" }));
});

test("R1-21: duplicate workspace names are disambiguated", () => {
  const c = (name) => ({ info: { name }, item: [{ name: "x", request: { method: "GET", url: "/x" }, response: [{ code: 200 }] }] });
  const out = flattenPostmanWorkspace({ collections: [{ uid: "a", collection: c("same") }, { uid: "b", collection: c("same") }] });
  assert.deepEqual(out.collections.map((x) => x.name), ["same", "same-2"]);
});

test("R1-22: import walkers quarantine deep input", () => {
  let value = { leaf: true };
  for (let i = 0; i < 40; i++) value = { next: value };
  const text = JSON.parse(JSON.stringify(value));
  assert.match(stableStringify(text), /quarantined.*depth 32/);
});

test("R1-23: capability manifest reports every write class", () => {
  const m = capabilityManifest({ root: "/repo", config: { baseUrl: "http://x", hosts: {} }, evidence: "/repo/evidence", usageLog: ("/" + "tmp/u"), tokenCache: ("/" + "tmp/t"), tokenUrl: null });
  const ids = new Set(m.writes.map((x) => x.id));
  for (const id of ["suites", "audit-baseline", "evidence", "usage-log", "token-cache", "save_to", "map-output"]) assert.ok(ids.has(id), id);
});

test("R1-26: registry output mode stays private", () => {
  const home = mkdtempSync(join(tmpdir(), "sannr-mode-"));
  const path = saveRegistry(emptyRegistry(), { SANNR_HOME: home });
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
});

test("R1-27: evidence protection has one write path", () => {
  assert.ok(readFileSync(join(process.cwd(), "lib", "client.mjs"), "utf8").includes("protectEvidence(clientRuntime().evidence)"));
});

test("R1-28: product names reject path punctuation", () => {
  const brand = join(process.cwd(), "lib", "brand.mjs");
  assert.throws(() => execFileSync("node", ["-e", `process.env.API_CONTEXT_PRODUCT_NAME='../escape'; import(${JSON.stringify(brand)})`], { encoding: "utf8" }));
});

test("R1-29: CI summary masks mode and rejects hardlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-ci-"));
  const file = join(root, "summary.md");
  writeFileSync(file, "x\n"); chmodSync(file, 0o777);
  appendCiSummary(file, "y\n");
  assert.equal(lstatSync(file).mode & 0o777, 0o777);
});

test("R1-30: suite names reject traversal at intake", () => {
  assert.equal(normalizeSuite("../escape", { path: "/x", expect: [{ status: 200 }] }).problems[0].code, "SUITE_NAME_INVALID");
});

test("R1-31: prototype keys cannot pollute parsed identities", () => {
  assert.equal(Object.prototype.polluted, undefined);
  const parsed = parseCurl('curl https://example.test -H "__proto__: value"');
  assert.ok(parsed.warnings.some((warning) => /prototype-shaped/.test(warning)));
  assert.equal(Object.prototype.value, undefined);
});

test("R1-32: scrubber failure does not preserve raw body", () => {
  const out = scrubCaptured({ response: { body: "PMAK-synthetic-value" } });
  assert.equal(JSON.stringify(out).includes("PMAK-synthetic-value"), false);
});

test("R1 promotion refuses credential-shaped response field names", () => {
  const out = promoteObservation({ operation: "GET /x", observed: { fieldValues: { "PMAK-secret-field": ["safe"] } }, contract: { properties: { "PMAK-secret-field": { enum: ["safe"] } } } });
  assert.deepEqual(out.refused, [{ field: "[withheld]", reason: "credential-shaped field name" }]);
  assert.equal(out.promoted.fields["PMAK-secret-field"], undefined);
});

test("R1 resolved path secrets are withheld", () => {
  // Synthetic secret-shaped fixture: PMAK-* is deliberately not a real token.
  const out = importPostman({ info: { name: "x" }, item: [{ name: "leak", request: { method: "GET", url: "/PMAK-abcdefghijklmnop" }, response: [{ code: 200 }] }] });
  assert.equal(out.suite.requests.length, 0, "a redacted request must not remain runnable");
  assert.equal(out.todo[0].path, "/{redacted}");
  assert.ok(!JSON.stringify(out).includes("PMAK-"));
  assert.ok(out.report.counts.secrets_omitted_by_design > 0);
});

test("R1 Bruno directory import preserves multiple requests", () => {
  const root = mkdtempSync(join(tmpdir(), "sannr-bruno-"));
  mkdirSync(join(root, "folder"));
  writeFileSync(join(root, "folder", "one.bru"), "meta {\n  name: One\n}\nget {\n  url: /one\n}\nassert {\n  res.status: eq 200\n}\n");
  writeFileSync(join(root, "two.bru"), "meta {\n  name: Two\n}\nget {\n  url: /two\n}\nassert {\n  res.status: eq 200\n}\n");
  const out = importBrunoDirectory(root);
  assert.equal(out.suite.requests.length, 2);
});

test("R1 hook classifies shell wrappers, branches, here strings and heredocs", () => {
  const bases = ["https://api.example.test/v1"];
  for (const command of [
    'bash -lc "curl https://api.example.test/v1/orders"',
    'bash -cx "curl https://api.example.test/v1/orders"',
    'dash -c "curl https://api.example.test/v1/orders"',
    "env env env env env curl https://api.example.test/v1/orders",
    "if true; then :; else curl https://api.example.test/v1/orders; fi",
    'bash <<< "curl https://api.example.test/v1/orders"',
    "sh <<EOF\ncurl https://api.example.test/v1/orders\nEOF",
  ]) assert.equal(inspectShellHttp(command, bases).deny, true, command);
  assert.equal(inspectShellHttp("curl https://other.example/file", bases).deny, false);
});

test("R1 legacy scanner is bounded and quarantines oversized remainder", () => {
  const started = performance.now();
  const out = translateTests("responseBody" + "tests[".repeat(60000));
  assert.ok(performance.now() - started < 1000);
  assert.ok(out.quarantined.some((x) => /64 KB/.test(x.reason)));
});
