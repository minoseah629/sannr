// Imported first by every test file (test/test-isolation.test.mjs fails for
// one that does not). It gives the test process its own temporary home, and
// makes that true for every process the test starts, whatever environment
// the test passes (USE-1 Amendments 5 and 6, A17b and A17d):
//
//  - In this process: HOME and USERPROFILE move to a fresh temporary
//    directory; any inherited SANNR_HOME and API_USAGE_LOG are removed, so the
//    machine state directory and usage log resolve inside it; npm's cache
//    moves there; usage counts are off (SANNR_TELEMETRY=0, DO_NOT_TRACK=1).
//    A child that inherits the environment inherits all of this.
//  - For a child started with an environment built by hand: every function
//    of node:child_process that starts a process (spawn, spawnSync, execFile,
//    execFileSync, exec, execSync, fork) is wrapped, and an explicit `env`
//    that does not name HOME, USERPROFILE, the off switch or DO_NOT_TRACK
//    (or names one as undefined, which Node drops)
//    gets this process's value for each; one that does not name SANNR_HOME or
//    API_USAGE_LOG resolves them inside that HOME. A test that sets one of
//    these keys itself, even to an empty string, keeps its own value: the
//    telemetry tests do that on purpose. The wrapped functions are published
//    to ESM importers with syncBuiltinESMExports.
//
// Git's global identity is read, never written, from its usual place so tests
// that commit keep working. The home is deleted when the process exits.
import childProcess from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME_ENV_NAME, TELEMETRY_ENV_NAME } from '../../lib/brand.mjs';

export const ISOLATED_HOME_MARK = 'TEST_ISOLATED_HOME';
export const FILLED_KEYS = Object.freeze(['HOME', 'USERPROFILE', TELEMETRY_ENV_NAME, 'DO_NOT_TRACK', 'GIT_CONFIG_GLOBAL', ISOLATED_HOME_MARK]);
if (process.env[ISOLATED_HOME_MARK] !== String(process.pid)) {
  const real = homedir();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'test-home-')));
  const gitConfig = join(real, '.gitconfig');
  if (!process.env.GIT_CONFIG_GLOBAL && existsSync(gitConfig)) process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env[HOME_ENV_NAME];
  delete process.env.API_USAGE_LOG;
  process.env.npm_config_cache = join(home, '.npm');
  process.env.npm_config_update_notifier = 'false';
  process.env[TELEMETRY_ENV_NAME] = '0';
  process.env.DO_NOT_TRACK = '1';
  process.env[ISOLATED_HOME_MARK] = String(process.pid);
  process.on('exit', () => { try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } });
}

/** An explicit child environment with every isolation key the test did not
 *  set itself filled from this process. */
export function isolateEnvironment(env) {
  const out = { ...env };
  // A key set to undefined is not set: Node drops it from the child's environment.
  for (const key of FILLED_KEYS) if ((!Object.hasOwn(out, key) || out[key] === undefined) && process.env[key] !== undefined) out[key] = process.env[key];
  return out;
}
const isOptions = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function isolateArguments(args) {
  for (let i = 1; i < args.length; i++) {
    if (typeof args[i] === 'function') break;
    if (isOptions(args[i])) {
      if (Object.hasOwn(args[i], 'env') && isOptions(args[i].env)) args[i] = { ...args[i], env: isolateEnvironment(args[i].env) };
      break;
    }
  }
  return args;
}
const PROMISIFY = Symbol.for('nodejs.util.promisify.custom');
function wrap(name) {
  const original = childProcess[name];
  if (typeof original !== 'function' || original.isolatedHome) return;
  const wrapped = function (...args) { return original.apply(this, isolateArguments(args)); };
  Object.defineProperty(wrapped, 'isolatedHome', { value: true });
  // util.promisify(exec) and util.promisify(execFile) use this hook.
  if (typeof original[PROMISIFY] === 'function') {
    const custom = original[PROMISIFY];
    wrapped[PROMISIFY] = function (...args) { return custom.apply(this, isolateArguments(args)); };
  }
  childProcess[name] = wrapped;
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) wrap(name);
syncBuiltinESMExports();
