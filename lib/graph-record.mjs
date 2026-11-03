import { LAYOUT } from './layout.mjs';
// A narrow write path for lessons an agent learned. Capturing prose never
// establishes a passed assertion, a provider endorsement, or an API request.
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { normalizeGraphManifest } from './dependency-graph.mjs';
import { captureOperationContext, captureObservationLesson } from './operation-context.mjs';
import { resolveOutputPath } from './output-path.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';
import { materializeRecordedSnapshot } from './graph-snapshot-write.mjs';
import { CLI_NAME, PRODUCT } from './brand.mjs';
import { loadContextSnapshot, saveContextNote, provenanceStamp } from './context.mjs';
import { resolveNoteEvidence } from './note-evidence.mjs';
import { loadHttpContract } from './http-operation-context.mjs';
import { hasCommentMarkup } from './block-text.mjs';
import { stackCatalog, stackScope, assertWritableStack } from './stacks.mjs';
import { activeStackScopeFor, withStackScope } from './stack-scope.mjs';
import { assertStacksWritable } from './stack-migration-state.mjs';

const MANIFEST = LAYOUT.graphManifest;
const EVIDENCE_EXAMPLE = { path: `${LAYOUT.evidence}/run-example.json`, locator: '/response/body/counts/deployment_events' };
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function refuseWorkstationPath(value) {
  if (/(?:^|[\s"'`(=])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/)/u.test(value))
    fail('GRAPH_PATH_REFUSED', 'Saved lessons must omit absolute workstation paths.');
}
function bounded(value, max, { locator = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f-\x9f\p{Cf}]/u.test(value))
    fail('GRAPH_RECORD_INVALID', 'Use bounded, nonempty text without terminal, Unicode format, or bidi control characters.');
  if (!locator) refuseWorkstationPath(value);
  scanMetadataSecrets(value, 'GRAPH_SECRET_REFUSED');
  return value;
}
function manifestAt(root) {
  let fd;
  try {
    const path = resolveOutputPath(root, join(root, MANIFEST), { fileOnly: true });
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error();
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    if (offset !== stat.size) throw new Error();
    const raw = buffer.subarray(0, offset).toString('utf8');
    return normalizeGraphManifest(JSON.parse(raw));
  } catch (error) {
    if (/^GRAPH_/u.test(error.code ?? '')) throw error;
    fail('GRAPH_MANIFEST_UNREADABLE', 'A valid local graph manifest is required to bind this lesson.');
  } finally { if (fd !== undefined) closeSync(fd); }
}

// Fixed guidance only: filesystem errors and rejected input can contain private
// paths, payloads, or credentials. Never reflect their message or extra fields.
const RECORD_FAILURES = {
  STACKS_MIGRATION_REQUIRED: ['Shared knowledge requires migration into named API stacks.', `${CLI_NAME} migrate --dry-run`],
  STACK_REQUIRED: ['Choose a default API stack before recording this lesson.', `Set default_stack in ${LAYOUT.directory}/defaults.json, then retry in that stack's scope.`],
  GRAPH_EVIDENCE_LOCATOR_INVALID: ['An evidence locator must be a JSON pointer into the saved evidence file.', 'Keep the evidence reference and correct both fields: path is the actual existing file relative to this repository; locator is an optional pointer such as /response/body/counts/deployment_events, never a run ID or dotted field name. Use ~0 for a literal tilde and ~1 for a slash within a property name. Omit locator only to reference the whole file, then retry.'],
  CONTEXT_EVIDENCE_MISSING: ['The referenced evidence file was not found in this repository.', `Locate the existing request evidence artifact in the configured evidence directory (default: ${LAYOUT.evidence}/). Set path to its actual repository-relative filename, such as ${LAYOUT.evidence}/run-example.json, and retry with that evidence. A run ID or response field name alone is not a file path. Do not invent a file or rerun the API request just to repair this reference.`],
  CONTEXT_EVIDENCE_INVALID: ['An evidence reference does not meet the local-file requirements.', 'Use an existing regular file inside this repository, no larger than 64 MiB. Supply its repository-relative path and, when needed, a JSON pointer starting with / in locator. Omit absolute workstation paths from both fields. Keep the evidence reference when correcting it, then retry.'],
  CONTEXT_EVIDENCE_CHANGED: ['Saved evidence no longer matches the source observation.', 'Preserve the observation and changed artifact. Restore the original evidence bytes from a trusted copy before retrying, or record a separately scoped authored claim that explicitly states the evidence is unavailable. Do not refresh its digest or rerun the API merely to repair this link.'],
  GRAPH_OBSERVATION_MISSING: ['No retained local observation matches this reference.', 'Use observation_id from a successful context_capture receipt in this repository. Imported catalog records, private run IDs, disabled or limited captures, and observations removed by retention are not local observation handles. Inspect their source details and use the explicit node/operation form for a separately attributed claim when appropriate; do not invent evidence or rerun the API merely to obtain a handle.'],
  GRAPH_OBSERVATION_AMBIGUOUS: ['More than one retained observation matches this reference.', 'Include the exact operation_id alongside observation_id from the same capture receipt. If that pair is still duplicated, preserve the context and resolve the duplicate identity before recording.'],
  GRAPH_OBSERVATION_UNSUPPORTED: ['The reference is not a retained client observation.', 'Use an observed client record from this repository. For authored, declared, external or imported knowledge, use the explicit node/operation form and attribute the source and uncertainty; do not relabel it as local execution evidence.'],
  GRAPH_OBSERVATION_RETENTION_LIMIT: ['Recording this lesson would remove its source at the history limit.', 'Preserve or export the existing history first. Use the explicit scoped form for a separately attributed historical claim, with its original learning date and available evidence. Do not relabel an unrelated newer observation as the source.'],
  GRAPH_PATH_REFUSED: ['The lesson or evidence reference contains a refused path.', 'Remove absolute workstation paths from the lesson. Evidence must use an existing repository-relative file path without traversal, a URL, or an escaping symlink. Correct the reference and retry.'],
  GRAPH_SECRET_REFUSED: ['The lesson or evidence metadata contains possible credentials.', 'Remove credentials and payload values from the lesson and reference metadata, then retry. Refer to the existing local evidence file; do not paste its response body into the lesson.'],
  GRAPH_RECORD_INVALID: ['The lesson input does not match the recording schema.', 'Provide observation_id and note, optionally operation_id, to reuse a local client observation. Or provide node, operation, and note with optional scope and evidence file references. Omit terminal, Unicode format, and bidi control characters. Do not mix the two forms or supply verification fields.'],
  GRAPH_RECORD_SCOPE_MISSING: ['No configured provider binding matches this lesson scope.', `Retrieve the dependency index and use its exact repository#node, protocol, and environment. Check the existing ${LAYOUT.graphManifest} provider binding before retrying.`],
  GRAPH_RECORD_SCOPE_AMBIGUOUS: ['More than one configured provider binding matches this lesson scope.', 'Use the exact repository#node and specify protocol and environment from the dependency index to select one provider binding, then retry.'],
  GRAPH_BINDING_CONFLICT: ['The graph configuration binds one provider scope to more than one node.', `Preserve existing context and repair the duplicate provider/environment/protocol binding in ${LAYOUT.graphManifest}. A saved observation cannot choose or borrow another provider identity.`],
  GRAPH_MANIFEST_UNREADABLE: ['The local graph manifest could not be read as valid configuration.', `Inspect the existing ${LAYOUT.graphManifest} and its provider bindings. Repair only the demonstrated configuration problem, then retry without replacing recorded context.`],
  GRAPH_CONTEXT_DISABLED: ['Graph context recording is disabled in this binding.', 'Use a binding where the team has enabled graph context recording. Preserve the learned fact and its evidence for that binding.'],
  CONTEXT_INVALID: ['The existing context file is damaged or invalid.', `Preserve ${LAYOUT.context} and inspect or restore its valid contents before retrying. Do not overwrite the existing context to save this lesson.`],
  CONTEXT_VERSION_UNSUPPORTED: ['The existing context version is unsupported by this client.', `Preserve ${LAYOUT.context} and use a client that supports its format before retrying.`],
  CONTEXT_CAPACITY_REACHED: ['The context storage limit was reached.', 'Preserve existing context and review its storage with the maintainer before retrying. Do not silently discard prior lessons.'],
  CONTEXT_WRITE_CONFLICT: ['Another writer changed the context before this write completed.', 'Read the current context and retry this additive lesson with its original evidence references.'],
  GRAPH_RECORD_FAILED: ['The lesson could not be recorded.', 'Check the local recording configuration and filesystem access, preserve the lesson and its evidence references, and retry after resolving the reported local issue.'],
};
export function graphRecordFailure(error) {
  if (new Set(['NOTE_RELATION_REQUIRED', 'NOTE_INPUT_INVALID', 'NOTE_KEY_INVALID', 'NOTE_KEY_UNSUPPORTED', 'NOTE_OPERATIONS_INVALID', 'NOTE_HISTORY_INVALID', 'NOTE_HISTORY_CHANGED', 'NOTE_HISTORY_PROTECTED', 'NOTE_BASELINE_REQUIRED', 'NOTE_RELATION_INVALID', 'NOTE_ALREADY_SUPERSEDED', 'NOTE_NOT_FOUND', 'NOTE_SELF_SUPERSESSION']).has(error?.code))
    return { error: { code: error.code, message: 'The note history refused this change.',
      remediation: `Inspect the selected stack with ${CLI_NAME} show --stack <name> --human --history before retrying. Preserve the old claims; choose alongside or supersedes for a correction.`,
      ...(/^sha256:[a-f0-9]{64}$/.test(error.digest ?? '') ? { digest: error.digest } : {}) }, requests_executed: 0, published: false };
  const code = Object.hasOwn(RECORD_FAILURES, error?.code) ? error.code : 'GRAPH_RECORD_FAILED';
  const [message, remediation] = RECORD_FAILURES[code];
  return { error: { code, message, remediation,
    ...(['GRAPH_EVIDENCE_LOCATOR_INVALID', 'CONTEXT_EVIDENCE_MISSING', 'CONTEXT_EVIDENCE_INVALID'].includes(code)
      ? { evidence_example: { ...EVIDENCE_EXAMPLE }, example_is_placeholder: true } : {}),
  }, requests_executed: 0, published: false };
}

// The stack form joins the ordinary note writer, rather than adding another
// observation ledger. Its evidence remains an attributed link, never proof.
function recordStackFact(root, args) {
  if (Object.keys(args).some(key => !['scope', 'stack', 'note', 'operations', 'evidence', 'alongside', 'supersedes'].includes(key)))
    fail('GRAPH_RECORD_INVALID', 'Stack facts accept stack, scope, note, operations, evidence run IDs and one relationship.');
  bounded(args.stack, 128); bounded(args.note, 1000);
  if (args.operations !== undefined) {
    if (!Array.isArray(args.operations)) fail('GRAPH_RECORD_INVALID', 'operations must be an array.');
    for (const operation of args.operations) bounded(operation, 512);
  }
  if (hasCommentMarkup(args.note)) fail('GRAPH_RECORD_INVALID', 'Comment markup cannot enter managed guidance.');
  if (args.alongside !== undefined && args.alongside !== true || args.alongside && args.supersedes)
    fail('GRAPH_RECORD_INVALID', 'Choose alongside or supersedes.');
  const scope = stackScope(root, { stack: args.stack });
  if (!scope) fail('GRAPH_RECORD_SCOPE_MISSING', 'Create or select a repository stack before recording stack facts.');
  assertWritableStack(scope);
  return withStackScope(scope, () => {
    assertStacksWritable(root);
    const snapshot = loadContextSnapshot(root);
    if (!snapshot) fail('CONTEXT_INVALID', 'Initialize this stack before recording its facts.');
    const stamp = provenanceStamp(root);
    const evidence = resolveNoteEvidence(args.evidence ?? [], { evidenceDir: join(root, scope.evidenceDir),
      operations: args.operations, environment: scope.config.name, provider: scope.config.baseUrl,
      contractDigest: scope.config.contract ? loadHttpContract(scope.config.contract)?.digest : undefined });
    if (evidence.references.length) stamp.evidence = evidence.references;
    const saved = saveContextNote(root, snapshot, { key: { kind: 'stack' }, note: args.note, operations: args.operations,
      stamp, relation: args.supersedes ? { supersedes: args.supersedes } : args.alongside ? { alongside: true } : undefined });
    const record = saved.history.records.find(record => record.id === saved.note_id);
    return { key: saved.key, stack: scope.stack, note_id: saved.note_id, unchanged: saved.unchanged,
      evidence: record?.provenance?.evidence ?? [], evidence_attachment: saved.unchanged ? 'unchanged; requested references were not attached' : 'only the supplied references; previous evidence is not inherited',
      ...(evidence.warnings.length ? { [saved.unchanged ? 'requested_evidence_warnings' : 'evidence_warnings']: evidence.warnings } : {}),
      requests_executed: 0, published: false, basis: 'authored', verification: 'external-claim',
      next: `The next request reads this fact. Run ${CLI_NAME} connect to refresh managed instruction blocks; graph snapshots do not yet carry stack facts.` };
  });
}

export function recordGraphContext(root, args) {
  if (process.env.API_CONTEXT_OFF === '1') fail('GRAPH_CONTEXT_DISABLED', 'Graph context is disabled by API_CONTEXT_OFF.');
  if (object(args) && args.scope === 'stack') return recordStackFact(root, args);
  // The existing CLI/MCP lesson surface has no stack selector. Resolve the
  // same repository default as other local writes; never search across APIs
  // for an observation or guess a stack from authored prose.
  if (!activeStackScopeFor(root) && stackCatalog(root).stacks.length)
    return withStackScope(stackScope(root), () => recordGraphContext(root, args));
  assertStacksWritable(root);
  if (!object(args) || Object.keys(args).some(key => !['node', 'operation', 'note', 'protocol', 'environment', 'evidence', 'observed_at', 'observation_id', 'operation_id'].includes(key)))
    fail('GRAPH_RECORD_INVALID', 'Provide a node, operation and one reusable lesson, with optional scope and evidence references.');
  if (Object.hasOwn(args, 'observation_id')) {
    if (Object.keys(args).some(key => !['observation_id', 'operation_id', 'note'].includes(key)))
      fail('GRAPH_RECORD_INVALID', 'An observation reference already supplies scope, learning time and evidence; do not override them.');
    bounded(args.observation_id, 512); bounded(args.note, 1000);
    if (Object.hasOwn(args, 'operation_id') && (typeof args.operation_id !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(args.operation_id)))
      fail('GRAPH_RECORD_INVALID', 'operation_id must be the exact digest returned with the observation.');
    const receipt = captureObservationLesson(root, args, { resolveScope(identity) {
      const manifest = manifestAt(root);
      const matches = (manifest.context?.providers ?? []).filter(binding => ['provider', 'environment', 'protocol'].every(key => binding[key] === identity[key]));
      if (matches.length !== 1) fail(matches.length ? 'GRAPH_RECORD_SCOPE_AMBIGUOUS' : 'GRAPH_RECORD_SCOPE_MISSING',
        'The original observation must match exactly one explicit provider binding.');
      return { node: matches[0].node, publisher: manifest.repository.id };
    } });
    return recordReceipt(root, receipt);
  }
  if (Object.hasOwn(args, 'operation_id')) fail('GRAPH_RECORD_INVALID', 'operation_id requires observation_id.');
  const nodeInput = bounded(args.node, 300), operation = bounded(args.operation, 512), note = bounded(args.note, 1000);
  for (const key of ['protocol', 'environment']) if (Object.hasOwn(args, key)) bounded(args[key], 128);
  if (Object.hasOwn(args, 'observed_at') && (typeof args.observed_at !== 'string' || args.observed_at.length > 64
    || !/^\d{4}-\d{2}-\d{2}T/u.test(args.observed_at) || !Number.isFinite(Date.parse(args.observed_at))))
    fail('GRAPH_RECORD_INVALID', 'observed_at must be an ISO timestamp for the original learning.');
  if (Object.hasOwn(args, 'evidence')) {
    if (!Array.isArray(args.evidence) || args.evidence.length > 8) fail('GRAPH_RECORD_INVALID', 'Use at most eight project-local evidence references.');
    for (const ref of args.evidence) {
      if (!object(ref) || Object.keys(ref).some(key => !['path', 'locator'].includes(key))) fail('GRAPH_RECORD_INVALID', 'Evidence accepts a path and optional JSON pointer only.');
      bounded(ref.path, 512);
      if (/^[~/\\]|^[A-Za-z]:|[\\?#]/u.test(ref.path) || !ref.path.split('/').every(part => part && part !== '.' && part !== '..'))
        fail('GRAPH_PATH_REFUSED', 'Evidence paths must be repository-relative.');
      if (Object.hasOwn(ref, 'locator')) {
        bounded(ref.locator, 512, { locator: true });
        // Diagnose a swapped run ID/field name before file resolution obscures
        // the problem with a missing-file error. Validate JSON Pointer escapes.
        if (!ref.locator.startsWith('/') || /~(?![01])/u.test(ref.locator))
          fail('GRAPH_EVIDENCE_LOCATOR_INVALID', 'Evidence locator must be a JSON pointer, not a run ID or dotted field name.');
        // Pointer syntax also accepts workstation paths. Validate promotion
        // safety after naming malformed pointers, before reading any evidence.
        refuseWorkstationPath(ref.locator);
      }
    }
  }
  const manifest = manifestAt(root), node = nodeInput.includes('#') ? nodeInput : `${manifest.repository.id}#${nodeInput}`;
  const bindings = (manifest.context?.providers ?? []).filter(binding => binding.node === node
    && (args.protocol === undefined || binding.protocol === args.protocol)
    && (args.environment === undefined || binding.environment === args.environment));
  if (bindings.length !== 1) fail(bindings.length ? 'GRAPH_RECORD_SCOPE_AMBIGUOUS' : 'GRAPH_RECORD_SCOPE_MISSING',
    `The lesson must match exactly one explicit node/provider/environment/protocol binding in ${LAYOUT.graphManifest}.`);
  const binding = bindings[0];
  const receipt = captureOperationContext(root, {
    identity: { provider: binding.provider, environment: binding.environment, protocol: binding.protocol, operation, endpoint: null, contractDigest: null },
    source: { tool: 'api_context_record' }, basis: 'authored', outcome: 'unknown', complete: false,
    notes: [note], evidence: args.evidence ?? [], ...(args.observed_at ? { observed_at: args.observed_at } : {}),
    omissions: ['Agent-authored lesson; this capture executed no request or verification. Contract applicability has not been established.'],
  }, { internal: false });
  return recordReceipt(root, { ...receipt, node, publisher: manifest.repository.id });
}

function recordReceipt(root, receipt) {
  const snapshot = materializeRecordedSnapshot(root, () => manifestAt(root), receipt);
  return { ...receipt, basis: 'authored', verification: 'external-claim',
    requests_executed: 0, published: false,
    ...(snapshot.state !== 'not_configured' ? { snapshot } : {}),
    next: snapshot.state === 'not_configured'
      ? `Run ${CLI_NAME} graph export and share the new snapshot through the team Git/CI workflow. Existing catalog copies remain unchanged.`
      : snapshot.next };
}

export function graphRecordTool(root, { env = process.env } = {}) {
  if (env.API_CONTEXT_OFF === '1') return null;
  // Only a validated configured project exposes this write capability.
  let manifest;
  try { manifest = manifestAt(root); } catch { return null; }
  return { name: 'api_context_record', title: 'Save an API lesson',
    description: `Save one reusable API gotcha or correction. For a stack fact use scope=stack, stack and note, optional operations, evidence run IDs, and alongside or supersedes for an existing claim. This shares the CLI note history; no request is executed. Otherwise prefer observation_id and note: ${PRODUCT} attaches the retained local client observation’s exact provider, operation, environment, contract identity, original learning time and evidence after checking its digest. Optionally include operation_id from that same capture receipt. Imported or authored records need the separate explicit node/operation form. Always an unverified authored claim; no API requests or remote publication. Keep credentials and payload values out. For operation lessons, if context.snapshot is configured, refresh that local Git/CI artifact and inspect snapshot.state; remote delivery remains separate. Otherwise export explicitly to share it.`,
    inputSchema: { type: 'object', additionalProperties: false, required: ['note'], oneOf: [
      { required: ['scope', 'stack'], properties: { scope: { const: 'stack' } }, not: { anyOf: ['node', 'operation', 'protocol', 'environment', 'observed_at', 'observation_id', 'operation_id'].map(key => ({ required: [key] })) } },
      { required: ['observation_id'], not: { anyOf: ['node', 'operation', 'protocol', 'environment', 'evidence', 'observed_at', 'scope', 'stack', 'operations', 'supersedes', 'alongside'].map(key => ({ required: [key] })) } },
      { required: ['node', 'operation'], not: { anyOf: ['observation_id', 'operation_id', 'scope', 'stack', 'operations', 'supersedes', 'alongside'].map(key => ({ required: [key] })) } },
    ], properties: {
      scope: { const: 'stack', description: 'Use the shared note history for a fact above one operation.' },
      stack: { type: 'string', maxLength: 128 },
      operations: { type: 'array', maxItems: 256, items: { type: 'string', maxLength: 512 }, description: 'Optional exact operation identities; omit for every operation in the selected stack.' },
      alongside: { type: 'boolean', const: true },
      supersedes: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$' },
      observation_id: { type: 'string', maxLength: 512, description: `Exact observation_id from a successful local context_capture receipt. ${PRODUCT} derives scope, original time and evidence; do not combine this with node, operation, environment, protocol, evidence or observed_at. A private run ID or imported catalog record ID is not a local observation reference.` },
      operation_id: { type: 'string', pattern: '^sha256:[a-f0-9]{64}$', description: 'Optional exact operation_id from the same capture receipt, to disambiguate observation_id. This is a digest, not a method/path.' },
      node: { type: 'string', maxLength: 300, description: 'Exact repository#node from the dependency index.' },
      operation: { type: 'string', maxLength: 512, description: 'Exact operation identity, such as GET /accounts.' },
      note: { type: 'string', maxLength: 1000, description: 'Reusable authored behavior or correction, with applicability and uncertainty. Distinguish the latest applicable observation from dated historical records; historical differences alone do not establish current variability. Identify source/test/local-server findings separately from the configured deployed provider; local tests do not prove deployment equivalence. Attribute tribal knowledge and unverified explanations to their source; execution evidence is optional. No secrets or payloads.' },
      protocol: { type: 'string', maxLength: 128 }, environment: { type: 'string', maxLength: 128 },
      observed_at: { type: 'string', maxLength: 64, description: 'Original learning time in ISO format, if known.' },
      evidence: { type: 'array', maxItems: 16, description: `For scope=stack use up to 16 exact run IDs; otherwise use up to eight references to existing request evidence files. Use the configured evidence directory (default: ${LAYOUT.evidence}/). The saved reference includes a digest; file payload contents are not copied into the lesson. Replace example filenames with the actual artifact.`, examples: [[EVIDENCE_EXAMPLE]], items: { oneOf: [{ type: 'string', pattern: '^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$' }, { type: 'object', additionalProperties: false, required: ['path'], properties: {
        path: { type: 'string', maxLength: 512, description: `Actual existing evidence filename relative to this repository, including its directory and extension. A run ID or response field name is not a path. Example: ${LAYOUT.evidence}/run-example.json; the configured evidence directory may differ.`, examples: [`${LAYOUT.evidence}/run-example.json`] },
        locator: { type: 'string', maxLength: 512, pattern: '^/(?:[^~]|~[01])*$', description: 'Optional JSON pointer inside the evidence file, such as /response/body/counts/deployment_events. Never a run ID or dotted field name. Escape ~ as ~0 and / within a property name as ~1. Omit this field to reference the whole file.', examples: ['/response/body/counts/deployment_events'] },
      } }] } },
    } }, annotations: { readOnlyHint: false, destructiveHint: Boolean(manifest.context?.snapshot), idempotentHint: false, openWorldHint: false } };
}
