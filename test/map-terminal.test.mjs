import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { renderMapReceipt } from '../lib/map-terminal.mjs';
import { terminalTheme } from '../lib/terminal.mjs';

const withoutAnsi = text => text.replace(/\x1b\[[0-9;]*m/g, '');
const withoutLinks = text => text.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const plainTheme = columns => terminalTheme({ stream: { isTTY: false, columns }, env: {} });
const model = (summary = {}, metadata = {}) => ({
  summary: { services: 1, operations: 1, undocumented_routes: 0, edges: 1,
    external: 1, shadow: 1, findings: 1, platform: 1, high: 2, ...summary },
  services: [], edges: [], external: [], platform: [], ...metadata,
});
const render = (value = model(), options = {}) => renderMapReceipt(value,
  { out: ('/' + 'tmp/api-footprint.html'), theme: plainTheme(100), ...options });
function tileCounts(output) {
  const lines = withoutAnsi(output).split('\n'), found = {};
  const cells = line => [...line.matchAll(/\|([^|]*)\|/g)].map(match => match[1].trim());
  for (let i = 0; i < lines.length; i++) {
    const values = cells(lines[i]);
    if (!values.length || !values.every(value => /^\d+$/.test(value))) continue;
    const captions = values.map(() => []);
    for (let row = i + 1; row < lines.length && /^\s*\|/.test(lines[row]); row++)
      cells(lines[row]).forEach((caption, index) => { if (caption) captions[index].push(caption); });
    values.forEach((value, index) => {
      const caption = captions[index].join(' ');
      assert.ok(caption, 'every number tile needs an associated caption');
      assert.equal(Object.hasOwn(found, caption), false, `duplicate statistic ${caption}`);
      found[caption] = Number(value);
    });
  }
  return found;
}

test('map receipt emits no ANSI for pipes, NO_COLOR presence, or a dumb terminal', () => {
  const plain = render();
  for (const [stream, env] of [
    [{ isTTY: false }, { FORCE_COLOR: '3', COLORTERM: 'truecolor' }],
    [{ isTTY: true }, { NO_COLOR: '' }],
    [{ isTTY: true }, { NO_COLOR: '0', FORCE_COLOR: '3' }],
    [{ isTTY: true }, { TERM: 'dumb', FORCE_COLOR: '3' }],
  ]) {
    const output = render(model(), { theme: terminalTheme({ stream: { ...stream, columns: 100 }, env }) });
    assert.doesNotMatch(output, /\x1b/, 'disabled color must not leave escape sequences in the output');
    assert.equal(output, plain, 'color preference must not change the reported facts');
  }
});

test('map receipt styles a TTY while preserving its plain text at both color depths', () => {
  for (const depth of [4, 24]) {
    const theme = terminalTheme({ stream: { isTTY: true, columns: 100, getColorDepth: () => depth }, env: { TERM: 'xterm' } });
    const output = render(model(), { theme });
    assert.match(output, /\x1b\[[0-9;]+m/, 'interactive terminal output should carry styling');
    assert.equal(withoutAnsi(output), render());
    assert.doesNotMatch(withoutAnsi(output), /\x1b/, 'every emitted style sequence must have a removable SGR form');
    assert.notEqual(theme.stamp('count'), theme.alarm('count'), 'inventory and finding fills must remain distinguishable');
    if (depth === 4) assert.doesNotMatch(output, /\x1b\[[0-9;]*48;2;/, 'basic-color terminals must not receive truecolor backgrounds');
  }
});

test('the primary map action links to the rendered HTTP preview and keeps the saved file separate', () => {
  const preview = { url: 'http://127.0.0.1:54321/abc123', expiresInMinutes: 30, pid: 12345 };
  const theme = terminalTheme({ stream: { isTTY: true }, env: { TERM: 'xterm' } });
  const output = render(model(), { preview, theme });
  assert.match(output, /\x1b\]8;;http:\/\/127\.0\.0\.1:54321\/abc123\x1b\\/);
  assert.doesNotMatch(output, /\x1b\]8;;file:/, 'file links can send HTML into the IDE source editor');
  const plain = withoutLinks(withoutAnsi(output));
  assert.match(plain, /OPEN THE MAP\n  ↗ http:\/\/127\.0\.0\.1:54321\/abc123/);
  assert.match(plain, /Cmd\/Ctrl\+click/);
  assert.match(plain, /Link expires in 30 minutes/);
  assert.match(plain, /KEEP A COPY\n  \/tmp\/api-footprint\.html/);
  assert.doesNotMatch(plain, /\x1b/);
  for (const [stream, env] of [
    [{ isTTY: false }, {}], [{ isTTY: true }, { NO_COLOR: '' }],
    [{ isTTY: true }, { TERM: 'dumb' }],
  ]) {
    const unstyled = render(model(), { preview, theme: terminalTheme({ stream, env }) });
    assert.equal(unstyled, plain, 'the URL remains visible and usable without terminal escapes');
  }
});

test('a failed browser preview retains the completed map and describes the fallback honestly', () => {
  const output = render(model(), { previewFailed: true });
  assert.match(output, /SAVED MAP/);
  assert.match(output, /\/tmp\/api-footprint\.html/);
  assert.match(output, /Browser preview unavailable\. Open this file from your browser\./);
  assert.doesNotMatch(output, /OPEN THE MAP|http:\/\/|Link expires/);
});

test('terminal hyperlinks cannot introduce escape controls or executable schemes', () => {
  const theme = terminalTheme({ stream: { isTTY: true }, env: {} });
  for (const url of [('file:///' + 'tmp/map.html'), ('vscode://file/' + 'tmp/map.html'),
    'https://example.invalid/\x1b]8;;file:///forged\x07', 'http://example.invalid/\r\nFAKE',
    'https://example.invalid/\x9b2J']) {
    const output = theme.link(url);
    assert.doesNotMatch(output, /[\x00-\x1f\x7f-\x9f]/);
  }
});

test('map receipt associates singular tile captions with exact counts and keeps high/platform totals separate', () => {
  const output = render();
  assert.deepEqual(tileCounts(output), { SERVICE: 1, 'DOCUMENTED OP': 1, 'SERVICE EDGE': 1,
    'SHADOW ROUTE': 1, DISAGREEMENT: 1, 'EXTERNAL UPSTREAM': 1, 'PLATFORM DISAGREEMENT': 1 });
  assert.match(output, /2 high-severity findings/);
  assert.doesNotMatch(output, /3 high-severity/, 'platform disagreements must not be added to the already computed high count');
});

test('optional undocumented and platform tiles retain their own counts and disappear only at zero', () => {
  const base = tileCounts(render(model({ platform: 0, undocumented_routes: 0 })));
  assert.equal(Object.keys(base).length, 6);
  assert.equal(Object.keys(base).some(caption => /UNDOCUMENTED|PLATFORM/.test(caption)), false);
  const extended = tileCounts(render(model({ undocumented_routes: 23, platform: 4 })));
  assert.equal(Object.keys(extended).length, 8);
  assert.equal(extended['UNDOCUMENTED ROUTES'], 23);
  assert.equal(extended['PLATFORM DISAGREEMENTS'], 4);
  for (const [caption, count] of Object.entries(base)) assert.equal(extended[caption], count);
});

test('positive inventory and findings use distinct color roles while zeros stay neutral in both layouts', () => {
  for (const columns of [36, 100]) {
    const theme = plainTheme(columns), colored = { inventory: [], finding: [] };
    theme.stamp = theme.accent = text => { colored.inventory.push(text); return text; };
    theme.alarm = text => { colored.finding.push(text); return text; };
    render(model({ services: 11, operations: 12, edges: 0, external: 0, shadow: 13,
      findings: 14, undocumented_routes: 15, platform: 16, high: 0 }), { theme });
    const numbers = rows => rows.map(row => /^\|\s*(\d+)\s*\|$/.exec(row)?.[1]
      ?? /^(\d+) /.exec(row)?.[1]).filter(value => value !== undefined).map(Number);
    assert.deepEqual(numbers(colored.inventory), [11, 12]);
    assert.deepEqual(numbers(colored.finding), [13, 14, 15, 16]);
    assert.equal([...numbers(colored.inventory), ...numbers(colored.finding)].includes(0), false,
      'a zero count must never receive either inventory or alert color');
  }
});

test('external-only receipt describes detected scan scope without inventing service edges', () => {
  const output = render(model({ services: 0, operations: 0, edges: 0, external: 2,
    shadow: 0, findings: 0, platform: 0, high: 0 }));
  assert.deepEqual(tileCounts(output), { SERVICES: 0, 'DOCUMENTED OPS': 0, 'SERVICE EDGES': 0,
    'SHADOW ROUTES': 0, DISAGREEMENTS: 0, 'EXTERNAL UPSTREAMS': 2 });
  assert.match(output, /no served API.*(?:found|detected).*scan/i);
  assert.match(output, /outside.*scanned services/i);
  assert.doesNotMatch(output, /serves none|no dependencies|third-party|high-severity/i);
});

test('only explicit static mode claims zero API requests and zero findings never imply an all-clear', () => {
  const value = model({ shadow: 0, findings: 0, platform: 0, high: 0 },
    { request_execution: false, services: [{ reachable: null }] });
  const ordinary = render(value), staticOutput = render(value, { noExecute: true });
  assert.match(staticOutput, /source scan only/i);
  assert.match(staticOutput, /no API requests executed/i);
  assert.match(ordinary, /source declarations.*probe results/i);
  assert.doesNotMatch(ordinary, /no API requests|zero (?:API )?requests|source scan only|not probed/i,
    'absence of per-service execution metadata is not an exhaustive zero-request ledger');
  for (const output of [ordinary, staticOutput])
    assert.doesNotMatch(output, /all.clear|healthy|fully verified|no issues/i);
});

test('map receipt branding follows the dynamic product rename seam', () => {
  const script = `
    import { renderMapReceipt } from ${JSON.stringify(new URL('../lib/map-terminal.mjs', import.meta.url).href)};
    import { terminalTheme } from ${JSON.stringify(new URL('../lib/terminal.mjs', import.meta.url).href)};
    process.stdout.write(renderMapReceipt(${JSON.stringify(model())}, {
      out: ('/' + 'tmp/footprint.html'), theme: terminalTheme({ stream: { isTTY: false }, env: {} })
    }));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script],
    { encoding: 'utf8', env: { ...process.env, API_CONTEXT_PRODUCT_NAME: 'wiremark' } });
  assert.match(output, /wiremark/);
  assert.doesNotMatch(output, /sannr/i);
});

test('narrow map receipts wrap statistics without losing or splitting their facts', () => {
  const value = model({ services: 12, operations: 345, undocumented_routes: 23,
    edges: 7, external: 4, shadow: 6, findings: 8, platform: 2, high: 0 });
  const narrowOutput = render(value, { theme: plainTheme(36) });
  const narrow = narrowOutput.split('\n').filter(line => /^\s+\d+ /.test(line));
  assert.equal(Object.keys(tileCounts(narrowOutput)).length, 0, 'narrow screens use a compact count list');
  assert.ok(narrow.every(line => line.length <= 36), 'statistic rows must fit the requested terminal width');
  assert.deepEqual(new Set(narrow.map(line => line.trim())), new Set([
    '12 services', '345 documented operations', '7 service edges', '4 external dependencies',
    '6 shadow routes', '8 disagreements', '23 undocumented routes', '2 platform disagreements',
  ]));
  const expected = { SERVICES: 12, 'DOCUMENTED OPS': 345, 'SERVICE EDGES': 7,
    'SHADOW ROUTES': 6, DISAGREEMENTS: 8, 'EXTERNAL UPSTREAMS': 4,
    'UNDOCUMENTED ROUTES': 23, 'PLATFORM DISAGREEMENTS': 2 };
  for (const columns of [52, 80, 100]) {
    const output = render(value, { theme: plainTheme(columns) });
    assert.deepEqual(tileCounts(output), expected, `the ${columns}-column grid must retain every count`);
    const gridLines = output.split('\n').filter(line => /^\s*[+|]/.test(line));
    assert.ok(gridLines.every(line => line.length <= columns), 'tile frames and captions must fit the terminal');
  }
});

test('untrusted output paths cannot inject terminal controls or new receipt lines', () => {
  const path = ('/' + 'tmp/map\x1b]8;;https://example.invalid/\x07CLICK\x1b]8;;\x07\r\n\x9b2J.html');
  for (const theme of [plainTheme(80), terminalTheme({ stream: { isTTY: true, columns: 80 }, env: {} })]) {
    const output = withoutAnsi(render(model(), { out: path, theme }));
    assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/,
      'repository-controlled path bytes must never remain active terminal controls');
    const pathLines = output.split('\n').filter(line => line.includes(('/' + 'tmp/map')));
    assert.equal(pathLines.length, 1);
    assert.match(pathLines[0], /\\u001b\]8;;/);
    assert.match(pathLines[0], /\\u0007/);
    assert.match(pathLines[0], /\\u000d\\u000a\\u009b2J\.html$/);
    assert.equal(output.split('\n').length, withoutAnsi(render(model(), { theme })).split('\n').length,
      'embedded path newlines must not forge receipt rows');
  }
});

test('a repository label cannot insert terminal controls or forge receipt lines', () => {
  const root = ('/' + 'tmp/hostile\x1b[2J\r\n\x9b31mrepo');
  for (const theme of [plainTheme(80), terminalTheme({ stream: { isTTY: true, columns: 80 }, env: {} })]) {
    const output = withoutAnsi(render(model({}, { root }), { theme }));
    assert.doesNotMatch(output, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    assert.match(output, /hostile\\u001b\[2J\\u000d\\u000a\\u009b31mrepo/);
    assert.equal(output.split('\n').length, withoutAnsi(render(model({}, { root: ('/' + 'tmp/ordinary') }), { theme })).split('\n').length);
  }
});
