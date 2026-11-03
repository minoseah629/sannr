// SESSION-1 part 2: the discovery record and control socket, the --show
// launch, and the agent's show action. The message carries a ledger session
// id and nothing else; a forged id is refused by name; an absent Workbench is
// a result, never a failed agent turn; the browser is never navigated here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { createWorkbenchControl, requestWorkbenchShow, listWorkbenchControls, controlDirectory } from '../lib/workbench-control.mjs';
import { createShowQueue, workbenchHandlers } from '../lib/workbench-engine.mjs';
import { createWorkbenchAgentTools } from '../lib/workbench-agent-tools.mjs';
import { launchWorkbench, parseWorkbenchArgs, resolveShowTarget, workbenchShowUrl } from '../lib/workbench-cli.mjs';

const SID = 'AC' + 'a'.repeat(32);
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-control-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'home', 'machine'), { recursive: true });
  const dir = join(root, LAYOUT.collection, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'stack.json'), JSON.stringify({ v: 1, name: 'alpha', default_environment: 'local', environments: { local: { baseUrl: 'https://alpha.example.test' } } }));
  writeFileSync(join(dir, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name: 'alpha' }, operations: {} }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'home', 'machine'), API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'home', 'machine', 'usage.jsonl'), API_FRICTION_OFF: '1' };
  return { root, env };
}
function writeRun(root, { sessionId, at = Date.now(), status = 200 }) {
  const runId = `run-${randomUUID()}`, dir = join(root, LAYOUT.evidence, 'alpha');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${runId}.json`), JSON.stringify({ runId, origin: { v: 1, initiator: 'mcp.api_request', observed_at: new Date(at).toISOString(), session_id: sessionId, scope: { protocol: 'http', operation: 'GET /health' } },
    request: { method: 'GET', url: `https://alpha.example.test/x/${SID}` }, response: { status, body: { id: SID } } }));
  return runId;
}
const raw = (path, text) => new Promise(resolve => {
  let out = ''; const socket = connect({ path });
  socket.on('connect', () => socket.write(text)); socket.on('data', chunk => { out += chunk; }); socket.on('close', () => resolve(out)); socket.on('error', () => resolve(out));
});

test('a running Workbench answers a show request for a recorded session, refuses a forged id by name, and bounds and validates messages', async t => {
  const { root, env } = project(t), session = randomUUID();
  writeRun(root, { sessionId: session }); writeRun(root, { sessionId: session, status: 500 });
  const shows = createShowQueue(root), wb = `wb-${randomUUID()}`;
  let paired = false;
  const control = await createWorkbenchControl({ root, sessionId: wb, onShow: id => shows.push(id), isPaired: () => paired });
  t.after(() => control.close());
  const record = JSON.parse(readFileSync(control.record, 'utf8'));
  assert.deepEqual(Object.keys(record).sort(), ['heartbeat_at', 'pid', 'session_id', 'socket', 'started_at', 'version']);
  assert.equal(record.session_id, wb);
  assert.equal(statSync(control.record).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(controlDirectory(root), '.gitignore'), 'utf8'), '*\n');
  assert.deepEqual(listWorkbenchControls(root).map(item => item.session_id), [wb]);
  assert.deepEqual(listWorkbenchControls(root, { now: Date.now() + 60_000 }), [], 'a record past its heartbeat TTL is not a running Workbench');

  const unpaired = await requestWorkbenchShow(root, `process:${session}`);
  assert.equal(unpaired.state, 'answered'); assert.deepEqual(unpaired.reply, { ok: true, paired: false, code: null });
  paired = true;
  const answered = await requestWorkbenchShow(root, `process:${session}`);
  assert.deepEqual(answered.reply, { ok: true, paired: true, code: null });
  const queued = shows.list();
  assert.equal(queued.length, 2);
  assert.equal(queued[1].session, `process:${session}`);
  assert.match(queued[1].line, /^\S+: 2 requests · 1 failed · no notes added$/);
  assert.ok(!JSON.stringify(queued).includes(SID));
  const forged = await requestWorkbenchShow(root, `process:${randomUUID()}`);
  assert.deepEqual(forged.reply, { ok: false, paired: false, code: 'WORKBENCH_SESSION_UNKNOWN' });
  assert.equal(shows.list().length, 2, 'a refused request queues nothing');
  await assert.rejects(requestWorkbenchShow(root, '../evidence'), { code: 'WORKBENCH_SESSION_ID_INVALID' });
  assert.match(await raw(control.socket, 'not json\n'), /WORKBENCH_CONTROL_MESSAGE_INVALID/);
  assert.match(await raw(control.socket, JSON.stringify({ v: 1, kind: 'navigate', session: `process:${session}` }) + '\n'), /WORKBENCH_CONTROL_MESSAGE_INVALID/);
  assert.match(await raw(control.socket, JSON.stringify({ v: 1, kind: 'show', session: `process:${session}`, token: 'x' }) + '\n'), /WORKBENCH_CONTROL_MESSAGE_INVALID/);
  assert.match(await raw(control.socket, 'x'.repeat(5000)), /WORKBENCH_CONTROL_MESSAGE_LIMIT/);
  assert.equal(shows.list().length, 2);
  const handlers = workbenchHandlers(root, { shows });
  assert.equal((await handlers.agent({})).show_requests.length, 2);
  await control.close();
  assert.equal(existsSync(control.record), false); assert.equal(existsSync(control.socket), false);
  assert.equal((await requestWorkbenchShow(root, `process:${session}`)).state, 'not-running');
  void env;
});

test('a fresh record whose socket is gone is unreachable, not a running Workbench', async t => {
  const { root } = project(t);
  const dir = controlDirectory(root); mkdirSync(dir, { recursive: true });
  const wb = `wb-${randomUUID()}`, now = new Date().toISOString();
  writeFileSync(join(dir, `${wb}.json`), JSON.stringify({ version: 1, session_id: wb, pid: 1, socket: join(tmpdir(), `missing-${randomUUID()}.sock`), started_at: now, heartbeat_at: now }));
  writeFileSync(join(dir, 'wb-malformed.json'), '{"version":1}');
  const result = await requestWorkbenchShow(root, `process:${randomUUID()}`);
  assert.equal(result.state, 'unreachable');
  assert.equal(result.attempts.length, 1);
});

test('api_workbench show never fails the turn: it returns the CLI command without a Workbench, and the shown state with a paired one', async t => {
  const { root, env } = project(t), session = randomUUID();
  writeRun(root, { sessionId: session });
  const peer = createWorkbenchAgentTools({ root, host: 'Fixture host', processSessionId: session, env });
  t.after(() => peer.close());
  const absent = await peer.call({ action: 'show' });
  assert.equal(absent.shown, false);
  assert.equal(absent.session_shown, `process:${session}`);
  assert.equal(absent.workbench.state, 'not-running');
  assert.match(absent.open, /^Open in Workbench: .*workbench --show last-session$/);
  assert.equal(absent.calls, 1);
  // The summary action keeps its verified invocation; only show names --show.
  assert.match((await peer.call({ action: 'summary' })).open, /^Open in Workbench: .*workbench$/);
  const elsewhere = `process:${randomUUID()}`;
  writeRun(root, { sessionId: elsewhere.slice(8) });
  assert.match((await peer.call({ action: 'show', session: elsewhere })).open, new RegExp(`workbench --show ${elsewhere}$`), 'another session is named by its id');
  await assert.rejects(peer.call({ action: 'show', session: 'wb-00000000-0000-0000-0000-000000000000' }), { code: 'WORKBENCH_SESSION_ID_INVALID' });
  await assert.rejects(peer.call({ action: 'show', task: 'x' }), { code: 'WORKBENCH_ACTION_INVALID' });
  const shows = createShowQueue(root);
  let paired = false;
  const control = await createWorkbenchControl({ root, sessionId: `wb-${randomUUID()}`, onShow: id => shows.push(id), isPaired: () => paired });
  t.after(() => control.close());
  const queued = await peer.call({ action: 'show' });
  assert.equal(queued.shown, false); assert.equal(queued.workbench.state, 'queued-unpaired');
  paired = true;
  const shown = await peer.call({ action: 'show' });
  assert.equal(shown.shown, true); assert.equal(shown.workbench.state, 'shown');
  assert.equal(shown.open, 'Shown in your Workbench tab');
  assert.equal((await peer.call({ action: 'summary' })).open, 'Shown in your Workbench tab');
  const other = await peer.call({ action: 'show', session: `process:${randomUUID()}` });
  assert.equal(other.shown, false); assert.equal(other.workbench.state, 'refused'); assert.equal(other.workbench.code, 'WORKBENCH_SESSION_UNKNOWN');
  assert.equal(shows.list().length, 2);
});

test('launching writes the discovery record beside the inbox, removes it on close, and --show resolves last-session or a ledger id', async t => {
  const { root } = project(t);
  assert.deepEqual(parseWorkbenchArgs(['--show', 'last-session', '--no-open']), { sessionId: undefined, show: 'last-session', open: false });
  assert.deepEqual(parseWorkbenchArgs([]), { sessionId: undefined, show: undefined, open: true });
  assert.throws(() => parseWorkbenchArgs(['--show']), { code: 'WORKBENCH_ARGUMENT_INVALID' });
  assert.throws(() => parseWorkbenchArgs(['--show', 'a', '--show', 'b']), { code: 'WORKBENCH_ARGUMENT_INVALID' });
  assert.equal(resolveShowTarget(root, 'last-session'), null, 'nothing recorded yet');
  assert.throws(() => resolveShowTarget(root, `process:${randomUUID()}`), { code: 'WORKBENCH_SESSION_UNKNOWN' });
  assert.throws(() => resolveShowTarget(root, '../evidence'), { code: 'WORKBENCH_SESSION_ID_INVALID' });
  const session = randomUUID();
  writeRun(root, { sessionId: session });
  assert.equal(resolveShowTarget(root, 'last-session'), `process:${session}`);
  assert.equal(resolveShowTarget(root, `process:${session}`), `process:${session}`);
  assert.equal(workbenchShowUrl('http://127.0.0.1:1/', `process:${session}`), `http://127.0.0.1:1/#session/process%3A${session}`);
  assert.equal(workbenchShowUrl('http://127.0.0.1:1/', null), 'http://127.0.0.1:1/');
  const server = await launchWorkbench(root, { onPairingState: () => {} });
  t.after(() => server.close());
  assert.ok(server.control?.record && existsSync(server.control.record));
  assert.deepEqual(listWorkbenchControls(root).map(item => item.session_id), [server.sessionId]);
  assert.equal((await requestWorkbenchShow(root, `process:${session}`)).reply.ok, true);
  await server.close();
  assert.equal(existsSync(server.control.record), false);
  assert.deepEqual(listWorkbenchControls(root), []);
});
