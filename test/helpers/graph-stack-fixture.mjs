// Graph export is a historical read-only projection until STACKS-2. Exercise
// captures through a real named stack, then save an explicit legacy snapshot
// for the older graph readers; never opt a writer out of migration guards.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileSync } from './layout-fixture.mjs';
import { createFixtureStack, fixtureContextFile, inFixtureStack } from './stack-fixture.mjs';
import { LAYOUT } from '../../lib/layout.mjs';
import { withContextLock } from '../../lib/context.mjs';
import { captureOperationContext } from '../../lib/operation-context.mjs';
import { recordGraphContext } from '../../lib/graph-record.mjs';
import { materializeRecordedSnapshot } from '../../lib/graph-snapshot-write.mjs';

export function prepareGraphStackFixture(root) {
  if (existsSync(join(root, LAYOUT.collection, 'fixture', 'stack.json'))) return;
  createFixtureStack(root);
  if (existsSync(join(root, LAYOUT.context)))
    writeFileSync(fixtureContextFile(root), readFileSync(join(root, LAYOUT.context)));
}

export function projectGraphStackFixture(root) {
  // Read the current atomic stack store only after taking the projection lock.
  // Concurrent fixture writers cannot publish an older captured generation.
  withContextLock(root, () => {
    writeFileSync(join(root, LAYOUT.context), readFileSync(fixtureContextFile(root)));
  });
}

export function captureGraphStackFixture(root, input, options) {
  prepareGraphStackFixture(root);
  const result = inFixtureStack(root, () => captureOperationContext(root, input, options));
  projectGraphStackFixture(root);
  return result;
}

export function recordGraphStackFixture(root, args) {
  prepareGraphStackFixture(root);
  const result = recordGraphContext(root, args);
  projectGraphStackFixture(root);
  if (result.snapshot?.code !== 'STACK_GRAPH_EXPORT_DEFERRED') return result;
  // This separately exercises the legacy artifact materializer, not a live
  // stack-sharing promise. The real receipt remains available to assert the
  // deferred boundary while retaining historical snapshot safety coverage.
  const snapshot = materializeRecordedSnapshot(root,
    () => JSON.parse(readFileSync(join(root, LAYOUT.graphManifest))), result);
  return { ...result, scoped_snapshot: result.snapshot, snapshot, next: snapshot.next };
}
