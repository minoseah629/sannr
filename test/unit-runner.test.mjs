import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = () => import('../scripts/test-unit.mjs');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'unit-runner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  for (const name of ['z.test.mjs', 'api-map.test.mjs', 'a.test.mjs', 'helper.mjs'])
    writeFileSync(join(root, 'test', name), '');
  mkdirSync(join(root, 'test', 'nested'));
  writeFileSync(join(root, 'test', 'nested', 'extra.test.mjs'), '');
  return root;
}
const summary = (overrides = {}) => ({ tests: 2, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0, ...overrides });

test('product and research suites partition discovery without dropping new regressions', async t => {
  const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'))).scripts;
  assert.equal(scripts['test:full'], 'node scripts/test-unit.mjs',
    'product qualification must keep discovering regressions outside the fast safety set');
  // The public source cut omits the research-only scripts together (see
  // scripts/stage-public-source.mjs); the private checkout keeps test:research
  // wired to this runner. Either way the runner itself still refuses below.
  if (scripts['test:external'] === undefined)
    assert.equal(scripts['test:research'], undefined, 'the public tree omits test:research with test:external');
  else assert.equal(scripts['test:research'], 'node scripts/test-unit.mjs --research');
  const { unitTestPlan, runUnitTests, RESEARCH_TEST_FILES } = await runner();
  const root = fixture(t);
  for (const name of RESEARCH_TEST_FILES) writeFileSync(join(root, 'test', name), '');
  const plan = unitTestPlan(root);
  assert.deepEqual(plan.map(phase => phase.files), [
    [join(root, 'test', 'api-map.test.mjs')],
    [join(root, 'test', 'a.test.mjs'), join(root, 'test', 'z.test.mjs')],
  ]);
  assert.deepEqual(unitTestPlan(root, { research: true }).flatMap(phase => phase.files),
    RESEARCH_TEST_FILES.map(name => join(root, 'test', name)));
  // Public source uses its own filtered inventory, not a private fixed list.
  for (const name of RESEARCH_TEST_FILES) rmSync(join(root, 'test', name));
  rmSync(join(root, 'test', 'z.test.mjs'));
  assert.deepEqual(unitTestPlan(root)[1].files, [join(root, 'test', 'a.test.mjs')]);
  assert.throws(() => unitTestPlan(root, { research: true }), /Research suite unavailable.*private source checkout/);
  const refusal = [];
  assert.equal(await runUnitTests({ root, research: true, write: chunk => refusal.push(chunk),
    execute: async () => assert.fail('unavailable research must not launch any child') }), 1);
  assert.match(refusal.join(''), /Research suite unavailable.*private source checkout/);
  // Partial private checkouts must not report a truncated research suite green.
  for (const name of RESEARCH_TEST_FILES.slice(1)) writeFileSync(join(root, 'test', name), '');
  assert.throws(() => unitTestPlan(root, { research: true }), /Research suite unavailable/);
});

test('default safety plan is bounded, includes its declared files once, and refuses missing coverage', async t => {
  const { unitTestPlan, SAFETY_TEST_FILES, RESEARCH_TEST_FILES } = await runner();
  assert.equal(JSON.parse(readFileSync(join(ROOT, 'package.json'))).scripts.test, 'node scripts/test-unit.mjs --safety');
  const root = fixture(t);
  for (const name of SAFETY_TEST_FILES) writeFileSync(join(root, 'test', name), '');
  const selected = unitTestPlan(root, { safety: true }).flatMap(phase => phase.files);
  assert.deepEqual(selected, SAFETY_TEST_FILES.map(name => join(root, 'test', name)));
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(SAFETY_TEST_FILES.filter(name => RESEARCH_TEST_FILES.includes(name)), [],
    'the default safety set contains no private research fixture');
  assert.ok(!selected.includes(join(root, 'test', 'api-map.test.mjs')));
  assert.ok(!selected.includes(join(root, 'test', 'z.test.mjs')), 'new unrelated tests do not silently expand the smoke check');
  rmSync(join(root, 'test', SAFETY_TEST_FILES[0]));
  assert.throws(() => unitTestPlan(root, { safety: true }), /Missing safety test/);
});

test('a green exit with zero passing tests cannot qualify any lane', async t => {
  const { runUnitTests, SAFETY_TEST_FILES, RESEARCH_TEST_FILES } = await runner();
  const root = fixture(t);
  for (const name of [...SAFETY_TEST_FILES, ...RESEARCH_TEST_FILES]) writeFileSync(join(root, 'test', name), '');
  for (const lane of [{ safety: true }, {}, { research: true }]) {
    for (const counts of [summary({ tests: 0, pass: 0 }), summary({ pass: 0, skipped: 2 })]) {
      const code = await runUnitTests({ root, ...lane, write: () => {}, execute: async () => ({ code: 0, counts }) });
      assert.equal(code, 1, 'an empty selection or all-skipped suite is not a passing check');
    }
  }
});

test('suite commands reject filtering instead of counting empty Node file wrappers as passes', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  for (const lane of [[], ['--safety'], ['--research']]) {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts/test-unit.mjs'), ...lane,
      '--test-name-pattern=__no_test_matches_this_pattern__'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /node --test/);
    assert.doesNotMatch(result.stdout, /# pass \d/);
  }
  const conflict = spawnSync(process.execPath, [join(ROOT, 'scripts/test-unit.mjs'), '--safety', '--research'],
    { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stdout + conflict.stderr, /Choose one suite/);
});

test('unit gate waits for the isolated phase, retains both failures and emits combined counts', async t => {
  const { runUnitTests } = await runner();
  const root = fixture(t), calls = [], output = [];
  let release;
  const first = new Promise(resolve => { release = resolve; });
  const running = runUnitTests({ root, write: chunk => output.push(chunk), execute: async phase => {
    calls.push(phase.files);
    if (calls.length === 1) { await first; return { code: 1, counts: summary({ pass: 1, fail: 1 }) }; }
    return { code: 0, counts: summary({ tests: 3, skipped: 1 }) };
  } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 1, 'no sibling test process may overlap the CPU measurement');
  release();
  assert.equal(await running, 1, 'a failed budget phase cannot be hidden by a passing concurrent phase');
  assert.equal(calls.length, 2, 'still report the remaining suite after a budget failure');
  const report = output.join('');
  for (const line of ['# tests 5', '# pass 3', '# fail 1', '# skipped 1']) assert.ok(report.includes(line), line);
});

test('unit gate refuses missing CPU coverage or a child without its final summary', async t => {
  const { unitTestPlan, runUnitTests } = await runner();
  const root = fixture(t);
  assert.equal(await runUnitTests({ root, write: () => {}, execute: async () => ({ code: 0 }) }), 1,
    'a truncated or incompatible child report must not silently pass');
  rmSync(join(root, 'test', 'api-map.test.mjs'));
  assert.throws(() => unitTestPlan(root), /api-map.test.mjs/);
});

test('unit gate preserves native failure and skip names and totals from real child runners', async t => {
  const { spawn } = await import('node:child_process');
  const { pathToFileURL } = await import('node:url');
  const root = fixture(t);
  const marker = join(root, 'isolated-complete');
  writeFileSync(join(root, 'test', 'api-map.test.mjs'), `
    import test from 'node:test';
    import { writeFileSync } from 'node:fs';
    test('isolated fixture completes first', async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
      writeFileSync(${JSON.stringify(marker)}, 'complete');
    });
  `);
  writeFileSync(join(root, 'test', 'a.test.mjs'), `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    import { existsSync } from 'node:fs';
    test('remaining fixture sees completed isolated phase', () => assert.ok(existsSync(${JSON.stringify(marker)})));
    test('named synthetic unavailable prerequisite', { skip: 'synthetic gate specimen' }, () => {});
  `);
  writeFileSync(join(root, 'test', 'z.test.mjs'), `
    import test from 'node:test';
    import assert from 'node:assert/strict';
    test('named synthetic assertion failure', () => assert.fail('intentional fixture failure'));
  `);
  const source = `import { runUnitTests } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/test-unit.mjs')).href)};
    process.exitCode = await runUnitTests({ root: ${JSON.stringify(root)} });`;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', source], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 1, stderr);
  assert.match(stdout, /ok 1 - API map \(isolated CPU budget\)/);
  assert.match(stdout, /not ok 2 - Remaining product regressions/);
  assert.match(stdout, /named synthetic unavailable prerequisite.*# SKIP synthetic gate specimen/);
  assert.match(stdout, /not ok \d+ - named synthetic assertion failure/);
  assert.equal((stdout.match(/^TAP version 13$/gm) ?? []).length, 1, 'one outer TAP document');
  for (const line of ['# tests 4', '# pass 2', '# fail 1', '# skipped 1'])
    assert.ok(stdout.split('\n').includes(line), `${line}\n${stdout}`);
  // CI, release and publish summaries use this anchored selector: indented
  // per-phase summaries must not be mistaken for complete gate totals.
  assert.deepEqual(stdout.match(/^(?:ℹ|#) (?:tests|pass|fail|skipped).*$/gm),
    ['# tests 4', '# pass 2', '# fail 1', '# skipped 1']);
  assert.ok(stdout.split('\n').filter(line => /# SKIP/.test(line))
    .some(line => line.includes('named synthetic unavailable prerequisite')));
});
