# Local Sannr workbench

The workbench shows what this repository's `.sannr/` stacks already hold: each
note an agent or a person recorded about an API operation, the evidence it rests
on, and the source survey of which code defines which operation. It reads the
stack files, ledgers, contracts, `graph/survey.json` and run-file metadata; it
never sends an API request. The terminal launches and owns the page. A coding
agent is optional.

## Open and pair

From the repository root, run the CLI in an interactive terminal. The examples
on this page write `sannr`; with an npx install that is `npx @sannr/sannr`,
and with a repository-local install `./node_modules/.bin/sannr`:

```sh
npx @sannr/sannr workbench
```

The command opens the default browser. Use `--no-open` to open the printed
local URL yourself. Without an interactive terminal (a pipe, an agent's shell)
it refuses with `WORKBENCH_TERMINAL_REQUIRED`. The listener is IPv4 loopback only, on an
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
**Workbench | Map** switch and a round settings button. There are no other
screens.

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
  same operation; **Add notes**, where you save a response, and **New note on
  this operation**, which writes a note to the ledger beside this one; and
  **Verify** or **Re-verify** with a prompt to copy into your coding agent. **J** moves to the
  next note and **K** to the previous one when no text box has focus.
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

### Settings

The settings popover has **Appearance**: Light (the default), Dark or System. The choice is
kept on this machine in `.sannr/evidence/workbench/appearance.json`, beside the
column widths. Instrument Sans and JetBrains Mono are bundled with the package
(SIL Open Font License 1.1); the page loads no font, script or style from the
network.

## Where the earlier screens went

The Activity, API map, APIs, Request, Agent handoff, Review and Settings screens
were replaced by the two views above. Their functions remain available headlessly:

| Earlier screen | Where it is now |
| --- | --- |
| Review decisions (trust, dispute, retire, ask for a run, batches) | `sannr review` and the `api_note_review` MCP tool; existing review records show in the trace |
| Activity and the agent session view | `sannr sessions` and the session summary an agent quotes |
| API map | The Map view, drawn from the same retained survey |
| APIs and operation detail | `sannr show '<METHOD /path>'`, notes on the Workbench view |
| Request runner and saved requests | `sannr saved` and the `api_saved_requests` MCP tool |
| Agent handoff and presence | The repository inbox through the `api_workbench` MCP tool (below) |
| Settings (Slate, Paper and Ink themes) | Removed; the settings popover offers Light, Dark or System |

`--show last-session` and `--show <session id>` are still accepted by
`sannr workbench`; the page has no session view, so read the session with
`sannr sessions`.

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
responses. None of it changes API bindings, shared knowledge or credentials;
the one ledger write is a note you save by hand.
The workbench uses package-local assets and no account or automatic telemetry.
Explicit feedback continues to follow the existing
[feedback-send policy](feedback.md). See
[Workbench security](workbench-security.md) for pairing, what a paired page can
reach, and the limits of the local boundary.
