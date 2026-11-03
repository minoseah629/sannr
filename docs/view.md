# sannr view

Run `sannr view` to write one self-contained HTML snapshot to
`<evidence dir>/view/index.html` and print its path. Open that file in a browser,
or opt into the OS opener with `sannr view --open`. There is no server or port.
By default, generating either `view` or `map` makes no API requests. The page
has inline CSS, no JavaScript, no external resources, and a restrictive
Content-Security-Policy. It works offline and on a phone.

The Theme controls offer Light, Dark and System. `view` starts with your system
preference; `map` starts dark. Light uses the website's warm paper and dark ink
palette. Switching themes works offline without JavaScript; the choice applies
to the open page and is not saved as a preference. Regenerate an older HTML
snapshot to get the controls.

**Needs attention** groups the same bounded, evidence-based items as
[`sessions`](sessions.md#needs-attention), including failures that precede a
later success, missing private receipts and unknown attribution. Each item
retains its session, operation and source basis where available. Omitted items
are counted by kind; no evidence and incomplete reads are named states.

Session rows and attention items link directly to operation details using
stable anchors derived from stack identity, method and canonical path. The
target contains the operation's context, notes and bounded receipt references,
with assertion outcomes and attribution. Contract-only and evidence-only
operations remain inspectable without acquiring a verification label. Operation
evidence names both its own 20-receipt bound and the ledger/attention omissions;
an absent shown receipt never establishes that no call occurred.

`--out <path>` selects another file. Output must stay inside the project unless
`--allow-outside-project` explicitly allows the destination; symlink and
hardlink outputs are refused either way. The evidence directory follows the
`API_EVIDENCE` override or configured default; the standard location is
`.sannr/evidence/`, ignored by `.sannr/.gitignore`. `--json` still writes the page
and prints `path`, `generated_at`, `head`, `snapshot`, and `opened`. Exit 0 means
written and exit 1 means a named failure (an unreadable knowledge store, an
unsafe output path). Content never refuses the page; see
[Withheld values](#withheld-values). Exit 2 means `VIEW_WITHHOLDING_MISSED`: the
last scan of the rendered page found a value that withholding missed, which is a
bug; the error names the section, never the value, and nothing is written. An
existing page survives a refusal. A failed opener reports `VIEW_OPEN_FAILED`
after the file has been written.

## Explicit reads before a snapshot

`map --execute` and `view --execute` first print `MAP_PROBE_PLAN` to stderr:
the number of declared reads and each stack's selected environment, base URL,
method and path. They then call the same API client as `request`, with that
stack's own authentication, headers and private per-request evidence. The
snapshot reads the resulting stored observations. A legacy directory tree uses
each API surface's own configuration and evidence directory.

The plan admits at most 40 declared GET/HEAD operations per stack or legacy
surface. It names omitted writes, unresolved path parameters, unsupported paths,
missing contracts or targets, and reads above the cap. It never guesses an ID.
Probes make one attempt each, without redirects, retries or OAuth grants;
OAuth-bound operations are named omissions. Use `request` explicitly when you
need those normal client behaviors or a concrete identifier. Refused credentials
remain refused; probes never retry without authentication. The count is planned
reads, while `map --json` (or `view --json --execute`) also reports attempts,
responses, omissions and evidence references under `map_execution`.

`--no-execute` forces local-only output, including when `--execute` is present.
The saved HTML itself never sends requests.

## Withheld values

`view` never refuses the page because of what the store, the contract, the
configuration or a saved report contains. Every value the page would show passes
the secret scan (credential-, key- and email-shaped text, as the committed-surface
guard reads it) and the promotion boundary's email rule; a flagged value reads
`withheld` exactly where it would render, and one line near the top of the page
counts what was withheld by kind, for example "Withheld by the secret and
promotion scans: 1 environment name; 2 notes." The kinds are store names and
dates, environment names, base URLs, contract file paths, contract versions,
contract paths, contract tags and summaries, stored operation keys, declared
field names and types, declared enum values, parameter names, key-source
records, measured field names and types, operation details, freshness reasons, notes, note authors,
dates and markers, granted provider names, verdict fields and lines, saved
report fields and lines, MCP inspection fields and lines, receipt fields and
grant fields. Only what the page shows is scanned and counted; one element shown
in two sections (a note in the API map and in its operation's details) is
counted once. A verdict line or a saved report line that its renderer composes
from clean parts but that the scan flags as a whole reads `withheld` too. A
contract path that is withheld keeps its row as "path withheld (secret-shaped)".
The scan of the final page stays as the last guard and reads the HTML both as
written and with the escaper's entities decoded; if it ever fires after
withholding, `view` refuses with `VIEW_WITHHOLDING_MISSED` as described above.
`map` withholds the same way inside its API map section and prints the same
counts line there; `map --json` reports them under `api_map.withheld`.

## The API map

With named stacks, the page includes a stack index and one API viewport per
stack, default first and then alphabetical. Counts come from the same scoped
store and contract as `sannr show --stack <name>`. Each viewport names its
selected environment and contract state, keeps its own filters and withholding
counts, and preserves the value, script and CSP rules described here.

The page opens with the API map. Evidence standings, notes and response counts
come from the knowledge store and the contract it names. The separate **In the
code** section comes from the local source scan described below. Nothing comes
from an agent's memory, a response body or the network. Each part names its basis,
and values never appear: names, types, methods, paths, status codes, counts and
dates only. Evidence files are checked against their
recorded digests and never read for content.

### In the code

Operation rows and details list `defined_in` and `called_from` locations as
repository-relative files with line numbers where available. Each is labeled
**declared by code**, with its kind (definition, request expression, source
binding or configuration reference) and matched environment. These locations
never change the operation's evidence class or response standing.

The stack section lists all matching host references, including references that
do not identify an operation. The code index shows counts and lists for both
sides of an unmatched join: routes or hosts without a stack, and stack operations
without code. A source location remembered from saved provenance is distinguished
from a current scan; a deleted file reads **not found at the working tree**.
Secret-shaped file paths read `withheld`, and the section counts them.

The HTML contains no source code or editor links. It keeps the same script-free,
offline rendering and theme controls. Regenerate the snapshot to reflect moved
files. See [API discovery](discovery.md#where-an-api-lives-in-code) for matching
rules and scanner limits.

Each operation has one standing. It is computed from the same retained client
responses, with the same rules, as the `observed` label of `sannr show`, so
`show`, `view` and `map` agree about every operation.

| Standing | Meaning |
| --- | --- |
| observed | The newest response retained in scope completed with a 2xx status, every assertion on it passed and its evidence still matches its digest; no earlier response retained in scope failed. `show` prints `observed` for this standing and for the next one. |
| observed after a failed attempt | Observed, and an earlier response retained in scope was non-2xx or failed an assertion, whether or not it can be counted. When it cannot be counted, the reason is named (for example "an earlier failure is retained; its evidence is missing or changed"). |
| latest response `<status>` | The newest response retained in scope was non-2xx or failed an assertion, or cannot be counted (older than the staleness horizon, evidence missing or changed, incomplete); nothing passed after it. The reason is named beside it. A response that did not fail but cannot be counted has a neutral marker rather than the failure marker. |
| no response recorded | A read (GET or HEAD) with no response retained in scope. |
| write — no response recorded | Any other method with no response retained in scope. It may or may not have been sent; nothing in this scope records it. |
| scope unresolved | No provider, environment and contract identity could be bound, so no response can be counted; the reason is named. |
| observations unavailable | The retained history could not be read completely, the operation cannot be held as an identity in the store (over its bounds, or a control or format character), or its path was withheld by the secret scan. The code or reason is named and no label is given. A record the store's query leaves out to stay within its read bound reads "history beyond the read bound", the words `show` uses for it (`unavailable`, never `none`). |

An observed operation carries `using parameters the contract does not declare:
<names>` when the query parameter names recorded in the request shape of its
newest counted request (the structured `params` and the names written into the
request path) include names the contract does not declare for it. When any of
the operation's declared parameters cannot be resolved to a name and location (a
reference that cannot be resolved, such as an external file or a missing
component, an entry missing its name or location, or a `parameters` value that
is not a list), its declared set is incomplete: the check is skipped for it and
such operations are counted in one note. Names are recorded in the request shape
only when written with `=`; a query component without `=` is a value and never
becomes a name (see [HTTP context capture](protocols.md#http-context-capture)).
A legacy `learn`
verification of the contract shape is shown beside the standing as `learned:
verified` or `learned: suspect` and is never merged into it.

The scope is the provider (the selected environment's base URL), the
environment and the contract digest that `show` binds. Each contract operation
is bound the way the client builds a request: the base URL, then the path. A
contract is used as written when one of its routes covers the base URL's path
segment by segment (a `{template}` segment matches any one segment, so
`/{tenant}/items` covers `https://h/acme`, and the operation binds as a request
to `https://h/acme/items` would); otherwise (base URL `https://h/api`, contract
path `/v1/items`) it binds below the base URL's path. Contract and request paths
are compared with each segment percent-decoded, so `/v1/café` binds; see
[HTTP context capture](protocols.md#http-context-capture). Responses retained
under another environment, provider or contract version are counted beside a
standing and never change it. When no identity can be bound, the reason names
the cause: no contract named for the selected environment; the contract is
missing, unreadable or declares no operations; no base URL; a base URL that
cannot scope responses (userinfo, a query or a fragment); an environment name the
store cannot hold (a secret-shaped name also reads `withheld` where the page would
print it); or, for one operation, not in the bound contract, declared more than
once, outside the base URL's path, matching more than one operation, or, built
into a request URL, matching no operation (for example an encoded dot segment the
URL parser removes). An operation whose path has a format character cannot be
held as an identity and reads "observations unavailable" with the code.
A granted provider whose directory is gone is skipped and named once at the top
of the map; when a granted provider's store cannot be read, labels stay withheld
and the provider is named once.

Operations are grouped by the contract's first tag; an untagged operation is
grouped by the first literal path segment after the hub prefix. The hub prefix
is the path up to and including the first path parameter shared by the most
operations, shown when it covers at least a quarter of them and abbreviated as
`…` inside groups; a hub's collection groups with its items. Each row gives the
method, path, standing, latest status codes and note count. A contract tag,
summary, path or version that the secret scan flags reads `withheld` and is
counted in the page's one withheld line; a withheld path keeps its row as "path
withheld (secret-shaped)". One operation the store cannot hold or query gets its
own row naming why and never takes the page down.

"Where each path key comes from" has one row per path key of the contract: the
path prefix that ends in the key, for example `/v1/hubs/{hubId}`. Each row shows
the recorded sources of that key on any operation under the prefix, most-seen
first: at most two, each with "seen on M operations", then "and N more". A key
with no recorded source says "not recorded". Query keys and every operation's
own key-source records stay in the operation details. The map shows exactly the
key sources the store accepts: it reads each operation's record through the
store's own query, whose one validator (the `key_sources` rules in
[protocols](protocols.md#path-key-sources)) also governs `show` and
`context query`. Key sources are derived data: an operation record whose
key-source list is damaged (the query names it in `record_issues` as
`KEY_SOURCES_INVALID`) has its links treated as absent and is counted in one
line; its observations and standing are unchanged and nothing else about the
operation is withheld. Key sources never cost a record its place: a record the
query returns without its list, because the list would not fit beside it within
the read bound, keeps its standing, and its list is counted in one line
("beyond the read bound; its links are not shown"). A key with no shown source
under such a record reads "not shown" instead of "not recorded". A key-source
name or field that the page scans flag reads `withheld` in the table and the
details and is counted once per record. Below
the key table are the active authored notes with author, date
and evidence run ids, and a full operations table. Its method and standing
filters are radio buttons styled with CSS and need no script; with CSS turned
off the complete table still renders. The map ends with "How to read this",
which defines each standing and the scope.

`sannr map` includes the same section when the store has operations, its
terminal receipt and `--text` output print the map's counts, and `--json` adds
them under `api_map`. A repository that serves no API but keeps a store for the
API it consumes gets that map instead of a footprint of zeros, and its coverage
line says it serves no documented API and the API map is the one it calls. If
the section cannot be built, `map` writes the footprint without it, prints
`API_MAP_UNAVAILABLE` with the reason, and exits 0. A repository without stored
operations gets exactly the footprint it got before. A footprint finding for a
probe that substituted an id from a collection names the operation, the
collection operation and the field the id was listed at (`for a listed id (GET
/hubs → data[].id)`, a key that carries data reading `{}`), never the id.
`view` never refuses because of the contract: a missing, unreadable or empty
contract renders the page from the store, and the map says which. A contract
that fails to parse is unreadable, never "declares no operations": malformed
JSON, and YAML the reader had to skip parts of (a character YAML does not
allow, a line that is not a key, an unclosed flow collection or quoted scalar,
a top level that is not a mapping) when no operation could be read from it.

## Operation details

Below the API map the page shows every stored operation, declared response
fields and enums, measured field names, verification dates, confidence and age,
notes with their recorded provenance and superseded markers, and verdicts. Each
operation's details state the map's standing beside the learned grade; "Not
measured: no executions recorded yet" appears only when no response is recorded
in scope. Each operation's own key-source records, path and query keys, appear
in its details, or a note that its stored list is damaged or beyond the read
bound. Active notes appear first; superseded authored and machine claims remain
in collapsed history.
Integrity warnings remain visible. See [note history](note-history.md).
Freshness uses the
same functions as `show` and the audit summary. The current contract supplies
declarations; it does not establish an execution. Historical stores sometimes
omit environment names or field types, which the page labels as not retained.

## Retained reports

Audit, map, and import retain their already-produced presentation models under
`<evidence dir>/view/records/`. Audit retains its comparison when a baseline
exists; CI uses the same summary model it just reported. Map retains its model
in HTML, text and JSON modes. Import retains its loss report when it writes the
import, including quarantine reasons and inferred assertion counts. These
sidecars contain projected metadata, never raw request/response values. A
retention failure reports `VIEW_RECORD_NOT_SAVED`; the original result keeps
its own exit status. Every retained report identifies its date and commit.

`view` reads those models and uses the existing map, audit and import renderers.
By default it does not run a new map or audit, execute requests, enumerate MCP servers, or
reconstruct a lost report from current state. Reports from before retention
existed have explicit empty states; new and resolved findings are unknown when
there is only a baseline. Run the relevant command to record its next result.
An old report remains visibly dated even when the store or baseline changes.

Stored MCP inspections show declarations, server claims, executed tool
observations and the recorded declaration diff. An annotation is a claim, not
proof of safety. Receipts count only project-scoped usage rows using the same
scope and arithmetic as `receipt`; legacy rows use repository basenames, so
equal basenames share that scope. Machine-global totals are absent. Registry
grants show consumer and provider names and grant dates; provider stores are
not read.

This is a snapshot of the working tree at the named git HEAD; local edits can
be included. Each section states its evidence basis and date, and missing
evidence is a sentence. Names, types, declared enums, note prose and verdict
text appear; observed values, examples, bodies, headers and query values do
not, and anything the secret scan flags reads `withheld`. One escaping rule
covers the whole page: control characters and every Unicode format character
(bidirectional controls, zero-width space, word joiner, byte order mark, soft
hyphen, tag characters) are removed, except the zero-width non-joiner and joiner
that real scripts and emoji need. The page is a report of retained evidence, not a management surface or a
new verification. Regenerate it with `sannr view` after recording new evidence.
