import { LAYOUT } from "../lib/layout.mjs";
// Exercise the archive handed to testers, without resolving into the checkout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync,  copyFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PRODUCT, NPM_PACKAGE, MCP_SERVER_KEY, TOOL_NAME, CONTEXT_BASENAME } from "../lib/brand.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const run = (command, args, cwd, env = process.env) => execFileSync(command, args, {
  cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000,
  maxBuffer: 16 * 1024 * 1024,
});
const missingArchiveTools = ["zip", "unzip"].filter(command =>
  spawnSync(command, ["-v"], { stdio: "ignore" }).error?.code === "ENOENT");
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function inventory(entry, cwd, env) {
  const child = spawn(entry.command, entry.args, {
    cwd, env: { ...env, ...entry.env }, stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    return await new Promise((resolve, reject) => {
      let output = "", errors = "";
      const replies = new Map();
      const timer = setTimeout(() => reject(new Error(`MCP inventory timed out: ${errors}`)), 10_000);
      const finish = (fn, value) => { clearTimeout(timer); fn(value); };
      child.on("error", (error) => finish(reject, error));
      child.on("exit", (code) => finish(reject, new Error(`MCP exited ${code}: ${errors}`)));
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.stdout.on("data", (chunk) => {
        output += chunk;
        let newline;
        while ((newline = output.indexOf("\n")) !== -1) {
          const line = output.slice(0, newline); output = output.slice(newline + 1);
          if (!line.trim()) continue;
          try {
            const reply = JSON.parse(line);
            replies.set(reply.id, reply);
            if (reply.id === 1) {
              child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
              child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
            }
            if (replies.has(2)) finish(resolve, replies);
          } catch (error) { finish(reject, error); }
        }
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "alpha-fixture", version: "1" } } }) + "\n");
    });
  } finally { child.kill(); }
}

// The alpha ZIP builder stays in the private repository; the public cut has no
// alpha installer to exercise, and says so by name.
const ALPHA_TOOLING_ABSENT = !existsSync(join(ROOT, "scripts", "pack-alpha.mjs"));

test("alpha ZIP installs offline and gives agents runnable commands plus a real MCP inventory", {
  skip: ALPHA_TOOLING_ABSENT ? "the private alpha ZIP tooling is absent from this public source cut"
    : !["darwin", "linux"].includes(process.platform) ? "Private alpha ZIP workflow supports macOS/Linux only"
    : missingArchiveTools.length ? `Private alpha ZIP requires tools on PATH: ${missingArchiveTools.join(", ")}` : false,
  timeout: 120_000,
}, async (t) => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), `${PRODUCT}-alpha-test-`)));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const output = join(scratch, "handoff with spaces");
  const result = JSON.parse(run(process.execPath,
    [join(ROOT, "scripts", "pack-alpha.mjs"), "--out", output], ROOT));
  assert.deepEqual(readdirSync(output), [result.archive.split("/").at(-1)]);
  assert.equal(sha(result.archive), result.sha256);
  const unpacked = join(scratch, "unpacked"); mkdirSync(unpacked);
  run("unzip", ["-q", result.archive, "-d", unpacked], scratch);
  const bundle = join(unpacked, result.buildId);
  const build = json(join(bundle, "BUILD.json"));
  assert.equal(build.package, NPM_PACKAGE);
  assert.equal(build.buildId, result.buildId);
  assert.equal(build.verification.releaseGates, "not run by pack:alpha");
  assert.deepEqual(readdirSync(bundle).sort(),
    [build.payload.file, "START-HERE.md", "INSTALL.txt", "BUILD.json", "SHA256SUMS"].sort());
  for (const line of read(join(bundle, "SHA256SUMS")).trim().split("\n")) {
    const [expected, file] = line.split("  ");
    assert.equal(sha(join(bundle, file)), expected, file);
  }
  assert.ok(read(join(bundle, "INSTALL.txt")).includes(build.payload.file));
  assert.doesNotMatch(read(join(bundle, "INSTALL.txt")), /\{\{PACKAGE_ARCHIVE\}\}/);
  assert.equal(read(join(bundle, "START-HERE.md")), read(join(ROOT, "docs", "install.md")));

  const repo = join(scratch, "tester's repo with spaces"); mkdirSync(repo);
  const home = join(scratch, "home"); mkdirSync(home);
  const env = { ...process.env, HOME: home, SANNR_HOME: join(home, "registry"),
    npm_config_cache: join(scratch, "empty-npm-cache"), npm_config_registry: "http://127.0.0.1:1" };
  for (const name of Object.keys(env)) if (name.startsWith("API_")) delete env[name];
  run("git", ["init", "-q"], repo, env);
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "alpha-fixture", private: true,
    scripts: { preinstall: 'node -e "process.exit(97)"' } }));
  writeFileSync(join(repo, "openapi.json"), JSON.stringify({ openapi: "3.0.0",
    info: { title: "Fixture", version: "1" }, paths: { "/health": { get: {
      responses: { "200": { description: "OK" } } } } } }));
  writeFileSync(join(repo, "AGENTS.md"), "Keep this existing project instruction.\n");
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "untouched" } } }));
  mkdirSync(join(repo, "vendor"));
  copyFileSync(join(bundle, build.payload.file), join(repo, "vendor", `${PRODUCT}-alpha.tgz`));
  const installArgs = ["install", "--offline", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund",
    `./vendor/${PRODUCT}-alpha.tgz`];
  const npm = (args) => process.env.npm_execpath
    ? run(process.execPath, [process.env.npm_execpath, ...args], repo, env) : run("npm", args, repo, env);
  npm(installArgs);
  const cliPath = join(repo, "node_modules", ".bin", PRODUCT);
  accessSync(cliPath, constants.X_OK);
  const cli = (...args) => run(process.execPath, [cliPath, ...args], repo, env);
  assert.match(cli("--help"), /start/);
  const installedBuild = json(join(repo, "node_modules", ...NPM_PACKAGE.split("/"), "lib", "build-info.json"));
  assert.equal(build.packageBuildId, installedBuild.buildId, "the outer receipt must identify the installed package build");
  assert.ok(cli("--version").includes(installedBuild.buildId));
  const started = JSON.parse(cli("start", "--json"));
  assert.equal(started.status, "configured");
  assert.equal(started.requests_executed, 0);
  assert.equal(started.setup.context.state, "available");
  assert.equal(started.setup.context.operations, 1);
  assert.equal(started.setup.context.verified, 0);
  assert.equal(started.setup.host.state, "confirmation_required");
  const binding = started.setup.host.binding_id;
  assert.equal(typeof binding, "string");
  assert.ok(binding.length > 0, "the installed package must identify its project binding");
  assert.ok(started.setup.continuation.prompt.includes(TOOL_NAME));
  assert.equal(started.inventory.state, "available");
  assert.equal(started.inventory.summary.operations, 1);
  const connected = started.connection;
  assert.equal(connected.omitted.length, 0, "agents must receive executable commands");
  // STACKS-1A creates a named store from the bundled fixture contract.
  const knowledge = join(repo, LAYOUT.collection, "fixture", CONTEXT_BASENAME);
  assert.ok(existsSync(knowledge));
  cli("connect", "--alpha", "--json");
  for (const host of [".claude", ".agents"]) {
    for (const skill of [`${PRODUCT}-request`, `${PRODUCT}-write`, `${PRODUCT}-feedback`])
      assert.ok(existsSync(join(repo, host, "skills", skill, "SKILL.md")));
    assert.ok(read(join(repo, host, "skills", `${PRODUCT}-write`, "SKILL.md"))
      .includes(`./node_modules/.bin/${PRODUCT} note`));
    const skillDir = join(repo, host, "skills", `${PRODUCT}-request`);
    const docsLink = /\[[^\]]+\]\(([^)]+\/docs\/agent-guide\.md)\)/.exec(read(join(skillDir, "SKILL.md")))?.[1];
    assert.ok(docsLink, "the installed skill must link to the agent operating guide");
    assert.ok(!docsLink.startsWith("/"), "the installed skill's documentation link must remain portable");
    const documentation = resolve(skillDir, decodeURIComponent(docsLink));
    assert.ok(existsSync(documentation), "the installed skill's documentation entry point must resolve");
    assert.equal(realpathSync(documentation),
      realpathSync(join(repo, "node_modules", ...NPM_PACKAGE.split("/"), "docs", "agent-guide.md")),
      "the portable link must resolve to this installation's bundled guide");
    for (const [, link] of read(documentation).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^(?:[a-z]+:|#)/i.test(link)) continue;
      assert.ok(existsSync(resolve(dirname(documentation), decodeURIComponent(link.split("#")[0]))),
        `the installed agent guide links to missing ${link}`);
    }
  }
  assert.match(read(join(repo, "AGENTS.md")), /^Keep this existing project instruction\./);
  assert.ok(read(join(repo, "AGENTS.md")).includes(`./node_modules/.bin/${PRODUCT}`));
  assert.ok(read(join(repo, "AGENTS.md")).includes(`Setup binding: ${binding}`));
  assert.equal(read(join(repo, "CLAUDE.md")), '@AGENTS.md\n',
    'a fresh Claude install bridges to the same complete agent instructions');
  const mcp = json(join(repo, ".mcp.json"));
  assert.equal(mcp.mcpServers.other.command, "untouched");
  const entry = mcp.mcpServers[MCP_SERVER_KEY];
  assert.equal(entry.env.API_SETUP_BINDING, binding);
  assert.equal(entry.args.length, 1, 'a retained repo-local package must not launch through npm');
  assert.equal(entry.args[0], join(repo, "node_modules", ...NPM_PACKAGE.split("/"), "server.mjs"));
  assert.ok(read(join(repo, ".codex", "config.toml")).includes(JSON.stringify(entry.args[0])));
  const replies = await inventory(entry, home, env);
  assert.ok(replies.get(1).result.serverInfo);
  const apiTool = replies.get(2).result.tools.find((tool) => tool.name === TOOL_NAME);
  assert.ok(apiTool);
  assert.ok(apiTool.description.includes(`Setup binding: ${binding}`),
    "the launched server must advertise this repository's binding without an API request");
  cli("note", "GET /health", "This is a packaging fixture note, not an API observation.");
  assert.ok(JSON.stringify(json(knowledge)).includes("This is a packaging fixture note"));
  // Alpha builds can keep the same package version. Replacing the archive must
  // still install new bytes, even with an existing lockfile and npm cache.
  const upgrade = join(scratch, "upgrade"); mkdirSync(upgrade);
  run("tar", ["xzf", join(bundle, build.payload.file), "-C", upgrade], scratch);
  const upgradedReadme = read(join(upgrade, "package", "README.md")) + "\nUpdated alpha fixture.\n";
  writeFileSync(join(upgrade, "package", "README.md"), upgradedReadme);
  const upgradedTar = join(scratch, "upgraded.tgz");
  run("tar", ["czf", upgradedTar, "-C", upgrade, "package"], scratch);
  copyFileSync(upgradedTar, join(repo, "vendor", `${PRODUCT}-alpha.tgz`));
  npm(installArgs);
  assert.equal(read(join(repo, "node_modules", ...NPM_PACKAGE.split("/"), "README.md")), upgradedReadme);
  const upgradedSetup = JSON.parse(cli("start", "--json"));
  assert.equal(upgradedSetup.connection.omitted.length, 0);
  assert.equal(upgradedSetup.setup.host.binding_id, binding, "reinstalling at the same location keeps the binding stable");
  cli("unwire");
  assert.equal(json(join(repo, ".mcp.json")).mcpServers.other.command, "untouched");
  assert.equal(json(join(repo, ".mcp.json")).mcpServers[MCP_SERVER_KEY], undefined);
  assert.equal(read(join(repo, "AGENTS.md")).trim(), "Keep this existing project instruction.");
  assert.ok(existsSync(knowledge), "unwire preserves recorded knowledge");
  npm(["uninstall", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", NPM_PACKAGE]);
  assert.equal(existsSync(cliPath), false);
});
