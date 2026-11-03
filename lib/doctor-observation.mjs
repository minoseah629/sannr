// Doctor observations are local onboarding evidence, never repository API
// contract knowledge. Retain the first and latest small receipts, not payloads.
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LAYOUT, ensureLayout } from './layout.mjs';
import { safeOutputPath, writeOutputFile } from './output-path.mjs';
import { terminalText } from './terminal.mjs';

export const ONBOARDING_OBSERVATION_PATH = join(LAYOUT.evidence, 'onboarding.json');
const MAX_BYTES = 32768;
const NUMERIC_HEADERS = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-used',
  'x-ratelimit-reset', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset'];
const fail = code => { throw Object.assign(new Error('The local onboarding observation could not be safely recorded or read.'), { code }); };

export function doctorTargetUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[invalid HTTP(S) URL]';
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of new Set(url.searchParams.keys())) url.searchParams.set(key, '[redacted]');
    const shown = url.toString();
    return terminalText(url.pathname === '/' && !url.search && !String(value).endsWith('/')
      ? shown.replace(/\/$/, '') : shown);
  } catch { return '[invalid HTTP(S) URL]'; }
}

export function probeRateHeaders(headers) {
  const get = name => typeof headers?.get === 'function' ? headers.get(name) : headers?.[name];
  const out = {};
  for (const name of NUMERIC_HEADERS) {
    const value = get(name);
    if (value != null) out[name] = /^\d{1,16}$/.test(value) ? String(value) : '[withheld]';
  }
  const retry = get('retry-after');
  if (retry != null) out['retry-after'] = /^\d{1,16}$/.test(retry)
    || /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(retry)
    ? String(retry) : '[withheld]';
  const resource = get('x-ratelimit-resource');
  if (resource != null) out['x-ratelimit-resource'] = ['core', 'search', 'graphql', 'integration_manifest', 'code_search'].includes(resource)
    ? resource : '[withheld]';
  return out;
}

function observation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.purpose !== 'onboarding' || value.repo_contract !== null
    || value.authentication !== 'not_sent' || value.assertions !== 'not_run'
    || !['default', 'override', 'configured'].includes(value.target_source)
    || !['HEAD', 'GET'].includes(value.method) || !Number.isFinite(Date.parse(value.observed_at))
    || !Number.isInteger(value.status) || value.status < 100 || value.status > 599
    || value.http_ok !== (value.status >= 200 && value.status < 300)
    || !Number.isSafeInteger(value.duration_ms) || value.duration_ms < 0
    || typeof value.url !== 'string' || value.url.length > 2048 || doctorTargetUrl(value.url) !== value.url
    || !/^run-[a-f0-9-]{36}$/.test(value.evidence_id ?? '')) fail('ONBOARDING_OBSERVATION_INVALID');
  let provider;
  try { provider = new URL(value.url).origin; } catch { fail('ONBOARDING_OBSERVATION_INVALID'); }
  if (provider !== value.provider) fail('ONBOARDING_OBSERVATION_INVALID');
  const headers = probeRateHeaders(value.rate_limit_headers);
  if (JSON.stringify(headers) !== JSON.stringify(value.rate_limit_headers)) fail('ONBOARDING_OBSERVATION_INVALID');
  return { purpose: 'onboarding', observed_at: value.observed_at, target_source: value.target_source,
    provider, method: value.method, url: value.url, status: value.status, http_ok: value.http_ok,
    duration_ms: value.duration_ms, rate_limit_headers: headers, evidence_id: value.evidence_id,
    authentication: 'not_sent', assertions: 'not_run', repo_contract: null };
}

function readRecord(root) {
  const file = safeOutputPath(join(root, ONBOARDING_OBSERVATION_PATH), { code: 'ONBOARDING_OBSERVATION_UNSAFE' });
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) fail('ONBOARDING_OBSERVATION_INVALID');
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_BYTES) fail('ONBOARDING_OBSERVATION_INVALID');
    const record = JSON.parse(bytes.subarray(0, count).toString('utf8'));
    if (record?.v !== 1 || record.purpose !== 'onboarding') fail('ONBOARDING_OBSERVATION_INVALID');
    return { v: 1, purpose: 'onboarding', first: observation(record.first), latest: observation(record.latest) };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code?.startsWith('ONBOARDING_')) throw error;
    fail('ONBOARDING_OBSERVATION_INVALID');
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function queryDoctorObservation(root) {
  const record = readRecord(root);
  return { v: 1, scope: 'onboarding', state: record ? 'recorded' : 'missing',
    path: ONBOARDING_OBSERVATION_PATH,
    meaning: 'Saved client observations only; no request, authentication check, or API assertion runs during retrieval. Evidence IDs identify the original local client runs; current API behavior and evidence-file availability are not rechecked.',
    ...(record ? { first: record.first, latest: record.latest } : { missing_reason: 'record_absent' }) };
}

/** Render only the validated metadata projection; never reopen request evidence
 * or reconstruct the full doctor output from an earlier conversation. */
export function renderDoctorObservation(receipt) {
  if (receipt?.v !== 1 || receipt.scope !== 'onboarding'
    || !['recorded', 'missing'].includes(receipt.state)) fail('ONBOARDING_OBSERVATION_INVALID');
  const lines = ['Saved onboarding observations (historical).'];
  if (receipt.state === 'missing') {
    lines.push('No saved onboarding observation is available.',
      'First and latest observations are unavailable. Offline setup does not create a probe observation.',
      'The saved record does not explain its absence; retrieval cannot distinguish a skipped or failed probe, failed save, or removed record.');
  } else {
    for (const [label, value] of [['First', receipt.first], ['Latest', receipt.latest]]) {
      const saved = observation(value);
      const rates = Object.entries(saved.rate_limit_headers).map(([key, value]) => `${key}=${value}`);
      lines.push(`${label}: ${new Date(saved.observed_at).toISOString()}`,
        `  Target: ${saved.method} ${saved.url} (source: ${saved.target_source}; provider: ${saved.provider})`,
        `  HTTP: ${saved.status} (${saved.http_ok ? '2xx response' : 'non-2xx response'}); latency: ${saved.duration_ms} ms`,
        `  Rate limits: ${rates.length ? rates.join('; ') : 'not recorded'}`,
        `  Evidence: ${saved.evidence_id}`);
    }
    lines.push('Saved probe scope: authentication not_sent; assertions not_run; repository contract: none.');
  }
  lines.push('Retrieval executed 0 requests; no authentication check or API assertion ran.',
    'Current API behavior and evidence-file availability were not rechecked. This is not a full doctor report.');
  return lines.join('\n');
}

export function recordDoctorObservation(root, input) {
  const next = observation(input);
  const file = safeOutputPath(join(root, ONBOARDING_OBSERVATION_PATH), { code: 'ONBOARDING_OBSERVATION_UNSAFE' });
  const lock = safeOutputPath(`${file}.lock`, { code: 'ONBOARDING_OBSERVATION_UNSAFE' });
  ensureLayout(root);
  mkdirSync(dirname(file), { recursive: true });
  let fd, temp;
  try {
    try { fd = openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code === 'EEXIST') fail('ONBOARDING_OBSERVATION_LOCKED'); throw error; }
    const prior = readRecord(root);
    const record = { v: 1, purpose: 'onboarding', first: prior?.first ?? next, latest: next };
    const text = JSON.stringify(record, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES) fail('ONBOARDING_OBSERVATION_INVALID');
    temp = join(dirname(file), `.onboarding-${randomUUID()}.tmp`);
    writeOutputFile(temp, text, { mode: 0o600, code: 'ONBOARDING_OBSERVATION_UNSAFE' });
    safeOutputPath(file, { code: 'ONBOARDING_OBSERVATION_UNSAFE' });
    renameSync(temp, file);
    return { state: 'recorded', path: ONBOARDING_OBSERVATION_PATH, evidence_id: next.evidence_id };
  } catch (error) {
    if (error.code?.startsWith('ONBOARDING_')) throw error;
    fail('ONBOARDING_OBSERVATION_WRITE_FAILED');
  } finally {
    if (temp) rmSync(temp, { force: true });
    if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); }
  }
}
