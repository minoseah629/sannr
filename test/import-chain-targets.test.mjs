// R3-C — importer fidelity: a Chai chain honors the target it was written for.
//
//   node --test test/import-chain-targets.test.mjs
//
// The defect these tests pin is the worst kind this project can ship: a
// translation that is COUNTED as translated, carries no loss entry, and
// asserts something the source never said. `expect(res.status).to.not.equal(
// 500)` became `{status: 500}` — the exact inverse, green on the failure it
// was written to catch. Its siblings (`be.true`, `have.length`, `be.a()`,
// `above`/`below` on a status or header target) emitted an operator with no
// target key at all, a clause that can never pass, also counted translated.
//
// The rule the tests enforce: every emitted clause names exactly one target
// and that target's value is defined; a recognized chain that cannot address
// the selected target is quarantined BY NAME, never approximated against a
// different target.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { importBruno, importBrunoDirectory, importPostman } from "../lib/import.mjs";
import { checkOne, runAssertions } from "../lib/assertions.mjs";
import { normalizeSuite, serializeSuite } from "../lib/suites.mjs";

const corpusSkip = existsSync(join(process.cwd(), "..", "import-corpus")) ? false
  : "sibling corpus ../import-corpus absent — local yardstick, run where it exists";

const FIXTURE = join(process.cwd(), "test", "fixtures", "import", "bruno-chain-targets.bru");

// One `.bru` around a tests block, so each case names only the chain it is about.
const bru = (tests, asserts = "") =>
  `meta {\n  name: chain\n  type: http\n  seq: 1\n}\n\nget {\n  url: /x\n  body: none\n  auth: none\n}\n` +
  (asserts ? `\nassert {\n${asserts}\n}\n` : "") +
  (tests ? `\ntests {\n  test("t", function() {\n${tests}\n  });\n}\n` : "");

// A Bruno request without a resolvable base stays in the todo file; its
// translated clauses ride there. Read both so a case is about translation,
// not about step placement.
const clausesOf = (out) => [...(out.suite?.requests ?? []), ...(out.todo ?? [])].flatMap((r) => r.expect ?? []);
const reasons = (out) => (out.report?.loss ?? []).map((entry) => entry.reason);
const translate = (tests, asserts) => {
  const source = bru(tests, asserts);
  return importBruno(source, { sourceText: source });
};
const ctx = (status, headers = {}, body = {}) => ({ status, headers, body });

// Exercise the persistence boundary too: an undefined or misparsed expectation
// can look plausible before serialization and silently change its meaning after.
const persistedImport = (source) => {
  const out = translate(source);
  const persisted = JSON.parse(serializeSuite({ ...out.suite, requests: [...out.suite.requests, ...out.todo] }));
  return { out, persisted, normalized: normalizeSuite("literal-fidelity", persisted) };
};

test("MAR-716 compound negation is quarantined rather than passing either forbidden value", () => {
  for (const selector of ['res.getHeader("x-state")', "res.body.state", "res.status"]) {
    const args = selector === "res.status" ? [400, 500] : ["bad", "worse"];
    const source = `expect(${selector}).to.not.equal(${JSON.stringify(args[0])}).and.not.equal(${JSON.stringify(args[1])});`;
    const { out, persisted, normalized } = persistedImport(source);
    assert.equal(out.report.counts.assertions_translated, 0, source);
    assert.deepEqual(clausesOf(out), [], source);
    assert.ok(reasons(out).some((reason) => reason.startsWith("not.equal() requires one fully consumed supported literal argument")));
    assert.ok(normalized.problems.some((problem) => problem.code === "SUITE_STEP_WITHOUT_EXPECT"));
    for (const value of args) {
      assert.equal(runAssertions(persisted.requests[0].expect, ctx(value, { "x-state": value }, { state: value })), null,
        "A quarantined predicate must not become a passing assertion after serialization");
    }
  }
});

test("MAR-716 quoted predicate arguments consume exactly one literal and report only the form", () => {
  const planted = "private-fixture-value-do-not-report";
  for (const [chain, form] of [
    [`equal("${planted}").and.equal("other")`, "equal()"],
    [`eql('${planted}').and.not.eql('other')`, "eql()"],
    [`include("${planted}").and.include("other")`, "include()"],
    [`contain('${planted}').and.contain('other')`, "contain()"],
    [`match("${planted}").and.match("other")`, "match()"],
    [`equal("${planted}" + "other")`, "equal()"],
    [`equal("${planted}", "other")`, "equal()"],
    [`equal("${planted}'oops")`, null], // A different quote INSIDE the string is valid.
    [`equal('\\123${planted}')`, "equal()"], // Legacy octal is outside the supported literal grammar.
    [`equal('\\u{61}${planted}')`, "equal()"], // Quarantine unsupported escape syntax instead of retaining backslashes.
    [`equal('\\xZZ${planted}')`, "equal()"],
  ]) {
    const { out, normalized } = persistedImport(`expect(res.body.state).to.${chain};`);
    if (!form) {
      assert.deepEqual(normalized.problems, []);
      assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: `${planted}'oops` })).failed, 0);
      continue;
    }
    assert.equal(out.report.counts.assertions_translated, 0, chain);
    assert.ok(normalized.problems.some((problem) => problem.code === "SUITE_STEP_WITHOUT_EXPECT"), chain);
    assert.ok(reasons(out).some((reason) => reason.startsWith(`${form} requires one fully consumed supported literal argument`)), chain);
    assert.ok(!JSON.stringify(out.report.loss).includes(planted), "Loss reasons must not retain predicate argument values");
    assert.ok(!JSON.stringify(out.report.counts.scripts_quarantined).includes(planted));
    assert.ok(!JSON.stringify(out).includes(planted), "A quarantined argument must not leak through another import surface");
  }
});

test("MAR-716 single quoted literals retain punctuation, semicolons and chain-like text", () => {
  for (const value of ["bad).and.not.equal(worse", 'bad").and.not.equal("worse', "one;two", "literal (value), [] {}", "a'b\"c", "slash\\quote\";end"]) {
    for (const raw of [JSON.stringify(value), `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`]) {
      const { out, normalized } = persistedImport(`expect(res.getHeader("x-state")).to.not.equal(${raw});`);
      assert.deepEqual(normalized.problems, [], raw);
      assert.deepEqual(out.report.loss, [], raw);
      assert.equal(out.report.counts.assertions_translated, 1, raw);
      const expect = normalized.suite.requests[0].expect;
      assert.equal(runAssertions(expect, ctx(200, { "x-state": value })).failed, 1, raw);
      assert.equal(runAssertions(expect, ctx(200, { "x-state": "different" })).passed, 1, raw);
    }
  }
});

test("MAR-716 supported escape sequences are decoded before persisted comparisons", () => {
  for (const [raw, value] of [
    [String.raw`"a\"b"`, 'a"b'], [String.raw`'a\'b'`, "a'b"],
    [String.raw`"a\\b"`, "a\\b"], [String.raw`'a\nb\tc\rd\be\ff'`, "a\nb\tc\rd\be\ff"],
    [String.raw`'a\v\0'`, "a\v\0"], [String.raw`'\x61\u0062'`, "ab"],
    [String.raw`"\uD83D\uDE00"`, "😀"], [String.raw`'a\/b'`, "a/b"],
  ]) {
    const { out, normalized } = persistedImport(`expect(res.body.state).to.equal(${raw});`);
    assert.deepEqual(normalized.problems, [], raw);
    assert.deepEqual(out.report.loss, [], raw);
    assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: value })).passed, 1, raw);
    assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: `${value}!` })).failed, 1, raw);
  }
});

test("MAR-716 a refused compound does not erase or inflate a separate supported assertion", () => {
  const { out, normalized } = persistedImport(`expect(res.status).to.equal(200);\nexpect(res.getHeader("x-state")).to.not.equal("bad").and.not.equal("worse");`);
  assert.deepEqual(normalized.problems, []);
  assert.equal(out.report.counts.assertions_translated, 1);
  assert.equal(out.report.counts.scripts_needing_manual_conversion, 1);
  assert.equal(out.report.loss.length, 1);
  assert.deepEqual(normalized.suite.requests[0].expect, [{ status: 200 }]);
  assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200)).passed, 1);
  assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(500)).failed, 1);
});

test("MAR-716 import never evaluates a compound expression to resolve its argument", () => {
  const marker = "__mar716_import_source_executed";
  delete globalThis[marker];
  try {
    const { out, normalized } = persistedImport(`expect(res.body.state).to.equal("bad" + (globalThis.${marker} = true) + "worse");`);
    assert.equal(globalThis[marker], undefined);
    assert.equal(out.report.counts.assertions_translated, 0);
    assert.ok(normalized.problems.some((problem) => problem.code === "SUITE_STEP_WITHOUT_EXPECT"));
  } finally { delete globalThis[marker]; }
});

test("MAR-716 regex quotes and semicolons cannot disappear behind a translated status", () => {
  for (const [pattern, value] of [[`/"/`, '"'], ["/'/", "'"], ["/;/", ";"], [`/["';]/`, '"']]) {
    const { out, normalized } = persistedImport(`expect(res.status).to.equal(200);\nexpect(res.body.state).to.match(${pattern});`);
    assert.deepEqual(normalized.problems, []);
    assert.deepEqual(out.report.loss, [], pattern);
    assert.equal(out.report.counts.assertions_translated, 2, pattern);
    assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: value })).passed, 2, pattern);
    assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: "different" })).failed, 1, pattern);
  }
});

test("MAR-716 an unparsed trailing predicate is reported even when an earlier assertion translates", () => {
  for (const broken of ['not.equal("private-unclosed-value);', "not.equal('private-unclosed-value);", 'match(/private-unclosed-value);']) {
    const { out, normalized } = persistedImport(`expect(res.status).to.equal(200);\nexpect(res.body.state).to.${broken}`);
    assert.deepEqual(normalized.problems, []);
    assert.equal(out.report.counts.assertions_translated, 1);
    assert.ok(out.report.loss.some(entry => entry.name === "t" && /unparsed assertion/.test(entry.reason)));
    assert.ok(out.report.counts.scripts_needing_manual_conversion > 0);
    assert.ok(!JSON.stringify(out).includes("private-unclosed-value"));
    assert.deepEqual(normalized.suite.requests[0].expect, [{ status: 200 }]);
  }
});

test("MAR-716 unsupported scalar literals never change meaning through JSON persistence", () => {
  for (const raw of ["TRUE", "FALSE", "NULL", "undefined", "1e999", "-1e999", "010", "08", "-00", "-0"]) {
    const { out, normalized } = persistedImport(`const TRUE = false;\nexpect(res.body.state).to.not.equal(${raw});`);
    assert.equal(out.report.counts.assertions_translated, 0, raw);
    assert.ok(normalized.problems.some(problem => problem.code === "SUITE_STEP_WITHOUT_EXPECT"), raw);
    assert.ok(reasons(out).some(reason => reason.startsWith("not.equal() requires one fully consumed supported literal argument")), raw);
  }
  for (const [raw, value] of [["true", true], ["false", false], ["null", null], ["0", 0], [".5", .5], ["1.", 1], ["1E3", 1000], ["-1e-3", -.001]]) {
    const { out, normalized } = persistedImport(`expect(res.body.state).to.equal(${raw});`);
    assert.deepEqual(normalized.problems, [], raw);
    assert.deepEqual(out.report.loss, [], raw);
    assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: value })).passed, 1, raw);
    assert.equal(runAssertions(normalized.suite.requests[0].expect, ctx(200, {}, { state: "different" })).failed, 1, raw);
  }
});

test("MAR-716 malformed chains containing many regex tokens remain bounded", () => {
  const source = bru(`expect(res.status).to.equal(200);\nexpect(res.body.state).to.equal(${'/a/'.repeat(5000)}"unclosed);`);
  const script = `import { readFileSync } from 'node:fs'; import { importBruno } from ${JSON.stringify(new URL('../lib/import.mjs', import.meta.url).href)};
    const out = importBruno(readFileSync(0, 'utf8')); console.log(JSON.stringify({ count: out.report.counts.assertions_translated, loss: out.report.loss.length }));`;
  const result = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { input: source, encoding: 'utf8', timeout: 5000 }));
  assert.equal(result.count, 1);
  assert.ok(result.loss > 0);
});

test("R3-C the positive status sugar is unchanged and stays a three-digit literal", () => {
  assert.deepEqual(clausesOf(translate(`    expect(res.status).to.equal(200);`)), [{ status: 200 }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.getStatus()).to.equal(201);`)), [{ status: 201 }]);
  // A non-status literal on a status target is refused rather than emitted as
  // a clause that can never pass.
  const odd = translate(`    expect(res.status).to.equal("200");`);
  assert.deepEqual(clausesOf(odd), []);
  assert.ok(reasons(odd).some((r) => /equal\(\) has no exact suite operator on a status target/.test(r)), reasons(odd).join(" | "));
});

test("R3-C chains that cannot address a status target are quarantined by name, never retargeted", () => {
  for (const [source, form] of [
    [`    expect(res.status).to.be.true;`, "be.true"],
    [`    expect(res.status).to.have.length(3);`, "have.length()"],
    [`    expect(res.status).to.be.a("number");`, "be.a()"],
    [`    expect(res.status).to.exist;`, "exist"],
    [`    expect(res.status).to.include(20);`, "include()"],
    [`    expect(res.status).to.match(/^2/);`, "match()"],
  ]) {
    const out = translate(source);
    assert.deepEqual(clausesOf(out), [], `${form} emitted a clause`);
    assert.equal(out.report.counts.assertions_translated, 0, `${form} was counted translated`);
    const reason = `${form} has no exact suite operator on a status target; not approximated`;
    assert.ok(reasons(out).includes(reason), `${form}: ${reasons(out).join(" | ")}`);
    // Quarantined BY NAME: the loss entry carries the test it came from.
    assert.ok(out.report.loss.some((entry) => entry.name === "t" && entry.reason === reason));
  }
});

test("R3-C chains that cannot address a header target are quarantined by name", () => {
  for (const [source, form] of [
    [`    expect(res.getHeader("X-Flag")).to.be.true;`, "be.true"],
    [`    expect(res.getHeader("X-Flag")).to.have.length(3);`, "have.length()"],
    [`    expect(res.getHeader("X-Flag")).to.be.a("string");`, "be.a()"],
    [`    expect(res.getHeader("X-Flag")).to.be.above(1);`, "above()"],
  ]) {
    const out = translate(source);
    assert.deepEqual(clausesOf(out), [], `${form} emitted a clause`);
    assert.equal(out.report.counts.assertions_translated, 0, `${form} was counted translated`);
    assert.ok(reasons(out).includes(`${form} has no exact suite operator on a header target; not approximated`),
      `${form}: ${reasons(out).join(" | ")}`);
  }
});

test("R3-C a header selector that resolves to an empty name is refused for every form", () => {
  // No response carries a header with no name, so a clause built from an empty
  // selector can never pass — the unfailable shape this slice exists to remove.
  // The parent emitted `{json: undefined, equals: "x"}`; the first round of this
  // slice emitted `{header: "", equals: "x"}`. Both are claims nothing can satisfy.
  for (const [source, form] of [
    [`    expect(res.getHeader("")).to.equal("x");`, "equal()"],
    [`    expect(res.getHeader("")).to.not.equal("x");`, "not.equal()"],
    [`    expect(res.getHeader("")).to.include("x");`, "include()"],
    [`    expect(res.getHeader("")).to.match(/x/);`, "match()"],
    [`    expect(res.getHeader("")).to.exist;`, "exist"],
    [`    expect(res.headers[""]).to.equal("x");`, "equal()"],
  ]) {
    const out = translate(source);
    assert.deepEqual(clausesOf(out), [], `${form} emitted a clause for an empty header name`);
    assert.equal(out.report.counts.assertions_translated, 0, `${form} was counted translated`);
    const reason = `${form} names an empty header, which can never match a response header; not translated`;
    assert.ok(reasons(out).includes(reason), `${form}: ${reasons(out).join(" | ")}`);
    assert.ok(out.report.loss.some((entry) => entry.name === "t" && entry.reason === reason));
  }
  // A named header is unaffected, and the EMPTY JSON PATH is not the same case:
  // it selects the whole body and still translates.
  assert.deepEqual(clausesOf(translate(`    expect(res.getHeader("x-a")).to.equal("x");`)), [{ header: "x-a", equals: "x" }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body).to.equal("x");`)), [{ json: "", equals: "x" }]);
});

test("R3-C header equality, include, match and exist still translate unchanged", () => {
  assert.deepEqual(clausesOf(translate(`    expect(res.getHeader("Content-Type")).to.include("json");`)),
    [{ header: "content-type", matches: "^.*json.*$" }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.getHeader("Content-Type")).to.equal("application/json");`)),
    [{ header: "content-type", equals: "application/json" }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.getHeader("Content-Type")).to.match(/^application/);`)),
    [{ header: "content-type", matches: "^application" }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.getHeader("Content-Type")).to.exist;`)),
    [{ header: "content-type", exists: true }]);
});

test("R3-C every json chain form is unchanged, including the whole-body target", () => {
  assert.deepEqual(clausesOf(translate(`    expect(res.body.ok).to.be.true;`)), [{ json: "ok", equals: true }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.ok).to.be.false;`)), [{ json: "ok", equals: false }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.ok).to.be.null;`)), [{ json: "ok", equals: null }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.tags).to.have.length(2);`)), [{ json: "tags", length: 2 }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.name).to.be.a("string");`)), [{ json: "name", type: "string" }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.n).to.be.above(1);`)), [{ json: "n", gt: 1 }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.n).to.be.below(9);`)), [{ json: "n", lt: 9 }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body.id).to.not.equal(1);`)), [{ json: "id", not_equals: 1 }]);
  assert.deepEqual(clausesOf(translate(`    expect(res.body).to.exist;`)), [{ json: "", exists: true }]);
  // The whole-body target is the empty path; it must stay a json target and
  // never be mistaken for a missing one.
  assert.deepEqual(clausesOf(translate(`    expect(res.body).to.be.true;`)), [{ json: "", equals: true }]);
});

test("R3-C declarative comparisons stay exact and JSON containment is named unsupported", () => {
  const out = translate("", "  res.body.count: gt 1\n  res.body.count: lt 9\n  res.body.name: eq ok\n  res.body.name: neq nope\n  res.body.message: contains a.b*c");
  assert.deepEqual(clausesOf(out), [
    { json: "count", gt: 1 }, { json: "count", lt: 9 },
    { json: "name", equals: "ok" }, { json: "name", not_equals: "nope" },
  ]);
  assert.ok(out.report.loss.some((entry) => /contains has no exact suite operator/.test(entry.reason)));
  // String regexes reject valid array containment and multiline strings, so
  // neither can become an unconditional source claim through approximation.
  assert.equal(checkOne({ json: "message", matches: "^.*ready.*$" }, ctx(200, {}, { message: ["ready"] })).ok, false);
  assert.equal(checkOne({ json: "message", matches: "^.*ready.*$" }, ctx(200, {}, { message: "ready\nlater" })).ok, false);
});

test("R3-C the declarative status rule is unchanged: eq with three digits, everything else named", () => {
  assert.deepEqual(clausesOf(translate("", "  res.status: eq 200")), [{ status: 200 }]);
  const gte = translate("", "  res.status: gte 200");
  assert.deepEqual(clausesOf(gte), []);
  assert.ok(reasons(gte).some((r) => /outside the declarative\/mechanical grammar/.test(r)), reasons(gte).join(" | "));
});

// The invariant. A clause that names no target, or names one whose value is
// undefined, cannot be evaluated by `checkOne` against anything the source
// meant — it is a fabricated claim wearing a translation's provenance.
const assertClauseShape = (clause, where) => {
  const keys = ["status", "header", "json"].filter((key) => key in clause);
  assert.equal(keys.length, 1, `${where}: ${JSON.stringify(clause)} names ${keys.length} targets`);
  const value = clause[keys[0]];
  assert.notEqual(value, undefined, `${where}: ${JSON.stringify(clause)} has an undefined target`);
  assert.ok(!(typeof value === "number" && Number.isNaN(value)), `${where}: ${JSON.stringify(clause)} has a NaN target`);
  if (keys[0] === "status") assert.ok(value === true || (typeof value === "number" && /^\d{3}$/.test(String(value))),
    `${where}: ${JSON.stringify(clause)} is neither the status marker nor a three-digit status`);
  if (keys[0] === "header") assert.ok(typeof value === "string" && value.length > 0, `${where}: ${JSON.stringify(clause)} has an empty header name`);
};

test("chain-target fixture preserves exact translation, quarantine and executable semantics after persistence", () => {
  const text = readFileSync(FIXTURE, "utf8");
  const out = importBruno(text, { sourceText: text });
  const clauses = clausesOf(out);
  for (const clause of clauses) assertClauseShape(clause, "fixture");
  // What the fixture translates, exactly: four status clauses, two header
  // clauses, two json range clauses, one json boolean, one json equality.
  assert.deepEqual(clauses, [
    { status: true, not_equals: 500 },
    { status: true, gt: 199 },
    { status: true, lt: 300 },
    { status: 200 },
    { header: "content-type", not_equals: "text/plain" },
    { header: "content-type", matches: "^.*json.*$" },
    { json: "n", gt: 1 },
    { json: "n", lt: 9 },
    { json: "ok", equals: true },
    { json: "name", equals: "ok" },
  ]);
  assert.equal(out.report.counts.assertions_translated, clauses.length);
  const persisted = JSON.parse(serializeSuite({ v: 2, requests: [
    { id: "one", method: "GET", path: "/things", expect: clauses },
  ] }));
  const normalized = normalizeSuite("chain-targets", persisted);
  assert.deepEqual(normalized.problems, []);
  assert.deepEqual(normalized.suite.requests[0].expect, clauses);
  // These were formerly separate imports of the same source predicates. Check
  // both outcomes on the actual persisted clauses, including each range edge.
  for (const [index, pass, fail] of [
    [0, ctx(200), ctx(500)], [1, ctx(204), ctx(100)], [2, ctx(204), ctx(404)],
    [4, ctx(200, { "content-type": "application/json" }), ctx(200, { "content-type": "text/plain" })],
  ]) {
    const clause = normalized.suite.requests[0].expect[index], label = JSON.stringify(clause);
    assert.equal(checkOne(clause, pass).ok, true, label);
    assert.equal(checkOne(clause, fail).ok, false, label);
  }
  assert.equal(checkOne(clauses[0], ctx(true)).ok, true, "the true marker is a selector, not the expected status");
  assert.equal(checkOne(clauses[6], ctx(200, {}, { n: 1 })).ok, false, "gt must not approximate gte at the boundary");
  // And what it refuses, by name, with a reason each.
  const refused = out.report.loss.filter((entry) => /not approximated|not translated/.test(entry.reason))
    .map((entry) => `${entry.name} => ${entry.reason}`).sort();
  assert.deepEqual(refused, [
    "empty header name => equal() names an empty header, which can never match a response header; not translated",
    "header is a string => be.a() has no exact suite operator on a header target; not approximated",
    "header is above one => above() has no exact suite operator on a header target; not approximated",
    "header is long => have.length() has no exact suite operator on a header target; not approximated",
    "header is truthy => be.true has no exact suite operator on a header target; not approximated",
    "res.body.count: gte 1 => gte/lte have no exact suite operator; not approximated as gt/lt",
    "res.body.count: lte 9 => gte/lte have no exact suite operator; not approximated as gt/lt",
    "res.body.message: contains a.b*c => contains has no exact suite operator across JSON strings and arrays; not approximated as a regex",
    "status exists => exist has no exact suite operator on a status target; not approximated",
    "status has a length => have.length() has no exact suite operator on a status target; not approximated",
    "status is a number => be.a() has no exact suite operator on a status target; not approximated",
    "status is truthy => be.true has no exact suite operator on a status target; not approximated",
  ].sort());
});

test("R3-C every clause translated from the upstream Bruno corpus names exactly one defined target", { skip: corpusSkip }, () => {
  const root = join(process.cwd(), "..", "import-corpus", "bruno");
  const files = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) visit(path);
      else if (name.endsWith(".bru")) files.push(path);
    }
  };
  visit(root);
  assert.ok(files.length > 100, `corpus is too small to be the yardstick: ${files.length}`);
  let clauses = 0;
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    let out;
    try { out = importBruno(text, { sourceText: text }); } catch { continue; }
    for (const clause of clausesOf(out)) { assertClauseShape(clause, path.slice(root.length + 1)); clauses += 1; }
  }
  assert.ok(clauses > 200, `corpus translated too few clauses to prove the invariant: ${clauses}`);
  const directory = importBrunoDirectory(join(root, "usebruno-bruno-tests"));
  for (const request of [...directory.suite.requests, ...directory.todo])
    for (const clause of request.expect ?? []) assertClauseShape(clause, "directory");
});

test("R3-C Postman status negations are never translated as a positive status equality", () => {
  // Not a rewrite: the Postman recognizers do not match a negated status, and
  // the pin is that they never silently become `{status: N}` (the Bruno bug's
  // shape) if a recognizer is widened later.
  for (const statement of [
    "pm.response.to.not.have.status(500);",
    "pm.expect(pm.response.code).to.not.equal(500);",
    "pm.expect(pm.response.code).to.not.eql(500);",
  ]) {
    const collection = { info: { name: "negations", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
      item: [{ name: "one", request: { method: "GET", url: { raw: "https://fixture.invalid/x" } },
        event: [{ listen: "test", script: { exec: [`pm.test("t", function () { ${statement} });`] } }] }] };
    const text = JSON.stringify(collection);
    const out = importPostman(JSON.parse(text), { sourceText: text });
    const clauses = clausesOf(out);
    assert.ok(!clauses.some((clause) => "status" in clause && clause.status === 500),
      `${statement} translated into a positive status equality: ${JSON.stringify(clauses)}`);
    for (const clause of clauses) assertClauseShape(clause, statement);
    assert.equal(out.report.counts.scripts_needing_manual_conversion, 1, `${statement} was not counted manual`);
  }
});
