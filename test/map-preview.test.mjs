import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { connect } from 'node:net';
import { execFile, fork } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createMapPreview, startMapPreview } from '../lib/map-preview.mjs';

const HTML = '<!doctype html><meta charset="utf-8"><title>Local map</title><h1>Route → API</h1>';
const LIB = new URL('../lib/map-preview.mjs', import.meta.url).href;
const WORKER = fileURLToPath(new URL('../bin/map-preview.mjs', import.meta.url));

function get(url, { path, method = 'GET', headers = {} } = {}) {
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: parsed.hostname, port: parsed.port,
      method, path: path ?? parsed.pathname, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('Preview fixture timed out.')));
    req.end();
  });
}

async function preview(t, options) {
  const result = await createMapPreview(HTML, options);
  t.after(result.close);
  return result;
}

test('map preview serves exact immutable UTF-8 bytes inline at one unpredictable loopback route', async t => {
  const first = await preview(t), second = await preview(t);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/);
  assert.notEqual(new URL(first.url).pathname, new URL(second.url).pathname);
  const response = await get(first.url);
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, Buffer.from(HTML));
  assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(response.headers['content-disposition'], 'inline');
  assert.equal(response.headers['content-length'], String(Buffer.byteLength(HTML)));
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['access-control-allow-origin'], undefined);
  assert.equal(response.headers['content-security-policy'], undefined, 'preview must not override the generated map policy');
  const head = await get(first.url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(HTML)));
  assert.deepEqual((await get(first.url)).body, response.body, 'reloading must preserve the immutable snapshot');
});

test('map preview rejects routes, traversal, query variants, methods and nonexact hosts without leaking the map', async t => {
  const { url } = await preview(t), route = new URL(url).pathname;
  for (const path of ['/', '/favicon.ico', '/etc/passwd', '/../package.json', '/%2e%2e/package.json',
    `${route}/`, `${route}?download=1`, `http://example.invalid${route}`]) {
    const result = await get(url, { path });
    assert.equal(result.status, 404, path);
    assert.ok(!result.body.includes(Buffer.from('<!doctype html>')), 'rejected routes must not expose the snapshot');
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) {
    const result = await get(url, { method });
    assert.equal(result.status, 405, method);
    assert.equal(result.headers.allow, 'GET, HEAD');
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const host of ['localhost', 'example.invalid', '127.0.0.1', `${new URL(url).host}.example.invalid`]) {
    const result = await get(url, { headers: { Host: host } });
    assert.equal(result.status, 421, host);
    assert.ok(!result.body.includes(Buffer.from('<!doctype html>')));
  }
});

test('map preview expiry closes active sockets and accepting sockets with no request', async t => {
  const instance = await preview(t, { ttlMs: 150 });
  const target = new URL(instance.url);
  const socket = connect(Number(target.port), target.hostname);
  socket.on('error', () => {});
  t.after(() => socket.destroy());
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write('GET / HTTP/1.1\r\n');
  const socketClosed = new Promise(resolve => socket.once('close', resolve));
  await Promise.all([instance.closed, socketClosed]);
  await assert.rejects(get(instance.url), { code: 'ECONNREFUSED' });
  await instance.close();
});

test('map preview rejects invalid payloads and lifetimes before listening', async () => {
  for (const value of [undefined, '', {}, 'x'.repeat(16 * 1024 * 1024 + 1)])
    await assert.rejects(createMapPreview(value), { code: 'MAP_PREVIEW_INPUT_INVALID' });
  for (const ttlMs of [0, -1, 1.5, Infinity, 30 * 60_000 + 1])
    await assert.rejects(createMapPreview(HTML, { ttlMs }), { code: 'MAP_PREVIEW_TTL_INVALID' });
  await assert.rejects(startMapPreview(''), { code: 'MAP_PREVIEW_INPUT_INVALID' });
});

test('detached preview survives its launching process and stops cleanly on SIGTERM', async t => {
  const script = `
    import { startMapPreview } from ${JSON.stringify(LIB)};
    const result = await startMapPreview(${JSON.stringify(HTML)});
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 7000 });
  const result = JSON.parse(stdout);
  t.after(() => { try { process.kill(result.pid, 'SIGKILL'); } catch { /* Already exited. */ } });
  assert.equal(result.expiresInMinutes, 30);
  assert.ok(Number.isSafeInteger(result.pid));
  assert.deepEqual((await get(result.url)).body, Buffer.from(HTML), 'worker must survive launcher exit');
  process.kill(result.pid, 'SIGTERM');
  const deadline = Date.now() + 2000;
  let stopped = false;
  while (Date.now() < deadline) {
    try { await get(result.url); }
    catch (error) {
      if (error.code === 'ECONNREFUSED') { stopped = true; break; }
      if (error.code !== 'ECONNRESET') throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(stopped, true, 'SIGTERM must promptly close the loopback listener');
});

test('worker exits when uninitialized IPC closes or an invalid initialization arrives', async () => {
  for (const initialize of [false, true]) {
    const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const exited = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Uninitialized worker did not exit.')); }, 2000);
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    if (initialize) child.send({ type: 'unexpected' });
    else child.disconnect();
    assert.equal(await exited, 0);
  }
});

test('an uninitialized worker also exits on its deadline while the IPC parent remains connected', async t => {
  const child = fork(WORKER, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Worker exceeded its initialization deadline.')); }, 7000);
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(code, 0);
  assert.ok(Date.now() - started < 7000);
});

test('listener startup failure rejects with a fixed diagnostic and leaves no preview worker', async t => {
  const root = mkdtempSync(join(tmpdir(), 'map-preview-failure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const hook = join(root, 'no-listen.mjs');
  writeFileSync(hook, `import { Server } from 'node:net';
    Server.prototype.listen = () => { throw new Error('private-host-value'); };
  `);
  const script = `
    import { startMapPreview } from ${JSON.stringify(LIB)};
    try { await startMapPreview(${JSON.stringify(HTML)}); process.exitCode = 2; }
    catch (error) { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', timeout: 7000, env: { ...process.env, NODE_OPTIONS: `--import=${hook}` } });
  assert.equal(JSON.parse(stdout).code, 'MAP_PREVIEW_START_FAILED');
  assert.doesNotMatch(stdout, /private-host-value/);
});
