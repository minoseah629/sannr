import { LAYOUT } from "../lib/layout.mjs";
// DEP-1 uses the actual artifact in a fresh project with an empty npm cache.
// Loopback traffic goes through the installed public CLI; all records stay in
// temporary projects. No repository API, host registration, or network registry.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePackage } from '../scripts/stage-package.mjs';
import { HOME_ENV_NAME, MCP_SERVER_KEY, NPM_PACKAGE, PRODUCT, TOOL_NAME } from '../lib/brand.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PINS = { '@grpc/grpc-js': '1.14.6', '@grpc/proto-loader': '0.8.1', graphql: '17.0.2', protobufjs: '8.8.1', ws: '8.22.0' };
let scratch, project, home, installed, env, manifest, entries, installOutput;
const sync = (command, args, cwd = ROOT, environment = process.env) => execFileSync(command, args,
  { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });

before(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'dep-1-package-')));
  // A test-only artifact input lets the same specimens exercise a retained
  // before-change tarball without changing the working tree under other tests.
  const archive = process.env.API_TEST_DEP1_ARCHIVE ?? (() => {
    const staged = stagePackage(ROOT, join(scratch, 'source'));
    const [packed] = JSON.parse(sync('npm', ['pack', '--json', '--pack-destination', scratch], staged));
    return join(scratch, packed.filename);
  })();
  entries = sync('tar', ['tzf', archive]).trim().split('\n');
  manifest = JSON.parse(sync('tar', ['xOf', archive, 'package/package.json']));
  project = join(scratch, 'project'); home = join(scratch, 'home');
  mkdirSync(project); mkdirSync(home);
  env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('API_') || name.startsWith(`${PRODUCT.toUpperCase()}_`)) delete env[name];
  Object.assign(env, { HOME: home, [HOME_ENV_NAME]: join(home, 'registry'), NODE_PATH: '',
    npm_config_cache: join(scratch, 'empty-npm-cache'), npm_config_registry: 'http://127.0.0.1:1',
    npm_config_offline: 'true', npm_config_ignore_scripts: 'false', API_USAGE_LOG: join(project, 'usage.jsonl') });
  sync('git', ['init', '-q'], project, env);
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'dep-1-fixture', private: true,
    devDependencies: { [NPM_PACKAGE]: `file:${archive}` },
    scripts: { preinstall: 'node -e "require(\'node:fs\').writeFileSync(\'lifecycle-enabled\',\'yes\')"' } }));
  installOutput = sync('npm', ['install', '--offline', '--omit=optional', '--ignore-scripts=false',
    '--foreground-scripts', '--no-audit', '--no-fund'], project, env);
  installed = join(project, 'node_modules', ...NPM_PACKAGE.split('/'));
});
after(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

function cli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(installed, 'bin', 'cli.mjs'), ...args],
      { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installed CLI exceeded its fixture deadline')); }, 20_000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function installedPackages(directory = join(project, 'node_modules')) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.')) return [];
    const path = join(directory, entry.name);
    if (entry.name.startsWith('@')) return installedPackages(path);
    const file = join(path, 'package.json');
    const name = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).name : null;
    return [...(name ? [name] : []), ...installedPackages(join(path, 'node_modules'))];
  });
}

test('DEP-1 packed manifest exact-pins the five adapters as optional and bundles none', () => {
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.optionalDependencies, PINS);
  assert.equal(Object.hasOwn(manifest, 'bundleDependencies'), false);
  assert.equal(Object.hasOwn(manifest, 'bundledDependencies'), false);
});

test('DEP-1 packed artifact ships no third-party tree or nested protobufjs and node types', () => {
  assert.deepEqual(entries.filter(entry => entry.includes('/node_modules/')), []);
});

test('DEP-1 offline omit-optional install runs enabled lifecycle scripts only for the fixture', () => {
  assert.equal(readFileSync(join(project, 'lifecycle-enabled'), 'utf8'), 'yes');
  assert.doesNotMatch(installOutput, /^> (?:protobufjs|@grpc\/|graphql|ws|@types\/node)[^\n]* (?:preinstall|install|postinstall)\b/m);
  assert.deepEqual(installedPackages().sort(), [NPM_PACKAGE]);
});

test('DEP-1 fresh optional-free install runs help, start, HTTP request, and mcp inspect', async t => {
  assert.deepEqual(installedPackages().sort(), [NPM_PACKAGE]);
  let requests = 0;
  const server = createServer((_req, response) => { requests++; response.writeHead(204); response.end(); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  writeFileSync(join(project, LAYOUT.environments), JSON.stringify({ v: 1, default: 'fixture',
    environments: { fixture: { baseUrl: `http://127.0.0.1:${server.address().port}` } } }));
  writeFileSync(join(project, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Fixture', version: '1' },
    paths: { '/health': { get: { responses: { '204': { description: 'No content' } } } } } }));
  const help = await cli(['--help']); assert.equal(help.code, 0, help.stderr); assert.match(help.stdout, /start/);
  const start = await cli(['start', '--json']); assert.equal(start.code, 0, start.stderr);
  const started = JSON.parse(start.stdout); assert.equal(started.status, 'configured'); assert.equal(started.requests_executed, 0);
  const request = await cli(['request', 'envelope', JSON.stringify({ requests: [
    { method: 'GET', path: '/health', expect: [{ status: 204 }] },
  ] })]);
  assert.equal(request.code, 0, request.stderr);
  const response = JSON.parse(request.stdout); assert.equal(response.ok, true); assert.equal(requests, 1);
  const inspection = await cli(['mcp', 'inspect', '--json']); assert.equal(inspection.code, 0, inspection.stderr);
  const inspected = JSON.parse(inspection.stdout).registrations.find(row => row.key === MCP_SERVER_KEY);
  assert.equal(inspected?.status, 'inspected'); assert.equal(inspected.record.initialized, true);
  assert.ok(inspected.record.declared.tools.some(tool => tool.name === TOOL_NAME));
  assert.equal(requests, 1, 'MCP inspection executes zero API requests');
});

test('DEP-1 packed GraphQL without graphql refuses by package and exact install hint', async () => {
  // Remove the dependency from the retained old artifact too, so this specimen
  // reaches the historical adapter-missing behavior rather than a live peer.
  rmSync(join(installed, 'node_modules', 'graphql'), { recursive: true, force: true });
  rmSync(join(project, 'node_modules', 'graphql'), { recursive: true, force: true });
  const result = await cli(['request', 'envelope', JSON.stringify({ requests: [{ protocol: 'graphql', path: '/graphql',
    graphql: { document: 'query Fixture { health }' } }] })]);
  assert.equal(result.code, 1);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, false); assert.equal(output.attempted, 0);
  assert.equal(output.results[0].error.code, 'PROTOCOL_PACKAGE_MISSING');
  assert.equal(output.results[0].error.package, 'graphql');
  assert.equal(output.results[0].error.install, 'npm install --save-exact --ignore-scripts graphql@17.0.2');
  assert.doesNotMatch(JSON.stringify(output), /ERR_MODULE_NOT_FOUND|node_modules|file:\/\//);
});
