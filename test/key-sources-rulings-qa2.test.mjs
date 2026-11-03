// MAP-1C fix round 2 (lead rulings after QA round 2): date shapes are complete
// calendar dates only (N2), an object of arrays is not a structural map (A1),
// and JSON:API member, attribute and relationship names are field names (A2).
// Every value is synthetic. Functions are read from the module namespace so a
// test against an engine without them fails on its own assertion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ks from '../lib/key-sources.mjs';

const fn = name => {
  assert.equal(typeof ks[name], 'function', `lib/key-sources.mjs exports ${name}`);
  return ks[name];
};
const eligible = value => ks.eligibleValue(value) === value;

test('MAP-1C N2 identifiers that only resemble dates are eligible: QA\'s four and their kin', () => {
  // QA's four (round 1 blocked them; they linked before it).
  for (const value of ['APR-721', 'MAY-1001', '1.2.10', '2026-278']) assert.equal(eligible(value), true, value);
  // A month abbreviation followed by digits, a month name without a day or a year, a dotted
  // version, a two-digit year, an ISO week or ordinal form, and numbers that are no date.
  for (const value of ['DEC-7', 'JUN-88', 'OCT-42', 'Sept-12', 'May 2026', '1 Oct', 'MAR-2026-15', '2.4.11', '18.3.10',
    '10.11.12', '3-4-26', '10/5/26', '2026-W41', '2026-W41-1', '2026.10.05', '13/13/2026', '32.10.2026', '05.13.2026'])
    assert.equal(eligible(value), true, value);
});

test('MAP-1C N2 every listed date form stays ineligible: four-digit-year separated dates, RFC 7231 and 2822, month names', () => {
  for (const value of [
    // YYYY/MM/DD, MM/DD/YYYY, DD/MM/YYYY (either order when both fit), DD.MM.YYYY, DD-MM-YYYY.
    '2026/10/05', '2026/1/5', '10/05/2026', '05/10/2026', '12/25/2026', '25/12/2026', '05.10.2026', '5.10.2026', '05-10-2026', '5-10-2026',
    // RFC 7231 (IMF-fixdate, RFC 850, asctime) and RFC 2822, with and without a weekday.
    'Mon, 05 Oct 2026 10:00:00 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994',
    'Mon, 5 Oct 2026 10:00:00 +0000', '5 Oct 2026 10:00:00 -0700',
    // A month name with a day and a four-digit year.
    'Oct 5, 2026', 'Oct 5 2026', '5 October 2026', 'October 5th, 2026', 'Oct. 5, 2026', '05-Oct-2026', '2026-Oct-05',
    'Monday, October 5, 2026', 'Oct 5, 2026 10:00 AM PST',
    // The ISO forms of the work order.
    '2026-10-05', '2026-10', '2026-10-05T10:00:00Z',
  ]) assert.equal(ks.eligibleValue(value), null, `${JSON.stringify(value)} is a date`);
});

test('MAP-1C A1 an object whose values are all arrays is not a structural map; record arrays keep their names', () => {
  const isMap = fn('structuralMap');
  assert.equal(isMap({ data: [1], included: [] }), false);
  assert.equal(isMap({ items: [{ id: 1 }], errors: [] }), false);
  assert.equal(isMap({ alice: { team_id: 1 }, bob: { team_id: 2 } }), true, 'objects with identical key sets still are');
  const fields = body => Object.fromEntries([...ks.fieldValues(body)].map(([value, list]) => [value, list]));
  assert.deepEqual(fields({ data: [{ id: 'row-A1-0001' }], included: [{ id: 'row-A1-0002' }] }),
    { 'row-A1-0001': ['data[].id'], 'row-A1-0002': ['included[].id'] });
  assert.deepEqual(fields({ items: [{ id: 'row-A1-0003' }], errors: [] }), { 'row-A1-0003': ['items[].id'] });
  assert.deepEqual(fields({ rows: [{ n: 'row-A1-0004' }], results: [{ id: 'row-A1-0005' }] }),
    { 'row-A1-0004': ['rows[].n'], 'row-A1-0005': ['results[].id'] });
});

// A JSON:API compound document: two relationships of one shared value shape (a
// structural map by shape), attributes whose values share a shape, and an
// included resource.
const ARTICLE = 'art-JSN-0001', CATEGORY = 'cat-JSN-0002', AUTHOR = 'ppl-JSN-0003', TAG = 'tag-JSN-0004';
const JSON_API_DOCUMENT = { data: [{ type: 'articles', id: ARTICLE,
  attributes: { title: { en: 'title-JSN-en', de: 'title-JSN-de' }, summary: { en: 'sum-JSN-en', de: 'sum-JSN-de' } },
  relationships: { category: { data: { type: 'categories', id: CATEGORY } }, author: { data: { type: 'people', id: AUTHOR } } } }],
  included: [{ type: 'tags', id: TAG }], meta: { total: 1 }, links: { self: 'http://h.invalid/articles' } };

test('MAP-1C A2 JSON:API member, attribute and relationship names are field names; a generic id-keyed map is not', () => {
  const found = ks.fieldValues(JSON_API_DOCUMENT);
  assert.deepEqual(found.get(ARTICLE), ['data[].id']);
  assert.deepEqual(found.get(TAG), ['included[].id']);
  assert.deepEqual(found.get(CATEGORY), ['data[].relationships.category.data.id']);
  assert.deepEqual(found.get(AUTHOR), ['data[].relationships.author.data.id']);
  assert.deepEqual(found.get('title-JSN-en'), ['data[].attributes.title.en'], 'attribute names inside attributes');
  assert.ok(![...found.values()].flat().some(field => field.includes('{}')), 'no {} anywhere in the document');
  // A generic id-keyed map (two or more keys, object values with identical key
  // sets) outside JSON:API's names is still data, also beside a JSON:API document.
  const generic = ks.fieldValues({ ...JSON_API_DOCUMENT, members: { alice: { team_id: 'team-A2-0001' }, bob: { team_id: 'team-A2-0002' } },
    byId: { thingA: { id: 'thing-A2-0003' }, thingB: { id: 'thing-A2-0004' } } });
  assert.deepEqual(generic.get('team-A2-0001'), ['members.{}.team_id']);
  assert.deepEqual(generic.get('thing-A2-0003'), ['byId.{}.id']);
  // The trusted names still pass the promotion field-name scan and the digit rule.
  const keep = fn('keepObjectKey');
  assert.equal(keep('category', { parentIsMap: true, container: 'relationships' }), true);
  assert.equal(keep('title', { parentIsMap: true, container: 'attributes' }), true);
  assert.equal(keep('data', { parentIsMap: true }), true, 'a member name wherever it appears');
  assert.equal(keep('category', { parentIsMap: true }), false, 'outside attributes/relationships a map key is data');
  assert.equal(keep('category', { parentIsMap: true, container: 'members' }), false);
  assert.equal(keep('item2', { parentIsMap: true, container: 'relationships' }), false, 'the digit rule');
  assert.equal(keep('sk_live_abcdefghijklmnop', { container: 'attributes' }), false, 'the promotion field-name scan');
  assert.equal(keep('category', { parentIsMap: true, container: 'relationships', wanted: new Set(['category']) }), false,
    'a key equal to the linked value is never a name');
  assert.equal(fn('jsonApiName')('included'), true);
  assert.equal(fn('jsonApiName')('author', 'relationships'), true);
  assert.equal(fn('jsonApiName')('author', 'data'), false);
  const digits = ks.fieldValues({ data: { relationships: { item2: { data: { id: 'rel-A2-0005' } }, item3: { data: { id: 'rel-A2-0006' } } } } });
  assert.deepEqual(digits.get('rel-A2-0005'), ['data.relationships.{}.data.id']);
  // Documented residual: usernames directly inside attributes are trusted by name.
  assert.deepEqual(ks.fieldValues({ attributes: { alice: { x: 'usr-A2-0007' }, bob: { x: 'usr-A2-0008' } } }).get('usr-A2-0007'),
    ['attributes.alice.x']);
  // Documented residual (QA round 2): a username map whose values have different key sets.
  assert.deepEqual(ks.fieldValues({ members: { carol: { team_id: 'team-A2-0009' }, dave: { team_id: 'team-A2-0010', admin: true } } })
    .get('team-A2-0009'), ['members.carol.team_id']);
});
