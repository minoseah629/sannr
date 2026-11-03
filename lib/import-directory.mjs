// Import only regular, bounded local trees. lstat never follows a symbolic
// link: even an unrelated link in a capture directory is a named refusal.
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
export const IMPORT_DIRECTORY_MAX_ENTRIES = 4096;
export const IMPORT_DIRECTORY_MAX_DEPTH = 33;
export const IMPORT_DIRECTORY_MAX_BYTES = 50 * 1024 * 1024;
const fail = (code, rule) => { throw Object.assign(new Error(`Import directory: ${rule}.`), { code }); };
export function inspectImportDirectory(root, { bruno = false } = {}) {
  let entries = 0, bytes = 0;
  const pending = [{ path: root, depth: 1, root: true }];
  try {
    while (pending.length) {
      const item = pending.pop();
      const stat = lstatSync(item.path);
      if (stat.isSymbolicLink()) fail('IMPORT_DIRECTORY_SYMLINK', 'symbolic links are not permitted');
      if (++entries > IMPORT_DIRECTORY_MAX_ENTRIES) fail('IMPORT_DIRECTORY_ENTRIES', 'entry count exceeds 4096');
      if (stat.isDirectory()) {
        if (bruno && !item.root && /\.bru$/i.test(item.path)) fail('IMPORT_DIRECTORY_FILE_EXPECTED', '.bru entries must be regular files');
        if (item.depth > IMPORT_DIRECTORY_MAX_DEPTH) fail('IMPORT_DIRECTORY_DEPTH', 'directory depth exceeds 33');
        const names = readdirSync(item.path).sort();
        if (entries + pending.length + names.length > IMPORT_DIRECTORY_MAX_ENTRIES) fail('IMPORT_DIRECTORY_ENTRIES', 'entry count exceeds 4096');
        for (const name of names) pending.push({ path: join(item.path, name), depth: item.depth + 1 });
      } else {
        if (item.root) fail('IMPORT_DIRECTORY_EXPECTED', 'root must be a directory');
        if (!stat.isFile()) fail('IMPORT_DIRECTORY_FILE_EXPECTED', 'entries must be regular files');
        bytes += stat.size;
        if (bytes > IMPORT_DIRECTORY_MAX_BYTES) fail('IMPORT_DIRECTORY_BYTES', 'total file size exceeds 50 MB');
      }
    }
  } catch (error) {
    if (error?.code?.startsWith('IMPORT_DIRECTORY_')) throw error;
    fail('IMPORT_DIRECTORY_UNREADABLE', 'tree must be readable');
  }
  return { entries, bytes };
}
