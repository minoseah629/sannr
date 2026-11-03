// Extended robustness run — a LOCAL yardstick, never the gate.
//   npm run test:robustness
//   SANNR_ROBUSTNESS_CORPUS=../import-corpus SANNR_ROBUSTNESS_ITERATIONS=5 SANNR_ROBUSTNESS_SEED=1 npm run test:robustness
// Walks the corpus directory (default: the in-repo seeds), classifies every
// readable file to an entry point by shape, runs every variation class for
// the requested number of indexes in a worker per source with the same
// deadline and memory bound as the gate, and prints the outcome table, the
// summary, and every defect as a reproducible triple. Exit 1 on any defect.
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { SEEDS_DIR, textSources, directorySources, runAll, reproduce, table, summary } from "./driver.mjs";

const corpus = resolve(process.env.SANNR_ROBUSTNESS_CORPUS ?? SEEDS_DIR);
const iterations = Math.max(1, Number.parseInt(process.env.SANNR_ROBUSTNESS_ITERATIONS ?? "3", 10) || 3);
const seed = Number.parseInt(process.env.SANNR_ROBUSTNESS_SEED ?? "1", 10) || 1;
if (!statSync(corpus, { throwIfNoEntry: false })?.isDirectory()) {
  console.error(`SANNR_ROBUSTNESS_CORPUS is not a directory: ${corpus}`);
  process.exit(2);
}
const started = performance.now();
const sources = [...textSources(corpus), ...directorySources(corpus)];
console.log(`robustness run — corpus ${corpus}: ${sources.length} sources, seed ${seed}, ${iterations} index(es) per class`);
const results = await runAll(sources, { seed, iterations });
const rows = table(results);
const width = Math.max(...rows.map((r) => r.entry.length));
console.log(`\n${"entry".padEnd(width)}  ${"variation".padEnd(20)} result  named  harness  defect`);
for (const r of rows) console.log(`${r.entry.padEnd(width)}  ${r.variation.padEnd(20)} ${String(r.result).padStart(6)} ${String(r.named).padStart(6)} ${String(r.harness).padStart(8)} ${String(r.defect).padStart(7)}`);
const report = summary(results);
console.log(`\ninputs ${report.inputs}  results ${report.results}  named ${report.named}  harness ${report.harness}  defects ${report.defects}  max ${report.maxMs.toFixed(0)} ms  max rss delta ${(report.maxRssDelta / 1048576).toFixed(1)} MB  wall ${((performance.now() - started) / 1000).toFixed(1)} s`);
if (report.defects) {
  const rerun = await reproduce(results);
  console.log("\nfindings (each line is a reproducible seed/source/index triple):");
  for (const d of rerun) console.log(`  ${d.reproduced ? "reproducible" : "NOT reproducible"}: ${d.outcome}${d.leaks.length ? ` leaks=${d.leaks.join(",")}` : ""} — ${d.entry} ${d.variation} seed=${seed} source=${d.source} index=${d.index}: ${d.message}`);
  process.exit(1);
}
