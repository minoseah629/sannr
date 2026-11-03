// `verify` — committed suites as conformance probes (T2).
//
// A saved suite (lib/suites.mjs) is a set of claims about an API, and claims
// rot: the server changes, the suite stays committed, and the next agent reads
// stale green. `verify` runs every suite against the live API and reports what
// NO LONGER holds — each failing assertion as a drift entry carrying the
// expected value (what the suite still claims) next to the actual (what the
// API now does). On a schedule or in CI, rot goes red on a Tuesday instead of
// misleading someone in three months.
//
// verify is deliberately NOT a fourth executor. It loads suites with loadSuite,
// runs them through the same runEnvelope the client and `suite run` use, and
// reduces with the same suiteReport — what this module adds is only the two
// things a conformance posture needs and a plain run does not have:
//
//   1. A read-only PLAN (--read-only): the safe default for scheduled probes.
//      Only GET/HEAD steps run; a suite's write steps are skipped BY PLAN,
//      before any request leaves, and reported as skips so a narrowed check
//      never masquerades as a full one. The skip cascades: a read that
//      interpolates a value captured by a skipped write would go red with
//      UNRESOLVED_PLACEHOLDER — a false drift verify itself manufactured — so
//      it is skipped too, with the lost capture named.
//   2. A DRIFT reduction: one flat list of every claim that no longer holds,
//      across all suites, because "what rotted" is the entire deliverable of a
//      conformance run and nobody should dig it out of per-step rows.
//
// Verify disables shared request-context capture, including a suite entry's
// explicit capture flag. Private execution evidence remains available. The
// production guard in lib/config.mjs refuses suite writes against production.
// Context and suite bytes stay unchanged (test/verify.test.mjs).
import { containsBodyFileReference } from './request-input-schema.mjs';

// GET and HEAD are the two methods HTTP defines as safe; everything else in a
// suite is treated as a write, including anything exotic, because the cost of
// wrongly running a write dwarfs the cost of wrongly skipping a read.
const READ_METHODS = new Set(["GET", "HEAD"]);

// Placeholder names a step consumes, from everywhere runOne interpolates:
// path, params, body. Used to cascade skips, so the scan must see every string
// the client would substitute into — a partial scan is a false drift factory.
function placeholderNames(req) {
  const names = new Set();
  const scan = (node) => {
    if (typeof node === "string")
      for (const m of node.matchAll(/(?<!\{)\{([^{}]+)\}(?!\})/g)) names.add(m[1]);
    else if (Array.isArray(node)) node.forEach(scan);
    else if (node && typeof node === "object") Object.values(node).forEach(scan);
  };
  scan(req.path); scan(req.params); scan(req.body); scan(req.headers); scan(req.expect);
  return names;
}

// Split a suite into the steps a read-only probe may run and the steps it must
// skip, in order, with a human reason per skip. Environment variables can also
// fill placeholders at run time, but a name captured by a skipped write is
// treated as lost even if an env var shadows it: the suite meant "the id the
// write just created", and verifying against some ambient value would be a
// green (or red) about the wrong resource.
export function readOnlyPlan(suite) {
  const retained = [], skipped = [], cleanup = [];
  const lost = new Set();   // captures owned by skipped steps, not re-captured since
  [...suite.requests.map(req => ({ req })), ...(suite.finally ?? []).map(req => ({ req, phase: 'finally' }))].forEach(({ req, phase }, i) => {
    const method = (req.method ?? "GET").toUpperCase();
    const id = req.id ?? String(i + 1);
    const op = `${method} ${req.path}`;
    const skip = (reason) => {
      skipped.push({ id, op, reason, ...(phase ? { phase } : {}) });
      for (const name of Object.keys(req.capture ?? {})) lost.add(name);
    };
    if (phase && !retained.length) return skip('no primary read remains; cleanup was not run');
    if ((req.protocol && req.protocol !== "http") || ["graphql", "rpc", "grpc", "websocket"].some(key => Object.hasOwn(req, key)))
      return skip("protocol adapter execution is outside the HTTP GET/HEAD read-only plan");
    if (!READ_METHODS.has(method)) return skip(`${method} is a write; --read-only runs GET/HEAD only`);
    if (Object.hasOwn(req, 'files') || containsBodyFileReference(req.body))
      return skip('local file inputs are unavailable in the read-only plan');
    const orphan = [...placeholderNames(req)].find((n) => lost.has(n));
    if (orphan !== undefined)
      return skip(`needs {${orphan}}, captured by a skipped write step`);
    (phase ? cleanup : retained).push(req);
    // A retained read that captures a name makes it live again for later steps.
    for (const name of Object.keys(req.capture ?? {})) lost.delete(name);
  });
  return { retained, skipped, ...(suite.finally !== undefined ? { finally: cleanup } : {}) };
}

// Flatten per-suite reports (suiteReport shape) into the conformance verdict:
// every assertion that no longer holds, plus every error that made a claim
// unverifiable. Both belong in the list — "the status is now 'active'" and
// "the host is down" both mean the committed knowledge is not confirmed — but
// they carry different fields so a consumer can tell rot from outage.
export function driftFrom(reports) {
  const drift = [];
  for (const r of reports) {
    // A suite-level error (dead host, unsupported version) verified nothing.
    if (r.error) drift.push({ suite: r.name, step: null, op: null, error: r.error });
    for (const s of r.steps ?? []) {
      if (s.ok !== false) continue;   // null = not run under stop; not itself drift
      for (const f of s.failures ?? [])
        drift.push({ suite: r.name, step: s.id, op: s.op, target: f.target,
                     // `check` is the operator that failed; a clause carrying several
                     // carries all of them, so the record cannot read as one check.
                     path: f.path, check: f.op, ...(f.ops ? { checks: f.ops } : {}),
                     // A refused evaluation is not a failed comparison. The
                     // refusal may belong to a later operator than `check`.
                     ...(f.refused_ops ? { refused_ops: f.refused_ops } : {}),
                     ...(f.code ? { code: f.code } : {}),
                     expected: f.expected, actual: f.actual });
      if (s.error) drift.push({ suite: r.name, step: s.id, op: s.op, error: s.error });
    }
  }
  return drift;
}
