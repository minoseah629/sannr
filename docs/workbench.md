# Local Sannr workbench

The workbench shows what this repository's `.sannr/` stacks already hold: each
note an agent or a person recorded about an API operation, the evidence it rests
on, and the source survey of which code defines which operation. It reads the
stack files, ledgers, contracts, `graph/survey.json` and run-file metadata. It
also lists the requests recorded on this machine and lets you send one
yourself. Opening or reading the page never sends an API request; one goes out
only when you choose **Send request** in the Request view. A coding agent is
optional.

There are two ways to open it, and both show the same page: ask for it in one
step (`workbench open`, or your coding agent), or launch it in an interactive
terminal and pair the browser with a typed code. The examples on this page
write `sannr`; with an npx install that is `npx @sannr/sannr`, and with a
repository-local install `./node_modules/.bin/sannr`.

## Open in one step

Say **“open the workbench”** to a coding agent that has Sannr set up, or run:

```sh
npx @sannr/sannr workbench open
```

This starts the repository's workbench as a background process on this machine,
or reuses the one that is already running, and asks the system opener for a
connected page in your default browser. It needs no interactive terminal and no
pairing code, so it also works from an agent's shell or a script, and through
the `api_workbench` MCP tool as `{"action":"open"}`. Opening sends no API
request and writes nothing to the stack files.

**Which repository.** `open` acts on the checkout it is run in: the Git top
level of the current directory, else the directory itself. `--project <path>`
names another local checkout instead. A coding agent chooses the checkout from
what you asked: a repository you named, else the one the conversation is about,
else the current directory, and it asks when two are equally likely. The
`api_workbench` tool opens only the repository its MCP server is bound to. Given
a `project` that is a different checkout it refuses with
`WORKBENCH_REPOSITORY_MISMATCH` and opens nothing; the agent then runs
`workbench open --project <path>` for that checkout. Nothing rebinds the server.

**Several at once.** Each checkout has its own background workbench on its own
port. Two checkouts with the same folder name, and linked worktrees of one
repository, are separate. Opening a second repository leaves the first one
running, and each page shows only its own repository.

**Opening again.** A second `open` for the same checkout reuses its running
workbench and opens another tab. Tabs that are already open stay connected,
with their drafts, filters and selection as they were.

**What the result says.** With `--json`, and from the MCP tool, the result is
one object:

- `repository`: the folder name and the full path of the checkout that opened.
- `instance.state`: `created` or `reused`, with its ID and when it started and
  will stop by itself.
- `url`: the plain local address, such as `http://127.0.0.1:53148/`. It
  carries no access; see below.
- `browser.state`: `dispatched` (the system opener accepted the request),
  `failed`, `unavailable` or `not-requested`.
- `page.state`: `connected` when the opened page reached the workbench within
  about four seconds, else `not-observed`. An accepted opener request does not
  show that a page rendered, and the result never says it does. When no page
  was opened it is `not-requested` (`--no-open`) or `not-opened` (the browser
  could not be opened).
- `stop`: the command that stops this checkout's workbench.

Without `--json` the same facts print as a few lines.

**Options.** `--view workbench|activity|request|map` opens on that view.
`--operation "<METHOD /path>"`, with `--stack <name>` when the repository has
named stacks, opens that operation on the Workbench view. A value that cannot
be used is ignored and named under `context.ignored`; it never changes which
repository opens. `--no-open` starts or reuses the workbench without opening a
browser.

**Reload and new tabs.** Reloading a connected tab keeps it connected. A new
tab opened on the plain URL is not connected: it shows a screen that says to
ask your agent or run `workbench open`. Only a launch connects a tab.

**Stopping.** `sannr workbench stop` stops this checkout's workbench and no
other (`--project <path>` for another checkout). `sannr workbench status` says
whether one is running, its URL and how many pages are connected. Left alone,
a background workbench stops 30 minutes after the last request from a page (an
open page checks in once a minute) and after eight hours in any case. It also
stops within seconds if its folder under `.sannr/evidence/workbench/launch/`
is deleted, for example when the checkout or worktree is removed, and it does
not create that folder again. Closing a tab stops nothing by itself. After it stops, tabs that were open show the
not-connected screen; `open` starts it again, on a new port, in a new tab. In
a process list the background workbench is the CLI running
`workbench serve --project <path>`; `open` starts that, and it is not meant to
be run by hand.

**When it cannot open.** Each of these is a named result, and none falls back
to another repository:

| Code | Meaning | What to do |
| --- | --- | --- |
| `WORKBENCH_PROJECT_NOT_FOUND` | The path names no directory. | Name an existing local checkout. |
| `WORKBENCH_PROJECT_NOT_CONFIGURED` | The checkout has no Sannr files. Nothing was created there. | Run `sannr connect` in it first. |
| `WORKBENCH_OPENER_UNAVAILABLE`, `WORKBENCH_OPENER_FAILED` | The system opener is missing or reported a failure. The workbench is running. | Run `workbench open` again where your browser is, or use the terminal launch below. |
| `WORKBENCH_BROWSER_UNAVAILABLE` | A Linux session with no display. The workbench is running. | Open it from a desktop session on that machine. |
| `WORKBENCH_SERVICE_UNRESPONSIVE` | The background process did not answer. Nothing was stopped. | Retry; if it persists, check the named process yourself. |
| `WORKBENCH_LAUNCH_BUSY`, `WORKBENCH_SERVICE_START_FAILED`, `WORKBENCH_SERVICE_START_TIMEOUT` | Another open is still starting, or the process did not start. | Open again. |

Less common codes (`WORKBENCH_LAUNCH_GRANT_FAILED`, `WORKBENCH_LAUNCH_UNSAFE`,
`WORKBENCH_STOP_FAILED`) carry their own next step in the result.

The browser opens on the machine that runs the command. In a shell reached over
SSH the result also carries `browser.remote_session: true`. Opening a browser on
a different machine than the workbench, through a tunnel or otherwise, is not
supported.

The background workbench keeps the environment of the command that first
started it. A stack that reads a credential from an environment variable finds
it there or not at all; if a send reports a missing credential, stop the
workbench and open it from a shell that has the variable.

## Launch in a terminal and pair

From the repository root, run the CLI in an interactive terminal:

```sh
npx @sannr/sannr workbench
```

This is a separate workbench that the terminal owns. `workbench open` does not
reuse it, and the two can run side by side.

The command opens the default browser: with `open` on macOS, `xdg-open` on
Linux, and on Windows with PowerShell's `Start-Process`, which receives the URL
through an environment variable rather than as command text. If the opener
cannot start, the terminal asks you to open the printed URL. Use `--no-open` to
open the printed local URL yourself. Without an interactive terminal (a pipe, an agent's shell)
it refuses with `WORKBENCH_TERMINAL_REQUIRED` and names `workbench open`. The listener is IPv4 loopback only, on an
ephemeral port. The URL contains no authority and may be printed normally.
Each launch creates an operator session ID for its handoff journal. To continue
an earlier inbox in the same repository, pass `--session wb-SESSION_ID` using an
existing journal's exact ID. This selects retained work, not a coding agent.
You can open and use the workbench with no coding agent running.

1. Request a pairing code in the browser.
2. Type that code at the running terminal's `Pairing code:` prompt.
3. When the terminal says **Browser connected. Workbench ready**, return to the
   browser. The terminal waits quietly; it asks for another code only when a
   browser requests a new pairing.

Typing at this prompt does not put the code in shell history. Pairing needs the
local interactive terminal; pipes, unattended approval and tunneled browser
hosts are unsupported. A browser reload requires pairing again. Opening or
pairing reads no vendor API and changes no project binding.

Keep the terminal open while using the workbench. Ctrl-C or closing its input
disconnects the browser. Browser authority expires after 15 minutes without an
operator action, with an eight-hour maximum lifetime. When pairing ends, the page
returns to the pairing screen; choose **Get a new code** and enter it in the
running terminal. A response you were writing stays in the tab. A closed or
unreachable terminal needs to be relaunched.

## What the page shows

The header reads **Sannr Workbench** or **Sannr Map**, then the API name, then a
**Workbench | Activity | Request | Map** switch and a round settings button.
Once connected, the browser tab's title starts with the repository's folder
name, so tabs for different repositories can be told apart.
The page opens on the Workbench view.

### Workbench view

Three columns. Drag either inner edge to resize the columns (left 220 to 600
pixels, right 260 to 680); double-click an edge to reset. Widths are kept on
this machine. Below 880 pixels wide the page scrolls sideways.

- **Left: the notes.** Stack chips with the number of notes that match the
  current filter and basis (a stack with no notes is faint and cannot be
  chosen); filters **All**, **In scope**, **Mismatch**, **No run**, **Agent** and
  **People**; and **Note basis** chips (observed, asserted, local source,
  rehearsal, client, note). The list groups notes by stack, or within one stack
  by the contract's tag or the first path segment. A green square means every
  attached run is in scope, amber means a run is out of scope, hollow means no
  run is attached. **responded** marks notes you answered. The view opens on
  **Mismatch** when any note is a mismatch, otherwise on **All**.
- **Middle: one note.** The operation, its author, date, basis, stated
  environment and stack, the note text and a status line; other notes on the
  same operation; **Add notes**, where you save a response; **New note on
  this operation**, which writes a note to the ledger beside this one;
  **Review decision**, where you record trust, a dispute, a request for a run
  or a retirement (below); and
  **Verify** or **Re-verify** with a prompt to copy into your coding agent. **J** moves to the
  next note and **K** to the previous one when no text box has focus. A note on
  a GraphQL operation (`query Name`, `mutation Name` or `subscription Name`, as
  `note` and the GraphQL adapter record it) opens the same way; its trace has no
  contract declaration, because an OpenAPI contract declares no GraphQL
  operation.
- **Right: the trace.** From the claim back to the contract: the claim, the
  evidence run the ledger links (its recorded state), the run's scope against
  the ledger's contract digest, the shared observation of that run if one
  exists, and the contract declaration. A hollow step means that record is
  absent; existing review records appear under the claim.

A basis recorded with the note wins; otherwise it is inferred from the note's
opening words and shown the same way.

### Your review and responses

The **Your review** block in the header counts the notes in the current filter
that have a response from you. Click it for **Next note without a response**,
the list of saved responses, and **Copy prompt for all responses**: one prompt
that asks your agent to write every saved response back to its note through the
product.

Responses are saved on this machine in the private, ignored
`.sannr/evidence/workbench/responses.json`, keyed by the note's full identity.
They never change `sannr.json`. A response that looks like it holds a credential
is refused and nothing is saved. Until ledger write-back exists, the **Send
responses** prompt is the way a response reaches the ledger.

### Activity view

Three columns, resized like the Workbench view's.

- **Left: recorded requests.** Every request this machine's ledger retains,
  newest first, grouped by caller and time: requests sent through Sannr by a
  coding agent (the `api_request` tool), the command line or this page. A
  caption gives the ledger's totals. Filters: **All**, **Failed** (an HTTP
  status of 400 or more, a failed check, a refusal or an error), **Coding
  agent**, **Command line** and **Workbench**. The caller is the recorded
  initiator; the command line is not assumed to be a person, because an agent's
  shell uses it too. A green square means a response was recorded, red a
  failure, hollow no response. The list shows at most 100 requests in 20 groups
  and says when older ones are not listed. A fresh clone starts empty, because
  run evidence is not committed.
- **Middle: one request.** Its operation, caller, time and stack, and a status
  line with the HTTP status and whether any check ran. A recorded response is
  not a passed test, and the line says so. **Show response** reads the retained
  response for that run once: the body with credentials masked, and its
  displayable headers. Listing and selecting never read a body. **Open in
  Request** reopens the request as a draft in the Request view; **Open its
  notes** opens the operation on the Workbench view.
- **Right: details.** What the ledger recorded: the caller, the request, the
  response and its receipt state, the checks, the notes delivered with the
  call, and what it produced (a shared observation, knowledge drafts, drift
  records, notes written).

Activity describes requests made through Sannr. It cannot see a call made with
curl or an SDK.

### Request view

Send a request by hand, change a value and send it again, then save it for
reuse. Three columns, resized like the Workbench view's.

- **Left: what you can send.** Stack chips, the stack's environments
  (production ones are marked), the saved requests for the stack, and its
  operations with the same squares as Activity. **Another endpoint** takes a
  method and a path; with a contract bound, the path must be one the contract
  declares.
- **Middle: the request.** Choosing an operation builds a draft from the
  current contract: its structure and required fields, never examples, defaults
  or credential values. Building a draft sends nothing. Each field shows where
  it goes (path, query, header or body) and its type. A string is sent as
  typed; any other type is entered as JSON. A field the draft marks sensitive
  is masked until you choose **Show**. **Send request**, or Enter in a field,
  sends the request once through the same client, credentials and production
  policy as the CLI and the MCP tool. A missing value is named and nothing is
  sent. Entered values stay in the tab, so you can adjust one and send again;
  they are dropped when you choose another operation and are never written to
  a file. A production environment shows a warning line above the fields.
- **Advanced request structure** shows the draft's bindings as JSON. Add an
  optional header, query parameter or body field by binding it to an input,
  `{"$input":"name"}`, then choose **Update the fields**. **Save for reuse**
  writes the structure to `.sannr/requests/<folder>/<name>.json` (see
  [saved requests](saved-requests.md)). A saved request can be changed, renamed
  or moved, and deleted after a second confirmation; its execution history
  stays.
- **Right: the response.** The HTTP status, whether any check ran, the
  round-trip time from the page, and the recorded response: the body with
  credentials masked and the displayable headers, read once from this machine's
  private evidence after the send. Below it, the run identifier and where it
  was recorded. A request reopened from Activity shows its earlier result and
  says nothing was sent again; its body is read when you choose **Show recorded
  response**.

The Request view treats an empty field as missing, so it cannot send an empty
string as a value.

### Map view

The Map draws the retained `graph/survey.json` as five columns: contract, stack,
operation, notes and runs, and the file that defines the operation. Operations
of vendor stacks, which no code references, are hidden; their stack box is
dashed and the coverage footer counts them. Select a box to highlight its links
and see its details, connections and notes in the side panel. The legend's
groups are separated by thin vertical rules. An operation's square is green when
it succeeded, red when it errored, solid gray when it was requested but no
result is recorded (its runs are only ledger links or run files without a
status), and an outline when it was never requested. Run counts come from note
evidence links and from run-file metadata (run ID, operation, status and time;
never bodies, headers or inputs).

**Open on Workbench** appears for every operation box and every notes-and-runs
box. An operation with notes opens its first note. An operation with no notes
opens the operation view: the list keeps its filters with no row current, the
middle column names the stack and the defining file, opens **Write a note**,
and below it offers the **First note** prompt (the agent tests the operation,
records the run and writes the note through Sannr), and the trace runs from the operation through its recorded
runs, newest first, to the contract. The prompt carries the production STOP
line when any of the stack's environments is production. Choosing a row, or J
or K, leaves the view. If a note on the operation is written meanwhile, the view
stays and offers **Open its note**.

**Copy remap prompt**, under Coverage and beside the line shown when there is no
survey or it cannot be read, copies a prompt that has the agent run
`sannr survey generate` from the repository root, then `sannr survey status`,
and report what changed against the snapshot the page shows. The Map is read
again when the window regains focus.

Without a survey the Map shows one line naming `sannr survey generate`. Opening
the Map never generates a survey, scans code or calls an API.

### Writing a note by hand

**Write a note** in the operation view, and **New note on this operation** under
a note, save what you know straight to the ledger, whether or not the operation
has notes yet. This is how knowledge that lives only in people's heads gets
into the API context. The note is written as `sannr note --actor person` writes
it: attributed to the author marker the line under the box names (`API_AUTHOR`,
else `git config user.name`, else `agent`), dated today, with no evidence
attached, and saved alongside any notes already there. Nothing is superseded,
retired or reviewed. The box takes the same text `sannr note` takes, tabs
included. The CLI's refusals apply: a note that looks like it holds a
credential, comment markup, a note over the length limit, a note history that
needs reviewed acceptance, and a write that raced another. A refused note saves
nothing: it stays in the box with the reason below it. If the write fails for
another reason, the page cannot promise that nothing was written, so check the
operation's notes with `sannr show '<METHOD /path>' --stack <name> --history` before saving
again. After a save the list is read again and the new note is selected with the
filter on **All**. Responses, by contrast, stay on this machine until your agent
writes them back.

In a repository with no named stacks (the single-store layout) the ledger takes
no notes until migration, from the CLI or the page, so both boxes are drawn
disabled with a line naming `sannr migrate --dry-run`.

### Recording a review decision

**Review decision**, under a note, shows the note's current review (or
"unreviewed") and opens four choices. Each is written to the ledger through the
same functions as `sannr review` and the `api_note_review` MCP tool, attributed
to the author marker (`API_AUTHOR`, else `git config user.name`, else `agent`)
as a person. Recording a decision sends no API request.

- **Trust** records `trusted`, with optional limits such as "local only" or a
  version.
- **Dispute** records `disputed` and needs a reason. Overturning a note that
  was trusted also needs a run ID as evidence; the page shows the refusal and
  keeps what you typed.
- **Ask for a run** records `run-requested` with what to check, and queues a
  run request in the repository inbox for an agent. Nothing runs because a run
  was requested.
- **Retire** adds a retirement note that supersedes this one. Choose why
  (false, removed, replaced by a version, no longer applies, other) and say
  why in a sentence. The first press only asks; the second writes. The
  retirement note is then selected in the retired note's place.

Trust, Dispute and Retire take optional run IDs as evidence. A refusal writes
nothing and is shown with its code. Batch decisions and superseding one note
with another remain with `sannr review` and the `api_note_review` MCP tool. In
a repository with no named stacks the choices are drawn disabled, as the note
boxes are.

### Settings

The settings popover has **Appearance**: Light (the default), Dark or System. The choice is
kept on this machine in `.sannr/evidence/workbench/appearance.json`, beside the
column widths. Instrument Sans and JetBrains Mono are bundled with the package
(SIL Open Font License 1.1); the page loads no font, script or style from the
network.

## Where the earlier screens went

The Activity, API map, APIs, Request, Agent handoff, Review and Settings screens
were replaced by the views above. Their functions also remain available headlessly:

| Earlier screen | Where it is now |
| --- | --- |
| Review decisions (trust, dispute, retire, ask for a run, batches) | Trust, dispute, ask for a run and retire under a note on the Workbench view; batches and supersession with `sannr review` and the `api_note_review` MCP tool; review records show in the trace |
| Activity and the agent session view | The Activity view lists recorded requests; a whole agent session reads with `sannr sessions` and the session summary an agent quotes |
| API map | The Map view, drawn from the same retained survey |
| APIs and operation detail | `sannr show '<METHOD /path>'`, notes on the Workbench view |
| Request runner and saved requests | The Request view; also `sannr saved` and the `api_saved_requests` MCP tool |
| Agent handoff and presence | The repository inbox through the `api_workbench` MCP tool (below) |
| Settings (Slate, Paper and Ink themes) | Removed; the settings popover offers Light, Dark or System |

`--show last-session` and `--show <session id>` are still accepted by the
terminal launch, `sannr workbench`; the page has no session view, so read the
session with `sannr sessions`.

## Headless: the repository inbox

Run requests and agent handoffs wait in this repository's local inbox for any
later agent; the page does not write to it.

The local inbox does not wake an idle model. Say **“Pick up my workbench
handoff”** in the agent conversation. A compact notice also accompanies its next
ordinary Sannr MCP tool result when work is pending. The agent uses `status` to
find inboxes, `read` with a session ID and cursor to retrieve them, then `ack`
with the returned cursor. Acknowledgment means **received**, not completed.
Read and acknowledgment are distinct. A new agent can find older inboxes in the same repository after the original host exits. `status`,
`read` and `ack` do not require the reading agent to attach presence first.

```json
{"action":"status"}
{"action":"read","session":"wb-SESSION_ID","after":0,"limit":20}
{"action":"ack","session":"wb-SESSION_ID","through":3}
```

Recording `review --decision run-requested`, or the same decision through the
`api_note_review` tool, writes a `run_request` handoff to the
repository's run-request inbox, `wb-00000000-0000-4000-8000-000000000001`,
whether or not a workbench is open. It carries the note identity, what to check,
the stated environments with their resolved host and production marking, and
the Verify claim prompt. The claim's label and its trace show the request as
open, acknowledged or run attached. Nothing runs because someone asked; see
[run requests](note-history.md#run-requests).

Substitute the real ID and the cursor actually returned. Read pages in order;
the tool refuses acknowledgment of a range this peer did not retrieve. Inboxes
live under private, ignored `.sannr/evidence/workbench/handoffs/`, not shared API
knowledge. Each is limited to 1,000 events or 256 KiB. At capacity, existing
records remain and new entries are refused. Review pending work and launch a
new workbench session. Concurrent writes use a per-session lock; a crash may
leave that lock behind. Only remove a leftover lock after confirming no writer is active.
Never repair malformed history by deleting pending records.

## Headless: saved requests

`sannr saved` and the `api_saved_requests` MCP tool create, edit, rename, run and
inspect saved requests. Only structure, typed input
declarations, credential references and allowed source attribution are written
to `.sannr/requests/`; runtime values are not saved. Rename/move keeps the stable
request identity. Delete removes the recipe while retaining execution history.

A teammate can commit the recipe with the relevant stack configuration and
knowledge. Their clone can list and open it even though private evidence and
local inputs did not travel. After supplying their own environment and values:

```sh
sannr saved list --stack example --env local
sannr saved show examples/lookup
sannr saved run examples/lookup --inputs-stdin < local-inputs.json
```

Keep the input file local and ignored. `--inputs-file` additionally verifies
that the source is inside the repository, untracked and gitignored. Declared
environment references are another supported source; current authentication
variables remain in stack credential bindings. Never type sensitive values in
command arguments. The `api_saved_requests` MCP tool exposes the same headless
actions. A saved operation may advertise a small, byte-accounted reference in
ordinary request context; `API_CONTEXT_OFF=1` disables that advertisement.

The workbench does not provide a secret store. Provision credentials through
the stack's existing local environment source; saved requests name credential
references only, never values. Saving a recipe does not authorize its
future execution, change environments or create credentials.

## Local files

Everything the page saves stays under the private, gitignored
`.sannr/evidence/workbench/` directory: appearance and column widths, and your
responses. A background workbench also keeps its discovery record and a short
launch lock in `.sannr/evidence/workbench/launch/`; they hold no access to the
page and are removed when it stops. None of it changes API bindings, shared knowledge or credentials;
the one ledger write is a note you save by hand.
The workbench uses package-local assets and no account. The page itself sends
nothing; the CLI's daily usage counts ([telemetry](telemetry.md)) count
each launch (`sannr workbench` or `workbench open`) once, and not `workbench
status`, `workbench stop` or the background process an open starts.
Explicit feedback continues to follow the existing
[feedback-send policy](feedback.md). See
[Workbench security](workbench-security.md) for how a page earns access on
each path, what a connected page can reach, and the limits of the local
boundary.
