// Reuse the actual single-request fields for batch discovery. Keeping the
// nested grammar here avoids prose-only inputs without adding another tool.
const operators = {
  equals: {}, not_equals: {}, exists: { type: 'boolean' },
  in: { type: 'array' }, matches: { type: 'string' },
  type: { type: 'string', enum: ['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'] },
  gt: { type: 'number' }, lt: { type: 'number' },
  length: { type: 'integer', minimum: 0 },
};

// The grammar an agent reads must be the grammar the engine runs. The engine
// conjoins every operator in a clause (lib/assertions.mjs), so `oneOf` over the
// operators advertised a clause it would happily check as invalid, and an
// integer-typed status made the marker form — the spelling that lets operators
// select the status — inexpressible. Both said one thing while the engine did
// another, on the surface an agent plans from.
export const assertionSchema = {
  type: 'object', additionalProperties: false,
  description: 'Choose one target and one or more operators. Several operators in one clause are a conjunction: the clause holds only when every one of them holds, and a failure names the first that did not. {status:200} alone is equality shorthand; to apply operators to the status, select it with {status:true}. JSON paths use dot notation; equals and not_equals compare objects and arrays structurally.',
  properties: {
    status: { anyOf: [{ type: 'integer' }, { enum: [true] }],
      description: 'Select the HTTP status: an integer alone requires exactly that status; true selects it for the operators in this clause.' },
    json: { type: 'string', description: 'JSON response path; empty string selects the whole body.' },
    header: { type: 'string' }, ...operators,
  },
  allOf: [
    { oneOf: ['status', 'json', 'header'].map(key => ({ required: [key] })) },
    // One or more operators, or the bare {status: N} shorthand.
    { anyOf: [
      { required: ['status'], maxProperties: 1, properties: { status: { type: 'integer' } } },
      ...Object.keys(operators).map(key => ({ required: [key] })),
    ] },
    // An integer status IS the expectation, so it cannot also be a selector:
    // beside an operator the engine compares the operator's value and ignores
    // the integer, and a grammar should not offer a form that means less than
    // it looks like. With operators, the marker `true` is the honest spelling.
    { anyOf: [
      { not: { required: ['status'] } },
      { required: ['status'], maxProperties: 1 },
      { properties: { status: { enum: [true] } } },
    ] },
  ],
};

export const captureSchema = {
  type: 'object', additionalProperties: { type: 'string' },
  description: 'Variable name -> response JSON path. Later steps use {name} in path, params, body, headers or expect. Values come from the full response even when passing assertions omit its public body.',
};

export const waitForSchema = {
  type: 'object', additionalProperties: false, required: ['json'],
  description: 'Poll this HTTP GET/HEAD until one predicate matches. Protocol requests and write methods cannot be polled. Completion does not override failed expect assertions.',
  properties: {
    json: { type: 'string' }, equals: {}, in: { type: 'array' }, exists: { type: 'boolean' },
    timeout_ms: { type: 'number', minimum: 0, maximum: 300000, description: 'Default 30000; overall polling deadline.' },
    interval_ms: { type: 'number', minimum: 100, description: 'Default 500; minimum interval between polls.' },
  },
  oneOf: ['equals', 'in', 'exists'].map(key => ({ required: [key] })),
};

// A reserved, explicit HTTP body value. This check never reads a file and is
// shared by execution and read-only planning so planning cannot expand it.
export function containsBodyFileReference(value) {
  if (!value || typeof value !== 'object') return false;
  if (Object.hasOwn(value, '$file')) return true;
  return Object.values(value).some(containsBodyFileReference);
}

export const multipartFileSchema = {
  anyOf: [
    { type: 'string', minLength: 1 },
    { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', minLength: 1 }, contentType: { type: 'string', minLength: 1 },
      filename: { type: 'string', minLength: 1 },
    } },
  ],
};

export function describeRequestInputs(schema) {
  const props = schema.properties;
  props.expect.items = assertionSchema;
  props.paginate.anyOf = [
    { type: 'string', enum: ['all'] }, { type: 'boolean' }, { type: 'null' },
    { type: 'object', additionalProperties: false, required: ['max_pages'],
      properties: { max_pages: { type: 'integer', minimum: 1 } } },
  ];
  const { curl, requests, finally: cleanup, reveal_captures, on_failure, ...singleRequest } = props;
  // The same field's description is already visible at the top level. Repeat
  // its grammar in batch steps, without charging the host twice for that prose.
  const shapeOnly = value => Array.isArray(value) ? value.map(shapeOnly)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== 'description').map(([key, child]) => [key, shapeOnly(child)])) : value;
  requests.items = {
    type: 'object', additionalProperties: false, required: ['path'],
    properties: { ...shapeOnly(singleRequest), id: { description: 'Optional caller correlation id.' },
      capture: captureSchema, wait_for: waitForSchema },
  };
  if (cleanup) cleanup.items = requests.items;
  return schema;
}
