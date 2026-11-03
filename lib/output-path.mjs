// A destination is authority to write one file, never to follow a repository
// link into another file. Check all ancestors; directory link counts are not
// file link counts. Open without truncation, then inspect the actual descriptor.
import { closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

const failure = code => Object.assign(new Error('Output destination must be a regular, single-link file with unlinked directory ancestors.'), { code });
export function safeOutputPath(value, { directory = false, code = 'OUTPUT_UNSAFE_PATH' } = {}) {
  const target = resolve(value);
  for (let current = target;; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      // macOS exposes these OS-owned filesystem aliases in ordinary temp paths.
      const systemAlias = process.platform === 'darwin' && current !== target
        && ['/tmp', '/var'].includes(current) && realpathSync(current) === `/private${current}`;
      if (stat.isSymbolicLink() && !systemAlias) throw failure(code);
      if (!systemAlias && (current !== target || directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1)) throw failure(code);
    } catch (error) { if (error.code !== 'ENOENT') throw failure(code); }
    if (dirname(current) === current) break;
  }
  return target;
}

export function writeOutputFile(value, bytes, { mode, mkdir = false, append = false, code = 'OUTPUT_UNSAFE_PATH' } = {}) {
  const target = safeOutputPath(value, { code });
  if (mkdir) mkdirSync(dirname(target), { recursive: true });
  let fd;
  try {
    fd = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK | (append ? constants.O_APPEND : 0), mode ?? 0o666);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw failure(code);
    if (mode !== undefined) fchmodSync(fd, mode);
    if (!append) ftruncateSync(fd, 0);
    writeFileSync(fd, bytes);
  } catch (error) {
    if (['ELOOP', 'EMLINK'].includes(error.code)) throw failure(code);
    throw error;
  } finally { if (fd !== undefined) closeSync(fd); }
  return target;
}

// The same write, made visible all at once. The bytes go to a temporary file in
// the destination's directory, created exclusively (an existing file or link at
// that name is refused, never followed) and checked like writeOutputFile's
// descriptor; the complete file is then renamed over the final name. A reader
// that lists the directory sees the final name only with all its bytes. The
// temporary name keeps the destination's prefix and extension, so ignore rules
// written for the final name cover a leftover, and it carries a dot before the
// extension that no run id contains.
export function writeOutputFileAtomic(value, bytes, { mode, mkdir = false, code = 'OUTPUT_UNSAFE_PATH', tempName } = {}) {
  const target = safeOutputPath(value, { code });
  if (mkdir) mkdirSync(dirname(target), { recursive: true });
  const ext = extname(target), stem = basename(target, ext);
  const temp = join(dirname(target), tempName ?? `${stem}.tmp-${process.pid}-${randomBytes(6).toString('hex')}${ext}`);
  safeOutputPath(temp, { code });
  let fd, created = false, renamed = false;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, mode ?? 0o666);
    created = true;
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw failure(code);
    if (mode !== undefined) fchmodSync(fd, mode);
    writeFileSync(fd, bytes);
    closeSync(fd);
    fd = undefined;
    // The name must still be the file this call wrote, and the destination and
    // its ancestors are rechecked immediately before the name appears.
    const atPath = lstatSync(temp);
    if (!atPath.isFile() || atPath.nlink !== 1 || atPath.dev !== stat.dev || atPath.ino !== stat.ino) throw failure(code);
    safeOutputPath(target, { code });
    renameSync(temp, target);
    renamed = true;
  } catch (error) {
    if (['ELOOP', 'EMLINK', 'EEXIST'].includes(error.code)) throw failure(code);
    throw error;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* the unlink below still runs */ }
    // Only a temporary file this call created is removed; an existing entry at
    // that name was refused above and is left exactly as it was.
    if (created && !renamed) try { unlinkSync(temp); } catch { /* never mask the original result */ }
  }
  return target;
}

// A caller-facing boundary shared by every user-chosen output path (the view,
// reports, flattened workspaces): inside the project unless explicitly allowed,
// then the same regular-file and unlinked-ancestor checks as safeOutputPath.
export function resolveOutputPath(root, flag, { allowOutside = false, defaultInside = false, fileOnly = false, code = 'OUTPUT_UNSAFE_PATH' } = {}) {
  const target = resolve(flag), base = resolve(root);
  const inside = target === base || target.startsWith(`${base}${sep}`);
  if (!inside && !allowOutside && !defaultInside)
    throw Object.assign(new Error(`${flag} resolves outside the project; pass --allow-outside-project for this destination.`),
      { code: 'OUTPUT_OUTSIDE_PROJECT', next: 'Use a project-local output path, or add --allow-outside-project for this destination.' });
  return safeOutputPath(target, { directory: false, code });
}
