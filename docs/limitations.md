# Known limitations

What Sannr does not do in this release, in one place, so you can tell a gap
from a bug. Bugs go to [GitHub Issues](https://github.com/sannrhq/sannr/issues);
see [SUPPORT.md](../SUPPORT.md).

## Platforms and hosts

- macOS and Linux with Node 22 or newer. Native Windows is not supported; the
  path handling has known open issues. Windows Subsystem for Linux has not been
  part of our testing.
- Claude Code, Codex and Cursor are the hosts `connect` registers. Cursor is
  detected only when a `.cursor/` directory already exists. Other MCP hosts can
  point at `sannr mcp serve` by hand, but setup does not write their files.
- Claude Code needs a restart to load a new MCP registration. Until then the
  `api_request` tool is absent and the installed skills fall back to the CLI.
- The Workbench needs an interactive terminal for pairing. It does not run
  under a pipe, an agent's shell, unattended approval or a tunneled browser.

## Setup without a contract

- `connect` with no OpenAPI document in the repository creates no stack, and
  `note` refuses with `CONTEXT_UNAVAILABLE` until `stack add` or
  `start --contract` creates one. Before that first stack, the `doctor` config
  row still names `.sannr/config/api-environments.json`, which is the older
  single-store layout; you do not need that file. The generated `.sannr/README.md`
  lists the older paths until the first stack exists, then the stack paths.
- A stack without a contract can make requests and keeps private evidence, but
  shared capture is skipped (`CONTRACT_NOT_BOUND`): no response structure is
  promoted into the knowledge file, and the Workbench lists the operation as
  not recorded. Authored notes still work and are delivered to agents.
- Monorepos get one install at the root. Stacks separate APIs inside it, but
  nothing scopes a stack to a package folder yet.
- Cross-repository stack sharing is not supported. The older grant-based
  context reads across repositories remain an opt-in capability with their
  own [guide](dependency-graph.md).

## Protocols

- HTTP, GraphQL, JSON-RPC, gRPC and WebSocket, within each adapter's
  documented bounds in [protocols](protocols.md). The adapters are optional,
  pinned packages; a missing one is named with its install command.
- Not supported: generic server-sent events, incremental or multipart GraphQL
  HTTP results, GraphQL subscriptions over legacy subprotocols, JSON-RPC wire
  batches and notifications, an OpenRPC loader, gRPC reflection, and mutual
  TLS. Apollo GraphQL and Federation are planned.
- Protocol adapters do not retry or follow redirects. HTTP redirects follow the
  client's credential, body and method guards, and some are refused.

## Imports

- Inputs: Postman v2.1 JSON and v3 YAML, Insomnia v4 and v5 exports, Bruno
  files or directories, curl commands and OpenAPI documents.
- Collection scripts are never executed. Only recognized assertions translate;
  everything else is quarantined by name in the loss report, and requests
  without a usable assertion stay in the todo file. A successful import is not
  evidence that the API passed anything. Details in [imports](imports.md).
- Bruno pre-request and post-response scripts, settings and unsupported
  assertion forms are reported, not converted.

## Discovery and maps

- `map`, `survey` and `audit` find the source patterns they know. They can
  miss APIs and dependencies, a found endpoint is not necessarily live, and an
  empty inventory means nothing recognized was found, not that setup failed.
  Scanner limits are in [discovery](discovery.md).
- `doctor`'s default probe depends on GitHub's anonymous API, which allows 60
  requests per hour per IP address. On a shared network it can return 403; see
  [troubleshooting](troubleshooting.md).

## What the records can and cannot say

- A contract declaration, a recorded observation, an authored note and a
  passing assertion are kept apart on purpose. A note is what someone wrote;
  it is not verified by being stored. An observation is what one execution saw
  in one environment at one time.
- Freshness and provenance help an agent decide whether to reuse or re-check a
  fact. They do not make it true elsewhere or later.
- The `receipt` and feedback counts come from the local usage log: envelope
  sizes compared with raw response sizes, notes delivered, drift surfaced. They
  are not a measurement of session cost, time or accuracy, and Sannr makes no
  claim about how it compares with any other tool or convention.

## Workbench

- Local only: IPv4 loopback, ephemeral port, pairing code at the terminal,
  authority that expires after 15 idle minutes or 8 hours. Closing the terminal
  closes it.
- No secret store. Credentials come from the stack's environment source; the
  page shows reference names and readiness, never values.
- Native installers, import editing, suite and batch launch controls, surveys
  and in-flight recording are not in this release.

## Feedback

- `feedback --send` is the only path that contacts a Sannr service, and only
  after a human yes. The payload is capped at 32 KiB and 4,000 characters per
  answer, is anonymized, and cannot be redirected to another endpoint.
