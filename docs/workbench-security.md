# Workbench security

The Sannr Workbench is a browser page served by a process on your own machine.
This page describes what that page can reach, how a browser tab earns access,
what is stored, and the limits of the boundary. For launching and using the
Workbench, see [the Workbench guide](workbench.md).

## Launch and pairing

`sannr workbench` runs in an interactive terminal and listens on IPv4
`127.0.0.1` at a port the operating system assigns. The printed launch URL
carries no secret, query or fragment. Before pairing, the page holds only
package-owned HTML, CSS and JavaScript; it cannot read project names, history,
saved requests, credentials or private evidence. The server has no generic
filesystem, command, proxy or outbound HTTP routes.

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

## What a paired page can do

Every private read and action is a `POST /action` with the JSON envelope
`{"action":"<name>","params":{}}`, the current `X-Workbench-Token`, `Host` and
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

Only `/`, `/workbench.js` and `/workbench.css` are served, from package-local
bytes with fixed content types; no request path is ever resolved into a file
path. A strict Content Security Policy allows only same-origin scripts,
styles, connections and images (bundled fonts are embedded), blocks inline and
`eval` scripts, forms, base tags and framing, and loads nothing external. The
page renders API, evidence and error text as text, never as markup.

Errors are `{ok:false,error:{code,next_action}}` with a fixed code and safe
repair text. Unexpected failures return a fixed error without their message or
stack.

### Writes to shared knowledge

Of the actions the page calls, exactly one writes the stack's knowledge file:
saving a note you typed. It goes through the same writer as
`sannr note --actor person`, with the same author marker, date, history,
conflict and credential refusals, and the same managed pointer refresh. It
never edits, supersedes, retires or reviews a note, takes no evidence and sends
no request. The operation must be one the survey, the contract or the stack's
knowledge already names, and a refusal leaves the file unchanged. The page's
other actions write only the private, gitignored Workbench files under the
evidence folder, or nothing.

The same token can also reach actions the page does not call: the review
actions (record a review, supersession or retirement), saved-request
management (create, edit, rename, delete and run portable saved requests) and
the handoff inbox. Treat a paired token as able to do all of these.

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
wakes a model, calls back remotely or sends telemetry.

## Limits and lifetime

Requests are limited to 64 KiB of JSON and 8 KiB of headers, responses to
512 KiB, JSON to 32 levels and 10,000 nodes, with 32 connections, four
concurrent actions and a five-second body-read deadline. An oversized response
becomes an error, never a partial success.

The process closes after 15 minutes without pairing or an explicit action, and
after eight hours in any case. Background refreshes and refused traffic do not
extend that time. It also closes when the terminal ends, on interrupt or on
exit. Closing clears pending pairings and the active token, closes connections
and aborts running actions. A new process creates new authority even if the
port is reused.

An action accepted just before a disconnect may already have done its work;
aborting is not a rollback. The page shows an unknown-outcome state rather than
sending again, and the run history tells you what happened.

The server does not log URLs, bodies, request headers, tokens, pairing values,
exception messages or responses, and sets `Referrer-Policy: no-referrer` and
`Cache-Control: no-store`. The page keeps the nonce and token in memory only,
never in URLs, cookies, browser storage, console output, reports or feedback;
only the theme choice is stored locally.

## What this does not protect against

Browser developer tools, and anyone who controls your local user account or
browser, can read the page's memory and requests. A malicious local process
running as you is outside this boundary. The Workbench is for one person at
one machine; it does not support remote access.

## Check it yourself

In a source checkout, `node --test test/workbench-server.test.mjs` runs the
boundary's tests against loopback fixtures only. They cover leaked URLs, codes
and nonces, unapproved and expired pairings, cross-origin and rebinding
requests, duplicate headers, unsupported methods and routes, malformed JSON,
stale tokens, expiry, size bounds, hostile markup delivered unchanged as JSON and the
fixed error responses. They exercise the Node server, not a real browser.
