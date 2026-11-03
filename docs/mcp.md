# MCP inspection

`sannr mcp inspect` enumerates and records by default; it executes no tool without
a per-tool `--execute <tool>` opt-in. `readOnlyHint` is a **claim the server makes**,
recorded as claimed and never trusted as proof of safety. Execution also requires
that claim or an explicit `--execute-unsafe` override. Credentials are environment
references only. Server command lines and URLs with userinfo are never stored or
printed; URI userinfo is redacted. Every stored string is bounded and secret-scanned.

## Sannr's registered server

`connect` registers Sannr's API client for the detected coding hosts. An npx or global npm
installation uses an exact-version npx command ending in `sannr mcp serve`,
with install scripts disabled. Setup uses stable Node/npx aliases and includes
the Node directory in the registration's PATH where available; otherwise the
host needs Node and npx on its own PATH. The
registration pins the installed version, so publishing a newer version does
not change it; after a cache prune, npx may download that same version again.
It does not retain an absolute `_npx` cache path to `server.mjs`.
A real repository-local installation keeps its local `server.mjs` and stable
Node launcher, so it can start without an npm download.

`mcp serve` starts the stdio server used by that registration. It emits MCP
messages, without an install banner. Project paths and setup binding come from
the registration's environment. Use [install](install.md) for older
Node or cached-server registrations and for host activation checks.

### Workbench presence and handoff

The ordinary writable binding exposes `api_workbench` for explicit `attach`,
`status`, `read`, `ack` and `detach`. Read-only librarian bindings do not expose
this tool; browser controls cannot widen their permissions. `sannr workbench`
launches independently in an interactive terminal and works without an attached
agent. `attach` optionally writes a presence record for this MCP peer, using the
host name from `clientInfo`, a task label and a periodically refreshed heartbeat.
It is not a verified model or conversation identity. `detach` or stdin closure
removes that presence; neither closes the terminal-owned workbench.

Operator changes wait in the repository's durable local inbox, grouped by the
operator launch ID. `status`, `read` and `ack` work without attaching presence.
The agent explicitly reads and acknowledges relevant pages; acknowledgment means
received, not completed. Pending notices accompany ordinary tool results without
changing their primary API result. No host ping, sampling, elicitation,
native-channel extension, remote callback or automatic model wake is used.

See [the workbench workflow](workbench.md). After replacing an installed server,
restart the host and confirm `api_workbench` is actually listed before using its
presence or handoff actions. Its absence does not prevent terminal launch.

### Rotating credentials

For HTTP Basic authentication, configure `basic:USER_ENV:PASS_ENV` and supply
both environment variables locally. Neither value belongs in registration
files or shared context. The tool description reports local authentication
configuration, not successful authentication with the API; credentials are
checked at dispatch and missing Basic credentials refuse without a request.

The running server re-reads credential files before applying authentication.
Replace a token in the selected environment's `envFile`; the next request uses
the new value without restarting MCP.
Writing a replacement file and renaming it over the old file avoids reading a
partially written token. Removing a variable, deleting the file, or making it
unreadable withdraws its value; the server does not keep sending the startup
token. HTTP may then report missing credentials and the API's unauthenticated
response. OAuth cannot reuse its cached grant when its credential set changes.

An explicitly inherited environment variable takes precedence over files. If
the MCP host supplies the token itself, update its environment and restart the
server. These files contain secrets and should stay local and outside version
control.

In the legacy layout, a named host's own `envFile` replaces the primary
environment's file; a host without one uses the primary file. `API_ENV_FILE`
fills missing keys in either case. Other hosts' files never supply that request's
credentials, even if they use the same variable name.

OAuth's file-based token endpoint and scope follow that same provider boundary.
A missing endpoint is reported as missing; another host's file cannot supply
it. Explicit `tokenUrl` and `scope` settings retain precedence; otherwise
inherited variables override the provider's file values.

Explicit stacks use only their selected environment's `envFile`;
`API_ENV_FILE` and other stacks' files do not supply their credentials. Stacks
resolve current configuration on every call, including configured base URLs,
auth references and environment selection. The tool description's stack list
is a startup inventory; restart to refresh that description, not to apply a
stack configuration change.

For the legacy layout, credential-file values refresh, including OAuth's
file-based endpoint and scope. Changes to configured API base URLs, auth reference
names, selected environments or other server configuration still require a restart.
Requests using file-backed authentication are dispatched separately so an
overlapping call cannot reuse a response made with an older token.

## Read the report

```sh
sannr mcp inspect node server.mjs
sannr mcp inspect node server.mjs --label local-integration --json
sannr mcp inspect node server.mjs --summary mcp-summary.md
```

The report starts with the name and version supplied by `initialize`, the selected
protocol version, transport, server capabilities, and bounded server instructions.
Instructions are reported as server-provided content. A server without a name is
explicitly reported as **identity unavailable** and recorded with `server.name: null`.
The label defaults to the server name; `--label` supplies an integrator's stable
name for an installation. It never defaults to the command or endpoint URL.

Each tool has one row: its name, all four annotation hints expressed as claims,
required and optional input field names and declared types, and whether an
`outputSchema` is declared. For example, `claims read-only` describes the server's
annotation. A false annotation says `claims not read-only`; an omitted annotation
says `no read-only claim`. The same distinction applies to destructive,
idempotent, and open-world hints. Schema examples, defaults, and enum values are
not input field values and do not appear in the report. A field without a declared
type is `unspecified`; alternative field types are shown when declared. Required
inputs refer to the schema's explicit `required` list, rather than guessing which
conditional branch an eventual call will select.

Resources list their URI or URI template and MIME type. Prompts list their names
and argument names, marked required or optional. A capability the server does not
declare is not called: the report says `Resources: not declared by this server`
(likewise for tools and prompts), and the record stores
`declared.resources: {state: "not_declared"}`. Failed enumeration calls for a
declared capability appear as `List failed: tools/list`, `resources/list`,
`resources/templates/list`, or
`prompts/list`, with the returned error. A failed list is not a successful empty
list. `malformed_frames` counts invalid server frames. A server that never answers
initialization fails as `MCP_NOT_INITIALIZED`.

`--json` emits one JSON document containing the same record, declarations,
observations, and diff. `--summary <path>` writes the report's GFM tables using the
same `summaryCell` escaper as CI summaries, including escaping pipes, HTML, and
Markdown supplied by a server. Both flags can be used together.
Summary destinations may be outside the project, but must not replace the context
file or follow a symlink or hardlink. An unsafe destination is refused before the
inspection starts with `MCP_SUMMARY_UNSAFE_PATH`.

## Inspect again to see what changed

```sh
sannr mcp inspect node server.mjs --label local-integration
sannr mcp inspect node server.mjs --label local-integration
```

The second inspection matches the previous record by server label/name and prints
`since <previous at>`. It names added, removed, and changed tools, resources, and
prompts. A changed tool says what changed: for example, its description, a required
field added or removed, a hint flipped, or an output schema appearing. An unchanged
server prints `since <previous at>: no declaration changes`.

When a current or previous list failed, its comparison is explicitly unavailable;
the diff does not infer additions, removals, or stability from missing evidence.
The report marks that comparison incomplete. Changes to server metadata,
capabilities, and instructions are named as well.
Undeclared lists have no comparison and produce no failure noise. Introducing or
removing a capability is a declaration change, including an empty declared list.

The JSON report includes `diff` as data; `diff_from` points to the preceding
record's `at` timestamp. The inspector shows you once; sannr remembers. Keep a
consistent `--label` when comparing the same installation, and use distinct labels
for installations you want to track independently.

## Opt in to a tool call with arguments

For a server declaring a `lookup` tool with a required string field `id`:

```sh
sannr mcp inspect node integration-server.mjs \
  --execute lookup --args 'lookup={"id":"example-id"}'
```

Repeat `--execute` and `--args` for distinct tools. `--args` alone authorizes no
execution. Each argument payload must be a JSON object. Before calling, the
inspector checks the declared input schema, including required fields, primitive
types, `enum` membership, `const` equality, inclusive `minimum`/`maximum`, Unicode
code-point `minLength`/`maxLength`, `pattern`, and primitive array `items`.
Patterns use the same ReDoS guard as assertions; unsafe patterns are refused by
keyword and field name before compilation. Patterns are limited to 200 characters:
quantified groups, backreferences, lookaround and multiple variable repetitions
are unsupported. Generated literal substring checks remain supported. Pattern
inputs are limited to 4,096 characters; longer inputs fail with a named limit.
An invalid field produces
`MCP_ARGS_INVALID` naming the field, never its supplied value, and makes no
call. The validator is deliberately bounded; a declaration it cannot validate is
refused with the same named error rather than assumed valid. `--execute-unsafe`
overrides the missing read-only claim; it does not override argument validation.
Unsupported constraints are refused even on an unused optional field, with the
keyword named: `unsupported schema keyword: oneOf at 'query'`. The server
may still reject an otherwise valid call. Prefer credentials configured in the
server's environment. A `$NAME` or `${NAME}` credential reference in an argument
is sent literally; the inspector does not resolve environment variables into
argument values. Credential-named fields refuse literal credential values.

Argument values never enter the record or report. Promotion preserves field names
and types plus constraint names, consistently with earlier inspections; enum
members, const values, patterns, examples, and defaults are omitted. The original
schema is used in memory for validation. For an executed tool with an output
schema, `observed` records
`matches_output_schema` (`true`, `false`, or `null`), missing and unexpected field
names, and `result_kind` (`structured`, `text`, or `error`). This compares the
declared output with the measured shape, without recording result values. Without
an output schema, the bounded observed field names and types are the measured
shape. A text or error response is identified as such rather than treated as proof
that a declared structured output matched.

## Stdio and Streamable HTTP

One session covers the entire inspection: `initialize`,
`notifications/initialized`, declaration lists, and each opted-in tool call. The
stdio process is not restarted between tools.

```sh
sannr mcp inspect http://127.0.0.1:3000/mcp --label local-http
```

Streamable HTTP uses POST and accepts JSON or `text/event-stream` responses. The
`Mcp-Session-Id` header returned by `initialize` is echoed on subsequent requests.
SSE `data:` frames are parsed as JSON-RPC messages; multiple frames and messages
split across network chunks are supported. Responses are limited to 1 MB and each
request has a timeout. The in-repository HTTP fixture exercises both the session
header and SSE framing without contacting a remote service. The session identifier
is transport state and is not stored in the inspection record.

## What is remembered

The `mcp_inspections` array in `.sannr/<collection>/sannr.json` keeps the last 20 inspections **per server**.
Pruning is by count only: there is no age-based deletion. Each new inspection
appends a record; retained records are never rewritten. Legacy records without an
identity remain distinguishable as identity-unavailable records.

Stored facts include the timestamp, server identity and label, transport,
initialization metadata, bounded declarations, list errors, malformed-frame count,
safe observed shapes from opted-in calls, and the diff pointer/data. String content
is capped at 200 characters; collections and nesting are bounded as well. Never
stored: the server command line, endpoint target, URI userinfo, literal credentials,
tool argument values, response values, or schema example/default/enum values.
Credential-shaped content is refused or withheld; only sanitized declarations and
measured shapes cross the storage boundary.

## Inspect the servers this repository registers

```sh
sannr mcp inspect --dry-run
sannr mcp inspect
sannr mcp inspect --only sannr
```

With no command or URL, sannr reads project registrations from `.mcp.json`
(Claude Code), `.codex/config.toml` (Codex), `.cursor/mcp.json` (Cursor), and
`.vscode/mcp.json` (VS Code). It inspects each registration using its command,
argument order, and environment overrides. It does not search user-wide host
configuration. The registration key becomes the record's label. Environment
values are supplied to the child process; they and command lines never enter
the record or report. Relative commands and arguments resolve from the project
unless the registration supplies a working directory.

`--only <key>` selects that key across project hosts. `--dry-run` lists the
registrations and named coverage gaps without starting a server or writing a
record. A missing executable is reported under its registration key with a
named reason. Disabled, unsupported, or invalid registrations are also visible;
none is silently treated as a successful inspection. Registered discovery accepts
stdio commands; URL-only registrations receive a named unsupported gap.
Enumeration still executes zero tools. Use the explicit command form for
per-tool execution opt-ins. Summary destinations cannot overwrite any of the
four registration files.

## Deliver inspected declarations to agents

```sh
sannr mcp inspect
sannr connect
sannr show api_request
```

`connect` and `learn --agents` place an **MCP servers this repo registers**
section in the managed pointer block in agent instruction files. The section
uses the latest stored inspection for each registered label and preserves the
existing facts-led workflow and HTTP context ordering. It delivers the server's
name and version, tool names, annotation hints expressed as server claims,
required input field names, and the last inspection's meaningful declaration diff.
Servers with the same name, version, and canonical tool-declaration digest share
one entry with a `registered as:` list of registration keys and hosts. Inspection
records and histories remain per registration key. Unknown identities and failed
tool lists cannot establish equivalence and are kept separate in delivery.
New inspections retain a SHA-256 digest of the full declarations before schema
projection, so different enum members cannot collapse into one identity. The
digest preserves no argument or declaration values. Legacy records without this
digest can only be grouped by their retained declaration facts, separately from
records with the full digest.
If the digest changes while the retained fields remain equal, the diff explicitly
says `tool declarations changed (details not retained)`.
It reads remembered declarations; generating the block does not spawn a server.

The named `MAX_INLINE_MCP_TOOLS` bound counts unique tools after server grouping,
so four hosts registering the same declarations spend the budget once. Omitted
declarations are counted. Server-supplied text is bounded, secret-scanned, and
rendered with the pointer's own escaping: pipes and newlines cannot break a cell;
server, tool, and field identifiers remain literal inside backticks, including
`api_request`. Code-span delimiters accommodate backticks in a name. The CI
summary escaper stays on the summary surface. `Last diff since …` appears only
when declarations changed, for example `1 tool added (new_tool)` or
`required inputs changed on lookup (added: tenant_id)`. Unchanged declarations
and unavailable comparisons add no diff line; declared list failures remain
separate coverage gaps in the block, inspector report, and record. A record with
`server.name: null` appears
under its registration label with the identity gap stated. A read-only claim
still establishes neither observed behavior nor permission to execute a tool.

`show <tool-name>` returns the inspected declaration and its provenance, just as
`show` exposes an HTTP operation's remembered knowledge. Its JSON names are
verbatim, without Markdown entity escaping. Equivalent host registrations do
not make a tool ambiguous; distinct server identities still require a qualified
`<registration>/<tool>` lookup. When a request targets
an inspected tool name, the MCP server's response includes that declaration in
its `known` facts. This delivery describes the declaration; it does not turn an
HTTP request into an MCP tool call or assert that the inspected tool was executed.

An MCP server outlives the files it reads, so every request answers from the
knowledge file and the contract **as they stand on disk at that moment**. A note
recorded a second ago rides the next response rather than the next session's,
and a contract edited since the last learn grades its operations `suspect` here
exactly as `show`, `audit` and `view` already do — one claim, one answer, on
every surface. Each lookup costs one stat of each file; a re-read and a re-hash
happen only when that stat says the file changed. `API_CONTEXT_OFF=1` reads
neither file at all.

Legacy operation-note delivery uses the same active/history projection as
`show`, managed pointers and exports. Authored supersession preserves the
original claim but removes it from default guidance. Changed or malformed
history remains visible with integrity issues instead of silently hiding text.
New private evidence records its internal initiating path: `mcp.api_request`
differs from `cli.learn` even though both use the API client. An attached evidence
digest does not verify a note's explanation. See [note history](note-history.md).

## Check declaration drift in CI

```sh
sannr mcp inspect
git add .sannr/
git commit -m "Record MCP declarations"
sannr audit . --ci --no-execute --report-only --summary mcp-ci.md
sannr audit . --ci --no-execute
```

For registered servers with records in the committed `HEAD` version of
`.sannr/<collection>/sannr.json`, `audit --ci` starts an enumeration-only inspection and compares its
declarations with the latest committed record for that label. Working-tree
edits to the record cannot silently accept drift. The witness reports added,
removed, and changed tools, including flipped annotation claims and changed
required input fields. It never writes a replacement inspection record.

MCP findings participate in the existing report-only and enforcing CI modes.
`--report-only` returns exit 0 for declaration drift; enforcing mode returns
exit 1. The workflow installed by `connect --ci` remains report-only until its
owner enables enforcement. The CI summary renders the MCP witness through the
same `summaryCell` escaper as HTTP findings.

A server that cannot be spawned is a named coverage gap, not a drift failure.
Unavailable tool lists are also coverage gaps: missing evidence cannot prove
that tools were removed. `--no-execute` disables HTTP probing; the MCP witness
still enumerates registered servers and executes zero tools. Review a fresh
local inspection and commit it when accepting a declaration change; the gate
only checks the committed evidence.

## Validation modes

`SANNR_STRESS_LOCAL=1 npm run test:stress` is an offline fixture check. Its first
output line is:

```text
LOCAL MODE — not the stress gate; run `npm run test:stress` unset before committing
```

Run the real stress gate with `SANNR_STRESS_LOCAL` unset before committing.
`npm run check` clears that variable
for all its gates, so an inherited local-mode setting cannot skip the public
stress matrix. Regression tests for inspector behavior use in-repo fixtures.

## Worked example: sannr inspects sannr

Run from a checkout:

```sh
sannr mcp inspect node server.mjs
sannr mcp inspect node server.mjs
```

The current server announces `sannr` at the package's own version, protocol `2025-11-25`, and
the `tools` capability. Its one tool, `api_request`, **claims not read-only**,
**claims destructive**, **claims not idempotent**, and **claims open-world**.
Enumeration executes zero tool calls.
Resources and prompts are not declared by this server; they are recorded as
`not_declared` and do not produce failed-list or repeated-diff noise.

The current checked-in contract has **29 input fields**. The inspector reports
the complete declaration, including the protocol adapters and HTTP context capture controls:

| Input field | Declared type |
| --- | --- |
| v | integer (2; omitted means current envelope version) |
| protocol | string |
| graphql | object |
| rpc | object |
| grpc | object |
| websocket | object |
| timeout_ms | integer |
| capture_context | boolean |
| curl | string |
| method | string |
| stack | string |
| environment | string |
| path | string |
| upstream | string |
| params | object |
| body | unspecified |
| fields | array |
| headers | object |
| body_type | string |
| files | object |
| save_to | string |
| idempotency_key | string |
| paginate | unspecified |
| expect | array |
| requests | array |
| finally | array (batch cleanup requests) |
| reveal_captures | boolean (batch value disclosure; default false) |
| reveal_secrets | boolean (response-body disclosure; default false; evidence stays masked) |
| on_failure | string |

If response masking changes visible `data`, `data_secrets` names the replacement
count and the `reveal_secrets` option. The count covers the shown values and keys,
including configured-auth redactions, rather than hidden or omitted fields.
Configured authentication and evidence always stay masked. Recognized AWS,
Google and Azure signed upload URLs remain usable in agent output; see
[response disclosure and signing formats](protocols.md#protocol-execution-and-shared-context).

There is no unconditional `required` list: the server's `anyOf` requires one of
`path`, `curl`, or `requests`. Supplying `finally` or `reveal_captures` also
requires `requests`; those fields are not single-request options. It declares
no output schema. The server does not
implement resource or prompt listing, so those lists report JSON-RPC `-32601`,
`Method not found`. On the second run, the report links to the first record and
prints `since <previous at>: no comparable declaration changes; comparison incomplete`.
It explicitly names the unavailable resource and prompt comparisons; the unchanged
tool declaration remains comparable.

## Named stack selection

For repositories using [API stacks](stacks.md), `api_request` accepts `stack` and
`environment`. Each call resolves current configuration, credentials, contracts
and private evidence inside that stack. `upstream` remains a named compatibility
alias for one release. New registrations do not pin API_ENV, API_CONFIG or
API_CONTRACT. Stack names in the tool description are a startup inventory;
routing reads updated files on each call. Knowledge remains in the repository.

`api_note_context` reads active operation notes with the Workbench closed:
provide `operation`, optional `stack`, and optional `max_bytes` (512–1048576).
Its `note_context.records` includes current review labels, basis/source and
author categories. Disputed notes remain; retirement records identify the old
claim and reason. Missing private runs do not erase saved reviews. The tool
executes no requests and is available in read-only bindings; `API_CONTEXT_OFF=1`
disables it. `api_request` also pairs delivered notes with compact review data,
retaining labels when other note metadata is compacted under budget pressure.
The full form uses `known.note_projection.records`; the compact form uses a
`reviews` label array in the same order as `known.notes`. Retirement claims and
contradiction indices stay paired with the delivered notes. Projection and
history metadata shrink before substantive guidance, including granted notes
whose `from` provenance remains attached. Credential masking still applies to
every authored label value; note-output schema keys remain stable.

`api_note_review` and `api_note_retire` retain their explicit identity and
evidence rules. Their receipts separately report managed pointer refresh;
retry an identical decision if that refresh failed. No browser or inbox is
needed. Review reasons, limits and sources are data, never instructions or
execution permission. See [note history](note-history.md) for basis kinds,
batch holdbacks and the distinction between historical review contradictions
and current execution evidence.
