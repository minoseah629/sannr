// Evidence stays local and masks returned credentials. Agent presentation uses
// that protection with an explicit reveal option and a narrow signed-URL exception.
// This uses the same scanner as authored notes. Withholding the whole affected
// string also covers scanner patterns that only recognize a credential prefix.
import { createHash, randomBytes } from 'node:crypto';
import { scanMetadataSecrets } from './verdicts.mjs';

const credentialKey = key => /(?:^|[_-])(?:secret|password|passwd|token|api[_-]?key|authorization|credential)s?$/i
  .test(key.replace(/([a-z])([A-Z])/g, '$1_$2'));
const scannerRejects = value => {
  try { scanMetadataSecrets(value); return false; } catch { return true; }
};

// A direct upload URL is an intentionally transferable, temporary capability.
// Only recognized AWS, Google and Azure signing tuples are exempt. Continue
// scanning the authority/path and every other parameter; evidence has no exemption.
function signedUrlRemainder(text) {
  if (!/^https:\/\//i.test(text) || /\s/.test(text)) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password || url.hash) return null;
  const params = new Map();
  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (params.has(lower)) return null;
    params.set(lower, { key, value });
  }
  const signing = ['x-amz', 'x-goog'].find(prefix => {
    const credential = params.get(`${prefix}-credential`)?.value;
    const signature = params.get(`${prefix}-signature`)?.value;
    if (!credential || !/^[a-f0-9]{16,}$/i.test(signature ?? '')) return false;
    return prefix === 'x-amz'
      ? /^[A-Za-z0-9]+\/\d{8}\/[a-z0-9-]+\/s3\/aws4_request$/.test(credential)
      : /^[a-z0-9._%+-]+@[a-z0-9.-]+\.gserviceaccount\.com\/\d{8}\/[^/]+\/storage\/goog4_request$/i.test(credential);
  });
  const signature = params.get('signature')?.value;
  const legacySignature = /^[A-Za-z0-9+/=_-]{16,}$/.test(signature ?? '');
  const awsLegacy = legacySignature && /^(?:(?:AKIA|ASIA)[A-Z0-9]{12,}|[a-f0-9]{32})$/.test(params.get('awsaccesskeyid')?.value ?? '');
  const googleLegacy = legacySignature && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.gserviceaccount\.com$/i.test(params.get('googleaccessid')?.value ?? '');
  const azure = /^[A-Za-z0-9+/=_-]{16,}$/.test(params.get('sig')?.value ?? '')
    && /^\d{4}-\d{2}-\d{2}$/.test(params.get('sv')?.value ?? '')
    && /^\d{4}-\d{2}-\d{2}T/.test(params.get('se')?.value ?? '')
    && /^[racwdlmeoputi]+$/.test(params.get('sp')?.value ?? '')
    && (/^[bcdf]$/.test(params.get('sr')?.value ?? '')
      || /^[bqtf]+$/.test(params.get('ss')?.value ?? '') && /^[sco]+$/.test(params.get('srt')?.value ?? ''));
  const exempt = new Set(signing ? [`${signing}-credential`, `${signing}-signature`,
    ...(signing === 'x-amz' ? ['x-amz-security-token'] : [])]
    : awsLegacy ? ['awsaccesskeyid', 'signature']
    : googleLegacy ? ['googleaccessid', 'signature'] : azure ? ['sig'] : []);
  if (!exempt.size) return null;
  for (const [key, { key: original, value }] of params) {
    if (exempt.has(key)) { url.searchParams.delete(original); continue; }
    if (credentialKey(key) && value || scannerRejects(key) || scannerRejects(value)) return null;
  }
  let remainder = url.href;
  try { remainder = decodeURIComponent(remainder); } catch { return null; }
  return scannerRejects(remainder) ? null : remainder;
}

function encodedValue(text) {
  // JSON-in-a-string and canonical UTF-8 base64 are common response wrappers.
  // Inspect decoded contents, but never turn opaque arbitrary bytes into text.
  try { return { value: JSON.parse(text) }; } catch { /* ordinary text */ }
  const match = /^(?:data:[^,\s]+;base64,)?([A-Za-z0-9+/]{8,}={0,2})$/.exec(text);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64'), decoded = bytes.toString('utf8');
  if (bytes.toString('base64').replace(/=+$/, '') !== match[1].replace(/=+$/, '')
    || !Buffer.from(decoded, 'utf8').equals(bytes)) return null;
  return { value: decoded };
}

function containsSecret(value, credential = false, depth = 0, presentation = false) {
  if (typeof value === 'string') {
    if (credential && value.length > 0) return true;
    if (presentation && signedUrlRemainder(value) !== null) return false;
    // Signed URLs are bearer credentials even under an innocent field such as
    // download_url. Withhold the entire string, including encoded query forms.
    if (/(?:[?&]|&amp;|%3f|%26)(?:x-amz-signature|x-goog-signature|signature|sig)(?:=|%3d)/i.test(value)) return true;
    if (scannerRejects(value) || credential && scannerRejects(`secret: ${value}`)) return true;
    const encoded = encodedValue(value);
    if (!encoded) return false;
    // Bound recursively wrapped encodings; withhold rather than silently skip.
    return depth >= 8 || containsSecret(encoded.value, credential, depth + 1, presentation);
  }
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => scannerRejects(key)
    || containsSecret(child, credential || credentialKey(key), depth, presentation));
}

/** Return a masked copy. The private random salt is never saved;
 * identical secrets can be compared within a record, never across runs. */
function sanitizeBody(body, { presentation = false, maskedKeys = new Map() } = {}) {
  const salt = randomBytes(32);
  let replacements = 0;
  const originals = new Set(), markers = new Set();
  const marker = value => {
    replacements++;
    if (typeof value === 'string') originals.add(value);
    const result = `[withheld: secret; salted-sha256:${createHash('sha256').update(salt).update(value).digest('hex')}]`;
    markers.add(result);
    return result;
  };
  const visit = (value, credential = false) => {
    if (typeof value === 'string') return containsSecret(value, credential, 0, presentation) ? marker(value) : value;
    if (Array.isArray(value)) return value.map(item => visit(item, credential));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      scannerRejects(key) ? (() => { const masked = marker(key); maskedKeys.set(key, masked); return masked; })() : key, visit(child, credential || credentialKey(key)),
    ]));
  };
  let value;
  if (Buffer.isBuffer(body)) {
    value = containsSecret(body.toString('utf8')) ? Buffer.from(marker(body), 'utf8') : body;
  } else {
    value = visit(body);
    // An opaque credential identified by its field can be echoed under an
    // innocent key or repeated in assertion details. Scrub those aliases too,
    // independent of property order, including their common encodings.
    const dense = originals.size > 128 || [...originals].reduce((sum, secret) => sum + secret.length, 0) > 65_536;
    const forms = dense ? [] : [...new Set([...originals].flatMap(secret => {
      const encoded = [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64')];
      try { encoded.push(encodeURIComponent(secret)); } catch { /* a lone surrogate is not URI-encodable */ }
      return encoded;
    }))];
    const copies = node => {
      if (typeof node === 'string') {
        const inspected = presentation ? signedUrlRemainder(node) ?? node : node;
        return !markers.has(node) && forms.some(secret => inspected.includes(secret)) ? marker(node) : node;
      }
      if (Array.isArray(node)) return node.map(copies);
      if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([key, child]) => {
        const masked = copies(key); if (masked !== key) maskedKeys.set(key, masked);
        return [masked, copies(child)];
      }));
      return node;
    };
    // Keep alias scanning bounded for adversarial responses with thousands of
    // unique credentials. Withhold the whole body instead of skipping aliases.
    if (dense) value = marker(JSON.stringify(body));
    else if (forms.length) value = copies(value);
  }
  return { body: value, body_secrets: { replaced: replacements > 0, replacements,
    ...(replacements ? { hash: 'salted-sha256' } : {}) } };
}

export function sanitizeEvidenceBody(body) { return sanitizeBody(body); }

// Snapshot only changes made by this call's masks, never marker-looking provider
// text. Selection happens before this helper; later budget trims can only remove
// paths (or shorten a masked string). No paths or values enter the public receipt.
export function dataSecretsTracker(original, shown, maskKey = key => key) {
  const changed = [], seen = new Set();
  const add = (path, value, key = false) => {
    const id = JSON.stringify([path, key]);
    if (!seen.has(id)) { changed.push({ path, value, key }); seen.add(id); }
  };
  const walk = (before, after, path) => {
    if (typeof after === 'string') {
      if (before !== after) add(path, after);
    } else if (before && after && typeof before === 'object' && typeof after === 'object') {
      for (const [key, value] of Object.entries(before)) {
        const target = Array.isArray(before) ? key : maskKey(key);
        if (!Object.hasOwn(after, target)) continue;
        const next = [...path, target];
        if (target !== key) add(next, after[target], true);
        walk(value, after[target], next);
      }
    }
  };
  walk(original, shown, []);
  return data => {
    if (data === null || data === undefined) return undefined;
    let replacements = 0;
    for (const change of changed) {
      let value = data, found = true;
      for (const key of change.path) {
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) { found = false; break; }
        value = value[key];
      }
      if (found && (change.key || value === change.value || typeof value === 'string'
        && value.endsWith('…') && change.value.startsWith(value.slice(0, -1)))) replacements++;
    }
    return replacements ? { replacements, reveal: 'reveal_secrets' } : undefined;
  };
}

export function setDataSecrets(result, tracker) {
  const receipt = tracker?.(result.data);
  if (receipt) result.data_secrets = receipt;
  else delete result.data_secrets;
  return result;
}

// Scan the complete response before projection so a credential echoed under an
// innocent key stays protected even when its credential-named key is omitted.
// Assertions execute against the original; only their presentation is copied.
export function sanitizeResponsePresentation(body, assertions) {
  const maskedKeys = new Map();
  const protectedResponse = sanitizeBody({ body, assertions }, { presentation: true, maskedKeys });
  const maskKey = key => maskedKeys.get(key) ?? key;
  if (typeof protectedResponse.body !== 'string') return { ...protectedResponse.body, maskKey };
  // The evidence scanner bounds dense secret aliases by withholding the whole
  // container. Keep assertion counts truthful when it takes that path.
  return { body: protectedResponse.body, maskKey, assertions: assertions ? {
    passed: assertions.passed, failed: assertions.failed, failures: [],
    details_withheld: protectedResponse.body,
  } : assertions };
}
