// Intentionally refresh after npm ci --ignore-scripts. Read packed artifacts,
// never the working node_modules tree: local edits cannot become trusted pins.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, posix } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'pin-runtime-'));
const run = (command, args, cwd = root) => execFileSync(command, args,
  { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
// Reviewed upstream edges, not a name-wide exemption. These declarations have
// no runtime entrypoint or executable files; protobuf's verified JS never loads
// them. Keep their artifact records for audit, outside the runtime dependency
// walk. A different upstream version requires another explicit review.
const declarationEdges = { 'protobufjs@7.6.6': new Set(['@types/node']),
  '@types/node@26.5.1': new Set(['undici-types']) };
let sequence = 0;
function artifact(spec, integrity) {
  const destination = join(scratch, String(sequence++)); mkdirSync(destination);
  const args = ['pack', '--ignore-scripts', '--offline', '--json', ...spec];
  const listing = JSON.parse(run('npm', [...args, '--dry-run']))[0];
  const packed = JSON.parse(run('npm', [...args, '--pack-destination', destination]))[0];
  const archive = join(destination, packed.filename);
  if (integrity) {
    const bytes = readFileSync(archive);
    if (!integrity.split(/\s+/).some(item => {
      const [algorithm, expected] = item.split('-');
      return ['sha512', 'sha256', 'sha1'].includes(algorithm)
        && createHash(algorithm).update(bytes).digest('base64') === expected;
    })) throw new Error('A dependency artifact differs from package-lock integrity.');
  }
  const entries = run('tar', ['tzf', archive]).trim().split('\n');
  const prefix = `${entries[0].split('/')[0]}/`;
  for (const path of entries) if ((!path.startsWith(prefix) && path !== prefix.slice(0, -1)) || path.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(path)
    || path.split('/').includes('..')) throw new Error('Unsafe dependency artifact path.');
  if (run('tar', ['tvzf', archive]).trim().split('\n').some(line => !/^[-d]/.test(line)))
    throw new Error('Dependency artifact contains links or special files.');
  run('tar', ['xzf', archive, '-C', destination]);
  const base = join(destination, prefix);
  const files = listing.files.map(file => file.path).filter(path => !path.endsWith('/') && path !== prefix.slice(0, -1))
    .map(path => path.startsWith(prefix) ? path.slice(prefix.length) : path)
    .filter(path => lstatSync(join(base, path)).isFile()).sort();
  const actual = entries.filter(path => lstatSync(join(destination, path)).isFile())
    .map(path => path.slice(prefix.length)).sort();
  if (JSON.stringify(files) !== JSON.stringify(actual)) throw new Error('Packed artifact differs from its dry-run inventory.');
  const hashes = Object.fromEntries(files.map(path => {
    if (!lstatSync(join(base, path)).isFile()) throw new Error('Dependency artifact contains a non-file.');
    return [path, hash(readFileSync(join(base, path)))];
  }));
  return { base, files: hashes, manifest: JSON.parse(readFileSync(join(base, 'package.json'), 'utf8')) };
}
function lockedDependency(name, parent = '') {
  let location = parent;
  for (;;) {
    const path = posix.join(location, 'node_modules', name);
    if (lock.packages[path]) return path;
    if (!location) throw new Error('An optional dependency is absent from package-lock. Run npm ci before pinning.');
    const next = posix.dirname(location);
    location = next === '.' ? '' : next;
  }
}
try {
  const packed = artifact([]);
  const packages = {}, files = {}, optional = {}, upstreamManifests = {};
  for (const [path, digest] of Object.entries(packed.files)) if (path.startsWith('node_modules/')) {
    files[path] = digest;
    if (path.endsWith('/package.json')) {
      const manifest = JSON.parse(readFileSync(join(packed.base, path), 'utf8'));
      packages[path.slice(0, -13)] = { name: manifest.name, version: manifest.version };
    }
  }
  function visit(path) {
    const locked = lock.packages[path];
    const name = locked.name ?? path.split('node_modules/').at(-1);
    const key = `${name}@${locked.version}`;
    if (optional[key]) return key;
    const upstream = artifact([locked.resolved ?? key], locked.integrity);
    upstreamManifests[key] = upstream.manifest;
    if (upstream.manifest.name !== name || upstream.manifest.version !== locked.version)
      throw new Error('Dependency artifact identity differs from the lockfile.');
    const item = optional[key] = { name, version: locked.version, files: upstream.files, dependencies: {}, optionalDependencies: {} };
    for (const dependency of Object.keys(upstream.manifest.dependencies ?? {}).sort()) {
      const pin = visit(lockedDependency(dependency, path));
      if (declarationEdges[key]?.has(dependency)) {
        const declaration = optional[pin];
        const pkg = upstreamManifests[pin];
        if (pkg.types !== 'index.d.ts' || pkg.main || pkg.exports
          || Object.keys(pkg.scripts ?? {}).length
          || Object.keys(declaration.files).some(file => !file.endsWith('.d.ts')
            && !['LICENSE', 'README.md', 'package.json'].includes(file)))
          throw new Error('A reviewed declaration dependency gained executable files or entrypoints.');
        (item.declarationDependencies ??= {})[dependency] = pin;
      } else item.dependencies[dependency] = pin;
    }
    for (const dependency of Object.keys(upstream.manifest.optionalDependencies ?? {}).sort()) {
      try { item.optionalDependencies[dependency] = visit(lockedDependency(dependency, path)); }
      catch { throw new Error('An optional transitive dependency has no pinned artifact.'); }
    }
    // Optional peers (ws native accelerators) may be absent. A present peer
    // without an artifact pin must be refused before it can execute.
    for (const dependency of Object.keys(upstream.manifest.peerDependencies ?? {}).sort())
      item.optionalDependencies[dependency] ??= null;
    return key;
  }
  for (const [name, version] of Object.entries(packed.manifest.optionalDependencies ?? {}).sort()) {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Protocol packages must be exact-pinned.');
    if (visit(lockedDependency(name)) !== `${name}@${version}`) throw new Error('Optional package version differs from the lockfile.');
  }
  const sorted = value => Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')));
  writeFileSync(join(root, 'lib/runtime-dependencies.json'), JSON.stringify({ v: 2,
    packages: sorted(packages), files: sorted(files), optional: sorted(optional) }, null, 2) + '\n');
  console.log(`Pinned ${Object.keys(packages).length} bundled packages and ${Object.keys(files).length} bundled files; ${Object.keys(optional).length} optional package artifacts.`);
} finally { rmSync(scratch, { recursive: true, force: true }); }
