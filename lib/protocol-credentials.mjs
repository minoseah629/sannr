import { types } from 'node:util';
import { SECRET_HEADERS, CREDENTIAL_SHAPED_HEADER, SECRET_PARAMS } from './curl.mjs';

const credentialName = name => name.toLowerCase() === 'set-cookie' || SECRET_HEADERS.test(name)
  || CREDENTIAL_SHAPED_HEADER.test(name) || SECRET_PARAMS.test(name);
const payloadFields = { graphql: new Set(['variables']), rpc: new Set(['params']),
  grpc: new Set(['body', 'messages']), websocket: new Set(['send']) };
const INVALID = 'PROTOCOL_INPUT_INVALID', CREDENTIAL = 'CREDENTIAL_IN_REQUEST';
// This aggregate preflight must encompass the adapters' existing allowances:
// 32 WebSocket frames of up to 100000 JSON nodes each, up to 8 MiB of sends,
// and JSON depth 64 plus the containing input blocks. Each adapter still owns
// and enforces its tighter per-document, per-message and transport limits.
const MAX_NODES = 32 * 100000 + 10000, MAX_DEPTH = 66, MAX_BYTES = 16 * 1024 * 1024;

// One descriptor-only snapshot is both the credential check and the adapter's
// input. Never invoke payload accessors, serialization hooks or proxy traps;
// never let later caller mutation replace the checked values in saved evidence.
// Only credential-shaped field names are inspected, never credential values.
export function snapshotProtocolInputs(args) {
  const active = new Set();
  let nodes = 0, bytes = 0;
  const charge = text => { if ((bytes += Buffer.byteLength(text)) > MAX_BYTES) throw INVALID; };
  const clone = (value, depth, payload, block, direct = false) => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw INVALID;
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string') { charge(value); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    // Optional adapter options may be explicitly undefined; payload children
    // and array entries must still contain only explicit JSON values.
    if (value === undefined && direct) return value;
    if (!value || typeof value !== 'object' || types.isProxy(value) || active.has(value)) throw INVALID;
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype && prototype !== null
      : prototype !== Object.prototype && prototype !== null) throw INVALID;
    for (let parent = prototype; parent; parent = Object.getPrototypeOf(parent))
      if (Object.getOwnPropertyDescriptor(parent, 'toJSON')) throw INVALID;
    const keys = Reflect.ownKeys(value);
    if (keys.length + nodes > MAX_NODES) throw INVALID;
    let length;
    if (array) {
      length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES || keys.length !== length + 1) throw INVALID;
    }
    const snapshot = array ? [] : Object.create(null);
    active.add(value);
    for (const key of keys) {
      if (array && key === 'length') continue;
      if (typeof key !== 'string' || key === 'toJSON') throw INVALID;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw INVALID;
      if (array && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= length)) throw INVALID;
      if (payload && credentialName(key)) throw CREDENTIAL;
      if (!array) charge(key);
      const startsPayload = !payload && direct && payloadFields[block].has(key);
      snapshot[key] = clone(descriptor.value, startsPayload ? 0 : depth + 1, payload || startsPayload, block, depth === 0 && !payload);
    }
    active.delete(value);
    return Object.freeze(snapshot);
  };
  try {
    if (!args || typeof args !== 'object' || types.isProxy(args)) throw INVALID;
    const blocks = Object.create(null);
    for (const block of Object.keys(payloadFields)) {
      const descriptor = Object.getOwnPropertyDescriptor(args, block);
      if (descriptor && !Object.hasOwn(descriptor, 'value')) throw INVALID;
      blocks[block] = descriptor?.value === undefined ? undefined : clone(descriptor.value, 0, false, block, true);
    }
    // Account for JSON quoting and punctuation after the bounded clone. At
    // this point there are no accessors or hooks for serialization to execute.
    if (Buffer.byteLength(JSON.stringify(blocks)) > MAX_BYTES) throw INVALID;
    return { blocks: Object.freeze(blocks), problem: null };
  } catch (failure) {
    return { blocks: null, problem: failure === CREDENTIAL ? CREDENTIAL : INVALID };
  }
}

// Suites share the same refusal vocabulary without acquiring any execution or
// evidence-writing behavior. Callers that dispatch must retain the snapshot.
export function payloadCredentialProblem(args) { return snapshotProtocolInputs(args).problem; }
