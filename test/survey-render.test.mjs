import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSurveyDot, renderSurveyHtml, renderSurveySection } from '../lib/survey-render.mjs';
import { createSurveySnapshot } from '../lib/survey-model.mjs';

function fixture({ fileLabel = 'src/client.mjs' } = {}) {
  return createSurveySnapshot({
    nodes: [
      { id: 'file-client', kind: 'file', label: fileLabel, file: 'src/client.mjs' },
      { id: 'file-server', kind: 'file', label: 'src/server.mjs', file: 'src/server.mjs' },
      { id: 'op-orders', kind: 'operation', label: 'GET /orders/{id}', operation: 'GET /orders/{id}', stack: 'orders' },
      { id: 'op-billing', kind: 'operation', label: 'POST /invoices', operation: 'POST /invoices', stack: 'billing' },
      { id: 'host-unknown', kind: 'host', label: 'unlinked.example.test', host: 'unlinked.example.test' },
      { id: 'contract-orders', kind: 'contract', label: 'orders.openapi.json', contract: 'orders.openapi.json' },
    ],
    relationships: [
      { id: 'edge-calls', kind: 'calls', from: 'file-client', to: 'op-orders',
        declarations: [{ kind: 'code', file: 'src/client.mjs', line: 12 }], observations: [], operator_attributions: [] },
      { id: 'edge-defines', kind: 'defines', from: 'file-server', to: 'op-orders',
        declarations: [{ kind: 'code', file: 'src/server.mjs', line: 20 }], observations: [], operator_attributions: [] },
      { id: 'edge-supplies', kind: 'supplies', from: 'op-orders', to: 'op-billing',
        source_field: '$.id', target_parameter: { location: 'query', name: 'order_id' },
        scope: { source_stack: 'orders', target_stack: 'billing', environment: 'local' },
        declarations: [{ kind: 'suite', file: 'api-suites/orders.json' }],
        observations: [{ kind: 'executed_transfer', evidence: { run_id: 'run-fixture' }, proof: { state: 'unavailable' } }],
        operator_attributions: [{ kind: 'operator', author: 'Fixture operator', at: '2026-10-16T00:00:00.000Z' }] },
    ],
    unresolved: [{ reason: 'host_unbound', host: 'unlinked.example.test' }],
  }, { now: '2026-10-17T12:00:00.000Z' });
}

test('survey projections preserve graph identities, stack groups and every provenance class', () => {
  const model = fixture();
  const dot = renderSurveyDot(model), html = renderSurveyHtml(model), section = renderSurveySection(model);
  assert.ok(html.includes(section), 'standalone and embedded consumers use the identical projection');
  assert.doesNotMatch(section, /<!doctype|<html\b|<body\b/iu);
  assert.ok([...section.matchAll(/\sid="([^"]+)"/gu)].every(([, id]) => id.startsWith('survey')));
  for (const node of model.nodes) {
    assert.match(dot, new RegExp(`"${node.id}" \\[`, 'u'));
    assert.equal([...html.matchAll(new RegExp(`data-node-id="${node.id}"`, 'gu'))].length, 1);
  }
  for (const edge of model.relationships) {
    assert.match(dot, new RegExp(`"${edge.from}" -> "${edge.to}" \\[id="${edge.id}"`, 'u'));
    assert.equal([...html.matchAll(new RegExp(`data-relationship-id="${edge.id}"`, 'gu'))].length, 1);
  }
  for (const text of ['orders', 'billing', 'run-fixture', 'Fixture operator', 'order_id', '$.id', 'host_unbound']) {
    assert.ok(dot.includes(text), `DOT retains ${text}`);
    assert.ok(html.includes(text), `HTML retains ${text}`);
  }
  assert.match(html, /<details[^>]*>[\s\S]*?<summary>Stack orders/u);
  assert.match(html, /Unlinked nodes/u);
  assert.match(html, /proof[\s\S]*unavailable/u);
});

test('snapshot readers distinguish build time from an explicitly supplied current-input check', () => {
  const model = fixture();
  for (const render of [renderSurveyDot, renderSurveyHtml]) {
    const unchecked = render(model);
    assert.ok(unchecked.includes(model.snapshot.id));
    assert.ok(unchecked.includes(model.snapshot.built_at));
    assert.match(unchecked, /current inputs not checked/u);
    const status = { snapshot_id: model.snapshot.id, state: 'stale', checked_at: '2026-10-17T13:00:00.000Z', source: { state: 'stale' }, observations: { state: 'unknown' }, private_diagnostic: ['', 'Users', 'private', 'credentials'].join('/') };
    const checked = render(model, { status });
    assert.match(checked, /2026-10-17T13:00:00.000Z/u);
    assert.match(checked, /stale/u);
    assert.match(checked, /unknown/u);
    assert.doesNotMatch(checked, /private\/credentials/u);
    assert.match(render(model, { status: { ...status, snapshot_id: 'a-different-snapshot' } }), /current inputs not checked/u);
    assert.throws(() => render({ ...model, v: 999 }), /survey|version/iu);
  }
});

test('rendered metadata cannot become HTML, DOT attributes or external resources', () => {
  const model = fixture({ fileLabel: 'quoted "label" <img src=x onerror=alert(1)>' });
  const dot = renderSurveyDot(model), html = renderSurveyHtml(model);
  assert.match(dot, /quoted \\"label\\"/u);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(html, /<(?:script|img|iframe|object|embed|link)\b|<[^>]*\s(?:src|srcset|onload|onerror)=|@import|url\(/iu);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'/u);
  assert.doesNotMatch(dot, /\b(?:URL|href|image)\s*=/iu);
  const privateModel = fixture();
  privateModel.nodes[0].file = ['', 'Users', 'private', 'project', 'client.mjs'].join('/');
  assert.throws(() => renderSurveyHtml(privateModel), /survey|unsafe|path/iu);
  assert.throws(() => renderSurveyDot(privateModel), /survey|unsafe|path/iu);
});
