// Each packaged build gets its own identity even when the release version is unchanged.
// Keep generated identity out of the committed source tree and workstation paths out of it.
import { randomUUID } from "node:crypto";
import { lstatSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(new URL("../lib", import.meta.url));
let temporary, created = false;
try {
  if (!lstatSync(directory).isDirectory()) throw new Error();
  temporary = join(directory, `.build-info-${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify({ buildId: randomUUID() }) + "\n", { flag: "wx", mode: 0o600 });
  created = true;
  // Replacing the directory entry never follows a prior symlink or modifies its
  // hardlink peers; only the generated package identity changes.
  renameSync(temporary, join(directory, "build-info.json"));
  created = false;
} catch {
  console.error("BUILD_ID_WRITE_FAILED: the package build identity could not be written.");
  process.exitCode = 1;
} finally {
  if (created) {
    try { unlinkSync(temporary); } catch { /* Fixed failure above; no path output. */ }
  }
}
