// A loopback API for the MAP-1A fix round 3 audit-finding test (after QA's
// q3-footprint-value specimen). It runs in its own process, listens on
// 127.0.0.1 only and prints "PORT <n>". Each collection lists one id, and its
// documented item route fails for that id: /hubs/<id> answers 404 and
// /rooms/<id> answers 500. /days lists its rows under a key that is itself a
// date, a key that carries data. The ids, the date key and the error bodies are
// markers that must never appear in a finding, a page or a committed file.
import http from "node:http";

// Run it, never import it: importing starts a server in the importing process.
// The tests check these literals (repeated there) against every surface.
const M = Object.freeze({ hub: "LISTEDMARK_HUB_3a9f", room: "LISTEDMARK_ROOM_6b1d", day: "LISTEDMARK_DAY_0c4e",
  dateKey: "1999-12-31", body: "LISTEDMARK_BODY_7e2a" });
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://loopback.invalid");
  const send = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  req.resume();
  req.on("end", () => {
    if (req.method !== "GET") return send(405, { error: M.body });
    if (url.pathname === "/hubs") return send(200, { data: [{ id: M.hub, name: M.body }] });
    if (url.pathname === "/rooms") return send(200, { items: [{ id: M.room }] });
    if (url.pathname === "/days") return send(200, { [M.dateKey]: [{ id: M.day }] });
    if (/^\/(hubs|days)\/[^/]+$/.test(url.pathname)) return send(404, { error: M.body });
    if (/^\/rooms\/[^/]+$/.test(url.pathname)) return send(500, { error: M.body });
    send(404, { error: "no route" });
  });
});
server.listen(0, "127.0.0.1", () => { process.stdout.write(`PORT ${server.address().port}\n`); });
process.on("SIGTERM", () => server.close(() => process.exit(0)));
