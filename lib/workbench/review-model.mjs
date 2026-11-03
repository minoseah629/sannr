// Local Review adapters. Shared note readers decide history, scope and labels;
// the same atomic commands used headlessly own every write. No request runner.
import { createHash } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { loadContext, loadContextSnapshot, saveContextNote, provenanceStamp, parseYamlDocument, opNode } from '../context.mjs';
import { buildNoteReviewModel, reviewLaneSummary, reviewAuthorSummary, readReviewOperation, mentionedEnvironments,
  evidenceExplanation, verifyPromptFor } from '../note-read-model.mjs';
import { decorateNoteRecord, noteCorrectionConflicts, NOTE_DATA_MEANING } from '../note-projection.mjs';
import { recordNoteReview, retireNote, readNoteContext, noteReviewFailure } from '../note-review-actions.mjs';
import { NOTE_DIGEST, normalizeReview, validateReviewActor, validateReviewEvidence, validateReviewText, staleNoteError } from '../note-reviews.mjs';
import { validNoteOperations } from '../note-key.mjs';
import { openEvidenceRoot, readEvidenceBytes, resolveNoteEvidence } from '../note-evidence.mjs';
import { stackCatalog, stackScope, assertWritableStack } from '../stacks.mjs';
import { withStackScope } from '../stack-scope.mjs';
import { assertStacksWritable } from '../stack-migration-state.mjs';
import { resolveConfig } from '../config.mjs';
import { evidenceDirectory } from '../view-records.mjs';
import { loadHttpContract } from '../http-operation-context.mjs';
import { selectContractFile } from '../api-map.mjs';
import { contextShape, validatedNoteObservationContext } from '../operation-context.mjs';
import { inspectRecordedResponse } from '../response-inspection.mjs';
import { sanitizeEvidenceBody } from '../response-redaction.mjs';
import { refreshNotePointers } from '../note-pointers.mjs';

const fail = code => { throw Object.assign(new Error('Refresh Review and select a retained note by its full identity.'), { code }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function exact(params, keys) {
  if (!plain(params) || Object.keys(params).some(key => !keys.includes(key))) fail('NOTE_REVIEW_INVALID');
}
function target(params) {
  if (!validNoteOperations([params.operation]) || !NOTE_DIGEST.test(params.note_id ?? '')) fail('NOTE_REVIEW_INVALID');
  validateReviewText(params.operation);
  if (params.stack !== undefined && (typeof params.stack !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(params.stack))) fail('NOTE_REVIEW_INVALID');
}
function scoped(root, stack, fn, write = false) {
  const scope = stack !== undefined || stackCatalog(root).stacks.length ? stackScope(root, { stack }) : null;
  const run = () => { if (write) { assertWritableStack(scope); assertStacksWritable(root); } return fn(scope); };
  return scope ? withStackScope(scope, run) : run();
}
const identity = row => ({ ...(row.stack == null ? {} : { stack: row.stack }), operation: row.operation, note_id: row.id });
const keyOf = row => JSON.stringify([row.stack ?? null, row.operation, row.note_id ?? row.id]);
const clean = value => sanitizeEvidenceBody(value).body;
const bytes = value => Buffer.byteLength(JSON.stringify(value));
const short = (text, max = 800) => String(text ?? '').length > max ? `${String(text).slice(0, max)}…` : String(text ?? '');

// JSON inspection has an explicit projection receipt, not a silent substring
// that could turn a partial document into purported complete evidence.
function bounded(value, maxBytes = 48000) {
  let omitted = 0, nodes = 0;
  const visit = (item, depth = 0) => {
    if (++nodes > 1500 || depth > 10) { omitted++; return '[omitted]'; }
    if (typeof item === 'string' && item.length > 4000) { omitted++; return short(item, 4000); }
    if (Array.isArray(item)) { omitted += Math.max(0, item.length - 100); return item.slice(0, 100).map(child => visit(child, depth + 1)); }
    if (plain(item)) {
      const entries = Object.entries(item); omitted += Math.max(0, entries.length - 100);
      return Object.fromEntries(entries.slice(0, 100).map(([key, child]) => [key, visit(child, depth + 1)]));
    }
    return item;
  };
  const data = visit(clean(value));
  if (bytes(data) > maxBytes) return { data: null, omitted: omitted + 1, note: 'JSON exceeds this view’s byte bound. Use the local headless reader.' };
  return { data, omitted, note: omitted ? 'Bounded JSON projection; some content is omitted.' : 'Selected local JSON projection; no entries omitted from this projection.' };
}

export function reviewIndex(root, params = {}) {
  exact(params, ['offset', 'limit', 'stack', 'lane', 'state', 'author']);
  const offset = params.offset ?? 0, limit = params.limit ?? 120;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('NOTE_REVIEW_INVALID');
  const model = buildNoteReviewModel(root), catalog = stackCatalog(root);
  const states = ['unreviewed', 'trusted', 'disputed', 'run-requested', 'contradicted-since-trusted'];
  if (params.lane && !model.lanes.some(row => row.id === params.lane)
    || params.state && !states.includes(params.state) || params.author && !model.authors.some(row => row.category === params.author)
    || params.stack !== undefined && !catalog.stacks.some(row => row.name === params.stack) && params.stack !== '') fail('NOTE_REVIEW_INVALID');
  const all = model.records, inStack = all.filter(row => params.stack === undefined || (row.stack ?? '') === params.stack);
  // Each facet counts the notes that match every other active filter, so a
  // chip's count is the result size its click would produce.
  const matches = (row, skip) => (skip === 'lane' || !params.lane || row.lane === params.lane)
    && (skip === 'state' || !params.state || row.review.state === params.state)
    && (skip === 'author' || !params.author || row.author.category === params.author);
  const filtered = inStack.filter(row => matches(row));
  const causes = model.causes.filter(cause => inStack.some(row => row.run_support?.some(ref => ref.cause === cause.id)));
  const records = [], selected = filtered.slice(offset, offset + limit);
  let used = 0;
  for (const row of selected) {
    const item = { ...identity(row), text: short(row.text), text_shortened: String(row.text).length > 800,
      author: row.author, basis: row.basis, lane: row.lane, state: row.review.state,
      label: short(row.review.label), covered: row.run_support?.some(ref => ref.coverage === 'covered' && ref.depth === 'full-run') ?? false,
      correction_suggestion: Boolean(row.correction_suggestion), corrections: row.corrections ?? [],
      ...(row.retirement?.length ? { retirement: { note_id: row.retirement[0].note_id, reason: row.retirement[0].reason, claim: short(row.retirement[0].claim, 120) } } : {}) };
    if ((used += bytes(item)) > 260000) break;
    records.push(item);
  }
  let ledgers = 0;
  const countLedger = () => { if (loadContext(root)) ledgers++; };
  if (catalog.stacks.length) for (const row of catalog.stacks) scoped(root, row.name, countLedger);
  else countLedger();
  // Stack counts, like the other facets, apply every other active filter.
  const stacks = catalog.stacks.map(row => ({ name: row.name, count: all.filter(note => note.stack === row.name && matches(note)).length }));
  if (!catalog.stacks.length && all.length) stacks.push({ name: '', count: all.filter(note => matches(note)).length });
  return clean({ state: !ledgers ? 'no-ledger' : !all.length ? 'no-notes' : 'available', meaning: model.meaning,
    total: all.length, covered: all.filter(row => row.run_support?.some(ref => ref.coverage === 'covered' && ref.depth === 'full-run')).length,
    reviewed: all.filter(row => row.review.state !== 'unreviewed').length,
    trusted: all.filter(row => row.review.state === 'trusted').length,
    scope_total: inStack.length, states: states.map(state => ({ state, count: inStack.filter(row => matches(row, 'state') && row.review.state === state).length })),
    stacks: stacks.slice(0, 100), stacks_omitted: Math.max(0, stacks.length - 100), stacks_total: all.filter(row => matches(row)).length, lanes: reviewLaneSummary(inStack.filter(row => matches(row, 'lane'))),
    authors: model.authors, filter_authors: reviewAuthorSummary(inStack.filter(row => matches(row, 'author'))),
    causes: causes.slice(0, 50), causes_omitted: Math.max(0, causes.length - 50),
    issues: model.issues.slice(0, 20), issues_omitted: Math.max(0, model.issues.length - 20),
    records, filtered_total: filtered.length, offset, next_offset: offset + records.length < filtered.length ? offset + records.length : null,
    omitted: filtered.length - records.length, note: 'Counts cover active operation notes in the retained ledger. Header totals (total, covered, reviewed, trusted, authors) ignore filters. Each facet count applies every other active filter except its own: stack counts and stacks_total apply the state, author and lane filters; state, author and lane counts apply the stack filter and the other two. Common causes follow the stack filter. Review decisions do not upgrade evidence.' });
}

function selectedNote(root, params) {
  target(params);
  const read = readReviewOperation(root, params.operation), { raw, record } = read.select(params.note_id);
  return { ...read, raw, record: { ...identity({ stack: params.stack, operation: params.operation, id: raw.id }), ...record } };
}
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// Run IDs a trusted claim has been contradicted by since its trust decision.
const laterRunIds = record => record.review?.state === 'contradicted-since-trusted'
  ? [...new Set(record.review.contradiction?.evidence ?? [])].filter(id => !(record.run_support ?? []).some(ref => ref.run_id === id)) : [];

// The same prompt builder writes a run request's inbox handoff (see
// note-review-actions). This is data only; no environment is invented from
// the default configuration when the claim itself names none.
export function buildVerifyPrompt(root, params) {
  exact(params, ['stack', 'operation', 'note_id']);
  return scoped(root, params.stack, () => {
    const { record, options } = selectedNote(root, params);
    return verifyPromptFor(root, params, record, options);
  });
}
function shapeNames(shape, prefix = '', names = new Set()) {
  if (shape?.type === 'object') for (const [name, child] of Object.entries(shape.properties ?? {})) {
    names.add(name); names.add(prefix ? `${prefix}.${name}` : name); shapeNames(child, prefix ? `${prefix}.${name}` : name, names);
  }
  if (shape?.type === 'array') for (const child of shape.items ?? []) shapeNames(child, prefix, names);
  return names;
}
function observationFor(ctx, operation, id, stack) {
  return Object.values(validatedNoteObservationContext(ctx).api_context.operations).flatMap(entry =>
    entry.identity.operation === operation && (entry.identity.stack ?? null) === (stack ?? null)
      ? entry.observations.filter(row => row.source.kind === 'client' && row.source.tool === 'api_request:http'
        && row.basis === 'observed' && row.verification === 'client-observation' && row.evidence.some(ref => basename(ref.path) === `${id}.json`))
        .map(row => ({ identity: entry.identity, observation: row })) : []).sort((a, b) => b.observation.observed_at.localeCompare(a.observation.observed_at))[0] ?? null;
}
function privateRun(root, ref, options) {
  if (ref.depth !== 'full-run') return null;
  const expected = options.reviewEvidenceFor(ref.run_id);
  try {
    const opened = openEvidenceRoot(evidenceDirectory(root));
    if (!opened) return null;
    const bytes = readEvidenceBytes(opened, `${ref.run_id}.json`, { maxBytes: 8 * 1024 * 1024 });
    if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== expected.digest) return null;
    const value = JSON.parse(bytes);
    return value.runId === ref.run_id && plain(value.response) ? value : null;
  } catch { return null; }
}
function compareRun(record, ref, run, shared, environmentNames, role = 'attached') {
  const text = String(record.text).slice(0, 2048), rows = [];
  const depth = run ? 'full-run' : shared ? 'ledger-summary' : 'run-id-only';
  // A changed/deleted/oversized file between the two reads cannot inherit the
  // earlier full-run coverage. Ledger comparisons are always qualified.
  const coverage = ref.coverage === 'out-of-scope' ? 'out-of-scope' : run ? ref.coverage : 'unknown';
  const mark = equal => depth === 'run-id-only' ? 'not-checkable' : coverage === 'out-of-scope' ? 'out-of-scope'
    : coverage !== 'covered' ? 'scope-unknown' : equal ? 'matches' : 'differs';
  // A found name establishes presence only; literal equality keeps `matches`.
  const presence = () => { const value = mark(true); return value === 'matches' ? 'present' : value; };
  const status = run?.response?.status ?? shared?.observation.response_status;
  const codes = [...new Set([...text.matchAll(/\b(?:returns?|returned|HTTP|status(?: code)?(?: is|:|=)?)\s+(?:HTTP\s+)?([1-5]\d\d)\b/giu)].map(match => Number(match[1])))].slice(0, 8);
  const qualifiedStatus = /\b(?:if|unless|either|not|never|formerly|previously)\b/iu.test(text);
  for (const code of codes) rows.push({ kind: 'status', claim: `Status mentioned: ${code}`, recorded: Number.isInteger(status) ? String(status) : 'Not retained',
    mark: !Number.isInteger(status) || codes.length > 1 || qualifiedStatus ? 'not-checkable' : mark(code === status) });
  for (const name of mentionedEnvironments(text, environmentNames)) rows.push({ kind: 'environment', claim: name,
    recorded: depth === 'run-id-only' ? 'Not retained' : ref.scope?.environment ?? 'Not retained',
    mark: depth === 'run-id-only' || !ref.scope?.environment ? 'not-checkable' : mark(name === ref.scope.environment) });
  const requestShape = run ? contextShape(run.request?.body).shape : shared?.observation.request_shape;
  const responseShape = run ? contextShape(run.response?.body).shape : shared?.observation.response_shape;
  const req = shapeNames(requestShape), res = shapeNames(responseShape);
  const fields = [...text.matchAll(/\b(request|response)\s+field\s+[`"']?([A-Za-z_][A-Za-z0-9_.-]{0,127})/giu)].slice(0, 16);
  for (const [, direction, name] of fields) {
    const names = direction.toLowerCase() === 'request' ? req : res, present = names.has(name);
    rows.push({ kind: 'field', claim: `${direction.toLowerCase()} field ${name}`, recorded: present ? 'Name present; value not compared' : 'Not found in retained field names',
      mark: present ? presence() : 'not-checkable' });
  }
  // Names mentioned without an explicit request/response direction are only
  // presence comparisons. Never inspect or compare a payload value as prose.
  const named = new Set(fields.map(([, , name]) => name));
  const candidates = new Set([...text.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b|\b[a-z]+[A-Z][A-Za-z0-9]+\b/gu)].map(match => match[0]));
  for (const name of new Set([...req, ...res])) if (new RegExp(`(?:^|[^A-Za-z0-9_])${escaped(name)}(?![A-Za-z0-9_])`, 'u').test(text)) candidates.add(name);
  for (const name of [...candidates].filter(name => !named.has(name) && name !== 'api_request' && !environmentNames.includes(name)).slice(0, 16 - fields.length)) {
    const where = [req.has(name) ? 'request' : null, res.has(name) ? 'response' : null].filter(Boolean);
    rows.push({ kind: 'field', claim: `Field mentioned: ${name}`, recorded: where.length ? `Name present in ${where.join(' and ')}; value not compared` : 'Not found in retained field names',
      mark: where.length ? presence() : 'not-checkable' });
  }
  const headers = [...new Set([...text.matchAll(/\bheader\s+[`"']?([A-Za-z][A-Za-z0-9-]{0,127})|\b([A-Z][a-z]+(?:-[A-Z][A-Za-z]+)+)\b/gu)].map(match => (match[1] ?? match[2]).toLowerCase()))].slice(0, 12);
  const presentHeaders = new Set(Object.keys(run?.response?.headers ?? {}).map(name => name.toLowerCase()));
  for (const name of headers) rows.push({ kind: 'header', claim: name, recorded: !run ? 'Headers not retained in ledger summary' : presentHeaders.has(name) ? 'Name present; value not compared' : 'Not found in retained headers',
    mark: run && presentHeaders.has(name) ? presence() : 'not-checkable' });
  return { run_id: ref.run_id, role, depth, coverage, scope: ref.scope ?? null, ...(ref.code ? { code: ref.code } : {}), rows,
    meaning: 'Bounded literal comparison of mentioned status, declared environments, explicit request/response field names and header names. A present name is not a value check. Values and free prose are not judged. Missing names are not proof of absence; comparison never changes review state.' };
}
function contractNode(root, ctx, operation) {
  const config = resolveConfig(root), file = selectContractFile(root, config, () => ctx.api?.contract);
  if (!file) return { present: false, referenced: false, data: { operation }, stop: 'No local contract is configured.' };
  try {
    const absolute = resolve(root, file), opened = openEvidenceRoot(dirname(absolute));
    if (!opened) throw new Error();
    const bytes = readEvidenceBytes(opened, basename(absolute), { maxBytes: 4 * 1024 * 1024 });
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const doc = /^\s*[{[]/u.test(raw) ? JSON.parse(raw) : parseYamlDocument(raw, { maxDepth: 64, strictDepth: true });
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`, space = operation.indexOf(' ');
    const node = opNode(doc, operation.slice(0, space), operation.slice(space + 1));
    return node ? { present: true, data: { digest, operation, declaration: node }, stop: 'Trace ends at the local contract declaration. A declaration is not an executed check.' }
      : { present: false, referenced: false, data: { operation, digest }, stop: 'The configured contract has no declaration for this operation.' };
  } catch { return { present: false, referenced: true, data: { operation }, stop: 'The configured contract could not be read within local safety bounds.' }; }
}

function detailModel(root, params, { nodeData = null } = {}) {
  const { ctx, entry, history, options, record } = selectedNote(root, params);
  const comparisons = [], nodes = [];
  const fields = entries => entries.filter(([, value]) => value !== null && value !== undefined && value !== '' && (!Array.isArray(value) || value.length))
    .map(([name, value, literal = true]) => ({ name, value: short(Array.isArray(value) ? value.join(', ') : value, 2048), literal }));
  const add = (id, kind, label, present, data, stop, extra = {}) => nodes.push({ id, kind, label, present, referenced: false, stop, ...extra,
    ...(nodeData === id ? { json: bounded(data) } : {}) });
  add('claim', 'claim', 'Claim', true, record, record.superseded ? 'This note is historical; its replacement supplies active guidance.' : null,
    { fields: fields([['Author', record.author.by, false], ['Author type', record.author.category, false], ['Date', record.provenance?.at],
      ['Basis', `${record.basis.kind}${record.basis.inferred ? ' (inferred)' : ''}`, false],
      ['Stated environment', mentionedEnvironments(record.text, options.environmentNames)]]) });
  const reviews = (Array.isArray(entry.note_reviews) ? entry.note_reviews : []).filter(review => review?.note_id === record.id);
  const reviewsOmitted = Math.max(0, reviews.length - 32);
  // The current run request's status: open, acknowledged or run attached.
  const request = record.review?.request, requestText = request && ({ open: 'Open: in the repository inbox, not yet acknowledged',
    acknowledged: 'Acknowledged: an agent received it; not evidence', 'run-attached': `Run attached: ${(request.run_ids ?? []).join(', ')}`,
    'no-local-handoff': 'No handoff in this repository inbox', 'inbox-unavailable': `Inbox unavailable (${request.code})` })[request.status];
  for (let index = reviewsOmitted; index < reviews.length; index++) {
    const review = reviews[index], current = index === reviews.length - 1 && review.decision === 'run-requested';
    add(`review:${index}`, 'review', `Review · ${review.decision}`, true, review, null,
      { fields: fields([['By', review.by, false], ['Actor', review.actor, false], ['Date', review.at], ['Runs', review.evidence?.length ? review.evidence : 'No run'],
        ['Limits', review.limits, false], ['Reason', review.reason, false], ['Request', current ? requestText : null, false]]) });
  }
  if (!reviews.length) add('reviews', 'review', 'Reviews', false, { note_id: record.id }, 'No review record exists for this note.');
  const refs = record.run_support ?? [];
  for (const ref of refs.slice(0, 16)) {
    const run = privateRun(root, ref, options), shared = observationFor(ctx, params.operation, ref.run_id, params.stack);
    const origin = options.reviewEvidenceFor(ref.run_id).provenance;
    const comparison = compareRun(record, ref, run, shared, options.environmentNames); comparisons.push(comparison);
    add(`run:${ref.run_id}`, 'run', ref.run_id, Boolean(run), { ...ref, ...(run ? { origin: run.origin, status: run.response.status } : {}) },
      run ? null : comparison.depth === 'ledger-summary' ? 'Private run stops here; only the shared summary remains.' : 'Trail stops here: the run is referenced only, not on this machine.',
      { run_id: ref.run_id, referenced: !run, fields: run ? fields([['Observed', origin?.observed_at], ['Initiator', origin?.initiator],
        ['Package', origin?.package_version], ['Status', run.response.status]]) : [] });
    add(`scope:${ref.run_id}`, 'scope', 'Run scope', Boolean(run || shared), run?.origin?.scope ?? shared?.identity ?? ref.scope ?? {},
      comparison.coverage === 'covered' ? null : comparison.coverage === 'out-of-scope' ? 'This run does not cover the claim’s scope.' : 'Complete scope coverage cannot be established.',
      { referenced: !run && !shared && Boolean(ref.scope), fields: fields([['Environment', ref.scope?.environment], ['Provider', ref.scope?.provider],
        ['Operation', ref.scope?.operation], ['Protocol', ref.scope?.protocol], ['Contract', ref.scope?.contract_digest]]) });
    add(`observation:${ref.run_id}`, 'observation', 'Shared observation', Boolean(shared), shared ?? { run_id: ref.run_id }, shared ? null : 'No shared observation references this run.',
      { fields: shared ? fields([['Observed', shared.observation.observed_at], ['Status', shared.observation.response_status],
        ['Verification', shared.observation.verification], ['Assertions', shared.observation.assertions
          ? `${shared.observation.assertions.passed} passed · ${shared.observation.assertions.failed} failed` : 'Not recorded', false]]) : [] });
  }
  const later = laterRunIds(record);
  if (!refs.length) add('evidence', 'run', 'Evidence run', false, { note_id: record.id },
    later.length ? 'No run is attached to the authored claim; a later run contradicts it.' : 'Trail stops here: no run is attached.');
  // A later contradicting run is resolved through the same shared evidence
  // reader as an attached one and compared with the same bounded rules.
  for (const id of later.slice(0, 16)) {
    const ref = options.evidenceFor({ ...record, provenance: { ...record.provenance, evidence: [...(record.provenance?.evidence ?? []), { run_id: id }] } })
      .find(row => row.run_id === id) ?? { run_id: id, depth: 'run-id-only', coverage: 'unknown' };
    const run = privateRun(root, ref, options), shared = observationFor(ctx, params.operation, id, params.stack);
    const origin = options.reviewEvidenceFor(id).provenance;
    const comparison = compareRun(record, ref, run, shared, options.environmentNames, 'later-run'); comparisons.push(comparison);
    add(`later-run:${id}`, 'later-run', id, Boolean(run), { ...ref, ...(run ? { origin: run.origin, status: run.response.status } : {}) },
      run ? null : comparison.depth === 'ledger-summary' ? 'Private run stops here; only the shared summary remains.' : 'Trail stops here: the run is referenced only, not on this machine.',
      { run_id: id, referenced: !run, fields: run ? fields([['Observed', origin?.observed_at], ['Initiator', origin?.initiator],
        ['Package', origin?.package_version], ['Status', run.response.status]])
        : shared ? fields([['Observed', shared.observation.observed_at], ['Status', shared.observation.response_status]]) : [] });
  }
  // Review-only evidence remains distinct: trusting a note cannot upgrade its
  // authored evidence classification or create a new observation.
  const reviewIds = [...new Set(reviews.flatMap(review => Array.isArray(review.evidence) ? review.evidence : []))]
    .filter(id => typeof id === 'string' && /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id) && !refs.some(ref => ref.run_id === id) && !later.includes(id));
  for (const id of reviewIds.slice(0, 16)) {
    const ref = options.reviewEvidenceFor(id);
    add(`review-run:${id}`, 'review-evidence', `Review evidence · ${id}`, ref.state !== 'unavailable', ref,
      ref.state === 'unavailable' ? 'Review references this ID; the run is not on this machine.' : 'Attached to a review decision, not to the authored claim.', { run_id: id, referenced: ref.state === 'unavailable' });
  }
  const contract = contractNode(root, ctx, params.operation);
  add('contract', 'contract', 'Contract', contract.present, contract.data, contract.stop, { referenced: contract.referenced === true,
    fields: fields([['Digest', contract.data.digest], ['Operation', params.operation], ['Declared statuses', Object.keys(contract.data.declaration?.responses ?? {})]]) });
  const preview = readNoteContext(root, { operation: params.operation, ...(params.stack ? { stack: params.stack } : {}), max_bytes: 32000 });
  const siblings = history.records.filter(row => row.id !== record.id);
  const selectedSiblings = siblings.slice(0, 100).map(row => ({ id: row.id, text: short(row.text, 600), superseded: row.superseded ?? null,
    review: { state: decorateNoteRecord(row, options).review.state, label: short(decorateNoteRecord(row, options).review.label) } }));
  // Only the pair this note belongs to: as the trusted predecessor or as its correction.
  const conflicts = noteCorrectionConflicts(entry, history, params).filter(row => row.predecessor === record.id || row.correction === record.id);
  const result = clean({ historical: Boolean(record.superseded), record: { ...record, text: short(record.text, 8192), text_shortened: String(record.text).length > 8192,
      provenance: { by: record.provenance?.by, at: record.provenance?.at, actor: record.provenance?.actor },
      ...(record.retirement?.length ? { retirement_of: { note_id: record.retirement[0].note_id, reason: record.retirement[0].reason } } : {}) },
    evidence_explanation: evidenceExplanation(record), comparisons, nodes, nodes_omitted: reviewsOmitted + Math.max(0, reviewIds.length - 16),
    conflicts: conflicts.slice(0, 50), conflicts_omitted: Math.max(0, conflicts.length - 50), other_notes: selectedSiblings, other_notes_omitted: Math.max(0, siblings.length - 100),
    history_state: history.state, history_digest: history.digest,
    // An absent projection can mean an unavailable source or a bounded read.
    // Preserve the reader's issues and omissions instead of inventing success.
    preview: preview.note_context ?? null, preview_issues: preview.issues ?? [],
    preview_omissions: preview.omissions, meaning: NOTE_DATA_MEANING });
  // Complete identities are never shortened to satisfy the HTTP limit. The
  // context preview already has its own shared bound; trim display collections
  // and count omissions before falling back to a smaller headless read.
  for (const field of ['other_notes', 'conflicts']) while (bytes(result) > 400000 && result[field].length) {
    result[field].pop(); result[`${field}_omitted`]++;
  }
  if (bytes(result) > 440000) fail('NOTE_REVIEW_READ_LIMIT');
  return result;
}
export function reviewDetail(root, params) {
  exact(params, ['stack', 'operation', 'note_id']); target(params);
  return scoped(root, params.stack, () => detailModel(root, params));
}
export function reviewNode(root, params) {
  exact(params, ['stack', 'operation', 'note_id', 'node']); target(params);
  if (typeof params.node !== 'string' || params.node.length > 160) fail('NOTE_REVIEW_INVALID');
  return scoped(root, params.stack, () => {
    const model = detailModel(root, params, { nodeData: params.node }), node = model.nodes.find(row => row.id === params.node);
    if (!node) fail('NOTE_REVIEW_INVALID');
    if (node.run_id && node.present) {
      try { return { ...node.json, response: inspectRecordedResponse(root, { runId: node.run_id, stack: params.stack }), meaning: 'Private local response inspection; read only. Nothing is saved into knowledge.' }; }
      catch { return { ...node.json, response_unavailable: true }; }
    }
    return node.json;
  });
}

// Batch identity lists come from B's source/cause groupings. Historical
// predecessors are displayed as holdbacks; prose never selects a predecessor.
export function reviewGroups(root, params) {
  exact(params, ['kind', 'stack', 'operation', 'note_id', 'cause']);
  if (!['source', 'cause'].includes(params.kind)) fail('NOTE_REVIEW_INVALID');
  const model = buildNoteReviewModel(root);
  let selected, label, basis;
  if (params.kind === 'source') {
    target(params);
    const row = model.records.find(item => keyOf(item) === keyOf(params));
    if (!row?.basis.source) fail('NOTE_REVIEW_INVALID');
    const source = model.sources.find(group => group.notes.some(item => keyOf(item) === keyOf(params)));
    selected = source.notes; label = row.basis.source; basis = row.basis;
  } else {
    const cause = model.causes.find(item => item.id === params.cause);
    if (!cause) fail('NOTE_REVIEW_INVALID');
    label = cause.label;
    selected = model.records.filter(row => row.run_support?.some(ref => ref.cause === cause.id)).map(identity);
  }
  const notes = selected.map(id => {
    const row = model.records.find(row => keyOf(row) === keyOf(id));
    return { ...id, text: short(row.text, 300), state: row.review.state };
  });
  const held_back = [];
  for (const id of selected) scoped(root, id.stack, () => {
    const { record, history } = selectedNote(root, id);
    for (const link of record.corrections ?? []) {
      const prior = history.records.find(row => row.id === link.note_id);
      if (prior && !held_back.some(row => keyOf(row) === keyOf({ ...id, note_id: prior.id }))) held_back.push({ ...id, note_id: prior.id,
        text: short(prior.text, 300), replacement: record.id, code: 'NOTE_REVIEW_REPLACED' });
    }
  });
  return clean({ kind: params.kind, label, basis, notes: notes.slice(0, 256), omitted: Math.max(0, notes.length - 256),
    held_back: held_back.slice(0, 256), held_back_omitted: Math.max(0, held_back.length - 256),
    meaning: 'Review this explicit identity list before applying a decision. Corrected notes are held back from trust. Each operation commits independently; receipts name any partial completion.' });
}
export function reviewBatch(root, params) {
  exact(params, ['identities', 'decision', 'by', 'actor', 'limits', 'reason', 'evidence']);
  if (!Array.isArray(params.identities) || !params.identities.length || params.identities.length > 256) fail('NOTE_REVIEW_INVALID');
  const groups = new Map();
  for (const id of params.identities) {
    exact(id, ['stack', 'operation', 'note_id']); target(id);
    const key = JSON.stringify([id.stack, id.operation]), group = groups.get(key) ?? { ...(id.stack ? { stack: id.stack } : {}), operation: id.operation, notes: [] };
    if (!group.notes.includes(id.note_id)) group.notes.push(id.note_id); groups.set(key, group);
  }
  const { identities, ...decision } = params;
  // Validate the entire envelope before the first operation write. The shared
  // writer still owns per-operation concurrency and its stable refusals.
  for (const group of groups.values()) normalizeReview({ ...decision, ...group, at: new Date().toISOString() });
  const receipts = [];
  for (const group of groups.values()) {
    try { receipts.push({ stack: group.stack, operation: group.operation, ...recordNoteReview(root, { ...decision, ...group }) }); }
    catch (error) { receipts.push({ stack: group.stack, operation: group.operation, ...noteReviewFailure(error, group) }); }
  }
  return { receipts, partial: receipts.some(row => row.refused) && receipts.some(row => !row.refused), requests_executed: 0 };
}
export function reviewSupersede(root, params) {
  exact(params, ['stack', 'operation', 'note_id', 'supersedes', 'by', 'actor', 'evidence']); target(params);
  if (!NOTE_DIGEST.test(params.supersedes ?? '') || params.supersedes === params.note_id) fail('NOTE_REVIEW_INVALID');
  validateReviewActor(params.by, params.actor); validateReviewEvidence(params.evidence ?? []);
  return scoped(root, params.stack, () => {
    const snapshot = loadContextSnapshot(root), { record, history } = selectedNote(root, params);
    if (!history.records.some(row => row.id === params.supersedes)) throw staleNoteError(history);
    validateReviewText(record.text);
    const config = resolveConfig(root), file = selectContractFile(root, config, () => snapshot.ctx.api?.contract);
    const resolved = resolveNoteEvidence(params.evidence ?? [], { evidenceDir: evidenceDirectory(root), operation: params.operation,
      environment: config.name, provider: config.baseUrl, contractDigest: file ? loadHttpContract(file)?.digest : undefined });
    const stamp = { ...provenanceStamp(root), by: params.by, actor: params.actor, recorded_at: new Date().toISOString(), evidence: resolved.references };
    // Do not infer or copy the original author's basis into the new assertion.
    const result = saveContextNote(root, snapshot, { operation: params.operation, note: record.text, stamp, relation: { supersedes: params.supersedes } });
    return { note_id: result.note_id, supersedes: params.supersedes, unchanged: result.unchanged,
      evidence_warnings: resolved.warnings, pointers: refreshNotePointers(root), requests_executed: 0 };
  }, true);
}

export function reviewHandlers(root) {
  const guarded = fn => ({ touch: true, run: async params => {
    try { return await fn(root, params); }
    catch (error) { return noteReviewFailure(error, params); }
  } });
  return { reviewIndex: guarded(reviewIndex), reviewDetail: guarded(reviewDetail), reviewNode: guarded(reviewNode),
    reviewGroups: guarded(reviewGroups), reviewBatch: guarded(reviewBatch), reviewSupersede: guarded(reviewSupersede),
    reviewDecision: guarded(recordNoteReview), reviewRetire: guarded(retireNote), reviewPrompt: guarded(buildVerifyPrompt) };
}
