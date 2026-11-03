# Portable saved requests

A saved request is a shared recipe, with typed runtime bindings and an explicit
stack/environment. Saving, opening, listing and reopening history do not send
anything. Sending calls the existing request engine with current configuration,
credentials and production policy. Each run that reaches the engine has a new
execution identity; HTTP dispatch records a new private run receipt when local
evidence storage is available. Input preflight refusals do not create a run
receipt. Historical permission does not transfer.

Requests live in `.sannr/requests/<folder>/<name>.json`. Folders are directories;
names use letters, digits, dash and underscore. These files are separate from
saved suites. An assertion-free request reports its HTTP outcome and
`assertions: null`, with `saved_request.assertions: "not_run"`. It is an
observation, never a passed test or a verified integration. Existing suites keep
their assertion requirement.

## Headless commands

```sh
sannr saved list --stack orders --env local
sannr saved show orders/lookup
sannr saved create --file request.json
sannr saved edit orders/lookup --file edited-request.json
sannr saved run orders/lookup --inputs-stdin < local-inputs.json
sannr saved run orders/lookup --inputs-file local-inputs.json
sannr saved rename orders/lookup --folder archived --name lookup
sannr saved delete archived/lookup
sannr saved reopen run-RECORDED_ID --stack orders
sannr saved inspect run-RECORDED_ID --stack orders
```

The document reader also accepts `--file -`. Runtime input files must be inside
the repository, untracked and ignored by Git; symlinks and hard links are
refused. Stdin and declared environment references are alternatives. Do not put
sensitive values in command arguments or shell commands. The library and paired
workbench can supply invocation-local `inputs` objects; they are never saved in
the request document. Credential values continue to belong in the stack's
existing local environment source, never in ordinary request headers or inputs.

The `api_saved_requests` MCP tool exposes `draft`, `list`, `show`, `create`, `edit`, `run`,
`rename`, `delete`, `reopen` and `inspect` using shared functions. Use `action:"list"` for
discovery and `action:"run",ref:"orders/lookup",inputs:{...}` for execution.
Missing and malformed inputs return a named refusal and the input name to
repair. `stack` or `environment` on an invocation must match the saved document.
The browser cannot request arbitrary local input-file reads.
`inspect` reads a bounded redacted response from an existing private receipt;
it makes no API request and creates no new response-retention store.

`action:"draft",stack:"orders",environment:"local",operation:"POST /orders"`
builds a new value-free recipe from the current bound contract. The environment
may be omitted to use the stack's current environment selection. This shared
headless action also supplies the Workbench form: `fields` names each required
path, query, header or body input and its type; `document` contains bindings,
not input values. Required nested JSON objects are expanded into scalar fields,
and JSON or form encoding is selected from the contract. A field's `enum`
contains bounded scalar choices only when the contract declares them and the
credential scan permits them. String inputs are
sensitive by default. Examples, defaults, descriptions and credential values
are never copied. Credentials remain references to current stack authentication.

Draft creation writes nothing and sends nothing. `ready` describes whether the
recipe has all supported required bindings, not whether local values,
credentials or permission to send are available. Unsupported composed schemas,
arrays, untyped fields, unsupported required parameter locations (such as cookie
or formData), unsafe enum choices and nested form bodies produce a blocking warning and
`ready:false`; review these in the advanced editor before sending. Optional
fields are omitted with a count and can be added in the advanced editor. With
no bound contract, only path placeholders are prepared and a warning names the
missing contract basis. Missing bindings report the required contract field,
including a body field such as `body.session_token`, instead of only a generic
binding failure.

## Format version 1

This is a separate format, not envelope v1. Its fixed
`origin:"saved-request-document"` marker makes older direct and batch readers
refuse with `REQUEST_ROUTING_FIELD_UNSUPPORTED`. This marker is structural
format syntax, never a URL or authority; the saved-request reader consumes it
and never forwards it. Nesting alone would be insufficient because older direct
readers default a missing path to the configured root. The existing explicit
envelope-v1 refusal is unchanged. Older versions do not discover this dedicated
directory. Exact published-reader qualification is recorded with the candidate.

```json
{
  "kind": "saved-request",
  "origin": "saved-request-document",
  "format_version": 1,
  "id": "req-8194b0b4-088f-4b66-93e3-4db1fe279468",
  "folder": "orders",
  "name": "lookup",
  "stack": "orders",
  "environment": "local",
  "request": {
    "method": "GET",
    "path": "/orders/{id}",
    "bindings": {
      "path": { "id": { "$input": "order_id" } },
      "query": { "detail": { "$enum": "compact" } },
      "headers": { "x-note": { "$input": "private_note" } }
    }
  },
  "inputs": {
    "order_id": { "type": "string" },
    "private_note": {
      "type": "string",
      "sensitive": true,
      "source": { "env": "ORDER_NOTE" }
    }
  },
  "credentials": ["bearer:ORDERS_TOKEN"]
}
```

Create may omit `id`, `kind`, `origin`, `format_version`, `folder`, `inputs` and
`credentials`; the engine supplies their documented defaults. Edit preserves
the stable id and location; rename changes the location while retaining the id.
`credentials` must exactly match the current selected stack's authentication
reference (or be empty for an unauthenticated stack).

Every value is an explicit `{"$input":"name"}` binding, or a scalar
`{"$enum":value}` that the current contract actually declares as an enum at
that input position. Object/array structure may be saved; arbitrary scalar
values may not. A JSON body can therefore be
`{"title":{"$input":"title"},"enabled":{"$input":"enabled"}}`.
Types are `string`, `number`, `integer`, `boolean`, `object`, `array` and `null`.
Sensitive inputs are strings; split sensitive structured data into individual
string fields. They are scrubbed from the engine's evidence, responses and
usage output, including common encoded reflections. Input objects cannot carry
body-file directives or prototype keys.
Environment sources accept string inputs and are always treated as private,
even if `sensitive` was omitted. A current authentication variable cannot also
be an ordinary request input. Supply other typed values through JSON stdin,
an ignored local input file or explicit invocation inputs.

`source` optionally contains `run_id` and/or `request_id`. It is attribution,
not authority. Assertions are intentionally absent from this core request
format; use existing suites for executable assertion sets. JSON and form HTTP
bodies are supported; multipart, file directives and protocol editors are
outside this first saved-request format.

When a contract is available, its canonical method/path, required parameters,
body fields, declared types and enum bindings are checked at save and again at
send. Contract changes can therefore make a formerly runnable recipe refuse.
A missing contract permits an all-input-bound author-declared route with
structural path names and explicit placeholders; the readiness view reports
the missing contract, and no literal enum can be promoted. Required fields that
an unavailable contract would declare cannot be inferred. A configured but
unreadable contract or undeclared operation refuses with a named repair action.

## History, clone reuse and discovery costs

Reopen reads a bounded private run and produces a new value-free draft. It uses
the recorded canonical operation and current contract field names, names the
missing inputs, and withholds recorded values and authorization. Unknown
operation attribution or absent private evidence is an honest refusal. Rename
and delete affect only the recipe; private execution receipts and source links
remain. A clone can list/show the shared recipe without having its author's
private evidence or values, then supply its own current bindings to run it.

Operation context advertises at most five saved request references, scoped to
the exact stack, environment and canonical operation. The block contains no
request bodies or input declarations, reports serialized `bytes` and omitted
counts, and is capped at 800 bytes (lower when the request budget is smaller).
The context fit removes this block before code-location hints when necessary.
`API_CONTEXT_OFF=1` disables it. Listing is bounded to 500 files/2,000 directory
entries and reports scan omissions or unreadable files rather than inventing
an exhaustive result.

The `saved_request` result block carries stable request identity, this execution
identity, the underlying run id when available, source attribution and private
receipt-write status. It is additional output beyond the request engine's own
envelope budget; whole-workflow measurements must include it. A missing private
receipt is reported as unavailable, never as recorded. No universal time, token
or cost savings claim follows from this feature.
