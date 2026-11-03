import { LAYOUT } from "../lib/layout.mjs";
// Regression for the retained Aster demo feedback: {data, pagination:{...}}
// was reported as ok:true after only 200 of 1,297 rows. These servers are
// disposable loopback fixtures; no running demo service is contacted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const devices = Array.from({ length: 1297 }, (_, i) => ({
  id: `dev_fixture_${String(i).padStart(4, "0")}`,
  organization_id: "org_fixture", site_id: "site_fixture", status: "online",
}));

async function fixture(t, respond) {
  const requests = [];
  const dir = mkdtempSync(join(tmpdir(), "sannr-paginate-nested-"));
  writeFileSync(join(dir, LAYOUT.environments), "{}\n");
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://fixture.invalid");
    requests.push(url);
    const response = respond(url, requests.length);
    res.writeHead(response.status ?? 200, { "content-type": "application/json", ...response.headers });
    res.end(JSON.stringify(response.body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (args = {}, env = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
      cwd: dir,
      env: { ...process.env, API_BASE_URL: origin, API_CONFIG: join(dir, LAYOUT.environments),
        API_ENV: "", API_ENV_FILE: "", API_AUTH: "", API_CONTRACT: "", API_USAGE_LOG: "/dev/null",
        API_CONTEXT_OFF: "1", API_FRICTION_OFF: "1", SANNR_HOME: join(dir, "home"),
        API_EVIDENCE: join(dir, "evidence"), API_BUDGET: "800", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "", stderr = "", done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true; clearTimeout(timer); child.kill(); fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`MCP call timed out: ${stderr}`)), 15_000);
    child.on("error", (error) => finish(reject, error));
    child.on("exit", (code) => finish(reject, new Error(`MCP exited (${code}): ${stderr}`)));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id !== 100) continue;
        if (message.error) { finish(reject, new Error(JSON.stringify(message.error))); return; }
        try { finish(resolve, JSON.parse(message.result.content[0].text)); }
        catch (error) { finish(reject, error); }
      }
    });
    child.stdin.end([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: {
        name: "api_request", arguments: { path: "/devices", paginate: "all", ...args },
      } },
    ].map((message) => JSON.stringify(message)).join("\n") + "\n");
  });
  return { call, requests, dir };
}

function registryPage(url) {
  const offset = Number(url.searchParams.get("offset") ?? 0);
  const limit = Number(url.searchParams.get("limit") ?? 200);
  return { body: { data: devices.slice(offset, offset + limit),
    pagination: { offset, limit, total: devices.length, has_more: offset + limit < devices.length } } };
}

test("the demo's nested offset envelope returns all 1,297 unique rows in seven requests", async (t) => {
  const f = await fixture(t, registryPage);
  const result = await f.call({ params: { limit: 200, status: "online" }, fields: ["id"] }, { API_BUDGET: "100000" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.discovery.pages, { fetched: 7, rows: 1297, style: "offset", complete: true, stopped_early: null });
  assert.equal(result.discovery.count, 1297);
  assert.deepEqual(result.data.map((row) => row.id), devices.map((row) => row.id));
  assert.equal(new Set(result.data.map((row) => row.id)).size, 1297);
  assert.deepEqual(f.requests.map((url) => Number(url.searchParams.get("offset") ?? 0)), [0, 200, 400, 600, 800, 1000, 1200]);
  assert.ok(f.requests.every((url) => url.searchParams.get("limit") === "200" && url.searchParams.get("status") === "online"));
  const last = JSON.parse(readFileSync(join(f.dir, "evidence", `${result.evidence}-p7.json`), "utf8"));
  assert.equal(last.response.body.pagination.has_more, false);
  assert.equal(last.response.body.data.length, 97);
});

test("the demo request at the default budget reports its 200-row partial result as incomplete", async (t) => {
  const f = await fixture(t, registryPage);
  const result = await f.call({ params: { limit: 200 }, fields: ["id", "organization_id", "site_id", "status"] });
  assert.equal(result.status, 200, "the original HTTP response remains visible");
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "PAGINATION_INCOMPLETE");
  assert.deepEqual(result.discovery.pages, { fetched: 1, rows: 200, style: "offset", complete: false, stopped_early: "budget" });
  assert.equal(f.requests.length, 1);
});

test("a requested page cap remains incomplete even when its status assertion passes", async (t) => {
  const f = await fixture(t, registryPage);
  const result = await f.call({ paginate: { max_pages: 2 }, expect: [{ status: 200 }] }, { API_BUDGET: "100000" });
  assert.equal(result.ok, false);
  assert.equal(result.assertions.passed, 1);
  assert.equal(result.assertions.failed, 0);
  assert.equal(result.discovery.pages.complete, false);
  assert.equal(result.discovery.pages.stopped_early, "page_cap");
  assert.equal(result.discovery.count, 400);
  assert.equal(f.requests.length, 2);
});

test("nested page and cursor metadata both follow through a terminal signal", async (t) => {
  for (const style of ["page", "cursor"]) await t.test(style, async (t) => {
    const f = await fixture(t, (url) => {
      const n = style === "page" ? Number(url.searchParams.get("page") ?? 1) : Number(url.searchParams.get("cursor") ?? 1);
      return { body: { data: [{ id: n }], meta: { pagination: style === "page"
        ? { page: n, per_page: 1, total_pages: 3, has_more: n < 3 }
        : { next_cursor: n < 3 ? String(n + 1) : null } } } };
    });
    const result = await f.call({ fields: ["id"] });
    assert.equal(result.ok, true);
    assert.equal(result.discovery.pages.style, style);
    assert.equal(result.discovery.pages.complete, true);
    assert.deepEqual(result.data, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(f.requests.length, 3);
  });
});

test("has_more:true takes precedence over a short offset page", async (t) => {
  const f = await fixture(t, (url) => {
    const offset = Number(url.searchParams.get("offset") ?? 0);
    return { body: { data: [{ id: offset }], pagination: { offset, limit: 200, has_more: offset < 2 } } };
  });
  const result = await f.call({ fields: ["id"] });
  assert.equal(result.ok, true);
  assert.equal(result.discovery.pages.complete, true);
  assert.deepEqual(result.data, [{ id: 0 }, { id: 1 }, { id: 2 }]);
  assert.deepEqual(f.requests.map((url) => Number(url.searchParams.get("offset") ?? 0)), [0, 1, 2]);
  assert.equal(f.requests[1].searchParams.get("limit"), "200", "the response's default limit is carried forward");
});

test("unsupported, empty, and disappearing pagination signals never look complete", async (t) => {
  const cases = [
    { name: "has_more alone", reason: "unsupported_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }], pagination: { has_more: true } } }) },
    { name: "invalid offset coordinates", reason: "unsupported_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }], pagination: { offset: 0, limit: 0, has_more: true } } }) },
    { name: "unsupported next object", reason: "unsupported_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }], pagination: { next: { bookmark: "another" } } } }) },
    { name: "empty with more rows promised", reason: "empty_page", requests: 2,
      respond: (url, n) => ({ body: { data: n === 1 ? [{ id: 1 }] : [], pagination: { offset: n - 1, limit: 1, total: 3, has_more: true } } }) },
    { name: "metadata disappears", reason: "pagination_signal_lost", requests: 2,
      respond: (url, n) => ({ body: n === 1 ? { data: [{ id: 1 }], pagination: { next_cursor: "second" } } : { data: [{ id: 2 }] } }) },
    { name: "empty cursor contradicts more rows", reason: "inconsistent_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }], pagination: { next_cursor: null, has_more: true } } }) },
    { name: "total contradicts more rows", reason: "inconsistent_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }], pagination: { offset: 0, limit: 1, total: 1, has_more: true } } }) },
    { name: "terminal flag contradicts remaining total", reason: "inconsistent_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }, { id: 2 }], pagination: { offset: 0, limit: 2, total: 10, has_more: false } } }) },
    { name: "root and nested flags conflict", reason: "inconsistent_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }, { id: 2 }], has_more: false,
        pagination: { offset: 0, limit: 2, total: 10, has_more: true } } }) },
    { name: "null cursor contradicts remaining offset total", reason: "inconsistent_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }, { id: 2 }], next_cursor: null,
        pagination: { offset: 0, limit: 2, total: 10 } } }) },
    { name: "page and row totals conflict", reason: "inconsistent_pagination", requests: 1,
      respond: () => ({ body: { data: [{ id: 1 }, { id: 2 }], pagination: { page: 1, per_page: 2, total_pages: 1, total: 10 } } }) },
    { name: "link then cursor metadata disappears", reason: "pagination_signal_lost", requests: 3,
      respond: (url, n) => n === 1 ? { headers: { link: '</devices?page=2>; rel="next"' }, body: { data: [{ id: 1 }] } }
        : { body: n === 2 ? { data: [{ id: 2 }], next_cursor: "third" } : { data: [{ id: 3 }] } } },
    { name: "later HTTP failure", reason: "error_page", requests: 2,
      respond: (url, n) => n === 1 ? { body: { data: [{ id: 1 }], pagination: { next_cursor: "second" } } }
        : { status: 503, body: { error: "fixture failure" } } },
  ];
  for (const scenario of cases) await t.test(scenario.name, async (t) => {
    const f = await fixture(t, scenario.respond);
    const result = await f.call();
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "PAGINATION_INCOMPLETE");
    assert.equal(result.discovery.pages.complete, false);
    assert.equal(result.discovery.pages.stopped_early, scenario.reason);
    assert.equal(f.requests.length, scenario.requests);
  });
});

test("a nested next link cannot escape the configured origin", async (t) => {
  const f = await fixture(t, () => ({ body: { data: [{ id: 1 }], pagination: { next: "http://127.0.0.1:9/never-follow" } } }));
  const result = await f.call();
  assert.equal(result.ok, false);
  assert.equal(result.discovery.pages.complete, false);
  assert.equal(result.discovery.pages.stopped_early, "cross_origin");
  assert.equal(f.requests.length, 1);
});

test("pagination-like fields inside a collection row are not navigation instructions", async (t) => {
  const f = await fixture(t, () => ({ body: { data: [{ id: 1, pagination: { next: "http://127.0.0.1:9/never-follow", has_more: true } }] } }));
  const result = await f.call();
  assert.equal(result.ok, true);
  assert.equal(result.discovery.pages.complete, null, "no pagination signal is an unknown, not proven completion");
  assert.equal(result.discovery.pages.stopped_early, null);
  assert.equal(f.requests.length, 1);
});
