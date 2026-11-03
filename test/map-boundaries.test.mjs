import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT, HOME_ENV_NAME } from '../lib/brand.mjs';
import { footprintModel, renderMapHtml, renderMapText } from '../lib/map.mjs';
import { decorateGraphMapHtml } from '../lib/graph-map.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const attack = '\x1b[31m\x1b]8;;https://x.invalid\x07link\x1b]8;;\x07\rend';
const controls = /[\x00-\x09\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const escaped = '\\u001b[31m\\u001b]8;;https://x.invalid\\u0007link\\u001b]8;;\\u0007\\u000dend';
function model(value = attack) {
  return footprintModel({ root: `/fixture/${value}`, surfaces: [{ name: `service${value}`, dir: '/fixture',
    kind: 'documented', declared: 1, repo: `repo${value}`, owner: `owner${value}`, ownerSource: `source${value}`,
    shadowRoutes: [{ method: 'GET', path: `/route${value}`, file: `src/${value}.mjs` }],
    findings: [{ kind: 'schema-mismatch', op: `GET /finding${value}`, detail: `detail${value}` }],
  }], edges: [{ from: `service${value}`, to: `target${value}`, via: `src/${value}.mjs`, operations: [`GET /call${value}`] }],
  external: [{ from: `service${value}`, url: `host${value}`, via: `src/${value}.mjs` }],
  platform: [{ dimension: `dimension${value}`, detail: `detail${value}` }] });
}

function fixture(t) {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'map-boundaries-'))), root = join(temp, 'project');
  mkdirSync(root); t.after(() => rmSync(temp, { recursive: true, force: true }));
  writeFileSync(join(root, 'server.mjs'), `app.get("/route${attack}", handler);\n`);
  writeFileSync(join(root, 'openapi.json'), JSON.stringify({ openapi: '3.0.0', info: { title: 'Map', version: '1' },
    paths: { '/declared': { get: { responses: { 200: { description: 'ok' } } } } } }));
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1, repository: { id: 'fixture/map', name: 'Map' }, nodes: [], dependencies: [] }));
  const run = args => spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, API_CONTEXT_DIR: root, API_CONTEXT_OFF: '0', API_BASE_URL: '', API_ENV: '', NODE_OPTIONS: '',
      NO_COLOR: '1', [HOME_ENV_NAME]: join(temp, 'home'), API_USAGE_LOG: join(temp, 'usage.jsonl'), API_EVIDENCE: join(root, 'evidence') } });
  return { temp, root, run };
}

test('AH-2 text map visibly escapes a route with ESC color, OSC-8 hyperlink and carriage return on stdout', t => {
  const { run } = fixture(t), result = run(['map', '.', '--text', '--no-execute']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(controls.test(result.stdout), false, 'repository route bytes must not control the terminal');
  // Route extraction collapses repeated path slashes; the terminal boundary
  // still has to preserve every control as visible escaped data.
  assert.ok(result.stdout.includes(`/route${escaped.replace('https://', 'https:/')}`),
    'each route control must remain visible as escaped text');
});

test('AH-2 text map sanitizes every foreign column and bounds oversized service names', () => {
  for (const complete of [false, true]) {
    const text = renderMapText(model(), { complete });
    assert.equal(controls.test(text), false, 'foreign map fields contain no terminal controls');
    assert.ok(text.includes(`GET /route${escaped}`));
    const wide = renderMapText(model('x'.repeat(20000)), { complete });
    assert.ok(wide.split('\n').every(line => line.length <= 1024), 'oversized foreign columns must not expand a terminal row without limit');
  }
});

test('AH-2 HTML map strips control and bidi characters in local and shared graph fields', () => {
  const value = `${attack}\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069<>`;
  const html = decorateGraphMapHtml(renderMapHtml(model(value)), { ok: true,
    repositories: [{ id: 'fixture/map', name: value }], nodes: [{ id: 'fixture/map#api', name: value }],
    edges: [], omissions: [value] });
  assert.equal(controls.test(html), false, 'HTML content removes controls and bidi formatting');
  assert.ok(html.includes('&lt;&gt;'), 'markup remains HTML-escaped');
});

test('AH-2 map --out ../x requires the explicit outside-project flag', t => {
  const { root, temp, run } = fixture(t), outside = join(temp, 'x.html');
  const denied = run(['map', '.', '--no-execute', '--out', '../x.html']);
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).error.code, 'OUTPUT_OUTSIDE_PROJECT');
  assert.equal(existsSync(outside), false);
  assert.equal(denied.stderr.includes(root), false, 'refusal must not promote workstation paths');
  const allowed = run(['map', '.', '--no-execute', '--out', '../x.html', '--allow-outside-project']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(readFileSync(outside, 'utf8'), /^<!doctype html>/iu);
});

test('AH-2 map --out through a symlink refuses even with outside-project authority', t => {
  const { root, temp, run } = fixture(t), outside = join(temp, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const flags of [[], ['--allow-outside-project']]) {
    const result = run(['map', '.', '--no-execute', '--out', 'linked/map.html', ...flags]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, 'OUTPUT_UNSAFE_PATH');
    assert.equal(existsSync(join(outside, 'map.html')), false);
  }
});

test('AH-2 graph export outside project refuses until --allow-outside-project is explicit', t => {
  const { temp, run } = fixture(t), outside = join(temp, 'graph.json');
  const denied = run(['graph', 'export', '--out', outside, '--json']);
  assert.equal(denied.status, 1);
  assert.equal(JSON.parse(denied.stderr).error.code, 'OUTPUT_OUTSIDE_PROJECT');
  assert.equal(existsSync(outside), false);
  assert.equal(denied.stderr.includes(outside), false, 'refusal uses curated remediation without the path');
  const allowed = run(['graph', 'export', '--out', outside, '--allow-outside-project', '--json']);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(JSON.parse(readFileSync(outside, 'utf8')).repository.id, 'fixture/map');
});
