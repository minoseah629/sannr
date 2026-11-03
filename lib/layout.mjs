// Project-owned paths have one authority. Basenames in brand are identities;
// this module decides where the project's committed and private halves live.
import { closeSync, constants, fstatSync, openSync, readSync, writeFileSync, fsyncSync, fchmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, linkSync, rmdirSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { PRODUCT, COLLECTION, PROJECT_DIR_NAME, CONTEXT_BASENAME, GRAPH_MANIFEST_BASENAME, GRAPH_SNAPSHOT_BASENAME, POINTER_CLI_NAME, CI_TARBALL_BASENAME, PROSE_PRODUCT_TITLE, POINTER_BEGIN, POINTER_END } from './brand.mjs';
import { currentStackScope } from './stack-scope.mjs';
import { safeOutputPath, writeOutputFile } from './output-path.mjs';
import { advertisementPlan } from './advertisement.mjs';

export function layoutFor(product = PRODUCT, collectionName = COLLECTION) {
  if (['config', 'skills', 'evidence', 'feedback', 'vendor', 'requests', 'readme.md', '.gitignore', 'layout.json'].includes(collectionName.toLowerCase()))
    throw Object.assign(new Error('The collection name conflicts with a managed layout location.'), { code: 'LAYOUT_COLLECTION_CONFLICT' });
  const renamed = name => name.replace(PRODUCT, product);
  const directory = renamed(PROJECT_DIR_NAME);
  const collection = posix.join(directory, collectionName);
  const config = posix.join(directory, 'config');
  const skills = posix.join(directory, 'skills');
  return Object.freeze({
    directory, collection, config, skills, requests: posix.join(directory, 'requests'),
    readme: posix.join(directory, 'README.md'), gitignore: posix.join(directory, '.gitignore'),
    marker: posix.join(directory, 'layout.json'),
    context: posix.join(collection, renamed(CONTEXT_BASENAME)),
    graphManifest: posix.join(collection, renamed(GRAPH_MANIFEST_BASENAME)),
    graphSnapshot: posix.join(collection, GRAPH_SNAPSHOT_BASENAME),
    environments: posix.join(config, 'api-environments.json'), defaults: posix.join(config, 'defaults.json'),
    evidence: posix.join(directory, 'evidence'), skillGuide: posix.join(skills, `${product}-request.md`),
    feedback: posix.join(directory, 'feedback.md'),
    suites: posix.join(collection, 'suites'), baseline: posix.join(collection, 'api-audit-baseline.json'),
    ciTarball: posix.join(directory, 'vendor', renamed(CI_TARBALL_BASENAME)),
    mapOutput: posix.join(directory, 'evidence', 'api-footprint.html'),
    viewOutput: posix.join(directory, 'evidence', 'view', 'index.html'),
    auditReport: posix.join(directory, 'evidence', 'api-audit.md'),
    mcpReport: posix.join(directory, 'evidence', 'mcp-report.md'),
  });
}
export const LAYOUT = layoutFor();
const directory = LAYOUT.directory;
export const layoutPath = (root, key) => resolve(root, LAYOUT[key] ?? key);
export const LEGACY_LAYOUT = Object.freeze({
  context: CONTEXT_BASENAME, graphManifest: GRAPH_MANIFEST_BASENAME,
  graphSnapshot: posix.join(directory, GRAPH_SNAPSHOT_BASENAME),
  environments: 'api-environments.json', hiddenEnvironments: '.api-environments.json',
  defaults: 'api-defaults.json', evidence: 'evidence', skillGuide: 'api-request.md',
  suites: 'api-suites', baseline: 'api-audit-baseline.json', ciTarball: posix.join('vendor', CI_TARBALL_BASENAME),
  mapOutput: 'api-footprint.html',
});
const markerBytes = () => JSON.stringify({ kind: 'repo-api-layout', v: 1, product: PRODUCT, collection: COLLECTION }, null, 2) + '\n';
function layoutReadmeBody({ stacks = false, cli = POINTER_CLI_NAME } = {}) {
  const table = [
    ...(stacks ? [
      [posix.join(LAYOUT.collection, '<name>', 'stack.json'), 'Committed API configuration, environments and credential references.'],
      [posix.join(LAYOUT.directory, 'defaults.json'), 'Optional committed client defaults and default_stack.'],
    ] : []),
    [stacks ? posix.join(LAYOUT.collection, '<name>', CONTEXT_BASENAME) : LAYOUT.context, 'Committed API knowledge: operations, observations, and authored lessons.'],
    [LAYOUT.graphManifest, 'Committed graph configuration and provider bindings.'],
    [LAYOUT.graphSnapshot, 'Committed cross-repository graph snapshot, when exported.'],
    ...(!stacks ? [[LAYOUT.environments, 'Committed named environments and credential-variable references.'],
      [LAYOUT.defaults, 'Optional committed client defaults.']] : []),
    [LAYOUT.suites + '/', 'Committed request suites and import provenance.'],
    [LAYOUT.baseline, 'Committed accepted audit findings.'],
    [LAYOUT.ciTarball, 'Vendored engine package, when CI is explicitly installed.'],
    [LAYOUT.skills + '/', 'Canonical skills, copied into each agent host.'],
    [LAYOUT.evidence + (stacks ? '/<name>/' : '/'), 'Private local request evidence; ignored by Git.'],
  ].map(([path, meaning]) => `| \`${path}\` | ${meaning} |`).join('\n');
  return readFileSync(new URL('./layout-README.md', import.meta.url), 'utf8')
    .replaceAll(PROSE_PRODUCT_TITLE, PRODUCT[0].toUpperCase() + PRODUCT.slice(1))
    .replaceAll('{{CLI}}', cli)
    .replace('{{LAYOUT_TABLE}}', '| Repository-relative path | Purpose |\n| --- | --- |\n' + table);
}
export function renderLayoutReadme(options = {}) {
  return `${POINTER_BEGIN}\n${layoutReadmeBody(options)}${POINTER_END}\n`;
}

// Exact byte identities of every distinct generated guide shipped before
// markers: DOTSANNR-1, alpha.3, alpha.4, STACKS-1A and STACKS-1B respectively.
// Never infer ownership from a heading or a substring: one appended link makes
// an unmarked guide user-owned. Current renamed renders are compared directly.
const SHIPPED_GUIDES = new Set([
  '88128167763108966896abd7f286009824e73ddd3c1227a4b9bf23b5fc19fadd', // 38086d0
  '28f4167ef297652cf344fd3d34e0528ff4584cf7f67bb55e96662dbaf42a991c', // 9fec6d3
  '6b907f6811f80e4ff32236ead756ff319d5be11a078dc0743dbda3fa5df55d58', // 834f36b
  '94a9079049f043e7dd321d6051113e55717e4b4c477dc293922392f9557e733f', // 1639078 stacks
  '6e9faaed5443c9db0c5d06dc6c78faa03b032e443b7f598c3f3a595c25ab4a1d', // b85ed98 legacy
  'c9131f74da1e03777b48ff8a1e7718122e5398a7a8a1a71a6da8346ffee104d5', // b85ed98 stacks
]);
function readmeState(text, { beginMarker = POINTER_BEGIN, endMarker = POINTER_END } = {}) {
  if (text === null) return { status: 'missing' };
  const begins = [], ends = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    const content = line.replace(/\r$/u, '');
    if (content === beginMarker) begins.push(offset);
    if (content === endMarker) ends.push(offset);
    offset += line.length + 1;
  }
  if (begins.length || ends.length) {
    if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return { status: 'invalid-markers' };
    return { status: 'managed', begin: begins[0], end: ends[0] + endMarker.length };
  }
  const generated = SHIPPED_GUIDES.has(createHash('sha256').update(text).digest('hex'))
    || [false, true].some(stacks => text === layoutReadmeBody({ stacks }));
  return { status: generated ? 'legacy-generated' : 'unmanaged' };
}
export function inspectLayoutReadme(root) {
  const path = layoutPath(root, 'readme');
  safeOutputPath(path, { code: 'LAYOUT_UNSAFE_PATH' });
  return { path: LAYOUT.readme, ...readmeState(existsSync(path) ? readFileSync(path, 'utf8') : null) };
}
// The guide is committed, so it names the same command tier as the pointer
// block: the repo-local shim when it exists, else the exact npx form. Without
// either, the shim path stays as the documented install target.
function readmeCli(root) {
  const portable = advertisementPlan(root).portable;
  return portable.available ? portable.command : POINTER_CLI_NAME;
}
function refreshLayoutReadme(root, options) {
  options = { cli: readmeCli(root), ...options };
  const path = layoutPath(root, 'readme');
  const text = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const state = readmeState(text), generated = renderLayoutReadme(options);
  if (state.status === 'managed')
    return text.slice(0, state.begin) + generated.trimEnd() + text.slice(state.end);
  if (['missing', 'legacy-generated'].includes(state.status)) return generated;
  return text;
}
const fail = (code, path) => { throw Object.assign(new Error(`${code}: ${path}`), { code, path }); };
function present(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export function planLayout(root, { migrating = false } = {}) {
  if (!migrating) {
    const unconfiguredEvidence = new Set([LEGACY_LAYOUT.evidence, LEGACY_LAYOUT.mapOutput]);
    const legacy = legacyLayoutEntries(root).filter(entry => !unconfiguredEvidence.has(entry.from));
    if (legacy.length) {
      const error = Object.assign(new Error(`An existing install requires migration: ${legacy.map(entry => entry.from).join(', ')}.`),
        { code: 'LAYOUT_MIGRATION_REQUIRED', next: `Run ${POINTER_CLI_NAME} migrate before writing new project memory.` });
      throw error;
    }
  }
  // Explicit stacks own their configuration; do not recreate the retired
  // shared config folder during a scoped write. Legacy installs retain it.
  const collection = join(root, LAYOUT.collection);
  if (existsSync(collection)) safeOutputPath(collection, { directory: true, code: 'LAYOUT_UNSAFE_PATH' });
  const stackLayout = currentStackScope()?.root === resolve(root)
    || (existsSync(collection) && readdirSync(collection, { withFileTypes: true })
      .some(entry => entry.isDirectory() && existsSync(join(collection, entry.name, 'stack.json'))));
  // A fresh repository's next write creates a named stack. Describe that
  // layout before its first stack exists, preserving the single-store guide
  // only for an existing legacy installation. This does not change storage.
  const legacyStore = [LAYOUT.context, LAYOUT.environments, LEGACY_LAYOUT.context,
    LEGACY_LAYOUT.environments, LEGACY_LAYOUT.hiddenEnvironments].some(path => existsSync(join(root, path)));
  const dirs = ['directory', 'collection', ...(!stackLayout ? ['config'] : []), 'skills', 'evidence'].map(key => LAYOUT[key]);
  for (const path of dirs) safeOutputPath(join(root, path), { directory: true, code: 'LAYOUT_UNSAFE_PATH' });
  for (const key of ['readme', 'gitignore', 'marker']) safeOutputPath(layoutPath(root, key), { code: 'LAYOUT_UNSAFE_PATH' });
  let ignore = existsSync(layoutPath(root, 'gitignore')) ? readFileSync(layoutPath(root, 'gitignore'), 'utf8') : '';
  // Install before an agent writes answers, not just when a send later creates
  // its receipt. A trailing block overrides earlier negations and stays stable
  // across repeated connects. Knowledge cannot use these reserved directories.
  const privateRules = '/evidence/\n/feedback/';
  if (!ignore.trimEnd().replaceAll('\r\n','\n').endsWith(privateRules))
    ignore += `${ignore && !ignore.endsWith('\n') ? '\n' : ''}${privateRules}\n`;
  return { directories: dirs, files: [
    { path: LAYOUT.readme, content: refreshLayoutReadme(root, { stacks: stackLayout || !legacyStore }) },
    { path: LAYOUT.gitignore, content: ignore },
    { path: LAYOUT.marker, content: markerBytes() },
  ] };
}
export function ensureLayout(root) {
  const plan = planLayout(root), created = [];
  for (const path of plan.directories) if (!existsSync(join(root, path))) { mkdirSync(join(root, path), { recursive: true }); created.push(path); }
  for (const {path, content} of plan.files) {
    if (existsSync(join(root, path)) && readFileSync(join(root, path), 'utf8') === content) continue;
    writeOutputFile(join(root, path), content, { code: 'LAYOUT_UNSAFE_PATH' }); created.push(path);
  }
  return { created };
}

function readMarker(path, portablePath) {
  safeOutputPath(path, { code: 'LAYOUT_UNSAFE_PATH' });
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) fail('LAYOUT_MARKER_INVALID', portablePath);
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > 4096 || count !== stat.size) fail('LAYOUT_MARKER_INVALID', portablePath);
    try { return JSON.parse(bytes.subarray(0, count).toString('utf8')); } catch { return null; }
  } finally { if (fd !== undefined) closeSync(fd); }
}
function priorLayouts(root) {
  const prior = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.name.startsWith('.') || !entry.isDirectory()) continue;
    const path = join(root, entry.name, 'layout.json');
    if (!present(path)) continue;
    const data = readMarker(path, posix.join(entry.name, 'layout.json'));
    if (data?.kind !== 'repo-api-layout' || data.v !== 1) continue;
    if (![data.product, data.collection].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(value))) fail('LAYOUT_MARKER_INVALID', posix.join(entry.name, 'layout.json'));
    if (entry.name !== `.${data.product}`) fail('LAYOUT_MARKER_INVALID', posix.join(entry.name, 'layout.json'));
    if (entry.name !== directory || data.collection !== COLLECTION) prior.push({ ...data, directory: entry.name });
  }
  return prior;
}
function filesUnder(root, path) {
  safeOutputPath(join(root, path), { directory: true, code: 'LAYOUT_UNSAFE_PATH' });
  return readdirSync(join(root, path), { withFileTypes: true }).flatMap(entry => {
    const child = posix.join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(root, child);
    safeOutputPath(join(root, child), { code: 'LAYOUT_UNSAFE_PATH' }); return [child];
  });
}
export function legacyLayoutEntries(root) {
  const entries = [];
  for (const [key, from] of Object.entries(LEGACY_LAYOUT)) {
    const to = LAYOUT[key === 'hiddenEnvironments' ? 'environments' : key];
    if (from !== to && present(join(root, from))) entries.push({ from, to });
  }
  for (const prior of priorLayouts(root)) entries.push({ from: prior.directory, to: directory, collection: prior.collection, product: prior.product });
  return entries;
}
function removeEmptyTree(path) {
  if (!existsSync(path)) return;
  safeOutputPath(path, { directory: true, code: 'LAYOUT_UNSAFE_PATH' });
  for (const item of readdirSync(path, {withFileTypes:true})) if (item.isDirectory()) removeEmptyTree(join(path, item.name));
  try { rmdirSync(path); } catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error; }
}
function migratedReferenceBytes(root, move, entries, moves) {
  if (move.to === LAYOUT.readme) {
    const prior = entries.find(entry => entry.product && move.from === posix.join(entry.from, 'README.md'));
    if (!prior) return null;
    const text = readFileSync(join(root, move.from), 'utf8');
    const state = readmeState(text, { beginMarker: `<!-- ${prior.product}:begin -->`, endMarker: `<!-- ${prior.product}:end -->` });
    if (state.status === 'managed')
      return text.slice(0, state.begin) + renderLayoutReadme().trimEnd() + text.slice(state.end);
    return state.status === 'legacy-generated' ? renderLayoutReadme() : null;
  }
  if (![LAYOUT.environments, LAYOUT.defaults, LAYOUT.graphManifest, LAYOUT.graphSnapshot, LAYOUT.context].includes(move.to)) return null;
  let value; try { value = JSON.parse(readFileSync(join(root, move.from), 'utf8')); } catch { return null; }
  const replacements = [...moves, ...entries].map(entry => ({ from: entry.from, to: entry.to }));
  for (const entry of entries.filter(item => item.product)) {
    replacements.unshift({ from: posix.join(entry.directory ?? entry.from, entry.collection), to: LAYOUT.collection });
  }
  replacements.sort((a,b) => b.from.length - a.from.length);
  let changed = false;
  // These references belong to the configuration/knowledge schema, unlike an
  // authored object's coincidentally named contract or envFile field. Rebase
  // only a path covered by the move plan; external env files stay external.
  const rewriteOwnedReference = (container, key) => {
    const input = container?.[key];
    if (typeof input !== 'string' || input.startsWith('~/')) return;
    const normalized = relative(resolve(root), resolve(root, input));
    const match = replacements.find(entry => normalized === entry.from || normalized.startsWith(entry.from + '/'));
    if (match) { changed = true; container[key] = match.to + normalized.slice(match.from.length); }
  };
  if (move.to === LAYOUT.context) rewriteOwnedReference(value.api, 'contract');
  if (move.to === LAYOUT.environments) {
    const rewriteEnvironment = environment => {
      if (!environment || typeof environment !== 'object' || Array.isArray(environment)) return;
      rewriteOwnedReference(environment, 'contract');
      rewriteOwnedReference(environment, 'envFile');
    };
    for (const host of Object.values(value.hosts ?? {})) rewriteEnvironment(host);
    for (const environment of Object.values(value.environments ?? {})) {
      rewriteEnvironment(environment);
      for (const host of Object.values(environment?.hosts ?? {})) rewriteEnvironment(host);
    }
  }
  const walk = (item, key = '') => {
    if (Array.isArray(item)) return item.map(child => walk(child, key));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, child]) => [name, walk(child, name)]));
    if (typeof item !== 'string') return item;
    if (['path', 'file', 'source_file', 'catalog', 'snapshot', 'evidenceDir', 'contextPath', 'probe'].includes(key)) {
      const normalized = item.replace(/^\.\//u, '');
      const match = replacements.find(entry => normalized === entry.from || normalized.startsWith(entry.from + '/'));
      if (match) { changed = true; return match.to + normalized.slice(match.from.length); }
      if (key === 'evidenceDir' && normalized === LEGACY_LAYOUT.evidence) { changed = true; return LAYOUT.evidence; }
    }
    if (key === 'kind' && entries.some(entry => entry.product && item === `${entry.product}-graph`)) {
      changed = true; return `${PRODUCT}-graph`;
    }
    return item;
  };
  const next = walk(value);
  return changed ? JSON.stringify(next, null, 2) + '\n' : null;
}
// The stack migration preflights against the canonical layout before the older
// layout is changed. Keep private evidence bytes in this in-process Map only;
// neither the CLI report nor a persisted migration plan contains them.
export function projectedLayoutFiles(root, plan) {
  const entries = legacyLayoutEntries(root);
  return new Map(plan.moved.map(move => {
    const source = join(root, move.from);
    safeOutputPath(source, { code: 'LAYOUT_UNSAFE_PATH' });
    return [move.to, { from: move.from,
      bytes: Buffer.from(migratedReferenceBytes(root, move, entries, plan.moved) ?? readFileSync(source)),
      mode: lstatSync(source).mode & 0o777 }];
  }));
}
export function migrateLayout(root, { dryRun = false } = {}) {
  const entries = legacyLayoutEntries(root), moves = [], obsolete = [];
  for (const entry of entries) {
    const stat = lstatSync(join(root, entry.from));
    if (entry.product) {
      for (const file of filesUnder(root, entry.from)) {
        const relative = file.slice(entry.from.length + 1);
        if (relative === 'layout.json') { obsolete.push(file); continue; }
        const parts = relative.split('/');
        if (parts[0] === entry.collection) parts[0] = COLLECTION;
        const renamed = parts.map(part => part === `${entry.product}.json` ? CONTEXT_BASENAME
          : part === `.${entry.product}-graph.json` ? GRAPH_MANIFEST_BASENAME
          : part.startsWith(`${entry.product}-`) ? `${PRODUCT}${part.slice(entry.product.length)}` : part);
        const to = posix.join(directory, ...renamed);
        if (file !== to) moves.push({ from: file, to });
      }
    } else if (stat.isDirectory()) {
      for (const file of filesUnder(root, entry.from)) moves.push({ from: file, to: posix.join(entry.to, file.slice(entry.from.length + 1)) });
    } else moves.push(entry);
  }
  // Validate the complete plan before creating directories or moving one byte.
  const destinations = new Set();
  for (const {from,to} of moves) {
    safeOutputPath(join(root, from), { code: 'LAYOUT_UNSAFE_PATH' });
    safeOutputPath(join(root, to), { code: 'LAYOUT_UNSAFE_PATH' });
    if (destinations.has(to)) fail('MIGRATION_CONFLICT', to);
    if (present(join(root, to))) {
      const bytes = Buffer.from(migratedReferenceBytes(root, { from, to }, entries, moves) ?? readFileSync(join(root, from)));
      if (!readFileSync(join(root, to)).equals(bytes) || (lstatSync(join(root, to)).mode & 0o777) !== (lstatSync(join(root, from)).mode & 0o777)) fail('MIGRATION_CONFLICT', to);
    }
    destinations.add(to);
  }
  planLayout(root, { migrating: true });
  const result = { moved: moves, layout: LAYOUT.directory, previousProducts: [...new Set(entries.filter(entry => entry.product).map(entry => entry.product))], previousLayouts: entries.filter(entry => entry.product).map(({product, collection, from}) => ({product, collection, directory: from})), requests_executed: 0 };
  if (dryRun) return { ...result, dry_run: true };
  const snapshots = new Map(moves.map(move => [move.from, readFileSync(join(root, move.from))]));
  const projected = projectedLayoutFiles(root, result);
  for (const {from,to} of moves) {
    // The complete preflight detects existing conflicts before any move. Check
    // again at each mutation: an earlier move must not grant a later symlink
    // replacement permission to redirect this migration outside the project.
    safeOutputPath(join(root, from), { code: 'LAYOUT_UNSAFE_PATH' });
    safeOutputPath(join(root, to), { code: 'LAYOUT_UNSAFE_PATH' });
    const { bytes, mode } = projected.get(to);
    if (present(join(root, to))) {
      if (!readFileSync(join(root, to)).equals(bytes) || (lstatSync(join(root, to)).mode & 0o777) !== mode) fail('MIGRATION_CONFLICT', to);
      continue;
    }
    mkdirSync(dirname(join(root, to)), {recursive:true});
    safeOutputPath(join(root, from), { code: 'LAYOUT_UNSAFE_PATH' });
    safeOutputPath(join(root, to), { code: 'LAYOUT_UNSAFE_PATH' });
    const temporary = join(root, `${to}.migration-${randomUUID()}`);
    let fd, created = false;
    try {
      safeOutputPath(temporary, { code: 'LAYOUT_UNSAFE_PATH' });
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
      created = true; fchmodSync(fd, mode); writeFileSync(fd, bytes); fsyncSync(fd); closeSync(fd); fd = undefined;
      // An exclusive link publishes the complete file without replacing a
      // destination created by another process between preflight and commit.
      safeOutputPath(join(root, to), { code: 'LAYOUT_UNSAFE_PATH' });
      try { linkSync(temporary, join(root, to)); }
      catch (error) { if (error.code === 'EEXIST') fail('MIGRATION_CONFLICT', to); throw error; }
    } finally { if (fd !== undefined) closeSync(fd); if (created && present(temporary)) unlinkSync(temporary); }
    safeOutputPath(join(root, to), { code: 'LAYOUT_UNSAFE_PATH' });
    if (!readFileSync(join(root, to)).equals(bytes)) fail('MIGRATION_READBACK_FAILED', to);
  }
  // Do not delete any source until every destination was read back. If a
  // source changed during the copy, preserve it and name the conflict.
  for (const {from} of moves) {
    safeOutputPath(join(root, from), { code: 'LAYOUT_UNSAFE_PATH' });
    if (!readFileSync(join(root, from)).equals(snapshots.get(from))) fail('MIGRATION_SOURCE_CHANGED', from);
  }
  for (const {from} of moves) {
    safeOutputPath(join(root, from), { code: 'LAYOUT_UNSAFE_PATH' });
    unlinkSync(join(root, from));
  }
  for (const path of obsolete) { safeOutputPath(join(root, path), { code: 'LAYOUT_UNSAFE_PATH' }); unlinkSync(join(root, path)); }
  for (const entry of entries) if (existsSync(join(root, entry.from)) && lstatSync(join(root, entry.from)).isDirectory()) removeEmptyTree(join(root, entry.from));
  ensureLayout(root);
  return result;
}
