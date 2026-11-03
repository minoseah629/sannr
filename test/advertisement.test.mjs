import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
  symlinkSync,
} from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MCP_SERVER_KEY, POINTER_BEGIN, POINTER_END, POINTER_CLI_NAME, PRODUCT, FEEDBACK_ORIGIN,
} from "../lib/brand.mjs";
import { POINTER_FILES } from "../lib/capabilities.mjs";
import { advertisementPlan } from "../lib/advertisement.mjs";
import { SKILL_SOURCES, SKILL_TARGETS, renderSkill, skillName } from "../lib/connect.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

function scratch({ shim = false, files = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "advertisement-"));
  const home = mkdtempSync(join(tmpdir(), "advertisement-home-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: Fixture, version: '1' }", "paths:",
    "  /health:", "    get:", "      responses: { '200': { description: ok } }", "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local",
    environments: { local: { baseUrl: "http://127.0.0.1:9" } },
  }, null, 2));
  for (const [name, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), bytes);
  }
  if (shim) installShim(dir);
  return { dir, home, env: { ...process.env, HOME: home } };
}

function installShim(dir) {
  const path = join(dir, "node_modules", ".bin", PRODUCT);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

function cli(dir, args, env) {
  return cliWith(CLI, dir, args, env);
}

function cliWith(executable, dir, args, env) {
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env,
  });
  const stdout = result.stdout ?? "", stderr = result.stderr ?? "";
  // JSON belongs to stdout. Keep both streams in failure diagnostics, including
  // doctor's pre-request announcements, without appending them to JSON input.
  return { code: result.status ?? 1, stdout, stderr,
    out: stdout + stderr + (result.error ? String(result.error) : "") };
}

function managedBlock(dir, file = "AGENTS.md") {
  const text = readFileSync(join(dir, file), "utf8");
  const begin = text.indexOf(POINTER_BEGIN), end = text.indexOf(POINTER_END, begin);
  assert.notEqual(begin, -1, `${file} has no managed pointer`);
  assert.notEqual(end, -1, `${file} has no managed pointer end`);
  return text.slice(begin, end + POINTER_END.length);
}

function commandOmissions(report) {
  assert.ok(Array.isArray(report.omitted), "structured output has no named omission set");
  for (const row of report.omitted) {
    assert.deepEqual(Object.keys(row), ["surface", "command", "reason", "remedy"]);
    assert.equal(row.command, POINTER_CLI_NAME);
    assert.ok(row.surface && row.reason && row.remedy);
  }
  return report.omitted;
}

function historicalSkill(source, invocation) {
  const matcher = new RegExp(
    `(^|[\\s\`(])${PRODUCT.replace(/[.*+?^${}()|[\]\\\\]/g, "\\$&")}` +
    `(?= [a-z][a-z-]*(?:$|\\s+[\"'-]))`, "gm");
  const template = renderSkill(source, PRODUCT);
  return template.replace(matcher, (_match, lead) => `${lead}${invocation}`);
}

test("connect names a truthful partial and installs MCP-backed command-free committed surfaces", () => {
  const { dir, home, env } = scratch();
  try {
    const result = cli(dir, ["connect", "--alpha", "--json"], env);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.doesNotMatch(report.note, /@alpha\b/);
    assert.ok(!report.note.includes(ROOT), "teammates must not receive this source checkout's invocation");
    const omitted = commandOmissions(report);
    assert.deepEqual(omitted.map(({ surface }) => surface), [
      "AGENTS.md", "CLAUDE.md",
      `${LAYOUT.skills}/${PRODUCT}-request/SKILL.md`, `${LAYOUT.skills}/${PRODUCT}-write/SKILL.md`, `${LAYOUT.skills}/${PRODUCT}-feedback/SKILL.md`,
      ".claude/skills/sannr-request/SKILL.md", ".claude/skills/sannr-write/SKILL.md", ".claude/skills/sannr-feedback/SKILL.md",
      ".agents/skills/sannr-request/SKILL.md", ".agents/skills/sannr-write/SKILL.md", ".agents/skills/sannr-feedback/SKILL.md",
    ]);
    assert.ok(omitted.some(({ surface }) => surface === "AGENTS.md"));
    assert.ok(omitted.some(({ surface }) => surface.includes("SKILL.md")));
    assert.ok(readFileSync(join(dir, ".mcp.json"), "utf8").includes(MCP_SERVER_KEY),
      "the truthful MCP tier was held hostage by a missing portable shim");

    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n",
      "a new CLAUDE.md must import the shared guidance without a duplicate block");
    for (const file of ["AGENTS.md"]) {
      const block = managedBlock(dir, file);
      const verbs = block.split("\n").filter((line) => /is it up \/ health \/ verify/.test(line));
      assert.equal(verbs.length, 1, `expected exactly one verb-owning line in ${file}`);
      assert.match(verbs[0], /api_request.*never raw-curl this repo's own API/i);
      assert.doesNotMatch(block, new RegExp(POINTER_CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(block, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    for (const row of report.skills) {
      const body = readFileSync(join(dir, row.path), "utf8");
      assert.doesNotMatch(body, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.doesNotMatch(body, new RegExp(`(?:^|[\\s\`(])${PRODUCT} (?:note|verdict|feedback)\\b`, "m"));
      assert.doesNotMatch(body, /(?:^|[^A-Za-z0-9_./-])\/(?:Users|home|private|tmp|Volumes|var\/folders)(?:\/|\b)|\bfile:|\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\/m,
        `committed skill contains a machine-local path: ${row.path}`);
    }
    const feedback = readFileSync(join(dir, ".claude", "skills", "sannr-feedback", "SKILL.md"), "utf8");
    assert.doesNotMatch(feedback, /\[portable CLI command omitted\]/,
      "a placeholder plus subcommand still looks like an executable instruction");
    assert.match(feedback, /the one who actually used the tool, so you write the report with the feedback workflow\n\s+after installing the repo-local CLI; fill in the three questions from what you personally\n\s+observed/,
      "fallback rendering left the folded frontmatter sentence dangling");
    assert.ok(feedback.includes("Use the repo-local feedback command once installed.") && feedback.includes(`That writes \`${LAYOUT.feedback}\``),
      "the fallback Steps section no longer identifies what writes the report");
    assert.doesNotMatch(feedback, /`sannr feedback`/, "inline-backtick command survived omission");
    assert.match(feedback, /sannr\.json/, "product file prose was mistaken for a command");
    const writeSkill = readFileSync(join(dir, ".claude", "skills", "sannr-write", "SKILL.md"), "utf8");
    for (const operation of ["POST /orders", "GET /users", "GET /orders"])
      assert.ok(writeSkill.includes("Example for `" + operation + "`"),
        `command omission erased the useful ${operation} example`);
    assert.doesNotMatch(`${feedback}\n${writeSkill}`, /portable-cli-only:/,
      "package-only render markers leaked into an installed skill");

    const human = cli(dir, ["connect", "--alpha"], env);
    assert.equal(human.code, 0, human.out);
    for (const row of omitted) {
      assert.match(human.out, new RegExp(row.surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(human.out, new RegExp(row.reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("an executable repo-local shim enables only the portable committed command tier", () => {
  const { dir, home, env } = scratch({ shim: true });
  try {
    const result = cli(dir, ["connect", "--json"], env);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.omitted, []);
    assert.ok(report.note.includes(`\`${POINTER_CLI_NAME} connect\``),
      "teammate setup must use the verified portable invocation");
    execFileSync("/bin/sh", ["-c", `${POINTER_CLI_NAME} doctor --help >/dev/null`],
      { cwd: dir, env, stdio: "pipe" });
    const block = managedBlock(dir);
    const verbs = block.split("\n").filter((line) => /is it up \/ health \/ verify/.test(line));
    assert.deepEqual(verbs, [
      "is it up / health / verify → `api_request` tool (when registered), with the relevant endpoint and assertions; never raw-curl this repo's own API.",
    ]);
    assert.match(block, new RegExp(`${PRODUCT} map \\.`));
    assert.doesNotMatch(block, /Map the landscape first/);
    assert.match(block, /not prerequisites for an API task/);
    assert.match(block, /Read the relevant saved entries directly/);
    assert.doesNotMatch(block, /api_context/, "a portable CLI shim does not register optional graph tools");
    for (const row of report.skills) {
      const body = readFileSync(join(dir, row.path), "utf8");
      assert.doesNotMatch(body, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      if (/write-context|feedback/.test(row.path))
        assert.match(body, new RegExp(POINTER_CLI_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("init --agents applies the same verified pointer rule and names omissions", () => {
  for (const shim of [false, true]) {
    const { dir, home, env } = scratch({ shim });
    try {
      const result = cli(dir, ["init", "--agents"], env);
      assert.equal(result.code, 0, result.out);
      const report = JSON.parse(result.stdout);
      if (shim) assert.deepEqual(report.omitted, []);
      else assert.ok(commandOmissions(report).every(({ surface }) => POINTER_FILES.includes(surface)));
      const block = managedBlock(dir);
      assert.equal(block.includes(POINTER_CLI_NAME), shim);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }
});

test("an exported function cannot make a missing portable path look resolved", () => {
  const { dir, home, env } = scratch();
  try {
    env[`BASH_FUNC_${PRODUCT}%%`] = "() { :; }";
    const result = cli(dir, ["connect", "--json"], env);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.ok(commandOmissions(report).length);
    assert.ok(report.command_resolution.shadowing.includes("exported-function"));
    assert.equal(managedBlock(dir).includes(POINTER_CLI_NAME), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("portable resolution is metadata-only and fail-closed for nonregular paths", () => {
  const kinds = ["nonexec", "directory", "fifo", "dangling"];
  for (const kind of kinds) {
    const { dir, home } = scratch();
    const path = join(dir, "node_modules", ".bin", PRODUCT);
    mkdirSync(dirname(path), { recursive: true });
    if (kind === "nonexec") writeFileSync(path, "#!/bin/sh\n");
    else if (kind === "directory") mkdirSync(path);
    else if (kind === "fifo") execFileSync("mkfifo", [path]);
    else symlinkSync(join(dir, "missing-target"), path);
    try {
      const plan = advertisementPlan(dir, { PATH: "", [`BASH_FUNC_${PRODUCT}%%`]: "() { :; }" });
      assert.equal(plan.portable.available, false, `${kind} was advertised as executable`);
      assert.ok(plan.portable.reason && plan.portable.remedy);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }

  const { dir, home } = scratch();
  try {
    const target = join(dir, "node_modules", PRODUCT, "bin", "cli");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nexit 0\n");
    chmodSync(target, 0o755);
    const shim = join(dir, "node_modules", ".bin", PRODUCT);
    mkdirSync(dirname(shim), { recursive: true });
    symlinkSync(join("..", PRODUCT, "bin", "cli"), shim);
    assert.equal(advertisementPlan(dir, { PATH: "\u0001hostile" }).portable.available, true,
      "an npm-style executable symlink did not resolve");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("the rename seam shell-quotes spaces and metacharacters as one portable word", () => {
  const renamed = "truth-tool-safe";
  const { dir, home, env } = scratch();
  try {
    const renamedShim = join(dir, "node_modules", ".bin", renamed);
    mkdirSync(dirname(renamedShim), { recursive: true });
    writeFileSync(renamedShim,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(CLI)} "$@"\n`);
    chmodSync(renamedShim, 0o755);
    const renamedEnv = { ...env, API_CONTEXT_PRODUCT_NAME: renamed };
    const result = cli(dir, ["init", "--agents"], renamedEnv);
    assert.equal(result.code, 0, result.out);
    const command = `./node_modules/.bin/${renamed}`;
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(text, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " doctor"));
    execFileSync("/bin/sh", ["-c", `${command} doctor --help >/dev/null`], { cwd: dir, env: renamedEnv });
    assert.equal(existsSync(join(dir, "SHOULD_NOT_EXIST")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("the documented prose rename leaves brand-neutral skill regions renderable", () => {
  const dir = mkdtempSync(join(tmpdir(), "advertisement-renamed-skills-"));
  try {
    const copies = SKILL_SOURCES.slice(1).map((source) => {
      const target = join(dir, source.includes("write-context") ? "write.md" : "feedback.md");
      const renamed = readFileSync(source, "utf8").replaceAll(PRODUCT, "truthmark")
        .replaceAll(PRODUCT[0].toUpperCase() + PRODUCT.slice(1), "Truthmark");
      writeFileSync(target, renamed);
      return target;
    });
    const script = [
      `const { renderSkill } = await import(${JSON.stringify(join(ROOT, "lib", "connect.mjs"))});`,
      `const paths = ${JSON.stringify(copies)};`,
      "console.log(JSON.stringify(paths.map((path) => ({",
      "  fallback: renderSkill(path, null),",
      "  portable: renderSkill(path, './node_modules/.bin/truthmark'),",
      "}))));",
    ].join("\n");
    const rows = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      encoding: "utf8", env: { ...process.env, API_CONTEXT_PRODUCT_NAME: "truthmark" },
    }));
    for (const { fallback, portable } of rows) {
      // The first-party network destination is pinned independently of the
      // product-name test seam; a cosmetic rename cannot redirect a send.
      assert.doesNotMatch(`${fallback}\n${portable}`.replaceAll(FEEDBACK_ORIGIN, '<pinned-feedback-origin>'), /sannr|portable-cli-only:/i);
      if (fallback.includes('feedback.send')) {
        assert.ok(fallback.includes(`${FEEDBACK_ORIGIN}/api/v1/feedback`));
        assert.ok(fallback.includes('TRUTHMARK_FEEDBACK_SEND=never'));
      }
      assert.doesNotMatch(fallback, /(?:^|[\s`(])truthmark (?:note|verdict|feedback)\b/m);
      assert.match(portable, /\.\/node_modules\/\.bin\/truthmark (?:note|verdict|feedback)\b/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dry-run and real connect have byte-identical omission plans and opt-outs add none", () => {
  const { dir, home, env } = scratch();
  try {
    const dry = cli(dir, ["connect", "--dry-run", "--json"], env);
    assert.equal(dry.code, 0, dry.out);
    const dryReport = JSON.parse(dry.stdout);
    assert.equal(existsSync(join(dir, ".mcp.json")), false);
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);
    const real = cli(dir, ["connect", "--json"], env);
    assert.equal(real.code, 0, real.out);
    assert.deepEqual(JSON.parse(real.stdout).omitted, dryReport.omitted);

    const other = scratch();
    try {
      rmSync(join(other.dir, "openapi.yaml"));
      const optOut = cli(other.dir, ["connect", "--no-pointers", "--no-skills", "--json"], other.env);
      assert.equal(optOut.code, 0, optOut.out);
      assert.deepEqual(JSON.parse(optOut.stdout).omitted, []);
    } finally { rmSync(other.dir, { recursive: true, force: true }); rmSync(other.home, { recursive: true, force: true }); }
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("portable dry-run and real plans stay deterministic without machine paths in committed bytes", () => {
  const { dir, home, env } = scratch({ shim: true });
  try {
    const dry = JSON.parse(cli(dir, ["connect", "--dry-run", "--json"], env).stdout);
    assert.deepEqual(dry.omitted, []);
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);
    const first = JSON.parse(cli(dir, ["connect", "--json"], env).stdout);
    const bytes = POINTER_FILES.map((file) => readFileSync(join(dir, file), "utf8"));
    const dryAgain = JSON.parse(cli(dir, ["connect", "--dry-run", "--json"], env).stdout);
    assert.ok(dryAgain.pointers.every(({ action }) => action === "unchanged"),
      "dry-run changed unchanged pointer rows into would-write rows");
    const second = JSON.parse(cli(dir, ["connect", "--json"], env).stdout);
    assert.deepEqual(second.omitted, first.omitted);
    assert.deepEqual(POINTER_FILES.map((file) => readFileSync(join(dir, file), "utf8")), bytes);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("dry and real connect preserve the same named registry writability conflict", () => {
  const { dir, home, env } = scratch();
  const registry = join(home, `.${PRODUCT}`, "registry.json");
  mkdirSync(dirname(registry), { recursive: true });
  writeFileSync(registry, `${JSON.stringify({ v: 1, repos: {}, grants: [] }, null, 2)}\n`);
  chmodSync(registry, 0o400);
  try {
    for (const args of [["connect", "--dry-run", "--json"], ["connect", "--json"]]) {
      const result = cli(dir, args, env);
      assert.equal(result.code, 1, result.out);
      const row = JSON.parse(result.stdout).registry;
      assert.equal(row.action, "conflict");
      assert.match(row.reason, /not writable/i);
    }
    for (const path of [".mcp.json", ".codex", ".claude", ".agents", LAYOUT.context, "AGENTS.md", "CLAUDE.md"])
      assert.equal(existsSync(join(dir, path)), false, `${path} was written around a registry conflict`);
  } finally {
    chmodSync(registry, 0o600);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("hook writability stays the named conflict after whole-plan normalization", () => {
  const { dir, home, env } = scratch();
  const parent = join(dir, ".claude");
  try {
    mkdirSync(parent);
    chmodSync(parent, 0o500);
    const result = cli(dir, ["connect", "--claude-hook", "--no-skills", "--no-pointers", "--json"], env);
    assert.equal(result.code, 1, result.out);
    const row = JSON.parse(result.stdout).hooks.claude_code;
    assert.equal(row.action, "conflict");
    assert.match(row.reason, /not writable/i);
  } finally {
    chmodSync(parent, 0o700);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("a real connect conflict is planned before any unrelated write", () => {
  const foreign = `${JSON.stringify({
    mcpServers: { [MCP_SERVER_KEY]: { command: "python", args: ["team.py"] } },
  }, null, 2)}\n`;
  const { dir, home, env } = scratch({ files: { ".mcp.json": foreign } });
  try {
    const result = cli(dir, ["connect", "--json"], env);
    assert.equal(result.code, 1, result.out);
    assert.equal(readFileSync(join(dir, ".mcp.json"), "utf8"), foreign);
    for (const path of [".codex", ".claude", ".agents", "AGENTS.md", "CLAUDE.md", LAYOUT.context])
      assert.equal(existsSync(join(dir, path)), false, `connect wrote ${path} before its plan was complete`);
    assert.equal(existsSync(join(home, `.${PRODUCT}`)), false, "connect registered before its plan was complete");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("late conflicts leave optional hook and CI plans unwritten with no residue", () => {
  const foreign = `${JSON.stringify({
    mcpServers: { [MCP_SERVER_KEY]: { command: "python", args: ["team.py"] } },
  }, null, 2)}\n`;
  const { dir, home, env } = scratch({ files: { ".mcp.json": foreign } });
  try {
    const result = cli(dir, ["connect", "--claude-hook", "--ci", "--json"], env);
    assert.equal(result.code, 1, result.out);
    for (const path of [
      ".claude/settings.local.json", `.github/workflows/${PRODUCT}.yml`,
      `vendor/${PRODUCT}-ci.tgz`, LAYOUT.context, "AGENTS.md", "CLAUDE.md",
    ]) assert.equal(existsSync(join(dir, path)), false, `${path} was written before late conflict`);
    const residue = execFileSync("find", [dir, "-name", "*.tmp-*", "-o", "-name", "*.tgz"],
      { encoding: "utf8" }).trim();
    assert.equal(residue, "", `planning left temporary/package residue:\n${residue}`);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("init and learn refuse unsafe pointer plans before context/network writes", () => {
  const { dir, home, env } = scratch();
  const outside = join(home, "outside.md");
  writeFileSync(outside, "outside\n");
  symlinkSync(outside, join(dir, "CLAUDE.md"));
  try {
    const init = cli(dir, ["init", "--agents"], env);
    assert.equal(init.code, 1, init.out);
    assert.equal(existsSync(join(dir, LAYOUT.context)), false);
    assert.equal(existsSync(join(dir, "AGENTS.md")), false);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");

    rmSync(join(dir, "CLAUDE.md"));
    assert.equal(cli(dir, ["init"], env).code, 0);
    const before = readFileSync(join(dir, LAYOUT.context));
    symlinkSync(outside, join(dir, "CLAUDE.md"));
    const learn = cli(dir, ["learn", "--agents", "--json"], env);
    assert.equal(learn.code, 1, learn.out);
    assert.deepEqual(readFileSync(join(dir, LAYOUT.context)), before);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("a hardlinked second pointer is a plan conflict before connect writes anything", () => {
  const { dir, home, env } = scratch();
  const outside = join(home, "team-claude.md");
  writeFileSync(outside, "team-owned\n");
  linkSync(outside, join(dir, "CLAUDE.md"));
  try {
    const result = cli(dir, ["connect", "--json"], env);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /single-link regular|POINTER_CONFLICT/i);
    assert.equal(readFileSync(outside, "utf8"), "team-owned\n");
    for (const path of [".mcp.json", ".codex", ".claude", ".agents", LAYOUT.context, "AGENTS.md"])
      assert.equal(existsSync(join(dir, path)), false, `${path} was written before pointer preflight completed`);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("a read-only second pointer is refused before hook, CI, MCP, skills, context, or first pointer writes", () => {
  const { dir, home, env } = scratch({ files: { "CLAUDE.md": "team-owned\n" } });
  chmodSync(join(dir, "CLAUDE.md"), 0o400);
  try {
    const result = cli(dir, ["connect", "--claude-hook", "--ci", "--json"], env);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /not writable|WRITE.*CONFLICT|POINTER_CONFLICT/i);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "team-owned\n");
    for (const path of [
      ".mcp.json", ".codex", ".claude", ".agents", ".github", "vendor",
      LAYOUT.context, "AGENTS.md",
    ]) assert.equal(existsSync(join(dir, path)), false, `${path} was written before writability preflight completed`);
    assert.equal(existsSync(join(home, `.${PRODUCT}`)), false,
      "the registry was written before writability preflight completed");
    const residue = execFileSync("find", [dir, "-name", "*.tmp-*", "-o", "-name", "*.tgz"],
      { encoding: "utf8" }).trim();
    assert.equal(residue, "", `writability planning left residue:\n${residue}`);
  } finally {
    chmodSync(join(dir, "CLAUDE.md"), 0o600);
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("exact generated tiers transition and unwire while neighbouring user bytes stay", () => {
  const { dir, home, env } = scratch();
  try {
    assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
    assert.equal(managedBlock(dir).includes(POINTER_CLI_NAME), false);
    installShim(dir);
    assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
    assert.equal(managedBlock(dir).includes(POINTER_CLI_NAME), true);
    rmSync(join(dir, "node_modules", ".bin", PRODUCT));
    assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
    assert.equal(managedBlock(dir).includes(POINTER_CLI_NAME), false);

    const editedPath = join(dir, "AGENTS.md");
    const edited = `Team preface.\n\n${readFileSync(editedPath, "utf8")}`;
    writeFileSync(editedPath, edited);
    const reconnect = cli(dir, ["connect", "--json"], env);
    assert.equal(reconnect.code, 0, reconnect.out);
    assert.equal(readFileSync(editedPath, "utf8"), edited);
    const unwire = cli(dir, ["unwire", "--json"], env);
    assert.equal(unwire.code, 0, unwire.out);
    assert.match(readFileSync(editedPath, "utf8"), /^Team preface\./);
    assert.doesNotMatch(readFileSync(editedPath, "utf8"), new RegExp(POINTER_BEGIN));
    assert.equal(JSON.parse(unwire.stdout).pointers.find(({ file }) => file === "AGENTS.md").action, "removed");
    assert.equal(existsSync(join(dir, "CLAUDE.md")), true, "edited sibling must not mask exact cleanup assertion");
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n",
      "the generic import bridge must stay because its prior ownership is indistinguishable");
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("unwire recognizes either exact generated tier after the shim state changes", () => {
  for (const initialShim of [false, true]) {
    const { dir, home, env } = scratch({ shim: initialShim });
    try {
      assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
      const shimPath = join(dir, "node_modules", ".bin", PRODUCT);
      if (initialShim) rmSync(shimPath);
      else installShim(dir);
      const result = cli(dir, ["unwire", "--json"], env);
      assert.equal(result.code, 0, result.out);
      const report = JSON.parse(result.stdout);
      assert.ok(report.pointers.every(({ action }) => action === "removed"));
      assert.equal(existsSync(join(dir, ".claude", "skills", "sannr-write", "SKILL.md")), false);
      assert.equal(existsSync(join(dir, ".agents", "skills", "sannr-feedback", "SKILL.md")), false);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }
});

test("doctor advises about an unavailable portable advertisement without failing", () => {
  for (const shim of [false, true]) {
    const { dir, home, env } = scratch({ shim });
    try {
      const result = cli(dir, ["doctor", "--json"], env);
      assert.match(result.stderr, /About to request: HEAD/, "doctor announcement belongs on stderr");
      const report = JSON.parse(result.stdout);
      const row = report.checks.find(({ name }) => name === "advertised-commands");
      assert.ok(row, "doctor omitted the ongoing command-advertisement check");
      assert.equal(row.state, shim ? "PASS" : "WARN");
      assert.equal(report.failed, report.checks.filter(({ state }) => state === "FAIL").length);
      if (!shim) {
        assert.match(row.fix, /node_modules.*\.bin.*connect|install/i);
        const connected = JSON.parse(cli(dir, ["connect", "--json"], env).stdout);
        assert.equal(row.fix, connected.omitted[0].remedy);
        const after = JSON.parse(cli(dir, ["doctor", "--json"], env).stdout);
        assert.equal(after.checks.find(({ name }) => name === "skills").state, "PASS",
          "doctor graded the installed commandless tier against a nonexistent portable tier");
        assert.equal(after.checks.find(({ name }) => name === "advertised-commands").state, "WARN");
      }
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
  }
});

test("global-layout preflight errors advertise the verified local invocation, never a missing bare bin", () => {
  const base = mkdtempSync(join(tmpdir(), "advertisement-global-"));
  const pkg = join(base, "node_modules", PRODUCT);
  const { dir, home, env } = scratch();
  const outside = join(home, "outside-claude");
  try {
    mkdirSync(dirname(pkg), { recursive: true });
    cpSync(ROOT, pkg, { recursive: true, filter(source) {
      const rel = source.slice(ROOT.length).replace(/^\//, "");
      return !/^(?:\.git|node_modules|h2|evidence)(?:\/|$)/.test(rel);
    } });
    mkdirSync(outside);
    symlinkSync(outside, join(dir, ".claude"), "dir");
    const result = cliWith(join(pkg, "bin", "cli.mjs"), dir,
      ["connect", "--claude-hook", "--json"], { ...env, PATH: "/usr/bin:/bin" });
    assert.equal(result.code, 1, result.out);
    assert.doesNotMatch(result.out, /(?:^|[`:\s])sannr connect --claude-hook\b/,
      "the global-layout error advertised a bare bin absent from clean PATH");
    assert.match(result.out, new RegExp(join(pkg, "bin", "cli.mjs")
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("exact pre-AX skill bodies from another checkout migrate or unwind without claiming prose edits", () => {
  const historical = ("node '/" + ("private/tmp" + "/old tool/bin/cli.mjs'"));
  const seedHistorical = (dir) => {
    for (const target of SKILL_TARGETS) for (const source of SKILL_SOURCES) {
      const name = skillName(source);
      const path = join(dir, ...target.dir, name, "SKILL.md");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, historicalSkill(source, historical));
    }
  };

  const first = scratch();
  try {
    seedHistorical(first.dir);
    const result = cli(first.dir, ["connect", "--alpha", "--no-pointers", "--json"], first.env);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    const historicalRows = report.skills.filter(({ path, host }) => host !== "project" && /sannr-(?:write|feedback)/.test(path));
    assert.equal(historicalRows.length, 4);
    assert.ok(historicalRows.every(({ action }) => action === "updated"), result.out);
    assert.deepEqual(report.omitted.map(({ surface }) => surface),
      report.skills.map(({ path }) => path));
    for (const { path } of historicalRows) {
      const body = readFileSync(join(first.dir, path), "utf8");
      assert.doesNotMatch(body, /old tool|\[portable CLI command omitted\]/);
      assert.match(body, /repo-local (?:note|verdict|feedback) command once installed/i);
    }
  } finally { rmSync(first.dir, { recursive: true, force: true }); rmSync(first.home, { recursive: true, force: true }); }

  const second = scratch();
  try {
    seedHistorical(second.dir);
    const result = cli(second.dir, ["unwire", "--json"], second.env);
    assert.equal(result.code, 0, result.out);
    assert.ok(JSON.parse(result.stdout).skills.every(({ action }) => action === "removed"));
  } finally { rmSync(second.dir, { recursive: true, force: true }); rmSync(second.home, { recursive: true, force: true }); }
});
