// Machine-local usage and OAuth state. R11 corrected 2026-10-06: write new,
// read old in place. A pinned older install must retain its log and token cache.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME, HOME_ENV_NAME } from './brand.mjs';
import { safeOutputPath, writeOutputFileAtomic } from './output-path.mjs';

// This lock protects only the once-per-name doctor notice. State reads never
// acquire it; new usage appends and atomic token writes do not depend on it.
const LOCK = '.legacy-state-notice.lock';
const NOTICE = '.legacy-state-notice.json';

export function machineStatePaths({ env = process.env, home = homedir() } = {}) {
  const directory = resolve(env[HOME_ENV_NAME] || join(home, `.${STATE_DIR_NAME}`));
  const legacy = join(home, `.${LEGACY_STATE_DIR_NAME}`);
  return { directory, legacy, usageLog: env.API_USAGE_LOG ?? join(directory, 'usage.jsonl'), tokenCache: join(directory, 'tokens') };
}

function safeStore(path, directory = false) {
  if (!path) return false;
  try {
    safeOutputPath(path, { directory });
    return existsSync(path);
  } catch { return false; }
}

function readPaths(name, options = {}) {
  const paths = machineStatePaths(options), env = options.env ?? process.env;
  const candidates = name === 'usage.jsonl' && env.API_USAGE_LOG !== undefined
    ? [paths.usageLog] : [join(paths.directory, name), join(paths.legacy, name)];
  return [...new Set(candidates.filter(Boolean).map(path => resolve(path)))].filter(path => safeStore(path, name === 'tokens'));
}

// Scalar paths are write destinations, never fallback destinations. Readers
// must opt into both stores; token callers resolve each provider file in order.
export const usageLogPath = options => machineStatePaths(options).usageLog;
export const tokenCachePath = options => machineStatePaths(options).tokenCache;
export const usageLogPaths = options => readPaths('usage.jsonl', options);
export const tokenCachePaths = options => readPaths('tokens', options);

function ensureDirectory(paths) {
  safeOutputPath(paths.directory, { directory: true });
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  chmodSync(paths.directory, 0o700);
}

function lock(paths) {
  ensureDirectory(paths);
  const path = join(paths.directory, LOCK);
  safeOutputPath(path, { directory: true });
  let created = false;
  try {
    mkdirSync(path, { mode: 0o700 });
    created = true;
    writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid }), { mode: 0o600 });
    return () => rmSync(path, { recursive: true, force: true });
  } catch (error) {
    // Failure while recording our ownership must not strand our new lock.
    if (created) { rmSync(path, { recursive: true, force: true }); throw error; }
    if (error.code !== 'EEXIST') throw error;
    // An owner is written immediately after mkdir. Give an interrupted empty
    // or partial-owner directory a bounded grace period before reclaiming it;
    // a fresh contender without its owner file is still in flight.
    try {
      safeOutputPath(path, { directory: true });
      const observed = lstatSync(path);
      const aged = Date.now() - observed.mtimeMs > 30_000;
      const entries = readdirSync(path);
      if (entries.some(name => name !== 'owner.json')) return null;
      const ownerPath = join(path, 'owner.json');
      safeOutputPath(ownerPath);
      let owner;
      try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
      catch (read) {
        if (read.code !== 'ENOENT' && !(read instanceof SyntaxError)) return null;
      }
      let reclaim = aged;
      if (Number.isInteger(owner?.pid) && owner.pid > 0) {
        reclaim = false;
        try { process.kill(owner.pid, 0); }
        catch (probe) { reclaim = probe.code === 'ESRCH'; }
      }
      if (reclaim) {
        // Do not remove a replacement installed since this inspection.
        safeOutputPath(path, { directory: true });
        const current = lstatSync(path);
        if (current.ino !== observed.ino || current.dev !== observed.dev || current.mtimeMs !== observed.mtimeMs) return null;
        rmSync(path, { recursive: true, force: true });
        return lock(paths);
      }
    } catch { /* an unsafe or unfamiliar lock is not authority to remove it */ }
    return null;
  }
}

// Compatibility for callers from the original rename slice. Preparation is
// deliberately side-effect free; no reader, doctor or connect can move state.
export async function prepareMachineState() {
  return { moved: [], pending: [] };
}

export async function withMachineStateWrite(kind, write, options = {}) {
  if (!['usage', 'tokens'].includes(kind)) throw new TypeError('Unknown machine state kind.');
  const paths = machineStatePaths(options), env = options.env ?? process.env;
  if (kind === 'usage' && env.API_USAGE_LOG !== undefined) return write(paths.usageLog);
  ensureDirectory(paths);
  const target = kind === 'usage' ? paths.usageLog : paths.tokenCache;
  safeOutputPath(target, { directory: kind === 'tokens' });
  if (kind === 'tokens') {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    chmodSync(target, 0o700);
  }
  return write(target);
}

// Doctor reports names and safe read locations, never token contents. A
// persistent private receipt makes the same leftover quiet on later runs.
export function inspectLegacyState(options = {}) {
  const paths = machineStatePaths(options);
  let leftovers = [];
  try {
    safeOutputPath(paths.legacy, { directory: true });
    leftovers = readdirSync(paths.legacy).sort();
  } catch { /* absence or an unsafe old directory needs no contents read */ }
  const out = { directory: paths.legacy, leftovers, reported: leftovers,
    reads: { usage: usageLogPaths(options), tokens: tokenCachePaths(options) } };
  if (!options.reportOnce || !leftovers.length) return out;
  let release;
  try {
    release = lock(paths);
    if (!release) return { ...out, reported: [] };
    const marker = join(paths.directory, NOTICE);
    let previous = [];
    try { safeOutputPath(marker); previous = JSON.parse(readFileSync(marker, 'utf8')); } catch { /* first notice */ }
    if (!Array.isArray(previous) || previous.some(name => typeof name !== 'string')) previous = [];
    out.reported = leftovers.filter(name => !previous.includes(name));
    if (out.reported.length) writeOutputFileAtomic(marker, `${JSON.stringify([...new Set([...previous, ...leftovers])].sort())}\n`, { mode: 0o600 });
    return out;
  } catch {
    // An unsafe or unwritable current location must not hide safe legacy
    // leftovers. Without a durable receipt these names may be reported again.
    return out;
  }
  finally { release?.(); }
}
