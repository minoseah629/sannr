// The core loads only Node. Public protocol requests use this preflight before
// importing an adapter, checking packages before any third-party code runs.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProtocolPackage } from './runtime-dependencies.mjs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const names = new Set(['graphql', 'ws', '@grpc/grpc-js', '@grpc/proto-loader', 'protobufjs']);
const missing = new WeakMap();
const integrity = () => Object.assign(new Error('Protocol package files differ from the pinned artifact inventory.'),
  { code: 'PROTOCOL_PACKAGE_INTEGRITY' });

function missingPackage(name) {
  const version = manifest.optionalDependencies?.[name];
  if (!names.has(name) || typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw integrity();
  const install = `npm install --save-exact --ignore-scripts ${name}@${version}`;
  const message = `The optional protocol package ${name} is missing.`;
  const error = Object.assign(new Error(message), { code: 'PROTOCOL_PACKAGE_MISSING' });
  // Public metadata comes only from our known package identities and pins.
  // A foreign error with the same code never gains an untrusted message path.
  missing.set(error, Object.freeze({ code: error.code, package: name, install, message, next: `Run: ${install}` }));
  return error;
}

export function protocolPackageRefusal(error) { return missing.get(error) ?? null; }

function resolvePackage(name) {
  if (!names.has(name)) throw integrity();
  let entry;
  try { entry = import.meta.resolve(name); }
  catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') throw missingPackage(name);
    throw integrity();
  }
  let directory = dirname(fileURLToPath(entry));
  for (let depth = 0; depth < 32; depth++) {
    const file = join(directory, 'package.json');
    if (existsSync(file)) {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).name === name) return { name, entry, root: directory };
      } catch { throw integrity(); }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw integrity();
}

export function verifyProtocolPackages(...requested) {
  const packages = requested.map(resolvePackage);
  const seen = new Set();
  for (const { name, root } of packages) verifyProtocolPackage(name, root, seen);
  return packages;
}
