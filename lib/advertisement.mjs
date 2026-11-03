// Commands written into committed agent guidance need a stricter answer than
// "this process is running, so the command probably exists". A teammate reads
// those bytes in a clean shell later. Only the repo-relative npm shim can be
// portable across that boundary without npm; a package installed by npm can
// also name its exact registry version through npx. Shell aliases/functions are not a
// substitute: a slash-qualified path bypasses both, while trusting one would
// make committed guidance depend on the writer's startup shell.

import { constants, accessSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stableNodeCommand, versionedNodePath } from "./node-runtime.mjs";

import {
  MCP_SERVER_KEY, NPM_PACKAGE, POINTER_CLI_NAME, PRODUCT, TOOL_NAME,
} from "./brand.mjs";

export const PORTABLE_COMMAND_REMEDY =
  `Install this package in the repository so ${POINTER_CLI_NAME} exists and is executable, ` +
  "then re-run connect or the --agents command.";

const LIB = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(dirname(LIB), "bin", "cli.mjs");

/** Only npm-installed copies may advertise a registry fallback. A source
 * checkout can contain unpublished changes, so its version is not a promise
 * that npx retrieves those bytes. No package lookup or network call occurs. */
export function installedNpxCommand(packageRoot = dirname(LIB)) {
  if (!packageRoot.endsWith(`${sep}node_modules${sep}${NPM_PACKAGE.split('/').join(sep)}`)) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    if (pkg.name !== NPM_PACKAGE || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(pkg.version)) return null;
    return `npx --yes ${NPM_PACKAGE}@${pkg.version}`;
  } catch { return null; }
}

/** A cache directory is an implementation detail of npm, not an MCP binding.
 * Pin the installed version and let npm locate (or restore) those bytes. This
 * is a launch plan only; connect never runs npm or installs another package. */
export function installedMcpLaunch(packageRoot = dirname(LIB), { npxCommand, nodeCommand = stableNodeCommand() } = {}) {
  const invocation = installedNpxCommand(packageRoot);
  if (!invocation) return null;
  const spec = invocation.slice("npx --yes ".length);
  if (!npxCommand) {
    // Retain the public alias, never realpath(npx): Homebrew replaces the keg.
    // A bare command is preferable when no stable companion can be verified.
    const candidate = isAbsolute(nodeCommand) ? join(dirname(nodeCommand), process.platform === "win32" ? "npx.cmd" : "npx") : null;
    if (candidate && !versionedNodePath(candidate)) {
      try { accessSync(candidate, constants.X_OK); if (statSync(candidate).isFile()) npxCommand = candidate; }
      catch { /* The host must resolve npx from PATH. Doctor probes that path. */ }
    }
  }
  // npm and the package's bin both use `env node`. Keep their runtime search
  // path independent of a desktop host's sparse PATH without copying the
  // installing shell's private/volatile path entries into project config.
  const windowsRoot = process.env.SystemRoot ?? join(`${process.env.SystemDrive ?? 'C:'}${sep}`, 'Windows');
  const systemDirectories = process.platform === "win32"
    ? [join(windowsRoot, 'System32'), windowsRoot]
    : ['/usr/local/bin', '/usr/bin', '/bin'];
  const path = isAbsolute(nodeCommand) && !versionedNodePath(nodeCommand)
    ? [...new Set([dirname(nodeCommand), ...systemDirectories])].join(delimiter) : null;
  return { command: npxCommand ?? "npx",
    args: ["--yes", "--ignore-scripts", `--package=${spec}`, "--", PRODUCT, "mcp", "serve"],
    ...(path ? { env: { PATH: path } } : {}) };
}

/** Recognize only our exact immutable package launch grammar. A dist-tag,
 * extra flags, shell wrapper or different binary is not generated wiring. */
export function pinnedMcpPackage(entry) {
  if (!entry || !["npx", "npx.cmd"].includes(basename(entry.command ?? "")) ||
      !Array.isArray(entry.args) || entry.args.length !== 7 ||
      entry.args[0] !== "--yes" || entry.args[1] !== "--ignore-scripts" ||
      entry.args[3] !== "--" || entry.args[4] !== PRODUCT ||
      entry.args[5] !== "mcp" || entry.args[6] !== "serve") return null;
  const spec = entry.args[2];
  const prefix = `--package=${NPM_PACKAGE}@`;
  if (typeof spec !== "string" || !spec.startsWith(prefix) ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(spec.slice(prefix.length))) return null;
  return spec.slice("--package=".length);
}

function shellWord(value) {
  if (/^[A-Za-z0-9_./:\-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function portableProblem(path) {
  let link;
  try { link = lstatSync(path); }
  catch (error) {
    return error?.code === "ENOENT"
      ? "the repo-local portable CLI shim does not exist"
      : "the repo-local portable CLI shim cannot be inspected safely";
  }
  if (!link.isFile() && !link.isSymbolicLink())
    return "the repo-local portable CLI shim is not a regular file";
  let target;
  try { target = statSync(path); }
  catch {
    return "the repo-local portable CLI shim does not resolve to a regular file";
  }
  if (!target.isFile()) return "the repo-local portable CLI shim does not resolve to a regular file";
  try { accessSync(path, constants.X_OK); }
  catch { return "the repo-local portable CLI shim is not executable"; }
  return null;
}

/** A deterministic three-tier advertisement plan. It performs metadata checks
 * only: it never executes a candidate command or a shell startup file. */
export function advertisementPlan(root, env = process.env) {
  const portablePath = join(root, "node_modules", ".bin", PRODUCT);
  const problem = portableProblem(portablePath);
  const npx = problem ? installedNpxCommand() : null;
  const shadowing = [];
  if (Object.hasOwn(env, `BASH_FUNC_${PRODUCT}%%`)) shadowing.push("exported-function");
  // There is no portable environment representation for a shell alias. We do
  // not run an interactive shell to discover one; the slash-qualified command
  // bypasses aliases in any event. This is disclosed by doctor.
  return {
    mcp: { server: MCP_SERVER_KEY, tool: TOOL_NAME, available: true },
    portable: {
      command: npx ?? POINTER_CLI_NAME, path: npx ? null : portablePath, available: problem == null || npx != null,
      ...(npx ? { source: "npm-exact-version", may_download_package: true } : {}),
      ...(problem && !npx ? { reason: problem, remedy: PORTABLE_COMMAND_REMEDY } : {}),
    },
    // Share the registration's stable interpreter choice: a resolved Homebrew
    // Cellar path can disappear on upgrade even while its opt alias survives.
    // The package path remains machine-local, so this is terminal guidance,
    // never the command a teammate is told to copy from another installation.
    local: { command: `${shellWord(stableNodeCommand())} ${shellWord(CLI_ENTRY)}`, available: true },
    shadowing,
  };
}

export function commandOmission(surface, plan) {
  return {
    surface,
    command: plan.portable.command,
    reason: plan.portable.reason,
    remedy: plan.portable.remedy,
  };
}
