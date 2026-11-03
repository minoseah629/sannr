// Release qualification: fresh default-dependency install of exact package bytes.
// Registry downloads are real; the gRPC operation is a controlled loopback fixture.
// No ambient npm credentials, lifecycle scripts, host registrations or API secrets.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const [archiveArg, outputArg] = process.argv.slice(2);
if (!archiveArg || !outputArg || process.argv.length !== 4) {
  console.error('Usage: node scripts/verify-protocol-install.mjs <exact-package.tgz> <receipt.json>');
  process.exit(2);
}
const archive = resolve(archiveArg), output = resolve(outputArg);
const exec = (command, args, options = {}) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024, ...options,
});
const manifest = JSON.parse(exec('tar', ['xOf', archive, 'package/package.json']));
const catalog = JSON.parse(exec('tar', ['xOf', archive, 'package/lib/runtime-dependencies.json']));
assert.deepEqual(catalog.optional['protobufjs@7.6.6'].declarationDependencies, { '@types/node': '@types/node@26.5.1' });
assert.deepEqual(manifest.dependencies ?? {}, {});
const scratch = mkdtempSync(join(tmpdir(), 'protocol-install-'));
try {
  const scenarios = [];
  for (const scenario of ['empty-project', 'competing-transitive']) {
  const home = join(scratch, `${scenario}-home`), project = join(scratch, `${scenario} project with spaces`);
  mkdirSync(home); mkdirSync(project);
  const userconfig = join(home, 'npmrc'), globalconfig = join(home, 'global-npmrc');
  writeFileSync(userconfig, ''); writeFileSync(globalconfig, '');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'protocol-install-fixture', private: true,
    ...(scenario === 'competing-transitive' ? { dependencies: { '@types/node': '26.6.3' } } : {}) }));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: scratch, CI: '1', NODE_PATH: '',
    npm_config_cache: join(scratch, `${scenario}-empty-npm-cache`), npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_userconfig: userconfig, npm_config_globalconfig: globalconfig,
    npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false' };
  // Do not pass a source lockfile or npm ci: exercise real consumer resolution.
  exec('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', archive], { cwd: project, env });
  const installed = join(project, 'node_modules', ...manifest.name.split('/'));
  const script = join(scratch, 'probe.mjs');
  writeFileSync(script, String.raw`
import assert from 'node:assert/strict';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const installed = process.argv[2];
const require = createRequire(join(installed, 'package.json'));
const moduleUrl = path => pathToFileURL(join(installed, path)).href;
const { verifyProtocolPackages } = await import(moduleUrl('lib/protocol-packages.mjs'));
const names = ['graphql', 'ws', '@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs'];
const verified = verifyProtocolPackages(...names).map(({ name, root }) => ({
  name, version: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
}));
// Enforce the reviewed distinction during actual execution, not just by names
// in a manifest: no gRPC code may load either declaration-only package.
const load = Module._load;
Module._load = function(request, ...args) {
  assert.doesNotMatch(request, /(?:^|[/\\])(?:@types[/\\]node|undici-types)(?:$|[/\\])/);
  return load.call(this, request, ...args);
};
// Third-party modules are loaded only after every artifact tree verifies.
const grpc = require('@grpc/grpc-js'), loader = require('@grpc/proto-loader');
const proto = 'syntax="proto3"; package fixture; message Input { string text=1; } message Output { string text=1; } service Service { rpc Read(Input) returns (Output); }';
writeFileSync('service.proto', proto);
const definition = grpc.loadPackageDefinition(loader.loadSync('service.proto'));
const server = new grpc.Server();
let calls = 0, attempts = 0;
server.addService(definition.fixture.Service.service, { Read(call, callback) {
  calls++; callback(null, { text: call.request.text });
} });
try {
  const port = await new Promise((resolve, reject) => server.bindAsync('127.0.0.1:0',
    grpc.ServerCredentials.createInsecure(), (error, port) => error ? reject(error) : resolve(port)));
  Object.assign(process.env, { API_BASE_URL: 'http://127.0.0.1:' + port, API_TIMEOUT_MS: '5000',
    API_CONTEXT_OFF: '1', API_CONTEXT_DIR: process.cwd(), API_EVIDENCE: join(process.cwd(), 'evidence'),
    API_USAGE_LOG: join(process.cwd(), 'usage.jsonl'), API_BUDGET: '10000' });
  const { apiRequest } = await import(moduleUrl('lib/client.mjs'));
  const request = { protocol: 'grpc', path: '',
    grpc: { proto: 'service.proto', service: 'fixture.Service', method: 'Read', body: { text: 'fixture-ok' } },
    expect: [{ json: 'text', equals: 'fixture-ok' }],
    _onAttempt() { attempts++; } };
  const result = await apiRequest(request);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.assertions.passed, 1);
  assert.equal(result.assertions.failed, 0);
  assert.equal(result.protocol.complete, true);
  assert.equal(result.protocol.attempts, 1);
  assert.equal(calls, 1); assert.equal(attempts, 1);
  // Resolve from the package that actually owns this transitive dependency.
  const protoRequire = createRequire(require.resolve('@grpc/proto-loader/package.json'));
  const protobufRequire = createRequire(protoRequire.resolve('protobufjs/package.json'));
  const typesManifest = protobufRequire.resolve('@types/node/package.json');
  const transitiveVersion = JSON.parse(readFileSync(typesManifest, 'utf8')).version;
  appendFileSync(protoRequire.resolve('long'), '\n// fixture runtime tamper\n');
  const refused = await apiRequest(request);
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, 'refused');
  assert.equal(refused.error.code, 'PROTOCOL_PACKAGE_INTEGRITY');
  assert.equal(calls, 1, 'Tampered cached adapter must not dispatch another RPC');
  assert.equal(attempts, 1);
  process.stdout.write(JSON.stringify({ verified, transitive: { name: '@types/node', version: transitiveVersion },
    grpc: { asserted: true, complete: true, calls, attempts },
    declaration_modules_loaded: 0,
    tamper: { code: refused.error.code, additional_attempts: 0 } }));
} finally { server.forceShutdown(); }
`);
  const checked = JSON.parse(exec(process.execPath, [script, installed], { cwd: project, env }));
  if (scenario === 'competing-transitive') {
    assert.equal(JSON.parse(readFileSync(join(project, 'node_modules/@types/node/package.json'), 'utf8')).version, '26.6.3');
  }
  scenarios.push({ scenario, empty_cache: true, ...checked });
  }
  const receipt = { v: 1, recorded_at: new Date().toISOString(), package: manifest.name,
    version: manifest.version, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
    platform: process.platform, arch: process.arch, node: process.version,
    npm: exec('npm', ['--version']).trim(),
    installation: { source_lock_supplied: false,
      optional_dependencies: 'default-enabled', lifecycle_scripts: false,
      registry: 'https://registry.npmjs.org/' }, scenarios,
    limits: 'Exact local tarball, not a published version; API operation uses loopback, not an external gRPC service.' };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt, null, 2));
} finally { rmSync(scratch, { recursive: true, force: true }); }
