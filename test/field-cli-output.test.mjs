import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const cli = join(packageRoot, 'bin/cli.mjs');
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'field-output-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [join(packageRoot, 'test/fixtures/field-cli-output-server.mjs')],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const origin = await new Promise((resolve, reject) => {
    child.once('message', message => resolve(message.origin)); child.once('error', reject);
  });
  t.after(async () => {
    if (child.exitCode !== null) return;
    const closed = new Promise(resolve => child.once('close', resolve)); child.send('stop'); await closed;
  });
  const contract = join(root, 'openapi.json');
  writeFileSync(contract, JSON.stringify({ openapi: '3.0.0', info: { title: 'Fixture', version: '1' },
    paths: { '/probe': { get: { responses: { '200': { description: 'ok' } } } },
      '/probe?unsupported=true': { get: { responses: { '200': { description: 'ok' } } } } } }));
  createFixtureStack(root, { baseUrl: origin, contract });
  const envelope = { stack: 'fixture', requests: [1, 2, 3].map(n => ({
    protocol: 'http', method: 'GET', path: '/probe', id: `read-${n}`, expect: [{ status: 200 }],
  })) };
  writeFileSync(join(root, 'requests.json'), JSON.stringify(envelope));
  const env = { PATH: process.env.PATH, HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'machine'),
    API_CONTEXT_DIR: root, API_USAGE_LOG: join(root, 'usage.jsonl'), NO_COLOR: '1' };
  mkdirSync(env.HOME);
  const evidence = () => readdirSync(join(root, fixtureEvidencePath())).filter(f => /^run-.*\.json$/.test(f));
  const execute = (command, args, { closeStderr = false, onOutput } = {}) => new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', bytes => { onOutput?.(); stdout += bytes; });
    if (closeStderr) proc.stderr.destroy(); else proc.stderr.on('data', bytes => stderr += bytes);
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20_000);
    proc.once('error', reject);
    proc.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
  return { root, env, envelope, evidence, execute };
}

test('CLI-002 protocol piped to head -c1 names EPIPE and retains one evidence file per request', async t => {
  const f = await fixture(t), preload = join(f.root, 'preload.mjs');
  // Make the real head consumer close the pipe before the result is written.
  // This removes OS pipe-buffer timing from the regression, without mocking I/O.
  writeFileSync(preload, "process.stdout.write('x'); await new Promise(resolve => setTimeout(resolve, 200));\n");
  const result = await f.execute('bash', ['-c', 'set -o pipefail; "$@" | head -c1', 'field-pipe',
    process.execPath, '--import', preload, cli, 'protocol', 'requests.json']);
  assert.equal(result.code, 1, result.stderr);
  assert.equal(result.stdout, 'x');
  assert.match(result.stderr, /CLI_OUTPUT_CLOSED/);
  assert.match(result.stderr, /EPIPE/);
  assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
  assert.equal(f.evidence().length, 3);
});

test('CLI-002 a closed diagnostic pipe cannot abort protocol requests before evidence', async t => {
  const f = await fixture(t);
  const result = await f.execute(process.execPath, [cli, 'protocol', 'requests.json'], { closeStderr: true });
  assert.equal(f.evidence().length, 3, `exit=${result.code}, stdout=${result.stdout}`);
  assert.equal(JSON.parse(result.stdout).results.length, 3);
  assert.equal(result.code, 0, 'An unavailable best-effort warning sink must not abort the requests.');
});

test('CLI-002 all protocol evidence exists before the first result byte', async t => {
  const f = await fixture(t); let filesAtFirstByte;
  const result = await f.execute(process.execPath, [cli, 'protocol', 'requests.json'], {
    onOutput: () => { filesAtFirstByte ??= f.evidence().length; },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(filesAtFirstByte, 3);
  for (const row of JSON.parse(result.stdout).results) {
    assert.match(row.evidence, /^run-/);
    assert.doesNotThrow(() => JSON.parse(readFileSync(join(f.root, fixtureEvidencePath(), `${row.evidence}.json`), 'utf8')));
  }
});

test('CLI-002 the standalone request launcher drains errors and keeps batch evidence', async t => {
  const f = await fixture(t), preload = join(f.root, 'preload.mjs');
  writeFileSync(preload, "process.stdout.write('x'); await new Promise(resolve => setTimeout(resolve, 200));\n");
  const result = await f.execute('bash', ['-c', 'set -o pipefail; "$@" | head -c1', 'field-pipe',
    process.execPath, '--import', preload, join(packageRoot, 'bin/request.mjs'), 'envelope', JSON.stringify(f.envelope)]);
  assert.equal(result.code, 1, result.stderr);
  assert.match(result.stderr, /CLI_OUTPUT_CLOSED/);
  assert.equal(f.evidence().length, 3);
});
