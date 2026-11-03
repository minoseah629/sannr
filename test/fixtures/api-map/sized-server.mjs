// A loopback API for the MAP-1A fix round 3 budget tests (after QA's
// q3-budgets specimen). It runs in its own process, listens on 127.0.0.1 only
// and prints "PORT <n>". GET /things lists one item. GET /things/<id> answers
// with a body whose stored shape the test sizes: `m` nodes of nine leaves
// under 120-character keys (each node adds about 1.4 KB to the shape), then
// `pad` characters spread over keys of up to 100 characters (each adds its
// length and a fixed overhead). Keys are letters only; every value is a
// marker that must never reach the store or a page.
import http from "node:http";

// Run it, never import it: importing starts a server in the importing process.
// The tests check these literals (repeated there) against every surface.
const M = Object.freeze({ item: "SIZEDMARK_ITEM_5e7a", leaf: "SIZEDMARK_LEAF_8c2d" });
const letters = i => { let s = ""; do { s = String.fromCharCode(97 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0); return s; };
const fill = (prefix, n) => (prefix + "x".repeat(n)).slice(0, n);
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://loopback.invalid");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  req.resume();
  req.on("end", () => {
    if (req.method === "GET" && url.pathname === "/things") return send(200, { data: [{ id: M.item }] });
    if (req.method === "GET" && /^\/things\/[^/]+$/.test(url.pathname)) {
      const m = Number(url.searchParams.get("m") ?? 0), pad = Number(url.searchParams.get("pad") ?? 0);
      const body = { id: M.item };
      for (let i = 0; i < m; i++) {
        const inner = {};
        for (let j = 0; j < 9; j++) inner[fill(`leaf${letters(j)}q`, 120)] = M.leaf;
        body[fill(`node${letters(i)}q`, 120)] = inner;
      }
      for (let left = pad, i = 0; left > 0; left -= 100, i++) body[fill(`pad${letters(i)}q`, Math.max(5, Math.min(100, left)))] = M.leaf;
      return send(200, body);
    }
    send(404, { error: "no route" });
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`PORT ${server.address().port}\n`); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
