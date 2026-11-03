## Why

An evaluation of `0.1.0-beta.1` (commit `4452853`) found that the safety and
privacy core holds up, but some results can mislead the people and agents who
rely on them. The most serious case: `audit` printed "agrees" for an operation
it never compared, while the server returned a wrong type and omitted a required
field. A product whose purpose is truthful evidence cannot report agreement it
did not measure, and this breaks the repository's "No silent green" rule.

Findings came from small local fixtures run on Linux (WSL), not from real APIs.
They show that each behavior exists, not how often it occurs in practice.

## What Changes

- `audit` and the map report "agrees" only for operations actually compared, and
  otherwise say what was not compared.
- `request` reports a response that disagrees with its declared schema, using
  field names and types only.
- Repeating a request with an unchanged outcome stops rewriting the committed
  knowledge file. Readers report a damaged file by name instead of treating it
  as having no history.
- A stack's copied contract is checked against its source, and `audit --stack`
  uses the contract bound to the stack.
- One evidence label is authoritative, so a single `show` result cannot both say
  an operation was asserted and that no execution was verified.
- CI covers macOS, which the docs list as supported, and runs the full suite on
  a schedule.
- Stale docs and leftover test references are corrected.

**BREAKING (output only):** scripts that parse the human-readable "agrees" state
will see new wording. `audit --json` keeps its existing fields.

### How the evaluation's gaps map to this change

| # | Gap | What it means in practice | Decision |
|---|---|---|---|
| 1 | `audit` false "agrees" | You trust an API check that never ran | This change |
| 2 | `request` ignores response schema | An agent sees `ok: true` on a response that breaks the contract | This change |
| 3 | Reads rewrite a committed file | About 63 new lines per repeated GET, and conflicts between branches | This change |
| 4 | No contract, no observations | The README's walkthrough records no observed structure | Separate change, see design |
| 5 | Contract copy goes stale | Sannr checks against an old contract while `doctor` passes | This change |
| 6 | Discovery is JS/TS and Python only | `map` finds nothing in Go, .NET, Java, Ruby, Rust or PHP | Separate change, per language |
| 7 | CI misses claimed platforms | macOS support is never exercised | This change |
| 8 | Native Windows does not work | `connect` fails and `npm test` does not finish | Separate change; documented as unsupported |
| 9 | Contributors cannot run all tests | 20 tests skip, 10 of them on private import corpora | Partly: stale references here, corpus separately |
| 10 | Docs have drifted | The docs describe behavior the code no longer has | This change |
| 11 | Contradictory evidence labels | Readers cannot tell what was actually established | This change |
| 12 | Very large source files | `bin/cli-main.mjs` is 5,835 lines | Not here: refactoring would obscure these fixes |

## Capabilities

### New Capabilities

- `audit-coverage-reporting`: what `audit` and the map may claim about comparison coverage.
- `response-contract-check`: reporting response-versus-schema disagreement on `request`.
- `knowledge-file-stability`: when requests may change the committed knowledge file, and how readers treat a damaged one.
- `stack-contract-binding`: detecting a stale contract copy and using the bound contract in `audit`.
- `evidence-labels`: one authoritative evidence label per operation.
- `release-qualification`: the platforms and suites CI must exercise.

### Modified Capabilities

None. The repository has no existing OpenSpec specs, so every requirement is
new to OpenSpec, including those describing existing commands.

## Impact

- **Code:** `bin/cli-main.mjs`, `lib/map.mjs`, `lib/audit.mjs`, `lib/client.mjs`,
  `lib/operation-context.mjs`, `lib/context.mjs`, `lib/stacks.mjs`.
- **Stored data:** `stack.json` gains a contract source record, so its closed key
  list in `lib/stacks.mjs` must change. Existing stacks must keep loading.
- **Result envelope:** `contract_delta` gains a new kind. Its size counts toward
  the existing response budget.
- **Docs:** `docs/limitations.md`, `docs/protocols.md`, `docs/api-call-policy.md`,
  `docs/agent-guide.md`, `docs/layout.md`, `docs/troubleshooting.md`, `CLAUDE.md`.
- **CI:** `.github/workflows/ci.yml` and a new scheduled trigger; macOS runners add cost.
- **Repository rules:** committing `openspec/` requires an inventory decision,
  because `test/public-source.test.mjs` fails on any tracked path that
  `packaging/public-source-files.json` does not classify.
