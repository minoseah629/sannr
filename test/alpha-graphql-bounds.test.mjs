import { PRODUCT } from '../lib/brand.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const adapter = new URL('../lib/protocols/graphql.mjs', import.meta.url).href;
const vocabulary = new URL('../lib/protocol-errors.mjs', import.meta.url).href;
const runner = `
  import { readFileSync } from 'node:fs';
  const { analyzeGraphql } = await import(${JSON.stringify(adapter)});
  const { publicProtocolCode } = await import(${JSON.stringify(vocabulary)});
  const requests = JSON.parse(readFileSync(0, 'utf8'));
  const results = [];
  for (const graphql of requests) {
    try { await analyzeGraphql({ graphql }, { root: process.cwd() }); results.push({ accepted: true }); }
    catch (error) { results.push({ accepted: false, code: publicProtocolCode(error, 'PROTOCOL_INPUT_INVALID'), message: error.message }); }
  }
  process.stdout.write(JSON.stringify(results));
`;

// Every probe executes in a temporary project, with no inherited application
// settings and no request or response payloads in diagnostics.
function probe(t, documents) {
  const root = mkdtempSync(join(tmpdir(), 'alpha-graphql-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('API_') && !name.startsWith(`${PRODUCT.toUpperCase()}_`)));
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', runner], {
    cwd: root, env, input: JSON.stringify(documents.map(document => ({ document }))),
    encoding: 'utf8', timeout: 5000,
  });
  assert.equal(result.error, undefined, 'GraphQL analysis must finish inside the fixture deadline');
  assert.equal(result.status, 0, 'GraphQL analysis child must complete successfully');
  assert.equal(result.stderr, '', 'GraphQL analysis must not log payloads or diagnostics');
  return JSON.parse(result.stdout);
}

const nested = depth => `{ ${'child { '.repeat(depth - 1)}leaf ${'} '.repeat(depth)}`;
const aliases = count => `{ ${Array.from({ length: count }, (_, index) => `a${index}: leaf`).join(' ')} }`;

test('AH-3 GraphQL depth 32 is accepted and depth 33 is refused by GRAPHQL_DEPTH_LIMIT', t => {
  const [within, beyond] = probe(t, [nested(32), nested(33)]);
  assert.equal(within.accepted, true);
  assert.equal(beyond.accepted, false);
  assert.equal(beyond.code, 'GRAPHQL_DEPTH_LIMIT');
});

test('AH-3 GraphQL aliases 256 are accepted and alias 257 is refused by GRAPHQL_ALIAS_LIMIT', t => {
  const [within, beyond] = probe(t, [aliases(256), aliases(257)]);
  assert.equal(within.accepted, true);
  assert.equal(beyond.accepted, false);
  assert.equal(beyond.code, 'GRAPHQL_ALIAS_LIMIT');
});

test('AH-3 GraphQL fragment expansion cannot bypass the depth or alias bounds', t => {
  const deep = '{ ...F0 } ' + Array.from({ length: 33 }, (_, index) =>
    `fragment F${index} on Node { ${index === 32 ? 'leaf' : `child { ...F${index + 1} }`} }`).join(' ');
  const broad = '{ ...F0 } ' + Array.from({ length: 10 }, (_, index) =>
    `fragment F${index} on Node { ${index === 9 ? 'a: leaf' : `...F${index + 1} ...F${index + 1}`} }`).join(' ');
  const [depth, breadth] = probe(t, [deep, broad]);
  assert.equal(depth.code, 'GRAPHQL_DEPTH_LIMIT');
  assert.equal(breadth.code, 'GRAPHQL_ALIAS_LIMIT');
});

test('AH-3 GraphQL cycles, missing fragments and duplicate fragments are refused without a schema', t => {
  const results = probe(t, [
    '{ ...A } fragment A on Node { ...B } fragment B on Node { ...A }',
    '{ ...Missing }',
    '{ ...A } fragment A on Node { leaf } fragment A on Node { other }',
  ]);
  for (const result of results) assert.equal(result.code, 'GRAPHQL_FRAGMENT_INVALID');
});

test('AH-3 GraphQL depth rejection precedes parser recursion and withholds document values', t => {
  const value = randomUUID();
  const [result] = probe(t, [nested(2000).replace('leaf', `leaf(input: "${value}")`)]);
  assert.equal(result.code, 'GRAPHQL_DEPTH_LIMIT');
  assert.equal(JSON.stringify(result).includes(value), false, 'A refused document value must not enter public diagnostics');
});
