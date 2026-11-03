import { secretIn } from "./verdicts.mjs";

// THE PROMOTION BOUNDARY.
//
// The rule, stated once:
//
//   An observation may contribute STRUCTURE without restriction — field names,
//   types, cardinality, status codes.
//
//   It may contribute VALUES only when the contract already declares that
//   field's value set, because then the values were already published in a
//   committed file and promotion adds no new exposure.
//
//   Nothing observed against a production environment contributes values.
//
// Why this rule and not a heuristic: an enum and a customer list are
// structurally identical low-cardinality strings. Nothing separates
// `status: [active, churned]` from `owner: [alice, bob]` by looking at
// the data. The contract is the only authority on which fields hold
// categorical values, because a human declared it there on purpose.
//
// Why it matters more than the other open decisions: promotion writes to a
// COMMITTED file. Every other mistake is a changed default; this one is in git
// history, in every clone and fork, permanently.
//
// Behaviour is pinned by test/promote.test.mjs, written before this file.

// Values that are dangerous regardless of what a contract claims. A contract can
// be wrong, or hostile; the boundary must not inherit its mistakes.
const CREDENTIAL_SHAPED = /^(?:sk|pk|rk|whsec|ghp|gho|ghu|ghs|ghr|xox[abposr])[-_]|^AKIA[0-9A-Z]{8}|^Bearer\s|-----BEGIN|^ey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./;
const EMAIL_SHAPED = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const MAX_VALUE_LENGTH = 64;    // enum members are short; prose is not an enum
const MAX_VALUES = 50;          // a committed file is not a data dump
// The boundary's email rule, for pages that withhold what it flags (view, map).
export const emailShaped = (value) => typeof value === "string" && EMAIL_SHAPED.test(value);

// Response schemas are rarely the bare object the values came from. Unwrap the
// common shapes so a real contract still authorises the right fields.
const COLLECTION_KEYS = ["results", "data", "items", "records", "entries", "content"];

function fieldSchemas(contract) {
  let node = contract;
  for (let depth = 0; node && depth < 4; depth += 1) {
    if (node.type === "array" || node.items) { node = node.items; continue; }
    const props = node.properties;
    if (!props) break;
    // A wrapper whose only interesting member is the collection: descend.
    const wrapper = COLLECTION_KEYS.find((k) => props[k]?.items || props[k]?.properties);
    if (wrapper && !props.id && !props.status) { node = props[wrapper]; continue; }
    return props;
  }
  return node?.properties ?? {};
}

const unsafeValue = (v) =>
  typeof v !== "string" ? "not a string"
    : v.length > MAX_VALUE_LENGTH ? "longer than an enum member"
    : CREDENTIAL_SHAPED.test(v) ? "credential-shaped"
    : EMAIL_SHAPED.test(v) ? "email-shaped"
    : secretIn(v) ? "credential-shaped"
    : null;

// The field-name half of the boundary: a reason the name cannot be committed,
// or null. Every caller that records response field names uses this one scan
// (key-source field paths in lib/key-sources.mjs reuse it).
export const fieldNameRefusal = (field) => secretIn(field) || unsafeValue(field);

// Response keys are data too. Scan before returning even a refusal/preview;
// otherwise the explanatory report itself becomes the credential leak.
const safeShape = (value, depth = 0) => {
  if (depth > 32) return '…';
  if (Array.isArray(value)) return value.map(item => safeShape(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !secretIn(key)).map(([key, child]) => [key, safeShape(child, depth + 1)]));
  return typeof value === 'string' && secretIn(value) ? '[withheld]' : value;
};

/**
 * Decide what observations for one operation may contribute to a committed
 * sannr.json entry.
 *
 * @param {object} input
 * @param {string} input.operation              e.g. "GET /customers"
 * @param {object} input.observed
 * @param {object} [input.observed.shape]       field -> type
 * @param {object} [input.observed.fieldValues] field -> observed values[]
 * @param {number[]} [input.observed.statusCodes]
 * @param {object} [input.contract]             response schema for this operation
 * @param {object} [input.environment]          { name, production }
 * @returns {{ promoted: object, refused: Array<{field:string, reason:string}> }}
 */
export function promoteObservation({ operation, observed = {}, contract, environment } = {}) {
  const { shape = {}, fieldValues = {}, statusCodes = [] } = observed;
  const declared = fieldSchemas(contract);
  const isProduction = Boolean(environment?.production);

  const promoted = {
    operation: operation ?? null,
    environment: environment?.name ?? null,
    // Retain schema structure after scanning response-derived field names.
    shape: safeShape(shape),
    status_codes: [...new Set(statusCodes)].sort((a, b) => a - b),
    // Null-prototype: a field literally named `__proto__` (or `constructor`)
    // assigned onto a plain object sets the prototype instead of an own
    // property, so it vanished from a report whose whole job is completeness.
    fields: Object.create(null),
  };
  const refused = [];
  const refuse = (field, reason) => refused.push({ field, reason });

  for (const [field, rawValues] of Object.entries(fieldValues)) {
    const fieldReason = fieldNameRefusal(field);
    if (fieldReason) {
      refuse("[withheld]", "credential-shaped field name");
      continue;
    }
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    const distinct = [...new Set(values)];

    // Cardinality always promotes. It is the useful half that carries no
    // exposure: an agent learns `owner` is worth filtering on without ever
    // learning who the owners are.
    const entry = { distinct: distinct.length };
    promoted.fields[field] = entry;

    const enumeration = declared[field]?.enum;
    if (!enumeration) {
      refuse(field, contract
        ? "not declared as an enum in the contract"
        : "no contract available to authorise values");
      continue;
    }
    if (isProduction) {
      refuse(field, "observed against a production environment");
      continue;
    }

    const unsafe = distinct.map((v) => [v, unsafeValue(v)]).find(([, why]) => why);
    if (unsafe) {
      refuse(field, `declared as an enum but a value is ${unsafe[1]}`);
      continue;
    }

    // The rule is that the VALUE is declared, not merely that the field is an
    // enum. Those differ exactly on the case that matters: a stale contract
    // (`tier: [free, pro]`) against a server returning real data
    // (`tier: enterprise-acme-health`). Promoting the observed value because its
    // field happens to be an enum publishes customer-identifying strings into a
    // committed file — the precise leak this boundary exists to stop. So promote
    // only the intersection with the declared set; nothing here was not already
    // in a committed contract.
    const declaredValues = distinct.filter((v) => enumeration.includes(v));
    entry.values = declaredValues.slice(0, MAX_VALUES);
    if (declaredValues.length > MAX_VALUES) entry.values_truncated = true;

    // That an undocumented value EXISTS is a real gotcha worth surfacing. The
    // value itself is not safe to publish (it is undeclared, so nothing vouches
    // for it), so report the cardinality and never the members — the same
    // field-name-and-count rule already used for undeclared fields.
    const undeclaredCount = distinct.length - declaredValues.length;
    if (undeclaredCount) entry.undeclared_count = undeclaredCount;
  }

  return { promoted, refused };
}
