import { createHash } from 'node:crypto';
import { isObject, mcpError, safeMcpValue } from './mcp-facts.mjs';

// Identity covers complete declarations before the value-free projection. Hash
// canonical tokens directly, then sort per-tool hashes so list order is immaterial.
// Bounds mirror at most 100 one-MiB declarations and prevent excessive nesting
// or traversal; raw schema values never leave this function.
export function mcpToolDeclarationsDigest(tools) {
  const oversized = () => { throw mcpError('MCP tool declarations exceed the supported digest bound', 'MCP_OVERSIZED'); };
  if (!Array.isArray(tools) || tools.length > 100) return oversized();
  let bytes = 0, nodes = 0;
  const hashes = tools.map(tool => {
    const hash = createHash('sha256');
    const token = value => {
      bytes += Buffer.byteLength(value);
      if (bytes > 100 * 1024 * 1024) oversized();
      hash.update(value);
    };
    const walk = (value, depth = 0) => {
      if (depth > 64 || ++nodes > 1_000_000) oversized();
      if (Array.isArray(value)) {
        token('[');
        value.forEach((item, i) => { if (i) token(','); walk(item, depth + 1); });
        token(']');
      } else if (isObject(value)) {
        token('{');
        Object.keys(value).sort().forEach((key, i) => {
          if (i) token(',');
          token(JSON.stringify(key)); token(':'); walk(value[key], depth + 1);
        });
        token('}');
      } else token(JSON.stringify(value) ?? 'null');
    };
    walk(tool);
    return hash.digest('hex');
  });
  return createHash('sha256').update(JSON.stringify(hashes.sort())).digest('hex');
}

export const mcpServerKey = (record) => record.server?.label || record.server?.name || null;
const stable = (value) => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(v => JSON.parse(stable(v) ?? 'null')) : Object.fromEntries(Object.keys(value).sort().map(k => [k, JSON.parse(stable(value[k]) ?? 'null')])) : value);
const changed = (a, b) => stable(a) !== stable(b);
const fieldTypes = (schema, prefix = '', depth = 0) => depth > 32 ? {} : Object.fromEntries(Object.entries(schema?.properties ?? {}).flatMap(([name, field]) => {
  const path = prefix ? `${prefix}.${name}` : name;
  return [[path, field?.type ?? 'unspecified'], ...Object.entries(fieldTypes(field, path, depth + 1)), ...Object.entries(fieldTypes(field?.items, `${path}[]`, depth + 1))];
}));
function requiredFields(schema, prefix = '', depth = 0) {
  if (depth > 32) return [];
  return [...(schema?.required ?? []).map(name => prefix ? `${prefix}.${name}` : name), ...Object.entries(schema?.properties ?? {}).flatMap(([name, field]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    return [...requiredFields(field, path, depth + 1), ...requiredFields(field?.items, `${path}[]`, depth + 1)];
  })];
}

function schemaChanges(before, after, prefix = 'input') {
  const changes = [];
  const oldRequired = new Set(requiredFields(before)), newRequired = new Set(requiredFields(after));
  for (const name of newRequired) if (!oldRequired.has(name)) changes.push(`${prefix} required field added: ${name}`);
  for (const name of oldRequired) if (!newRequired.has(name)) changes.push(`${prefix} required field removed: ${name}`);
  const oldFields = fieldTypes(before), newFields = fieldTypes(after);
  for (const [name, type] of Object.entries(newFields)) {
    if (!Object.hasOwn(oldFields, name)) changes.push(`${prefix} field added: ${name}`);
    else if (changed(oldFields[name], type)) changes.push(`${prefix} field type changed: ${name}`);
  }
  for (const name of Object.keys(oldFields)) if (!Object.hasOwn(newFields, name)) changes.push(`${prefix} field removed: ${name}`);
  if (changed(before, after) && !changes.length) changes.push(`${prefix} schema changed`);
  return changes;
}

function toolChanges(a, b) {
  const out = [];
  if (changed(a.description, b.description)) out.push('description changed');
  out.push(...schemaChanges(a.inputSchema, b.inputSchema));
  for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
    if (changed(a.annotations?.[hint], b.annotations?.[hint])) out.push(`claim ${hint} changed: ${a.annotations?.[hint] ?? 'unspecified'} → ${b.annotations?.[hint] ?? 'unspecified'}`);
  }
  if (a.outputSchema === undefined && b.outputSchema !== undefined) out.push('outputSchema appeared');
  else if (a.outputSchema !== undefined && b.outputSchema === undefined) out.push('outputSchema removed');
  else if (changed(a.outputSchema, b.outputSchema)) out.push(...schemaChanges(a.outputSchema, b.outputSchema, 'output'));
  if (!out.length && changed(a, b)) out.push('declaration changed');
  return out;
}
function declarationChanges(a, b) {
  const out = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!changed(a[key], b[key])) continue;
    if (key === 'arguments') {
      const old = new Map((a.arguments ?? []).map(arg => [arg.name, arg]));
      const next = new Map((b.arguments ?? []).map(arg => [arg.name, arg]));
      for (const [name, arg] of next) out.push(!old.has(name) ? `argument added: ${name}` : changed(old.get(name), arg) ? `argument changed: ${name}` : null);
      for (const name of old.keys()) if (!next.has(name)) out.push(`argument removed: ${name}`);
    } else out.push(`${key} changed`);
  }
  return out.filter(Boolean);
}
function collectionDiff(before, after, identify, details, unavailable) {
  const result = { added: [], removed: [], changed: [] };
  const oldState = before?.state === 'not_declared' ? 'not_declared' : 'declared';
  const newState = after?.state === 'not_declared' ? 'not_declared' : 'declared';
  if (oldState === 'not_declared' && newState === 'not_declared') return { state: 'not_declared' };
  if (oldState !== newState) result.declaration = { previous: oldState, current: newState };
  // A failed list cannot prove deletion, addition, or stability.
  if (unavailable.length) return { ...result, unavailable };
  const old = new Map((Array.isArray(before) ? before : []).map(x => [identify(x), x])), next = new Map((Array.isArray(after) ? after : []).map(x => [identify(x), x]));
  for (const [name, item] of next) {
    if (!old.has(name)) result.added.push(name);
    else { const changes = details(old.get(name), item); if (changes.length) result.changed.push({ name, changes }); }
  }
  for (const name of old.keys()) if (!next.has(name)) result.removed.push(name);
  return result;
}
export function diffMcpInspection(previous, current) {
  if (!previous) return null;
  const lists = record => {
    const declared = { ...record.declared };
    // Older inspections requested undeclared lists and recorded empty arrays
    // with method-not-found errors. Use the stored capability claim to compare
    // their absence without rewriting that immutable historical evidence.
    if (isObject(record.capabilities)) for (const key of ['tools', 'resources', 'resourceTemplates', 'prompts']) {
      if (!Object.hasOwn(record.capabilities, key === 'resourceTemplates' ? 'resources' : key)
        && Array.isArray(declared[key]) && declared[key].length === 0) {
        declared[key] = { state: 'not_declared' };
        delete declared[`${key}_error`];
      }
    }
    return declared;
  };
  const a = lists(previous), b = lists(current);
  const unavailable = (...kinds) => kinds.flatMap(k => [a[`${k}_error`] ? `previous ${k} list failed` : null, b[`${k}_error`] ? `current ${k} list failed` : null]).filter(Boolean);
  const resources = declared => declared.resources?.state === 'not_declared' ? declared.resources
    : [...(Array.isArray(declared.resources) ? declared.resources : []), ...(Array.isArray(declared.resourceTemplates) ? declared.resourceTemplates : [])];
  const tools = collectionDiff(a.tools ?? [], b.tools ?? [], x => x.name, toolChanges, unavailable('tools'));
  const digestChanged = [previous, current].every(record => /^[a-f0-9]{64}$/.test(record.tool_declarations_digest ?? ''))
    && previous.tool_declarations_digest !== current.tool_declarations_digest;
  return safeMcpValue({
    since: previous.at,
    tools,
    ...(digestChanged && !tools.unavailable && tools.state !== 'not_declared' && !['added', 'removed', 'changed'].some(key => tools[key]?.length)
      ? { tool_declarations: 'tool declarations changed (details not retained)' } : {}),
    resources: collectionDiff(resources(a), resources(b), x => x.uriTemplate ?? x.uri ?? x.name, declarationChanges, unavailable('resources', 'resourceTemplates')),
    prompts: collectionDiff(a.prompts ?? [], b.prompts ?? [], x => x.name, declarationChanges, unavailable('prompts')),
    server: declarationChanges(previous.server ?? {}, current.server ?? {}),
    ...(changed(previous.capabilities, current.capabilities) ? { capabilities: 'capabilities changed' } : {}),
    ...(changed(previous.instructions, current.instructions) ? { instructions: 'instructions changed' } : {}),
  });
}

// Count-only pruning; timestamps are evidence pointers, never expiry dates.
// Unknown identities share a bounded legacy bucket but are never diff-matched.
export function pruneMcpInspections(records, keep = 20) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 20) throw new RangeError('MCP retention count must be between 1 and 20');
  const counts = new Map();
  return records.slice().reverse().filter(record => {
    const key = mcpServerKey(record);
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= keep;
  }).reverse();
}
