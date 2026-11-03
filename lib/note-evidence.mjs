// Private evidence has a transport receipt. The tiny projection returned here
// links an authored note to that receipt; it never verifies the explanation.
import { readFileSync, lstatSync, realpathSync, openSync, fstatSync, closeSync, readSync, constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { secretIn } from './verdicts.mjs';
import { normalizeNoteKey, normalizeNoteOperations } from './note-key.mjs';
import { safeOutputPath } from './output-path.mjs';

export const EVIDENCE_INITIATORS = Object.freeze(['mcp.api_request', 'mcp.api_saved_requests', 'workbench.request', 'cli.saved', 'cli.request', 'cli.protocol', 'cli.learn', 'cli.doctor', 'cli.map', 'cli.view', 'cli.feedback', 'library.apiRequest', 'library.apiReadProbe', 'library.batch']);
const transports = ['api_request:http', 'api_request:graphql', 'api_request:jsonrpc', 'api_request:grpc', 'api_request:websocket'];
const MAX_BYTES = 16 * 1024 * 1024;
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const safeText = (value, max = 512) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\x00-\x1f\x7f-\x9f]/.test(value) && !secretIn(value) ? value : null;
const hash = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value ? value : null;
const version = value => typeof value === 'string' && value.length <= 80 && !secretIn(value) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value) ? value : null;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value) ? value : null;
const packageIdentity = (() => {
  let packageVersion = null, buildId = null;
  try { packageVersion = version(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); } catch { /* source identity unavailable */ }
  try { buildId = uuid(JSON.parse(readFileSync(new URL('./build-info.json', import.meta.url), 'utf8')).buildId); } catch { /* unpackaged source has no generated build */ }
  return { package_version: packageVersion, build_id: buildId };
})();

export function evidenceInitiator(internal, fallback = 'library.apiRequest') {
  return EVIDENCE_INITIATORS.includes(internal?.initiator) ? internal.initiator : fallback;
}
function safeProvider(value) {
  const text = safeText(value, 1024);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    return text;
  } catch { return null; }
}
function scopeProjection(scope = {}) {
  return { operation: safeText(scope.operation), protocol: ['http', 'graphql', 'jsonrpc', 'grpc', 'websocket'].includes(scope.protocol) ? scope.protocol : null,
    environment: safeText(scope.environment, 128), provider: safeProvider(scope.provider),
    contract_digest: hash(scope.contract_digest ?? scope.contractDigest) };
}
// One random identity per host process (an MCP server, one CLI invocation).
// build_id names the installed package build, which every process of one
// install shares; the session ledger groups calls by this field instead. It
// carries no value from a request, response or machine.
export const PROCESS_SESSION_ID = randomUUID();
export function requestEvidenceOrigin(initiator, protocol = 'http', scope = {}) {
  return { v: 1, initiator: EVIDENCE_INITIATORS.includes(initiator) ? initiator : 'library.apiRequest',
    transport: transports.includes(`api_request:${protocol}`) ? `api_request:${protocol}` : null,
    observed_at: new Date().toISOString(), ...packageIdentity, session_id: PROCESS_SESSION_ID,
    scope: scopeProjection({ ...scope, protocol }) };
}
function projectOrigin(origin) {
  if (!object(origin) || origin.v !== 1) origin = {};
  return { provenance: {
    initiator: EVIDENCE_INITIATORS.includes(origin.initiator) ? origin.initiator : 'unknown',
    transport: transports.includes(origin.transport) ? origin.transport : 'unknown',
    observed_at: date(origin.observed_at), package_version: version(origin.package_version), build_id: uuid(origin.build_id),
  }, scope: scopeProjection(object(origin.scope) ? origin.scope : {}) };
}
function refuse(code) { throw Object.assign(new Error('Local evidence reference could not be read safely; no payload was returned.'), { code }); }

/** The evidence directory as a safe read root: an unlinked directory with
 * unlinked ancestors. null when it does not exist yet. Shared by every reader of
 * private evidence (note references, key-source linking).
 */
export function openEvidenceRoot(evidenceDir) {
  if (typeof evidenceDir !== 'string' || !evidenceDir || evidenceDir.includes('\0')) refuse('EVIDENCE_ROOT_INVALID');
  try {
    safeOutputPath(evidenceDir, { directory: true, code: 'EVIDENCE_ROOT_UNSAFE' });
    const rootStat = lstatSync(resolve(evidenceDir));
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) refuse('EVIDENCE_ROOT_UNSAFE');
    return { root: realpathSync(resolve(evidenceDir)), rootStat };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('EVIDENCE_')) throw error;
    refuse('EVIDENCE_ROOT_UNAVAILABLE');
  }
}

/** One evidence file's bytes under the shared rules: a regular, single-link
 * file opened without following links, no larger than maxBytes, unchanged
 * while it was read. Throws EVIDENCE_* codes, or the raw filesystem error for
 * missing or unreadable files so each caller decides what absence means.
 */
export function readEvidenceBytes({ root, rootStat }, name, { maxBytes = MAX_BYTES } = {}) {
  let fd;
  try {
    const file = join(root, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) refuse('EVIDENCE_FILE_UNSAFE');
    // An atomic replacement can unlink the inode while lstat resolves it.
    // Return no bytes; callers that read mutable journals may retry a complete
    // snapshot. Multiple links remain unsafe, rather than a retryable race.
    if (stat.nlink === 0) refuse('EVIDENCE_FILE_CHANGED');
    if (stat.nlink !== 1) refuse('EVIDENCE_FILE_UNSAFE');
    if (stat.size > maxBytes) refuse('EVIDENCE_TOO_LARGE');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.dev !== stat.dev || before.ino !== stat.ino) refuse('EVIDENCE_FILE_CHANGED');
    if (before.size > maxBytes) refuse('EVIDENCE_TOO_LARGE');
    // Bound the allocation even if another process grows the file after stat.
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, length);
      if (!n) break;
      length += n;
    }
    const after = fstatSync(fd), entry = lstatSync(file), rootAfter = lstatSync(root);
    if (length !== before.size || after.size !== before.size || after.nlink !== 1 || entry.nlink !== 1 || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || entry.dev !== before.dev || entry.ino !== before.ino || entry.isSymbolicLink()
      || rootAfter.dev !== rootStat.dev || rootAfter.ino !== rootStat.ino) refuse('EVIDENCE_FILE_CHANGED');
    return buffer.subarray(0, length);
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Resolve exact local IDs, never caller paths. Missing old files stay missing.
 * New stamps are machine-written metadata in an editable local file, not a
 * signature; digest binding detects later byte changes, not the author's truth.
 */
export function resolveNoteEvidence(runIds, { evidenceDir, key, operation, operations, environment, provider, contractDigest } = {}) {
  if (key !== undefined) {
    const target = normalizeNoteKey(key);
    if (target.kind === "operation") operation = target.op;
  }
  const applicable = normalizeNoteOperations(operations);
  if (!Array.isArray(runIds) || runIds.length > 16 || runIds.some(id => typeof id !== 'string' || (!/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) || secretIn(id))))
    refuse('EVIDENCE_ID_INVALID');
  const ids = [...new Set(runIds)];
  if (!ids.length) return { references: [], warnings: [] };
  const opened = openEvidenceRoot(evidenceDir);
  const root = opened?.root;
  const references = [], warnings = [];
  for (const run_id of ids) {
    const ref = { run_id, state: 'unavailable', digest: null, ...projectOrigin(null) };
    const unavailable = code => { ref.code = code; references.push(ref); warnings.push({ run_id, code }); };
    if (!root) { unavailable('EVIDENCE_MISSING'); continue; }
    let bytes;
    try { bytes = readEvidenceBytes(opened, `${run_id}.json`); }
    catch (error) {
      if (error.code?.startsWith('EVIDENCE_')) throw error;
      if (['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) { unavailable(error.code === 'ENOENT' ? 'EVIDENCE_MISSING' : 'EVIDENCE_UNREADABLE'); continue; }
      refuse('EVIDENCE_FILE_UNSAFE');
    }
    let record;
    try { record = JSON.parse(bytes.toString('utf8')); } catch { unavailable('EVIDENCE_INVALID_JSON'); continue; }
    if (!object(record)) { unavailable('EVIDENCE_INVALID_RECORD'); continue; }
    if (record.runId !== undefined && record.runId !== run_id) refuse('EVIDENCE_RUN_ID_MISMATCH');
    Object.assign(ref, { state: 'available', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, ...projectOrigin(record.origin) });
    if (ref.provenance.initiator === 'unknown') warnings.push({ run_id, code: 'EVIDENCE_ORIGIN_UNKNOWN' });
    const expected = { operation, environment, provider, contract_digest: contractDigest };
    const mismatches = [], unknown = [];
    for (const [key, value] of Object.entries(expected)) if (value !== undefined && value !== null) {
      if (ref.scope[key] === null) unknown.push(key);
      else if (ref.scope[key] !== value) mismatches.push(key);
    }
    if (applicable !== undefined && operation === undefined) {
      if (ref.scope.operation === null) unknown.push("operation");
      else if (!applicable.includes(ref.scope.operation)) mismatches.push("operation");
    }
    if (mismatches.length) {
      ref.state = 'scope_mismatch'; ref.code = 'EVIDENCE_SCOPE_MISMATCH';
      warnings.push({ run_id, code: ref.code, fields: mismatches });
    }
    if (unknown.length) warnings.push({ run_id, code: 'EVIDENCE_SCOPE_UNKNOWN', fields: unknown });
    references.push(ref);
  }
  return { references, warnings };
}

// Comparable claims are intentionally narrow. Conditional, historical and
// negative prose is not an assertion that every response has this status.
export function explicitNoteClaims(text) {
  if (typeof text !== 'string') return {};
  text = text.replace(/\bresponds?\s+with\s+(?:HTTP\s+|status\s+)?([1-5]\d\d)\b/giu, 'returns HTTP $1');
  if (/\b(?:if|when|unless|without|before|after|previously|formerly|earlier|used to|returned|may|might|sometimes|except|with|or|either|not|never|cannot|can|could|should|usually|typically|successful|authenticated)\b|\bon (?:success|failure)\b/iu.test(text)) return {};
  const status = text.match(/\b(?:always\s+)?(?:returns?|responds?\s+with)\s+(?:HTTP\s+|status\s+)?([1-5]\d\d)\b/iu)
    ?? text.match(/\b(?:HTTP\s+)?status(?:\s+code)?\s*(?:is|:|=)\s*([1-5]\d\d)\b/iu);
  const code = text.match(/\b(?:returns?\s+)?error[ _-]code\s*(?:is|:|=)?\s*[`"']?([A-Za-z0-9][A-Za-z0-9_.-]{0,63})\b/iu);
  return { ...(status ? { status: Number(status[1]) } : {}), ...(code ? { code: code[1] } : {}) };
}

export const noteScope = identity => ({ operation: identity?.operation, protocol: identity?.protocol,
  environment: identity?.environment, provider: identity?.provider,
  contract_digest: identity?.contract_digest ?? identity?.contractDigest ?? null });
export function scopeCoversNote(actual, expected, record, environmentNames = []) {
  if (!actual || !expected || !actual.operation || actual.protocol !== 'http' || !actual.environment || !actual.provider
    || !expected.operation || expected.protocol !== 'http' || !expected.environment || !expected.provider) return false;
  if (!['operation', 'protocol', 'environment', 'provider', 'contract_digest'].every(key =>
    expected[key] === undefined || actual[key] === expected[key])) return false;
  // A bounded explicit environment mention can narrow coverage, never widen
  // it. Match only declared names, not arbitrary prose or review instructions.
  const mentions = environmentNames.filter(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b(?:in|on|environment)\\s+(?:environment\\s+)?[\x60"']?${escaped}(?![A-Za-z0-9_-])`, 'iu').test(String(record.text).slice(0, 512));
  });
  if (mentions.length && (mentions.length !== 1 || mentions[0] !== actual.environment)) return false;
  return (record.provenance?.evidence ?? []).every(ref => ['operation', 'protocol', 'environment', 'provider', 'contract_digest']
    .every(key => ref.scope?.[key] == null || ref.scope[key] === actual[key]));
}

// Only metadata already promoted by the client is used here. In particular,
// clones can compare a status or a saved bounded contradiction flag without
// needing a private response file. A lone run ID establishes no comparison.
export function noteObservations(ctx, operation, stack) {
  return Object.values(ctx?.api_context?.operations ?? {}).flatMap(entry => {
    const identity = entry?.identity;
    if (identity?.operation !== operation || identity.protocol !== 'http'
      || (identity.stack !== undefined && identity.stack !== stack)) return [];
    return (Array.isArray(entry.observations) ? entry.observations : []).filter(item =>
      item?.source?.kind === 'client' && item.source.tool === 'api_request:http' && item.basis === 'observed'
      && item.verification === 'client-observation' && item.complete === true && Number.isInteger(item.response_status)
      && item.response_status >= 100 && item.response_status <= 599
      && Number.isFinite(Date.parse(item.observed_at)) && Array.isArray(item.evidence))
      .map(item => ({ observed_at: item.observed_at, response_status: item.response_status,
        scope: noteScope(identity), evidence: item.evidence.filter(ref => hash(ref?.digest)
          && !/^(?:\/|[A-Za-z]:|\\)/u.test(ref?.path ?? '') && !ref?.path?.split('/').includes('..')
          && /(?:^|\/)run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/u.test(ref?.path ?? '')),
        note_contradictions: Array.isArray(item.note_contradictions) ? item.note_contradictions : [] }));
  });
}
export function contradictionsSinceReview(record, review, { observations = [], scope, scopeBlocked = false, environmentNames = [], now = Date.now() } = {}) {
  if (scopeBlocked) return null;
  const after = Date.parse(review.at.length === 10 ? `${review.at}T23:59:59.999Z` : review.at);
  const claim = explicitNoteClaims(record.text), runs = new Set(), kinds = new Set();
  for (const item of observations) {
    const at = Date.parse(item.observed_at);
    if (!(at > after && at <= now) || !item.evidence?.length || !scopeCoversNote(item.scope, scope, record, environmentNames)) continue;
    const flags = new Set();
    if (claim.status !== undefined && claim.status !== item.response_status) flags.add('status');
    for (const flag of item.note_contradictions ?? []) if (flag?.note_id === record.id
      && ['status', 'error-code'].includes(flag.kind)) flags.add(flag.kind);
    if (!flags.size) continue;
    for (const ref of item.evidence) {
      const id = ref.path?.split('/').at(-1)?.replace(/\.json$/u, '');
      if (/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id ?? '') && !secretIn(id)) runs.add(id);
    }
    for (const kind of flags) kinds.add(kind);
  }
  return runs.size ? { evidence: [...runs].sort(), kinds: [...kinds].sort() } : null;
}
