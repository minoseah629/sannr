// Private, bounded inspection of an existing receipt. Never sends or replays.
// CLI and the paired browser share this contract; the service retains no body.
import { join, relative, isAbsolute, sep } from 'node:path';
import { stackScope } from './stacks.mjs';
import { evidenceDirectory } from './view-records.mjs';
import { openEvidenceRoot, readEvidenceBytes } from './note-evidence.mjs';
import { sanitizeEvidenceBody } from './response-redaction.mjs';
import { LAYOUT } from './layout.mjs';
const fail = code => { throw Object.assign(new Error('The private response could not be inspected safely.'), {
  code, next: 'Use a retained run ID in this repository. A clone does not contain private response evidence.',
}); };
// Curated diagnostic headers only. Cookie/auth/custom headers never enter the
// preview, even when inspecting an older receipt that retained their values.
const PREVIEW_HEADERS = new Set(['content-type', 'content-length', 'content-encoding', 'content-disposition',
  'cache-control', 'etag', 'last-modified', 'retry-after', 'location', 'link', 'x-request-id', 'x-correlation-id']);
const credentialHeader = name => /(?:authorization|cookie|token|secret|password|credential|api[-_]?key)/i.test(name);
function utf8Prefix(bytes, limit) {
  let end = Math.min(bytes.length, limit);
  // Do not manufacture a replacement character (or exceed the byte cap) by
  // cutting through a multi-byte code point in a private response.
  if (end < bytes.length) while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
function headerCandidates(raw) {
  const entries = raw && typeof raw === 'object' && !Array.isArray(raw) ? Object.entries(raw) : [];
  const headers = {}, counts = new Map(), credentials = [];
  for (const [key, value] of entries) {
    const name = key.toLowerCase(); counts.set(name, (counts.get(name) ?? 0) + 1);
    if (credentialHeader(name)) credentials.push(value);
    if (PREVIEW_HEADERS.has(name) && typeof value === 'string') headers[name] = value;
  }
  // Ambiguous case-variant duplicates in a hand-written receipt are withheld.
  for (const name of Object.keys(headers)) if (counts.get(name) !== 1) delete headers[name];
  return { headers, credentials, total: entries.length };
}
export function inspectRecordedResponse(root, { runId, stack = null } = {}) {
  if (typeof runId !== 'string' || !/^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) fail('EVIDENCE_ID_INVALID');
  const scope = stack ? stackScope(root, { stack }) : null;
  const dir = scope ? join(root, scope.evidenceDir) : evidenceDirectory(root);
  const part = relative(root, dir);
  if (!part || part === '..' || part.startsWith(`..${sep}`) || isAbsolute(part)) fail('EVIDENCE_ROOT_UNSAFE');
  const opened = openEvidenceRoot(dir);
  if (!opened) fail('EVIDENCE_MISSING');
  let record;
  try { record = JSON.parse(readEvidenceBytes(opened, `${runId}.json`, { maxBytes: 8 * 1024 * 1024 }).toString('utf8')); }
  catch (error) { fail(error.code === 'ENOENT' ? 'EVIDENCE_MISSING' : error.code?.startsWith('EVIDENCE_') ? error.code : 'EVIDENCE_INVALID_RECORD'); }
  if (!record || record.runId !== runId || !record.response || typeof record.response !== 'object') fail('EVIDENCE_INVALID_RECORD');
  const candidates = headerCandidates(record.response.headers);
  // Scan before truncation, jointly with the body: an opaque credential named
  // in the body or a withheld credential header may be echoed in an ETag. Signed
  // links use evidence masking, never the agent output's upload-URL exception.
  // Array slots cannot be renamed by the alias scrubber when a short credential
  // happens to equal a structural key such as "body" or "headers".
  const protectedResponse = sanitizeEvidenceBody([record.response.body ?? null,
    candidates.headers, { credentials: candidates.credentials }]);
  const dense = typeof protectedResponse.body === 'string';
  const body = JSON.stringify(dense ? protectedResponse.body : protectedResponse.body[0], null, 2);
  const bytes = Buffer.from(body);
  const limit = 32768;
  const bodyText = utf8Prefix(bytes, limit), headers = {};
  let truncatedHeaders = 0;
  for (const name of Object.keys(dense ? {} : candidates.headers)) {
    const value = protectedResponse.body[1][name];
    // If a header name itself matched a known secret, its masked substitute is
    // not a new allowlisted header. Count the original as omitted instead.
    if (typeof value !== 'string') continue;
    const valueBytes = Buffer.from(value);
    if (valueBytes.length > 1024) truncatedHeaders++;
    headers[name] = utf8Prefix(valueBytes, 1024);
  }
  return {
    run_id: runId, stack, source: 'private retained evidence', retention: 'read once; not retained by workbench service',
    status: Number.isInteger(record.response.status) ? record.response.status : null,
    duration_ms: typeof record.durationMs === 'number' && Number.isFinite(record.durationMs) && record.durationMs >= 0 ? record.durationMs : null,
    headers, headers_total: candidates.total, headers_omitted: candidates.total - Object.keys(headers).length,
    header_values_truncated: truncatedHeaders,
    body_available: Object.hasOwn(record.response, 'body'),
    body_unavailable_reason: Object.hasOwn(record.response, 'body') ? null : 'Body was not retained; binary responses may contain no text evidence.',
    body_text: bodyText, body_bytes: bytes.length, omitted_bytes: bytes.length - Buffer.byteLength(bodyText),
    redacted: true, recorded_redactions: record.response.body_secrets && {
      replaced: record.response.body_secrets.replaced === true,
      replacements: Number.isSafeInteger(record.response.body_secrets.replacements) && record.response.body_secrets.replacements >= 0 ? record.response.body_secrets.replacements : null,
    },
    inspection_redactions: protectedResponse.body_secrets,
    note: `This is private local response content from ${LAYOUT.evidence}; it is not shared knowledge or proof of a current integration. Credential masking does not remove all personal data.`,
  };
}
