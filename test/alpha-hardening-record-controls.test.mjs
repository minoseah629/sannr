import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {  PRODUCT } from "../lib/brand.mjs";
import { graphRecordFailure, recordGraphContext } from '../lib/graph-record.mjs';
import { captureOperationContext, contextShape } from '../lib/operation-context.mjs';
import { createFixtureStack, fixtureContextFile, inFixtureStack } from './helpers/stack-fixture.mjs';

const identity = { provider: 'fixture-provider', protocol: 'http', environment: 'fixture',
  operation: 'GET /health', endpoint: null, contractDigest: null };
// WORD JOINER is Cf without being a bidi control; RIGHT-TO-LEFT OVERRIDE and
// ARABIC LETTER MARK cover both directional formatting and directional marks.
const controls = ['\u2060', '\u202e', '\u061c'];
const note = 'The response field remains optional in the fixture.';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-record-controls-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/consumer', name: 'Consumer' }, nodes: [], dependencies: [],
    context: { providers: [{ node: 'repo', provider: identity.provider,
      protocol: identity.protocol, environment: identity.environment }] } }));
  createFixtureStack(root, { environment: identity.environment });
  return root;
}

function capture(root, notes = [note], extra = {}) {
  return inFixtureStack(root, () => captureOperationContext(root, { identity, source: { tool: 'fixture-client' },
    basis: 'observed', outcome: 'success', complete: true, notes, ...extra }, { internal: true }));
}

function namedGraphRefusal(call, control) {
  assert.throws(call, error => {
    assert.equal(error.code, 'GRAPH_RECORD_INVALID');
    const failure = graphRecordFailure(error);
    assert.equal(failure.error.code, 'GRAPH_RECORD_INVALID');
    assert.equal(failure.requests_executed, 0);
    assert.equal(failure.published, false);
    assert.ok(!JSON.stringify(failure).includes(control));
    assert.ok(!error.message.includes(control));
    return true;
  });
}

test('AH-4: explicit authored record refuses Unicode format and bidi controls by name before writing', t => {
  const root = fixture(t);
  for (const control of controls) for (const field of ['note', 'operation', 'node']) {
    const args = { node: 'repo', operation: identity.operation, note };
    args[field] += control;
    namedGraphRefusal(() => recordGraphContext(root, args), control);
    assert.equal(existsSync(fixtureContextFile(root)), false);
  }
});

test('AH-4: observation-reference lessons refuse Unicode format and bidi controls without changing source', t => {
  const root = fixture(t), receipt = capture(root);
  const path = fixtureContextFile(root), before = readFileSync(path, 'utf8');
  for (const control of controls) {
    namedGraphRefusal(() => recordGraphContext(root, {
      observation_id: receipt.observation_id, note: note + control,
    }), control);
    assert.equal(readFileSync(path, 'utf8'), before);
  }
});

test('AH-4: operation capture refuses Unicode format and bidi record text by name', t => {
  const root = fixture(t);
  for (const control of controls) {
    assert.throws(() => capture(root, [note + control]), { code: 'CONTEXT_INPUT_INVALID' });
    assert.throws(() => capture(root, [note], { omissions: ['Unsupported field' + control] }), { code: 'CONTEXT_INPUT_INVALID' });
    assert.equal(existsSync(fixtureContextFile(root)), false);
  }
});

test('AH-4: shape capture omits Unicode format and bidi field names instead of promoting them', () => {
  for (const control of controls) {
    const result = contextShape({ ['field' + control]: false, safe: false });
    assert.equal(result.omitted, 1);
    assert.deepEqual(Object.keys(result.shape.properties), ['safe']);
  }
});
