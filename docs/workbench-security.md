# Workbench security

The Sannr Workbench is a browser page served by a process on your own machine.
This page describes what that page can reach, how a browser tab earns access,
what is stored, and the limits of the boundary. For launching and using the
Workbench, see [the Workbench guide](workbench.md).

A tab earns access in one of two ways, depending on how the Workbench was
started: a code typed into the launching terminal, or a one-use launch from
`sannr workbench open`. Each Workbench process offers exactly one of them.
Either way the listener is IPv4 `127.0.0.1` at a port the operating system
assigns, and the address you see or are given carries no secret. Until a tab
has earned access, the page holds only package-owned HTML, CSS and JavaScript;
it cannot read project names, history, saved requests, credentials or private
evidence. The server has no generic filesystem, command, proxy or outbound
HTTP routes.

## Terminal launch and pairing

`sannr workbench` runs in an interactive terminal. The printed launch URL
carries no secret, query or fragment.

To pair, the page shows a short random code and you type that code into the
terminal that launched the Workbench. No HTTP endpoint approves a pairing, so
an unattended terminal, auto-approval and remote or tunneled browsers are not
supported. Behind the code, the page also holds a random 256-bit nonce in
memory. After you approve in the terminal, that nonce can be exchanged exactly
once for a separate 256-bit action token. So:

- A leaked launch URL gives only the public page.
- A leaked code has no HTTP authority, before or after approval.
- A leaked nonce cannot complete pairing without your terminal approval.

A pairing challenge expires after two minutes, and at most four can be
outstanding. Approving one discards the others, and a completed exchange
rotates the active token. Reloading the page loses the in-memory token and
requires pairing again. Pairing codes and tokens are never taken from command
arguments or environment variables, and a code typed at the running prompt
does not enter shell history.

## One-step open

`sannr workbench open`, and the `api_workbench` tool's `open`, start one
background process per checkout and open a connected page without a typed
code. This path makes different promises from the terminal launch, and they
are listed here in full.

**Who can start a connection.** The background process listens on a private
local endpoint: on macOS and Linux a Unix socket inside a directory that only
your account can enter, on Windows a named pipe with the system's default
access control. A process that can reach that endpoint can ask for a launch.
In practice that is any process running as you, which includes your coding
agent. So an open proves that a process running as you asked, in that
checkout. It does not prove that a person approved, as a typed code does.
What such a process gains is a page that can do what the CLI in that checkout
already lets it do, through the same client, credentials and policy.

**How the tab connects.** For each open, the background process mints a launch
grant: 256 random bits, valid for two minutes and for one use, known only to
that process. The command hands your browser the local address with the grant
in the URL fragment. A fragment is not sent in an HTTP request or a referrer.
The page takes the fragment out of the address bar before it does anything
else, then exchanges the grant once, at `POST /launch/redeem`, for a session
token of its own. That exchange passes the same origin, host, fetch-metadata
and JSON checks as every other private route.

- The plain address, which results and status print, gives only the public
  page. A tab opened on it stays on a not-connected screen.
- A grant that was used cannot be used again. Presenting it a second time
  within ten minutes of its issue is refused and also ends the session its
  first use created, so a copy that raced the browser turns into a visible
  failed open rather than a second reader. After that the process has
  forgotten the grant and refuses it as unknown.
- A grant for one checkout's Workbench is unknown to every other one.
- The grant is never written to a result, a record, a log, a diagnostic or
  feedback.

**What the tab keeps.** The tab stores its session token in `sessionStorage`,
which the browser scopes to that tab and to that exact origin, port included.
That is what lets a reload stay connected. The token is not in a cookie, the
URL or `localStorage`, so another tab, another port and another site cannot
read it; duplicating the tab copies it, as the browser copies all of that
tab's session data. The browser may keep session data on disk to restore tabs,
so the token can be at rest in your browser profile while that Workbench
process lives. It is worthless once the process ends.

**Several tabs, several repositories.** A background Workbench accepts up to
64 page sessions at once, and a new one does not end the others; beyond 64 the
session unused for longest gives way. Each checkout has its own process, port,
grants and tokens. No token or grant is shared between them, and none is
global. If a later process is given a port that an earlier one used, a
leftover tab presents a token that process never issued and is refused.

**Discovery and stopping.** The background process writes a private launch
record, `.sannr/evidence/workbench/launch/service.json` (mode 0600), with its
instance ID, the checkout's real path, its process ID, its endpoint, the plain
address and its start time. Like a terminal launch it also keeps the small
heartbeat record under `.sannr/evidence/workbench/control/` that lets `show`
find it. Neither holds a grant or a token. A command trusts the launch record
only after the process behind the endpoint answers with the same instance and
the same path. A record that nothing answers for is deleted, and only the
record: no process is ever stopped or interrupted by a recorded ID, and no
path named inside a record is removed. The one use of a recorded process ID is
to ask the system whether the opener that left a launch lock still exists.
`workbench stop` asks the process to close over the endpoint.

The terminal launch is not part of this path. Its process has no
`/launch/redeem` route, its endpoint accepts only `show`, and `open` never
reuses it.

## What a connected page can do

Every private read and action is a `POST /action` with the JSON envelope
`{"action":"<name>","params":{}}`, the tab's `X-Workbench-Token`, `Host` and
`Origin` equal to the listener's own `127.0.0.1:<port>`, same-origin fetch
metadata (`Sec-Fetch-Site: same-origin`, `Sec-Fetch-Mode: cors`,
`Sec-Fetch-Dest: empty`) and JSON `Accept` and `Content-Type` headers. Modern
browsers set the fetch metadata themselves.

Cookies carry no authority and the server sets none. There are no CORS allow
headers, preflight responses, form endpoints, URL credentials, WebSocket
upgrades, redirects or DNS-name aliases. Duplicate security headers, other
origins or hosts, missing fetch metadata, encoded or ambiguous paths, extra
envelope keys, duplicate or prototype JSON keys, non-finite numbers and
malformed UTF-8 are refused before any action runs. Action names are an exact
allowlist.

Besides `/action` and the one route by which a tab earns access (`/pair/start`
and `/pair/complete`, or `/launch/redeem`), only `/`, `/workbench.js` and
`/workbench.css` are served, from package-local
bytes with fixed content types; no request path is ever resolved into a file
path. A strict Content Security Policy allows only same-origin scripts,
styles, connections and images (bundled fonts are embedded), blocks inline and
`eval` scripts, forms, base tags and framing, and loads nothing external. The
page renders API, evidence and error text as text, never as markup.

Errors are `{ok:false,error:{code,next_action}}` with a fixed code and safe
repair text. Unexpected failures return a fixed error without their message or
stack.

### Writes to shared files

Four things you do on the page can change files you commit.

**Saving a note you typed** writes the stack's knowledge file. It goes through the same writer as
`sannr note --actor person`, with the same author marker, date, history,
conflict and credential refusals, and the same managed pointer refresh. It
never edits, supersedes, retires or reviews a note, takes no evidence and sends
no request. The operation must be one the survey, the contract or the stack's
knowledge already names, and a refusal leaves the file unchanged.

**Recording a review decision**, under a note, also writes the stack's knowledge
file, through the same functions as `sannr review` and the `api_note_review`
MCP tool: a trust, dispute or run-request record, or a retirement note that
supersedes the selected note. It is attributed to the author marker as a
person, takes run IDs only as evidence and sends no request, and a refusal
leaves the file unchanged. A run request also adds an entry to the repository's
private inbox. A retirement is written only on a second confirmation.

**Send request**, in the Request view, runs one request through the same client
as the CLI and MCP server. Like any request through that client it writes
private run evidence, and when the operation is bound to a contract it may
record a structural observation (field names and types, never values) in the
stack's knowledge file. Nothing is sent by opening a view, building a draft or
reading Activity.

**Saving, renaming or deleting a saved request** writes or removes one file
under `.sannr/requests/`: structure, typed input declarations and credential
references only. Values you entered are never written.

The page's other actions write only the private, gitignored Workbench files
under the evidence folder, or nothing.

The same token can also reach actions the page does not call: batch review,
supersession of one note by another, and the handoff inbox.
Treat a session token as able to do all of these.

### Responses and private evidence

Sends run through the same client as the CLI and MCP server, under the same
policy, target selection and credential resolution; credential values are never
returned to the page. After an explicit Send, the page can read that run's
receipt once for its inline preview, and Inspect uses the same path. Neither
read sends or replays a request, and background refreshes never load private
response bodies.

Inspection reads at most 8 MiB of retained evidence and shows at most 32 KiB
of body text and twelve selected headers of at most 1 KiB each, with omissions
counted. Credential and cookie headers are left out, and the displayed headers
and body are masked again before truncation, including signed URLs. A recorded
duration is shown only when it is a real measurement. Credential masking is not
general personal-data removal.

## Agent presence and handoffs

An MCP client in the same repository can announce itself through
`api_workbench`. A presence record holds the client's reported name, a task
label you give, a random ID and a heartbeat time; it is refreshed while the
MCP process runs and removed on detach or exit. The reported name is not a
verified identity, and presence grants no browser authority, pairing approval
or request permission. A stale presence changes only the presence line.
Presence records live in the private, gitignored Workbench folder under the
repository's evidence directory; linked or unsafe paths are refused.

Handoffs you send from the page go to an inbox that belongs to the repository.
Automatic events keep only request, recipe and run references, revision
digests, scope, HTTP status and error codes. A follow-up message you write is
bounded, scanned for credentials and paths, marked as operator-authored and
untrusted, and shown as text; payloads, runtime values and response bodies
never enter the inbox. This is not general personal-data detection. Inbox
messages never authorize a send or override repository policy.

Each terminal launch uses a random session, or resumes one with `--session`.
Inbox files are private, gitignored and mode 0600, written atomically under a
per-session lock; damaged or full history is never silently replaced. Reading
does not acknowledge, and acknowledging means received, not completed. A
pending notice rides along with the agent's next ordinary tool result; nothing
wakes a model or calls back remotely, and the page itself sends nothing to Sannr.

## Limits and lifetime

Requests are limited to 64 KiB of JSON and 8 KiB of headers, responses to
512 KiB, JSON to 32 levels and 10,000 nodes, with 32 connections, four
concurrent actions and a five-second body-read deadline. An oversized response
becomes an error, never a partial success.

A terminal-launched process closes after 15 minutes without pairing or an
explicit action, and after eight hours in any case. Background refreshes and
refused traffic do not extend that time. It also closes when the terminal
ends, on interrupt or on exit.

A background process started by `workbench open` closes on `workbench stop`,
30 minutes after the last request that carried a valid session token, and
after eight hours in any case. An open page checks in once a minute, so a
connected tab keeps its access for as long as it stays open and awake, up to
the eight hours; the 15-minute rule above does not apply to it. Requests
without a valid token do not extend the time.

Closing either kind clears pending pairings or launches and every session
token, closes connections and aborts running actions. A new process creates
new authority even if the port is reused.

An action accepted just before a disconnect may already have done its work;
aborting is not a rollback. The page shows an unknown-outcome state rather than
sending again, and the run history tells you what happened.

The server does not log URLs, bodies, request headers, tokens, pairing or
launch values, exception messages or responses, and sets
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`. A terminal-paired
page keeps the nonce and token in memory only. A page opened by
`workbench open` keeps its token in the tab's `sessionStorage`, as described
above, and removes the launch grant from the URL at once. Neither puts
authority in cookies, console output, reports or feedback; the theme choice is
the only other thing stored in the browser.

## What this does not protect against

Browser developer tools, and anyone who controls your local user account or
browser, can read the page's memory, its session storage and its requests. A
malicious local process running as you is outside this boundary; on the
one-step path it can also ask for a launch itself. The Workbench is for one
person at one machine; it does not support remote access.

On macOS and Linux the system opener receives the launch address as a command
argument. While the opener runs, another account on the same machine that can
list your processes can see it. The grant in it works once, for two minutes,
and a second use ends the first one's session, but on a machine you share with
accounts you do not trust, prefer the terminal launch. The browser itself may
also record the address it was opened with, in history or sync, before the
page clears it; that copy cannot be used again.

## Check it yourself

In a source checkout, `node --test test/workbench-server.test.mjs` runs the
boundary's tests against loopback fixtures only. They cover leaked URLs, codes
and nonces, unapproved and expired pairings, launch grants that are unused,
expired, replayed or sent from another origin, cross-origin and rebinding
requests, duplicate headers, unsupported methods and routes, malformed JSON,
stale tokens, expiry, size bounds, hostile markup delivered unchanged as JSON and the
fixed error responses. `node --test test/workbench-open.test.mjs` runs the
one-step path end to end with the real CLI and MCP server: two repositories
side by side, simultaneous opens, a killed process, a reused port and a
damaged record. Both exercise the Node processes with a stand-in for the
browser, not a real browser.
