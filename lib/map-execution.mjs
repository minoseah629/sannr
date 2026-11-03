// Explicit visualization reads. Planning is local; every eligible target is
// announced before the client is imported or the first request is dispatched.
import { readContract, operationsFrom } from './context.mjs';
import { findSurfaces } from './audit.mjs';
import { resolveConfig } from './config.mjs';
import { apiMapStackScopes } from './api-map.mjs';
import { redactMetadataSecrets } from './verdicts.mjs';

export function planMapReads(root, { environment, includeFixtures = false, limit = 40 } = {}) {
  const scopes = apiMapStackScopes(root, { environment });
  const sources = scopes.length ? scopes.map(scope => ({ root, scope, name: scope.stack, config: scope.config }))
    : findSurfaces(root, { includeFixtures }).map(surface => ({ root: surface.dir, name: surface.name,
      config: resolveConfig(surface.dir, { environment }), contract: surface.contract }));
  const reads = [], omitted = [];
  for (const source of sources) {
    const { config, scope } = source;
    const counts = new Map();
    const omit = reason => counts.set(reason, (counts.get(reason) ?? 0) + 1);
    const contract = scope ? config.contract : source.contract ?? config.contract;
    if (config.problems?.length) throw Object.assign(new Error('A map request configuration is invalid; no requests were sent.'), { code: config.problems[0].code });
    if (!contract || !config.baseUrl || config.baseUrlSource === 'fallback') { omit(!contract ? 'no-bound-contract' : 'no-configured-target'); }
    else {
      let url;
      try { url = new URL(config.baseUrl); } catch { /* rejected below */ }
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
        throw Object.assign(new Error('A map target needs a plain configured HTTP(S) base URL; no requests were sent.'), { code: 'MAP_TARGET_INVALID' });
      const { doc } = readContract(contract);
      const seen = new Set(); let eligible = 0;
      for (const operation of operationsFrom(doc)) {
        if (seen.has(operation.op)) continue; seen.add(operation.op);
        if (!['GET', 'HEAD'].includes(operation.method)) { omit('not-a-safe-read'); continue; }
        if (operation.path.includes('{')) { omit('unresolved-path-parameters'); continue; }
        if (!operation.path.startsWith('/') || operation.path.startsWith('//') || /[\s?#\\]/.test(operation.path)) { omit('unsupported-path'); continue; }
        if (String(config.auth ?? '').startsWith('oauth:')) { omit('oauth-grant-requires-explicit-request'); continue; }
        if (eligible++ >= limit) { omit('read-limit'); continue; }
        reads.push({ ...source, method: operation.method, path: operation.path,
          target: { ...(scope ? { stack: scope.stack } : { service: source.name }), environment: config.name ?? null,
            method: operation.method, path: operation.path, base_url: config.baseUrl,
            base_url_source: config.baseUrlOverride ? 'API_BASE_URL' : config.baseUrlSource === 'config' ? 'environment' : config.baseUrlSource } });
      }
    }
    for (const [reason, count] of counts) omitted.push({ ...(scope ? { stack: scope.stack } : { service: source.name }), reason, count });
  }
  return { reads, announcement: redactMetadataSecrets({ code: 'MAP_PROBE_PLAN', count: reads.length,
    targets: reads.map(row => row.target), omitted, policy: 'Declared GET/HEAD only; no retries, redirects, OAuth grants or inferred identifiers.' }) };
}

export async function executeMapReads(root, { command = 'map', announce = value => new Promise((resolve, reject) => process.stderr.write(`${JSON.stringify(value)}\n`, error => error ? reject(error) : resolve())), ...options } = {}) {
  if (!['map', 'view'].includes(command)) throw new TypeError('Unknown visualization command.');
  const { reads, announcement } = planMapReads(root, options);
  await announce(announcement);
  const { apiMapRead, transportError } = reads.length ? await import('./client.mjs') : {};
  const requests = [];
  for (const read of reads) {
    let attempts = 0, result;
    try { result = await apiMapRead({ root: read.root, scope: read.scope, config: read.config, method: read.method,
      path: read.path, onAttempt: () => { attempts++; }, command }); }
    catch (error) { result = { error: { code: transportError(error).code } }; }
    requests.push(redactMetadataSecrets({ ...read.target, attempts, status: result.status ?? null,
      evidence: result.evidence ?? null, assertions: result.assertions ? { passed: result.assertions.passed, failed: result.assertions.failed } : null,
      ...(result.error?.code ? { refusal: result.error.code } : {}) }));
  }
  return { planned: reads.length, attempted: requests.reduce((n, row) => n + row.attempts, 0),
    responses: requests.filter(row => Number.isInteger(row.status)).length, omitted: announcement.omitted, requests };
}
