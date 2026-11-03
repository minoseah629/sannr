import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { installedMcpLaunch, pinnedMcpPackage } from '../lib/advertisement.mjs';
import { codexServerBlock, installedProjectEntry, mcpTargets, planRemoval, planRuntimeRepair, planTarget, projectEntry } from '../lib/connect.mjs';
import { currentSetupBinding, setupBindingId } from '../lib/setup-binding.mjs';
import { discoverMcpRegistrations } from '../lib/mcp-registrations.mjs';
import { registeredContextTools } from '../lib/pointer-context.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { MCP_SERVER_KEY, NPM_PACKAGE, PRODUCT } from '../lib/brand.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'))).version;
const write = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha4-durable-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function packagePath(root, version = VERSION) {
  const path = join(root, '_npx/fixture/node_modules', ...NPM_PACKAGE.split('/'));
  write(join(path, 'package.json'), JSON.stringify({ name: NPM_PACKAGE, version }));
  return path;
}
function targetText(target, entry) {
  return target.format === 'toml' ? codexServerBlock(entry) + '\n'
    : JSON.stringify({ [target.shape.container]: { [MCP_SERVER_KEY]: target.shape.entryFor(entry), neighbor: { command: '/keep/me', args: ['yes'] } }, neighbor: 'preserved' }, null, 2) + '\n';
}

test('npm launch pins a package version without a cache path, mutable tag or install scripts', t => {
  const root = scratch(t), packageRoot = packagePath(root);
  const launch = installedMcpLaunch(packageRoot, { npxCommand: 'npx', nodeCommand: 'node' });
  assert.deepEqual(launch, { command: 'npx', args: ['--yes', '--ignore-scripts', `--package=${NPM_PACKAGE}@${VERSION}`, '--', PRODUCT, 'mcp', 'serve'] });
  assert.equal(pinnedMcpPackage(launch), `${NPM_PACKAGE}@${VERSION}`);
  assert.equal(installedMcpLaunch(ROOT), null, 'unpublished source retains its direct launch');
  for (const version of ['alpha', '^1.0.0', '1.0.0;false']) {
    packagePath(root, version);
    assert.equal(installedMcpLaunch(packageRoot), null);
  }
  for (const changed of [
    { ...launch, command: 'sh' },
    { ...launch, args: [...launch.args, '--other'] },
    { ...launch, args: launch.args.map(arg => arg.startsWith('--package=') ? `--package=${NPM_PACKAGE}@alpha` : arg) },
    { ...launch, args: launch.args.map(arg => arg === PRODUCT ? 'different-client' : arg) },
  ]) assert.equal(pinnedMcpPackage(changed), null);
});

test('setup identity survives cache pruning and still detects version, config, target and host changes', t => {
  const root = scratch(t), packageRoot = packagePath(root);
  const config = join(root, 'api-environments.json'); write(config, '{"v":1}');
  const cfg = { file: config, name: 'staging', baseUrl: 'https://fixture.invalid', baseUrlOverride: true, defaults: { evidenceDir: 'private-evidence' }, contract: '' };
  const launch = installedMcpLaunch(packageRoot, { npxCommand: 'npx' });
  const entry = projectEntry(root, cfg, { launch, env: { API_USAGE_LOG: '' } });
  assert.equal(entry.env.API_CONFIG, config);
  assert.equal(entry.env.API_ENV, 'staging');
  assert.equal(entry.env.API_BASE_URL, cfg.baseUrl);
  assert.equal(entry.env.API_CONTRACT, '');
  assert.equal(entry.env.API_EVIDENCE, join(root, 'private-evidence'));
  for (const target of mcpTargets(root)) write(target.file, targetText(target, entry));
  const original = entry.env.API_SETUP_BINDING;
  assert.equal(installedProjectEntry(root).env.API_SETUP_BINDING, original);
  assert.equal(currentSetupBinding(root, discoverMcpRegistrations(root)), original);
  rmSync(join(root, '_npx'), { recursive: true });
  assert.equal(setupBindingId(root, entry), original);
  assert.equal(currentSetupBinding(root, discoverMcpRegistrations(root)), original);
  const next = structuredClone(entry); next.args[2] = `--package=${NPM_PACKAGE}@1.2.3`;
  assert.notEqual(setupBindingId(root, next), original);
  const other = structuredClone(entry); other.env.API_BASE_URL = 'https://other.invalid';
  assert.notEqual(setupBindingId(root, other), original);
  write(config, '{"v":1,"default":"other"}');
  assert.equal(currentSetupBinding(root, discoverMcpRegistrations(root)), null);
});

test('repair migrates vanished generated npm-cache and Node paths across all hosts, with exact ownership and unwire', t => {
  const root = scratch(t), packageRoot = packagePath(root);
  mkdirSync(join(root, '.cursor')); mkdirSync(join(root, '.vscode'));
  const desired = projectEntry(root, {}, { launch: installedMcpLaunch(packageRoot, { npxCommand: 'npx' }), env: { API_USAGE_LOG: '' } });
  const old = projectEntry(root, {}, { serverPath: join(packageRoot, 'server.mjs'), nodePath: '/gone/Cellar/node/22.0.0/bin/node', env: { API_USAGE_LOG: '' } });
  rmSync(join(root, '_npx'), { recursive: true });
  for (const target of mcpTargets(root)) {
    const prior = targetText(target, old);
    const repaired = planRuntimeRepair(prior, target, desired);
    assert.equal(repaired.action, 'repair', target.id);
    assert.equal(repaired.durable, true);
    assert.equal(planTarget(repaired.text, target, desired).action, 'unchanged');
    assert.equal(planRuntimeRepair(repaired.text, target, desired).action, 'unchanged');
    assert.equal(planRemoval(repaired.text, target).action, 'removed');
    if (target.format !== 'toml') assert.equal(JSON.parse(repaired.text).neighbor, 'preserved');
    for (const change of [
      e => e.args.push('--custom'),
      e => e.env.API_BASE_URL = 'https://user-owned.invalid',
      e => e.env.USER_FLAG = 'keep',
      e => e.env.PATH = '/user-owned/bin',
      e => e.cwd = '/user-owned',
      e => e.command = '/custom/launcher',
      e => e.args = [join(root, 'unrelated/server.mjs')],
    ]) {
      const custom = structuredClone(old); change(custom);
      // Codex serializer deliberately omits unsupported custom cwd, so test
      // its equivalent extra managed setting directly.
      let text = targetText(target, custom);
      if (custom.cwd && target.format === 'toml') text = text.replace('tool_timeout_sec =', 'cwd = "/user-owned"\ntool_timeout_sec =');
      assert.equal(planRuntimeRepair(text, target, desired).action, 'refused', `${target.id}: ${change}`);
    }
    if (target.format === 'toml') {
      const edited = prior.replace('tool_timeout_sec = 330', 'tool_timeout_sec = 999');
      assert.equal(planRuntimeRepair(edited, target, desired).action, 'refused');
    }
  }
});

test('version upgrade repairs owned launch PATH and keeps custom PATH intact', t => {
  const root = scratch(t), packageRoot = packagePath(root);
  const launch = installedMcpLaunch(packageRoot);
  assert.ok(launch.env?.PATH);
  assert.doesNotMatch(launch.env.PATH, /_npx|Cellar|\\.nvm/);
  const desired = projectEntry(root, {}, { launch, env: { API_USAGE_LOG: '' } });
  const prior = structuredClone(desired); prior.args[2] = `--package=${NPM_PACKAGE}@0.1.0-alpha.3`;
  prior.env.API_SETUP_BINDING = setupBindingId(root, prior);
  for (const target of mcpTargets(root)) {
    assert.equal(planRuntimeRepair(targetText(target, prior), target, desired).action, 'repair');
    const custom = structuredClone(prior); custom.env.PATH += ':/team/custom';
    assert.equal(planRuntimeRepair(targetText(target, custom), target, desired).action, 'refused');
    const customCommand = structuredClone(prior); customCommand.command = '/team/custom/npx';
    assert.equal(planRuntimeRepair(targetText(target, customCommand), target, desired).action, 'refused');
  }
});

test('old cache registration can repair to an existing retained project package', t => {
  const root = scratch(t), packageRoot = packagePath(root);
  const local = join(root, 'node_modules', ...NPM_PACKAGE.split('/'), 'server.mjs');
  write(local, '// retained fixture');
  const old = projectEntry(root, {}, { serverPath: join(packageRoot, 'server.mjs'), nodePath: '/gone/Cellar/node/22.0.0/bin/node', env: { API_USAGE_LOG: '' } });
  const desired = projectEntry(root, {}, { serverPath: local, env: { API_USAGE_LOG: '' } });
  for (const target of mcpTargets(root)) {
    const result = planRuntimeRepair(targetText(target, old), target, desired);
    assert.equal(result.action, 'repair');
    assert.equal(planTarget(result.text, target, desired).action, 'unchanged');
  }
});

test('context pointers advertise only a matching executable and bound exact package version', t => {
  const root = scratch(t), packageRoot = packagePath(root), server = join(packageRoot, 'server.mjs');
  write(server, '// fixture identity only');
  write(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1, repository: { id: 'fixture/repo', name: 'Fixture' }, nodes: [], dependencies: [] }));
  const launch = installedMcpLaunch(packageRoot);
  const entry = projectEntry(root, {}, { launch, env: { API_USAGE_LOG: '' } });
  const check = candidate => registeredContextTools(root, [{ key: MCP_SERVER_KEY, ...candidate }], server);
  assert.deepEqual(check(entry), { read: true, record: true });
  const readonly = structuredClone(entry); readonly.env.API_REQUEST_READ_ONLY = '1'; readonly.env.API_SETUP_BINDING = setupBindingId(root, readonly);
  assert.deepEqual(check(readonly), { read: true, record: false });
  for (const changed of [
    e => e.args[2] = `--package=${NPM_PACKAGE}@1.2.3`,
    e => e.args[2] = `--package=${NPM_PACKAGE}@alpha`,
    e => e.args.push('--foreign'),
    e => e.env.API_CONTEXT_OFF = '1',
    e => e.env.API_CONTEXT_DIR = dirname(root),
    e => e.env.API_SETUP_BINDING = 'setup-v1:' + '0'.repeat(64),
  ]) { const candidate = structuredClone(entry); changed(candidate); assert.deepEqual(check(candidate), { read: false, record: false }); }
  const wrong = join(root, 'foreign/npx'); write(wrong, '#!/bin/sh\\nexit 0\\n'); chmodSync(wrong, 0o755);
  const candidate = { ...entry, command: wrong };
  candidate.env = { ...entry.env, API_SETUP_BINDING: setupBindingId(root, candidate) };
  assert.deepEqual(check(candidate), { read: false, record: false });
});

function command(command, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '';
    const stop = () => { try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const timer = setTimeout(() => { stop(); reject(new Error(`command timeout: ${stderr}`)); }, 30000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

// Real npm cache mechanics, bounded to this loopback registry. No public
// registry, API request, provider token or user npm cache is used.
test('actual pinned MCP initializes after cache prune and tag movement despite a foreign local bin', { timeout: 60000 }, async t => {
  const root = scratch(t), pkg = join(root, 'package'), repo = join(root, 'repo');
  mkdirSync(pkg); mkdirSync(repo);
  for (const file of ['bin', 'lib', 'skill', 'server.mjs']) cpSync(join(ROOT, file), join(pkg, file), { recursive: true });
  const meta = { name: NPM_PACKAGE, version: VERSION, type: 'module', bin: { [PRODUCT]: './bin/cli.mjs' }, files: ['bin/', 'lib/', 'skill/', 'server.mjs'], scripts: { postinstall: 'node -e "process.exit(89)"' } };
  write(join(pkg, 'package.json'), JSON.stringify(meta));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', root], { cwd: pkg, encoding: 'utf8' }))[0];
  const tarball = readFileSync(join(root, packed.filename));
  const integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
  const hits = []; let alpha = VERSION;
  const registry = createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith('/tarball')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(tarball); }
    if (!decodeURIComponent(req.url).startsWith('/' + NPM_PACKAGE)) { res.writeHead(404); return res.end('{}'); }
    const version = { ...meta, dist: { tarball: `http://127.0.0.1:${registry.address().port}/tarball.tgz`, integrity } };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ name: NPM_PACKAGE, 'dist-tags': { alpha, latest: alpha }, versions: { [VERSION]: version } }));
  });
  await new Promise(resolve => registry.listen(0, '127.0.0.1', resolve));
  t.after(() => { registry.closeAllConnections(); registry.close(); });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const cache = join(root, 'npm-cache');
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), SANNR_HOME: join(root, 'state'), API_USAGE_LOG: '',
    npm_config_cache: cache, npm_config_registry: `http://127.0.0.1:${registry.address().port}/`, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', npm_config_fetch_retries: '0' };
  const first = await command('npx', ['--yes', '--ignore-scripts', `--package=${NPM_PACKAGE}@${VERSION}`, '--', PRODUCT, 'connect', '--json'], { cwd: repo, env });
  assert.equal(first.code, 0, first.stderr + first.stdout);
  const entry = JSON.parse(readFileSync(join(repo, '.mcp.json'))).mcpServers[MCP_SERVER_KEY];
  assert.equal(pinnedMcpPackage(entry), `${NPM_PACKAGE}@${VERSION}`);
  assert.doesNotMatch(JSON.stringify(entry), /_npx|Cellar/);
  const original = entry.env.API_SETUP_BINDING;
  assert.equal(currentSetupBinding(repo, discoverMcpRegistrations(repo)), original);
  // A repo-local older package/bin must not supersede the pinned MCP package.
  const foreign = join(repo, 'node_modules', ...NPM_PACKAGE.split('/'));
  write(join(foreign, 'package.json'), JSON.stringify({ ...meta, version: '0.0.1' }));
  write(join(foreign, 'bin/cli.mjs'), '#!/usr/bin/env node\nprocess.stderr.write("FOREIGN_BIN_EXECUTED"); process.exit(97);\n');
  mkdirSync(join(repo, 'node_modules/.bin'), { recursive: true });
  symlinkSync(join(foreign, 'bin/cli.mjs'), join(repo, 'node_modules/.bin', PRODUCT));
  rmSync(cache, { recursive: true, force: true }); alpha = '99.0.0';
  assert.equal(currentSetupBinding(repo, discoverMcpRegistrations(repo)), original);
  const input = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'prune-fixture', version: '1' } } }) + '\n' +
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n';
  const result = await command(entry.command, entry.args, { cwd: repo,
    env: { ...env, PATH: '/usr/bin:/bin', ...entry.env }, input });
  assert.equal(result.code, 0, result.stderr + result.stdout);
  assert.doesNotMatch(result.stderr, /FOREIGN_BIN_EXECUTED/);
  const replies = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(replies.find(reply => reply.id === 1)?.result?.serverInfo);
  assert.ok(replies.find(reply => reply.id === 2)?.result?.tools.some(tool => tool.description?.includes(original)));
  assert.ok(hits.filter(path => path.startsWith('/tarball')).length >= 2, 'cold launch must restore package from controlled registry');
  assert.ok(existsSync(cache));
});
