import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProtocolPackage } from '../lib/runtime-dependencies.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const catalog = JSON.parse(readFileSync(join(root, 'lib/runtime-dependencies.json'), 'utf8'));

test('gRPC declaration exclusions name exact reviewed upstream edges and contain no executable files', () => {
  const edges = Object.fromEntries(Object.entries(catalog.optional)
    .filter(([, value]) => value.declarationDependencies)
    .map(([key, value]) => [key, value.declarationDependencies]));
  assert.deepEqual(edges, {
    'protobufjs@7.6.6': { '@types/node': '@types/node@26.5.1' },
    '@types/node@26.5.1': { 'undici-types': 'undici-types@8.9.0' },
  });
  const require = createRequire(join(root, 'node_modules/@grpc/proto-loader/package.json'));
  const protobuf = dirname(require.resolve('protobufjs/package.json'));
  const fromProtobuf = createRequire(join(protobuf, 'package.json'));
  for (const key of ['@types/node@26.5.1', 'undici-types@8.9.0']) {
    const item = catalog.optional[key];
    const manifest = JSON.parse(readFileSync(fromProtobuf.resolve(`${item.name}/package.json`), 'utf8'));
    assert.equal(manifest.types, 'index.d.ts');
    assert.ok(!manifest.main && !manifest.exports);
    assert.deepEqual(manifest.scripts ?? {}, {});
    assert.ok(Object.keys(item.files).every(file => file.endsWith('.d.ts')
      || ['LICENSE', 'README.md', 'package.json'].includes(file)));
  }
  // Inspect the qualified upstream JS as well as its package metadata.
  for (const [key, directory] of [['protobufjs@7.6.6', protobuf],
    ['@grpc/proto-loader@0.8.1', dirname(require.resolve('@grpc/proto-loader/package.json'))]]) {
    for (const file of Object.keys(catalog.optional[key].files).filter(file => file.endsWith('.js')))
      assert.doesNotMatch(readFileSync(join(directory, file), 'utf8'), /@types\/node|undici-types/);
  }
});

test('gRPC tolerates absent declaration packages but still refuses changed executable transitive bytes', t => {
  const dir = mkdtempSync(join(tmpdir(), 'protocol-declarations-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(root, 'node_modules'), join(dir, 'node_modules'), { recursive: true });
  const grpcRoot = join(dir, 'node_modules/@grpc/grpc-js');
  const require = createRequire(join(grpcRoot, 'package.json'));
  const loader = createRequire(require.resolve('@grpc/proto-loader/package.json'));
  const protobuf = createRequire(loader.resolve('protobufjs/package.json'));
  const typesRoot = dirname(protobuf.resolve('@types/node/package.json'));
  const types = createRequire(join(typesRoot, 'package.json'));
  const undiciRoot = dirname(types.resolve('undici-types/package.json'));
  assert.doesNotThrow(() => verifyProtocolPackage('@grpc/grpc-js', grpcRoot));
  rmSync(typesRoot, { recursive: true });
  rmSync(undiciRoot, { recursive: true });
  assert.doesNotThrow(() => verifyProtocolPackage('@grpc/grpc-js', grpcRoot));
  appendFileSync(loader.resolve('long'), '\n// changed runtime fixture\n');
  assert.throws(() => verifyProtocolPackage('@grpc/grpc-js', grpcRoot), { code: 'PROTOCOL_PACKAGE_INTEGRITY' });
});
