import { LAYOUT } from "../lib/layout.mjs";
// AX-A — the reflex-moment interception hook.
//
// This suite is deliberately separate from connect.test.mjs: it executes the
// generated Claude Code command as a real stdin/stdout hook, and adversarially
// drives the shell/URL classifier without ever executing an intercepted line.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { CLI_NAME } from "../lib/brand.mjs";
import { capabilityManifest } from "../lib/capabilities.mjs";
import {
  CLAUDE_HOOK_SETTINGS,
  PLUMBING_ESCAPE,
  claudeHookEntry,
  configuredBaseUrls,
  inspectShellHttp,
  planClaudeHookRemoval,
  renderClaudeHookCommand,
} from "../lib/claude-hook.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const SOURCE_CLI = `node ${CLI}`;
// Every subprocess sees only fixture-local git configuration.
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

function cli(cwd, args, env = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, ...env, ...GIT_ENV },
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

function scratch({ config, files = {}, prefix = "connect-hook-" } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hook-home-")));
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ...GIT_ENV };
  execFileSync("git", ["init", "-q"], { cwd: dir, env: { ...process.env, ...env } });
  writeFileSync(join(dir, "openapi.yaml"),
    "openapi: 3.0.0\ninfo:\n  title: t\npaths:\n  /health:\n    get:\n      summary: health\n");
  if (config !== false) writeFileSync(join(dir, LAYOUT.environments), JSON.stringify(config ?? {
      v: 1,
      default: "local",
      environments: { local: { baseUrl: "https://api.example.test/v1" } },
    }, null, 2));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return { dir, env };
}

function hookRow(settings) {
  return settings.hooks.PreToolUse.find((row) =>
    row?.hooks?.some((hook) => hook.command?.includes("managed-shell-http-intercept")));
}

function runInstalledHook(dir, command, env = {}) {
  const settings = JSON.parse(readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8"));
  const installed = hookRow(settings)?.hooks?.[0]?.command;
  assert.ok(installed, "connect did not install a recognisable PreToolUse command hook");
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
    tool_input: { command } });
  return spawnSync("/bin/sh", ["-c", installed], {
    cwd: dir, input, encoding: "utf8", env: { ...process.env, ...env, ...GIT_ENV },
  });
}

function walkFiles(root) {
  const out = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) out.push(path);
    }
  };
  visit(root);
  return out;
}

test("optional interception is disclosed in JSON and help without making ordinary setup look broken", () => {
  const { dir, env } = scratch();
  const plain = cli(dir, ["connect", "--no-skills", "--no-pointers", "--json"], env);
  assert.equal(plain.code, 0, plain.out);
  assert.ok(!existsSync(join(dir, CLAUDE_HOOK_SETTINGS)), "plain connect silently installed a hook");
  const plainReport = JSON.parse(plain.out);
  assert.equal(plainReport.hooks.claude_code.action, "not_requested");
  assert.match(plainReport.hooks.claude_code.fix, /--claude-hook/);
  assert.match(plainReport.hooks.claude_code.scope, /--config|input-file|pipe.*shell/i,
    "indirect URL sources are unsupported but undisclosed");
  assert.equal(plainReport.hooks.codex.action, "unsupported");
  assert.match(plainReport.hooks.codex.reason, /reliable.*PreToolUse|PreToolUse.*reliable/i);
  assert.match(plainReport.hooks.codex.fallback, /MCP.*skills.*pointer/i);
  const text = cli(dir, ["connect", "--no-skills", "--no-pointers"], env);
  assert.equal(text.code, 0, text.out);
  assert.doesNotMatch(text.out, /not_requested|unsupported\s+Codex hook/);
  const hookText = cli(dir, ["connect", "--claude-hook", "--dry-run", "--no-skills", "--no-pointers"], env);
  assert.equal(hookText.code, 0, hookText.out);
  assert.match(hookText.out, /Claude Code hook/);
  assert.match(hookText.out, /dynamic shell-variable targets[\s\S]*not guessed/);
  assert.match(hookText.out, /unsupported\s+Codex hook/);

  const dry = cli(dir, ["connect", "--claude-hook", "--dry-run", "--no-skills",
    "--no-pointers", "--json"], env);
  assert.equal(dry.code, 0, dry.out);
  assert.ok(!existsSync(join(dir, CLAUDE_HOOK_SETTINGS)), "hook dry-run wrote settings");
  assert.equal(JSON.parse(dry.out).hooks.claude_code.action, "would_create");

  const help = cli(dir, ["connect", "--help"], env);
  assert.equal(help.code, 0, help.out);
  assert.match(help.out, /--claude-hook/);
  assert.match(help.out, /Claude Code.*PreToolUse/i);
  assert.match(help.out, /Codex.*unsupported|unsupported.*Codex/i);
});

test("explicit hook install merges, is idempotent, and exact unwire is conservative", () => {
  const foreign = { matcher: "Bash", hooks: [{ type: "command", command: "./team-policy.sh" }] };
  const { dir, env } = scratch({ files: {
    [CLAUDE_HOOK_SETTINGS]: `${JSON.stringify({ permissions: { allow: ["Read"] },
      hooks: { PreToolUse: [foreign] } }, null, 2)}\n`,
  } });
  const first = cli(dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"], env);
  assert.equal(first.code, 0, first.out);
  const installed = readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8");
  const doc = JSON.parse(installed);
  assert.deepEqual(doc.permissions, { allow: ["Read"] });
  assert.ok(doc.hooks.PreToolUse.some((row) => row.hooks?.[0]?.command === "./team-policy.sh"));
  const managed = hookRow(doc);
  assert.ok(managed, "the managed hook was not merged beside the team hook");
  assert.deepEqual(Object.keys(managed).sort(), ["hooks", "matcher"],
    "ownership metadata leaked into Claude Code's hook schema");
  assert.deepEqual(Object.keys(managed.hooks[0]).sort(), ["command", "timeout", "type"]);
  assert.equal(execFileSync("git", ["status", "--short", "--untracked-files=all", "--", ".claude"],
    { cwd: dir, encoding: "utf8", env: { ...process.env, ...env, ...GIT_ENV } }), "",
  "the machine-local hook created a commit-visible ownership artifact");

  const second = cli(dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"], env);
  assert.equal(second.code, 0, second.out);
  assert.equal(readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8"), installed,
    "an idempotent hook install changed bytes");
  assert.equal(JSON.parse(second.out).hooks.claude_code.action, "unchanged");

  const unwired = cli(dir, ["unwire", "--json"], env);
  assert.equal(unwired.code, 0, unwired.out);
  const left = JSON.parse(readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8"));
  assert.deepEqual(left.permissions, { allow: ["Read"] });
  assert.deepEqual(left.hooks.PreToolUse, [foreign], "unwire removed the user's own hook");

  const fresh = scratch();
  assert.equal(cli(fresh.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], fresh.env).code, 0);
  assert.equal(cli(fresh.dir, ["unwire", "--json"], fresh.env).code, 0);
  assert.ok(!existsSync(join(fresh.dir, CLAUDE_HOOK_SETTINGS)), "unwire left its exact local settings file");
  assert.ok(!existsSync(join(fresh.dir, ".claude")), "unwire left empty hook scaffolding");
});

const IGNORE_MARKER = "# sannr:managed-claude-hook-ignore";
const HOOK_CONNECT = ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"];
const git = (dir, args, env) => execFileSync("git", args, {
  cwd: dir, encoding: "utf8", env: { ...process.env, ...env, ...GIT_ENV },
});

test("hook ignore is planned, idempotent, and unwire restores unrelated exclude bytes", () => {
  for (const original of ["# team\n*.private\n", "# team\n*.private", "# team\r\n*.private\r\n"]) {
    const { dir, env } = scratch();
    const exclude = join(dir, ".git/info/exclude");
    writeFileSync(exclude, original);
    const dry = cli(dir, [...HOOK_CONNECT, "--dry-run"], env);
    assert.equal(dry.code, 0, dry.out);
    assert.equal(JSON.parse(dry.out).hooks.claude_code.ignore.action, "would_append");
    assert.equal(readFileSync(exclude, "utf8"), original, "dry run wrote the exclude");
    const first = cli(dir, HOOK_CONNECT, env);
    assert.equal(first.code, 0, first.out);
    assert.equal(JSON.parse(first.out).hooks.claude_code.ignore.action, "append");
    const installed = readFileSync(exclude, "utf8");
    assert.ok(installed.startsWith(original), "install changed an existing exclude byte");
    assert.match(installed, /# sannr:managed-claude-hook-ignore[^\n]*\n\.claude\/settings\.local\.json\n/);
    assert.equal(git(dir, ["status", "--short", "--untracked-files=all", "--", ".claude"], env), "");
    const second = cli(dir, HOOK_CONNECT, env);
    assert.equal(second.code, 0, second.out);
    assert.equal(JSON.parse(second.out).hooks.claude_code.ignore.action, "unchanged");
    assert.equal(readFileSync(exclude, "utf8"), installed);
    writeFileSync(exclude, `${installed}# added afterwards\n.claude/settings.local.json\nkeep-me\n`);
    const unwired = cli(dir, ["unwire", "--json"], env);
    assert.equal(unwired.code, 0, unwired.out);
    assert.equal(JSON.parse(unwired.out).hooks.claude_code.ignore.action, "removed");
    assert.equal(readFileSync(exclude, "utf8"), `${original}# added afterwards\n.claude/settings.local.json\nkeep-me\n`,
      "unwire removed or changed bytes outside its exact appended block");
  }
});

test("hook ignore leaves covering gitignore and existing excludes untouched", () => {
  for (const file of [".gitignore", ".git/info/exclude"]) {
    const { dir, env } = scratch();
    writeFileSync(join(dir, file), "# team rule\n**/.claude/settings.local.json\n");
    const before = readFileSync(join(dir, ".git/info/exclude"), "utf8");
    const rule = readFileSync(join(dir, file), "utf8");
    const connected = cli(dir, HOOK_CONNECT, env);
    assert.equal(connected.code, 0, connected.out);
    assert.equal(JSON.parse(connected.out).hooks.claude_code.ignore.action, "already_ignored");
    assert.equal(readFileSync(join(dir, ".git/info/exclude"), "utf8"), before);
    assert.equal(cli(dir, ["unwire", "--json"], env).code, 0);
    assert.equal(readFileSync(join(dir, file), "utf8"), rule, "unwire removed a team ignore rule");
    assert.equal(readFileSync(join(dir, ".git/info/exclude"), "utf8"), before);
  }
});

test("hook ignore reports non-git skip by name without creating git metadata", () => {
  const { dir, env } = scratch();
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  const connected = cli(dir, HOOK_CONNECT, env);
  assert.equal(connected.code, 0, connected.out);
  const ignore = JSON.parse(connected.out).hooks.claude_code.ignore;
  assert.equal(ignore.action, "skipped");
  assert.equal(ignore.code, "CLAUDE_HOOK_IGNORE_NOT_GIT_WORKTREE");
  assert.ok(existsSync(join(dir, CLAUDE_HOOK_SETTINGS)));
  assert.ok(!existsSync(join(dir, ".git")));
});

test("hook ignore resolves a linked worktree's common git exclude", () => {
  const { dir, env } = scratch();
  git(dir, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "commit", "--allow-empty", "-m", "fixture"], env);
  const worktree = join(realpathSync(mkdtempSync(join(tmpdir(), "hook-worktree-"))), "checkout");
  git(dir, ["worktree", "add", "--detach", worktree], env);
  writeFileSync(join(worktree, LAYOUT.environments), readFileSync(join(dir, LAYOUT.environments)));
  const exclude = join(dir, ".git/info/exclude");
  const before = readFileSync(exclude, "utf8");
  const connected = cli(worktree, HOOK_CONNECT, env);
  assert.equal(connected.code, 0, connected.out);
  assert.match(readFileSync(exclude, "utf8"), /sannr:managed-claude-hook-ignore/);
  assert.equal(git(worktree, ["status", "--short", "--untracked-files=all", "--", ".claude"], env), "");
  assert.equal(cli(worktree, ["unwire", "--json"], env).code, 0);
  assert.equal(readFileSync(exclude, "utf8"), before);
});

test("unwire leaves edited or duplicate owned ignore blocks conservatively", () => {
  for (const edit of [
    (text) => text.replace(`${IGNORE_MARKER}\n.claude/settings.local.json`, `${IGNORE_MARKER}\n.claude/`),
    (text) => text.replace(IGNORE_MARKER, `${IGNORE_MARKER}:team-edited`),
    (text) => `${text}${IGNORE_MARKER}\n.claude/settings.local.json\n`,
  ]) {
    const { dir, env } = scratch();
    assert.equal(cli(dir, HOOK_CONNECT, env).code, 0);
    const exclude = join(dir, ".git/info/exclude");
    const edited = edit(readFileSync(exclude, "utf8"));
    writeFileSync(exclude, edited);
    const unwired = cli(dir, ["unwire", "--json"], env);
    assert.equal(unwired.code, 0, unwired.out);
    assert.equal(JSON.parse(unwired.out).hooks.claude_code.ignore.action, "left");
    assert.equal(readFileSync(exclude, "utf8"), edited);
  }
});

test("hook ignore refuses linked git excludes before writing any connect surface", () => {
  const { dir, env } = scratch();
  const outside = join(realpathSync(mkdtempSync(join(tmpdir(), "hook-exclude-"))), "exclude");
  const original = "# external\n";
  writeFileSync(outside, original);
  const exclude = join(dir, ".git/info/exclude");
  rmSync(exclude);
  symlinkSync(outside, exclude);
  const connected = cli(dir, HOOK_CONNECT, env);
  assert.equal(connected.code, 1, connected.out);
  assert.match(connected.out, /CLAUDE_HOOK_IGNORE_PATH_UNSAFE/);
  assert.equal(readFileSync(outside, "utf8"), original);
  assert.ok(!existsSync(join(dir, ".mcp.json")));
  assert.ok(!existsSync(join(dir, CLAUDE_HOOK_SETTINGS)));
  const unwired = cli(dir, ["unwire", "--json"], env);
  assert.equal(unwired.code, 0, unwired.out);
  assert.equal(JSON.parse(unwired.out).hooks.claude_code.ignore.action, "left");
  assert.equal(readFileSync(outside, "utf8"), original);
});

for (const tracked of [false, true]) {
  test(`hook ignore refuses ${tracked ? "tracked settings" : "higher-precedence negations"} before writes`, () => {
    const { dir, env } = scratch({ files: { [CLAUDE_HOOK_SETTINGS]: "{}\n" } });
    if (tracked) git(dir, ["add", "-f", "--", CLAUDE_HOOK_SETTINGS], env);
    else writeFileSync(join(dir, ".gitignore"), `!${CLAUDE_HOOK_SETTINGS}\n`);
    const exclude = join(dir, ".git/info/exclude");
    const original = readFileSync(exclude, "utf8");
    const connected = cli(dir, HOOK_CONNECT, env);
    assert.equal(connected.code, 1, connected.out);
    assert.match(connected.out, tracked ? /CLAUDE_HOOK_SETTINGS_TRACKED/ : /CLAUDE_HOOK_IGNORE_CONFLICT/);
    assert.equal(readFileSync(exclude, "utf8"), original);
    assert.equal(readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8"), "{}\n");
    assert.ok(!existsSync(join(dir, ".mcp.json")));
  });
}

test("nested hook connect still protects the checkout root without relying on global ignores", () => {
  const { dir, env } = scratch();
  const nested = join(dir, "nested", "project");
  mkdirSync(nested, { recursive: true });
  const globalIgnore = join(env.XDG_CONFIG_HOME, "git", "ignore");
  mkdirSync(dirname(globalIgnore), { recursive: true });
  const globalRule = "**/.claude/settings.local.json\n";
  writeFileSync(globalIgnore, globalRule);
  const connected = cli(nested, HOOK_CONNECT, env);
  assert.equal(connected.code, 0, connected.out);
  assert.equal(JSON.parse(connected.out).hooks.claude_code.ignore.action, "append");
  assert.ok(existsSync(join(dir, CLAUDE_HOOK_SETTINGS)));
  assert.ok(!existsSync(join(nested, CLAUDE_HOOK_SETTINGS)));
  assert.equal(git(dir, ["-c", "core.excludesFile=/dev/null", "status", "--short",
    "--untracked-files=all", "--", ".claude"], env), "");
  assert.equal(cli(nested, ["unwire", "--json"], env).code, 0);
  assert.equal(readFileSync(globalIgnore, "utf8"), globalRule);
});

test("unwire admits only a prior env-base snapshot, never edited runtime or guidance fields", () => {
  const original = renderClaudeHookCommand({ nodePath: "/usr/bin/node",
    hookPath: "/repo/lib/claude-hook.mjs", configPath: "/repo/api-environments.json",
    doctor: `${CLI_NAME} doctor`, pinnedBaseUrls: ["https://api.example.test/v1"] });
  const priorEnv = renderClaudeHookCommand({ nodePath: "/usr/bin/node",
    hookPath: "/repo/lib/claude-hook.mjs", configPath: "/repo/api-environments.json",
    doctor: `${CLI_NAME} doctor`, pinnedBaseUrls: ["https://old.example.test/v1"] });
  const textFor = (command) => JSON.stringify({ hooks: { PreToolUse: [claudeHookEntry(command)] } });
  assert.equal(planClaudeHookRemoval(textFor(priorEnv), original).action, "removed",
    "a changed/unset API_BASE_URL orphaned the exact prior generated hook");

  const variants = [
    { nodePath: ("/" + "tmp/team-node") },
    { hookPath: ("/" + "tmp/team-hook.mjs") },
    { configPath: ("/" + "tmp/team-config.json") },
    { doctor: "team-owned doctor --custom" },
    { pinnedBaseUrls: ["https://team-owned.example/private"] },
  ];
  for (const changed of variants) {
    const edited = renderClaudeHookCommand({ nodePath: "/usr/bin/node",
      hookPath: "/repo/lib/claude-hook.mjs", configPath: "/repo/api-environments.json",
      doctor: `${CLI_NAME} doctor`, pinnedBaseUrls: ["https://api.example.test/v1"], ...changed });
    const installedThenEdited = textFor(edited).replace(
      edited.split(" ").at(-1), original.split(" ").at(-1));
    assert.equal(planClaudeHookRemoval(installedThenEdited, original).action, "left",
      `unwire deleted a hook whose ${Object.keys(changed)[0]} was edited`);
  }
});

test("hook planning refuses malformed, linked, and edited managed settings without clobber", () => {
  const malformed = scratch({ files: { [CLAUDE_HOOK_SETTINGS]: "{ nope\n" } });
  const bad = cli(malformed.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"], malformed.env);
  assert.equal(bad.code, 1, bad.out);
  assert.match(bad.out, /CLAUDE_HOOK_SETTINGS_INVALID/);
  assert.equal(readFileSync(join(malformed.dir, CLAUDE_HOOK_SETTINGS), "utf8"), "{ nope\n");
  assert.ok(!existsSync(join(malformed.dir, ".mcp.json")), "connect partly wired before hook preflight failed");

  const linked = scratch();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-hook-")));
  writeFileSync(join(outside, "settings.local.json"), "{}\n");
  mkdirSync(join(linked.dir, ".claude"));
  symlinkSync(join(outside, "settings.local.json"), join(linked.dir, CLAUDE_HOOK_SETTINGS));
  const linkResult = cli(linked.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], linked.env);
  assert.equal(linkResult.code, 1, linkResult.out);
  assert.equal(readFileSync(join(outside, "settings.local.json"), "utf8"), "{}\n");

  const edited = scratch();
  assert.equal(cli(edited.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], edited.env).code, 0);
  const path = join(edited.dir, CLAUDE_HOOK_SETTINGS);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  hookRow(settings).hooks[0].command += " --team-edit";
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
  const reconnect = cli(edited.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], edited.env);
  assert.equal(reconnect.code, 1, reconnect.out);
  assert.match(reconnect.out, /CLAUDE_HOOK_CONFLICT/);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse.filter((row) =>
    row.hooks?.some((hook) => hook.command?.includes("managed-shell-http-intercept"))).length, 1,
    "reconnect appended a second managed hook beside the edited one");
  const removal = JSON.parse(cli(edited.dir, ["unwire", "--json"], edited.env).out);
  assert.equal(removal.hooks.claude_code.action, "left");
  assert.match(removal.hooks.claude_code.reason, /edited|different|differs/i);
  assert.ok(existsSync(path), "unwire deleted an edited hook");

  const duplicate = scratch();
  assert.equal(cli(duplicate.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], duplicate.env).code, 0);
  const duplicatePath = join(duplicate.dir, CLAUDE_HOOK_SETTINGS);
  const duplicateDoc = JSON.parse(readFileSync(duplicatePath, "utf8"));
  duplicateDoc.hooks.PreToolUse.push(structuredClone(hookRow(duplicateDoc)));
  const duplicateBytes = `${JSON.stringify(duplicateDoc, null, 2)}\n`;
  writeFileSync(duplicatePath, duplicateBytes);
  const duplicateConnect = cli(duplicate.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], duplicate.env);
  assert.equal(duplicateConnect.code, 1, duplicateConnect.out);
  assert.equal(readFileSync(duplicatePath, "utf8"), duplicateBytes);
  const duplicateUnwire = JSON.parse(cli(duplicate.dir, ["unwire", "--json"], duplicate.env).out);
  assert.equal(duplicateUnwire.hooks.claude_code.action, "left");
  assert.equal(readFileSync(duplicatePath, "utf8"), duplicateBytes);
});

test("connect and unwire never read or rewrite hardlinked/non-regular local hook settings", () => {
  const hardlinked = scratch();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "outside-hard-hook-")));
  const external = join(outside, "team-settings.json");
  const original = `${JSON.stringify({ team: "owned" }, null, 2)}\n`;
  writeFileSync(external, original);
  mkdirSync(join(hardlinked.dir, ".claude"));
  linkSync(external, join(hardlinked.dir, CLAUDE_HOOK_SETTINGS));
  const install = cli(hardlinked.dir,
    ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"], hardlinked.env);
  assert.equal(install.code, 1, install.out);
  assert.match(install.out, /CLAUDE_HOOK_PATH_UNSAFE/);
  assert.equal(readFileSync(external, "utf8"), original, "connect rewrote the external hardlink target");
  assert.ok(!existsSync(join(hardlinked.dir, ".mcp.json")), "hook path refusal happened after MCP writes");
  const removal = JSON.parse(cli(hardlinked.dir, ["unwire", "--json"], hardlinked.env).out);
  assert.equal(removal.hooks.claude_code.action, "left");
  assert.match(removal.hooks.claude_code.reason, /hard link|multiple links/i);
  assert.equal(readFileSync(external, "utf8"), original, "unwire rewrote the external hardlink target");

  const fifo = scratch();
  mkdirSync(join(fifo.dir, ".claude"));
  const fifoPath = join(fifo.dir, CLAUDE_HOOK_SETTINGS);
  execFileSync("mkfifo", [fifoPath]);
  const fifoInstall = cli(fifo.dir,
    ["connect", "--claude-hook", "--no-skills", "--no-pointers"], fifo.env);
  assert.equal(fifoInstall.code, 1, fifoInstall.out);
  assert.match(fifoInstall.out, /CLAUDE_HOOK_PATH_UNSAFE/);
  assert.equal(lstatSync(fifoPath).isFIFO(), true, "connect replaced a non-regular target");
});

test("configured URL inventory includes every environment and host without credential loading", () => {
  const text = JSON.stringify({
    environments: {
      local: { baseUrl: "https://api.example.test/v1", hosts: {
        media: { baseUrl: "https://media.example.test/api", envFile: "./secrets.env" },
      } },
      staging: { baseUrl: "https://staging.example.test", hosts: {
        search: { baseUrl: "https://search.example.test/v2" },
      } },
    },
    hosts: { billing: { baseUrl: "https://billing.example.test" } },
  });
  assert.deepEqual(configuredBaseUrls(text), [
    "https://api.example.test/v1",
    "https://billing.example.test",
    "https://media.example.test/api",
    "https://search.example.test/v2",
    "https://staging.example.test",
  ]);
});

test("shell classifier matches exact own URL semantics and leaves lookalikes untouched", () => {
  const own = ["https://API.Example.test:443/v1/./"];
  const denied = [
    "curl https://api.example.test/v1",
    "wget 'https://api.example.test/v1/orders?token=x#frag'",
    "/usr/bin/curl --url=https://user:pass@api.example.test/v1/orders",
    "command curl https://api.example.test/v1/orders",
    "env MODE=x wget https://api.example.test/v1/orders",
    "env -u UNUSED curl https://api.example.test/v1/orders",
    "env -C /tmp wget https://api.example.test/v1/orders",
    "printf x; curl https://api.example.test/v1/orders",
    "printf x && wget https://api.example.test/v1/orders",
    "printf x | /usr/bin/curl https://api.example.test/v1/orders",
    "echo $(curl https://api.example.test/v1/orders)",
    "echo `wget https://api.example.test/v1/orders`",
    "curl 'https://api.example.test'\"/v1/orders\"",
    "'cu''rl' https://api.example.test/v1/orders",
    "cu\\rl https://api.example.test/v1/orders",
    "printf x\ncurl https://api.example.test/v1/orders",
    "bash -c 'curl https://api.example.test/v1/orders'",
    "sh -c \"wget https://api.example.test/v1/orders\"",
    "zsh -c 'printf x; /usr/bin/curl https://api.example.test/v1/orders'",
    "curl https://other.example.test https://api.example.test/v1/orders",
    "wget https://other.example.test https://api.example.test/v1/orders",
    "curl https://api.example.test./v1/orders",
    "curl https://api.example.test/%76%31/orders",
    "exec curl https://api.example.test/v1/orders",
    "time curl https://api.example.test/v1/orders",
    "nohup wget https://api.example.test/v1/orders",
    "sudo curl https://api.example.test/v1/orders",
    "nice wget https://api.example.test/v1/orders",
    "timeout 5 curl https://api.example.test/v1/orders",
    "stdbuf -oL wget https://api.example.test/v1/orders",
    "cat <(curl https://api.example.test/v1/orders)",
    "curl https://other.example.test > >(curl https://api.example.test/v1/orders)",
    "if curl https://api.example.test/v1/orders; then echo ok; fi",
    "! curl https://api.example.test/v1/orders",
    "while wget https://api.example.test/v1/orders; do break; done",
    "cat <<EOF\n$(curl https://api.example.test/v1/orders)\nEOF",
    "cat <<EOF\n`curl https://api.example.test/v1/orders`\nEOF",
    "cat <<\\EOF\ndata\nEOF\ncurl https://api.example.test/v1/orders",
    "cat <<E\"OF\"\ndata\nEOF\ncurl https://api.example.test/v1/orders",
    "# <<EOF\ncurl https://api.example.test/v1/orders",
    "echo ok # <<EOF\ncurl https://api.example.test/v1/orders",
  ];
  for (const command of denied)
    assert.equal(inspectShellHttp(command, own).deny, true, command);

  const allowed = [
    "curl https://api.example.test.evil/v1",
    "curl http://api.example.test/v1",
    "curl https://api.example.test:444/v1",
    "curl https://api.example.test/v10",
    "curl https://api.example.test/other",
    "wget https://other.example.test/v1",
    "echo 'curl https://api.example.test/v1'",
    "printf '%s' wget https://api.example.test/v1",
    "./curl-report https://api.example.test/v1",
    "curl --header 'Referer: https://api.example.test/v1' https://other.example.test",
    "wget -O https://api.example.test/v1/output https://other.example.test/file",
    "curl -sSo https://api.example.test/v1/output https://other.example.test/file",
    "curl --referer https://api.example.test/v1 https://other.example.test/file",
    "curl --data https://api.example.test/v1 https://other.example.test/file",
    "curl -x https://api.example.test/v1 https://other.example.test/file",
    "curl --config ./urls.conf",
    "wget --input-file ./urls.txt",
    "printf 'curl https://api.example.test/v1' | bash",
    "curl -d @- https://other.example.test/file <<< https://api.example.test/v1/body",
    "cat <<'EOF'\ncurl https://api.example.test/v1\nEOF",
    "cat <<E\"OF\"\ncurl https://api.example.test/v1\nEOF",
    "cat <<EOF\ncurl https://api.example.test/v1\nEOF",
    "# curl https://api.example.test/v1",
    "echo \"$API_BASE_URL\"",
    "curl \"$API_BASE_URL/orders\"",
  ];
  for (const command of allowed)
    assert.equal(inspectShellHttp(command, own).deny, false, command);
  assert.equal(inspectShellHttp("curl \"$API_BASE_URL/orders\"", own).unsupported, "dynamic_url");
});

test("AX-3 names scheme-less, loopback, and unsupported-client specimens", () => {
  const own = ["http://localhost:3000"];
  const denied = [
    "curl localhost:3000/orders",
    'curl "localhost:3000/orders"',
    "curl -s localhost:3000/orders",
    "curl http://localhost:3000/orders",
    "curl http://127.0.0.1:3000/orders",
    "curl http://[::1]:3000/orders",
    "curl http://0.0.0.0:3000/orders",
    "curl -s http://localhost:3000/orders",
    "printf x | curl http://localhost:3000/orders",
    "printf x && curl http://localhost:3000/orders",
    "curl HTTP://LOCALHOST:3000/orders",
    "curl " + "x".repeat(3 * 1024 * 1024) + " http://localhost:3000/orders",
  ];
  for (const command of denied)
    assert.equal(inspectShellHttp(command, own).deny, true, command);

  for (const command of ["http GET http://localhost:3000/orders", "httpie GET http://localhost:3000/orders"]) {
    const result = inspectShellHttp(command, own);
    assert.equal(result.deny, false, command);
    assert.equal(result.unsupported, "client", command);
  }

  assert.equal(inspectShellHttp('curl -X POST "$API_BASE_URL/orders"', own).unsupported, "dynamic_url");
  for (const command of [
    "curl http://localhost/orders",
    "curl http://foreign.example/orders",
  ]) assert.equal(inspectShellHttp(command, own).deny, false, command);
});

test("plumbing escape applies only as an exact prefix of the intercepted simple command", () => {
  const own = ["https://api.example.test/v1"];
  for (const command of [
    `${PLUMBING_ESCAPE}=1 curl https://api.example.test/v1`,
    `env ${PLUMBING_ESCAPE}=1 wget https://api.example.test/v1`,
    `command env ${PLUMBING_ESCAPE}=1 /usr/bin/curl https://api.example.test/v1`,
  ]) assert.equal(inspectShellHttp(command, own).deny, false, command);
  for (const command of [
    `echo ${PLUMBING_ESCAPE}=1; curl https://api.example.test/v1`,
    `curl 'https://api.example.test/v1?x=${PLUMBING_ESCAPE}=1'`,
    `curl --data '${PLUMBING_ESCAPE}=1' https://api.example.test/v1`,
    `${PLUMBING_ESCAPE}=10 curl https://api.example.test/v1`,
    `curl https://api.example.test/v1 ${PLUMBING_ESCAPE}=1`,
  ]) assert.equal(inspectShellHttp(command, own).deny, true, command);
});

test("env-only configured base is pinned without secrets and fallback-only install refuses", () => {
  const secret = "ENV-URL-SECRET-CANARY-123456";
  const envOnly = scratch({ config: false });
  const connected = cli(envOnly.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"],
    { ...envOnly.env, API_BASE_URL: `https://user:${secret}@api.example.test/v1?token=${secret}` });
  assert.equal(connected.code, 0, connected.out);
  const settings = readFileSync(join(envOnly.dir, CLAUDE_HOOK_SETTINGS), "utf8");
  assert.doesNotMatch(settings, new RegExp(secret), "env URL credentials were persisted in local settings");
  const blocked = runInstalledHook(envOnly.dir, "curl https://api.example.test/v1/orders",
    { API_BASE_URL: "" });
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny",
    "the later hook process depended on inheriting connect's API_BASE_URL");
  const unwired = cli(envOnly.dir, ["unwire", "--json"], envOnly.env);
  assert.equal(unwired.code, 0, unwired.out);
  assert.equal(JSON.parse(unwired.out).hooks.claude_code.action, "removed",
    "unwire depended on the original API_BASE_URL still being exported");

  const fallback = scratch({ config: false });
  const refused = cli(fallback.dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"],
    fallback.env);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /CLAUDE_HOOK_NO_CONFIGURED_BASE/);
  assert.ok(!existsSync(join(fallback.dir, CLAUDE_HOOK_SETTINGS)));
});

test("installed hook follows safe config edits and never snapshots configured URL secrets", () => {
  const secret = "CONFIG-URL-SECRET-CANARY-123456";
  const { dir, env } = scratch({ config: {
    environments: { local: { baseUrl: `https://user:${secret}@old.example.test/v1?token=${secret}` } },
  } });
  assert.equal(cli(dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], env).code, 0);
  assert.doesNotMatch(readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8"), new RegExp(secret));
  assert.notEqual(runInstalledHook(dir, "curl https://old.example.test/v1").stdout, "");
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    environments: { local: { baseUrl: "https://new.example.test/v2" } },
  }));
  assert.equal(runInstalledHook(dir, "curl https://old.example.test/v1").stdout, "",
    "config-file base was pinned forever after it changed");
  assert.notEqual(runInstalledHook(dir, "curl https://new.example.test/v2/x").stdout, "",
    "hook did not safely reread the current config");
  writeFileSync(join(dir, LAYOUT.environments), "{ invalid\n");
  assert.equal(runInstalledHook(dir, `curl 'https://bad.example/${secret}`).stdout, "",
    "invalid config/URL emitted command-bearing diagnostics");
});

test("malformed and non-Bash hook input fail generically without secret output", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers"], env).code, 0);
  const settings = JSON.parse(readFileSync(join(dir, CLAUDE_HOOK_SETTINGS), "utf8"));
  const installed = hookRow(settings).hooks[0].command;
  const secret = "MALFORMED-HOOK-SECRET-123456";
  for (const input of [
    `{ not-json ${secret}`,
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Read",
      tool_input: { command: `curl https://api.example.test/v1?x=${secret}` } }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: { secret } } }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: `curl 'https://user:${secret}@[bad'` } }),
    "x".repeat(1024 * 1024 + 1),
  ]) {
    const r = spawnSync("/bin/sh", ["-c", installed], { cwd: dir, input, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    if (input.length > 1024 * 1024) {
      assert.match(r.stdout, /permissionDecision":"deny/);
      assert.doesNotMatch(`${r.stdout}${r.stderr}`, /MALFORMED-HOOK-SECRET/);
    } else assert.equal(`${r.stdout}${r.stderr}`, "", "invalid hook input was echoed or diagnosed with command data");
  }
});

test("installed hook denies without echoing or persisting secret-shaped command data", () => {
  const { dir, env } = scratch({ config: {
    v: 1, default: "local",
    environments: {
      local: { baseUrl: "https://api.example.test/v1" },
      staging: { baseUrl: "https://staging.example.test/api" },
    },
    hosts: { billing: { baseUrl: "https://billing.example.test" } },
  } });
  const connected = cli(dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"], env);
  assert.equal(connected.code, 0, connected.out);

  for (const target of [
    "https://api.example.test/v1/orders",
    "https://staging.example.test/api/orders",
    "https://billing.example.test/orders",
  ]) {
    const r = runInstalledHook(dir, `curl --url '${target}'`);
    assert.equal(r.status, 0, r.stderr);
    const decision = JSON.parse(r.stdout);
    assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
    const reason = decision.hookSpecificOutput.permissionDecisionReason;
    assert.ok(reason.includes(`${SOURCE_CLI} doctor`), `wrong doctor command: ${reason}`);
    assert.ok(reason.includes(`${PLUMBING_ESCAPE}=1`), `missing plumbing escape: ${reason}`);
  }

  const secret = "xoxb-AXA-SECRET-CANARY-123456789";
  const command = `curl -H 'Authorization: Bearer ${secret}' --data '${secret}' ` +
    `'https://user:${secret}@api.example.test/v1/orders?token=${secret}'`;
  const blocked = runInstalledHook(dir, command);
  assert.equal(blocked.status, 0, blocked.stderr);
  assert.doesNotMatch(`${blocked.stdout}${blocked.stderr}`, new RegExp(secret));
  assert.equal(JSON.parse(blocked.stdout).hookSpecificOutput.permissionDecision, "deny");
  for (const path of walkFiles(dir))
    assert.doesNotMatch(readFileSync(path, "utf8"), new RegExp(secret), `hook persisted secret in ${path}`);

  const escaped = runInstalledHook(dir, `${PLUMBING_ESCAPE}=1 ${command}`);
  assert.equal(escaped.status, 0, escaped.stderr);
  assert.equal(escaped.stdout, "", "the explicit plumbing escape still denied or echoed input");
  const arbitrary = runInstalledHook(dir, `curl -H 'Authorization: ${secret}' https://other.example.test/x`);
  assert.equal(arbitrary.status, 0, arbitrary.stderr);
  assert.equal(arbitrary.stdout, "", "arbitrary-host curl was intercepted");
});

test("generated command shell-quotes machine paths and transports guidance without expansion", () => {
  const odd = realpathSync(mkdtempSync(join(tmpdir(), "hook ' $() ` paths-")));
  const node = join(odd, "node ' $() `");
  const hook = join(odd, "hook ' $() `.mjs");
  symlinkSync(process.execPath, node);
  writeFileSync(hook, readFileSync(join(ROOT, "lib", "claude-hook.mjs")));
  const config = join(odd, "config ' $() `.json");
  writeFileSync(config, JSON.stringify({ environments: { x: {
    baseUrl: "https://api.example.test/v1",
  } } }));
  const doctor = `${CLI_NAME} doctor --label ' $() \``;
  const command = renderClaudeHookCommand({ nodePath: node, hookPath: hook, configPath: config, doctor });
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8",
    input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash",
      tool_input: { command: "curl https://api.example.test/v1" } }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason.includes(doctor), true);
  rmSync(odd, { recursive: true, force: true });
});

test("hook runtime never evaluates, spawns, logs, or writes intercepted input", () => {
  const source = readFileSync(join(ROOT, "lib", "claude-hook.mjs"), "utf8");
  assert.doesNotMatch(source, /node:child_process|\b(?:exec|execFile|spawn|fork|eval|Function)\s*\(/,
    "the hook can execute intercepted input");
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|createWriteStream|console\.(?:log|error|warn))\b/,
    "the hook can persist or log intercepted input");
});

test("capability self-report discloses the explicit local hook write and guard", () => {
  const manifest = capabilityManifest({ root: "/repo",
    config: { baseUrl: "https://api.example.test", hosts: {} },
    evidence: "/repo/evidence", usageLog: ("/" + "tmp/usage"), tokenCache: ("/" + "tmp/token"), tokenUrl: null });
  const row = manifest.writes.find((write) => write.path.includes(CLAUDE_HOOK_SETTINGS));
  assert.ok(row, "capabilities omits the new local-settings write");
  assert.equal(row.committed, false);
  assert.match(row.guard, /explicit connect --claude-hook/);
  assert.match(row.guard, /Codex.*no hook/i);
});
