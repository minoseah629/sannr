// Deterministic, loopback-only response specimens. Shared by stdio and HTTP.
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { prng } from './variations.mjs';
import { pathToFileURL } from 'node:url';

export const MCP_CLASSES = ['unchanged', 'malformed-json', 'wrong-id', 'duplicate-id', 'oversized-frame', 'trickle', 'ten-thousand-tools', 'list-spread', 'deep-schema', 'non-utf8', 'control-characters', 'exit-mid-frame', 'rpc-error', 'slow-pages'];
export const MCP_HTTP_CLASSES = [...MCP_CLASSES.filter(x => x !== 'exit-mid-frame'), 'sse-open', 'sse-never', 'session-change', 'redirect', 'status-503'];
export const HTTP_CLASSES = ['unchanged', 'envelope-budget', 'oversized-body', 'binary-oversized', 'invalid-length', 'lying-length', 'short-length', 'chunked-never', 'redirect-loop', 'invalid-redirect', 'header-flood', 'gzip-expansion', 'slow-body', 'deep-json', 'retry-slow', 'retry-delay', 'redirect-slow', 'oauth-oversized', 'oauth-slow', 'oauth-null', 'page-oversized', 'page-deep', 'page-slow'];
export const MARKER = 'PMAK-' + 'network-fixture-private';
export const BODY_LIMIT = 8 * 1024 * 1024;
export const TIMEOUT_MS = 750;
// A size refusal must first receive the HTTP body or MCP declaration list, which on a loaded machine can
// take longer than the 750 ms deadline the timing variations exercise. These variations get a generous
// deadline so the size/count boundary decides them; every timing variation keeps TIMEOUT_MS.
export const SIZE_REFUSALS = new Set(['oversized-body', 'binary-oversized', 'gzip-expansion', 'deep-json', 'oauth-oversized', 'page-oversized', 'page-deep', 'list-spread']);
export const SIZE_TIMEOUT_MS = 10000;
export const timeoutFor = variation => SIZE_REFUSALS.has(variation) ? SIZE_TIMEOUT_MS : TIMEOUT_MS;
export function rpcBytes(message, variation, index = 0) {
  const random = prng(1, variation, index);
  const tool = { name: 'read', inputSchema: { type: 'object' } };
  let result = message.method === 'initialize'
    ? { protocolVersion: '2025-11-25', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } }
    : { tools: [tool] };
  // Exercise the initialization boundary for invalid encoding and oversize;
  // other variations follow a valid handshake and test enumeration failures.
  if (message.method !== 'initialize' || ['non-utf8', 'oversized-frame'].includes(variation)) {
    if (variation === 'malformed-json') return Buffer.from('{"' + MARKER + '"');
    if (variation === 'oversized-frame') return Buffer.from(' '.repeat(1024 * 1024 + 1 + (index ? Math.floor(random() * 128) : 0)));
    if (variation === 'list-spread') result = { tools: Array.from({ length: 150000 }, () => ({})) };
    if (variation === 'ten-thousand-tools') result = { tools: Array.from({ length: 10000 }, (_, i) => ({ ...tool, name: `read_${i}` })) };
    if (variation === 'deep-schema') return Buffer.from(`{"jsonrpc":"2.0","id":${message.id},"result":{"tools":[{"name":"read","inputSchema":${'{"items":'.repeat(1000)}{}${'}'.repeat(1000)}}]}}`);
    if (variation === 'non-utf8') return Buffer.concat([Buffer.from(`{"jsonrpc":"2.0","id":${message.id},"result":{"serverInfo":{"name":"`), Buffer.from([0xc3, 0x28]), Buffer.from('"},"capabilities":{}}}')]);
    if (variation === 'control-characters') tool.description = '\u0000\u001b\u007f' + 'x'.repeat(500 + Math.floor(random() * 100));
    if (variation === 'rpc-error') return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'network-private-diagnostic' + 'x'.repeat(2000) } }));
  }
  if (message.method !== 'initialize' && variation === 'slow-pages') result = { tools: [], nextCursor: String(message.id) };
  const id = message.method !== 'initialize' && variation === 'wrong-id' ? message.id + 1 + Math.floor(random() * 100) : message.id;
  return Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result }));
}
function drip(stream, text, interval = 25) {
  let i = 0;
  const timer = setInterval(() => stream.write(text[i++ % text.length]), interval);
  stream.on('close', () => clearInterval(timer));
}
export function serveStdio(variation, index) {
  const input = createInterface({ input: process.stdin });
  input.on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    if (message.method !== 'initialize' && variation === 'exit-mid-frame') return process.stdout.write('{"jsonrpc":', () => process.exit(0));
    if (message.method !== 'initialize' && variation === 'trickle') return drip(process.stdout, '{');
    const bytes = rpcBytes(message, variation, index);
    if (message.method !== 'initialize' && variation === 'slow-pages') return setTimeout(() => process.stdout.write(Buffer.concat([bytes, Buffer.from('\n')])), TIMEOUT_MS * .6);
    process.stdout.write(Buffer.concat([bytes, Buffer.from('\n')]));
    if (variation === 'duplicate-id') process.stdout.write(Buffer.concat([bytes, Buffer.from('\n')]));
  });
}
export async function startFixture(kind, variation, index = 0) {
  const random = prng(1, `${kind}/${variation}`, index);
  const sockets = new Set();
  let requests = 0;
  const raw = kind === 'http' && ['invalid-length', 'lying-length', 'short-length', 'header-flood'].includes(variation);
  const server = raw ? createTcpServer(socket => {
    socket.once('data', () => {
      requests++;
      if (variation === 'header-flood') return socket.end('HTTP/1.1 200 OK\r\n' + Array.from({ length: 2000 }, (_, i) => `X-${i}: ${'x'.repeat(50)}\r\n`).join('') + 'Content-Length: 2\r\n\r\n{}');
      const length = variation === 'invalid-length' ? 'bogus' : variation === 'short-length' ? '2' : '999';
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${length}\r\n\r\n{}${variation === 'short-length' ? MARKER : ''}`);
    });
  }) : createServer(async (req, res) => {
    requests++;
    res.on('error', () => {});
    if (kind === 'mcp') {
      let text = ''; for await (const chunk of req) text += chunk;
      const message = JSON.parse(text);
      res.setHeader('mcp-session-id', variation === 'session-change' && message.method !== 'initialize' ? 'changed' : 'initial');
      if (variation === 'redirect') { res.writeHead(307, { location: '/' }); return res.end(); }
      if (variation === 'status-503') { res.writeHead(503); return res.end(MARKER); }
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const isList = message.method !== 'initialize';
      if (isList && ['sse-open', 'sse-never'].includes(variation)) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(variation === 'sse-open' ? `data: ${rpcBytes(message, 'unchanged', index)}\n\n` : ': waiting\n\n');
        return;
      }
      res.setHeader('content-type', variation === 'duplicate-id' ? 'text/event-stream' : 'application/json');
      if (isList && variation === 'trickle') { res.flushHeaders(); return drip(res, '{'); }
      const bytes = rpcBytes(message, variation, index);
      if (isList && variation === 'slow-pages') { const timer = setTimeout(() => res.end(bytes), TIMEOUT_MS * .6); res.on('close', () => clearTimeout(timer)); return; }
      if (variation === 'duplicate-id') return res.end(`data: ${bytes}\n\ndata: ${bytes}\n\n`);
      return res.end(bytes);
    }
    res.setHeader('content-type', 'application/json');
    if (variation === 'redirect-loop') { res.writeHead(302, { location: '/' }); return res.end(); }
    if (variation === 'invalid-redirect') { res.writeHead(302, { location: 'http://[' }); return res.end(); }
    if (variation === 'retry-delay') { res.writeHead(429, { 'retry-after': '10' }); return res.end('{}'); }
    if (variation === 'redirect-slow') {
      const timer = setTimeout(() => { res.writeHead(302, { location: `/hop-${requests}` }); res.end(); }, TIMEOUT_MS * .6);
      res.on('close', () => clearTimeout(timer)); return;
    }
    if (variation === 'oauth-null') return res.end('null');
    if (variation.startsWith('page-') && requests === 1) { res.setHeader('link', '</next>; rel="next"'); return res.end('[{}]'); }
    if (variation === 'retry-slow' && requests === 1) { res.writeHead(429, { 'retry-after': '0' }); return res.end('{}'); }
    if (['chunked-never', 'slow-body', 'retry-slow', 'oauth-slow', 'page-slow'].includes(variation)) {
      res.flushHeaders(); res.write('[');
      if (variation !== 'slow-body') drip(res, ' ', 25);
      return;
    }
    if (['deep-json', 'page-deep'].includes(variation)) return res.end('{"a":'.repeat(15000) + '0' + '}'.repeat(15000));
    if (variation === 'binary-oversized') res.setHeader('content-type', 'application/octet-stream');
    if (['oversized-body', 'binary-oversized', 'gzip-expansion', 'oauth-oversized', 'page-oversized'].includes(variation)) {
      const bytes = Buffer.alloc(BODY_LIMIT + 1 + (index ? Math.floor(random() * 128) : 0), 32);
      if (variation === 'gzip-expansion') { res.setHeader('content-encoding', 'gzip'); return res.end(gzipSync(bytes)); }
      return res.end(bytes);
    }
    res.end(variation === 'envelope-budget' ? JSON.stringify(Array.from({ length: 2000 }, (_, i) => ({ id: i, name: 'x'.repeat(80) }))) : '{}');
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, get requests() { return requests; }, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) serveStdio(process.argv[2], Number(process.argv[3] ?? 0));
