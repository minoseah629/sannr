// Parse inspector flags separately from the server's command and arguments.
// Tool argument values live only in this in-memory object, never in a report.
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { CONTEXT_FILE } from "./context.mjs";
import { MCP_REGISTRATION_FILES } from "./mcp-registrations.mjs";

const invalid = (message, code = "MCP_ARGS_INVALID") => Object.assign(new Error(message), { code });

export function safeMcpSummaryPath(root, destination) {
  const target = resolve(destination);
  const refuse = () => { throw invalid("MCP summary destination must be a regular, unlinked file outside context and registration paths.", "MCP_SUMMARY_UNSAFE_PATH"); };
  if ([CONTEXT_FILE, ...MCP_REGISTRATION_FILES].some(file => target === resolve(root, file))) refuse();
  for (let current = target;; current = dirname(current)) {
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || (current === target && !stat.isFile())) refuse();
    } catch (error) {
      if (error.code === "MCP_SUMMARY_UNSAFE_PATH") throw error;
      if (error.code !== "ENOENT") throw invalid("Could not inspect the MCP summary destination.", "MCP_SUMMARY_UNSAFE_PATH");
    }
    if (dirname(current) === current) break;
  }
  return target;
}

export function writeMcpSummary(root, destination, report) {
  let descriptor;
  try {
    const target = safeMcpSummaryPath(root, destination);
    // Refuse a replaced leaf symlink and inspect links before truncating bytes.
    descriptor = openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) throw invalid("MCP summary destination must be a regular, unlinked file.", "MCP_SUMMARY_UNSAFE_PATH");
    ftruncateSync(descriptor, 0);
    writeFileSync(descriptor, report, "utf8");
  } catch (error) {
    if (error.code === "MCP_SUMMARY_UNSAFE_PATH") throw error;
    throw invalid("Could not write the MCP summary.", error.code === "ELOOP" ? "MCP_SUMMARY_UNSAFE_PATH" : "MCP_SUMMARY_WRITE_FAILED");
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export function parseMcpInspectOptions(raw) {
  const execute = [], kept = [], toolArgs = Object.create(null);
  let executeUnsafe = false, label, json = false, summary, only, dryRun = false;
  const valueAfter = (index, flag, code) => {
    if (!raw[index + 1] || raw[index + 1].startsWith("--")) throw invalid(`${flag} needs a value.`, code);
    return raw[index + 1];
  };
  for (let i = 0; i < raw.length; i += 1) {
    const flag = raw[i];
    if (flag === "--execute") { execute.push(valueAfter(i, flag, "MCP_EXECUTE_NAME_REQUIRED")); i += 1; }
    else if (flag === "--execute-unsafe") executeUnsafe = true;
    else if (flag === "--json") json = true;
    else if (flag === "--only") { only = valueAfter(i, flag, "MCP_ONLY_REQUIRED"); i += 1; }
    else if (flag === "--dry-run") dryRun = true;
    else if (flag === "--label") { label = valueAfter(i, flag, "MCP_LABEL_REQUIRED"); i += 1; }
    else if (flag === "--summary") { summary = valueAfter(i, flag, "MCP_SUMMARY_PATH_REQUIRED"); i += 1; }
    else if (flag === "--args") {
      const value = valueAfter(i, flag, "MCP_ARGS_INVALID"); i += 1;
      const equals = value.indexOf("=");
      if (equals < 1) throw invalid("--args needs tool=<JSON object>; field: arguments.");
      const name = value.slice(0, equals);
      let parsed;
      try { parsed = JSON.parse(value.slice(equals + 1)); }
      catch { throw invalid("--args contains invalid JSON; field: arguments."); }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalid("--args must be a JSON object; field: arguments.");
      if (Object.hasOwn(toolArgs, name)) throw invalid("--args repeats a tool; field: arguments.");
      toolArgs[name] = parsed;
    } else kept.push(flag);
  }
  const target = kept[0];
  if (!target) {
    if (execute.length || executeUnsafe || Object.keys(toolArgs).length || label) throw invalid("Registered inspection enumerates only; use an explicit target for per-tool execution or a custom label.", "MCP_REGISTRATION_ENUMERATE_ONLY");
    return { registered: true, only, dryRun, json, summary };
  }
  if (only !== undefined || dryRun) throw invalid("--only and --dry-run apply to project registrations without an explicit target.", "MCP_REGISTRATION_OPTIONS_INVALID");
  if (/^https?:\/\//i.test(target) && kept.length > 1) throw invalid("An HTTP target does not accept command arguments.", "MCP_TARGET_INVALID");
  return {
    ...(/^https?:\/\//i.test(target) ? { url: target } : { command: target, args: kept.slice(1) }),
    execute, executeUnsafe, toolArgs, label, json, summary,
  };
}
