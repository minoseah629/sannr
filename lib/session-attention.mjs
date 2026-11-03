// A deterministic projection of retained facts, not an assessment. Build from
// all filtered rows before the display bound; success never removes a failure.
// No source file, response value or network access is available to this module.
import { createHash } from 'node:crypto';

export const ATTENTION_BOUND = 50;
const KINDS = Object.freeze({
  'http-failure': 'HTTP failures',
  'transport-failure': 'Transport failures',
  'request-error': 'Other errors without a response',
  'assertion-failure': 'Failed assertions',
  'refusal': 'Pre-traffic refusals',
  'leftover': 'Resources left behind',
  'drift': 'Recorded drift',
  'proposed-draft': 'Proposed drafts',
  'unresolved-placeholder': 'Unresolved placeholders',
  'missing-receipt': 'Missing receipts',
  'unknown-attribution': 'Unknown attribution',
});
const order = (a, b) => (b.at ?? '').localeCompare(a.at ?? '') || a.id.localeCompare(b.id);
const TRANSPORT_CODES = new Set(['REQUEST_TIMEOUT', 'TRANSPORT_FAILED', 'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND',
  'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'PROTOCOL_TRANSPORT_ERROR', 'FEEDBACK_REQUEST_TIMEOUT', 'FEEDBACK_TRANSPORT_FAILED']);

export function projectSessionAttention(sessions, { bound = ATTENTION_BOUND, sources = {}, empty = null } = {}) {
  bound = Number.isSafeInteger(bound) ? Math.min(200, Math.max(1, bound)) : ATTENTION_BOUND;
  const items = [];
  const add = (kind, session, row, summary, count = 1, extra = {}) => {
    const basis = { ...(row.basis ?? {}), ...extra };
    const sessionId = session?.id ?? null;
    const id = createHash('sha256').update(JSON.stringify([kind, sessionId, row.at, basis, summary])).digest('hex');
    items.push({ id: `attention-${id}`, kind, at: row.at ?? null, session_id: sessionId,
      stack: row.stack ?? null, operation: row.operation ?? null, method: row.method ?? null,
      operation_anchor: row.operation_anchor ?? null, basis, summary, count });
  };
  for (const session of sessions) for (const entry of session.rows) {
    if (entry.kind === 'batch') {
      if (entry.left_behind > 0) add('leftover', session, entry, `${entry.left_behind} resources recorded as left behind; their values are withheld.`, entry.left_behind);
      if (entry.refusal) add('refusal', session, entry, `${entry.refusal}; attempted ${entry.attempted ?? 'not recorded'}.`);
    }
    for (const row of entry.kind === 'batch' ? entry.rows : [entry]) {
      if (row.status >= 400) add('http-failure', session, row, `HTTP ${row.status} was recorded; later responses do not erase this failure.`);
      if (row.assertions?.failed > 0) add('assertion-failure', session, row, `${row.assertions.failed} failed assertions (${row.assertions_basis}).`, row.assertions.failed);
      if (row.left.refusal) add('refusal', session, row, `${row.left.refusal}; attempted ${row.left.attempted ?? 'not recorded'}.`);
      if ((row.left.error ?? row.left.refusal) === 'UNRESOLVED_PLACEHOLDER') add('unresolved-placeholder', session, row, 'UNRESOLVED_PLACEHOLDER was recorded; an input remained unresolved.');
      else if (row.left.error && row.status === null && !row.left.refusal) add(TRANSPORT_CODES.has(row.left.error) ? 'transport-failure' : 'request-error', session, row, `${row.left.error}; no response was recorded.`);
      if (row.produced.drift.length) {
        const kinds = [...new Set(row.produced.drift)];
        add('drift', session, row, `${row.produced.drift.length} drift records: ${kinds.slice(0, 8).join(', ')}${kinds.length > 8 ? `; ${kinds.length - 8} additional kinds omitted` : ''}.`, row.produced.drift.length);
      }
      for (const draft of row.produced.drafts) add('proposed-draft', session, row, `Draft proposed: ${draft.reason}; this is not an accepted claim.`, 1, { draft_id: draft.id });
      if (row.basis.receipt_state === 'missing') add('missing-receipt', session, row, 'An outcome references a run receipt that is not available here; its response content and provenance cannot be inspected.');
      const unknown = [];
      if (row.attribution?.initiator === 'unknown') unknown.push('host');
      if (!row.attribution?.session_id) unknown.push('host process');
      if (!row.operation_anchor) unknown.push(row.operation === 'withheld' ? 'operation (withheld)' : 'canonical operation');
      if (unknown.length) add('unknown-attribution', session, row, `${unknown.join(', ')} not recorded or unavailable; no attribution was inferred.`);
    }
  }
  const usageOnly = sources.usage_log?.project_rows_without_evidence ?? 0;
  if (usageOnly) add('missing-receipt', null, { basis: { source: 'usage log; legacy project-name scope' } },
    `${usageOnly} usage-log rows for this project name have no local run receipt. Session, operation and filter applicability are unknown.`, usageOnly);
  items.sort(order);
  const shown = items.slice(0, bound), groups = Object.entries(KINDS).map(([kind, title]) => {
    const total = items.filter(item => item.kind === kind).length, kept = shown.filter(item => item.kind === kind);
    return { kind, title, total, shown: kept.length, omitted: total - kept.length, items: kept };
  }).filter(group => group.total);
  const gaps = [sources.unreadable_files ? `${sources.unreadable_files} unreadable files` : null,
    sources.files_beyond_read_bound ? `${sources.files_beyond_read_bound} files beyond the read bound` : null,
    sources.unsafe_directories ? `${sources.unsafe_directories} unsafe directories` : null].filter(Boolean);
  const unavailable = !sessions.length && empty?.reason !== 'filtered-out';
  return { v: 1, state: gaps.length ? (sessions.length ? 'partial' : 'unavailable') : unavailable ? 'unavailable' : items.length ? 'recorded' : 'empty',
    bound, total: items.length, shown: shown.length, omitted: items.length - shown.length, groups,
    basis: 'Recorded local evidence only; grouped by kind, newest first within each kind. Counts describe attention items, not unique calls. Earlier failures remain after later success.',
    empty: !items.length ? (unavailable ? 'No readable execution evidence is available; attention cannot be assessed.' : empty?.reason === 'filtered-out'
      ? 'No execution evidence matches the selected filters.' : 'No attention items in the recorded evidence for this range.') : null,
    unknowns: ['Account-fact delivery is not recorded; it is not counted as zero.', 'Host telemetry is not recorded.',
      ...(gaps.length ? [`Attention is incomplete: ${gaps.join('; ')}.`] : []),
      ...(usageOnly ? ['Usage-log-only receipt gaps are unscoped; they cannot be assigned to a session, operation or selected filter.'] : [])] };
}
