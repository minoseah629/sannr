import { randomUUID } from 'node:crypto';
import { jsonSnapshot, postJson, protocolError } from './http-json.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw protocolError(code, message); };

export async function prepareJsonRpc(request, _options = {}) {
  const input = request?.rpc;
  if (Array.isArray(input) || object(input) && Object.hasOwn(input, 'batch'))
    fail('JSONRPC_BATCH_UNSUPPORTED', 'JSON-RPC batch requests are not supported by this adapter.');
  if (!object(input)) fail('JSONRPC_METHOD_REQUIRED', 'JSON-RPC requires a method name.');
  if (Object.hasOwn(input, 'notification')) fail('JSONRPC_NOTIFICATION_UNSUPPORTED', 'JSON-RPC notifications are not supported by this adapter.');
  if (typeof input.method !== 'string' || !input.method.length || input.method.length > 200 || /[\x00-\x1f\x7f]/.test(input.method))
    fail('JSONRPC_METHOD_INVALID', 'JSON-RPC method must be a nonempty bounded name.');
  if (input.params !== undefined && !Array.isArray(input.params) && !object(input.params))
    fail('JSONRPC_PARAMS_INVALID', 'JSON-RPC params must be a JSON array or object.');
  if (input.id !== undefined && input.id !== null && typeof input.id !== 'string' && !(typeof input.id === 'number' && Number.isSafeInteger(input.id)))
    fail('JSONRPC_ID_INVALID', 'JSON-RPC id must be a string, safe integer or null.');
  if (Object.hasOwn(input, 'schema')) fail('JSONRPC_SCHEMA_UNSUPPORTED', 'JSON-RPC schemas are not supported by this adapter.');
  if (Object.keys(input).some(key => !['method', 'params', 'id'].includes(key)))
    fail('JSONRPC_OPTION_UNSUPPORTED', 'JSON-RPC input contains an unsupported option.');
  const payload = jsonSnapshot({ jsonrpc: '2.0', method: input.method,
    ...(input.params !== undefined ? { params: input.params } : {}), id: input.id === undefined ? randomUUID() : input.id }, 'JSONRPC_INPUT_INVALID');
  return {
    operation: input.method, effect: 'unknown', contractDigest: null,
    declaration: { version: '2.0', method: input.method, schemaValidated: false },
    execute: async options => {
      const response = await postJson(payload, options);
      if (!response.complete) return response;
      const body = response.body;
      const invalid = (code = 'JSONRPC_RESPONSE_INVALID', message = 'Response is not a valid JSON-RPC response.') => ({
        ...response, ok: false, complete: false, outcome: 'incomplete', error: { code, message },
      });
      if (!object(body) || body.jsonrpc !== '2.0') return invalid();
      if (!Object.hasOwn(body, 'id') || body.id !== payload.id)
        return invalid('JSONRPC_ID_MISMATCH', 'JSON-RPC response does not match the request id.');
      const hasResult = Object.hasOwn(body, 'result'), hasError = Object.hasOwn(body, 'error');
      if (hasResult === hasError) return invalid();
      if (hasError) {
        if (!object(body.error) || !Number.isSafeInteger(body.error.code) || typeof body.error.message !== 'string') return invalid();
        return { ...response, ok: false, outcome: 'error', protocolStatus: body.error.code,
          error: { code: 'JSONRPC_REMOTE_ERROR', message: 'JSON-RPC returned an application error.' } };
      }
      if (!response.ok) return { ...response, error: { code: 'JSONRPC_HTTP_ERROR', message: 'JSON-RPC HTTP request was not successful.' } };
      return response;
    },
  };
}
