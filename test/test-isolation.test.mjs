import './helpers/isolated-home.mjs';
// Test isolation is structural (USE-1 Amendments 5 and 6, A17b and A17d):
// every test file imports test/helpers/isolated-home.mjs before anything else,
// with no pattern deciding which files need it; the helper isolates the home
// of every process a test starts, whatever environment the test passes; and
// the runner gives every test process its own home, state directory, usage
// log and npm cache with counting off. Each part is checked here, including
// that the rule itself fails for a file that breaks it.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync as namedSpawnSync, execFileSync as namedExecFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_ENV_NAME, TELEMETRY_ENV_NAME } from '../lib/brand.mjs';
import { executePhase, isolatedEnvironment } from '../scripts/test-unit.mjs';

const TEST_DIR = fileURLToPath(new URL('./', import.meta.url));
const HARNESSES = ['truthful.mjs', 'stress.mjs', 'check.mjs'];
// The first import or re-export statement, read the way Node reads the file:
// comments removed, statements spanning lines, `export … from` included.
export function firstModuleSpecifier(source) {
  const code = source.replace(/^#!.*/, '').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const start = /^\s*(?:import|export)\b/m.exec(code);
  if (!start) return null;
  const rest = code.slice(start.index).trimStart();
  const statement = /^(?:import\s*(['"])([^'"]+)\1|(?:import|export)\b[^;]*?\bfrom\s*(['"])([^'"]+)\3)/.exec(rest);
  return statement ? statement[2] ?? statement[4] : null;
}
export function importsHelperFirst(source) {
  return firstModuleSpecifier(source) === './helpers/isolated-home.mjs';
}
/** Every test file and harness in `directory` that does not import the helper first. */
export function missingHelper(directory) {
  return readdirSync(directory).filter(name => name.endsWith('.test.mjs') || HARNESSES.includes(name))
    .filter(name => !importsHelperFirst(readFileSync(join(directory, name), 'utf8'))).sort();
}

test('A17d: every test file and harness imports the isolated home first', () => {
  const missing = missingHelper(TEST_DIR);
  assert.deepEqual(missing, [], `import './helpers/isolated-home.mjs' first in: ${missing.join(', ')}`);
});

test('A17d: the rule fails for the files the fourth audit wrote, and for a helper imported second', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-rule-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'zz-cli-join.test.mjs'), "import { spawnSync } from 'node:child_process';\nimport { join } from 'node:path';\nspawnSync(process.execPath, [join('..', 'bin', 'cli.mjs'), 'stacks'], { env: process.env });\n");
  writeFileSync(join(dir, 'zz-dynamic.test.mjs'), "const { loadRegistry, saveRegistry } = await import('../lib/registry.mjs');\nsaveRegistry(loadRegistry().registry);\n");
  writeFileSync(join(dir, 'zz-second.test.mjs'), "import test from 'node:test';\nimport './helpers/isolated-home.mjs';\n");
  writeFileSync(join(dir, 'zz-good.test.mjs'), "#!/usr/bin/env node\n// a comment\n/* import './helpers/isolated-home.mjs'; */\nimport './helpers/isolated-home.mjs';\nimport test from 'node:test';\n");
  // The fifth audit's layouts: a multi-line import, a re-export and a
  // commented-out helper before the first real statement.
  writeFileSync(join(dir, 'zz-multiline.test.mjs'), "import {\n  apiRequest,\n  runEnvelope,\n} from '../lib/client.mjs';\nimport './helpers/isolated-home.mjs';\n");
  writeFileSync(join(dir, 'zz-reexport.test.mjs'), "export { HOME_ENV_NAME } from '../lib/brand.mjs';\nimport './helpers/isolated-home.mjs';\n");
  writeFileSync(join(dir, 'zz-commented.test.mjs'), "// import './helpers/isolated-home.mjs';\n/*\nimport './helpers/isolated-home.mjs';\n*/\nimport test from 'node:test';\nimport './helpers/isolated-home.mjs';\n");
  // The harness scripts are covered too.
  writeFileSync(join(dir, 'truthful.mjs'), "import { spawn } from 'node:child_process';\n");
  assert.deepEqual(missingHelper(dir), ['truthful.mjs', 'zz-cli-join.test.mjs', 'zz-commented.test.mjs', 'zz-dynamic.test.mjs',
    'zz-multiline.test.mjs', 'zz-reexport.test.mjs', 'zz-second.test.mjs']);
});

test('A17d: in this process the home, state directory, usage log and npm cache are isolated and counting is off', () => {
  assert.match(process.env.HOME, /test-home-/);
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(process.env[HOME_ENV_NAME], undefined);
  assert.equal(process.env.API_USAGE_LOG, undefined);
  assert.ok(process.env.npm_config_cache.startsWith(process.env.HOME));
  assert.equal(process.env[TELEMETRY_ENV_NAME], '0');
  assert.equal(process.env.DO_NOT_TRACK, '1');
});

test('A17d: a child started with a hand-built environment gets the isolated home and the off switch, through every function', async () => {
  const probe = ['-e', 'process.stdout.write(JSON.stringify({ home: process.env.HOME ?? null, off: process.env.' + TELEMETRY_ENV_NAME + ' ?? null, dnt: process.env.DO_NOT_TRACK ?? null }))'];
  const env = { PATH: process.env.PATH };
  const node = JSON.stringify(process.execPath);
  const read = text => JSON.parse(String(text).trim());
  const collect = child => new Promise(resolve => { let out = ''; child.stdout.on('data', c => out += c); child.on('close', () => resolve(out)); });
  const seen = {
    spawn: read(await collect(childProcess.spawn(process.execPath, probe, { env }))),
    spawnSync: read(childProcess.spawnSync(process.execPath, probe, { env }).stdout),
    execFile: read((await promisify(childProcess.execFile)(process.execPath, probe, { env })).stdout),
    execFileSync: read(childProcess.execFileSync(process.execPath, probe, { env })),
    exec: read((await promisify(childProcess.exec)(`${node} -e ${JSON.stringify(probe[1])}`, { env })).stdout),
    execSync: read(childProcess.execSync(`${node} -e ${JSON.stringify(probe[1])}`, { env })),
    fork: await new Promise(resolve => {
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-fork-'))), file = join(dir, 'probe.cjs');
      writeFileSync(file, probe[1].replace('process.stdout.write', 'process.send'));
      const child = childProcess.fork(file, [], { env });
      child.once('message', value => { child.kill(); rmSync(dir, { recursive: true, force: true }); resolve(JSON.parse(value)); });
    }),
  };
  for (const [name, value] of Object.entries(seen))
    assert.deepEqual(value, { home: process.env.HOME, off: '0', dnt: '1' }, `${name} reached a child without the isolated home`);
  // A test that sets a key itself, even to an empty string, keeps its value.
  assert.deepEqual(read(childProcess.spawnSync(process.execPath, probe, { env: { ...env, HOME: '/elsewhere', [TELEMETRY_ENV_NAME]: '' } }).stdout),
    { home: '/elsewhere', off: '', dnt: '1' });
  // A key set to undefined is not set (Node drops it): it is filled (A17e).
  assert.deepEqual(read(childProcess.spawnSync(process.execPath, probe, { env: { ...process.env, HOME: undefined, USERPROFILE: undefined, [TELEMETRY_ENV_NAME]: undefined } }).stdout),
    { home: process.env.HOME, off: '0', dnt: '1' });
  // Named ESM imports reach the wrapped functions too (syncBuiltinESMExports).
  assert.equal(namedSpawnSync.isolatedHome, true, 'a named import of spawnSync is not the wrapped function');
  assert.deepEqual(read(namedSpawnSync(process.execPath, probe, { env }).stdout), { home: process.env.HOME, off: '0', dnt: '1' });
  assert.deepEqual(read(namedExecFileSync(process.execPath, probe, { env })), { home: process.env.HOME, off: '0', dnt: '1' });
});

test('A17d: a test process that inherits a usage-log path or state directory drops them', t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-inherit-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const probe = join(dir, 'probe.mjs');
  writeFileSync(probe, `import ${JSON.stringify(new URL('./helpers/isolated-home.mjs', import.meta.url).href)};\n`
    + `process.stdout.write(JSON.stringify({ log: process.env.API_USAGE_LOG ?? null, state: process.env.${HOME_ENV_NAME} ?? null, home: process.env.HOME }));\n`);
  const canary = join(dir, 'canary');
  // A process that is not the helper's own (no mark for its pid) inheriting a canary home.
  const result = childProcess.spawnSync(process.execPath, [probe], { env: { PATH: process.env.PATH, HOME: canary, USERPROFILE: canary, TEST_ISOLATED_HOME: '1',
    API_USAGE_LOG: join(canary, 'usage.jsonl'), [HOME_ENV_NAME]: join(canary, 'state'), [TELEMETRY_ENV_NAME]: '', DO_NOT_TRACK: '' }, encoding: 'utf8' });
  const seen = JSON.parse(result.stdout);
  assert.equal(seen.log, null, 'an inherited API_USAGE_LOG was kept');
  assert.equal(seen.state, null, 'an inherited SANNR_HOME was kept');
  assert.ok(!seen.home.startsWith(canary), 'the inherited HOME was kept');
});

test('A17b: the runner gives every test process its own home, state directory, usage log and npm cache, with counting off', async t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'isolation-runner-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const canary = join(dir, 'canary');
  const inherited = { ...process.env, HOME: canary, USERPROFILE: canary, [HOME_ENV_NAME]: join(canary, 'state'), API_USAGE_LOG: join(canary, 'usage.jsonl'),
    [TELEMETRY_ENV_NAME]: '', DO_NOT_TRACK: '', npm_config_cache: join(canary, '.npm') };
  const env = isolatedEnvironment(inherited);
  for (const key of ['HOME', 'USERPROFILE', HOME_ENV_NAME, 'API_USAGE_LOG', 'npm_config_cache']) assert.ok(!env[key].startsWith(canary), `${key} still points at the inherited home`);
  assert.ok(env[HOME_ENV_NAME].startsWith(env.HOME) && env.API_USAGE_LOG.startsWith(env.HOME));
  assert.equal(env[TELEMETRY_ENV_NAME], '0');
  assert.equal(env.DO_NOT_TRACK, '1');
  // And executePhase really runs a test file with it.
  const out = join(dir, 'seen.json'), probe = join(dir, 'probe.test.mjs');
  writeFileSync(probe, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify({ home: process.env.HOME, state: process.env.${HOME_ENV_NAME}, log: process.env.API_USAGE_LOG, off: process.env.${TELEMETRY_ENV_NAME} }));\n`);
  const saved = { ...process.env };
  Object.assign(process.env, inherited);
  delete process.env.NODE_TEST_CONTEXT; // the runner runs as a top-level runner here
  let log = '';
  try { await executePhase({ name: 'probe', files: [probe] }, { root: dir, write: chunk => { log += chunk; } }); }
  finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); }
  let seen;
  try { seen = JSON.parse(readFileSync(out, 'utf8')); } catch { assert.fail(`the probe did not run: ${log}`); }
  for (const key of ['home', 'state', 'log']) assert.ok(!seen[key].startsWith(canary), `the runner passed the inherited ${key}`);
  assert.equal(seen.off, '0');
});
