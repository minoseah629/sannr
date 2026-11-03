import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LAYOUT } from '../lib/layout.mjs';
import { appendWorkbenchEvent, readWorkbenchHandoff, acknowledgeWorkbenchHandoff, listWorkbenchHandoffs, WORKBENCH_HANDOFF_LIMITS,
  appendRunRequests, readRunRequests, RUN_REQUEST_SESSION, runRequestSession } from '../lib/workbench-handoff.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-handoff-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = `wb-${randomUUID()}`, directory = join(root, LAYOUT.evidence, 'workbench', 'handoffs');
  return { root, session, directory, file: join(directory, `${session}.json`) };
}
const refuses = (fn, code) => assert.throws(fn, error => error.code === code);

test('handoffs retain bounded safe references, explicit cursors, and acknowledgment across calls and process reads', async t => {
  const f = fixture(t);
  assert.deepEqual(readWorkbenchHandoff(f.root, f.session), { events: [], next_cursor: 0, pending: 0, total: 0, omitted: 0, acknowledged_through: 0 });
  assert.equal(existsSync(f.directory), false, 'reading never initializes project state');
  const first = appendWorkbenchEvent(f.root, f.session, { kind: 'saved', stack: 'app', environment: 'test', operation: 'POST /sessions/{id}', request_id: `req-${randomUUID()}`, saved_ref: 'requests/end-session', request_digest: 'a'.repeat(64) });
  const second = appendWorkbenchEvent(f.root, f.session, { kind: 'request_result', stack: 'app', operation: 'POST /sessions/{id}', run_id: `run-${randomUUID()}`, status: 422 });
  const third = appendWorkbenchEvent(f.root, f.session, { kind: 'follow_up', message: 'Please inspect the failing request.\nOpening the viewport did not run an assertion.' });
  assert.deepEqual([first.seq, second.seq, third.seq], [1, 2, 3]);
  assert.notEqual(first.event_id, second.event_id);
  assert.match(first.at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(third.message_source, 'operator');
  assert.equal(third.message_trust, 'untrusted-data');
  assert.equal(statSync(f.file).mode & 0o777, 0o600);
  assert.equal(readFileSync(join(f.directory, '.gitignore'), 'utf8'), '*\n');
  const page = readWorkbenchHandoff(f.root, f.session, { limit: 1 });
  assert.equal(page.events.length, 1); assert.equal(page.next_cursor, 1); assert.equal(page.omitted, 2); assert.equal(page.pending, 3);
  assert.equal(readWorkbenchHandoff(f.root, f.session).pending, 3, 'retrieval never acknowledges work');
  assert.equal(acknowledgeWorkbenchHandoff(f.root, f.session, 2).pending, 1);
  assert.equal(acknowledgeWorkbenchHandoff(f.root, f.session, 1).acknowledged_through, 2, 'repeated older acknowledgment cannot rewind');
  assert.deepEqual(readWorkbenchHandoff(f.root, f.session, { after: 2 }).events, [third]);
  refuses(() => acknowledgeWorkbenchHandoff(f.root, f.session, 4), 'WORKBENCH_HANDOFF_CURSOR_INVALID');
  refuses(() => readWorkbenchHandoff(f.root, f.session, { after: 4 }), 'WORKBENCH_HANDOFF_CURSOR_INVALID');
  const { spawn } = await import('node:child_process');
  const source = `import { readWorkbenchHandoff } from ${JSON.stringify(new URL('../lib/workbench-handoff.mjs', import.meta.url).href)}; process.stdout.write(JSON.stringify(readWorkbenchHandoff(process.argv[1], process.argv[2])));`;
  const restarted = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.root, f.session], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`fixture child exited ${code}`)));
  });
  assert.equal(restarted.pending, 1); assert.deepEqual(restarted.events, [first, second, third]);
});

test('handoff input refuses payload fields, credentials, private paths and malformed identities before creating files', t => {
  const f = fixture(t);
  const userPath = ['', 'Users', 'example', 'private.json'].join('/');
  const windowsPath = ['C:', 'Users', 'example', 'private.json'].join(String.fromCharCode(92));
  const invalid = [
    { kind: 'saved', body: { private: 'value' } }, { kind: 'request_result', response: 'secret payload' },
    { kind: 'follow_up', message: 'token=synthetic-secret-value' },
    { kind: 'follow_up', message: 'Bearer abcdefghijklmnopqrstuvwxyz' },
    { kind: 'follow_up', message: `Read ${userPath}` },
    { kind: 'follow_up', message: `Read ${windowsPath}` },
    { kind: 'follow_up', message: 'Read %2Fhome%2Fexample%2Fprivate.json' },
    { kind: 'follow_up', message: 'Read /mnt/private/credentials.txt' },
    { kind: 'follow_up', message: 'Read %2Fmnt%2Fprivate%2Fcredentials.txt' },
    { kind: 'follow_up', message: 'See https://example.test/private?token=hidden' },
    { kind: 'saved', operation: 'GET https://example.test/path' },
    { kind: 'follow_up', message: `The local file is ${userPath}` },
    { kind: 'saved', operation: 'GET /path?private=value' },
    { kind: 'saved', saved_ref: '../private' }, { kind: 'saved', saved_ref: '/absolute/path' },
    { kind: 'saved', saved_ref: 'https://example.test/private' },
    { kind: 'saved', saved_ref: 'requests/sk-exampleToken1234' },
    { kind: 'saved', request_id: 'bad-id' }, { kind: 'request_result', status: 900 },
    { kind: 'follow_up', message: 'x'.repeat(1001) }, { kind: 'follow_up', message: 'hidden\u202evalue' },
    { kind: 'follow_up', message: 'context', run_id: '/private/evidence.json' },
    { kind: 'saved', request_digest: 'a'.repeat(63) },
  ];
  for (const input of invalid) assert.throws(() => appendWorkbenchEvent(f.root, f.session, input), error => /^WORKBENCH_HANDOFF_(?:INPUT_INVALID|SECRET_REFUSED|PRIVATE_DATA_REFUSED)$/.test(error.code));
  refuses(() => appendWorkbenchEvent(f.root, '../../escape', { kind: 'saved' }), 'WORKBENCH_HANDOFF_SESSION_INVALID');
  assert.equal(existsSync(f.directory), false);
});

test('automatic events preserve canonical contract paths without applying the prose filesystem heuristic', t => {
  const f = fixture(t), routes = [`GET ${['', 'home', '{id}'].join('/')}`, `POST ${['', 'tmp', '{key}'].join('/')}`, 'GET /v1/items:batchGet', 'GET /v1/items/%24count'];
  for (const operation of routes) {
    const saved = appendWorkbenchEvent(f.root, f.session, { kind: 'saved', operation, saved_ref: 'requests/fixture' });
    assert.equal(saved.operation, operation);
    const result = appendWorkbenchEvent(f.root, f.session, { kind: 'request_result', operation, status: 200, run_id: `run-${randomUUID()}` });
    assert.equal(result.operation, operation);
  }
  assert.deepEqual(readWorkbenchHandoff(f.root, f.session).events.map(event => event.operation), routes.flatMap(operation => [operation, operation]));
  const serialized = readFileSync(f.file, 'utf8');
  for (const field of ['body', 'response', 'inputs', 'authorization']) assert.ok(!serialized.includes(`"${field}"`));
  for (const operation of ['GET /path?token=value', 'GET /path#fragment', 'GET /../private', 'GET /bad%route', 'GET /sk-syntheticSecretValue', 'GET /sk%2DsyntheticSecretValue'])
    assert.throws(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved', operation }), error => /^WORKBENCH_HANDOFF_(?:INPUT_INVALID|SECRET_REFUSED)$/.test(error.code));
  refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'follow_up', message: `Read ${['', 'home', 'private-file.json'].join('/')}` }), 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED');
});

test('stored malformed history refuses without reset and cannot be copied into another session', t => {
  const f = fixture(t);
  appendWorkbenchEvent(f.root, f.session, { kind: 'saved', saved_ref: 'requests/start' });
  const valid = readFileSync(f.file, 'utf8');
  for (const malformed of ['{bad-json', JSON.stringify({ ...JSON.parse(valid), acknowledged_through: 2 }), JSON.stringify({ ...JSON.parse(valid), events: [{ ...JSON.parse(valid).events[0], seq: 7 }] })]) {
    writeFileSync(f.file, malformed);
    refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_HISTORY_INVALID');
    refuses(() => acknowledgeWorkbenchHandoff(f.root, f.session, 0), 'WORKBENCH_HANDOFF_HISTORY_INVALID');
    assert.equal(readFileSync(f.file, 'utf8'), malformed);
  }
  writeFileSync(f.file, valid);
  const another = `wb-${randomUUID()}`;
  writeFileSync(join(f.directory, `${another}.json`), valid);
  refuses(() => readWorkbenchHandoff(f.root, another), 'WORKBENCH_HANDOFF_HISTORY_INVALID');
  const listing = listWorkbenchHandoffs(f.root);
  assert.equal(listing.sessions.length, 1); assert.equal(listing.unavailable[0].session_id, another);
});

test('handoff ancestor symlinks, destination symlinks and hard links never read or replace outside files', t => {
  const f = fixture(t), outside = mkdtempSync(join(tmpdir(), 'workbench-handoff-outside-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const target = join(outside, 'private.json'); writeFileSync(target, 'private-sentinel');
  mkdirSync(join(f.root, LAYOUT.evidence), { recursive: true });
  symlinkSync(outside, join(f.root, LAYOUT.evidence, 'workbench'));
  refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_UNSAFE_PATH');
  refuses(() => readWorkbenchHandoff(f.root, f.session), 'WORKBENCH_HANDOFF_UNSAFE_PATH');
  rmSync(join(f.root, LAYOUT.evidence, 'workbench')); mkdirSync(f.directory, { recursive: true });
  for (const link of [() => symlinkSync(target, f.file), () => linkSync(target, f.file)]) {
    link();
    refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_UNSAFE_PATH');
    refuses(() => readWorkbenchHandoff(f.root, f.session), 'WORKBENCH_HANDOFF_UNSAFE_PATH');
    rmSync(f.file);
  }
  assert.equal(readFileSync(target, 'utf8'), 'private-sentinel');
});

test('capacity refuses new events without discarding unread or acknowledged history', t => {
  const f = fixture(t), first = appendWorkbenchEvent(f.root, f.session, { kind: 'saved' });
  const document = JSON.parse(readFileSync(f.file, 'utf8'));
  document.events = Array.from({ length: WORKBENCH_HANDOFF_LIMITS.events }, (_, index) => ({ ...first, event_id: randomUUID(), seq: index + 1 }));
  writeFileSync(f.file, JSON.stringify(document));
  const original = readFileSync(f.file, 'utf8');
  refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_CAPACITY');
  assert.equal(readFileSync(f.file, 'utf8'), original); assert.equal(readWorkbenchHandoff(f.root, f.session).pending, 1000);
  acknowledgeWorkbenchHandoff(f.root, f.session, 1000);
  refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_CAPACITY');
  const byteFixture = fixture(t);
  let appended = 0;
  while (appended < WORKBENCH_HANDOFF_LIMITS.events) {
    try { appendWorkbenchEvent(byteFixture.root, byteFixture.session, { kind: 'follow_up', message: 'x'.repeat(1000) }); appended++; }
    catch (error) { assert.equal(error.code, 'WORKBENCH_HANDOFF_CAPACITY'); break; }
  }
  assert.ok(appended > 0 && appended < WORKBENCH_HANDOFF_LIMITS.events);
  assert.equal(readWorkbenchHandoff(byteFixture.root, byteFixture.session).total, appended);
  assert.ok(statSync(byteFixture.file).size <= WORKBENCH_HANDOFF_LIMITS.bytes);
});

test('session discovery is read-only, bounded and names pending work without attaching to any agent', t => {
  const f = fixture(t);
  assert.deepEqual(listWorkbenchHandoffs(f.root), { sessions: [], omitted: 0, scan_omitted: false, unavailable: [], unavailable_omitted: 0 });
  for (let i = 0; i < 3; i++) appendWorkbenchEvent(f.root, `wb-${randomUUID()}`, { kind: 'follow_up', message: 'Review this change.' });
  const listing = listWorkbenchHandoffs(f.root, { limit: 2 });
  assert.equal(listing.sessions.length, 2); assert.equal(listing.omitted, 1);
  for (const summary of listing.sessions) {
    assert.equal(summary.pending, 1); assert.equal(summary.total, 1); assert.equal(summary.acknowledged_through, 0);
    assert.equal(readWorkbenchHandoff(f.root, summary.session_id).pending, 1);
  }
});

test('a held session lock refuses mutation while permitting snapshots and is never silently evicted', t => {
  const f = fixture(t);
  appendWorkbenchEvent(f.root, f.session, { kind: 'saved' });
  const lock = join(f.directory, `${f.session}.lock`), before = readFileSync(f.file, 'utf8');
  mkdirSync(lock);
  refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_BUSY');
  refuses(() => acknowledgeWorkbenchHandoff(f.root, f.session, 1), 'WORKBENCH_HANDOFF_BUSY');
  assert.equal(readFileSync(f.file, 'utf8'), before); assert.equal(readWorkbenchHandoff(f.root, f.session).pending, 1);
  assert.equal(existsSync(lock), true, 'a crashed writer lock needs explicit human recovery');
  rmSync(lock, { recursive: true });
  assert.equal(appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }).seq, 2);
  assert.equal(existsSync(lock), false, 'successful writes remove only their own lock');
  symlinkSync(f.directory, lock);
  refuses(() => appendWorkbenchEvent(f.root, f.session, { kind: 'saved' }), 'WORKBENCH_HANDOFF_UNSAFE_PATH');
  assert.equal(readWorkbenchHandoff(f.root, f.session).total, 2);
});

for (const persistent of [false, true]) test(`atomic replacement during a handoff stat ${persistent ? 'refuses persistent churn as busy without payload' : 'retries and returns the complete newer snapshot'}`, async t => {
  const f = fixture(t), { spawn } = await import('node:child_process');
  const source = `import fs from 'node:fs';
    import assert from 'node:assert/strict';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendWorkbenchEvent, readWorkbenchHandoff } from ${JSON.stringify(new URL('../lib/workbench-handoff.mjs', import.meta.url).href)};
    const [root, session, file, mode] = process.argv.slice(1);
    const first = appendWorkbenchEvent(root, session, { kind: 'saved' });
    const original = fs.readFileSync(file);
    const second = appendWorkbenchEvent(root, session, { kind: 'follow_up', message: 'Review the newer saved request.' });
    const replacement = fs.readFileSync(file);
    fs.writeFileSync(file, original);
    const exactPaths = new Set([file, fs.realpathSync(file)]);
    const nativeStat = fs.lstatSync;
    let replacements = 0;
    fs.lstatSync = function(path, ...options) {
      if (!exactPaths.has(path) || (mode !== 'persistent' && replacements)) return nativeStat.call(this, path, ...options);
      replacements++;
      // Keep the old inode open, then do the same atomic replacement as a
      // concurrent writer. Its real descriptor now reports nlink=0, which a
      // path stat racing that replacement can observe before it returns.
      const fd = fs.openSync(file, fs.constants.O_RDONLY);
      const next = file + '.replacement';
      try {
        fs.writeFileSync(next, replacement, { mode: 0o600, flag: 'wx' });
        fs.renameSync(next, file);
        const replaced = fs.fstatSync(fd);
        assert.equal(replaced.nlink, 0);
        return replaced;
      } finally { fs.closeSync(fd); }
    };
    syncBuiltinESMExports();
    let result, error;
    try { result = readWorkbenchHandoff(root, session); }
    catch (caught) { error = { code: caught.code, message: caught.message }; }
    finally { fs.lstatSync = nativeStat; syncBuiltinESMExports(); }
    assert.deepEqual(fs.readFileSync(file), replacement, 'reading never rewrites the new snapshot');
    process.stdout.write(JSON.stringify({ result, error, replacements, expected: [first, second] }));`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.root, f.session, f.file, persistent ? 'persistent' : 'once'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('atomic replacement fixture timed out')); }, 10_000);
    t.after(() => child.kill());
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new Error(`atomic replacement fixture exited ${code}: ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
  if (persistent) {
    assert.equal(result.error?.code, 'WORKBENCH_HANDOFF_BUSY');
    assert.equal(result.result, undefined, 'churn must never return empty or partial history');
    assert.ok(result.replacements >= 2 && result.replacements <= 5, 'retries are bounded');
  } else {
    assert.equal(result.error, undefined);
    assert.equal(result.replacements, 1);
    assert.equal(result.result.total, 2);
    assert.equal(result.result.pending, 2);
    assert.deepEqual(result.result.events, result.expected);
  }
});

test('concurrent process appends and acknowledgments preserve every event and the received prefix', async t => {
  const f = fixture(t), { spawn } = await import('node:child_process');
  appendWorkbenchEvent(f.root, f.session, { kind: 'saved' });
  const source = `import { appendWorkbenchEvent, readWorkbenchHandoff, acknowledgeWorkbenchHandoff } from ${JSON.stringify(new URL('../lib/workbench-handoff.mjs', import.meta.url).href)};
    import { setTimeout as delay } from 'node:timers/promises';
    const [root, session, worker] = process.argv.slice(1);
    const retry = async fn => { for (let n=0;n<3000;n++) { try { return fn(); } catch(error) { if(error.code!=='WORKBENCH_HANDOFF_BUSY') throw error; await delay(1); } } throw new Error('fixture lock timeout'); };
    process.stdout.write('ready\\n'); await new Promise(resolve => process.stdin.once('data', resolve));
    for (let n=0;n<40;n++) {
      if(worker==='ack') { const through=(await retry(() => readWorkbenchHandoff(root, session))).total; await retry(() => acknowledgeWorkbenchHandoff(root, session, through)); await delay(1); }
      else { await retry(() => appendWorkbenchEvent(root, session, {kind:'follow_up',message:worker+' event '+n})); await delay(1); }
    }
    process.stdin.destroy(); process.stdout.write('done\\n');`;
  const children = ['writer-a', 'writer-b', 'ack'].map(worker => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.root, f.session, worker], { stdio: ['pipe', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    let output = '', stderr = '', ready;
    const started = new Promise(resolve => { ready = resolve; });
    child.stdout.on('data', chunk => { output += chunk; if (output.includes('ready\n')) ready(); });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`fixture child exited ${code}: ${stderr}`))); });
    return { child, started: Promise.race([started, done]), done };
  });
  await Promise.all(children.map(item => item.started));
  for (const { child } of children) child.stdin.write('start\n');
  await Promise.all(children.map(item => item.done));
  const result = readWorkbenchHandoff(f.root, f.session, { limit: 100 });
  assert.equal(result.total, 81);
  assert.equal(new Set(result.events.map(event => event.event_id)).size, 81);
  assert.equal(new Set(result.events.filter(event => event.message).map(event => event.message)).size, 80);
  assert.ok(result.acknowledged_through >= 1 && result.acknowledged_through <= 81);
  assert.deepEqual(result.events.map(event => event.seq), Array.from({ length: 81 }, (_, index) => index + 1));
  assert.equal(acknowledgeWorkbenchHandoff(f.root, f.session, 81).pending, 0);
  assert.equal(existsSync(join(f.directory, `${f.session}.lock`)), false);
});


test('operator prose accepts canonical route mentions while still refusing secrets and private locations', t => {
  const f = fixture(t);
  const messages = [
    'Review GET /orders/{id}',
    'Compare `GET /orders/{id}` with POST /v1/items:batchGet before changing the handler.',
    'Review GET /orders/{id}. Then check HEAD /health.',
    `Review GET ${['', 'home', '{id}'].join('/')}`,
  ];
  for (const message of messages) {
    assert.equal(appendWorkbenchEvent(f.root, f.session, { kind: 'follow_up', message }).message, message);
  }
  const privatePath = ['', 'Users', 'fixture', 'private.json'].join('/');
  for (const message of [
    `Review GET /orders/{id} and read ${privatePath}`,
    `Review GET ${privatePath}`,
    `Review GET ${['', 'home', 'fixture', 'private', 'file'].join('/')}`,
    'Review GET /orders/{id}?token=value',
    'Review GET /orders/..',
    'Review GET /orders/.',
    'Review GET /sk-syntheticSecretValue',
    'Review GET /sk%2DsyntheticSecretValue',
    'Review GET /mnt/private/credentials.txt',
    'Review GET /orders/{id}%3Ftoken=value',
    `Review GET ${['', 'home', '{id}', '%2E%2E', 'private'].join('/')}`,
    'Review GET /orders/{id} and read /mnt/private/credentials.txt',
    'Review GET /orders/{id} and read %2Fmnt%2Fprivate%2Fcredentials.txt',
    'Review GET /orders/{id} and https://example.test/private',
  ]) assert.throws(() => appendWorkbenchEvent(f.root, f.session, { kind: 'follow_up', message }), error => /^WORKBENCH_HANDOFF_(?:INPUT_INVALID|SECRET_REFUSED|PRIVATE_DATA_REFUSED)$/.test(error.code));
  assert.deepEqual(readWorkbenchHandoff(f.root, f.session).events.map(event => event.message), messages);
});


test('a methodless route refusal teaches HTTP-method syntax without echoing private or secret text', t => {
  const f = fixture(t);
  const privatePath = ['', 'Users', 'fixture', 'private-note.json'].join('/');
  const cases = [
    ['Read /orders/{id}', 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED'],
    ['Read /customers/{customerId}', 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED'],
    [`Read ${privatePath}`, 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED'],
    ['Read https://example.test/private-note', 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED'],
    ['token=synthetic-note-secret', 'WORKBENCH_HANDOFF_SECRET_REFUSED'],
  ];
  for (const [message, code] of cases) assert.throws(() => appendWorkbenchEvent(f.root, f.session, { kind: 'follow_up', message }), error => {
    assert.equal(error.code, code);
    if (code === 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED') assert.ok(error.message.includes('GET /orders/{id}'), 'explain the method-and-route form using a fixed safe example');
    for (const privateText of [privatePath, 'https://example.test/private-note', 'synthetic-note-secret', '/customers/{customerId}'])
      assert.ok(!error.message.includes(privateText), 'refusal guidance must not quote submitted private text');
    return true;
  });
  assert.equal(existsSync(f.directory), false, 'refused guidance does not append an event');
  assert.equal(appendWorkbenchEvent(f.root, f.session, { kind: 'follow_up', message: 'Review GET /orders/{id}' }).message, 'Review GET /orders/{id}');
});

test('run requests keep the inbox bounds, queue once per decision and roll into a new journal without rewriting a full one', t => {
  const f = fixture(t), file = session => join(f.directory, `${session}.json`);
  const request = (index, extra = {}) => ({ stack: 'app', operation: 'GET /items/{id}', note_id: `sha256:${String(index).padStart(64, '0')}`,
    requested_at: '2026-10-29T09:00:00.000Z', requested_by: 'Reviewer', requested_actor: 'person', check: 'Check that unknown ids return 404 locally.',
    environments: [{ name: 'local', host: '127.0.0.1:4010', production: false }], prompt: 'Verify this claim about GET /items/{id} in stack app.\n\nSTOP and ask first.',
    prompt_claim: 'quoted', ...extra });
  // Refusals are per request and write nothing; a host is never a URL.
  for (const [extra, code] of [[{ environments: [{ name: 'local', host: 'http://127.0.0.1:4010', production: false }] }, 'WORKBENCH_HANDOFF_INPUT_INVALID'],
    [{ check: 'Compare with https://example.test/items first.' }, 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED'],
    [{ check: `Read ${['', 'Users', 'someone', 'notes.txt'].join('/')} first.` }, 'WORKBENCH_HANDOFF_PRIVATE_DATA_REFUSED'],
    [{ check: 'Use Authorization: Bearer sk-test-1234567890abcdefghijklmnop' }, 'WORKBENCH_HANDOFF_SECRET_REFUSED'],
    [{ run_id: 'run-extra' }, 'WORKBENCH_HANDOFF_INPUT_INVALID']]) {
    assert.deepEqual(appendRunRequests(f.root, [request(1, extra)]), [{ state: 'not_queued', code }]);
  }
  assert.equal(existsSync(f.directory), false, 'refused run requests create no inbox');
  refuses(() => appendWorkbenchEvent(f.root, f.session, { ...request(1), kind: 'run_request' }), 'WORKBENCH_HANDOFF_INPUT_INVALID');

  const [queued] = appendRunRequests(f.root, [request(1)]);
  assert.deepEqual([queued.state, queued.session_id, queued.seq], ['queued', RUN_REQUEST_SESSION, 1]);
  const again = appendRunRequests(f.root, [request(1), request(2)]);
  assert.deepEqual(again.map(row => [row.state, row.seq]), [['already_queued', 1], ['queued', 2]], 'an exact retry adds no event');
  const stored = readWorkbenchHandoff(f.root, RUN_REQUEST_SESSION).events;
  assert.deepEqual(stored.map(row => [row.kind, row.message_source, row.message_trust]), [['run_request', 'review', 'untrusted-data'], ['run_request', 'review', 'untrusted-data']]);
  assert.equal(listWorkbenchHandoffs(f.root).sessions[0].pending, 2);
  assert.equal(readRunRequests(f.root).find(request(2)).acknowledged, false);
  acknowledgeWorkbenchHandoff(f.root, RUN_REQUEST_SESSION, 2);
  assert.equal(readRunRequests(f.root).find(request(2)).acknowledged, true);

  // A hand-edited run request is malformed history, never a status source.
  const original = readFileSync(file(RUN_REQUEST_SESSION), 'utf8');
  writeFileSync(file(RUN_REQUEST_SESSION), original.replace('127.0.0.1:4010', 'http://127.0.0.1:4010'));
  assert.deepEqual(readRunRequests(f.root).state, 'unavailable');
  assert.deepEqual(appendRunRequests(f.root, [request(3)]), [{ state: 'not_queued', code: 'WORKBENCH_HANDOFF_HISTORY_INVALID' }]);
  writeFileSync(file(RUN_REQUEST_SESSION), original);

  // Fill the first journal; the next requests open the next one in the series.
  const big = index => request(index, { prompt: `Verify this claim.\n\n${'Check the documented status. '.repeat(120)}` });
  const results = appendRunRequests(f.root, Array.from({ length: 90 }, (_, index) => big(index + 10)));
  const sessions = [...new Set(results.map(row => row.session_id))];
  assert.deepEqual(sessions, [RUN_REQUEST_SESSION, runRequestSession(2)], JSON.stringify(results.filter(row => row.state !== 'queued')));
  assert.ok(results.every(row => row.state === 'queued'));
  const first = readWorkbenchHandoff(f.root, RUN_REQUEST_SESSION, { limit: 100 });
  assert.equal(first.acknowledged_through, 2, 'the full journal keeps its acknowledgment');
  assert.ok(readFileSync(file(RUN_REQUEST_SESSION)).length <= WORKBENCH_HANDOFF_LIMITS.bytes);
  assert.deepEqual(appendRunRequests(f.root, [big(10), request(1)]).map(row => [row.state, row.session_id]),
    [['already_queued', RUN_REQUEST_SESSION], ['already_queued', RUN_REQUEST_SESSION]], 'retries are found in earlier journals');
  assert.deepEqual(listWorkbenchHandoffs(f.root).sessions.map(row => row.session_id).sort(), [RUN_REQUEST_SESSION, runRequestSession(2)]);
});
