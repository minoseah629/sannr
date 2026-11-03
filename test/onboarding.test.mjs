import { LAYOUT } from "../lib/layout.mjs";
// First-run setup, exercised only in disposable repositories. These checks
// deliberately configure a live local fixture to prove setup stays static.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { HOME_ENV_NAME, MCP_SERVER_KEY, PRODUCT, STATE_DIR_NAME, TOOL_NAME, CONTEXT_BASENAME } from "../lib/brand.mjs";
import { emptyContext, saveContext, liveContractDigest, readContract } from "../lib/context.mjs";
import { discoverMcpRegistrations } from "../lib/mcp-registrations.mjs";
import { currentSetupBinding } from "../lib/setup-binding.mjs";
import { stackCatalog } from "../lib/stacks.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const read = (path) => readFileSync(path, "utf8");
const json = (path) => JSON.parse(read(path));
// STACKS-1A (2026-10-06): fresh setup owns a named store; pre-existing
// single-store fixtures continue to exercise the compatibility layout.
const knowledgePath = (root) => {
  const stack = stackCatalog(root).stacks[0];
  return stack ? join(stack.folder, CONTEXT_BASENAME) : join(root, LAYOUT.context);
};
const contract = (paths = ["/health", "/items"]) => JSON.stringify({
  openapi: "3.0.0", info: { title: "Onboarding fixture", version: "1" },
  paths: Object.fromEntries(paths.map((path) => [path, { get: {
    responses: { 200: { description: "OK" } },
  } }])),
});

function fixture(t, files = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "sannr-onboarding-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "consumer repo with spaces"), home = join(base, "home");
  mkdirSync(repo); mkdirSync(home);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(?:API_|SANNR_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, SANNR_HOME: join(home, "registry") });
  return { repo, home, env };
}

function cli({ repo, env }, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: repo, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Onboarding command timed out: ${args.join(" ")}\n${err}`));
    }, 20_000);
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { err += chunk; });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

function tree(root, prefix = "") {
  return Object.fromEntries(readdirSync(join(root, prefix), { withFileTypes: true })
    .filter((entry) => entry.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const path = join(prefix, entry.name);
      return entry.isDirectory() ? [[`${path}/`, "directory"], ...Object.entries(tree(root, path))]
        : [[path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex")]];
    }));
}

function result(command) {
  assert.equal(command.code, 0, command.err || command.out);
  return JSON.parse(command.out);
}

function assertPendingHost(report) {
  assert.equal(report.v, 1);
  assert.equal(report.command, "start");
  assert.equal(report.requests_executed, 0);
  assert.equal(report.setup.host.state, "confirmation_required");
  assert.equal(report.setup.host.server, MCP_SERVER_KEY);
  assert.equal(report.setup.host.tool, TOOL_NAME);
  assert.equal(typeof report.setup.host.binding_id, "string");
  assert.ok(report.setup.host.binding_id.length > 0, "host confirmation must identify this project's binding");
  assert.ok(report.setup.continuation.prompt.includes(TOOL_NAME));
  assert.equal(report.setup.api.state, "not_checked");
  assert.match(report.connection.verify, / start --dry-run --json$/,
    "the advertised verification command must only inspect setup");
  assert.doesNotMatch(report.connection.next,
    /\b(?:curl|wget|doctor|learn)\b|\brequest\s+(?:GET|HEAD|POST|PUT|PATCH|DELETE)\b/i,
    "the next setup step must not instruct the agent to contact an API");
}

test("start installs an empty repo and leaves the next agent usable setup guidance", async (t) => {
  const f = fixture(t, { "AGENTS.md": "Keep these project instructions.\n",
    "CLAUDE.md": "Keep these Claude instructions.\n" });
  const report = result(await cli(f, "start", "--json"));
  assertPendingHost(report);
  assert.equal(report.status, "configured");
  assert.equal(report.setup.wiring.state, "configured");
  assert.equal(report.setup.context.state, "missing");
  assert.equal(report.setup.context.operations, 0);
  assert.equal(report.setup.context.verified, 0);
  assert.equal(report.setup.api.configured, false);
  assert.equal(report.inventory.state, "empty");
  assert.equal(existsSync(join(f.repo, LAYOUT.context)), false,
    "setup must not invent a contract to make the knowledge milestone look ready");
  for (const [path, original] of [["AGENTS.md", "Keep these project instructions."],
    ["CLAUDE.md", "Keep these Claude instructions."]]) {
    const guidance = read(join(f.repo, path));
    assert.ok(guidance.startsWith(original));
    assert.ok(guidance.includes(TOOL_NAME), `${path} must tell the next agent which tool to find`);
    assert.match(guidance, /contract/i, `${path} must preserve the missing-contract next step`);
    assert.match(guidance, /start/, `${path} must leave a usable setup entry point`);
  }
  assert.ok(json(join(f.repo, ".mcp.json")).mcpServers[MCP_SERVER_KEY]);
  assert.ok(read(join(f.repo, ".codex", "config.toml")).includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
});

test("start gives a consumer-only repo its external API inventory and a first stack for the one API it calls", async (t) => {
  const f = fixture(t, { "src/payments.mjs": 'await fetch("https://api.stripe.com/v1/charges");\n' });
  const report = result(await cli(f, "start", "--json"));
  assertPendingHost(report);
  assert.equal(report.status, "configured");
  // One public upstream with calling evidence becomes the first stack, so the
  // first session's notes have a committed home. No contract is invented.
  assert.deepEqual(report.connection.first_stack, { action: "created", stack: "stripe", base_url: "https://api.stripe.com",
    source: "detected-in-code", file: "src/payments.mjs", environment: "default" });
  assert.equal(report.setup.context.state, "available");
  assert.equal(report.inventory.state, "available");
  assert.equal(report.inventory.summary.services, 0);
  assert.equal(report.inventory.summary.operations, 0);
  assert.equal(report.inventory.summary.external, 1);
  assert.equal(existsSync(join(f.repo, LAYOUT.context)), false);
  assert.equal(json(join(f.repo, LAYOUT.collection, "stripe", "stack.json")).contract, undefined);
  result(await cli(f, "note", "GET /v1/charges", "A fixture-authored lesson.", "--json"));
  assert.ok(read(knowledgePath(f.repo)).includes("A fixture-authored lesson."), "a note lands in the auto-created stack immediately");
});

test("start with only a loopback API creates no stack and keeps the no-contract recovery path", async (t) => {
  const f = fixture(t, { "src/payments.mjs": 'await fetch("http://localhost:4100/v1/charges");\n' });
  const report = result(await cli(f, "start", "--json"));
  assert.equal(report.connection.first_stack.action, "none");
  assert.equal(report.connection.first_stack.message, "Nothing your agent calls is kept until a stack exists.");
  assert.equal(report.setup.context.state, "missing");
  assert.equal(existsSync(join(f.repo, LAYOUT.context)), false);
  assert.match(report.setup.context.next, /stack add <name> --base-url <url>/);
  const connected = await cli(f, "connect");
  assert.equal(connected.code, 0, connected.out + connected.err);
  assert.doesNotMatch(connected.out, /add the real base URL and authentication to .*api-environments\.json/);
  assert.match(connected.out, /stack add <name> --base-url <url>/);
  assert.match(connected.out, /Nothing your agent calls is kept until a stack exists\./);

  const missing = await cli(f, "note", "GET /charges", "A fixture-authored lesson.");
  assert.notEqual(missing.code, 0);
  assert.match(missing.out + missing.err, /CONTEXT_UNAVAILABLE/);
  assert.match(missing.out + missing.err, /stack add <name> --base-url <url>/);
  assert.doesNotMatch(missing.out + missing.err, /API_CONTRACT=/);
  result(await cli(f, "stack", "add", "payments", "--base-url", "https://payments.example.test", "--json"));
  result(await cli(f, "note", "GET /charges", "A fixture-authored lesson.", "--stack", "payments", "--json"));
  assert.ok(read(knowledgePath(f.repo)).includes("A fixture-authored lesson."),
    "the advertised no-contract recovery must let the original note be saved");
});

test("host confirmation binds to this repository and remains stable when setup is repeated", async (t) => {
  const firstRepo = fixture(t), otherRepo = fixture(t);
  const first = result(await cli(firstRepo, "start", "--json"));
  const other = result(await cli(otherRepo, "start", "--json"));
  assertPendingHost(first);
  assertPendingHost(other);
  assert.notEqual(first.setup.host.binding_id, other.setup.host.binding_id,
    "seeing a globally registered tool from another repository must not satisfy setup confirmation");
  for (const [f, report] of [[firstRepo, first], [otherRepo, other]]) {
    const binding = report.setup.host.binding_id;
    assert.equal(json(join(f.repo, ".mcp.json")).mcpServers[MCP_SERVER_KEY].env.API_SETUP_BINDING, binding);
    assert.ok(read(join(f.repo, "AGENTS.md")).includes(`Setup binding: ${binding}`),
      "AGENTS.md must give the next agent the exact binding to confirm in tool metadata");
    assert.equal(read(join(f.repo, "CLAUDE.md")), "@AGENTS.md\n",
      "a fresh Claude host must import the canonical instruction file");
    assert.ok(read(join(f.repo, ".codex", "config.toml")).includes(JSON.stringify(binding)));
  }
  const repeated = result(await cli(firstRepo, "start", "--json"));
  assert.equal(repeated.setup.host.binding_id, first.setup.host.binding_id);
  assert.equal(json(join(firstRepo.repo, ".mcp.json")).mcpServers[MCP_SERVER_KEY].env.API_SETUP_BINDING,
    first.setup.host.binding_id);
});

test("start seeds discovered OpenAPI operations and reports a static inventory without claiming validation", async (t) => {
  const f = fixture(t, { "openapi.json": contract() });
  const report = result(await cli(f, "start", "--json"));
  assertPendingHost(report);
  assert.equal(report.status, "configured");
  assert.equal(report.setup.context.state, "available");
  assert.equal(report.setup.context.operations, 2);
  assert.equal(report.setup.context.verified, 0);
  assert.equal(report.inventory.state, "available");
  assert.equal(report.inventory.summary.operations, 2);
  const context = json(knowledgePath(f.repo));
  assert.ok(JSON.stringify(context).includes("GET /health"));
  assert.ok(JSON.stringify(context).includes("GET /items"));
});

test("repeating start preserves project files byte-for-byte, including accumulated knowledge", async (t) => {
  const f = fixture(t, { "openapi.json": contract() });
  result(await cli(f, "start", "--json"));
  const initial = tree(f.repo);
  result(await cli(f, "start", "--json"));
  assert.deepEqual(tree(f.repo), initial, "repeating setup without other changes must be byte-identical");
  const note = await cli(f, "note", "GET /items", "This is fixture-authored knowledge, not an API observation.");
  assert.equal(note.code, 0, note.err || note.out);
  const knowledge = read(knowledgePath(f.repo));
  const report = result(await cli(f, "start", "--json"));
  assert.equal(report.status, "configured");
  assert.equal(read(knowledgePath(f.repo)), knowledge, "setup must preserve authored knowledge");
  assert.ok(read(join(f.repo, "AGENTS.md")).includes("This is fixture-authored knowledge"),
    "setup may refresh derived agent guidance to include the newly authored note");
  const before = tree(f.repo);
  result(await cli(f, "start", "--json"));
  assert.deepEqual(tree(f.repo), before, "a second setup must preserve wiring and existing notes");
});

test("start --contract retains the selected portable stack contract without pinning either host", async (t) => {
  const path = "contracts/partner schema.json";
  const f = fixture(t, { [path]: contract(["/partner"]), "openapi.json": contract(["/unselected"]) });
  const report = result(await cli(f, "start", "--contract", path, "--json"));
  assert.equal(report.setup.context.operations, 1);
  assert.ok(JSON.stringify(json(knowledgePath(f.repo))).includes("GET /partner"));
  const selected = stackCatalog(f.repo).stacks[0];
  assert.equal(selected.name, "onboarding-fixture");
  assert.equal(read(join(selected.folder, selected.document.contract)), read(join(f.repo, path)),
    "the selected document is copied into its stack without replacing it with a discoverable alternative");
  const configBefore = read(join(selected.folder, "stack.json"));
  for (const row of discoverMcpRegistrations(f.repo)) {
    for (const key of ["API_ENV", "API_CONTRACT", "API_CONFIG"]) assert.equal(row.env[key], undefined,
      `${row.host} must let the repository choose each request's stack and environment`);
  }
  result(await cli(f, "start", "--json"));
  assert.equal(read(join(selected.folder, "stack.json")), configBefore, "later setup retains the selected contract");
  assert.ok(JSON.stringify(json(knowledgePath(f.repo))).includes("GET /partner"));
});

test("setup retains isolated storage in both generated hosts without copying shell credentials", async (t) => {
  for (const mode of ["absolute", "relative", "empty-log", "unset"]) await t.test(mode, async (t) => {
    const f = fixture(t, { "openapi.json": contract() });
    const cwd = join(f.repo, "nested setup"), hostCwd = join(f.home, "host cwd");
    mkdirSync(cwd); mkdirSync(hostCwd);
    const stateHome = join(f.repo, 'isolated "grants"');
    const usageLog = join(f.repo, 'observed "logs"', "usage.jsonl");
    f.env[HOME_ENV_NAME] = mode === "relative" ? '../isolated "grants"' : stateHome;
    f.env.API_USAGE_LOG = mode === "relative" ? '../observed "logs"/usage.jsonl'
      : mode === "empty-log" ? "" : usageLog;
    if (mode === "unset") { delete f.env[HOME_ENV_NAME]; delete f.env.API_USAGE_LOG; }
    f.env.API_AUTH = "bearer:PRIVATE_TOKEN";
    f.env.PRIVATE_TOKEN = "fixture-secret-that-must-stay-in-the-shell";
    f.env.UNRELATED_SETTING = "private-shell-value";
    const setup = { repo: cwd, env: f.env };
    const report = result(await cli(setup, "start", "--json"));
    assertPendingHost(report);
    const registrations = discoverMcpRegistrations(f.repo);
    assert.deepEqual(registrations.map((row) => row.host).sort(), ["claude-code", "codex"]);
    assert.equal(currentSetupBinding(f.repo, registrations), report.setup.host.binding_id);
    const expectedHome = mode === "unset" ? join(f.home, `.${PRODUCT}`) : stateHome;
    const expectedLog = mode === "unset" ? join(f.home, `.${STATE_DIR_NAME}`, "usage.jsonl")
      : mode === "empty-log" ? "" : usageLog;
    assert.ok(existsSync(join(expectedHome, "registry.json")), "setup registered the repo in a different home");
    const hostEnv = { ...f.env };
    for (const name of [HOME_ENV_NAME, "API_USAGE_LOG", "API_AUTH", "PRIVATE_TOKEN", "UNRELATED_SETTING"])
      delete hostEnv[name];
    for (const row of registrations) {
      assert.equal(row.env[HOME_ENV_NAME], mode === "unset" ? undefined : stateHome);
      assert.equal(row.env.API_USAGE_LOG, mode === "unset" ? undefined : expectedLog);
      assert.equal(row.env.API_AUTH, undefined);
      assert.equal(row.env.PRIVATE_TOKEN, undefined);
      assert.equal(row.env.UNRELATED_SETTING, undefined);
      // Load the runtime's storage selectors under the parsed, generated host
      // environment. This executes no requests and needs no real host reload.
      const observed = JSON.parse(execFileSync(row.command, ["--input-type=module", "--eval", `
        import { registryPath } from ${JSON.stringify(pathToFileURL(join(ROOT, "lib", "registry.mjs")).href)};
        import { USAGE_LOG } from ${JSON.stringify(pathToFileURL(join(ROOT, "lib", "client.mjs")).href)};
        console.log(JSON.stringify({ registry: registryPath(), usageLog: USAGE_LOG }));
      `], { cwd: hostCwd, env: { ...hostEnv, ...row.env }, encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"] }));
      assert.deepEqual(observed, { registry: join(expectedHome, "registry.json"), usageLog: expectedLog });
    }
    for (const path of [join(f.repo, ".mcp.json"), join(f.repo, ".codex", "config.toml")])
      assert.doesNotMatch(read(path), /fixture-secret-that-must-stay-in-the-shell|private-shell-value/);
    const before = [read(join(f.repo, ".mcp.json")), read(join(f.repo, ".codex", "config.toml"))];
    const repeated = result(await cli(setup, "start", "--json"));
    assert.equal(repeated.setup.host.binding_id, report.setup.host.binding_id);
    assert.deepEqual([read(join(f.repo, ".mcp.json")), read(join(f.repo, ".codex", "config.toml"))], before);
  });
});

test("start --dry-run provides a setup preview while leaving the repository and home untouched", async (t) => {
  const f = fixture(t, { "openapi.json": contract() });
  const repoBefore = tree(f.repo), homeBefore = tree(f.home);
  const report = result(await cli(f, "start", "--dry-run", "--json"));
  assert.equal(report.status, "preview");
  assert.equal(report.setup.wiring.state, "planned");
  assert.equal(report.inventory.state, "not_run");
  assert.equal(report.requests_executed, 0);
  assert.deepEqual(tree(f.repo), repoBefore);
  assert.deepEqual(tree(f.home), homeBefore);
});

test("selected missing contract or configuration files fail before any setup writes", async (t) => {
  const cases = [
    { name: "API_CONTRACT overrides a discoverable contract", code: "CONTRACT_NOT_FOUND",
      prepare: (f) => { f.env.API_CONTRACT = join(f.repo, "missing-contract.json"); } },
    { name: "configured contract overrides a discoverable contract", code: "CONTRACT_NOT_FOUND",
      prepare: (f) => writeFileSync(join(f.repo, LAYOUT.environments), JSON.stringify({
        v: 1, default: "local", environments: { local: { contract: "missing-contract.json" } },
      })) },
    { name: "a missing stored contract does not fall back to another document", code: "CONTRACT_NOT_FOUND",
      prepare: async (f) => {
        writeFileSync(join(f.repo, "selected-contract.json"), contract(["/selected"]));
        result(await cli(f, "start", "--contract", "selected-contract.json", "--json"));
        const selected = stackCatalog(f.repo).stacks[0];
        rmSync(join(selected.folder, selected.document.contract));
      } },
    { name: "an explicit missing configuration is not silently ignored", code: "CONFIG_NOT_FOUND",
      prepare: (f) => { f.env.API_CONFIG = join(f.repo, "missing-config.json"); } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = fixture(t, { "openapi.json": contract() });
    await scenario.prepare(f);
    const repoBefore = tree(f.repo), homeBefore = tree(f.home);
    const command = await cli(f, "start", "--json");
    assert.notEqual(command.code, 0, "an explicitly selected missing file must stop setup");
    const failure = JSON.parse(command.out.trim() || command.err.trim());
    assert.equal(failure.error.code, scenario.code);
    assert.deepEqual(tree(f.repo), repoBefore);
    assert.deepEqual(tree(f.home), homeBefore);
  });
});

test("switching an existing knowledge file to another contract reports a conflict and preserves every byte", async (t) => {
  const f = fixture(t, { "openapi.json": contract(["/original"]),
    "other-contract.json": contract(["/other"]) });
  result(await cli(f, "start", "--json"));
  const note = await cli(f, "note", "GET /original", "This fixture note belongs only to the original contract.");
  assert.equal(note.code, 0, note.err || note.out);
  const repoBefore = tree(f.repo), homeBefore = tree(f.home);
  const command = await cli(f, "start", "--contract", "other-contract.json", "--json");
  assert.notEqual(command.code, 0);
  const report = JSON.parse(command.out);
  assert.equal(report.status, "attention");
  assert.equal(report.setup.wiring.state, "blocked");
  assert.equal(report.setup.context.problem.code, "CONTRACT_SELECTION_CONFLICT");
  assert.equal(report.requests_executed, 0);
  assert.deepEqual(tree(f.repo), repoBefore);
  assert.deepEqual(tree(f.home), homeBefore);
});

test("a legacy external absolute contract stays selected and its current bytes control the live digest", async (t) => {
  const f = fixture(t);
  const external = join(f.home, "external partner contract.json");
  writeFileSync(external, contract(["/partner"]));
  // R2 confines new stack contracts to the project. Preserve the older absolute
  // contract behavior here by deliberately starting from a legacy store.
  saveContext(f.repo, emptyContext({ name: "Legacy partner", contractPath: external }));
  const report = result(await cli(f, "start", "--contract", external, "--json"));
  assert.equal(report.setup.context.operations, 1);
  const context = json(knowledgePath(f.repo));
  assert.equal(context.api.contract, external);
  assert.equal(json(join(f.repo, ".mcp.json")).mcpServers[MCP_SERVER_KEY].env.API_CONTRACT, external);
  assert.ok(read(join(f.repo, ".codex", "config.toml")).includes(JSON.stringify(external)));
  result(await cli(f, "start", "--json"));
  assert.equal(json(join(f.repo, ".mcp.json")).mcpServers[MCP_SERVER_KEY].env.API_CONTRACT, external);
  const initialDigest = liveContractDigest(f.repo, context);
  assert.equal(initialDigest, readContract(external).digest);
  writeFileSync(external, contract(["/partner", "/changed"]));
  const currentDigest = liveContractDigest(f.repo, context);
  assert.equal(currentDigest, readContract(external).digest);
  assert.notEqual(currentDigest, initialDigest,
    "an absolute external path must not silently fall back to its stale stored digest");
});

test("shell-only base URL and authentication are reported as unpersisted without revealing credentials", async (t) => {
  const f = fixture(t, { "openapi.json": contract() });
  const secret = "onboarding-fixture-private-credential-value";
  Object.assign(f.env, { API_BASE_URL: "http://127.0.0.1:1", API_AUTH: "bearer:ONBOARDING_FIXTURE_TOKEN",
    ONBOARDING_FIXTURE_TOKEN: secret });
  const command = await cli(f, "start", "--json");
  const report = result(command);
  assertPendingHost(report);
  assert.equal(report.setup.api.configured, false);
  assert.equal(report.setup.api.source, "shell_only");
  assert.match(report.setup.api.next, /stacks\/onboarding-fixture\/stack\.json/);
  assert.doesNotMatch(report.setup.api.next, /api-environments\.json/);
  assert.match(report.setup.api.next, /shell|persist|MCP|host|restart/i,
    "setup must explain why a shell setting does not complete host configuration");
  assert.ok(!`${command.out}${command.err}`.includes(secret));
  for (const path of [".mcp.json", ".codex/config.toml", "AGENTS.md", "CLAUDE.md"])
    assert.ok(!read(join(f.repo, path)).includes(secret), `${path} must never persist credential values`);
});

test("start reports an existing foreign registration without partially installing other files", async (t) => {
  const f = fixture(t, { "openapi.json": contract(), ".mcp.json": JSON.stringify({
    mcpServers: { [MCP_SERVER_KEY]: { command: "someone-elses-server" } },
  }) });
  const repoBefore = tree(f.repo), homeBefore = tree(f.home);
  const command = await cli(f, "start", "--json");
  assert.notEqual(command.code, 0);
  const report = JSON.parse(command.out);
  assert.equal(report.status, "attention");
  assert.equal(report.setup.wiring.state, "blocked");
  assert.equal(report.requests_executed, 0);
  assert.deepEqual(tree(f.repo), repoBefore);
  assert.deepEqual(tree(f.home), homeBefore);
});

test("invalid start arguments fail before writing any setup files", async (t) => {
  for (const args of [["--unknown-option"], ["--contract"], ["--contract", "missing.json"]]) {
    await t.test(args.join(" "), async (t) => {
      const f = fixture(t, { "openapi.json": contract() });
      const repoBefore = tree(f.repo), homeBefore = tree(f.home);
      const command = await cli(f, "start", ...args);
      assert.notEqual(command.code, 0, "invalid setup arguments must not be silently ignored");
      assert.deepEqual(tree(f.repo), repoBefore);
      assert.deepEqual(tree(f.home), homeBefore);
    });
  }
});

test("start performs zero HTTP requests even when a reachable API is configured", async (t) => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1; res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}');
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const f = fixture(t, { "openapi.json": contract(), [LAYOUT.environments]: JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl } },
  }) });
  const report = result(await cli(f, "start", "--json"));
  assertPendingHost(report);
  assert.equal(report.setup.api.configured, true);
  assert.equal(report.inventory.state, "available");
  assert.equal(hits, 0, "first-run setup must not probe even a configured loopback API");
});
