import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync,  existsSync, rmSync, realpathSync, symlinkSync, linkSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { seedViewFixture, AT } from "./fixtures/view/fixture.mjs";
import { buildViewModel, renderViewHtml } from "../lib/view.mjs";
import { recordViewModel } from "../lib/view-records.mjs";
import { renderMapText } from "../lib/map.mjs";
import { freshnessFor, liveContractDigest, loadContext } from "../lib/context.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin/cli.mjs");
const run = (root, args, env = {}) => spawnSync(process.execPath, [CLI, ...args], {
  cwd: root, encoding: "utf8", env: { ...process.env, API_USAGE_LOG: join(root, "usage.jsonl"),
    SANNR_HOME: join(root, "home"), API_EVIDENCE: join(root, LAYOUT.evidence), ...env },
});
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "view-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const fixtureModel = root => buildViewModel(root, { generatedAt: AT,
  env: { SANNR_HOME: join(root, "home"), API_USAGE_LOG: join(root, "usage.jsonl") } });

// MAP-1A fix round 2: view never refuses the page because of content. A value
// the secret scan flags reads "withheld" where it would render and is counted;
// the scan of the rendered page stays as the last guard (api-map-fixes2).
test("view withholds a planted credential in fixture note prose: the page is written, the note reads withheld and is counted", t => {
  const root = project(t);
  const planted = "ghp_" + "a".repeat(36);
  writeFileSync(join(root, LAYOUT.context), JSON.stringify({ api: { name: "Fixture" },
    operations: { "GET /items": { notes: [`Do not publish ${planted}`] } } }));
  const output = join(root, `${LAYOUT.evidence}/view/index.html`);
  for (const previous of [null, "replace the existing page\n"]) {
    if (previous) { mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, previous); }
    const result = run(root, ["view", "--json"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(planted));
    const page = readFileSync(output, "utf8");
    assert.ok(!page.includes(planted), "the page");
    assert.match(page, /<p>withheld<\/p>/, "the note reads withheld where it would render");
    assert.match(page, /Withheld by the secret and promotion scans: 1 note\. Each reads withheld where it would render\./);
  }
});

test("view golden covers operations, reports, claims, scoped receipts and grants", t => {
  const root = project(t);
  seedViewFixture(root);
  const model = fixtureModel(root), html = renderViewHtml(model);
  assert.equal(html, readFileSync(join(ROOT, "test/fixtures/view/golden.html"), "utf8").replaceAll("{{CONTEXT_PATH}}", LAYOUT.context).replaceAll("{{SUITES_PATH}}", LAYOUT.suites));
  const withoutTimestamp = text => text.replace(/^<p id="generated-at">.*$/m, "TIMESTAMP");
  assert.equal(withoutTimestamp(html), withoutTimestamp(renderViewHtml({ ...model, generated_at: "2026-09-08T12:05:00.000Z" })));
  assert.equal(model.receipt.calls, 1);
  assert.equal(model.receipt.gotchas.notes_delivered, 2);
  assert.deepEqual(model.grants, [{ consumer: "inventory", provider: "billing", at: "2026-09-06T12:00:00.000Z" }]);
  assert.ok(!html.includes("MUST_NOT_APPEAR"), "raw values, examples and observed enum values never render");
  for (const pattern of [/declared enum.*ready.*held/, /Superseded.*successful_verification/, /ci-pass-17/,
    /1 new, 1 resolved, 1 accepted unchanged/, /unsupported dynamic expression/, /input field added: cursor/, /No loss report retained/]) assert.match(html, pattern);
  assert.ok(!html.includes("99999") && !html.includes("UNRELATED_MACHINE_PROJECT"));
});

test("view has zero script or external resources even in hostile note prose", t => {
  const root = project(t), store = seedViewFixture(root);
  store.operations["GET /items"].notes.push('<script>alert(1)</script><link><iframe><img src="https://example.test"> @import url(https://example.test)');
  writeFileSync(join(root, LAYOUT.context), JSON.stringify(store));
  const html = renderViewHtml(fixtureModel(root));
  assert.doesNotMatch(html, /<script|<link|<iframe|src\s*=|@import|url\s*\(/i);
  assert.match(html, /content="default-src 'none'; style-src 'unsafe-inline'"/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="(?!#)/);
});

test("view freshness uses show/audit grading, including source and age axes", t => {
  const root = project(t);
  seedViewFixture(root);
  const ctx = loadContext(root), model = fixtureModel(root);
  for (const entry of model.operations)
    assert.deepEqual(entry.freshness, freshnessFor(ctx.operations[entry.op], root, liveContractDigest(root, ctx), Date.parse(AT)));
  assert.equal(model.operations.find(e => e.op === "GET /legacy").freshness.confidence, "suspect");
  assert.equal(model.operations.find(e => e.op === "GET /legacy").freshness.age.stale, true);
  assert.equal(model.operations.find(e => e.op === "POST /draft").freshness.confidence, "unverified");
});

test("view consumes retained map/audit results and leaves inputs unchanged", t => {
  const root = project(t);
  seedViewFixture(root);
  mkdirSync(join(root, "new-service"));
  writeFileSync(join(root, "new-service/openapi.json"), JSON.stringify({ openapi: "3.0.0", info: { title: "NEW_UNSCANNED_SERVICE" }, paths: { "/added-later": { get: {} } } }));
  const store = readFileSync(join(root, LAYOUT.context), "utf8"), baseline = readFileSync(join(root, LAYOUT.baseline), "utf8");
  const result = run(root, ["view", "--json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.opened, false);
  assert.equal(output.snapshot, true);
  assert.equal(output.path, join(root, `${LAYOUT.evidence}/view/index.html`));
  const html = readFileSync(output.path, "utf8");
  assert.ok(!html.includes("NEW_UNSCANNED_SERVICE"));
  assert.match(html, /1111111111111111111111111111111111111111/);
  assert.equal(readFileSync(join(root, LAYOUT.context), "utf8"), store);
  assert.equal(readFileSync(join(root, LAYOUT.baseline), "utf8"), baseline);
});

test("view refuses external outputs unless allowed and always refuses links", t => {
  const root = project(t), outside = project(t), path = join(outside, "page.html");
  for (const args of [["--out", path], []]) {
    const result = run(root, ["view", ...args], args.length ? {} : { API_EVIDENCE: outside });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /OUTPUT_OUTSIDE_PROJECT/);
    assert.equal(existsSync(path), false);
  }
  const allowed = run(root, ["view", "--out", path, "--allow-outside-project"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), path);
  symlinkSync(outside, join(root, "linked"));
  assert.match(run(root, ["view", "--out", join(root, "linked/other.html"), "--allow-outside-project"]).stderr, /OUTPUT_UNSAFE_PATH/);
  linkSync(path, join(root, "hardlinked.html"));
  assert.match(run(root, ["view", "--out", join(root, "hardlinked.html")]).stderr, /OUTPUT_UNSAFE_PATH/);
});

test("view names empty states and refuses malformed inputs", t => {
  const root = project(t), result = run(root, ["view", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const html = readFileSync(JSON.parse(result.stdout).path, "utf8");
  for (const sentence of ["No operations recorded", "No executions recorded yet", "No verdicts recorded", "No audit baseline recorded", "No estate map recorded", "No import sources", "No MCP inspections recorded", "No API calls recorded", "No registry grants recorded"])
    assert.ok(html.includes(sentence), sentence);
  writeFileSync(join(root, LAYOUT.context), "{");
  assert.match(run(root, ["view"]).stderr, /VIEW_CONTEXT_INVALID/);
  rmSync(join(root, LAYOUT.context));
  mkdirSync(join(root, `${LAYOUT.evidence}/view/records`), { recursive: true });
  writeFileSync(join(root, `${LAYOUT.evidence}/view/records/map.json`), "{");
  assert.match(run(root, ["view"]).stderr, /VIEW_RECORD_INVALID/);
});

test("view stays discoverable after static first-time setup", t => {
  const root = project(t);
  assert.match(run(root, ["--help"]).stdout, /view\s+write one static snapshot/);
  const help = run(root, ["view", "--help"]);
  assert.equal(help.status, 0);
  for (const flag of ["--open", "--out", "--json", "--allow-outside-project"]) assert.ok(help.stdout.includes(flag));
  assert.match(help.stdout, /2\s+refused/);
  const started = run(root, ["start", "--json"]);
  assert.equal(started.status, 0, started.stderr);
  const setup = JSON.parse(started.stdout);
  assert.equal(setup.requests_executed, 0);
  assert.equal(setup.setup.host.state, "confirmation_required");
  assert.equal(existsSync(join(root, ".github/workflows/sannr.yml")), false,
    "first-time setup must not opt into CI");
  assert.equal(run(root, ["view"]).status, 0, "a static snapshot remains available after setup");
  const guidePath = "docs/agent-guide.md";
  assert.ok(readFileSync(join(ROOT, "README.md"), "utf8").includes(`\`${guidePath}\``),
    "the npm README must name the bundled guide without relying on a broken relative web link");
  const guide = readFileSync(join(ROOT, guidePath), "utf8");
  const viewLink = /\[[^\]]*view[^\]]*\]\((view\.md)\)/.exec(guide)?.[1];
  assert.ok(viewLink, "the bundled guide must lead to the local view documentation");
  const viewPath = join(dirname(guidePath), viewLink);
  const packagedFiles = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).files;
  for (const path of [guidePath, viewPath])
    assert.ok(packagedFiles.includes(path), `${path} must ship with the package`);
  assert.match(readFileSync(join(ROOT, viewPath), "utf8"), /sannr view/,
    "the reachable view guide must document the command");
  assert.match(readFileSync(join(ROOT, "lib/brand.mjs"), "utf8"), /"docs\/view.md"/);
});

test("CLI producers retain existing models without another execution", t => {
  const root = project(t);
  seedViewFixture(root);
  rmSync(join(root, `${LAYOUT.evidence}/view/records`), { recursive: true });
  for (const args of [["map", ".", "--json", "--no-execute"], ["audit", ".", "--ci", "--report-only", "--no-execute"]]) {
    const result = run(root, args);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  }
  assert.ok(existsSync(join(root, `${LAYOUT.evidence}/view/records/map.json`)));
  assert.ok(existsSync(join(root, `${LAYOUT.evidence}/view/records/audit.json`)));
  const source = join(root, "collection.json");
  writeFileSync(source, JSON.stringify({ info: { name: "collection", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item: [
    { name: "status", request: { method: "GET", url: "https://example.test/items" },
      event: [{ listen: "test", script: { exec: ['pm.test("status", function () { pm.response.to.have.status(200); });'] } }] },
  ] }));
  const imported = run(root, ["import", source]);
  assert.equal(imported.status, 0, imported.stdout + imported.stderr);
  assert.equal(fixtureModel(root).records.filter(r => r.kind === "import").length, 1);
  assert.equal(run(root, ["view"]).status, 0);
});

test("view report sidecars reject secrets before any write", t => {
  const root = project(t);
  assert.throws(() => recordViewModel(root, "audit", { added: [{ op: "GET /items", service: "ghp_" + "z".repeat(36) }] }), { code: "VIEW_SECRET_REFUSED" });
  assert.equal(existsSync(join(root, "evidence")), false);
});

test("view opens only on opt-in, with network and listener APIs disabled", t => {
  const root = project(t);
  seedViewFixture(root);
  const guard = join(root, "offline.mjs"), marker = join(root, "opened.json");
  writeFileSync(guard, `
    import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import tls from 'node:tls';
    import child from 'node:child_process'; import { writeFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const forbidden = () => { throw new Error('Network or listener used by view'); };
    globalThis.fetch = forbidden;
    for (const module of [http, https, net, tls]) for (const name of ['request', 'get', 'connect', 'createConnection', 'createServer'])
      if (typeof module[name] === 'function') module[name] = forbidden;
    const original = child.execFileSync;
    child.execFileSync = (command, args, options) => {
      if (['open', 'xdg-open', 'explorer.exe'].includes(command)) {
        writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args)); return '';
      }
      if (command !== 'git') throw new Error('Unexpected process');
      return original(command, args, options);
    };
    child.spawn = child.spawnSync = forbidden;
    syncBuiltinESMExports();
  `);
  const env = { NODE_OPTIONS: `--import=${guard}` };
  const closed = run(root, ["view", "--json"], env);
  assert.equal(closed.status, 0, closed.stderr);
  assert.equal(existsSync(marker), false);
  const opened = run(root, ["view", "--open", "--json"], env);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(JSON.parse(opened.stdout).opened, true);
  assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), [join(root, `${LAYOUT.evidence}/view/index.html`)]);
});

test("view names the exact project commit, even with a dirty store", t => {
  const root = project(t);
  seedViewFixture(root);
  const git = args => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.test", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.test" } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(["init", "-q"]); git(["add", "openapi.json"]);
  git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "Fixture declaration"]);
  const head = git(["rev-parse", "HEAD"]);
  const result = run(root, ["view", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).head, head);
  assert.ok(readFileSync(JSON.parse(result.stdout).path, "utf8").includes(`at commit ${head}`));
});

test("the shared map renderer's complete mode retains isolated services, owners and uncapped findings", () => {
  const model = { root: "fixture", summary: { services: 1, operations: 1, edges: 0, findings: 14, shadow: 0 },
    services: [{ name: "isolated-api", kind: "documented", ops: 1, owner: "reviewer", ownerSource: "CODEOWNERS", shadow: [],
      findings: Array.from({ length: 14 }, (_, i) => ({ op: `GET /item-${i}`, severity: "high", detail: "missing field" })) }],
    edges: [], external: [], platform: [{ dimension: "pagination", detail: "declared convention disagreement" }] };
  const text = renderMapText(model, { complete: true });
  for (const fact of ["isolated-api", "reviewer", "CODEOWNERS", "GET /item-13", "pagination"]) assert.ok(text.includes(fact));
  assert.doesNotMatch(text, /more —/);
});

test("credential field names and types render as structure without an inline-credential false positive", t => {
  const root = project(t);
  seedViewFixture(root);
  const contract = JSON.parse(readFileSync(join(root, "openapi.json"), "utf8"));
  contract.paths["/items"].get.responses[200].content["application/json"].schema.properties.token = { type: "string" };
  writeFileSync(join(root, "openapi.json"), JSON.stringify(contract));
  const html = renderViewHtml(fixtureModel(root));
  assert.match(html, /<code>\$\.token<\/code>: <code>string<\/code>/);
});
