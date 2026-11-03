// Release-only qualification: the product bytes come exclusively from an exact
// local tarball. Only synthetic tests/helpers/fixtures come from the source tree.
// No third-party API traffic, publication, or user's repository is involved.
import assert from 'node:assert/strict';
import { BIN_NAME, PRODUCT } from '../lib/brand.mjs';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [archiveArg, receiptArg, sourceArg] = process.argv.slice(2);
if (!archiveArg || !receiptArg || !sourceArg || process.argv.length !== 5) {
  console.error('Usage: node verify-stacks-install.mjs <exact-package.tgz> <receipt.json> <test-source-root>');
  process.exit(2);
}
const archive = resolve(archiveArg), receiptPath = resolve(receiptArg), source = resolve(sourceArg);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(execFileSync('tar', ['xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
const scratch = mkdtempSync(join(tmpdir(), `${PRODUCT}-artifact-stacks-`));
const home = join(scratch, 'home'), project = join(scratch, 'consumer with spaces');
mkdirSync(home); mkdirSync(project);
writeFileSync(join(home, '.npmrc'), '');
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: `${PRODUCT}-release-consumer`, private: true }) + '\n');
const env = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, CI: '1', NO_COLOR: '1',
  npm_config_cache: join(scratch, 'empty-cache'), npm_config_userconfig: join(home, '.npmrc'),
  npm_config_registry: 'http://127.0.0.1:1/', npm_config_offline: 'true',
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
const tests = [
  'connect-first-stack.test.mjs', 'name-registration.test.mjs', 'stack-migration-engine.test.mjs',
  'stack-migration-layout.test.mjs', 'stack-migration-state.test.mjs',
  'stacks-1a.test.mjs', 'stacks-2-request.test.mjs', 'stacks-2-pointers.test.mjs',
  'stacks-2-map.test.mjs', 'stacks-2-readme.test.mjs',
];
const receipt = { schema_version: 1, captured_at: new Date().toISOString(), platform: process.platform,
  arch: process.arch, node: process.version, package: manifest.name, version: manifest.version,
  sha256: sha(readFileSync(archive)), state: 'failed', scenarios: [
    'fresh offline npm install of exact tarball with optional adapters omitted',
    'canonical registration migration, ownership conflicts and portable instructions',
    'migration split, defaults, unsorted, evidence bytes/modes and credential references',
    'migration dry-run, apply, idempotence and scoped operation move',
    'two-stack CLI and actual stdio MCP auth, environment and evidence separation',
    'known notes, scoped show/context, map/view counts and withheld values',
    'pointer fact format, caps and exact scoped retrieval commands',
    'README outside paragraph/link preservation and unknown-guide warning',
  ], tests: tests.map(file => ({ file, sha256: sha(readFileSync(join(source, 'test', file))) })),
  limits: 'Unpublished local tarball; synthetic loopback traffic only. Test fixtures are copied beside installed package bytes. No desktop-host UI reload or registry publication is implied. Cold npx launcher/binding qualification is a separate receipt.', steps: [] };
async function run(command, args, options = {}) {
  const started = performance.now();
  const child = spawn(command, args, { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180_000);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timeout);
  receipt.steps.push({ command, args, exit, duration_ms: Math.round(performance.now() - started) });
  return { exit, stdout, stderr };
}
function files(root, prefix = '') {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(root, entry.name), relative) : [relative];
  });
}
try {
  assert.deepEqual(manifest.bin, { [BIN_NAME]: './bin/cli.mjs' });
  const install = await run('npm', ['install', '--offline', '--omit=optional', '--ignore-scripts', '--no-audit', '--no-fund', archive]);
  assert.equal(install.exit, 0, install.stdout + install.stderr);
  const installed = join(project, 'node_modules', ...manifest.name.split('/'));
  assert.ok(existsSync(join(project, 'node_modules', '.bin', BIN_NAME)));
  const productHashes = new Map(files(installed).map(path => [path, sha(readFileSync(join(installed, path)))]));
  for (const file of tests) cpSync(join(source, 'test', file), join(installed, 'test', file), { recursive: true });
  cpSync(join(source, 'test/helpers'), join(installed, 'test/helpers'), { recursive: true });
  cpSync(join(source, 'test/fixtures'), join(installed, 'test/fixtures'), { recursive: true });
  const result = await run(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...tests.map(file => `test/${file}`)], { cwd: installed });
  const log = result.stdout + result.stderr;
  const logPath = receiptPath.replace(/\.json$/, '') + '.tap';
  mkdirSync(dirname(logPath), { recursive: true }); writeFileSync(logPath, log);
  receipt.test_log_sha256 = sha(log); receipt.test_log = logPath;
  const number = label => Number(new RegExp(`^# ${label} (\\d+)$`, 'm').exec(log)?.[1]);
  receipt.counts = { tests: number('tests'), pass: number('pass'), fail: number('fail'), skipped: number('skipped') };
  assert.equal(result.exit, 0, log);
  assert.ok(receipt.counts.tests > 50); assert.equal(receipt.counts.fail, 0); assert.equal(receipt.counts.skipped, 0);
  for (const [path, digest] of productHashes) assert.equal(sha(readFileSync(join(installed, path))), digest, `Fixture changed installed product: ${path}`);
  receipt.installed_product_files_unchanged = productHashes.size;
  receipt.state = 'passed';
} catch (error) { receipt.error = { name: error.name, message: error.message }; process.exitCode = 1; }
finally {
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  rmSync(scratch, { recursive: true, force: true });
}
console.log(JSON.stringify({ state: receipt.state, package: receipt.package, version: receipt.version,
  node: receipt.node, platform: receipt.platform, sha256: receipt.sha256, counts: receipt.counts,
  error: receipt.error?.message?.slice(0, 500) }, null, 2));
