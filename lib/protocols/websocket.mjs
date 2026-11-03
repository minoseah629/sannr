import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { atPath } from '../assertions.mjs';
import { boundResponseJson } from '../response-bounds.mjs';
import { jsonSnapshot } from './http-json.mjs';

const LIMITS = {
  timeout_ms: [10_000, 60_000], max_messages: [32, 1000],
  max_frame_bytes: [64 * 1024, 1024 * 1024], max_total_bytes: [1024 * 1024, 8 * 1024 * 1024],
};
const MAX_SENDS = 64;
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_WEBSOCKET_REQUEST' });
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const primitive = value => value === null || ['string', 'boolean'].includes(typeof value)
  || (typeof value === 'number' && Number.isFinite(value));

function jsonText(value) {
  return JSON.stringify(jsonSnapshot(value, 'INVALID_WEBSOCKET_REQUEST'));
}

function optionsFor(input = {}, subscription = false) {
  if (!plain(input)) throw invalid('websocket must be an object.');
  const allowed = new Set(['operation', 'send', 'until', 'subprotocols', 'effect', ...Object.keys(LIMITS)]);
  if (Object.keys(input).some(key => !allowed.has(key))) throw invalid('websocket contains an unsupported option.');
  if (input.effect !== undefined && !['read', 'write', 'unknown'].includes(input.effect))
    throw invalid('websocket.effect must be read, write, or unknown.');
  const limits = Object.fromEntries(Object.entries(LIMITS).map(([key, [fallback, ceiling]]) => {
    const value = input[key] ?? fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling)
      throw invalid(`${key} must be an integer from 1 to ${ceiling}.`);
    return [key, value];
  }));
  const until = input.until;
  if (until !== undefined && (!plain(until) || typeof until.json !== 'string' || until.json.length > 512
    || until.json.split('.').length > 64 || Object.keys(until).some(key => !['json', 'equals', 'exists'].includes(key))
    || (!Object.hasOwn(until, 'equals') && !Object.hasOwn(until, 'exists'))
    || (Object.hasOwn(until, 'equals') && !primitive(until.equals))
    || (Object.hasOwn(until, 'exists') && typeof until.exists !== 'boolean')))
    throw invalid('until requires a bounded JSON path and equals (primitive) or exists (boolean).');
  const subprotocols = input.subprotocols ?? (subscription ? ['graphql-transport-ws'] : []);
  if (!Array.isArray(subprotocols) || subprotocols.length > 8 || new Set(subprotocols).size !== subprotocols.length
    || subprotocols.some(value => typeof value !== 'string' || value.length > 128 || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value)))
    throw invalid('subprotocols must contain at most eight distinct WebSocket protocol tokens.');
  if (subscription && (subprotocols.length !== 1 || subprotocols[0] !== 'graphql-transport-ws'))
    throw invalid('GraphQL subscriptions require the graphql-transport-ws subprotocol.');
  const send = input.send ?? [];
  if (!Array.isArray(send) || send.length > 32 || (subscription && send.length))
    throw invalid(subscription ? 'GraphQL subscription frames are managed by the adapter; websocket.send is not supported.'
      : 'send must be an array of at most 32 JSON messages.');
  const frames = send.map(jsonText);
  if (frames.some(frame => Buffer.byteLength(frame) > limits.max_frame_bytes)
    || frames.reduce((sum, frame) => sum + Buffer.byteLength(frame), 0) > limits.max_total_bytes)
    throw invalid('Outgoing messages exceed the configured frame or total byte bound.');
  return { ...limits, effect: input.effect ?? 'unknown',
    effectBasis: input.effect === undefined ? 'unknown' : 'caller-declared-unverified',
    until: until ? { ...until } : null, subprotocols: [...subprotocols], frames };
}

function matches(message, predicate) {
  const value = atPath(message, predicate.json);
  return (!Object.hasOwn(predicate, 'equals') || value === predicate.equals)
    && (!Object.hasOwn(predicate, 'exists') || (value !== undefined) === predicate.exists);
}

function socketUrl(url) {
  const target = new URL(url);
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.hash)
    throw invalid('WebSocket targets require an HTTP(S) or WS(S) URL without credentials or a fragment.');
  target.protocol = target.protocol === 'https:' || target.protocol === 'wss:' ? 'wss:' : 'ws:';
  return target;
}

function runSession(config, graphql, { url, headers = {}, signal, onAttempt = () => {} }) {
  const target = socketUrl(url);
  return new Promise(resolve => {
    const messages = [], omissions = [];
    let socket, status = null, sent = 0, received = 0, bytes = 0, controls = 0, reservedSends = 0;
    let ending = false, resolved = false, result, timer, closeTimer, queue = Promise.resolve();
    let acknowledged = false, subscribed = false, subscriptionEnded = false;
    let initialFramesSent = 0, predicateMatched = false;
    const id = graphql ? randomUUID() : null;
    const deliver = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', aborted);
      resolve({ status, ok: result?.outcome === 'success', body: { messages },
        outcome: result?.outcome ?? 'error', complete: result?.complete ?? false,
        sent, received, ...(result?.protocolStatus !== undefined ? { protocolStatus: result.protocolStatus } : {}),
        ...(result?.error ? { error: result.error } : {}), ...(omissions.length ? { omissions } : {}) });
    };
    const stop = (outcome, code, message, { complete = false, protocolStatus, unsubscribe = true } = {}) => {
      if (ending) return;
      ending = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      if (!graphql && initialFramesSent < config.frames.length)
        omissions.push(`${config.frames.length - initialFramesSent} initial outgoing messages were not dispatched before the session ended.`);
      result = { outcome, complete, protocolStatus, ...(code ? { error: { code, message } } : {}) };
      if (!socket || socket.readyState === WebSocket.CLOSED) { deliver(); return; }
      // Graceful close gets a short, fixed cleanup interval. A peer that never
      // acknowledges close cannot keep the caller or its socket alive forever.
      closeTimer = setTimeout(() => { socket.terminate(); deliver(); }, 100);
      if (socket.readyState !== WebSocket.OPEN) { socket.terminate(); return; }
      if (graphql && subscribed && !subscriptionEnded && unsubscribe) {
        const text = JSON.stringify({ id, type: 'complete' });
        const size = Buffer.byteLength(text);
        if (sent < MAX_SENDS && size <= config.max_frame_bytes && bytes + size <= config.max_total_bytes
          && socket.bufferedAmount + size <= config.max_frame_bytes * 2) {
          bytes += size; sent += 1;
          socket.send(text, error => { if (error) socket.terminate(); else socket.close(1000); });
          return;
        }
        omissions.push('Subscription completion frame omitted because the send bound was reached.');
      }
      socket.close(1000);
    };
    const aborted = () => {
      const timeout = signal?.reason?.name === 'TimeoutError' || signal?.reason?.code === 'REQUEST_TIMEOUT';
      stop(timeout ? 'timeout' : 'cancelled', timeout ? 'WEBSOCKET_TIMEOUT' : 'WEBSOCKET_CANCELLED',
        timeout ? 'The WebSocket session exceeded its deadline.' : 'The WebSocket session was cancelled.');
    };
    const send = (text, pong = false, dispatched = () => {}) => {
      const size = Buffer.byteLength(text);
      if (ending) return;
      if (size > config.max_frame_bytes || bytes + size > config.max_total_bytes || reservedSends >= MAX_SENDS) {
        stop('incomplete', 'WEBSOCKET_SEND_LIMIT', 'The WebSocket send or byte bound was reached.'); return;
      }
      bytes += size; reservedSends += 1;
      queue = queue.then(() => new Promise(done => {
        if (ending || socket.readyState !== WebSocket.OPEN) { done(); return; }
        if (socket.bufferedAmount + size > config.max_frame_bytes * 2) {
          stop('incomplete', 'WEBSOCKET_BACKPRESSURE', 'The WebSocket send buffer exceeded its bound.'); done(); return;
        }
        sent += 1;
        socket[pong ? 'pong' : 'send'](text, error => {
          if (error && !ending) stop('error', 'WEBSOCKET_SEND_FAILED', 'A WebSocket message could not be sent.');
          done();
        });
        dispatched();
      })).catch(() => stop('error', 'WEBSOCKET_SEND_FAILED', 'A WebSocket message could not be sent.'));
    };
    const protocolFailure = () => stop('error', 'GRAPHQL_WS_PROTOCOL_ERROR',
      'The GraphQL subscription returned an invalid or out-of-order protocol message.', { unsubscribe: false });
    const handleGraphql = frame => {
      if (!plain(frame) || typeof frame.type !== 'string') { protocolFailure(); return; }
      if (frame.type === 'ping' || frame.type === 'pong') {
        if (frame.payload != null && !plain(frame.payload)) { protocolFailure(); return; }
        if (frame.type === 'ping') send(JSON.stringify({ type: 'pong', ...(frame.payload ? { payload: frame.payload } : {}) }));
        return;
      }
      if (frame.type === 'connection_ack') {
        if (acknowledged || (frame.payload != null && !plain(frame.payload))) { protocolFailure(); return; }
        acknowledged = true;
        send(JSON.stringify({ id, type: 'subscribe', payload: graphql }), false, () => { subscribed = true; });
        return;
      }
      if (!acknowledged || !subscribed || frame.id !== id) { protocolFailure(); return; }
      if (frame.type === 'next') {
        if (!plain(frame.payload) || (!Object.hasOwn(frame.payload, 'data') && !Object.hasOwn(frame.payload, 'errors'))
          || (Object.hasOwn(frame.payload, 'data') && frame.payload.data !== null && !plain(frame.payload.data))
          || (Object.hasOwn(frame.payload, 'errors') && (!Array.isArray(frame.payload.errors) || !frame.payload.errors.length
            || frame.payload.errors.some(error => !plain(error) || typeof error.message !== 'string')))
          || (Object.hasOwn(frame.payload, 'extensions') && !plain(frame.payload.extensions))) { protocolFailure(); return; }
        if (frame.payload.errors?.length) {
          stop(plain(frame.payload.data) ? 'partial' : 'error', 'GRAPHQL_EXECUTION_ERROR',
            'The subscription returned GraphQL execution errors.', { protocolStatus: 'next.errors' }); return;
        }
        if (config.until && matches(frame.payload, config.until)) stop('success', null, null, { complete: true, protocolStatus: 'predicate' });
        return;
      }
      if (frame.type === 'error') {
        if (!Array.isArray(frame.payload) || !frame.payload.length
          || frame.payload.some(error => !plain(error) || typeof error.message !== 'string')) { protocolFailure(); return; }
        subscriptionEnded = true;
        stop('error', 'GRAPHQL_EXECUTION_ERROR', 'The GraphQL subscription ended with execution errors.',
          { protocolStatus: 'error', unsubscribe: false }); return;
      }
      if (frame.type === 'complete') {
        subscriptionEnded = true;
        if (config.until) stop('incomplete', 'WEBSOCKET_PREDICATE_UNMET', 'The subscription ended before its completion predicate matched.',
          { protocolStatus: 'complete', unsubscribe: false });
        else stop('success', null, null, { complete: true, protocolStatus: 'complete', unsubscribe: false });
        return;
      }
      protocolFailure();
    };
    if (signal?.aborted) { aborted(); return; }
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => stop('timeout', 'WEBSOCKET_TIMEOUT', 'The WebSocket session exceeded its deadline.'), config.timeout_ms);
    try {
      onAttempt();
      socket = new WebSocket(target, config.subprotocols, { headers: { ...headers }, followRedirects: false,
        handshakeTimeout: config.timeout_ms, maxPayload: config.max_frame_bytes, perMessageDeflate: false, autoPong: false });
    } catch { stop('error', 'WEBSOCKET_CONNECT_FAILED', 'The WebSocket connection could not be created.'); return; }
    socket.on('upgrade', response => { status = response.statusCode; });
    socket.on('unexpected-response', (request, response) => {
      status = response.statusCode;
      // Do not read or forward a redirect response; it may name another host.
      response.destroy(); request.destroy();
      stop('error', status >= 300 && status < 400 ? 'WEBSOCKET_REDIRECT_REFUSED' : 'WEBSOCKET_HANDSHAKE_REFUSED',
        'The configured target did not accept the WebSocket upgrade.');
    });
    socket.on('open', () => {
      if (ending) return;
      if (graphql && socket.protocol !== 'graphql-transport-ws') { protocolFailure(); return; }
      if (graphql) send(JSON.stringify({ type: 'connection_init' }));
      else for (const frame of config.frames) send(frame, false, () => {
        initialFramesSent += 1;
        if (predicateMatched && initialFramesSent === config.frames.length)
          stop('success', null, null, { complete: true, protocolStatus: 'predicate' });
      });
    });
    socket.on('ping', data => {
      if (ending) return;
      bytes += data.length;
      if (++controls > MAX_SENDS || bytes > config.max_total_bytes) {
        stop('incomplete', 'WEBSOCKET_CONTROL_LIMIT', 'The WebSocket control-frame bound was reached.'); return;
      }
      send(data, true);
    });
    socket.on('pong', data => {
      if (ending) return;
      bytes += data.length;
      if (++controls > MAX_SENDS || bytes > config.max_total_bytes)
        stop('incomplete', 'WEBSOCKET_CONTROL_LIMIT', 'The WebSocket control-frame bound was reached.');
    });
    socket.on('message', (data, binary) => {
      if (ending) return;
      received += 1; bytes += data.length;
      if (data.length > config.max_frame_bytes || bytes > config.max_total_bytes) {
        omissions.push('The message exceeding the byte bound was omitted.');
        stop('incomplete', 'WEBSOCKET_BYTE_LIMIT', 'The WebSocket frame or total byte bound was reached.'); return;
      }
      if (binary) {
        omissions.push('A binary WebSocket message was omitted; this adapter accepts JSON text messages.');
        stop('error', 'WEBSOCKET_BINARY_UNSUPPORTED', 'Binary WebSocket messages are not supported.'); return;
      }
      let frame;
      try { frame = JSON.parse(data.toString()); boundResponseJson(frame); }
      catch {
        omissions.push('An invalid or oversized JSON message was omitted.');
        stop('error', 'WEBSOCKET_INVALID_JSON', 'The WebSocket message was not bounded JSON.'); return;
      }
      messages.push(frame);
      if (graphql) handleGraphql(frame);
      else if (config.until && matches(frame, config.until)) {
        predicateMatched = true;
        if (initialFramesSent === config.frames.length) stop('success', null, null, { complete: true, protocolStatus: 'predicate' });
      }
      if (!ending && received >= config.max_messages)
        stop('incomplete', 'WEBSOCKET_MESSAGE_LIMIT', 'The WebSocket message bound was reached before completion.');
    });
    socket.on('error', error => {
      if (ending) return;
      if (error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH') {
        omissions.push('An oversized WebSocket message was omitted.');
        stop('incomplete', 'WEBSOCKET_BYTE_LIMIT', 'The WebSocket frame byte bound was reached.');
      } else stop(messages.length ? 'partial' : 'error', 'WEBSOCKET_TRANSPORT_ERROR', 'The WebSocket transport failed.');
    });
    socket.on('close', code => {
      if (ending) { deliver(); return; }
      if (code === 1000 && !graphql && initialFramesSent < config.frames.length)
        stop('incomplete', 'WEBSOCKET_SEND_INCOMPLETE', 'The socket closed before all initial messages could be dispatched.', { protocolStatus: code });
      else if (code === 1000 && !graphql && !config.until) stop('success', null, null, { complete: true, protocolStatus: code });
      else if (code === 1000) stop('incomplete', 'WEBSOCKET_CLOSED_BEFORE_COMPLETION',
        'The socket closed before the requested completion signal.', { protocolStatus: code });
      else stop(messages.length ? 'partial' : 'error', 'WEBSOCKET_ABNORMAL_CLOSE',
        'The WebSocket session closed abnormally.', { protocolStatus: code });
    });
  });
}

export async function prepareWebsocket(request, { root } = {}) {
  const input = request?.websocket;
  if (!plain(input) || typeof input.operation !== 'string' || !input.operation.trim()
    || input.operation.length > 256 || /[\x00-\x1f\x7f]/.test(input.operation))
    throw invalid('websocket.operation must name the channel or message operation in at most 256 characters.');
  const config = optionsFor(input);
  return { operation: `WEBSOCKET ${input.operation.trim()}`, effect: config.effect, contractDigest: null,
    declaration: { protocol: 'websocket', operation: input.operation.trim(), stream: true,
      effect: config.effect, effectBasis: config.effectBasis,
      bounds: Object.fromEntries(Object.keys(LIMITS).map(key => [key, config[key]])), completion: config.until ? 'predicate' : 'normal_close' },
    execute: context => runSession(config, null, context) };
}

export async function prepareGraphqlSubscription(request, { root } = {}) {
  const { analyzeGraphql } = await import('./graphql.mjs');
  const analyzed = await analyzeGraphql(request, { root });
  if (analyzed.kind !== 'subscription') throw invalid('The selected GraphQL operation must be a subscription.');
  const config = optionsFor(request.websocket, true);
  // Validate the entire subscribe frame before any upgrade or connection_init.
  const text = jsonText({ id: '00000000-0000-0000-0000-000000000000', type: 'subscribe', payload: analyzed.payload });
  if (Buffer.byteLength(text) > config.max_frame_bytes || Buffer.byteLength(text) > config.max_total_bytes)
    throw invalid('The GraphQL subscription exceeds the configured frame or total byte bound.');
  return { operation: analyzed.operation, effect: config.effect, contractDigest: analyzed.contractDigest,
    declaration: { ...analyzed.declaration, protocol: 'graphql-transport-ws', stream: true,
      effect: config.effect, effectBasis: config.effectBasis,
      bounds: Object.fromEntries(Object.keys(LIMITS).map(key => [key, config[key]])),
      completion: config.until ? 'next.payload predicate' : 'complete frame', messageCount: 'all received JSON protocol frames' },
    execute: context => runSession(config, analyzed.payload, context) };
}
