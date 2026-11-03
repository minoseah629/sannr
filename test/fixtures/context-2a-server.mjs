// A separate process keeps synchronous CLI work from starving fixture I/O.
import { createServer } from 'node:http';
const server = createServer(async (request, response) => {
  let text = ''; for await (const chunk of request) text += chunk;
  let body; try { body = JSON.parse(text); } catch { /* Plain HTTP fixture. */ }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body?.jsonrpc === '2.0'
    ? { jsonrpc: '2.0', id: body.id, result: { ready: true } } : { ready: true }));
});
server.listen(0, '127.0.0.1', () => process.send({ origin: `http://127.0.0.1:${server.address().port}` }));
process.on('message', message => { if (message?.command === 'stop') server.close(() => process.exit(0)); });
