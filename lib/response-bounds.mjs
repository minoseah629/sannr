// A wire bound is separate from the much smaller presentation token budget.
// Count decoded bytes: fetch transparently decompresses gzip/deflate/brotli.
export const RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const messages = {
  RESPONSE_OVERSIZED: 'Response exceeds the supported byte, node or nesting bound.',
  RESPONSE_REDIRECT_LOOP: 'Response redirect chain repeated a target.',
  RESPONSE_REDIRECT_INVALID: 'Response contains an invalid redirect target.',
  REQUEST_TIMEOUT: 'Request exceeded its deadline.',
  TRANSPORT_FAILED: 'HTTP transport failed while receiving the response.',
};
export const responseFailure = code => Object.assign(new Error(messages[code] ?? 'HTTP transport failed.'), { code });
export function normalizeNetworkError(error, signal) {
  if (Object.hasOwn(messages, error?.code)) return responseFailure(error.code);
  if (signal?.aborted || error?.name === 'TimeoutError' || error?.cause?.name === 'TimeoutError') return responseFailure('REQUEST_TIMEOUT');
  // Only known OS connection identities may survive; native messages can carry
  // response bytes (for example parser diagnostics). Never copy those messages.
  const cause = error?.cause?.code ?? error?.code;
  return responseFailure(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause) ? cause : 'TRANSPORT_FAILED');
}
export async function readResponseBytes(response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > RESPONSE_MAX_BYTES) throw responseFailure('RESPONSE_OVERSIZED');
      chunks.push(Buffer.from(value));
    }
  } finally {
    // Cancellation releases sockets on refusal as well as successful EOF.
    try { await reader.cancel(); } catch { /* no upstream diagnostics */ }
  }
}
export const readResponseText = async response => (await readResponseBytes(response)).toString('utf8');
export function boundResponseJson(value, depth = 0, budget = { nodes: 0 }) {
  if (depth > 64 || ++budget.nodes > 250000) throw responseFailure('RESPONSE_OVERSIZED');
  if (value && typeof value === 'object') for (const item of Object.values(value)) boundResponseJson(item, depth + 1, budget);
  return value;
}
