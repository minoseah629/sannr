// CLAUDE CODE SHELL-HTTP INTERCEPT — AX-A.
//
// This module has two deliberately separate halves:
//   * pure planning/rendering for connect's explicit local-settings merge;
//   * a tiny stdin/stdout PreToolUse program that classifies a Bash command.
//
// The runtime half is intentionally self-contained. It never starts a shell,
// evaluates input, writes a file, or prints the intercepted command. Bash
// arguments routinely contain credentials, so even an error path may emit only
// fixed guidance assembled before the hook sees stdin.

import { lstatSync, readFileSync, readSync } from "node:fs";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const CLAUDE_HOOK_SETTINGS = ".claude/settings.local.json";
export const PLUMBING_ESCAPE = "API_ALLOW_RAW_HTTP_PROBE";
const MANAGED_ARG = "--managed-shell-http-intercept";
const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;

const b64 = (value) => Buffer.from(String(value ?? ""), "utf8").toString("base64");
const unb64 = (value) => Buffer.from(String(value ?? ""), "base64").toString("utf8");

// POSIX command hooks are strings interpreted by Claude Code's shell. Single
// quotes are the only safe common transport for paths containing spaces,
// dollar substitutions, or backticks; an embedded quote closes/reopens around
// a literal quote. The opaque arguments are base64 so the same rule also holds
// for the machine-local doctor invocation.
function shellWord(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function renderClaudeHookCommand({
  nodePath = process.execPath,
  hookPath = fileURLToPath(import.meta.url),
  configPath = "",
  doctor,
  pinnedBaseUrls = [],
} = {}) {
  const words = [nodePath, hookPath, MANAGED_ARG, b64(configPath), b64(doctor),
    b64(JSON.stringify(pinnedBaseUrls))];
  const integrity = createHash("sha256").update(JSON.stringify(words), "utf8").digest("hex");
  return [...words, integrity].map(shellWord).join(" ");
}

export function claudeHookTarget(root) {
  return join(root, CLAUDE_HOOK_SETTINGS);
}

/** The final local-settings inode is itself part of the project boundary.
 * Lexical/symlink ancestry is checked by connect.projectPathProblem; this
 * complements it with the properties that require inspecting the leaf. */
export function claudeHookFileProblem(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { return error?.code === "ENOENT" ? null : "local settings cannot be inspected safely"; }
  if (stat.isSymbolicLink()) return "local settings are a symbolic link";
  if (!stat.isFile()) return "local settings are not a regular file";
  if (stat.nlink !== 1) return "local settings have multiple hard links";
  return null;
}

export function claudeHookEntry(command) {
  return { matcher: "Bash", hooks: [{ type: "command", command, timeout: 5 }] };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const commandsIn = (row) => Array.isArray(row?.hooks)
  ? row.hooks.map((hook) => hook?.command).filter((command) => typeof command === "string") : [];
const looksManaged = (row) => commandsIn(row).some((command) => command.includes(MANAGED_ARG));

/** Plan the one project-local Claude setting without touching the filesystem. */
export function planClaudeHook(existingText, command) {
  const expected = claudeHookEntry(command);
  if (existingText == null) {
    const doc = { hooks: { PreToolUse: [expected] } };
    return { action: "create", text: `${JSON.stringify(doc, null, 2)}\n`, entry: expected };
  }

  let doc;
  try { doc = JSON.parse(existingText); }
  catch {
    return { action: "conflict", code: "CLAUDE_HOOK_SETTINGS_INVALID",
      reason: "Claude Code local settings are not valid JSON; the hook was not installed." };
  }
  if (!isObject(doc) || (doc.hooks !== undefined && !isObject(doc.hooks)) ||
      (doc.hooks?.PreToolUse !== undefined && !Array.isArray(doc.hooks.PreToolUse))) {
    return { action: "conflict", code: "CLAUDE_HOOK_SETTINGS_INVALID",
      reason: "Claude Code local settings do not contain an object hooks.PreToolUse array." };
  }

  const rows = doc.hooks?.PreToolUse ?? [];
  const managed = rows.filter(looksManaged);
  if (managed.length) {
    if (managed.length === 1 && same(managed[0], expected))
      return { action: "unchanged", text: existingText, entry: expected };
    return { action: "conflict", code: "CLAUDE_HOOK_CONFLICT",
      reason: "A locally different managed shell-HTTP hook is already present; it was not replaced." };
  }

  const merged = { ...doc, hooks: { ...(doc.hooks ?? {}), PreToolUse: [...rows, expected] } };
  return { action: "merge", text: `${JSON.stringify(merged, null, 2)}\n`, entry: expected };
}

/** Remove only the exact entry generated for this install. */
export function planClaudeHookRemoval(existingText) {
  if (existingText == null) return { action: "absent" };
  let doc;
  try { doc = JSON.parse(existingText); }
  catch { return { action: "left", reason: "local settings are not valid JSON" }; }
  if (!isObject(doc) || !isObject(doc.hooks) || !Array.isArray(doc.hooks.PreToolUse))
    return { action: "absent" };

  const managed = doc.hooks.PreToolUse.filter(looksManaged);
  if (!managed.length) return { action: "absent" };
  const owned = managed.length === 1 && recognizableGeneratedWords(managed[0]);
  if (!owned)
    return { action: "left", reason: "managed hook differs locally — yours now, not removed" };

  const pre = doc.hooks.PreToolUse.filter((row) => row !== managed[0]);
  const hooks = { ...doc.hooks };
  if (pre.length) hooks.PreToolUse = pre;
  else delete hooks.PreToolUse;
  const out = { ...doc };
  if (Object.keys(hooks).length) out.hooks = hooks;
  else delete out.hooks;
  if (!Object.keys(out).length) return { action: "removed", text: null };
  return { action: "removed", text: `${JSON.stringify(out, null, 2)}\n` };
}

function recognizableGeneratedWords(row) {
  if (!isObject(row) || Object.keys(row).sort().join(",") !== "hooks,matcher" ||
      row.matcher !== "Bash" || !Array.isArray(row.hooks) || row.hooks.length !== 1) return null;
  const hook = row.hooks[0];
  if (!isObject(hook) || Object.keys(hook).sort().join(",") !== "command,timeout,type" ||
      hook.type !== "command" || hook.timeout !== 5 || typeof hook.command !== "string") return null;
  const parsed = lexShell(hook.command);
  if (parsed.substitutions.length || parsed.tokens.some((token) => token.type !== "word" || token.dynamic))
    return null;
  const words = parsed.tokens.map((token) => token.value);
  if (words.length !== 7 || words[2] !== MANAGED_ARG || !/^[a-f0-9]{64}$/.test(words[6])) return null;
  let pinned;
  try { pinned = JSON.parse(unb64(words[5]) || "[]"); } catch { return null; }
  if (!Array.isArray(pinned) || pinned.some((url) => typeof url !== "string" || policyBaseUrl(url) !== url))
    return null;
  return hook.command === renderClaudeHookCommand({ nodePath: words[0], hookPath: words[1],
    configPath: unb64(words[3]), doctor: unb64(words[4]), pinnedBaseUrls: pinned })
    ? words : null;
}

// Collect EVERY statically configured upstream, not merely the selected
// environment. Agents may address a shared/per-environment host explicitly,
// and changing API_ENV must not turn an own endpoint into an arbitrary one.
export function configuredBaseUrls(text, extra = []) {
  let doc;
  try { doc = JSON.parse(text); } catch { return []; }
  const found = [];
  const take = (value) => {
    if (typeof value !== "string") return;
    try {
      const url = new URL(value);
      if (url.protocol === "http:" || url.protocol === "https:") found.push(value);
    } catch { /* malformed configured destinations are not guessed */ }
  };
  for (const value of extra) take(value);
  for (const host of Object.values(doc?.hosts ?? {})) take(host?.baseUrl);
  for (const env of Object.values(doc?.environments ?? {})) {
    take(env?.baseUrl);
    for (const host of Object.values(env?.hosts ?? {})) take(host?.baseUrl);
  }
  return [...new Set(found)].sort();
}

/** A policy target carries only origin + path. Userinfo/query/fragment can hold
 * credentials and do not participate in target identity, so a machine-local
 * env-only snapshot must discard them before it reaches generated settings. */
export function policyBaseUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.toString();
  } catch { return null; }
}

function normalUrl(value) {
  try {
    // curl treats a scheme-less host[:port]/path as HTTP. Normalize that
    // spelling before comparing origins; do not broaden this to arbitrary
    // words, which are curl options or positional data rather than URLs.
    const candidate = /^[^/?#\s:]+:\d+(?:[/?#]|$)/.test(value)
      ? `http://${value}` : value;
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    const unreserved = /%([0-9a-f]{2})/gi;
    let path = (url.pathname || "/").replace(unreserved, (raw, hex) => {
      const char = String.fromCharCode(Number.parseInt(hex, 16));
      return /[A-Za-z0-9._~-]/.test(char) ? char : raw.toUpperCase();
    });
    const segments = [];
    for (const segment of path.split("/")) {
      if (!segment || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    path = `/${segments.join("/")}`;
    while (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
    return { protocol: url.protocol,
      hostname: url.hostname.toLowerCase().replace(/\.$/, ""), port, path };
  } catch { return null; }
}

function targetIsOwn(value, bases) {
  const target = normalUrl(value);
  if (!target) return false;
  return bases.some((raw) => {
    const base = normalUrl(raw);
    // NAMED LOOPBACK RULE: when the configured base is loopback, localhost,
    // 127.0.0.1, [::1], and 0.0.0.0 are one host class. This is intentionally
    // explicit rather than a DNS or private-address heuristic.
    const loopback = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);
    const hostMatch = base && loopback.has(base.hostname) && loopback.has(target.hostname)
      ? true : base && target.hostname === base.hostname;
    return base && target.protocol === base.protocol && hostMatch &&
      target.port === base.port &&
      (target.path === base.path || base.path === "/" || target.path.startsWith(`${base.path}/`));
  });
}

const UNSUPPORTED_HTTP_CLIENTS = new Set(["http", "https", "httpie", "xh"]);

// A deliberately small shell lexer. It does not execute or expand anything;
// it recovers literal word concatenation and recursively exposes the contents
// of command substitutions, which are executable shell positions. A word that
// needs variable expansion is marked dynamic and never guessed at.
function withoutHeredocBodies(source) {
  // Only expansions execute inside an unquoted heredoc body. Preserve those
  // executable fragments for the ordinary lexer, while replacing literal
  // body text (including strings that merely spell "curl URL") with blanks.
  const bodyExpansions = (line) => {
    const out = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === "\\") { i += 2; continue; }
      if (line[i] === "`" || (line[i] === "$" && line[i + 1] === "(")) {
        const start = i, backtick = line[i] === "`";
        let depth = backtick ? 0 : 1, quote = null, escaped = false;
        i += backtick ? 1 : 2;
        for (; i < line.length; i += 1) {
          const c = line[i];
          if (escaped) { escaped = false; continue; }
          if (c === "\\") { escaped = true; continue; }
          if (backtick) { if (c === "`") { i += 1; break; } continue; }
          if (quote) { if (c === quote) quote = null; continue; }
          if (c === "'" || c === '"') { quote = c; continue; }
          if (c === "(" && line[i - 1] === "$") depth += 1;
          else if (c === ")" && --depth === 0) { i += 1; break; }
        }
        out.push(line.slice(start, i));
        continue;
      }
      i += 1;
    }
    return out.join(" ; ");
  };
  const declarations = (line) => {
    const found = [];
    let i = 0, quote = null, escaped = false;
    while (i < line.length) {
      const c = line[i];
      if (escaped) { escaped = false; i += 1; continue; }
      if (quote) {
        if (c === "\\" && quote === '"') escaped = true;
        else if (c === quote) quote = null;
        i += 1; continue;
      }
      if (c === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) break;
      if (c === "'" || c === '"') { quote = c; i += 1; continue; }
      if (c === "\\") { escaped = true; i += 1; continue; }
      if (line.slice(i, i + 2) !== "<<" || line[i + 2] === "<") { i += 1; continue; }
      i += 2;
      const tabs = line[i] === "-";
      if (tabs) i += 1;
      while (/\s/.test(line[i] ?? "")) i += 1;
      let delimiter = "", delimiterQuote = null, quoted = false;
      while (i < line.length) {
        const d = line[i];
        if (!delimiterQuote && /[\s;&|()<>]/.test(d)) break;
        if (d === "\\" && delimiterQuote !== "'") {
          quoted = true;
          if (i + 1 < line.length) delimiter += line[i + 1];
          i += 2; continue;
        }
        if (d === "'" || d === '"') {
          quoted = true;
          if (delimiterQuote === d) delimiterQuote = null;
          else if (!delimiterQuote) delimiterQuote = d;
          else delimiter += d;
          i += 1; continue;
        }
        delimiter += d; i += 1;
      }
      if (delimiter) found.push({ delimiter, tabs, quoted });
    }
    return found;
  };
  const lines = source.split("\n"), pending = [], out = [];
  for (const line of lines) {
    if (pending.length) {
      const current = pending[0], candidate = current.tabs ? line.replace(/^\t+/, "") : line;
      if (candidate === current.delimiter) { pending.shift(); out.push(""); }
      else out.push(current.quoted ? "" : bodyExpansions(line));
      continue;
    }
    out.push(line);
    pending.push(...declarations(line));
  }
  return out.join("\n");
}

function lexShell(source) {
  source = withoutHeredocBodies(source);
  const tokens = [], substitutions = [];
  let i = 0, word = "", inWord = false, dynamic = false;
  const flush = () => {
    if (inWord) tokens.push({ type: "word", value: word, dynamic });
    word = ""; inWord = false; dynamic = false;
  };
  const add = (value) => { word += value; inWord = true; };
  const variable = () => {
    dynamic = true; inWord = true;
    i += 1;
    if (source[i] === "{") {
      const end = source.indexOf("}", i + 1);
      i = end < 0 ? source.length : end + 1;
    } else {
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i])) i += 1;
    }
  };
  const parenBody = () => {
    const start = i + 2;
    let j = start, depth = 1, quote = null, escaped = false;
    for (; j < source.length; j += 1) {
      const c = source[j];
      if (escaped) { escaped = false; continue; }
      if (quote === "'") { if (c === "'") quote = null; continue; }
      if (quote === '"') {
        if (c === "\\") { escaped = true; continue; }
        if (c === '"') quote = null;
        continue;
      }
      if (c === "\\") { escaped = true; continue; }
      if (c === "'" || c === '"') { quote = c; continue; }
      if (c === "(" && source[j - 1] === "$") depth += 1;
      else if (c === ")" && --depth === 0) break;
    }
    substitutions.push(source.slice(start, j));
    dynamic = true; inWord = true;
    i = j < source.length ? j + 1 : source.length;
  };
  const backtickBody = () => {
    let j = i + 1, body = "";
    for (; j < source.length; j += 1) {
      if (source[j] === "\\" && j + 1 < source.length) { body += source[++j]; continue; }
      if (source[j] === "`") break;
      body += source[j];
    }
    substitutions.push(body);
    dynamic = true; inWord = true;
    i = j < source.length ? j + 1 : source.length;
  };

  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      flush();
      if (c === "\n") tokens.push({ type: "op", value: "\n" });
      i += 1; continue;
    }
    if (c === "#" && !inWord) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      continue;
    }
    const two = source.slice(i, i + 2);
    if (["&&", "||"].includes(two)) {
      flush(); tokens.push({ type: "op", value: two }); i += 2; continue;
    }
    // Redirection operands are data, not argv. In particular a here-string can
    // contain an own URL while curl's actual target is arbitrary. Keep the
    // surrounding simple command together and let simpleCommands drop exactly
    // the operand. Process substitution is different: its body executes.
    if ((c === "<" || c === ">") && source[i + 1] === "(") {
      flush(); tokens.push({ type: "op", value: "(" }); i += 2; continue;
    }
    if (!inWord) {
      const redirection = source.slice(i).match(/^(?:\d*)(?:<<<|<<|>>|<>|>&|<&|>|<)|^&>>?/);
      if (redirection) {
        flush(); tokens.push({ type: "redir", value: redirection[0] });
        i += redirection[0].length; continue;
      }
    }
    if ([";", "|", "&", "(", ")"].includes(c)) {
      flush(); tokens.push({ type: "op", value: c }); i += 1; continue;
    }
    if (c === "\\") {
      if (i + 1 < source.length) add(source[i + 1]);
      i += 2; continue;
    }
    if (c === "'") {
      inWord = true; i += 1;
      while (i < source.length && source[i] !== "'") add(source[i++]);
      if (source[i] === "'") i += 1;
      continue;
    }
    if (c === '"') {
      inWord = true; i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === "\\" && i + 1 < source.length) { add(source[i + 1]); i += 2; }
        else if (source[i] === "$" && source[i + 1] === "(") parenBody();
        else if (source[i] === "$") variable();
        else if (source[i] === "`") backtickBody();
        else add(source[i++]);
      }
      if (source[i] === '"') i += 1;
      continue;
    }
    if (c === "$" && source[i + 1] === "(") { parenBody(); continue; }
    if (c === "$") { variable(); continue; }
    if (c === "`") { backtickBody(); continue; }
    add(c); i += 1;
  }
  flush();
  return { tokens, substitutions };
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(.*)$/s;
function commandStart(words) {
  let i = 0, escaped = false, splitBody = null;
  const assignments = () => {
    while (i < words.length && ASSIGNMENT.test(words[i].value)) {
      if (words[i].value === `${PLUMBING_ESCAPE}=1`) escaped = true;
      i += 1;
    }
  };
  assignments();
  for (let wrappers = 0; wrappers < 32 && i < words.length; wrappers += 1) {
    const name = basename(words[i].value);
    if (name === "command") {
      i += 1;
      while (words[i]?.value?.startsWith("-")) i += 1;
      assignments();
      continue;
    }
    if (name === "env") {
      i += 1;
      while (words[i]?.value?.startsWith("-") && !ASSIGNMENT.test(words[i].value)) {
        const option = words[i++].value;
        if (option === '-S' || option === '--split-string') {
          splitBody = words[i++]; return { index: i, escaped, splitBody };
        }
        if (option.startsWith('--split-string=') || option.startsWith('-S')) {
          splitBody = { ...words[i - 1], value: option.slice(option.startsWith('-S') ? 2 : '--split-string='.length) };
          return { index: i, escaped, splitBody };
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(option)) i += 1;
      }
      assignments();
      continue;
    }
    if (["exec", "time", "nohup"].includes(name)) {
      i += 1;
      // Common wrapper switches do not turn their following command into
      // prose. Options whose own value is not a command are consumed here.
      while (words[i]?.value?.startsWith("-")) {
        const option = words[i++].value;
        if ((name === "exec" && option === "-a") ||
            (name === "time" && ["-f", "--format", "-o", "--output"].includes(option))) i += 1;
      }
      assignments();
      continue;
    }
    if (name === "sudo") {
      i += 1;
      while (words[i]?.value?.startsWith("-")) {
        const option = words[i++].value;
        if (["-u", "--user", "-g", "--group", "-h", "--host", "-p", "--prompt",
          "-C", "--chdir", "-R", "--chroot", "-r", "--role", "-t", "--type"].includes(option)) i += 1;
      }
      assignments();
      continue;
    }
    if (name === "nice") {
      i += 1;
      while (words[i]?.value?.startsWith("-")) {
        const option = words[i++].value;
        if (["-n", "--adjustment"].includes(option)) i += 1;
      }
      assignments();
      continue;
    }
    if (name === "timeout") {
      i += 1;
      while (words[i]?.value?.startsWith("-")) {
        const option = words[i++].value;
        if (["-k", "--kill-after", "-s", "--signal"].includes(option)) i += 1;
      }
      if (words[i]) i += 1; // duration
      assignments();
      continue;
    }
    if (name === "stdbuf") {
      i += 1;
      while (words[i]?.value?.startsWith("-")) {
        const option = words[i++].value;
        if (["-i", "-o", "-e", "--input", "--output", "--error"].includes(option)) i += 1;
      }
      assignments();
      continue;
    }
    if (["if", "then", "elif", "else", "fi", "while", "until", "do", "done", "esac", "!", "{", "coproc"].includes(name)) {
      i += 1;
      assignments();
      continue;
    }
    break;
  }
  return { index: i, escaped, splitBody };
}

const VALUE_OPTIONS = new Set([
  "--abstract-unix-socket", "--aws-sigv4", "--cacert", "--capath", "--cert", "--cert-type",
  "--connect-timeout", "--connect-to", "--cookie", "--cookie-jar", "--data", "--data-ascii",
  "--data-binary", "--data-raw", "--data-urlencode", "--dns-interface", "--dns-ipv4-addr",
  "--dns-ipv6-addr", "--form", "--form-string", "--header", "--interface", "--key",
  "--key-type", "--limit-rate", "--max-time", "--output", "--proxy", "--proxy-header",
  "--referer", "--request", "--resolve", "--retry", "--unix-socket", "--upload-file", "--user",
  "--user-agent", "--write-out", "--body-data", "--ca-certificate", "--certificate", "--directory-prefix",
  "--header", "--input-file", "--output-document", "--password", "--post-data", "--post-file",
  "--proxy-user", "--referer", "--timeout", "--user", "--user-agent",
]);
const SHORT_VALUE_CHARS = {
  curl: new Set("AbcCdDeEFHKmoPQrT uUw xXYyz".replaceAll(" ", "")),
  wget: new Set("aAbBDeFiloOPQtTUw"),
};

function shortNeedsNext(value, tool) {
  const valueChars = SHORT_VALUE_CHARS[tool] ?? new Set();
  for (let i = 1; i < value.length; i += 1) {
    if (!valueChars.has(value[i])) continue;
    // Everything after a value-taking short flag is its attached value. It
    // consumes the next word only when the flag is last in the cluster.
    return i === value.length - 1;
  }
  return false;
}

function targetWords(words, start, tool) {
  const targets = [];
  let dynamic = false, options = true;
  for (let i = start; i < words.length; i += 1) {
    const word = words[i];
    if (word.dynamic) dynamic = true;
    if (options && word.value === "--") { options = false; continue; }
    if (options && word.value === "--url") {
      if (words[i + 1]) { targets.push(words[++i]); if (words[i].dynamic) dynamic = true; }
      continue;
    }
    if (options && word.value.startsWith("--url=")) {
      targets.push({ ...word, value: word.value.slice("--url=".length) }); continue;
    }
    if (options && word.value.startsWith("--")) {
      const [option] = word.value.split("=", 1);
      if (VALUE_OPTIONS.has(option) && !word.value.includes("=") && words[i + 1]) i += 1;
      continue;
    }
    if (options && /^-[^-]/.test(word.value)) {
      if (shortNeedsNext(word.value, tool) && words[i + 1]) i += 1;
      continue;
    }
    targets.push(word);
  }
  return { targets, dynamic };
}

function simpleCommands(tokens) {
  const groups = [];
  let current = [], redirectionOperand = false;
  for (const token of tokens) {
    if (token.type === "redir") { redirectionOperand = true; continue; }
    if (token.type === "op") {
      if (current.length) groups.push(current);
      current = []; redirectionOperand = false;
    } else if (redirectionOperand) redirectionOperand = false;
    else current.push(token);
  }
  if (current.length) groups.push(current);
  return groups;
}

export function inspectShellHttp(command, bases) {
  if (typeof command !== "string") return { deny: false };
  const visit = (source, depth = 0) => {
    if (depth > 12) return { deny: false, unsupported: "dynamic_url" };
    const { tokens, substitutions } = lexShell(source);
    let unsupported = null;
    for (const nested of substitutions) {
      const result = visit(nested, depth + 1);
      if (result.deny) return result;
      unsupported ||= result.unsupported;
    }
    const shell = "(?:busybox\\s+)?(?:sh|bash|dash|ksh|zsh)";
    const hereString = new RegExp(`\\b${shell}\\s+<<<\\s*(?:"([\\s\\S]*?)"|'([\\s\\S]*?)'|([^\\n;|&]+))`, "gi");
    for (const match of source.matchAll(hereString)) {
      const result = visit(match[1] ?? match[2] ?? match[3] ?? "", depth + 1);
      if (result.deny) return result;
      unsupported ||= result.unsupported;
    }
    const heredoc = new RegExp(`\\b${shell}\\s+<<-?\\s*([A-Za-z_][A-Za-z0-9_]*)[\\t ]*\\n([\\s\\S]*?)\\n\\1(?:\\n|$)`, "gi");
    for (const match of source.matchAll(heredoc)) {
      const result = visit(match[2], depth + 1);
      if (result.deny) return result;
      unsupported ||= result.unsupported;
    }
    for (const words of simpleCommands(tokens)) {
      const { index, escaped, splitBody } = commandStart(words);
      if (splitBody) {
        if (splitBody.dynamic || words.slice(index).some(word => word.dynamic)) unsupported ||= 'dynamic_url';
        else {
          // env appends the remaining argv after splitting its string. Quote
          // those already-lexed words to preserve their literal boundaries.
          const tail = words.slice(index).map(word => "'" + word.value.replace(/'/g, "'\\''") + "'").join(' ');
          const result = visit(splitBody.value + ' ' + tail, depth + 1);
          if (result.deny && !escaped) return result;
          unsupported ||= result.unsupported;
        }
        continue;
      }
      const executable = basename(words[index]?.value ?? "").toLowerCase();
      if (["sh", "bash", "dash", "ksh", "zsh", "busybox"].includes(executable)) {
        const c = words.slice(index + 1).findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word.value));
        if (c >= 0) {
          const body = words[index + 1 + c + 1];
          if (body?.dynamic) unsupported ||= "dynamic_url";
          else if (body) {
            const result = visit(body.value, depth + 1);
            if (result.deny) return result;
            unsupported ||= result.unsupported;
          }
        }
        continue;
      }
      if (UNSUPPORTED_HTTP_CLIENTS.has(executable)) {
        if (words.slice(index + 1).some((word) => !word.dynamic && normalUrl(word.value)))
          unsupported ||= "client";
        continue;
      }
      if (executable !== "curl" && executable !== "wget") continue;
      const { targets, dynamic } = targetWords(words, index + 1, executable);
      if (!escaped && targets.some((word) => !word.dynamic && targetIsOwn(word.value, bases)))
        return { deny: true };
      if (dynamic) unsupported ||= "dynamic_url";
    }
    return { deny: false, ...(unsupported ? { unsupported } : {}) };
  };
  return visit(command);
}

function safeConfigText(path) {
  if (!path) return null;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_CONFIG_BYTES)
      return null;
    return readFileSync(path, "utf8");
  } catch { return null; }
}

function decision(reason) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny", permissionDecisionReason: reason } };
}

function runManagedHook(configPath, doctor, pinnedBaseUrls = []) {
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_INPUT_BYTES + 1 - size));
      const count = readSync(0, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count;
      if (size > MAX_INPUT_BYTES) { process.stdout.write(JSON.stringify(decision("Hook input exceeded 1 MB; denied fail-closed."))); return; }
      chunks.push(chunk.subarray(0, count));
    }
  } catch { return; }
  const raw = Buffer.concat(chunks, size);
  let input;
  try { input = JSON.parse(raw.toString("utf8")); } catch { return; }
  if (input?.hook_event_name !== "PreToolUse" || input?.tool_name !== "Bash" ||
      typeof input?.tool_input?.command !== "string") return;
  const text = safeConfigText(configPath);
  const runtime = process.env.API_BASE_URL ? [process.env.API_BASE_URL] : [];
  const bases = text ? configuredBaseUrls(text, [...pinnedBaseUrls, ...runtime]) :
    configuredBaseUrls("{}", [...pinnedBaseUrls, ...runtime]);
  if (!inspectShellHttp(input.tool_input.command, bases).deny) return;
  const reason = `Direct shell HTTP to this repo's configured API is blocked. ` +
    `Use the verified check: ${doctor}. Genuine plumbing probe escape: prefix only that command with ` +
    `${PLUMBING_ESCAPE}=1.`;
  process.stdout.write(JSON.stringify(decision(reason)));
}

if (process.argv[2] === MANAGED_ARG) {
  try {
    const pinned = JSON.parse(unb64(process.argv[5]) || "[]");
    runManagedHook(unb64(process.argv[3]), unb64(process.argv[4]),
      Array.isArray(pinned) ? pinned : []);
  }
  catch { /* fail open with no command-bearing diagnostics */ }
}
