import { createServer } from 'node:http';
const sid = 'AC' + 'a'.repeat(32);
const seen = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk;
  seen.push({ method: req.method, path: req.url, body });
  if (req.url === '/trace') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(seen)); return; }
  if (req.url.includes('/disconnect')) { req.socket.destroy(); return; }
  const value = req.url.startsWith('/short/') || req.url.startsWith('/rpcshape/') ? decodeURIComponent(req.url.split('/')[2]) : sid;
  if (req.url.startsWith('/rpcshape/')) {
    const input = JSON.parse(body); res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: input.id, result: { [value]: 'sample', text: 'x'.repeat(50000), list: ['sample'] } })); return;
  }
  const status = req.method === 'DELETE' ? (req.url.includes('refused') ? 401 : 200)
    : req.method === 'POST' ? (req.url.includes('error') ? 500 : 201) : 200;
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ [value]: 'sample', id: value, numericId: 19, flag: true, state: 'ready', ids: [sid], nested: { id: sid }, mirror: req.url }));
});
server.listen(0, '127.0.0.1', () => process.send({ origin: `http://127.0.0.1:${server.address().port}` }));
process.on('disconnect', () => server.close(() => process.exit()));
