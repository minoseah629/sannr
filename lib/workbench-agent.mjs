// Optional repository presence, not browser authority or proof that a model is
// working. The MCP process refreshes its own record until stdin closes. Readers
// never contact the host, start a server, or require an agent to be present.
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, realpath, open, opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { PROJECT_DIR_NAME } from './brand.mjs';
import { writeOutputFileAtomic } from './output-path.mjs';
import { secretIn } from './verdicts.mjs';

export const WORKBENCH_AGENT_PRESENCE_TTL_MS = 45000;
const SESSION = /^wb-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_RECORD_BYTES = 4096;
const MAX_SCAN = 4096;
const DIRECTORY = ['evidence', 'workbench', 'agents'];
const FIELDS = ['version', 'session_id', 'host', 'task', 'attached_at', 'heartbeat_at'];
const fail = (code, message, next) => Object.assign(new Error(message), { code, next });
const unsafe = () => fail('WORKBENCH_PRESENCE_UNSAFE', 'The optional agent presence directory or record is unsafe.',
  'Use a private, repository-owned agents directory with regular records and no symbolic links. The workbench and repository inbox do not require presence.');
const owned = stat => typeof process.getuid !== 'function' || stat.uid === process.getuid();
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function label(value, fallback) {
  if (value === undefined && fallback) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\p{Cc}\p{Cf}]/u.test(value))
    throw fail('WORKBENCH_PRESENCE_LABEL_INVALID', 'The optional presence label must be readable text of at most 120 characters.', 'Use a short host or task label without control characters.');
  let decoded = value;
  for (let count = 0; count < 3; count++) {
    if (secretIn(decoded, { allowAuthReferences: true }) || Object.entries(process.env).some(([name, secret]) =>
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name) && secret?.length >= 6 && decoded.includes(secret))
      || /(?:^|[\s"'`(=])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/)/u.test(decoded)
      || /\b[a-z][a-z0-9+.-]*:\/\//i.test(decoded) || /(?:^|[\s"'`(=])\/\//.test(decoded))
      throw fail('WORKBENCH_PRESENCE_LABEL_PRIVATE', 'The optional presence label contains credential-shaped text, a private path or a URL.', 'Remove private values, workstation paths and URLs from the label; use an operation name or short task description.');
    let next; try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break; decoded = next;
  }
  return value.trim();
}
function instant(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
async function directory(root, create = false) {
  let path = await realpath(root);
  for (const [index, part] of [PROJECT_DIR_NAME, ...DIRECTORY].entries()) {
    path = join(path, part);
    if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await lstat(path);
    // Shared repositories commonly have group-writable ancestors. Only this
    // feature's private leaf needs private ownership/permissions; links anywhere
    // below the selected repository still must not redirect presence writes.
    if (stat.isSymbolicLink() || !stat.isDirectory() || index === DIRECTORY.length && (!owned(stat) || (stat.mode & 0o077))) throw unsafe();
  }
  return path;
}
async function readRecord(path, file) {
  const handle = await open(join(path, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !owned(stat) || (stat.mode & 0o077) || stat.size > MAX_RECORD_BYTES) throw unsafe();
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > MAX_RECORD_BYTES) throw unsafe();
    let record;
    try { record = JSON.parse(text); } catch { throw unsafe(); }
    if (!isObject(record) || Object.keys(record).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(record, key))
      || record.version !== 1 || record.session_id !== file.slice(0, -5) || !SESSION.test(record.session_id)
      || !instant(record.attached_at) || !instant(record.heartbeat_at) || record.heartbeat_at < record.attached_at
      || label(record.host) !== record.host || label(record.task) !== record.task) throw unsafe();
    return { record, stat };
  } finally { await handle.close(); }
}
function view(record, now) {
  const heartbeat_age_ms = now - Date.parse(record.heartbeat_at);
  return { session_id: record.session_id, host: record.host, task: record.task,
    state: heartbeat_age_ms >= 0 && heartbeat_age_ms <= WORKBENCH_AGENT_PRESENCE_TTL_MS ? 'attached' : 'stale',
    attached_at: record.attached_at, heartbeat_at: record.heartbeat_at, heartbeat_age_ms };
}

/** A bounded informational read: absent, old, malformed or unsafe presence never
 * refuses standalone use. Unavailable records are named without their contents. */
export async function listWorkbenchAgents(root, { now = Date.now(), limit = 32 } = {}) {
  if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new TypeError('Invalid presence listing options.');
  const result = { agents: [], stale: 0, unavailable: [], unavailable_omitted: 0, omitted: 0, scan_omitted: false,
    stale_after_ms: WORKBENCH_AGENT_PRESENCE_TTL_MS };
  const unavailable = (code, session_id) => {
    if (result.unavailable.length < 20) result.unavailable.push({ ...(session_id ? { session_id } : {}), code });
    else result.unavailable_omitted++;
  };
  let path, handle;
  try { path = await directory(root); handle = await opendir(path); }
  catch (error) { if (error.code !== 'ENOENT') unavailable('WORKBENCH_PRESENCE_UNSAFE'); return result; }
  let scanned = 0;
  try {
    for await (const entry of handle) {
      if (++scanned > MAX_SCAN) { result.scan_omitted = true; break; }
      if (!entry.name.endsWith('.json') || !SESSION.test(entry.name.slice(0, -5))) continue;
      try {
        const { record } = await readRecord(path, entry.name), current = view(record, now);
        if (current.state === 'stale') result.stale++;
        else result.agents.push(current);
      } catch (error) { if (error.code !== 'ENOENT') unavailable('WORKBENCH_PRESENCE_UNSAFE', entry.name.slice(0, -5)); }
    }
  } catch { unavailable('WORKBENCH_PRESENCE_UNSAFE'); }
  result.agents.sort((a, b) => b.heartbeat_at.localeCompare(a.heartbeat_at) || a.session_id.localeCompare(b.session_id));
  result.omitted = Math.max(0, result.agents.length - limit);
  result.agents = result.agents.slice(0, limit);
  return result;
}

// Clean only validated, expired records while attaching. Informational reads
// remain read-only. Cleanup is best-effort: recheck the identity, heartbeat and
// modification time before unlinking. This is not atomic compare-and-delete.
// Invalid records are preserved, and cleanup errors never prevent attachment.
async function pruneExpiredPresence(path, now) {
  let scanned = 0, pruned = 0;
  let handle;
  try { handle = await opendir(path); } catch { return pruned; }
  try { for await (const entry of handle) {
    if (++scanned > MAX_SCAN) break;
    if (!entry.name.endsWith('.json') || !SESSION.test(entry.name.slice(0, -5))) continue;
    try {
      const prior = await readRecord(path, entry.name);
      if (now - Date.parse(prior.record.heartbeat_at) <= WORKBENCH_AGENT_PRESENCE_TTL_MS
        || now - prior.stat.mtimeMs <= WORKBENCH_AGENT_PRESENCE_TTL_MS) continue;
      const current = await readRecord(path, entry.name);
      if (current.stat.ino !== prior.stat.ino || current.stat.dev !== prior.stat.dev
        || current.stat.mtimeMs !== prior.stat.mtimeMs || JSON.stringify(current.record) !== JSON.stringify(prior.record)) continue;
      await unlink(join(path, entry.name)); pruned++;
    } catch { /* Unsafe or concurrently changed presence does not block attach. */ }
  } } catch { /* A concurrently unavailable directory does not block attach. */ }
  return pruned;
}

export async function createWorkbenchAgent({ root, sessionId = `wb-${randomUUID()}`, host, task,
  heartbeatMs = 15000, now = Date.now } = {}) {
  if (!SESSION.test(sessionId) || !Number.isInteger(heartbeatMs) || heartbeatMs < 10 || typeof now !== 'function')
    throw new TypeError('Invalid workbench presence options.');
  const at = new Date(now()).toISOString();
  let record = { version: 1, session_id: sessionId, host: label(host, 'Coding agent'), task: label(task), attached_at: at, heartbeat_at: at };
  let path;
  try { path = await directory(root, true); } catch (error) { if (error.code === 'WORKBENCH_PRESENCE_UNSAFE') throw error; throw unsafe(); }
  await pruneExpiredPresence(path, now());
  const recordPath = join(path, `${sessionId}.json`);
  // The leaf and every record are private. The ignore rule also protects a
  // fresh repository before any other command has established evidence ignores.
  writeOutputFileAtomic(join(path, '.gitignore'), '*\n', { mode: 0o600, code: 'WORKBENCH_PRESENCE_UNSAFE' });
  let handle, ownedRecord;
  try {
    handle = await open(recordPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    ownedRecord = await handle.stat();
  } catch (error) {
    if (error.code === 'EEXIST') throw fail('WORKBENCH_PRESENCE_EXISTS', 'That optional presence identity already exists.', 'Attach with a new session identity; existing presence was not overwritten.');
    throw unsafe();
  } finally { await handle?.close(); }
  let closing = false, timer, resolveClosed, lastError;
  let writing = Promise.resolve();
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  async function ownRecord() {
    const current = await readRecord(path, `${sessionId}.json`);
    if (current.stat.ino !== ownedRecord.ino || current.stat.dev !== ownedRecord.dev
      || JSON.stringify(current.record) !== JSON.stringify(record)) throw unsafe();
  }
  function update(nextTask) {
    const update = writing.catch(() => {}).then(async () => {
      if (closing) return null;
      try {
        await directory(root);
        await ownRecord();
        const previousTask = record.task, taskUpdated = nextTask !== undefined && nextTask !== previousTask;
        const next = { ...record, ...(nextTask !== undefined ? { task: nextTask } : {}), heartbeat_at: new Date(now()).toISOString() };
        writeOutputFileAtomic(recordPath, `${JSON.stringify(next)}\n`, { mode: 0o600, code: 'WORKBENCH_PRESENCE_UNSAFE' });
        ownedRecord = await lstat(recordPath);
        record = next; lastError = undefined;
        return { ...view(record, now()), ...(nextTask !== undefined ? { task_updated: taskUpdated, ...(taskUpdated ? { previous_task: previousTask } : {}) } : {}) };
      } catch { lastError = 'WORKBENCH_PRESENCE_UNSAFE'; throw unsafe(); }
    });
    writing = update;
    return update;
  }
  function refresh() { return update(); }
  function updateTask(task) { return update(label(task)); }
  async function close(reason = 'detached') {
    if (closing) return closed;
    closing = true; clearInterval(timer);
    await writing.catch(() => {});
    let cleanup;
    try { await directory(root); await ownRecord(); await unlink(recordPath); }
    catch (error) { if (error.code !== 'ENOENT') cleanup = 'WORKBENCH_PRESENCE_UNSAFE'; }
    resolveClosed({ reason, ...(cleanup ? { cleanup_error: cleanup } : {}) });
    return closed;
  }
  timer = setInterval(() => { void refresh().catch(() => {}); }, heartbeatMs);
  timer.unref?.();
  return { sessionId, refresh, updateTask, close, closed,
    info: () => ({ ...view(record, now()), ...(lastError ? { warning: lastError } : {}) }) };
}
