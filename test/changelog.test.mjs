// Keep the installed version discoverable; prose, dates and section ordering
// belong to release review rather than a second hand-written semver parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const text = () => readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
const sections = () => [...text().matchAll(/^## \[([^\]]+)\](?: - (.+))?$/gm)]
  .map((m) => ({ version: m[1], date: m[2]?.trim() ?? null }));

test("the changelog has a section for the version package.json carries", () => {
  const { version } = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.ok(sections().some((s) => s.version === version), `CHANGELOG.md has no section for ${version}`);
});
