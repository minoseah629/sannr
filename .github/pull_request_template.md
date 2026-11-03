## What changed and why

<!-- One paragraph. Link the issue or discussion if there is one. -->

## Verification

Report only the checks you ran. Verification is proportional to the change
(see CONTRIBUTING.md#verification): affected test files for a focused change,
`npm test` before a behavioral handoff, `npm run test:full` for cross-cutting
or release-qualifying work. Give the counts each command printed and name every
failure and skip rather than claiming all green. A focused or safety-only run is
not a full-suite pass.

| Command | Pass | Fail | Skipped (named) |
| --- | --- | --- | --- |
| `node --test test/<affected>.test.mjs` | | | |
| `npm test` | | | |

## Bug fix?

- [ ] Not a bug fix.
- [ ] Bug fix: the regression test is named here and failed before the fix: <!-- test file and name -->

## Checklist

- [ ] No bodies, headers, credentials or query values in committed files or test fixtures (the promotion boundary).
- [ ] No machine-absolute paths in tracked files.
- [ ] The product name appears in code only through `lib/brand.mjs`; new prose that names it is listed in `PROSE_SURFACES`.
- [ ] New tracked files are listed in `packaging/public-source-files.json`.
- [ ] `CHANGELOG.md` has an `[Unreleased]` line if a user would notice the change.
