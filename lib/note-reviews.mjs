// Review decisions are attributed repository data, never execution authority.
// This module contains policy only; callers resolve private evidence locally
// and commit through the existing locked, optimistic note-history writer.
import { safeNoteAuthor, validNoteDate, assertWritableNoteHistory } from './note-history.mjs';
import { secretIn } from './verdicts.mjs';
import { hasCommentMarkup, BLOCK_TEXT_MAX } from './block-text.mjs';
import { contradictionsSinceReview } from './note-evidence.mjs';

export const NOTE_DIGEST = /^sha256:[a-f0-9]{64}$/;
export const REVIEW_DECISIONS = Object.freeze(['trusted', 'disputed', 'run-requested']);
export const RETIRE_REASONS = Object.freeze(['false', 'removed', 'replaced-by-version', 'no-longer-applies', 'other']);
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const runId = value => typeof value === 'string' && /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) && !secretIn(value);
const safeText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= BLOCK_TEXT_MAX
  && !/[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/u.test(value) && !hasCommentMarkup(value)
  && !secretIn(value, { allowAuthReferences: true });

const MESSAGES = {
  NOTE_REVIEW_INVALID: 'Provide one operation, explicit full note identities and supported review fields.',
  NOTE_REVIEW_DECISION_INVALID: 'Choose trusted, disputed or run-requested.',
  NOTE_REVIEW_ACTOR_REQUIRED: 'Attribute the decision with actor person or agent.',
  NOTE_REVIEW_BY_REQUIRED: 'Attribute the decision with a bounded display name, without credentials or an email address.',
  NOTE_REVIEW_REASON_REQUIRED: 'Dispute and run-requested require a reason describing the disagreement or what the run should check.',
  NOTE_REVIEW_TEXT_INVALID: 'Review text must be bounded, nonempty data without control characters or comment markup.',
  SECRET_IN_REVIEW: 'Review input appears to contain credentials. Remove secrets and payload values before retrying.',
  NOTE_DIGEST_REQUIRED: 'Select notes using full sha256 identities from show; positions and digest prefixes are not selectors.',
  NOTE_DIGEST_CONFLICT: 'A selected note identity is no longer in this operation. Re-read show and explicitly select current identities.',
  NOTE_REVIEW_EVIDENCE_REQUIRED: 'Overturning a trusted note requires an attached run ID, for people and agents alike.',
  NOTE_SELF_TRUST_EVIDENCE_REQUIRED: 'An agent trusting its own note must attach a new, locally available run whose scope covers the note.',
  NOTE_SELF_TRUST_EVIDENCE_UNAVAILABLE: 'Self-trust requires readable local run evidence with a known origin; a run ID alone is insufficient.',
  NOTE_SELF_TRUST_EVIDENCE_SCOPE: 'The attached run does not establish coverage of this note in the selected operation, environment, provider and contract scope.',
  NOTE_SELF_TRUST_EVIDENCE_OLD: 'Self-trust needs a run observed after the note and its prior reviews, not an already attached or future-dated run.',
  NOTE_REVIEW_REPLACED: 'This note has an authored replacement. Select its current replacement before trusting it.',
  NOTE_RETIRE_REASON_REQUIRED: 'Retirement requires a reason class: false, removed, replaced-by-version, no-longer-applies or other.',
  NOTE_RETIRE_TEXT_REQUIRED: 'Retirement requires text explaining why the claim is retired.',
  NOTE_RETIRE_INVALID: 'Retirement takes one full note identity and cannot be combined with alongside or supersedes.',
};
export function reviewError(code, details = {}) {
  return Object.assign(new Error(MESSAGES[code] ?? 'The note review could not be saved.'), { code, ...details });
}
export function validateReviewText(value) {
  if (typeof value === 'string' && secretIn(value, { allowAuthReferences: true })) throw reviewError('SECRET_IN_REVIEW');
  if (!safeText(value)) throw reviewError('NOTE_REVIEW_TEXT_INVALID');
  return value;
}
export function validateReviewActor(by, actor) {
  if (![by, actor].every(value => typeof value !== 'string' || !secretIn(value))) throw reviewError('SECRET_IN_REVIEW');
  if (!safeNoteAuthor(by) || !safeText(by)) throw reviewError('NOTE_REVIEW_BY_REQUIRED');
  if (!['person', 'agent'].includes(actor)) throw reviewError('NOTE_REVIEW_ACTOR_REQUIRED');
}
export function validateReviewEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length > 16 || !evidence.every(runId))
    throw Object.assign(new Error('Evidence must list at most 16 exact local run IDs, never paths or payloads.'), { code: 'EVIDENCE_ID_INVALID' });
  return [...new Set(evidence)].sort();
}
export function validNoteReview(record) {
  return plain(record) && Object.keys(record).every(key => ['note_id', 'decision', 'by', 'actor', 'at', 'limits', 'reason', 'evidence'].includes(key))
    && NOTE_DIGEST.test(record.note_id) && REVIEW_DECISIONS.includes(record.decision)
    && safeNoteAuthor(record.by) && safeText(record.by) && ['person', 'agent'].includes(record.actor) && validNoteDate(record.at)
    && (record.limits === undefined || record.decision === 'trusted' && safeText(record.limits))
    && (record.reason === undefined ? record.decision === 'trusted' : safeText(record.reason))
    && Array.isArray(record.evidence) && record.evidence.length <= 16 && record.evidence.every(runId)
    && new Set(record.evidence).size === record.evidence.length;
}
export function latestNoteReview(entry, id) {
  return (entry.note_reviews ?? []).findLast(record => record.note_id === id) ?? null;
}
export function validNoteRetirement(record) {
  return plain(record) && Object.keys(record).every(key => ['replacement', 'reason', 'actor'].includes(key))
    && NOTE_DIGEST.test(record.replacement) && RETIRE_REASONS.includes(record.reason) && ['person', 'agent'].includes(record.actor);
}
export function noteRetirement(entry, id) {
  return (entry.note_retirements ?? []).find(record => record.replacement === id) ?? null;
}
export function reviewEvidenceLabel(ids, { reviewEvidenceFor } = {}) {
  return ids.map(id => `${id}${reviewEvidenceFor?.(id)?.state === 'unavailable' ? ' (run not on this machine)' : ''}`).join(', ');
}
// Asking for evidence does not discharge an existing trust decision. This
// prevents trust -> run request -> dispute/retire from evading the run rule.
export function assertReviewOverturn(entry, id, evidence) {
  const prior = (entry.note_reviews ?? []).findLast(record => record.note_id === id && record.decision !== 'run-requested');
  if (prior?.decision === 'trusted' && !evidence.length) throw reviewError('NOTE_REVIEW_EVIDENCE_REQUIRED', { note_id: id });
}
// A retirement note is itself the claim "this earlier note is retired", so a
// run request on it is the decision, not an unreviewed state: its label leads
// with the request and keeps the retirement evidence suffix the caller adds.
export function reviewProjection(entry, history, record, options = {}, { retirement = false } = {}) {
  if (['invalid', 'changed'].includes(history.state)) return { state: 'unreviewed', label: 'unreviewed · review withheld: note history requires inspection' };
  const review = latestNoteReview(entry, record.id);
  if (!review) return { state: 'unreviewed', label: 'unreviewed' };
  const contradiction = review.decision === 'trusted' ? contradictionsSinceReview(record, review, options) : null;
  const state = contradiction ? 'contradicted-since-trusted' : review.decision;
  // A run request's status: open, acknowledged or run attached. Readers that
  // supply no status source (committed managed pointers) keep the decision only.
  const { label: requestLabel, ...request } = review.decision === 'run-requested' && typeof options.runRequestFor === 'function'
    ? options.runRequestFor(review, history) : {};
  const label = `${contradiction ? 'contradicted since trusted' : review.decision === 'run-requested' ? retirement ? 'run requested' : 'unreviewed · run-requested' : review.decision} by ${review.by} · ${review.evidence.length ? reviewEvidenceLabel(review.evidence, options) : 'no run'}`
    + (requestLabel ? ` · request: ${requestLabel}` : '')
    + (review.limits ? ` · limits: ${JSON.stringify(review.limits)}` : '')
    + (review.reason ? ` · reason: ${JSON.stringify(review.reason)}` : '')
    + (contradiction ? ` · later run: ${contradiction.evidence.join(', ')}` : '');
  return { state, ...review, ...(contradiction ? { contradiction } : {}), ...(requestLabel ? { request } : {}), label };
}
export function staleNoteError(history) {
  const current_notes = history.records.map(({ id }) => id);
  return reviewError('NOTE_DIGEST_CONFLICT', { digest: history.digest, current_notes,
    next: `Re-read show --history and select a current full note identity: ${current_notes.join(', ') || '(no notes)'}.` });
}

function assertSelfTrust(entry, note, change, resolved) {
  if (change.actor !== 'agent' || change.by !== note.provenance?.by) return;
  if (!change.evidence.length) throw reviewError('NOTE_SELF_TRUST_EVIDENCE_REQUIRED', { note_id: note.id });
  const references = resolved.references.filter(ref => change.evidence.includes(ref.run_id));
  const available = references.filter(ref => ref.state !== 'unavailable' && ref.provenance.initiator !== 'unknown');
  if (!available.length) throw reviewError('NOTE_SELF_TRUST_EVIDENCE_UNAVAILABLE', { note_id: note.id });
  // In addition to the current selected scope, honor any scope explicitly
  // attached to the authored note. Unknown dimensions cannot prove coverage.
  // This public review surface selects HTTP METHOD /path operations. A run
  // for another transport cannot cover one merely by sharing its spelling.
  const covered = available.filter(ref => ref.state === 'available' && ref.scope.operation && ref.scope.protocol === 'http'
    && ref.provenance.transport === 'api_request:http'
    && !resolved.warnings.some(warning => warning.run_id === ref.run_id && warning.code === 'EVIDENCE_SCOPE_UNKNOWN')
    && (note.provenance?.evidence ?? []).every(prior => ['operation', 'protocol', 'environment', 'provider', 'contract_digest']
      .every(key => prior.scope?.[key] == null || prior.scope[key] === ref.scope[key])));
  if (!covered.length) throw reviewError('NOTE_SELF_TRUST_EVIDENCE_SCOPE', { note_id: note.id });
  const previous = (entry.note_reviews ?? []).filter(review => review.note_id === note.id);
  const used = new Set([...(note.provenance?.evidence ?? []).map(ref => ref.run_id), ...previous.flatMap(review => review.evidence)]);
  // Legacy date-only provenance cannot establish ordering within that day.
  const time = value => Date.parse(value.length === 10 ? `${value}T23:59:59.999Z` : value);
  const after = Math.max(time(note.provenance.recorded_at ?? note.provenance.at), ...previous.map(review => time(review.at)));
  if (!covered.some(ref => !used.has(ref.run_id) && Date.parse(ref.provenance.observed_at) > after
    && Date.parse(ref.provenance.observed_at) <= Date.parse(change.at)))
    throw reviewError('NOTE_SELF_TRUST_EVIDENCE_OLD', { note_id: note.id });
}

export function normalizeReview(change) {
  const { notes, decision, by, actor, limits, reason, at } = change;
  if (!Array.isArray(notes) || !notes.length || notes.length > 256 || !notes.every(id => typeof id === 'string' && NOTE_DIGEST.test(id)))
    throw reviewError('NOTE_DIGEST_REQUIRED');
  if (!REVIEW_DECISIONS.includes(decision)) throw reviewError('NOTE_REVIEW_DECISION_INVALID');
  validateReviewActor(by, actor);
  if (decision !== 'trusted' && (typeof reason !== 'string' || !reason.trim())) throw reviewError('NOTE_REVIEW_REASON_REQUIRED');
  if (reason !== undefined) validateReviewText(reason);
  if (limits !== undefined) { validateReviewText(limits); if (decision !== 'trusted') throw reviewError('NOTE_REVIEW_INVALID'); }
  if (!validNoteDate(at)) throw reviewError('NOTE_REVIEW_INVALID');
  return { notes: [...new Set(notes)], decision, by, actor, at, ...(limits === undefined ? {} : { limits }),
    ...(reason === undefined ? {} : { reason }), evidence: validateReviewEvidence(change.evidence ?? []) };
}
export function applyNoteReviews(entry, operation, input, resolveEvidence) {
  const change = normalizeReview(input);
  const history = assertWritableNoteHistory(entry, operation);
  const targets = change.notes.map(id => history.records.find(record => record.id === id));
  if (targets.some(note => !note)) throw staleNoteError(history);
  const resolved = resolveEvidence(change.evidence);
  const reviews = [], held_back = [], appended = [];
  for (const note of targets) {
    if (change.decision === 'trusted' && note.superseded?.kind === 'authored') {
      if (change.notes.length === 1) throw reviewError('NOTE_REVIEW_REPLACED', { note_id: note.id, replacement: note.superseded.replacement });
      held_back.push({ note_id: note.id, code: 'NOTE_REVIEW_REPLACED', replacement: note.superseded.replacement }); continue;
    }
    const { notes, ...fields } = change;
    const review = { note_id: note.id, ...fields };
    const prior = latestNoteReview(entry, note.id);
    const same = prior && ['decision', 'by', 'actor', 'limits', 'reason'].every(key => prior[key] === review[key])
      && JSON.stringify([...prior.evidence].sort()) === JSON.stringify(review.evidence);
    if (same) { reviews.push(prior); continue; }
    if (change.decision === 'disputed') assertReviewOverturn(entry, note.id, change.evidence);
    if (change.decision === 'trusted') assertSelfTrust(entry, note, change, resolved);
    reviews.push(review); appended.push(review);
  }
  // Validate every target before changing any of them: one bad target refuses
  // the whole write; held-back authored replacements are the explicit exception.
  if (appended.length) (entry.note_reviews ??= []).push(...appended);
  return { unchanged: appended.length === 0, reviews, held_back, added: appended.length, evidence_warnings: resolved.warnings };
}

export function retirementNote(id, reason, text) {
  if (typeof id !== 'string' || !NOTE_DIGEST.test(id)) throw reviewError('NOTE_DIGEST_REQUIRED');
  if (!RETIRE_REASONS.includes(reason)) throw reviewError('NOTE_RETIRE_REASON_REQUIRED');
  if (typeof text !== 'string' || !text.trim()) throw reviewError('NOTE_RETIRE_TEXT_REQUIRED');
  validateReviewText(text);
  const note = `Retired ${id} (${reason}): ${text}`;
  validateReviewText(note);
  return note;
}
