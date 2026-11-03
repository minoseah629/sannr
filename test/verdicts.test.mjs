import { LAYOUT } from "../lib/layout.mjs";
// `sannr verdict` records decisions NOT to use an API into the committed
// file (ADR-0033). Four properties under test, each of which failed by
// construction before the feature existed (the subcommand was unknown):
//
//   1. the class taxonomy is closed — an unknown class is refused
//   2. free text goes through the SAME secret guard as `note`
//   3. an expired verdict renders as a QUESTION, never as an answer
//   4. the block is committed, JSON-serialisable, and proto-pollution-safe
//
//   node --test test/verdicts.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync,  readFileSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isExpired, renderVerdict, recordVerdict, validateVerdict, VERDICT_CLASSES } from "../lib/verdicts.mjs";
import { PROSE_SURFACES } from "../lib/brand.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(REPO, "bin", "cli.mjs");

function repoWithContext() {
  const dir = mkdtempSync(join(tmpdir(), "verdict-test-"));
  execFileSync("git", ["init", "-q", "."], { cwd: dir });
  writeFileSync(join(dir, LAYOUT.context),
    JSON.stringify({ v: 0, api: { name: "t" }, operations: {} }));
  return dir;
}

// Returns { code, out } for a verdict invocation. Never throws on non-zero exit.
function verdict(dir, ...args) {
  try {
    const out = execFileSync("node", [CLI, "verdict", ...args], { cwd: dir, encoding: "utf8" });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

const REJECT = ["--verdict", "rejected", "--reason", "429 at 10 req/s sustained; we need 40", "--class", "measured"];

// --- recording -------------------------------------------------------------

test("a full verdict records into the committed file", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "twilio/verify", ...REJECT,
    "--scope", "SMS verification only; voice not evaluated", "--held-by", "org");
  assert.equal(r.code, 0, r.out);
  const ctx = JSON.parse(readFileSync(join(dir, LAYOUT.context), "utf8"));
  const v = ctx.verdicts["twilio/verify"];
  assert.equal(v.verdict, "rejected");
  assert.equal(v.class, "measured");
  assert.match(v.reason, /429 at 10 req\/s/);
  assert.equal(v.held_by, "org");
  assert.equal(v.revisable, false);
  assert.equal(v.last_confirmed, new Date().toISOString().slice(0, 10));
});

test("an unknown class is refused and nothing is written", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "twilio/verify", "--verdict", "rejected", "--reason", "too slow", "--class", "vibes");
  assert.notEqual(r.code, 0, "the taxonomy is closed; 'vibes' must be refused");
  assert.match(r.out, /INVALID_VERDICT/);
  assert.match(r.out, /measured\|documented\|priced\|structural\|contextual\|judgment/);
  assert.equal(JSON.parse(readFileSync(join(dir, LAYOUT.context), "utf8")).verdicts, undefined);
});

test("an unknown verdict state is refused", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "x", "--verdict", "maybe", "--reason", "hm", "--class", "measured");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /rejected\|accepted\|deferred/);
});

test("a verdict without a reason is refused: it would be an opinion with a date on it", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "x", "--verdict", "rejected", "--class", "measured");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /reason/);
});

test("judgment verdicts carry their holder and revisability", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "acme-events", "--verdict", "rejected", "--reason", "their bulk endpoint drops rows past 500 without an error",
    "--class", "judgment", "--held-by", "lead", "--revisable");
  assert.equal(r.code, 0, r.out);
  const v = JSON.parse(readFileSync(join(dir, LAYOUT.context), "utf8")).verdicts["acme-events"];
  assert.equal(v.held_by, "lead");
  assert.equal(v.revisable, true);
});

// --- the probe -------------------------------------------------------------

test("a probe path that does not exist is refused: a dangling probe is just an opinion", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "twilio/verify", ...REJECT, "--probe", "envelopes/nope.json");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /PROBE_NOT_FOUND/);
});

test("a probe outside the repo is refused: it cannot be committed", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "twilio/verify", ...REJECT, "--probe", "../outside.json");
  assert.notEqual(r.code, 0);
  assert.match(r.out, /PROBE_OUTSIDE_REPO/);
});

test("a committed JSON envelope records as a repo-relative path", () => {
  const dir = repoWithContext();
  writeFileSync(join(dir, "probe.json"), JSON.stringify({ v: 1, request: { method: "GET", path: "/v1/limits" } }));
  const r = verdict(dir, "twilio/verify", ...REJECT, "--probe", "./probe.json");
  assert.equal(r.code, 0, r.out);
  const v = JSON.parse(readFileSync(join(dir, LAYOUT.context), "utf8")).verdicts["twilio/verify"];
  assert.equal(v.probe, "probe.json");
});

// --- the secret guard ------------------------------------------------------
// Verdicts are a new free-text path around the promotion boundary. Same
// shapes, same exit code as `note` — one guard, two doors.

const SECRET = "xoxb-9999-REALSECRETVALUE";

test("a secret in the REASON is refused", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "twilio/verify", "--verdict", "rejected",
    "--reason", `auth with ${SECRET} kept 401ing`, "--class", "measured");
  assert.equal(r.code, 2);
  assert.match(r.out, /SECRET_IN_VERDICT/);
  assert.ok(!readFileSync(join(dir, LAYOUT.context), "utf8").includes(SECRET));
});

test("a secret in the TARGET is refused: the key position is a door too", () => {
  const dir = repoWithContext();
  const r = verdict(dir, `https://api.example.com/hooks?access_token=${SECRET}`, ...REJECT);
  assert.equal(r.code, 2);
  assert.match(r.out, /SECRET_IN_VERDICT/);
  assert.ok(!readFileSync(join(dir, LAYOUT.context), "utf8").includes(SECRET));
});

test("an email address in SCOPE is refused, same as note", () => {
  const dir = repoWithContext();
  const r = verdict(dir, "twilio/verify", ...REJECT, "--scope", "per bob@customer.example.com only");
  assert.equal(r.code, 2);
  assert.match(r.out, /email address/);
});

// --- expiry: a question, never an answer -----------------------------------

test("a fresh verdict shows as an answer; an expired one as a question", () => {
  const dir = repoWithContext();
  verdict(dir, "fresh/api", ...REJECT);
  verdict(dir, "stale/api", "--verdict", "rejected", "--reason", "429 at 10 req/s",
    "--class", "measured", "--confirmed", "2026-03-14");
  const r = verdict(dir, "show");
  assert.equal(r.code, 0, r.out);
  const fresh = r.out.split("\n").find((l) => l.includes("fresh/api"));
  const stale = r.out.split("\n").find((l) => l.includes("stale/api"));
  assert.match(fresh, /rejected \[measured\]/, "fresh renders as a statement");
  assert.doesNotMatch(fresh, /before relying/);
  assert.match(stale, /^\? /, "expired leads with a question mark");
  assert.match(stale, /last confirmed 2026-03-14/);
  assert.match(stale, /re-run the probe before relying on this/,
    "expired must instruct re-checking, not assert the verdict");
});

test("isExpired honours the TTL and a missing last_confirmed never expires", () => {
  assert.equal(isExpired({ last_confirmed: "2026-03-14" }, "2026-08-15"), true);
  assert.equal(isExpired({ last_confirmed: "2026-08-01" }, "2026-08-15"), false);
  assert.equal(isExpired({}, "2026-08-15"), false, "no date to be past");
});

test("renderVerdict recheck instruction tracks the class", () => {
  const old = { verdict: "rejected", reason: "docs say webhooks do not retry",
    class: "documented", last_confirmed: "2025-01-01", held_by: "org", revisable: false };
  assert.match(renderVerdict("hooky", old, "2026-08-15"), /re-fetch the docs before relying/);
  const judged = { ...old, class: "judgment", held_by: "lead", revisable: true };
  assert.match(renderVerdict("hooky", judged, "2026-08-15"), /held by lead, revisable/);
  assert.match(renderVerdict("hooky", judged, "2026-08-15"), /ask whoever holds it/);
});

// --- proto safety and serialisability --------------------------------------

test("a target named __proto__ stores as an own key without polluting prototypes", () => {
  const ctx = { operations: {} };
  recordVerdict(ctx, "__proto__", { verdict: "rejected", reason: "hostile name", cls: "judgment" });
  assert.equal({}.reason, undefined, "Object.prototype must not grow a 'reason'");
  assert.equal(Object.getPrototypeOf(ctx.verdicts), Object.prototype, "the container prototype is untouched");
  assert.ok(Object.hasOwn(ctx.verdicts, "__proto__"), "stored as an own property");
  const roundtrip = JSON.parse(JSON.stringify(ctx));
  assert.ok(Object.hasOwn(roundtrip.verdicts, "__proto__"), "survives a JSON round-trip as data");
  assert.equal({}.reason, undefined, "and the round-trip did not pollute either");
});

test("the recorded block is exactly the schema: caller extras never leak in", () => {
  const ctx = {};
  const entry = recordVerdict(ctx, "x", { verdict: "deferred", reason: "later", cls: "contextual",
    evil: () => {}, nested: { deep: true } });
  assert.deepEqual(Object.keys(entry).sort(),
    ["class", "held_by", "last_confirmed", "reason", "revisable", "verdict"]);
  assert.equal(typeof JSON.parse(JSON.stringify(ctx.verdicts)), "object");
});

test("validateVerdict rejects every class outside the taxonomy, including inherited names", () => {
  // "toString" would pass an `in` check via the prototype chain; the taxonomy
  // must be consulted with own-property semantics.
  for (const cls of ["vibes", "toString", "constructor", "", undefined])
    assert.ok(validateVerdict({ verdict: "rejected", reason: "r", cls }).length > 0, String(cls));
  for (const cls of ["measured", "documented", "priced", "structural", "contextual", "judgment"])
    assert.equal(validateVerdict({ verdict: "rejected", reason: "r", cls }).length, 0, cls);
});

// --- reading a hostile or hand-edited file ---------------------------------
// `verdict show` reads a committed file that a human may have edited by hand,
// so every entry it renders is untrusted input. None of these may crash, and
// none may render a claim whose freshness cannot be established as a confident
// answer — an agent reads a confident sentence as a fact.

test("an unparseable last_confirmed renders as a question, not a confident answer", () => {
  // The dangerous case a valid-vs-missing view of dates misses: a present but
  // garbage date DID claim a confirmation, so it must not read as fresh. It
  // cannot be placed in time, so it cannot be shown fresh, so it is a question.
  const bad = { verdict: "rejected", reason: "429 at 10 req/s", class: "measured",
    last_confirmed: "last spring", held_by: "org", revisable: false };
  assert.equal(isExpired(bad, "2026-08-15"), true, "an uncheckable date cannot be shown fresh");
  const line = renderVerdict("twilio/verify", bad, "2026-08-15");
  assert.match(line, /re-run the probe before relying on this/,
    "renders as a re-check question, not 'rejected [measured] — …'");
  assert.doesNotMatch(line, /^twilio\/verify: rejected \[measured\]/,
    "must not print the confident answer form");
});

test("verdict show survives no-last_confirmed, a malformed date, an unknown class and a __proto__ key", () => {
  const dir = repoWithContext();
  // Hand-write the file as raw JSON text: a "__proto__" key set through an
  // object literal would rewrite the prototype and never store, so the only way
  // a file carries one is a human typing it. JSON.parse DOES round-trip it as an
  // own property, which is exactly the hostile input the reader must survive.
  writeFileSync(join(dir, LAYOUT.context), JSON.stringify({ v: 0, api: { name: "t" }, operations: {} })
    .replace(/}$/, `,"verdicts":{
      "no/date":{"verdict":"deferred","reason":"never re-confirmed","class":"contextual"},
      "bad/date":{"verdict":"rejected","reason":"garbage date","class":"measured","last_confirmed":"yesterday-ish"},
      "odd/class":{"verdict":"rejected","reason":"hand-typed class","class":"vibes","last_confirmed":"2026-01-01"},
      "__proto__":{"verdict":"rejected","reason":"hostile key","class":"judgment","last_confirmed":"2026-01-01"}
    }}`));
  const r = verdict(dir, "show");
  assert.equal(r.code, 0, `verdict show must not crash on a hand-edited file: ${r.out}`);
  // no last_confirmed never claimed freshness, so it stays an answer…
  assert.match(r.out, /no\/date: deferred \[contextual\]/);
  // …while the garbage date and the stale odd class are questions, and the
  // unknown class degrades to a generic "re-check" instead of throwing.
  assert.match(r.out.split("\n").find((l) => l.includes("bad/date")), /^\? /);
  assert.match(r.out.split("\n").find((l) => l.includes("odd/class")), /re-check before relying on this/);
  // the hostile key round-trips as data and is rendered like any other verdict
  assert.match(r.out, /__proto__ was rejected for: hostile key/);
  assert.equal({}.reason, undefined, "reading the file did not pollute Object.prototype");
});

test("every --class example a reader can copy names a class that exists", () => {
  // The taxonomy is closed and validated, so a documented example with a class
  // outside it is not a typo a reader shrugs off: they paste the line the docs
  // gave them, get INVALID_VERDICT, and their first attempt at the one write
  // this product asks them to make fails. `--class missing-capability` shipped
  // in help and in the quickstart, and the skill installed next to it carried
  // the correct list — the docs contradicted each other.
  //
  // Every surface a class name is copied FROM is scanned, so the next example
  // added anywhere is covered without anyone remembering this test exists.
  const surfaces = [
    ["`--help`", execFileSync("node", [CLI, "--help"], { encoding: "utf8" })],
    ["`verdict --help`", execFileSync("node", [CLI, "verdict", "--help"], { encoding: "utf8" })],
    ...["docs/quickstart.md", "README.md", ...PROSE_SURFACES.filter((f) => f.endsWith("SKILL.md"))]
      .map((f) => [f, readFileSync(join(REPO, f), "utf8")]),
  ];
  const bad = [];
  for (const [where, text] of surfaces)
    for (const m of text.matchAll(/--class\s+([a-z][a-z-]*)/g))
      if (!Object.hasOwn(VERDICT_CLASSES, m[1])) bad.push(`${where}: --class ${m[1]}`);
  assert.deepEqual(bad, [],
    `these examples are refused by the command they document (valid: ${Object.keys(VERDICT_CLASSES).join("|")}):\n${bad.join("\n")}`);
});
