// Bundled files and optional adapter files are pinned from npm artifacts.
// Reading this catalog uses Node only; third-party code loads on adapter use.
import { readFileSync, lstatSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
const catalog = JSON.parse(readFileSync(new URL('./runtime-dependencies.json', import.meta.url), 'utf8'));
export const runtimeDependencyFiles = Object.freeze(Object.keys(catalog.files));
export function isRuntimeDependencyPath(path) { return Object.hasOwn(catalog.files, path); }
export function isRuntimeDependencyDirectory(path) {
  return runtimeDependencyFiles.some(file => file.startsWith(`${path.replace(/\/$/, '')}/`));
}
export function verifyRuntimeDependency(path, bytes) {
  return isRuntimeDependencyPath(path) && createHash('sha256').update(bytes).digest('hex') === catalog.files[path];
}
export function validateRuntimeBundle(paths, root) {
  for (const path of paths.filter(path => path.startsWith('node_modules/') && !path.endsWith('/'))) {
    if (!isRuntimeDependencyPath(path) || !lstatSync(join(root, path)).isFile()
      || !verifyRuntimeDependency(path, readFileSync(join(root, path))))
      throw new Error('Present runtime dependency bytes differ from the pinned inventory.');
  }
}
const integrityError = () => Object.assign(new Error('Protocol package files differ from the pinned artifact inventory.'),
  { code: 'PROTOCOL_PACKAGE_INTEGRITY' });
function findPackage(name, from) {
  const require = createRequire(join(from, 'package.json'));
  for (const directory of require.resolve.paths(name) ?? []) {
    const path = join(directory, name);
    try { lstatSync(path); return path; }
    catch (error) { if (error.code !== 'ENOENT') throw integrityError(); }
  }
  return null;
}
// Validate every installed upstream file in the executable dependency graph
// before import. Separately reviewed declarationDependencies contain no runtime
// entrypoint and are not traversed. Share work only within one synchronous preflight; later requests
// rehash the files so changes on disk are still detected.
// Installation layouts may be hoisted or nested; package identity is exact.
export function verifyProtocolPackage(name, packageRoot, seen = new Set()) {
  try {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const version = manifest.optionalDependencies?.[name];
    if (!version) throw integrityError();
    function verify(key, directory) {
      const expected = catalog.optional?.[key];
      if (!expected || !directory || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw integrityError();
      const identity = `${key}:${resolve(directory)}`;
      if (seen.has(identity)) return;
      seen.add(identity);
      const present = [];
      function walk(current, prefix = '') {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          if (!prefix && entry.name === 'node_modules') continue;
          const path = prefix + entry.name;
          if (entry.isDirectory()) walk(join(current, entry.name), `${path}/`);
          else if (entry.isFile()) present.push(path);
          else throw integrityError();
        }
      }
      walk(directory);
      if (present.length !== Object.keys(expected.files).length) throw integrityError();
      for (const path of present) if (!Object.hasOwn(expected.files, path)
        || createHash('sha256').update(readFileSync(join(directory, path))).digest('hex') !== expected.files[path]) throw integrityError();
      for (const [dependency, pinned] of Object.entries(expected.dependencies))
        verify(pinned, findPackage(dependency, directory));
      for (const [dependency, pinned] of Object.entries(expected.optionalDependencies)) {
        const installed = findPackage(dependency, directory);
        if (installed) verify(pinned, installed);
      }
    }
    verify(`${name}@${version}`, packageRoot);
  } catch { throw integrityError(); }
}
