// npm test is the fast, local safety net; test:full discovers product
// regressions, and test:research explicitly selects the private research rig.
// Product qualification isolates the map CPU measurement before other files.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const COUNT_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];
// This reviewed inventory already owns the product/research boundary. Reuse it
// rather than maintaining a second list that can drift. Keep the original test
// paths: preregistrations and historical research receipts refer to them.
export const RESEARCH_TEST_FILES = Object.freeze(JSON.parse(readFileSync(
  new URL('../packaging/public-source-files.json', import.meta.url), 'utf8'))
  .excluded_files.filter(path => /^test\/[^/]+\.test\.mjs$/.test(path))
  .map(path => path.slice('test/'.length)).sort());
// Keep this list deliberate: new feature regressions belong in focused/full
// runs unless they protect these core promises. No corpus, daemon or live API.
export const SAFETY_TEST_FILES = Object.freeze([
  'assertions.test.mjs',              // unknown assertions never pass green
  'suite.test.mjs',                   // assertions required; corrupt suites refuse
  'env-selection.test.mjs',           // requested environment or a hard error
  'promote.test.mjs',                 // only safe API knowledge is persisted
  'hardening-security.test.mjs',      // secrets, redirects, traversal and symlinks
  'basic-auth.test.mjs',              // credential isolation and echo redaction
  'context-concurrency.test.mjs',     // no lost updates or partial knowledge files
  'output-atomic.test.mjs',           // failed evidence writes preserve old bytes
  'evidence.test.mjs',                // truthful evidence and execution boundaries
  'request-evidence-origin.test.mjs', // actual CLI/MCP execution identity
  'request-routing-fields.test.mjs',  // untrusted fields cannot reroute execution
  'feedback-send-qa.test.mjs',        // consent, private receipts, no silent sends
  'package.test.mjs',                // packed CLI, connect, skills and MCP boot
  'unit-runner.test.mjs',             // the check cannot swallow failures
]);

export function unitTestPlan(root = ROOT, { safety = false, research = false } = {}) {
  if (safety && research) throw new Error('Choose one suite: safety, product, or research.');
  const directory = join(root, 'test');
  if (research) {
    const files = RESEARCH_TEST_FILES.map(name => join(directory, name));
    const missing = files.filter(file => !statSync(file, { throwIfNoEntry: false })?.isFile());
    if (!files.length || missing.length) throw new Error(
      `Research suite unavailable: use the complete private source checkout; ${missing.length} declared research files missing.`);
    return [{ name: 'Private research fixtures (not a live campaign)', files }];
  }
  if (safety) {
    const files = SAFETY_TEST_FILES.map(name => join(directory, name));
    for (const file of files) {
      if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing safety test: ${file}`);
    }
    return [{ name: 'Core safety (local fixtures; not full qualification)', files }];
  }
  const files = readdirSync(directory, { withFileTypes: true })
    // New/unclassified tests remain product regressions. Only explicit reviewed
    // research exclusions leave this lane; filename prefixes are not a policy.
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs') && !RESEARCH_TEST_FILES.includes(entry.name))
    .map(entry => join(directory, entry.name)).sort();
  const isolated = join(directory, 'api-map.test.mjs');
  if (!files.includes(isolated)) throw new Error('Unit gate is missing api-map.test.mjs and its CPU-budget coverage.');
  return [{ name: 'API map (isolated CPU budget)', files: [isolated] },
    { name: 'Remaining product regressions', files: files.filter(file => file !== isolated) }]
    .filter(phase => phase.files.length);
}

function executePhase(phase, { root, write }) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...phase.files],
      { cwd: root, stdio: ['inherit', 'pipe', 'inherit'] });
    const counts = {};
    let pending = '';
    const line = text => {
      if (text === 'TAP version 13') return;
      const count = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(text);
      if (count) counts[count[1]] = Number(count[2]);
      // Native TAP is nested as a phase, so skip names and assertion details
      // survive and the outer report remains one valid TAP stream.
      write(`    ${text}\n`);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        line(pending.slice(0, end).replace(/\r$/, ''));
        pending = pending.slice(end + 1);
      }
    });
    child.on('error', error => write(`    # Child start failed: ${String(error.message).replace(/[\r\n]/g, ' ')}\n`));
    child.on('close', (code, signal) => {
      if (pending) line(pending);
      if (signal) write(`    # Child terminated by ${signal}\n`);
      resolveResult({ code: code ?? 1, counts });
    });
  });
}

export async function runUnitTests({ root = ROOT, safety = false, research = false, args = [], write = chunk => process.stdout.write(chunk), execute = executePhase } = {}) {
  // Node can count an empty, filtered file wrapper as a pass. Suite commands
  // promise the whole declared set; focused selections use Node directly.
  if (args.length) {
    write('Suite commands do not accept extra flags or files. For focused checks use node --test <options> test/<area>.test.mjs.\n');
    return 1;
  }
  let plan;
  try { plan = unitTestPlan(root, { safety, research }); }
  catch (error) { write(`Suite planning failed: ${error.message}\n`); return 1; }
  const totals = Object.fromEntries(COUNT_KEYS.map(key => [key, 0]));
  let failed = false;
  const started = performance.now();
  write('TAP version 13\n');
  for (const [index, phase] of plan.entries()) {
    write(`# Subtest: ${phase.name}\n`);
    const result = await execute(phase, { root, write });
    const complete = COUNT_KEYS.every(key => Number.isInteger(result.counts?.[key]) && result.counts[key] >= 0);
    const passed = complete && result.code === 0 && result.counts.pass > 0 && result.counts.fail === 0 && result.counts.cancelled === 0;
    if (!complete) write('    # Incomplete child summary; this phase did not qualify.\n');
    else if (result.counts.pass === 0) write('    # No passing tests; this phase did not qualify.\n');
    failed ||= !passed;
    if (complete) for (const key of COUNT_KEYS) totals[key] += result.counts[key];
    write(`${passed ? 'ok' : 'not ok'} ${index + 1} - ${phase.name}\n`);
  }
  write(`1..${plan.length}\n# Combined unit-test counts (phase wrappers are not additional tests)\n`);
  for (const key of COUNT_KEYS) write(`# ${key} ${totals[key]}\n`);
  write(`# duration_ms ${(performance.now() - started).toFixed(3)}\n`);
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  process.exitCode = await runUnitTests({ safety: args.includes('--safety'), research: args.includes('--research'),
    args: args.filter(arg => arg !== '--safety' && arg !== '--research') });
}
