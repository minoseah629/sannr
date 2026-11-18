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
`stack import` copies a stack from another repository (see below); older
grant-based context reads retain their existing boundary. Private evidence can contain response
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

## Import a stack from another repository

`stack import` installs a stack that another repository already keeps: its
contract, its operation notes and its stack facts.

```sh
sannr stack import ../api-stacks --stack billing
sannr stack import https://git.example.test/acme/api-stacks.git --stack billing --ref v2
sannr stack import ../api-stacks --all --dry-run
sannr stack import ../api-stacks --stack billing --as billing-library
```

The source is a local path or a Git URL. A path names a repository, its
`.sannr/stacks` directory or one stack folder, and is read as it is on disk. A
Git URL uses `https`, `ssh` (including the `user@host:path` spelling) or
`file`; `--ref` names a branch, a tag or, where the server allows it, a commit,
and defaults to the remote `HEAD`. Sannr runs your own `git` to fetch one
commit into a temporary bare repository, prints that command on stderr before
it runs, and removes the directory afterwards, including when the command is
interrupted or terminated. Nothing is checked out: the stack folders are read
from git's object store, so no hook, smudge filter or LFS download runs on the
source's files. The git child process does not inherit `GIT_DIR`,
`GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` or any other `GIT_*`
variable except the SSH, askpass, proxy and TLS settings, so an import run
from a hook or `rebase --exec` cannot touch your own repository. Sannr
downloads nothing itself. One stack folder, on disk or at the root of a Git
repository, is named by its `stack.json`.

A source with one stack imports it. With several, the command lists them,
writes nothing and exits non-zero until you pass `--stack <name>` (repeatable)
or `--all`. `--as <name>` installs one imported stack under another name.
`--dry-run` prints the receipt and writes nothing. `--json` prints the receipt
as JSON: the source and its commit, and for each stack the files written, the
note counts (`added`, `updated`, `retired`, `unchanged`) and what was not
imported. Import, dry run and update send no API request.

Every receipt, dry run included, lists each environment of the stack with the
host its requests go to, the host of its `tokenUrl` if it has one, the names
of the variables its credentials are read from and its `production` flag
(`environments[].base_url_host`, `token_url_host`, `auth_variables`,
`production`). Read it before using the stack: a source chooses those hosts,
and a familiar variable name does not make the host yours.

The source is untrusted data. Its `stack.json` passes the same checks as a
local stack: an unknown key refuses by name (`STACK_KEY_UNKNOWN`), and so do a
secret-shaped literal and a credential header. A contract must sit inside its
own stack folder (`STACK_CONTRACT_OUTSIDE_PROJECT`). Every contract the stack
names, for any environment, must end in `.json`, `.yaml` or `.yml` and be a
contract `stack add --contract` accepts: the same reader, and at least one
operation. A dotfile, a dot-directory, and a name reserved for agent
instructions or tool configuration (`AGENTS`, `CLAUDE`, `mcp`, `package` and
similar) refuse by name with `STACK_CONTRACT_INVALID`; the message tells the
source's author what to rename. No other file in the source folder is copied.
A symbolic link anywhere in the stack folder refuses (`STACK_UNSAFE_PATH`).
Every note passes the note secret check, and so do its author name, source
reference and applicability; a secret-shaped value refuses with
`SECRET_IN_NOTE` and exit 2 without printing it. A secret-shaped contract
title or path refuses with `STACK_SECRET_LITERAL`. A malformed or changed
note history refuses with exit 3. Any refusal leaves the repository unchanged. Nothing in a source
file is executed or followed as an instruction.

What arrives: `stack.json` with its environments, base URLs and credential
references by variable name; the contract files it names; an operation
inventory taken from that contract; the active authored notes and stack facts.
What stays behind: `envFile` paths, shared account facts, evidence files and
private storage, superseded note history, unattributed and machine-generated
notes, learned response shapes and verification state, and review decisions.
The receipt names what it left out under `not_imported` and `skipped`. An
evidence reference is not carried at all: its run ID, the author's provider
URL, environment name and build stay in the source, and a basis source that is
a run ID is dropped. The imported note keeps only how many runs the author
attached (`imported.evidence_count`), and `show` and `context query` read it
as `unavailable` here. An imported stack is
`written` until this repository observes or verifies it itself.

Every imported note keeps its author, date, basis and source, and gains an
`imported` record: the source, the source commit when there is one, the import
date and the note's identity in the source. `show`, `context query`, request
`known` blocks and the managed instructions print it, so an imported note is
never mistaken for one written or observed here. `sannr stacks` marks the
stack `imported from <source>`. The source is recorded as the Git URL without a
login name, or as a path relative to this repository; a path more than two
directories above the repository is recorded by its directory name alone,
which is a label and not an identity (`imported_from.exact` is `false`). For
a local path the commit is the source repository's `HEAD`, read from its files;
uncommitted changes in the source are imported and are not reflected in it.

A name that already exists here and did not come from the same source refuses
with `STACK_EXISTS` and names `--as`. So does any second import from a local
source recorded by directory name only, because that name cannot show it is
the same source. An import that later imports can update needs a Git URL or a
path within two directories of this repository.
Importing again from the same source is an update: new upstream notes are added, a note the author superseded replaces
its imported predecessor, and a note the author retired is retired here; the
old text stays in `show --history`. Notes written, observed or reviewed in this
repository are never overwritten or dropped. A locally trusted imported note
is not overturned without a run: the upstream change arrives beside it (a
retirement then names the local note's identity) and every import lists the
trusted note under `held` until it is resolved here. An imported note that is no longer active in
the source and has no replacement there is left alone and listed under
`no_longer_upstream`. An update changes neither the local `stack.json` nor the
local contract; a contract that changed in the source is named in the receipt.

After an import, existing managed blocks in `AGENTS.md` and `CLAUDE.md` are
refreshed as they are after `note`; the receipt reports that result separately.
The first knowledge write in a repository also creates `.sannr/README.md`,
`.sannr/.gitignore` and `.sannr/layout.json`; the receipt lists them under
`layout_files`. A new stack is installed whole or not at all. Its folder is
created by the import and must not exist beforehand, even empty; if a write
fails part-way, only the files and folders the import made are removed. When
one of several stacks cannot be written the run stops: the receipt lists the
stacks already in place, which stay, and a named error on stderr gives the
stack that failed (`failed`, `not_attempted` in JSON); the exit is non-zero. The MCP tool surface has
no import action.

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
