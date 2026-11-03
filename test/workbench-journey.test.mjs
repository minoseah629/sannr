// One reviewer's journey through the Sannr Workbench Review screen, step by
// step, over one synthetic repository with two stacks (orders, billing) and a
// loopback fake API running in its own process. Review actions use the real
// workbench handlers; pairing uses the real local server; agent reads use the
// CLI and the MCP stdio server. The browser DOM is covered by workbench-ui.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureStack, fixtureContextFile } from './helpers/stack-fixture.mjs';
import { workbenchHandlers, workbenchAssets } from '../lib/workbench-engine.mjs';
import { createWorkbenchServer } from '../lib/workbench-server.mjs';
import { LAYOUT } from '../lib/layout.mjs';
import { HOME_ENV_NAME } from '../lib/brand.mjs';

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url));
const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const WIDGET = 'GET /widgets/{id}', ROWS = 'GET /budget-rows', INVOICES = 'GET /invoices';
const DOCS = 'https://docs.example.test/billing/budget-rows';
const EPERM = 'Loopback fixture bind refused by sandbox: EPERM';
// Distinctive response values: none may ever reach a review record.
const VALUES = ['JOURNEY_WIDGET_NAME_VALUE', 'JOURNEY_WIDGET_COLOUR_VALUE', 'journey_secret_opaque_value_7f3a', 'JOURNEY_ROW_VALUE'];
const SECRET = VALUES[2];

// The fake API is its own process. It records every request it receives.
const FAKE_API = `import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const log = process.argv[2];
const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    const path = new URL(req.url, 'http://fake').pathname;
    appendFileSync(log, JSON.stringify({ method: req.method, path, body: raw || null }) + '\\n');
    if (req.method === 'GET' && path === '/widgets/w1') return send(res, 200,
      { id: 'w1', name: ${JSON.stringify(VALUES[0])}, colour: ${JSON.stringify(VALUES[1])}, access_token: ${JSON.stringify(SECRET)} });
    if (req.method === 'GET' && path.startsWith('/widgets/')) return send(res, 404, { error: 'not_found' });
    if (req.method === 'GET' && path === '/budget-rows') return send(res, 200,
      Array.from({ length: 80 }, (_, i) => ({ id: 'row-' + i, description: ${JSON.stringify(VALUES[3])} + ' synthetic row '.repeat(6) })));
    send(res, 404, { error: 'not_found' });
  });
});
server.on('error', error => { process.stdout.write('error:' + error.code + '\\n'); process.exit(1); });
server.listen(0, '127.0.0.1', () => process.stdout.write('http://127.0.0.1:' + server.address().port + '\\n'));
`;
const contracts = {
  orders: { openapi: '3.0.3', info: { title: 'Orders', version: '1' }, paths: {
    '/widgets/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { 200: { description: 'found' }, 404: { description: 'missing' } } } } } },
  billing: { openapi: '3.0.3', info: { title: 'Billing', version: '1' }, paths: {
    '/budget-rows': { get: { responses: { 200: { description: 'rows' } } } },
    '/invoices': { get: { responses: { 200: { description: 'invoices' } } } } } },
};

async function startFakeApi(t, dir) {
  const script = join(dir, 'fake-api.mjs'), log = join(dir, 'fake-api.jsonl');
  writeFileSync(script, FAKE_API); writeFileSync(log, '');
  const child = spawn(process.execPath, [script, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  const line = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('\n')) resolve(out.trim()); });
    exited.then(code => reject(new Error(`fake API exited ${code}: ${out}`)));
  });
  const seen = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map(row => JSON.parse(row)).map(({ method, path }) => ({ method, path }));
  return { origin: line.startsWith('http') ? line : null, error: line.startsWith('error:') ? line.slice(6) : null, seen };
}

// Copied from workbench-review.test.mjs: a same-origin browser-shaped POST.
async function wire(service, path, body, token, extra = {}) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(service.url, { method: 'POST', path, headers: { origin: service.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty', 'content-type': 'application/json', accept: 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(token ? { 'x-workbench-token': token } : {}), ...extra } }, res => {
      const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, ...JSON.parse(Buffer.concat(chunks)) }));
    }); req.on('error', reject); req.end(payload);
  });
}

function files(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files(path, base, out); else out.push(relative(base, path));
  }
  return out.sort();
}

test('a reviewer works through the Review screen and agents read her decisions with the workbench closed', async t => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'workbench-journey-'))), root = join(parent, 'repo'), home = join(parent, 'home');
  mkdirSync(root); mkdirSync(home);
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const fake = await startFakeApi(t, parent);
  if (fake.error === 'EPERM') { t.skip(EPERM); return; }
  assert.ok(fake.origin, fake.error);

  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:API_|SANNR_|NODE_OPTIONS$)/u.test(key) && key !== HOME_ENV_NAME));
  Object.assign(env, { HOME: home, API_REPO_ROOT: root, API_CONTEXT_DIR: root, API_FRICTION_OFF: '1', NO_COLOR: '1', API_USAGE_LOG: join(parent, 'usage.jsonl') });
  const run = (file, args, extra = {}) => new Promise(resolve => execFile(process.execPath, [file, ...args],
    { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr })));
  const cli = async args => {
    const out = await run(CLI, [...args, '--json']);
    assert.equal(out.code, 0, out.stdout + out.stderr);
    return JSON.parse(out.stdout);
  };
  const mcp = (name, args, extra = {}) => new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [SERVER], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(stderr || error.message));
      const reply = stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.id === 1);
      resolve(JSON.parse(reply.result.content[0].text));
    });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  // A second agent: one MCP stdio session that initializes, then calls tools in order.
  const peer = async () => {
    const child = spawn(process.execPath, [SERVER], { cwd: root, env, stdio: ['pipe', 'pipe', 'inherit'] });
    const closed = new Promise(resolve => child.once('close', resolve));
    t.after(async () => { child.stdin.end(); child.kill(); await closed; });
    let buffer = '', sequence = 0;
    const waiting = new Map();
    child.stdout.on('data', bytes => {
      buffer += bytes; const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines.filter(Boolean)) { const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id); }
    });
    const rpc = (method, params) => new Promise(resolve => { const id = ++sequence; waiting.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Second agent', version: '1' } });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    return async (name, args) => {
      const reply = await rpc('tools/call', { name, arguments: args });
      assert.ok(!reply.result.isError, JSON.stringify(reply.result));
      return JSON.parse(reply.result.content[0].text);
    };
  };
  // Every request the fake API receives must be one of these.
  const made = [];
  const apiRequest = (args, extra = {}) => { made.push({ method: 'GET', path: args.path }); return mcp('api_request', args, extra); };

  execFileSync('git', ['init', '--quiet'], { cwd: root, env });
  for (const [name, contract] of Object.entries(contracts)) {
    writeFileSync(join(parent, `${name}.openapi.json`), JSON.stringify(contract));
    createFixtureStack(root, { name, contract: join(parent, `${name}.openapi.json`), environments: name === 'orders'
      ? { local: { baseUrl: fake.origin }, 'reporting-test': { baseUrl: 'https://api.example.test' }, production: { baseUrl: 'https://api.example.test', production: true } }
      : { local: { baseUrl: fake.origin }, production: { baseUrl: 'https://billing.example.test', production: true } } });
    writeFileSync(fixtureContextFile(root, name), JSON.stringify({ v: 0, api: { name }, operations: {} }));
  }
  writeFileSync(join(root, 'AGENTS.md'), 'Team instructions.\n');
  const connected = await run(CLI, ['connect', '--agents', '--no-skills']);
  assert.equal(connected.code, 0, connected.stdout + connected.stderr);

  const ledgerFile = name => fixtureContextFile(root, name);
  const ledger = name => JSON.parse(readFileSync(ledgerFile(name), 'utf8'));
  const ledgerHash = () => createHash('sha256').update(['orders', 'billing'].map(name => readFileSync(ledgerFile(name), 'utf8')).join('\0')).digest('hex');
  const read = async fn => {
    const before = ledgerHash(), value = await fn();
    assert.equal(ledgerHash(), before, 'a read leaves the ledger bytes unchanged');
    return value;
  };
  const handlers = workbenchHandlers(root);
  const call = (name, params) => handlers[name].run(JSON.parse(JSON.stringify(params)));
  const id = (stack, operation, note) => ({ stack, operation, note_id: note.note_id ?? note });
  const labelOf = (records, note) => records.find(row => row.id === (note.note_id ?? note))?.review.label;

  // The week before review: an agent ran the orders API twice and wrote notes;
  // a summary tool imported some; a teammate trusted one documentation note
  // before the agent authored its correction. Every active note is unreviewed.
  const runA = await apiRequest({ stack: 'orders', path: '/widgets/w1' });
  assert.equal(runA.status, 200, JSON.stringify(runA));
  const runC = await apiRequest({ stack: 'orders', path: '/widgets/w1' });
  assert.ok(runA.evidence && runC.evidence && runA.evidence !== runC.evidence, 'each kept run has its own id');
  const authored = new Set(), active = new Map();
  const note = async (stack, operation, text, args = [], author = 'agent') => {
    const relation = args.includes('--supersedes') || args.includes('--retires');
    const by = { agent: ['--by', 'Coding agent', '--actor', 'agent'], imported: ['--by', 'Summary tool', '--actor', 'imported'], person: ['--by', 'Teammate', '--actor', 'person'] }[author];
    const receipt = await cli(['note', operation, text, '--stack', stack, ...(authored.has(`${stack} ${operation}`) && !relation ? ['--alongside'] : []), ...by, ...args]);
    authored.add(`${stack} ${operation}`);
    if (relation) active.delete(args[Math.max(args.indexOf('--supersedes'), args.indexOf('--retires')) + 1]);
    active.set(receipt.note_id, { stack, operation, author, text });
    return receipt;
  };
  const N1 = await note('orders', WIDGET, 'Returns HTTP 200 in local; response field name and header Content-Type.', ['--evidence', runA.evidence, '--basis', 'observed-run']);
  const N2 = await note('orders', WIDGET, 'Returns HTTP 201 for an existing widget.', ['--evidence', runA.evidence, '--basis', 'observed-run']);
  const N3 = await note('orders', WIDGET, 'Documented: an unknown id returns HTTP 404.', ['--basis', 'documentation', '--source', 'https://docs.example.test/orders']);
  const N4 = await note('orders', WIDGET, 'The colour query filter narrows the result.', [], 'imported');
  const N5 = await note('orders', WIDGET, 'Observed in production: responses carry a cache header.');
  const N6 = await note('orders', WIDGET, 'Observed in reporting-test: the widget payload is cached.', [], 'imported');
  const N7 = await note('orders', WIDGET, 'Pagination is not offered on this route.', [], 'person');
  const N8 = await note('orders', WIDGET, 'Observed: a repeated read returns HTTP 200.', ['--evidence', runC.evidence, '--basis', 'observed-run']);
  // The second run file was later edited by hand; its digest no longer matches.
  appendFileSync(join(root, LAYOUT.evidence, 'orders', `${runC.evidence}.json`), '\n');
  const docs = ['--basis', 'documentation', '--source', DOCS];
  const D = [];
  for (const text of ['Documented: rows are sorted by period.', 'Documented: amounts are integer cents.', 'Documented: the currency is ISO 4217.',
    'Documented: archived rows are excluded.', 'Documented: page size defaults to 50.']) D.push(await note('billing', ROWS, text, docs));
  await cli(['review', ROWS, '--stack', 'billing', '--note', D[4].note_id, '--decision', 'trusted', '--by', 'Teammate', '--actor', 'person']);
  const D6 = await note('billing', ROWS, 'Documented: page size defaults to 25.', ['--supersedes', D[4].note_id, '--evidence', 'run-docs-correction', ...docs]);
  for (const text of ['Documented: rows carry a cost centre.', 'Documented: budgets close monthly.', 'Documented: forecasts are separate rows.'])
    D.push(await note('billing', ROWS, text, docs));
  const I1 = await note('billing', INVOICES, 'Documented: invoices list the newest first.', docs);
  const L1 = await note('billing', INVOICES, 'Local tests stub invoices with an empty list.', ['--basis', 'local-source', '--source', 'test/invoices.test.mjs']);
  const docsActive = [...D.slice(0, 4), D6, ...D.slice(5)];
  const ordersOf = () => [...active].filter(([, row]) => row.stack === 'orders').map(([key]) => key);
  const requestsBeforeReview = fake.seen().length;
  assert.equal(requestsBeforeReview, 2);

  let service = null, token = null;
  const action = async (name, params) => {
    if (!service) return call(name, params);
    const reply = await wire(service, '/action', { action: name, params }, token);
    assert.equal(reply.status, 200, JSON.stringify(reply));
    return reply.result;
  };
  t.after(() => service?.close());
  const trustN1 = { stack: 'orders', operation: WIDGET, notes: [N1.note_id], decision: 'trusted', by: 'Maya', actor: 'person', limits: 'local only' };

  await t.test('step 1: an unpaired workbench action is refused with 401 and writes nothing; after pairing the same action succeeds', async t => {
    try { service = await createWorkbenchServer({ assets: workbenchAssets(), handlers }); }
    catch (error) { if (error.code === 'EPERM') { t.skip(EPERM); return; } throw error; }
    const before = ledgerHash();
    assert.equal((await wire(service, '/action', { action: 'reviewDecision', params: trustN1 })).status, 401);
    assert.equal((await wire(service, '/action', { action: 'reviewIndex', params: {} })).status, 401);
    assert.equal(ledgerHash(), before, 'a refused action writes nothing');
    assert.equal(new URL(service.url).search, '', 'the launch URL carries no authority');
    const pending = (await wire(service, '/pair/start', {})).result; service.authorizePairing(pending.code);
    token = (await wire(service, '/pair/complete', {}, null, { 'x-workbench-pairing': pending.nonce })).result.token;
    assert.ok(token);
    const index = await read(() => action('reviewIndex', {}));
    assert.equal(index.state, 'available');
    assert.equal(index.total, active.size);
  });

  await t.test('step 2: Review opens on the ledger with honest totals, lanes and authors and selects the first record', async () => {
    const index = await read(() => action('reviewIndex', {}));
    assert.equal(index.state, 'available');
    assert.equal(index.total, active.size);
    // Independently of the reader: authored notes minus authored replacements.
    const inLedger = ['orders', 'billing'].map(name => Object.values(ledger(name).operations)
      .reduce((sum, entry) => sum + (entry.notes?.length ?? 0) - (entry.note_replacements?.length ?? 0), 0));
    assert.deepEqual(index.stacks.map(row => row.count), [inLedger[1], inLedger[0]]);
    assert.equal(index.total, inLedger[0] + inLedger[1]);
    assert.deepEqual(new Set(index.records.map(row => row.note_id)), new Set(active.keys()));
    for (const row of index.records) assert.deepEqual([row.stack, row.operation], [active.get(row.note_id).stack, active.get(row.note_id).operation]);
    assert.deepEqual(index.stacks, [{ name: 'billing', count: active.size - ordersOf().length }, { name: 'orders', count: ordersOf().length }]);
    assert.equal(index.reviewed, 0, 'the predecessor a teammate trusted is no longer active');
    assert.equal(index.covered, 2);
    assert.equal(index.lanes.reduce((sum, lane) => sum + lane.count, 0), index.total);
    assert.equal(index.authors.reduce((sum, row) => sum + row.count, 0), index.total);
    const lane = note => index.records.find(row => row.note_id === note.note_id).lane;
    assert.equal(lane(N1), 'covered-run'); assert.equal(lane(N2), 'covered-run');
    for (const row of [N3, ...docsActive, I1]) assert.equal(lane(row), 'documentation');
    assert.equal(lane(L1), 'code-local-tests');
    assert.notEqual(lane(N8), 'covered-run', 'an edited run file covers nothing');
    for (const category of ['person', 'agent', 'imported'])
      assert.equal(index.authors.find(row => row.category === category).count, [...active.values()].filter(row => row.author === category).length);
    // The UI asks for the unfiltered index and opens its first record.
    const first = index.records[0];
    assert.deepEqual({ stack: first.stack, operation: first.operation, note_id: first.note_id }, id('billing', ROWS, D[0]));
    const detail = await read(() => action('reviewDetail', id(first.stack, first.operation, first.note_id)));
    assert.equal(detail.refused, undefined, JSON.stringify(detail));
    assert.equal(detail.record.id, D[0].note_id);
    assert.equal(detail.nodes[0].kind, 'claim');
  });

  await t.test('step 3: only a kept run whose digest matches gives full-run comparisons, and Inspect JSON stays redacted', async () => {
    const lane = await read(() => action('reviewIndex', { lane: 'covered-run' }));
    assert.deepEqual(new Set(lane.records.map(row => row.note_id)), new Set([N1.note_id, N2.note_id]));
    assert.ok(lane.records.every(row => row.covered));
    const detail = await read(() => action('reviewDetail', id('orders', WIDGET, N1)));
    assert.deepEqual(detail.comparisons.map(row => [row.run_id, row.depth, row.coverage]), [[runA.evidence, 'full-run', 'covered']]);
    assert.ok(detail.comparisons[0].rows.some(row => row.mark === 'matches'), JSON.stringify(detail.comparisons));
    const edited = await read(() => action('reviewDetail', id('orders', WIDGET, N8)));
    assert.notEqual(edited.comparisons[0].depth, 'full-run');
    const absent = await read(() => action('reviewDetail', id('billing', ROWS, D6)));
    assert.equal(absent.comparisons[0].depth, 'run-id-only');
    for (const comparison of [...detail.comparisons, ...edited.comparisons, ...absent.comparisons])
      for (const row of comparison.rows) if (row.mark === 'matches') assert.deepEqual([comparison.depth, comparison.coverage], ['full-run', 'covered']);
    const kinds = detail.nodes.map(node => node.kind);
    for (const [a, b] of [['claim', 'review'], ['review', 'run'], ['run', 'scope'], ['scope', 'observation'], ['observation', 'contract']])
      assert.ok(kinds.indexOf(a) < kinds.indexOf(b), kinds.join(' → '));
    const runNode = detail.nodes.find(node => node.id === `run:${runA.evidence}`);
    assert.equal(runNode.present, true, 'the run file is on this machine');
    assert.equal(detail.nodes.find(node => node.id === 'contract').present, true);
    const inspected = await read(() => action('reviewNode', { ...id('orders', WIDGET, N1), node: runNode.id }));
    assert.ok(inspected.response?.body_text?.includes(VALUES[0]), 'Inspect JSON shows the retained response');
    assert.ok(!JSON.stringify(inspected).includes(SECRET), 'Inspect JSON never contains the redacted secret');
    assert.ok(!JSON.stringify(detail).includes(VALUES[0]), 'the comparison never carries response values');
  });

  await t.test('step 4: a trusted claim with a limit carries the same label in show, the preview and api_note_context', async () => {
    const before = await read(() => action('reviewIndex', {})), requests = fake.seen().length;
    const saved = await action('reviewDecision', trustN1);
    assert.equal(saved.refused, undefined, JSON.stringify(saved));
    assert.equal(saved.added, 1); assert.equal(saved.requests_executed, 0);
    const records = ledger('orders').operations[WIDGET].note_reviews.filter(row => row.note_id === N1.note_id);
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].decision, records[0].by, records[0].actor, records[0].limits, records[0].evidence], ['trusted', 'Maya', 'person', 'local only', []]);
    const detail = await read(() => action('reviewDetail', id('orders', WIDGET, N1)));
    const label = detail.record.review.label;
    assert.match(label, /^trusted by Maya · no run · limits: "local only"$/u);
    assert.ok(detail.nodes.some(node => node.kind === 'review' && node.present && node.label === 'Review · trusted'));
    assert.equal(labelOf(detail.preview.records, N1), label, 'What agents will read is the saved headless projection');
    const shown = await read(() => cli(['show', WIDGET, '--stack', 'orders']));
    assert.equal(labelOf(shown.note_projection.records, N1), label);
    const context = await read(() => mcp('api_note_context', { operation: WIDGET, stack: 'orders' }));
    assert.equal(labelOf(context.note_context.records, N1), label);
    assert.equal(context.requests_executed, 0);
    assert.equal((await read(() => action('reviewIndex', {}))).reviewed, before.reviewed + 1);
    assert.equal(fake.seen().length, requests, 'no run was executed');
  });

  await t.test('step 5: a dispute needs a reason, and overturning trust needs a run id', async () => {
    const detail = await read(() => action('reviewDetail', id('orders', WIDGET, N2)));
    assert.ok(detail.comparisons[0].rows.some(row => row.kind === 'status' && row.mark === 'differs'), 'the kept run shows another status');
    const dispute = { stack: 'orders', operation: WIDGET, notes: [N2.note_id], decision: 'disputed', by: 'Maya', actor: 'person' };
    let before = ledgerHash();
    assert.equal((await action('reviewDecision', { ...dispute, reason: '' })).refused, 'NOTE_REVIEW_REASON_REQUIRED');
    assert.equal(ledgerHash(), before, 'nothing was saved');
    const disputed = await action('reviewDecision', { ...dispute, reason: 'The kept run shows 200 for an existing widget.' });
    assert.equal(disputed.added, 1);
    assert.equal((await read(() => action('reviewDetail', id('orders', WIDGET, N2)))).record.review.state, 'disputed');
    // Overturning a trusted note needs a run.
    assert.equal((await action('reviewDecision', { ...dispute, notes: [N3.note_id], decision: 'trusted', reason: undefined })).added, 1);
    const overturn = { ...dispute, notes: [N3.note_id], reason: 'The documentation predates the 404 change.' };
    before = ledgerHash();
    assert.equal((await action('reviewDecision', overturn)).refused, 'NOTE_REVIEW_EVIDENCE_REQUIRED');
    assert.equal(ledgerHash(), before);
    assert.equal((await action('reviewDecision', { ...overturn, evidence: [runA.evidence] })).added, 1);
    const after = await read(() => action('reviewDetail', id('orders', WIDGET, N3)));
    assert.equal(after.record.review.state, 'disputed');
    assert.ok(after.record.review.label.includes(runA.evidence));
  });

  let R;
  await t.test('step 6: retiring a removed claim keeps it in history and out of active guidance', async () => {
    const retired = await action('reviewRetire', { stack: 'orders', operation: WIDGET, retires: N4.note_id, reason: 'removed',
      text: 'The colour query filter was removed last sprint.', by: 'Maya', actor: 'person' });
    assert.equal(retired.refused, undefined, JSON.stringify(retired));
    R = retired; active.delete(N4.note_id); active.set(R.note_id, { stack: 'orders', operation: WIDGET, author: 'person' });
    const detail = await read(() => action('reviewDetail', id('orders', WIDGET, R)));
    assert.deepEqual(detail.record.retirement.map(row => [row.note_id, row.reason]), [[N4.note_id, 'removed']]);
    const entry = ledger('orders').operations[WIDGET];
    assert.deepEqual(entry.note_retirements, [{ replacement: R.note_id, reason: 'removed', actor: 'person' }]);
    const link = entry.note_replacements.find(row => row.replacement === R.note_id);
    assert.deepEqual(Object.keys(link).sort(), ['at', 'by', 'replacement', 'supersedes']);
    assert.equal(link.supersedes, N4.note_id);
    const shown = await read(() => cli(['show', WIDGET, '--stack', 'orders', '--history']));
    assert.ok(!shown.active_notes.includes('The colour query filter narrows the result.'));
    assert.ok(shown.note_projection.records.some(row => row.id === R.note_id));
    assert.ok(!shown.note_projection.records.some(row => row.id === N4.note_id));
    const original = shown.note_history.records.find(row => row.id === N4.note_id);
    assert.equal(original.superseded.replacement, R.note_id, 'the original stays in history as superseded');
    const context = await read(() => mcp('api_note_context', { operation: WIDGET, stack: 'orders' }));
    assert.ok(!context.note_context.records.some(row => row.id === N4.note_id));
    assert.equal(context.note_context.records.find(row => row.id === R.note_id).retirement[0].claim, 'The colour query filter narrows the result.');
  });

  await t.test('step 7: a documentation source is reviewed as an explicit identity list with held-back corrections and an honest partial receipt', async () => {
    const group = await read(() => action('reviewGroups', { kind: 'source', ...id('billing', ROWS, D[0]) }));
    assert.deepEqual(new Set(group.notes.map(row => JSON.stringify([row.stack, row.operation, row.note_id]))),
      new Set([...docsActive.map(row => JSON.stringify(['billing', ROWS, row.note_id])), JSON.stringify(['billing', INVOICES, I1.note_id])]));
    assert.deepEqual(group.held_back.map(row => [row.note_id, row.replacement]), [[D[4].note_id, D6.note_id]]);
    // Meanwhile another session retires the only documentation note on invoices.
    const moved = await note('billing', INVOICES, 'Invoices moved to a versioned route.', ['--retires', I1.note_id, '--reason', 'replaced-by-version']);
    // The UI submits the listed identities plus held-back predecessors of included notes.
    const identities = group.notes.map(row => id(row.stack, row.operation, row.note_id));
    for (const row of group.held_back) if (identities.some(item => item.note_id === row.replacement)) identities.push(id(row.stack, row.operation, row.note_id));
    const invoicesBefore = JSON.stringify(ledger('billing').operations[INVOICES].note_reviews ?? []);
    const batch = await action('reviewBatch', { identities, decision: 'trusted', by: 'Maya', actor: 'person', limits: 'as documented' });
    assert.equal(batch.requests_executed, 0);
    const rows = batch.receipts.find(row => row.operation === ROWS), invoices = batch.receipts.find(row => row.operation === INVOICES);
    assert.equal(rows.added, docsActive.length);
    assert.deepEqual(rows.held_back, [{ note_id: D[4].note_id, code: 'NOTE_REVIEW_REPLACED', replacement: D6.note_id }]);
    assert.equal(invoices.refused, 'NOTE_REVIEW_REPLACED');
    assert.equal(invoices.replacement, moved.note_id);
    assert.equal(batch.partial, true);
    assert.equal(JSON.stringify(ledger('billing').operations[INVOICES].note_reviews ?? []), invoicesBefore, 'the refused operation wrote nothing');
    const detail = await read(() => action('reviewDetail', id('billing', ROWS, D6)));
    assert.match(detail.record.review.label, /^trusted by Maya · no run · limits: "as documented"$/u);
  });

  await t.test('step 8: a both-trusted correction is reported and clears when the predecessor is disputed with the cited run', async () => {
    const detail = await read(() => action('reviewDetail', id('billing', ROWS, D6)));
    assert.deepEqual(detail.conflicts.map(row => [row.code, row.predecessor, row.correction]), [['NOTE_BOTH_TRUSTED', D[4].note_id, D6.note_id]]);
    const cited = detail.record.run_support.map(row => row.run_id);
    assert.deepEqual(cited, ['run-docs-correction']);
    const dispute = { stack: 'billing', operation: ROWS, notes: [D[4].note_id], decision: 'disputed', by: 'Maya', actor: 'person',
      reason: `Retired by authored correction ${D6.note_id}` };
    const before = ledgerHash();
    assert.equal((await action('reviewDecision', dispute)).refused, 'NOTE_REVIEW_EVIDENCE_REQUIRED', 'on this build the run id is typed, not prefilled');
    assert.equal(ledgerHash(), before);
    const saved = await action('reviewDecision', { ...dispute, evidence: cited });
    assert.equal(saved.added, 1, JSON.stringify(saved));
    assert.deepEqual((await read(() => action('reviewDetail', id('billing', ROWS, D6)))).conflicts, []);
    assert.deepEqual((await read(() => cli(['show', ROWS, '--stack', 'billing']))).note_projection.conflicts ?? [], []);
  });

  await t.test('step 9: verification prompts stop before production hosts, and Ask for a run hands the prompt to a second agent without executing anything', async () => {
    const production = await read(() => action('reviewPrompt', id('orders', WIDGET, N5)));
    assert.ok(production.prompt.includes(WIDGET) && production.prompt.includes('orders'));
    assert.ok(production.prompt.includes(JSON.stringify('Observed in production: responses carry a cache header.')), 'the prompt quotes the claim');
    assert.match(production.prompt, /No run is attached/u);
    assert.match(production.prompt, /Environment: production\. Resolved host: api\.example\.test\./u);
    assert.match(production.prompt, /STOP and ask/u);
    const alias = await read(() => action('reviewPrompt', id('orders', WIDGET, N6)));
    assert.match(alias.prompt, /Environment: reporting-test\. Resolved host: api\.example\.test\./u);
    assert.match(alias.prompt, /STOP and ask/u);
    assert.equal(alias.environments[0].production, true, 'an alias resolving to the production host stops too');
    const none = await read(() => action('reviewPrompt', id('orders', WIDGET, N7)));
    assert.deepEqual(none.environments, []);
    assert.doesNotMatch(none.prompt, /Environment:|Resolved host|undefined|null|default environment/u);
    for (const prompt of [production, alias, none]) assert.equal(prompt.requests_executed, 0);
    const tree = files(join(root, LAYOUT.directory));
    const requested = await action('reviewDecision', { stack: 'orders', operation: WIDGET, notes: [N7.note_id], decision: 'run-requested',
      by: 'Maya', actor: 'person', reason: 'Check pagination in an authorized local run.' });
    assert.equal(requested.added, 1); assert.equal(requested.requests_executed, 0);
    assert.equal(requested.handoff.state, 'queued', JSON.stringify(requested.handoff));
    const session = requested.handoff.session_id, inbox = join('evidence', 'workbench', 'handoffs');
    assert.deepEqual(files(join(root, LAYOUT.directory)), [...tree, join(inbox, '.gitignore'), join(inbox, `${session}.json`)].sort(),
      'the run request wrote its inbox handoff and nothing else');
    let detail = await read(() => action('reviewDetail', id('orders', WIDGET, N7)));
    assert.equal(detail.record.review.state, 'run-requested');
    assert.match(detail.record.review.label, /· request: open ·/u);
    // A second agent finds, reads and acknowledges it while the browser stays paired.
    const agent = await peer();
    assert.equal((await agent('api_workbench', { action: 'status' })).sessions.find(row => row.session_id === session).pending, 1);
    const page = await agent('api_workbench', { action: 'read', session, after: 0 });
    assert.deepEqual(page.events.map(row => [row.kind, row.stack, row.operation, row.note_id, row.check, row.message_trust]),
      [['run_request', 'orders', WIDGET, N7.note_id, 'Check pagination in an authorized local run.', 'untrusted-data']]);
    assert.deepEqual(page.events[0].environments, [], 'no environment is invented for a claim that states none');
    assert.equal(page.events[0].prompt, none.prompt, 'the inbox carries the Verify claim prompt');
    assert.equal((await agent('api_workbench', { action: 'ack', session, through: page.next_cursor })).pending, 0);
    detail = await read(() => action('reviewDetail', id('orders', WIDGET, N7)));
    assert.match(detail.record.review.label, /· request: acknowledged ·/u);
    assert.equal(fake.seen().length, requestsBeforeReview, 'nothing in Review, the inbox read or the acknowledgment sent a request');
  });

  await t.test('step 10: with the browser closed, agents read the same labels, a tight budget keeps notes, and a later run flips trust', async t => {
    if (service) {
      const closed = service; await closed.close(); service = null;
      await assert.rejects(wire(closed, '/action', { action: 'reviewIndex', params: {} }, token), 'the closed workbench no longer answers');
    }
    for (const name of ['orders', 'billing']) for (const entry of Object.values(ledger(name).operations))
      if (entry.note_reviews?.length || entry.note_retirements?.length) assert.ok(entry.note_review_integrity, `${name} decisions carry their own seal`);
    assert.ok(ledger('orders').operations[WIDGET].note_retirements.length);
    const shown = await read(() => cli(['show', WIDGET, '--stack', 'orders']));
    const labels = new Map(shown.note_projection.records.map(row => [row.id, row.review.label]));
    assert.deepEqual(new Set(labels.keys()), new Set(ordersOf()));
    const human = await read(() => run(CLI, ['show', WIDGET, '--stack', 'orders', '--human']));
    assert.equal(human.code, 0, human.stderr);
    for (const label of labels.values()) assert.ok(human.stdout.includes(label), label);
    const context = await read(() => mcp('api_note_context', { operation: WIDGET, stack: 'orders' }));
    assert.deepEqual(new Map(context.note_context.records.map(row => [row.id, row.review.label])), labels);
    const pointer = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    // Committed instructions keep the decision; the private inbox status stays out of them.
    const decisionOnly = label => label.replace(/ · request: [^·]*(?= · |$)/u, '');
    assert.match(labels.get(N7.note_id), /· request: acknowledged ·/u);
    for (const label of [labels.get(N1.note_id), labels.get(N2.note_id), labels.get(N7.note_id)]) assert.ok(pointer.includes(decisionOnly(label)), label);
    assert.ok(!pointer.includes('request: acknowledged'));
    assert.ok(pointer.includes('trusted by Maya · no run · limits: "as documented"'), 'the billing decisions reach AGENTS.md too');

    const delivered = await read(() => apiRequest({ stack: 'orders', path: '/widgets/w1', capture_context: false }, { API_BUDGET: '16000' }));
    assert.equal(delivered.status, 200);
    assert.deepEqual(delivered.known.notes, shown.active_notes);
    assert.deepEqual(new Map(delivered.known.note_projection.records.map(row => [row.id, row.review.label])), labels, 'each active note arrives with its label');

    const billing = await read(() => cli(['show', ROWS, '--stack', 'billing']));
    const tight = await read(() => apiRequest({ stack: 'billing', path: '/budget-rows', capture_context: false }, { API_BUDGET: '300' }));
    t.diagnostic(`tight budget: ${tight.known?.notes?.length ?? 0} notes, ${tight.known?.withheld?.note_projection ?? 0} labels withheld`);
    assert.equal(tight.status, 200);
    assert.deepEqual(tight.known.notes, billing.active_notes, 'the notes are delivered first');
    assert.equal(tight.known.withheld?.notes, undefined);
    assert.ok(tight.known.withheld.note_projection > 0, 'withheld labels are counted in a receipt');

    const later = await apiRequest({ stack: 'orders', path: '/widgets/missing' });
    assert.equal(later.status, 404);
    assert.ok(later.evidence);
    const flipped = await read(() => cli(['show', WIDGET, '--stack', 'orders']));
    const review = flipped.note_projection.records.find(row => row.id === N1.note_id).review;
    assert.equal(review.state, 'contradicted-since-trusted');
    assert.ok(review.label.startsWith('contradicted since trusted by Maya · no run · limits: "local only"'), review.label);
    assert.ok(review.label.endsWith(`later run: ${later.evidence}`), review.label);
    const agent = await read(() => mcp('api_note_context', { operation: WIDGET, stack: 'orders' }));
    assert.equal(labelOf(agent.note_context.records, N1), review.label, 'evidence outranks approval for agents too');
  });

  await t.test('after the journey the fake API saw exactly the runs this test made and no review record holds a response value', () => {
    assert.deepEqual(fake.seen(), made);
    for (const name of ['orders', 'billing']) for (const [operation, entry] of Object.entries(ledger(name).operations)) {
      const records = JSON.stringify([entry.note_reviews ?? [], entry.note_retirements ?? [], entry.note_replacements ?? [], entry.note_review_integrity ?? null]);
      for (const value of VALUES) assert.ok(!records.includes(value), `${name} ${operation} review records hold ${value}`);
    }
  });
});
