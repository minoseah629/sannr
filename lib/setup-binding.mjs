// A local setup identity lets a fresh agent distinguish the registration it
// just installed from an inherited tool with the same name. This is an opaque
// change detector, not API validation or a security attestation.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MCP_SERVER_KEY } from "./brand.mjs";
import { pinnedMcpPackage } from "./advertisement.mjs";

export const SETUP_BINDING_ENV = "API_SETUP_BINDING";
const PREFIX = "setup-v1:";
const VALID_BINDING = /^setup-v1:[a-f0-9]{64}$/;
const RUNTIME_FILES = ["server.mjs", "lib/stdio-server.mjs", "lib/client.mjs",
  "lib/config.mjs", "lib/librarian.mjs", "lib/setup-binding.mjs", "lib/brand.mjs"];
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function validSetupBinding(value) {
  return typeof value === "string" && value.length === PREFIX.length + 64 && VALID_BINDING.test(value);
}

function fileIdentity(path) {
  if (!path) return null;
  try { return { state: "present", digest: digest(readFileSync(path)) }; }
  catch (error) { return { state: error?.code === "ENOENT" ? "missing" : "unreadable" }; }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value)
    .sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]));
  return value;
}

/** Hash only local identity. Config/contract contents contribute digests and
 * are never included in returned text, errors, or tool metadata. The bounded
 * runtime inputs distinguish same-version alpha builds at the same path. */
export function setupBindingId(root, entry, { configText } = {}) {
  const env = Object.fromEntries(Object.entries(entry.env ?? {}).filter(([key]) => key !== SETUP_BINDING_ENV));
  const npmPackage = pinnedMcpPackage(entry);
  const packageRoot = npmPackage ? null : dirname(resolve(root, entry.args[0]));
  const identity = {
    version: 1,
    root: resolve(root),
    registration: { ...entry, env },
    config: env.API_CONFIG && configText !== undefined
      ? { state: "present", digest: digest(configText) }
      : fileIdentity(env.API_CONFIG ? resolve(root, env.API_CONFIG) : null),
    contract: fileIdentity(env.API_CONTRACT ? resolve(root, env.API_CONTRACT) : null),
    // A registry version is immutable. Hash its exact invocation rather than
    // npm's disposable cache location, which can change without changing the
    // runtime. Direct source bindings still detect local code modifications.
    runtime: npmPackage ? { source: "npm-exact-version", package: npmPackage }
      : RUNTIME_FILES.map((path) => [path, fileIdentity(join(packageRoot, path))]),
  };
  return PREFIX + digest(JSON.stringify(canonical(identity)));
}

/** Reuse a registration marker only while its current local identity still
 * matches, and every applicable host agrees. Discovery adds host/file/key and
 * a default cwd; those are not fields in projectEntry's generated identity.
 * A changed cwd cannot be reconstructed as that generated shape, so abstain. */
export function currentSetupBinding(root, registrations) {
  if (!Array.isArray(registrations)) return null;
  // A host config that could not be read may conceal a conflicting binding.
  if (registrations.some((row) => row.code && row.file && row.key === row.file)) return null;
  const applicable = registrations.filter((row) => row.key === MCP_SERVER_KEY);
  if (!applicable.length) return null;
  let current = null;
  for (const row of applicable) {
    const binding = row.env?.[SETUP_BINDING_ENV];
    if (row.code || !validSetupBinding(binding) || typeof row.command !== "string" ||
        !Array.isArray(row.args) ||
        (!pinnedMcpPackage(row) && (row.args.length !== 1 || typeof row.args[0] !== "string")) ||
        (row.cwd !== undefined && (typeof row.cwd !== "string" || resolve(root, row.cwd) !== resolve(root))))
      return null;
    try {
      if (setupBindingId(root, { command: row.command, args: row.args, env: row.env }) !== binding)
        return null;
    } catch { return null; }
    if (current !== null && current !== binding) return null;
    current = binding;
  }
  return current;
}

/** Bind only the stdio tool's public metadata, keeping the shared TOOL export
 * untouched. Strict grammar prevents arbitrary environment prose from being
 * injected into the agent's tool instructions. */
export function bindSetupTool(tool, env = process.env) {
  const binding = env[SETUP_BINDING_ENV];
  if (!validSetupBinding(binding)) return tool;
  return { ...tool, description: `${tool.description ?? ""}\n\nSetup binding: ${binding}` };
}
