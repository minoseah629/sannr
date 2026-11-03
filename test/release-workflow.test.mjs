// REL-1: validate the actual workflow YAML without a GitHub run or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "../lib/yaml.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (file) => readFileSync(join(ROOT, ".github/workflows", file), "utf8");
const workflow = (file) => {
  const result = parseYaml(source(file));
  assert.deepEqual(result.yamlWarnings ?? [], [], "workflow has ambiguous YAML keys");
  return result;
};
const runs = (job) => job.steps.filter((step) => step.run).map((step) => step.run);
const action = (job, name) => job.steps.find((step) => step.uses?.startsWith(`${name}@`));

function assertGates(gates, { ci = false } = {}) {
  assert.equal(gates["runs-on"], "ubuntu-latest");
  assert.deepEqual(gates.strategy.matrix, { node: [22, 24] });
  assert.equal(action(gates, "actions/setup-node").with["node-version"], "${{ matrix.node }}");
  const unit = gates.steps.find((step) => /^npm run test:full\b/.test(step.run ?? ""));
  assert.ok(unit, "release/full qualification explicitly runs test:full, not the fast default");
  // A piped gate declares bash so pipefail keeps the exit code — a tee must never eat a red suite.
  if (unit.run.includes("|")) assert.equal(unit.shell, "bash");
  assert.match(unit.run, /GITHUB_STEP_SUMMARY/, "the unit step writes to the job summary");
  assert.match(unit.run, /SKIP|﹣/, "skipped tests are listed by name in the job summary — a skip is a claim the run did not check");
  assert.ok(runs(gates).includes("npm run test:truth"));
  const stress = gates.steps.find((step) => step.run === "npm run test:stress");
  assert.equal(String(stress.env.SANNR_STRESS_LOCAL), "1");
  assert.match(stress.name, /local mode/i);
  const summaries = gates.steps.filter((step) => step.run?.includes("GITHUB_STEP_SUMMARY")).map((step) => step.run);
  assert.ok(summaries.some((run) => /stress.*local mode/i.test(run)), "the job summary names the stress run as the local mode");
  assert.doesNotMatch(JSON.stringify(gates), /shell\//);
  const fullCondition = "${{ github.event_name == 'workflow_dispatch' && inputs.full }}";
  for (const step of [unit, stress, gates.steps.find(step => step.run === 'npm run test:truth')]) {
    assert.equal(step.if, ci ? fullCondition : undefined, 'full qualification is optional in CI, mandatory for release');
    assert.equal(step['continue-on-error'], undefined);
  }
  if (ci) {
    const fast = gates.steps.find(step => /^npm test\b/.test(step.run ?? ''));
    assert.ok(fast, 'routine CI runs the fast safety set');
    assert.equal(fast.if, "${{ !(github.event_name == 'workflow_dispatch' && inputs.full) }}");
    assert.equal(fast.shell, 'bash');
    assert.equal(fast['continue-on-error'], undefined);
  }
}

test("release preparation is an explicit owner dispatch, read-only by default, and creates only a draft", () => {
  const release = workflow("release.yml");
  assert.deepEqual(release.on, { workflow_dispatch: { inputs: { tag: { description: "Existing version tag to prepare as a draft release", required: true, type: "string" } } } });
  assert.deepEqual(release.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(release.jobs), ["gates", "package", "release"]);
  assert.deepEqual(release.jobs.package.needs, ["gates"]);
  assert.deepEqual(release.jobs.release.needs, ["package"]);
  assertGates(release.jobs.gates);
});

test("release can only write release assets and has no shell or npm publishing", () => {
  const release = workflow("release.yml");
  assert.doesNotMatch(source("release.yml"), /npm\s+publish/);
  for (const [id, job] of Object.entries(release.jobs)) {
    assert.doesNotMatch(JSON.stringify(job), /shell\//);
    assert.deepEqual(job.permissions ?? {}, id === "release" ? { contents: "write" } : id === "package" ? { contents: "read", "id-token": "write", attestations: "write" } : {});
  }
});

test("package job verifies the tarball allowlist and uploads SHA-256 sums with it", () => {
  const job = workflow("release.yml").jobs.package;
  assert.equal(job["runs-on"], "ubuntu-latest");
  const commands = runs(job).join("\n");
  assert.match(commands, /npm pack --pack-destination release-artifacts/);
  assert.match(commands, /node scripts\/verify-package\.mjs release-artifacts\/\*\.tgz/);
  assert.match(commands, /sha256sum "\$\{assets\[@\]\}" > SHA256SUMS/);
  assert.ok(commands.indexOf("npm pack") < commands.indexOf("verify-package.mjs"));
  assert.ok(commands.indexOf("verify-package.mjs") < commands.indexOf("sha256sum"));
  assert.ok(commands.indexOf("verify-protocol-install.mjs") > commands.indexOf("verify-package.mjs"));
  assert.ok(commands.indexOf("verify-protocol-install.mjs") < commands.indexOf("sha256sum"));
  const checksums = job.steps.find((step) => step.run?.includes("sha256sum"));
  assert.equal(checksums["working-directory"], "release-artifacts");
  const upload = action(job, "actions/upload-artifact");
  assert.equal(upload.with.name, "sannr-package");
  assert.deepEqual(upload.with.path.trim().split("\n"), ["release-artifacts/*.tgz", "release-artifacts/*.zip", "release-artifacts/SHA256SUMS"]);
  assert.equal(upload.with["if-no-files-found"], "error");
});

test("GitHub Release verifies the existing tag and attaches the allowlisted release assets", () => {
  const job = workflow("release.yml").jobs.release;
  const download = action(job, "actions/download-artifact");
  assert.equal(download.with.name, "sannr-package");
  assert.equal(download.with.path, "release-artifacts");
  const create = job.steps.find((step) => step.run?.includes("gh release create"));
  assert.equal(create.env.GH_TOKEN, "${{ github.token }}");
  assert.equal(create.env.GH_REPO, "${{ github.repository }}");
  assert.match(create.run, /gh release create "\$\{RELEASE_TAG\}"/);
  assert.match(create.run, /--verify-tag/);
  assert.match(create.run, /--draft/);
  assert.equal(create.env.RELEASE_TAG, "${{ inputs.tag }}");
  assert.match(create.run, /assets=\(release-artifacts\/\*\.tgz release-artifacts\/\*\.zip release-artifacts\/SHA256SUMS\)/);
  assert.equal(create.env.RELEASE_PRERELEASE, "${{ needs.package.outputs.prerelease }}");
  assert.equal(create.shell, "bash");
});

test("npm publishing is an explicitly documented owner dispatch with a required tag", () => {
  const publish = workflow("publish.yml");
  assert.deepEqual(Object.keys(publish.on), ["workflow_dispatch"]);
  assert.deepEqual(publish.on.workflow_dispatch.inputs.tag, {
    description: "Existing version tag to publish (for example v0.1.0)", required: true, type: "string",
  });
  assert.match(source("publish.yml").split("\n")[0], /^#.*owner's launch-day act.*never triggered by a tag/);
  assert.deepEqual(publish.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(publish.jobs), ["gates", "publish"]);
  assert.deepEqual(publish.jobs.publish.needs, ["gates"]);
  assertGates(publish.jobs.gates);
});

test("only the publish job can mint provenance and use the npm token", () => {
  const publish = workflow("publish.yml");
  for (const [id, job] of Object.entries(publish.jobs)) {
    assert.doesNotMatch(JSON.stringify(job), /shell\//);
    assert.deepEqual(job.permissions ?? {}, id === "publish" ? { contents: "read", "id-token": "write", attestations: "write" } : {});
    if (id !== "publish") assert.doesNotMatch(JSON.stringify(job), /NPM_TOKEN|npm publish/);
  }
  const job = publish.jobs.publish;
  const setup = action(job, "actions/setup-node");
  assert.equal(setup.with["registry-url"], "https://registry.npmjs.org");
  const step = job.steps.find((step) => step.run?.includes("npm publish"));
  assert.equal(step.run, 'npm publish --provenance --access public --tag "$NPM_DIST_TAG" release-artifacts/*.tgz');
  assert.deepEqual(step.env, { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}", NPM_DIST_TAG: "${{ steps.metadata.outputs.dist_tag }}" });
  const commands = runs(job).join("\n");
  assert.doesNotMatch(commands, /npm pack/);
  assert.match(commands, /gh release download/);
  assert.ok(commands.indexOf("verify-release-artifact.mjs") > commands.indexOf("gh release download"));
  assert.ok(commands.indexOf("verify-npx-install.mjs") > commands.indexOf("verify-release-artifact.mjs"));
  assert.ok(commands.indexOf("npm publish") > commands.indexOf("verify-npx-install.mjs"));
  assert.ok(commands.indexOf("verify-protocol-install.mjs") > commands.indexOf("verify-release-artifact.mjs"));
  assert.ok(commands.indexOf("npm publish") > commands.indexOf("verify-protocol-install.mjs"));
});

test("both workflows reject mismatched or malformed tags and classify prereleases from package versions", () => {
  for (const file of ["publish.yml", "release.yml"]) {
    for (const job of Object.values(workflow(file).jobs).filter(job => job.steps.some(step => step.name === "Verify version equals tag"))) {
      const checkout = action(job, "actions/checkout");
      assert.equal(checkout.with.ref, "refs/tags/${{ inputs.tag }}");
      const guardIndex = job.steps.findIndex(step => step.name === "Verify version equals tag");
      assert.ok(guardIndex > job.steps.indexOf(checkout));
      assert.ok(guardIndex < job.steps.findIndex(step => /npm (?:test|pack|run (?:test:full|pack:alpha))|gh release download/.test(step.run ?? "")));
      const guard = job.steps[guardIndex];
      assert.equal(guard.id, "metadata");
      assert.deepEqual(guard.env, { RELEASE_TAG: "${{ inputs.tag }}" });
      const scratch = mkdtempSync(join(tmpdir(), "sannr-release-tag-"));
      try {
        const output = join(scratch, "metadata");
        for (const [version, tag, status, prerelease] of [
          ["0.1.0", "v0.1.0", 0, false],
          ["0.1.0-alpha.1", "v0.1.0-alpha.1", 0, true],
          ["0.1.0-beta.1", "v0.1.0-beta.1", 0, true],
          ["0.1.0-rc.1+build", "v0.1.0-rc.1+build", 0, true],
          ["0.1.0+build-with-hyphen", "v0.1.0+build-with-hyphen", 0, false],
          ["0.1.0", "v0.2.0", 1], ["0.1.0", "0.1.0", 1],
          ["0.1.0", "main", 1], ["0.1.0", "", 1],
          ["0.1.0", "v0.1.0; touch injected", 1],
          ["0.1.0-alpha..1", "v0.1.0-alpha..1", 1],
          ["0.1.0-alpha.01", "v0.1.0-alpha.01", 1],
          ["0.1.0+build..1", "v0.1.0+build..1", 1],
          ["0.1.0; touch injected", "v0.1.0; touch injected", 1],
        ]) {
          writeFileSync(join(scratch, "package.json"), JSON.stringify({ version }));
          writeFileSync(output, "");
          const result = spawnSync("bash", ["-e", "-c", guard.run], {
            cwd: scratch, env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output }, encoding: "utf8",
          });
          assert.equal(result.status, status, `${file} tag ${JSON.stringify(tag)}: ${result.stderr}`);
          if (status) {
            assert.match(result.stderr, /does not match package version/);
            assert.equal(readFileSync(output, "utf8"), "", "failed validation cannot select a release channel");
          } else assert.equal(readFileSync(output, "utf8"), file === "publish.yml"
            ? `dist_tag=${!prerelease ? "latest" : version.includes("-alpha") ? "alpha" : version.includes("-beta") ? "beta" : "next"}\n`
            : `prerelease=${prerelease}\n`);
        }
        assert.deepEqual(readdirSync(scratch).sort(), ["metadata", "package.json"]);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    }
  }
});

test("npm provenance refuses private or unknown repository visibility before checkout or credentials", () => {
  for (const job of Object.values(workflow("publish.yml").jobs)) {
    const guard = job.steps[0];
    assert.equal(guard.name, "Require public source for npm provenance");
    assert.deepEqual(guard.env, { SOURCE_REPOSITORY_PRIVATE: "${{ github.event.repository.private }}" });
    for (const [visibility, status] of [["true", 1], ["", 1], ["unknown", 1], ["false", 0]]) {
      const result = spawnSync("bash", ["-e", "-c", guard.run], {
        env: { ...process.env, SOURCE_REPOSITORY_PRIVATE: visibility }, encoding: "utf8",
      });
      assert.equal(result.status, status);
      if (status) assert.match(result.stderr, /NPM_PROVENANCE_PRIVATE_SOURCE/);
    }
    assert.doesNotMatch(guard.run, /gh repo edit|npm publish|NODE_AUTH_TOKEN|provenance=false/);
  }
});

test("only an alpha.N tag builds the alpha installer ZIP, before generated files can dirty the build receipt", () => {
  const job = workflow("release.yml").jobs.package;
  assert.deepEqual(job.outputs, { prerelease: "${{ steps.metadata.outputs.prerelease }}" });
  const alphaIndex = job.steps.findIndex(step => step.name?.startsWith("Build the alpha installer ZIP"));
  assert.ok(alphaIndex >= 0 && alphaIndex < job.steps.findIndex(step => step.name === "Pack the package"));
  const step = job.steps[alphaIndex];
  // The guard is the step's own script so it can be exercised here: a beta,
  // rc or final release installs from npm and must not build an alpha installer.
  const scratch = mkdtempSync(join(tmpdir(), "sannr-release-alpha-"));
  try {
    mkdirSync(join(scratch, "bin"));
    const log = join(scratch, "npm-calls");
    writeFileSync(join(scratch, "bin", "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$NPM_CALL_LOG"\n', { mode: 0o755 });
    for (const [tag, builds] of [
      ["v0.1.0-alpha.12", true], ["v0.1.0-alpha.1", true], ["v1.2.3-alpha.0+build.7", true],
      ["v0.1.0-beta.1", false], ["v0.1.0-beta.12", false], ["v0.1.0", false], ["v0.1.0-rc.1", false],
      ["v0.1.0-alphabet.1", false], ["v0.1.0-alpha", false], ["v0.1.0-beta.1-alpha.1", false],
      ["v0.1.0-alpha.1; touch injected", false], ["", false],
    ]) {
      writeFileSync(log, "");
      const result = spawnSync("bash", ["-e", "-c", step.run], { cwd: scratch, encoding: "utf8",
        env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`, RELEASE_TAG: tag, NPM_CALL_LOG: log } });
      assert.equal(result.status, 0, `${JSON.stringify(tag)}: ${result.stderr}`);
      assert.equal(readFileSync(log, "utf8"), builds ? "run pack:alpha -- --out release-artifacts\n" : "",
        `${JSON.stringify(tag)} ${builds ? "must" : "must not"} build the alpha installer`);
    }
    assert.deepEqual(readdirSync(scratch).sort(), ["bin", "npm-calls"], "the guard writes nothing else");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  assert.equal(step.if, undefined, "the tag guard lives in the script, where this test can run it");
  assert.deepEqual(step.env, { RELEASE_TAG: "${{ inputs.tag }}" });
  assert.equal(step.shell, "bash");
});

test("release execution marks alpha prereleases without latest and keeps asset globs bounded", () => {
  const create = workflow("release.yml").jobs.release.steps.find(step => step.run?.includes("gh release create"));
  const scratch = mkdtempSync(join(tmpdir(), "sannr-release-create-"));
  try {
    mkdirSync(join(scratch, "release-artifacts"));
    const log = join(scratch, "args");
    for (const file of ["package.tgz", "SHA256SUMS", "private.txt"]) writeFileSync(join(scratch, "release-artifacts", file), "fixture");
    for (const prerelease of ["false", "true", "unknown"]) {
      if (prerelease === "true") writeFileSync(join(scratch, "release-artifacts", "installer.zip"), "fixture");
      writeFileSync(log, "");
      const result = spawnSync("bash", ["-e", "-c", 'gh() { printf "%s\\n" "$@" > "$RELEASE_ARGUMENT_LOG"; }\n' + create.run], {
        cwd: scratch,
        env: { ...process.env, RELEASE_PRERELEASE: prerelease, RELEASE_TAG: "v0.1.0-alpha.1", RELEASE_ARGUMENT_LOG: log },
        encoding: "utf8",
      });
      assert.equal(result.status, prerelease === "unknown" ? 1 : 0, result.stderr);
      const args = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
      if (prerelease === "unknown") { assert.deepEqual(args, []); continue; }
      assert.deepEqual(args.slice(0, 3), ["release", "create", "v0.1.0-alpha.1"]);
      assert.equal(args.includes("--prerelease"), prerelease === "true");
      assert.equal(args.includes("--latest=false"), prerelease === "true");
      assert.equal(args.includes("release-artifacts/installer.zip"), prerelease === "true");
      assert.ok(args.includes("--draft"), "workflow cannot publish a release implicitly");
      assert.ok(args.includes("release-artifacts/package.tgz"));
      assert.ok(args.includes("release-artifacts/SHA256SUMS"));
      assert.ok(!args.some(arg => /private|\*/.test(arg)), "no unrelated files or unmatched globs reach gh");
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("the active workflows are exactly ci, release, and publish — and only publish can publish", () => {
  const files = readdirSync(join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f)).sort();
  assert.deepEqual(files, ["ci.yml", "publish.yml", "release.yml"]);
  const ci = workflow("ci.yml");
  assert.deepEqual(Object.keys(ci.on).sort(), ["pull_request", "push", "workflow_dispatch"]);
  assert.equal(ci.on.workflow_dispatch.inputs.full.type, 'boolean');
  assert.equal(ci.on.workflow_dispatch.inputs.full.default, false);
  assert.equal(ci.permissions.contents, "read");
  for (const [name, job] of Object.entries(ci.jobs)) {
    assert.doesNotMatch(JSON.stringify(job), /npm publish|contents: write|id-token|upload-artifact|gh release/, `ci job ${name} must only test`);
    assert.ok(Number.isInteger(job["timeout-minutes"]), `ci job ${name} carries a timeout`);
  }
  assertGates(ci.jobs.gates, { ci: true });
});

test("package metadata permits the npm-only alpha without advertising private source", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (pkg.repository === undefined) {
    // Manual npm-only alpha publishing is separate from the public-source
    // provenance workflow. That later route still needs repository metadata.
    assert.match(pkg.version, /^\d+\.\d+\.\d+-alpha\.\d+$/);
    assert.equal(pkg.homepage, undefined, "npm must not infer a private README URL");
    assert.equal(pkg.bugs, undefined, "npm must not advertise a private issue tracker");
  } else {
    assert.deepEqual(pkg.repository, { type: "git", url: "git+https://github.com/sannrhq/sannr.git" });
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), []);
  assert.equal(pkg.bundleDependencies, undefined);
  assert.deepEqual(Object.keys(pkg.optionalDependencies).sort(), ['@grpc/grpc-js', '@grpc/proto-loader', 'graphql', 'protobufjs', 'ws']);
  for (const version of Object.values(pkg.optionalDependencies)) assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('every test or packaging job installs locked runtime dependencies first', () => {
  for (const file of ['ci.yml', 'release.yml', 'publish.yml']) for (const job of Object.values(workflow(file).jobs)) {
    const consumer = job.steps.findIndex(step => /npm test|npm run test:full|node --test|npm pack/.test(step.run ?? ''));
    if (consumer < 0) continue;
    const install = job.steps.findIndex(step => step.run === 'npm ci --ignore-scripts --no-audit --no-fund');
    assert.ok(install >= 0 && install < consumer, `${file}: dependencies must exist before tests or packing`);
  }
});

test("CI and release workflows pin every action to a full commit SHA, not a movable tag", () => {
  for (const file of ["ci.yml", "release.yml", "publish.yml"]) {
    for (const [name, job] of Object.entries(workflow(file).jobs)) {
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file} ${name}: ${step.uses}`);
      }
    }
  }
});

test("every release job carries a timeout so a hung gate cannot hold a runner for hours", () => {
  for (const file of ["release.yml", "publish.yml"]) {
    for (const [name, job] of Object.entries(workflow(file).jobs)) {
      const minutes = job["timeout-minutes"];
      assert.ok(Number.isInteger(minutes) && minutes > 0 && minutes <= 60, `${file} ${name}: timeout-minutes=${minutes}`);
    }
  }
});

test("public releases promote latest by default with an explicit alpha-only exception", () => {
  const publish = workflow("publish.yml");
  const input = publish.on.workflow_dispatch.inputs.promote_latest;
  assert.equal(input.required, false);
  assert.equal(input.type, "boolean");
  assert.equal(input.default, true, "normal public alpha releases must update the front page and default install");
  const step = publish.jobs.publish.steps.find((step) => step.run?.includes("npm dist-tag add"));
  assert.ok(step, "the publish job promotes latest in a dedicated step");
  assert.equal(step.if, "${{ inputs.promote_latest }}");
  assert.equal(step.run, `npm dist-tag add "$(node -p 'const p = require("./package.json"); p.name + "@" + p.version')" latest`);
  assert.deepEqual(step.env, { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" });
  assert.doesNotMatch(step.run, /npm publish/);
  for (const [id, job] of Object.entries(publish.jobs)) if (id !== "publish") assert.doesNotMatch(JSON.stringify(job), /dist-tag/);
});


test("npm tag readback waits for propagation, bounds failures and respects explicit alpha-only releases", () => {
  const job = workflow("publish.yml").jobs.publish;
  const check = job.steps.find(step => step.name === "Verify public npm tags");
  assert.ok(check, "publication requires registry tag readback after promotion");
  assert.ok(job.steps.indexOf(check) > job.steps.findIndex(step => step.run?.includes("npm dist-tag add")));
  assert.equal(check.if, undefined, "alpha-only releases still verify their alpha tag");
  assert.equal(check["continue-on-error"], undefined);
  assert.deepEqual(check.env, {
    NPM_DIST_TAG: "${{ steps.metadata.outputs.dist_tag }}", PROMOTE_LATEST: "${{ inputs.promote_latest }}",
  });
  const scratch = mkdtempSync(join(tmpdir(), "release-tag-readback-"));
  const version = "0.1.0-alpha.2", older = "0.1.0-alpha.1";
  try {
    mkdirSync(join(scratch, "bin")); mkdirSync(join(scratch, "release-artifacts"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "@example/release", version }));
    writeFileSync(join(scratch, "bin/npm"), String.raw`#!${process.execPath}
const fs = require('node:fs');
const calls = fs.readFileSync('npm-calls.jsonl', 'utf8').trim().split('\n').filter(Boolean).length;
fs.appendFileSync('npm-calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\n');
const responses = JSON.parse(process.env.MOCK_RESPONSES);
const response = responses[Math.min(calls, responses.length - 1)];
if (response.exit) process.exit(response.exit);
process.stdout.write(response.raw ?? JSON.stringify(response.tags));
`, { mode: 0o755 });
    writeFileSync(join(scratch, "bin/sleep"), String.raw`#!${process.execPath}
require('node:fs').appendFileSync('sleep-calls.jsonl', JSON.stringify(process.argv.slice(2)) + '\n');
`, { mode: 0o755 });
    const current = { tags: { alpha: version, latest: version } };
    for (const row of [
      { name: "both current", responses: [current], status: 0, calls: 1 },
      { name: "propagates on third read", responses: [{ tags: { alpha: older, latest: older } }, { tags: { alpha: version } }, current], status: 0, calls: 3 },
      { name: "transient error and malformed response recover", responses: [{ exit: 12 }, { raw: "not JSON" }, current], status: 0, calls: 3 },
      { name: "stale latest", responses: [{ tags: { alpha: version, latest: older } }], status: 1, calls: 5 },
      { name: "stale alpha", responses: [{ tags: { alpha: older, latest: version } }], status: 1, calls: 5 },
      { name: "missing latest", responses: [{ tags: { alpha: version } }], status: 1, calls: 5 },
      { name: "explicit alpha-only", responses: [{ tags: { alpha: version, latest: older } }], promote: "false", status: 0, calls: 1 },
      { name: "npm failed", responses: [{ exit: 12 }], status: 1, calls: 5 },
      { name: "malformed response", responses: [{ raw: "not JSON" }], status: 1, calls: 5 },
    ]) {
      const promote = row.promote ?? "true";
      const summary = join(scratch, "summary"); writeFileSync(summary, "");
      for (const file of ["npm-calls.jsonl", "sleep-calls.jsonl"]) writeFileSync(join(scratch, file), "");
      const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", check.run], {
        cwd: scratch, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
          MOCK_RESPONSES: JSON.stringify(row.responses),
          GITHUB_STEP_SUMMARY: summary, NPM_DIST_TAG: "alpha", PROMOTE_LATEST: promote },
      });
      assert.equal(result.status, row.status, `${row.name}: ${result.stderr}`);
      const readCalls = file => readFileSync(join(scratch, file), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
      const calls = readCalls("npm-calls.jsonl"), sleeps = readCalls("sleep-calls.jsonl");
      assert.equal(calls.length, row.calls, `${row.name}: bounded registry reads`);
      assert.deepEqual(sleeps, Array.from({ length: row.calls - 1 }, () => ["75"]), "wait only between reads; five tries span five minutes plus bounded network time");
      for (const args of calls) {
        assert.deepEqual(args.slice(0, 4), ["view", "@example/release", "dist-tags", "--json"]);
        for (const flag of ["--registry=https://registry.npmjs.org/", "--prefer-online", "--fetch-retries=0", "--fetch-timeout=30000"]) assert.ok(args.includes(flag));
      }
      const output = readFileSync(summary, "utf8");
      if (row.status) {
        assert.equal(output, "", `${row.name} cannot claim successful verification`);
        assert.match(result.stderr, /NPM_TAG_VERIFICATION_PENDING/);
      } else if (promote === "false") assert.match(output, /alpha-only/);
      else assert.match(output, /front page.*visibly show/);
    }
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test("publication binds the downloaded tarball and tag to explicit owner-approved identities", () => {
  const publish = workflow("publish.yml");
  for (const input of ["approved_sha256", "approved_commit"]) {
    assert.equal(publish.on.workflow_dispatch.inputs[input].required, true);
    assert.equal(publish.on.workflow_dispatch.inputs[input].type, "string");
  }
  for (const job of Object.values(publish.jobs)) {
    const guard = job.steps.find(step => step.name === "Require the approved source commit");
    assert.ok(guard);
    assert.match(guard.run, /git rev-parse HEAD/);
    assert.ok(job.steps.indexOf(guard) < job.steps.findIndex(step => /npm ci/.test(step.run ?? "")));
  }
  const verify = publish.jobs.publish.steps.find(step => step.name === "Verify the exact approved artifact and source bytes");
  assert.deepEqual(verify.env, { APPROVED_SHA256: "${{ inputs.approved_sha256 }}", APPROVED_COMMIT: "${{ inputs.approved_commit }}" });
  assert.match(verify.run, /archives\[@\].*ne 1/);
  assert.match(verify.run, /SHA256SUMS/);
});

test("a beta release kept off latest names its own channel in the job summary", () => {
  const check = workflow("publish.yml").jobs.publish.steps.find(step => step.name === "Verify public npm tags");
  const scratch = mkdtempSync(join(tmpdir(), "release-beta-only-"));
  try {
    mkdirSync(join(scratch, "bin")); mkdirSync(join(scratch, "release-artifacts"));
    writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "@example/release", version: "0.1.0-beta.1" }));
    writeFileSync(join(scratch, "bin/npm"), String.raw`#!${process.execPath}
process.stdout.write(JSON.stringify({ beta: "0.1.0-beta.1", latest: "0.1.0-alpha.12" }));
`, { mode: 0o755 });
    writeFileSync(join(scratch, "bin/sleep"), "#!/bin/sh\n", { mode: 0o755 });
    const summary = join(scratch, "summary"); writeFileSync(summary, "");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", check.run], {
      cwd: scratch, encoding: "utf8", timeout: 15000, env: { ...process.env, PATH: `${join(scratch, "bin")}:${process.env.PATH}`,
        GITHUB_STEP_SUMMARY: summary, NPM_DIST_TAG: "beta", PROMOTE_LATEST: "false" },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(summary, "utf8");
    assert.match(output, /Registry tags verified for @example\/release@0\.1\.0-beta\.1: beta\./);
    assert.match(output, /beta-only/);
    assert.doesNotMatch(output, /alpha/, "a beta release summary must not describe itself as alpha");
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});
