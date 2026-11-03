// Curation as a byproduct of a quick pass, not a project.
//
// Six months of accumulation is landfill without curation, but curation must
// cost a glance, not a cleanup sprint. `review` surfaces the entries worth a
// second look and says WHY each one is a candidate; acting on one is a single
// explicit command (confirm to re-date it, drop to remove it). Nothing here
// deletes: this module only NAMES candidates. The removal lives in the CLI,
// behind an explicit --drop / prune, so a bulk silent purge is impossible by
// construction.
//
// Four candidate kinds, each an orthogonal signal a reader acts on differently
// — deliberately NOT collapsed into one "stale" score, for the same reason
// freshnessFor keeps its axes apart (a reader treats "the code moved" and
// "nobody has looked in seven months" as different problems):
//
//   age-stale      last confirmed past the staleness horizon. Source-independent:
//                  the API may have moved under a client whose source never did.
//                  (Computed by freshnessFor's age axis — see context.mjs.)
//   source-moved   the mapped source_file no longer exists at that path. The
//                  git-based freshness grade goes quiet when the file is gone
//                  (no commits to compare), so the broken mapping would sit
//                  invisible — exactly the drift review exists to catch.
//   shape-diverged the audit recorded a live response that stopped matching the
//                  baseline shape hash. Re-learning clears it; until then it is
//                  a claim whose SHAPE is known-wrong.
//   superseded     the operation is no longer declared in the contract. Only
//                  flagged for entries that were once REAL (verified, digested,
//                  or shape-baselined): a note-only entry on an undeclared
//                  operation is deliberately-kept knowledge, never landfill.
//
// Everything is computed from the repo and the file — no execution, no network
// — so `review` is safe to run anywhere, any time, exactly like `status`.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { freshnessFor, ageReason } from "./context.mjs";

/**
 * Whether ONE entry is a curation candidate, and why. Returns a candidate
 * descriptor { op, confidence, confidenceReason, reasons: [{kind, why}] } or
 * null when the entry is healthy. `contractOps` is the Set of operation keys
 * the current contract declares, or null when the contract could not be read
 * (in which case superseded is not judged — absence of evidence is not evidence
 * the op was dropped).
 */
export function reviewCandidateFor(entry, op, root, { digest, contractOps } = {}) {
  if (!entry || typeof entry !== "object") return null;
  const fresh = freshnessFor(entry, root, digest);
  const reasons = [];

  // age-stale — the source-independent axis. freshnessFor already computed it;
  // ageReason phrases it so it can never be mistaken for a repo-moved reason.
  if (fresh.age?.stale) reasons.push({ kind: "age-stale", why: ageReason(fresh.age) });

  // source-moved — the mapping points at a file that is gone. A relative path
  // resolved under the repo root; a present file with churn is NOT this (that
  // is ordinary source drift, which freshnessFor already grades suspect).
  if (entry.source_file && !existsSync(join(root, entry.source_file)))
    reasons.push({ kind: "source-moved",
      why: `mapped source ${entry.source_file} no longer exists at that path (moved or deleted)` });

  // shape-diverged — a recorded, still-uncleared divergence.
  if (entry.shape_diverged_at)
    reasons.push({ kind: "shape-diverged",
      why: `response shape diverged from the recorded baseline (observed ${entry.shape_diverged_at})` });

  // superseded — real once, gone from the contract now. The "was real" gate is
  // what keeps intentionally-kept notes on undeclared operations off the list.
  const wasReal = Boolean(entry.verified_at || entry.contract_digest || entry.shape_hash);
  if (contractOps && wasReal && !contractOps.has(op))
    reasons.push({ kind: "superseded", why: "the operation is no longer declared in the contract" });

  if (!reasons.length) return null;
  return { op, confidence: fresh.confidence, confidenceReason: fresh.reasons.join("; "), reasons };
}

/** Every curation candidate in a context, in operation order. */
export function reviewCandidates(ctx, root, opts = {}) {
  const out = [];
  for (const [op, entry] of Object.entries(ctx.operations ?? {})) {
    const c = reviewCandidateFor(entry, op, root, opts);
    if (c) out.push(c);
  }
  return out;
}
