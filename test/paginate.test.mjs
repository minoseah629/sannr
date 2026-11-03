// Pagination auto-follow (F4).
//
//   node --test test/paginate.test.mjs
//
// Real collections paginate, and before this feature the agent hand-rolled the
// loop: one turn per page, one envelope per page, and no protection at all
// against a next-link that never terminates. The client now detects the style
// FROM THE RESPONSE (cursor field, page/per_page, offset/limit, Link rel=next)
// and follows it — but only when asked, never unbounded, and the summary says
// how many pages were fetched and which guard stopped it.
//
// Every test here failed against the pre-change client, which ignored the
// `paginate` option entirely: discovery.pages did not exist and counts were
// one page's worth.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Drive the real MCP adapter rather than the core, so what is asserted is what
// an agent would actually receive.
function call(base, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_BASE_URL: base, API_USAGE_LOG: "/dev/null",
             API_CONTEXT_OFF: "1", API_EVIDENCE: ("/" + "tmp/paginate-evidence"), ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "", done = false;
    const finish = (fn, v) => { if (done) return; done = true; child.kill(); fn(v); };
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        try {
          const m = JSON.parse(l);
          if (m.id === 100) finish(resolve, JSON.parse(m.result.content[0].text));
        } catch { /* not our line */ }
      }
    });
    child.stdin.write(`${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 100, method: "tools/call", params: { name: "api_request", arguments: args } },
    ].map((m) => JSON.stringify(m)).join("\n")}\n`);
    setTimeout(() => finish(reject, new Error("timed out")), 20_000);
  });
}

test("cursor style: next_cursor is followed to exhaustion", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/cursor", paginate: "all" });
    assert.equal(e.status, 200);
    assert.equal(e.discovery?.pages?.fetched, 3, "three pages of four rows exist");
    assert.equal(e.discovery?.pages?.style, "cursor");
    assert.equal(e.discovery?.pages?.stopped_early, null, "exhaustion is completion, not a stop");
    assert.equal(e.discovery?.count, 12, "all pages' rows are accumulated");
  } finally { await f.close(); }
});

test("page style: page/per_page is followed to exhaustion", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/page", paginate: { max_pages: 10 } });
    assert.equal(e.discovery?.pages?.fetched, 3);
    assert.equal(e.discovery?.pages?.style, "page");
    assert.equal(e.discovery?.count, 12);
  } finally { await f.close(); }
});

test("offset style: offset/limit is followed to exhaustion", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/offset", paginate: "all" });
    assert.equal(e.discovery?.pages?.fetched, 3);
    assert.equal(e.discovery?.pages?.style, "offset");
    assert.equal(e.discovery?.count, 12);
  } finally { await f.close(); }
});

test("Link rel=next over a bare array is followed", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/link", paginate: "all" });
    assert.equal(e.discovery?.pages?.fetched, 3);
    assert.equal(e.discovery?.pages?.style, "link");
    assert.equal(e.discovery?.count, 12);
  } finally { await f.close(); }
});

test("max_pages is honored and reported as the stop reason", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/cursor", paginate: { max_pages: 2 } });
    assert.equal(e.discovery?.pages?.fetched, 2);
    assert.equal(e.discovery?.pages?.stopped_early, "page_cap");
    assert.equal(e.discovery?.count, 8, "two pages of four, and no more were fetched");
  } finally { await f.close(); }
});

test("a next-cursor that never advances stops as a loop, not an infinite fetch", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/loop", paginate: "all" });
    assert.equal(e.discovery?.pages?.stopped_early, "loop");
    assert.equal(e.discovery?.pages?.fetched, 2, "the repeat is noticed on the second page, before a third fetch");
  } finally { await f.close(); }
});

test("the token budget stops accumulation and says so", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/big", paginate: "all" }, { API_BUDGET: "400" });
    assert.equal(e.discovery?.pages?.stopped_early, "budget");
    assert.ok(e.discovery.pages.fetched < 10,
      `the budget must bite long before the cursor runs out, fetched ${e.discovery?.pages?.fetched}`);
  } finally { await f.close(); }
});

test("the hard page cap holds even when the budget would allow more", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/big", paginate: "all" },
      { API_BUDGET: "1000000", API_PAGINATE_CAP: "5" });
    assert.equal(e.discovery?.pages?.fetched, 5);
    assert.equal(e.discovery?.pages?.stopped_early, "page_cap");
  } finally { await f.close(); }
});

test("a rel=next pointing at another origin is refused, not fetched", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/link-cross", paginate: "all" });
    assert.equal(e.discovery?.pages?.fetched, 1, "the cross-origin page must never be requested");
    assert.equal(e.discovery?.pages?.stopped_early, "cross_origin");
    assert.ok((e.contract_delta ?? []).some((d) => d.kind === "pagination-cross-origin"),
      "the refusal is reported, so the agent knows the collection is incomplete");
  } finally { await f.close(); }
});

test("pagination is OFF by default: no option, one page, no pages block", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/cursor" });
    assert.equal(e.discovery?.pages, undefined, "the summary must not grow keys for a feature not in use");
    assert.equal(e.discovery?.count, 4, "exactly one page's rows");
  } finally { await f.close(); }
});

test("paginate on a non-GET is refused loudly", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { method: "POST", path: "/anything", paginate: "all" });
    assert.equal(e.ok, false);
    assert.equal(e.error?.code, "INVALID_PAGINATE", "replaying a write across pages must never happen silently");
  } finally { await f.close(); }
});

test("a malformed paginate option is an error, not a silent single page", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { path: "/paginate/cursor", paginate: { max_pages: "lots" } });
    assert.equal(e.ok, false);
    assert.equal(e.error?.code, "INVALID_PAGINATE");
  } finally { await f.close(); }
});

test("paginate works inside a batch request", async () => {
  const f = await start();
  try {
    const e = await call(f.origin, { requests: [{ method: "GET", path: "/paginate/cursor", paginate: "all" }] });
    assert.equal(e.results?.[0]?.discovery?.pages?.fetched, 3);
    assert.equal(e.results?.[0]?.discovery?.count, 12);
  } finally { await f.close(); }
});
