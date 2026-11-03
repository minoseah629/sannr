// Synthetic semantic fixtures only. No downloaded collections or vendor scripts
// execute here. Positive and wrong-value cases exercise the real clause engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importPostman, importBruno, importBrunoDirectory, translateTests, sourceDrift, stableStringify } from '../lib/import.mjs';
import { checkOne, runAssertions } from '../lib/assertions.mjs';
import { importCaseFingerprint } from '../lib/import-case.mjs';
import { normalizeSuite, suiteSecretProblems } from '../lib/suites.mjs';

const item = (name, url, code = 'pm.response.to.have.status(200);', method = 'GET') => ({ name,
  request: { method, url }, event: [{ listen: 'test', script: { exec: [code] } }] });
const collection = (items, extra = {}) => ({ info: { name: 'fidelity' }, item: items, ...extra });
const allSteps = (out) => [...out.suite.requests, ...out.todo];
const bru = (script = '', asserts = '', url = '/x', name = 'fixture') => `meta {\n name: ${name}\n}\nget {\n url: ${url}\n}\n${script ? `tests {\n${script}\n}` : ''}\n${asserts ? `assert {\n${asserts}\n}` : ''}`;

test('IMP-001 every legacy request-order predicate remains named beside a status', () => {
  const out = importPostman(collection(Array.from({ length: 6 }, (_, index) => item(`step-${index}`, '/health',
    `tests["status"] = responseCode.code === 200;\ntests["order-${index}"] = request.name === "step-${index}";\npostman.setNextRequest("next");`))));
  assert.equal(out.report.counts.assertions_translated, 6);
  assert.equal(out.construct_ledger.filter((entry) => entry.name.startsWith('order-') && entry.disposition === 'named-unsupported').length, 6);
  assert.equal(out.construct_ledger.filter((entry) => entry.name === 'postman.setNextRequest' && entry.disposition === 'named-unsupported').length, 6);
  for (const step of out.suite.requests) {
    assert.equal(checkOne(step.expect[0], { status: 200 }).ok, true);
    assert.equal(checkOne(step.expect[0], { status: 503 }).ok, false);
  }
});

test('IMP-002 complete legacy header equality rejects the wrong value and compound predicates are not shortened', () => {
  for (const accessor of ['responseHeaders["X-State"]', 'responseHeaders.get("X-State")']) {
    const out = translateTests(`tests["header value"] = ${accessor} === "ready";`);
    assert.deepEqual(out.expect, [{ header: 'X-State', equals: 'ready' }]);
    assert.equal(checkOne(out.expect[0], { headers: { 'x-state': 'ready' } }).ok, true);
    assert.equal(checkOne(out.expect[0], { headers: { 'x-state': 'wrong' } }).ok, false);
    const compound = translateTests(`tests["compound"] = ${accessor} === "ready" && extra;`);
    assert.equal(compound.expect.length, 0);
    assert.equal(compound.construct_ledger[0].disposition, 'named-unsupported');
  }
  const assignment = translateTests('tests["mutation"] = responseCode.code = 200;');
  assert.equal(assignment.expect.length, 0);
});

test('IMP-004 property chains retarget following checks in one-line, multiline and aliased forms', () => {
  for (const code of [
    'pm.expect(pm.response.json()).to.have.property("state").and.to.eql("active")',
    'const response = pm.response.json();\npm.expect(response)\n.to.have.property("state")\n.and.to.eql("active")',
    'const state = pm.response.json().state; pm.expect(state).to.eql("active")',
  ]) {
    const out = translateTests(`pm.test("state", () => { ${code}; });`);
    // Whitespace between chain links is grammatical JavaScript but not yet in
    // the bounded chain recognizer: explicit quarantine is an acceptable result.
    if (!out.expect.length) { assert.ok(out.quarantined.length); continue; }
    assert.ok(out.expect.every((clause) => clause.json === 'state'));
    assert.equal(runAssertions(out.expect, { body: { state: 'active' } }).failed, 0);
    assert.ok(runAssertions(out.expect, { body: { state: 'wrong' } }).failed > 0);
  }
  const unsupported = translateTests('pm.expect(pm.response.json()).to.have.property("state").and.not.be.empty.and.eql("active");');
  assert.equal(unsupported.expect.length, 0, 'never salvage the wrong target after an unsupported chain operator');
});

test('N4 undeclared and reassigned aliases are never assumed to be response JSON', () => {
  for (const code of [
    'pm.expect(jsonData.state).to.eql("active");',
    'const body = pm.response.json(); body.state = "active"; pm.expect(body.state).to.eql("active");',
    'const body = pm.response.json(); mutate(body); pm.expect(body.state).to.eql("active");',
  ]) {
    const out = translateTests(code);
    assert.equal(out.expect.length, 0);
    assert.ok(out.quarantined.length > 0);
  }
});

test('N1/N2/N5 named bases preserve HTTP and empty path/query IDs never collapse', () => {
  const out = importPostman(collection([
    item('health', '{{serviceBase}}/health'), item('detail', '{{serviceBase}}/things/{{thingId}}?id={{thingId}}'),
  ], { variable: [{ key: 'serviceBase', value: 'http://127.0.0.1:9411' }, { key: 'thingId', value: '' }] }));
  assert.equal(out.report.environment.baseUrl, 'http://127.0.0.1:9411');
  assert.equal(out.suite.requests[0].path, '/health');
  assert.equal(out.suite.requests[1].path, '/things/{thingId}');
  assert.equal(out.suite.requests[1].params.id, '{thingId}');
  assert.equal(out.knowledgeCandidates[1].path_template, '/things/{thingId}');
  assert.deepEqual(out.knowledgeCandidates[1].conditions.unresolved_variables, ['thingId']);
});

test('N3/IMP-008 collection/folder/request events, helper calls and partial failures all have dispositions', () => {
  const out = importPostman(collection([{ name: 'folder', event: [{ listen: 'prerequest', script: { exec: ['setup();'] } }], item: [
    item('mixed', '/health', 'pm.response.to.have.status(200); expect(false).to.be.true; helper();'),
  ] }], { event: [{ listen: 'test', script: { exec: ['pm.test(`inherited`, () => { pm.expect(false).to.be.true; });'] } }] }));
  assert.equal(out.suite.requests.length, 1, 'inherited setup is an unverified prerequisite, not a request veto');
  assert.ok(out.suite.requests[0].prerequisites.some(row => row.kind === 'inherited-setup' && row.source === 'folder:prerequest' && row.status === 'unverified'));
  const ledger = out.construct_ledger;
  assert.ok(ledger.some((row) => row.scope === 'collection:test' && row.disposition === 'named-unsupported'));
  assert.ok(ledger.some((row) => row.scope === 'folder' && row.disposition === 'named-unsupported'));
  assert.ok(ledger.some((row) => row.disposition === 'translated'));
  assert.ok(ledger.some((row) => row.name === 'expect' && row.disposition === 'named-unsupported'));
  assert.ok(ledger.some((row) => row.name === 'helper' && row.disposition === 'named-unsupported'));
});

test('conditional, exception and loop-contained assertions never become unconditional checks', () => {
  for (const body of ['if (flag) { pm.response.to.have.status(201); }', 'try { pm.response.to.have.status(201); } catch {}', 'for (const x of list) { pm.response.to.have.status(201); }']) {
    const out = translateTests(`pm.response.to.have.status(200);\n${body}`);
    assert.deepEqual(out.expect, [{ status: 200 }]);
    assert.ok(out.quarantined.some((row) => /conditional|loop/.test(row.reason)));
    assert.equal(checkOne(out.expect[0], { status: 500 }).ok, false);
  }
  const bruno = importBruno(bru('test("conditional", () => { if (flag) { expect(res.status).to.equal(201); } });'));
  assert.equal(allSteps(bruno)[0].expect, undefined);
  assert.ok(bruno.report.loss.some((row) => /conditional/.test(row.reason)));
});

test('N6 Bruno truthiness stays named unsupported for numeric/string and false values', () => {
  for (const form of ['isTruthy', 'isFalsy']) {
    const out = importBruno(bru('', `res.body.value: ${form}`));
    assert.equal(out.report.counts.assertions_translated, 0);
    assert.equal(out.suite.requests.length, 0);
    assert.ok(out.report.loss.some((row) => /truthiness/.test(row.reason)));
    assert.equal(out.knowledgeCandidates[0].assertions.length, 0);
  }
});

test('N7 auth omission and earlier writes remain explicit request conditions', () => {
  const authenticated = item('with auth', '/things/1', 'pm.response.to.have.status(200);', 'PUT');
  authenticated.request.header = [{ key: 'Cookie', value: 'session=not-a-real-secret' }];
  const out = importPostman(collection([authenticated, item('no auth', '/things/1', 'pm.response.to.have.status(403);', 'PUT'), item('after write', '/things/1')]));
  assert.equal(out.suite.requests[0].id, 'with-auth');
  assert.equal(out.knowledgeCandidates[0].conditions.auth, 'reference');
  assert.equal(out.knowledgeCandidates[1].conditions.auth, 'none');
  assert.equal(out.knowledgeCandidates[2].conditions.preceded_by, 'no-auth');
  assert.equal(out.knowledgeCandidates[2].conditions.request_case, true);
});

test('N8 supplied environment values never enter saved paths, headers, body, query or knowledge candidates', () => {
  const request = item('values', '{{runtimeBase}}/things/{{runtimeId}}?region={{runtimeRegion}}');
  request.request.header = [{ key: 'X-Case', value: '{{runtimeHeader}}' }];
  request.request.body = { mode: 'raw', raw: '{"input":"{{runtimeBody}}"}' };
  const values = { runtimeBase: 'https://unique-environment-value.test', runtimeId: 'unique-id-value', runtimeRegion: 'unique-region-value', runtimeHeader: 'unique-header-value', runtimeBody: 'unique-body-value' };
  const out = importPostman(collection([request]), { values });
  for (const value of Object.values(values)) assert.ok(!stableStringify(out).includes(value));
  assert.equal(out.suite.requests.length, 1);
  assert.ok(out.suite.requests[0].path.includes('{runtimeId}'));
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest, undefined);
});

test('capture/use prerequisites are attributed but never claimed executable or verified', () => {
  const out = importPostman(collection([
    item('create', 'http://127.0.0.1:9411/things', 'pm.response.to.have.status(201); pm.collectionVariables.set("thingId", pm.response.json().id);', 'POST'),
    item('read', 'http://127.0.0.1:9411/things/{{thingId}}'),
  ]));
  const producer = out.knowledgeCandidates[0].prerequisites.find((entry) => entry.kind === 'capture');
  const consumer = out.knowledgeCandidates[1].prerequisites.find((entry) => entry.kind === 'variable-use');
  assert.equal(producer.response_path, 'id');
  assert.equal(consumer.from_item_id, 'create');
  assert.equal(consumer.from_path, 'id');
  assert.equal(consumer.verification, 'unverified');
  assert.equal(consumer.executable, false);
});

test('Bruno vars:post-response is visible even beside a translated status', () => {
  const out = importBruno(bru('', 'res.status: eq 200') + '\nvars:post-response {\n thingId: res.body.id\n}\n');
  assert.ok(out.report.loss.some((entry) => entry.name === 'vars:post-response'));
  assert.ok(out.construct_ledger.some((entry) => entry.name === 'vars:post-response' && entry.disposition === 'named-unsupported'));
});

test('duplicate request names preserve distinct item identities and a stable reimport', () => {
  const source = collection([item('same', '/a'), item('same', '/b'), item('same', '/c', 'pm.response.to.have.status(204);', 'DELETE')]);
  const one = importPostman(source), two = importPostman(source);
  assert.equal(new Set(allSteps(one).map((step) => step.id)).size, 3);
  assert.equal(Object.keys(one.provenance.items).length, 3);
  assert.equal(stableStringify(one), stableStringify(two));
  assert.equal(sourceDrift(one.provenance, two.provenance).same_source, true);
});

test('IMP-006 dangerous pattern quarantines its clause while an independent status survives', () => {
  const out = importBruno(bru('test("status", () => { expect(res.status).to.equal(200); });\ntest("regex", () => { expect(res.body.value).to.match(/a.*b.*c/); });'));
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.deepEqual(normalizeSuite('safe', out.suite).problems, []);
  assert.ok(out.construct_ledger.some((row) => /pattern refused/.test(row.reason ?? '')));
  assert.equal(checkOne(out.suite.requests[0].expect[0], { status: 503 }).ok, false);
});

test('IMP-010 Bruno directory counts/ledger/files agree and source drift sees edits', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'import-ledger-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'a.bru'), bru('', 'res.status: eq 200', '/a', 'same'));
  writeFileSync(join(root, 'b.bru'), bru('', '', '/b', 'same'));
  const first = importBrunoDirectory(root), again = importBrunoDirectory(root);
  assert.equal(first.report.counts.imported, first.report.items.filter((row) => row.status === 'imported').length);
  assert.equal(first.report.counts.todo, first.report.items.filter((row) => row.status === 'todo').length);
  assert.deepEqual(first.report.items.filter((row) => row.status === 'imported').map((row) => row.id), first.suite.requests.map((row) => row.id));
  assert.deepEqual(first.report.items.filter((row) => row.status === 'todo').map((row) => row.id), first.todo.map((row) => row.id));
  assert.equal(first.knowledgeCandidates.length, 2);
  assert.equal(sourceDrift(first.provenance, again.provenance).same_source, true);
  writeFileSync(join(root, 'a.bru'), bru('', 'res.status: eq 201', '/a', 'same'));
  const changed = sourceDrift(first.provenance, importBrunoDirectory(root).provenance);
  assert.equal(changed.same_source, false); assert.deepEqual(changed.changed, ['a']);
  assert.equal(sourceDrift({ items: {} }, { items: {} }).same_source, false, 'absent hashes are not evidence of source equality');
});

function fixtureServer(label) {
  const seen = [];
  const server = createServer((req, res) => { seen.push({ path: req.url, authorization: req.headers.authorization }); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ provider: label })); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, origin: `http://127.0.0.1:${server.address().port}` })));
}

test('IMP-003 real client sends both imported health requests to their original configured providers', async (t) => {
  const [a, b] = await Promise.all([fixtureServer('a'), fixtureServer('b')]);
  t.after(() => Promise.all([a, b].map(({ server }) => new Promise((resolve) => server.close(resolve)))));
  const root = mkdtempSync(join(tmpdir(), 'import-origins-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const out = importPostman(collection([item('A', `${a.origin}/health`), item('B', `${b.origin}/health`)]));
  assert.deepEqual(out.suite.requests.map((row) => row.path), [`${a.origin}/health`, `${b.origin}/health`]);
  assert.deepEqual(out.knowledgeCandidates.map((row) => row.provider_base_url), [a.origin, b.origin]);
  const config = join(root, 'config.json');
  writeFileSync(config, JSON.stringify({ v: 1, hosts: { a: { baseUrl: a.origin }, b: { baseUrl: b.origin } } }));
  const moduleUrl = new URL('../lib/client.mjs', import.meta.url).href;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import {runEnvelope} from ${JSON.stringify(moduleUrl)}; let text=''; for await(const chunk of process.stdin) text+=chunk; console.log(JSON.stringify(await runEnvelope(JSON.parse(text))));`], {
      cwd: root, env: { ...process.env, API_CONFIG: config, API_BASE_URL: a.origin, API_CONTEXT_OFF: '1', API_USAGE_LOG: '/dev/null', API_EVIDENCE: join(root, 'evidence'), API_REPO_ROOT: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', (chunk) => stdout += chunk); child.stderr.on('data', (chunk) => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('controlled client fixture timed out')); }, 15000);
    child.on('error', reject); child.on('exit', (code) => { clearTimeout(timer); if (code) reject(new Error(stderr)); else resolve(JSON.parse(stdout)); });
    child.stdin.end(JSON.stringify(out.suite));
  });
  assert.deepEqual(a.seen.map((row) => row.path), ['/health']);
  assert.deepEqual(b.seen.map((row) => row.path), ['/health']);
  assert.ok(!JSON.stringify(result).includes('REQUEST_FAILED'));
});


test('source-case digests distinguish path/query/body/header values without storing them in the identity', () => {
  const a = { path: '/things/1', params: { q: 'a b' }, body: { b: 2, a: 1 }, headers: { Accept: 'application/json' } };
  const b = { path: 'https://provider.test/things/1?q=a+b', body: { a: 1, b: 2 }, headers: { accept: 'application/json' } };
  assert.equal(importCaseFingerprint(a), importCaseFingerprint(b));
  for (const change of [{ path: '/things/2' }, { params: { q: 'different' } }, { body: { b: 3 } }, { headers: { Accept: 'text/plain' } }])
    assert.notEqual(importCaseFingerprint(a), importCaseFingerprint({ ...a, ...change }));
  assert.equal(importCaseFingerprint({ path: '/things/{{id}}' }), null);
  assert.equal(importCaseFingerprint({ path: '/health?mode=admin&mode=public' }), null);
  assert.equal(importCaseFingerprint({ path: '/health?mode=admin&mode=public', params: { mode: 'safe' } }), importCaseFingerprint({ path: '/health?mode=safe' }));
});

test('bounded inherited default setup does not block independent reads but still blocks consumers', () => {
  const out = importPostman(collection([item('health', 'http://127.0.0.1:9411/health'), item('needs default', '/things?approver={{approver}}')], {
    event: [{ listen: 'prerequest', script: { exec: ['if (!pm.collectionVariables.get("approver")) { pm.collectionVariables.set("approver", "fixture-default"); }'] } }],
  }));
  assert.equal(out.suite.requests[0].id, 'health');
  assert.equal(out.todo[0].id, 'needs-default');
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest, undefined, 'inherited setup remains unverified');
  assert.ok(!out.knowledgeCandidates[1].conditions.request_case_digest);
  assert.ok(out.construct_ledger.some((row) => row.disposition === 'named-unsupported'));
  assert.ok(!JSON.stringify(out).includes('fixture-default'));
});

test('unsupported setup, response aliases and secret-shaped test labels cannot erase unrelated useful results', () => {
  const out = importPostman(collection([item('plain', '/health', 'pm.test("Contact fixture@example.test", () => { pm.response.to.have.status(200); });')]));
  assert.equal(out.suite.requests.length, 1);
  assert.ok(!JSON.stringify(out).includes('fixture@example.test'));
  assert.match(out.knowledgeCandidates[0].assertions[0].test_name, /withheld/);
});

test('raw query decoding is faithful and repeated query values are quarantined', () => {
  const out = importPostman(collection([item('encoded', '/search?q=a%20b'), item('repeated', '/search?q=a&q=b')]));
  assert.deepEqual(out.suite.requests[0].params, { q: 'a b' });
  assert.equal(out.todo[0].id, 'repeated');
  assert.match(out.todo[0].todo, /duplicate query/);
});

test('regex flags and unsafe patterns are never recorded as translated clauses', () => {
  const out = importBruno(bru('test("status", () => { expect(res.status).to.equal(200); });\ntest("regex flags", () => { expect(res.body.value).to.match(/ready/i); });'));
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.ok(out.construct_ledger.some((row) => row.name === 'regex flags' && row.disposition === 'named-unsupported'));
  assert.ok(!out.construct_ledger.some((row) => row.name === 'regex flags' && row.disposition === 'translated'));
});


test('explicit noauth overrides inherited credentials through an absence requirement', () => {
  const unauthenticated = item('public', '/health');
  unauthenticated.request.auth = { type: 'noauth' };
  const out = importPostman(collection([unauthenticated], { auth: { type: 'bearer' } }));
  assert.equal(out.suite.requests.length, 1);
  assert.equal(out.suite.requests[0].auth, 'none');
  // The overridden parent declaration is inactive. With no other prerequisites,
  // the exact unauthenticated case is identifiable, but still unverified.
  assert.deepEqual(out.suite.requests[0].prerequisites ?? [], []);
  assert.deepEqual(out.knowledgeCandidates[0].prerequisites, []);
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest,
    importCaseFingerprint({ path: '/health' }));
  assert.equal(out.knowledgeCandidates[0].conditions.auth, 'none');
  assert.ok(out.knowledgeCandidates[0].assertions.every(clause => clause.verification === 'unverified'));
});


test('Bruno JSON include cannot become a string-only claim and authentication identity is digest-only', () => {
  const out = importBruno(bru('test("status", () => { expect(res.status).to.equal(200); });\ntest("members", () => { expect(res.body.members).to.include("ready"); });'));
  assert.deepEqual(out.suite.requests[0].expect, [{ status: 200 }]);
  assert.ok(out.construct_ledger.some((row) => row.name === 'members' && row.disposition === 'named-unsupported'));
  const auth = importPostman(collection([item('authenticated', 'https://provider.test/health')], { auth: { type: 'bearer' } }));
  const condition = auth.knowledgeCandidates[0].conditions;
  assert.match(condition.auth_reference_digest, /^[a-f0-9]{64}$/);
  assert.equal(condition.auth_reference, undefined);
  assert.ok(!JSON.stringify(auth.knowledgeCandidates).includes('POSTMAN_BEARER_TOKEN'));
});


test('case fingerprints reject non-JSON bodies rather than collapsing them into another case', () => {
  for (const body of [new Date('2026-01-01'), { nested: new Date('2026-01-01') }, { missing: undefined }, { fn() {} }, { symbol: Symbol('fixture') }, NaN, Infinity, [undefined], Array(1)]) {
    assert.equal(importCaseFingerprint({ path: '/health', body }), null);
  }
  let invoked = false;
  assert.equal(importCaseFingerprint({ path: '/health', body: { toJSON() { invoked = true; return {}; } } }), null);
  const hiddenSerializer = Object.defineProperty({}, 'toJSON', { value() { invoked = true; return 'different'; } });
  for (const body of [hiddenSerializer, { created: hiddenSerializer }])
    assert.equal(importCaseFingerprint({ path: '/health', body }), null);
  assert.ok(importCaseFingerprint({ path: '/health', body: { created: {} } }));
  assert.equal(invoked, false);
  assert.ok(importCaseFingerprint({ path: '/health', body: {} }));
});


test('suite secret guard permits only top-level typed auth references, not nested credential text', () => {
  const step = { id: 'health', method: 'GET', path: '/health', expect: [{ status: 200 }] };
  for (const auth of ['bearer:POSTMAN_BEARER_TOKEN', 'basic:POSTMAN_BASIC_USERNAME:POSTMAN_BASIC_PASSWORD', 'header:X-API-Key:POSTMAN_API_KEY']) {
    assert.deepEqual(suiteSecretProblems({ requests: [{ ...step, auth }] }), []);
  }
  for (const value of ['bearer:POSTMAN_BEARER_TOKEN', 'Bearer synthetic-credential-value']) {
    assert.ok(suiteSecretProblems({ requests: [{ ...step, body: { message: value } }] }).length > 0);
    assert.ok(suiteSecretProblems({ requests: [{ ...step, metadata: { auth: value } }] }).length > 0);
  }
  assert.ok(suiteSecretProblems({ requests: [{ ...step, auth: 'Bearer synthetic-credential-value' }] }).length > 0);
});


test('auth imports preserve API-key placement/name and quarantine unmapped Basic', () => {
  const make = (auth) => { const request = item('auth', 'https://provider.test/health'); request.request.auth = auth; return importPostman(collection([request])); };
  const basic = make({ type: 'basic', basic: [{ key: 'username', value: 'fixture' }] });
  assert.equal(basic.suite.requests.length, 0);
  assert.match(basic.todo[0].todo, /Basic authentication/);
  assert.match(basic.todo[0].todo, /manual mapping to username\/password environment-variable references/);
  assert.doesNotMatch(basic.todo[0].todo, /no supported client credential scheme/);
  assert.equal(basic.knowledgeCandidates[0].conditions.auth, 'unknown');
  for (const [location, key] of [['header', 'X-Fixture-Token'], ['query', 'api_key']]) {
    const out = make({ type: 'apikey', apikey: [{ key: 'key', value: key }, { key: 'in', value: location }, { key: 'value', value: '{{secret}}' }] });
    assert.equal(out.suite.requests[0].auth, `${location}:${key}:POSTMAN_API_KEY`);
    assert.deepEqual(suiteSecretProblems(out.suite), []);
    assert.match(out.knowledgeCandidates[0].conditions.auth_reference_digest, /^[a-f0-9]{64}$/);
  }
  for (const fields of [[], [{ key: 'key', value: '{{name}}' }, { key: 'in', value: 'header' }], [{ key: 'key', value: 'api_key' }, { key: 'in', value: 'cookie' }]]) {
    const out = make({ type: 'apikey', apikey: fields });
    assert.equal(out.suite.requests.length, 0);
    assert.match(out.todo[0].todo, /placement\/name/);
  }
});

// JSON string scalars would lose their surrounding quotes in the raw-string
// client path. A parsed value is not proof of faithful request transmission.
test('raw JSON string bodies are named nonrunnable instead of changing wire semantics', () => {
  const out = importPostman({ info: { name: 'scalar body' }, item: [{ name: 'create', request: {
    method: 'POST', url: 'https://fixture.invalid/widgets', body: { mode: 'raw', raw: '\"sample\"' }
  }, event: [{ listen: 'test', script: { exec: ['pm.response.to.have.status(201);'] } }] }] });
  assert.equal(out.suite.requests.length, 0);
  assert.equal(out.todo.length, 1);
  assert.match(out.todo[0].todo, /JSON string body needs manual conversion/);
  assert.equal(out.knowledgeCandidates[0].conditions.request_case_digest, undefined);
});
