// VIEW-2a: the session ledger. Per host session, what the API client did and
// what it carried, produced and left, built only from local files: the private
// run files and envelope-outcome records in the evidence directories, the
// knowledge files' observations, note history and key-source links, the
// private draft-note folders (ids and reasons only) and the usage log rows the
// client wrote at request time. No request is made and no account is needed.
//
// The promotion boundary holds here as everywhere: the model carries names,
// counts, statuses, codes, ids and timestamps. Request URLs, bodies, headers,
// captured values and messages are never read into it. Stored operation keys
// pass the page's secret scan and read "withheld" when flagged.
//
// Counts are sums over recorded facts, never reconstructions: a call whose
// delivery the usage log did not record says so instead of borrowing a count.
import { basename, join, relative, resolve, sep } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { LAYOUT } from './layout.mjs';
import { CONTEXT_BASENAME, PRODUCT } from './brand.mjs';
import { stackCatalog } from './stacks.mjs';
import { evidenceDirectory } from './view-records.mjs';
import { openEvidenceRoot, readEvidenceBytes, EVIDENCE_INITIATORS } from './note-evidence.mjs';
import { inspectNoteHistory } from './note-history.mjs';
import { projectKeySources, RUN_ID } from './key-sources.mjs';
import { readUsageSources } from './feedback.mjs';
import { scopeToProject } from './receipt.mjs';
import { createWithholder, operationElement } from './api-map.mjs';
import { ENVELOPE_RECORD_ID } from './session-ledger-record.mjs';
import { secretIn } from './verdicts.mjs';
import { operationAnchor } from './operation-anchor.mjs';
import { projectSessionAttention, ATTENTION_BOUND } from './session-attention.mjs';

/** Rows shown per session; the rest are counted by name, never dropped silently. */
export const SESSION_ROW_BOUND = 100;
// One run file larger than this is named as beyond the read bound, not parsed.
const MAX_RUN_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 32 * 1024 * 1024;
const MAX_DRAFT_BYTES = 65536;
export const TOKEN_LABEL = `estimate, ${PRODUCT[0].toUpperCase()}${PRODUCT.slice(1)} envelopes only`;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const CODE = /^[A-Z][A-Z0-9_]{0,95}$/;
const METHOD = /^[A-Z]{1,16}$/;
const STACK = /^[a-z0-9][a-z0-9-]{0,62}$/;
const DRAFT_ID = /^draft-[a-f0-9]{64}$/;
const NOTE_ID = /^sha256:[a-f0-9]{64}$/;
const DRIFT_KIND = /^[a-z][a-z0-9_-]{0,63}$/;
const DRAFT_REASONS = new Set(['undeclared-status', 'optional-field-required', 'unknown-parameter', 'required-beta-header', 'repeated-error-code']);
const PROTOCOLS = new Set(['http', 'graphql', 'jsonrpc', 'grpc', 'websocket']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value, re) => typeof value === 'string' && re.test(value) && !secretIn(value) ? value : null;
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const httpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null;
const runId = value => matches(value, RUN_ID);
const pairs = value => object(value) && count(value.passed) !== null && count(value.failed) !== null
  ? { passed: value.passed, failed: value.failed } : null;
const pad = n => String(n).padStart(2, '0');
/** The local calendar day of an instant, in the reading process's time zone. */
export const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function origin(value) {
  const o = object(value) && value.v === 1 ? value : {};
  return {
    initiator: EVIDENCE_INITIATORS.includes(o.initiator) ? o.initiator : 'unknown',
    observed_at: isoTime(o.observed_at),
    build_id: matches(o.build_id, UUID), session_id: matches(o.session_id, UUID),
    package_version: typeof o.package_version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(o.package_version) && o.package_version.length <= 80 ? o.package_version : null,
  };
}

// --- sources -----------------------------------------------------------------

// The repository's evidence directories: the configured one, and each stack's
// own. A path is shown repository-relative; one outside the project is named
// as such and its location withheld.
function evidenceSources(root, catalog) {
  const seen = new Set(), sources = [];
  const add = (dir, stack) => {
    const path = resolve(dir);
    if (seen.has(path)) return;
    seen.add(path);
    const rel = relative(root, path);
    sources.push({ dir: path, stack, shown: rel && !rel.startsWith('..') && !rel.startsWith(sep) ? rel.split(sep).join('/') : rel === '' ? '.' : 'outside the project (path withheld)' });
  };
  // An unreadable configuration falls back to the standard location.
  let configured;
  try { configured = evidenceDirectory(root); } catch { configured = join(root, LAYOUT.evidence); }
  add(configured, null);
  for (const row of catalog.stacks) add(join(root, LAYOUT.evidence, row.name), row.name);
  return sources;
}

function listJson(opened) {
  try { return readdirSync(opened.root).filter(name => name.endsWith('.json')).sort(); }
  catch { return []; }
}

function readJson(opened, name, maxBytes, issues) {
  try { return JSON.parse(readEvidenceBytes(opened, name, { maxBytes }).toString('utf8')); }
  catch (error) {
    issues[error?.code === 'EVIDENCE_TOO_LARGE' ? 'beyond_read_bound' : 'unreadable'] += 1;
    return undefined;
  }
}

function projectRun(record, stack, name) {
  if (!object(record)) return null;
  const id = runId(record.runId) ?? runId(name.slice(0, -'.json'.length));
  if (!id) return null;
  const scope = object(record.origin?.scope) ? record.origin.scope : {};
  const request = object(record.request) ? record.request : {};
  const response = object(record.response) ? record.response : {};
  const drift = Array.isArray(record.drift) ? record.drift.map(item => matches(item?.kind, DRIFT_KIND) ?? 'unnamed') : [];
  return { type: 'run', run_id: id, stack, page_of: runId(record.page_of), origin: origin(record.origin),
    operation: typeof scope.operation === 'string' && scope.operation.length <= 512 ? scope.operation : null,
    protocol: PROTOCOLS.has(scope.protocol) ? scope.protocol : null,
    method: matches(typeof request.method === 'string' ? request.method.toUpperCase() : null, METHOD),
    status: httpStatus(response.status), drift, assertions: pairs(record.assertions), error: matches(record.error?.code, CODE) };
}

function projectEnvelope(record, stack) {
  if (!object(record) || record.v !== 1 || record.kind !== 'envelope-outcome' || !matches(record.id, ENVELOPE_RECORD_ID)) return null;
  const steps = (Array.isArray(record.steps) ? record.steps : []).filter(object).map(step => ({
    phase: step.phase === 'finally' ? 'cleanup' : 'requests', method: matches(step.method, METHOD),
    protocol: PROTOCOLS.has(step.protocol) ? step.protocol : null, stack: matches(step.stack, STACK) ?? stack,
    run_id: runId(step.evidence), status: httpStatus(step.status), ok: step.ok === true, refused: step.refused === true,
    error: matches(step.error, CODE), assertions: pairs(step.assertions) }));
  return { type: 'envelope', id: record.id, stack: matches(record.stack, STACK) ?? stack, origin: origin(record.origin),
    started_at: isoTime(record.started_at), batch: record.batch === true, attempted: count(record.attempted),
    stopped_early: record.stopped_early === true, refusal: matches(record.refusal, CODE), error: matches(record.error, CODE),
    method: matches(record.method, METHOD), protocol: PROTOCOLS.has(record.protocol) ? record.protocol : null,
    left_behind: count(record.left_behind), steps };
}

function readEvidence(sources) {
  const runs = new Map(), envelopes = [], drafts = new Map();
  const unreadableRuns = [], incompleteEnvelopes = [];
  const issues = { unreadable: 0, beyond_read_bound: 0, unsafe_directories: 0, incomplete_call_records: 0 };
  let runFiles = 0, envelopeFiles = 0, draftFiles = 0;
  for (const source of sources) {
    let opened;
    try { opened = openEvidenceRoot(source.dir); } catch { issues.unsafe_directories += 1; issues.incomplete_call_records += 1; continue; }
    if (!opened) continue;
    source.present = true;
    for (const name of listJson(opened)) {
      const id = name.slice(0, -'.json'.length);
      if (RUN_ID.test(id)) {
        runFiles += 1;
        const run = projectRun(readJson(opened, name, MAX_RUN_BYTES, issues), source.stack, name);
        if (!run) { issues.incomplete_call_records += 1; unreadableRuns.push(id); }
        if (run && !runs.has(run.run_id)) runs.set(run.run_id, run);
      } else if (ENVELOPE_RECORD_ID.test(id)) {
        envelopeFiles += 1;
        const record = readJson(opened, name, MAX_DRAFT_BYTES, issues);
        const envelope = projectEnvelope(record, source.stack);
        if (!envelope) { issues.incomplete_call_records += 1; incompleteEnvelopes.push(origin(record?.origin)); }
        if (envelope) envelopes.push(envelope);
      }
    }
    // Draft suggestions: ids, reasons and the run ids they cite, nothing else.
    let folder;
    try { folder = openEvidenceRoot(join(source.dir, 'draft-notes')); } catch { issues.unsafe_directories += 1; }
    if (folder) for (const name of listJson(folder)) {
      if (!DRAFT_ID.test(name.slice(0, -'.json'.length))) continue;
      draftFiles += 1;
      const record = readJson(folder, name, MAX_DRAFT_BYTES, issues);
      if (!object(record) || !matches(record.id, DRAFT_ID) || !DRAFT_REASONS.has(record.reason) || !Array.isArray(record.evidence)) continue;
      for (const ref of record.evidence) {
        const id = runId(ref);
        if (!id) continue;
        const list = drafts.get(id) ?? [];
        if (!list.some(draft => draft.id === record.id)) list.push({ id: record.id, reason: record.reason });
        drafts.set(id, list);
      }
    }
  }
  return { runs, envelopes, drafts, unreadableRuns, incompleteEnvelopes, issues, files: { runs: runFiles, envelopes: envelopeFiles, drafts: draftFiles } };
}

// What the knowledge files link to a run: the observation captured from it,
// its assertion totals, notes written citing it and key-source links from it.
// A caller that already read the stores (the view) passes them as `contexts`,
// so a page reads each store once.
function readKnowledge(root, catalog, issues, contexts = null) {
  const stores = contexts ?? (catalog.stacks.length ? catalog.stacks.map(row => ({ stack: row.name, path: join(row.folder, CONTEXT_BASENAME) }))
    : [{ stack: null, path: join(root, LAYOUT.context) }]);
  const observations = new Map(), notes = new Map(), keys = new Map(), referenced = [];
  // Note ids that are authored corrections: the replacement side of a
  // supersession link. A correction keeps the original; it is counted apart
  // from an added note, never as a second addition.
  const corrections = new Set();
  const link = (map, id, value) => { const list = map.get(id) ?? []; if (!list.includes(value)) list.push(value); map.set(id, list); };
  const runOfPath = path => typeof path === 'string' ? runId(basename(path).replace(/\.json$/, '')) : null;
  const noteLinks = entry => {
    let history;
    try { history = inspectNoteHistory(entry); } catch { return; }
    for (const record of [...history.active, ...history.history]) {
      const id = matches(record.id, NOTE_ID);
      const refs = Array.isArray(record.provenance?.evidence) ? record.provenance.evidence : [];
      if (id) for (const ref of refs) { const run = runId(ref?.run_id); if (run) link(notes, run, id); }
      const replacement = record.superseded?.kind === 'authored' ? matches(record.superseded.replacement, NOTE_ID) : null;
      if (replacement) corrections.add(replacement);
    }
  };
  let read = 0;
  for (const store of stores) {
    let ctx = store.ctx;
    if (!store.path && !object(ctx)) continue;
    if (store.path) try {
      const text = readFileSync(store.path, 'utf8');
      if (text.length > MAX_STORE_BYTES) { issues.beyond_read_bound += 1; continue; }
      ctx = JSON.parse(text);
    } catch (error) { if (error.code !== 'ENOENT') issues.unreadable += 1; continue; }
    if (!object(ctx)) { issues.unreadable += 1; continue; }
    read += 1;
    for (const entry of Object.values(object(ctx.operations) ? ctx.operations : {})) if (object(entry)) noteLinks(entry);
    if (object(ctx.stack_facts)) noteLinks(ctx.stack_facts);
    const records = object(ctx.api_context?.operations) ? ctx.api_context.operations : {};
    for (const record of Object.values(records)) {
      if (!object(record)) continue;
      for (const observation of Array.isArray(record.observations) ? record.observations : []) {
        if (!object(observation)) continue;
        // Authored operation-context lessons use their saved observation id,
        // not a note-history digest. Count only lessons with retained run
        // evidence, so CLI and MCP summaries share the same attribution.
        const authoredId = observation.basis === 'authored' && Array.isArray(observation.notes) && observation.notes.length
          ? matches(observation.id, UUID) : null;
        for (const ref of Array.isArray(observation.evidence) ? observation.evidence : []) {
          const run = runOfPath(ref?.path);
          if (run && authoredId) link(notes, run, `observation:${authoredId}`);
          if (run) referenced.push({ run_id: run, stack: store.stack ?? null,
            operation: typeof record.identity?.operation === 'string' && record.identity.operation.length <= 512 ? record.identity.operation : null,
            at: isoTime(observation.observed_at), id: matches(observation.id, UUID),
            // External/authored claims remain claims; only retained client
            // observation metadata supplies execution outcomes here.
            client_observation: observation.basis === 'observed' && observation.verification === 'client-observation' && observation.source?.kind === 'client',
            status: httpStatus(observation.response_status), assertions: pairs(observation.assertions) });
          if (run && !observations.has(run)) observations.set(run, { id: typeof observation.id === 'string' && observation.id.length <= 128 && !secretIn(observation.id) ? observation.id : null,
            assertions: pairs(observation.assertions) });
        }
      }
      const projected = projectKeySources(record);
      if (projected.state === 'valid') for (const key of projected.key_sources) {
        const run = runId(key.evidence?.run_id);
        if (run) keys.set(run, (keys.get(run) ?? 0) + 1);
      }
    }
  }
  return { observations, notes, keys, corrections, referenced, stores_read: read };
}

// --- sessions ------------------------------------------------------------------

// VIEW2A-Q1. A session is one host process when the evidence names it
// (origin.session_id, one random id per process); a long-lived MCP server that
// spans midnight stays one session with its own start and end. Older evidence
// names only the installed package build, which every process of an install
// shares, so it is grouped by build, host and local day, and evidence with
// neither by host and local day; the header says which.
function sessionKey(o, at) {
  const day = at === null ? 'date not recorded' : localDay(at);
  if (o.session_id) return { key: `process:${o.session_id}`, grouping: 'process', day };
  if (o.build_id) return { key: `build:${o.build_id}:${o.initiator}:${day}`, grouping: 'build-and-day', day };
  return { key: `day:${o.initiator}:${day}`, grouping: 'host-and-day', day };
}
// Call completeness is session-scoped. Shared knowledge citations describe
// historical evidence; they cannot attribute a missing call to this reader.
// Usage and envelopes are local execution witnesses. Legacy usage without a
// session, and unreadable files with no surviving witness, remain uncertain for
// every session. A surviving pagination child can also identify its parent.
function callRecordGaps(evidence, projectRows) {
  const owners = new Map(), expected = new Set();
  const reference = (id, sessionId, required = true) => {
    if (!id) return;
    if (required) expected.add(id);
    const session = matches(sessionId, UUID);
    if (session) {
      const ids = owners.get(id) ?? new Set();
      ids.add(`process:${session}`); owners.set(id, ids);
    }
  };
  for (const row of projectRows) reference(runId(row?.runId), row?.session_id);
  for (const run of evidence.runs.values()) {
    reference(run.run_id, run.origin.session_id, false);
    reference(run.page_of, run.origin.session_id);
  }
  for (const envelope of evidence.envelopes)
    for (const step of envelope.steps) reference(step.run_id, envelope.origin.session_id);
  const missing = new Set([...expected].filter(id => !evidence.runs.has(id)));
  for (const id of evidence.unreadableRuns) missing.add(id);
  const bySession = {};
  let unattributed = evidence.issues.incomplete_call_records - evidence.unreadableRuns.length - evidence.incompleteEnvelopes.length;
  const add = sessions => {
    if (!sessions?.size) { unattributed += 1; return; }
    for (const session of sessions) bySession[session] = (bySession[session] ?? 0) + 1;
  };
  for (const id of missing) add(owners.get(id));
  for (const o of evidence.incompleteEnvelopes) add(o.session_id ? new Set([`process:${o.session_id}`]) : null);
  return { incomplete_call_records_by_session: bySession, unattributed_incomplete_call_records: unattributed };
}

const GROUPING = Object.freeze({
  'process': 'One host process: every call carries the same process session id.',
  'build-and-day': 'Grouped by package build, host and local day because the host process is unknown: this evidence predates process session ids, and one package build is shared by every process of an install.',
  'host-and-day': 'Grouped by host and local day because the host process is unknown: this evidence records neither a process session id nor a package build.',
});

const statusClass = status => status === null ? 'not sent' : `${String(status)[0]}xx`;
const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx', '1xx', 'not sent'];

function emptyTotals() {
  return { calls: 0, sent: 0, status_classes: Object.fromEntries(STATUS_CLASSES.map(key => [key, 0])),
    // calls_failed merges a recorded non-2xx response, a failed assertion and an
    // error without a response into one count per call; calls_unasserted
    // counts calls with no recorded assertions (not a pass).
    calls_failed: 0, calls_unasserted: 0,
    assertions: { passed: 0, failed: 0, calls_asserted: 0 }, notes_delivered: 0, delivery_not_recorded: 0,
    notes_written: 0, notes_corrected: 0, observations_captured: 0, drift_records: 0, drafts_proposed: 0, key_source_links: 0,
    refusals: 0, errors_without_response: 0, unresolved_placeholders: 0, leftovers: 0, leftovers_not_recorded: 0, batches: 0,
    envelope_tokens: { estimate: 0, calls_measured: 0, label: TOKEN_LABEL } };
}

/** One call failed when a non-2xx response was recorded, an assertion failed, or an
 * error ended it without a response. A refusal sent nothing and is counted as
 * a refusal, not a failure. Counted once per call however many reasons apply. */
export const callFailed = row => (row.status !== null && (row.status < 200 || row.status >= 300)) || row.assertions?.failed > 0
  || (row.status === null && !row.left.refusal && row.left.error !== null);

function addRow(totals, row, seen) {
  totals.calls += 1;
  if (row.status !== null) totals.sent += 1;
  totals.status_classes[statusClass(row.status)] = (totals.status_classes[statusClass(row.status)] ?? 0) + 1;
  if (callFailed(row)) totals.calls_failed += 1;
  if (row.assertions) { totals.assertions.passed += row.assertions.passed; totals.assertions.failed += row.assertions.failed; totals.assertions.calls_asserted += 1; }
  // A response with no recorded assertions is an observation, not a pass; a
  // refusal or an error without a response is neither.
  else if (row.status !== null) totals.calls_unasserted += 1;
  if (row.delivered.notes === null) totals.delivery_not_recorded += 1; else totals.notes_delivered += row.delivered.notes;
  if (row.produced.observation) totals.observations_captured += 1;
  totals.drift_records += row.produced.drift.length;
  totals.key_source_links += row.produced.key_source_links;
  for (const id of row.produced.notes_written) if (!seen.notes.has(id)) { seen.notes.add(id); totals.notes_written += 1; }
  for (const id of row.produced.notes_corrected) if (!seen.corrections.has(id)) { seen.corrections.add(id); totals.notes_corrected += 1; }
  for (const draft of row.produced.drafts) if (!seen.drafts.has(draft.id)) { seen.drafts.add(draft.id); totals.drafts_proposed += 1; }
  if (row.left.refusal) totals.refusals += 1;
  else if (row.left.error && row.status === null) totals.errors_without_response += 1;
  if (row.left.error === 'UNRESOLVED_PLACEHOLDER') totals.unresolved_placeholders += 1;
  if (row.envelope_tokens !== null) { totals.envelope_tokens.estimate += row.envelope_tokens; totals.envelope_tokens.calls_measured += 1; }
}

function totalsOf(items) {
  const totals = emptyTotals(), seen = { notes: new Set(), corrections: new Set(), drafts: new Set() };
  for (const item of items) {
    if (item.kind === 'batch') {
      totals.batches += 1;
      // A batch whose record carries no leftover count is named, not zeroed.
      if (item.left_behind === null) totals.leftovers_not_recorded += 1; else totals.leftovers += item.left_behind;
      if (item.refusal) totals.refusals += 1;
      for (const row of item.rows) addRow(totals, row, seen);
    } else addRow(totals, item, seen);
  }
  return totals;
}

const sumTotals = list => {
  const out = emptyTotals();
  const add = (target, source) => {
    for (const [key, value] of Object.entries(source)) {
      if (typeof value === 'number') target[key] += value;
      else if (object(value)) add(target[key], value);
    }
  };
  for (const totals of list) add(out, totals);
  return out;
};

/**
 * Build the ledger model. `since` is an epoch-ms floor or null; `stack` a stack
 * name or null. `rowBound` caps rows per session, with the rest counted.
 */
export function buildSessionLedger(root, { env = process.env, since = null, stack = null, now = Date.now(), rowBound = SESSION_ROW_BOUND, attentionBound = ATTENTION_BOUND, withhold: shared = null, contexts = null } = {}) {
  root = resolve(root);
  // The view passes its own withholder so one key is counted once per page.
  const withhold = shared ?? createWithholder();
  let catalog;
  try { catalog = stackCatalog(root); } catch { catalog = { stacks: [], problems: [] }; }
  const sources = evidenceSources(root, catalog);
  const evidence = readEvidence(sources);
  const knowledgeIssues = { unreadable: 0, beyond_read_bound: 0 };
  const knowledge = readKnowledge(root, catalog, knowledgeIssues, contexts);
  const usage = readUsageSources(undefined, { env });
  const usageByRun = new Map();
  for (const row of usage.rows) { const id = runId(row?.runId); if (id && !usageByRun.has(id)) usageByRun.set(id, row); }

  const operationText = op => typeof op === 'string' && op ? withhold.text('operation-key', op, operationElement(op)) : null;
  const callRow = ({ at, stack: rowStack, run, method, protocol, status, assertions, error, refused, attempted, phase, origin: rowOrigin, envelopeId = null, expectedRunId = null, stepIndex = null }) => {
    const use = run ? usageByRun.get(run.run_id) : undefined;
    const observation = run ? knowledge.observations.get(run.run_id) : undefined;
    const delivered = use && Object.hasOwn(use, 'knownNotes') && count(use.knownNotes) !== null ? use.knownNotes : null;
    const selectedStack = rowStack ?? (use && matches(use.stack, STACK)) ?? null;
    const operation = run ? operationText(run.operation) : null;
    const attribution = run?.origin ?? rowOrigin ?? origin(null);
    return {
      kind: 'call', ...(phase ? { phase } : {}), at, stack: selectedStack,
      operation, operation_anchor: operationAnchor({ stack: selectedStack, operation, method: run?.method ?? method }),
      attribution: { initiator: attribution.initiator, session_id: attribution.session_id, build_id: attribution.build_id },
      method: run?.method ?? method ?? null, protocol: run?.protocol ?? protocol ?? null,
      status: run ? run.status : status ?? null,
      assertions: observation?.assertions ?? run?.assertions ?? assertions ?? null,
      assertions_basis: observation?.assertions ? 'observation' : run?.assertions ? 'run file' : assertions ? 'envelope outcome' : 'not recorded',
      delivered: { notes: delivered, basis: delivered === null ? 'delivery not recorded' : 'usage log',
        by_class: 'not recorded', stack_facts: delivered === null ? null : 'counted with notes; split not recorded',
        // known.account_facts travels beside known.notes; the usage log counts notes only.
        account_facts: 'not recorded' },
      produced: {
        observation: observation ? observation.id ?? 'observation id not recorded' : null,
        drift: run?.drift ?? [], drafts: run ? evidence.drafts.get(run.run_id) ?? [] : [],
        notes_written: run ? knowledge.notes.get(run.run_id) ?? [] : [],
        // The subset of notes_written that supersede an earlier note.
        notes_corrected: run ? (knowledge.notes.get(run.run_id) ?? []).filter(id => knowledge.corrections.has(id)) : [],
        key_source_links: run ? knowledge.keys.get(run.run_id) ?? 0 : 0,
      },
      left: { refusal: refused ? error ?? 'REFUSED' : null, attempted: refused ? attempted ?? 0 : null,
        error: refused ? null : error ?? run?.error ?? null },
      envelope_tokens: use && count(use.envelopeBytes) !== null ? Math.ceil(use.envelopeBytes / 4) : null,
      basis: { run_id: run?.run_id ?? null, envelope_id: envelopeId, expected_run_id: expectedRunId,
        ...(stepIndex !== null ? { step_index: stepIndex } : {}),
        receipt_state: run ? 'available' : expectedRunId ? 'missing' : 'not-created' },
    };
  };

  // Batch steps own their run files: the block replaces the individual rows.
  const claimed = new Set();
  for (const envelope of evidence.envelopes) for (const step of envelope.steps) if (step.run_id) claimed.add(step.run_id);
  const items = [];
  for (const run of evidence.runs.values()) {
    if (run.page_of || claimed.has(run.run_id)) continue;
    const at = run.origin.observed_at;
    items.push({ origin: run.origin, at, row: callRow({ at, stack: run.stack, run }) });
  }
  for (const envelope of evidence.envelopes) {
    const at = envelope.started_at ?? envelope.origin.observed_at;
    if (!envelope.batch) {
      items.push({ origin: envelope.origin, at, row: callRow({ at, stack: envelope.stack, method: envelope.method, protocol: envelope.protocol,
        status: null, refused: Boolean(envelope.refusal), error: envelope.refusal ?? envelope.error, attempted: envelope.attempted,
        origin: envelope.origin, envelopeId: envelope.id }) });
      continue;
    }
    const rows = envelope.steps.map((step, stepIndex) => {
      const run = step.run_id ? evidence.runs.get(step.run_id) : undefined;
      return callRow({ at: run?.origin.observed_at ?? at, stack: run?.stack ?? step.stack, run, method: step.method, protocol: step.protocol,
        status: step.status, assertions: step.assertions, error: step.error, refused: step.refused && !run, attempted: 0,
        phase: step.phase === 'cleanup' ? 'cleanup' : 'requests', origin: envelope.origin, envelopeId: envelope.id,
        expectedRunId: step.run_id, stepIndex });
    });
    items.push({ origin: envelope.origin, at, row: { kind: 'batch', at, envelope_id: envelope.id, stack: envelope.stack,
      attempted: envelope.attempted, stopped_early: envelope.stopped_early, refusal: envelope.refusal,
      left_behind: envelope.left_behind, rows, basis: { envelope_id: envelope.id } } });
  }

  // Filters: rows outside the window or stack go; totals are recomputed.
  const atMs = value => value === null ? null : Date.parse(value);
  const keepRow = row => (since === null || (atMs(row.at) !== null && atMs(row.at) >= since)) && (stack === null || row.stack === stack);
  const filtered = [];
  for (const item of items) {
    if (item.row.kind === 'batch') {
      const rows = item.row.rows.filter(keepRow);
      const keepRefusal = !item.row.rows.length && keepRow(item.row);
      if (rows.length || keepRefusal) filtered.push({ ...item, row: { ...item.row, rows } });
    } else if (keepRow(item.row)) filtered.push(item);
  }

  const groups = new Map();
  for (const item of filtered) {
    const at = atMs(item.at);
    const { key, grouping, day } = sessionKey(item.origin, at);
    const group = groups.get(key) ?? { key, grouping, day, origin: item.origin, hosts: new Set(), items: [] };
    group.hosts.add(item.origin.initiator);
    group.items.push(item);
    groups.set(key, group);
  }
  const order = (a, b) => (atMs(a.at) ?? -Infinity) - (atMs(b.at) ?? -Infinity);
  const attentionSessions = [];
  const sessions = [...groups.values()].map(group => {
    group.items.sort(order);
    const times = group.items.flatMap(item => item.row.kind === 'batch' ? [item.at, ...item.row.rows.map(row => row.at)] : [item.at])
      .filter(Boolean).sort();
    const all = group.items.map(item => item.row);
    attentionSessions.push({ id: group.key, rows: all });
    // The bound keeps the newest rows; a batch block is never split.
    const shown = [];
    let used = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const size = all[i].kind === 'batch' ? Math.max(1, all[i].rows.length) : 1;
      if (used + size > rowBound && shown.length) break;
      shown.unshift(all[i]);
      used += size;
    }
    const rowsIn = list => list.reduce((n, row) => n + (row.kind === 'batch' ? row.rows.length : 1), 0);
    const stacks = [...new Set(all.flatMap(row => row.kind === 'batch' ? [row.stack, ...row.rows.map(r => r.stack)] : [row.stack]).filter(Boolean))].sort();
    return {
      id: group.key, grouping: group.grouping, grouping_basis: GROUPING[group.grouping],
      local_day: group.grouping === 'process' ? null : group.day,
      hosts: [...group.hosts].sort(), build_id: group.origin.build_id, package_version: group.origin.package_version,
      started_at: times[0] ?? null, ended_at: times.at(-1) ?? null, stacks,
      host_telemetry: null,
      totals: totalsOf(all), rows: shown, rows_shown: rowsIn(shown), rows_omitted: rowsIn(all) - rowsIn(shown),
    };
  }).sort((a, b) => (b.ended_at ?? '').localeCompare(a.ended_at ?? '') || a.id.localeCompare(b.id));

  const projectRows = scopeToProject(usage.rows, root);
  const usageOnly = projectRows.filter(row => !runId(row?.runId) || !evidence.runs.has(row.runId)).length;
  // A deleted receipt is not encountered by the directory reader. Retained
  // usage, context, envelope, draft and page records can still name it, but
  // cannot recover every receipt field (including drift and note links).
  // This is a repository-wide diagnostic. Session completeness is scoped
  // separately through local execution witnesses in callRecordGaps.
  const missingRuns = new Set([
    ...projectRows.map(row => runId(row?.runId)),
    ...knowledge.referenced.map(ref => ref.run_id),
    ...knowledge.notes.keys(),
    ...knowledge.keys.keys(),
    ...evidence.envelopes.flatMap(envelope => envelope.steps.map(step => step.run_id)),
    ...evidence.drafts.keys(),
    ...[...evidence.runs.values()].map(run => run.page_of),
  ].filter(id => id && !evidence.runs.has(id)));
  const anyEvidence = evidence.runs.size > 0 || evidence.envelopes.length > 0;
  const model = {
    v: 1, kind: 'session-ledger', generated_at: new Date(now).toISOString(),
    filters: { since: since === null ? null : new Date(since).toISOString(), stack },
    sources: {
      evidence_directories: sources.filter(source => source.present).map(source => source.shown),
      run_files: evidence.files.runs, envelope_records: evidence.files.envelopes, draft_records: evidence.files.drafts,
      knowledge_files: knowledge.stores_read,
      usage_log: { rows_matched_by_run: [...evidence.runs.keys()].filter(id => usageByRun.has(id)).length,
        project_rows_without_evidence: usageOnly, logs: usage.logs.map(log => ({ source: log.source, rows: log.rows })) },
      unreadable_files: evidence.issues.unreadable + knowledgeIssues.unreadable,
      files_beyond_read_bound: evidence.issues.beyond_read_bound + knowledgeIssues.beyond_read_bound,
      unsafe_directories: evidence.issues.unsafe_directories,
      incomplete_call_records: evidence.issues.incomplete_call_records + missingRuns.size,
      ...callRecordGaps(evidence, projectRows),
      incomplete_note_records: knowledgeIssues.unreadable + knowledgeIssues.beyond_read_bound,
    },
    row_bound: rowBound,
    sessions,
    totals: { sessions: sessions.length, ...sumTotals(sessions.map(session => session.totals)) },
    empty: sessions.length ? null : {
      reason: !anyEvidence ? (usageOnly ? 'usage-log-only' : 'no-evidence') : 'filtered-out',
      populate: !anyEvidence
        ? `Calls made through the MCP tool api_request or the request, protocol, learn, suite and verify commands write private run files under ${LAYOUT.evidence}/ (one folder per stack). Each one becomes a row here; nothing is sent to build this ledger.`
        : 'No recorded call matches the filters. Widen --since or choose another --stack.',
    },
  };
  // A clone can retain a shared observation while its private receipt did not
  // travel. Preserve the recorded outcome, with no invented host or session.
  const missing = knowledge.referenced.filter(ref => !evidence.runs.has(ref.run_id) && keepRow(ref));
  const seenMissing = new Set();
  const missingRows = missing.filter(ref => {
    const key = `${ref.stack}\u0000${ref.run_id}`;
    if (seenMissing.has(key)) return false;
    seenMissing.add(key); return true;
  }).map(ref => {
    const operation = operationText(ref.operation);
    return { ...callRow({ at: ref.at, stack: ref.stack, expectedRunId: ref.run_id,
      status: ref.client_observation ? ref.status : null, assertions: ref.client_observation ? ref.assertions : null }),
      operation, operation_anchor: operationAnchor({ stack: ref.stack, operation }),
      assertions_basis: ref.client_observation ? 'retained client observation; receipt unavailable' : 'not recorded',
      basis: { expected_run_id: ref.run_id, observation_id: ref.id, receipt_state: 'missing', source: ref.client_observation ? 'retained client observation' : 'retained claim; execution not verified' } };
  });
  model.needs_attention = projectSessionAttention([...attentionSessions, ...(missingRows.length ? [{ id: null, rows: missingRows }] : [])],
    { bound: attentionBound, sources: model.sources, empty: model.empty });
  model.withheld = shared ? {} : withhold.counts();
  return model;
}
