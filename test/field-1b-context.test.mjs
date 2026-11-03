import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { setupGuidance } from '../lib/onboarding.mjs';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
const pkg = fileURLToPath(new URL('../', import.meta.url));
const save = (file, value) => writeFileSync(file, JSON.stringify(value));
async function fixture(t, { contract = true, notes = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'field-context-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'home'); mkdirSync(home);
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_BUDGET: '6000', API_FRICTION_OFF: '1', NO_COLOR: '1' };
  const child = spawn(process.execPath, [join(pkg, 'test/fixtures/stacks-1a-server.mjs'), 'alpha'],
    { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  t.after(async () => { if (child.exitCode !== null) return; const done = new Promise(r => child.once('exit', r)); child.send({ command: 'stop' }); await done; });
  const origin = await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('message', msg => resolve(msg.origin));
    child.once('exit', code => reject(new Error(`Fixture failed: ${code}`)));
  });
  const contractName = 'fixture.openapi.json';
  save(join(root, contractName), { openapi: '3.0.3', info: { title: 'Synthetic API', version: '1' },
    paths: { '/users': { get: { responses: { 200: { description: 'Synthetic' } } } } } });
  for (const name of ['alpha', 'beta']) {
    createFixtureStack(root, { name, environment: 'local', ...(contract ? { contract: contractName } : {}),
      environments: { local: { baseUrl: `${origin}/${name}` }, stage: { baseUrl: `${origin}/${name}/stage` } } });
    save(fixtureContextFile(root, name), { v: 0, api: { name,
      ...(contract ? { contract: `.sannr/stacks/${name}/${contractName}` } : {}) }, operations: notes ? {
      'GET /users': { effect: 'read', notes: [`${name} authored lesson`], notes_provenance: [{ by: 'fixture', at: '2026-10-08' }] },
    } : {} });
  }
  return { root, env, origin, snapshot: () => new Promise(resolve => {
    child.once('message', msg => resolve(msg.requests)); child.send({ command: 'snapshot', id: 'requests' });
  }) };
}
async function run(f, args) {
  const child = spawn(process.execPath, [join(pkg, 'bin/cli.mjs'), ...args], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, stdout + stderr);
  return { stdout, stderr, value: (() => { try { return JSON.parse(stdout); } catch { return null; } })() };
}
function applicability(result, f, name, environment) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.known.applicability, { stack: name, provider: `${f.origin}/${name}${environment === 'stage' ? '/stage' : ''}`,
    environment, basis: 'resolved-stack-request' });
}
test('RECEIPT-001 named stack notes identify the resolved stack, environment and mounted provider', async t => {
  const f = await fixture(t);
  for (const [name, environment] of [['beta', 'stage'], ['alpha', 'local'], ['beta', 'local']]) {
    const { value } = await run(f, ['request', 'GET', '/users', '--stack', name, '--env', environment]);
    applicability(value, f, name, environment);
    assert.deepEqual(value.known.notes, [`${name} authored lesson`]);
    assert.equal(value.known.verified_at, null, 'scope attribution cannot promote an authored note to verification');
  }
});
test('RECEIPT-001 contractless notes still identify configured scope without claiming capture', async t => {
  const f = await fixture(t, { contract: false });
  const { value } = await run(f, ['request', 'GET', '/users', '--stack', 'beta', '--env', 'stage']);
  applicability(value, f, 'beta', 'stage');
  assert.notEqual(value.context_capture.state, 'captured');
});
test('RECEIPT-001 scoped-only prior observations retain applicability without authored notes', async t => {
  const f = await fixture(t, { notes: false });
  const args = ['request', 'GET', '/users', '--stack', 'beta', '--env', 'stage'];
  await run(f, args);
  const { value } = await run(f, args);
  assert.ok(value.known.scoped);
  applicability(value, f, 'beta', 'stage');
  assert.equal(value.known.notes, undefined);
});
test('ONBOARD-001 generated Finish instructions condition replay on an existing receipt', async t => {
  const f = await fixture(t);
  await run(f, ['connect', '--json']);
  await run(f, ['doctor', '--offline', '--json']);
  assert.equal(existsSync(join(f.root, '.sannr/evidence/onboarding.json')), false);
  const guidance = readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
  assert.match(guidance, /If `.sannr\/evidence\/onboarding.json` exists, (?:run|read it)/);
  assert.match(guidance, /If no receipt exists, skip replay/);
  assert.match(guidance, /absence does not establish whether a probe was skipped or failed/);
  for (const cli of ['fixture-cli', null]) {
    assert.match(setupGuidance('fixture-binding', cli), /If no receipt exists, skip replay/);
  }
  const missing = await run(f, ['context', 'query', '--onboarding']);
  assert.equal(missing.value.state, 'missing');
  assert.deepEqual(await f.snapshot(), [], 'connect, offline doctor and local replay send no requests');
});
