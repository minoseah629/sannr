// Copy npm's actual allowlist into a private build tree before lifecycle writes.
// Packing tests and alpha builds must not mutate an engine another process hashes.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export function stagePackage(root, destination) {
  try {
    const args = ["pack", "--dry-run", "--ignore-scripts", "--offline", "--json"];
    const command = process.env.npm_execpath ? process.execPath : "npm";
    const argv = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
    const packed = JSON.parse(execFileSync(command, argv, { cwd: root,
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024 }));
    if (packed.length !== 1 || !Array.isArray(packed[0].files)) throw new Error();
    mkdirSync(destination);
    for (const { path } of packed[0].files) {
      if (typeof path !== "string" || isAbsolute(path) || path.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new Error();
      // Every build generates this independently after staging; no inherited id.
      if (path === "lib/build-info.json") continue;
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(join(root, path), target);
    }
    return destination;
  } catch {
    throw new Error("PACKAGE_STAGE_FAILED: the allowlisted source could not be staged for packaging.");
  }
}
