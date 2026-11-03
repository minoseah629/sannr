// Best-effort command-name diagnostics for doctor.
//
// This module deliberately does not start an interactive/login shell: doing so
// executes user startup files, making a read-only diagnostic nondeterministic
// and potentially effectful. Exported Bash functions are visible in env keys;
// aliases and non-exported functions are not, and doctor says that limit.

import { X_OK } from "node:constants";
import { accessSync, lstatSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";

import { LEGACY_BIN_NAMES, PRODUCT } from "./brand.mjs";

function executableIdentity(path) {
  try {
    const leaf = lstatSync(path);
    if (!leaf.isFile() && !leaf.isSymbolicLink()) return null;
    const target = leaf.isSymbolicLink() ? statSync(path) : leaf;
    if (!target.isFile()) return null;
    accessSync(path, X_OK);
    // Device+inode dedupes repeat PATH slots, symlinks, and hardlinks to the
    // same executable without reading the candidate or trusting its path text.
    return `${target.dev}:${target.ino}`;
  } catch { return null; }
}

/** Inspect exact declared basenames in each PATH slot. No directory listing,
 * file read, command execution, or candidate-controlled text crosses out. */
export function inspectDoctorEnvironment({
  cwd = process.cwd(),
  env = process.env,
  pathValue,
  legacyNames = LEGACY_BIN_NAMES,
  product = PRODUCT,
} = {}) {
  const found = [];
  const effectivePath = pathValue === undefined ? env.PATH : pathValue;
  for (const name of effectivePath == null ? [] : legacyNames) {
    const identities = new Set();
    for (const slot of String(effectivePath).split(delimiter)) {
      const base = slot === "" ? cwd : isAbsolute(slot) ? slot : resolve(cwd, slot);
      const identity = executableIdentity(join(base, name));
      if (identity) identities.add(identity);
    }
    if (identities.size) found.push({ name, count: identities.size });
  }
  return {
    legacy: found,
    exportedFunction: Object.hasOwn(env, `BASH_FUNC_${product}%%`),
  };
}
