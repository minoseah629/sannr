# Agent context across repositories

Sannr can carry an API lesson from one agent's checkout to the next through
small, per-repository snapshots. Agents start with a dependency index, retrieve
the facts relevant to an API operation, and save reusable discoveries. The HTML
map shows a secondary view of the same declared relationships.

This capability is opt-in. Existing single-repository usage works without a
graph manifest. It requires no common parent directory, hosted catalog, or
provider source checkout.

The [API call convention](api-call-policy.md) routes agent-issued repo and
integration calls through Sannr, including simple calls. Configured HTTP
targets capture structural observations when a unique route in that provider's
bound contract supplies a safe identity; unbound and unresolved routes report a
capture limitation. Named integrations declare their own
[`hosts.<name>.contract`](protocols.md#http-context-capture).
A graph manifest controls how
selected observations and authored lessons attach to shared dependency nodes.

## Start with one repository

Add `.sannr/<collection>/.sannr-graph.json` to the repo. Choose stable IDs the team will keep when
folders move or other engineers clone them. This frontend declares a dependency
on a billing API and explicitly binds its saved API observations to that node:

```json
{
  "v": 1,
  "repository": {
    "id": "acme/storefront",
    "name": "Storefront",
    "url": "https://github.com/acme/storefront"
  },
  "nodes": [{ "id": "checkout", "kind": "component", "name": "Checkout" }],
  "dependencies": [{
    "from": "checkout",
    "to": "acme/billing#api",
    "kind": "calls",
    "protocol": "http",
    "environment": "staging",
    "operations": ["POST /invoices"]
  }],
  "context": {
    "snapshot": "share/catalog.json",
    "providers": [{
      "node": "acme/billing#api",
      "provider": "https://billing.example.test/v2",
      "environment": "staging",
      "protocol": "http"
    }]
  }
}
```

Repository IDs must be a slug or `namespace/slug`: each segment starts with an
ASCII letter or digit and then uses letters, digits, `.`, `_` or `-`. IDs are
validated before they enter the agent's dependency index or tool description.

`provider`, `environment`, and `protocol` must exactly match the identities in
saved protocol context. They are explicit bindings, not host-name guesses.
For automatic HTTP capture, `provider` is the actual configured `baseUrl`, not
the `upstream` alias; `environment` is the selected environment name. A mounted
contract keeps its canonical operation path, so dependencies use `POST /invoices`
even when an explicit `contractPathPrefix` mounts the endpoint at `/v2/invoices`.
The frontend owns `acme/storefront#checkout`; `acme/billing#api` remains an
unresolved provider until a selected snapshot defines it. The frontend can
save a lesson about that declared dependency without claiming to own the API.

The backend can start with:

```json
{
  "v": 1,
  "repository": { "id": "acme/billing", "name": "Billing" },
  "nodes": [{ "id": "api", "kind": "service", "name": "Billing API" }],
  "dependencies": [],
  "context": { "legacy": "api" }
}
```

`context.legacy` binds existing HTTP operation knowledge in `.sannr/<collection>/sannr.json` to
the API. Without an explicit binding, old records are counted as unbound and
omitted from scoped results. Add provider bindings too if this repo will use
the new capture tool. With only the backend snapshot, callers are unknown.

## Work through the agent

The existing Sannr MCP server conditionally exposes `api_context` and
`api_context_record` when this manifest is present. Refresh the host's tool
list or reopen its session if it caches tools. The restricted librarian server
does not receive the new write tool. `API_CONTEXT_OFF=1` disables graph reads
and capture.

The initial tool description contains a small dependency index, not the notes
store. A focused read looks like:

```json
{
  "action": "context",
  "node": "acme/billing#api",
  "operation": "POST /invoices",
  "environment": "staging"
}
```

Context defaults to `response_format: "concise"`: attributed lessons, original
dates, bounded response field types, exact scopes, freshness and unavailable
evidence are visible together. Saved verification ranks before authorship:
all local client observations precede observations from
publishers whose manifest fingerprint matches. Publishers alternate within a
tier; distinct recent claims and shapes precede repeats. This order does not
establish truth. A newer sample and a contrary older sample
describe history; they do not by themselves establish current variability or
equivalent request conditions. Unknown environments do not match an exact
environment filter, and missing contract scope stays unknown.

Your repository's own records about its declared provider nodes are local
knowledge. They appear in the main `knowledge` list by default, below local
observations; authored lessons retain `basis: authored` and
`verification: external-claim`. They never count as omitted foreign claims.

A catalog-delivered claim whose publisher is neither the consuming repository
nor the node's owner is a foreign-node claim. Exporting your provider lessons
and consuming them in another repository makes them foreign claims there.
These claims are omitted by default, with
`omitted_foreign_claims` reporting their count. Add
`"include_foreign_claims": true` to a query to retrieve them in the separately
labeled `foreign_claims` section. They remain `external-claim`, including when
their publisher's fingerprint matches. The CLI equivalent is
`--include-foreign-claims` on `graph context` or `graph impact`. The same opt-in is required to inspect
their `detail_ref`; otherwise inspection returns
`GRAPH_FOREIGN_CLAIMS_OPT_IN_REQUIRED`.

Each concise record includes a `detail_ref`. Retrieve its full source locator,
evidence artifact digests, saved shapes, omissions and publication metadata with
`{"action":"inspect","ref":"<exact detail_ref>"}`. Inspection reads the selected
local snapshots and executes zero requests; it does not open evidence bodies or
fetch another repository. References bind publisher, record content, source
locator and evidence identities. Re-export time, calculated freshness and the
digest of the containing context file can change without changing the reference.
A changed or removed record returns a missing-reference result; retrieve context
again rather than treating an old reference as current. If the complete record
exceeds the budget, inspection omits it intact and returns `required_bytes`.

Use `response_format: "detailed"` on a context query for the previous full-record
format. The 2000–64000 byte budget still applies and all formats disclose omitted
records. Overview and impact preserve their dependency topology semantics;
operation/environment filters select knowledge only. A concise record's
`record_with` object, when present, can be passed with a `note` to
`api_context_record`. Only freshly exported local client observations expose this
shortcut. An imported record's `detail_ref` is an inspection reference, not a
local recording handle.

After discovering a reusable gotcha, the agent can call `api_context_record`:

```json
{
  "observation_id": "<observation_id from context_capture>",
  "operation_id": "<operation_id from the same context_capture>",
  "note": "The staging response rejected a missing account_id despite that field being optional in the contract. Production applicability is unknown."
}
```

This form supplies only the lesson and an existing local observation reference.
Sannr retains the exact provider, operation, environment, protocol, endpoint,
contract digest, original observation time and evidence digests. `operation_id`
is optional and disambiguates the observation ID. A receipt's `observation_id`
differs from its private evidence run ID. Do not combine this form with manual
scope, `observed_at` or `evidence` fields.

The tool checks every saved evidence file against its original digest and
refuses missing, changed or linked files. It does not rerun the API or repair
evidence silently. An observation that originally had no evidence remains
explicitly evidence-free. The resulting **authored claim** retains a `based_on`
source link through Git/CI export; evidence bodies stay private and remote
availability is not implied. The original observation remains unchanged.
Its age and contract identity are retained, not refreshed or reassessed against
the current deployment. Source assertions are not assertions of the explanation.

This shortcut supports retained local client observations. Imported catalog
IDs, external claims, private run IDs and observations removed by retention
cannot substitute for one. Recording refuses when it would evict the selected
source at the 20-observation history limit. Preserve the source history and use
an explicitly attributed historical claim when that limit applies.

For tribal knowledge, imported context or other findings without a local client
observation, use the existing explicit scope form:

```json
{
  "node": "acme/billing#api",
  "operation": "POST /invoices",
  "environment": "staging",
  "note": "account_id is required when creating an invoice, despite being optional in the current contract. This was learned against staging; production applicability is unknown.",
  "evidence": [{ "path": "evidence/run-<actual-id>.json", "locator": "/response/body" }]
}
```

Both forms save an **authored claim** in local `.sannr/<collection>/sannr.json`. The tool executes
no API request and establishes no passed assertion. Optional `observed_at`
preserves the original learning time; optional `evidence` names up to eight
project-relative files and JSON pointers. Their identities are retained;
evidence bodies are not exported. Replace the example file with the existing
request evidence artifact in the configured evidence directory; the locator is
a JSON pointer within that file. A bare run ID is neither a path nor a pointer.
Correct an invalid reference before retrying instead of discarding available
evidence. When `context.snapshot` is configured, the same call refreshes that
local artifact after saving the lesson. Otherwise export explicitly to share it.

When the managed instruction block is rendered, recorded authored lessons also
appear under **inherited lessons (authored, unverified)**. Their scope and text
are flattened and bounded through the same block-text boundary as notes;
lesson text cannot introduce a block delimiter. Workflow lines naming
`api_context` or `api_context_record` appear only when those tools are registered.
Recording refuses terminal, Unicode format (`\p{Cf}`), and bidi control
characters with a named input error before saving the lesson.

Existing client capture also remains available: protocol observations retain
their original provenance. Configured primary and named upstream HTTP APIs capture
bounded observations when a unique route in their own bound contract supplies a safe identity;
see [HTTP capture scope and limits](protocols.md#http-context-capture).
Automatic observations retain response shapes; another note should capture a
behavioral implication or decision rather than duplicate those shapes. Sannr
does not automatically deduce every semantic lesson from a response. The agent
must record what it learned. New observations accumulate; this release
does not automatically adjudicate conflicting authored claims.

## Share through Git or CI artifacts

Configure `context.snapshot` with a repository-relative filename such as
`share/catalog.json` to refresh a local snapshot after each successful
`api_context_record` or `graph record`. Automatic response capture does not
trigger this export. The receipt reports `snapshot.state: "written"` and
`record_included: true` when the new lesson is included. Concurrent recorders
serialize snapshot generation using the context writer lock and read the latest
saved context before replacing the artifact.

This writes a local artifact only: `published` stays false, no API call or
remote upload occurs, and evidence bodies are not copied. Use the team's Git/CI
workflow to deliver the snapshot and separately approved evidence files. Original
artifact digests do not establish availability in another checkout.

The destination must be a new file or this publisher's existing valid snapshot.
Both configured snapshots and explicit exports refuse `.sannr/<collection>/sannr.json`, the graph
manifest (including a selected custom manifest), unrelated files, other
publishers and linked paths. Existing bytes are preserved. If the export
fails, the receipt reports `snapshot.state: "failed"` and `lesson_saved: true`;
if export limits omit the lesson, it reports `"limited"` and
`record_included: false`. MCP marks these partial results as errors and the CLI
exits nonzero. Inspect the receipt before claiming a handoff. Repair the local
destination or export limit, then retry `sannr graph export --out <configured-path>`
without recording a duplicate lesson.

For an explicit export, including repos without `context.snapshot`:

```sh
sannr graph export
```

The default output is `.sannr/<collection>/graph.snapshot.json`. Copy the reviewed snapshot
to a team Git repo or publish it as a CI artifact using the team's existing
workflow. Use a distinct filename per repository, for example
`api-catalog/billing.json` and `api-catalog/storefront.json`. Replace that repo's
previous snapshot rather than keeping multiple revisions in the active catalog.

In a consumer checkout, add a `catalog` field to the manifest:

```json
"catalog": "api-catalog"
```

This can name a flat directory of snapshots or a single snapshot file. Relative
paths resolve against this checkout, and the committed manifest requires a
relative catalog path. Use the invocation's `--catalog` override to select an
absolute local path to a separate Git checkout or downloaded artifact; that
selection is never exported. There is no required shared parent directory.

The consumer manifest can declare `publishers`, an array of
`{"id": "acme/billing", "fingerprint": "sha256:<64 lowercase hexadecimal characters>"}`
entries. Replace the placeholder with the team's reviewed publisher fingerprint.
The publisher places the same value in its optional `repository.fingerprint`,
which is included in its snapshot. Each publisher ID may occur only once in the
consumer list. A fingerprint is a metadata pin, not a signature, cryptographic
authentication, or evidence of current API behavior; the Git/CI artifact still
needs the team's review.

Only a matching ID and fingerprint retain an imported record's saved
verification label. An unlisted publisher produces `GRAPH_PUBLISHER_UNLISTED`;
a missing or mismatched fingerprint for a listed publisher produces
`GRAPH_PUBLISHER_FINGERPRINT_MISMATCH`. The diagnosis names the publisher without
echoing fingerprint values. Those records are delivered as `external-claim`,
never `observed` or `client-observation`, and cannot outrank a local observation.

Every query rereads the selected files and composes a fresh local export with
the catalog. A selected snapshot claiming the current repository's ID remains
an external claim and produces `GRAPH_LOCAL_PUBLISHER_CLAIM`; it cannot replace
the current local declaration or observations.
Sannr does not push, download, clone, or synchronize these files automatically.
Each laptop sees the Git revision or CI artifact it has obtained.

Snapshots contain API metadata and team-authored notes. Credential-shaped
text, workstation paths and raw execution bodies are excluded or refused;
that screening is not a guarantee that every business-sensitive sentence is
public. The selected Git/CI destination determines who can read the artifact.

## CLI and map

```sh
sannr graph context --json
sannr graph context 'acme/billing#api' --operation 'POST /invoices' --json
sannr graph record 'acme/billing#api' --operation 'POST /invoices' --note 'Reusable lesson with its scope.'
sannr graph export --out ./api-catalog/storefront.json --json
sannr graph impact 'acme/billing#api' --catalog ./api-catalog --json
sannr map --catalog ./api-catalog --no-execute
```

Run these from a configured repo. `--catalog` overrides that invocation's
local selection. `graph export [repo] --manifest <path>` can select a different
local manifest. Queries default to a 12,000-byte response budget; `--max-bytes`
accepts 2,000–64,000. Limits and omissions are explicit. Unknown nodes and
unreadable catalogs produce nonzero CLI exits.

`operation` and `environment` filter **knowledge**. Dependency traversal stays
across the declared topology, including other environments and operations.
Impact returns potential direct and transitive dependents with supporting
paths. It does not establish a breaking change, measured use, or performance
effect. Explicit `component` nodes and `imports` edges are supported; automatic
component scanning is a follow-up.

The map keeps locally scanned edges separate from shared declarations. A repo
with no served API can still show its declared provider network. Published
repository URLs are browser links. Unknown callers remain unknown; known
callers are a lower bound. The historical `sannr view` projection does not
retain this new shared catalog section; rerun `map` for it.

## Attribution and freshness

- Each fact retains its publishing repo, original source identity, basis,
  timestamps, and evidence omissions. A consumer-authored provider lesson
  remains attributed to the consumer. A snapshot is not a provider endorsement.
- Export time does not reset observation time. Old facts can be labeled stale;
  saved legacy divergence is preserved. Available contract digests remain
  attached to records. This release does not scan the current provider source,
  compare every remote revision, or revalidate copied evidence bodies.
- Missing evidence is unavailable. Freshness otherwise remains unknown or
  unverified. Even a recorded client observation covers only its original
  execution, not all current API behavior.
- Duplicate repository or node ownership fails visibly. Different repo
  contributions compose; context writers in one checkout use the existing
  lock and atomic file updates. Conflicting claims are not silently promoted
  to a newly verified fact.

Catalog loading is bounded to 100 snapshot files, 4 MiB per snapshot and
16 MiB total, with additional node/edge/knowledge limits. It is flat and
does not follow user-created symbolic links or URLs. The macOS system aliases
from `/tmp` and `/var` to their `/private` counterparts are allowed only as
ancestors, as in the output-path guard. One malformed or refused catalog file
is skipped with its safe filename and a named issue while other files load.
Credential-shaped filenames are withheld. Duplicate ownership and catalog
bounds remain visible failures. Missing providers and limits are reported
instead of inferring a complete organization inventory.

## Validate whether it helps

Set `"metrics": true` in the local manifest to opt into metadata-only delivery
events in `evidence/graph/usage.jsonl`. The log retains at most 1 MiB of recent
complete rows; statistics count retained events, and a contended metrics writer
can skip an event. Inspect them with `sannr graph stats`.
No API identities, notes, paths or payloads are logged, and nothing is sent to
Sannr. Listing the MCP context tool can record an overview event as part of
discovery. Counts therefore do not prove voluntary use, correct work, time
saved, token savings or cost savings.

Implementation acceptance is separate from behavioral value. The primary
validation is whether a writer records a useful
discovery, a later agent reuses it, and a maintainer handles a changed API.
Comparative outcomes against an ordinary Markdown convention remain an
experiment; Sannr makes no such claim.
