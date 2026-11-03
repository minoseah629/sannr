import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, rmSync, lstatSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { STATE_DIR_NAME, LEGACY_STATE_DIR_NAME, HOME_ENV_NAME } from '../lib/brand.mjs';

const helper = new URL('../lib/machine-state.mjs', import.meta.url).href;
const feedback = new URL('../lib/feedback.mjs', import.meta.url).href;
const client = new URL('../lib/client.mjs', import.meta.url).href;
const root = new URL('../', import.meta.url).pathname;
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'name-state-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const old = join(home, `.${LEGACY_STATE_DIR_NAME}`), state = join(home, `.${STATE_DIR_NAME}`);
  mkdirSync(join(old, 'tokens'), { recursive: true, mode: 0o700 });
  writeFileSync(join(old, 'usage.jsonl'), '{"status":200}\n', { mode: 0o600 });
  writeFileSync(join(old, 'tokens', 'synthetic.json'), '{"expiresAt":0}', { mode: 0o600 });
  writeFileSync(join(old, 'keep.txt'), 'synthetic untouched file', { mode: 0o600 });
  return { home, old, state };
}
function child(home, code, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: home, NO_COLOR: '1', API_CONTEXT_OFF: '1', ...extra };
    for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', b => stdout += b); p.stderr.on('data', b => stderr += b);
    p.on('error', reject); p.on('close', exit => resolve({ exit, stdout: stdout.trim(), stderr }));
  });
}
const result = r => { assert.equal(r.exit, 0, r.stderr); return JSON.parse(r.stdout); };
const snapshot = path => { const s = statSync(path); return { ino:s.ino, mtimeMs:s.mtimeMs, bytes:readFileSync(path, 'utf8') }; };
const readUsage = `import { readUsage } from ${JSON.stringify(feedback)}; console.log(JSON.stringify(readUsage()));`;
const readPaths = `import { usageLogPath, usageLogPaths, tokenCachePath, tokenCachePaths } from ${JSON.stringify(helper)};
  console.log(JSON.stringify({ usage:usageLogPath(), logs:usageLogPaths(), tokens:tokenCachePath(), caches:tokenCachePaths() }));`;

test('R11(g) reading legacy usage leaves both stores in place, byte-for-byte, without creating current state', async t => {
  const f = fixture(t), usage = join(f.old, 'usage.jsonl'), token = join(f.old, 'tokens', 'synthetic.json');
  const before = [snapshot(usage), snapshot(token)];
  assert.deepEqual(result(await child(f.home, readUsage)), [{ status:200 }]);
  assert.deepEqual([snapshot(usage), snapshot(token)], before);
  assert.equal(existsSync(f.state), false);
});

test('R11(g) importing, preparing and reading paths never move, delete or create machine stores', async t => {
  const f = fixture(t);
  const r = result(await child(f.home, `await import(${JSON.stringify(client)}); import { prepareMachineState } from ${JSON.stringify(helper)};
    console.log(JSON.stringify(await prepareMachineState()));`));
  assert.deepEqual(r, { moved:[], pending:[] });
  assert.equal(existsSync(f.state), false);
  const paths = result(await child(f.home, readPaths));
  assert.equal(paths.usage, join(f.state, 'usage.jsonl'));
  assert.equal(paths.tokens, join(f.state, 'tokens'));
  assert.deepEqual(paths.logs, [join(f.old, 'usage.jsonl')]);
  assert.deepEqual(paths.caches, [join(f.old, 'tokens')]);
  assert.equal(existsSync(f.state), false);
});

test('R11(g) current then legacy reads count both logs with the home override honored', async t => {
  const f = fixture(t), custom = join(f.home, 'custom-state');
  mkdirSync(join(custom, 'tokens'), { recursive:true, mode:0o700 });
  writeFileSync(join(custom, 'usage.jsonl'), '{"status":201}\n', { mode:0o600 });
  const env = { [HOME_ENV_NAME]:custom };
  const paths = result(await child(f.home, readPaths, env));
  assert.deepEqual(paths.logs, [join(custom, 'usage.jsonl'), join(f.old, 'usage.jsonl')]);
  assert.deepEqual(paths.caches, [join(custom, 'tokens'), join(f.old, 'tokens')]);
  assert.deepEqual(result(await child(f.home, readUsage, env)), [{ status:201 }, { status:200 }]);
  assert.equal(existsSync(f.state), false);
});

test('R11(g) explicit usage-log overrides stay isolated and disabled logging reads no fallback', async t => {
  const f = fixture(t), override = join(f.home, 'request-usage.jsonl');
  writeFileSync(override, '{"status":202}\n', { mode:0o600 });
  assert.deepEqual(result(await child(f.home, readUsage, { API_USAGE_LOG:override })), [{ status:202 }]);
  assert.deepEqual(result(await child(f.home, readUsage, { API_USAGE_LOG:'' })), []);
  assert.equal(existsSync(f.state), false);
  assert.equal(existsSync(join(f.old, 'usage.jsonl')), true);
});

test('R11(g) a home override pointing at the legacy location is counted once', async t => {
  const f = fixture(t);
  const paths = result(await child(f.home, readPaths, { [HOME_ENV_NAME]:f.old }));
  assert.deepEqual(paths.logs, [join(f.old, 'usage.jsonl')]);
  assert.deepEqual(paths.caches, [join(f.old, 'tokens')]);
});

test('R11(g) leftover names are reported once and diagnostics name both read locations without token contents', async t => {
  const f = fixture(t), before = snapshot(join(f.old, 'keep.txt'));
  mkdirSync(join(f.state, 'tokens'), { recursive:true, mode:0o700 });
  writeFileSync(join(f.state, 'usage.jsonl'), '{"status":201}\n', { mode:0o600 });
  const code = `import { inspectLegacyState } from ${JSON.stringify(helper)}; console.log(JSON.stringify(inspectLegacyState({ reportOnce:true })));`;
  const first = result(await child(f.home, code)), second = result(await child(f.home, code));
  assert.deepEqual(first.leftovers, ['keep.txt', 'tokens', 'usage.jsonl']);
  assert.deepEqual(first.reported, first.leftovers);
  assert.deepEqual(second.reported, []);
  assert.deepEqual(first.reads, { usage:[join(f.state, 'usage.jsonl'), join(f.old, 'usage.jsonl')], tokens:[join(f.state, 'tokens'), join(f.old, 'tokens')] });
  assert.doesNotMatch(JSON.stringify(first), /synthetic untouched|expiresAt/);
  assert.deepEqual(snapshot(join(f.old, 'keep.txt')), before);
});

async function serverFixture(t) {
  const p = spawn(process.execPath, [new URL('./fixtures/name-state-server.mjs', import.meta.url).pathname], {
    env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (p.connected) p.send('stop'); else p.kill(); });
  const origin = await new Promise((resolve, reject) => {
    p.once('error', reject); p.once('message', msg => resolve(msg.origin));
    p.once('exit', exit => reject(new Error(`Fixture exited before ready: ${exit}`)));
  });
  return { origin, counts: () => new Promise(resolve => { p.once('message', resolve); p.send('counts'); }) };
}
function cacheFile(server) {
  return `${createHash('sha256').update(JSON.stringify([`${server.origin}/token`, 'synthetic-client', 'synthetic-secret', null, null])).digest('hex').slice(0,32)}.json`;
}
function cached(path, { expired = false, accessToken = 'synthetic-cached-access', refreshToken } = {}) {
  const token = { accessToken, expiresAt:expired ? Date.now()-60_000 : Date.now()+60_000, ...(refreshToken ? { refreshToken } : {}) };
  writeFileSync(path, JSON.stringify(token), { mode:0o600 });
}
const request = `import { apiRequest } from ${JSON.stringify(client)}; console.log(JSON.stringify(await apiRequest({ method:'GET', path:'/x', expect:[{ status:200 }] })));`;
function oauthEnv(f, server, extra = {}) {
  return { API_BASE_URL:server.origin, API_EVIDENCE:join(f.home, 'evidence'), API_USAGE_LOG:'',
    API_AUTH:'oauth:FIXTURE_CLIENT:FIXTURE_SECRET', API_OAUTH_TOKEN_URL:`${server.origin}/token`,
    FIXTURE_CLIENT:'synthetic-client', FIXTURE_SECRET:'synthetic-secret', ...extra };
}

test('R11(g) new loopback usage appends only to current state, preserving legacy files and private modes', async t => {
  const f = fixture(t), server = await serverFixture(t), before = snapshot(join(f.old, 'usage.jsonl'));
  const r = result(await child(f.home, request, { API_BASE_URL:server.origin, API_EVIDENCE:join(f.home, 'evidence') }));
  assert.equal(r.ok, true);
  assert.deepEqual(snapshot(join(f.old, 'usage.jsonl')), before);
  assert.equal(existsSync(join(f.old, 'tokens', 'synthetic.json')), true);
  const rows = readFileSync(join(f.state, 'usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1); assert.equal(rows[0].status, 200);
  assert.equal(statSync(f.state).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.state, 'usage.jsonl')).mode & 0o777, 0o600);
});

test('R11(g) two concurrent real processes reuse an old token despite an unrelated current cache; no grants or moves', async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server), oldFile = join(f.old, 'tokens', file);
  cached(oldFile);
  mkdirSync(join(f.state, 'tokens'), { recursive:true, mode:0o700 });
  writeFileSync(join(f.state, 'tokens', 'unrelated.json'), '{}', { mode:0o600 });
  const before = snapshot(oldFile), barrier = join(f.home, 'go');
  const code = `import { existsSync } from 'node:fs'; import { setTimeout } from 'node:timers/promises';
    while (!existsSync(${JSON.stringify(barrier)})) await setTimeout(2); ${request}`;
  const pending = [child(f.home, code, oauthEnv(f, server)), child(f.home, code, oauthEnv(f, server))];
  writeFileSync(barrier, 'go');
  for (const run of await Promise.all(pending)) assert.equal(result(run).ok, true);
  assert.deepEqual(await server.counts(), { requests:2, grants:0, cachedAuth:2 });
  assert.deepEqual(snapshot(oldFile), before);
  assert.equal(existsSync(join(f.state, 'tokens', file)), false);
  assert.equal(existsSync(join(f.old, 'usage.jsonl')), true);
});

test('R11(g) current token wins over an old token for the same provider', async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server);
  cached(join(f.old, 'tokens', file));
  mkdirSync(join(f.state, 'tokens'), { recursive:true, mode:0o700 });
  cached(join(f.state, 'tokens', file), { accessToken:'synthetic-current-access' });
  assert.equal(result(await child(f.home, request, oauthEnv(f, server))).ok, true);
  assert.deepEqual(await server.counts(), { requests:1, grants:0, cachedAuth:0 });
});

for (const current of ['expired', 'malformed']) test(`R11(g) a ${current} current token is authoritative; an older valid grant is not resurrected`, async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server);
  cached(join(f.old, 'tokens', file));
  mkdirSync(join(f.state, 'tokens'), { recursive:true, mode:0o700 });
  const currentFile = join(f.state, 'tokens', file);
  if (current === 'expired') cached(currentFile, { expired:true }); else writeFileSync(currentFile, '{not-json', { mode:0o600 });
  const before = snapshot(join(f.old, 'tokens', file));
  assert.equal(result(await child(f.home, request, oauthEnv(f, server))).ok, true);
  assert.deepEqual(await server.counts(), { requests:1, grants:1, cachedAuth:0 });
  assert.deepEqual(snapshot(join(f.old, 'tokens', file)), before);
  assert.equal(JSON.parse(readFileSync(currentFile, 'utf8')).accessToken, 'synthetic-granted-access');
});

for (const rotated of [false, true]) test(`R11(g) ${rotated ? 'rotated' : 'new'} grants write only current cache with private permissions`, async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server), oldFile = join(f.old, 'tokens', file);
  if (rotated) cached(oldFile, { expired:true, refreshToken:'synthetic-refresh' });
  const before = rotated ? snapshot(oldFile) : null, custom = join(f.home, 'custom-state');
  assert.equal(result(await child(f.home, request, oauthEnv(f, server, { [HOME_ENV_NAME]:custom }))).ok, true);
  assert.deepEqual(await server.counts(), { requests:1, grants:1, cachedAuth:0 });
  if (rotated) assert.deepEqual(snapshot(oldFile), before); else assert.equal(existsSync(oldFile), false);
  const token = join(custom, 'tokens', file);
  assert.equal(JSON.parse(readFileSync(token, 'utf8')).accessToken, 'synthetic-granted-access');
  for (const dir of [custom, join(custom, 'tokens')]) assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(token).mode & 0o777, 0o600);
  assert.equal(existsSync(f.state), false);
});

test('R11(g) machines already moved keep using current state and never move anything back', async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server);
  rmSync(f.old, { recursive:true });
  mkdirSync(join(f.state, 'tokens'), { recursive:true, mode:0o700 });
  writeFileSync(join(f.state, 'usage.jsonl'), '{"status":201}\n', { mode:0o600 });
  cached(join(f.state, 'tokens', file));
  const before = snapshot(join(f.state, 'tokens', file));
  assert.deepEqual(result(await child(f.home, readUsage)), [{ status:201 }]);
  assert.equal(result(await child(f.home, request, oauthEnv(f, server))).ok, true);
  assert.deepEqual(await server.counts(), { requests:1, grants:0, cachedAuth:1 });
  assert.deepEqual(snapshot(join(f.state, 'tokens', file)), before);
  assert.equal(existsSync(f.old), false);
});

for (const location of ['state', 'old']) for (const kind of ['file', 'cache', 'root']) {
  test(`R11(g) linked ${kind} in ${location} is never read as a token cache`, async t => {
    const f = fixture(t), server = await serverFixture(t), file = cacheFile(server), target = join(f.home, 'outside');
    mkdirSync(join(target, 'tokens'), { recursive:true, mode:0o700 });
    const targetFile = join(target, 'tokens', file); cached(targetFile);
    mkdirSync(join(f[location], 'tokens'), { recursive:true, mode:0o700 });
    const link = kind === 'file' ? join(f[location], 'tokens', file) : kind === 'cache' ? join(f[location], 'tokens') : f[location];
    rmSync(link, { recursive:true, force:true });
    symlinkSync(kind === 'file' ? targetFile : kind === 'cache' ? join(target, 'tokens') : target, link);
    const before = snapshot(targetFile);
    assert.equal(result(await child(f.home, request, oauthEnv(f, server))).ok, true);
    assert.deepEqual(await server.counts(), { requests:1, grants:1, cachedAuth:0 });
    assert.deepEqual(snapshot(targetFile), before);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
  });
}
for (const location of ['state', 'old']) for (const kind of ['file', 'root']) {
  test(`R11(g) linked usage ${kind} in ${location} is excluded from reads`, async t => {
    const f = fixture(t), outside = join(f.home, 'outside');
    mkdirSync(outside, { mode:0o700 });
    writeFileSync(join(outside, 'usage.jsonl'), '{"status":599}\n', { mode:0o600 });
    mkdirSync(f.state, { recursive:true, mode:0o700 });
    writeFileSync(join(f.state, 'usage.jsonl'), '{"status":201}\n', { mode:0o600 });
    const link = kind === 'file' ? join(f[location], 'usage.jsonl') : f[location];
    rmSync(link, { recursive:true }); symlinkSync(kind === 'file' ? join(outside, 'usage.jsonl') : outside, link);
    assert.deepEqual(result(await child(f.home, readUsage)), [{ status:location === 'state' ? 200 : 201 }]);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(join(outside, 'usage.jsonl'), 'utf8'), '{"status":599}\n');
  });
}

test('R11(g) abandoned migration locks are left alone and cannot block current writes', async t => {
  const f = fixture(t), lock = join(f.state, '.state-migration.lock');
  mkdirSync(lock, { recursive:true, mode:0o700 });
  writeFileSync(join(lock, 'owner.json'), '{"pid":', { mode:0o600 });
  const before = snapshot(join(lock, 'owner.json'));
  const code = `import { prepareMachineState, withMachineStateWrite } from ${JSON.stringify(helper)}; import { appendFileSync } from 'node:fs';
    await prepareMachineState(); await withMachineStateWrite('usage', p => appendFileSync(p, 'new\\n', { mode:0o600 })); console.log('{}');`;
  result(await child(f.home, code));
  assert.equal(readFileSync(join(f.state, 'usage.jsonl'), 'utf8'), 'new\n');
  assert.deepEqual(snapshot(join(lock, 'owner.json')), before);
  assert.equal(existsSync(join(f.old, 'usage.jsonl')), true);
});

test('Basic + R11 concurrent requests persist scrubbed usage before returning, with evidence identities intact', async t => {
  const f = fixture(t), server = await serverFixture(t), username = 'run', password = 'synthetic-basic-password';
  const pair = `${username}:${password}`, encoded = Buffer.from(pair).toString('base64'), usage = join(f.state, 'usage.jsonl');
  const code = i => `import { apiRequest } from ${JSON.stringify(client)}; import { existsSync, readFileSync } from 'node:fs';
    const r = await apiRequest({ path:${JSON.stringify(`/${username}/${password}/${encoded}`)} + '/${i}', mode:'full' });
    const rows = existsSync(${JSON.stringify(usage)}) ? readFileSync(${JSON.stringify(usage)}, 'utf8').trim().split('\\n').map(JSON.parse) : [];
    console.log(JSON.stringify({ r, loggedAtReturn:rows.some(row => row.runId === r.evidence) }));`;
  const runs = (await Promise.all([0,1].map(i => child(f.home, code(i), {
    API_BASE_URL:server.origin, API_EVIDENCE:join(f.home, 'evidence'),
    API_AUTH:'basic:FIXTURE_USER:FIXTURE_PASS', FIXTURE_USER:username, FIXTURE_PASS:password,
  })))).map(result);
  for (const run of runs) {
    assert.equal(run.r.ok, true); assert.equal(run.loggedAtReturn, true);
    const evidence = JSON.parse(readFileSync(join(f.home, 'evidence', `${run.r.evidence}.json`), 'utf8'));
    assert.equal(evidence.runId, run.r.evidence);
  }
  const text = readFileSync(usage, 'utf8'), rows = text.trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.deepEqual(new Set(rows.map(row => row.runId)), new Set(runs.map(run => run.r.evidence)));
  for (const row of rows) { assert.equal(row.path.includes(username), false); assert.equal(row.authUsed, 'basic:FIXTURE_USER:FIXTURE_PASS'); }
  for (const secret of [password,pair,encoded,`Basic ${encoded}`]) assert.equal(text.includes(secret), false);
  assert.equal(statSync(usage).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.old, 'usage.jsonl'), 'utf8'), '{"status":200}\n');
});

test('R11(g) a safe legacy provider token remains readable beside an unrelated linked file', async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server);
  cached(join(f.old, 'tokens', file));
  const outside = join(f.home, 'outside-token.json'); cached(outside);
  const before = snapshot(outside);
  symlinkSync(outside, join(f.old, 'tokens', 'unrelated.json'));
  assert.equal(result(await child(f.home, request, oauthEnv(f, server))).ok, true);
  assert.deepEqual(await server.counts(), { requests:1, grants:0, cachedAuth:1 });
  assert.equal(existsSync(join(f.state, 'tokens', file)), false);
  assert.deepEqual(snapshot(outside), before);
});

test('R11(g) writing a new grant tightens existing current directories without changing legacy modes', async t => {
  const f = fixture(t), server = await serverFixture(t), file = cacheFile(server);
  mkdirSync(join(f.state, 'tokens'), { recursive:true, mode:0o755 });
  const before = statSync(join(f.old, 'tokens')).mode & 0o777;
  assert.equal(result(await child(f.home, request, oauthEnv(f, server))).ok, true);
  assert.equal(statSync(f.state).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.state, 'tokens')).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.state, 'tokens', file)).mode & 0o777, 0o600);
  assert.equal(statSync(join(f.old, 'tokens')).mode & 0o777, before);
});

test('R11(g) doctor still names safe old leftovers when an unsafe current directory cannot store the notice', async t => {
  const f = fixture(t), outside = join(f.home, 'outside');
  mkdirSync(outside, { mode:0o700 }); symlinkSync(outside, f.state);
  const r = result(await child(f.home, `import { inspectLegacyState } from ${JSON.stringify(helper)};
    console.log(JSON.stringify(inspectLegacyState({ reportOnce:true })));`));
  assert.deepEqual(r.reported, ['keep.txt', 'tokens', 'usage.jsonl']);
  assert.equal(existsSync(join(outside, '.legacy-state-notice.json')), false);
});
