# Protocol execution and shared context

Sannr can execute bounded GraphQL, JSON-RPC, gRPC and WebSocket operations through the same configured targets, authentication and evidence path as its HTTP client. The context extension identifies an operation by provider, environment, protocol, operation name, endpoint and contract digest. Different operations at one HTTP endpoint have separate identities.

Core startup, HTTP and MCP inspection load only Node. Protocol libraries are
optional dependencies, exact-pinned and hash-verified before use; the tarball
does not bundle them. GraphQL uses `graphql`, WebSocket uses `ws`, and gRPC uses
`@grpc/grpc-js`, `@grpc/proto-loader` and `protobufjs`. JSON-RPC needs no adapter
package. npm attempts optional packages by default; use `--omit=optional` when
installing the core alone. That option applies to all optional dependencies in
the npm install, not only this package's adapters.

When a requested adapter library is absent, the request refuses with
`PROTOCOL_PACKAGE_MISSING`, the package name and its exact install command with
`--ignore-scripts`. Install it in the same npm project as Sannr, then retry.
That install also attempts the other optional packages by npm's default rules.
Missing libraries do
not prevent unrelated core commands from running. Source contributors use
`npm ci --ignore-scripts --no-audit --no-fund` to install the locked adapters
before running the full fixture tests.

The hash catalog pins exact upstream artifacts for transitive libraries too.
A consumer's npm install resolves those libraries independently of the source
lockfile. Unexpected future transitive versions in the runtime graph, modified files and unpinned
optional peers refuse with `PROTOCOL_PACKAGE_INTEGRITY`; the client does not
silently trust them. A new transitive version needs maintainer review and a
package build with refreshed artifact hashes. Core commands remain usable
while that adapter is refused.
The reviewed protobuf dependency on `@types/node` and its `undici-types`
declarations is recorded separately: these packages contain declarations and
are not loaded by the adapter. Their versions do not gate runtime requests;
all files in the executable dependency graph remain hash-verified.

Run a JSON request file:

```sh
sannr protocol request.json --env local
```

The file contains one request, or a version 2 envelope with a `requests` array. Each request names its `protocol`: `http`, `graphql`, `jsonrpc`, `grpc` or `websocket`. `--env` selects the configured environment. Configure service authorities with `http` or `https` URLs in `.sannr/config/api-environments.json`; the WebSocket adapter converts them to `ws` or `wss`, and gRPC uses the corresponding insecure or TLS channel. `path` and optional `upstream` select an authorized target. Authentication belongs in the existing configuration/environment references.

The JSON may select a `stack` on a single request or on the batch envelope;
steps inherit the envelope selection and may select another stack explicitly.
No repository default is required when requests name their stack. An explicit
CLI `--stack` that disagrees with the envelope refuses with
`STACK_SELECTOR_CONFLICT`. `--env` overrides the envelope environment; a step's
explicit environment remains local to that step.

Response `data` and failed assertion details mask detected response credentials,
including aliases in projections. When masking changes the data actually shown,
`data_secrets: {"replacements": 2, "reveal": "reveal_secrets"}` counts the changed
string values and property names. The receipt follows the visible projection or
sample; clean data, omitted data and passing assertions with `data: null` carry
no receipt. Text from a provider that already looks like a mask is not counted.

Set `reveal_secrets: true` on the request, or on a batch envelope for its steps,
to reveal returned secrets in agent output. A step can override that with
`false`. Configured authentication values remain masked even with this flag;
the receipt counts those replacements too. Saved evidence remains masked.
Assertions and capture chaining still use the original response internally.
`reveal_captures` is a separate choice for exposing captured values. Saved suites
preserve the explicit setting through `suite run` and `verify`.

Recognized HTTPS upload URLs remain readable in agent output: AWS S3 and Google
Cloud Storage V4 signing tuples, their legacy access-id/signature forms, and
Azure SAS URLs with a version, expiry, permissions and resource scope. Only the
signing fields receive this presentation exception. Credentials in other query
parameters, URL userinfo, credential-named response fields and configured auth
values remain protected; ambiguous signing formats stay masked. Recognition does
not verify the signature or expiry. Evidence and the Workbench evidence inspector
continue masking signed URLs.

Output is JSON. A successful complete result exits zero; refusal, protocol errors, partial results and incomplete streams exit nonzero. `protocol.outcome`, `complete`, `attempts`, `sent`, `received` and `omissions` describe the observed execution. Transport/application outcomes and assertion results remain separate: a passing assertion on an error response does not turn a protocol failure into success.

Common `expect` assertions and top-level `fields` projection are supported. For the GraphQL, JSON-RPC, gRPC and WebSocket adapters, `timeout_ms` bounds an operation, from 1 to 300,000 milliseconds, subject to any tighter transport bound. The inherited default, including `API_TIMEOUT_MS`, is clamped to that range; an explicit out-of-range or non-integer `timeout_ms` refuses with `PROTOCOL_TIMEOUT_INVALID`. HTTP-only `method`, `body`, `body_type`, `files`, `save_to`, `paginate`, `wait_for`, `curl` and `idempotency_key` options are rejected on those requests. Use the nested protocol input instead. These adapters do not retry an operation or follow HTTP/WebSocket redirects.

Credential-named fields in GraphQL `variables`, JSON-RPC `params`, gRPC `body`/`messages`, and WebSocket `send` frames are refused with `CREDENTIAL_IN_REQUEST`, including nested fields. As with credential headers, they cannot be sent or saved in a suite; configure authentication using environment-variable references. Refusals do not retain payload values in output or evidence.

## HTTP body files and multipart metadata

For JSON and form bodies, an explicit `content-type` header wins over the
body-kind default. This includes a static header in the selected stack's
environment: a stack-level `content-type` overrides the form content-type
default too. A request header overrides the stack header. Encoding still follows
`body_type`, so a form body remains URL-encoded even when the header names a
different media type; remove or override a stale static header when changing
body kinds. Multipart boundaries remain generated by the client.

In batches and saved suites, single-brace `{name}` strings in bodies resolve
captured values. Double-brace templates such as `{{item.expected}}` stay literal,
including when a capture with that name exists. The same literal-template rule
applies to assertion values; request paths retain their strict placeholder
rules. A missing single-brace capture still refuses with
`UNRESOLVED_PLACEHOLDER`. Direct HTTP bodies are sent as supplied.

Multipart `files` accepts a local path or an object with `path`, optional
`contentType` and optional `filename`. Content type is inferred from the local
path's extension, case-insensitively, with `application/octet-stream` for an
unknown extension. An explicit content type wins. The default filename is the
path's basename; an explicit filename can include a directory:

```json
{
  "protocol": "http", "method": "POST", "path": "/uploads",
  "files": {
    "image": "fixtures/image.png",
    "document": {
      "path": "fixtures/instructions.md",
      "contentType": "text/markdown",
      "filename": "example/SKILL.md"
    }
  }
}
```

An HTTP body value can reference a file using the reserved `$file` object. This
works at any depth, including array entries and the whole body, for direct
requests, batches and saved suites. The object must contain only `$file`; its
descriptor requires `path` and `encoding` (`utf8` or `base64`), with an optional
literal `prefix`. Use `base64` and a prefix for a data URL:

```json
{
  "protocol": "http", "method": "POST", "path": "/images",
  "body": {
    "image_url": {
      "$file": {
        "path": "fixtures/image.png",
        "encoding": "base64",
        "prefix": "data:image/png;base64,"
      }
    }
  }
}
```

The CLI JSON envelope limit stays **1 MiB**. Body file sources are limited to
**16 MiB each**, with **32 MiB total** for the encoded replacement strings,
including prefixes. An over-limit expansion refuses with `BODY_FILE_LIMIT`
before sending. Invalid descriptors refuse with `BODY_FILE_INVALID`; invalid
UTF-8 refuses with `BODY_FILE_ENCODING_INVALID`. Files use literal paths,
relative to the calling working directory unless absolute. Captures cannot
select file paths or generate descriptors, and file contents are never
interpolated. `$file` is reserved in object bodies; JSON strings are not parsed
to discover references.

File reads happen after routing, production and authentication admission.
Both multipart and body file inputs require regular files and refuse a final
symbolic link or special file with `REQUEST_FILE_UNSAFE`; missing or unreadable
files return `REQUEST_FILE_UNREADABLE`. Parent-directory aliases retain normal
filesystem resolution. Multipart metadata errors return
`MULTIPART_FILE_INVALID`. Body file expansion is unavailable to protocol
adapters or feedback sends. The librarian refuses body/file inputs atomically;
`verify --read-only` skips steps with local file inputs and their dependent
capture steps. Saving a suite preserves references without reading file bytes.

## HTTP context capture

Agent-issued calls to repo APIs and integrations go through Sannr even for a
simple request or health check; see the [API call convention](api-call-policy.md).
HTTP responses within an explicitly configured primary or named upstream base record bounded
context by default when a unique applicable contract route supplies a safe
identity. Matching uses the actual origin and a segment-bounded base path.
The built-in localhost fallback and URLs outside the selected base prefix are
excluded from automatic capture. Named integrations bind their own local contract
in `.sannr/config/api-environments.json`:

```json
{
  "v": 1,
  "default": "staging",
  "environments": {
    "staging": { "baseUrl": "http://127.0.0.1:3000" }
  },
  "hosts": {
    "billing": {
      "baseUrl": "https://billing.example.test/v2",
      "contract": "./contracts/billing.openapi.json",
      "contractPathPrefix": "/v2",
      "auth": "bearer:BILLING_STAGING_TOKEN"
    }
  }
}
```

With a contract declaring `GET /devices/{deviceId}`, call the integration:

```json
{
  "method": "GET",
  "upstream": "billing",
  "path": "/devices/42",
  "expect": [{ "status": 200 }]
}
```

The identity is provider `https://billing.example.test/v2`, environment
`staging`, operation `GET /devices/{deviceId}`, endpoint
`https://billing.example.test/v2/devices/{deviceId}` and the SHA-256 digest of
the bound contract bytes. The literal request ID is not part of shared identity.
Contract paths resolve relative to the project root (the directory that holds
`.sannr/`), including when the client runs from another directory; a
configuration file kept outside that layout resolves them relative to its own
directory. Both primary environments and named hosts accept
`contractPathPrefix`. It defaults to empty;
omit it when contract operations already include the deployment mount (including
Swagger 2.0 `basePath`). Sannr does not infer a mount from OpenAPI `servers` URLs.
The configured base URL's own path is a declared mount: the client builds a
request URL as the base URL followed by the path. A contract is used as written
when any of its routes covers the base URL's path, compared segment by segment,
where a `{template}` segment matches any one segment: a route `/{tenant}/items`
covers base URL `https://api.example.test/acme`, so a request to `/items`
records operation `GET /{tenant}/items` with endpoint
`https://api.example.test/{tenant}/items`, and `/ex/jira/{cloudid}/rest/api/3/issue`
covers `https://api.example.test/ex/jira/abc`. When no route covers it (base URL
`https://api.example.test/api`, contract path `/v1/items`), the contract binds
below that path and a request to `/v1/items` records operation `GET /v1/items`
with endpoint `https://api.example.test/api/v1/items`. The decision is made once
per contract and base URL and is shared by capture, the undeclared-path drift
check and `show`, `view` and `map`; an explicit `contractPathPrefix` is never
combined with it. A contract with a templated first segment under a base URL
with a path (`/{version}/items` under `…/api`) is therefore used as written.
When a prefix is used, the HTTP `context_capture.mount` receipt names its
`pathPrefix` and source: `contractPathPrefix` for an explicit setting or
`base-url-path` for an inferred mount. `doctor --offline` reports that choice,
including `contract-routes` when the routes are used as written.

Unmatchable contract path keys are skipped individually by both inventory and
runtime matching. Query suffixes such as `/responses?beta=true` belong in query
parameter declarations; those keys do not erase the other operations.
The client reports `HTTP_CONTRACT_ROUTE_SKIPPED` at load time, and doctor lists
skipped keys, reasons and operation counts. Diagnostic path labels omit query
and fragment values. A contract with no matchable operations is rejected.
`HTTP_CONTEXT_ROUTE_UNRESOLVED` distinguishes a rejected or absent contract,
a prefix mismatch, an ambiguous match and an undeclared method/path; successful
HTTP responses and private evidence remain separate from shared capture.

Contract paths and request paths are compared in one form, each path segment
percent-decoded, so a contract path the URL parser encodes (`/v1/café`, `/v1/a^b`)
binds, and an agent's lowercase escapes (`/v1/caf%c3%a9`) bind the same operation.
An environment-level host entry replaces the complete top-level entry for that
name. Bind its contract explicitly; `API_CONTRACT` overrides only the primary API.

`capture_context: true` explicitly requests recording but cannot bypass the
safe route identity requirement. `capture_context: false` disables recording on an HTTP or
protocol request; `API_CONTEXT_OFF=1` disables it globally. These controls also
apply to individual `requests` entries. `context_capture` reports whether an
attempted recording succeeded; a recording failure does not rewrite the HTTP
response as a transport failure.

Identity binds the actual configured provider and environment, method, endpoint
and applicable contract digest. Only a unique matching operation from the actual
target's bound contract supplies a route template and digest. Missing, unreadable
or invalid bindings, unmatched or ambiguous routes, and primary base overrides without an explicitly supplied
contract return `context_capture.state: "limited"` with
`HTTP_CONTEXT_ROUTE_UNRESOLVED`. They do not commit a raw path or infer a route
from ID-looking segments. Private execution evidence remains available.

For a resolved named stack, `known.applicability` identifies `stack`, `provider`
(the configured base URL) and `environment`, with `basis: "resolved-stack-request"`.
This describes the request's routing scope; stack-wide authored notes do not
become environment-specific observations or verified facts. Scoped-only prior
observations carry the same identity when no authored note exists.

Legacy knowledge is delivered only for the configured primary API, with existing
freshness grading. Its provider and environment applicability remain explicitly
unknown because the legacy file did not record those identities. Named
integrations never receive the primary API's legacy notes by a path resemblance.

HTTP results also return bounded earlier observations in `known.scoped`, matched
to the configured provider, environment, operation, endpoint and contract digest.
The response being recorded is not included in its own earlier history. Retrieval
does not execute another request; missing, changed or unchecked evidence and
budget omissions remain explicit.

The current summary is `known.evidence_class` in a request and `evidence_class`
in `show`: written, observed, asserted or verified
by learn, with its date and reason. Stack totals expose `counts.evidence_classes`
using the same rules. A retained error response is observed, not successful;
only fresh passing assertion support can produce asserted. Missing/changed
local evidence and newer failed or incomplete observations cannot inherit an
older positive label. These fields describe execution support, not proof that
an authored explanation is true. Notes rank by supporting evidence and date
within their stack/operation groups; contradiction metadata never deletes them.

Resolved HTTP/OpenAPI requests may return `draft_notes` with local draft IDs
and original evidence references. Drafts use bounded generated wording, make no
extra request, and stay private until explicit `note --accept-draft`. See
[note history](note-history.md) for supported signals, repeated-error scope and
acceptance refusals. Other protocols keep their own contract semantics.

The compatibility field in `sannr show "GET /path"` reports `confidence: "observed"` when the newest eligible
response in the currently configured primary scope is a complete 2xx client
observation with matching evidence and no failed saved assertions. This is weaker
than `"verified"`: an unasserted response remains an unasserted observation.
`legacy_confidence` retains the older learning grade, including `"unverified"`.
Automatic capture does not populate legacy `verified_at`, `shape_hash`,
`status_codes` or `fields`; empty legacy fields do not mean no responses were
recorded. Existing legacy `"verified"` and `"suspect"` grades are preserved.

`observation_summary` surfaces the selected provider, environment, endpoint and
live contract digest, latest `observed_at` and response status, retained response
count, `observed_status_codes`, saved assertion outcomes, and matching evidence
references. `show --env <name>` selects an environment; `--human` renders the same
distinction for people. Inspection sends no requests and changes no knowledge.
Authored claims, incomplete responses, observations older than the configured
staleness horizon, future timestamps and missing, changed or unchecked evidence
are excluded from the eligible summary with named reasons. A newest non-2xx or
failed asserted response does not elevate an unverified operation to `"observed"`.
All client records tied at the newest timestamp must support that label; UUID
order cannot hide a simultaneous failure. Newer unavailable or incomplete
evidence cannot borrow a positive label from an older successful response.
Counts describe retained eligible responses, not lifetime request totals; omitted
records and evidence checks remain explicit. When the read bound leaves a matching
record out, `state` is `unavailable` with `unavailable_reason: "history beyond the
read bound"`, the words the API map uses, never `none`: the record left out could
hold a newer response.

The separate `scoped` history can include other stored providers, environments
and contracts. These identities stay labelled; their statuses are never merged
into the selected summary. Unbound or changed configuration does not borrow an
older identity. Inspect each observation's `observed_at`, `response_status`,
`response_shape`, assertions and evidence for the complete recorded account.
Adding a note or citing evidence does not verify an author's explanation.

Captured context includes bounded request/response structure, status, assertion
summaries, observed request attempts, pagination completion and project-local
evidence identities. Scalar values remain in private execution evidence. The
request structure lists query parameter names: those passed in `params` and
those written into the request path with `=` (`/items?a=1&b=2` records `a` and
`b`, typed as strings), never their values. A query component without `=`
(`?1696500000`, an opaque token, `?flag`) is a value, not a name, and is never
recorded. Every query name passes one filter before it is recorded: a name
written into the path passes the promotion boundary's field-name scan and the
store's own scans (a blank name, more than 128 characters, a control or format
character, secret-shaped text, or text that reads as a credential reference such
as `basic:abc`), and a structured `params` name passes the store's own scans. A
refused name is dropped and counted in the observation's omissions ("N query
names withheld by the secret and promotion scans"), so a capture never fails
because of a query name. A
complete response does not establish full collection traversal; an unasserted
response is not verified behavior. Passing assertions on an expected error
remain separate from the HTTP error outcome. Semantic lessons still require
an explicit scoped write.

This HTTP bridge records received responses; failures before a response use the
existing error path without a new shared observation. After a redirect, shared
capture requires the final provider's bound contract identity; intermediate
responses and redirected request structure are explicitly omitted. A redirect
between same-origin providers drops the source provider's request headers under
the same rules as a cross-origin hop and never attaches the destination's
configured credential automatically. Preserved bodies and writes cannot cross
provider scopes. Cookie jars are also isolated by provider, even when a server
sets a cookie with `Path=/` on an origin shared by several providers.
Path-declaration drift and the shared identity describe the final response
provider's contract. Pagination uses the final response URL and stops before a link
crosses provider scopes, reporting incomplete traversal. The read-only librarian
binding and `sannr verify` disable shared recording, including for HTTP batches.

## GraphQL

```json
{
  "protocol": "graphql",
  "path": "/graphql",
  "graphql": {
    "document": "query Device($id: ID!) { device(id: $id) { id label } }",
    "operationName": "Device",
    "variables": { "id": "device-1" },
    "schema": "schema.graphql"
  },
  "expect": [{ "json": "data.device.id", "equals": "device-1" }]
}
```

`document` is required. A document with several operations needs `operationName`; ambiguous, duplicate or missing selected operations are refused before dispatch. Queries are classified as reads and mutations as writes even though both use HTTP POST. Identity includes the selected operation and a hash of the printed document. Whitespace/comments and variable values do not create a new operation; different documents with the same name do.

`schema` is optional and must identify a project-local SDL or introspection JSON file. SDL, raw introspection and `{ "data": { "__schema": ... } }` are accepted. Absolute paths, escaping symlinks, unreadable files and oversized schemas are refused. With a schema, Sannr validates the request document and variables before sending. Without one it validates syntax and operation selection. This does not claim validation of every returned field against the selection/schema.

HTTP 200 with GraphQL `errors` is an application error. Data accompanied by errors is `partial`, with `ok: false`; the response may still be a complete protocol message. Incremental HTTP responses, multipart results and SSE are not supported by this adapter. Documents are limited to 256 KiB/10,000 parser tokens, expanded field depth 32 and 256 aliases (including repeated fragment spreads). Excess depth or aliases refuses with `GRAPHQL_DEPTH_LIMIT` or `GRAPHQL_ALIAS_LIMIT`; syntax nesting above 64 also refuses with `GRAPHQL_DEPTH_LIMIT`. Cyclic, missing or duplicate fragments refuse with `GRAPHQL_FRAGMENT_INVALID`. These checks apply with or without a schema. Schema files are limited to 2 MiB, JSON request payloads to 1 MiB and decoded HTTP responses to 8 MiB with structural bounds.

### Subscriptions

The `graphql` dispatcher selects `graphql-transport-ws` for a subscription document:

```json
{
  "protocol": "graphql",
  "path": "/graphql",
  "graphql": {
    "document": "subscription Changes { changed { id status } }",
    "operationName": "Changes"
  },
  "websocket": {
    "effect": "read",
    "until": { "json": "data.changed.status", "equals": "ready" },
    "max_messages": 20,
    "timeout_ms": 5000
  }
}
```

The adapter manages initialization, acknowledgement, subscription, ping/pong and completion messages. The optional `until` predicate applies to each `next.payload`. Otherwise the server must send the subscription's `complete` frame. Message counts include protocol control frames. Reaching a bound or losing the connection before the requested completion signal is incomplete. Raw `websocket.send` overrides and legacy subscription subprotocols are not supported.

Subscriptions and plain WebSockets share the stream policy: their effect defaults to `unknown`, so the production write boundary applies. Set `websocket.effect` to `read` for a declared read-only stream to observe it in production without a write flag. `write` and `unknown` are also accepted. The envelope labels this as `caller-declared-unverified`; successful execution does not verify the declaration.

Apollo GraphQL/Federation is an explicit fast follow **after launch**. This implementation covers standard GraphQL execution; it does not provide federation composition, supergraph/subgraph inspection or gateway-specific behavior.

## JSON-RPC 2.0

```json
{
  "protocol": "jsonrpc",
  "path": "/rpc",
  "rpc": {
    "method": "inventory.lookup",
    "params": { "id": "device-1" },
    "id": "lookup-1"
  }
}
```

The adapter sends one HTTP POST. `params` may be an object or array; omitted `params` stays omitted. `rpc.id` may be a string, safe integer or null; an omitted ID is generated. Response IDs must match in both type and value. A valid response contains exactly one of `result` or `error`; remote errors remain failures even on HTTP 200. Error diagnostics use fixed text while private execution evidence retains the scrubbed response.

Method effects remain `unknown`: a name such as `getThing` does not establish read-only behavior. The production write policy applies to unknown effects. JSON-RPC batches, notifications and a schema/OpenRPC loader are explicitly unsupported in this adapter. A Sannr request envelope can still sequence separate calls; it is not a JSON-RPC wire batch.

## gRPC

```json
{
  "protocol": "grpc",
  "path": "/",
  "grpc": {
    "proto": "proto/catalog.proto",
    "service": "demo.Catalog",
    "method": "GetDevice",
    "body": { "id": "device-1" }
  }
}
```

The service and method must be declared in the project-local proto descriptor. Unary and server-streaming requests use `grpc.body`; client-streaming and bidirectional methods use a bounded `grpc.messages` array. `grpc.max_messages` defaults to 25 and has a ceiling of 100. Request messages are checked against their declared types. Method identity and streaming mode come from the descriptor; effects default to `unknown`. `grpc.effect` accepts `read`, `write`, or `unknown` as a caller declaration, labeled `caller-declared-unverified`. Declared read-only methods and streams need no production write flag; the descriptor does not verify this declaration.

The result preserves gRPC status separately from HTTP status. A stream must terminate successfully to count as complete; collected messages before an error or limit do not establish full completion. Server reflection and mTLS configuration are not provided by this interface.

Configured credentials over plain `http:` gRPC to a non-loopback host refuse before dispatch with `GRPC_INSECURE_CREDENTIALS`. Use `https:` for TLS; credential-bearing local fixtures may use `localhost`, IPv4 loopback or `::1`.

## WebSocket JSON messages

```json
{
  "protocol": "websocket",
  "path": "/events",
  "websocket": {
    "operation": "device.events",
    "send": [{ "type": "subscribe", "channel": "devices" }],
    "until": { "json": "type", "equals": "ready" },
    "max_messages": 20,
    "timeout_ms": 5000
  }
}
```

Name the channel or message operation explicitly. Messages must be JSON. `effect` declares `read`, `write`, or `unknown` under the same policy as subscriptions above. `until` supports a JSON field path plus a primitive `equals` value or boolean `exists`; without it, normal server closure is the completion signal. Optional `subprotocols` advertises up to eight distinct protocol tokens. A message limit by itself is a bound, not a success predicate. Arbitrary binary message protocols require another adapter or external capture.

| WebSocket option | Default | Ceiling |
| --- | ---: | ---: |
| `timeout_ms` | 10,000 | 60,000 |
| `max_messages` | 32 | 1,000 |
| `max_frame_bytes` | 65,536 | 1,048,576 |
| `max_total_bytes` | 1,048,576 | 8,388,608 |

At most 32 initial messages and 64 total outbound/control messages are allowed. Shutdown is bounded. The same transport limits apply to GraphQL subscriptions.

## Capture context from another tool

Execution support and knowledge capture are separate. An external client can contribute an observation for another protocol without fabricating an HTTP operation or marking it client-verified:

```sh
sannr context capture observation.json
sannr context query query.json
```

Example `observation.json`:

```json
{
  "identity": {
    "provider": "inventory-api",
    "environment": "local",
    "protocol": "custom-rpc",
    "operation": "inventory.lookup",
    "endpoint": "http://127.0.0.1:9000/rpc",
    "contractDigest": null
  },
  "basis": "observed",
  "source": { "tool": "external-client" },
  "outcome": "success",
  "complete": true,
  "response": { "found": true },
  "evidence": [{ "path": "evidence/lookup.json", "locator": "/result" }],
  "omissions": ["One request observed; broader service behavior was not checked."]
}
```

The evidence file must already exist within the project. Sannr records its digest and optional JSON pointer, then rechecks file identity during bounded retrieval. A matching digest establishes artifact identity, not that the external tool's assertion is correct. External observations are marked `external-claim`; `basis` can also be `declared` or `authored`. Request/response scalar values are projected to bounded structural samples before committing context. Notes, provenance, assertion counts and omissions are retained separately.

Example `query.json`:

```json
{ "provider": "inventory-api", "environment": "local", "protocol": "custom-rpc" }
```

Query filters are exact and may include `provider`, `environment`, `protocol`, `operation`, `endpoint` and `contractDigest`. Queries read local records plus providers covered by existing directional grants. Use returned identities for precise retrieval. The default result budget is 20 operations/16,000 bytes; omissions and unavailable evidence checks are reported. A record that does not fit the room left is returned without its derived `key_sources` when that makes it fit, and the answer counts such records in `key_sources_omitted`; a record is omitted (counted in `omissions.operations`) only when it still does not fit. Room for `record_issues` is reserved before any record is placed, so the first damaged record is always named and the rest counted: a record that sits near the budget is omitted rather than trimming them out. Storage retains 20 observations per identity and supports up to 2,000 identities.

External context capture accepts at most 1 MiB of JSON input; internal protocol observations accept at most 16 MiB before projecting payload values to shapes. Additive context updates enforce a 16 MiB limit on the complete serialized `.sannr/<collection>/sannr.json`, including existing HTTP and MCP records. Snapshot writes, including `init` and `learn`, enforce the same limit when the file contains `api_context`. An update that exceeds that limit fails with `CONTEXT_CAPACITY_REACHED` and preserves the previous file.

The extension lives under `api_context` in `.sannr/<collection>/sannr.json`. Existing HTTP `operations` and MCP `mcp_inspections` remain intact. To associate an old HTTP record with a provider explicitly:

```json
{
  "bindings": [{
    "legacy_operation": "GET /devices",
    "identity": {
      "provider": "inventory-api",
      "environment": "local",
      "protocol": "http",
      "operation": "GET /devices",
      "endpoint": "http://127.0.0.1:9000/devices",
      "contractDigest": null
    }
  }]
}
```

Run `sannr context migrate bindings.json`. This records an explicit binding and preserves the original record; it neither executes the API nor invents missing verification. These capture/query/migrate commands require one regular JSON input file no larger than 1 MiB and perform no API requests.

## Path-key sources

After the client captures a 2xx HTTP response for an operation whose path or query carries parameters, it records which earlier response field supplied each parameter value: for `GET /things/{id}`, that `id` came from `data[].id` of `GET /things`. The link is stored on the operation's `api_context` record as `key_sources`; the value itself never is.

```json
"key_sources": [{
  "param": "id",
  "location": "path",
  "source": { "operation": "GET /things", "field": "data[].id" },
  "first_observed_at": "2026-10-05T18:54:38.385Z",
  "last_observed_at": "2026-10-05T18:54:38.385Z",
  "also_seen": 0,
  "evidence": { "run_id": "run-…", "digest": "sha256:…" }
}]
```

- The concrete request URL is read from the captured run's own private evidence. The capture examines at most the 256 newest run files written before its own, in any provider, environment or protocol, and searches the first 64 of them in the same provider and environment; evidence files over 2 MiB are skipped. A 300 ms budget starts before the evidence directory is listed and covers the listing, so a very large evidence directory makes capture-time linking give up within the budget; `context keys` fills that gap. Over budget, or any evidence read problem, records no link for that request; the request and its observation are unaffected. A request whose own evidence file exceeds 2 MiB is not linked.
- Evidence run files are written to a temporary name in the same directory and renamed into place, so a parallel request never reads a run file half written. A run file that exists but cannot be read stays a read problem.
- The source is the earliest earlier 2xx response that contained the value. A response is never a source for a value its own request carried anywhere: as part of a decoded path segment, of a query key or value, of a header name or value, or of a body key or scalar (the raw text when the body is not JSON). The rule is conservative on purpose: a coincidental substring can cost a true source, but a request is never recorded as its own source. `also_seen` counts the other (operation, field) pairs that contained it; `evidence` names the source response's run and digest.
- A query parameter links only to a field whose last name equals the parameter name (`timezone` from `data[].timezone`).
- Only eligible values link: strings of four or more characters that are not whitespace-padded, not a null token (`null`, `undefined`, `none`, `nil`, `n/a` in any case), not an ISO date or datetime (`2026-10`, `2026-10-05`, `2026-10-05T10:00:00Z`), not a complete calendar date written another way, not a boolean and not secret-shaped; and integers or digit strings of 1000 or more. By shape, a value is a date only when it is a complete calendar date with a four-digit year: `YYYY/MM/DD`, `MM/DD/YYYY`, `DD/MM/YYYY`, `DD.MM.YYYY` or `DD-MM-YYYY` with valid month and day ranges; an RFC 7231 HTTP date (including its obsolete RFC 850 and asctime forms) or an RFC 2822 date; or a month name written with a day and a four-digit year (`Oct 5, 2026`, `5 October 2026`, `05-Oct-2026`). A month abbreviation followed by digits (`DEC-7`, `MAY-1001`), a month name without a day (`May 2026`), a dotted version (`1.2.10`), a two-digit year (`3-4-26`), a year followed by a sequence (`2026-278`, including ISO ordinal dates) and ISO week forms (`2026-W41`) are not dates; nor are compact eight-digit dates, epoch numbers and years. All of these stay eligible by shape, because identifiers of those shapes exist; a contract that declares a date format excludes them. Unconstrained words such as `active` stay eligible: slugs and usernames are real identifiers, and a link records an equality, not a meaning. Values are compared in memory and never stored, logged, printed or placed in an error.
- The bound contract's own rules apply. A parameter whose schema declares `enum`, `const`, `type: boolean`, or `format: date`, `date-time` or `time` (directly, through `$ref`, in `allOf`/`oneOf`/`anyOf` members or in array items) is never linked. When the contract describes the response, a response field whose schema declares `enum`, `const` or one of those formats is never a source.
- `field` holds names only, at most 256 characters: array positions become `[]`, and an object key appears verbatim only when the bound contract declares it as a property name (from `properties` of schema nodes, never from `example`, `examples`, `default`, `enum` or `const`) or when it is word-shaped (letters, underscores and hyphens, no digits), passes the secret-name scan, is not the linked value and either sits in an object that is not a structural map or is a JSON:API name. A structural map is an object with two or more keys whose values are all objects with the same keys; an object whose values are all arrays is not one, so `{ "data": [...], "included": [...] }` records `data[].id` and `included[].id`. JSON:API names are kept wherever they appear: the members `data`, `included`, `meta`, `links`, `errors`, `jsonapi`, `id`, `type`, `attributes` and `relationships`, and every key directly inside an `attributes` or `relationships` object, so a relationship reads `data[].relationships.category.data.id`. Every other key becomes `{}`, so ids, hashes, dates and digit-bearing names (`U024BE7LH`, `address_line_2` unless declared) never enter the store. The limits of a shape rule, with no response schema in the contract: a map keyed by digit-free words (usernames) keeps those keys verbatim when it has a single entry, when its values are scalars, or when its values have different key sets; and the names JSON:API defines are trusted by name, so a map keyed by usernames directly inside `attributes` keeps them.
- A record keeps at most 16 entries and 2 sources per parameter, the most recent distinct; path entries are kept before query entries. A repeated link widens its observed dates; its latest observation supplies `also_seen` and `evidence`. Records without the field remain valid, and `context query` and `show` return it.
- `key_sources` is derived data, so damage to it never withdraws an observation. A list that fails validation (a value that is not an array, more entries than the bounds, a malformed date, location or digest, a secret-shaped name, or a name or operation the knowledge file's final secret scan refuses, such as a credential reference like `basic:abc`) is treated as absent: the record keeps every observation, `context query` and `show` name the record in `record_issues` as `{ "repository", "operation_id", "code": "KEY_SOURCES_INVALID" }` (separate from `issues`, which names an unavailable source), and the rest of the knowledge file stays readable. The next capture that derives links for that operation replaces the damaged list and says so in the request's `context_capture` (`"key_sources": { "replaced_damaged": true }`), and `context keys` replaces every damaged list. A capture that derives no links leaves a damaged list in place, still named. `view` and `map` read key sources through the same query, so the API map shows exactly the lists the store accepts and counts each damaged record in one line. A list's size never costs its record a place in a bounded answer either: a record that fits only without its list is returned without it and counted in `key_sources_omitted`.

To derive the same links from evidence recorded before this existed:

```sh
sannr context keys --dry-run
sannr context keys
```

`context keys` reads the local evidence directory chronologically (the newest 5,000 runs) and replays the capture window for each linkable request: the 256 run files recorded before it, of which the first 64 in scope, with the same size bound and the configured contracts' rules. It runs outside the request path, so the 300 ms budget does not apply. It records links on existing operation records. A request whose examined files include an unreadable one is not linked; the report counts it. A second run reports `unchanged` and leaves the knowledge file untouched. `--dry-run` writes nothing and `--json` prints the machine report; output holds names, operations, dates, counts and evidence identities only. A damaged `key_sources` list is replaced by the links derived from local evidence now; when none can be derived (for example on a clone without the evidence), the field is removed. The report counts these in `replaced_damaged` and the terminal summary says so in one line. Any other damage to the knowledge file is refused with `CONTEXT_INVALID`. It executes no API requests.

`API_CONTEXT_OFF=1` disables linking and evidence reads: capture records nothing, and `context keys` refuses with `CONTEXT_DISABLED` before it reads any evidence.

Context remains evidence with a stated scope. A completed request, a bounded subscription observation and an author's operational note carry different meanings; none establishes every behavior of an API.

## Batch captures and cleanup

Cleanup and capture-disclosure options require a `requests` batch; a single
request refuses them instead of silently ignoring them.

A `requests` envelope may include `finally`, an array of requests with the same
fields. Normal steps follow `on_failure` (default `stop`). Cleanup runs afterward
in order, including after assertion failures, input refusals within a step and
transport errors. A cleanup failure does not stop the remaining cleanup. Results
keep normal `results` separate from `finally`; overall `ok` requires both to
succeed. All steps' stack/environment routing is validated before any traffic.
The usual authentication, production-write and read-only restrictions apply to
cleanup too. No cleanup is invented or authorized by the client.

`capture` binds response JSON paths to request-local variables. Captured values
interpolate in later paths, parameters, headers, bodies and assertions. An exact
placeholder in an assertion preserves JSON type, including arrays and objects;
embedded placeholders remain text. An unresolved assertion placeholder refuses
that step before sending. A completed 2xx HTTP response can supply captures even
when its assertions fail, allowing `finally` to remove a created resource. A
non-2xx or redirected response cannot supply HTTP captures.

By default `captured` reports shapes such as
`{"fileId":{"type":"string","length":34}}`; string/array length and object key
count are reported, while scalar numbers, booleans and null report type only.
Captured values are withheld from all public step results, including concrete
paths, failed assertions and response projections. `reveal_captures: true` is
an explicit per-envelope opt-in to show values. Private evidence follows its
separate evidence policy; hiding a capture is not deletion of local evidence.

`left_behind` conservatively tracks nonempty string and finite numeric captures
from 2xx HTTP POST/PUT responses. Each entry names `created_by` (the request ID,
or its one-based position) and `capture`; a failed DELETE also supplies its
`delete_status`. Only a later 2xx DELETE that consumes that capture in its path, under the same
stack, environment and provider, can clear the entry. For a POST, its path must
be the creation collection path plus one encoded identifier segment; for PUT,
it must equal the creation target, containing that identifier as a segment.
A mention in a query or an unrelated DELETE path is not proof of cleanup.
Reusing a capture name for another create retains the earlier entry. Aliases for
the same identifier from one create retire together. Literal IDs, custom cleanup paths (including suffix-based routes such as `.json`),
unrelated same-valued captures, other protocols, uncaptured resources, external deletions
and asynchronous deletion completion cannot establish cleanup here. Review the
list as possible remaining resources, not a complete inventory of remote state.

Saved suites preserve `finally` and scan its requests for secrets like normal
steps. `suite run` and full `verify` execute it and report its assertions;
`verify --read-only` filters cleanup to GET/HEAD and skips dependencies on
captures from skipped writes. When no primary read remains, cleanup is also
named as skipped. The read-only librarian admits and scopes cleanup
under its existing GET/HEAD-only policy.
