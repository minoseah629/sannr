// One supplies projection for survey JSON, queries, DOT and offline views.
// This module reads no files, executes no requests and never receives proof
// payloads. A saved value-match relationship and a suite declaration can support
// the same edge without either becoming caller attribution or a behavioral grade.
import { projectKeySources, recordableName, validField, RUN_ID } from './key-sources.mjs';
import { secretIn } from './verdicts.mjs';
import { emailShaped } from './promote.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sort = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const json = value => JSON.stringify(value);
const unique = rows => [...new Map(rows.map(row => [json(row), row])).values()].sort((a, b) => sort(json(a), json(b)));
const CONTROL = /[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u;
const WORKSTATION = /(?:^|[\s"'`(=:/])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/)|\b[fF][iI][lL][eE]:[\\/]/u;
const OPERATION = /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\/[^\s?#]*)$/u;
const BOUNDS = Object.freeze({ operations: 20000, stores: 1000, records: 2000, suites: 1000, steps: 10000, annotations: 10000, relationships: 50000 });

function safeText(value, max = 512) {
  if (typeof value !== 'string' || !value || value.length > max) return false;
  let decoded = value;
  for (let round = 0; round < 8; round++) {
    if (CONTROL.test(decoded) || WORKSTATION.test(decoded) || secretIn(decoded) || emailShaped(decoded)) return false;
    // Author text is not a typed URL field. Apply the same portable boundary
    // to URLs embedded in prose before their query or fragment can become a label.
    for (const match of decoded.matchAll(/https?:\/\/[^\s"'`<>]+/giu)) {
      try {
        const url = new URL(match[0]);
        if (url.search || url.hash || url.username || url.password) return false;
      } catch { return false; }
    }
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; if (round === 7) return false; }
    catch { break; }
  }
  return true;
}
function safeFile(value) {
  if (!safeText(value)) return false;
  let decoded = value;
  for (let round = 0; round < 8; round++) {
    if (/^[~\\/]|^[A-Za-z][A-Za-z0-9+.-]*:|[\\?#]/u.test(decoded)
      || !decoded.split('/').every(part => part && part !== '.' && part !== '..')) return false;
    try { const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next; if (round === 7) return false; }
    catch { break; }
  }
  return true;
}
const safeName = value => recordableName(value) && safeText(value, 64);
const safeOperation = value => safeText(value) && OPERATION.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value)
  && Number.isFinite(Date.parse(value));
const trim = path => path.replace(/\/+$/u, '') || '/';
const providerKey = value => {
  if (!safeText(value, 2048)) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
      ? `${url.origin}${trim(url.pathname) === '/' ? '' : trim(url.pathname)}` : null;
  } catch { return null; }
};
const bindingKey = row => json([row.id, row.stack, row.environment, row.provider]);

// atPath uses dotted numeric segments, not JSONPath. Normalize only that exact
// grammar: data.0.id -> data[].id. Bracket syntax, root scalars and dynamic
// expressions stay unsupported rather than being interpreted by a new parser.
function captureField(value) {
  if (!safeText(value, 256)) return null;
  const parts = value.split('.');
  if (parts.some(part => !/^\d+$/u.test(part) && !safeName(part))) return null;
  const field = parts.reduce((out, part) => /^\d+$/u.test(part) ? `${out}[]` : `${out ? `${out}.` : ''}${part}`, '');
  return validField(field) && safeText(field, 256) ? field : null;
}
const placeholder = value => typeof value === 'string' ? /^\{([A-Za-z_$][\w.$\[\]-]*)\}$/u.exec(value)?.[1] ?? null : null;
const hasPlaceholder = value => {
  const pending = [value]; let seen = 0;
  while (pending.length && seen++ < 2000) {
    const item = pending.pop();
    if (typeof item === 'string' && /(?<!\{)\{[^{}]+\}(?!\})/u.test(item)) return true;
    if (object(item) || Array.isArray(item)) pending.push(...Object.values(item).slice(0, 2000));
  }
  return pending.length > 0;
};

/**
 * operations: [{id, stack, operation, provider?, environment?}], one row per
 * binding (a node id may occur in several environments).
 * retainedEntries: [{stack, file, entries: storedOperationEntries(ctx),
 *   evidenceAvailability?: Map|object(run_id -> state)}]. Availability concerns
 * the source artifact only; it is not a new validation of the relationship.
 * suites: [{file, stack?, environment?, suite: boundedParsedSuite}].
 * operatorBindings: existing annotations of a matching structural edge,
 *   {from,to,source_field,target_parameter,environment?,file,author?,at?}.
 * They cannot create an execution record or authorize a new binding writer.
 *
 * Relationships have no graph IDs: the serializer assigns those from the safe
 * tuple. Diagnostics deliberately contain reason/count only, never input text.
 */
export function projectSurveySupplies({ operations = [], retainedEntries = [], suites = [], operatorBindings = [] } = {}) {
  const reasons = new Map(), edges = new Map();
  const count = (reason, n = 1) => { if (n) reasons.set(reason, (reasons.get(reason) ?? 0) + n); };
  const bounded = (value, limit) => {
    if (!Array.isArray(value)) { count('input-shape-unsupported'); return []; }
    if (value.length > limit) count('input-bound-exceeded', value.length - limit);
    return value.slice(0, limit);
  };
  const index = [];
  for (const row of bounded(operations, BOUNDS.operations)) {
    if (!object(row) || !safeText(row.id) || !safeText(row.stack ?? 'default') || !safeOperation(row.operation)
      || row.environment !== undefined && !safeText(row.environment, 128)
      || row.provider !== undefined && !providerKey(row.provider)) { count('operation-metadata-withheld'); continue; }
    index.push({ id: row.id, stack: row.stack ?? '', operation: row.operation,
      ...(row.environment !== undefined ? { environment: row.environment } : {}),
      ...(row.provider !== undefined ? { provider: providerKey(row.provider) } : {}) });
  }
  const bindings = [...new Map(index.map(row => [bindingKey(row), row])).values()];
  const select = (rows, prefix) => {
    if (rows.length !== 1) { count(`${prefix}-${rows.length ? 'ambiguous' : 'unresolved'}`); return null; }
    return rows[0];
  };
  const relationship = (from, to, field, parameter) => {
    const scope = { ...(from.stack ? { source_stack: from.stack } : {}), ...(to.stack ? { target_stack: to.stack } : {}),
      ...(from.environment === to.environment ? to.environment !== undefined ? { environment: to.environment } : {}
        : { ...(from.environment !== undefined ? { source_environment: from.environment } : {}),
          ...(to.environment !== undefined ? { target_environment: to.environment } : {}) }) };
    const shape = { kind: 'supplies', from: from.id, to: to.id, source_field: field, target_parameter: parameter, scope };
    const key = json(shape);
    if (!edges.has(key)) {
      if (edges.size >= BOUNDS.relationships) { count('relationship-bound-exceeded'); return null; }
      if (from.environment === undefined || to.environment === undefined) count('relationship-environment-unavailable');
      if (!from.stack || !to.stack) count('relationship-stack-unavailable');
      edges.set(key, { ...shape, declarations: [], observations: [], operator_attributions: [] });
    }
    return edges.get(key);
  };

  let retainedRecords = 0, declaredCaptures = 0, examinedSteps = 0;
  for (const store of bounded(retainedEntries, BOUNDS.stores)) {
    if (!object(store) || !safeFile(store.file) || store.stack !== undefined && !safeText(store.stack || 'default')) {
      count('input-metadata-withheld'); continue;
    }
    for (const item of bounded(store.entries, BOUNDS.records)) {
      retainedRecords++;
      const entry = item?.entry, identity = entry?.identity, projection = projectKeySources(entry);
      if (item?.keySourcesDamaged || projection.state === 'damaged') { count('retained-links-damaged'); continue; }
      if (projection.state === 'absent') continue;
      const provider = providerKey(identity?.provider);
      const stack = identity?.stack ?? store.stack;
      if (identity?.protocol !== 'http' || !provider || !safeText(identity?.environment, 128)
        || !safeOperation(identity?.operation) || stack !== undefined && !safeText(stack || 'default')
        || identity?.stack !== undefined && store.stack !== undefined && identity.stack !== store.stack) {
        count('retained-scope-unavailable'); continue;
      }
      const inScope = bindings.filter(row => row.provider === provider && row.environment === identity.environment);
      const target = select(inScope.filter(row => row.operation === identity.operation && (stack === undefined || row.stack === stack)), 'retained-target');
      if (!target) continue;
      for (const link of projection.key_sources) {
        if (!safeOperation(link.source.operation) || !safeText(link.source.field, 256) || !safeName(link.param)
          || !RUN_ID.test(link.evidence.run_id) || !safeText(link.evidence.run_id, 132)) { count('retained-link-withheld'); continue; }
        const source = select(inScope.filter(row => row.operation === link.source.operation), 'retained-source');
        if (!source) continue;
        const edge = relationship(source, target, link.source.field, { location: link.location, name: link.param });
        if (!edge) continue;
        const availability = store.evidenceAvailability instanceof Map ? store.evidenceAvailability.get(link.evidence.run_id)
          : object(store.evidenceAvailability) && Object.hasOwn(store.evidenceAvailability, link.evidence.run_id)
            ? store.evidenceAvailability[link.evidence.run_id] : null;
        const state = ['matching', 'changed', 'unavailable'].includes(availability) ? availability
          : availability === 'missing-or-unavailable' ? 'unavailable' : 'not-checked';
        edge.observations.push({ kind: 'retained-value-match', file: store.file,
          first_observed_at: link.first_observed_at, last_observed_at: link.last_observed_at, also_seen: link.also_seen,
          evidence: { run_id: link.evidence.run_id }, proof: { state,
            meaning: 'Source artifact availability only; the retained relationship was not revalidated.' } });
      }
    }
  }

  // Resolve declarations against an exact scoped operation, without selecting a
  // convenient environment or a similarly named operation in another stack.
  const suiteTarget = (req, wrapper) => {
    if (req.protocol !== undefined && req.protocol !== 'http') { count('suite-protocol-unsupported'); return null; }
    const selectedStack = req.stack ?? req.upstream ?? wrapper.suite.stack ?? wrapper.suite.upstream ?? wrapper.stack;
    const environment = req.environment ?? wrapper.suite.environment ?? wrapper.environment;
    if (selectedStack !== undefined && !safeText(selectedStack || 'default') || environment !== undefined && !safeText(environment, 128)) {
      count('input-metadata-withheld'); return null;
    }
    if (typeof req.path !== 'string' || req.path.length > 4096 || CONTROL.test(req.path)) { count('suite-target-unsupported'); return null; }
    const method = typeof req.method === 'string' ? req.method.toUpperCase() : 'GET';
    let absolute = null, requestPath = req.path.split(/[?#]/u)[0];
    if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(req.path)) {
      try {
        absolute = new URL(req.path);
        if (!['http:', 'https:'].includes(absolute.protocol) || absolute.username || absolute.password || absolute.hash) throw new Error();
        requestPath = absolute.pathname.replaceAll('%7B', '{').replaceAll('%7D', '}');
      } catch { count('suite-target-unsupported'); return null; }
    }
    if (!requestPath.startsWith('/')) { count('suite-target-unsupported'); return null; }
    const matches = [];
    for (const row of bindings) {
      if (selectedStack !== undefined && row.stack !== selectedStack || environment !== undefined && row.environment !== environment) continue;
      const [, opMethod, opPath] = OPERATION.exec(row.operation);
      if (method !== opMethod) continue;
      let path = requestPath;
      if (absolute) {
        if (!row.provider) continue;
        const base = new URL(row.provider);
        if (base.origin !== absolute.origin) continue;
        const prefix = trim(base.pathname) === '/' ? '' : trim(base.pathname);
        if (prefix && path !== prefix && !path.startsWith(`${prefix}/`)) continue;
        if (prefix) path = path.slice(prefix.length) || '/';
      }
      const declared = trim(opPath).split('/'), actual = trim(path).split('/');
      if (declared.length !== actual.length || !declared.every((segment, n) => /^\{[^{}]+\}$/u.test(segment) || segment === actual[n])) continue;
      matches.push({ row, path, declared, actual });
    }
    return select(matches, 'suite-operation');
  };
  for (const wrapper of bounded(suites, BOUNDS.suites)) {
    if (!object(wrapper) || !safeFile(wrapper.file)) { count('input-metadata-withheld'); continue; }
    if (!object(wrapper.suite)) { count('input-shape-unsupported'); continue; }
    const captures = new Map();
    for (const phase of ['requests', 'finally']) {
      if (phase === 'finally' && wrapper.suite.finally === undefined) continue;
      for (const [step, req] of bounded(wrapper.suite[phase], BOUNDS.steps).entries()) {
        if (++examinedSteps > BOUNDS.steps) { count('step-bound-exceeded'); continue; }
        if (!object(req)) { count('suite-step-unsupported'); continue; }
        const consumes = hasPlaceholder(req.path) || hasPlaceholder(req.params);
        const hasCapture = object(req.capture) && Object.keys(req.capture).length > 0;
        if (hasPlaceholder(req.body) || hasPlaceholder(req.headers) || hasPlaceholder(req.expect)
          || hasPlaceholder(req.graphql) || hasPlaceholder(req.rpc) || hasPlaceholder(req.grpc) || hasPlaceholder(req.websocket))
          count('capture-consumer-unsupported');
        const target = consumes || hasCapture ? suiteTarget(req, wrapper) : null;
        const add = (name, location, parameter) => {
          if (!safeName(name) || !safeName(parameter)) { count('capture-metadata-withheld'); return; }
          const captured = captures.get(name);
          if (!captured) { count('capture-not-declared-before-use'); return; }
          if (!target || !captured.source) return;
          const edge = relationship(captured.source, target.row, captured.field, { location, name: parameter });
          if (edge) edge.declarations.push({ kind: 'suite-capture', file: wrapper.file, capture: name,
            source: captured.position, consumer: { phase, step: step + 1 } });
        };
        if (target) {
          for (const [n, segment] of target.actual.entries()) {
            const name = placeholder(segment);
            if (name && /^\{[^{}]+\}$/u.test(target.declared[n])) add(name, 'path', target.declared[n].slice(1, -1));
            else if (hasPlaceholder(segment)) count('capture-consumer-unsupported');
          }
          const query = new Map();
          try {
            const raw = typeof req.path === 'string' ? req.path.split('?')[1]?.split('#')[0] : undefined;
            for (const [name, value] of new URLSearchParams(raw ?? '')) query.set(name, value);
          } catch { count('suite-query-unsupported'); }
          if (object(req.params)) for (const [name, value] of Object.entries(req.params)) query.set(name, value);
          for (const [name, value] of query) {
            const captured = placeholder(value);
            if (captured) add(captured, 'query', name);
            else if (hasPlaceholder(value)) count('capture-consumer-unsupported');
          }
        }
        if (hasCapture) for (const [name, field] of Object.entries(req.capture).slice(0, 1000)) {
          declaredCaptures++;
          // Even an unresolved/unsupported later declaration shadows an earlier
          // one: choosing the old capture would invent a definite transfer.
          captures.delete(name);
          if (!safeName(name)) { count('capture-metadata-withheld'); continue; }
          const projected = captureField(field);
          if (!projected) { count('capture-field-unsupported'); continue; }
          captures.set(name, { source: target?.row ?? null, field: projected, position: { phase, step: step + 1 } });
        }
        if (hasCapture && Object.keys(req.capture).length > 1000) count('capture-bound-exceeded', Object.keys(req.capture).length - 1000);
      }
    }
  }

  for (const annotation of bounded(operatorBindings, BOUNDS.annotations)) {
    if (!object(annotation) || !safeFile(annotation.file)
      || annotation.author !== undefined && !safeText(annotation.author, 256)
      || annotation.at !== undefined && !date(annotation.at)) { count('operator-attribution-withheld'); continue; }
    const matching = [...edges.values()].filter(edge => edge.from === annotation.from && edge.to === annotation.to
      && edge.source_field === annotation.source_field && edge.target_parameter.location === annotation.target_parameter?.location
      && edge.target_parameter.name === annotation.target_parameter?.name
      && (annotation.environment === undefined || edge.scope.environment === annotation.environment));
    if (matching.length !== 1) { count(matching.length ? 'operator-binding-ambiguous' : 'operator-binding-unmatched'); continue; }
    matching[0].operator_attributions.push({ kind: 'operator-annotation', file: annotation.file,
      ...(annotation.author !== undefined ? { author: annotation.author } : {}), ...(annotation.at !== undefined ? { at: annotation.at } : {}) });
  }
  const relationships = [...edges.values()].map(edge => ({ ...edge, declarations: unique(edge.declarations),
    observations: unique(edge.observations), operator_attributions: unique(edge.operator_attributions) }))
    .sort((a, b) => sort(json(a), json(b)));
  const unresolved = [...reasons].sort(([a], [b]) => sort(a, b)).map(([reason, count]) => ({ reason, count }));
  return { relationships, unresolved, coverage: { retained_records_examined: retainedRecords, suite_steps_examined: Math.min(examinedSteps, BOUNDS.steps),
    capture_declarations: declaredCaptures, relationships: relationships.length,
    observed_relationships: relationships.filter(edge => edge.observations.length).length,
    declared_relationships: relationships.filter(edge => edge.declarations.length).length,
    unresolved: unresolved.reduce((sum, row) => sum + row.count, 0) },
    // Safe structural identity is deliberately NOT a digest of raw context or
    // suite bytes. Proof availability is a separate, local status dimension.
    inputStructures: relationships.map(edge => ({ ...edge, observations: edge.observations.map(({ proof: _local, ...observation }) => observation) })) };
}
