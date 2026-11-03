// Claude Code keeps settings.local.json out of commits via global git excludes:
// https://code.claude.com/docs/en/settings#keep-personal-settings-out-of-a-repository
// Connect owns only this repository's machine-local artifacts. Use Git's local
// exclude instead: editing a tracked .gitignore would itself violate AX-B's
// committed-surface rule, and changing a global exclude would affect other repos.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLAUDE_HOOK_SETTINGS } from "./claude-hook.mjs";
import { projectPathProblem, writeText } from "./connect.mjs";

const MARKER = "# sannr:managed-claude-hook-ignore";
const SEPARATOR_MARKER = `${MARKER}:added-separator`;

function git(root, args, input) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", input });
}

function excludeTarget(root) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.error?.code === "ENOENT") return { action: "skipped",
    code: "CLAUDE_HOOK_IGNORE_GIT_UNAVAILABLE", reason: "Git is unavailable; no local exclude was written." };
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return { action: "skipped",
    code: "CLAUDE_HOOK_IGNORE_NOT_GIT_WORKTREE", reason: "The directory is not a Git work tree; no local exclude was written." };
  // Git resolves info/exclude through the common directory for linked worktrees.
  const common = git(root, ["rev-parse", "--git-common-dir"]);
  const target = git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (common.status !== 0 || target.status !== 0) return { action: "conflict",
    code: "CLAUDE_HOOK_IGNORE_GIT_FAILED", reason: "Git could not resolve its local exclude path." };
  const gitRoot = resolve(root, common.stdout.trim());
  const path = resolve(root, target.stdout.trim());
  let unsafe;
  try {
    if (lstatSync(join(root, ".git")).isSymbolicLink() || lstatSync(gitRoot).isSymbolicLink())
      unsafe = "Git metadata is a symbolic link";
  } catch (error) {
    if (error?.code !== "ENOENT") unsafe = "Git metadata cannot be inspected safely";
  }
  unsafe ??= projectPathProblem(gitRoot, path);
  if (unsafe) return { action: "conflict", path,
    code: "CLAUDE_HOOK_IGNORE_PATH_UNSAFE", reason: unsafe };
  return { path, gitRoot };
}

function ownedBlock(text) {
  const lines = text.split("\n");
  const markers = lines.flatMap((line, i) => line.startsWith(MARKER) ? [i] : []);
  if (!markers.length) return null;
  const i = markers[0], marker = lines[i];
  if (markers.length !== 1 || ![MARKER, SEPARATOR_MARKER].includes(marker) ||
      lines[i + 1] !== CLAUDE_HOOK_SETTINGS || i + 2 >= lines.length)
    return { edited: true };
  const start = lines.slice(0, i).reduce((n, line) => n + line.length + 1, 0);
  if (marker === SEPARATOR_MARKER && start === 0) return { edited: true };
  return { start: start - (marker === SEPARATOR_MARKER ? 1 : 0),
    end: start + marker.length + 1 + CLAUDE_HOOK_SETTINGS.length + 1 };
}

export function planClaudeHookIgnore(root) {
  const target = excludeTarget(root);
  if (target.action) return target;
  const text = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  const owned = ownedBlock(text);
  if (owned?.edited) return { ...target, action: "conflict",
    code: "CLAUDE_HOOK_IGNORE_CONFLICT", reason: "The managed local exclude block was edited or duplicated; it was not changed." };
  const tracked = git(root, ["ls-files", "-z", "--", CLAUDE_HOOK_SETTINGS]);
  if (tracked.status !== 0) return { ...target, action: "conflict",
    code: "CLAUDE_HOOK_IGNORE_GIT_FAILED", reason: "Git could not check whether local settings are tracked." };
  if (tracked.stdout) return { ...target, action: "conflict",
    code: "CLAUDE_HOOK_SETTINGS_TRACKED", reason: "Claude Code local settings are tracked; a machine-local ignore cannot keep tracked edits out of commits." };
  // Ask Git to evaluate all repository ignore patterns; disable only the global
  // excludes file so this install never relies on the current user's other repos.
  const ignored = git(root, ["-c", "core.excludesFile=/dev/null", "check-ignore", "--verbose", "-z", "--stdin"], `${CLAUDE_HOOK_SETTINGS}\0`);
  const [source, , pattern] = ignored.stdout.split("\0");
  const negated = pattern?.startsWith("!");
  if (ignored.status === 0 && !negated) return { ...target, action: owned ? "unchanged" : "already_ignored" };
  if (![0, 1].includes(ignored.status)) return { ...target, action: "conflict",
    code: "CLAUDE_HOOK_IGNORE_GIT_FAILED", reason: "Git could not check the local settings ignore rule." };
  // A later local exclude can override another exclude rule, but .gitignore
  // has higher precedence. Refuse before any write when it explicitly includes
  // this path; claiming a successful local ignore would leave it commit-visible.
  if (negated && resolve(root, source) !== target.path) return { ...target, action: "conflict",
    code: "CLAUDE_HOOK_IGNORE_CONFLICT", reason: "A repository .gitignore negation includes local settings; a machine-local exclude cannot override it." };
  if (owned) return { ...target, action: "conflict", code: "CLAUDE_HOOK_IGNORE_CONFLICT",
    reason: "The managed ignore rule no longer covers local settings; review tracked files and negated ignore rules." };
  const separator = text.length > 0 && !text.endsWith("\n");
  return { ...target, action: "append", text: `${text}${separator ? "\n" : ""}${separator ? SEPARATOR_MARKER : MARKER}\n${CLAUDE_HOOK_SETTINGS}\n` };
}

export function planClaudeHookIgnoreRemoval(root) {
  const target = excludeTarget(root);
  if (target.action) return target.action === "conflict" ? { ...target, action: "left" } : target;
  const text = existsSync(target.path) ? readFileSync(target.path, "utf8") : "";
  const owned = ownedBlock(text);
  if (!owned) return { ...target, action: "absent" };
  if (owned.edited) return { ...target, action: "left",
    reason: "The managed local exclude block was edited or duplicated; it was not removed." };
  return { ...target, action: "removed", text: text.slice(0, owned.start) + text.slice(owned.end) };
}

export function applyClaudeHookIgnore(plan) {
  if (["append", "removed"].includes(plan?.action)) writeText(plan.path, plan.text, plan.gitRoot);
}

export function claudeHookIgnoreReport(plan, dryRun = false) {
  const { action, path, code, reason } = plan;
  return { action: dryRun && action === "append" ? "would_append" : action,
    ...(path ? { path } : {}), ...(code ? { code } : {}), ...(reason ? { reason } : {}) };
}
