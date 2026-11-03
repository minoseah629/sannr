// The commands the CLI prints in `next` and `fix:` lines must run in the shell
// of the person reading them. The package is scoped (@<name>/<name>), so an
// npm install puts it one directory deeper than an unscoped one. These tests
// lay the package out the way npm does for a repository-local install and for
// an `npx` run, then read the command a refusal tells the user to run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NPM_PACKAGE, PRODUCT } from "../lib/brand.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

// Copy what the CLI loads (not a symlink: Node resolves symlinked modules to
// their real path, which would put the package back in the source checkout).
function installInto(modules) {
  const pkg = join(modules, ...NPM_PACKAGE.split("/"));
  mkdirSync(pkg, { recursive: true });
  for (const entry of ["bin", "lib", "skill", "stacks", "server.mjs", "package.json"])
    cpSync(join(ROOT, entry), join(pkg, entry), { recursive: true });
  mkdirSync(join(modules, ".bin"), { recursive: true });
  const shim = join(modules, ".bin", PRODUCT);
  symlinkSync(join("..", ...NPM_PACKAGE.split("/"), "bin", "cli.mjs"), shim);
  return shim;
}

function installed(t, layout, files = {}) {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "install-invocation-")));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  spawnSync("git", ["init", "-q"], { cwd: project });
  writeFileSync(join(project, "README.md"), "# demo\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(project, name), text);
  const modules = layout === "local" ? join(project, "node_modules")
    : join(scratch, "home", ".npm", "_npx", "0123456789abcdef", "node_modules");
  const shim = installInto(modules);
  const run = (...args) => spawnSync(process.execPath, [shim, ...args], { cwd: project, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: join(scratch, "home"), PATH: "/usr/bin:/bin" } });
  run.project = project;
  run.lib = join(modules, ...NPM_PACKAGE.split("/"), "lib");
  return run;
}

function refusalNext(t, layout) {
  // No TTY on stdin: the workbench refuses and names the command to run instead.
  const run = installed(t, layout)("workbench");
  assert.equal(run.status, 1, run.stderr);
  const error = JSON.parse(run.stdout || run.stderr).error;
  assert.equal(error.code, "WORKBENCH_TERMINAL_REQUIRED");
  return error.next;
}

test("after a repository-local npm install, printed commands use the project's shim", t => {
  assert.equal(refusalNext(t, "local"), `./node_modules/.bin/${PRODUCT} workbench`);
});

test("after an npx run, printed commands use the exact npx form, not a bare name that is not on PATH", t => {
  assert.equal(refusalNext(t, "npx"), `npx --yes ${NPM_PACKAGE}@${VERSION} workbench`);
});

test("the survey command a reader prints is runnable after an npx run", t => {
  const openapi = JSON.stringify({ openapi: "3.0.0", info: { title: "fixture", version: "1" },
    paths: { "/zen": { get: { responses: { 200: { description: "ok" } } } } } });
  const run = installed(t, "npx", { "openapi.json": openapi })("map", ".", "--no-execute", "--json");
  assert.equal(run.status, 0, run.stderr);
  const { survey } = JSON.parse(run.stdout);
  assert.equal(survey.state, "not-generated");
  assert.equal(survey.command, `npx --yes ${NPM_PACKAGE}@${VERSION} survey generate`);
});

test("the .sannr/README.md that connect writes after an npx run names commands a teammate can run", t => {
  const run = installed(t, "npx");
  const connected = run("connect");
  assert.equal(connected.status, 0, connected.stdout + connected.stderr);
  const guide = readFileSync(join(run.project, ".sannr", "README.md"), "utf8");
  assert.ok(guide.includes(`\`npx --yes ${NPM_PACKAGE}@${VERSION} doctor\``), guide);
  assert.ok(!guide.includes(`./node_modules/.bin/${PRODUCT}`), guide);
});

// Every other refusal or hint that names a command to run. Each is read from
// the installed copy, so the module resolves its invocation from the npm layout.
function installedHints(t, layout) {
  const run = installed(t, layout);
  // A single-store layout is what the migration refusal guards.
  mkdirSync(join(run.project, ".sannr", "config"), { recursive: true });
  writeFileSync(join(run.project, ".sannr", "config", "api-environments.json"),
    JSON.stringify({ v: 1, default: "local", environments: { local: { baseUrl: "https://api.example.test" } } }));
  const lib = file => JSON.stringify(pathToFileURL(join(run.lib, file)).href);
  const source = `
    import { contextCommandError } from ${lib("context-errors.mjs")};
    import { stacksMigrationRequired } from ${lib("stack-migration-state.mjs")};
    import { graphRecordFailure } from ${lib("graph-record.mjs")};
    import { stackFactsProjection } from ${lib("stack-facts.mjs")};
    import { importKong } from ${lib("import.mjs")};
    import { renderMapReceipt } from ${lib("map-terminal.mjs")};
    import { terminalTheme } from ${lib("terminal.mjs")};
    let kong;
    try { importKong({ openapi: "3.0.0" }); } catch (error) { kong = error.message; }
    const map = renderMapReceipt({ summary: {}, services: [], edges: [], external: [], platform: [],
      graph: { repositories: [], edges: [], unresolved: [] } },
      { out: "map.html", theme: terminalTheme({ stream: { isTTY: false, columns: 100 }, env: {} }) });
    console.log(JSON.stringify({
      context: contextCommandError({ code: "STACKS_MIGRATION_REQUIRED" }).next,
      migration: stacksMigrationRequired(process.cwd())?.command,
      record: graphRecordFailure({ code: "STACKS_MIGRATION_REQUIRED" }).error.remediation,
      stackFacts: stackFactsProjection({}, { stack: "billing" }).receipt.show_command,
      kong,
      map: map.split("\\n").find(line => line.includes("Agent entry point")).trim(),
    }));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: run.project,
    encoding: "utf8", env: { ...process.env, HOME: join(run.project, "..", "home") } });
  assert.equal(result.status, 0, result.stderr);
  return { run, hints: JSON.parse(result.stdout) };
}

for (const [layout, cli] of [["local", `./node_modules/.bin/${PRODUCT}`], ["npx", `npx --yes ${NPM_PACKAGE}@${VERSION}`]]) {
  test(`after ${layout === "local" ? "a repository-local npm install" : "an npx run"}, refusal and hint commands use the scoped form`, t => {
    const { hints } = installedHints(t, layout);
    assert.deepEqual(hints, {
      context: `${cli} migrate --dry-run`,
      migration: `${cli} migrate --dry-run`,
      record: `${cli} migrate --dry-run`,
      stackFacts: `${cli} show --stack billing`,
      kong: `Kong importer received an OpenAPI document; use \`${cli} init\` or \`${cli} learn\``,
      map: `Agent entry point: ${cli} graph context --json`,
    });
  });
}

test("after a repository-local npm install, a single-store note refusal names the scoped migrate command", t => {
  const { run } = installedHints(t, "local");
  const refused = run("note", "GET /health", "Responds with ok.");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stdout + refused.stderr, /STACKS_MIGRATION_REQUIRED/);
  assert.ok((refused.stdout + refused.stderr).includes(`./node_modules/.bin/${PRODUCT} migrate --dry-run`), refused.stdout + refused.stderr);
  assert.doesNotMatch(refused.stdout + refused.stderr, new RegExp(`(^|[\\s"'\`])${PRODUCT} migrate`));
});
