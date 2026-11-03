import { LAYOUT } from "../lib/layout.mjs";
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphContext, readGraphUsage } from '../lib/agent-graph-context.mjs';
import { PRODUCT } from '../lib/brand.mjs';

const CAP = 1024 * 1024;
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-usage-cap-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.API_CONTEXT_OFF;
  delete process.env.API_CONTEXT_OFF;
  t.after(() => {
    if (previous === undefined) delete process.env.API_CONTEXT_OFF;
    else process.env.API_CONTEXT_OFF = previous;
  });
  writeFileSync(join(root, LAYOUT.graphManifest), JSON.stringify({
    v: 1, repository: { id: 'fixture', name: 'Fixture' }, metrics: true,
  }));
  return root;
}

test('AH-1 graph usage caps delivery at the boundary and repairs oversized preexisting logs', async t => {
  const root = fixture(t), path = join(root, `${LAYOUT.evidence}/graph/usage.jsonl`);
  await graphContext(root);
  const row = readFileSync(path, 'utf8');
  // Seed the state immediately before the meaningful write instead of spending
  // thousands of graph deliveries reaching the same byte-cap boundary.
  for (const rows of [Math.floor(CAP / Buffer.byteLength(row)), Math.ceil(CAP / Buffer.byteLength(row)) + 1]) {
    writeFileSync(path, row.repeat(rows));
    assert.equal((await graphContext(root)).ok, true);
    assert.ok(statSync(path).size <= CAP, 'delivery must bound the persisted log, not only its reader');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    assert.ok(lines.length < rows + 1, 'retention must discard older delivery counts');
    for (const line of lines) assert.equal(JSON.parse(line).action, 'overview');
    const report = readGraphUsage(root);
    assert.equal(report.invalid_rows, 0);
    assert.equal(report.recorded_events, lines.length);
    assert.match(report.meaning, /retained/i);
  }
});

test('AH-1 graph usage preserves private file permissions when appending to an existing log',
  { skip: process.platform === 'win32' ? 'POSIX file mode bits are unavailable on Windows.' : false }, async t => {
    const root = fixture(t), path = join(root, `${LAYOUT.evidence}/graph/usage.jsonl`);
    assert.equal((await graphContext(root)).ok, true);
    chmodSync(path, 0o644);
    assert.equal((await graphContext(root)).ok, true);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readGraphUsage(root).recorded_events, 2);
  });


test('AH-1 graph context public error codes are an explicit allowlist', async t => {
  const root = fixture(t), open = fs.openSync;
  try {
    fs.openSync = () => { throw Object.assign(new Error('Fixture detail must stay private.'), { code: 'GRAPH_UNCURATED_FIXTURE' }); };
    syncBuiltinESMExports();
    const result = await graphContext(root);
    assert.equal(result.issues[0].code, 'GRAPH_CONTEXT_UNAVAILABLE');
    assert.doesNotMatch(JSON.stringify(result), /GRAPH_UNCURATED_FIXTURE|Fixture detail/);
  } finally { fs.openSync = open; syncBuiltinESMExports(); }
});
