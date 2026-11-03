// The explicit CI door written by connect --ci.
//
// Vendored installs bind a workflow to one exact engine archive; registry
// installs bind a workflow to the generating package version. Plan and stage
// every affected artifact together, including explicit install-mode changes.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CI_TARBALL_BASENAME, CI_WORKFLOW_BASENAME, POINTER_CLI_NAME, PRODUCT, NPM_PACKAGE,
} from "./brand.mjs";
import { LAYOUT, layoutFor } from "./layout.mjs";
import { secretIn } from "./verdicts.mjs";
import { isRuntimeDependencyPath, verifyRuntimeDependency, validateRuntimeBundle } from './runtime-dependencies.mjs';

const LIB = dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = dirname(LIB);
export const CI_WORKFLOW_REL = join(".github", "workflows", CI_WORKFLOW_BASENAME);
export const CI_TARBALL_REL = LAYOUT.ciTarball;
const LEGACY_CI_TARBALL_REL = join("vendor", CI_TARBALL_BASENAME);

const posix = (path) => path.split(sep).join("/");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// The launch default (flipped 2026-09-14 for the first public release):
// registry mode installs the exact version of the generating CLI from npm and
// commits no archive. Vendored stays an explicit choice. Pinned by a test.
export const CI_INSTALL_DEFAULT = "registry";
const OWNERSHIP_FORMAT = "ci-artifact-pair-v3";
const PRE_LAYOUT_OWNERSHIP_FORMAT = "ci-artifact-pair-v2";
const LEGACY_OWNERSHIP_FORMAT = "ci-artifact-pair-v1";
// Fingerprint of the original v1 body as literal fragments and typed slots
// for product/CLI/archive. Recognise old installs without shipping their
// retired prose or treating a caller's self-hash as authorship.
const LEGACY_BODY_DIGEST = "785be84d7d4ad30bae1a3fcf0fd4676127979cd3e5ff2f8cc7b7667c3a2fee71";
const named = (code, message) => Object.assign(new Error(message), { code });

function validateInstall(install) {
  if (!["vendored", "registry"].includes(install))
    throw named("CI_INSTALL_INVALID", "--install must be vendored or registry.");
}

function validateVersion(version) {
  // An exact SemVer only: no npm tags, ranges, URLs or shell syntax. Numeric
  // prerelease identifiers may not have leading zeroes (SemVer 2.0).
  const part = "(?:0|[1-9][0-9]*)";
  const pre = `(?:${part}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const exact = new RegExp(`^${part}\\.${part}\\.${part}(?:-${pre}(?:\\.${pre})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
  if (typeof version !== "string" || !exact.test(version))
    throw named("CI_PACKAGE_VERSION_INVALID", "Registry CI requires an exact version in the generating package's own package.json.");
  return version;
}

function engineVersion(packageRoot = ENGINE_ROOT) {
  let version;
  try { version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version; }
  catch { /* the named validation below owns unreadable package metadata */ }
  return validateVersion(version);
}

/** The current versioned template. Default and explicit vendored mode produce
 * identical bytes; registry binds the generating package's exact version. */
export function renderCiWorkflow({ product = PRODUCT, packageName = NPM_PACKAGE, cli = POINTER_CLI_NAME,
  tarball = posix(CI_TARBALL_REL), tarballDigest, install = CI_INSTALL_DEFAULT,
  version, layout = LAYOUT } = {}) {
  validateInstall(install);
  if (install === "registry") version = validateVersion(version ?? engineVersion());
  return renderCiWorkflowV3({ product, packageName, cli, tarball, tarballDigest, install, version, layout });
}

/** Keep each ownership renderer byte-stable; future changes need a new version
 * so unwire can continue recognising workflows that consumers already own.
 * (2026-09-08: the registry install line moved to the scoped package name while
 * the default was still vendored and no consumer held a registry-mode workflow;
 * the vendored bytes did not change, so v2 stands.) */
function renderCiWorkflowV2({ product, packageName, cli, tarball, tarballDigest, install, version }) {
  if (install === "vendored" && !/^[a-f0-9]{64}$/.test(tarballDigest ?? ""))
    throw named("CI_PACK_FAILED", "A generated vendored workflow requires the exact self-pack digest.");
  // A scoped name is the shipped form (`@name/name`); an unscoped one stays valid
  // so a rename through the seam keeps rendering. Nothing else may reach npm.
  if (install === "registry" && !/^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,63}$/i.test(packageName))
    throw named("CI_INSTALL_INVALID", "Registry CI requires a valid npm package name.");
  const installation = install === "vendored"
    ? `      - name: Install ${product} from the vendored engine
        run: npm install --ignore-scripts --no-audit --no-fund --offline --no-save ${JSON.stringify(`./${tarball}`)}`
    : `      - name: Install ${product} from the npm registry
        run: npm install --ignore-scripts --no-audit --no-fund --no-save ${packageName}@${version}`;
  const body = `name: ${product} API audit

on:
  push:
  pull_request:
  schedule:
    - cron: "17 9 * * 1"

permissions:
  contents: read

concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  report:
    name: ${product} CI report
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Check out source for ${product}
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - name: Set up Node for ${product}
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version: 22
${installation}
      - name: ${product} push and pull request audit
        if: github.event_name != 'schedule'
        run: ${cli} audit . --ci --report-only --summary "$GITHUB_STEP_SUMMARY" --no-execute
      - name: ${product} weekly freshness report
        if: github.event_name == 'schedule'
        run: ${cli} audit . --ci --report-only --summary "$GITHUB_STEP_SUMMARY" --no-execute

      # Enforcing mode is off by default; when the report has been clean for a while,
      # remove only --report-only — keep the no-traffic and summary boundaries.
      # - name: ${product} enforcing audit
      #   run: ${cli} audit . --ci --summary "$GITHUB_STEP_SUMMARY" --no-execute

      # Organization-internal alternative (comment only; never the default):
      # with a read-only organization token in NODE_AUTH_TOKEN, replace the
      # engine install with: npm install --ignore-scripts --no-save github:${product}hq/${product}#<sha>
`;
  return `# generated-workflow: ${PRE_LAYOUT_OWNERSHIP_FORMAT}\n` +
    `# generated-product: ${JSON.stringify(product)}\n` +
    `# generated-body-sha256: ${sha256(Buffer.from(body))}\n` +
    (install === "vendored" ? `# generated-tarball-sha256: ${tarballDigest}\n`
      : `# generated-registry-version: ${version}\n`) + body;
}

/** Layout documentation is part of the owned v3 bytes. Keep v2 byte-stable so
 * existing consumer workflows remain recognizable during migration/unwire. */
function renderCiWorkflowV3(options) {
  const layout = options.layout ?? LAYOUT;
  const lines = renderCiWorkflowV2(options).split("\n");
  const body = lines.slice(4).join("\n") + `\n# Project API memory: ${layout.readme}\n` +
    `# Committed knowledge: ${layout.context}; configuration: ${layout.environments}\n` +
    `# Private request evidence: ${layout.evidence}/ (ignored by ${layout.gitignore})\n`;
  lines[0] = `# generated-workflow: ${OWNERSHIP_FORMAT}`;
  lines[2] = `# generated-body-sha256: ${sha256(Buffer.from(body))}`;
  return `${lines.slice(0, 4).join("\n")}\n${body}`;
}

function legacyBodyDigest(body, product) {
  const values = new Map([
    [POINTER_CLI_NAME, { slot: "cli" }],
    [JSON.stringify(`./${posix(LEGACY_CI_TARBALL_REL)}`), { slot: "tarball" }],
    [product, { slot: "product" }],
  ]);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(${[...values.keys()].sort((a, b) => b.length - a.length).map(escape).join("|")})`, "g");
  // Keep literal input distinct from recognized slots: a consumer's literal
  // placeholder text must never impersonate a normalized template variable.
  const tokens = body.split(pattern).map((part, index) => index % 2 ? values.get(part) : part);
  return sha256(Buffer.from(JSON.stringify(tokens)));
}

/** A matching body hash proves integrity; the exact versioned body proves
 * template identity. Both are required before replacing/removing artifacts. */
export function inspectCiWorkflowOwnership(text, product = PRODUCT, { layout = LAYOUT } = {}) {
  const lines = String(text).split("\n");
  const format = /^# generated-workflow: (.+)$/.exec(lines[0])?.[1];
  if (![OWNERSHIP_FORMAT, PRE_LAYOUT_OWNERSHIP_FORMAT, LEGACY_OWNERSHIP_FORMAT].includes(format))
    return { owned: false, reason: "no recognised generated-workflow marker" };
  let recordedProduct;
  try { recordedProduct = JSON.parse(lines[1]?.replace(/^# generated-product: /, "")); }
  catch { return { owned: false, reason: "generated product marker is unreadable" }; }
  if (recordedProduct !== product || lines[1] !== `# generated-product: ${JSON.stringify(product)}`)
    return { owned: false, reason: "generated product marker belongs to a different product" };
  const bodyDigest = /^# generated-body-sha256: ([a-f0-9]{64})$/.exec(lines[2])?.[1];
  const tarballDigest = /^# generated-tarball-sha256: ([a-f0-9]{64})$/.exec(lines[3])?.[1];
  const version = /^# generated-registry-version: (.+)$/.exec(lines[3])?.[1];
  const install = tarballDigest ? "vendored" : "registry";
  if (!bodyDigest || (!tarballDigest && !version) || (format === LEGACY_OWNERSHIP_FORMAT && !tarballDigest))
    return { owned: false, reason: "generated ownership digests are missing or malformed" };
  const body = lines.slice(4).join("\n");
  if (sha256(Buffer.from(body)) !== bodyDigest)
    return { owned: false, reason: "generated workflow was edited locally" };
  if (format === LEGACY_OWNERSHIP_FORMAT) {
    if (legacyBodyDigest(body, product) !== LEGACY_BODY_DIGEST)
      return { owned: false, reason: "workflow does not match the generated v1 template" };
  } else {
    let expected;
    try { expected = format === PRE_LAYOUT_OWNERSHIP_FORMAT
      ? renderCiWorkflowV2({ product, packageName: NPM_PACKAGE, cli: POINTER_CLI_NAME,
        tarball: posix(LEGACY_CI_TARBALL_REL), tarballDigest, install, version })
      : renderCiWorkflow({ product, tarballDigest, install, version, layout,
        packageName: NPM_PACKAGE.replaceAll(PRODUCT, product), cli: POINTER_CLI_NAME.replaceAll(PRODUCT, product),
        tarball: posix(layout.ciTarball) }); }
    catch { return { owned: false, reason: "generated registry version is invalid" }; }
    if (String(text) !== expected)
      return { owned: false, reason: "workflow does not match the generated template" };
  }
  return { owned: true, install, ...(tarballDigest ? { tarballDigest } : { version }) };
}

/** Used by layout migration after conflict preflight. Existing generated
 * ownership is required; foreign and edited workflows remain project-owned. */
export function migrateCiWorkflowText(text, { priorLayouts = [] } = {}) {
  let ownership = inspectCiWorkflowOwnership(text);
  for (const prior of priorLayouts) {
    if (ownership.owned) break;
    if (![prior.product, prior.collection].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value))) continue;
    ownership = inspectCiWorkflowOwnership(text, prior.product, { layout: layoutFor(prior.product, prior.collection) });
  }
  if (!ownership.owned) return null;
  return renderCiWorkflow({ install: ownership.install,
    ...(ownership.tarballDigest ? { tarballDigest: ownership.tarballDigest }
      : { version: ownership.version }) });
}

/** Validate npm's exact pack manifest before any bytes approach the project.
 *
 * Whole-source secretIn scanning is deliberately NOT used: the guard's own JS
 * and ordinary identifiers such as `const secret = secretIn(...)` match that
 * broad free-text refusal. The alpha hygiene being reused here is containment:
 * npm's package allowlist, forbidden-path rejection, and tests that plant real
 * credential canaries in the target/evidence tree and prove none enter this
 * engine-root pack. Path NAMES can use secretIn without that self-match. */
export function validateCiPackManifest(info, packageRoot = ENGINE_ROOT) {
  if (!info || !Array.isArray(info.files) || !info.files.length)
    throw named("CI_PACK_UNSAFE", "The package manager returned no self-pack file manifest.");
  const paths = info.files.map((file) => String(file.path ?? ""));
  if (!paths.includes("package.json"))
    throw named("CI_PACK_UNSAFE", "The self-pack omits package.json.");
  for (const path of paths) {
    const dependency = isRuntimeDependencyPath(path);
    // Exact engine source exception; captured evidence remains forbidden.
    const evidenceModule = path === 'lib/evidence-confidence.mjs';
    const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
    if (!path || isAbsolute(path) || parts.includes("..") || resolve(packageRoot, path)
      .startsWith(`${resolve(packageRoot)}${sep}`) === false)
      throw named("CI_PACK_UNSAFE", "The self-pack manifest contains an unsafe path.");
    if ((!dependency && parts.some((part) => part.startsWith(".")))
      || parts.some((part) => (!evidenceModule && /^(?:evidence(?:-|$)|results$)/.test(part)) || (!dependency && part === 'node_modules'))
      || parts.some((part) => /\.env$|\.tgz$/i.test(part))
      || secretIn(path))
      throw named("CI_PACK_UNSAFE", "The self-pack manifest contains a forbidden artifact path.");
    const source = join(packageRoot, path);
    let stat;
    try { stat = lstatSync(source); }
    catch { throw named("CI_PACK_UNSAFE", "The self-pack manifest names a missing source file."); }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw named("CI_PACK_UNSAFE", "The self-pack manifest contains a non-regular source.");
    if (dependency && !verifyRuntimeDependency(path, readFileSync(source)))
      throw named('CI_PACK_UNSAFE', 'Bundled dependency bytes differ from their pinned inventory.');
  }
  try { validateRuntimeBundle(paths, packageRoot); }
  catch { throw named('CI_PACK_UNSAFE', 'The self-pack runtime dependency inventory is incomplete or changed.'); }
  return paths;
}

/** Pack this installed engine, never the repository being connected. npm's
 * stdout/stderr are captured so JSON connect output remains one document. */
export function buildCiTarball(packageRoot = ENGINE_ROOT) {
  const scratch = mkdtempSync(join(tmpdir(), "ci-engine-pack-"));
  try {
    let stdout;
    try {
      stdout = execFileSync("npm", ["pack", packageRoot, "--ignore-scripts", "--json",
        "--pack-destination", scratch],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      throw named("CI_PACK_FAILED", "Could not self-pack this installed engine.");
    }
    let packed;
    try { packed = JSON.parse(stdout)?.[0]; }
    catch { throw named("CI_PACK_FAILED", "The package manager returned an unreadable self-pack report."); }
    validateCiPackManifest(packed, packageRoot);
    const archive = join(scratch, basename(String(packed.filename ?? "")));
    if (!existsSync(archive))
      throw named("CI_PACK_FAILED", "The package manager reported no self-pack archive.");
    return readFileSync(archive);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function ciArtifactTargets(root, { legacy = false } = {}) {
  const tarball = legacy ? LEGACY_CI_TARBALL_REL : CI_TARBALL_REL;
  return {
    workflow: { path: CI_WORKFLOW_REL, absolute: join(root, CI_WORKFLOW_REL) },
    tarball: { path: tarball, absolute: join(root, tarball) },
  };
}

function nearestExisting(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function assertWritableDestination(target) {
  const parent = nearestExisting(dirname(target));
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o222) === 0)
    throw named("CI_ARTIFACT_WRITE_FAILED", "A CI artifact parent is not writable.");
  try { accessSync(parent, constants.W_OK); }
  catch { throw named("CI_ARTIFACT_WRITE_FAILED", "A CI artifact parent is not writable."); }
}

function absentDirs(parent, root) {
  const missing = [];
  let current = parent;
  while (current !== root && !existsSync(current)) {
    missing.push(current);
    current = dirname(current);
  }
  return missing.reverse();
}

function presence(path) {
  try { return { exists: true, stat: lstatSync(path) }; }
  catch (error) {
    if (error?.code === "ENOENT") return { exists: false, stat: null };
    return { exists: true, stat: null };
  }
}

/** Materialize an install or an explicitly requested mode transition. All
 * affected paths are preflighted and staged together; a failed write restores
 * the prior bytes. Same-mode differences remain conflicts, never upgrades. */
export function materializeCiArtifacts(root, { dryRun = false,
  pathProblem = () => null, packageRoot = ENGINE_ROOT,
  install = CI_INSTALL_DEFAULT, switchInstall = false } = {}) {
  validateInstall(install);
  const targets = ciArtifactTargets(root);
  for (const target of Object.values(targets)) {
    const unsafe = pathProblem(root, target.absolute);
    if (unsafe) throw named("CI_ARTIFACT_CONFLICT", "A CI artifact path is unsafe or linked.");
  }
  const current = {};
  for (const [kind, target] of Object.entries(targets)) {
    const found = presence(target.absolute);
    if (!found.exists) { current[kind] = null; continue; }
    if (!found.stat?.isFile() || found.stat.isSymbolicLink() || found.stat.nlink !== 1)
      throw named("CI_ARTIFACT_CONFLICT", `The existing CI ${kind} is not a regular, single-link file.`);
    try { current[kind] = readFileSync(target.absolute); }
    catch { throw named("CI_ARTIFACT_CONFLICT", `The existing CI ${kind} is unreadable.`); }
  }
  const ownership = current.workflow ? inspectCiWorkflowOwnership(current.workflow.toString("utf8")) : null;
  if (ownership && !ownership.owned)
    throw named("CI_ARTIFACT_CONFLICT", `The existing CI workflow was left untouched: ${ownership.reason}.`);
  const transition = ownership && ownership.install !== install
    ? `${ownership.install}-to-${install}` : null;
  if (transition && !switchInstall)
    throw named("CI_INSTALL_SWITCH_REQUIRED", `Changing CI install mode requires --install ${install} --switch-install; existing artifacts were left untouched.`);
  if (transition && ownership.install === "vendored"
    && (!current.tarball || sha256(current.tarball) !== ownership.tarballDigest))
    throw named("CI_ARTIFACT_CONFLICT", "The old workflow's exact digest-bound tarball is required for a mode switch; both artifacts were left untouched.");
  if (transition && ownership.install === "registry" && current.tarball)
    throw named("CI_ARTIFACT_CONFLICT", "The registry workflow does not own the existing tarball; it was left untouched.");

  // Registry generation never invokes npm, even during dry-run or a switch.
  const tarball = install === "vendored" ? buildCiTarball(packageRoot) : null;
  const wanted = { tarball, workflow: Buffer.from(renderCiWorkflow({ install,
    ...(tarball ? { tarballDigest: sha256(tarball) } : { version: engineVersion(packageRoot) }) })) };
  if (!transition && current.workflow && !current.workflow.equals(wanted.workflow))
    throw named("CI_ARTIFACT_CONFLICT", "The existing CI workflow differs and was left untouched.");
  if (install === "vendored" && current.tarball && !current.tarball.equals(wanted.tarball))
    throw named("CI_ARTIFACT_CONFLICT", "The existing CI tarball differs and was left untouched.");

  const changes = [];
  if (!current.workflow || transition) changes.push("workflow");
  if (install === "vendored" && !current.tarball) changes.push("tarball");
  if (transition && install === "registry") changes.push("tarball");
  for (const kind of changes) assertWritableDestination(targets[kind].absolute);
  const result = {
    install, ...(transition ? { transition } : {}),
    workflow: { path: targets.workflow.path, action: changes.includes("workflow")
      ? (dryRun ? "would write" : "wrote") : "unchanged" },
    tarball: { path: targets.tarball.path, action: install === "vendored"
      ? (changes.includes("tarball") ? (dryRun ? "would write" : "wrote") : "unchanged")
      : (transition ? (dryRun ? "would remove" : "removed") : (current.tarball ? "left" : "absent")),
    ...(transition && install === "registry"
      ? { reason: "The removed tarball matches the prior generated workflow's SHA-256 digest.",
        sha256: ownership.tarballDigest }
      : (install === "registry" && current.tarball ? { reason: "The registry workflow does not own this tarball." } : {})) },
  };
  if (dryRun || !changes.length) return result;

  const createdDirs = [...new Set(changes.filter((kind) => wanted[kind])
    .flatMap((kind) => absentDirs(dirname(targets[kind].absolute), root)))];
  const staged = [], saved = [], installed = [];
  try {
    for (const dir of createdDirs) mkdirSync(dir);
    for (const kind of changes) {
      const target = targets[kind].absolute;
      const nonce = `${process.pid}-${Date.now()}-${kind}`;
      if (wanted[kind]) {
        const temp = join(dirname(target), `.${basename(target)}.tmp-${nonce}`);
        // Acquire ownership before registering cleanup. A colliding file is
        // foreign; a partial write to our own new file must be rolled back.
        const fd = openSync(temp, "wx", 0o644);
        staged.push({ kind, temp });
        try { writeFileSync(fd, wanted[kind]); }
        finally { closeSync(fd); }
      }
      if (current[kind]) saved.push({ kind, bytes: current[kind],
        mode: lstatSync(target).mode & 0o777,
        backup: join(dirname(target), `.${basename(target)}.ci-switch-${nonce}`) });
    }
    // Refuse a changed destination before moving any original artifact.
    for (const kind of changes) {
      const target = targets[kind].absolute;
      const found = presence(target);
      if (current[kind] ? (!found.stat?.isFile() || found.stat.nlink !== 1
        || !readFileSync(target).equals(current[kind])) : found.exists)
        throw new Error("CI artifact changed while staging");
    }
    for (const item of saved) {
      if (presence(item.backup).exists) throw new Error("backup path already exists");
      renameSync(targets[item.kind].absolute, item.backup);
      item.moved = true;
    }
    for (const item of staged) {
      renameSync(item.temp, targets[item.kind].absolute);
      installed.push(item.kind);
    }
    for (const item of saved) unlinkSync(item.backup);
  } catch {
    for (const { temp } of staged) try { unlinkSync(temp); } catch { /* absent or renamed */ }
    for (const kind of installed) try { unlinkSync(targets[kind].absolute); } catch { /* restore below */ }
    for (const item of saved.filter((item) => item.moved)) {
      const target = targets[item.kind].absolute;
      try {
        if (presence(item.backup).exists) renameSync(item.backup, target);
        else if (!presence(target).exists) writeFileSync(target, item.bytes, { flag: "wx", mode: item.mode });
      } catch { /* preserve any remaining backup for recovery */ }
    }
    for (const dir of [...createdDirs].reverse()) try { rmdirSync(dir); } catch { /* non-empty or pre-existing */ }
    throw named("CI_ARTIFACT_WRITE_FAILED", "Could not materialize CI artifacts; the prior installation was preserved.");
  }
  if (transition && install === "registry") {
    try { rmdirSync(dirname(targets.tarball.absolute)); } catch { /* retain neighbours */ }
  }
  return result;
}

/** Plan explicit unwire using the workflow's self-verifying ownership record.
 * The tgz has no human-readable body, so its filename is never ownership: it
 * is removable only when a valid generated workflow binds its exact digest. */
export function planCiArtifactRemoval(root, { pathProblem = () => null } = {}) {
  let legacy = false;
  const workflow = ciArtifactTargets(root).workflow.absolute;
  if (!pathProblem(root, workflow)) {
    try {
      const text = readFileSync(workflow, "utf8");
      legacy = !text.startsWith(`# generated-workflow: ${OWNERSHIP_FORMAT}\n`)
        && inspectCiWorkflowOwnership(text).owned;
    } catch { /* unreadable ownership is handled by the removal plan below */ }
  }
  const targets = ciArtifactTargets(root, { legacy });
  const row = (kind, action, reason = null) => ({ path: targets[kind].path,
    absolute: targets[kind].absolute, action, ...(reason ? { reason } : {}) });
  const workflowExists = presence(targets.workflow.absolute).exists;
  const tarballExists = presence(targets.tarball.absolute).exists;

  const workflowUnsafe = workflowExists ? pathProblem(root, targets.workflow.absolute) : null;
  if (workflowUnsafe) return {
    workflow: row("workflow", "left", `${workflowUnsafe}; linked paths are not followed`),
    tarball: tarballExists
      ? row("tarball", "left", "workflow ownership is unsafe or ambiguous")
      : row("tarball", "absent"),
  };
  const tarballUnsafe = tarballExists ? pathProblem(root, targets.tarball.absolute) : null;
  if (tarballUnsafe) return {
    workflow: workflowExists
      ? row("workflow", "left", "tarball path is unsafe or linked; preserving the pair")
      : row("workflow", "absent"),
    tarball: row("tarball", "left", `${tarballUnsafe}; linked paths are not followed`),
  };
  if (!workflowExists) return {
    workflow: row("workflow", "absent"),
    tarball: tarballExists
      ? row("tarball", "left", "no generated workflow ownership record; filename alone is ambiguous")
      : row("tarball", "absent"),
  };
  let workflowText;
  try {
    if (!lstatSync(targets.workflow.absolute).isFile()) throw new Error("not regular");
    workflowText = readFileSync(targets.workflow.absolute, "utf8");
  } catch {
    return {
      workflow: row("workflow", "left", "workflow is unreadable or not a regular file"),
      tarball: tarballExists
        ? row("tarball", "left", "workflow ownership is unreadable or ambiguous")
        : row("tarball", "absent"),
    };
  }
  const ownership = inspectCiWorkflowOwnership(workflowText);
  if (!ownership.owned) return {
    workflow: row("workflow", "left", ownership.reason),
    tarball: tarballExists
      ? row("tarball", "left", "no intact generated workflow binds this tarball")
      : row("tarball", "absent"),
  };
  if (ownership.install === "registry") return {
    workflow: row("workflow", "removed"),
    tarball: tarballExists ? row("tarball", "left", "registry workflow does not own this tarball")
      : row("tarball", "absent"),
  };
  if (!tarballExists) return {
    workflow: row("workflow", "removed"), tarball: row("tarball", "absent"),
  };
  let bytes;
  try {
    if (!lstatSync(targets.tarball.absolute).isFile()) throw new Error("not regular");
    bytes = readFileSync(targets.tarball.absolute);
  } catch {
    return {
      workflow: row("workflow", "left", "bound tarball is unreadable; preserving the pair"),
      tarball: row("tarball", "left", "tarball is unreadable or not a regular file"),
    };
  }
  if (sha256(bytes) !== ownership.tarballDigest) return {
    workflow: row("workflow", "left", "bound tarball was edited; preserving the pair"),
    tarball: row("tarball", "left", "tarball bytes differ from the generated ownership record"),
  };
  return { workflow: row("workflow", "removed"), tarball: row("tarball", "removed") };
}

export function applyCiArtifactRemoval(plan) {
  const artifacts = [plan.workflow, plan.tarball].filter((row) => row.action === "removed");
  if (!artifacts.length) return plan;
  const leave = (reason) => {
    for (const artifact of artifacts) {
      artifact.action = "left";
      artifact.reason = reason;
    }
    return plan;
  };

  // Rename/unlink authority comes from the parent directory, not the file's
  // mode. Preflight the entire removal set so a read-only second parent cannot
  // turn an exact pair into a half-removal.
  try { for (const artifact of artifacts) assertWritableDestination(artifact.absolute); }
  catch { return leave("CI artifact parents are not all writable; preserving the generated pair"); }

  const saved = artifacts.map((artifact, index) => ({ artifact,
    bytes: readFileSync(artifact.absolute), mode: lstatSync(artifact.absolute).mode & 0o777,
    staged: join(dirname(artifact.absolute),
      `.${basename(artifact.absolute)}.unwire-${process.pid}-${Date.now()}-${index}`) }));
  const moved = [];
  try {
    for (const item of saved) {
      if (presence(item.staged).exists) throw new Error("staging path exists");
      renameSync(item.artifact.absolute, item.staged);
      moved.push(item);
    }
  } catch {
    for (const item of [...moved].reverse())
      try { renameSync(item.staged, item.artifact.absolute); } catch { /* preservation attempt below */ }
    for (const item of moved)
      if (!presence(item.artifact.absolute).exists)
        try { writeFileSync(item.artifact.absolute, item.bytes, { flag: "wx", mode: item.mode }); }
        catch { /* no overwrite: a concurrent writer owns the path now */ }
    return leave("CI pair could not be staged atomically; both artifacts were preserved");
  }

  try {
    for (const item of saved) unlinkSync(item.staged);
  } catch {
    // A successful stage made both original paths vacant. Reconstitute any
    // already-unlinked member from its saved bytes and rename the rest back.
    for (const item of saved) {
      if (presence(item.staged).exists) {
        try { renameSync(item.staged, item.artifact.absolute); } catch { /* preserve below */ }
      }
      if (!presence(item.artifact.absolute).exists)
        try { writeFileSync(item.artifact.absolute, item.bytes, { flag: "wx", mode: item.mode }); }
        catch { /* no overwrite: a concurrent writer owns the path now */ }
      try { if (presence(item.staged).exists) unlinkSync(item.staged); } catch { /* leave data, never delete more */ }
    }
    return leave("CI pair removal could not complete atomically; both artifacts were preserved");
  }
  return plan;
}

/** Remove only scaffolding emptied by an exact artifact removal. Neighbouring
 * workflows/vendor files make the directory non-empty and therefore owned by
 * the project, not cleanup. */
export function pruneCiArtifactDirs(root, plan, { pathProblem = () => null } = {}) {
  const candidates = [
    ...(plan.tarball.action === "removed" ? [dirname(plan.tarball.absolute)] : []),
    ...(plan.workflow.action === "removed"
      ? [join(root, ".github", "workflows"), join(root, ".github")] : []),
  ];
  const removed = [];
  for (const dir of candidates) {
    try {
      if (pathProblem(root, join(dir, ".ci-cleanup-safety-check"))) continue;
      if (!existsSync(dir) || readdirSync(dir).length) continue;
      rmdirSync(dir);
      removed.push(relative(root, dir));
    } catch { /* unreadable, non-empty, or already gone: preservation wins */ }
  }
  return removed;
}
