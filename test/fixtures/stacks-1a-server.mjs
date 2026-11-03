// STACKS-1A's wire witness is a separate process so synchronous CLI work can
// never starve the server. Only synthetic request metadata crosses IPC.
import { createServer } from 'node:http';

const label = process.argv[2];
const requests = [];
const server = createServer((req, res) => {
  requests.push({ method: req.method, path: req.url,
    authorization: req.headers.authorization ?? null,
    fixtureHeader: req.headers['x-fixture-stack'] ?? null });
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ [label === 'alpha' ? 'alphaField' : 'betaField']: 'synthetic-private-response', ready: true }));
});
server.listen(0, '127.0.0.1', () => process.send({ origin: `http://127.0.0.1:${server.address().port}` }));
process.on('message', message => {
  if (message?.command === 'snapshot') process.send({ id: message.id, requests: [...requests] });
  if (message?.command === 'stop') server.close(() => process.exit(0));
});
