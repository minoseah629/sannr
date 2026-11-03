// A synthetic stored key-source link and the 19 damaged forms of a
// key_sources value (MAP-1C). One definition, shared by the store's validator
// test (test/key-sources-capture.test.mjs) and the API map's rendering test
// (test/api-map-integration.test.mjs), so both pin exactly the same forms.
// Names and shapes only; no value here comes from a real API.
export const storedLink = (overrides = {}) => ({ param: 'id', location: 'path',
  source: { operation: 'GET /things', field: 'data[].id' },
  first_observed_at: '2026-10-01T00:00:00.000Z', last_observed_at: '2026-10-01T00:00:00.000Z',
  also_seen: 0, evidence: { run_id: 'run-aaaa', digest: `sha256:${'a'.repeat(64)}` }, ...overrides });

export const DAMAGED_FORMS = [
  [storedLink(), storedLink()], Array.from({ length: 17 }, (_, index) => storedLink({ param: `p${index}x` })),
  [storedLink(), storedLink({ source: { operation: 'GET /b', field: 'b' } }), storedLink({ source: { operation: 'GET /c', field: 'c' } })],
  [storedLink({ param: 'two words' })], [storedLink({ param: 'sk_live_abcdefghijklmnop' })], [storedLink({ location: 'header' })],
  [storedLink({ source: { operation: 'get /things', field: 'id' } })], [storedLink({ source: { operation: 'GET /things', field: 'data[].sk_live_abcdefghijklmnop' } })],
  [storedLink({ source: { operation: 'GET /things', field: 'data[].person@example.invalid' } })],
  [storedLink({ source: { operation: 'GET /things', field: 'x'.repeat(257) } })], [storedLink({ first_observed_at: 'yesterday' })],
  [storedLink({ first_observed_at: '2026-10-02T00:00:00.000Z' })], [storedLink({ also_seen: -1 })], [storedLink({ also_seen: 1.5 })],
  [storedLink({ evidence: { run_id: '../run-1', digest: `sha256:${'a'.repeat(64)}` } })], [storedLink({ evidence: { run_id: 'run-1', digest: 'sha256:short' } })],
  'not-an-array', [null], [{ ...storedLink(), source: null }],
];

// Text from the damaged forms that no output may print.
export const DAMAGED_TEXT = ['sk_live_abcdefghijklmnop', 'person@example.invalid', 'two words', 'xxxxxxxxxxxxxxxx', 'yesterday', '../run-1'];
