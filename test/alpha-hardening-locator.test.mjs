import { withFixtureProjection, fixtureEvidencePath } from './helpers/stack-fixture.mjs';
import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {  PRODUCT } from "../lib/brand.mjs";
import { captureOperationContext as captureRaw } from '../lib/operation-context.mjs';
import { graphRecordFailure, recordGraphContext as recordRaw } from '../lib/graph-record.mjs';

const captureOperationContext = (root,...args) => withFixtureProjection(root, () => captureRaw(root,...args));
const recordGraphContext = (root,...args) => withFixtureProjection(root, () => recordRaw(root,...args));
const identity = { provider: 'fixture-provider', protocol: 'http', environment: 'fixture',
  operation: 'GET /health', endpoint: null, contractDigest: null };
const workstationLocator = `${'/' + 'Users'}/${['fixture', 'private'].join('-')}/evidence.json`;

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'alpha-locator-integrity-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, fixtureEvidencePath(), 'evidence.json'), '{}');
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({ v: 1,
    repository: { id: 'fixture/consumer', name: 'Consumer' }, nodes: [], dependencies: [],
    context: { providers: [{ node: 'repo', provider: identity.provider,
      protocol: identity.protocol, environment: identity.environment }] } }));
  return root;
}

function capture(root, locator) {
  return captureOperationContext(root, { identity, source: { tool: 'fixture-client' },
    basis: 'observed', outcome: 'success', complete: true,
    evidence: [{ path: `${fixtureEvidencePath()}/evidence.json`, locator }] }, { internal: true });
}

test('AH-1: direct operation capture refuses workstation evidence locators before recording', t => {
  const root = fixture(t);
  assert.throws(() => capture(root, workstationLocator), error => {
    assert.equal(error.code, 'CONTEXT_EVIDENCE_INVALID');
    assert.match(error.message, /workstation/);
    assert.ok(!error.message.includes(workstationLocator));
    return true;
  });
  assert.equal(existsSync(join(root, LAYOUT.context)), false);
  assert.equal(capture(root, '/response/literal~0tilde~1slash').state, 'captured');
});

test('AH-1: an observation lesson refuses a retained workstation locator without rewriting the source record', t => {
  const root = fixture(t), receipt = capture(root, '/response');
  const path = join(root, LAYOUT.context), context = JSON.parse(readFileSync(path, 'utf8'));
  // Simulate an existing record from a client predating locator promotion checks.
  // Its immutable source must be preserved instead of copied into a new lesson.
  context.api_context.operations[receipt.operation_id].observations[0].evidence[0].locator = workstationLocator;
  const before = JSON.stringify(context, null, 2) + '\n';
  writeFileSync(path, before);
  assert.throws(() => recordGraphContext(root, { observation_id: receipt.observation_id,
    note: 'The health response shape is scoped to the fixture provider.' }), error => {
    assert.equal(error.code, 'CONTEXT_EVIDENCE_INVALID');
    const failure = graphRecordFailure(error);
    assert.equal(failure.error.code, 'CONTEXT_EVIDENCE_INVALID');
    assert.equal(failure.requests_executed, 0);
    assert.ok(!JSON.stringify(failure).includes(workstationLocator));
    return true;
  });
  assert.equal(readFileSync(path, 'utf8'), before);
});
