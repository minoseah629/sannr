// One portable, bounded model for explicitly generated API surveys. This module
// has no repository I/O: validating, querying and rendering cannot scan source.
import { createHash } from 'node:crypto';
import { secretIn } from './verdicts.mjs';
import { emailShaped } from './promote.mjs';
import { validField, recordableName } from './key-sources.mjs';

export const SURVEY_VERSION = 1;
export const SURVEY_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, nodes: 10000, relationships: 20000,
  unresolved: 10000, supports: 1000, queryBytes: 65536 });
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const sha = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const fail = (code = 'SURVEY_INVALID', message = 'The survey is malformed or contains unsupported metadata; it was not rewritten.') => {
  throw Object.assign(new Error(message), { code });
};
const control = /[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u;
const workstation = /(?:\b[fF][iI][lL][eE]:[/\\]|(?:^|[\s"'`(=:/])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/))/u;

/** Null means withheld, never a sanitized fragment that could retain a secret. */
export function safeSurveyText(value, { max = 1024, path = false, url = false, route = false, host = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > max) return null;
  let decoded = value;
  for (let round = 0; round < 8; round++) {
    if (control.test(decoded) || workstation.test(decoded) || emailShaped(decoded)
      || secretIn(decoded, { allowAuthReferences: true })) return null;
    // Free-form labels/attribution are not a loophole around typed URL fields.
    // Drop the whole field, including ordinary (non-token-shaped) query values.
    for (const match of decoded.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
      try {
        const parsed = new URL(match[0]);
        if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      } catch { return null; }
    }
    if (path && (decoded.startsWith('/') || /[\\?#]/u.test(decoded) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(decoded)
      || !decoded.split('/').every(part => part && part !== '.' && part !== '..'))) return null;
    if (route && (!decoded.startsWith('/') || /[\s\\?#]/u.test(decoded))) return null;
    if (host && /[\s/\\?#@]/u.test(decoded)) return null;
    if (url) {
      try {
        const parsed = new URL(decoded);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      } catch { return null; }
    }
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; if (round === 7) return null; }
    catch { break; }
  }
  return value;
}
const text = (value, options) => { if (safeSurveyText(value, options) === null) fail('SURVEY_UNSAFE_METADATA', 'Unsafe survey metadata was withheld; raw values and workstation paths are not portable.'); };
const number = value => { if (!Number.isSafeInteger(value) || value < 0) fail(); };
const digest = value => { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) fail(); };
const date = value => { text(value); if (!/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) fail(); };
const operation = value => { text(value); if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^\s?#]*$/u.test(value)) fail(); text(value.slice(value.indexOf(' ') + 1), { route: true }); };
const route = value => text(value, { route: true });
function keys(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function bounded(value, max) { if (!Array.isArray(value) || value.length > max) fail('SURVEY_BOUNDS', 'The survey exceeds supported bounds.'); return value; }
function strings(values, max = 128) { for (const value of bounded(values, max)) text(value); }
function counters(values) { if (!object(values)) fail(); for (const [key, value] of Object.entries(values)) { text(key, { max: 128 }); number(value); } }
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (object(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
  return value;
}
export const surveyStructuralDigest = value => sha(JSON.stringify(sorted(value)));
export const surveyId = (kind, tuple) => `${kind}:${createHash('sha256').update(JSON.stringify(sorted(tuple))).digest('hex').slice(0, 32)}`;
const ordered = values => [...values].sort((a, b) => {
  const left = JSON.stringify(sorted(a)), right = JSON.stringify(sorted(b));
  return left < right ? -1 : left > right ? 1 : 0;
});

function reference(value) {
  keys(value, ['file', 'line', 'kind', 'state', 'code_path', 'contract_path', 'environment', 'environments']);
  if (own(value, 'file')) text(value.file, { path: true });
  if (own(value, 'line')) { number(value.line); if (!value.line) fail(); }
  for (const key of ['kind', 'state', 'environment']) if (own(value, key)) text(value[key]);
  for (const key of ['code_path', 'contract_path']) if (own(value, key)) route(value[key]);
  if (own(value, 'environments')) strings(value.environments);
}
function support(value) {
  keys(value, ['kind', 'file', 'line', 'code_path', 'contract_path', 'environment', 'environments', 'state',
    'step', 'consumer_step', 'capture', 'record_id', 'first_observed_at', 'last_observed_at', 'also_seen',
    'evidence', 'proof', 'author', 'at', 'reason', 'source', 'consumer', 'inference']);
  for (const [key, item] of Object.entries(value)) {
    if (key === 'file') text(item, { path: true });
    else if (['code_path', 'contract_path'].includes(key)) route(item);
    else if (['line', 'also_seen'].includes(key)) number(item);
    else if (key === 'environments') strings(item);
    else if (key === 'evidence') { keys(item, ['run_id', 'file']); if (item.run_id) text(item.run_id); if (item.file) text(item.file, { path: true }); }
    else if (key === 'proof') { keys(item, ['state', 'reason', 'meaning']); text(item.state); if (item.reason) text(item.reason); if (item.meaning) text(item.meaning); }
    else if (['source', 'consumer'].includes(key) && object(item)) {
      keys(item, ['phase', 'step']); text(item.phase); number(item.step);
    }
    else if (key === 'at' && /^\d{4}-\d{2}-\d{2}$/u.test(item) && Number.isFinite(Date.parse(item))) text(item);
    else if (['first_observed_at', 'last_observed_at', 'at'].includes(key)) date(item);
    else if (['step', 'consumer_step'].includes(key) && typeof item === 'number') number(item);
    else text(item);
  }
  text(value.kind);
}
function unresolved(value) {
  keys(value, ['kind', 'reason', 'count', 'file', 'line', 'stack', 'operation', 'host', 'path', 'state', 'extent']);
  for (const [key, item] of Object.entries(value)) {
    if (['count', 'line'].includes(key)) number(item);
    else if (key === 'path') route(item);
    else if (key === 'operation') operation(item);
    else if (key === 'host') text(item, { host: true });
    else text(item, key === 'file' ? { path: true } : undefined);
  }
  text(value.reason);
}

/** Strict boundary used by artifact reads and every renderer, not a repairer. */
export function validateSurvey(value, { identity = true } = {}) {
  try {
    if (!object(value) || value.v !== SURVEY_VERSION || value.kind !== 'api-survey')
      fail('SURVEY_VERSION_UNSUPPORTED', 'The survey format/version is unsupported; regenerate explicitly with a compatible CLI.');
    // Check depth/shape before serializing untrusted input or walking records.
    let count = 0; const seen = new Set();
    const check = (item, depth = 0) => {
      if (++count > 300000 || depth > 16) fail('SURVEY_BOUNDS');
      if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) return;
      if ((!object(item) && !Array.isArray(item)) || seen.has(item)) fail();
      seen.add(item); for (const child of Object.values(item)) check(child, depth + 1); seen.delete(item);
    };
    check(value);
    if (Buffer.byteLength(JSON.stringify(value)) > SURVEY_LIMITS.bytes) fail('SURVEY_BOUNDS');
    keys(value, ['v', 'kind', 'snapshot', 'scanner', 'source', 'coverage', 'nodes', 'relationships', 'unresolved']);
    keys(value.snapshot, ['id', 'built_at']); digest(value.snapshot.id); date(value.snapshot.built_at);
    keys(value.scanner, ['name', 'version', 'identity', 'config_identity', 'limits', 'config']);
    text(value.scanner.name); number(value.scanner.version); digest(value.scanner.identity); digest(value.scanner.config_identity);
    counters(value.scanner.limits);
    keys(value.scanner.config, ['include_fixtures', 'exclude_env', 'excluded_files']);
    for (const key of ['include_fixtures', 'exclude_env']) if (typeof value.scanner.config[key] !== 'boolean') fail();
    strings(value.scanner.config.excluded_files, 1000);
    keys(value.source, ['base_commit', 'git_state', 'structural_identity', 'configuration_identity', 'observation_identity', 'dirty', 'inventory', 'limitations']);
    if (value.source.base_commit !== null && !/^[a-f0-9]{40,64}$/u.test(value.source.base_commit)) fail();
    if (!['available', 'unavailable'].includes(value.source.git_state)) fail();
    for (const key of ['structural_identity', 'configuration_identity', 'observation_identity']) digest(value.source[key]);
    keys(value.source.dirty, ['tracked', 'untracked', 'eligible_untracked']); counters(value.source.dirty);
    for (const entry of bounded(value.source.inventory, 30000)) {
      keys(entry, ['file', 'kind', 'state']); text(entry.file, { path: true }); text(entry.kind); text(entry.state);
    }
    strings(value.source.limitations);
    keys(value.coverage, ['supported_relationships', 'supported_patterns', 'languages', 'eligible_files', 'scanned_files', 'skipped_files',
      'unreadable_files', 'oversized_files', 'truncated', 'omissions', 'unresolved_by_reason', 'withheld', 'flow', 'limitations']);
    for (const key of ['supported_relationships', 'supported_patterns', 'languages', 'limitations']) strings(value.coverage[key]);
    for (const key of ['eligible_files', 'scanned_files', 'skipped_files', 'unreadable_files', 'oversized_files']) number(value.coverage[key]);
    if (typeof value.coverage.truncated !== 'boolean') fail();
    for (const item of bounded(value.coverage.omissions, 10000)) unresolved(item);
    for (const key of ['unresolved_by_reason', 'withheld', 'flow']) counters(value.coverage[key]);
    const ids = new Set();
    for (const node of bounded(value.nodes, SURVEY_LIMITS.nodes)) {
      keys(node, ['id', 'kind', 'label', 'stack', 'operation', 'file', 'host', 'contract', 'state', 'references', 'environments']);
      if (!['file', 'operation', 'host', 'contract'].includes(node.kind) || ids.has(node.id)) fail();
      text(node.id); ids.add(node.id); text(node.label);
      for (const key of ['stack', 'operation', 'host', 'state']) if (own(node, key)) text(node[key]);
      if (node.kind === 'operation') { operation(node.operation); text(node.stack); }
      if (node.kind === 'file') text(node.file, { path: true });
      if (node.kind === 'contract') text(node.contract, { path: true });
      if (node.kind === 'host') text(node.host, { host: true });
      for (const key of ['file', 'contract']) if (own(node, key)) text(node[key], { path: true });
      if (own(node, 'references')) for (const ref of bounded(node.references, SURVEY_LIMITS.supports)) reference(ref);
      if (own(node, 'environments')) strings(node.environments);
    }
    const edges = new Set();
    const nodeKinds = new Map(value.nodes.map(node => [node.id, node.kind]));
    for (const edge of bounded(value.relationships, SURVEY_LIMITS.relationships)) {
      keys(edge, ['id', 'kind', 'from', 'to', 'source_field', 'target_parameter', 'scope', 'declarations', 'observations', 'operator_attributions']);
      if (!['defines', 'calls', 'supplies'].includes(edge.kind) || edges.has(edge.id) || !ids.has(edge.from) || !ids.has(edge.to)) fail();
      text(edge.id); edges.add(edge.id);
      const from = nodeKinds.get(edge.from), to = nodeKinds.get(edge.to);
      if (edge.kind === 'defines' && (from !== 'file' || to !== 'operation')
        || edge.kind === 'calls' && (from !== 'file' || !['operation', 'host'].includes(to))
        || edge.kind === 'supplies' && (from !== 'operation' || to !== 'operation'
          || !validField(edge.source_field) || !recordableName(edge.target_parameter?.name))) fail();
      if (own(edge, 'source_field')) text(edge.source_field);
      if (own(edge, 'target_parameter')) {
        keys(edge.target_parameter, ['location', 'name']); text(edge.target_parameter.name);
        if (!['path', 'query'].includes(edge.target_parameter.location)) fail();
      }
      if (own(edge, 'scope')) { keys(edge.scope, ['source_stack', 'target_stack', 'environment', 'source_environment', 'target_environment']); for (const item of Object.values(edge.scope)) text(item); }
      for (const key of ['declarations', 'observations', 'operator_attributions']) for (const item of bounded(edge[key], SURVEY_LIMITS.supports)) support(item);
      if (![...edge.declarations, ...edge.observations, ...edge.operator_attributions].length) fail();
    }
    for (const item of bounded(value.unresolved, SURVEY_LIMITS.unresolved)) unresolved(item);
    if (identity && value.snapshot.id !== snapshotIdentity(value)) fail('SURVEY_IDENTITY_MISMATCH', 'The survey content does not match its snapshot identity; it was not rewritten.');
    return value;
  } catch (error) {
    if (/^SURVEY_/.test(error?.code ?? '')) throw error;
    fail();
  }
}

export function canonicalSurveyJson(snapshot) {
  validateSurvey(snapshot);
  return canonicalBytes(snapshot);
}
function canonicalBytes(snapshot) {
  const copy = structuredClone(snapshot);
  copy.nodes = ordered(copy.nodes.map(node => ({ ...node, ...(node.references ? { references: ordered(node.references) } : {}) })));
  copy.relationships = ordered(copy.relationships.map(edge => ({ ...edge,
    ...Object.fromEntries(['declarations', 'observations', 'operator_attributions'].map(key => [key, ordered(edge[key])])) })));
  copy.unresolved = ordered(copy.unresolved);
  copy.source.inventory = ordered(copy.source.inventory);
  copy.coverage.omissions = ordered(copy.coverage.omissions);
  return JSON.stringify(sorted(copy), null, 2) + '\n';
}
function snapshotIdentity(snapshot) {
  const copy = { ...snapshot, snapshot: { ...snapshot.snapshot, id: surveyStructuralDigest([]) } };
  return sha(canonicalBytes(copy));
}

export function createSurveySnapshot({ nodes = [], relationships = [], unresolved = [], coverage = {}, source = {}, scanner = {} } = {}, { now = new Date().toISOString() } = {}) {
  const empty = surveyStructuralDigest([]);
  const model = { v: SURVEY_VERSION, kind: 'api-survey', snapshot: { id: empty, built_at: new Date(now).toISOString() },
    scanner: { name: 'code-1', version: 1, identity: empty, config_identity: empty, limits: { max_file_bytes: 400000, max_depth: 7 },
      config: { include_fixtures: false, exclude_env: false, excluded_files: [] }, ...scanner },
    source: { base_commit: null, git_state: 'unavailable', structural_identity: empty, configuration_identity: empty, observation_identity: empty,
      dirty: { tracked: 0, untracked: 0, eligible_untracked: 0 }, inventory: [], limitations: [], ...source },
    coverage: { supported_relationships: ['defines', 'calls', 'supplies'], supported_patterns: [], languages: [], eligible_files: 0, scanned_files: 0,
      skipped_files: 0, unreadable_files: 0, oversized_files: 0, truncated: false, omissions: [], unresolved_by_reason: {}, withheld: {}, flow: {},
      limitations: ['Detected candidates are not a complete API inventory; unrecognized patterns cannot be enumerated.'], ...coverage },
    nodes, relationships, unresolved };
  // Node/edge identities are structural. Snapshot identity also distinguishes
  // the dated capture; raw input hashes must never be supplied here.
  validateSurvey(model, { identity: false });
  model.snapshot.id = snapshotIdentity(model);
  return JSON.parse(canonicalSurveyJson(model));
}

/** Bounded snapshot-only query. No status check, regeneration or live lookup. */
export function querySurveySnapshot(snapshot, { stack, operation, maxBytes = 8192, status } = {}) {
  validateSurvey(snapshot);
  if (!Number.isInteger(maxBytes) || maxBytes < 512 || maxBytes > SURVEY_LIMITS.queryBytes)
    fail('SURVEY_QUERY_BOUNDS', 'Use a survey query budget from 512 to 65536 bytes.');
  const selected = snapshot.nodes.filter(node => node.kind === 'operation' && (stack === undefined || node.stack === stack)
    && (operation === undefined || node.operation === operation));
  const wanted = new Set(selected.map(node => node.id));
  const relationships = snapshot.relationships.filter(edge => wanted.has(edge.from) || wanted.has(edge.to));
  const ids = new Set([...wanted, ...relationships.flatMap(edge => [edge.from, edge.to])]);
  const nodes = snapshot.nodes.filter(node => ids.has(node.id));
  const result = { state: 'ready', snapshot: snapshot.snapshot,
    current_inputs: surveyStatusSummary(status, snapshot.snapshot.id),
    provenance: 'Snapshot declarations, retained observations and operator attributions stay separate; this query executes no API.',
    nodes: [], relationships: [], omitted: { nodes: nodes.length, relationships: relationships.length } };
  const fits = () => Buffer.byteLength(JSON.stringify(result)) <= maxBytes;
  for (const node of nodes) { result.nodes.push(node); result.omitted.nodes--; if (!fits()) { result.nodes.pop(); result.omitted.nodes++; } }
  const included = new Set(result.nodes.map(node => node.id));
  for (const edge of relationships) {
    if (!included.has(edge.from) || !included.has(edge.to)) continue;
    result.relationships.push(edge); result.omitted.relationships--;
    if (!fits()) { result.relationships.pop(); result.omitted.relationships++; }
  }
  if (!fits()) { delete result.provenance; }
  if (!fits()) fail('SURVEY_QUERY_BOUNDS');
  return result;
}

const STATUS_STATES = new Set(['current', 'changed', 'stale', 'unknown', 'unavailable', 'available', 'matching',
  'not-checked', 'unchanged', 'missing', 'not-generated', 'invalid', 'checked', 'structurally-unchanged']);
/** Private receipt text is not trusted as portable metadata. */
export function surveyStatusSummary(status, snapshotId) {
  if (!object(status) || status.snapshot_id !== snapshotId || !STATUS_STATES.has(status.state)) return { state: 'not-checked' };
  try { date(status.checked_at); } catch { return { state: 'not-checked' }; }
  return { state: status.state, checked_at: status.checked_at,
    ...Object.fromEntries(['source', 'observations', 'base_commit'].filter(key => STATUS_STATES.has(status[key]?.state))
      .map(key => [key, { state: status[key].state }])) };
}
