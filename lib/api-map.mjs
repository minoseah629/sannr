// The API map (MAP-1A): a projection of the knowledge store and the contract
// it names. Evidence standings and response counts derive from those two
// inputs; CODE-1 adds a separately labeled local-source projection. Nothing
// comes from an agent's memory, a response body or the network (R1). Evidence files are hashed by the same check `show` uses and never read
// for their content. Names, types, methods, paths, status codes, counts and
// dates appear; request and response values, headers, bodies, credentials and
// query values do not. The store holds shapes, not bodies, so no row counts.
//
// One standing per operation (R2), computed mechanically from the summary
// `show` prints for that operation (lib/show-observations.mjs), so `show`,
// `view` and `map` cannot disagree about which operations are observed. The
// legacy learn verification travels beside the standing and is never merged
// into it. One operation the store cannot hold or query never takes the page
// down: it gets its own row, naming why. Content never takes it down either:
// a value the secret scan flags is withheld where it would render and counted
// (see createWithholder below).

import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { LAYOUT } from './layout.mjs';
import { resolveConfig } from './config.mjs';
import { readContextState, readContract, operationsFrom, opNode, deref, inspectNoteHistory,
  freshnessFor, liveContractDigest, withGitSnapshot } from './context.mjs';
import { loadHttpContract } from './http-operation-context.mjs';
import { showObservationSummaries, observationConfidence, scopeProblem, HISTORY_BEYOND_READ_BOUND } from './show-observations.mjs';
import { contextCommandError } from './context-errors.mjs';
import { CONTRACT_CANDIDATES } from './setup-contract.mjs';
import { secretIn } from './verdicts.mjs';
import { KEY_SOURCES_INVALID } from './key-sources.mjs';
import { emailShaped } from './promote.mjs';
import { terminalText } from './terminal.mjs';
import { stackCatalog, stackScope } from './stacks.mjs';
import { codeLocations, readCodeContext, withCodeLocations } from './code-locations.mjs';
import { activeStackScopeFor, withStackScope } from './stack-scope.mjs';
import { evidenceClass, evidenceClassCounts, evidenceOperations, formatEvidenceClasses, rankNoteRecords } from './evidence-confidence.mjs';

export const API_MAP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const READS = new Set(['GET', 'HEAD']);
const OPERATION_KEY = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/\S*)$/;

// The fixed vocabulary. CSS classes, filter ids and selectors are built from
// these keys only; no label, tag, path or note ever becomes a class name.
export const API_MAP_STANDINGS = Object.freeze({
  'observed': 'observed',
  'observed-after-failure': 'observed after a failed attempt',
  'latest-response': 'latest response',
  'no-response': 'no response recorded',
  'write-no-response': 'write — no response recorded',
  'scope-unresolved': 'scope unresolved',
  'unavailable': 'observations unavailable',
});
const STANDING_KEYS = Object.keys(API_MAP_STANDINGS);

// Why no identity could be bound, as a sentence. `contract` is the bound
// contract's project path. The codes come from bindIdentity / scopeProblem
// (shared with `show`), refined here by the contract file's state.
const SCOPE_REASONS = Object.freeze({
  'config-problem': () => 'the environment configuration has a problem',
  'no-contract': () => 'no contract is named for the selected environment',
  'contract-missing': contract => `${contract} is missing`,
  'contract-unreadable': contract => `${contract} is unreadable`,
  'contract-empty': contract => `${contract} declares no operations`,
  'contract-unbindable': contract => `${contract} declares a path the client cannot bind (whitespace, a query or fragment character, a backslash or a dot segment)`,
  'no-base-url': () => 'no base URL is configured; the built-in fallback address is not a scope',
  'base-url-override-without-contract': () => 'API_BASE_URL overrides the base URL without API_CONTRACT',
  'environment-unusable': () => 'the selected environment name cannot be stored (a control or format character, more than 512 characters, or secret-shaped text)',
  'provider-not-eligible': () => 'the configured base URL cannot scope responses',
  'not-in-contract': () => 'not in the bound contract',
  'not-unique-in-contract': () => 'declared more than once in the bound contract',
  'outside-base-path': () => "its path is outside the configured base URL's path",
  'route-ambiguous': () => 'its path matches more than one operation in the bound contract',
  'route-unmatched': () => 'built into a request URL, its path matches no operation in the bound contract',
});
const contractLabel = path => path === WITHHELD ? 'the named contract (its path withheld)'
  : typeof path === 'string' && path ? `contract ${path}` : 'the named contract';
const scopeReasonText = (code, contract) => (SCOPE_REASONS[code] ?? (() => 'no identity could be bound under the configured base URL'))(contractLabel(contract));

const NEWEST_REASONS = Object.freeze({
  'stale-observation': staleDays => `older than the ${staleDays}-day staleness horizon`,
  'future-observation': () => 'dated after this snapshot',
  'incomplete-or-status-unavailable': () => 'incomplete or without a status',
  'evidence-not-matching': () => 'its evidence is missing or changed',
  'assertion-failed': () => 'an assertion failed',
  'outcome-not-success': () => 'the outcome was not success',
});
// Why an earlier failed response is retained but cannot be counted.
const EARLIER_REASONS = Object.freeze({
  'stale-observation': staleDays => `it is older than the ${staleDays}-day staleness horizon`,
  'incomplete-or-status-unavailable': () => 'it is incomplete',
  'evidence-not-matching': () => 'its evidence is missing or changed',
});

const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => plain(value) && Object.hasOwn(value, key) ? value[key] : undefined;
const regularFile = path => { try { return statSync(path).isFile(); } catch { return false; } };
const shortText = (value, max) => typeof value === 'string' && value.trim() && value.length <= max && !CONTROL.test(value)
  ? value.trim() : null;
const isOk = status => status >= 200 && status < 300;
const failedResponse = observation => (Number.isInteger(observation.response_status) && !isOk(observation.response_status))
  || observation.assertions?.failed > 0;

export const apiMapError = (code, message) => Object.assign(new Error(message), { code });

// --- withholding -------------------------------------------------------------
// A page never refuses because of content. Every value it would show from the
// store, the contract, the configuration or a saved record passes the secret
// scan (credential-, key- and email-shaped text, as the committed-surface
// guard reads it) and the promotion boundary's email rule; a flagged value is
// replaced by "withheld" where it would render and counted once by kind. The
// scan of the final rendered page stays as the last guard: a hit there after
// withholding is a bug, refused and named by the caller.
export const WITHHELD = 'withheld';
// The fixed vocabulary, in the order the page lists it: [singular, plural].
export const WITHHELD_KINDS = Object.freeze({
  'store-text': ['store name or date', 'store names or dates'],
  'environment-name': ['environment name', 'environment names'],
  'base-url': ['base URL', 'base URLs'],
  'contract-file': ['contract file path', 'contract file paths'],
  'code-location': ['code location', 'code locations'],
  'contract-version': ['contract version', 'contract versions'],
  'contract-path': ['contract path', 'contract paths'],
  'contract-text': ['contract tag or summary', 'contract tags or summaries'],
  'operation-key': ['stored operation key', 'stored operation keys'],
  'declared-field': ['declared field name or type', 'declared field names or types'],
  'declared-enum': ['declared enum value', 'declared enum values'],
  'parameter-name': ['parameter name', 'parameter names'],
  'key-source': ['key-source record', 'key-source records'],
  'measured-field': ['measured field name or type', 'measured field names or types'],
  'operation-detail': ['operation detail', 'operation details'],
  'freshness-reason': ['freshness reason', 'freshness reasons'],
  'note': ['note', 'notes'],
  'note-detail': ['note author, date or marker', 'note authors, dates or markers'],
  'provider-name': ['granted provider name', 'granted provider names'],
  'verdict-text': ['verdict field or line', 'verdict fields or lines'],
  'report-text': ['saved report field or line', 'saved report fields or lines'],
  'mcp-text': ['MCP inspection field or line', 'MCP inspection fields or lines'],
  'receipt-text': ['receipt field', 'receipt fields'],
  'grant-text': ['grant field', 'grant fields'],
});
export const flaggedForPage = value => typeof value === 'string'
  && (Boolean(secretIn(value, { allowAuthReferences: true })) || emailShaped(value));

/**
 * One page's withholding. `text(kind, value, id)` returns the value, or
 * "withheld" when the scan flags it; `id` names the element (an operation key,
 * a note's position) so one element shown in two sections is counted once.
 * `deep` withholds every string and key of a structured record; `lines` every
 * line of a rendered report. `counts()` is names-free: kind → number.
 */
export function createWithholder() {
  const seen = new Set(), tally = new Map();
  const text = (kind, value, id = `${kind}\u0000${value}`) => {
    if (!flaggedForPage(value)) return value;
    if (!Object.hasOwn(WITHHELD_KINDS, kind)) throw apiMapError('WITHHELD_KIND_UNKNOWN', 'An unknown withholding kind was named.');
    if (!seen.has(id)) { seen.add(id); tally.set(kind, (tally.get(kind) ?? 0) + 1); }
    return WITHHELD;
  };
  const deep = (kind, value, id, depth = 0) => {
    if (typeof value === 'string') return text(kind, value, id);
    if (value === null || typeof value !== 'object') return value;
    if (depth > 64) return null;
    if (Array.isArray(value)) return value.map((item, index) => deep(kind, item, `${id}\u0000${index}`, depth + 1));
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      let name = text(kind, key, `${id}\u0000key\u0000${key}`);
      for (let n = 2; name.startsWith(WITHHELD) && Object.hasOwn(out, name); n++) name = `${WITHHELD} ${n}`;
      Object.defineProperty(out, name, { value: deep(kind, item, `${id}\u0000${key}`, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return out;
  };
  const lines = (kind, value, id) => String(value).split('\n').map((line, index) => text(kind, line, `${id}\u0000line\u0000${index}`)).join('\n');
  const counts = () => Object.fromEntries(Object.keys(WITHHELD_KINDS).filter(kind => tally.has(kind)).map(kind => [kind, tally.get(kind)]));
  return { text, deep, lines, counts };
}

/** Several pages' counts as one. */
export const mergeWithheld = (...all) => {
  const out = {};
  for (const kind of Object.keys(WITHHELD_KINDS)) {
    const n = all.reduce((sum, counts) => sum + (counts?.[kind] ?? 0), 0);
    if (n) out[kind] = n;
  }
  return out;
};

/** The one line that counts what a page withheld, by kind; "" when nothing was. */
export function withheldSentence(counts) {
  const parts = Object.entries(WITHHELD_KINDS).filter(([kind]) => counts?.[kind])
    .map(([kind, [one, many]]) => `${counts[kind]} ${counts[kind] === 1 ? one : many}`);
  return parts.length ? `Withheld by the secret and promotion scans: ${parts.join('; ')}. Each reads withheld where it would render.` : '';
}

/**
 * The contract file `show` binds observations against: API_CONTRACT, then the
 * selected environment's contract, then the store's named contract, then a
 * conventional file. `storedContract` is a function so a caller that already
 * holds the parsed store never reads it again.
 */
export function selectContractFile(root, config, storedContract = () => undefined) {
  const scope = activeStackScopeFor(root);
  // stack.json owns the binding. A saved header may describe an earlier
  // configuration and cannot reattach a removed or sibling contract.
  if (scope) return typeof config?.contract === 'string' && config.contract
    ? resolve(root, config.contract) : null;
  let selected = process.env.API_CONTRACT ?? config?.contract;
  if (selected == null) selected = storedContract();
  if (typeof selected === 'string' && selected) return resolve(root, selected);
  for (const candidate of CONTRACT_CANDIDATES) if (existsSync(join(root, candidate))) return join(root, candidate);
  return null;
}

// A path printed on a shared page names the project file, never the machine.
function displayPath(root, path) {
  if (typeof path !== 'string' || !path) return null;
  if (!isAbsolute(path)) return path;
  const inside = relative(root, path);
  return inside && !inside.startsWith('..') && !isAbsolute(inside)
    ? inside.split('\\').join('/') : `${basename(path)} (outside the project; directory omitted)`;
}

// The contract file's state, so a page can say which of missing, unreadable
// (bad JSON or YAML, a directory, no permission) or empty applies. A document
// the YAML reader could not parse (it skipped what it could not read) and that
// yields no operations is unreadable, never "declares no operations".
function readMapContract(root, path) {
  if (!path) return { state: 'not-named', doc: null };
  const file = resolve(root, path);
  if (!existsSync(file)) return { state: 'missing', doc: null };
  if (!regularFile(file)) return { state: 'unreadable', doc: null };
  try {
    const { doc, problems } = readContract(file);
    if (!plain(doc)) return { state: 'unreadable', doc: null };
    let operations = 0;
    try { operations = operationsFrom(doc).length; } catch { return { state: 'unreadable', doc: null }; }
    if (!operations && problems?.length) return { state: 'unreadable', doc: null };
    return { state: operations ? 'read' : 'empty', doc };
  } catch { return { state: 'unreadable', doc: null }; }
}

// Each operation node's path item, so path-level parameters apply too.
function pathItems(doc) {
  const items = new Map();
  for (const item of Object.values(own(doc, 'paths') ?? {}))
    if (plain(item)) for (const node of Object.values(item)) if (plain(node)) items.set(node, item);
  return items;
}

// The query parameter names an operation declares, and whether that set is
// complete: an entry that cannot be resolved (an external-file `$ref`, a local
// `$ref` to nothing, a cycle, an entry without a name and location) leaves the
// declared set unknown, so no parameter can be called undeclared.
function declaredQueryParameters(doc, node, items) {
  const names = new Set();
  let complete = true;
  for (const list of [own(items.get(node), 'parameters'), own(node, 'parameters')]) {
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 500) { complete = false; continue; }
    for (const raw of list) {
      const parameter = deref(doc, raw);
      if (!plain(parameter) || typeof parameter.in !== 'string' || typeof parameter.name !== 'string') { complete = false; continue; }
      if (parameter.in === 'query') names.add(parameter.name);
    }
  }
  return { names, complete };
}

// Names only: the client stores the request as a bounded shape whose `params`
// object lists the query parameter names it recorded (structured parameters
// and names written into the request path), never their values.
function requestParameterNames(observation) {
  const shape = observation?.request_shape;
  const params = shape?.type === 'object' ? own(shape.properties, 'params') : undefined;
  return params?.type === 'object' && plain(params.properties) ? Object.keys(params.properties) : [];
}

function detectHub(paths) {
  const counts = new Map();
  for (const path of paths) {
    const segments = path.split('/');
    const index = segments.findIndex(segment => segment.includes('{'));
    if (index < 1) continue;
    const prefix = segments.slice(0, index + 1).join('/');
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  let best = null;
  for (const [prefix, operations] of counts)
    if (!best || operations > best.operations || (operations === best.operations && prefix < best.prefix)) best = { prefix, operations };
  // A hub must cover at least a quarter of the operations to abbreviate them.
  return best && best.operations >= 2 && best.operations * 4 >= paths.length ? best : null;
}

// The longest run of literal segments every path starts with. A path that is
// the prefix itself keeps the prefix for the others (it is named by its own
// last segment below), so a root operation beside its children does not pull
// every operation into one group.
function commonLiteralPrefix(paths) {
  if (!paths.length) return [];
  const split = paths.map(path => path.split('/').filter(Boolean));
  const out = [];
  for (let index = 0; ; index++) {
    const segment = split[0][index];
    if (segment === undefined || segment.includes('{') || !split.every(parts => parts[index] === segment)) break;
    out.push(segment);
  }
  return out;
}

const lastLiteral = path => path.split('/').filter(segment => segment && !segment.includes('{')).at(-1) ?? null;

function pathGroupName(path, hub, common) {
  const segments = path.split('/').filter(Boolean);
  if (hub) {
    if (path === hub.prefix || path.startsWith(`${hub.prefix}/`)) {
      const literal = path.slice(hub.prefix.length).split('/').filter(Boolean).find(segment => !segment.includes('{'));
      return literal ?? lastLiteral(hub.prefix) ?? '/';
    }
    // The hub's own collection (the hub without its parameter) groups with the
    // items under the hub, so a collection and its items are never split.
    const collection = hub.prefix.split('/').filter(Boolean).slice(0, -1);
    if (collection.length && segments.length === collection.length && segments.every((segment, index) => segment === collection[index]))
      return lastLiteral(hub.prefix) ?? '/';
  }
  if (segments.length <= common.length) return lastLiteral(path) ?? '/';
  return segments.slice(common.length).find(segment => !segment.includes('{'))
    ?? segments.find(segment => !segment.includes('{')) ?? '/';
}

// One key-source entry as the store's reader returns it (MAP-1C's
// projectKeySources, applied by storedEntry), in the map's own shape. Every
// name it shows passes the page's withholder; one entry is one element, so it
// is counted once however many of its names are flagged and wherever it
// renders (the key table and the view's operation details).
function keySourceRow(op, item, index, withhold) {
  const id = `key-source\u0000${op}\u0000${index}`;
  const shown = value => withhold.text('key-source', value, id);
  return { op, param: shown(item.param), location: item.location,
    source_operation: shown(item.source.operation), source_field: shown(item.source.field),
    first_observed_at: item.first_observed_at, last_observed_at: item.last_observed_at,
    also_seen: item.also_seen, run_id: shown(item.evidence.run_id) };
}

// The ids an element is withheld under on any page, so the map and the view's
// details count one element once: an operation by its key, a note by its
// operation and position in the stored history.
export const operationElement = op => `op\u0000${op}`;
export const noteElement = (op, index) => `note\u0000${op}\u0000${index}`;

function noteRows(op, entry, withhold, confidence = {}) {
  if (!entry) return { notes: [], state: null };
  const history = inspectNoteHistory(entry, op);
  const graded = new Map(rankNoteRecords(history.active, { ...confidence, history }).map(record => [record.index, record]));
  // Authored and unattributed prose. Machine notes (learn's own failure
  // records) stay in the operation's history; they are not authored notes.
  const notes = history.active.filter(record => record.kind !== 'machine').map(record => {
    const origin = plain(record.provenance) ? record.provenance : null;
    const evidence = Array.isArray(origin?.evidence) ? origin.evidence : [];
    const id = noteElement(op, record.index);
    return { op, note_id: record.id, evidence_class: graded.get(record.index).evidence_class,
      contradictions: graded.get(record.index).contradictions,
      text: withhold.text('note', typeof record.text === 'string' ? record.text : String(record.text ?? ''), id),
      by: typeof origin?.by === 'string' ? withhold.text('note-detail', origin.by, `${id}\u0000by`) : null,
      at: typeof origin?.at === 'string' ? withhold.text('note-detail', origin.at, `${id}\u0000at`) : null,
      evidence: evidence.filter(ref => plain(ref) && typeof ref.run_id === 'string' && RUN_ID.test(ref.run_id))
        .map(ref => ({ run_id: ref.run_id, state: ['available', 'unavailable', 'scope_mismatch'].includes(ref.state) ? ref.state : 'not recorded' })) };
  });
  return { notes, state: history.state };
}

function standingOf(row, result, { staleDays, contractPath, shownName = name => name }) {
  const { identity, summary, newest, candidates } = result;
  const qualifiers = [];
  if (!identity) return { key: 'scope-unresolved', label: API_MAP_STANDINGS['scope-unresolved'],
    qualifiers: [scopeReasonText(row.scope_reason, contractPath)] };
  if (observationConfidence(null, summary) === 'observed') {
    // R2: an earlier response retained in this scope that was non-2xx or
    // failed an assertion, whether or not it can be counted.
    const tied = new Set(newest);
    const earlier = candidates.filter(candidate => !tied.has(candidate) && candidate.reason !== 'future-observation'
      && failedResponse(candidate.observation));
    const key = earlier.length ? 'observed-after-failure' : 'observed';
    if (earlier.length && !earlier.some(candidate => candidate.eligible))
      for (const reason of new Set(earlier.map(candidate => candidate.reason)))
        qualifiers.push(`an earlier failure is retained; ${(EARLIER_REASONS[reason] ?? (() => 'it cannot be counted'))(staleDays)}`);
    if (row.undeclared_parameters.length)
      qualifiers.push(`using parameters the contract does not declare: ${row.undeclared_parameters.map(shownName).join(', ')}`);
    return { key, label: API_MAP_STANDINGS[key], qualifiers };
  }
  if (summary.issues.length || summary.omissions.operations) {
    const codes = [...new Set(summary.issues.map(issue => issue.code).filter(Boolean))];
    if (summary.omissions.operations) codes.push(HISTORY_BEYOND_READ_BOUND);
    return { key: 'unavailable', label: API_MAP_STANDINGS.unavailable, qualifiers: codes };
  }
  if (summary.latest_recorded_observed_at) {
    const codes = summary.latest_recorded_status_codes;
    const reasons = new Set();
    let failed = false;
    for (const candidate of newest) {
      if (failedResponse(candidate.observation)) failed = true;
      if (!candidate.eligible) reasons.add(candidate.reason);
      else if (!isOk(candidate.observation.response_status)) continue;
      else if (candidate.observation.assertions?.failed > 0) reasons.add('assertion-failed');
      else if (candidate.observation.outcome !== 'success') reasons.add('outcome-not-success');
    }
    for (const reason of reasons) qualifiers.push(NEWEST_REASONS[reason]?.(staleDays) ?? reason);
    // A newest response that did not fail but cannot be counted is neutral.
    return { key: 'latest-response', label: `${API_MAP_STANDINGS['latest-response']} ${codes.length ? codes.join(', ') : 'without a status'}`,
      qualifiers, tone: failed ? 'failure' : 'neutral' };
  }
  const key = READS.has(row.method) ? 'no-response' : 'write-no-response';
  return { key, label: API_MAP_STANDINGS[key], qualifiers };
}

// History sources the page names once, instead of a bare code on every row.
function historySources(loaded) {
  const out = [];
  if (loaded.problem) out.push({ kind: 'registry-unreadable', code: loaded.problem.code });
  for (const item of loaded.skipped ?? [])
    out.push({ kind: 'provider-missing', repository: item.repository, name: shortText(item.name, 200) });
  for (const source of loaded.sources) if (source.error)
    out.push(source.id === 'local' ? { kind: 'local-unreadable', code: contextCommandError(source.error).code }
      : { kind: 'provider-unreadable', repository: source.id, name: shortText(source.name, 200), code: contextCommandError(source.error).code });
  return out;
}

/**
 * Build the map. `snapshot` is an already-read store ({ ctx } as
 * readContextState returns it); without one the store is read here, once.
 * `now` grades staleness and dates the page; `env` selects the registry for
 * granted provider history, as `show` does; `environment` selects a named
 * environment like `show --env`. `learnedReasons: false` keeps the learned
 * grade but skips the descriptive commit count (a caller showing labels only).
 * `withhold` is the page's withholder (createWithholder), so a page that shows
 * the map beside other sections counts each withheld element once; the
 * model's `withheld` holds the counts by kind as of the map.
 */
export function buildApiMapModel(root, options = {}) {
  return withCodeLocations(root, () => withGitSnapshot(() => {
    const scopes = apiMapStackScopes(root, options);
    if (scopes.length) {
      // Snapshot and withholding ownership are per stack. A caller's legacy
      // snapshot must never be reused across all of the stack viewports.
      const { snapshot, withhold, ...shared } = options;
      shared.now ??= Date.now();
      const model = collectStackApiMaps(scopes.map(scope => ({ scope,
        api_map: withStackScope(scope, () => attachCodeLocations(root, projectApiMap(root, shared))) })));
      return attachCodeIndex(root, model);
    }
    return attachCodeLocations(root, projectApiMap(root, options));
  }), options);
}

// Code is a separate local declaration projection. It cannot change a stored
// observation, learned grade, evidence class or operation inventory.
function attachCodeLocations(root, model) {
  const all = codeLocations(root), stack = activeStackScopeFor(root)?.stack ?? '';
  const code = all.stacks[stack];
  if (!code) return attachCodeIndex(root, model);
  const withhold = createWithholder();
  const clean = withhold.deep('code-location', { label: 'declared by code',
    called_from: code.called_from, summary: stack === '' ? all.summary : code.summary,
    ...(stack === '' ? { unmatched: all.unmatched } : {}) }, `code\u0000${stack}`);
  const operations = (model.operations ?? []).map(row => ({ ...row,
    code: row.op && code.operations[row.op]
      ? withhold.deep('code-location', code.operations[row.op], `code\u0000${stack}\u0000${row.op}`)
      : { defined_in: [], called_from: [] } }));
  return { ...model, code: clean, operations,
    withheld: mergeWithheld(model.withheld, withhold.counts()) };
}

export function attachCodeIndex(root, model) {
  const all = codeLocations(root), withhold = createWithholder();
  const code = withhold.deep('code-location', { label: 'declared by code',
    summary: all.summary, unmatched: all.unmatched }, 'code-index');
  return { ...model, code, withheld: mergeWithheld(model.withheld, withhold.counts()) };
}

// A viewport uses the same resolver and scope as show. No implicit selection
// of the first stack, and no fallback to a neighbour's contract or store.
export function apiMapStackScopes(root, { environment } = {}) {
  if (activeStackScopeFor(root)) return [];
  const catalog = stackCatalog(root);
  if (catalog.problems.length) throw apiMapError(catalog.problems[0].code, catalog.problems[0].message);
  return [...catalog.stacks].sort((a, b) => Number(b.name === catalog.defaults.default_stack)
    - Number(a.name === catalog.defaults.default_stack) || a.name.localeCompare(b.name))
    .map(row => stackScope(root, { stack: row.name, ...(environment !== undefined ? { environment } : {}) }));
}

export function collectStackApiMaps(entries) {
  const stacks = entries.map(({ scope, api_map }, index) => {
    const withhold = createWithholder();
    const names = Object.keys(scope.document.environments).sort().map((name, n) =>
      withhold.text('environment-name', name, `environment-name\u0000${n}`));
    return { name: withhold.text('store-text', scope.stack, 'stack-name'), viewport: `stack-${index}`,
      environments: names, api_map: { ...api_map, withheld: mergeWithheld(api_map.withheld, withhold.counts()) } };
  });
  const stack_index = stacks.map(({ name, viewport, environments, api_map: map }) => ({ name, viewport, environments,
    contract_state: map.contract?.state ?? 'not-named', operations: map.counts?.operations ?? 0,
    observed: map.counts?.observed_total ?? 0, evidence_classes: map.counts?.evidence_classes ?? evidenceClassCounts([]),
    responses: map.observations?.counted ?? 0, notes: map.counts?.notes ?? 0 }));
  return { v: 1, kind: 'stack-api-map', name: 'Stacks', state: 'mapped',
    generated_at: stacks[0]?.api_map.generated_at, stacks, stack_index,
    store_operations: stacks.reduce((n, row) => n + row.api_map.store_operations, 0),
    counts: { ...Object.fromEntries(['operations', 'observed', 'responses', 'notes'].map(key =>
      [key, stack_index.reduce((n, row) => n + row[key], 0)])),
      evidence_classes: Object.fromEntries(Object.keys(evidenceClassCounts([])).map(key =>
        [key, stack_index.reduce((n, row) => n + row.evidence_classes[key], 0)])) },
    withheld: mergeWithheld(...stacks.map(row => row.api_map.withheld)) };
}

export function renderStackIndex(model) {
  return `<section id="stack-index" class="am"><h2>Stack index</h2><p class="am-basis">Each viewport reads its own store and contract. Counts use the same selected scope as show.</p>` +
    '<div class="am-scroll"><table><thead><tr><th>stack</th><th>operations</th><th>written</th><th>observed</th><th>asserted</th><th>verified</th><th>responses</th><th>notes</th></tr></thead><tbody>' +
    model.stack_index.map(row => `<tr><td><a href="#${row.viewport}">${esc(row.name)}</a></td><td>${row.operations}</td>${Object.values(row.evidence_classes).map(n => `<td>${n}</td>`).join('')}<td>${row.responses}</td><td>${row.notes}</td></tr>`).join('') +
    '</tbody></table></div></section>';
}

// Fixed, index-derived namespaces keep radio groups, labels, anchors and CSS
// independent. Untrusted stack names never become selectors or attributes.
export function renderStackApiMapHtml(row) {
  const prefix = row.viewport;
  if (!/^stack-\d+$/.test(prefix)) throw apiMapError('API_MAP_VIEWPORT_INVALID', 'A viewport requires its generated numeric identity.');
  const html = renderApiMapHtml(row.api_map).replace(/\b(id|name|for|aria-labelledby)="(api-map|am-[^"]+)"/g,
    (_, attribute, value) => `${attribute}="${prefix}-${value}"`);
  const css = API_MAP_CSS.split('\n').filter(line => line.startsWith('#am-')).join('\n')
    .replaceAll('#am-', `#${prefix}-am-`).replaceAll('for="am-', `for="${prefix}-am-`);
  return `<style>${css}</style>\n${html}`;
}

function projectApiMap(root, { now = Date.now(), env = process.env, environment, snapshot, learnedReasons = true,
  withhold = createWithholder() } = {}) {
  const generatedAt = new Date(now).toISOString();
  let read = snapshot;
  if (read === undefined) {
    const state = readCodeContext(root, activeStackScopeFor(root)?.stack, () => readContextState(root));
    if (state.state === 'malformed' || state.state === 'unusable')
      throw apiMapError('API_MAP_CONTEXT_INVALID', 'The knowledge store is unreadable or unusable.');
    read = state.snapshot;
  }
  const stackBinding = activeStackScopeFor(root), stored = read?.ctx ?? null;
  // A new stack may have a contract before its first saved fact. An empty
  // in-memory projection lets declarations render without creating a store,
  // observation or verification. Legacy implicit-store reads stay unchanged.
  const ctx = stored ?? (stackBinding ? { v: 0, operations: {}, api: {} } : null);
  const base = { v: 1, kind: 'api-map', name: withhold.text('store-text', shortText(ctx?.api?.name, 200)
      ?? shortText(stackBinding?.document.title, 200) ?? basename(root), 'store\u0000name'),
    generated_at: generatedAt, store: { ...(stackBinding && !stored ? { state: 'missing' } : {}),
      path: stackBinding?.contextFile ?? LAYOUT.context, generated_at: typeof ctx?.generated_at === 'string'
      ? withhold.text('store-text', ctx.generated_at.slice(0, 64), 'store\u0000generated_at') : null } };
  if (!ctx) return { ...base, state: 'missing', store_operations: 0, counts: { operations: 0, evidence_classes: evidenceClassCounts([]) }, operations: [], groups: [], notes: [], key_sources: [], key_slots: [], withheld: withhold.counts() };

  const config = resolveConfig(root, environment !== undefined ? { environment } : {});
  const bindingFile = selectContractFile(root, config, () => ctx.api?.contract);
  const bindingContract = bindingFile && regularFile(bindingFile) ? loadHttpContract(bindingFile) : null;
  const named = activeStackScopeFor(root) ? bindingFile
    : typeof ctx.api?.contract === 'string' && ctx.api.contract ? ctx.api.contract : null;
  const contractFile = path => withhold.text('contract-file', path, `contract-file\u0000${path}`);
  const contractPath = contractFile(displayPath(root, named ?? bindingFile));
  const contract = readMapContract(root, named ? resolve(root, named) : bindingFile);
  const doc = contract.doc;
  const legacyDigest = named && !regularFile(resolve(root, named)) ? ctx.api?.contract_digest ?? null : liveContractDigest(root, ctx);

  // Rows: the contract's operations in document order, then stored operations
  // the contract no longer (or never) declared.
  const legacy = plain(ctx.operations) ? ctx.operations : {};
  const items = doc ? pathItems(doc) : new Map();
  const rows = [], byOp = new Map();
  // Contract text is third-party input. A tag, summary or path the secret scan
  // flags is withheld and counted rather than refusing the whole page.
  let contractTextWithheld = 0, pathsWithheld = 0;
  const contractText = (value, id) => {
    if (value && withhold.text('contract-text', value, id) === WITHHELD) { contractTextWithheld++; return WITHHELD; }
    return value;
  };
  const addRow = (op, method, path, inContract) => {
    if (byOp.has(op)) return;
    const node = doc && inContract ? opNode(doc, method, path) : null;
    // A withheld tag reads "withheld" in its cell; the row is grouped by path.
    const tagText = contractText(shortText(Array.isArray(own(node, 'tags')) ? node.tags[0] : null, 128), `contract-text\u0000${op}\u0000tag`);
    const tag = tagText === WITHHELD ? null : tagText;
    const summary = contractText(typeof own(node, 'summary') === 'string' && !CONTROL.test(node.summary.replace(/[\t\n\r]/g, ' '))
      ? node.summary.replace(/\s+/g, ' ').trim().slice(0, 200) : null, `contract-text\u0000${op}\u0000summary`);
    // The row keeps its method and its place; the path never reaches the model.
    // A contract path and a key only the store holds are counted apart; one
    // element shown in another section too is counted once (`op` names it).
    const withheld = withhold.text(inContract ? 'contract-path' : 'operation-key', path, operationElement(op)) === WITHHELD;
    if (withheld && inContract) pathsWithheld++;
    const row = { op: withheld ? null : op, method, path: withheld ? null : path, ...(withheld ? { withheld: true } : {}),
      tag, ...(tagText === WITHHELD ? { tag_withheld: true } : {}), summary: summary || null,
      in_contract: inContract, in_store: Object.hasOwn(legacy, op),
      declared_query: node && !withheld ? declaredQueryParameters(doc, node, items) : null };
    rows.push(row); byOp.set(op, row);
  };
  for (const { op, method, path } of doc ? operationsFrom(doc) : []) addRow(op, method, path, true);
  let nonHttpKeys = 0;
  const storeOnly = [];
  for (const op of Object.keys(legacy)) {
    if (byOp.has(op)) continue;
    const match = OPERATION_KEY.exec(op);
    if (!match) { nonHttpKeys++; continue; }
    storeOnly.push({ op, method: match[1], path: match[2] });
  }
  storeOnly.sort((a, b) => a.path.localeCompare(b.path) || API_MAP_METHODS.indexOf(a.method) - API_MAP_METHODS.indexOf(b.method));
  for (const { op, method, path } of storeOnly) addRow(op, method, path, false);

  // Captured operations in the selected scope and in-store authored operation
  // identities belong in the inventory. An unresolved authored identity stays
  // written; only matching scoped evidence may upgrade its class.
  for (const op of evidenceOperations(ctx, { config, contract: bindingContract })) {
    const match = OPERATION_KEY.exec(op);
    if (match) addRow(op, match[1], match[2], false);
  }

  const apiContextOperations = plain(ctx.api_context) && plain(ctx.api_context.operations) ? ctx.api_context.operations : {};
  const storeOperations = Object.keys(legacy).length + Object.keys(apiContextOperations).length;
  if (!rows.length) return { ...base, state: 'empty', store_operations: storeOperations, counts: { operations: 0, evidence_classes: evidenceClassCounts([]) }, operations: [], groups: [], notes: [], key_sources: [], key_slots: [],
    contract: { path: contractPath, state: contract.state, version: null }, withheld: withhold.counts() };

  // Scope: the identity `show` binds, once for the repository. A contract that
  // cannot be bound is named by its state: not named, missing, unreadable,
  // empty, or declaring a path the client cannot bind.
  let problem = scopeProblem(config, bindingContract);
  if (problem === 'no-contract' && bindingFile) {
    const state = readMapContract(root, bindingFile).state;
    problem = { missing: 'contract-missing', unreadable: 'contract-unreadable', empty: 'contract-empty', read: 'contract-unbindable' }[state] ?? problem;
  }
  const bindingPath = contractFile(displayPath(root, bindingFile));
  const bindable = rows.filter(row => !row.withheld);
  const { results, loaded } = showObservationSummaries(root, bindable.map(row => row.op),
    { config, contract: bindingContract, now, env, snapshot: ctx });
  const staleDays = config.defaults?.staleDays ?? 180;

  // `links` keeps each shown key-source row beside the stored names it came
  // from: a slot is matched by the stored parameter name, and two distinct
  // sources stay two even when both read withheld.
  const notes = [], keySources = [], links = [], issues = [];
  const omissions = { key_source_records_damaged: 0, non_http_store_keys: nonHttpKeys,
    contract_text_withheld: contractTextWithheld, contract_paths_withheld: pathsWithheld, declared_parameters_unresolved: 0 };
  const local = loaded.sources.find(source => source.id === 'local' && !source.error);
  const inScope = new Set();
  let counted = 0, first = null, last = null;
  for (const row of rows) {
    if (row.withheld) {
      Object.assign(row, { scope_reason: null, undeclared_parameters: [], responses: 0, latest_status_codes: [], status_codes: [],
        latest_observed_at: null, learned: null, notes: 0, note_history: null, key_sources: 0, outside_scope: 0,
        evidence_class: { class: 'written', reason: 'path-withheld', at: null, current_success: false },
        standing: { key: 'unavailable', label: API_MAP_STANDINGS.unavailable, qualifiers: ['path withheld (secret-shaped); its history is not read'] } });
      delete row.declared_query;
      continue;
    }
    const result = results.get(row.op);
    row.scope_reason = problem ?? result.scope_reason;
    // Names only, from the newest eligible responses `show` counted. A
    // declared set with an unresolved entry is incomplete: nothing is called
    // undeclared against it.
    const sent = new Set(result.newest.filter(candidate => candidate.eligible).flatMap(candidate => requestParameterNames(candidate.observation)));
    if (row.declared_query && !row.declared_query.complete) omissions.declared_parameters_unresolved++;
    row.undeclared_parameters = row.declared_query?.complete ? [...sent].filter(name => !row.declared_query.names.has(name)).sort() : [];
    // A recorded name the scan flags reads "withheld" in the qualifier, and is
    // counted only when the qualifier is shown.
    const shownName = name => withhold.text('parameter-name', name, `parameter\u0000${row.op}\u0000${name}`);
    row.standing = standingOf(row, result, { staleDays, contractPath: bindingPath, shownName });
    // The qualifier belongs to a passing response only; a failing newest
    // response carries its status instead.
    row.undeclared_parameters = ['observed', 'observed-after-failure'].includes(row.standing.key)
      ? row.undeclared_parameters.map(shownName) : [];
    const summary = result.summary;
    row.responses = summary.observation_count;
    row.latest_status_codes = summary.latest_recorded_status_codes;
    row.status_codes = summary.observed_status_codes;
    row.latest_observed_at = summary.latest_recorded_observed_at;
    for (const observation of summary.observations) {
      counted++;
      const at = Date.parse(observation.observed_at);
      if (first === null || at < Date.parse(first)) first = observation.observed_at;
      if (last === null || at > Date.parse(last)) last = observation.observed_at;
    }
    const entry = Object.hasOwn(legacy, row.op) && plain(legacy[row.op]) ? legacy[row.op] : null;
    if (entry) {
      const freshness = freshnessFor(entry, root, legacyDigest, now, { commits: learnedReasons });
      row.learned = { confidence: freshness.confidence, verified_at: typeof entry.verified_at === 'string' ? entry.verified_at : null,
        stale: Boolean(freshness.age?.stale), freshness };
    } else row.learned = null;
    row.evidence_class = evidenceClass({ entry: entry ?? {}, summary, freshness: row.learned?.freshness, now, staleDays });
    const written = noteRows(row.op, entry, withhold, { summary, freshness: row.learned?.freshness, now, staleDays });
    row.notes = written.notes.length;
    row.note_history = written.state;
    notes.push(...written.notes);
    row.key_sources = 0;
    if (result.operation_id && local) {
      inScope.add(result.operation_id);
      // Key sources exactly as the store accepts them: the local record the
      // query returned carries only a list MAP-1C's validator passed, and a
      // damaged list is named in the query's record_issues (never in its
      // issues, which would withdraw the observed label). Its links are
      // absent; its observations stand.
      const saved = result.saved;
      const mine = item => item.repository === 'local' && item.operation_id === result.operation_id;
      const stored = saved?.operations.find(mine);
      // A list the store accepts that the answer does not carry was left out
      // by the read bound: the record was returned without its key_sources
      // (counted in key_sources_omitted), or the bound left the record out (a
      // record the store refused is named by its issue instead). Its links
      // are not shown and the record is counted, never read as "not recorded".
      const leftOut = stored ? !stored.key_sources
        : saved.omissions.operations > 0 && !saved.issues.some(issue => issue.repository === 'local');
      if (local.byId.get(result.operation_id)?.key_sources?.length && leftOut) row.key_sources_omitted = true;
      for (const [index, item] of (stored?.key_sources ?? []).entries()) {
        const shown = keySourceRow(row.op, item, index, withhold);
        keySources.push(shown);
        links.push({ shown, param: item.param, source: `${item.source.operation}\u0000${item.source.field}` });
        row.key_sources++;
      }
      if ((saved?.record_issues ?? []).some(issue => mine(issue) && issue.code === KEY_SOURCES_INVALID)) {
        omissions.key_source_records_damaged++;
        issues.push({ code: KEY_SOURCES_INVALID, operation: row.op });
      }
    }
    row.outside_scope = 0;
    delete row.declared_query;
  }

  // Retained client responses this scope does not count: other environments,
  // providers or contract versions. Counted, never folded into a standing.
  let outsideMap = 0;
  for (const [id, entry] of local?.projected ?? []) {
    if (entry.identity.protocol !== 'http' || inScope.has(id)) continue;
    const responses = entry.observations.filter(observation => observation.source.kind === 'client'
      && observation.source.tool === 'api_request:http' && observation.basis === 'observed').length;
    if (!responses) continue;
    const row = byOp.get(entry.identity.operation);
    if (row) row.outside_scope += responses; else outsideMap += responses;
  }
  for (const row of rows) if (row.outside_scope)
    row.standing.qualifiers.push(`${row.outside_scope} response${row.outside_scope === 1 ? '' : 's'} retained outside this scope`);

  // Grouping: the contract's first tag, else a path segment. Withheld paths
  // have no segment to group by.
  const pathRows = rows.filter(row => !row.withheld);
  const hub = detectHub(pathRows.map(row => row.path));
  const common = commonLiteralPrefix(pathRows.map(row => row.path));
  const groupsByKey = new Map();
  for (const [index, row] of rows.entries()) {
    const source = row.tag ? 'tag' : row.withheld ? 'withheld' : 'path';
    const name = row.tag ?? (row.withheld ? 'paths withheld by the secret scan' : pathGroupName(row.path, hub, common));
    const key = `${source}\u0000${name}`;
    if (!groupsByKey.has(key)) groupsByKey.set(key, { name, source, operations: [] });
    groupsByKey.get(key).operations.push(index);
    row.display_path = row.withheld ? null : hub && row.path.startsWith(`${hub.prefix}/`) ? `…${row.path.slice(hub.prefix.length)}` : row.path;
  }
  const declaredTags = Array.isArray(own(doc, 'tags')) ? doc.tags.map(tag => own(tag, 'name')).filter(name => typeof name === 'string') : [];
  const order = group => group.source === 'tag' ? (declaredTags.includes(group.name) ? 0 : 1) : group.source === 'path' ? 2 : 3;
  const groups = [...groupsByKey.values()].map((group, index) => ({ ...group, index }))
    .sort((a, b) => order(a) - order(b) || (order(a) === 0 ? declaredTags.indexOf(a.name) - declaredTags.indexOf(b.name) : a.index - b.index))
    .map(({ index, ...group }) => group);
  for (const [index, group] of groups.entries()) for (const row of group.operations) rows[row].group = index;

  // Path keys: one slot per path parameter of the contract, named by the path
  // prefix that ends in it. Each slot lists the sources recorded on any
  // operation under it, most-seen first.
  const slots = new Map();
  for (const row of rows) {
    if (!row.in_contract || row.withheld) continue;
    const segments = row.path.split('/');
    for (let index = 1; index < segments.length; index++)
      for (const [, param] of segments[index].matchAll(/\{([^{}]*)\}/gu)) {
        const prefix = segments.slice(0, index + 1).join('/');
        const key = `${prefix}\u0000${param}`;
        if (!slots.has(key)) slots.set(key, { prefix, param, sources: new Map() });
      }
  }
  const rowPaths = new Map(rows.filter(row => !row.withheld).map(row => [row.op, row.path]));
  for (const { shown: record, param, source } of links) {
    if (record.location !== 'path') continue;
    const segments = rowPaths.get(record.op).split('/');
    for (let index = 1; index < segments.length; index++) {
      if (!segments[index].includes(`{${param}}`)) continue;
      const slot = slots.get(`${segments.slice(0, index + 1).join('/')}\u0000${param}`);
      if (!slot) continue;
      if (!slot.sources.has(source)) slot.sources.set(source, { operation: record.source_operation, field: record.source_field, operations: new Set() });
      slot.sources.get(source).operations.add(record.op);
    }
  }
  // A key with no shown source under which an operation's key-source list was
  // beyond the read bound cannot be called "not recorded": the list was left
  // out, not found empty.
  const beyondBound = rows.filter(row => row.key_sources_omitted && !row.withheld && row.in_contract).map(row => row.path.split('/'));
  const underSlot = (slot, segments) => {
    const prefix = slot.prefix.split('/');
    return segments.length >= prefix.length && prefix.every((segment, index) => segments[index] === segment);
  };
  const keySlots = [...slots.values()].map(slot => {
    const sources = [...slot.sources.values()].map(source => ({ operation: source.operation, field: source.field, seen_on: source.operations.size }))
      .sort((a, b) => b.seen_on - a.seen_on || (a.operation < b.operation ? -1 : a.operation > b.operation ? 1 : 0)
        || (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
    return { prefix: slot.prefix, param: slot.param, sources: sources.slice(0, 2), more: Math.max(0, sources.length - 2),
      ...(!sources.length && beyondBound.some(segments => underSlot(slot, segments)) ? { beyond_read_bound: true } : {}) };
  });

  const counts = Object.fromEntries(STANDING_KEYS.map(key => [key, rows.filter(row => row.standing.key === key).length]));
  // The environment name and base URL are configuration text: an unusable
  // (for example secret-shaped) environment name is a scope reason and reads
  // "withheld" where the page would print it.
  const environmentName = withhold.text('environment-name', config.name ?? 'default', 'environment-name');
  const scope = problem
    ? { state: 'unresolved', reason: scopeReasonText(problem, bindingPath), problems: (config.problems ?? []).map(item => item.code),
      environment: environmentName, production: Boolean(config.production), contract: bindingPath }
    : { state: 'bound', provider: withhold.text('base-url', config.baseUrl, 'base-url'), environment: environmentName,
      production: Boolean(config.production), contract: bindingPath, contract_digest: bindingContract.digest };
  // The contract's version is third-party text too: withheld and counted when
  // the secret scan flags it, never a reason to refuse the page.
  const version = typeof doc?.info?.version === 'string' || typeof doc?.info?.version === 'number' ? shortText(String(doc.info.version), 64) : null;
  omissions.contract_version_withheld = version && withhold.text('contract-version', version, 'contract-version') === WITHHELD ? 1 : 0;
  const sources = historySources(loaded).map(source => source.name
    ? { ...source, name: withhold.text('provider-name', source.name, `provider\u0000${source.repository}`) } : source);
  return {
    ...base, state: 'mapped', store_operations: storeOperations,
    contract: { path: contractPath, state: contract.state, version: omissions.contract_version_withheld ? null : version },
    scope, hub, stale_days: staleDays, sources,
    observations: { counted, first_observed_at: first, last_observed_at: last, outside_scope: rows.reduce((n, row) => n + row.outside_scope, 0), outside_map: outsideMap },
    counts: { operations: rows.length, evidence_classes: evidenceClassCounts(rows), ...counts,
      observed_total: counts.observed + counts['observed-after-failure'],
      learned_verified: rows.filter(row => row.learned?.confidence === 'verified').length,
      learned_suspect: rows.filter(row => row.learned?.confidence === 'suspect').length,
      undeclared_parameters: rows.filter(row => row.undeclared_parameters.length).length,
      notes: notes.length, key_sources: keySources.length, key_sources_omitted: rows.filter(row => row.key_sources_omitted).length,
      key_slots: keySlots.length, key_slots_sourced: keySlots.filter(slot => slot.sources.length).length,
      contract_only: rows.filter(row => !row.in_store).length, store_only: rows.filter(row => !row.in_contract).length },
    groups, operations: rows, notes, key_sources: keySources, key_slots: keySlots, omissions, issues,
    withheld: withhold.counts(),
  };
}

// A compact, values-free summary for machine output (map --json). `withheld`
// is the count by kind of what the map withheld.
export function apiMapSummary(model) {
  if (model?.kind === 'stack-api-map') return { state: model.state, kind: model.kind, generated_at: model.generated_at,
    stack_index: model.stack_index, counts: model.counts, withheld: model.withheld, code: model.code,
    stacks: model.stacks.map(({ api_map, ...row }) => ({ ...row, api_map: apiMapSummary(api_map) })) };
  if (!model || model.state !== 'mapped') return model ? { state: model.state, name: model.name, code: model.code } : null;
  return { state: model.state, name: model.name, generated_at: model.generated_at, store: model.store,
    contract: model.contract, scope: model.scope, counts: model.counts, observations: model.observations,
    sources: model.sources, issues: model.issues, withheld: model.withheld ?? {}, code: model.code,
    operations: model.operations.map(row => ({ op: row.op, code: row.code })) };
}

// --- HTML ------------------------------------------------------------------
// Untrusted text (contract paths, tags, summaries, notes) is escaped for HTML
// and also for the view's active-content guard: `=`, `@` and `(` are encoded so
// a note that says "url(" or "src=" stays text instead of refusing the page.
// Every C0 and C1 control except tab, newline and carriage return is removed,
// and so is every Unicode format character (general category Cf): the
// bidirectional controls, zero-width space, word joiner, byte order mark, soft
// hyphen and the invisible tag characters. Zero-width non-joiner (U+200C) and
// zero-width joiner (U+200D) stay, because real scripts and emoji sequences
// need them. The same text therefore renders one way everywhere on a page.
export const escapeText = value => String(value ?? '')
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]|(?![\u200c\u200d])\p{Cf}/gu, '')
  .replace(/[&<>"'=@(]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '=': '&#61;', '@': '&#64;', '(': '&#40;' }[c]));
const esc = escapeText;
const day = value => typeof value === 'string' ? value.slice(0, 10) : 'not recorded';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const methodChip = method => `<span class="am-m am-m-${API_MAP_METHODS.includes(method) ? method.toLowerCase() : 'get'}">${esc(method)}</span>`;
const standingChip = standing => `<span class="am-chip am-s-${STANDING_KEYS.includes(standing.key) ? standing.key : 'unavailable'}${standing.tone === 'neutral' ? ' am-tone-neutral' : ''}">${esc(standing.label)}</span>`;
const learnedChip = learned => learned && learned.confidence !== 'unverified'
  ? ` <span class="am-chip am-learned">learned: ${esc(learned.confidence)}${learned.stale ? ', age-stale' : ''}</span>` : '';
const evidenceChip = evidence => evidence
  ? `<span class="am-chip">${esc(evidence.class)}</span>${evidence.reason ? `<span class="am-q">${esc(evidence.reason)}</span>` : ''}` : '';
const qualifiersHtml = standing => standing.qualifiers.length
  ? `<span class="am-q">${standing.qualifiers.map(esc).join('; ')}</span>` : '';
const pathCell = (row, path) => row.withheld ? 'path withheld (secret-shaped)' : `<code>${esc(path)}</code>`;

// Locations are text only: no editor URI, filesystem link or source content.
const codeLocationHtml = location => {
  const file = `${location.file}${Number.isInteger(location.line) ? `:${location.line}` : ''}`;
  const kind = { definition: 'definition', request: 'request expression', binding: 'source binding', config: 'configuration reference' }[location.kind] ?? 'recorded location';
  const state = location.state === 'not-found' ? ' · not found at the working tree'
    : location.state === 'remembered' ? ' · remembered location; not rediscovered' : '';
  return `<code>${esc(file)}</code> <span class="am-q">${esc(kind)}${esc(state)}${location.environments?.length ? ` · environment ${esc(location.environments.join(', '))}` : ''}</span>`;
};
export function renderOperationCodeHtml(code) {
  const groups = [['defined_in', 'Defined in'], ['called_from', 'Called from']]
    .filter(([key]) => code?.[key]?.length)
    .map(([key, title]) => `<span class="am-q">${title} — declared by code</span>${code[key].map(codeLocationHtml).join('<br>')}`);
  return groups.length ? groups.join('<br>') : '<span class="am-q">No matching code location</span>';
}
export function renderCodeIndexHtml(code) {
  if (!code) return '';
  const summary = code.summary ?? {}, unmatched = code.unmatched;
  const locations = code.called_from?.length
    ? `<h4>Stack references</h4><ul>${code.called_from.map(location => `<li>${codeLocationHtml(location)}</li>`).join('')}</ul>` : '';
  const list = (title, entries, describe) => entries?.length
    ? `<h4>${title}</h4><ul>${entries.map(entry => `<li>${describe(entry)}</li>`).join('')}</ul>` : '';
  const unmatchedHtml = unmatched ? [
    list('Routes without a stack', unmatched.routes, row => `<code>${esc(row.operation ?? row.op ?? `${row.method ?? ''} ${row.path ?? ''}`)}</code> ${row.file ? codeLocationHtml(row) : (row.locations ?? []).map(codeLocationHtml).join('<br>')}`),
    list('Hosts without a stack', unmatched.hosts, row => `<code>${esc(row.host ?? '')}</code> ${row.file ? codeLocationHtml(row) : (row.locations ?? []).map(codeLocationHtml).join('<br>')}`),
    list('Stack operations without a code location', unmatched.operations, row => `<code>${esc(row.stack || 'default')}</code> · <code>${esc(row.operation ?? row.op ?? '')}</code>`),
  ].join('') : '';
  return `<div class="am-code"><h3>In the code</h3><p class="am-basis">Declared by code: local signatures and configuration references, not runtime behavior. ${esc(summary.defined_locations ?? 0)} definition locations; ${esc(summary.call_sites ?? 0)} call sites; ${esc(summary.unmatched_routes ?? 0)} routes without a stack; ${esc(summary.unmatched_hosts ?? 0)} hosts without a stack; ${esc(summary.unmatched_operations ?? 0)} stack operations without code.${summary.withheld_paths ? ` ${esc(summary.withheld_paths)} code paths withheld.` : ''}</p>${locations}${unmatchedHtml}</div>`;
}

const STANDING_DEFINITIONS = Object.freeze({
  'observed': 'The newest response retained in this scope completed with a 2xx status, every assertion on it passed, and its evidence still matches; no earlier response retained in this scope failed. This is the label show prints; show also prints observed for an operation observed after a failed attempt.',
  'observed-after-failure': 'Observed, and an earlier response retained in this scope was non-2xx or failed an assertion. When that earlier response cannot be counted, the reason is named.',
  'latest-response': 'The newest response retained in this scope did not pass (a non-2xx status or a failed assertion) or cannot be counted (older than the staleness horizon, evidence missing or changed, incomplete); nothing passed after it. The reason is named beside the status; a response that did not fail but cannot be counted has a neutral marker.',
  'no-response': 'A read with no response retained in this scope.',
  'write-no-response': 'A write (not GET or HEAD) with no response retained in this scope. It may or may not have been sent; nothing in this scope records it.',
  'scope-unresolved': 'No provider, environment and contract identity could be bound for this operation, so no response can be counted for it. The reason is named beside it.',
  'unavailable': 'The retained history could not be read completely, or the operation cannot be held as an identity in the store, or its path was withheld; the reason or code is named, so no label is given.',
});

function sourceSentence(source) {
  const who = source.repository ? `granted provider ${source.name ?? 'unnamed'} (${source.repository})` : '';
  switch (source.kind) {
    case 'provider-missing': return `${who}: directory missing; its history is not included`;
    case 'provider-unreadable': return `${who}: its store cannot be read (${source.code}); labels are withheld because a newer response could be held there`;
    case 'local-unreadable': return `this repository's observation history cannot be read (${source.code}); labels are withheld`;
    case 'registry-unreadable': return `the registry cannot be read (${source.code}); granted history cannot be checked, so labels are withheld`;
    default: return '';
  }
}

/**
 * The API map as an HTML fragment. `withheldLine: false` leaves out the line
 * that counts what was withheld, for a page that prints one line for all of
 * its sections (view).
 */
export function renderApiMapHtml(model, { withheldLine = true } = {}) {
  if (model?.kind === 'stack-api-map') return '<div id="api-map">' + renderStackIndex(model) + renderCodeIndexHtml(model.code) + '\n' + model.stacks.map(row =>
    `<section id="${row.viewport}" class="stack-viewport" data-stack="${esc(row.name)}"><h2>Stack ${esc(row.name)}</h2>` +
    `<p class="am-basis">Environments: ${esc(row.environments.join(', ') || 'none')}. Contract: ${esc(row.api_map.contract?.state ?? 'not-named')}.</p>` +
    renderStackApiMapHtml(row) + '</section>').join('\n') + '</div>';
  if (!model || model.state === 'missing')
    return `<section id="api-map" class="am"><h2>API map</h2><p class="am-basis">Basis: no knowledge store at <code>${esc(model?.store?.path ?? LAYOUT.context)}</code>; generated ${esc(day(model?.generated_at))} with evidence from the store and contract, and code locations from local source.</p><p>No knowledge store recorded; the API map is empty. No executions recorded yet.</p><p>${esc(formatEvidenceClasses(model?.counts?.evidence_classes ?? evidenceClassCounts([])))}</p>${renderCodeIndexHtml(model?.code)}</section>`;
  if (model.state !== 'mapped')
    return `<section id="api-map" class="am"><h2>${esc(model.name)} — API map</h2><p class="am-basis">Basis: <code>${esc(model.store.path)}</code>, generated ${esc(model.store.generated_at ?? 'date not recorded')}; no contract operations to map${model.contract?.path && model.contract.state !== 'read' ? ` (contract <code>${esc(model.contract.path)}</code> — ${esc(contractStateText(model.contract.state))})` : ''}.</p><p>No operations recorded.</p><p>${esc(formatEvidenceClasses(model.counts?.evidence_classes ?? evidenceClassCounts([])))}</p>${renderCodeIndexHtml(model.code)}</section>`;
  const c = model.counts, scope = model.scope, rows = model.operations;
  const contract = model.contract.path
    ? `contract <code>${esc(model.contract.path)}</code>${model.contract.version ? ` (version ${esc(model.contract.version)})` : ''}${model.contract.state === 'read' ? '' : ` — ${esc(contractStateText(model.contract.state))}`}`
    : 'no contract named';
  const range = model.observations.counted
    ? `${plural(model.observations.counted, 'counted response')} observed ${esc(day(model.observations.first_observed_at))} to ${esc(day(model.observations.last_observed_at))}`
    : 'no counted responses';
  const basis = `<p class="am-basis">Basis: ${contract}; store <code>${esc(model.store.path)}</code> generated ${esc(model.store.generated_at ?? 'date not recorded')}; ${range}. Generated ${esc(day(model.generated_at))} with evidence from the store and contract, and code locations from local source; nothing was executed.</p>`;
  const scopeLine = scope.state === 'bound'
    ? `<p class="am-basis">Scope: provider <code>${esc(scope.provider)}</code> · environment ${esc(scope.environment)}${scope.production ? ', marked production' : ''} · contract digest <code>${esc(scope.contract_digest.slice(0, 19))}…</code>${model.observations.outside_scope ? ` · ${plural(model.observations.outside_scope, 'retained response')} outside this scope` : ''}.</p>`
    : `<p class="am-basis">Scope unresolved: ${esc(scope.reason)}${scope.problems?.length ? ` (${esc(scope.problems.join(', '))})` : ''}. Environment ${esc(scope.environment)}; no response can be counted.</p>`;
  const sources = (model.sources ?? []).map(sourceSentence).filter(Boolean);
  const sourcesLine = sources.length ? `<p class="am-basis">History sources: ${esc(sources.join('; '))}.</p>` : '';
  const notes = [
    ...(c.contract_only ? [`${plural(c.contract_only, 'contract operation')} not yet in the store`] : []),
    ...(c.store_only ? [`${plural(c.store_only, 'stored operation')} not in the contract`] : []),
    ...(model.observations.outside_map ? [`${plural(model.observations.outside_map, 'retained response')} for operations outside this map`] : []),
    ...(model.omissions.non_http_store_keys ? [`${plural(model.omissions.non_http_store_keys, 'stored key')} that is not an HTTP operation`] : []),
    ...(model.omissions.declared_parameters_unresolved ? [`${plural(model.omissions.declared_parameters_unresolved, 'operation declares', 'operations declare')} parameters that cannot all be resolved to a name and location (a reference that cannot be resolved, an entry missing either, or a parameters value that is not a list), so the undeclared-parameter check is skipped for ${model.omissions.declared_parameters_unresolved === 1 ? 'it' : 'them'}`] : []),
  ];
  const withheld = withheldLine ? withheldSentence(model.withheld) : '';
  const tile = (n, label) => `<div class="am-tile"><b>${esc(n)}</b><span>${esc(label)}</span></div>`;
  const tiles = `<div class="am-tiles">${[
    tile(c.operations, 'operations'),
    ...Object.entries(c.evidence_classes).map(([kind, count]) => tile(count, kind)),
    tile(c.observed_total, `passing response histories (${c['observed-after-failure']} after a failed attempt)`),
    tile(c['latest-response'], 'latest response not passing or not counted'),
    tile(c['no-response'], 'reads — no response recorded'),
    tile(c['write-no-response'], 'writes — no response recorded'),
    ...(c['scope-unresolved'] ? [tile(c['scope-unresolved'], 'scope unresolved')] : []),
    ...(c.unavailable ? [tile(c.unavailable, 'observations unavailable')] : []),
    tile(c.notes, 'notes'), tile(c.key_slots_sourced, `of ${c.key_slots} path keys with a recorded source`),
  ].join('')}</div>`;
  const present = STANDING_KEYS.filter(key => c[key]);
  const legend = `<dl class="am-legend">${present.map(key => `<div><dt>${standingChip({ key, label: API_MAP_STANDINGS[key] })}</dt><dd>${esc(STANDING_DEFINITIONS[key])}</dd></div>`).join('')}` +
    (c.learned_verified || c.learned_suspect ? `<div><dt><span class="am-chip am-learned">learned</span></dt><dd>${esc('A legacy learn verification of the contract shape, shown beside the standing and never merged into it.')}</dd></div>` : '') + `</dl>`;
  const hub = model.hub
    ? `<p class="am-basis">Hub <code>${esc(model.hub.prefix)}</code> covers ${esc(model.hub.operations)} of ${esc(c.operations)} operations; <code>…</code> abbreviates it inside groups.</p>` : '';
  const heading = group => group.source === 'path' ? `<code>${esc(group.name === '/' ? '/' : `/${group.name}`)}</code>` : esc(group.name);
  const groupHtml = model.groups.map(group => `<div class="am-group"><h4>${heading(group)} <span class="am-n">${esc(group.operations.length)}</span></h4>` +
    `<div class="am-scroll"><table><thead><tr><th>method</th><th>path</th><th>evidence class</th><th>response standing</th><th>latest</th><th>notes</th><th>in the code</th></tr></thead><tbody>\n` +
    group.operations.map(index => {
      const row = rows[index];
      return `<tr><td class="am-nw">${methodChip(row.method)}</td><td>${pathCell(row, row.display_path)}</td><td>${evidenceChip(row.evidence_class)}</td><td>${standingChip(row.standing)}${learnedChip(row.learned)}${qualifiersHtml(row.standing)}</td><td class="am-nw">${esc(row.latest_status_codes.join(', ') || '—')}</td><td>${esc(row.notes)}</td><td>${renderOperationCodeHtml(row.code)}</td></tr>`;
    }).join('\n') + `\n</tbody></table></div></div>`).join('\n');
  const slots = model.key_slots ?? [];
  const keys = slots.length
    ? `<div class="am-scroll"><table class="am-wide"><thead><tr><th>key</th><th>path</th><th>comes from</th></tr></thead><tbody>\n` +
      slots.map(slot => `<tr><td><code>${esc(slot.param)}</code></td><td><code>${esc(slot.prefix)}</code></td><td>${slot.sources.length
        ? slot.sources.map(source => `<code>${esc(source.operation)}</code> → <code>${esc(source.field)}</code> <span class="am-q">seen on ${esc(plural(source.seen_on, 'operation'))}</span>`).join('<br>') +
          (slot.more ? `<br>and ${esc(slot.more)} more` : '')
        : slot.beyond_read_bound ? 'not shown (a key-source list under it is beyond the read bound)' : 'not recorded'}</td></tr>`).join('\n') + `\n</tbody></table></div>`
    : `<p>${model.contract.state === 'read' ? 'No contract operation has a path key.' : 'No readable contract; path keys cannot be listed.'}</p>`;
  const keyBasis = `Basis: one row per path key of the contract (the path prefix that ends in it) with the key-source records on the operations in this scope under it; a key with no record says not recorded. Query keys and every operation's own records stay in the operation details.${model.omissions.key_source_records_damaged
    ? ` ${plural(model.omissions.key_source_records_damaged, 'operation record has', 'operation records have')} a damaged key-source list; ${model.omissions.key_source_records_damaged === 1 ? 'its links are' : 'their links are'} treated as absent.` : ''}${c.key_sources_omitted
    ? ` ${plural(c.key_sources_omitted, 'operation record has', 'operation records have')} a key-source list beyond the read bound; ${c.key_sources_omitted === 1 ? 'its links are' : 'their links are'} not shown.` : ''}`;
  const notesHtml = model.notes.length
    ? `<div class="am-scroll"><table><thead><tr><th>operation</th><th>note</th><th>author</th><th>date</th><th>evidence</th></tr></thead><tbody>\n` +
      model.notes.map(note => `<tr><td><code>${esc(note.op)}</code></td><td>${esc(note.text)}${note.contradictions?.length ? `<p class="am-q">Contradicted by the latest response: ${esc(note.contradictions.join(', '))}. The authored claim is retained.</p>` : ''}</td><td>${esc(note.by ?? 'not recorded')}</td><td class="am-nw">${esc(note.at ?? 'not recorded')}</td><td>${note.evidence.length ? note.evidence.map(ref => `<code>${esc(ref.run_id)}</code> <span class="am-q">${esc(ref.state)}</span>`).join('<br>') : '—'}</td></tr>`).join('\n') + `\n</tbody></table></div>`
    : `<p>No active authored notes recorded.</p>`;
  const historyIssues = rows.filter(row => ['invalid', 'changed'].includes(row.note_history));
  const methods = API_MAP_METHODS.filter(method => rows.some(row => row.method === method));
  const radio = (group, value) => `<input type="radio" class="am-radio" name="am-${group}" id="am-${group}-${value}"${value === 'all' ? ' checked' : ''}>`;
  const option = (group, value, label) => `<label for="am-${group}-${value}">${esc(label)}</label>`;
  const filters = [
    radio('method', 'all'), ...methods.map(method => radio('method', method.toLowerCase())),
    radio('standing', 'all'), ...present.map(key => radio('standing', key)),
    `<fieldset class="am-filter"><legend>Method</legend>${option('method', 'all', 'all')}${methods.map(method => option('method', method.toLowerCase(), method)).join('')}</fieldset>`,
    `<fieldset class="am-filter"><legend>Standing</legend>${option('standing', 'all', 'all')}${present.map(key => option('standing', key, API_MAP_STANDINGS[key])).join('')}</fieldset>`,
  ].join('\n');
  const all = `<div class="am-scroll"><table class="am-all am-wide"><thead><tr><th>method</th><th>path</th><th>tag</th><th>summary</th><th>evidence class</th><th>response standing</th><th>statuses</th><th>in the code</th></tr></thead><tbody>\n` +
    rows.map(row => `<tr class="am-r am-row-${API_MAP_METHODS.includes(row.method) ? row.method.toLowerCase() : 'get'} am-row-${STANDING_KEYS.includes(row.standing.key) ? row.standing.key : 'unavailable'}"><td class="am-nw">${methodChip(row.method)}</td><td>${pathCell(row, row.path)}</td><td>${esc(row.tag_withheld ? WITHHELD : row.tag ?? (row.in_contract ? 'untagged' : 'not in the contract'))}</td><td>${esc(row.summary ?? '')}</td><td>${evidenceChip(row.evidence_class)}</td><td>${standingChip(row.standing)}${learnedChip(row.learned)}${qualifiersHtml(row.standing)}</td><td class="am-nw">${esc(row.status_codes.join(', ') || '—')}</td><td>${renderOperationCodeHtml(row.code)}</td></tr>`).join('\n') + `\n</tbody></table></div>`;
  const scopeText = scope.state === 'bound'
    ? `The scope is the provider ${scope.provider}, the environment ${scope.environment} and the contract digest ${scope.contract_digest}: exactly the identity show binds. Responses retained under another environment, provider or contract version are counted beside a standing and never change it.`
    : `No scope could be bound (${scope.reason}), so every operation is scope unresolved; show reports the same.`;
  const read = `<p>${esc(`Each standing is computed from the knowledge store and the contract only, with the rules show uses. ${scopeText} A counted response is a client observation in this scope that is complete, has a status, is within the ${model.stale_days}-day staleness horizon and whose evidence file still matches its recorded digest; evidence is hashed, never read for content. "using parameters the contract does not declare" names the query parameter names recorded in the request shape of the newest counted request that the contract does not declare for that operation; an operation with a declared parameter that cannot be resolved to a name and location is not checked. "learned" is the legacy learn verification of the contract shape, shown beside and never merged. Notes are active authored notes with their recorded author, date and evidence run ids; they are claims, not verification. Key sources are recorded links from a path or query key to the earlier response field it came from. No request or response values appear on this page; a stored or declared value the secret scan flags reads withheld.`)}</p>` +
    `<dl class="am-legend">${STANDING_KEYS.map(key => `<div><dt>${standingChip({ key, label: API_MAP_STANDINGS[key] })}</dt><dd>${esc(STANDING_DEFINITIONS[key])}</dd></div>`).join('')}</dl>`;
  return [
    `<section id="api-map" class="am" aria-labelledby="am-title">`,
    `<h2 id="am-title">${esc(model.name)} — API map</h2>`,
    basis, scopeLine, sourcesLine,
    renderCodeIndexHtml(model.code),
    notes.length ? `<p class="am-basis">${esc(notes.join('; '))}.</p>` : '',
    withheld ? `<p class="am-basis">${esc(withheld)}</p>` : '',
    tiles, '<p class="am-basis">Evidence classes count each operation once: written declarations or claims without current eligible execution evidence; observed responses without passing assertions; asserted responses with passing client assertions; verified by fresh learn. Observed includes failed responses and is not a success claim. Response history below preserves its separate standing and failure details.</p>', legend, hub,
    `<h3>Operations by ${model.groups.some(group => group.source === 'tag') ? 'tag' : 'path'}</h3>`,
    groupHtml,
    `<h3>Where each path key comes from</h3>`,
    `<p class="am-basis">${esc(keyBasis)}</p>`,
    keys,
    `<h3>Notes</h3>`,
    `<p class="am-basis">Basis: active authored notes in the store, with recorded author, date and evidence run ids.${historyIssues.length ? ` Note history needs review for ${esc(historyIssues.map(row => row.op).join(', '))}.` : ''}</p>`,
    notesHtml,
    `<h3>All operations</h3>`,
    `<div class="am-filters">`, filters, all, `</div>`,
    `<h3>How to read this</h3>`,
    read,
    `</section>`,
  ].filter(Boolean).join('\n');
}

function contractStateText(state) {
  return { missing: 'missing', unreadable: 'unreadable', empty: 'declares no operations', 'not-named': 'not named' }[state] ?? state;
}

// One static stylesheet. Every selector is built from the fixed method and
// standing vocabulary above; colours come from the host page's tokens
// (--ink, --muted, --line, --card, --bg) so light and dark follow the page.
const hue = { get: '#3d7fc4', head: '#7a7a74', post: '#2f9e5b', put: '#b07d18', patch: '#b07d18', delete: '#d14b4b', options: '#7a7a74' };
const standingHue = { 'observed': '#2f9e5b', 'observed-after-failure': '#7fa832', 'latest-response': '#d14b4b',
  'no-response': '#8a8a83', 'write-no-response': '#b07d18', 'scope-unresolved': '#7a6fc0', 'unavailable': '#d14b4b' };
const filterKeys = [['method', ['all', ...API_MAP_METHODS.map(method => method.toLowerCase())]], ['standing', ['all', ...STANDING_KEYS]]];
// Stack viewports can be narrower than the browser. Let labels and tiles reflow
// against their container; table minima scale with text inside scroll wrappers.
export const API_MAP_CSS = [
  '.am{--am-ink:var(--ink,#1c1c1a);--am-muted:var(--muted,#666660);--am-line:var(--line,#e4e4df);--am-card:var(--card,#fff);--am-bg:var(--bg,#f7f7f5);color:var(--am-ink)}',
  '.am h3{font-size:1rem;margin:24px 0 8px}.am h4{font-size:.95rem;margin:16px 0 6px;display:flex;gap:8px;align-items:baseline}.am .am-n{color:var(--am-muted);font-weight:400}',
  '.am .am-basis{color:var(--am-muted);font-size:.875rem;margin:0 0 6px}.am p{max-width:none}.am p,.am dd,.am h2,.am h4,.am .am-q{overflow-wrap:anywhere}',
  '.am-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,11rem),1fr));gap:10px;margin:14px 0}',
  '.am-tile{min-width:0;overflow-wrap:anywhere;border:1px solid var(--am-line);border-radius:10px;padding:10px 12px;background:var(--am-card)}.am-tile b{display:block;font-size:1.6rem;line-height:1.15}.am-tile span{display:block;color:var(--am-muted);font-size:.8rem}',
  '.am-legend{display:grid;gap:6px;margin:12px 0}.am-legend>div{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline}.am-legend dt{flex:0 1 18rem;min-width:0;max-width:100%}.am-legend dd{flex:1 1 28rem;min-width:0;max-width:100%;margin:0;color:var(--am-muted);font-size:.85rem}',
  '.am-chip{display:inline-block;box-sizing:border-box;max-width:100%;overflow-wrap:anywhere;padding:0 8px 0 6px;border:1px solid var(--am-line);border-left:4px solid var(--am-hue,var(--am-muted));border-radius:6px;background:color-mix(in srgb,var(--am-hue,var(--am-muted)) 13%,transparent);color:var(--am-ink);font-size:.8rem;line-height:1.6;white-space:normal}',
  '.am-learned{--am-hue:#3d7fc4}.am-q{display:block;color:var(--am-muted);font-size:.8rem;margin-top:3px}',
  ...Object.entries(standingHue).map(([key, value]) => `.am-s-${key}{--am-hue:${value}}`),
  '.am-chip.am-tone-neutral{--am-hue:#8a8a83}',
  '.am-m{display:inline-block;min-width:4.6em;padding:0 6px;border:1px solid var(--am-line);border-left:4px solid var(--am-hue,var(--am-muted));border-radius:4px;font:600 .72rem/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--am-ink);white-space:nowrap}',
  ...Object.entries(hue).map(([key, value]) => `.am-m-${key}{--am-hue:${value}}`),
  '.am-scroll{overflow-x:auto;max-width:100%;border:1px solid var(--am-line);border-radius:10px;background:var(--am-card);margin:6px 0 12px}',
  '.am table{border-collapse:collapse;width:100%;min-width:40rem;font-size:.85rem}.am th,.am td{text-align:left;padding:7px 10px;border:0;border-bottom:1px solid var(--am-line);vertical-align:top;background:transparent;color:var(--am-ink)}',
  '.am .am-nw{white-space:nowrap}.am .am-wide{min-width:51.25rem}.am-group table{table-layout:fixed}',
  '.am-group th:nth-child(1){width:7.5em}.am-group th:nth-child(2){width:36%}.am-group th:nth-child(4){width:6em}.am-group th:nth-child(5){width:5.5em}',
  '.am th{color:var(--am-muted);font-size:.72rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}.am tr:last-child td{border-bottom:0}.am td code{overflow-wrap:anywhere}',
  '.am-radio{position:absolute;opacity:0;width:1px;height:1px;margin:0;pointer-events:none}',
  '.am-filter{display:flex;flex-wrap:wrap;gap:6px;align-items:center;border:0;padding:0;margin:8px 0}.am-filter legend{float:left;margin-right:6px;padding:0;color:var(--am-muted);font-size:.8rem}',
  '.am-filter label{cursor:pointer;padding:1px 10px;border:1px solid var(--am-line);border-radius:999px;font-size:.8rem;background:var(--am-card)}',
  ...filterKeys.flatMap(([group, values]) => values.flatMap(value => [
    `#am-${group}-${value}:checked~.am-filter label[for="am-${group}-${value}"]{background:var(--am-ink);color:var(--am-bg);border-color:var(--am-ink)}`,
    `#am-${group}-${value}:focus-visible~.am-filter label[for="am-${group}-${value}"]{outline:2px solid var(--am-ink);outline-offset:2px}`,
    ...(value === 'all' ? [] : [`#am-${group}-${value}:checked~.am-scroll .am-r:not(.am-row-${value}){display:none}`]),
  ])),
].join('\n');

// --- terminal --------------------------------------------------------------

export function renderApiMapText(model) {
  if (model?.kind === 'stack-api-map') return `Stack index — ${model.stacks.length} stacks\n` + model.stack_index.map(row =>
    `  ${terminalText(row.name)}: ${row.operations} operations; ${formatEvidenceClasses(row.evidence_classes)}; ${row.responses} responses; ${row.notes} notes`).join('\n') +
    '\n\n' + model.stacks.map(row => `Stack ${terminalText(row.name)}\n${renderApiMapText(row.api_map)}`).join('\n\n');
  if (!model || model.state === 'missing') return `API map — no knowledge store recorded.\n  ${formatEvidenceClasses(model?.counts?.evidence_classes ?? evidenceClassCounts([]))}`;
  if (model.state !== 'mapped') return `API map — ${terminalText(model.name)}: no operations recorded.\n  ${formatEvidenceClasses(model.counts?.evidence_classes ?? evidenceClassCounts([]))}`;
  const c = model.counts, scope = model.scope;
  const fact = (label, value) => `  ${label.padEnd(30)} ${value}`;
  const lines = [
    `API map — ${terminalText(model.name)}: ${plural(c.operations, 'operation')}`,
    fact('evidence classes', formatEvidenceClasses(c.evidence_classes)),
    fact('passing response histories', `${c.observed_total} (${c['observed-after-failure']} after a failed attempt)`),
    fact('latest response not passing', `${c['latest-response']} (failed or not counted)`),
    fact('reads, no response recorded', String(c['no-response'])),
    fact('writes, no response recorded', String(c['write-no-response'])),
    ...(c['scope-unresolved'] ? [fact('scope unresolved', String(c['scope-unresolved']))] : []),
    ...(c.unavailable ? [fact('observations unavailable', String(c.unavailable))] : []),
    fact('learned, shown beside', `${c.learned_verified} verified, ${c.learned_suspect} suspect`),
    fact('notes · path keys sourced', `${c.notes} · ${c.key_slots_sourced} of ${c.key_slots}`),
    ...(scope.state === 'bound' ? [
      fact('scope', `${terminalText(scope.environment)}${scope.production ? ', marked production' : ''} · ${terminalText(scope.provider)}`),
      fact('contract', `${terminalText(scope.contract_digest.slice(0, 19))}… · ${model.observations.counted
        ? `responses ${day(model.observations.first_observed_at)} to ${day(model.observations.last_observed_at)}` : 'no counted responses'}`),
    ] : [fact('scope', `unresolved: ${terminalText(scope.reason)}`)]),
    ...(model.sources ?? []).map(source => fact('history source', terminalText(sourceSentence(source)))),
  ];
  return lines.join('\n');
}
