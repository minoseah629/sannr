// Stack facts are a projection of the existing note history, not a second
// history or verification system. Applicability is author-supplied metadata.
import { inspectNoteHistory } from './note-history.mjs';
import { validNoteOperations } from './note-key.mjs';
import { redactMetadataSecrets } from './verdicts.mjs';
import { CLI_NAME } from './brand.mjs';
import { decorateNoteRecord, NOTE_DATA_MEANING } from './note-projection.mjs';
import { reviewedNoteDelivery } from './mcp-delivery.mjs';

export const MAX_REQUEST_STACK_FACTS = 5;
const own = (value, key) => value !== null && typeof value === 'object' && Object.hasOwn(value, key);

export function stackFactsProjection(ctx, { operation, stack, maxFacts = MAX_REQUEST_STACK_FACTS, rankRecords } = {}) {
  const history = inspectNoteHistory(ctx?.stack_facts);
  // Once saved applicability was edited, its old extent cannot be recovered
  // from the current file alone. Do not reinterpret a missing operations list
  // as new permission to deliver the claim on every request. Raw history stays
  // available through show; review re-establishes a deliberate baseline.
  if (['invalid', 'changed'].includes(history.state)) return { history, records: [], notes: [],
    receipt: { total: history.active.length, shown: 0, omitted: history.active.length,
      ...(stack ? { show_command: `${CLI_NAME} show --stack ${stack}` } : {}),
      history_state: history.state, reason: 'note-history-review-required' } };
  const applicable = history.active.filter(record => {
    if (typeof record.text !== 'string') return false;
    // An invalid scope must never widen to every operation. History still
    // retains it for show/doctor; request delivery withholds the unsafe fact.
    if (!own(record.provenance, 'operations')) return true;
    const operations = record.provenance.operations;
    return validNoteOperations(operations)
      && (operation === undefined || operations.includes(operation));
  });
  // Ranking cannot widen applicability: the optional presenter sees only
  // already-eligible records, and its output is intersected with that set.
  const allowed = new Set(applicable.map(record => record.id));
  const decorated = applicable.map(record => decorateNoteRecord(record, { entry: ctx?.stack_facts, history }));
  const ranked = rankRecords ? rankRecords(decorated).filter(record => allowed.has(record.id)) : decorated;
  const records = ranked.slice(0, Math.max(0, maxFacts));
  return { history, records, notes: records.map(record => redactMetadataSecrets(record.text)),
    receipt: { total: applicable.length, shown: records.length, omitted: applicable.length - records.length,
      ...(stack ? { show_command: `${CLI_NAME} show --stack ${stack}` } : {}),
      ...(history.state === 'unbaselined' ? { history_state: history.state, reason: 'note-history-baseline-missing' } : {}) } };
}

export function prependStackFacts(known, ctx, { stack, operation, rankRecords } = {}) {
  if (!stack) return known;
  // Context queries expose complete facts for explicit retrieval. Request
  // envelopes get only this capped projection, never a second uncapped copy.
  const { stack_facts: queriedFacts, ...withoutStackFacts } = known ?? {};
  const projection = stackFactsProjection(ctx, { stack, operation, rankRecords });
  if (!projection.receipt.total && !projection.receipt.history_state) return queriedFacts ? withoutStackFacts : known;
  const { notes = [], ...operationContext } = withoutStackFacts;
  return { stack_facts: projection.receipt,
    notes: [...projection.notes, ...notes], ...operationContext,
    ...(rankRecords ? { note_projection: { meaning: NOTE_DATA_MEANING, records: [
      ...projection.records.map(record => reviewedNoteDelivery(record, 'stack')),
      ...(known?.note_projection?.records ?? []),
    ] } } : {}) };
}

// Known.notes always places stack facts first. Any presentation budget drops
// notes from the tail and updates the same explicit recovery receipt.
export function stackFactReceiptAfterTrim(known, keptNotes = 0) {
  if (!known?.stack_facts) return {};
  const shown = Math.min(known.stack_facts.shown, keptNotes);
  return { stack_facts: { ...known.stack_facts, shown, omitted: known.stack_facts.total - shown } };
}
