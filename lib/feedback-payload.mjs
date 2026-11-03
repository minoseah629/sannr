// A closed projection is the privacy boundary. Report inputs can come from
// edited local files: never spread metadata, names, targets, paths or notes.
// This module has no I/O or network capability. Explicit prose remains data.
import { FEEDBACK_ORIGIN, PROJECT_DIR_NAME } from './brand.mjs';
import feedbackSchema from './feedback.schema.json' with { type: 'json' };
import { scanMetadataSecrets, secretIn } from './verdicts.mjs';

export const FEEDBACK_MAX_BYTES = 32 * 1024;
export const FEEDBACK_MAX_TEXT = 4000;
export const FEEDBACK_HOST_AGENTS = Object.freeze(['claude-code', 'codex', 'other']);
const PLATFORMS = ['darwin', 'linux', 'win32', 'aix', 'freebsd', 'openbsd', 'sunos', 'android', 'other'];
const FINDING_KINDS = ['shadow-route', 'deprecated-but-live', 'status-mismatch', 'schema-mismatch', 'required-param-optional', 'request-field-now-required', 'required-field-drift', 'shape-drift', 'page-size-change', 'inconsistency', 'platform-inconsistency', 'redirect', 'erroring', 'missing', 'other'];
const DRIFT_KINDS = ['redirect', 'status-mismatch', 'schema-mismatch', 'shape-drift', 'undeclared-path', 'undeclared-method', 'undeclared-status', 'missing-required-field', 'unexpected-field', 'type-mismatch', 'enum-mismatch', 'other'];
const ANSWERS = ['cry_wolf', 'new_to_you', 'first_ten_minutes'];
const OPTIONAL_ANSWERS = ['wanted_and_could_not', 'also'];
const closed = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
const savedCounts = ['calls', 'calls_where_the_envelope_cost_more', 'gotchas_reused', 'gotchas_delivered_through_grants', 'drift_calls', 'friction_captured'];
const foundCounts = ['request_attempts', 'services', 'documented_operations', 'undocumented_routes', 'edges', 'external_dependencies'];
const accumulatedCounts = ['operations_known', 'verified_by_execution', 'gotchas_written', 'verdicts_recorded', 'friction_prompts_fired'];
const deepFreeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };

/** Exact server-owned schema, audited against the Worker on October 7, 2026.
 * Projection remains narrower: stored metadata never becomes arbitrary fields. */
export const FEEDBACK_SCHEMA = deepFreeze(feedbackSchema);

function refusal(code, field) {
  const message = code === 'FEEDBACK_BODY_TOO_LARGE' ? 'The feedback body exceeds the 32 KiB limit; nothing was sent.'
    : code === 'FEEDBACK_SECRET_REFUSED' ? 'Feedback contains credential-shaped text; nothing was sent.'
    : code === 'FEEDBACK_PRIVATE_DATA_REFUSED' ? 'Feedback contains private identifiers, paths or unsupported URLs; nothing was sent.'
    : code === 'FEEDBACK_RESPONSE_INVALID' ? 'The feedback response did not match the shipped contract; its body was withheld.'
    : 'Feedback does not match the shipped payload schema; nothing was sent.';
  throw Object.assign(new Error(message), { code, ...(field ? { field } : {}) });
}
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const counts = (value, names) => Object.fromEntries(names.map(name => [name, count(value?.[name])]));
const normalText = value => {
  if (typeof value !== 'string') refusal('FEEDBACK_PAYLOAD_INVALID');
  // Cf controls include invisible direction overrides/isolates. Newline and
  // tab are the only retained Cc characters. NFC does not turn prose into code.
  return value.normalize('NFC').replace(/[\p{Cf}\p{Cc}]/gu, char => char === '\n' || char === '\t' ? char : '');
};
function tally(value, keys) {
  const output = {};
  for (const [key, amount] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
    const n = count(amount); if (!n) continue;
    const target = keys.includes(key) ? key : keys.includes('other') ? 'other' : '?xx';
    output[target] = Math.min(Number.MAX_SAFE_INTEGER, (output[target] ?? 0) + n);
  }
  return output;
}

/** Project the existing local report. Anonymization is unconditional, even if
 * buildFeedback was invoked without --anonymize or its metadata was edited. */
export function buildFeedbackPayload(model, { agentNote = '', score, hostAgent = 'other', answers = {}, version, forbiddenNames = [] } = {}) {
  const found = model?.what_it_found, saved = model?.what_it_saved, usage = model?.usage;
  const serviceCount = count(found?.services), named = Math.min(serviceCount, 256);
  const platform = PLATFORMS.includes(process.platform) ? process.platform : 'other';
  const wired = Array.isArray(model?.environment?.host_agents_wired) ? model.environment.host_agents_wired : [];
  if (!answers || typeof answers !== 'object' || Array.isArray(answers) || Object.keys(answers).some(key => ![...ANSWERS, ...OPTIONAL_ANSWERS].includes(key))) refusal('FEEDBACK_PAYLOAD_INVALID', 'questions');
  const payload = {
    report: {
      anonymized: true,
      environment: { platform, node: process.version, host_agents_wired: FEEDBACK_HOST_AGENTS.filter(name => wired.includes(name)) },
      what_it_found: {
        executed_against_a_running_server: found?.executed_against_a_running_server === true,
        request_execution_requested: found?.request_execution_requested === true,
        ...counts(found, foundCounts),
        findings_by_kind: tally(found?.findings_by_kind, FINDING_KINDS),
        findings_by_severity: counts(found?.findings_by_severity, ['high', 'medium', 'low']),
        service_names: Array.from({ length: named }, (_, i) => `svc-${i + 1}`),
      },
      did_anything_accumulate: counts(model?.did_anything_accumulate, accumulatedCounts),
      what_it_saved: saved ? { ...counts(saved, savedCounts), ...(Number.isSafeInteger(saved.tokens_saved) && saved.tokens_saved >= 0 ? { tokens_saved: saved.tokens_saved } : {}), drift_kinds: tally(saved.drift_kinds, DRIFT_KINDS) } : null,
      usage: { calls: count(usage?.calls), status_classes: tally(usage?.status_classes, ['1xx', '2xx', '3xx', '4xx', '5xx', '?xx']),
        ...(Number.isSafeInteger(usage?.machine_wide_calls) && usage.machine_wide_calls >= 0 ? { machine_wide_calls: usage.machine_wide_calls } : {}),
      },
      questions: Object.fromEntries([...ANSWERS, ...OPTIONAL_ANSWERS.filter(name => Object.hasOwn(answers, name))].map(name => [name, normalText(answers[name] ?? '')])),
    },
    agent_note: normalText(agentNote), ...(score !== undefined ? { score } : {}),
    product: { version, node: process.version, platform, host_agent: hostAgent },
  };
  validateFeedbackPayload(payload, { forbiddenNames });
  return payload;
}

function resolveSchema(schema, root) {
  if (!schema.$ref) return schema;
  if (!schema.$ref.startsWith('#/$defs/')) return false;
  const target = root.$defs?.[schema.$ref.slice('#/$defs/'.length)];
  return target ? { ...target, ...Object.fromEntries(Object.entries(schema).filter(([key]) => key !== '$ref')) } : false;
}

// Implements only the shipped document's JSON Schema subset. Unknown payload
// keys are rejected before privacy scanning and never become error messages.
function matches(value, input, depth = 0, root = input) {
  if (depth > 12) return false;
  const schema = resolveSchema(input, root); if (!schema) return false;
  if (schema.anyOf) return schema.anyOf.some(option => matches(value, option, depth + 1, root));
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isSafeInteger(value) ? 'integer' : typeof value;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).includes(actual)) return false;
  if (actual === 'integer' || actual === 'number') return Number.isFinite(value)
    && (schema.minimum === undefined || value >= schema.minimum) && (schema.maximum === undefined || value <= schema.maximum);
  if (actual === 'string') return (schema.minLength === undefined || [...value].length >= schema.minLength)
    && (schema.maxLength === undefined || [...value].length <= schema.maxLength) && (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  if (actual === 'array') return (schema.maxItems === undefined || value.length <= schema.maxItems)
    && (!schema.uniqueItems || new Set(value).size === value.length)
    && (!schema.items || value.every(item => matches(item, schema.items, depth + 1, root)));
  if (actual === 'object') return (schema.maxProperties === undefined || Object.keys(value).length <= schema.maxProperties)
    && (schema.required ?? []).every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => (!schema.propertyNames || matches(key, schema.propertyNames, depth + 1, root))
      && (Object.hasOwn(schema.properties ?? {}, key) ? matches(value[key], schema.properties[key], depth + 1, root)
        : schema.additionalProperties === false ? false
          : typeof schema.additionalProperties === 'object' ? matches(value[key], schema.additionalProperties, depth + 1, root) : true));
  return actual === 'boolean' || actual === 'null';
}

function scanPrivateText(text, forbiddenNames) {
  if (text !== normalText(text)) refusal('FEEDBACK_PAYLOAD_INVALID');
  let decoded = text;
  try { decoded = decodeURIComponent(text); } catch { /* malformed escapes remain literal */ }
  const wholeReference = /^(?:(?:bearer|basic):|(?:header|query):[^:\s]+:)[A-Z_][A-Z0-9_]*$/.test(decoded);
  try { scanMetadataSecrets(decoded, 'FEEDBACK_SECRET_REFUSED'); } catch {
    // The product guard's basic reference grammar is narrower than this API's.
    // Only the exact schema-owned whole-string form can exempt inline syntax;
    // every other credential pattern (including all emails) still refuses.
    if (!wholeReference || secretIn(decoded) !== 'an inline credential') refusal('FEEDBACK_SECRET_REFUSED');
  }
  if (!wholeReference && (secretIn(decoded) || /\b(?:bearer|basic|header|query):/i.test(decoded))) refusal('FEEDBACK_SECRET_REFUSED');
  const privateFolder = PROJECT_DIR_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`${privateFolder}[\\\\/]`, 'i').test(decoded)
    || /\brun-[a-z0-9][a-z0-9-]{3,}\b/i.test(decoded)
    || /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i.test(decoded)
    || /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/.test(decoded)
    || /["'](?:api_context|notes_provenance|notes_superseded|contract_digest|shape_hash)["']\s*:/i.test(decoded)) refusal('FEEDBACK_PRIVATE_DATA_REFUSED');
  let remainder = text;
  // Scheme URLs are parsed individually; only the pinned first-party origin
  // is permitted. Protocol-relative URLs are caught by the absolute-path rule.
  for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi)) {
    let url; try { url = new URL(match[0]); } catch { refusal('FEEDBACK_PRIVATE_DATA_REFUSED'); }
    if (url.origin !== FEEDBACK_ORIGIN || url.username || url.password || /:\d+$/.test(match[0].match(/^[^:]+:\/\/([^/?#]+)/)?.[1] ?? '')) refusal('FEEDBACK_PRIVATE_DATA_REFUSED');
    for (const value of url.searchParams.values()) scanPrivateText(value, forbiddenNames);
    if (url.hash) scanPrivateText(url.hash.slice(1), forbiddenNames);
    remainder = remainder.replace(match[0], '');
  }
  if (/(?:^|[\s(\[{'"`=:>])(?:\/[A-Za-z0-9_.~/-]|~\/|[A-Za-z]:[\\/]|\\\\)/m.test(remainder)
    || /\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(remainder)
    || /\[[0-9a-f]*:[0-9a-f:]+\]/i.test(remainder)) refusal('FEEDBACK_PRIVATE_DATA_REFUSED');
  for (const match of remainder.matchAll(/\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\b/gi))
    if (match[0].toLowerCase() !== new URL(FEEDBACK_ORIGIN).hostname) refusal('FEEDBACK_PRIVATE_DATA_REFUSED');
  for (const name of forbiddenNames) if (typeof name === 'string' && name && decoded.toLocaleLowerCase('en-US').includes(name.normalize('NFC').toLocaleLowerCase('en-US'))) refusal('FEEDBACK_PRIVATE_DATA_REFUSED');
}

/** Schema and privacy checks also cover raw MCP payloads, including keys. */
export function validateFeedbackPayload(payload, { forbiddenNames = [] } = {}) {
  if (!matches(payload, FEEDBACK_SCHEMA)) refusal('FEEDBACK_PAYLOAD_INVALID');
  const pending = [{ value: payload, schema: FEEDBACK_SCHEMA, path: '' }]; let nodes = 0;
  while (pending.length) {
    if (++nodes > 4096) refusal('FEEDBACK_PAYLOAD_INVALID');
    const { value, schema: input, path } = pending.pop();
    const schema = resolveSchema(input, FEEDBACK_SCHEMA);
    if (typeof value === 'string') {
      // Protocol constants cannot identify a repo. Dynamic text and map keys
      // still use the caller's private-name list; all strings retain every
      // credential, path, hostname and evidence scan regardless of origin.
      const fixed = schema.enum?.includes(value) || schema.const === value
        || ['product.platform', 'report.environment.platform'].includes(path) && PLATFORMS.includes(value)
        || path === 'report.environment.host_agents_wired[]' && FEEDBACK_HOST_AGENTS.includes(value)
        || path === 'report.what_it_found.service_names[]' && /^svc-[0-9]{1,5}$/.test(value);
      scanPrivateText(value, fixed ? [] : forbiddenNames);
    } else if (Array.isArray(value)) for (const child of value) pending.push({ value: child, schema: schema.items, path: `${path}[]` });
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      const named = Object.hasOwn(schema.properties ?? {}, key);
      scanPrivateText(key, named ? [] : forbiddenNames);
      pending.push({ value: child, schema: named ? schema.properties[key] : schema.additionalProperties, path: path ? `${path}.${key}` : key });
    }
  }
  const bytes = Buffer.from(JSON.stringify(payload));
  if (bytes.byteLength > FEEDBACK_MAX_BYTES) refusal('FEEDBACK_BODY_TOO_LARGE');
  return payload;
}

/** Normalize a bounded clone before validating, persisting or sending it. Keys
 * normalize too; collisions refuse instead of silently dropping a property. */
export function encodeFeedbackPayload(payload, options = {}) {
  let nodes = 0;
  function normalize(value, depth = 0) {
    if (++nodes > 4096 || depth > 12) refusal('FEEDBACK_PAYLOAD_INVALID');
    if (typeof value === 'string') return normalText(value);
    if (Array.isArray(value)) return value.map(child => normalize(child, depth + 1));
    if (value && typeof value === 'object') {
      const entries = Object.entries(value).map(([key, child]) => [normalText(key), normalize(child, depth + 1)]);
      if (new Set(entries.map(([key]) => key)).size !== entries.length) refusal('FEEDBACK_PAYLOAD_INVALID');
      return Object.fromEntries(entries);
    }
    return value;
  }
  const normalized = normalize(payload);
  validateFeedbackPayload(normalized, options);
  return { payload: normalized, bytes: Buffer.from(JSON.stringify(normalized)) };
}

export const FEEDBACK_ACCEPTED_SCHEMA = deepFreeze(closed({
  id: { type: 'string', maxLength: 26, pattern: '^[0-7][0-9A-HJKMNP-TV-Z]{25}$' },
  received_at: { type: 'string', maxLength: 24, pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' },
}));
export const FEEDBACK_RATE_LIMIT_SCHEMA = deepFreeze(closed({ error: { const: 'rate_limited' }, retry_after: { type: 'integer', minimum: 1, maximum: 2147483647 } }));
const FIELD_NAMES = new Set(['body', '[key]', 'content-type']);
function collectFields(input, path = '') {
  const schema = resolveSchema(input, FEEDBACK_SCHEMA);
  if (!schema) return;
  if (path) FIELD_NAMES.add(path);
  if (schema.type === 'object' || schema.type?.includes?.('object')) {
    FIELD_NAMES.add(`${path}[key]`);
    for (const [key, value] of Object.entries(schema.properties ?? {})) collectFields(value, path ? `${path}.${key}` : key);
  }
  if (schema.items) for (let i = 0; i < schema.maxItems; i++) collectFields(schema.items, `${path}[${i}]`);
}
collectFields(FEEDBACK_SCHEMA);
export const FEEDBACK_REJECTED_SCHEMA = deepFreeze(closed({ error: { type: 'string', enum: ['invalid', 'forbidden_content'] }, field: { type: 'string', enum: [...FIELD_NAMES].sort() } }));

/** Responses carry no agent instructions. Even an error body is never returned
 * until the entire object matches a locally shipped fixed shape. */
export function validateFeedbackResponse(status, body) {
  if (status === 503 && (body === '' || body === undefined || Buffer.isBuffer(body) && body.length === 0)) return null;
  let value = body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (Buffer.byteLength(body) > 1024) refusal('FEEDBACK_RESPONSE_INVALID');
    try { value = JSON.parse(body.toString()); } catch { refusal('FEEDBACK_RESPONSE_INVALID'); }
  }
  const schema = status === 202 ? FEEDBACK_ACCEPTED_SCHEMA : status === 429 ? FEEDBACK_RATE_LIMIT_SCHEMA : status === 400 ? FEEDBACK_REJECTED_SCHEMA : null;
  if (!schema || !matches(value, schema)) refusal('FEEDBACK_RESPONSE_INVALID');
  if (status === 202) {
    const date = new Date(value.received_at);
    if (!Number.isFinite(date.getTime()) || date.toISOString().replace('.000Z', 'Z') !== value.received_at.replace('.000Z', 'Z')) refusal('FEEDBACK_RESPONSE_INVALID');
  }
  return { ...value };
}

/** A manual schema read may return the shipped schema, never new instructions
 * hidden in annotations. This helper does not fetch or trust remote schemas. */
export function validateFeedbackSchemaResponse(body) {
  let value = body;
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    if (Buffer.byteLength(body) > FEEDBACK_MAX_BYTES) refusal('FEEDBACK_RESPONSE_INVALID');
    try { value = JSON.parse(body.toString()); } catch { refusal('FEEDBACK_RESPONSE_INVALID'); }
  }
  const same = (a, b, depth = 0) => {
    if (depth > 24) return false;
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Object.keys(a), expected = Object.keys(b);
    return keys.length === expected.length && keys.every(key => Object.hasOwn(b, key) && same(a[key], b[key], depth + 1));
  };
  if (!same(value, FEEDBACK_SCHEMA)) refusal('FEEDBACK_RESPONSE_INVALID');
  return FEEDBACK_SCHEMA;
}
