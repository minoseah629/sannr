// Bind an approved tarball to both its exact digest and the tagged source bytes.
// This never repacks, extracts into the checkout, publishes, or repairs inputs.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args, root) => execFileSync(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
export function verifyReleaseArtifact({ archive, sha256, commit, checksums, root = ROOT }) {
  if (!/^[a-f0-9]{64}$/.test(sha256 ?? '') || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Approved SHA-256 and full source commit are required.');
  archive = resolve(archive);
  const actual = createHash('sha256').update(readFileSync(archive)).digest('hex');
  if (actual !== sha256) throw new Error('Artifact digest differs from the approved SHA-256.');
  if (run('git', ['rev-parse', 'HEAD'], root).toString().trim() !== commit) throw new Error('Checked-out tag differs from the approved source commit.');
  if (run('git', ['status', '--porcelain', '--untracked-files=no'], root).toString().trim()) throw new Error('Tracked source is dirty; release verification requires the approved commit.');
  if (checksums) {
    const lines = readFileSync(checksums, 'utf8').trim().split('\n');
    const records = lines.map(line => /^([a-f0-9]{64})  ([A-Za-z0-9._+-]+\.(?:tgz|zip))$/.exec(line));
    if (records.some(row => !row)) throw new Error('Checksum file contains an invalid or unbounded asset name.');
    const matching = records.filter(row => row[2] === basename(archive));
    if (matching.length !== 1 || matching[0][1] !== sha256) throw new Error('Release checksum does not identify the approved tarball exactly once.');
  }
  run(process.execPath, [resolve(ROOT, 'scripts/verify-package.mjs'), archive], root);
  const entries = run('tar', ['tzf', archive], root).toString().trim().split('\n').filter(path => !path.endsWith('/'));
  const pack = JSON.parse(run('npm', ['pack', '--dry-run', '--ignore-scripts', '--offline', '--json'], root));
  if (pack.length !== 1) throw new Error('Expected exactly one package source inventory.');
  const expected = new Set(pack[0].files.map(row => `package/${row.path}`).filter(path => path !== 'package/lib/build-info.json'));
  let verified = 0, build;
  for (const entry of entries) {
    const bytes = run('tar', ['xOf', archive, entry], root);
    if (entry === 'package/lib/build-info.json') {
      build = JSON.parse(bytes);
      if (Object.keys(build).length !== 1 || !/^[a-f0-9-]{36}$/.test(build.buildId ?? '')) throw new Error('Generated build identity is malformed.');
      continue;
    }
    if (!expected.delete(entry)) throw new Error(`Unexpected packed source file: ${entry}`);
    const source = run('git', ['show', `${commit}:${entry.slice('package/'.length)}`], root);
    if (!bytes.equals(source)) throw new Error(`Packed source bytes differ from the approved commit: ${entry}`);
    verified += 1;
  }
  if (!build || expected.size) throw new Error('Artifact omits the generated build identity or approved source files.');
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  return { schema_version: 1, package: pkg.name, version: pkg.version, source_commit: commit,
    tracked_source_dirty: false, sha256, build_id: build.buildId, verified_source_files: verified,
    generated_identity: 'build-info.json contains a generated UUID; all other packaged bytes match source_commit.',
    publication: 'Not performed by this verifier.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [archive, sha256, commit, checksums] = process.argv.slice(2);
    if (process.argv.length < 5 || process.argv.length > 6) throw new Error('Usage: node scripts/verify-release-artifact.mjs <archive.tgz> <approved-sha256> <approved-commit> [SHA256SUMS]');
    console.log(JSON.stringify(verifyReleaseArtifact({ archive, sha256, commit, checksums }), null, 2));
  } catch (error) { console.error(`Release artifact verification failed: ${error.message}`); process.exitCode = 1; }
}
