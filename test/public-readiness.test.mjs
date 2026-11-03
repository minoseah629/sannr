import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { renderCiWorkflow } from "../lib/ci-workflow.mjs";
import { isRuntimeDependencyPath } from '../lib/runtime-dependencies.mjs';

const ROOT = new URL("..", import.meta.url).pathname;

// npm's dry-run entry list is the package boundary. Keep this offline: these
// checks inspect local files and render templates, never query a registry.
const packedEntries = JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--offline"],
  { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }))[0].files.map(({ path }) => path);

test("packed entries and both rendered CI install modes contain no private tracker references", () => {
  const surfaces = packedEntries.map((path) => [path, `${path}\n${readFileSync(join(ROOT, path), "utf8")}`]);
  for (const install of ["vendored", "registry"]) surfaces.push([`rendered workflow (${install})`,
    renderCiWorkflow({ install, version: "0.1.0", tarballDigest: "a".repeat(64) })]);
  const violations = surfaces.flatMap(([path, text]) => [...text.matchAll(/MAR-\d+|linear\.app/gi)]
    .map(([reference]) => `${path}: ${reference}`));
  assert.deepEqual(violations, [], "public package surfaces must use self-contained wording");
});

test("every relative markdown link in a first-party packed file resolves inside the package", () => {
  const entries = new Set(packedEntries);
  const unresolved = [];
  // Upstream READMEs refer to their upstream source repositories. Preserve
  // their distributed bytes; their hashes are verified by the release gate.
  for (const path of packedEntries.filter((entry) => /\.md$/i.test(entry) && !isRuntimeDependencyPath(entry))) {
    const markdown = readFileSync(join(ROOT, path), "utf8").replace(/^(```|~~~)[\s\S]*?^\1[^\n]*$/gm, "");
    const inline = [...markdown.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^\n]*?)?\s*\)/g)];
    const definitions = [...markdown.matchAll(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>]+>|\S+)/gm)];
    for (const [, destination] of [...inline, ...definitions]) {
      const href = destination.replace(/^<|>$/g, "");
      if (/^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(href)) continue;
      const local = decodeURIComponent(href.split(/[?#]/)[0]);
      const target = posix.normalize(posix.join(posix.dirname(path), local));
      if (!entries.has(target)) unresolved.push(`${path}: ${href} -> ${target}`);
    }
  }
  assert.deepEqual(unresolved, [], "relative links must work for installed-package readers");
});

test("install guides disclose the external onboarding probe and local retrieval", () => {
  // The private alpha install prompt is checked where it exists; the public cut omits it.
  const alphaPrompt = existsSync(join(ROOT, "packaging/alpha/INSTALL.md")) ? ["packaging/alpha/INSTALL.md"] : [];
  for (const file of ["README.md", "docs/install.md", "docs/quickstart.md", "SECURITY.md", ...alphaPrompt]) {
    const prose = readFileSync(join(ROOT, file), "utf8");
    assert.ok(prose.includes("https://api.github.com/zen"), `${file} must name the default external target`);
    assert.ok(prose.includes("--probe <url>"), `${file} must disclose the target override`);
    assert.ok(prose.includes("--offline"), `${file} must retain the optional no-probe mode`);
    assert.ok(prose.includes("context query --onboarding"), `${file} must explain local observation retrieval`);
    assert.doesNotMatch(prose, /nothing to check yet/i, `${file} must not promise the superseded no-target default`);
  }
});

test("package metadata is publishable and the allowlist stays public-ready", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.license, "Apache-2.0");
  assert.equal(pkg.private, undefined);
  assert.ok(pkg.bin.sannr);
  assert.ok(pkg.files.includes("docs/README.md"));
  assert.ok(!pkg.files.includes("docs/"), "public docs use an explicit allowlist");
  const out = mkdtempSync(join(tmpdir(), "sannr-pack-"));
  try {
    execFileSync("npm", ["pack", "--ignore-scripts", "--offline", "--pack-destination", out],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const tar = readdirSync(out).find((f) => f.endsWith(".tgz"));
    const listing = execFileSync("tar", ["tzf", join(out, tar)], { encoding: "utf8" });
    assert.doesNotMatch(listing, /(^|\/)(evidence|results)\//);
    for (const entry of listing.trim().split('\n').filter(entry => entry.includes('/node_modules/')))
      assert.ok(isRuntimeDependencyPath(entry.replace(/^package\//, '')), `Unpinned runtime dependency: ${entry}`);
    assert.doesNotMatch(listing, /\.env$/);
    const publicText = execFileSync("tar", ["xOf", join(out, tar), "package/README.md"], { encoding: "utf8" });
    assert.doesNotMatch(publicText, /\/Users\/|\/private\/var\/|private archives/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
