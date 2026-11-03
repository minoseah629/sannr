import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as inventory from '../lib/runtime-dependencies.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dependency-inventory-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('DEP-1 bundle validation permits absent optional packages and rejects unpinned present bytes', t => {
  const dir = scratch(t);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ optionalDependencies: { graphql: '17.0.2' } }));
  assert.doesNotThrow(() => inventory.validateRuntimeBundle(['package.json'], dir));
  mkdirSync(join(dir, 'node_modules/unlisted'), { recursive: true });
  writeFileSync(join(dir, 'node_modules/unlisted/index.js'), 'export default 1;');
  assert.throws(() => inventory.validateRuntimeBundle(['package.json', 'node_modules/unlisted/index.js'], dir), /pinned|inventory/);
});

test('DEP-1 installed adapter verification rejects modified package bytes before loading', t => {
  const dir = scratch(t);
  const installed = join(dir, 'node_modules/ws');
  cpSync(join(root, 'node_modules/ws'), installed, { recursive: true });
  assert.equal(typeof inventory.verifyProtocolPackage, 'function');
  assert.doesNotThrow(() => inventory.verifyProtocolPackage('ws', installed));
  writeFileSync(join(installed, 'lib/websocket.js'), '// modified fixture code\n');
  assert.throws(() => inventory.verifyProtocolPackage('ws', installed), { code: 'PROTOCOL_PACKAGE_INTEGRITY' });
});

test('DEP-1 dependency inventory follows the artifact and ignores unpacked local modules', t => {
  const dir = scratch(t);
  mkdirSync(join(dir, 'scripts')); mkdirSync(join(dir, 'lib'));
  cpSync(join(root, 'scripts/pin-runtime-dependencies.mjs'), join(dir, 'scripts/pin-runtime-dependencies.mjs'));
  const manifest = { name: 'inventory-fixture', version: '1.0.0', type: 'module', files: ['lib/'] };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': manifest,
    'node_modules/not-shipped': { version: '1.0.0' } } }));
  writeFileSync(join(dir, 'lib/index.mjs'), 'export const fixture = true;\n');
  const result = spawnSync(process.execPath, ['scripts/pin-runtime-dependencies.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(readFileSync(join(dir, 'lib/runtime-dependencies.json'), 'utf8'));
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--offline', '--json'],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0];
  assert.deepEqual(Object.keys(catalog.files), packed.files.map(f => f.path).filter(p => p.startsWith('node_modules/')));
  assert.deepEqual(catalog.packages, {});
});

test('DEP-1 optional artifact pins follow the clean-install lock including transitive versions', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const catalog = JSON.parse(readFileSync(join(root, 'lib/runtime-dependencies.json'), 'utf8'));
  for (const [path, item] of Object.entries(lock.packages).filter(([path]) => path)) {
    const name = item.name ?? path.split('node_modules/').at(-1);
    assert.ok(catalog.optional[`${name}@${item.version}`], `Missing locked artifact: ${name}@${item.version}`);
  }
});

test('DEP-1 clean-installed optional adapters verify their complete transitive artifact tree', () => {
  for (const name of ['graphql', 'ws', '@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs'])
    assert.doesNotThrow(() => inventory.verifyProtocolPackage(name, join(root, 'node_modules', name)), name);
});
