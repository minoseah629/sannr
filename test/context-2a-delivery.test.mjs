import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME, PRODUCT, POINTER_BEGIN, POINTER_END, TOOL_NAME } from '../lib/brand.mjs';
import { baselineNoteHistory } from '../lib/note-history.mjs';
import { createMcpSession } from '../lib/mcp-transport.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';

const pkg = fileURLToPath(new URL('../', import.meta.url));
// Receipts name this install's command; a source checkout runs the CLI through node.
const SOURCE_CLI = `node ${join(pkg, 'bin/cli.mjs')}`;
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const saved = path => JSON.parse(readFileSync(path, 'utf8'));
function history(notes) {
  return baselineNoteHistory({ notes: notes.map(note => typeof note === 'string' ? note : note.text),
    notes_provenance: notes.map(note => ({ by: 'fixture', at: '2026-10-09',
      ...(note.operations ? { operations: note.operations } : {}) })), notes_superseded: notes.map(() => null) });
}
async function fixture(t, facts = ['All alpha writes use a shared error envelope.']) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'context-2a-delivery-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  const server = spawn(process.execPath, [join(pkg, 'test/fixtures/context-2a-server.mjs')],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => {
    if (server.exitCode !== null) return;
    const stopped = new Promise(resolve => server.once('exit', resolve));
    server.send({ command: 'stop' }); await stopped;
  });
  const origin = await new Promise((resolve, reject) => {
    server.once('error', reject); server.once('message', message => resolve(message.origin));
    server.once('exit', code => reject(new Error(`Fixture stopped (${code})`)));
  });
  const contract = 'fixture.openapi.json';
  save(join(root, contract), { openapi: '3.0.3', info: { title: 'Synthetic API', version: '1' },
    paths: Object.fromEntries(['/users', '/jobs', '/groups'].map(path => [path, { get: { responses: { 200: { description: 'Synthetic' } } } }])) });
  for (const name of ['alpha', 'beta']) {
    createFixtureStack(root, { name, baseUrl: `${origin}/${name}/v1`, contract });
    save(fixtureContextFile(root, name), { v: 0, api: { name, contract: `.sannr/stacks/${name}/${contract}` },
      ...(name === 'alpha' ? { stack_facts: history(facts) } : {}), operations: {
        'GET /users': { ...history([`${name} operation note.`]), effect: 'read', fields: {}, status_codes: [] },
      } });
  }
  return { root, env, origin };
}
async function command(f, args, env = {}) {
  const child = spawn(process.execPath, [join(pkg, 'bin/cli.mjs'), ...args],
    { cwd: f.root, env: { ...f.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stdout + stderr);
  return { stdout, value: (() => { try { return JSON.parse(stdout); } catch { return null; } })() };
}
const request = async (f, path, stack = 'alpha', env) => (await command(f, ['request', 'GET', path, '--stack', stack], env)).value;
const part = (text, name) => text.split(`### Stack \`${name}\``)[1]?.split('\n### Stack ')[0];

test('CONTEXT-2a(a) saved stack facts lead known on every own-stack request, including no operation entry', async t => {
  const fact = 'All alpha writes use a shared error envelope.';
  const f = await fixture(t, [fact]);
  for (const path of ['/users', '/jobs', `${f.origin}/alpha/v1/groups`]) {
    const result = await request(f, path);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.known?.notes?.[0], fact);
    assert.deepEqual(result.known.stack_facts, { total: 1, shown: 1, omitted: 0, show_command: `${SOURCE_CLI} show --stack alpha` });
    if (path === '/users') assert.deepEqual(result.known.notes, [fact, 'alpha operation note.']);
  }
  const other = await request(f, '/users', 'beta');
  assert.deepEqual(other.known.notes, ['beta operation note.']);
  assert.equal(other.known.stack_facts, undefined);
  const off = await request(f, '/users', 'alpha', { API_CONTEXT_OFF: '1' });
  assert.equal(off.known, null);
});

test('CONTEXT-2a(b) operation restriction applies to canonical mounted routes, never a third operation', async t => {
  const fact = 'Users and jobs require the beta header.';
  const f = await fixture(t, [{ text: fact, operations: ['GET /users', 'GET /jobs'] }]);
  for (const path of ['/users', '/jobs']) assert.equal((await request(f, path)).known?.notes?.[0], fact);
  assert.ok(!(await request(f, '/groups')).known?.notes?.includes(fact));
  assert.ok(!(await request(f, '/users', 'beta')).known?.notes?.includes(fact));
});

test('CONTEXT-2a stack facts cap at five and budget omissions retain exact recovery command', async t => {
  const facts = Array.from({ length: 7 }, (_, i) => `Stack fact ${i}: shared synthetic rule.`);
  const f = await fixture(t, facts);
  const result = await request(f, '/users');
  assert.deepEqual(result.known.notes, [...facts.slice(0, 5), 'alpha operation note.']);
  assert.deepEqual(result.known.stack_facts, { total: 7, shown: 5, omitted: 2, show_command: `${SOURCE_CLI} show --stack alpha` });
  for (const note of facts.slice(5)) assert.ok(!JSON.stringify(result.known).includes(note), 'scoped enrichment cannot bypass the five-fact cap');
  const rpcInput = join(f.root, 'rpc-cap.json');
  save(rpcInput, { protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'probe' } });
  const rpc = (await command(f, ['protocol', rpcInput, '--stack', 'alpha'])).value;
  assert.deepEqual(rpc.known.notes, facts.slice(0, 5));
  assert.equal(rpc.known.stack_facts.omitted, 2);
  for (const note of facts.slice(5)) assert.ok(!JSON.stringify(rpc.known).includes(note), 'protocol query enrichment cannot bypass the five-fact cap');
  const tiny = await request(f, '/users', 'alpha', { API_BUDGET: '200' });
  assert.equal(tiny.known.stack_facts.show_command, `${SOURCE_CLI} show --stack alpha`);
  assert.equal(tiny.known.stack_facts.omitted, 7 - tiny.known.stack_facts.shown);
  await command(f, ['connect', '--json']);
  const alpha = part(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'alpha');
  assert.match(alpha, /2 stack facts omitted \(stack-fact cap 5\)/);
  assert.ok(alpha.includes('show --stack alpha'));
});

test('CONTEXT-2a(c) both managed blocks put stack facts first without changing operation fact bytes', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.root, 'CLAUDE.md'), '# Existing team instructions\n');
  await command(f, ['connect', '--json']);
  const agents = readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), alpha = part(agents, 'alpha');
  assert.ok(alpha.includes('All alpha writes use a shared error envelope.'));
  assert.ok(alpha.indexOf('All alpha writes use a shared error envelope.') < alpha.indexOf('- `GET /users` — alpha operation note.'));
  const operationLines = alpha.split('\n').filter(line => /^- `GET /.test(line));
  assert.deepEqual(operationLines.map(line => line.replace(/ \[Review data: unreviewed; basis: unknown \(inferred\)\]$/u, '')),
    ['- `GET /users` — alpha operation note.']);
  for (const line of operationLines) assert.match(line, /\[Review data: unreviewed; basis: unknown \(inferred\)\]$/u);
  assert.ok(!part(agents, 'beta').includes('All alpha writes'));
  const block = text => text.slice(text.indexOf(POINTER_BEGIN), text.indexOf(POINTER_END) + POINTER_END.length);
  assert.equal(block(agents), block(readFileSync(join(f.root, 'CLAUDE.md'), 'utf8')));
});

test('CONTEXT-2a(c) adding stack facts preserves operation facts and omission wording at the existing cap', async t => {
  const f = await fixture(t, []), file = fixtureContextFile(f.root, 'alpha'), ctx = saved(file);
  ctx.operations = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`GET /items/${i}`,
    { ...history([`Operation lesson ${i}.`]), effect: 'read', fields: {}, status_codes: [] }]));
  save(file, ctx);
  await command(f, ['connect', '--json']);
  const operationPart = text => part(text, 'alpha').split('**Known gotchas**')[1];
  const before = operationPart(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'));
  assert.equal(before.split('\n').filter(line => /^- `GET /.test(line)).length, 15);
  assert.match(before, /1 gotchas omitted \(per-stack cap 15\)/);
  await command(f, ['note', '--stack', 'alpha', '--scope', 'stack', 'Every operation shares the error envelope.', '--json']);
  const after = operationPart(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'));
  assert.equal(after, before, 'stack facts must not consume the existing operation-fact budget');
});

test('CONTEXT-2a(c) pointer stack-fact total cap is independent and names only the facts it omits', async t => {
  const f = await fixture(t, []);
  for (const name of ['alpha', 'beta', ...Array.from({ length: 11 }, (_, i) => `scope-${String(i).padStart(2, '0')}`)]) {
    if (!['alpha', 'beta'].includes(name)) createFixtureStack(f.root, { name, baseUrl: `https://${name}.example.test` });
    save(fixtureContextFile(f.root, name), { v: 0, api: { name }, stack_facts: history(Array.from({ length: 5 }, (_, i) => `${name} shared fact ${i}.`)),
      operations: { 'GET /users': { ...history([`${name} operation note.`]), effect: 'read', fields: {}, status_codes: [] } } });
  }
  await command(f, ['connect', '--json']);
  const text = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.equal(text.split('\n').filter(line => line.startsWith('- Every operation — ')).length, 60);
  assert.equal(text.split('\n').filter(line => line.startsWith('- `GET /users` — ')).length, 13,
    'all 13 operation facts retain their independent budget');
  const last = part(text, 'scope-10');
  assert.match(last, /5 stack facts omitted \(stack-fact cap 5; stack-fact total cap 60\)/);
  assert.ok(last.includes('show --stack scope-10'));
  assert.doesNotMatch(text, /gotchas omitted/);
});

test('CONTEXT-2a protocol calls carry unrestricted stack facts ahead of scoped protocol observations', async t => {
  const f = await fixture(t), input = join(f.root, 'rpc.json');
  save(input, { protocol: 'jsonrpc', path: '/rpc', rpc: { method: 'probe' } });
  const result = (await command(f, ['protocol', input, '--stack', 'alpha'])).value;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.known?.notes, ['All alpha writes use a shared error envelope.']);
  assert.equal(result.known?.stack_facts?.shown, 1);
  const tiny = (await command(f, ['protocol', input, '--stack', 'alpha'], { API_BUDGET: '200' })).value;
  assert.equal(tiny.known.stack_facts.show_command, `${SOURCE_CLI} show --stack alpha`);
  assert.equal(tiny.known.stack_facts.omitted, 1 - tiny.known.stack_facts.shown);
});

test('CONTEXT-2a malformed stack-fact scope cannot turn into an unrestricted note', async t => {
  const f = await fixture(t), file = fixtureContextFile(f.root, 'alpha'), ctx = saved(file);
  ctx.stack_facts.notes_provenance[0].operations = 'GET /users'; save(file, ctx);
  const result = await request(f, '/jobs');
  assert.deepEqual(result.known?.notes ?? [], []);
  assert.equal(result.known?.stack_facts?.history_state, 'invalid');
  assert.equal(result.known?.stack_facts?.omitted, 1);
  assert.equal(result.known?.stack_facts?.show_command, `${SOURCE_CLI} show --stack alpha`);
});

test('CONTEXT-2a editing away applicability cannot widen a restricted fact to the whole stack', async t => {
  const fact = 'Only user reads require the scoped beta header.';
  const f = await fixture(t, [{ text: fact, operations: ['GET /users'] }]);
  const file = fixtureContextFile(f.root, 'alpha'), ctx = saved(file);
  delete ctx.stack_facts.notes_provenance[0].operations; save(file, ctx);
  const result = await request(f, '/jobs');
  assert.ok(!result.known?.notes?.includes(fact), JSON.stringify(result.known));
  assert.equal(result.known?.stack_facts?.history_state, 'changed');
  assert.equal(result.known?.stack_facts?.omitted, 1);
  assert.equal(result.known?.stack_facts?.show_command, `${SOURCE_CLI} show --stack alpha`);
  await command(f, ['connect', '--json']);
  assert.ok(!part(readFileSync(join(f.root, 'AGENTS.md'), 'utf8'), 'alpha').includes(fact));
});

test('CONTEXT-2a legacy unbaselined facts retain the unknown-integrity warning when delivered', async t => {
  const f = await fixture(t), file = fixtureContextFile(f.root, 'alpha'), ctx = saved(file);
  delete ctx.stack_facts.note_integrity; save(file, ctx);
  const result = await request(f, '/users');
  assert.equal(result.known.notes[0], 'All alpha writes use a shared error envelope.');
  assert.equal(result.known.stack_facts.history_state, 'unbaselined');
  assert.equal(result.known.stack_facts.reason, 'note-history-baseline-missing');
});

test('CONTEXT-2a(a) a fact written once by note reaches an already running MCP client without copying operation notes', async t => {
  const f = await fixture(t, []);
  const session = createMcpSession({ command: process.execPath, args: [join(pkg, 'server.mjs')],
    cwd: f.root, env: f.env, timeoutMs: 15000 });
  t.after(() => session.close());
  await session.request('initialize', { protocolVersion: '2025-11-25', capabilities: {},
    clientInfo: { name: 'stack-fact-delivery-fixture', version: '1' } });
  await session.notify('notifications/initialized');
  const fact = 'Every request requires the shared error-code check.';
  await command(f, ['note', '--stack', 'alpha', '--scope', 'stack', fact, '--json']);
  const ctx = saved(fixtureContextFile(f.root, 'alpha'));
  assert.equal(ctx.stack_facts.notes.length, 1);
  assert.deepEqual(Object.keys(ctx.operations), ['GET /users'], 'one fact does not manufacture operation notes');
  for (const [stack, path] of [['alpha', '/users'], ['alpha', '/jobs'], ['beta', '/users']]) {
    const reply = await session.request('tools/call', { name: TOOL_NAME, arguments: { stack, method: 'GET', path } });
    const result = JSON.parse(reply.result.content.find(block => block.type === 'text').text);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.known?.notes?.includes(fact), stack === 'alpha');
  }
});
