// Detecting the moment something was learned.
//
// The valuable half of API knowledge is the half no spec contains: that this
// transition needs the piece to be in `outlined` first, that this endpoint wants
// the key in a header rather than a bearer token, that this create is rejected
// until the parent exists. Today that knowledge is acquired by an agent at
// 14:32, used at 14:33, and destroyed when the session ends.
//
// Nobody is going to write it down on purpose. Every documentation effort in
// history has died on that. So the trigger has to be automatic and the cost has
// to be near zero.
//
// The signal is in the usage log already: N failures on one templated operation
// followed by a success means something changed between the attempts, and the
// only thing that changed was the agent's understanding.
//
//   POST /pieces/{id}/transition -> 409 409 422 200
//
// This module DETECTS. It never writes. The client cannot know what was learned,
// only that learning occurred; the agent holds the reasoning and writes the note.
// Putting an LLM in here to guess at the lesson would break exactly the
// deterministic-tool / reasoning-agent split the rest of the design depends on.

import { readFileSync, statSync } from "node:fs";
import { CLI_NAME } from "./brand.mjs";
import { safeOutputPath } from "./output-path.mjs";

// A failure run must be recent to mean anything. Two 401s last Tuesday and a
// success today are not a learning moment, they are two unrelated events.
const WINDOW_MS = Number(process.env.API_FRICTION_WINDOW_MS ?? 45 * 60 * 1000);

// One failure then a success is ordinary: a 404 before a create, a probe before
// a write. Two or more means the agent was genuinely wrong about something.
const MIN_FAILURES = Number(process.env.API_FRICTION_MIN ?? 2);

// Read only the tail. This log is append-only and global across every repo, so
// it grows without bound and must never be loaded whole.
const TAIL_BYTES = 256 * 1024;

/**
 * What a run of failures on one operation most likely taught. Deliberately
 * coarse: the agent writes the actual lesson, this only frames the question.
 */
const KINDS = [
  { test: (s) => s === 401 || s === 403, kind: "auth",
    asks: "what the endpoint actually wanted (scheme, scope, header name)" },
  { test: (s) => s === 409, kind: "state",
    asks: "what state the resource had to be in first" },
  { test: (s) => s === 422 || s === 400, kind: "payload",
    asks: "which field or value the endpoint actually required" },
  { test: (s) => s === 404, kind: "shape",
    asks: "where the resource really lives, if the documented path was wrong" },
  { test: (s) => s === 429, kind: "rate",
    asks: "the real rate ceiling and how long a backoff has to be" },
];

// 5xx is deliberately absent. A server erroring and then working taught you
// nothing except that it was briefly broken, and prompting for a note on every
// transient upstream blip is how a useful signal becomes noise people disable.
const isLearnable = (status) => KINDS.some((k) => k.test(status));

function readTail(file) {
  let size = 0;
  try { safeOutputPath(file); size = statSync(file).size; } catch { return []; }
  const start = Math.max(0, size - TAIL_BYTES);
  let raw;
  try { raw = readFileSync(file, "utf8"); } catch { return []; }
  if (start > 0) raw = raw.slice(raw.indexOf("\n", raw.length - TAIL_BYTES) + 1);
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn final line is expected */ }
  }
  return rows;
}

/**
 * Did the current successful request conclude a run of failures?
 *
 * @param {{host:string, method:string, path:string, status:number}} current
 * @param {{log?:string, logs?:string[], rows?:object[], now?:number, alreadyNoted?:boolean}} opts
 * @returns {null | {op:string, kind:string, pattern:string, attempts:number, asks:string}}
 */
export function detectFriction(current, { log, logs, rows, now = Date.now(), alreadyNoted = false } = {}) {
  // An operation that already carries a note is not a question any more. Without
  // this the trigger fires on every subsequent success forever, which is how a
  // helpful prompt becomes something people turn off.
  if (alreadyNoted) return null;
  if (!(current.status >= 200 && current.status < 300)) return null;

  // Mixed-version clients can append to both locations at once. Directory
  // precedence is not event order; a success in either log closes the run.
  const all = rows ?? (logs
    ? [...new Set(logs)].flatMap(readTail).sort((a, b) => (Date.parse(a.ts) || 0) - (Date.parse(b.ts) || 0))
    : readTail(log));
  if (!all.length) return null;

  // Walk backwards over this operation only, stopping at the first thing that is
  // not a failure. An earlier success means that run was already concluded.
  const failures = [];
  for (let i = all.length - 1; i >= 0; i -= 1) {
    const r = all[i];
    if (r.host !== current.host || r.method !== current.method || r.path !== current.path) continue;
    const age = now - Date.parse(r.ts ?? 0);
    if (!Number.isFinite(age) || age > WINDOW_MS) break;
    if (r.status >= 200 && r.status < 300) break;
    failures.push(r);
  }
  if (failures.length < MIN_FAILURES) return null;

  // Order oldest-first so the pattern reads the way it happened.
  failures.reverse();
  const statuses = failures.map((f) => f.status);
  if (!statuses.some(isLearnable)) return null;

  // The last learnable failure is the one that was actually solved; earlier ones
  // are usually a different obstacle already cleared.
  const decisive = [...statuses].reverse().find(isLearnable);
  const { kind, asks } = KINDS.find((k) => k.test(decisive));

  return {
    op: `${current.method} ${current.path}`,
    kind,
    attempts: failures.length + 1,
    pattern: [...statuses, current.status].join(" "),
    asks,
  };
}

/**
 * The prompt the agent sees, attached to the response that concluded the run.
 *
 * Phrasing matters more than it looks, and the 2026-08-15 friction test proved
 * how much: the passive shape ("that knowledge dies unless written down") got
 * the note written by a strong model and ignored by a weaker one given the
 * IDENTICAL prompt. A suggestion is optional to a model looking for the least
 * work; an instruction with the command already in hand is not. So the prompt
 * now leads with the exact command as the next action, states the one-line WHY
 * after, and surfaces the ready-to-run command in its own field. The command is
 * kept verbatim in `write_it` (copy-paste runnable, and the one thing the budget
 * shrink keeps) rather than wrapped in prose the agent has to unpack.
 */
export function frictionPrompt(f) {
  const write_it = `${CLI_NAME} note "${f.op}" "<one sentence: what you had to do differently>"`;
  return {
    op: f.op,
    pattern: f.pattern,
    kind: f.kind,
    // Imperative and command-first: the action is the first thing read, the WHY
    // is one clause behind it. No "consider", no "you may wish"; those are the
    // words a weaker model treats as skippable.
    note: `Do this now, before your next call: ${write_it} ` +
      `Two-plus failures then a success means you know something the contract ` +
      `does not say (${f.asks}); it is gone when this session ends.`,
    write_it,
  };
}
