# Troubleshooting

Each entry names what you see, what it means, and what to do. Start with
`npx @sannr/sannr doctor --offline` when unsure; its PASS/WARN/FAIL rows and
`fix:` lines are the quickest description of an installation's state.

## `doctor` shows HTTP 403 from `https://api.github.com/zen`

A shared office, conference or cloud network can exhaust GitHub's anonymous
rate limit. Inspect the `probe-rate-limits` row: when the response carries
`x-ratelimit-remaining: 0` (or the status is 429) it reads WARN, says
"rate limit exhausted" and gives the reset time from `x-ratelimit-reset`.
HTTP 403 without that metadata does not establish the cause, and the row stays
PASS. The base-url row reads WARN for any unsuccessful HTTP response. A
response alone does not mean every setup check passed.

- `npx @sannr/sannr doctor --offline` runs every local check without a probe.
- `npx @sannr/sannr doctor --probe <url>` sends one unauthenticated GET to a
  public endpoint of your choice instead.
- Try again after the reset time in `x-ratelimit-reset`, or from another
  network.

A 403 is recorded as the latest onboarding observation. The offline checks
help distinguish local setup problems from a refused remote probe.

## The agent cannot see an `api_request` tool after setup

Coding hosts read MCP registrations at startup.

1. Restart the host (Claude Code needs a full restart; Codex and Cursor may
   offer a refresh), accept the project trust or MCP prompt if one appears, and
   open a fresh task in the same repository.
2. Run `npx @sannr/sannr doctor --offline`. The `mcp` row says whether the
   registration exists for each host and whether a new server process
   initializes. PASS there means the server can start; it does not mean the
   running host has loaded it.
3. If the host still shows no tool, look at its MCP startup error (Claude
   Code: `/mcp`; Codex: its MCP log) and check that `node` and `npx` resolve on
   the host's PATH. The registration includes the Node directory setup found;
   a host launched from a desktop icon may have a shorter PATH than your shell.

## "Setup binding" does not match

The pointer block in `AGENTS.md` carries `Setup binding: setup-v1:…`. The
agent compares it with the loaded tool's description. A mismatch means the host
loaded a server from another installation: another checkout, a teammate's
registration committed by mistake, or an older setup in a parent directory.
Registrations contain machine-local paths, so each clone runs
`npx @sannr/sannr connect` itself; do not commit `.mcp.json` from one machine
and expect it to work on another. Rerun `connect` here and restart the host.

## `note` fails with `CONTEXT_UNAVAILABLE`

There is no stack to write to. The message recommends creating a named
stack and retrying the note. An OpenAPI contract is optional:

```sh
npx @sannr/sannr stack add <name> --base-url <url>
npx @sannr/sannr note "GET /path" "What you learned." --stack <name>
```

With several stacks and no `default_stack` in `.sannr/defaults.json`,
commands need `--stack <name>` or they refuse with `STACK_REQUIRED`.

## `connect` or `note` names the older single-store file

Before the first stack exists, the `connect` message and a refused `note` name
`.sannr/stacks/sannr.json`. A fresh installation uses named stacks
(`.sannr/stacks/<name>/stack.json` and `sannr.json`) and needs no legacy file.
Create a stack as above. Earlier versions of `doctor` suggested adding
`.sannr/config/api-environments.json`; in a repository without stacks that file
makes `stack add` refuse with `STACKS_MIGRATION_REQUIRED`. If you created it
and have no notes yet, delete it and run `stack add`. See
[project layout](layout.md).

## `doctor` reports a legacy installation, or `STACKS_MIGRATION_REQUIRED`

The repository has a root-level `sannr.json` or `api-request.md`, or a single
`.sannr/stacks/sannr.json` store from an earlier version. Requests still run,
but notes and shared capture refuse until you migrate:

```sh
npx @sannr/sannr migrate --dry-run
npx @sannr/sannr migrate
npx @sannr/sannr connect
```

The preview writes nothing. Migration refuses conflicting destinations by name
and can be rerun safely. Details in [project layout](layout.md#migrate-an-existing-project).

## Cursor was not set up

Setup detects Cursor from an existing `.cursor/` directory. Create it, rerun
`npx @sannr/sannr connect`, and the registration lands in `.cursor/mcp.json`.

## A host refused a write to `.codex/config.toml` or `.agents/skills`

Some hosts protect their configuration. Approve the write through the host's
own flow and rerun `connect`; restarting does not complete a denied write.
`connect` reports a conflict instead of overwriting a file it did not generate.

## After a Node upgrade or `npm cache clean`, the MCP server does not start

An older registration can point at a deleted interpreter or cached server file.

```sh
npx @sannr/sannr doctor --offline --repair
```

Repair rewrites recognized, otherwise matching registrations to the durable
launcher and reports each file. Edited registrations stay as conflicts for you
to review. Restart the host afterwards.

## `doctor` warns about a legacy command on PATH

`api-request` or `api-context` is an earlier name of this CLI. The warning
says a launcher with that name is still on PATH; it is not executed. Remove it
when you no longer need it.

## The Workbench refuses with `WORKBENCH_TERMINAL_REQUIRED`

Run `npx @sannr/sannr workbench` in an interactive terminal, not through an
agent, a pipe or a script. Pairing needs the code typed at that terminal. If
the browser lost pairing (15 idle minutes, or 8 hours), choose **Pair again**
in the page and enter the new code at the same terminal.

## A request refuses before sending

Refusals name their code and come before any traffic: `ORIGIN_NOT_CONFIGURED`
(an absolute URL matches no stack), `STACK_AMBIGUOUS` (two stacks match),
`STACK_REQUIRED`, `ENVIRONMENT_NOT_FOUND`, a production write guard, or a
missing credential variable. Add or select the stack and environment the
message names. A refusal is not an API observation and records nothing about
the API.

## Something else

Run `npx @sannr/sannr doctor --offline --json` and open an issue with the rows,
your version (`npx @sannr/sannr --version`), host and platform, with private
paths and hostnames removed. See [SUPPORT.md](../SUPPORT.md).
