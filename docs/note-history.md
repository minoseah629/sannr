# Correct API guidance without losing its history

Sannr keeps an authored correction beside the original claim. Superseding a
note means it is no longer default guidance; it does not mean it was false at
the time it was written. Give the replacement its applicable version, date or
environment, and keep disagreements explicit. An evidence link identifies a
request; it does not prove an explanation of that request.

```sh
sannr show "GET /api/user" --human --history
sannr note "GET /api/user" "In <version>, learn sends the configured authorization." --supersedes sha256:<full-note-digest> --evidence run-<id>
sannr note "GET /api/user" "The earlier claim applies to an older version; this run used api_request." --alongside
```

Use the full `sha256:` note identity printed by `show`, within the named
operation. Array positions are not selectors. The first note needs no flag;
when active authored or unattributed notes exist, another note requires
`--supersedes` or `--alongside`. Sannr does not choose a replacement relationship from prose. A bounded
status/error-code contradiction flag can call attention to a claim; it never
supersedes or deletes that claim.
An exact active duplicate, or a retry of the same replacement, saves no second
note. A historical claim can be superseded once; further corrections target
its active replacement.

Successful note receipts are JSON. Add `--json` to receive refusals on stdout
as JSON too; otherwise refusals use stderr. Exit 2 means a secret refusal,
exit 3 means a non-secret note or history policy refusal (including
`NOTE_RELATION_REQUIRED`), and exit 1 means a usage or other error. A refusal
does not save the proposed note.

The original `notes`, `notes_provenance` and `notes_superseded` arrays retain
their order. Authored links live in `note_replacements`; machine markers keep
their existing format. `show` adds `active_notes` and `note_history` with full
identities, attribution, active and superseded records, and integrity issues.
The human view shows active guidance first and includes retained history with
`--history`. The HTML view collapses superseded claims. Current client delivery,
managed pointer blocks and graph exports use the same active projection.
Older installations may display both claims; upgrade collaborators before
relying on authored supersession.

After a note save, existing managed instruction blocks are refreshed. The
receipt reports knowledge and pointer results separately. If pointer refresh
fails, the saved note remains: repeat the same command to retry refresh.
Refresh uses complete-file replacement and checks the planned instruction
contents before committing. External editors that do not share a lock can
still race that final check; it is conflict detection, not a filesystem lock.
`review --drop` and `prune` refuse to remove operations with authored or
unattributed history. Correct guidance through relationships; handling an
actual exposed secret or personal data is a separate explicit redaction task.

## Review individual notes headlessly

Use the full note identity from `show`, not the history digest used by
`review --accept-notes`. Trust is an attributed decision, separate from
acknowledging the integrity of a history and separate from execution evidence.

```sh
sannr review "GET /api/user" --note sha256:<full-note-digest> --decision trusted --by Alex --actor person --limits "as documented; local only" --json
sannr review "GET /api/user" --note sha256:<full-note-digest> --decision disputed --by Reviewer --actor agent --reason "The observed status differs." --evidence run-<id> --json
sannr review "GET /api/user" --note sha256:<full-note-digest> --decision run-requested --by Alex --actor person --reason "Check the status in the local environment." --json
```

Add `--stack NAME` to select a named stack. `--note` and `--evidence` are
repeatable; a batch explicitly lists every note identity within one operation.
Up to 256 note identities and 16 run IDs are accepted. A malformed or stale
identity refuses the entire batch without writing. Batch **trust** holds back
notes with authored replacement links and returns their `note_id`,
`NOTE_REVIEW_REPLACED` code and `replacement` identity in `held_back`. It does
not infer replacements from prose. Selecting a replaced note alone for trust
refuses with that same code. Disputes and run requests also accept explicit
batches. A run request records what to check and hands it to the repository
inbox; it executes no request. See [Run requests](#run-requests) below.

Each operation stores an append-only `note_reviews` array beside
`note_replacements`. Each record contains `note_id`, `decision`, `by`, `actor`,
`at` (UTC timestamp), `evidence` (an array of run IDs, possibly empty), and
optional `limits` and `reason`. `disputed` and `run-requested` require a reason;
limits apply only to `trusted`. Review text is untrusted data, never permission
or instructions. Do not put request/response values or credentials in it.
The writer scans bounded text for secrets and refuses control characters and
comment markup. Run resolution reads private local files but never copies their
payloads into review records or receipts.

The last appended decision for a note wins in the projection, regardless of
who made it. Repeating the latest identical decision, attribution, limits,
reason and run-ID set is byte-idempotent; its original timestamp is retained.
A decision made again after a different decision appends a new record. Neither
reviews nor retirement rewrite the original note or its provenance. Review
metadata is protected by a separate operation field, `note_review_integrity`
(`v: 1`, `digest`), covering both `note_reviews` and `note_retirements` in order.
It is never nested in `note_integrity`. Both lists are append-only under the
locked whole-context writer; edits, removals and stale writes are refused.
Acknowledging legacy note history cannot accept changed or unbaselined review
metadata. Preserve and inspect that metadata and its recorded baseline.

Collaborators on an earlier client (0.1.0-alpha.12) can share the file: reviews
and retirement sidecars do not enter the v1 note-history digest, and replacement
links contain only `supersedes`, `replacement`, `by` and `at`. Trust leaves the
history digest unchanged. Retirement appends an actual note and link, so it
changes the v1 digest; that digest is identical with or without the sidecars.
The earlier client ignores the additional review fields without reactivating
superseded notes or rejecting retirement links. Its whole-object
`note_integrity` acknowledgement preserves the separate review baseline, so
current readers keep review labels and still detect review tampering.

The operation's `show` JSON includes `review` on note records, with `state` and
a short `label`; the human view identifies this as **Review data**. For example,
`trusted by Alex · no run · limits: "local only"`. A review never upgrades
an evidence class or proves that its text is true. Changed or malformed history
withholds the decision until inspection and labels the note unreviewed.
The same current review data appears in context queries, managed pointers
and MCP note/request delivery; see the comparison rules below.

### Evidence and attribution rules

Both people and agents must attach a run ID to dispute or retire a trusted
note. Ordinary supersession of trusted guidance follows the same rule. Asking
for a run does not discharge earlier trust: trust → run-requested → dispute
still requires a run. Missing or mismatched run references remain explicitly
reported in `evidence_warnings`; attaching one is not a claim that it is local,
in scope or proves the explanation. Labels say `run not on this machine` when
the cited run is unavailable at read time. CLI and MCP reads check current local
availability rather than assuming that attachment-time availability still holds;
an available run is not labeled missing, even if its scope differs.

An agent trusting a note with the same `by` attribution must attach **new local
evidence**. At least one supplied run must be available with known origin,
matching HTTP transport, operation and the selected environment, provider and
contract. Known scope on the original note's evidence must also match. Unknown
required scope cannot establish coverage. Its observation time must be after
the note and all its earlier reviews, no later than this decision, and its ID
must not already have been attached to the note or earlier reviews. New CLI
operation notes retain their authored day in `at` and a precise creation time
in provenance `recorded_at`, both covered by their immutable identity. Legacy
date-only provenance cannot establish ordering within that day: the run must
be later than the end of that UTC day. An exact retry remains idempotent.

`--by` and `--actor` are caller-selected **attribution, not authenticated
identity**. They do not prove who operated the client and cannot prevent a
caller from claiming another name or role. Local evidence metadata is editable;
these checks do not provide signed attestation. Existing operation notes may
also use optional `--by NAME --actor person|agent|imported` when authoring; older notes
keep their attribution unchanged. Self-trust conservatively compares names
even when an older note has no recorded actor.

### Run requests

A `run-requested` decision, from `review`, the `api_note_review` MCP tool or
**Ask for a run** in the Workbench, first saves the review record. It then
appends one `run_request` handoff per note to the repository's run-request
inbox, with or without a workbench open. Its session is the fixed
`wb-00000000-0000-4000-8000-000000000001` under the private, ignored
`.sannr/evidence/workbench/handoffs/`; when that journal is full, the next
request opens `…000000000002`, up to 16 journals. Full journals are never
rewritten. A fresh MCP peer finds it with `api_workbench` `status`, then `read`
and `ack`, exactly like an operator handoff ([workbench inbox](workbench.md#hand-work-back-to-your-agent)).

Each event names the stack, operation, full `sha256:` note identity, the
decision's time and attribution (`requested_at`, `requested_by`,
`requested_actor`), what to check (`check`, the decision's reason), every
environment the claim states with its resolved host name and `production`
marking, and the same verify prompt the Review screen builds, including its
STOP line for a production host. `prompt_claim` is `quoted` when the prompt
quotes the claim. When the quoted claim would break the inbox's bounds or its
URL and private-path rules, the prompt names the note by identity instead
(`by-identity`) and the claim text is read with `api_note_context` or
`show --history`. Events are marked `message_source: "review"` and
`message_trust: "untrusted-data"`. The inbox's secret, private-path, URL,
field and capacity refusals apply; a credential-shaped reason, or one that
contains a credential value from the process environment, is refused as
`SECRET_IN_REVIEW` before the ledger or the inbox changes.

The receipt's `handoff` reports `queued`, `already_queued`, `not_queued` or
`partial`, with each note's session, cursor (`seq`) and any inbox code. If the
handoff cannot be written, the decision stays saved and the receipt names the
code, such as `WORKBENCH_HANDOFF_BUSY`. An exact retry saves no second decision
and records only a handoff that is still missing; it never adds a duplicate.

The label gains `request:` with the status of the latest run request:

| Status | Meaning |
| --- | --- |
| `open` | The handoff is in this repository's inbox and not acknowledged. |
| `acknowledged` | A peer acknowledged through its cursor: received, not completed or evidence. |
| `run attached: run-…` | After the request, a run on this operation was attached as evidence, to a replacement (`note --supersedes … --evidence`) or a new note (`--alongside --evidence`). |
| `no handoff in this repository inbox` | No local handoff, for example in a clone or after a failed write. |
| `inbox unavailable (CODE)` | The inbox could not be read safely; nothing was repaired. |

Only a run that an agent actually made and attached moves a request to run
attached: its evidence must have a known initiator, the same operation and an
observation time after the request. The status comes from the ledger first,
so it also shows in a clone; open and acknowledged come from the local inbox.
Committed managed pointer blocks keep the decision label without the status.
Nothing executes because a run was requested, read or acknowledged; the agent
runs through the shared client under existing policy.

### Retire through supersession

```sh
sannr note "GET /api/user" "The route was removed in this version." --retires sha256:<full-note-digest> --reason removed --actor person --by Alex --evidence run-<id> --json
```

The reason class is exactly `false`, `removed`, `replaced-by-version`,
`no-longer-applies` or `other`. The note text explains that reason. The writer
appends `Retired sha256:<full-note-digest> (<class>): <reason text>` and records
the class and actor in an append-only `note_retirements` record with fields
`replacement` (the replacement note identity), `reason` and `actor`. The link
itself has only `supersedes`, `replacement`, `by` and `at`. The replacement note
retains day-only `at` and precise `recorded_at` provenance, like ordinary notes.
The retired claim leaves active guidance; its full text, original provenance
and reviews remain under `show --history`.
Retirement cannot be combined with `--supersedes` or `--alongside`. Repeating
the same retirement retains the saved replacement and its original evidence.
When omitted, `actor` defaults to `agent` and `by` uses the existing local note
author marker. No new run is required to retire an unreviewed note.

### Equivalent MCP tools

The repository-bound server advertises `api_note_review` and `api_note_retire`
without requiring the workbench or a graph manifest. They are unavailable in
the read-only librarian binding and when `API_CONTEXT_OFF=1`.

| Tool | Required fields | Optional fields |
| --- | --- | --- |
| `api_note_review` | `operation`, `notes` (array of full identities; one item for a single review), `decision`, `by`, `actor` | `limits`, `reason` (required for dispute/run request), `evidence` (run-ID array), `stack` |
| `api_note_retire` | `operation`, `retires` (one full identity), `reason` (reason class), `text` (explanation) | `by`, `actor`, `evidence` (run-ID array), `stack` |

The allowed decision and actor values match the CLI. Both tools return
`requests_executed: 0` and `published: false`. Reviews return `reviews`, `added`,
`unchanged`, `held_back` and `evidence_warnings`. Retirement returns the saved
note identity, explanation, link target and original evidence references.
The next active read uses the retirement. Both MCP and CLI retirement refresh
existing managed blocks and report their outcome separately, like ordinary `note`.

### Stable review refusals

CLI review/retirement refusals use `refused`, `reason` and `next`; `--json`
puts them on stdout. They exit 3, or 2 for `SECRET_IN_REVIEW`. MCP returns the
same receipt with `isError: true`. No refused decision changes the ledger.

| Code | Meaning and recovery |
| --- | --- |
| `NOTE_DIGEST_REQUIRED` | Supply full `sha256:` note identities, never positions or prefixes. |
| `NOTE_DIGEST_CONFLICT` | A selected identity is absent; `current_notes` and `next` list current full identities. Re-read and select explicitly. |
| `NOTE_REVIEW_DECISION_INVALID` | Use `trusted`, `disputed` or `run-requested`. |
| `NOTE_REVIEW_BY_REQUIRED`, `NOTE_REVIEW_ACTOR_REQUIRED` | Supply safe attribution and `person` or `agent`. |
| `NOTE_REVIEW_REASON_REQUIRED` | Supply a dispute reason or what the requested run should check. |
| `NOTE_REVIEW_TEXT_INVALID`, `SECRET_IN_REVIEW` | Remove unsafe markup, controls, overlong text or credentials. Rejected text is not echoed. |
| `NOTE_REVIEW_INVALID` | Unsupported/mixed fields, invalid operation or invalid batch shape. |
| `NOTE_REVIEW_EVIDENCE_REQUIRED` | Attach a run before overturning trusted guidance, whoever decided. |
| `NOTE_SELF_TRUST_EVIDENCE_REQUIRED` | Attach new evidence before trusting your own agent-authored note. |
| `NOTE_SELF_TRUST_EVIDENCE_UNAVAILABLE` | A supplied ID lacks readable local evidence with known origin. |
| `NOTE_SELF_TRUST_EVIDENCE_SCOPE` | No available run establishes the required scope coverage. |
| `NOTE_SELF_TRUST_EVIDENCE_OLD` | No covering run is new, unused and dated within the required interval. |
| `NOTE_REVIEW_REPLACED` | Trust targets an authored-replaced note; inspect the named replacement. Batch trust reports this in `held_back`. |
| `NOTE_REVIEW_HISTORY_CHANGED` | Preserve and inspect the review sidecars and their separate baseline; legacy history acknowledgement cannot accept their changes. |
| `NOTE_RETIRE_REASON_REQUIRED`, `NOTE_RETIRE_TEXT_REQUIRED`, `NOTE_RETIRE_INVALID` | Supply a supported retirement class and explanation, with one identity and no conflicting relationship flags. |
| `NOTE_ALREADY_SUPERSEDED` | A different replacement is already recorded; select its identity. |
| `EVIDENCE_ID_INVALID` | Use at most 16 exact run IDs, never paths. |
| `EVIDENCE_ROOT_UNSAFE`, `EVIDENCE_ROOT_UNAVAILABLE`, `EVIDENCE_FILE_UNSAFE`, `EVIDENCE_FILE_CHANGED`, `EVIDENCE_TOO_LARGE`, `EVIDENCE_RUN_ID_MISMATCH` | Preserve the evidence and resolve its unsafe directory/file, concurrent change, size or identity mismatch. No private bytes are returned. |
| `NOTE_BASELINE_REQUIRED`, `NOTE_HISTORY_CHANGED`, `NOTE_HISTORY_INVALID`, `NOTE_HISTORY_PROTECTED` | Existing history integrity protections still apply; inspect the complete history before explicit baseline acceptance. |
| `CONTEXT_NOTE_CONFLICT`, `CONTEXT_WRITE_CONFLICT`, `CONTEXT_WRITE_LOCKED` | Another writer changed or locked the store. Re-read before retrying. Unrelated-operation changes may rebase; a target-operation change refuses. |

## Facts shared by a stack

Write a lesson once when it applies throughout an API:

```sh
sannr note --stack billing --scope stack "Documented: errors include a stable code; assert on code."
sannr note --stack billing --scope stack "Documented: writes use form encoding." --operations "POST /invoices" "POST /payments" --alongside --evidence run-<id>
sannr show --stack billing --human --history
```

Without `--operations`, a fact applies to every operation in that stack. Supply
exact contract operation keys for a restricted fact. Attribution, tense prefixes,
secret checks, relationship choices and evidence rules are the same as operation
notes. Supersession does not inherit the old fact's operation restriction: state
`--operations` again when the replacement remains restricted. A changed
restriction makes a distinct claim even if the wording matches.

The file stores stack facts in additive `stack_facts` note history. Each restricted
fact's original provenance carries its `operations` list, covered by the same
immutable note identity and integrity baseline. Older clients (0.1.0-alpha.10)
read the file and keep this field during ordinary writes, but do not deliver
stack facts; upgrade them to receive stack facts. No migration is required.

Requests put up to five applicable stack facts before operation notes in `known`.
The receipt counts omitted facts and names the exact `show --stack` command.
Managed stack sections put those facts first without changing operation lines.
Changed or malformed stack history withholds its facts from requests until
reviewed; an edited operation list must not silently broaden applicability.
`show --stack` provides their complete history. `context query query.json --stack
billing` searches them with an optional `{"search":"error code"}` or filters
applicability with `{"operation":"POST /invoices"}`. These are local reads.

To acknowledge a reviewed stack-history baseline:

```sh
sannr review --stack billing --scope stack --accept-notes --if-notes sha256:<current-history-digest>
```

When `api_context_record` is already available in a configured graph binding, it
also accepts `scope: "stack"`, `stack`, `note`, optional `operations`, exact run
IDs in `evidence`, and either `alongside: true` or `supersedes`. This uses the
same note writer. The next request reads the saved fact; its receipt names
`connect` to refresh managed instructions. Stack facts travel in the committed
knowledge file; graph snapshots do not yet export them. Recording does not
execute a request or publish anything. Credential-specific lessons belong in account scope, described below, rather
than shared stack facts.

## Facts about one account

Account facts use the same note identities, provenance, supersession and secret
checks as operation and stack facts. Their key adds the selected environment
and configured credential reference to the stack. Sannr never keys a fact by
a credential value.

```sh
sannr note --stack billing --env staging --scope account "Trial account; organization writes are unavailable." --evidence run-<id>
sannr show --stack billing --env staging --scope account --human --history
sannr note --stack billing --env staging --scope account "This shared project key cannot read organization endpoints." --shared
```

The default write is private, under the project's ignored private directory,
with private file and directory permissions. `--shared` is an explicit opt-in
to committed account knowledge; it includes the reference name and authored
fact, never a credential value or fingerprint. A private fact is not promoted
by making a request, connecting the agent, or writing an unrelated shared note.
Default inventory views and managed instructions do not expose private facts.
Use `show --scope account` to inspect them locally. Private and shared records
have separate histories: omitting `--shared` later does not remove or demote an
existing shared claim. Keep `--shared` when correcting or reconfirming that
shared record; an explicit private write may coexist with it.

Requests return up to five facts matching their stack, environment and credential
reference, labeled as account facts with the authored date and linked evidence.
Omitted facts retain their count and the exact scoped `show` command.
A retained observation supports only the request recorded in that environment;
it does not prove an account tier or permission explanation. No account facts
are inferred or accepted automatically.

A per-machine salted fingerprint binds the local confirmation to the current
credential. The fingerprint and salt never enter the shared knowledge file.
Changing the value marks each affected fact **credential changed since
observed**. A missing credential is named as missing. A shared fact first read
on another machine is unconfirmed until that machine explicitly records its
own confirmation. These states qualify the claim instead of deleting it or
silently treating it as universal guidance.

After checking that the fact still applies, repeat the same `note --scope
account` command (and `--shared` for a shared fact) to reconfirm it locally.
This keeps the existing note identity and authored history; ordinary requests
and `show` reads do not refresh confirmation. For a changed lesson, use
`--supersedes` or `--alongside` with the account view's full note identity and
supply the new evidence explicitly, just as for other note kinds. Changed or
invalid authored history is withheld from normal delivery; `--history` keeps it
inspectable with the integrity issue named.

## Review unknown or changed history

`show` and `doctor` inspect raw arrays, attribution, markers, identities and
replacement relationships and review records. Malformed present structures fail integrity;
missing legacy attribution or baselines remain warnings with unknown prior
integrity. A versioned digest covers note text, original provenance, machine
markers, authored relationships and present review records. A mismatch says the history differs from
its recorded baseline; it does not identify who edited it or when.

Inspect the complete record before explicitly accepting its current digest:

```sh
sannr show "GET /api/user" --human --history
sannr review --accept-notes "GET /api/user" --if-notes sha256:<current-history-digest>
```

Acceptance records who, when, the previous baseline and the accepted digest.
It cannot recover deleted content or certify earlier history. Diagnosis does
not repair or reseal notes, and note edits against changed, malformed or
unbaselined history are refused. Unrelated writes preserve the suspect history
and its baseline. This is an integrity warning in a writable repository, not
an immutable audit log.

## Attach request provenance

`--evidence run-<id>` is repeatable up to 16 local run IDs. It resolves regular,
bounded local evidence files and stores only their digest, producer, transport,
observation time, package/build identity and available operation/environment
scope. It never promotes request headers, bodies or credential values. Missing
runs are unavailable; known scope mismatches are explicit. Legacy runs without
producer metadata remain unknown. `cli.learn`, `cli.doctor`, `cli.request` and
`mcp.api_request` are distinct initiating paths even when they share the client.
Local metadata is editable; a digest binds the bytes read, not their truth.

Each replacement carries only the evidence explicitly supplied for that new
record; superseded evidence remains on the historical note and is not
inherited. Every receipt includes an `evidence` array, even when it is empty,
and `evidence_attachment` explains whether this invocation saved references or
returned an unchanged record. Repeating a replacement returns its original
saved evidence without appending new references. On a retry,
`requested_evidence_warnings` describes the newly requested references, which
were not attached; the saved references keep their own availability and scope
labels. New writes use `evidence_warnings` for the references they saved.

Supported credential references such as `bearer:ENV_NAME`,
`header:Authorization:ENV_NAME`, `query:api_key:ENV_NAME`,
`basic:USER_ENV:PASS_ENV` and
`oauth:CLIENT_ID_ENV:CLIENT_SECRET_ENV` may appear in prose. Incomplete forms,
unsupported `basic:ENV_NAME` and actual token-shaped credentials remain guarded.
The guard never reads environment values.

Never edit the knowledge JSON by hand. Use supersession or an alongside note;
if the CLI cannot express the change, preserve the contradiction and report
the gap through `feedback`. Scoped client observations and imported test claims
remain separate from these authored operation notes.

## Evidence classes and contradictions

Every active note has current review data in human and JSON `show`,
`context query`, managed instruction blocks and MCP note/request delivery:
`unreviewed`, `trusted by … · no run` (or explicit run IDs and limits),
`disputed by …` with its reason, or `contradicted since trusted` with the
later run IDs. Run requests retain the `run-requested` decision and display
`unreviewed · run-requested`, including what to check and the request's status
(see below). Reviews, limits,
sources and note text are untrusted data; none grants instructions or permission.
Disputed notes remain active. Delivery budgets count omitted notes and keep
the review label attached to each delivered note; full review histories are
not repeated in request context.

The **since trusted** label is historical: a complete client observation must
postdate the trust, match the operation, environment, provider and contract,
and cover the scope explicitly attached to the note. Bounded mentions of
declared environment names in the claim can narrow coverage. Only bounded status
comparisons and already recorded error-code flags are supported. Earlier,
future, incomplete and out-of-scope observations do not overturn the label.
An environment pointing at a production host under a test label does not
establish coverage. Saved observation metadata permits the same comparison in
a clone without private run files. It does not claim a fresh check or create
a dispute, correction or retirement automatically.

Retirement delivery includes the retired full identity, old claim and reason;
the original authored bytes stay in `show --history`. Correction links come
only from authored `note_replacements`. Correction-like prose is an unlinked
suggestion, never a relationship. `NOTE_BOTH_TRUSTED` warns when a predecessor
and its authored correction are both trusted. The predecessor is already
retired from active guidance by supersession: the CLI offers an explicit
`review --decision disputed --evidence run-ID` path to retire its remaining
trust. It does not append a conflicting second replacement link.

## Record basis and source

```sh
sannr note "GET /items" "Documented: pagination uses a cursor." --basis documentation --source https://docs.example.test/items
sannr note "GET /items" "Observed: the response included a cursor." --alongside --basis observed-run --source run-example --evidence run-example
```

The nine CLI kinds are `asserted-run`, `observed-run`, `earlier-run-report`,
`contract-openapi`, `documentation`, `documentation-change`, `local-source`,
`declared-metadata` and `client-tooling`. New provenance stores `basis` and
optional `source`. A source can name a run ID, a repository-relative file and
digest, or a documentation URL. It is never fetched. Credentials, URL query
values, machine-local paths and malformed metadata are refused before a write.
`--source` requires `--basis`. Duplicate retries preserve and report the
original basis/source; they never relabel an existing note.

Older notes get a basis from their opening words only, always marked
`inferred`. For example, “Historical prep report” means `earlier-run-report`,
“Written-down from docs” means `documentation`, and “Client limitation” means
`client-tooling`. Unrecognized openings stay `unknown`. Inference is never
written to provenance. Authors have separate `person`, `agent`, `imported`
and unknown categories. `note --actor imported` records an import/summary
tool explicitly; legacy import/summary author names are inferred as imported.
Review deciders remain people or agents.

Shared lanes identify covered kept runs, out-of-scope runs, earlier runs with
nothing kept, documentation, code/local tests and client/tooling notes. Unknown
basis has an honest unclassified lane. A kept run is rechecked locally; missing
or changed bytes cannot count as kept coverage. Run support states its depth:
`full-run`, `ledger-summary` or `run-id-only`. Production-host mislabels are
grouped by cause and environment, naming every affected stack. These are
diagnostics, with no change to request permissions.

`show` keeps its existing raw arrays and adds the review model under
`note_projection.records`: active records, lane counts and progress, separate
author counts, basis and source groups with explicit stack, operation and note
identities, production-host causes and authored correction conflicts. Context
queries expose bounded `note_context` records and an omission count. Batch trust still takes explicit identities and
retains its corrected-note `held_back` receipt.

## Current execution evidence

The current operation summary assigns one class in the selected stack,
environment and contract scope: **written**, **observed**, **asserted** or
**verified**. Written means inventory or authored guidance without current
countable execution support. Observed means a retained response with matching
local evidence; it includes failed responses and does not mean success.
Asserted requires fresh passing client assertions. Verified refers to current
`learn` verification. Later failures, stale observations, missing evidence and
changed evidence cannot borrow an older positive result. Response-history
qualifiers and legacy learning fields remain available separately.

Notes are ordered by their own supporting evidence class, then date. Stack
facts still precede operation notes. A linked request does not prove the prose's
explanation, even when that request passed assertions. Unsupported or missing
references leave an authored claim written rather than silently upgrading it.
Raw saved history retains its order and every superseded record.

Only bounded, explicit status or error-code statements are compared with the
latest matching observation. Arbitrary prose is not semantically interpreted.
Contradiction flags identify the original note; they do not edit its words.
Error-code flags are derived while the response is in memory and retain a note
identity and category, not the returned value. Older observations without this
metadata cannot establish an error-code comparison. Missing, changed or stale
evidence cannot supply a current contradiction flag.

## Review and accept a proposed note

For a resolved HTTP operation, the client can return `draft_notes` when the
response disagrees with the selected OpenAPI contract. Supported signals include
an undeclared status, a 400 or 422 naming a directly declared optional field as
required, an unknown parameter, and an explicit missing beta-header requirement.
Recognition uses bounded field names and error-message patterns; it does not
interpret arbitrary prose or every composed schema. These
are suggestions about one observed response, not proof that every caller must
follow the proposed rule. Unstructured provider text is not copied into a note
or treated as instructions.

```sh
sannr note --stack billing --env staging --accept-draft draft-<id>
sannr note --stack billing --env staging --accept-draft draft-<id> "Observed: the response rejected this field." --alongside
```

The draft stays under the stack's private evidence directory until you explicitly
accept it. Acceptance verifies its stack, environment, provider, contract and
original evidence before using the ordinary note writer. It refuses mismatched
or modified evidence. Existing authored guidance still requires `--alongside`
or `--supersedes`; an edited suggestion still passes the secret and history
checks. Repeating the same acceptance does not create a second note. Correct an
already accepted note through normal supersession rather than changing the
same draft's meaning.

When one client process observes the same error code on two different operations
in the same scope, it can suggest a stack fact restricted to those operations.
This does not infer a trial tier, billing state or universal account restriction.
Separate CLI invocations are separate sessions for this correlation. Account
facts require explicit account-scope authoring; the draft does not infer them. Non-HTTP protocols do not acquire an OpenAPI
contradiction claim by analogy, and disabling context capture also suppresses
draft generation. No additional request is made to produce a draft.

`known` describes knowledge saved before the request. A contradiction captured by
that request appears immediately in `show`, and in `known` on the next request.
`draft_notes` describes the response just received. If a draft's frozen evidence
is missing or changed, accepting that draft refuses; a later response can create
a new evidence-bound draft without replacing the old receipt.

These counts follow the existing HTTP inventory in each stack. Authored scoped
operations remain in the inventory as written when no environment resolves.
A captured path absent the bound contract stays scope-unresolved; unrelated
protocol histories are not silently treated as HTTP contract observations.
