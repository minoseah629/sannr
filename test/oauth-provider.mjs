#!/usr/bin/env node
// Throwaway OAuth provider + protected resource, for stress-testing the client's
// token handling. Deliberately hostile: tokens expire fast, the resource returns
// a real 401 the moment one does, and refresh tokens rotate on every use.
//
//   node test/oauth-provider.mjs [port] [ttlSeconds]

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.argv[2] ?? 9099);
const TTL = Number(process.argv[3] ?? 2);

const CLIENT_ID = "test-client";
const CLIENT_SECRET = "test-secret-do-not-log";
const tokens = new Map();          // access_token -> {exp, scope}
const refresh = new Map();         // refresh_token -> {scope}
refresh.set("seed-refresh-token", { scope: "read write" });

const counters = { issued: 0, refreshed: 0, rejected401: 0, resourceOk: 0, clientCredGrants: 0 };

const issue = (scope) => {
  const access = `at_${randomUUID()}`;
  const rt = `rt_${randomUUID()}`;
  tokens.set(access, { exp: Date.now() + TTL * 1000, scope });
  refresh.set(rt, { scope });
  counters.issued += 1;
  return { access_token: access, refresh_token: rt, token_type: "Bearer", expires_in: TTL, scope };
};

const body = (req) => new Promise((r) => {
  let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d));
});

const json = (res, code, obj) => {
  const s = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s) });
  res.end(s);
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/token" && req.method === "POST") {
    const form = new URLSearchParams(await body(req));
    const grant = form.get("grant_type");

    // Accept credentials via body or Basic auth, like real providers do.
    const basic = (req.headers.authorization ?? "").startsWith("Basic ")
      ? Buffer.from(req.headers.authorization.slice(6), "base64").toString().split(":")
      : [];
    const id = form.get("client_id") ?? basic[0];
    const secret = form.get("client_secret") ?? basic[1];
    if (id !== CLIENT_ID || secret !== CLIENT_SECRET)
      return json(res, 401, { error: "invalid_client", error_description: "bad client credentials" });

    if (grant === "client_credentials") {
      counters.clientCredGrants += 1;
      return json(res, 200, issue(form.get("scope") ?? "read"));
    }
    if (grant === "refresh_token") {
      const rt = form.get("refresh_token");
      const known = refresh.get(rt);
      if (!known) return json(res, 400, { error: "invalid_grant", error_description: "unknown or already-used refresh token" });
      refresh.delete(rt);                       // rotation: single use
      counters.refreshed += 1;
      return json(res, 200, issue(known.scope));
    }
    return json(res, 400, { error: "unsupported_grant_type", error_description: `grant_type '${grant}' not supported` });
  }

  if (url.pathname === "/counters") return json(res, 200, counters);

  // --- protected resource -------------------------------------------------
  const presented = (req.headers.authorization ?? "").replace(/^Bearer /i, "");
  const tok = tokens.get(presented);
  if (!tok || tok.exp < Date.now()) {
    counters.rejected401 += 1;
    res.setHeader("www-authenticate", `Bearer realm="test", error="invalid_token"`);
    return json(res, 401, { error: "invalid_token", error_description: !tok ? "unknown token" : "token expired" });
  }
  if (url.pathname === "/widgets") {
    counters.resourceOk += 1;
    return json(res, 200, {
      data: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `widget-${i + 1}`, tier: i % 2 ? "pro" : "free" })),
      total: 3,
    });
  }
  if (url.pathname === "/slow") {
    counters.resourceOk += 1;
    await new Promise((r) => setTimeout(r, Number(url.searchParams.get("ms") ?? 500)));
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not_found" });
}).listen(PORT, () => console.log(`oauth provider on http://127.0.0.1:${PORT} (ttl ${TTL}s)`));
