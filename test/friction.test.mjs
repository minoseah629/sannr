// The friction trigger is the mechanism the whole accumulation thesis rests on.
//
//   node --test test/friction.test.mjs
//
// Two failure modes to guard against, and they pull in opposite directions:
// a trigger that never fires accumulates nothing, and a trigger that fires on
// ordinary traffic gets disabled in a week. Most of these tests are about the
// second one, because that is the failure that kills the product quietly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectFriction, frictionPrompt } from "../lib/friction.mjs";

const T0 = Date.parse("2026-08-14T12:00:00.000Z");
const at = (minsAgo) => new Date(T0 - minsAgo * 60_000).toISOString();

// A usage row, with only the fields the detector reads.
const row = (status, minsAgo, over = {}) => ({
  ts: at(minsAgo), host: "api.example.com", method: "POST",
  path: "/pieces/{id}/transition", status, ...over,
});

const now = T0;
const current = { host: "api.example.com", method: "POST", path: "/pieces/{id}/transition", status: 200 };
const detect = (rows, cur = current, opts = {}) => detectFriction(cur, { rows, now, ...opts });

function logFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'state-friction-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, 'old.jsonl'), fresh = join(root, 'current.jsonl');
  return { root, old, fresh, write: (path, rows) => writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n') };
}

test('R11 friction reads both logs in time order across mixed-version calls', t => {
  const f = logFixture(t);
  f.write(f.old, [row(409, 3)]);
  f.write(f.fresh, [row(422, 2)]);
  assert.equal(detectFriction(current, { logs: [f.fresh, f.old], now })?.pattern, '409 422 200');
  // A later success in either log closes earlier failures in the other.
  f.write(f.old, [row(200, 1)]);
  f.write(f.fresh, [row(409, 4), row(422, 2)]);
  assert.equal(detectFriction(current, { logs: [f.fresh, f.old], now }), null);
});

test('R11 friction never reads a linked usage file or linked parent', t => {
  const f = logFixture(t);
  f.write(f.old, [row(409, 3), row(422, 2)]);
  symlinkSync(f.old, f.fresh);
  assert.equal(detectFriction(current, { log: f.fresh, now }), null);
  const folder = join(f.root, 'folder'); mkdirSync(folder);
  f.write(join(folder, 'usage.jsonl'), [row(409, 3), row(422, 2)]);
  symlinkSync(folder, join(f.root, 'linked'));
  assert.equal(detectFriction(current, { log: join(f.root, 'linked', 'usage.jsonl'), now }), null);
});

// --- it fires when something was actually learned ---------------------------

test("a run of failures ending in success is a learning moment", () => {
  const f = detect([row(409, 5), row(409, 4), row(422, 3)]);
  assert.ok(f, "409 409 422 200 is the canonical case and must fire");
  assert.equal(f.op, "POST /pieces/{id}/transition");
  assert.equal(f.pattern, "409 409 422 200");
  assert.equal(f.attempts, 4);
});

test("the kind comes from the failure that was actually solved", () => {
  // The 409 was cleared earlier; the 422 is what the successful attempt fixed.
  assert.equal(detect([row(409, 5), row(422, 3)]).kind, "payload");
  assert.equal(detect([row(422, 5), row(409, 3)]).kind, "state");
  assert.equal(detect([row(401, 5), row(401, 3)]).kind, "auth");
  assert.equal(detect([row(429, 5), row(429, 3)]).kind, "rate");
  assert.equal(detect([row(404, 5), row(404, 3)]).kind, "shape");
});

// --- it stays quiet the rest of the time ------------------------------------

test("a single failure before a success is ordinary traffic", () => {
  // A 404 before a create, a probe before a write. Firing here would make the
  // prompt appear constantly and it would be turned off.
  assert.equal(detect([row(404, 3)]), null);
});

test("5xx teaches nothing and must not fire", () => {
  assert.equal(detect([row(500, 5), row(502, 4), row(503, 3)]), null,
    "a server that was briefly broken is not a lesson about the API");
});

test("a 5xx run mixed with one real failure still fires on the real one", () => {
  const f = detect([row(500, 6), row(503, 5), row(422, 3)]);
  assert.ok(f);
  assert.equal(f.kind, "payload");
});

test("an intervening success closes the run", () => {
  // The 409s belong to an episode that already concluded. Counting them again
  // would re-prompt for something already learned.
  assert.equal(detect([row(409, 20), row(409, 19), row(200, 18), row(409, 3)]), null);
});

test("stale failures are not part of this run", () => {
  assert.equal(detect([row(409, 500), row(409, 499)]), null,
    "two 401s last week and a success today are unrelated events");
});

test("failures on a different operation are ignored", () => {
  assert.equal(detect([
    row(409, 5, { path: "/pieces/{id}/publish" }),
    row(409, 4, { method: "GET" }),
    row(409, 3, { host: "other.example.com" }),
  ]), null, "friction is per operation, or every noisy endpoint implicates its neighbours");
});

test("an operation that already carries a note does not ask again", () => {
  const rows = [row(409, 5), row(409, 4), row(422, 3)];
  assert.ok(detect(rows), "sanity: it fires without a note");
  assert.equal(detect(rows, current, { alreadyNoted: true }), null,
    "a documented operation is not an open question; re-prompting is how this gets disabled");
});

test("nothing fires on a request that did not succeed", () => {
  assert.equal(detect([row(409, 5), row(409, 4)], { ...current, status: 409 }), null,
    "the run is not over until it succeeds");
});

test("an empty or unreadable log is not an error", () => {
  assert.equal(detect([]), null);
  assert.equal(detectFriction(current, { log: "/nonexistent/usage.jsonl", now }), null);
});

// --- the prompt has to actually provoke a write -----------------------------

test("the prompt is imperative, command-first, and names the specific question", () => {
  // Rewritten 2026-08-15: the passive prompt was model-dependent (sonnet wrote
  // the note, haiku ignored the identical text). The command must be the first
  // action read, the WHY must survive, and hedges must stay out.
  const p = frictionPrompt(detect([row(409, 5), row(409, 4), row(422, 3)]));
  assert.match(p.note, /^Do this now/,
    "the prompt has to open with the action, not the rationale a model can skip");
  assert.match(p.write_it, /^sannr note "POST \/pieces\/\{id\}\/transition"/);
  assert.ok(p.note.includes(p.write_it),
    "the exact runnable command is surfaced in the prompt itself, not just gestured at");
  assert.ok(p.note.indexOf(p.write_it) < p.note.indexOf("the contract does not say"),
    "command-first: the command precedes the WHY, so the action is unmissable");
  assert.match(p.note, /the contract does not say/,
    "the one-line WHY still names what was learned");
  assert.ok(!/consider|might want|you may wish|unless it is written/i.test(p.note),
    "hedged or passive phrasing gets ignored by weaker models; the action must be a direct instruction");
});
