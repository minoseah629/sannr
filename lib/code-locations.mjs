// Local source locations are navigation hints, never response evidence. The
// invocation owns one lazy source snapshot; nothing is written or requested.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CONTEXT_BASENAME } from './brand.mjs';
import { extractRoutes, findSurfaces, upstreamCalls, upstreamUrls } from './audit.mjs';
import { operationsFrom, parseYaml, readContextState } from './context.mjs';
import { resolveConfig } from './config.mjs';
import { contractMount } from './http-operation-context.mjs';
import { emailShaped } from './promote.mjs';
import { secretIn } from './verdicts.mjs';
import { stackCatalog } from './stacks.mjs';
import { withStackScope } from './stack-scope.mjs';
import { createSourceScan, currentSourceScan, withSourceScan } from './source-scan.mjs';

const invocations = new AsyncLocalStorage();
const indexes = new WeakMap();
const locationIdentities = new WeakMap(), locationFiles = new WeakMap(), locationLists = new WeakMap();
const METHODS = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\s?#]*)$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const flagged = value => CONTROL.test(value) || Boolean(secretIn(value, { allowAuthReferences: true })) || emailShaped(value);
const safeText = value => flagged(String(value)) ? 'withheld' : String(value);
const portable = value => value.split(sep).join('/');
const inside = (root, file) => {
  const path = relative(root, file);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
};
const canonical = path => String(path).split(/[?#]/u)[0].replace(/\$\{[^}]*\}/gu, '{}')
  .split('/').map(segment => segment.startsWith(':') || /^\{[^{}]*\}$/u.test(segment) ? '{}' : segment)
  .join('/').replace(/\/+$/u, '') || '/';
const keyOf = (method, path) => `${method} ${canonical(path)}`;
const compose = (base, path) => `${base.replace(/\/+$/u, '')}/${path.replace(/^\/+/, '')}`;
const hostPort = value => {
  try { const url = new URL(value); return `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`; }
  catch { return null; }
};
const unique = (values, identity) => [...new Map(values.map(value => [identity(value), value])).values()];
const locationKey = value => `${value.file}\u0000${value.line ?? ''}\u0000${value.kind}\u0000${value.code_path ?? ''}\u0000${value.state}`;
const addLocation = (list, location) => {
  let index = locationLists.get(list);
  if (!index) { index = new Map(); locationLists.set(list, index); }
  const key = locationIdentities.get(location) ?? locationKey(location), old = index.get(key);
  if (old) old.environments = [...new Set([...old.environments, ...location.environments])].sort();
  else { list.push(location); index.set(key, location); }
};
const emptyCode = () => ({ label: 'declared by code', defined_in: [], called_from: [] });
const safeAssign = (object, key, value) => Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });

/** Shared by source locations and older fields that still expose a source path. */
export function codePathWithheld(root, file) {
  if (typeof file !== 'string' || !file) return true;
  root = resolve(root);
  const absolute = resolve(root, file), path = portable(relative(root, absolute));
  return !inside(root, absolute) || !path || flagged(path);
}

/** Preserve the callback's sync/async contract and reuse a containing scan. */
export function withCodeLocations(root, fn, options = {}) {
  root = resolve(root);
  const active = invocations.getStore();
  if (active?.root === root) return fn();
  const scan = currentSourceScan(root) ?? createSourceScan(root, options);
  return invocations.run({ root, scan, options, model: null, contexts: new Map() }, () => withSourceScan(scan, fn));
}

/** A map and its join use the same store read, including missing/damaged state. */
export function readCodeContext(root, stack, read) {
  const active = invocations.getStore(), key = stack ?? '';
  if (active?.root !== resolve(root)) return read();
  if (!active.contexts.has(key)) active.contexts.set(key, read());
  return active.contexts.get(key);
}

function readDocument(scan, file, cache) {
  if (!file) return null;
  file = resolve(file);
  if (cache.has(file)) return cache.get(file);
  const result = scan.memo(`code-contract:${file}`, () => {
    try {
      const raw = scan.read(file, { maxBytes: 16 * 1024 * 1024 });
      if (typeof raw === 'string') {
        const doc = /^\s*[\[{]/u.test(raw) ? JSON.parse(raw) : parseYaml(raw);
        // The join needs only identities, not the document's descriptions or
        // values. Keep its reusable parsed result small and source-only.
        if (doc && typeof doc === 'object') return { operations: operationsFrom(doc),
          digest: createHash('sha256').update(raw).digest('hex') };
      }
    } catch { /* A damaged contract contributes no guessed identities. */ }
    return null;
  }, { files: [file] });
  cache.set(file, result);
  return result;
}

function build(root, scan, options = {}) {
  const documents = new Map(), withheldPaths = new Set();
  const location = (directory, input, environments = [], state = 'current') => {
    const absolute = resolve(directory, input.file ?? ''), rel = portable(relative(root, absolute));
    const withheld = codePathWithheld(root, absolute);
    if (withheld) withheldPaths.add(absolute);
    const value = { file: withheld ? 'withheld' : rel,
      ...(Number.isSafeInteger(input.line) && input.line > 0 ? { line: input.line } : {}),
      kind: input.kind ?? 'definition', state,
      environments: [...new Set(environments.map(safeText))].sort(),
      ...(typeof input.code_path === 'string' ? { code_path: safeText(input.code_path.split(/[?#]/u)[0]) } : {}),
      ...(withheld ? { withheld: true } : {}),
      ...(input.source ? { source: input.source } : {}) };
    locationIdentities.set(value, `${absolute}\u0000${input.line ?? ''}\u0000${value.kind}\u0000${input.code_path ?? ''}\u0000${state}`);
    locationFiles.set(value, absolute);
    return value;
  };
  const catalog = stackCatalog(root), stackRows = [];
  for (const row of catalog.stacks) {
    const scope = { root, stack: row.name, contextFile: `${row.relativeFolder}/${CONTEXT_BASENAME}` };
    const state = readCodeContext(root, row.name, () => withStackScope(scope, () => readContextState(root)));
    stackRows.push({ name: row.name, row, context: state.state === 'healthy' ? state.snapshot.ctx : null,
      environments: Object.entries(row.document.environments).map(([name, env]) => ({ name, ...env,
        contract: env.contract ?? row.document.contract ? resolve(row.folder, env.contract ?? row.document.contract) : null })),
      contract: row.document.contract ? resolve(row.folder, row.document.contract) : null });
  }
  if (!catalog.stacks.length) {
    const state = readCodeContext(root, null, () => withStackScope(null, () => readContextState(root)));
    // Explicit survey generation supplies structural config read inside its
    // bounded repository inventory. It must not resolve credentials or follow
    // an environment file. Existing request/lookup callers retain their path.
    let config; try { config = Object.hasOwn(options, 'legacyConfig')
      ? options.legacyConfig ?? {} : withStackScope(null, () => resolveConfig(root)); } catch { config = {}; }
    const ctx = state.state === 'healthy' ? state.snapshot.ctx : null;
    if (ctx || config.contract) stackRows.push({ name: '', context: ctx,
      contract: config.contract ? resolve(root, config.contract) : ctx?.api?.contract ? resolve(root, ctx.api.contract) : null,
      environments: config.baseUrl && config.baseUrlSource !== 'fallback'
        ? [{ name: config.name ?? 'default', baseUrl: config.baseUrl, contractPathPrefix: config.contractPathPrefix,
          contract: config.contract ? resolve(root, config.contract) : ctx?.api?.contract ? resolve(root, ctx.api.contract) : null }] : [] });
  }

  const model = { label: 'declared by code', stacks: {}, unmatched: { routes: [], hosts: [], operations: [] }, summary: {} };
  const internal = new Map(), targets = new Map();
  const surfaces = findSurfaces(root, { includeFixtures: scan.includeFixtures }), serviceRows = [], byContract = new Map(), byDigest = new Map();
  for (const surface of surfaces) {
    const contract = readDocument(scan, surface.contract, documents);
    const service = { ...surface, contractData: contract, routes: extractRoutes(surface.dir) };
    serviceRows.push(service);
    if (surface.contract) (byContract.get(resolve(surface.contract)) ?? byContract.set(resolve(surface.contract), []).get(resolve(surface.contract))).push(service);
    if (contract) (byDigest.get(contract.digest) ?? byDigest.set(contract.digest, []).get(contract.digest)).push(service);
  }

  for (const row of stackRows) {
    const operations = new Map(), contracts = new Set([row.contract, ...row.environments.map(env => env.contract)].filter(Boolean));
    for (const file of contracts) for (const op of readDocument(scan, file, documents)?.operations ?? []) operations.set(op.op, op);
    for (const op of Object.keys(row.context?.operations ?? {})) {
      const match = METHODS.exec(op); if (match && !operations.has(op)) operations.set(op, { op, method: match[1], path: match[2] });
    }
    const code = { label: 'declared by code', operations: {}, called_from: [], summary: {} }, records = new Map();
    for (const op of operations.values()) {
      const value = emptyCode(); records.set(op.op, value);
      const label = safeText(op.op); let display = label;
      for (let n = 2; Object.hasOwn(code.operations, display); n++) display = `${label} ${n}`;
      safeAssign(code.operations, display, value);
    }
    safeAssign(model.stacks, safeText(row.name), code);
    internal.set(row.name, { ...row, code, records, operations, contracts });
    for (const environment of row.environments) {
      const hp = hostPort(environment.baseUrl); if (!hp) continue;
      const contract = readDocument(scan, environment.contract, documents);
      const prefix = environment.contractPathPrefix?.replace(/\/+$/u, '') ?? '';
      const routes = (contract?.operations ?? [...operations.values()]).map(op => ({ ...op, endpointPath: `${prefix}${op.path}` }));
      const mount = contractMount({ routes, ...(prefix ? { pathPrefix: prefix } : {}) }, environment.baseUrl);
      const matching = new Map();
      for (const op of routes) {
        const key = keyOf(op.method, `${mount}${op.endpointPath}`);
        (matching.get(key) ?? matching.set(key, []).get(key)).push(op.op);
      }
      (targets.get(hp) ?? targets.set(hp, []).get(hp)).push({ stack: row.name, environment: environment.name,
        basePath: new URL(environment.baseUrl).pathname.replace(/\/+$/u, ''), matching });
    }
  }

  // A copied contract binds only when its exact bytes name one discovered
  // service. Matching a convenient path in an unrelated service is forbidden.
  const boundServices = new Map();
  for (const row of internal.values()) for (const file of row.contracts) {
    const data = readDocument(scan, file, documents); if (!data) continue;
    const candidates = byContract.get(file) ?? byDigest.get(data.digest) ?? [];
    const dirs = new Set(candidates.map(service => resolve(service.dir)));
    if (dirs.size !== 1) continue;
    const environments = row.environments.filter(env => env.contract === file);
    // A default contract overridden in every environment is not the active
    // binding for any of those environments. Keep its operations, not a claim
    // that its source belongs to requests under a different contract.
    if (row.environments.length && !environments.length) continue;
    for (const service of candidates) {
      const stacks = boundServices.get(service) ?? new Map();
      const routes = stacks.get(row.name) ?? new Map();
      for (const env of environments.length ? environments : [null]) {
        const prefix = env?.contractPathPrefix?.replace(/\/+$/u, '') ?? '';
        const mounted = data.operations.map(op => ({ ...op, endpointPath: `${prefix}${op.path}` }));
        const mount = env ? contractMount({ routes: mounted, ...(prefix ? { pathPrefix: prefix } : {}) }, env.baseUrl) : '';
        for (const op of mounted) for (const key of new Set([keyOf(op.method, op.path), keyOf(op.method, `${mount}${op.endpointPath}`)])) {
          const operations = routes.get(key) ?? new Map(), names = operations.get(op.op) ?? new Set();
          if (env) names.add(env.name);
          operations.set(op.op, names); routes.set(key, operations);
        }
      }
      stacks.set(row.name, routes); boundServices.set(service, stacks);
    }
  }
  const allRoutes = new Map();
  const serviceDirectories = new Set(serviceRows.map(service => resolve(service.dir))), nearestServices = new Map();
  const nearestService = file => {
    const directory = dirname(file);
    if (nearestServices.has(directory)) return nearestServices.get(directory);
    let nearest;
    for (let at = directory; inside(root, at); at = dirname(at)) {
      if (serviceDirectories.has(at)) { nearest = at; break; }
      if (at === root) break;
    }
    nearestServices.set(directory, nearest); return nearest;
  };
  for (const service of serviceRows) for (const route of service.routes) {
    for (const raw of route.locations ?? [{ ...route, kind: 'definition', code_path: route.path }]) {
      const absolute = resolve(service.dir, raw.file);
      // A parent contract does not own routes inside a separately discovered
      // nested service, even when an operation happens to have the same name.
      const nearest = nearestService(absolute);
      if (nearest !== resolve(service.dir)) continue;
      const path = raw.code_path ?? route.path;
      const loc = location(service.dir, raw), identity = `${resolve(service.dir, raw.file)}\u0000${raw.line ?? ''}\u0000${keyOf(route.method, path)}`;
      let record = allRoutes.get(identity);
      if (!record) { record = { route: { ...route, path }, loc, matched: false }; allRoutes.set(identity, record); }
      if (raw.reason ?? route.reason) continue;
      for (const [name, permitted] of boundServices.get(service) ?? []) {
        const row = internal.get(name), candidates = permitted.get(keyOf(route.method, path));
        if (candidates?.size !== 1) continue;
        const [op, environments] = [...candidates][0];
        addLocation(row.records.get(op).defined_in, location(service.dir, raw, [...environments])); record.matched = true;
      }
    }
  }
  // The legacy service detector deliberately suppresses one-route undocumented
  // services. CODE-1 still names those declarations as unmatched locations.
  for (const route of extractRoutes(root)) for (const raw of route.locations ?? [route]) {
    const path = raw.code_path ?? route.path;
    const identity = `${resolve(root, raw.file)}\u0000${raw.line ?? ''}\u0000${keyOf(route.method, path)}`;
    if (!allRoutes.has(identity)) allRoutes.set(identity, { route: { ...route, path }, loc: location(root, raw), matched: false });
  }
  for (const { route, loc, matched } of allRoutes.values()) if (!matched)
    model.unmatched.routes.push({ method: route.method, path: safeText(route.path), ...loc,
      reason: route.reason ? 'unresolved-route' : 'no-unique-bound-operation' });

  const refs = upstreamUrls(root, null), calls = upstreamCalls(root, new Map([...targets.keys()].map(key => [key, true])));
  const addReference = (hp, raw) => {
    const candidates = (targets.get(hp) ?? []).filter(target => {
      const path = raw.path ?? '/';
      return !target.basePath || path === target.basePath || path.startsWith(`${target.basePath}/`);
    });
    const names = new Set(candidates.map(candidate => candidate.stack));
    if (names.size === 1) {
      const row = internal.get([...names][0]);
      addLocation(row.code.called_from, location(root, raw, candidates.map(candidate => candidate.environment)));
    } else model.unmatched.hosts.push({ host: safeText(hp), ...location(root, raw),
      reason: names.size > 1 ? 'ambiguous-stack' : targets.has(hp) ? 'base-path-unresolved' : 'no-stack' });
  };
  for (const reference of refs) for (const raw of reference.locations ?? [reference]) addReference(reference.hostPort, raw);
  for (const [hp, found] of calls) for (const call of found) for (const raw of call.locations ?? [call]) {
    const path = raw.code_path !== undefined ? compose(raw.base_path ?? '', raw.code_path) : raw.request_path ?? call.path;
    // Building a URL names a dependency; it does not establish a request to
    // an operation. Preserve that location at the stack/reference level only.
    if (raw.kind !== 'request') { addReference(hp, { ...raw, path, kind: 'binding' }); continue; }
    const candidates = (targets.get(hp) ?? []).flatMap(target => (target.matching.get(keyOf(call.method, path)) ?? [])
      .map(op => ({ ...target, op })));
    const identities = new Set(candidates.map(candidate => `${candidate.stack}\u0000${candidate.op}`));
    if (identities.size !== 1) continue;
    const selected = candidates[0], row = internal.get(selected.stack);
    addLocation(row.records.get(selected.op).called_from, location(root, { ...raw, kind: 'request' }, candidates.map(candidate => candidate.environment)));
  }

  for (const row of internal.values()) {
    let unmatchedOperations = 0;
    for (const [op, code] of row.records) {
      const source = row.context?.operations?.[op]?.source_file;
      if (typeof source === 'string' && source && ![...code.defined_in, ...code.called_from].some(loc => locationFiles.get(loc) === resolve(root, source))) {
        const file = resolve(root, source); let present = false;
        if (inside(root, file)) try { const stat = lstatSync(file); present = stat.isFile() && !stat.isSymbolicLink() && inside(realpathSync(root), realpathSync(file)); } catch { /* remembered file missing */ }
        const kind = /\.(?:json|ya?ml|toml|env)$/iu.test(source) ? 'config' : 'definition';
        addLocation(code.defined_in, location(root, { file: source, kind, source: 'stored-source-file' }, [], present ? 'remembered' : 'not-found'));
      }
      if (![...code.defined_in, ...code.called_from].some(loc => loc.state === 'current')) {
        model.unmatched.operations.push({ stack: safeText(row.name), operation: safeText(op), reason: 'no-current-code-location' });
        unmatchedOperations++;
      }
    }
    const locations = [...row.code.called_from, ...[...row.records.values()].flatMap(code => [...code.defined_in, ...code.called_from])];
    for (const code of row.records.values()) for (const key of ['defined_in', 'called_from']) code[key].sort((a, b) => locationKey(a).localeCompare(locationKey(b)));
    row.code.called_from.sort((a, b) => locationKey(a).localeCompare(locationKey(b)));
    row.code.summary = { operations: row.records.size,
      defined_locations: [...row.records.values()].reduce((n, code) => n + code.defined_in.length, 0),
      call_sites: row.code.called_from.length,
      operation_call_sites: [...row.records.values()].reduce((n, code) => n + code.called_from.length, 0),
      unmatched_operations: unmatchedOperations,
      withheld_paths: unique(locations.filter(loc => loc.withheld), loc => locationFiles.get(loc)).length };
  }
  model.summary = { stacks: stackRows.length, operations: [...internal.values()].reduce((n, row) => n + row.records.size, 0),
    defined_locations: [...internal.values()].reduce((n, row) => n + row.code.summary.defined_locations, 0),
    call_sites: unique([...internal.values()].flatMap(row => row.code.called_from), loc => locationIdentities.get(loc) ?? locationKey(loc)).length,
    operation_call_sites: [...internal.values()].reduce((n, row) => n + row.code.summary.operation_call_sites, 0),
    unmatched_routes: model.unmatched.routes.length, unmatched_hosts: model.unmatched.hosts.length,
    unmatched_operations: model.unmatched.operations.length, withheld_paths: withheldPaths.size };
  indexes.set(model, internal);
  return model;
}

/** Read only repository files; no remote discovery and no persisted cache. */
export function codeLocations(root) {
  root = resolve(root);
  const active = invocations.getStore();
  if (active?.root !== root) return withCodeLocations(root, () => codeLocations(root));
  return active.model ??= build(root, active.scan, active.options);
}

/** The exact operation only: a sibling's host match never supplies locations. */
export function forOperationCode(root, stack, operation) {
  const model = codeLocations(root);
  return indexes.get(model)?.get(stack ?? '')?.records.get(operation) ?? emptyCode();
}
