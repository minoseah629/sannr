# Quickstart: five minutes to a first recorded request

You need macOS or Linux, Node 22 or newer with npm, a git repository, and
Claude Code, Codex or Cursor. Native Windows is not supported. No account, API
contract or credentials are needed for any step on this page.

Every command below runs from the repository root. `npx @sannr/sannr <command>`
downloads the package on first use and asks npm's "Ok to proceed?" question in
an interactive terminal; `--yes` answers it. A repository-local install
(`npm install --save-dev @sannr/sannr`) gives you `./node_modules/.bin/sannr`
instead, and the commands Sannr writes into your repository then use that
form. See [install](install.md) for hosts, repair and removal.

## 1. Install (about 30 seconds)

```sh
npx @sannr/sannr connect
```

`connect` reports every file it writes. On a fresh repository that is the MCP
registration for each detected host (`.mcp.json` for Claude Code,
`.codex/config.toml` for Codex; Cursor needs an existing `.cursor/` directory),
the three skills under `.sannr/skills/`, `.claude/skills/` and
`.agents/skills/`, a pointer block in `AGENTS.md`, a `CLAUDE.md` that imports it
(an existing `CLAUDE.md` gets the same block instead), and `.sannr/README.md`,
`.sannr/.gitignore` and `.sannr/layout.json`. It ends with:

```
Agent wiring configured.
API context: no OpenAPI contract found. The client is installed; notes are not ready yet.
```

That second line is expected in an empty repository. Above it `connect` says
"Nothing your agent calls is kept until a stack exists." and recommends
`stack add <name> --base-url <url>`; an OpenAPI contract is optional. Step 3
creates what notes need. In your own repository `connect` may already have made
the first stack: from an OpenAPI contract, or from the one public API your code
calls (`First API stack created: stripe → https://api.stripe.com, detected in
code (src/pay.js).`). `connect --base-url https://api.github.com --stack github`
does install and step 3 in one command.

## 2. Check it (about 30 seconds)

```sh
npx @sannr/sannr doctor
```

`doctor` says what it is about to send, then sends it: one unauthenticated
`GET https://api.github.com/zen`, with no credentials, redirects or retries.
It records a bounded observation (status, latency, rate-limit headers, an
evidence id) in `.sannr/evidence/onboarding.json`, which Git ignores. Trimmed
output on a fresh repository:

```
About to request: GET https://api.github.com/zen (API client; no credentials, redirects, or retries)

  PASS layout    Project files live under .sannr; see .sannr/README.md.
  WARN contract  no OpenAPI document selected or found; setup can continue
  WARN config    no API stack yet; notes and shared capture need one (a contract is optional)
  PASS base-url  https://api.github.com/zen reachable through the API client (HTTP 200, 245 ms); ...
  PASS probe-rate-limits x-ratelimit-limit: 60, x-ratelimit-remaining: 58, ...
  PASS onboarding saved local observation run-... in .sannr/evidence/onboarding.json; ...
  WARN auth      no auth configured for this environment
  PASS mcp       registered for Claude Code as 'sannr' and Codex as 'sannr'; MCP initialize responded
  PASS skills    installed for Claude Code and Codex (9 files)
  PASS wiring    wired into AGENTS.md, CLAUDE.md (CLAUDE imports AGENTS)

Nothing's on fire: all checks passed, 3 warnings.
```

Warnings are fine here: there is no contract, no stack and no credential yet;
step 3 creates the stack, and the other two are optional. The config row's
`fix:` line names the `stack add` command for your install. `doctor` exits 0 unless a row says FAIL.
A 200 from GitHub shows the client's network path works; it says nothing about
any other API.

**If the base-url row shows HTTP 403**, read the `probe-rate-limits` row. When
the response carries `x-ratelimit-remaining: 0` (or the status is 429), that row
reads WARN, says the rate limit is exhausted and gives the reset time. Shared
office, conference or cloud networks can exhaust GitHub's anonymous limit; a
403 without that metadata has some other cause. Run
`npx @sannr/sannr doctor --offline` to finish the local checks
without a probe, or `doctor --probe <url>` to use a public GET endpoint you
prefer. The saved observation can be read back later without a request with
`npx @sannr/sannr context query --onboarding`.

## 3. Name your first API (about 30 seconds)

```sh
npx @sannr/sannr stack add github --base-url https://api.github.com
```

```
github: .sannr/stacks/github/stack.json
Knowledge: .sannr/stacks/github/sannr.json
```

A stack is one API you talk to. It holds the base URL, an optional credential
reference (`--auth bearer:GITHUB_TOKEN` names the variable, never the value), an
optional OpenAPI contract (`--contract <path>`), and the knowledge file where
notes and observations for that API go. Without a stack there is nowhere to put
a note, which is why `note` refuses with `CONTEXT_UNAVAILABLE` on a repository
that has none yet. If `connect` already created a stack for another API, this
adds a second one; the steps below name `--stack github` explicitly. `npx @sannr/sannr stacks` lists what you have; the
packaged read-only `sannr-feedback` stack is always in that list.

## 4. Restart your agent and say "Finish sannr setup." (about a minute)

Coding hosts read MCP registrations at startup, so Claude Code needs a restart
(Codex and Cursor may offer a refresh) before the `api_request` tool exists.
Accept the project trust or MCP prompt if one appears, open a fresh task in the
same repository and say:

> Finish sannr setup.

The pointer block `connect` wrote into `AGENTS.md` tells the agent how to
confirm the tool it sees belongs to this installation (an exact setup binding in
the tool description), read the saved onboarding observation, and summarize
each stack's state. Until the host has restarted, the installed skills fall
back to the CLI; that is normal.

## 5. First request and first note (about a minute)

Through the agent, paste:

> Use Sannr to GET /zen on the github stack, assert status 200, then record a
> note about what it returns.

The agent should report the status, the one assertion, an evidence id, and a
note saved in `.sannr/stacks/github/sannr.json`. The same three commands by
hand:

```sh
npx @sannr/sannr request GET /zen --stack github --expect-status 200
npx @sannr/sannr note "GET /zen" "Returns one line of text; it varies." --stack github
npx @sannr/sannr show "GET /zen" --stack github --human
```

The request result reads `"status": 200, "ok": true` with
`"assertions": {"passed": 1, "failed": 0}` and an `"evidence": "run-..."` id.
Its `context_capture` is `limited` with `CONTRACT_NOT_BOUND`: without a
contract the response is kept as private evidence, and nothing structural is
promoted into the shared knowledge file. The note is the shared part. `note`
prints the note's digest and file, and updates the `AGENTS.md` pointer block
with a **Known gotchas** line so the next agent reads it before calling. `show`
prints the note with its author, date and evidence class (`written`: an
authored claim, not an observed or asserted fact).

## 6. Open the Workbench (about a minute)

```sh
npx @sannr/sannr workbench
```

This needs an interactive terminal: it refuses with
`WORKBENCH_TERMINAL_REQUIRED` under a pipe or an agent's shell. It prints
`Local workbench: http://127.0.0.1:<port>/` and opens your browser (`--no-open`
prints the URL only). The page shows a pairing code such as `3277-0F66-7C6D`;
the terminal then says "Browser requested pairing" and shows a
`Pairing code:` prompt. Type the code there, and the terminal answers
**Browser connected. Workbench ready**.

The page opens on the **Workbench** view: the `github` stack's `GET /zen` note
in the left column, the note itself in the middle (author, date, basis and
"No evidence run is attached", because `note` was run by hand without one),
and its trace on the right, from the claim back to the contract (here "never
verified": the stack has no contract). The middle column also offers **Add
notes** for a response of your own and a **Verify** prompt to paste into your
coding agent. The **Map** switch in the header draws which code defines which
operation once a survey exists; until then it says there is no survey yet and
names the `survey generate` command for your install. Opening
either view sends no API request. Keep the terminal open while you use it;
Ctrl-C closes it. The [workbench guide](workbench.md) covers the rest.

## 7. Commit `.sannr/`

```sh
git add .sannr AGENTS.md CLAUDE.md .mcp.json .codex
git commit -m "Add Sannr API context"
```

`.sannr/.gitignore` already excludes `.sannr/evidence/`, so request evidence
stays on this machine. A teammate who clones the repository runs
`npx @sannr/sannr connect` once (registrations carry machine-local paths) and
starts with your note.

## Next

- Add your own API: `stack add <name> --base-url <url> --auth bearer:<VAR> --contract <openapi.json>`;
  see [API stacks](stacks.md) and [project layout](layout.md).
- Give the agent an actual task against it. The [agent guide](agent-guide.md)
  and [worked examples](agent-examples.md) describe the workflow.
- Something did not match this page? See [troubleshooting](troubleshooting.md).
