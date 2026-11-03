#!/usr/bin/env node
// npm run check always runs the complete gates, even from an offline-check shell.
import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.SANNR_STRESS_LOCAL;
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error("Run this gate with npm run check");

for (const args of [["test"], ["run", "test:truth"], ["run", "test:stress"]]) {
  const result = spawnSync(process.execPath, [npmCli, ...args], { env, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
