// MCP promotion boundary: declarations and measured shapes, never sample values.
import { secretIn } from './verdicts.mjs';
import { unsafePattern, matchesPattern, PATTERN_INPUT_MAX_CHARS } from './assertions.mjs';

export const mcpError = (message, code) => Object.assign(new Error(message), { code });
export const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const valueType = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
const userinfo = /(?<![a-z\d+.-])([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi;
export const redactMcpUri = (v) => String(v).replace(userinfo, '$1');

export function scanMcpValue(v, depth = 0) {
  if (typeof v === 'string') {
    if (secretIn(v) || /(?<![a-z\d+.-])[a-z][a-z\d+.-]*:\/\/[^\s/]*@/i.test(v))
      throw mcpError('MCP inspection contains a literal secret', 'MCP_LITERAL_SECRET_REFUSED');
  } else if (v && typeof v === 'object') {
    if (depth > 64) throw mcpError('MCP data exceeds the supported nesting depth', 'MCP_OVERSIZED');
    for (const [key, value] of Object.entries(v)) { scanMcpValue(key, depth + 1); scanMcpValue(value, depth + 1); }
  }
}

// Scan the entire string before truncating it, including property names. Live
// declarations redact URI userinfo; direct storage retains the strict refusal.
export function safeMcpValue(v, depth = 0) {
  if (typeof v === 'string') {
    const redacted = redactMcpUri(v);
    if (secretIn(redacted)) throw mcpError('MCP inspection contains a literal secret', 'MCP_LITERAL_SECRET_REFUSED');
    return redacted.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200);
  }
  if (depth > 32) return { type: 'object' };
  if (Array.isArray(v)) return v.slice(0, 100).map(x => safeMcpValue(x, depth + 1));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [safeMcpValue(k), safeMcpValue(x, depth + 1)]));
  return v;
}

export function schemaFacts(schema, depth = 0) {
  if (typeof schema === 'boolean') return schema;
  if (!isObject(schema) || depth > 32) return {};
  const out = {};
  if (primitiveTypes.has(schema.type)) out.type = schema.type;
  else if (Array.isArray(schema.type)) out.type = schema.type.filter(type => primitiveTypes.has(type));
  if (Array.isArray(schema.required)) out.required = schema.required.filter(name => typeof name === 'string');
  if (isObject(schema.properties)) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, child]) => [name, schemaFacts(child, depth + 1)]));
  if (schema.items !== undefined) out.items = schemaFacts(schema.items, depth + 1);
  if (schema.additionalProperties !== undefined) out.additionalProperties = schemaFacts(schema.additionalProperties, depth + 1);
  // Constraints are identified, not copied: enum/default/example values never
  // cross the promotion boundary. Execution validates the original schema.
  const constraints = Object.keys(schema).filter(k => !['type', 'required', 'properties', 'items', 'additionalProperties', 'description', 'title', '$schema', 'default', 'examples', 'example', 'constraints'].includes(k));
  if (Array.isArray(schema.constraints)) constraints.push(...schema.constraints.filter(key => typeof key === 'string'));
  if (constraints.length) out.constraints = [...new Set(constraints)];
  return out;
}

const primitiveTypes = new Set(['string', 'number', 'integer', 'boolean', 'null', 'object', 'array']);
const annotationKeys = new Set(['description', 'title', '$schema', 'default', 'examples', 'example']);
const supported = new Set(['type', 'required', 'properties', 'items', 'additionalProperties', 'enum', 'const', 'minimum', 'maximum', 'minLength', 'maxLength', 'pattern']);
const typeMatches = (v, type) => type === 'integer' ? Number.isInteger(v) : type === 'number' ? typeof v === 'number' && Number.isFinite(v) : valueType(v) === type;
const unsupportedKeyword = key => `unsupported schema keyword: ${safeMcpValue(key)}`;

// JSON equality ignores object key order and treats -0 and 0 alike. Neither
// declaration values nor argument values are used in a diagnostic or record.
function equalJson(a, b, depth = 0) {
  if (a === b) return true;
  if (depth > 32) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, i) => equalJson(item, b[i], depth + 1));
  if (isObject(a) && isObject(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equalJson(a[key], b[key], depth + 1));
  return false;
}

function patternProblem(pattern) {
  // Share the assertion runner's ReDoS rule and refuse before compilation.
  if (unsafePattern(pattern) !== null) return 'unsupported pattern: unsafe pattern';
  try { new RegExp(pattern); }
  catch { return 'unsupported pattern: invalid regular expression'; }
  return null;
}

// Deliberately bounded structural validation. Unknown constraints fail closed;
// this does not claim to implement all of JSON Schema.
export function shapeProblems(value, schema, path = '$', depth = 0) {
  const issues = [];
  const add = (kind, field = path) => issues.push({ kind, field });
  if (depth > 32) { add('unsupported depth'); return issues; }
  if (schema === true) return issues;
  if (schema === false) { add('forbidden field'); return issues; }
  if (!isObject(schema)) { add('unsupported schema'); return issues; }
  for (const key of Object.keys(schema)) if (!supported.has(key) && !annotationKeys.has(key)) add(unsupportedKeyword(key));
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.some(t => !primitiveTypes.has(t)) || (Array.isArray(schema.type) && !types.length)) add('unsupported type');
  else if (types.length && !types.some(t => typeMatches(value, t))) add('type mismatch');
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(x => typeof x !== 'string'))) add('unsupported required');
  if (schema.properties !== undefined && !isObject(schema.properties)) add('unsupported properties');
  if (Array.isArray(schema.enum) && !schema.enum.some(member => equalJson(value, member))) add('enum mismatch');
  if (Object.hasOwn(schema, 'const') && !equalJson(value, schema.const)) add('const mismatch');
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) add('minimum not met');
    if (typeof schema.maximum === 'number' && value > schema.maximum) add('maximum exceeded');
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (Number.isInteger(schema.minLength) && length < schema.minLength) add('minLength not met');
    if (Number.isInteger(schema.maxLength) && length > schema.maxLength) add('maxLength exceeded');
    if (schema.pattern !== undefined) {
      const problem = patternProblem(schema.pattern);
      if (problem) add(problem);
      else if (value.length > PATTERN_INPUT_MAX_CHARS) add('unsupported pattern input length');
      else if (!matchesPattern(value, schema.pattern)) add('pattern mismatch');
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? schema.required : []) if (!Object.hasOwn(value, name)) add('missing', path === '$' ? name : `${path}.${name}`);
    for (const [name, item] of Object.entries(value)) {
      const field = path === '$' ? name : `${path}.${name}`;
      if (Object.hasOwn(properties, name)) issues.push(...shapeProblems(item, properties[name], field, depth + 1));
      else if (schema.additionalProperties === false) add('unexpected', field);
      else if (isObject(schema.additionalProperties)) issues.push(...shapeProblems(item, schema.additionalProperties, field, depth + 1));
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) for (const item of value) issues.push(...shapeProblems(item, schema.items, `${path}[]`, depth + 1));
  return issues;
}

function definitionProblems(schema, path = '$', depth = 0) {
  if (depth > 32) return [{ field: path, kind: 'unsupported depth' }];
  if (typeof schema === 'boolean') return [];
  if (!isObject(schema)) return [{ field: path, kind: 'unsupported schema' }];
  const problems = Object.keys(schema).filter(key => !supported.has(key) && !annotationKeys.has(key)).map(key => ({ field: path, kind: unsupportedKeyword(key) }));
  if (schema.type !== undefined && !(primitiveTypes.has(schema.type) || Array.isArray(schema.type) && schema.type.length && schema.type.every(type => primitiveTypes.has(type)))) problems.push({ field: path, kind: 'unsupported type' });
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some(name => typeof name !== 'string'))) problems.push({ field: path, kind: 'unsupported required' });
  if (schema.properties !== undefined && !isObject(schema.properties)) problems.push({ field: path, kind: 'unsupported properties' });
  if (Object.hasOwn(schema, 'enum') && (!Array.isArray(schema.enum) || !schema.enum.length)) problems.push({ field: path, kind: 'unsupported enum' });
  for (const key of ['minimum', 'maximum']) if (Object.hasOwn(schema, key) && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) problems.push({ field: path, kind: `unsupported ${key}` });
  for (const key of ['minLength', 'maxLength']) if (Object.hasOwn(schema, key) && (!Number.isInteger(schema[key]) || schema[key] < 0)) problems.push({ field: path, kind: `unsupported ${key}` });
  if (Object.hasOwn(schema, 'pattern')) {
    const problem = patternProblem(schema.pattern);
    if (problem) problems.push({ field: path, kind: problem });
  }
  for (const [name, child] of Object.entries(isObject(schema.properties) ? schema.properties : {})) problems.push(...definitionProblems(child, path === '$' ? name : `${path}.${name}`, depth + 1));
  if (schema.items !== undefined) problems.push(...definitionProblems(schema.items, `${path}[]`, depth + 1));
  if (schema.additionalProperties !== undefined) problems.push(...definitionProblems(schema.additionalProperties, path, depth + 1));
  return problems;
}

// Credential material belongs in the server environment, never literal JSON
// arguments. References remain literal references; the inspector resolves none.
export function guardCredentialArgs(value, depth = 0) {
  if (depth > 32 || !value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:password|passwd|secret|token|access_token|client_secret|api[_-]?key|authorization)$/i.test(key) && typeof item === 'string' && !/^\$(?:[A-Z_][A-Z0-9_]*|\{[A-Z_][A-Z0-9_]*\})$/.test(item))
      throw mcpError('MCP credential arguments must be environment references', 'MCP_LITERAL_SECRET_REFUSED');
    guardCredentialArgs(item, depth + 1);
  }
}

export function validateToolArgs(value, schema) {
  const contract = schema ?? { type: 'object' };
  let problems = isObject(value) ? definitionProblems(contract) : [{ field: '$', kind: 'expected object' }];
  if (!problems.length) problems = shapeProblems(value, contract);
  if (problems.length) {
    const { field, kind } = problems[0];
    throw mcpError(`MCP arguments invalid: ${kind} at '${safeMcpValue(field)}'`, 'MCP_ARGS_INVALID');
  }
}

function measuredFields(value, path = '', depth = 0) {
  if (depth > 16) return [];
  if (!isObject(value)) return [{ name: path || '$', type: valueType(value) }];
  const fields = [];
  for (const [name, item] of Object.entries(value).slice(0, 100)) {
    const field = path ? `${path}.${name}` : name;
    fields.push({ name: field, type: valueType(item) });
    if (isObject(item)) fields.push(...measuredFields(item, field, depth + 1));
    if (Array.isArray(item) && item.length) fields.push(...measuredFields(item[0], `${field}[]`, depth + 1));
    if (fields.length >= 100) break;
  }
  return fields.slice(0, 100);
}

export function observeTool(reply, schema) {
  const result = reply?.result;
  const error = Boolean(reply?.error || result?.isError);
  const structured = isObject(result) && Object.hasOwn(result, 'structuredContent');
  const value = structured ? result.structuredContent : result?.content;
  const result_kind = error ? 'error' : structured ? 'structured' : 'text';
  const problems = schema !== undefined && structured && !error ? [...definitionProblems(schema), ...shapeProblems(value, schema)] : [];
  const fields = measuredFields(value);
  // Unexpected fields are drift even where additionalProperties permits them:
  // this is a comparison with the declared shape, not a validity guarantee.
  const unexpected = [];
  const walk = (v, s, path = '', depth = 0) => {
    if (depth > 16 || !isObject(v)) return;
    for (const [key, item] of Object.entries(v).slice(0, 100)) {
      const field = path ? `${path}.${key}` : key;
      if (!Object.hasOwn(s?.properties ?? {}, key)) unexpected.push(field);
      else walk(item, s.properties[key], field, depth + 1);
    }
  };
  if (schema !== undefined && structured) walk(value, schema);
  return safeMcpValue({
    matches_output_schema: schema === undefined ? null : error || !structured ? false : problems.length === 0 && unexpected.length === 0,
    missing: problems.filter(p => p.kind === 'missing').map(p => p.field),
    unexpected: [...new Set([...unexpected, ...problems.filter(p => p.kind === 'unexpected').map(p => p.field)])],
    result_kind,
    ...(problems.some(p => p.kind === 'type mismatch') ? { type_mismatches: problems.filter(p => p.kind === 'type mismatch').map(p => p.field) } : {}),
    ...(problems.some(p => p.kind.startsWith('unsupported')) ? { schema_limitations: problems.filter(p => p.kind.startsWith('unsupported')).map(p => p.field) } : {}),
    ...(schema === undefined ? { fields } : {}),
  });
}
