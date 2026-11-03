// CI-only verifier: inspect the artifact that will be uploaded/published.
// Read metadata as tar streams; extract any bundled dependencies into a
// temporary directory for hash verification, then remove it. No new package dependencies.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRuntimeDependencyPath, isRuntimeDependencyDirectory, verifyRuntimeDependency,
  validateRuntimeBundle } from '../lib/runtime-dependencies.mjs';

async function verify(archive) {
  const source = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const allowed = ["package.json", ...source.files];
  const tar = (...args) => execFileSync("tar", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024,
  });
  const entries = tar("tzf", archive).trimEnd().split("\n");
  const seen = new Set();
  for (const entry of entries) {
    const parts = entry.replace(/\/$/, "").split("/");
    const dependencyPath = entry.startsWith('package/') ? entry.slice(8) : '';
    const dependency = entry.endsWith('/') ? isRuntimeDependencyDirectory(dependencyPath) : isRuntimeDependencyPath(dependencyPath);
    // This exact engine module is source, not captured evidence. Keep all
    // evidence directories and similarly named payloads excluded.
    const evidenceModule = entry === 'package/lib/evidence-confidence.mjs';
    // Match the packaging suites' evidence/working-tree exclusions even
    // inside an allowed directory. Dotfiles and escaped/control characters
    // also cannot enter the release artifact.
    if (/^[\\/]|[\\\x00-\x1f\x7f]/.test(entry)
      || parts.some((part) => !part || (!dependency && part.startsWith("."))
        || (!evidenceModule && /^(?:evidence(?:-|$)|results$)/.test(part)) || (!dependency && part === 'node_modules'))
      || /\.env$|\.tgz$/.test(entry)) {
      throw new Error(`Unsafe archive entry: ${entry}`);
    }
    if (seen.has(entry)) throw new Error(`Duplicate archive entry: ${entry}`);
    seen.add(entry);
    const path = entry.startsWith("package/") ? entry.slice("package/".length) : null;
    const permitted = path !== null && (dependency || path === ""
      || allowed.some((rule) => rule.endsWith("/") ? path.startsWith(rule) : path === rule));
    if (!permitted) throw new Error(`Entry outside package.json files allowlist: ${entry}`);
  }
  // Verbose tar listings start with the entry type on both BSD tar (local)
  // and GNU tar (ubuntu-latest). No links or special files may ship.
  if (tar("tvzf", archive).trimEnd().split("\n").some((line) => !/^[-d]/.test(line))) {
    throw new Error("Archive contains links or special files");
  }
  for (const rule of allowed) {
    const complete = rule.endsWith("/")
      ? entries.some((entry) => entry.startsWith(`package/${rule}`) && !entry.endsWith("/"))
      : seen.has(`package/${rule}`);
    if (!complete) throw new Error(`Missing allowlisted payload: ${rule}`);
  }
  const packed = JSON.parse(tar("xOf", archive, "package/package.json"));
  if (!isDeepStrictEqual(packed, source)) {
    throw new Error("Packed manifest does not match the checked-out package.json");
  }
  if (entries.some(entry => entry.startsWith('package/node_modules/'))) {
    // Read all bundled files in one extraction stream would hide file boundaries;
    // hash regular files in a private extraction directory instead.
    const { mkdtempSync, rmSync, lstatSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const scratch = mkdtempSync(join(tmpdir(), 'verify-runtime-'));
    try {
      tar('xzf', archive, '-C', scratch);
      validateRuntimeBundle(entries.map(entry => entry.slice('package/'.length)), join(scratch, 'package'));
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  console.log(`Verified ${entries.length} entries against package.json files allowlist`);
}

try {
  if (process.argv.length !== 3 || !process.argv[2].endsWith(".tgz")) {
    throw new Error("Usage: node scripts/verify-package.mjs <package.tgz>");
  }
  await verify(resolve(process.argv[2]));
} catch (error) {
  console.error(`Package verification failed: ${error.message}`);
  process.exitCode = 1;
}
