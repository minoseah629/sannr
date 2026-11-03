// Synthetic Parcel Lab for the Workbench. Imported, buildWorkbenchLab writes a
// small repository with three stacks, notes in every evidence state, run files
// and an optional survey. Run directly, it is the standalone loopback service
// for real-browser and fresh-agent handoff checks. No real credentials, vendor
// hosts or household data.
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixtureStack, fixtureContextFile } from '../helpers/stack-fixture.mjs';
import { operationId } from '../../lib/operation-context.mjs';
import { LAYOUT } from '../../lib/layout.mjs';

const quoteResponses = { 200: { description: 'Quote ready', content: { 'application/json': { schema: { $ref: '#/components/schemas/Quote' } } } },
  422: { description: 'Window needed' } };
export const LAB_CONTRACT = { openapi: '3.0.3', info: { title: 'Parcel Lab', version: '1' }, tags: [{ name: 'Quotes' }, { name: 'Service' }], paths: {
  '/orders/{orderId}/quote': { get: { operationId: 'getQuote', tags: ['Quotes'], parameters: [
    { in: 'path', name: 'orderId', required: true, schema: { type: 'string' } },
    { in: 'query', name: 'window', schema: { type: 'string' } },
  ], responses: quoteResponses } },
  '/health': { get: { operationId: 'getHealth', tags: ['Service'], responses: { 200: { description: 'Ready',
    content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } } } } } },
}, components: { schemas: { Quote: { type: 'object', required: ['quote', 'currency'], allOf: [{ properties: { quote: { type: 'object' } } }],
  properties: { currency: { type: 'string' }, delivery: { type: 'string' } } } } } };
const LEDGER_CONTRACT = { openapi: '3.0.3', info: { title: 'Ledger Lab', version: '1' }, paths: {
  '/v1/entries': { get: { responses: { 200: { description: 'Entries' } } } } } };
const VENDOR_CONTRACT = { openapi: '3.0.3', info: { title: 'Vendor Lab', version: '1' }, paths: Object.fromEntries(
  ['/messages', '/messages/{id}', '/numbers'].map(path => [path, { get: { responses: { 200: { description: 'ok' } } } }])) };
const CLI = fileURLToPath(new URL('../../bin/cli.mjs', import.meta.url));
const digestOf = file => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;

/** Write the lab into root. `env` isolates HOME and machine state for the CLI.
 * mismatch: false leaves out the scope-mismatch note, so Mismatch has none.
 * shortDigest: true stores the parcel ledger's contract digest in the 16-hex
 * short form that init and learn write; run files keep the full digest.
 * singleStore: true leaves the parcel ledger alone in the single-store layout
 * (no named stacks; its run files at the evidence root).
 * quietOperations: true adds two parcel operations, defined in code, that no
 * note mentions: one with two run files (201 and 409), one with none. */
export function buildWorkbenchLab(root, { env, mismatch = true, survey = true, generateSurvey, shortDigest = false, singleStore = false, quietOperations = false } = {}) {
  mkdirSync(root, { recursive: true });
  const write = (path, value) => { const file = join(root, path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2)); return file; };
  write('parcel-service/openapi.json', quietOperations ? { ...LAB_CONTRACT, paths: { ...LAB_CONTRACT.paths,
    '/orders/{orderId}/label': { post: { operationId: 'createLabel', tags: ['Quotes'], responses: { 201: { description: 'Label created',
      content: { 'application/json': { schema: { type: 'object', required: ['label_id'], properties: { label_id: { type: 'string' } } } } } }, 409: { description: 'Already labelled' } } } },
    '/orders/{orderId}': { delete: { operationId: 'cancelOrder', tags: ['Quotes'], responses: { 204: { description: 'Cancelled' } } } } } } : LAB_CONTRACT);
  write('ledger-service/openapi.json', LEDGER_CONTRACT); write('contracts/vendor.json', VENDOR_CONTRACT);
  const local = 'http://127.0.0.1:9', staging = 'https://staging.parcel.example.test';
  createFixtureStack(root, { name: 'parcel', title: 'Parcel Lab', contract: 'parcel-service/openapi.json', environment: 'local',
    environments: { local: { baseUrl: local }, staging: { baseUrl: staging } } });
  createFixtureStack(root, { name: 'ledger', title: 'Ledger Lab', contract: 'ledger-service/openapi.json', baseUrl: 'https://ledger.example.test' });
  createFixtureStack(root, { name: 'vendor', title: 'Vendor Lab', contract: 'contracts/vendor.json', baseUrl: 'https://vendor.example.test' });
  // Routes beside each service's contract are what the survey matches.
  write('parcel-service/routes.mjs', `app.get("/orders/:orderId/quote", quote);\napp.get("/health", health);\n${quietOperations
    ? 'app.post("/orders/:orderId/label", label);\napp.delete("/orders/:orderId", cancel);\n' : ''}`);
  write('ledger-service/routes.mjs', 'app.get("/v1/entries", entries);\n');
  const current = digestOf(join(root, '.sannr/stacks/parcel/openapi.json'));
  writeFileSync(fixtureContextFile(root, 'parcel'), JSON.stringify({ v: 0, api: { name: 'Parcel Lab', contract_digest: current }, operations: {} }));
  writeFileSync(fixtureContextFile(root, 'ledger'), JSON.stringify({ v: 0, api: { name: 'Ledger Lab' }, operations: {} }));
  writeFileSync(fixtureContextFile(root, 'vendor'), JSON.stringify({ v: 0, api: { name: 'Vendor Lab' }, operations: {} }));
  const run = (id, { operation, environment, provider, contract, status, at = '2026-10-29T10:00:00.000Z' }) => {
    const body = JSON.stringify({ runId: id, origin: { v: 1, initiator: 'cli.request', transport: 'api_request:http', observed_at: at, package_version: '0.0.0-lab',
      scope: { operation, protocol: 'http', environment, provider, contract_digest: contract } },
    request: { method: operation.split(' ')[0], url: `${provider}/lab` }, response: { status, body: { status: 'ok' } }, durationMs: 4 });
    return write(`.sannr/evidence/parcel/${id}.json`, body);
  };
  const okRun = run('run-lab-health-ok', { operation: 'GET /health', environment: 'local', provider: local, contract: current, status: 200 });
  run('run-lab-quote-scope', { operation: 'GET /orders/{orderId}/quote', environment: 'staging', provider: staging, contract: `sha256:${'0'.repeat(64)}`, status: 422 });
  run('run-lab-unscoped', { operation: 'GET /health', environment: 'local', provider: local, contract: current, status: 200 });
  const unscoped = join(root, '.sannr/evidence/parcel/run-lab-unscoped.json'), value = JSON.parse(readFileSync(unscoped, 'utf8'));
  delete value.origin.scope.operation; writeFileSync(unscoped, JSON.stringify(value));
  if (quietOperations) for (const [id, status, at] of [['run-lab-label-refused', 409, '2026-10-29T10:02:00.000Z'], ['run-lab-label-created', 201, '2026-10-29T10:05:00.000Z']])
    run(id, { operation: 'POST /orders/{orderId}/label', environment: 'local', provider: local, contract: current, status, at });
  // The in-scope run is shared as a ledger observation of its response shape.
  const ctxFile = fixtureContextFile(root, 'parcel'), ctx = JSON.parse(readFileSync(ctxFile, 'utf8'));
  const identity = { stack: 'parcel', protocol: 'http', operation: 'GET /health', environment: 'local', provider: local, contractDigest: current, endpoint: `${local}/health` };
  ctx.api_context = { v: 1, operations: { [operationId(identity)]: { identity, omitted_observations: 0, observations: [{ id: 'run-lab-health-ok', recorded_at: '2026-10-29T10:00:01.000Z',
    observed_at: '2026-10-29T10:00:00.000Z', source: { kind: 'client', tool: 'api_request:http' }, basis: 'observed', verification: 'client-observation', outcome: 'success',
    complete: true, response_status: 200, request_shape: { type: 'object', properties: {} }, response_shape: { type: 'object', properties: { status: { type: 'string' } } },
    assertions: { passed: 1, failed: 0 }, evidence: [{ path: '.sannr/evidence/parcel/run-lab-health-ok.json', digest: digestOf(okRun) }], notes: [], omissions: [] }] } } };
  writeFileSync(ctxFile, JSON.stringify(ctx));
  const note = (stack, operation, text, args = []) => JSON.parse(execFileSync(process.execPath, [CLI, 'note', operation, text, '--stack', stack, '--json', ...args],
    { cwd: root, env: { ...env, API_REPO_ROOT: root, API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', NO_COLOR: '1' }, encoding: 'utf8', timeout: 20000 }));
  const notes = {};
  if (mismatch) notes.mismatch = note('parcel', 'GET /orders/{orderId}/quote', 'Observed in staging: quotes return 422 until window=current is sent.',
    ['--evidence', 'run-lab-quote-scope', '--by', 'Lab agent', '--actor', 'agent']);
  notes.local = note('parcel', 'GET /orders/{orderId}/quote', 'Local source: the quote handler reads the window from the query string.',
    [...(mismatch ? ['--alongside'] : []), '--by', 'Lab reviewer', '--actor', 'person']);
  notes.ok = note('parcel', 'GET /health', 'Observed in local: health returns 200 with a status field.', ['--evidence', 'run-lab-health-ok', '--by', 'Lab agent', '--actor', 'agent']);
  notes.ledger = note('ledger', 'GET /v1/entries', 'Documented: entries are paged by cursor.', ['--by', 'Lab reviewer', '--actor', 'person']);
  if (shortDigest) {
    const value = JSON.parse(readFileSync(ctxFile, 'utf8'));
    value.api.contract_digest = current.slice(0, 'sha256:'.length + 16);
    writeFileSync(ctxFile, JSON.stringify(value));
  }
  if (singleStore) {
    renameSync(ctxFile, join(root, LAYOUT.context));
    const runs = join(root, LAYOUT.evidence, 'parcel');
    for (const name of readdirSync(runs)) renameSync(join(runs, name), join(root, LAYOUT.evidence, name));
    for (const name of ['parcel', 'ledger', 'vendor']) {
      rmSync(join(root, LAYOUT.collection, name), { recursive: true, force: true });
      rmSync(join(root, LAYOUT.evidence, name), { recursive: true, force: true });
    }
  }
  if (survey && generateSurvey) generateSurvey(root, { now: '2026-10-29T12:00:00.000Z' });
  return { root, notes };
}

// Standalone service mode, unchanged in behavior.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(process.argv[2]);
  mkdirSync(root, { recursive: true });
  const seen = join(root, 'fixture-requests.jsonl');
  const contract = { openapi: '3.0.3', info: { title: 'Parcel Lab', version: '1' }, paths: {
    '/orders/{orderId}/quote': { get: { parameters: LAB_CONTRACT.paths['/orders/{orderId}/quote'].get.parameters,
      responses: { 200: { description: 'Quote ready' }, 422: { description: 'Window needed' } } } },
    '/health': { get: { responses: { 200: { description: 'Ready' } } } },
  } };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.example.test');
    const success = url.pathname === '/health' || url.searchParams.get('window') === 'current';
    const status = success ? 200 : 422;
    appendFileSync(seen, JSON.stringify({ method: request.method, path: url.pathname, status, at: new Date().toISOString() }) + '\n');
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(success ? { quote: { currency: 'USD', total: 24, delivery: 'tomorrow' },
      preview_url: 'https://files.example.test/item?X-Amz-Signature=synthetic-private-signature', password: 'abc',
      message: '<img src=x onerror=alert(1)> rendered as text only' }
      : { error: 'window_required', detail: 'Quotes need window=current. The contract does not mark it required.' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  writeFileSync(join(root, 'openapi.json'), JSON.stringify(contract, null, 2));
  createFixtureStack(root, { name: 'parcel', title: 'Parcel Lab', contract: 'openapi.json', baseUrl });
  writeFileSync(join(root, '.gitignore'), 'home/\nmachine/\nfixture-requests.jsonl\nlocal-inputs.json\n');
  writeFileSync(join(root, 'README.md'), '# Parcel Lab\n\nSynthetic fixture. All traffic must stay on the configured loopback API.\n');
  console.log(JSON.stringify({ root, baseUrl, stack: 'parcel', environment: 'local' }));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
}
