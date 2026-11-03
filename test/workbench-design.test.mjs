// The Workbench page as a user observes it: the packaged script runs against
// the real engine handlers over a synthetic lab repository (no network, no
// real home directory). One test per acceptance scenario in the DESIGN-1 brief.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorkbenchLab } from './fixtures/workbench-lab.mjs';
import { fixtureContextFile } from './helpers/stack-fixture.mjs';
import { loadWorkbenchPage } from './helpers/workbench-dom.mjs';
import { generateSurvey } from '../lib/survey.mjs';
import { workbenchHandlers, workbenchAssets } from '../lib/workbench-engine.mjs';
import { ENV_PREFIX, HOME_ENV_NAME, POINTER_BEGIN, POINTER_END } from '../lib/brand.mjs';
import { LAYOUT } from '../lib/layout.mjs';

function lab(t, { survey = true, mismatch = true, ...options } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'workbench-design-')), home = join(parent, 'home');
  mkdirSync(home);
  const owned = key => key === 'HOME' || key.startsWith('API_') || key.startsWith(`${ENV_PREFIX}_`);
  const previous = Object.fromEntries(Object.entries(process.env).filter(([key]) => owned(key)));
  for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
  process.env.HOME = home; process.env[HOME_ENV_NAME] = join(home, '.state');
  t.after(() => { for (const key of Object.keys(process.env)) if (owned(key)) delete process.env[key];
    Object.assign(process.env, previous); rmSync(parent, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: home, [HOME_ENV_NAME]: join(home, '.state') };
  return { ...buildWorkbenchLab(join(parent, 'repo'), { env, mismatch, generateSurvey: survey ? generateSurvey : undefined, ...options }), env };
}
// One more synthetic note, written through the CLI's own note command.
const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
function addNote({ root, env }, stack, operation, text, args = []) {
  execFileSync(process.execPath, [CLI, 'note', operation, text, '--stack', stack, '--json', '--alongside', ...args],
    { cwd: root, env: { ...env, API_REPO_ROOT: root, API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', NO_COLOR: '1' }, encoding: 'utf8', timeout: 20000 });
}
async function open(root, options) {
  const page = loadWorkbenchPage(workbenchHandlers(root), options);
  await page.settle(120);
  return page;
}
const rows = page => page.all('[data-note-row]');
const selected = page => page.q('[data-note-row][aria-current="true"]')?.getAttribute('data-note-row');
const noteOf = key => JSON.parse(key);
const pressed = (page, selector) => page.q(selector)?.getAttribute('aria-pressed') === 'true';
const stepState = (page, title) => page.q(`[data-step="${title}"]`)?.getAttribute('data-step-state');
async function selectRow(page, operation, stack) {
  const row = rows(page).find(node => { const [s, o] = noteOf(node.getAttribute('data-note-row')); return o === operation && (!stack || s === stack); });
  await page.click(row); await page.settle(60);
  return row.getAttribute('data-note-row');
}

test('pairing opens the Workbench with three columns and its trace, no other screen, and Mismatch first when it has notes', async t => {
  const { root } = lab(t), page = await open(root);
  assert.equal(page.q('#app').hidden, false);
  assert.equal(page.text('[data-product-title]'), 'Product Workbench');
  for (const column of ['list', 'note', 'trace']) assert.ok(page.q(`[data-col="${column}"]`), column);
  assert.ok(page.all('[data-step]').length >= 3, 'the trace is drawn for the selected note');
  assert.deepEqual(page.all('.switch button').map(node => node.getAttribute('data-mode')), ['workbench', 'map']);
  assert.equal(page.all('[data-screen]').length, 0, 'no screen router remains');
  assert.ok(pressed(page, '[data-filter="attention"]'));
  assert.ok(rows(page).every(node => ['mismatch', 'partial'].includes(node.getAttribute('data-state'))));
  const quiet = await open(lab(t, { mismatch: false }).root);
  assert.ok(pressed(quiet, '[data-filter="all"]'), 'All is the default when no note is a mismatch');
  assert.equal(rows(quiet).length, 3);
});

test('switching to the Map draws the survey and switching back restores the selected note and filters', async t => {
  const { root } = lab(t), page = await open(root);
  await page.click('[data-filter="all"]');
  const chosen = await selectRow(page, 'GET /v1/entries');
  await page.click('[data-mode="map"]'); await page.settle(80);
  assert.equal(page.text('[data-product-title]'), 'Product Map');
  const kinds = new Set(page.all('[data-map-node]').map(node => node.getAttribute('data-kind')));
  assert.deepEqual([...kinds].sort(), ['contract', 'ev', 'file', 'op', 'stack']);
  assert.ok(page.all('[data-edge]').length > 0, 'edges join the boxes');
  await page.click('[data-mode="workbench"]');
  assert.equal(page.text('[data-product-title]'), 'Product Workbench');
  assert.ok(pressed(page, '[data-filter="all"]'));
  assert.equal(selected(page), chosen);
});

test('each stack chip counts the notes its click would list, and a stack with no notes is inert', async t => {
  const { root } = lab(t), page = await open(root);
  for (const filter of ['all', 'attention', 'none']) {
    await page.click(`[data-filter="${filter}"]`);
    const chips = page.all('[data-stack]').map(node => [node.getAttribute('data-stack'), Number(node.getAttribute('data-count')), node.getAttribute('aria-disabled') === 'true']);
    for (const [stack, count, inert] of chips) {
      if (inert) continue;
      await page.click(`[data-stack="${stack}"]`);
      assert.equal(rows(page).length, count, `${filter} · ${stack}`);
    }
    await page.click('[data-stack="all"]');
  }
  const vendor = page.q('[data-stack="vendor"]');
  assert.equal(vendor.getAttribute('aria-disabled'), 'true');
  const before = selected(page);
  await page.click(vendor);
  assert.ok(pressed(page, '[data-stack="all"]'), 'the empty stack cannot be chosen');
  assert.equal(selected(page), before);
});

test('changing the filter re-counts basis and stack chips, and an empty result says no notes match', async t => {
  const { root } = lab(t), page = await open(root);
  const basisCounts = () => Object.fromEntries(page.all('[data-basis]').map(node => [node.getAttribute('data-basis'), Number(node.getAttribute('data-count'))]));
  await page.click('[data-filter="all"]');
  const all = basisCounts();
  await page.click('[data-filter="none"]');
  const none = basisCounts();
  assert.notDeepEqual(all, none, 'basis counts follow the filter');
  for (const [basis, count] of Object.entries(none)) {
    if (!count && basis !== 'any') { assert.equal(page.q(`[data-basis="${basis}"]`).getAttribute('aria-disabled'), 'true'); continue; }
    await page.click(`[data-basis="${basis}"]`);
    assert.equal(rows(page).length, count, basis);
  }
  await page.click('[data-basis="local source"]');
  assert.equal(Number(page.q('[data-stack="parcel"]').getAttribute('data-count')), 1);
  assert.equal(Number(page.q('[data-stack="ledger"]').getAttribute('data-count')), 0);
  await page.click('[data-filter="ok"]');
  assert.equal(rows(page).length, 0);
  assert.ok(page.q('[data-empty-list]'));
});

test('the scope-mismatch note shows its amber status, the Re-verify section and the trace from claim to contract', async t => {
  const { root } = lab(t), page = await open(root);
  const [, operation] = noteOf(selected(page));
  assert.equal(operation, 'GET /orders/{orderId}/quote');
  assert.equal(page.q('[data-status]').getAttribute('data-state'), 'mismatch');
  assert.equal(page.q('[data-fix]').getAttribute('data-fix'), 'reverify');
  assert.equal(page.q('[data-col="note"] [data-prompt-kind]').getAttribute('data-prompt-kind'), 'reverify');
  assert.deepEqual(page.all('[data-step]').map(node => node.getAttribute('data-step')), ['Claim', 'Evidence run', 'Run scope', 'Shared observation', 'Contract']);
  assert.equal(stepState(page, 'Evidence run'), 'scope mismatch');
  assert.equal(stepState(page, 'Run scope'), 'older contract');
  assert.equal(stepState(page, 'Shared observation'), 'not shared');
  assert.equal(stepState(page, 'Contract'), 'never verified');
  assert.match(page.text('[data-prompt]'), /GET \/orders\/\{orderId\}\/quote/);
  // The in-scope note's trace reaches its shared observation.
  await page.click('[data-filter="ok"]');
  assert.equal(stepState(page, 'Run scope'), 'matches ledger');
  assert.equal(stepState(page, 'Shared observation'), 'succeeded');
});

test('a saved response is listed on the note, marks the row, counts in the header and the panel, and feeds the Send responses prompt', async t => {
  const { root } = lab(t), page = await open(root);
  const ledger = join(root, '.sannr/stacks/parcel/sannr.json'), before = readFileSync(ledger);
  const key = selected(page), [, operation] = noteOf(key);
  assert.equal(page.q('[data-review-toggle]').getAttribute('data-progress'), '0/1');
  await page.type('[data-focus="draft"]', 'Staging needs the window parameter; re-run with it.');
  await page.click('[data-save]');
  assert.equal(page.all('[data-reply]').length, 1);
  assert.match(page.q('[data-reply]').textContent, /window parameter/);
  assert.ok(rows(page).find(row => row.getAttribute('data-note-row') === key).querySelector('[data-responded]'));
  assert.equal(page.q('[data-review-toggle]').getAttribute('data-progress'), '1/1');
  assert.equal(page.q('[data-focus="draft"]').value, '');
  await page.click('[data-review-toggle]');
  assert.deepEqual(page.all('[data-saved-response]').map(node => node.getAttribute('data-saved-response')), [key]);
  await page.click('[data-prompt-tab="respond"]');
  const prompt = page.text('[data-prompt]'), note = JSON.parse(readFileSync(ledger, 'utf8')).operations[operation].notes_provenance[0];
  assert.ok(prompt.includes(operation) && prompt.includes(note.at) && prompt.includes('window parameter'));
  assert.deepEqual(readFileSync(ledger), before, 'responses never edit the ledger');
  assert.ok(existsSync(join(root, '.sannr/evidence/workbench/responses.json')), 'responses are kept on this machine');
  // A credential-shaped response is refused before anything is saved.
  await page.type('[data-focus="draft"]', 'token sk_live_abcdefghijklmnopqrstuvwxyz0123');
  await page.click('[data-save]');
  assert.ok(page.q('[role="alert"]'));
  assert.equal(page.all('[data-reply]').length, 1);
  // Save and next records the response and moves to the next note.
  await page.click('[data-filter="all"]');
  const first = selected(page);
  await page.type('[data-focus="draft"]', 'Checked against the handler.');
  await page.click('[data-save-next]'); await page.settle(60);
  assert.notEqual(selected(page), first);
  assert.ok(rows(page).find(row => row.getAttribute('data-note-row') === first).querySelector('[data-responded]'));
  const reopened = await open(root);
  await reopened.click('[data-review-toggle]');
  assert.equal(reopened.all('[data-saved-response]').length, 2, 'responses survive a reload');
});

test('the review panel jumps to the next note without a response and copies one prompt for every response', async t => {
  const { root } = lab(t), page = await open(root);
  await page.click('[data-filter="all"]');
  await page.click('[data-review-toggle]');
  assert.ok(page.q('[data-copy-all]').disabled, 'nothing to copy without responses');
  assert.equal(page.q('[data-remaining]').getAttribute('data-remaining'), '4');
  const first = selected(page);
  await page.type('[data-focus="draft"]', 'First response.');
  await page.click('[data-save]');
  await page.click('[data-review-toggle]');
  assert.equal(page.q('[data-remaining]').getAttribute('data-remaining'), '3');
  await page.click('[data-review-next]');
  const second = selected(page);
  assert.notEqual(second, first);
  assert.equal(rows(page).find(row => row.getAttribute('data-note-row') === second).querySelector('[data-responded]'), null);
  assert.equal(page.q('[data-review-panel]'), null, 'jumping closes the panel');
  await page.type('[data-focus="draft"]', 'Second response.');
  await page.click('[data-save]');
  await page.click('[data-review-toggle]');
  assert.equal(page.q('[data-copy-all]').disabled, false);
  await page.click('[data-copy-all]');
  const copied = page.copied.at(-1);
  for (const key of [first, second]) assert.ok(copied.includes(noteOf(key)[1]));
  assert.ok(copied.includes('First response.') && copied.includes('Second response.'));
  // An outside click closes the panel.
  await page.mousedown(page.q('[data-col="trace"]'));
  assert.equal(page.q('[data-review-panel]'), null);
});

test('selecting an operation on the Map highlights its links, fills the aside and opens its note on the Workbench', async t => {
  const { root } = lab(t), page = await open(root);
  await page.click('[data-mode="map"]'); await page.settle(80);
  const op = page.all('[data-map-node][data-kind="op"]').find(node => node.getAttribute('title') === 'GET /orders/{orderId}/quote');
  await page.click(op);
  const edges = page.all('[data-edge]');
  assert.ok(edges.some(edge => edge.classList.contains('on')) && edges.some(edge => edge.classList.contains('dim')));
  assert.ok(page.all('[data-map-node]').some(node => node.classList.contains('dim')));
  assert.equal(page.q('[data-map-node].sel').getAttribute('data-map-node'), op.getAttribute('data-map-node'));
  assert.equal(page.q('[data-selected-kind]').getAttribute('data-selected-kind'), 'op');
  assert.equal(page.all('[data-map-note]').length, 2);
  await page.click('[data-open-workbench]'); await page.settle(60);
  assert.equal(page.q('#app').getAttribute('data-view'), 'workbench');
  assert.equal(noteOf(selected(page))[1], 'GET /orders/{orderId}/quote');
  await page.click('[data-mode="map"]');
  await page.click(page.all('[data-map-node][data-kind="op"]').find(node => node.getAttribute('title') === 'GET /health'));
  await page.click('[data-map-background]');
  assert.equal(page.q('[data-map-node].sel'), null);
  assert.equal(page.all('[data-edge].dim').length, 0);
  assert.equal(page.q('[data-selected-kind]'), null);
});

test('a vendor stack with no operation referenced from code is a dashed box without operation rows, counted in coverage', async t => {
  const { root } = lab(t), page = await open(root);
  await page.click('[data-mode="map"]'); await page.settle(80);
  const vendor = page.q('[data-map-node="stack:vendor"]');
  assert.ok(vendor.classList.contains('dashed'));
  assert.equal(vendor.getAttribute('data-total'), '3');
  assert.equal(vendor.getAttribute('data-referenced'), '0');
  const ops = page.all('[data-map-node][data-kind="op"]').map(node => node.getAttribute('title'));
  assert.deepEqual(ops.sort(), ['GET /health', 'GET /orders/{orderId}/quote', 'GET /v1/entries']);
  assert.equal(page.q('[data-coverage]').getAttribute('data-vendor-hidden'), '3');
  assert.equal(page.q('[data-coverage]').getAttribute('data-vendor-stacks'), '1');
});

test('without a survey the Map shows one line naming the command that builds one, and the Workbench is unaffected', async t => {
  const { root } = lab(t, { survey: false }), page = await open(root);
  await page.click('[data-mode="map"]'); await page.settle(80);
  assert.equal(page.q('[data-no-survey]').getAttribute('data-no-survey'), 'not-generated');
  assert.match(page.q('[data-no-survey]').getAttribute('data-command'), / survey generate$/);
  assert.equal(page.all('[data-map-node]').length, 0);
  assert.equal(page.q('[data-coverage]'), null);
  await page.click('[data-mode="workbench"]');
  await page.click('[data-filter="all"]');
  assert.equal(rows(page).length, 4);
});

test('appearance applies Light, Dark or System, survives a reload, and the page loads nothing from the network', async t => {
  const { root } = lab(t), page = await open(root);
  assert.equal(page.document.documentElement.getAttribute('data-theme'), 'light', 'Light until the operator chooses');
  await page.click('[data-settings-toggle]');
  assert.ok(pressed(page, '[data-appearance="light"]'));
  assert.deepEqual(page.all('[data-appearance]').map(node => node.getAttribute('data-appearance')), ['light', 'dark', 'system']);
  await page.click('[data-appearance="dark"]');
  assert.equal(page.document.documentElement.getAttribute('data-theme'), 'dark');
  const reloaded = await open(root);
  assert.equal(reloaded.document.documentElement.getAttribute('data-theme'), 'dark');
  await reloaded.click('[data-settings-toggle]');
  assert.ok(pressed(reloaded, '[data-appearance="dark"]'));
  await reloaded.click('[data-appearance="system"]');
  assert.equal((await open(root, { dark: true })).document.documentElement.getAttribute('data-theme'), 'dark', 'System follows a dark preference');
  assert.equal((await open(root, { dark: false })).document.documentElement.getAttribute('data-theme'), 'light', 'System follows a light preference');
  const assets = workbenchAssets(), css = assets.get('/workbench.css').body, html = assets.get('/').body, js = assets.get('/workbench.js').body;
  for (const text of [css, html, js]) assert.doesNotMatch(text.replaceAll('http://www.w3.org/2000/svg', ''), /\b(?:https?:)?\/\/(?!127\.0\.0\.1)[a-z0-9.-]+\.[a-z]{2,}/iu);
  const faces = [...css.matchAll(/@font-face\{font-family:"([^"]+)";[^}]*src:url\((data:font\/woff2;base64,)/gu)].map(match => match[1]);
  assert.deepEqual([...new Set(faces)].sort(), ['Instrument Sans', 'JetBrains Mono']);
  assert.doesNotMatch(css, /Anton|Courier Prime|data-theme="(?:slate|paper|ink)"/u);
});

test('column widths persist on this machine within their bounds, and double-click resets them', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root);
  await handlers.appearance.run({ columns: { left: 480, right: 300 } });
  const page = await open(root);
  assert.match(page.q('[data-workbench]').style.getPropertyValue('grid-template-columns'), /min\(480px, 30vw\).*min\(300px, 32vw\)/);
  await assert.rejects(handlers.appearance.run({ columns: { left: 900, right: 300 } }), { code: 'WORKBENCH_COLUMNS_INVALID' });
  const handle = page.q('[data-handle="left"]');
  for (const fn of handle.listeners.dblclick) fn({});
  await page.settle(40);
  assert.match(page.q('[data-workbench]').style.getPropertyValue('grid-template-columns'), /min\(340px, 30vw\).*min\(380px, 32vw\)/);
  assert.deepEqual((await handlers.workbench.run({})).appearance.columns, { left: null, right: null });
});

test('J and K move through the list and do nothing while the response box has focus', async t => {
  const { root } = lab(t), page = await open(root);
  await page.click('[data-filter="all"]');
  const order = rows(page).map(node => node.getAttribute('data-note-row'));
  assert.equal(selected(page), order[0]);
  await page.key('j'); await page.settle(40);
  assert.equal(selected(page), order[1]);
  await page.key('k'); await page.settle(40);
  assert.equal(selected(page), order[0]);
  const box = page.q('[data-focus="draft"]');
  box.focus();
  await page.key('j', box);
  assert.equal(selected(page), order[0]);
});

test('J, K, Previous, Next and the position follow the rows as drawn, group by group', async t => {
  const repo = lab(t);
  // A second ledger note sorts first by date and operation but is drawn in the ledger group.
  addNote(repo, 'ledger', 'GET /accounts', 'Accounts are paged by cursor too.', ['--by', 'Lab reviewer', '--actor', 'person']);
  const page = await open(repo.root);
  await page.click('[data-filter="all"]');
  const order = rows(page).map(node => node.getAttribute('data-note-row'));
  assert.equal(order.length, 5);
  assert.deepEqual(order.map(key => noteOf(key)[0]), ['ledger', 'ledger', 'parcel', 'parcel', 'parcel'], 'rows are drawn grouped by stack');
  await page.click(rows(page)[0]);
  for (let i = 1; i < order.length; i++) {
    await page.key('j'); await page.settle(40);
    assert.equal(selected(page), order[i], `J step ${i}`);
    assert.equal(page.q('[data-position]').getAttribute('data-position'), `${i + 1}/${order.length}`);
  }
  await page.click('[data-nav="next"]');
  assert.equal(selected(page), order[0], 'Next wraps to the first drawn row');
  await page.click('[data-nav="previous"]');
  assert.equal(selected(page), order.at(-1));
  await page.key('k'); await page.settle(40);
  assert.equal(selected(page), order.at(-2));
});

test('focus returns to the activated control after a repaint, popovers follow their toggles, and Map notes open from the keyboard', async t => {
  const { root } = lab(t), page = await open(root);
  const focused = () => page.document.activeElement;
  const filter = page.q('[data-filter="all"]');
  filter.focus(); await page.click(filter);
  assert.ok(focused().isConnected && focused().getAttribute('data-filter') === 'all', 'the new filter chip keeps focus');
  const row = rows(page)[1], key = row.getAttribute('data-note-row');
  row.focus(); await page.click(row);
  assert.ok(focused().isConnected && focused().getAttribute('data-note-row') === key, 'the activated row keeps focus');
  await page.key('j', focused()); await page.settle(40);
  assert.equal(focused().getAttribute('data-note-row'), selected(page), 'focus follows J to the newly selected row');
  for (const [toggle, panel] of [['[data-settings-toggle]', '[data-settings]'], ['[data-review-toggle]', '[data-review-panel]']]) {
    page.q(toggle).focus(); await page.click(toggle);
    const siblings = page.q(toggle).parentNode.childNodes;
    assert.equal(siblings.indexOf(page.q(panel)), siblings.indexOf(page.q(toggle)) + 1, `${panel} comes right after its toggle`);
    assert.ok(focused().isConnected && focused().hasAttribute(toggle.slice(1, -1)));
    await page.click(toggle);
  }
  await page.click('[data-mode="map"]'); await page.settle(80);
  await page.click(page.all('[data-map-node][data-kind="op"]').find(node => node.getAttribute('title') === 'GET /orders/{orderId}/quote'));
  const mapNote = page.q('[data-map-note]');
  assert.equal(mapNote.tagName, 'BUTTON', 'a Map note row is a button');
  const target = mapNote.getAttribute('data-map-note');
  mapNote.focus(); await page.click(mapNote); await page.settle(60);
  assert.equal(page.q('#app').getAttribute('data-view'), 'workbench');
  assert.equal(selected(page), target);
  assert.equal(focused().getAttribute('data-note-row'), target, 'focus lands on the opened note');
});

test('a partial note names its out-of-scope run in the status, the Re-verify body and the prompt, whichever run tab is selected', async t => {
  const repo = lab(t);
  addNote(repo, 'parcel', 'GET /health', 'Health returns 200 in both environments.', ['--evidence', 'run-lab-health-ok', '--evidence', 'run-lab-quote-scope', '--by', 'Lab agent', '--actor', 'agent']);
  const page = await open(repo.root);
  await page.click(rows(page).find(node => node.getAttribute('data-state') === 'partial')); await page.settle(60);
  const tabs = page.all('[data-run-tab]').map(node => node.getAttribute('data-run-tab'));
  assert.deepEqual(tabs.sort(), ['run-lab-health-ok', 'run-lab-quote-scope']);
  const seen = [];
  for (const run of tabs) {
    await page.click(`[data-run-tab="${run}"]`);
    const body = page.text('[data-fix-body]'), prompt = page.text('[data-prompt]');
    assert.equal(page.q('[data-fix]').getAttribute('data-fix'), 'reverify');
    assert.ok(body.includes('lab-quot') && !body.includes('lab-heal'), `the body names only the flagged run (${run} selected)`);
    assert.ok(prompt.includes('run-lab-quote-scope') && prompt.includes('run-lab-health-ok'), 'the prompt accounts for both runs');
    seen.push([page.text('[data-status]'), body, prompt]);
  }
  assert.deepEqual(seen[0], seen[1], 'the run tab does not change what the page says about the note');
});

test('returning to the tab re-reads the index and the selected note, and a failed trace read is shown but not kept', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root);
  let fail = true;
  const note = handlers.note;
  handlers.note = { run: (...args) => { if (fail) { fail = false; throw Object.assign(new Error('busy'), { code: 'WORKBENCH_BUSY', nextAction: 'Try again.' }); } return (note.run ?? note)(...args); } };
  const page = loadWorkbenchPage(handlers); await page.settle(120);
  assert.equal(page.all('[data-step]').length, 0, 'the failed read leaves no trace');
  assert.equal(page.q('[data-prompt]').getAttribute('data-prompt-state'), 'problem', 'the prompt card reports the failed read');
  assert.ok(page.q('[data-copy-prompt]').disabled);
  const key = selected(page), [stack, operation, noteId] = noteOf(key);
  await handlers.respond.run({ stack, operation, note_id: noteId, text: 'Written from another tab.' });
  assert.equal(rows(page).find(row => row.getAttribute('data-note-row') === key).querySelector('[data-responded]'), null);
  await page.returnToTab(); await page.settle(60);
  assert.ok(rows(page).find(row => row.getAttribute('data-note-row') === key).querySelector('[data-responded]'), 'the index is read again');
  assert.ok(page.all('[data-step]').length >= 3, 'the selected note is read again');
  assert.equal(page.q('[data-prompt]').getAttribute('data-prompt-state'), 'ready');
});

test('Escape closes the review panel and the settings popover, and the column handles resize from the keyboard and persist', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root), page = await open(root);
  await page.click('[data-review-toggle]');
  assert.ok(page.q('[data-review-panel]'));
  await page.key('Escape');
  assert.equal(page.q('[data-review-panel]'), null);
  await page.click('[data-settings-toggle]');
  await page.key('Escape');
  assert.equal(page.q('[data-settings]'), null);
  const handle = page.q('[data-handle="left"]');
  assert.equal(handle.getAttribute('role'), 'separator');
  assert.equal(handle.getAttribute('tabindex'), '0');
  handle.focus();
  await page.key('ArrowRight', handle);
  assert.match(page.q('[data-workbench]').style.getPropertyValue('grid-template-columns'), /^min\(356px, 30vw\)/);
  assert.equal(page.document.activeElement, handle, 'the handle keeps focus while resizing');
  await page.settle(40);
  assert.equal((await handlers.workbench.run({})).appearance.columns.left, 356, 'the width is saved like a drag');
  for (let i = 0; i < 20; i++) await page.key('ArrowLeft', handle);
  assert.match(page.q('[data-workbench]').style.getPropertyValue('grid-template-columns'), /^min\(220px, 30vw\)/, 'the keyboard stays within the drag bounds');
  const right = page.q('[data-handle="right"]');
  await page.key('ArrowLeft', right);
  assert.match(page.q('[data-workbench]').style.getPropertyValue('grid-template-columns'), /min\(396px, 32vw\)$/, 'moving the right handle left widens the trace');
});

test('the verify prompt stops for a production environment the note names, whichever run is selected', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root);
  let environments = [{ name: 'production', production: true }];
  const note = handlers.note;
  handlers.note = { run: async (...args) => ({ ...(await (note.run ?? note)(...args)), environments }) };
  const page = loadWorkbenchPage(handlers); await page.settle(120);
  await page.click('[data-filter="none"]');
  assert.equal(page.q('[data-status]').getAttribute('data-state'), 'none');
  assert.ok(page.q('[data-prompt]').hasAttribute('data-stop'), 'a run-less note naming production stops first');
  environments = [{ name: 'local', production: false }];
  const fresh = loadWorkbenchPage(handlers); await fresh.settle(120);
  await fresh.click('[data-filter="none"]');
  assert.equal(fresh.q('[data-prompt]').hasAttribute('data-stop'), false);
});

test('a saved response updates only its own note when the server returns that note’s responses', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root);
  const respond = handlers.respond;
  handlers.respond = { run: async params => {
    const result = await (respond.run ?? respond)(params), key = JSON.stringify([params.stack || '', params.operation, params.note_id]);
    return { key, responses: result.responses?.[key] ?? result.responses ?? [], ledger_written: false };
  } };
  const page = loadWorkbenchPage(handlers); await page.settle(120);
  await page.click('[data-filter="all"]');
  const [first, second] = rows(page).map(node => node.getAttribute('data-note-row'));
  for (const key of [first, second]) {
    await page.click(rows(page).find(node => node.getAttribute('data-note-row') === key)); await page.settle(40);
    await page.type('[data-focus="draft"]', `Response on ${noteOf(key)[1]}.`);
    await page.click('[data-save]');
  }
  for (const key of [first, second]) assert.ok(rows(page).find(node => node.getAttribute('data-note-row') === key).querySelector('[data-responded]'), key);
  await page.click('[data-review-toggle]');
  assert.equal(page.q('[data-copy-all]').getAttribute('data-responses'), '2');
});

test('with the review panel open, a click elsewhere closes the panel and still does what it was', async t => {
  const { root } = lab(t), page = await open(root);
  await page.click('[data-filter="all"]');
  const openPanel = async () => { await page.click('[data-review-toggle]'); assert.ok(page.q('[data-review-panel]')); };
  await openPanel();
  const row = rows(page)[2], key = row.getAttribute('data-note-row');
  await page.click(row); await page.settle(40);
  assert.equal(page.q('[data-review-panel]'), null);
  assert.equal(selected(page), key, 'the row is selected on the same click');
  await openPanel();
  await page.click('[data-filter="none"]');
  assert.equal(page.q('[data-review-panel]'), null);
  assert.ok(pressed(page, '[data-filter="none"]'), 'the filter changes on the same click');
  await openPanel();
  await page.click('[data-settings-toggle]');
  assert.equal(page.q('[data-review-panel]'), null);
  assert.ok(page.q('[data-settings]'), 'settings open on the same click');
  await page.click('[data-settings-toggle]');
  await openPanel();
  await page.click('[data-mode="map"]'); await page.settle(80);
  assert.equal(page.q('[data-review-panel]'), null);
  assert.equal(page.q('#app').getAttribute('data-view'), 'map', 'the view switches on the same click');
});

test('keyboard resizing stops at the width the column is drawn at, and saves that width', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root), page = await open(root);
  page.context.innerWidth = 1440; // the list is drawn at most 30vw (432px) wide, the trace 32vw (460.8px)
  const right = page.q('[data-handle="right"]'), left = page.q('[data-handle="left"]');
  right.focus();
  for (let i = 0; i < 8; i++) await page.key('ArrowLeft', right, { shiftKey: true });
  assert.equal(right.getAttribute('aria-valuenow'), '460');
  await page.key('ArrowRight', right);
  assert.equal(right.getAttribute('aria-valuenow'), '444', 'the first step back narrows the drawn trace');
  left.focus();
  for (let i = 0; i < 8; i++) await page.key('ArrowRight', left, { shiftKey: true });
  assert.equal(left.getAttribute('aria-valuenow'), '432');
  await page.settle(40);
  assert.deepEqual((await handlers.workbench.run({})).appearance.columns, { left: 432, right: 444 });
});

test('a column handle reports the width drawn and the widest it can reach, as the window and the columns change', async t => {
  const { root } = lab(t), handlers = workbenchHandlers(root);
  await handlers.appearance.run({ columns: { left: 480, right: null } });
  const page = loadWorkbenchPage(handlers, { innerWidth: 880 }); await page.settle(120);
  const handle = side => page.q(`[data-handle="${side}"]`);
  const value = side => [Number(handle(side).getAttribute('aria-valuenow')), Number(handle(side).getAttribute('aria-valuemax'))];
  // At 880 the list is drawn at most 30vw (264px) wide and the trace 32vw (281.6px).
  assert.deepEqual(value('left'), [264, 264], 'a stored width above the cap reports the drawn width');
  assert.deepEqual(value('right'), [281, 281]);
  await page.resize(1440);
  assert.deepEqual(value('left'), [432, 432], 'resizing the window updates the values without a repaint');
  assert.deepEqual(value('right'), [380, 460]);
  await page.drag(handle('left'), 500);
  assert.deepEqual(value('left'), [432, 432], 'a wide drag reports the drawn width');
  await page.resize(880);
  await page.key('ArrowLeft', handle('left'));
  assert.deepEqual(value('left'), [248, 264], 'a key press steps from the drawn width');
  for (const fn of handle('left').listeners.dblclick) fn({});
  await page.settle(40);
  assert.deepEqual(value('left'), [264, 264], 'after a reset the default width is reported as drawn');
  assert.deepEqual(value('right'), [281, 281]);
  await page.click('[data-filter="all"]');
  assert.deepEqual(value('left'), [264, 264], 'a repaint keeps the drawn width');
});

// The Map's operation boxes by operation, and opening one on the Workbench.
const mapOp = (page, operation) => page.all('[data-map-node][data-kind="op"]').find(node => node.getAttribute('title') === operation);
async function openOperation(page, operation) {
  await page.click('[data-mode="map"]'); await page.settle(80);
  await page.click(mapOp(page, operation));
  const opens = page.q('[data-open-workbench]').getAttribute('data-open-workbench');
  await page.click('[data-open-workbench]'); await page.settle(80);
  return opens;
}

test('an operation with no note opens on the Workbench in the operation view, with a ready first-note prompt and its runs in the trace', async t => {
  const { root } = lab(t, { quietOperations: true }), page = await open(root);
  assert.equal(await openOperation(page, 'POST /orders/{orderId}/label'), 'operation');
  assert.equal(page.q('#app').getAttribute('data-view'), 'workbench');
  assert.equal(page.q('[data-operation-view]').getAttribute('data-operation-view'), 'POST /orders/{orderId}/label');
  assert.equal(page.q('[data-note-row][aria-current="true"]'), null, 'no row is current');
  assert.ok(rows(page).length > 0, 'the list keeps its rows and filters');
  assert.equal(page.q('[data-nav]'), null); assert.equal(page.q('[data-position]'), null);
  assert.equal(page.q('[data-prompt]').getAttribute('data-prompt'), 'first-note');
  assert.equal(page.q('[data-prompt]').getAttribute('data-prompt-state'), 'ready');
  assert.equal(page.q('[data-save]'), null, 'responses belong to notes');
  assert.equal(stepState(page, 'Claim'), 'no note');
  assert.deepEqual(page.all('[data-run-tab]').map(node => node.getAttribute('data-run-tab')), ['run-lab-label-created', 'run-lab-label-refused'], 'newest first');
  await page.click(page.all('[data-run-tab]')[1]);
  assert.equal(page.all('[data-run-tab]')[1].getAttribute('aria-pressed'), 'true');
  await page.click('[data-copy-prompt]');
  assert.equal(page.copied.length, 1);
  assert.equal(page.text('[data-copy-prompt]'), 'Copied');
  // An operation with no run file at all.
  await openOperation(page, 'DELETE /orders/{orderId}');
  assert.equal(stepState(page, 'Evidence run'), 'none recorded');
  assert.equal(page.all('[data-run-tab]').length, 0);
  assert.deepEqual(page.all('[data-step]').map(node => node.getAttribute('data-step')), ['Claim', 'Evidence run', 'Run scope', 'Shared observation', 'Contract'], 'the five-step shape');
  // An operation with notes still opens its first note.
  assert.equal(await openOperation(page, 'GET /health'), 'note');
  assert.equal(page.q('[data-operation-view]'), null);
  assert.equal(noteOf(selected(page))[1], 'GET /health');
});

test('J leaves the operation view for the first row, and K for the last', async t => {
  const { root } = lab(t, { quietOperations: true }), page = await open(root);
  await page.click('[data-filter="all"]');
  await openOperation(page, 'POST /orders/{orderId}/label');
  const list = rows(page).map(node => node.getAttribute('data-note-row'));
  await page.key('j');
  assert.equal(page.q('[data-operation-view]'), null);
  assert.equal(selected(page), list[0]);
  await openOperation(page, 'POST /orders/{orderId}/label');
  await page.key('k');
  assert.equal(selected(page), list.at(-1));
});

test('the first-note prompt stops for a production environment of the operation’s stack', async t => {
  // The single store's declared environments count as its stack's.
  const single = lab(t, { quietOperations: true, singleStore: true, survey: false });
  mkdirSync(join(single.root, LAYOUT.environments, '..'), { recursive: true });
  writeFileSync(join(single.root, LAYOUT.environments), JSON.stringify({ default: 'local', environments: {
    local: { baseUrl: 'http://127.0.0.1:9', contract: 'parcel-service/openapi.json' }, live: { baseUrl: 'https://api.parcel.example.test', production: true } } }));
  generateSurvey(single.root, { now: '2026-10-29T12:00:00.000Z' });
  const stored = await open(single.root);
  await openOperation(stored, 'DELETE /orders/{orderId}');
  assert.equal(stored.q('[data-prompt]').getAttribute('data-prompt-state'), 'ready');
  assert.ok(stored.q('[data-prompt]').hasAttribute('data-stop'));
  const { root } = lab(t, { quietOperations: true });
  let page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  assert.equal(page.q('[data-prompt]').hasAttribute('data-stop'), false);
  const file = join(root, LAYOUT.collection, 'parcel', 'stack.json'), stack = JSON.parse(readFileSync(file, 'utf8'));
  stack.environments.staging.production = true; writeFileSync(file, JSON.stringify(stack));
  page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  assert.equal(page.q('[data-prompt]').getAttribute('data-prompt-state'), 'ready');
  assert.ok(page.q('[data-prompt]').hasAttribute('data-stop'));
});

test('the remap button copies a prompt that runs the server’s survey commands, with or without a survey', async t => {
  for (const survey of [true, false]) {
    const { root } = lab(t, { survey }), page = await open(root);
    const map = await workbenchHandlers(root).surveyMap.run({});
    await page.click('[data-mode="map"]'); await page.settle(80);
    assert.ok(page.q(survey ? '[data-coverage] [data-copy-remap]' : '[data-no-survey] [data-copy-remap]'));
    await page.click('[data-copy-remap]');
    assert.equal(page.copied.length, 1);
    for (const command of [map.command, map.status_command]) assert.ok(page.copied[0].includes(command), command);
    assert.equal(page.text('[data-copy-remap]'), 'Copied');
  }
});

// Notes written by hand go to the ledger as person-authored notes.
const ledgerNotes = (root, operation) => {
  const entry = JSON.parse(readFileSync(fixtureContextFile(root, 'parcel'), 'utf8')).operations[operation] ?? {};
  return (entry.notes ?? []).map((text, i) => ({ text, ...entry.notes_provenance[i], superseded: entry.notes_superseded?.[i] ?? null }));
};

test('a note saved from the operation view is written to the ledger by the person the marker names, and the page selects it', async t => {
  const { root } = lab(t, { quietOperations: true });
  process.env.API_AUTHOR = 'Lab Person';
  const page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  assert.equal(page.q('[data-note-composer]').getAttribute('data-note-composer'), 'operation');
  assert.equal(page.q('[data-note-author]').getAttribute('data-note-author'), 'Lab Person');
  await page.type('[data-note-composer] textarea', '  A second label request answers 409.  ');
  await page.click('[data-save-note]'); await page.settle(80);
  const saved = ledgerNotes(root, 'POST /orders/{orderId}/label');
  assert.equal(saved.length, 1);
  assert.equal(saved[0].text, 'A second label request answers 409.', 'the text is trimmed');
  assert.equal(saved[0].by, 'Lab Person'); assert.equal(saved[0].actor, 'person');
  assert.equal(page.q('[data-operation-view]'), null, 'the operation view closes');
  assert.ok(pressed(page, '[data-filter="all"]'));
  const [, operation] = noteOf(selected(page));
  assert.equal(operation, 'POST /orders/{orderId}/label');
  assert.equal(page.q('[data-note-row][aria-current="true"]').getAttribute('data-state'), 'none');
  assert.ok(page.q('[data-note-text]').textContent.includes('answers 409'));
});

test('a new note on an operation that has notes is saved alongside them and the older notes stay active', async t => {
  const { root } = lab(t);
  process.env.API_AUTHOR = 'Lab Person';
  const page = await open(root);
  await page.click('[data-filter="all"]');
  const before = await selectRow(page, 'GET /health');
  assert.equal(page.q('[data-note-composer]'), null, 'the composer opens from its toggle');
  await page.click('[data-new-note-toggle]');
  assert.equal(page.q('[data-new-note-toggle]').getAttribute('aria-expanded'), 'true');
  await page.type('[data-note-composer="note"] textarea', 'Health answers within a second on local.');
  await page.click('[data-save-note]'); await page.settle(80);
  const saved = ledgerNotes(root, 'GET /health');
  assert.equal(saved.length, 2);
  assert.ok(saved.every(row => row.superseded === null), 'nothing is superseded');
  const index = await workbenchHandlers(root).workbench.run({});
  assert.equal(index.notes.filter(note => note.operation === 'GET /health').length, 2, 'both notes are active');
  assert.notEqual(selected(page), before);
  assert.equal(noteOf(selected(page))[1], 'GET /health');
  assert.equal(page.q('[data-note-composer]'), null, 'the composer closes after a save');
});

test('a note that looks like it holds a credential is refused, the draft stays and the ledger bytes are unchanged', async t => {
  const { root } = lab(t, { quietOperations: true });
  const page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  const ledger = readFileSync(fixtureContextFile(root, 'parcel'));
  const draft = `Send Authorization: Bearer ${'Q7x'.repeat(16)} to label.`;
  await page.type('[data-note-composer] textarea', draft);
  await page.click('[data-save-note]'); await page.settle(80);
  assert.equal(page.q('[data-note-problem]').getAttribute('data-note-problem'), 'SECRET_IN_NOTE');
  assert.equal(page.q('[data-note-problem]').getAttribute('role'), 'alert');
  assert.equal(page.q('[data-note-composer] textarea').value, draft, 'the draft stays');
  assert.ok(page.q('[data-operation-view]'), 'the operation view stays open');
  assert.deepEqual(readFileSync(fixtureContextFile(root, 'parcel')), ledger);
});

test('the operation view’s agent prompt kind is a label, not a button', async t => {
  const { root } = lab(t, { quietOperations: true }), page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  const label = page.q('[data-prompt-label]');
  assert.ok(label);
  assert.notEqual(label.tagName, 'BUTTON');
  assert.equal(label.hasAttribute('aria-pressed'), false);
  assert.equal(page.all('[data-operation-view] [data-prompt-tab]').length, 0);
  assert.equal(page.all('[data-operation-view] .seg').length, 0);
});

test('a note’s prompt kind is a label while it is the only one, and becomes two tabs once a response adds Send responses', async t => {
  const { root } = lab(t), page = await open(root);
  const label = page.q('[data-col="note"] [data-prompt-label]');
  assert.ok(label);
  assert.notEqual(label.tagName, 'BUTTON');
  assert.equal(label.hasAttribute('aria-pressed'), false);
  assert.equal(page.all('[data-col="note"] [data-prompt-tab]').length, 0);
  await page.type('[data-focus="draft"]', 'Checked against the handler.');
  await page.click('[data-save]');
  assert.deepEqual(page.all('[data-col="note"] [data-prompt-tab]').map(node => node.getAttribute('data-prompt-tab')), ['verify', 'respond']);
  assert.equal(page.q('[data-col="note"] [data-prompt-label]'), null);
});

test('in a repository with no named stacks both note composers are drawn disabled and the ledger is unchanged', async t => {
  const named = lab(t, { quietOperations: true }), ready = await open(named.root);
  await openOperation(ready, 'POST /orders/{orderId}/label');
  assert.equal(ready.q('[data-note-composer]').getAttribute('data-note-writes'), 'ready');
  const { root } = lab(t, { quietOperations: true, singleStore: true, survey: false });
  // The single store's own contract, so the Map lists its operations.
  mkdirSync(join(root, LAYOUT.environments, '..'), { recursive: true });
  writeFileSync(join(root, LAYOUT.environments), JSON.stringify({ default: 'local', environments: {
    local: { baseUrl: 'http://127.0.0.1:9', contract: 'parcel-service/openapi.json' } } }));
  generateSurvey(root, { now: '2026-10-29T12:00:00.000Z' });
  const file = join(root, LAYOUT.context), before = readFileSync(file);
  const page = await open(root);
  await page.click('[data-new-note-toggle]');
  assert.equal(page.q('[data-note-composer="note"]').getAttribute('data-note-writes'), 'migration_required');
  await openOperation(page, 'DELETE /orders/{orderId}');
  const composer = page.q('[data-note-composer="operation"]');
  assert.equal(composer.getAttribute('data-note-writes'), 'migration_required');
  assert.equal(page.q('[data-note-composer="operation"] textarea').disabled, true);
  assert.equal(page.q('[data-note-composer="operation"] [data-save-note]').disabled, true);
  assert.ok(page.q('[data-note-composer="operation"] [data-note-readonly]'));
  await page.click('[data-save-note]'); await page.settle(80);
  assert.equal(page.q('[data-note-problem]'), null);
  assert.deepEqual(readFileSync(file), before);
});

test('Save note is disabled until the draft has text, and an empty draft writes nothing', async t => {
  const { root } = lab(t, { quietOperations: true });
  const page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  const ledger = readFileSync(fixtureContextFile(root, 'parcel'));
  assert.equal(page.q('[data-save-note]').disabled, true, 'disabled with no draft');
  await page.type('[data-note-composer] textarea', '   \n  ');
  assert.equal(page.q('[data-save-note]').disabled, true, 'disabled with whitespace only');
  await page.click('[data-save-note]'); await page.settle(80);
  assert.equal(page.q('[data-note-problem]'), null);
  assert.deepEqual(readFileSync(fixtureContextFile(root, 'parcel')), ledger);
  await page.type('[data-note-composer] textarea', 'A label is printable once.');
  assert.equal(page.q('[data-save-note]').disabled, false, 'enabled once the draft has text');
});

test('when the managed pointer refresh fails the note is saved once, and its draft stays open under the new note to retry', async t => {
  const { root } = lab(t, { quietOperations: true });
  process.env.API_AUTHOR = 'Lab Person';
  // A managed block with two openings cannot be refreshed.
  writeFileSync(join(root, 'AGENTS.md'), `# Lab\n\n${POINTER_BEGIN}\nold\n${POINTER_BEGIN}\n${POINTER_END}\n`);
  const page = await open(root);
  await openOperation(page, 'POST /orders/{orderId}/label');
  const draft = 'A label request after cancellation answers 409.';
  await page.type('[data-note-composer] textarea', draft);
  await page.click('[data-save-note]'); await page.settle(80);
  assert.equal(ledgerNotes(root, 'POST /orders/{orderId}/label').length, 1, 'the note is saved');
  assert.equal(page.q('[data-operation-view]'), null);
  assert.equal(noteOf(selected(page))[1], 'POST /orders/{orderId}/label', 'the new note is selected');
  assert.equal(page.q('[data-new-note-toggle]').getAttribute('aria-expanded'), 'true');
  assert.equal(page.q('[data-note-composer="note"] textarea').value, draft, 'the draft stays for a retry');
  await page.click('[data-save-note]'); await page.settle(80);
  assert.equal(ledgerNotes(root, 'POST /orders/{orderId}/label').length, 1, 'a retry does not save the note twice');
});
