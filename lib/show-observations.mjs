// A read-only presentation bridge. Legacy learning and client observations are
// separate ledgers: neither a response nor an author's assertion renews the
// older verification stamp. The configured identity and checked evidence must
// agree before a recorded response receives the aggregate observed label.
import { httpContextIdentity, httpContextScope, httpOperationMatches, pathBelowMount, routeRequestPath } from './http-operation-context.mjs';
import { loadOperationContextSources, operationId, queryLoadedOperationContext } from './operation-context.mjs';
import { secretIn } from './verdicts.mjs';

// Text the store accepts as an identity component: bounded, without control or
// format characters and not secret-shaped (operationIdentity's own rule).
const storableText = value => typeof value === 'string' && value.trim() !== '' && value.length <= 512
  && !/[\u0000-\u001f\u007f\p{Cf}]/u.test(value) && !secretIn(value, { allowAuthReferences: true });

// The base URL a capture can be scoped to (httpContextScope's rule for the
// configured URL), and short enough to be stored as the provider.
function scopableBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      && storableText(baseUrl);
  } catch { return false; }
}

// Why no identity could be bound, in the order the checks below run. Names
// only: the configured URL and contract path are not repeated here.
export function scopeProblem(config, contract) {
  if (config.problems?.length) return 'config-problem';
  if (!contract) return 'no-contract';
  if (config.baseUrlSource === 'fallback') return 'no-base-url';
  if (config.baseUrlOverride && process.env.API_CONTRACT === undefined) return 'base-url-override-without-contract';
  if (!storableText(config.name ?? 'default')) return 'environment-unusable';
  if (!scopableBaseUrl(config.baseUrl)) return 'provider-not-eligible';
  return null;
}

/**
 * The identity a capture would have recorded for one contract operation, built
 * the way the client builds a request URL (base URL, then the contract path;
 * see contractMount and routeRequestPath), or the reason none can be bound: a scope problem above,
 * or one of `not-in-contract`, `not-unique-in-contract`, `outside-base-path`
 * (the operation's URL is outside the configured base URL's path),
 * `route-ambiguous` (its URL matches more than one operation) and
 * `route-unmatched` (built into a request URL, its path matches no operation,
 * for example an encoded dot segment the URL parser removes).
 */
export function bindIdentity(operation, config, contract) {
  const problem = scopeProblem(config, contract);
  if (problem) return { identity: null, reason: problem };
  const matches = contract.routes.filter(route => route.op === operation);
  if (matches.length !== 1) return { identity: null, reason: matches.length ? 'not-unique-in-contract' : 'not-in-contract' };
  const target = { baseUrl: config.baseUrl, httpContract: contract };
  const scope = { baseUrl: config.baseUrl, baseUrlSource: config.baseUrlSource };
  let url;
  try { url = new URL(`${new URL(config.baseUrl).origin}${routeRequestPath(contract, config.baseUrl, matches[0])}`).href; }
  catch { return { identity: null, reason: 'provider-not-eligible' }; }
  if (!httpContextScope(url, target, scope).eligible) return { identity: null, reason: 'outside-base-path' };
  const identity = httpContextIdentity(url, target, { method: matches[0].method, environment: config.name ?? 'default', ...(config.stack ? { stack: config.stack } : {}), ...scope });
  if (identity?.operation === operation) return { identity, reason: null };
  // Another operation answers this path first, or none or several do; capture
  // could not record this operation either, so say which.
  if (identity) return { identity: null, reason: 'route-ambiguous' };
  const below = pathBelowMount(contract, config.baseUrl, new URL(url).pathname);
  const found = below === null ? { exact: [], matches: [] } : httpOperationMatches(contract, matches[0].method, below);
  return { identity: null, reason: found.exact.length > 1 || found.matches.length > 1 ? 'route-ambiguous' : 'route-unmatched' };
}

export const selectedIdentity = (operation, config, contract) => bindIdentity(operation, config, contract).identity;

const MEANING = 'Retained responses in the selected scope, not current execution verification or proof of an authored explanation. Assertion counts belong only to their saved response.';

// The words `show` and the map both use when a query's bounds leave a record
// out: the record could hold a newer response, so no label is given.
export const HISTORY_BEYOND_READ_BOUND = 'history beyond the read bound';

function emptySummary(identity) {
  return { state: 'none', scope: identity, observed_at: null, observed_status_codes: [],
    observation_count: 0, successful_response_count: 0, latest_response_status: null,
    latest_assertions: null, latest_outcome: null, latest_recorded_observed_at: null,
    latest_recorded_status_codes: [], latest_tied_observations: 0, latest_response_eligible: false,
    observations: [], excluded: {}, omissions: {}, issues: [], meaning: MEANING };
}

function unresolvedSummary(config, reason) {
  const summary = emptySummary(null);
  summary.state = 'scope-unresolved';
  if (reason) summary.scope_reason = reason;
  summary.issues = (config.problems ?? []).map(problem => ({ code: problem.code }));
  summary.meaning = `Current provider, environment and contract could not be bound. Inspect the separately labelled scoped history. ${MEANING}`;
  return summary;
}

// An identity the store cannot hold or query (over its bounds, a control or
// format character, secret-shaped text) is named, never thrown past the caller.
function unavailableSummary(identity, code) {
  const summary = emptySummary(identity);
  summary.state = 'unavailable';
  summary.issues = [{ code }];
  return summary;
}
const contextCode = error => /^CONTEXT_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'CONTEXT_COMMAND_FAILED';

// The one rule set, applied to a query result. `candidates` keeps every client
// record with the reason it was or was not eligible; callers that only need
// the label read `summary`, which is exactly what `show` prints.
function summarize(identity, saved, config, now) {
  const summary = emptySummary(identity);
  summary.omissions = { ...saved.omissions, observations: 0 };
  summary.issues = saved.issues;
  if (saved.skipped?.length) summary.skipped = saved.skipped;
  const clientCandidates = [];
  const excluded = reason => { summary.excluded[reason] = (summary.excluded[reason] ?? 0) + 1; };
  for (const entry of saved.operations) {
    summary.omissions.observations += entry.omitted_observations;
    for (const observation of entry.observations) {
      if (observation.source.kind !== 'client' || observation.source.tool !== 'api_request:http'
        || observation.basis !== 'observed' || observation.verification !== 'client-observation') {
        excluded('authored-or-non-http-client'); continue;
      }
      const candidate = { observation, operation_id: entry.operation_id, repository: entry.repository, eligible: false, reason: null };
      clientCandidates.push(candidate);
      const reject = reason => { candidate.reason = reason; excluded(reason); };
      const age = now - Date.parse(observation.observed_at);
      if (age < 0) { reject('future-observation'); continue; }
      if (age > config.defaults.staleDays * 86400000) { reject('stale-observation'); continue; }
      if (!observation.complete || !Number.isInteger(observation.response_status)) {
        reject('incomplete-or-status-unavailable'); continue;
      }
      if (!observation.evidence.length || observation.evidence.some(ref => ref.state !== 'matching')) {
        reject('evidence-not-matching'); continue;
      }
      candidate.eligible = true;
      summary.observations.push({ observation_id: observation.id, operation_id: entry.operation_id,
        repository: entry.repository, observed_at: observation.observed_at,
        response_status: observation.response_status, outcome: observation.outcome,
        assertions: observation.assertions ?? null, evidence: observation.evidence,
        verification: observation.verification,
        ...(observation.note_contradictions !== undefined ? { note_contradictions: observation.note_contradictions } : {}) });
    }
  }
  summary.observations.sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at)
    || a.observation_id.localeCompare(b.observation_id));
  summary.observation_count = summary.observations.length;
  summary.successful_response_count = summary.observations.filter(item => item.response_status >= 200 && item.response_status < 300).length;
  summary.observed_status_codes = [...new Set(summary.observations.map(item => item.response_status))].sort((a, b) => a - b);
  const latest = summary.observations[0];
  summary.observed_at = latest?.observed_at ?? null;
  summary.latest_response_status = latest?.response_status ?? null;
  summary.latest_assertions = latest?.assertions ?? null;
  summary.latest_outcome = latest?.outcome ?? null;
  // UUID order is not chronology. Every client record at the newest stored
  // timestamp must support a positive label; an unavailable/error/failed peer
  // cannot be hidden by an older eligible response or a lexical UUID tie-break.
  let tied = [];
  if (clientCandidates.length) {
    const newest = Math.max(...clientCandidates.map(item => Date.parse(item.observation.observed_at)));
    tied = clientCandidates.filter(item => Date.parse(item.observation.observed_at) === newest);
    summary.latest_recorded_observed_at = new Date(newest).toISOString();
    summary.latest_tied_observations = tied.length;
    summary.latest_recorded_status_codes = [...new Set(tied.map(item => item.observation.response_status).filter(Number.isInteger))].sort((a, b) => a - b);
    summary.latest_response_eligible = !saved.issues.length && !saved.omissions.operations
      && tied.every(({ observation, eligible }) => eligible && observation.outcome === 'success'
        && observation.response_status >= 200 && observation.response_status < 300
        && !(observation.assertions?.failed > 0));
  }
  // A record the query's bounds left out could hold a newer response: the
  // history is unavailable, named with the map's words, never "none".
  const beyondBound = saved.omissions.operations > 0;
  summary.state = latest && !beyondBound ? 'observed' : saved.issues.length || beyondBound ? 'unavailable' : 'none';
  if (beyondBound) summary.unavailable_reason = HISTORY_BEYOND_READ_BOUND;
  return { summary, candidates: clientCandidates, newest: tied };
}

// One operation's answer: bind, validate the identity against the store's
// bounds, query, summarize. Anything the store refuses for this operation is
// contained here, so `show` and the map name the same code for it.
function summarizeOne(source, operation, { config, contract, now }) {
  const { identity, reason } = bindIdentity(operation, config, contract);
  if (!identity) return { identity: null, operation_id: null, scope_reason: reason, summary: unresolvedSummary(config, reason),
    saved: null, candidates: [], newest: [] };
  try {
    const id = operationId(identity);
    // Exact retrieval uses the existing evidence validation and grant boundary.
    // The broader scoped history is retained separately for an explicit audit.
    const saved = queryLoadedOperationContext(source(), identity, { maxItems: 20, maxBytes: 1024 * 1024, includeNotes: false });
    return { identity, operation_id: id, scope_reason: null, saved, ...summarize(identity, saved, config, now) };
  } catch (error) {
    const code = contextCode(error);
    return { identity, operation_id: null, scope_reason: null, failure: code, summary: unavailableSummary(identity, code),
      saved: null, candidates: [], newest: [] };
  }
}

export function showObservationSummary(root, operation, { config, contract, now = Date.now(), env = process.env } = {}) {
  let loaded;
  const source = () => (loaded ??= loadOperationContextSources(root, { env }));
  return summarizeOne(source, operation, { config, contract, now }).summary;
}

/**
 * showObservationSummary for many operations of one repository, reading each
 * store once. Every operation gets the summary `show` would print for it (the
 * same identity binding, query bounds, evidence checks and rules), plus the
 * saved records and per-candidate eligibility the summary was derived from, so
 * a renderer can explain a label without deriving a second one. An operation
 * the store cannot hold or query gets an `unavailable` summary naming the code;
 * it never takes the others down.
 */
export function showObservationSummaries(root, operations, { config, contract, now = Date.now(), env = process.env, snapshot } = {}) {
  const loaded = loadOperationContextSources(root, { env, snapshot });
  const results = new Map();
  for (const operation of operations) results.set(operation, summarizeOne(() => loaded, operation, { config, contract, now }));
  return { results, loaded };
}

export function observationConfidence(legacyConfidence, summary) {
  // Errors, failed checks and missing evidence never turn an unverified legacy
  // row into an apparently successful operation. Observed remains weaker than
  // verified even for a completed 2xx response with passing assertions.
  return (!legacyConfidence || legacyConfidence === 'unverified') && summary.state === 'observed'
    && summary.latest_response_eligible
    && summary.latest_response_status >= 200 && summary.latest_response_status < 300
    && summary.latest_outcome === 'success'
    && !(summary.latest_assertions?.failed > 0) ? 'observed' : legacyConfidence ?? 'unverified';
}
