import { LAYOUT } from "../lib/layout.mjs";
// Per-host auth (F1). One client instance, many credential sets, routed by the
// host each request actually targets.
//
//   node --test test/multihost.test.mjs
//
// The property under test is the same one the cross-origin redirect suite
// guards, from the other direction: a credential configured for host A must
// reach host A and must NEVER reach host B — not on a direct request, not on a
// batch step, not on a redirect, and not because two identical-looking requests
// to different hosts were coalesced into one. Every assertion here is made
// against what a recording server actually RECEIVED, not against what the
// client claims it sent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// A vendor stand-in that records exactly what arrived — URL (query string
// included, because query-scheme credentials live there) and every header.
// What each host SAW is the entire subject of this file.
function vendor() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: { ...req.headers } });
    const u = new URL(req.url, "http://x");
    if (u.pathname === "/redirect") {
      res.writeHead(302, { location: u.searchParams.get("to") ?? "/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path: u.pathname }));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({
    seen,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  })));
}

// Drive the real MCP adapter, so what is asserted is what an agent receives.
// Accepts several argument sets and sends them in ONE stdin write, which is
// also how the coalescing case gets two calls genuinely in flight together.
function call(env, ...argsList) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["server.mjs"], {
      cwd: ROOT,
      env: { ...process.env, API_USAGE_LOG: "/dev/null", API_CONTEXT_OFF: "1",
             API_EVIDENCE: mkdtempSync(join(tmpdir(), "mh-ev-")), ...env },
      stdio: ["pipe", "pipe", "ignore"],
    });
    let buf = "", done = false;
    const results = new Map();
    const finish = (fn, v) => { if (done) return; done = true; child.kill(); fn(v); };
    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) {
        try {
          const m = JSON.parse(l);
          if (m.id >= 100) results.set(m.id, JSON.parse(m.result.content[0].text));
        } catch { /* not our line */ }
        if (results.size === argsList.length)
          finish(resolve, argsList.map((_, i) => results.get(100 + i)));
      }
    });
    child.stdin.write(`${[
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      ...argsList.map((args, i) => ({ jsonrpc: "2.0", id: 100 + i, method: "tools/call",
        params: { name: "api_request", arguments: args } })),
    ].map((m) => JSON.stringify(m)).join("\n")}\n`);
    setTimeout(() => finish(reject, new Error("timed out")), 20_000);
  });
}

// One config file per suite run: three named upstreams, three different auth
// schemes, all referencing env-var NAMES. The base URL is a fourth, credential-
// less host, so back-compat (plain path → API_AUTH → base) is observable apart
// from the routed hosts.
const SECRETS = {
  ALPHA_TOKEN: "alpha-secret-bearer-value",
  BETA_KEY: "beta-secret-header-value",
  GAMMA_KEY: "gamma-secret-query-value",
  BASE_TOKEN: "base-secret-bearer-value",
  V1_TOKEN: "v-one-secret-bearer-value",
  V2_KEY: "v-two-secret-header-value",
};

async function rig() {
  const [base, alpha, beta, gamma] = await Promise.all([vendor(), vendor(), vendor(), vendor()]);
  const dir = mkdtempSync(join(tmpdir(), "mh-cfg-"));
  const file = join(dir, LAYOUT.environments);
  writeFileSync(file, JSON.stringify({
    v: 1,
    hosts: {
      alpha: { baseUrl: alpha.origin, auth: "bearer:ALPHA_TOKEN" },
      beta:  { baseUrl: `${beta.origin}/`, auth: "header:X-API-Key:BETA_KEY" },
      gamma: { baseUrl: gamma.origin, auth: "query:api_key:GAMMA_KEY" },
    },
  }));
  const env = { API_CONFIG: file, API_BASE_URL: base.origin, ...SECRETS };
  const close = () => Promise.all([base, alpha, beta, gamma].map((v) => v.close()));
  return { base, alpha, beta, gamma, env, close };
}

// A host's record must carry its OWN credential and no fragment of anyone
// else's. Checked against the serialized whole — headers and URL — so a
// credential smuggled anywhere (query, custom header, cookie) is caught.
function assertOnlyOwnSecret(seenEntry, ownValues, label) {
  const blob = JSON.stringify(seenEntry);
  for (const [name, value] of Object.entries(SECRETS)) {
    if (ownValues.includes(value)) continue;
    assert.ok(!blob.includes(value), `${label} received ${name}, another host's credential`);
  }
  for (const value of ownValues)
    assert.ok(blob.includes(value), `${label} did not receive its own credential`);
}

test("a batch spanning three authenticated hosts sends each its own credential", async () => {
  const r = await rig();
  try {
    const [e] = await call(r.env, { path: "/x", requests: [
      { method: "GET", path: "/a", upstream: "alpha" },
      { method: "GET", path: "/b", upstream: "beta" },
      { method: "GET", path: "/c", upstream: "gamma" },
    ] });
    assert.equal(e.ok, true, `batch failed: ${JSON.stringify(e).slice(0, 400)}`);
    assert.equal(r.alpha.seen.length, 1, "alpha must receive exactly its own request");
    assert.equal(r.beta.seen.length, 1, "beta must receive exactly its own request");
    assert.equal(r.gamma.seen.length, 1, "gamma must receive exactly its own request");
    assert.equal(r.base.seen.length, 0, "nothing in this batch targets the base URL");

    assert.equal(r.alpha.seen[0].headers.authorization, `Bearer ${SECRETS.ALPHA_TOKEN}`);
    assertOnlyOwnSecret(r.alpha.seen[0], [SECRETS.ALPHA_TOKEN], "alpha");

    assert.equal(r.beta.seen[0].headers["x-api-key"], SECRETS.BETA_KEY);
    assert.equal(r.beta.seen[0].headers.authorization, undefined,
      "a bearer token configured for alpha must never reach beta");
    assertOnlyOwnSecret(r.beta.seen[0], [SECRETS.BETA_KEY], "beta");

    assert.match(r.gamma.seen[0].url, /api_key=gamma-secret-query-value/);
    assert.equal(r.gamma.seen[0].headers.authorization, undefined);
    assert.equal(r.gamma.seen[0].headers["x-api-key"], undefined);
    assertOnlyOwnSecret(r.gamma.seen[0], [SECRETS.GAMMA_KEY], "gamma");

    // And no credential VALUE may surface in what the agent is shown.
    const out = JSON.stringify(e);
    for (const [name, value] of Object.entries(SECRETS))
      assert.ok(!out.includes(value), `${name} leaked into the returned envelope`);
  } finally { await r.close(); }
});

test("single-credential config keeps working unchanged next to a hosts map", async () => {
  const r = await rig();
  try {
    const [e] = await call({ ...r.env, API_AUTH: "bearer:BASE_TOKEN" }, { path: "/plain" });
    assert.equal(e.status, 200);
    assert.equal(r.base.seen.length, 1);
    assert.equal(r.base.seen[0].headers.authorization, `Bearer ${SECRETS.BASE_TOKEN}`,
      "a plain path must still resolve API_AUTH against the base URL");
    assertOnlyOwnSecret(r.base.seen[0], [SECRETS.BASE_TOKEN], "base");
    assert.equal(r.alpha.seen.length + r.beta.seen.length + r.gamma.seen.length, 0);
  } finally { await r.close(); }
});

test("an unknown upstream is a named refusal, not a silent fallback to the base URL", async () => {
  const r = await rig();
  try {
    const [e] = await call(r.env, { path: "/a", upstream: "delta" });
    assert.equal(e.ok, false);
    assert.equal(e.error?.code, "UPSTREAM_NOT_FOUND");
    assert.deepEqual(e.error?.details?.available, ["alpha", "beta", "gamma"]);
    assert.equal(r.base.seen.length, 0,
      "a typo'd upstream silently hitting the base URL is the failure this refusal exists to prevent");
  } finally { await r.close(); }
});

test("a full-URL path resolves the credential for ITS host", async () => {
  const r = await rig();
  try {
    const [e] = await call(r.env, { path: `${r.beta.origin}/direct` });
    assert.equal(e.status, 200);
    assert.equal(r.beta.seen.length, 1);
    assert.equal(r.beta.seen[0].headers["x-api-key"], SECRETS.BETA_KEY);
    assertOnlyOwnSecret(r.beta.seen[0], [SECRETS.BETA_KEY], "beta");
  } finally { await r.close(); }
});

test("a full-URL path to an UNCONFIGURED origin is refused, and nothing is sent", async () => {
  const r = await rig();
  const stranger = await vendor();
  try {
    const [e] = await call(r.env, { path: `${stranger.origin}/collect` });
    assert.equal(e.ok, false);
    assert.equal(e.error?.code, "ORIGIN_NOT_CONFIGURED");
    assert.equal(stranger.seen.length, 0, "an unconfigured origin must not even be contacted");
  } finally { await r.close(); await stranger.close(); }
});

test("a redirect from host A to host B hands B neither A's credential nor B's", async () => {
  // Credentials resolve when the REQUEST is made, by its host. A redirect is
  // the server's choice, not the caller's, so the hop gets no credential at
  // all — the same allowlist rule the cross-origin redirect suite pins down,
  // now checked between two hosts that BOTH have credentials configured.
  const r = await rig();
  try {
    const [e] = await call(r.env,
      { path: "/redirect", upstream: "alpha", params: { to: `${r.beta.origin}/landed` } });
    assert.equal(e.status, 200);
    assert.equal(r.alpha.seen.length, 1);
    assert.equal(r.alpha.seen[0].headers.authorization, `Bearer ${SECRETS.ALPHA_TOKEN}`);
    assert.equal(r.beta.seen.length, 1, "the cross-origin hop should have been followed");
    assert.equal(r.beta.seen[0].headers.authorization, undefined,
      "alpha's bearer token must not travel to beta on a redirect");
    assert.equal(r.beta.seen[0].headers["x-api-key"], undefined,
      "beta's own credential must not be auto-armed on a hop the caller never addressed to beta");
  } finally { await r.close(); }
});

test("identical paths to different upstreams are never coalesced into one request", async () => {
  // The in-flight dedup fingerprint predates multi-host: two GETs to /same on
  // different hosts looked identical, so one host got both answers and the
  // other was never called — with the wrong host's data returned as its own.
  const r = await rig();
  try {
    await call(r.env,
      { path: "/same", upstream: "alpha" },
      { path: "/same", upstream: "beta" });
    assert.equal(r.alpha.seen.length, 1, "alpha must be called");
    assert.equal(r.beta.seen.length, 1, "beta must be called, not fed alpha's response");
  } finally { await r.close(); }
});

test("a pasted curl for a configured upstream routes there with that host's credential", async () => {
  const r = await rig();
  try {
    const [e] = await call(r.env, { curl: `curl ${r.beta.origin}/from-curl` });
    assert.equal(e.status, 200, `expected the curl to route to beta: ${JSON.stringify(e.error ?? {})}`);
    assert.equal(r.beta.seen.length, 1);
    assert.equal(r.beta.seen[0].headers["x-api-key"], SECRETS.BETA_KEY);
    assertOnlyOwnSecret(r.beta.seen[0], [SECRETS.BETA_KEY], "beta");
  } finally { await r.close(); }
});

test("a curl for an origin that is configured NOWHERE is still refused", async () => {
  const r = await rig();
  const stranger = await vendor();
  try {
    const [e] = await call(r.env, { curl: `curl ${stranger.origin}/collect` });
    assert.equal(e.ok, false);
    assert.equal(e.error?.code, "CURL_ORIGIN_MISMATCH");
    assert.equal(stranger.seen.length, 0);
  } finally { await r.close(); await stranger.close(); }
});

// --- same-origin siblings (F1 follow-up) -----------------------------------
// One ORIGIN, two configured hosts differing only by base path — an API gateway
// with /v1 and /v2 behind different keys is the ordinary shape of this. Routing
// keyed on origin alone let the LAST sibling win the whole origin, so v1
// requests carried v2's credential: wrong-credential-to-the-right-host, the
// bug's quieter cousin.

async function siblingRig() {
  const [shared, other] = await Promise.all([vendor(), vendor()]);
  const dir = mkdtempSync(join(tmpdir(), "mh-sib-"));
  const file = join(dir, LAYOUT.environments);
  writeFileSync(file, JSON.stringify({
    v: 1,
    hosts: {
      v1: { baseUrl: `${shared.origin}/v1`, auth: "bearer:V1_TOKEN" },
      v2: { baseUrl: `${shared.origin}/v2`, auth: "header:X-API-Key:V2_KEY" },
      alpha: { baseUrl: other.origin, auth: "bearer:ALPHA_TOKEN" },
    },
  }));
  const env = { API_CONFIG: file, ...SECRETS };
  const close = () => Promise.all([shared, other].map((v) => v.close()));
  return { shared, other, env, close };
}

test("same-origin sibling hosts each receive their OWN credential", async () => {
  const r = await siblingRig();
  try {
    const [e] = await call(r.env, { path: "/x", requests: [
      { method: "GET", path: "/a", upstream: "v1" },
      { method: "GET", path: "/b", upstream: "v2" },
    ] });
    assert.equal(e.ok, true, `batch failed: ${JSON.stringify(e).slice(0, 400)}`);
    assert.equal(r.shared.seen.length, 2);
    const v1 = r.shared.seen.find((s) => s.url.startsWith("/v1/"));
    const v2 = r.shared.seen.find((s) => s.url.startsWith("/v2/"));
    assert.ok(v1 && v2, `expected /v1/a and /v2/b, saw ${r.shared.seen.map((s) => s.url).join(", ")}`);
    assert.equal(v1.headers.authorization, `Bearer ${SECRETS.V1_TOKEN}`,
      "the /v1 sibling must carry v1's credential, not its sibling's");
    assert.equal(v1.headers["x-api-key"], undefined, "v2's key must not reach a /v1 request");
    assertOnlyOwnSecret(v1, [SECRETS.V1_TOKEN], "v1");
    assert.equal(v2.headers["x-api-key"], SECRETS.V2_KEY,
      "the /v2 sibling must carry v2's credential, not its sibling's");
    assert.equal(v2.headers.authorization, undefined, "v1's bearer must not reach a /v2 request");
    assertOnlyOwnSecret(v2, [SECRETS.V2_KEY], "v2");
    // The cross-origin property is untouched: the sibling fix must not have
    // widened anything beyond the one origin the siblings share.
    assert.equal(r.other.seen.length, 0);
  } finally { await r.close(); }
});

test("two hosts colliding on origin AND base path are a reported config error, not a silent pick", async () => {
  const shared = await vendor();
  const dir = mkdtempSync(join(tmpdir(), "mh-dup-"));
  const file = join(dir, LAYOUT.environments);
  writeFileSync(file, JSON.stringify({
    v: 1,
    hosts: {
      p1: { baseUrl: `${shared.origin}/v1`, auth: "bearer:V1_TOKEN" },
      p2: { baseUrl: `${shared.origin}/v1/`, auth: "header:X-API-Key:V2_KEY" },
    },
  }));
  try {
    const [e] = await call({ API_CONFIG: file, ...SECRETS }, { path: "/a", upstream: "p1" });
    assert.equal(e.ok, false);
    assert.equal(e.error?.code, "HOST_CONFIG_AMBIGUOUS",
      `expected the ambiguity to be reported, got: ${JSON.stringify(e.error ?? e).slice(0, 300)}`);
    assert.equal(shared.seen.length, 0, "an ambiguous credential choice must send NOTHING");
  } finally { await shared.close(); }
});

test("a pasted curl already carrying the upstream's base path is not double-prefixed", async () => {
  const r = await siblingRig();
  try {
    const [e] = await call(r.env, { curl: `curl ${r.shared.origin}/v1/things` });
    assert.equal(e.status, 200, `expected the curl to route: ${JSON.stringify(e.error ?? {})}`);
    assert.equal(r.shared.seen.length, 1);
    assert.equal(r.shared.seen[0].url, "/v1/things",
      `the configured baseUrl's path must not be prefixed again: saw ${r.shared.seen[0].url}`);
    assert.equal(r.shared.seen[0].headers.authorization, `Bearer ${SECRETS.V1_TOKEN}`);
    assertOnlyOwnSecret(r.shared.seen[0], [SECRETS.V1_TOKEN], "v1");
  } finally { await r.close(); }
});

test("a pasted curl against a path-bearing API_BASE_URL keeps a single prefix and the base credential", async () => {
  const base = await vendor();
  try {
    const [e] = await call(
      { API_BASE_URL: `${base.origin}/api`, API_AUTH: "bearer:BASE_TOKEN", ...SECRETS },
      { curl: `curl ${base.origin}/api/things?limit=2` });
    assert.equal(e.status, 200, `expected the curl to reach the base: ${JSON.stringify(e.error ?? {})}`);
    assert.equal(base.seen.length, 1);
    const seen = new URL(base.seen[0].url, "http://x");
    assert.equal(seen.pathname, "/api/things",
      `the base URL's path must not be prefixed again: saw ${base.seen[0].url}`);
    assert.equal(seen.searchParams.get("limit"), "2", "the query string must survive the paste");
    assert.equal(base.seen[0].headers.authorization, `Bearer ${SECRETS.BASE_TOKEN}`);
  } finally { await base.close(); }
});
