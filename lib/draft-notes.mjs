// Suggestions are private, evidence-bound records. Provider prose is inspected
// for small signals, never copied into instructions or committed knowledge.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deref, opNode, readContract } from './context.mjs';
import { normalizeNoteKey, normalizeNoteOperations, validNoteOperations } from './note-key.mjs';
import { secretIn } from './verdicts.mjs';
import { fieldNameRefusal } from './promote.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { openEvidenceRoot, readEvidenceBytes, resolveNoteEvidence } from './note-evidence.mjs';
import { CLI_NAME } from './brand.mjs';

const sessions = new Map();
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code) => {
  throw Object.assign(
    new Error(
      'The private draft could not be accepted safely; inspect its scoped evidence and request a new draft.',
    ),
    { code },
  );
};
const safe = (value, secrets = []) =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 &&
  !/[\x00-\x1f\x7f-\x9f]/.test(value) && !secretIn(value) &&
  !secrets.some((secret) => typeof secret === 'string' && secret && value.includes(secret));
const symbol = (value, secrets = []) =>
  safe(value, secrets) && /^[A-Za-z_][A-Za-z0-9_.-]{0,79}$/.test(value) && !fieldNameRefusal(value);
const scopeOf = (identity) => ({
  stack: identity.stack,
  environment: identity.environment,
  provider: identity.provider,
  contract_digest: identity.contractDigest,
});
const stable = (value) => JSON.stringify(value);
const idFor = (seed) => `draft-${createHash('sha256').update(stable(seed)).digest('hex')}`;
const folderFor = (root, evidenceDir) => join(resolve(root, evidenceDir), 'draft-notes');
const evidenceFields = (scope) => ({
  environment: scope.environment,
  provider: scope.provider,
  contractDigest: scope.contract_digest,
});

function generatedText(finding, scope, operations) {
  switch (finding.kind) {
    case 'undeclared-status':
      return `Observed HTTP ${finding.status}, which this operation's contract does not declare. Review the linked response before relying on that status.`;
    case 'optional-field-required':
      return `Observed HTTP ${finding.status} naming ${finding.name} as required although the contract marks it optional and the request omitted it. Re-check this requirement against the linked evidence.`;
    case 'unknown-parameter':
      return `Observed HTTP ${finding.status} naming parameter ${finding.name}, which this operation's contract does not declare. Review the linked evidence before using it.`;
    case 'required-beta-header':
      return `Observed HTTP ${finding.status} asking for header ${finding.name}, which the contract does not mark required. Review the linked evidence before adding this header.`;
    case 'repeated-error-code':
      return `Observed error code ${finding.code} on ${operations.length} named operations in environment ${scope.environment} during one client session. This is an observation, not a universal stack or account requirement; review both evidence runs.`;
    default:
      fail('DRAFT_INVALID');
  }
}
function validateFinding(finding) {
  if (!object(finding)) fail('DRAFT_INVALID');
  if (finding.kind === 'repeated-error-code') {
    if (!(symbol(finding.code) || /^\d{1,12}$/.test(finding.code))) fail('DRAFT_INVALID');
  } else if (
    !['undeclared-status', 'optional-field-required', 'unknown-parameter', 'required-beta-header'].includes(
      finding.kind,
    ) ||
    !Number.isInteger(finding.status) || finding.status < 100 || finding.status > 599 ||
    finding.kind !== 'undeclared-status' && !symbol(finding.name)
  ) fail('DRAFT_INVALID');
}
function validate(record) {
  if (!object(record) || record.v !== 1 || !/^draft-[a-f0-9]{64}$/.test(record.id)) fail('DRAFT_INVALID');
  const scope = record.scope;
  if (
    !object(scope) || !safe(scope.stack) || !/^[a-z0-9][a-z0-9-]*$/.test(scope.stack) ||
    !safe(scope.environment) || !safe(scope.provider) ||
    !/^sha256:[a-f0-9]{64}$/.test(scope.contract_digest)
  ) fail('DRAFT_INVALID');
  try {
    const url = new URL(scope.provider);
    if (
      !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    ) fail('DRAFT_INVALID');
  } catch {
    fail('DRAFT_INVALID');
  }
  validateFinding(record.finding);
  let key, operations;
  try {
    key = normalizeNoteKey(record.key);
    operations = normalizeNoteOperations(record.operations);
  } catch {
    fail('DRAFT_INVALID');
  }
  if (
    key.kind !== 'operation' && key.kind !== 'stack' ||
    key.kind === 'stack' && (!operations || operations.length < 2 || operations.length > 16)
  ) fail('DRAFT_INVALID');
  if (key.kind === 'operation' && !validNoteOperations([key.op])) fail('DRAFT_INVALID');
  if (
    record.reason !== record.finding.kind ||
    record.text !== generatedText(record.finding, scope, operations) || secretIn(record.text)
  ) fail('DRAFT_INVALID');
  if (record.snapshot_digest !== undefined && !/^sha256:[a-f0-9]{64}$/.test(record.snapshot_digest)) {
    fail('DRAFT_INVALID');
  }
  const seed = {
    scope,
    key,
    ...(operations?.length ? { operations } : {}),
    finding: record.finding,
    ...(record.snapshot_digest ? { snapshot_digest: record.snapshot_digest } : {}),
  };
  if (
    idFor(seed) !== record.id || !Array.isArray(record.evidence) || !record.evidence.length ||
    record.evidence.length > 16 ||
    record.evidence.some((id) => !/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) ||
    !Array.isArray(record.references) || record.references.length !== record.evidence.length
  ) fail('DRAFT_INVALID');
  if (
    record.accepted &&
    (!object(record.accepted) || !/^sha256:[a-f0-9]{64}$/.test(record.accepted.note_id) ||
      !/^sha256:[a-f0-9]{64}$/.test(record.accepted.text_digest))
  ) fail('DRAFT_INVALID');
  return record;
}
function load(folder, id) {
  if (typeof id !== 'string' || !/^draft-[a-f0-9]{64}$/.test(id)) fail('DRAFT_ID_INVALID');
  try {
    const opened = openEvidenceRoot(folder);
    if (!opened) fail('DRAFT_NOT_FOUND');
    const record = validate(JSON.parse(readEvidenceBytes(opened, `${id}.json`, { maxBytes: 65536 }).toString()));
    // A valid sibling's bytes are not the draft the caller chose to accept.
    if (record.id !== id) fail('DRAFT_INVALID');
    return record;
  } catch (error) {
    if (error.code?.startsWith('DRAFT_')) throw error;
    fail(error.code === 'ENOENT' ? 'DRAFT_NOT_FOUND' : 'DRAFT_INVALID');
  }
}
function verifyEvidence(record, evidenceDir) {
  const resolved = resolveNoteEvidence(record.evidence, {
    evidenceDir,
    key: record.key,
    operations: record.operations,
    ...evidenceFields(record.scope),
  });
  if (
    resolved.warnings.length ||
    resolved.references.some((ref, index) =>
      ref.state !== 'available' || ref.digest !== record.references[index]?.digest ||
      stable(ref.scope) !== stable(record.references[index]?.scope)
    )
  ) fail('DRAFT_EVIDENCE_CHANGED');
}
export function readDraftNote(root, id, { scope } = {}) {
  if (!scope?.stack || !scope.evidenceDir) fail('DRAFT_SCOPE_REQUIRED');
  const record = load(folderFor(root, scope.evidenceDir), id);
  let digest;
  try {
    digest = hash(readContract(scope.config.contract).raw);
  } catch {
    fail('DRAFT_SCOPE_CHANGED');
  }
  const expected = {
    stack: scope.stack,
    environment: scope.config.name,
    provider: scope.config.baseUrl,
    contract_digest: digest,
  };
  if (stable(expected) !== stable(record.scope)) fail('DRAFT_SCOPE_CHANGED');
  verifyEvidence(record, resolve(root, scope.evidenceDir));
  return record;
}
export function markDraftNoteAccepted(root, id, { scope, note_id, text_digest } = {}) {
  const record = readDraftNote(root, id, { scope });
  if (!/^sha256:[a-f0-9]{64}$/.test(note_id) || !/^sha256:[a-f0-9]{64}$/.test(text_digest)) {
    fail('DRAFT_ACCEPTANCE_INVALID');
  }
  if (record.accepted) {
    if (record.accepted.note_id !== note_id || record.accepted.text_digest !== text_digest) {
      fail('DRAFT_ALREADY_ACCEPTED');
    }
    return record.accepted;
  }
  record.accepted = { note_id, text_digest, at: new Date().toISOString() };
  writeOutputFileAtomic(
    join(folderFor(root, scope.evidenceDir), `${id}.json`),
    JSON.stringify(record, null, 2) + '\n',
    { mode: 0o600 },
  );
  return record.accepted;
}
function signals(response) {
  const out = [], queue = [response];
  let visited = 0;
  while (queue.length && visited++ < 64) {
    const value = queue.shift();
    if (typeof value === 'string') out.push(value.slice(0, 1024));
    else if (Array.isArray(value)) queue.push(...value.slice(0, 16));
    else if (object(value)) {
      for (const [key, child] of Object.entries(value).slice(0, 24)) {
        if (
          ['error', 'errors', 'message', 'detail', 'msg', 'field', 'param', 'parameter', 'header', 'loc']
            .includes(key) || visited > 1
        ) {
          out.push(key);
          queue.push(child);
        }
      }
    }
  }
  return out.join(' ').slice(0, 8192);
}
const names = (text) => new Set(text.match(/[A-Za-z_][A-Za-z0-9_.-]{0,79}/g) ?? []);
function findings(doc, identity, status, response, request, secrets) {
  const split = identity.operation.indexOf(' '),
    method = identity.operation.slice(0, split),
    path = identity.operation.slice(split + 1),
    node = opNode(doc, method, path);
  if (!node) return [];
  const output = [], responses = Object.keys(node.responses ?? {});
  if (
    responses.length && !responses.some((code) =>
      code === 'default' || code === String(status) ||
      new RegExp(`^${Math.floor(status / 100)}[xX]{2}$`).test(code)
    )
  ) output.push({ kind: 'undeclared-status', status });
  if (![400, 422].includes(status)) return output;
  const text = signals(response),
    mentioned = names(text),
    required = /\b(?:required|missing|must|blank)\b/i.test(text),
    unknown = /\b(?:unknown|unrecognized|unexpected|invalid|unsupported)\b/i.test(text);
  const params = [...(doc.paths?.[path]?.parameters ?? []), ...(node.parameters ?? [])].map((p) =>
    deref(doc, p)
  );
  const bodyNode = deref(doc, node.requestBody),
    schemas = Object.values(bodyNode?.content ?? {}).map((media) => deref(doc, media?.schema)).filter(
      Boolean,
    );
  for (const schema of schemas) {
    for (const name of Object.keys(schema.properties ?? {})) {
      if (
        required && symbol(name, secrets) && mentioned.has(name) && !(schema.required ?? []).includes(name) &&
        !Object.hasOwn(request.body ?? {}, name)
      ) output.push({ kind: 'optional-field-required', status, name });
    }
  }
  for (const param of params) {
    if (
      param?.in === 'query' && param.required !== true && required && symbol(param.name, secrets) &&
      mentioned.has(param.name) && !Object.hasOwn(request.params ?? {}, param.name)
    ) output.push({ kind: 'optional-field-required', status, name: param.name });
  }
  const structured = object(response?.error) ? response.error : response;
  const queryNames = new Set(params.filter((p) => p?.in === 'query').map((p) => p.name));
  const declaredNames = new Set([
    ...params.map((p) => p?.name),
    ...schemas.flatMap((schema) => Object.keys(schema.properties ?? {})),
  ]);
  const parameter = structured?.param ?? structured?.parameter;
  for (
    const name of new Set([
      ...Object.keys(request.params ?? {}),
      ...(typeof parameter === 'string' ? [parameter] : []),
    ])
  ) {
    if (
      (unknown || required && name === parameter) && symbol(name, secrets) && mentioned.has(name) &&
      !(Object.hasOwn(request.params ?? {}, name) ? queryNames : declaredNames).has(name)
    ) output.push({ kind: 'unknown-parameter', status, name });
  }
  // Many APIs name a beta header only in a message. Recognize one header-like
  // token near an explicit requirement, but never copy prose or its value.
  const betaNames = [...mentioned].filter((name) =>
    symbol(name, secrets) && /-/.test(name) && /beta/i.test(name)
  );
  const header = structured?.header ??
    (/\bheader\b/i.test(text) && betaNames.length === 1 ? betaNames[0] : undefined);
  if (
    required && symbol(header, secrets) && /beta/i.test(header) &&
    !params.some((p) =>
      p?.in === 'header' && p.name?.toLowerCase() === header.toLowerCase() && p.required === true
    ) &&
    !Object.keys(request.headers ?? {}).some((name) => name.toLowerCase() === header.toLowerCase())
  ) output.push({ kind: 'required-beta-header', status, name: header });
  return output.slice(0, 5);
}
function publicDraft(record) {
  return {
    id: record.id,
    key: record.key,
    ...(record.operations?.length ? { operations: record.operations } : {}),
    reason: record.reason,
    text: record.text,
    scope: record.scope,
    evidence: record.evidence,
    accept: `${CLI_NAME} note --stack ${record.scope.stack} --env '${
      record.scope.environment.replaceAll("'", "'\\''")
    }' --accept-draft ${record.id}`,
  };
}

export function recordDraftNotes(
  root,
  { identity, contractFile, status, response, request = {}, evidenceDir, runId, secrets = [] } = {},
) {
  if (!identity?.stack || identity.protocol !== 'http' || !evidenceDir || !runId) return {};
  const scope = scopeOf(identity);
  if (Object.values(scope).some((value) => !safe(value, secrets))) return {};
  let contract;
  try {
    contract = readContract(contractFile);
  } catch {
    return {};
  }
  if (hash(contract.raw) !== scope.contract_digest) return {};
  const refs = resolveNoteEvidence([runId], {
    evidenceDir,
    key: { kind: 'operation', op: identity.operation },
    ...evidenceFields(scope),
  });
  if (refs.warnings.length || refs.references[0]?.state !== 'available') return {};
  let candidates = findings(contract.doc, identity, status, response, request, secrets).map((finding) => ({
    key: { kind: 'operation', op: identity.operation },
    finding,
    evidence: [runId],
    references: refs.references,
  }));
  const rawCode = response?.error?.code ?? response?.code,
    code = typeof rawCode === 'number' && Number.isSafeInteger(rawCode) ? String(rawCode) : rawCode;
  if (status >= 400 && (symbol(code, secrets) || typeof code === 'string' && /^\d{1,12}$/.test(code))) {
    const sessionKey = stable({ root: resolve(root), scope, code });
    let session = sessions.get(sessionKey);
    if (!session) {
      if (sessions.size >= 128) sessions.delete(sessions.keys().next().value);
      session = new Map();
      sessions.set(sessionKey, session);
    }
    if (!session.has(identity.operation) && session.size < 16) {
      session.set(identity.operation, { runId, ref: refs.references[0] });
    }
    if (session.size >= 2) {
      const operations = [...session.keys()].sort();
      candidates = [{
        key: { kind: 'stack' },
        operations,
        finding: { kind: 'repeated-error-code', code },
        evidence: operations.map((op) => session.get(op).runId),
        references: operations.map((op) => session.get(op).ref),
      }];
    }
  }
  if (!candidates.length) return {};
  const folder = folderFor(root, evidenceDir);
  safeOutputPath(folder, { directory: true });
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  chmodSync(folder, 0o700);
  const drafts = [];
  let omitted = 0;
  for (const candidate of candidates) {
    let seed = {
      scope,
      key: candidate.key,
      ...(candidate.operations ? { operations: candidate.operations } : {}),
      finding: candidate.finding,
    };
    let id = idFor(seed), file = join(folder, `${id}.json`), record;
    if (existsSync(file)) {
      record = load(folder, id);
      try {
        verifyEvidence(record, evidenceDir);
      } catch (error) {
        if (error.code !== 'DRAFT_EVIDENCE_CHANGED') throw error;
        // A missing/changed first snapshot cannot silently acquire a new run.
        // Retain the refused original and bind a successor to these exact bytes.
        seed = { ...seed, snapshot_digest: hash(stable(candidate.references.map((ref) => ref.digest))) };
        id = idFor(seed);
        file = join(folder, `${id}.json`);
        record = undefined;
        if (existsSync(file)) {
          record = load(folder, id);
          verifyEvidence(record, evidenceDir);
        }
      }
    }
    if (!record) {
      if (readdirSync(folder).filter((name) => /^draft-[a-f0-9]{64}\.json$/.test(name)).length >= 200) {
        omitted++;
        continue;
      }
      record = {
        v: 1,
        id,
        ...seed,
        reason: candidate.finding.kind,
        text: generatedText(candidate.finding, scope, candidate.operations),
        evidence: candidate.evidence,
        references: candidate.references,
        created_at: new Date().toISOString(),
      };
      validate(record);
      verifyEvidence(record, evidenceDir);
      if (secrets.some((value) => typeof value === 'string' && value && stable(record).includes(value))) {
        omitted++;
        continue;
      }
      safeOutputPath(file);
      try {
        writeFileSync(file, JSON.stringify(record, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        record = load(folder, id);
        verifyEvidence(record, evidenceDir);
      }
    }
    if (!record.accepted) drafts.push(publicDraft(record));
  }
  return {
    ...(drafts.length ? { draft_notes: drafts } : {}),
    ...(omitted ? { draft_notes_omitted: omitted } : {}),
  };
}
