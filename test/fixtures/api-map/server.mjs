// A loopback API for the MAP-1A capture tests. It runs in its own process
// (the tests drive the client with spawnSync, which blocks theirs), listens on
// 127.0.0.1 only and prints "PORT <n>". Every body carries a marker that must
// never reach a page or the store. A leading /api mount is accepted and
// ignored, so one server answers a base URL with or without a path prefix.
import http from "node:http";

// Run it, never import it: importing starts a server in the importing process.
// The tests check these literals (repeated there) against every surface.
const M = Object.freeze({ body: "SRVMARK_BODY_4c1e", item: "SRVMARK_ITEM_7b2d", echo: "SRVMARK_ECHO_9f3a" });
const seen = new Map();
const nth = key => { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return n; };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://loopback.invalid");
  const path = url.pathname.replace(/^\/api(?=\/)/, "");
  const send = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  req.resume();
  req.on("end", () => {
    if (req.method === "GET" && path === "/v1/items") return send(200, { data: [{ id: M.item, name: M.body }], echo: `${url.search}${M.echo}` });
    if (req.method === "GET" && /^\/v1\/items\/[^/]+$/.test(path))
      return path.endsWith("/missing") ? send(404, { error: M.body }) : send(200, { id: M.item, name: M.body });
    if (req.method === "GET" && path === "/v1/inline") return send(200, { ok: M.body, echo: `${url.search}${M.echo}` });
    if (req.method === "GET" && path === "/v1/flaky") return nth("flaky") === 1 ? send(500, { error: M.body }) : send(200, { ok: M.body });
    if (req.method === "GET" && path === "/v1/health") return send(200, { ok: true });
    send(404, { error: "no route" });
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`PORT ${server.address().port}\n`); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
