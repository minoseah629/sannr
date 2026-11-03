// Authored correction is a relationship, not a stronger verification claim.
// Keep legacy note arrays intact. Older readers may show both claims; older
// learners preserve this additive relationship field rather than clearing it.
import { createHash } from 'node:crypto';
import { secretIn } from './verdicts.mjs';
import { getNoteEntry, noteEntries, noteKeyLabel, validNoteOperations } from './note-key.mjs';
import { validNoteReview, validNoteRetirement } from './note-reviews.mjs';
import { EVIDENCE_INITIATORS } from './note-evidence.mjs';
import { NOTE_BASIS_KINDS, validNoteSource } from './note-basis.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|([+-])(\d{2}):(\d{2})))?$/;
const MACHINE_KINDS = new Set(['learn_reachability_failure', 'learn_verification_failure', 'learn_observation']);
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const own = (value, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};

export function safeNoteAuthor(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 80
    && value === value.trim() && !/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.test(value)
    && !/\S{40,}/.test(value) && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

export function validNoteDate(value) {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m || m[0].length !== value.length) return false;
  const y = Number(m[1]), month = Number(m[2]), d = Number(m[3]);
  const days = [0, 31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || d < 1 || d > days[month]) return false;
  if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59)) return false;
  if (m[9] !== undefined && (Number(m[9]) > 23 || Number(m[10]) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}

export function isValidSupersessionMarker(marker) {
  if (!plain(marker)) return false;
  const reason = own(marker, 'reason');
  if (!['successful_verification', 'maintenance_staleness'].includes(reason) || !validNoteDate(own(marker, 'at'))) return false;
  if (Object.hasOwn(marker, 'by') && !safeNoteAuthor(own(marker, 'by'))) return false;
  if (reason === 'maintenance_staleness') {
    if (!safeNoteAuthor(own(marker, 'by'))) return false;
    const pass = own(marker, 'pass_id');
    if (typeof pass !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(pass)) return false;
  } else if (Object.hasOwn(marker, 'pass_id')) return false;
  return true;
}

function canonical(value, seen = new Set(), depth = 0) {
  if (depth > 64) throw new Error('depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if ((!Array.isArray(value) && !plain(value)) || seen.has(value) || Object.hasOwn(value, 'toJSON')) throw new Error('non-json');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = Array.from({ length: value.length }, (_, i) => {
      const d = Object.getOwnPropertyDescriptor(value, String(i));
      if (!d || !Object.hasOwn(d, 'value')) throw new Error('sparse');
      return canonical(d.value, seen, depth + 1);
    });
  } else {
    result = Object.fromEntries(Object.keys(value).sort().map(key => {
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!Object.hasOwn(d, 'value')) throw new Error('accessor');
      return [key, canonical(d.value, seen, depth + 1)];
    }));
  }
  seen.delete(value);
  return result;
}

const serialized = value => JSON.stringify(canonical(value));
const hash = value => `sha256:${createHash('sha256').update(serialized(value)).digest('hex')}`;
export const noteIdentity = (text, provenance = null) => hash({ v: 1, text, provenance: provenance ?? null });

export function isMachineNote(text, provenance) {
  return MACHINE_KINDS.has(provenance?.kind);
}

const evidenceInitiators = new Set(['unknown', ...EVIDENCE_INITIATORS]);
const protocols = new Set(['http', 'graphql', 'jsonrpc', 'grpc', 'websocket']);
const boundedText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && !/[\x00-\x1f\x7f-\x9f]/.test(value) && !secretIn(value, { allowAuthReferences: true });
const keysWithin = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const optional = (value, test) => value === null || test(value);
function validEvidenceReferences(refs) {
  if (!Array.isArray(refs) || refs.length > 16) return false;
  const seen = new Set();
  return refs.every(ref => {
    if (!keysWithin(ref, ['run_id', 'state', 'digest', 'provenance', 'scope', 'code'])
      || typeof ref.run_id !== 'string' || !/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(ref.run_id)
      || secretIn(ref.run_id)
      || seen.has(ref.run_id) || !['available', 'unavailable', 'scope_mismatch'].includes(ref.state)
      || (ref.state === 'unavailable' ? ref.digest !== null : !HASH.test(ref.digest))
      || (ref.code !== undefined && !/^[A-Z][A-Z0-9_]{0,95}$/.test(ref.code))) return false;
    seen.add(ref.run_id);
    const origin = ref.provenance, scope = ref.scope;
    if (!keysWithin(origin, ['initiator', 'transport', 'observed_at', 'package_version', 'build_id'])
      || !evidenceInitiators.has(origin.initiator)
      || !(origin.transport === 'unknown' || (typeof origin.transport === 'string' && origin.transport.startsWith('api_request:') && protocols.has(origin.transport.slice(12))))
      || !optional(origin.observed_at, validNoteDate)
      || !optional(origin.package_version, value => boundedText(value, 80) && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value))
      || !optional(origin.build_id, value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value))) return false;
    if (!keysWithin(scope, ['operation', 'protocol', 'environment', 'provider', 'contract_digest'])
      || !optional(scope.operation, value => boundedText(value, 512))
      || !optional(scope.protocol, value => protocols.has(value))
      || !optional(scope.environment, value => boundedText(value, 128))
      || !optional(scope.contract_digest, value => HASH.test(value))) return false;
    return optional(scope.provider, value => {
      if (!boundedText(value, 1024)) return false;
      try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }
      catch { return false; }
    });
  });
}

export function validAuthoredNoteStamp(stamp) {
  try {
    const value = canonical(stamp);
    return keysWithin(value, ['by', 'at', 'recorded_at', 'actor', 'evidence', 'operations', 'basis', 'source']) && safeNoteAuthor(value.by) && validNoteDate(value.at)
      && (value.recorded_at === undefined || validNoteDate(value.recorded_at) && value.recorded_at.includes('T'))
      && (value.actor === undefined || ['person', 'agent', 'imported'].includes(value.actor))
      && (value.basis === undefined || NOTE_BASIS_KINDS.includes(value.basis))
      && (value.source === undefined || value.basis !== undefined && validNoteSource(value.source))
      && (value.evidence === undefined || validEvidenceReferences(value.evidence))
      && (value.operations === undefined || validNoteOperations(value.operations));
  } catch { return false; }
}

function contents(entry) {
  const notes = entry?.notes === undefined ? [] : entry.notes;
  return { v: 1, notes,
    notes_provenance: entry?.notes_provenance === undefined ? (Array.isArray(notes) ? notes.map(() => null) : []) : entry.notes_provenance,
    notes_superseded: entry?.notes_superseded === undefined ? (Array.isArray(notes) ? notes.map(() => null) : []) : entry.notes_superseded,
    note_replacements: entry?.note_replacements === undefined ? [] : entry.note_replacements };
}

// The published v1 history format is fixed. Review metadata has its own
// operation-level baseline: older writers replace note_integrity wholesale.
function reviewContents(entry) {
  return { v: 1, note_reviews: entry?.note_reviews === undefined ? [] : entry.note_reviews,
    note_retirements: entry?.note_retirements === undefined ? [] : entry.note_retirements };
}

export function inspectNoteHistory(entry = {}, operation) {
  const issues = [];
  const issue = (code, message, index, severity = 'error') => issues.push({ code, severity, message, ...(index === undefined ? {} : { index }) });
  if (!plain(entry)) issue('NOTE_ENTRY_INVALID', 'A note entry must be a plain object.');
  let data, digest = null, reviewData, reviewDigest = null;
  try { data = canonical(contents(entry)); digest = hash(data); }
  catch { issue('NOTE_DATA_INVALID', 'Note history must contain plain JSON data.'); data = {}; }
  try { reviewData = canonical(reviewContents(entry)); reviewDigest = hash(reviewData); }
  catch { issue('NOTE_REVIEW_DATA_INVALID', 'Review metadata must contain plain JSON data.'); reviewData = {}; }
  const notes = Array.isArray(data.notes) ? data.notes : [];
  if (!Array.isArray(data.notes)) issue('NOTE_ARRAY_INVALID', 'notes must be an array.');
  for (const name of ['notes_provenance', 'notes_superseded']) {
    if (!Array.isArray(data[name])) issue('NOTE_ARRAY_INVALID', `${name} must be an array.`);
    else if (data[name].length !== notes.length) issue('NOTE_ARRAY_ALIGNMENT', `${name} does not align with notes.`);
    if (entry?.[name] !== undefined && !Array.isArray(entry[name])) issue('NOTE_ARRAY_INVALID', `${name} must be an array when present.`);
  }
  const records = notes.map((text, index) => {
    const provenance = data.notes_provenance?.[index] ?? null;
    const marker = data.notes_superseded?.[index] ?? null;
    if (typeof text !== 'string' || !text.trim()) issue('NOTE_TEXT_INVALID', 'A note must be nonempty text.', index);
    if (provenance !== null && !plain(provenance)) issue('NOTE_PROVENANCE_INVALID', 'Note provenance must be an object or null.', index);
    else if (provenance === null)
      issue('NOTE_ATTRIBUTION_UNKNOWN', 'Original author or recorded date is unknown.', index, 'warning');
    if (plain(provenance) && (!safeNoteAuthor(provenance.by) || !validNoteDate(provenance.at)))
      issue('NOTE_PROVENANCE_INVALID', 'Recorded provenance has an invalid author or date.', index);
    if (plain(provenance) && provenance.evidence !== undefined && !validEvidenceReferences(provenance.evidence))
      issue('NOTE_EVIDENCE_INVALID', 'Note evidence references must be bounded receipt metadata, without payloads or credentials.', index);
    if (plain(provenance) && provenance.operations !== undefined && !validNoteOperations(provenance.operations))
      issue('NOTE_OPERATIONS_INVALID', 'Note applicability must list bounded operation keys without values.', index);
    if (plain(provenance) && provenance.actor !== undefined && !['person', 'agent', 'imported'].includes(provenance.actor))
      issue('NOTE_PROVENANCE_INVALID', 'Note actor must be person, agent or imported.', index);
    if (plain(provenance) && provenance.basis !== undefined && (!NOTE_BASIS_KINDS.includes(provenance.basis)
      || provenance.source !== undefined && !validNoteSource(provenance.source)))
      issue('NOTE_BASIS_INVALID', 'Note basis and source must be supported, bounded provenance without credentials.', index);
    if (plain(provenance) && provenance.recorded_at !== undefined && (!validNoteDate(provenance.recorded_at) || !provenance.recorded_at.includes('T')))
      issue('NOTE_PROVENANCE_INVALID', 'Precise note creation time must be a valid timestamp.', index);
    if (marker !== null && !isValidSupersessionMarker(marker)) issue('NOTE_MARKER_INVALID', 'A machine supersession marker is invalid.', index);
    return { id: noteIdentity(text, provenance), index, text, provenance,
      kind: isMachineNote(text, provenance) ? 'machine' : provenance ? 'authored' : 'unattributed',
      superseded: isValidSupersessionMarker(marker) ? { ...marker, kind: 'machine' } : null };
  });
  const byId = new Map();
  for (const record of records) {
    if (byId.has(record.id)) issue('NOTE_ID_AMBIGUOUS', 'Multiple notes have the same immutable identity.', record.index);
    else byId.set(record.id, record);
  }
  const replacements = Array.isArray(data.note_replacements) ? data.note_replacements : [];
  if (!Array.isArray(data.note_replacements)) issue('NOTE_REPLACEMENTS_INVALID', 'note_replacements must be an array.');
  const links = new Map();
  for (const [index, link] of replacements.entries()) {
    if (!plain(link) || Object.keys(link).some(k => !['supersedes', 'replacement', 'by', 'at'].includes(k))
      || !HASH.test(link.supersedes) || !HASH.test(link.replacement) || !safeNoteAuthor(link.by) || !validNoteDate(link.at)) {
      issue('NOTE_REPLACEMENT_INVALID', 'An authored replacement relationship is malformed.', index); continue;
    }
    if (!byId.has(link.supersedes) || !byId.has(link.replacement)) { issue('NOTE_REPLACEMENT_DANGLING', 'A replacement relationship names a missing note.', index); continue; }
    if (link.supersedes === link.replacement || links.has(link.supersedes)) { issue('NOTE_REPLACEMENT_CONFLICT', 'A note has conflicting or self-referential replacement links.', index); continue; }
    links.set(link.supersedes, link);
  }
  if (reviewData.note_reviews !== undefined) {
    if (!Array.isArray(reviewData.note_reviews)) issue('NOTE_REVIEWS_INVALID', 'note_reviews must be an append-only list.');
    else for (const [index, review] of reviewData.note_reviews.entries()) {
      if (!validNoteReview(review)) issue('NOTE_REVIEW_INVALID', 'A note review must contain bounded decision metadata, never payloads or credentials.', index);
      else if (!byId.has(review.note_id)) issue('NOTE_REVIEW_DANGLING', 'A review names a missing note identity.', index);
    }
  }
  if (reviewData.note_retirements !== undefined) {
    if (!Array.isArray(reviewData.note_retirements)) issue('NOTE_RETIREMENTS_INVALID', 'note_retirements must be an append-only list.');
    else {
      const seen = new Set();
      for (const [index, retirement] of reviewData.note_retirements.entries()) {
        if (!validNoteRetirement(retirement)) issue('NOTE_RETIREMENT_INVALID', 'A retirement must contain a replacement identity, reason class and actor.', index);
        else if (!byId.has(retirement.replacement) || !replacements.some(link => link?.replacement === retirement.replacement))
          issue('NOTE_RETIREMENT_DANGLING', 'A retirement names a missing replacement relationship.', index);
        else if (seen.has(retirement.replacement)) issue('NOTE_RETIREMENT_CONFLICT', 'A replacement note has more than one retirement record.', index);
        else seen.add(retirement.replacement);
      }
    }
  }
  const checked = new Set();
  for (const id of links.keys()) {
    if (checked.has(id)) continue;
    const visited = new Set(); let cursor = id;
    while (links.has(cursor) && !checked.has(cursor)) {
      if (visited.has(cursor)) { issue('NOTE_REPLACEMENT_CYCLE', 'Replacement relationships contain a cycle.'); break; }
      visited.add(cursor); cursor = links.get(cursor).replacement;
    }
    for (const seen of visited) checked.add(seen);
  }
  const baseline = entry?.note_integrity;
  let baselineValid = baseline === undefined;
  if (baseline !== undefined) {
    baselineValid = plain(baseline) && baseline.v === 1 && HASH.test(baseline.digest)
      && ['unknown', 'recorded'].includes(baseline.prior_integrity) && Array.isArray(baseline.acknowledgements)
      && baseline.acknowledgements.every(receipt => plain(receipt) && safeNoteAuthor(receipt.by) && validNoteDate(receipt.at)
        && ['first_baseline', 'baseline_mismatch'].includes(receipt.reason)
        && (receipt.previous_digest === null || HASH.test(receipt.previous_digest)) && HASH.test(receipt.accepted_digest));
    if (!baselineValid) issue('NOTE_BASELINE_INVALID', 'The recorded integrity baseline is malformed.');
  }
  const reviewBaseline = entry?.note_review_integrity;
  const reviewBaselineValid = reviewBaseline === undefined || keysWithin(reviewBaseline, ['v', 'digest'])
    && reviewBaseline.v === 1 && HASH.test(reviewBaseline.digest);
  if (!reviewBaselineValid) issue('NOTE_REVIEW_BASELINE_INVALID', 'The recorded review integrity baseline is malformed.');
  const reviewChanged = reviewBaselineValid && (reviewBaseline === undefined
    ? Boolean(reviewData.note_reviews?.length || reviewData.note_retirements?.length)
    : reviewDigest !== reviewBaseline.digest);
  if (reviewChanged) issue('NOTE_REVIEW_HISTORY_CHANGED', 'Review metadata differs from its separate baseline or has no baseline; history acknowledgement cannot accept it.', undefined, 'warning');
  const invalid = issues.some(i => i.severity === 'error');
  const historyChanged = baselineValid && baseline !== undefined && digest !== baseline.digest;
  const changed = historyChanged || reviewChanged;
  const state = invalid ? 'invalid' : changed ? 'changed' : !records.length && !replacements.length ? 'empty' : baseline === undefined ? 'unbaselined' : 'healthy';
  if (historyChanged) issue('NOTE_HISTORY_CHANGED', 'Note history differs from its recorded baseline.', undefined, 'warning');
  if (state === 'unbaselined') issue('NOTE_BASELINE_MISSING', 'Prior note-history integrity is unknown; reviewed acknowledgement is required before changing it.', undefined, 'warning');
  // Invalid relationships never hide text. A baseline mismatch also prevents
  // a hand-edited marker from silently removing a claim from active retrieval.
  if (invalid || changed) for (const record of records) record.superseded = null;
  else for (const [id, link] of links) byId.get(id).superseded = { ...link, kind: 'authored' };
  return { ...(operation === undefined ? {} : { operation }), state, digest,
    review_digest: reviewDigest, review_changed: reviewChanged,
    baseline_digest: baselineValid && baseline !== undefined ? baseline.digest : null,
    prior_integrity: baselineValid && baseline !== undefined ? baseline.prior_integrity : 'unknown',
    records, active: records.filter(r => !r.superseded), history: records.filter(r => r.superseded), issues };
}

export function noteHistoryError(code, operation, inspection) {
  return Object.assign(new Error({
    NOTE_BASELINE_REQUIRED: 'Existing note history needs reviewed baseline acknowledgement before it can change.',
    NOTE_HISTORY_CHANGED: 'Note history differs from its recorded baseline; preserve and review it before writing.',
    NOTE_HISTORY_INVALID: 'Note history is malformed; preserve it and inspect its integrity issues.',
    NOTE_HISTORY_PROTECTED: 'The write would discard or rewrite protected note history.',
    NOTE_REVIEW_HISTORY_CHANGED: 'Review metadata differs from its separate baseline; preserve and inspect it. Note-history acknowledgement cannot accept review changes.',
    NOTE_RELATION_REQUIRED: 'Choose whether this note belongs alongside an existing claim or supersedes one.',
  }[code] ?? 'The note-history change was refused.'), { code, operation, digest: inspection?.digest,
    issues: inspection?.issues ?? [], existing: inspection?.active?.slice(0, 20).map(({ id, text }) => ({ id, text: String(text).slice(0, 1000) })) });
}

export function assertWritableNoteHistory(entry, operation) {
  const history = inspectNoteHistory(entry, operation);
  const code = history.state === 'invalid' ? 'NOTE_HISTORY_INVALID' : history.review_changed ? 'NOTE_REVIEW_HISTORY_CHANGED'
    : { changed: 'NOTE_HISTORY_CHANGED', unbaselined: 'NOTE_BASELINE_REQUIRED' }[history.state];
  if (code) throw noteHistoryError(code, operation, history);
  return history;
}

export function baselineNoteHistory(entry, { prior = 'recorded', acknowledgements = [] } = {}) {
  const inspection = inspectNoteHistory({ ...entry, note_integrity: undefined });
  if (inspection.state === 'invalid') throw noteHistoryError('NOTE_HISTORY_INVALID', undefined, inspection);
  if (inspection.review_changed) throw noteHistoryError('NOTE_REVIEW_HISTORY_CHANGED', undefined, inspection);
  entry.note_integrity = { v: 1, digest: inspection.digest, prior_integrity: prior, acknowledgements };
  return entry;
}

// Apply to an entire proposed write while the context lock is held, against
// the freshly read disk state. An unrelated write may preserve suspect history
// byte-for-byte but must never give it a new baseline.
export function protectContextNoteHistory(previous, next) {
  const keys = new Map([...noteEntries(previous, { accounts: true }), ...noteEntries(next, { accounts: true })].map(({ key }) => [JSON.stringify(key), key]));
  for (const key of keys.values()) {
    const operation = noteKeyLabel(key);
    const old = getNoteEntry(previous, key);
    const value = getNoteEntry(next, key);
    const current = inspectNoteHistory(old === undefined ? {} : old, operation);
    if (value === undefined) {
      if (current.records.some(r => r.kind !== 'machine') || old?.note_replacements?.length || old?.note_reviews?.length || old?.note_retirements?.length
        || old?.note_integrity?.acknowledgements?.length || ['invalid', 'changed'].includes(current.state))
        throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
      continue;
    }
    // First-store import of legacy bytes stays unbaselined. It is not a tool
    // assertion that this pre-existing authored history is intact.
    if (old === undefined) {
      const created = inspectNoteHistory(value, operation);
      if (['invalid', 'changed'].includes(created.state)) throw noteHistoryError('NOTE_HISTORY_INVALID', operation, created);
      if (created.state === 'empty') baselineNoteHistory(value);
      continue;
    }
    const candidate = inspectNoteHistory(value, operation);
    const same = current.digest !== null && current.digest === candidate.digest
      && current.review_digest !== null && current.review_digest === candidate.review_digest;
    if (serialized({ present: Object.hasOwn(old, 'note_integrity'), value: old.note_integrity ?? null })
      !== serialized({ present: Object.hasOwn(value, 'note_integrity'), value: value.note_integrity ?? null })) {
      // Pure machine transforms can prepare a fresh baseline before pointer
      // planning. Re-check the *disk* baseline here: a transformed object must
      // never conceal prior drift. Only the digest may change automatically.
      const autoBaseline = ['healthy', 'empty'].includes(current.state)
        && ['healthy', 'empty'].includes(candidate.state)
        && value.note_integrity?.prior_integrity === (old.note_integrity?.prior_integrity ?? 'recorded')
        && serialized(value.note_integrity?.acknowledgements ?? []) === serialized(old.note_integrity?.acknowledgements ?? []);
      if (!autoBaseline) throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
    }
    if (serialized({ present: Object.hasOwn(old, 'note_review_integrity'), value: old.note_review_integrity ?? null })
      !== serialized({ present: Object.hasOwn(value, 'note_review_integrity'), value: value.note_review_integrity ?? null })) {
      const autoBaseline = ['healthy', 'empty'].includes(current.state) && ['healthy', 'empty'].includes(candidate.state)
        && value.note_review_integrity?.v === 1 && value.note_review_integrity.digest === candidate.review_digest;
      if (!autoBaseline) throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
    }
    if (same) continue;
    assertWritableNoteHistory(old, operation);
    if (candidate.issues.some(i => i.severity === 'error')) throw noteHistoryError('NOTE_HISTORY_INVALID', operation, candidate);
    // Corrections append; neither machine normalization nor a stale whole-file
    // writer may splice, reorder, rewrite or relabel already-recorded notes.
    for (const record of current.records) if (candidate.records[record.index]?.id !== record.id)
      throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
    for (const record of current.records) if (record.kind !== 'machine'
      && serialized(old.notes_superseded?.[record.index] ?? null) !== serialized(value.notes_superseded?.[record.index] ?? null))
      throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
    const previousLinks = old.note_replacements ?? [], links = value.note_replacements ?? [];
    if (serialized(links.slice(0, previousLinks.length)) !== serialized(previousLinks))
      throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
    for (const field of ['note_reviews', 'note_retirements']) {
      const previousRows = old[field] ?? [], rows = value[field] ?? [];
      if (serialized(rows.slice(0, previousRows.length)) !== serialized(previousRows))
        throw noteHistoryError('NOTE_HISTORY_PROTECTED', operation, current);
    }
    // Seal only after checking the on-disk baseline and both append-only lists.
    // A legacy acknowledgement never reaches this separate sealing step.
    if (current.review_digest !== candidate.review_digest)
      value.note_review_integrity = { v: 1, digest: candidate.review_digest };
    baselineNoteHistory(value, { prior: old.note_integrity?.prior_integrity ?? 'recorded', acknowledgements: old.note_integrity?.acknowledgements ?? [] });
  }
}

export function sealNoteMutation(previous, next) {
  protectContextNoteHistory({ operations: { note: previous } }, { operations: { note: next } });
  return next;
}
