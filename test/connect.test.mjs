import { LAYOUT } from "../lib/layout.mjs";
import { stableNodeCommand } from "../lib/node-runtime.mjs";
// CONNECT — the adoption mechanic: the path from "a stranger heard about this"
// to "it is running in their repo and wired to their agent", in one command.
//
//   node --test test/connect.test.mjs
//
// Written before the implementation. lib/brand.mjs and lib/connect.mjs do not
// exist yet and `connect` is an unknown command: this suite fails on the
// missing import and the non-zero exit until they do.
//
// What it pins, in the order a tester meets it:
//   1. the NAME is a single point (lib/brand.mjs) — everything derives from it
//   2. connect writes an MCP registration a host can actually launch (proved by
//      launching it and speaking JSON-RPC, not by asserting on JSON shape)
//   3. it MERGES — a pre-existing unrelated server survives, a foreign entry
//      under our key is a reported conflict and never overwritten
//   4. it is idempotent (twice = byte-identical) and reversible (unwire)
//   5. the agent-facing files (skills + pointer block) come with it, because a
//      tester who does not get the write convention accumulates nothing

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync,  readFileSync, readdirSync, existsSync,
  rmSync, realpathSync, symlinkSync, chmodSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCT, MCP_SERVER_KEY, POINTER_BEGIN, POINTER_END, TOOL_NAME,
  PROSE_SURFACES, PRIVATE_SURFACES, STATE_DIR_NAME, NPM_PACKAGE, SKILL_NAMES, FEEDBACK_ASSET_DIRECTORY, FEEDBACK_ORIGIN,} from "../lib/brand.mjs";
import { CONTEXT_FILE } from "../lib/context.mjs";
import { capabilityManifest } from "../lib/capabilities.mjs";
import { CODEX_TOOL_TIMEOUT_SEC, SKILL_SOURCES, codexServerBlock, projectEntry,
  renderSkill, serverEntry } from "../lib/connect.mjs";
import {
  LIBRARIAN_MCP_SERVER_KEY, LIBRARIAN_NAME, librarianServerEntry, librarianTargets,
} from "../lib/librarian.mjs";
import { start } from "./fixture-server.mjs";
import { productMentionPattern, unlistedProseSurfaces } from "./brand-guard-helpers.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const SOURCE_CLI = `node ${CLI}`;
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Run the CLI in a scratch repo, capturing output and exit code, never throwing.
function cli(cwd, args, env = {}) {
  const result = spawnSync("node", [CLI, ...args],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  const stdout = result.stdout ?? "", stderr = result.stderr ?? "";
  // Keep announcements and errors available for diagnostics while callers parse
  // machine-readable JSON from its own stdout stream, even on nonzero exits.
  return { code: result.status ?? 1, stdout, stderr,
    out: stdout + stderr + (result.error ? String(result.error) : "") };
}

// A clean scratch REPO — the DONE condition's setting. git init because the CLI
// locates the project by `git rev-parse`, exactly as it does in a real repo.
// HOME is redirected so global-host detection (~/.codex and friends) reads a
// controlled tree instead of whatever the developer running the suite happens
// to have installed.
function scratch({ config, files } = {}) {
  // realpath: on macOS /tmp is a symlink to /private/tmp and `git rev-parse`
  // resolves it, so a test comparing paths against the CLI's output must start
  // from the same resolved form or it fails on an artefact of the tmpdir.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "connect-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"),
    "openapi: 3.0.0\ninfo:\n  title: t\npaths:\n  /json:\n    get:\n      summary: s\n");
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify(config ?? {
    v: 1, default: "local", environments: { local: { baseUrl: "http://127.0.0.1:9101" } },
  }, null, 2));
  for (const [p, body] of Object.entries(files ?? {})) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  const home = realpathSync(mkdtempSync(join(tmpdir(), "connect-home-")));
  return { dir, home, env: { HOME: home } };
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

// Speak JSON-RPC to a server launched EXACTLY as a registration declares it —
// its command, its args, its env — from a cwd we choose. The cwd is the point:
// an MCP host spawns servers from wherever it happens to be, so anything the
// server resolves against process.cwd() is a live grenade the suite must be
// able to pull the pin on.
function rpc(entry, { cwd, env = {}, messages, timeoutMs = 20_000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args,
      { cwd, env: { ...process.env, ...env, ...entry.env }, stdio: ["pipe", "pipe", "pipe"] });
    const wanted = messages.filter((m) => m.id !== undefined).length;
    const replies = [];
    let buf = "", err = "";
    const done = (fn, v) => { clearTimeout(timer); child.kill(); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`no reply within ${timeoutMs}ms; stderr: ${err}`)), timeoutMs);
    child.stderr.on("data", (d) => { err += d; });
    child.stdout.on("data", (c) => {
      buf += c;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) { try { replies.push(JSON.parse(l)); } catch { /* not JSON-RPC */ } }
      if (replies.length >= wanted) done(resolve, replies);
    });
    child.stdin.write(`${messages.map((m) => JSON.stringify(m)).join("\n")}\n`);
  });
}

// --- 1. the name is a single point -----------------------------------------

test("renaming the product renames every user-visible mention, in one edit", () => {
  // The seam: brand.mjs reads an override so this claim is testable rather than
  // asserted. Derived user-visible names must change. The feedback service's
  // pinned origin and shipped physical asset directory are independent fixed
  // identities: renaming the local product must not invent another endpoint or
  // hide the actual installed path from the capability manifest.
  const { dir, env } = scratch();
  const renamed = { ...env, API_CONTEXT_PRODUCT_NAME: "zzrenamed" };
  for (const args of [["--help"], ["capabilities"], ["init", "--help"]]) {
    const { out } = cli(dir, args, renamed);
    let userVisible = out.replaceAll(SOURCE_CLI, "zzrenamed");
    if (args[0] === "capabilities") {
      assert.ok(out.includes(FEEDBACK_ORIGIN), "the security manifest must retain the real pinned service origin");
      assert.ok(out.includes(FEEDBACK_ASSET_DIRECTORY), "the security manifest must retain the installed physical asset path");
      // Exact constants only, scoped to capabilities. Any other old-brand
      // string (including the logical stack name) still fails this gate.
      userVisible = userVisible.replaceAll(FEEDBACK_ORIGIN, "<fixed-feedback-origin>")
        .replaceAll(FEEDBACK_ASSET_DIRECTORY, "<fixed-feedback-assets>");
    }
    assert.doesNotMatch(userVisible, productMentionPattern(PRODUCT),
      `\`${args.join(" ")}\` still prints the old name after a rename:\n${out}`);
    assert.match(userVisible, /zzrenamed/, `\`${args.join(" ")}\` never prints the new name`);
  }
});

/**
 * A scratch repo with this package installed AS A DEPENDENCY, laid out the way
 * npm actually does it: the package under <repo>/node_modules/<name>, the shim
 * at <repo>/node_modules/.bin/<name>. That layout is what makes CLI_NAME
 * resolve to `./node_modules/.bin/<name>`, so it is the only setting in which
 * a bare-name instruction is visibly wrong.
 *
 * The returned runner calls the copy under node_modules by absolute path with
 * a PATH that cannot reach a global install — this machine has one, and a test
 * that shelled out to the bare name would silently measure it instead.
 */
function perProjectInstall(opts) {
  const { dir, env } = scratch(opts);
  const pkgDir = join(dir, "node_modules", PRODUCT);
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const packDir = join(dir, "pack");
  mkdirSync(packDir);
  const packed = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--pack-destination", packDir, "--json"], { cwd: ROOT, encoding: "utf8" }))[0].filename;
  mkdirSync(pkgDir, { recursive: true });
  execFileSync("tar", ["-xzf", join(packDir, packed), "--strip-components=1", "-C", pkgDir]);
  assert.equal(existsSync(join(pkgDir, ".git")), false, "packed install surface contains .git");
  writeFileSync(join(dir, "node_modules", ".bin", PRODUCT), "#!/bin/sh\n");
  chmodSync(join(dir, "node_modules", ".bin", PRODUCT), 0o755);
  const local = (args) => {
    try {
      return execFileSync("node", [join(pkgDir, "bin", "cli.mjs"), ...args],
        { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
    } catch (e) { return (e.stdout ?? "") + (e.stderr ?? ""); }
  };
  return { dir, env, local };
}

test("a bare checkout prints its actual node invocation instead of assuming PATH", () => {
  const { dir, env } = scratch();
  const tool = join(dir, "tool");
  execFileSync("cp", ["-R", `${ROOT}/.`, tool]);
  rmSync(join(tool, "node_modules"), { recursive: true, force: true });
  const out = execFileSync("node", ["tool/bin/cli.mjs", "connect"],
    { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin` } });
  const bare = out.split("\n").filter((l) =>
    new RegExp(`(?:^|[\`\\s:])${PRODUCT}\\s+(?:doctor|learn|init|map|receipt|unwire|audit)\\b`).test(l));
  assert.deepEqual(bare, [], `these lines assume an uninstalled command is on PATH:\n${bare.join("\n")}`);
  assert.match(out, new RegExp(escapeRegExp(`node ${join(tool, "bin", "cli.mjs")}`)),
    "the checkout's runnable node invocation is never shown");

  const block = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.doesNotMatch(block, new RegExp(escapeRegExp(`./node_modules/.bin/${PRODUCT}`)),
    `a bare checkout advertised a repo-local shim that does not exist:\n${block}`);
  assert.match(block, /api_request.*never raw-curl/is,
    `the missing portable tier has no MCP verb fallback:\n${block}`);
  assert.doesNotMatch(block, new RegExp(escapeRegExp(join(tool, "bin", "cli.mjs"))),
    `the committed pointer block leaks this checkout's absolute path:\n${block}`);
});

test("a packed project install supplies portable commands and removable runnable skills", async () => {
  // The README offers two installs. The global one puts the bin on PATH and
  // every `Run: sannr doctor` in the output is true. The per-project one
  // (`npm install --save-dev …`) does not, and every one of those lines is
  // then a command-not-found for a newcomer who has installed the tool
  // correctly — including the pointer block written into their AGENTS.md,
  // where a TEAMMATE reads it later with no idea what went wrong.
  //
  const { dir, local } = perProjectInstall();
  const out = local(["connect"]);
  // Every instruction to run the tool must carry a path, because the bare name
  // is not resolvable from this repo.
  const bare = out.split("\n").filter((l) =>
    new RegExp(`(?:^|[\`\\s:])${PRODUCT}\\s+(?:doctor|learn|init|map|receipt|unwire|audit)\\b`).test(l) &&
    !l.includes(`node_modules/.bin/${PRODUCT}`));
  assert.deepEqual(bare, [], `these lines tell the reader to run a command they do not have:\n${bare.join("\n")}`);
  assert.match(out, new RegExp(`${PRODUCT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin/cli\\.mjs`),
    "terminal output omitted the verified local invocation");

  // And the block left in their repo, which outlives the terminal output.
  const block = readFileSync(join(dir, "AGENTS.md"), "utf8");
  assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n");
  assert.match(block, new RegExp(`node_modules/\\.bin/${PRODUCT}`),
    `the pointer block tells a teammate to run a bare command:\n${block}`);
  for (const host of [".claude", ".agents"]) {
    const installed = readFileSync(join(dir, host, "skills", SKILL_NAMES.write, "SKILL.md"), "utf8");
    const bareCommands = installed.split("\n").filter(line =>
      new RegExp(`(?:^|[\\s\`(])${PRODUCT}\\s+(?:note|verdict)\\b`).test(line)
      && !line.includes(`node_modules/.bin/${PRODUCT}`));
    assert.deepEqual(bareCommands, [], `${host}: installed convention must use the local executable`);
  }
  local(["unwire"]);
  for (const host of [".claude", ".agents"])
    assert.equal(existsSync(join(dir, host, "skills", SKILL_NAMES.write, "SKILL.md")), false);
});

test("no module hardcodes a name brand.mjs already declares", () => {
  // The rename test above proves the OUTPUT is clean. This proves the SOURCE
  // is, which is the difference between "one edit" and "one edit plus whatever
  // the next person greps for". Both of these were real: STATE_DIR_NAME was
  // declared in brand.mjs and used nowhere (client.mjs spelled the directory
  // out twice), and the MCP server announced a serverInfo name that no
  // constant knew about — so a rename left the tool identifying itself to
  // every host under the old name, in the one place a user cannot edit.
  const files = ["lib/client.mjs", "lib/capabilities.mjs", "server.mjs", "lib/stdio-server.mjs"];
  for (const f of files) {
    const src = readFileSync(join(ROOT, f), "utf8");
    // Strip comments: the reasons a name is what it is are prose, and prose
    // naming it is documentation, not a second source of truth.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n")
      .filter((l) => !/^\s*(\/\/|\*)/.test(l)).join("\n");
    assert.doesNotMatch(code, new RegExp(`["'\`][^"'\`]*${STATE_DIR_NAME}`),
      `${f} spells the state directory out instead of deriving it from brand.STATE_DIR_NAME`);
  }
  const server = readFileSync(join(ROOT, "lib/stdio-server.mjs"), "utf8");
  assert.doesNotMatch(server, /name:\s*["'][a-z-]*api[a-z-]*["']/,
    "stdio-server.mjs hardcodes the name it announces to every MCP host");
});

test("the name the MCP server announces comes from a constant, not a literal", async () => {
  // The host-facing identity is the one user-visible string a user CANNOT fix
  // themselves: it arrives over the wire from a server they did not write. It
  // used to be the literal "api-request-poc", which no constant knew about —
  // an orphan a rename could not reach and nobody would notice, because it
  // shows up in a host's server list and never in our own output.
  //
  // It tracks MCP_SERVER_KEY, which NAME-1 derives from PRODUCT. The measured
  // tool verb remains independent. Pinning the announced identity here ensures
  // the announced name and registered key cannot drift apart, including when
  // the product-name seam is overridden.
  const { dir, env } = scratch();
  const replies = await rpc({ command: "node", args: [join(ROOT, "server.mjs")] }, {
    cwd: dir,
    env: { ...env, API_CONTEXT_PRODUCT_NAME: "zzrenamed", API_BASE_URL: "http://127.0.0.1:9101" },
    messages: [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }],
  });
  const name = replies.find((r) => r.id === 1)?.result?.serverInfo?.name;
  assert.equal(name, "zzrenamed",
    `the server announces '${name}', which is not the key it is registered under`);
  assert.notEqual(name, "api-request-poc", "the orphaned literal is still in server.mjs");
});

test("the prose surfaces a rename must edit by hand are listed, and the list is true", () => {
  // brand.mjs claims markdown is the one place a rename is manual and names the
  // files. An inventory nobody checks goes stale and sends the renamer looking
  // in the wrong places, which is worse than no inventory: pin it both ways.
  for (const f of PROSE_SURFACES) {
    const p = join(ROOT, f);
    // A public cut is a subset of the repository: a surface named in
    // PRIVATE_SURFACES may be absent from this tree; nothing else may be.
    if (!existsSync(p) && PRIVATE_SURFACES.includes(f)) continue;
    assert.ok(existsSync(p), `PROSE_SURFACES names ${f}, which does not exist`);
    assert.match(readFileSync(p, "utf8"), productMentionPattern(PRODUCT),
      `PROSE_SURFACES names ${f}, which does not mention the product name — the list has gone stale`);
  }
  // And nothing a USER receives is missing from it: the README and the skills
  // connect installs into their repo are the prose that would still say the old
  // name after a rename, in their repo, where we would never see it.
  for (const f of ["README.md", "skill/SKILL.md", "skill/write-context/SKILL.md"]) {
    if (!productMentionPattern(PRODUCT).test(readFileSync(join(ROOT, f), "utf8"))) continue;
    assert.ok(PROSE_SURFACES.includes(f), `${f} ships to users and names the product, but a renamer is never told to edit it`);
  }
});

// --- 2. the registration a host can actually launch -------------------------

test("connect registers the MCP server in project-scoped .mcp.json", () => {
  const { dir, env } = scratch();
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 0, `connect failed:\n${out}`);

  const cfg = readJson(join(dir, ".mcp.json"));
  const entry = cfg.mcpServers?.[MCP_SERVER_KEY];
  assert.ok(entry, `.mcp.json has no '${MCP_SERVER_KEY}' server:\n${JSON.stringify(cfg, null, 2)}`);
  assert.equal(entry.command, stableNodeCommand(), "desktop hosts need the stable Node launch path");
  assert.ok(entry.args.some((a) => a.endsWith("server.mjs")), "args must launch the MCP server");
  assert.ok(entry.args.every((a) => !a.startsWith(".")), "paths must be absolute — a host spawns with an arbitrary cwd");
  // The multi-credential half: the client routes per-host auth off the config,
  // so the config path is PINNED absolute or every host but the default breaks.
  assert.equal(entry.env.API_CONFIG, join(dir, LAYOUT.environments));
  assert.equal(entry.env.API_CONTEXT_DIR, dir, "context discovery must not depend on the host cwd");

  // Absolute paths are correct for the host that spawns the server and WRONG
  // for a teammate who clones the repo. The committed file must say so, or the
  // second person on the team debugs a path that only ever existed on ours.
  assert.match(JSON.parse(stdout).note ?? "", /machine|teammate|clone/i,
    "nothing warns that the generated paths are machine-specific");

  // The same contract applies when the host-native files are already tracked:
  // they are regenerated for this machine, not treated as prohibited prose.
  {
  const { dir: trackedDir, env: trackedEnv } = scratch();
  const oldRoot = "/old teammate/checkout";
  const oldEntry = serverEntry({
    nodePath: "/old teammate/bin/node",
    serverPath: `${oldRoot}/server.mjs`,
    configPath: `${oldRoot}/api-environments.json`,
    contextPath: oldRoot,
    evidencePath: `${oldRoot}/evidence`,
  });
  const neighbour = { command: "/team/tool", args: ["serve"] };
  writeFileSync(join(trackedDir, ".mcp.json"), `${JSON.stringify({
    projectSetting: true,
    mcpServers: { neighbour, [MCP_SERVER_KEY]: oldEntry },
  }, null, 2)}\n`);
  mkdirSync(join(trackedDir, ".codex"), { recursive: true });
  writeFileSync(join(trackedDir, ".codex", "config.toml"),
    `team_setting = true\n\n${codexServerBlock(oldEntry)}\n`);
  execFileSync("git", ["add", ".mcp.json", ".codex/config.toml"], { cwd: trackedDir });
  execFileSync("git", ["-c", "user.name=Sannr Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "track host configs"], { cwd: trackedDir });

  const first = cli(trackedDir, ["connect", "--json"], trackedEnv);
  assert.equal(first.code, 0, first.out);
  const report = JSON.parse(first.stdout);
  assert.match(report.note ?? "", /absolute for this machine/i);
  assert.match(report.note ?? "", /teammate.*connect/i);
  assert.ok(report.mcp.some(({ action }) => action === "update"),
    "a tracked stale registration was treated as an omission instead of corrected");

  const jsonBytes = readFileSync(join(trackedDir, ".mcp.json"), "utf8");
  const tomlBytes = readFileSync(join(trackedDir, ".codex", "config.toml"), "utf8");
  const current = readJson(join(trackedDir, ".mcp.json"));
  assert.deepEqual(current.mcpServers.neighbour, neighbour, "merge clobbered a foreign server");
  assert.equal(current.mcpServers[MCP_SERVER_KEY].command, stableNodeCommand());
  assert.equal(current.mcpServers[MCP_SERVER_KEY].env.API_CONTEXT_DIR, trackedDir);
  assert.doesNotMatch(`${jsonBytes}\n${tomlBytes}`, /old teammate/,
    "re-running on this machine retained the other machine's absolute paths");
  assert.notEqual(execFileSync("git", ["diff", "--", ".mcp.json", ".codex/config.toml"],
    { cwd: trackedDir, encoding: "utf8" }), "", "tracked host configs were left untouched");

  const second = cli(trackedDir, ["connect", "--json"], trackedEnv);
  assert.equal(second.code, 0, second.out);
  assert.equal(readFileSync(join(trackedDir, ".mcp.json"), "utf8"), jsonBytes);
  assert.equal(readFileSync(join(trackedDir, ".codex", "config.toml"), "utf8"), tomlBytes);
  assert.ok(JSON.parse(second.stdout).mcp.every(({ action }) => action === "unchanged"),
    "the per-machine correction did not settle idempotently");

  const missing = join(trackedDir, "moved", "server.mjs");
  const broken = readJson(join(trackedDir, ".mcp.json"));
  broken.mcpServers[MCP_SERVER_KEY].args = [missing];
  writeFileSync(join(trackedDir, ".mcp.json"), `${JSON.stringify(broken, null, 2)}\n`);
  const doctor = JSON.parse(cli(trackedDir, ["doctor", "--json"], trackedEnv).stdout);
  const mcp = doctor.checks.find(({ name }) => name === "mcp");
  assert.equal(mcp.state, "FAIL");
  assert.match(mcp.detail, /moved[\\/]server\.mjs/);
  assert.match(mcp.fix, /doctor --offline --repair/);
  assert.match(mcp.fix, /Customized registrations are preserved/);
  }
});

test("a config declaring several hosts yields ONE registration that serves all of them", () => {
  const { dir, env } = scratch({ config: {
    v: 1, default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:9101", auth: "bearer:LOCAL_TOKEN" } },
    hosts: {
      stripe: { baseUrl: "https://api.stripe.com", auth: "bearer:STRIPE_KEY" },
      clerk: { baseUrl: "https://api.clerk.com", auth: "header:X-API-Key:CLERK_KEY" },
    },
  } });
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 0, out);
  const report = JSON.parse(stdout);

  const servers = readJson(join(dir, ".mcp.json")).mcpServers;
  assert.deepEqual(Object.keys(servers), [MCP_SERVER_KEY],
    "vendors must stay inside the ordinary polymorphic client");
  assert.equal(servers[MCP_SERVER_KEY].env.API_CONFIG, join(dir, LAYOUT.environments));

  // Every credential the config references is reported by NAME with its state,
  // because an MCP host does not run a login shell: a key that works in the
  // tester's terminal is simply absent when the host spawns the server, and
  // that surfaces as a 401 they blame on us.
  const named = report.credentials.map((c) => c.var);
  for (const v of ["LOCAL_TOKEN", "STRIPE_KEY", "CLERK_KEY"])
    assert.ok(named.includes(v), `credential ${v} is not reported: ${JSON.stringify(report.credentials)}`);
  assert.ok(report.credentials.every((c) => c.state === "missing"), "unset credentials must not be reported as resolved");
  // Values are never echoed — this output gets pasted into issues.
  assert.doesNotMatch(out, /sk_live|secret-value/);
});

test("plain connect has no librarian product surface", () => {
  const { dir, env } = scratch();
  const connected = cli(dir, ["connect", "--json"], env);
  assert.equal(connected.code, 0, connected.out);

  const report = JSON.parse(connected.stdout);
  assert.ok(!Object.hasOwn(report, "librarian_mcp"),
    "connect still reports a librarian MCP registration");
  assert.ok(!Object.hasOwn(report, "agents"),
    "connect still reports librarian agent definitions");
  assert.deepEqual(Object.keys(readJson(join(dir, ".mcp.json")).mcpServers), [MCP_SERVER_KEY],
    "plain connect installed a restricted librarian server");
  assert.ok(!existsSync(join(dir, ".claude", "agents", `${LIBRARIAN_NAME}.md`)),
    "plain connect installed the Claude librarian definition");
  assert.ok(!existsSync(join(dir, ".codex", "agents", `${LIBRARIAN_NAME}.toml`)),
    "plain connect installed the Codex librarian definition");
  const writeCapabilities = capabilityManifest({
    root: dir, config: {}, evidence: join(dir, LAYOUT.evidence),
    usageLog: join(dir, ".state", "usage.jsonl"), tokenCache: join(dir, ".state", "tokens"),
    tokenUrl: null,
  }).writes.map(({ id }) => id);
  assert.ok(!writeCapabilities.some((id) => id.includes("librarian")),
    "the capability self-report still claims connect writes librarian artifacts");

  const help = cli(dir, ["connect", "--help"], env);
  assert.equal(help.code, 0, help.out);
  assert.doesNotMatch(help.out, /librarian/i,
    "connect help still names the retired librarian surface");
  const text = cli(dir, ["connect"], env);
  assert.equal(text.code, 0, text.out);
  assert.doesNotMatch(text.out, /librarian/i,
    "connect output still names the retired librarian surface");
});

test("connect has no flag that restores or mutates retired librarian artifacts", () => {
  const connectSource = readFileSync(join(ROOT, "lib", "connect.mjs"), "utf8");
  assert.doesNotMatch(connectSource, /force-agents|planLibrarianAgents/,
    "production connect code still carries the dead librarian re-enable path");
  for (const edited of [false, true]) {
    const { dir, env } = scratch();
    assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
    const entry = projectEntry(dir, {});
    const configPath = join(dir, ".mcp.json");
    const config = readJson(configPath);
    config.mcpServers[LIBRARIAN_MCP_SERVER_KEY] = librarianServerEntry(entry);
    if (edited) config.mcpServers[LIBRARIAN_MCP_SERVER_KEY].team_policy = "keep";
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const targets = librarianTargets(dir, entry, { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC });
    for (const target of targets) {
      mkdirSync(dirname(target.to), { recursive: true });
      writeFileSync(target.to, target.body + (edited ? "\n# team copy\n" : ""));
    }
    const before = [configPath, ...targets.map(({ to }) => to)]
      .map((path) => [path, readFileSync(path)]);

    const connected = cli(dir, ["connect", "--json", "--force-agents"], env);
    assert.equal(connected.code, 0, connected.out);
    assert.equal(JSON.parse(connected.stdout).librarian_mcp, undefined);
    for (const [path, bytes] of before)
      assert.deepEqual(readFileSync(path), bytes,
        `${edited ? "edited" : "generated"} retired artifact was changed: ${path}`);
  }
});

test("a credential declared in an envFile is reported as resolved, not missing", () => {
  const { dir, env } = scratch();
  writeFileSync(join(dir, "vendor.env"), "STRIPE_KEY=sk_test_dont_echo_me\n");
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:9101" } },
    hosts: { stripe: { baseUrl: "https://api.stripe.com", auth: "bearer:STRIPE_KEY", envFile: "./vendor.env" } },
  }, null, 2));
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 0, out);
  const cred = JSON.parse(stdout).credentials.find((c) => c.var === "STRIPE_KEY");
  assert.equal(cred.state, "envFile", "an envFile-declared credential resolves without a login shell");
  assert.doesNotMatch(out, /sk_test_dont_echo_me/, "a credential VALUE must never be printed");
});

// --- 3. merge, never clobber ------------------------------------------------

test("a FOREIGN entry under our server name is a reported conflict, never overwritten", () => {
  const foreign = { mcpServers: { [MCP_SERVER_KEY]: { command: "python", args: ["their_server.py"] } } };
  const { dir, env } = scratch({ files: { ".mcp.json": JSON.stringify(foreign, null, 2) + "\n" } });
  const { code, out } = cli(dir, ["connect"], env);

  assert.notEqual(code, 0, "a conflict must not be reported as success");
  assert.deepEqual(readJson(join(dir, ".mcp.json")), foreign, "the user's config was overwritten");
  assert.match(out, /conflict/i, "the conflict must be named");
  // "print what to change" — the exact entry, so the fix is a paste, not a guess.
  assert.match(out, /server\.mjs/, "the entry the user must paste is not printed");
});

test("an unparseable .mcp.json is refused with the snippet, not silently replaced", () => {
  const { dir, env } = scratch({ files: { ".mcp.json": "{ this is not json" } });
  const { code, out } = cli(dir, ["connect"], env);
  assert.notEqual(code, 0);
  assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), "{ this is not json", "a broken file was clobbered");
  assert.match(out, /server\.mjs/, "the snippet to paste is not printed");
});

// --- 4. idempotent, and reversible -----------------------------------------

test("first connect is stable across clean, empty-host, and no-contract repos", () => {
  const cases = [
    { name: "clean", prepare: () => {} },
    { name: "empty host layouts", prepare: (dir) => {
      mkdirSync(join(dir, ".claude"));
      mkdirSync(join(dir, ".codex"));
    } },
    { name: "no contract", prepare: (dir) => rmSync(join(dir, "openapi.yaml"), { force: true }) },
  ];
  const settled = (report) => ({
    server: report.server,
    config: report.config,
    mcp: report.mcp.map(({ action, ...row }) => row),
    skills: report.skills.map(({ action, ...row }) => row),
    pointers: report.pointers.map(({ action, ...row }) => row),
    registry: { file: report.registry.file, ...(report.registry.reason ? { reason: report.registry.reason } : {}) },
    context: report.context.startsWith("skipped") ? "skipped" : "present",
    credentials: report.credentials,
    note: report.note,
    verify: report.verify,
    next: report.next,
  });

  for (const scenario of cases) {
    const { dir, env } = scratch();
    scenario.prepare(dir);
    const first = cli(dir, ["connect", "--json"], env);
    assert.equal(first.code, 0, `${scenario.name}: first connect failed:\n${first.out}`);
    const installed = [".mcp.json", ".codex/config.toml", "AGENTS.md", "CLAUDE.md"];
    const bytes = installed.map(path => readFileSync(join(dir, path), "utf8"));
    const second = cli(dir, ["connect", "--json"], env);
    assert.equal(second.code, 0, `${scenario.name}: second connect failed:\n${second.out}`);

    const firstReport = JSON.parse(first.stdout);
    const secondReport = JSON.parse(second.stdout);
    assert.deepEqual(settled(secondReport), settled(firstReport),
      `${scenario.name}: first and second reports differ beyond expected write actions`);
    assert.deepEqual(secondReport.mcp.map((row) => row.action),
      secondReport.mcp.map(() => "unchanged"),
      `${scenario.name}: second connect did not settle every MCP registration`);
    assert.equal(secondReport.registry.action, "refreshed",
      `${scenario.name}: second connect did not settle the machine registry`);
    assert.deepEqual(installed.map(path => readFileSync(join(dir, path), "utf8")), bytes,
      `${scenario.name}: repeat connect rewrote an installed registration or pointer`);
  }
});

test("unwire reverses connect completely and leaves the neighbours alone", () => {
  const existing = { mcpServers: { postgres: { command: "npx", args: ["-y", "pg-mcp"] } } };
  const { dir, env } = scratch({ files: { ".mcp.json": JSON.stringify(existing, null, 2) + "\n" } });
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  assert.deepEqual(readJson(join(dir, ".mcp.json")).mcpServers.postgres, existing.mcpServers.postgres,
    "connect must preserve neighboring registrations before unwire also preserves them");

  const { code, out } = cli(dir, ["unwire", "--json"], env);
  assert.equal(code, 0, out);
  const cfg = readJson(join(dir, ".mcp.json"));
  assert.equal(cfg.mcpServers[MCP_SERVER_KEY], undefined, "the registration survived unwire");
  assert.deepEqual(cfg.mcpServers.postgres, existing.mcpServers.postgres, "the neighbour was removed too");
  assert.ok(!existsSync(join(dir, ".claude", "skills", SKILL_NAMES.request)), "the skill survived unwire");
  assert.doesNotMatch(readFileSync(join(dir, "AGENTS.md"), "utf8"), new RegExp(POINTER_BEGIN.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&")),
    "the pointer block survived unwire");
});

test("unwire on a never-connected repo is a no-op that says so", () => {
  const { dir, env } = scratch();
  const { code, out } = cli(dir, ["unwire", "--json"], env);
  assert.equal(code, 0, out);
  assert.ok(!existsSync(join(dir, ".mcp.json")), "unwire fabricated a config file");
});

// --- 5. the agent-facing files ---------------------------------------------

test("connect installs canonical skills and their Claude Code and Codex copies, named as they declare", () => {
  const { dir, env } = scratch();
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 0, out);
  const report = JSON.parse(stdout);

  // The write convention is the accumulation mechanism: without it a tester
  // accumulates nothing and concludes the product does not work.
  const names = report.skills.map((s) => s.name);
  assert.ok(names.includes(SKILL_NAMES.request), `the client skill is not installed: ${names}`);
  assert.ok(names.some((n) => /write/.test(n)), `the write-context convention is not installed: ${names}`);
  assert.deepEqual(new Set(report.skills.map((s) => s.host)), new Set(["project", "claude-code", "codex"]));
  for (const s of report.skills) {
    const p = join(dir, s.path);
    assert.ok(existsSync(p), `${s.path} was reported but not written`);
    // Both hosts key a skill by its directory name, so the directory must be
    // the skill's own declared `name:` — a mismatch silently never loads.
    const declared = /^name:\s*(\S+)/m.exec(readFileSync(p, "utf8"))?.[1];
    assert.equal(p.split("/").at(-2), declared, `${s.path} is installed under a directory that is not its declared name`);
  }
});

test("the write convention lands in the repo with commands the agent can actually run", () => {
  // The skill is the accumulation mechanism, and it is the ONE agent-facing
  // file whose command lines are executed verbatim by something that cannot
  // notice they are wrong. On a per-project install the bare name is
  // command-not-found (exit 127), so the agent's write silently never happens
  // and the knowledge file never grows — indistinguishable, from the outside,
  // from a tool that does nothing. Same failure CLI_NAME already fixes for our
  // printed output and for the pointer block; the skill body was the copy that
  // outlives both, because it is committed into someone else's repo.
  const src = SKILL_SOURCES.find((s) => s.includes("write-context"));
  const shim = `./node_modules/.bin/${PRODUCT}`;
  const rendered = renderSkill(src, shim);

  const bare = rendered.split("\n").filter((l) =>
    new RegExp(`(?:^|[\\s\`(])${PRODUCT}\\s+(?:note|verdict|init|learn|doctor|map|receipt|audit)\\b`).test(l) &&
    !l.includes(shim));
  assert.deepEqual(bare, [], `the installed skill tells the agent to run a command it does not have:\n${bare.join("\n")}`);
  assert.match(rendered, new RegExp(`${shim.replace(/[.\\/]/g, "\\$&")} note `), "no runnable form of the write survived");

  // IDENTIFIERS are not invocations: the knowledge file's name and the skill's
  // own declared name spell the product too, and rewriting either produces a
  // file nobody has and a skill directory Claude Code never loads.
  assert.match(rendered, /^name: sannr-write$/m, "the skill's declared name was rewritten into a path");
  assert.match(rendered, new RegExp(`${PRODUCT}\\.json`), "the knowledge file's name was rewritten into a path");

  // On a global install the invocation IS the bare name, so nothing changes —
  // templating must not churn the file for the install that was already right.
  assert.ok(!renderSkill(src, PRODUCT).includes("{{"), "the source tokens resolve on a global install too");
  assert.ok(renderSkill(src, PRODUCT).includes(`${PRODUCT} note`));
});

test("a skill the user has EDITED is left alone, and says how to take the update", () => {
  // Same rule as the MCP config, one file over: what the user changed is theirs.
  // Silently restoring our copy would delete a team's local tightening of the
  // write convention — the artefact the whole product wants them to own.
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const skill = join(dir, ".claude", "skills", SKILL_NAMES.request, "SKILL.md");
  writeFileSync(skill, readFileSync(skill, "utf8") + "\n\nOUR TEAM RULE: always pass expect.\n");

  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 0, out);
  assert.match(readFileSync(skill, "utf8"), /OUR TEAM RULE/, "a locally-edited skill was overwritten");
  const row = JSON.parse(stdout).skills.find((s) => s.name === SKILL_NAMES.request && s.host === "claude-code");
  assert.equal(row.action, "differs");
  assert.match(row.fix ?? "", /--force-skills/, "no way to take the packaged version is offered");

  // …and the escape hatch actually works, because a stale skill must be fixable.
  assert.equal(cli(dir, ["connect", "--json", "--force-skills"], env).code, 0);
  assert.doesNotMatch(readFileSync(skill, "utf8"), /OUR TEAM RULE/, "--force-skills did not take the packaged version");
});

test("doctor survives a malformed MCP config instead of crashing on it", () => {
  // doctor is what a stuck tester runs. A stack trace out of the check that was
  // supposed to explain the problem is the worst possible moment to crash.
  const { dir, env } = scratch({ files: { ".mcp.json": "{ nope" } });
  const { out, stdout, stderr } = cli(dir, ["doctor", "--json"], env);
  assert.match(stderr, /About to request: HEAD/, "doctor must retain its pre-request announcement");
  const parsed = JSON.parse(stdout);
  const mcp = parsed.checks.find((c) => c.name === "mcp");
  assert.equal(mcp.state, "FAIL");
  assert.match(mcp.detail, /JSON/i, "the reason must name the broken file, not a stack");
});

test("doctor fails when a registered absolute runtime command no longer exists", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const configPath = join(dir, ".codex", "config.toml");
  const missingRuntime = join(dir, "missing-node-runtime");
  const config = readFileSync(configPath, "utf8")
    .replace(`command = ${JSON.stringify(stableNodeCommand())}`,
      `command = ${JSON.stringify(missingRuntime)}`);
  writeFileSync(configPath, config);

  const doctor = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
  const mcp = doctor.checks.find((c) => c.name === "mcp");
  assert.equal(mcp.state, "FAIL");
  assert.match(mcp.detail, /missing-node-runtime/);
  assert.match(mcp.fix, /doctor --offline --repair/);
  assert.match(mcp.fix, /Customized registrations are preserved/);
});

test("doctor finds a missing server path in a multiline Codex args array", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const configPath = join(dir, ".codex", "config.toml");
  const missingServer = join(dir, "missing", "server.mjs");
  const config = readFileSync(configPath, "utf8")
    .replace(/^args = \[[^\n]+\]$/m,
      `args = [\n  ${JSON.stringify(missingServer)},\n]`);
  writeFileSync(configPath, config);

  const doctor = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
  const mcp = doctor.checks.find((c) => c.name === "mcp");
  assert.equal(mcp.state, "FAIL");
  assert.match(mcp.detail, /missing[\\/]server\.mjs/);
});

// --- other hosts: support what is reliable, print what is not ---------------

test("a project that uses Cursor gets its own registration too", () => {
  const { dir, env } = scratch({ files: { ".cursor/rules.md": "x\n" } });
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const cfg = readJson(join(dir, ".cursor", "mcp.json"));
  assert.ok(cfg.mcpServers[MCP_SERVER_KEY], "Cursor's project config was not written");
});

test("a VS Code project gets the shape VS Code actually reads", () => {
  const { dir, env } = scratch({ files: { ".vscode/settings.json": "{}\n" } });
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const cfg = readJson(join(dir, ".vscode", "mcp.json"));
  const entry = cfg.servers?.[MCP_SERVER_KEY];
  assert.ok(entry, "VS Code uses `servers`, not `mcpServers`");
  assert.equal(entry.type, "stdio", "VS Code requires the transport type");
});

test("Codex gets a project-scoped TOML registration and global config stays untouched", () => {
  const { dir, env, home } = scratch();
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "config.toml"), "model = \"user-choice\"\n");
  const { code, out } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 0, out);
  const text = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
  assert.match(text, /^# sannr:managed-mcp-begin$/m, "Codex block has no ownership marker");
  assert.match(text, /^\[mcp_servers\.sannr\]$/m);
  assert.match(text, new RegExp(`command = ${JSON.stringify(stableNodeCommand()).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(text, /server\.mjs/);
  assert.match(text, new RegExp(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`));
  assert.match(text, /default_tools_approval_mode = "prompt"/);
  assert.match(text, new RegExp(`API_CONTEXT_DIR[^\n]+${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(readFileSync(join(home, ".codex", "config.toml"), "utf8"), "model = \"user-choice\"\n",
    "connect changed the user's global Codex config");
});

test("Codex TOML merge preserves comments, settings, and unrelated MCP servers", () => {
  const original = [
    "# personal choice", 'model = "gpt-5.5"', "", "[mcp_servers.postgres]",
    'command = "npx"', 'args = ["-y", "pg-mcp"]', "",
  ].join("\n");
  const { dir, env } = scratch({ files: { ".codex/config.toml": original } });
  const first = cli(dir, ["connect", "--json"], env);
  assert.equal(first.code, 0, first.out);
  const merged = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
  assert.ok(merged.startsWith(original.trimEnd()), "connect rewrote the user's TOML prefix");
  assert.match(merged, /\[mcp_servers\.postgres\][\s\S]*pg-mcp/, "unrelated MCP server was lost");
  assert.match(merged, /\[mcp_servers\.sannr\]/);

  const second = cli(dir, ["connect", "--json"], env);
  assert.equal(second.code, 0, second.out);
  assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), merged,
    "Codex config changed on an idempotent second connect");
  assert.equal(JSON.parse(second.stdout).mcp.find((m) => m.host === "codex").action, "unchanged");
});

test("connect and unwire never follow a project .codex symlink outside the repo", () => {
  const { dir, env } = scratch();
  const external = realpathSync(mkdtempSync(join(tmpdir(), "external-codex-")));
  const config = join(external, "config.toml");
  const original = 'model = "global-choice"\n';
  writeFileSync(config, original);
  symlinkSync(external, join(dir, ".codex"), "dir");

  const connected = cli(dir, ["connect", "--json"], env);
  assert.equal(connected.code, 1, connected.out);
  assert.equal(readFileSync(config, "utf8"), original,
    "connect followed .codex and changed an external/global config");
  const row = JSON.parse(connected.stdout).mcp.find((m) => m.host === "codex");
  assert.equal(row.action, "conflict");
  assert.match(row.reason, /symbolic link/i);

  const doctor = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
  assert.equal(doctor.checks.find((c) => c.name === "mcp").state, "FAIL");
  const unwired = JSON.parse(cli(dir, ["unwire", "--json"], env).stdout);
  assert.equal(readFileSync(config, "utf8"), original,
    "unwire followed .codex and changed an external/global config");
  assert.equal(unwired.mcp.find((m) => m.file === ".codex/config.toml").action, "left");
});

test("connect and unwire never follow a project .agents symlink outside the repo", () => {
  const { dir, env } = scratch();
  const external = realpathSync(mkdtempSync(join(tmpdir(), "external-agents-")));
  const sentinel = join(external, "sentinel.txt");
  writeFileSync(sentinel, "keep\n");
  symlinkSync(external, join(dir, ".agents"), "dir");

  const connected = cli(dir, ["connect", "--json"], env);
  assert.equal(connected.code, 1, connected.out);
  const codexSkills = JSON.parse(connected.stdout).skills.filter((s) => s.host === "codex");
  assert.ok(codexSkills.length && codexSkills.every((s) => s.action === "conflict"));
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  assert.ok(!existsSync(join(external, "skills")), "connect installed skills through .agents");
  for (const path of [".mcp.json", ".claude", LAYOUT.context, "AGENTS.md", "CLAUDE.md"]) {
    assert.equal(existsSync(join(dir, path)), false,
      `connect wrote ${path} before the late skill-path conflict was resolved`);
  }

  const unwired = JSON.parse(cli(dir, ["unwire", "--json"], env).stdout);
  assert.equal(readFileSync(sentinel, "utf8"), "keep\n");
  assert.ok(unwired.skills.filter((s) => s.host === "codex")
    .every((s) => s.action === "left"), "unwire followed the linked skill tree");
});

test("a foreign Codex server under our name is a conflict and is never overwritten", () => {
  const foreign = ['model = "gpt-5.5"', "", "[mcp_servers.sannr]",
    'command = "python"', 'args = ["foreign.py"]', ""].join("\n");
  const { dir, env } = scratch({ files: { ".codex/config.toml": foreign } });
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 1, out);
  assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), foreign);
  const row = JSON.parse(stdout).mcp.find((m) => m.host === "codex");
  assert.equal(row.action, "conflict");
  assert.match(row.reason, /unmarked|does not own|DIFFERENT/);
});

test("connect never claims an older unmarked Codex server entry as its own", () => {
  const old = ["[mcp_servers.api-request]", 'command = "node"',
    `args = [${JSON.stringify(join(ROOT, "server.mjs"))}]`, "", "[features]", "shell_tool = true", ""].join("\n");
  const { dir, env } = scratch({ files: { ".codex/config.toml": old } });
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 1, out);
  assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), old,
    "a server.mjs suffix is not sufficient proof that an unmarked entry is ours");
  assert.match(JSON.parse(stdout).mcp.find((m) => m.host === "codex").reason, /locally different legacy server under "api-request"/);
});

test("nested Codex server subtables are treated as user-owned and never partially replaced", () => {
  const nested = ["[mcp_servers.api-request]", 'command = "node"',
    `args = [${JSON.stringify(join(ROOT, "server.mjs"))}]`, "",
    "[mcp_servers.api-request.env]", `API_CONFIG = ${JSON.stringify(join(ROOT, "old.json"))}`, ""].join("\n");
  const { dir, env } = scratch({ files: { ".codex/config.toml": nested } });
  const { code, out } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 1, out);
  assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), nested);
});

test("duplicate Codex definitions outside a managed block are a conflict", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const file = join(dir, ".codex", "config.toml");
  const duplicate = `${readFileSync(file, "utf8")}\n[mcp_servers.sannr]\ncommand = "python"\nargs = ["foreign.py"]\n`;
  writeFileSync(file, duplicate);
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 1, out);
  assert.equal(readFileSync(file, "utf8"), duplicate);
  assert.match(JSON.parse(stdout).mcp.find((m) => m.host === "codex").reason, /outside|duplicate/);

  const doctor = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
  assert.equal(doctor.checks.find((c) => c.name === "mcp").state, "FAIL",
    "doctor passed TOML that Codex rejects as a duplicate table");

  const unwire = JSON.parse(cli(dir, ["unwire", "--json"], env).stdout);
  assert.equal(readFileSync(file, "utf8"), duplicate,
    "unwire partially removed a managed entry that had an outside duplicate");
  assert.equal(unwire.mcp.find((m) => m.file === ".codex/config.toml").action, "left");
});

test("duplicate ownership marker pairs are refused", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const file = join(dir, ".codex", "config.toml");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, `${text}\n${text}`);
  const result = cli(dir, ["connect", "--json"], env);
  assert.equal(result.code, 1, result.out);
  assert.match(JSON.parse(result.stdout).mcp.find((m) => m.host === "codex").reason, /incomplete managed block/);
});

test("marker text inside ordinary TOML content does not confer ownership", () => {
  const content = [
    'note = "# sannr:managed-mcp-begin"',
    'other = "# sannr:managed-mcp-end"', "",
  ].join("\n");
  const { dir, env } = scratch({ files: { ".codex/config.toml": content } });
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const text = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
  assert.ok(text.startsWith(content.trimEnd()), "marker-shaped string content was overwritten");
  assert.equal((text.match(/^# sannr:managed-mcp-begin$/gm) ?? []).length, 1);
});

test("ownership markers inside TOML multiline strings are never replaced or removed", () => {
  for (const quote of ['"""', "'''"]) {
    const original = [
      `developer_instructions = ${quote}`,
      "Keep this.",
      "# sannr:managed-mcp-begin",
      "This is quoted text, not ownership.",
      "# sannr:managed-mcp-end",
      "Keep this too.", quote, "",
    ].join("\n");
    const { dir, env } = scratch({ files: { ".codex/config.toml": original } });
    const connected = cli(dir, ["connect", "--json"], env);
    assert.equal(connected.code, 0, connected.out);
    const file = join(dir, ".codex", "config.toml");
    const text = readFileSync(file, "utf8");
    assert.ok(text.startsWith(original.trimEnd()), "connect changed a multiline string");
    assert.match(text, /^\[mcp_servers\.sannr\]$/m);
    const unwired = cli(dir, ["unwire", "--json"], env);
    assert.equal(unwired.code, 0, unwired.out);
    assert.equal(readFileSync(file, "utf8").trimEnd(), original.trimEnd(),
      "unwire deleted marker-shaped text from a multiline string");
  }
});

test("quoted Codex table segments under our key are a foreign-entry conflict", () => {
  for (const header of ['["mcp_servers"."sannr"]',
    '["\\u006dcp_servers"."sannr"]']) {
    const foreign = [header, 'command = "python"', 'args = ["foreign.py"]', ""].join("\n");
    const { dir, env } = scratch({ files: { ".codex/config.toml": foreign } });
    const result = cli(dir, ["connect", "--json"], env);
    assert.equal(result.code, 1, result.out);
    assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), foreign);
    assert.equal(JSON.parse(result.stdout).mcp.find((m) => m.host === "codex").action, "conflict");
  }
});

test("a sealed inline mcp_servers root is refused instead of made invalid", () => {
  for (const root of ["mcp_servers", '"\\u006dcp_servers"']) {
    const original = `${root} = { postgres = { command = "npx", args = ["pg-mcp"] } }\n`;
    const { dir, env } = scratch({ files: { ".codex/config.toml": original } });
    const result = cli(dir, ["connect", "--json"], env);
    assert.equal(result.code, 1, result.out);
    assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), original);
    assert.match(JSON.parse(result.stdout).mcp.find((m) => m.host === "codex").reason,
      /inline table|cannot be extended/i);
  }
});

test("structurally malformed Codex TOML is refused rather than appended to", () => {
  const malformed = 'model = "unterminated\n';
  const { dir, env } = scratch({ files: { ".codex/config.toml": malformed } });
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 1, out);
  assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), malformed);
  assert.match(JSON.parse(stdout).mcp.find((m) => m.host === "codex").reason, /valid TOML|unterminated/);
});

test("unwire removes only the managed Codex block", () => {
  const original = ['model = "gpt-5.5"', "", "[mcp_servers.postgres]",
    'command = "npx"', 'args = ["pg-mcp"]', ""].join("\n");
  const { dir, env } = scratch({ files: { ".codex/config.toml": original } });
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const result = cli(dir, ["unwire", "--json"], env);
  assert.equal(result.code, 0, result.out);
  const text = readFileSync(join(dir, ".codex", "config.toml"), "utf8");
  assert.match(text, /model = "gpt-5\.5"/);
  assert.match(text, /\[mcp_servers\.postgres\]/);
  assert.doesNotMatch(text, /sannr:managed|\[mcp_servers\.sannr\]/);
});

test("malformed Codex ownership markers are refused without changing the file", () => {
  const broken = "# sannr:managed-mcp-begin\n[mcp_servers.sannr]\ncommand = \"node\"\n";
  const { dir, env } = scratch({ files: { ".codex/config.toml": broken } });
  const { code, out, stdout } = cli(dir, ["connect", "--json"], env);
  assert.equal(code, 1, out);
  assert.equal(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), broken);
  assert.match(JSON.parse(stdout).mcp.find((m) => m.host === "codex").reason, /incomplete managed block/);
});

// --- posture ---------------------------------------------------------------

test("the capabilities manifest discloses what connect writes", () => {
  // The self-report is only worth anything if it is COMPLETE. connect adds new
  // committed write paths (an MCP registration and installed skills); a manifest
  // that omitted them would be exactly the comforting fiction that command exists
  // to prevent.
  const m = capabilityManifest({
    root: "/repo", config: { baseUrl: "http://127.0.0.1:8787", hosts: {} },
    evidence: "/repo/evidence", usageLog: "/h/usage.jsonl", tokenCache: "/h/tokens", tokenUrl: null,
  });
  const paths = m.writes.map((w) => w.path);
  assert.ok(paths.some((p) => p.includes(".mcp.json")), "the MCP registration is not disclosed");
  assert.ok(paths.some((p) => p.includes(".codex/config.toml")), "the Codex registration is not disclosed");
  assert.ok(paths.some((p) => p.includes(".claude/skills")), "the installed skills are not disclosed");
  assert.ok(paths.some((p) => p.includes(".agents/skills")), "the Codex skills are not disclosed");
  for (const w of m.writes.filter((w) => /mcp|skills/.test(w.path)))
    assert.match(w.guard, /connect|unwire|merge/i, `${w.path} discloses no guard`);
});

test("doctor reports the MCP wiring, so a tester learns it is missing before an agent does", () => {
  const { dir, env } = scratch();
  const before = cli(dir, ["doctor", "--json"], env);
  const mcpCheck = JSON.parse(before.stdout).checks.find((c) => c.name === "mcp");
  assert.ok(mcpCheck, "doctor never checks the MCP registration");
  assert.notEqual(mcpCheck.state, "PASS", "doctor passed an unregistered repo");
  assert.match(mcpCheck.fix, new RegExp(escapeRegExp(`${SOURCE_CLI} connect`)), "doctor names no fix");

  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const after = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
  const mcp = after.checks.find((c) => c.name === "mcp");
  assert.equal(mcp.state, "PASS", "doctor does not see a completed connect");
  assert.match(mcp.detail, /MCP initialize responded|reachable/i,
    "doctor called registration shape a PASS without proving the server answered");

  const registrationPath = join(dir, ".mcp.json");
  const registration = JSON.parse(readFileSync(registrationPath, "utf8"));
  registration.mcpServers[MCP_SERVER_KEY].command = "/definitely/missing/sannr-node";
  writeFileSync(registrationPath, JSON.stringify(registration, null, 2) + "\n");
  const broken = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
  const brokenMcp = broken.checks.find((c) => c.name === "mcp");
  assert.notEqual(brokenMcp.state, "PASS", "a non-functional MCP registration must not be reported green");
});

// --- 6. the cwd a host actually uses ---------------------------------------

test("a registered MCP initializes, lists tools and executes from a foreign cwd with project-bound evidence", async () => {
  // initialize + tools/list touch no filesystem, so the earlier launch test
  // cannot see this: EVERY tools/call creates the evidence directory, and a
  // relative evidence path resolves against process.cwd() — the host's cwd, not
  // the repo's. Two failure modes, both blamed on the tester's API:
  //   unwritable cwd → every call dies "ENOENT: mkdir '/evidence'"
  //   writable cwd   → the call succeeds and writes response bodies into a
  //                    directory outside the project, so the evidence id in the
  //                    agent's reply names a file the human cannot find and
  //                    `receipt`/`show` in the repo never see it.
  const f = await start();
  const foreign = realpathSync(mkdtempSync(join(tmpdir(), "connect-hostcwd-")));
  const { dir, env } = scratch({ config: {
    v: 1, default: "local", environments: { local: { baseUrl: f.origin } },
  } });
  try {
    assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
    const entry = readJson(join(dir, ".mcp.json")).mcpServers[MCP_SERVER_KEY];
    // Pinned the same way API_CONFIG is, and for the same reason.
    assert.equal(entry.env.API_EVIDENCE, join(dir, LAYOUT.evidence),
      "the evidence directory is not pinned absolute in the registration");

    const replies = await rpc(entry, { cwd: foreign, env, messages: [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL_NAME,
        arguments: { method: "GET", path: "/json", expect: [{ status: 200 }] } } },
    ] });
    assert.ok(replies.find(reply => reply.id === 1)?.result?.protocolVersion);
    assert.ok(replies.find(reply => reply.id === 3)?.result?.tools.some(tool => tool.name === TOOL_NAME));
    const call = replies.find((r) => r.id === 2);
    assert.ok(call, `no tools/call reply: ${JSON.stringify(replies)}`);
    assert.ok(!call.result.isError, `tools/call from a foreign cwd failed: ${call.result.content?.[0]?.text}`);
    assert.equal(JSON.parse(call.result.content[0].text).status, 200);

    assert.ok(existsSync(join(dir, LAYOUT.evidence)), "the call left no evidence inside the project");
    assert.ok(readdirSync(join(dir, LAYOUT.evidence)).some((n) => n.endsWith(".json")),
      "the evidence directory holds no run record");
    assert.ok(!existsSync(join(foreign, LAYOUT.evidence)),
      "evidence was written into the host's cwd, outside the project, where the human will never find it");
  } finally { await f.close(); }
});

// --- 7. the install path a stranger actually has ----------------------------

test("package.json names the scoped npm package the seam derives, and the bin stays the product name", () => {
  // npm refused the bare name; the published identity is `@name/name` while the
  // command a user types is still the product name. Both come from lib/brand.mjs.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, NPM_PACKAGE, `package.json name ${pkg.name} is not the seam's ${NPM_PACKAGE}`);
  assert.equal(NPM_PACKAGE, `@${PRODUCT}/${PRODUCT}`);
  assert.ok(Object.hasOwn(pkg.bin, PRODUCT), `package.json bin has no ${PRODUCT} entry`);
});

// --- 8. the rename inventory, both directions -------------------------------

test("every markdown file that names the product is listed in PROSE_SURFACES", () => {
  // brand.mjs promises the list "cannot rot into a stale inventory". The
  // existing test only checks the listed files still mention the name; a file
  // that mentions it and is NOT listed is the omission that leaves the old name
  // behind after the documented four-step rename.
  //
  // TRACKED files only, from git itself — for the same reason the other
  // direction can read every listed file in every clone: PROSE_SURFACES can
  // only ever list what git ships. An untracked machine-local note
  // (CLAUDE.local.md is the standing example) is outside the rename's
  // jurisdiction, like the state dir; the moment such a file is committed it
  // appears here and the omission is caught. First caught for real
  // 2026-08-21, when a committed CLAUDE.md landed unlisted.
  const found = execFileSync("git", ["ls-files", "*.md"], { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean)
    // A coherent slice may delete a tracked prose file before its commit is
    // staged. Git still reports that old index entry, but there are no bytes
    // left in the worktree to rename. After commit it leaves the inventory;
    // every newly tracked product-naming markdown remains visible here.
    .filter((f) => existsSync(join(ROOT, f)));
  assert.ok(found.some(file => productMentionPattern(PRODUCT).test(readFileSync(join(ROOT, file), "utf8"))),
    "the inventory walk found no product mentions — the scope is broken, not clean");
  assert.deepEqual(unlistedProseSurfaces(found, PROSE_SURFACES,
    file => readFileSync(join(ROOT, file), "utf8"), PRODUCT), [],
    "Product-naming prose is absent from PROSE_SURFACES");
});

test("a skill whose DIRECTORY name carries the product name is reachable by the rename procedure", () => {
  // The installed front matter resolves the product token from the seam.
  // Source prose remains in the explicit rename inventory.
  for (const src of SKILL_SOURCES) {
    const declared = /^name:\s*(\S+)/m.exec(renderSkill(src, PRODUCT))?.[1] ?? "";
    if (!productMentionPattern(PRODUCT).test(declared)) continue;
    const relPath = src.slice(ROOT.length + 1);
    assert.ok(PROSE_SURFACES.includes(relPath),
      `${relPath} declares the directory name '${declared}', which carries the product name, but no rename step touches it`);
  }
});

// --- 9. unwire leaves no scaffolding ----------------------------------------

test("unwire removes empty host scaffolding and keeps host trees the user had", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  assert.equal(cli(dir, ["unwire", "--json"], env).code, 0);
  assert.ok(!existsSync(join(dir, ".claude")),
    "connect created .claude/skills and unwire left the empty tree behind");
  assert.ok(!existsSync(join(dir, ".agents")),
    "connect created .agents/skills and unwire left the empty tree behind");

  // …but a tree with someone else's skill in it is theirs, and stays.
  const other = scratch({ files: { ".claude/skills/theirs/SKILL.md": "---\nname: theirs\n---\nours\n" } });
  assert.equal(cli(other.dir, ["connect", "--json"], other.env).code, 0);
  assert.equal(cli(other.dir, ["unwire", "--json"], other.env).code, 0);
  assert.ok(existsSync(join(other.dir, ".claude", "skills", "theirs", "SKILL.md")),
    "unwire removed a skill that was never ours");

  const codexOther = scratch({ files: { ".agents/skills/theirs/SKILL.md": "---\nname: theirs\n---\nours\n" } });
  assert.equal(cli(codexOther.dir, ["connect", "--json"], codexOther.env).code, 0);
  assert.equal(cli(codexOther.dir, ["unwire", "--json"], codexOther.env).code, 0);
  assert.ok(existsSync(join(codexOther.dir, ".agents", "skills", "theirs", "SKILL.md")),
    "unwire removed a Codex skill that was never ours");
});

test.after(() => {
  // Scratch dirs are cheap but the suite runs often; leave /tmp as we found it.
  for (const d of [tmpdir()]) void d;
  rmSync(join(tmpdir(), "connect-nonexistent"), { recursive: true, force: true });
});

test("connect in a repo with no spec says what still works, not just what it skipped", () => {
  // A repo that serves no API gets `skipped  sannr.json — No OpenAPI
  // document found in …` and nothing else. Everything in that line is true and
  // none of it is actionable: the reader cannot tell whether connect worked,
  // whether they are supposed to go write an OpenAPI document, or whether the
  // thing they just installed does anything for them at all. It is the last
  // line of the adoption path, and it ends in a shrug.
  //
  // What is actually true is worth saying: the MCP server and the write
  // convention are wired and will accumulate context from real calls; the
  // knowledge file appears once there is a contract to inventory.
  const { dir, env } = scratch();
  rmSync(join(dir, "openapi.yaml"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "pay.js"), 'await fetch("https://api.stripe.com/v1/charges");\n');

  const { code, out } = cli(dir, ["connect"], env);
  assert.equal(code, 0, out);
  assert.match(out, /No OpenAPI document/, "the reason is still stated");
  assert.match(out, /client is installed; notes are not ready yet/,
    `the result must distinguish installed client from missing knowledge:\n${out}`);

  // And what it says about the write convention has to SURVIVE the reader
  // trying it. In this repo it cannot land anything: note and verdict both
  // need the knowledge file, and `init` needs a contract this repo does not
  // have — so "it will accumulate what your agent learns" is a promise that
  // dead-ends two commands later, in exactly the repo shape half a real tree
  // is. The one path that does work is naming the spec of an API this repo
  // CALLS, and that is what a next step has to say.
  assert.match(out, /start --contract <path>/,
    `the path for adding a real contract must be named:\n${out}`);

  const failedWrite = cli(dir, ["note", "GET /charges", "400s without a customer"], env);
  // FIELD-1b: a named migration policy is distinct from ordinary CLI failure.
  assert.equal(failedWrite.code, 3, "a note with nowhere to land must report a policy refusal");
  assert.match(failedWrite.out, /STACKS_MIGRATION_REQUIRED/,
    `the write the convention just asked for fails with a next step that also fails:\n${failedWrite.out}`);
});
