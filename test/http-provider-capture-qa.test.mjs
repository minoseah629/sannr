import { LAYOUT } from "../lib/layout.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdtempSync, realpathSync, readFileSync,  rmSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStackScope } from '../lib/stack-scope.mjs';
import { resolveStack } from '../lib/stacks.mjs';
import { existsSync } from 'node:fs';
import { queryOperationContext } from '../lib/operation-context.mjs';
import { exportGraphSnapshot } from '../lib/graph-export.mjs';
import { graphContext } from '../lib/agent-graph-context.mjs';

const clientUrl = new URL('../lib/client.mjs', import.meta.url).href;
const runFile = promisify(execFile);
const save = (root, path, data) => writeFileSync(join(root, path), JSON.stringify(data));
const sha = data => `sha256:${createHash('sha256').update(JSON.stringify(data)).digest('hex')}`;
const spec = (title, paths = { '/items/{itemId}': { get: {} } }) => ({
  openapi: '3.0.0', info: { title, version: '1' }, paths,
});

function directory(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sannr-provider-qa-')));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  return root;
}

async function fixture(t, reply, { legacy = false } = {}) {
  const root = directory(t), calls = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url, method: req.method, authorization: req.headers.authorization, headers: { ...req.headers } });
    if (reply?.(req, res)) return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ item: 'response-value-private', location: req.url }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const primary = spec('primary'), alpha = spec('alpha'), beta = spec('beta');
  save(root, 'primary.json', primary); save(root, 'alpha.json', alpha); save(root, 'beta.json', beta);
  const config = { v: 1, default: 'local', environments: {
    local: { baseUrl: origin, contract: 'primary.json' },
  }, hosts: {
    alpha: { baseUrl: `${origin}/alpha`, contract: 'alpha.json', contractPathPrefix: '/alpha', auth: 'bearer:QA_ALPHA_KEY' },
    beta: { baseUrl: `${origin}/beta`, contract: 'beta.json', contractPathPrefix: '/beta', auth: 'bearer:QA_BETA_KEY' },
  } };
  save(root, LAYOUT.environments, config);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(API_|SANNR_|QA_)/.test(key)) delete env[key];
  Object.assign(env, { API_CONFIG: join(root, LAYOUT.environments), API_CONTEXT_DIR: root,
    API_EVIDENCE: join(root, 'evidence'), API_USAGE_LOG: join(root, 'usage.jsonl'),
    API_FRICTION_OFF: '1', API_CONTEXT_OFF: '0', API_BUDGET: '6000',
    SANNR_HOME: join(root, 'home'), QA_ALPHA_KEY: 'alpha-credential-private', QA_BETA_KEY: 'beta-credential-private' });
  // Existing host-security controls stay legacy on purpose; capture controls
  // use separate stack documents and therefore separate committed ledgers.
  const stackNames = new Set(['primary']);
  const syncStacks = () => {
    if (legacy) return;
    const source = JSON.parse(readFileSync(join(root, LAYOUT.environments), 'utf8'));
    const convert = value => {
      const { hosts, ...environment } = value;
      if (environment.contract) environment.contract = `../../../${environment.contract}`;
      return environment;
    };
    save(root, `${LAYOUT.collection}/primary/stack.json`, { v:1, name:'primary', default_environment:source.default,
      environments:Object.fromEntries(Object.entries(source.environments).map(([name,value]) => [name,convert(value)])) });
    save(root, `${LAYOUT.directory}/defaults.json`, { default_stack:'primary' });
    for (const name of new Set([...Object.keys(source.hosts ?? {}), ...Object.values(source.environments).flatMap(value => Object.keys(value.hosts ?? {}))])) {
      stackNames.add(name);
      const environments = Object.fromEntries(Object.entries(source.environments).flatMap(([environment,value]) => {
        const binding = value.hosts?.[name] ?? source.hosts?.[name];
        return binding ? [[environment,convert(binding)]] : [];
      }));
      save(root, `${LAYOUT.collection}/${name}/stack.json`, {v:1,name,default_environment:source.default,environments});
    }
  };
  const request = async (requests, overrides = {}, cwd = root) => {
    syncStacks();
    if (!legacy) requests = requests.map(args => args.stack || args.upstream ? args : {stack:'primary',...args});
    const script = `const { apiRequest } = await import(${JSON.stringify(clientUrl)});
      const results = []; for (const args of ${JSON.stringify(requests)}) results.push(await apiRequest(args));
      process.stdout.write(JSON.stringify(results));`;
    const child = await runFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 20000, maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(child.stdout);
  };
  const observations = query => legacy
    ? queryOperationContext(root, { protocol: 'http', ...query }, { env, maxBytes:64000 }).operations
    : [...stackNames].flatMap(stack => withStackScope(resolveStack(root,{stack,environment:query?.environment ?? 'local'}),
      () => queryOperationContext(root,{protocol:'http',...query},{env,maxBytes:64000}).operations));
  const contextFiles = () => legacy ? [join(root,LAYOUT.context)] : [...stackNames].map(name => join(root,LAYOUT.collection,name,'sannr.json'));
  const contextText = () => contextFiles().filter(existsSync).map(path=>readFileSync(path,'utf8')).join('\n');
  const privateRecord = (result, page = '') => JSON.parse(readFileSync(join(root, 'evidence', `${result.evidence}${page}.json`), 'utf8'));
  return { root, origin, config, env, calls, request, observations, primary, alpha, beta, contextText, privateRecord };
}

test('QA: identical integration routes stay provider-scoped and survive portable export without payloads or writer files', async t => {
  const f = await fixture(t);
  const foreignCwd = directory(t);
  const results = await f.request([
    { path: '/items/primary-path-private' },
    { upstream: 'alpha', path: '/items/alpha-path-private', params: { search: 'query-value-private' }, expect: [{ status: 200 }] },
    { upstream: 'beta', path: '/items/beta-path-private' },
  ], {}, foreignCwd);
  assert.ok(results.every(result => result.context_capture?.state === 'captured'), JSON.stringify(results));
  const operations = f.observations({ operation: 'GET /items/{itemId}', environment: 'local' });
  assert.equal(operations.length, 3);
  for (const [suffix, contract] of [['', f.primary], ['/alpha', f.alpha], ['/beta', f.beta]]) {
    const [entry] = operations.filter(item => item.identity.provider === `${f.origin}${suffix}`);
    assert.ok(entry, `Missing actual provider ${suffix || 'primary'}`);
    assert.equal(entry.identity.endpoint, `${f.origin}${suffix}/items/{itemId}`);
    assert.equal(entry.identity.contractDigest, sha(contract));
    assert.equal(entry.observations.length, 1);
    assert.equal(entry.observations[0].verification, 'client-observation');
    assert.equal(entry.observations[0].evidence[0].state, 'matching');
  }
  assert.equal(f.calls[1].authorization, 'Bearer alpha-credential-private');
  assert.equal(f.calls[2].authorization, 'Bearer beta-credential-private');
  assert.doesNotMatch(f.contextText(), /(?:path|query-value|response-value|credential)-private/);

  const providers = ['', '/alpha', '/beta'].map((suffix, index) => ({
    node: `qa/provider-${index}#api`, provider: `${f.origin}${suffix}`, environment: 'local', protocol: 'http',
  }));
  const manifest = { v: 1, repository: { id: 'qa/writer', name: 'Writer' },
    nodes: [{ id: 'ui', kind: 'component', name: 'UI' }],
    dependencies: providers.map(provider => ({ from: 'ui', to: provider.node, kind: 'calls',
      protocol: 'http', environment: 'local', operations: ['GET /items/{itemId}'] })), context: { providers } };
  save(f.root, LAYOUT.graphManifest, manifest);
  // Export remains a legacy-reader control until STACKS-2. Materialize a saved
  // historical projection from the synthetic per-stack records, with no request.
  const records = Object.assign({}, ...['primary','alpha','beta'].map(name =>
    JSON.parse(readFileSync(join(f.root, LAYOUT.collection, name, 'sannr.json'), 'utf8')).api_context.operations));
  save(f.root, LAYOUT.context, { v:0, api:{}, operations:{}, api_context:{v:1,operations:records} });
  const snapshot = exportGraphSnapshot(f.root);
  assert.equal(snapshot.knowledge.length, 3);
  const reader = directory(t);
  save(reader, 'writer.json', snapshot);
  save(reader, LAYOUT.graphManifest, { ...manifest, repository: { id: 'qa/reader', name: 'Reader' }, catalog: 'writer.json', context: {} });
  const priorIds = snapshot.knowledge.map(item => item.id).sort();
  const requestCount = f.calls.length;
  rmSync(f.root, { recursive: true, force: true });
  const retrieved = await graphContext(reader, { action: 'context', response_format: 'detailed', operation: 'GET /items/{itemId}', environment: 'local', max_bytes: 64000, include_foreign_claims: true });
  assert.equal(retrieved.ok, true, JSON.stringify(retrieved));
  assert.equal(retrieved.requests_executed, 0);
  assert.equal(f.calls.length, requestCount);
  assert.equal(retrieved.knowledge.length, 0, 'writer observations about provider nodes require their own opted-in section');
  assert.deepEqual(retrieved.foreign_claims.map(item => item.id).sort(), priorIds);
  assert.deepEqual(retrieved.foreign_claims.map(item => item.node).sort(), providers.map(item => item.node).sort());
  assert.ok(retrieved.foreign_claims.every(item => item.evidence.every(ref => ref.state === 'unavailable')));
  assert.ok(retrieved.foreign_claims.every(item => item.basis !== 'observed' && item.verification === 'external-claim' && item.source.verification === 'external-claim'));
  assert.doesNotMatch(JSON.stringify(retrieved), /(?:path|query-value|response-value|credential)-private/);
  assert.ok(!JSON.stringify(retrieved).includes(f.root));
});

test('QA: named upstream labels and redirects cannot misattribute the actual response provider', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/alpha/redirect') {
      res.writeHead(302, { location: '/beta/items/redirect-path-private' }); res.end(); return true;
    }
  }, { legacy:true });
  const results = await f.request([
    { upstream: 'alpha', path: '/../beta/items/traversal-path-private' },
    { upstream: 'alpha', path: '/redirect' },
  ]);
  assert.ok(results.every(result => result.context_capture?.code === 'STACKS_MIGRATION_REQUIRED'), JSON.stringify(results));
  const entries = f.observations();
  assert.equal(entries.length, 0, 'Legacy response-provider routing must not write shared knowledge');
  for (const result of results) {
    const scope = f.privateRecord(result).origin.scope;
    assert.equal(scope.provider, `${f.origin}/beta`);
    assert.equal(scope.contract_digest, sha(f.beta));
    assert.equal(scope.operation, 'GET /items/{itemId}');
  }
  assert.doesNotMatch(f.contextText(), /traversal-path-private|redirect-path-private/);
  assert.deepEqual(f.calls.map(call => call.url), [
    '/beta/items/traversal-path-private', '/alpha/redirect', '/beta/items/redirect-path-private',
  ]);
  assert.equal(f.calls[0].authorization, 'Bearer beta-credential-private');
  assert.notEqual(f.calls[2].authorization, 'Bearer alpha-credential-private', 'A redirect must not forward the original provider credential into another configured path scope.');
  assert.equal(f.contextText(), '', 'Legacy requests leave committed API knowledge untouched');
});

test('QA: selected environments keep integration bindings, contract digests and observations separate', async t => {
  const f = await fixture(t);
  const staging = spec('alpha staging'); save(f.root, 'alpha-staging.json', staging);
  f.config.environments.staging = { baseUrl: f.origin, contract: 'primary.json', hosts: {
    alpha: { baseUrl: `${f.origin}/alpha-staging`, contract: 'alpha-staging.json', contractPathPrefix: '/alpha-staging' },
  } };
  save(f.root, LAYOUT.environments, f.config);
  const local = await f.request([{ upstream: 'alpha', path: '/items/local-path-private' }]);
  const staged = await f.request([{ upstream: 'alpha', path: '/items/staging-path-private' }], { API_ENV: 'staging' });
  assert.equal(local[0].context_capture?.state, 'captured', JSON.stringify(local));
  assert.equal(staged[0].context_capture?.state, 'captured', JSON.stringify(staged));
  assert.equal(f.observations({ environment: 'local' }).length, 1);
  const [entry] = f.observations({ environment: 'staging' });
  assert.ok(entry);
  assert.equal(entry.identity.provider, `${f.origin}/alpha-staging`);
  assert.equal(entry.identity.contractDigest, sha(staging));
  assert.equal(entry.identity.operation, 'GET /items/{itemId}');
  assert.equal(f.observations({ provider: `${f.origin}/alpha`, environment: 'staging' }).length, 0);
});

test('QA: unmatched, ambiguous and unbound integrations cannot borrow a primary declaration or leak literal paths', async t => {
  const f = await fixture(t);
  const ambiguous = spec('ambiguous', { '/items/{first}': { get: {} }, '/items/{second}': { get: {} } });
  save(f.root, 'ambiguous.json', ambiguous);
  f.config.hosts.alpha.contract = 'ambiguous.json';
  delete f.config.hosts.beta.contract;
  f.config.hosts.alpha12 = { baseUrl: `${f.origin}/alpha12` };
  save(f.root, LAYOUT.environments, f.config);
  const results = await f.request([
    { upstream: 'alpha', path: '/items/ambiguous-path-private' },
    { upstream: 'beta', path: '/items/unbound-path-private', capture_context: true },
    { upstream:'alpha12', path: '/items/segment-path-private' },
    { upstream: 'alpha', path: '/shadow/undeclared-path-private' },
  ]);
  assert.ok(results.every(result => result.ok === true), JSON.stringify(results));
  assert.ok(results.every(result => ['limited','skipped'].includes(result.context_capture?.state)), JSON.stringify(results));
  assert.ok(results.every(result => ['HTTP_CONTEXT_ROUTE_UNRESOLVED','CONTRACT_NOT_BOUND'].includes(result.context_capture?.code)), JSON.stringify(results));
  assert.equal(f.observations().length, 0);
  assert.ok(results.every(result => result.known == null));
});

test('QA: an ambient primary base override cannot redirect a selected stack while an explicit integration remains capturable', async t => {
  const f = await fixture(t);
  const results = await f.request([
    { path: '/items/overridden-path-private', capture_context: true },
    { upstream: 'beta', path: '/items/bound-path-private' },
  ], { API_BASE_URL: `${f.origin}/overridden` });
  assert.equal(results[0].context_capture?.state, 'captured', JSON.stringify(results));
  assert.equal(results[0].context_capture.identity.provider, f.origin);
  assert.equal(results[1].context_capture?.state, 'captured', JSON.stringify(results));
  const entries = f.observations();
  assert.equal(entries.length, 2);
  const beta = entries.find(entry => entry.identity.provider === `${f.origin}/beta`);
  assert.ok(beta);
  assert.equal(beta.identity.contractDigest, sha(f.beta));
});

test('QA: pagination cannot cross a same-origin provider boundary or mix its evidence into the first provider', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/alpha/items/collection-path-private') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ alpha: 'alpha-row-private' }], next: '/beta/items/other-provider-private' }));
      return true;
    }
    if (req.url === '/beta/items/other-provider-private') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ results: [{ betaOnly: 'beta-row-private' }], next: null }));
      return true;
    }
  });
  const [result] = await f.request([{ upstream: 'alpha', path: '/items/collection-path-private', paginate: { max_pages: 4 } }]);
  assert.equal(f.calls.length, 1, 'An alpha next link must not execute a request in beta scope.');
  assert.equal(result.discovery.pages.fetched, 1);
  assert.equal(result.discovery.pages.complete, false);
  assert.ok(result.discovery.pages.stopped_early, 'The provider-boundary stop must be visible.');
  const [entry] = f.observations();
  assert.equal(entry.identity.provider, `${f.origin}/alpha`);
  assert.equal(entry.observations[0].complete, false);
  assert.equal(entry.observations[0].outcome, 'partial');
  assert.doesNotMatch(JSON.stringify(entry), /betaOnly|alpha-row-private|beta-row-private/);
});

test('QA: legacy pagination after a redirect resolves relative links and private evidence against the final provider', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/alpha/redirect-collection') {
      res.writeHead(302, { location: '/beta/items/collection-path-private' }); res.end(); return true;
    }
    if (req.url === '/beta/items/collection-path-private' || req.url === '/beta/items/collection-path-private?page=2') {
      res.writeHead(200, { 'content-type': 'application/json', ...(!req.url.includes('?') ? { link: '<?page=2>; rel="next"' } : {}) });
      res.end(JSON.stringify({ results: [{ betaOnly: 'beta-row-private' }] }));
      return true;
    }
  }, { legacy:true });
  const [result] = await f.request([{ upstream: 'alpha', path: '/redirect-collection', paginate: { max_pages: 4 } }]);
  assert.deepEqual(f.calls.map(call => call.url), [
    '/alpha/redirect-collection', '/beta/items/collection-path-private', '/beta/items/collection-path-private?page=2',
  ]);
  assert.ok(f.calls.slice(1).every(call => call.authorization !== 'Bearer alpha-credential-private'));
  assert.equal(result.context_capture?.code, 'STACKS_MIGRATION_REQUIRED', JSON.stringify(result));
  assert.equal(result.discovery.pages.complete, true);
  assert.equal(result.discovery.pages.fetched, 2);
  assert.equal(f.observations().length, 0, 'Legacy redirected pages remain private evidence only');
  for (const page of ['', '-p2']) {
    const scope = f.privateRecord(result, page).origin.scope;
    assert.equal(scope.provider, `${f.origin}/beta`);
    assert.equal(scope.contract_digest, sha(f.beta));
    assert.equal(scope.operation, 'GET /items/{itemId}');
  }
  assert.equal(f.contextText(), '', 'Legacy requests leave committed API knowledge untouched');
});

test('QA: same-origin provider redirects strip custom scoped headers and echoed query auth', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith('/alpha/redirect-credentials')) {
      const key = new URL(req.url, 'http://fixture.invalid').searchParams.get('api_key');
      res.writeHead(302, { location: `/beta/items/credential-target-private?api_key=${key}&page=2` });
      res.end(); return true;
    }
  }, { legacy:true });
  f.config.hosts.alpha.auth = 'query:api_key:QA_ALPHA_KEY';
  save(f.root, LAYOUT.environments, f.config);
  const [result] = await f.request([{ upstream: 'alpha', path: '/redirect-credentials',
    headers: { 'X-Tenant-Context': 'tenant-header-private', Accept: 'application/json' } }]);
  assert.equal(result.context_capture?.code, 'STACKS_MIGRATION_REQUIRED', JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].url, /api_key=alpha-credential-private/);
  assert.equal(f.calls[0].headers['x-tenant-context'], 'tenant-header-private');
  assert.equal(f.calls[1].url, '/beta/items/credential-target-private?page=2');
  assert.equal(f.calls[1].headers['x-tenant-context'], undefined);
  assert.equal(f.calls[1].headers.accept, 'application/json');
  assert.doesNotMatch(f.contextText(), /alpha-credential-private|tenant-header-private|credential-target-private/);
  assert.equal(f.contextText(), '', 'Legacy requests leave committed API knowledge untouched');
});

test('QA: same-origin provider redirects refuse preserved bodies and bodyless writes before contacting the target', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.startsWith('/alpha/replay-')) {
      res.writeHead(307, { location: '/beta/items/replayed-path-private' }); res.end(); return true;
    }
  }, { legacy:true });
  const results = await f.request([
    { upstream: 'alpha', path: '/replay-body', method: 'POST', body: { customer: 'request-body-private' } },
    { upstream: 'alpha', path: '/replay-write', method: 'DELETE' },
  ]);
  assert.deepEqual(f.calls.map(call => [call.method, call.url]), [
    ['POST', '/alpha/replay-body'], ['DELETE', '/alpha/replay-write'],
  ]);
  assert.ok(results.every(result => result.ok === false && result.mode === 'refused'), JSON.stringify(results));
  assert.equal(results[0].error.code, 'CROSS_PROVIDER_BODY_REDIRECT_REFUSED');
  assert.equal(results[1].error.code, 'CROSS_PROVIDER_WRITE_REDIRECT_REFUSED');
  assert.equal(f.observations({ provider: `${f.origin}/beta` }).length, 0);
  assert.equal(f.contextText(), '', 'Legacy requests leave committed API knowledge untouched');
});

test('QA: a provider root cookie persists for that provider and is not reinserted into a sibling redirect', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/alpha/cookie-redirect') {
      res.writeHead(302, { location: '/beta/items/cookie-target-private', 'set-cookie': 'session=alpha-cookie-private; Path=/; HttpOnly' });
      res.end(); return true;
    }
  }, { legacy:true });
  await f.request([
    { upstream: 'alpha', path: '/cookie-redirect' },
    { upstream: 'alpha', path: '/items/same-provider-private' },
  ]);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[1].headers.cookie, undefined, 'Stripped cookies must not be reinstalled from another provider jar.');
  assert.equal(f.calls[2].headers.cookie, 'session=alpha-cookie-private', 'The same provider retains its session.');
  assert.doesNotMatch(f.contextText(), /alpha-cookie-private/);
  assert.equal(f.contextText(), '', 'Legacy requests leave committed API knowledge untouched');
});

test('QA: redirect drift and contract-loaded telemetry describe the final response provider', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/alpha/items/redirect-source-private' || req.url === '/alpha/undeclared-redirect') {
      res.writeHead(302, { location: req.url.includes('/items/') ? '/beta/shadow/final-path-private' : '/beta/items/final-path-private' });
      res.end(); return true;
    }
  }, { legacy:true });
  const results = await f.request([
    { upstream: 'alpha', path: '/items/redirect-source-private' },
    { upstream: 'alpha', path: '/undeclared-redirect' },
  ]);
  const drift = result => (result.contract_delta ?? []).filter(item => item.kind === 'undeclared-path');
  assert.deepEqual(drift(results[0]).map(item => item.requested), ['/beta/shadow/final-path-private']);
  assert.equal(results[0].context_capture?.code, 'STACKS_MIGRATION_REQUIRED');
  assert.deepEqual(drift(results[1]), [], 'An undeclared initial redirect must not be reported as final-provider path drift.');
  assert.equal(results[1].context_capture?.code, 'STACKS_MIGRATION_REQUIRED');
  delete f.config.hosts.beta.contract; save(f.root, LAYOUT.environments, f.config);
  const [unbound] = await f.request([{ upstream: 'alpha', path: '/undeclared-redirect' }]);
  assert.equal(unbound.context_capture?.code, 'STACKS_MIGRATION_REQUIRED');
  assert.deepEqual(drift(unbound), [], 'An unbound final provider has no declared-path verdict.');
  const usage = readFileSync(join(f.root, 'usage.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(usage.map(row => row.contractLoaded), [true, true, false]);
  assert.equal(f.contextText(), '', 'Legacy requests leave committed API knowledge untouched');
});
