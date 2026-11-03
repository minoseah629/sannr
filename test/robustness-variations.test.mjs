import { LAYOUT } from "../lib/layout.mjs";
// ROB-1 gate: every importer entry point survives deterministic variations of
// the in-repo seeds. Hermetic by construction — the seeds live in the
// repository, so a clean CI runner runs exactly what a laptop runs. The
// sibling corpora are the extended mode (`npm run test:robustness`), never
// this gate. A "defect" is any native exception, uncoded error, timeout,
// worker death, memory blow-up, or planted value crossing into an output
// surface; the assertion message lists each one as a reproducible triple.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync,  rmSync, existsSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SEEDS_DIR, MEMORY_BOUND, textSources, directorySources, runAll, reproduce, table, summary, isDefect } from "./robustness/driver.mjs";
import { vary, TEXT_CLASSES, DIRECTORY_CLASSES } from "./robustness/variations.mjs";

const CLI = fileURLToPath(new URL("../bin/cli.mjs", import.meta.url));
const GATE_BUDGET_MS = 30_000;

test("ROB-1 every entry point returns a result or a named failure for every seed variation, within bounds", async (t) => {
  const started = performance.now();
  const sources = [...textSources(SEEDS_DIR), ...directorySources(SEEDS_DIR)];
  assert.ok(sources.length >= 8, `seed inventory is thinner than expected: ${sources.map((s) => s.name).join(", ")}`);
  const results = await runAll(sources, { seed: 1, iterations: 3 });
  const elapsed = performance.now() - started;
  const report = summary(results);
  for (const row of table(results)) t.diagnostic(`${row.entry.padEnd(24)} ${row.variation.padEnd(18)} result=${row.result} named=${row.named} harness=${row.harness} defect=${row.defect}`);
  t.diagnostic(`inputs=${report.inputs} results=${report.results} named=${report.named} harness=${report.harness} defects=${report.defects} maxMs=${report.maxMs.toFixed(0)} maxRssDeltaMB=${(report.maxRssDelta / 1048576).toFixed(1)} elapsedMs=${elapsed.toFixed(0)}`);
  assert.equal(results.length, 3 * TEXT_CLASSES.length * textSources(SEEDS_DIR).length + DIRECTORY_CLASSES.length * directorySources(SEEDS_DIR).length, "every class ran for every source and index");
  assert.ok(report.harness < report.inputs / 4, `the harness itself produced too many unparseable inputs: ${report.harness}/${report.inputs}`);
  if (report.defects) {
    const rerun = await reproduce(results);
    assert.fail(`robustness defects (each reproduces from seed/source/index):\n  ${rerun.map((d) => `${d.reproduced ? "reproducible" : "NOT reproducible"}: ${d.outcome}${d.leaks.length ? ` leaks=${d.leaks.join(",")}` : ""} — ${d.entry} ${d.variation} seed=1 source=${d.source} index=${d.index}: ${d.message}`).join("\n  ")}`);
  }
  assert.ok(report.maxRssDelta <= MEMORY_BOUND, `memory growth ${report.maxRssDelta} exceeded the ${MEMORY_BOUND} bound`);
  assert.ok(elapsed < GATE_BUDGET_MS, `the gate share ran ${elapsed.toFixed(0)} ms; the bound is ${GATE_BUDGET_MS} ms`);
});

test("ROB-1 variations are pure functions of seed, source, and index", () => {
  const source = textSources(SEEDS_DIR)[0];
  for (const variation of TEXT_CLASSES) {
    const a = vary(source.text, { seed: 7, source: source.name, index: 3, variation, entry: source.entry });
    const b = vary(source.text, { seed: 7, source: source.name, index: 3, variation, entry: source.entry });
    assert.equal(a, b, `${variation} is not deterministic`);
  }
  const x = vary(source.text, { seed: 7, source: source.name, index: 3, variation: "truncate", entry: source.entry });
  const y = vary(source.text, { seed: 8, source: source.name, index: 3, variation: "truncate", entry: source.entry });
  assert.notEqual(x, y, "a different seed produces a different truncation");
});

test("ROB-1 a defect classified once is classified the same way again", async () => {
  // The determinism guarantee must hold for the defect classifier itself, not
  // only for the variation text: run the same jobs twice and compare classes.
  const source = textSources(SEEDS_DIR).find((s) => s.entry === "importPostman");
  const first = await runAll([source], { seed: 3, iterations: 1 });
  const second = await runAll([source], { seed: 3, iterations: 1 });
  assert.deepEqual(first.map((r) => r.outcome), second.map((r) => r.outcome));
  assert.equal(first.some(isDefect), false, "the Postman seed produces no defects at seed 3");
});

test("ROB-1 the CLI import path exits with a named code and never a stack trace on varied input", (t) => {
  const root = mkdtempSync(join(tmpdir(), "sannr-rob-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sources = textSources(SEEDS_DIR).filter((s) => s.kind !== "parsed-yaml").slice(0, 4);
  for (const [n, source] of sources.entries()) {
    const variation = ["truncate", "bracket-swap", "byte-substitution", "malformed-field"][n % 4];
    const text = vary(source.text, { seed: 11, source: source.name, index: n, variation, entry: source.entry });
    const file = join(root, source.name.replace(/\//g, "_"));
    writeFileSync(file, text);
    const cli = spawnSync(process.execPath, [CLI, "import", file, "--dry-run"], { cwd: root, encoding: "utf8", timeout: 10_000 });
    const out = `${cli.stdout}\n${cli.stderr}`;
    assert.ok(cli.status === 0 || cli.status === 1, `${source.name} ${variation}: exit ${cli.status} signal ${cli.signal}`);
    assert.doesNotMatch(out, /\n\s+at |TypeError|RangeError|SyntaxError|ReferenceError|Maximum call stack/, `${source.name} ${variation} leaked a stack or native error:\n${out.slice(0, 400)}`);
    assert.doesNotMatch(out, /ROB1_AUTH_VALUE_|ROB1_ENV_VALUE_/, `${source.name} ${variation} printed a planted value`);
    if (cli.status === 1) assert.match(out, /[A-Z][A-Z_]{5,}/, `${source.name} ${variation}: a refusal must carry a named code:\n${out.slice(0, 300)}`);
  }
  assert.equal(existsSync(join(root, LAYOUT.context)), false, "a dry run writes no knowledge file");
});
