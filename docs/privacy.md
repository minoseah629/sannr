# Privacy: what Sannr stores, and what leaves your machine

Sannr has no account and no telemetry. It is a local API client with files
beside your code. This page says where each kind of record lives and which
commands put traffic on the network. The exact destination inventory is in
[network behavior](network-behavior.md); the feedback payload is in
[feedback](feedback.md).

## What is stored, and where

| Where | What | Who can read it |
| --- | --- | --- |
| `.sannr/stacks/<name>/sannr.json` (committed) | Per-API knowledge: operation names, field names and types, enum values the contract declares, authored notes and decisions with author and date, observation summaries. No request or response bodies, headers, query values or credentials. | Anyone with the repository, including your coding agent. |
| `.sannr/stacks/<name>/stack.json` (committed) | Base URLs, environment names, contract paths, and credential references by environment-variable name. Never a credential value. | Same. |
| `AGENTS.md` and `CLAUDE.md` pointer block (committed) | A summary of each stack and its recorded notes, so agents read them without a command. | Same. |
| `.sannr/evidence/` (ignored by Git) | Request and response evidence for executed calls, including bodies, with detected credentials masked; the onboarding observation from `doctor`; Workbench settings and handoff inboxes. | This machine only. Masking does not remove all personal data, and Git ignore rules do not protect a folder that is copied or uploaded. |
| `~/.sannr/` (or `SANNR_HOME`) | A registry of repositories set up on this machine, a usage log of request sizes and outcomes, and cached OAuth tokens when you configure OAuth. Files are mode 0600 in 0700 directories. | This machine only. |
| `.sannr/feedback/` (ignored by Git) | The local feedback report and, under `sent/`, the exact bytes of any report you chose to send. | This machine only. |

The promotion boundary decides what moves from evidence into committed
knowledge: field names and types, and a value only when the contract declares
it as an enum. Review a knowledge file before committing it, as you would any
other file; the boundary is enforced by tests, and authored notes are still
free text that you or your agent wrote.

## What leaves the machine, and when

| Traffic | Trigger | Destination |
| --- | --- | --- |
| Package download | `npx @sannr/sannr …` when the version is not cached; `npm install`. | The npm registry configured for npm, with its proxies and cache. |
| Setup probe | `doctor` (not `doctor --offline`). Announced before it is sent. | `GET https://api.github.com/zen` with no configured API; an unauthenticated HEAD to your configured base URL otherwise; `--probe <url>` chooses another GET. No credentials, cookies, redirects or retries. |
| Your API calls | `request`, `protocol`, `learn`, `verify`, suite runs, `map --execute`, Workbench **Send request**, and the `api_request` MCP tool. | The stacks and URLs you configure or name, with the credentials those environments reference. OAuth grants go to the configured token URL. Redirects follow the client's credential and method guards. |
| Postman capture | `postman capture`, explicitly. | `https://api.getpostman.com`, with `POSTMAN_API_KEY` from your environment. Importing an exported file contacts nothing. |
| Feedback | `feedback --send`, after a human yes (or an explicit `allow` setting). | `https://sannr.dev/api/v1/feedback`: version, platform, host category, aggregate counts and the prose you supply, with names, paths, hostnames and identifiers removed. |

Nothing else. `connect`, `unwire`, `note`, `show`, `map`, `view`, `survey`,
`import` of a local file, the Workbench's read-only views and session
completion send no requests. `lib/feedback.mjs`, which collects the report,
has no network capability; a test asserts it. The Workbench listens on IPv4
loopback only, on an ephemeral port, and needs a pairing code typed at the
terminal that launched it.

## What your coding agent's provider sees

Sannr runs where your agent runs. Whatever the agent reads goes to its model
provider under that provider's terms: the pointer block, the notes it looks up,
and the bounded request results the MCP tool returns, which can include
response data within the configured budget. Response credentials are masked
in agent-visible output; a `data_secrets` receipt names when masking happened.
If a response should not reach the model at all, do not route that call
through an agent. Sannr adds no provider of its own.

## Credentials

Configuration stores the names of environment variables, never values; a
literal credential on the command line is refused with an instruction to rotate
it. Credentials are read from the process environment or a stack's `envFile`
at request time and sent only to that stack's hosts. Evidence files mask
detected credentials but may contain other sensitive response content; treat
`.sannr/evidence/` as private.

## Reporting a concern

Anything that could expose credentials or files goes to security@sannr.dev,
per [SECURITY.md](../SECURITY.md), not to a public issue.
