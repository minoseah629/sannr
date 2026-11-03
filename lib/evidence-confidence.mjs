// Evidence grades describe support retained in this scope, not the truth of
// an author's explanation. All presentation surfaces share these rules.
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { freshnessFor, liveContractDigest } from './context.mjs';
import { resolveConfig } from './config.mjs';
import { loadHttpContract } from './http-operation-context.mjs';
import { activeStackScopeFor } from './stack-scope.mjs';
import { CONTRACT_CANDIDATES } from './setup-contract.mjs';
import { showObservationSummaries } from './show-observations.mjs';
import { inspectNoteHistory } from './note-history.mjs';
import { validNoteOperations } from './note-key.mjs';
import { explicitNoteClaims as explicitClaims } from './note-evidence.mjs';
import { decorateNoteRecord } from './note-projection.mjs';

const DAY = 86400000;
const rank = { written: 0, observed: 1, asserted: 2, verified: 3 };
const date = value => typeof value === 'string' ? Date.parse(value) : NaN;
const fresh = (at, now, staleDays) => Number.isFinite(date(at)) && date(at) <= now && now - date(at) <= staleDays * DAY;
const success = item => item.outcome === 'success' && item.response_status >= 200 && item.response_status < 300 && !(item.assertions?.failed > 0);
const asserted = item => success(item) && Number.isSafeInteger(item.assertions?.passed) && item.assertions.passed > 0 && item.assertions.failed === 0;

function latestResponses(summary, now, staleDays) {
  if (!summary || summary.state !== 'observed' || summary.issues?.length || summary.omissions?.operations) return [];
  const at = summary.latest_recorded_observed_at;
  if (!fresh(at, now, staleDays)) return [];
  const latest = (summary.observations ?? []).filter(item => date(item.observed_at) === date(at));
  if (!latest.length || latest.length !== summary.latest_tied_observations) return [];
  return latest.every(item => Number.isInteger(item.response_status) && item.evidence?.length
    && item.evidence.every(ref => ref.state === 'matching')) ? latest : [];
}

export function evidenceClass({ entry = {}, summary, freshness, now = Date.now(), staleDays = 180 } = {}) {
  const latest = latestResponses(summary, now, staleDays);
  const learned = freshness?.confidence === 'verified' && fresh(entry.verified_at, now, staleDays)
    && !(Array.isArray(entry.status_codes) && entry.status_codes.length && !entry.status_codes.some(code => Number.isInteger(code) && code >= 200 && code < 300));
  const recordedAt = date(summary?.latest_recorded_observed_at);
  const failedAfterLearn = Number.isFinite(recordedAt) && recordedAt >= date(entry.verified_at)
    && (!latest.length || !latest.every(success));
  const unavailable = summary?.issues?.length || summary?.omissions?.operations || summary?.state === 'unavailable';
  if (learned && !failedAfterLearn && !unavailable) return { class: 'verified', reason: 'fresh-learn', at: entry.verified_at, current_success: true };
  if (latest.length) {
    const currentSuccess = latest.every(success);
    const hasAssertions = latest.every(asserted);
    return { class: hasAssertions ? 'asserted' : 'observed',
      reason: hasAssertions ? 'passing-client-assertions' : currentSuccess ? 'response-without-passing-assertions' : 'latest-response-failed',
      at: summary.latest_recorded_observed_at, current_success: currentSuccess };
  }
  return { class: 'written', reason: summary?.scope_reason ?? summary?.unavailable_reason
    ?? (unavailable ? 'history-unavailable' : summary?.latest_recorded_observed_at ? 'latest-evidence-not-eligible' : entry.verified_at ? 'learn-not-fresh' : 'no-eligible-response'),
    at: null, current_success: false };
}

export function evidenceClassCounts(rows = []) {
  const counts = { written: 0, observed: 0, asserted: 0, verified: 0 };
  for (const row of rows) {
    const key = (row?.evidence_class ?? row)?.class;
    if (Object.hasOwn(counts, key)) counts[key]++;
  }
  return counts;
}
export const formatEvidenceClasses = counts => ['written', 'observed', 'asserted', 'verified'].map(key => `${counts?.[key] ?? 0} ${key}`).join(', ');
export const formatEvidenceClassCounts = formatEvidenceClasses;

export function evidenceOperations(ctx, { config, contract } = {}) {
  const operations = new Set([...Object.keys(ctx?.operations ?? {}), ...(contract?.routes ?? []).map(route => route.op)]);
  if (config) for (const entry of Object.values(ctx?.api_context?.operations ?? {})) {
    const identity = entry?.identity;
    const owned = identity?.stack === undefined || identity.stack === config.stack;
    // Authored guidance belongs to this store even while unsorted or while
    // its old environment/contract is not selected. It contributes written
    // inventory; only a separately bound eligible response can upgrade it.
    if (owned && identity?.protocol === 'http' && entry.observations?.some(item => item.basis === 'authored')) operations.add(identity.operation);
    if (identity?.protocol === 'http' && identity.provider === config.baseUrl && identity.environment === (config.name ?? 'default')
      && identity.stack === config.stack && identity.contractDigest === (contract?.digest ?? null)) operations.add(identity.operation);
  }
  return [...operations].filter(value => typeof value === 'string').sort();
}

export function stackEvidenceClasses(root, ctx, { config, contract, now = Date.now(), env = process.env, commits = false } = {}) {
  config ??= resolveConfig(root);
  if (contract === undefined) {
    const selected = activeStackScopeFor(root) ? config.contract : process.env.API_CONTRACT ?? config.contract ?? ctx?.api?.contract;
    const file = typeof selected === 'string' && selected ? resolve(root, selected)
      : activeStackScopeFor(root) ? null : CONTRACT_CANDIDATES.map(name => join(root, name)).find(existsSync);
    contract = file ? loadHttpContract(file, { pathPrefix: config.contractPathPrefix }) : null;
  }
  const keys = evidenceOperations(ctx, { config, contract });
  const { results: summaries } = showObservationSummaries(root, keys, { config, contract, now, env, snapshot: ctx });
  const legacyDigest = liveContractDigest(root, ctx);
  const operations = new Map(keys.map(operation => {
    const entry = ctx?.operations?.[operation] ?? {};
    const summary = summaries.get(operation)?.summary;
    const freshness = freshnessFor(entry, root, legacyDigest, now, { commits });
    return [operation, { operation, entry, summary, freshness,
      evidence_class: evidenceClass({ entry, summary, freshness, now, staleDays: config?.defaults?.staleDays ?? 180 }) }];
  }));
  return { counts: evidenceClassCounts(operations.values()), operations };
}

// Only unconditional, present-tense claims are mechanically comparable. The
// deliberately narrow grammar does not guess at conditional or historical prose.
function responseCodes(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return [];
  return [response.code, response.error?.code, ...(Array.isArray(response.errors) ? response.errors.slice(0, 8).map(item => item?.code) : [])]
    .map(value => Number.isSafeInteger(value) ? String(value) : value)
    .filter(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u.test(value));
}
function applicableRecords(entry, operation) {
  const history = inspectNoteHistory(entry);
  if (['invalid', 'changed'].includes(history.state)) return [];
  return history.active.filter(record => record.kind !== 'machine'
    && (!Object.hasOwn(record.provenance ?? {}, 'operations') || validNoteOperations(record.provenance.operations) && record.provenance.operations.includes(operation)));
}
export function deriveNoteContradictions(ctx, { operation, status, response } = {}) {
  const codes = responseCodes(response), flags = [];
  for (const record of [...applicableRecords(ctx?.stack_facts, operation), ...applicableRecords(ctx?.operations?.[operation], operation)]) {
    const claim = explicitClaims(record.text);
    if (claim.status !== undefined && Number.isInteger(status) && claim.status !== status) flags.push({ note_id: record.id, kind: 'status' });
    if (claim.code && codes.length && !codes.includes(claim.code)) flags.push({ note_id: record.id, kind: 'error-code' });
  }
  return [...new Map(flags.map(flag => [`${flag.note_id}:${flag.kind}`, flag])).values()].slice(0, 32);
}

function noteGrade(record, { summary, freshness, now, staleDays }) {
  let grade = { class: 'written', reason: 'authored-without-eligible-linked-evidence', at: null, current_success: false };
  for (const ref of record.provenance?.evidence ?? []) {
    if (ref.state !== 'available') continue;
    for (const observation of summary?.observations ?? []) {
      if (!fresh(observation.observed_at, now, staleDays) || !observation.evidence?.every(item => item.state === 'matching')) continue;
      if (!observation.evidence.some(item => item.digest === ref.digest && item.path?.split('/').at(-1) === `${ref.run_id}.json`)) continue;
      const kind = ref.provenance?.initiator === 'cli.learn' && freshness?.confidence === 'verified' && !freshness.age?.stale && success(observation) ? 'verified' : asserted(observation) ? 'asserted' : 'observed';
      if (rank[kind] > rank[grade.class]) grade = { class: kind, reason: 'linked-response-evidence', at: observation.observed_at, current_success: success(observation) };
    }
  }
  return grade;
}

export function rankNoteRecords(records = [], { summary, freshness, history, now = Date.now(), staleDays = 180, ...options } = {}) {
  const latest = latestResponses(summary, now, staleDays);
  return records.map(record => {
    const contradictions = new Set();
    const claim = explicitClaims(record.text);
    if (claim.status !== undefined && latest.some(item => item.response_status !== claim.status)) contradictions.add('status');
    for (const item of latest) for (const flag of item.note_contradictions ?? []) if (flag.note_id === record.id) contradictions.add(flag.kind);
    const grade = ['invalid', 'changed'].includes(history?.state)
      ? { class: 'written', reason: 'note-history-review-required', at: null, current_success: false }
      : noteGrade(record, { summary, freshness, now, staleDays });
    return { ...decorateNoteRecord(record, { ...options, history, now }), evidence_class: grade, contradictions: [...contradictions] };
  }).sort((a, b) => rank[b.evidence_class.class] - rank[a.evidence_class.class]
    || (date(b.provenance?.at) || 0) - (date(a.provenance?.at) || 0) || a.index - b.index);
}
export function projectKnownNotes(entry, options = {}) {
  const history = inspectNoteHistory(entry, options.operation);
  const records = rankNoteRecords(history.active, { ...options, entry, history });
  return { notes: records.map(record => record.text), records, history };
}
