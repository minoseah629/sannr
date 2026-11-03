// Offline theme choices are native form controls: no script, storage or requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOME_ENV_NAME } from '../lib/brand.mjs';
import { seedApiMapFixture, AT } from './fixtures/api-map/fixture.mjs';
import { buildApiMapModel } from '../lib/api-map.mjs';
import { footprintModel, renderMapHtml } from '../lib/map.mjs';
import { buildViewModel, renderViewHtml } from '../lib/view.mjs';

function pages(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'report-theme-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  seedApiMapFixture(root, { withSource: false });
  const env = { [HOME_ENV_NAME]: join(root, '.state'), API_USAGE_LOG: join(root, '.usage.jsonl') };
  return {
    map: renderMapHtml(footprintModel({ root, surfaces: [], edges: [], external: [], platform: [] }), { apiMap: buildApiMapModel(root, { now: Date.parse(AT), env }) }),
    view: renderViewHtml(buildViewModel(root, { generatedAt: AT, env })),
  };
}

test('map and view expose keyboard-accessible light/dark/system choices with deliberate defaults', t => {
  for (const [kind, html] of Object.entries(pages(t))) {
    assert.ok(/<fieldset class="report-theme"><legend>Theme<\/legend>/.test(html), `${kind} has no theme controls`);
    const controls = [...html.matchAll(/<input type="radio" name="report-theme" id="report-theme-(system|light|dark)"([^>]*)>/g)];
    assert.equal(controls.length, 3, kind);
    assert.deepEqual(controls.filter(row => /\bchecked\b/.test(row[2])).map(row => row[1]), [kind === 'map' ? 'dark' : 'system']);
    for (const theme of ['system', 'light', 'dark']) {
      assert.match(html, new RegExp(`<label for="report-theme-${theme}">`));
      assert.ok(html.includes(`:root:has(#report-theme-${theme}:checked)`), `${kind} ${theme} CSS state`);
    }
    assert.match(html, /:focus-visible/);
  }
});

test('theme palettes match the brand while reports remain self-contained and script-free', t => {
  for (const [kind, html] of Object.entries(pages(t))) {
    assert.match(html, /--bg:#0b0b0b/);
    assert.ok(/--bg:#fbfaf5/.test(html), `${kind} has no light palette`);
    assert.match(html, /--accent-text:#4a5c05/);
    assert.match(html, /--accent:#c8f224/);
    assert.match(html, /Content-Security-Policy/);
    assert.doesNotMatch(html, /<script|<link|<iframe|<object|<embed|\bsrc\s*=|\bon[a-z]+\s*=|localStorage|sessionStorage/i, kind);
    assert.doesNotMatch(html, /href="(?!#)/, kind);
    const urls = [...html.matchAll(/url\s*\(([^)]*)\)/gi)].map(row => row[1]);
    assert.ok(urls.every(value => kind === 'map' && value.startsWith('#')));
  }
});
