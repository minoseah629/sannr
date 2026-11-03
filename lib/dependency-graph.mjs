// Portable, repository-owned declarations. Loading and traversing a graph never
// reads a provider checkout, follows a URL, or establishes execution evidence.
import { createHash } from 'node:crypto';
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, opendirSync, realpathSync } from 'node:fs';
import { resolve, parse, join, isAbsolute, basename } from 'node:path';
import { scanMetadataSecrets } from './verdicts.mjs';
import { blockText } from './block-text.mjs';
import { GRAPH_SNAPSHOT_KIND } from './brand.mjs';

const LIMITS = { bytes: 4 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, files: 100,
  nodes: 2000, totalNodes: 10000, edges: 10000, totalEdges: 50000, knowledge: 2000, totalKnowledge: 20000 };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const own = (value, key) => Object.hasOwn(value, key);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('GRAPH_INPUT_INVALID', 'Graph input contains an unsupported or invalid field.');
const hash = value => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
// Public codes are a closed set. A filesystem/parser error never supplies a
// diagnosis or message merely by imitating the graph prefix.
const ERROR_CODES = new Set(['GRAPH_INPUT_INVALID', 'GRAPH_INPUT_BOUNDS', 'GRAPH_PATH_REFUSED',
  'GRAPH_SECRET_REFUSED', 'GRAPH_TEXT_CONTROL_REFUSED', 'GRAPH_REPOSITORY_ID_INVALID',
  'GRAPH_VERSION_UNSUPPORTED', 'GRAPH_OWNERSHIP_INVALID', 'GRAPH_OWNERSHIP_CONFLICT',
  'GRAPH_NODE_MISSING', 'GRAPH_NODE_NOT_FOUND', 'GRAPH_EDGE_CONFLICT', 'GRAPH_BINDING_CONFLICT',
  'GRAPH_KNOWLEDGE_CONFLICT', 'GRAPH_PUBLISHER_CONFLICT', 'GRAPH_SYMLINK_REFUSED',
  'GRAPH_CATALOG_INVALID', 'GRAPH_CATALOG_BOUNDS', 'GRAPH_CATALOG_CHANGED', 'GRAPH_CATALOG_UNREADABLE']);
const workstation = /(?:^|[\s"'`(=])(?:\/(?:Users|home|private|tmp|var|Volumes|Applications|Library|opt|etc|root)(?:\/|\b)|[A-Za-z]:[\\/]|\\\\|~\/)/u;
function text(value, max = 512, { local = false } = {}) {
  if (typeof value === 'string' && /\p{Cf}/u.test(value))
    fail('GRAPH_TEXT_CONTROL_REFUSED', 'Graph record text must omit Unicode format and bidirectional controls.');
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) invalid();
  if (!local && workstation.test(value)) fail('GRAPH_PATH_REFUSED', 'Graph metadata must omit absolute workstation paths.');
  scanMetadataSecrets(value, 'GRAPH_SECRET_REFUSED');
  return value;
}
function json(value, max = LIMITS.bytes) {
  try {
    const ancestors = new Set(); let count = 0;
    const visit = (item, depth) => {
      if (++count > 250000 || depth > 32) throw new Error();
      if (item === null || ['string', 'boolean'].includes(typeof item) || typeof item === 'number' && Number.isFinite(item)) return;
      if ((!object(item) && !Array.isArray(item)) || ancestors.has(item)) throw new Error();
      ancestors.add(item);
      for (const child of Object.values(item)) visit(child, depth + 1);
      ancestors.delete(item);
    };
    visit(value, 0);
    if (Buffer.byteLength(JSON.stringify(value)) > max) throw new Error();
  } catch { fail('GRAPH_INPUT_BOUNDS', 'Graph input exceeds the supported JSON bounds.'); }
}
function list(value, max) {
  if (!Array.isArray(value) || value.length > max) invalid();
  return value;
}
function identifier(value, max = 160) {
  text(value, max);
  if (!value.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(part))) invalid();
  return value;
}
function repositoryId(value) {
  if (typeof value !== 'string' || value.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/u.test(value))
    fail('GRAPH_REPOSITORY_ID_INVALID', 'Repository identities must be a slug or namespace/slug.');
  return text(value, 160);
}
function qualified(value) {
  text(value, 300);
  const parts = value.split('#');
  if (parts.length !== 2) invalid();
  return `${repositoryId(parts[0])}#${identifier(parts[1], 128)}`;
}
function owned(value, repository) {
  const id = typeof value === 'string' && value.includes('#') ? qualified(value) : `${repository}#${identifier(value, 128)}`;
  if (!id.startsWith(`${repository}#`)) fail('GRAPH_OWNERSHIP_INVALID', 'A repository may declare only its own nodes and outgoing dependencies.');
  return id;
}
function contextNode(value, repository, ids, targets) {
  const id = typeof value === 'string' && value.includes('#') ? qualified(value) : owned(value, repository);
  if (!ids.has(id) && !targets.has(id))
    fail('GRAPH_NODE_MISSING', 'Context must bind to an owned node or an exact declared dependency target.');
  return id;
}
function relativeFile(value) {
  text(value, 512);
  if (isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) || /[\\?#]/u.test(value) ||
      value.startsWith('~') || !value.split('/').every(part => part && part !== '.' && part !== '..'))
    fail('GRAPH_PATH_REFUSED', 'Graph source and evidence paths must be repository-relative.');
  return value;
}
function webUrl(value) {
  text(value, 2048);
  let url; try { url = new URL(value); } catch { invalid(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid();
  return value;
}
function protocol(value) {
  text(value, 32);
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) invalid();
  return value;
}
function timestamp(value) {
  text(value, 64);
  originalTimestamp(value);
  if (!value.includes('T')) invalid();
  return new Date(value).toISOString();
}
function originalTimestamp(value) {
  text(value, 64);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/u.test(value) || !Number.isFinite(Date.parse(value))) invalid();
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) invalid();
  return value;
}
function sha(value) { if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) invalid(); return value; }
function metadata(input) {
  const out = {};
  if (own(input, 'protocol')) out.protocol = protocol(input.protocol);
  if (own(input, 'environment')) out.environment = text(input.environment, 128);
  if (own(input, 'file')) out.file = relativeFile(input.file);
  if (own(input, 'operations')) out.operations = [...new Set(list(input.operations, 100).map(value => text(value, 512)))].sort();
  return out;
}
function repository(input) {
  if (!object(input)) invalid();
  return { id: repositoryId(input.id), name: text(input.name, 256), ...(own(input, 'url') ? { url: webUrl(input.url) } : {}),
    ...(own(input, 'fingerprint') ? { fingerprint: sha(input.fingerprint) } : {}) };
}

export function normalizeGraphManifest(input) {
  json(input);
  if (!object(input) || input.v !== 1) fail('GRAPH_VERSION_UNSUPPORTED', 'The graph manifest version is unsupported.');
  const repo = repository(input.repository), ids = new Set(), nodes = [];
  for (const value of list(input.nodes ?? [], LIMITS.nodes)) {
    if (!object(value) || !['repository', 'service', 'operation', 'component'].includes(value.kind)) invalid();
    const id = owned(value.id, repo.id);
    if (ids.has(id)) fail('GRAPH_OWNERSHIP_CONFLICT', 'Duplicate graph node ownership is not supported.');
    if (own(value, 'repository') && value.repository !== repo.id) invalid();
    if (id === `${repo.id}#repo` && value.kind !== 'repository') invalid();
    ids.add(id);
    nodes.push({ id, repository: repo.id, kind: value.kind, name: text(value.name, 256), ...metadata(value) });
  }
  if (!ids.has(`${repo.id}#repo`)) {
    ids.add(`${repo.id}#repo`);
    nodes.unshift({ id: `${repo.id}#repo`, repository: repo.id, kind: 'repository', name: repo.name });
  }
  if (nodes.length > LIMITS.nodes) invalid();
  const edgeIds = new Set();
  const dependencies = list(input.dependencies ?? [], LIMITS.edges).map(value => {
    if (!object(value) || !['depends_on', 'calls', 'imports'].includes(value.kind) ||
        own(value, 'basis') && value.basis !== 'declared' || own(value, 'repository') && value.repository !== repo.id) invalid();
    const from = owned(value.from, repo.id), to = qualified(value.to);
    if (!ids.has(from) || to.startsWith(`${repo.id}#`) && !ids.has(to))
      fail('GRAPH_NODE_MISSING', 'A local dependency must reference declared local nodes.');
    const edge = { repository: repo.id, from, to, kind: value.kind, basis: 'declared', ...metadata(value) };
    const id = hash(edge);
    if (edgeIds.has(id)) fail('GRAPH_EDGE_CONFLICT', 'Duplicate dependency declarations are not supported.');
    if (own(value, 'id') && value.id !== id) invalid();
    edgeIds.add(id);
    return { id, ...edge };
  });
  const result = { v: 1, repository: repo, nodes, dependencies };
  if (own(input, 'publishers')) {
    const publishers = new Set();
    result.publishers = list(input.publishers, LIMITS.files).map(value => {
      if (!object(value)) invalid();
      const id = repositoryId(value.id), fingerprint = sha(value.fingerprint);
      if (publishers.has(id)) fail('GRAPH_PUBLISHER_CONFLICT', 'Each publisher must have exactly one manifest fingerprint.');
      publishers.add(id);
      return { id, fingerprint };
    });
  }
  if (own(input, 'metrics')) {
    if (typeof input.metrics !== 'boolean') invalid();
    result.metrics = input.metrics;
  }
  if (own(input, 'catalog')) {
    const path = text(input.catalog, 2048);
    if (isAbsolute(path) || /^[A-Za-z]:|^[~\\]/u.test(path))
      fail('GRAPH_PATH_REFUSED', 'A committed graph catalog path must be relative; select absolute local paths through the catalog override.');
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path) || path.includes('\0')) invalid();
    result.catalog = path;
  }
  if (own(input, 'context')) {
    if (!object(input.context)) invalid();
    result.context = {};
    if (own(input.context, 'snapshot')) result.context.snapshot = relativeFile(input.context.snapshot);
    const targets = new Set(dependencies.map(edge => edge.to));
    const bindingNode = value => contextNode(value, repo.id, ids, targets);
    if (own(input.context, 'legacy')) result.context.legacy = bindingNode(input.context.legacy);
    if (own(input.context, 'providers')) {
      const keys = new Set();
      result.context.providers = list(input.context.providers, 1000).map(value => {
        if (!object(value)) invalid();
        const provider = text(value.provider, 512);
        if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(provider)) {
          let uri; try { uri = new URL(provider); } catch { invalid(); }
          if (uri.username || uri.password || uri.search || uri.hash) invalid();
        }
        const binding = { node: bindingNode(value.node), provider, environment: text(value.environment, 128), protocol: protocol(value.protocol) };
        const key = JSON.stringify([binding.provider, binding.environment, binding.protocol]);
        if (keys.has(key)) fail('GRAPH_BINDING_CONFLICT', 'A provider scope must bind to exactly one graph node.');
        keys.add(key); return binding;
      });
    }
  }
  return result;
}

function shape(input, depth = 0, budget = { nodes: 0 }) {
  if (!object(input) || ++budget.nodes > 1000 || depth > 10) invalid();
  const allowed = input.type === 'object' ? ['type', 'properties'] : input.type === 'array' ? ['type', 'items', 'sampled'] : ['type'];
  if (Object.keys(input).some(key => !allowed.includes(key))) invalid();
  if (input.type === 'object') {
    if (!object(input.properties) || Object.keys(input.properties).length > 100) invalid();
    return { type: 'object', properties: Object.fromEntries(Object.entries(input.properties).map(([key, value]) => [text(key, 128), shape(value, depth + 1, budget)])) };
  }
  if (input.type === 'array') {
    if (!Number.isSafeInteger(input.sampled) || input.sampled < 0 || input.sampled > 20) invalid();
    return { type: 'array', items: list(input.items, 20).map(value => shape(value, depth + 1, budget)), sampled: input.sampled };
  }
  if (!['null', 'string', 'number', 'boolean', 'omitted'].includes(input.type)) invalid();
  return { type: input.type };
}
function knowledgeRecord(value, repo, ids, targets) {
  if (!object(value)) invalid();
  const node = contextNode(value.node, repo, ids, targets), foreign = !ids.has(node);
  if (own(value, 'publisher') && value.publisher !== repo) fail('GRAPH_OWNERSHIP_INVALID', 'Knowledge publisher identity must match its snapshot repository.');
  if (!['declared', 'observed', 'authored', 'unknown'].includes(value.basis) ||
      !['client-observation', 'external-claim', 'legacy-unverified', 'legacy-verification-recorded'].includes(value.verification)) invalid();
  const out = { id: sha(value.id), node, publisher: repo, operation: text(value.operation, 512), protocol: protocol(value.protocol),
    basis: foreign && value.basis === 'observed' ? 'unknown' : value.basis,
    verification: foreign ? 'external-claim' : value.verification, notes: list(value.notes ?? [], 20).map(note => text(note, 1000)) };
  if (own(value, 'environment')) out.environment = text(value.environment, 128);
  for (const key of ['recorded_at', 'observed_at']) if (own(value, key)) out[key] = originalTimestamp(value[key]);
  if (own(value, 'contractDigest')) out.contractDigest = value.contractDigest === null ? null : sha(value.contractDigest);
  if (own(value, 'based_on')) {
    if (!object(value.based_on) || Object.keys(value.based_on).some(key => !['operation_id', 'observation_id', 'observation_digest'].includes(key))) invalid();
    out.based_on = { operation_id: sha(value.based_on.operation_id), observation_id: text(value.based_on.observation_id, 512),
      observation_digest: sha(value.based_on.observation_digest) };
  }
  for (const key of ['request_shape', 'response_shape']) if (own(value, key)) out[key] = shape(value[key]);
  out.evidence = list(value.evidence ?? [], 8).map(ref => {
    if (!object(ref) || ref.state !== 'unavailable') invalid();
    return { path: relativeFile(ref.path), digest: sha(ref.digest), state: 'unavailable' };
  });
  out.omissions = list(value.omissions ?? [], 40).map(note => text(note, 512));
  if (!object(value.source) || !['legacy-http', 'protocol-context'].includes(value.source.kind)) invalid();
  out.source = { kind: value.source.kind, path: relativeFile(value.source.path), record_id: text(value.source.record_id, 1024), digest: sha(value.source.digest) };
  for (const key of ['author', 'claim_kind']) if (own(value.source, key)) out.source[key] = text(value.source[key], 256);
  if (own(value.source, 'verification')) {
    if (!['client-observation', 'external-claim', 'legacy-unverified', 'legacy-verification-recorded'].includes(value.source.verification)) invalid();
    out.source.verification = foreign ? 'external-claim' : value.source.verification;
  } else if (foreign) out.source.verification = 'external-claim';
  if (!object(value.freshness) || !['unverified', 'stale', 'unknown'].includes(value.freshness.state)) invalid();
  out.freshness = { state: value.freshness.state, reason: text(value.freshness.reason, 512) };
  for (const key of ['recorded_at', 'observed_at']) if (own(value.freshness, key)) out.freshness[key] = originalTimestamp(value.freshness[key]);
  if (own(value.freshness, 'age_days')) {
    if (!Number.isSafeInteger(value.freshness.age_days) || value.freshness.age_days < 0) invalid();
    out.freshness.age_days = value.freshness.age_days;
  }
  return out;
}

export function createGraphSnapshot(manifest, { knowledge = [], omissions = [], at = new Date().toISOString(), head = null } = {}) {
  const normalized = normalizeGraphManifest(manifest), ids = new Set(normalized.nodes.map(node => node.id)), targets = new Set(normalized.dependencies.map(edge => edge.to));
  json({ knowledge, omissions });
  if (head !== null && (typeof head !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(head))) invalid();
  const knowledgeIds = new Set();
  const records = list(knowledge, LIMITS.knowledge).map(value => {
    const record = knowledgeRecord(value, normalized.repository.id, ids, targets);
    if (knowledgeIds.has(record.id)) fail('GRAPH_KNOWLEDGE_CONFLICT', 'Duplicate knowledge identities are not supported.');
    knowledgeIds.add(record.id); return record;
  });
  const snapshot = { v: 1, kind: GRAPH_SNAPSHOT_KIND, repository: normalized.repository, generated_at: timestamp(at), head,
    nodes: normalized.nodes, edges: normalized.dependencies, knowledge: records, omissions: list(omissions, 100).map(value => text(value, 512)) };
  json(snapshot); scanMetadataSecrets(snapshot, 'GRAPH_SECRET_REFUSED');
  return snapshot;
}

function snapshot(input) {
  if (!object(input) || input.v !== 1 || input.kind !== GRAPH_SNAPSHOT_KIND)
    fail('GRAPH_VERSION_UNSUPPORTED', 'The graph snapshot version or kind is unsupported.');
  if (!Array.isArray(input.nodes) || !Array.isArray(input.edges) || !Array.isArray(input.knowledge) ||
      !Array.isArray(input.omissions) || !own(input, 'head') || !own(input, 'generated_at')) invalid();
  if (!input.nodes.some(node => node?.id === `${input.repository?.id}#repo` && node.kind === 'repository')) invalid();
  for (const node of input.nodes) qualified(node.id);
  // Reuse ownership and field projection on read. Snapshot files never carry
  // catalog paths or context bindings into the loaded catalog.
  return createGraphSnapshot({ v: 1, repository: input.repository, nodes: input.nodes, dependencies: input.edges },
    { knowledge: input.knowledge, omissions: input.omissions, at: input.generated_at, head: input.head });
}
function noSymlinks(path) {
  const absolute = resolve(path), { root } = parse(absolute);
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, part);
    // Same narrow OS-owned ancestor exceptions as safeOutputPath. A user-made
    // alias, the selected target itself, and aliases elsewhere still refuse.
    const systemAlias = process.platform === 'darwin' && current !== absolute
      && ['/tmp', '/var'].includes(current) && realpathSync(current) === `/private${current}`;
    if (lstatSync(current).isSymbolicLink() && !systemAlias) fail('GRAPH_SYMLINK_REFUSED', 'Graph catalog paths must not traverse symbolic links.');
  }
  return absolute;
}
function readSnapshot(path, budget) {
  noSymlinks(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  let data;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) fail('GRAPH_CATALOG_INVALID', 'Catalog entries must be regular snapshot files.');
    if (stat.size > LIMITS.bytes || budget.bytes + stat.size > LIMITS.totalBytes)
      fail('GRAPH_CATALOG_BOUNDS', 'The graph catalog exceeds its supported size limits.');
    // Read only the bounded size already measured; concurrent growth cannot
    // force an unbounded allocation through readFileSync.
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const bytes = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!bytes) break;
      offset += bytes;
    }
    if (offset !== stat.size) fail('GRAPH_CATALOG_CHANGED', 'A graph snapshot changed while it was being read.');
    budget.bytes += offset; data = buffer.subarray(0, offset).toString('utf8');
  } finally { closeSync(fd); }
  let input; try { input = JSON.parse(data); } catch { fail('GRAPH_CATALOG_INVALID', 'A graph snapshot is not valid JSON.'); }
  return snapshot(input);
}

export function buildGraphCatalog(snapshots) {
  json(snapshots, LIMITS.totalBytes);
  list(snapshots, LIMITS.files);
  const result = { v: 1, repositories: [], nodes: [], edges: [], knowledge: [], snapshots: [], coverage: 'partial', issues: [], omissions: [], unresolved: [] };
  const owners = new Set(), nodeIds = new Set();
  for (const input of snapshots) {
    const value = snapshot(input);
    if (owners.has(value.repository.id)) fail('GRAPH_OWNERSHIP_CONFLICT', 'The selected catalog contains duplicate repository ownership.');
    owners.add(value.repository.id);
    for (const node of value.nodes) {
      if (nodeIds.has(node.id)) fail('GRAPH_OWNERSHIP_CONFLICT', 'The selected catalog contains duplicate node ownership.');
      nodeIds.add(node.id);
    }
    if (result.nodes.length + value.nodes.length > LIMITS.totalNodes || result.edges.length + value.edges.length > LIMITS.totalEdges ||
        result.knowledge.length + value.knowledge.length > LIMITS.totalKnowledge)
      fail('GRAPH_CATALOG_BOUNDS', 'The graph catalog exceeds its graph or knowledge limits.');
    result.snapshots.push(value);
    result.repositories.push({ ...value.repository, generated_at: value.generated_at, head: value.head });
    result.nodes.push(...value.nodes); result.edges.push(...value.edges);
    result.knowledge.push(...value.knowledge);
    result.omissions.push(...value.omissions.map(message => ({ repository: value.repository.id, message })));
  }
  const missing = new Map();
  for (const edge of result.edges) if (!nodeIds.has(edge.to)) {
    if (!missing.has(edge.to)) missing.set(edge.to, []);
    missing.get(edge.to).push(edge.id);
  }
  result.unresolved = [...missing].map(([id, referenced_by]) => ({ id, referenced_by }));
  if (!snapshots.length) result.issues.push({ code: 'GRAPH_CATALOG_EMPTY', message: 'The selected catalog contains no snapshot files.' });
  result.omissions.push('Catalog coverage is partial; absent incoming declarations do not establish that a node has no callers.');
  return result;
}

export async function loadGraphCatalog(path) {
  try {
    text(path, 4096, { local: true });
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(path)) fail('GRAPH_CATALOG_INVALID', 'A graph catalog must be an explicit local file or directory.');
    const absolute = noSymlinks(path), stat = lstatSync(absolute), files = [], omissions = [], issues = [];
    if (stat.isFile()) files.push(absolute);
    else if (stat.isDirectory()) {
      const directory = opendirSync(absolute); let entry, seen = 0, ignored = 0;
      try {
        while ((entry = directory.readSync())) {
          if (++seen > 1000) fail('GRAPH_CATALOG_BOUNDS', 'The graph catalog directory exceeds its entry limit.');
          if (!entry.name.endsWith('.json')) { ignored++; continue; }
          if (!entry.isFile() && !entry.isSymbolicLink()) { ignored++; continue; }
          files.push(join(absolute, entry.name));
          if (files.length > LIMITS.files) fail('GRAPH_CATALOG_BOUNDS', 'The graph catalog exceeds its snapshot file limit.');
        }
      } finally { directory.closeSync(); }
      if (ignored) omissions.push('Only JSON snapshot files in the selected directory were read; other entries were not followed.');
    } else fail('GRAPH_CATALOG_INVALID', 'A graph catalog must be a regular file or flat directory.');
    files.sort();
    const budget = { bytes: 0 }, snapshots = [];
    for (const file of files) {
      try { snapshots.push(readSnapshot(file, budget)); }
      catch (error) {
        // A file's diagnosis is isolated; aggregate bounds and conflicting
        // ownership remain fatal rather than choosing an owner by filename.
        if (budget.bytes >= LIMITS.totalBytes) throw error;
        const code = ERROR_CODES.has(error.code) ? error.code : 'GRAPH_CATALOG_UNREADABLE';
        let name = blockText(basename(file).replace(/\p{Cf}/gu, char => `\\u${char.codePointAt(0).toString(16).padStart(4, '0')}`), { max: 256 });
        try { scanMetadataSecrets(name, 'GRAPH_SECRET_REFUSED'); }
        catch { name = '[withheld filename]'; }
        issues.push({ code, file: name, message: 'This catalog file was skipped; inspect its bounded snapshot shape and unlinked file path.' });
      }
    }
    const result = buildGraphCatalog(snapshots);
    result.issues.push(...issues);
    result.omissions.unshift(...omissions);
    return result;
  } catch (error) {
    if (ERROR_CODES.has(error.code)) throw error;
    fail('GRAPH_CATALOG_UNREADABLE', 'The graph catalog could not be read.');
  }
}

// Only the fresh projection of the consuming repository receives local trust.
// Its own provider lessons are local knowledge; exported copies carry no such
// provenance and remain foreign claims when read by another consumer.
export function isForeignNodeClaim(record) {
  return record.publisher_trust !== 'local' && record.node.split('#')[0] !== record.publisher;
}

function traverse(catalog, { node, depth = 1, maxNodes, includeForeignClaims = false }, reverse) {
  qualified(node);
  if (!object(catalog) || catalog.v !== 1 || !Array.isArray(catalog.nodes) || !Array.isArray(catalog.edges)) invalid();
  if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > 500 || !Number.isInteger(depth) || depth < 0 || depth > 10
    || typeof includeForeignClaims !== 'boolean') invalid();
  const nodes = new Map(catalog.nodes.map(value => [value.id, value]));
  for (const value of catalog.unresolved ?? []) if (!nodes.has(value.id)) nodes.set(value.id,
    { id: value.id, repository: value.id.split('#')[0], name: value.id, kind: 'unresolved', unresolved: true });
  if (!nodes.has(node)) fail('GRAPH_NODE_NOT_FOUND', 'The selected node is absent from the catalog and its unresolved targets.');
  const focus = nodes.get(node), seeds = focus.kind === 'repository'
    ? [node, ...catalog.nodes.filter(value => value.repository === focus.repository && value.id !== node).map(value => value.id).sort()] : [node];
  const incoming = new Map(), outgoing = new Map();
  for (const edge of catalog.edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    incoming.get(edge.to).push(edge); outgoing.get(edge.from).push(edge);
  }
  const seen = new Set(), queue = [], paths = [], truncated = { max_nodes: false, max_edges: false, knowledge: false };
  for (const seed of seeds) {
    if (seen.size >= maxNodes) { truncated.max_nodes = true; break; }
    seen.add(seed); queue.push({ id: seed, distance: 0, seed, nodes: [seed], edges: [] });
  }
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index];
    if (!reverse && current.distance >= depth) continue;
    const adjacent = [...(incoming.get(current.id) ?? []), ...(!reverse ? outgoing.get(current.id) ?? [] : [])];
    for (const edge of adjacent) {
      const next = edge.to === current.id ? edge.from : edge.to;
      if (seen.has(next)) continue;
      if (seen.size >= maxNodes) { truncated.max_nodes = true; continue; }
      seen.add(next);
      const found = { id: next, distance: current.distance + 1, seed: current.seed,
        nodes: [...current.nodes, next], edges: [...current.edges, edge.id] };
      queue.push(found); paths.push({ node: next, seed: found.seed, distance: found.distance, nodes: found.nodes, edges: found.edges, basis: 'declared' });
    }
  }
  const allEdges = catalog.edges.filter(edge => seen.has(edge.from) && seen.has(edge.to));
  // Preserve every supporting path before filling additional local edges.
  const supporting = new Set(paths.flatMap(path => path.edges)), selectedEdges = [];
  for (const edge of allEdges.filter(edge => supporting.has(edge.id)).concat(allEdges.filter(edge => !supporting.has(edge.id)))) {
    if (selectedEdges.length >= 2000) { truncated.max_edges = true; break; }
    selectedEdges.push(edge);
  }
  const matching = (catalog.knowledge ?? []).filter(record => seen.has(record.node));
  const foreign = matching.filter(isForeignNodeClaim);
  const selectedKnowledge = matching.filter(record => !isForeignNodeClaim(record));
  const knowledge = []; let bytes = 0;
  for (const record of selectedKnowledge) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (knowledge.length >= 200 || bytes + size > 1024 * 1024) { truncated.knowledge = true; continue; }
    knowledge.push(record); bytes += size;
  }
  // Catalog-delivered foreign-node claims have an independent opt-in and cap;
  // a consumer's own provider lessons stay in its main knowledge budget.
  const foreignClaims = []; let foreignBytes = 0;
  if (includeForeignClaims) for (const record of foreign) {
    const size = Buffer.byteLength(JSON.stringify(record));
    if (foreignClaims.length >= 200 || foreignBytes + size > 1024 * 1024) { truncated.foreign_claims = true; continue; }
    foreignClaims.push(record); foreignBytes += size;
  }
  const seedSet = new Set(seeds), callers = [...new Set(catalog.edges.filter(edge => seedSet.has(edge.to) &&
    edge.repository !== focus.repository).map(edge => edge.repository))].sort();
  const omissions = [...(catalog.omissions ?? []), 'Only one shortest supporting path per reached node is returned; alternative paths are not enumerated.'];
  if (truncated.max_nodes) omissions.push('The node limit omitted additional nodes and their context.');
  if (truncated.max_edges) omissions.push('The edge limit omitted additional declarations.');
  if (truncated.knowledge) omissions.push('The knowledge limit omitted additional records.');
  const repositoryIds = new Set([...seen].map(id => nodes.get(id).repository).concat([...knowledge, ...foreignClaims].map(record => record.publisher)));
  const edgeIds = new Set(selectedEdges.map(edge => edge.id));
  const unresolved = (catalog.unresolved ?? []).filter(value => seen.has(value.id)).map(value => {
    const referenced_by = value.referenced_by.filter(id => edgeIds.has(id));
    return { id: value.id, referenced_by, ...(referenced_by.length < value.referenced_by.length
      ? { omitted_references: value.referenced_by.length - referenced_by.length } : {}) };
  });
  return { v: 1, kind: reverse ? 'impact' : 'neighborhood', focus: node, coverage: 'partial',
    meaning: reverse ? 'Declared reverse reachability is potential impact, not proof of a breaking change or a performance effect.'
      : 'Repository-owned dependency declarations and scoped saved knowledge; declarations do not establish execution.',
    repositories: (catalog.repositories ?? []).filter(repository => repositoryIds.has(repository.id)),
    nodes: [...seen].map(id => nodes.get(id)), edges: selectedEdges, knowledge, paths,
    ...(includeForeignClaims ? { foreign_claims: foreignClaims,
      foreign_claims_meaning: 'Claims about foreign nodes (external-claim, unverified); dependency declarations do not grant node ownership.' }
      : foreign.length ? { omitted_foreign_claims: foreign.length } : {}),
    callers: { repositories: callers, count: callers.length, coverage: 'partial', meaning: 'Known direct caller repositories are a lower bound; other callers are unknown.' },
    unresolved, issues: catalog.issues ?? [], omissions, truncated };
}

function query(catalog, options, reverse) {
  try {
    if (!object(options)) invalid();
    return traverse(catalog, { node: options.node, depth: options.depth ?? 1, maxNodes: options.maxNodes ?? (reverse ? 100 : 50),
      includeForeignClaims: options.includeForeignClaims ?? false }, reverse);
  } catch (error) {
    if (ERROR_CODES.has(error.code)) throw error;
    fail('GRAPH_INPUT_INVALID', 'A valid loaded graph catalog and bounded query are required.');
  }
}
export function graphNeighborhood(catalog, options = {}) {
  return query(catalog, options, false);
}
export function graphImpact(catalog, options = {}) {
  return query(catalog, options, true);
}
