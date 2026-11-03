import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const reporterURL = new URL("../scripts/windows-test-reporter.mjs", import.meta.url);
async function report(events) {
  const { default: reporter } = await import(reporterURL);
  let output = "";
  for await (const chunk of reporter(events)) output += chunk;
  return output;
}
const summary = (failed) => ({ type: "test:summary", data: {
  success: !failed, counts: { tests: 3, passed: 2 - failed, failed, skipped: 1, todo: 0 },
} });

test("Windows summary lists structured failure names and escapes Markdown without assertion payloads", async () => {
  const output = await report([
    { type: "test:stdout", data: { message: "PRIVATE_STDOUT" } },
    { type: "test:fail", data: { name: "child <script> [link](url) `tick`\r\nnext", details: { error: "PRIVATE_ASSERTION" } } },
    { type: "test:fail", data: { name: "parent suite", details: { error: { failureType: "subtestsFailed" } } } },
    { type: "test:fail", data: { name: "expected todo", todo: true } },
    { type: "test:pass", data: { name: "skipped specimen", skip: true } },
    summary(1),
  ]);
  assert.match(output, /child &lt;script&gt; \[link\]\(url\) `tick` next/);
  assert.match(output, /<li><code>parent suite<\/code><\/li>/);
  assert.doesNotMatch(output, /PRIVATE_|expected todo|skipped specimen|<script>/);
  assert.match(output, /Tests: 3; passed: 1; failed: 1; skipped: 1; todo: 0/);
  assert.match(output, /Result: failed/);
});

test("Windows summary distinguishes a completed green suite from an interrupted or empty stream", async () => {
  assert.match(await report([summary(0)]), /No failing tests reported[\s\S]*Result: passed/);
  const incomplete = await report([]);
  assert.match(incomplete, /incomplete.*not a passing run/i);
  assert.doesNotMatch(incomplete, /Result: passed|No failing tests/);
  // Per-file summaries must not masquerade as completion of the entire run.
  assert.match(await report([{ ...summary(0), data: { ...summary(0).data, file: "one.test.mjs" } }]), /incomplete/);
});

test("Windows reporter measures a real failing child suite and preserves its nonzero exit", () => {
  const dir = mkdtempSync(join(tmpdir(), "windows-reporter-"));
  try {
    writeFileSync(join(dir, "fixture.test.mjs"), [
      'import { test } from "node:test";',
      'test("parent specimen", async t => { await t.test("child failure specimen", () => { throw new Error("PRIVATE_ASSERTION"); }); });',
      'test.skip("skip specimen", () => {});',
      'test.todo("todo specimen", () => { throw new Error("EXPECTED_TODO"); });',
    ].join("\r\n"));
    const destination = join(dir, "summary.md");
    const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1",
      `--test-reporter=${fileURLToPath(reporterURL)}`, `--test-reporter-destination=${destination}`,
      join(dir, "fixture.test.mjs")], { cwd: dir, encoding: "utf8", timeout: 15000,
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
    });
    assert.equal(result.status, 1, result.stderr);
    const output = readFileSync(destination, "utf8");
    assert.match(output, /<li><code>child failure specimen<\/code><\/li>/);
    assert.match(output, /<li><code>parent specimen<\/code><\/li>/);
    assert.match(output, /Result: failed/);
    assert.doesNotMatch(output, /PRIVATE_ASSERTION|EXPECTED_TODO|skip specimen|todo specimen/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
