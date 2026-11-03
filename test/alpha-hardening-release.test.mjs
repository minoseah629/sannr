// AH-5 release boundaries: fixtures stay in temporary projects and make no API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, X509Certificate, createPrivateKey, createPublicKey } from "node:crypto";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { PRODUCT, HOME_ENV_NAME } from "../lib/brand.mjs";
import { parseYaml } from "../lib/yaml.mjs";
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const text = p => readFileSync(join(ROOT, p), "utf8");
const scratch = t => { const dir = mkdtempSync(join(tmpdir(), `${PRODUCT}-release-specimen-`)); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const workflow = file => parseYaml(text(`.github/workflows/${file}.yml`));
// The alpha ZIP handoff (its verifier guide and builder) stays in the private
// repository. Its tests skip by name in the public source cut.
const ALPHA_GUIDE_ABSENT = existsSync(join(ROOT, "packaging/alpha/VERIFY-ZIP.md")) ? false
  : "the private alpha ZIP verifier guide is absent from this public source cut";
const ALPHA_PACKER_ABSENT = existsSync(join(ROOT, "scripts/pack-alpha.mjs")) ? false
  : "the private alpha ZIP builder is absent from this public source cut";

test("DOTSANNR-1 feedback skill installs by default and connect --alpha remains compatible", t => {
  const root = scratch(t), home = join(root, "home"); mkdirSync(home);
  const env = { ...process.env, HOME: home, [HOME_ENV_NAME]: join(home, "state") };
  for (const key of Object.keys(env)) if (key.startsWith("API_")) delete env[key];
  const run = args => spawnSync(process.execPath, [join(ROOT, "bin/cli.mjs"), "connect", "--json", ...args], { cwd: root, env, encoding: "utf8" });
  let result = run([]); assert.equal(result.status, 0, result.stderr);
  for (const host of [".agents", ".claude"]) assert.equal(existsSync(join(root, host, "skills", `${PRODUCT}-feedback`, "SKILL.md")), true, "ordinary setup installs all three branded skills");
  result = run(["--alpha"]); assert.equal(result.status, 0, result.stderr);
  for (const host of [".agents", ".claude"]) assert.equal(existsSync(join(root, host, "skills", `${PRODUCT}-feedback`, "SKILL.md")), true);
});

test("AH-5 out-of-band ZIP checksum is checked before extraction or reading bundled instructions", { skip: ALPHA_GUIDE_ABSENT }, t => {
  const guide = text("packaging/alpha/VERIFY-ZIP.md");
  assert.match(guide, /out-of-band checksum/i);
  const script = /```js\n([\s\S]*?)\n```/.exec(guide)?.[1];
  assert.ok(script, "the pre-extraction verifier must be supplied outside the ZIP");
  const root = scratch(t), archive = join(root, "fixture.zip"), marker = join(root, "unzip-called");
  writeFileSync(archive, "opaque archive fixture");
  const bin = join(root, "bin"); mkdirSync(bin);
  writeFileSync(join(bin, "unzip"), '#!/bin/sh\n: > "$EXTRACTION_MARKER"\n', { mode: 0o755 });
  const run = checksum => spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ALPHA_ZIP_PATH: archive, ALPHA_ZIP_SHA256: checksum, ALPHA_EXTRACT_DIR: join(root, "extracted"), EXTRACTION_MARKER: marker } });
  const wrong = run("0".repeat(64)); assert.equal(wrong.status, 1); assert.equal(existsSync(marker), false); assert.match(wrong.stderr, /ALPHA_ZIP_CHECKSUM_MISMATCH/);
  const malformed = run("not-a-checksum"); assert.equal(malformed.status, 1); assert.equal(existsSync(marker), false);
  const correct = run(createHash("sha256").update(readFileSync(archive)).digest("hex")); assert.equal(correct.status, 0, correct.stderr); assert.equal(existsSync(marker), true);
  assert.ok(guide.indexOf("ALPHA_ZIP_CHECKSUM_MISMATCH") < guide.indexOf("Read INSTALL.txt"));
});

test("AH-5 ZIP verifier refuses I/O failures by fixed code without input paths", { skip: ALPHA_GUIDE_ABSENT }, t => {
  const script = /```js\n([\s\S]*?)\n```/.exec(text("packaging/alpha/VERIFY-ZIP.md"))?.[1]; assert.ok(script);
  const root = scratch(t), archive = join(root, "private-archive-name.zip"), target = join(root, "private-extraction-name");
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", env: { ...process.env, ALPHA_ZIP_PATH: archive, ALPHA_ZIP_SHA256: createHash("sha256").update("fixture").digest("hex"), ALPHA_EXTRACT_DIR: target } });
  const missing = run(); assert.equal(missing.status, 1); assert.match(missing.stderr, /^ALPHA_ZIP_READ_FAILED:/); assert.doesNotMatch(missing.stderr, /private-archive-name|private-extraction-name|node:fs/);
  writeFileSync(archive, "fixture"); writeFileSync(target, "occupied");
  const occupied = run(); assert.equal(occupied.status, 1); assert.match(occupied.stderr, /^ALPHA_ZIP_EXTRACTION_FAILED:/); assert.doesNotMatch(occupied.stderr, /private-archive-name|private-extraction-name|node:fs/);
});

test("AH-5 release and publish serialize builds and attest the built artifacts", () => {
  for (const [file, id] of [["release", "package"], ["publish", "publish"]]) {
    const w = workflow(file), job = w.jobs[id];
    assert.ok(w.concurrency?.group?.includes("${{")); assert.equal(w.concurrency["cancel-in-progress"], false);
    assert.equal(job.permissions["id-token"], "write"); assert.equal(job.permissions.attestations, "write");
    const index = job.steps.findIndex(s => /^actions\/attest(?:-build-provenance)?@[0-9a-f]{40}$/.test(s.uses ?? ""));
    assert.ok(index > job.steps.findIndex(s => s.run?.includes("verify-package.mjs")));
    assert.match(job.steps[index].with["subject-path"], /release-artifacts\/\*\.tgz/);
    if (file === "release") assert.match(job.steps[index].with["subject-path"], /release-artifacts\/\*\.zip/);
  }
});

test("AH-5 each npm build ships a distinct build id in the installed package", t => {
  const root = scratch(t), pkg = JSON.parse(text("package.json"));
  assert.equal(pkg.scripts.prepack, "node scripts/write-build-id.mjs");
  mkdirSync(join(root, "scripts")); mkdirSync(join(root, "lib"));
  cpSync(join(ROOT, "scripts/write-build-id.mjs"), join(root, "scripts/write-build-id.mjs"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "build-fixture", version: "1.0.0", type: "module", files: ["lib/"], scripts: { prepack: pkg.scripts.prepack } }));
  const ids = [];
  for (let i = 0; i < 2; i++) {
    const result = spawnSync("npm", ["pack", "--offline", "--json"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const packed = JSON.parse(result.stdout)[0]; assert.ok(packed.files.some(f => f.path === "lib/build-info.json"));
    const build = JSON.parse(spawnSync("tar", ["xOf", join(root, packed.filename), "package/lib/build-info.json"], { encoding: "utf8" }).stdout);
    assert.match(build.buildId, /^[0-9a-f-]{36}$/); ids.push(build.buildId);
  }
  assert.notEqual(ids[0], ids[1]);
});

test("AH-5 alpha packing generates the build id despite its ignore-scripts setting", { skip: ALPHA_PACKER_ABSENT }, () => {
  assert.match(text("scripts/pack-alpha.mjs"), /write-build-id\.mjs/, "alpha packing must generate the id despite its ignore-scripts setting");
});

test("AH-5 build identity write errors use fixed text without workstation paths", t => {
  const root = scratch(t); mkdirSync(join(root, "scripts"));
  cpSync(join(ROOT, "scripts/write-build-id.mjs"), join(root, "scripts/write-build-id.mjs"));
  const result = spawnSync(process.execPath, [join(root, "scripts/write-build-id.mjs")], { encoding: "utf8" });
  assert.equal(result.status, 1); assert.match(result.stderr, /^BUILD_ID_WRITE_FAILED:/);
  assert.equal(result.stderr.includes(root), false); assert.doesNotMatch(result.stderr, /node:fs|ENOENT/);
});

test("AH-5 gRPC fixtures generate a fresh valid key pair at test start and commit no private key", async t => {
  const tracked = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" }); assert.equal(tracked.status, 0);
  const privateMarker = /^-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----\r?$/m;
  const offenders = tracked.stdout.split("\0").filter(Boolean).filter(file => existsSync(join(ROOT, file)) && privateMarker.test(readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(offenders, [], "private key material must never be tracked");
  const { ephemeralTlsPair } = await import("./helpers/ephemeral-tls.mjs");
  const a = ephemeralTlsPair(), b = ephemeralTlsPair();
  const cert = new X509Certificate(a.cert_chain);
  assert.equal(cert.checkPrivateKey(createPrivateKey(a.private_key)), true);
  assert.equal(cert.verify(createPublicKey(a.private_key)), true);
  assert.notDeepEqual(a.private_key, b.private_key);
  assert.match(text("test/protocol-grpc.test.mjs"), /const TLS_PAIR = ephemeralTlsPair\(\)/);
});

test("the retired desktop shell has no tracked source, dependency lane, or CI audit", t => {
  const tracked = spawnSync("git", ["ls-files", "-z", "--", "shell"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.equal(tracked.stdout, "", "the optional Electron shell must stay out of the active source tree");
  assert.ok(existsSync(join(ROOT, ".github/dependabot.yml")), "dependency update configuration is missing");
  const config = parseYaml(text(".github/dependabot.yml"));
  assert.ok(config.updates.some(row => row["package-ecosystem"] === "npm" && row.directory === "/" && row.schedule.interval === "weekly"));
  assert.equal(config.updates.some(row => row["package-ecosystem"] === "npm" && row.directory === "/shell"), false);
  const audit = workflow("ci").jobs.gates.steps.find(s => /npm audit\b/.test(s.run ?? ""));
  assert.equal(audit?.["continue-on-error"], true); assert.doesNotMatch(audit.run, /npm audit --prefix shell/);
  const log = join(scratch(t), "audit-arguments");
  const stub = 'npm() { printf "%s\\n" "$*" >> "$AUDIT_ARGUMENTS"; if [ "$#" -eq 1 ]; then return 1; fi; }\n';
  const result = spawnSync("bash", ["-e", "-c", stub + audit.run], { encoding: "utf8", env: { ...process.env, AUDIT_ARGUMENTS: log } });
  assert.equal(result.status, 1, "vulnerabilities remain visible to the non-blocking step");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), ["audit"]);
});

// A package build must not change the engine that concurrent fixture consumers hash.
test("AH-5 alpha packaging preserves the source engine build identity", { timeout: 120_000, skip: ALPHA_PACKER_ABSENT }, t => {
  const before = existsSync(join(ROOT, "lib/build-info.json")) ? readFileSync(join(ROOT, "lib/build-info.json"), "utf8") : null;
  const output = join(scratch(t), "bundle");
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/pack-alpha.mjs"), "--out", output], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stderr);
  const after = existsSync(join(ROOT, "lib/build-info.json")) ? readFileSync(join(ROOT, "lib/build-info.json"), "utf8") : null;
  assert.equal(after, before, "alpha packaging must generate identity only in its isolated staging tree");
});

test("AH-5 build identity replacement leaves symlink and hardlink targets unchanged", t => {
  const root = scratch(t); mkdirSync(join(root, "scripts")); mkdirSync(join(root, "lib"));
  cpSync(join(ROOT, "scripts/write-build-id.mjs"), join(root, "scripts/write-build-id.mjs"));
  const target = join(root, "shared-target"), generated = join(root, "lib/build-info.json");
  writeFileSync(target, "retained fixture");
  for (const alias of [symlinkSync, linkSync]) {
    alias(target, generated);
    const result = spawnSync(process.execPath, [join(root, "scripts/write-build-id.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(target, "utf8"), "retained fixture");
    assert.notEqual(lstatSync(generated).ino, lstatSync(target).ino);
    assert.match(JSON.parse(readFileSync(generated, "utf8")).buildId, /^[0-9a-f-]{36}$/);
    rmSync(generated);
  }
});

test("AH-5 alpha ZIP builds without an external zip executable", { timeout: 120_000, skip: ALPHA_PACKER_ABSENT }, t => {
  const root = scratch(t), commands = join(root, "commands"); mkdirSync(commands);
  writeFileSync(join(commands, "zip"), "#!/bin/sh\nexit 97\n", { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(ROOT, "scripts/pack-alpha.mjs"), "--out", join(root, "output")], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${commands}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, "building the ZIP must not invoke an external zip command");
  const report = JSON.parse(result.stdout);
  const checked = spawnSync("unzip", ["-t", report.archive], { encoding: "utf8" });
  assert.equal(checked.status, 0, "an independent ZIP reader must validate all entry checksums");
});
