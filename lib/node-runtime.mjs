// Keep the launch path, not realpath(Node): package managers replace versioned
// installations while retaining their public executable or opt symlink.
import { accessSync, realpathSync, statSync } from 'node:fs';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export function versionedNodePath(path) {
  return /[\\/]Cellar[\\/]|[\\/]\.nvm[\\/]versions[\\/]node[\\/]|[\\/]node-versions[\\/]|[\\/]installs[\\/]node(?:js)?[\\/]/.test(path);
}

/** No candidate is executed. Prefer an executable alias of this exact Node,
 * preserving version-manager choice (e.g. Homebrew node@22). If only a volatile
 * install path is available, defer to the host's Node PATH instead of pinning
 * a path that will disappear. Doctor probes the resulting registration. */
export function stableNodeCommand({ execPath = process.execPath, path = process.env.PATH ?? '' } = {}) {
  const candidates = [];
  const brew = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(execPath);
  if (brew) candidates.push(join(brew[1], 'opt', brew[2], 'bin', 'node'), join(brew[1], 'bin', 'node'));
  for (const slot of path.split(delimiter))
    if (isAbsolute(slot)) candidates.push(join(slot, process.platform === 'win32' ? 'node.exe' : 'node'));
  for (const candidate of candidates) {
    if (versionedNodePath(candidate)) continue;
    try {
      if (!statSync(candidate).isFile() || realpathSync(candidate) !== realpathSync(execPath)) continue;
      accessSync(candidate, constants.X_OK);
      return candidate; // Intentionally NOT realpathSync(candidate).
    } catch { /* a missing or foreign candidate cannot establish an alias */ }
  }
  return versionedNodePath(execPath) ? 'node' : execPath;
}
