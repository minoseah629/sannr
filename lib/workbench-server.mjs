// The HTTP boundary owns browser authority, never repository data or API calls.
// Only package-owned static bytes and explicitly injected engine handlers exist.
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const WORKBENCH_HEADERS = Object.freeze({ token: 'x-workbench-token', pairing: 'x-workbench-pairing' });
export const WORKBENCH_LIMITS = Object.freeze({
  requestBytes: 64 * 1024, responseBytes: 512 * 1024, assetBytes: 512 * 1024,
  idleTimeoutMs: 15 * 60 * 1000, lifetimeMs: 8 * 60 * 60 * 1000,
  pairingTimeoutMs: 2 * 60 * 1000, bodyTimeoutMs: 5000, pendingPairs: 4,
  actionsInFlight: 4,
});
const ASSET_TYPES = Object.freeze({
  '/': 'text/html; charset=utf-8',
  '/workbench.js': 'text/javascript; charset=utf-8',
  '/workbench.css': 'text/css; charset=utf-8',
});
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; font-src data:; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
});

/** Adapters may expose only an engine refusal already safe for the operator.
 * Unknown exceptions are never echoed: their message/stack may hold values. */
export class WorkbenchRefusal extends Error {
  constructor(code, nextAction) {
    if (!/^[A-Z][A-Z0-9_]{0,95}$/.test(code) || typeof nextAction !== 'string' || nextAction.length > 2000)
      throw new TypeError('Invalid public workbench refusal.');
    super('The engine refused this action.');
    this.code = code;
    this.nextAction = nextAction;
  }
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || actual.length !== expected.length) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keysExactly(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function limit(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError('Invalid workbench limit.');
  return value;
}
function jsonDepth(value, depth = 0, budget = { count: 0 }) {
  if (++budget.count > 10000 || depth > 32) return false;
  if (typeof value === 'number' && !Number.isFinite(value)) return false;
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !jsonDepth(item, depth + 1, budget)) return false;
    }
  }
  return true;
}
// Called only after JSON.parse validated the grammar. The small second pass
// rejects duplicate (including escaped) keys instead of choosing one meaning
// for an ambiguous envelope. String contents are never interpreted as tokens.
function uniqueJsonKeys(source) {
  const stack = [];
  for (const token of source.matchAll(/"(?:[^"\\]|\\.)*"|[{}\[\],:]|[^{}\[\],:\s]+/g)) {
    const value = token[0], parent = stack.at(-1);
    if (value === '{') stack.push({ keys: new Set(), key: true });
    else if (value === '[') stack.push({});
    else if (value === '}' || value === ']') stack.pop();
    else if (value === ',' && parent?.keys) parent.key = true;
    else if (value.startsWith('"') && parent?.key) {
      const key = JSON.parse(value);
      if (parent.keys.has(key)) return false;
      parent.keys.add(key);
      parent.key = false;
    }
  }
  return true;
}
function singleHeader(req, name) {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count === 1 && typeof req.headers[name] === 'string' ? req.headers[name] : undefined;
}

/**
 * Operator-launched IPv4 loopback service, ephemeral port, no implicit opener.
 *
 * assets: Map or object with '/', '/workbench.js', '/workbench.css' package
 * strings/Buffers (or {body, contentType}); these must contain no project data.
 * handlers: exact name -> async(params, {signal}) or {run, touch: true}.
 * Only touch-marked actions reset idle time; polling does not keep it alive.
 *
 * Public URL is safe to display. authorizePairing(code) must be invoked only
 * from the launch terminal after the operator enters the code shown in their
 * browser. It is deliberately not reachable over HTTP or auto-approved.
 * Credentials, redaction, destination validation and policy stay in handlers.
 * onPairingState receives only 'requested' or 'connected', never authority or
 * a code. It drives terminal status; it cannot approve a browser.
 */
export async function createWorkbenchServer({ assets, handlers, idleTimeoutMs, lifetimeMs, pairingTimeoutMs,
  maxRequestBytes, maxResponseBytes, bodyTimeoutMs, onPairingState } = {}) {
  if (onPairingState !== undefined && typeof onPairingState !== 'function') throw new TypeError('Invalid pairing state listener.');
  const limits = {
    idle: limit(idleTimeoutMs, WORKBENCH_LIMITS.idleTimeoutMs, WORKBENCH_LIMITS.lifetimeMs),
    lifetime: limit(lifetimeMs, WORKBENCH_LIMITS.lifetimeMs, WORKBENCH_LIMITS.lifetimeMs),
    pairing: limit(pairingTimeoutMs, WORKBENCH_LIMITS.pairingTimeoutMs, WORKBENCH_LIMITS.pairingTimeoutMs),
    request: limit(maxRequestBytes, WORKBENCH_LIMITS.requestBytes, WORKBENCH_LIMITS.requestBytes),
    response: limit(maxResponseBytes, WORKBENCH_LIMITS.responseBytes, WORKBENCH_LIMITS.responseBytes),
    body: limit(bodyTimeoutMs, WORKBENCH_LIMITS.bodyTimeoutMs, WORKBENCH_LIMITS.bodyTimeoutMs),
  };
  const staticAssets = new Map();
  for (const [path, asset] of assets instanceof Map ? assets : Object.entries(assets ?? {})) {
    if (!Object.hasOwn(ASSET_TYPES, path)) throw new TypeError('Unsupported workbench asset path.');
    const content = record(asset) && !Buffer.isBuffer(asset) ? asset.body : asset;
    if (typeof content !== 'string' && !Buffer.isBuffer(content)) throw new TypeError('Invalid workbench asset.');
    if (asset?.contentType && asset.contentType !== ASSET_TYPES[path]) throw new TypeError('Invalid workbench asset content type.');
    const body = Buffer.from(content);
    if (body.length > WORKBENCH_LIMITS.assetBytes) throw new TypeError('Workbench asset exceeds its byte limit.');
    staticAssets.set(path, { body, type: ASSET_TYPES[path] });
  }
  if (!staticAssets.has('/')) throw new TypeError('Workbench requires a package-local document.');
  const actions = new Map();
  for (const [name, definition] of Object.entries(handlers ?? {})) {
    const run = typeof definition === 'function' ? definition : definition?.run;
    if (!/^[a-z][a-zA-Z0-9.]{0,63}$/.test(name) || typeof run !== 'function') throw new TypeError('Invalid workbench action.');
    actions.set(name, { run, touch: definition?.touch === true });
  }

  const pending = new Map();
  const abort = new AbortController();
  let authority = null, origin, host, closing = false, inFlight = 0, idleTimer, lifetimeTimer;
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000,
    keepAliveTimeout: 1000, connectionsCheckingInterval: 1000 }, (req, res) => {
    void handle(req, res).catch(() => respond(res, 500, refusal('WORKBENCH_ACTION_FAILED', 'Retry the action; if it persists, restart the workbench.')));
  });
  server.maxConnections = 32;
  server.maxRequestsPerSocket = 100;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  server.on('connect', (_req, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { server.off('error', reject); resolve(); });
  });
  host = `127.0.0.1:${server.address().port}`;
  origin = `http://${host}`;

  function refusal(code, next) { return { ok: false, error: { code, next_action: next } }; }
  function respond(res, status, payload) {
    if (res.destroyed || res.writableEnded) return;
    let body;
    try { body = Buffer.from(JSON.stringify(payload)); } catch { body = null; }
    if (!body || body.length > limits.response) {
      status = 500;
      body = Buffer.from(JSON.stringify(refusal('WORKBENCH_RESPONSE_LIMIT', 'Use a narrower result or the headless inspection command.')));
      if (body.length > limits.response) body = Buffer.alloc(0);
    }
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
    res.end(body);
  }
  function deny(res, status, code, next) { respond(res, status, refusal(code, next)); }
  function pairingState(state) {
    // Terminal display is advisory; a failed display must neither approve a
    // browser nor change the HTTP/security result of the pairing exchange.
    try { onPairingState?.(state); } catch { /* local status only */ }
  }
  function prunePairs() {
    for (const [nonce, entry] of pending) if (entry.expires <= Date.now()) pending.delete(nonce);
  }
  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { void close('idle'); }, limits.idle);
    idleTimer.unref();
  }
  async function close(reason = 'operator') {
    if (closing) return closed;
    closing = true;
    authority = null;
    pending.clear();
    abort.abort();
    clearTimeout(idleTimer);
    clearTimeout(lifetimeTimer);
    server.close(() => resolveClosed({ reason }));
    server.closeAllConnections();
    return closed;
  }
  async function readBody(req) {
    return new Promise((resolve, reject) => {
      let bytes = 0;
      const parts = [];
      const timer = setTimeout(() => finish(new WorkbenchRefusal('WORKBENCH_BODY_TIMEOUT', 'Send a complete JSON request.')), limits.body);
      timer.unref();
      function finish(error, value) {
        clearTimeout(timer);
        req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', failed);
        if (error) { req.resume(); reject(error); } else resolve(value);
      }
      function failed() { finish(new WorkbenchRefusal('WORKBENCH_REQUEST_INVALID', 'Retry from the paired workbench.')); }
      function data(chunk) {
        bytes += chunk.length;
        if (bytes > limits.request) return finish(new WorkbenchRefusal('WORKBENCH_REQUEST_LIMIT', 'Reduce the request input size.'));
        parts.push(chunk);
      }
      function end() {
        try {
          // Reject malformed UTF-8, instead of silently changing an input value.
          const source = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts));
          const value = JSON.parse(source);
          if (!jsonDepth(value) || !uniqueJsonKeys(source)) throw new Error();
          finish(null, value);
        } catch { finish(new WorkbenchRefusal('WORKBENCH_REQUEST_INVALID', 'Send a supported JSON request.')); }
      }
      req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', failed);
    });
  }
  async function handle(req, res) {
    if (closing) return deny(res, 410, 'WORKBENCH_CLOSED', 'Launch the workbench again.');
    if (req.socket.remoteAddress !== '127.0.0.1' || singleHeader(req, 'host') !== host)
      return deny(res, 403, 'WORKBENCH_HOST', 'Use the exact loopback URL from the launch terminal.');
    if (req.method === 'GET' && staticAssets.has(req.url)) {
      const suppliedOrigin = req.headers.origin;
      if (suppliedOrigin !== undefined && singleHeader(req, 'origin') !== origin)
        return deny(res, 403, 'WORKBENCH_ORIGIN', 'Open the workbench directly from its launch URL.');
      const asset = staticAssets.get(req.url);
      res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type, 'content-length': asset.body.length });
      res.end(asset.body);
      return;
    }
    if (!['/pair/start', '/pair/complete', '/action'].includes(req.url))
      return deny(res, 404, 'WORKBENCH_ROUTE', 'Use the packaged workbench interface.');
    if (req.method !== 'POST') return deny(res, 405, 'WORKBENCH_METHOD', 'Use the paired workbench interface.');
    if (singleHeader(req, 'origin') !== origin || singleHeader(req, 'sec-fetch-site') !== 'same-origin' ||
        singleHeader(req, 'sec-fetch-mode') !== 'cors' || singleHeader(req, 'sec-fetch-dest') !== 'empty')
      return deny(res, 403, 'WORKBENCH_ORIGIN', 'Use the paired workbench at the exact launch origin.');
    if (singleHeader(req, 'content-type') !== 'application/json' || singleHeader(req, 'accept') !== 'application/json' ||
        req.headers['content-encoding'] !== undefined || req.headers['access-control-request-method'] !== undefined)
      return deny(res, 415, 'WORKBENCH_REQUEST_SHAPE', 'Use the packaged JSON action interface.');
    // Authentication happens before reading bodies or invoking any private handler.
    if (req.url === '/action' && !equalSecret(singleHeader(req, WORKBENCH_HEADERS.token), authority))
      return deny(res, 401, 'WORKBENCH_AUTH_REQUIRED', 'Pair this browser in the launch terminal.');
    if (req.url !== '/action' && req.headers[WORKBENCH_HEADERS.token] !== undefined)
      return deny(res, 400, 'WORKBENCH_REQUEST_SHAPE', 'Pair without an existing action token.');
    if (req.url !== '/pair/complete' && req.headers[WORKBENCH_HEADERS.pairing] !== undefined)
      return deny(res, 400, 'WORKBENCH_REQUEST_SHAPE', 'Use the packaged pairing interface.');
    const size = req.headers['content-length'];
    if (size !== undefined && (!/^\d+$/.test(size) || Number(size) > limits.request))
      return deny(res, 413, 'WORKBENCH_REQUEST_LIMIT', 'Reduce the request input size.');
    let body;
    try { body = await readBody(req); }
    catch (error) {
      return deny(res, error.code === 'WORKBENCH_REQUEST_LIMIT' ? 413 : 400, error.code, error.nextAction);
    }
    // Revocation may occur while a slow request body is being received.
    if (closing) return deny(res, 410, 'WORKBENCH_CLOSED', 'Launch the workbench again.');
    if (req.url === '/action' && !equalSecret(singleHeader(req, WORKBENCH_HEADERS.token), authority))
      return deny(res, 401, 'WORKBENCH_AUTH_REQUIRED', 'Pair this browser in the launch terminal.');
    if (req.url === '/pair/start') {
      if (!keysExactly(body, [])) return deny(res, 400, 'WORKBENCH_REQUEST_SHAPE', 'Start pairing with an empty JSON object.');
      prunePairs();
      if (pending.size >= WORKBENCH_LIMITS.pendingPairs)
        return deny(res, 429, 'WORKBENCH_PAIRING_LIMIT', 'Wait two minutes or restart the workbench, then pair again.');
      const nonce = randomBytes(32).toString('base64url');
      const code = randomBytes(6).toString('hex').toUpperCase().match(/.{4}/g).join('-');
      pending.set(nonce, { code, expires: Date.now() + limits.pairing, approved: false });
      pairingState('requested');
      return respond(res, 200, { ok: true, result: { code, nonce, expires_in_ms: limits.pairing } });
    }
    if (req.url === '/pair/complete') {
      if (!keysExactly(body, [])) return deny(res, 400, 'WORKBENCH_REQUEST_SHAPE', 'Complete pairing with an empty JSON object.');
      prunePairs();
      const nonce = singleHeader(req, WORKBENCH_HEADERS.pairing);
      const pairing = pending.get(nonce);
      if (!pairing) return deny(res, 401, 'WORKBENCH_PAIRING_EXPIRED', 'Start pairing again and enter the new browser code in the launch terminal.');
      if (!pairing.approved) return respond(res, 202, { ok: true, result: { paired: false } });
      authority = randomBytes(32).toString('base64url');
      pending.clear();
      touch();
      pairingState('connected');
      return respond(res, 200, { ok: true, result: { paired: true, token: authority } });
    }
    if (!keysExactly(body, ['action', 'params']) || typeof body.action !== 'string' || !record(body.params))
      return deny(res, 400, 'WORKBENCH_REQUEST_SHAPE', 'Use an action name and a JSON parameter object.');
    const action = actions.get(body.action);
    if (!action) return deny(res, 404, 'WORKBENCH_ACTION_UNKNOWN', 'Use an action exposed by the packaged workbench.');
    if (inFlight >= WORKBENCH_LIMITS.actionsInFlight)
      return deny(res, 429, 'WORKBENCH_BUSY', 'Wait for an active action to finish.');
    inFlight++;
    if (action.touch) touch();
    try {
      const result = await action.run(body.params, { signal: abort.signal });
      if (!closing) respond(res, 200, { ok: true, result });
    } catch (error) {
      if (error instanceof WorkbenchRefusal) return deny(res, 409, error.code, error.nextAction);
      deny(res, 500, 'WORKBENCH_ACTION_FAILED', 'The action could not be completed. Inspect local engine status, then retry.');
    } finally { inFlight--; }
  }

  touch();
  lifetimeTimer = setTimeout(() => { void close('lifetime'); }, limits.lifetime);
  lifetimeTimer.unref();
  return Object.freeze({
    url: `${origin}/`, origin, closed, close,
    authorizePairing(code) {
      if (closing || typeof code !== 'string') return false;
      prunePairs();
      const normalized = code.trim().toUpperCase();
      for (const [nonce, entry] of pending) {
        if (equalSecret(normalized, entry.code)) {
          for (const other of pending.keys()) if (other !== nonce) pending.delete(other);
          entry.approved = true;
          touch();
          return true;
        }
      }
      return false;
    },
  });
}
