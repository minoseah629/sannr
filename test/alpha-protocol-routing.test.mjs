import { PRODUCT } from '../lib/brand.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const moduleUrl = new URL('../lib/http-operation-context.mjs', import.meta.url);

async function probe(t, source) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-protocol-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('API_') && !key.startsWith(`${PRODUCT.toUpperCase()}_`)));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { matchHttpOperation, httpContractDeclaresPath } = await import(${JSON.stringify(moduleUrl.href)});
    const contract = (...paths) => ({ routes: paths.map(path => ({ method: 'GET', endpointPath: path })) });
    ${source}
  `], { cwd: root, env, encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL' });
  assert.equal(stderr, '');
  return stdout;
}

test('AH-3 route matcher rejects forty-character adjacent-placeholder near misses within milliseconds', async t => {
  const elapsed = Number(await probe(t, `
    const route = '/v1/{a}{b}{c}{d}{e}{f}{g}{h}{i}{j}{k}{l}/x';
    const target = '/v1/' + 'a'.repeat(40);
    const start = performance.now();
    for (const pathname of [target, target + '/y']) {
      assert.equal(matchHttpOperation(contract(route), 'GET', pathname), null);
      assert.equal(httpContractDeclaresPath(contract(route), pathname), false);
    }
    // A suffix inside the same segment must also avoid wildcard backtracking.
    assert.equal(matchHttpOperation(contract(route.replace('/x', 'x')), 'GET', target), null);
    process.stdout.write(String(performance.now() - start));
  `));
  assert.ok(elapsed < 1000, 'bounded route probes must complete in under one second');
  t.diagnostic(`forty-character near-miss probes: ${elapsed.toFixed(3)} ms`);
});

test('AH-3 HTTP operation matching never constructs a regular expression from contract text', () => {
  assert.doesNotMatch(readFileSync(moduleUrl, 'utf8'), /\b(?:new\s+)?RegExp\s*\(/u);
});

test('AH-3 segment matcher preserves literal, Unicode, trailing-slash and ambiguity semantics', async t => {
  await probe(t, `
    const routes = contract('/v1/{id}', '/v1/latest');
    assert.equal(matchHttpOperation(routes, 'GET', '/v1/latest').endpointPath, '/v1/latest');
    assert.equal(matchHttpOperation(routes, 'POST', '/v1/latest'), null);
    assert.equal(matchHttpOperation(contract('/v1/{a}', '/v1/{b}'), 'GET', '/v1/value'), null);
    assert.equal(httpContractDeclaresPath(contract('/v1/{a}', '/v1/{b}'), '/v1/value'), true);
    for (const [route, path, expected] of [
      ['/v1/{id}', '/v1/value', true],
      ['/v1/{id}', '/v1/value/', true],
      ['/v1/{id}', '/v1/value//', false],
      ['/v1/{id}', '/v1/', false],
      ['/v1/{id}', '/v1/a/b', false],
      ['/v1/{a}{b}', '/v1/aa', true],
      ['/v1/{a}{b}', '/v1/a', false],
      ['/v1/{a}{b}', '/v1/😀', false],
      ['/v1/{a}{b}', '/v1/😀😀', true],
      ['/v1/{id}', '/v1/a%2Fb', true],
      ['/v1/pre-{a}-{b}.json', '/v1/pre-one-two.json', true],
      ['/v1/pre-{a}-{b}.json', '/v1/pre-one-.json', false],
      ['/v1/a.b+(c)[d]', '/v1/a.b+(c)[d]/', true],
      ['/v1/a.b+(c)[d]', '/v1/axbccccd', false],
      ['/v1/{broken', '/v1/{broken/', true],
      ['/v1/{}', '/v1/nonempty', true],
      ['/v1/a/', '/v1/a//', true],
      ['/v1/a/', '/v1/a', false],
      ['/', '/', true],
      ['/', '//', true],
      ['/', '', false],
    ]) {
      assert.equal(Boolean(matchHttpOperation(contract(route), 'GET', path)), expected, 'segment semantics');
      assert.equal(httpContractDeclaresPath(contract(route), path), expected, 'declared-path semantics');
    }
  `);
});
