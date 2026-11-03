import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// Whole tracked-file inventory, independent of extension, directory or operator
// name. Portable system paths and API routes are not workstation identities.
const MACHINE_PATH = /\/(?:Users|home|Volumes|(?:private\/)?(?:tmp|var\/folders))\/[^\s'"`<>/]+|(?<![A-Za-z/])[A-Za-z]:(?:\\+|\/(?!\/))[^\s'"`<>]+/i;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

// Screenshots are tracked evidence, not UTF-8 source. Skip only compressed
// raster payload after checking PNG framing and every chunk's CRC. Metadata and
// other bytes retain the existing scan; malformed images are scanned whole.
function trackedText(bytes) {
  const raw = () => bytes.toString('utf8');
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return raw();
  const parts = [PNG_SIGNATURE];
  let offset = 8, sawData = false, closedData = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset), end = offset + length + 12;
    if (end > bytes.length) return raw();
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return raw();
    if (offset === 8 ? type !== 'IHDR' || length !== 13 : type === 'IHDR') return raw();
    if (type === 'IDAT') {
      if (closedData) return raw();
      sawData = true;
      parts.push(bytes.subarray(offset, offset + 8), Buffer.from('\n'), bytes.subarray(end - 4, end));
    } else {
      if (sawData) closedData = true;
      parts.push(bytes.subarray(offset, end));
    }
    if (type === 'IEND') return length === 0 && sawData && end === bytes.length ? Buffer.concat(parts).toString('utf8') : raw();
    offset = end;
  }
  return raw();
}

// Three publication receipts from 2026-09-22 are immutable: BUILD_STATUS.json and
// later snapshots pin their digests, so the four workstation artifact locators
// they carry cannot be reworded without breaking that chain. Each file is pinned
// whole and exactly the pinned number of locators is masked; everything else in
// them is scanned like any other tracked file. The locator shape is composed at
// runtime so this file never carries a workstation path itself.
const HISTORICAL_LOCATOR = new RegExp(['', 'Users', '[^/"\\s]+', 'work', '[^/"\\s]+', 'briefs', ''].join('/'), 'g');
const HISTORICAL_RECEIPTS = new Map([
  ['reports/build-status/2026-09-22T010309Z.json', { sha256: '09b0ab269db445a7383c45c3507d0a9b155954451c47e3622cd5df9b4149a80c', occurrences: 1 }],
  ['reports/build-status/2026-09-22T175757Z.json', { sha256: 'b00eabf69bf6e81ac83ba82a8e2a2ebcee43c6f4c7bdb98352b463b91c028a97', occurrences: 2 }],
  ['reports/build-status/2026-09-22T190336Z.json', { sha256: '353003a738d13a2a2e83bb2ed6fa7a19840f21ca0404186191dc431ff0821844', occurrences: 1 }],
]);

// A serialized UNC root has twice the backslashes of its component separator
// (or a literal forward separator). This distinguishes roots from regexp and
// escaped newline sequences without exempting any source directory.
function containsUnc(text, file) {
  const minimumRoot = /\.(?:[cm]?js|json|jsonl)$/i.test(file) ? 4 : 2;
  const unc = /(?<![A-Za-z0-9_\\])(\\{2,})(?:\?\\+(?:UNC\\+)?)?[A-Za-z][\w.-]*(\\+|\/)[A-Za-z][\w.-]*/g;
  return [...text.matchAll(unc)].some(([, root, separator]) => root.length >= minimumRoot && (separator === '/' || root.length === separator.length * 2))
    || [...text.matchAll(/(?<![A-Za-z0-9_\\])(\\{2,})[A-Za-z][\w.-]*(?=['"`]|$)/g)].some(([, root]) => root.length >= minimumRoot);
}

function machinePaths(root) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  return files.flatMap(file => {
    if (!existsSync(join(root, file))) return []; // staged deletions are absent from the next tree
    let text = trackedText(readFileSync(join(root, file)));
    // One historical path specimen is immutable under the work order. Pin its
    // entire archive and mask only that exact occurrence; everything else is scanned.
    if (file === 'BACKLOG.md') {
      const start = text.indexOf('\n# 📁 PREREGISTRATION ARCHIVE —');
      assert.ok(start >= 0, 'preregistration archive heading is present');
      const archive = text.slice(start + 1);
      assert.equal(createHash('sha256').update(archive).digest('hex'),
        'e0ac34b1d1be4f7cc4228479a661acfe96dd3f9ab10a41c6c1bc17e506ef28a9');
      const historical = ['C:', 'Users', 'sterl', '...'].join('/');
      assert.equal(archive.split(historical).length, 2);
      text = text.slice(0, start + 1) + archive.replace(historical, '[immutable historical path specimen]');
    }
    if (HISTORICAL_RECEIPTS.has(file)) {
      const { sha256, occurrences } = HISTORICAL_RECEIPTS.get(file);
      assert.equal(createHash('sha256').update(text).digest('hex'), sha256, `${file} is an immutable publication receipt`);
      assert.equal((text.match(HISTORICAL_LOCATOR) ?? []).length, occurrences, `${file} carries exactly its pinned historical locators`);
      text = text.replace(HISTORICAL_LOCATOR, '[immutable historical artifact locator]/');
    }
    return text.split('\n').flatMap((line, index) => {
      // Registry URLs can contain directory names such as the tmp package.
      const local = line.replace(/https?:\/\/[^\s'"`<>]+/g, '');
      return (MACHINE_PATH.test(local) || containsUnc(local, file)) ? [`${file}:${index + 1}`] : [];
    });
  });
}

test('AH-5 tracked files contain no machine absolute paths', () => {
  assert.deepEqual(machinePaths(ROOT), [], 'use portable artifact references and compose synthetic fixture paths');
});

test('AH-5 tracked-file guard catches another machine in a newly tracked file', t => {
  const root = mkdtempSync(join(tmpdir(), 'tracked-hygiene-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const body of [
    ['', 'Users', 'other-operator', 'project'].join('/'),
    ['', 'home', 'other-operator', 'project'].join('/'),
    ['', 'private', 'tmp', 'other-project'].join('/'),
    ['Q:', 'other-operator', 'project'].join('\\'),
    ['\\', 'other-machine', 'share', 'project'].join('\\'),
  ]) {
    writeFileSync(join(root, 'new-surface.data'), body);
    execFileSync('git', ['add', 'new-surface.data'], { cwd: root });
    assert.deepEqual(machinePaths(root), ['new-surface.data:1']);
  }
  rmSync(join(root, 'new-surface.data'));
  const unc = ['\\', 'another-machine', 'share', 'project'].join('\\');
  for (const file of ['new-source.mjs', 'new-data.json']) {
    writeFileSync(join(root, file), JSON.stringify(unc));
    execFileSync('git', ['add', file], { cwd: root });
    assert.deepEqual(machinePaths(root), [`${file}:1`]);
    rmSync(join(root, file));
  }
});

test('AH-5 PNG evidence scans metadata and malformed files without interpreting compressed pixels as text', t => {
  const root = mkdtempSync(join(tmpdir(), 'tracked-png-hygiene-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const file = 'new-surface.data', path = ['', 'Users', 'other-operator', 'project'].join('/');
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length); bytes.write(type, 4); data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13), width = Math.ceil(Buffer.byteLength(path) / 3);
  header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  // Stored deflate bytes happen to spell a path, but represent RGB pixels,
  // not text. The image is a valid one-row, 8-bit truecolor PNG.
  const pixels = Buffer.alloc(1 + width * 3); pixels.write(path, 1);
  const idat = chunk('IDAT', deflateSync(pixels, { level: 0 }));
  const image = metadata => Buffer.concat([PNG_SIGNATURE, chunk('IHDR', header), ...metadata, idat, chunk('IEND', Buffer.alloc(0))]);
  const check = bytes => {
    writeFileSync(join(root, file), bytes); execFileSync('git', ['add', file], { cwd: root });
    return machinePaths(root);
  };
  assert.deepEqual(check(image([])), [], 'verified PNG raster payload is not text, regardless of extension');
  assert.ok(check(image([chunk('tEXt', Buffer.from(`Comment\0${path}`))])).length, 'metadata is still scanned');
  const corrupt = image([]); corrupt[corrupt.length - 13] ^= 1;
  for (const bytes of [corrupt, image([]).subarray(0, -1), Buffer.concat([image([]), Buffer.from(path)])])
    assert.ok(check(bytes).length, 'bad CRC, truncation or trailing data restores the whole-file scan');
  assert.ok(check(Buffer.from(path)).length, 'non-PNG content still receives the whole-file scan');
});

test('AH-5 generated output is ignored', () => {
  const result = spawnSync('git', ['check-ignore', '--no-index', 'output/new-run/artifact.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, 'generated output must not appear as untracked source');
});

const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'],
  { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))[0].files.map(file => file.path);

test('AH-5 packed files contain no private decision-record references', () => {
  const privateReference = /\bADR[- #]*\d+|docs\/decisions\/|\bprivate decision record\b/i;
  assert.deepEqual(packed.filter(path => privateReference.test(readFileSync(join(ROOT, path), 'utf8'))), [],
    'explain the contract directly in public files');
});

test('AH-5 packed docs exclude the internal alpha PRD', () => {
  assert.ok(!packed.includes('docs/agent-first-alpha-prd.md'));
  assert.deepEqual(packed.filter(path => /\.md$/i.test(path)
    && /agent-first-alpha-prd\.md/.test(readFileSync(join(ROOT, path), 'utf8'))), [], 'public links must not name the omitted PRD');
});
