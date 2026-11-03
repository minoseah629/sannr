## Context

The client records what it learns about an API so a later session can separate
an executed observation from an unsupported claim. These fixes must keep the
repository's non-negotiable rules: field names and types may be committed, but
values may not; unverifiable results must not look green; and the core loads
nothing beyond Node.

Observed behavior behind each decision:

- `bin/cli-main.mjs:2238` and `lib/map.mjs:696` choose "agrees" from findings and
  reachability alone. `lib/map.mjs:301` already words the zero-coverage case
  correctly, so the correct concept exists but these two places ignore it.
- `lib/audit.mjs:1256` excludes templated paths from the direct probe, so a
  contract with only `/items/{id}` routes and no list route to sample IDs from
  reaches zero compared operations.
- `lib/client.mjs:2265-2406` fills `contract_delta` with redirect, undeclared-path
  and pagination kinds only. The schema comparison exists in `audit`.
- `lib/operation-context.mjs:479` appends every captured observation, capped at 20
  per operation, which measured about 25 KB per operation at the cap.
- `lib/context.mjs:1009` emits "no execution verification recorded" even when the
  same result carries `evidence_class.class: asserted`.

## Goals / Non-Goals

**Goals:**

- Never claim agreement that was not measured.
- Surface contract disagreement at the moment an agent makes a request.
- Keep the committed knowledge file stable unless something was actually learned.
- Keep every change inside the existing promotion boundary.

**Non-Goals:**

- Observations for stacks without a contract (gap 4). Concrete paths can contain
  identifiers, so this needs its own route-identity design.
- New language scanners (gap 6), which are separate per-language work.
- Native Windows support (gap 8), which `ci.yml` already says needs bounded
  shards and a completed measurement first.
- Splitting `bin/cli-main.mjs` or `lib/client.mjs` (gap 12).

## Decisions

**Compute one audit state in one place.** A shared function returns the state, and
the CLI and HTML both render it. Alternative considered: patch both call sites,
which is smaller but is how they came to differ from `lib/map.mjs:301`.

**A schema mismatch does not change `ok`.** `ok` keeps its current meaning: the
caller's assertions passed, or the response succeeded when there were none. The
mismatch appears in `contract_delta`. Alternative considered: fail on mismatch,
which would break callers on contracts that are merely out of date, and turn a
contract problem into a request failure.

**Reuse the audit comparison.** One comparison gives one definition of
disagreement. Schema constructs it cannot evaluate are reported as not checked,
never as passing.

**Skip the committed write when the outcome is unchanged.** "Unchanged" means the
same status, response shape, outcome and contract digest as the newest retained
observation. Private evidence is still written for every request, so nothing is
lost locally. Trade-off: the committed file no longer shows when an operation was
most recently re-confirmed. Alternatives considered: move all observations out of
the committed file, which removes the shared knowledge the product exists for; or
add a merge driver, which treats the symptom and needs per-clone git setup.

**Record the contract's source path and digest in `stack.json`.** `doctor` warns on
a difference and names both paths. It does not refresh automatically, because
silently changing the contract an agent checks against would hide the change.

**`evidence_class` is authoritative.** The older `why` and `legacy_confidence`
fields stay for compatibility but must not contradict it.

## Risks / Trade-offs

- Schema comparison could slow requests or exceed the response budget → bound the
  items reported and count them toward the existing budget.
- Comparing composed schemas could produce false mismatches → report unsupported
  constructs as not checked, and test against real composed-schema fixtures.
- Skipping unchanged writes could hide a regression → any change in status, shape,
  outcome or contract digest still writes.
- Existing committed files keep their old entries → they age out under the
  existing cap, with no migration.
- macOS runners cost more → run them on a schedule and at release, not on every PR.

## Migration Plan

Ship the changes independently, audit state first since it is smallest and most
valuable. `stack.json` changes are additive: a stack without a source record skips
the staleness check and says so. Each change can be reverted on its own.

## Open Questions

1. **`test:full` baseline.** The first run had 5 failures of 3,295, but my leftover
   processes were competing for CPU. Three passed alone. `test/workbench-design.test.mjs`
   failed 6-10 of 35 on 8 reruns under the same interference. An isolated run is
   needed before calling any of these real.
2. **Conflict markers.** `show` on a conflicted file reported `history-unavailable`,
   but only the first 7 lines of that output were inspected. Confirm no warning
   follows before implementing that requirement as a fix.
3. **`openspec/` in the public tree.** Classify it as public, or exclude it like the
   private planning records already left out of this repository?
4. **Import corpora.** Can a redistributable subset be published? This depends on
   the licenses of the upstream collections.
5. **Product-name search.** A case-insensitive search for the product name hits 18
   source files outside `lib/brand.mjs`. Check whether any breaks the brand seam
   or whether all are permitted, such as the state directory name.
