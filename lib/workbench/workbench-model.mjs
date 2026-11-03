// Read models for the Workbench and Map views, and the page's one ledger
// writer, addNote. Everything shown comes from the repository's .sannr files
// through shared readers: stack.json, the ledger (sannr.json), each stack's
// OpenAPI contract, graph/survey.json and run-file metadata. The browser
// receives JSON summaries only: never a response body, header value or request
// input from a run file. Nothing here sends a request.
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { readdirSync, statSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { loadContext, loadContextSnapshot, saveContextNote, provenanceStamp, authorMarker, parseYamlDocument, opNode } from '../context.mjs';
import { buildNoteReviewModel, readReviewOperation, mentionedEnvironments } from '../note-read-model.mjs';
import { stackCatalog, stackScope, assertWritableStack } from '../stacks.mjs';
import { assertStacksWritable, stacksMigrationRequired } from '../stack-migration-state.mjs';
import { refreshNotePointers, containsMachineLocalPath } from '../note-pointers.mjs';
import { noteReviewFailure } from '../note-review-actions.mjs';
import { validateReviewActor } from '../note-reviews.mjs';
import { hasCommentMarkup, BLOCK_TEXT_MAX } from '../block-text.mjs';
import { withStackScope } from '../stack-scope.mjs';
import { resolveConfig } from '../config.mjs';
import { selectContractFile } from '../api-map.mjs';
import { openEvidenceRoot, readEvidenceBytes } from '../note-evidence.mjs';
import { evidenceDirectory } from '../view-records.mjs';
import { validatedNoteObservationContext } from '../operation-context.mjs';
import { readSurvey } from '../survey.mjs';
import { sanitizeEvidenceBody } from '../response-redaction.mjs';
import { safeOutputPath, writeOutputFileAtomic } from '../output-path.mjs';
import { secretIn } from '../verdicts.mjs';
import { LAYOUT } from '../layout.mjs';
import { CLI_NAME, PROSE_PRODUCT_TITLE } from '../brand.mjs';
import { WorkbenchRefusal } from '../workbench-server.mjs';

const clean = value => sanitizeEvidenceBody(value).body;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const portable = value => value.split(sep).join('/');
const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const OPERATION = /^(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|TRACE) \/\S{0,2040}$/u;
const NOTE_ID = /^sha256:[0-9a-f]{64}$/u;
const STACK = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const short = (text, max) => String(text ?? '').length > max ? `${String(text).slice(0, max)}…` : String(text ?? '');
const stringOr = (value, fallback = null) => typeof value === 'string' && value ? value : fallback;
const workbenchDir = root => resolve(root, LAYOUT.evidence, 'workbench');
const refuse = (code, next) => { throw new WorkbenchRefusal(code, next); };
const exact = (params, keys) => {
  if (!plain(params) || Object.keys(params).some(key => !keys.includes(key)))
    refuse('WORKBENCH_PARAMETERS_INVALID', 'Use the documented action fields.');
};
// A note's identity is three strings. '' as the stack means no stack: the
// single-store layout, which the index lists with stack ''.
const noteTarget = params => {
  if (typeof params.operation !== 'string' || !OPERATION.test(params.operation)
    || typeof params.note_id !== 'string' || !NOTE_ID.test(params.note_id)
    || typeof params.stack !== 'string' || (params.stack !== '' && !STACK.test(params.stack)))
    refuse('WORKBENCH_NOTE_INVALID', 'Reload the Workbench and choose a note from the list.');
};
const PRODUCTION_NAME = /^(?:prod|production)$/iu;
const hostOf = value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.host : null; }
  catch { return null; }
};
// Ledger digests may be the full `sha256:<64 hex>` or the 16-hex short form
// that init and learn store; compare on the shorter length, at least 16.
const digestHex = value => typeof value === 'string' ? value.replace(/^sha256:/u, '').toLowerCase() : '';
export function sameContractDigest(a, b) {
  const left = digestHex(a), right = digestHex(b), length = Math.min(left.length, right.length);
  return length >= 16 && /^[0-9a-f]+$/u.test(left) && /^[0-9a-f]+$/u.test(right) && left.slice(0, length) === right.slice(0, length);
}
// One run of each stack scope; a legacy single-store repository has none.
function inStack(root, stack, fn) {
  if (stack === null || stack === undefined || !stackCatalog(root).stacks.length) return fn(null);
  const scope = stackScope(root, { stack });
  return withStackScope(scope, () => fn(scope));
}

// Basis chips are the design's: observed, asserted, local source, rehearsal,
// client, note. A basis recorded in the ledger wins; otherwise the shared
// reader's wording inference applies, then the design's extra phrases.
const BASIS_LABELS = { 'observed-run': 'observed', 'asserted-run': 'asserted', 'local-source': 'local source', 'client-tooling': 'client' };
export const NOTE_BASES = Object.freeze(['observed', 'asserted', 'local source', 'rehearsal', 'client', 'note']);
export function basisLabel(record) {
  const label = BASIS_LABELS[record.basis?.kind];
  if (label) return label;
  if (record.basis?.inferred !== false) {
    const text = String(record.text ?? '').toLowerCase();
    if (text.includes('source inspection')) return 'local source';
    if (text.includes('browser rehearsal')) return 'rehearsal';
    if (text.includes('client observation')) return 'client';
  }
  return 'note';
}
// The ledger's own link state decides the square: every link in scope, some,
// none, or no link at all.
function links(record) {
  return (Array.isArray(record.provenance?.evidence) ? record.provenance.evidence : []).filter(ref => plain(ref) && RUN_ID.test(ref.run_id ?? ''));
}
export function evidenceState(record) {
  const refs = links(record);
  if (!refs.length) return 'none';
  const mismatched = refs.filter(ref => ref.state === 'scope_mismatch').length;
  return mismatched === refs.length ? 'mismatch' : mismatched ? 'partial' : 'ok';
}
function statedEnvironment(record) {
  return stringOr(links(record)[0]?.scope?.environment);
}

// Contracts are parsed once per file revision; large vendor contracts are
// read only when a stack has notes or a trace asks for them.
const contractCache = new Map();
function readContractDocument(file) {
  try {
    const stat = statSync(file), key = `${file}:${stat.size}:${stat.mtimeMs}`;
    if (contractCache.has(key)) return contractCache.get(key);
    const opened = openEvidenceRoot(dirname(file));
    if (!opened) return null;
    const bytes = readEvidenceBytes(opened, basename(file), { maxBytes: 8 * 1024 * 1024 });
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const doc = /^\s*[{[]/u.test(text) ? JSON.parse(text) : parseYamlDocument(text, { maxDepth: 64, strictDepth: true });
    for (const old of contractCache.keys()) if (old.startsWith(`${file}:`)) contractCache.delete(old);
    if (contractCache.size > 16) contractCache.delete(contractCache.keys().next().value);
    contractCache.set(key, plain(doc) ? doc : null);
    return contractCache.get(key);
  } catch { return null; }
}
function stackContract(root, ctx) {
  try {
    const file = selectContractFile(root, resolveConfig(root), () => ctx?.api?.contract);
    return file ? readContractDocument(file) : null;
  } catch { return null; }
}
function pointer(doc, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  return ref.slice(2).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((node, key) => plain(node) ? node[key] : undefined, doc) ?? null;
}
function deref(doc, schema, depth = 0) {
  let value = schema;
  for (let hops = 0; plain(value) && typeof value.$ref === 'string' && hops < 8; hops++) value = pointer(doc, value.$ref);
  return depth > 8 ? null : value;
}
// Success-body fields as the design reads them: properties and required names
// through $ref, oneOf, anyOf and allOf.
function schemaFields(doc, schema, out = { names: new Map() }, depth = 0) {
  const value = deref(doc, schema);
  if (!plain(value) || depth > 6) return out;
  for (const part of [...(value.oneOf ?? []), ...(value.anyOf ?? []), ...(value.allOf ?? [])]) schemaFields(doc, part, out, depth + 1);
  for (const name of Object.keys(plain(value.properties) ? value.properties : {})) if (!out.names.has(name)) out.names.set(name, false);
  for (const name of Array.isArray(value.required) ? value.required : []) if (typeof name === 'string') out.names.set(name, true);
  return out;
}
function contractOperation(doc, operation) {
  if (!doc) return null;
  const space = operation.indexOf(' '), node = opNode(doc, operation.slice(0, space), operation.slice(space + 1));
  if (!plain(node)) return null;
  const responses = plain(node.responses) ? node.responses : {};
  const codes = Object.keys(responses);
  const success = codes.find(code => code.startsWith('2') || code === '101');
  let fields = [];
  if (success) {
    const response = deref(doc, responses[success]) ?? {};
    const schema = plain(response.content) ? Object.values(response.content)[0]?.schema : response.schema;
    if (schema) fields = [...schemaFields(doc, schema).names].map(([name, required]) => ({ name, required }));
  }
  return { operation_id: stringOr(node.operationId), codes, fields: fields.slice(0, 200), fields_total: fields.length,
    tag: Array.isArray(node.tags) && typeof node.tags[0] === 'string' ? node.tags[0] : null };
}
// Group within one stack: the contract's tag, else the first meaningful path
// segment (versions, dates and a leading "api" are skipped).
function groupOf(operation, contract) {
  if (contract?.tag) return contract.tag;
  const path = operation.slice(operation.indexOf(' ') + 1);
  return `/${path.split('/').filter(part => part && !/^(?:v\d+|\d{4}-\d\d-\d\d|api)$/u.test(part))[0] ?? ''}`;
}
function ledgerOperation(entry, operation, contract) {
  const ledgerFields = plain(entry?.fields) ? Object.entries(entry.fields).map(([name, type]) => ({ name, required: Boolean(plain(type) && type.required) })) : [];
  return { operation_id: contract?.operation_id ?? operation,
    codes: contract?.codes?.length ? contract.codes : (Array.isArray(entry?.status_codes) ? entry.status_codes.map(String) : []),
    fields: contract ? contract.fields : ledgerFields.slice(0, 200), fields_total: contract ? contract.fields_total : ledgerFields.length,
    verified_at: stringOr(entry?.verified_at), source_file: stringOr(entry?.source_file) };
}
// Shared observations by the run file they cite, newest first.
function observationsByRun(ctx, stack) {
  const byRun = new Map(), byOperation = new Map();
  let entries = [];
  try { entries = Object.values(validatedNoteObservationContext(ctx).api_context.operations); } catch { entries = []; }
  for (const entry of entries) {
    if ((entry.identity?.stack ?? null) !== (stack ?? null) && entry.identity?.stack !== undefined) continue;
    for (const row of entry.observations ?? []) {
      const summary = { outcome: row.outcome, response_status: Number.isInteger(row.response_status) ? row.response_status : null,
        assertions: plain(row.assertions) ? { passed: row.assertions.passed ?? 0, failed: row.assertions.failed ?? 0 } : null,
        fields: Object.keys(plain(row.response_shape?.properties) ? row.response_shape.properties : {}).slice(0, 100),
        recorded_at: stringOr(row.recorded_at ?? row.observed_at), environment: stringOr(entry.identity?.environment) };
      for (const ref of row.evidence ?? []) {
        const id = basename(String(ref.path ?? '')).replace(/\.json$/u, '');
        if (RUN_ID.test(id) && (!byRun.has(id) || byRun.get(id).recorded_at < summary.recorded_at)) byRun.set(id, summary);
      }
      const operation = entry.identity?.operation, latest = byOperation.get(operation);
      if (operation && (!latest || String(latest.recorded_at) < String(summary.recorded_at))) byOperation.set(operation, summary);
    }
  }
  return { byRun, byOperation };
}
function productionHosts(catalog) {
  return new Set(catalog.stacks.flatMap(item => Object.entries(item.document.environments ?? {})
    .filter(([name, env]) => env.production === true || PRODUCTION_NAME.test(name)).map(([, env]) => hostOf(env.baseUrl))).filter(Boolean));
}
function productionEnvironments(catalog, row) {
  const production = productionHosts(catalog);
  return Object.entries(row?.document.environments ?? {}).filter(([name, env]) => env.production === true
    || PRODUCTION_NAME.test(name) || production.has(hostOf(env.baseUrl))).map(([name]) => name);
}
// The environments a note's verify prompt concerns: those of its stack that the
// note text names (REVIEW-1's shared reader) and every evidence link's scope
// environment. Production is decided as REVIEW-1's verifyPromptFor decides it:
// marked production, named prod or production, or resolving to a production
// host anywhere in the catalog.
function noteEnvironments(root, stack, record, options) {
  const names = [...mentionedEnvironments(record.text ?? '', options?.environmentNames ?? []),
    ...links(record).map(ref => stringOr(ref.scope?.environment)).filter(Boolean)];
  return environmentRows(root, stack, names);
}
// The single store's declared environments, from its committed environments
// file: a bounded read of a regular file, never following a link. A missing,
// oversized or malformed file lists none.
const SINGLE_STORE_CONFIG_BYTES = 256 * 1024;
function singleStoreEnvironments(root) {
  let fd;
  try {
    fd = openSync(resolve(root, LAYOUT.environments), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > SINGLE_STORE_CONFIG_BYTES) return {};
    const bytes = Buffer.alloc(stat.size); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    const environments = JSON.parse(bytes.subarray(0, count).toString('utf8'))?.environments;
    return plain(environments) ? Object.fromEntries(Object.entries(environments).filter(([, env]) => plain(env))) : {};
  } catch { return {}; }
  finally { if (fd !== undefined) closeSync(fd); }
}
// Each named environment of a stack, marked production by the rule above. The
// single store (stack null) passes its own declared environments, whose
// production hosts count as well.
function environmentRows(root, stack, names, declaredEnvironments) {
  const catalog = stackCatalog(root), row = catalog.stacks.find(item => item.name === stack), hosts = productionHosts(catalog);
  const own = declaredEnvironments ?? row?.document.environments ?? {};
  for (const [name, env] of Object.entries(own)) if (env?.production === true || PRODUCTION_NAME.test(name)) { const host = hostOf(env?.baseUrl); if (host) hosts.add(host); }
  return [...new Set(names)].slice(0, 32).map(name => {
    let config = null;
    try { config = stack ? stackScope(root, { stack, environment: name })?.config ?? null : null; } catch { config = null; }
    const declared = Object.hasOwn(own, name) && plain(own[name]) ? own[name] : null;
    const target = hostOf(config?.baseUrl ?? declared?.baseUrl);
    return { name: short(name, 128), production: config?.production === true || declared?.production === true
      || PRODUCTION_NAME.test(name) || Boolean(target && hosts.has(target)) };
  });
}

export const WORKBENCH_INDEX_BYTES = 440 * 1024;
/** Stacks and every active note, with the counts the left column needs. */
export function workbenchIndex(root) {
  const catalog = stackCatalog(root), model = buildNoteReviewModel(root);
  const named = catalog.stacks.length ? catalog.stacks : [{ name: null, document: { environments: {} } }];
  const stacks = [], contracts = new Map();
  for (const row of named) inStack(root, row.name, () => {
    const ctx = loadContext(root), hasNotes = model.records.some(note => (note.stack ?? null) === row.name);
    contracts.set(row.name, { ctx, doc: hasNotes ? stackContract(root, ctx) : null });
    stacks.push({ name: row.name ?? '', title: stringOr(row.document.title) ?? stringOr(ctx?.api?.name) ?? row.name ?? basename(root),
      api_name: stringOr(ctx?.api?.name), environments: Object.keys(row.document.environments ?? {}).slice(0, 32),
      production_environments: productionEnvironments(catalog, row), operations: Object.keys(plain(ctx?.operations) ? ctx.operations : {}).length,
      implemented: Object.values(plain(ctx?.operations) ? ctx.operations : {}).filter(entry => typeof entry?.source_file === 'string' && entry.source_file).length });
  });
  const notes = [], groups = new Map();
  for (const record of model.records) {
    const stack = record.stack ?? null, key = `${stack}\0${record.operation}`;
    if (!groups.has(key)) groups.set(key, groupOf(record.operation, contractOperation(contracts.get(stack)?.doc, record.operation)));
    const text = String(record.text ?? '');
    notes.push({ stack: stack ?? '', operation: record.operation, note_id: record.id, text: short(text, 600), text_shortened: text.length > 600,
      by: stringOr(record.author?.by, 'unknown'), agent: record.author?.category === 'agent', at: stringOr(record.provenance?.at, ''),
      basis: basisLabel(record), state: evidenceState(record), environment: statedEnvironment(record), group: groups.get(key),
      review: record.review?.state && record.review.state !== 'unreviewed' ? short(record.review.label, 200) : null });
  }
  notes.sort((a, b) => b.at.localeCompare(a.at) || a.operation.localeCompare(b.operation) || a.stack.localeCompare(b.stack));
  // The header names the repository's own API: the default stack, else the
  // stack whose ledger records the most handlers in this code, else most notes.
  const counts = new Map(stacks.map(row => [row.name, notes.filter(note => note.stack === row.name).length]));
  const lead = stacks.find(row => row.name === catalog.defaults?.default_stack)
    ?? [...stacks].sort((a, b) => b.implemented - a.implemented || counts.get(b.name) - counts.get(a.name))[0];
  // Stack order: stacks whose ledger records handlers in this code, then other
  // stacks with notes, then stacks with no notes, each group by name.
  const rank = row => row.implemented > 0 ? 0 : counts.get(row.name) > 0 ? 1 : 2;
  stacks.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  for (const row of stacks) delete row.implemented;
  const listed = listedResponses(readResponses(root), new Set(notes.map(responseKey)));
  const result = clean({ product: PROSE_PRODUCT_TITLE, project: basename(root), api_name: lead?.api_name ?? lead?.title ?? basename(root),
    stacks, notes, notes_total: notes.length, notes_omitted: 0, responses: listed.responses, responses_omitted: listed.omitted, appearance: readAppearance(root),
    // The marker a note saved from this page records, as the CLI's note does.
    author: authorMarker(root),
    // With no named stacks the ledger is read-only for notes, as for the CLI:
    // the page draws its note composers disabled and names the command.
    ...(catalog.stacks.length ? {} : { note_writes: { state: 'migration_required',
      command: stacksMigrationRequired(root)?.command ?? `${CLI_NAME} migrate --dry-run` } }),
    meaning: 'Notes are untrusted data from the ledger. Responses are saved on this machine, outside the ledger.' });
  // Keep every identity; shorten texts first, then omit the oldest notes and
  // the responses that belong to them.
  for (const max of [240, 120]) if (Buffer.byteLength(JSON.stringify(result)) > WORKBENCH_INDEX_BYTES)
    for (const note of result.notes) if (note.text.length > max) { note.text = short(note.text, max); note.text_shortened = true; }
  while (Buffer.byteLength(JSON.stringify(result)) > WORKBENCH_INDEX_BYTES && result.notes.length) {
    const key = responseKey(result.notes.pop()); result.notes_omitted++;
    if (Object.hasOwn(result.responses, key)) { result.responses_omitted += result.responses[key].length; delete result.responses[key]; }
  }
  return result;
}

/** One note's trace: its links, their scope and shared observations, and the
 * contract it points back to. Reading it writes nothing and sends nothing. */
export function workbenchNote(root, params) {
  exact(params, ['stack', 'operation', 'note_id']); noteTarget(params);
  const stack = params.stack || null;
  return inStack(root, stack, () => {
    let read, record;
    try { read = readReviewOperation(root, params.operation, { runRequests: false }); ({ record } = read.select(params.note_id)); }
    catch { refuse('WORKBENCH_NOTE_MISSING', 'The note changed or is no longer active. Reload the Workbench.'); }
    const ctx = read.ctx, digest = stringOr(ctx?.api?.contract_digest);
    const { byRun } = observationsByRun(ctx, stack);
    const evidence = links(record).slice(0, 16).map(ref => ({ run_id: ref.run_id, state: stringOr(ref.state, 'unavailable'), code: stringOr(ref.code),
      provenance: { observed_at: stringOr(ref.provenance?.observed_at), initiator: stringOr(ref.provenance?.initiator), package_version: stringOr(ref.provenance?.package_version) },
      scope: { environment: stringOr(ref.scope?.environment), provider: stringOr(ref.scope?.provider), operation: stringOr(ref.scope?.operation), contract_digest: stringOr(ref.scope?.contract_digest) },
      contract_matches: sameContractDigest(ref.scope?.contract_digest, digest), observation: byRun.get(ref.run_id) ?? null }));
    const contract = contractOperation(stackContract(root, ctx), params.operation);
    const text = String(record.text ?? '');
    return clean({ stack: stack ?? '', operation: params.operation, note_id: params.note_id, text: short(text, 8192), text_shortened: text.length > 8192,
      ledger_digest: digest, environments: noteEnvironments(root, stack, record, read.options), evidence, evidence_omitted: Math.max(0, links(record).length - 16),
      contract: ledgerOperation(read.entry, params.operation, contract),
      review: record.review?.state && record.review.state !== 'unreviewed' ? short(record.review.label, 300) : null });
  });
}

// Run-file metadata for the Map's run counts: id, operation, status and time
// only. Bodies, headers and request inputs are never read into the result.
const RUN_FILE = /^(?:saved-)?run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.json$/u;
function runFiles(root) {
  const runs = [];
  let unreadable = 0, omitted = 0;
  try {
    const opened = openEvidenceRoot(evidenceDirectory(root));
    if (!opened) return { runs, unreadable, omitted };
    const names = readdirSync(opened.root).filter(name => RUN_FILE.test(name)).sort();
    omitted = Math.max(0, names.length - 1500);
    for (const name of names.slice(0, 1500)) {
      try {
        const value = JSON.parse(readEvidenceBytes(opened, name, { maxBytes: 4 * 1024 * 1024 }).toString('utf8'));
        if (!plain(value)) { unreadable++; continue; }
        if (value.kind === 'saved-request-execution') {
          if (RUN_ID.test(value.evidence ?? '')) runs.push({ id: value.evidence, operation: OPERATION.test(value.operation ?? '') ? value.operation : null,
            status: Number.isInteger(value.status) ? value.status : null, at: stringOr(value.executed_at) });
          continue;
        }
        const id = RUN_ID.test(value.runId ?? '') ? value.runId : name.replace(/\.json$/u, '');
        const operation = value.origin?.scope?.operation;
        runs.push({ id, operation: typeof operation === 'string' && OPERATION.test(operation) ? operation : null,
          status: Number.isInteger(value.response?.status) ? value.response.status : null, at: stringOr(value.origin?.observed_at) });
      } catch { unreadable++; }
    }
  } catch { unreadable++; }
  return { runs, unreadable, omitted };
}

const surveyStoreName = catalog => name => !catalog.stacks.length && name === 'legacy' ? '' : name;
const MAP_OPERATIONS = 400;
/** The Map result's byte budget, well under the server's 512 KB response limit. */
export const WORKBENCH_MAP_RESULT_BYTES = 320 * 1024;
/** The Map: contracts, stacks, operations referenced from code, the files that
 * define them and the survey's coverage, from the retained graph/survey.json. */
// The survey commands, as the Map's command table names them. The remap prompt
// runs generate, then status.
const SURVEY_COMMANDS = Object.freeze({ generate: `${CLI_NAME} survey generate`, status: `${CLI_NAME} survey status` });
export function workbenchMap(root) {
  const saved = readSurvey(root), command = SURVEY_COMMANDS.generate, status_command = SURVEY_COMMANDS.status;
  if (saved.state !== 'ready') return { state: saved.state, command, status_command };
  const snapshot = saved.snapshot, catalog = stackCatalog(root);
  const collection = new RegExp(`^${LAYOUT.collection.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}/([^/]+)/`, 'u');
  const contractStacks = new Map();
  for (const row of catalog.stacks) for (const path of [row.document.contract, ...Object.values(row.document.environments ?? {}).map(env => env.contract)])
    if (typeof path === 'string') contractStacks.set(portable(relative(root, resolve(row.folder, path))), row.name);
  // The survey names a single-store repository's one store "legacy" (its
  // contract comes from that store's configuration); the Workbench names it ''
  // (shown as "repository"). The Map takes the Workbench's name, so its notes,
  // runs and "Open on Workbench" join.
  const single = !catalog.stacks.length, storeName = surveyStoreName(catalog);
  const contracts = snapshot.nodes.filter(node => node.kind === 'contract').map(node => ({ id: node.id, path: node.contract,
    stack: storeName(contractStacks.get(node.contract) ?? collection.exec(node.contract)?.[1] ?? (single ? 'legacy' : null)) }));
  const operations = snapshot.nodes.filter(node => node.kind === 'operation').map(node => ({ ...node, stack: storeName(node.stack) }));
  const names = [...new Set([...contracts.map(row => row.stack), ...operations.map(row => row.stack)].filter(name => typeof name === 'string' && (name || single)))]
    .sort((a, b) => a.localeCompare(b));
  const stacks = names.map(name => {
    const mine = operations.filter(row => row.stack === name), referenced = mine.filter(row => row.references?.length).length;
    return { id: `stack:${name}`, name, total: mine.length, referenced, vendor: referenced === 0,
      contract: contracts.find(row => row.stack === name) ?? null };
  });
  const codeStacks = new Set(stacks.filter(row => !row.vendor).map(row => row.name));
  const shown = operations.filter(row => codeStacks.has(row.stack));
  const fileStates = new Map(snapshot.nodes.filter(node => node.kind === 'file').map(node => [node.file, node.state]));
  const notes = buildNoteReviewModel(root).records;
  let unmatchedRuns = 0, runFilesUnreadable = 0;
  const ledger = new Map();
  for (const name of codeStacks) inStack(root, name, () => {
    const ctx = loadContext(root), files = runFiles(root);
    unmatchedRuns += files.runs.filter(run => !run.operation).length; runFilesUnreadable += files.unreadable;
    ledger.set(name, { operations: plain(ctx?.operations) ? ctx.operations : {}, observed: observationsByRun(ctx, name || null).byOperation, files: files.runs });
  });
  const ops = shown.slice(0, MAP_OPERATIONS).map(row => {
    const definition = (row.references ?? []).find(ref => ref.kind === 'definition'), stack = ledger.get(row.stack);
    const runs = new Map();
    for (const note of notes) if ((note.stack ?? '') === row.stack && note.operation === row.operation)
      for (const ref of links(note)) if (!runs.has(ref.run_id)) runs.set(ref.run_id, { id: ref.run_id, mismatch: ref.state === 'scope_mismatch', status: null });
    for (const run of stack?.files ?? []) if (run.operation === row.operation) {
      const known = runs.get(run.id);
      if (known) known.status ??= run.status; else runs.set(run.id, { id: run.id, mismatch: false, status: run.status });
    }
    // A shared observation decides the square; without one, the latest run
    // file's status does (below 400 succeeded, 400 and above errored). A run
    // with neither, a ledger link or a run file without a status, was
    // requested with no result recorded; no run at all is never requested.
    const latest = stack?.observed.get(row.operation);
    const recorded = (stack?.files ?? []).filter(run => run.operation === row.operation && Number.isInteger(run.status))
      .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')) || b.id.localeCompare(a.id))[0];
    const list = [...runs.values()];
    return { id: row.id, key: row.operation, stack: row.stack, file: definition?.file ?? null, file_state: definition?.state ?? null,
      in_ledger: Object.hasOwn(stack?.operations ?? {}, row.operation), runs: list, runs_total: list.length,
      status: latest ? (latest.outcome === 'success' ? 'ok' : 'error') : recorded ? (recorded.status < 400 ? 'ok' : 'error') : list.length ? 'unrecorded' : 'unobserved' };
  });
  const coverage = snapshot.coverage;
  const assemble = (list, omitted) => clean({ state: 'ready', command, status_command, contracts, stacks, operations: list, operations_omitted: omitted,
    files: [...new Set(list.map(op => op.file).filter(Boolean))].map(file => ({ id: `file:${file}`, file,
      state: fileStates.get(file) ?? 'unknown', operations: list.filter(op => op.file === file).map(op => op.key) })),
    coverage: { scanned: coverage.scanned_files, eligible: coverage.eligible_files, omissions: coverage.omissions?.length ?? 0,
      truncated: coverage.truncated === true, relationships: snapshot.relationships.length,
      vendor_hidden: operations.length - shown.length, vendor_stacks: stacks.filter(row => row.vendor).length,
      unmatched_runs: unmatchedRuns, run_files_unreadable: runFilesUnreadable,
      built_at: snapshot.snapshot?.built_at ?? null, commit: stringOr(snapshot.source?.base_commit)?.slice(0, 8) ?? null,
      dirty: snapshot.source?.dirty?.tracked ?? null } });
  // Fit the byte budget: trim each operation's run list, then omit operations
  // from the end. runs_total and operations_omitted keep the true counts.
  const fits = value => Buffer.byteLength(JSON.stringify(value)) <= WORKBENCH_MAP_RESULT_BYTES;
  let omitted = Math.max(0, shown.length - MAP_OPERATIONS), result;
  for (const cap of [24, 8, 2, 0]) {
    result = assemble(ops.map(op => ({ ...op, runs: op.runs.slice(0, cap) })), omitted);
    if (fits(result)) return result;
  }
  let kept = ops.map(op => ({ ...op, runs: [] }));
  while (kept.length) {
    const drop = Math.max(1, Math.ceil(kept.length / 8));
    kept = kept.slice(0, -drop); omitted += drop;
    result = assemble(kept, omitted);
    if (fits(result)) return result;
  }
  return result;
}

export const WORKBENCH_OPERATION_BYTES = 96 * 1024;
const OPERATION_RUNS = 16;
// The identity rules the operation view and addNote share: strings, '' for
// the single store, a stack of this repository, and an operation that the
// survey, the contract or the stack's ledger knows. The second step runs in
// the stack's scope.
function operationTarget(root, params) {
  if (typeof params.operation !== 'string' || !OPERATION.test(params.operation)
    || typeof params.stack !== 'string' || (params.stack !== '' && !STACK.test(params.stack)))
    refuse('WORKBENCH_OPERATION_INVALID', 'Reload the Map and choose an operation from it.');
  const catalog = stackCatalog(root), stack = params.stack || null, operation = params.operation;
  if (stack === null ? catalog.stacks.length > 0 : !catalog.stacks.some(row => row.name === stack))
    refuse('WORKBENCH_OPERATION_UNKNOWN', 'That stack is not in this repository. Reload the Map.');
  // The survey's definition reference, under the Map's name for the store.
  const saved = readSurvey(root), storeName = surveyStoreName(catalog);
  const surveyed = saved.state === 'ready' ? saved.snapshot.nodes.find(node => node.kind === 'operation'
    && node.operation === operation && storeName(node.stack) === params.stack) ?? null : null;
  return { catalog, stack, operation, surveyed };
}
function knownOperation(root, { operation, surveyed }) {
  const ctx = loadContext(root), entries = plain(ctx?.operations) ? ctx.operations : {};
  const contract = contractOperation(stackContract(root, ctx), operation), in_ledger = Object.hasOwn(entries, operation);
  if (!surveyed && !contract && !in_ledger) refuse('WORKBENCH_OPERATION_UNKNOWN', 'That operation is not in the survey, the contract or the ledger. Reload the Map.');
  return { ctx, entries, contract, in_ledger };
}
/** One operation that may have no note: where it is defined, its contract,
 * its run files (id, status and time only) with the shared observation that
 * cites each, and every environment of its stack. Reading it writes nothing
 * and sends nothing. The identity follows `note`: '' is the single store. */
export function workbenchOperation(root, params) {
  exact(params, ['stack', 'operation']);
  const target = operationTarget(root, params), { catalog, stack, operation, surveyed } = target;
  const definition = (surveyed?.references ?? []).find(ref => ref.kind === 'definition') ?? null;
  return inStack(root, stack, () => {
    const { ctx, entries, contract, in_ledger } = knownOperation(root, target);
    const { byRun } = observationsByRun(ctx, stack);
    const recorded = runFiles(root).runs.filter(run => run.operation === operation)
      .sort((a, b) => String(b.at ?? '').localeCompare(String(a.at ?? '')) || b.id.localeCompare(a.id));
    const declared = stack ? catalog.stacks.find(item => item.name === stack)?.document.environments ?? {} : singleStoreEnvironments(root);
    const result = clean({ stack: params.stack, operation, in_ledger, file: stringOr(definition?.file), file_state: stringOr(definition?.state),
      contract: ledgerOperation(entries[operation], operation, contract),
      runs: recorded.slice(0, OPERATION_RUNS).map(run => ({ id: run.id, status: run.status, at: run.at, observation: byRun.get(run.id) ?? null })),
      runs_total: recorded.length, environments: environmentRows(root, stack, Object.keys(declared), declared) });
    // Fit the byte bound: shorten observed field lists, then drop the oldest runs.
    const fits = () => Buffer.byteLength(JSON.stringify(result)) <= WORKBENCH_OPERATION_BYTES;
    for (const run of result.runs) if (!fits() && run.observation) run.observation.fields = run.observation.fields.slice(0, 8);
    while (!fits() && result.runs.length) result.runs.pop();
    if (!fits()) result.contract.fields = result.contract.fields.slice(0, 8);
    return result;
  });
}

// Private, gitignored local state beside the existing workbench settings.
function ensurePrivateDirectory(root) {
  const dir = workbenchDir(root);
  safeOutputPath(dir, { directory: true });
  let ignore = '';
  try {
    const opened = openEvidenceRoot(dir);
    if (opened) ignore = readEvidenceBytes(opened, '.gitignore', { maxBytes: 8192 }).toString('utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!ignore.endsWith('*\n!.gitignore\n')) writeOutputFileAtomic(resolve(dir, '.gitignore'),
    `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}*\n!.gitignore\n`, { mkdir: true, mode: 0o600 });
  return dir;
}
function readPrivate(root, name, maxBytes) {
  try {
    const opened = openEvidenceRoot(workbenchDir(root));
    if (!opened) return null;
    return JSON.parse(readEvidenceBytes(opened, name, { maxBytes }).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    refuse('WORKBENCH_LOCAL_STATE_UNSAFE', 'Inspect the local evidence/workbench files, then reload.');
  }
}

const APPEARANCES = ['light', 'dark', 'system'];
export function readAppearance(root) {
  const value = readPrivate(root, 'appearance.json', 1024) ?? {};
  const width = (n, min, max) => Number.isInteger(n) && n >= min && n <= max ? n : null;
  // The design page opens in Light until the operator chooses otherwise.
  return { appearance: APPEARANCES.includes(value.appearance) ? value.appearance : 'light',
    columns: { left: width(value.columns?.left, 220, 600), right: width(value.columns?.right, 260, 680) } };
}
export function setAppearance(root, params) {
  exact(params, ['appearance', 'columns']);
  const current = readAppearance(root), next = { ...current, columns: { ...current.columns } };
  if (params.appearance !== undefined) {
    if (!APPEARANCES.includes(params.appearance)) refuse('WORKBENCH_APPEARANCE_INVALID', 'Choose Light, Dark or System.');
    next.appearance = params.appearance;
  }
  if (params.columns !== undefined) {
    if (params.columns !== null && (!plain(params.columns) || Object.keys(params.columns).some(key => !['left', 'right'].includes(key))))
      refuse('WORKBENCH_COLUMNS_INVALID', 'Send left and right column widths, or null to reset.');
    const check = (n, min, max) => n === null || n === undefined || (Number.isInteger(n) && n >= min && n <= max);
    if (params.columns && (!check(params.columns.left, 220, 600) || !check(params.columns.right, 260, 680)))
      refuse('WORKBENCH_COLUMNS_INVALID', 'Column widths are 220 to 600 pixels on the left and 260 to 680 on the right.');
    next.columns = { left: params.columns?.left ?? null, right: params.columns?.right ?? null };
  }
  const dir = ensurePrivateDirectory(root);
  writeOutputFileAtomic(resolve(dir, 'appearance.json'), `${JSON.stringify(next)}\n`, { mode: 0o600 });
  return next;
}

// Responses are the operator's corrections and annotations. They are kept on
// this machine, outside the ledger, keyed by the note's full identity, until
// an agent writes them back through the product from the Send responses prompt.
// The stored file stays well below the 4 MB read limit; past either bound a
// save is refused before anything is written.
const RESPONSE_TEXT_MAX = 4000, RESPONSES_PER_NOTE = 20, NOTES_WITH_RESPONSES = 2000;
const RESPONSES_READ_BYTES = 4 * 1024 * 1024, RESPONSES_FILE_BYTES = 3 * 1024 * 1024;
export const WORKBENCH_RESPONSES_INDEX_BYTES = 160 * 1024;
const RESPONSES_FULL_NEXT = `The saved responses file is full. After your agent has written the saved responses back to the ledger, remove ${LAYOUT.evidence}/workbench/responses.json, then save again. Nothing was saved.`;
const responseKey = ({ stack, operation, note_id }) => JSON.stringify([stack || '', operation, note_id]);
const validResponseRow = row => plain(row) && typeof row.operation === 'string' && typeof row.note_id === 'string' && NOTE_ID.test(row.note_id)
  && (row.stack === undefined || row.stack === null || typeof row.stack === 'string') && Array.isArray(row.responses);
const validResponses = list => list.filter(item => plain(item) && typeof item.text === 'string' && typeof item.at === 'string').map(item => ({ text: item.text, at: item.at }));
function readResponseRows(root) {
  const value = readPrivate(root, 'responses.json', RESPONSES_READ_BYTES);
  return Array.isArray(value?.notes) ? value.notes : [];
}
/** Every stored response by note key, oldest first. */
export function readResponses(root) {
  const out = {};
  for (const row of readResponseRows(root)) if (validResponseRow(row)) out[responseKey(row)] = [...(out[responseKey(row)] ?? []), ...validResponses(row.responses)];
  return out;
}
// The index carries responses for listed notes only: at most 20 per note and
// at most WORKBENCH_RESPONSES_INDEX_BYTES in all, the most recent kept first.
// Each note's list stays oldest first. Everything else is counted, not sent.
function listedResponses(all, keys) {
  let omitted = 0;
  const candidates = [];
  for (const [key, list] of Object.entries(all)) {
    if (!keys.has(key)) { omitted += list.length; continue; }
    omitted += Math.max(0, list.length - RESPONSES_PER_NOTE);
    list.slice(-RESPONSES_PER_NOTE).forEach((item, order) => candidates.push({ key, item, order }));
  }
  candidates.sort((a, b) => b.item.at.localeCompare(a.item.at) || b.order - a.order);
  const kept = new Map();
  let bytes = 2;
  for (const row of candidates) {
    const size = Buffer.byteLength(JSON.stringify(row.item)) + 1 + (kept.has(row.key) ? 0 : Buffer.byteLength(JSON.stringify(row.key)) + 4);
    if (bytes + size > WORKBENCH_RESPONSES_INDEX_BYTES) { omitted++; continue; }
    bytes += size;
    if (!kept.has(row.key)) kept.set(row.key, []);
    kept.get(row.key).push(row);
  }
  const responses = {};
  for (const [key, rows] of kept) responses[key] = rows.sort((a, b) => a.order - b.order).map(row => row.item);
  return { responses, omitted };
}
export function addResponse(root, params) {
  exact(params, ['stack', 'operation', 'note_id', 'text']); noteTarget(params);
  const text = typeof params.text === 'string' ? params.text.trim() : '';
  if (!text || text.length > RESPONSE_TEXT_MAX || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text))
    refuse('WORKBENCH_RESPONSE_INVALID', `Write between 1 and ${RESPONSE_TEXT_MAX} characters of plain text.`);
  if (secretIn(text, { allowAuthReferences: true }))
    refuse('WORKBENCH_RESPONSE_SECRET', 'The response looks like it contains a credential. Remove it and save again; nothing was saved.');
  // The note must still be active in the ledger; reading it changes nothing.
  inStack(root, params.stack || null, () => {
    try { readReviewOperation(root, params.operation, { runRequests: false }).select(params.note_id); }
    catch { refuse('WORKBENCH_NOTE_MISSING', 'The note changed or is no longer active. Reload the Workbench.'); }
  });
  // Every stored row is kept as it was: the product never deletes a response.
  const rows = readResponseRows(root), key = responseKey(params);
  let row = rows.find(item => validResponseRow(item) && responseKey(item) === key);
  if (!row && rows.filter(validResponseRow).length >= NOTES_WITH_RESPONSES) refuse('WORKBENCH_RESPONSES_FULL', RESPONSES_FULL_NEXT);
  if (!row) rows.push(row = { stack: params.stack, operation: params.operation, note_id: params.note_id, responses: [] });
  row.responses.push({ text, at: new Date().toISOString() });
  const body = `${JSON.stringify({ v: 1, notes: rows })}\n`;
  if (Buffer.byteLength(body) > RESPONSES_FILE_BYTES) refuse('WORKBENCH_RESPONSES_FULL', RESPONSES_FULL_NEXT);
  const dir = ensurePrivateDirectory(root);
  writeOutputFileAtomic(resolve(dir, 'responses.json'), body, { mode: 0o600 });
  return { key, responses: validResponses(row.responses).slice(-RESPONSES_PER_NOTE), ledger_written: false };
}

// A note written by hand on the page. It is the one ledger write the page
// makes, and it goes through the path the CLI's `note --actor person` uses:
// the same stamp, the shared saveContextNote writer and the managed pointer
// refresh. It records one person-authored operation note, never supersedes,
// retires or reviews one, and sends no request.
// The page accepts the characters `note` accepts. The one it refuses, NUL,
// cannot reach the CLI at all: an argument cannot carry it.
const NOTE_CONTROL = /\x00/u;
const NOTE_NEXT = {
  NOTE_ARGUMENTS_REQUIRED: 'Write the note, then save it.',
  NOTE_TOO_LONG: `A note is limited to ${BLOCK_TEXT_MAX} characters. Record what the next reader needs and save again; nothing was saved.`,
  WORKBENCH_NOTE_TEXT_INVALID: 'Remove the NUL character from the note and save again. Nothing was saved.',
  SECRET_IN_NOTE: 'The note looks like it contains a credential. Describe it by its shape (for example, needs a bearer token from the console), not its value. Nothing was saved.',
  MARKUP_IN_NOTE: 'Comment markup (<!-- or -->) cannot enter a note. Describe the behavior without it. Nothing was saved.',
  MACHINE_PATH_IN_OPERATION: 'Name the operation by its method and API path only. Nothing was saved.',
};
const noteRefusal = code => refuse(code, NOTE_NEXT[code]);
export function addNote(root, params) {
  exact(params, ['stack', 'operation', 'text']);
  // As the CLI's note command does, the single-store layout is refused before
  // anything else; a named stack is its own scope and is checked inside it.
  const migration = params.stack === '' ? stacksMigrationRequired(root) : null;
  if (migration) refuse(migration.code, `${migration.message} Nothing was saved.`);
  const target = operationTarget(root, params), { stack, operation } = target;
  if (typeof params.text !== 'string') noteRefusal('NOTE_ARGUMENTS_REQUIRED');
  const text = params.text.trim();
  if (!text) noteRefusal('NOTE_ARGUMENTS_REQUIRED');
  // The CLI's guards, in its order, before anything is read for writing; the
  // page's own control-character bound comes last.
  if (containsMachineLocalPath(operation)) noteRefusal('MACHINE_PATH_IN_OPERATION');
  if ([operation, text].some(field => secretIn(field, { allowAuthReferences: true }))) noteRefusal('SECRET_IN_NOTE');
  if ([operation, text].some(hasCommentMarkup)) noteRefusal('MARKUP_IN_NOTE');
  if (text.length > BLOCK_TEXT_MAX) noteRefusal('NOTE_TOO_LONG');
  if (NOTE_CONTROL.test(text)) noteRefusal('WORKBENCH_NOTE_TEXT_INVALID');
  return inStack(root, stack, scope => {
    knownOperation(root, target);
    let result, stamp;
    try {
      assertWritableStack(scope); assertStacksWritable(root);
      const snapshot = loadContextSnapshot(root);
      if (!snapshot?.ctx) throw Object.assign(new Error('No ledger.'), { code: 'CONTEXT_UNAVAILABLE' });
      // The CLI's stamp for `note --actor person`: the author marker and today,
      // the precise creation time, and the actor. No basis and no evidence.
      stamp = provenanceStamp(root);
      stamp.recorded_at = new Date().toISOString();
      stamp.actor = 'person';
      validateReviewActor(stamp.by, stamp.actor);
      // Beside active authored or unattributed notes the note is saved
      // alongside (`note --alongside`). On a first note the shared writer
      // records nothing for the relation, so the record is the CLI's first note.
      result = saveContextNote(root, snapshot, { key: { kind: 'operation', op: operation }, note: text, stamp, relation: { alongside: true } });
    } catch (error) {
      if (error instanceof WorkbenchRefusal) throw error;
      // An unexpected error becomes NOTE_REVIEW_FAILED with the shared static
      // reason and next step; no exception text reaches the browser.
      const failure = noteReviewFailure(error, { operation, ...(stack ? { stack } : {}) });
      // The single-store layout is read-only for knowledge, as for the CLI;
      // its refusal names the migration command.
      if (failure.refused === 'STACKS_MIGRATION_REQUIRED') refuse(failure.refused, `${error.message} Nothing was saved.`);
      // An unexpected failure cannot promise that nothing was written.
      refuse(failure.refused, `${failure.reason} ${failure.next}${failure.refused === 'NOTE_REVIEW_FAILED' ? '' : ' Nothing was saved.'}`.slice(0, 2000));
    }
    const pointers = refreshNotePointers(root);
    const recorded = result.history?.records.find(record => record.id === result.note_id)?.provenance;
    // The writer may match an existing ledger key that differs by a trailing
    // slash; the returned key names the operation the note is stored under.
    return { key: responseKey({ stack: params.stack, operation: result.key?.op ?? operation, note_id: result.note_id }), note_id: result.note_id,
      by: recorded?.by ?? stamp.by, at: recorded?.at ?? stamp.at, ...(result.unchanged ? { unchanged: true } : {}),
      ...(pointers.state === 'failed' ? { pointers: 'failed',
        pointers_next: 'The note is saved, but the managed instruction blocks were not refreshed. Its text stays under New note on this operation: save it again to retry; it is not saved twice.' } : {}) };
  });
}
