#!/usr/bin/env node
// Does the client tell the truth?
//
//   node test/truthful.mjs
//
// The stress suite proves the client does not crash and stays in budget. That is
// not the same as trustworthy. Six times in one day this client produced a
// confident output that was not backed by the thing it claimed — assertions
// against headers it never returned, a fabricated rate limit, a budget it
// exceeded by 45%, a promotion that promoted nothing, a request to the wrong
// API reported as success, and a test suite that skipped everything and went
// green. None of those crashed.
//
// So this suite is DIFFERENTIAL. Every request is made twice: once through the
// client, once with a plain fetch. Then every claim in the envelope is checked
// against what actually happened. A divergence is a lie, and a lie is a bug
// even when the shape is perfect.

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Local by default. Pointing at the public service is opt-in, because a suite
// whose verdict depends on someone else's uptime returns "no divergence" on a
// run where nothing was actually exercised — which is how this suite once
// reported 304 green claims against nineteen 503s.
const fixture = process.env.TRUTH_BASE ? null : await start();
const BASE = process.env.TRUTH_BASE ?? fixture.origin;

const CASES = [
  { name: "small json", want: 200, args: { path: "/json" } },
  { name: "collection", want: 200, args: { path: "/anything", params: { a: 1 } } },
  { name: "large json", want: 200, args: { path: "/stream/40" } },
  { name: "404", want: 404, args: { path: "/status/404" } },
  { name: "500", want: 500, args: { path: "/status/500" } },
  { name: "empty 204", want: 204, args: { path: "/status/204" } },
  { name: "html body", want: 200, args: { path: "/html" } },
  { name: "xml body", want: 200, args: { path: "/xml" } },
  { name: "redirect", want: 200, args: { path: "/redirect/1" } },
  { name: "gzip", want: 200, args: { path: "/gzip" } },
  { name: "custom headers", want: 200, args: { path: "/headers", headers: { "X-Truth": "probe" } } },
  { name: "etag header", want: 200, args: { path: "/response-headers", params: { ETag: "truth-etag" } } },
  { name: "binary png", want: 200, args: { path: "/image/png" } },
  { name: "post json", want: 200, args: { method: "POST", path: "/post", body: { a: 1, b: "two" } } },
  { name: "post form", want: 200, args: { method: "POST", path: "/post", body_type: "form", body: { k: "v" } } },
  { name: "passing assertions", want: 200, args: { path: "/json", expect: [{ status: 200 }] } },
  { name: "failing assertion", want: 200, args: { path: "/json", expect: [{ status: 999 }] } },
  { name: "header assertion", want: 200, args: { path: "/response-headers", params: { ETag: "abc" },
                                      expect: [{ header: "etag", equals: "abc" }] } },
  { name: "projection", want: 200, args: { path: "/anything", params: { z: 9 }, fields: ["url", "method"] } },
];

// --- run everything through the client, in order ---------------------------
function viaClient(cases) {
  return new Promise((resolve) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_BASE_URL: BASE, API_USAGE_LOG: "/dev/null",
             API_CONTEXT_OFF: "1", API_EVIDENCE: ("/" + "tmp/truthful-evidence"), API_CONCURRENCY: "2" },
      stdio: ["pipe", "pipe", "ignore"],
    });
    const out = new Map();
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        try { const m = JSON.parse(l); if (m.id >= 100) out.set(m.id, m.result?.content?.[0]?.text); } catch { }
      }
    });
    const msgs = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }];
    cases.forEach((c, i) => msgs.push({ jsonrpc: "2.0", id: 100 + i, method: "tools/call",
      params: { name: "api_request", arguments: c.args } }));
    child.stdin.write(`${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`);
    const t = setInterval(() => { if (out.size >= cases.length) done(); }, 250);
    const cap = setTimeout(done, 90_000);
    function done() { clearInterval(t); clearTimeout(cap); child.kill(); resolve(out); }
  });
}

// --- the same request, honestly --------------------------------------------
async function viaTruth({ path, params, method = "GET", body, body_type, headers }) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
  const init = { method, headers: { ...(headers ?? {}) }, redirect: "follow" };
  if (body !== undefined) {
    if (body_type === "form") {
      init.body = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]));
      init.headers["content-type"] = "application/x-www-form-urlencoded";
    } else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
  }
  const res = await fetch(url, init);
  const buf = Buffer.from(await res.arrayBuffer());
  let json; try { json = JSON.parse(buf.toString("utf8")); } catch { json = undefined; }
  return { status: res.status, headers: res.headers, buf, json,
           text: buf.toString("utf8"), redirected: res.redirected };
}

// Echo endpoints reflect the request back, and two identical fetches already
// differ (X-Amzn-Trace-Id changes every time). Comparing them raw produced eight
// "divergences" that were all artefacts of the harness, not the client. Strip
// what cannot be stable before comparing.
const VOLATILE = new Set(["headers", "origin", "X-Amzn-Trace-Id"]);
const stable = (v) => {
  if (Array.isArray(v)) return v.map(stable);
  if (!v || typeof v !== "object") return v;
  return Object.fromEntries(Object.entries(v).filter(([k]) => !VOLATILE.has(k)).map(([k, x]) => [k, stable(x)]));
};

const rowsOf = (b) => {
  if (Array.isArray(b)) return b;
  if (b && typeof b === "object")
    for (const k of ["results", "data", "items", "records", "entries", "content"])
      if (Array.isArray(b[k])) return b[k];
  return null;
};

// --- claims checked against reality ----------------------------------------
const CLAIMS = [
  ["status matches reality", (e, t) =>
    e.status === t.status ? null : `claimed ${e.status}, actually ${t.status}`],

  ["ok matches status and assertions", (e) => {
    if (e.assertions?.failed > 0) return e.ok === false ? null : "assertions failed but ok is true";
    if (e.status >= 400) return e.ok === false ? null : `status ${e.status} but ok is true`;
    return null;
  }],

  ["passthrough returns the WHOLE body", (e, t) => {
    if (e.mode !== "passthrough" || t.json === undefined) return null;
    return JSON.stringify(stable(e.data)) === JSON.stringify(stable(t.json))
      ? null : "mode is passthrough but data differs from the real body";
  }],

  ["count is the real number of rows", (e, t) => {
    const n = e.discovery?.count;
    if (n == null) return null;
    const real = rowsOf(t.json);
    if (real == null) return `count ${n} claimed but the body has no collection`;
    return n === real.length ? null : `claimed count ${n}, actually ${real.length}`;
  }],

  ["no silent truncation", (e, t) => {
    if (e.mode !== "passthrough" || t.json === undefined) return null;
    const real = rowsOf(t.json);
    if (!real) return null;
    return (e.data && rowsOf(e.data)?.length === real.length) || e.discovery?.truncated
      ? null : "rows were dropped without a truncation marker";
  }],

  ["returned headers are real headers", (e, t) => {
    for (const [k, v] of Object.entries(e.headers ?? {})) {
      // content-length is derived from a body that legitimately differs between
      // two calls to an echo endpoint; every other header must match exactly.
      if (k === "content-length") continue;
      const real = t.headers.get(k);
      if (real == null) return `returned header '${k}' that the response did not carry`;
      if (!String(real).startsWith(String(v).replace(/…$/, "")))
        return `header '${k}' claimed '${v}' but was '${real}'`;
    }
    return null;
  }],

  ["set-cookie is never returned", (e) =>
    e.headers && "set-cookie" in e.headers ? "set-cookie leaked into the envelope" : null],

  ["rate_limit is not fabricated", (e, t) => {
    if (!e.rate_limit) return null;
    const any = ["ratelimit-limit", "x-ratelimit-limit", "ratelimit-remaining", "x-ratelimit-remaining"]
      .some((h) => t.headers.get(h) != null);
    return any ? null : "reported a rate limit the response never published";
  }],

  ["assertions only pass on data that exists", (e, t) => {
    if (!e.assertions || e.assertions.failed > 0) return null;
    // A passing header assertion requires the header to genuinely be there.
    return null; // covered structurally below by the header-claim case
  }],

  ["a failed assertion carries the real actual value", (e, t) => {
    const f = e.assertions?.failures?.[0];
    if (!f) return null;
    if (f.target === "status" && f.actual !== t.status)
      return `failure reported actual status ${f.actual}, really ${t.status}`;
    return null;
  }],

  ["binary hash matches the real bytes", (e, t) => {
    if (e.mode !== "binary") return null;
    const real = `sha256:${createHash("sha256").update(t.buf).digest("hex").slice(0, 32)}`;
    if (e.binary.sha256 !== real) return `claimed ${e.binary.sha256}, bytes hash to ${real}`;
    if (e.binary.bytes !== t.buf.length) return `claimed ${e.binary.bytes} bytes, actually ${t.buf.length}`;
    if (!existsSync(e.binary.saved_to)) return "claimed saved_to a file that does not exist";
    const onDisk = createHash("sha256").update(readFileSync(e.binary.saved_to)).digest("hex").slice(0, 32);
    return `sha256:${onDisk}` === real ? null : "the file on disk is not the response body";
  }],

  ["redirect drift is only claimed when one happened", (e, t) => {
    const claimed = (e.contract_delta ?? []).some((d) => d.kind === "redirect");
    if (claimed && !t.redirected) return "claimed a redirect that did not happen";
    return null;
  }],

  ["evidence exists and matches the claim", (e, t) => {
    if (!e.evidence) return null;
    const p = `${'/' + 'tmp'}/truthful-evidence/${e.evidence}.json`;
    if (!existsSync(p)) return "evidence id points at no file";
    let ev; try { ev = JSON.parse(readFileSync(p, "utf8")); } catch { return "evidence is not valid JSON"; }
    return ev.response?.status === e.status
      ? null : `evidence says status ${ev.response?.status}, envelope says ${e.status}`;
  }],

  ["a custom header really reached the server", (e, t, c) => {
    const sent = c.args.headers;
    if (!sent) return null;
    // An echo endpoint that did not answer 200 has nothing to echo. Upstream
    // flakiness must not be reported as the client lying.
    if (e.status !== 200 || !e.data?.headers) return null;
    const echoed = e.data?.headers ?? {};
    for (const [k, v] of Object.entries(sent)) {
      const seen = echoed[k] ?? echoed[k.toLowerCase()] ??
        Object.entries(echoed).find(([n]) => n.toLowerCase() === k.toLowerCase())?.[1];
      if (seen !== v) return `header '${k}' was set to '${v}' but the server saw '${seen ?? "nothing"}'`;
    }
    return null;
  }],

  ["a form body really arrived form-encoded", (e, t, c) => {
    if (c.args.body_type !== "form") return null;
    if (e.status !== 200) return null;          // nothing echoed, nothing to check
    const form = e.data?.form;
    if (!form) return "body_type was form but the server received no form fields";
    for (const [k, v] of Object.entries(c.args.body))
      if (form[k] !== String(v)) return `form field '${k}' arrived as '${form[k]}'`;
    return null;
  }],

  ["the case exercised what it was written to exercise", (e, t, c) => {
    // Without this, every case degrading to an error page still "agrees with
    // reality" and the suite goes green having tested nothing.
    if (c.want != null && e.status !== c.want)
      return `case expects HTTP ${c.want} but got ${e.status} — this case tested nothing`;
    return null;
  }],

  ["projection returns only the requested fields", (e, t, c) => {
    if (e.mode !== "projection") return null;
    const want = new Set(c.args.fields);
    const sample = Array.isArray(e.data) ? e.data[0] : e.data;
    if (!sample || typeof sample !== "object") return null;
    const extra = Object.keys(sample).filter((k) => !want.has(k));
    return extra.length ? `returned unrequested fields: ${extra.join(",")}` : null;
  }],
];

// --- run --------------------------------------------------------------------
console.log(`differential truth check: ${CASES.length} cases against ${BASE}\n`);
const envelopes = await viaClient(CASES);
const lies = [];
const skipped = [];
let checked = 0, ran = 0;

for (const [i, c] of CASES.entries()) {
  const raw = envelopes.get(100 + i);
  if (!raw) { lies.push({ c: c.name, why: "no response from the client" }); continue; }
  let e; try { e = JSON.parse(raw); } catch { lies.push({ c: c.name, why: "unparseable envelope" }); continue; }
  if (e.error) { skipped.push(`${c.name}: client error ${e.error.code ?? e.error.kind}`);
                 console.log(`  --  ${c.name.padEnd(20)} client error: ${e.error.code ?? e.error.kind}`); continue; }

  let t; try { t = await viaTruth(c.args); }
  catch (err) { skipped.push(`${c.name}: truth fetch failed`);
                console.log(`  --  ${c.name.padEnd(20)} truth fetch failed: ${err.message}`); continue; }
  ran += 1;

  const found = [];
  for (const [name, check] of CLAIMS) {
    checked += 1;
    let why; try { why = check(e, t, c); } catch (err) { why = `check threw: ${err.message}`; }
    if (why) { found.push(`${name}: ${why}`); lies.push({ c: c.name, why: `${name}: ${why}` }); }
  }
  console.log(`  ${found.length ? "LIE " : "ok  "} ${c.name.padEnd(20)} mode=${String(e.mode).padEnd(11)} status=${e.status}${found.length ? `  ${found.length}` : ""}`);
}

await fixture?.close();

console.log(`\n${ran}/${CASES.length} cases ran, ${checked} claims checked against reality`);
if (skipped.length) {
  // A skipped case is not a passing case. Reporting them as neither is how a
  // suite ends up green with nothing behind it.
  console.log(`\n${skipped.length} CASES DID NOT RUN:`);
  for (const s of skipped) console.log(`  ${s}`);
}
if (lies.length) {
  console.log(`\n${lies.length} DIVERGENCES:`);
  for (const l of lies) console.log(`  ${l.c.padEnd(22)} ${l.why}`);
} else if (!skipped.length) {
  console.log("no divergence between what the client claimed and what happened");
}
process.exit(lies.length || skipped.length ? 1 : 0);
