// M1-B — explicit connect materializes a review-only CI door from a vendored,
// self-packed engine. No test here executes an API request.
//
//   node --test test/connect-ci.test.mjs

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { PRODUCT, NPM_PACKAGE } from "../lib/brand.mjs";
import { LAYOUT } from "../lib/layout.mjs";
import * as ciWorkflow from "../lib/ci-workflow.mjs";

const packFixture = realpathSync(mkdtempSync(join(tmpdir(), "shared-ci-pack-")));
const preload = new URL('./helpers/shared-ci-pack.mjs', import.meta.url).href;
const priorOptions = process.env.NODE_OPTIONS;
process.env.NODE_OPTIONS = `${priorOptions ?? ''} --import=${preload}`.trim();
process.env.CI_PACK_FIXTURE = packFixture;
after(() => {
  if (priorOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = priorOptions;
  delete process.env.CI_PACK_FIXTURE;
  rmSync(packFixture, { recursive: true, force: true });
});

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const WORKFLOW_REL = join(".github", "workflows", `${PRODUCT}.yml`);
const TARBALL_REL = LAYOUT.ciTarball;
const VENDOR_REL = dirname(TARBALL_REL);
const POISON = "ghp_M1BTargetOnlyCredential123456789";
const ENGINE_VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const digestBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function git(root, args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args],
    { cwd: root, encoding: "utf8" });
}

function scratch({ poison = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "connect-ci-")));
  const home = realpathSync(mkdtempSync(join(tmpdir(), "connect-ci-home-")));
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "openapi.json"), JSON.stringify({
    openapi: "3.0.0", info: { title: "fixture" }, paths: {
      "/things": { get: { responses: { 200: { description: "ok" } } } },
    },
  }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "app.mjs"), 'app.get("/things", handler);\n');
  if (poison) {
    mkdirSync(join(dir, "evidence"));
    writeFileSync(join(dir, "evidence", "response.json"), POISON);
    writeFileSync(join(dir, ".env"), `TOKEN=${POISON}\n`);
    writeFileSync(join(dir, `token=${POISON}.txt`), POISON);
  }
  return { dir, home, env: { HOME: home } };
}

function cli(cwd, args, env = {}, executable = CLI) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [executable, ...args], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    }) };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    out.push(path);
    if (entry.isDirectory()) walk(path, out);
  }
  return out;
}

function extract(tarball) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "connect-ci-unpack-")));
  execFileSync("tar", ["xzf", tarball, "-C", root]);
  return { root, packageRoot: join(root, "package") };
}

test("plain connect stays CI-side-effect free while explicit dry-run names both artifacts", () => {
  const { dir, home, env } = scratch();
  try {
    for (const args of [["connect", "--json"], ["connect", "--dry-run", "--json"],
      ["connect", "--json"]]) {
      const result = cli(dir, args, env);
      assert.equal(result.code, 0, result.out);
      assert.ok(!existsSync(join(dir, ".github")), "plain connect created .github");
      assert.ok(!existsSync(join(dir, VENDOR_REL)), "plain connect created vendor");
    }

    const dry = cli(dir, ["connect", "--ci", "--install", "vendored", "--dry-run", "--json"], env);
    assert.equal(dry.code, 0, dry.out);
    const report = JSON.parse(dry.out);
    assert.equal(report.ci.workflow.path, WORKFLOW_REL);
    assert.equal(report.ci.tarball.path, TARBALL_REL);
    assert.match(report.ci.workflow.action, /would write/);
    assert.match(report.ci.tarball.action, /would write/);
    assert.ok(!existsSync(join(dir, ".github")), "CI dry-run wrote .github");
    assert.ok(!existsSync(join(dir, VENDOR_REL)), "CI dry-run wrote vendor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("connect --ci writes one branded, review-only weekly workflow and a stable self-pack", () => {
  const { dir, home, env } = scratch();
  try {
    const first = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
    assert.equal(first.code, 0, first.out);
    const parsed = JSON.parse(first.out);
    assert.deepEqual([parsed.ci.workflow.path, parsed.ci.tarball.path],
      [WORKFLOW_REL, TARBALL_REL]);
    const workflowPath = join(dir, WORKFLOW_REL);
    const tarballPath = join(dir, TARBALL_REL);
    assert.ok(existsSync(workflowPath) && existsSync(tarballPath), first.out);
    const before = [digest(workflowPath), digest(tarballPath)];

    const plain = cli(dir, ["connect", "--json"], env);
    assert.equal(plain.code, 0, plain.out);
    assert.equal(JSON.parse(plain.out).ci, undefined);
    assert.deepEqual([digest(workflowPath), digest(tarballPath)], before,
      "a later plain connect changed explicitly installed CI artifacts");

    const workflow = readFileSync(workflowPath, "utf8");
    assert.match(workflow, new RegExp(`^name: ${PRODUCT} `, "m"));
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    for (const trigger of ["push", "pull_request", "schedule"])
      assert.match(workflow, new RegExp(`^  ${trigger}:`, "m"));
    const cron = /cron:\s*["']([^"']+)["']/.exec(workflow)?.[1];
    assert.match(cron ?? "", /^\d+ \d+ \* \* [0-6]$/,
      "the default schedule must run exactly once on one weekday each week");
    assert.doesNotMatch(workflow, /pull_request_target/);

    const active = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    const activeAudits = active.split("\n").filter((line) => line.includes(" audit . "));
    assert.ok(activeAudits.length >= 2, `push and scheduled audit steps are missing:\n${workflow}`);
    for (const line of activeAudits) {
      for (const flag of ["--ci", "--report-only", "--summary", '"$GITHUB_STEP_SUMMARY"',
        "--no-execute"])
        assert.ok(line.includes(flag), `active audit omits ${flag}: ${line}`);
      assert.doesNotMatch(line, /--baseline|\blearn\b|\binit\b/);
    }
    const activeInstalls = active.split("\n").filter((line) => /^\s*run: .*\binstall\b/.test(line));
    assert.deepEqual(activeInstalls.length, 1, `vendored tgz must be the sole install:\n${workflow}`);
    assert.ok(activeInstalls[0].includes(`./${TARBALL_REL.replaceAll("\\", "/")}`));
    assert.doesNotMatch(active, /github:|\bnpx\b|\btoken\b|contents:\s*write|\bregistry\b/i);
    assert.match(workflow, /#.*github:[^\n]+#<sha>/i,
      "org-internal GitHub install is not present as a comment-only alternative");
    assert.match(workflow, /Enforcing mode is off by default/);
    const enforcing = workflow.split("\n").find((line) => /^\s*#.*\brun: .*\baudit\b/.test(line));
    assert.ok(enforcing && !enforcing.includes("--report-only") && enforcing.includes("--no-execute"),
      `commented enforcement command must omit only report-only:\n${workflow}`);

    const second = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
    assert.equal(second.code, 0, second.out);
    assert.deepEqual([digest(workflowPath), digest(tarballPath)], before,
      "repeat connect --ci changed workflow or self-pack bytes");
    const text = cli(dir, ["connect", "--ci", "--install", "vendored"], env);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, new RegExp(WORKFLOW_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text.out, new RegExp(TARBALL_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }

  const noNpm = scratch();
  try {
    const failedPack = cli(noNpm.dir, ["connect", "--ci", "--install", "vendored", "--json"],
      { ...noNpm.env, PATH: "/path-with-no-tools" });
    assert.equal(failedPack.code, 1, failedPack.out);
    assert.match(failedPack.out, /CI_PACK_FAILED/);
    assert.ok(!existsSync(join(noNpm.dir, WORKFLOW_REL))
      && !existsSync(join(noNpm.dir, TARBALL_REL)),
    "self-pack failure left half of the CI pair");
  } finally {
    rmSync(noNpm.dir, { recursive: true, force: true });
    rmSync(noNpm.home, { recursive: true, force: true });
  }
});

test("the CI artifact pair refuses foreign bytes, symlink traversal, and half-installs", () => {
  const seed = scratch();
  let expectedWorkflow, expectedTarball;
  try {
    const seeded = cli(seed.dir, ["connect", "--ci", "--install", "vendored", "--json"], seed.env);
    assert.equal(seeded.code, 0, seeded.out);
    expectedWorkflow = readFileSync(join(seed.dir, WORKFLOW_REL));
    expectedTarball = readFileSync(join(seed.dir, TARBALL_REL));
  } finally {
    rmSync(seed.dir, { recursive: true, force: true });
    rmSync(seed.home, { recursive: true, force: true });
  }
  const foreignCases = [
    { rel: WORKFLOW_REL, bytes: Buffer.from("name: team-owned\n"),
      other: TARBALL_REL, otherBytes: expectedTarball },
    { rel: TARBALL_REL, bytes: Buffer.from("team-owned archive\n"),
      other: WORKFLOW_REL, otherBytes: expectedWorkflow },
  ];
  for (const scenario of foreignCases) {
    const { dir, home, env } = scratch();
    try {
      const path = join(dir, scenario.rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, scenario.bytes);
      const otherPath = join(dir, scenario.other);
      mkdirSync(dirname(otherPath), { recursive: true });
      writeFileSync(otherPath, scenario.otherBytes);
      const before = [digest(path), digest(otherPath)];
      const dry = cli(dir, ["connect", "--ci", "--install", "vendored", "--dry-run", "--json"], env);
      assert.equal(dry.code, 1, dry.out);
      assert.match(dry.out, /CI_ARTIFACT_CONFLICT/);
      assert.deepEqual([digest(path), digest(otherPath)], before,
        "dry-run conflict changed the foreign member or its exact counterpart");
      const result = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /CI_ARTIFACT_CONFLICT/);
      assert.deepEqual([digest(path), digest(otherPath)], before,
        "conflict changed the foreign member or its exact counterpart");
      assert.ok(!walk(dir).some((p) => /\.tmp-/.test(p)), "conflict left a temp artifact");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  for (const kind of ["workflow-dir", "vendor-dir", "workflow-file", "tarball-file"]) {
    const { dir, home, env } = scratch();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "connect-ci-outside-")));
    try {
      if (kind === "workflow-dir") {
        mkdirSync(join(dir, ".github"));
        symlinkSync(outside, join(dir, ".github", "workflows"));
      } else if (kind === "vendor-dir") { mkdirSync(dirname(join(dir, VENDOR_REL)), { recursive: true }); symlinkSync(outside, join(dir, VENDOR_REL)); }
      else {
        const rel = kind === "workflow-file" ? WORKFLOW_REL : TARBALL_REL;
        mkdirSync(dirname(join(dir, rel)), { recursive: true });
        const held = join(outside, "held");
        writeFileSync(held, "outside bytes\n");
        symlinkSync(held, join(dir, rel));
      }
      const dry = cli(dir, ["connect", "--ci", "--install", "vendored", "--dry-run", "--json"], env);
      assert.equal(dry.code, 1, dry.out);
      assert.match(dry.out, /CI_ARTIFACT_CONFLICT/);
      const result = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /CI_ARTIFACT_CONFLICT/);
      assert.deepEqual(readdirSync(outside).sort(), kind.endsWith("file") ? ["held"] : [],
        "connect followed a project artifact symlink");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }

  const { dir, home, env } = scratch();
  try {
    mkdirSync(join(dir, VENDOR_REL), { recursive: true });
    chmodSync(join(dir, VENDOR_REL), 0o500);
    const result = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
    chmodSync(join(dir, VENDOR_REL), 0o700);
    assert.equal(result.code, 1, result.out);
    assert.match(result.out, /CI_ARTIFACT_WRITE_FAILED/);
    assert.ok(!existsSync(join(dir, WORKFLOW_REL)), "second-artifact failure left a workflow");
    assert.ok(!existsSync(join(dir, TARBALL_REL)), "second-artifact failure left a tarball");
    assert.ok(!walk(dir).some((p) => /\.tmp-/.test(p)), "write failure left a temp artifact");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unwire removes an exact generated CI pair without rebuilding it and is idempotent", () => {
  const { dir, home, env } = scratch();
  try {
    const connected = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
    assert.equal(connected.code, 0, connected.out);
    const unwired = cli(dir, ["unwire", "--json"],
      { ...env, PATH: "/path-with-no-package-manager" });
    assert.equal(unwired.code, 0, unwired.out);
    const report = JSON.parse(unwired.out);
    assert.deepEqual([report.ci.workflow.action, report.ci.tarball.action],
      ["removed", "removed"]);
    assert.deepEqual([report.ci.workflow.path, report.ci.tarball.path],
      [WORKFLOW_REL, TARBALL_REL]);
    assert.ok(!("absolute" in report.ci.workflow) && !("absolute" in report.ci.tarball),
      "unwire JSON leaked machine-local artifact paths");
    assert.ok(!existsSync(join(dir, WORKFLOW_REL)) && !existsSync(join(dir, TARBALL_REL)));
    assert.ok(!existsSync(join(dir, ".github")) && !existsSync(join(dir, VENDOR_REL)),
      "exact CI cleanup left connect-created empty scaffolding");

    const again = cli(dir, ["unwire", "--json"], env);
    assert.equal(again.code, 0, again.out);
    const second = JSON.parse(again.out);
    assert.deepEqual([second.ci.workflow.action, second.ci.tarball.action],
      ["absent", "absent"]);

    assert.equal(cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env).code, 0);
    const text = cli(dir, ["unwire"], env);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, new RegExp(WORKFLOW_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text.out, new RegExp(TARBALL_REL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text.out, /workflow\s+removed/);
    assert.match(text.out, /vendored engine removed/);
    const help = cli(dir, ["unwire", "--help"], env);
    assert.equal(help.code, 0, help.out);
    assert.match(help.out, /exact generated workflow.*digest-bound tarball/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("unwire preserves the entire CI pair when either generated member was edited", () => {
  for (const edited of ["workflow", "tarball", "both"]) {
    const { dir, home, env } = scratch();
    try {
      const connected = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
      assert.equal(connected.code, 0, connected.out);
      const workflow = join(dir, WORKFLOW_REL), tarball = join(dir, TARBALL_REL);
      if (edited === "workflow" || edited === "both")
        writeFileSync(workflow, Buffer.concat([readFileSync(workflow), Buffer.from("# team edit\n")]));
      if (edited === "tarball" || edited === "both")
        writeFileSync(tarball, Buffer.concat([readFileSync(tarball), Buffer.from("team edit") ]));
      const before = [digest(workflow), digest(tarball)];
      const unwired = cli(dir, ["unwire", "--json"], env);
      assert.equal(unwired.code, 0, unwired.out);
      const report = JSON.parse(unwired.out);
      assert.deepEqual([report.ci.workflow.action, report.ci.tarball.action], ["left", "left"]);
      assert.ok(report.ci.workflow.reason && report.ci.tarball.reason);
      assert.deepEqual([digest(workflow), digest(tarball)], before,
        `${edited} edit was partially deleted or changed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }

  for (const locked of ["workflow-parent", "tarball-parent"]) {
    const { dir, home, env } = scratch();
    const parent = join(dir, locked === "workflow-parent"
      ? join(".github", "workflows") : VENDOR_REL);
    try {
      assert.equal(cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env).code, 0);
      const workflow = join(dir, WORKFLOW_REL), tarball = join(dir, TARBALL_REL);
      const before = [digest(workflow), digest(tarball)];
      chmodSync(parent, 0o500);
      const unwired = cli(dir, ["unwire", "--json"], env);
      chmodSync(parent, 0o700);
      assert.equal(unwired.code, 0, unwired.out);
      assert.doesNotMatch(unwired.out, /\n\s+at\s|Error:/, "unwire leaked a raw stack");
      const ci = JSON.parse(unwired.out).ci;
      assert.deepEqual([ci.workflow.action, ci.tarball.action], ["left", "left"]);
      assert.ok(ci.workflow.reason && ci.tarball.reason);
      assert.deepEqual([digest(workflow), digest(tarball)], before,
        `${locked} produced a half-removal`);
      assert.ok(!walk(dir).some((path) => /\.unwire-/.test(path)),
        `${locked} left a removal staging file`);
    } finally {
      try { chmodSync(parent, 0o700); } catch { /* absent */ }
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("unwire preserves foreign/linked/tar-only CI artifacts and removes an exact workflow-only survivor", () => {
  const foreign = scratch();
  try {
    mkdirSync(dirname(join(foreign.dir, WORKFLOW_REL)), { recursive: true });
    mkdirSync(dirname(join(foreign.dir, TARBALL_REL)), { recursive: true });
    writeFileSync(join(foreign.dir, WORKFLOW_REL), "name: team workflow\n");
    writeFileSync(join(foreign.dir, TARBALL_REL), "team tarball\n");
    const before = [digest(join(foreign.dir, WORKFLOW_REL)), digest(join(foreign.dir, TARBALL_REL))];
    const result = cli(foreign.dir, ["unwire", "--json"], foreign.env);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.out);
    assert.deepEqual([report.ci.workflow.action, report.ci.tarball.action], ["left", "left"]);
    assert.deepEqual([digest(join(foreign.dir, WORKFLOW_REL)), digest(join(foreign.dir, TARBALL_REL))], before);
  } finally {
    rmSync(foreign.dir, { recursive: true, force: true });
    rmSync(foreign.home, { recursive: true, force: true });
  }

  const forged = scratch();
  try {
    const body = "name: team-owned\n";
    const archive = Buffer.from("team-owned opaque binary\n");
    const claimed = `# generated-workflow: ci-artifact-pair-v1\n` +
      `# generated-product: ${JSON.stringify(PRODUCT)}\n` +
      `# generated-body-sha256: ${digestBytes(Buffer.from(body))}\n` +
      `# generated-tarball-sha256: ${digestBytes(archive)}\n${body}`;
    mkdirSync(dirname(join(forged.dir, WORKFLOW_REL)), { recursive: true });
    mkdirSync(dirname(join(forged.dir, TARBALL_REL)), { recursive: true });
    writeFileSync(join(forged.dir, WORKFLOW_REL), claimed);
    writeFileSync(join(forged.dir, TARBALL_REL), archive);
    const before = [digest(join(forged.dir, WORKFLOW_REL)), digest(join(forged.dir, TARBALL_REL))];
    const result = cli(forged.dir, ["unwire", "--json"], forged.env);
    assert.equal(result.code, 0, result.out);
    const ci = JSON.parse(result.out).ci;
    assert.deepEqual([ci.workflow.action, ci.tarball.action], ["left", "left"]);
    assert.deepEqual([digest(join(forged.dir, WORKFLOW_REL)),
      digest(join(forged.dir, TARBALL_REL))], before,
    "self-asserted ownership markers caused foreign bytes to be deleted");
  } finally {
    rmSync(forged.dir, { recursive: true, force: true });
    rmSync(forged.home, { recursive: true, force: true });
  }

  for (const missing of ["workflow", "tarball"]) {
    const fixture = scratch();
    try {
      assert.equal(cli(fixture.dir, ["connect", "--ci", "--install", "vendored", "--json"], fixture.env).code, 0);
      rmSync(join(fixture.dir, missing === "workflow" ? WORKFLOW_REL : TARBALL_REL));
      const result = cli(fixture.dir, ["unwire", "--json"], fixture.env);
      assert.equal(result.code, 0, result.out);
      const ci = JSON.parse(result.out).ci;
      if (missing === "workflow") {
        assert.deepEqual([ci.workflow.action, ci.tarball.action], ["absent", "left"]);
        assert.ok(existsSync(join(fixture.dir, TARBALL_REL)),
          "tarball filename alone was treated as ownership");
      } else {
        assert.deepEqual([ci.workflow.action, ci.tarball.action], ["removed", "absent"]);
        assert.ok(!existsSync(join(fixture.dir, WORKFLOW_REL)));
      }
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }

  const linked = scratch();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "unwire-ci-outside-")));
  try {
    mkdirSync(dirname(join(linked.dir, WORKFLOW_REL)), { recursive: true });
    mkdirSync(dirname(join(linked.dir, TARBALL_REL)), { recursive: true });
    const held = join(outside, "held.yml");
    writeFileSync(held, "name: outside\n");
    symlinkSync(held, join(linked.dir, WORKFLOW_REL));
    writeFileSync(join(linked.dir, TARBALL_REL), "ambiguous tar\n");
    const result = cli(linked.dir, ["unwire", "--json"], linked.env);
    assert.equal(result.code, 0, result.out);
    const ci = JSON.parse(result.out).ci;
    assert.deepEqual([ci.workflow.action, ci.tarball.action], ["left", "left"]);
    assert.equal(readFileSync(held, "utf8"), "name: outside\n");
  } finally {
    rmSync(linked.dir, { recursive: true, force: true });
    rmSync(linked.home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }

  for (const danglingKind of ["workflow", "tarball"]) {
    const fixture = scratch();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "unwire-ci-dangling-")));
    try {
      assert.equal(cli(fixture.dir, ["connect", "--ci", "--install", "vendored", "--json"], fixture.env).code, 0);
      const dangling = join(fixture.dir,
        danglingKind === "workflow" ? WORKFLOW_REL : TARBALL_REL);
      const counterpart = join(fixture.dir,
        danglingKind === "workflow" ? TARBALL_REL : WORKFLOW_REL);
      const counterpartBefore = digest(counterpart);
      rmSync(dangling);
      symlinkSync(join(outside, "missing"), dangling);
      const result = cli(fixture.dir, ["unwire", "--json"], fixture.env);
      assert.equal(result.code, 0, result.out);
      const ci = JSON.parse(result.out).ci;
      assert.deepEqual([ci.workflow.action, ci.tarball.action], ["left", "left"]);
      assert.ok(lstatSync(dangling).isSymbolicLink(), `${danglingKind} dangling link was deleted`);
      assert.equal(digest(counterpart), counterpartBefore,
        `${danglingKind} dangling link caused its exact counterpart to be deleted`);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  }

  const neighbours = scratch();
  try {
    assert.equal(cli(neighbours.dir, ["connect", "--ci", "--install", "vendored", "--json"], neighbours.env).code, 0);
    writeFileSync(join(neighbours.dir, ".github", "workflows", "team.yml"), "name: team\n");
    writeFileSync(join(neighbours.dir, VENDOR_REL, "team.tgz"), "team archive\n");
    const result = cli(neighbours.dir, ["unwire", "--json"], neighbours.env);
    assert.equal(result.code, 0, result.out);
    assert.deepEqual([JSON.parse(result.out).ci.workflow.action,
      JSON.parse(result.out).ci.tarball.action], ["removed", "removed"]);
    assert.equal(readFileSync(join(neighbours.dir, ".github", "workflows", "team.yml"), "utf8"),
      "name: team\n");
    assert.equal(readFileSync(join(neighbours.dir, VENDOR_REL, "team.tgz"), "utf8"),
      "team archive\n");
    assert.ok(existsSync(join(neighbours.dir, ".github", "workflows"))
      && existsSync(join(neighbours.dir, VENDOR_REL)),
    "CI cleanup pruned scaffolding that still holds neighboring project files");
  } finally {
    rmSync(neighbours.dir, { recursive: true, force: true });
    rmSync(neighbours.home, { recursive: true, force: true });
  }
});

test("the actual self-pack is isolated, hygienic, self-contained, and works from an extracted package", async () => {
  const { isRuntimeDependencyPath, verifyRuntimeDependency } = await import('../lib/runtime-dependencies.mjs');
  const { dir, home, env } = scratch({ poison: true });
  let unpacked;
  try {
    const result = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
    assert.equal(result.code, 0, result.out);
    assert.doesNotMatch(result.out, /npm notice|connect-ci-pack-|M1BTargetOnlyCredential/);
    const tarball = join(dir, TARBALL_REL);
    const listed = execFileSync("tar", ["tzf", tarball], { encoding: "utf8" })
      .split("\n").filter(Boolean);
    assert.ok(listed.includes("package/package.json"));
    for (const entry of listed) {
      assert.ok(!isAbsolute(entry) && !entry.split("/").includes(".."), `unsafe tar entry: ${entry}`);
      const parts = entry.split("/").filter(Boolean);
      const dependency = isRuntimeDependencyPath(entry.replace(/^package\//, ''));
      assert.ok(dependency || !parts.some((part) => part.startsWith(".")), `dotfile in self-pack: ${entry}`);
      // Exact runtime source exception; evidence siblings/directories remain forbidden.
      const evidenceModule = entry === 'package/lib/evidence-confidence.mjs';
      assert.ok(!parts.some((part) => (!evidenceModule && /^(?:evidence(?:-|$)|results$)/.test(part)) || (!dependency && part === 'node_modules')),
        `runtime/working-tree artifact in self-pack: ${entry}`);
      assert.doesNotMatch(entry, /\.env$|\.tgz$/);
      assert.ok(!entry.includes(POISON), `secret-shaped filename entered self-pack: ${entry}`);
    }
    unpacked = extract(tarball);
    for (const entry of listed.filter(entry => entry.includes('/node_modules/'))) {
      const path = entry.replace(/^package\//, '');
      assert.ok(verifyRuntimeDependency(path, readFileSync(join(unpacked.packageRoot, path))), `Unpinned dependency bytes: ${path}`);
    }
    // Do not run secretIn over engine JS: the guard implementation and normal
    // identifiers (`const secret = secretIn`, `{ token: cached }`) self-match.
    // Alpha hygiene is proven with a unique real credential canary planted in
    // target cwd/evidence/dotfile/filename/content, then an actual unpack walk.
    for (const path of walk(unpacked.packageRoot)) {
      assert.ok(!lstatSync(path).isSymbolicLink(), `self-pack contains a symlink: ${path}`);
      if (lstatSync(path).isFile())
        assert.ok(!readFileSync(path).includes(POISON), `target secret entered ${path}`);
    }
    const help = cli(dir, ["--help"], {}, join(unpacked.packageRoot, "bin", "cli.mjs"));
    assert.equal(help.code, 0, help.out);

    const nested = scratch();
    try {
      // This separate integration must really invoke npm from the extracted
      // install; transaction fixtures elsewhere share the source archive.
      const installedPackFixture = join(packFixture, "installed");
      mkdirSync(installedPackFixture);
      const fromPacked = cli(nested.dir, ["connect", "--ci", "--install", "vendored", "--json"],
        { ...nested.env, CI_PACK_FIXTURE: installedPackFixture },
        join(unpacked.packageRoot, "bin", "cli.mjs"));
      assert.equal(fromPacked.code, 0, fromPacked.out);
      assert.equal(readFileSync(join(installedPackFixture, "executions"), "utf8"), "pack\n",
        "the installed-package integration must execute a real npm pack exactly once");
      assert.ok(existsSync(join(nested.dir, TARBALL_REL)),
        "an extracted install could not self-pack its own engine root");
    } finally {
      rmSync(nested.dir, { recursive: true, force: true });
      rmSync(nested.home, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    if (unpacked) rmSync(unpacked.root, { recursive: true, force: true });
  }
});

test("the exact clean-runner install and active audit commands execute with zero requests", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const { dir, home, env } = scratch();
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    mkdirSync(join(dir, LAYOUT.config), { recursive: true });
    writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
      v: 1, default: "local", environments: { local: { baseUrl: origin } },
    }));
    mkdirSync(join(dir, LAYOUT.collection), { recursive: true });
    writeFileSync(join(dir, LAYOUT.baseline), JSON.stringify({
      version: 1, generated_at: "2026-08-29", findings: [],
    }));
    const connected = cli(dir, ["connect", "--ci", "--install", "vendored", "--json"], env);
    assert.equal(connected.code, 0, connected.out);
    const before = [digest(join(dir, "openapi.json")), digest(join(dir, "src", "app.mjs")),
      digest(join(dir, LAYOUT.context))];
    const workflow = readFileSync(join(dir, WORKFLOW_REL), "utf8");
    const commands = workflow.split("\n")
      .filter((line) => /^\s*run: /.test(line) && !/^\s*#/.test(line))
      .map((line) => line.replace(/^\s*run:\s*/, ""));
    const install = commands.find((line) => /\bnpm install\b/.test(line));
    const audits = commands.filter((line) => /\baudit\b/.test(line));
    assert.ok(install && audits.length >= 2, `workflow commands are incomplete:\n${workflow}`);
    const shellEnv = { ...process.env, ...env,
      PATH: `${join(dir, "node_modules", ".bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      GITHUB_STEP_SUMMARY: join(dir, "step-summary.md"),
      npm_config_registry: `${origin}/`, npm_config_audit: "false", npm_config_fund: "false" };
    execFileSync("/bin/sh", ["-c", install], { cwd: dir, env: shellEnv, stdio: "pipe" });
    for (const command of audits)
      execFileSync("/bin/sh", ["-c", command], { cwd: dir, env: shellEnv, stdio: "pipe" });
    assert.equal(requests, 0, "a generated active CI command made an API request");
    assert.ok(existsSync(shellEnv.GITHUB_STEP_SUMMARY));
    assert.deepEqual([digest(join(dir, "openapi.json")), digest(join(dir, "src", "app.mjs")),
      digest(join(dir, LAYOUT.context))], before,
    "report-only workflow rewrote a contract, source, or committed knowledge file");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("renamed CI artifacts install and unwire using their declared paths", () => {
  const { dir, home, env } = scratch();
  try {
    const renamedProduct = "zz-renamed";
    const renamed = { ...env, API_CONTEXT_PRODUCT_NAME: renamedProduct };
    const result = cli(dir, ["connect", "--ci", "--install", "vendored", "--json", "--no-skills", "--no-pointers"], renamed);
    assert.equal(result.code, 0, result.out);
    assert.ok(existsSync(join(dir, ".github", "workflows", `${renamedProduct}.yml`)));
    assert.ok(existsSync(join(dir, `.${renamedProduct}`, "vendor", `${renamedProduct}-ci.tgz`)));
    const workflow = readFileSync(join(dir, ".github", "workflows", `${renamedProduct}.yml`), "utf8");
    assert.ok(workflow.includes(renamedProduct));
    const names = workflow.split("\n").map((line) =>
      /^\s*(?:#\s*)?(?:-\s*)?name:\s*(.+)$/.exec(line)?.[1]).filter(Boolean);
    assert.ok(names.length >= 6, `workflow/step names were not found:\n${workflow}`);
    assert.ok(names.every((name) => name.includes(renamedProduct)),
      `a workflow or step name missed the brand seam: ${names.join(" | ")}`);
    const active = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
    assert.doesNotMatch(active, new RegExp(PRODUCT), "active workflow retained the old product name");
    assert.doesNotMatch(result.out, new RegExp(`${PRODUCT}(?:\.yml|-ci\.tgz)`));
    const install = active.split("\n").find((line) => /^\s*run: npm install/.test(line))
      ?.replace(/^\s*run:\s*/, "");
    assert.ok(install, `renamed workflow has no active vendored install:\n${workflow}`);
    execFileSync("/bin/sh", ["-c", install], {
      cwd: dir, stdio: "pipe", env: { ...process.env, ...env,
        PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, npm_config_audit: "false",
        npm_config_fund: "false" },
    });
    const help = cli(dir, ["connect", "--help"], renamed);
    assert.equal(help.code, 0, help.out);
    assert.match(help.out, /--ci/);
    assert.ok(help.out.includes(renamedProduct));

    const capabilities = cli(dir, ["capabilities", "--json"], renamed);
    assert.equal(capabilities.code, 0, capabilities.out);
    const writes = JSON.parse(capabilities.out).writes;
    const workflowWrite = writes.find((row) =>
      row.path === `.github/workflows/${renamedProduct}.yml`);
    const tarballWrite = writes.find((row) =>
      row.path === `.${renamedProduct}/vendor/${renamedProduct}-ci.tgz`);
    assert.ok(workflowWrite && tarballWrite,
      `capabilities hides renamed CI writes: ${capabilities.out}`);
    assert.match(workflowWrite.guard, /connect --ci|explicit/i);
    assert.match(workflowWrite.guard, /contents.*read|report-only|no-execute/i);
    assert.match(tarballWrite.guard, /self-pack|allowlist|evidence|dotfile/i);

    const unwired = cli(dir, ["unwire", "--json"], renamed);
    assert.equal(unwired.code, 0, unwired.out);
    assert.deepEqual([JSON.parse(unwired.out).ci.workflow.path,
      JSON.parse(unwired.out).ci.tarball.path],
    [join(".github", "workflows", `${renamedProduct}.yml`),
      join(`.${renamedProduct}`, "vendor", `${renamedProduct}-ci.tgz`)]);
    assert.deepEqual([JSON.parse(unwired.out).ci.workflow.action,
      JSON.parse(unwired.out).ci.tarball.action], ["removed", "removed"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }

});

// CI-2: the launch default is deliberately a single, pinned owner decision
// (registry since the first public release; vendored stays an explicit choice).
function workflowTemplateDigest(workflow) {
  const slots = new Map(Object.entries(LAYOUT).map(([key, path]) => [path, `<layout:${key}>`]));
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp([...slots.keys()].sort((a,b) => b.length-a.length).map(escape).join("|"), "g");
  const stable = workflow.replace(/^# generated-body-sha256: [a-f0-9]{64}$/m, "# generated-body-sha256: <body digest>")
    .replace(pattern, path => slots.get(path));
  return digestBytes(Buffer.from(stable));
}

test("CI-2 pins both versioned workflow templates with seam-derived path slots", () => {
  const expected = {
    vendored: "b6a4e52ed5f6cda121e6ca9d0f145aeab1eb37df960ff4c6c1103a97d208ddfe",
    // Layout migration is version 3: the trail and vendored archive path move.
    // Exact version 2 ownership remains independently pinned below.
    registry: "460f4c022a941ee168808b86622b00b0da6855c405f3bf4fe677ee9e90f09177",
  };
  for (const install of ["vendored", "registry"]) {
    const workflow = ciWorkflow.renderCiWorkflow({ install, version: "7.8.9-ci.2",
      tarballDigest: "a".repeat(64) });
    assert.equal(workflowTemplateDigest(workflow), expected[install],
      `${install} ownership template bytes changed; use a new ownership version`);
  }
});

test("CI-2 the registry install line carries the scoped npm package name from the seam, and nothing else reaches npm", () => {
  // The bare product name is not the package (npm refused it); the seam derives
  // `@name/name`, and the rendered line must be exactly that plus the pinned version.
  const workflow = ciWorkflow.renderCiWorkflow({ install: "registry", version: "1.2.3" });
  const line = workflow.split("\n").find((l) => l.includes("npm install") && l.includes("--no-save"));
  assert.equal(line.trim(), `run: npm install --ignore-scripts --no-audit --no-fund --no-save @${PRODUCT}/${PRODUCT}@1.2.3`);
  assert.equal(NPM_PACKAGE, `@${PRODUCT}/${PRODUCT}`);
  for (const packageName of ["@/x", "@scope/", "a b", "@Scope/name!", "../evil", "@s/n@1.0.0", ""]) {
    assert.throws(() => ciWorkflow.renderCiWorkflow({ install: "registry", version: "1.2.3", packageName }),
      { code: "CI_INSTALL_INVALID" }, `packageName ${JSON.stringify(packageName)} must be refused`);
  }
  // An unscoped name stays valid so a rename through the seam keeps rendering.
  assert.ok(ciWorkflow.renderCiWorkflow({ install: "registry", version: "1.2.3", packageName: "plain-name" }).includes("--no-save plain-name@1.2.3"));
});

test("CI-2 registry rendering rejects tags, ranges, malformed versions, and shell syntax offline", () => {
  for (const version of ["latest", "^1.2.3", "~1.2.3", "1", "1.2", "01.2.3", "1.2.3-01",
    "https://example.invalid/package.tgz", "1.2.3; echo unexpected", "1.2.3\n", 123]) {
    assert.throws(() => ciWorkflow.renderCiWorkflow({ install: "registry", version,
      tarballDigest: "a".repeat(64) }), { code: "CI_PACKAGE_VERSION_INVALID" }, String(version));
  }
  for (const version of ["0.0.0", "7.8.9-ci.2", "1.2.3-rc.4+build.5"]) {
    const workflow = ciWorkflow.renderCiWorkflow({ install: "registry", version });
    assert.ok(workflow.includes(`--no-save ${NPM_PACKAGE}@${version}`), `install line names the scoped package: ${workflow.split("\n").find((l) => l.includes("--no-save"))}`);
    assert.equal(ciWorkflow.inspectCiWorkflowOwnership(workflow).owned, true);
  }
});

test("CI-2 both workflow modes retain ownership/body binding and harden runner bounds", () => {
  for (const install of ["vendored", "registry"]) {
    const workflow = ciWorkflow.renderCiWorkflow({ install, version: ENGINE_VERSION,
      tarballDigest: "a".repeat(64) });
    assert.match(workflow,
      /uses: actions\/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4\.4\.0$/m);
    assert.match(workflow,
      /uses: actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4\.4\.0$/m);
    assert.match(workflow, /^permissions:\n  contents: read$/m);
    assert.match(workflow, /^    timeout-minutes: [1-9]\d*$/m);
    assert.match(workflow, /^concurrency:\n  group: .*\$\{\{ github\.ref \}\}.*\n  cancel-in-progress: true$/m);
    assert.doesNotMatch(workflow, /MAR-\d+|linear\.app/);
    assert.match(workflow, /^# generated-workflow: \S+$/m);
    const body = workflow.slice(workflow.indexOf("name: "));
    assert.match(workflow,
      new RegExp(`^# generated-body-sha256: ${digestBytes(Buffer.from(body))}$`, "m"));
    const ownership = ciWorkflow.inspectCiWorkflowOwnership(workflow);
    assert.equal(ownership.owned, true, JSON.stringify(ownership));
    assert.equal(ownership.install, install);
    if (install === "vendored") assert.equal(ownership.tarballDigest, "a".repeat(64));
    else assert.equal(ownership.version, ENGINE_VERSION);
    assert.equal(ciWorkflow.inspectCiWorkflowOwnership(`${workflow}# local edit\n`).owned, false);
    const foreignBody = "name: team-owned\n";
    const forged = workflow.slice(0, workflow.indexOf("name: "))
      .replace(/# generated-body-sha256: [a-f0-9]{64}/,
        `# generated-body-sha256: ${digestBytes(Buffer.from(foreignBody))}`) + foreignBody;
    assert.equal(ciWorkflow.inspectCiWorkflowOwnership(forged).owned, false,
      `${install} self-asserted headers must not confer ownership`);
  }
});

test("CI-2 the implicit default is registry, and explicit registry preserves its workflow bytes", () => {
  const fixture = scratch();
  try {
    const first = cli(fixture.dir, ["connect", "--ci", "--json"], fixture.env);
    assert.equal(first.code, 0, first.out);
    assert.equal(JSON.parse(first.out).ci.install, "registry");
    assert.ok(!existsSync(join(fixture.dir, TARBALL_REL)), "the default commits no engine archive");
    const before = digest(join(fixture.dir, WORKFLOW_REL));
    const explicit = cli(fixture.dir, ["connect", "--ci", "--install", "registry", "--json"], fixture.env);
    assert.equal(explicit.code, 0, explicit.out);
    const ci = JSON.parse(explicit.out).ci;
    assert.equal(ci.install, "registry");
    assert.equal(ci.workflow.action, "unchanged");
    assert.equal(digest(join(fixture.dir, WORKFLOW_REL)), before);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("CI-2 registry mode writes no archive and pins the generating CLI version without packing", () => {
  const fixture = scratch();
  try {
    writeFileSync(join(fixture.dir, "package.json"), JSON.stringify({ name: "consumer", version: "98.76.54" }));
    const args = ["connect", "--ci", "--install", "registry", "--json"];
    const env = { ...fixture.env, PATH: "/path-with-no-package-manager" };
    const dry = cli(fixture.dir, [...args, "--dry-run"], env);
    assert.equal(dry.code, 0, dry.out);
    assert.equal(JSON.parse(dry.out).ci.install, "registry");
    assert.equal(JSON.parse(dry.out).ci.tarball.action, "absent");
    assert.ok(!existsSync(join(fixture.dir, ".github")) && !existsSync(join(fixture.dir, VENDOR_REL)));
    const first = cli(fixture.dir, args, env);
    assert.equal(first.code, 0, first.out);
    const ci = JSON.parse(first.out).ci;
    assert.equal(ci.install, "registry");
    assert.equal(ci.tarball.action, "absent");
    assert.ok(!existsSync(join(fixture.dir, VENDOR_REL)));
    const workflow = readFileSync(join(fixture.dir, WORKFLOW_REL), "utf8");
    const active = workflow.split("\n").filter((line) => !/^\s*#/.test(line));
    const installs = active.filter((line) => /^\s*run: npm install\b/.test(line));
    assert.deepEqual(installs.map((line) => line.trim()),
      [`run: npm install --ignore-scripts --no-audit --no-fund --no-save ${NPM_PACKAGE}@${ENGINE_VERSION}`]);
    assert.doesNotMatch(active.join("\n"), /--offline|vendor\/|98\.76\.54|@latest|@[~^]/);
    const before = digest(join(fixture.dir, WORKFLOW_REL));
    const second = cli(fixture.dir, args, env);
    assert.equal(second.code, 0, second.out);
    assert.equal(JSON.parse(second.out).ci.workflow.action, "unchanged");
    assert.equal(digest(join(fixture.dir, WORKFLOW_REL)), before);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("CI-2 registry version comes from an extracted generating package, never the consumer", () => {
  const fixture = scratch();
  let unpacked;
  try {
    const packed = cli(fixture.dir, ["connect", "--ci", "--install", "vendored", "--json"], fixture.env);
    assert.equal(packed.code, 0, packed.out);
    unpacked = extract(join(fixture.dir, TARBALL_REL));
    const manifestPath = join(unpacked.packageRoot, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "7.8.9-ci.2";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const consumer = scratch();
    try {
      writeFileSync(join(consumer.dir, "package.json"), JSON.stringify({ version: "98.76.54" }));
      const result = cli(consumer.dir, ["connect", "--ci", "--install", "registry", "--json"],
        { ...consumer.env, PATH: "/path-with-no-package-manager" }, join(unpacked.packageRoot, "bin", "cli.mjs"));
      assert.equal(result.code, 0, result.out);
      assert.ok(readFileSync(join(consumer.dir, WORKFLOW_REL), "utf8")
        .includes(`--no-save ${NPM_PACKAGE}@7.8.9-ci.2`));
      assert.ok(!existsSync(join(consumer.dir, TARBALL_REL)));
    } finally {
      rmSync(consumer.dir, { recursive: true, force: true });
      rmSync(consumer.home, { recursive: true, force: true });
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
    if (unpacked) rmSync(unpacked.root, { recursive: true, force: true });
  }
});

test("CI-2 mode changes require an explicit transition and report digest-verified archive removal", () => {
  const fixture = scratch();
  try {
    const installed = cli(fixture.dir, ["connect", "--ci", "--install", "vendored", "--json"], fixture.env);
    assert.equal(installed.code, 0, installed.out);
    const workflow = join(fixture.dir, WORKFLOW_REL), tarball = join(fixture.dir, TARBALL_REL);
    const original = [digest(workflow), digest(tarball)];
    const registryArgs = ["connect", "--ci", "--install", "registry", "--json"];
    const denied = cli(fixture.dir, registryArgs, fixture.env);
    assert.equal(denied.code, 1, denied.out);
    assert.match(denied.out, /CI_INSTALL_SWITCH_REQUIRED/);
    assert.deepEqual([digest(workflow), digest(tarball)], original);
    const dry = cli(fixture.dir, [...registryArgs, "--switch-install", "--dry-run"], fixture.env);
    assert.equal(dry.code, 0, dry.out);
    const dryCi = JSON.parse(dry.out).ci;
    assert.equal(dryCi.transition, "vendored-to-registry");
    assert.equal(dryCi.tarball.action, "would remove");
    assert.deepEqual([digest(workflow), digest(tarball)], original);
    const switched = cli(fixture.dir, [...registryArgs, "--switch-install"], fixture.env);
    assert.equal(switched.code, 0, switched.out);
    const ci = JSON.parse(switched.out).ci;
    assert.equal(ci.transition, "vendored-to-registry");
    assert.equal(ci.install, "registry");
    assert.equal(ci.tarball.action, "removed");
    assert.equal(ci.tarball.sha256, original[1]);
    assert.match(ci.tarball.reason, /matches.*SHA-256 digest/);
    assert.ok(!existsSync(tarball));
    const registryDigest = digest(workflow);
    const backArgs = ["connect", "--ci", "--install", "vendored", "--json"];
    const backDenied = cli(fixture.dir, backArgs, fixture.env);
    assert.equal(backDenied.code, 1, backDenied.out);
    assert.match(backDenied.out, /CI_INSTALL_SWITCH_REQUIRED/);
    assert.equal(digest(workflow), registryDigest);
    assert.ok(!existsSync(tarball));
    const back = cli(fixture.dir, [...backArgs, "--switch-install"], fixture.env);
    assert.equal(back.code, 0, back.out);
    const backCi = JSON.parse(back.out).ci;
    assert.equal(backCi.transition, "registry-to-vendored");
    assert.equal(backCi.install, "vendored");
    assert.equal(backCi.tarball.action, "wrote");
    assert.deepEqual([digest(workflow), digest(tarball)], original);
    const repeated = cli(fixture.dir, [...backArgs, "--switch-install"], fixture.env);
    assert.equal(repeated.code, 0, repeated.out);
    assert.equal(JSON.parse(repeated.out).ci.transition, undefined);
    assert.deepEqual([digest(workflow), digest(tarball)], original);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("CI-2 switching never removes or changes edited ownership evidence", () => {
  for (const edited of ["workflow", "tarball"]) {
    const fixture = scratch();
    try {
      assert.equal(cli(fixture.dir, ["connect", "--ci", "--install", "vendored", "--json"], fixture.env).code, 0);
      const workflow = join(fixture.dir, WORKFLOW_REL), tarball = join(fixture.dir, TARBALL_REL);
      const target = edited === "workflow" ? workflow : tarball;
      writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("team edit\n")]));
      const before = [digest(workflow), digest(tarball)];
      for (const dry of [true, false]) {
        const args = ["connect", "--ci", "--install", "registry", "--switch-install", "--json"];
        if (dry) args.push("--dry-run");
        const result = cli(fixture.dir, args, fixture.env);
        assert.equal(result.code, 1, result.out);
        assert.match(result.out, /CI_ARTIFACT_CONFLICT/);
        assert.deepEqual([digest(workflow), digest(tarball)], before, `${edited} edit caused a partial transition`);
      }
      assert.ok(!walk(fixture.dir).some((path) => /\.tmp-|\.ci-switch-/.test(path)));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

test("CI-2 failed transitions preserve the complete prior installation", () => {
  for (const install of ["vendored", "registry"]) {
    for (const parent of [join(".github", "workflows"), VENDOR_REL]) {
      const fixture = scratch();
      const locked = join(fixture.dir, parent);
      try {
        const first = cli(fixture.dir, ["connect", "--ci", "--install", install, "--json"], fixture.env);
        assert.equal(first.code, 0, first.out);
        const workflow = join(fixture.dir, WORKFLOW_REL), tarball = join(fixture.dir, TARBALL_REL);
        const before = [digest(workflow), existsSync(tarball) ? digest(tarball) : null];
        mkdirSync(locked, { recursive: true });
        chmodSync(locked, 0o500);
        const other = install === "vendored" ? "registry" : "vendored";
        const result = cli(fixture.dir,
          ["connect", "--ci", "--install", other, "--switch-install", "--json"], fixture.env);
        chmodSync(locked, 0o700);
        assert.equal(result.code, 1, result.out);
        assert.match(result.out, /CI_ARTIFACT_WRITE_FAILED/);
        assert.deepEqual([digest(workflow), existsSync(tarball) ? digest(tarball) : null], before);
        assert.ok(!walk(fixture.dir).some((path) => /\.tmp-|\.ci-switch-/.test(path)));
      } finally {
        try { chmodSync(locked, 0o700); } catch { /* absent */ }
        rmSync(fixture.dir, { recursive: true, force: true });
        rmSync(fixture.home, { recursive: true, force: true });
      }
    }
  }
});

test("CI-2 registry workflow ownership controls idempotent removal and preserves foreign bytes", () => {
  for (const edited of [false, true]) {
    const fixture = scratch();
    try {
      const installed = cli(fixture.dir, ["connect", "--ci", "--install", "registry", "--json"], fixture.env);
      assert.equal(installed.code, 0, installed.out);
      const workflow = join(fixture.dir, WORKFLOW_REL);
      if (edited) writeFileSync(workflow, `${readFileSync(workflow, "utf8")}# team edit\n`);
      const before = digest(workflow);
      if (edited) {
        const result = cli(fixture.dir, ["connect", "--ci", "--install", "registry", "--json"], fixture.env);
        assert.equal(result.code, 1, result.out);
        assert.match(result.out, /CI_ARTIFACT_CONFLICT/);
        assert.equal(digest(workflow), before);
      }
      const removed = cli(fixture.dir, ["unwire", "--json"], fixture.env);
      assert.equal(removed.code, 0, removed.out);
      const ci = JSON.parse(removed.out).ci;
      assert.deepEqual([ci.workflow.action, ci.tarball.action], [edited ? "left" : "removed", "absent"]);
      if (edited) assert.equal(digest(workflow), before);
      else assert.ok(!existsSync(workflow));
      assert.ok(!existsSync(join(fixture.dir, TARBALL_REL)));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

test("CI-2 invalid install switches fail without creating CI artifacts", () => {
  for (const args of [
    ["connect", "--ci", "--install", "latest", "--json"],
    ["connect", "--ci", "--install", "--json"],
    ["connect", "--install", "registry", "--json"],
    ["connect", "--switch-install", "--json"],
    ["connect", "--ci", "--switch-install", "--json"],
  ]) {
    const fixture = scratch();
    try {
      const result = cli(fixture.dir, args, fixture.env);
      assert.equal(result.code, 1, result.out);
      assert.match(result.out, /--install|--switch-install|CI_INSTALL/);
      assert.ok(!existsSync(join(fixture.dir, ".github")) && !existsSync(join(fixture.dir, VENDOR_REL)));
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

test("CI-2 recognises the byte-pinned legacy ownership format and refuses edits", () => {
  const legacy = readFileSync(join(ROOT, "test", "fixtures", "ci-workflow-v1.txt"), "utf8");
  assert.equal(digestBytes(Buffer.from(legacy)), "a0324c5ecd5369a62c8beaa5f8a65de6ce238bdfd8223edf15b5f338e38a49cc");
  const ownership = ciWorkflow.inspectCiWorkflowOwnership(legacy);
  assert.equal(ownership.owned, true, JSON.stringify(ownership));
  assert.equal(ownership.install, "vendored");
  assert.equal(ownership.tarballDigest, "a".repeat(64));
  assert.equal(ciWorkflow.inspectCiWorkflowOwnership(legacy.replace("17 9", "18 9")).owned, false);
  assert.equal(ciWorkflow.inspectCiWorkflowOwnership(legacy.replace("# generated-workflow: ", "")).owned, false,
    "legacy ownership requires the complete marker, not its bare format value");
  for (const [from, to] of [
    [`"./vendor/${PRODUCT}-ci.tgz"`, '"./CI_TARBALL"'],
    [`./node_modules/.bin/${PRODUCT}`, "CI_CLI"],
    [`name: ${PRODUCT} API audit`, "name: CI_PRODUCT API audit"],
  ]) {
    const body = legacy.split("\n").slice(4).join("\n").replace(from, to);
    const forged = legacy.split("\n").slice(0, 4).join("\n")
      .replace(/^# generated-body-sha256: [a-f0-9]{64}$/m,
        `# generated-body-sha256: ${digestBytes(Buffer.from(body))}`) + `\n${body}`;
    assert.equal(ciWorkflow.inspectCiWorkflowOwnership(forged).owned, false,
      `a literal normalization sentinel must not confer legacy ownership: ${to}`);
  }
});

test("CI-2 registry leaves a foreign archive alone and refuses to claim it during a switch", () => {
  const fixture = scratch();
  try {
    const tarball = join(fixture.dir, TARBALL_REL);
    mkdirSync(dirname(tarball), { recursive: true });
    writeFileSync(tarball, "team-owned archive\n");
    const original = digest(tarball);
    const args = ["connect", "--ci", "--install", "registry", "--json"];
    const installed = cli(fixture.dir, args, fixture.env);
    assert.equal(installed.code, 0, installed.out);
    assert.equal(JSON.parse(installed.out).ci.tarball.action, "left");
    assert.equal(digest(tarball), original);
    const workflow = join(fixture.dir, WORKFLOW_REL), before = digest(workflow);
    const repeated = cli(fixture.dir, args, fixture.env);
    assert.equal(repeated.code, 0, repeated.out);
    assert.equal(digest(workflow), before);
    const refused = cli(fixture.dir,
      ["connect", "--ci", "--install", "vendored", "--switch-install", "--json"], fixture.env);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /CI_ARTIFACT_CONFLICT/);
    assert.deepEqual([digest(workflow), digest(tarball)], [before, original]);
    const removed = cli(fixture.dir, ["unwire", "--json"], fixture.env);
    assert.equal(removed.code, 0, removed.out);
    const ci = JSON.parse(removed.out).ci;
    assert.deepEqual([ci.workflow.action, ci.tarball.action], ["removed", "left"]);
    assert.equal(digest(tarball), original);
    assert.ok(!existsSync(workflow));
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("CI-2 explicitly switches a legacy owned pair using its recorded archive digest without repacking", () => {
  const fixture = scratch();
  try {
    const archive = Buffer.from("legacy engine bytes from an older generating package\n");
    const legacy = readFileSync(join(ROOT, "test", "fixtures", "ci-workflow-v1.txt"), "utf8")
      .replace(/^# generated-tarball-sha256: [a-f0-9]{64}$/m,
        `# generated-tarball-sha256: ${digestBytes(archive)}`);
    const workflow = join(fixture.dir, WORKFLOW_REL), tarball = join(fixture.dir, TARBALL_REL);
    mkdirSync(dirname(workflow), { recursive: true });
    mkdirSync(dirname(tarball), { recursive: true });
    writeFileSync(workflow, legacy);
    writeFileSync(tarball, archive);
    const result = cli(fixture.dir,
      ["connect", "--ci", "--install", "registry", "--switch-install", "--json"],
      { ...fixture.env, PATH: "/path-with-no-package-manager" });
    assert.equal(result.code, 0, result.out);
    const ci = JSON.parse(result.out).ci;
    assert.equal(ci.transition, "vendored-to-registry");
    assert.equal(ci.tarball.action, "removed");
    assert.ok(!existsSync(tarball));
    assert.ok(readFileSync(workflow, "utf8").includes(`--no-save ${NPM_PACKAGE}@${ENGINE_VERSION}`));
    assert.equal(ciWorkflow.inspectCiWorkflowOwnership(readFileSync(workflow, "utf8")).owned, true);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
    rmSync(fixture.home, { recursive: true, force: true });
  }
});

test("CI-2 a partial staging write preserves prior artifacts and removes its temporary file", () => {
  for (const [install, failAt] of [["vendored", 1], ["registry", 1], ["registry", 2]]) {
    const fixture = scratch();
    try {
      const installed = cli(fixture.dir, ["connect", "--ci", "--install", install, "--json"], fixture.env);
      assert.equal(installed.code, 0, installed.out);
      const workflow = join(fixture.dir, WORKFLOW_REL), tarball = join(fixture.dir, TARBALL_REL);
      const before = [digest(workflow), existsSync(tarball) ? digest(tarball) : null];
      const targetInstall = install === "vendored" ? "registry" : "vendored";
      const script = `
        import fs from "node:fs";
        import { syncBuiltinESMExports } from "node:module";
        import { materializeCiArtifacts } from ${JSON.stringify(new URL("../lib/ci-workflow.mjs", import.meta.url).href)};
        const write = fs.writeFileSync;
        const open = fs.openSync;
        const stagingFds = new Set();
        let writes = 0;
        fs.openSync = function(path, ...args) {
          const fd = open.call(this, path, ...args);
          if (typeof path === "string" && path.includes(".tmp-")) stagingFds.add(fd);
          return fd;
        };
        fs.writeFileSync = function(target, bytes, options) {
          const staged = typeof target === "number" ? stagingFds.has(target)
            : typeof target === "string" && target.includes(".tmp-");
          if (staged && ++writes === ${failAt}) {
            write.call(this, target, Buffer.from("partial staging write"), options);
            throw Object.assign(new Error("injected partial disk-full write"), { code: "ENOSPC" });
          }
          return write.call(this, target, bytes, options);
        };
        syncBuiltinESMExports();
        let code = null;
        try { materializeCiArtifacts(process.cwd(), { install: ${JSON.stringify(targetInstall)}, switchInstall: true }); }
        catch (error) { code = error.code; }
        process.stdout.write(JSON.stringify({ code, writes }));
      `;
      const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: fixture.dir, encoding: "utf8", env: { ...process.env, ...fixture.env },
      });
      const result = JSON.parse(out);
      assert.equal(result.writes, failAt, out);
      assert.equal(result.code, "CI_ARTIFACT_WRITE_FAILED", out);
      assert.deepEqual([digest(workflow), existsSync(tarball) ? digest(tarball) : null], before);
      assert.deepEqual(walk(fixture.dir).filter((path) => /\.tmp-|\.ci-switch-/.test(path)), [],
        `${install} transition left a partially written staging artifact`);
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      rmSync(fixture.home, { recursive: true, force: true });
    }
  }
});

// Counts real successful npm executions; missing-PATH refusal remains a real attempt.
test("DOTSANNR CI retains exact v2 ownership and migrates its archive trail", () => {
  const digests = {
    vendored: "338ff5bb3d12f3dc991680436af80f59c63fa2b06d930cbab3aa4d333b0b6f58",
    registry: "513ec3c1c9ee9d980a4629c58c156c09be0167fc4e9bdaf185c6cebf59b1ff58",
  };
  for (const install of ["vendored", "registry"]) {
    const current = ciWorkflow.renderCiWorkflow({ install, version: "7.8.9-ci.2", tarballDigest: "a".repeat(64) });
    const lines = current.split("\n");
    const body = lines.slice(4).join("\n").split("\n# Project API memory:")[0]
      .replace(JSON.stringify(`./${LAYOUT.ciTarball}`), JSON.stringify(`./vendor/${PRODUCT}-ci.tgz`));
    lines[0] = "# generated-workflow: ci-artifact-pair-v2";
    lines[2] = `# generated-body-sha256: ${digestBytes(Buffer.from(body))}`;
    const old = `${lines.slice(0, 4).join("\n")}\n${body}`;
    assert.equal(digestBytes(Buffer.from(old)), digests[install], "historical v2 bytes remain exact");
    assert.equal(ciWorkflow.inspectCiWorkflowOwnership(old).owned, true);
    assert.equal(ciWorkflow.migrateCiWorkflowText(old), current);
    assert.equal(ciWorkflow.migrateCiWorkflowText(`${old}# team edit\n`), null);
  }
});
