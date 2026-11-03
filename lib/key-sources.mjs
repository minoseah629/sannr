// Path-key sources: which field of an earlier response supplied a value that a
// later request used as a path or query parameter ("the id in GET /things/{id}
// comes from data[].id of GET /things"). Everything in this module is pure:
// callers read private evidence and pass parsed records in.
//
// Values are compared in memory only. What leaves this module for storage or
// output is names, operations, dates, counts and evidence identities: a
// parameter name, a names-only field path, the source operation, when the link
// was observed, how many other fields also held the value, and the evidence run
// id and digest. A value never enters a stored entry, a return meant for
// output, or an error message.
import { secretIn, scanMetadataSecrets } from './verdicts.mjs';
import { fieldNameRefusal } from './promote.mjs';
import { basePathOf, deref, opNode, responseSchema } from './context.mjs';

export const KEY_SOURCE_BOUNDS = Object.freeze({
  examineRuns: 256,                  // newest earlier run files a capture examines, any scope
  windowRuns: 64,                    // of those, the in-scope runs searched (same provider and environment)
  maxEvidenceBytes: 2 * 1024 * 1024, // larger evidence files are skipped
  budgetMs: 300,                     // capture-time budget; over budget records nothing
  maxEntries: 16,                    // key_sources entries per operation record
  maxSourcesPerParam: 2,             // most recent distinct sources per parameter
  maxFieldChars: 256,                // names-only field path length
  backfillRuns: 5000,                // newest evidence runs one backfill reads
});

export const RUN_ID = /^run-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const HTTP_OPERATION = /^[A-Z][A-Z0-9_-]{0,31} \/[^\r\n]*$/u;
const CONTROL = /[\u0000-\u001f\u007f\p{Cf}]/u;
const PATH_SYNTAX = /[.[\]{}\s]/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
// The field's own damage code: key_sources is derived data, so its damage is
// never store damage (see projectKeySources).
export const KEY_SOURCES_INVALID = 'KEY_SOURCES_INVALID';
const damaged = () => { throw Object.assign(new Error('Stored key sources are damaged.'), { code: KEY_SOURCES_INVALID }); };

// --- names -------------------------------------------------------------------

/** A name the store may hold: the promotion boundary's field-name scan
 * (lib/promote.mjs), plus what keeps a names-only path unambiguous — no
 * whitespace, control characters or the path syntax . [ ] { }. */
export function recordableName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 64
    && !CONTROL.test(name) && !PATH_SYNTAX.test(name) && !fieldNameRefusal(name);
}

// Extra refusals: keys that carry data even when they would otherwise pass. A
// key starting with a digit (numbers, dates, most hashes), a UUID, a
// digit-bearing hex string of 16+ characters, or a prefixed identifier with a
// digit-bearing suffix (the URL shapes templatePath collapses: cus_9s8d7f6g).
const IDENTIFIER_KEYS = [
  /^\d/u,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  /^(?=[0-9a-f]*\d)[0-9a-f]{16,}$/iu,
  /^[A-Za-z][A-Za-z0-9]{0,11}[-_](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{3,}$/u,
];
const WORD_KEY = /^[A-Za-z_][A-Za-z_-]*$/u;
const NO_NAMES = new Set();

/** A structural map: an object with two or more keys whose values are all
 * objects with identical key sets. Its keys are data. An object whose values
 * are all arrays is not one: arrays under fixed names (data, included, items,
 * results) are record fields. */
export function structuralMap(value) {
  if (!object(value)) return false;
  const values = Object.values(value);
  if (values.length < 2 || !values.every(object)) return false;
  const signature = item => Object.keys(item).sort().join('\u0000');
  const first = signature(values[0]);
  return values.every(item => signature(item) === first);
}

// JSON:API (jsonapi.org) member names, and the objects whose direct keys are
// attribute and relationship names, which the specification defines as field
// names.
const JSON_API_MEMBERS = new Set(['data', 'included', 'meta', 'links', 'errors', 'jsonapi', 'id', 'type', 'attributes', 'relationships']);
const JSON_API_FIELD_OBJECTS = new Set(['attributes', 'relationships']);

/** Whether a key is a field name by JSON:API's definition, wherever it
 * appears: a JSON:API member name, or a key directly inside an object held by
 * an `attributes` or `relationships` key (`container`). keepObjectKey still
 * applies the promotion field-name scan and the digit rule to it. */
export function jsonApiName(key, container = null) {
  return JSON_API_MEMBERS.has(key) || JSON_API_FIELD_OBJECTS.has(container);
}

/** Whether an object key may appear verbatim in a names-only field path. It
 * must be a recordable name and not identifier-shaped, and then either (a) a
 * property name the bound contract declares, or (b) word-shaped (letters,
 * underscores and hyphens only, no digits) and not equal to a value being
 * linked, and either a JSON:API name (jsonApiName; `container` is the key that
 * holds the object) or inside an object that is not a structural map. Every
 * other key is recorded as {}, so the key itself never enters the store. The
 * rule is shape-based: with no schema in the contract, a map keyed by
 * digit-free words cannot be told from field names when it has a single entry
 * or its values have different key sets, and the names JSON:API defines are
 * trusted by name. */
export function keepObjectKey(key, { declared = NO_NAMES, wanted = null, parentIsMap = false, container = null } = {}) {
  if (!recordableName(key) || IDENTIFIER_KEYS.some(pattern => pattern.test(key))) return false;
  if (declared?.has(key)) return true;
  if (!WORD_KEY.test(key) || wanted?.has(key)) return false;
  return !parentIsMap || jsonApiName(key, container);
}

/** The inverse of keepObjectKey: the key is recorded as {}. */
export function dynamicKey(key, wanted = null, options = {}) {
  return !keepObjectKey(key, { ...options, wanted });
}

// --- values ------------------------------------------------------------------

// The work order's ISO forms: YYYY-MM, YYYY-MM-DD and ISO datetimes.
const ISO_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/u;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:[Zz]|[+-]\d{2}(?::?\d{2})?)?$/u;
const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;
// The private evidence's own redaction markers are never values.
const REDACTION_MARKER = /\[(?:redacted|withheld)/iu;
const NULL_TOKEN = /^(?:null|undefined|none|nil|n\/a)$/iu;
const MONTHS = new Set(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december']);
const WEEKDAYS = new Set(['mon', 'tue', 'tues', 'wed', 'thu', 'thur', 'thurs', 'fri', 'sat', 'sun', 'monday',
  'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']);
const ZONE = /^(?:gmt|utc|ut|z|[ecmp][sd]t|bst|cet|cest|[+-]\d{4}|[+-]\d{2}:\d{2})$/u;
const TIME = /^\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?$/u;
const inMonth = text => Number(text) >= 1 && Number(text) <= 12;
const inDay = text => Number(text) >= 1 && Number(text) <= 31;
// RFC 850, the obsolete HTTP-date form RFC 7231 still defines (two-digit year).
const RFC850_DATE = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday), \d{2}-(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)-\d{2} \d{2}:\d{2}:\d{2} gmt$/u;

// A complete calendar date written with separators and a four-digit year, in
// one of the forms YYYY/MM/DD, MM/DD/YYYY, DD/MM/YYYY, DD.MM.YYYY or
// DD-MM-YYYY, with valid month (1-12) and day (1-31) ranges. A dotted version
// (1.2.10) or a two-digit year (3-4-26) is not a date.
function separatedDate(value) {
  let match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/u.exec(value);
  if (match) return inMonth(match[2]) && inDay(match[3]);
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value);
  if (match) return inMonth(match[1]) && inDay(match[2]) || inDay(match[1]) && inMonth(match[2]);
  match = /^(\d{1,2})([.-])(\d{1,2})\2(\d{4})$/u.exec(value);
  return Boolean(match) && inDay(match[1]) && inMonth(match[3]);
}

// A date written with a month name: a day, a month name and a four-digit year,
// in day-month-year, month-day-year or year-month-day order, with an optional
// leading weekday and an optional trailing time, meridiem and zone ("Oct 5,
// 2026", "5 October 2026", "05-Oct-2026", RFC 7231 IMF-fixdate and RFC 2822
// dates); the asctime form (weekday, month, day, time, year); and RFC 850. A
// month name followed by digits alone (DEC-7, MAY-1001) or without a day
// (May 2026) is not a date.
function monthNameDate(value) {
  const text = value.toLowerCase();
  if (RFC850_DATE.test(text)) return true;
  let classes = '';
  for (const piece of text.split(/[\s,]+/u)) {
    // A month name joined to numbers by - / or . (05-Oct-2026) is split there;
    // numbers joined to numbers are not.
    for (let token of piece.split(/(?<=\d)[-/.](?=[a-z])|(?<=[a-z])[-/.](?=\d)/u)) {
      if (!token) continue;
      if (/^[a-z]+\.$/u.test(token)) token = token.slice(0, -1);
      if (MONTHS.has(token)) classes += 'M';
      else if (WEEKDAYS.has(token)) classes += 'W';
      else if (/^\d{4}$/u.test(token)) classes += 'Y';
      else if (/^\d{1,2}(?:st|nd|rd|th)?$/u.test(token) && inDay(token.replace(/[a-z]+$/u, ''))) classes += 'D';
      else if (TIME.test(token)) classes += 'T';
      else if (token === 'am' || token === 'pm') classes += 'A';
      else if (ZONE.test(token)) classes += 'Z';
      else return false;
    }
  }
  return /^W?(?:(?:DMY|MDY|YMD)(?:TA?)?Z?|MDTYZ?)$/u.test(classes);
}

/** The in-memory comparison form of a value that can link a key, or null:
 * a string of four or more characters that is not whitespace-padded, a null
 * token (null, undefined, none, nil, n/a), an ISO date or datetime, a complete
 * calendar date written with separators and a four-digit year or with a month
 * name (see separatedDate and monthNameDate), a boolean, or secret-shaped; an
 * integer (or a digit string) of 1000 or more. Compact eight-digit dates, epoch
 * numbers, years, ISO week and ordinal forms (2026-W41, 2026-278) and
 * two-digit-year forms stay eligible by shape: identifiers of those shapes
 * exist, so only a contract that declares a date format excludes them. */
export function eligibleValue(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 1000 ? String(value) : null;
  if (typeof value !== 'string') return null;
  if (NUMERIC.test(value)) return /^\d+$/u.test(value) && Number(value) >= 1000 ? value : null;
  if (value.length < 4 || value.trim() !== value || NULL_TOKEN.test(value) || /^(?:true|false)$/iu.test(value)
    || ISO_DATE.test(value) || ISO_DATETIME.test(value) || separatedDate(value) || monthNameDate(value)
    || REDACTION_MARKER.test(value) || secretIn(value)) return null;
  return value;
}

// A response scalar compared against already-eligible wanted values. Only
// strings and integers can be equal to one; null and booleans never are.
function wantedForm(value, wanted) {
  if (typeof value === 'string') return wanted.has(value) ? value : null;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1000) {
    const form = String(value);
    return wanted.has(form) ? form : null;
  }
  return null;
}

// --- (a) parameter values from a concrete request ----------------------------

function templatePathFor(url, { operation, endpoint }) {
  // The capture identity's endpoint is `${origin}${endpointPath}`, including any
  // declared contractPathPrefix; a different origin is a different endpoint.
  if (typeof endpoint === 'string') return endpoint.startsWith(`${url.origin}/`) ? endpoint.slice(url.origin.length) : null;
  if (typeof operation === 'string' && HTTP_OPERATION.test(operation)) return operation.slice(operation.indexOf(' ') + 1);
  return null;
}

/** The parameter values a concrete request URL carried, by its templated
 * endpoint or operation: [{ param, location: 'path'|'query', value }]. Literal
 * segments must match. A segment holding one parameter may carry a literal
 * prefix or suffix; a segment holding several is not split. Only recordable
 * parameter names and eligible values are returned. In memory only. */
export function deriveParameterValues(url, { operation, endpoint } = {}) {
  let parsed;
  try { parsed = url instanceof URL ? url : new URL(url); } catch { return []; }
  const template = templatePathFor(parsed, { operation, endpoint });
  if (template === null) return [];
  const segments = template.split('/'), actual = parsed.pathname.split('/');
  // The route matcher tolerates one optional trailing slash; so does this.
  if (actual.length === segments.length + 1 && actual.at(-1) === '') actual.pop();
  if (actual.length !== segments.length) return [];
  const out = [];
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index], concrete = actual[index];
    const open = segment.indexOf('{');
    if (open < 0) {
      if (segment !== concrete) return [];
      continue;
    }
    const close = segment.indexOf('}', open + 1);
    if (close < 0 || segment.includes('{', close + 1) || segment.includes('}', close + 1)) continue;
    const prefix = segment.slice(0, open), suffix = segment.slice(close + 1), name = segment.slice(open + 1, close);
    if (concrete.length <= prefix.length + suffix.length || !concrete.startsWith(prefix) || !concrete.endsWith(suffix)) return [];
    let value;
    try { value = decodeURIComponent(concrete.slice(prefix.length, concrete.length - suffix.length)); } catch { continue; }
    if (recordableName(name) && eligibleValue(value) !== null) out.push({ param: name, location: 'path', value });
  }
  for (const [name, value] of parsed.searchParams)
    if (recordableName(name) && eligibleValue(value) !== null) out.push({ param: name, location: 'query', value });
  const seen = new Set();
  return out.filter(item => {
    const key = JSON.stringify([item.param, item.location, item.value]);
    return seen.has(key) ? false : seen.add(key);
  });
}

// --- (b) eligible values in a response, with names-only field paths -----------

const budgetExceeded = () => Object.assign(new Error('The key-source time budget was exceeded.'), { code: 'KEY_SOURCE_BUDGET_EXCEEDED' });

/** Eligible scalar values in a parsed JSON body and the names-only fields that
 * held them: array positions become [] (data[].id) and object keys that
 * keepObjectKey does not keep become {} (byId.{}.id). `declaredNames` are the
 * property names the bound contract declares. With `wanted`, only those values
 * are collected. Returns Map(value → distinct fields in document order); values
 * stay in memory. A root scalar has no field and is not collected; a field
 * longer than maxFieldChars is not collected. */
export function fieldValues(body, { wanted = null, declaredNames = NO_NAMES, maxFieldChars = KEY_SOURCE_BOUNDS.maxFieldChars,
  deadline = Infinity, clock = Date.now } = {}) {
  const found = new Map();
  // [value, field path, the key that holds this value when it is an object's member]
  const stack = [[body, '', null]];
  let visited = 0;
  while (stack.length) {
    if ((++visited & 4095) === 0 && clock() > deadline) throw budgetExceeded();
    const [value, path, container] = stack.pop();
    if (Array.isArray(value)) {
      const child = `${path}[]`;
      if (child.length > maxFieldChars) continue;
      for (let index = value.length - 1; index >= 0; index--) stack.push([value[index], child, null]);
    } else if (object(value)) {
      const keys = Object.keys(value), parentIsMap = structuralMap(value);
      for (let index = keys.length - 1; index >= 0; index--) {
        const key = keys[index];
        const kept = keepObjectKey(key, { declared: declaredNames ?? NO_NAMES, wanted, parentIsMap, container });
        const child = `${path ? `${path}.` : ''}${kept ? key : '{}'}`;
        if (child.length <= maxFieldChars) stack.push([value[key], child, key]);
      }
    } else if (path) {
      const form = wanted ? wantedForm(value, wanted) : eligibleValue(value);
      if (form === null) continue;
      if (!found.has(form)) found.set(form, new Set());
      found.get(form).add(path);
    }
  }
  return new Map([...found].map(([form, fields]) => [form, [...fields]]));
}

const MAX_REQUEST_TEXTS = 1_000_000;
const decoded = segment => { try { return decodeURIComponent(segment); } catch { return segment; } };

// Every piece of text a request carried: decoded path segments, query keys and
// values, header names and values, and the body's keys and scalars (the raw
// text when the body is not JSON). null when the body is too large to walk.
function requestTexts(request) {
  const texts = [];
  if (typeof request.url === 'string') {
    try {
      const url = new URL(request.url);
      for (const segment of url.pathname.split('/')) texts.push(decoded(segment));
      for (const [key, value] of url.searchParams) texts.push(key, value);
    } catch { texts.push(request.url); }
  }
  if (object(request.headers)) for (const [key, value] of Object.entries(request.headers)) {
    texts.push(key);
    for (const item of Array.isArray(value) ? value : [value]) if (typeof item === 'string') texts.push(item);
  }
  const stack = [request.body];
  while (stack.length) {
    if (texts.length > MAX_REQUEST_TEXTS) return null;
    const value = stack.pop();
    if (typeof value === 'string') texts.push(value);
    else if (typeof value === 'number' && Number.isFinite(value)) texts.push(String(value));
    else if (Array.isArray(value)) for (const item of value) stack.push(item);
    else if (object(value)) for (const [key, child] of Object.entries(value)) { texts.push(key); stack.push(child); }
  }
  return texts;
}

/** The wanted values a request itself carried, anywhere: as a substring of a
 * decoded path segment, of a query key or value, of a header name or value, or
 * of a body key or scalar (the raw text when the body is not JSON). A response
 * is never the source of a value its own request carried; the rule is
 * conservative on purpose, so a coincidental substring can cost a true source
 * but a request is never recorded as its own source. A body too large to walk
 * carries every wanted value. */
export function carriedValues(request, wanted) {
  const carried = new Set();
  if (!object(request) || !wanted?.size) return carried;
  const texts = requestTexts(request);
  for (const value of wanted) if (texts === null || texts.some(text => text.includes(value))) carried.add(value);
  return carried;
}

// --- (c) choose the source ----------------------------------------------------

/** The last name of a field path: data[].id → id; byId.{} → {}. */
export function lastName(field) {
  return field.split('.').at(-1).replace(/(?:\[\])+$/u, '');
}

const validOperation = operation => typeof operation === 'string' && operation.length <= 512
  && HTTP_OPERATION.test(operation) && !CONTROL.test(operation) && !secretIn(operation);
const sourceRun = run => validOperation(run?.operation) && Number.isInteger(run.status)
  && run.status >= 200 && run.status < 300 && run.matches instanceof Map;
const chronological = (a, b) => Date.parse(a.observed_at) - Date.parse(b.observed_at)
  || (a.run_id < b.run_id ? -1 : a.run_id > b.run_id ? 1 : 0);

/** One link per candidate (param, location, value) that a windowed earlier
 * run supplied. Sources are 2xx responses whose own request did not carry the
 * value. The earliest such run is the source; within it, a field whose last
 * name equals the parameter is preferred, then document order. also_seen counts
 * the other distinct (operation, field) pairs that held the value. A query
 * parameter links only to fields whose last name equals the parameter name.
 * runs: [{ run_id, digest, observed_at, operation, status, matches, carried }] */
export function chooseSources(candidates, runs) {
  const ordered = runs.filter(sourceRun).sort(chronological);
  const links = [], seen = new Set();
  for (const { param, location, value } of candidates) {
    const key = JSON.stringify([param, location, value]);
    if (seen.has(key)) continue;
    seen.add(key);
    const pairs = new Set();
    let source = null;
    for (const run of ordered) {
      if (run.carried?.has(value)) continue;
      const fields = (run.matches.get(value) ?? []).filter(field => location === 'path' || lastName(field) === param);
      if (!fields.length) continue;
      for (const field of fields) pairs.add(JSON.stringify([run.operation, field]));
      source ??= { run, field: fields.find(field => lastName(field) === param) ?? fields[0] };
    }
    if (!source) continue;
    links.push({ param, location, source: { operation: source.run.operation, field: source.field },
      also_seen: pairs.size - 1, evidence: { run_id: source.run.run_id, digest: source.run.digest } });
  }
  return links;
}

// --- the bound contract's rules ------------------------------------------------

const DATE_FORMATS = new Set(['date', 'date-time', 'time']);
// Values, never schema nodes: their contents are data, not declarations.
const VALUE_KEYS = new Set(['example', 'examples', 'default', 'enum', 'const']);

/** Every property name the contract declares: the keys of each schema node's
 * `properties`, never anything under example, examples, default, enum or const. */
export function declaredPropertyNames(doc) {
  const names = new Set(), seen = new Set(), stack = [doc];
  let visited = 0;
  while (stack.length && ++visited <= 500_000) {
    const node = stack.pop();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    if (Array.isArray(node)) { for (const item of node) stack.push(item); continue; }
    for (const [key, value] of Object.entries(node)) {
      if (VALUE_KEYS.has(key)) continue;
      if (key === 'properties' && object(value)) for (const name of Object.keys(value)) names.add(name);
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return names;
}

// A schema that pins the value set or the value's meaning: an enum or const, a
// date, date-time or time format, or (for parameters) a boolean type,
// including through allOf/oneOf/anyOf members and array items.
function constrainedSchema(doc, schema, { boolean }, depth = 0) {
  const node = deref(doc, schema);
  if (!object(node) || depth > 16) return false;
  if (Array.isArray(node.enum) && node.enum.length || Object.hasOwn(node, 'const') || DATE_FORMATS.has(node.format)) return true;
  if (boolean && [node.type].flat().includes('boolean')) return true;
  for (const key of ['allOf', 'oneOf', 'anyOf'])
    if (Array.isArray(node[key]) && node[key].some(member => constrainedSchema(doc, member, { boolean }, depth + 1))) return true;
  return node.items !== undefined && constrainedSchema(doc, node.items, { boolean }, depth + 1);
}

function pathItemFor(doc, path) {
  const base = basePathOf(doc);
  if (base && path.startsWith(base) && (path.length === base.length || path[base.length] === '/')) {
    const stripped = doc?.paths?.[path.slice(base.length) || '/'];
    if (stripped) return stripped;
  }
  return doc?.paths?.[path];
}

const splitOperation = operation => {
  const space = operation.indexOf(' ');
  return { method: operation.slice(0, space), path: operation.slice(space + 1) };
};
const propertyOf = (node, name, depth = 0) => {
  if (!object(node) || depth > 8) return undefined;
  if (object(node.properties) && Object.hasOwn(node.properties, name)) return node.properties[name];
  for (const key of ['allOf', 'oneOf', 'anyOf']) for (const member of Array.isArray(node[key]) ? node[key] : []) {
    const found = propertyOf(member, name, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};
const itemsOf = (node, depth = 0) => {
  if (!object(node) || depth > 8) return undefined;
  if (object(node.items)) return node.items;
  for (const key of ['allOf', 'oneOf', 'anyOf']) for (const member of Array.isArray(node[key]) ? node[key] : []) {
    const found = itemsOf(member, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
};

/** What the bound contract says about linking, computed lazily from its
 * document: the property names it declares, whether a parameter's schema pins
 * its value (enum, const, boolean, or a date, date-time or time format), and
 * whether a response field's schema does (enum, const or those formats) when
 * the contract describes the response. A contract that cannot answer says
 * nothing is constrained. */
export function contractKeyProfile(doc) {
  let names;
  const parameters = new Map(), responses = new Map();
  const parameterRules = operation => {
    if (!parameters.has(operation)) {
      const rules = new Map();
      try {
        const { method, path } = splitOperation(operation);
        const declared = [...(pathItemFor(doc, path)?.parameters ?? []), ...(opNode(doc, method, path)?.parameters ?? [])];
        for (const raw of declared) {
          const param = deref(doc, raw);
          if (!object(param) || typeof param.name !== 'string' || typeof param.in !== 'string') continue;
          const contentKey = object(param.content) ? Object.keys(param.content)[0] : undefined;
          const schema = param.schema ?? (contentKey ? param.content[contentKey]?.schema : undefined) ?? param;
          rules.set(`${param.in}\u0000${param.name}`, constrainedSchema(doc, schema, { boolean: true }));
        }
      } catch { /* an unreadable operation constrains nothing */ }
      parameters.set(operation, rules);
    }
    return parameters.get(operation);
  };
  return {
    get declaredNames() {
      if (!names) { try { names = declaredPropertyNames(doc); } catch { names = new Set(); } }
      return names;
    },
    parameterUnlinkable(operation, location, name) {
      return Boolean(parameterRules(operation).get(`${location}\u0000${name}`));
    },
    fieldUnlinkable(operation, field) {
      try {
        if (!responses.has(operation)) {
          const { method, path } = splitOperation(operation);
          responses.set(operation, responseSchema(doc, method, path));
        }
        let node = responses.get(operation);
        for (const segment of field.split('.')) {
          if (node === undefined) return false;
          const [, core, arrays] = /^(.*?)((?:\[\])*)$/u.exec(segment);
          if (core === '{}') node = object(node.additionalProperties) ? node.additionalProperties : undefined;
          else if (core !== '') node = propertyOf(node, core);
          for (let count = 0; count < arrays.length / 2 && node !== undefined; count++) node = itemsOf(node);
        }
        return node !== undefined && constrainedSchema(doc, node, { boolean: false });
      } catch { return false; }
    },
  };
}

// --- (d) merge into a record within bounds ------------------------------------

const entryKey = item => JSON.stringify([item.param, item.location, item.source.operation, item.source.field]);
const paramKey = item => JSON.stringify([item.param, item.location]);
const time = value => Date.parse(value);
const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// A total order on observations of one link: the latest supplies also_seen and
// evidence. Ties break on evidence run id, then the count, so merging is
// independent of the order links arrive in.
const rank = (a, b) => time(a.last_observed_at) - time(b.last_observed_at)
  || text(a.evidence.run_id, b.evidence.run_id) || a.also_seen - b.also_seen;
const byRecency = (a, b) => time(b.last_observed_at) - time(a.last_observed_at) || text(entryKey(a), entryKey(b));
// The record's bound keeps path keys before query keys, the most recent first
// within each: the path keys are what a reader needs to call the operation.
const LOCATION_ORDER = { path: 0, query: 1 };
const byPriority = (a, b) => (LOCATION_ORDER[a.location] ?? 2) - (LOCATION_ORDER[b.location] ?? 2) || byRecency(a, b);
const byDisplay = (a, b) => text(a.location, b.location) || text(a.param, b.param)
  || time(b.last_observed_at) - time(a.last_observed_at) || text(a.source.operation, b.source.operation)
  || text(a.source.field, b.source.field);

const copyEntry = item => ({ param: item.param, location: item.location,
  source: { operation: item.source?.operation, field: item.source?.field },
  first_observed_at: item.first_observed_at, last_observed_at: item.last_observed_at,
  also_seen: item.also_seen, evidence: { run_id: item.evidence?.run_id, digest: item.evidence?.digest } });

/** Merge links into a record's key_sources. One entry per (param, location,
 * source operation, source field): first and last observed widen, and the
 * latest observation supplies also_seen and evidence. Then the bounds: the 2
 * most recent distinct sources per parameter, and 16 entries per record, path
 * entries kept before query entries and the most recent first within each.
 * Merging the same links again changes nothing. */
export function mergeKeySources(existing = [], incoming = [], { maxEntries = KEY_SOURCE_BOUNDS.maxEntries,
  maxSourcesPerParam = KEY_SOURCE_BOUNDS.maxSourcesPerParam } = {}) {
  const byKey = new Map();
  for (const item of [...existing, ...incoming]) {
    const key = entryKey(item), previous = byKey.get(key);
    if (!previous) { byKey.set(key, copyEntry(item)); continue; }
    const latest = rank(item, previous) > 0 ? item : previous;
    byKey.set(key, { ...copyEntry(latest),
      first_observed_at: time(item.first_observed_at) < time(previous.first_observed_at) ? item.first_observed_at : previous.first_observed_at,
      last_observed_at: latest.last_observed_at });
  }
  const perParam = new Map(), kept = [];
  for (const item of [...byKey.values()].sort(byPriority)) {
    const count = perParam.get(paramKey(item)) ?? 0;
    if (count >= maxSourcesPerParam) continue;
    perParam.set(paramKey(item), count + 1);
    kept.push(item);
    if (kept.length >= maxEntries) break;
  }
  // Display order is stable; key order inside each entry is fixed by copyEntry.
  return kept.sort(byDisplay);
}

// --- stored validation ----------------------------------------------------------

const isoTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;

/** A names-only field path: segments joined by '.', each a recordable name or
 * {}, followed by any number of []; only the first segment may be empty, and
 * only when it is a root array ([].id). At most 256 characters. */
export function validField(field) {
  // The whole path is scanned too: segments can each look clean while their
  // joined text (an address split at its dots) is secret-shaped.
  if (typeof field !== 'string' || !field || field.length > KEY_SOURCE_BOUNDS.maxFieldChars || CONTROL.test(field)
    || secretIn(field)) return false;
  return field.split('.').every((segment, index) => {
    const [, core, arrays] = /^(.*?)((?:\[\])*)$/u.exec(segment);
    if (core === '{}') return true;
    if (core === '') return index === 0 && arrays.length > 0;
    return recordableName(core);
  });
}

/** Validate and project a stored key_sources array; older records omit it.
 * The single validator for every reader. Throws KEY_SOURCES_INVALID on damage,
 * including a value that is not an array; readers use projectKeySources. */
export function storedKeySources(value) {
  if (!Array.isArray(value) || value.length > KEY_SOURCE_BOUNDS.maxEntries) damaged();
  const keys = new Set(), perParam = new Map();
  return value.map(item => {
    if (!object(item) || !object(item.source) || !object(item.evidence)) damaged();
    const entry = copyEntry(item);
    if (!recordableName(entry.param) || !['path', 'query'].includes(entry.location)
      || !validOperation(entry.source.operation) || !validField(entry.source.field)
      || !isoTime(entry.first_observed_at) || !isoTime(entry.last_observed_at)
      || time(entry.first_observed_at) > time(entry.last_observed_at)
      || !Number.isSafeInteger(entry.also_seen) || entry.also_seen < 0
      || typeof entry.evidence.run_id !== 'string' || !RUN_ID.test(entry.evidence.run_id) || secretIn(entry.evidence.run_id)
      || typeof entry.evidence.digest !== 'string' || !DIGEST.test(entry.evidence.digest)) damaged();
    if (keys.has(entryKey(entry))) damaged();
    keys.add(entryKey(entry));
    perParam.set(paramKey(entry), (perParam.get(paramKey(entry)) ?? 0) + 1);
    if (perParam.get(paramKey(entry)) > KEY_SOURCE_BOUNDS.maxSourcesPerParam) damaged();
    return entry;
  });
}

/** A reader's view of one stored operation record's key_sources. Never throws.
 * - { state: 'absent' }: the record has no key_sources (older records).
 * - { state: 'valid', key_sources }: validated by storedKeySources, and passed
 *   by the store's final lock (scanMetadataSecrets).
 * - { state: 'damaged', code: 'KEY_SOURCES_INVALID' }: any validation failure.
 * key_sources is derived data that capture and `context keys` regenerate, so a
 * damaged list is treated as absent and reported for its record: the record's
 * observations and the rest of the store stay readable. The final lock reads
 * credential references too (`basic:abc` as a name): a reader that returned a
 * list holding one would have the whole record refused, so such a list is
 * damaged here, exactly as the writers refuse to store it. */
export function projectKeySources(record) {
  if (!object(record) || !Object.hasOwn(record, 'key_sources')) return { state: 'absent' };
  try {
    const keySources = storedKeySources(record.key_sources);
    scanMetadataSecrets(keySources, KEY_SOURCES_INVALID);
    return { state: 'valid', key_sources: keySources };
  } catch { return { state: 'damaged', code: KEY_SOURCES_INVALID }; }
}

export { validOperation };
