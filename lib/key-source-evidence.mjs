// Links path and query keys to the earlier response fields that supplied them,
// by reading private execution evidence under the shared evidence rules
// (lib/note-evidence.mjs) and applying the pure rules in lib/key-sources.mjs.
//
// Two callers. The HTTP capture path links one request: its own evidence names
// the concrete URL, and the newest earlier run files are examined (at most 256,
// any scope), of which the first 64 in the same provider and environment are
// searched, within a file-size bound and a time budget that starts before the
// directory listing; over budget, or any read problem, records nothing for that
// request and never fails it. The `context keys` backfill replays the same
// window over existing evidence, chronologically, and records links additively.
// Where the bound contract describes a parameter or a response field, its rules
// apply: a pinned parameter never links, a pinned field is never a source, and
// a declared property name is kept in field paths.
//
// Values are compared in memory. Results, reports and errors carry names,
// operations, dates, counts and evidence identities only.
import { lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';
import { KEY_SOURCE_BOUNDS, RUN_ID, deriveParameterValues, fieldValues, carriedValues, chooseSources,
  mergeKeySources, storedKeySources, validOperation } from './key-sources.mjs';
import { CONTEXT_VERSION, inspectContext, loadContextSnapshot } from './context.mjs';
import { recordKeySources, storedOperationEntries } from './operation-context.mjs';
import { secretIn } from './verdicts.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const coded = (code, message) => Object.assign(new Error(message), { code });
const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const at = value => Date.parse(value);
const overBudget = () => coded('KEY_SOURCE_BUDGET_EXCEEDED', 'The key-source time budget was exceeded.');
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Evidence runs in the directory, newest file first. Only exact run-file names
// are candidates; other files (binary saves, the view, reports, a writer's
// temporary file) are not runs. With a deadline, the listing itself is
// budgeted: a very large directory gives up within the budget.
function listRuns(opened, { deadline = Infinity, clock = Date.now } = {}) {
  const runs = [];
  let checked = 0;
  for (const name of readdirSync(opened.root)) {
    if ((++checked & 127) === 0 && clock() > deadline) throw overBudget();
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -'.json'.length);
    if (!RUN_ID.test(id) || secretIn(id)) continue;
    let stat;
    try { stat = lstatSync(join(opened.root, name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    runs.push({ id, name, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  if (clock() > deadline) throw overBudget();
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs || byName(a.id, b.id));
}

// The part of an evidence record linking needs. The body stays on `record` so
// a caller can search it and drop it.
function projectRun(entry, record, bytes) {
  const origin = object(record.origin) && record.origin.v === 1 ? record.origin : {};
  const scope = object(origin.scope) ? origin.scope : {};
  const request = object(record.request) ? record.request : {};
  const response = object(record.response) ? record.response : {};
  const string = value => typeof value === 'string' ? value : null;
  return {
    run_id: entry.id, mtimeMs: entry.mtimeMs,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    http: origin.transport === 'api_request:http' && scope.protocol === 'http',
    observed_at: isoTime(origin.observed_at) ? origin.observed_at : null,
    provider: string(scope.provider), environment: string(scope.environment),
    contract_digest: string(scope.contract_digest),
    operation: validOperation(scope.operation) ? scope.operation : null,
    status: Number.isInteger(response.status) ? response.status : null,
    method: string(request.method), url: string(request.url),
    page: record.page_of !== undefined,
  };
}

// Read one run. null: gone, or over the size bound (skipped, not a problem).
// Throws for a read problem: unsafe or changed file, unreadable bytes, invalid
// JSON, a record that is not an object, or a run id that disagrees with its file.
function readRun(opened, entry, bounds) {
  let bytes;
  try { bytes = readEvidenceBytes(opened, entry.name, { maxBytes: bounds.maxEvidenceBytes }); }
  catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'EVIDENCE_TOO_LARGE') return null;
    throw coded(error?.code?.startsWith('EVIDENCE_') ? error.code : 'EVIDENCE_UNREADABLE', 'An evidence file could not be read safely.');
  }
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { throw coded('EVIDENCE_INVALID_JSON', 'An evidence file is not valid JSON.'); }
  if (!object(record)) throw coded('EVIDENCE_INVALID_RECORD', 'An evidence record is not an object.');
  if (record.runId !== undefined && record.runId !== entry.id) throw coded('EVIDENCE_RUN_ID_MISMATCH', 'An evidence run id disagrees with its file.');
  return { meta: projectRun(entry, record, bytes), record };
}

const sameScope = (meta, identity) => meta.http && meta.observed_at !== null
  && meta.provider === identity.provider && meta.environment === identity.environment;

// The parameter values a run used, when it is a linkable request of this
// identity: a first-page HTTP request with a 2xx response, in the identity's
// exact provider, environment, contract and operation, sent with its method.
// A parameter the bound contract pins (enum, boolean, date formats) is dropped.
function consumerCandidates(meta, identity, profile = null) {
  if (!meta.http || meta.page || meta.observed_at === null || !Number.isInteger(meta.status)
    || meta.status < 200 || meta.status > 299 || meta.url === null
    || meta.operation !== identity.operation || meta.provider !== identity.provider
    || meta.environment !== identity.environment || meta.contract_digest !== (identity.contractDigest ?? null)
    || meta.method !== identity.operation.slice(0, identity.operation.indexOf(' '))) return [];
  return deriveParameterValues(meta.url, { operation: identity.operation, endpoint: identity.endpoint })
    .filter(candidate => !profile?.parameterUnlinkable(identity.operation, candidate.location, candidate.param));
}

// A windowed run as chooseSources reads it: where the wanted values appear in
// its response, and which of them its own request carried. With the run's own
// contract profile, declared property names stay names in field paths and
// fields whose schema pins the value are not sources.
function searched(meta, record, wanted, { deadline = Infinity, clock = Date.now, profile = null } = {}) {
  const found = fieldValues(object(record.response) ? record.response.body : undefined,
    { wanted, declaredNames: profile?.declaredNames, deadline, clock });
  const matches = new Map();
  for (const [value, fields] of found) {
    const usable = profile ? fields.filter(field => !profile.fieldUnlinkable(meta.operation, field)) : fields;
    if (usable.length) matches.set(value, usable);
  }
  return { run_id: meta.run_id, digest: meta.digest, observed_at: meta.observed_at, operation: meta.operation,
    status: meta.status, matches, carried: carriedValues(record.request, wanted) };
}

/** Capture-time linking for one HTTP run. Never throws: returns
 * { state, links } where links are bounded, validated key_sources entries for
 * the captured identity, or none. state names why nothing was recorded.
 * `contract` is the bound contract; its rules apply when its digest is the
 * identity's (and, for a source, the source run's). */
export function linkCapturedRun({ evidenceDir, runId, identity, contract = null, env = process.env, clock = Date.now,
  bounds = KEY_SOURCE_BOUNDS } = {}) {
  if (env.API_CONTEXT_OFF === '1') return { state: 'disabled', links: [] };
  const deadline = clock() + bounds.budgetMs;
  const nothing = state => ({ state, links: [] });
  try {
    if (typeof runId !== 'string' || !RUN_ID.test(runId) || identity?.protocol !== 'http'
      || !validOperation(identity.operation) || typeof identity.endpoint !== 'string') return nothing('not-linkable');
    const opened = openEvidenceRoot(evidenceDir);
    if (!opened) return nothing('evidence-missing');
    const listing = listRuns(opened, { deadline, clock });
    const own = listing.find(entry => entry.id === runId);
    if (!own) return nothing('evidence-missing');
    if (own.size > bounds.maxEvidenceBytes) return nothing('evidence-oversized');
    const current = readRun(opened, own, bounds);
    if (!current) return nothing('evidence-oversized');
    const profile = typeof contract?.digest === 'string' && contract.digest === identity.contractDigest ? contract.keyProfile : null;
    const candidates = consumerCandidates(current.meta, identity, profile);
    if (!candidates.length) return nothing('no-keys');
    const wanted = new Set(candidates.map(candidate => candidate.value));
    // The newest run files written before this run's own (any scope; a file
    // written after it cannot be an earlier run and is often another request
    // still in flight), at most examineRuns of them.
    const examined = listing.filter(entry => entry.id !== runId && !entry.id.startsWith(`${runId}-p`)
      && entry.mtimeMs <= own.mtimeMs).slice(0, bounds.examineRuns);
    const window = [];
    for (const entry of examined) {
      if (window.length >= bounds.windowRuns) break;
      if (clock() > deadline) return nothing('over-budget');
      if (entry.size > bounds.maxEvidenceBytes) continue;
      const run = readRun(opened, entry, bounds);
      if (!run || !sameScope(run.meta, identity) || !(at(run.meta.observed_at) < at(current.meta.observed_at))) continue;
      const sourceProfile = run.meta.contract_digest === identity.contractDigest ? profile : null;
      window.push(searched(run.meta, run.record, wanted, { deadline, clock, profile: sourceProfile }));
    }
    if (clock() > deadline) return nothing('over-budget');
    const links = chooseSources(candidates, window).map(link => ({ ...link,
      first_observed_at: current.meta.observed_at, last_observed_at: current.meta.observed_at }));
    if (!links.length) return nothing('no-source');
    return { state: 'linked', links: storedKeySources(mergeKeySources([], links)) };
  } catch (error) {
    return nothing(error?.code === 'KEY_SOURCE_BUDGET_EXCEEDED' ? 'over-budget' : 'evidence-read-problem');
  }
}

const countCode = (counts, code) => { counts[code] = (counts[code] ?? 0) + 1; };

/** The `context keys` backfill: derive links from existing local evidence,
 * chronologically, and record them on existing HTTP operation records.
 * Idempotent; a dry run writes nothing; executes no requests. `contracts` are
 * the configured contracts (their rules apply by digest). Every damaged
 * key_sources list is replaced by the links derived now (none removes the
 * field) and counted in replaced_damaged. Refuses on a damaged store
 * (CONTEXT_INVALID) or API_CONTEXT_OFF=1 (CONTEXT_DISABLED). */
export function backfillKeySources(root, { evidenceDir, dryRun = false, env = process.env, bounds = KEY_SOURCE_BOUNDS,
  contracts = [] } = {}) {
  if (env.API_CONTEXT_OFF === '1')
    throw coded('CONTEXT_DISABLED', 'Shared context is disabled; no evidence was read and nothing was written.');
  const report = { v: 1, state: 'unchanged', dry_run: dryRun, requests_executed: 0,
    meaning: 'Names, operations, dates, counts and evidence identities only. Values were compared in memory and are never recorded or printed. No API requests were executed.',
    evidence: { files: 0, read: 0, oversized: 0, omitted_beyond_limit: 0, unreadable: 0, unreadable_codes: {},
      changed_while_listed: 0, outside_http_scope: 0 },
    runs: { linkable: 0, linked: 0, ambiguous: 0, blocked_by_read_problems: 0 },
    operations: [], changed_operations: 0, replaced_damaged: 0 };
  const state = inspectContext(root);
  if (state.state === 'missing') return { ...report, state: 'no-context' };
  if (state.state !== 'healthy') throw coded('CONTEXT_INVALID', 'The context is damaged.');
  const snapshot = loadContextSnapshot(root);
  if (!snapshot || snapshot.ctx?.v !== CONTEXT_VERSION) throw coded('CONTEXT_INVALID', 'The context is damaged.');
  const stored = storedOperationEntries(snapshot.ctx);
  // A damaged key_sources list is derived data, not store damage.
  const damaged = stored.filter(record => record.keySourcesDamaged).length;
  const records = stored.filter(({ entry }) => entry.identity.protocol === 'http' && typeof entry.identity.endpoint === 'string'
    && validOperation(entry.identity.operation));
  const derived = records.length ? deriveLinks(report, records, { evidenceDir, bounds, contracts })
    : { state: 'no-http-records', linksByOperation: new Map() };
  if (derived.state && !damaged) return { ...report, state: derived.state };
  const { linksByOperation } = derived;

  // What the merge would leave on each record, against the snapshot read above.
  for (const { id, entry, keySourcesDamaged } of stored) {
    const links = linksByOperation.get(id) ?? [];
    if (!links.length && !keySourcesDamaged) continue;
    const before = entry.key_sources ?? [];
    const merged = links.length ? storedKeySources(mergeKeySources(before, links)) : before;
    const changed = keySourcesDamaged || JSON.stringify(merged) !== JSON.stringify(before);
    report.operations.push({ operation_id: id, operation: entry.identity.operation, environment: entry.identity.environment,
      changed, ...(keySourcesDamaged ? { replaced_damaged: true } : {}), key_sources: merged });
  }
  report.operations.sort((a, b) => byName(a.operation, b.operation) || byName(a.environment, b.environment));
  const pending = report.operations.filter(item => item.changed);
  if (dryRun) return { ...report, state: pending.length ? 'would-change' : 'unchanged', changed_operations: pending.length,
    replaced_damaged: pending.filter(item => item.replaced_damaged).length };
  if (!pending.length) return report;
  const { changed, replaced_damaged } = recordKeySources(root, linksByOperation);
  return { ...report, state: changed.length ? 'recorded' : 'unchanged', changed_operations: changed.length,
    replaced_damaged: replaced_damaged.length };
}

// The backfill's derivation: read the evidence, replay the capture window for
// every linkable request and choose sources. Counts go into report.evidence and
// report.runs. Returns { state, linksByOperation }; state names why nothing
// could be derived (no-evidence), otherwise null.
function deriveLinks(report, records, { evidenceDir, bounds, contracts }) {
  const profiles = new Map();
  for (const contract of contracts ?? []) if (typeof contract?.digest === 'string') profiles.set(contract.digest, contract.keyProfile);

  let opened;
  try { opened = openEvidenceRoot(evidenceDir); }
  catch { throw coded('CONTEXT_EVIDENCE_ROOT_UNSAFE', 'The local evidence directory is unsafe.'); }
  if (!opened) return { state: 'no-evidence', linksByOperation: new Map() };
  let listing = listRuns(opened);
  report.evidence.files = listing.length;
  if (listing.length > bounds.backfillRuns) {
    report.evidence.omitted_beyond_limit = listing.length - bounds.backfillRuns;
    listing = listing.slice(0, bounds.backfillRuns);
  }

  // Pass 1: one timeline entry per listed run file, in recorded order (the
  // file time when a file has no readable record time). Bodies are dropped as
  // soon as they are projected.
  const timeline = [], entries = new Map(listing.map(entry => [entry.id, entry]));
  for (const entry of listing) {
    if (entry.size > bounds.maxEvidenceBytes) {
      report.evidence.oversized++;
      timeline.push({ id: entry.id, kind: 'skipped', time: entry.mtimeMs });
      continue;
    }
    let run;
    try { run = readRun(opened, entry, bounds); }
    catch (error) {
      report.evidence.unreadable++;
      countCode(report.evidence.unreadable_codes, error.code);
      timeline.push({ id: entry.id, kind: 'unreadable', time: entry.mtimeMs });
      continue;
    }
    // Gone, or grown past the size bound, since the directory was listed.
    if (!run) {
      report.evidence.changed_while_listed++;
      timeline.push({ id: entry.id, kind: 'skipped', time: entry.mtimeMs });
      continue;
    }
    report.evidence.read++;
    if (!run.meta.http || run.meta.observed_at === null) report.evidence.outside_http_scope++;
    timeline.push({ id: entry.id, kind: 'run', time: run.meta.observed_at !== null ? at(run.meta.observed_at) : entry.mtimeMs, meta: run.meta });
  }
  timeline.sort((a, b) => a.time - b.time || byName(a.id, b.id));

  // Consumers: runs of a recorded identity that carried linkable values. The
  // capture-time window is replayed: walking back through the run files
  // recorded before the consumer (any scope), at most examineRuns of them are
  // examined and the first windowRuns in scope are kept. An unreadable file
  // among those examined links nothing, as at capture time.
  const consumers = [], byOperation = new Map();
  for (const record of records) {
    if (!byOperation.has(record.entry.identity.operation)) byOperation.set(record.entry.identity.operation, []);
    byOperation.get(record.entry.identity.operation).push(record);
  }
  timeline.forEach((item, index) => {
    if (item.kind !== 'run') return;
    const meta = item.meta;
    // consumerCandidates holds the full rule (including: a page file is never linked).
    if (!meta.http || meta.observed_at === null || !meta.operation) return;
    const matching = (byOperation.get(meta.operation) ?? [])
      .map(record => ({ ...record, candidates: consumerCandidates(meta, record.entry.identity, profiles.get(record.entry.identity.contractDigest) ?? null) }))
      .filter(record => record.candidates.length);
    if (matching.length !== 1) {
      if (matching.length > 1) report.runs.ambiguous++;
      return;
    }
    const [{ id, entry, candidates }] = matching;
    report.runs.linkable++;
    const window = [];
    let examined = 0, blocked = false;
    for (let back = index - 1; back >= 0 && examined < bounds.examineRuns && window.length < bounds.windowRuns; back--) {
      const other = timeline[back];
      if (other.id.startsWith(`${meta.run_id}-p`)) continue;
      examined++;
      if (other.kind === 'unreadable') { blocked = true; break; }
      if (other.kind === 'run' && sameScope(other.meta, entry.identity) && at(other.meta.observed_at) < at(meta.observed_at))
        window.push(other.meta);
    }
    if (blocked) { report.runs.blocked_by_read_problems++; return; }
    consumers.push({ meta, id, candidates, window });
  });

  // Pass 2: search each windowed source once, for every consumer that needs it,
  // under the source run's own contract profile.
  const needs = new Map();
  for (const consumer of consumers) for (const source of consumer.window) {
    if (!validOperation(source.operation) || !Number.isInteger(source.status) || source.status < 200 || source.status > 299) continue;
    if (!needs.has(source.run_id)) needs.set(source.run_id, { meta: source, wanted: new Set() });
    for (const candidate of consumer.candidates) needs.get(source.run_id).wanted.add(candidate.value);
  }
  const found = new Map(), changedSources = new Set();
  for (const [runId, { meta, wanted }] of needs) {
    try {
      const run = readRun(opened, entries.get(runId), bounds);
      if (!run || run.meta.digest !== meta.digest) { changedSources.add(runId); continue; }
      found.set(runId, searched(meta, run.record, wanted, { profile: profiles.get(meta.contract_digest) ?? null }));
    } catch { changedSources.add(runId); }
  }

  const linksByOperation = new Map();
  for (const consumer of consumers) {
    if (consumer.window.some(source => changedSources.has(source.run_id))) { report.runs.blocked_by_read_problems++; continue; }
    const window = consumer.window.map(source => found.get(source.run_id)).filter(Boolean);
    const links = chooseSources(consumer.candidates, window).map(link => ({ ...link,
      first_observed_at: consumer.meta.observed_at, last_observed_at: consumer.meta.observed_at }));
    if (!links.length) continue;
    report.runs.linked++;
    if (!linksByOperation.has(consumer.id)) linksByOperation.set(consumer.id, []);
    linksByOperation.get(consumer.id).push(...links);
  }
  return { state: null, linksByOperation };
}

/** A terminal summary of a backfill report: names, dates and counts only. */
export function renderKeySourceReport(report) {
  const lines = [report.dry_run ? 'Path-key sources from local evidence (dry run; nothing written; no requests executed):'
    : 'Path-key sources from local evidence (no requests executed):'];
  if (['no-context', 'no-http-records', 'no-evidence'].includes(report.state)) {
    lines.push(`  ${{ 'no-context': 'No knowledge file here; nothing to link.', 'no-http-records': 'No captured HTTP operation records; nothing to link.',
      'no-evidence': 'No local evidence directory; nothing to link.' }[report.state]}`);
    return lines.join('\n');
  }
  for (const item of report.operations) {
    lines.push(`  ${item.operation} (environment ${item.environment})${item.changed ? (report.dry_run ? ' — would change' : ' — updated') : ''}`
      + `${item.replaced_damaged ? ` (damaged key_sources ${report.dry_run ? 'would be ' : ''}replaced)` : ''}`);
    for (const source of item.key_sources)
      lines.push(`    ${source.param} (${source.location}) ← ${source.source.operation} ${source.source.field}`
        + ` · also seen ${source.also_seen} · ${source.first_observed_at.slice(0, 10)}..${source.last_observed_at.slice(0, 10)}`);
  }
  if (!report.operations.length) lines.push('  No path or query key matched an earlier response field.');
  const { evidence, runs } = report;
  lines.push(`Evidence: ${evidence.files} run file(s); ${evidence.read} read; ${evidence.oversized} over the size bound; `
    + `${evidence.unreadable} unreadable; ${evidence.omitted_beyond_limit} beyond the ${KEY_SOURCE_BOUNDS.backfillRuns}-run limit.`);
  lines.push(`Runs: ${runs.linked} of ${runs.linkable} linkable run(s) linked; ${runs.blocked_by_read_problems} not linked because their window had a read problem.`);
  if (report.replaced_damaged) lines.push(`${report.replaced_damaged} damaged key_sources list(s) ${report.dry_run ? 'would be' : 'were'} `
    + 'replaced by the links derived from local evidence now; a list with none derived is removed.');
  lines.push(report.dry_run ? `${report.changed_operations} operation record(s) would change.`
    : `${report.changed_operations} operation record(s) updated.`);
  return lines.join('\n');
}
