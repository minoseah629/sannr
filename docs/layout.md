# Sannr project layout and migration

Sannr keeps project API knowledge in one committed `.sannr/` directory. Start with its
`README.md`: setup generates this introduction from the brand and layout
constants, using portable paths that a teammate can read after cloning the
project. `sannr start` and `sannr connect` create it directly.

The generated guide is enclosed by `<!-- sannr:begin -->` and
`<!-- sannr:end -->`. Handwritten paragraphs and Markdown links outside that
pair survive setup, requests and notes. An older unmarked guide is upgraded
only when its bytes match a shipped generated version. A customized unmarked
guide, or one with incomplete or duplicate markers, stays unchanged and
`doctor` names it with a `layout-readme` warning. To opt into refresh, keep your
text outside one marker pair; `connect` replaces only the content inside it.

New repositories use [named API stacks](stacks.md): each API has
`.sannr/stacks/<name>/stack.json` and its own `sannr.json`, with private evidence
under `.sannr/evidence/<name>/` and project defaults in `.sannr/defaults.json`.
Setup with a contract creates the first stack; `stack add <name> --base-url <url>`
creates one without a contract. Existing single-store installs
(`.sannr/stacks/sannr.json` with `.sannr/config/api-environments.json`) use the
migration below; the old store remains readable in this release. Requests still
run before migration, but shared capture and authored notes name
`STACKS_MIGRATION_REQUIRED` and the exact `sannr migrate --dry-run` command.

What a fresh `connect` writes under `.sannr/` with no contract is only
`README.md`, `.gitignore`, `layout.json` and `skills/`. The generated
`README.md` already lists the stack paths in the table below, and the `doctor`
config row says no API stack exists yet and names `stack add`. Until the first
stack exists, the `connect` message and a refused `note` still name the
single-store knowledge file (`.sannr/stacks/sannr.json`); you do not need it.
Do not create `.sannr/config/api-environments.json` in a fresh repository:
it marks the repository as a single-store install, and `stack add` then
refuses with `STACKS_MIGRATION_REQUIRED`.

| Path | Contents and ownership |
| --- | --- |
| `.sannr/README.md` | Generated introduction to the directory. |
| `.sannr/stacks/<name>/stack.json` | Per-API environments, contracts and credential-variable references. |
| `.sannr/stacks/<name>/sannr.json` | Per-API knowledge: operations, authored notes, verdicts and retained structural observations. |
| `.sannr/stacks/.sannr-graph.json` | Committed graph manifest with stable repository, provider, node and operation identities. |
| `.sannr/stacks/graph.snapshot.json` | Default portable cross-repository snapshot; review it before publication. |
| `.sannr/defaults.json` | Optional project defaults, including `default_stack`. |
| `.sannr/stacks/suites/` | Named, committed request suites. |
| `.sannr/stacks/api-audit-baseline.json` | Reviewed, committed audit baseline. |
| `.sannr/vendor/sannr-ci.tgz` | Vendored engine for the optional offline CI workflow. |
| `.sannr/feedback.md` | Local feedback report for a human to review and send. |
| `.sannr/evidence/` | Private captured request evidence and local reports. The product writes `.sannr/.gitignore` to ignore it. |
| `.sannr/skills/` | Source copies of the `sannr-request`, `sannr-write` and `sannr-feedback` skills. |

Contract paths in `stack.json` resolve relative to that stack folder and stay
inside the project. The old environments file resolved contracts from the repo
root; migration moves the contract files and updates their bindings.

The promotion boundary separates committed API knowledge from local evidence. Field
names and types may enter committed API knowledge; values may enter only when the
contract already declares them as enums. Do not force-add evidence or put
credentials, bodies, headers or observed query values in committed files.
Private evidence can contain personal response data. Git ignore rules do not
redact those files or protect them when a folder is copied or uploaded outside
Git, including a directory that has not been initialized as a Git repository.

## The files an agent host reads

The full pointer block stays in `AGENTS.md`, where agents load it passively.
An existing `CLAUDE.md` receives the same block; when absent, it is created with
the single line `@AGENTS.md` to load that shared guidance. The block names the
knowledge and guidance paths inside `.sannr/`.
Host-native registrations stay in `.mcp.json` and `.codex/config.toml`, with
additional supported host files where those hosts are present. They bind the
server to this project's `.sannr/` paths. npx and global npm registrations pin an
exact package version through npx rather than an absolute cache path. Setup
uses stable Node/npx aliases and supplies a Node PATH entry where available;
otherwise the host needs them on PATH. npx may restore the package after a cache
prune. Project paths and setup bindings remain installation-specific, so each
teammate runs setup locally. See [install](install.md).
A real repository-local installation keeps its local server and stable Node
launcher, including an install from an offline tarball.

`connect` copies the skill sources from `.sannr/skills/` into `.claude/skills/`
and `.agents/skills/`. The installed directories are `sannr-request`,
`sannr-write` and `sannr-feedback`, derived from the brand seam. `unwire` and
`doctor` still recognize legacy skill names. `unwire` preserves edited skills
and unrelated host registrations.

The optional consumer CI workflow remains in `.github/workflows/` and names
the layout paths. It retains the review-only, no-API-traffic behavior described
in [CI setup](ci.md).

## Migrate an existing project

Always preview from the project root before applying:

```sh
sannr migrate --dry-run --json
sannr migrate
sannr connect
```

The preview writes nothing and sends no requests. The same `--name` and
`--split` options belong on both the preview and apply commands. Environment
splits are suggestions until explicitly selected; for example:

```sh
sannr migrate --dry-run --split npm=npm
sannr migrate --split npm=npm
sannr connect
```

All ordinary environments become one API stack. Its name comes from `--name`,
the stored API name, the contract title, or `api`, in that order. A trailing
word “API” is dropped before slugging. A top-level `hosts.<name>` becomes a
stack with a `default` environment; an environment-scoped host retains its
source environment name. Each stack gets its own contract copy and credential
references. A different-origin environment without a contract stays unbound.

Operations go to the unique stack whose contract declares them. Undeclared or
ambiguous operations retain their complete note history in `unsorted`, with a
named issue. File them explicitly after inspecting the plan:

```sh
sannr stack move --to npm "GET /downloads"
```

Use `--from <stack>` if that operation exists in several source stacks.
Moving an operation does not change its note text, provenance or verification.
Observations route by their saved origin and environment; unmatched identities
stay in `unsorted`. Their original identities and observation digests are
retained as migration provenance. Evidence moves by each run’s target URL,
without interpreting response bodies; references follow the new private paths.
No new execution or verification is claimed. Unsupported metadata stays with
the primary stack (or `unsorted` when there is no primary), with a named issue.

Migration also handles recognized older root and renamed layouts. It checks
all named destinations before writing, publishes each file atomically, reads
it back, then removes the corresponding sources. Distinct destination contents
are a named conflict; preserve both and resolve the conflict before retrying.
Repeating a completed migration makes no duplicate records. Repo-level graph,
audit and suite files keep their locations. Client defaults move to
`.sannr/defaults.json`; `config/` is removed only when empty, so unrelated
files are retained. Run `connect` afterwards to update the host registrations
and managed instructions without environment or contract pins.

The implicit single-store and older root read paths are compatibility routes;
`migrate` is the supported way forward. Fresh stack installations need no migration. The map and view
show one viewport per stack, and managed pointers have one section per stack;
see [stack context delivery](stacks.md). Cross-repository stack sharing is not
supported yet. Saving a lesson in a named stack preserves any existing graph
snapshot and returns `STACK_GRAPH_EXPORT_DEFERRED`; it does not replace that
snapshot with an incomplete export.

Migration and operation moves use `.sannr/.stack-migration.lock` to exclude a
second writer. If a process is killed, the lock may remain. After confirming
that no migration or stack move is running, remove that lock and preview again.
An identical destination left by an interrupted copy is safe to reuse; a
different destination remains a named conflict. If an operation move is
interrupted after its destination is written, both copies may remain. A retry
names that collision rather than choosing which history to discard; inspect
both stores before resolving it.

## Server and machine-state migration

The MCP registration key is `sannr`; the request tool is still `api_request`.
For an older installation, run `sannr migrate --dry-run`, review the plan,
then run `sannr migrate` and `sannr connect`. Recognized `api-request` entries
and Codex ownership markers are replaced without adding a second server.
Unmodified skills from shipped releases are upgraded. Customized registrations
and edited skills are named conflicts and are preserved for review.

The package exposes one command: use `sannr request`, including
`sannr request --report` for the machine-wide usage report. Doctor checks for
legacy command launchers on PATH without running them.

New usage rows and OAuth token grants are written under `~/.sannr/`, or the
directory selected by `SANNR_HOME`, with private permissions (0700 directories,
0600 files). The pre-rename `~/.agent-api-poc/` is never moved, renamed or deleted.
Older pinned installations can keep using it. A cached token is read from the
current location first, then from the old cache if its entry is missing; new or rotated grants
are written only to the current cache. Symlinked stores and directories are not read.

Usage reports, receipts and feedback count both logs and identify their sources.
An explicit `API_USAGE_LOG` selects that log instead. Doctor names old files once
and reports the readable locations for each store without showing token values.
If it cannot save its private notice receipt, it still names those files and may
repeat the warning on a later run.
If an earlier candidate already moved state, nothing moves back: current state
and any subsequently created old state remain readable.
Repository knowledge and private request evidence keep their existing paths.
