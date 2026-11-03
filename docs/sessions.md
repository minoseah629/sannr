# sannr sessions

`sannr sessions` shows, per host session, what the API client did: every call,
what the client carried into it, what it produced and what it left behind. It
reads only local files and makes no request. `sannr view` carries the same
ledger as its Sessions section.

```sh
sannr sessions                      # human table, newest session first
sannr sessions --since 7d           # 90m, 24h, 7d, 2w or an ISO date
sannr sessions --stack billing      # only calls routed to one stack
sannr sessions --json               # the model
sannr sessions --out sessions.html  # also write the offline HTML section
```

## Sessions

One session is one host process: an MCP server for as long as it runs, or one
CLI invocation (`request`, `protocol`, `learn`, `suite run`, `verify`). Each run
file the client writes carries a random process id (`origin.session_id`), and
the ledger groups by it. A long-lived MCP server that runs past midnight stays
one session with its own start and end times.

Evidence written before process ids existed carries only the installed
package build (`origin.build_id`), which every process of one install shares.
That evidence is grouped by build, host and local day; evidence with neither
field is grouped by host and local day. The session header names the grouping
and says the host process is unknown. Local days and times use the time zone
of the process that renders the ledger.

Sessions list newest first. Each header gives the start and end times, the
host (`mcp.api_request`, `cli.request`, `cli.protocol`, `cli.learn` and the
others the client records) and the stacks touched.

## Rows

One row per call, in order:

| Column | Source |
| --- | --- |
| time, stack | The run file's origin and the evidence folder it lives in. |
| operation | The stored operation key the client resolved. A key the secret scan flags reads `withheld`; an unresolved route shows only its method. |
| status | The response status, `not sent` for a refusal, `no response` for an error before any response. |
| assertions | Passed and failed counts from the captured observation, the run file or the batch outcome; otherwise `not recorded`. |
| known | Notes the client delivered in `known`, from the usage log row written at request time. Stack facts are counted with operation notes; the split and evidence classes are not recorded. A call without a delivery count says `delivery not recorded`; nothing is inferred. Account facts delivered in `known.account_facts` are not counted by the usage log, so the ledger does not count them. |
| produced | An observation captured from the run, drift records (by kind), draft notes proposed (by reason), notes written that cite the run, key-source links. |
| left | A refusal code with `attempted 0`, an error code, an unresolved placeholder. |
| basis | The run id, envelope outcome id where available, and each draft id and note id the row produced. A referenced run that is unavailable reads `receipt missing`. |

A batch envelope is one block: its own line with the attempted count, any
envelope-level refusal and the number of created resources left behind, then
its steps, with cleanup (`finally`) steps marked `cleanup`.

Refusals, batch cleanup and leftovers are never in a run file, because nothing
reached the network or the run files do not link the steps. The client writes
a small private outcome record (`envelope-<id>.json`) beside its run files when
a batch finishes or a single call returns without evidence. It holds fixed
codes, methods, stack names, statuses, counts and run ids only; paths, bodies,
captures, caller ids and messages are not copied. The record goes only into
an evidence directory that already exists, so a refusal before the
repository's first request leaves no record and no new folder.

## Totals

Each session, and the listed range, totals calls by status class, assertions
passed and failed, notes delivered and written, observations, drift records,
drafts proposed, refusals and resources left behind. Filters recompute the
totals over the remaining rows.

Envelope tokens appear only where the usage log measured the client's own
envelope, labeled "estimate, Sannr envelopes only": the envelope's size
divided by four. They are not a savings claim.

Every session reserves `host_telemetry: null` in `--json` for host telemetry,
which this version does not read.

## Agent summary

The MCP tool `api_workbench` accepts `{ "action": "summary" }` to summarize
its own server process's session. It reads the same ledger without sending a
request, attaching an agent, or requiring a running Workbench. The installed
request skill asks the agent to call it once at the end of a task and quote its
`line`, for example `Sannr: 6 requests · 2 failed · 2 notes added, 1 corrected`.

Failures combine a non-2xx response, a failed assertion, or an error without a
response, counted once per call. Refusals are counted separately. Notes must
be attributable through retained evidence; successful writes without durable
session attribution say `not recorded`. Unreadable call records also make the
affected totals `not recorded`, rather than zero. Summary totals are recorded
activity for the whole MCP process, which may span more than one task.

Completeness is scoped to the session. Missing receipts cited only by inherited
knowledge do not hide a new session's healthy calls or notes. A missing or
unreadable run named by this session's usage rows or batch envelopes makes its
totals `not recorded`. Unreadable call files with no surviving session attribution,
and legacy usage rows naming missing runs without a session, keep every session
uncertain. An unreadable knowledge file still withholds note totals.

New private usage rows retain the generated process session ID so a deleted run
can still be attributed. Shared note citations never invent a process identity.
When this session's history may be incomplete, the summary's line says
`requests not recorded · failures not recorded · notes not recorded`. It never
substitutes a zero lower bound for unknown failures. Structured `recorded` counts
and the Workbench call rows remain readable details; the headline and notes panel
preserve the same uncertainty.

The summary's `open` text gives terminal launch guidance for the Workbench.
`api_workbench` with `action: "show"` offers the session in a paired Workbench;
the person clicks the banner to navigate. With no running Workbench it returns
the launch command with `--show last-session`. The session view lists attributed
note changes, attention items and recorded calls.

## Needs attention

The text, JSON and offline pages carry the same deterministic projection of
recorded HTTP and transport failures, other errors without a response, failed
assertions, pre-traffic refusals, leftovers, drift, proposed drafts, unresolved
placeholders, missing receipts and unknown attribution. These are recorded
facts with source identities, not a generated assessment. A later success never
removes an earlier failure.

The projection groups by kind and orders each group newest first. It keeps the
newest 50 attention items across the groups and names omitted items by kind;
counts describe attention items, so one call may contribute several. It is built
before the session row bound, and therefore can retain a failure whose call row
is omitted. Every shown item identifies its session, stack, operation and basis
where recorded. Unknown host processes and unresolved or withheld operations
remain explicit.

In a clone, shared client observations may name private receipts that did not
travel. Their retained outcomes and receipt gaps stay visible with an unknown
session; they are not added to local call totals. Authored and external claims
can identify missing receipts but do not supply executed outcomes. Usage-log-only
receipt gaps use the legacy project-name scope and cannot be assigned to a
session, operation or selected filter. Unreadable files and unsafe directories
make the projection partial or unavailable. No evidence is an unavailable state,
not an all-clear result. Account-fact delivery stays `not recorded`, never zero.

The JSON field is `needs_attention`: it includes `state`, `bound`, `total`,
`shown`, `omitted`, `groups`, `basis`, `empty` and `unknowns`. Each group reports
its own omissions. Rows and attention items expose `operation_anchor`, derived
from the stack identity, method and stored canonical path; withheld or unresolved
operations have no anchor.

## Bounds and empty states

A session shows its newest 100 rows; earlier rows are counted by name ("1900
earlier rows omitted") and stay in the totals. A batch block is never split.
Run files larger than 8 MB, and unreadable files, are counted in the basis line
rather than parsed.

With no evidence, the ledger says what would populate it. A filter that
matches nothing says so. Usage-log rows for this project name that have no run
file here are counted in the basis line and not listed.

## Output and values

The terminal table and `--json` carry names, counts, statuses, codes, ids and
timestamps. Request URLs, bodies, headers, captured values and credentials are
never read into the model. `--out` writes the same section the view page
carries, as its own offline page with the view's Light, Dark and System
controls, Content-Security-Policy and no script; the page's last scan refuses
to write a page holding a secret-shaped value. Output must stay inside the
project unless `--allow-outside-project` allows the destination. In the view,
each resolved operation links directly to its context, notes and bounded
session evidence. Anchors remain stable if stack order changes, and identical
paths in different stacks have different anchors. A standalone session page
links relatively to an available view with that anchor. Without an available
target, it keeps useful inline basis: outcomes, drift, draft/note identities and
receipt references; it explicitly names the missing operation context and text.

`sessions` is a human surface. It is not an MCP tool.
