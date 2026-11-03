// A loopback API that answers every path, for the MAP-1A fix round 2 capture
// tests (base-URL mounts, query names and encoded paths). Adapted from QA's
// round-2 specimen. It runs in its own process (the tests drive the client
// with spawnSync, which blocks theirs), listens on 127.0.0.1 only and prints
// "PORT <n>". GET answers 200 with a list body; a path containing "/missing"
// answers 404. Every body carries markers that must never reach the store or a
// page, and the echo repeats the query string so a leaked query value would
// show up beside a marker.
import http from "node:http";

// Run it, never import it: importing starts a server in the importing process.
// The tests check these literals (repeated there) against every surface.
const M = Object.freeze({ body: "ANYMARK_BODY_2e8c", item: "ANYMARK_ITEM_6d1f" });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://loopback.invalid");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  req.resume();
  req.on("end", () => {
    if (url.pathname.includes("/missing")) return send(404, { error: M.body });
    if (req.method === "POST") return send(201, { id: M.item, note: M.body });
    send(200, { data: [{ id: M.item, name: M.body }], echo: `${url.search}${M.body}` });
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`PORT ${server.address().port}\n`); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
