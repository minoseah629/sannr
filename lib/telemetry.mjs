// Usage counts: one small document a day, on unless turned off, never before
// a notice has been printed on this machine. docs/telemetry.md is the human
// page; lib/usage.schema.json is the whole contract with the receiving
// endpoint, and lib/usage-features.json is the only list of names it counts.
//
// What this module is allowed to know: fixed feature names from that file, a
// count per name, a count of executed API requests, the package version, the
// platform family, the Node major version and a random install identifier. It
// never receives a path, an argument, a host, a header or any text a person
// typed, so it cannot leak one.
//
// Rules that shape the code:
//  1. Nothing here may break, slow or change a command. Every entry point is
//     synchronous, bounded local file work wrapped in try/catch; the network
//     send happens in a detached child process (lib/telemetry-send.mjs) that
//     the command never waits for.
//  2. The off switches win before any file is touched: an environment switch,
//     a CI environment, a test runner's mark or a source tree means no state is
//     read or written.
//  3. Off cannot be undone by a send in progress: `telemetry off` takes the
//     send lock, and every other writer writes only while the state on disk
//     still says on.
//  4. A state file that cannot be read or written means nothing is counted,
//     nothing is sent and no notice is shown; `telemetry status` says why.
import { accessSync, chmodSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { devNull, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CLI_NAME, HOME_ENV_NAME, PRODUCT_SEAM_ENV_NAME, PRODUCT_SEAM_SET, PROSE_PRODUCT_TITLE, TELEMETRY_CHECKOUT_ENV_NAME, TELEMETRY_ENV_NAME,
  USAGE_URL, USAGE_USER_AGENT_NAME } from './brand.mjs';
import { machineStatePaths } from './machine-state.mjs';
import { safeOutputPath, writeOutputFile, writeOutputFileAtomic } from './output-path.mjs';
import FEATURE_LIST from './usage-features.json' with { type: 'json' };

export const TELEMETRY_STATE_BASENAME = 'telemetry.json';
export const TELEMETRY_DIRECTORY = 'telemetry';
const COUNTS = 'counts.jsonl', BATCH = 'batch.json', LOCK = '.send.lock', SENT = 'sent', OWNER = 'owner.json';
const DAY_MS = 86_400_000;
export const TELEMETRY_LIMITS = Object.freeze({
  noticeWaitMs: DAY_MS, attemptsPerDay: 3, receiptsKept: 30, timeoutMs: 5_000, lockStaleMs: 60_000, lockWaitMs: 8_000,
  featureMax: 10_000, apiCallsMax: 1_000_000, featuresMax: 64, bytesMax: 2_048,
});
const L = TELEMETRY_LIMITS;
const FEATURE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
export const CI_VARIABLES = Object.freeze(['GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'CIRCLECI', 'JENKINS_URL', 'TF_BUILD', 'TEAMCITY_VERSION']);
const OFF_VALUES = new Set(['0', 'off', 'false', 'no']);
/** Marks common test runners put on the processes they run. */
export const TEST_RUN_VARIABLES = Object.freeze(['NODE_TEST_CONTEXT', 'VITEST', 'JEST_WORKER_ID']);
const SENDER = fileURLToPath(new URL('./telemetry-send.mjs', import.meta.url));
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
/** The only names ever counted. */
export const FEATURES = new Set(FEATURE_LIST);

let packageVersionCache;
function packageVersion() {
  if (packageVersionCache !== undefined) return packageVersionCache;
  try { packageVersionCache = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version; }
  catch { packageVersionCache = null; }
  return packageVersionCache;
}
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// --- the fixed feature names -------------------------------------------------

// The command shapes the CLI recognizes. A subcommand listed here is folded
// into the name (suite_run, saved_run); any other counts as its command; a
// command not listed is not counted. Every name is then checked against
// lib/usage-features.json, so nothing outside that file is ever counted, and
// a test proves these tables produce exactly that file.
const CLI_COMMANDS = Object.freeze({
  workbench: [], saved: ['draft', 'list', 'show', 'create', 'edit', 'run', 'rename', 'delete', 'reopen', 'inspect'],
  migrate: [], audit: [], map: ['reconcile'], graph: ['export', 'record', 'context', 'impact', 'stats'],
  survey: ['generate', 'status', 'query', 'render'], view: [], sessions: [], connect: [], repos: [], grant: [],
  revoke: [], stack: ['add', 'move'], stacks: [], init: [], learn: [], doctor: [], capabilities: [], show: [],
  note: [], verdict: [], import: [], postman: ['capture'], request: [], protocol: [],
  context: ['capture', 'query', 'migrate', 'keys'], suite: ['save', 'run', 'list'], verify: [], receipt: [],
  feedback: [], review: [], prune: [], unwire: [], start: [], mcp: ['inspect'],
});
const CLI_ALIASES = Object.freeze({ status: 'doctor', check: 'doctor', health: 'doctor', ping: 'doctor', disconnect: 'unwire',
  '--version': 'version', '-v': 'version', '--help': 'help', '-h': 'help', help: 'help' });
const VALUE_FLAGS = new Set(['--env', '--stack']);
// Subcommands that are not counted. `workbench` counts launches only: the
// terminal launch and `workbench open`. `status` and `stop` only look at or
// end one, and `serve` is the background process that `open` starts, never a
// command a person runs (see backgroundProcess).
const CLI_UNCOUNTED = Object.freeze({ workbench: ['serve', 'status', 'stop'] });
const known = name => (FEATURES.has(name) ? name : null);

/** Whether this invocation is a process the package starts by itself, whose
 *  output nobody reads: the Workbench service (`workbench serve`, started
 *  detached with its output discarded by `workbench open` and the
 *  api_workbench tool). Such a process never shows or records the notice,
 *  counts no feature for its own start and starts no send. */
export function backgroundProcess(argv) {
  // A person asking for help reads the output: `workbench serve --help` is
  // help like any other command's. The launcher never passes either flag.
  return argv[0] === 'workbench' && argv[1] === 'serve' && !argv.includes('--help') && !argv.includes('-h');
}
// Set once this process is known to be one nobody reads: from then on no
// notice can be recorded in it, and it starts no send. Requests it executes
// still count under the ordinary rule (recordApiCall).
let unattended = false;

/** Every name the CLI tables can produce (for the test that pins the file). */
export function cliFeatureNames() {
  return [...new Set([...Object.values(CLI_ALIASES), ...Object.entries(CLI_COMMANDS)
    .flatMap(([command, subs]) => [command, ...subs.map(sub => `${command}_${sub}`)])])].sort();
}

/** The fixed feature name for one CLI invocation, or null when it has none.
 *  The telemetry command itself is never counted. */
export function cliFeature(argv) {
  const first = argv[0];
  if (first === undefined) return known('help');
  if (first === 'telemetry') return null;
  if (Object.hasOwn(CLI_ALIASES, first)) return known(CLI_ALIASES[first]);
  if (!Object.hasOwn(CLI_COMMANDS, first)) return null;
  if (argv.includes('--help') || argv.includes('-h')) return known('help');
  // Decided on the token the CLI itself dispatches on (argv[1]).
  if (Object.hasOwn(CLI_UNCOUNTED, first) && CLI_UNCOUNTED[first].includes(argv[1])) return null;
  const subs = CLI_COMMANDS[first];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (VALUE_FLAGS.has(token)) { i++; continue; }
    if (token.startsWith('-')) continue;
    return known(subs.includes(token) ? `${first}_${token}` : first);
  }
  return known(first);
}

/** The fixed feature name for one MCP tool call, or null for a name the
 *  server does not declare or the file does not list. */
export function mcpFeature(tool, declared) {
  if (typeof tool !== 'string' || !declared.includes(tool)) return null;
  return known(`mcp_${tool.replaceAll('-', '_')}`);
}

// --- switches, paths and state -------------------------------------------------

// A source tree never counts or sends: contributors' and agents' runs must
// not be in the numbers. Only a test that names the tree's own real path
// switches it on.
// A source tree is a development checkout with or without git: the package
// root holds `.git`, or the repository's own test runner or test suite
// (scripts/test-unit.mjs, test/telemetry.test.mjs). The published package's
// `files` list ships neither, and a packed copy contains neither, so only an
// installed or packed package counts.
export const SOURCE_TREE_MARKERS = Object.freeze(['.git', 'scripts/test-unit.mjs', 'test/telemetry.test.mjs']);
let checkoutCache;
function inCheckout(env) {
  if (checkoutCache === undefined) {
    checkoutCache = SOURCE_TREE_MARKERS.some(marker => {
      try { lstatSync(join(PACKAGE_ROOT, marker)); return true; }
      catch (error) { return error.code !== 'ENOENT' && error.code !== 'ENOTDIR'; }
    });
  }
  if (!checkoutCache) return false;
  const named = env[TELEMETRY_CHECKOUT_ENV_NAME];
  if (typeof named !== 'string' || !named) return true;
  try { return realpathSync(named) !== realpathSync(PACKAGE_ROOT); } catch { return true; }
}

/** What turns telemetry off for this process before any state is read, or null. */
/** The home directory the environment names (HOME; USERPROFILE on Windows),
 *  or null when it names none: missing, empty or not absolute. Decided from
 *  the environment, never from the system's answer for the account. */
export function environmentHome(env = process.env) {
  const home = process.platform === 'win32' ? (env.USERPROFILE || env.HOME) : env.HOME;
  return typeof home === 'string' && home !== '' && isAbsolute(home) ? home : null;
}

export function environmentSwitch(env = process.env) {
  // Off without a home directory (A17e): a process whose environment names no home
  // directory (an MCP host that starts Sannr without one, a misconfigured
  // container) is not a person's machine; nothing is counted, sent, shown or
  // written, anywhere.
  if (!environmentHome(env)) return { source: 'no_home', missing: process.platform === 'win32' ? 'USERPROFILE' : 'HOME' };
  // Off under the product-name test seam, in this process or in the
  // environment asked about: the seam moves the state directory and renames
  // the off switch, so a process run with it must never count, send or show a
  // notice, whatever else is set.
  if (PRODUCT_SEAM_SET || (typeof env[PRODUCT_SEAM_ENV_NAME] === 'string' && env[PRODUCT_SEAM_ENV_NAME] !== '')) return { source: 'seam', variable: PRODUCT_SEAM_ENV_NAME };
  const own = env[TELEMETRY_ENV_NAME];
  if (typeof own === 'string' && OFF_VALUES.has(own.trim().toLowerCase())) return { source: 'environment', variable: TELEMETRY_ENV_NAME };
  if (env.DO_NOT_TRACK === '1') return { source: 'environment', variable: 'DO_NOT_TRACK' };
  if (typeof env.CI === 'string' && env.CI !== '' && !['0', 'false'].includes(env.CI.trim().toLowerCase())) return { source: 'ci', variable: 'CI' };
  for (const name of CI_VARIABLES) if (typeof env[name] === 'string' && env[name] !== '') return { source: 'ci', variable: name };
  // Inside a test run, as in CI: a test of anything else must never count or
  // send, whichever copy of the package (checkout, packed, installed) it runs.
  for (const name of TEST_RUN_VARIABLES) if (typeof env[name] === 'string' && env[name] !== '') return { source: 'test', variable: name };
  if (inCheckout(env)) return { source: 'checkout' };
  return null;
}

function pathsFor(directory) {
  const folder = join(directory, TELEMETRY_DIRECTORY);
  return { directory, state: join(directory, TELEMETRY_STATE_BASENAME), folder,
    counts: join(folder, COUNTS), batch: join(folder, BATCH), lock: join(folder, LOCK), sent: join(folder, SENT) };
}
export function telemetryPaths(env = process.env) {
  return pathsFor(machineStatePaths({ env }).directory);
}
/** The user's default state directory (~/.sannr), whatever SANNR_HOME says.
 *  Off recorded there holds for every process run with this home directory. */
function defaultPaths(env) {
  const { [HOME_ENV_NAME]: _ignored, ...rest } = env;
  return pathsFor(machineStatePaths({ env: rest }).directory);
}
// --- off: a marker that only `telemetry on` removes -------------------------------
//
// Off is its own small file (telemetry.off) beside the record, in the state
// directory where `telemetry off` ran and in the default directory of its
// home. Every reader checks the markers before anything else, and no write of
// the record (by any command or a sender) touches them, so no stale record
// put back by a racing writer can undo off. A marker that exists and cannot be
// read means off. A directory that sees the home's marker copies it as its own
// (inherited), so losing the home's files later does not turn it back on; an
// inherited marker is lifted only by a later `telemetry on` recorded for the
// home (lifted_at).
const MARKER = 'telemetry.off';
const markerPath = paths => join(paths.directory, MARKER);
function readMarker(paths) {
  try { lstatSync(markerPath(paths)); }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? null : { damaged: true }; }
  try {
    safeOutputPath(markerPath(paths));
    const value = JSON.parse(readFileSync(markerPath(paths), 'utf8'));
    if (value?.v !== 1 || !isTime(value.at) || (value.epoch !== null && !/^[0-9a-f]{16}$/.test(value.epoch ?? ''))) return { damaged: true };
    return { at: value.at, epoch: value.epoch, inherited: value.inherited === true, dirs: Array.isArray(value.dirs) ? value.dirs.filter(d => typeof d === 'string') : [] };
  } catch { return { damaged: true }; }
}
function writeMarker(paths, marker) {
  privateDirectory(paths.directory);
  writeOutputFileAtomic(markerPath(paths), `${JSON.stringify({ v: 1, ...marker })}\n`, { mode: 0o600 });
}
function createMarkerIfAbsent(paths, marker) {
  try {
    privateDirectory(paths.directory);
    const temp = join(paths.directory, `telemetry.off.new-${process.pid}-${randomBytes(4).toString('hex')}`);
    writeOutputFile(temp, `${JSON.stringify({ v: 1, ...marker })}\n`, { mode: 0o600 });
    try { linkSync(temp, markerPath(paths)); } catch { /* one exists */ } finally { try { unlinkSync(temp); } catch { /* gone */ } }
  } catch { /* the home's marker still holds this directory off */ }
}

/** Why this state directory is off by a marker or a damaged record of its home,
 *  or null. Checked before anything else by every reader. */
function offReason(paths, env) {
  const own = readMarker(paths);
  const user = defaultPaths(env), same = user.directory === paths.directory;
  if (own?.damaged) return { source: 'marker_damaged', file: markerPath(paths) };
  if (own && !own.inherited) return { source: 'command', file: markerPath(paths) };
  if (own?.inherited) {
    const lifted = same ? null : readState(user);
    const liftedAt = lifted?.kind === 'state' ? lifted.state.lifted_at : null;
    if (!(liftedAt && Date.parse(liftedAt) > Date.parse(own.at))) return { source: 'home', file: markerPath(paths), inherited: true };
  }
  if (same) return null;
  const home = readMarker(user);
  if (home) {
    if (!home.damaged && (!own || own.inherited && own.at !== home.at)) createMarkerIfAbsent(paths, { at: home.at, epoch: home.epoch ?? null, inherited: true });
    return { source: home.damaged ? 'home_marker_damaged' : 'home', file: markerPath(user) };
  }
  // A record that exists and cannot be read means off; a home directory
  // that is unusable (no record can exist there) does not.
  let recordExists = false;
  try { lstatSync(user.state); recordExists = true; } catch { /* absent, or no directory to hold it */ }
  if (recordExists && readState(user).kind === 'broken') return { source: 'home_record_damaged', file: user.state };
  return null;
}
function offByDefaultHome(paths, env) { return Boolean(offReason(paths, env)); }
// The epoch of the home's latest off: from its marker while off, then from
// its record (written by `on`). A directory whose own epoch differs still
// holds an identifier or counts from before that off; they are discarded
// before it counts or sends again (reconcile).
// Every state directory records itself with its home when first used, so
// `telemetry off` can mark all of them at once (A5k): one path per line in
// ~/.sannr/telemetry.dirs, appended, never rewritten.
const DIRS = 'telemetry.dirs';
export const DIRECTORY_LIST_MAX = 256;
// An entry is an absolute path to a directory that exists; anything else is
// dropped. The newest entries are kept, at most DIRECTORY_LIST_MAX of them.
const isUsableDirectory = dir => {
  if (typeof dir !== 'string' || !isAbsolute(dir) || dir !== dir.trim()) return false;
  try { return statSync(dir).isDirectory(); } catch { return false; }
};
/** { dirs, readable, problem }: readable is false when the list exists and
 *  cannot be read. A missing list is readable and empty. Bounded whatever the
 *  file holds: only its last DIRECTORY_LIST_BYTES are read and only its last
 *  DIRECTORY_LIST_SCAN lines are looked at. */
const DIRECTORY_LIST_BYTES = 256 * 1024, DIRECTORY_LIST_SCAN = 4 * DIRECTORY_LIST_MAX;
function readDirectoryList(user) {
  let text, truncated = false, fd;
  try {
    fd = openSync(join(user.directory, DIRS), 'r');
    const size = fstatSync(fd).size, length = Math.min(size, DIRECTORY_LIST_BYTES);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) { const n = readSync(fd, buffer, read, length - read, size - length + read); if (!n) break; read += n; }
    truncated = size > length;
    text = buffer.subarray(0, read).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return { dirs: [], readable: true, lines: 0 };
    return { dirs: [], readable: false, lines: 0, problem: error.code ?? 'unreadable' };
  } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
  let lines = text.split('\n');
  if (truncated) lines.shift(); // a partial first line
  lines = lines.filter(Boolean);
  const total = truncated ? Infinity : lines.length;
  const dirs = [];
  // Newest first; the last occurrence of a path wins its place.
  for (const line of lines.slice(-DIRECTORY_LIST_SCAN).reverse()) {
    if (dirs.length >= DIRECTORY_LIST_MAX) break;
    if (!dirs.includes(line) && isUsableDirectory(line)) dirs.push(line);
  }
  return { dirs: dirs.reverse(), readable: true, lines: total };
}
const knownDirectories = user => readDirectoryList(user).dirs;
function writeDirectoryList(user, dirs) {
  writeOutputFileAtomic(join(user.directory, DIRS), dirs.length ? `${dirs.join('\n')}\n` : '', { mode: 0o600 });
}
function registerDirectory(paths, env) {
  try {
    const user = defaultPaths(env);
    if (user.directory === paths.directory) return;
    const list = readDirectoryList(user);
    if (!list.readable || list.dirs.includes(paths.directory)) return;
    privateDirectory(user.directory);
    // Prune when the file holds more than it should; otherwise append.
    if (list.lines >= DIRECTORY_LIST_MAX) writeDirectoryList(user, [...list.dirs, paths.directory].slice(-DIRECTORY_LIST_MAX));
    else writeOutputFile(join(user.directory, DIRS), `${paths.directory}\n`, { append: true, mode: 0o600 });
  } catch { /* a home that cannot record it still holds it off through its marker */ }
}
function homeEpoch(paths, env) {
  const user = defaultPaths(env);
  if (user.directory === paths.directory) return null;
  const marker = readMarker(user);
  if (marker && !marker.damaged) return marker.epoch ?? null;
  const record = readState(user);
  return record.kind === 'state' ? record.state.epoch ?? null : null;
}

const isDate = value => typeof value === 'string' && DATE.test(value);
const isTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validState(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && value.v === 1
    && ['on', 'off'].includes(value.state) && ['default', 'command'].includes(value.set_by)
    && (value.noticed_at === null || isTime(value.noticed_at))
    && (value.install === null || typeof value.install === 'string' && UUID_V4.test(value.install))
    && (value.since === undefined || value.since === null || isDate(value.since))
    && (value.last_sent === null || isDate(value.last_sent))
    && (value.attempt_day === null || isDate(value.attempt_day))
    && Number.isSafeInteger(value.attempts) && value.attempts >= 0
    && (value.epoch === undefined || value.epoch === null || typeof value.epoch === 'string' && /^[0-9a-f]{16}$/.test(value.epoch))
    && (value.lifted_at === undefined || value.lifted_at === null || isTime(value.lifted_at));
}

/** { kind: 'untold' } | { kind: 'state', state } | { kind: 'broken', problem } */
export function readState(paths) {
  let bytes;
  try {
    if (!lstatSync(paths.directory).isDirectory())
      return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_DIRECTORY_INVALID', message: 'The machine state directory is not a directory.' } };
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'untold' };
    return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_UNREADABLE', message: 'The machine state directory cannot be read.' } };
  }
  try {
    safeOutputPath(paths.state);
    bytes = readFileSync(paths.state, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'untold' };
    return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_UNREADABLE', message: 'The telemetry state file cannot be read safely.' } };
  }
  let value;
  try { value = JSON.parse(bytes); } catch { value = null; }
  if (!validState(value)) return { kind: 'broken', problem: { code: 'TELEMETRY_STATE_INVALID', message: 'The telemetry state file is damaged.' } };
  return { kind: 'state', state: value };
}

function privateDirectory(path) {
  safeOutputPath(path, { directory: true });
  mkdirSync(path, { recursive: true, mode: 0o700 });
}
const stateBytes = state => `${JSON.stringify(state)}\n`;

function writeState(paths, state) {
  privateDirectory(paths.directory);
  writeOutputFileAtomic(paths.state, stateBytes(state), { mode: 0o600 });
}
// The notice creates the record only where none exists: a hard link of a
// complete private file either appears whole or fails because a record (for
// example a concurrent off) is already there.
function createState(paths, state) {
  privateDirectory(paths.directory);
  safeOutputPath(paths.state);
  const temp = join(paths.directory, `telemetry.new-${process.pid}-${randomBytes(4).toString('hex')}.json`);
  writeOutputFile(temp, stateBytes(state), { mode: 0o600 });
  try { linkSync(temp, paths.state); return true; }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  finally { try { unlinkSync(temp); } catch { /* already gone */ } }
}
// THE ONE PATH for every change of an existing record, by any command or by
// the sender: it holds the send lock (taken here, waiting up to waitMs, or
// handed in by its holder as `nonce`), re-reads the record, and writes what
// `change(current)` returns (null writes nothing). A recorded off becomes on
// only through `telemetry on` (allowOn). The only other writes are the notice's
// creation of a record where none exists (createState) and the removal of
// that same record when the notice could not be written (withdrawNotice).
//
// Off is protected by four layers, each of which would hold on its own:
// `off` takes the lock; every automatic change re-reads under the lock; an
// automatic change writes only while the record still says on for the same
// install; and the sender re-checks before it posts. The tests can only show
// the loss of all of them together; the redundancy is deliberate.
function changeState(paths, change, { now = Date.now(), nonce = null, waitMs = 0 } = {}) {
  let own = null;
  if (!nonce) {
    const attempt = lockAttempt(paths, now, waitMs);
    if (!attempt.nonce) return { written: false, locked: false, reason: attempt.reason };
    own = attempt.nonce;
  }
  try {
    const current = readState(paths);
    const next = change(current);
    if (!next) return { written: false, locked: true, current };
    writeState(paths, next);
    return { written: true, locked: true, state: next };
  } finally { if (own) releaseLock(paths, own); }
}
// Discard the identifier, unsent counts and receipts of one directory.
// Called only while the caller holds that directory's lock.
function discardData(paths) {
  const removed = [];
  for (const [label, path] of [['unsent counts', paths.counts], ['unsent counts', paths.batch], ['receipts', paths.sent]]) {
    try { lstatSync(path); rmSync(path, { recursive: true, force: true }); if (!removed.includes(label)) removed.push(label); }
    catch { /* already absent */ }
  }
  for (const file of journalFiles(paths)) rmSync(file, { force: true });
  return removed;
}
const newEpoch = () => randomBytes(8).toString('hex');

const freshState = (fields = {}) => ({ v: 1, state: 'on', set_by: 'default', noticed_at: null, install: null,
  since: null, last_sent: null, attempt_day: null, attempts: 0, epoch: null, ...fields });
// The day's record survives off, on and reset: one document per UTC day.
const dayRecord = state => state ? { last_sent: state.last_sent, attempt_day: state.attempt_day, attempts: state.attempts } : {};
const utcDay = now => new Date(now).toISOString().slice(0, 10);

// --- the notice ----------------------------------------------------------------

/** The notice, one paragraph. Its wording is the product's promise; keep it
 *  plain and keep every element docs/telemetry.md lists. */
export function noticeText() {
  const host = new URL(USAGE_URL).host;
  return `${PROSE_PRODUCT_TITLE} telemetry: once a day ${PROSE_PRODUCT_TITLE} sends usage counts to ${host}: `
    + `a random install ID (derived from nothing on this machine; the same every day, so one day's counts can be linked to the next), `
    + `the ${PROSE_PRODUCT_TITLE} version, the operating system (with processor type and Node.js major version), `
    + `how many times each ${PROSE_PRODUCT_TITLE} command and MCP tool ran, and how many API calls went through it. `
    + `Nothing about your repositories, APIs or requests is sent. It is on unless you turn it off: run \`${CLI_NAME} telemetry off\`, `
    + `or tell your agent "opt out". \`${CLI_NAME} telemetry show\` prints exactly what is sent. `
    + `Nothing has been sent from this state directory yet; its first send is no earlier than 24 hours from now.`;
}

/** True when a text block is Sannr's notice: it begins with the notice's
 *  fixed opening words. `mcp inspect` uses it to show a notice that reached it
 *  in a tool result (USE-1 A9.3). */
export function isNoticeText(text) {
  return typeof text === 'string' && text.startsWith(noticeText().split(' sends usage counts')[0]);
}
/** True when a line of output carries the notice: the line begins with it,
 *  or it is JSON (a whole object, or one member line of an indented object)
 *  whose telemetry_notice begins with it, as `connect` writes it (A10.1). */
export function isNoticeLine(line) {
  if (isNoticeText(line)) return true;
  if (typeof line !== 'string' || !line.includes('"telemetry_notice"')) return false;
  const text = line.trim();
  for (const candidate of [text, `{${text.replace(/,$/, '')}}`]) {
    try {
      const value = JSON.parse(candidate);
      if (value && typeof value === 'object' && isNoticeText(value.telemetry_notice)) return true;
    } catch { /* not this form */ }
  }
  return false;
}

/** True when descriptor `fd` is the platform's null device: both are
 *  character devices with the same device number (rdev), however the
 *  descriptor was reached (another mount namespace, chroot or sandbox). A
 *  notice written there is read by nobody and is never recorded (USE-1 A9.2,
 *  A10.2). False when either cannot be read or the platform gives no device
 *  number (Windows' NUL is not detected). */
function nullDevice(fd) {
  try {
    const stream = fstatSync(fd), device = statSync(devNull);
    return stream.isCharacterDevice() && device.isCharacterDevice() && device.rdev !== 0 && stream.rdev === device.rdev;
  } catch { return false; }
}

// Record that the notice was emitted. Returns true only when this call
// created the record: a machine that cannot keep the record, or already has
// one, is not shown the notice again.
function recordNotice(paths, now, env = process.env) {
  if (unattended || readState(paths).kind !== 'untold') return false;
  try {
    const created = createState(paths, freshState({ noticed_at: new Date(now).toISOString(), epoch: homeEpoch(paths, env) }));
    if (created) registerDirectory(paths, env);
    return created;
  } catch { return false; }
}

// --- counting --------------------------------------------------------------------

// The one test of "may this process count or send now". Off markers first.
function active(paths, env) {
  if (environmentSwitch(env) || offReason(paths, env)) return null;
  const current = readState(paths);
  if (!(current.kind === 'state' && current.state.state === 'on' && current.state.noticed_at)) return null;
  return current.state;
}

function appendCount(paths, line) {
  privateDirectory(paths.folder);
  writeOutputFile(paths.counts, `${line}\n`, { append: true, mode: 0o600 });
}

/** Count one run of a fixed feature name. Never throws. */
export function recordFeature(name, { env = process.env } = {}) {
  try {
    if (!FEATURES.has(name)) return;
    const paths = telemetryPaths(env);
    if (active(paths, env)) appendCount(paths, JSON.stringify({ f: name }));
  } catch { /* counting never affects a command */ }
}

/** Count one request executed against the person's APIs (not doctor's probe,
 *  not a feedback send). Kept apart from the usage log, which a person may
 *  redirect. Never throws. */
export function recordApiCall({ env = process.env } = {}) {
  try {
    const paths = telemetryPaths(env);
    if (active(paths, env)) appendCount(paths, '{"a":1}');
  } catch { /* counting never affects a request */ }
}

const emptyCounts = () => ({ features: {}, api_calls: 0 });
function addCounts(into, line) {
  let row;
  try { row = JSON.parse(line); } catch { return; }
  if (!row || typeof row !== 'object') return;
  if (typeof row.f === 'string' && FEATURES.has(row.f))
    into.features[row.f] = Math.min(L.featureMax, (Object.hasOwn(into.features, row.f) ? into.features[row.f] : 0) + 1);
  if (row.a === 1) into.api_calls = Math.min(L.apiCallsMax, into.api_calls + 1);
}
function readBatch(paths) {
  try {
    safeOutputPath(paths.batch);
    const value = JSON.parse(readFileSync(paths.batch, 'utf8'));
    const out = emptyCounts();
    if (Number.isSafeInteger(value?.api_calls) && value.api_calls > 0) out.api_calls = Math.min(L.apiCallsMax, value.api_calls);
    for (const [name, count] of Object.entries(value?.features ?? {}))
      if (FEATURES.has(name) && Number.isSafeInteger(count) && count > 0) out.features[name] = Math.min(L.featureMax, count);
    return out;
  } catch { return emptyCounts(); }
}
function journalFiles(paths) {
  let names = [];
  try { safeOutputPath(paths.folder, { directory: true }); names = readdirSync(paths.folder); } catch { return []; }
  return names.filter(name => name === COUNTS || /^counts\.fold-[0-9a-f-]+\.jsonl$/.test(name)).sort().map(name => join(paths.folder, name));
}
function sumJournal(into, file) {
  try {
    safeOutputPath(file);
    for (const line of readFileSync(file, 'utf8').split('\n')) if (line) addCounts(into, line);
  } catch { /* an unreadable journal contributes nothing */ }
}

/** Unsent counts as they stand, without changing anything. */
function peekCounts(paths) {
  const counts = readBatch(paths);
  for (const file of journalFiles(paths)) sumJournal(counts, file);
  return counts;
}

/** Move every journal into the batch. Runs only under the send lock. */
function foldCounts(paths) {
  const counts = readBatch(paths);
  const folding = [];
  for (const file of journalFiles(paths)) {
    if (file === paths.counts) {
      const target = join(paths.folder, `counts.fold-${process.pid}-${randomBytes(4).toString('hex')}.jsonl`);
      try { renameSync(file, target); folding.push(target); } catch { /* appended concurrently or gone */ }
    } else folding.push(file);
  }
  for (const file of folding) sumJournal(counts, file);
  writeOutputFileAtomic(paths.batch, `${JSON.stringify(counts)}\n`, { mode: 0o600 });
  for (const file of folding) rmSync(file, { force: true });
  return counts;
}

// --- the document ------------------------------------------------------------------

const osFamily = () => ['darwin', 'linux', 'win32'].includes(process.platform) ? process.platform : 'other';
const archFamily = () => ['arm64', 'x64'].includes(process.arch) ? process.arch : 'other';
const nodeMajor = () => Number(process.versions.node.split('.')[0]);

/** The document for these counts. Features beyond 64 or the 2,048-byte bound
 *  stay unsent (largest counts go first) and wait for the next document. */
export function buildDocument({ install, since, counts }) {
  const version = packageVersion();
  if (typeof version !== 'string' || !VERSION.test(version)) return null;
  const node = nodeMajor();
  if (!(node >= 18 && node <= 99)) return null;
  const ordered = Object.entries(counts.features).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const chosen = {};
  const render = features => JSON.stringify({ v: 1, install, version, os: osFamily(), arch: archFamily(), node, since,
    features: Object.fromEntries(Object.entries(features).sort((a, b) => (a[0] < b[0] ? -1 : 1))),
    api_calls: Math.min(L.apiCallsMax, counts.api_calls) });
  for (const [name, count] of ordered) {
    if (Object.keys(chosen).length >= L.featuresMax) break;
    const next = { ...chosen, [name]: Math.min(L.featureMax, count) };
    if (Buffer.byteLength(render(next)) > L.bytesMax) continue;
    chosen[name] = next[name];
  }
  const body = render(chosen);
  return { body, document: JSON.parse(body) };
}

// One document per UTC day per machine state, whatever the identifier: reset
// keeps the day's record.
function dueReason(state, now) {
  if (!state.noticed_at) return 'notice_pending';
  if (Date.parse(state.noticed_at) + L.noticeWaitMs > now) return 'notice_too_recent';
  const today = utcDay(now);
  if (state.last_sent === today) return 'sent_today';
  if (state.attempt_day === today && state.attempts >= L.attemptsPerDay) return 'attempts_exhausted';
  return null;
}

// --- the send lock ---------------------------------------------------------------
//
// A directory that appears with its owner record already inside it (a renamed
// private directory), so a lock is never seen without its owner. Its age is
// the time written inside it, never a file time: processes on one machine
// share a clock, file systems need not.

function readOwner(paths) {
  try {
    const stat = lstatSync(paths.lock);
    if (!stat.isDirectory()) return { broken: true };
    const owner = JSON.parse(readFileSync(join(paths.lock, OWNER), 'utf8'));
    if (typeof owner?.nonce !== 'string' || !Number.isFinite(owner.created_at)) return { broken: true };
    return owner;
  } catch (error) {
    if (error.code === 'ENOENT' && !existsLock(paths)) return null;
    return { broken: true };
  }
}
function existsLock(paths) { try { lstatSync(paths.lock); return true; } catch { return false; } }
// A lock whose recorded owner has ended is not waited for: an interrupted
// command, or a sender that died, leaves it behind.
function ownerAlive(owner) {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}
function lockStale(owner, now) {
  return owner.broken || Math.abs(now - owner.created_at) > L.lockStaleMs || !ownerAlive(owner);
}
function discardLock(paths, judged) {
  try {
    const stat = lstatSync(paths.lock);
    if (!stat.isDirectory()) { rmSync(paths.lock, { force: true }); return; }
    const trash = join(paths.folder, `.send.lock.stale-${randomBytes(4).toString('hex')}`);
    renameSync(paths.lock, trash);
    // Put back a lock that changed hands since it was judged stale.
    let moved = null;
    try { moved = JSON.parse(readFileSync(join(trash, OWNER), 'utf8')); } catch { /* broken */ }
    if (judged && !judged.broken && moved?.nonce !== judged.nonce) { try { renameSync(trash, paths.lock); return; } catch { /* taken */ } }
    try { chmodSync(trash, 0o700); } catch { /* an unreadable lock is still removed below if it can be */ }
    rmSync(trash, { recursive: true, force: true });
  } catch { /* someone else discarded it */ }
}

/** The lock's nonce when acquired, otherwise null. */
function acquireLock(paths, now) {
  privateDirectory(paths.folder);
  const nonce = randomBytes(8).toString('hex');
  const temp = join(paths.folder, `.send.lock.new-${nonce}`);
  mkdirSync(temp, { mode: 0o700 });
  try {
    writeFileSync(join(temp, OWNER), JSON.stringify({ nonce, created_at: now, pid: process.pid }), { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // A rename onto an existing lock fails (or, for an empty broken
        // directory, replaces it), so exactly one contender holds the name.
        if (existsLock(paths) && attempt === 0) throw Object.assign(new Error('held'), { code: 'EEXIST' });
        renameSync(temp, paths.lock);
        return nonce;
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'ENOTDIR', 'EISDIR', 'EBUSY'].includes(error.code)) throw error;
        const owner = readOwner(paths);
        if (owner && !lockStale(owner, now)) return null;
        discardLock(paths, owner);
      }
    }
    return null;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
/** acquireLock, retrying for up to waitMs while a live owner holds it. */
// The lock, or why not: 'busy' only when a live owner holds it past the
// wait, 'unwritable' when the lock cannot be made at all.
function lockAttempt(paths, now, waitMs = 0) {
  const end = Date.now() + waitMs;
  for (;;) {
    let nonce = null;
    try { nonce = acquireLock(paths, now); } catch { return { nonce: null, reason: 'unwritable' }; }
    if (nonce) return { nonce };
    if (Date.now() >= end) return { nonce: null, reason: 'busy' };
    sleep(50);
  }
}
const takeLock = (paths, now, waitMs = 0) => lockAttempt(paths, now, waitMs).nonce;
// The sender becomes the recorded owner of the lock it was handed, so a lock
// whose holder has ended is recognized as such.
function handOver(paths, nonce, pid) {
  const owner = readOwner(paths);
  if (!owner || owner.broken || owner.nonce !== nonce) return;
  writeOutputFileAtomic(join(paths.lock, OWNER), JSON.stringify({ ...owner, pid }), { mode: 0o600 });
}
export function releaseLock(paths, nonce) {
  try {
    const owner = readOwner(paths);
    if (owner && !owner.broken && owner.nonce === nonce) rmSync(paths.lock, { recursive: true, force: true });
  } catch { /* a stale lock is replaced later */ }
}

// Receipts: <stamp>-<id>.json while prepared, renamed with the outcome.
const RECEIPT = /^(\d{8}T\d{6}Z-[0-9a-f]{8})(?:\.(delivered|not-delivered))?\.json$/;
function pruneReceipts(paths) {
  try {
    const names = readdirSync(paths.sent).filter(name => RECEIPT.test(name)).sort();
    for (const name of names.slice(0, Math.max(0, names.length - L.receiptsKept))) rmSync(join(paths.sent, name), { force: true });
  } catch { /* pruning is best effort */ }
}

function senderEnvironment(env) {
  // No proxy variable may redirect the send.
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(https?|all|no)_proxy$/i.test(key) || key === 'NODE_USE_ENV_PROXY') continue;
    out[key] = key === 'NODE_OPTIONS' ? value.split(/\s+/).filter(token => token !== '--use-env-proxy').join(' ') : value;
  }
  return out;
}

/** When a document is due, prepare it (counts folded, receipt written, the
 *  attempt recorded) and hand it to a detached sender. Never waits, never throws. */
export function maybeSend({ env = process.env, now = Date.now() } = {}) {
  let paths, nonce = null;
  try {
    if (unattended) return false;
    paths = telemetryPaths(env);
    const state = active(paths, env);
    if (!state || dueReason(state, now)) return false;
    nonce = acquireLock(paths, now);
    if (!nonce) return false;
    // Recheck under the lock: another process may have sent meanwhile.
    const reread = readState(paths);
    if (reread.kind !== 'state' || dueReason(reread.state, now)) return false;
    const current = reread.state;
    const today = utcDay(now), install = current.install ?? randomUUID();
    const counts = foldCounts(paths);
    const built = buildDocument({ install, since: current.since, counts });
    if (!built) return false;
    const recorded = changeState(paths, read => read.kind === 'state' && read.state.install === current.install
      ? { ...read.state, install, attempt_day: today, attempts: read.state.attempt_day === today ? read.state.attempts + 1 : 1 } : null,
    { now, nonce });
    if (!recorded.written) return false;
    privateDirectory(paths.sent);
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const receipt = join(paths.sent, `${stamp}-${randomBytes(4).toString('hex')}.json`);
    writeOutputFileAtomic(receipt, built.body, { mode: 0o600 });
    pruneReceipts(paths);
    // The sender holds the state directory, never the project, as its cwd.
    const child = spawn(process.execPath, [SENDER, receipt, nonce], { detached: true, stdio: 'ignore', windowsHide: true,
      cwd: paths.folder, env: senderEnvironment(env) });
    const held = nonce;
    child.on('error', () => releaseLock(paths, held));
    child.unref();
    if (child.pid) handOver(paths, held, child.pid);
    nonce = null; // the sender owns the lock now
    return true;
  } catch { return false; }
  finally { if (nonce) releaseLock(paths, nonce); }
}

function markReceipt(receipt, outcome) {
  try { renameSync(receipt, receipt.replace(/\.json$/, `.${outcome}.json`)); } catch { /* the bytes stay as prepared */ }
}

/** The detached sender's work: POST the receipt's exact bytes once. Counts are
 *  cleared only on a 2xx answer. */
export async function deliver(receipt, nonce, { env = process.env } = {}) {
  const paths = telemetryPaths(env);
  try {
    safeOutputPath(receipt);
    const bytes = readFileSync(receipt);
    const sentDocument = JSON.parse(bytes.toString('utf8'));
    // The one check, immediately before the request: an off written at any
    // point up to here stops it (A5g, F5).
    const state = active(paths, env);
    if (!state || !state.install || sentDocument.install !== state.install) return;
    let ok = false;
    // A referenced timer: an unanswered request must end by the deadline even
    // when nothing else keeps this process alive.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), L.timeoutMs);
    try {
      const response = await fetch(USAGE_URL, { method: 'POST', body: bytes, redirect: 'manual', credentials: 'omit',
        headers: { 'content-type': 'application/json', 'user-agent': `${USAGE_USER_AGENT_NAME}/${packageVersion()}` },
        signal: controller.signal });
      ok = response.status >= 200 && response.status < 300;
      try { await response.body?.cancel(); } catch { /* nothing to read */ }
    } catch { ok = false; }
    finally { clearTimeout(timer); }
    markReceipt(receipt, ok ? 'delivered' : 'not-delivered');
    if (!ok) return;
    // Recorded only while the state still says on for this install: an off or
    // reset made while the request was out wins.
    const day = state.attempt_day;
    const recorded = changeState(paths, read => read.kind === 'state' && read.state.install === sentDocument.install
      ? { ...read.state, last_sent: day, since: day } : null, { nonce });
    if (!recorded.written) return;
    const batch = readBatch(paths);
    for (const name of Object.keys(sentDocument.features ?? {})) delete batch.features[name];
    batch.api_calls = 0;
    writeOutputFileAtomic(paths.batch, `${JSON.stringify(batch)}\n`, { mode: 0o600 });
  } catch { /* the sender has no one to report to */ }
  finally { releaseLock(paths, nonce); }
}

// --- the entry points --------------------------------------------------------------

/** Write the notice to standard error. False when the write failed (a pipe
 *  whose reader has gone, a closed descriptor): nobody received it. */
function writeNotice(text) {
  try { writeSync(2, `${text}\n`); return true; } catch { return false; }
}
// The notice is recorded before it is written, so a machine that cannot keep
// the record is never shown it twice. When the write then fails, this process
// knows nobody received it: the record it created a moment ago is removed and
// the next command that can write is told. Only that exact record is removed
// (on by default, this notice time, no identifier, no attempt); a record that
// `telemetry off`, `on` or anything else has touched since is left alone, and
// off is held by its marker, never by this file. The lock is taken when it is
// free so no writer puts the record back; a failure here leaves the record.
function withdrawNotice(paths, noticedAt, now) {
  let nonce = null;
  try {
    nonce = takeLock(paths, now, 250);
    const current = readState(paths);
    const mine = current.kind === 'state' && current.state.state === 'on' && current.state.set_by === 'default'
      && current.state.noticed_at === noticedAt && !current.state.install && !current.state.attempt_day && !current.state.last_sent;
    if (mine) unlinkSync(paths.state);
  } catch { /* the record stays */ }
  finally { if (nonce) releaseLock(paths, nonce); }
}

/** Called once at the start of every CLI invocation, before anything prints.
 *  Synchronous and bounded; never throws. A dry run writes nothing, records no
 *  notice and starts no send. `connect` emits its notice in its own output
 *  instead (takeConnectNotice). */
export function cliStart(argv, { env = process.env, now = Date.now() } = {}) {
  try {
    // A process the package started by itself writes where nobody reads: it
    // takes no notice, counts nothing for its own start and starts no send.
    if (backgroundProcess(argv)) { unattended = true; return; }
    if (argv[0] === 'telemetry' || argv.includes('--dry-run') || environmentSwitch(env)) return;
    const paths = telemetryPaths(env);
    const feature = cliFeature(argv);
    reconcile(paths, env, now);
    const current = readState(paths);
    if (current.kind === 'state') registerDirectory(paths, env);
    if (current.kind === 'untold') {
      if (argv[0] === 'connect' || offByDefaultHome(paths, env)) return;
      if (nullDevice(2) || !recordNotice(paths, now, env)) return;
      if (!writeNotice(noticeText())) { withdrawNotice(paths, new Date(now).toISOString(), now); return; }
    } else if (current.kind !== 'state') return;
    // A due document carries the counts up to now; this run joins the next one,
    // so `telemetry show` immediately before a command shows what it sends.
    // A command run --offline starts no send.
    if (!argv.includes('--offline')) maybeSend({ env, now });
    if (feature) recordFeature(feature, { env });
  } catch { /* telemetry never affects a command */ }
}

// Clean-up, done whenever the lock is free: a directory that is off discards
// any identifier and counts it still holds (off itself never waits for a
// sender), and a directory holding data from before its home's latest off
// discards it before it counts or sends again (A5e).
function hasData(paths) {
  return [paths.counts, paths.batch, paths.sent].some(path => { try { lstatSync(path); return true; } catch { return false; } })
    || journalFiles(paths).length > 0;
}
function reconcile(paths, env, now) {
  try {
    const off = offReason(paths, env), epoch = homeEpoch(paths, env);
    const current = readState(paths);
    const stale = current.kind === 'state' && Boolean(epoch) && (current.state.epoch ?? null) !== epoch;
    const leftovers = Boolean(off) && (current.kind === 'state' && Boolean(current.state.install) || hasData(paths));
    if (!stale && !leftovers) return;
    const nonce = takeLock(paths, now, 0);
    if (!nonce) return;
    try {
      discardData(paths);
      changeState(paths, again => again.kind === 'state'
        ? { ...again.state, install: null, since: null, epoch: epoch ?? again.state.epoch ?? null } : null, { now, nonce });
    } finally { releaseLock(paths, nonce); }
  } catch { /* retried at the next use; nothing counts meanwhile (active) */ }
}

/** For connect: the notice text when this is the moment it is first emitted on
 *  this machine (it is then recorded), otherwise null. Never throws. */
export function takeConnectNotice({ env = process.env, now = Date.now() } = {}) {
  try {
    if (environmentSwitch(env)) return null;
    const paths = telemetryPaths(env);
    if (offByDefaultHome(paths, env) || nullDevice(1) || !recordNotice(paths, now, env)) return null;
    recordFeature('connect', { env });
    return noticeText();
  } catch { return null; }
}

let mcpNoticeSettled = false;
/** Count one MCP tool call and start a due send in the background. */
export function mcpToolCall(tool, declared, { env = process.env, now = Date.now() } = {}) {
  try {
    if (environmentSwitch(env)) return;
    const paths = telemetryPaths(env);
    reconcile(paths, env, now);
    // The server records its state directory as the CLI does (A5l).
    if (readState(paths).kind === 'state') registerDirectory(paths, env);
    maybeSend({ env, now });
    recordFeature(mcpFeature(tool, declared), { env });
  } catch { /* never affects a tool call */ }
}
/** The notice for the first tool result on this machine, recorded as emitted
 *  when returned; null otherwise. Never throws. */
export function takeMcpNotice({ env = process.env, now = Date.now() } = {}) {
  if (mcpNoticeSettled) return null;
  try {
    if (environmentSwitch(env)) { mcpNoticeSettled = true; return null; }
    const paths = telemetryPaths(env);
    const current = readState(paths);
    if (current.kind !== 'untold') { if (current.kind === 'state') mcpNoticeSettled = true; return null; }
    if (offByDefaultHome(paths, env)) { mcpNoticeSettled = true; return null; }
    if (!recordNotice(paths, now, env)) return null;
    mcpNoticeSettled = true;
    return noticeText();
  } catch { return null; }
}

// --- the telemetry command -------------------------------------------------------------

function stateProblem(paths) {
  try {
    const stat = statSync(paths.directory);
    if (!stat.isDirectory()) return { code: 'TELEMETRY_STATE_DIRECTORY_INVALID', message: 'The machine state directory is not a directory.' };
    accessSync(paths.directory, constants.W_OK);
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') {
      for (let parent = dirname(paths.directory); ; parent = dirname(parent)) {
        try { accessSync(parent, constants.W_OK); return null; }
        catch (inner) {
          if (inner.code !== 'ENOENT') return { code: 'TELEMETRY_STATE_UNWRITABLE', message: 'The machine state directory cannot be created.' };
        }
        if (dirname(parent) === parent) return null;
      }
    }
    if (error.code === 'ENOTDIR') return { code: 'TELEMETRY_STATE_DIRECTORY_INVALID', message: 'The machine state directory is not a directory.' };
    return { code: 'TELEMETRY_STATE_UNWRITABLE', message: 'The machine state directory is not writable.' };
  }
}

function receipts(paths) {
  const out = { last_attempt: null, last_delivered: null };
  try {
    safeOutputPath(paths.sent, { directory: true });
    const names = readdirSync(paths.sent).filter(name => RECEIPT.test(name)).sort();
    const read = name => { const path = join(paths.sent, name); safeOutputPath(path); return { path, body: readFileSync(path, 'utf8') }; };
    if (names.length) {
      const name = names.at(-1), outcome = RECEIPT.exec(name)[2] ?? 'prepared';
      out.last_attempt = { outcome, ...read(name) };
    }
    const delivered = names.filter(name => RECEIPT.exec(name)[2] === 'delivered').at(-1);
    if (delivered) out.last_delivered = read(delivered);
  } catch { /* none */ }
  return out;
}

function lockStatus(paths, now) {
  const owner = readOwner(paths);
  if (!owner) return null;
  if (!lockStale(owner, now)) return 'held by a send in progress';
  return !owner.broken && !ownerAlive(owner) ? 'left by a process that has ended: replaced by the next send' : 'stale: replaced by the next send';
}

const NO_HOME_MESSAGE = 'This environment names no home directory (HOME is missing, empty or not an absolute path), so telemetry is off for this process: nothing is counted, sent, shown or written for it.';
const noHomeFailure = () => Object.assign(new Error(`${NO_HOME_MESSAGE} Run it with HOME set to change the setting for that home directory.`), { code: 'TELEMETRY_NO_HOME' });
function noHomeStatus() {
  return { state: 'off', reason: { source: 'no_home', missing: process.platform === 'win32' ? 'USERPROFILE' : 'HOME' }, sending: false,
    machine_state: 'none', notice_emitted_at: null, next_send_after: null, last_sent: null, attempts_today: 0, install: 'absent',
    send_lock: null, destination: USAGE_URL, state_file: null, state_directory: null, problem: null };
}

export function telemetryStatus({ env = process.env, now = Date.now() } = {}) {
  if (!environmentHome(env)) return noHomeStatus();
  const paths = telemetryPaths(env);
  const current = readState(paths);
  const switched = environmentSwitch(env);
  const marked = switched ? null : offReason(paths, env);
  const problem = current.kind === 'broken' ? current.problem : stateProblem(paths);
  const state = current.kind === 'state' ? current.state : null;
  let status, reason;
  if (switched) { status = 'off'; reason = switched; }
  else if (marked) { status = 'off'; reason = marked; }
  else if (current.kind === 'broken') { status = 'unavailable'; reason = { source: 'state_problem' }; }
  else if (current.kind === 'untold') { status = problem ? 'unavailable' : 'not_told'; reason = { source: problem ? 'state_problem' : 'default' }; }
  else { status = state.state; reason = { source: state.state === 'on' ? (state.set_by === 'command' ? 'command_on' : 'default') : 'command' }; }
  const due = state && status === 'on' ? dueReason(state, now) : null;
  const nextAfter = state?.noticed_at && status === 'on'
    ? new Date(Math.max(Date.parse(state.noticed_at) + L.noticeWaitMs,
      due === 'sent_today' || due === 'attempts_exhausted' ? Date.parse(`${utcDay(now)}T00:00:00Z`) + DAY_MS : now)).toISOString()
    : null;
  return {
    state: status, reason, sending: status === 'on' && Boolean(state?.noticed_at),
    machine_state: current.kind === 'state' ? state.state : current.kind === 'untold' ? 'not_told' : 'unreadable',
    notice_emitted_at: state?.noticed_at ?? null,
    // A time, not a promise: the next command at or after it starts the send.
    next_send_after: nextAfter, last_sent: state?.last_sent ?? null,
    attempts_today: state?.attempt_day === utcDay(now) ? state.attempts : 0,
    install: state?.install ? 'present' : 'absent', send_lock: lockStatus(paths, now),
    destination: USAGE_URL, state_file: paths.state, state_directory: paths.folder,
    problem: problem ?? null,
  };
}

export function telemetryShow({ env = process.env, now = Date.now() } = {}) {
  if (!environmentHome(env)) return { destination: { method: 'POST', url: USAGE_URL }, state: 'off', reason: noHomeStatus().reason,
    would_send: 'not now', install: 'none', body: null, last_attempt: null, last_delivered: null };
  const paths = telemetryPaths(env);
  const status = telemetryStatus({ env, now });
  const current = readState(paths);
  const state = current.kind === 'state' ? current.state : null;
  const counts = status.state === 'off' || !state ? emptyCounts() : peekCounts(paths);
  const install = state?.install ?? null;
  const built = buildDocument({ install: install ?? '<made at the first send>', since: state?.since ?? null, counts });
  return {
    destination: { method: 'POST', url: USAGE_URL },
    state: status.state, reason: status.reason,
    would_send: status.state === 'on' && state && !dueReason(state, now) ? 'next command' : 'not now',
    install: install ? 'present' : 'made at the first send',
    body: built?.body ?? null,
    ...receipts(paths),
  };
}

// --- the commands ---------------------------------------------------------------

// Clear one directory's identifier and counts if its lock is free now, and
// mark its record off. Never waits: a sender holding the lock finishes, and
// the clean-up happens at the next use of the directory (reconcile).
function clearNow(paths, now, epoch, { recordOff = true } = {}) {
  const nonce = takeLock(paths, now, 0);
  if (!nonce) return { cleared: false, removed: [] };
  try {
    let kept = null;
    changeState(paths, read => {
      kept = read.kind === 'state' ? read.state : null;
      // A directory marked by its home's off keeps its record's own setting,
      // so lifting the marker is all `on` has to do there.
      if (!recordOff) return kept ? { ...kept, install: null, since: null, epoch } : null;
      return freshState({ state: 'off', set_by: 'command', noticed_at: kept?.noticed_at ?? null, epoch, ...dayRecord(kept) });
    }, { now, nonce });
    const removed = kept?.install ? ['install identifier'] : [];
    for (const label of discardData(paths)) if (!removed.includes(label)) removed.push(label);
    return { cleared: true, removed };
  } catch { return { cleared: false, removed: [] }; }
  finally { releaseLock(paths, nonce); }
}
const writeFailure = error => ({ code: ['ENOTDIR', 'EEXIST', 'OUTPUT_UNSAFE_PATH'].includes(error?.code)
  ? 'TELEMETRY_STATE_DIRECTORY_INVALID' : 'TELEMETRY_STATE_UNWRITABLE',
  message: ['ENOTDIR', 'EEXIST', 'OUTPUT_UNSAFE_PATH'].includes(error?.code) ? 'it is not a usable directory' : 'it cannot be written' });
const homeDirectory = env => env.HOME || env.USERPROFILE || homedir();

/** Off: the marker, written at once in this state directory and in the
 *  default directory of this home, so it holds for every process run with
 *  this home directory. It never waits for a sender. Identifiers and counts
 *  are cleared now where the lock is free, otherwise before that directory
 *  counts or sends again. Nothing is sent. ok only when the home's marker
 *  was written. */
// off and on run one at a time for a home: a small lock in the home's
// directory, held only while they change markers (well under a second).
// off never waits long for it (it must record off), on waits a little.
const settingsPaths = user => ({ folder: user.directory, lock: join(user.directory, '.telemetry-settings.lock') });
function takeSettingsLock(user, now, waitMs) {
  try { return lockAttempt(settingsPaths(user), now, waitMs).nonce; } catch { return null; }
}

// A marker in a listed directory (one readDirectoryList found to exist). The
// write creates no directory: one removed since then fails and is named.
function markListed(dir, marker) {
  writeOutputFileAtomic(markerPath(pathsFor(dir)), `${JSON.stringify({ v: 1, ...marker })}\n`, { mode: 0o600 });
}

export function telemetryOff({ env = process.env, now = Date.now() } = {}) {
  if (!environmentHome(env)) throw noHomeFailure();
  const paths = telemetryPaths(env), user = defaultPaths(env), same = user.directory === paths.directory;
  const epoch = newEpoch(), at = new Date(now).toISOString();
  const settings = takeSettingsLock(user, now, 2_000);
  try {
    const previous = readMarker(user);
    // Directories where off was run themselves, so `on` can name them later.
    const selfOff = [...new Set([...(previous && !previous.damaged ? previous.dirs : []), ...(same ? [] : [paths.directory])])]
      .filter(isUsableDirectory).slice(-DIRECTORY_LIST_MAX);
    let hereError = null, thereError = null;
    try { writeMarker(paths, { at, epoch, inherited: false, dirs: same ? selfOff : [] }); } catch (error) { hereError = writeFailure(error); }
    if (!same) {
      try { writeMarker(user, { at, epoch, inherited: false, dirs: selfOff }); } catch (error) { thereError = writeFailure(error); }
    }
    const forHome = same ? !hereError : !thereError;
    const scope = forHome ? 'home' : !hereError ? 'directory' : 'none';
    if (!same && !hereError) registerDirectory(paths, env);
    // Every other state directory recorded with this home is marked at once
    // (A5k, A5l): only directories that exist, at most DIRECTORY_LIST_MAX of
    // them; a directory that turned itself off keeps its own marker. Each
    // marker is read once.
    const list = forHome ? readDirectoryList(user) : { dirs: [], readable: true };
    const marked = [], unmarked = [], selfMarked = new Set();
    for (const dir of list.dirs) {
      if (dir === paths.directory || dir === user.directory) continue;
      const existing = readMarker(pathsFor(dir));
      if (existing && !existing.inherited) { marked.push(dir); selfMarked.add(dir); continue; }
      try { markListed(dir, { at, epoch, inherited: true, dirs: [] }); marked.push(dir); }
      catch { unmarked.push(dir); }
    }
    if (forHome && list.readable && list.lines > list.dirs.length) { try { writeDirectoryList(user, list.dirs); } catch { /* pruned next time */ } }
    const removed = [];
    let pending = false;
    const targets = [...(hereError ? [] : [[paths, true]]), ...(!same && !thereError ? [[user, true]] : []),
      ...marked.map(dir => [pathsFor(dir), selfMarked.has(dir)])];
    for (const [target, recordOff] of targets) {
      const result = clearNow(target, now, epoch, { recordOff });
      if (!result.cleared) pending = true;
      for (const label of result.removed) if (!removed.includes(label)) removed.push(label);
    }
    return { ok: scope === 'home', state: scope === 'none' ? 'unchanged' : 'off', scope, sent: false, removed, cleanup_pending: pending,
      home: homeDirectory(env), state_file: markerPath(paths), user_state_file: markerPath(user), same_directory: same,
      other_directories: marked, unmarked_directories: unmarked,
      directory_list: { file: join(user.directory, DIRS), readable: list.readable, ...(list.problem ? { problem: list.problem } : {}) },
      recorded: { here: !hereError, home: forHome },
      ...(hereError ? { here_problem: hereError } : {}), ...(thereError ? { user_problem: thereError } : {}) };
  } finally { if (settings) releaseLock(settingsPaths(user), settings); }
}

const failure = (code, message) => Object.assign(new Error(message), { code });
function lockFailure(reason, paths) {
  return reason === 'busy'
    ? failure('TELEMETRY_STATE_BUSY', `A send in progress holds ${paths.folder}; nothing was changed. Retry in a few seconds.`)
    : failure('TELEMETRY_STATE_UNWRITABLE', `${paths.directory} cannot be written; nothing was changed.`);
}

/** On: removes this directory's off marker (the only thing that ever does),
 *  starts it with a new identifier and no old counts, then lifts the home's
 *  off. Its own directory must be writable before anything else changes. */
export function telemetryOn({ env = process.env, now = Date.now() } = {}) {
  if (!environmentHome(env)) throw noHomeFailure();
  const paths = telemetryPaths(env), user = defaultPaths(env);
  const settings = lockAttempt(settingsPaths(user), now, L.lockWaitMs);
  if (!settings.nonce && settings.reason === 'busy') throw failure('TELEMETRY_STATE_BUSY', 'Another telemetry off or on is changing the setting for this home; nothing was changed. Retry in a moment.');
  try { return turnOn(paths, user, env, now); }
  finally { if (settings.nonce) releaseLock(settingsPaths(user), settings.nonce); }
}
function turnOn(paths, user, env, now) {
  const same = user.directory === paths.directory;
  const attempt = lockAttempt(paths, now, L.lockWaitMs);
  if (!attempt.nonce) throw lockFailure(attempt.reason, paths);
  let noticed = null, wasOff = false, selfDirs = [];
  const homeMarker = same ? null : readMarker(user);
  try {
    const own = readMarker(paths);
    wasOff = Boolean(own);
    selfDirs = own && !own.damaged ? own.dirs : [];
    changeState(paths, read => {
      const kept = read.kind === 'state' ? read.state : null;
      noticed = kept?.noticed_at ?? null;
      wasOff ||= kept?.state === 'off';
      return freshState({ set_by: 'command', noticed_at: noticed ?? new Date(now).toISOString(),
        epoch: (same ? own?.epoch : homeMarker?.epoch) ?? kept?.epoch ?? null, lifted_at: same ? new Date(now).toISOString() : kept?.lifted_at ?? null,
        ...dayRecord(kept) });
    }, { now, nonce: attempt.nonce });
    rmSync(markerPath(paths), { recursive: true, force: true });
    registerDirectory(paths, env);
    // Never revive an old identifier or old counts.
    discardData(paths);
  } finally { releaseLock(paths, attempt.nonce); }
  // Lift the home's off, now that this directory is on.
  let lifted = same && wasOff;
  if (homeMarker) {
    const result = changeState(user, read => read.kind === 'state'
      ? { ...read.state, state: 'on', set_by: 'command', epoch: homeMarker.epoch ?? read.state.epoch ?? null, lifted_at: new Date(now).toISOString() }
      : freshState({ set_by: 'command', epoch: homeMarker.epoch ?? null, lifted_at: new Date(now).toISOString() }), { now, waitMs: L.lockWaitMs });
    if (!result.written) throw lockFailure(result.reason, user);
    rmSync(markerPath(user), { recursive: true, force: true });
    lifted = true;
  }
  // Lift every marker the home's off put in another directory; a directory
  // that turned itself off stays off and is named, as is one that could not
  // be lifted.
  const remaining = [], unlifted = [];
  const listed = [...new Set([...knownDirectories(user), ...(homeMarker?.dirs ?? []), ...(selfDirs ?? [])])];
  for (const dir of listed) {
    if (dir === paths.directory || dir === user.directory) continue;
    const marker = readMarker(pathsFor(dir));
    if (!marker) continue;
    if (marker.inherited && !marker.damaged) {
      try { rmSync(markerPath(pathsFor(dir)), { force: true }); } catch { unlifted.push(dir); }
    } else remaining.push(dir);
  }
  const switched = environmentSwitch(env);
  return { ok: true, state: 'on', directory_was_off: wasOff, home_off_lifted: lifted, still_off: remaining, not_lifted: unlifted,
    home: homeDirectory(env), notice: noticed ? null : noticeText(),
    state_file: paths.state, user_state_file: user.state, ...(switched ? { overridden_by: switched } : {}) };
}

/** A new identifier at the next document. The day's record stays, so a reset
 *  never adds a document to the day; it never changes off or on. */
export function telemetryReset({ env = process.env, now = Date.now() } = {}) {
  if (!environmentHome(env)) throw noHomeFailure();
  const paths = telemetryPaths(env);
  const current = readState(paths);
  if (current.kind === 'broken') throw failure(current.problem.code, `${current.problem.message} Run ${CLI_NAME} telemetry on or off to replace it.`);
  if (current.kind === 'untold') return { ok: true, changed: false, reason: 'no identifier exists yet; one is made at the first document', state_file: paths.state };
  let had = false;
  const result = changeState(paths, read => {
    if (read.kind !== 'state') return null;
    had = Boolean(read.state.install);
    return { ...read.state, install: null, since: null };
  }, { now, waitMs: L.lockWaitMs });
  if (!result.locked) throw lockFailure(result.reason, paths);
  return { ok: true, changed: had, reason: had ? 'the identifier was deleted; a new one is made at the next document'
    : 'no identifier exists yet; one is made at the next document', state_file: paths.state };
}

const REASONS = { default: 'on unless turned off', command: 'turned off with telemetry off', command_on: 'turned on with telemetry on', state_problem: 'the state file cannot be used',
  checkout: 'this is a source tree of the package (.git, its test runner or its test suite); it never counts or sends', test: 'a test runner is running this process',
  no_home: 'this environment names no home directory, so nothing is counted, sent, shown or written',
  home: 'turned off for this home directory', marker_damaged: 'its off marker exists but cannot be read, which means off',
  home_marker_damaged: "the home's off marker exists but cannot be read, which means off",
  home_record_damaged: "the home's telemetry record exists but cannot be read, which means off" };
export function renderStatus(s) {
  const why = s.reason.variable ? `${s.reason.variable} is set${s.reason.source === 'ci' ? ' (a CI environment)' : ''}`
    : `${REASONS[s.reason.source] ?? s.reason.source}${s.reason.file ? ` (${s.reason.file})` : ''}`;
  const lines = [`Telemetry: ${s.state.replace('_', ' ')} (${why})`];
  if (s.state === 'not_told') lines.push('The notice has not been printed for this state directory; nothing is counted or sent from it until it is.');
  if (s.notice_emitted_at) lines.push(`Notice printed: ${s.notice_emitted_at}`);
  if (s.next_send_after) lines.push(`Next document: the first command at or after ${s.next_send_after}`);
  lines.push(`Last document delivered: ${s.last_sent ?? 'none'}`);
  if (s.send_lock) lines.push(`Send lock: ${s.send_lock}`);
  if (s.problem) lines.push(`Problem: ${s.problem.message} Nothing is counted or sent. (${s.problem.code})`);
  if (s.reason.source === 'no_home') lines.push(NO_HOME_MESSAGE);
  lines.push(`Destination: ${s.destination}`, ...(s.state_file ? [`State file: ${s.state_file}`, `Counts and receipts: ${s.state_directory}`] : []),
    `Turn off: ${CLI_NAME} telemetry off  ·  See what is sent: ${CLI_NAME} telemetry show`);
  return lines.join('\n');
}
export function renderShow(s) {
  const lines = [`Destination: ${s.destination.method} ${s.destination.url}`, `Telemetry: ${s.state.replace('_', ' ')}; would send: ${s.would_send}`];
  if (s.install !== 'present') lines.push('No install identifier exists yet; one is made at the first send, so a placeholder stands in below.');
  lines.push('Next document (the exact bytes):', s.body ?? '(none: this version cannot build a valid document)');
  lines.push(s.last_delivered ? `Last document delivered: ${s.last_delivered.path}\n${s.last_delivered.body}` : 'Last document delivered: none');
  lines.push(s.last_attempt ? `Last attempt (${s.last_attempt.outcome}): ${s.last_attempt.path}` : 'Last attempt: none');
  return lines.join('\n');
}
