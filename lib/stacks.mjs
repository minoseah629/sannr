// One disk-backed resolver for requests and knowledge. Nothing here executes an
// API call, loads credential values, or mutates process.env.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, openSync, closeSync, constants, fstatSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep, posix } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { LAYOUT, LEGACY_LAYOUT } from './layout.mjs';
import { CONTEXT_BASENAME, POINTER_CLI_NAME, PROSE_PRODUCT_TITLE, FEEDBACK_STACK_NAME, FEEDBACK_BASE_URL, FEEDBACK_ASSET_DIRECTORY } from './brand.mjs';
import { parseAuthReference } from './auth-reference.mjs';
import { scanMetadataSecrets } from './verdicts.mjs';
import { CREDENTIAL_SHAPED_HEADER, SECRET_HEADERS } from './curl.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { resolveDefaults } from './config-defaults.mjs';

export const STACK_CONFIG_BASENAME = 'stack.json';
export const STACKS_DEFAULTS_FILE = posix.join(LAYOUT.directory, 'defaults.json');
export const STACK_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STACK_KEYS = new Set(['v', 'name', 'title', 'default_environment', 'contract', 'environments', 'cli', 'mcp']);
const ENVIRONMENT_KEYS = new Set(['baseUrl', 'auth', 'envFile', 'production', 'contract', 'contractPathPrefix', 'headers', 'variables', 'concurrency', 'tokenUrl', 'scope']);
const DEFAULT_KEYS = new Set(['default_stack', 'budget', 'timeoutMs', 'concurrency', 'evidenceDir', 'staleDays', 'feedback']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const portable = value => value.split(sep).join('/');
const fail = (code, message, details = {}, next) => { throw Object.assign(new Error(message), { code, details, ...(next ? { next } : {}) }); };
const problem = error => ({ code: error.code ?? 'STACK_INVALID', message: error.message, ...(error.details ? { details: error.details } : {}), ...(error.next ? { next: error.next } : {}) });
const contains = (root, path) => { const part = relative(resolve(root), resolve(path)); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };
const safe = (path, directory = false) => {
  try { safeOutputPath(path, { directory, code: 'STACK_UNSAFE_PATH' }); }
  catch { fail('STACK_UNSAFE_PATH', 'A stack path must be a regular file or real directory inside the project.'); }
};
function present(path) { try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
function inputContractPath(root, input) {
  const source = resolve(root,input);
  if (contains(root,source)) return source;
  // A host may supply /var/... while Git reports /private/var/.... Rebase only
  // the project ancestor; resolving the whole file would conceal links inside
  // the repository from the regular-file and ancestor checks below.
  for (let ancestor=dirname(source);; ancestor=dirname(ancestor)) {
    try {
      if (realpathSync(ancestor) === realpathSync(root)) return resolve(root,relative(ancestor,source));
    } catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
    if (dirname(ancestor) === ancestor) break;
  }
  fail('STACK_CONTRACT_OUTSIDE_PROJECT','The input contract must be inside the project before it is copied into a stack.');
}
function readBounded(path, max, code, kind) {
  safe(path);
  let fd;
  try {
    fd=openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat=fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) fail('STACK_UNSAFE_PATH', `${kind} must be a regular single-link file.`);
    if (stat.size > max) fail(code, `${kind} exceeds the supported size limit.`);
    const buffer=Buffer.alloc(Math.min(stat.size+1,max+1));
    let bytes=0;
    while(bytes < buffer.length) { const count=readSync(fd,buffer,bytes,buffer.length-bytes,null); if(!count) break; bytes+=count; }
    // Reject a source that grew during its read; never quietly copy a prefix.
    if (bytes > max || bytes > stat.size) fail(code, `${kind} exceeds the supported size limit or changed while reading.`);
    safe(path); const atPath=lstatSync(path);
    if (atPath.ino !== stat.ino || atPath.dev !== stat.dev) fail('STACK_UNSAFE_PATH', `${kind} changed while reading.`);
    return buffer.subarray(0,bytes);
  } finally { if(fd !== undefined) closeSync(fd); }
}
function readJson(path, kind) {
  try {
    const value = JSON.parse(readBounded(path,1024*1024,'STACK_CONFIG_LIMIT',kind).toString('utf8'));
    if (!object(value)) fail('STACK_CONFIG_INVALID', `${kind} must contain a JSON object.`);
    return value;
  } catch (error) {
    if (error.code?.startsWith('STACK_')) throw error;
    fail('STACK_CONFIG_INVALID', `${kind} could not be read as a JSON object.`);
  }
}
export function validStackName(name) { return typeof name === 'string' && STACK_NAME.test(name) && name !== 'suites'; }
function requireName(name) {
  if (!validStackName(name)) fail('STACK_NAME_INVALID', 'Stack names use 1–63 lowercase letters, digits or hyphens, beginning with a letter or digit; suites is reserved.');
}
function unknownKeys(value, allowed, location) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail('STACK_KEY_UNKNOWN', `Unknown key '${key}' in ${location}.`, { key, location });
}
function contractPath(root, folder, path) {
  if (path === undefined || path === '') return undefined;
  if (typeof path !== 'string' || isAbsolute(path) || path.startsWith('~/')) fail('STACK_CONTRACT_INVALID', 'Stack contract paths must be relative to their stack folder.');
  const target = resolve(folder, path);
  if (!contains(root, target)) fail('STACK_CONTRACT_OUTSIDE_PROJECT', 'The stack contract resolves outside the project.');
  safe(target); return target;
}
function validateUrl(value, where) {
  let url;
  try { url = new URL(value); } catch { fail('STACK_URL_INVALID', `${where} requires an absolute http or https URL.`); }
  if (typeof value !== 'string' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    fail('STACK_URL_INVALID', `${where} requires an absolute http or https URL without credentials, query or fragment.`);
  return url;
}
export function validateStackDocument(root, folder, name, document) {
  requireName(name); unknownKeys(document, STACK_KEYS, `stack '${name}'`);
  if (document.v !== 1 || document.name !== name) fail('STACK_CONFIG_INVALID', `Stack '${name}' requires v:1 and the matching name.`, { stack:name });
  if (document.title !== undefined && (typeof document.title !== 'string' || !document.title.trim() || document.title.length > 256)) fail('STACK_CONFIG_INVALID', `Stack '${name}' has an invalid title.`);
  if (!object(document.environments)) fail('STACK_CONFIG_INVALID', `Stack '${name}' requires an environments object.`);
  contractPath(root, folder, document.contract);
  for (const [environment, value] of Object.entries(document.environments)) {
    if (!ENVIRONMENT_NAME.test(environment) || !object(value)) fail('STACK_ENVIRONMENT_INVALID', `Stack '${name}' has an invalid environment entry.`);
    unknownKeys(value, ENVIRONMENT_KEYS, `environment '${environment}' in stack '${name}'`);
    validateUrl(value.baseUrl, `Stack '${name}' environment '${environment}' baseUrl`);
    if (value.auth !== undefined && value.auth !== '' && !parseAuthReference(value.auth)) fail('STACK_AUTH_INVALID', `Stack '${name}' environment '${environment}' auth must be an environment-variable reference.`);
    if (value.envFile !== undefined && (typeof value.envFile !== 'string' || !value.envFile)) fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' has an invalid envFile.`);
    if (value.production !== undefined && typeof value.production !== 'boolean') fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' production must be boolean.`);
    if (value.contractPathPrefix !== undefined && (typeof value.contractPathPrefix !== 'string' || !value.contractPathPrefix.startsWith('/') || /[?#]/.test(value.contractPathPrefix))) fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' has an invalid contractPathPrefix.`);
    if (value.concurrency !== undefined && (!Number.isFinite(value.concurrency) || value.concurrency < 1)) fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' has an invalid concurrency.`);
    for (const key of ['headers', 'variables']) if (value[key] !== undefined && !object(value[key])) fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' ${key} must be an object.`);
    for (const [header, headerValue] of Object.entries(value.headers ?? {})) {
      if (CREDENTIAL_SHAPED_HEADER.test(header) || SECRET_HEADERS.test(header)) fail('STACK_AUTH_INVALID', `Stack '${name}' environment '${environment}' declares a credential header; use its auth reference instead.`);
      if (typeof headerValue !== 'string') fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' headers must have string values.`);
    }
    if (value.tokenUrl !== undefined) validateUrl(value.tokenUrl, `Stack '${name}' environment '${environment}' tokenUrl`);
    if (value.scope !== undefined && typeof value.scope !== 'string') fail('STACK_CONFIG_INVALID', `Stack '${name}' environment '${environment}' scope must be a string.`);
    contractPath(root, folder, value.contract);
  }
  const names = Object.keys(document.environments);
  if (names.length && (!Object.hasOwn(document.environments, document.default_environment)))
    fail('STACK_DEFAULT_ENVIRONMENT_INVALID', `Stack '${name}' requires default_environment naming one of its environments.`, { available:names });
  if (!names.length && document.default_environment !== undefined) fail('STACK_DEFAULT_ENVIRONMENT_INVALID', `Stack '${name}' has no environments to select.`);
  const { cli, mcp, ...active } = document;
  try { scanMetadataSecrets(active, 'STACK_SECRET_LITERAL'); }
  catch { fail('STACK_SECRET_LITERAL', `Stack '${name}' contains a secret-shaped literal; use credential references.`); }
  return { name, folder, file:join(folder,STACK_CONFIG_BASENAME), relativeFolder:portable(relative(root,folder)), document, environmentNames:names };
}

// Bundled assets are read from this installation, never from a repository or a
// configurable search path. The physical asset name is a shipped prose surface;
// the runtime identity follows the brand seam used by the rest of the client.
const builtinFolder = fileURLToPath(new URL(`../${FEEDBACK_ASSET_DIRECTORY}/`, import.meta.url));
export const isBuiltinStack = name => name === FEEDBACK_STACK_NAME;
export function isBuiltinFeedbackTarget(path) {
  try {
    const url = new URL(path), base = new URL(FEEDBACK_BASE_URL);
    // Reserve the complete hostname, including alternate ports, HTTP and DNS
    // terminal-dot spellings. Encoded or proxy-normalized paths must never
    // reach this service through a less restrictive generic transport.
    return url.hostname.replace(/\.+$/, '') === base.hostname;
  } catch { return false; }
}
export function assertWritableStack(scope) {
  if (scope?.readOnly || isBuiltinStack(typeof scope === 'string' ? scope : scope?.stack))
    fail('STACK_READ_ONLY', `Stack '${FEEDBACK_STACK_NAME}' is packaged read-only; its knowledge and configuration cannot be changed.`);
}
function builtinRow(root) {
  const document = readJson(join(builtinFolder, STACK_CONFIG_BASENAME), 'The packaged feedback stack');
  // Only the pinned no-auth environment is admitted. Neither a repo stack with
  // this name nor ambient API_* configuration participates in its resolution.
  const pinned = { ...document, name: FEEDBACK_STACK_NAME, default_environment: 'public',
    contract: 'feedback.openapi.json', environments: { public: { baseUrl: FEEDBACK_BASE_URL } } };
  return { ...validateStackDocument(builtinFolder, builtinFolder, FEEDBACK_STACK_NAME, pinned),
    relativeFolder: portable(relative(root, builtinFolder)), builtin: true, readOnly: true };
}
function validateFeedbackDefaults(defaults) {
  if (!Object.hasOwn(defaults, 'feedback')) return;
  const value = defaults.feedback;
  if (!object(value) || Object.keys(value).some(key => key !== 'send')
      || value.send !== undefined && !['ask', 'allow', 'never'].includes(value.send))
    fail('FEEDBACK_POLICY_INVALID', 'feedback must contain only send: ask, allow or never.');
}

/** Every call reads the current files. Invalid siblings are named and cause
 * dispatch to fail closed; doctor can still list the complete catalog. */
export function stackCatalog(root, { includeBuiltin = false } = {}) {
  root = resolve(root);
  const catalog = { root, stacks:[], defaults:{}, problems:[], notes:[] };
  const finish = () => { if (includeBuiltin) catalog.stacks.push(builtinRow(root)); return catalog; };
  const defaultsFile = join(root, STACKS_DEFAULTS_FILE);
  if (present(defaultsFile)) try {
    catalog.defaults = readJson(defaultsFile, STACKS_DEFAULTS_FILE);
    unknownKeys(catalog.defaults, DEFAULT_KEYS, STACKS_DEFAULTS_FILE);
    if (catalog.defaults.default_stack !== undefined) {
      requireName(catalog.defaults.default_stack);
      if (isBuiltinStack(catalog.defaults.default_stack)) fail('STACK_DEFAULT_READ_ONLY', 'A packaged read-only stack cannot be the repository default.');
    }
    validateFeedbackDefaults(catalog.defaults);
    scanMetadataSecrets(catalog.defaults, 'STACK_SECRET_LITERAL');
  } catch (error) { catalog.problems.push(problem(error)); }
  const base = join(root, LAYOUT.collection);
  if (!existsSync(base)) return finish();
  try {
    safe(base, true);
    for (const entry of readdirSync(base, { withFileTypes:true }).sort((a,b)=>a.name.localeCompare(b.name))) {
      const folder = join(base, entry.name), file = join(folder, STACK_CONFIG_BASENAME);
      if (isBuiltinStack(entry.name)) {
        catalog.notes.push({ code: 'STACK_BUILTIN_SHADOW_IGNORED', stack: entry.name, message: `The repository copy of '${entry.name}' is ignored; the packaged read-only stack is used.` });
        continue;
      }
      if (entry.isSymbolicLink()) { fail('STACK_UNSAFE_PATH', 'A stack folder must not be a symbolic link.'); }
      if (!entry.isDirectory() || !present(file)) continue;
      try {
        safe(folder, true);
        const row = validateStackDocument(root,folder,entry.name,readJson(file,`stack '${entry.name}'`));
        catalog.stacks.push(row);
        for (const key of ['cli','mcp']) if (Object.hasOwn(row.document,key)) catalog.notes.push({ code:'STACK_FIELD_RESERVED', stack:row.name, key, message:`Stack '${row.name}' field '${key}' is reserved and ignored until CLI/MCP stack support ships.` });
      } catch (error) { catalog.problems.push({ ...problem(error), stack:entry.name }); }
    }
  } catch (error) { catalog.problems.push(problem(error)); }
  return finish();
}

/** Find a repository stack catalog from a subdirectory or a pinned host cwd. */
export function stackProjectRoot(cwd = process.cwd()) {
  let directory = resolve(cwd);
  for (;;) {
    if (stackCatalog(directory).stacks.length || existsSync(join(directory,LAYOUT.marker))) return directory;
    const parent = dirname(directory); if (parent === directory) return resolve(cwd); directory = parent;
  }
}
const basePath = url => url.pathname.replace(/\/+$/,'');
const covers = (base, url) => base.origin === url.origin && (basePath(base) === '' || url.pathname === basePath(base) || url.pathname.startsWith(`${basePath(base)}/`));
const expand = value => value.startsWith('~/') ? join(homedir(),value.slice(2)) : value;
function scopeFor(catalog, row, environment, alias, allowEmpty = false) {
  const available = row.environmentNames;
  let selected = environment ?? (row.builtin ? undefined : process.env.API_ENV) ?? row.document.default_environment;
  const empty = allowEmpty && available.length === 0 && environment === undefined;
  if (!empty && (typeof selected !== 'string' || !Object.hasOwn(row.document.environments,selected))) fail('ENVIRONMENT_NOT_FOUND', `Stack '${row.name}' has no environment '${selected ?? '(none)'}'.`, { stack:row.name, available }, `Use one of: ${available.join(', ') || '(none)'}.`);
  if (empty) selected = null;
  const env = empty ? {} : row.document.environments[selected];
  const evidenceDir = posix.join(LAYOUT.evidence,row.name);
  const defaults = { ...resolveDefaults(catalog.defaults), evidenceDir };
  if (process.env.API_CONCURRENCY === undefined && env.concurrency !== undefined) defaults.concurrency = env.concurrency;
  const credentialEnvFiles = [env.envFile ? resolve(row.folder,expand(env.envFile)) : null].filter(Boolean);
  const config = { stack:row.name, root:catalog.root, name:selected, env, file:row.file,
    baseUrl:env.baseUrl?.replace(/\/+$/,''), baseUrlSource:env.baseUrl ? 'config' : 'fallback', baseUrlOverride:false,
    contract:contractPath(row.builtin ? row.folder : catalog.root,row.folder,env.contract ?? row.document.contract), contractPathPrefix:env.contractPathPrefix,
    auth:env.auth, headers:env.headers ?? {}, variables:env.variables ?? {}, credentialEnvFiles,
    ...(row.builtin ? { builtin: true, readOnly: true, capture: false } : {}),
    tokenUrl:env.tokenUrl, scope:env.scope, production:Boolean(env.production), hosts:{}, defaults, concurrency:defaults.concurrency, problems:[],
  };
  return { root:catalog.root, stack:row.name, name:row.name, folder:row.folder, ...(row.builtin ? { builtin: true, readOnly: true } : {}), contextFile:posix.join(row.relativeFolder,row.builtin ? `${PROSE_PRODUCT_TITLE.toLowerCase()}.json` : CONTEXT_BASENAME), evidenceDir, config, document:row.document, ...(alias ? { alias } : {}) };
}
function selectStack(root, { stack, upstream, path='', environment } = {}, allowEmpty = false) {
  const catalog = stackCatalog(root);
  const names = catalog.stacks.map(row=>row.name), explicit = stack ?? upstream;
  const alias = stack === undefined && upstream !== undefined ? { from:'upstream', to:'stack', message:'upstream is a compatibility alias for stack for one release.' } : undefined;
  // Legacy dispatch owns its established URL/credential diagnostics. Inspect
  // only the reserved feedback destination before yielding to that client;
  // otherwise parsing userinfo here would replace CREDENTIAL_IN_REQUEST with
  // a generic URL error before the client's credential boundary can name it.
  if (!catalog.stacks.length && !catalog.problems.length && !isBuiltinStack(explicit) && !isBuiltinFeedbackTarget(path)) return null;
  let absolute = null;
  if (typeof path === 'string' && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) {
    try { absolute = new URL(path); } catch { fail('URL_INVALID','The supplied absolute URL is invalid.'); }
    if (!['http:','https:'].includes(absolute.protocol) || absolute.username || absolute.password || absolute.hash) fail('URL_INVALID','The supplied URL must use http or https without credentials or a fragment.');
  }
  const builtinTarget = absolute && isBuiltinFeedbackTarget(absolute.href);
  if (builtinTarget && explicit !== undefined && !isBuiltinStack(explicit))
    fail('FEEDBACK_STACK_REQUIRED', `The feedback API must use the packaged '${FEEDBACK_STACK_NAME}' stack.`);
  if (isBuiltinStack(explicit) || builtinTarget) {
    const scope = scopeFor(catalog, builtinRow(catalog.root), environment, alias, allowEmpty);
    if (!allowEmpty) {
      const target = absolute ?? new URL(`${scope.config.baseUrl}${String(path).startsWith('/') ? '' : '/'}${path}`);
      if (!covers(new URL(FEEDBACK_BASE_URL), target)) fail('ORIGIN_NOT_CONFIGURED', 'The URL is outside the packaged feedback stack; the request was not sent.');
    }
    return scope;
  }
  if (catalog.problems.length) { const first=catalog.problems[0]; fail(first.code,first.message,first.details,first.next); }
  if (!catalog.stacks.length) return null;
  let row;
  if (explicit !== undefined) {
    row = catalog.stacks.find(value=>value.name===explicit);
    if (!row) fail('STACK_NOT_FOUND',`No stack named '${explicit}' is configured.`,{ available:names });
  } else if (absolute) {
    const candidates = catalog.stacks.filter(value=>Object.values(value.document.environments).some(env=>covers(new URL(env.baseUrl),absolute)));
    if (candidates.length > 1) fail('STACK_AMBIGUOUS',`Stacks ${candidates.map(value=>`'${value.name}'`).join(' and ')} cover this URL; choose a stack explicitly.`,{ available:candidates.map(value=>value.name) });
    row = candidates[0];
    if (!row) fail('ORIGIN_NOT_CONFIGURED','No stack environment covers this URL; the request was not sent.',{ available:names, configured:names });
  } else {
    if (catalog.defaults.default_stack !== undefined) row = catalog.stacks.find(value=>value.name===catalog.defaults.default_stack);
    else if (catalog.stacks.length===1) row=catalog.stacks[0];
    if (!row) fail('STACK_REQUIRED','Choose a stack for a relative request; no unique default is configured.',{ available:names });
  }
  const scope=scopeFor(catalog,row,environment,alias,allowEmpty);
  if (allowEmpty) return scope;
  const base=new URL(scope.config.baseUrl);
  let target=absolute;
  if (!target) try { target=new URL(`${scope.config.baseUrl}${String(path).startsWith('/') ? '' : '/'}${path}`); } catch { fail('URL_INVALID','The supplied request path is invalid.'); }
  if (!covers(base,target)) fail('ORIGIN_NOT_CONFIGURED',`The URL is outside stack '${row.name}' environment '${scope.config.name}'; the request was not sent.`,{ stack:row.name, environment:scope.config.name, available:names });
  return scope;
}

export const resolveStack = (root, options) => selectStack(root, options, false);
export const stackScope = (root, options) => selectStack(root, options, true);

export function stackNameFromTitle(title) {
  const name=String(title ?? '').replace(/\s+api\s*$/i,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,63).replace(/-$/,'');
  return validStackName(name) ? name : 'api';
}
// planStack runs every check createStack makes and writes nothing, so a
// caller can preflight a stack inside a larger all-or-nothing write plan.
export function planStack(root, name, options = {}) {
  root=resolve(root); requireName(name); assertWritableStack(name);
  const catalog=stackCatalog(root);
  if (catalog.problems.length) { const p=catalog.problems[0]; fail(p.code,p.message,p.details,p.next); }
  if (!catalog.stacks.length && [LAYOUT.context,LAYOUT.environments,LEGACY_LAYOUT.context,LEGACY_LAYOUT.environments,LEGACY_LAYOUT.hiddenEnvironments].some(path=>existsSync(join(root,path))))
    fail('STACKS_MIGRATION_REQUIRED','This repository has a single-store installation; migrate it to named stacks before adding explicit stacks.',{},`Run ${POINTER_CLI_NAME} migrate --dry-run to preview the migration, then ${POINTER_CLI_NAME} migrate to apply it, then retry ${POINTER_CLI_NAME} stack add.`);
  const relativeFolder=posix.join(LAYOUT.collection,name), folder=join(root,relativeFolder), stackFile=posix.join(relativeFolder,STACK_CONFIG_BASENAME);
  if (existsSync(join(root,stackFile))) fail('STACK_EXISTS',`Stack '${name}' already exists.`);
  const environment=options.environment ?? options.env ?? 'default';
  const env={ baseUrl:options.baseUrl, ...(options.auth ? {auth:options.auth} : {}), ...(options.envFile ? {envFile:options.envFile} : {}), ...(options.production !== undefined ? {production:options.production} : {}), ...(options.contractPathPrefix ? {contractPathPrefix:options.contractPathPrefix} : {}) };
  let contract, contractBytes;
  if (options.contract) {
    const source=inputContractPath(root,options.contract);
    safe(source); contract=basename(source);
    if (contract===STACK_CONFIG_BASENAME || contract===CONTEXT_BASENAME) fail('STACK_CONTRACT_INVALID','The contract filename conflicts with a stack metadata file.');
    try { contractBytes=readBounded(source,16*1024*1024,'STACK_CONTRACT_LIMIT','The input contract'); }
    catch (error) { if (error.code?.startsWith('STACK_')) throw error; fail('STACK_CONTRACT_INVALID','The input contract could not be read.'); }
  }
  if (!options.baseUrl && options.auth) fail("STACK_URL_INVALID", "A credential reference requires a declared base URL.");
  const document={v:1,name,...(options.title ? {title:options.title} : {}),...(options.baseUrl ? {default_environment:environment} : {}),...(contract ? {contract} : {}),environments:options.baseUrl ? {[environment]:env} : {}};
  validateStackDocument(root,folder,name,document);
  safe(folder,true); safe(join(root,stackFile));
  if (contract) { safe(join(folder,contract)); if (existsSync(join(folder,contract))) fail('STACK_EXISTS','A destination contract already exists; it was preserved.'); }
  return { root, name, relativeFolder, folder, stackFile, document, contract, contractBytes, environment, baseUrl: options.baseUrl };
}
export function createStack(root, name, options = {}) {
  return writeStack(planStack(root, name, options));
}
function writeStack({ root, name, relativeFolder, folder, stackFile, document, contract, contractBytes, environment, baseUrl }) {
  mkdirSync(folder,{recursive:true});
  const created=[];
  if (contract) { writeOutputFileAtomic(join(folder,contract),contractBytes,{code:'STACK_UNSAFE_PATH'}); created.push(posix.join(relativeFolder,contract)); }
  writeOutputFileAtomic(join(root,stackFile),`${JSON.stringify(document,null,2)}\n`,{code:'STACK_UNSAFE_PATH'}); created.push(stackFile);
  const scope=stackScope(root,{stack:name,...(baseUrl ? {environment} : {})});
  return { stack:name,folder,stackFile,contextFile:scope.contextFile,evidenceDir:scope.evidenceDir,document,created,scope };
}
