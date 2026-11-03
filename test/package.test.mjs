import { LAYOUT } from "../lib/layout.mjs";
// THE INSTALLED COPY — does this work when it is not a git clone?
//
//   node --test test/package.test.mjs
//
// Every other suite runs the CLI out of the repo, where `files` in package.json
// is inert and every file is present because it is checked in. That is exactly
// the blind spot: the `files` array is the only thing standing between "works
// on my machine" and a tester's `npm install` producing a package with a
// missing piece — and the pieces that go missing are the ones no import
// statement mentions, so no linter, type-checker or unit test can catch it.
// `skill/` was one: it was not in `files`, so an installed copy shipped no
// skills, `connect` installed nothing, the write convention never reached the
// agent, and NOTHING ACCUMULATED. The tool would have looked like it worked.
//
// So this suite refuses to trust the repo. It packs the package the way npm
// does, extracts the tarball somewhere with no repo anywhere above it, and
// RUNS things out of the extracted copy: the CLI, and the MCP server over
// JSON-RPC. What it asserts is behaviour from that copy, never the shape of a
// file list, because a file list is a claim and a running binary is evidence.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname, relative, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";

import { PRODUCT, MCP_SERVER_KEY } from "../lib/brand.mjs";
import { stagePackage } from "../scripts/stage-package.mjs";
import { isRuntimeDependencyPath, verifyRuntimeDependency } from '../lib/runtime-dependencies.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));

// Where the extracted package lives, and the scratch HOME every run gets. Set
// once in `before` because `npm pack` is the slowest thing in the suite and
// packing per test would pay for it five times over.
let PACKED = null;      // <tmp>/package — the extracted tarball
let SCRATCH = null;     // a tmpdir to keep everything else in

before(() => {
  SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), "packed-")));
  // Lifecycle generation belongs to this isolated copy, never the shared engine.
  const staged = stagePackage(ROOT, join(SCRATCH, "source"));
  execFileSync("npm", ["pack", "--pack-destination", SCRATCH],
    { cwd: staged, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const tgz = join(SCRATCH, `${PKG.name.replace(/^@/, "").replace("/", "-")}-${PKG.version}.tgz`);
  assert.ok(existsSync(tgz), `npm pack produced no ${basename(tgz)}`);
  const into = join(SCRATCH, "installed");
  mkdirSync(into, { recursive: true });
  execFileSync("tar", ["xzf", tgz, "-C", into]);
  PACKED = join(into, "package");                    // npm's fixed tarball prefix
});

after(() => { if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true }); });

// --- running things out of the extracted copy -------------------------------

// A scratch repo with NO relationship to this one: tmpdir, its own git root,
// its own HOME. Nothing here can reach back into the source tree, which is the
// point — a test that accidentally resolves a file from the repo proves
// nothing about an install.
function scratchRepo(files = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "packed-repo-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "packed-home-")));
  return { dir, home };
}

// Run the EXTRACTED cli by absolute path, with a PATH that cannot resolve a
// globally installed copy. This machine has one on its PATH (the source clone,
// installed with `npm install -g .`), and a test that shelled out to the bare
// name would have silently measured the repo instead of the tarball — the
// exact confusion this suite exists to remove.
function packedCli(cwd, args, env = {}) {
  try {
    const out = execFileSync(process.execPath, [join(PACKED, "bin", "cli.mjs"), ...args],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: "/usr/bin:/bin", ...env } });
    return { code: 0, out };
  } catch (e) { return { code: e.status ?? 1, out: (e.stdout ?? "") + (e.stderr ?? "") }; }
}

/** Speak JSON-RPC to a server, exactly as an MCP host spawns one. */
function rpc(serverPath, { cwd, env = {}, messages, timeoutMs = 20_000 }) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [serverPath],
      { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const wanted = messages.filter((m) => m.id !== undefined).length;
    const replies = [];
    let buf = "", err = "";
    const done = (fn, v) => { clearTimeout(timer); child.kill(); fn(v); };
    const timer = setTimeout(() => done(rej, new Error(`no reply in ${timeoutMs}ms; stderr: ${err}`)), timeoutMs);
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (c) => {
      buf += c;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) { try { replies.push(JSON.parse(l)); } catch { /* not JSON-RPC */ } }
      if (replies.length >= wanted) done(res, replies);
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  });
}

// --- 1. completeness, derived rather than listed ----------------------------

// The module graph, followed from the package's own entry points. A hand-kept
// list of "files the package needs" is the same kind of claim as `files`
// itself, and it goes stale the same way; this one cannot, because it is read
// from the imports that actually exist.
function moduleGraph(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const f = resolve(queue.pop());
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const src = readFileSync(f, "utf8");
    // Static `from "…"` and dynamic `import("…")`, relative specifiers only —
    // Bundled bare dependencies are checked against the pinned inventory below.
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g))
      queue.push(join(dirname(f), m[1]));
  }
  return seen;
}

test("the package ships every file its own entry points import", () => {
  // The failure this catches: a new lib/ module lands, `files` still lists
  // directories so it is included by luck, and the day someone tightens the
  // array to individual files the install breaks for a reason nobody can see.
  const entries = [
    ...Object.values(PKG.bin ?? {}),
    ...(typeof PKG.exports === "string" ? [PKG.exports] : Object.values(PKG.exports ?? {})),
    PKG.main,
  ].filter(Boolean).map((p) => join(ROOT, p));
  const missing = [...moduleGraph(entries)]
    .map((f) => relative(ROOT, f))
    .filter((rel) => !existsSync(join(PACKED, rel)));
  assert.deepEqual(missing, [], `imported at runtime but not in the tarball: ${missing.join(", ")}`);
});

test("the package ships the skills — the accumulation mechanism, not an extra", async () => {
  // Pinned separately from the module graph because NOTHING IMPORTS THEM. The
  // skills are read from disk by path at connect time, so every static check
  // in this repo passes with them missing, and the only symptom in the field
  // is a knowledge file that never grows.
  // The paths come from connect's own SKILL_SOURCES, made relative to the repo
  // — so a skill that is added, renamed or moved is covered here the day it
  // lands, without anyone remembering to edit this list.
  const { SKILL_SOURCES } = await import("../lib/connect.mjs");
  assert.ok(SKILL_SOURCES.length, "connect declares no skills to install");
  for (const src of SKILL_SOURCES) {
    const rel = relative(ROOT, src);
    assert.ok(existsSync(join(PACKED, rel)), `${rel} is not in the tarball — an installed copy has no skills`);
  }
});

test("the tarball carries no evidence, no secrets, and nothing from a working tree", () => {
  // `files` is an allowlist, but a directory entry in it ships whatever is
  // inside on the packing machine. Evidence bodies and .env files are the two
  // that would be catastrophic and silent.
  const listed = execFileSync("tar", ["tzf",
    join(SCRATCH, `${PKG.name.replace(/^@/, "").replace("/", "-")}-${PKG.version}.tgz`)],
    { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const bad of [/(^|\/)evidence\//, /\.env$/, /(^|\/)\.git\//, /\.tgz$/])
    assert.ok(!listed.some((f) => bad.test(f)), `${bad} matched in the tarball: ${listed.filter((f) => bad.test(f))}`);
  for (const entry of listed.filter(path => path.includes('/node_modules/') && !path.endsWith('/'))) {
    const path = entry.replace(/^package\//, '');
    assert.ok(isRuntimeDependencyPath(path), `Unpinned dependency file: ${path}`);
    assert.ok(verifyRuntimeDependency(path, readFileSync(join(PACKED, path))), `Changed dependency: ${path}`);
  }
});

// --- 2. it RUNS from the extracted copy, with no repo present ---------------

test("the extracted copy is self-contained: nothing resolves back into the repo", () => {
  // The install lives in a tmpdir with no package.json above it, so a file the
  // package forgot cannot be quietly satisfied by the source tree.
  assert.ok(!PACKED.startsWith(ROOT), `${PACKED} is inside the repo; this suite would prove nothing`);
  assert.equal(existsSync(join(PACKED, 'node_modules')), false, 'optional adapters are not shipped inside the package');
  const imports = execFileSync(process.execPath, ['--input-type=module', '-e',
    "await import('./lib/client.mjs'); await import('./lib/mcp-inspect.mjs'); console.log('core loads without protocol packages')"],
  { cwd: PACKED, encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.match(imports, /core loads without protocol packages/);
});

test("the CLI runs from the extracted copy and prints its own help", () => {
  const { dir } = scratchRepo();
  const { code, out } = packedCli(dir, ["--help"]);
  assert.equal(code, 0, out);
  assert.match(out, new RegExp(PRODUCT), "help does not name the product");
  assert.match(out, /\bmap\b/, "the day-one command is not in help");
});

test("map runs from the extracted copy and reports a real repo's footprint", () => {
  // The day-one value, from an installed copy, against a repo it has never
  // seen — the first thing a tester does, and the first thing that would have
  // broken if lib/ shipped incompletely.
  const { dir } = scratchRepo({
    "openapi.yaml": "openapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\npaths:\n  /orders:\n    get:\n      summary: s\n",
    "src/app.js": 'await fetch("https://api.stripe.com/v1/charges");\n',
  });
  const { code, out } = packedCli(dir, ["map", ".", "--text", "--no-execute"]);
  assert.equal(code, 0, out);
  assert.match(out, /API footprint/);
  assert.match(out, /api\.stripe\.com/, "the external dependency is not on the map");
});

test("doctor runs from the extracted copy and names a fix for every problem", () => {
  const { dir, home } = scratchRepo();
  const { out } = packedCli(dir, ["doctor", "--offline"], { HOME: home });
  assert.match(out, /contract/, "doctor did not run its checks");
  assert.ok(/fix:/.test(out), "a failing check with no fix is a dead end for a newcomer");
});

// --- 3. the whole adoption path, from the installed copy --------------------

test("connect from the installed copy wires an agent AND installs the skills", async () => {
  // The end-to-end version of the `files` bug: connect resolves its skill
  // sources relative to its OWN location, so from the tarball it reads the
  // packed skill/ directory. If that directory did not ship, this is where it
  // shows — the registration lands, the pointer block lands, and the write
  // convention silently does not.
  const { dir, home } = scratchRepo({
    "openapi.yaml": "openapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\npaths:\n  /orders:\n    get:\n      summary: s\n",
    [LAYOUT.environments]: JSON.stringify({ v: 1, default: "local",
      environments: { local: { baseUrl: "http://127.0.0.1:9101" } } }),
  });
  const { code, out } = packedCli(dir, ["connect"], { HOME: home });
  assert.equal(code, 0, out);

  for (const skills of [join(dir, ".claude", "skills"), join(dir, ".agents", "skills")]) {
    assert.ok(existsSync(skills), `connect installed no skills at ${skills}`);
    const installed = readFileSync(join(skills, "sannr-write", "SKILL.md"), "utf8");
    assert.match(installed, /record/i, `the write-convention skill did not survive at ${skills}`);
  }

  // And the registration points at the INSTALLED server, not this repo's.
  const entry = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers[MCP_SERVER_KEY];
  assert.ok(entry, `no MCP registration:\n${out}`);
  assert.ok(entry.args[0].startsWith(PACKED),
    `the registration points at ${entry.args[0]}, not the installed copy`);
  assert.ok(!entry.args[0].startsWith(ROOT), "an installed copy registered the source clone");

  // Codex receives a project-scoped registration that points at the same
  // extracted package, not at a globally installed or source-tree copy.
  const codex = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
  assert.match(codex, /\[mcp_servers\.sannr\]/);
  assert.match(codex, new RegExp(PACKED.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(codex, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("the MCP server launches from the extracted copy and offers its tool", async () => {
  // The registration above is only a claim until something speaks to it. This
  // launches the packed server from a cwd it has never seen (an MCP host picks
  // its own), and requires a tools/list a host can actually use.
  const { dir, home } = scratchRepo();
  const replies = await rpc(join(PACKED, "server.mjs"), {
    cwd: dir,
    env: { HOME: home, API_BASE_URL: "http://127.0.0.1:9101", API_EVIDENCE: join(dir, "evidence") },
    messages: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ],
  });
  const init = replies.find((r) => r.id === 1);
  assert.ok(init?.result?.serverInfo?.name, `initialize returned no serverInfo: ${JSON.stringify(init)}`);
  const tools = replies.find((r) => r.id === 2)?.result?.tools ?? [];
  assert.ok(tools.some((t) => t.name === "api_request"),
    `the packed server offers no api_request tool: ${JSON.stringify(tools)}`);
  assert.ok(tools[0].inputSchema, "a tool with no input schema is unusable by a host");
});

// --- 4. the incomplete install ---------------------------------------------

test("a package missing its skills says so, and never prints a stack trace", () => {
  // The `files` array now ships skill/, so our own tarball cannot land here.
  // A user's copy still can: a half-finished extract, a vendored subset, a
  // stale global install from before the fix. What that user got was an
  // ENOENT stack trace out of readFileSync on the FIRST command they ran,
  // which reads as "this tool is broken" rather than "this copy is
  // incomplete" — and those have very different next steps.
  const broken = join(SCRATCH, "broken");
  mkdirSync(broken, { recursive: true });
  execFileSync("cp", ["-R", `${PACKED}/.`, broken]);
  rmSync(join(broken, "skill"), { recursive: true, force: true });

  const { dir, home } = scratchRepo({
    "openapi.yaml": ("openapi: 3.0.0\ninfo:\n  title: t\n  version: '1'\npaths:\n  /o:" + "\n    get:\n      summary: s\n"),
  });
  let out;
  try {
    out = execFileSync(process.execPath, [join(broken, "bin", "cli.mjs"), "connect"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } });
  } catch (e) { out = (e.stdout ?? "") + (e.stderr ?? ""); }
  assert.ok(!/at \w+ \(node:/.test(out), `a stack trace reached the user:\n${out}`);
  assert.match(out, /SKILL_NOT_FOUND/, "the failure is not named");
  assert.match(out, /reinstall/i, "the error does not say what to do about it");

  let doctorOut;
  try {
    doctorOut = execFileSync(process.execPath, [join(broken, "bin", "cli.mjs"), "doctor", "--offline", "--json"],
      { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" } });
  } catch (e) { doctorOut = (e.stdout ?? "") + (e.stderr ?? ""); }
  assert.ok(!/ENOENT|at \w+ \(node:/.test(doctorOut), `doctor crashed on an incomplete package:\n${doctorOut}`);
  const doctorJson = JSON.parse(doctorOut.slice(doctorOut.indexOf("{")));
  const skillCheck = doctorJson.checks.find((c) => c.name === "skills");
  assert.equal(skillCheck.state, "FAIL");
  assert.match(skillCheck.fix, /reinstall/i);
});
