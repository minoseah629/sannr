// THE PROMOTION BOUNDARY — specification by test.
//
// Written BEFORE the implementation, deliberately. Promotion writes into a
// committed file; every other decision in this project is a changed default,
// this one is permanent in git history across every clone and fork. If this
// suite is right the implementation is nearly mechanical. If it is wrong, no
// implementation saves it.
//
//   node --test test/promote.test.mjs
//
// Fixtures are realistic on purpose: a small dev-sized table where every field
// looks categorical is exactly the case that breaks heuristics.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteObservation } from "../lib/promote.mjs";

// --- fixtures --------------------------------------------------------------

// A contract that declares SOME fields as enums and leaves others open. This
// asymmetry is the whole test: the contract is the only authority on which
// fields hold categorical values.
const CONTRACT = {
  type: "object",
  properties: {
    id: { type: "integer" },
    status: { type: "string", enum: ["active", "churned", "trial"] },
    plan: { type: "string", enum: ["free", "pro", "enterprise"] },
    owner: { type: "string" },                 // NOT an enum — a person
    company: { type: "string" },               // NOT an enum — a customer
    contact_email: { type: "string" },
    notes: { type: "string" },
    seats: { type: "integer" },
    created_at: { type: "string", format: "date-time" },
  },
};

// Five rows from a dev database. Every string field here has 2-3 distinct
// values, so cardinality alone cannot tell an enum from a customer list.
const OBSERVED = {
  shape: {
    id: "number", status: "string", plan: "string", owner: "string",
    company: "string", contact_email: "string", notes: "string",
    seats: "number", created_at: "string",
  },
  fieldValues: {
    status: ["active", "active", "churned", "active", "active"],
    plan: ["pro", "free", "pro", "free", "pro"],
    owner: ["alice", "bob", "alice", "j.tran", "bob"],
    company: ["Acme Health", "Beta Legal", "Acme Health", "Cedar Clinic", "Beta Legal"],
    contact_email: ["a@acme.test", "b@beta.test", "a@acme.test", "c@cedar.test", "b@beta.test"],
    notes: ["renewal due", "asked about SSO", "renewal due", "trialling", "asked about SSO"],
    seats: [5, 12, 5, 3, 12],
    created_at: ["2026-01-02T10:00:00Z", "2026-02-11T09:00:00Z", "2026-01-02T10:00:00Z",
                 "2026-03-04T14:00:00Z", "2026-02-11T09:00:00Z"],
  },
  statusCodes: [200, 200, 200, 404],
};

const DEV = { name: "local", production: false };
const PROD = { name: "prod", production: true };

const run = (over = {}) => promoteObservation({
  operation: "GET /customers",
  observed: OBSERVED,
  contract: CONTRACT,
  environment: DEV,
  ...over,
});

const valuesFor = (result, field) => result.promoted?.fields?.[field]?.values;
const refusedFields = (result) => result.refused.map((r) => r.field);

// --- structure is always promotable ---------------------------------------

test("field names and types are promoted in full", () => {
  const r = run();
  assert.deepEqual(r.promoted.shape, OBSERVED.shape,
    "shape is schema, not data, and is already implied by the contract");
});

test("observed status codes are promoted", () => {
  const r = run();
  assert.deepEqual([...r.promoted.status_codes].sort(), [200, 404]);
});

test("cardinality is promoted for every field, including refused ones", () => {
  const r = run();
  assert.equal(r.promoted.fields.owner.distinct, 3);
  assert.equal(r.promoted.fields.company.distinct, 3);
  assert.equal(r.promoted.fields.status.distinct, 2);
  // Cardinality is the useful part that carries no exposure: an agent learns
  // `owner` is worth filtering on without learning who the owners are.
});

// --- values: the contract is the only authority ---------------------------

test("values ARE promoted for a field the contract declares as an enum", () => {
  const r = run();
  assert.deepEqual([...valuesFor(r, "status")].sort(), ["active", "churned"]);
  assert.deepEqual([...valuesFor(r, "plan")].sort(), ["free", "pro"]);
  // Safe because the contract already published the legal set; promotion adds
  // no exposure that a committed file did not already have.
});

test("values are NOT promoted for a low-cardinality field the contract leaves open", () => {
  const r = run();
  assert.equal(valuesFor(r, "owner"), undefined, "owner values must never be committed");
  assert.equal(valuesFor(r, "company"), undefined, "company values must never be committed");
  assert.ok(refusedFields(r).includes("owner"));
  assert.ok(refusedFields(r).includes("company"));
  // THE money case. These are structurally identical to `status` — 3 distinct
  // short strings out of 5 rows. Only the contract distinguishes them.
});

test("no promoted value anywhere contains customer data", () => {
  const blob = JSON.stringify(run().promoted);
  for (const forbidden of ["alice", "bob", "j.tran", "Acme", "Beta Legal",
                           "Cedar", "@acme.test", "renewal due", "asked about SSO"]) {
    assert.ok(!blob.includes(forbidden), `promoted output leaked: ${forbidden}`);
  }
});

test("a refusal states which rule refused it", () => {
  const r = run();
  const owner = r.refused.find((x) => x.field === "owner");
  assert.match(owner.reason, /not declared|contract/i,
    "a refusal must be explainable in a security review, not a silent drop");
});

// --- undeclared enum members: the EXISTENCE is the gotcha, not the value ----
//
// Red-team finding, 2026-08-14, confirmed by reproduction: the boundary's rule
// is "promote a value only when the contract declares it," but the code checked
// only that the FIELD was an enum, then promoted every observed value including
// ones NOT in the declared set. Those differ exactly on a stale contract against
// a server returning real data, which is the normal state — and a `tier` field
// declared `[free, pro]` returning `enterprise-acme-health` published a
// customer's name into a committed file.

test("an observed value outside the declared enum is NOT published", () => {
  const r = run({ observed: { ...OBSERVED,
    fieldValues: { ...OBSERVED.fieldValues, status: ["active", "dormant"] } } });
  assert.deepEqual([...valuesFor(r, "status")], ["active"],
    "only values the contract already committed may be promoted");
  assert.ok(!JSON.stringify(r).includes("dormant"),
    "the undeclared value must appear nowhere in the promoted output");
  assert.equal(r.promoted.fields.status.undeclared_count, 1,
    "that an undocumented value exists is still surfaced — as a count, never the value");
});

test("a stale enum against real data does not leak the real data", () => {
  // The concrete exploit: a two-value contract, customer-identifying strings on
  // the wire, non-production (the default when no environments file declares it).
  const contract = { type: "object", properties: { tier: { type: "string", enum: ["free", "pro"] } } };
  const r = promoteObservation({ operation: "GET /accounts",
    observed: { fieldValues: { tier: ["enterprise-acme-health", "enterprise-beta-legal", "free"] } },
    contract, environment: { production: false } });
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes("acme") && !blob.includes("beta-legal"),
    "customer-identifying values must never reach the promoted output");
  assert.deepEqual(r.promoted.fields.tier.values, ["free"]);
  assert.equal(r.promoted.fields.tier.undeclared_count, 2);
});

// --- THE INVARIANT (2026-08-14) -------------------------------------------
//
// The single property the promotion boundary exists to guarantee, stated
// directly and independent of environment: no value appears in the promoted
// output unless the contract already committed it as an enum member. This is
// the primary control. It does not depend on correctly guessing production —
// which is why the production default was deliberately left off (see ADR / the
// residual note): a guard that must classify the environment is weaker than one
// that holds in every environment.
//
// This test is the guard. If a future feature ever emits an undeclared value,
// it fails here, in every environment, before anything reaches a committed file.

test("INVARIANT: no undeclared value is ever promoted, in ANY environment", () => {
  // Adversarial: contracts whose declared enums are a strict subset of what the
  // server returns, so every field carries values the contract never blessed.
  const contract = {
    type: "object",
    properties: {
      status: { type: "string", enum: ["active"] },          // server also returns churned, banned
      region: { type: "string", enum: ["us"] },              // server also returns a customer's data centre
      tier:   { type: "string", enum: ["free", "pro"] },     // server also returns enterprise-<customer>
    },
  };
  const observed = { fieldValues: {
    status: ["active", "churned", "banned-acme-health"],
    region: ["us", "eu-cedar-clinic-dc1"],
    tier:   ["free", "pro", "enterprise-beta-legal", "enterprise-acme-health"],
  } };
  const declared = new Set(["active", "us", "free", "pro"]);

  for (const environment of [DEV, PROD, undefined, { name: "staging" }, { production: false }]) {
    const r = promoteObservation({ operation: "GET /accounts", observed, contract, environment });
    for (const [field, entry] of Object.entries(r.promoted.fields)) {
      for (const v of entry.values ?? []) {
        assert.ok(declared.has(v),
          `env ${JSON.stringify(environment)}: promoted '${v}' on '${field}', which the contract never declared`);
      }
    }
    // And no undeclared value survives anywhere in the serialised output, not
    // just under `values` — a customer name in any key is a leak.
    const blob = JSON.stringify(r.promoted);
    for (const leak of ["acme", "beta-legal", "cedar", "banned"]) {
      assert.ok(!blob.includes(leak),
        `env ${JSON.stringify(environment)}: '${leak}' reached the promoted output`);
    }
  }
});

// --- production never promotes --------------------------------------------

test("a production environment promotes no values at all", () => {
  const r = run({ environment: PROD });
  assert.equal(valuesFor(r, "status"), undefined,
    "declared enums are already public, but prod promotes nothing: defence in depth");
  assert.equal(valuesFor(r, "plan"), undefined);
});

test("a production environment still promotes structure", () => {
  const r = run({ environment: PROD });
  assert.deepEqual(r.promoted.shape, OBSERVED.shape);
  assert.equal(r.promoted.fields.status.distinct, 2);
  // Shape and cardinality remain useful and carry no values.
});

// --- belt and braces: refuse dangerous shapes even when "declared" ---------

test("secret-shaped values are refused even from a declared enum field", () => {
  const contract = { type: "object",
    properties: { token: { type: "string", enum: ["sk-live-aaa", "sk-live-bbb"] } } };
  const r = run({ contract,
    observed: { shape: { token: "string" }, fieldValues: { token: ["sk-live-aaa"] } } });
  assert.equal(valuesFor(r, "token"), undefined, "P0: never promote credential-shaped values");
  assert.ok(refusedFields(r).includes("token"));
});

test("email-shaped values are refused even from a declared enum field", () => {
  const contract = { type: "object",
    properties: { addr: { type: "string", enum: ["a@x.test", "b@x.test"] } } };
  const r = run({ contract,
    observed: { shape: { addr: "string" }, fieldValues: { addr: ["a@x.test"] } } });
  assert.equal(valuesFor(r, "addr"), undefined);
});

test("long free text is refused even from a declared enum field", () => {
  const long = "x".repeat(200);
  const contract = { type: "object", properties: { blurb: { type: "string", enum: [long] } } };
  const r = run({ contract,
    observed: { shape: { blurb: "string" }, fieldValues: { blurb: [long] } } });
  assert.equal(valuesFor(r, "blurb"), undefined);
});

test("a pathologically large declared enum is capped rather than dumped", () => {
  const many = Array.from({ length: 500 }, (_, i) => `code_${i}`);
  const contract = { type: "object", properties: { code: { type: "string", enum: many } } };
  const r = run({ contract,
    observed: { shape: { code: "string" }, fieldValues: { code: many.slice(0, 200) } } });
  assert.ok(valuesFor(r, "code").length <= 50, "a committed file is not a data dump");
  assert.equal(r.promoted.fields.code.distinct, 200, "the true count is still reported");
});

// --- non-strings and structural edges -------------------------------------

test("numeric values are never promoted, however small the range", () => {
  const r = run();
  assert.equal(valuesFor(r, "seats"), undefined,
    "a number can be a salary, an age, or an account balance");
  assert.equal(r.promoted.fields.seats.distinct, 3);   // [5,12,5,3,12]
});

test("timestamps are never promoted as values", () => {
  const r = run();
  assert.equal(valuesFor(r, "created_at"), undefined);
});

test("a field absent from the contract gets cardinality only", () => {
  const r = run({ observed: { ...OBSERVED,
    fieldValues: { ...OBSERVED.fieldValues, undocumented: ["a", "b", "a"] },
    shape: { ...OBSERVED.shape, undocumented: "string" } } });
  assert.equal(valuesFor(r, "undocumented"), undefined);
  assert.equal(r.promoted.fields.undocumented.distinct, 2);
});

test("no contract at all means no values are promoted anywhere", () => {
  const r = run({ contract: undefined });
  for (const f of Object.keys(OBSERVED.fieldValues))
    assert.equal(valuesFor(r, f), undefined, `${f} promoted without a contract to authorise it`);
  assert.ok(r.promoted.shape, "structure is still promoted");
});

test("empty observations produce an empty result rather than throwing", () => {
  const r = run({ observed: { shape: {}, fieldValues: {}, statusCodes: [] } });
  // fields is a null-prototype object (so a field named __proto__ is a real own
  // key, not the prototype); it is empty here, but deepEqual to {} would trip on
  // the differing prototype.
  assert.equal(Object.keys(r.promoted.fields).length, 0);
  assert.deepEqual(r.refused, []);
});

test("the result is JSON-serialisable and free of prototype pollution", () => {
  const r = run();
  const round = JSON.parse(JSON.stringify(r));
  assert.deepEqual(round.promoted.shape, r.promoted.shape);
});

// --- regression: real specs point at their models by $ref -------------------
// The first implementation returned nothing for every real API, because the
// unwrapper hit {"$ref": "#/components/schemas/Piece"}, found no `properties`,
// and silently authorised zero values. The fixtures above were all flat, so the
// suite passed while the feature did nothing. Dereferencing now happens before
// promotion; this proves the promoter still works on a dereferenced wrapper.
test("a dereferenced collection wrapper still authorises its item enums", () => {
  const contract = {
    type: "object",
    properties: {
      data: { type: "array", items: { type: "object", properties: {
        id: { type: "integer" },
        lane: { type: "string", enum: ["build-in-public", "top-of-funnel"] },
        owner: { type: "string" },
      } } },
      total: { type: "integer" },
    },
  };
  const r = run({ contract, observed: {
    shape: { id: "number", lane: "string", owner: "string" },
    fieldValues: { lane: ["build-in-public", "top-of-funnel"], owner: ["alice", "bob"] },
  } });
  assert.deepEqual([...valuesFor(r, "lane")].sort(), ["build-in-public", "top-of-funnel"]);
  assert.equal(valuesFor(r, "owner"), undefined);
});

// --- adversarial batch (2026-08-14): a field literally named __proto__
test("a field named __proto__ is preserved, not swallowed by the prototype", () => {
  const fieldValues = JSON.parse('{"__proto__":["a","b"],"status":["x"]}');   // a real own key
  const r = promoteObservation({ operation: "GET /x", observed: { fieldValues } });
  const ser = JSON.stringify(r.promoted.fields);
  assert.match(ser, /__proto__/, "the field must appear in a report whose job is completeness");
  assert.equal(r.promoted.fields.__proto__.distinct, 2);
});
