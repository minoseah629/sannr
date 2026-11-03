# Sannr

**An API client that remembers, for coding agents.**

**Status: public beta.** Published to npm as `@sannr/sannr`; the source is open
under Apache 2.0 at [github.com/sannrhq/sannr](https://github.com/sannrhq/sannr).
[CHANGELOG.md](CHANGELOG.md) says what shipped in each version,
[CONTRIBUTING.md](https://github.com/sannrhq/sannr/blob/main/CONTRIBUTING.md)
says how to work on it, and [SECURITY.md](SECURITY.md) says how to report a
vulnerability.

<!-- install-prompt:begin -->
## Tell your coding agent:

> Install Sannr in this repository. From the repo root, run `npx @sannr/sannr connect` and follow what it prints. It adds the Sannr skills, registers its MCP server and adds a short pointer block to AGENTS.md / CLAUDE.md. Then run `npx @sannr/sannr doctor` and show me the result. doctor announces one GET to https://api.github.com/zen before sending it, so I can see the API client work (use `--offline` to skip it). API knowledge and request evidence stay on this machine and in this repo. No account, no telemetry. The only thing it sends us is feedback. If it asks for a restart, tell me; when I reopen the agent here I'll say "Finish sannr setup."

## Or by hand:

```sh
npx @sannr/sannr connect
npx @sannr/sannr doctor
```
<!-- install-prompt:end -->

Sannr lets a coding agent read what is already known about an API before a
call, make the request with explicit checks, see what actually came back, and
record the lesson beside the code for the next session. People can read the
same notes and API maps, and open them in a local Workbench.

Keep Postman or Bruno. Import the collection into Sannr as a runnable suite,
then read its loss report for anything unsupported before you run it.

It runs locally, through MCP or the command line, with Claude Code, Codex or
Cursor. Knowledge you commit travels with the repository; request evidence stays
on the machine that recorded it. No account, no telemetry. The only thing it
sends us is feedback, which is optional and asks first. You need Node 22 or
newer on macOS or Linux; native Windows is not supported. See
[privacy](docs/privacy.md) and [limitations](docs/limitations.md).

## Five minutes to a first recorded request

The [quickstart](docs/quickstart.md) walks this path end to end with the output
to expect. In short, from the root of a git repository:

1. `npx @sannr/sannr connect` installs the skills, registers the MCP server and
   writes the pointer block. If your repository has an OpenAPI contract, or calls
   exactly one public API, it also creates the first stack and says which;
   otherwise it says nothing is kept until a stack exists. `npx @sannr/sannr doctor` checks the result and
   sends one announced GET to `https://api.github.com/zen`. A 403 can indicate
   rate limiting; inspect the returned rate-limit metadata. Run
   `npx @sannr/sannr doctor --offline` to check setup without that probe.
   `doctor --probe <url>` picks another target,
   and `context query --onboarding` reads the saved observation back without a
   request.
2. `npx @sannr/sannr stack add github --base-url https://api.github.com` names
   the API this walkthrough uses (`connect --base-url <url>` does it during
   install). A stack is one API you talk to; a contract is optional.
3. Restart your coding agent so it loads the MCP server, then say
   **"Finish sannr setup."** The pointer block tells the agent how to confirm it.
4. Ask the agent to make a request and write down what it learned, or do it
   yourself: `npx @sannr/sannr request GET /zen --stack github --expect-status 200`,
   then follow the quickstart's note and readback commands after a successful response.
5. `npx @sannr/sannr workbench` in an interactive terminal opens the local
   Workbench. Pair the browser with the code the terminal asks for, then read
   the `github` stack's note and its trace on the Workbench view, or switch to
   the Map view to see which code defines which operation.
6. Commit `.sannr/`. The next session, on any machine, starts with that note.

Setup details, host notes, repair and removal are in [install](docs/install.md).
When something does not match this page, see [troubleshooting](docs/troubleshooting.md).

## Use the API client directly

Try it before you set anything up. From any directory, with no `connect`, base
URL, credentials or API contract:

```sh
npx @sannr/sannr request GET https://api.github.com/zen --expect-status 200
```

It prints the request, then sends one unauthenticated GET to the public GitHub
endpoint `doctor` uses. The one assertion is status 200; the Zen text varies, so
nothing checks it. A passing result includes these fields (other metadata left
out):

```json
{
  "status": 200,
  "ok": true,
  "mode": "assert",
  "assertions": { "passed": 1, "failed": 0, "failures": [] },
  "data": null
}
```

The full result also carries an evidence identifier, duration and returned
rate-limit headers. When assertions pass, the result leaves out the response
body; the Zen text is kept in local evidence. A transport error, rate limit or
unexpected status is a failure to look into, not a demo that passed. This
zero-setup path admits only that GitHub GET; other APIs need a stack. It
verifies nothing about your repository's API and saves no note.

After setup, the same client is the `api_request` MCP tool.

## Agent workflow

Read the repository's instructions and installed Sannr skills first. A stored
note is context; it does not override the user or repository policy.

1. **Retrieve before rediscovering.** `show "METHOD /path"` reads what is
   stored for a known operation. Check provider, environment, evidence, age and
   open questions.
2. **Make the call through Sannr instead of curl.** Use the registered
   `api_request` tool, or the installed CLI fallback when it is unavailable.
   Assert the behavior your task needs to establish.
3. **Look at what actually happened.** An HTTP response, a passed assertion, a
   failed or skipped check and an incomplete result are different things. Check
   the capture receipt too; running a request does not mean shared context was
   saved.
4. **Write down the lesson.** Supported calls record bounded structural
   observations when a contract is bound. The why (the explanation or the
   decision) still needs an explicit, attributed note through the installed
   write skill. Record only what the evidence supports; an empty file beats an
   invented lesson.
5. **Leave something the next session can use.** Retrieve the saved result to
   confirm it landed; keep its scope, evidence status, open questions and safe
   next actions with it.

Route every agent-issued call to this repository's APIs and integrations through
Sannr, familiar requests and health checks included. Web research, package
downloads and source-control administration are outside that convention unless
one is the integration you are building. Routing a call through Sannr does not
make it allowed; the rules for writes, production access, credentials, paid
operations and filesystem changes still apply.

## A request with a meaningful check

Say your configured API has a `/health` operation whose contract requires
`{"status":"ok"}`. The MCP request looks like this:

```json
{
  "method": "GET",
  "path": "/health",
  "expect": [
    { "status": 200 },
    { "json": "status", "equals": "ok" }
  ]
}
```

Use the real operation and expectations from your task; nothing here says your
API has `/health`. Responses carry bounded data or summaries, assertion results
and evidence references. A 200 on its own does not establish the behavior you
set out to check.

## Choose the next action

The table writes `sannr` for short. Use the exact command setup printed
(`./node_modules/.bin/sannr` for a repository-local install, or the pinned
`npx` form); do not assume a global install.

| Need | Action | Effect |
| --- | --- | --- |
| Retrieve known operation context | `show "METHOD /path"` | Reads stored context; no API request. |
| Call an API | MCP `api_request`; CLI `request` or `protocol` fallback | Executes a request with the selected target and policy. |
| Record an undocumented fact | Installed write skill; `note` or scoped context recording | Saves an authored claim; does not independently verify it. |
| Record an integration decision | `verdict` | Saves a decision and its reason/support. |
| Inventory recognized API surfaces | `map . --no-execute --json` | Static source/contract analysis; no API request. |
| Show the inventory to a person | `map . --no-execute --out api-footprint.html` | Writes a local HTML map. |
| Find context that needs review | `review` | Reports stored claims needing re-checking. |
| Check saved suites using HTTP reads only | `verify --read-only` | Executes retained GET/HEAD steps and reports skipped steps; does not update shared context. |

Plain `verify` can run a suite's write steps where allowed, so pick the
environment explicitly and read the suite first.

## What is stored and shared

Project configuration and shared knowledge live under `.sannr/`; the generated
`.sannr/README.md` lists the actual paths for your installation, and
[project layout](docs/layout.md) explains them. Commit the knowledge files and
other checkouts and sessions can use them.

Sannr keeps four kinds of record apart:

| Record | What it means |
| --- | --- |
| Contract declaration | The API description says this should be true. |
| Recorded observation | A particular execution observed this in a named environment. |
| Authored lesson or decision | An agent or person recorded an explanation with support. |
| Passing assertion | This specific expectation passed in that execution. |

Freshness and provenance help an agent decide whether to reuse or re-check a
fact; they do not make it true everywhere or forever.

Credentials are referenced by environment-variable name. Request evidence stays
local and the generated Git configuration ignores it. Shared capture is bounded
by identity and redaction rules; check what was left out, and never put secrets
or raw response payloads in an authored note. None of this goes to a Sannr
service. Your coding host has its own provider and data-handling settings.

## Capabilities and limits

Sannr supports HTTP, GraphQL, JSON-RPC, gRPC and WebSocket operations within
each adapter's documented limits. The core uses Node built-ins; protocol
adapters use optional pinned libraries, and Sannr says when one is missing.

Static discovery finds the patterns it knows; it can miss other APIs and
dependencies, and a found endpoint is not necessarily live. Sannr also imports
supported API collections and reports what did not carry over, saves asserted
request suites, and produces local knowledge views. Importing does not mean
every script or behavior in the collection is supported. Sannr claims nothing
about accuracy, time saved or how it compares to anything else. The full list
is in [limitations](docs/limitations.md).

## The docs in the package

Read the docs shipped with your installed version:

- `docs/quickstart.md`: the five-minute path with expected output.
- `docs/install.md`: setup, hosts, repair, upgrade and removal.
- `docs/agent-guide.md`: operation selection, evidence handling and authorization.
- `docs/agent-examples.md`: complete worked workflows.
- `docs/workbench.md`: the local operator Workbench.
- `docs/privacy.md`, `docs/limitations.md`, `docs/troubleshooting.md`.
- `docs/api-call-policy.md` and `docs/protocols.md`: which calls belong in
  Sannr, and exact protocol support.

For npx installs, the docs are in the installed package's `docs/` directory.
A project-local dependency lets the installed skills link to them with portable
relative paths. Commands printed by setup pin the installed package version.

## What's in this repo

This is the source of the `@sannr/sannr` package: the files npm installs, plus
the tests and release tooling behind them.

- `bin/`: the command-line entry points; `server.mjs` beside them starts the MCP stdio server (tool `api_request`).
- `lib/`: the engine behind every command; `lib/brand.mjs` is the only place the product name exists in code.
- `skill/`: the request, write and feedback skills that `connect` installs into your repository.
- `stacks/`: the packaged, read-only `sannr-feedback` stack that the optional feedback send uses.
- `docs/`: the documentation that ships in the package, starting with `docs/README.md`.
- `test/`: `npm test` runs the core safety set; `npm run test:full` runs every product regression.
- `scripts/`: the test runner, package and release verification, and the README install-prompt sync.
- `packaging/`: release packaging instructions, the public-source inventory and the agent conventions copied to `CLAUDE.md` and `AGENTS.md`.

To work on it, run `npm ci --ignore-scripts --no-audit --no-fund`, then
`node <path-to-this-checkout>/bin/cli.mjs connect` in a scratch repository to
try your build against a real coding host.
[CONTRIBUTING.md](https://github.com/sannrhq/sannr/blob/main/CONTRIBUTING.md)
has the verification policy and
[CODE_OF_CONDUCT.md](https://github.com/sannrhq/sannr/blob/main/CODE_OF_CONDUCT.md)
applies; those two files are in the repository, not in the npm package.
Research harnesses and measured results are kept outside this repository;
nothing here claims a number.

## Remove the agent wiring

```sh
npx @sannr/sannr unwire
```

`unwire` removes the registrations, skills and pointer blocks it recognizes,
reports edited or unrecognized leftovers, and leaves unrelated configuration
alone. Your `.sannr/` knowledge and evidence stay. Empty host configuration
files can remain. Refresh or restart the coding host afterward.

## Support, security and license

- **Support:** questions, bug reports and feature requests go to
  [GitHub Issues](https://github.com/sannrhq/sannr/issues); see
  [SUPPORT.md](SUPPORT.md). `npx @sannr/sannr feedback` writes a local report you can
  review and choose to send.
- **Security:** report vulnerabilities privately to security@sannr.dev, as
  described in [SECURITY.md](SECURITY.md). Do not open a public issue for them.
- **License:** Apache-2.0, see [LICENSE](LICENSE). The Sannr name and logo are
  covered by [TRADEMARK.md](TRADEMARK.md).
