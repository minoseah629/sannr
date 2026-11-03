import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { selectStressHosts } from "./stress.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const suites = { __EDGE__: [{ path: "/get" }], "https://remote.invalid": [{ path: "/remote" }] };
test("local stress check selects only the in-repo fixture without remote hosts", () => {
  assert.deepEqual(selectStressHosts({ suites, fixtureOrigin: "http://127.0.0.1:12345", localOnly: true }), [["http://127.0.0.1:12345", suites.__EDGE__]]);
});

test("local stress check refuses a STRESS_EDGE override before starting any requests", () => {
  assert.throws(() => selectStressHosts({ suites, fixtureOrigin: "http://127.0.0.1:12345", localOnly: true, edge: "https://remote.invalid" }), /SANNR_STRESS_LOCAL.*STRESS_EDGE/);
});

test("ordinary stress selection preserves the full public matrix and quick cap", () => {
  const selected = selectStressHosts({ suites, fixtureOrigin: "http://127.0.0.1:12345" });
  assert.deepEqual(selected, [["http://127.0.0.1:12345", suites.__EDGE__], ["https://remote.invalid", suites["https://remote.invalid"]]]);
  const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`https://remote-${i}.invalid`, []]));
  assert.equal(selectStressHosts({ suites: many, quick: true }).length, 4);
});

test("local stress check warns on its first line that it is not the stress gate", () => {
  const env = { ...process.env, SANNR_STRESS_LOCAL: "1" };
  delete env.STRESS_EDGE;
  const result = spawnSync(process.execPath, [join(ROOT, "test/stress.mjs")], {
    cwd: tmpdir(), env, encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.split(/\r?\n/)[0], "LOCAL MODE — not the stress gate; run `npm run test:stress` unset before committing");
  assert.match(result.stdout, /stressing 1 hosts, 46 requests/);
});

test("npm run check ignores SANNR_STRESS_LOCAL for every gate", () => {
  const dir = mkdtempSync(join(tmpdir(), "sannr-check-mode-"));
  try {
    // A stub package manager records gate selection without running any gate
    // or reaching the public network, including on the pre-fix check script.
    const cli = join(dir, "npm.mjs");
    const log = join(dir, "calls.jsonl");
    writeFileSync(cli, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.SANNR_CHECK_TEST_LOG, JSON.stringify({ args: process.argv.slice(2), local: process.env.SANNR_STRESS_LOCAL ?? null }) + "\\n");
`);
    if (process.platform === "win32") {
      writeFileSync(join(dir, "npm.cmd"), `@"${process.execPath}" "${cli}" %*\r\n`);
    } else {
      writeFileSync(join(dir, "npm"), `#!${process.execPath}\nawait import(${JSON.stringify(pathToFileURL(cli).href)});\n`);
      chmodSync(join(dir, "npm"), 0o755);
    }
    const { scripts } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const result = spawnSync(scripts.check, {
      shell: true, cwd: ROOT, encoding: "utf8", timeout: 10_000,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, npm_execpath: cli,
        SANNR_CHECK_TEST_LOG: log, SANNR_STRESS_LOCAL: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").map(JSON.parse), [
      { args: ["test"], local: null },
      { args: ["run", "test:truth"], local: null },
      { args: ["run", "test:stress"], local: null },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
