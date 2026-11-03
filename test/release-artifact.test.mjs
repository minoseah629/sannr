import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stagePackage } from '../scripts/stage-package.mjs';
import { verifyReleaseArtifact } from '../scripts/verify-release-artifact.mjs';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (root, command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function fixture(t) {
  const scratch = mkdtempSync(join(tmpdir(), 'release-artifact-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const root = stagePackage(ROOT, join(scratch, 'source'));
  run(root, 'git', ['init', '-q']); run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'Package fixture']);
  const commit = run(root, 'git', ['rev-parse', 'HEAD']).trim();
  const packed = JSON.parse(run(root, 'npm', ['pack', '--offline', '--json', '--pack-destination', scratch]));
  const archive = join(scratch, packed[0].filename), sha256 = digest(archive);
  const checksums = join(scratch, 'SHA256SUMS');
  writeFileSync(checksums, `${sha256}  ${packed[0].filename}\n`);
  return { scratch, root, archive, sha256, commit, checksums };
}
test('release artifact verifier binds approved bytes to the exact clean source commit', t => {
  const input = fixture(t), receipt = verifyReleaseArtifact(input);
  assert.equal(receipt.sha256, input.sha256);
  assert.equal(receipt.source_commit, input.commit);
  assert.equal(receipt.tracked_source_dirty, false);
  assert.ok(receipt.verified_source_files > 50);
  assert.match(receipt.build_id, /^[a-f0-9-]{36}$/);
});
test('release artifact verifier rejects changed approvals and unsafe checksum asset paths', t => {
  const input = fixture(t);
  for (const changed of [{ sha256: '0'.repeat(64) }, { commit: '0'.repeat(40) }, { commit: 'main' }])
    assert.throws(() => verifyReleaseArtifact({ ...input, ...changed }), /approved|Approved/);
  writeFileSync(input.checksums, `${input.sha256}  ../private.tgz\n`);
  assert.throws(() => verifyReleaseArtifact(input), /unbounded asset name/);
});
test('release artifact verifier rejects changed source bytes even with a matching approved digest', t => {
  const input = fixture(t), unpacked = join(input.scratch, 'unpacked'); mkdirSync(unpacked);
  run(input.root, 'tar', ['xzf', input.archive, '-C', unpacked]);
  writeFileSync(join(unpacked, 'package/lib/client.mjs'), '// Tampered fixture\n');
  const changed = join(input.scratch, 'changed.tgz');
  run(input.root, 'tar', ['czf', changed, '-C', unpacked, ...run(input.root, 'tar', ['tzf', input.archive]).trim().split('\n').filter(path => path !== 'package/lib/client.mjs' || !changed.endsWith('incomplete.tgz'))]);
  assert.throws(() => verifyReleaseArtifact({ ...input, archive: changed, sha256: digest(changed), checksums: undefined }), /source bytes differ/);
});
test('release artifact verifier rejects missing source files and tracked local edits', t => {
  const input = fixture(t), unpacked = join(input.scratch, 'unpacked'); mkdirSync(unpacked);
  run(input.root, 'tar', ['xzf', input.archive, '-C', unpacked]);
  rmSync(join(unpacked, 'package/lib/client.mjs'));
  const changed = join(input.scratch, 'incomplete.tgz');
  run(input.root, 'tar', ['czf', changed, '-C', unpacked, ...run(input.root, 'tar', ['tzf', input.archive]).trim().split('\n').filter(path => path !== 'package/lib/client.mjs' || !changed.endsWith('incomplete.tgz'))]);
  assert.throws(() => verifyReleaseArtifact({ ...input, archive: changed, sha256: digest(changed), checksums: undefined }), /omits/);
  writeFileSync(join(input.root, 'README.md'), 'Changed tracked fixture\n');
  assert.throws(() => verifyReleaseArtifact(input), /source is dirty/);
});
