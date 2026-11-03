// SESSION-1 part 2: the running Workbench's discovery record and control
// socket, so an agent in another process can ask the paired tab to bring a
// session forward without a URL that carries authority.
//
// The launch terminal writes one private record under the ignored evidence
// directory (.sannr/evidence/workbench/control/<wb-session>.json) naming a
// Unix domain socket it listens on. The socket accepts one small JSON line per
// connection: { v: 1, kind: "show", session: "<ledger session id>" }. The
// Workbench validates the id against its own ledger before queuing a banner;
// the browser never navigates until the person clicks. Nothing here grants
// browser authority: pairing still happens in the terminal, the message
// carries only a ledger session id, and a forged id is refused by name.
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { LAYOUT } from './layout.mjs';
import { PRODUCT } from './brand.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { SESSION_ID } from './workbench-session.mjs';

export const WORKBENCH_CONTROL_TTL_MS = 45_000;
const HEARTBEAT_MS = 15_000;
const MAX_MESSAGE_BYTES = 4096;
const MAX_RECORD_BYTES = 2048;
const MAX_RECORDS = 64;
const WB_SESSION = /^wb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = ['version', 'session_id', 'pid', 'socket', 'started_at', 'heartbeat_at'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
export const controlDirectory = root => join(root, LAYOUT.evidence, 'workbench', 'control');
const refusal = (code, next) => Object.assign(new Error(next), { code, next });

function readRecord(dir, name) {
  const path = join(dir, name);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.size > MAX_RECORD_BYTES) return null;
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
  if (!object(record) || Object.keys(record).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(record, key))
    || record.version !== 1 || record.session_id !== name.slice(0, -5) || !WB_SESSION.test(record.session_id)
    || !Number.isSafeInteger(record.pid) || typeof record.socket !== 'string' || !record.socket || record.socket.length > 200
    || !instant(record.started_at) || !instant(record.heartbeat_at)) return null;
  return record;
}

/** The running Workbenches this repository knows about: fresh records only. */
export function listWorkbenchControls(root, { now = Date.now() } = {}) {
  const dir = controlDirectory(root);
  let names;
  try { names = readdirSync(dir).filter(name => name.endsWith('.json')).sort().slice(0, MAX_RECORDS); } catch { return []; }
  const live = [];
  for (const name of names) {
    const record = readRecord(dir, name);
    if (record && now - Date.parse(record.heartbeat_at) <= WORKBENCH_CONTROL_TTL_MS) live.push(record);
  }
  return live.sort((a, b) => b.heartbeat_at.localeCompare(a.heartbeat_at));
}

/**
 * Listen for show requests on behalf of one launched Workbench. `onShow(id)`
 * returns a result object ({ queued: true, ... }) or throws an Error with a
 * named `code`; that code, and only that code, goes back to the requester.
 */
export async function createWorkbenchControl({ root, sessionId, onShow, isPaired = () => false, now = Date.now, heartbeatMs = HEARTBEAT_MS }) {
  if (!WB_SESSION.test(sessionId) || typeof onShow !== 'function') throw new TypeError('Invalid workbench control options.');
  const dir = controlDirectory(root);
  safeOutputPath(dir, { directory: true, code: 'WORKBENCH_CONTROL_UNSAFE' });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOutputFileAtomic(join(dir, '.gitignore'), '*\n', { mode: 0o600, code: 'WORKBENCH_CONTROL_UNSAFE' });
  // A socket path must stay short (104 bytes on macOS); the temp directory
  // keeps it so, and the record names it for the agent in this repository.
  const socket = join(tmpdir(), `${PRODUCT}-wb-${randomBytes(8).toString('hex')}.sock`);
  const server = createServer({ allowHalfOpen: false }, connection => {
    let buffer = '', done = false;
    const reply = payload => { if (done) return; done = true; connection.end(`${JSON.stringify(payload)}\n`); };
    connection.setTimeout(2000, () => reply({ ok: false, code: 'WORKBENCH_CONTROL_TIMEOUT' }));
    connection.on('error', () => { done = true; });
    connection.on('data', chunk => {
      if (done) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return reply({ ok: false, code: 'WORKBENCH_CONTROL_MESSAGE_LIMIT' });
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      let message;
      try { message = JSON.parse(buffer.slice(0, end)); } catch { return reply({ ok: false, code: 'WORKBENCH_CONTROL_MESSAGE_INVALID' }); }
      if (!object(message) || message.v !== 1 || message.kind !== 'show' || Object.keys(message).length !== 3 || !SESSION_ID.test(message.session ?? ''))
        return reply({ ok: false, code: 'WORKBENCH_CONTROL_MESSAGE_INVALID' });
      Promise.resolve().then(() => onShow(message.session)).then(
        result => reply({ ok: true, paired: isPaired() === true, ...(object(result) ? result : {}) }),
        error => reply({ ok: false, code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'WORKBENCH_CONTROL_REFUSED' }));
    });
  });
  server.on('error', () => {});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ path: socket, exclusive: true }, () => { server.off('error', reject); resolve(); }); });
  try { statSync(socket); } catch { /* the listener owns the path */ }
  const recordPath = join(dir, `${sessionId}.json`);
  const started = new Date(now()).toISOString();
  const write = () => writeOutputFileAtomic(recordPath, `${JSON.stringify({ version: 1, session_id: sessionId, pid: process.pid, socket, started_at: started, heartbeat_at: new Date(now()).toISOString() })}\n`, { mode: 0o600, code: 'WORKBENCH_CONTROL_UNSAFE' });
  write();
  const timer = setInterval(() => { try { write(); } catch { /* a missed heartbeat only ages the record */ } }, heartbeatMs);
  timer.unref?.();
  let closed = false;
  return Object.freeze({
    sessionId, socket, record: recordPath,
    async close() {
      if (closed) return; closed = true;
      clearInterval(timer);
      await new Promise(resolve => server.close(() => resolve()));
      for (const path of [socket, recordPath]) try { unlinkSync(path); } catch { /* already gone */ }
    },
  });
}

/**
 * Ask a running Workbench in this repository to bring `session` forward. Never
 * throws for an absent Workbench: the result says so, with the CLI command.
 * Only a fresh record whose socket answers counts as running.
 */
export async function requestWorkbenchShow(root, session, { now = Date.now(), timeoutMs = 1500 } = {}) {
  if (!SESSION_ID.test(session ?? '')) throw refusal('WORKBENCH_SESSION_ID_INVALID', 'Use a ledger session id, such as the one summary returns.');
  const controls = listWorkbenchControls(root, { now });
  const attempts = [];
  for (const control of controls) {
    const answer = await ask(control.socket, { v: 1, kind: 'show', session }, timeoutMs);
    attempts.push({ workbench: control.session_id, ...answer });
    if (answer.state === 'answered') return { state: 'answered', workbench: control.session_id, reply: answer.reply, attempts };
  }
  return { state: controls.length ? 'unreachable' : 'not-running', attempts };
}

function ask(path, message, timeoutMs) {
  return new Promise(resolve => {
    let buffer = '', settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); try { socket.destroy(); } catch { /* closed */ } } };
    const socket = connect({ path });
    socket.setTimeout(timeoutMs, () => finish({ state: 'timeout' }));
    socket.on('error', error => finish({ state: 'unreachable', code: typeof error?.code === 'string' ? error.code : 'ECONNREFUSED' }));
    socket.on('connect', () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_MESSAGE_BYTES) return finish({ state: 'unreachable', code: 'WORKBENCH_CONTROL_REPLY_LIMIT' });
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      try {
        const reply = JSON.parse(buffer.slice(0, end));
        finish(object(reply) ? { state: 'answered', reply: { ok: reply.ok === true, paired: reply.paired === true, code: typeof reply.code === 'string' ? reply.code : null } } : { state: 'unreachable', code: 'WORKBENCH_CONTROL_REPLY_INVALID' });
      } catch { finish({ state: 'unreachable', code: 'WORKBENCH_CONTROL_REPLY_INVALID' }); }
    });
    socket.on('close', () => finish({ state: 'unreachable', code: 'ECONNRESET' }));
  });
}
