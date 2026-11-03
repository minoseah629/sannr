// AX-C — own the verbs agents guess, without hiding heuristic uncertainty.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync,
  symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { HOME_ENV_NAME, LEGACY_BIN_NAMES, PRODUCT } from "../lib/brand.mjs";
import { inspectDoctorEnvironment } from "../lib/doctor-path.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const SOURCE_CLI = `node ${CLI}`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "doctor-alias-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"),
    "openapi: 3.0.0\ninfo: { title: fixture, version: '1' }\npaths: {}\n");
  const home = mkdtempSync(join(tmpdir(), "doctor-alias-home-"));
  return { dir, env: { ...process.env, HOME: home, [HOME_ENV_NAME]: join(home, "state") } };
}

function run(cwd, command, args = [], env = {}) {
  // These cases compare local setup diagnostics byte-for-byte, not live probes.
  if (["doctor", "status", "check", "health", "ping"].includes(command)) args = [...args, "--offline"];
  const result = spawnSync(process.execPath, [CLI, command, ...args], {
    cwd, env, encoding: "utf8",
  });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test("status, check, health, and ping are exact doctor aliases with one stderr redirect", () => {
  const { dir, env } = sandbox();
  // Aliases share one dispatcher. Exercise every alias and every argument mode
  // without repeating the same four-by-four subprocess matrix.
  for (const [alias, args] of [["status", []], ["check", ["--json"]],
    ["health", ["--help"]], ["ping", ["--why"]]]) {
    const doctor = run(dir, "doctor", args, env);
    const actual = run(dir, alias, args, env);
    assert.equal(actual.code, doctor.code, `${alias} changed doctor's exit code`);
    assert.equal(actual.stdout, doctor.stdout, `${alias} changed doctor's stdout`);
    assert.equal(actual.stderr,
      `${SOURCE_CLI} ${alias} redirects to ${SOURCE_CLI} doctor\n`,
      `${alias} did not emit exactly one one-line redirect note`);
    if (args.includes("--json")) JSON.parse(actual.stdout);
  }

  const help = run(dir, "--help", [], env).stdout;
  for (const alias of ["status", "check", "health", "ping"])
    assert.match(help, new RegExp(`\\b${alias}\\b`), `${alias} is not discoverable in help`);
  const unknown = run(dir, "uptime", [], env);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr, "", "an unknown command emitted an alias redirect");
});

test("doctor warns about the declared historical binary without executing it", () => {
  assert.deepEqual(LEGACY_BIN_NAMES, ["api-context", "api-request"],
    "the historical package/bin identity belongs in the brand seam");
  const { dir, env } = sandbox();
  const bin = mkdtempSync(join(tmpdir(), "doctor-old-bin-"));
  const tripped = join(dir, "old-binary-executed");
  const legacy = join(bin, LEGACY_BIN_NAMES[0]);
  writeFileSync(legacy, `#!/bin/sh\ntouch ${JSON.stringify(tripped)}\n`);
  execFileSync("chmod", ["755", legacy]);

  const actual = run(dir, "doctor", ["--json"], {
    ...env, PATH: `${bin}${delimiter}/usr/bin${delimiter}/bin`,
  });
  const report = JSON.parse(actual.stdout);
  const warning = report.checks.find((row) => row.name === "path-binaries");
  assert.equal(warning?.state, "WARN");
  assert.match(warning.detail, new RegExp(LEGACY_BIN_NAMES[0]));
  assert.equal(existsSync(tripped), false, "doctor executed an unknown PATH binary");
  assert.equal(report.failed, report.checks.filter((row) => row.state === "FAIL").length,
    "heuristic warning changed the hard-failure count");

  const clean = run(dir, "doctor", ["--json"], {
    ...env, PATH: `/usr/bin${delimiter}/bin`,
  });
  const cleanReport = JSON.parse(clean.stdout);
  assert.equal(clean.code, actual.code, "a stale-binary heuristic changed doctor's exit code");
  assert.equal(cleanReport.failed, report.failed);
  assert.equal(cleanReport.checks.find((row) => row.name === "path-binaries")?.state, "PASS");
});

test("PATH inspection handles filesystem edge cases without candidate text or execution", () => {
  const { dir } = sandbox();
  const name = LEGACY_BIN_NAMES[0];
  const quiet = mkdtempSync(join(tmpdir(), "doctor-path-quiet-"));
  const nonexec = join(quiet, "nonexec"), directory = join(quiet, "directory");
  const fifo = join(quiet, "fifo"), dangling = join(quiet, "dangling");
  const unreadable = join(quiet, "unreadable");
  for (const slot of [nonexec, directory, fifo, dangling, unreadable]) mkdirSync(slot);
  writeFileSync(join(nonexec, name), "not executable\n");
  mkdirSync(join(directory, name));
  execFileSync("mkfifo", [join(fifo, name)]);
  symlinkSync(join(quiet, "missing-target"), join(dangling, name));
  chmodSync(unreadable, 0o000);
  const hostile = `bad\nsegment;$()\u001b[31m`;
  try {
    const result = inspectDoctorEnvironment({ cwd: dir,
      pathValue: [nonexec, directory, fifo, dangling, unreadable, hostile].join(delimiter),
      env: {}, legacyNames: [name] });
    assert.deepEqual(result.legacy, []);
    assert.doesNotMatch(JSON.stringify(result), /bad|segment|31m/,
      "candidate-controlled PATH text escaped the detector");
  } finally { chmodSync(unreadable, 0o700); }

  const targetDir = mkdtempSync(join(tmpdir(), "doctor-path-target-"));
  const target = join(targetDir, "real-command");
  writeFileSync(target, "#!/bin/sh\nexit 99\n"); chmodSync(target, 0o755);
  const slotA = mkdtempSync(join(tmpdir(), "doctor-path-a-"));
  const slotB = mkdtempSync(join(tmpdir(), "doctor-path-b-"));
  symlinkSync(target, join(slotA, name));
  linkSync(target, join(slotB, name));
  const warned = inspectDoctorEnvironment({ cwd: dir,
    pathValue: `${slotA}${delimiter}${slotB}${delimiter}${slotA}`,
    env: {}, legacyNames: [name] });
  assert.deepEqual(warned.legacy, [{ name, count: 1 }],
    "symlink/repeat/hardlink aliases of one executable were counted more than once");

  const relative = join(dir, "relative-bin"); mkdirSync(relative);
  symlinkSync(target, join(relative, name));
  symlinkSync(target, join(dir, name));
  assert.deepEqual(inspectDoctorEnvironment({ cwd: dir, env: {}, legacyNames: [name] }).legacy,
    [], "an absent PATH was misread as an explicit cwd slot");
  assert.deepEqual(inspectDoctorEnvironment({ cwd: dir,
    pathValue: `${delimiter}relative-bin`, env: {}, legacyNames: [name] }).legacy,
  [{ name, count: 1 }], "empty and relative PATH entries did not use shell PATH semantics");
});

test("doctor warns on an environment-visible function shadow without echoing its body", () => {
  const { dir, env } = sandbox();
  const secret = "ghp_AXC_SHADOW_BODY_MUST_NOT_PRINT_1234567890";
  const actual = run(dir, "doctor", ["--json"], {
    ...env,
    [`BASH_FUNC_${PRODUCT}%%`]: `() { printf '%s' '${secret}'; }`,
  });
  const report = JSON.parse(actual.stdout);
  const warning = report.checks.find((row) => row.name === "shell-shadow");
  assert.equal(warning?.state, "WARN");
  assert.match(warning.detail, /function.*shadow|shadow.*function/i);
  assert.doesNotMatch(`${actual.stdout}${actual.stderr}`, new RegExp(secret));
  assert.equal(report.failed, report.checks.filter((row) => row.state === "FAIL").length);
  const clean = run(dir, "doctor", ["--json"], env);
  const cleanShadow = JSON.parse(clean.stdout).checks.find((row) => row.name === "shell-shadow");
  assert.equal(cleanShadow?.state, "PASS");
  assert.match(cleanShadow.detail, /aliases.*non-exported.*not inspected|not inspected.*aliases/i,
    "doctor hides the limit of environment-only shadow detection");
});

test("alias routing and shadow diagnostics follow the product rename seam", () => {
  const { dir, env } = sandbox();
  const renamed = "zzrenamed";
  const actual = run(dir, "status", ["--json"], {
    ...env, API_CONTEXT_PRODUCT_NAME: renamed,
    [`BASH_FUNC_${renamed}%%`]: "() { return 0; }",
  });
  const report = JSON.parse(actual.stdout);
  assert.match(report.checks.find((row) => row.name === "shell-shadow")?.detail ?? "",
    new RegExp(renamed));
  const visible = `${actual.stdout}${actual.stderr}`.replaceAll(SOURCE_CLI, renamed);
  assert.match(visible, new RegExp(`${renamed} status redirects to ${renamed} doctor`));
  assert.doesNotMatch(visible, /sannr/i, "renamed alias/doctor output retained the current brand");
});
