// The Workbench's Activity and Request views, and review decisions on the
// Workbench view, as an operator observes them: the
// packaged page script runs against the real engine handlers over the
// synthetic Parcel Lab, whose API is a loopback service in its own process
// that logs every request it receives. No vendor host, no real home directory.
import './helpers/isolated-home.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkbenchPage } from './helpers/workbench-dom.mjs';
import { buildWorkbenchLab } from './fixtures/workbench-lab.mjs';
import { fixtureContextFile } from './helpers/stack-fixture.mjs';
import { workbenchHandlers } from '../lib/workbench-engine.mjs';
import { ENV_PREFIX, HOME_ENV_NAME } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';

const LAB = fileURLToPath(new URL('./fixtures/workbench-lab.mjs', import.meta.url));
const QUOTE = 'GET /orders/{orderId}/quote', HEALTH = 'GET /health';
// Entered values must never reach a saved request or the page's saved state.
const ORDER = 'ord_OPERATOR_ENTERED_VALUE';

// The lab API in its own process, and a page paired with this repository's
// handlers. Returns null after skipping when the sandbox refuses loopback.
async function lab(t) {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-operator-')), home = join(parent, 'home'), root = join(parent, 'repo');
  mkdirSync(home);
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state');
  const child = spawn(process.execPath, [LAB, root], { env: { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, '.state') }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => {
    child.kill(); await exited;
    for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true });
  });
  let problem = '';
  child.stderr.on('data', chunk => { problem += chunk; });
  const line = await new Promise(resolve => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) resolve(out.trim()); });
    exited.then(() => resolve(null));
  });
  if (!line) {
    if (/EPERM|EACCES/u.test(problem)) { t.skip('Loopback fixture bind refused by sandbox'); return null; }
    throw new Error(`The lab service did not start: ${problem}`);
  }
  const log = join(root, 'fixture-requests.jsonl');
  const seen = () => existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(row => JSON.parse(row)) : [];
  const page = loadWorkbenchPage(workbenchHandlers(root));
  await page.settle(120);
  return { root, seen, page };
}
const by = (page, name, value) => page.all(`[${name}]`).find(node => node.getAttribute(name) === value) ?? null;
const input = (page, key) => by(page, 'data-focus', `req-input:${key}`);
// Typing: the field takes the text and the page hears one input event.
async function type(page, node, text) {
  node.focus(); node.value = text;
  for (const fn of node.listeners.input ?? []) await fn({ type: 'input', target: node, currentTarget: node });
  await page.settle();
}
async function show(page, mode) { await page.click(`[data-mode="${mode}"]`); await page.settle(80); }
async function choose(page, operation) { await page.click(by(page, 'data-req-op', operation)); await page.settle(80); }
async function send(page) { await page.click('[data-req-send]'); await page.settle(160); }

test('the switch offers Workbench, Activity, Request and Map, and opening Activity and Request sends nothing', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page, seen } = ctx;
  assert.deepEqual(page.all('.switch button').map(node => node.getAttribute('data-mode')), ['workbench', 'activity', 'request', 'map']);
  assert.equal(page.q('.switch button[aria-pressed="true"]').getAttribute('data-mode'), 'workbench', 'the notes view is still where the page opens');
  await show(page, 'activity');
  assert.equal(page.q('[data-activity]').getAttribute('data-activity'), 'ready');
  assert.equal(page.text('[data-product-title]'), 'Product Workbench');
  assert.match(page.text('[data-empty-list]'), /No requests are recorded on this machine yet/u);
  assert.equal(page.all('[data-review-toggle]').length, 0, 'the review progress belongs to the notes view');
  await show(page, 'request');
  for (const column of ['requests', 'request', 'response']) assert.ok(page.q(`[data-col="${column}"]`), column);
  assert.deepEqual(page.all('[data-req-op]').map(node => node.getAttribute('data-req-op')), [HEALTH, QUOTE]);
  assert.match(page.text('[data-req-empty]'), /Opening this view never calls the API/u);
  assert.equal(page.text('[data-response]'), 'Nothing sent yet.');
  await choose(page, QUOTE);
  assert.ok(input(page, 'path_orderId'), 'choosing an operation builds its fields from the contract');
  assert.deepEqual(seen(), [], 'reading the views and building a draft sent no API request');
});

test('Request refuses to send without a required value, names the field and sends nothing', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page, seen } = ctx;
  await show(page, 'request'); await choose(page, QUOTE);
  assert.match(page.text('[data-req-field="path_orderId"]'), /orderId.*path · string · required/u);
  await send(page);
  assert.match(page.text('[data-req-problem]'), /Not sent: enter path\.orderId first\./u);
  assert.equal(input(page, 'path_orderId').getAttribute('aria-invalid'), 'true');
  assert.equal(page.document.activeElement, input(page, 'path_orderId'), 'focus moves to the field that needs a value');
  assert.equal(page.text('[data-response]'), 'Nothing sent yet.');
  assert.deepEqual(seen(), []);
});

test('Request sends once, shows the recorded response as masked text, and keeps the entered value for an adjusted second send', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page, seen } = ctx;
  await show(page, 'request'); await choose(page, QUOTE);
  const field = input(page, 'path_orderId');
  assert.equal(field.getAttribute('type'), 'password', 'a sensitive input is masked until the operator shows it');
  await type(page, field, ORDER);
  // Enter in a field sends, as the button does.
  await page.key('Enter', input(page, 'path_orderId')); await page.settle(160);
  assert.deepEqual(seen().map(row => [row.method, row.path, row.status]), [['GET', `/orders/${ORDER}/quote`, 422]], 'exactly one request reached the API');
  assert.equal(page.q('[data-response]').getAttribute('data-response'), '422');
  assert.match(page.text('[data-response]'), /HTTP 422 Unprocessable Content · HTTP failure/u);
  assert.match(page.text('[data-response-checks]'), /No checks were run\. A recorded response is not a passed test\./u);
  assert.match(page.text('[data-response-body]'), /window_required/u, 'the response body is shown after an explicit send');
  assert.equal(input(page, 'path_orderId').value, ORDER, 'the entered value stays in the tab for the next send');

  // The contract leaves `window` optional; the operator adds it and sends again.
  assert.match(page.text('[data-req-warning="SAVED_DRAFT_OPTIONAL_OMITTED"]'), /optional contract fields were left out/u);
  await page.click(by(page, 'data-req-toggle', 'advanced'));
  const structure = by(page, 'data-focus', 'req-structure');
  await type(page, structure, JSON.stringify({ path: { orderId: { $input: 'path_orderId' } }, query: { window: { $input: 'query_window' } } }));
  await page.click('[data-req-update]');
  assert.ok(input(page, 'query_window'), 'the new input gets a field');
  assert.equal(input(page, 'path_orderId').value, ORDER);
  await type(page, input(page, 'query_window'), 'current');
  await send(page);
  assert.deepEqual(seen().map(row => row.status), [422, 200]);
  assert.equal(page.q('[data-response]').getAttribute('data-response'), '200');
  const body = page.text('[data-response-body]');
  assert.match(body, /"currency": "USD"/u);
  assert.match(body, /withheld/u, 'credential-shaped response values are masked');
  assert.ok(!body.includes('synthetic-private-signature') && !/"password": "abc"/u.test(body));
  assert.match(body, /<img src=x onerror=alert\(1\)>/u, 'markup in a response is text');
  assert.equal(page.all('[data-response-body] img').length, 0, 'and never an element');

  // A structure that is not JSON sends nothing and says so.
  await type(page, by(page, 'data-focus', 'req-structure'), '{ not json');
  await send(page);
  assert.match(page.text('[data-req-problem]'), /not valid JSON\. Nothing was sent or saved\./u);
  assert.equal(seen().length, 2);
});

test('Request saves the structure without the entered values, lists it for reuse, and renames and deletes it on a second confirmation', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page, root, seen } = ctx;
  await show(page, 'request'); await choose(page, QUOTE);
  await type(page, input(page, 'path_orderId'), ORDER);
  await page.click(by(page, 'data-req-toggle', 'save'));
  await type(page, by(page, 'data-focus', 'req-name'), 'quote-lookup');
  await page.click('[data-req-save]'); await page.settle(120);
  assert.match(page.text('[data-req-notice]'), /Saved for reuse as requests\/quote-lookup\. The values you entered were not saved\./u);
  const file = join(root, LAYOUT.requests, 'requests', 'quote-lookup.json');
  assert.ok(existsSync(file));
  const saved = readFileSync(file, 'utf8');
  assert.ok(!saved.includes(ORDER), 'the entered value is not in the saved request');
  assert.deepEqual(JSON.parse(saved).request, { method: 'GET', path: '/orders/{orderId}/quote', bindings: { path: { orderId: { $input: 'path_orderId' } } } });
  assert.deepEqual(page.all('[data-req-saved]').map(node => node.getAttribute('data-req-saved')), ['requests/quote-lookup']);
  assert.equal(page.q('[data-req-ref]').getAttribute('data-req-ref'), 'requests/quote-lookup');

  // Opening the saved request later starts with empty fields.
  await choose(page, HEALTH);
  await page.click(by(page, 'data-req-saved', 'requests/quote-lookup')); await page.settle(80);
  assert.equal(input(page, 'path_orderId').value, '');

  await page.click(by(page, 'data-req-toggle', 'save'));
  assert.equal(page.q('[data-req-rename]').disabled, true, 'nothing to move until the folder or name changes');
  await type(page, by(page, 'data-focus', 'req-name'), 'quote-by-order');
  assert.equal(page.q('[data-req-rename]').disabled, false);
  await page.click('[data-req-rename]'); await page.settle(120);
  assert.ok(existsSync(join(root, LAYOUT.requests, 'requests', 'quote-by-order.json')) && !existsSync(file));
  assert.match(page.text('[data-req-notice]'), /Moved to requests\/quote-by-order\./u);

  await page.click('[data-req-delete]');
  assert.equal(page.q('[data-req-delete]').getAttribute('data-req-delete'), 'confirm', 'the first press only asks');
  assert.ok(existsSync(join(root, LAYOUT.requests, 'requests', 'quote-by-order.json')));
  await page.click('[data-req-cancel]');
  assert.equal(page.q('[data-req-delete]').getAttribute('data-req-delete'), 'ask');
  await page.click('[data-req-delete]'); await page.click('[data-req-delete]'); await page.settle(120);
  assert.ok(!existsSync(join(root, LAYOUT.requests, 'requests', 'quote-by-order.json')));
  assert.equal(page.all('[data-req-saved]').length, 0);
  assert.deepEqual(seen(), [], 'saving, opening, renaming and deleting sent no API request');
});

test('Activity lists what was sent newest first, marks and filters the failure, and reads a response only when asked', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page, seen } = ctx;
  await show(page, 'request'); await choose(page, QUOTE);
  await type(page, input(page, 'path_orderId'), ORDER); await send(page);
  await choose(page, HEALTH); await send(page);
  assert.deepEqual(seen().map(row => row.status), [422, 200]);

  await show(page, 'activity');
  const rows = () => page.all('[data-act-row]');
  assert.deepEqual(rows().map(node => [node.getAttribute('title'), node.getAttribute('data-failed')]), [[HEALTH, 'false'], [QUOTE, 'true']]);
  assert.match(page.text('[data-act-caption]'), /^2 requests · 1 failed$/u);
  assert.match(page.text('.group-name'), /^Workbench · /u, 'the caller is the recorded initiator');
  assert.equal(page.q('[data-act-row][aria-current="true"]').getAttribute('title'), HEALTH);
  assert.match(page.text('[data-call-status]'), /HTTP 200 OK\. No checks were run\./u);
  assert.equal(page.all('[data-response-body]').length, 0, 'no response body is read by listing or selecting');

  await page.click('[data-act-filter="failed"]');
  assert.deepEqual(rows().map(node => node.getAttribute('title')), [QUOTE]);
  assert.match(page.text('[data-call-status]'), /HTTP 422 Unprocessable Content/u);
  assert.match(page.text('[data-col="call-details"]'), /HTTP 422 was recorded/u, 'the ledger’s attention finding is shown with the call');
  const before = page.calls.filter(name => name === 'inspect').length;
  await page.click('[data-act-show]'); await page.settle(80);
  assert.equal(page.calls.filter(name => name === 'inspect').length, before + 1);
  assert.match(page.text('[data-response-body]'), /window_required/u);
  assert.equal(seen().length, 2, 'reading recorded activity sent nothing');

  await page.click('[data-act-filter="agent"]');
  assert.equal(rows().length, 0);
  assert.match(page.text('[data-empty-list]'), /No recorded requests match this filter\./u);
});

test('Activity opens a recorded request in Request as a fresh draft: no values, nothing sent, and its recorded result shown', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page, seen } = ctx;
  await show(page, 'request'); await choose(page, QUOTE);
  await type(page, input(page, 'path_orderId'), ORDER); await send(page);
  await show(page, 'activity');
  await page.click(by(page, 'data-act-open', 'request')); await page.settle(120);
  assert.equal(page.q('.switch button[aria-pressed="true"]').getAttribute('data-mode'), 'request');
  assert.equal(input(page, 'path_orderId').value, '', 'the recorded value is not copied into the draft');
  assert.ok(!page.q('#app').textContent.includes(ORDER));
  assert.equal(page.q('[data-response]').getAttribute('data-response'), '422');
  assert.match(page.text('[data-col="response"]'), /recorded result of an earlier request\. Nothing was sent again\./u);
  assert.equal(page.all('[data-response-body]').length, 0);
  await page.click('[data-req-show]'); await page.settle(80);
  assert.match(page.text('[data-response-body]'), /window_required/u);
  assert.equal(seen().length, 1, 'reopening and reading sent nothing');

  // From Activity, an operation's notes open on the Workbench view.
  await show(page, 'activity');
  await page.click(by(page, 'data-act-open', 'operation')); await page.settle(80);
  assert.equal(page.q('.switch button[aria-pressed="true"]').getAttribute('data-mode'), 'workbench');
  assert.equal(page.q('[data-operation-view]').getAttribute('data-operation-view'), QUOTE);
});

test('every control in Activity and Request keeps keyboard focus across a repaint', async t => {
  const ctx = await lab(t); if (!ctx) return;
  const { page } = ctx;
  await show(page, 'request'); await choose(page, QUOTE);
  await type(page, input(page, 'path_orderId'), ORDER); await send(page);
  await page.click(by(page, 'data-req-toggle', 'advanced')); await page.click(by(page, 'data-req-toggle', 'save'));
  const keyed = node => [...node.attributes.keys()].some(name => name.startsWith('data-') && name !== 'data-count' && name !== 'data-production' && name !== 'data-failed');
  const unkeyed = () => page.all('#app button').filter(node => !keyed(node)).map(node => node.textContent);
  assert.deepEqual(unkeyed(), []);
  // Revealing a masked value repaints; focus stays on the control pressed.
  const reveal = by(page, 'data-req-reveal', 'path_orderId'); reveal.focus();
  await page.click(reveal);
  assert.equal(page.document.activeElement.getAttribute('data-req-reveal'), 'path_orderId');
  assert.equal(input(page, 'path_orderId').getAttribute('type'), 'text');
  await show(page, 'activity');
  assert.deepEqual(unkeyed(), []);
  const row = page.q('[data-act-row]'); row.focus();
  await page.click('[data-act-filter="failed"]');
  assert.ok(page.document.activeElement, 'focus is never dropped to nothing');
});

// Review decisions on the Workbench view, over the Parcel Lab's notes. No API
// is behind this lab: recording a decision can send nothing.
function notesLab(t, options = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-review-')), home = join(parent, 'home');
  mkdirSync(home);
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state'); process.env.API_AUTHOR = 'Rae Reviewer';
  t.after(() => { for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, '.state') };
  return buildWorkbenchLab(join(parent, 'repo'), { env, survey: false, ...options });
}
async function reviewPage(root) {
  const page = loadWorkbenchPage(workbenchHandlers(root));
  await page.settle(120);
  await page.click('[data-filter="all"]');
  return page;
}
// Select the note in the given evidence state and open its review decision.
async function decide(page, state) {
  await page.click(page.all('[data-note-row]').find(node => node.getAttribute('data-state') === state)); await page.settle(60);
  await page.click('[data-review-decide-toggle]');
}
const reviews = (root, stack = 'parcel') => Object.values(JSON.parse(readFileSync(fixtureContextFile(root, stack), 'utf8')).operations ?? {})
  .flatMap(entry => entry.note_reviews ?? []);
async function write(page, selector, text) { await type(page, page.q(selector), text); }

test('a person records trust from the note view: the ledger gets the review, the trace shows it, and overturning it needs a run', async t => {
  const { root } = notesLab(t), page = await reviewPage(root);
  await decide(page, 'ok');
  assert.equal(page.q('[data-review-state]').getAttribute('data-review-state'), 'unreviewed');
  assert.equal(page.all('[data-review-record]').length, 0, 'nothing can be recorded before a decision is chosen');
  await page.click('[data-review-choice="trusted"]');
  await write(page, '[data-focus="rev-limits"]', 'local only');
  assert.equal(page.q('[data-review-author]').getAttribute('data-review-author'), 'Rae Reviewer');
  assert.deepEqual(page.all('[data-review-form] button').filter(node => ![...node.attributes.keys()].some(name => name.startsWith('data-review-'))).map(node => node.textContent), [], 'every review control keeps focus across a repaint');
  await page.click('[data-review-record]'); await page.settle(120);
  assert.equal(page.text('[data-review-notice]'), 'Recorded as trusted.');
  assert.deepEqual(reviews(root).map(({ decision, by, actor, limits, evidence }) => ({ decision, by, actor, limits, evidence })),
    [{ decision: 'trusted', by: 'Rae Reviewer', actor: 'person', limits: 'local only', evidence: [] }]);
  assert.match(page.text('[data-review-state]'), /^trusted by Rae Reviewer/u);
  assert.match(page.text('[data-step="Claim"]'), /review.*trusted by Rae Reviewer.*limits: "local only"/u, 'the trace reads the review back');

  // Disputing needs a reason, and overturning a trusted note needs a run.
  await page.click('[data-review-choice="disputed"]');
  assert.equal(page.q('[data-review-record]').disabled, true);
  await write(page, '[data-focus="rev-text"]', 'It no longer returns a status field.');
  assert.equal(page.q('[data-review-record]').disabled, false);
  await page.click('[data-review-record]'); await page.settle(120);
  assert.match(page.text('[data-review-problem]'), /^Not recorded\. Overturning a trusted note requires an attached run ID.*\(NOTE_REVIEW_EVIDENCE_REQUIRED\)$/u);
  assert.equal(reviews(root).length, 1, 'a refused decision writes nothing');
  assert.equal(page.q('[data-focus="rev-text"]').value, 'It no longer returns a status field.', 'the reason is kept for another try');
});

test('a dispute and a run request are recorded with their reasons, and the run request waits for an agent', async t => {
  const { root } = notesLab(t), page = await reviewPage(root);
  await decide(page, 'none');
  await page.click('[data-review-choice="disputed"]');
  await write(page, '[data-focus="rev-text"]', 'Nothing confirms this.');
  await page.click('[data-review-record]'); await page.settle(120);
  assert.equal(page.text('[data-review-notice]'), 'Recorded as disputed.');
  await decide(page, 'mismatch');
  await page.click('[data-review-choice="run-requested"]');
  assert.equal(page.all('[data-focus="rev-evidence"]').length, 0, 'a run request takes no evidence');
  await write(page, '[data-focus="rev-text"]', 'Check the 422 without window.');
  await page.click('[data-review-record]'); await page.settle(120);
  assert.equal(page.text('[data-review-notice]'), 'Run requested. It waits in the repository inbox for an agent. Nothing runs because a run was requested.');
  assert.match(page.text('[data-review-state]'), /run-requested by Rae Reviewer.*request: open/u);
  const recorded = [...reviews(root), ...reviews(root, 'ledger')].map(({ decision, reason, actor }) => [decision, reason, actor]).sort();
  assert.deepEqual(recorded, [['disputed', 'Nothing confirms this.', 'person'], ['run-requested', 'Check the 422 without window.', 'person']]);
});

test('retiring a note asks twice, adds a retirement note and selects it', async t => {
  const { root } = notesLab(t), page = await reviewPage(root);
  const count = page.all('[data-note-row]').length;
  await decide(page, 'none');
  const retired = page.text('[data-note-text]');
  await page.click('[data-review-choice="retire"]'); await page.click('[data-review-retire="removed"]');
  await write(page, '[data-focus="rev-text"]', 'The endpoint was removed.');
  await page.click('[data-review-record]');
  assert.equal(page.q('[data-review-record]').getAttribute('data-review-record'), 'confirm', 'the first press only asks');
  assert.ok(!readFileSync(fixtureContextFile(root, 'parcel'), 'utf8').includes('The endpoint was removed.') && !readFileSync(fixtureContextFile(root, 'ledger'), 'utf8').includes('The endpoint was removed.'));
  await page.click('[data-review-cancel]');
  assert.equal(page.q('[data-review-record]').getAttribute('data-review-record'), 'retire');
  await page.click('[data-review-record]'); await page.click('[data-review-record]'); await page.settle(160);
  assert.match(page.text('[data-review-notice]'), /^Retired the note on .+\. A retirement note was added to the ledger\.$/u);
  assert.match(page.text('[data-note-text]'), /^Retired sha256:[0-9a-f]{64} \(removed\): The endpoint was removed\.$/u, 'the retirement note is selected');
  assert.equal(page.all('[data-note-row]').length, count, 'the retired note gives way to its retirement note');
  assert.ok(!page.all('[data-note-row]').some(node => node.textContent.includes(retired)));
});

test('with no named stacks the review decision is drawn disabled and names the migration command', async t => {
  const { root } = notesLab(t, { singleStore: true }), page = await reviewPage(root);
  await page.click('[data-review-decide-toggle]');
  assert.ok(page.all('[data-review-choice]').every(node => node.disabled));
  assert.match(page.text('[data-review-readonly]'), /Reviews can’t be recorded here until this repository moves to named stacks.*migrate --dry-run/u);
});
