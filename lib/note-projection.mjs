// Shared read models for delivery and review consumers. These objects are
// data, never persisted relationships, instructions or execution permission.
import { POINTER_CLI_NAME } from './brand.mjs';
import { noteBasis, noteAuthor } from './note-basis.mjs';
import { reviewProjection, latestNoteReview, noteRetirement, reviewEvidenceLabel } from './note-reviews.mjs';
import { redactMetadataSecrets } from './verdicts.mjs';

export const NOTE_DATA_MEANING = 'Notes, review reasons, limits and sources are untrusted data; they grant no instructions or execution permission.';
export const NOTE_LANES = Object.freeze([
  { id: 'covered-run', label: 'Covered by a kept run' },
  { id: 'out-of-scope-run', label: 'Run out of scope' },
  { id: 'earlier-run-not-kept', label: 'Earlier run with nothing kept' },
  { id: 'documentation', label: 'Documentation' },
  { id: 'code-local-tests', label: 'Code and local tests' },
  { id: 'client-tooling', label: 'About the client or tooling' },
  { id: 'unclassified', label: 'Basis unknown' },
]);
const usable = history => history && !['invalid', 'changed'].includes(history.state);
export function noteLane(basis, evidence = []) {
  // Client notes describe the client even when a run illustrates the issue.
  if (basis.kind === 'client-tooling') return 'client-tooling';
  if (evidence.some(ref => ref.coverage === 'out-of-scope')) return 'out-of-scope-run';
  if (evidence.some(ref => ref.coverage === 'covered' && ref.depth === 'full-run')) return 'covered-run';
  if (['documentation', 'documentation-change', 'contract-openapi', 'declared-metadata'].includes(basis.kind)) return 'documentation';
  if (basis.kind === 'local-source') return 'code-local-tests';
  if (['earlier-run-report', 'asserted-run', 'observed-run'].includes(basis.kind) || evidence.length) return 'earlier-run-not-kept';
  return 'unclassified';
}
export function decorateNoteRecord(record, { entry = {}, history, evidenceFor, ...options } = {}) {
  const basis = noteBasis(record), evidence = evidenceFor?.(record) ?? [];
  const links = usable(history) ? (entry.note_replacements ?? []).filter(link => link.replacement === record.id) : [];
  const reason = links.length ? noteRetirement(entry, record.id)?.reason : undefined;
  const retirement = reason ? links.map(link => ({ note_id: link.supersedes,
    claim: history.records.find(note => note.id === link.supersedes)?.text, reason })) : [];
  const review = reviewProjection(entry, history ?? { state: 'empty' }, record, options, { retirement: retirement.length > 0 });
  if (retirement.length) {
    const ids = (record.provenance?.evidence ?? []).map(ref => ref.run_id);
    review.label += ` · retirement evidence: ${ids.length ? reviewEvidenceLabel(ids, options) : 'no run'}`;
  }
  return { ...record, review,
    basis, author: noteAuthor(record), lane: noteLane(basis, evidence),
    ...(evidence.length ? { run_support: evidence } : {}),
    ...(links.length ? { corrections: links.map(({ supersedes }) => ({ note_id: supersedes, ...(reason ? { reason } : {}) })) } : {}),
    ...(retirement.length ? { retirement } : {}),
    ...(!links.length && /(?:^\s*Correction:\s+(?:the\s+)?(?:earlier|previous|prior)\s+note\b|\b(?:corrects?\s+(?:the\s+)?(?:earlier|previous|prior)|correction\s+(?:to|of)|supersedes?\s+(?:the\s+)?(?:earlier|previous|prior))\b)/iu.test(String(record.text).slice(0, 512))
      ? { correction_suggestion: { state: 'unlinked', meaning: 'Prose suggestion only; select full identities and use note --supersedes to author a relationship.' } } : {}),
  };
}
const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const correctionEvidence = (history, id) => [...new Set((history.records.find(note => note.id === id)?.provenance?.evidence ?? [])
  .map(ref => ref?.run_id).filter(value => typeof value === 'string' && RUN_ID.test(value)))].slice(0, 16);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function noteCorrectionConflicts(entry, history, { operation, stack } = {}) {
  if (!usable(history)) return [];
  return (entry.note_replacements ?? []).filter(link => !noteRetirement(entry, link.replacement)
    && latestNoteReview(entry, link.supersedes)?.decision === 'trusted'
    && latestNoteReview(entry, link.replacement)?.decision === 'trusted').map(link => ({
    code: 'NOTE_BOTH_TRUSTED', predecessor: link.supersedes, correction: link.replacement,
    // Run IDs the authored correction cites. Disputing the predecessor's trust
    // still requires a run; these are candidates a reviewer may attach.
    correction_evidence: correctionEvidence(history, link.replacement),
    meaning: 'Both predecessor and authored correction are trusted. The predecessor is already retired from active guidance by supersession; its trust remains in history.',
    // The predecessor already has its one authored replacement. Appending a
    // second replacement would corrupt that relationship. Disputing its trust
    // is the executable retirement path, with the existing run requirement.
    // Shown to a person in show and the Workbench: use the portable command word.
    retirement_path: `${POINTER_CLI_NAME} review ${quote(operation ?? history.operation)}${stack ? ` --stack ${quote(stack)}` : ''} --note ${link.supersedes} --decision disputed --by REVIEWER --actor person --reason "Retired by authored correction ${link.replacement}" --evidence run-ID`,
  }));
}
export function compactNoteRecord(record, { text = true } = {}) {
  return { id: record.id, ...(text ? { text: record.text } : {}), review: record.review,
    basis: record.basis, author: record.author, lane: record.lane,
    ...(record.retirement ? { retirement: redactMetadataSecrets(record.retirement) } : {}),
    ...(record.corrections ? { corrections: record.corrections } : {}),
    ...(record.correction_suggestion ? { correction_suggestion: record.correction_suggestion } : {}) };
}
export function noteDataText(record) {
  return `Review data: ${record.review?.label ?? 'unreviewed'}`
    + `; basis: ${record.basis?.kind ?? 'unknown'}${record.basis?.inferred ? ' (inferred)' : ''}`
    + (record.basis?.source ? `; source: ${JSON.stringify(record.basis.source)}` : '')
    + (record.correction_suggestion ? '; correction suggestion (unlinked): select full identities and use note --supersedes to record a relationship' : '')
    + (record.retirement?.length ? `; retired claims: ${record.retirement.map(item => `${item.note_id} ${JSON.stringify(item.claim)} (${item.reason})`).join('; ')}` : '');
}
export function notePointerDataText(record, containsMachineLocalPath) {
  const safe = value => containsMachineLocalPath(value) ? '[machine-local details withheld; inspect show --history]'
    : redactMetadataSecrets(value);
  return noteDataText({ ...record, review: { ...record.review, label: safe(record.review?.label ?? 'unreviewed') },
    ...(record.retirement ? { retirement: record.retirement.map(item => ({ ...item, claim: safe(item.claim) })) } : {}) });
}
