// `sannr --version` identifies the build without making a newcomer parse help.
// The git hash is useful only for a checkout of this package; an extracted copy
// must still report its package version without borrowing a parent repository's
// commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const PACKAGE = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

test("version from a checkout is one line with package version and git short hash", () => {
  const out = execFileSync("node", [CLI, "--version"], { cwd: ROOT, encoding: "utf8" });
  const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  assert.equal(out.trim().split("\n").length, 1, `version printed more than one line:\n${out}`);
  assert.match(out, new RegExp(`\\b${PACKAGE.version}\\b`));
  assert.match(out, new RegExp(`\\b${hash}\\b`));
  assert.doesNotMatch(out, /shared API knowledge for coding agents/);
});

test("version from an extracted non-git copy omits the hash without crashing", () => {
  const extracted = mkdtempSync(join("/tmp", "sannr-version-"));
  try {
    for (const name of ["bin", "lib", "package.json"])
      execFileSync("cp", ["-R", join(ROOT, name), join(extracted, name)]);
    const out = execFileSync("node", [join(extracted, "bin", "cli.mjs"), "-v"], {
      cwd: extracted, encoding: "utf8",
    });
    assert.equal(out.trim().split("\n").length, 1);
    assert.match(out, new RegExp(`\\b${PACKAGE.version}\\b`));
    assert.doesNotMatch(out, /\([0-9a-f]{7,}\)/i, "a non-git copy borrowed a commit hash");
    assert.doesNotMatch(out, /shared API knowledge for coding agents/);
  } finally {
    rmSync(extracted, { recursive: true, force: true });
  }
});
