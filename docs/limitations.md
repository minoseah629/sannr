# Known limitations

What Sannr does not do in this release, in one place, so you can tell a gap
from a bug. Bugs go to [GitHub Issues](https://github.com/sannrhq/sannr/issues);
see [SUPPORT.md](../SUPPORT.md).

## Platforms and hosts

- macOS, Linux and native Windows with Node 22 or newer. See
  [Windows](install.md#windows) for installation, what CI verifies there and
  NTFS permission limits: Windows file privacy relies on directory ACLs, which
  Node's POSIX mode bits do not describe. WSL is not required and has not been
  part of the testing. In PowerShell (the shell Codex uses),
  `./node_modules/.bin/sannr` can hit the `.ps1` launcher, which the default
  Windows client execution policy blocks; run
  `node .\node_modules\@sannr\sannr\bin\cli.mjs` or
  `.\node_modules\.bin\sannr.cmd` instead. Git Bash, which Claude Code uses,
  runs the `./node_modules/.bin/sannr` form as written. The optional
  `--claude-hook` checks only Claude Code's Bash tool, so on Windows it does
  not cover commands run through Claude Code's PowerShell tool.
- Not yet qualified on Windows. The full product suite, run on Windows through
  the manual `windows_full` CI dispatch, still reports failures outside the
  flows the Windows lanes verify on every change. Most are test-harness
  assumptions, but these product behaviors are known not to work there yet:
  `migrate` refuses an existing evidence directory because it checks for
  POSIX mode 0600, which NTFS does not report; relative paths from source
  scanning and some `connect` and `map` output use backslashes where the
  committed knowledge format expects forward slashes; and a migrated
  pre-layout registration can write an unescaped backslash into JSON. Treat
  stack migration and source-derived paths on Windows as unsupported until a
  release notes otherwise.
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
- A stack is shared across repositories by copying it with
  [`stack import`](stacks.md#import-a-stack-from-another-repository); there is
  no live link. It brings the contract, the active authored notes and the
  stack facts. Evidence references (only their count), learned response shapes, verification state, review decisions,
  superseded history and unattributed notes are not imported. An update never
  changes the local `stack.json` or contract, so a contract that changed in
  the source is reported and has to be replaced by hand. A Git source is
  fetched over `https`, `ssh` or `file` only; `--ref` with a commit ID works
  only where the server serves that commit. A local source more
  than two directories above the repository is recorded by directory name
  alone and can be imported once per name; a later import from it refuses
  and names `--as` rather than update. Contract files must end in `.json`,
  `.yaml` or `.yml`. Import provenance on a
  note imported a second time through an intermediate repository names the
  intermediate repository only. Clients older than this command read an
  imported stack but do not mark it. The older grant-based context reads
  across repositories remain an opt-in capability with their own
  [guide](dependency-graph.md).

## Protocols

- HTTP, GraphQL, JSON-RPC, gRPC and WebSocket, within each adapter's
  documented bounds in [protocols](protocols.md). The adapters are optional,
  pinned packages; a missing one is named with its install command.
- Not supported: generic server-sent events, incremental or multipart GraphQL
  HTTP results, GraphQL over GET, persisted queries, GraphQL multipart file
  uploads, GraphQL subscriptions over legacy subprotocols, JSON-RPC wire
  batches and notifications, an OpenRPC loader, gRPC reflection, and mutual
  TLS. Apollo GraphQL and Federation are planned.
- GraphQL schema files are supplied by you (SDL or introspection JSON in the
  project); Sannr does not fetch or write one, and does not validate returned
  fields against it. Protocol observations are kept under `api_context` and
  read with `context query --stack`; `show` and the Workbench list the notes
  on a GraphQL operation, not those observations.
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
