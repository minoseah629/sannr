# Sannr API stacks

A stack names one API integration. Its environments share one knowledge file;
other stacks have separate credentials, contracts, notes and observations.

`sannr stacks` also lists the packaged, read-only `sannr-feedback` stack. Read it
with `sannr show --stack sannr-feedback`. It does not become the repository's
default, appear in repository API maps, or inherit repository credentials.
Its two public operations, contract and day-one notes ship with the package;
repository files cannot replace them. Request evidence stays in the repository's
private evidence directory. [Feedback sends](feedback.md) have a separate
ask/allow/never policy and never run automatically.

```sh
sannr stack add billing --base-url https://billing.example.test/v2 --auth bearer:BILLING_KEY --contract billing.openapi.json --env production
sannr stacks --json
sannr request GET /users --stack billing --env production --expect-status 200
sannr show 'GET /users' --stack billing
sannr note 'GET /users' 'An authored integration lesson.' --stack billing
```

`stack add` copies a project-local contract into the stack folder. It refuses
existing names and unsafe paths. Fresh `init --contract <path>` or
`start --contract <path>` creates the first stack from the contract title,
with a trailing “API” removed before slugging. `--stack <name>` chooses its
name instead. A contract's first absolute HTTP server supplies the initial
base URL. Without one, setup inventories the contract with no environment;
add the real environment to `stack.json` before making requests.

Without a contract, a fresh `connect --base-url <url> [--stack <name>]
[--auth <scheme:VAR>] [--env <name>]` creates the first stack exactly as
`stack add` would, and a bare `connect` creates it for the one public API the
code calls (named from the host: `api.stripe.com` becomes `stripe`; colliding
names get `-2`, `-3`). Several or no detected APIs create nothing and list
`stack add` commands; loopback and private hosts are never chosen. These run
only while the repository has no stack.

| Path | Contents |
| --- | --- |
| `.sannr/stacks/<name>/stack.json` | API configuration, environments and credential references. |
| `.sannr/stacks/<name>/sannr.json` | Committed knowledge for this API only. |
| `.sannr/evidence/<name>/` | Private request evidence for this stack. |
| `.sannr/defaults.json` | Optional project defaults, including `default_stack`. |

Graph manifests, graph snapshots, suites and the audit baseline retain their
repository-level locations. Stack names match `^[a-z0-9][a-z0-9-]{0,62}$`;
`suites` is reserved. `unsorted` is an ordinary stack name.

```json
{
  "v": 1,
  "name": "billing",
  "title": "Billing API",
  "default_environment": "production",
  "contract": "billing.openapi.json",
  "environments": {
    "production": {
      "baseUrl": "https://billing.example.test/v2",
      "auth": "bearer:BILLING_KEY",
      "envFile": "~/.config/example/billing.env",
      "production": true
    },
    "staging": {
      "baseUrl": "https://staging.billing.example.test/v2",
      "auth": "bearer:BILLING_STAGING_KEY",
      "contract": "billing.staging.openapi.json",
      "contractPathPrefix": "/v2"
    }
  }
}
```

Contract paths resolve from the stack folder and must remain inside the
project, without symlink traversal. An environment contract overrides the
stack contract. Auth fields accept variable references such as `bearer:KEY`,
never credential values. Configured environment files are read at request
selection; one stack's credentials do not become another's. Production write
protection still applies. Unknown configuration keys refuse by name; `cli`
and `mcp` are reserved and ignored with a doctor note.

Explicit `--stack`, a tool's `stack`, or a suite step's `stack` wins selection.
`upstream` is a compatibility alias for one release, named in the response.
Otherwise an absolute URL must match exactly one configured stack by origin
and segment-bounded base path. Two matches return `STACK_AMBIGUOUS`; no match
returns `ORIGIN_NOT_CONFIGURED`. A relative path uses `default_stack`, or the
only stack. With several stacks and no default it returns `STACK_REQUIRED`.
Each refusal occurs before traffic. Set a default with, for example,
`{"default_stack":"billing"}` in `.sannr/defaults.json`.

`--env`, the tool's `environment`, or `API_ENV` selects an environment inside
the resolved stack. An unknown environment returns `ENVIRONMENT_NOT_FOUND`
and names that stack's environments; it never falls back to another API.
Without an override, `default_environment` applies. MCP descriptions list
stacks at startup, and dispatch reads the current files on every call. New
stack registrations do not pin `API_ENV`, `API_CONFIG` or `API_CONTRACT`.

Successful contract-bound calls retain structural observations in the selected
stack and evidence in its private folder. Observation identities include the
stack name. Evidence linking stays inside that folder. A stack without a
contract can make requests and retain private evidence; its response names
`CONTRACT_NOT_BOUND` and no shared operation context is captured. An observed
response remains distinct from passed assertions or execution verification.
`doctor` reports configuration, contracts and credential availability for
each stack/environment; use `--offline` to inspect without requests.

Existing single-store repositories keep read access in this release. Requests still
execute and retain private evidence, while shared capture reports
`STACKS_MIGRATION_REQUIRED` with `sannr migrate --dry-run`. Authored notes and
`learn` require migration too. Follow the [migration guide](layout.md#migrate-an-existing-project):
preview, select explicit environment splits if needed, apply, then reconnect.
Unassigned operations retain their notes in `unsorted` until `stack move`
files them. Do not manually move knowledge to bypass the refusal.

Requests return saved notes from the resolved stack only, including APIs
mounted under a base path. `show --stack <name>` lists that API's
operations and notes; add an operation for its detail. `context query --stack <name>`
retrieves scoped context without borrowing the default stack's notes.

The managed instructions in `AGENTS.md` and an existing `CLAUDE.md` have one
section per stack: default first, then alphabetical. Each section names the
environments and contract state. Authored facts keep the same operation-and-note
format. At most 15 facts per stack and 60 total appear across gotchas and inherited
lessons; omitted counts name the exact `show --stack` command. `unsorted` reports
its operation count and the `stack move` command.

`map` and `view` include a stack index and one viewport per stack. Each uses
that stack's default environment and the same observation rules as scoped
`show`; observations and verified executions remain separate. The viewport
reads its store and contract, withholds unsafe values and counts them, and
renders without scripts under the page's Content-Security-Policy.
Cross-repository stack sharing is separate work; older grant-based context
reads retain their existing boundary. Private evidence can contain response
values; Git ignore rules do not protect copied or uploaded folders.

Stack-wide lessons use `sannr note --stack <name> --scope stack "<lesson>"`.
Use `--operations "METHOD /path"` to restrict a lesson. The first five applicable
facts precede operation notes on requests, with an omission count and an exact
`show --stack` command for the rest. See [note history](note-history.md) for
supersession, evidence, query and mixed-version behavior.

Stack summaries expose `counts.evidence_classes` with one current class per
operation: written, observed, asserted or verified. The selected environment,
contract identity, freshness and evidence checks are shared by `stacks`, `show`,
managed instructions, map/view and the local feedback report. Observed includes
failed responses; it is not a success count. See [note history](note-history.md)
for ranking, contradiction flags and explicit draft-note acceptance.

## Account facts

Account facts are scoped more narrowly than stack facts: they belong to one
stack, environment and configured credential reference. They stay in the
project's ignored private storage by default. Use account scope when a lesson
is about this credential's trial tier, project role or access restrictions:

```sh
sannr note --stack billing --env staging --scope account "Trial account; organization writes are unavailable."
sannr show --stack billing --env staging --scope account --human
```

Requests deliver matching facts in `known.account_facts`, with their dates,
evidence and credential state. They do not cross environments, stacks or
credential references. Ordinary `show`, map/view and managed instruction
blocks do not include private account facts; retrieve them through the explicit
account view. Private files use restrictive permissions and Git ignore rules,
but those rules do not protect copied or uploaded folders.

`--shared` explicitly writes an account fact to the stack's committed knowledge
for a team sharing that credential reference. It never shares a credential
value, fingerprint or machine salt. The receiving machine has to confirm its
own binding; a shared fact is not evidence that two people have the same token.
Local salted fingerprints detect credential rotation. A changed credential
marks existing facts as needing reconfirmation; requests and reads do not
reconfirm them. Repeat the exact account note after checking that the lesson
still applies. See [note history](note-history.md#facts-about-one-account) for
history, evidence and reconfirmation details.
