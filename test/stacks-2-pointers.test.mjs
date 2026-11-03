import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, CONTEXT_BASENAME, POINTER_BEGIN, POINTER_END } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { blockCode, blockText } from '../lib/block-text.mjs';

const cli = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value)); };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'stacks-2-pointers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), NO_COLOR: '1' };
  mkdirSync(env.HOME);
  const shim = join(root, 'node_modules', '.bin', PRODUCT);
  mkdirSync(dirname(shim), { recursive: true });
  writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath.replaceAll("'", "'\\''")}' '${cli.replaceAll("'", "'\\''")}' "$@"\n`); chmodSync(shim, 0o755);
  writeFileSync(join(root, 'CLAUDE.md'), '# Team instructions\n\n');
  return { root, env };
}
function stack(f, name, notes, { empty = false, contract = false } = {}) {
  const folder = join(f.root, LAYOUT.collection, name);
  const operations = Object.fromEntries(notes.map((note, i) => [`GET /items/${i}`, { notes: [note],
    notes_provenance: [{ by: 'agent', at: '2026-10-07' }], notes_superseded: [null], verified_at: null,
    status_codes: [], fields: {}, effect: 'read' }]));
  writeJson(join(folder, 'stack.json'), { v: 1, name, ...(empty ? {} : { default_environment: 'production' }),
    ...(contract ? { contract: 'openapi.json' } : {}), environments: empty ? {} : {
      production: { baseUrl: `https://${name}.example.test` }, staging: { baseUrl: `https://staging-${name}.example.test` },
    } });
  if (contract) writeJson(join(folder, 'openapi.json'), { openapi: '3.0.3', info: { title: 'Fixture API', version: '1' }, paths: Object.fromEntries(notes.map((_, i) => [`/items/${i}`, { get: { responses: { '200': { description: 'Fixture response' } } } }])) });
  writeJson(join(folder, CONTEXT_BASENAME), { v: 0, api: { name: name + ' API' }, operations });
  return operations;
}
async function connect(f) {
  const child = spawn(process.execPath, [cli, 'connect', '--json'], { cwd: f.root, env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => stdout += b); child.stderr.on('data', b => stderr += b);
  const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exit, 0, stdout + stderr);
  return readFileSync(join(f.root, 'AGENTS.md'), 'utf8');
}
const section = (text, name) => text.split(`### Stack \`${name}\``)[1]?.split('\n### Stack ')[0];
const facts = text => text.split('\n').filter(line => /^- `[^`]+` — /.test(line));

test('STACKS-2(b) managed blocks deliver every stack default first with review labels and preserved fact text', async t => {
  const f = fixture(t);
  const notes = ['An authored fixture lesson.', 'A line\nwith `code`, <tag>, and punctuation.'];
  const alpha = stack(f, 'alpha', notes), beta = stack(f, 'beta', ['Only beta context.'], { contract: true });
  stack(f, 'unsorted', ['An unfiled operation.'], { empty: true });
  writeJson(join(f.root, LAYOUT.directory, 'defaults.json'), { default_stack: 'beta' });
  const text = await connect(f);
  assert.deepEqual([...text.matchAll(/^### Stack `([^`]+)`/gm)].map(m => m[1]), ['beta', 'alpha', 'unsorted']);
  for (const [name, operations] of [['alpha', alpha], ['beta', beta]]) {
    const part = section(text, name); assert.ok(part, name);
    assert.match(part, /Environments: `production`, `staging`/);
    assert.match(part, name === 'beta' ? /Contract: bound/ : /Contract: not_bound/);
    // Review data is additive; the original text still crosses the same
    // escaping seam and remains associated with its own operation.
    for (const line of facts(part)) assert.match(line, / \[Review data: unreviewed; basis: unknown \(inferred\)\]$/);
    assert.deepEqual(facts(part).map(line => line.replace(/ \[Review data:.*\]$/, '')),
      Object.entries(operations).flatMap(([op, entry]) => entry.notes.map(note => `- \`${blockCode(op)}\` — ${blockText(note)}`)));
  }
  assert.match(section(text, 'unsorted'), /1 operation/);
  assert.ok(section(text, 'unsorted').includes(`${PRODUCT} stack move --to <stack> "<METHOD /path>"`));
  const claude = readFileSync(join(f.root, 'CLAUDE.md'), 'utf8');
  const body = content => content.slice(content.indexOf(POINTER_BEGIN), content.indexOf(POINTER_END) + POINTER_END.length);
  assert.equal(body(text), body(claude));
});

test('STACKS-2(c) per-stack and total caps name omitted counts and exact scoped show commands', async t => {
  const f = fixture(t);
  for (const name of ['alpha', 'beta', 'charlie', 'delta', 'echo']) stack(f, name,
    Array.from({ length: 20 }, (_, i) => `${name} lesson ${i}.`));
  const text = await connect(f);
  assert.equal(facts(text).length, 60, 'total facts cap is 60');
  for (const name of ['alpha', 'beta', 'charlie', 'delta', 'echo']) {
    const part = section(text, name); assert.ok(part, name);
    const shown = name === 'echo' ? 0 : 15;
    assert.equal(facts(part).length, shown);
    assert.ok(part.includes(`show --stack ${name}`), part);
    assert.match(part, new RegExp(`${20 - shown} (?:gotchas|notes) omitted`));
    assert.match(part, name === 'echo' ? /total cap/ : /per-stack cap/);
  }
});

test('STACKS-2(c) inherited claims share per-stack and total fact caps with gotchas', async t => {
  const f = fixture(t);
  for (const name of ['alpha', 'beta', 'charlie', 'delta', 'echo']) {
    stack(f, name, Array.from({ length: 10 }, (_, i) => `${name} gotcha ${i}.`));
    const path = join(f.root, LAYOUT.collection, name, CONTEXT_BASENAME);
    const ctx = JSON.parse(readFileSync(path));
    ctx.api_context = { v: 1, operations: { fixture: { identity: { stack: name, operation: 'GET /inherited',
      provider: name, protocol: 'http', environment: 'production' }, observations: [
      { basis: 'authored', notes: Array.from({ length: 10 }, (_, i) => `${name} inherited ${i}.`) },
    ] } } };
    writeJson(path, ctx);
  }
  const text = await connect(f);
  assert.equal(text.split('\n').filter(line => line.startsWith('- `GET ')).length, 60);
  for (const name of ['alpha', 'beta', 'charlie', 'delta']) {
    const part = section(text, name);
    assert.equal(facts(part).length, 10);
    assert.equal(part.split('\n').filter(line => line.startsWith('- `GET /inherited`')).length, 5);
    assert.match(part, /5 inherited lessons omitted \(per-stack cap 15\)/);
    assert.ok(part.includes(`show --stack ${name}`));
  }
  const echo = section(text, 'echo');
  assert.match(echo, /10 inherited lessons omitted \(per-stack cap 15; total cap 60\)/);
  assert.ok(echo.includes('show --stack echo'));
});

test('STACKS-2(b) environment contract overrides are named without borrowing default state', async t => {
  const f = fixture(t);
  stack(f, 'alpha', ['Fixture lesson.'], { contract: true });
  const configPath = join(f.root, LAYOUT.collection, 'alpha', 'stack.json');
  const config = JSON.parse(readFileSync(configPath));
  config.environments.staging.contract = 'missing.openapi.json';
  writeJson(configPath, config);
  const text = await connect(f);
  assert.match(section(text, 'alpha'), /Contract: bound \(default environment `production`\)/);
  assert.match(section(text, 'alpha'), /Contract by environment: `production`: bound; `staging`: missing/);
});

test('STACKS-2(b) scoped-only knowledge is counted once per operation, including unsorted', async t => {
  const f = fixture(t);
  stack(f, 'alpha', ['Legacy fixture lesson.']);
  stack(f, 'unsorted', [], { empty: true });
  for (const name of ['alpha', 'unsorted']) {
    const path = join(f.root, LAYOUT.collection, name, CONTEXT_BASENAME);
    const ctx = JSON.parse(readFileSync(path));
    const entries = [['stranded-production', 'GET /stranded', 'production'],
      ['stranded-staging', 'GET /stranded', 'staging'],
      ...(name === 'alpha' ? [['legacy-also-observed', 'GET /items/0', 'production']] : [])];
    ctx.api_context = { v: 1, operations: Object.fromEntries(entries.map(([id, operation, environment]) =>
      [id, { identity: { operation, provider: name, protocol: 'http', environment, stack: name },
        observations: [{ basis: 'authored', notes: ['A scoped authored fixture lesson.'] }] }])) };
    writeJson(path, ctx);
  }
  const text = await connect(f);
  assert.match(section(text, 'alpha'), /— 2 operations; 2 written, 0 observed, 0 asserted, 0 verified/);
  assert.match(section(text, 'unsorted'), /— 1 operation; 1 written, 0 observed, 0 asserted, 0 verified/);
  assert.match(section(text, 'unsorted'), /1 operation awaiting a destination stack/);
  assert.match(section(text, 'unsorted'), /A scoped authored fixture lesson/);
});
