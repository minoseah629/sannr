// --- assertions -------------------------------------------------
// Deliberately not a language: no loops, no conditionals, no arithmetic, no
// user-defined functions. A check that needs those needs code. What this
// refuses to express is the feature.
export const ENVELOPE_VERSION = 2;
import { secretIn } from "./verdicts.mjs";
import { isDeepStrictEqual } from "node:util";

// Dotted path with numeric segments for arrays: "data.0.status", "meta.total".
export function atPath(obj, path) {
  if (path === undefined || path === null || path === "") return obj;
  let cur = obj;
  for (const seg of String(path).split(".")) {
    if (cur === null || cur === undefined) return undefined;
    if (!Object.hasOwn(Object(cur), seg)) return undefined;
    cur = cur[Array.isArray(cur) && /^\d+$/.test(seg) ? Number(seg) : seg];
  }
  return cur;
}

// A `matches` pattern comes from a committed file, and a committed file is a
// door: a nested quantifier such as (a+)+ makes the engine backtrack
// exponentially, so one imported test can hang every `suite run` in CI.
// Refused here (the runner), in normalizeSuite (the file), and escaped at the
// importer — three locks, because any one of them can be bypassed by an old
// suite already on disk.
const PATTERN_MAX_CHARS = 200;
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/;
// Importers express literal substring checks this way. Evaluate this exact
// spelling with includes(), avoiding two ambiguous wildcard repetitions.
function containsLiteral(pattern) {
  if (!pattern.startsWith('^.*') || !pattern.endsWith('.*$')) return null;
  const inner = pattern.slice(3, -3);
  if (!/^(?:[^\\.*+?^${}()|[\]]|\\[\\.*+?^${}()|[\]])*$/.test(inner)) return null;
  return inner.replace(/\\(.)/g, '$1');
}
export function unsafePattern(e) {
  if (typeof e !== "string") return "is not a string";
  if (e.length > PATTERN_MAX_CHARS) return `is longer than ${PATTERN_MAX_CHARS} characters`;
  if (NESTED_QUANTIFIER.test(e)) return "contains a nested quantifier";
  if (containsLiteral(e) !== null) return null;
  // Conservative regular-language subset. Quantified groups, lookaround,
  // backreferences and multiple variable repetitions need a stronger engine.
  // Refuse them by name instead of pretending a heuristic makes JS backtracking
  // safe. Escapes and character classes are atoms, not pattern punctuation.
  let repetitions = 0, expanded = 0;
  for (let i = 0; i < e.length; i++) {
    const c = e[i];
    if (c === '\\') { if (/[1-9k]/.test(e[++i] ?? '')) return 'contains a backreference'; continue; }
    if (c === '[') { for (i++; i < e.length && e[i] !== ']'; i++) if (e[i] === '\\') i++; continue; }
    if (c === '(' && e[i + 1] === '?') {
      if (e.slice(i, i + 3) !== '(?:') return 'contains an unsupported group';
      i += 2; continue;
    }
    if (c === ')' && /^[*+?{]/.test(e.slice(i + 1))) return 'contains a quantified group';
    if ('*+?'.includes(c)) repetitions++;
    if (c === '{') {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(e.slice(i));
      if (match) {
        const [, min, max] = match;
        expanded += Number(max || min);
        if (max !== undefined && max !== min) repetitions++;
        i += match[0].length - 1;
      }
    }
    if (repetitions > 1) return 'contains multiple variable repetitions';
    if (expanded > 1000) return 'exceeds the fixed repetition bound';
  }
  return null;
}

export const PATTERN_INPUT_MAX_CHARS = 4096;
export function matchesPattern(actual, pattern) {
  if (typeof actual !== 'string' || unsafePattern(pattern) !== null) return false;
  if (actual.length > PATTERN_INPUT_MAX_CHARS) throw Object.assign(new Error('Pattern input exceeds 4096 characters'), { code: 'ASSERTION_INPUT_OVERSIZED' });
  const literal = containsLiteral(pattern);
  if (literal === null) return new RegExp(pattern).test(actual);
  // The generated wildcards use ordinary dot semantics: line terminators may
  // occur only INSIDE the literal. includes() alone would silently broaden it.
  const breaks = /[\r\n\u2028\u2029]/g;
  const first = actual.search(breaks);
  if (first < 0) return actual.includes(literal);
  let last = first;
  for (const match of actual.matchAll(breaks)) last = match.index;
  const at = actual.indexOf(literal, Math.max(0, last - literal.length + 1));
  return at >= 0 && at <= first && at + literal.length > last;
}

export const OPERATORS = {
  // Response JSON and expected JSON are separate allocations. Arrays and
  // objects compare by structure, with strict types and ordered array items.
  equals: isDeepStrictEqual,
  not_equals: (a, e) => !isDeepStrictEqual(a, e),
  exists: (a, e) => (e === false ? a === undefined : a !== undefined),
  in: (a, e) => Array.isArray(e) && e.includes(a),
  matches: matchesPattern,
  type: (a, e) => e === "array" ? Array.isArray(a)
    : e === "null" ? a === null
    : e === "object" ? a !== null && typeof a === "object" && !Array.isArray(a)
    : typeof a === e,
  gt: (a, e) => typeof a === "number" && a > e,
  lt: (a, e) => typeof a === "number" && a < e,
  length: (a, e) => (Array.isArray(a) || typeof a === "string") && a.length === e,
};

// The three selectors. Everything else in a clause is an operator or a mistake.
const TARGETS = ["json", "header", "status"];
const strayError = (stray) =>
  `unknown operator ${stray.map((s) => `'${s}'`).join(", ")} — did you mean one of ${Object.keys(OPERATORS).join(", ")}?`;

// A refused pattern has not been tested against the response. Keep the
// lower-level matcher's boolean guard for its other callers, but name this
// distinction in assertion results just as suite admission and import do.
function patternRefusal(op, expected) {
  const reason = op === 'matches' ? unsafePattern(expected) : null;
  return reason ? { code: 'ASSERTION_PATTERN_REFUSED', reason } : null;
}

// One assertion clause -> {ok, detail}. Unknown operators fail loudly rather
// than passing silently, so a typo is never mistaken for a green check. A
// clause may carry several operators; all of them are the claim, so all of
// them are checked.
export function checkOne(clause, ctx) {
  const target = "status" in clause ? "status"
    : "header" in clause ? "header" : "json";
  let actual;
  if (target === "status") actual = ctx.status;
  else if (target === "header") actual = ctx.headers[String(clause.header).toLowerCase()];
  else actual = atPath(ctx.body, clause.json);
  if (target === "header" && /^(?:set-cookie|authorization|proxy-authorization)$/i.test(String(clause.header)) && secretIn(actual)) actual = "[redacted]";

  const ops = Object.keys(clause).filter((k) => Object.hasOwn(OPERATORS, k));
  // A key that is neither a target nor an operator is a mistake whatever else
  // the clause carries — `{json:"x", equals:1, equal:2}` used to run `equals`
  // and drop `equal` on the floor, green. Measured before refusing it: across
  // 383 clauses on disk (this repo, ../import-corpus, ../postman-corpus and its
  // flattened suites) and 279 the importers emit, not one carries a stray key.
  const stray = Object.keys(clause).filter((k) => !TARGETS.includes(k) && !Object.hasOwn(OPERATORS, k));
  if (!ops.length) {
    // `{status: 201}` is sugar for `{status: …, equals: 201}`, and it works ONLY
    // for status, where the clause value genuinely IS the expected value. For
    // json/header the value is a selector (a path, a header name), so a clause
    // with no operator asserts nothing — and the old code compared the value to
    // its own path, which can pass GREEN by coincidence. That is the exact
    // "confident output not backed by the claim" failure this tool exists to
    // kill, so it fails loudly instead. Unknown keys are named, because a typo'd
    // operator (`equal` for `equals`) is the most likely cause.
    // The sugar is the WHOLE clause: `{status: 201, foo: 1}` asserted the 201 and
    // dropped `foo`, so a typo next to the shorthand was green too.
    if (target === "status" && !stray.length) {
      const expected = clause[target];
      return { ok: actual === expected, target, path: clause[target], op: "equals", expected, actual };
    }
    return { ok: false, target, path: clause[target], op: "invalid", expected: undefined, actual,
      error: stray.length ? strayError(stray)
        : `a ${target} assertion needs an operator (e.g. equals, in, exists); this clause has none` };
  }
  // The same refusal when operators ARE present: a conjunction engine that
  // silently ignored the key it did not recognise would re-open the hole one
  // level down. The suite file keeps unknown keys (serializeSuite preserves
  // them for forward compatibility); the runner refuses to pretend it checked
  // one it cannot evaluate.
  const path = target === "json" ? clause.json : clause[target];
  if (stray.length)
    return { ok: false, target, path, op: "invalid", expected: undefined, actual, error: strayError(stray) };
  if (ops.length === 1) {
    const op = ops[0];
    const expected = clause[op];
    const refusal = patternRefusal(op, expected);
    if (refusal) return { ok: false, target, path, op, expected, actual, refused_ops: [op], ...refusal };
    const known = OPERATORS[op];
    return { ok: Boolean(known(actual, expected)), target, path, op, expected, actual };
  }
  // `{json:"count", gt:0, lt:3}` is a conjunction: the caller claims both, so
  // both are checked and the clause holds only when every operator holds.
  // Evaluating ops[0] alone passed that clause on count=10 — a green check for
  // something false, inside the engine whose whole job is to refuse that.
  // Every operator is evaluated, never short-circuited at the first failure, so
  // `ops` reports the whole claim whatever the data and a later operator's
  // outcome cannot be hidden by an earlier one. Key order is the clause's own;
  // serializeSuite canonicalises it, so a committed suite names the same
  // operator every run.
  const outcomes = ops.map((op) => {
    const expected = clause[op];
    const refusal = patternRefusal(op, expected);
    if (refusal) return { op, expected, ok: false, refused: true, ...refusal };
    try { return { op, expected, ok: Boolean(OPERATORS[op](actual, expected)) }; }
    // An operator that cannot be evaluated at all — `matches` over an input past
    // the engine's own limit — is a failed outcome, not an escape hatch. Letting
    // it throw past the others erased the operator that had ALREADY failed and
    // replaced the author's defect with the engine's limit; swallowing it would
    // be the silent drop this slice exists to kill. It fails, by name.
    catch (e) { return { op, expected, ok: false, refused: true,
                         ...(typeof e.code === "string" ? { code: e.code } : {}) }; }
  });
  const failure = outcomes.find((o) => !o.ok);
  const refused = outcomes.filter((o) => o.refused);
  const code = refused.find((o) => o.code)?.code;
  const reason = refused.find((o) => o.reason)?.reason;
  // On failure, `op`/`expected` name the FIRST operator that did not hold, so a
  // report points at one actionable expectation; `ops` lists them all, so no
  // renderer can show a multi-operator clause as a single check. `refused_ops`
  // and `code` survive even when an earlier operator already failed — that is
  // what makes "every operator was evaluated" a fact a test can hold us to,
  // and it says which operator raised the code rather than leaving it next to
  // an `op` that did not.
  return { ok: !failure, target, path,
           op: failure ? failure.op : ops.join("+"),
           ops,
           ...(refused.length ? { refused_ops: refused.map((o) => o.op) } : {}),
           ...(code ? { code } : {}),
           ...(reason ? { reason } : {}),
           expected: failure ? failure.expected : Object.fromEntries(ops.map((op) => [op, clause[op]])),
           actual };
}

export function runAssertions(expect, ctx, { onClause } = {}) {
  if (!Array.isArray(expect) || !expect.length) return null;
  const failures = [];
  let passed = 0;
  for (const [index, clause] of expect.entries()) {
    let r;
    try { r = checkOne(clause, ctx); }
    catch (e) { r = { ok: false, target: "clause", op: "invalid", expected: clause, ...(typeof e.code === 'string' ? { code: e.code } : {}),
                      actual: String(e.message).slice(0, 120) }; }
    // Internal evidence hook receives no actual response value. The public
    // result stays unchanged and unknown/refused checks cannot verify claims.
    onClause?.({ index, ok: r.ok === true, invalid: r.op === 'invalid' || Boolean(r.error || r.code || r.refused_ops?.length) });
    if (r.ok) passed += 1;
    else failures.push({ target: r.target, path: r.path ?? null, op: r.op, ...(r.ops ? { ops: r.ops } : {}),
                         ...(r.refused_ops ? { refused_ops: r.refused_ops } : {}),
                         ...(r.code ? { code: r.code } : {}),
                         ...(r.reason ? { reason: r.reason } : {}),
                         expected: r.expected,
                         actual: r.actual === undefined ? null : truncateValue(r.actual) });
  }
  return { passed, failed: failures.length, failures };
}

// Keep a failure report readable without letting a huge value blow the budget.
export const truncateValue = (v) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s !== undefined && s.length > 200 ? `${s.slice(0, 200)}…` : v;
};
