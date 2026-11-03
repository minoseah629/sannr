import { createHash } from 'node:crypto';

// Equality witness for an authored request case. No raw value is returned or
// persisted here. Callers must omit credentials and unresolved/runtime values
// BEFORE hashing; authentication is compared separately by reference identity.
export function importCaseFingerprint({ path, params = {}, body, headers = {} }) {
  if (typeof path !== 'string' || !path || /\{\{/.test(path)) return null;
  let pathname, query;
  try {
    const url = new URL(path, 'https://import-case.invalid');
    pathname = url.pathname;
    // The client applies explicit params with URLSearchParams.set. Preserve
    // that behavior before refusing ambiguous duplicate authored URL keys.
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, String(value));
    const keys = [...url.searchParams.keys()];
    if (new Set(keys).size !== keys.length) return null;
    query = Object.fromEntries(url.searchParams);
  } catch { return null; }
  const lowered = {};
  for (const [key, value] of Object.entries(headers ?? {})) lowered[key.toLowerCase()] = String(value);
  const order = (value, depth = 0) => {
    if (depth > 32) throw new Error('case nesting limit');
    if (value && typeof value === 'object' && Object.hasOwn(value, 'toJSON')) throw new Error('case custom serialization');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('case non-JSON array');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('case sparse/accessor array');
        return order(descriptor.value, depth + 1);
      });
    }
    if (value && typeof value === 'object') {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.getOwnPropertySymbols(value).length) throw new Error('case non-JSON object');
      return Object.fromEntries(Object.keys(value).sort().map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new Error('case accessor');
        return [key, order(descriptor.value, depth + 1)];
      }));
    }
    throw new Error('case non-JSON value');
  };
  try {
    const value = { path: pathname, params: query, ...(body !== undefined ? { body } : {}), headers: lowered };
    return createHash('sha256').update(JSON.stringify(order(value))).digest('hex');
  } catch { return null; }
}
