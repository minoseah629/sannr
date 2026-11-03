import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decorateGraphMapHtml } from '../lib/graph-map.mjs';
import { footprintModel, renderMapHtml } from '../lib/map.mjs';

const original = '<!doctype html><html><body><main><section id="services">LOCAL: 2 services / 9 operations / 1 edge</section></main></body></html>';
const graph = (overrides = {}) => ({ v: 1, ok: true, action: 'overview', coverage: 'partial', requests_executed: 0,
  focus: 'acme/frontend#repo', repositories: [
    { id: 'acme/frontend', name: 'Frontend', url: 'https://example.invalid/frontend', generated_at: '2026-09-10T00:00:00.000Z' },
    { id: 'acme/billing', name: 'Billing' },
  ], nodes: [
    { id: 'acme/frontend#ui', repository: 'acme/frontend', name: 'Invoice UI', kind: 'component', file: 'src/Invoice.tsx' },
    { id: 'acme/billing#api', repository: 'acme/billing', name: 'Billing API', kind: 'service' },
    { id: 'acme/auth#api', repository: 'acme/auth', name: 'acme/auth#api', kind: 'unresolved', unresolved: true },
  ], edges: [
    { id: 'one', repository: 'acme/frontend', from: 'acme/frontend#ui', to: 'acme/billing#api', kind: 'calls',
      basis: 'declared', protocol: 'graphql', environment: 'staging', file: 'src/Invoice.tsx', operations: ['query Invoice'] },
    { id: 'two', repository: 'acme/frontend', from: 'acme/frontend#ui', to: 'acme/auth#api', kind: 'depends_on', basis: 'declared' },
  ], callers: { count: 1, repositories: ['acme/mobile'], coverage: 'partial' }, knowledge: [],
  unresolved: [{ id: 'acme/auth#api', referenced_by: ['two'] }], issues: [], omissions: ['Overview returns a small index only.'], truncated: {}, ...overrides });

test('shared dependencies are appended inside main while the source scan output stays intact', () => {
  const html = decorateGraphMapHtml(original, graph());
  assert.ok(html.startsWith(original.split('</main>')[0]));
  assert.ok(html.endsWith('</main></body></html>'));
  assert.match(html, /shared dependency graph/);
  assert.match(html, /The next repo\./);
  assert.match(html, /Declared relationships shown/);
  assert.match(html, /LOCAL: 2 services \/ 9 operations \/ 1 edge/);
  assert.match(html, /local source-scan counts above are unchanged/);
  assert.match(html, /query Invoice/);
  assert.match(html, /graphql · staging/);
  assert.match(html, /src\/Invoice\.tsx/);
  assert.match(html, /published dependency declarations/);
  assert.match(html, /do not establish live traffic or a breaking change/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<link\b|@import|url\(|fetch\(/iu);
});

test('only published HTTP(S) repository URLs become browser links, with no guessed URL for missing repos', () => {
  const html = decorateGraphMapHtml(original, graph());
  assert.match(html, /href="https:\/\/example\.invalid\/frontend" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /snapshot exported 2026-09-10/);
  assert.match(html, /acme\/billing · repository link not published/);
  assert.match(html, /acme\/mobile/);
  assert.doesNotMatch(html, /href="[^"]*(?:billing|mobile|auth)(?:"|\/)/);
  const internalLinks = [...html.matchAll(/href="#(shared-node-[a-f0-9]+)"/gu)].map(match => match[1]);
  assert.ok(internalLinks.length >= 4);
  for (const id of internalLinks) assert.ok(html.includes(`id="${id}"`));
});

test('unknown callers and unresolved providers stay visibly incomplete when counts are zero', () => {
  const html = decorateGraphMapHtml(original, graph({ callers: { count: 0, repositories: [] }, edges: [] }));
  assert.match(html, /No callers are declared in the selected snapshots\. Other callers are unknown\./);
  assert.match(html, /Known caller repos · lower bound/);
  assert.match(html, /Coverage is partial/);
  assert.match(html, /acme\/auth#api/);
  assert.match(html, /do not define this provider node or its repository location/);
  assert.match(html, /Other publishers may still have saved claims/);
  assert.doesNotMatch(html, /no consumers|no callers exist|complete graph|all clear/iu);
});

test('hostile catalog labels and metadata are escaped and cannot add elements or attributes', () => {
  const bad = '<img src=x onerror="alert(1)">';
  const html = decorateGraphMapHtml(original, graph({
    repositories: [{ id: bad, name: bad, url: 'https://example.invalid/repo', generated_at: bad }],
    nodes: [{ id: bad, name: bad, repository: bad, kind: bad, file: bad }],
    edges: [{ from: bad, to: bad, repository: bad, kind: bad, file: bad, protocol: bad, environment: bad, operations: [bad] }],
    callers: { count: 1, repositories: [bad] }, unresolved: [{ id: bad }],
    issues: [{ code: bad, message: bad }], omissions: [{ repository: bad, message: bad }],
  }));
  assert.doesNotMatch(html, /<img\b|onerror="|<script\b/iu);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.ok([...html.matchAll(/id="([^"]+)"/gu)].every(match => !match[1].includes('<')));
});

test('script, credential-bearing, protocol-relative, file, query, and malformed repository URLs are inert', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', ('file:///' + 'Users/person/repo.html'),
    '//example.invalid/repo', 'https://person:private-value@example.invalid/repo', 'https://example.invalid/repo?token=private-value',
    'https://example.invalid/repo#private-value', 'https://example.invalid/" onmouseover="x', ' https://example.invalid/repo', 'https:\n//example.invalid/repo']) {
    const html = decorateGraphMapHtml(original, graph({ repositories: [{ id: 'repo', name: 'Repo', url }], nodes: [], edges: [], unresolved: [] }));
    assert.doesNotMatch(html, /<a href="(?:https?:|javascript:|data:|file:|\/\/)/iu);
    assert.doesNotMatch(html, /private-value|onmouseover=/);
    assert.match(html, /repository link not published/);
  }
});

test('bounded context gaps and unavailable catalog results are visible without dumping saved knowledge', () => {
  const html = decorateGraphMapHtml(original, graph({ knowledge: [{ notes: ['PRIVATE KNOWLEDGE MUST STAY OUT OF THE OVERVIEW'] }],
    truncated: { response_bytes: true }, omissions: Array.from({ length: 34 }, (_, index) => `Omitted detail ${index}.`) }));
  assert.match(html, /bounded view/);
  assert.match(html, /4 further coverage reports are omitted/);
  assert.match(html, /retrieve saved API context for the operation/);
  assert.doesNotMatch(html, /PRIVATE KNOWLEDGE/);
  const unavailable = decorateGraphMapHtml(original, graph({ ok: false, issues: [{ code: 'GRAPH_CATALOG_UNREADABLE', message: 'The selected snapshot is unavailable.' }] }));
  assert.match(unavailable, /Shared graph context is unavailable/);
  assert.match(unavailable, /GRAPH_CATALOG_UNREADABLE/);
  assert.doesNotMatch(unavailable, /Declared relationships shown/);
});

test('decoration is optional and idempotent and never guesses an insertion point', () => {
  assert.equal(decorateGraphMapHtml(original, undefined), original);
  assert.equal(decorateGraphMapHtml('<html><body>no main</body></html>', graph()), '<html><body>no main</body></html>');
  const once = decorateGraphMapHtml(original, graph());
  assert.equal(decorateGraphMapHtml(once, graph()), once);
});

test('the current footprint renderer accepts the supplemental graph without changing its model or scripts policy', () => {
  const model = footprintModel({ root: '/fixture', surfaces: [{ name: 'Billing', dir: '/fixture', kind: 'documented', declared: 3,
    findings: [], shadowRoutes: [], shadowCount: 0, checked: 0, reachable: null }], edges: [], external: [], platform: [] });
  const before = structuredClone(model), base = renderMapHtml(model), html = decorateGraphMapHtml(base, graph());
  assert.deepEqual(model, before);
  assert.ok(html.includes(base.slice(0, base.indexOf('</main>'))));
  assert.match(html, /id="shared-dependency-graph"/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<img\b|<link\b/iu);
});
