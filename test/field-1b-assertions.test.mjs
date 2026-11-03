import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkOne, runAssertions, unsafePattern, OPERATORS } from '../lib/assertions.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const pattern = '^a+a+$';
const reason = 'contains multiple variable repetitions';
const context = { status: 200, headers: {}, body: { state: 'ready', count: 19 } };

function run(cwd, env, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    child.stdin.end(input);
  });
}

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'field-assertions-')), home = join(root, 'home');
  mkdirSync(home);
  const server = spawn(process.execPath, [join(source, 'test/fixtures/field-batch-server.mjs')],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(async () => {
    if (server.exitCode === null) { const ended = once(server, 'exit'); server.kill('SIGTERM'); await ended; }
    rmSync(root, { recursive: true, force: true });
  });
  const [{ origin }] = await once(server, 'message');
  const evidence = join(root, 'evidence');
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'machine'),
    API_CONTEXT_DIR: root, API_CONTEXT_OFF: '1', API_USAGE_LOG: join(root, 'usage.jsonl'),
    API_EVIDENCE: evidence, API_BASE_URL: origin, API_TIMEOUT_MS: '1000', API_BUDGET: '800', NO_COLOR: '1' };
  return { async execute(expect, cli = false) {
    const request = { protocol: 'http', method: 'GET', path: '/health', expect };
    const args = cli ? [join(source, 'bin/cli.mjs'), 'protocol', join(root, 'request.json')]
      : ['--input-type=module', '-e', `import {apiRequest} from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)};let input='';for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify(await apiRequest(JSON.parse(input))));`];
    if (cli) writeFileSync(join(root, 'request.json'), JSON.stringify(request));
    const out = await run(root, env, args, JSON.stringify(request));
    assert.equal(out.signal, null, out.stderr);
    assert.ok(out.stdout.trim(), out.stderr);
    const result = JSON.parse(out.stdout);
    assert.match(result.evidence, /^run-/);
    assert.ok(readdirSync(evidence).includes(`${result.evidence}.json`), 'the response has actual private execution evidence');
    assert.ok(Math.ceil(JSON.stringify(result).length / 4) <= 800, 'the complete returned envelope fits the requested budget');
    return { ...out, result };
  } };
}

for (const cli of [false, true]) test(`CLI-003 ${cli ? 'CLI' : 'client'} names a safety-refused regex after an actual response`, async t => {
  const f = await fixture(t);
  const { result } = await f.execute([{ status: 200 }, { json: 'state', matches: pattern }], cli);
  assert.equal(result.status, 200);
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'assert');
  assert.equal(result.assertions.passed, 1);
  assert.equal(result.assertions.failed, 1);
  assert.deepEqual(result.assertions.failures[0], { target: 'json', path: 'state', op: 'matches',
    expected: pattern, actual: 'ready', refused_ops: ['matches'], code: 'ASSERTION_PATTERN_REFUSED', reason });
});

test('CLI-003 a later regex refusal survives an earlier mismatch on the actual client path', async t => {
  const f = await fixture(t);
  const { result } = await f.execute([{ json: 'state', equals: 'wrong', matches: pattern, length: 5 }]);
  assert.equal(result.ok, false);
  assert.equal(result.assertions.failed, 1);
  assert.deepEqual(result.assertions.failures[0], { target: 'json', path: 'state', op: 'equals',
    expected: 'wrong', actual: 'ready', ops: ['equals', 'matches', 'length'],
    refused_ops: ['matches'], code: 'ASSERTION_PATTERN_REFUSED', reason });
});

test('CLI-003 safe matches and genuine mismatches keep their prior request shape', async t => {
  const f = await fixture(t);
  const good = (await f.execute([{ json: 'state', matches: '^r.*y$' }])).result;
  assert.equal(good.ok, true); assert.equal(good.assertions.passed, 1); assert.equal(good.data, null);
  const bad = (await f.execute([{ json: 'state', matches: '^wrong$' }])).result;
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.assertions.failures[0], { target: 'json', path: 'state', op: 'matches', expected: '^wrong$', actual: 'ready' });
});

test('CLI-003 every existing safety guard returns its exact reason without evaluating the refused pattern', () => {
  for (const pattern of [null, 'x'.repeat(201), '(a+)+$', '(a|aa)+$', '(?=a)a', '(a)\\1', '^a+a+$', 'a{1001}']) {
    const why = unsafePattern(pattern);
    assert.equal(typeof why, 'string');
    const result = checkOne({ json: 'state', matches: pattern }, context);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'ASSERTION_PATTERN_REFUSED');
    assert.equal(result.reason, why);
    assert.deepEqual(result.refused_ops, ['matches']);
    assert.equal('ops' in result, false);
  }
  assert.equal(OPERATORS.matches('a'.repeat(40) + '!', '(a+)+$'), false, 'the lower-level boolean guard still refuses without compiling');
});

test('CLI-003 refusal is invalid evidence even after another operator fails; safe non-string mismatch remains ordinary', () => {
  const outcomes = [];
  const result = runAssertions([
    { json: 'state', matches: pattern, length: 5 },
    { json: 'count', type: 'string', matches: pattern },
    { json: 'count', matches: '^19$' },
  ], context, { onClause: outcome => outcomes.push(outcome) });
  assert.equal(result.passed, 0); assert.equal(result.failed, 3);
  assert.equal(result.failures[0].op, 'matches');
  assert.equal(result.failures[1].op, 'type');
  assert.deepEqual(result.failures[1].refused_ops, ['matches']);
  assert.deepEqual(result.failures[2], { target: 'json', path: 'count', op: 'matches', expected: '^19$', actual: 19 });
  assert.deepEqual(outcomes, [{ index: 0, ok: false, invalid: true }, { index: 1, ok: false, invalid: true },
    { index: 2, ok: false, invalid: false }]);
});
