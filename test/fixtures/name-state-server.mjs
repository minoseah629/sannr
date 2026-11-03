// Controlled NAME-1 state fixture. This runs in its own process; no external
// endpoints or credential values are returned in any fixture report.
import { createServer } from 'node:http';
let requests = 0, grants = 0, cachedAuth = 0;
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url === '/token') {
    grants += 1;
    res.end(JSON.stringify({ access_token: 'synthetic-granted-access', expires_in: 3600 }));
  } else {
    requests += 1;
    if (req.headers.authorization === 'Bearer synthetic-cached-access') cachedAuth += 1;
    res.end(JSON.stringify({ healthy: true }));
  }
});
server.listen(0, '127.0.0.1', () => process.send({ origin: `http://127.0.0.1:${server.address().port}` }));
process.on('message', message => {
  if (message === 'counts') process.send({ requests, grants, cachedAuth });
  if (message === 'stop') server.close(() => process.exit(0));
});
