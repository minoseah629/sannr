// A local origin for the differential truth suite.
//
// This exists because of a real failure: the suite pointed at httpbin.org, the
// service returned 503 for every case, and the suite reported "304 claims
// checked, no divergence." It was telling the truth — the client accurately
// reported nineteen 503s — and it proved nothing at all, because no JSON was
// parsed, no gear was selected, and no assertion ran against a real body.
//
// A test that quietly becomes vacuous when a third party has a bad afternoon is
// the same defect this project exists to catch, wearing a lab coat. So the
// origin is local, deterministic, and always available.
//
// The endpoints are httpbin-shaped on purpose: the cases were written against
// that vocabulary, and keeping it means the suite can still be pointed at the
// real thing (TRUTH_BASE=https://httpbin.org) to check that the fixture has not
// drifted into a convenient fiction.

import { createServer } from "node:http";
import { gzipSync, deflateSync, brotliCompressSync } from "node:zlib";
import { randomBytes, randomUUID } from "node:crypto";

// A 1x1 PNG. Real bytes, so the binary-hash claim is checked against something
// that is genuinely not text.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64");

const json = (res, status, body, headers = {}) => {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length, ...headers });
  res.end(buf);
};

// Echo of the incoming request, in httpbin's shape.
async function echo(req, url) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  const type = req.headers["content-type"] ?? "";
  const out = {
    method: req.method,
    url: url.href,
    args: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
    data: raw,
    form: {},
    json: null,
  };
  if (type.includes("application/x-www-form-urlencoded"))
    out.form = Object.fromEntries(new URLSearchParams(raw));
  else if (raw) { try { out.json = JSON.parse(raw); } catch { /* left null, as httpbin does */ } }
  return out;
}

// --- pagination surface (F4) ------------------------------------------------
// Twelve rows in three pages of four, served in each style the client claims to
// detect. Deterministic on purpose: the follow logic is under test, not the data.
const PAGE_TOTAL = 12, PAGE_SIZE = 4;
const pageRows = (start, n = PAGE_SIZE) =>
  Array.from({ length: Math.max(0, Math.min(n, PAGE_TOTAL - start)) }, (_, i) => ({
    id: start + i, name: `item-${start + i}`, tier: (start + i) % 2 ? "basic" : "pro" }));

const handlers = {
  "/json": (req, res) => json(res, 200,
    { slideshow: { author: "Yours Truly", date: "date of publication", title: "Sample Slide Show",
      slides: [{ title: "Wake up to WonderWidgets!", type: "all" },
               { title: "Overview", type: "all", items: ["Why WonderWidgets are great", "Who buys WonderWidgets"] }] } }),

  "/html": (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!DOCTYPE html><html><body><h1>Herman Melville - Moby-Dick</h1><p>Call me Ishmael.</p></body></html>");
  },

  "/xml": (req, res) => {
    res.writeHead(200, { "content-type": "application/xml" });
    res.end(`<?xml version='1.0' encoding='us-ascii'?><slideshow title="Sample"><slide><title>WonderWidgets</title></slide></slideshow>`);
  },

  "/gzip": (req, res) => {
    const buf = gzipSync(Buffer.from(JSON.stringify({ gzipped: true, method: req.method })));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": buf.length });
    res.end(buf);
  },

  "/image/png": (req, res) => {
    res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
    res.end(PNG);
  },

  // --- the rest of the edge-case surface the stress suite exercises ---------

  "/deflate": (req, res) => {
    const buf = deflateSync(Buffer.from(JSON.stringify({ deflated: true })));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "deflate", "content-length": buf.length });
    res.end(buf);
  },

  "/brotli": (req, res) => {
    const buf = brotliCompressSync(Buffer.from(JSON.stringify({ brotli: true })));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "br", "content-length": buf.length });
    res.end(buf);
  },

  "/uuid": (req, res) => json(res, 200, { uuid: randomUUID() }),

  "/robots.txt": (req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("User-agent: *\nDisallow: /deny\n");
  },

  "/encoding/utf8": (req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<h1>Unicode Demonstration</h1><p>日本語 · Ελληνικά · emoji 🚚</p>");
  },

  "/cache": (req, res) => {
    // Conditional request support: a client that sends the validator must get 304.
    if (req.headers["if-none-match"] || req.headers["if-modified-since"]) { res.writeHead(304); return res.end(); }
    return json(res, 200, { cached: false }, { etag: '"cache-probe"', "last-modified": "Wed, 21 Oct 2026 07:28:00 GMT" });
  },

  // A JPEG needs only a valid header for the binary path; the bytes are hashed,
  // not decoded.
  "/image/jpeg": (req, res) => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(0), Buffer.from([0xff, 0xd9])]);
    res.writeHead(200, { "content-type": "image/jpeg", "content-length": jpeg.length });
    res.end(jpeg);
  },

  // Cookies must survive the redirect that sets them — a login flow is
  // POST → 302 + Set-Cookie, and only remembering the final response loses it.
  "/cookies/set": (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const cookies = [...url.searchParams].map(([k, v]) => `${k}=${v}; Path=/`);
    res.writeHead(302, { location: "/cookies", "set-cookie": cookies.length ? cookies : ["probe=1; Path=/"] });
    res.end();
  },

  "/cookies": (req, res) => json(res, 200, {
    cookies: Object.fromEntries((req.headers.cookie ?? "").split(";").map((c) => c.trim().split("="))
      .filter(([k]) => k)),
  }),
};

export function start() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;

    if (p === "/health") return json(res, 200, { ok: true });
    if (handlers[p]) return handlers[p](req, res);

    // --- pagination styles (F4) -------------------------------------------
    // cursor: { data, next_cursor }, the catalog-service shape.
    if (p === "/paginate/cursor") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      return json(res, 200, { data: pageRows(start),
        next_cursor: start + PAGE_SIZE < PAGE_TOTAL ? String(start + PAGE_SIZE) : null });
    }
    // page: { data, page, per_page, total }, the identity-service shape.
    if (p === "/paginate/page") {
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      return json(res, 200, { data: pageRows((page - 1) * PAGE_SIZE),
        page, per_page: PAGE_SIZE, total: PAGE_TOTAL });
    }
    // offset: { data, offset, limit, total }, the orders-service shape.
    if (p === "/paginate/offset") {
      const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
      return json(res, 200, { data: pageRows(offset), offset, limit: PAGE_SIZE, total: PAGE_TOTAL });
    }
    // Link header rel=next over a bare array: only the header knows there is more.
    if (p === "/paginate/link") {
      const from = Number(url.searchParams.get("from") ?? 0);
      const extra = from + PAGE_SIZE < PAGE_TOTAL
        ? { link: `</paginate/link?from=${from + PAGE_SIZE}>; rel="next"` } : {};
      return json(res, 200, pageRows(from), extra);
    }
    // A next-cursor that never advances. The client must notice and stop.
    if (p === "/paginate/loop")
      return json(res, 200, { data: pageRows(0, 2), next_cursor: "same-again" });
    // Fat rows that outgrow any sane budget long before the cursor runs out.
    if (p === "/paginate/big") {
      const n = Number(url.searchParams.get("cursor") ?? 0);
      return json(res, 200, { data: Array.from({ length: 5 }, (_, i) => ({ id: n * 5 + i, note: "x".repeat(220) })),
        next_cursor: n < 50 ? String(n + 1) : null });
    }
    // rel=next naming ANOTHER origin. Followed, it could carry the credential
    // to a host the server chose; the client must refuse, not fetch.
    if (p === "/paginate/link-cross")
      return json(res, 200, pageRows(0), { link: `<http://127.0.0.1:9/steal>; rel="next"` });

    // /status/{code} — including 204, which must carry no body.
    const status = p.match(/^\/status\/(\d{3})$/);
    if (status) {
      const code = Number(status[1]);
      if (code === 204) { res.writeHead(204); return res.end(); }
      res.writeHead(code, { "content-type": "text/plain" });
      return res.end(code >= 400 ? `error ${code}` : "ok");
    }

    // /stream/{n} — a collection big enough to exercise the summary gear.
    const stream = p.match(/^\/stream\/(\d+)$/);
    if (stream) {
      const n = Math.min(Number(stream[1]), 200);
      return json(res, 200, Array.from({ length: n }, (_, i) => ({
        id: i, url: `http://localhost/stream/${n}`, status: i % 3 === 0 ? "active" : "idle",
        note: `row ${i} with enough text on it that the body is worth summarising rather than passing through whole`,
      })));
    }

    // /redirect/{n}
    const redirect = p.match(/^\/redirect\/(\d+)$/);
    if (redirect) {
      const n = Number(redirect[1]);
      res.writeHead(302, { location: n > 1 ? `/redirect/${n - 1}` : "/json" });
      return res.end();
    }

    // /response-headers?Key=Value — echoes query params back AS headers, which
    // is what the header-assertion cases assert against.
    if (p === "/response-headers") {
      const extra = {};
      for (const [k, v] of url.searchParams) extra[k] = v;
      return json(res, 200, { ...Object.fromEntries(url.searchParams) }, extra);
    }

    if (p === "/headers") {
      return json(res, 200, { headers: Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, String(v)])) });
    }

    // A redirect that never terminates. The client must stop and say so rather
    // than spin.
    if (p === "/loop") { res.writeHead(302, { location: "/loop" }); return res.end(); }

    // Redirect to an arbitrary URL, so the cross-origin credential boundary can
    // be tested with a second fixture standing in for a hostile upstream.
    if (p === "/redirect-to") {
      res.writeHead(302, { location: url.searchParams.get("url") ?? "/json" });
      return res.end();
    }

    // /bytes/{n} and /stream-bytes/{n} — binary of a known length.
    const bytes = p.match(/^\/(?:stream-)?bytes\/(\d+)$/);
    if (bytes) {
      const buf = randomBytes(Math.min(Number(bytes[1]), 100_000));
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": buf.length });
      return res.end(buf);
    }

    // /etag/{tag} — 304 when the client already holds it.
    const etag = p.match(/^\/etag\/(.+)$/);
    if (etag) {
      const tag = `"${etag[1]}"`;
      if (req.headers["if-none-match"] === tag) { res.writeHead(304, { etag: tag }); return res.end(); }
      return json(res, 200, { etag: etag[1] }, { etag: tag });
    }

    const absolute = p.match(/^\/absolute-redirect\/(\d+)$/);
    if (absolute) {
      const n = Number(absolute[1]);
      res.writeHead(302, { location: n > 1 ? `${url.origin || `http://127.0.0.1:${server.address().port}`}/absolute-redirect/${n - 1}`
                                           : `http://127.0.0.1:${server.address().port}/json` });
      return res.end();
    }

    const relative = p.match(/^\/relative-redirect\/(\d+)$/);
    if (relative) {
      const n = Number(relative[1]);
      res.writeHead(302, { location: n > 1 ? `/relative-redirect/${n - 1}` : "/json" });
      return res.end();
    }

    // /delay/{n} — capped hard, because a fixture that can hang is a fixture
    // that can make a suite look like a client bug.
    const delay = p.match(/^\/delay\/(\d+)$/);
    if (delay) {
      await new Promise((r) => setTimeout(r, Math.min(Number(delay[1]), 3) * 1000));
      return json(res, 200, await echo(req, url));
    }

    // 401 paths, so the auth-degradation behaviour is exercised for real.
    if (/^\/basic-auth\//.test(p)) {
      if (!req.headers.authorization?.startsWith("Basic "))
        return json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Basic realm=probe" });
      return json(res, 200, { authenticated: true });
    }
    if (p === "/bearer") {
      if (!req.headers.authorization?.startsWith("Bearer "))
        return json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
      return json(res, 200, { authenticated: true, token: "redacted" });
    }

    if (p === "/anything" || p === "/get" || ["POST", "PUT", "PATCH", "DELETE"].includes(req.method))
      return json(res, 200, await echo(req, url));

    return json(res, 404, { error: "not found", path: p });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
