import { readResponseText, boundResponseJson, normalizeNetworkError } from '../response-bounds.mjs';

export const protocolError = (code, message) => Object.assign(new Error(message), { code });
const MAX_REQUEST_BYTES = 1024 * 1024;

// Snapshot only JSON values. Programmatic callers must not silently lose an
// undefined/function property or stringify a class instance into new arguments.
export function jsonSnapshot(value, code = 'PROTOCOL_INPUT_INVALID') {
  let nodes = 0;
  const walk = (item, depth = 0) => {
    if (depth > 64 || ++nodes > 100000) throw protocolError(code, 'Protocol input exceeds the supported bound.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!item || typeof item !== 'object' || !Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      throw protocolError(code, 'Protocol input must contain only JSON values.');
    if (Array.isArray(item) && Object.keys(item).length !== item.length)
      throw protocolError(code, 'Protocol input arrays must contain explicit JSON values.');
    for (const child of Object.values(item)) walk(child, depth + 1);
  };
  try {
    walk(value);
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) throw protocolError(code, 'Protocol input exceeds the supported bound.');
    return JSON.parse(encoded);
  } catch (error) {
    if (error?.code === code) throw error;
    throw protocolError(code, 'Protocol input must contain only bounded JSON values.');
  }
}

const cancelledOutcome = signal => signal?.reason?.name === 'TimeoutError' || signal?.reason?.code === 'REQUEST_TIMEOUT'
  ? 'timeout' : 'cancelled';

export async function postJson(payload, { url, headers = {}, signal, onAttempt, accept = 'application/json' }) {
  let status = null, sent = 0, received = 0, responseHeaders = null;
  const failed = (code, message, outcome = 'incomplete') => ({ status, ok: false, body: null, outcome,
    complete: false, sent, received, headers: responseHeaders, error: { code, message } });
  if (!url || !['http:', 'https:'].includes(url.protocol)) return failed('PROTOCOL_URL_INVALID', 'Protocol HTTP target must use HTTP or HTTPS.');
  if (signal?.aborted) return failed('PROTOCOL_ABORTED', 'Protocol request was interrupted.', cancelledOutcome(signal));
  try {
    const requestHeaders = new Headers(headers);
    requestHeaders.set('content-type', 'application/json');
    requestHeaders.set('accept', accept);
    const body = JSON.stringify(payload);
    onAttempt?.();
    sent = 1;
    const response = await fetch(url, { method: 'POST', headers: requestHeaders, body, signal, redirect: 'manual' });
    status = response.status;
    received = 1;
    responseHeaders = Object.fromEntries(response.headers);
    if (status >= 300 && status < 400) {
      try { await response.body?.cancel(); } catch { /* no response diagnostics */ }
      return failed('PROTOCOL_REDIRECT_REFUSED', 'Protocol redirects are not followed.');
    }
    if (/^(?:text\/event-stream|multipart\/)/i.test(response.headers.get('content-type') ?? '')) {
      try { await response.body?.cancel(); } catch { /* no response diagnostics */ }
      return failed('PROTOCOL_STREAM_UNSUPPORTED', 'This HTTP operation requires a single JSON response.');
    }
    const text = await readResponseText(response);
    let parsed;
    try { parsed = JSON.parse(text); } catch { return failed('PROTOCOL_RESPONSE_INVALID', 'Protocol response is not a JSON document.'); }
    boundResponseJson(parsed);
    return { status, ok: response.ok, body: parsed, outcome: response.ok ? 'success' : 'error', complete: true, sent, received, headers: responseHeaders };
  } catch (error) {
    if (signal?.aborted) return failed('PROTOCOL_ABORTED', 'Protocol request was interrupted.', cancelledOutcome(signal));
    const normalized = normalizeNetworkError(error, signal);
    return failed(normalized.code, normalized.message, normalized.code === 'REQUEST_TIMEOUT' ? 'timeout' : 'incomplete');
  }
}
