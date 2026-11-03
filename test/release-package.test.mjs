import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { stagePackage } from "../scripts/stage-package.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERIFY = join(ROOT, "scripts", "verify-package.mjs");
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Pin the launch package boundaries independently of the verifier. This is
// package.json's packaging allowlist, plus npm's mandatory package.json.
// Feedback API v1 adds its read-only provider stack and the explicit-send
// guide; CONTEXT-2a adds the shipped discovery guide. Keep this list exact: widening the package's files list
// still requires a deliberate test change.
const FILES = ["bin/", "lib/", "skill/", "stacks/", "server.mjs", "README.md",
  "CHANGELOG.md", "SUPPORT.md", "SECURITY.md", "TRADEMARK.md", "docs/README.md", "docs/install.md", "docs/privacy.md", "docs/limitations.md", "docs/troubleshooting.md", "docs/agent-examples.md", "docs/agent-guide.md", "docs/api-call-policy.md", "docs/ci.md", "docs/dependency-graph-design.md", "docs/dependency-graph.md", "docs/discovery.md", "docs/feedback.md", "docs/imports.md", "docs/install-prompt.md", "docs/layout.md", "docs/stacks.md", "docs/survey.md", "docs/mcp.md", "docs/network-behavior.md", "docs/note-history.md", "docs/protocols.md", "docs/quickstart.md", "docs/sessions.md", "docs/saved-requests.md", "docs/workbench.md", "docs/workbench-security.md", "docs/view.md", "LICENSE", "scripts/write-build-id.mjs"];
const CONTEXT_RUNTIME_FILES = ['lib/draft-notes.mjs', 'lib/evidence-confidence.mjs'];
const BUILTIN_STACK_FILES = ["stacks/sannr-feedback/stack.json", "stacks/sannr-feedback/feedback.openapi.json", "stacks/sannr-feedback/sannr.json"];
const BASE = [
  { name: "package/package.json", body: JSON.stringify(PKG) },
  ...FILES.filter(name => name !== "stacks/").map((name) => ({ name: `package/${name}${name.endsWith("/") ? "entry.mjs" : ""}`, body: "fixture\n" })),
  ...BUILTIN_STACK_FILES.map(name => ({ name: `package/${name}`, body: readFileSync(join(ROOT, name), "utf8") })),
];

// Tiny fixture writer keeps hostile names/links intact: no extracting into
// the repository and no platform-specific tar transform options.
function archive(dir, entries) {
  const blocks = [];
  for (const { name, body = "", type = "0", link = "" } of entries) {
    const bytes = Buffer.from(body);
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const path = join(dir, "fixture.tgz");
  writeFileSync(path, gzipSync(Buffer.concat(blocks)));
  return path;
}

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "sannr-release-pack-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function verify(path) {
  return spawnSync(process.execPath, [VERIFY, path], { cwd: ROOT, encoding: "utf8" });
}

test("release packaging uses the existing launch allowlist", () => {
  assert.deepEqual(PKG.files, FILES);
});

test("release verifier accepts the actual npm pack artifact", (t) => {
  const dir = scratch(t);
  const staged = stagePackage(ROOT, join(dir, "source"));
  execFileSync("npm", ["pack", "--pack-destination", dir],
    { cwd: staged, stdio: ["ignore", "pipe", "pipe"] });
  const path = join(dir, readdirSync(dir).find((name) => name.endsWith(".tgz")));
  const result = verify(path);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Verified .* entries against package\.json files allowlist/);
  const entries = new Set(execFileSync("tar", ["tzf", path], { encoding: "utf8" }).trim().split("\n"));
  for (const file of [...BUILTIN_STACK_FILES, ...CONTEXT_RUNTIME_FILES, "docs/feedback.md"])
    assert.ok(entries.has(`package/${file}`), `Required package payload missing: ${file}`);
});

test('release verifier permits the exact context runtime modules, never evidence files beside or below them', t => {
  const dir = scratch(t);
  const result = verify(archive(dir, [...BASE, ...CONTEXT_RUNTIME_FILES.map(file => ({ name: `package/${file}`, body: 'export {};\n' }))]));
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['package/docs/evidence-confidence.mjs', 'package/lib/evidence-confidence.mjs/run.json',
    'package/lib/evidence-confidence.json', 'package/lib/evidence-other.mjs']) {
    const refused = verify(archive(dir, [...BASE, { name }]));
    assert.notEqual(refused.status, 0, name);
    assert.match(refused.stderr, /unsafe.*entry/i, refused.stderr);
  }
});

test("release verifier rejects files outside the package allowlist", (t) => {
  const dir = scratch(t);
  for (const name of ["package/shell/main.mjs", "package/test/private.mjs", "other/README.md"]) {
    const result = verify(archive(dir, [...BASE, { name }]));
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /outside.*allowlist/i, result.stderr);
  }
});

test("release verifier rejects dangerous entries even inside allowed directories", (t) => {
  const dir = scratch(t);
  for (const name of ["package/lib/../secret", "/package/lib/secret", "package/lib/.env",
    "package/docs/.env.production", "package/lib/evidence/run.json", "package/docs/results/run.json",
    "package/lib/node_modules/a/index.js", "package/lib/private.tgz", "package/lib/back\\slash"]) {
    const result = verify(archive(dir, [...BASE, { name }]));
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /unsafe.*entry/i, result.stderr);
  }
});

test("release verifier rejects links and duplicate archive members", (t) => {
  const dir = scratch(t);
  for (const extra of [
    { name: "package/lib/link.mjs", type: "2", link: "../../secret" },
    { name: "package/lib/link.mjs", type: "1", link: "package/README.md" },
    BASE[0],
  ]) {
    const result = verify(archive(dir, [...BASE, extra]));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /links|duplicate/i, result.stderr);
  }
});

test("release verifier rejects missing allowlisted payloads", (t) => {
  const dir = scratch(t);
  for (const missing of ["package/package.json", "package/server.mjs", "package/skill/entry.mjs", "package/docs/feedback.md", "package/stacks/"]) {
    const result = verify(archive(dir, BASE.filter(({ name }) => name !== missing && !(missing.endsWith("/") && name.startsWith(missing)))));
    assert.notEqual(result.status, 0, missing);
    assert.match(result.stderr, /missing/i, result.stderr);
  }
});

test("release verifier binds the archive manifest to the checked-out package", (t) => {
  const dir = scratch(t);
  for (const changed of [{ ...PKG, version: "999.0.0" }, { ...PKG, files: [...PKG.files, "shell/"] }]) {
    const result = verify(archive(dir, [
      { name: BASE[0].name, body: JSON.stringify(changed) }, ...BASE.slice(1),
    ]));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /manifest.*match/i, result.stderr);
  }
});

test('release verifier accepts omitted optional dependencies and rejects unpinned bundled files', t => {
  const dir = scratch(t);
  const missing = verify(archive(dir, BASE));
  assert.equal(missing.status, 0, missing.stderr);
  const unknown = verify(archive(dir, [...BASE, { name: 'package/node_modules/unrelated/index.js', body: 'private data' }]));
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /unsafe archive entry/i);
  const changed = verify(archive(dir, [...BASE, { name: 'package/node_modules/graphql/index.js', body: 'changed dependency bytes' }]));
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /unsafe archive entry/i);
});

test("release verifier requires exactly one tarball argument", () => {
  const result = spawnSync(process.execPath, [VERIFY], { cwd: ROOT, encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Usage:.*verify-package\.mjs.*\.tgz/);
});
