import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { BIN_NAME } from '../lib/brand.mjs';
import { LAYOUT, LEGACY_LAYOUT } from '../lib/layout.mjs';
import { withStackScope } from '../lib/stack-scope.mjs';
import { stacksMigrationRequired, stacksMigrationCapture, assertStacksWritable } from '../lib/stack-migration-state.mjs';

const project = t => { const root = mkdtempSync(join(tmpdir(), 'stack-migration-state-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const write = (root, file, body = '{}') => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), body); };
const scope = root => ({ root, stack: 'billing', contextFile: `${LAYOUT.collection}/billing/sannr.json`, evidenceDir: `${LAYOUT.evidence}/billing`, config: {} });
const assertRequired = root => {
  const refusal = stacksMigrationRequired(root);
  assert.equal(refusal.code, 'STACKS_MIGRATION_REQUIRED');
  assert.equal(refusal.command, `${BIN_NAME} migrate --dry-run`);
  assert.equal(stacksMigrationCapture(root).state, 'skipped');
  assert.throws(() => assertStacksWritable(root), error => error.code === refusal.code && error.next === refusal.command);
};

test('empty managed folders and a layout marker do not invent a legacy install', t => {
  const root = project(t);
  mkdirSync(join(root, LAYOUT.config), { recursive: true });
  write(root, LAYOUT.marker, JSON.stringify({ kind: 'repo-api-layout', v: 1, product: BIN_NAME, collection: 'stacks' }));
  assert.equal(stacksMigrationRequired(root), null);
  assert.equal(stacksMigrationCapture(root), null);
  assert.doesNotThrow(() => assertStacksWritable(root));
});

test('current single-store or configuration files each require migration', t => {
  for (const file of [LAYOUT.context, LAYOUT.environments]) { const root = project(t); write(root, file); assertRequired(root); }
});

test('recognized pre-layout root store and both environment filenames require migration', t => {
  for (const file of [LEGACY_LAYOUT.context, LEGACY_LAYOUT.environments, LEGACY_LAYOUT.hiddenEnvironments]) {
    const root = project(t); write(root, file); assertRequired(root);
  }
});

test('marker-declared earlier collection and product stores require migration', t => {
  const root = project(t);
  write(root, '.fixture-previous/layout.json', JSON.stringify({ kind: 'repo-api-layout', v: 1, product: 'fixture-previous', collection: 'knowledge' }));
  write(root, '.fixture-previous/knowledge/fixture-previous.json');
  assertRequired(root);
});

test('only an explicit stack in this repo exempts a remaining legacy file', t => {
  const root = project(t), other = project(t); write(root, LAYOUT.context);
  withStackScope(scope(other), () => assertRequired(root));
  withStackScope(scope(root), () => {
    assert.equal(stacksMigrationRequired(root), null);
    assert.doesNotThrow(() => assertStacksWritable(root));
  });
});

test('a canonical alias of the selected stack repo preserves the exemption', t => {
  const root = project(t), aliases = project(t), alias = join(aliases, 'repo');
  write(root, LAYOUT.context); symlinkSync(root, alias, 'dir');
  withStackScope(scope(alias), () => assert.equal(stacksMigrationRequired(root), null));
});

test('legacy capture CLI diagnostics preserve the named migration command without reflecting error text', async () => {
  const { contextCommandError } = await import('../lib/context-errors.mjs');
  const result = contextCommandError({ code: 'STACKS_MIGRATION_REQUIRED', message: 'private synthetic detail' });
  assert.equal(result.code, 'STACKS_MIGRATION_REQUIRED');
  assert.equal(result.next, `${BIN_NAME} migrate --dry-run`);
  assert.doesNotMatch(JSON.stringify(result), /private synthetic/);
});
