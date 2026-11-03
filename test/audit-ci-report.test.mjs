import { LAYOUT } from "../lib/layout.mjs";
// M1-A — CI is loud without being enforcing, and writes a safe append-only
// GitHub step summary without executing API traffic.
//
//   node --test test/audit-ci-report.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  rmSync,
} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { BASELINE_FILE } from "../lib/ci.mjs";
import { secretIn } from "../lib/verdicts.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const sha = (value) => `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;

function git(root, args, date = "2026-01-10") {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: root, encoding: "utf8", env: { ...process.env,
      GIT_AUTHOR_DATE: `${date}T12:00:00Z`, GIT_COMMITTER_DATE: `${date}T12:00:00Z` },
  });
}

function fixture({ origin = null, poison = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "audit-ci-report-")));
  const svc = join(root, "widgets");
  mkdirSync(join(svc, "src"), { recursive: true });
  git(root, ["init", "-q"]);
  const spec = JSON.stringify({ openapi: "3.0.0", info: { title: "widgets" }, paths: {
    "/things": { get: { responses: { 200: { description: "ok" } } } },
  } });
  writeFileSync(join(svc, "openapi.json"), spec);
  writeFileSync(join(svc, "src", "app.mjs"),
    `app.get("/things", h);\napp.get("/tags", h);\n`);
  if (origin) writeFileSync(join(svc, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: origin } },
  }));
  const poisonText = [
    "token=supersecretvalue", "customer@example.com",
    "eyJabcdefghijk.abcdefghijklmnop", "-----BEGIN PRIVATE KEY-----",
    "Authorization: Bearer abcdefghijklmnop", "body password=secretvalue",
    "?access_token=abcdefghijklmnop",
  ].join(" ");
  writeFileSync(join(svc, LAYOUT.context), `${JSON.stringify({
    v: 0, api: { name: "widgets", contract: "openapi.json", contract_digest: sha(spec) },
    generated_at: "2026-02-01",
    operations: {
      "GET /things": { source_file: "src/app.mjs", verified_at: "2026-02-01T12:00:00Z",
        contract_digest: poison ? "sha256:changed-contract" : sha(spec), shape_hash: "sha256:aa",
        status_codes: [200], effect: "read", fields: {}, notes: poison ? [poisonText] : [] },
      "GET /old": { source_file: null, verified_at: "2020-01-01T00:00:00Z",
        contract_digest: sha(spec), status_codes: [200], effect: "read", fields: {} },
      "GET /never": { source_file: poison ? "src/token=supersecretvalue.mjs" : null,
        verified_at: null, contract_digest: sha(spec), status_codes: [], effect: "read", fields: {},
        headers: poison ? { Authorization: "Bearer abcdefghijklmnop" } : undefined },
    },
  }, null, 2)}\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "fixture"], "2026-03-01");
  // A source commit after GET /things was verified makes its git-aware grade suspect.
  writeFileSync(join(svc, "src", "app.mjs"),
    `app.get("/things", h);\napp.get("/tags", h);\n// changed after verification\n`);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "source changed"], "2026-08-20");
  return { root, svc, spec, poisonText };
}

function run(args, cwd) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

async function runAsync(args, cwd) {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [CLI, ...args],
      { cwd, encoding: "utf8" });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function baselineAndDrift(root, svc) {
  const baseline = run(["audit", root, "--baseline", "--no-execute"], root);
  assert.equal(baseline.code, 0, baseline.out);
  writeFileSync(join(svc, "src", "app.mjs"),
    `app.get("/things", h);\napp.post("/admin/reset", h);\n`);
}

test("--report-only preserves the CI diff but exits zero and names its mode", () => {
  const { root, svc } = fixture();
  baselineAndDrift(root, svc);

  const enforcing = run(["audit", root, "--ci", "--no-execute"], root);
  const reporting = run(["audit", root, "--ci", "--report-only", "--no-execute"], root);
  assert.equal(enforcing.code, 1, enforcing.out);
  assert.equal(reporting.code, 0, reporting.out);
  for (const needle of ["NEW since the baseline (1)", "POST /admin/reset",
    "resolved since the baseline (1)", "GET /tags"])
    assert.ok(enforcing.out.includes(needle) && reporting.out.includes(needle),
      `enforcing/report-only reports diverged at ${needle}`);
  const rows = (out) => out.split("\n").filter((line) => /POST \/admin\/reset|GET \/tags/.test(line));
  assert.deepEqual(rows(reporting.out), rows(enforcing.out),
    "finding and resolved rows must be byte-identical across modes");
  assert.match(reporting.out, /report-only: found 1 findings that WOULD fail an enforcing gate/);

  const jsonSummary = join(root, "json-summary.md");
  const json = run(["audit", root, "--ci", "--report-only", "--json", "--summary",
    jsonSummary, "--no-execute"], root);
  assert.equal(json.code, 0, json.out);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.report_only, true);
  assert.equal(parsed.would_fail, 1);
  assert.equal(parsed.new.length, 1);
  assert.equal(parsed.resolved.length, 1);
  assert.match(readFileSync(jsonSummary, "utf8"), /^## API audit CI summary/,
    "pure JSON stdout did not also append the requested GFM file");
  rmSync(root, { recursive: true, force: true });
});

test("--summary appends separated safe GFM with findings, freshness, and reviewed local commands", () => {
  const { root, svc } = fixture({ poison: true });
  baselineAndDrift(root, svc);
  // Poison the source identity that feeds the finding detail/where only AFTER
  // the baseline, so the new row must cross the summary promotion boundary.
  writeFileSync(join(svc, "src", "token=supersecretvalue.mjs"),
    `app.get("/poisoned", h);\n`);
  const summary = join(root, "step-summary.md");
  const prefix = "# Existing job output\nkeep byte-for-byte";
  writeFileSync(summary, prefix);

  for (let i = 0; i < 2; i += 1) {
    const result = run(["audit", root, "--ci", "--report-only", "--summary", summary,
      "--no-execute"], root);
    assert.equal(result.code, 0, result.out);
  }
  const written = readFileSync(summary, "utf8");
  assert.ok(written.startsWith(prefix), "summary overwrote or changed the existing prefix");
  assert.equal((written.match(/^## API audit CI summary$/gm) ?? []).length, 2,
    "each invocation appends one separated section");
  assert.match(written, /\| Operation \| Kind \| Where \|/);
  assert.match(written, /POST \/admin\/reset/);
  assert.match(written, /## Freshness/);
  assert.match(written, /GET \/things[\s\S]*suspect/);
  assert.match(written, /GET \/old[\s\S]*age-stale/);
  assert.match(written, /GET \/never[\s\S]*unverified/);
  assert.match(written,
    /Fix code\/spec locally, then regenerate and review the accepted state with:[\s\S]*audit \. --baseline --no-execute/);
  assert.match(written, /Then verify the enforcing gate with:[\s\S]*audit \. --ci --no-execute/);
  assert.equal(secretIn(written), null, `summary leaked secret-shaped evidence: ${written}`);
  assert.ok(!written.includes("supersecretvalue") && !written.includes("customer@example.com"));
  rmSync(root, { recursive: true, force: true });
});

test("summary cells neutralize GFM/HTML injection and never render finding detail", async () => {
  const { renderCiSummary } = await import("../lib/ci.mjs");
  const poison = "token=supersecretvalue";
  const rendered = renderCiSummary({
    added: [{ op: "GET /a|b\n<script>*x*", kind: "shadow|route", service: "svc<script>",
      detail: `response body ${poison}` }],
    resolved: [], unchanged: 0, freshness: [], reportOnly: true,
    baselineGeneratedAt: "2026-08-01",
  });
  assert.equal(secretIn(rendered), null);
  assert.ok(!rendered.includes(poison), "finding detail reached the summary");
  assert.doesNotMatch(rendered, /<script>|\*x\*|a\|b\n/);
  assert.match(rendered, /&#124;|&lt;|&#42;/, "GFM/HTML metacharacters were not escaped");
});

test("the scheduled no-execute summary grades freshness with zero requests or input writes", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const { root, svc } = fixture({ origin });
  try {
    baselineAndDrift(root, svc);
    const specPath = join(svc, "openapi.json");
    const contextPath = join(svc, LAYOUT.context);
    const changedSpec = JSON.parse(readFileSync(specPath, "utf8"));
    changedSpec.info.version = "2.0.0";
    writeFileSync(specPath, JSON.stringify(changedSpec));
    const before = [sha(readFileSync(specPath)), sha(readFileSync(contextPath))];
    const summary = join(root, "scheduled.md");
    const result = await runAsync(["audit", "--ci", "--report-only", "--summary", summary,
      "--no-execute"], root);
    assert.equal(result.code, 0, result.out);
    assert.equal(requests, 0, "freshness-focused scheduled path made an API request");
    assert.deepEqual([sha(readFileSync(specPath)), sha(readFileSync(contextPath))], before,
      "reporting mutated the declared spec or knowledge store");
    const text = readFileSync(summary, "utf8");
    assert.match(text, /suspect/);
    assert.match(text, /contract digest diverged/,
      "a nested service contract edit was graded from the repository root");
    assert.match(text, /widgets\/src\/app\.mjs changed .* since/,
      "a nested service source commit was graded from the repository root");
    assert.match(text, /No API requests were executed/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("CI-only flags and summary failures are named, non-destructive errors", () => {
  const { root, svc } = fixture();
  const summary = join(root, "summary.md");
  writeFileSync(summary, "sentinel\n");
  for (const args of [
    ["audit", root, "--report-only", "--no-execute"],
    ["audit", root, "--summary", summary, "--no-execute"],
  ]) {
    const result = run(args, root);
    assert.equal(result.code, 1);
    assert.match(result.out, /CI_FLAG_REQUIRED/);
  }
  const missingValue = run(["audit", root, "--ci", "--summary", "--no-execute"], root);
  assert.equal(missingValue.code, 1);
  assert.match(missingValue.out, /MISSING_SUMMARY_PATH/);
  assert.equal(readFileSync(summary, "utf8"), "sentinel\n");

  // A missing baseline is inability to assert, not a finding report: it stays red
  // and never touches the requested summary.
  const noBaseline = run(["audit", root, "--ci", "--report-only", "--summary", summary,
    "--no-execute"], root);
  assert.equal(noBaseline.code, 1);
  assert.match(noBaseline.out, /BASELINE_NOT_FOUND/);
  assert.equal(readFileSync(summary, "utf8"), "sentinel\n");

  writeFileSync(join(root, BASELINE_FILE), "{ corrupt");
  const corruptBaseline = run(["audit", root, "--ci", "--report-only", "--summary", summary,
    "--no-execute"], root);
  assert.equal(corruptBaseline.code, 1);
  assert.match(corruptBaseline.out, /BASELINE_CORRUPT/);
  assert.equal(readFileSync(summary, "utf8"), "sentinel\n");

  baselineAndDrift(root, svc);
  const directoryPath = run(["audit", root, "--ci", "--summary", root, "--no-execute"], root);
  assert.equal(directoryPath.code, 1);
  assert.match(directoryPath.out, /SUMMARY_WRITE_FAILED/);
  const missingParent = join(root, "absent", "summary.md");
  const badParent = run(["audit", root, "--ci", "--summary", missingParent, "--no-execute"], root);
  assert.equal(badParent.code, 1);
  assert.match(badParent.out, /SUMMARY_WRITE_FAILED/);
  assert.ok(!existsSync(missingParent));

  const locked = join(root, "locked");
  mkdirSync(locked);
  const lockedSummary = join(locked, "summary.md");
  writeFileSync(lockedSummary, "preserve me\n");
  chmodSync(locked, 0o500);
  const writeFailure = run(["audit", root, "--ci", "--summary", lockedSummary, "--no-execute"], root);
  chmodSync(locked, 0o700);
  assert.equal(writeFailure.code, 1);
  assert.match(writeFailure.out, /SUMMARY_WRITE_FAILED/);
  assert.equal(readFileSync(lockedSummary, "utf8"), "preserve me\n");

  const readOnlySummary = join(root, "read-only-summary.md");
  writeFileSync(readOnlySummary, "cannot replace me\n");
  chmodSync(readOnlySummary, 0o400);
  const readOnlyFailure = run(["audit", root, "--ci", "--summary", readOnlySummary,
    "--no-execute"], root);
  chmodSync(readOnlySummary, 0o600);
  assert.equal(readOnlyFailure.code, 1, readOnlyFailure.out);
  assert.match(readOnlyFailure.out, /SUMMARY_WRITE_FAILED/);
  assert.equal(readFileSync(readOnlySummary, "utf8"), "cannot replace me\n");
  rmSync(root, { recursive: true, force: true });
});

test("--summary refuses context, contract, and reviewed baseline targets byte-for-byte", () => {
  for (const protectedName of ["context", "contract", "baseline"]) {
    const { root, svc } = fixture();
    try {
      baselineAndDrift(root, svc);
      const protectedPath = protectedName === "context" ? join(svc, LAYOUT.context)
        : protectedName === "contract" ? join(svc, "openapi.json")
          : join(root, BASELINE_FILE);
      const before = readFileSync(protectedPath);
      const result = run(["audit", root, "--ci", "--report-only", "--summary",
        protectedPath, "--no-execute"], root);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /SUMMARY_TARGET_PROTECTED/);
      assert.deepEqual(readFileSync(protectedPath), before,
        `${protectedName} bytes changed despite the protected-target refusal`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("audit help documents CI modes while the one exit-code table stays stable", () => {
  const help = run(["audit", "--help"], ROOT);
  assert.equal(help.code, 0, help.out);
  assert.match(help.out, /--report-only/);
  assert.match(help.out, /--summary <path>/);
  assert.match(help.out, /--no-execute/);
  assert.equal((help.out.match(/^  0   success/mg) ?? []).length, 1);
  assert.equal((help.out.match(/^  1   failure/mg) ?? []).length, 1);
  assert.equal((help.out.match(/^  2   refused/mg) ?? []).length, 1);
});
