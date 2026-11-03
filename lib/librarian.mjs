import { LAYOUT } from './layout.mjs';
// LIBRARIAN — one behavioural charter, rendered into both supported agent hosts.
//
// The chosen L1-A boundary is read-only plus proposal handoff: a maintenance
// delegate that cannot mutate the yardstick is safer than one disciplined only
// by prose. The task agent remains the accountable writer and can review each
// proposed knowledge or declared-spec change before applying it.

import { join } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import { PRODUCT, TOOL_NAME } from "./brand.mjs";

export const LIBRARIAN_NAME = `${PRODUCT}-librarian`;
export const LIBRARIAN_DESCRIPTION =
  `Read-only ${PRODUCT} estate librarian: answers with provenance and proposes reviewed knowledge updates.`;
// NAME-1, 2026-10-06: this separate restricted experimental registration
// keeps its historical identity and generated agent allowlists. Renaming the
// ordinary server must not strand or duplicate this security boundary.
export const LIBRARIAN_MCP_SERVER_KEY = `${TOOL_NAME.replaceAll("_", "-")}-read-only`;
export const LIBRARIAN_READ_ONLY_ENV = "API_REQUEST_READ_ONLY";
export const LIBRARIAN_DEFINITION_INVALID = "LIBRARIAN_DEFINITION_INVALID";

// This is deliberately the ONLY copy of the behavioural instructions. Host
// renderers add syntax around these exact bytes; neither owns a paraphrase.
export const LIBRARIAN_CHARTER = `# ${PRODUCT} librarian charter

You are the read-only maintenance delegate for this repository's API knowledge. You are a proposer, never the owner of source code, declared contracts, or product decisions.

## What you do

- Answer what the estate knows about named API operations from ${LAYOUT.context}, contracts, declared suites, and map evidence.
- Detect staleness mechanically from the contract digest, \`verified_at\`, and git confidence. Distinguish fresh evidence from stale or unsupported assertions.
- Re-verify only through safe reads (GET or HEAD) and already-declared suites. Never turn a verification task into a write.
- Maintain ${LAYOUT.context} through the proposal handoff below; because this agent is read-only, the calling task agent reviews and applies accepted notes.
- Compute blast radius from map edges and name the affected callers, providers, and operations.
- Attach provenance to every answer: operation key, knowledge source, confidence, verification time, and relevant contract or evidence identity. Say plainly when evidence is absent.

## What you never do

- Never write integration or feature code, edit source files, or apply your own proposal.
- Never commit to or edit the DECLARED specification. Propose a contract patch only; the agent that audits declared-versus-measured truth cannot own its yardstick.
- Never execute an undeclared write or use a request method other than GET or HEAD.
- Never hold, request, print, or persist third-party credentials. Refer only to configured environment-variable names.
- Never make the product decision. Present evidence, confidence, blast radius, and alternatives to the accountable task agent.

## Proposal handoff

When maintenance would change ${LAYOUT.context} or a declared contract, do not edit it. Return a structured proposal with: target file; named operation; exact proposed note or patch; supporting safe-read or declared-suite evidence; provenance; staleness reason; blast radius; and an explicit \`not applied\` status. The calling task agent alone decides whether to apply it.
`;

const yamlValue = (value) => JSON.stringify(String(value));
const tomlValue = yamlValue;

export function librarianServerEntry(entry) {
  // Put the enforcement flag last so even a caller-supplied base entry cannot
  // dilute this wrapper by smuggling the same environment key with value 0.
  return { ...entry, env: { ...(entry.env ?? {}), [LIBRARIAN_READ_ONLY_ENV]: "1" } };
}

export function renderClaudeLibrarian(entry) {
  // Claude custom agents reference project-registered MCP tools by allowlisted
  // name; they do not support an inline server definition in this frontmatter.
  void entry;
  return [
    "---",
    `name: ${LIBRARIAN_NAME}`,
    `description: ${yamlValue(LIBRARIAN_DESCRIPTION)}`,
    `tools: Read, Grep, Glob, mcp__${LIBRARIAN_MCP_SERVER_KEY}__${TOOL_NAME}`,
    "---",
    LIBRARIAN_CHARTER,
  ].join("\n");
}

export function renderCodexLibrarian(entry, { toolTimeoutSec = 330 } = {}) {
  const restricted = librarianServerEntry(entry);
  const env = Object.entries(restricted.env ?? {})
    .map(([key, value]) => `${tomlValue(key)} = ${tomlValue(value)}`).join(", ");
  return [
    `name = ${tomlValue(LIBRARIAN_NAME)}`,
    `description = ${tomlValue(LIBRARIAN_DESCRIPTION)}`,
    `developer_instructions = ${tomlValue(LIBRARIAN_CHARTER)}`,
    `sandbox_mode = "read-only"`,
    "",
    `[mcp_servers.${LIBRARIAN_MCP_SERVER_KEY}]`,
    `command = ${tomlValue(restricted.command)}`,
    `args = [${restricted.args.map(tomlValue).join(", ")}]`,
    ...(env ? [`env = { ${env} }`] : []),
    `enabled_tools = [${tomlValue(TOOL_NAME)}]`,
    `tool_timeout_sec = ${toolTimeoutSec}`,
    `default_tools_approval_mode = "prompt"`,
    "",
  ].join("\n");
}

export function librarianTargets(root, entry, opts = {}) {
  return [{
    host: "claude-code", label: "Claude Code",
    to: join(root, ".claude", "agents", `${LIBRARIAN_NAME}.md`),
    body: renderClaudeLibrarian(entry),
  }, {
    host: "codex", label: "Codex",
    to: join(root, ".codex", "agents", `${LIBRARIAN_NAME}.toml`),
    body: renderCodexLibrarian(entry, opts),
  }];
}

/** Select the one definition the active host will actually discover. Keeping
 * this selection on top of librarianTargets means connect, harness2, and the
 * fleet cannot acquire subtly different copies of the charter. */
export function librarianTarget(root, provider, entry, opts = {}) {
  const host = provider === "codex" ? "codex" : provider === "claude"
    ? "claude-code" : null;
  if (!host) throw new Error(`unsupported librarian host provider: ${provider}`);
  return librarianTargets(root, entry, opts).find((target) => target.host === host);
}

/** Return a stable refusal when the native definition is absent or is not the
 * exact regular-file output of the shared renderer. lstat is intentional: a
 * symlink to the right bytes is still an ambient path escape, not a delivered
 * experiment artifact. */
export function librarianDefinitionProblem(root, provider, entry, opts = {}) {
  let target;
  try { target = librarianTarget(root, provider, entry, opts); }
  catch { return { code: LIBRARIAN_DEFINITION_INVALID,
    reason: "librarian_definition_renderer_input_invalid", path: root }; }
  let stat;
  try { stat = lstatSync(target.to); }
  catch (error) {
    return { code: LIBRARIAN_DEFINITION_INVALID,
      reason: error?.code === "ENOENT" ? "librarian_definition_missing"
        : "librarian_definition_unreadable",
      path: target.to };
  }
  if (!stat.isFile()) return { code: LIBRARIAN_DEFINITION_INVALID,
    reason: stat.isSymbolicLink() ? "librarian_definition_symlink"
      : "librarian_definition_not_regular",
    path: target.to };
  let actual;
  try { actual = readFileSync(target.to); }
  catch { return { code: LIBRARIAN_DEFINITION_INVALID,
    reason: "librarian_definition_unreadable", path: target.to }; }
  if (!actual.equals(Buffer.from(target.body)))
    return { code: LIBRARIAN_DEFINITION_INVALID,
      reason: "librarian_definition_mismatch", path: target.to };
  const other = librarianTargets(root, entry, opts).find(({ host }) => host !== target.host);
  try {
    lstatSync(other.to);
    return { code: LIBRARIAN_DEFINITION_INVALID,
      reason: "librarian_definition_unexpected_host", path: other.to };
  } catch (error) {
    if (error?.code !== "ENOENT") return { code: LIBRARIAN_DEFINITION_INVALID,
      reason: "librarian_definition_unreadable", path: other.to };
  }
  return null;
}

export function assertLibrarianDefinition(root, provider, entry, opts = {}) {
  const problem = librarianDefinitionProblem(root, provider, entry, opts);
  if (!problem) return;
  const error = new Error(`[librarian] librarian definition is invalid: ${problem.reason} (${problem.path})`);
  error.code = problem.code;
  error.reason = problem.reason;
  error.path = problem.path;
  throw error;
}

const READ_METHODS = new Set(["GET", "HEAD"]);
const METHOD_OVERRIDE_HEADERS = new Set([
  "x-http-method", "x-http-method-override", "x-method-override",
]);
const METHOD_OVERRIDE_PARAMS = new Set([
  "_method", "method_override", "http_method", "http_method_override",
]);

function methodOverrideReason(request) {
  for (const key of Object.keys(request?.headers ?? {})) {
    const normalized = key.toLowerCase().replaceAll("_", "-");
    if (METHOD_OVERRIDE_HEADERS.has(normalized)) return `header ${key} can override the HTTP method`;
  }
  const parameterKeys = new Set(Object.keys(request?.params ?? {})
    .map((key) => key.toLowerCase().replaceAll("-", "_")));
  try {
    const url = new URL(String(request?.path ?? ""), "http://librarian.invalid");
    for (const key of url.searchParams.keys())
      parameterKeys.add(key.toLowerCase().replaceAll("-", "_"));
  } catch { /* malformed paths are rejected by the ordinary client */ }
  for (const key of parameterKeys)
    if (METHOD_OVERRIDE_PARAMS.has(key)) return `query parameter ${key} can override the HTTP method`;
  return null;
}

/** Return the policy refusal before the server calls client.mjs. The scan is
 * atomic over an envelope: one write-shaped step rejects the entire batch, so
 * a preceding GET cannot execute before a later POST is noticed. */
export function readOnlyRequestProblem(args) {
  const requests = Array.isArray(args?.requests) ? args.requests : [args ?? {}];
  const candidates = [args ?? {}, ...requests, ...(Array.isArray(args?.finally) ? args.finally : [])];
  for (const [index, request] of candidates.entries()) {
    const has = (key) => Boolean(request) && typeof request === "object"
      && Object.hasOwn(request, key);
    if ((has("protocol") && request.protocol !== "http") || ["graphql", "rpc", "grpc", "websocket"].some(has))
      return refusal("protocol adapters require the accountable task client; this boundary permits HTTP GET/HEAD only", index);
    if (has('capture_context')) return refusal('capture_context writes shared operation knowledge', index);
    if (has("curl"))
      return refusal("curl input is ambiguous in the librarian boundary; use an explicit GET or HEAD request", index);
    if (has("save_to"))
      return refusal("save_to can write a caller-selected file", index);
    if (has("files"))
      return refusal("files can upload caller-selected bytes", index);
    for (const key of ["body", "body_type", "idempotency_key"])
      if (has(key)) return refusal(`${key} is write-oriented and unavailable`, index);
    const override = methodOverrideReason(request);
    if (override) return refusal(override, index);
    const method = String(request?.method ?? "GET").toUpperCase();
    if (!READ_METHODS.has(method))
      return refusal(`${method} is not GET or HEAD`, index, method);
  }
  return null;
}

// Apply only after atomic policy admission. The ordinary client captures
// configured API observations by default; that local write is unavailable to
// the librarian even when the caller omitted every write-oriented argument.
export function readOnlyExecutionArgs(args) {
  return { ...args, capture_context: false,
    ...(Array.isArray(args.requests) ? {
      requests: args.requests.map(request => ({ ...request, capture_context: false })),
    } : {}),
    ...(Array.isArray(args.finally) ? { finally: args.finally.map(request => ({ ...request, capture_context: false })) } : {}) };
}

function refusal(reason, index, method = null) {
  return {
    kind: "policy",
    code: "LIBRARIAN_READ_ONLY",
    message: `The librarian MCP boundary refused this call before execution; no request was sent (${reason}).`,
    details: { request_index: Math.max(0, index - 1), ...(method ? { method } : {}) },
    next: "Use an explicit GET or HEAD with no files or save_to, or hand a proposed write to the accountable task agent.",
  };
}

/** A truthful discovery shape for the restricted server without mutating the
 * ordinary TOOL object imported by every existing MCP registration. */
export function readOnlyTool(tool) {
  const { curl: _curl, files: _files, save_to: _saveTo, body: _body,
    body_type: _bodyType, idempotency_key: _idempotencyKey,
    protocol: _protocol, graphql: _graphql, rpc: _rpc, grpc: _grpc, websocket: _websocket,
    timeout_ms: _timeout, capture_context: _captureContext, ...safeProperties } =
    tool.inputSchema.properties;
  const batchProperties = Object.fromEntries(
    ["method", "path", "upstream", "params", "fields", "headers", "paginate", "expect"]
      .filter((key) => safeProperties[key]).map((key) => [key, safeProperties[key]]));
  const restricted = {
    ...tool,
    description: `Read-only librarian binding. GET and HEAD only; file upload, save_to and shared context recording are unavailable. Automatic context capture is disabled in this binding. ${tool.description}`,
    annotations: { ...tool.annotations, readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      ...tool.inputSchema,
      additionalProperties: false,
      properties: {
        ...safeProperties,
        method: { ...safeProperties.method, enum: ["GET", "HEAD"] },
        requests: {
          ...safeProperties.requests,
          description: "Run several GET/HEAD reads atomically through the librarian policy. Any write-oriented or method-override field refuses the entire batch before its first request.",
          items: {
            type: "object", required: ["path"], additionalProperties: false,
            properties: {
              ...batchProperties,
              method: { ...safeProperties.method, enum: ["GET", "HEAD"] },
              id: { description: "Optional caller correlation id." },
              capture: safeProperties.requests.items.properties.capture,
              wait_for: safeProperties.requests.items.properties.wait_for,
            },
          },
        },
      },
      anyOf: [{ required: ["path"] }, { required: ["requests"] }],
    },
  };
  if (safeProperties.finally) restricted.inputSchema.properties.finally = {
    ...safeProperties.finally, items: restricted.inputSchema.properties.requests.items,
  };
  return restricted;
}
