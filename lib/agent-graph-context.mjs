import { LAYOUT, ensureLayout } from './layout.mjs';
// Agent-facing reads of explicitly selected local graph snapshots. Repository
// prose is data: the bootstrap is a small index, and notes require a query.
import { constants, closeSync, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { normalizeGraphManifest, loadGraphCatalog, buildGraphCatalog, graphNeighborhood, graphImpact, isForeignNodeClaim } from './dependency-graph.mjs';
import { exportGraphSnapshot } from './graph-export.mjs';
import { resolveOutputPath, safeOutputPath } from './output-path.mjs';
import { conciseKnowledge, knowledgeDetailRef, CONCISE_MEANING, CONCISE_LIMITS } from './graph-briefing.mjs';

const MANIFEST = LAYOUT.graphManifest;
const DEFAULT_BYTES = 12000, MIN_BYTES = 2000, MAX_BYTES = 64000;
const ACTIONS = ['overview', 'context', 'impact', 'inspect'];
const CHANNELS = ['cli', 'mcp', 'map'];
const MAX_USAGE_BYTES = 1024 * 1024;
const own = (value, key) => Object.hasOwn(value, key);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = code => { throw Object.assign(new Error('Graph context is unavailable.'), { code }); };
const size = value => Buffer.byteLength(JSON.stringify(value));
const KNOWLEDGE_ORDERING = 'verification-first-fair-diverse-v2';

// Rank saved verification before authorship, without claiming current truth.
// Publisher lanes prevent imported timestamps/repetition from starving locally
// captured evidence. Distinct scoped claims/shapes precede repeated records.
function orderKnowledge(records, now = Date.now()) {
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const timestamp = item => {
    for (const key of ['observed_at', 'recorded_at']) {
      const value = Date.parse(item[key]);
      if (Number.isFinite(value) && value <= now) return value;
    }
    return -Infinity;
  };
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const signature = item => JSON.stringify(canonical([
    item.node, item.operation, item.protocol, item.environment, item.contractDigest,
    item.basis, item.verification, item.request_shape, item.response_shape, item.notes,
  ]));
  // Verification lanes precede authorship. Within a lane no publisher can
  // take a second turn before its peers.
  const lanes = Array.from({ length: 6 }, () => new Map());
  for (const record of records) {
    const local = record.publisher_trust === 'local';
    const verified = record.basis === 'observed' && record.verification === 'client-observation';
    const lane = verified ? (local ? 0 : 1)
      : record.basis === 'authored' ? (local ? 2 : 3) : (local ? 4 : 5);
    const publishers = lanes[lane];
    if (!publishers.has(record.publisher)) publishers.set(record.publisher, []);
    publishers.get(record.publisher).push(record);
  }
  const queues = lanes.map(publishers => [...publishers.entries()].sort(([a], [b]) => compare(a, b)).map(([, items]) => {
    items.sort((a, b) => {
      const left = timestamp(a), right = timestamp(b);
      return left === right ? compare(a.id, b.id) : left > right ? -1 : 1;
    });
    const distinct = [], repeats = [], seen = new Set();
    for (const item of items) {
      const key = signature(item);
      if (seen.has(key)) repeats.push(item); else { seen.add(key); distinct.push(item); }
    }
    return { items: distinct.concat(repeats), offset: 0 };
  }));
  const ordered = [];
  // Exhaust each verification lane before entering the next: no authored or
  // external claim may outrank even the last retained local observation.
  for (const publishers of queues) {
    let cursor = 0, remaining = true;
    while (remaining) {
      remaining = false;
      for (let tries = 0; tries < publishers.length; tries++) {
        const queue = publishers[cursor++ % publishers.length];
        if (queue.offset < queue.items.length) { ordered.push(queue.items[queue.offset++]); remaining = true; break; }
      }
    }
  }
  return ordered;
}

export function graphConfigured(root) {
  try { lstatSync(join(root, MANIFEST)); return true; }
  catch (error) { return error.code !== 'ENOENT'; }
}

function readBounded(path, maxBytes, { tail = false } = {}) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('GRAPH_CONTEXT_READ_FAILED');
    if (!tail && stat.size > maxBytes) fail('GRAPH_CONTEXT_INPUT_BOUNDS');
    const start = tail ? Math.max(0, stat.size - maxBytes) : 0;
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + (tail ? 0 : 1));
    let offset = 0;
    while (offset < buffer.length) {
      const n = readSync(fd, buffer, offset, buffer.length - offset, start + offset);
      if (!n) break;
      offset += n;
    }
    if (!tail && offset !== stat.size) fail('GRAPH_CONTEXT_INPUT_CHANGED');
    return { text: buffer.subarray(0, offset).toString('utf8'), omittedBytes: start };
  } finally { if (fd !== undefined) closeSync(fd); }
}

function readManifest(root) {
  const path = resolveOutputPath(root, join(root, MANIFEST), { fileOnly: true });
  let input;
  try { input = JSON.parse(readBounded(path, 4 * 1024 * 1024).text); }
  catch (error) {
    if (/^GRAPH_[A-Z_]+$/u.test(error.code ?? '')) throw error;
    fail('GRAPH_MANIFEST_UNREADABLE');
  }
  return normalizeGraphManifest(input);
}

function queryArgs(args) {
  if (!object(args) || Object.keys(args).some(key => !['action', 'node', 'operation', 'environment', 'max_bytes', 'response_format', 'ref', 'include_foreign_claims'].includes(key)))
    fail('GRAPH_QUERY_INVALID');
  if (own(args, 'include_foreign_claims') && typeof args.include_foreign_claims !== 'boolean') fail('GRAPH_QUERY_INVALID');
  const action = args.action ?? 'overview', maxBytes = args.max_bytes ?? DEFAULT_BYTES;
  if (!ACTIONS.includes(action) || !Number.isInteger(maxBytes) || maxBytes < MIN_BYTES || maxBytes > MAX_BYTES)
    fail('GRAPH_QUERY_INVALID');
  const responseFormat = args.response_format ?? (action === 'context' ? 'concise' : 'detailed');
  if (!['concise', 'detailed'].includes(responseFormat) || (action !== 'context' && responseFormat !== 'detailed')) fail('GRAPH_QUERY_INVALID');
  if (action === 'inspect') {
    if (typeof args.ref !== 'string' || !/^knowledge:[a-f0-9]{64}$/u.test(args.ref)
      || ['node', 'operation', 'environment'].some(key => own(args, key))) fail('GRAPH_QUERY_INVALID');
  } else if (own(args, 'ref')) fail('GRAPH_QUERY_INVALID');
  for (const [key, max] of [['node', 300], ['operation', 512], ['environment', 128]]) if (own(args, key)
    && (typeof args[key] !== 'string' || !args[key].trim() || args[key].length > max || /[\x00-\x1f\x7f-\x9f]/u.test(args[key])))
    fail('GRAPH_QUERY_INVALID');
  return { action, maxBytes, responseFormat };
}

const ISSUE_MESSAGES = {
  GRAPH_NOT_CONFIGURED: 'This repository has no graph manifest.',
  GRAPH_CONTEXT_DISABLED: 'Graph context is disabled by API_CONTEXT_OFF.',
  GRAPH_QUERY_INVALID: 'Use overview, context or impact with exact optional node, operation and environment filters. Context accepts response_format concise or detailed. Inspect requires only an exact detail_ref as ref and optional byte budget (2000–64000).',
  GRAPH_RECORD_NOT_FOUND: 'This detail reference is absent from the selected snapshots. Retrieve context again; the record may have changed or its publisher may no longer be selected.',
  GRAPH_FOREIGN_CLAIMS_OPT_IN_REQUIRED: 'This record claims behavior of a foreign node. Set include_foreign_claims to true to retrieve it in the labeled foreign-claims section.',
  GRAPH_RECORD_REF_AMBIGUOUS: 'More than one selected record matches this detail reference. Inspect the selected snapshots before relying on the record.',
  GRAPH_NODE_NOT_FOUND: 'The requested node is absent from the selected snapshots and their unresolved targets.',
  GRAPH_OWNERSHIP_CONFLICT: 'The selected snapshots contain conflicting ownership. Resolve the duplicate before querying.',
  GRAPH_MANIFEST_UNREADABLE: 'The configured graph manifest could not be read as bounded JSON.',
};
// The public boundary accepts named diagnoses only, never arbitrary error.code.
const PUBLIC_ISSUE_CODES = new Set([...Object.keys(ISSUE_MESSAGES),
  'GRAPH_CONTEXT_UNAVAILABLE', 'GRAPH_CONTEXT_READ_FAILED', 'GRAPH_CONTEXT_INPUT_BOUNDS',
  'GRAPH_CONTEXT_INPUT_CHANGED', 'GRAPH_CONTEXT_OUTPUT_BOUNDS', 'GRAPH_CATALOG_INVALID',
  'GRAPH_CATALOG_BOUNDS', 'GRAPH_CATALOG_CHANGED', 'GRAPH_CATALOG_UNREADABLE', 'GRAPH_SYMLINK_REFUSED',
  'GRAPH_INPUT_INVALID', 'GRAPH_INPUT_BOUNDS', 'GRAPH_PATH_REFUSED', 'GRAPH_SECRET_REFUSED',
  'GRAPH_VERSION_UNSUPPORTED', 'GRAPH_OWNERSHIP_INVALID', 'GRAPH_NODE_MISSING', 'GRAPH_EDGE_CONFLICT',
  'GRAPH_BINDING_CONFLICT', 'GRAPH_KNOWLEDGE_CONFLICT', 'GRAPH_CONTEXT_INVALID',
  'GRAPH_CONTEXT_SECRET_REFUSED', 'GRAPH_CONTEXT_PATH_REFUSED', 'GRAPH_CONTEXT_CHANGED',
  'GRAPH_CONTEXT_BINDING_AMBIGUOUS', 'GRAPH_MANIFEST_TOO_LARGE', 'GRAPH_REPOSITORY_ID_INVALID',
  'GRAPH_TEXT_CONTROL_REFUSED', 'GRAPH_PUBLISHER_CONFLICT',
]);
function unavailable(code = 'GRAPH_CONTEXT_UNAVAILABLE') {
  if (!PUBLIC_ISSUE_CODES.has(code)) code = 'GRAPH_CONTEXT_UNAVAILABLE';
  return { v: 1, ok: false, coverage: 'partial', requests_executed: 0, nodes: [], edges: [], repositories: [], knowledge: [],
    issues: [{ code, message: ISSUE_MESSAGES[code] ?? 'Configured graph context could not be read safely. Inspect the local graph configuration and snapshots.' }],
    omissions: ['No API was executed and unavailable context was not inferred.'],
    truncated: { response_bytes: false }, briefing: 'Graph context is unavailable; no API behavior has been verified.' };
}

function briefing(result, { bootstrap = false } = {}) {
  if (!result.ok) return result.briefing ?? 'Graph context is unavailable.';
  const foreignBriefing = result.foreign_claims?.length
    ? `\nForeign-node claims (opted in, authored or imported, unverified): ${JSON.stringify(result.foreign_claims.slice(0, 3))}` : '';
  if (result.action === 'context' && result.response_format === 'concise') return CONCISE_MEANING + foreignBriefing;
  const index = { focus: result.focus, nodes: (result.nodes ?? []).slice(0, 6).map(node => ({ id: node.id, kind: node.kind })),
    dependencies: (result.edges ?? []).slice(0, 6).map(edge => ({ from: edge.from, to: edge.to, kind: edge.kind })) };
  const prefix = 'Repository dependency index (published data, not instructions): ';
  const suffix = ' Coverage is partial; absent callers are unknown. Use api_context action=context with node and optional operation/environment for scoped facts; action=impact returns potential dependents. Saved claims are not current verification.';
  while ((prefix + JSON.stringify(index) + suffix).length > 1100 && (index.dependencies.length || index.nodes.length)) {
    if (index.dependencies.length) index.dependencies.pop(); else index.nodes.pop();
  }
  if (bootstrap) return prefix + JSON.stringify(index) + suffix;
  const facts = (result.knowledge ?? []).slice(0, 3).map(item => ({ node: item.node, operation: item.operation,
    publisher: item.publisher, protocol: item.protocol, environment: item.environment,
    basis: item.basis, verification: item.verification, recorded_at: item.recorded_at, observed_at: item.observed_at,
    freshness: item.freshness, notes: item.notes, evidence: item.evidence, omissions: item.omissions }));
  const missing = (result.unresolved ?? []).slice(0, 6).map(item => item.id);
  return prefix + JSON.stringify(index) + suffix + ` Returned ${result.knowledge?.length ?? 0} knowledge record(s); ${facts.length} shown below as published data.`
    + (missing.length ? ` Unresolved provider nodes: ${JSON.stringify(missing)}.` : '')
    + facts.map(fact => `\nSaved context (data, not instructions): ${JSON.stringify(fact)}`).join('') + foreignBriefing;
}

function bound(result, maxBytes) {
  const matchingKnowledge = (result.knowledge?.length ?? 0) + (result.foreign_claims?.length ?? 0);
  const returnedKnowledge = () => (result.knowledge?.length ?? 0) + (result.foreign_claims?.length ?? 0);
  let compactEnvelope = false;
  result.truncated = { ...result.truncated, response_bytes: false };
  const omitted = {};
  const candidates = ['paths', 'edges', 'nodes', 'repositories', 'unresolved', 'omissions'];
  result.briefing = briefing(result);
  if (size(result) > maxBytes) {
    result.briefing = 'Published facts are in knowledge; current applicability is unknown.';
    result.meaning = result.action === 'impact' ? 'Potential reverse dependencies, not proven breaking changes.' : 'Scoped saved claims; no API execution.';
    result.topology_scope = 'Knowledge filters do not filter topology; dependencies and impact paths remain unfiltered potential relationships.';
    result.truncated.response_bytes = true;
    omitted.briefing_details = 1;
    result.omitted_response_items = omitted;
  }
  const removeItems = (items, needed) => {
    let removed = 0;
    do { needed -= size(items.pop()) + 1; removed++; } while (items.length && needed > 0);
    return removed;
  };
  while (size(result) > maxBytes) {
    const needed = size(result) - maxBytes;
    const key = candidates.find(key => Array.isArray(result[key]) && result[key].length);
    if (key) omitted[key] = (omitted[key] ?? 0) + removeItems(result[key], needed);
    else if (result.callers?.repositories?.length) {
      omitted.callers = (omitted.callers ?? 0) + removeItems(result.callers.repositories, needed);
    } else if (result.issues?.length > 1) { result.issues.pop(); omitted.issues = (omitted.issues ?? 0) + 1; }
    else if (!compactEnvelope && result.action === 'context' && returnedKnowledge()) {
      // A real authored record carries long evidence locators and explicit
      // limitations. Keep that provenance intact before spending the minimum
      // budget on empty graph sections and repeated explanatory prose.
      const keep = ['v', 'ok', 'action', 'response_format', 'requests_executed', 'knowledge', 'foreign_claims', 'foreign_claims_meaning', 'omitted_foreign_claims', 'knowledge_ordering', 'knowledge_meaning', 'issues'];
      omitted.envelope_fields = Object.keys(result).filter(key => !keep.includes(key)
        && !['truncated', 'omitted_response_items', 'briefing', 'topology_scope'].includes(key)).length;
      const metadataKeys = ['briefing_details', 'paths', 'edges', 'nodes', 'repositories', 'unresolved', 'omissions', 'callers'];
      omitted.envelope_items = metadataKeys.reduce((count, key) => count + (omitted[key] ?? 0), 0);
      for (const key of metadataKeys) delete omitted[key];
      result = { ...Object.fromEntries(keep.filter(key => own(result, key)).map(key => [key, result[key]])),
        ...(result.foreign_claims ? { foreign_claims_meaning: 'Foreign-node claims (external-claim, unverified).' } : {}),
        topology_scope: 'The unfiltered topology is omitted.',
        truncated: Object.fromEntries(Object.entries(result.truncated).filter(([, value]) => value)),
        omitted_response_items: omitted,
        briefing: 'Saved facts returned; other context omitted by the byte limit.' };
      compactEnvelope = true;
    }
    else if (returnedKnowledge()) {
      // Foreign claims have their own opted-in section and cannot consume the
      // byte budget reserved for local or publisher-owned saved knowledge.
      const key = result.foreign_claims?.length ? 'foreign_claims' : 'knowledge';
      const available = maxBytes - size({ ...result, [key]: [] });
      const oversized = result.action === 'context' ? result[key].findIndex(item => size(item) + 1 > available) : -1;
      if (oversized >= 0) { result[key].splice(oversized, 1); omitted[key] = (omitted[key] ?? 0) + 1; }
      else omitted[key] = (omitted[key] ?? 0) + removeItems(result[key], needed);
    }
    else {
      result.briefing = 'The response byte budget omitted context; narrow the node or operation query.';
      if (size(result) <= maxBytes) break;
      return { ...unavailable('GRAPH_CONTEXT_OUTPUT_BOUNDS'), truncated: { response_bytes: true },
        omitted_response_items: omitted };
    }
    result.truncated.response_bytes = true;
    result.omitted_response_items = omitted;
  }
  if (result.truncated.response_bytes) {
    result.briefing = matchingKnowledge > 0 && returnedKnowledge() === 0
      ? 'All matching facts were omitted by the response byte limit. Increase max_bytes or narrow the operation/environment query.'
      : `${returnedKnowledge()} saved fact(s) returned; other context omitted by the response byte limit.`;
    // The final warning is part of the same budget, including when it replaces
    // a shorter provisional explanation at an exact boundary.
    if (size(result) > maxBytes) result.briefing = returnedKnowledge() === 0 && matchingKnowledge > 0
      ? 'All matching facts omitted by byte limit.' : 'Other context omitted by byte limit.';
  }
  return result;
}

function logDelivery(root, action, channel, result) {
  let fd, lockFd, lockPath;
  try {
    const event = { at: new Date().toISOString(), action, channel: CHANNELS.includes(channel) ? channel : 'cli',
      repository_count: result.repositories?.length ?? new Set((result.knowledge ?? []).map(item => item.publisher)).size,
      knowledge_delivered: result.knowledge?.length ?? 0,
      truncated: Object.values(result.truncated ?? {}).some(Boolean), issues: result.issues?.length ?? 0 };
    ensureLayout(root);
    const path = safeOutputPath(join(root, LAYOUT.evidence, 'graph', 'usage.jsonl'));
    mkdirSync(join(root, LAYOUT.evidence, 'graph'), { recursive: true });
    // Metrics are optional: skip a contended writer rather than delaying the
    // read. Serializing the size check and append keeps concurrent hosts capped.
    lockPath = `${path}.lock`;
    lockFd = openSync(lockPath, 'wx', 0o600);
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND
      | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) return;
    fchmodSync(fd, 0o600);
    const row = JSON.stringify(event) + '\n';
    if (stat.size + Buffer.byteLength(row) > MAX_USAGE_BYTES) {
      // Keep complete recent rows, reading at most half the cap even if an
      // older version left a huge log. Counts describe retained events only.
      const tail = Buffer.alloc(Math.min(stat.size, MAX_USAGE_BYTES / 2));
      const start = stat.size - tail.length;
      let count = 0;
      while (count < tail.length) {
        const n = readSync(fd, tail, count, tail.length - count, start + count);
        if (!n) break;
        count += n;
      }
      const bytes = tail.subarray(0, count);
      const retained = start ? bytes.subarray(bytes.indexOf(10) + 1) : bytes;
      ftruncateSync(fd, 0);
      // A partial preexisting final row must not swallow the new JSON event.
      const end = retained.lastIndexOf(10);
      if (end >= 0) writeFileSync(fd, retained.subarray(0, end + 1));
    }
    writeFileSync(fd, row);
  } catch { /* Optional local metrics must never break a context read. */ }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    if (lockFd !== undefined) {
      try { closeSync(lockFd); } catch { /* still remove our lock */ }
      try { unlinkSync(lockPath); } catch { /* best effort */ }
    }
  }
}

export async function graphContext(root, args = {}, options = {}) {
  let manifest, action = 'overview', maxBytes = DEFAULT_BYTES, responseFormat = 'detailed';
  try {
    ({ action, maxBytes, responseFormat } = queryArgs(args));
    if (process.env.API_CONTEXT_OFF === '1') return unavailable('GRAPH_CONTEXT_DISABLED');
    if (!graphConfigured(root)) return unavailable('GRAPH_NOT_CONFIGURED');
    const base = resolve(root);
    manifest = readManifest(base);
    const selected = options.catalogPath ?? manifest.catalog;
    let loaded;
    if (selected !== undefined) {
      if (typeof selected !== 'string' || !selected.trim() || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(selected))
        fail('GRAPH_CATALOG_INVALID');
      loaded = await loadGraphCatalog(resolve(base, selected));
    }
    // A selected file that claims this repository's identity is still imported
    // data. It must not replace the actual local declaration or observations.
    const local = exportGraphSnapshot(base, { manifestPath: MANIFEST });
    const selectedLocal = loaded?.snapshots.find(snapshot => snapshot.repository.id === manifest.repository.id);
    let catalog = buildGraphCatalog([...(loaded?.snapshots ?? []).filter(snapshot => snapshot.repository.id !== manifest.repository.id), local]);
    if (loaded) {
      catalog.issues.push(...loaded.issues);
      catalog.omissions = [...new Map([...loaded.omissions, ...catalog.omissions].map(item => [JSON.stringify(item), item])).values()];
    }
    const pins = new Map((manifest.publishers ?? []).map(publisher => [publisher.id, publisher.fingerprint]));
    const trust = new Map();
    for (const repository of catalog.repositories) {
      let state = 'local';
      if (repository.id !== manifest.repository.id) {
        state = !pins.has(repository.id) ? 'unlisted'
          : repository.fingerprint === pins.get(repository.id) ? 'manifest-fingerprint-match' : 'fingerprint-mismatch';
        if (state !== 'manifest-fingerprint-match') catalog.issues.push({
          code: state === 'unlisted' ? 'GRAPH_PUBLISHER_UNLISTED' : 'GRAPH_PUBLISHER_FINGERPRINT_MISMATCH', publisher: repository.id,
          message: state === 'unlisted' ? `Publisher ${repository.id} is not pinned in the consumer manifest; its saved knowledge is external claims only.`
            : `Publisher ${repository.id} does not match its consumer manifest fingerprint; its saved knowledge is external claims only.`,
        });
      }
      trust.set(repository.id, state);
    }
    const deliveredRecord = (record, publication, state) => {
      const foreign = isForeignNodeClaim({ ...record, publisher_trust: state });
      const untrusted = !['local', 'manifest-fingerprint-match'].includes(state);
      return { ...record, publisher_trust: state, publication,
        ...(foreign || untrusted ? { basis: record.basis === 'observed' ? 'unknown' : record.basis,
          verification: 'external-claim', source: { ...record.source, verification: 'external-claim' } } : {}) };
    };
    catalog.knowledge = catalog.knowledge.map(record => deliveredRecord(record,
      catalog.repositories.find(repository => repository.id === record.publisher), trust.get(record.publisher)));
    if (selectedLocal) {
      const { repository, generated_at, head } = selectedLocal;
      catalog.knowledge.push(...selectedLocal.knowledge.map(record => deliveredRecord(record, { ...repository, generated_at, head }, 'local-identity-claim')));
      catalog.issues.push({ code: 'GRAPH_LOCAL_PUBLISHER_CLAIM', publisher: repository.id,
        message: `A selected snapshot claims local publisher ${repository.id}; its claims are external and cannot replace fresh local knowledge.` });
    }
    if (action === 'inspect') {
      // Lookup precedes traversal and its 200-record limit. A reference selects
      // an existing validated record, never a filename, URL or mutation target.
      const matches = catalog.knowledge.filter(item => knowledgeDetailRef(item) === args.ref);
      if (matches.length !== 1) fail(matches.length ? 'GRAPH_RECORD_REF_AMBIGUOUS' : 'GRAPH_RECORD_NOT_FOUND');
      const record = matches[0], foreign = isForeignNodeClaim(record);
      if (foreign && !args.include_foreign_claims) fail('GRAPH_FOREIGN_CLAIMS_OPT_IN_REQUIRED');
      const response = { v: 1, ok: true, action, response_format: 'detailed', requests_executed: 0, coverage: 'partial',
        detail_ref: args.ref, knowledge: foreign ? [] : [record],
        ...(foreign ? { foreign_claims: [record], foreign_claims_meaning: 'Opted-in foreign-node claims (authored or imported, unverified); dependency declarations confer no ownership.' } : {}),
        issues: catalog.issues.filter(issue => issue.publisher === record.publisher), catalog_issue_count: catalog.issues.length,
        meaning: 'Selected saved record, not current verification. The reference binds record content and source locator; publication metadata, container digest and calculated freshness may change on re-export. Evidence contents were not read.',
        truncated: { response_bytes: false } };
      if (size(response) > maxBytes) {
        const requiredBytes = size(response);
        response.knowledge = [];
        if (foreign) response.foreign_claims = [];
        response.truncated.response_bytes = true;
        response.omitted_response_items = { [foreign ? 'foreign_claims' : 'knowledge']: 1 };
        response.required_bytes = requiredBytes;
        response.meaning = 'The complete record exceeds max_bytes and was omitted intact. Increase the budget, up to 64000 bytes; no evidence contents were read.';
      }
      if (manifest.metrics === true) logDelivery(base, action, options.channel ?? 'cli', response);
      return response;
    }
    const node = args.node ?? `${manifest.repository.id}#repo`;
    // Exact filters precede traversal's record budget, so a matching late
    // record is not hidden behind unrelated records that filled the cap.
    catalog = { ...catalog, knowledge: catalog.knowledge.filter(item => (args.operation === undefined || item.operation === args.operation)
      && (args.environment === undefined || item.environment === args.environment)) };
    catalog.knowledge = orderKnowledge(catalog.knowledge);
    const result = action === 'impact' ? graphImpact(catalog, { node, maxNodes: 100, includeForeignClaims: args.include_foreign_claims === true })
      : graphNeighborhood(catalog, { node, maxNodes: 50, includeForeignClaims: args.include_foreign_claims === true });
    result.ok = true;
    result.action = action;
    result.requests_executed = 0;
    if (action === 'context') {
      result.response_format = responseFormat;
      result.knowledge_ordering = KNOWLEDGE_ORDERING;
    }
    result.topology_scope = 'Operation and environment filters select knowledge only. Nodes, dependencies, callers and impact paths remain unfiltered potential relationships across declared scopes.';
    if (action === 'context' && responseFormat === 'concise') {
      result.knowledge = result.knowledge.map(record => conciseKnowledge(record, { freshLocal: record.publisher_trust === 'local' }));
      if (result.foreign_claims) result.foreign_claims = result.foreign_claims.map(record => conciseKnowledge(record));
      result.knowledge_meaning = CONCISE_LIMITS;
    }
    if (action === 'overview') {
      result.available_knowledge = result.knowledge.length;
      result.knowledge = [];
      if (result.foreign_claims) { result.available_foreign_claims = result.foreign_claims.length; result.foreign_claims = []; }
      result.omissions.push('Overview returns an index only; use action=context for saved knowledge.');
    }
    const response = bound(result, maxBytes);
    if (manifest.metrics === true) logDelivery(base, action, options.channel ?? 'cli', response);
    return response;
  } catch (error) {
    const result = unavailable(error.code);
    if (manifest?.metrics === true) logDelivery(resolve(root), action, options.channel ?? 'cli', result);
    return result;
  }
}

export async function graphTool(root) {
  if (process.env.API_CONTEXT_OFF === '1' || !graphConfigured(root)) return null;
  const index = await graphContext(root, { action: 'overview', max_bytes: 4000 }, { channel: 'mcp' });
  return { name: 'api_context', title: 'Repository API context',
    description: 'Read this repository’s selected local dependency snapshots before API work. No API requests, source scan, URL fetching, or context mutation. Context defaults to a concise briefing: attributed lessons, dated response types, exact scope, freshness and missing evidence. Use action=inspect with a returned detail_ref as ref for the complete selected record, or response_format=detailed for full context records. When record_with is present, pass those IDs with a note to api_context_record; detail_ref is read-only. Selection ranks saved verification before authorship, with local observations first and fair turns across publishers; recent distinct scopes, shapes and claims precede repeats. Imported publishers require a matching declared manifest fingerprint; that metadata match is not cryptographic proof or current verification. Your own records about declared providers are local knowledge and appear by default. Catalog claims whose publisher is neither the consumer nor the node owner require include_foreign_claims=true and appear only in the labeled foreign_claims section. Future timestamps get no recency priority. Ordering does not resolve disagreements or verify truth. If this project opted into metrics, calls append local delivery counts only.\n\n' + briefing(index, { bootstrap: true }),
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      action: { type: 'string', enum: ACTIONS, default: 'overview', description: 'overview: small dependency index; context: scoped saved facts; impact: potential reverse dependents; inspect: complete saved record selected by ref, without node/operation/environment filters.' },
      node: { type: 'string', maxLength: 300, description: 'Exact repository#node identity from the index; defaults to this repository.' },
      operation: { type: 'string', maxLength: 512, description: 'Exact knowledge operation; does not filter dependency or impact topology.' },
      environment: { type: 'string', maxLength: 128, description: 'Exact knowledge environment; unknown scopes do not match. Dependency and impact topology remains unfiltered.' },
      include_foreign_claims: { type: 'boolean', default: false, description: 'Opt into the separate foreign_claims section for catalog claims about nodes their publisher does not own. Your own local provider lessons appear in knowledge without opt-in. Also required to inspect a foreign claim; dependencies do not grant node ownership.' },
      response_format: { type: 'string', enum: ['concise', 'detailed'], description: 'Context defaults to concise. Detailed retains full source, publication, shapes and evidence references. Overview, impact and inspect always use detailed.' },
      ref: { type: 'string', pattern: '^knowledge:[a-f0-9]{64}$', description: 'For action=inspect only: the exact detail_ref returned by concise context. Selects saved record details, not an observation handle for api_context_record.' },
      max_bytes: { type: 'integer', minimum: MIN_BYTES, maximum: MAX_BYTES, default: DEFAULT_BYTES },
    } }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
}

export function readGraphUsage(root) {
  const report = { v: 1, recorded_events: 0, knowledge_delivered: 0, truncated_events: 0, issue_events: 0,
    by_action: {}, by_channel: {}, invalid_rows: 0, omitted_bytes: 0,
    meaning: 'Optional retained local delivery counts (a 1 MiB rolling log); they do not prove agent use, correctness, time saved, or token savings.' };
  try {
    const path = resolveOutputPath(root, join(root, LAYOUT.evidence, 'graph', 'usage.jsonl'), { fileOnly: true });
    const loaded = readBounded(path, MAX_USAGE_BYTES, { tail: true });
    report.omitted_bytes = loaded.omittedBytes;
    const lines = loaded.text.split('\n');
    if (loaded.omittedBytes) lines.shift();
    for (const line of lines.filter(Boolean)) {
      let event; try { event = JSON.parse(line); } catch { report.invalid_rows++; continue; }
      if (!object(event) || !ACTIONS.includes(event.action) || !CHANNELS.includes(event.channel)
        || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))
        || !['repository_count', 'knowledge_delivered', 'issues'].every(key => Number.isSafeInteger(event[key]) && event[key] >= 0)
        || typeof event.truncated !== 'boolean') { report.invalid_rows++; continue; }
      report.recorded_events++;
      report.knowledge_delivered += event.knowledge_delivered;
      report.truncated_events += Number(event.truncated);
      report.issue_events += Number(event.issues > 0);
      report.by_action[event.action] = (report.by_action[event.action] ?? 0) + 1;
      report.by_channel[event.channel] = (report.by_channel[event.channel] ?? 0) + 1;
    }
  } catch (error) { if (error.code !== 'ENOENT') report.issue = 'GRAPH_USAGE_UNREADABLE'; }
  return report;
}
