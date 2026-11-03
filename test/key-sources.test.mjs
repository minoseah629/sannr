// MAP-1C pure rules: which values can link a key, how parameter values are
// derived, how response fields are named, how the source is chosen and how
// links merge into a record within bounds. Every value here is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEY_SOURCE_BOUNDS, eligibleValue, deriveParameterValues, fieldValues, carriedValues, chooseSources,
  mergeKeySources, storedKeySources, dynamicKey, validField, lastName } from '../lib/key-sources.mjs';

const digest = char => `sha256:${char.repeat(64)}`;
const link = (overrides = {}) => ({ param: 'id', location: 'path',
  source: { operation: 'GET /things', field: 'data[].id' },
  first_observed_at: '2026-10-01T00:00:00.000Z', last_observed_at: '2026-10-01T00:00:00.000Z',
  also_seen: 0, evidence: { run_id: 'run-aaaa', digest: digest('a') }, ...overrides });
const run = (overrides = {}) => ({ run_id: 'run-1', digest: digest('1'), observed_at: '2026-10-01T00:00:00.000Z',
  operation: 'GET /things', status: 200, matches: new Map(), carried: new Set(), ...overrides });

test('MAP-1C ineligible values never link: ISO dates and datetimes, booleans, short strings, small integers, secret-shaped values', () => {
  for (const value of ['2026-10-05', '2026-10', '2026-10-05T12:30:00Z', '2026-10-05T12:30:00.123+02:00', '2026-10-05 12:30',
    true, false, 'true', 'FALSE', 'abc', '', 999, 0, -5000, 12.5, '999', '0999', '-1234', '12.50', '1e9', null, undefined,
    { id: 'thing-9001' }, ['thing-9001'], 'sk_live_abcdefghijklmnop', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
    'person@example.invalid', '[redacted]', 'prefix-[redacted]-suffix'])
    assert.equal(eligibleValue(value), null, `${JSON.stringify(value)} must not be eligible`);
  assert.equal(eligibleValue('thing-9001'), 'thing-9001');
  assert.equal(eligibleValue('abcd'), 'abcd');
  assert.equal(eligibleValue(1000), '1000');
  assert.equal(eligibleValue(4294967296), '4294967296');
  assert.equal(eligibleValue('1000'), '1000');
  assert.equal(eligibleValue('00001234'), '00001234');
  assert.equal(eligibleValue(2 ** 60), null, 'an unsafe integer has no exact comparison form');
});

test('MAP-1C parameter values come from the endpoint template: path segments, literal prefixes and eligible query values', () => {
  const endpoint = 'http://127.0.0.1:9/v2/things/{thingId}/files/{name}.json';
  const url = 'http://127.0.0.1:9/v2/things/thing-9001/files/report%20one.json?timezone=Europe%2FLisbon&page=2&flag=true&when=2026-10-05';
  assert.deepEqual(deriveParameterValues(url, { operation: 'GET /things/{thingId}/files/{name}.json', endpoint }), [
    { param: 'thingId', location: 'path', value: 'thing-9001' },
    { param: 'name', location: 'path', value: 'report one' },
    { param: 'timezone', location: 'query', value: 'Europe/Lisbon' },
  ]);
  // One optional trailing slash, as the route matcher allows.
  assert.equal(deriveParameterValues('http://127.0.0.1:9/v2/things/thing-9001/files/abcd.json/', { endpoint }).length, 2);
  // A different literal, a different origin or an ineligible key value derives nothing.
  assert.deepEqual(deriveParameterValues('http://127.0.0.1:9/v2/thing/thing-9001/files/abcd.json', { endpoint }), []);
  assert.deepEqual(deriveParameterValues('http://127.0.0.1:8/v2/things/thing-9001/files/abcd.json', { endpoint }), []);
  assert.deepEqual(deriveParameterValues('http://127.0.0.1:9/v2/things/999/files/x.json', { endpoint }), []);
  // Several parameters in one segment are not split; a secret-shaped parameter name is never recorded.
  assert.deepEqual(deriveParameterValues('http://h.invalid/a/thing-9001.v2000', { endpoint: 'http://h.invalid/a/{id}.v{version}' }), []);
  assert.deepEqual(deriveParameterValues('http://h.invalid/a?api_key=thing-9001&person%40example.invalid=thing-9001',
    { operation: 'GET /a' }), [{ param: 'api_key', location: 'query', value: 'thing-9001' }]);
});

test('MAP-1C response fields are names only: array positions become [] and dynamic object keys become {}', () => {
  const uuid = 'f81d4fae-7dec-11d0-a765-00a0c91e6bf6';
  const body = { data: [{ id: 'thing-9001', owner: { id: 'owner-1234' } }, { id: 'thing-9002' }],
    byId: { [uuid]: { id: 'thing-9001' }, '1042': { id: 'thing-9001' }, 'cus_9s8d7f6g5h': { id: 'thing-9001' },
      'dev-1001': { id: 'thing-9001' }, 'two words': { id: 'thing-9001' }, 'a.b': { id: 'thing-9001' },
      'sk_live_abcdefghijklmnop': { id: 'thing-9001' }, 'person@example.invalid': { id: 'thing-9001' } },
    payment_intent_id: 'pi-12345', address_line_2: 'flat-1234' };
  const found = fieldValues(body);
  assert.deepEqual(found.get('thing-9001'), ['data[].id', 'byId.{}.id']);
  assert.deepEqual(found.get('owner-1234'), ['data[].owner.id']);
  assert.deepEqual(found.get('pi-12345'), ['payment_intent_id'], 'a structural snake_case name stays a name');
  // A digit-bearing key is not word-shaped: it is a name only when the contract declares it.
  assert.deepEqual(found.get('flat-1234'), ['{}']);
  assert.deepEqual(fieldValues(body, { declaredNames: new Set(['address_line_2']) }).get('flat-1234'), ['address_line_2']);
  const stored = JSON.stringify([...found.values()]);
  for (const key of [uuid, '1042', 'cus_9s8d7f6g5h', 'dev-1001', 'two words', 'a.b', 'sk_live', 'person@example'])
    assert.ok(!stored.includes(key), `${key} must not appear in a field path`);
  // Root arrays, a key equal to a linked value, root scalars and over-long paths.
  assert.deepEqual(fieldValues([{ id: 'thing-9001' }]).get('thing-9001'), ['[].id']);
  assert.deepEqual(fieldValues({ Lisbon: { name: 'Lisbon' } }, { wanted: new Set(['Lisbon']) }).get('Lisbon'), ['{}.name'],
    'a key equal to a value being linked is data');
  assert.deepEqual(fieldValues({ Lisbon: { name: 'Lisbon' } }).get('Lisbon'), ['Lisbon.name']);
  assert.equal(fieldValues('thing-9001').size, 0);
  let deep = 'thing-9001';
  for (let index = 0; index < 60; index++) deep = { level_name: deep };
  assert.equal(fieldValues(deep).size, 0, `a path beyond ${KEY_SOURCE_BOUNDS.maxFieldChars} characters is not collected`);
  assert.equal(dynamicKey('updated_at'), false);
  assert.equal(dynamicKey('x-request-id'), false);
  for (const field of ['data[].id', '[].id', 'byId.{}.id', '{}', 'a[][].b']) assert.equal(validField(field), true, field);
  for (const field of ['', '.id', 'a..b', 'a.[].b', 'a b', 'x'.repeat(257), 'data[].sk_live_abcdefghijklmnop', 'a[]x', 'a.{b}'])
    assert.equal(validField(field), false, field);
  assert.equal(lastName('data[].timezone'), 'timezone');
  assert.equal(lastName('byId.{}'), '{}');
});

test('MAP-1C the response walk checks the time budget inside one large body', () => {
  const big = { rows: Array.from({ length: 5000 }, (_, index) => ({ id: `row-${index}0000` })) };
  assert.throws(() => fieldValues(big, { deadline: 0, clock: () => 1 }), { code: 'KEY_SOURCE_BUDGET_EXCEEDED' });
  assert.equal(fieldValues(big, { deadline: 2, clock: () => 1 }).size, 5000);
  try { fieldValues(big, { wanted: new Set(['row-10000']), deadline: 0, clock: () => 1 }); }
  catch (error) { assert.doesNotMatch(error.message, /row-/, 'the budget error carries no value'); }
});

test('MAP-1C the earliest prior 2xx response is the source; also_seen counts other pairs; echoes and errors are not sources', () => {
  const wanted = new Set(['thing-9001']);
  const candidates = [{ param: 'id', location: 'path', value: 'thing-9001' }];
  const list = run({ run_id: 'run-list', observed_at: '2026-10-01T00:00:02.000Z',
    matches: fieldValues({ data: [{ id: 'thing-9001', parent_id: 'thing-9001' }] }, { wanted }) });
  const echo = run({ run_id: 'run-echo', operation: 'GET /things/{id}', observed_at: '2026-10-01T00:00:01.000Z',
    matches: fieldValues({ id: 'thing-9001' }, { wanted }),
    carried: carriedValues({ url: 'http://h.invalid/things/thing-9001' }, wanted) });
  const failed = run({ run_id: 'run-404', status: 404, observed_at: '2026-10-01T00:00:00.000Z',
    matches: fieldValues({ missing: 'thing-9001' }, { wanted }) });
  const other = run({ run_id: 'run-other', operation: 'GET /others', observed_at: '2026-10-01T00:00:03.000Z',
    matches: fieldValues({ items: [{ thing_ref: 'thing-9001' }] }, { wanted }) });
  const [chosen] = chooseSources(candidates, [other, failed, echo, list]);
  assert.deepEqual(chosen.source, { operation: 'GET /things', field: 'data[].id' });
  assert.equal(chosen.also_seen, 2, 'data[].parent_id and GET /others items[].thing_ref also held the value');
  assert.deepEqual(chosen.evidence, { run_id: 'run-list', digest: digest('1') });
  assert.deepEqual(chooseSources(candidates, [echo, failed]), [], 'an echo of the request and an error body are not sources');
  // A request body carried the value: POST responses echoing it are not sources either.
  assert.equal(carriedValues({ url: 'http://h.invalid/things', body: { name: 'thing-9001' } }, wanted).has('thing-9001'), true);
});

test('MAP-1C query parameters link only to a field whose last name equals the parameter name', () => {
  const wanted = new Set(['Europe/Lisbon']);
  const source = run({ matches: fieldValues({ data: [{ region: 'Europe/Lisbon', timezone: 'Europe/Lisbon' }] }, { wanted }) });
  const [byName] = chooseSources([{ param: 'timezone', location: 'query', value: 'Europe/Lisbon' }], [source]);
  assert.deepEqual(byName.source, { operation: 'GET /things', field: 'data[].timezone' });
  assert.equal(byName.also_seen, 0, 'the region field does not count for the timezone parameter');
  assert.deepEqual(chooseSources([{ param: 'zone', location: 'query', value: 'Europe/Lisbon' }], [source]), []);
  // A path parameter takes any field, preferring one named like the parameter.
  const [path] = chooseSources([{ param: 'timezone', location: 'path', value: 'Europe/Lisbon' }], [source]);
  assert.equal(path.source.field, 'data[].timezone');
  assert.equal(path.also_seen, 1);
});

test('MAP-1C merging is bounded, keeps the most recent distinct sources and is idempotent in any order', () => {
  const at = second => `2026-10-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  const sourceA = link({ last_observed_at: at(5), first_observed_at: at(5) });
  const sourceB = link({ source: { operation: 'GET /others', field: 'items[].thing_ref' }, first_observed_at: at(4), last_observed_at: at(4) });
  const sourceC = link({ source: { operation: 'GET /older', field: 'rows[].id' }, first_observed_at: at(3), last_observed_at: at(3) });
  const merged = mergeKeySources([], [sourceC, sourceA, sourceB]);
  assert.deepEqual(merged.map(item => item.source.operation), ['GET /things', 'GET /others'], 'two most recent distinct sources per parameter');
  assert.deepEqual(mergeKeySources(merged, [sourceC, sourceA, sourceB]), merged, 'merging the same links again changes nothing');
  assert.deepEqual(mergeKeySources([], [sourceB, sourceA, sourceC]), merged, 'arrival order does not matter');
  // A repeated link widens its dates; the latest observation supplies the count and evidence.
  const later = link({ first_observed_at: at(9), last_observed_at: at(9), also_seen: 3, evidence: { run_id: 'run-bbbb', digest: digest('b') } });
  const [widened] = mergeKeySources([sourceA], [later]);
  assert.equal(widened.first_observed_at, at(5));
  assert.equal(widened.last_observed_at, at(9));
  assert.equal(widened.also_seen, 3);
  assert.equal(widened.evidence.run_id, 'run-bbbb');
  // Sixteen entries per record, the most recent kept.
  const many = Array.from({ length: 20 }, (_, index) => link({ param: `p${String(index).padStart(2, '0')}x`,
    first_observed_at: at(index), last_observed_at: at(index) }));
  const bounded = mergeKeySources([], many);
  assert.equal(bounded.length, KEY_SOURCE_BOUNDS.maxEntries);
  assert.ok(!bounded.some(item => ['p00x', 'p01x', 'p02x', 'p03x'].includes(item.param)));
  assert.deepEqual(storedKeySources(bounded), bounded);
});
