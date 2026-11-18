// OPEN-1: start or reuse one checkout's background Workbench and open a
// connected browser page, with no terminal and no typed pairing code.
//
// One background service runs per checkout. Its discovery record is a private
// file inside that checkout's own ignored evidence folder, so the checkout
// directory is the identity: equal basenames and linked worktrees cannot
// collide. A record is never trusted on its own. Before reuse, the service
// behind it must answer on its local control endpoint with the same instance
// and the same canonical path; a dead process, a reused PID or another
// repository fails that check. Nothing here signals a process by PID or
// deletes a path that a record names.
//
// The browser earns authority through a one-use launch grant that the service
// mints for this process over the control endpoint. It travels to the browser
// in the URL fragment only, and never appears in a result, a record or a log:
// every result carries the plain URL, which serves the package's static page.
import { spawn, execFileSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { LAYOUT, LEGACY_LAYOUT } from './layout.mjs';
import { CLI_NAME } from './brand.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';
import { atomicRenameSync } from './atomic-rename.mjs';
import { stackCatalog } from './stacks.mjs';
import { askWorkbenchControl, controlEndpointAllowed } from './workbench-control.mjs';
import { osOpenLaunch } from './os-open.mjs';

export const WORKBENCH_VIEWS = Object.freeze(['workbench', 'activity', 'request', 'map']);
export const WORKBENCH_LAUNCH_LIMITS = Object.freeze({
  // One open may wait this long for another open of the same checkout. A lock
  // is abandoned when its holder is gone, or older than any open can take.
  deadlineMs: 30_000, lockStaleMs: 45_000, serviceStartMs: 12_000,
  // How long a result waits to see the page redeem its launch.
  pageWaitMs: 4000, openerWaitMs: 3000, stopWaitMs: 5000,
});
const RECORD = 'service.json', LOCK = 'launch.lock';
const WB_SESSION = /^wb-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOCAL_URL = /^http:\/\/127\.0\.0\.1:\d{1,5}\/$/;
const CLI_ENTRY = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const WINDOWS_OPEN_URL_ENV = 'WORKBENCH_OPEN_URL';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const problem = (code, message, next, extra = {}) => Object.assign(new Error(message), { code, next, ...extra });
const word = value => /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : process.platform === 'win32' ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;

export const launchDirectory = root => join(root, LAYOUT.evidence, 'workbench', 'launch');
export const serviceRecordPath = root => join(launchDirectory(root), RECORD);
const repository = root => ({ name: basename(root), root });
const commandFor = (root, verb) => `${CLI_NAME} workbench ${verb} --project ${word(root)}`;

/** The canonical checkout a path names: its Git top level when it has one, else the directory itself. */
export function resolveWorkbenchProject(path, { cwd = process.cwd() } = {}) {
  const target = resolve(cwd, String(path));
  let stat = null;
  try { stat = statSync(target); } catch { /* reported below */ }
  if (!stat?.isDirectory()) throw problem('WORKBENCH_PROJECT_NOT_FOUND', 'No checkout directory exists at the requested path.',
    'Name an existing local checkout with --project, or run the command inside it. Nothing was opened.', { project: target });
  let top = target;
  try { top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: target, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || target; }
  catch { /* not a Git checkout: the directory itself is the project */ }
  return realpathSync.native(top);
}

/** Opening never initializes a repository: one without any product files is refused by name. */
export function assertWorkbenchConfigured(root) {
  let stacks = 0;
  try { stacks = stackCatalog(root).stacks.length; } catch { /* an unreadable catalog still counts as present below */ }
  const present = stacks > 0 || [LAYOUT.marker, LAYOUT.collection, LAYOUT.context, LEGACY_LAYOUT.context].some(path => existsSync(join(root, path)));
  if (!present) throw problem('WORKBENCH_PROJECT_NOT_CONFIGURED', 'That checkout has no API stacks or saved API knowledge for the workbench to show.',
    `Run ${CLI_NAME} connect in that repository first. Opening the workbench never sets a repository up, and nothing was created there.`, { project: root });
}

export function ensureLaunchDirectory(root) {
  const dir = launchDirectory(root);
  safeOutputPath(dir, { directory: true, code: 'WORKBENCH_LAUNCH_UNSAFE' });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeOutputFileAtomic(ignore, '*\n', { mode: 0o600, code: 'WORKBENCH_LAUNCH_UNSAFE' });
  return dir;
}

/** The record as written, null when absent, or { invalid: true } when it is not a service record. */
export function readServiceRecord(root) {
  const path = serviceRecordPath(root);
  let stat;
  try { stat = lstatSync(path); } catch { return null; }
  if (!stat.isFile() || stat.size > 4096) return { invalid: true };
  let record;
  try { record = JSON.parse(readFileSync(path, 'utf8')); } catch { return { invalid: true }; }
  if (!object(record) || record.version !== 1 || record.kind !== 'workbench-service' || !WB_SESSION.test(record.instance ?? '')
    || typeof record.root !== 'string' || !controlEndpointAllowed(record.socket) || !LOCAL_URL.test(record.url ?? '')
    || !Number.isSafeInteger(record.pid) || !instant(record.started_at)) return { invalid: true };
  return record;
}

/**
 * Whether this checkout's service is running, proven by the service itself.
 * running: it answered with the record's instance, this canonical path and the
 * record's URL. unresponsive: its endpoint accepts a connection but did not
 * answer in time, so it may be busy; it is not replaced. stale: a record exists
 * but nothing is listening behind it. absent: no record.
 */
export async function liveWorkbenchService(root) {
  const record = readServiceRecord(root);
  if (!record) return { state: 'absent' };
  if (record.invalid || record.root !== root) return { state: 'stale' };
  let answer = await askWorkbenchControl(record.socket, { v: 1, kind: 'status' }, { timeoutMs: 1500 });
  if (answer.state === 'timeout') answer = await askWorkbenchControl(record.socket, { v: 1, kind: 'status' }, { timeoutMs: 4000 });
  if (answer.state === 'timeout') return { state: 'unresponsive', record };
  const reply = answer.reply;
  if (answer.state !== 'answered' || reply.ok !== true || reply.instance !== record.instance || reply.root !== root || reply.url !== record.url)
    return { state: 'stale', record };
  return { state: 'running', record, status: reply };
}

// Whether the opener that wrote a lock is gone. Signal 0 delivers nothing; it
// only asks whether the process exists. A reused PID reads as alive, and the
// age limit covers that case.
function lockAbandoned(path) {
  let age = 0, holder = null;
  try { age = Date.now() - lstatSync(path).mtimeMs; } catch { return false; }
  try { holder = JSON.parse(readFileSync(path, 'utf8')).pid; } catch { /* judged by age */ }
  if (age > WORKBENCH_LAUNCH_LIMITS.lockStaleMs) return true;
  if (!Number.isSafeInteger(holder) || holder <= 0 || holder === process.pid) return false;
  try { process.kill(holder, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}

// Serializes the openers of one checkout so that they start one service
// between them. It saves work; it is not what keeps a checkout to one service.
// That is the service's own exclusive claim on the record, so a lock taken
// over in a race costs a second start that gives way, never a second service.
async function withLaunchLock(root, deadline, run) {
  const path = join(ensureLaunchDirectory(root), LOCK), mine = randomBytes(8).toString('hex');
  for (;;) {
    let fd;
    try { fd = openSync(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw problem('WORKBENCH_LAUNCH_UNSAFE', 'The private launch folder of that checkout could not be written.',
        `Check ${LAYOUT.evidence} in that checkout, then open the workbench again.`);
      if (lockAbandoned(path)) try { unlinkSync(path); } catch { /* cleared by another opener, or not removable: the deadline below ends the wait */ }
      if (Date.now() > deadline) throw problem('WORKBENCH_LAUNCH_BUSY', 'Another open of this repository is still starting, or left its lock behind.',
        `Open the workbench again in a few seconds. If it keeps failing, remove ${join(LAYOUT.evidence, 'workbench', 'launch', LOCK)} in that checkout.`);
      // Every pass waits, so a lock that cannot be cleared never spins.
      await delay(60 + Math.floor(Math.random() * 60));
      continue;
    }
    try { writeSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), id: mine })}\n`); } catch { /* the lock is its name */ } finally { closeSync(fd); }
    try { return await run(); }
    finally {
      // Release only this opener's lock: one that was taken over is another's.
      let held = null;
      try { held = JSON.parse(readFileSync(path, 'utf8')).id; } catch { /* gone or unreadable */ }
      if (held === mine) try { unlinkSync(path); } catch { /* already cleared */ }
    }
  }
}

/**
 * Remove this checkout's record if, and only if, nothing live stands behind
 * it. The record is first renamed out of the way, which only one caller can do
 * for a given file, and then judged: a record whose service answers was not
 * stale after all (another opener replaced it meanwhile) and is put back.
 * Nothing but the record file is ever removed.
 */
export async function removeStaleServiceRecord(root) {
  const path = serviceRecordPath(root), tomb = join(launchDirectory(root), `service.stale-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  try { atomicRenameSync(path, tomb); } catch { return false; }
  let live = false;
  try {
    const record = JSON.parse(readFileSync(tomb, 'utf8'));
    if (object(record) && record.root === root && WB_SESSION.test(record.instance ?? '') && controlEndpointAllowed(record.socket)) {
      const answer = await askWorkbenchControl(record.socket, { v: 1, kind: 'status' }, { timeoutMs: 1500 });
      live = answer.state === 'timeout' || (answer.state === 'answered' && answer.reply.ok === true && answer.reply.instance === record.instance && answer.reply.root === root);
    }
  } catch { /* unreadable: not a live service's record */ }
  if (live) try { linkSync(tomb, path); } catch { /* its service has already written it again */ }
  try { unlinkSync(tomb); } catch { /* already gone */ }
  return !live;
}

// A service for one checkout must not read another checkout's bindings from an
// inherited environment, such as an MCP registration that pins a different one.
function serviceEnvironment(root, env) {
  const next = { ...env };
  let pinned = null;
  try { if (typeof env.API_CONTEXT_DIR === 'string' && env.API_CONTEXT_DIR) pinned = realpathSync.native(resolve(env.API_CONTEXT_DIR)); } catch { pinned = ''; }
  if (pinned !== null && pinned !== root) for (const key of ['API_CONTEXT_DIR', 'API_REPO_ROOT', 'API_CONFIG', 'API_EVIDENCE', 'API_CONTRACT']) delete next[key];
  return next;
}

function startService(root, env) {
  return new Promise(resolveStart => {
    let child, settled = false, timer;
    const finish = value => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      if (child) { child.removeAllListeners(); child.on('error', () => {}); try { if (child.connected) child.disconnect(); } catch { /* already closed */ } child.unref(); }
      resolveStart(value);
    };
    try {
      // Its own session and process group, no terminal and no inherited pipes:
      // the service outlives this command and the agent that ran it.
      child = spawn(process.execPath, [CLI_ENTRY, 'workbench', 'serve', '--project', root],
        { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: serviceEnvironment(root, env) });
    } catch { return finish({ ok: false, code: 'WORKBENCH_SERVICE_START_FAILED' }); }
    timer = setTimeout(() => finish({ ok: false, code: 'WORKBENCH_SERVICE_START_TIMEOUT' }), WORKBENCH_LAUNCH_LIMITS.serviceStartMs);
    child.once('message', message => finish(object(message) && typeof message.ok === 'boolean' ? message : { ok: false, code: 'WORKBENCH_SERVICE_START_FAILED' }));
    child.once('error', () => finish({ ok: false, code: 'WORKBENCH_SERVICE_START_FAILED' }));
    child.once('exit', () => finish({ ok: false, code: 'WORKBENCH_SERVICE_START_FAILED' }));
  });
}

const unresponsive = (root, record) => problem('WORKBENCH_SERVICE_UNRESPONSIVE', 'This repository\'s workbench service is running but did not answer.',
  `Open the workbench again in a moment. If it keeps failing, check that process ${record.pid} is the workbench service and end it yourself; nothing was stopped for you.`, { project: root });

async function ensureService(root, env, deadlineMs) {
  const first = await liveWorkbenchService(root);
  if (first.state === 'running') return { ...first, created: false };
  if (first.state === 'unresponsive') throw unresponsive(root, first.record);
  return withLaunchLock(root, Date.now() + deadlineMs, async () => {
    const again = await liveWorkbenchService(root);
    if (again.state === 'running') return { ...again, created: false };
    if (again.state === 'unresponsive') throw unresponsive(root, again.record);
    // Only the record is removed. Ledgers, reviews, responses and evidence are
    // not launch state, and no process is signalled.
    const recovered = again.state === 'stale' && await removeStaleServiceRecord(root);
    const started = await startService(root, env);
    const after = await liveWorkbenchService(root);
    if (after.state !== 'running') throw problem(started.code === 'WORKBENCH_SERVICE_START_TIMEOUT' ? started.code : 'WORKBENCH_SERVICE_START_FAILED',
      'The local workbench service did not start for this repository.', `Open the workbench again. If it keeps failing, run ${CLI_NAME} workbench in an interactive terminal to see the launch error.`, { project: root });
    return { ...after, created: started.ok === true && started.instance === after.record.instance, recovered };
  });
}

/** Best-effort navigation passed to the page. A value that is not usable is left out and named; it never changes which repository opens. */
function launchContext(context = {}) {
  const passed = {}, ignored = [];
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
  if (context.view !== undefined) { if (WORKBENCH_VIEWS.includes(context.view)) passed.view = context.view; else ignored.push('view'); }
  if (context.stack !== undefined) { if (text(context.stack, 64)) passed.stack = context.stack; else ignored.push('stack'); }
  if (context.operation !== undefined) { if (text(context.operation, 2048)) passed.operation = context.operation; else ignored.push('operation'); }
  return Object.keys(passed).length || ignored.length ? { passed, ignored } : null;
}

function spawnOpener(target, { platform, env }) {
  // A Linux session with no display has no browser to hand the URL to, and
  // xdg-open may fall back to a terminal browser that never returns.
  if (platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)
    return Promise.resolve({ state: 'unavailable', code: 'WORKBENCH_BROWSER_UNAVAILABLE',
      message: 'This session has no graphical display, so no browser was opened.' });
  const launch = osOpenLaunch(target, { platform, env, variable: WINDOWS_OPEN_URL_ENV });
  const opener = basename(launch.command);
  return new Promise(resolveOpen => {
    let settled = false, child, timer;
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); child?.removeAllListeners(); child?.on('error', () => {}); child?.unref(); resolveOpen({ opener, ...value }); };
    try {
      child = spawn(launch.command, launch.args, { stdio: 'ignore', shell: false, windowsHide: true, detached: platform !== 'win32',
        env: { ...env, ...(launch.env ?? {}) } });
    } catch { return finish({ state: 'failed', code: 'WORKBENCH_OPENER_UNAVAILABLE', message: 'The system opener could not be started.' }); }
    child.once('error', error => finish(error?.code === 'ENOENT'
      ? { state: 'failed', code: 'WORKBENCH_OPENER_UNAVAILABLE', message: `The system opener (${opener}) is not available on this machine.` }
      : { state: 'failed', code: 'WORKBENCH_OPENER_FAILED', message: `The system opener (${opener}) could not be started.` }));
    child.once('exit', code => finish(code === 0 ? { state: 'dispatched' }
      : { state: 'failed', code: 'WORKBENCH_OPENER_FAILED', message: `The system opener (${opener}) reported a failure.`, ...(Number.isInteger(code) ? { exit_code: code } : {}) }));
    // Some openers stay in the foreground for as long as the browser they
    // started. Not having failed by now is treated as an accepted request.
    timer = setTimeout(() => finish({ state: 'dispatched', opener_exit: 'pending' }), WORKBENCH_LAUNCH_LIMITS.openerWaitMs);
  });
}

async function observePage(socket, id, waitMs) {
  const until = Date.now() + waitMs;
  for (;;) {
    const answer = await askWorkbenchControl(socket, { v: 1, kind: 'grant-status', id }, { timeoutMs: 1000 });
    const state = answer.state === 'answered' && answer.reply.ok === true ? answer.reply.state : null;
    if (state === 'redeemed') return { state: 'connected', basis: 'The opened page exchanged this launch for its own session with the local service.' };
    if (state !== 'pending' || Date.now() >= until) break;
    await delay(120);
  }
  return { state: 'not-observed', basis: 'The opener accepted the request, but no page had connected when this result was written. That does not show whether a page rendered.' };
}

/**
 * Start or reuse this checkout's Workbench service and, unless open is false,
 * ask the system opener for a connected browser page. Throws a named error when
 * no service could be reached; a browser that could not be opened is a result
 * (ok false) that still carries the running instance and its plain URL.
 */
export async function openWorkbench(root, { open = true, context, env = process.env, platform = process.platform, deadlineMs = WORKBENCH_LAUNCH_LIMITS.deadlineMs } = {}) {
  root = realpathSync.native(resolve(root));
  assertWorkbenchConfigured(root);
  const found = await ensureService(root, env, deadlineMs), { record, status } = found;
  const retry = commandFor(root, 'open');
  let browser = { state: 'not-requested' }, page = { state: 'not-requested' };
  const passing = launchContext(context);
  if (open) {
    const minted = await askWorkbenchControl(record.socket, { v: 1, kind: 'grant' }, { timeoutMs: 3000 });
    if (minted.state !== 'answered' || minted.reply.ok !== true || typeof minted.reply.grant !== 'string' || typeof minted.reply.id !== 'string')
      browser = { state: 'failed', code: 'WORKBENCH_LAUNCH_GRANT_FAILED', message: 'The local service did not issue a browser launch.' };
    else {
      const target = `${record.url}#${new URLSearchParams({ launch: minted.reply.grant, ...(passing?.passed ?? {}) })}`;
      browser = await spawnOpener(target, { platform, env });
      if (browser.state === 'dispatched') page = await observePage(record.socket, minted.reply.id, WORKBENCH_LAUNCH_LIMITS.pageWaitMs);
    }
    if (browser.state !== 'dispatched') {
      browser.next = `The workbench is running. Run ${retry} on the machine where your browser is, or run ${CLI_NAME} workbench in an interactive terminal there and pair with the code it asks for. The local URL alone grants no access.`;
      page = { state: 'not-opened' };
    }
    // A shell reached over SSH opens the browser on that machine, not on the person's.
    if (env.SSH_CONNECTION || env.SSH_TTY) browser.remote_session = true;
  }
  const failed = open && browser.state !== 'dispatched';
  return {
    ok: !failed,
    ...(failed ? { error: { code: browser.code, message: browser.message, next: browser.next } } : {}),
    repository: repository(root),
    instance: { state: found.created ? 'created' : 'reused', id: record.instance, started_at: status.started_at, expires_at: status.expires_at,
      ...(found.recovered ? { replaced_stale_record: true } : {}) },
    url: record.url,
    browser, page,
    ...(passing ? { context: passing } : {}),
    stop: commandFor(root, 'stop'),
  };
}

/** What is running for this checkout, without starting anything. */
export async function workbenchServiceStatus(root) {
  root = realpathSync.native(resolve(root));
  const found = await liveWorkbenchService(root);
  if (found.state === 'running') return { ok: true, state: 'running', repository: repository(root),
    instance: { id: found.record.instance, started_at: found.status.started_at, expires_at: found.status.expires_at, pid: found.status.pid },
    url: found.record.url, pages_connected: Number.isSafeInteger(found.status.pages) ? found.status.pages : null, stop: commandFor(root, 'stop') };
  if (found.state === 'unresponsive') return { ok: true, state: 'unresponsive', repository: repository(root), pid: found.record.pid,
    next: 'The service accepted a connection but did not answer. Ask again in a moment.' };
  return { ok: true, state: 'not-running', repository: repository(root), ...(found.state === 'stale' ? { stale_record: true } : {}), open: commandFor(root, 'open') };
}

/** Ask this checkout's service to close. It cannot reach another checkout's service. */
export async function stopWorkbenchService(root) {
  root = realpathSync.native(resolve(root));
  const found = await liveWorkbenchService(root);
  if (found.state === 'unresponsive') throw unresponsive(root, found.record);
  if (found.state !== 'running') {
    let cleaned = false;
    if (found.state === 'stale') await withLaunchLock(root, Date.now() + WORKBENCH_LAUNCH_LIMITS.deadlineMs, async () => {
      if ((await liveWorkbenchService(root)).state === 'stale') cleaned = await removeStaleServiceRecord(root);
    });
    return { ok: true, state: 'not-running', repository: repository(root), ...(cleaned ? { removed_stale_record: true } : {}) };
  }
  const answer = await askWorkbenchControl(found.record.socket, { v: 1, kind: 'stop' }, { timeoutMs: 3000 });
  if (answer.state !== 'answered' || answer.reply.ok !== true) throw problem('WORKBENCH_STOP_FAILED', 'The workbench service did not accept the stop request.',
    `Run ${commandFor(root, 'status')} to see whether it is still running.`, { project: root });
  const until = Date.now() + WORKBENCH_LAUNCH_LIMITS.stopWaitMs;
  for (;;) {
    const again = await liveWorkbenchService(root);
    if (again.state !== 'running' && again.state !== 'unresponsive' || again.record?.instance !== found.record.instance) break;
    if (Date.now() >= until) throw problem('WORKBENCH_STOP_FAILED', 'The workbench service accepted the stop request but is still running.',
      `Run ${commandFor(root, 'status')} in a moment.`, { project: root });
    await delay(80);
  }
  return { ok: true, state: 'stopped', repository: repository(root), instance: { id: found.record.instance } };
}
