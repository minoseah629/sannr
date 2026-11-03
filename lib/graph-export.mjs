import { LAYOUT } from './layout.mjs';
// A portable projection of saved, explicitly bound context. Exporting never
// scans source, traverses grants, reads evidence bodies, or executes an API.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CONTEXT_FILE, MAX_CONTEXT_BYTES, STALE_DAYS_DEFAULT, inspectNoteHistory } from './context.mjs';
import { operationId, operationIdentity, observationReference } from './operation-context.mjs';
import { createGraphSnapshot, normalizeGraphManifest } from './dependency-graph.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';

const MAX_RECORDS = 2000, MAX_KNOWLEDGE_BYTES = 3 * 1024 * 1024;
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('GRAPH_CONTEXT_INVALID', 'Saved context is damaged or unsupported; nothing was exported.');
const workstationPath = /(?:^|[\s"'`(])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|~\/)/u;

function text(value, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f-\x9f]/u.test(value)) invalid();
  scanMetadataSecrets(value, 'GRAPH_CONTEXT_SECRET_REFUSED');
  if (workstationPath.test(value)) fail('GRAPH_CONTEXT_PATH_REFUSED', 'Portable context must omit workstation paths; nothing was exported.');
  return value;
}

function date(value) {
  if (value == null) return undefined;
  text(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  return value;
}

function digest(value, { legacy = false } = {}) {
  if (value == null) return undefined;
  if (typeof value !== 'string' || !(legacy ? /^sha256:(?:[a-f0-9]{16}|[a-f0-9]{64})$/u : /^sha256:[a-f0-9]{64}$/u).test(value)) invalid();
  return value;
}

function projectPath(value) {
  text(value, 2048);
  if (isAbsolute(value) || /^[A-Za-z]:|\\/u.test(value) || value.split('/').some(part => !part || part === '..' || part === '.'))
    fail('GRAPH_CONTEXT_PATH_REFUSED', 'Portable evidence references must be repository-relative; nothing was exported.');
  return value;
}

function localJson(base, path, limit, optional = false) {
  let file;
  try { file = realpathSync(resolve(base, path)); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    fail('GRAPH_CONTEXT_READ_FAILED', 'The local context or manifest could not be read.');
  }
  const rel = relative(base, file);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    fail('GRAPH_CONTEXT_PATH_REFUSED', 'The local context and manifest must stay inside the repository.');
  let raw, fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) invalid();
    if (stat.size > limit) return { oversized: true };
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== stat.size) fail('GRAPH_CONTEXT_CHANGED', 'The local context or manifest changed while it was being read.');
    raw = buffer.subarray(0, offset);
  } catch (error) {
    if (error.code?.startsWith('GRAPH_')) throw error;
    fail('GRAPH_CONTEXT_READ_FAILED', 'The local context or manifest could not be read.');
  } finally { if (fd !== undefined) closeSync(fd); }
  let value;
  try { value = JSON.parse(raw.toString('utf8')); } catch { invalid(); }
  return { value, digest: sha(raw) };
}

function freshness({ recorded_at, observed_at, divergent = false, verified = false }, now) {
  const timestamp = observed_at ?? recorded_at;
  const age = timestamp === undefined ? undefined : Math.floor((now - Date.parse(timestamp)) / 86400000);
  const stale = divergent || (age !== undefined && age > STALE_DAYS_DEFAULT);
  return {
    state: stale ? 'stale' : verified ? 'unknown' : 'unverified',
    ...(recorded_at ? { recorded_at } : {}), ...(observed_at ? { observed_at } : {}),
    ...(age !== undefined && age >= 0 ? { age_days: age } : {}),
    reason: divergent ? 'The saved context records contract or response-shape divergence; recheck before relying on this claim.'
      : age !== undefined && age < 0 ? 'The saved claim date is in the future; current applicability is unknown.'
      : stale ? `The saved claim is older than ${STALE_DAYS_DEFAULT} days; export did not refresh or verify it.`
      : 'Original claim dates are retained. Export did not verify the API, source, contract, or evidence.',
  };
}

// Both observed-shape formats keep structure only. Unknown keys, including
// values/default/example, are deliberately excluded and accounted for.
function shape(input, { legacy = false } = {}) {
  const budget = { nodes: 0, omitted: 0 };
  const children = (values, project) => values.flatMap(value => {
    if (budget.nodes >= 1000) { budget.omitted++; return []; }
    return [project(value)];
  });
  const visit = (value, depth) => {
    budget.nodes++;
    if (depth >= 10) { budget.omitted++; return { type: 'omitted' }; }
    if (legacy) {
      if (typeof value === 'string') {
        if (['string', 'number', 'boolean', 'null'].includes(value)) return { type: value };
        if (value === 'integer') return { type: 'number' };
        if (value === '…' || value === 'undefined') { budget.omitted++; return { type: 'omitted' }; }
        invalid();
      }
      if (Array.isArray(value)) {
        if (value.length > 20) budget.omitted += value.length - 20;
        return { type: 'array', sampled: Math.min(value.length, 20), items: children(value.slice(0, 20), child => visit(child, depth + 1)) };
      }
      if (!object(value)) invalid();
      const entries = Object.entries(value);
      if (entries.length > 100) budget.omitted += entries.length - 100;
      return { type: 'object', properties: Object.fromEntries(children(entries.slice(0, 100), ([key, child]) => [text(key, 128), visit(child, depth + 1)])) };
    }
    if (!object(value)) invalid();
    if (value.type === 'object') {
      if (!object(value.properties)) invalid();
      budget.omitted += Object.keys(value).filter(key => !['type', 'properties'].includes(key)).length;
      const entries = Object.entries(value.properties);
      if (entries.length > 100) budget.omitted += entries.length - 100;
      return { type: 'object', properties: Object.fromEntries(children(entries.slice(0, 100), ([key, child]) => [text(key, 128), visit(child, depth + 1)])) };
    }
    if (value.type === 'array') {
      if (!Array.isArray(value.items) || !Number.isSafeInteger(value.sampled) || value.sampled < 0) invalid();
      budget.omitted += Object.keys(value).filter(key => !['type', 'items', 'sampled'].includes(key)).length;
      if (value.items.length > 20) budget.omitted += value.items.length - 20;
      return { type: 'array', sampled: Math.min(value.sampled, 20), items: children(value.items.slice(0, 20), child => visit(child, depth + 1)) };
    }
    if (!['null', 'string', 'number', 'boolean', 'omitted'].includes(value.type)) invalid();
    budget.omitted += Object.keys(value).filter(key => key !== 'type').length;
    return { type: value.type };
  };
  return { shape: visit(input, 0), omitted: budget.omitted };
}

function source(kind, record_id, contextDigest, stamp) {
  const out = { kind, path: CONTEXT_FILE, record_id, digest: contextDigest };
  if (stamp?.by !== undefined) out.author = text(stamp.by, 256);
  if (stamp?.kind !== undefined) out.claim_kind = text(stamp.kind, 256);
  return out;
}

function legacyRecords(ctx, binding, contextDigest, now, emit, omit) {
  const entries = Object.entries(ctx.operations);
  if (!binding) { if (entries.length) omit(`${entries.length} legacy HTTP operation(s) omitted: no explicit context.legacy node binding.`); return; }
  for (const [operation, entry] of entries) {
    text(operation, 512);
    if (!/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT) \/[^\s?#]*$/u.test(operation) || !object(entry)) invalid();
    if (entry.notes !== undefined && !Array.isArray(entry.notes)) invalid();
    for (const key of ['notes_provenance', 'notes_superseded']) if (entry[key] !== undefined && !Array.isArray(entry[key])) invalid();
    const verifiedAt = date(entry.verified_at);
    const savedDigest = digest(entry.contract_digest, { legacy: true });
    const currentDigest = digest(ctx.api?.contract_digest, { legacy: true });
    const divergent = Boolean(entry.shape_diverged_at) || Boolean(savedDigest && currentDigest && savedDigest !== currentDigest);
    if (entry.shape_diverged_at) date(entry.shape_diverged_at);
    const base = { node: binding, operation, protocol: 'http', notes: [], evidence: [],
      basis: 'unknown', verification: verifiedAt ? 'legacy-verification-recorded' : 'legacy-unverified',
      ...(verifiedAt ? { observed_at: verifiedAt } : {}),
      ...(savedDigest?.length === 71 ? { contractDigest: savedDigest } : {}),
      source: source('legacy-http', `operations/${operation}`, contextDigest),
      omissions: ['Legacy request and response values, enums, examples, and transport settings are not exported.',
        'Legacy context has no explicit environment identity; no environment was inferred.'],
      freshness: freshness({ observed_at: verifiedAt, divergent, verified: Boolean(verifiedAt) }, now) };
    if (entry.source_file != null) projectPath(entry.source_file);
    if (entry.source_file) base.omissions.push('The saved source-file reference was not checked or copied; the original context record retains it.');
    if (savedDigest && savedDigest.length !== 71) base.omissions.push('The legacy contract digest is truncated and was not promoted to a full SHA-256 identity.');
    if (entry.shape !== undefined) {
      const projected = shape(entry.shape, { legacy: true });
      base.response_shape = projected.shape;
      if (projected.omitted) base.omissions.push(`${projected.omitted} response structure item(s) omitted by projection limits.`);
    }
    base.id = sha(JSON.stringify([binding, operation, 'legacy-operation']));
    const history = inspectNoteHistory(entry, operation);
    if (history.state === 'invalid') invalid();
    const issueCodes = [...new Set(history.issues.map(issue => issue.code))].slice(0, 8).join(', ');
    if (history.issues.length) base.omissions.push(`Note history ${history.state}; ${issueCodes}. Read original history before relying on a claim.`);
    emit(base);
    for (const record of history.active) {
      const { index, text: note, provenance: stamp } = record;
      if (stamp != null && !object(stamp)) invalid();
      const at = date(stamp?.at);
      const observed = stamp?.kind === 'learn_observation';
      const item = { id: sha(JSON.stringify([binding, operation, 'legacy-note', index])), node: binding, operation,
        protocol: 'http', notes: [text(note)], basis: observed ? 'observed' : stamp ? 'authored' : 'unknown',
        verification: 'legacy-unverified', ...(at ? { recorded_at: at } : {}),
        evidence: [], source: source('legacy-http', `operations/${operation}/notes/${index}`, contextDigest, stamp),
        omissions: ['The note does not inherit the operation verification timestamp. No API assertion was executed during export.',
          'Legacy context has no explicit environment identity; no environment was inferred.'],
        freshness: freshness({ recorded_at: at, divergent }, now) };
      if (!stamp) item.omissions.push('The original note has no author or recorded date.');
      if (stamp?.evidence?.length) item.omissions.push('Authored note evidence provenance remains in the original note history; local request evidence is not copied into this graph snapshot.');
      if (history.issues.length) item.omissions.push(`Note history ${history.state}; ${issueCodes}. Read the original history before relying on this claim.`);
      emit(item);
    }
    if (history.history.length) omit(`${history.history.length} superseded legacy note(s) omitted from active knowledge.`);
  }
}

function protocolRecords(ctx, bindings, contextDigest, now, emit, omit) {
  if (ctx.api_context === undefined) return;
  const ext = ctx.api_context;
  if (!object(ext) || ext.v !== 1 || !object(ext.operations)) invalid();
  let unbound = 0, noObservations = 0, historical = 0;
  for (const [id, entry] of Object.entries(ext.operations)) {
    if (!object(entry) || !object(entry.identity)) invalid();
    // Only identity metadata is validated here; endpoints are never projected.
    const identity = operationIdentity(entry.identity);
    if (operationId(identity) !== id || !Array.isArray(entry.observations) || !Number.isSafeInteger(entry.omitted_observations) || entry.omitted_observations < 0) invalid();
    const matches = bindings.filter(binding => ['provider', 'environment', 'protocol'].every(key => binding[key] === identity[key]));
    if (matches.length > 1) fail('GRAPH_CONTEXT_BINDING_AMBIGUOUS', 'A saved provider identity has more than one graph node binding.');
    if (!matches.length) { unbound++; continue; }
    if (!entry.observations.length) noObservations++;
    historical += entry.omitted_observations;
    if (entry.legacy || entry.legacy_bindings?.length) omit('Explicit protocol migration references are retained in the original context; their source records were not guessed into graph knowledge.');
    for (const observation of entry.observations) {
      if (!object(observation) || !object(observation.source) || !['client', 'external'].includes(observation.source.kind)
        || !['observed', 'declared', 'authored'].includes(observation.basis)
        || observation.verification !== (observation.source.kind === 'client' ? 'client-observation' : 'external-claim')
        || typeof observation.complete !== 'boolean'
        || !['success', 'error', 'partial', 'incomplete', 'timeout', 'cancelled', 'unknown'].includes(observation.outcome)) invalid();
      for (const key of ['notes', 'omissions', 'evidence']) if (!Array.isArray(observation[key])) invalid();
      const recorded_at = date(observation.recorded_at), observed_at = date(observation.observed_at);
      if (!recorded_at || !observed_at) invalid();
      const recordId = text(observation.id, 512);
      const item = { id: sha(JSON.stringify([matches[0].node, id, recordId])), node: matches[0].node,
        operation: text(identity.operation, 512), protocol: identity.protocol, environment: text(identity.environment, 512),
        basis: observation.basis, verification: observation.verification, recorded_at, observed_at,
        ...(identity.contractDigest ? { contractDigest: identity.contractDigest } : {}),
        notes: observation.notes.slice(0, 20).map(note => text(note)),
        evidence: observation.evidence.slice(0, 8).map(ref => {
          if (!object(ref)) invalid();
          return { path: projectPath(ref.path), digest: digest(ref.digest), state: 'unavailable' };
        }),
        source: source('protocol-context', `api_context/operations/${id}/observations/${recordId}`, contextDigest,
          { by: observation.source.tool, kind: observation.source.kind }),
        omissions: observation.omissions.slice(0, 30).map(item => text(item, 512)),
        freshness: freshness({ recorded_at, observed_at, verified: observation.verification === 'client-observation' }, now) };
      if (own(observation, 'based_on')) item.based_on = observationReference(observation.based_on);
      item.omissions.push('Endpoints, request and response values, adapter metadata, and assertion details are not exported.');
      if (!observation.complete || observation.outcome !== 'success') item.omissions.push(`The saved observation was ${observation.outcome}; completion was ${observation.complete}.`);
      if (observation.notes.length > 20) item.omissions.push(`${observation.notes.length - 20} note(s) omitted by the record limit.`);
      if (observation.omissions.length > 30) item.omissions.push(`${observation.omissions.length - 30} original omission detail(s) omitted by the record limit.`);
      if (observation.evidence.length) item.omissions.push('Evidence files were not copied or checked; references retain artifact identity only.');
      if (observation.evidence.length > 8) item.omissions.push(`${observation.evidence.length - 8} evidence reference(s) omitted by the record limit.`);
      for (const key of ['request_shape', 'response_shape']) if (own(observation, key)) {
        const projected = shape(observation[key]); item[key] = projected.shape;
        if (projected.omitted) item.omissions.push(`${projected.omitted} ${key} item(s) omitted by projection limits.`);
      }
      emit(item);
    }
  }
  if (unbound) omit(`${unbound} protocol operation(s) omitted: no exact provider, environment, and protocol node binding.`);
  if (noObservations) omit(`${noObservations} bound protocol operation(s) have no saved observations.`);
  if (historical) omit(`${historical} historical protocol observation(s) were already omitted from the saved context.`);
}

export function exportGraphSnapshot(root, { manifestPath = LAYOUT.graphManifest } = {}) {
  const base = realpathSync(root);
  const rawManifest = localJson(base, manifestPath, 4 * 1024 * 1024);
  if (rawManifest.oversized) fail('GRAPH_MANIFEST_TOO_LARGE', 'The graph manifest exceeds the 4 MiB input limit.');
  const manifest = normalizeGraphManifest(rawManifest.value);
  const saved = localJson(base, CONTEXT_FILE, MAX_CONTEXT_BYTES, true);
  const at = new Date().toISOString(), now = Date.parse(at), knowledge = [], omissions = new Set();
  let bytes = 0, withheld = 0;
  const omit = message => omissions.add(message);
  const emit = item => {
    // The same API note index may exist in several consumer repositories.
    // Publisher identity keeps those independently authored claims distinct.
    item.id = sha(JSON.stringify([manifest.repository.id, item.id]));
    scanMetadataSecrets(item, 'GRAPH_CONTEXT_SECRET_REFUSED');
    const size = Buffer.byteLength(JSON.stringify(item));
    if (knowledge.length >= MAX_RECORDS || bytes + size > MAX_KNOWLEDGE_BYTES) { withheld++; return; }
    knowledge.push(item); bytes += size;
  };
  if (!saved) omit(`No saved ${CONTEXT_FILE} was present; graph relationships contain declarations only.`);
  else if (saved.oversized) omit(`Saved ${CONTEXT_FILE} exceeds ${MAX_CONTEXT_BYTES} bytes; all saved context was omitted without reading its contents.`);
  else {
    const ctx = saved.value;
    if (!object(ctx) || ctx.v !== 0 || !object(ctx.operations)) invalid();
    legacyRecords(ctx, manifest.context?.legacy, saved.digest, now, emit, omit);
    protocolRecords(ctx, manifest.context?.providers ?? [], saved.digest, now, emit, omit);
    for (const [key, description] of [['mcp_inspections', 'legacy MCP inspection'], ['verdicts', 'verdict']]) {
      if (ctx[key] !== undefined && !Array.isArray(ctx[key]) && !object(ctx[key])) invalid();
      const count = ctx[key] === undefined ? 0 : Object.keys(ctx[key]).length;
      if (count) omit(`${count} ${description} record(s) omitted: graph API identities were not explicitly bound.`);
    }
  }
  if (withheld) omit(`${withheld} knowledge record(s) omitted by the ${MAX_RECORDS}-record or ${MAX_KNOWLEDGE_BYTES}-byte export bound.`);
  omit('Export reads this repository manifest and saved context only; source scans, catalogs, registry providers, usage receipts, and imported suites were not traversed.');
  return createGraphSnapshot(manifest, { knowledge, omissions: [...omissions], at });
}
