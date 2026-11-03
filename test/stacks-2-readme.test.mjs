import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PRODUCT, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT, ensureLayout, renderLayoutReadme, migrateLayout } from '../lib/layout.mjs';
import { createFixtureStack } from './helpers/stack-fixture.mjs';

const begin = `<!-- ${PRODUCT}:begin -->`, end = `<!-- ${PRODUCT}:end -->`;
const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const read = root => readFileSync(join(root, LAYOUT.readme), 'utf8');
function project(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stacks-2-readme-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'home'));
  return root;
}
async function cli(root, args) {
  const child = spawn(process.execPath, [join(packageRoot, 'bin/cli.mjs'), ...args], {
    cwd: root, env: { PATH: process.env.PATH, HOME: join(root, 'home'),
      [HOME_ENV_NAME]: join(root, 'machine'), API_CONTEXT_DIR: root, API_USAGE_LOG: '', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data);
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('close', code => resolve({ code, stdout, stderr }));
  });
}
function passed(result) { assert.equal(result.code, 0, result.stdout + result.stderr); return result; }
async function server(t) {
  const child = spawn(process.execPath, [join(packageRoot, 'test/fixtures/stacks-1a-server.mjs'), 'alpha'], {
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.send({ command: 'stop' }); await exited;
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject); child.once('message', message => resolve(message.origin));
  });
}

test('STACKS-2 (e): outside paragraph and Markdown link survive connect, request and note', async t => {
  const root = project(t), origin = await server(t);
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.3',
    info: { title: 'Synthetic API', version: '1' }, paths: {
      '/users': { get: { responses: { '200': { description: 'Readiness' } } } },
    } }));
  createFixtureStack(root, { name: 'alpha', baseUrl: origin, contract: 'openapi.json' });
  passed(await cli(root, ['init', '--stack', 'alpha', '--contract', join(root, LAYOUT.collection, 'alpha/openapi.json')]));
  const prefix = 'A hand-written paragraph about this repository.\n\n';
  const suffix = '\n[Integration decisions](stacks/alpha/decisions.md)\n';
  const original = `${prefix}${begin}\nOld generated guide.\n${end}\n${suffix}`;
  writeFileSync(join(root, LAYOUT.readme), original);
  for (const args of [ ['connect', '--json'],
    ['request', 'GET', '/users', '--stack', 'alpha', '--expect-status', '200'],
    ['note', 'GET /users', 'The fixture returns readiness.', '--stack', 'alpha'] ]) {
    passed(await cli(root, args));
    const text = read(root);
    assert.ok(text.startsWith(prefix + begin + '\n'), `${args[0]} lost the outside paragraph`);
    assert.ok(text.endsWith(end + '\n' + suffix), `${args[0]} lost the handwritten link`);
    assert.equal(text.includes('Old generated guide.'), false);
    assert.equal(text.split(begin).length, 2);
  }
});

test('STACKS-2 R9: unknown unmarked guide is kept byte-for-byte and doctor names it', async t => {
  const root = project(t);
  createFixtureStack(root, { name: 'alpha' });
  const custom = '# Our guide\n\n[Lessons](stacks/alpha/lessons.md)\n';
  writeFileSync(join(root, LAYOUT.readme), custom);
  ensureLayout(root);
  assert.equal(read(root), custom);
  const report = passed(await cli(root, ['doctor', '--stack', 'alpha', '--offline', '--json']));
  const checks = JSON.parse(report.stdout).checks;
  assert.ok(checks.some(check => check.name === 'layout-readme' && check.state === 'WARN'
    && check.detail.includes(LAYOUT.readme)), report.stdout);
});

test('STACKS-2 R9: generated unmarked guides acquire markers; malformed markers are preserved', t => {
  const root = project(t);
  createFixtureStack(root, { name: 'alpha' });
  for (const stacks of [false, true]) {
    const unmarked = renderLayoutReadme({ stacks }).replace(begin + '\n', '').replace(end + '\n', '');
    writeFileSync(join(root, LAYOUT.readme), unmarked);
    ensureLayout(root);
    assert.ok(read(root).startsWith(begin + '\n'));
    assert.ok(read(root).endsWith(end + '\n'));
  }
  for (const custom of [`${begin}\nUnclosed.\n`, `${end}\nReversed\n${begin}\n`,
    `${begin}\n${begin}\nAmbiguous\n${end}\n`, `Our guide explains \`${begin}\` and \`${end}\` inline.\n`]) {
    writeFileSync(join(root, LAYOUT.readme), custom);
    ensureLayout(root);
    assert.equal(read(root), custom);
  }
});

test('STACKS-2 R9: layout migration preserves an authored guide and its link', t => {
  const root = project(t), old = join(root, '.former');
  mkdirSync(old);
  writeFileSync(join(old, 'layout.json'), JSON.stringify({ kind: 'repo-api-layout', v: 1, product: 'former', collection: 'stacks' }));
  const custom = '# Our API guide\n\n[Decisions](decisions.md)\n';
  writeFileSync(join(old, 'README.md'), custom);
  const preview = migrateLayout(root, { dryRun: true });
  assert.ok(preview.moved.some(move => move.to === LAYOUT.readme));
  migrateLayout(root);
  assert.equal(read(root), custom);
});

// Historical bodies are captured from the exact source revisions named in the
// fixture, not inferred by a prefix/heading that might also own a user's text.
test('STACKS-2 R9: all shipped generated guides upgrade, appended links remain user-owned', t => {
  const root = project(t);
  createFixtureStack(root, { name: 'alpha' });
  const versions = JSON.parse(readFileSync(new URL('./fixtures/layout-generated-guides.json', import.meta.url)));
  for (const version of versions) {
    writeFileSync(join(root, LAYOUT.readme), version.body);
    ensureLayout(root);
    assert.ok(read(root).startsWith(begin + '\n'), version.commit);
    const customized = version.body + '\n[Local decisions](decisions.md)\n';
    writeFileSync(join(root, LAYOUT.readme), customized);
    ensureLayout(root);
    assert.equal(read(root), customized, version.commit);
  }
});
