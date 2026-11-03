// Account knowledge uses the common authored-note history, but its credential
// confirmation never crosses into the shared stack store. Reads cannot turn a
// reference name into proof that this machine has the same credential.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { MAX_CONTEXT_BYTES, emptyContext, inspectNoteHistory, loadContextSnapshot, saveContext, saveContextNote } from './context.mjs';
import { accountNoteIdentity, canonicalCredentialReference, getNoteEntry, normalizeNoteKey } from './note-key.mjs';
import { authEnvVars, authReadiness, credentialEnvironment } from './config.mjs';
import { currentStackScope, withStackScope } from './stack-scope.mjs';
import { assertWritableStack } from './stacks.mjs';
import { machineStatePaths } from './machine-state.mjs';
import { LAYOUT, ensureLayout } from './layout.mjs';
import { CLI_NAME } from './brand.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { secretIn } from './verdicts.mjs';
import { validAuthoredNoteStamp } from './note-history.mjs';

const fail = code => { throw Object.assign(new Error('The account fact could not be read or recorded safely; inspect the selected stack, environment and credential reference.'), { code }); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const safePath = (path, directory = false) => safeOutputPath(path, { directory, code: 'ACCOUNT_UNSAFE_PATH' });
const pause = new Int32Array(new SharedArrayBuffer(4));
const shell = value => /^[A-Za-z0-9_.-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
function bytes(path, maxBytes = MAX_CONTEXT_BYTES) {
  safePath(path);
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail('ACCOUNT_UNSAFE_PATH');
    const chunks = []; let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count; if (total > maxBytes) fail('ACCOUNT_STORE_TOO_LARGE');
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function json(path) { return JSON.parse(bytes(path)); }
function directory(path) { safePath(path, true); mkdirSync(path, { recursive: true, mode: 0o700 }); chmodSync(path, 0o700); }
function write(path, value) {
  writeOutputFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, code: 'ACCOUNT_UNSAFE_PATH' });
}
function locked(folder, fn) {
  const lock = join(folder, '.state-lock');
  const until = Date.now() + 5000;
  for (;;) {
    safePath(lock, true);
    try { mkdirSync(lock, { mode: 0o700 }); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= until) fail('ACCOUNT_WRITE_LOCKED');
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try { return fn(); } finally { rmdirSync(lock); }
}
function selected(root, scope, config = scope?.config, { writing = false, credentials } = {}) {
  if (!scope?.stack || resolve(scope.root ?? '') !== resolve(root) || !/^[a-z0-9][a-z0-9-]*$/.test(scope.stack) || !scope.contextFile || !config?.name)
    fail('ACCOUNT_SCOPE_REQUIRED');
  if (writing) assertWritableStack(scope);
  if (!config.auth) fail('ACCOUNT_AUTH_REQUIRED');
  let reference;
  try { reference = canonicalCredentialReference(config.auth); } catch { fail('ACCOUNT_AUTH_INVALID'); }
  let key;
  try { key = normalizeNoteKey({ kind: 'account', environment: config.name, credential_reference: reference }); }
  catch { fail('ACCOUNT_SCOPE_REQUIRED'); }
  const values = credentials ?? credentialEnvironment(config.credentialEnvFiles ?? []), readiness = authReadiness(reference, values);
  if (writing && readiness.state !== 'present') fail(readiness.state === 'missing' ? 'ACCOUNT_CREDENTIAL_MISSING' : 'ACCOUNT_AUTH_INVALID');
  const secrets = authEnvVars(reference).map(name => values[name]).filter(value => typeof value === 'string' && value);
  const identity = accountNoteIdentity(key), folder = join(resolve(root), LAYOUT.evidence, scope.stack, 'account-facts');
  const sharedFile = resolve(root, scope.contextFile);
  if (relative(resolve(root), sharedFile).startsWith('..')) fail('ACCOUNT_UNSAFE_PATH');
  safePath(folder, true); safePath(sharedFile);
  return { root: resolve(root), scope, config, key, identity, folder, secrets, readiness,
    privateFile: join(folder, `${identity}.json`), stateFile: join(folder, `${identity}.confirmation.json`), sharedFile,
    canonicalScope: { stack: scope.stack, environment: key.environment, credential_reference: reference } };
}
function salt({ create = false } = {}) {
  const folder = machineStatePaths().directory, file = join(folder, 'account-facts.salt');
  safePath(folder, true); safePath(file);
  if (create) directory(folder);
  if (!existsSync(file)) {
    if (!create) return null;
    let fd;
    try {
      fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, randomBytes(32).toString('hex'));
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  const raw = bytes(file, 128);
  if (!/^[a-f0-9]{64}$/.test(raw)) fail('ACCOUNT_SALT_INVALID');
  if (create) chmodSync(file, 0o600);
  return { secret: Buffer.from(raw, 'hex'), id: hash(`account-facts-salt-v1:${raw}`) };
}
function fingerprint(selection, machine) {
  if (selection.readiness.state !== 'present' || !machine) return null;
  return createHmac('sha256', machine.secret).update(JSON.stringify({ v: 1, ...selection.canonicalScope, values: selection.secrets })).digest('hex');
}
function state(selection, { writing = false } = {}) {
  safePath(selection.stateFile);
  if (!existsSync(selection.stateFile)) return { v: 1, scope: selection.canonicalScope, confirmations: {} };
  try {
    const current = json(selection.stateFile);
    if (!object(current) || current.v !== 1 || JSON.stringify(current.scope) !== JSON.stringify(selection.canonicalScope) || !object(current.confirmations)) throw new Error('invalid');
    for (const [id, value] of Object.entries(current.confirmations)) {
      if (!/^(?:shared|private):sha256:[a-f0-9]{64}$/.test(id) || !object(value) || !/^[a-f0-9]{64}$/.test(value.fingerprint)
        || !/^[a-f0-9]{64}$/.test(value.salt_id) || typeof value.changed !== 'boolean' || typeof value.confirmed_at !== 'string') throw new Error('invalid');
    }
    return current;
  } catch (error) {
    if (error.code === 'ACCOUNT_UNSAFE_PATH') throw error;
    if (writing) fail('ACCOUNT_STATE_INVALID');
    return { v: 1, scope: selection.canonicalScope, confirmations: {}, invalid: true };
  }
}
function inspection(path, key) {
  safePath(path);
  if (!existsSync(path)) return { records: [], active: [], state: 'empty', issues: [] };
  let ctx;
  try { ctx = json(path); } catch (error) { if (error.code === 'ACCOUNT_UNSAFE_PATH') throw error; fail('ACCOUNT_STORE_INVALID'); }
  if (!object(ctx) || !object(ctx.operations)) fail('ACCOUNT_STORE_INVALID');
  const entry = getNoteEntry(ctx, key);
  if (entry && (entry.environment !== key.environment || entry.credential_reference !== key.credential_reference)) fail('ACCOUNT_STORE_INVALID');
  return inspectNoteHistory(entry ?? {}, 'account');
}
function safeText(value, secrets) {
  return typeof value === 'string' && value.length <= 16384 && !secretIn(value, { allowAuthReferences: true })
    && !secrets.some(secret => value.includes(secret));
}

function redactCurrent(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.replaceAll(secret, '[credential withheld]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => redactCurrent(item, secrets));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactCurrent(item, secrets)]));
  return value;
}

export function writeAccountFact(root, { scope = currentStackScope(), text, stamp, relation, shared = false } = {}) {
  if (typeof shared !== 'boolean') fail('ACCOUNT_SHARING_INVALID');
  const s = selected(root, scope, scope?.config, { writing: true });
  if (!safeText(text, s.secrets) || s.secrets.some(secret => JSON.stringify(stamp)?.includes(secret))) fail('SECRET_IN_NOTE');
  if (stamp?.evidence?.some(ref => ref.state === 'scope_mismatch'
    || ref.scope?.environment && ref.scope.environment !== s.key.environment
    || ref.scope?.provider && ref.scope.provider !== s.config.baseUrl)) fail('ACCOUNT_EVIDENCE_SCOPE_MISMATCH');
  const machine = salt({ create: true });
  // Install ignore rules before any fact or confirmation is created, including
  // a stack added without connect in a repository that has no .git directory.
  withStackScope(scope, () => ensureLayout(root));
  directory(join(resolve(root), LAYOUT.evidence)); directory(dirname(s.folder)); directory(s.folder);
  return locked(s.folder, () => {
    const local = state(s, { writing: true }), file = shared ? s.sharedFile : s.privateFile;
    const storageScope = shared ? scope : { ...scope, contextFile: relative(resolve(root), file) };
    const result = withStackScope(storageScope, () => {
      if (!existsSync(file)) {
        if (shared) saveContext(root, emptyContext({}));
        else write(file, emptyContext({}));
      }
      // Validate the read boundary before entering the existing snapshot/CAS
      // writer; no alternate note mutation or history format is introduced.
      inspection(file, s.key);
      try { return saveContextNote(root, loadContextSnapshot(root), { key: s.key, note: text, stamp, relation }); }
      catch (error) {
        if (error.existing) error.existing = redactCurrent(error.existing, s.secrets);
        throw error;
      }
    });
    local.confirmations[`${shared ? 'shared' : 'private'}:${result.note_id}`] = {
      fingerprint: fingerprint(s, machine), salt_id: machine.id, changed: false, confirmed_at: new Date().toISOString(),
    };
    write(s.stateFile, local);
    return { key: s.key, note_id: result.note_id, unchanged: result.unchanged, reconfirmed: result.unchanged,
      file: relative(resolve(root), file), history: redactCurrent(result.history, s.secrets), shared, credential_state: 'confirmed' };
  });
}

export function readAccountFacts(root, { scope = currentStackScope(), config = scope?.config, history = false, maxFacts = 20, credentials } = {}) {
  const s = selected(root, scope, config, { credentials }), issues = [];
  const show_command = `${CLI_NAME} show --stack ${shell(scope.stack)} --env ${shell(s.key.environment)} --scope account`;
  const sets = [{ shared: false, path: s.privateFile }, { shared: true, path: s.sharedFile }];
  const rows = [];
  for (const group of sets) {
    const inspected = inspection(group.path, s.key);
    const invalid = ['invalid', 'changed'].includes(inspected.state);
    if (invalid) issues.push('ACCOUNT_NOTE_HISTORY_INVALID');
    // Credential confirmation cannot rescue hand-edited authored history.
    // Keep it inspectable only via the explicit history surface.
    const source = history ? inspected.records : invalid ? [] : inspected.active;
    for (const record of source) {
      if (!safeText(record.text, s.secrets)) { issues.push('ACCOUNT_NOTE_WITHHELD'); continue; }
      rows.push({ record, shared: group.shared, invalid: ['invalid', 'changed'].includes(inspected.state) });
    }
  }
  const totals = { credential_changed: 0, credential_unconfirmed: 0, credential_missing: 0 };
  if (!rows.length) return { records: [], total: 0, shown: 0, omitted: 0, show_command, ...totals, ...(issues.length ? { issues: [...new Set(issues)] } : {}) };
  let machine;
  try { machine = salt(); } catch (error) { if (error.code === 'ACCOUNT_UNSAFE_PATH') throw error; issues.push('ACCOUNT_CONFIRMATION_UNAVAILABLE'); }
  const current = fingerprint(s, machine);
  const render = () => {
    const local = state(s); let changed = false;
    if (local.invalid) issues.push('ACCOUNT_CONFIRMATION_UNAVAILABLE');
    const records = rows.map(({ record, shared, invalid }) => {
      const confirmation = local.confirmations[`${shared ? 'shared' : 'private'}:${record.id}`];
      let credential_state = 'unconfirmed';
      if (s.readiness.state !== 'present') credential_state = 'missing';
      else if (!invalid && current && confirmation?.salt_id === machine?.id) {
        if (confirmation.fingerprint !== current && !confirmation.changed) { confirmation.changed = true; changed = true; }
        credential_state = confirmation.changed ? 'changed' : 'confirmed';
      }
      if (credential_state === 'changed') totals.credential_changed++;
      else if (credential_state === 'missing') totals.credential_missing++;
      else if (credential_state === 'unconfirmed') totals.credential_unconfirmed++;
      const provenance = validAuthoredNoteStamp(record.provenance) ? record.provenance : {};
      const safeMetadata = value => {
        const serialized = JSON.stringify(value);
        return !s.secrets.some(secret => serialized?.includes(secret)) && !secretIn(serialized ?? '', { allowAuthReferences: true });
      };
      return { id: record.id, text: record.text, at: safeMetadata(provenance.at) ? provenance.at ?? null : null,
        by: safeMetadata(provenance.by) ? provenance.by ?? null : null,
        evidence: (provenance.evidence ?? []).filter(safeMetadata), shared, credential_reference: s.key.credential_reference,
        environment: s.key.environment, stack: scope.stack, credential_state,
        ...(credential_state === 'changed' ? { warning: 'credential changed since observed' } : {}),
        ...(history ? { superseded: Boolean(record.superseded) } : {}) };
    });
    if (changed && !local.invalid) write(s.stateFile, local);
    return records;
  };
  // Read-only discovery does not create a salt, directory or confirmation. A
  // detected mismatch marks existing local confirmation sticky under a lock.
  const records = existsSync(s.folder) ? locked(s.folder, render) : render();
  records.sort((a, b) => Number(a.superseded) - Number(b.superseded) || String(b.at).localeCompare(String(a.at)) || a.id.localeCompare(b.id));
  const limit = Number.isInteger(maxFacts) ? Math.max(0, Math.min(maxFacts, 1000)) : 20;
  return { records: records.slice(0, limit), total: records.length, shown: Math.min(records.length, limit), omitted: Math.max(0, records.length - limit),
    show_command, ...totals, ...(issues.length ? { issues: [...new Set(issues)] } : {}) };
}
