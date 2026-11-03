// Authored basis is immutable provenance. Legacy inference is a read model,
// deliberately restricted to the opening words, never a stored assertion.
import { secretIn } from './verdicts.mjs';
import { hasCommentMarkup } from './block-text.mjs';

export const NOTE_BASIS_KINDS = Object.freeze(['asserted-run', 'observed-run', 'earlier-run-report',
  'contract-openapi', 'documentation', 'documentation-change', 'local-source', 'declared-metadata', 'client-tooling']);
const fail = code => { throw Object.assign(new Error({
  NOTE_BASIS_INVALID: `Choose a note basis: ${NOTE_BASIS_KINDS.join(', ')}.`,
  NOTE_BASIS_REQUIRED: '--source requires --basis.',
  NOTE_SOURCE_INVALID: 'Use a bounded source reference without credentials, URL query values, control characters or machine-local paths.',
  SECRET_IN_NOTE: 'The source reference appears to contain credentials; no note was saved.',
}[code]), { code }); };

export function validNoteSource(source) {
  if (typeof source !== 'string' || !source.trim() || source !== source.trim() || source.length > 2048
    || /[\x00-\x1f\x7f-\x9f\p{Cf}\u2028\u2029]/u.test(source) || hasCommentMarkup(source)
    || secretIn(source, { allowAuthReferences: true })
    || /(?:^|\s)(?:\/|~[\/\\]|[A-Za-z]:[\/\\]|\\\\)/u.test(source)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
    try { const url = new URL(source); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.search; }
    catch { return false; }
  }
  return !source.split(/[\/\\]/u).includes('..');
}
export function noteBasisStamp(basis, source) {
  if (basis === undefined && source === undefined) return {};
  if (basis === undefined) fail('NOTE_BASIS_REQUIRED');
  if (!NOTE_BASIS_KINDS.includes(basis)) fail('NOTE_BASIS_INVALID');
  if (source !== undefined) {
    if (typeof source === 'string' && secretIn(source, { allowAuthReferences: true })) fail('SECRET_IN_NOTE');
    if (!validNoteSource(source)) fail('NOTE_SOURCE_INVALID');
  }
  return { basis, ...(source === undefined ? {} : { source }) };
}
export function noteBasis(record) {
  const stamp = record.provenance;
  if (NOTE_BASIS_KINDS.includes(stamp?.basis)) return { kind: stamp.basis, inferred: false,
    ...(validNoteSource(stamp.source) ? { source: stamp.source } : {}) };
  const opening = String(record.text ?? '').slice(0, 256).trim().replace(/^[\s*#>-]+/u, '');
  const rules = [
    ['client-tooling', /^(?:(?:[\w-]+\s+)?client\s+(?:limitation|behavior|issue|note)|tooling\b|tool\s+limitation)/iu],
    ['earlier-run-report', /^(?:historical\s+(?:prep\s+)?report|earlier[- ]run\s+report|prior\s+run\s+report|reported\s+(?:earlier|historical))/iu],
    ['documentation-change', /^(?:documentation|docs?)\s+(?:change|update|diff)/iu],
    ['documentation', /^(?:written[- ]down\s+from\s+docs?\b|documented\b|from\s+(?:the\s+)?docs?\b|documentation\b|docs?\s*[:—-])/iu],
    ['contract-openapi', /^(?:openapi\b|contract\b|from\s+(?:the\s+)?(?:openapi|contract)\b)/iu],
    ['local-source', /^(?:local\s+(?:source|code|tests?)\b|source[- ](?:code|derived)\b|from\s+(?:local\s+)?source\b|code\s+inspection\b)/iu],
    ['declared-metadata', /^(?:declared\s+(?:metadata|configuration)\b|metadata\b)/iu],
    ['asserted-run', /^(?:asserted\b|assertion[- ]checked\b)/iu],
    ['observed-run', /^(?:observed\b|observation\b)/iu],
  ];
  return { kind: rules.find(([, pattern]) => pattern.test(opening))?.[0] ?? 'unknown', inferred: true };
}
export function noteAuthor(record) {
  const stamp = record.provenance, by = stamp?.by ?? 'unknown';
  // Import/summary tool names predate actor. They must never become people
  // simply because they lack an agent marker (or inherit one from a client).
  const imported = stamp?.actor === 'imported' || /(?:^|[\s_-])(?:import(?:ed|er)?|summary|summarizer)(?:$|[\s_-])/iu.test(by)
    || /^(?:import|summary)(?:$|[_-])/iu.test(stamp?.kind ?? '');
  const category = imported ? 'imported' : ['person', 'agent'].includes(stamp?.actor) ? stamp.actor
    : /(?:agent|codex|claude|assistant|gpt|bot)(?:\b|[_-])/iu.test(by) || record.kind === 'machine' ? 'agent'
      : stamp ? 'person' : 'unknown';
  return { by, category, inferred: imported ? stamp?.actor !== 'imported' : stamp?.actor === undefined };
}
