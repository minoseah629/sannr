// MAP-1C fix round 1 over synthetic private evidence: the capture window is
// the 256 newest earlier run files (any scope), the budget covers the listing,
// the backfill replays the same window, and pins for the consumer rules and
// the shared reader's changed-during-read check. Fixtures live in temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { backfillKeySources, linkCapturedRun } from '../lib/key-source-evidence.mjs';
import { openEvidenceRoot, readEvidenceBytes } from '../lib/note-evidence.mjs';
import { captureOperationContext, queryOperationContext } from '../lib/operation-context.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const provider = 'http://127.0.0.1:4100';
const contractDigest = `sha256:${'c'.repeat(64)}`;
const identity = { v: 1, provider, environment: 'local', protocol: 'http', operation: 'GET /things/{id}',
  endpoint: `${provider}/things/{id}`, contractDigest };
const VALUE = 'thing-MKR-52d0e1';
const second = n => new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + n * 1000).toISOString();

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-rulings-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'evidence');
  mkdirSync(dir);
  const write = (id, { at, observedAt, operation = 'GET /things', status = 200, url = `${provider}/things`, body = {},
    environment = 'local', digest = contractDigest, method, pageOf, mtime } = {}) => {
    const file = join(dir, `${id}.json`);
    writeFileSync(file, JSON.stringify({ runId: id, ...(pageOf ? { page_of: pageOf } : {}),
      origin: { v: 1, initiator: 'cli.request', transport: 'api_request:http', observed_at: observedAt ?? second(at),
        scope: { operation, protocol: 'http', environment, provider, contract_digest: digest } },
      request: { method: method ?? operation.split(' ')[0], url, headers: {}, body: null },
      response: { status, headers: {}, body } }));
    const when = new Date(mtime ?? observedAt ?? second(at));
    utimesSync(file, when, when);
    return file;
  };
  const current = (overrides = {}) => write('run-current', { at: 10_000, operation: 'GET /things/{id}',
    url: `${provider}/things/${VALUE}`, body: { id: VALUE }, ...overrides });
  const link = (options = {}) => linkCapturedRun({ evidenceDir: dir, runId: 'run-current', identity, ...options });
  const env = { [HOME_ENV_NAME]: join(root, 'isolated-registry') };
  // A store with the detail operation's record, for the backfill.
  const record = () => captureOperationContext(root, { identity, source: { tool: 'api_request:http' }, basis: 'observed',
    outcome: 'success', complete: true, status: 200 }, { internal: true });
  const backfill = (options = {}) => backfillKeySources(root, { evidenceDir: dir, env, ...options });
  const sources = () => queryOperationContext(root, { operation: identity.operation }, { env }).operations[0]?.key_sources ?? [];
  return { root, dir, write, current, link, record, backfill, sources };
}

// Out-of-scope run files written between the source and the captured run.
const fillers = (f, count, { from = 100 } = {}) => {
  for (let index = 0; index < count; index++)
    f.write(`run-other-${String(index).padStart(4, '0')}`, { at: from + index, environment: 'staging', body: { data: [] } });
};

test('MAP-1C B5 a capture examines at most the 256 newest earlier run files, in any scope', t => {
  const f = scratch(t);
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  fillers(f, 255);
  // Files written after the captured run take no examine slot.
  for (let index = 0; index < 10; index++) f.write(`run-later-${index}`, { at: 20_000 + index, environment: 'staging' });
  f.current();
  const inside = f.link();
  assert.equal(inside.state, 'linked', 'the source is the 256th file examined');
  assert.equal(inside.links[0].evidence.run_id, 'run-source');
  f.write('run-other-9999', { at: 600, environment: 'staging' });
  assert.equal(f.link().state, 'no-source', 'a 257th file is not examined, whatever its scope');
});

test('MAP-1C B5 the backfill replays the same window: 256 files examined, the first 64 in scope', t => {
  const f = scratch(t);
  f.record();
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  fillers(f, 255);
  f.current();
  assert.equal(f.backfill({ dryRun: true }).runs.linked, 1, 'the source is within the 256 examined');
  f.write('run-other-9999', { at: 600, environment: 'staging' });
  const report = f.backfill({ dryRun: true });
  assert.equal(report.runs.linkable, 1);
  assert.equal(report.runs.linked, 0, 'beyond 256 examined files the backfill does not link either');
});

test('MAP-1C B5 the time budget covers the directory listing itself', t => {
  const f = scratch(t);
  for (let index = 0; index < 3000; index++) f.write(`run-bulk-${String(index).padStart(5, '0')}`, { at: 100 + index, environment: 'staging' });
  f.current();
  let lstats = 0;
  const original = fs.lstatSync;
  fs.lstatSync = function (path, ...rest) {
    if (String(path).startsWith(`${f.dir}${sep}`)) lstats++;
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  let calls = 0;
  try {
    // Over budget from the second clock reading on.
    const result = f.link({ clock: () => (calls++ === 0 ? 0 : 1e9) });
    assert.deepEqual(result, { state: 'over-budget', links: [] });
  } finally { fs.lstatSync = original; syncBuiltinESMExports(); }
  assert.ok(lstats < 300, `the listing stopped within the budget (${lstats} of 3001 files examined)`);
});

test('MAP-1C a linked request must match the record\'s contract digest and method; earlier means strictly earlier', t => {
  const f = scratch(t);
  f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  f.current();
  assert.equal(f.link().state, 'linked', 'control');
  f.current({ digest: `sha256:${'d'.repeat(64)}` });
  assert.equal(f.link().state, 'no-keys', 'a run under another contract digest is not this record\'s request');
  f.current({ method: 'POST' });
  assert.equal(f.link().state, 'no-keys', 'a run sent with another method is not this operation\'s request');
  f.current({ observedAt: second(1), mtime: second(10_000) });
  assert.equal(f.link().state, 'no-source', 'a source recorded at the same time is not earlier');
});

test('MAP-1C the backfill never links page files and takes only strictly earlier sources', t => {
  const f = scratch(t);
  f.record();
  // Named to sort before the consumer at an equal time: only the time rule can exclude it.
  f.write('run-a-source', { at: 1, body: { data: [{ id: VALUE }] } });
  // A follow-up page of a detail call is client-generated: never a linked request.
  f.write('run-current', { at: 5_000, operation: 'GET /things', body: { data: [] } });
  f.write('run-current-p2', { at: 5_001, operation: 'GET /things/{id}', url: `${provider}/things/${VALUE}`, body: { id: VALUE }, pageOf: 'run-current' });
  let report = f.backfill({ dryRun: true });
  assert.equal(report.runs.linkable, 0, 'a page file is not a linkable request');
  assert.equal(report.runs.linked, 0);
  // A detail request recorded at the same time as the only source: no link.
  f.write('run-detail', { at: 1, operation: 'GET /things/{id}', url: `${provider}/things/${VALUE}`, body: { id: VALUE } });
  report = f.backfill({ dryRun: true });
  assert.equal(report.runs.linkable, 1);
  assert.equal(report.runs.linked, 0, 'a source recorded at the same time is not earlier');
  f.write('run-detail', { at: 2, operation: 'GET /things/{id}', url: `${provider}/things/${VALUE}`, body: { id: VALUE } });
  report = f.backfill();
  assert.equal(report.runs.linked, 1, 'one second later it links');
  assert.equal(f.sources()[0].evidence.run_id, 'run-a-source');
});

test('MAP-1C the shared evidence reader refuses a file that changes while it is read', t => {
  const f = scratch(t);
  const file = f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  f.current();
  const growDuringRead = (target, fn) => {
    const original = fs.readSync, inode = fs.statSync(target).ino;
    let grown = false;
    fs.readSync = function (fd, ...rest) {
      const read = original.call(this, fd, ...rest);
      // Grow the target between the reader's first and last reads of it.
      if (!grown && fs.fstatSync(fd).ino === inode) { grown = true; appendFileSync(target, '  '); }
      return read;
    };
    syncBuiltinESMExports();
    try { return fn(); } finally { fs.readSync = original; syncBuiltinESMExports(); }
  };
  const opened = openEvidenceRoot(f.dir);
  assert.throws(() => growDuringRead(file, () => readEvidenceBytes(opened, 'run-source.json')), { code: 'EVIDENCE_FILE_CHANGED' });
  // Through linking, a source changing during its read is a read problem.
  const changing = f.write('run-source', { at: 1, body: { data: [{ id: VALUE }] } });
  assert.equal(growDuringRead(changing, () => f.link()).state, 'evidence-read-problem');
});
