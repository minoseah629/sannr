// MAP-1C fix round 1 (lead rulings after QA round 1): the echo rule, object
// keys in field paths, eligibility, contract rules and the record's bound.
// Every value is synthetic. Functions are read from the module namespace so a
// test against an engine without them fails on its own assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ks from '../lib/key-sources.mjs';

const fn = name => {
  assert.equal(typeof ks[name], 'function', `lib/key-sources.mjs exports ${name}`);
  return ks[name];
};
const digest = char => `sha256:${char.repeat(64)}`;
const link = (overrides = {}) => ({ param: 'id', location: 'path',
  source: { operation: 'GET /things', field: 'data[].id' },
  first_observed_at: '2026-10-01T00:00:00.000Z', last_observed_at: '2026-10-01T00:00:00.000Z',
  also_seen: 0, evidence: { run_id: 'run-aaaa', digest: digest('a') }, ...overrides });
const run = (overrides = {}) => ({ run_id: 'run-1', digest: digest('1'), observed_at: '2026-10-01T00:00:00.000Z',
  operation: 'GET /things', status: 200, matches: new Map(), carried: new Set(), ...overrides });

test('MAP-1C B1 a request carried a value anywhere: inside a segment, a query key or value, a header, or the body', () => {
  const ID = 'thing-QA1-0a1b2c', wanted = new Set([ID]);
  const carried = request => ks.carriedValues(request, wanted).has(ID);
  for (const request of [
    { url: `http://h.invalid/things/${ID}.json` },
    { url: `http://h.invalid/jobs/${ID}:cancel` },
    { url: `http://h.invalid/items/v-${encodeURIComponent(ID)}-x` },
    { url: `http://h.invalid/search?filter=${encodeURIComponent(`id:${ID}`)}` },
    { url: `http://h.invalid/search?${encodeURIComponent(ID)}=1` },
    { url: 'http://h.invalid/x', headers: { 'x-trace': `ref=${ID};` } },
    { url: 'http://h.invalid/x', body: { filter: `id eq ${ID}` } },
    { url: 'http://h.invalid/x', body: { [`${ID}-key`]: true } },
    { url: 'http://h.invalid/x', body: `raw=${ID}&x=1` },
  ]) assert.equal(carried(request), true, JSON.stringify(request));
  assert.equal(ks.carriedValues({ url: 'http://h.invalid/x', body: { ids: [9912349912] } }, new Set(['1234'])).has('1234'), true,
    'a number in the body carries its digits');
  assert.equal(carried({ url: 'http://h.invalid/things/thing-QA1-0a1b', body: { other: 'nothing' } }), false,
    'a request that never carried the value does not exclude its response');

  // QA's four variants: none of these responses is the source of the id.
  const echoRun = (operation, url) => run({ run_id: `run-${operation.length}`, operation,
    matches: ks.fieldValues({ id: ID }, { wanted }), carried: ks.carriedValues({ url }, wanted) });
  const candidates = [{ param: 'id', location: 'path', value: ID }];
  assert.deepEqual(ks.chooseSources(candidates, [echoRun('GET /things/{id}.json', `http://h.invalid/things/${ID}.json`)]), [],
    'a repeated {id}.json call is not the source of its own id');
  assert.deepEqual(ks.chooseSources(candidates, [echoRun('GET /things/{id}.json', `http://h.invalid/things/${ID}.json`),
    echoRun('POST /jobs/{id}:cancel', `http://h.invalid/jobs/${ID}:cancel`)]), [],
    'an {id}:cancel call and a plain /items/{id} call do not take the .json echo as their source');
  const search = run({ run_id: 'run-search', operation: 'GET /search', matches: ks.fieldValues({ data: [{ id: ID }] }, { wanted }),
    carried: ks.carriedValues({ url: `http://h.invalid/search?filter=${encodeURIComponent(`id:${ID}`)}` }, wanted) });
  assert.deepEqual(ks.chooseSources(candidates, [search]), [], 'a search whose filter carried the id is not its source');
});

// QA's 20-format matrix (s2-sweep-keys.mjs): id-shaped keys of common formats.
const MAP_KEYS = {
  'f81d4fae-7dec-11d0-a765-00a0c91e6bf6': 'uuid', '1042': 'numeric', '507f1f77bcf86cd799439011': 'mongo-objectid',
  'cus_9s8d7f6gQA2': 'stripe-prefixed', 'U0QA2ABCD9': 'slack-user-id', 'V1StGXR8_Z5jdHi6B-myT': 'nanoid',
  '-NQA2abcDEF1234567': 'firebase-push-id', 'abc123qa': 'short-alnum', 'thing-QA2-x9': 'multi-hyphen-id',
  'octo/repoQA2': 'owner/repo', 'aliceqa': 'username', 'dQw4w9WgXcQ': 'youtube-id', 'a1b2c3d': 'git-short-sha',
  'ord8842': 'letters+digits', 'user_alice': 'snake-username', 'SKU-WIDGET-QA2': 'multi-hyphen-sku', '2026-10-05': 'date-key',
  'sk_live_QA2keyname0123456': 'secret-shaped-key', 'qa2-owner@example.com': 'email-key', 'api_key=QA2abcdef123': 'inline-credential-key',
};

test('MAP-1C B2 every key of QA\'s 20-format id map is recorded as {}', () => {
  const teams = Object.fromEntries(Object.keys(MAP_KEYS).map((key, index) => [key, { team: `team-QA2-${1000 + index}` }]));
  const body = { data: [{ id: 'thing-QA2-a1b2c3' }], byId: teams };
  const found = ks.fieldValues(body, { wanted: new Set(Object.values(teams).map(team => team.team)) });
  for (const [key, kind] of Object.entries(MAP_KEYS))
    assert.deepEqual(found.get(teams[key].team), ['byId.{}.team'], `${kind} (${key})`);
  const stored = JSON.stringify([...found.values()]);
  for (const key of Object.keys(MAP_KEYS)) assert.ok(!stored.includes(key), `${MAP_KEYS[key]} key never in a field path`);
});

test('MAP-1C B2 a key is kept only when the contract declares it or it is a word outside a structural map', () => {
  const keep = fn('keepObjectKey'), isMap = fn('structuralMap');
  // Single-entry maps (QA's B2 reproduction and the other digit-bearing formats).
  for (const key of ['U024BE7LH', 'U0QA2ABCD9', 'abc123qa', 'thing-QA2-x9', 'dQw4w9WgXcQ', 'a1b2c3d', 'ord8842', 'line1'])
    assert.deepEqual(ks.fieldValues({ members: { [key]: { team_id: 'team-B2-0001' } } }).get('team-B2-0001'), ['members.{}.team_id'], key);
  // Word-shaped keys stay names outside a structural map; inside one they are data.
  for (const key of ['team_id', 'updated_at', 'x-request-id', 'Timezone', '_links']) assert.equal(keep(key), true, key);
  for (const key of ['line1', 'sha256', 'v2', 'a.b', 'two words', 'U0QA2ABCD9', '-leading']) assert.equal(keep(key), false, key);
  assert.equal(keep('pending', { wanted: new Set(['pending']) }), false, 'a key equal to the linked value is data');
  assert.equal(keep('alice', { parentIsMap: true }), false);
  assert.equal(keep('address_line_2', { declared: new Set(['address_line_2']) }), true, 'a declared property is a name');
  assert.equal(keep('a.b', { declared: new Set(['a.b']) }), false, 'a declared name must still be writable unambiguously');
  assert.equal(isMap({ alice: { role: 'x', id: 1 }, bob: { id: 2, role: 'y' } }), true, 'objects with identical key sets');
  // (All-arrays objects: see the fix round 2 test, ruling A1.)
  assert.equal(isMap({ alice: { role: 'x' }, bob: { id: 2 } }), false, 'different key sets');
  assert.equal(isMap({ only: { id: 1 } }), false, 'one key is not a map');
  assert.equal(isMap({ data: [], total: 2 }), false, 'mixed values');
  assert.deepEqual(ks.fieldValues({ users: { alice: { team_id: 'team-B2-0002' }, bob: { team_id: 'team-B2-0003' } } }).get('team-B2-0002'),
    ['users.{}.team_id']);
  // Documented residual (docs/protocols.md): a single-entry map keyed by a
  // digit-free word cannot be told from a field name by shape alone.
  assert.deepEqual(ks.fieldValues({ users: { aliceqa: { team_id: 'team-B2-0004' } } }).get('team-B2-0004'), ['users.aliceqa.team_id']);
  assert.equal(ks.dynamicKey('updated_at'), false);
  assert.equal(ks.dynamicKey('address_line_2'), true);
});

test('MAP-1C B2 declared property names come from schema properties only, never from example values', () => {
  const doc = { openapi: '3.0.0', paths: { '/x': { get: { responses: { 200: { content: { 'application/json': {
    schema: { type: 'object', properties: { address_line_2: { type: 'string' }, members: { type: 'object' } },
      example: { properties: { leaked_example_name: 1 } } },
    examples: { one: { value: { properties: { leaked_examples_name: 1 } } } } } } } } } } },
    components: { schemas: { Team: { properties: { team_id: { type: 'string' } }, default: { properties: { leaked_default: 1 } } } } } };
  const names = fn('declaredPropertyNames')(doc);
  assert.deepEqual([...names].sort(), ['address_line_2', 'members', 'team_id']);
  assert.deepEqual([...fn('contractKeyProfile')(doc).declaredNames].sort(), ['address_line_2', 'members', 'team_id']);
});

test('MAP-1C B4 by shape: whitespace, null tokens and dates written with separators or month names never link', () => {
  // (Which date shapes count as dates is narrowed by the fix round 2 test, ruling N2.)
  for (const value of ['    ', ' padded', 'padded ', '\tthing-1234', 'null', 'NULL', 'Undefined', 'none', 'None', 'NIL', 'n/a', 'N/A',
    '2026/10/05', '10/05/2026', '05.10.2026', '5-10-2026', 'Mon, 05 Oct 2026 10:00:00 GMT',
    'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994', 'Mon, 5 Oct 2026 10:00:00 +0000', '5 Oct 2026',
    'October 5, 2026', 'Oct 5th, 2026'])
    assert.equal(ks.eligibleValue(value), null, `${JSON.stringify(value)} must not be eligible`);
  // Compact dates, epoch numbers, years and unconstrained words stay eligible by shape.
  for (const value of ['20261005', '1759658400', '2026', 'active', 'widget', 'march-madness-x', 'sunday-special', 'Oct-report',
    '1.2.3', 'v1.2.33', '1.20.300'])
    assert.equal(ks.eligibleValue(value), value, `${JSON.stringify(value)} stays eligible`);
  assert.equal(ks.eligibleValue(1759658400), '1759658400');
});

const OAS = { openapi: '3.0.0',
  components: {
    parameters: { Status: { name: 'status', in: 'query', schema: { type: 'string', enum: ['pending', 'shipped'] } } },
    schemas: { Order: { type: 'object', properties: { status: { type: 'string', enum: ['pending'] }, created: { type: 'string', format: 'date-time' },
      day: { allOf: [{ type: 'string' }, { format: 'date' }] }, id: { type: 'string' }, year: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string', enum: ['x'] } }, extra: { type: 'object', additionalProperties: { type: 'string', format: 'time' } } } } } },
  paths: {
    '/orders': { parameters: [{ name: 'region', in: 'query', schema: { type: 'string', format: 'date' } }],
      get: { parameters: [{ $ref: '#/components/parameters/Status' }, { name: 'flag', in: 'query', schema: { type: 'boolean' } },
        { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'ids', in: 'query', schema: { type: 'array', items: { type: 'string', enum: ['a'] } } }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'object', properties: {
          data: { type: 'array', items: { $ref: '#/components/schemas/Order' } } } } } } } } } },
    '/days/{day}': { get: { parameters: [{ name: 'day', in: 'path', required: true, schema: { type: 'string', format: 'date' } }] } },
    '/at/{t}': { get: { parameters: [{ name: 't', in: 'path', required: true, schema: { oneOf: [{ type: 'string' }, { type: 'string', format: 'time' }] } }] } },
    '/things/{id}': { get: { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }] } },
  } };
const SWAGGER = { swagger: '2.0', basePath: '/v1', paths: { '/items': { get: {
  parameters: [{ name: 'kind', in: 'query', type: 'string', enum: ['a'] }, { name: 'when', in: 'query', type: 'string', format: 'date-time' },
    { name: 'ids', in: 'query', type: 'array', items: { type: 'string', enum: ['x'] } }, { name: 'free', in: 'query', type: 'string' }],
  responses: { 200: { schema: { type: 'object', properties: { kind: { type: 'string', enum: ['a'] }, name: { type: 'string' } } } } } } } } };

test('MAP-1C B4 the contract pins parameters (enum, boolean, date formats) and response fields (enum, date formats)', () => {
  const profile = fn('contractKeyProfile')(OAS);
  const pinned = (operation, location, name) => profile.parameterUnlinkable(operation, location, name);
  assert.equal(pinned('GET /orders', 'query', 'status'), true, 'enum through a $ref parameter');
  assert.equal(pinned('GET /orders', 'query', 'flag'), true, 'boolean');
  assert.equal(pinned('GET /orders', 'query', 'region'), true, 'path-level date parameter');
  assert.equal(pinned('GET /orders', 'query', 'ids'), true, 'array items enum');
  assert.equal(pinned('GET /orders', 'query', 'q'), false);
  assert.equal(pinned('GET /orders', 'query', 'undeclared'), false);
  assert.equal(pinned('GET /days/{day}', 'path', 'day'), true, 'date path parameter');
  assert.equal(pinned('GET /at/{t}', 'path', 't'), true, 'time format inside oneOf');
  assert.equal(pinned('GET /things/{id}', 'path', 'id'), false);
  assert.equal(pinned('GET /missing', 'path', 'id'), false, 'an operation the contract does not describe pins nothing');
  const field = (operation, path) => profile.fieldUnlinkable(operation, path);
  assert.equal(field('GET /orders', 'data[].status'), true, 'enum field through $ref items');
  assert.equal(field('GET /orders', 'data[].created'), true, 'date-time field');
  assert.equal(field('GET /orders', 'data[].day'), true, 'date format inside allOf');
  assert.equal(field('GET /orders', 'data[].tags[]'), true, 'array items enum');
  assert.equal(field('GET /orders', 'data[].extra.{}'), true, 'additionalProperties format');
  assert.equal(field('GET /orders', 'data[].id'), false);
  assert.equal(field('GET /orders', 'data[].year'), false, 'an integer field without a date format stays a source');
  assert.equal(field('GET /orders', 'data[].unknown'), false, 'a field the contract does not describe');
  assert.equal(field('GET /days/{day}', 'day'), false, 'no response schema: the contract does not describe the response');
  const swagger = fn('contractKeyProfile')(SWAGGER);
  assert.equal(swagger.parameterUnlinkable('GET /v1/items', 'query', 'kind'), true, 'Swagger 2 inline enum under basePath');
  assert.equal(swagger.parameterUnlinkable('GET /v1/items', 'query', 'when'), true);
  assert.equal(swagger.parameterUnlinkable('GET /v1/items', 'query', 'ids'), true);
  assert.equal(swagger.parameterUnlinkable('GET /v1/items', 'query', 'free'), false);
  assert.equal(swagger.fieldUnlinkable('GET /v1/items', 'kind'), true);
  assert.equal(swagger.fieldUnlinkable('GET /v1/items', 'name'), false);
});

test('MAP-1C B6 the 16-entry bound keeps path keys before same-time query keys', () => {
  const at = '2026-10-01T00:00:05.000Z';
  const path = link({ param: 'thingId', location: 'path', first_observed_at: at, last_observed_at: at });
  const queries = Array.from({ length: 16 }, (_, index) => link({ param: `a${String(index).padStart(2, '0')}`, location: 'query',
    source: { operation: 'GET /things', field: `data[].a${String(index).padStart(2, '0')}` }, first_observed_at: at, last_observed_at: at }));
  const merged = ks.mergeKeySources([], [...queries, path]);
  assert.equal(merged.length, 16);
  assert.ok(merged.some(item => item.location === 'path' && item.param === 'thingId'), 'the path key is kept');
  assert.equal(merged.filter(item => item.location === 'query').length, 15);
  // Within a location the most recent are kept, as before.
  const older = link({ param: 'thingId', location: 'path', source: { operation: 'GET /old', field: 'rows[].id' },
    first_observed_at: '2026-10-01T00:00:01.000Z', last_observed_at: '2026-10-01T00:00:01.000Z' });
  const newer = link({ param: 'thingId', location: 'path', source: { operation: 'GET /new', field: 'rows[].id' },
    first_observed_at: '2026-10-01T00:00:09.000Z', last_observed_at: '2026-10-01T00:00:09.000Z' });
  const kept = ks.mergeKeySources([], [older, newer, path]).map(item => item.source.operation);
  assert.deepEqual(kept, ['GET /new', 'GET /things'], 'the two most recent sources of the path key');
});
