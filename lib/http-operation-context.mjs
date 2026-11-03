// Scoped bridge from the HTTP client into the additive protocol context store.
// Configuration establishes capture scope; an origin resemblance never does.
import { readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { captureOperationContext, operationIdentity, operationId, queryOperationContext } from './operation-context.mjs';
import { readContract, operationsFrom } from './context.mjs';
import { resolveConfig } from './config.mjs';
import { linkCapturedRun } from './key-source-evidence.mjs';
import { contractKeyProfile } from './key-sources.mjs';
import { stacksMigrationCapture } from './stack-migration-state.mjs';

// A declared prefix is prepended only for endpoint matching; the canonical
// operation remains the contract's method/path identity. contractMount below
// supplies a base-URL mount only when no explicit prefix was selected.
export function loadHttpContract(file, { pathPrefix = '', onDiagnostic } = {}) {
  const report = item => {
    // A failed warning sink must not reject a readable contract or turn the
    // sink failure into a misleading parse error.
    try { onDiagnostic?.(item); } catch { /* diagnostics are best-effort */ }
  };
  const reject = reason => {
    report({ code: 'HTTP_CONTRACT_REJECTED', reason });
    return null;
  };
  try {
    if (typeof file !== 'string' || !file) return null;
    if (typeof pathPrefix !== 'string') return reject('invalid-path-prefix');
    const prefix = pathPrefix.replace(/\/+$/, '');
    if (prefix && (!prefix.startsWith('/') || /[\s?#{}\\]/u.test(prefix)
      || new URL(prefix, 'https://contract.invalid').pathname !== prefix)) return reject('invalid-path-prefix');
    const { doc, raw } = readContract(file);
    const skippedRoutes = [];
    const routes = operationsFrom(doc, { onSkipped: item => { skippedRoutes.push(item); report(item); } })
      .map(operation => ({ ...operation, endpointPath: `${prefix}${operation.path}` }));
    if (!routes.length) return reject('no-matchable-routes');
    // A declared prefix is recorded so the base-URL mount (contractMount) never
    // stacks a second, inferred prefix on top of an explicit one.
    const contract = { routes, digest: `sha256:${createHash('sha256').update(raw).digest('hex')}`,
      ...(prefix ? { pathPrefix: prefix } : {}), ...(skippedRoutes.length ? { skippedRoutes } : {}) };
    // What the contract says about key linking (declared property names, pinned
    // parameter and response values), computed on first use. Not enumerable:
    // the binding never carries the document into an envelope or a report.
    let profile;
    Object.defineProperty(contract, 'keyProfile', { enumerable: false, get: () => (profile ??= contractKeyProfile(doc)) });
    return contract;
  } catch { return reject('unreadable-contract'); }
}

/** Every contract the configuration binds in any environment: the primary
 * API's and each named upstream's. The key-source backfill reads contract
 * rules by digest from these; one that cannot be loaded is left out. */
export function configuredHttpContracts(root) {
  const files = new Set();
  let environments = [undefined];
  try {
    const config = resolveConfig(root);
    if (typeof config.file === 'string') {
      const declared = JSON.parse(readFileSync(config.file, 'utf8'))?.environments;
      if (declared && typeof declared === 'object' && !Array.isArray(declared)) environments = [undefined, ...Object.keys(declared)];
    }
  } catch { /* no readable configuration: only the default resolution below */ }
  for (const environment of environments) {
    let config;
    try { config = resolveConfig(root, { environment }); } catch { continue; }
    if (typeof config.contract === 'string' && config.contract) files.add(config.contract);
    for (const host of Object.values(config.hosts ?? {}))
      if (typeof host?.contract === 'string' && host.contract) files.add(host.contract);
  }
  return [...files].map(file => loadHttpContract(file)).filter(Boolean);
}

// --- one comparison form ---------------------------------------------------
// The client builds a request URL with the URL parser, which percent-encodes
// some characters of a path (non-ASCII text, `^`, braces, a zero-width space)
// and keeps escapes an agent wrote (`%c3%a9`) as written; a contract writes its
// paths as text. Contract paths and request paths are therefore compared in
// one form: each path segment percent-decoded (a run of escapes that is not
// valid UTF-8 stays as written). Splitting on "/" first keeps an encoded slash
// (`%2F`) inside its segment, and a contract's `{parameter}` templates are
// found in the contract's own text before decoding, so an encoded brace in a
// request is never a template.
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/gu;
const decodeSegment = segment => !segment.includes('%') ? segment
  : segment.replace(ESCAPE_RUN, run => { try { return decodeURIComponent(run); } catch { return run; } });
const requestSegments = pathname => pathname.split('/').map(decodeSegment);

// One contract segment, parsed once: `{ literal }` (no parameter), `{ any }`
// (a whole-segment parameter: any nonempty value) or `{ pattern }` (literal
// code points, with null for each parameter). A `{` opens a parameter only
// when a `}` follows it; an incomplete brace stays literal text.
function segmentToken(segment) {
  if (!segment.includes('{')) return { literal: decodeSegment(segment) };
  if (/^\{[^{}]*\}$/u.test(segment)) return { any: true };
  const pattern = [];
  let parameters = 0;
  for (let cursor = 0; cursor < segment.length;) {
    const open = segment.indexOf('{', cursor);
    const close = open < 0 ? -1 : segment.indexOf('}', open + 1);
    if (close < 0) {
      for (const char of decodeSegment(segment.slice(cursor))) pattern.push(char);
      break;
    }
    for (const char of decodeSegment(segment.slice(cursor, open))) pattern.push(char);
    pattern.push(null);
    parameters++;
    cursor = close + 1;
  }
  return parameters ? { pattern } : { literal: decodeSegment(segment) };
}

// Loaded contracts are not mutated; a route whose path changed is re-parsed.
const routeShapes = new WeakMap();
function routeTokens(route) {
  const cached = routeShapes.get(route);
  if (cached?.path === route.endpointPath) return cached.tokens;
  const tokens = route.endpointPath.split('/').map(segmentToken);
  routeShapes.set(route, { path: route.endpointPath, tokens });
  return tokens;
}
const literalRoute = tokens => tokens.every(token => token.literal !== undefined);

// Binding every operation of a large contract asks contractMount once per
// operation; the answer depends only on the loaded contract and the base path.
const mounts = new WeakMap();

/**
 * Where a contract's paths sit under a configured base URL. The client builds a
 * request URL as the base URL followed by the path an agent passes. A contract
 * is used as written when any of its routes covers the base URL's path: its
 * leading segments match the base path's segments one for one, where a
 * `{template}` segment matches any one segment (`/{tenant}/items` covers
 * `/acme`; `/ex/jira/{cloudid}/rest/…` covers `/ex/jira/abc`). Otherwise the
 * contract was written relative to the base URL (base `https://h/api`, paths
 * `/v1/items`) and is mounted at the base URL's own path: its operations bind
 * at `/api/v1/items`. An explicit `contractPathPrefix` is authoritative. Nothing
 * is inferred from `servers` or from a request URL: the base URL is
 * configuration. The decision is made once per contract and base path and is
 * shared by capture, the undeclared-path drift check and binding. Returns the
 * mount ("" for none).
 */
export function contractMount(contract, baseUrl) {
  if (!contract || !Array.isArray(contract.routes) || contract.pathPrefix) return '';
  let base;
  try { base = new URL(baseUrl).pathname.replace(/\/+$/u, ''); } catch { return ''; }
  if (!base) return '';
  const cached = mounts.get(contract);
  const key = `${contract.routes.length}\u0000${base}`;
  if (cached?.routes === contract.routes && cached.answers.has(key)) return cached.answers.get(key);
  const wanted = requestSegments(base);
  const covers = route => {
    if (typeof route?.endpointPath !== 'string') return false;
    const tokens = routeTokens(route);
    return tokens.length >= wanted.length && wanted.every((segment, index) => tokenMatches(tokens[index], segment));
  };
  const mount = contract.routes.some(covers) ? '' : base;
  const entry = cached?.routes === contract.routes ? cached : { routes: contract.routes, answers: new Map() };
  entry.answers.set(key, mount);
  mounts.set(contract, entry);
  return mount;
}

// A bounded receipt of the actual matching choice, shared by doctor and the
// client. It does not infer anything from servers[] or a request's pathname.
export function httpContractMountInfo(contract, baseUrl) {
  if (contract?.pathPrefix) return { pathPrefix: contract.pathPrefix, source: 'contractPathPrefix' };
  const pathPrefix = contractMount(contract, baseUrl);
  return { pathPrefix, source: pathPrefix ? 'base-url-path' : 'contract-routes' };
}

// A request path matched under a mount: the part after the mount, or null when
// the path is not under it.
const belowMount = (pathname, mount) => !mount ? pathname
  : pathname === mount ? '/' : pathname.startsWith(`${mount}/`) ? pathname.slice(mount.length) : null;

// One decoded request segment against one contract segment.
function tokenMatches(token, value) {
  if (token.literal !== undefined) return token.literal === value;
  // A whole-segment parameter is the common case: any nonempty value.
  if (token.any) return value.length > 0;
  // Each null is a nonempty parameter. Literals are Unicode code points; the
  // contract text is never interpreted as code.
  const pattern = token.pattern;
  const chars = Array.from(value);
  if (pattern.length > chars.length) return false;
  let previous = new Uint8Array(chars.length + 1);
  previous[0] = 1;
  // Dynamic reachability is O(template length * segment length), with linear
  // memory. Adjacent parameters cannot trigger combinatorial backtracking.
  for (const part of pattern) {
    const current = new Uint8Array(chars.length + 1);
    for (let end = 1; end <= chars.length; end++) {
      current[end] = part === null
        ? previous[end - 1] || current[end - 1]
        : previous[end - 1] && part === chars[end - 1] ? 1 : 0;
    }
    previous = current;
  }
  return previous[chars.length] === 1;
}

// Decoded request segments against a route's tokens, keeping the existing
// optional single trailing slash, including routes that already declare their
// own trailing slash.
function tokensMatch(tokens, actual) {
  const segments = actual.length === tokens.length + 1 && actual.at(-1) === '' ? actual.slice(0, -1) : actual;
  return segments.length === tokens.length && tokens.every((token, index) => tokenMatches(token, segments[index]));
}

// A route can only match a path with the same number of segments, or one
// fewer when the path ends in "/" (the optional trailing slash in
// tokensMatch). Indexing a contract's routes by method and segment count lets
// one lookup skip every route that could never match, which matters when a
// caller binds every operation of a large contract (the API map). A route
// without a method or a path cannot match anything and is left out. Loaded
// contracts are not mutated; a changed routes array is re-indexed.
const routeIndexes = new WeakMap();
function routesByShape(contract) {
  const routes = contract.routes, cached = routeIndexes.get(contract);
  if (cached?.routes === routes && cached.length === routes.length) return cached.index;
  const index = new Map();
  for (const route of routes) {
    if (typeof route?.method !== 'string' || typeof route.endpointPath !== 'string') continue;
    const tokens = routeTokens(route), key = `${route.method}\u0000${tokens.length}`;
    (index.get(key) ?? index.set(key, []).get(key)).push({ route, tokens });
  }
  routeIndexes.set(contract, { routes, length: routes.length, index });
  return index;
}

/**
 * Every route a request path could bind to: `exact` holds the routes the path
 * names literally (a route written exactly as the path, or a route with no
 * parameter whose decoded segments equal the path's), which win over `matches`,
 * the routes whose templates match it. One answer binds; none or several do
 * not, and the caller can say which.
 */
export function httpOperationMatches(contract, method, pathname) {
  if (!Array.isArray(contract?.routes) || typeof method !== 'string' || typeof pathname !== 'string') return { exact: [], matches: [] };
  const index = routesByShape(contract);
  const actual = requestSegments(pathname);
  const same = index.get(`${method}\u0000${actual.length}`) ?? [];
  const exact = same.filter(({ route, tokens }) => route.endpointPath === pathname
    || literalRoute(tokens) && tokens.every((token, position) => token.literal === actual[position])).map(entry => entry.route);
  if (exact.length) return { exact, matches: [] };
  const matches = same.filter(entry => tokensMatch(entry.tokens, actual));
  if (actual.at(-1) === '')
    matches.push(...(index.get(`${method}\u0000${actual.length - 1}`) ?? []).filter(entry => tokensMatch(entry.tokens, actual)));
  return { exact, matches: matches.map(entry => entry.route) };
}

export function matchHttpOperation(contract, method, pathname) {
  const { exact, matches } = httpOperationMatches(contract, method, pathname);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  return matches.length === 1 ? matches[0] : null;
}

// `baseUrl` applies the same mount as identity binding, so a request that binds
// to an operation is never also reported as an undeclared path.
export const httpContractDeclaresPath = (contract, pathname, { baseUrl } = {}) => {
  const below = belowMount(pathname, contractMount(contract, baseUrl));
  if (below === null || !Array.isArray(contract?.routes)) return false;
  const actual = requestSegments(below);
  return contract.routes.some(route => typeof route?.endpointPath === 'string' && tokensMatch(routeTokens(route), actual));
};

/** The mounted part of a request URL's path that the contract's routes are
 * matched against, or null when the path is outside the mount. */
export const pathBelowMount = (contract, baseUrl, pathname) => belowMount(pathname, contractMount(contract, baseUrl));

/**
 * The path a request to one route has under a configured base URL, the way
 * the client builds it (base URL, then the path an agent passes). A mounted
 * contract sits below the base path. A contract used as written whose route
 * covers the base path (contractMount) has its leading segments filled by the
 * base path's own segments: `/{tenant}/items` under `https://h/acme` is
 * `/acme/items`, which binds back to `GET /{tenant}/items`. A route that does
 * not cover the base path keeps its own path, outside the base URL's.
 */
export function routeRequestPath(contract, baseUrl, route) {
  const mount = contractMount(contract, baseUrl);
  if (mount) return `${mount}${route.endpointPath}`;
  let base;
  try { base = new URL(baseUrl).pathname.replace(/\/+$/u, ''); } catch { return route.endpointPath; }
  if (!base || typeof route?.endpointPath !== 'string') return route.endpointPath;
  const wanted = requestSegments(base), tokens = routeTokens(route);
  if (tokens.length < wanted.length || !wanted.every((segment, index) => tokenMatches(tokens[index], segment))) return route.endpointPath;
  const rest = route.endpointPath.split('/').slice(wanted.length);
  return rest.length ? `${base}/${rest.join('/')}` : base;
}

export function httpContextScope(url, target, { baseUrl, baseUrlSource } = {}) {
  try {
    const actual = new URL(url), configured = new URL(target?.baseUrl);
    const primary = target?.name == null && target?.baseUrl === baseUrl;
    const explicit = primary ? ['config', 'env'].includes(baseUrlSource) : typeof target?.name === 'string';
    const prefix = configured.pathname.replace(/\/+$/, '');
    if (!explicit || target?.collision || !['http:', 'https:'].includes(configured.protocol)
      || configured.username || configured.password || configured.search || configured.hash
      || actual.origin !== configured.origin
      || prefix && actual.pathname !== prefix && !actual.pathname.startsWith(`${prefix}/`))
      return { eligible: false, reason: 'outside-configured-api-scope' };
    return { eligible: true, primary, provider: target.baseUrl };
  } catch { return { eligible: false, reason: 'outside-configured-api-scope' }; }
}

// Capture and retrieval must agree on every identity component. In particular,
// a legacy path resemblance or a primary contract cannot bind an integration.
export function httpContextIdentity(url, target, { method, environment, stack, ...config } = {}) {
  const scope = httpContextScope(url, target, config);
  const contract = scope.eligible ? target.httpContract : null;
  // The contract is mounted where the client builds its URLs (contractMount).
  const mount = contractMount(contract, target?.baseUrl);
  const below = belowMount(new URL(url).pathname, mount);
  const matched = below === null ? null : matchHttpOperation(contract, method, below);
  if (!matched) return null;
  return { provider: scope.provider, environment: environment ?? 'default', ...(stack ? { stack } : {}),
    protocol: 'http', operation: matched.op, endpoint: `${new URL(url).origin}${mount}${matched.endpointPath}`,
    contractDigest: contract.digest };
}

// Explain an unresolved identity using the same mount and matcher as capture.
// Request paths can contain private identifiers, so only reason codes and the
// configured mount choice leave this helper, never the actual request path.
export function httpContextRouteResolution(url, target, { method, ...config } = {}) {
  const result = (reason, message, extra = {}) => ({ reason, message: `${message} Shared capture was skipped; the request remains in private execution evidence.`, ...extra });
  if (!httpContextScope(url, target, config).eligible)
    return result('outside-configured-api-scope', 'The request is outside the explicitly configured API scope.');
  const contract = target?.httpContract;
  if (!contract) {
    const rejected = target?.httpContractDiagnostics?.find(item => item.code === 'HTTP_CONTRACT_REJECTED');
    return target?.contract
      ? result('contract-rejected', `The configured HTTP contract was rejected (${rejected?.reason ?? 'unavailable-contract'}).`,
        { contract_reason: rejected?.reason ?? 'unavailable-contract' })
      : result('contract-not-bound', 'No HTTP contract is bound to this configured target.');
  }
  const pathname = new URL(url).pathname, mount = httpContractMountInfo(contract, target.baseUrl);
  const below = pathBelowMount(contract, target.baseUrl, pathname);
  const { exact, matches } = httpOperationMatches(contract, method, below);
  const candidates = exact.length ? exact : matches;
  if (candidates.length > 1)
    return result('ambiguous-match', 'Multiple declared HTTP routes match this method and path.');
  if (candidates.length === 1) return null;

  const skipped = contract.skippedRoutes?.find(item => item.methods.includes(method)
    && matchHttpOperation({ routes: [{ method, endpointPath: `${contract.pathPrefix ?? ''}${item.path.split(/[?#]/u)[0]}` }] }, method, below));
  if (skipped) return result('route-skipped', `The matching contract path key was skipped (${skipped.reason}).`, { route_reason: skipped.reason });

  // Look for a route that would match without the mount, with the base mount
  // removed twice, or under the base mount instead of an explicit prefix.
  // These counterfactuals diagnose a prefix mismatch; they never bind it.
  let basePath = '';
  try { basePath = new URL(target.baseUrl).pathname.replace(/\/+$/u, ''); } catch { /* scope checked above */ }
  const relative = belowMount(pathname, basePath);
  const canonical = contract.pathPrefix ? { routes: contract.routes.map(route => ({ ...route, endpointPath: route.path })) } : contract;
  const prefixMismatch = below === null
    || mount.pathPrefix && matchHttpOperation(contract, method, pathname)
    || below !== null && basePath && matchHttpOperation(contract, method, belowMount(below, basePath))
    || contract.pathPrefix && matchHttpOperation(canonical, method, relative);
  if (prefixMismatch) return result('prefix-mismatch', 'The request path does not match the declared routes under the selected contract prefix.', { mount });
  return result('route-not-declared', 'No declared HTTP route matches this method and path under the selected contract prefix.');
}

// A compact delivery view of saved observations, never a legacy verification
// stamp. Keep exact identities and assertion outcomes even when shape/details
// must be withheld. The complete records remain available to explicit queries.
export function compactHttpContext(context, maxBytes) {
  const out = structuredClone(context);
  const fits = () => Buffer.byteLength(JSON.stringify(out)) <= maxBytes;
  for (const key of ['request_shape', 'response_shape', 'declaration', 'notes', 'omissions', 'evidence']) {
    for (const observation of [...out.observations].reverse()) {
      if (fits()) return out;
      if (Object.hasOwn(observation, key)) {
        delete observation[key];
        observation.details_omitted = true;
      }
    }
  }
  while (!fits() && out.issues?.length) {
    out.issues.pop();
    out.omissions.issues++;
  }
  while (!fits() && out.observations.length) {
    out.observations.pop();
    out.omissions.observations++;
  }
  if (!fits()) {
    delete out.identity;
    out.details_omitted = true;
  }
  if (!fits()) out.meaning = 'Earlier scoped history omitted; not current verification.';
  if (!fits()) {
    if (!out.issues?.length) delete out.issues;
    for (const [key, value] of Object.entries(out.omissions))
      if (key !== 'observations' && value === 0) delete out.omissions[key];
  }
  if (!fits()) out.meaning = 'Not current verification.';
  return out;
}

export function queryHttpContext(root, identity, { env = process.env, maxBytes = 16000 } = {}) {
  if (env.API_CONTEXT_OFF === '1' || !identity) return null;
  try {
    // All filters are required here, including nulls; no unscoped fallback.
    const exact = operationIdentity(identity);
    // This exact observation lookup must not acquire legacy-note diagnostics
    // or inferred scope. Authored notes have their own delivery projection.
    const saved = queryOperationContext(root, exact, { env, maxItems: 3, maxBytes: 1024 * 1024, includeNotes: false });
    const observations = [], omissions = { ...saved.omissions, observations: 0 };
    for (const entry of saved.operations) {
      omissions.observations += entry.omitted_observations + Math.max(0, entry.observations.length - 3);
      for (const observation of entry.observations.slice(-3).reverse())
        observations.push({ repository: entry.repository, ...observation });
    }
    if (!observations.length && !saved.issues.length && !Object.values(omissions).some(Boolean)) return null;
    return compactHttpContext({ operation_id: operationId(exact), identity: exact,
      meaning: 'Earlier scoped observations and claims; not current verification. Assertion counts belong only to their saved observation.',
      observations, omissions, ...(saved.issues.length ? { issues: saved.issues } : {}) }, maxBytes);
  } catch {
    return { state: 'unavailable', code: 'HTTP_CONTEXT_LOOKUP_FAILED', observations: [],
      omissions: { observations: 0 }, meaning: 'Saved HTTP context could not be read; no prior behavior was inferred.' };
  }
}

function projectEvidence(root, supplied) {
  try {
    if (typeof supplied !== 'string' || !supplied) return null;
    const base = realpathSync(root), file = realpathSync(resolve(base, supplied));
    const path = relative(base, file);
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return null;
    return { path: path.split(sep).join('/') };
  } catch { return null; }
}

// keyLinking: { evidenceDir, runId } from the client. After the identity is
// established, the run's own private evidence names the concrete URL, and
// path/query keys are linked to earlier response fields (bounded; any problem
// records no links and never fails the capture or the request).
export function captureHttpContext(root, input = {}, { env = process.env, scope, keyLinking } = {}) {
  if (env.API_CONTEXT_OFF === '1') return { state: 'disabled', reason: 'API_CONTEXT_OFF' };
  if (input.capture_context === false) return { state: 'disabled', reason: 'request-opt-out' };
  if (input.capture_context !== true && !scope?.eligible) return { state: 'disabled', reason: 'not-requested' };
  const migration = stacksMigrationCapture(root);
  if (migration) return migration;
  try {
    const identity = operationIdentity(input.identity);
    if (identity.protocol !== 'http' || !/^[A-Z][A-Z0-9_-]{0,31} \/[^\r\n]*$/.test(identity.operation))
      throw Object.assign(new Error(), { code: 'HTTP_CONTEXT_IDENTITY_INVALID' });
    if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599)
      throw Object.assign(new Error(), { code: 'HTTP_CONTEXT_STATUS_INVALID' });
    const pages = input.pages;
    if (pages != null && (typeof pages !== 'object' || Array.isArray(pages)
      || !Number.isSafeInteger(pages.fetched) || pages.fetched < 1 || pages.fetched > 100))
      throw Object.assign(new Error(), { code: 'HTTP_CONTEXT_PAGES_INVALID' });
    const complete = input.complete === true && (!pages || pages.complete === true && !pages.stopped_early);
    const outcome = !complete ? pages ? 'partial' : 'incomplete'
      : input.status >= 200 && input.status < 300 ? 'success' : 'error';
    const supplied = input.evidencePaths ?? (input.evidencePath ? [input.evidencePath] : []);
    if (!Array.isArray(supplied)) throw Object.assign(new Error(), { code: 'HTTP_CONTEXT_EVIDENCE_INVALID' });
    const evidence = [...new Map(supplied.slice(0, 8).map(path => projectEvidence(root, path)).filter(Boolean)
      .map(ref => [ref.path, ref])).values()];
    const omissions = ['Only bounded HTTP request and response structure is committed; payload values remain in private execution evidence.'];
    if (Array.isArray(input.omissions)) omissions.push(...input.omissions);
    if (evidence.length < supplied.length || !evidence.length)
      omissions.push('Some or all HTTP evidence files were outside the project, unavailable or beyond the reference bound.');
    if (pages && pages.fetched > evidence.length)
      omissions.push('Evidence references do not cover every captured page.');
    if (pages && !complete) omissions.push('Pagination did not establish complete collection traversal.');
    if (!pages) omissions.push('A completed HTTP response does not establish complete collection traversal.');
    if (input.attempts === undefined) omissions.push('An HTTP request-attempt count was not supplied.');
    const keySources = keyLinking ? linkCapturedRun({ ...keyLinking, identity, env }).links : [];
    return captureOperationContext(root, {
      identity, source: { tool: 'api_request:http' }, basis: 'observed', status: input.status,
      ...(input.note_contradictions !== undefined ? { note_contradictions: input.note_contradictions } : {}),
      outcome, complete, evidence, omissions,
      ...(input.attempts !== undefined ? { attempts: input.attempts } : {}),
      ...(input.assertions != null ? { assertions: input.assertions } : {}),
      ...(input.declaration != null ? { declaration: input.declaration } : {}),
      ...(Object.hasOwn(input, 'request') && input.request !== undefined ? { request: input.request } : {}),
      ...(Object.hasOwn(input, 'response') && input.response !== undefined ? { response: input.response } : {}),
      notes: [`HTTP response status ${input.status}.`, ...(pages
        ? [`Pagination captured ${pages.fetched} page${pages.fetched === 1 ? '' : 's'}; traversal ${complete ? 'complete' : 'incomplete'}.`] : [])],
    }, { internal: true, keySources });
  } catch (error) {
    return { state: 'failed', code: /^(?:HTTP_CONTEXT|CONTEXT)_[A-Z_]+$/.test(error?.code ?? '') ? error.code : 'HTTP_CONTEXT_CAPTURE_FAILED',
      message: 'The HTTP response was returned, but shared context could not be recorded.' };
  }
}
