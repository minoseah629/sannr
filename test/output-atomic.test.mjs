// MAP-1C fix round 1 (B3): evidence run files are written atomically. The
// bytes go to an exclusively created temporary file in the same directory and
// are renamed into place, so a reader never sees a run file half written. The
// temporary file keeps writeOutputFile's link and descriptor protections.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
  symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as outputPath from '../lib/output-path.mjs';
import { RUN_ID } from '../lib/key-sources.mjs';

const atomic = () => {
  assert.equal(typeof outputPath.writeOutputFileAtomic, 'function', 'lib/output-path.mjs exports writeOutputFileAtomic');
  return outputPath.writeOutputFileAtomic;
};
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'map1c-atomic-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'evidence');
  mkdirSync(dir);
  return { root, dir };
}
// Observe the destination at the moment the bytes are written.
function duringWrite(target, fn) {
  const original = fs.writeFileSync, seen = [];
  fs.writeFileSync = function (file, ...rest) {
    seen.push({ exists: existsSync(target), bytes: existsSync(target) ? readFileSync(target, 'utf8') : null });
    return original.call(this, file, ...rest);
  };
  syncBuiltinESMExports();
  try { fn(); } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  return seen;
}

test('MAP-1C B3 a run file appears under its final name only once it is complete', t => {
  const f = scratch(t), write = atomic(), target = join(f.dir, 'run-0f1e2d3c.json');
  const created = duringWrite(target, () => write(target, '{"complete":true}', { mode: 0o600 }));
  assert.equal(created.length, 1);
  assert.equal(created[0].exists, false, 'while the bytes were written, the final name did not exist');
  assert.equal(readFileSync(target, 'utf8'), '{"complete":true}');
  if (process.platform !== 'win32') assert.equal(statSync(target).mode & 0o777, 0o600);
  // Replacing a file: readers see the old complete bytes until the rename.
  const replaced = duringWrite(target, () => write(target, '{"complete":"again"}', { mode: 0o600 }));
  assert.deepEqual(replaced, [{ exists: true, bytes: '{"complete":true}' }]);
  assert.equal(readFileSync(target, 'utf8'), '{"complete":"again"}');
  assert.deepEqual(readdirSync(f.dir), ['run-0f1e2d3c.json'], 'no temporary file is left behind');
});

test('MAP-1C B3 the temporary name is covered by the evidence ignore rule and is never a run id', t => {
  const f = scratch(t), write = atomic(), target = join(f.dir, 'run-0f1e2d3c.json');
  const names = [];
  const original = fs.renameSync;
  fs.renameSync = function (from, to) { names.push(from.slice(f.dir.length + 1)); return original.call(this, from, to); };
  syncBuiltinESMExports();
  try { write(target, '{}', { mode: 0o600 }); } finally { fs.renameSync = original; syncBuiltinESMExports(); }
  assert.equal(names.length, 1);
  assert.match(names[0], /^run-.*\.json$/u, 'the evidence ignore rule run-*.json covers a leftover');
  assert.equal(RUN_ID.test(names[0].slice(0, -'.json'.length)), false, 'linking never lists it as a run');
});

test('MAP-1C B3 the atomic writer keeps the link and descriptor protections', t => {
  const f = scratch(t), write = atomic();
  const outside = join(f.root, 'outside.json');
  writeFileSync(outside, 'untouched');
  // A symlink at the destination is refused, never followed or replaced.
  symlinkSync(outside, join(f.dir, 'run-link.json'));
  assert.throws(() => write(join(f.dir, 'run-link.json'), 'x', { mode: 0o600 }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  // A hard-linked destination is refused.
  writeFileSync(join(f.dir, 'run-hard.json'), 'original');
  linkSync(join(f.dir, 'run-hard.json'), join(f.root, 'second-name.json'));
  assert.throws(() => write(join(f.dir, 'run-hard.json'), 'x', { mode: 0o600 }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(readFileSync(join(f.root, 'second-name.json'), 'utf8'), 'original');
  // A linked ancestor directory is refused.
  mkdirSync(join(f.root, 'real'));
  symlinkSync(join(f.root, 'real'), join(f.root, 'aliased'));
  assert.throws(() => write(join(f.root, 'aliased', 'run-a.json'), 'x', { mode: 0o600 }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.deepEqual(readdirSync(join(f.root, 'real')), []);
  // An existing entry at the temporary name is refused unopened and left as it was.
  symlinkSync(outside, join(f.dir, 'run-planted.tmp.json'));
  assert.throws(() => write(join(f.dir, 'run-b.json'), 'x', { mode: 0o600, tempName: 'run-planted.tmp.json' }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(readFileSync(outside, 'utf8'), 'untouched');
  assert.equal(fs.lstatSync(join(f.dir, 'run-planted.tmp.json')).isSymbolicLink(), true, 'the planted entry is not removed');
  writeFileSync(join(f.dir, 'run-held.tmp.json'), 'someone else');
  assert.throws(() => write(join(f.dir, 'run-c.json'), 'x', { mode: 0o600, tempName: 'run-held.tmp.json' }), { code: 'OUTPUT_UNSAFE_PATH' });
  assert.equal(readFileSync(join(f.dir, 'run-held.tmp.json'), 'utf8'), 'someone else');
  assert.equal(existsSync(join(f.dir, 'run-b.json')) || existsSync(join(f.dir, 'run-c.json')), false, 'nothing was written');
});

test('MAP-1C B3 a failed write leaves no temporary file and the old run file intact', t => {
  const f = scratch(t), write = atomic(), target = join(f.dir, 'run-0f1e2d3c.json');
  write(target, '{"old":1}', { mode: 0o600 });
  const original = fs.writeFileSync;
  fs.writeFileSync = function () { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  syncBuiltinESMExports();
  try { assert.throws(() => write(target, '{"new":1}', { mode: 0o600 }), { code: 'ENOSPC' }); }
  finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal(readFileSync(target, 'utf8'), '{"old":1}');
  assert.deepEqual(readdirSync(f.dir), ['run-0f1e2d3c.json']);
});
