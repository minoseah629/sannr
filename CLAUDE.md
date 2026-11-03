# Sannr

**Sannr** (Old Norse: "true", SAH-ner) is an API client for coding agents that
records what it learns about an API beside the code, with the evidence behind
each claim, so a later session can tell an executed observation from an
unsupported assertion.

Three things: a **map** (every API under a tree, who calls whom, where contract
and server disagree), a **knowledge file** (`.sannr/stacks/<name>/sannr.json`,
committed, survives the session boundary), and a **client** (executes requests,
returns bounded, truthful result envelopes).

This file is the agent-facing conventions file for the public repository. It is
copied to both `CLAUDE.md` and `AGENTS.md` when the release tree is assembled,
so every host reads the same rules. The human-facing docs start at
[README.md](README.md) and [docs/README.md](docs/README.md); contributor
process is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Non-negotiables

- **Auditable runtime.** Node ≥22, ESM. The installed package loads nothing beyond Node.
  Protocol adapters are opt-in, exact-pinned, and hash-verified before use;
  they live in `optionalDependencies` and are not bundled. Core commands work
  without them. npm attempts optional packages by default; use `--omit=optional`
  for a core-only install. The agent-facing code must remain auditable.
- **The promotion boundary.** Field names and types promote into committed
  files; a *value* only when the contract declares it as an enum. No bodies,
  headers, credentials, or query values in anything committed or logged.
  Credentials are env-var *references*, never values, everywhere, always.
- **No silent green.** Suites require assertions; unverifiable steps are
  quarantined, not imported; unsupported semantics fail with a named reason.
- **The brand seam.** `lib/brand.mjs` is the only place the product name
  exists in code. `PROSE_SURFACES` lists every markdown file that names it;
  `PRIVATE_SURFACES` names the ones that live only in the maintainers' full
  repository. Tests enforce both directions. Never hardcode the name anywhere else.
- **Measure before claiming.** Name the exact source, command, evidence and
  limitations behind any result. Fixture checks do not establish real-world
  accuracy, savings, or superiority. Research is maintained separately and is
  not included in this product repository.
- **No account, no telemetry.** The only thing Sannr sends us is feedback, which
  is optional and asks first: a report goes out only through an explicit
  `feedback --send`, which stops for a human yes by default
  (`feedback.send: ask | allow | never`). Install, requests, schedules and
  session end send us nothing; requests go only to the API being called, and
  `doctor` announces its one probe before sending it. Collection stays
  local: a test asserts `lib/feedback.mjs` has no network capability, and only
  the API client's pinned feedback path may transmit the report, after writing
  its receipt. Keep both true. See [docs/feedback.md](docs/feedback.md).

## Map of the repo

- `bin/cli.mjs` — Node-version guard; `bin/cli-main.mjs` implements commands and help
- `server.mjs` — Node-version guard; `lib/stdio-server.mjs` implements MCP stdio (tool `api_request`)
- `lib/` — the engine; pure functions, I/O at the edges, comment-dense
- `skill/` — installed into user repos by `connect` (dir names from front matter)
- `test/` — `npm test` runs core safety; `npm run test:full` discovers all
  product regressions. Run affected files directly for feature work.
- `docs/` — the documentation that ships inside the package; `docs/imports.md`
  covers the import format and suite semantics (`sannr import`)
- `CHANGELOG.md` — what shipped in each published version; GitHub Releases carry
  the release artifacts and their checksums

## Working in this repository

- Run `npm ci --ignore-scripts --no-audit --no-fund` before testing or packing.
  This installs the locked optional adapters for their fixture tests; it does
  not make them a startup dependency.
- Verification is proportional to the change. For small code changes, run
  affected files with `node --test test/<area>.test.mjs`, then `npm test`
  before a behavioral handoff. Prose, comments and metadata usually need diff
  review and only a relevant check.
- `npm test` is a local-fixture safety set, not full qualification. It protects
  honest verification, environment routing, credentials and privacy, feedback
  consent, state integrity and packed CLI/MCP startup. Keep it small; new feature
  tests do not automatically belong in it. Prefer one failing regression for a
  bug, reusing existing tests; remove duplicates and copy-only assertions. Never
  delete a unique safety check just to hide a failure.
- Use `npm run test:full` for cross-cutting changes and release qualification,
  `test:truth` for request/envelope/assertion changes, and local stress for
  transport/budget changes. Routine PR CI runs safety only; releases also run
  full, truth and local stress plus exact-package checks. See
  [CONTRIBUTING.md](CONTRIBUTING.md#verification). Live API stress and
  publication need explicit maintainer authorization.
- Report only checks actually run. Fix relevant failures before handoff and
  disclose unrelated failures and named skips. A fast pass is not a full-suite
  pass; a skipped check is not verified coverage.
- Never write knowledge records into this repository's root while testing:
  every test uses a temporary project. A stray root `sannr.json` or a knowledge
  file under this checkout's `.sannr/` is a defect.
- A commit message, a test name, and a report's before/after table are all
  claims; the reviewer's specimen is the test.
- Product regression tests and their controlled fixtures live in this tree.
  Research harnesses, their exclusive tests and the research-only npm scripts
  are omitted; research is maintained separately and is not a product/release
  gate. Any remaining platform, service or optional-corpus skip is named in the
  test summary.
- Docs state behavior that the code has. When you change what a command does,
  change the page that describes it in the same change, and say in the PR what
  you verified by running it.
