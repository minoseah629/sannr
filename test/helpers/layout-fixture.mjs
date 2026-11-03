// Fixture setup may create nested managed paths. Product writes are exercised
// through their real APIs; this helper only replaces direct test-data writes.
import { mkdirSync, writeFileSync as write } from 'node:fs';
import { dirname } from 'node:path';
export function writeFileSync(path, ...args) {
  mkdirSync(dirname(path), { recursive: true });
  return write(path, ...args);
}
