// A field report (2026-09-15): `api-request --help` was sent as the HTTP method,
// so asking for usage produced a request. The low-level binary must answer usage
// questions and refuse malformed argv without touching the wire. The counting
// server below is the witness: it records every TCP connection and every parsed
// request, so a refused method that still opened a connection would show.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REQUEST = fileURLToPath(new URL("../bin/request.mjs", import.meta.url));
const requests = [];
let connections = 0, server, base;
const dirs = [];

before(async () => {
  server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  server.on("connection", () => { connections += 1; });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server?.close(); for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function scratch(prefix) { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; }

// Stripped environment: only the base URL points at the witness; a fresh HOME
// keeps machine state out of the specimen.
function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [REQUEST, ...args], {
      cwd: scratch("request-usage-cwd-"), stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: scratch("request-usage-home-"), API_BASE_URL: base },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}
const errorCode = (stdout) => { try { return JSON.parse(stdout).error?.code ?? null; } catch { return null; } };

test("the low-level binary answers --help, -h and help with usage and opens no connection", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const [seenConnections, seenRequests] = [connections, requests.length];
    const result = await run(args);
    assert.equal(result.code, 0, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /^Usage: /);
    assert.match(result.stdout, /GET, HEAD, POST, PUT, PATCH, DELETE or OPTIONS/);
    assert.equal(connections, seenConnections, `${args.join(" ")} opened a connection`);
    assert.equal(requests.length, seenRequests, `${args.join(" ")} sent a request`);
  }
});

test("unknown options, unknown methods and missing or malformed paths are named refusals that open no connection", async () => {
  const cases = [
    [["--bogus"], "REQUEST_OPTION_UNKNOWN"],
    [["FROB", "/x"], "REQUEST_METHOD_INVALID"],
    [["GET"], "REQUEST_PATH_REQUIRED"],
    [["GET", ""], "REQUEST_PATH_REQUIRED"],
    [["GET", "x"], "REQUEST_PATH_INVALID"],
  ];
  for (const [args, code] of cases) {
    const [seenConnections, seenRequests] = [connections, requests.length];
    const result = await run(args);
    assert.equal(result.code, 1, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.equal(errorCode(result.stderr), code, `${args.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /Run: .*--help/);
    assert.equal(result.stdout, "", `${args.join(" ")} wrote to stdout`);
    assert.equal(connections, seenConnections, `${args.join(" ")} opened a connection`);
    assert.equal(requests.length, seenRequests, `${args.join(" ")} sent a request`);
  }
});

test("a refusal never echoes argument values", async () => {
  const result = await run(["FROB", "/x?token=PLANTED_QUERY_VALUE_7f4d9a"]);
  assert.equal(errorCode(result.stderr), "REQUEST_METHOD_INVALID");
  assert.ok(!(result.stdout + result.stderr).includes("PLANTED_QUERY_VALUE_7f4d9a"));
  assert.ok(!(result.stdout + result.stderr).includes("FROB"));
});

test("a well-formed request still reaches the wire exactly once", async () => {
  const seenRequests = requests.length;
  const result = await run(["GET", "/x"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 200);
  assert.deepEqual(requests.slice(seenRequests), ["GET /x"]);
});
