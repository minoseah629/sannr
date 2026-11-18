// SESSION-1 part 2: the running Workbench's discovery record and control
// socket, so an agent in another process can ask the paired tab to bring a
// session forward without a URL that carries authority.
//
// The launch terminal writes one private record under the ignored evidence
// directory (.sannr/evidence/workbench/control/<wb-session>.json) naming a
// local IPC endpoint it listens on (a named pipe on Windows, a Unix socket
// elsewhere). The endpoint accepts one small JSON line per
// connection: { v: 1, kind: "show", session: "<ledger session id>" }. The
// Workbench validates the id against its own ledger before queuing a banner;
// the browser never navigates until the person clicks. Nothing here grants
// browser authority: pairing still happens in the terminal, the message
// carries only a ledger session id, and a forged id is refused by name.
//
// The background service behind `workbench open` listens on the same kind of
// endpoint and adds its own message kinds (status, grant, stop) through
// `handlers`. One of those mints a browser launch grant, so the endpoint is
// kept to the account that owns it: on POSIX the socket lives in a directory
// only that account can enter. A terminal launch passes no handlers and still
// answers `show` alone.
import { createServer, connect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
const WINDOWS_PIPE_PREFIX = `\\\\.\\pipe\\${PRODUCT}-wb-`;
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
  // Discovery records are repo files, not authority to connect to a remote
  // Windows pipe/SMB host (which could disclose ambient account credentials).
  if (process.platform === 'win32' && (!record.socket.startsWith(WINDOWS_PIPE_PREFIX)
    || !/^[a-f0-9]{16}$/.test(record.socket.slice(WINDOWS_PIPE_PREFIX.length)))) return null;
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
export async function createWorkbenchControl({ root, sessionId, onShow, isPaired = () => false, now = Date.now, heartbeatMs = HEARTBEAT_MS, handlers = {} }) {
  if (!WB_SESSION.test(sessionId) || typeof onShow !== 'function') throw new TypeError('Invalid workbench control options.');
  // Extra message kinds: name -> { fields: [allowed extra keys], run(message) }.
  const kinds = new Map();
  for (const [kind, definition] of Object.entries(handlers ?? {})) {
    if (!/^[a-z][a-z-]{0,31}$/.test(kind) || kind === 'show' || typeof definition?.run !== 'function') throw new TypeError('Invalid workbench control handler.');
    kinds.set(kind, { fields: definition.fields ?? [], run: definition.run });
  }
  const dir = controlDirectory(root);
  safeOutputPath(dir, { directory: true, code: 'WORKBENCH_CONTROL_UNSAFE' });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeOutputFileAtomic(join(dir, '.gitignore'), '*\n', { mode: 0o600, code: 'WORKBENCH_CONTROL_UNSAFE' });
  // A socket path must stay short (104 bytes on macOS); the temp directory
  // keeps it so, and the record names it for the agent in this repository.
  const nonce = randomBytes(8).toString('hex');
  // On POSIX the socket sits alone in a fresh directory that mkdtemp creates
  // for this account only (mode 0700), so no other account can connect. A
  // temp directory too deep for a socket path falls back to the system one.
  let socketDir = null;
  if (process.platform !== 'win32') {
    const prefix = `${PRODUCT}-wb-`, base = join(tmpdir(), prefix).length + 6 + '/control.sock'.length > 100 ? '/tmp' : tmpdir();
    socketDir = mkdtempSync(join(base, prefix));
  }
  const socket = socketDir ? join(socketDir, 'control.sock') : WINDOWS_PIPE_PREFIX + nonce;
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
      const extra = object(message) && message.v === 1 && typeof message.kind === 'string' ? kinds.get(message.kind) : undefined;
      const refused = error => reply({ ok: false, code: typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(error.code) ? error.code : 'WORKBENCH_CONTROL_REFUSED' });
      if (extra) {
        if (Object.keys(message).some(key => key !== 'v' && key !== 'kind' && !extra.fields.includes(key)))
          return reply({ ok: false, code: 'WORKBENCH_CONTROL_MESSAGE_INVALID' });
        Promise.resolve().then(() => extra.run(message)).then(result => reply({ ...(object(result) ? result : {}), ok: true }), refused);
        return;
      }
      if (!object(message) || message.v !== 1 || message.kind !== 'show' || Object.keys(message).length !== 3 || !SESSION_ID.test(message.session ?? ''))
        return reply({ ok: false, code: 'WORKBENCH_CONTROL_MESSAGE_INVALID' });
      Promise.resolve().then(() => onShow(message.session)).then(
        result => reply({ ok: true, paired: isPaired() === true, ...(object(result) ? result : {}) }), refused);
    });
  });
  server.on('error', () => {});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ path: socket, exclusive: true }, () => { server.off('error', reject); resolve(); }); });
  } catch (error) {
    if (socketDir) try { rmdirSync(socketDir); } catch { /* nothing was created in it */ }
    throw error;
  }
  if (socketDir) try { chmodSync(socket, 0o600); } catch { /* the directory already keeps other accounts out */ }
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
      if (socketDir) try { rmdirSync(socketDir); } catch { /* already gone, or not empty */ }
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

/**
 * One request to a service's control endpoint, with its reply as the service
 * sent it. Used for the launch kinds (status, grant, stop); never throws.
 */
export function askWorkbenchControl(path, message, { timeoutMs = 1500 } = {}) {
  return ask(path, message, timeoutMs, reply => reply);
}

/** Whether a record's endpoint may be dialled at all on this platform. */
export function controlEndpointAllowed(socket) {
  if (typeof socket !== 'string' || !socket || socket.length > 200) return false;
  return process.platform !== 'win32' || (socket.startsWith(WINDOWS_PIPE_PREFIX) && /^[a-f0-9]{16}$/.test(socket.slice(WINDOWS_PIPE_PREFIX.length)));
}

const showReply = reply => ({ ok: reply.ok === true, paired: reply.paired === true, code: typeof reply.code === 'string' ? reply.code : null });
function ask(path, message, timeoutMs, shape = showReply) {
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
        finish(object(reply) ? { state: 'answered', reply: shape(reply) } : { state: 'unreachable', code: 'WORKBENCH_CONTROL_REPLY_INVALID' });
      } catch { finish({ state: 'unreachable', code: 'WORKBENCH_CONTROL_REPLY_INVALID' }); }
    });
    socket.on('close', () => finish({ state: 'unreachable', code: 'ECONNRESET' }));
  });
}
