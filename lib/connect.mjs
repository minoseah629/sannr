// CONNECT — the wiring, as one command.
//
// The measured fact this exists for: a frontier agent does NOT pick this tool up
// on its own mid-task (F6c), but it honours a convention that a human wired in.
// So adoption is a HUMAN act, and every step of that act is a place a tester
// gets it wrong and concludes the product is broken. A hand-edited .mcp.json
// with a relative path silently never launches; a skill installed under the
// wrong directory name silently never loads; a per-host credential that lives
// only in the tester's shell is simply absent when the host spawns the server.
// Each of those reads as "the tool does not work" and none of them is a bug we
// would ever see. This module removes the hand edit.
//
// Three rules it does not bend:
//   MERGE, NEVER CLOBBER. The config belongs to the user; we own one key in it.
//     Anything we did not write and cannot recognise is a reported conflict with
//     the exact entry printed, not an overwrite.
//   PLAN, THEN WRITE. Every decision is computed as a plan (pure, testable, and
//     what --dry-run prints); the writing is a separate, dumb step. A dry run
//     that took a different code path would be a preview of a different command.
//   INSIDE THE PROJECT ONLY. Global agent config (~/.codex, ~/.claude.json) is
//     the user's machine, not their repo. Claude Code and Codex both have
//     project-scoped config, so those are the two unconditional targets.
//
// Pure functions here, I/O at the edges, so the CLI stays a thin caller.

import { existsSync, readFileSync, readdirSync, realpathSync, mkdirSync, writeFileSync, rmSync, rmdirSync,
  lstatSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, relative, sep } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MCP_SERVER_KEY, LEGACY_MCP_SERVER_KEYS, CLI_NAME, POINTER_CLI_NAME, PRODUCT, HOME_ENV_NAME, SKILL_NAMES, LEGACY_SKILL_NAMES, PROSE_PRODUCT_TITLE, COLLECTION, NPM_PACKAGE, FEEDBACK_BASE_URL, FEEDBACK_SEND_ENV } from "./brand.mjs";
import { stackCatalog } from './stacks.mjs';
import { SHIPPED_SKILL_DIGESTS } from "./shipped-skill-digests.mjs";
import { LAYOUT, LEGACY_LAYOUT, layoutFor } from "./layout.mjs";
import { authEnvVars, BUILTIN_DEFAULTS, projectConfigRoot } from "./config.mjs";
import { PORTABLE_COMMAND_REMEDY, advertisementPlan, installedNpxCommand, installedMcpLaunch, pinnedMcpPackage } from "./advertisement.mjs";
import { SETUP_BINDING_ENV, setupBindingId, validSetupBinding } from "./setup-binding.mjs";
import { stableNodeCommand } from "./node-runtime.mjs";
import { LIBRARIAN_MCP_SERVER_KEY, LIBRARIAN_NAME, librarianServerEntry,
  librarianTargets } from "./librarian.mjs";

const LIB = dirname(fileURLToPath(import.meta.url));
/** This installation's MCP server, absolute. Resolved from THIS file's location,
 *  so it is right whether the package sits in node_modules, a global prefix, or
 *  a git clone — and it keeps being right if the caller's cwd is anywhere. */
export const SERVER_PATH = join(dirname(LIB), "server.mjs");
/** The skills shipped with the package, the source for the install. */
export const SKILL_SOURCES = [
  join(dirname(LIB), "skill", "SKILL.md"),
  join(dirname(LIB), "skill", "write-context", "SKILL.md"),
  join(dirname(LIB), "skill", "feedback", "SKILL.md"),
];

/** Refuse project-managed paths that escape lexically or traverse a symlink.
 * A repository can commit `.codex`/`.agents` symlinks; following one would turn
 * a project-only connect/unwire into a write or deletion in a global/shared
 * directory. Check every existing component, including a symlink destination
 * file, without dereferencing it. */
export function projectPathProblem(root, target) {
  const base = resolve(root), dest = resolve(target);
  if (dest !== base && !dest.startsWith(`${base}${sep}`))
    return `${target} resolves outside the project root`;
  const parts = relative(base, dest).split(sep).filter(Boolean);
  let current = base;
  for (let i = 0; i < parts.length; i += 1) {
    current = join(current, parts[i]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      return `${relative(base, current)} cannot be inspected safely (${error?.code ?? "error"})`;
    }
    if (stat.isSymbolicLink())
      return `${relative(base, current)} is a symbolic link`;
    if (i < parts.length - 1 && !stat.isDirectory())
      return `${relative(base, current)} is not a directory`;
    if (i === parts.length - 1 && !stat.isFile())
      return `${relative(base, current)} is not a regular managed file`;
    if (i === parts.length - 1 && stat.nlink !== 1)
      return `${relative(base, current)} has multiple hard links`;
  }
  return null;
}

// --- the registration entry -------------------------------------------------

/**
 * The MCP server entry a host launches.
 *
 * npm installs use an immutable package invocation, independent of npm's cache
 * location. Source checkouts use an absolute server path and a stable Node
 * alias where available. Project/config paths remain machine-local: teammates
 * run `connect` after a clone instead of committing another machine's paths.
 *
 * API_CONFIG is the multi-credential half. The client routes per-host auth by
 * the request's origin off `hosts` in api-environments.json, so pinning the
 * config path is what makes ONE registration serve every declared host instead
 * of only the default base URL. Omitted when there is no config file, because
 * pointing API_CONFIG at a file that does not exist is a hard CONFIG_NOT_FOUND
 * on every call — strictly worse than the env-var fallback path.
 *
 * API_EVIDENCE is the SAME pin, and it was the one this originally missed.
 * `evidenceDir` defaults to "./evidence" and the client resolves it with no
 * base, i.e. against process.cwd() — the HOST's cwd. Every tools/call creates
 * that directory, so with the host spawned somewhere unwritable every call died
 * "ENOENT: mkdir '/evidence'" (reported to the agent as a transport failure, so
 * the tester blames their own API server), and with the host spawned somewhere
 * writable the call succeeded while depositing response bodies outside the
 * project, where the evidence id in the reply names a file the human cannot
 * find and `receipt`/`show` in the repo never see it. Pinning it absolute is
 * the fix that works everywhere; a `cwd` field on the entry is not, because it
 * is not part of the config shape every host reads, and a host that ignores it
 * would fail in exactly the silent way this exists to remove.
 */
export function serverEntry({ serverPath = SERVER_PATH, configPath = null,
  contextPath = null, evidencePath = null, contractPath = null,
  environmentName = null, baseUrl = null,
  stateHome = null, usageLog = null, nodePath = stableNodeCommand(),
  launch = serverPath === SERVER_PATH ? installedMcpLaunch() : null } = {}) {
  // Homebrew's resolved Cellar path vanishes on upgrade. Retain its verified
  // stable alias so a desktop host can launch without a login-shell PATH.
  const entry = launch ? { command: launch.command, args: [...launch.args] }
    : { command: nodePath, args: [serverPath] };
  const env = { ...(configPath ? { API_CONFIG: configPath } : {}),
                ...(environmentName ? { API_ENV: environmentName } : {}),
                ...(baseUrl ? { API_BASE_URL: baseUrl } : {}),
                ...(contextPath ? { API_CONTEXT_DIR: contextPath } : {}),
                ...(evidencePath ? { API_EVIDENCE: evidencePath } : {}),
                ...(contractPath != null ? { API_CONTRACT: contractPath } : {}),
                ...(stateHome ? { [HOME_ENV_NAME]: stateHome } : {}),
                ...(usageLog != null ? { API_USAGE_LOG: usageLog } : {}),
                ...(launch?.env ?? {}) };
  if (Object.keys(env).length) entry.env = env;
  return entry;
}

/**
 * The entry for THIS project: the one place the registration is composed, so
 * `connect` (which writes it) and `doctor` (which decides whether what is on
 * disk still matches) cannot disagree. Two constructions of the same entry is
 * how doctor starts reporting "registered with different settings" forever.
 *
 * The evidence dir follows the project's own resolved default (env > config
 * file `defaults` > built-in), made absolute against the repo root, so a
 * project that moved its evidence directory keeps it.
 */
function retainedProjectServer(root, serverPath) {
  if (typeof root !== 'string') return false;
  const localServer = join(root, 'node_modules', ...NPM_PACKAGE.split('/'), 'server.mjs');
  try {
    const actual = realpathSync(serverPath), base = realpathSync(root);
    return realpathSync(localServer) === actual && insidePath(base, actual) &&
      !/(?:^|[\\/])_npx[\\/]/.test(actual);
  } catch { return false; }
}

export function projectEntry(root, cfg = {}, opts = {}) {
  const { env = process.env, cwd = process.cwd(), configText, ...serverOpts } = opts;
  // A real repo-local dependency is already durable and works offline from
  // the supplied ZIP/tarball. Do not trade it for an unnecessary registry
  // lookup. A node_modules link into npm's disposable cache is not local.
  if (!Object.hasOwn(serverOpts, 'launch') && !Object.hasOwn(serverOpts, 'serverPath') &&
      retainedProjectServer(root, SERVER_PATH)) serverOpts.launch = null;
  // These are supported local storage overrides, not arbitrary shell settings.
  // Relative values already refer to the installing process's cwd in the
  // registry/client, including when setup runs from a project subdirectory.
  // Pin that same destination for hosts launched elsewhere. Do not serialize
  // credentials or the rest of the environment; unset paths keep runtime
  // defaults, and an explicitly empty usage log remains empty (no log writes).
  const explicitStacks = stackCatalog(root).stacks.length > 0;
  const stateHome = env[HOME_ENV_NAME];
  const usageLog = env.API_USAGE_LOG;
  const entry = serverEntry({
    configPath: explicitStacks ? null : cfg.file ?? null,
    environmentName: explicitStacks ? null : cfg.name ?? null,
    baseUrl: !explicitStacks && cfg.baseUrlOverride ? cfg.baseUrl : null,
    contextPath: root,
    evidencePath: resolve(root, explicitStacks ? LAYOUT.evidence : cfg.defaults?.evidenceDir ?? BUILTIN_DEFAULTS.evidenceDir),
    contractPath: explicitStacks ? null : cfg.contract === "" ? "" : cfg.contract ? resolve(root, cfg.contract) : null,
    stateHome: stateHome ? resolve(cwd, stateHome) : null,
    usageLog: usageLog == null || usageLog === "" ? usageLog : resolve(cwd, usageLog),
    ...serverOpts,
  });
  entry.env = { ...entry.env, [SETUP_BINDING_ENV]: setupBindingId(root, entry, { configText }) };
  return entry;
}

// --- hosts ------------------------------------------------------------------
//
// Two axes decide how a host is handled: is its config file inside the PROJECT
// (we may write it) and do we know its exact shape (we may generate it). Where
// either answer is no, we print the snippet — a guess at a host's schema that
// half-works is worse than a paste, because the user then debugs OUR output.

/** `mcpServers: { key: {command,args,env} }` — Claude Code, Cursor. */
const shapeMcpServers = {
  container: "mcpServers",
  entryFor: (entry) => entry,
};
/** `servers: { key: {type:"stdio",command,args,env} }` — VS Code / Copilot. */
const shapeServers = {
  container: "servers",
  entryFor: (entry) => ({ type: "stdio", ...entry }),
};

// Codex lets one MCP call poll for as long as five minutes, while Codex's host
// default is one minute. Keep a small allowance above the product's hard cap so
// the host never kills a valid wait_for just before the client can report it.
export const CODEX_TOOL_TIMEOUT_SEC = 330;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const codexMarkers = (key) => ({
  begin: `# ${key}:managed-mcp-begin`,
  end: `# ${key}:managed-mcp-end`,
});

function tomlString(value) { return JSON.stringify(String(value)); }

/** The exact Codex project block connect owns. Comments are ownership markers:
 * they let unwire remove precisely this block without parsing or reserialising
 * the user's unrelated TOML. */
export function codexServerBlock(entry, key = MCP_SERVER_KEY) {
  const { begin, end } = codexMarkers(key);
  const lines = [begin, `[mcp_servers.${key}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(", ")}]`];
  if (entry.env) {
    const env = Object.entries(entry.env)
      .map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(", ");
    lines.push(`env = { ${env} }`);
  }
  lines.push(`tool_timeout_sec = ${CODEX_TOOL_TIMEOUT_SEC}`,
    // api_request can execute reads and writes through the same MCP tool. A
    // host-level "auto" policy would therefore grant more authority than the
    // tool name alone can communicate. Keep Codex's approval UX conservative;
    // the runtime policy remains the final enforcement boundary.
    `default_tools_approval_mode = "prompt"`, end);
  return lines.join("\n");
}

/**
 * Which agents this project uses, and what we can do about each.
 *
 * Claude Code and Codex are unconditional: `.mcp.json` and `.codex/config.toml`
 * are their project-scoped conventions, and a repo with no agent config yet is
 * precisely the repo being onboarded.
 * The others are opt-IN by evidence — a `.cursor/` or `.vscode/` directory that
 * the user made. Writing a Cursor config into a repo that has never seen Cursor
 * is litter in someone else's project.
 */
export function mcpTargets(root, { home = homedir() } = {}) {
  void home; // retained as an option so older callers/tests do not break.
  const targets = [{
    id: "claude-code", label: "Claude Code", file: join(root, ".mcp.json"),
    format: "json", shape: shapeMcpServers, scope: "project", writable: true,
  }, {
    id: "codex", label: "Codex", file: join(root, ".codex", "config.toml"),
    format: "toml", shape: null, scope: "project", writable: true,
  }];
  if (existsSync(join(root, ".cursor")))
    targets.push({ id: "cursor", label: "Cursor", file: join(root, ".cursor", "mcp.json"),
      format: "json", shape: shapeMcpServers, scope: "project", writable: true });
  if (existsSync(join(root, ".vscode")))
    targets.push({ id: "vscode", label: "VS Code / Copilot", file: join(root, ".vscode", "mcp.json"),
      format: "json", shape: shapeServers, scope: "project", writable: true });
  return targets;
}

/** Claude custom-agent frontmatter can allowlist an MCP tool but cannot define
 * its server inline. This second project registration is therefore the runtime
 * half of the Claude librarian boundary; Codex carries the same entry inside
 * its own per-agent TOML and needs no extra project-global registration. */
export function librarianMcpRegistration(root, entry) {
  return {
    key: LIBRARIAN_MCP_SERVER_KEY,
    entry: librarianServerEntry(entry),
    target: { id: "claude-code-librarian", label: "Claude Code librarian",
      file: join(root, ".mcp.json"), format: "json", shape: shapeMcpServers,
      scope: "project", writable: true },
  };
}

// --- the merge plan ---------------------------------------------------------

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Is an existing entry one of OURS (any version of it)? The heuristic is
 *  narrow: a direct server.mjs or our exact immutable npm invocation. Anything else
 *  parked under our key belongs to someone else and is never touched. */
const looksLikeOurs = (e) =>
  Boolean(pinnedMcpPackage(e)) ||
  (Boolean(e) && Array.isArray(e.args) && e.args.some((a) => typeof a === "string" && a.endsWith("server.mjs")));

const directServerLaunch = (entry) => Array.isArray(entry?.args) && entry.args.length === 1 &&
  typeof entry.args[0] === "string" && isAbsolute(entry.args[0]) && entry.args[0].endsWith(`${sep}server.mjs`);

/** Recognition for the 2026-10-06 server-key migration is deliberately stricter
 * than a filename heuristic. Earlier releases wrote only these launch fields
 * and repository-bound paths. An added flag, environment key or host setting
 * is a local edit, even if it still launches the same server. The old Node
 * executable and package path need not exist: Homebrew/npx may have removed
 * them already, and ownership never executes them. */
function ownedLegacyEntry(entry, expected, { stdio = false } = {}) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      Object.keys(entry).some(key => !["command", "args", "env", ...(stdio ? ["type"] : [])].includes(key)) ||
      (stdio && entry.type !== "stdio") ||
      typeof entry.command !== "string" ||
      (!pinnedMcpPackage(entry) && !(directServerLaunch(entry) &&
        /(?:^|[\\/])node(?:\.exe)?$/.test(entry.command)))) return false;
  const env = entry.env, root = expected?.env?.API_CONTEXT_DIR;
  if (!env || typeof env !== "object" || Array.isArray(env) || !root ||
      env.API_CONTEXT_DIR !== root || Object.values(env).some(value => typeof value !== "string")) return false;
  const keys = new Set(["API_CONFIG", "API_CONTEXT_DIR", "API_EVIDENCE", "API_CONTRACT",
    "API_ENV", "API_BASE_URL", HOME_ENV_NAME, "API_USAGE_LOG", "PATH", SETUP_BINDING_ENV]);
  if (Object.keys(env).some(key => !keys.has(key))) return false;
  if (env[SETUP_BINDING_ENV] !== undefined && !validSetupBinding(env[SETUP_BINDING_ENV])) return false;
  if (env[SETUP_BINDING_ENV] === undefined &&
      !["API_CONFIG", "API_CONTEXT_DIR", "API_EVIDENCE"].every(key => typeof env[key] === "string")) return false;
  for (const key of ["API_CONFIG", "API_EVIDENCE", "API_CONTRACT"])
    if (env[key] !== undefined && env[key] !== "" &&
        (!isAbsolute(env[key]) || !insidePath(root, env[key]))) return false;
  for (const key of [HOME_ENV_NAME, "API_USAGE_LOG", "PATH", "API_BASE_URL"])
    if (env[key] !== undefined && env[key] !== expected.env?.[key]) return false;
  return true;
}

function legacyConflict(target, entry, key, extra = {}) {
  return { action: "conflict", entry, registered: true, registeredKey: key,
    currentServerPath: null, currentCommand: null,
    reason: `${target.file} has a locally different legacy server under "${key}"; it was preserved.`,
    fix: `Review the named legacy entry before re-running \`${CLI_NAME} connect\`; connect will not create a second server.`, ...extra };
}

/** The actual keys on disk are report metadata, not evidence that a host
 * activated the server. Doctor uses them even before a migration is accepted. */
function registrationKeys(text, target, key) {
  const candidates = key === MCP_SERVER_KEY ? [key, ...LEGACY_MCP_SERVER_KEYS] : [key];
  if (text == null) return [];
  if (target.format === "toml") return candidates.filter(candidate =>
    codexDefinitions(text, candidate).length || managedRange(text, candidate));
  try {
    const servers = JSON.parse(text)?.[target.shape.container];
    return candidates.filter(candidate => servers && Object.hasOwn(servers, candidate));
  } catch { return []; }
}

/** Snapshot the launch binding written by an earlier connect before removing
 * it. Restricted legacy artifacts must be compared with that installation,
 * not today's npm cache path, Node alias or shell environment. The setup marker
 * is an identity hint, not an authorization token; the restricted entry and
 * agent body still have to match their exact generated form. Do not inspect or
 * execute the old package: it may already have been deleted. */
export function installedProjectEntry(root) {
  const path = join(root, ".mcp.json");
  if (projectPathProblem(root, path)) return null;
  try {
    const servers = JSON.parse(readFileSync(path, "utf8"))?.mcpServers;
    const entry = [MCP_SERVER_KEY, ...LEGACY_MCP_SERVER_KEYS].map(key => servers?.[key]).find(Boolean);
    if (!entry || Object.keys(entry).some(key => !["command", "args", "env"].includes(key)) ||
        typeof entry.command !== "string" || !entry.command ||
        (!directServerLaunch(entry) && !pinnedMcpPackage(entry)) ||
        !entry.env || Array.isArray(entry.env) || typeof entry.env !== "object" ||
        entry.env.API_CONTEXT_DIR !== resolve(root) ||
        !validSetupBinding(entry.env[SETUP_BINDING_ENV])) return null;
    return entry;
  } catch { return null; }
}

/**
 * Decide what to do with one host's config file, without touching it.
 *
 * Actions: create | merge | update | unchanged | conflict. `conflict` NEVER
 * writes and always carries the reason plus the entry to paste, because the one
 * unforgivable outcome here is a user's working MCP config replaced by ours.
 *
 * @param {string|null} existingText  the file's current contents, or null
 * @param {object} target             from mcpTargets()
 * @param {object} entry              from serverEntry()
 * @param {string} key                the server key (brand.MCP_SERVER_KEY)
 */
export function planTarget(existingText, target, entry, key = MCP_SERVER_KEY) {
  const registeredKeys = registrationKeys(existingText, target, key);
  const plan = target.format === "toml" ? planCodexTarget(existingText, target, entry, key)
    : planJsonTarget(existingText, target, entry, key);
  return { ...plan, registeredKeys, registeredKey: registeredKeys.includes(key) ? key : registeredKeys[0] ?? null };
}

function planJsonTarget(existingText, target, entry, key) {
  const shaped = target.shape.entryFor(entry);
  const container = target.shape.container;
  const fresh = { [container]: { [key]: shaped } };

  if (existingText == null)
    return { action: "create", text: `${JSON.stringify(fresh, null, 2)}\n`, entry: shaped,
      registered: false, currentServerPath: null, currentCommand: null };

  let doc;
  try { doc = JSON.parse(existingText); }
  catch (e) {
    // Unparseable: we cannot merge into it and we will not replace it. The user
    // has a broken file and now knows, with the entry to add once they fix it.
    return { action: "conflict", entry: shaped, registered: false, currentServerPath: null, currentCommand: null,
      reason: `${target.file} is not valid JSON (${String(e.message).slice(0, 80)}), so it cannot be merged into.`,
      fix: `Fix the JSON, then re-run \`${CLI_NAME} connect\` — or add this entry under "${container}" by hand.` };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc))
    return { action: "conflict", entry: shaped, registered: false, currentServerPath: null, currentCommand: null,
      reason: `${target.file} is not a JSON object.`,
      fix: `Replace it with an object containing "${container}", or add this entry by hand.` };

  const servers = doc[container];
  if (servers !== undefined && (servers === null || typeof servers !== "object" || Array.isArray(servers)))
    return { action: "conflict", entry: shaped, registered: false, currentServerPath: null, currentCommand: null,
      reason: `${target.file} has a "${container}" that is not an object.`,
      fix: `Make "${container}" an object, then re-run \`${CLI_NAME} connect\`.` };

  const legacyKeys = key === MCP_SERVER_KEY
    ? LEGACY_MCP_SERVER_KEYS.filter(legacy => servers && Object.hasOwn(servers, legacy)) : [];
  for (const legacy of legacyKeys)
    if (!ownedLegacyEntry(servers[legacy], entry, { stdio: target.shape === shapeServers }))
      return legacyConflict(target, shaped, legacy, {
        currentServerPath: servers[legacy]?.args?.find?.(arg => typeof arg === "string" && arg.endsWith("server.mjs")) ?? null,
        currentCommand: servers[legacy]?.command ?? null });
  const current = servers?.[key];
  const currentServerPath = current?.args?.find?.((a) => typeof a === "string" && a.endsWith("server.mjs")) ?? null;
  const currentCommand = typeof current?.command === "string" ? current.command : null;
  if (current && key === LIBRARIAN_MCP_SERVER_KEY && !deepEqual(current, shaped))
    return { action: "conflict", entry: shaped, registered: true,
      currentServerPath, currentCommand,
      reason: `${target.file} has a locally different restricted librarian entry under "${key}".`,
      fix: `Review that security-boundary edit explicitly; restore the generated entry before re-running \`${CLI_NAME} connect\`.` };
  if (current && key !== LIBRARIAN_MCP_SERVER_KEY && !looksLikeOurs(current))
    return { action: "conflict", entry: shaped, registered: true, currentServerPath, currentCommand,
      reason: `${target.file} already registers a DIFFERENT server under "${key}" ` +
              `(${current.command ?? "?"} ${(current.args ?? []).join(" ")}).`,
      fix: `Rename that server, or replace its entry under "${container}"."${key}" with the one below.` };
  if (current && deepEqual(current, shaped) && !legacyKeys.length)
    return { action: "unchanged", text: existingText, entry: shaped,
      registered: true, currentServerPath, currentCommand };

  // Merge: rebuild with our key set, every other key and every sibling field
  // (comments-as-fields, unrelated top-level settings) carried through by spread.
  const remaining = { ...(servers ?? {}) };
  for (const legacy of legacyKeys) delete remaining[legacy];
  const merged = { ...doc, [container]: { ...remaining, [key]: shaped } };
  return { action: current || legacyKeys.length ? "update" : "merge",
    text: `${JSON.stringify(merged, null, 2)}\n`, entry: shaped,
    registered: Boolean(current || legacyKeys.length), currentServerPath, currentCommand };
}

/** Repair generated launch details and their setup identity, preserving all
 * non-launch settings. An old npm cache entry may be gone: recognize its exact
 * package path grammar without reading or executing that vanished package. */
export function planRuntimeRepair(existingText, target, entry) {
  const plan = planTarget(existingText, target, entry);
  if (!plan.registered || plan.action === 'unchanged' || plan.action === 'conflict')
    return { action: 'unchanged' };
  if (plan.registeredKeys?.some(key => LEGACY_MCP_SERVER_KEYS.includes(key))) {
    // The complete legacy entry has passed the strict generated-shape check.
    // Do not rewrite old project paths before the explicit layout migration.
    if (!existsSync(join(entry.env?.API_CONTEXT_DIR ?? "", LAYOUT.marker)))
      return { action: "refused", reason: "legacy registration needs project migration before repair" };
    return { action: "repair", text: plan.text, previousCommand: plan.currentCommand,
      command: entry.command, args: [...entry.args], durable: Boolean(pinnedMcpPackage(entry)) };
  }
  const refuse = () => ({ action: 'refused', reason: 'registration has other changes; runtime-only repair preserved it' });
  let current;
  if (target.format === 'toml') {
    const managed = managedRange(existingText, MCP_SERVER_KEY);
    if (!managed || managed.malformed) return refuse();
    const args = /^args = (\[[^\n]*\])$/m.exec(managed.text)?.[1];
    const binding = /"API_SETUP_BINDING"\s*=\s*("(?:\\.|[^"\\])*")/.exec(managed.text)?.[1];
    const path = /"PATH"\s*=\s*("(?:\\.|[^"\\])*")/.exec(managed.text)?.[1];
    try { current = { command: commandFromToml(managed.text), args: JSON.parse(args),
      env: { [SETUP_BINDING_ENV]: JSON.parse(binding), ...(path ? { PATH: JSON.parse(path) } : {}) } }; }
    catch { return refuse(); }
  } else current = JSON.parse(existingText)[target.shape.container][MCP_SERVER_KEY];
  if (!validSetupBinding(current.env?.[SETUP_BINDING_ENV])) return refuse();
  const nodeLaunch = directServerLaunch(current) && /(?:^|[\\/])node(?:\.exe)?$/.test(current.command ?? '');
  const pinned = pinnedMcpPackage(current);
  if (!nodeLaunch && !pinned) return refuse();
  if (pinned && current.command !== entry.command && !['npx', 'npx.cmd'].includes(current.command)) return refuse();
  // Adding our narrowly generated Node PATH is a launch migration. Replacing
  // an existing different PATH could change user tooling and is never repair.
  if (current.env.PATH !== undefined && current.env.PATH !== entry.env?.PATH) return refuse();
  const addPath = current.env.PATH === undefined && entry.env?.PATH !== undefined;
  const sameArguments = deepEqual(current.args, entry.args);
  const npmServerSuffix = `/node_modules/${NPM_PACKAGE}/server.mjs`;
  const cachePath = directServerLaunch(current) ? current.args[0].replaceAll('\\', '/') : '';
  const cachedPackage = cachePath.endsWith(npmServerSuffix) &&
    /(?:^|\/)_npx\/[^/]+$/.test(cachePath.slice(0, -npmServerSuffix.length)) && nodeLaunch;
  // An existing exact-version launch may move to the version the user is
  // explicitly running for repair. Tags and custom invocation flags never do.
  const retainedLocal = directServerLaunch(entry) && retainedProjectServer(entry.env?.API_CONTEXT_DIR, entry.args[0]);
  const canMigrate = (Boolean(pinnedMcpPackage(entry)) && (cachedPackage || Boolean(pinned))) ||
    (retainedLocal && cachedPackage);
  if (!sameArguments && !canMigrate) return refuse();
  if (sameArguments && current.command === entry.command && !addPath) return { action: 'unchanged' };
  let text;
  if (target.format === 'toml') {
    const managed = managedRange(existingText, MCP_SERVER_KEY);
    if (!managed || managed.malformed) return refuse();
    let block = managed.text
      .replace(/^(\s*command\s*=\s*)"(?:\\.|[^"\\])*"/m,
        (_, prefix) => prefix + JSON.stringify(entry.command))
      .replace(/^args = \[[^\n]*\]$/m,
        () => `args = [${entry.args.map(tomlString).join(', ')}]`)
      .replace(/("API_SETUP_BINDING"\s*=\s*)"(?:\\.|[^"\\])*"/,
        (_, prefix) => prefix + JSON.stringify(entry.env[SETUP_BINDING_ENV]));
    if (addPath) block = block.replace('"API_SETUP_BINDING" = ',
      () => `"PATH" = ${tomlString(entry.env.PATH)}, "API_SETUP_BINDING" = `);
    text = existingText.slice(0, managed.start) + block + existingText.slice(managed.end);
  } else {
    const doc = JSON.parse(existingText);
    const current = doc[target.shape.container][MCP_SERVER_KEY];
    current.command = entry.command;
    current.args = [...entry.args];
    current.env = { ...Object.fromEntries(Object.entries(current.env).filter(([key]) => key !== SETUP_BINDING_ENV)),
      ...(addPath ? { PATH: entry.env.PATH } : {}), [SETUP_BINDING_ENV]: entry.env[SETUP_BINDING_ENV] };
    text = JSON.stringify(doc, null, 2) + '\n';
  }
  // The expected generated entry must now match exactly. This excludes changed
  // arguments, env, approval policy, timeout, cwd and noncanonical TOML edits.
  if (planTarget(text, target, entry).action !== 'unchanged') return refuse();
  return { action: 'repair', text, previousCommand: plan.currentCommand, command: entry.command,
    previousArgs: current.args, args: [...entry.args], durable: Boolean(pinnedMcpPackage(entry)) };
}

function managedRange(text, key) {
  const { begin, end } = codexMarkers(key);
  // Ownership markers count only as exact, standalone lines. A marker-shaped
  // substring inside a user's TOML string is just their content and must never
  // become an instruction to delete a range of their file. They must also be
  // top-level comments, not comments embedded in a multiline array/inline
  // table. The lexical scan deliberately preserves byte offsets.
  const matches = (marker) => standaloneTomlComments(text, marker);
  const begins = matches(begin), ends = matches(end);
  if (!begins.length && !ends.length) return null;
  if (begins.length !== 1 || ends.length !== 1 || ends[0].index < begins[0].index)
    return { malformed: true };
  const start = begins[0].index;
  const finish = ends[0].index + ends[0].length;
  const after = text[finish] === "\n" ? finish + 1 : finish;
  return { start, end: after, text: text.slice(start, after) };
}

function standaloneTomlComments(text, marker) {
  const found = [];
  let mode = null, escaped = false, square = 0, curly = 0, lineStart = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (i === lineStart) {
      const newline = text.indexOf("\n", i);
      const end = newline < 0 ? text.length : newline;
      const raw = text.slice(i, end);
      if (mode === null && square === 0 && curly === 0 && raw.replace(/\r$/, "").trim() === marker)
        found.push({ index: i, length: raw.length });
    }
    const c = text[i], three = text.slice(i, i + 3);
    if (mode === "comment") {
      if (c === "\n") mode = null;
    } else if (mode === "multi-basic") {
      if (three === '\"\"\"' && text[i - 1] !== "\\") { mode = null; i += 2; }
    } else if (mode === "multi-literal") {
      if (three === "'''") { mode = null; i += 2; }
    } else if (mode === "basic") {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') mode = null;
    } else if (mode === "literal") {
      if (c === "'") mode = null;
    } else if (c === "#") mode = "comment";
    else if (three === '\"\"\"') { mode = "multi-basic"; i += 2; }
    else if (three === "'''") { mode = "multi-literal"; i += 2; }
    else if (c === '"') mode = "basic";
    else if (c === "'") mode = "literal";
    else if (c === "[") square += 1;
    else if (c === "]") square = Math.max(0, square - 1);
    else if (c === "{") curly += 1;
    else if (c === "}") curly = Math.max(0, curly - 1);
    if (c === "\n") lineStart = i + 1;
  }
  return found;
}

function tomlCode(line) {
  let quote = null, escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quote = null;
    } else if (quote === "'") {
      if (c === "'") quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return line.slice(0, i);
  }
  return line;
}

function codexDefinitions(text, key) {
  text = decodeTomlUnicodeEscapes(text);
  const found = [];
  let inMcpRoot = false;
  const segment = (value) => `(?:${escapeRe(value)}|"${escapeRe(value)}"|'${escapeRe(value)}')`;
  const root = segment("mcp_servers"), keyed = segment(key);
  const directTable = new RegExp(`^\\s*\\[\\[?\\s*${root}\\s*\\.\\s*${keyed}(?:\\s*\\.|\\s*\\]\\]?)`);
  const rootTable = new RegExp(`^\\s*\\[\\s*${root}\\s*\\]\\s*$`);
  const anyTable = /^\s*\[\[?[^\]]+\]\]?\s*$/;
  const rootKey = new RegExp(`^\\s*${keyed}\\s*=`);
  const dotted = new RegExp(`^\\s*${root}\\s*\\.\\s*${keyed}(?:\\s*\\.|\\s*=)`);
  for (const raw of text.split("\n")) {
    const line = tomlCode(raw).trimEnd();
    if (directTable.test(line)) found.push(raw);
    if (rootTable.test(line)) { inMcpRoot = true; continue; }
    if (anyTable.test(line)) { inMcpRoot = false; continue; }
    if (dotted.test(line) || (inMcpRoot && rootKey.test(line))) found.push(raw);
  }
  return found;
}

function decodeTomlUnicodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g,
    (raw, short, long) => {
      try {
        const point = Number.parseInt(short ?? long, 16);
        return point <= 0x10ffff ? String.fromCodePoint(point) : raw;
      } catch { return raw; }
    });
}

function codexSealedRoot(text) {
  text = decodeTomlUnicodeEscapes(text);
  const root = `(?:mcp_servers|"mcp_servers"|'mcp_servers')`;
  const assignment = new RegExp(`^\\s*${root}\\s*=\\s*\\{`);
  return text.split("\n").some((raw) => assignment.test(tomlCode(raw)));
}

// A quoted/escaped form the small structural recogniser does not understand is
// still a collision, never permission to append. False positives produce a
// repairable conflict; a false negative can make a valid Codex config invalid.
function possibleCodexTargetReference(text, key) {
  const decoded = decodeTomlUnicodeEscapes(text);
  return decoded.includes("mcp_servers") && decoded.includes(key);
}

// This is intentionally a structural sanity check, not a second TOML parser.
// It catches the malformed files connect can identify without a dependency:
// unterminated strings and unbalanced arrays/inline tables. Valid multiline
// strings are tracked so ordinary Codex config is not rejected.
function tomlStructureProblem(text) {
  let mode = null, escaped = false, square = 0, curly = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i], three = text.slice(i, i + 3);
    if (mode === "comment") { if (c === "\n") mode = null; continue; }
    if (mode === "multi-basic") {
      if (three === '\"\"\"' && text[i - 1] !== "\\") { mode = null; i += 2; }
      continue;
    }
    if (mode === "multi-literal") {
      if (three === "'''") { mode = null; i += 2; }
      continue;
    }
    if (mode === "basic") {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') mode = null;
      else if (c === "\n") return "unterminated quoted string";
      continue;
    }
    if (mode === "literal") {
      if (c === "'") mode = null;
      else if (c === "\n") return "unterminated quoted string";
      continue;
    }
    if (c === "#") { mode = "comment"; continue; }
    if (three === '\"\"\"') { mode = "multi-basic"; i += 2; continue; }
    if (three === "'''") { mode = "multi-literal"; i += 2; continue; }
    if (c === '"') { mode = "basic"; continue; }
    if (c === "'") { mode = "literal"; continue; }
    if (c === "[") square += 1;
    else if (c === "]") square -= 1;
    else if (c === "{") curly += 1;
    else if (c === "}") curly -= 1;
    if (square < 0 || curly < 0) return "unbalanced bracket";
  }
  if (mode && mode !== "comment") return "unterminated quoted string";
  if (square || curly) return "unbalanced bracket";
  return null;
}

function serverPathFromToml(section) {
  const assignment = /^\s*args\s*=\s*\[/m.exec(section);
  if (!assignment) return null;
  const open = assignment.index + assignment[0].lastIndexOf("[");
  const values = [];
  let mode = null, escaped = false, value = "";
  for (let i = open + 1; i < section.length; i += 1) {
    const c = section[i];
    if (mode === "comment") {
      if (c === "\n") mode = null;
      continue;
    }
    if (mode === "basic") {
      value += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') {
        try { values.push(JSON.parse(value)); } catch { return null; }
        value = ""; mode = null;
      }
      continue;
    }
    if (mode === "literal") {
      if (c === "'") { values.push(value); value = ""; mode = null; }
      else value += c;
      continue;
    }
    if (c === "#") mode = "comment";
    else if (c === '"') { mode = "basic"; value = '"'; }
    else if (c === "'") { mode = "literal"; value = ""; }
    else if (c === "]")
      return values.find((a) => a.endsWith("server.mjs")) ?? null;
    else if (!/[\s,]/.test(c)) return null;
  }
  return null;
}

function commandFromToml(section) {
  const value = /^\s*command\s*=\s*("(?:\\.|[^"\\])*")\s*(?:#.*)?$/m.exec(section)?.[1];
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function appendBlock(text, block) {
  if (!text) return `${block}\n`;
  return `${text.replace(/\s*$/, "")}\n\n${block}\n`;
}

function generatedEntryFromCodex(text, key) {
  try {
    const command = commandFromToml(text);
    const args = JSON.parse(/^args = (\[[^\n]*\])$/m.exec(text)?.[1]);
    const inline = /^env = (\{[^\n]*\})$/m.exec(text)?.[1];
    const env = inline === undefined ? undefined : JSON.parse(inline.replace(/("(?:\\.|[^"\\])*")\s*=/g, "$1:"));
    const entry = { command, args, ...(env ? { env } : {}) };
    // Every earlier shipped Codex block used this exact shape and settings.
    // Marker presence alone does not authorize overwriting a custom setting.
    return text === codexServerBlock(entry, key) + "\n" ? entry : null;
  } catch { return null; }
}

/** Plan a surgical Codex TOML edit. We never reserialize the document. Only a
 * block carrying our exact marker lines is ours; unmarked definitions remain
 * user-owned even when they happen to launch a file named server.mjs. */
export function planCodexTarget(existingText, target, entry, key = MCP_SERVER_KEY) {
  const block = codexServerBlock(entry, key);
  if (existingText == null)
    return { action: "create", text: `${block}\n`, entry, registered: false,
      currentServerPath: null, currentCommand: null };

  if (key === MCP_SERVER_KEY) {
    for (const legacy of LEGACY_MCP_SERVER_KEYS) {
      const old = managedRange(existingText, legacy);
      if (!old && !codexDefinitions(existingText, legacy).length && !possibleCodexTargetReference(existingText, legacy)) continue;
      if (!old || old.malformed || tomlStructureProblem(existingText)) return legacyConflict(target, entry, legacy);
      const outside = existingText.slice(0, old.start) + existingText.slice(old.end);
      if (codexDefinitions(old.text, legacy).length !== 1 || codexDefinitions(outside, legacy).length ||
          possibleCodexTargetReference(outside, legacy) || codexSealedRoot(outside))
        return legacyConflict(target, entry, legacy);
      const previous = generatedEntryFromCodex(old.text, legacy);
      if (!previous || !ownedLegacyEntry(previous, entry)) return legacyConflict(target, entry, legacy);
      const replacement = planCodexTarget(outside, target, entry, key);
      if (replacement.action === "conflict") return replacement;
      // Replace in place when no current-key block exists; otherwise the current
      // block is updated and the recognized duplicate legacy block is removed.
      const text = registrationKeys(outside, target, key).length ? replacement.text
        : existingText.slice(0, old.start) + codexServerBlock(entry, key) + "\n" + existingText.slice(old.end);
      return { ...replacement, action: "update", text, registered: true,
        currentServerPath: directServerLaunch(previous) ? previous.args[0] : null,
        currentCommand: previous.command };
    }
  }

  const managed = managedRange(existingText, key);
  if (managed?.malformed)
    return { action: "conflict", entry, registered: true, currentServerPath: null, currentCommand: null,
      reason: `${target.file} has an incomplete managed block for "${key}".`,
      fix: `Repair or remove the ${key}:managed-mcp markers, then re-run \`${CLI_NAME} connect\`.` };
  const structureProblem = tomlStructureProblem(existingText);
  if (structureProblem)
    return { action: "conflict", entry, registered: Boolean(managed), currentServerPath: null, currentCommand: null,
      reason: `${target.file} is not structurally valid TOML (${structureProblem}), so it cannot be merged safely.`,
      fix: `Fix the TOML, then re-run \`${CLI_NAME} connect\`.` };
  if (managed) {
    const ownedDefinitions = codexDefinitions(managed.text, key);
    if (ownedDefinitions.length !== 1)
      return { action: "conflict", entry, registered: true,
        currentServerPath: serverPathFromToml(managed.text),
        currentCommand: commandFromToml(managed.text),
        reason: `${target.file} has ownership markers without exactly one managed "${key}" table.`,
        fix: `Repair or remove the managed block, then re-run \`${CLI_NAME} connect\`.` };
    const outside = `${existingText.slice(0, managed.start)}${existingText.slice(managed.end)}`;
    if (codexDefinitions(outside, key).length || possibleCodexTargetReference(outside, key) ||
        codexSealedRoot(outside))
      return { action: "conflict", entry, registered: true,
        currentServerPath: serverPathFromToml(managed.text),
        currentCommand: commandFromToml(managed.text),
        reason: `${target.file} defines "${key}" outside its managed block too.`,
        fix: `Remove the duplicate definition, then re-run \`${CLI_NAME} connect\`.` };
    const canonical = `${block}\n`;
    if (managed.text === canonical)
      return { action: "unchanged", text: existingText, entry, registered: true,
        currentServerPath: serverPathFromToml(managed.text),
        currentCommand: commandFromToml(managed.text) };
    return { action: "update",
      text: `${existingText.slice(0, managed.start)}${canonical}${existingText.slice(managed.end)}`,
      entry, registered: true, currentServerPath: serverPathFromToml(managed.text),
      currentCommand: commandFromToml(managed.text) };
  }

  if (codexDefinitions(existingText, key).length || possibleCodexTargetReference(existingText, key))
    return { action: "conflict", entry, registered: true, currentServerPath: null, currentCommand: null,
      reason: `${target.file} already defines an unmarked "${key}" server that connect does not own.`,
      fix: `Remove or rename that entry, then re-run \`${CLI_NAME} connect\` — or keep it and do not let connect manage Codex.` };

  if (codexSealedRoot(existingText))
    return { action: "conflict", entry, registered: false, currentServerPath: null, currentCommand: null,
      reason: `${target.file} defines mcp_servers as an inline table, which cannot be extended safely.`,
      fix: `Convert mcp_servers to ordinary TOML tables, then re-run \`${CLI_NAME} connect\`.` };

  return { action: "merge", text: appendBlock(existingText, block), entry,
    registered: false, currentServerPath: null, currentCommand: null };
}

/** The reverse: drop our key, keep everything else. Returns null when there is
 *  nothing of ours to remove, so unwire on a stranger's repo writes nothing. */
export function planRemoval(existingText, target, key = MCP_SERVER_KEY, expectedEntry = null) {
  if (target.format === "toml") return planCodexRemoval(existingText, key);
  if (existingText == null) return null;
  let doc;
  try { doc = JSON.parse(existingText); } catch { return null; }   // never touch what we cannot parse
  const container = target.shape?.container;
  const servers = doc?.[container];
  if (!servers || typeof servers !== "object" || !Object.hasOwn(servers, key)) return null;
  const expected = expectedEntry && target.shape ? target.shape.entryFor(expectedEntry) : expectedEntry;
  if (key === LIBRARIAN_MCP_SERVER_KEY && (!expected || !deepEqual(servers[key], expected)))
    return { action: "left", reason: "locally different restricted librarian entry — not exact generated bytes" };
  // Only remove an entry we recognise as ours — the same narrow test the merge
  // uses. Removing a foreign server that happens to share the key would be the
  // clobber, one command later.
  if (key !== LIBRARIAN_MCP_SERVER_KEY && !looksLikeOurs(servers[key]))
    return { action: "left", reason: "not ours" };
  const rest = { ...servers };
  delete rest[key];
  const out = { ...doc, [container]: rest };
  return { action: "removed", text: `${JSON.stringify(out, null, 2)}\n` };
}

function planCodexRemoval(existingText, key = MCP_SERVER_KEY) {
  if (existingText == null) return null;
  const managed = managedRange(existingText, key);
  if (managed?.malformed) return { action: "left", reason: "incomplete managed markers" };
  if (managed) {
    if (tomlStructureProblem(existingText))
      return { action: "left", reason: "the TOML is structurally malformed" };
    if (codexDefinitions(managed.text, key).length !== 1)
      return { action: "left", reason: "ownership markers do not contain exactly one managed table" };
    const outside = `${existingText.slice(0, managed.start)}${existingText.slice(managed.end)}`;
    if (codexDefinitions(outside, key).length || possibleCodexTargetReference(outside, key) ||
        codexSealedRoot(outside))
      return { action: "left", reason: "another definition under this key exists outside the managed block" };
    const text = `${existingText.slice(0, managed.start)}${existingText.slice(managed.end)}`
      .replace(/\n{3,}/g, "\n\n");
    return { action: "removed", text };
  }
  return codexDefinitions(existingText, key).length || possibleCodexTargetReference(existingText, key)
    ? { action: "left", reason: "unmarked entry is not ours" } : null;
}

// --- the snippet (for hosts we do not write) --------------------------------

/** Exactly what to paste, in the host's own format. Printed, never guessed at
 *  by writing it: the user applies it and stays the owner of their file. */
export function snippetFor(target, entry, key = MCP_SERVER_KEY) {
  if (target.id === "codex") {
    return codexServerBlock(entry, key).split("\n").slice(1, -1).join("\n");
  }
  return JSON.stringify({ [target.shape?.container ?? "mcpServers"]: {
    [key]: target.shape ? target.shape.entryFor(entry) : entry } }, null, 2);
}

// --- credentials ------------------------------------------------------------

/**
 * Every credential the config references, by NAME, with whether it will
 * actually resolve when an MCP HOST launches the server.
 *
 * The failure this catches: an MCP host does not run a login shell. A key
 * exported in the tester's .zshrc works perfectly for the CLI and is simply
 * absent for the server the host spawns, so the vendor returns 401 and the tool
 * looks broken. With per-host auth there can be several of these, and only one
 * of them failing is even more confusing than all of them failing.
 *
 * envFile coverage is read from the FILE, not from process.env, because
 * resolveConfig loads env files into process.env as a side effect — checking
 * the environment after that would report every envFile var as "already set in
 * your shell" and give the opposite advice.
 *
 * Values are never read, never printed, never returned. Names only.
 */
export function credentialReport(configPath, { env = process.env } = {}) {
  if (!configPath || !existsSync(configPath)) return [];
  let doc;
  try { doc = JSON.parse(readFileSync(configPath, "utf8")); } catch { return []; }
  const base = projectConfigRoot(configPath);
  const expand = (p) => (p?.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
  const declaredIn = (file) => {
    if (!file) return new Set();
    try {
      const names = new Set();
      for (const line of readFileSync(resolve(base, expand(file)), "utf8").split("\n")) {
        const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/.exec(line);
        if (m) names.add(m[1]);
      }
      return names;
    } catch { return new Set(); }
  };

  // Scopes: the selected environment (its `auth` is the credential for the base
  // URL) and each declared host. Both can name their own envFile — vendor keys
  // commonly live apart from the project's.
  const scopes = [];
  const envName = env.API_ENV ?? doc.default;
  const selected = envName ? doc.environments?.[envName] : null;
  if (selected) scopes.push({ scope: `env:${envName}`, auth: selected.auth, envFile: selected.envFile });
  for (const [name, h] of Object.entries({ ...doc.hosts, ...selected?.hosts }))
    if (h && typeof h === "object") scopes.push({ scope: `host:${name}`, auth: h.auth, envFile: h.envFile });

  const rows = [];
  for (const s of scopes) {
    const vars = authEnvVars(s.auth);
    if (!Array.isArray(vars)) {
      rows.push({ scope: s.scope, var: null, state: "invalid",
        fix: `The auth spec '${s.auth}' is not a recognised form (bearer:ENV, header:Name:ENV, query:param:ENV, oauth:ID_ENV:SECRET_ENV).` });
      continue;
    }
    const inFile = declaredIn(s.envFile);
    for (const v of vars) {
      if (inFile.has(v)) { rows.push({ scope: s.scope, var: v, state: "envFile", source: s.envFile }); continue; }
      if (env[v]) rows.push({ scope: s.scope, var: v, state: "shell-only",
        fix: `${v} is set in your shell but an MCP host does not inherit it. Add "${v}=..." to an envFile and point ${s.scope}'s "envFile" at it.` });
      else rows.push({ scope: s.scope, var: v, state: "missing",
        fix: `${v} is not set. Put "${v}=..." in an env file and add "envFile" to ${s.scope} in the config.` });
    }
  }
  return rows;
}

// --- skills -----------------------------------------------------------------

/** A skill's own declared `name:`. Claude Code keys a skill by its DIRECTORY
 *  name, so installing under anything else silently never loads it — the exact
 *  failure that makes a tester conclude the write convention "does nothing". */
function skillSource(sourcePath) {
  return readFileSync(sourcePath, "utf8")
    .replace(new RegExp(escapeRe(PROSE_PRODUCT_TITLE), "gi"), spelling =>
      spelling[0] === spelling[0].toUpperCase() ? PRODUCT[0].toUpperCase() + PRODUCT.slice(1) : PRODUCT)
    .replace(/\{\{([A-Z_]+)\}\}/g, (token, key) => ({
    PRODUCT, CONTEXT_PATH: LAYOUT.context, ENVIRONMENTS_PATH: LAYOUT.environments,
    GRAPH_MANIFEST_PATH: LAYOUT.graphManifest, EVIDENCE_PATH: LAYOUT.evidence,
    FEEDBACK_PATH: LAYOUT.feedback, SKILLS_PATH: LAYOUT.skills, SUITES_PATH: LAYOUT.suites,
    FEEDBACK_ENDPOINT: `${FEEDBACK_BASE_URL}/feedback`, FEEDBACK_SEND_ENV,
  })[key] ?? token);
}

export function skillName(sourcePath) {
  const text = skillSource(sourcePath);
  return /^name:\s*(\S+)\s*$/m.exec(text)?.[1] ?? null;
}

/**
 * The skills the package is supposed to carry, or a NAMED reason it cannot.
 *
 * The skills are the only part of the product that no import statement
 * mentions: they are read from disk by path, so an installed copy missing
 * them type-checks, imports cleanly, and dies in readFileSync on the first
 * `connect` a newcomer runs — as a raw ENOENT stack trace, which reads as
 * "this tool is broken" when the truth is "this COPY is incomplete". Those
 * have completely different next steps, and the newcomer cannot tell them
 * apart from a stack trace. Named here so the caller can print a fix.
 */
export function missingSkills(sources = SKILL_SOURCES) {
  return sources.filter((s) => !existsSync(s));
}

// A command line inside a skill: the product name, then a space, then a
// lowercase subcommand whose own next character is an argument (a quote, a
// flag) or the end of the line. Prose that merely NAMES the product does not
// match — `sannr.json` (no space), `sannr-write` (no space),
// "sannr is the tool that…" ("the" is neither an argument nor a line
// end) — because those are identifiers and rewriting one produces a file
// nobody has or a skill directory Claude Code never loads.
const COMMAND_POSITION = new RegExp(
  "(^|[\\s`(])" + PRODUCT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") +
  "(?= (?:graph (?:context|record|impact|export)|[a-z][a-z-]*)(?:$|[`.,;:!?)]|\\s+(?:[\"'-]|$)))", "gm");
// Exact matcher used by 00e0b38 and earlier. In particular it did not rewrite
// inline-backtick `sannr feedback`, while it did rewrite the standalone
// command lower in that skill. Migration recognises those historical mixed
// bytes without broadening ownership to prose edits.
const HISTORICAL_COMMAND_POSITION = new RegExp(
  "(^|[\\s`(])" + PRODUCT.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") +
  "(?= [a-z][a-z-]*(?:$|\\s+[\"'-]))", "gm");
function replaceExactSkillRegion(text, before, after, label) {
  const at = text.indexOf(before);
  if (at < 0 || text.indexOf(before, at + before.length) >= 0)
    throw new Error(`The packaged ${label} skill region is missing or ambiguous.`);
  return text.slice(0, at) + after + text.slice(at + before.length);
}

// Keep command substitutions out of the shipped skill sources. The
// portable/commandless variants are render-time views over
// a small, explicitly enumerated set of command-bearing regions instead of
// annotations added to those source files.
function renderCommandlessSkill(sourcePath, text) {
  const suites = text.includes(`${LAYOUT.suites}/<name>.json`) ? LAYOUT.suites : LEGACY_LAYOUT.suites;
  const name = skillName(sourcePath);
  let rendered = text;
  const fallbackHeading = name === SKILL_NAMES.request ? "## Before the MCP server loads"
    : name === SKILL_NAMES.write ? "## CLI fallback before restart" : null;
  if (fallbackHeading && rendered.includes(`${fallbackHeading}\n`)) {
    const start = rendered.indexOf(`${fallbackHeading}\n`);
    const end = rendered.indexOf("\n## ", start + fallbackHeading.length);
    if (end < 0) throw new Error("The packaged CLI fallback section has no boundary.");
    rendered = rendered.slice(0, start) + `${fallbackHeading}\n\n` +
      `The current installation has no portable CLI invocation. ${PORTABLE_COMMAND_REMEDY} ` +
      `Then use its local context commands before restarting. Do not execute API requests just to confirm installation.\n` +
      rendered.slice(end);
  }
  if (name === `${PRODUCT}-feedback`) {
    rendered = replaceExactSkillRegion(rendered, [
      "  they are done trying it, or at the end of a session where you used it. You are",
      "  the one who actually used the tool, so you write the report: run",
      `  \`${PRODUCT} feedback\`, fill in the three questions from what you personally`,
    ].join("\n"), [
      "  they are done trying it, or at the end of a session where you used it. You are",
      "  the one who actually used the tool, so you write the report with the feedback workflow",
      "  after installing the repo-local CLI; fill in the three questions from what you personally",
    ].join("\n"), "feedback description");
    rendered = replaceExactSkillRegion(rendered,
      ["```", `${PRODUCT} feedback`, "```"].join("\n"),
      `Use the repo-local feedback command once installed. ${PORTABLE_COMMAND_REMEDY}`,
      "feedback command");
    // The optional send workflow has its own explicit commandless rendering.
    // Keep consent and privacy instructions while withholding commands that
    // this installation cannot execute through a portable invocation.
    for (const [before, after, label] of [
      [`\`${PRODUCT} feedback\``, 'the repo-local feedback command', 'feedback local inline command'],
      [`\`${PRODUCT} feedback --send\``, 'the repo-local feedback send command', 'feedback send inline command'],
      [`\`${PRODUCT} show --stack ${PRODUCT}-feedback\``, 'the repo-local show command for the packaged feedback stack', 'feedback stack command'],
      [["```sh", `${PRODUCT} feedback --send --confirm-send --answers .${PRODUCT}/feedback/answers.json --agent-note 'The imported request worked after I supplied its missing variable.' --host-agent codex`, "```"].join('\n'),
        `Use the repo-local feedback send command with the confirmed report, private answers file, agent note and actual host. ${PORTABLE_COMMAND_REMEDY}`, 'feedback send command'],
    ]) if (rendered.includes(before)) rendered = replaceExactSkillRegion(rendered, before, after, label);
  } else if (name === `${PRODUCT}-write`) {
    // New authored-history commands have a commandless view too. Preserve the
    // workflow when no executable portable CLI is available, without leaving
    // a bare command that cannot run in the consumer repository.
    for (const [before, after, label] of [
      [`\`${PRODUCT} note --stack <name> --scope stack "<one sentence>"\``, "the repo-local note command with a selected stack and stack scope", "stack fact command"],
      [`\`${PRODUCT} show "<METHOD /path>" --human --history\``, "the repo-local history inspection command with human and history output", "history inspection"],
      [`\`${PRODUCT} review --accept-notes "<METHOD /path>" --if-notes sha256:<current-history-digest>\``, "the repo-local reviewed baseline command with the current history digest", "history acknowledgement"],
    ]) {
      // These regions were introduced with authored note history. Historical
      // templates have neither command; their existing map still applies and
      // the final command scan continues to refuse unknown command regions.
      if (rendered.includes(before)) rendered = replaceExactSkillRegion(rendered, before, after, label);
    }
    rendered = replaceExactSkillRegion(rendered,
      ["```", `${PRODUCT} note \"<METHOD /path>\" \"<one sentence>\"`, "```"].join("\n"),
      `Use the repo-local note command once installed. ${PORTABLE_COMMAND_REMEDY}`,
      "note command");
    rendered = replaceExactSkillRegion(rendered, [
      `  - \`${PRODUCT} note \"POST /orders\" \"400s without idempotency_key, which the contract marks optional\"\``,
      `  - \`${PRODUCT} note \"GET /users\" \"returns disabled accounts too; filter on status yourself\"\``,
      `  - \`${PRODUCT} note \"GET /orders\" \"cursor is opaque; decoding it breaks on deploy\"\``,
    ].join("\n"), [
      "  - Example for `POST /orders`: 400s without idempotency_key, which the contract marks optional.",
      "  - Example for `GET /users`: returns disabled accounts too; filter on status yourself.",
      "  - Example for `GET /orders`: cursor is opaque; decoding it breaks on deploy.",
    ].join("\n"), "note examples");
    rendered = replaceExactSkillRegion(rendered, [
      "```",
      `${PRODUCT} verdict \"<what>\" --verdict rejected --reason \"<one sentence, by shape not value>\" --class <class> [--probe ${suites}/<name>.json]`,
      "```",
    ].join("\n"),
    `Use the repo-local verdict command once installed. ${PORTABLE_COMMAND_REMEDY}`,
    "verdict command");
  }
  COMMAND_POSITION.lastIndex = 0;
  if (COMMAND_POSITION.test(rendered))
    throw new Error("A packaged skill command is outside its commandless rendering map.");
  return rendered;
}

/**
 * A skill AS IT MUST LAND IN THE USER'S REPO.
 *
 * The skill body is prose, so the name in it cannot derive from a constant the
 * way code does. Its COMMAND LINES are different: an agent executes them
 * verbatim, and on a per-project install the bare name is command-not-found
 * (exit 127). This is the copy that matters most,
 * because it is committed into someone else's repo and read months later by an
 * agent that cannot notice the command is wrong: it just does not write, and
 * the knowledge file silently never grows. From the outside that is
 * indistinguishable from a product that does nothing.
 *
 * The command position receives the verified portable
 * invocation when one exists; otherwise the executable line is visibly
 * omitted while the surrounding skill guidance remains available.
 * The documentation link is also relative to the installed skill's location.
 */
export function renderSkill(sourcePath, cliName = POINTER_CLI_NAME, options = {}) {
  const source = skillSource(sourcePath);
  const documentation = skillDocumentation(sourcePath, source, options);
  const text = documentation ? source.replace(SKILL_DOCUMENTATION, documentation.paragraph) : source;
  if (cliName == null) return renderCommandlessSkill(sourcePath, text);
  const template = text;
  const replacement = cliName;
  if (replacement === PRODUCT) return template;
  return template.replace(COMMAND_POSITION, (_, lead) => `${lead}${replacement}`);
}

const SKILL_DOCUMENTATION = "For the package's agent-readable command and safety documentation, see the\n" +
  "[Agent operating guide](../docs/agent-guide.md).";
const PREVIOUS_SKILL_DOCUMENTATION = "For the package's agent-readable command and safety documentation, see the\n" +
  "[API client documentation](../docs/README.md).";
const LEGACY_SKILL_DOCUMENTATION = "For the package's agent-readable command and safety documentation, see the\n" +
  "portable-relative `docs/` tree next to this skill (`docs/README.md`).";
const SKILL_DOCUMENTATION_REMEDY = `Install ${PRODUCT} as a local project dependency, then run connect again to add its portable documentation link.`;
const PREVIOUS_OMITTED_SKILL_DOCUMENTATION = "The package's command and safety documentation is not available through a portable project-local link. " +
  SKILL_DOCUMENTATION_REMEDY;
const OMITTED_SKILL_DOCUMENTATION = "Read `docs/agent-guide.md` in the installed package for command and safety documentation. " +
  "It is not available through a portable project-local link. " + SKILL_DOCUMENTATION_REMEDY;

function insidePath(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

/** Installed skills move away from their source docs. Link to the original
 * package tree only when it lives in this repository, so committed guidance
 * never embeds another machine's checkout or global installation path. */
function skillDocumentation(sourcePath, source, { root, destination } = {}) {
  if (!root || !destination || !source.includes(SKILL_DOCUMENTATION)) return null;
  const docs = resolve(dirname(sourcePath), "..", "docs", "agent-guide.md");
  let portable = false;
  try { portable = insidePath(root, docs) && insidePath(realpathSync(root), realpathSync(docs)); }
  catch { /* Missing package docs receive an explicit remedy, not a dead link. */ }
  const link = relative(dirname(destination), docs).split(sep).map(encodeURIComponent).join("/");
  const linkedParagraph = "For the package's agent-readable command and safety documentation, see the\n" +
    `[Agent operating guide](${link}).`;
  const previousLinkedParagraph = "For the package's agent-readable command and safety documentation, see the\n" +
    `[API client documentation](${link.replace(/agent-guide\.md$/, "README.md")}).`;
  return { paragraph: portable ? linkedParagraph : OMITTED_SKILL_DOCUMENTATION,
    // Retain exact generated bytes for unwire if package docs disappear later.
    linkedParagraph: insidePath(root, docs) ? linkedParagraph : null,
    previousLinkedParagraph: insidePath(root, docs) ? previousLinkedParagraph : null,
    omitted: !portable, remedy: portable ? null : SKILL_DOCUMENTATION_REMEDY };
}

function generatedSkills(sourcePath, options) {
  const source = skillSource(sourcePath);
  const documentation = skillDocumentation(sourcePath, source, options);
  // PRODUCT: installed copies printed the bare name before scoped installs were detected.
  return new Set([null, PRODUCT, POINTER_CLI_NAME, CLI_NAME, installedNpxCommand()].flatMap((command) => {
    const rendered = renderSkill(sourcePath, command);
    return [rendered, renderSkill(sourcePath, command, options),
      ...(source.includes(SKILL_DOCUMENTATION) ? [
        rendered.replace(SKILL_DOCUMENTATION, PREVIOUS_SKILL_DOCUMENTATION),
        rendered.replace(SKILL_DOCUMENTATION, LEGACY_SKILL_DOCUMENTATION),
        rendered.replace(SKILL_DOCUMENTATION, OMITTED_SKILL_DOCUMENTATION),
        rendered.replace(SKILL_DOCUMENTATION, PREVIOUS_OMITTED_SKILL_DOCUMENTATION),
        ...(documentation?.linkedParagraph ? [rendered.replace(SKILL_DOCUMENTATION, documentation.linkedParagraph)] : []),
        ...(documentation?.previousLinkedParagraph ? [rendered.replace(SKILL_DOCUMENTATION, documentation.previousLinkedParagraph)] : []),
      ] : [])];
  }));
}

// Retain exact generated selection/write policies from previous releases.
// Keep only their digests in the runtime: old instructions must not be shipped
// as another discoverable skill. Hash after undoing our exact docs/CLI rendering
// so portable and historical checkout installations can upgrade. Every other
// byte remains part of ownership; a team's edit is still theirs.
const PREVIOUS_GENERATED_SKILL_DIGESTS = new Map([
  [SKILL_NAMES.request, new Set([
    "93c421fab8254e528074c03ed20dc9fc019310b1402a2a1dd63d3af83d0d0467",
    "7a9acf6599415db96903281cf8d3e4c456b7bd8de842f830849b082e9e4a4662",
    // 252c215 repository-scoped API request convention, before CLI-first setup.
    "b6d3ade6ce053e3b04aa4d3ac40c772a342652d6420c3f1ec64ffca5c0fc7780",
  ])],
  [SKILL_NAMES.write, new Set([
    "53e275144fbb232cd8feb45513467745e9bcf574a4413011d7299896c06dc30a",
    "d66d7990d32153306467e8e2a997edaeff507cd058d0e1d0e797e73f54c347ad",
    "c95c68eeed34ebc1c9b6d76882b765d6d9a66c31e0feeb8d8f21509db8497fa4",
    "f703310bc55b33b237af265cd5ea7392c7841528c9fc00717954b1d4374281b0",
    // a02b8b4 predates the own-base hook clarification; existing installed
    // commandless copies still carry that exact generated policy.
    "d574d56b137d70f6de29b8680f5eece573f9c35f3e0e232f03095cd11091db61",
    "080b886d76927822d4c069f4ceae9783a7dd13332ef4cc266ffd1451a115a851",
    // e094728 observation-linked recording and configured snapshot guidance,
    // followed by its exact commandless rendering.
    "e33f181ac4b52a222303756da06e7a814e28a7b618156a83a6d0612486cc4cd9",
    "f9968e34d01955df77d1c91ec397b5c3e5855f0e7d077ad2a8b4e10d96bc525e",
    // 252c215 temporal/provider attribution and its commandless rendering.
    "611d18e77979b84de800789a68b5e34099889b6a5aa5ce5a3d4be766b007bfff",
    "7a348c390e83e8128c696e9966c7886e346fd56b4642d8ad9d881e984de216ed",
    // Published alpha.8, before authored supersession and integrity guidance;
    // followed by its exact commandless rendering. All other prose must match.
    "a1b18645fee0a636a3f52b827794b5739ef383c5459fd9cdfacb439ca128323f",
    "1135b5a5e4cec711a71c4aec61c033a553cace4fb15d88e3261ab8ca2e63c954",
  ])],
  [SKILL_NAMES.feedback, new Set([
    "449ddd580c67cbbb57dd089006fc3c35aa025b2861b428dd84fb60c32f64cdd0",
    "feb50f21844f4df5280b70ab1325b61b93b3858b4eb8899d999af3914bd69db5",
  ])],
]);
function previousGeneratedSkill(sourcePath, body, options) {
  const name = skillName(sourcePath);
  const role = Object.keys(SKILL_NAMES).find(key => SKILL_NAMES[key] === name);
  const digest = shippedSkillDigest(sourcePath, body, options);
  return PREVIOUS_GENERATED_SKILL_DIGESTS.get(name)?.has(digest) ||
    SHIPPED_SKILL_DIGESTS.some(release => release.skills[role]?.includes(digest));
}

/** Hash only after undoing exact generated documentation and CLI positions.
 * Every policy byte remains authoritative: normalization never removes team
 * additions, changes to instructions or arbitrary links. The same digest
 * table is used by connect, migration and explicit unwire. */
export function shippedSkillDigest(sourcePath, body, options = {}) {
  const source = skillSource(sourcePath);
  const documentation = skillDocumentation(sourcePath, source, options);
  let normalized = body;
  for (const paragraph of new Set([SKILL_DOCUMENTATION, PREVIOUS_SKILL_DOCUMENTATION, LEGACY_SKILL_DOCUMENTATION,
    OMITTED_SKILL_DOCUMENTATION, PREVIOUS_OMITTED_SKILL_DOCUMENTATION,
    documentation?.linkedParagraph, documentation?.previousLinkedParagraph].filter(Boolean))) {
    normalized = normalized.replace(paragraph, "<generated-skill-documentation>");
  }
  const invocations = new Set([PRODUCT, POINTER_CLI_NAME, CLI_NAME]);
  // A historical connect wrote an absolute Node entrypoint, shell quoted if
  // needed. Admit only that existing CLI grammar, never a general shell command.
  for (const match of normalized.matchAll(/(?:^|[\s`(])node ((?:'(?:[^']|'\\'')*'|[A-Za-z0-9_./:\\-]+))/gm)) {
    const invocation = `node ${match[1]}`;
    if (historicalCliInvocation(invocation)) invocations.add(invocation);
  }
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pinnedInvocations = new RegExp("(?:^|[\\s`(])(npx --yes " + escape(NPM_PACKAGE)
    + "@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)(?= )", "gm");
  for (const match of normalized.matchAll(pinnedInvocations))
    if (historicalCliInvocation(match[1])) invocations.add(match[1]);
  const commands = new RegExp("(^|[\\s`(])(" + [...invocations].sort((a, b) => b.length - a.length)
    .map(escape).join("|") + ")(?= (?:graph (?:context|record|impact|export)|[a-z][a-z-]*)(?:$|[`.,;:!?)]|\\s+(?:[\"'-]|$)))", "gm");
  const seen = new Set();
  normalized = normalized.replace(commands, (_, lead, invocation) => {
    seen.add(invocation);
    return `${lead}${PRODUCT}`;
  });
  // Previous templates used one invocation at every command position.
  // Mixed invocations are an edit, even if each individual command is valid.
  if (seen.size > 1) return null;
  return createHash("sha256").update(normalized).digest("hex");
}

export function skillContainsCommands(sourcePath) {
  COMMAND_POSITION.lastIndex = 0;
  return COMMAND_POSITION.test(skillSource(sourcePath));
}

function decodeHistoricalWord(word) {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(word)) return word;
  if (!word.startsWith("'") || !word.endsWith("'")) return null;
  const inner = word.slice(1, -1);
  if (inner.replaceAll("'\\''", "").includes("'")) return null;
  return inner.replaceAll("'\\''", "'");
}

function historicalCliInvocation(value) {
  if (new RegExp(`^npx --yes ${escapeRe(NPM_PACKAGE)}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$`).test(value)) return true;
  if ([PRODUCT, POINTER_CLI_NAME, CLI_NAME].includes(value)) return true;
  if (!value.startsWith("node ")) return false;
  const entry = decodeHistoricalWord(value.slice(5));
  return Boolean(entry && isAbsolute(entry) && /[\\/]bin[\\/]cli\.mjs$/.test(entry));
}

// Before AX-B, command positions were the only bytes connect rendered in a
// packaged skill. Recognise that exact structural substitution even after the
// old checkout moved: every non-command byte must still equal the template,
// every replacement must be the same known historical CLI form. Prose edits
// therefore remain user-owned while exact old machine-path installs migrate.
function historicalGeneratedSkill(sourcePath, body, matcher = HISTORICAL_COMMAND_POSITION, options) {
  const documentation = options ? skillDocumentation(sourcePath, skillSource(sourcePath), options) : null;
  const targetParagraph = documentation?.paragraph ?? SKILL_DOCUMENTATION;
  // Documentation and command rendering both changed across alpha releases.
  // Normalize only exact known generated paragraphs for this destination;
  // arbitrary documentation links and every other prose edit stay user-owned.
  for (const paragraph of new Set([SKILL_DOCUMENTATION, PREVIOUS_SKILL_DOCUMENTATION,
    LEGACY_SKILL_DOCUMENTATION, OMITTED_SKILL_DOCUMENTATION, PREVIOUS_OMITTED_SKILL_DOCUMENTATION,
    documentation?.linkedParagraph, documentation?.previousLinkedParagraph].filter(Boolean))) {
    body = body.replace(paragraph, targetParagraph);
  }
  const sourceLines = (options ? renderSkill(sourcePath, PRODUCT, options) : skillSource(sourcePath)).split("\n");
  const bodyLines = body.split("\n");
  if (sourceLines.length !== bodyLines.length) return false;
  let invocation = null, saw = false;
  for (let i = 0; i < sourceLines.length; i += 1) {
    const source = sourceLines[i], rendered = bodyLines[i];
    matcher.lastIndex = 0;
    const matches = [...source.matchAll(matcher)];
    if (!matches.length) {
      if (source !== rendered) return false;
      continue;
    }
    if (matches.length !== 1) return false;
    const lead = matches[0][1] ?? "";
    const start = matches[0].index + lead.length;
    const before = source.slice(0, start), after = source.slice(start + PRODUCT.length);
    if (!rendered.startsWith(before) || !rendered.endsWith(after) || rendered.length < before.length + after.length)
      return false;
    const candidate = rendered.slice(before.length, rendered.length - after.length);
    if (!historicalCliInvocation(candidate) || (invocation != null && invocation !== candidate)) return false;
    invocation = candidate;
    saw = true;
  }
  return saw;
}

/**
 * Plan the skill installs: idempotent by content comparison, so a re-run is a
 * no-op.
 *
 * A destination that DIFFERS is left alone unless forced. This is the same rule
 * the MCP merge follows one file over: what the user changed is theirs. A team
 * that tightened the write convention for their own repo would otherwise lose
 * that edit to a routine re-run — and the edited convention is precisely the
 * artefact this product wants them to own. `--force-skills` takes the packaged
 * version when a genuinely stale skill needs replacing.
 */
export const SKILL_TARGETS = [
  { host: "claude-code", label: "Claude Code", dir: [".claude", "skills"] },
  { host: "codex", label: "Codex", dir: [".agents", "skills"] },
];

/** Canonical copies and host copies have the same depth, so portable links and
 * command bytes remain identical. A team's canonical edits are authoritative;
 * separately edited host copies still require an explicit force to replace. */
const CANONICAL_SKILL_TARGET = { host: "project", label: "Project skills", dir: LAYOUT.skills.split("/") };

function ownedSkill(src, current, options) {
  const name = skillName(src);
  const role = Object.keys(SKILL_NAMES).find(key => SKILL_NAMES[key] === name);
  const variants = new Set([current, ...(LEGACY_SKILL_NAMES[role] ?? [])
    .map(legacy => current.replace(new RegExp(`^name: ${escapeRe(legacy)}$`, "m"), `name: ${name}`))]);
  const generated = generatedSkills(src, options);
  return [...variants].some(body => generated.has(body) || historicalGeneratedSkill(src, body)
    || historicalGeneratedSkill(src, body, COMMAND_POSITION)
    || historicalGeneratedSkill(src, body, COMMAND_POSITION, options) || previousGeneratedSkill(src, body, options));
}

export function planSkills(root, { alpha = false, sources = SKILL_SOURCES, force = false,
  targets = SKILL_TARGETS, cliName = POINTER_CLI_NAME } = {}) {
  void alpha; // accepted for older callers; all three named conventions now ship.
  const canonical = new Map();
  const installs = [CANONICAL_SKILL_TARGET, ...targets.filter(target => target.host !== "project")];
  return installs.flatMap((target) => sources.map((src) => {
    const name = skillName(src);
    const dest = join(root, ...target.dir, name, "SKILL.md");
    const options = { root, destination: dest };
    const packaged = renderSkill(src, cliName, options);
    const documentation = skillDocumentation(src, skillSource(src), options);
    const commandOmitted = cliName == null && skillContainsCommands(src);
    const unsafe = projectPathProblem(root, dest);
    if (unsafe) return { name, host: target.host, label: target.label, from: src,
      to: dest, body: packaged, action: "conflict",
      reason: `${unsafe}; project skill paths must not traverse symbolic links.`,
      fix: `Replace the linked skill path with a real directory inside the project, then re-run \`${CLI_NAME} connect\`.` };
    const role = Object.keys(SKILL_NAMES).find(key => SKILL_NAMES[key] === name);
    const legacy = (LEGACY_SKILL_NAMES[role] ?? []).map(previousName =>
      join(root, ...target.dir, previousName, "SKILL.md")).filter(path => path !== dest);
    const legacyProblem = legacy.map(path => ({ path, problem: projectPathProblem(root, path) }))
      .find(row => row.problem);
    if (legacyProblem) return { name, host: target.host, label: target.label,
      from: src, to: dest, body: packaged, action: "conflict",
      reason: `${legacyProblem.path}: ${legacyProblem.problem}; legacy skills are not followed through symbolic links.` };
    const previous = legacy.filter(path => existsSync(path));
    if (previous.length > 1) return { name, host: target.host, label: target.label,
      from: src, to: dest, body: packaged, action: "conflict",
      reason: `Multiple legacy skills claim "${name}": ${previous.join(", ")}.` };
    const migratedFrom = previous[0];
    if (migratedFrom && !ownedSkill(src, readFileSync(migratedFrom, "utf8"), { root, destination: migratedFrom }))
      return { name, host: target.host, label: target.label, from: src,
        to: dest, body: packaged, action: "conflict",
        reason: `${migratedFrom}: the legacy skill was edited; its instructions were preserved.`,
        fix: "Review the named legacy skill before migrating; no second skill was installed." };
    const current = existsSync(dest) ? readFileSync(dest, "utf8") : null;
    if (migratedFrom && current != null && !force && !ownedSkill(src, current, options))
      return { name, host: target.host, label: target.label, from: src, to: dest,
        body: packaged, action: "conflict",
        reason: `${dest}: the current skill was edited while a legacy skill also exists; both were preserved.` };
    const isCanonical = target.host === "project";
    const body = isCanonical && current != null && !force && !ownedSkill(src, current, options)
      ? current : (canonical.get(name)?.body ?? packaged);
    const action = current == null ? migratedFrom ? "updated" : "installed"
      : current === body && !migratedFrom ? "unchanged"
      : ownedSkill(src, current, options) || force ? "updated" : "differs";
    if (isCanonical) canonical.set(name, { body, path: dest });
    return { name, host: target.host, label: target.label,
      from: isCanonical ? src : canonical.get(name)?.path ?? src, to: dest, body, action,
      ...(migratedFrom ? { migratedFrom } : {}), commandOmitted,
      ...(documentation ? { documentationOmitted: documentation.omitted,
        ...(documentation.remedy ? { documentationRemedy: documentation.remedy } : {}) } : {}),
      ...(action === "differs" ? { fix: `Yours differs from the project skill and was left as-is. Take the project version with \`${CLI_NAME} connect --force-skills\`.` } : {}) };
  }));
}

/** Old directory names remain explicit removal candidates. A name alone never
 * grants deletion authority: every unedited byte must match generated policy. */
export function planSkillRemoval(root, sources = SKILL_SOURCES, targets = SKILL_TARGETS) {
  return [CANONICAL_SKILL_TARGET, ...targets.filter(target => target.host !== "project")]
    .flatMap(target => sources.flatMap(src => {
    const currentName = skillName(src);
    const role = Object.keys(SKILL_NAMES).find(key => SKILL_NAMES[key] === currentName);
    return [currentName, ...(LEGACY_SKILL_NAMES[role] ?? [])].map(name => {
      const dest = join(root, ...target.dir, name, "SKILL.md");
      const unsafe = projectPathProblem(root, dest);
      if (unsafe) return { name, host: target.host, label: target.label, to: dest,
        action: "left", reason: `${unsafe}; not followed during unwire` };
      if (!existsSync(dest)) return { name, host: target.host, label: target.label, to: dest, action: "absent" };
      const current = readFileSync(dest, "utf8");
      if (!ownedSkill(src, current, { root, destination: dest }))
        return { name, host: target.host, label: target.label, to: dest, action: "left", reason: "edited locally — yours now, not removed" };
      return { name, host: target.host, label: target.label, to: dest, action: "removed" };
    });
  }));
}

/** A layout rename changes generated instructions as well as filenames. Build
 * every write before migration moves anything. Only exact generated bytes (or
 * their existing historical digest allowlist) confer authority; an edited
 * convention is a named conflict and remains available for human migration. */
export function migrateSkillPlans(root, { previousLayouts = [],
  cliName = advertisementPlan(root).portable.available ? POINTER_CLI_NAME : null } = {}) {
  const previous = previousLayouts.length ? previousLayouts : [{ product: PRODUCT, collection: COLLECTION }];
  const rows = [], seen = new Set();
  const targets = [CANONICAL_SKILL_TARGET, ...SKILL_TARGETS];
  const title = value => value[0].toUpperCase() + value.slice(1);
  const candidatesFor = (src, options, prior, oldLayout) => {
    const replacements = new Map(Object.keys(LAYOUT).map(key => [LAYOUT[key], oldLayout[key]])
      .filter(([from, to]) => from !== to));
    if (PRODUCT !== prior.product) {
      replacements.set(PRODUCT, prior.product);
      replacements.set(title(PRODUCT), title(prior.product));
      // Environment spellings are uppercase and cannot be recovered by the
      // ordinary lowercase/title substitutions. Match exactly the generated
      // send-policy identifier; every other byte still establishes ownership.
      replacements.set(FEEDBACK_SEND_ENV, `${prior.product.toUpperCase().replaceAll('-', '_')}_FEEDBACK_SEND`);
    }
    const pattern = replacements.size ? new RegExp([...replacements.keys()].sort((a,b) => b.length-a.length).map(escapeRe).join("|"), "g") : null;
    return new Set([...generatedSkills(src, options)].map(body => pattern
      ? body.replace(pattern, match => replacements.get(match)) : body));
  };
  for (const prior of previous) {
    if (![prior.product, prior.collection].every(value => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)))
      throw Object.assign(new Error("The prior skill layout identity is invalid."), { code: "LAYOUT_MARKER_INVALID" });
    const oldLayout = layoutFor(prior.product, prior.collection);
    for (const target of targets) for (const src of SKILL_SOURCES) {
      const name = skillName(src), role = Object.keys(SKILL_NAMES).find(key => SKILL_NAMES[key] === name);
      const oldName = SKILL_NAMES[role].replace(PRODUCT, prior.product);
      const oldDir = target.host === "project" ? oldLayout.skills.split("/") : target.dir;
      const to = join(root, ...target.dir, name, "SKILL.md");
      const options = { root, destination: to };
      const generated = candidatesFor(src, options, prior, oldLayout);
      for (const priorName of [oldName, ...(LEGACY_SKILL_NAMES[role] ?? [])]) {
        const from = join(root, ...oldDir, priorName, "SKILL.md");
        if (seen.has(from)) continue;
        seen.add(from);
        const unsafe = projectPathProblem(root, from) ?? projectPathProblem(root, to);
        if (!unsafe && !existsSync(from)) continue;
        const base = { name, host: target.host, from, to };
        if (unsafe) { rows.push({ ...base, action: "conflict", reason: unsafe }); continue; }
        if (from !== to && existsSync(to)) {
          rows.push({ ...base, action: "conflict", reason: "The destination skill already exists." }); continue;
        }
        const current = readFileSync(from, "utf8");
        if (!generated.has(current) && !ownedSkill(src, current, { root, destination: from })) {
          rows.push({ ...base, action: "conflict", reason: "The installed skill was edited; its instructions were preserved." }); continue;
        }
        const body = renderSkill(src, cliName, options);
        rows.push({ ...base, body, action: from !== to ? "moved" : current === body ? "unchanged" : "updated" });
      }
    }
  }
  // A legacy host-only install gets its canonical source during migration.
  // The corresponding host row owns any removal; this row only creates a file.
  for (const src of SKILL_SOURCES) {
    const name = skillName(src);
    if (rows.some(row => row.name === name && row.host === "project")
      || !rows.some(row => row.name === name && row.action !== "conflict")) continue;
    const to = join(root, ...CANONICAL_SKILL_TARGET.dir, name, "SKILL.md");
    const unsafe = projectPathProblem(root, to);
    if (unsafe || existsSync(to)) {
      rows.push({ name, host: "project", from: to, to, action: "conflict",
        reason: unsafe ?? "The destination canonical skill already exists." }); continue;
    }
    rows.unshift({ name, host: "project", from: to, to, action: "installed",
      body: renderSkill(src, cliName, {root,destination:to}) });
  }
  const destinations = new Set();
  for (const row of rows) {
    if (destinations.has(row.to)) { row.action = "conflict"; row.reason = "Multiple installed skills claim the destination."; }
    destinations.add(row.to);
  }
  return rows;
}

/** Remove only byte-identical generated agents. The base entry is the same one
 * historical connect composed, so explicit unwire can clean up an old install
 * while preserving every locally edited copy. */
export function planLibrarianAgentRemoval(root, entry, alternateEntries = []) {
  const alternatives = alternateEntries.flatMap(candidate =>
    librarianTargets(root, candidate, { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC }));
  return librarianTargets(root, entry, { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC }).map((target) => {
    const unsafe = projectPathProblem(root, target.to);
    if (unsafe) return { ...target, name: LIBRARIAN_NAME, action: "left",
      reason: `${unsafe}; not followed during unwire` };
    if (!existsSync(target.to)) return { ...target, name: LIBRARIAN_NAME, action: "absent" };
    const current = readFileSync(target.to, "utf8");
    if (current !== target.body && !alternatives.some(other => other.to === target.to && current === other.body))
      return { ...target, name: LIBRARIAN_NAME, action: "left",
        reason: "edited locally — yours now, not removed" };
    return { ...target, name: LIBRARIAN_NAME, action: "removed" };
  });
}

// --- the writes (dumb by design) --------------------------------------------

export function writeText(path, text, root = null) {
  const unsafe = root ? projectPathProblem(root, path) : null;
  if (unsafe) throw new Error(`Refusing project write: ${unsafe}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** Remove a skill's file and its directory if that leaves it empty — never the
 * host skill tree itself, which holds the user's other skills. */
export function removeSkill(dest, root = null) {
  const unsafe = root ? projectPathProblem(root, dest) : null;
  if (unsafe) throw new Error(`Refusing project removal: ${unsafe}`);
  rmSync(dest, { force: true });
  const dir = dirname(dest);
  try { rmdirSync(dir); } catch { /* non-empty, absent, or already gone */ }
}

/**
 * After the skills are gone, drop host skill directories IF THEY ARE EMPTY.
 * connect creates those trees in repos that had none, and an
 * undo that leaves its own scaffolding behind is not an undo — the next person
 * to open the repo finds an empty `.claude/` and has to work out who made it.
 *
 * Emptiness is the whole guard, and it is enough: a directory with anything in
 * it (another skill, settings.json, a subdirectory) is the user's and survives
 * untouched. Innermost first, because removing the parent is only correct once
 * the child is gone.
 */
export function pruneEmptyDirs(root) {
  const removed = [];
  for (const d of [join(root, ".claude", "skills"), join(root, ".claude", "agents"),
                   join(root, ".claude"), join(root, ".agents", "skills"),
                   join(root, ".agents"), join(root, ".codex", "agents")]) {
    try {
      if (projectPathProblem(root, join(d, ".project-path-safety-check"))) continue;
      if (!existsSync(d) || readdirSync(d).length) continue;
      rmdirSync(d);
      removed.push(d);
    } catch { /* unreadable or already gone: leaving it is always safe */ }
  }
  return removed;
}
