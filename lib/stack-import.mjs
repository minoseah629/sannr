// Import a stack from another repository: a local path or a Git URL fetched
// with the user's own git. The source is untrusted data. It is validated under
// the rules a local stack must pass, nothing in it is executed or followed,
// and no API request is sent. Planning writes nothing; applying a plan writes
// through the stack and note store functions `stack add` and `note` use.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LAYOUT, planLayout } from './layout.mjs';
import { CONTEXT_BASENAME, POINTER_CLI_NAME } from './brand.mjs';
import { STACK_CONFIG_BASENAME, assertSafeStackPath, assertWritableStack, isBuiltinStack, readStackFile, readStackJson,
  stackCatalog, stackScope, validStackName, validateStackDocument } from './stacks.mjs';
import { CONTEXT_VERSION, MAX_CONTEXT_BYTES, openContextNoteBatch, emptyContext, loadContextSnapshot, mapSourceFiles,
  operationsFrom, readContract, saveContext, sourceFileFor } from './context.mjs';
import { baselineNoteHistory, inspectNoteHistory, protectContextNoteHistory, validAuthoredNoteStamp, validNoteImport } from './note-history.mjs';
import { RETIRE_REASONS } from './note-reviews.mjs';
import { withStackScope } from './stack-scope.mjs';
import { stacksMigrationRequired } from './stack-migration-state.mjs';
import { secretIn } from './verdicts.mjs';
import { parseAuthReference } from './auth-reference.mjs';
import { BLOCK_TEXT_MAX, hasCommentMarkup } from './block-text.mjs';
import { writeOutputFileAtomic } from './output-path.mjs';

export const IMPORT_RECORD_KEY = 'imported_from';
const MAX_CONTRACT_BYTES = 16 * 1024 * 1024;
const MAX_FOLDER_ENTRIES = 4096;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const CONTRACT_EXTENSIONS = ['.json', '.yaml', '.yml'];
// A contract is copied under its own name, so the name must not be one an
// agent host or a package tool reads as instructions or configuration.
const RESERVED_CONTRACT_STEMS = new Set(['agents', 'claude', 'gemini', 'copilot-instructions', 'skill', 'mcp', 'settings',
  'package', 'package-lock', 'tsconfig', 'jsconfig', 'launch', 'tasks']);
const COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@-]{0,255}$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const portable = value => value.split(sep).join('/');
const fail = (code, message, extra = {}) => { throw Object.assign(new Error(message), { code, ...extra }); };
const today = () => new Date().toISOString().slice(0, 10);
const within = (root, path) => { const part = relative(root, path); return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part); };

/** What the user typed, classified. Nothing is contacted or read here. */
export function parseImportSource(source, { ref } = {}) {
  if (typeof source !== 'string' || !source.trim() || source.startsWith('-'))
    fail('STACK_IMPORT_SOURCE_INVALID', 'Name the source: a local path or a Git URL (https or ssh).');
  if (ref !== undefined && (!GIT_REF.test(ref) || ref.includes('..')))
    fail('STACK_IMPORT_REF_INVALID', 'A Git ref is a branch, tag or commit name of letters, digits and . _ / @ -.');
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+\.[A-Za-z0-9.-]+):(?!\/\/)([^\s:][^\s]*)$/.exec(source);
  if (scp && !/^[A-Za-z]:[\\/]/.test(source))
    return { kind: 'git', url: source, ref, location: `ssh://${scp[1]}/${scp[2].replace(/^\/+/, '')}` };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(source)?.[1].toLowerCase();
  if (scheme) {
    if (!['https', 'ssh', 'file'].includes(scheme))
      fail('STACK_IMPORT_SOURCE_INVALID', `A Git source uses https or ssh; '${scheme}' is not fetched.`);
    let url;
    try { url = new URL(source); } catch { fail('STACK_IMPORT_SOURCE_INVALID', 'The Git URL could not be parsed.'); }
    if (url.password || url.search || url.hash || scheme === 'https' && url.username)
      fail('STACK_IMPORT_SOURCE_INVALID', 'A Git URL must not carry credentials, a query or a fragment; let git supply credentials.');
    if (scheme === 'file') return { kind: 'git', url: source, ref, file: fileURLToPath(url) };
    // The recorded source drops the ssh login name: it is not part of where
    // the stack came from, and it reads as an address in committed files.
    url.username = '';
    return { kind: 'git', url: source, ref, location: url.href.replace(/\/+$/, '') };
  }
  if (ref !== undefined) fail('STACK_IMPORT_REF_INVALID', '--ref applies to a Git URL; a local path is read as it is on disk.');
  return { kind: 'path', path: source };
}

// A path recorded in committed files is relative to this repository, never
// machine-absolute. A source more than two directories above the repository
// would spell most of its absolute path, so it is recorded by its directory
// name alone, and that name is not an identity: `exact` is false.
function recordedPath(root, target) {
  const part = portable(relative(root, target));
  const far = isAbsolute(part) || part.startsWith('../../../') || part === '../../..';
  return { location: far ? basename(target) : part || '.', exact: !far };
}

// git runs with a child environment that cannot redirect it at the user's own
// repository, index or configuration: every GIT_* variable is dropped except
// the transport and credential helpers. The temporary repository is always
// named with --git-dir, it is bare, and nothing is ever checked out, so no
// hook, smudge filter or LFS download runs on the source's files.
// GIT_ALLOW_PROTOCOL is kept too: it only narrows what git may fetch.
const GIT_ENVIRONMENT_KEPT = /^GIT_(?:SSH|SSH_COMMAND|ASKPASS|TERMINAL_PROMPT|SSL_[A-Z_]+|HTTP_[A-Z_]+|PROXY_COMMAND|ALLOW_PROTOCOL)$/;
function gitEnvironment() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key) || GIT_ENVIRONMENT_KEPT.test(key)) environment[key] = value;
  return { ...environment, GIT_LFS_SKIP_SMUDGE: '1' };
}
function git(session, args, { maxBytes = 4 * 1024 * 1024 } = {}) {
  return new Promise((done, refuse) => {
    const child = spawn('git', [`--git-dir=${session.gitDir}`, ...args], { cwd: session.directory, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
    session.child = child;
    const out = [], err = [];
    let size = 0, over = false;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > maxBytes) { over = true; child.kill(); } else out.push(chunk); });
    child.stderr.on('data', chunk => { if (err.length < 64) err.push(chunk); });
    const failed = (code, message) => refuse(Object.assign(new Error(message), { code }));
    child.once('error', error => failed(error.code === 'ENOENT' ? 'STACK_IMPORT_GIT_UNAVAILABLE' : 'STACK_IMPORT_GIT_FAILED',
      error.code === 'ENOENT' ? 'git was not found on PATH; a Git source is fetched with your own git.' : 'git could not be started.'));
    child.once('close', status => {
      session.child = null;
      if (over) return failed('STACK_IMPORT_LIMIT', 'The Git source is larger than this command reads; nothing was imported.');
      if (status !== 0) {
        const detail = Buffer.concat(err).toString('utf8').trim().split('\n').filter(Boolean).pop()?.slice(0, 300);
        return failed('STACK_IMPORT_GIT_FAILED', `git could not read the source${detail ? `: ${detail}` : '.'}`);
      }
      done(Buffer.concat(out));
    });
  });
}

// Write the stack folders of the fetched commit as plain files, straight from
// git's object store. Only folders that can hold a stack are written.
async function materialize(session, tree) {
  const listing = (await git(session, ['ls-tree', '-r', '-z', '--long', 'FETCH_HEAD'], { maxBytes: 64 * 1024 * 1024 })).toString('utf8');
  const entries = listing.split('\0').filter(Boolean).map(line => {
    const tab = line.indexOf('\t'), [mode, type, object, size] = line.slice(0, tab).split(/ +/);
    return { mode, type, object, size: Number(size), path: line.slice(tab + 1) };
  });
  const paths = new Set(entries.map(entry => entry.path));
  const collection = `${LAYOUT.collection}/`;
  const keep = entries.some(entry => entry.path.startsWith(collection)) ? entry => entry.path.startsWith(collection)
    : paths.has(STACK_CONFIG_BASENAME) ? () => true
      : entry => entry.path.includes('/') && paths.has(`${entry.path.slice(0, entry.path.indexOf('/'))}/${STACK_CONFIG_BASENAME}`);
  let files = 0, bytes = 0;
  mkdirSync(tree);
  for (const entry of entries.filter(keep)) {
    const parts = entry.path.split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /^\.git$/i.test(part) || /[\\\0]/.test(part)) || !/^[a-f0-9]{40,64}$/.test(entry.object))
      fail('STACK_UNSAFE_PATH', 'The Git source holds a file path this command does not write; nothing was imported.');
    if (++files > MAX_FOLDER_ENTRIES) fail('STACK_IMPORT_LIMIT', `The Git source holds more than ${MAX_FOLDER_ENTRIES} files in its stack folders; nothing was imported.`);
    const target = join(tree, ...parts);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.type !== 'blob' || entry.mode === '120000') {
      // A link or submodule is kept as a link so the stack that holds it is
      // refused by the same check a local source gets. Its target is not read.
      try { symlinkSync('not-followed', target); } catch { fail('STACK_UNSAFE_PATH', 'The Git source holds a symbolic link in a stack folder; links are not followed.'); }
      continue;
    }
    bytes += entry.size;
    if (entry.size > MAX_CONTRACT_BYTES || bytes > MAX_SOURCE_BYTES)
      fail('STACK_IMPORT_LIMIT', `The Git source's stack folders exceed the ${MAX_CONTRACT_BYTES / 1024 / 1024} MiB per-file or ${MAX_SOURCE_BYTES / 1024 / 1024} MiB total limit; nothing was imported.`);
    writeFileSync(target, await git(session, ['cat-file', 'blob', entry.object], { maxBytes: MAX_CONTRACT_BYTES + 1 }), { flag: 'wx' });
  }
}

// The commit of a local source is read from its files; git is not run inside a
// directory this command did not create.
function small(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('unreadable');
  return readFileSync(path, 'utf8');
}
function localCommit(directory) {
  try {
    for (let current = directory;; current = dirname(current)) {
      const dot = join(current, '.git'), stat = lstatSync(dot, { throwIfNoEntry: false });
      if (stat) {
        let gitDir = dot;
        if (stat.isFile()) {
          const pointer = /^gitdir: (.+)$/m.exec(small(dot))?.[1].trim();
          if (!pointer) return null;
          gitDir = resolve(current, pointer);
        } else if (!stat.isDirectory()) return null;
        const head = small(join(gitDir, 'HEAD')).trim();
        if (COMMIT.test(head)) return head;
        const ref = /^ref: (refs\/[A-Za-z0-9._/@-]+)$/.exec(head)?.[1];
        if (!ref || ref.includes('..')) return null;
        const common = existsSync(join(gitDir, 'commondir')) ? resolve(gitDir, small(join(gitDir, 'commondir')).trim()) : gitDir;
        for (const base of new Set([gitDir, common])) {
          if (!existsSync(join(base, ref))) continue;
          const value = small(join(base, ref)).trim();
          return COMMIT.test(value) ? value : null;
        }
        if (existsSync(join(common, 'packed-refs')))
          for (const line of small(join(common, 'packed-refs')).split('\n')) {
            const [value, name] = line.split(' ');
            if (name === ref && COMMIT.test(value)) return value;
          }
        return null;
      }
      if (dirname(current) === current) return null;
    }
  } catch { return null; }
}

/** Make the source readable on disk. A Git source is fetched into a temporary
 *  directory; `release` removes it, and so does an interrupt or termination
 *  signal. `announce` receives the git command line before it runs, because
 *  it is this command's only network use. */
export async function openImportSource(root, parsed, { announce = () => {} } = {}) {
  if (parsed.kind === 'path') {
    let directory;
    try { directory = realpathSync(resolve(parsed.path)); } catch { fail('STACK_IMPORT_SOURCE_NOT_FOUND', 'The source path does not exist.'); }
    if (!statSync(directory).isDirectory()) fail('STACK_IMPORT_SOURCE_INVALID', 'The source path must be a directory: a repository, its stacks directory or one stack folder.');
    const located = locateStacks(directory);
    return { kind: 'path', directory, ...located, ...recordedPath(root, located.owner), commit: localCommit(located.owner), release() {} };
  }
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'stack-import-')));
  const session = { directory, gitDir: join(directory, 'source.git'), child: null };
  const interrupted = signal => { session.child?.kill(); rmSync(directory, { recursive: true, force: true }); process.exit(signal === 'SIGINT' ? 130 : 143); };
  const release = () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeListener(signal, interrupted);
    rmSync(directory, { recursive: true, force: true });
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, interrupted);
  try {
    const target = parsed.ref ?? 'HEAD';
    announce(`git fetch --depth 1 --no-tags -- ${parsed.url} ${target}`);
    await git(session, ['init', '--quiet', '--bare', session.gitDir]);
    await git(session, ['fetch', '--quiet', '--depth', '1', '--no-tags', '--no-recurse-submodules', '--', parsed.url, target]);
    const commit = (await git(session, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).toString('utf8').trim();
    const tree = join(directory, 'tree');
    await materialize(session, tree);
    const recorded = parsed.location ? { location: parsed.location, exact: true } : recordedPath(root, realpathSync(parsed.file));
    return { kind: 'git', directory: tree, ...locateStacks(tree), ...recorded,
      ...(parsed.ref ? { ref: parsed.ref } : {}), commit: COMMIT.test(commit) ? commit : null, release };
  } catch (error) { release(); throw error; }
}

// A repository root, its stacks directory, or one stack folder. `owner` is the
// directory the recorded source names, so the three spellings of one source
// are one source.
function locateStacks(directory) {
  const entryAt = path => lstatSync(path, { throwIfNoEntry: false });
  const collection = join(directory, LAYOUT.collection);
  const ownerOf = path => portable(path).endsWith(`/${LAYOUT.collection}`) ? resolve(path, ...LAYOUT.collection.split('/').map(() => '..')) : path;
  if (entryAt(join(directory, STACK_CONFIG_BASENAME)) && !entryAt(collection)) {
    // One stack folder is named by its own stack.json, not by the directory
    // that happens to hold it (a clone's root has no meaningful name).
    const name = readStackJson(join(directory, STACK_CONFIG_BASENAME), 'the source stack').name;
    if (!validStackName(name)) fail('STACK_CONFIG_INVALID', 'The source stack.json does not carry a valid stack name.');
    return { owner: ownerOf(dirname(directory)) === dirname(directory) ? directory : ownerOf(dirname(directory)),
      stacks: [{ name, folder: directory }] };
  }
  const base = entryAt(collection) ? collection : directory;
  const baseEntry = entryAt(base);
  if (!baseEntry) fail('STACK_IMPORT_SOURCE_EMPTY', `The source holds no stack: expected ${LAYOUT.collection}/<name>/${STACK_CONFIG_BASENAME}, a stacks directory or one stack folder.`);
  if (baseEntry.isSymbolicLink() || !baseEntry.isDirectory()) fail('STACK_UNSAFE_PATH', 'The source stacks directory must be a real directory, not a link.');
  const stacks = [];
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (isBuiltinStack(entry.name) || !validStackName(entry.name)) continue;
    const folder = join(base, entry.name);
    if (entry.isSymbolicLink() || entry.isDirectory() && entryAt(join(folder, STACK_CONFIG_BASENAME))) stacks.push({ name: entry.name, folder });
  }
  if (!stacks.length) fail('STACK_IMPORT_SOURCE_EMPTY', `The source holds no stack: expected ${LAYOUT.collection}/<name>/${STACK_CONFIG_BASENAME}, a stacks directory or one stack folder.`);
  return { owner: base === collection ? directory : ownerOf(base), stacks };
}

function assertNoLinks(folder, name) {
  let seen = 0;
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++seen > MAX_FOLDER_ENTRIES) fail('STACK_IMPORT_LIMIT', `Stack '${name}' in the source has more than ${MAX_FOLDER_ENTRIES} files.`);
      if (entry.isSymbolicLink()) fail('STACK_UNSAFE_PATH', `Stack '${name}' in the source contains a symbolic link ('${entry.name}'); links are not followed.`, { source_stack: name });
      if (entry.isDirectory()) walk(join(directory, entry.name));
    }
  };
  walk(folder);
}

/** Read one source stack folder as untrusted data. */
function readSourceStack({ name, folder }) {
  const at = lstatSync(folder);
  if (at.isSymbolicLink() || !at.isDirectory()) fail('STACK_UNSAFE_PATH', `Stack '${name}' in the source is a symbolic link; links are not followed.`, { source_stack: name });
  assertSafeStackPath(folder, true);
  assertNoLinks(folder, name);
  const document = readStackJson(join(folder, STACK_CONFIG_BASENAME), `stack '${name}' in the source`);
  // Containment is the stack folder itself: a contract anywhere else in the
  // source repository does not come along and is refused.
  try { validateStackDocument(folder, folder, name, document); }
  catch (error) {
    if (error.code === 'STACK_CONTRACT_OUTSIDE_PROJECT')
      fail(error.code, `Stack '${name}' in the source names a contract outside its stack folder; it was not imported.`, { source_stack: name });
    throw Object.assign(error, { source_stack: name });
  }
  // Every contract the stack names is copied under its own name, so each one
  // must be a contract: an allowed name and a document that parses with
  // operations. No other file in the source folder is copied.
  const contracts = new Map(), parsed = new Map();
  for (const path of [document.contract, ...Object.values(document.environments).map(environment => environment.contract)]) {
    if (!path) continue;
    const local = portable(relative(folder, resolve(folder, path)));
    if (contracts.has(local)) continue;
    const refuse = why => fail('STACK_CONTRACT_INVALID', `Stack '${name}' in the source names '${local}' as a contract; ${why}. Nothing was imported.`, { source_stack: name });
    const rename = `the source's author must rename the file, for example to '${name}.openapi${CONTRACT_EXTENSIONS.includes(extname(local).toLowerCase()) ? extname(local).toLowerCase() : '.json'}', and name it in ${STACK_CONFIG_BASENAME}`;
    const stem = basename(local, extname(local)).toLowerCase();
    if (local.split('/').some(part => part.startsWith('.'))) refuse(`dotfiles and dot-directories are not imported; ${rename}, outside any dot-directory`);
    if (!CONTRACT_EXTENSIONS.includes(extname(local).toLowerCase())) refuse(`a contract file ends in ${CONTRACT_EXTENSIONS.join(', ')}; ${rename}`);
    if (RESERVED_CONTRACT_STEMS.has(stem) || [STACK_CONFIG_BASENAME, CONTEXT_BASENAME].includes(basename(local).toLowerCase()))
      refuse(`the file name '${basename(local)}' is reserved for agent instructions, tool configuration or stack metadata; ${rename}`);
    if (!existsSync(join(folder, local))) refuse('it is not in the stack folder');
    contracts.set(local, readStackFile(join(folder, local), MAX_CONTRACT_BYTES, 'STACK_CONTRACT_LIMIT', `The contract of stack '${name}'`));
    // What counts as a contract is what `stack add --contract` accepts: the
    // same reader and the same "declares operations" test, nothing narrower.
    let contract;
    try { contract = readContract(join(folder, local)); } catch { refuse('it could not be parsed as a contract'); }
    let declared = 0;
    try { declared = operationsFrom(contract.doc).length; } catch { declared = 0; }
    if (!declared) refuse('it declares no operations, so it is not a contract this version reads');
    parsed.set(local, contract);
  }
  let knowledge = null;
  const file = join(folder, CONTEXT_BASENAME);
  if (lstatSync(file, { throwIfNoEntry: false })) {
    try { knowledge = JSON.parse(readStackFile(file, MAX_CONTEXT_BYTES, 'CONTEXT_CAPACITY_REACHED', `The knowledge file of stack '${name}'`).toString('utf8')); }
    catch (error) { if (error.code) throw error; knowledge = undefined; }
    if (!object(knowledge) || !object(knowledge.operations))
      fail('STACK_IMPORT_KNOWLEDGE_INVALID', `The knowledge file of stack '${name}' in the source is not a usable knowledge document.`, { source_stack: name });
    if (knowledge.v !== CONTEXT_VERSION)
      fail('CONTEXT_VERSION_UNSUPPORTED', `The knowledge file of stack '${name}' in the source has an unsupported version.`, { source_stack: name });
  }
  return { name, folder, document, contracts, parsed, knowledge };
}

// What the local stack.json keeps: credential references by variable name,
// never the author's envFile path; reserved keys are dropped.
function localDocument(document, name) {
  const { cli, mcp, ...kept } = structuredClone(document);
  const removed = [];
  for (const [environment, value] of Object.entries(kept.environments)) {
    if (Object.hasOwn(value, 'envFile')) { delete value.envFile; removed.push(environment); }
  }
  return { document: { ...kept, name }, envFileRemoved: removed };
}

// Strings from the source that are written to committed files pass the same
// secret refusal as note text, wherever they sit.
function refuseSecrets(value, code, message, extra) {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { if (secretIn(item)) fail(code, message, extra); }
    else if (item && typeof item === 'object') for (const [key, child] of Object.entries(item)) pending.push(key, child);
  }
}

function inventory(root, read, name, document) {
  const selected = document.environments[document.default_environment]?.contract ?? document.contract;
  if (!selected) return emptyContext({ name: document.title ?? name, contractPath: null, contractDigest: null });
  const local = portable(relative(read.folder, resolve(read.folder, selected)));
  const contract = read.parsed.get(local);
  const ctx = emptyContext({ name: typeof contract.doc.info?.title === 'string' ? contract.doc.info.title.slice(0, 256) : document.title ?? name,
    contractPath: posix.join(LAYOUT.collection, name, local), contractDigest: contract.digest });
  const sources = mapSourceFiles(root);
  for (const { op, path } of operationsFrom(contract.doc)) ctx.operations[op] ??= baselineNoteHistory({ source_file: sourceFileFor(path, sources),
    verified_at: null, contract_digest: null, shape_hash: null, status_codes: [],
    effect: op.startsWith('GET ') || op.startsWith('HEAD ') ? 'read' : 'write', fields: {} });
  refuseSecrets([ctx.api.name, Object.keys(ctx.operations)], 'STACK_SECRET_LITERAL',
    `The contract of stack '${read.name}' in the source carries a secret-shaped title or path; nothing was imported.`, { source_stack: read.name });
  return ctx;
}

// Where requests and credentials would go once the stack is used: shown in
// every receipt so a source cannot pair a familiar variable name with its own
// host unnoticed.
function environmentSummary(document) {
  return Object.entries(document.environments).map(([name, environment]) => {
    const auth = parseAuthReference(environment.auth);
    const host = value => { try { return new URL(value).host; } catch { return null; } };
    return { name, default: name === document.default_environment, base_url_host: host(environment.baseUrl),
      ...(environment.tokenUrl ? { token_url_host: host(environment.tokenUrl) } : {}),
      auth_variables: auth ? [auth.envVar, auth.clientIdEnv, auth.clientSecretEnv, auth.usernameEnv, auth.passwordEnv].filter(Boolean) : [],
      production: environment.production === true };
  });
}

const noteRefusal = (code, label, stack) => fail(code, {
  SECRET_IN_NOTE: `A note on ${label} in source stack '${stack}' appears to contain a credential; nothing was imported.`,
  MARKUP_IN_NOTE: `A note on ${label} in source stack '${stack}' contains comment markup; nothing was imported.`,
  NOTE_TOO_LONG: `A note on ${label} in source stack '${stack}' is longer than ${BLOCK_TEXT_MAX} characters; nothing was imported.`,
  NOTE_INPUT_INVALID: `A note on ${label} in source stack '${stack}' has provenance this version cannot keep; nothing was imported.`,
  NOTE_KEY_INVALID: `Source stack '${stack}' has an operation key this version cannot keep; nothing was imported.`,
  NOTE_HISTORY_INVALID: `The note history of ${label} in source stack '${stack}' is malformed; nothing was imported.`,
  NOTE_HISTORY_CHANGED: `The note history of ${label} in source stack '${stack}' differs from its recorded baseline; nothing was imported.`,
}[code], { source_stack: stack, operation: label });

// Evidence stays in the author's private storage, and so does what a
// reference says about it: run IDs, the author's provider URL, environment
// name and build are not carried. Only the number of references is kept, so a
// reader can see that the author attached runs that are unavailable here.
const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
function importedStamp(record, origin) {
  const stamp = {};
  for (const key of ['by', 'at', 'recorded_at', 'actor', 'basis', 'source', 'operations'])
    if (record.provenance[key] !== undefined) stamp[key] = record.provenance[key];
  // A basis source that is a run ID names the same private evidence.
  if (typeof stamp.source === 'string' && RUN_ID.test(stamp.source)) delete stamp.source;
  const evidence = record.provenance.evidence;
  const count = evidence === undefined ? 0 : Array.isArray(evidence) && evidence.length <= 16 ? evidence.length : -1;
  stamp.imported = { source: origin.location, ...(origin.commit ? { commit: origin.commit } : {}), at: origin.at, note: record.id,
    ...(count > 0 ? { evidence_count: count } : {}) };
  return count < 0 ? null : stamp;
}

// One note target (an operation or the stack's shared facts): bring the
// source's active notes into `ctx` and count what happened. The local history
// is opened and inspected once, whatever the number of notes.
function mergeNotes(ctx, key, label, sourceEntry, origin, report) {
  const history = inspectNoteHistory(sourceEntry, label);
  if (history.state === 'invalid') noteRefusal('NOTE_HISTORY_INVALID', label, origin.stack);
  if (history.state === 'changed') noteRefusal('NOTE_HISTORY_CHANGED', label, origin.stack);
  if (key.kind === 'operation' && (key.op.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(key.op) || secretIn(key.op) || hasCommentMarkup(key.op)))
    noteRefusal(secretIn(key.op) ? 'SECRET_IN_NOTE' : 'NOTE_KEY_INVALID', 'an operation', origin.stack);
  const links = Array.isArray(sourceEntry.note_replacements) ? sourceEntry.note_replacements : [];
  const previous = new Map(links.map(link => [link.replacement, link.supersedes]));
  const retirements = new Map((Array.isArray(sourceEntry.note_retirements) ? sourceEntry.note_retirements : []).map(row => [row.replacement, row.reason]));
  let batch;
  try { batch = openContextNoteBatch(ctx, key); }
  catch (error) { throw Object.assign(error, { operation: label }); }
  // Source note identity -> the local note imported from it.
  const have = new Map(batch.history.records.filter(record => record.provenance?.imported?.source === origin.location)
    .map(record => [record.provenance.imported.note, { id: record.id, superseded: Boolean(record.superseded) }]));
  const held = new Set();
  const hold = id => { if (!held.has(id)) { held.add(id); report.held.push({ target: label, note_id: id, reason: 'LOCALLY_TRUSTED' }); } };
  const reviews = () => (key.kind === 'stack' ? ctx.stack_facts : ctx.operations?.[key.op])?.note_reviews ?? [];
  const locallyTrusted = id => reviews().findLast(row => row.note_id === id && row.decision !== 'run-requested')?.decision === 'trusted';
  // The nearest earlier version of a source note that was imported here; with
  // `any` false, only one that is still active locally.
  const chainTarget = (id, any = false) => {
    for (let cursor = previous.get(id), steps = 0; cursor && steps < 1024; cursor = previous.get(cursor), steps++)
      if (have.has(cursor)) return any || !have.get(cursor).superseded ? have.get(cursor) : null;
    return null;
  };
  for (const record of history.active) {
    if (record.kind !== 'authored') {
      report.skipped.push({ target: label, reason: record.kind === 'machine' ? 'MACHINE_NOTE' : 'NOTE_ATTRIBUTION_UNKNOWN' });
      continue;
    }
    if (have.has(record.id)) {
      report.notes.unchanged += 1;
      // An upstream change that could not replace a locally trusted note on an
      // earlier import is still held: say so on every import, not only the first.
      const earlier = chainTarget(record.id);
      if (earlier && locallyTrusted(earlier.id)) hold(earlier.id);
      continue;
    }
    if (secretIn(record.text, { allowAuthReferences: true })) noteRefusal('SECRET_IN_NOTE', label, origin.stack);
    if (hasCommentMarkup(record.text)) noteRefusal('MARKUP_IN_NOTE', label, origin.stack);
    if (typeof record.text !== 'string' || record.text.length > BLOCK_TEXT_MAX) noteRefusal('NOTE_TOO_LONG', label, origin.stack);
    const stamp = importedStamp(record, origin);
    if (!stamp || !validAuthoredNoteStamp(stamp)) noteRefusal('NOTE_INPUT_INVALID', label, origin.stack);
    // The author name, source reference and applicability are written too: a
    // secret-shaped value in any of them refuses.
    const { imported, ...authored } = stamp;
    refuseSecrets(authored, 'SECRET_IN_NOTE', `The attribution of a note on ${label} in source stack '${origin.stack}' appears to contain a credential; nothing was imported.`,
      { source_stack: origin.stack, operation: label });
    report.evidence_unavailable += stamp.imported.evidence_count ?? 0;
    const ancestor = chainTarget(record.id, true);
    const reason = retirements.get(record.id);
    const explanation = /^Retired sha256:[a-f0-9]{64} \([a-z-]+\): ([\s\S]+)$/.exec(record.text)?.[1];
    const target = ancestor && !ancestor.superseded ? ancestor : null;
    // Beside a locally trusted note a retirement arrives as an ordinary note;
    // it then names the local note's identity, which can be looked up here.
    const beside = target && reason !== undefined && explanation ? `Retired ${target.id} (${reason}): ${explanation}` : record.text;
    if (reason !== undefined && !target) {
      // A retirement of a note that never arrived here retires nothing.
      report.skipped.push({ target: label, reason: 'RETIREMENT_TARGET_NOT_HERE' });
      continue;
    }
    const attempts = [];
    if (target && key.kind === 'operation' && RETIRE_REASONS.includes(reason) && explanation && ['person', 'agent'].includes(stamp.actor))
      attempts.push({ change: { note: explanation, retirement: { note_id: target.id, reason } }, counts: 'retired', replaces: true });
    if (target) attempts.push({ change: { note: record.text, relation: { supersedes: target.id } }, counts: reason === undefined ? 'updated' : 'retired', replaces: true });
    attempts.push({ change: { note: beside }, counts: 'added' }, { change: { note: beside, relation: { alongside: true } }, counts: 'added' });
    let result, done;
    for (const [index, attempt] of attempts.entries()) {
      try { result = batch.apply({ stamp: structuredClone(stamp), ...attempt.change }); done = attempt; break; }
      catch (error) {
        // A locally trusted note is not overturned by an upstream change: the
        // upstream note arrives beside it and the receipt says so.
        const next = index < attempts.length - 1 && (error.code === 'NOTE_RELATION_REQUIRED'
          || attempt.change.retirement || attempt.change.relation?.supersedes && /^NOTE_(?:REVIEW|RETIRE|ALREADY|SELF)_/.test(error.code ?? ''));
        if (!next) throw Object.assign(error, { source_stack: origin.stack, operation: label });
        if (error.code === 'NOTE_REVIEW_EVIDENCE_REQUIRED') hold(target.id);
      }
    }
    if (result.unchanged) { report.notes.unchanged += 1; continue; }
    report.notes[done.counts] += 1;
    if (done.replaces) target.superseded = true;
    have.set(record.id, { id: result.note_id, superseded: false });
  }
  batch.finish();
  // An imported note that is active here but no longer active in the source,
  // with no upstream replacement to follow, is left alone and named.
  const active = new Set(history.active.map(record => record.id));
  for (const [id, record] of have) if (!record.superseded && !active.has(id) && !held.has(record.id)) report.no_longer_upstream.push({ target: label, note_id: record.id });
}

function planStackImport(root, source, stack, localName, at) {
  const read = readSourceStack(stack);
  if (!validStackName(localName)) fail('STACK_NAME_INVALID', 'Stack names use 1–63 lowercase letters, digits or hyphens, beginning with a letter or digit; suites is reserved.');
  assertWritableStack(localName);
  const relativeFolder = posix.join(LAYOUT.collection, localName), folder = join(root, relativeFolder);
  const origin = { location: source.location, commit: source.commit, at, stack: stack.name };
  const exists = existsSync(join(folder, STACK_CONFIG_BASENAME));
  // `exact: false` marks a location that is a directory name only. It is a
  // label; no later import is ever matched against it.
  const record = { v: 1, source: source.location, ...(source.exact ? {} : { exact: false }), stack: stack.name, ...(source.ref ? { ref: source.ref } : {}),
    ...(source.commit ? { commit: source.commit } : {}), first_imported_at: at, imported_at: at };
  const report = { stack: localName, from: stack.name, action: exists ? 'update' : 'import', folder: relativeFolder, files: [],
    environments: [], env_file_removed: [], operations: 0,
    notes: { added: 0, updated: 0, retired: 0, unchanged: 0 }, evidence_unavailable: 0, skipped: [], held: [], no_longer_upstream: [], not_imported: [] };
  let base, snapshot = null, document = null;
  const scope = exists ? stackScope(root, { stack: localName }) : null;
  if (exists) {
    snapshot = withStackScope(scope, () => loadContextSnapshot(root));
    const prior = snapshot?.ctx?.[IMPORT_RECORD_KEY];
    // A far-away local source is recorded by directory name only. That name
    // cannot tell it from another directory of the same name, so it never
    // counts as "the same source": refuse rather than mix two stacks' notes.
    if (!source.exact)
      fail('STACK_EXISTS', `Stack '${localName}' already exists here, and this source is recorded by its directory name only ('${source.location}'), which cannot prove it is the source that stack came from; nothing was written.`,
        { local_stack: localName, next: `Import it under another name with --as <name>, or import from a Git URL or from a path within two directories of this repository so that later imports can update it.` });
    if (object(prior) && prior.exact === false && prior.source === source.location)
      fail('STACK_EXISTS', `Stack '${localName}' was imported from a source recorded by its directory name only ('${prior.source}'), which cannot prove this is the same source; nothing was written.`,
        { local_stack: localName, next: `Import it under another name: ${POINTER_CLI_NAME} stack import <source> --stack ${stack.name} --as <name>` });
    if (!object(prior) || prior.source !== source.location || prior.stack !== stack.name)
      fail('STACK_EXISTS', `Stack '${localName}' already exists here and was not imported from this source; nothing was written.`,
        { local_stack: localName, next: `Import it under another name: ${POINTER_CLI_NAME} stack import <source> --stack ${stack.name} --as <name>` });
    base = snapshot.ctx;
    report.environments = environmentSummary(scope.document);
    Object.assign(record, { first_imported_at: prior.first_imported_at ?? at });
    if (read.contracts.size && [...read.contracts].some(([path, bytes]) => {
      try { return !readFileSync(join(folder, path)).equals(bytes); } catch { return true; }
    })) report.not_imported.push('contract (changed in the source; the local contract is kept)');
  } else {
    if (lstatSync(folder, { throwIfNoEntry: false }))
      fail('STACK_EXISTS', `${relativeFolder} already exists and is not a stack; it was left untouched and nothing was written.`, { local_stack: localName, next: 'Remove it if it is empty, or choose another name with --as <name>.' });
    const local = localDocument(read.document, localName);
    document = local.document; report.env_file_removed = local.envFileRemoved;
    validateStackDocument(root, folder, localName, document);
    assertSafeStackPath(folder, true);
    base = inventory(root, read, localName, document);
    report.environments = environmentSummary(document);
    report.files = [...[...read.contracts.keys()].map(path => posix.join(relativeFolder, path)),
      posix.join(relativeFolder, STACK_CONFIG_BASENAME), posix.join(relativeFolder, CONTEXT_BASENAME)];
  }
  const next = structuredClone(base);
  const knowledge = read.knowledge ?? { operations: {} };
  if (Object.hasOwn(knowledge, 'stack_facts')) mergeNotes(next, { kind: 'stack' }, 'the stack facts', knowledge.stack_facts, origin, report);
  for (const [op, entry] of Object.entries(knowledge.operations)) {
    if (!object(entry)) noteRefusal('NOTE_HISTORY_INVALID', 'an operation', stack.name);
    if (Array.isArray(entry.notes) && entry.notes.length || entry.note_replacements?.length) mergeNotes(next, { kind: 'operation', op }, op, entry, origin, report);
    if (entry.verified_at || object(entry.fields) && Object.keys(entry.fields).length) report.learned = (report.learned ?? 0) + 1;
    if (entry.note_reviews?.length) report.reviews = (report.reviews ?? 0) + entry.note_reviews.length;
  }
  for (const key of Object.keys(knowledge)) if (!['v', 'api', 'generated_at', 'operations', 'stack_facts', IMPORT_RECORD_KEY].includes(key)) report.not_imported.push(key);
  if (report.env_file_removed.length) report.not_imported.push(`envFile (${report.env_file_removed.join(', ')})`);
  if (report.learned) report.not_imported.push(`learned shapes and verification state (${report.learned} operations)`);
  if (report.reviews) report.not_imported.push(`review decisions (${report.reviews})`);
  delete report.learned; delete report.reviews;
  const changed = report.notes.added + report.notes.updated + report.notes.retired > 0;
  if (!exists || changed || base[IMPORT_RECORD_KEY]?.commit !== record.commit || base[IMPORT_RECORD_KEY]?.ref !== record.ref) next[IMPORT_RECORD_KEY] = record;
  // Seal and check the planned histories now, so a refusal comes before any write.
  protectContextNoteHistory(structuredClone(base), next);
  if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > MAX_CONTEXT_BYTES)
    fail('CONTEXT_CAPACITY_REACHED', `Stack '${stack.name}' would exceed the 16 MiB knowledge limit; nothing was written.`, { local_stack: localName });
  report.operations = Object.keys(next.operations).length;
  const write = !exists || JSON.stringify(next) !== JSON.stringify(base);
  if (exists && write) report.files = [posix.join(relativeFolder, CONTEXT_BASENAME)];
  return { report, exists, write, folder, relativeFolder, localName, document, contracts: read.contracts, next, digest: snapshot?.digest };
}

/** Validate everything and decide every write. Writes nothing. */
export function planImport(root, source, { stacks = [], all = false, as } = {}) {
  root = resolve(root);
  const refusal = stacksMigrationRequired(root);
  if (refusal) fail(refusal.code, refusal.message, { next: refusal.command });
  const catalog = stackCatalog(root);
  if (catalog.problems.length) { const first = catalog.problems[0]; fail(first.code, first.message, { next: first.next }); }
  if (!validNoteImport({ source: source.location, at: today(), note: `sha256:${'0'.repeat(64)}` }))
    fail('STACK_IMPORT_SOURCE_INVALID', 'The source location cannot be recorded in committed files; use a plain URL or a path near this repository.');
  const names = source.stacks.map(stack => stack.name);
  for (const name of stacks) if (!names.includes(name))
    fail('STACK_NOT_FOUND', `The source has no stack named '${name}'. It holds: ${names.join(', ')}.`, { available: names });
  if (all && stacks.length) fail('STACK_ARGUMENT_INVALID', 'Choose --all or --stack, not both.');
  const selected = all ? source.stacks : stacks.length ? source.stacks.filter(stack => stacks.includes(stack.name))
    : source.stacks.length === 1 ? source.stacks : null;
  if (!selected) fail('STACK_SELECTION_REQUIRED', `The source holds ${names.length} stacks: ${names.join(', ')}. Nothing was written.`,
    { available: names, next: `Choose with --stack <name> (repeatable) or --all.` });
  if (as !== undefined && selected.length !== 1) fail('STACK_ARGUMENT_INVALID', '--as renames one imported stack; select exactly one.');
  const at = today();
  const plans = selected.map(stack => planStackImport(root, source, stack, as ?? stack.name, at));
  // The first knowledge write in a repository also creates the managed
  // directory's own files, as `stack add` does. Name them in the receipt.
  const layout = plans.some(item => item.write) ? planLayout(root).files
    .filter(({ path, content }) => !existsSync(join(root, path)) || readFileSync(join(root, path), 'utf8') !== content).map(({ path }) => path) : [];
  return { root, plans, layout, source: { kind: source.kind, location: source.location, ...(source.ref ? { ref: source.ref } : {}), commit: source.commit ?? null } };
}

/** Write a plan. Each stack's knowledge is one locked, atomic save. A stack
 *  that cannot be written stops the run: `failed` names it and its error, and
 *  `written` lists the stacks already in place, which stay. */
export function applyImport(plan) {
  const { root } = plan;
  let scope = null;
  const written = [];
  for (const item of plan.plans) {
    try {
      if (item.exists) {
        const selected = stackScope(root, { stack: item.localName });
        if (item.write) withStackScope(selected, () => saveContext(root, item.next, { expectedDigest: item.digest }));
        scope = selected;
      } else scope = installStack(root, item);
      written.push(item.localName);
    } catch (error) {
      // A file-system error is reported by name, without the absolute path
      // Node puts in its message.
      const system = typeof error.code !== 'string' || /^E[A-Z0-9]+$/.test(error.code);
      return { scope, written, failed: { stack: item.localName, code: system ? 'STACK_IMPORT_WRITE_FAILED' : error.code,
        message: system ? `the file system refused the write${error.code ? ` (${error.code})` : ''}; what this import had written for the stack was removed.` : error.message,
        ...(typeof error.operation === 'string' ? { target: error.operation } : {}) },
        not_attempted: plan.plans.slice(plan.plans.indexOf(item) + 1).map(row => row.localName) };
    }
  }
  return { scope, written };
}

// A new stack is all or nothing. Its folder is created here, exclusively: a
// folder that appeared since planning belongs to someone else and is refused
// untouched. On failure only the files and directories this call made are
// removed.
function installStack(root, item) {
  mkdirSync(dirname(item.folder), { recursive: true });
  const made = { directories: [], files: [] };
  const directory = path => { if (!existsSync(path)) { directory(dirname(path)); mkdirSync(path); made.directories.push(path); } };
  try {
    try { mkdirSync(item.folder); made.directories.push(item.folder); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      fail('STACK_EXISTS', `${item.relativeFolder} appeared while this import was running; it was left untouched and nothing was written to it.`,
        { next: `Inspect it, then import again or choose another name with --as <name>.` });
    }
    const write = (path, bytes) => { directory(dirname(path)); writeOutputFileAtomic(path, bytes, { code: 'STACK_UNSAFE_PATH' }); made.files.push(path); };
    for (const [path, bytes] of item.contracts) write(join(item.folder, path), bytes);
    write(join(item.folder, STACK_CONFIG_BASENAME), `${JSON.stringify(item.document, null, 2)}\n`);
    const scope = stackScope(root, { stack: item.localName });
    made.files.push(join(item.folder, CONTEXT_BASENAME));
    withStackScope(scope, () => saveContext(root, item.next));
    return scope;
  } catch (error) {
    for (const path of made.files) rmSync(path, { force: true });
    for (const path of made.directories.reverse()) try { rmdirSync(path); } catch { /* not empty: something else is there, and it stays */ }
    throw error;
  }
}

export function importReceipt(plan, { dryRun = false, written } = {}) {
  return { dry_run: dryRun, requests_executed: 0, source: plan.source,
    stacks: plan.plans.filter(item => !written || written.includes(item.localName)).map(item => item.report), layout_files: plan.layout };
}

/** The import record of a local stack's knowledge document, or null. */
export function importRecord(ctx) {
  const record = ctx?.[IMPORT_RECORD_KEY];
  return object(record) && typeof record.source === 'string' ? record : null;
}
