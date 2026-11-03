import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const EXPIRES_MINUTES = 30;
const TTL_MS = EXPIRES_MINUTES * 60_000;
const STARTUP_MS = 5000;
const MAX_HTML_BYTES = 16 * 1024 * 1024;
const failure = (code, message) => Object.assign(new Error(message), { code });

function htmlBuffer(html) {
  if (typeof html !== 'string' || !html.length || Buffer.byteLength(html) > MAX_HTML_BYTES)
    throw failure('MAP_PREVIEW_INPUT_INVALID', 'The map preview requires nonempty HTML of at most 16 MiB.');
  return Buffer.from(html, 'utf8');
}

/** Serve one immutable generated map; there is no filesystem request handler. */
export async function createMapPreview(html, { ttlMs = TTL_MS } = {}) {
  const body = htmlBuffer(html);
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > TTL_MS)
    throw failure('MAP_PREVIEW_TTL_INVALID', 'The map preview lifetime must be between 1 millisecond and 30 minutes.');
  const route = `/${randomBytes(16).toString('hex')}`;
  let authority, timer, closing = false, resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000,
    headersTimeout: 5000, keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' };
    const reject = (status, text, extra = {}) => {
      res.writeHead(status, { ...headers, 'content-type': 'text/plain; charset=utf-8', ...extra });
      res.end(req.method === 'HEAD' ? undefined : text);
    };
    const hostCount = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === 'host').length;
    if (req.headers.host !== authority || hostCount !== 1) { reject(421, 'Unexpected host.'); return; }
    if (req.url !== route) { reject(404, 'Not found.'); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') { reject(405, 'Method not allowed.', { allow: 'GET, HEAD' }); return; }
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8',
      'content-disposition': 'inline', 'content-length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  server.maxConnections = 16;
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('upgrade', (_req, socket) => socket.destroy());
  server.on('connect', (_req, socket) => socket.destroy());
  const close = () => {
    if (!closing) {
      closing = true;
      clearTimeout(timer);
      server.close(() => resolveClosed());
      server.closeAllConnections();
    }
    return closed;
  };
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch {
    server.close();
    throw failure('MAP_PREVIEW_LISTEN_FAILED', 'The local map preview could not start listening.');
  }
  server.removeAllListeners('error');
  server.on('error', close);
  authority = `127.0.0.1:${server.address().port}`;
  timer = setTimeout(close, ttlMs);
  return { url: `http://${authority}${route}`, close, closed };
}

/** Start a bounded worker that remains available after the CLI exits. */
export async function startMapPreview(html) {
  htmlBuffer(html);
  const { fork } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    let child, settled = false, timer;
    const fail = (code = 'MAP_PREVIEW_START_FAILED') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child?.connected) child.disconnect();
      child?.kill('SIGKILL');
      reject(failure(code, 'The map was saved, but its local browser preview could not start.'));
    };
    try {
      child = fork(fileURLToPath(new URL('../bin/map-preview.mjs', import.meta.url)), [],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    } catch { fail(); return; }
    timer = setTimeout(() => fail('MAP_PREVIEW_START_TIMEOUT'), STARTUP_MS);
    child.on('error', () => fail());
    child.once('exit', () => fail());
    child.once('message', message => {
      if (settled) return;
      if (message?.type !== 'ready' || typeof message.url !== 'string'
        || !/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{32}$/.test(message.url)) { fail(); return; }
      settled = true;
      clearTimeout(timer);
      child.disconnect();
      child.unref();
      resolve({ url: message.url, expiresInMinutes: EXPIRES_MINUTES, pid: child.pid });
    });
    try { child.send({ type: 'init', html }, error => { if (error) fail(); }); }
    catch { fail(); }
  });
}
