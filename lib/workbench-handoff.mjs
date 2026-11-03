// A private operator inbox, not API knowledge or permission to run a request.
// Only bounded identities, result summaries and explicit operator prose enter
// this journal. Request values, documents and response bodies have no field.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, opendirSync, rmdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { LAYOUT } from './layout.mjs';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { secretIn } from './verdicts.mjs';

export const WORKBENCH_HANDOFF_LIMITS = Object.freeze({ events: 1000, bytes: 256 * 1024, message: 1000, page: 100, sessions: 256,
  check: 2000, prompt: 4000, environments: 8, run_request_journals: 16 });
const UUID = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const SESSION = new RegExp(`^wb-${UUID}$`), EVENT_ID = new RegExp(`^${UUID}$`), REQUEST_ID = new RegExp(`^req-${UUID}$`);
const KINDS = ['saved', 'edited', 'renamed', 'deleted', 'request_result', 'follow_up', 'run_request'];
// A run request carries a review decision's identity, what to check and the
// verify prompt. Only this kind may use these fields, and only these fields.
const RUN_REQUEST_FIELDS = ['note_id', 'requested_at', 'requested_by', 'requested_actor', 'check', 'environments', 'prompt', 'prompt_claim'];
const INPUT_FIELDS = ['kind', 'stack', 'environment', 'operation', 'request_id', 'saved_ref', 'previous_ref', 'request_digest', 'previous_request_digest', 'run_id', 'status', 'error_code', 'message', ...RUN_REQUEST_FIELDS];
// Prose kinds name their author class; both remain untrusted data.
const MESSAGE_SOURCE = { follow_up: 'operator', run_request: 'review' };
const RECORD_FIELDS = [...INPUT_FIELDS, 'seq', 'event_id', 'at', 'message_source', 'message_trust'];
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = code => {
  const message = code === 'WORKBENCH_HANDOFF_CAPACITY' ? 'The local handoff inbox is full. Its existing history was kept; start a new workbench session after reviewing pending work.'
    : code === 'WORKBENCH_HANDOFF_BUSY' ? 'The local handoff journal is busy; no event or acknowledgment was written. Retry after the current write. A lock left after a crash requires a human to confirm all writers are stopped before removing that session\'s empty .lock directory.'
    : code === 'WORKBENCH_HANDOFF_SECRET_REFUSED' ? 'The handoff contains credential-shaped text. Remove values and reference the saved request or evidence run instead.'
    : code === 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED' ? 'The handoff contains a private path, a URL or a route without an HTTP method. For an API route, write GET /orders/{id}. Keep private paths and URLs out; use a saved request reference or evidence run identity instead.'
    : code === 'WORKBENCH_HANDOFF_HISTORY_INVALID' ? 'The stored handoff history is malformed or belongs to another session. It was left untouched.'
    : code === 'WORKBENCH_HANDOFF_UNSAFE_PATH' ? 'The local handoff path cannot be read or written safely.'
    : code === 'WORKBENCH_HANDOFF_CURSOR_INVALID' ? 'The handoff cursor must identify an existing event or zero.'
    : code === 'WORKBENCH_HANDOFF_SESSION_INVALID' ? 'Use an exact workbench session identity from the connection or inbox listing.'
    : 'The handoff must contain only supported, bounded metadata and operator prose.';
  throw Object.assign(new Error(message), { code });
};
function keys(value, allowed) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
}
function identity(value) {
  if (typeof value !== 'string' || !SESSION.test(value)) fail('WORKBENCH_HANDOFF_SESSION_INVALID');
  return value;
}
function text(value, max, { multiline = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > max || /[\p{Cc}\p{Cf}]/u.test(multiline ? value.replace(/[\n\t]/g, '') : value)) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  return value.normalize('NFC');
}
function secrets(value) {
  if (secretIn(value, { allowAuthReferences: true })) fail('WORKBENCH_HANDOFF_SECRET_REFUSED');
  // The shared shape guard also catches unlabelled values when they match a
  // credential already present in this process. No env file is loaded here.
  for (const [name, secret] of Object.entries(process.env)) if (/(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL)/i.test(name)
    && secret?.length >= 6 && value.includes(secret)) fail('WORKBENCH_HANDOFF_SECRET_REFUSED');
}
const workstationPath = value => /(?:^|[\s"'`(=])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/)/u.test(value);
// A method and canonical route make an API mention unambiguous in prose.
// Keep credential checks over the original text and never let a method prefix
// launder a workstation location. Parameterized home-prefixed routes remain
// useful even though the same prefix can identify a real local directory.
function withoutRouteMentions(value) {
  return value.replace(/\b(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\s`"'(),;]+)/g, (mention, method, rawPath) => {
    if (/(?:^|\/)\.{1,2}$/.test(rawPath)) return mention;
    const path = rawPath.replace(/\.+$/, '');
    try { operation(`${method} ${path}`); } catch { return mention; }
    let decoded = path;
    for (let count = 0; count < 3; count++) {
      try { operation(`${method} ${decoded}`); } catch { return mention; }
      if (/^\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root|mnt|media|proc|sys|dev|run|boot|usr|bin|sbin)(?:\/|$)/.test(decoded)
        && !/^\/[^/]+\/\{[A-Za-z_][A-Za-z0-9_.-]{0,127}\}(?:\/|$)/.test(decoded)) return mention;
      let next; try { next = decodeURIComponent(decoded); } catch { break; }
      if (next === decoded) break; decoded = next;
    }
    return `${method} [route]`;
  });
}
function privateText(value, { prose = false } = {}) {
  let decoded = value;
  for (let i = 0; i < 3; i++) {
    secrets(decoded);
    const locations = prose ? withoutRouteMentions(decoded) : decoded;
    if (workstationPath(locations) || /\b[a-z][a-z0-9+.-]*:\/\//i.test(decoded) || /(?:^|[\s"'`(=])\/\//.test(decoded)
      || prose && /(?:^|[\s(\[{'"`=:>])(?:\/[A-Za-z0-9_.~/-]|~\/|[A-Za-z]:[\\/]|\\\\)/m.test(locations)) fail('WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED');
    let next; try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break; decoded = next;
  }
}
function ref(value) {
  value = text(value, 454);
  if (value.split('/').length > 7 || value.split('/').some(part => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(part))) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  secrets(value); return value;
}
function operation(value) {
  value = text(value, 1040);
  const match = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\s]*)$/.exec(value);
  if (!match || /[?#[\]\\]/.test(match[2]) || /%(?![a-f0-9]{2})/i.test(match[2]) || match[2].includes('//') || match[2].split('/').some(part => part === '.' || part === '..')
    || /[{}]/.test(match[2].replace(/\{[A-Za-z_][A-Za-z0-9_.-]{0,127}\}/g, ''))) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  // This is a canonical contract operation, not prose or a filesystem read.
  // A route may legitimately start with /home or include colon/percent syntax.
  // Keep credential checks, but never classify its path as a workstation path.
  let decoded = value;
  for (let count = 0; count < 3; count++) {
    secrets(decoded);
    let next; try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break; decoded = next;
  }
  return value;
}
const HOST = /^(?:(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const ENVIRONMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function environments(value) {
  if (!Array.isArray(value) || value.length > WORKBENCH_HANDOFF_LIMITS.environments) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  return value.map(item => {
    keys(item, ['name', 'host', 'production']);
    const name = text(item.name, 128);
    // A resolved host is a host name with an optional port, never a URL.
    if (!ENVIRONMENT.test(name) || typeof item.production !== 'boolean'
      || Object.hasOwn(item, 'host') && (typeof item.host !== 'string' || item.host.length > 260 || !HOST.test(item.host))) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
    secrets(name);
    return { name, ...(Object.hasOwn(item, 'host') ? { host: item.host } : {}), production: item.production };
  });
}
function prose(value, max) {
  const out = text(value, max, { multiline: true }).trim();
  if (!out) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  privateText(out, { prose: true });
  return out;
}
function projectRunRequest(input) {
  if (Reflect.ownKeys(input).some(key => !['kind', 'stack', 'operation', ...RUN_REQUEST_FIELDS].includes(key))
    || !['operation', ...RUN_REQUEST_FIELDS].every(key => Object.hasOwn(input, key))) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  const out = { kind: 'run_request' };
  if (Object.hasOwn(input, 'stack')) {
    out.stack = text(input.stack, 63);
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(out.stack)) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  }
  out.operation = operation(input.operation);
  out.note_id = text(input.note_id, 71);
  out.requested_at = text(input.requested_at, 24);
  out.requested_by = text(input.requested_by, 128);
  if (!/^sha256:[a-f0-9]{64}$/.test(out.note_id) || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(out.requested_at)
    || !['person', 'agent'].includes(input.requested_actor) || !['quoted', 'by-identity'].includes(input.prompt_claim)) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  privateText(out.requested_by);
  out.requested_actor = input.requested_actor;
  out.check = prose(input.check, WORKBENCH_HANDOFF_LIMITS.check);
  out.environments = environments(input.environments);
  out.prompt = prose(input.prompt, WORKBENCH_HANDOFF_LIMITS.prompt);
  out.prompt_claim = input.prompt_claim;
  return out;
}
function projectEvent(input) {
  keys(input, INPUT_FIELDS);
  if (!KINDS.includes(input.kind)) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  if (input.kind === 'run_request') return projectRunRequest(input);
  if (RUN_REQUEST_FIELDS.some(key => Object.hasOwn(input, key))) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  const out = { kind: input.kind };
  const patterns = {
    stack: /^[a-z0-9][a-z0-9-]{0,62}$/, environment: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
    request_id: REQUEST_ID, request_digest: /^[a-f0-9]{64}$/, previous_request_digest: /^[a-f0-9]{64}$/, run_id: /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/,
    error_code: /^[A-Z][A-Z0-9_]{0,95}$/,
  };
  for (const [key, pattern] of Object.entries(patterns)) if (Object.hasOwn(input, key)) {
    const value = text(input[key], 132);
    if (!pattern.test(value)) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
    secrets(value); out[key] = value;
  }
  for (const key of ['saved_ref', 'previous_ref']) if (Object.hasOwn(input, key)) out[key] = ref(input[key]);
  if (Object.hasOwn(input, 'operation')) out.operation = operation(input.operation);
  if (Object.hasOwn(input, 'status')) {
    if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599 || input.kind !== 'request_result') fail('WORKBENCH_HANDOFF_INPUT_INVALID');
    out.status = input.status;
  }
  if (Object.hasOwn(input, 'message')) {
    if (input.kind !== 'follow_up') fail('WORKBENCH_HANDOFF_INPUT_INVALID');
    const message = text(input.message, WORKBENCH_HANDOFF_LIMITS.message, { multiline: true }).trim();
    if (!message) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
    // Canonical route mentions are readable in prose; ambiguous slash paths
    // and private mount points still require safe operation/reference fields.
    privateText(message, { prose: true });
    out.message = message;
  }
  if (input.kind === 'follow_up' && !out.message) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  return out;
}
function directoryFor(root) {
  if (typeof root !== 'string' || !root || root.includes('\0')) fail('WORKBENCH_HANDOFF_UNSAFE_PATH');
  return safeOutputPath(join(resolve(root), LAYOUT.evidence, 'workbench', 'handoffs'), { directory: true, code: 'WORKBENCH_HANDOFF_UNSAFE_PATH' });
}
const empty = session => ({ kind: 'workbench-handoff', format_version: 1, session_id: session, acknowledged_through: 0, events: [] });
function readState(root, session) {
  identity(session);
  const directory = directoryFor(root);
  // The evidence reader owns leaf safety and detects atomic replacements.
  // A separate output-path check here could observe an unlinked old inode
  // before the bounded snapshot retry below had a chance to handle it.
  let bytes;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const opened = openEvidenceRoot(directory);
      if (!opened) return empty(session);
      bytes = readEvidenceBytes(opened, `${session}.json`, { maxBytes: WORKBENCH_HANDOFF_LIMITS.bytes });
      break;
    } catch (error) {
      if (error.code === 'ENOENT') return empty(session);
      // Atomic replacement by a legitimate writer can race the evidence
      // helper's inode check. Retry a bounded number of complete snapshots;
      // persistent churn is busy, never an empty or partially read history.
      if (error.code === 'EVIDENCE_FILE_CHANGED') {
        if (attempt < 2) continue;
        fail('WORKBENCH_HANDOFF_BUSY');
      }
      fail(error.code === 'EVIDENCE_TOO_LARGE' ? 'WORKBENCH_HANDOFF_HISTORY_INVALID' : 'WORKBENCH_HANDOFF_UNSAFE_PATH');
    }
  }
  let state;
  try {
    state = JSON.parse(bytes.toString('utf8'));
    keys(state, ['kind', 'format_version', 'session_id', 'acknowledged_through', 'events']);
    if (state.kind !== 'workbench-handoff' || state.format_version !== 1 || state.session_id !== session
      || !Array.isArray(state.events) || state.events.length > WORKBENCH_HANDOFF_LIMITS.events
      || !Number.isInteger(state.acknowledged_through) || state.acknowledged_through < 0 || state.acknowledged_through > state.events.length) throw new Error();
    const ids = new Set();
    for (const [index, event] of state.events.entries()) {
      keys(event, RECORD_FIELDS);
      if (event.seq !== index + 1 || typeof event.event_id !== 'string' || !EVENT_ID.test(event.event_id) || ids.has(event.event_id)
        || typeof event.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.at) || new Date(event.at).toISOString() !== event.at) throw new Error();
      ids.add(event.event_id);
      const input = Object.fromEntries(INPUT_FIELDS.filter(key => Object.hasOwn(event, key)).map(key => [key, event[key]]));
      const projected = projectEvent(input);
      if (Object.keys(input).length !== Object.keys(projected).length
        || Object.keys(input).some(key => JSON.stringify(input[key]) !== JSON.stringify(projected[key]))) throw new Error();
      const source = MESSAGE_SOURCE[event.kind];
      if (source ? event.message_source !== source || event.message_trust !== 'untrusted-data'
        : Object.hasOwn(event, 'message_source') || Object.hasOwn(event, 'message_trust')) throw new Error();
    }
  } catch { fail('WORKBENCH_HANDOFF_HISTORY_INVALID'); }
  return state;
}
function writeState(root, state) {
  const bytes = JSON.stringify(state) + '\n';
  if (state.events.length > WORKBENCH_HANDOFF_LIMITS.events || Buffer.byteLength(bytes) > WORKBENCH_HANDOFF_LIMITS.bytes) fail('WORKBENCH_HANDOFF_CAPACITY');
  const directory = directoryFor(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeOutputFileAtomic(join(directory, '.gitignore'), '*\n', { mode: 0o600, code: 'WORKBENCH_HANDOFF_UNSAFE_PATH' });
  writeOutputFileAtomic(join(directory, `${state.session_id}.json`), bytes, { mode: 0o600, code: 'WORKBENCH_HANDOFF_UNSAFE_PATH' });
}
const cursor = (value, latest) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > latest) fail('WORKBENCH_HANDOFF_CURSOR_INVALID');
  return value;
};
const pageLimit = value => {
  if (!Number.isSafeInteger(value) || value < 1 || value > WORKBENCH_HANDOFF_LIMITS.page) fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  return value;
};
function summary(state) {
  return { pending: state.events.length - state.acknowledged_through, total: state.events.length, acknowledged_through: state.acknowledged_through };
}

function withSessionLock(root, sessionId, change) {
  identity(sessionId);
  const directory = directoryFor(root);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = safeOutputPath(join(directory, `${sessionId}.lock`), { directory: true, code: 'WORKBENCH_HANDOFF_UNSAFE_PATH' });
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code === 'EEXIST') fail('WORKBENCH_HANDOFF_BUSY');
    fail('WORKBENCH_HANDOFF_UNSAFE_PATH');
  }
  const owned = lstatSync(lock);
  try { return change(); }
  finally {
    // Never evict a stale/foreign lock or recursively remove a directory. The
    // empty directory is ours only while its original inode remains in place.
    // A crash leaves it for explicit human recovery after writers are stopped.
    try {
      safeOutputPath(lock, { directory: true, code: 'WORKBENCH_HANDOFF_UNSAFE_PATH' });
      const current = lstatSync(lock);
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino) rmdirSync(lock);
    } catch { /* keep an unsafe or changed lock; do not disguise a committed event */ }
  }
}

/** A per-session exclusive directory lock serializes cross-process append and
 * acknowledgment, including a fresh agent receiving an older live inbox.
 * Readers may see the previous or next complete atomic snapshot. */
export function appendWorkbenchEvent(root, sessionId, event) {
  identity(sessionId);
  // Run requests have their own idempotent writer and journal series.
  if (event?.kind === 'run_request') fail('WORKBENCH_HANDOFF_INPUT_INVALID');
  const projected = projectEvent(event);
  return withSessionLock(root, sessionId, () => {
    const state = readState(root, sessionId);
    const record = { seq: state.events.length + 1, event_id: randomUUID(), at: new Date().toISOString(), ...projected,
      ...(projected.kind === 'follow_up' ? { message_source: 'operator', message_trust: 'untrusted-data' } : {}) };
    state.events.push(record); writeState(root, state); return record;
  });
}
export function readWorkbenchHandoff(root, sessionId, { after = 0, limit = 20 } = {}) {
  const state = readState(root, sessionId);
  cursor(after, state.events.length); pageLimit(limit);
  const events = state.events.slice(after, after + limit), next = events.at(-1)?.seq ?? after;
  return { events, next_cursor: next, ...summary(state), omitted: state.events.length - next };
}
export function acknowledgeWorkbenchHandoff(root, sessionId, through) {
  identity(sessionId);
  if (!Number.isSafeInteger(through) || through < 0) fail('WORKBENCH_HANDOFF_CURSOR_INVALID');
  return withSessionLock(root, sessionId, () => {
    const state = readState(root, sessionId);
    cursor(through, state.events.length);
    if (through > state.acknowledged_through) { state.acknowledged_through = through; writeState(root, state); }
    return summary(state);
  });
}

/** Discover local inboxes after an agent restart without attaching, claiming,
 * or acknowledging them. A bounded directory scan states its omissions. */
export function listWorkbenchHandoffs(root, { limit = 20 } = {}) {
  pageLimit(limit);
  const directory = directoryFor(root), sessions = [], unavailable = [];
  let handle, scanned = 0, scan_omitted = false;
  try { handle = opendirSync(directory); }
  catch (error) { if (error.code === 'ENOENT') return { sessions, omitted: 0, scan_omitted, unavailable, unavailable_omitted: 0 }; fail('WORKBENCH_HANDOFF_UNSAFE_PATH'); }
  try {
    let entry;
    while ((entry = handle.readSync())) {
      if (++scanned > WORKBENCH_HANDOFF_LIMITS.sessions) { scan_omitted = true; break; }
      const session = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : '';
      if (!SESSION.test(session)) continue;
      try {
        const state = readState(root, session);
        sessions.push({ session_id: session, ...summary(state), latest_at: state.events.at(-1)?.at ?? null });
      } catch (error) {
        unavailable.push({ session_id: session, code: error.code?.startsWith('WORKBENCH_HANDOFF_') ? error.code : 'WORKBENCH_HANDOFF_HISTORY_INVALID' });
      }
    }
  } finally { handle.closeSync(); }
  sessions.sort((a, b) => (b.latest_at ?? '').localeCompare(a.latest_at ?? '') || a.session_id.localeCompare(b.session_id));
  return { sessions: sessions.slice(0, limit), omitted: Math.max(0, sessions.length - limit), scan_omitted, unavailable: unavailable.slice(0, limit), unavailable_omitted: Math.max(0, unavailable.length - limit) };
}

// Run requests from review decisions land in one stable repository journal,
// whether or not a workbench is open, so a fresh MCP peer finds them with
// status and every surface reads one place for a request's status. When that
// journal reaches its capacity, the next one in a short fixed series opens;
// existing records are never rewritten or evicted.
export const runRequestSession = index => `wb-00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
export const RUN_REQUEST_SESSION = runRequestSession(1);
const handoffCode = error => /^WORKBENCH_HANDOFF_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'WORKBENCH_HANDOFF_UNAVAILABLE';
const sameRequest = (a, b) => (a.stack ?? null) === (b.stack ?? null)
  && ['operation', 'note_id', 'requested_at'].every(key => a[key] === b[key]);
function runRequestJournals(root) {
  const directory = directoryFor(root);
  let count = 1;
  while (count < WORKBENCH_HANDOFF_LIMITS.run_request_journals) {
    try { lstatSync(join(directory, `${runRequestSession(count + 1)}.json`)); count++; }
    catch (error) { if (error.code === 'ENOENT') break; fail('WORKBENCH_HANDOFF_UNSAFE_PATH'); }
  }
  return count;
}
/** Refuse a credential-shaped or credential-valued run-request reason before
 * anything is written. The review writer applies its own shape check first. */
export function runRequestTextHasSecret(value) {
  let decoded = String(value ?? '');
  for (let i = 0; i < 3; i++) {
    try { secrets(decoded); } catch { return true; }
    let next; try { next = decodeURIComponent(decoded); } catch { break; }
    if (next === decoded) break; decoded = next;
  }
  return false;
}
/** Check one run request against the inbox bounds without writing it. */
export function validateRunRequest(event) {
  return projectEvent({ ...event, kind: 'run_request' });
}
/** Append run requests idempotently. A request is its review record: the same
 * stack, operation, note identity and decision time is never queued twice,
 * so an exact retry records only a handoff that is still missing. Every input
 * gets its own state; a refused one never blocks the others. */
export function appendRunRequests(root, events) {
  const results = events.map(event => {
    try { return { state: 'pending', record: validateRunRequest(event) }; }
    catch (error) { return { state: 'not_queued', code: handoffCode(error) }; }
  });
  let pending = results.filter(item => item.state === 'pending');
  if (!pending.length) return results.map(({ record, ...item }) => item);
  let last;
  try { last = runRequestJournals(root); }
  catch (error) { for (const item of pending) Object.assign(item, { state: 'not_queued', code: handoffCode(error) }); pending = []; }
  for (let index = 1; index <= WORKBENCH_HANDOFF_LIMITS.run_request_journals && pending.length; index++) {
    const session = runRequestSession(index);
    try {
      const queued = withSessionLock(root, session, () => {
        const state = readState(root, session);
        for (const item of pending) {
          const found = state.events.find(event => event.kind === 'run_request' && sameRequest(event, item.record));
          if (found) Object.assign(item, { state: 'already_queued', session_id: session, seq: found.seq, event_id: found.event_id });
        }
        // Earlier, full journals are only checked for an existing request.
        if (index < last) return [];
        const added = [];
        // The serialized size grows by each record plus its separating comma.
        let size = Buffer.byteLength(JSON.stringify(state) + '\n');
        for (const item of pending.filter(row => row.state === 'pending')) {
          const record = { seq: state.events.length + 1, event_id: randomUUID(), at: new Date().toISOString(), ...item.record,
            message_source: 'review', message_trust: 'untrusted-data' };
          const grown = size + Buffer.byteLength(JSON.stringify(record)) + (state.events.length ? 1 : 0);
          if (state.events.length + 1 > WORKBENCH_HANDOFF_LIMITS.events || grown > WORKBENCH_HANDOFF_LIMITS.bytes) break;
          state.events.push(record); size = grown;
          added.push([item, record]);
        }
        if (added.length) writeState(root, state);
        return added;
      });
      for (const [item, record] of queued) Object.assign(item, { state: 'queued', session_id: session, seq: record.seq, event_id: record.event_id });
    } catch (error) {
      // Without a complete duplicate check, never risk a second event.
      for (const item of pending) if (item.state === 'pending') Object.assign(item, { state: 'not_queued', code: handoffCode(error) });
    }
    pending = pending.filter(item => item.state === 'pending');
    if (index >= last) last = index + 1;
  }
  for (const item of pending) Object.assign(item, { state: 'not_queued', code: 'WORKBENCH_HANDOFF_CAPACITY' });
  return results.map(({ record, ...item }) => item);
}
/** Snapshot the run-request journals for status labels. Never throws: an
 * unreadable journal reports its code instead of inventing a status. */
export function readRunRequests(root) {
  const journals = [];
  try {
    const count = runRequestJournals(root);
    for (let index = 1; index <= count; index++) {
      const session = runRequestSession(index), state = readState(root, session);
      journals.push({ session, acknowledged_through: state.acknowledged_through, events: state.events.filter(event => event.kind === 'run_request') });
    }
  } catch (error) { return { state: 'unavailable', code: handoffCode(error), find: () => null }; }
  return { state: 'available', find(request) {
    for (const journal of journals) {
      const event = journal.events.find(row => sameRequest(row, request));
      if (event) return { session_id: journal.session, seq: event.seq, acknowledged: event.seq <= journal.acknowledged_through };
    }
    return null;
  } };
}
