import { LAYOUT } from './layout.mjs';
// Materialize a configured local Git/CI artifact. This does not publish it,
// copy evidence payloads, or ask an agent to repeat an already saved lesson.
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { CONTEXT_BASENAME } from './brand.mjs';
import { withContextLock } from './context.mjs';
import { activeStackScopeFor } from './stack-scope.mjs';
import { buildGraphCatalog } from './dependency-graph.mjs';
import { exportGraphSnapshot } from './graph-export.mjs';
import { resolveOutputPath, safeOutputPath, writeOutputFile } from './output-path.mjs';

const FAILURE_CODES = new Set(['GRAPH_SNAPSHOT_DESTINATION_REFUSED', 'GRAPH_SNAPSHOT_DESTINATION_CHANGED',
  'GRAPH_SNAPSHOT_CONFIGURATION_CHANGED', 'GRAPH_SNAPSHOT_TOO_LARGE', 'CONTEXT_WRITE_LOCKED']);
const fail = code => { throw Object.assign(new Error('The configured snapshot could not be updated.'), { code }); };
const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const MANIFEST = LAYOUT.graphManifest;

function snapshotDestination(root, path, manifestPath, allowOutside) {
  const target = resolve(path), manifest = resolve(root, manifestPath);
  // These names are never snapshot destinations, even before a knowledge file
  // exists or when its bytes happen to look like a graph snapshot. Protect the
  // selected custom manifest as well as the conventional manifest basename.
  if ([CONTEXT_BASENAME, basename(MANIFEST)].some(name => basename(target).toLowerCase() === name.toLowerCase())
    || target.toLowerCase() === manifest.toLowerCase())
    fail('GRAPH_SNAPSHOT_DESTINATION_REFUSED');
  // The output guard allows OS-owned temporary-directory aliases. Compare
  // existing identities first: an alias of the manifest is unconditionally
  // protected, not an outside-project destination the allow flag can authorize.
  try {
    if (realpathSync(target).toLowerCase() === realpathSync(manifest).toLowerCase())
      fail('GRAPH_SNAPSHOT_DESTINATION_REFUSED');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  resolveOutputPath(root, target, { allowOutside, code: 'GRAPH_SNAPSHOT_DESTINATION_REFUSED' });
  return target;
}

function destination(path, publisher) {
  safeOutputPath(path, { code: 'GRAPH_SNAPSHOT_DESTINATION_REFUSED' });
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024) fail('GRAPH_SNAPSHOT_DESTINATION_REFUSED');
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const n = readSync(fd, bytes, count, bytes.length - count, null);
      if (!n) break;
      count += n;
    }
    if (count !== stat.size) fail('GRAPH_SNAPSHOT_DESTINATION_CHANGED');
    let catalog;
    try { catalog = buildGraphCatalog([JSON.parse(bytes.subarray(0, count).toString('utf8'))]); }
    catch { fail('GRAPH_SNAPSHOT_DESTINATION_REFUSED'); }
    if (catalog.repositories[0]?.id !== publisher) fail('GRAPH_SNAPSHOT_DESTINATION_REFUSED');
    return { digest: digest(bytes.subarray(0, count)), mode: stat.mode & 0o777, inode: stat.ino, device: stat.dev };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
}

// CLI exports and configured publication share the same guard, ownership check,
// lock and atomic replacement. No caller can opt into replacing unrelated data.
export function writeGraphSnapshot(root, path, createSnapshot, { manifestPath = MANIFEST, allowOutside = false } = {}) {
  let temporary;
  try {
    return withContextLock(root, () => {
      const target = snapshotDestination(root, path, manifestPath, allowOutside);
      const snapshot = createSnapshot();
      const before = destination(target, snapshot.repository.id);
      const bytes = `${JSON.stringify(snapshot, null, 2)}\n`;
      if (Buffer.byteLength(bytes) > 4 * 1024 * 1024) fail('GRAPH_SNAPSHOT_TOO_LARGE');
      mkdirSync(dirname(target), { recursive: true });
      temporary = `${target}.tmp-${randomUUID()}`;
      writeOutputFile(temporary, bytes, { mode: before?.mode ?? 0o600 });
      const after = destination(target, snapshot.repository.id);
      if (JSON.stringify(before) !== JSON.stringify(after)) fail('GRAPH_SNAPSHOT_DESTINATION_CHANGED');
      safeOutputPath(temporary); snapshotDestination(root, target, manifestPath, allowOutside);
      renameSync(temporary, target); temporary = undefined;
      return { snapshot, path: target, digest: digest(bytes) };
    });
  } finally { if (temporary) try { unlinkSync(temporary); } catch { /* preserve the original result */ } }
}

export function materializeRecordedSnapshot(root, readManifest, receipt) {
  try {
    const manifest = readManifest();
    if (!manifest.context?.snapshot) return { state: 'not_configured' };
    // Stack sharing is a later surface. The legacy exporter reads the old
    // single store; using it here would replace a valid repository snapshot
    // with an empty projection after migration. Keep that artifact intact.
    if (activeStackScopeFor(root)) return { state: 'deferred', code: 'STACK_GRAPH_EXPORT_DEFERRED',
      lesson_saved: true, record_included: false, evidence_payloads_copied: false, published: false,
      next: 'The lesson is saved in this API stack. Cross-repository stack export is not supported yet; the existing graph snapshot was preserved.' };
    // Every context writer uses this same lock. Read the latest saved context
    // only after acquiring it, so concurrent recording cannot publish an older
    // snapshot over a newer one. This second phase never adds another lesson.
    const path = manifest.context.snapshot;
    const result = writeGraphSnapshot(root, join(root, path), () => {
      const current = readManifest();
      if (JSON.stringify(current) !== JSON.stringify(manifest) || current.repository.id !== receipt.publisher)
        fail('GRAPH_SNAPSHOT_CONFIGURATION_CHANGED');
      const snapshot = exportGraphSnapshot(root);
      if (snapshot.repository.id !== receipt.publisher || JSON.stringify(readManifest()) !== JSON.stringify(current))
        fail('GRAPH_SNAPSHOT_CONFIGURATION_CHANGED');
      return snapshot;
    });
    const recordId = `api_context/operations/${receipt.operation_id}/observations/${receipt.observation_id}`;
    const included = result.snapshot.knowledge.some(item => item.source.record_id === recordId);
    return { state: included ? 'written' : 'limited', path, digest: result.digest, record_included: included,
      evidence_payloads_copied: false, published: false,
      next: included ? 'The local snapshot is ready for the configured Git/CI sharing workflow; remote delivery has not occurred.'
        : 'The snapshot was written but export bounds or bindings omitted this lesson. Inspect export omissions before claiming the lesson was handed off.' };
  } catch (error) {
    return { state: 'failed', code: FAILURE_CODES.has(error.code) ? error.code : 'GRAPH_SNAPSHOT_WRITE_FAILED',
      lesson_saved: true, published: false,
      next: 'The lesson is saved locally. Inspect the configured context.snapshot destination and export omissions. Preserve unrelated or linked files. Retry graph export --out with the corrected destination; do not record the lesson again merely to retry sharing.' };
  }
}
