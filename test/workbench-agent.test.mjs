import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, lstat, readdir, mkdir, chmod, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as presence from '../lib/workbench-agent.mjs';
import { PROJECT_DIR_NAME } from '../lib/brand.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-presence-'));
  const agents = [];
  t.after(async () => { for (const agent of agents) await agent.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory: join(root, PROJECT_DIR_NAME, 'evidence/workbench/agents'),
    async launch(options = {}) {
      const agent = await presence.createWorkbenchAgent({ root, host: 'Fixture Code', task: 'Debug GET /orders/{id}', ...options });
      agents.push(agent); return agent;
    },
  };
}
const currentRecord = async (fixture, agent) => JSON.parse(await readFile(join(fixture.directory, `${agent.sessionId}.json`), 'utf8'));

test('optional agent presence attaches without a host probe or browser authority and keeps normal task syntax', async t => {
  const f = await fixture(t);
  assert.deepEqual((await presence.listWorkbenchAgents(f.root)).agents, []);
  await assert.rejects(lstat(join(f.root, PROJECT_DIR_NAME)), { code: 'ENOENT' });
  const agent = await f.launch({ checkHost: () => { throw new Error('Presence must not ping its host.'); } });
  const record = await currentRecord(f, agent);
  assert.equal(record.host, 'Fixture Code');
  assert.equal(record.task, 'Debug GET /orders/{id}');
  assert.equal(record.session_id, agent.sessionId);
  assert.equal(agent.info().state, 'attached');
  assert.equal((await lstat(join(f.directory, `${agent.sessionId}.json`))).mode & 0o777, 0o600);
  assert.equal((await lstat(f.directory)).mode & 0o777, 0o700);
  assert.equal(await readFile(join(f.directory, '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(Object.keys(record).sort(), ['version', 'session_id', 'host', 'task', 'attached_at', 'heartbeat_at'].sort());
  for (const key of ['url', 'token', 'port', 'authorizePairing']) assert.equal(agent[key], undefined);
  const listed = await presence.listWorkbenchAgents(f.root);
  assert.equal(listed.agents[0].session_id, agent.sessionId);
});

test('presence refresh updates its timestamp; stale and future records do not claim attachment', async t => {
  const f = await fixture(t);
  let now = Date.parse('2026-10-21T12:00:00.000Z');
  const agent = await f.launch({ now: () => now });
  now += 20000;
  await agent.refresh();
  const record = await currentRecord(f, agent);
  assert.equal(record.attached_at, '2026-10-21T12:00:00.000Z');
  assert.equal(record.heartbeat_at, '2026-10-21T12:00:20.000Z');
  assert.equal((await presence.listWorkbenchAgents(f.root, { now: now + 5000 })).agents[0].heartbeat_age_ms, 5000);
  assert.equal((await presence.listWorkbenchAgents(f.root, { now: now + 120000 })).stale, 1);
  assert.deepEqual((await presence.listWorkbenchAgents(f.root, { now: now - 1 })).agents, []);
  await agent.close('eof');
  assert.deepEqual(await agent.closed, { reason: 'eof' });
  assert.deepEqual((await readdir(f.directory)).filter(file => file.endsWith('.json')), []);
  assert.deepEqual((await presence.listWorkbenchAgents(f.root, { now })).agents, []);
});

test('attaching prunes expired valid presence records without removing live presence', async t => {
  const f = await fixture(t);
  const first = await f.launch();
  const stale = { ...await currentRecord(f, first), attached_at: '2020-01-01T00:00:00.000Z', heartbeat_at: '2020-01-01T00:00:00.000Z' };
  for (let n = 0; n < 40; n++) {
    const session = `wb-${randomUUID()}`;
    const file = join(f.directory, `${session}.json`);
    await writeFile(file, JSON.stringify({ ...stale, session_id: session }), { mode: 0o600 });
    await utimes(file, new Date(stale.heartbeat_at), new Date(stale.heartbeat_at));
  }
  const second = await f.launch({ task: 'Second task' });
  const listed = await presence.listWorkbenchAgents(f.root);
  assert.equal(listed.stale, 0);
  assert.equal((await readdir(f.directory)).filter(file => file.endsWith('.json')).length, 2);
  assert.deepEqual(new Set(listed.agents.map(agent => agent.session_id)), new Set([first.sessionId, second.sessionId]));
  assert.equal(listed.omitted, 0);
  await first.close();
  assert.equal((await presence.listWorkbenchAgents(f.root)).agents[0].session_id, second.sessionId);
});

test('group-writable repository ancestors are supported while the private presence leaf stays private', async t => {
  const f = await fixture(t);
  await chmod(f.root, 0o775);
  let path = f.root;
  for (const segment of [PROJECT_DIR_NAME, 'evidence', 'workbench']) { path = join(path, segment); await mkdir(path); await chmod(path, 0o775); }
  const agent = await f.launch();
  assert.equal((await presence.listWorkbenchAgents(f.root)).agents[0].session_id, agent.sessionId);
  assert.equal((await lstat(join(f.root, PROJECT_DIR_NAME))).mode & 0o777, 0o775);
  await chmod(f.directory, 0o775);
  await assert.rejects(f.launch(), { code: 'WORKBENCH_PRESENCE_UNSAFE' });
  const unavailable = await presence.listWorkbenchAgents(f.root);
  assert.deepEqual(unavailable.agents, []);
  assert.equal(unavailable.unavailable[0].code, 'WORKBENCH_PRESENCE_UNSAFE');
  await chmod(f.directory, 0o700);
});

test('unsafe, malformed and legacy bridge records never appear as present and are not followed', async t => {
  const f = await fixture(t), other = await fixture(t), agent = await f.launch();
  const path = join(f.directory, `${agent.sessionId}.json`), record = await currentRecord(f, agent);
  await chmod(path, 0o644);
  assert.deepEqual((await presence.listWorkbenchAgents(f.root)).agents, []);
  await chmod(path, 0o600);
  for (const invalid of [{ ...record, heartbeat_at: 'bad-date' }, { ...record, session_id: `wb-${randomUUID()}` }, { ...record, token: 'bridge-token', port: 12345 }]) {
    await writeFile(path, JSON.stringify(invalid));
    assert.deepEqual((await presence.listWorkbenchAgents(f.root)).agents, []);
  }
  await rm(path);
  const outside = join(other.root, 'private.json'); await writeFile(outside, JSON.stringify(record), { mode: 0o600 });
  await symlink(outside, path);
  assert.deepEqual((await presence.listWorkbenchAgents(f.root)).agents, []);
  await assert.rejects(agent.refresh(), { code: 'WORKBENCH_PRESENCE_UNSAFE' });
  assert.equal(await readFile(outside, 'utf8'), JSON.stringify(record));
  await rm(path);
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
});

test('credential-shaped labels are refused explicitly rather than silently renamed', async t => {
  const f = await fixture(t);
  const secret = 'fixture-sensitive-value-12345';
  process.env.WORKBENCH_TEST_SECRET = secret;
  t.after(() => { delete process.env.WORKBENCH_TEST_SECRET; });
  await assert.rejects(f.launch({ task: `Investigate ${secret}` }), { code: 'WORKBENCH_PRESENCE_LABEL_PRIVATE' });
  await assert.rejects(f.launch({ task: `Authorization: Bearer ${'x'.repeat(36)}` }), { code: 'WORKBENCH_PRESENCE_LABEL_PRIVATE' });
  for (const privateLabel of [`Inspect ${['', 'Users', 'fixture', 'repository'].join('/')}`, 'Inspect https://example.test/orders', `Inspect ${['C:', 'Users', 'fixture'].join('\\')}`]) {
    await assert.rejects(f.launch({ task: privateLabel }), { code: 'WORKBENCH_PRESENCE_LABEL_PRIVATE' });
    await assert.rejects(f.launch({ host: privateLabel }), { code: 'WORKBENCH_PRESENCE_LABEL_PRIVATE' });
  }
  await assert.rejects(lstat(join(f.root, PROJECT_DIR_NAME)), { code: 'ENOENT' });
  const agent = await f.launch({ task: 'Investigate token refresh: phase=2 @ fixture' });
  assert.equal(agent.info().task, 'Investigate token refresh: phase=2 @ fixture');
});

test('detach never deletes a replacement presence record with the same session identity', async t => {
  const f = await fixture(t), agent = await f.launch();
  const path = join(f.directory, `${agent.sessionId}.json`);
  const record = { ...await currentRecord(f, agent), task: 'Replacement task' };
  await rm(path);
  await writeFile(path, JSON.stringify(record), { mode: 0o600 });
  await assert.rejects(agent.refresh(), { code: 'WORKBENCH_PRESENCE_UNSAFE' });
  const result = await agent.close();
  assert.equal(result.cleanup_error, 'WORKBENCH_PRESENCE_UNSAFE');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).task, 'Replacement task');
});


test('presence cleanup leaves recently written, future, malformed, legacy and symbolic-link records untouched', async t => {
  const f = await fixture(t), other = await fixture(t), first = await f.launch();
  const base = await currentRecord(f, first), files = [];
  for (const changes of [
    { attached_at: '2020-01-01T00:00:00.000Z', heartbeat_at: '2020-01-01T00:00:00.000Z' },
    { attached_at: '2999-01-01T00:00:00.000Z', heartbeat_at: '2999-01-01T00:00:00.000Z' },
    { attached_at: 'bad-date', heartbeat_at: 'bad-date' },
    { attached_at: '2020-01-01T00:00:00.000Z', heartbeat_at: '2020-01-01T00:00:00.000Z', token: 'legacy-bridge-field' },
  ]) {
    const session = `wb-${randomUUID()}`, path = join(f.directory, `${session}.json`);
    await writeFile(path, JSON.stringify({ ...base, session_id: session, ...changes }), { mode: 0o600 });
    files.push(path);
  }
  const link = join(f.directory, `wb-${randomUUID()}.json`), outside = join(other.root, 'outside.json');
  await writeFile(outside, JSON.stringify(base), { mode: 0o600 });
  await symlink(outside, link);
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  await f.launch({ task: 'Another task' });
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.equal((await lstat(link)).isSymbolicLink(), true);
  assert.equal(await readFile(outside, 'utf8'), JSON.stringify(base));
});
