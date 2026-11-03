import { LAYOUT } from "../lib/layout.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codexServerBlock, projectEntry, SERVER_PATH } from "../lib/connect.mjs";
import { bindSetupTool, currentSetupBinding, setupBindingId, validSetupBinding } from "../lib/setup-binding.mjs";
import { LIBRARIAN_READ_ONLY_ENV } from "../lib/librarian.mjs";
import { discoverMcpRegistrations } from "../lib/mcp-registrations.mjs";
import { HOME_ENV_NAME, MCP_SERVER_KEY } from "../lib/brand.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "setup-binding-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}
function isolatedEnv(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:API_|SANNR_)/.test(key)));
  return { ...env, SANNR_HOME: join(root, "registry") };
}
function inventory(entry, root, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { cwd: root,
      env: { ...isolatedEnv(root), ...entry.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("MCP inventory timed out")); }, 10_000);
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const result = output.split("\n").filter(Boolean).flatMap((line) => {
        try { return [JSON.parse(line)]; } catch { return []; }
      }).find((message) => message.id === 2);
      if (result) { clearTimeout(timer); child.kill(); resolve(result.result.tools); }
    });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      if (!output.includes('"id":2')) { clearTimeout(timer); reject(new Error(`MCP exited (${code}): ${errors}`)); }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "setup-fixture", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

test("setup binding is deterministic, ignores its own field, and distinguishes registration identities", (t) => {
  const root = fixture(t), other = fixture(t);
  const entry = projectEntry(root);
  const binding = entry.env.API_SETUP_BINDING;
  assert.ok(validSetupBinding(binding));
  assert.equal(projectEntry(root).env.API_SETUP_BINDING, binding);
  assert.equal(setupBindingId(root, entry), binding);
  assert.equal(setupBindingId(root, { ...entry,
    env: Object.fromEntries(Object.entries({ ...entry.env, API_SETUP_BINDING: "ignored" }).reverse()) }), binding);
  assert.notEqual(projectEntry(other).env.API_SETUP_BINDING, binding);
  assert.notEqual(projectEntry(root, {}, { nodePath: "/different/node" }).env.API_SETUP_BINDING, binding);
  assert.notEqual(projectEntry(root, {}, { evidencePath: join(root, "other-evidence") }).env.API_SETUP_BINDING, binding);
});

test("storage overrides affect the binding while unrelated shell values stay private", (t) => {
  const root = fixture(t), cwd = join(root, "nested setup");
  const env = { [HOME_ENV_NAME]: "../isolated grants", API_USAGE_LOG: "../logs/usage.jsonl",
    API_AUTH: "bearer:PRIVATE_TOKEN", PRIVATE_TOKEN: "fixture-secret-must-not-be-copied",
    UNRELATED_SETTING: "private-shell-value" };
  const entry = projectEntry(root, {}, { env, cwd });
  assert.equal(entry.env[HOME_ENV_NAME], join(root, "isolated grants"));
  assert.equal(entry.env.API_USAGE_LOG, join(root, "logs", "usage.jsonl"));
  assert.equal(entry.env.API_AUTH, undefined);
  assert.equal(entry.env.PRIVATE_TOKEN, undefined);
  assert.equal(entry.env.UNRELATED_SETTING, undefined);
  const binding = entry.env.API_SETUP_BINDING;
  assert.equal(setupBindingId(root, entry), binding);
  assert.equal(projectEntry(root, {}, { env: { ...env, PRIVATE_TOKEN: "different-secret" }, cwd })
    .env.API_SETUP_BINDING, binding);
  for (const changed of [
    { ...env, [HOME_ENV_NAME]: "../other grants" },
    { ...env, API_USAGE_LOG: "../other log.jsonl" },
  ]) assert.notEqual(projectEntry(root, {}, { env: changed, cwd }).env.API_SETUP_BINDING, binding);

  const omitted = projectEntry(root, {}, { env: {} });
  assert.equal(Object.hasOwn(omitted.env, HOME_ENV_NAME), false);
  assert.equal(Object.hasOwn(omitted.env, "API_USAGE_LOG"), false);
  const empty = projectEntry(root, {}, { env: { [HOME_ENV_NAME]: "", API_USAGE_LOG: "" }, cwd });
  assert.equal(Object.hasOwn(empty.env, HOME_ENV_NAME), false);
  assert.equal(empty.env.API_USAGE_LOG, "", "an empty log override must not become a directory path");
});

test("discovered host registrations roundtrip the generated identity and reject stale or disagreeing markers", (t) => {
  const root = fixture(t);
  const config = file(join(root, LAYOUT.environments), '{"v":1}\n');
  const original = projectEntry(root, { file: config });
  const claude = (entry) => file(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: entry } }));
  const codex = (entry) => file(join(root, ".codex", "config.toml"), codexServerBlock(entry));
  claude(original); codex(original);
  const discovered = discoverMcpRegistrations(root);
  assert.equal(discovered.length, 2);
  assert.ok(discovered.every((row) => row.cwd === root && row.host && row.file));
  assert.equal(currentSetupBinding(root, discovered), original.env.API_SETUP_BINDING,
    "normalized discovery metadata must not change the registration identity");
  writeFileSync(config, '{"v":1,"defaults":{"budget":800}}\n');
  assert.equal(currentSetupBinding(root, discoverMcpRegistrations(root)), null,
    "stored markers no longer identify the current config bytes");
  const updated = projectEntry(root, { file: config });
  claude(updated);
  assert.equal(currentSetupBinding(root, discoverMcpRegistrations(root)), null,
    "one updated host must not hide a stale registration on the other host");
  codex(updated);
  assert.equal(currentSetupBinding(root, discoverMcpRegistrations(root)), updated.env.API_SETUP_BINDING);
});

test("current binding abstains on missing, invalid, disabled, or unreconstructable setup records", (t) => {
  const root = fixture(t), entry = projectEntry(root);
  const row = { key: MCP_SERVER_KEY, ...entry, cwd: root };
  const unrelated = { key: "other-server", code: "MCP_REGISTRATION_UNSUPPORTED" };
  assert.equal(currentSetupBinding(root, []), null);
  assert.equal(currentSetupBinding(root, [unrelated]), null);
  assert.equal(currentSetupBinding(root, [unrelated, row]), entry.env.API_SETUP_BINDING);
  for (const invalid of [
    { ...row, env: {} },
    { ...row, env: { ...row.env, API_SETUP_BINDING: "not-a-binding" } },
    { ...row, code: "MCP_REGISTRATION_DISABLED" },
    { ...row, args: [] },
    { ...row, cwd: join(root, "different-workspace") },
    { ...row, env: { ...row.env, API_EVIDENCE: join(root, "changed-evidence") } },
  ]) assert.equal(currentSetupBinding(root, [row, invalid]), null);
  assert.equal(currentSetupBinding(root, [row, { key: ".mcp.json", file: ".mcp.json",
    code: "MCP_REGISTRATION_CONFIG_INVALID" }]), null,
  "an unreadable host config may conceal a conflicting setup registration");
});

test("config, contract, and same-version runtime changes update the binding without exposing their contents", (t) => {
  const root = fixture(t);
  const config = file(join(root, LAYOUT.environments), '{"v":1,"fixture":"private-config-value"}\n');
  const contract = file(join(root, "openapi.json"), '{"openapi":"3.0.0","paths":{}}\n');
  const runtime = join(root, "package");
  file(join(runtime, "package.json"), '{"version":"0.1.0"}\n');
  for (const path of ["server.mjs", "lib/stdio-server.mjs", "lib/client.mjs", "lib/config.mjs",
    "lib/librarian.mjs", "lib/setup-binding.mjs", "lib/brand.mjs"])
    file(join(runtime, path), readFileSync(join(ROOT, path)));
  const current = () => projectEntry(root, { file: config, contract }, { serverPath: join(runtime, "server.mjs") }).env.API_SETUP_BINDING;
  const original = current();
  assert.equal(current(), original);
  assert.ok(!original.includes("private-config-value"));
  writeFileSync(config, '{"v":1,"fixture":"changed-private-value"}\n');
  const changedConfig = current();
  assert.notEqual(changedConfig, original);
  writeFileSync(contract, '{"openapi":"3.0.0","paths":{"/new":{}}}\n');
  const changedContract = current();
  assert.notEqual(changedContract, changedConfig);
  writeFileSync(join(runtime, "lib", "client.mjs"), readFileSync(join(runtime, "lib", "client.mjs"), "utf8") + "\n// Same-version fixture upgrade.\n");
  assert.notEqual(current(), changedContract);
  assert.equal(JSON.parse(readFileSync(join(runtime, "package.json"))).version, "0.1.0");
});

test("tool metadata accepts only the exact binding grammar and leaves shared tool definitions unchanged", () => {
  const tool = { name: "fixture", description: "Original guidance.", inputSchema: { type: "object" } };
  const binding = `setup-v1:${"a".repeat(64)}`;
  assert.ok(validSetupBinding(binding));
  const bound = bindSetupTool(tool, { API_SETUP_BINDING: binding });
  assert.equal(bound.description, `Original guidance.\n\nSetup binding: ${binding}`);
  assert.equal(tool.description, "Original guidance.");
  assert.equal(bound.inputSchema, tool.inputSchema);
  for (const value of [undefined, "", "arbitrary instructions", `${binding}\n`, `${binding} extra`,
    `setup-v1:${"A".repeat(64)}`, `setup-v1:${"a".repeat(63)}`]) {
    assert.equal(validSetupBinding(value), false);
    assert.equal(bindSetupTool(tool, { API_SETUP_BINDING: value }), tool);
  }
});

test("fresh stdio inventory exposes the exact binding with zero HTTP and distinguishes stale metadata", async (t) => {
  const root = fixture(t);
  let hits = 0;
  const server = createServer((_request, response) => { hits += 1; response.end("fixture"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const config = file(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: "local",
    environments: { local: { baseUrl: `http://127.0.0.1:${server.address().port}` } } }));
  const original = projectEntry(root, { file: config });
  const [tool] = await inventory(original, root);
  assert.equal(tool.name, "api_request");
  assert.ok(tool.description.endsWith(`Setup binding: ${original.env.API_SETUP_BINDING}`));
  assert.equal(tool.annotations.readOnlyHint, false);
  writeFileSync(config, readFileSync(config, "utf8") + "\n");
  const updated = projectEntry(root, { file: config });
  assert.notEqual(updated.env.API_SETUP_BINDING, original.env.API_SETUP_BINDING);
  assert.ok(!tool.description.includes(`Setup binding: ${updated.env.API_SETUP_BINDING}`),
    "tool visibility from the previous binding cannot confirm the updated setup");
  const [fresh] = await inventory(updated, root);
  assert.ok(fresh.description.endsWith(`Setup binding: ${updated.env.API_SETUP_BINDING}`));
  const [restricted] = await inventory(updated, root, { [LIBRARIAN_READ_ONLY_ENV]: "1" });
  assert.ok(restricted.description.endsWith(`Setup binding: ${updated.env.API_SETUP_BINDING}`));
  assert.equal(restricted.annotations.readOnlyHint, true);
  assert.deepEqual(restricted.inputSchema.properties.method.enum, ["GET", "HEAD"]);
  assert.equal(restricted.inputSchema.properties.save_to, undefined);
  assert.equal(hits, 0);
});

test("the full setup binding survives the host description cap with auth and a realistic base URL", async (t) => {
  const root = fixture(t);
  const baseUrl = "https://api.example.test/customer-platform/v1/regional-route";
  assert.equal(baseUrl.length, 60);
  const config = file(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: "local",
    environments: { local: { baseUrl, auth: "bearer:SETUP_BINDING_FIXTURE_TOKEN" } } }));
  const entry = projectEntry(root, { file: config });
  const marker = `Setup binding: ${entry.env.API_SETUP_BINDING}`;
  // Reproduce the host's discovery projection, including its description prefix.
  const hostPrefix = "x".repeat(91), hostCap = 2048;
  for (const [name, env] of [["ordinary", {}], ["read-only librarian", { [LIBRARIAN_READ_ONLY_ENV]: "1" }]]) {
    await t.test(name, async (t) => {
      const [tool] = await inventory(entry, root, env);
      assert.equal(tool.name, "api_request");
      assert.ok(tool.description.includes(baseUrl));
      assert.match(tool.description, /Auth values missing at startup; authentication is unverified\./);
      assert.doesNotMatch(tool.description, /Authentication is configured and applied automatically/);
      assert.ok(tool.description.endsWith(`\n\n${marker}`));
      const projected = hostPrefix + tool.description;
      t.diagnostic(`description=${tool.description.length}; host prefix=${hostPrefix.length}; cap=${hostCap}; marker budget=${hostCap - projected.length}`);
      assert.ok(projected.slice(0, hostCap).endsWith(marker),
        "the complete setup identity must reach the agent after the host caps the description");
    });
  }
});

test("stdio auth metadata distinguishes invalid, missing and present references without API traffic", async (t) => {
  const root = fixture(t);
  for (const [auth, env, expected] of [
    ['basic:ONLY_ONE', {}, /Auth reference invalid; automatic authentication unavailable\./],
    ['basic:SETUP_USER:SETUP_PASS', { SETUP_USER: 'synthetic-user' }, /Auth values missing at startup; authentication is unverified\./],
    ['basic:SETUP_USER:SETUP_PASS', { SETUP_USER: 'synthetic-user', SETUP_PASS: 'synthetic-password' }, /Auth values present at startup; authentication is unverified\./],
    ['basic:SETUP_USER:SETUP_PASS', { SETUP_USER: 'invalid:user', SETUP_PASS: 'synthetic-password' }, /Auth values invalid at startup; automatic authentication unavailable\./],
  ]) {
    const config = file(join(root, LAYOUT.environments), JSON.stringify({ v: 1, default: 'local',
      environments: { local: { baseUrl: 'http://127.0.0.1:1', auth } } }));
    const [tool] = await inventory(projectEntry(root, { file: config }), root, env);
    assert.match(tool.description, expected);
    assert.doesNotMatch(tool.description, /Authentication is configured and applied automatically/);
    for (const value of Object.values(env)) assert.equal(tool.description.includes(value), false);
  }
});

test("standalone client TOOL exports remain unbound when the setup environment is set", async (t) => {
  const root = fixture(t);
  const binding = projectEntry(root).env.API_SETUP_BINDING;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e",
      `import { TOOL } from ${JSON.stringify(join(dirname(SERVER_PATH), "lib", "client.mjs"))}; if (TOOL.description.includes('Setup binding:')) process.exit(1);`],
    { cwd: root, env: { ...isolatedEnv(root), API_SETUP_BINDING: binding }, stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => { try { assert.equal(code, 0); resolve(); } catch (error) { reject(error); } });
  });
});
