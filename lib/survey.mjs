// Explicit survey I/O only. Snapshot readers never discover source or execute
// requests; raw change-detection material stays in ignored, private state.
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLI_NAME, CONTEXT_BASENAME } from './brand.mjs';
import { LAYOUT } from './layout.mjs';
import { stackCatalog, STACKS_DEFAULTS_FILE } from './stacks.mjs';
import { codeLocations, readCodeContext, withCodeLocations } from './code-locations.mjs';
import { createSourceScan, withSourceScan } from './source-scan.mjs';
import { upstreamUrls, upstreamCalls } from './audit.mjs';
import { storedOperationEntries } from './operation-context.mjs';
import { operationsFrom, parseYaml } from './context.mjs';
import { projectSurveySupplies } from './survey-flows.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { SURVEY_LIMITS, createSurveySnapshot, validateSurvey, canonicalSurveyJson, querySurveySnapshot,
  safeSurveyText, surveyId, surveyStructuralDigest, surveyStatusSummary } from './survey-model.mjs';
import { renderSurveyDot, renderSurveyHtml } from './survey-render.mjs';

export const SURVEY_FILE = join(LAYOUT.directory, 'graph', 'survey.json').split(sep).join('/');
const MAX_INPUTS = 30000, MAX_INPUT_BYTES = 16 * 1024 * 1024;
const portable = value => value.split(sep).join('/');
const inside = (root, file) => { const path = relative(root, file); return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`); };
const rawHash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
// Structural graph arrays are sets of declarations/references, not execution
// order. Canonicalize them before hashing independently of host collation.
const structuralOrder = value => Array.isArray(value) ? value.map(structuralOrder).sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)))
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, structuralOrder(value[key])])) : value;
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const nowAt = now => new Date(now ?? Date.now()).toISOString();
const safePath = value => safeSurveyText(value, { path: true });
const safeOperation = value => typeof value === 'string' && /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) \/[^\s?#]*$/u.test(value)
  && safeSurveyText(value) && safeSurveyText(value.slice(value.indexOf(' ') + 1), { route: true });
const errorDiagnostic = error => ({ code: /^SURVEY_[A-Z_]+$/u.test(error?.code ?? '') ? error.code : 'SURVEY_READ_FAILED',
  message: 'The survey could not be read or validated. Preserve it and regenerate explicitly after inspecting local inputs.' });

function paths(root, { file, out, stateDir } = {}) {
  const path = resolve(root, out ?? file ?? SURVEY_FILE), state = resolve(root, stateDir ?? join(LAYOUT.evidence, 'survey'));
  const key = createHash('sha256').update(path).digest('hex').slice(0, 24);
  return { path, state, baseline: join(state, `${key}.inputs.json`), status: join(state, `${key}.status.json`),
    outputs: join(state, `${key}.outputs.json`), lock: join(state, `${key}.lock`) };
}
function localBytes(file, max = SURVEY_LIMITS.bytes) {
  safeOutputPath(file, { code: 'SURVEY_UNSAFE_PATH' });
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('SURVEY_UNSAFE_PATH', 'Survey input must be a regular, single-link file.');
    if (stat.size > max) fail('SURVEY_BOUNDS', 'Survey input exceeds its supported byte limit.');
    const bytes = Buffer.alloc(stat.size + 1); let count = 0;
    while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
    if (count !== stat.size) fail('SURVEY_INPUT_CHANGED', 'Survey input changed during its read.');
    return bytes.subarray(0, count);
  } finally { if (fd !== undefined) closeSync(fd); }
}
function privateJson(file) { try { return JSON.parse(localBytes(file, MAX_INPUT_BYTES).toString('utf8')); } catch { return null; } }
function ensurePrivateState(directory, root) {
  if (root && inside(directory, root)) fail('SURVEY_STATE_OVERLAP', 'Private survey state must not encompass the source repository.');
  safeOutputPath(directory, { directory: true, code: 'SURVEY_UNSAFE_PATH' });
  if (existsSync(directory) && readdirSync(directory).some(name => name !== '.gitignore' && !/^[a-f0-9]{24}\.(?:(?:inputs|status|outputs)\.json|lock)$/u.test(name)))
    fail('SURVEY_STATE_NOT_PRIVATE', 'The selected state directory contains unrelated files; choose a dedicated private directory.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const ignore = join(directory, '.gitignore'), rule = '*\n!.gitignore\n';
  let previous = ''; try { previous = localBytes(ignore, 65536).toString('utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!previous.endsWith(rule)) writeOutputFileAtomic(ignore, `${previous}${previous && !previous.endsWith('\n') ? '\n' : ''}${rule}`,
    { mode: 0o600, code: 'SURVEY_UNSAFE_PATH' });
}
function writePrivate(file, value, root) {
  ensurePrivateState(resolve(file, '..'), root);
  writeOutputFileAtomic(file, `${JSON.stringify(value)}\n`, { mode: 0o600, code: 'SURVEY_UNSAFE_PATH' });
}
function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024, timeout: 5000 }).trimEnd(); }
  catch { return null; }
}
function gitState(root, eligible, excluded) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']), status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const dirty = { tracked: 0, untracked: 0, eligible_untracked: 0 };
  if (status !== null) {
    const rows = status.split('\0');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]; if (!row) continue;
      const state = row.slice(0, 2), file = row.slice(3), absolute = resolve(root, file);
      if (/[RC]/u.test(state)) i++;
      if (excluded.some(path => inside(path, absolute))) continue;
      if (state === '??') { dirty.untracked++; if (eligible.has(file)) dirty.eligible_untracked++; }
      else dirty.tracked++;
    }
  }
  return { base_commit: /^[a-f0-9]{40,64}$/u.test(head ?? '') ? head : null, git_state: head === null || status === null ? 'unavailable' : 'available', dirty };
}
function scannerIdentity() {
  const names = ['survey.mjs', 'survey-model.mjs', 'survey-flows.mjs', 'code-locations.mjs', 'source-scan.mjs', 'audit.mjs',
    'brand.mjs', 'layout.mjs', 'stacks.mjs', 'config.mjs', 'context.mjs', 'http-operation-context.mjs', 'operation-context.mjs', 'key-sources.mjs'];
  return surveyStructuralDigest(names.map(name => [name, rawHash(localBytes(fileURLToPath(new URL(name, import.meta.url)), MAX_INPUT_BYTES))]));
}

function collect(root, options, destinations) {
  const catalog = stackCatalog(root);
  if (catalog.problems.length) fail('SURVEY_CONFIGURATION_INVALID', 'A stack configuration is damaged or unsupported; the existing survey was preserved.');
  const excluded = [destinations.path, destinations.state, resolve(root, LAYOUT.mapOutput), resolve(root, LAYOUT.viewOutput)], credentialFiles = new Set();
  for (const row of privateJson(destinations.outputs)?.outputs ?? []) {
    if (!object(row) || typeof row.file !== 'string' || typeof row.digest !== 'string') continue;
    const file = resolve(root, row.file);
    try { if (rawHash(localBytes(file, SURVEY_LIMITS.bytes * 8)) === row.digest) excluded.push(file); } catch { /* changed or missing output is not trusted */ }
  }
  // An explicitly named credential file is never source, even without the
  // broader --exclude-env policy for ordinary .env binding discovery.
  for (const row of catalog.stacks) for (const env of Object.values(row.document.environments))
    if (typeof env.envFile === 'string') credentialFiles.add(resolve(row.folder, env.envFile));
  {
    // Legacy files can name credential files with ordinary source extensions.
    // Inspect configuration only, before a source scanner can open those files.
    if (!catalog.stacks.length) {
      const legacy = privateJson(resolve(root, LAYOUT.environments));
      for (const env of Object.values(legacy?.environments ?? {})) if (typeof env?.envFile === 'string')
        credentialFiles.add(resolve(root, env.envFile));
      for (const host of Object.values(legacy?.hosts ?? {})) if (typeof host?.envFile === 'string')
        credentialFiles.add(resolve(root, host.envFile));
    }
  }
  excluded.push(...credentialFiles);
  const scan = createSourceScan(root, { includeFixtures: options.includeFixtures, diagnostics: true, excludeFiles: excluded,
    excludeEnvironmentFiles: options.excludeEnv });
  const rawInputs = { source: new Map(), configuration: new Map(), observations: new Map() }, inputRows = new Map(), omissions = [], limitations = [];
  let withheld = 0, incomplete = false;
  const remember = (file, kind, text) => {
    const path = portable(relative(root, file)), state = text === null ? existsSync(file) ? 'unavailable' : 'missing' : 'read';
    rawInputs[kind].set(path, text === null ? state : rawHash(text));
    if (safePath(path)) inputRows.set(`${kind}:${path}`, { file: path, kind, state }); else withheld++;
    if (state === 'unavailable') incomplete = true;
  };
  const read = (file, kind = 'configuration', maxBytes = MAX_INPUT_BYTES) => {
    file = resolve(root, file);
    if (!inside(root, file)) { incomplete = true; omissions.push({ kind, reason: 'input-outside-repository', count: 1 }); return null; }
    const text = scan.read(file, { maxBytes }); remember(file, kind, text); return text;
  };
  const json = (file, kind = 'configuration', optional = true) => {
    const text = read(file, kind); if (text === null) return null;
    try { return JSON.parse(text); }
    catch { incomplete = true; omissions.push({ kind, reason: 'input-malformed', count: 1 });
      if (!optional) fail('SURVEY_INPUT_INVALID', 'A required input is malformed; the existing survey was preserved.'); return null; }
  };
  const configRows = [], retained = [], suites = [], operatorBindings = [], contractOperations = new Map();
  const legacyDoc = !catalog.stacks.length ? json(LAYOUT.environments) : null;
  const legacyName = legacyDoc?.default, legacyEnv = legacyDoc?.environments?.[legacyName];
  const legacyConfig = legacyEnv ? { name: legacyName, baseUrl: legacyEnv.baseUrl, baseUrlSource: 'config',
    ...(typeof legacyEnv.contract === 'string' ? { contract: resolve(root, legacyEnv.contract) } : {}), contractPathPrefix: legacyEnv.contractPathPrefix } : {};
  if (!catalog.stacks.length && Object.keys(legacyDoc?.environments ?? {}).length > 1)
    limitations.push('Legacy code matching uses only the explicitly declared default environment; named stacks retain every environment.');
  for (const path of [STACKS_DEFAULTS_FILE, LAYOUT.defaults, LAYOUT.marker, LAYOUT.graphManifest]) if (existsSync(resolve(root, path))) {
    const value = json(path);
    if (path === LAYOUT.graphManifest && Array.isArray(value?.operator_bindings))
      operatorBindings.push(...value.operator_bindings.slice(0, 10000).map(row => ({ ...row, file: path })));
  }
  const stackRows = catalog.stacks.map(row => ({ name: row.name, folder: row.folder, document: row.document, file: row.file,
    context: join(row.relativeFolder, CONTEXT_BASENAME) }));
  if (!stackRows.length) stackRows.push({ name: 'legacy', folder: root, document: { environments: legacyEnv ? { [legacyName]: legacyEnv } : {},
    ...(legacyConfig.contract ? { contract: portable(relative(root, legacyConfig.contract)) } : {}) }, context: LAYOUT.context });
  const contexts = new Map();
  for (const row of stackRows) {
    if (row.file) read(row.file);
    const contextsRaw = json(row.context, 'observations'); contexts.set(row.name, contextsRaw);
    if (contextsRaw) try { retained.push({ stack: row.name, file: portable(row.context), entries: storedOperationEntries(contextsRaw), evidenceAvailability: new Map() }); }
    catch { incomplete = true; omissions.push({ kind: 'observations', reason: 'retained-context-damaged', count: 1 }); }
    const contracts = new Set([row.document.contract, ...Object.values(row.document.environments).map(env => env.contract)].filter(Boolean));
    for (const contract of contracts) {
      const file = resolve(row.folder, contract), text = read(file);
      if (text !== null) try {
        const doc = /^\s*[\[{]/u.test(text) ? JSON.parse(text) : parseYaml(text);
        contractOperations.set(file, new Set(operationsFrom(doc).map(row => row.op)));
      } catch { incomplete = true; omissions.push({ kind: 'contract', reason: 'contract-unreadable', count: 1 }); }
    }
    for (const [name, env] of Object.entries(row.document.environments)) {
      const path = env.contract ?? row.document.contract;
      configRows.push({ stack: row.name, environment: name, baseUrl: env.baseUrl, contract: path ? portable(relative(root, resolve(row.folder, path))) : null,
        prefix: env.contractPathPrefix ?? '' });
    }
  }
  const suiteRoot = resolve(root, LAYOUT.suites);
  const walkSuites = (directory, depth = 0) => {
    if (depth > 4 || suites.length >= 1000) { incomplete = true; omissions.push({ kind: 'suite', reason: 'suite-scan-limit', extent: 'unknown', count: 1 }); return; }
    let entries; try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      if (error.code !== 'ENOENT') { incomplete = true; omissions.push({ kind: 'suite', reason: 'suite-directory-unreadable', extent: 'unknown', count: 1 }); } return; }
    for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) walkSuites(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.json')) {
        const suite = json(file, 'observations'); if (suite) suites.push({ file: portable(relative(root, file)), suite });
      } else if (entry.isSymbolicLink()) { incomplete = true; omissions.push({ kind: 'suite', reason: 'suite-symlink-excluded', count: 1 }); }
    }
  };
  walkSuites(suiteRoot);
  for (const store of retained) for (const item of store.entries) for (const link of item.entry.key_sources ?? []) {
    const file = join(root, LAYOUT.evidence, ...(store.stack === 'legacy' ? [] : [store.stack]), `${link.evidence.run_id}.json`);
    const bytes = read(file, 'observations', 2 * 1024 * 1024);
    store.evidenceAvailability.set(link.evidence.run_id, bytes === null ? 'unavailable' : rawHash(bytes) === link.evidence.digest ? 'matching' : 'changed');
  }
  const detectedOmissions = [];
  const model = withSourceScan(scan, () => withCodeLocations(root, () => {
    for (const row of stackRows) readCodeContext(root, row.name === 'legacy' ? null : row.name, () => {
      const ctx = contexts.get(row.name);
      return ctx && object(ctx.operations) ? { state: 'healthy', snapshot: { ctx } } : { state: 'missing', snapshot: null };
    });
    return { code: codeLocations(root), refs: upstreamUrls(root, null, { omissions: detectedOmissions }) };
  }, { legacyConfig }));
  const inventory = scan.inventory(), eligible = inventory.entries.filter(row => row.eligible);
  if (eligible.length > MAX_INPUTS) { incomplete = true; omissions.push({ kind: 'source', reason: 'input-inventory-limit', count: eligible.length - MAX_INPUTS }); }
  for (const row of eligible.slice(0, MAX_INPUTS)) if (!rawInputs.configuration.has(row.path)) read(row.file, 'source', 400000);
  for (const row of inventory.omissions) {
    if (row.reason === 'explicitly-excluded') continue;
    if (['depth-limit', 'unreadable', 'symlink-excluded', 'special-file'].includes(row.reason)) incomplete = true;
    omissions.push({ kind: row.kind, reason: row.reason, extent: row.extent, count: 1,
      ...(safePath(row.path) ? { file: row.path } : {}) });
  }
  for (const row of inventory.entries) if (!row.eligible && !['unsupported-extension', 'symlink-excluded'].includes(row.status)
    && (row.status !== 'explicitly-excluded' || credentialFiles.has(row.file))) {
    omissions.push({ kind: 'file', reason: credentialFiles.has(row.file) ? 'credential-file-excluded' : row.status, count: 1,
      ...(safePath(row.path) ? { file: row.path } : {}) });
  }
  for (const row of detectedOmissions) omissions.push({ kind: 'source', reason: row.code, count: 1,
    ...(safePath(row.file) ? { file: row.file } : {}) });
  const nodes = new Map(), edges = new Map(), unresolved = [], opBindings = [], operationNodes = new Map();
  const addNode = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); return nodes.get(node.id); };
  const fileNode = (file, state = 'current') => {
    if (!safePath(file) || file === 'withheld') { withheld++; return null; }
    return addNode({ id: surveyId('file', [file]), kind: 'file', label: file, file, state });
  };
  const reference = raw => {
    if (!safePath(raw.file) || raw.file === 'withheld') { withheld++; return null; }
    const value = { file: raw.file, ...(Number.isSafeInteger(raw.line) && raw.line > 0 ? { line: raw.line } : {}),
      kind: raw.kind ?? 'binding', state: raw.state ?? 'current' };
    if (typeof raw.code_path === 'string' && safeSurveyText(raw.code_path)
      && safeSurveyText(raw.code_path.split(/[?#]/u)[0], { route: true })) value.code_path = raw.code_path.split(/[?#]/u)[0];
    if (Array.isArray(raw.environments)) value.environments = raw.environments.filter(value => safeSurveyText(value));
    return value;
  };
  const relationship = (kind, from, to, support, scope) => {
    if (!from || !to || !support) return;
    const id = surveyId(kind, [from.id, to.id, scope ?? null]);
    if (!edges.has(id)) edges.set(id, { id, kind, from: from.id, to: to.id, ...(scope ? { scope } : {}), declarations: [], observations: [], operator_attributions: [] });
    const list = edges.get(id).declarations;
    if (!list.some(row => JSON.stringify(row) === JSON.stringify(support))) list.push(support);
  };
  const callLocationKey = raw => `${raw.file}\0${raw.line ?? ''}\0${raw.code_path ?? ''}`;
  const matchedCalls = new Set();
  for (const [codeStack, stack] of Object.entries(model.code.stacks)) {
    const name = codeStack || 'legacy'; if (!safeSurveyText(name)) { withheld++; continue; }
    for (const [operation, code] of Object.entries(stack.operations)) {
      if (!safeOperation(operation)) { withheld++; continue; }
      const op = addNode({ id: surveyId('operation', [name, operation]), kind: 'operation', label: operation, operation, stack: name, references: [] });
      operationNodes.set(`${name}\0${operation}`, op);
      const bindings = configRows.filter(row => row.stack === name);
      for (const binding of bindings) if (safeSurveyText(binding.environment) && safeSurveyText(binding.baseUrl, { url: true })
        && (!binding.contract || contractOperations.get(resolve(root, binding.contract))?.has(operation)))
        opBindings.push({ id: op.id, stack: name, operation, provider: binding.baseUrl, environment: binding.environment });
      if (!bindings.length) opBindings.push({ id: op.id, stack: name, operation });
      for (const raw of [...code.defined_in, ...code.called_from]) {
        const ref = reference(raw); if (!ref) continue;
        op.references.push(ref); const file = fileNode(ref.file, raw.state === 'not-found' ? 'not found at the working tree' : raw.state);
        if (raw.state !== 'current') continue;
        const kind = code.called_from.includes(raw) && raw.kind === 'request' ? 'calls' : raw.kind === 'definition' ? 'defines' : null;
        if (kind) relationship(kind, file, op, { ...ref, kind: 'declared-by-code', contract_path: operation.split(' ').slice(1).join(' ') });
        if (kind === 'calls') matchedCalls.add(callLocationKey(raw));
      }
    }
  }
  for (const row of configRows) if (row.contract && safePath(row.contract))
    addNode({ id: surveyId('contract', [row.contract]), kind: 'contract', label: row.contract, contract: row.contract });
  const targets = new Map();
  for (const ref of model.refs) {
    if (!safeSurveyText(ref.hostPort, { host: true })) { withheld++; continue; }
    targets.set(ref.hostPort, true);
    const host = addNode({ id: surveyId('host', [ref.hostPort]), kind: 'host', label: ref.hostPort, host: ref.hostPort, references: [] });
    for (const raw of ref.locations ?? [ref]) {
      const value = reference(raw); if (!value) continue; host.references.push(value); fileNode(value.file);
    }
  }
  const rawCalls = withSourceScan(scan, () => upstreamCalls(root, targets));
  for (const [hostName, calls] of rawCalls) {
    const host = nodes.get(surveyId('host', [hostName])); if (!host) continue;
    for (const call of calls) for (const raw of call.locations ?? [call]) {
      if (raw.kind !== 'request' || matchedCalls.has(callLocationKey(raw))) continue;
      const ref = reference(raw);
      relationship('calls', ref && fileNode(ref.file), host, ref && { ...ref, kind: 'declared-by-code' });
      unresolved.push({ kind: 'call', reason: 'no-unique-bound-operation', ...(ref ? { file: ref.file, ...(ref.line ? { line: ref.line } : {}) } : {}), host: hostName });
    }
  }
  for (const [kind, rows] of Object.entries(model.code.unmatched)) for (const row of rows) {
    const value = { kind, reason: row.reason };
    for (const key of ['file', 'stack', 'operation', 'host', 'path', 'state']) {
      if (!row[key]) continue;
      const safe = key === 'operation' ? safeOperation(row[key]) : safeSurveyText(row[key],
        key === 'file' ? { path: true } : key === 'path' ? { route: true } : key === 'host' ? { host: true } : undefined);
      if (safe && row[key] !== 'withheld') value[key] = row[key];
      else withheld++;
    }
    if (row.line) value.line = row.line;
    unresolved.push(value); if (value.file) fileNode(value.file, value.state);
  }
  const flows = projectSurveySupplies({ operations: opBindings, retainedEntries: retained, suites, operatorBindings });
  for (const edge of flows.relationships) { const id = surveyId('supplies', [edge.from, edge.to, edge.source_field, edge.target_parameter, edge.scope]); edges.set(id, { id, ...edge }); }
  unresolved.push(...flows.unresolved.map(row => ({ kind: 'supplies', ...row })));
  const reasons = {}; for (const row of unresolved) reasons[row.reason] = (reasons[row.reason] ?? 0) + (row.count ?? 1);
  const safeConfigs = configRows.flatMap(row => safeSurveyText(row.stack) && safeSurveyText(row.environment)
    && safeSurveyText(row.baseUrl, { url: true }) && (!row.contract || safePath(row.contract)) && safeSurveyText(row.prefix || '/', { route: true }) ? [row] : []);
  if (safeConfigs.length !== configRows.length) withheld += configRows.length - safeConfigs.length;
  const reads = scan.readDiagnostics(), sourceReads = reads.filter(row => rawInputs.source.has(row.path));
  // Different readers can inspect the same file under different byte limits.
  // Each outcome dimension counts files, not attempts. A file can be readable
  // by the contract reader but oversized for source analysis: retain both
  // outcomes so partial source inspection cannot silently become complete.
  const sourceFileCount = predicate => new Set(sourceReads.filter(predicate).map(row => row.path)).size;
  const currentGit = gitState(root, new Set(eligible.map(row => row.path)), excluded);
  const scannerConfig = { include_fixtures: Boolean(options.includeFixtures), exclude_env: Boolean(options.excludeEnv), excluded_files: excluded
    .map(file => portable(relative(root, file))).filter(file => safePath(file)).sort() };
  const scanner = { identity: scannerIdentity(), config_identity: surveyStructuralDigest({ include_fixtures: scannerConfig.include_fixtures,
    exclude_env: scannerConfig.exclude_env, exclusion_policy: 'explicit-generated-and-private-v1' }), config: scannerConfig };
  const excludedPrivate = Boolean(options.excludeEnv || credentialFiles.size);
  if (excludedPrivate) limitations.push('Credential environment files were deliberately excluded; their current state is unavailable.');
  if (withheld) limitations.push('Unsafe structural metadata was withheld before identities and serialization.');
  const structural = { nodes: [...nodes.values()], relationships: [...edges.values()].filter(edge => edge.kind !== 'supplies'), inventory: [...inputRows.values()].filter(row => row.kind === 'source') };
  const source = { ...currentGit, structural_identity: surveyStructuralDigest(structuralOrder(structural)), configuration_identity: surveyStructuralDigest(structuralOrder(safeConfigs)),
    observation_identity: surveyStructuralDigest(structuralOrder(flows.inputStructures)), inventory: [...inputRows.values()], limitations };
  const coverage = { supported_patterns: ['existing conservative CODE-1 route and HTTP request patterns', 'literal host/config references', 'retained key-source links', 'suite capture placeholders'],
    languages: ['JavaScript/TypeScript', 'Python', 'Ruby', 'Go', 'JSON/YAML/TOML/env bindings'], eligible_files: eligible.length,
    scanned_files: sourceFileCount(row => row.status === 'read'), skipped_files: sourceFileCount(row => row.status !== 'read'),
    unreadable_files: sourceFileCount(row => !['read', 'oversized'].includes(row.status)),
    oversized_files: sourceFileCount(row => row.status === 'oversized'), truncated: incomplete,
    omissions, unresolved_by_reason: reasons, withheld: { metadata: withheld }, flow: flows.coverage };
  const privateInputs = Object.fromEntries(Object.entries(rawInputs).map(([kind, rows]) => [kind, [...rows].sort(([a], [b]) => compare(a, b))]));
  const privateIdentity = surveyStructuralDigest({ ...privateInputs, scanner: scanner.identity, config: scanner.config_identity });
  const unavailableProofs = flows.relationships.flatMap(edge => edge.observations).filter(row => row.proof.state !== 'matching').length;
  return { content: { nodes: [...nodes.values()], relationships: [...edges.values()], unresolved, coverage, source, scanner },
    privateInputs, privateIdentity, incomplete, unavailableProofs, excludedPrivate,
    scanStats: Object.fromEntries(Object.entries(scan.stats).filter(([, value]) => Number.isSafeInteger(value))) };
}

export function readSurvey(root, options = {}) {
  const target = paths(root, options);
  try {
    const snapshot = validateSurvey(JSON.parse(localBytes(target.path).toString('utf8')));
    const summary = surveyStatusSummary(privateJson(target.status), snapshot.snapshot.id);
    return { state: 'ready', snapshot, ...(summary.state !== 'not-checked' ? { status: { snapshot_id: snapshot.snapshot.id, ...summary } } : {}) };
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'not-generated', command: `${CLI_NAME} survey generate` };
    return { state: 'invalid', diagnostic: errorDiagnostic(error) };
  }
}

export function generateSurvey(root, options = {}) {
  root = resolve(root); const target = paths(root, options);
  safeOutputPath(target.path, { code: 'SURVEY_UNSAFE_PATH' }); safeOutputPath(target.state, { directory: true, code: 'SURVEY_UNSAFE_PATH' });
  ensurePrivateState(target.state, root); let lock;
  try {
    try { lock = openSync(target.lock, 'wx', 0o600); } catch { fail('SURVEY_WRITE_LOCKED', 'Another survey generation owns this output; retry after it completes.'); }
    const existing = readSurvey(root, { file: target.path, stateDir: target.state });
    if (existing.state === 'invalid') fail('SURVEY_DESTINATION_INVALID', 'The existing destination is not a valid survey; it was not overwritten.');
    const collected = collect(root, options, target), previous = privateJson(target.baseline);
    if (existing.state === 'ready' && previous?.snapshot_id === existing.snapshot.snapshot.id && previous.identity === collected.privateIdentity)
      return { state: 'unchanged', path: target.path, snapshot: existing.snapshot, ...(existing.status ? { status: existing.status } : {}), diagnostics: collected.scanStats };
    if (collected.content.source.inventory.some(row => resolve(root, row.file) === target.path))
      fail('SURVEY_DESTINATION_INPUT', 'The output destination is a survey input; no file was replaced.');
    const snapshot = createSurveySnapshot(collected.content, { now: nowAt(options.now) });
    const bytes = canonicalSurveyJson(snapshot);
    writePrivate(target.baseline, { v: 1, snapshot_id: snapshot.snapshot.id, identity: collected.privateIdentity, inputs: collected.privateInputs,
      scanner: snapshot.scanner.identity, config: snapshot.scanner.config_identity }, root);
    const beforeWrite = readSurvey(root, { file: target.path, stateDir: target.state });
    if (beforeWrite.state !== existing.state || beforeWrite.snapshot?.snapshot.id !== existing.snapshot?.snapshot.id)
      fail('SURVEY_DESTINATION_CHANGED', 'The survey destination changed during generation; it was not replaced.');
    writeOutputFileAtomic(target.path, bytes, { mkdir: true, mode: 0o644, code: 'SURVEY_UNSAFE_PATH' });
    return { state: 'generated', path: target.path, snapshot, diagnostics: collected.scanStats };
  } finally { if (lock !== undefined) { closeSync(lock); try { unlinkSync(target.lock); } catch { /* preserve generation result */ } } }
}

export function surveyStatus(root, options = {}) {
  root = resolve(root); const target = paths(root, options), saved = readSurvey(root, options);
  if (saved.state !== 'ready') return saved;
  const snapshot = saved.snapshot, checked_at = nowAt(options.now), baseline = privateJson(target.baseline);
  let current;
  try { current = collect(root, { includeFixtures: snapshot.scanner.config.include_fixtures, excludeEnv: snapshot.scanner.config.exclude_env }, target); }
  catch {
    const status = { checked_at, snapshot_id: snapshot.snapshot.id, state: 'unknown', source: { state: 'unknown', reason: 'current-inputs-unavailable' },
      observations: { state: 'unknown', reason: 'current-inputs-unavailable' }, base_commit: { state: 'unavailable' } };
    writePrivate(target.status, status, root); return status;
  }
  const comparable = baseline?.snapshot_id === snapshot.snapshot.id && baseline?.inputs;
  const changed = kind => comparable && surveyStructuralDigest(baseline.inputs[kind]) !== surveyStructuralDigest(current.privateInputs[kind]);
  const sourceChanged = changed('source') || changed('configuration') || baseline?.scanner !== current.content.scanner.identity || baseline?.config !== current.content.scanner.config_identity;
  const source = { state: !comparable ? 'unknown' : sourceChanged ? 'stale' : current.incomplete || current.excludedPrivate ? 'unknown' : 'current',
    comparison: comparable ? 'local-input-baseline' : 'safe-structural-only', structural_state: current.content.source.structural_identity === snapshot.source.structural_identity ? 'same' : 'changed',
    configuration_state: current.content.source.configuration_identity === snapshot.source.configuration_identity ? 'same' : 'changed',
    dirty: current.content.source.dirty,
    ...(!comparable ? { reason: 'private-input-baseline-unavailable' } : {}) };
  const observations = { state: !comparable ? 'unknown' : changed('observations') ? 'stale' : current.unavailableProofs || current.incomplete ? 'unknown' : 'current',
    unavailable_proofs: current.unavailableProofs, structural_state: current.content.source.observation_identity === snapshot.source.observation_identity ? 'same' : 'changed' };
  const availableBase = snapshot.source.base_commit && git(root, ['cat-file', '-e', `${snapshot.source.base_commit}^{commit}`]) !== null;
  const base_commit = { state: availableBase ? 'available' : 'unavailable', comparison: 'not-git-relative',
    ...(current.content.source.base_commit ? { current_head: current.content.source.base_commit } : {}) };
  const state = [source.state, observations.state].includes('stale') ? 'stale' : source.state === 'current' && observations.state === 'current' && availableBase ? 'current' : 'unknown';
  const status = { checked_at, snapshot_id: snapshot.snapshot.id, state, source, observations, base_commit };
  writePrivate(target.status, status, root); return status;
}

export function querySurvey(root, options = {}) {
  const saved = readSurvey(root, options); if (saved.state !== 'ready') return saved;
  return querySurveySnapshot(saved.snapshot, { ...options, status: saved.status });
}

/** Register only a byte-exact projection, never an arbitrary input exclusion. */
export function registerSurveyRender(root, options = {}) {
  root = resolve(root);
  const sourceOptions = { file: options.file, stateDir: options.stateDir };
  const target = paths(root, sourceOptions), saved = readSurvey(root, sourceOptions);
  if (saved.state !== 'ready' || !['json', 'dot', 'html'].includes(options.format) || typeof options.out !== 'string')
    fail('SURVEY_RENDER_INVALID', 'Only an existing validated survey projection can be registered.');
  const file = resolve(root, options.out);
  if (file === target.path) fail('SURVEY_RENDER_INPUT_COLLISION', 'A projection cannot replace its source survey.');
  const expected = options.format === 'json' ? canonicalSurveyJson(saved.snapshot) : options.format === 'dot'
    ? renderSurveyDot(saved.snapshot, { status: saved.status }) : renderSurveyHtml(saved.snapshot, { status: saved.status });
  const actual = localBytes(file, SURVEY_LIMITS.bytes * 8);
  if (actual.toString('utf8') !== expected) fail('SURVEY_RENDER_CHANGED', 'The output is not the byte-exact survey projection; it was not excluded from discovery.');
  const previous = privateJson(target.outputs), rows = Array.isArray(previous?.outputs) ? previous.outputs : [];
  const path = portable(relative(root, file));
  const outputs = rows.filter(row => object(row) && typeof row.file === 'string' && row.file !== path && typeof row.digest === 'string').slice(-999);
  outputs.push({ file: path, digest: rawHash(actual), format: options.format });
  writePrivate(target.outputs, { v: 1, outputs }, root);
  return { state: 'registered', outputs: outputs.length };
}
