// Synthetic, offline W1 evidence. Each fixture isolates HOME and machine state;
// no transport, installed host or customer repository is involved.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LAYOUT } from '../lib/layout.mjs';
import { CONTEXT_BASENAME, HOME_ENV_NAME } from '../lib/brand.mjs';
import { operationAnchor, relativeViewHref } from '../lib/operation-anchor.mjs';
import { buildSessionLedger } from '../lib/session-ledger.mjs';
import { renderSessionLedgerText } from '../lib/session-ledger-render.mjs';
import { buildViewModel, renderViewHtml, renderSessionsPageHtml } from '../lib/view.mjs';

const AT = '2026-10-17T12:00:00.000Z';
const PRIVATE = 'PRIVATE_RESPONSE_MUST_NOT_APPEAR';
function fixture(t, stacks = []) {
  const root = mkdtempSync(join(tmpdir(), 'attention-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { HOME: join(root, 'home'), [HOME_ENV_NAME]: join(root, 'home/machine'), API_USAGE_LOG: join(root, 'usage.jsonl') };
  for (const name of stacks) {
    const folder = join(root, LAYOUT.collection, name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'stack.json'), JSON.stringify({ v: 1, name, default_environment: 'local', contract: 'openapi.json',
      environments: { local: { baseUrl: 'http://127.0.0.1:1' } } }));
    writeFileSync(join(folder, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: name, version: '1' }, paths: {
      '/items/{id}': { get: { responses: { 200: { description: 'ok' } } } } } }));
    writeFileSync(join(folder, CONTEXT_BASENAME), JSON.stringify({ v: 0, api: { name }, operations: {
      'GET /items/{id}': { notes: ['A retained authored note.'], notes_provenance: [{ by: 'human', at: AT }] } } }));
  }
  const put = (value, name, stack = null) => {
    const folder = join(root, LAYOUT.evidence, ...(stack ? [stack] : []));
    mkdirSync(dirname(join(folder, name)), { recursive: true }); writeFileSync(join(folder, name), JSON.stringify(value));
  };
  const session = randomUUID();
  const origin = { v: 1, initiator: 'cli.request', session_id: session, observed_at: AT };
  const run = (fields = {}, stack = null) => {
    const runId = `run-${randomUUID()}`;
    put({ runId, origin: { ...origin, scope: { operation: 'GET /items/{id}', protocol: 'http' } }, request: { method: 'GET', url: `https://example.test/${PRIVATE}` },
      response: { status: 200, body: PRIVATE }, ...fields }, `${runId}.json`, stack);
    return runId;
  };
  const outcome = (fields = {}) => {
    const id = `envelope-${randomUUID()}`;
    put({ v: 1, kind: 'envelope-outcome', id, origin, started_at: AT, batch: false, method: 'POST', protocol: 'http', ...fields }, `${id}.json`);
    return id;
  };
  return { root, env, put, run, outcome, origin };
}
const items = model => model.needs_attention.groups.flatMap(group => group.items);

test('attention retains failure before success outside the row bound, groups all supported facts and names omissions', t => {
  const f = fixture(t);
  const failed = f.run({ response: { status: 503, body: PRIVATE }, assertions: { passed: 1, failed: 2 }, drift: [{ kind: 'undeclared-status' }] });
  const draft = `draft-${'a'.repeat(64)}`;
  f.put({ id: draft, reason: 'undeclared-status', evidence: [failed], body: PRIVATE }, `draft-notes/${draft}.json`);
  f.run({ origin: { ...f.origin, observed_at: '2026-10-17T12:01:00.000Z', scope: { operation: 'GET /items/{id}', protocol: 'http' } } });
  f.outcome({ refusal: 'AUTH_ENV_MISSING', attempted: 0 });
  f.outcome({ error: 'ECONNREFUSED' });
  f.outcome({ error: 'UNRESOLVED_PLACEHOLDER' });
  const missing = `run-${randomUUID()}`;
  f.outcome({ batch: true, attempted: 1, left_behind: 1, steps: [{ method: 'DELETE', protocol: 'http', evidence: missing, status: 404 }] });
  const model = buildSessionLedger(f.root, { env: f.env, rowBound: 1 });
  assert.ok(model.sessions[0].rows_omitted > 0);
  const kinds = new Set(items(model).map(item => item.kind));
  for (const kind of ['http-failure', 'transport-failure', 'assertion-failure', 'refusal', 'leftover', 'drift', 'proposed-draft', 'unresolved-placeholder', 'missing-receipt', 'unknown-attribution']) assert.ok(kinds.has(kind), kind);
  assert.ok(items(model).some(item => item.kind === 'http-failure' && item.basis.run_id === failed));
  assert.ok(items(model).some(item => item.kind === 'missing-receipt' && item.basis.expected_run_id === missing));
  const bounded = buildSessionLedger(f.root, { env: f.env, rowBound: 1, attentionBound: 2 });
  assert.equal(bounded.needs_attention.shown, 2);
  assert.equal(bounded.needs_attention.total, model.needs_attention.total);
  assert.equal(bounded.needs_attention.omitted, bounded.needs_attention.total - 2);
  assert.equal(bounded.needs_attention.groups.reduce((n, group) => n + group.omitted, 0), bounded.needs_attention.omitted);
  for (const group of model.needs_attention.groups) assert.deepEqual(group.items.map(item => item.at), [...group.items.map(item => item.at)].sort().reverse());
  for (const output of [JSON.stringify(model), renderSessionLedgerText(model), renderSessionsPageHtml(model, { project: 'fixture' })]) assert.equal(output.includes(PRIVATE), false);
});

test('a clone retains client failure metadata and missing receipts without inventing a session or executing an authored claim', t => {
  const f = fixture(t);
  const reference = verification => ({ identity: { operation: 'GET /items/{id}' }, observations: [{ id: randomUUID(),
    observed_at: AT, basis: 'observed', verification, source: { kind: verification === 'client-observation' ? 'client' : 'external' },
    response_status: 500, assertions: { passed: 0, failed: 1 }, evidence: [{ path: `${LAYOUT.evidence}/run-${randomUUID()}.json` }] }] });
  const model = buildSessionLedger(f.root, { env: f.env, contexts: [{ stack: null, ctx: { api_context: { operations: { client: reference('client-observation'), author: reference('external-claim') } } } }] });
  assert.equal(model.totals.calls, 0);
  assert.equal(items(model).filter(item => item.kind === 'missing-receipt').length, 2);
  assert.equal(items(model).filter(item => item.kind === 'http-failure').length, 1);
  assert.equal(items(model).filter(item => item.kind === 'assertion-failure').length, 1);
  assert.ok(items(model).every(item => item.session_id === null));
  assert.ok(model.needs_attention.unknowns.includes('Account-fact delivery is not recorded; it is not counted as zero.'));
});

test('operation navigation separates identical paths in stacks and reaches context, notes and evidence offline', t => {
  const f = fixture(t, ['alpha', 'beta']);
  const alpha = f.run({}, 'alpha'), beta = f.run({}, 'beta');
  const model = buildViewModel(f.root, { env: f.env, generatedAt: AT });
  const html = renderViewHtml(model);
  const anchors = ['alpha', 'beta'].map(stack => operationAnchor({ stack, operation: 'GET /items/{id}' }));
  assert.notEqual(...anchors);
  for (const anchor of anchors) {
    assert.ok(html.includes(`href="#${anchor}"`));
    assert.equal(html.split(`id="${anchor}"`).length, 2, 'one precise target');
    const detail = html.slice(html.indexOf(`id="${anchor}"`), html.indexOf('</details>', html.indexOf(`id="${anchor}"`)));
    assert.match(detail, /A retained authored note/);
    assert.match(detail, /Session evidence/);
  }
  assert.ok(html.includes(alpha) && html.includes(beta));
  assert.doesNotMatch(html, /<script|<link|<iframe|src\s*=|@import|url\s*\(/i);
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'/);
  const standalone = renderSessionsPageHtml(model.sessions, { project: 'fixture', viewHref: '../view/index.html' });
  assert.ok(standalone.includes(`href="../view/index.html#${anchors[0]}"`));
  const old = renderSessionsPageHtml(model.sessions, { project: 'fixture', viewHref: '../view/index.html', viewAnchors: [] });
  assert.doesNotMatch(old, /href="\.\.\/view\/index.html#/);
  const absent = renderSessionsPageHtml(model.sessions, { project: 'fixture' });
  assert.match(absent, /No linked operation view is available/);
  assert.ok(absent.includes(alpha));
  for (const unsafe of ['https://example.test/view.html', '//example.test/view.html', '%2f%2fexample.test/view.html', 'javascript:view.html', '../view.html?token=x']) {
    assert.equal(relativeViewHref(unsafe), null);
    assert.match(renderSessionsPageHtml(model.sessions, { project: 'fixture', viewHref: unsafe }), /No linked operation view is available/);
  }
  assert.equal(operationAnchor({ stack: 'alpha', operation: 'get /items/{id}' }), anchors[0]);
  assert.notEqual(operationAnchor({ stack: 'alpha', operation: 'POST /items/{id}' }), anchors[0]);
  for (const operation of ['GET https://example.test/items', 'GET /items?secret=x', 'GET /items\u202e', `GET /keys/ghp_${'a'.repeat(36)}`]) assert.equal(operationAnchor({ operation }), null);
});

test('empty, unavailable and damaged evidence never become a clean attention result', t => {
  const f = fixture(t);
  assert.equal(buildSessionLedger(f.root, { env: f.env }).needs_attention.state, 'unavailable');
  f.run();
  assert.equal(buildSessionLedger(f.root, { env: f.env }).needs_attention.state, 'empty');
  const path = join(f.root, LAYOUT.evidence, `run-${randomUUID()}.json`);
  writeFileSync(path, '{broken');
  const model = buildSessionLedger(f.root, { env: f.env });
  assert.equal(model.needs_attention.state, 'partial');
  assert.ok(model.needs_attention.unknowns.some(item => item.includes('1 unreadable files')));
  const filtered = buildSessionLedger(f.root, { env: f.env, stack: 'absent' });
  assert.equal(filtered.empty.reason, 'filtered-out');
});
