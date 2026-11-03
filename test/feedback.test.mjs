// The feedback report leaves the tester's machine. Everything here is about
// what must NOT be in it.
//
//   node --test test/feedback.test.mjs
//
// ALPHA.md's fourth line promises testers that nothing phones home, and the
// report is the one artifact that crosses the boundary — by hand, after they
// read it. Two things follow, and both are tested here: the tool never sends,
// and the file contains no bodies, headers, credentials, query values, or
// absolute paths. A single leaked bearer token in a file someone forwards over
// Slack would end the alpha and deserve to.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFeedback, renderFeedback, readUsage, wiredHosts } from "../lib/feedback.mjs";
import { STATE_DIR_NAME } from "../lib/brand.mjs";
import { buildReceipt } from "../lib/receipt.mjs";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAYOUT } from "../lib/layout.mjs";

// A usage log with every dangerous field a real one could carry. If any of
// these strings reaches the rendered report, the test fails.
const SECRETS = [
  "sk-live-DEADBEEF", "Bearer abc123", "hunter2",
  ("/" + "Users/someone/private/repo"), "customer@example.com",
  "internal-billing.acme-corp.net", "?api_key=leakme",
];
const usage = [
  { ts: 1, method: "GET", path: "/v1/customers", status: 200, host: "internal-billing.acme-corp.net",
    url: "https://internal-billing.acme-corp.net/v1/customers?api_key=leakme",
    headers: { authorization: "Bearer abc123" }, body: { email: "customer@example.com" },
    token: "sk-live-DEADBEEF", cwd: ("/" + "Users/someone/private/repo") },
  { ts: 2, method: "POST", path: "/v1/charges", status: 402, friction: true, password: "hunter2" },
  { ts: 3, method: "GET", path: "/v1/x", status: 500 },
];

const model = () => buildFeedback({
  map: {
    summary: { operations: 4, undocumented_routes: 2, edges: 1, external: 3 },
    services: [{
      name: "billing-internal",
      findings: [{ kind: "required-field-drift", severity: "high", detail: "field `ssn` missing" }],
      shadow: [{ severity: "medium", path: "/admin/impersonate" }],
    }],
  },
  ctx: { operations: { "GET /a": { notes: ["429s are unlabelled"], verified_at: "2026-08-01" } },
         verdicts: { "GET /a": {} } },
  receipt: { calls: 3, tokens: { saved: 900 }, gotchas: { notes_delivered: 2 },
             drift: { calls: 1, kinds: { redirect: 1 } }, friction: { captured: 1 } },
  usage,
});

test("no credential, body, header, host, or absolute path reaches the report", () => {
  const text = renderFeedback(model()) + JSON.stringify(model());
  for (const s of SECRETS)
    assert.ok(!text.includes(s), `the report leaked: ${s}`);
});

test("a finding's DETAIL is never included — only its kind and severity", () => {
  const text = renderFeedback(model());
  assert.ok(text.includes("required-field-drift"), "the kind is the useful, safe half");
  assert.ok(!text.includes("ssn"), "a finding detail quotes their schema and must not travel");
  assert.ok(!text.includes("/admin/impersonate"), "a shadow route path is theirs, not ours");
});

test("statuses are reported as classes, never as paths", () => {
  const m = model();
  assert.deepEqual(m.usage.status_classes, { "2xx": 1, "4xx": 1, "5xx": 1 });
  assert.equal(m.usage.calls, 3);
  assert.ok(!JSON.stringify(m.usage).includes("/v1/"), "a path can encode an identifier");
});

test("machine-wide calls are named only when there IS a difference to explain", () => {
  // Found 2026-08-23: a real feedback report claimed 1,339 calls for a
  // two-route repo because the usage log is machine-wide and nothing scoped
  // it. The CLI now scopes `usage` before calling buildFeedback and passes
  // the pre-scope total separately — this pins that the model surfaces it
  // ONLY when scoping actually excluded something, never as noise.
  const scoped = buildFeedback({ map: { summary: {}, services: [] }, usage: [], machineWideCalls: 3 });
  assert.equal(scoped.usage.machine_wide_calls, 3);
  assert.match(renderFeedback(scoped), /3 calls\n> total across every project/);

  const noGap = buildFeedback({ map: { summary: {}, services: [] }, usage: [], machineWideCalls: 0 });
  assert.ok(!("machine_wide_calls" in noGap.usage), "nothing excluded, nothing to explain");
  assert.ok(!renderFeedback(noGap).includes("across every project"));
});

test("--anonymize replaces service names with stable placeholders", () => {
  const named = buildFeedback({ map: { summary: {}, services: [{ name: "billing-internal" }, { name: "auth" }] } });
  const anon = buildFeedback({ map: { summary: {}, services: [{ name: "billing-internal" }, { name: "auth" }] } , anonymize: true });
  assert.deepEqual(named.what_it_found.service_names, ["billing-internal", "auth"]);
  assert.deepEqual(anon.what_it_found.service_names, ["svc-1", "svc-2"]);
  assert.ok(!renderFeedback(anon).includes("billing-internal"));
});

test("a static run says so, and does not let an empty findings list read as 'nothing wrong'", () => {
  const staticRun = renderFeedback(buildFeedback({ map: { summary: {}, services: [] }, executed: false }));
  assert.match(staticRun, /static scan/i);
  assert.match(staticRun, /not looked for/i);
  const executed = renderFeedback(buildFeedback({ map: { summary: {}, services: [] }, executed: true }));
  assert.ok(!/static scan/i.test(executed));
});

test("feedback dates show the computer's local time and zone while retaining a UTC instant", () => {
  for (const [zone, expected] of [
    ["America/Los_Angeles", "2026-10-06 18:30:00 -07:00 (America/Los_Angeles)"],
    ["Pacific/Kiritimati", "2026-10-07 15:30:00 +14:00 (Pacific/Kiritimati)"],
  ]) {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { buildFeedback, renderFeedback } from './lib/feedback.mjs';
      const model = buildFeedback({ now: new Date('2026-10-07T01:30:00.000Z') });
      console.log(JSON.stringify({ model, text: renderFeedback(model) }));
    `], { cwd: new URL("../", import.meta.url), env: { ...process.env, TZ: zone }, encoding: "utf8" });
    const { model, text } = JSON.parse(output);
    assert.equal(model.generated_at, "2026-10-07T01:30:00.000Z");
    assert.equal(model.generated_local, expected);
    assert.ok(text.includes(`Generated ${expected}`));
    assert.match(text, /timestamps ending in Z are UTC/i);
  }
});

test("feedback does not equate GET/HEAD with free or side-effect-free execution", () => {
  const text = renderFeedback(buildFeedback());
  assert.match(text, /GET\/HEAD can still incur charges or have side effects/);
  assert.match(text, /Review the provider's behavior before opting in/);
});

test("legacy feedback models label the UTC fallback without claiming local conversion", () => {
  const report = model();
  delete report.generated_local;
  report.generated_at = '2026-10-07';
  const text = renderFeedback(report);
  assert.match(text, /Generated 2026-10-07 \(UTC\)/);
  assert.doesNotMatch(text, /generated time above uses this computer's local zone/);
});

test("static URL-reference hosts are not advertised as confirmed application dependencies", () => {
  const report = model();
  assert.equal(report.what_it_found.external_dependencies, 3, 'retain the historical JSON count');
  assert.equal(report.what_it_found.external_dependency_basis, 'unmatched_static_url_reference_hosts');
  const text = renderFeedback(report);
  assert.match(text, /3 external hosts referenced \(not confirmed dependencies\)/);
  assert.match(text, /Specs and documentation can contribute references/);
  assert.doesNotMatch(text, /3 external dependencies/);
});

test("zero accumulation is stated as a real result, not hidden", () => {
  const text = renderFeedback(buildFeedback({ map: { summary: {}, services: [] } }));
  assert.match(text, /Zero gotchas written/);
  assert.match(text, /in this repo/);
  assert.match(text, /excludes notes stored in provider repos/);
  assert.match(text, /does not establish whether notes were written or used elsewhere/);
});

test("consumer feedback separates provider note deliveries from local accumulation", () => {
  const rows = [
    { status: 200, knownNotes: 2, knownProviderHash: "sha256:provider", knownOp: "GET /devices", tokensSaved: 100 },
    { status: 200, knownNotes: 2, knownProviderHash: "sha256:provider", knownOp: "GET /devices", tokensSaved: 100 },
    { status: 200, knownNotes: 1, knownOp: "GET /local", tokensSaved: -10 },
  ];
  const report = buildFeedback({ usage: rows, receipt: buildReceipt(rows, null) });
  assert.equal(report.did_anything_accumulate.gotchas_written, 0);
  assert.equal(report.did_anything_accumulate.verified_by_execution, 0);
  assert.equal(report.what_it_saved.gotchas_reused, 5);
  assert.equal(report.what_it_saved.gotchas_delivered_through_grants, 4);
  assert.equal(report.what_it_saved.tokens_saved, 190);
  const text = renderFeedback(report);
  assert.match(text, /4 note delivery event\(s\) through grants/);
  assert.match(text, /do not automatically verify a provider/);
  assert.match(text, /do not measure end-to-end agent token use or time saved/);
  assert.match(text, /include repeat deliveries/);
  assert.doesNotMatch(text, /sha256:provider|GET \/devices/);
});

test("the three questions are always present and unanswered", () => {
  const text = renderFeedback(model());
  assert.match(text, /Did it cry wolf/);
  assert.match(text, /did not already know/);
  assert.match(text, /first ten minutes/);
});

test("the feature-request slot asks for a blocked moment, and licenses a blank", () => {
  // A plain wishlist prompt is the failure mode: an agent will fill it with
  // twenty plausible features that cost nothing to write and are worth nothing
  // to read, and a comfortable roadmap crowds out "I went back to curl". So the
  // section must ask for a moment and must say blank is fine.
  const text = renderFeedback(model());
  assert.match(text, /want(ed)? to do and could not/i);
  assert.match(text, /workaround/i, "what the feature competes with is the useful half");
  assert.match(text, /Not a wishlist/i);
  assert.match(text, /blank/i, "an unlicensed blank gets filled with invention");
  // And it stays subordinate to the three questions, which are the hard ones.
  assert.ok(text.indexOf("Did it cry wolf") < text.indexOf("could not"),
    "cry-wolf must be read first; a wishlist at the top is the one people answer");
});

test("the report tells the reader nothing was sent", () => {
  assert.match(renderFeedback(model()), /Nothing was sent anywhere/);
});

// --- the promise itself ------------------------------------------------------
//
// Static, not behavioural, and deliberately so: a behavioural test can only
// prove the paths it exercised made no request. This proves no code path can,
// because the module never imports anything that could.

test("the feedback module contains no network capability at all", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../lib/feedback.mjs", import.meta.url), "utf8");
  for (const forbidden of ["fetch(", "node:http", "node:https", "node:net", "XMLHttpRequest", "WebSocket"])
    assert.ok(!src.includes(forbidden),
      `feedback.mjs must not be able to send: found ${forbidden}. ALPHA.md promises nothing phones home.`);
});

// --- defensive reads ---------------------------------------------------------

test("a missing or torn usage log yields an empty list, never a crash", () => {
  assert.deepEqual(readUsage(join(tmpdir(), "does-not-exist-", String(process.pid), "usage.jsonl")), []);
  const dir = mkdtempSync(join(tmpdir(), "fb-"));
  const p = join(dir, "usage.jsonl");
  writeFileSync(p, `{"status":200}\n{"status":404}\n{"status":5`);   // killed mid-write
  assert.equal(readUsage(p).length, 2, "the two intact rows survive a torn final line");
});

test("readUsage without an argument reads the same default path the client writes", () => {
  const home = mkdtempSync(join(tmpdir(), "fb-home-"));
  const state = join(home, `.${STATE_DIR_NAME}`);
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "usage.jsonl"), '{"status":200}\n');
  const env = { ...process.env, HOME: home };
  delete env.API_USAGE_LOG;
  const count = execFileSync(process.execPath, ["--input-type=module", "-e",
    'import { readUsage } from "./lib/feedback.mjs"; console.log(readUsage().length);'],
  { cwd: new URL("../", import.meta.url).pathname, env, encoding: "utf8" }).trim();
  assert.equal(count, "1", "the no-argument reader must follow client.mjs's default USAGE_LOG");
});

test("usage-log paths never derive the pinned state directory from PRODUCT", () => {
  const files = ["lib/client.mjs", "lib/feedback.mjs", "bin/cli.mjs", "bin/cli-main.mjs", "bin/request.mjs", "bin/request-main.mjs"];
  for (const file of files) {
    const code = readFileSync(new URL(`../${file}`, import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").filter((line) => !/^\s*\/\//.test(line)).join("\n");
    assert.doesNotMatch(code, /PRODUCT[^\n]*usage\.jsonl|usage\.jsonl[^\n]*PRODUCT/,
      `${file} must resolve usage.jsonl through STATE_DIR_NAME, not PRODUCT`);
  }
});

test("wiring is reported as presence only, never as file contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "fb-wired-"));
  assert.deepEqual(wiredHosts(dir), { "claude-code": false, codex: false, skills: false });
  writeFileSync(join(dir, ".mcp.json"), `{"mcpServers":{"x":{"env":{"TOKEN":"sk-live-DEADBEEF"}}}}`);
  mkdirSync(join(dir, ".codex"), { recursive: true });
  writeFileSync(join(dir, ".codex", "config.toml"), "secret = 'hunter2'");
  const w = wiredHosts(dir);
  assert.equal(w["claude-code"], true);
  assert.equal(w.codex, true);
  const text = renderFeedback(buildFeedback({ map: { summary: {}, services: [] }, wired: w }));
  assert.ok(!text.includes("sk-live-DEADBEEF") && !text.includes("hunter2"),
    "an MCP config holds credentials; only the fact of its existence may travel");
});

test("an empty repo produces a valid report rather than an error", () => {
  const text = renderFeedback(buildFeedback({}));
  // The report a beta user reads and sends names the beta, not the alpha.
  assert.match(text.split("\n")[0], /^# .+ — beta feedback$/);
  assert.doesNotMatch(text, /\balpha\b/i);
  assert.match(text, /0 service/);
});

// F-4 qualification, 2026-10-07: these controls already pass on merged
// bd0bca02. The reported post-write exit 1 is not reproduced; do not disguise
// configuration or output refusals by forcing a success exit in the handler.
function feedbackFixture(t) {
  const fixture = mkdtempSync(join(tmpdir(), "feedback-cli-"));
  const root = join(fixture, "repo"), home = join(fixture, "home");
  mkdirSync(root); mkdirSync(home);
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !/^(?:API_|SANNR_)/.test(key)));
  env.HOME = home;
  const cli = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
  return { root, run: (...args) => spawnSync(process.execPath, [cli, "feedback", ...args],
    { cwd: root, env, encoding: "utf8", timeout: 15_000 }) };
}

test("F-4 feedback without API configuration writes its report and exits zero", t => {
  const { root, run } = feedbackFixture(t);
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Nothing was sent/);
  const report = readFileSync(join(root, LAYOUT.feedback), "utf8");
  assert.match(report, /static scan/i);
  assert.match(report, /0 service/);
});

test("F-4 static findings do not turn a successfully written report into failure", t => {
  const { root, run } = feedbackFixture(t);
  writeFileSync(join(root, "openapi.json"), JSON.stringify({ openapi: "3.0.0",
    info: { title: "Example API", version: "1" }, servers: [{ url: "https://api.example.test" }],
    paths: { "/models": { get: { responses: { "200": { description: "ok" } } } } } }));
  writeFileSync(join(root, "app.mjs"), 'app.get("/models", () => {});\napp.post("/extra", () => {});\n');
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(root, LAYOUT.feedback), "utf8"), /shadow-route/);
  const json = run("--json");
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  assert.equal(report.what_it_found.findings_by_kind["shadow-route"], 1);
  assert.equal(report.what_it_found.request_attempts, 0);
  assert.equal(report.what_it_found.executed_against_a_running_server, false);
});

test("F-4 a custom feedback output succeeds without creating the default report", t => {
  const { root, run } = feedbackFixture(t);
  const result = run("--out", "custom-feedback.md");
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(root, "custom-feedback.md"), "utf8"), /Nothing was sent anywhere/);
  assert.equal(existsSync(join(root, LAYOUT.feedback)), false);
});

test("F-4 JSON feedback succeeds without pretending a report file was written", t => {
  const { root, run } = feedbackFixture(t);
  const result = run("--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).what_it_found.request_attempts, 0);
  assert.equal(existsSync(join(root, LAYOUT.feedback)), false);
});

test("F-4 an unwritable feedback destination remains a nonzero named error", t => {
  const { root, run } = feedbackFixture(t);
  const result = run("--out", "missing-parent/report.md");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stderr).error.code, "ENOENT");
  assert.doesNotMatch(result.stdout, /wrote /);
  assert.equal(existsSync(join(root, "missing-parent", "report.md")), false);
});
