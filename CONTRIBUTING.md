# Contributing

Thanks for looking. A few things about how this repository works will
save you time.

## The rules the tests enforce

- **Auditable runtime.** Node ≥ 22, ESM. The core loads only Node's built-in
  libraries. Protocol adapters use optional, exact-pinned libraries whose
  installed files are hash-verified before use. Dependency changes require
  inventory review and the package verification checks.
- **The promotion boundary.** Field names and types may be promoted into
  committed files; a *value* only when the contract declares it as an
  enum. No bodies, headers, credentials, or query values in anything
  committed or logged. Credentials are env-var references, always.
- **No silent green.** Suites require assertions; unverifiable imports
  are quarantined, not approximated; unsupported semantics fail with a
  named reason.
- **The brand seam.** The product name exists in code in exactly one
  file. Prose that names it is inventoried. Tests enforce both
  directions.
- **Measure before claiming.** Reported results identify the tested
  source, evidence and limits. Product checks do not establish general agent
  accuracy or token savings.

## Verification

Choose checks for the change. There is no full-suite gate before every commit
or push, and no minimum test-count target. This policy supersedes older sprint
instructions that say otherwise.

Install dependencies once per checkout (and after lockfile changes):

```bash
npm ci --ignore-scripts --no-audit --no-fund
```

For a small code change, run its affected tests, then the fast safety check
before handoff. For example, an environment-selection fix:

```bash
node --test test/env-selection.test.mjs
npm test
```

`npm test` is a deliberately bounded set in `scripts/test-unit.mjs`: honest
assertions and evidence, environment selection, credential/privacy boundaries,
consent for feedback sends, atomic/concurrent writes, and packed CLI/MCP startup.
It uses local fixtures; no live APIs, paid runs, daemon or sibling corpus. Aim
to keep it under a minute on a development machine, not to hit a test count.
New feature tests do not automatically join this set.
The suite commands (`npm test`, `npm run test:full`) take no extra flags or
files; use `node --test` directly for name filters or other focused selections
so they cannot masquerade as a complete safety or product run.

Documentation, comments and metadata changes usually need diff review and only
the applicable link/parser/package check. Do not rerun unrelated suites just
because a doc or status snapshot changed after a passing check. A bug fix should
have a focused failing reproduction when practical; reuse existing cases rather
than creating overlapping tests or pinning exact prose and internal structure.

Use broader checks when warranted:

- `npm run test:full` discovers all product regression files; use it for
  cross-cutting refactors and release qualification.
- Research harnesses and their fixtures are not part of this repository and
  are not a product or release gate, so there is no research suite to run
  here. The reviewed exclusions in `packaging/public-source-files.json` define
  that boundary; new unclassified test files remain included in product
  qualification.
- `npm run test:truth` checks claims against a controlled server; use it when
  changing request, assertion or envelope behavior.
- `SANNR_STRESS_LOCAL=1 npm run test:stress` exercises local transport/budget
  edges; use it for changes to those boundaries.
- Import/corpus, protocol, rendering and harness tests can be run directly with
  `node --test test/<area>.test.mjs` when working on that area. Name missing
  prerequisites instead of calling skips passes.

Routine PR CI runs the safety set on Node 22 and 24. The CI workflow's manual
`full` input opts into all product regressions, truth and local stress. Release and npm
publication workflows always require those broader checks:

```bash
npm run test:full
npm run test:truth
SANNR_STRESS_LOCAL=1 npm run test:stress
```

Release preparation additionally verifies the exact package installation (see
[packaging/README.md](packaging/README.md)). The external stress matrix
(`npm run test:stress` without local mode) needs explicit authorization and is
not a routine development gate. None of these instructions authorizes a live or
paid fleet run, publication, or a real feedback send.

Keep unique safety regressions; remove duplicates and low-value copy assertions.
Report the actual checks, failures and skips in the handoff. Never describe a
safety-only run as the full suite or shrink coverage merely to hide a red test.

## Developer Certificate of Origin

Contributions are accepted under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
Sign off each commit to certify that you wrote the change or have the
right to submit it under the project's Apache-2.0 license:

```bash
git commit -s
```

There is no contributor license agreement.

## What makes a good pull request here

One coherent change, with focused verification. For a behavioral fix, prefer
the regression that would have caught it over several overlapping cases. If the
change touches anything that writes a file, executes a request, or
parses an import, include the adversarial case — the malformed input,
the symlink, the oversized document — not just the happy path. Say in
the description what you measured, and what you did not.

## Reporting security issues

Not in the issue tracker — see `SECURITY.md`.
