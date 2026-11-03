import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, readFileSync, writeFileSync, readdirSync, statSync, chmodSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceNotePointer } from '../lib/note-pointers.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'note-pointer-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'instructions.md');
  writeFileSync(file, 'original\n');
  return { root, file };
}

test('pointer refresh preserves permissions and replaces a complete file', t => {
  const { file, root } = fixture(t);
  chmodSync(file, 0o640);
  replaceNotePointer(file, 'updated\n', { expectedText: 'original\n' });
  assert.equal(readFileSync(file, 'utf8'), 'updated\n');
  assert.equal(statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(readdirSync(root), ['instructions.md']);
});

test('a concurrent instruction edit is preserved and the temporary refresh is removed', t => {
  const { file, root } = fixture(t);
  assert.throws(() => replaceNotePointer(file, 'updated\n', { expectedText: 'original\n',
    beforeCommit() { writeFileSync(file, 'teammate edit\n'); } }), { code: 'POINTER_WRITE_CONFLICT' });
  assert.equal(readFileSync(file, 'utf8'), 'teammate edit\n');
  assert.deepEqual(readdirSync(root), ['instructions.md']);
});

test('a failed commit guard never truncates original instructions', t => {
  const { file, root } = fixture(t);
  assert.throws(() => replaceNotePointer(file, 'updated\n', { expectedText: 'original\n',
    beforeCommit() { throw Object.assign(new Error('context changed'), { code: 'CONTEXT_WRITE_CONFLICT' }); } }), { code: 'CONTEXT_WRITE_CONFLICT' });
  assert.equal(readFileSync(file, 'utf8'), 'original\n');
  assert.deepEqual(readdirSync(root), ['instructions.md']);
});

test('linked instruction destinations cannot redirect a note refresh', t => {
  for (const linker of [symlinkSync, linkSync]) {
    const { file, root } = fixture(t);
    const linked = join(root, 'linked.md');
    linker(file, linked);
    assert.throws(() => replaceNotePointer(linked, 'updated\n', { expectedText: 'original\n' }), { code: 'POINTER_UNSAFE_PATH' });
    assert.equal(readFileSync(file, 'utf8'), 'original\n');
  }
});
