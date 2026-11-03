import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { importBrunoDirectory, renderImportReport } from '../lib/import.mjs';
import { flattenPostmanCaptureDir } from '../lib/postman-workspace.mjs';
const fixtures = new URL('./fixtures/robustness/', import.meta.url);
const shapes = JSON.parse(readFileSync(new URL('directory-shapes.json', fixtures), 'utf8'));
const temporary = (t) => { const root = mkdtempSync(join(tmpdir(), 'sannr-rob-directory-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const named = (code) => (error) => error.constructor === Error && error.code === code;
for (const [name, code] of [['capture-malformed-field.json', 'POSTMAN_CAPTURE_INVALID'], ['capture-invalid-json.txt', 'POSTMAN_CAPTURE_JSON_INVALID']]) {
  test(`ROB-1 ${name} is a named, input-free refusal`, (t) => {
    const root = temporary(t);
    writeFileSync(join(root, 'capture.json'), readFileSync(new URL(name, fixtures)));
    assert.throws(() => flattenPostmanCaptureDir(root), (error) => {
      assert.equal(error.constructor, Error);
      assert.equal(error.code, code);
      assert.ok(!error.message.includes('ROB_CAPTURE_PRIVATE_VALUE'));
      return true;
    });
  });
}
for (const [entry, invoke] of [['Bruno', importBrunoDirectory], ['Postman capture', flattenPostmanCaptureDir]]) {
  test(`ROB-1 ${entry} refuses a symbolic link cycle before reading`, (t) => {
    const root = temporary(t);
    writeFileSync(join(root, 'capture.json'), JSON.stringify(shapes.capture));
    symlinkSync(root, join(root, 'cycle'));
    assert.throws(() => invoke(root), named('IMPORT_DIRECTORY_SYMLINK'));
  });
}
test('ROB-1 a .bru directory is refused as a file-shape error', (t) => {
  const root = temporary(t);
  mkdirSync(join(root, 'request.bru'));
  assert.throws(() => importBrunoDirectory(root), named('IMPORT_DIRECTORY_FILE_EXPECTED'));
});
test('ROB-1 partial Bruno directory without bruno.json still renders', (t) => {
  const root = temporary(t);
  writeFileSync(join(root, 'health.bru'), shapes.request);
  const result = importBrunoDirectory(root);
  assert.equal(result.suite.requests.length, 1);
  assert.equal(typeof renderImportReport(result.report), 'string');
});
test('ROB-1 CLI reads a Bruno directory as a directory', (t) => {
  const root = temporary(t);
  writeFileSync(join(root, 'health.bru'), shapes.request);
  const cli = spawnSync(process.execPath, [resolve('bin/cli.mjs'), 'import', root, '--dry-run'], { cwd: root, encoding: 'utf8', timeout: 2000 });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /dry run/);
});
test('ROB-1 CLI workspace JSON parse failure never prints input or a stack', (t) => {
  const root = temporary(t);
  writeFileSync(join(root, 'capture.json'), readFileSync(new URL('capture-invalid-json.txt', fixtures)));
  const cli = spawnSync(process.execPath, [resolve('bin/cli.mjs'), 'import', 'workspace', root, '--dry-run', '--out', 'out'], { cwd: root, encoding: 'utf8', timeout: 2000 });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /POSTMAN_CAPTURE_JSON_INVALID/);
  assert.doesNotMatch(cli.stdout + cli.stderr, /ROB_CAPTURE_PRIVATE_VALUE|\n\s+at |SyntaxError|TypeError|RangeError/);
});
