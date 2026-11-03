// Report identities are independent of render order and HTML selectors. Only a
// stored canonical operation key is accepted: never derive a route from a URL
// or guess which literal segment was an input. Invalid/withheld keys have no
// anchor. The hash includes the named stack (null means the legacy store).
import { createHash } from 'node:crypto';
import { secretIn } from './verdicts.mjs';

export function operationAnchor({ stack = null, operation, method } = {}) {
  if (stack !== null && (typeof stack !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(stack))) return null;
  if (typeof operation !== 'string' || operation.length > 512 || secretIn(operation)) return null;
  const match = /^([A-Za-z]{1,16}) (\/[^\s?#\\]*)$/u.exec(operation);
  if (!match || /[\p{Cc}\p{Cf}]/u.test(operation) || match[2].startsWith('//')) return null;
  const verb = match[1].toUpperCase();
  if (method != null && String(method).toUpperCase() !== verb) return null;
  return `operation-${createHash('sha256').update(JSON.stringify([1, stack, verb, match[2]])).digest('hex')}`;
}

// Standalone reports can link only to a relative, local HTML report. Keeping
// this check at the rendering seam also protects callers other than the CLI.
export function relativeViewHref(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || secretIn(value)
    || /^[\/\\]/.test(value) || /[\\:?#\p{Cc}\p{Cf}]/u.test(value) || !/\.html?$/i.test(value)) return null;
  // Encoded separators, schemes and controls are not a second path syntax.
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return null; }
  if (decoded !== value && (/^[\/\\]/.test(decoded) || /[\\:?#\p{Cc}\p{Cf}]/u.test(decoded) || secretIn(decoded))) return null;
  return value.split('/').map(part => encodeURIComponent(decodeURIComponent(part))).join('/');
}
