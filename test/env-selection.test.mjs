import { LAYOUT } from "../lib/layout.mjs";
import { createFixtureStack } from "./helpers/stack-fixture.mjs";
import { existsSync as setupExists } from "node:fs";
// AX-D — a named environment on the command line is an execution boundary,
// not decorative help text. Every CLI path below issues real local requests
// and proves the non-default server is the one that received them.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");
const execFileP = promisify(execFile);

async function cli(cwd, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileP("node", [CLI, ...args], {
      cwd, encoding: "utf8", env: {
        ...process.env, API_USAGE_LOG: "/dev/null", API_CONTEXT_OFF: "1",
        API_EVIDENCE: join(cwd, "evidence"), ...env,
      },
    });
    return { code: 0, stdout, stderr, out: stdout + stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "",
      out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function api(label) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const body = Buffer.from(JSON.stringify({ label, ok: true }));
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    hits, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

function fixture(local, tunnel, { legacy = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "env-selection-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: selected, version: '1' }", "paths:",
    "  /probe:", "    get:", "      responses:", "        '200': { description: ok }", "",
  ].join("\n"));
  if (legacy) {
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: {
      local: { baseUrl: local }, tunnel: { baseUrl: tunnel },
    },
  }, null, 2));
  } else createFixtureStack(dir, { baseUrl: local, contract: "openapi.yaml", environments: {
    local: { baseUrl: local }, tunnel: { baseUrl: tunnel },
  } });
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "smoke.json"), JSON.stringify({
    v: 2, name: "smoke", requests: [
      { id: "probe", method: "GET", path: "/probe", expect: [{ status: 200 }] },
    ],
  }, null, 2));
  execFileSync("node", [CLI, "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function requestTarget(doc) {
  return doc.request_target ?? doc.environment?.request_target
    ?? (doc.stacks?.length === 1 ? doc.stacks[0].request_target : undefined);
}

test("every request-executing command honors both explicit --env forms", async () => {
  const local = await api("local"), tunnel = await api("tunnel");
  const dir = fixture(local.origin, tunnel.origin);
  const commands = [
    ["learn", "--dry-run", "--json"],
    ["audit", ".", "--json"],
    ["map", ".", "--execute", "--json"],
    ["doctor", "--json"],
    ["suite", "run", "smoke", "--json"],
    ["verify", "smoke", "--json"],
    ["feedback", "--execute", "--json"],
  ];
  try {
    for (const base of commands) {
      for (const envArgs of [["--env", "tunnel"], ["--env=tunnel"]]) {
        const before = tunnel.hits.length;
        const result = await cli(dir, [...base, ...envArgs], { API_ENV: "local" });
        assert.equal(result.code, 0, `${base.join(" ")} ${envArgs.join(" ")}\n${result.out}`);
        const doc = JSON.parse(result.stdout);
        assert.deepEqual(requestTarget(doc), {
          environment: "tunnel", base_url: tunnel.origin, base_url_source: "environment",
        }, `${base.join(" ")} did not report the exact selected request target`);
        assert.ok(tunnel.hits.length > before, `${base.join(" ")} sent no request to tunnel`);
        assert.equal(local.hits.length, 0, `${base.join(" ")} silently executed the API_ENV/default target`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await local.close(); await tunnel.close();
  }
});

test("explicit selection and unknown learn flags fail closed before requests", async () => {
  const local = await api("local"), tunnel = await api("tunnel");
  const dir = fixture(local.origin, tunnel.origin);
  const empty = mkdtempSync(join(tmpdir(), "env-selection-empty-"));
  execFileSync("git", ["init", "-q"], { cwd: empty });
  try {
    for (const [args, code] of [
      [["learn", "--env", "missing", "--json"], "ENVIRONMENT_NOT_FOUND"],
      [["learn", "--env", "--json"], "ENVIRONMENT_REQUIRED"],
      [["learn", "--env", "-z", "--json"], "ENVIRONMENT_REQUIRED"],
      [["learn", "--env", "tunnel", "--env=local", "--json"], "ENVIRONMENT_DUPLICATE"],
      [["learn", "--bogus", "--json"], "UNKNOWN_FLAG"],
      [["learn", "-z", "--json"], "UNKNOWN_FLAG"],
      [["learn", "--limit", "1", "--json"], "UNKNOWN_FLAG"],
    ]) {
      const result = await cli(dir, args);
      assert.equal(result.code, 1, result.out);
      assert.equal(JSON.parse(result.stderr).error.code, code, result.out);
      assert.deepEqual([local.hits.length, tunnel.hits.length], [0, 0]);
    }
    const absent = await cli(empty, ["doctor", "--env=missing", "--json"]);
    assert.equal(absent.code, 1, absent.out);
    assert.equal(JSON.parse(absent.stderr).error.code, "ENVIRONMENT_CONFIG_REQUIRED");
    assert.deepEqual([local.hits.length, tunnel.hits.length], [0, 0]);

    for (const args of [
      ["audit", ".", "-z"], ["map", ".", "-z"], ["doctor", "-z"],
      ["suite", "run", "smoke", "-z"], ["verify", "smoke", "-z"],
      ["feedback", "--execute", "-z"],
    ]) {
      const result = await cli(dir, args);
      assert.equal(result.code, 1, result.out);
      assert.equal(JSON.parse(result.stderr).error.code, "UNKNOWN_FLAG", result.out);
      assert.deepEqual([local.hits.length, tunnel.hits.length], [0, 0]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
    await local.close(); await tunnel.close();
  }
});

test("static audit, map, and feedback do not require a usable request config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-static-bad-config-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: static, version: '1' }", "paths:",
    "  /probe:", "    get:", "      responses:", "        '200': { description: ok }", "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), "{ not json\n");
  try {
    for (const args of [
      ["feedback", "--json"], ["audit", ".", "--no-execute", "--json"],
      ["map", ".", "--no-execute", "--json"],
    ]) {
      const result = await cli(dir, args);
      assert.equal(result.code, 0, `${args.join(" ")}\n${result.out}`);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("ordinary doctor keeps malformed config inside its complete diagnostic report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-doctor-bad-config-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: diagnostic, version: '1' }", "paths: {}", "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), "{ not json\n");
  try {
    const result = await cli(dir, ["doctor", "--json"]);
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find(({ name }) => name === "config")?.state, "FAIL");
    assert.ok(report.checks.length > 1, "doctor stopped at config instead of completing diagnostics");
    assert.doesNotMatch(result.stderr, /CONFIG_INVALID/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("offline doctor does not report the unrequested fallback as an executed request target", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-doctor-fallback-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  try {
    const result = await cli(dir, ["doctor", "--offline", "--json"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.request_target, undefined);
    assert.equal(report.checks.find(({ name }) => name === "base-url")?.state, "WARN");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("feedback explicit environment preflights every service before traffic", async () => {
  const good = await api("good"), unused = await api("unused-root");
  const dir = mkdtempSync(join(tmpdir(), "env-feedback-preflight-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const contract = [
    "openapi: 3.0.0", "info: { title: selected, version: '1' }", "paths:",
    "  /probe:", "    get:", "      responses:", "        '200': { description: ok }", "",
  ].join("\n");
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { tunnel: { baseUrl: unused.origin } },
  }));
  for (const name of ["good", "missing"]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "openapi.yaml"), contract);
    writeFileSync(join(dir, name, LAYOUT.environments), JSON.stringify({
      v: 1, default: "local", environments: name === "good"
        ? { tunnel: { baseUrl: good.origin } }
        : { local: { baseUrl: "http://127.0.0.1:1" } },
    }));
  }
  try {
    const result = await cli(dir, ["feedback", "--execute", "--env", "tunnel", "--json"]);
    assert.equal(result.code, 1, result.out);
    const error = JSON.parse(result.stderr).error;
    assert.equal(error.code, "ENVIRONMENT_NOT_FOUND", result.out);
    assert.match(error.message, /missing/);
    assert.deepEqual([good.hits.length, unused.hits.length], [0, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await good.close(); await unused.close();
  }
});

test("suite run accepts the advertised selector before the subcommand", async () => {
  const local = await api("local"), tunnel = await api("tunnel");
  const dir = fixture(local.origin, tunnel.origin);
  try {
    const result = await cli(dir,
      ["suite", "--env", "tunnel", "run", "smoke", "--json"], { API_ENV: "local" });
    assert.equal(result.code, 0, result.out);
    assert.deepEqual(JSON.parse(result.stdout).request_target, {
      environment: "tunnel", base_url: tunnel.origin, base_url_source: "environment",
    });
    assert.equal(local.hits.length, 0);
    assert.ok(tunnel.hits.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await local.close(); await tunnel.close();
  }
});

test("consumer-only audit never reports a selected environment as an executed target", async () => {
  const tunnel = await api("unused-tunnel");
  const dir = mkdtempSync(join(tmpdir(), "env-consumer-static-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "client.mjs"),
    'export const upstream = "https://api.stripe.com/v1";\n');
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "tunnel", environments: { tunnel: { baseUrl: tunnel.origin } },
  }));
  try {
    const json = await cli(dir, ["audit", ".", "--env", "tunnel", "--json"]);
    assert.equal(json.code, 0, json.out);
    const report = JSON.parse(json.stdout);
    assert.equal(report.request_target, undefined);
    assert.deepEqual(report.selected_request_target, {
      environment: "tunnel", base_url: tunnel.origin, base_url_source: "environment",
    });
    assert.equal(report.request_execution, false);

    const human = await cli(dir, ["audit", ".", "--env=tunnel"]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.stdout, /selected.*not executed/i);
    assert.doesNotMatch(human.stdout, /executed against/i);
    assert.equal(tunnel.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await tunnel.close();
  }
});

test("POST-only surfaces report selection without inventing a request attempt", async () => {
  const server = await api("post-only");
  const dir = mkdtempSync(join(tmpdir(), "env-post-only-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: writes, version: '1' }", "paths:",
    "  /items:", "    post:", "      responses:", "        '201': { description: made }", "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: server.origin } },
  }));
  try {
    for (const args of [["audit", ".", "--json"], ["map", ".", "--execute", "--json"],
      ["feedback", "--execute", "--json"]]) {
      const result = await cli(dir, args);
      assert.equal(result.code, 0, result.out);
      const doc = JSON.parse(result.stdout);
      const report = args[0] === "feedback" ? doc.environment : doc;
      assert.equal(report.request_target, undefined, `${args[0]} invented an executed target`);
      assert.deepEqual(report.selected_request_target, {
        environment: "local", base_url: server.origin, base_url_source: "environment",
      });
      assert.equal(report.request_execution, false);
      if (args[0] === "feedback")
        assert.equal(doc.what_it_found.executed_against_a_running_server, false);
    }
    const human = await cli(dir, ["audit", "."]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.stdout, /selected.*not executed/i);
    const feedbackFile = join(dir, "post-only-feedback.md");
    const feedback = await cli(dir, ["feedback", "--execute", "--out", feedbackFile]);
    assert.equal(feedback.code, 0, feedback.out);
    const prose = readFileSync(feedbackFile, "utf8");
    assert.match(prose, /no eligible GET\/HEAD/i);
    assert.doesNotMatch(prose, /re-run as .*feedback --execute/i);
    assert.equal(server.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("POST-only learn dry-run reports a selected target without inventing execution", async () => {
  const server = await api("learn-post-only");
  const dir = mkdtempSync(join(tmpdir(), "env-learn-post-only-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: writes, version: '1' }", "paths:",
    "  /items:", "    post:", "      responses:", "        '201': { description: made }", "",
  ].join("\n"));
  createFixtureStack(dir, { baseUrl: server.origin, contract: "openapi.yaml" });
  execFileSync("node", [CLI, "init"], { cwd: dir, stdio: "ignore" });
  try {
    const result = await cli(dir, ["learn", "--dry-run", "--json"]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.executed, 0);
    assert.equal(report.request_target, undefined);
    assert.deepEqual(report.selected_request_target, {
      environment: "local", base_url: server.origin, base_url_source: "environment",
    });
    assert.equal(report.request_execution, false);
    assert.equal(server.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("read-only verify reports an all-write suite as selected but unexecuted", async () => {
  const server = await api("verify-write-only");
  const dir = mkdtempSync(join(tmpdir(), "env-verify-write-only-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: server.origin } },
  }));
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "writes.json"), JSON.stringify({
    v: 2, name: "writes", requests: [
      { id: "create", method: "POST", path: "/items", expect: [{ status: 201 }] },
    ],
  }, null, 2));
  try {
    const result = await cli(dir, ["verify", "writes", "--read-only", "--json"]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.suites[0].total, 0);
    assert.equal(report.request_target, undefined);
    assert.deepEqual(report.selected_request_target, {
      environment: "local", base_url: server.origin, base_url_source: "environment",
    });
    assert.equal(report.request_execution, false);
    assert.equal(server.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("an empty hand-edited suite never labels its selected target as executed", async () => {
  const server = await api("empty-suite");
  const dir = mkdtempSync(join(tmpdir(), "env-empty-suite-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: server.origin } },
  }));
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "empty.json"), JSON.stringify({
    v: 2, name: "empty", requests: [],
  }, null, 2));
  try {
    const result = await cli(dir, ["suite", "run", "empty", "--json"]);
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.suites[0].error.code, "EMPTY_ENVELOPE");
    assert.equal(report.request_target, undefined);
    assert.deepEqual(report.selected_request_target, {
      environment: "local", base_url: server.origin, base_url_source: "environment",
    });
    assert.equal(report.request_execution, false);
    assert.equal(server.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("suite and verify placeholder refusals remain selected with zero transport attempts", async () => {
  const server = await api("unresolved-placeholder");
  const dir = mkdtempSync(join(tmpdir(), "env-suite-unresolved-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: server.origin } },
  }));
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "unresolved.json"), JSON.stringify({
    v: 2, name: "unresolved", requests: [
      { id: "missing", method: "GET", path: "/items/{missing}", expect: [{ status: 200 }] },
    ],
  }, null, 2));
  try {
    for (const args of [
      ["suite", "run", "unresolved", "--json"],
      ["verify", "unresolved", "--json"],
    ]) {
      const result = await cli(dir, args);
      assert.equal(result.code, 1, result.out);
      const report = JSON.parse(result.stdout);
      assert.equal(report.suites[0].steps[0].error.code, "UNRESOLVED_PLACEHOLDER");
      assert.equal(report.request_attempts, 0);
      assert.equal(report.request_target, undefined);
      assert.deepEqual(report.selected_request_target, {
        environment: "local", base_url: server.origin, base_url_source: "environment",
      });
      assert.equal(report.request_execution, false);
      assert.equal(server.hits.length, 0);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("invalid wait_for policy is not counted as a transport attempt", async () => {
  const server = await api("invalid-wait");
  const dir = mkdtempSync(join(tmpdir(), "env-suite-invalid-wait-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: server.origin } },
  }));
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "invalid-wait.json"), JSON.stringify({
    v: 2, name: "invalid-wait", requests: [
      { id: "write-poll", method: "POST", path: "/items", body: {},
        wait_for: { json: "state", equals: "done" }, expect: [{ status: 200 }] },
    ],
  }, null, 2));
  try {
    const result = await cli(dir, ["suite", "run", "invalid-wait", "--json"]);
    assert.equal(result.code, 1, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.suites[0].steps[0].error.code, "INVALID_WAIT_FOR_METHOD");
    assert.equal(report.request_attempts, 0);
    assert.equal(report.request_target, undefined);
    assert.equal(report.request_execution, false);
    assert.equal(server.hits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await server.close();
  }
});

test("polling counts every concrete fetch attempt", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const body = Buffer.from(JSON.stringify({ state: hits.length < 3 ? "pending" : "done" }));
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "env-suite-poll-count-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: origin } },
  }));
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "poll.json"), JSON.stringify({
    v: 2, name: "poll", requests: [
      { id: "status", method: "GET", path: "/status",
        wait_for: { json: "state", equals: "done", interval_ms: 100, timeout_ms: 1000 },
        expect: [{ status: 200 }] },
    ],
  }, null, 2));
  try {
    const result = await cli(dir, ["suite", "run", "poll", "--json"]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.request_attempts, 3);
    assert.equal(report.suites[0].request_attempts, 3);
    assert.equal(hits.length, 3);
    assert.deepEqual(report.request_target, {
      environment: "local", base_url: origin, base_url_source: "environment",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rate retry and redirect hops each count as concrete fetch attempts", async () => {
  const hits = [];
  let startHits = 0;
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    if (req.url === "/start" && startHits++ === 0) {
      res.writeHead(429, { "retry-after": "0", "content-type": "application/json" });
      res.end('{"error":"slow"}');
      return;
    }
    if (req.url === "/start") {
      res.writeHead(302, { location: "/done" });
      res.end();
      return;
    }
    const body = Buffer.from('{"ok":true}');
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "env-suite-retry-redirect-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: origin } },
  }));
  mkdirSync(join(dir, LAYOUT.suites), { recursive: true });
  writeFileSync(join(dir, LAYOUT.suites, "retry.json"), JSON.stringify({
    v: 2, name: "retry", requests: [
      { id: "retry", method: "GET", path: "/start", expect: [{ status: 200 }] },
    ],
  }, null, 2));
  try {
    const result = await cli(dir, ["suite", "run", "retry", "--json"]);
    assert.equal(result.code, 0, result.out);
    const report = JSON.parse(result.stdout);
    assert.equal(report.request_attempts, 3);
    assert.equal(report.suites[0].request_attempts, 3);
    assert.deepEqual(hits, ["GET /start", "GET /start", "GET /done"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("learn and suite runners retain an unreachable target once a request is attempted", async () => {
  const closed = await api("closed-runner");
  const origin = closed.origin;
  await closed.close();
  const dir = fixture(origin, origin);
  const expected = {
    environment: "local", base_url: origin, base_url_source: "environment",
  };
  try {
    for (const args of [
      ["learn", "--dry-run", "--json"],
      ["suite", "run", "smoke", "--json"],
      ["verify", "smoke", "--json"],
    ]) {
      const result = await cli(dir, args);
      const report = JSON.parse(result.stdout);
      assert.ok(report.request_attempts >= 1);
      assert.deepEqual(report.request_target, expected, `${args.join(" ")} hid an attempted target`);
      assert.equal(report.selected_request_target, undefined);
      assert.notEqual(report.request_execution, false);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a synthetic parameterized 404 counts as a received server response", async () => {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const body = Buffer.from(JSON.stringify({ error: { code: "not_found" } }));
    res.writeHead(404, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), "env-param-response-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: parameterized, version: '1' }", "paths:",
    "  /items/{id}:", "    get:", "      parameters:",
    "        - { in: path, name: id, required: true, schema: { type: string } }",
    "      responses:", "        '200': { description: ok }", "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: origin } },
  }));
  try {
    const audit = await cli(dir, ["audit", ".", "--json"]);
    assert.equal(audit.code, 0, audit.out);
    const report = JSON.parse(audit.stdout);
    assert.equal(report.surfaces[0].attempted, 1);
    assert.equal(report.surfaces[0].checked, 1);
    assert.equal(report.surfaces[0].reachable, true);

    const human = await cli(dir, ["audit", "."]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.stdout, /1 request attempted, 1 received a response/i);
    assert.doesNotMatch(human.stdout, /no HTTP response/i);

    const feedback = await cli(dir, ["feedback", "--execute", "--json"]);
    assert.equal(feedback.code, 0, feedback.out);
    assert.equal(JSON.parse(feedback.stdout).what_it_found.executed_against_a_running_server, true);
    assert.ok(hits.length >= 3, "each command should receive the synthetic 404 response");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("an unreachable eligible GET remains an attempted target without claiming a running server", async () => {
  const closed = await api("closed");
  const origin = closed.origin;
  await closed.close();
  const dir = mkdtempSync(join(tmpdir(), "env-unreachable-attempt-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0", "info: { title: reads, version: '1' }", "paths:",
    "  /items:", "    get:", "      responses:", "        '200': { description: ok }", "",
  ].join("\n"));
  writeFileSync(join(dir, LAYOUT.environments), JSON.stringify({
    v: 1, default: "local", environments: { local: { baseUrl: origin } },
  }));
  try {
    const audit = await cli(dir, ["audit", ".", "--json"]);
    assert.equal(audit.code, 0, audit.out);
    assert.deepEqual(JSON.parse(audit.stdout).request_target, {
      environment: "local", base_url: origin, base_url_source: "environment",
    });
    const human = await cli(dir, ["audit", "."]);
    assert.equal(human.code, 0, human.out);
    assert.match(human.stdout, /request attempted.*no .*response/i);
    assert.doesNotMatch(human.stdout, /nothing executed/i);

    const feedback = await cli(dir, ["feedback", "--execute", "--json"]);
    assert.equal(feedback.code, 0, feedback.out);
    const report = JSON.parse(feedback.stdout);
    assert.deepEqual(report.environment.request_target, {
      environment: "local", base_url: origin, base_url_source: "environment",
    });
    assert.equal(report.what_it_found.executed_against_a_running_server, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("API_BASE_URL override is explicit in JSON and human request reports", async () => {
  const local = await api("local"), tunnel = await api("tunnel"), override = await api("override");
  const dir = fixture(local.origin, tunnel.origin, { legacy: true });
  try {
    const json = await cli(dir, ["doctor", "--env", "tunnel", "--json"],
      { API_BASE_URL: override.origin });
    assert.equal(json.code, 0, json.out);
    assert.deepEqual(JSON.parse(json.stdout).request_target, {
      environment: "tunnel", base_url: override.origin, base_url_source: "API_BASE_URL",
    });
    assert.equal(local.hits.length, 0);
    assert.equal(tunnel.hits.length, 0);
    assert.ok(override.hits.length > 0);

    const human = await cli(dir, ["doctor", "--env=tunnel"],
      { API_BASE_URL: override.origin });
    assert.equal(human.code, 0, human.out);
    assert.match(human.stdout, /environment 'tunnel'/i);
    assert.match(human.stdout, new RegExp(override.origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(human.stdout, /API_BASE_URL/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await local.close(); await tunnel.close(); await override.close();
  }
});

test("multi-surface audit, map, and feedback report every executed base without a false singular target", async () => {
  const one = await api("one"), two = await api("two");
  const dir = mkdtempSync(join(tmpdir(), "env-selection-multi-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  const contract = [
    "openapi: 3.0.0", "info: { title: selected, version: '1' }", "paths:",
    "  /probe:", "    get:", "      responses:", "        '200': { description: ok }", "",
  ].join("\n");
  for (const [name, origin] of [["one", one.origin], ["two", two.origin]]) {
    mkdirSync(join(dir, name));
    writeFileSync(join(dir, name, "openapi.yaml"), contract);
    writeFileSync(join(dir, name, LAYOUT.environments), JSON.stringify({
      v: 1, default: "local", environments: { tunnel: { baseUrl: origin } },
    }));
  }
  try {
    const selected = await cli(dir, ["feedback", "--env", "tunnel", "--json"]);
    assert.equal(selected.code, 0, selected.out);
    const selection = JSON.parse(selected.stdout).environment;
    assert.equal(selection.request_target, undefined);
    assert.equal(selection.selected_request_target, undefined);
    assert.equal(selection.request_execution, false);
    assert.deepEqual(new Set(selection.selected_request_targets.map(({ service, base_url }) =>
      `${service}:${base_url}`)), new Set([`one:${one.origin}`, `two:${two.origin}`]));
    assert.deepEqual([one.hits.length, two.hits.length], [0, 0]);

    for (const command of [["audit", ".", "--json"], ["map", ".", "--execute", "--json"],
      ["feedback", "--execute", "--json"]]) {
      const before = [one.hits.length, two.hits.length];
      const result = await cli(dir, [...command, "--env", "tunnel"]);
      assert.equal(result.code, 0, result.out);
      const doc = JSON.parse(result.stdout);
      const targetReport = command[0] === "feedback" ? doc.environment : doc;
      assert.equal(targetReport.request_target, undefined,
        "one root target was claimed for requests sent to distinct service bases");
      assert.deepEqual(new Set(targetReport.request_targets.map(({ base_url }) => base_url)),
        new Set([one.origin, two.origin]));
      assert.ok(one.hits.length > before[0] && two.hits.length > before[1],
        `${command[0]} did not execute both reported service targets`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await one.close(); await two.close();
  }
});

test("help documents environment selection on every request-executing command", async () => {
  const dir = mkdtempSync(join(tmpdir(), "env-help-"));
  try {
    for (const command of ["learn", "audit", "map", "doctor", "request", "protocol", "suite", "verify", "feedback"]) {
      const result = await cli(dir, [command, "--help"]);
      assert.equal(result.code, 0, result.out);
      assert.match(result.stdout, /--env <name>/, `${command} omits the explicit selector`);
      assert.match(result.stdout, /--env=<name>/, `${command} omits the equals selector`);
      assert.match(result.stdout, /outranks API_ENV\/default/, `${command} omits selector precedence`);
      assert.match(result.stdout, /API_BASE_URL.*override/i, `${command} hides URL override precedence`);
      assert.match(result.stdout, /API_BASE_URL[^\n]*legacy layout only/i, `${command} presents a legacy URL override as stack behavior`);
      assert.match(result.stdout, /Explicit stacks[^\n]*configured environment URLs[^\n]*API_BASE_URL does not override/i,
        `${command} omits the configured stack URL boundary`);
    }
    const top = await cli(dir, ["--help"]);
    assert.equal(top.code, 0, top.out);
    assert.match(top.stdout, /Legacy layout only: API_BASE_URL overrides/i);
    assert.match(top.stdout, /Explicit stacks[^\n]*configured environment URLs[^\n]*API_BASE_URL does not override/i);
    const guide = readFileSync(join(ROOT, "docs/agent-guide.md"), "utf8");
    assert.match(guide, /--env <name>/, "the bundled operating guide omits explicit environment selection");
    assert.match(guide, /unknown `--env` is an error/, "the operating guide hides invalid selection");
    assert.match(guide, /Do not substitute the configured default or\s+another environment/);
    assert.match(guide, /API_BASE_URL.*overrides only the\s+selected environment's URL/s);
    assert.match(guide, /In the legacy layout, if `API_BASE_URL` is present/);
    assert.match(guide, /Explicit stacks use their configured environment URLs;\s+`API_BASE_URL` does not override them/);
    assert.match(guide, /output must identify the override/);
    // The full selector precedence is in every command's help above; SETUP.md
    // also documents it when this private source reference is present.
    for (const file of ["SETUP.md"].filter((f) => setupExists(join(ROOT, f)))) {
      const prose = readFileSync(join(ROOT, file), "utf8");
      assert.match(prose, /--env <name>/, `${file} omits explicit environment selection`);
      assert.match(prose, /explicit.*API_ENV.*default/is, `${file} omits selector precedence`);
      assert.match(prose, /API_BASE_URL.*override/is, `${file} omits URL override disclosure`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
