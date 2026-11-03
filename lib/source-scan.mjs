// One invocation owns one bounded source snapshot. Consumers share bytes and
// line offsets; none of this inventory is written to the repository or home.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readdirSync, openSync, lstatSync, statSync, fstatSync, readSync, closeSync, realpathSync, constants } from 'node:fs';
import { resolve, relative, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { serialize } from 'node:v8';
import { LAYOUT } from './layout.mjs';

const active = new AsyncLocalStorage();
const SKIP = new Set(['node_modules', '.git', 'venv', '.venv', 'dist', 'build', '.next',
  '__pycache__', 'coverage', 'vendor', 'target', 'evidence', '.turbo', 'site-packages']);
const FIXTURE = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|test-data|samples?|examples?|e2e|__tests__|spec\/support)(?:\/|$)/i;
const MAX_BYTES = 400_000;
const CONTRACT_FILE = /^(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const SCAN_INPUT = /\.(?:py|ts|js|mjs|tsx|jsx|rb|go|ya?ml|env|toml|json)$/i;
const inside = (root, file) => file === root || file.startsWith(`${root}${sep}`);
const portable = value => value.split(sep).join('/');

// Process-private reuse only. A fresh invocation still checks file identities;
// an earlier invocation keeps its own maps when another request invalidates a
// file. Source values never reach a persistent cache, repository or home.
const processes = new Map();
const MAX_ROOTS = 4, MAX_CACHE_BYTES = 64 * 1024 * 1024, MAX_DERIVED = 64;
const identityOf = stat => [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
function fileIdentity(file) {
  try { return identityOf(lstatSync(file, { bigint: true })); } catch { return 'missing'; }
}
function trim() {
  let bytes = [...processes.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  while (processes.size > MAX_ROOTS || bytes > MAX_CACHE_BYTES) {
    const [key, entry] = processes.entries().next().value;
    processes.delete(key); bytes -= entry.bytes;
  }
}

export function createSourceScan(root, { includeFixtures = false, diagnostics = false, excludeFiles = [], excludeEnvironmentFiles = false } = {}) {
  root = resolve(root);
  // Survey generation may exclude its own outputs. This is explicit and local
  // to this scan; ordinary CODE-1 discovery keeps its existing inventory.
  const excluded = [...new Set(excludeFiles.map(file => resolve(root, file)))].sort();
  const isExcluded = file => excluded.some(path => inside(path, file));
  let realRoot, rootIdentity;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }
  try { const stat = lstatSync(realRoot, { bigint: true }); rootIdentity = `${stat.dev}:${stat.ino}:${stat.mode}`; }
  catch { rootIdentity = 'missing'; }
  const processKey = `${root}\u0000${realRoot}\u0000${rootIdentity}\u0000${Boolean(includeFixtures)}\u0000${Boolean(excludeEnvironmentFiles)}\u0000${JSON.stringify(excluded)}`;
  const environmentFile = file => /(?:^|[\\/])\.env(?:\.[^\\/]*)?$/iu.test(file);
  let inventory, entry;
  const inventoryEntries = [], inventoryOmissions = [], readResults = new Map();
  const pathOf = file => portable(relative(root, file));
  const noteEntry = (file, kind, status) => {
    if (diagnostics) inventoryEntries.push({ file, path: pathOf(file), kind, eligible: status === 'eligible', status });
  };
  const noteOmission = (file, kind, reason, extent = 'unknown') => {
    if (diagnostics) inventoryOmissions.push({ file, path: pathOf(file), kind, reason, extent });
  };
  const noteRead = (file, status, maxBytes, bytes, cache_hit = false) => {
    if (diagnostics) readResults.set(`${file}\u0000${maxBytes}`, { file, path: pathOf(file), status, maxBytes, bytes, cache_hit });
  };
  const identities = new Map(), contractLinks = new Set();
  const stats = { content_reads: 0, files_read: [], skipped_files: 0, cache_hits: 0,
    derived_builds: 0, derived_hits: 0, inventory_invalidations: 0, stat_checks: 0 };
  const identity = file => {
    if (!identities.has(file)) {
      let stamp = fileIdentity(file);
      // Explicit dependencies can live under hidden folders outside the source
      // walk. An ancestor changed to a link may preserve the file's inode and
      // timestamps, so its resolved boundary participates in cache identity.
      try { const real = realpathSync(file); stamp += `\u0000${inside(realRoot, real) ? 'inside' : 'outside'}\u0000${real}`; }
      catch { stamp += '\u0000unresolved'; }
      identities.set(file, stamp); stats.stat_checks++;
    }
    return identities.get(file);
  };
  const list = () => {
    if (inventory) return inventory;
    inventory = [];
    const walk = (directory, depth) => {
      if (depth > 7) { noteOmission(directory, 'directory', 'depth-limit'); return; }
      let entries;
      try { entries = readdirSync(directory, { withFileTypes: true }); }
      catch { noteOmission(directory, 'directory', 'unreadable'); return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(directory, entry.name);
        let exclusion;
        if (excluded.length && isExcluded(path)) exclusion = 'explicitly-excluded';
        else if (excludeEnvironmentFiles && environmentFile(path)) exclusion = 'environment-excluded';
        // Only the literal .env file is admitted. Hidden directories, including
        // private evidence and credentials, remain outside the source walk.
        else if (entry.name.startsWith('.') && entry.name !== '.github' && !(entry.name === '.env' && entry.isFile())) exclusion = 'hidden-excluded';
        else if (SKIP.has(entry.name) || entry.name === LAYOUT.baseline.split('/').at(-1)) exclusion = 'directory-excluded';
        if (exclusion) {
          if (entry.isFile()) noteEntry(path, 'file', exclusion);
          else noteOmission(path, entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'special', exclusion, entry.isDirectory() ? 'unknown' : 'one');
          continue;
        }
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isFile()) {
          inventory.push(path);
          if (diagnostics) noteEntry(path, 'file', !includeFixtures && FIXTURE.test(pathOf(path)) ? 'fixture-excluded'
            : SCAN_INPUT.test(path) ? 'eligible' : 'unsupported-extension');
        }
        // Existing static contract discovery lists these so its bounded
        // contract reader can count operations and name an outside link.
        // They are never admitted to the new source-content reader.
        else if (entry.isSymbolicLink()) {
          if (CONTRACT_FILE.test(entry.name)) { inventory.push(path); contractLinks.add(path); }
          noteEntry(path, 'symlink', 'symlink-excluded');
          noteOmission(path, 'symlink', 'symlink-excluded', 'one');
        } else {
          noteOmission(path, 'special', 'special-file', 'one');
        }
      }
    };
    walk(root, 0);
    const hash = createHash('sha256');
    for (const file of inventory) {
      if (!SCAN_INPUT.test(file)) continue;
      // A walked regular file has only real-directory ancestors; separately
      // requested hidden dependencies use the stronger realpath identity above.
      identities.set(file, fileIdentity(file)); stats.stat_checks++;
      hash.update(file).update('\u0000').update(identities.get(file)).update('\u0000');
      // Historical contract inventory follows these links. Include the target
      // metadata for its derived results, but never read it through scan.read.
      if (contractLinks.has(file)) {
        try { hash.update(realpathSync(file)).update(identityOf(statSync(file, { bigint: true }))); }
        catch { hash.update('unreadable-contract-link'); }
      }
    }
    const revision = hash.digest('hex'), previous = processes.get(processKey);
    const unchanged = previous?.revision === revision;
    if (previous && !unchanged) stats.inventory_invalidations++;
    const contents = new Map(previous?.contents ?? []), offsets = new Map(previous?.offsets ?? []);
    // Removed sources must not accumulate indefinitely across edited snapshots.
    const present = new Set(inventory);
    for (const file of contents.keys()) if (!present.has(file) && SCAN_INPUT.test(file) && !relative(root, file).startsWith('.')) contents.delete(file);
    for (const file of offsets.keys()) if (!present.has(file)) offsets.delete(file);
    const derived = new Map(unchanged ? previous.derived : []);
    entry = { revision, contents, offsets, derived, bytes: 0 };
    entry.bytes = [...contents.values()].reduce((sum, item) => sum + item.cost, 0)
      + [...offsets.values()].reduce((sum, item) => sum + item.starts.length * 8, 0)
      + [...derived.values()].reduce((sum, item) => sum + item.cost, 0);
    processes.delete(processKey); processes.set(processKey, entry); trim();
    return inventory;
  };
  const files = (directory = root) => {
    directory = resolve(directory);
    return inside(root, directory) ? list().filter(file => inside(directory, file)) : [];
  };
  const sourceFiles = (directory = root) => files(directory).filter(file =>
    !contractLinks.has(file) && (includeFixtures || !FIXTURE.test(portable(relative(root, file)))));
  const read = (file, { maxBytes = MAX_BYTES } = {}) => {
    maxBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 16 * 1024 * 1024) : MAX_BYTES;
    file = resolve(root, file);
    if (!inside(root, file)) { noteRead(file, 'outside-root', maxBytes, 0); return null; }
    if (excluded.length && isExcluded(file)) { noteRead(file, 'explicitly-excluded', maxBytes, 0); return null; }
    if (excludeEnvironmentFiles && environmentFile(file)) { noteRead(file, 'environment-excluded', maxBytes, 0); return null; }
    list();
    const stamp = identity(file), cached = entry.contents.get(file);
    if (cached?.identity === stamp && (cached.source !== null || !cached.limit || cached.limit >= maxBytes)) {
      stats.cache_hits++;
      noteRead(file, cached.source !== null ? cached.bytes <= maxBytes ? 'read' : 'oversized' : cached.status,
        maxBytes, cached.size ?? cached.bytes, true);
      return cached.source !== null && cached.bytes <= maxBytes ? cached.source : null;
    }
    let fd, source = null;
    let limit = null, bytes = 0, size = 0, status = 'unreadable';
    try {
      // Inspect before opening: opening a FIFO first can wait indefinitely for
      // a writer. NONBLOCK also closes the replacement race with a special file.
      if (!lstatSync(file).isFile()) { status = 'non-regular'; throw new Error('Source is not a regular file.'); }
      const realFile = realpathSync(file);
      if (!inside(realRoot, realFile)) { status = 'outside-root'; throw new Error('Source resolves outside the scan root.'); }
      fd = openSync(realFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      size = stat.size;
      if (stat.isFile() && stat.size > maxBytes) { limit = maxBytes; status = 'oversized'; }
      else if (stat.isFile()) {
        const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
        while (bytes < buffer.length) {
          const count = readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
          if (!count) break;
          bytes += count;
        }
        stats.content_reads++;
        stats.files_read.push(portable(relative(root, file)));
        // A file that grew during this snapshot cannot be represented by its
        // truncated prefix. Neither branch reads beyond its own byte allowance.
        if (bytes <= maxBytes && bytes === stat.size) { source = buffer.subarray(0, bytes).toString('utf8'); status = 'read'; }
        else status = 'changed';
      } else status = 'non-regular';
    } catch { /* Unreadable source stays absent, not an invented location. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    if (source === null) stats.skipped_files++;
    noteRead(file, status, maxBytes, size);
    const cost = (source === null ? 0 : Buffer.byteLength(source)) + 128;
    entry.bytes += cost - (cached?.cost ?? 0);
    entry.contents.set(file, { source, bytes, size, status, limit, identity: stamp, cost }); trim();
    return source;
  };
  const line = (file, offset) => {
    file = resolve(root, file);
    const source = read(file);
    if (source === null || !Number.isInteger(offset) || offset < 0 || offset > source.length) return undefined;
    const stamp = identity(file), old = entry.offsets.get(file);
    let starts = old?.identity === stamp ? old.starts : null;
    if (!starts) {
      starts = [0];
      for (let at = source.indexOf('\n'); at !== -1; at = source.indexOf('\n', at + 1)) starts.push(at + 1);
      entry.bytes += (starts.length - (old?.starts.length ?? 0)) * 8;
      entry.offsets.set(file, { identity: stamp, starts }); trim();
    }
    let low = 0, high = starts.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (starts[mid] <= offset) low = mid + 1; else high = mid;
    }
    return low;
  };
  const memo = (key, factory, { files: dependencies = [] } = {}) => {
    list();
    const dependencyKey = dependencies.map(file => {
      file = resolve(root, file); return `${file}\u0000${identity(file)}`;
    }).join('\u0001');
    const selected = `${key}\u0000${dependencyKey}`, cached = entry.derived.get(selected);
    if (cached) {
      stats.derived_hits++;
      entry.derived.delete(selected); entry.derived.set(selected, cached);
      return structuredClone(cached.value);
    }
    stats.derived_builds++;
    const value = factory();
    // Consumers can annotate a returned surface; that must not rewrite the
    // next invocation's cached source interpretation.
    const saved = structuredClone(value), cost = serialize(saved).byteLength;
    if (cost <= MAX_CACHE_BYTES) {
      entry.derived.set(selected, { value: saved, cost }); entry.bytes += cost;
      while (entry.derived.size > MAX_DERIVED) {
        const [oldKey, oldValue] = entry.derived.entries().next().value;
        entry.derived.delete(oldKey); entry.bytes -= oldValue.cost;
      }
      trim();
    }
    return value;
  };
  return { root, includeFixtures, files, sourceFiles, read, line, memo, stats,
    // Reports describe eligibility and read outcomes, not physical-read counts.
    // They remain process-private; portable consumers must project safe paths.
    inventory: () => {
      if (diagnostics) list();
      return { entries: inventoryEntries.map(row => ({ ...row })), omissions: inventoryOmissions.map(row => ({ ...row })) };
    },
    readDiagnostics: () => [...readResults.values()].map(row => ({ ...row })),
  };
}

export function withSourceScan(scan, fn) { return active.run(scan, fn); }
export function currentSourceScan(root) {
  const scan = active.getStore();
  return scan && inside(scan.root, resolve(root)) ? scan : null;
}
