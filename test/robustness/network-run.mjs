import { runNetwork, defective, table, summary } from './network-driver.mjs';
const iterations = Math.max(1, Number.parseInt(process.env.SANNR_NETWORK_ITERATIONS ?? '3', 10) || 3);
const started = performance.now();
const results = await runNetwork(iterations);
for (const row of results) console.log(`${row.entry} × ${row.variation} × ${row.index}: ${row.outcome}${row.code ? ` (${row.code})` : ''}${row.violations.length ? ` violations=${row.violations.join(',')}` : ''}`);
console.log(JSON.stringify({ ...summary(results), defects: results.filter(defective).length, iterations, wallMs: performance.now() - started }));
process.exitCode = results.some(defective) ? 1 : 0;
