## 1. Establish the baseline

- [ ] 1.1 Run `npm run test:full` on an otherwise idle Linux machine and record failures and named skips
- [ ] 1.2 Rerun `test/workbench-design.test.mjs` under the same conditions and either fix it or record it as not flaky
- [ ] 1.3 Inspect the complete `show` output for a conflicted knowledge file
- [ ] 1.4 Decide how `openspec/` is classified in `packaging/public-source-files.json`

## 2. Audit coverage reporting

- [ ] 2.1 Add a failing test: a contract with only templated routes must not report "agrees"
- [ ] 2.2 Add one shared audit-state function using `operations_probed`
- [ ] 2.3 Use it at `bin/cli-main.mjs:2238` and `lib/map.mjs:696`
- [ ] 2.4 Show partial coverage as compared-of-declared in terminal and HTML output
- [ ] 2.5 Update the `audit` documentation

## 3. Response contract check

- [ ] 3.1 Add failing tests for a missing required field and a wrong type on `request`
- [ ] 3.2 Extract the audit comparison so `lib/client.mjs` can reuse it
- [ ] 3.3 Add the `schema-mismatch` kind to `contract_delta`, bounded and within budget
- [ ] 3.4 Add adversarial tests proving response values never reach the result, evidence labels or committed files
- [ ] 3.5 Run `npm run test:truth`, since this changes envelope behavior
- [ ] 3.6 Document `contract_delta`, which is currently undocumented

## 4. Knowledge file stability

- [ ] 4.1 Add a failing test: a repeated unchanged request leaves the knowledge file byte-identical
- [ ] 4.2 Compare the new observation with the newest retained one before `lib/operation-context.mjs:479`
- [ ] 4.3 Confirm private evidence is still written and the capture receipt reports the skip truthfully
- [ ] 4.4 Add a named error for conflict markers, subject to task 1.3
- [ ] 4.5 Run `test/context-concurrency.test.mjs`

## 5. Stack contract binding

- [ ] 5.1 Add the source path and digest to `stack add`, and to the allowed keys in `lib/stacks.mjs`
- [ ] 5.2 Add the `doctor` warning, and a clear message for stacks with no source record
- [ ] 5.3 Make `audit --stack` use the stack's bound contract
- [ ] 5.4 Update `docs/stacks.md` and `docs/discovery.md`

## 6. Evidence labels

- [ ] 6.1 Add a failing test: `why` must not deny execution when `evidence_class` records it
- [ ] 6.2 Correct the wording at `lib/context.mjs:1009`
- [ ] 6.3 State which field is authoritative in `docs/agent-guide.md`

## 7. Release qualification

- [ ] 7.1 Add macOS on Node 22 and 24 to the safety run
- [ ] 7.2 Add a scheduled `test:full` run with named skips in its summary
- [ ] 7.3 Remove the stale `test:research` references from `scripts/test-unit.mjs`
- [ ] 7.4 Resolve `test/lane.test.mjs`, which needs a local `editorial-api`

## 8. Documentation accuracy

- [ ] 8.1 Correct `docs/limitations.md:24-27`, which describes old `doctor` behavior
- [ ] 8.2 Update the six docs that still name `api-environments.json`, marking any legacy-only use as such
- [ ] 8.3 List all six MCP tools in the conventions source `packaging/CLAUDE.public.md`, which generates `CLAUDE.md` and `AGENTS.md`
- [ ] 8.4 Say what was verified by running it in the PR, as `CLAUDE.md` requires

## 9. Final verification

- [ ] 9.1 Run `npm test`, `npm run test:full`, `npm run test:truth` and `SANNR_STRESS_LOCAL=1 npm run test:stress`
- [ ] 9.2 Re-run the evaluation fixtures and record before and after results
- [ ] 9.3 Add a `CHANGELOG.md` entry
