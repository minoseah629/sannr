import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSuite, serializeSuite, suiteSecretProblems, suiteReport } from '../lib/suites.mjs';
import { readOnlyPlan } from '../lib/verify.mjs';
import { PROJECT_DIR_NAME, HOME_ENV_NAME } from '../lib/brand.mjs';
const source = fileURLToPath(new URL('../', import.meta.url));
const sid = 'AC' + 'a'.repeat(32);
function run(cwd, env, args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', c => { stdout += c; }); child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr })); child.stdin.end(input);
  });
}
async function fixture(t, stacks = false) {
  const root = mkdtempSync(join(tmpdir(), 'field-batch-')); const home = join(root, 'home'); mkdirSync(home);
  const child = spawn(process.execPath, [join(source, 'test/fixtures/field-batch-server.mjs')], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const [{ origin }] = await once(child, 'message');
  t.after(async () => { if (child.exitCode === null) { const ended = once(child, 'exit'); child.kill('SIGTERM'); await ended; } rmSync(root, { recursive: true, force: true }); });
  if (stacks) for (const name of ['alpha', 'beta']) {
    const dir = join(root, PROJECT_DIR_NAME, 'stacks', name); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'stack.json'), JSON.stringify({ v: 1, name, default_environment: 'local', environments: {
      local: { baseUrl: `${origin}/${name}` }, other: { baseUrl: `${origin}/${name}` },
    } }));
  }
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, 'machine'), API_CONTEXT_DIR: root,
    API_CONTEXT_OFF: '1', API_USAGE_LOG: join(root, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence'),
    API_ALLOW_PRODUCTION_WRITES: '1', API_TIMEOUT_MS: '1000', API_BUDGET: '4000', NO_COLOR: '1', ...(stacks ? {} : { API_BASE_URL: origin }) };
  return { root, env, async execute(envelope, cli = false) {
    const args = cli ? [join(source, 'bin/cli.mjs'), 'protocol', join(root, 'envelope.json')]
      : ['--input-type=module', '-e', `import {runEnvelope} from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)};let text='';for await(const c of process.stdin)text+=c;console.log(JSON.stringify(await runEnvelope(JSON.parse(text))));`];
    if (cli) { envelope = { ...envelope, requests: envelope.requests.map(r => ({ protocol: 'http', ...r })), ...(envelope.finally ? { finally: envelope.finally.map(r => ({ protocol: 'http', ...r })) } : {}) }; writeFileSync(join(root, 'envelope.json'), JSON.stringify(envelope)); }
    const out = await run(root, env, args, JSON.stringify(envelope));
    assert.ok(out.stdout.trim(), out.stderr); return { ...out, result: JSON.parse(out.stdout) };
  } };
}
const create = (extra = {}) => ({ id: 'create-file', method: 'POST', path: '/files', expect: [{ status: 201 }], capture: { fileId: 'id' }, ...extra });
const remove = (extra = {}) => ({ id: 'delete-file', method: 'DELETE', path: '/files/{fileId}', expect: [{ status: 200 }], ...extra });

for (const cli of [false, true]) test(`CAPTURE-001 ${cli ? 'CLI' : 'library'} hides captures everywhere, including paths, bodies and assertion diagnostics`, async t => {
  const f = await fixture(t);
  {
    const { result, stdout } = await f.execute({ requests: [create(), { path: '/files/{fileId}', expect: [{ json: 'id', equals: 'wrong' }] }] }, cli);
    assert.equal(stdout.includes(sid), false, 'captured SID must not occur anywhere in the returned envelope');
    assert.deepEqual(result.captured.fileId, { type: 'string', length: 34 });
    assert.equal(result.results[1].assertions.failed, 1);
  }
});
test('CAPTURE-001 explicit reveal returns captured values; nonboolean opt-ins refuse before traffic', async t => {
  const f = await fixture(t); const { result } = await f.execute({ reveal_captures: true, requests: [create()] });
  assert.equal(result.captured.fileId, sid);
  const refused = (await f.execute({ reveal_captures: 'true', requests: [create()] })).result;
  assert.equal(refused.error?.code, 'REVEAL_CAPTURES_INVALID'); assert.equal(refused.attempted, 0);
});
test('CLI-004 expect placeholders preserve captured scalar and nested types', async t => {
  const f = await fixture(t); const { result } = await f.execute({ requests: [create({ capture: { fileId: 'id', count: 'numericId', object: 'nested', list: 'ids' } }),
    { path: '/files/{fileId}', expect: [{ json: 'id', equals: '{fileId}' }, { json: 'numericId', equals: '{count}' },
      { json: 'nested', equals: '{object}' }, { json: 'ids', equals: '{list}' }] }] });
  assert.equal(result.ok, true); assert.equal(result.results[1].assertions.passed, 4);
  assert.deepEqual(result.captured.count, { type: 'number' }); assert.deepEqual(result.captured.list, { type: 'array', length: 1 });
});
test('CLI-004 an unresolved expect placeholder refuses that step before traffic', async t => {
  const f = await fixture(t); const { result } = await f.execute({ requests: [{ path: '/files', expect: [{ json: 'id', equals: '{missing}' }] }] });
  assert.equal(result.results[0].error?.code, 'UNRESOLVED_PLACEHOLDER'); assert.equal(result.attempted, 0);
});
test('CLI-004 finally deletes after a failed create assertion and preserves that failure', async t => {
  const f = await fixture(t); const { result } = await f.execute({ requests: [create({ expect: [{ status: 200 }] }), { path: '/unreached' }], finally: [remove()] });
  assert.equal(result.ok, false); assert.equal(result.results.length, 1); assert.equal(result.results[0].assertions.failed, 1);
  assert.equal(result.finally[0].status, 200); assert.equal(result.attempted, 2); assert.equal(result.stopped_early, true);
  assert.deepEqual(result.left_behind, []); assert.equal(JSON.stringify(result).includes(sid), false);
});
test('CLI-004 finally delete 401 names an orphan without its value and still executes remaining cleanup', async t => {
  const f = await fixture(t); const { result } = await f.execute({ requests: [create(), { path: '/files/{fileId}', expect: [{ status: 404 }] }],
    finally: [remove({ path: '/files/{fileId}?refused=1' }), { id: 'last-cleanup', path: '/health', expect: [{ status: 200 }] }] });
  assert.equal(result.finally.length, 2); assert.equal(result.finally[1].ok, true);
  assert.deepEqual(result.left_behind, [{ created_by: 'create-file', capture: 'fileId', delete_status: 401 }]);
  assert.equal(JSON.stringify(result).includes(sid), false);
});
test('CLI-004 transport failures run finally and keep prior evidence and attempt counts', async t => {
  const f = await fixture(t); const { result } = await f.execute({ requests: [create(), { path: '/disconnect' }], finally: [remove()] });
  assert.equal(result.ok, false); assert.equal(result.results.length, 2); assert.ok(result.results[0].evidence);
  assert.equal(result.results[1].error?.kind, 'transport'); assert.equal(result.finally[0].status, 200); assert.equal(result.attempted, 3);
  assert.deepEqual(result.left_behind, []);
});
test('CLI-004 failed creates cannot supply cleanup captures; malformed finally refuses atomically', async t => {
  const f = await fixture(t);
  const { result } = await f.execute({ requests: [create({ path: '/error' })], finally: [remove()] });
  assert.equal(result.finally[0].error?.code, 'UNRESOLVED_PLACEHOLDER'); assert.deepEqual(result.left_behind, []); assert.equal(result.attempted, 1);
  for (const cleanup of [{ path: '/files' }, [null]]) {
    const invalid = (await f.execute({ requests: [create()], finally: cleanup })).result;
    assert.equal(invalid.attempted, 0); assert.equal(invalid.error?.code, 'FINALLY_INVALID');
  }
});
test('CLI-004 only same-scope DELETE using the exact captured binding retires a create', async t => {
  const f = await fixture(t, true);
  for (const cleanup of [remove({ stack: 'beta' }), remove({ environment: 'other' }), remove({ path: `/files/${sid}` })]) {
    const { result } = await f.execute({ stack: 'alpha', requests: [create()], finally: [cleanup] });
    assert.deepEqual(result.left_behind, [{ created_by: 'create-file', capture: 'fileId' }]);
  }
  const good = (await f.execute({ stack: 'alpha', requests: [create()], finally: [remove({ path: '/files', params: { id: '{fileId}' } })] })).result;
  assert.deepEqual(good.left_behind, [{ created_by: 'create-file', capture: 'fileId' }]);
});
test('CLI-004 capture name reuse does not let a later delete erase the earlier creation', async t => {
  const f = await fixture(t); const { result } = await f.execute({ requests: [create(), create({ id: 'second' })], finally: [remove()] });
  assert.deepEqual(result.left_behind, [{ created_by: 'create-file', capture: 'fileId' }]);
});
test('CLI-004 suites preserve cleanup, scan it for secrets, and read-only planning never admits its writes', () => {
  const { suite, problems } = normalizeSuite('files', { requests: [create()], finally: [remove()] });
  assert.deepEqual(problems, []); assert.deepEqual(JSON.parse(serializeSuite(suite)).finally, [remove()]);
  assert.ok(suiteSecretProblems({ ...suite, finally: [remove({ headers: { Authorization: 'literal-value' } })] }).length);
  const plan = readOnlyPlan(suite); assert.deepEqual(plan.finally, []); assert.equal(plan.skipped.length, 2);
  const report = suiteReport(suite, { attempted: 2, results: [{ ok: true }], finally: [{ ok: false, status: 401 }], left_behind: [{ created_by: 'create-file', capture: 'fileId' }] });
  assert.equal(report.ok, false); assert.equal(report.steps.length, 2); assert.deepEqual(report.left_behind, [{ created_by: 'create-file', capture: 'fileId' }]);
});

test('CLI-004 librarian checks finally atomically and disables capture in its safe cleanup', async () => {
  const { readOnlyRequestProblem, readOnlyExecutionArgs, readOnlyTool } = await import('../lib/librarian.mjs');
  const { TOOL } = await import('../lib/client.mjs');
  assert.equal(readOnlyRequestProblem({ requests: [{ path: '/health' }], finally: [remove()] })?.code, 'LIBRARIAN_READ_ONLY');
  assert.equal(readOnlyExecutionArgs({ requests: [{ path: '/health' }], finally: [{ path: '/health' }] }).finally[0].capture_context, false);
  assert.deepEqual(readOnlyTool(TOOL).inputSchema.properties.finally.items.properties.method.enum, ['GET', 'HEAD']);
});
test('CLI-004 suite CLI and full verify retain cleanup; read-only verify does not execute cleanup writes', async t => {
  const f = await fixture(t);
  const input = join(f.root, 'saved.json'); writeFileSync(input, JSON.stringify({ requests: [create()], finally: [remove()] }));
  const cli = (...args) => run(f.root, f.env, [join(source, 'bin/cli.mjs'), ...args]);
  assert.equal((await cli('suite', 'save', 'files', input)).code, 0);
  const ran = await cli('suite', 'run', 'files', '--json'); assert.equal(ran.code, 0, ran.stderr);
  const report = JSON.parse(ran.stdout).suites[0]; assert.equal(report.total, 2); assert.equal(report.request_attempts, 2);
  assert.deepEqual(report.left_behind, []);
  const verified = await cli('verify', '--ci', '--json'); assert.equal(verified.code, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).suites[0].request_attempts, 2);
  const readonly = await cli('verify', '--read-only', '--ci', '--json'); assert.equal(readonly.code, 0, readonly.stderr);
  assert.equal(JSON.parse(readonly.stdout).suites[0].request_attempts, 0);
  assert.equal(JSON.parse(readonly.stdout).suites[0].skipped.length, 2);
});
test('CLI-004 cleanup aliases retire together but identifiers from separate creates stay distinct', async t => {
  const f = await fixture(t);
  const { result } = await f.execute({ requests: [create({ capture: { fileId: 'id', alias: 'id', flag: 'flag' } })], finally: [remove()] });
  assert.deepEqual(result.left_behind, []); assert.deepEqual(result.captured.flag, { type: 'boolean' });
});
test('CLI-004 cleanup routing mistakes are caught before create and finally obeys production guards', async t => {
  const f = await fixture(t, true);
  const invalid = (await f.execute({ stack: 'alpha', requests: [create()], finally: [remove({ stack: 'missing' })] })).result;
  assert.equal(invalid.attempted, 0); assert.equal(invalid.error.code, 'STACK_NOT_FOUND');
  f.env.API_ALLOW_PRODUCTION_WRITES = '0';
  const stack = join(f.root, PROJECT_DIR_NAME, 'stacks', 'alpha', 'stack.json');
  const { readFileSync } = await import('node:fs'); const document = JSON.parse(readFileSync(stack, 'utf8'));
  document.environments.local.production = true; writeFileSync(stack, JSON.stringify(document));
  const refused = (await f.execute({ stack: 'alpha', requests: [{ path: '/health' }], finally: [{ method: 'DELETE', path: '/files/fixture' }] })).result;
  assert.equal(refused.finally[0].error?.code, 'PRODUCTION_WRITE_REFUSED'); assert.equal(refused.attempted, 1);
});

test('CLI-004 a single request cannot silently ignore batch cleanup or disclosure options', async t => {
  const f = await fixture(t);
  for (const extra of [{ finally: [remove()] }, { reveal_captures: true }]) {
    const out = await run(f.root, f.env, ['--input-type=module', '-e', `import {apiRequest} from ${JSON.stringify(new URL('../lib/client.mjs', import.meta.url).href)};console.log(JSON.stringify(await apiRequest(${JSON.stringify({ path: '/health', ...extra })})));`]);
    assert.equal(JSON.parse(out.stdout).error?.code, 'BATCH_ENVELOPE_REQUIRED');
  }
});
test('CLI-004 read-only verification names unused cleanup when every primary step was skipped', () => {
  const plan = readOnlyPlan({ requests: [create()], finally: [{ id: 'inspect', path: '/health', expect: [{ status: 200 }] }] });
  assert.deepEqual(plan.retained, []); assert.deepEqual(plan.finally, []); assert.equal(plan.skipped.length, 2);
  assert.match(plan.skipped[1].reason, /no primary read/);
});

test('CLI-004 unrelated DELETE paths and query mentions do not claim resource cleanup', async t => {
  const f = await fixture(t);
  for (const step of [remove({ path: '/unrelated', params: { reason: '{fileId}' } }), remove({ path: '/other/{fileId}' })]) {
    const { result } = await f.execute({ requests: [create()], finally: [step] });
    assert.equal(result.finally[0].status, 200);
    assert.deepEqual(result.left_behind, [{ created_by: 'create-file', capture: 'fileId' }]);
  }
});
test('CAPTURE-001 short identifiers cannot rename fixed result fields or change their types', async t => {
  const f = await fixture(t);
  for (const value of ['ok', 'status', 'assert']) {
    const { result } = await f.execute({ requests: [create({ path: `/short/${value}` })] });
    assert.equal(result.results[0].ok, true); assert.equal(result.results[0].status, 201); assert.equal(result.results[0].mode, 'assert');
    assert.equal(result.results[0].assertions.passed, 1);
    assert.equal(suiteReport({ name: 'fields', requests: [create()] }, result).ok, true);
  }
});


test('CAPTURE-001 HTTP discovery preserves generated type leaves and hides captured property names', async t => {
  const f = await fixture(t);
  for (const value of ['type', 'string', 'properties', 'items']) {
    const { result } = await f.execute({ requests: [create({ path: `/short/${value}`, expect: [{ status: 200 }] })] });
    const shape = result.results[0].discovery.shape;
    assert.equal(shape.id, 'string'); assert.equal(shape.numericId, 'number');
    assert.equal(shape['[capture withheld]'], 'string');
    assert.equal(Object.hasOwn(shape, value), false);
  }
});
test('CAPTURE-001 protocol discovery preserves its shape grammar and hides captured property names', async t => {
  const f = await fixture(t);
  for (const value of ['type', 'string', 'properties', 'items']) {
    const { result } = await f.execute({ requests: [create({ path: `/short/${value}` }),
      { protocol: 'jsonrpc', path: `/rpcshape/${value}`, rpc: { method: 'inspect', params: {} } }] });
    const shape = result.results[1].discovery.shape.shape;
    assert.equal(shape.type, 'object'); assert.equal(shape.properties.result.type, 'object');
    const properties = shape.properties.result.properties;
    assert.deepEqual(properties['[capture withheld]'], { type: 'string' });
    assert.equal(Object.hasOwn(properties, value), false);
    assert.deepEqual(properties.list, { type: 'array', sampled: 1, items: [{ type: 'string' }] });
  }
});
