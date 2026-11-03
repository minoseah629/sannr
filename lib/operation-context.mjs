// Transport-independent context. The extension is additive: legacy HTTP and
// MCP data keeps its original identity and provenance until explicitly bound.
import { CLI_NAME } from './brand.mjs';
import { stackFactsProjection } from './stack-facts.mjs';
import { inspectNoteHistory } from './note-history.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { assertStacksWritable } from './stack-migration-state.mjs';
import { constants, closeSync, fstatSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, join } from 'node:path';
import { CONTEXT_FILE, MAX_CONTEXT_BYTES, STALE_DAYS_DEFAULT, loadContext, updateContext } from './context.mjs';
import { loadRegistry, providersFor } from './registry.mjs';
import { secretIn, scanMetadataSecrets } from './verdicts.mjs';
import { responseChangeNotice } from './response-change-notice.mjs';
import { safeOutputPath } from './output-path.mjs';
import { contextCommandError } from './context-errors.mjs';
import { contextFileFor, activeStackScopeFor } from './stack-scope.mjs';
import { KEY_SOURCES_INVALID, mergeKeySources, projectKeySources, storedKeySources } from './key-sources.mjs';
import { loadNoteReadContext } from './note-read-model.mjs';
import { decorateNoteRecord, compactNoteRecord, NOTE_DATA_MEANING } from './note-projection.mjs';
import { resolveConfig } from './config.mjs';
import { stackScope } from './stacks.mjs';

export const OPERATION_CONTEXT_VERSION = 1;
const MAX_HISTORY = 20, MAX_OPERATIONS = 2000, MAX_INPUT = 1024 * 1024, MAX_INTERNAL_INPUT = 16 * 1024 * 1024;
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = (value, field, max = 512) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f\p{Cf}]/u.test(value))
    fail('CONTEXT_INPUT_INVALID', `${field} must be a bounded, nonempty string.`);
  scanMetadataSecrets(value, 'CONTEXT_SECRET_REFUSED');
  return value;
};
const requiredIdentityFields = ['provider', 'environment', 'protocol', 'operation', 'endpoint', 'contractDigest'];
const fields = [...requiredIdentityFields, 'stack'];
const own = (value, key) => Object.hasOwn(value, key);
const array = (value, field) => {
  if (value == null) return [];
  if (!Array.isArray(value)) fail('CONTEXT_INPUT_INVALID', `${field} must be an array.`);
  return value;
};
function jsonInput(input, max) {
  try {
    if (!object(input)) throw new Error();
    const ancestors = new Set();
    let nodes = 0;
    const visit = (value, depth) => {
      if (++nodes > 500000 || depth > 64) throw new Error();
      if (value === null || ['string', 'boolean'].includes(typeof value) ||
          (typeof value === 'number' && Number.isFinite(value))) return;
      if ((!object(value) && !Array.isArray(value)) || ancestors.has(value)) throw new Error();
      ancestors.add(value);
      for (const key of Object.keys(value)) visit(value[key], depth + 1);
      ancestors.delete(value);
    };
    visit(input, 0);
    if (Buffer.byteLength(JSON.stringify(input)) > max) throw new Error();
  } catch { fail('CONTEXT_INPUT_INVALID', `Capture must contain bounded JSON data no larger than ${max / (1024 * 1024)} MiB.`); }
}

// Adapter declarations describe what was checked, never payload values or
// transport options. Persist only this shared metadata vocabulary.
function declarationMetadata(input) {
  if (!object(input)) fail('CONTEXT_INPUT_INVALID', 'declaration must be an object.');
  const out = {}, strings = ['protocol', 'version', 'method', 'operation', 'operationType', 'operationName',
    'validationScope', 'responseValidation', 'completion', 'messageCount', 'sentMeaning', 'service'];
  const booleans = ['schemaValidated', 'requestValidated', 'responseValidated', 'requestStream', 'responseStream', 'reflection'];
  for (const key of strings) if (own(input, key)) out[key] = input[key] === null ? null : text(input[key], `declaration.${key}`, 512);
  for (const key of booleans) if (own(input, key)) {
    if (typeof input[key] !== 'boolean') fail('CONTEXT_INPUT_INVALID', `declaration.${key} must be a boolean.`);
    out[key] = input[key];
  }
  if (own(input, 'source')) {
    if (!object(input.source)) fail('CONTEXT_INPUT_INVALID', 'declaration.source must be an object.');
    out.source = Object.fromEntries(['kind', 'file'].filter(key => own(input.source, key))
      .map(key => [key, text(input.source[key], `declaration.source.${key}`, 512)]));
  }
  if (own(input, 'variables')) {
    const variables = array(input.variables, 'declaration.variables');
    if (variables.length > 100) fail('CONTEXT_INPUT_INVALID', 'At most 100 declared variables are supported.');
    out.variables = variables.map(variable => {
      if (!object(variable)) fail('CONTEXT_INPUT_INVALID', 'Declared variables must contain names and types.');
      return { name: text(variable.name, 'variable.name', 128), type: text(variable.type, 'variable.type', 256) };
    });
  }
  if (own(input, 'bounds')) {
    if (!object(input.bounds)) fail('CONTEXT_INPUT_INVALID', 'declaration.bounds must be an object.');
    out.bounds = Object.fromEntries(['timeout_ms', 'max_messages', 'max_frame_bytes', 'max_total_bytes'].filter(key => own(input.bounds, key)).map(key => {
      const value = input.bounds[key];
      if (!Number.isSafeInteger(value) || value < 0) fail('CONTEXT_INPUT_INVALID', 'Declaration bounds must be nonnegative integers.');
      return [key, value];
    }));
  }
  return out;
}

export function operationIdentity(input) {
  if (!object(input)) fail('CONTEXT_IDENTITY_INVALID', 'An operation identity is required.');
  const out = { v: OPERATION_CONTEXT_VERSION };
  if (input.stack !== undefined) {
    if (typeof input.stack !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(input.stack))
      fail('CONTEXT_IDENTITY_INVALID', 'stack must be a valid stack name.');
    out.stack = input.stack;
  }
  for (const key of fields.slice(0, 4)) out[key] = text(input[key], key);
  if (!/^[a-z][a-z0-9-]{0,31}$/u.test(out.protocol))
    fail('CONTEXT_IDENTITY_INVALID', 'protocol must be a lowercase protocol identifier.');
  // Endpoints never carry query arguments or URL credentials into context.
  out.endpoint = input.endpoint == null ? null : text(input.endpoint, 'endpoint', 2048);
  if (out.endpoint && /[?#]/u.test(out.endpoint))
    fail('CONTEXT_IDENTITY_INVALID', 'endpoint must omit query arguments and fragments.');
  if (out.endpoint && /^[a-z][a-z0-9+.-]*:\/\//iu.test(out.endpoint)) {
    let url;
    try { url = new URL(out.endpoint); } catch { fail('CONTEXT_IDENTITY_INVALID', 'endpoint must be a valid URL or a bounded transport identifier.'); }
    if (url.username || url.password) fail('CONTEXT_IDENTITY_INVALID', 'endpoint must omit URL credentials.');
  }
  out.contractDigest = input.contractDigest == null ? null : text(input.contractDigest, 'contractDigest');
  if (out.contractDigest && !/^sha256:[a-f0-9]{64}$/u.test(out.contractDigest))
    fail('CONTEXT_IDENTITY_INVALID', 'contractDigest must be a SHA-256 digest.');
  if (input.v !== undefined && input.v !== 1)
    fail('CONTEXT_VERSION_UNSUPPORTED', 'The operation identity version is unsupported.');
  return out;
}

export function operationId(identity) { return digest(JSON.stringify(operationIdentity(identity))); }

// Values never reach the committed context. Bounded structural samples retain
// names and types, and say when depth, fields, or array sampling omitted data.
export function contextShape(value) {
  let nodes = 0, omitted = 0;
  const visit = (item, depth) => {
    if (++nodes > 500 || depth > 8) { omitted++; return { type: 'omitted' }; }
    if (item === null) return { type: 'null' };
    if (Array.isArray(item)) {
      if (item.length > 5) omitted += item.length - 5;
      const items = [...new Map(item.slice(0, 5).map(child => {
        const shape = visit(child, depth + 1); return [JSON.stringify(shape), shape];
      })).values()];
      return { type: 'array', sampled: Math.min(item.length, 5), items };
    }
    if (object(item)) {
      const entries = Object.entries(item);
      if (entries.length > 50) omitted += entries.length - 50;
      return { type: 'object', properties: Object.fromEntries(entries.slice(0, 50).flatMap(([key, child]) => {
        if (!key.trim() || key.length > 128 || /[\u0000-\u001f\u007f\p{Cf}]/u.test(key) || secretIn(key)) { omitted++; return []; }
        return [[key, visit(child, depth + 1)]];
      })) };
    }
    return { type: typeof item };
  };
  return { shape: visit(value, 0), omitted };
}

/**
 * Why the store would not keep one name of a shape, or null. contextShape
 * drops a key that is blank, over 128 characters, carries a control or format
 * character or that the secret scan flags; the final scan before a capture is
 * written (scanMetadataSecrets) refuses the whole capture when a name reads as
 * a credential reference (`basic:abc`). A caller that would rather drop such a
 * name than lose the capture asks here first: the client's query-name filter.
 */
export const shapeKeyRefusal = key => typeof key !== 'string' || !key.trim() || key.length > 128
  || /[\u0000-\u001f\u007f\p{Cf}]/u.test(key) ? 'not a storable name'
  : secretIn(key) || secretIn(key, { allowAuthReferences: true }) || null;

function evidenceLocator(value) {
  const locator = text(value, 'evidence.locator');
  if (!locator.startsWith('/') || /~(?![01])/u.test(locator))
    fail('CONTEXT_EVIDENCE_INVALID', 'Evidence locators must be valid JSON pointers.');
  // JSON Pointer syntax also accepts workstation paths. Check the promotion
  // boundary for both new captures and retained observations before reuse.
  if (/(?:^|[\s"'`(=])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/)/u.test(locator))
    fail('CONTEXT_EVIDENCE_INVALID', 'Evidence locators must omit absolute workstation paths.');
  return locator;
}

function evidenceRef(root, input) {
  if (!object(input)) fail('CONTEXT_EVIDENCE_INVALID', 'Evidence must name a project-local file.');
  const path = text(input.path, 'evidence.path', 2048);
  if (isAbsolute(path)) fail('CONTEXT_EVIDENCE_INVALID', 'Evidence paths must be project-relative.');
  const base = realpathSync(root);
  let file;
  try { file = realpathSync(resolve(base, path)); }
  catch { fail('CONTEXT_EVIDENCE_MISSING', 'The evidence file is missing.'); }
  if (!file.startsWith(`${base}${sep}`)) fail('CONTEXT_EVIDENCE_INVALID', 'Evidence must stay inside the project.');
  const scope = activeStackScopeFor(root);
  if (scope && !file.startsWith(`${resolve(base, scope.evidenceDir)}${sep}`))
    fail('CONTEXT_EVIDENCE_INVALID', 'Evidence must belong to the selected stack.');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
    fail('CONTEXT_EVIDENCE_INVALID', 'Evidence must be a file no larger than 64 MiB.');
  const ref = { path: relative(base, file).split(sep).join('/'), digest: digest(readFileSync(file)) };
  if (input.locator !== undefined) ref.locator = evidenceLocator(input.locator);
  return ref;
}

function extension(ctx, create = false) {
  if (!own(ctx, 'api_context') && create) ctx.api_context = { v: 1, operations: {} };
  const ext = ctx.api_context;
  if (own(ctx, 'api_context') && (!object(ext) || ext.v !== 1 || !object(ext.operations)))
    fail('CONTEXT_VERSION_UNSUPPORTED', 'The operation context extension is unsupported or damaged.');
  return ext;
}

function storedShape(shape, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > 30000 || depth > 10 || !object(shape)) fail('CONTEXT_INVALID', 'Stored response structure is damaged.');
  const keys = Object.keys(shape);
  if (shape.type === 'object') {
    if (!object(shape.properties) || Object.keys(shape.properties).length > 50 || keys.some(key => !['type', 'properties'].includes(key)))
      fail('CONTEXT_INVALID', 'Stored object structure is damaged.');
    for (const [key, child] of Object.entries(shape.properties)) {
      text(key, 'shape field', 128); storedShape(child, depth + 1, budget);
    }
  } else if (shape.type === 'array') {
    if (!Array.isArray(shape.items) || shape.items.length > 5 || !Number.isInteger(shape.sampled) || shape.sampled < 0 || shape.sampled > 5 ||
        keys.some(key => !['type', 'items', 'sampled'].includes(key))) fail('CONTEXT_INVALID', 'Stored array structure is damaged.');
    for (const child of shape.items) storedShape(child, depth + 1, budget);
  } else if (!['null', 'string', 'number', 'boolean', 'omitted'].includes(shape.type) || keys.some(key => key !== 'type'))
    fail('CONTEXT_INVALID', 'Stored scalar structure is damaged.');
  return shape;
}

function noteContradictions(value, code = 'CONTEXT_INVALID') {
  if (!Array.isArray(value) || value.length > 32) fail(code, 'Note contradiction metadata must be a bounded list.');
  const seen = new Set();
  return value.map(flag => {
    if (!object(flag) || Object.keys(flag).some(key => !['note_id', 'kind'].includes(key))
      || !/^sha256:[a-f0-9]{64}$/u.test(flag.note_id ?? '') || !['status', 'error-code'].includes(flag.kind))
      fail(code, 'CONTEXT note contradiction metadata must contain only a note identity and comparison kind.');
    const key = `${flag.note_id}:${flag.kind}`;
    if (seen.has(key)) fail(code, 'Note contradiction metadata contains a duplicate comparison.');
    seen.add(key);
    return { note_id: flag.note_id, kind: flag.kind };
  });
}

function storedObservation(value) {
  if (!object(value) || !object(value.source) || !['client', 'external'].includes(value.source.kind) ||
      value.verification !== (value.source.kind === 'client' ? 'client-observation' : 'external-claim') ||
      !['observed', 'declared', 'authored'].includes(value.basis) || typeof value.complete !== 'boolean' ||
      !['success', 'error', 'partial', 'incomplete', 'timeout', 'cancelled', 'unknown'].includes(value.outcome))
    fail('CONTEXT_INVALID', 'Stored observation provenance or outcome is damaged.');
  const out = {};
  for (const key of ['id', 'recorded_at', 'observed_at', 'basis', 'verification', 'outcome']) out[key] = text(value[key], key);
  for (const key of ['recorded_at', 'observed_at']) if (!Number.isFinite(Date.parse(out[key]))) fail('CONTEXT_INVALID', 'Stored observation date is damaged.');
  out.source = { kind: value.source.kind, tool: text(value.source.tool, 'source.tool', 128) };
  out.complete = value.complete;
  if (own(value, 'response_status')) {
    if (!Number.isInteger(value.response_status) || value.response_status < 100 || value.response_status > 599)
      fail('CONTEXT_INVALID', 'Stored HTTP response status is damaged.');
    out.response_status = value.response_status;
  }
  for (const key of ['notes', 'omissions']) {
    if (!Array.isArray(value[key]) || value[key].length > (key === 'notes' ? 10 : 25)) fail('CONTEXT_INVALID', 'Stored observation text is damaged.');
    out[key] = value[key].map(note => text(note, key, key === 'notes' ? 1000 : 512));
  }
  if (!Array.isArray(value.evidence) || value.evidence.length > 8) fail('CONTEXT_INVALID', 'Stored evidence is damaged.');
  out.evidence = value.evidence.map(ref => {
    if (!object(ref) || typeof ref.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(ref.digest)) fail('CONTEXT_INVALID', 'Stored evidence identity is damaged.');
    return { path: text(ref.path, 'evidence.path', 2048), digest: ref.digest,
      ...(own(ref, 'locator') ? { locator: evidenceLocator(ref.locator) } : {}) };
  });
  for (const key of ['sent', 'received', 'attempts']) if (own(value, key)) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail('CONTEXT_INVALID', 'Stored message counts are damaged.');
    out[key] = value[key];
  }
  for (const key of ['request_shape', 'response_shape']) if (own(value, key)) out[key] = storedShape(value[key]);
  if (own(value, 'assertions')) {
    if (!object(value.assertions) || !['passed', 'failed'].every(key => Number.isSafeInteger(value.assertions[key]) && value.assertions[key] >= 0))
      fail('CONTEXT_INVALID', 'Stored assertion counts are damaged.');
    out.assertions = { passed: value.assertions.passed, failed: value.assertions.failed };
  }
  if (own(value, 'declaration')) out.declaration = declarationMetadata(value.declaration);
  if (own(value, 'based_on')) out.based_on = observationReference(value.based_on);
  if (own(value, 'note_contradictions')) {
    if (out.source.kind !== 'client' || out.source.tool !== 'api_request:http' || out.basis !== 'observed')
      fail('CONTEXT_INVALID', 'Note contradiction metadata requires a client HTTP observation.');
    out.note_contradictions = noteContradictions(value.note_contradictions);
  }
  return out;
}

// This links an authored explanation to an immutable source observation. It is
// an artifact identity, never an assertion that the explanation is correct.
export function observationReference(value) {
  if (!object(value) || Object.keys(value).some(key => !['operation_id', 'observation_id', 'observation_digest'].includes(key))
    || !/^sha256:[a-f0-9]{64}$/u.test(value.operation_id ?? '')
    || !/^sha256:[a-f0-9]{64}$/u.test(value.observation_digest ?? ''))
    fail('CONTEXT_INVALID', 'The source observation reference is damaged.');
  return { operation_id: value.operation_id, observation_id: text(value.observation_id, 'observation_id', 512),
    observation_digest: value.observation_digest };
}

function legacyReference(value) {
  if (!object(value) || !['http-operation', 'mcp-inspection'].includes(value.kind) ||
      typeof value.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value.digest))
    fail('CONTEXT_INVALID', 'A stored legacy binding is damaged.');
  const out = { kind: value.kind, key: text(value.key, 'legacy key'), digest: value.digest,
    meaning: 'Explicit author binding; the original record retains its evidence and provenance.' };
  if (out.kind === 'mcp-inspection') {
    if (!['id', 'at'].includes(value.identity_field)) fail('CONTEXT_INVALID', 'A stored MCP binding is damaged.');
    out.identity_field = value.identity_field;
  }
  return out;
}

function storedEntry(id, value) {
  if (!object(value) || operationId(value.identity) !== id || !Array.isArray(value.observations) || value.observations.length > MAX_HISTORY ||
      !Number.isSafeInteger(value.omitted_observations) || value.omitted_observations < 0)
    fail('CONTEXT_INVALID', 'The existing operation context entry is damaged.');
  const out = { identity: operationIdentity(value.identity), observations: value.observations.map(storedObservation),
    omitted_observations: value.omitted_observations };
  if (own(value, 'legacy')) out.legacy = legacyReference(value.legacy);
  if (own(value, 'legacy_bindings')) {
    if (!Array.isArray(value.legacy_bindings) || value.legacy_bindings.length > MAX_HISTORY) fail('CONTEXT_INVALID', 'Stored legacy bindings are damaged.');
    out.legacy_bindings = value.legacy_bindings.map(legacyReference);
  }
  if (own(value, 'omitted_legacy_bindings')) {
    if (!Number.isSafeInteger(value.omitted_legacy_bindings) || value.omitted_legacy_bindings < 0) fail('CONTEXT_INVALID', 'Stored legacy counts are damaged.');
    out.omitted_legacy_bindings = value.omitted_legacy_bindings;
  }
  // Path-key sources (lib/key-sources.mjs): bounded and names-only. Records
  // written before the field existed omit it and remain valid. The field is
  // derived data: a damaged list is projected as absent (readers report
  // KEY_SOURCES_INVALID for the record) and never makes the entry damaged.
  const links = projectKeySources(value);
  if (links.state === 'valid') out.key_sources = links.key_sources;
  return out;
}

// Read-model consumers must not compare a hand-damaged identity or promote an
// arbitrary object that merely resembles a captured response. No evidence
// bodies are read; malformed entries establish no note comparison.
export function validatedNoteObservationContext(ctx) {
  const operations = {};
  try {
    const entries = Object.entries(extension(ctx)?.operations ?? {});
    if (entries.length > MAX_OPERATIONS) return { api_context: { v: 1, operations } };
    for (const [id, value] of entries) {
      try { operations[id] = storedEntry(id, value); }
      catch { /* The ordinary query names this invalid entry; it cannot contradict a review. */ }
    }
  } catch { /* Unsupported/damaged histories establish no comparison. */ }
  return { api_context: { v: 1, operations } };
}

// Merge links into one raw entry, in place, only when the bounded result
// differs. A damaged list is replaced by the freshly derived links, and with
// none the field is removed. The caller holds the context lock and validated
// the entry. Returns { changed, replaced_damaged }.
function mergeEntryKeySources(raw, links) {
  const current = projectKeySources(raw);
  const before = current.state === 'valid' ? current.key_sources : [];
  const merged = links.length ? storedKeySources(mergeKeySources(before, links)) : before;
  if (current.state !== 'damaged' && JSON.stringify(merged) === JSON.stringify(before))
    return { changed: false, replaced_damaged: false };
  if (merged.length) raw.key_sources = merged; else delete raw.key_sources;
  return { changed: true, replaced_damaged: current.state === 'damaged' };
}

/** Every stored operation entry, validated and projected, for local readers
 * that need the whole store at once (the key-source backfill). Throws
 * CONTEXT_INVALID or CONTEXT_VERSION_UNSUPPORTED on damage; a damaged
 * key_sources list is not store damage and is flagged keySourcesDamaged. */
export function storedOperationEntries(ctx) {
  const ext = extension(ctx);
  if (!ext) return [];
  const entries = Object.entries(ext.operations);
  if (entries.length > MAX_OPERATIONS) fail('CONTEXT_INVALID', 'The operation context exceeds its supported capacity.');
  return entries.map(([id, value]) => ({ id, entry: storedEntry(id, value),
    keySourcesDamaged: projectKeySources(value).state === 'damaged' }));
}

/** Record derived key-source links on existing operation records, under the
 * context lock: the store is re-read and revalidated, and nothing is written
 * when no record changes. Every damaged key_sources list in the store is
 * replaced by the links derived for its record now (none removes the field).
 * linksByOperation: Map(operation id → links).
 * Returns { changed: [operation ids], replaced_damaged: [operation ids] }. */
export function recordKeySources(root, linksByOperation) {
  try {
    return updateContext(root, ctx => {
      const ext = extension(ctx);
      const changed = [], replaced = [];
      if (ext) {
        if (Object.keys(ext.operations).length > MAX_OPERATIONS) fail('CONTEXT_INVALID', 'The operation context exceeds its supported capacity.');
        for (const [key, value] of Object.entries(ext.operations)) storedEntry(key, value);
        for (const [id, raw] of Object.entries(ext.operations)) {
          const links = linksByOperation.get(id) ?? [];
          if (!links.length && projectKeySources(raw).state !== 'damaged') continue;
          const result = mergeEntryKeySources(raw, links);
          if (result.changed) changed.push(id);
          if (result.replaced_damaged) replaced.push(id);
        }
        scanMetadataSecrets(changed.map(id => ext.operations[id].key_sources ?? []), 'CONTEXT_SECRET_REFUSED');
      }
      // An unchanged store is not rewritten: abort the write, keep the lock discipline.
      if (!changed.length) throw Object.assign(new Error('unchanged'), { code: 'CONTEXT_KEYS_UNCHANGED' });
      return { changed, replaced_damaged: replaced };
    });
  } catch (error) {
    if (error?.code === 'CONTEXT_KEYS_UNCHANGED') return { changed: [], replaced_damaged: [] };
    throw error;
  }
}

// keySources: links derived from private evidence by the HTTP capture path
// (lib/key-source-evidence.mjs). Internal only: external JSON input cannot
// supply them. They merge into the record in the same locked write as the
// observation, and a merge problem never costs the observation.
export function captureOperationContext(root, input, { internal = false, keySources = [] } = {}) {
  assertStacksWritable(root);
  jsonInput(input, internal ? MAX_INTERNAL_INPUT : MAX_INPUT);
  const stack = activeStackScopeFor(root)?.stack;
  if (stack && input.identity?.stack !== undefined && input.identity.stack !== stack)
    fail('CONTEXT_IDENTITY_INVALID', 'The operation identity names a different stack.');
  const identity = operationIdentity(stack ? { ...input.identity, stack } : input.identity);
  const id = operationId(identity);
  const basis = input.basis ?? 'observed';
  if (!['observed', 'declared', 'authored'].includes(basis)) fail('CONTEXT_INPUT_INVALID', 'Invalid observation basis.');
  if (input.source !== undefined && !object(input.source)) fail('CONTEXT_INPUT_INVALID', 'source must be an object.');
  const source = { kind: internal ? 'client' : 'external', tool: text(input.source?.tool ?? 'external-client', 'source.tool', 128) };
  const observedAt = input.observed_at ?? new Date().toISOString();
  if (typeof observedAt !== 'string' || !Number.isFinite(Date.parse(observedAt)))
    fail('CONTEXT_INPUT_INVALID', 'observed_at must be a timestamp.');
  const observation = { id: randomUUID(), recorded_at: new Date().toISOString(), observed_at: new Date(observedAt).toISOString(),
    basis, source, verification: internal ? 'client-observation' : 'external-claim',
    outcome: input.outcome ?? 'unknown', complete: input.complete === true,
    evidence: array(input.evidence, 'evidence').slice(0, 8).map(ref => evidenceRef(root, ref)),
    notes: array(input.notes, 'notes').slice(0, 10).map(note => text(note, 'note', 1000)),
    omissions: array(input.omissions, 'omissions').slice(0, 20).map(note => text(note, 'omission', 512)) };
  if (own(input, 'note_contradictions')) {
    if (!internal || identity.protocol !== 'http' || source.tool !== 'api_request:http' || basis !== 'observed')
      fail('CONTEXT_INPUT_INVALID', 'Only the client can derive note contradiction metadata.');
    observation.note_contradictions = noteContradictions(input.note_contradictions, 'CONTEXT_INPUT_INVALID');
  }
  if (input.complete !== undefined && typeof input.complete !== 'boolean') fail('CONTEXT_INPUT_INVALID', 'complete must be a boolean.');
  if (!['success', 'error', 'partial', 'incomplete', 'timeout', 'cancelled', 'unknown'].includes(observation.outcome))
    fail('CONTEXT_INPUT_INVALID', 'Invalid protocol outcome.');
  if (internal && identity.protocol === 'http' && input.status !== undefined) {
    if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)
      fail('CONTEXT_INPUT_INVALID', 'HTTP response status must be an integer from 100 to 599.');
    observation.response_status = input.status;
  }
  for (const key of ['sent', 'received', 'attempts']) if (input[key] !== undefined) {
    if (!Number.isSafeInteger(input[key]) || input[key] < 0) fail('CONTEXT_INPUT_INVALID', `${key} must be a nonnegative integer.`);
    observation[key] = input[key];
  }
  for (const key of ['request', 'response']) if (Object.hasOwn(input, key)) {
    const { shape, omitted } = contextShape(input[key]);
    observation[`${key}_shape`] = shape;
    if (omitted) observation.omissions.push(`${key} structure omitted ${omitted} items due to sampling or bounds.`);
  }
  if (input.assertions != null) {
    if (!object(input.assertions)) fail('CONTEXT_INPUT_INVALID', 'assertions must be an object.');
    for (const key of ['passed', 'failed']) if (!Number.isSafeInteger(input.assertions[key]) || input.assertions[key] < 0)
      fail('CONTEXT_INPUT_INVALID', 'Assertion counts must be nonnegative integers.');
    observation.assertions = { passed: input.assertions.passed, failed: input.assertions.failed };
  }
  if (input.evidence?.length > 8) observation.omissions.push('Evidence references were limited to eight.');
  if (input.notes?.length > 10 || input.omissions?.length > 20) observation.omissions.push('Author text was limited.');
  if (input.declaration != null) {
    observation.declaration = declarationMetadata(input.declaration);
    if (JSON.stringify(observation.declaration) !== JSON.stringify(input.declaration))
      observation.omissions.push('Only supported declaration metadata was retained.');
  }
  scanMetadataSecrets({ identity, observation }, 'CONTEXT_SECRET_REFUSED');
  return updateContext(root, ctx => {
    const ext = extension(ctx, true);
    if (Object.keys(ext.operations).length > MAX_OPERATIONS) fail('CONTEXT_INVALID', 'The operation context exceeds its supported capacity.');
    for (const [key, value] of Object.entries(ext.operations)) storedEntry(key, value);
    let entry = ext.operations[id];
    if (!entry && Object.keys(ext.operations).length >= MAX_OPERATIONS)
      fail('CONTEXT_CAPACITY_REACHED', 'Operation context reached its 2000-operation bound.');
    if (!entry) entry = ext.operations[id] = { identity, observations: [], omitted_observations: 0 };
    storedEntry(id, entry);
    const changeNotice = internal ? responseChangeNotice(observation, entry.observations, identity) : null;
    entry.observations.push(observation);
    if (entry.observations.length > MAX_HISTORY) {
      entry.omitted_observations = (entry.omitted_observations ?? 0) + entry.observations.length - MAX_HISTORY;
      entry.observations = entry.observations.slice(-MAX_HISTORY);
    }
    let replacedDamaged = false;
    if (internal && Array.isArray(keySources) && keySources.length) {
      const original = entry.key_sources, hadField = own(entry, 'key_sources');
      try {
        // A damaged list is replaced by this capture's freshly derived links,
        // and the capture result says so.
        replacedDamaged = mergeEntryKeySources(entry, keySources).replaced_damaged;
        scanMetadataSecrets(entry.key_sources ?? [], 'CONTEXT_SECRET_REFUSED');
      } catch {
        if (hadField) entry.key_sources = original; else delete entry.key_sources;
        replacedDamaged = false;
      }
    }
    return { state: 'captured', operation_id: id, observation_id: observation.id, identity,
      ...(changeNotice ? { change_notice: changeNotice } : {}),
      retained_observations: entry.observations.length, omitted_observations: entry.omitted_observations,
      ...(replacedDamaged ? { key_sources: { replaced_damaged: true } } : {}) };
  });
}

function retainedEvidence(root, ref) {
  // Unlike new capture, this path must never replace a recorded digest with
  // today's bytes. Reject links even when they happen to resolve inside root.
  if (typeof ref.path !== 'string' || /^[~/\\]|^[A-Za-z]:|[\\?#]/u.test(ref.path)
    || ref.path.split('/').some(part => !part || part === '.' || part === '..'))
    fail('CONTEXT_EVIDENCE_INVALID', 'The saved evidence path is not repository-relative.');
  let fd;
  try {
    const file = safeOutputPath(join(root, ref.path), { code: 'CONTEXT_EVIDENCE_INVALID' });
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024)
      fail('CONTEXT_EVIDENCE_INVALID', 'The saved evidence must remain a regular, single-link file no larger than 64 MiB.');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const bytes = readSync(fd, buffer, 0, Math.min(buffer.length, before.size + 1 - total), total);
      if (!bytes) break;
      total += bytes; hash.update(buffer.subarray(0, bytes));
      if (total > before.size) fail('CONTEXT_EVIDENCE_CHANGED', 'The saved evidence changed while it was read.');
    }
    const after = fstatSync(fd);
    if (total !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || `sha256:${hash.digest('hex')}` !== ref.digest)
      fail('CONTEXT_EVIDENCE_CHANGED', 'The saved evidence no longer matches its original digest.');
    // Recheck the path after reading the descriptor, including its ancestors.
    safeOutputPath(file, { code: 'CONTEXT_EVIDENCE_INVALID' });
    const atPath = statSync(file);
    if (atPath.dev !== after.dev || atPath.ino !== after.ino || atPath.size !== after.size || atPath.mtimeMs !== after.mtimeMs)
      fail('CONTEXT_EVIDENCE_CHANGED', 'The saved evidence path changed while it was read.');
    if (own(ref, 'locator')) evidenceLocator(ref.locator);
    return { ...ref };
  } catch (error) {
    if (error.code === 'ENOENT') fail('CONTEXT_EVIDENCE_MISSING', 'The saved evidence is missing.');
    if (/^CONTEXT_/u.test(error.code ?? '')) throw error;
    fail('CONTEXT_EVIDENCE_INVALID', 'The saved evidence cannot be read as a safe local file.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Bookkeeping for a lesson about a retained local client observation. Resolve
// and append inside one context lock, retaining original identity and time.
// The callback revalidates the graph binding; it never chooses a new scope.
export function captureObservationLesson(root, { observation_id, operation_id, note }, { resolveScope } = {}) {
  if (process.env.API_CONTEXT_OFF === '1') fail('GRAPH_CONTEXT_DISABLED', 'Graph context recording is disabled.');
  assertStacksWritable(root);
  text(observation_id, 'observation_id', 512); text(note, 'note', 1000);
  if (operation_id !== undefined && !/^sha256:[a-f0-9]{64}$/u.test(operation_id))
    fail('GRAPH_RECORD_INVALID', 'operation_id must be an exact operation digest.');
  const path = safeOutputPath(join(root, contextFileFor(root, CONTEXT_FILE)), { code: 'CONTEXT_INVALID' });
  try { if (statSync(path).size > MAX_CONTEXT_BYTES) fail('CONTEXT_INVALID', 'The local context exceeds its supported limit.'); }
  catch (error) { if (error.code === 'ENOENT') fail('GRAPH_OBSERVATION_MISSING', 'No retained local observation matches this reference.'); throw error; }
  return updateContext(root, ctx => {
    safeOutputPath(path, { code: 'CONTEXT_INVALID' });
    const ext = extension(ctx), entries = Object.entries(ext?.operations ?? {});
    if (entries.length > MAX_OPERATIONS) fail('CONTEXT_INVALID', 'The operation context exceeds its supported capacity.');
    const matches = [];
    for (const [id, raw] of entries) {
      const entry = storedEntry(id, raw);
      if (operation_id !== undefined && id !== operation_id) continue;
      for (let index = 0; index < entry.observations.length; index++) {
        if (entry.observations[index].id === observation_id)
          matches.push({ id, entry, index, original: raw.observations[index] });
      }
    }
    if (matches.length !== 1) fail(matches.length ? 'GRAPH_OBSERVATION_AMBIGUOUS' : 'GRAPH_OBSERVATION_MISSING',
      'Select exactly one retained local client observation.');
    const { id, entry, index, original } = matches[0], source = entry.observations[index];
    if (source.source.kind !== 'client' || source.verification !== 'client-observation' || source.basis !== 'observed')
      fail('GRAPH_OBSERVATION_UNSUPPORTED', 'This mode requires a retained local client observation.');
    if (entry.observations.length >= MAX_HISTORY && index === 0)
      fail('GRAPH_OBSERVATION_RETENTION_LIMIT', 'Recording this lesson would evict its source observation.');
    if (typeof resolveScope !== 'function') fail('GRAPH_RECORD_SCOPE_MISSING', 'An explicit graph provider binding is required.');
    const scope = resolveScope(entry.identity);
    const based_on = { operation_id: id, observation_id: source.id, observation_digest: digest(JSON.stringify(original)) };
    const evidence = source.evidence.map(ref => retainedEvidence(root, ref));
    const now = new Date(), age = Math.floor((now.getTime() - Date.parse(source.observed_at)) / 86400000);
    const observation = { id: randomUUID(), recorded_at: now.toISOString(), observed_at: source.observed_at,
      basis: 'authored', source: { kind: 'external', tool: 'api_context_record' }, verification: 'external-claim',
      outcome: 'unknown', complete: false, based_on, evidence, notes: [note], omissions: [
        'Agent-authored explanation linked to a saved observation; no request or verification executed. The explanation is unverified.',
        'Provider, operation, environment, contract identity and learning time were retained from the source; current applicability was not reassessed.',
        `The source observation outcome was ${source.outcome}; completion was ${source.complete}. Source assertions are not assertions of this lesson.`,
        ...(!evidence.length ? ['The source observation has no saved evidence files; only its recorded metadata supports inspection.'] : []),
        ...(age > STALE_DAYS_DEFAULT ? ['The source observation is stale by the default age limit; recording this lesson did not renew it.'] : []),
        ...source.omissions.slice(0, 15),
      ] };
    scanMetadataSecrets({ identity: entry.identity, observation }, 'CONTEXT_SECRET_REFUSED');
    // Use the original entry so adding a lesson never normalizes or rewrites
    // existing observations, including metadata newer clients may understand.
    const target = ext.operations[id];
    target.observations.push(observation);
    if (target.observations.length > MAX_HISTORY) {
      target.omitted_observations += target.observations.length - MAX_HISTORY;
      target.observations = target.observations.slice(-MAX_HISTORY);
    }
    return { state: 'captured', operation_id: id, observation_id: observation.id, identity: entry.identity,
      based_on, observed_at: source.observed_at,
      source_freshness: { state: age > STALE_DAYS_DEFAULT ? 'stale' : 'unknown', ...(age >= 0 ? { age_days: age } : {}),
        meaning: 'Original observation age only; current applicability was not reassessed.' },
      evidence: { state: evidence.length ? 'matching' : 'absent', references: evidence.length, meaning: 'Artifact identity only; the authored explanation is unverified.' },
      retained_observations: target.observations.length, omitted_observations: target.omitted_observations, ...scope };
  });
}

// Explicit bindings avoid guessing which host an old method/path belonged to.
// The original entry remains untouched; its digest describes the bound snapshot.
export function migrateOperationContext(root, { bindings } = {}) {
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 2000)
    fail('CONTEXT_INPUT_INVALID', 'Provide one to 2000 explicit legacy operation bindings.');
  const normalized = bindings.map(binding => {
    if (!object(binding) || own(binding, 'legacy_operation') === own(binding, 'legacy_mcp_id'))
      fail('CONTEXT_INPUT_INVALID', 'Each binding must select exactly one legacy_operation or legacy_mcp_id.');
    return { kind: own(binding, 'legacy_operation') ? 'http-operation' : 'mcp-inspection',
      legacy: text(binding.legacy_operation ?? binding.legacy_mcp_id, 'legacy identifier'), identity: operationIdentity(binding.identity) };
  });
  return updateContext(root, ctx => {
    const ext = extension(ctx, true), ids = [];
    if (Object.keys(ext.operations).length > MAX_OPERATIONS) fail('CONTEXT_INVALID', 'The operation context exceeds its supported capacity.');
    for (const [key, value] of Object.entries(ext.operations)) storedEntry(key, value);
    for (const { kind, legacy, identity } of normalized) {
      let original, identityField;
      if (kind === 'http-operation') {
        if (!Object.hasOwn(ctx.operations, legacy)) fail('CONTEXT_LEGACY_MISSING', 'The named legacy operation is absent.');
        original = ctx.operations[legacy];
      } else {
        if (!Array.isArray(ctx.mcp_inspections)) fail('CONTEXT_LEGACY_MISSING', 'The named legacy MCP inspection is absent.');
        // Current MCP histories use their monotonic `at` timestamp as identity;
        // imported records may carry an explicit id. Neither is guessed.
        const byId = ctx.mcp_inspections.filter(record => object(record) && record.id === legacy);
        const matches = byId.length ? byId : ctx.mcp_inspections.filter(record => object(record) && record.at === legacy);
        if (matches.length !== 1) fail('CONTEXT_LEGACY_MISSING', 'legacy_mcp_id must match one exact inspection id or recorded timestamp.');
        original = matches[0]; identityField = byId.length ? 'id' : 'at';
      }
      const id = operationId(identity);
      const entry = ext.operations[id] ??= { identity, observations: [], omitted_observations: 0 };
      storedEntry(id, entry);
      const reference = { kind, key: legacy, digest: digest(JSON.stringify(original)),
        ...(identityField ? { identity_field: identityField } : {}),
        meaning: 'Explicit author binding; the original record retains its evidence and provenance.' };
      entry.legacy_bindings ??= entry.legacy ? [legacyReference(entry.legacy)] : [];
      if (!entry.legacy_bindings.some(ref => ref.kind === reference.kind && ref.key === reference.key && ref.digest === reference.digest))
        entry.legacy_bindings.push(reference);
      if (entry.legacy_bindings.length > MAX_HISTORY) {
        entry.omitted_legacy_bindings = (entry.omitted_legacy_bindings ?? 0) + entry.legacy_bindings.length - MAX_HISTORY;
        entry.legacy_bindings = entry.legacy_bindings.slice(-MAX_HISTORY);
      }
      ids.push(id);
    }
    if (Object.keys(ext.operations).length > MAX_OPERATIONS) fail('CONTEXT_CAPACITY_REACHED', 'Operation context reached its 2000-operation bound.');
    return { state: 'bound', operation_ids: ids, originals_preserved: true };
  });
}

function queryFilters(query, { maxItems, maxBytes }) {
  if (!object(query)) fail('CONTEXT_INPUT_INVALID', 'A context query must be an object.');
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100 || !Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > 1024 * 1024)
    fail('CONTEXT_INPUT_INVALID', 'Query bounds must be 1–100 operations and 512–1048576 bytes.');
  return Object.fromEntries(fields.filter(key => Object.hasOwn(query, key)).map(key => [key, query[key] === null ? null : text(query[key], key, 2048)]));
}

// Every source a query may read, read once. A caller asking many exact
// questions of the same stores (the API map asks one per operation) reuses
// this instead of re-reading and re-validating each store per question. A
// failure while loading is kept on its source and replayed at that source's
// position by queryLoadedOperationContext, so every query reports exactly the
// issues, counts and order a fresh queryOperationContext would. `snapshot`
// lets a caller that already parsed the local store pass that parse in.
export function loadOperationContextSources(root, { env = process.env, snapshot } = {}) {
  const base = realpathSync(root), { registry, problem } = loadRegistry(env);
  const sources = [{ id: 'local', root: base }];
  const consumer = Object.entries(registry.repos).find(([, repo]) => {
    try { return realpathSync(repo.root) === base; } catch { return false; }
  });
  if (consumer) sources.push(...providersFor(registry, consumer[0]));
  const loaded = [], seen = new Set(), skipped = [];
  for (const source of sources) {
    const item = { id: source.id, ...(source.id !== 'local' ? { name: typeof source.name === 'string' ? source.name : null } : {}) };
    // A granted provider whose directory is gone cannot hold a newer response
    // for any identity. It is skipped with a reason (as cross-repo lookups do),
    // not replayed as a failure that would withhold every local label.
    if (source.id !== 'local') {
      try { realpathSync(source.root); }
      catch (error) {
        if (['ENOENT', 'ENOTDIR'].includes(error?.code)) { skipped.push({ repository: source.id, name: item.name, reason: 'directory-missing' }); continue; }
      }
    }
    try {
      const real = realpathSync(source.root);
      if (seen.has(real)) continue;
      seen.add(real);
      const path = join(real, contextFileFor(real, CONTEXT_FILE));
      try { if (statSync(path).size > 16 * 1024 * 1024) fail('CONTEXT_TOO_LARGE', 'Context is oversized.'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const ctx = source.id === 'local' && snapshot !== undefined ? snapshot : loadContext(real);
      if (!ctx || ctx.v !== 0 || !object(ctx.operations)) fail('CONTEXT_INVALID', 'Context is damaged or unsupported.');
      if (source.id === 'local') item.legacy = { http_operations: Object.keys(ctx.operations).length,
        mcp_records: Array.isArray(ctx.mcp_inspections) ? ctx.mcp_inspections.length : 0 };
      Object.assign(item, { real, ctx, ...(source.id === 'local' && activeStackScopeFor(root) ? { stack: activeStackScopeFor(root).stack, stackEnvironments: activeStackScopeFor(root).document?.environments ?? {} } : {}) });
      const entries = Object.entries(extension(ctx)?.operations ?? {});
      if (entries.length > MAX_OPERATIONS) fail('CONTEXT_INVALID', 'Operation context exceeds its supported capacity.');
      // Each entry is projected once. A record whose derived key_sources fail
      // validation (lib/key-sources.mjs) keeps its observations; it is flagged
      // here and named by every query that matches it.
      item.projected = entries.map(([id, entry]) => [id, storedEntry(id, entry), projectKeySources(entry).state === 'damaged']);
      item.byId = new Map(item.projected.map(([id, entry]) => [id, entry]));
      item.hasStackIdentities = item.projected.some(([, entry]) => Object.hasOwn(entry.identity, 'stack'));
      item.keySourcesDamaged = new Set(item.projected.filter(([, , damaged]) => damaged).map(([id]) => id));
    } catch (error) { item.error = error; }
    loaded.push(item);
  }
  return { problem, sources: loaded, skipped };
}

export function queryOperationContext(root, query = {}, { env = process.env, maxItems = 20, maxBytes = 16000, includeNotes = true } = {}) {
  queryFilters(query, { maxItems, maxBytes });
  return queryLoadedOperationContext(loadOperationContextSources(root, { env }), query, { maxItems, maxBytes, includeNotes });
}

// The smallest record_issues answer: the first record named and the rest
// counted. Its bytes are reserved while records are placed, so a record that
// sits near the budget never trims the record issues out.
function recordIssuesReserve(recordIssues) {
  if (!recordIssues.length) return 0;
  return Buffer.byteLength(`,"record_issues":${JSON.stringify(recordIssues.slice(0, 1))}`)
    + (recordIssues.length > 1 ? Buffer.byteLength(`,"record_issues":${recordIssues.length - 1}`) : 0);
}

// The same record without its key_sources. Key sources are derived data
// (capture and `context keys` regenerate them), so a record that fits a bounded
// answer only without them keeps its place; the answer counts such records in
// key_sources_omitted.
function withoutKeySources(item) {
  const { key_sources: _omitted, ...rest } = item;
  return rest;
}

export function queryLoadedOperationContext(loaded, query = {}, { maxItems = 20, maxBytes = 16000, includeNotes = true } = {}) {
  const filters = queryFilters(query, { maxItems, maxBytes });
  const search = query.search === undefined ? null : text(query.search, 'search', 1000).toLowerCase();
  // Legacy identities omit the optional stack field and still permit an
  // exact lookup. A query omitting stack is a wildcard only when the source
  // has stack identities; in that case the scan preserves every matching
  // stack variant. Explicit stack queries always use the full identity key.
  let exact;
  if (requiredIdentityFields.every(key => Object.hasOwn(filters, key))) {
    try { exact = operationId(filters); } catch { exact = null; }
  }
  const result = { v: 1, meaning: 'Scoped observations and author claims; evidence identity is not proof of all API behavior.',
    operations: [], omissions: { operations: 0, evidence_checks: 0, issues: 0 }, issues: loaded.problem ? [{ code: loaded.problem.code }] : [],
    legacy: { http_operations: 0, mcp_records: 0, meaning: 'Legacy records retain original lookups and provenance, including after an explicit binding.' },
    // Named once, never as a failure: see loadOperationContextSources.
    ...(loaded.skipped?.length ? { skipped: loaded.skipped.map(item => ({ ...item })) } : {}) };
  // A record whose derived key_sources fail validation keeps its observations;
  // its links are absent and the record is named here. Kept apart from
  // `issues`, which means an unavailable source to every reader. Every
  // matching record is found first, so the room record_issues needs is known
  // before any record is placed.
  const recordIssues = [];
  const matched = loaded.sources.map(source => {
    if (source.error) return { source, candidates: [] };
    const candidates = (exact === undefined || !Object.hasOwn(filters, 'stack') && source.hasStackIdentities ? source.projected
      : exact !== null && source.byId.has(exact) ? [[exact, source.byId.get(exact), source.keySourcesDamaged.has(exact)]] : [])
      .filter(([, entry]) => Object.entries(filters).every(([key, value]) => entry.identity[key] === value))
      .filter(([, entry]) => !search || JSON.stringify(entry).toLowerCase().includes(search));
    for (const [id, , keySourcesDamaged] of candidates)
      if (keySourcesDamaged) recordIssues.push({ repository: source.id, operation_id: id, code: KEY_SOURCES_INVALID });
    return { source, candidates };
  });
  // Stack facts come only from the selected local store. They do not inherit
  // grants or acquire another provider's stack identity by proximity.
  const local = loaded.sources.find(source => source.id === 'local' && !source.error && source.stack);
  const declared = Object.entries(local?.stackEnvironments ?? {});
  const matchingStackScope = (filters.provider === undefined && filters.environment === undefined) || declared.some(([name, config]) =>
    (filters.environment === undefined || filters.environment === name) && (filters.provider === undefined || String(config.baseUrl).replace(/\/+$/, '') === String(filters.provider).replace(/\/+$/, '')));
  if (local?.ctx.stack_facts !== undefined && (filters.stack === undefined || filters.stack === local.stack) && matchingStackScope) {
    const history = inspectNoteHistory(local.ctx.stack_facts);
    const projection = stackFactsProjection(local.ctx, { operation: filters.operation, stack: local.stack, maxFacts: Infinity });
    const selected = projection.records.filter(record => !search || String(record.text).toLowerCase().includes(search));
    result.stack_facts = { key: { kind: 'stack' }, stack: local.stack, records: [], omitted: selected.length + projection.receipt.omitted,
      show_command: `${CLI_NAME} show --stack ${local.stack}`, integrity: history.state };
    for (const record of selected.slice(0, 5)) {
      try { scanMetadataSecrets(record, 'CONTEXT_SECRET_REFUSED'); }
      catch { continue; }
      result.stack_facts.records.push(record); result.stack_facts.omitted--;
    }
    if (history.state === 'invalid') result.issues.push({ repository: 'local', code: 'NOTE_HISTORY_INVALID' });
  }
  const bytes = () => Buffer.byteLength(JSON.stringify(result));
  const reserve = recordIssuesReserve(recordIssues);
  const room = () => bytes() + reserve <= maxBytes;
  while (!room() && result.stack_facts?.records.length) { result.stack_facts.records.pop(); result.stack_facts.omitted++; }
  // key_sources_omitted counts the records returned without their key_sources.
  const shedItems = new WeakSet();
  const countOmitted = delta => {
    const count = (result.key_sources_omitted ?? 0) + delta;
    if (count) result.key_sources_omitted = count; else delete result.key_sources_omitted;
  };
  const shedOne = item => { const lean = withoutKeySources(item); shedItems.add(lean); countOmitted(1); return lean; };
  // A record that does not fit the room left is projected again without its
  // key_sources; it is dropped only if it still does not fit.
  const place = item => {
    result.operations.push(item);
    if (room()) return true;
    result.operations.pop();
    if (!item.key_sources?.length) return false;
    result.operations.push(shedOne(item));
    if (room()) return true;
    result.operations.pop(); countOmitted(-1);
    return false;
  };
  for (const { source, candidates } of matched) {
    try {
      if (source.legacy) Object.assign(result.legacy, source.legacy);
      if (source.error) throw source.error;
      const { real, ctx } = source;
      for (const [id, entry] of candidates) {
        if (result.operations.length >= maxItems) { result.omissions.operations++; continue; }
        const item = structuredClone({ operation_id: id, repository: source.id, ...entry });
        // Check a bounded number of refs; never return their contents.
        let checked = 0;
        for (const observation of item.observations) for (const ref of observation.evidence ?? []) {
          if (++checked > 20) { ref.state = 'unchecked'; result.omissions.evidence_checks++; continue; }
          try { ref.state = evidenceRef(real, ref).digest === ref.digest ? 'matching' : 'changed'; }
          catch { ref.state = 'missing-or-unavailable'; }
          ref.meaning = 'artifact-identity-only';
        }
        for (const binding of [...(item.legacy ? [item.legacy] : []), ...(item.legacy_bindings ?? [])]) {
          const original = binding.kind === 'http-operation' ? ctx.operations[binding.key]
            : (Array.isArray(ctx.mcp_inspections) ? ctx.mcp_inspections : []).find(record => object(record) && record[binding.identity_field] === binding.key);
          binding.state = original === undefined ? 'missing' : digest(JSON.stringify(original)) === binding.digest ? 'matching' : 'changed';
        }
        scanMetadataSecrets(item, 'CONTEXT_SECRET_REFUSED');
        if (!place(item)) result.omissions.operations++;
      }
    } catch (error) {
      if (result.issues.length < 20) result.issues.push({ repository: source.id, code: contextCommandError(error).code });
      else result.omissions.issues++;
    }
  }
  // Diagnostics share the response budget too; a large granted fleet of
  // damaged files must not defeat the bound after operations were limited.
  // Key sources go before any record, records before source issues, and the
  // room reserved for record_issues stays reserved.
  const shed = () => {
    for (let index = result.operations.length - 1; index >= 0; index--) {
      if (!result.operations[index].key_sources?.length) continue;
      result.operations[index] = shedOne(result.operations[index]);
      return true;
    }
    return false;
  };
  while (!room() && shed());
  while (!room() && result.operations.length) {
    if (shedItems.has(result.operations.pop())) countOmitted(-1);
    result.omissions.operations++;
  }
  while (bytes() > maxBytes && result.issues.length) {
    result.issues.pop(); result.omissions.issues++;
  }
  // Record issues go last, into the space that is left: the first record named
  // and the rest counted always fit in the reserved room, more names when they
  // fit. Only when source issues or a budget too small even for that leave no
  // room are the names, and then the count, left out.
  if (recordIssues.length) {
    const fits = () => bytes() <= maxBytes;
    const count = () => {
      const rest = recordIssues.length - result.record_issues.length;
      if (rest) result.omissions.record_issues = rest; else delete result.omissions.record_issues;
    };
    result.record_issues = recordIssues.slice(0, 20);
    count();
    while (!fits() && result.record_issues.length) { result.record_issues.pop(); count(); }
    if (!result.record_issues.length) delete result.record_issues;
    if (!fits()) delete result.omissions.record_issues;
  }
  if (result.stack_facts && bytes() > maxBytes) {
    // Keep the exact recovery command and count even at the minimum budget.
    delete result.stack_facts.key; delete result.stack_facts.stack; delete result.stack_facts.integrity;
    if (bytes() > maxBytes) delete result.legacy.meaning;
    if (bytes() > maxBytes) result.meaning = 'Authored stack facts; no verification.';
  }
  // Legacy authored notes are independent of whether an observation was ever
  // captured. Add their active projection, with an explicit omission receipt,
  // without replacing the established observation or raw-history contracts.
  if (includeNotes && (filters.protocol === undefined || filters.protocol === 'http')) {
    const notes = [];
    for (const source of loaded.sources) {
      if (source.error || !source.ctx || filters.stack !== undefined && source.stack !== filters.stack) continue;
      try {
        const config = source.stack && filters.environment
          ? stackScope(source.real, { stack: source.stack, environment: filters.environment }).config
          : resolveConfig(source.real, filters.environment ? { environment: filters.environment } : {});
        if (filters.provider !== undefined && filters.provider !== config.baseUrl
          || filters.environment !== undefined && filters.environment !== (config.name ?? 'default')) continue;
        const read = loadNoteReadContext(source.real, source.ctx, { config });
        for (const [operation, entry] of Object.entries(source.ctx.operations)) {
          if (filters.operation !== undefined && filters.operation !== operation) continue;
          const options = read.forOperation(operation);
          if (filters.contractDigest !== undefined && filters.contractDigest !== options.scope.contract_digest) continue;
          // A legacy note has no endpoint identity of its own; do not invent a
          // binding from a URL supplied by the query.
          if (filters.endpoint !== undefined && !source.projected.some(([, value]) => value.identity.operation === operation
            && Object.entries(filters).every(([key, value2]) => value.identity[key] === value2))) continue;
          const history = inspectNoteHistory(entry, operation);
          for (const record of history.active) {
            if (search && !String(record.text).toLowerCase().includes(search)) continue;
            const item = { repository: source.id, ...(source.stack ? { stack: source.stack } : {}), operation,
              ...compactNoteRecord(decorateNoteRecord(record, { entry, history, ...options })) };
            try { scanMetadataSecrets(item, 'CONTEXT_SECRET_REFUSED'); notes.push(item); }
            catch { result.omissions.notes = (result.omissions.notes ?? 0) + 1; }
          }
        }
      } catch { result.issues.push({ repository: source.id, code: 'NOTE_CONTEXT_UNAVAILABLE' }); }
    }
    if (notes.length) {
      result.note_context = { meaning: NOTE_DATA_MEANING, records: [], omitted: notes.length };
      for (const item of notes) {
        if (result.note_context.records.length >= maxItems) break;
        result.note_context.records.push(item); result.note_context.omitted--;
        if (bytes() > maxBytes) { result.note_context.records.pop(); result.note_context.omitted++; }
      }
      if (bytes() > maxBytes) {
        delete result.note_context;
        result.omissions.notes = (result.omissions.notes ?? 0) + notes.length;
      }
    }
    while (bytes() > maxBytes && result.issues.length) { result.issues.pop(); result.omissions.issues++; }
    if (bytes() > maxBytes) delete result.legacy.meaning;
  }
  return result;
}
