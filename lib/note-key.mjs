// Typed ownership for the existing note entry. Stack facts are additive at the
// document root, so older readers keep treating operations as operations.
import { secretIn } from './verdicts.mjs';
import { createHash } from 'node:crypto';
import { parseAuthReference } from './auth-reference.mjs';
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (object, key) => plain(object) && Object.hasOwn(object, key) ? object[key] : undefined;
function refuse(code) { throw Object.assign(new Error('The note target is invalid or unsupported.'), { code }); }

export function normalizeNoteKey(input) {
  if (typeof input === 'string') input = { kind: 'operation', op: input };
  if (!plain(input)) refuse('NOTE_KEY_INVALID');
  if (input.kind === 'stack' && Object.keys(input).every(k => k === 'kind')) return { kind: 'stack' };
  if (input.kind === 'account' && Object.keys(input).every(k => ['kind', 'environment', 'credential_reference'].includes(k))
    && typeof input.environment === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(input.environment)
    && parseAuthReference(input.credential_reference))
    return { kind: 'account', environment: input.environment, credential_reference: canonicalCredentialReference(input.credential_reference) };
  // Existing operation keys retain their exact identity, including newlines.
  // Their output boundary flattens unsafe text; the typed wrapper must not
  // make an older saved store unwritable before that renderer can inspect it.
  if (input.kind === 'operation' && Object.keys(input).every(k => ['kind', 'op'].includes(k))
    && typeof input.op === 'string' && input.op.length > 0)
    return { kind: 'operation', op: input.op };
  refuse(input.kind && !['stack', 'operation', 'account'].includes(input.kind) ? 'NOTE_KEY_UNSUPPORTED' : 'NOTE_KEY_INVALID');
}
export function canonicalCredentialReference(value) {
  const auth = parseAuthReference(value);
  if (!auth) refuse('NOTE_KEY_INVALID');
  return auth.scheme === 'header' ? `header:${auth.name.toLowerCase()}:${auth.envVar}` : value;
}
export function accountNoteIdentity(input) {
  const key = normalizeNoteKey(input);
  if (key.kind !== 'account') refuse('NOTE_KEY_INVALID');
  return `account-${createHash('sha256').update(JSON.stringify(key)).digest('hex')}`;
}
export function noteKeyLabel(input) {
  const key = normalizeNoteKey(input);
  return key.kind === 'stack' ? 'stack' : key.kind === 'account' ? `account ${key.environment} ${key.credential_reference}` : key.op;
}
export function getNoteEntry(ctx, input) {
  const key = normalizeNoteKey(input);
  return key.kind === 'stack' ? own(ctx, 'stack_facts') : key.kind === 'account' ? own(ctx?.account_facts, accountNoteIdentity(key)) : own(ctx?.operations, key.op);
}
export function setNoteEntry(ctx, input, entry) {
  const key = normalizeNoteKey(input);
  const parent = key.kind === 'stack' ? ctx : key.kind === 'account' ? (ctx.account_facts ??= {}) : (ctx.operations ??= {});
  if (key.kind === 'account') Object.assign(entry, { environment: key.environment, credential_reference: key.credential_reference });
  Object.defineProperty(parent, key.kind === 'stack' ? 'stack_facts' : key.kind === 'account' ? accountNoteIdentity(key) : key.op,
    { value: entry, enumerable: true, writable: true, configurable: true });
  return entry;
}
// Account facts are opt-in: shared account knowledge still must not enter repo-wide pointers.
export function noteEntries(ctx, { accounts = false } = {}) {
  const scoped = accounts ? Object.entries(ctx?.account_facts ?? {}).map(([id, entry]) => {
    const key = normalizeNoteKey({ kind: 'account', environment: entry?.environment, credential_reference: entry?.credential_reference });
    if (id !== accountNoteIdentity(key)) refuse('NOTE_KEY_INVALID');
    return { key, entry };
  }) : [];
  return [
    ...scoped,
    ...(plain(ctx) && Object.hasOwn(ctx, 'stack_facts') ? [{ key: { kind: 'stack' }, entry: ctx.stack_facts }] : []),
    ...Object.entries(ctx?.operations ?? {}).map(([op, entry]) => ({ key: { kind: 'operation', op }, entry })),
  ];
}
export function validNoteOperations(operations) {
  return Array.isArray(operations) && operations.length > 0 && operations.length <= 256
    && operations.every(op => typeof op === 'string' && op.length <= 512
      && /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE|CONNECT) \/[^\s?#]*$/.test(op)
      && !/[\x00-\x1f\x7f-\x9f]/.test(op) && !secretIn(op))
    && new Set(operations).size === operations.length;
}
export function normalizeNoteOperations(operations) {
  if (operations === undefined || (Array.isArray(operations) && operations.length === 0)) return undefined;
  if (!Array.isArray(operations)) refuse('NOTE_OPERATIONS_INVALID');
  const normalized = [...new Set(operations)].sort();
  if (!validNoteOperations(normalized)) refuse('NOTE_OPERATIONS_INVALID');
  return normalized;
}
