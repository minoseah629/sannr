import { createServer } from 'node:http';
const servers = [];
const origins = {};
for (const name of ['alpha', 'beta', 'gamma']) {
  const server = createServer((req, res) => {
    process.send?.({ request: { stack: name, method: req.method, path: req.url,
      authorization: req.headers.authorization, marker: req.headers['x-fixture-stack'] } });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/items' }); res.end(); return; }
    if (req.url === '/throttle') { res.writeHead(429, { 'retry-after': '0' }); res.end('{}'); return; }
    res.writeHead(req.headers.authorization === `Bearer local-${name}-fixture-token` ? 200 : 401,
      { 'content-type': 'application/json' });
    res.end(JSON.stringify({ items: [{ id: 'local-item', name }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origins[name] = `http://127.0.0.1:${server.address().port}`;
  servers.push(server);
}
process.send?.({ origins });
process.on('message', async message => {
  if (message === 'close') {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    process.exit(0);
  }
});
