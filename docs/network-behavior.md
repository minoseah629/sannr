# Network behavior

Sannr stores API knowledge and execution evidence on your machine and in your
repo. No account. It sends us two things: one document a day of usage counts
with a random install identifier, on unless you turn it off (see below and
[telemetry](telemetry.md)), and feedback, which is optional and requires an
explicit send.
It is an API client: commands that execute requests contact the
selected APIs. Installation and MCP startup can also involve your package
manager. These are separate network paths.

## Setup and installation

- `connect` writes local instructions and MCP registration; it does not call your
  API or install another package. A registration may use the installed local
  package or an exact-version `npx` command. Starting that `npx` command can fetch
  the package if it is absent from npm's cache.
- Plain `doctor` prints its API request before sending it. With no configured
  API it requests GitHub's public `GET https://api.github.com/zen`. With a
  configured API it sends an unauthenticated HEAD to that base URL, with one GET
  fallback only on HEAD transport failure. `--probe <url>` selects a GET target.
  These probes send no configured credentials, follow no redirects, make no
  retries and perform no OAuth grants. Evidence stays local, separate from
  shared API contract knowledge.
- `doctor --offline` skips the API probe and starts no daily usage send. It still checks the registered MCP
  process. Running the CLI or that process through `npx` can involve npm; the flag
  is not a network sandbox for npm or an arbitrary registered executable.
- `npm`/`npx` use the registry, proxies and cache configured for npm. npm normally
  attempts the package's optional GraphQL, WebSocket and gRPC dependencies too.
  Use `--omit=optional` for the core-only installation. Protocol adapters are
  pinned and checked before loading; a missing adapter produces an installation
  instruction, not an automatic runtime download. See [protocols](protocols.md).

## API requests you select

Requests use the chosen environment, `API_BASE_URL`, named upstreams or an
allowed absolute URL. Their hosts can be any APIs you configure; a fixed list
of strings in this package cannot enumerate those destinations. The underlying
unconfigured client fallback is loopback `http://127.0.0.1:8000`; doctor does not
probe that implicit fallback.

HTTP requests can follow redirects under the client's credential, body, method
and production guards. Cross-provider credentials are removed; some redirects
are refused. Requested pagination stays inside the same origin/provider scope.
Retries can create additional attempts. If you configure OAuth, the client may
send a grant to `API_OAUTH_TOKEN_URL` or the host's `tokenUrl`; token-endpoint
redirects are refused. These ordinary request behaviors differ from the bounded
onboarding probe above.

GraphQL and JSON-RPC send requests to configured HTTP endpoints. WebSocket and
GraphQL subscriptions use the selected authority as WS/WSS; gRPC uses the
configured authority as its channel. No Clerk, Stripe or other service vendor is
an automatic target. Remote MCP inspection/execution contacts the URL you
select; stdio MCP starts the executable you select, whose behavior is outside
Sannr's own request inventory.

`learn` executes eligible reads. `map` and `view` do no API network I/O by
default. Their `--execute` option announces a bounded plan before sending
GET/HEAD requests through the client with each stack's own environment, auth,
headers and evidence. These probes do not retry, follow redirects, acquire OAuth
tokens or substitute inferred identifiers; omitted operations are named in the
plan. Use an explicit `request` for those cases. `--no-execute` forces the static
behavior. `audit` and `check` can execute probes; use their documented static
options for local analysis. Running a saved suite can execute writes if
those steps are authorized. Reading saved context, writing notes, generating a
static view and importing a local collection do not execute the collection's APIs.
See the [API call policy](api-call-policy.md) and [agent guide](agent-guide.md).

## Importing a stack

`stack import <source>` sends no request to any API, including with `--dry-run`
and when it updates a stack imported earlier. It reads the source's files and
never uses the base URLs or credentials they name. A local path involves no
network. For a Git URL the only network use is your own `git`: Sannr prints
`git fetch --depth 1 --no-tags -- <url> <ref>` on stderr, then runs it into a
temporary bare repository and removes that directory when the command ends
or is interrupted. Nothing is checked out, so no hook, filter or LFS download
runs. `git` uses the transport, proxy and credentials you have configured for
it, but not `GIT_DIR`, `GIT_WORK_TREE`, `GIT_CONFIG_*` or other variables that
would point it at another repository; Sannr downloads no archive itself. Only `https`, `ssh` and `file` URLs are fetched,
and a URL carrying a password, query or fragment is refused. See
[stacks](stacks.md#import-a-stack-from-another-repository).

## Explicit Postman capture

`postman capture` is an intentional migration feature. It contacts
`https://api.getpostman.com` only when you run that command, using
`POSTMAN_API_KEY` from the process environment. It reads the current account,
workspaces, collections and environments with allowlisted GETs. The default
budget is 100 requests including retries; each endpoint permits up to two
retries for throttling or an empty successful body. Redirects are refused.
Environment values and recognized secrets are scrubbed from the local capture.
Review that capture before sharing it. Programmatic callers can supply a
replacement `baseUrl`; the CLI uses the documented Postman root.

Importing an already-exported Postman, Bruno or Insomnia collection is local and
does not contact Postman. See [imports](imports.md).

## Daily usage counts

Once the one-time notice has been printed on a machine and 24 hours have passed,
the next command (or the MCP server) sends at most one document per UTC day by
this machine's clock from each state directory:
`POST https://sannr.dev/api/v1/usage` with `content-type: application/json`, a
user agent of the product name and version (plus Node's standard request
headers), no cookie or authorization, no redirect followed and a five-second
timeout. The destination is a constant in `lib/brand.mjs`. Sannr offers no
setting, configuration file or proxy variable that changes it, and removes
proxy variables from the sending process; code loaded into Node itself (for
example through `NODE_OPTIONS=--import`) can intercept it, as it can any
request. Cloudflare serves the endpoint; the request reveals the sending
address and the time, beside the install identifier.
The body is exactly [`lib/usage.schema.json`](../lib/usage.schema.json): a
random install identifier, the version, operating system and processor family,
Node major version, the previous send date, counts per fixed command name and
the number of API calls, at most 2,048 bytes. The exact bytes are written to
`~/.sannr/telemetry/sent/` before the request. A separate detached process
sends it, so no command waits for the network or changes its output or exit
code because of it; a failed send is retried by a later command, at most three
attempts a day.

Nothing is counted or sent with `SANNR_TELEMETRY=0`, `DO_NOT_TRACK=1`, in a CI
environment, in a process a test runner marks (`NODE_TEST_CONTEXT`, `VITEST`,
`JEST_WORKER_ID`), from a source tree of Sannr (with or without `.git`), in a
process whose environment names no home directory (`HOME`, or `USERPROFILE`
on Windows, missing or empty), in a `--dry-run`, before the notice, or after
`telemetry off`, which until `telemetry on` holds for every process run with
the same home directory while `~/.sannr` keeps its marker, and for every state
directory on that home's list even if `~/.sannr` is later lost, and sends nothing (a document that was being prepared or was
already on its way may still go out within a few seconds). A command run with `--offline`
starts no send. `telemetry show` prints the exact next document. See
[telemetry](telemetry.md).

## Reports, links and audit evidence

`feedback` collects a local report without sending it. `feedback --send` uses
the packaged `sannr-feedback` stack to POST to
`https://sannr.dev/api/v1/feedback`. It forces anonymization and scans the body
for credentials, private identifiers, paths and other URLs. The default
`feedback.send: ask` requires the human's yes in the current session;
`--confirm-send` records that confirmation. An explicit `allow` setting permits
a send after disclosure; `never` refuses it, including when set through
`SANNR_FEEDBACK_SEND=never`.

The exact JSON bytes are written privately before any network request. The
client refuses a second attempt within 30 seconds and follows no redirects or
retries. It does not fetch the public schema automatically. Server responses
must match the shipped fixed shape before any response fields reach the agent.
See [feedback](feedback.md) for settings, receipt paths and the explicit schema
read. Nothing in connect, doctor, map, or ordinary API execution sends feedback.

The clickable map preview serves one generated HTML snapshot on a temporary
`127.0.0.1` listener with a random port/path and a maximum 30-minute lifetime.
The report is self-contained. Documentation links and graph repository links
can be opened by the reader's browser; source comments, XML namespace URLs and
reserved parsing bases are not fetched by the client.

Release checks scan the URL literals in npm's actual candidate file list and
classify each one: onboarding and runtime controls, explicit integrations,
loopback preview and defaults, parser sentinels, documentation, examples and
license or schema identifiers. Example hosts use reserved `.test` names.
Vendor-name recognition in the client is parsing logic, not a network
destination. Neither that scan nor the categories above is a destination
allowlist: configured targets, OAuth endpoints, redirects, protocol channels,
MCP executables and npm resolution can introduce destinations without fixed
URL strings in this package. See [privacy](privacy.md) for the same material
by trigger.
