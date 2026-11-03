# Dependency graph format

This page describes the files behind [agent context across
repositories](dependency-graph.md): the per-repository manifest, the snapshot
that `graph export` writes, and how a selected set of snapshots is read. The
graph is opt-in. Snapshots move through a shared Git checkout or a downloaded
CI artifact; Sannr does not publish them to a remote service.

## What the graph answers

A backend can describe its APIs and dependencies before any consumer has
adopted Sannr; its map then says that callers are unknown. A frontend can
declare its own dependency on that backend without editing or checking out the
backend repository. Reading both snapshots gives the backend a known caller and
the frontend a link to the provider. Known callers are a lower bound on usage.

The same graph covers frontend components. A changed API can affect a
component, a page that imports it, and another repository that depends on that
page's package. Impact queries follow dependency edges in reverse and keep the
paths supporting each potential effect. Reachability is potential impact, not
proof of a breaking change or a performance regression.

## The manifest

Each repository owns a checked-in `.sannr/<collection>/.sannr-graph.json`.
Stable repository IDs, such as `acme/storefront`, survive moving the checkout.
Local node names are qualified as `acme/storefront#cart`; they are never
inferred from directory names, endpoint hosts or contract hashes. A repository
ID is a slug or `namespace/slug`: each segment starts with an ASCII letter or
digit and then uses letters, digits, `.`, `_` or `-`.

Manifest version 1:

```json
{
  "v": 1,
  "repository": {"id": "acme/storefront", "name": "Storefront", "url": "https://github.com/acme/storefront"},
  "nodes": [{"id": "cart", "kind": "component", "name": "Cart"}],
  "dependencies": [{"from": "cart", "to": "acme/catalog#api", "kind": "calls", "protocol": "http", "environment": "development", "operations": ["GET /items"]}]
}
```

Node kinds are `repository`, `service`, `operation` and `component`. A
`repository` node with local ID `repo` is supplied automatically. Dependency
kinds are `depends_on`, `calls` and `imports`; `from` belongs to the publishing
repository, and `to` is an explicitly qualified node ID. Optional metadata is a
repository-relative source file, protocol, environment and operation
identities. Manual dependencies are labeled `declared`; capturing context never
upgrades them into observed use.

### Publisher pins

The optional `repository.fingerprint` is `sha256:` followed by 64 lowercase
hexadecimal characters and is copied into the publisher's snapshot. A
consumer's optional `publishers` array lists `{id, fingerprint}` entries, one
per publisher ID, in the same shape. A pin is reviewed metadata, not a
signature, authentication or current API verification. A matching entry keeps
the publisher's saved verification labels. Unlisted or mismatched publishers
are delivered only as `external-claim`, and neither their basis nor nested
source verification can claim `observed` or `client-observation`.
`GRAPH_PUBLISHER_UNLISTED` and `GRAPH_PUBLISHER_FINGERPRINT_MISMATCH` name the
publisher without echoing fingerprints.

## Export, impact and the catalog

`sannr graph export` reads the manifest and saved local context and writes one
versioned snapshot. It scans no source and makes no API requests. A snapshot
holds the repository identity, export time, a commit field (currently null),
qualified nodes and edges, projected knowledge and explicit omissions.
Knowledge keeps its original observation dates and basis. API knowledge with no
explicit binding is counted as unbound and left out of scoped delivery rather
than guessed onto a service.

`sannr graph impact <qualified-id> --catalog <file-or-directory>` reports known
direct and transitive dependents with their supporting paths, unresolved
targets, catalog coverage and evidence labels. The same input adds a repository
network and links to `sannr map --catalog <file-or-directory>`; the local
footprint remains available.

A catalog is a selected set of per-repository snapshot files. Reading it does
not clone repositories, follow arbitrary URLs, execute requests or publish
data. Each repository replaces its own snapshot; two snapshots claiming the
same repository or node in one catalog are a conflict. There is no merge of
historical snapshots and no last-writer-wins by timestamp.

One malformed catalog file is skipped with a fixed code and a safe file name,
and the remaining files still load. Duplicate ownership and aggregate size
bounds are explicit failures. Repository text rejects Unicode format
characters (`\p{Cf}`) and bidirectional controls. Catalog reads refuse symbolic
links, except the macOS system aliases `/tmp` and `/var` to `/private` when
they are ancestors of the path.

## How claims are labeled

Every agent context query includes a fresh export from the consumer's own
checkout. A catalog snapshot that claims the consumer's ID is kept only as an
external claim with `GRAPH_LOCAL_PUBLISHER_CLAIM`; it cannot replace local
topology or take local observation priority. Concise and detailed results rank
saved verification before authorship, give local observations the first turn,
and alternate publishers within each tier.

The consumer's own authored lessons about declared provider nodes appear in
`knowledge` by default, as authored external claims below local observations.
Catalog claims whose publisher is neither the consumer nor the node owner need
`include_foreign_claims: true` on the agent query and appear in a separate
`foreign_claims` section; only they count in `omitted_foreign_claims`. An
exported consumer lesson becomes a foreign claim when another repository reads
it. Foreign claims stay external claims even with a matching publisher pin, and
they are dropped first when the shared response budget is exceeded. The same
opt-in applies to detail inspection.

Authored lessons also appear in the managed instruction block under
**inherited lessons (authored, unverified)**, flattened and bounded. Block
delimiters cannot come from lesson text. The block lists the context tools'
workflow lines only when those tools are registered in the binding.

## What the graph does not claim

- A dependency edge grants no write authority over another repository's node
  and no permission to merge foreign claims into ordinary knowledge.
- No incoming edge means unknown coverage, not no consumers.
- A missing provider snapshot leaves its target nodes unresolved and visible.
- Export time is not verification time. Remote source history that is not
  available is never described as unchanged, current or verified.
- Catalog input is bounded; limits, missing sources and conflicts are reported.
- Snapshots carry projected structural context, notes and provenance. They omit
  credentials, payload values, private execution bodies, and paths under the
  common home and workspace prefixes the export refuses.
- Ambiguous host or folder-name matches cannot establish a graph edge.
- Graph traversal does not assess breaking changes or measure performance.
