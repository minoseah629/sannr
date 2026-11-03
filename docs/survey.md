# Portable API survey

The survey is an explicit, historical graph of API structure in your repository.
Sannr sends no requests, starts no application and resolves no credentials to
generate it. It reuses the conservative source/contract join described in [discovery](discovery.md); it is not a
complete language parser or a runtime trace.

## Generate, check, inspect

Run from the repository root after configuring its [API stacks](stacks.md):

```sh
sannr survey generate
sannr survey status
sannr survey query --stack orders --operation 'GET /orders/{id}' --max-bytes 8192
sannr survey render --format dot
sannr survey render --format html --out survey.html
```

Commit `.sannr/graph/survey.json`. Generate drawings on demand; do not commit
private change-detection state in `.sannr/evidence/survey/`. The JSON format is
`v: 1`, `kind: "api-survey"`. Commands print JSON receipts, except render output
without `--out`, which prints the requested JSON, DOT or HTML. HTML is standalone
and offline: static SVG and native disclosures, no script or external resources.

Generation preserves the old bytes and build date when inputs are unchanged.
A failed generation does not replace the previous valid snapshot. Existing
unrelated output files are not an invitation to overwrite them. Choose a new
render destination if its bytes differ.

`status` explicitly discovers current inputs, including new files that the old
graph never mentioned. It does not regenerate. A snapshot's build time is not a
freshness check. A reader shows its last explicit check, tied to that snapshot,
or **current inputs not checked**. A check is historical: files may change again
afterward. Source/configuration, retained observation inventory and Git base
availability are separate dimensions. Missing private state or history cannot
produce a blanket clean claim.

For a read-only assessment, keep *both* outputs outside the source repository:

```sh
sannr survey generate --exclude-env \
  --out /private-assessment/survey.json \
  --state-dir /private-assessment/state --allow-outside-project
sannr survey status --file /private-assessment/survey.json \
  --state-dir /private-assessment/state --allow-outside-project
sannr survey query --file /private-assessment/survey.json \
  --state-dir /private-assessment/state \
  --stack orders --operation 'GET /orders/{id}' --allow-outside-project
```

Replace `/private-assessment` with a private temporary directory you own. These
are illustrative paths, not directories created automatically by the examples.
`--exclude-env` excludes environment-file inputs; it does not make a partial
inventory complete. `--include-fixtures` includes fixture/example source that
the scanner normally excludes. A query or renderer reads the artifact only;
it never scans the repository to fill a gap.

## What an edge means

| Relationship | Supported meaning | Not implied |
| --- | --- | --- |
| `defines` | A detected source route joins a unique service/contract operation. | The route ran or the contract is complete. |
| `calls` | A recognized request expression names a host or uniquely joined operation. | A URL constant/config binding is executable; a recorded endpoint response proves its application caller. |
| `supplies` | A response field supplies a path/query parameter according to a saved relationship or suite declaration. | The relationship verifies operation behavior or a suite declaration was executed. |

A relationship has stable `id`, `from`, `to` and `kind`, with separate
`declarations`, `observations` and `operator_attributions` arrays. Supplies also
names `source_field`, `target_parameter: {location, name}` and its available
stack/environment scope. The arrays can support the same edge together; one
does not silently replace or upgrade another.

For example, a suite that captures `data.0.id` from `GET /orders`, then uses that
capture in `GET /orders/{id}`, supports a **declared** `data[].id → path:id`
relationship. A retained key-source match can separately support an observed
value-match inference. That inference is not caller tracing. Its run reference
can survive a clone even when its private proof is unavailable locally.

Definitions, executable requests and plain references retain their repository-
relative files and available lines. Matching normalizes parameter spelling but
retains source and contract spellings. Ambiguous service, host, mount or operation
matches stay unresolved. Missing saved locations say **not found at the working
tree**; their history is not erased.

The survey does not cover imports, frameworks its scanner does not parse,
runtime route registration or call tracing, and it does not author new operator
bindings. Existing safe operator annotations keep their author and date without
becoming execution evidence.

## Coverage, identity and privacy

The artifact records scanner/config identities, a dated snapshot identity, base
commit when available, dirty/untracked counts, safe structural input identities,
nodes, relationships, coverage and unresolved candidates. Node kinds are `file`,
`operation`, `host` and `contract`; operations are stack-scoped. Stable IDs and
canonical ordering make JSON, DOT and HTML describe the same graph.

Coverage names eligible/scanned and omitted inputs, unreadable/oversized files,
detected unsupported constructs and unresolved reasons. Scanner limits still
apply. It cannot count constructs it never recognizes. Zero unresolved
candidates is **not** complete API coverage, and dropping files is not improved
resolution. See [discovery limits](discovery.md).

Each read-outcome count is unique by file, not by reader attempt. The dimensions
can overlap: a contract may fit the contract reader's larger limit while being
oversized for source analysis. That file counts once as scanned and once as
skipped/oversized; the partial inspection remains disclosed, not complete.

Portable output contains structural metadata only: no body/response/query
values, credentials, absolute workstation paths, secret-shaped locations or
secret-value fingerprints. Raw change-detection hashes remain private. All
renderers validate the same bounded model and content identity before output.
Unsafe metadata is withheld or rejects the artifact, not copied into labels.

## Existing command behavior

`show --stack orders 'GET /orders/{id}'` includes a bounded survey section.
`map --json` includes the saved graph under `survey`; absent or invalid snapshots
have a diagnostic state, not a fake empty graph. A missing snapshot names
`survey generate`. A stale snapshot remains inspectable under its historical
identity. Malformed or unsupported versions are not rewritten by readers.

The existing `code` and request `known.code` fields still describe current source/contract
locations, independently of the saved survey. Requests keep the five-location
cap, byte accounting and `API_CONTEXT_OFF=1` behavior. Requests do not generate,
check or deliver the survey. Survey queries default to 8,192 bytes, accept
512–65,536 bytes, and report omitted node/relationship counts. A bounded result
is not a claim that omitted relationships do not exist.
