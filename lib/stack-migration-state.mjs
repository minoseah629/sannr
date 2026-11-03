// A read-only boundary shared by request capture and authored knowledge.
// Keep this module independent of config, context and the migration engine:
// those modules all need this guard before they acquire a write lock.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { CLI_NAME } from './brand.mjs';
import { LAYOUT, LEGACY_LAYOUT, legacyLayoutEntries } from './layout.mjs';
import { activeStackScopeFor } from './stack-scope.mjs';

export function stacksMigrationRequired(root) {
  // A selected stack is writable even when a separate legacy store is waiting
  // to be sorted. A scope belonging to another repo never exempts this one.
  if (activeStackScopeFor(root)) return null;
  const paths = [LAYOUT.context, LAYOUT.environments, LEGACY_LAYOUT.context,
    LEGACY_LAYOUT.environments, LEGACY_LAYOUT.hiddenEnvironments];
  let legacy = paths.some(path => existsSync(join(root, path)));
  if (!legacy) {
    // The layout marker is the existing authority for earlier product and
    // collection names. A marker or empty managed directory alone is not an
    // install that needs migration.
    legacy = legacyLayoutEntries(root).some(entry => entry.product && [
      join(entry.from, entry.collection, `${entry.product}.json`),
      join(entry.from, 'config', 'api-environments.json'),
    ].some(path => existsSync(join(root, path))));
  }
  if (!legacy) return null;
  const command = `${CLI_NAME} migrate --dry-run`;
  return { code: 'STACKS_MIGRATION_REQUIRED', command,
    message: `This repository uses the single-store layout. Requests can run, but shared API knowledge is read-only until migration. Run ${command}.` };
}

export function assertStacksWritable(root) {
  const refusal = stacksMigrationRequired(root);
  if (refusal) throw Object.assign(new Error(refusal.message), refusal, { next: refusal.command });
}

export function stacksMigrationCapture(root) {
  const refusal = stacksMigrationRequired(root);
  return refusal ? { state: 'skipped', ...refusal } : null;
}
