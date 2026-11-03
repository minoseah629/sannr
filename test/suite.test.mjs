import { LAYOUT } from "../lib/layout.mjs";
// Saved suites: share the normal lifecycle; keep named adversarial boundaries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// A sandbox that is a git repo of its own, so repoRoot() resolves to it and a
// suite file can never land in the checkout the test runner sits in.
function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), "suite-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

// Sync runner for commands that touch no network (save/list). Returns
// { code, out } and never throws on a non-zero exit.
function cli(dir, args, { input } = {}) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args],
      { cwd: dir, encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// `suite run` fetches from a server that lives in THIS process, so the CLI
// must run asynchronously — execFileSync blocks the event loop and the child
// would wait forever on a server that can never answer.
const execFileP = promisify(execFile);
async function cliAsync(dir, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileP(process.execPath, [CLI, ...args], {
      cwd: dir, encoding: "utf8",
      env: { ...process.env, API_USAGE_LOG: "/dev/null", API_CONTEXT_OFF: "1",
             API_EVIDENCE: join(dir, "evidence"), ...env },
    });
    return { code: 0, out: `${stdout}${stderr}` };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

// A tiny deterministic API: enough surface for a passing suite, a failing
// assertion with a knowable expected-vs-actual, and a capture chain.
function startApi() {
  const srv = createServer((req, res) => {
    const send = (status, body) => {
      const buf = Buffer.from(JSON.stringify(body));
      res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
      res.end(buf);
    };
    if (req.url === "/health") return send(200, { status: "ok", pieces: 2 });
    if (req.url === "/pieces") return send(200, { data: [{ id: 1, status: "active" }, { id: 2, status: "draft" }], total: 2 });
    if (req.url === "/pieces/1") return send(200, { id: 1, status: "active", title: "first" });
    return send(404, { error: "no route" });
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () =>
    resolve({ origin: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise(done => srv.close(done)) })));
}

const GREEN = { v: 2, requests: [
  { id: "health", method: "GET", path: "/health",
    expect: [{ status: 200 }, { json: "status", equals: "ok" }] },
  { id: "pieces", method: "GET", path: "/pieces",
    expect: [{ status: 200 }, { json: "data.0.id", equals: 1 }, { json: "total", gt: 1 }] },
] };

const RED = { v: 2, requests: [
  { id: "one", method: "GET", path: "/pieces/1",
    expect: [{ status: 200 }, { json: "status", equals: "archived" }] },
] };

// --- save -------------------------------------------------------------------

test("suite lifecycle saves canonical bytes, lists, reruns without mutation and reports mixed results", async t => {
  const dir = sandbox(t), api = await startApi();
  t.after(() => api.close());
  const savedResult = cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
  assert.equal(savedResult.code, 0, savedResult.out);
  const file = join(dir, LAYOUT.suites, "smoke.json"), before = readFileSync(file, "utf8");
  const saved = JSON.parse(before);
  assert.equal(saved.name, "smoke"); assert.equal(saved.requests.length, 2);
  assert.deepEqual(saved.requests[0].expect, GREEN.requests[0].expect);

  const shuffled = { requests: [
    { expect: [{ status: 200 }, { equals: "ok", json: "status" }], path: "/health", method: "GET", id: "health" },
    { expect: [{ status: 200 }, { equals: 1, json: "data.0.id" }, { gt: 1, json: "total" }], path: "/pieces", method: "GET", id: "pieces" },
  ], v: 2 };
  const resaved = cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(shuffled) });
  assert.equal(resaved.code, 0, resaved.out);
  assert.equal(readFileSync(file, "utf8"), before, "input key order must not change committed bytes");
  const step = before.slice(before.indexOf("{", before.indexOf("requests")));
  assert.ok(step.indexOf('"method"') < step.indexOf('"path"'), "method before path");
  assert.ok(step.indexOf('"path"') < step.indexOf('"expect"'), "expect last");

  const redSaved = cli(dir, ["suite", "save", "regress"], { input: JSON.stringify(RED) });
  assert.equal(redSaved.code, 0, redSaved.out);
  const listing = cli(dir, ["suite", "list"]);
  assert.equal(listing.code, 0, listing.out);
  for (const pattern of [/smoke/, /regress/, /2 steps?/]) assert.match(listing.out, pattern);
  const human = await cliAsync(dir, ["suite", "run", "smoke"], { API_BASE_URL: api.origin });
  assert.equal(human.code, 0, human.out);
  for (const pattern of [/health/, /pieces/, /pass/i, /2\/2/]) assert.match(human.out, pattern);
  const red = await cliAsync(dir, ["suite", "run", "regress"], { API_BASE_URL: api.origin });
  assert.equal(red.code, 1, red.out);
  for (const pattern of [/FAIL/, /archived/, /active/]) assert.match(red.out, pattern);
  const all = await cliAsync(dir, ["suite", "run"], { API_BASE_URL: api.origin });
  assert.equal(all.code, 1, "one red suite makes the whole run red");
  assert.match(all.out, /smoke/); assert.match(all.out, /regress/);

  const first = await cliAsync(dir, ["suite", "run", "smoke", "--json"], { API_BASE_URL: api.origin });
  const second = await cliAsync(dir, ["suite", "run", "smoke", "--json"], { API_BASE_URL: api.origin });
  assert.equal(first.code, 0, first.out); assert.equal(second.code, 0, second.out);
  assert.deepEqual(JSON.parse(first.out), JSON.parse(second.out), "reruns have the same outcome");
  assert.equal(readFileSync(file, "utf8"), before, "execution must not rewrite the suite");
});

test("save from a file, and a bare single request is normalised to one step", t => {
  const dir = sandbox(t);
  writeFileSync(join(dir, "req.json"), JSON.stringify(
    { method: "GET", path: "/health", expect: [{ status: 200 }] }));
  const r = cli(dir, ["suite", "save", "ping", "req.json"]);
  assert.equal(r.code, 0, r.out);
  const saved = JSON.parse(readFileSync(join(dir, LAYOUT.suites, "ping.json"), "utf8"));
  assert.equal(saved.requests.length, 1);
  assert.equal(saved.requests[0].path, "/health");
});

test("suite save refuses vacuous assertions, unsafe names and each credential location before writing", t => {
  const dir = sandbox(t);
  for (const [name, request, code, exit] of [
    ["hollow", { method: "GET", path: "/health" }, "SUITE_STEP_WITHOUT_EXPECT"],
    ["../escape", GREEN.requests[0], "SUITE_NAME_INVALID"],
    ["header-secret", { method: "GET", path: "/pieces", headers: { Authorization: "Bearer live-token-abcdef" }, expect: [{ status: 200 }] }, "SECRET_IN_SUITE", 2],
    ["body-secret", { method: "POST", path: "/webhooks", body: { note: "use xoxb-9999-REALSECRETVALUE" }, expect: [{ status: 201 }] }, "SECRET_IN_SUITE", 2],
    ["query-secret", { method: "GET", path: "/pieces", params: { api_key: "abcd1234efgh" }, expect: [{ status: 200 }] }, "SECRET_IN_SUITE", 2],
  ]) {
    const result = cli(dir, ["suite", "save", name], { input: JSON.stringify({ v: 2, requests: [request] }) });
    assert.notEqual(result.code, 0, name);
    if (exit) assert.equal(result.code, exit, name);
    assert.ok(result.out.includes(code), name + ": " + result.out);
    assert.equal(existsSync(join(dir, LAYOUT.suites, name + ".json")), false,
      name + ": refused suite must leave nothing on disk");
  }
});

test("declared non-2xx status assertions control step success", async t => {
  const api = await startApi();
  const dir = sandbox(t);
  try {
    cli(dir, ["suite", "save", "expected-404"], { input: JSON.stringify({
      v: 2, requests: [{ id: "missing", method: "GET", path: "/missing",
        expect: [{ status: 404 }] }],
    }) });
    const expected = await cliAsync(dir, ["suite", "run", "expected-404"], { API_BASE_URL: api.origin });
    assert.equal(expected.code, 0, expected.out);
    assert.match(expected.out, /1\/1/);

    cli(dir, ["suite", "save", "wrong-200"], { input: JSON.stringify({
      v: 2, requests: [{ id: "missing", method: "GET", path: "/missing",
        expect: [{ status: 200 }] }],
    }) });
    const wrong = await cliAsync(dir, ["suite", "run", "wrong-200"], { API_BASE_URL: api.origin });
    assert.equal(wrong.code, 1, "a mismatched status assertion must fail");

    // Bypass save deliberately: exercise the loader, not SUITE_NOT_FOUND.
    writeFileSync(join(dir, LAYOUT.suites, "unasserted-404.json"), JSON.stringify({
      v: 2, name: "unasserted-404", requests: [{ id: "missing", method: "GET", path: "/missing" }],
    }));
    const unasserted = await cliAsync(dir, ["suite", "run", "unasserted-404"], { API_BASE_URL: api.origin });
    assert.equal(unasserted.code, 1, "an unasserted non-2xx must remain red");
    assert.match(unasserted.out, /HTTP_404/, "the actual unasserted response must be the failure, not a missing file");
  } finally { api.close(); }
});

test("a dead host is named for a single suite and does not abort run-all reporting", async t => {
  const dir = sandbox(t), api = await startApi(), { origin } = api;
  await api.close();
  cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
  cli(dir, ["suite", "save", "regress"], { input: JSON.stringify(RED) });
  for (const args of [["suite", "run", "smoke"], ["suite", "run"]]) {
    const result = await cliAsync(dir, args, { API_BASE_URL: origin });
    assert.equal(result.code, 1, args.join(" "));
    assert.doesNotMatch(result.out, /triggerUncaughtException|node:internal/);
    assert.match(result.out, /ECONNREFUSED/); assert.match(result.out, /smoke/);
    if (args.length === 2) assert.match(result.out, /regress/, "one failure must not eat the others' reports");
  }
});

test("hand-edited empty and corrupt suites fail by name; missing suites list available names", async t => {
  const dir = sandbox(t);
  cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
  for (const [name, requests, code] of [["empty", [], "EMPTY_ENVELOPE"], ["weird", "nope", "SUITE_CORRUPT"]]) {
    writeFileSync(join(dir, LAYOUT.suites, name + ".json"), JSON.stringify({ v: 2, name, requests }));
    const result = await cliAsync(dir, ["suite", "run", name]);
    assert.equal(result.code, 1, name);
    assert.ok(result.out.includes(code), name + ": " + result.out);
    assert.doesNotMatch(result.out, /suites? green|is not a function|triggerUncaughtException/);
  }
  const missing = await cliAsync(dir, ["suite", "run", "nope"]);
  assert.notEqual(missing.code, 0); assert.match(missing.out, /SUITE_NOT_FOUND/); assert.match(missing.out, /smoke/);
});

test("an unsupported envelope version reaches the report, human and --json alike", async t => {
  const dir = sandbox(t);
  cli(dir, ["suite", "save", "smoke"], { input: JSON.stringify(GREEN) });
  const file = join(dir, LAYOUT.suites, "smoke.json");
  writeFileSync(file, readFileSync(file, "utf8").replace('"v": 2', '"v": 99'));
  const human = await cliAsync(dir, ["suite", "run", "smoke"]);
  assert.equal(human.code, 1);
  assert.match(human.out, /ENVELOPE_VERSION_UNSUPPORTED/,
    "'not run' with no reason anywhere is a report that explains nothing");
  const asJson = await cliAsync(dir, ["suite", "run", "smoke", "--json"]);
  assert.equal(asJson.code, 1);
  const parsed = JSON.parse(asJson.out);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.suites[0].error.code, "ENVELOPE_VERSION_UNSUPPORTED");
});
