# Install Sannr

This page is the reference for setup: what `connect` and `doctor` do, how each
coding host loads the MCP server, how commands are pinned, and how to repair,
upgrade or remove an installation. For the first run, start with the
[quickstart](quickstart.md).

You need macOS, Linux or Windows, Node 22 or newer with npm, and Claude Code,
Codex or Cursor. Windows needs no WSL; the [Windows](#windows) section below
names the command form to use in PowerShell. No account, API contract or
credentials are needed for setup.

## Windows

Native Windows is supported from `0.1.0-beta.2` with Node 22 or newer, from
PowerShell, `cmd.exe` or Git Bash. Install from npm exactly as on the other
platforms (see [Install from npm](#install-from-npm)), then run:

```powershell
node .\node_modules\@sannr\sannr\bin\cli.mjs connect
node .\node_modules\@sannr\sannr\bin\cli.mjs doctor --offline
```

npm puts three launchers in `node_modules\.bin`: `sannr` (a POSIX shell
script), `sannr.cmd` and `sannr.ps1`. In PowerShell,
`./node_modules/.bin/sannr` can run `sannr.ps1`, which the default execution
policy on Windows client editions (`Restricted`) refuses with "running scripts
is disabled on this system", the same error npm's own `npm.ps1` gives. Two
forms need no policy change and work in PowerShell and `cmd.exe`:
`node .\node_modules\@sannr\sannr\bin\cli.mjs <command>` and
`.\node_modules\.bin\sannr.cmd <command>`. If you already ran
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` for npm, the `.ps1`
launcher runs too.

Which form an agent needs depends on its shell. Claude Code on Windows runs
commands through Git Bash, where `./node_modules/.bin/sannr` runs the shell
script exactly as on macOS and Linux. Codex runs commands in PowerShell. The
generated pointer block keeps the `./node_modules/.bin/sannr` form, which is
the same for every teammate, and adds one line giving the PowerShell form;
`connect` prints the same advice in a Windows terminal.

Native setup uses Windows paths and Node directly for MCP. A package-manager
MCP launch uses npm's JavaScript entry rather than executing `npx.cmd` as a
native program. The Workbench uses a local Windows named pipe for discovery
and control. No WSL or Administrator/Developer Mode is required for core use.
Windows file privacy relies on the containing directories' NTFS ACLs; Node's
POSIX permission bits do not describe those ACLs. Keep private evidence and
local credentials in directories private to your Windows account.

The optional `connect --claude-hook` PreToolUse hook is written to
`.claude/settings.local.json` in Claude Code's exec form on Windows: `command`
is the Node executable and `args` holds the hook script and its generated
arguments, so Claude Code spawns it without Git Bash or PowerShell. On macOS
and Linux it remains a single shell-form `command` string. `connect`,
`unwire` and the ownership check recognize either form on any platform; on
Windows, an unedited shell-form entry from an earlier connect is rewritten to
exec form (action `update`). The hook matches only Claude Code's `Bash` tool
and lexes POSIX shell syntax. On Windows it therefore covers Bash commands
run through Git Bash, not Claude Code's PowerShell tool; without Git Bash,
Claude Code offers only the PowerShell tool and the hook never fires.

What is verified on Windows: the repository's CI runs the core safety set and
the native CLI, MCP and Workbench scenarios on `windows-latest` with Node 22
and 24 for every change. The full product suite on Windows is a manual CI
dispatch rather than a per-change gate, and it still reports failures; the
product behaviors known not to work on Windows yet are listed under
[limitations](limitations.md#platforms-and-hosts). Browser behavior, the
Claude Code hook firing inside Claude Code and the Workbench and `view --open` openers are not
exercised by CI.
Restart the coding host after setup and compare the new repository binding
before claiming activation.

## Install from npm

Run from the repository root:

```sh
npx @sannr/sannr connect
npx @sannr/sannr doctor
```

An untagged `npx @sannr/sannr` resolves npm's `latest` tag, which is the
current public release. `npx` asks npm's "Ok to proceed?" question the first
time it downloads the package in an interactive terminal; `--yes` answers it and
grants nothing else. To pin a version, write it out:
`npx @sannr/sannr@<version> connect`.

A repository-local install is the alternative:

```sh
npm install --save-dev @sannr/sannr
./node_modules/.bin/sannr connect
```

With a local install, every command Sannr writes into your repository (the
pointer block, the installed skills) uses `./node_modules/.bin/sannr`, with one
pointer line giving the PowerShell form
`node ./node_modules/@sannr/sannr/bin/cli.mjs` ([why](#windows)), the MCP
registration starts the local `server.mjs` with no npm download, and the
installed skills can link to the package's `docs/` with relative paths. Use
`--omit=optional` to leave out the pinned protocol libraries (GraphQL,
WebSocket, gRPC); core commands work without them, and a missing adapter is
named with its install command when first used.

### What `connect` writes

`connect` reports every file it creates or changes and never overwrites a file
it did not generate. On a fresh repository:

| Path | Purpose |
| --- | --- |
| `.mcp.json` | Claude Code MCP registration, server name `sannr`. |
| `.codex/config.toml` | Codex MCP registration. |
| `.cursor/mcp.json` | Cursor registration, only when `.cursor/` already exists. |
| `.sannr/skills/`, `.claude/skills/`, `.agents/skills/` | The `sannr-request`, `sannr-write` and `sannr-feedback` skills; `.sannr/skills/` is the source copy. |
| `AGENTS.md` | The managed pointer block between `<!-- sannr:begin -->` and `<!-- sannr:end -->`; existing content is kept. |
| `CLAUDE.md` | The same block if the file exists; otherwise a one-line file containing `@AGENTS.md`. |
| `.sannr/README.md`, `.sannr/.gitignore`, `.sannr/layout.json` | The generated directory guide, the ignore rule for local evidence, and the layout marker. |
| `~/.sannr/registry.json` | A machine-local list of repositories set up on this machine (`SANNR_HOME` moves it). |

`connect` sends no API request. In a repository with no stack yet it also
creates the first one, because until a stack exists nothing your agent calls is
kept and `note` has nowhere to write:

- When it finds an OpenAPI document, the stack is named from the contract
  title and the contract's operations are inventoried as unverified entries.
- Otherwise `connect --base-url <url>` creates it for that API, with the same
  checks as `stack add`: no credentials, query or fragment in the URL;
  `--auth bearer:VAR` names a variable, never a value; `--stack <name>` and
  `--env <name>` are optional.
- With no flag, the one public API the code visibly calls becomes the stack
  (for example `api.stripe.com` becomes `stripe`), reported as
  `detected-in-code` with the file it was found in. Several APIs, or none,
  create nothing: the receipt lists each candidate with a ready
  `stack add <name> --base-url <origin>` command and says "Nothing your agent
  calls is kept until a stack exists." Loopback and private-network hosts are
  listed but never chosen.

An existing stack or single-store installation always wins, and a second
`connect` never adds a stack. `--dry-run` reports the stack it would create.
With a stack but no contract, responses are not yet captured into the shared
knowledge file automatically; notes work from the first call. `start --json` is an
alternative to `connect` that also prints a static API inventory and accepts
`--contract <path>` to name the document explicitly; you do not need both.
`start --dry-run --json` previews the plan without writing.

If your host protects project configuration such as `.codex/config.toml` or
`.agents/skills`, use its normal approval flow for those writes. A denied write
leaves setup incomplete; restarting does not complete it. Rerunning `connect`
finishes partial setup, keeps unrelated configuration and reports conflicts
instead of replacing edited files.

### What `doctor` checks

`doctor` runs local checks (layout, contract, configuration, MCP registration
and initialization, skills, pointer wiring, legacy launchers on PATH) and one
announced API probe. It exits 0 when no row is FAIL; warnings alone do not fail
setup. A missing OpenAPI document is a WARN in every repository. Keep FAIL and
WARN rows visible when you report the result.

| Doctor target | Request |
| --- | --- |
| No API configured | One unauthenticated `GET https://api.github.com/zen` to GitHub's public service. |
| A configured base URL | Unauthenticated HEAD to that URL; one separately announced GET fallback only if HEAD fails at the transport layer. |
| `--probe <url>` | One unauthenticated GET to your chosen URL, overriding either target above. |
| `--offline` | No API probe; local checks still run, including starting the registered MCP process once to check that it initializes. |

Probes send no configured credentials, cookies or static headers, obtain no
OAuth tokens, follow no redirects and do not retry. A received response creates
or updates `.sannr/evidence/onboarding.json` with bounded first and latest
observations (target, method, status, latency, rate-limit headers, evidence
id), without the response body. That file is private, ignored by Git, and is
not knowledge about your repository's API. Read it back without a request:

```sh
npx @sannr/sannr context query --onboarding
```

`doctor --json` keeps the announcement on stderr so the result stays
machine-readable. A GitHub 403 can indicate rate limiting; inspect its returned
rate-limit metadata before assigning a cause. See [troubleshooting](troubleshooting.md).

## Finish connecting in your coding agent

Coding hosts read MCP registrations at startup. Refresh or restart the host
(Claude Code needs a restart), accept its project trust or MCP prompt if one
appears, and open a fresh task in the same repository. Say:

> Finish sannr setup.

The pointer block tells the agent to compare the exact `Setup binding: <id>`
in the loaded `api_request` tool's description with the one saved by this
installation. A tool with the right name alone is not proof: it may belong to
an earlier setup or another checkout. On a match the agent reads the saved
onboarding observation and summarizes each stack's configuration. No API
request is needed to confirm activation, and a passing local `doctor` does not
prove the host loaded the server. Until the host restarts, the installed skills
use the CLI; that is normal.

## How commands and the MCP server are pinned

An npx or global npm installation registers the server as an exact-version npx
command (`npx --yes --ignore-scripts --package=@sannr/sannr@<version> -- sannr mcp serve`),
not as a path into npm's cache. Publishing a newer version does not change an
existing registration; pruning npm's cache lets npx download that same version
again when the registry is reachable. Where available, setup records stable
Node and npx paths and adds the Node directory to the registration's PATH so
desktop hosts do not need a login shell; otherwise the host needs Node and npx
on its own PATH. The commands written into the pointer block and skills pin the
same version. A repository-local installation keeps its local server and needs
no download to start.

New registrations use the server name `sannr`; the tool is `api_request`. An
older repository can still show `api-request` until you run `connect` from the
newer version and restart the host. Setup replaces recognized, unedited older
registrations and removes matching duplicates; customized registrations stay as
named conflicts for review.

## Upgrade

Run `connect` from the version you want:

```sh
npx @sannr/sannr@<version> connect
```

It rewrites the registration and the pinned commands to that version, upgrades
unmodified installed skills, and leaves edited skills and customized
registrations as reported conflicts. Then restart the host. For a local
install, update the dependency and run `./node_modules/.bin/sannr connect`.
A repository that still has a root-level `sannr.json` or `api-request.md`, or a
single `.sannr/stacks/sannr.json` store, is an older layout; `doctor` names it
and `migrate --dry-run` previews the move. See [project layout](layout.md).

## Repair

A Node upgrade or an npm cache prune can leave an older registration pointing
at a deleted interpreter or cached server file. Run:

```sh
npx @sannr/sannr doctor --offline --repair
```

Repair migrates recognized, otherwise matching Sannr registrations to the
durable launcher and reports each changed file; edited or unrecognized
registrations remain conflicts for review. Restart the host afterwards.

## Monorepos

One install at the root. Named stacks separate API context by integration
inside that installation; `--stack <name>` selects one explicitly. Stacks are
not assigned to package folders automatically, and per-folder scoping is not
available yet.

## Remove the agent wiring

```sh
npx @sannr/sannr unwire
```

This removes recognized Sannr MCP registrations, unedited generated skills and
managed pointer blocks, and reports edited or unrecognized leftovers. A
`@AGENTS.md` line in `CLAUDE.md` stays, because that generic import may already
have belonged to the project. Empty `.mcp.json`, `.codex/config.toml`,
`AGENTS.md` or `CLAUDE.md` files can remain. The `.sannr/` directory with its
knowledge, configuration and evidence is kept. Restart the host so it unloads
the removed registration.

## What setup sends and stores

Installation uses the network for npm downloads and the one probe `doctor`
announces. Setup never sends feedback. API knowledge lives in the repository;
request evidence, the registry and other state stay on this machine. See
[privacy](privacy.md) and [network behavior](network-behavior.md).
