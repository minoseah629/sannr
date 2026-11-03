#!/usr/bin/env node
// Stress the client against real public APIs through the real MCP path.
//
//   node test/stress.mjs [--quick]
//   SANNR_STRESS_LOCAL=1 node test/stress.mjs  # fixture only; no public matrix
//
// This is not a token measurement. It asks one question: does the client always
// return a well-formed, budgeted, structured result, whatever the internet does
// to it — HTML error pages, redirects, 401s, resets, 200KB payloads, empty
// bodies, unicode, chunked encoding, and deliberate 5xx.
//
// Every response is checked against invariants. A violation is a bug.

import { spawn } from "node:child_process";
import { start } from "./fixture-server.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUDGET = 800;
const QUICK = process.argv.includes("--quick");
const REPEAT = Number(process.argv.find((a) => a.startsWith("--repeat="))?.split("=")[1] ?? 1);
const OAUTH = process.argv.includes("--oauth");

export function classifyMissing({ base, local, missing, retryMissing }) {
  if (!missing.length) return { degraded: null, violations: [], exitCode: 0 };
  if (local) return {
    degraded: null,
    violations: missing.map((req) => ({ base, req, why: "no response" })),
    exitCode: 1,
  };
  return {
    degraded: { base, reason: "no response after retry", n: retryMissing.length },
    violations: [],
    exitCode: 0,
  };
}

// The edge cases run against a local fixture by default. They were pointed at
// httpbin.org, and on a day that service answered 503 to everything, the suite
// still printed "no invariant violations" — 46 of 99 requests had exercised
// nothing but the error path. Set STRESS_EDGE=https://httpbin.org to check the
// fixture against the real thing.
//
// The other seventeen hosts stay real on purpose: the point of them is that
// nobody wrote them to be convenient for us.
const EDGE = process.env.STRESS_EDGE ?? null;   // resolved to the fixture below

// host -> requests. The edge host carries the deliberate edge cases; the rest
// are ordinary APIs behaving the way real APIs behave.
const SUITES = {
  "__EDGE__": [
    { path: "/get" }, { path: "/json" }, { path: "/uuid" }, { path: "/headers" },
    { path: "/status/200" }, { path: "/status/204" }, { path: "/status/400" },
    { path: "/status/404" }, { path: "/status/418" }, { path: "/status/500" },
    { path: "/status/503" },
    { path: "/redirect/1" }, { path: "/redirect/3" }, { path: "/absolute-redirect/1" },
    { path: "/relative-redirect/2" },
    { path: "/gzip" }, { path: "/deflate" }, { path: "/brotli" },
    { path: "/xml" }, { path: "/html" }, { path: "/robots.txt" }, { path: "/encoding/utf8" },
    { path: "/bytes/1024" }, { path: "/stream/5" }, { path: "/stream-bytes/2048" },
    { path: "/cache" }, { path: "/etag/abc" }, { path: "/response-headers", params: { a: "1" } },
    { path: "/delay/1" },
    { method: "POST", path: "/post", body: { hello: "world", n: 1 } },
    { method: "POST", path: "/post", body: { nested: { deep: { deeper: [1, 2, { x: null }] } } } },
    { method: "POST", path: "/post", body: { unicode: "日本語 · emoji 🚚 · quotes \"'" } },
    { method: "POST", path: "/post", body: { big: "x".repeat(5000) } },
    { method: "PUT", path: "/put", body: { replaced: true } },
    { method: "PATCH", path: "/patch", body: { patched: true } },
    { method: "DELETE", path: "/delete" },
    { path: "/basic-auth/user/passwd" },          // 401 without credentials
    { path: "/bearer" },                          // 401 without a token
    { path: "/anything", params: { "weird key": "a b&c=d", "unicode": "日本" } },
    { path: "/headers", headers: { "X-Trace-Id": "stress", Accept: "application/json" } },
    { method: "POST", path: "/post", body_type: "form", body: { grant_type: "client_credentials" } },
    { path: "/image/png" }, { path: "/image/jpeg" },
    { path: "/cookies/set", params: { probe: "1" } }, { path: "/cookies" },
    { path: "/response-headers", params: { ETag: "xyz", Link: "</next>; rel=next" } },
  ],
  "https://pokeapi.co/api/v2": [
    { path: "/pokemon/1" }, { path: "/pokemon", params: { limit: 100 } },
    { path: "/pokemon", params: { limit: 1 } }, { path: "/type/3" },
    { path: "/berry" }, { path: "/pokemon/does-not-exist" },
  ],
  "https://dummyjson.com": [
    { path: "/products/1" }, { path: "/products", params: { limit: 30 } },
    { path: "/users", params: { limit: 5 } }, { path: "/products/search", params: { q: "phone" } },
    { method: "POST", path: "/products/add", body: { title: "probe" } },
    { method: "PUT", path: "/products/1", body: { title: "changed" } },
    { method: "DELETE", path: "/products/1" },
    { path: "/products/99999" },
  ],
  "https://jsonplaceholder.typicode.com": [
    { path: "/posts/1" }, { path: "/posts" }, { path: "/comments", params: { postId: 1 } },
    { method: "POST", path: "/posts", body: { title: "t", body: "b", userId: 1 } },
    { method: "PUT", path: "/posts/1", body: { id: 1, title: "t" } },
    { method: "PATCH", path: "/posts/1", body: { title: "t" } },
    { method: "DELETE", path: "/posts/1" },
    { path: "/posts/0" },
  ],
  "https://api.github.com": [
    { path: "/repos/nodejs/node" }, { path: "/repos/nodejs/node/languages" },
    { path: ("/" + "users/octocat") }, { path: "/repos/does-not-exist-xyz/nope" },
  ],
  "https://restcountries.com/v3.1": [
    { path: "/name/japan" }, { path: "/region/europe" }, { path: "/name/zzzznotacountry" },
  ],
  "https://rickandmortyapi.com/api": [
    { path: "/character/1" }, { path: "/character" }, { path: "/location" }, { path: "/character/99999" },
  ],
  "https://openlibrary.org": [
    { path: "/search.json", params: { q: "dune", limit: 5 } }, { path: "/isbn/9780441013593.json" },
  ],
  "https://api.artic.edu/api/v1": [
    { path: "/artworks", params: { limit: 3 } }, { path: "/artworks/129884" },
  ],
  "https://gutendex.com": [{ path: "/books/1" }, { path: "/books", params: { search: "dickens" } }],
  "https://api.chucknorris.io": [{ path: "/jokes/random" }, { path: "/jokes/categories" }],
  "https://catfact.ninja": [{ path: "/fact" }, { path: "/breeds", params: { limit: 5 } }],
  "https://dog.ceo/api": [{ path: "/breeds/image/random" }, { path: "/breeds/list/all" }],
  "https://api.zippopotam.us": [{ path: "/us/90210" }, { path: "/us/00000" }],
  "https://api.open-meteo.com/v1": [
    { path: "/forecast", params: { latitude: 37.8, longitude: -122.4, current: "temperature_2m" } },
    { path: "/forecast", params: { latitude: 999, longitude: 999 } },
  ],
  "https://api.coingecko.com/api/v3": [{ path: "/ping" }, { path: "/simple/price", params: { ids: "bitcoin", vs_currencies: "usd" } }],
  // Deliberately broken targets: the client must degrade, not crash.
  "https://api.spacexdata.com/v4": [{ path: "/launches/latest" }],
  "https://this-host-does-not-exist-xyz.invalid": [{ path: "/anything" }],
};

// Pure selection lets the offline check prove its network scope before a
// fixture or client process starts. The default remains the public matrix.
export function selectStressHosts({ suites = SUITES, fixtureOrigin = "__EDGE__", edge = null, localOnly = false, quick = false } = {}) {
  if (localOnly && edge !== null) throw new Error("SANNR_STRESS_LOCAL refuses a STRESS_EDGE override");
  return Object.entries(suites)
    .filter(([base]) => !localOnly || base === "__EDGE__")
    .map(([base, requests]) => [base === "__EDGE__" ? (edge ?? fixtureOrigin) : base, requests])
    .slice(0, quick ? 4 : undefined);
}

// --- invariants ------------------------------------------------------------
// Each returns null when satisfied, or a string describing the violation.
const INVARIANTS = [
  ["parses", (r) => (r === null ? "response was not JSON" : null)],
  ["structured", (r) => (r && (r.error || r.v !== undefined) ? null : "neither an envelope nor an error")],
  ["stable keys", (r) => {
    if (r.error) return null;
    const required = ["v", "status", "ok", "mode", "assertions", "data", "discovery",
                      "headers", "contract_delta", "rate_limit", "evidence"];
    const missing = required.filter((k) => !(k in r));
    return missing.length ? `missing keys: ${missing.join(",")}` : null;
  }],
  ["known mode", (r) => (r.error || ["assert", "projection", "passthrough", "summary", "refused", "binary"].includes(r.mode)
    ? null : `unknown mode '${r.mode}'`)],
  // ADR-0032: the budget is a threshold that selects a gear, not a guarantee made
  // to the agent. Missing a soft target by a few percent harms nobody; an agent
  // believing it holds a whole body when it does not is the failure that does.
  // The overage is reported in the summary either way, so regressions stay visible.
  ["no silent truncation", (r) => {
    if (r.error || r.mode !== "summary") return null;
    // Summary does not empty `data`, it replaces the body with a one-row sample.
    // The first draft of this check demanded `data === null` and reported eight
    // healthy hosts as defective. What must be true is only that discovery
    // explains the reduction, however the payload was reduced.
    const d = r.discovery;
    return d && (d.truncated != null || d.count != null || d.shape != null)
      ? null : "a summary reduced the body with nothing in discovery to say so";
  }],
  ["truncation is never silently partial", (r) => {
    // A partial array without a marker is the worst case: it looks complete.
    if (r.error || !Array.isArray(r.data) || r.discovery?.count == null) return null;
    return r.data.length < r.discovery.count && r.discovery.truncated == null
      ? `returned ${r.data.length} of ${r.discovery.count} rows with no truncation marker` : null;
  }],
  ["error is explained", (r) => {
    if (!r.error) return null;
    const e = r.error;
    // An envelope-level error must name itself. A transport failure carries
    // kind+message; a config refusal carries code+message.
    return (e.code || e.kind) && (e.message || e.body !== undefined)
      ? null : `error without a code or message: ${JSON.stringify(e).slice(0, 80)}`;
  }],
  ["evidence recorded", (r) => (r.error || r.mode === "refused" || r.evidence ? null : "no evidence id")],
];

// --- runner ----------------------------------------------------------------

export function runHost(base, requests, { deadline } = {}) {
  return new Promise((resolve) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_BASE_URL: base, API_USAGE_LOG: "/dev/null",
             API_CONTEXT_OFF: "1", API_EVIDENCE: ("/" + "tmp/stress-evidence"),
             API_CONCURRENCY: "2", API_CONTRACT: "", API_AUTH: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const results = new Map();
    let buf = "", stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id >= 100) results.set(m.id, m.result?.content?.[0]?.text ?? null);
        } catch { /* not our line */ }
      }
    });

    const msgs = [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }];
    requests.forEach((r, i) => msgs.push({
      jsonrpc: "2.0", id: 100 + i, method: "tools/call",
      params: { name: "api_request", arguments: r },
    }));
    child.stdin.write(`${msgs.map((m) => JSON.stringify(m)).join("\n")}\n`);

    const hostDeadline = deadline ?? (QUICK ? 25_000 : 60_000);
    const timer = setInterval(() => {
      if (results.size >= requests.length) finish();
    }, 250);
    const cap = setTimeout(finish, hostDeadline);
    function finish() {
      clearInterval(timer); clearTimeout(cap);
      child.kill();
      resolve({ base, requests, results, stderr });
    }
  });
}

async function main() {
// Resolve the edge placeholder to a real origin: the local fixture unless the
// suite was explicitly pointed at a public one.
const localOnly = process.env.SANNR_STRESS_LOCAL === "1";
if (localOnly) console.log("LOCAL MODE — not the stress gate; run `npm run test:stress` unset before committing");
const selectedHosts = selectStressHosts({ edge: EDGE, localOnly, quick: QUICK });
const fixture = EDGE ? null : await start();
let hosts = selectedHosts.map(([base, requests]) => [base === "__EDGE__" ? fixture.origin : base, requests]);
if (REPEAT > 1) hosts = hosts.map(([b, r]) => [b, Array.from({ length: REPEAT }, () => r).flat()]);
console.log(`stressing ${hosts.length} hosts, ${hosts.reduce((s, [, r]) => s + r.length, 0)} requests\n`);

const violations = [];
let answered = 0, missing = 0, total = 0, crashed = 0, worst = 0, worstAt = "";
const modes = {}, statuses = {};
// A request that came back 5xx or as a transport error tells us the client
// handled a failure; it does not tell us the client parses, projects, or
// summarises correctly. Counting the two together is how a dead upstream reads
// as coverage.
const degraded = [];
const overTarget = [];

for (const [base, requests] of hosts) {
  const first = await runHost(base, requests);
  const local = !EDGE && base === fixture?.origin;
  const missingIndices = requests.map((_, i) => i).filter((i) => !first.results.has(100 + i));
  const missingRequests = missingIndices.map((i) => requests[i]);
  const results = first.results;
  if (missingRequests.length && !local) {
    const retry = await runHost(base, missingRequests);
    missingIndices.forEach((originalIndex, i) => {
      const raw = retry.results.get(100 + i);
      if (raw != null) results.set(100 + originalIndex, raw);
    });
  }
  const { stderr } = first;
  total += requests.length;
  if (/Error|throw|unhandled/i.test(stderr)) {
    crashed += 1;
    violations.push({ base, req: "(process)", why: `stderr: ${stderr.split("\n")[0].slice(0, 120)}` });
  }
  let hostViolations = 0, exercised = 0;
  requests.forEach((req, i) => {
    const raw = results.get(100 + i);
    const label = `${req.method ?? "GET"} ${req.path}`;
    if (raw == null) { missing += 1; return; }
    answered += 1;
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* leave null */ }
    for (const [name, check] of INVARIANTS) {
      const why = parsed === null && name !== "parses" ? null : check(parsed, raw);
      if (why) { violations.push({ base, req: label, why: `${name}: ${why}` }); hostViolations += 1; break; }
    }
    if (parsed?.mode) modes[parsed.mode] = (parsed.mode ? modes[parsed.mode] ?? 0 : 0) + 1;
    if (parsed?.status >= 200 && parsed.status < 500) exercised += 1;
    const st = parsed?.status ?? (parsed?.error ? "error" : "?");
    statuses[st] = (statuses[st] ?? 0) + 1;
    const tok = Math.ceil(raw.length / 4);
    if (tok > BUDGET) overTarget.push({ base, label, tok });
    if (tok > worst) { worst = tok; worstAt = `${base.replace("https://", "")} ${label}`; }
  });
  const stillMissing = requests.map((req, i) => `${req.method ?? "GET"} ${req.path}`).filter((_, i) => !results.has(100 + i));
  const missingDecision = classifyMissing({ base, local, missing: stillMissing, retryMissing: stillMissing });
  violations.push(...missingDecision.violations);
  hostViolations += missingDecision.violations.length;
  if (missingDecision.degraded) degraded.push(missingDecision.degraded);
  if (exercised === 0 && requests.length > 1 && !missingDecision.degraded)
    degraded.push({ base, reason: "every request was 5xx or a transport error", n: requests.length });
  const cover = exercised < requests.length ? `   ${exercised}/${requests.length} exercised` : "";
  console.log(`${hostViolations === 0 ? "ok  " : "FAIL"} ${String(requests.length).padStart(3)} req  ${base.replace("https://", "")}${hostViolations ? `   ${hostViolations} violation(s)` : cover}`);
}

console.log(`\n${answered}/${total} answered, ${missing} missing, ${crashed} process errors`);
console.log(`modes: ${Object.entries(modes).map(([k, v]) => `${k} ${v}`).join(", ")}`);
console.log(`statuses: ${Object.entries(statuses).sort((a,b)=>b[1]-a[1]).map(([k, v]) => `${k}:${v}`).join(" ")}`);
// Reported every run rather than only on breach, because ADR-0032 removed the
// assertion that used to make budget regressions loud.
console.log(`worst envelope: ${worst} tokens (target ${BUDGET}) at ${worstAt}` +
  (worst > BUDGET ? `  <- ${Math.round((worst / BUDGET - 1) * 100)}% over target, not a failure` : ""));
const over = overTarget.length;
if (over) console.log(`${over}/${answered} envelopes over the ${BUDGET} token target (largest ${worst})`);
if (degraded.length) {
  console.log(`\n${degraded.length} DEGRADED HOST(S):`);
  for (const d of degraded) console.log(`  ${d.base.replace("https://", "").padEnd(34)} ${d.reason}`);
}
if (violations.length) {
  console.log(`\n${violations.length} VIOLATIONS:`);
  for (const v of violations.slice(0, 40)) console.log(`  ${v.base.replace("https://", "").padEnd(34)} ${v.req.padEnd(28)} ${v.why}`);
} else if (degraded.length) {
  console.log("\nno invariant violations — but coverage was degraded, see above");
} else {
  console.log("\nno invariant violations");
}
await fixture?.close();
return violations.length ? 1 : 0;
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) process.exit(await main());
