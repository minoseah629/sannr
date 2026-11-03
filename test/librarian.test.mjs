import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync,
  writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { MCP_SERVER_KEY, TOOL_NAME } from "../lib/brand.mjs";
import {
  LIBRARIAN_MCP_SERVER_KEY, LIBRARIAN_NAME, librarianServerEntry, librarianTargets,
} from "../lib/librarian.mjs";
import {
  CODEX_TOOL_TIMEOUT_SEC, librarianMcpRegistration, planTarget, projectEntry,
  projectPathProblem, writeText,
} from "../lib/connect.mjs";
import { resolveConfig } from "../lib/config.mjs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(ROOT, "bin", "cli.mjs");
const SERVER = join(ROOT, "server.mjs");
const AGENT_NAME = LIBRARIAN_NAME;
const READ_ONLY_SERVER = LIBRARIAN_MCP_SERVER_KEY;

function scratch() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "librarian-")));
  const home = join(dir, ".home");
  mkdirSync(home);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info:", "  title: fixture", "  version: 1.0.0",
    "paths:", "  /pieces:", "    get:", "      responses:", "        '200':",
    "          description: ok", "",
  ].join("\n"));
  return { dir, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, ".config") } };
}

function cli(dir, args, env) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, env, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function serverRpc(messages, env = {}) {
  const run = spawnSync(process.execPath, [SERVER], {
    input: `${messages.map(JSON.stringify).join("\n")}\n`,
    env: { ...process.env, API_BASE_URL: "http://127.0.0.1:1", API_TIMEOUT_MS: "10", ...env },
    encoding: "utf8", timeout: 5000,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  return run.stdout.trim().split("\n").filter(Boolean).map(JSON.parse);
}

function agentPaths(root, name = AGENT_NAME) {
  return {
    claude: join(root, ".claude", "agents", `${name}.md`),
    codex: join(root, ".codex", "agents", `${name}.toml`),
  };
}

function claudeBody(text) {
  const match = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(text);
  assert.ok(match, "Claude agent is not frontmatter plus a body");
  return match[1];
}

function codexInstructions(text) {
  const encoded = /^developer_instructions\s*=\s*("(?:\\.|[^"\\])*")\s*$/m.exec(text)?.[1];
  assert.ok(encoded, "Codex developer_instructions is not a deterministic TOML string");
  return JSON.parse(encoded);
}

function legacyInstall(root) {
  const entry = projectEntry(root, resolveConfig(root));
  const registration = librarianMcpRegistration(root, entry);
  const existing = existsSync(registration.target.file)
    ? readFileSync(registration.target.file, "utf8") : null;
  const registrationPlan = planTarget(existing, registration.target,
    registration.entry, registration.key);
  assert.notEqual(registrationPlan.action, "conflict", registrationPlan.reason);
  writeText(registration.target.file, registrationPlan.text, root);
  const agents = librarianTargets(root, entry, { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC });
  for (const agent of agents) writeText(agent.to, agent.body, root);
  return { entry, registration, agents };
}

test("the shared renderers produce one librarian charter in both read-only host definitions", () => {
  const { dir } = scratch();
  const entry = projectEntry(dir, {});
  const targets = librarianTargets(dir, entry, { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC });
  const claude = targets.find(({ host }) => host === "claude-code").body;
  const codex = targets.find(({ host }) => host === "codex").body;

  assert.equal(claudeBody(claude), codexInstructions(codex),
    "the host definitions did not receive the same charter bytes");
  assert.match(claude, new RegExp(`^name: ${AGENT_NAME}$`, "m"));
  assert.match(codex, new RegExp(`^name = ${JSON.stringify(AGENT_NAME)}$`, "m"));
  assert.doesNotMatch(claude, /^model:/m, "Claude must inherit the caller's model");
  assert.doesNotMatch(codex, /^model\s*=/m, "Codex must inherit the caller's model");

  // No shell/editor/file-write tool, and no binding to the ordinary polymorphic
  // MCP server. Both hosts receive only the explicitly restricted server.
  assert.match(claude, /^tools: Read, Grep, Glob, mcp__/m);
  assert.doesNotMatch(claude, /\b(?:Bash|Write|Edit|NotebookEdit)\b/);
  assert.match(claude, new RegExp(`mcp__${READ_ONLY_SERVER}__${TOOL_NAME}`));
  assert.doesNotMatch(claude, /^mcpServers:/m,
    "Claude custom-agent frontmatter does not support inline MCP definitions");
  const claudeRegistration = librarianServerEntry(entry);
  assert.equal(claudeRegistration.env.API_REQUEST_READ_ONLY, "1");
  assert.match(codex, /^sandbox_mode = "read-only"$/m);
  assert.match(codex, new RegExp(String.raw`^\[mcp_servers\.${READ_ONLY_SERVER}\]$`, "m"));
  assert.match(codex, /^env = \{ .*"API_REQUEST_READ_ONLY" = "1" \}$/m);
  assert.match(codex, new RegExp(String.raw`^enabled_tools = \[${JSON.stringify(TOOL_NAME)}\]$`, "m"));

  const charter = claudeBody(claude);
  for (const phrase of ["contract digest", "verified_at", "git confidence", "safe reads",
    "declared suites", "blast radius", "map edges", "provenance", "proposal handoff",
    "Never write integration or feature code", "third-party credentials",
    "Never make the product decision"])
    assert.match(charter, new RegExp(phrase, "i"), `charter omitted: ${phrase}`);
});

test("the librarian MCP policy refuses every request-shaped write before execution", async () => {
  const { readOnlyRequestProblem } = await import("../lib/librarian.mjs");
  assert.equal(readOnlyRequestProblem({ method: "GET", path: "/pieces" }), null);
  assert.equal(readOnlyRequestProblem({ method: "HEAD", path: "/pieces" }), null);
  assert.equal(readOnlyRequestProblem({ method: "GET", path: "/pieces", params: { state: "open" },
    headers: { "If-None-Match": "etag", Accept: "application/json" } }), null,
  "ordinary conditional-read headers and query filters must remain available");
  assert.equal(readOnlyRequestProblem({ requests: [
    { method: "GET", path: "/pieces" }, { method: "HEAD", path: "/pieces/1" },
  ] }), null);

  for (const args of [
    { method: "POST", path: "/pieces", body: { name: "x" } },
    { method: "PUT", path: "/pieces/1" },
    { method: "PATCH", path: "/pieces/1" },
    { method: "DELETE", path: "/pieces/1" },
    { method: "GET", path: "/pieces", save_to: "./source.mjs" },
    { method: "GET", path: "/pieces", files: { upload: "./source.mjs" } },
    { method: "GET", path: "/pieces", body: { _method: "POST" } },
    { method: "GET", path: "/pieces", body: null },
    { method: "GET", path: "/pieces", body_type: "json" },
    { method: "GET", path: "/pieces", idempotency_key: "write-like" },
    { method: "GET", path: "/pieces", headers: { "X-HTTP-Method-Override": "DELETE" } },
    { method: "GET", path: "/pieces", headers: { "x_method_override": "PATCH" } },
    { method: "GET", path: "/pieces", params: { _method: "POST" } },
    { method: "GET", path: "/pieces?method-override=DELETE" },
    { method: "GET", path: "/pieces?http_method_override=PATCH" },
    { curl: "curl http://example.invalid/pieces" },
    { requests: [{ method: "GET", path: "/pieces" }, { method: "POST", path: "/pieces" }] },
    { requests: [{ method: "GET", path: "/pieces", save_to: "./source.mjs" }] },
    { method: "POST", path: "/pieces", API_REQUEST_READ_ONLY: "0" },
  ]) {
    const problem = readOnlyRequestProblem(args);
    assert.equal(problem?.code, "LIBRARIAN_READ_ONLY", JSON.stringify(args));
    assert.match(problem.message, /not sent|refused/i);
  }
});

test("the opt-in MCP process advertises and enforces the restricted tool without changing the default", () => {
  const refusedSave = join(mkdtempSync(join(tmpdir(), "librarian-save-")), "source.mjs");
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: TOOL_NAME,
      arguments: { method: "POST", path: "/pieces", API_REQUEST_READ_ONLY: "0" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: TOOL_NAME,
      arguments: { method: "GET", path: "/pieces", save_to: refusedSave } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: TOOL_NAME,
      arguments: { requests: [
        { method: "GET", path: "/pieces" }, { method: "POST", path: "/pieces" },
      ] } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: TOOL_NAME,
      arguments: { method: "GET", path: "/pieces?_method=POST",
        headers: { "X-HTTP-Method-Override": "POST" } } } },
  ];
  const restricted = serverRpc(messages, { API_REQUEST_READ_ONLY: "1" });
  const tool = restricted.find((reply) => reply.id === 1).result.tools[0];
  assert.equal(tool.annotations.readOnlyHint, true);
  assert.equal(tool.annotations.destructiveHint, false);
  assert.deepEqual(tool.inputSchema.properties.method.enum, ["GET", "HEAD"]);
  assert.equal(tool.inputSchema.properties.save_to, undefined);
  assert.equal(tool.inputSchema.properties.files, undefined);
  assert.equal(tool.inputSchema.properties.curl, undefined);
  assert.equal(tool.inputSchema.properties.body, undefined);
  assert.equal(tool.inputSchema.properties.body_type, undefined);
  assert.equal(tool.inputSchema.properties.idempotency_key, undefined);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.requests.items.additionalProperties, false);
  for (const key of ["body", "body_type", "idempotency_key", "files", "save_to"])
    assert.equal(tool.inputSchema.properties.requests.items.properties[key], undefined);
  const refusal = restricted.find((reply) => reply.id === 2).result;
  assert.equal(refusal.isError, true);
  assert.equal(JSON.parse(refusal.content[0].text).error.code, "LIBRARIAN_READ_ONLY");
  for (const id of [3, 4, 5])
    assert.equal(JSON.parse(restricted.find((reply) => reply.id === id).result.content[0].text)
      .error.code, "LIBRARIAN_READ_ONLY");
  assert.ok(!existsSync(refusedSave), "restricted save_to wrote a source file before refusing");

  const ordinary = serverRpc([{ jsonrpc: "2.0", id: 1, method: "tools/list" }]);
  const ordinaryTool = ordinary[0].result.tools[0];
  assert.equal(ordinaryTool.annotations.readOnlyHint, false);
  assert.equal(ordinaryTool.annotations.destructiveHint, true);
  assert.ok(ordinaryTool.inputSchema.properties.save_to,
    "the opt-in wrapper mutated the ordinary MCP discovery shape");
});

test("legacy librarian artifacts remain removable without returning to connect or doctor", () => {
  const { dir, env } = scratch();
  const before = JSON.parse(cli(dir, ["doctor", "--offline", "--json"], env).out);
  assert.equal(before.checks.find((c) => c.name === "librarian"), undefined,
    "doctor still diagnoses a retired product surface");

  const first = JSON.parse(cli(dir, ["connect", "--json"], env).out);
  assert.equal(first.agents, undefined);
  assert.equal(first.librarian_mcp, undefined);
  legacyInstall(dir);
  const paths = agentPaths(dir);
  const firstBytes = [readFileSync(paths.claude), readFileSync(paths.codex)];

  const second = cli(dir, ["connect", "--json"], env);
  assert.equal(second.code, 0, second.out);
  assert.deepEqual([readFileSync(paths.claude), readFileSync(paths.codex)], firstBytes,
    "plain connect changed retired generated definitions");
  const after = JSON.parse(cli(dir, ["doctor", "--offline", "--json"], env).out);
  assert.equal(after.checks.find((c) => c.name === "librarian"), undefined);

  writeFileSync(paths.claude, `${readFileSync(paths.claude, "utf8")}\n# team edit\n`);
  const expectedRegistration = librarianMcpRegistration(dir,
    projectEntry(dir, resolveConfig(dir))).entry;
  const actualRegistration = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))
    .mcpServers[READ_ONLY_SERVER];
  assert.deepEqual(actualRegistration, expectedRegistration,
    "the legacy fixture must match the exact registration unwire recognizes");
  const unwired = JSON.parse(cli(dir, ["unwire", "--json"], env).out);
  assert.equal(unwired.librarian_mcp.action, "removed");
  assert.equal(unwired.agents.find((a) => a.host === "claude-code").action, "left");
  assert.equal(unwired.agents.find((a) => a.host === "codex").action, "removed");
  assert.ok(existsSync(paths.claude), "unwire deleted an edited agent definition");
  assert.ok(!existsSync(paths.codex), "unwire left its exact generated Codex agent");
});

test("librarian renderers stay dry, path-safe, and renameable for experiment callers", () => {
  const dry = scratch();
  const preview = librarianTargets(dry.dir, projectEntry(dry.dir, {}),
    { toolTimeoutSec: CODEX_TOOL_TIMEOUT_SEC });
  assert.equal(preview.length, 2);
  assert.ok(!existsSync(join(dry.dir, ".claude")));
  assert.ok(!existsSync(join(dry.dir, ".codex")));

  const linked = scratch();
  const outside = mkdtempSync(join(tmpdir(), "librarian-outside-"));
  symlinkSync(outside, join(linked.dir, ".claude"));
  const linkedTarget = librarianTargets(linked.dir, projectEntry(linked.dir, {}))
    .find((a) => a.host === "claude-code");
  assert.match(projectPathProblem(linked.dir, linkedTarget.to), /symbolic link/);
  assert.ok(!existsSync(join(outside, "agents")), "the path check followed .claude outside the project");

  const moduleUrl = new URL("../lib/librarian.mjs", import.meta.url).href;
  const renamed = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { librarianTargets } from ${JSON.stringify(moduleUrl)}; ` +
    `console.log(JSON.stringify(librarianTargets("/repo", {command:"node",args:["server.mjs"]})))`], {
    env: { ...process.env, API_CONTEXT_PRODUCT_NAME: "truthmark" }, encoding: "utf8",
  });
  assert.equal(renamed.status, 0, renamed.stderr);
  const renamedTargets = JSON.parse(renamed.stdout);
  assert.match(renamedTargets[0].to, /truthmark-librarian\.md$/);
  assert.match(renamedTargets[0].body, /^name: truthmark-librarian$/m);
  assert.match(renamedTargets[1].to, /truthmark-librarian\.toml$/);
  assert.match(renamedTargets[1].body, /^name = "truthmark-librarian"$/m);

  rmSync(outside, { recursive: true, force: true });
});

test("the ordinary MCP registration does not silently inherit librarian restrictions", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const ordinary = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))
    .mcpServers[MCP_SERVER_KEY];
  assert.equal(ordinary.env?.API_REQUEST_READ_ONLY, undefined);
});

test("the legacy restricted registration planner refuses to reclaim an edited boundary", () => {
  const { dir, env } = scratch();
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({
    mcpServers: { postgres: { command: "npx", args: ["postgres-mcp"] } }, keep: true,
  }, null, 2) + "\n");
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  const { registration } = legacyInstall(dir);
  const connected = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(connected.mcpServers.postgres, { command: "npx", args: ["postgres-mcp"] });
  assert.equal(connected.keep, true);
  const ordinary = structuredClone(connected.mcpServers[MCP_SERVER_KEY]);

  connected.mcpServers[READ_ONLY_SERVER].env.API_REQUEST_READ_ONLY = "0";
  writeFileSync(join(dir, ".mcp.json"), `${JSON.stringify(connected, null, 2)}\n`);
  const refused = planTarget(readFileSync(join(dir, ".mcp.json"), "utf8"),
    registration.target, registration.entry, registration.key);
  assert.equal(refused.action, "conflict");
  const after = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.equal(after.mcpServers[READ_ONLY_SERVER].env.API_REQUEST_READ_ONLY, "0",
    "connect silently reclaimed an edited security boundary");
  assert.deepEqual(after.mcpServers[MCP_SERVER_KEY], ordinary,
    "restricted-registration handling changed the ordinary MCP entry");

  const unwired = JSON.parse(cli(dir, ["unwire", "--json"], env).out);
  assert.equal(unwired.librarian_mcp.action, "left");
  assert.equal(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"))
    .mcpServers[READ_ONLY_SERVER].env.API_REQUEST_READ_ONLY, "0");
});

test("every non-canonical restricted entry is conflict/left, never updated or deleted", () => {
  const mutations = [
    ["extra argument", (entry) => entry.args.push("--team-wrapper")],
    ["changed command", (entry) => { entry.command = "/team/node-wrapper"; }],
    ["changed evidence", (entry) => { entry.env.API_EVIDENCE = "/team/evidence"; }],
    ["extra environment", (entry) => { entry.env.TEAM_MODE = "1"; }],
    ["extra top-level field", (entry) => { entry.team_wrapper = true; }],
  ];
  for (const [label, mutate] of mutations) {
    const { dir, env } = scratch();
    assert.equal(cli(dir, ["connect", "--json"], env).code, 0, label);
    const { registration } = legacyInstall(dir);
    const file = join(dir, ".mcp.json");
    const edited = JSON.parse(readFileSync(file, "utf8"));
    const ordinary = structuredClone(edited.mcpServers[MCP_SERVER_KEY]);
    mutate(edited.mcpServers[READ_ONLY_SERVER]);
    const editedRestricted = structuredClone(edited.mcpServers[READ_ONLY_SERVER]);
    writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`);

    const reconnect = planTarget(readFileSync(file, "utf8"), registration.target,
      registration.entry, registration.key);
    assert.equal(reconnect.action, "conflict", label);
    let after = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(after.mcpServers[READ_ONLY_SERVER], editedRestricted,
      `${label}: reconnect clobbered the local restricted entry`);
    assert.deepEqual(after.mcpServers[MCP_SERVER_KEY], ordinary,
      `${label}: reconnect changed the ordinary entry`);

    const unwire = JSON.parse(cli(dir, ["unwire", "--json"], env).out);
    assert.equal(unwire.librarian_mcp.action, "left", label);
    after = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(after.mcpServers[READ_ONLY_SERVER], editedRestricted,
      `${label}: unwire deleted the local restricted entry`);
  }
});

test("doctor ignores retired librarian state, and ordinary MCP symlinks remain unfollowed", () => {
  const { dir, env } = scratch();
  assert.equal(cli(dir, ["connect", "--json"], env).code, 0);
  legacyInstall(dir);
  const file = join(dir, ".mcp.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  delete config.mcpServers[READ_ONLY_SERVER];
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  const doctor = JSON.parse(cli(dir, ["doctor", "--offline", "--json"], env).out)
    .checks.find((check) => check.name === "librarian");
  assert.equal(doctor, undefined);

  const linked = scratch();
  const outside = join(mkdtempSync(join(tmpdir(), "librarian-mcp-link-")), "config.json");
  const untouched = '{"mcpServers":{"theirs":{"command":"safe"}}}\n';
  writeFileSync(outside, untouched);
  symlinkSync(outside, join(linked.dir, ".mcp.json"));
  const refused = cli(linked.dir, ["connect", "--json"], linked.env);
  assert.equal(refused.code, 1);
  assert.equal(readFileSync(outside, "utf8"), untouched);
  assert.equal(JSON.parse(refused.out).librarian_mcp, undefined);
  cli(linked.dir, ["unwire", "--json"], linked.env);
  assert.equal(readFileSync(outside, "utf8"), untouched);
});
