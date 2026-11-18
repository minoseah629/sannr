# Changelog

What changed in each published version of `@sannr/sannr`. Newest first. A section
says what shipped and when; it does not claim what the change proves. Versions
are published to npm under their prerelease channel and `latest` by default; an
explicit owner decision may keep a particular release on its channel only. Dates are UTC.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) headings,
`## [version] - date`. A version that was prepared but never published says so.

## [Unreleased]

## [0.1.0-beta.2] - 2026-11-06

- Native Windows is supported from this version: Windows paths and `node.exe`
  are used directly for MCP registration, a package-manager MCP launch runs
  npm's JavaScript entry under Node instead of executing `npx.cmd`, packaged
  skill templates render the same from CRLF checkouts, atomic file replacement
  retries Windows sharing violations instead of overwriting in place, and the
  Workbench uses a local named pipe for discovery and control. Windows CI lanes
  run the core safety set and the native CLI, MCP and Workbench scenarios on
  Node 22 and 24; the full product suite on Windows is an opt-in CI dispatch.
  Windows file privacy relies on NTFS ACLs, which Node's POSIX mode bits do not
  describe. Not yet qualified there: `migrate` refuses an existing evidence
  directory, relative paths from source scanning and some `connect` and `map`
  output use backslashes, and a migrated pre-layout registration can write an
  unescaped backslash into JSON. See
  [limitations](docs/limitations.md#platforms-and-hosts).
- `connect --claude-hook` writes the Claude Code hook in exec form on Windows
  (`command` is Node, `args` the generated words) so it runs without a shell;
  the shell-form string PowerShell could not run is rewritten in place. macOS
  and Linux output is unchanged. Recognition, `unwire` and conflict checks
  accept both forms on every platform. The hook still covers only the Bash
  tool, not Claude Code's PowerShell tool.
- `workbench` opens the browser on Windows through PowerShell's `Start-Process`,
  reading the URL from an environment variable; it used to spawn `xdg-open`
  there and only print the fallback message.
- `view --open` on Windows hands the written page to the same opener
  `workbench` now uses (shared in `lib/os-open.mjs`) instead of explorer.exe,
  which exits 1 after a successful open and so made every `--open` report
  `VIEW_OPEN_FAILED` with exit 1 although the page had opened. macOS and
  Linux output is unchanged.
- The committed pointer block names `node ./node_modules/@sannr/sannr/bin/cli.mjs`
  as the PowerShell form of the CLI, and `connect` on Windows prints the same
  hint, because the `.bin` shim's `.ps1` sibling is blocked by the default
  Windows client execution policy. The install, limitations and quickstart
  docs explain the launchers and which host shell each applies to.
- GraphQL and JSON-RPC envelopes show the same bounded header selection as an
  HTTP request instead of every response header, so a large header set no longer
  spends the response budget before the data. `rate_limit`, always `null` on
  these envelopes before, reads `RateLimit-*` or `X-RateLimit-*` headers as
  `{limit, remaining, reset}`, with `throttled_by_server` and `retry_after_ms`
  on a 429. Header assertions still see every header, and the full set stays in
  private evidence.
- A GraphQL or JSON-RPC request refused before dispatch says what was refused:
  `error.message` is the adapter's reason instead of one generic sentence, and
  `GRAPHQL_VALIDATION_FAILED` adds `error.details`, up to five validation
  messages with their document position. A variable problem names the variable
  and its declared type, never the supplied value.
- The Workbench opens a note on a GraphQL operation (`query Name`,
  `mutation Name` or `subscription Name`) with its trace and Verify prompt;
  opening one used to answer `WORKBENCH_NOTE_INVALID`.
- The optional gRPC adapter now pins `@grpc/grpc-js` 1.14.7 (upstream: a retry
  timer is cleared when a call is cancelled, and a write error after an HTTP/2
  reset reports the reset code in its status), with the hash catalog
  regenerated so the adapter still loads.
- The optional WebSocket adapter, used for GraphQL subscriptions, now pins `ws`
  8.22.1 (upstream: IPC URL paths are no longer cut at a colon, frames never
  carry empty chunks, and Node's own masking is used where available), with
  the hash catalog regenerated so the adapter still loads.

## [0.1.0-beta.1] - 2026-11-03

- First public source release at github.com/sannrhq/sannr; earlier entries were
  npm-only.

- Trim what ships beside the code for the beta. `QUICKSTART.md`, `MIGRATION.md`
  and `docs/alpha.md` are no longer in the package: the quickstart is
  `docs/quickstart.md`, and the import format, envelope v2 equality rules and
  `ENVELOPE_VERSION_UNSUPPORTED` recovery are in `docs/imports.md`, which that
  refusal now names. The alpha ZIP installer is not part of beta releases or the
  public source; install from npm. `docs/workbench-security.md` and
  `docs/dependency-graph-design.md` are rewritten as user pages, and the
  release runbook covers the beta channel. The feedback report is headed
  "beta feedback", `graph --help` no longer labels its commands alpha, and
  `SUPPORT.md` describes the beta.

- Print commands that run after a project-local or npx install. `next` lines,
  doctor `fix:` lines, the survey command and the generated `.sannr/README.md`
  name `./node_modules/.bin/sannr` after a local install and
  `npx --yes @sannr/sannr@<version>` after npx, instead of a bare `sannr` that
  is not on PATH; a global install still prints `sannr`.

- `doctor` on a fresh repository points at `stack add` instead of the
  single-store config file. A probe refused with HTTP 429, or with
  `x-ratelimit-remaining: 0`, reads as an exhausted rate limit (WARN, with the
  reset time when the response gives one) instead of PASS.

- Print runnable commands in more refusals and hints. The single-store
  `migrate --dry-run` recovery, the `show --stack` commands for stack and
  account facts, the Kong importer's `init`/`learn` pointer and the map's graph
  entry point now name this install's command, such as
  `./node_modules/.bin/sannr` or `npx --yes @sannr/sannr@<version>`, instead of
  a bare `sannr` that is not on PATH after a local or npx install.

- Write a note by hand on the Workbench: the operation view opens with **Write a
  note**, and a note view has **New note on this operation**. The note goes
  straight to the ledger as a person-authored note, through the same path and
  refusals as `sannr note --actor person`, saved alongside any existing notes.
  The operation view's agent prompt is now headed "Or have your agent write
  one". Wherever a prompt has only one kind, the kind is a label rather than a
  tab. In the single-store layout both note boxes are disabled and name
  `sannr migrate --dry-run`.

- On the Map, every operation opens on the Workbench: one with no notes opens an
  operation view with a first-note prompt and its recorded runs. A solid gray
  square marks an operation requested with no result recorded, apart from the
  outline for never requested. The legend's groups are separated by rules, and
  a **Copy remap prompt** button asks an agent to rebuild the survey and report
  what changed.

- Rebuild the Workbench as two views behind one switch, Workbench and Map, read
  from the repository's `.sannr/` stacks. The Workbench view lists notes by stack
  with filters for evidence in scope, mismatch and no run, by author and by note
  basis; shows one note with its status, other notes on the operation, saved
  responses and a Verify or Re-verify prompt; and traces it from the claim
  through its evidence run, run scope and shared observation to the contract.
  The Map view draws the retained survey: contracts, stacks, operations, notes
  and runs, and the files that define them, with coverage. Responses are saved
  on this machine outside the ledger; a copied prompt asks an agent to write
  them back. Appearance is Light, Dark or System, with bundled Instrument Sans
  and JetBrains Mono. Columns resize and J and K move between notes.

- Remove the Activity, API map, APIs, Request, Agent handoff and Settings
  screens, the Slate, Paper and Ink themes and their Anton and Courier Prime
  fonts. Sessions stay in `sessions`; saved requests and the request runner in
  `saved` and `api_saved_requests`; the inbox and presence in `api_workbench`.

- Add a copy button to the Workbench pairing code. It copies the code with its
  dashes and shows `Copied`. Where the browser denies clipboard access it falls
  back to copying a selection, and if that fails too it says
  `Copy blocked · select the code`.

- Review notes by full identity, one at a time or in an explicit batch, with
  `review "METHOD /path" --note sha256:<digest> --decision <decision>` (`--by`
  and `--actor person|agent` required) or the MCP tool `api_note_review`. The
  decisions are `trusted`, `disputed` and `run-requested`; the latest wins and
  earlier ones stay in history. Retire a note with
  `note "METHOD /path" "<why>" --retires sha256:<digest> --reason <class>` or
  `api_note_retire`; the original text and provenance stay in history. New
  notes accept `--basis` with one of nine kinds and an optional `--source`.
  `show`, context queries, managed pointers and MCP results carry the latest
  review label with active notes, and `api_note_context` reads one
  operation's notes with their labels, basis and source.

- Hand a note's run request to the repository inbox. Recording a `run-requested`
  review from the CLI or MCP writes one handoff with the verify prompt that a
  second agent can find, read and acknowledge with `api_workbench`; retries add
  none and nothing executes. Labels in `show`, context queries and MCP delivery
  add the request's status: open, acknowledged or run attached. A failed inbox
  write keeps the decision.

- Under tight response budgets, omit review labels with an explicit receipt before
  dropping saved notes; preserve contradiction flags and full labels in read tools.

- Preserve alpha.12 note-history compatibility when reviewing or retiring notes,
  protect review and retirement metadata with a separate integrity baseline, and
  label cited runs that are not on the current machine.

- `connect --base-url <url>`, with optional `--stack`, `--auth` and `--env`,
  creates the first stack in a repository that has none and no contract, through
  the same checks as `stack add`. With no flag, connect picks the one public API
  the code calls; several or none create nothing and print `stack add` commands.
  `--base-url` in a repository that already has a stack is refused with
  `STACK_EXISTS`, and `--auth` or `--env` without `--base-url` with
  `STACK_URL_REQUIRED`. Nothing is written when connect refuses.

- `STACKS_MIGRATION_REQUIRED` now names the migrate path: preview with
  `migrate --dry-run`, apply with `migrate`, then retry `stack add`.

- A fresh repository's generated `.sannr/README.md` describes the stacks layout;
  a repository with a single-store installation keeps its single-store guide.

- Clarify where to set the production write override for MCP and CLI runs,
  including restarting the MCP server after changing its launch environment.
- Scope session completeness to its own missing receipts and unassignable call
  files, so inherited evidence gaps do not hide a clone's new calls or notes.
  Unknown failures stay unknown in the pasted headline; private usage retains
  the process ID for attribution after receipt deletion.
- Label note evidence availability in human CLI output as its attachment-time
  state, so copied provenance does not imply a receipt is present locally.
- Include the new Workbench session runtime and tests in the reviewed public
  source inventory so public-tree staging can proceed.
- The local Workbench server's `snapshot` and `agent` actions carry
  `latest_session`: the newest agent session from the ledger with its fixed
  summary line, or null. The page does not display it.
- `workbench` accepts `--show last-session` and `--show <session id>`. The page
  has no session view and opens on the Workbench view; the terminal says the
  session is recorded and to read it with `sannr sessions`, or that no agent
  session is recorded yet. An id that is not in the ledger is refused with
  `WORKBENCH_SESSION_UNKNOWN`, and a malformed one with
  `WORKBENCH_SESSION_ID_INVALID`. A launched Workbench writes a private
  discovery record under `.sannr/evidence/workbench/control/` and listens on a
  Unix socket for the new `api_workbench` action `show`, which queues a ledger
  session for that Workbench (a forged id is refused as
  `WORKBENCH_SESSION_UNKNOWN`); without a running Workbench, `show` returns
  the `workbench --show` command instead of failing. The page does not display
  queued sessions, although `show` reports `shown` and `summary.open` reads
  `Shown in your Workbench tab` once a paired Workbench has accepted one.

## [0.1.0-alpha.12] - 2026-10-25

- Refresh installation and troubleshooting guides, use runnable npx commands,
  and ship privacy, limitations and support documentation.
- Point fresh setup and note recovery to the correct stack, warn when a doctor
  probe receives an unsuccessful HTTP response, and use the installed CLI's
  verified invocation in teammate guidance.
- Refresh exact protocol adapter pins and their integrity catalog; derive the
  publish channel from the prerelease label. Describe receipt token estimates
  as response-envelope comparisons rather than whole-session savings.
- Prepare the public source inventory and community files while keeping private
  planning, research and build receipts outside the staged public tree.
- Name the public source repository, homepage and issue tracker in the package
  metadata (`repository`, `homepage`, `bugs`), so npm links to them and
  provenance can check the publishing repository.
- Add `api_workbench` action `summary`: this MCP server's own session from the
  local ledger (requests, failures merged once per call, unasserted calls,
  notes added and corrected, drift, refusals, leftovers) with a fixed line the
  agent ends its reply with. Counts come from recorded files only; an
  unattributable count reads `not recorded`, never zero. The session ledger
  totals gain `calls_failed`, `calls_unasserted`, `notes_corrected` and
  `leftovers_not_recorded`. The request skill tells the agent to call it once
  at the end of a task.
- Group Workbench Activity by caller and time, show the newest five requests,
  and combine attention items from the same run. Put saved requests and APIs
  with activity first, with resource groups, live search and filters. Keep the
  map focused on relationships and agent presence in the navigation rail.
- After an explicit Workbench Send or Inspect action, show a bounded, redacted
  response preview with selected headers and recorded timing. Keep checks and
  provenance separate; opening an API index never reads response bodies or sends
  a request. Preserve unknown history and name missing or omitted evidence.
- Polish Workbench controls and Activity: consistent dropdown carets, explanatory
  disabled Send styling, clearer spacing, fewer redundant controls, correct
  singular counts, aligned columns and labeled phone rows. Show relative times
  with absolute timestamps on hover; retain the precision of date-only notes.
- Wait for npm tag propagation with five bounded readbacks before reporting
  `NPM_TAG_VERIFICATION_PENDING`; never retry publication to refresh tags.
- Explain that a methodless route in a Workbench operator message needs an HTTP
  method, using the fixed example `GET /orders/{id}` without echoing private text.
- Return a `data_secrets` receipt naming `reveal_secrets` when agent-visible
  response data is masked. Preserve usable presigned upload URLs in agent
  output; private evidence continues masking them, and configured credentials
  remain protected.
- Clarify terminal Workbench launch, accept route mentions in operator messages,
  and offer pairing recovery without replaying a request. Remove the browser's
  unsupported retrieval claim, report task-label updates, and prune expired
  optional presence records on attachment.

## [0.1.0-alpha.11] - 2026-10-22

- Retry a workbench inbox read when a concurrent writer atomically replaces
  its history file. A replaced inode reports a bounded busy state under
  persistent contention; symlinks and multiple hard links remain refused.
- Launch the workbench directly from the terminal with a repository-local
  handoff inbox. Agent attachment is optional host/task/heartbeat presence;
  agent loss never revokes browser actions. Terminal loss still does.
  Add `api_workbench` attachment and a durable private handoff inbox with scoped
  action references, operator follow-up messages, cursor reads and explicit
  receipt acknowledgments. Pending notices arrive on the next tool result;
  local MCP does not automatically wake an idle model.
- Stop repeating the workbench pairing prompt after approval. Ask for a code
  when a browser requests pairing, then report when it connects. Label browser
  pairing explicitly; it does not establish a coding-agent connection.
- Workbench request forms now derive required fields from the current contract,
  explain missing inputs, and keep advanced bindings and save/provenance controls
  in disclosures. Add the read-only shared saved-request `draft` action.
- Add API map navigation with recorded per-stack operation coverage and a
  retained dependency-survey graph. Opening either view sends no API traffic and
  does not generate a survey; freshness, evidence classes and omissions remain
  explicit.

- Open Workbench API links in a visible detail view with a return path to the
  filtered list. Show recorded notes and scoped response history, with local
  response inspection and explicit missing-evidence and omission states.
- Add an explicitly launched local browser workbench with Activity, APIs,
  Request and Settings screens. Terminal pairing gates private reads and
  actions; current engine policy governs every send. Slate, Paper and Ink
  switch locally. Bounded private response inspection reads existing redacted
  evidence without adding response retention. See docs/workbench.md.
- Add portable saved HTTP requests with typed runtime inputs, credential
  references, value-free history reopening and create/list/show/edit/run/rename/
  delete through CLI and MCP. Save/open/list never send; rename/delete retain
  execution history. Assertion-free runs report assertions not run. Saved
  references add bounded, byte-accounted operation context and honor context-off.
  A format guard makes published alpha.10 readers refuse the document safely.
- Link session calls and attention items to stable operation anchors. Keep
  failures, refusals, missing receipts, unknown attribution and leftovers
  visible with their recorded basis and named omissions, including after a
  later successful call. Offline reports remain script-free and independent.
- Withhold signed response URLs in shared response redaction, including common
  encoded query forms, before private workbench inspection.

- Add an explicit portable API survey: `survey generate`, `status`, bounded
  operation `query`, and JSON/DOT/offline HTML `render`. It reuses the current
  code join, keeps defines/calls/supplies provenance separate, reports coverage
  and freshness limits, and preserves unchanged or failed snapshots. `show`
  and `map` read the saved graph; API requests keep the current source/contract join behavior
  without loading or delivering the survey. No requests or application starts
  occur during survey generation. See [the packaged guide](docs/survey.md).

- Show where a stack operation is defined or called in local code. `show`,
  `map --json` and the offline map/view pages retain file and line locations,
  the matched environment and unmatched counts. Locations say “declared by
  code”; they never upgrade request evidence. Missing remembered files and
  withheld paths remain visible without changing saved knowledge.
- Named-stack HTTP requests include up to five operation-specific locations in `known.code`,
  with their byte cost inside the existing envelope estimate. Context-off
  disables them; the response budget may omit them with a count. Each invocation
  shares a bounded local source scan, with no persisted cache or network discovery.
- Bound route discovery to relevant source files and use indexed function-scope
  lookups. Long-lived clients reuse unchanged source discovery in a private
  process cache, checking file identities on each call and refreshing bindings
  and knowledge. Current request locations take precedence over remembered
  attribution in `known.code`; stored history remains intact.

- Make `npm test` and routine PR CI a bounded local safety check. Keep all
  product regressions under `npm run test:full`, required for release checks;
  truth and stress are selected for relevant changes rather than every commit.
  Remove redundant prose/format tests and replace thousands of graph-usage
  deliveries with direct boundary fixtures. Agent instructions now require
  proportional verification, not test-count floors or blanket gate reruns.
- Separate offline research fixtures into `npm run test:research`, outside the
  product and release gates. Consolidate overlapping feature/QA fixtures and
  CLI lifecycles while retaining unique adversarial and core safety cases.
  Avoid an empty-stdin subprocess race in the feedback safety test helper.
- Add `sannr sessions`, the session ledger: per host session (one MCP server
  process or one CLI invocation), every call with its time, stack, operation,
  status, assertions, notes delivered, what it produced (observation, drift
  records, draft notes, notes written, key-source links) and what it left
  (refusal code with `attempted 0`, error code, unresolved placeholder), with
  totals per session and over the listed range. `--json`, `--since`, `--stack`
  and `--out` (an offline HTML page) are available; `view` gains the same
  Sessions section. Built from local files only; no request is made. Envelope
  token figures are labeled as estimates of the client's own envelopes, not
  savings. See docs/sessions.md.
- Run files now carry a random per-process `origin.session_id` so the ledger can
  group calls by host process; `origin.build_id` names the package build that
  every process of an install shares. Older evidence is grouped by build, host
  and local day and says so.
- The client writes a private outcome record (`envelope-<id>.json`) beside its
  run files when a batch finishes or a single call returns without evidence.
  It holds codes, methods, stack names, statuses, counts and run ids only, so
  refusals, batch cleanup steps and leftovers stay visible after the session.
  It is written only into an evidence directory that already exists. The
  agent-facing envelope is unchanged.
- Record account facts with `note --stack <name> --env <name> --scope account`.
  They stay private and local unless `--shared` explicitly saves the fact and
  credential reference in the stack's knowledge. Requests deliver only facts
  for their stack, environment and credential reference, labeled with date,
  evidence and credential state. Locally salted fingerprints detect credential
  changes; repeating an unchanged note explicitly reconfirms it without erasing
  history. Shared facts need local confirmation on another machine. Values and
  fingerprints never enter shared knowledge or generated instruction blocks.

- Report one current evidence class per operation across stacks, managed
  instructions, show, map, view and local feedback: written, observed, asserted
  or verified by learn. Fresh passing assertions become visible without
  rewriting the learning ledger; stale, missing or changed evidence cannot
  borrow an earlier positive result. Saved note delivery ranks its supporting
  evidence and date within stack and operation groups, and flags bounded
  status/error-code contradictions without deleting authored history.
- Resolved HTTP requests can propose local evidence-linked draft notes for
  contract disagreements. Accept one with `note --stack <name> --accept-draft
  <id> ["<edited wording>"]`; normal history, relationship and secret rules still
  apply. Drafts never commit knowledge automatically. Repeated errors on two
  operations in the same client process propose a restricted stack draft, not
  an inferred account-wide rule. Account facts require an explicit authored note.

- Empty map/audit results and missing-contract setup errors explain the searched
  inputs and point to OpenAPI recovery. The discovery guide lists supported
  route styles and the Python forms that are not detected yet.

- Record stack facts with `note --stack <name> --scope stack`, optionally limited
  by `--operations`. They share operation-note history, supersession, evidence
  receipts and secret checks. Requests deliver up to five applicable facts
  before operation notes, with an omission count and `show --stack` recovery.
  Managed instructions and `show` put stack facts first; context queries search
  them. Existing MCP context-record tools accept the stack form. The packaged
  feedback stack shares its common rules at stack scope.
- Stack facts are additive committed knowledge. Alpha.10 reads and preserves
  them during ordinary writes but does not deliver them; upgrade clients to use
  them. No migration is required. Account facts use their own credential scope.
  Reconnect upgrades exact alpha.10 write guidance while preserving team edits.
- Mask detected response secrets in agent `data`, response summaries and failed
  assertion detail by default. `reveal_secrets: true` explicitly reveals returned
  values; evidence and configured credentials remain masked. Concurrent requests
  with different reveal settings remain separate. Saved suites retain the choice.
- The CLI protocol command honors the JSON envelope's stack selection and
  refuses conflicting command-line and JSON selections.
- Explicit content-type headers, including a stack's static content-type header,
  override JSON and form defaults. They change the header, not body encoding;
  a static JSON header therefore overrides a form request's form content type.

- Non-secret note/history policy refusals use exit 3; secret refusals retain exit
  2. `note --json` emits refusal JSON on stdout. Supersession receipts list
  exactly the new record's evidence, including an empty list; retries distinguish
  saved evidence from newly requested references that were not attached.
- Request assertions name safety-refused regexes instead of reporting an
  ordinary mismatch. Double-brace body text stays literal; single-brace captures
  continue to resolve in batches.
- Multipart uploads infer a part content type from its extension and accept
  explicit `path`, `contentType` and `filename` metadata, including directory
  names. JSON body fields can reference a local UTF-8 or base64 file with
  `{$file:{path,encoding,prefix?}}`; expansion is bounded and the 1 MiB input
  envelope limit remains. Captured values cannot select local files.
- Request knowledge receipts name the resolved stack, environment and provider
  without promoting authored notes to verified observations. Finish setup checks
  for a saved onboarding receipt before replaying it; missing receipts never
  trigger another probe.
- `map` and `view` stay offline by default. `--execute` announces a bounded
  plan of declared GET/HEAD requests and uses each stack's own client settings
  and evidence. Redirects, retries, unresolved path parameters and OAuth grants
  are excluded from these visualization probes and named in their reports.
- Batch captures show names and shapes by default, including in CLI results;
  `reveal_captures: true` explicitly returns values. Captures work inside
  assertions. `finally` requests run after failures, with ordinary request
  policy, and `left_behind` names captured creations not removed by successful
  cleanup. Saved suites preserve these fields; read-only execution checks
  cleanup steps too.
- Contract warnings print once per distinct warning in a process. Human CLI
  output-pipe errors no longer abort admitted requests before their evidence is
  saved; closed stdout is reported on stderr and produces a nonzero exit.
- Response evidence masks credential-shaped text and credential fields using
  the note secret scanner. Replacements carry salted hashes and an explicit
  count; assertions still inspect the original response in memory.
- Map and view status labels wrap inside their columns, and legend descriptions
  move below labels when space is limited. Metric cards and scrollable tables
  also adapt to enlarged text, and long repository paths wrap on narrow screens.
- Map and view offer Light, Dark and System theme controls using the website's
  paper, ink and lime colors. Theme selection works offline without scripts;
  it is not saved between pages.
- Feedback counts operations, verification stamps, written notes and verdicts
  across every repository stack. The local report names its source stores;
  anonymized reports replace stack names, and sends include only the totals.
- `feedback --send` prepares an anonymized payload and private receipt before
  sending through the API client. Human confirmation is required by default;
  `feedback.send` and `SANNR_FEEDBACK_SEND` support explicit `allow` and `never`.
  Credential/path scans, a local 30-second cooldown, no redirects or retries,
  and fixed-shape responses bound the send. Collection alone stays local.
- The package includes the read-only `sannr-feedback` stack, its public contract
  and day-one notes. `stacks` lists it and `show --stack sannr-feedback` reads it;
  repository credentials and files cannot replace its configuration or knowledge.

## [0.1.0-alpha.10] - 2026-10-07

Published under the `alpha` dist-tag. `latest` moves only by an explicit owner
decision. This is the re-qualified candidate that keeps legacy machine state
readable in place (R11); the earlier candidate that moved state was not
published.

- New machine usage rows and OAuth grants write to `~/.sannr` (or `SANNR_HOME`).
  Legacy state stays under `~/.agent-api-poc` for older pinned installations:
  tokens are read there as a fallback, reports count both logs, and doctor names
  the sources and old files. No state is moved back or deleted. Linked stores
  are not read; new private directories and files use 0700 and 0600 permissions.

- The full unit gate runs the map render budget in an isolated phase, with a
  three-second CPU ceiling on Node 22 and two seconds on newer Node versions.
  The one-store-read ceiling remains; every other test runs afterward. An
  isolated hosted Node 22 run still measured 2,138 ms, so isolation alone was
  insufficient to make the earlier two-second check reliable.
- Installed skills select context tools only when those tools are actually listed
  in the current session; the scoped CLI remains available before MCP loads.
- Fresh `connect` inventories a discovered contract into a named stack, so the
  first note does not immediately require migration. Setup conflicts still leave
  the repository untouched, and dry-run reports the intended stack files.
- Setup guides and worked examples use the named-stack configuration and scoped
  knowledge paths. Feedback exit-code regression checks cover written reports,
  static findings, JSON, custom paths and output failures; no new runtime fix is
  claimed for the unreproduced post-write exit-code report.

- Every named stack now contributes its own instruction section and map/view
  viewport. Request notes stay with the resolved stack, including mounted API
  paths. Bounded instruction facts name omitted counts and the scoped `show`
  command; `unsorted` names the operations waiting to be filed.
- Generated `.sannr/README.md` content uses markers. Handwritten text and links
  outside them survive setup and knowledge writes. Exact older generated guides
  upgrade automatically; customized unmarked guides stay intact and doctor
  reports them.

- Named API stacks keep configuration, contracts, knowledge and private evidence
  separate. `stack add` and `stacks` create and inspect integrations; fresh
  contract setup creates the first stack. Requests select a stack and one of
  its environments explicitly or through bounded URL/default routing, refusing
  ambiguous targets before traffic. Existing single-store reads remain available.
- Stack routing retains provider-local Basic credential checks and mounted
  contract diagnostics. Credential-matching scope labels and evidence pointers
  are explicitly withheld in returned results, including repeated protocol
  context; saved records keep their actual resolved scope. Request help now
  distinguishes legacy URL overrides from explicit-stack configuration.
- Existing installations can migrate into named API stacks with a dry-run plan,
  explicit environment splits, contract-based operation placement and private
  evidence grouped by target origin. Unassigned knowledge stays in `unsorted`
  until `stack move` files it. Pre-migration requests and reads remain available;
  capture and notes name the required migration instead of updating the old store.
- HTTP Basic authentication accepts `basic:USER_ENV:PASS_ENV`, resolves both
  credentials within the selected provider's environment, and refuses missing
  or invalid pairs before dispatch. Reflected raw and encoded credentials are
  scrubbed from returned results and local evidence. The MCP description no
  longer treats an arbitrary auth setting as proof that authentication works.
- Concurrent usage receipts retain credential redaction while awaiting their
  state write. Short credentials cannot corrupt client-owned
  mount diagnostics or generated capture identities; private mount prefixes
  are explicitly withheld rather than presented as usable paths.
- Feedback reports show local generation time with its zone and retain a full
  UTC timestamp. Static URL-reference hosts are labeled as references, not
  confirmed dependencies, and GET/HEAD execution is not described as inherently
  free or side-effect-free. Missing onboarding observations explicitly leave
  their cause unknown and never imply an authentication check ran.
- Unmatchable OpenAPI path keys, including literal query suffixes, are skipped
  individually instead of disabling the whole HTTP contract. Inventory and the
  client use the same route list; startup and doctor name skipped keys without
  query values. Unresolved capture explains contract rejection, prefix mismatch
  or ambiguity.
- Primary environments honor `contractPathPrefix`, including imported test-claim
  bindings. HTTP capture and doctor identify the explicit prefix or the existing
  base-URL path inference; canonical operation and contract digest remain bound
  in private evidence under mounts such as `/v1`.

- The MCP server is registered as `sannr`; the tool remains `api_request`.
  `connect` replaces recognized older `api-request` registrations and Codex
  markers without creating a second server. Customized registrations and edited
  skills remain named conflicts; unchanged shipped skills migrate.
- The package exposes one command, `sannr`. Use `sannr request` for API calls.
  Doctor reports the actual registered server key and warns about legacy keys
  and command launchers without executing those launchers.

- The request command accepts `--body <json>` or `--body=<json>` for a single
  HTTP request. The existing client still applies authentication, headers,
  assertions, evidence and execution protection; invalid or conflicting body
  options refuse before a request is sent.
- Suite discovery excludes import metadata (`.todo.json`, `.provenance.json`,
  `.environment-facts.json` and `.import-losses.json`). Reserved suite names
  refuse before writing; damaged real suites remain visible failures.
- `show` surfaces successful, current-scope client observations as **observed**,
  with retained response counts, statuses, timestamps and checked evidence.
  Legacy execution verification remains separate; a response does not renew
  `verified_at` or certify an authored explanation.
- Captured HTTP operations record where their path and query keys came from.
  After a 2xx request such as `GET /things/{id}`, the operation's record gains
  `key_sources` naming the earlier response field that supplied the value
  (`data[].id` of `GET /things`), with observed dates, a count of other fields
  that held it and an evidence reference; the value itself is never stored, and
  object keys that carry data are recorded as `{}` (JSON:API member, attribute
  and relationship names stay readable). A response is never the source of a
  value its own request carried; complete calendar dates are not linked by
  shape, and parameters or fields the contract pins (enums, booleans, date
  formats) are never linked.
  `context keys [--dry-run] [--json]` derives the same links from existing local
  evidence without sending requests. `API_CONTEXT_OFF=1` disables both. A
  damaged `key_sources` list, including one that holds a credential reference
  such as `basic:abc` as a name, never withdraws a record's observations: its
  links are treated as absent, `context query` and `show` name the record with
  `KEY_SOURCES_INVALID`, and the next capture or `context keys` replaces it and
  says so. A bounded `context query` or `show` answer never drops a record
  because of its `key_sources`: a record that fits only without its list is
  returned without it and counted in `key_sources_omitted`, and room is
  reserved so the first damaged record is always named.
- Private evidence run files (HTTP requests, followed pages and protocol
  requests) are written to a temporary name and renamed into place, so a
  parallel request never reads one half written.
- `view` opens with an API map drawn from the knowledge store and its contract
  only. Each operation has one standing (observed, observed after a failed
  attempt, latest response, no response recorded, write with no response
  recorded) computed with the same rules as `show`, with the learned grade shown
  beside it; operations are grouped by contract tag, followed by one row per
  path key with its recorded sources (or "not recorded"), authored notes and a
  full operations table whose method and standing filters need no script. It
  replaces the per-operation freshness list in the page header. The map reads
  key sources through the same query as `show` and `context query`, so all three
  keep exactly the same `key_sources` lists. An operation the store cannot hold
  or query, a damaged key-source list, an unreadable contract
  (including YAML that fails to parse) or a vanished granted provider is named
  on the page instead of failing it, and an unbound scope names its reason.
  `view` no longer refuses the page because of content: a value the secret scan
  flags (a credential-, key- or email-shaped environment name, stored operation
  key, contract path, summary, declared enum value or field name, key-source
  name or field, note, verdict line or saved report line) reads "withheld"
  where it would render, and one line counts what was withheld by kind. The
  scan of the rendered page stays as the last guard; a value that reaches it is
  refused as `VIEW_WITHHOLDING_MISSED`,
  naming the section. The page removes every invisible format character except
  the joiners real scripts and emoji need. `map` includes the same section and
  prints its counts when the store has operations, so a repository that only
  consumes an API no longer reports a footprint of zeros; if the section cannot
  be built, `map` still writes the footprint and names the reason. Other
  repositories get the footprint unchanged. HTTP capture, the undeclared-path
  check, `show` and the map bind a contract below the base URL's own path
  (base URL `…/api`, contract path `/v1/items`) unless one of its routes covers
  that path segment by segment, a `{template}` segment matching any one segment
  (`/{tenant}/items` under `…/acme`); they compare contract and request paths
  with each segment percent-decoded, so `/v1/café` binds. The recorded request
  shape lists query parameter names written into the request path with `=`,
  never their values; a query component without `=` is a value and is not
  recorded, and a name the secret or promotion scan refuses is dropped and
  counted, so a capture no longer fails because of a query name. A record whose
  key-source list is beyond the read bound keeps its standing and the map counts
  the list; a record the bound leaves out reads "history beyond the read bound"
  in `show` (state `unavailable`, no longer `none`) and on the map alike. The
  audit's finding for a probe that substitutes a listed id names the collection
  operation and the field the id came from (`for a listed id (GET /hubs →
  data[].id)`) instead of the id, in `audit`, `map`, the step summary and the
  baseline.

### Upgrade notes

- Run `connect` from the intended new version, then reload the coding host.
  An owned `api-request` registration becomes `sannr`; an edited registration,
  including one saved with a different Node path, remains a named conflict for
  review rather than being overwritten.
- A customized unmarked `.sannr/README.md` stays intact and doctor names it.
  Only byte-exact shipped generated guides gain markers automatically.
- A stack without a contract returns notes only for exact or id-shaped paths;
  human-readable template values can miss the saved note.
- Migration can leave an empty `.sannr/config/contracts/` directory. Its presence
  does not change the active stack configuration.
- Machine state is not moved. New usage rows and OAuth grants go to `~/.sannr`;
  an older pinned installation keeps reading `~/.agent-api-poc`, and doctor
  names both locations. Mixed-version machines therefore keep working, with
  usage counted across both logs.


## [0.1.0-alpha.9] - 2026-10-02

Published under the `alpha` dist-tag; promoted to `latest` after verification.
The immutable package records publication as pending at package-build time;
this source entry records the verified publication and later tag promotion.

- Importing is liberal with provenance again. A request from a Bruno or Postman
  collection stays runnable when its own method, URL, body and authentication
  can be expressed and it has a usable assertion; collection-level or folder-level
  setup, inherited authentication and inherited variables are recorded on the
  step as named, unverified prerequisites instead of withholding it; an omitted
  credential header becomes a credential reference the selected host must bind
  and supply before any request is sent; a quarantined script is reported once
  at its owning level. An explicit no-auth request refuses a host that would send
  credentials. The upstream Bruno test collection imports runnable requests again
  where 0.1.0-alpha.8 imported none.
- Correcting saved API guidance keeps its history. `note --supersedes <note id>`
  and `--alongside` record the relationship; the original text and attribution
  stay in the knowledge file; the client, pointer blocks, HTML view, graph
  exports and receipts show the active guidance. `show --history` reads the
  retained claims, `review --accept-notes` acknowledges a changed history by
  digest, and `review --drop` and `prune` refuse operations that carry authored
  history. Credential references such as `bearer:ENV_NAME` may appear in note
  prose while credential values are still refused. `--evidence run-<id>`
  attaches a local request's provenance without its payload. Installed write
  skills gain the no-manual-edit guidance.

## [0.1.0-alpha.8] - 2026-09-29

Published under `alpha`; `latest` stayed at 0.1.0-alpha.7.

- Imported test knowledge is preserved through collection imports, and the
  optional protocol adapters install again on a fresh default install: the
  gRPC integrity refusal caused by a transitive `@types/node` version drift is
  fixed.
- Authenticated `learn` verification works with a live credential, and a
  file-backed token refreshes during the run instead of failing the request.
- OAuth destinations are isolated per provider.
- Import loss artifacts stay behind the credential guard, and JSON string
  bodies whose wire representation would change on import are quarantined
  rather than rewritten.
- Documentation: the install prompt keeps its blockquote formatting, the
  collection import examples are corrected, Insomnia is no longer named in the
  launch claims, and the README installation instructions are revised.
- Known at publication: importing a Bruno collection whose requests inherit
  collection-level or folder-level setup (a pre-request script or inherited
  authentication) yields no runnable requests; each request is withheld as a
  todo entry that names the inherited setup. The upstream Bruno test collection,
  which imported most of its requests in earlier versions, now imports none.
  Under review against the import policy.

## [0.1.0-alpha.7] - 2026-09-28

Published under `alpha`, then promoted to `latest` on 2026-09-29 by owner
decision; the first version installed by `npx @sannr/sannr`.

- Recorded HTTP observations are surfaced beside legacy records and inside
  exact-scope HTTP results, so a later session sees what an earlier one saw.
- Onboarding metadata recorded before a host restart is replayed after the
  host activates, instead of being lost with the process.
- Named OpenAPI generators are excluded from implementation hints.
- The private-evidence documentation says what stays on the machine.
- Known at publication: the optional gRPC adapter's integrity refusal on fresh
  default installs (fixed in 0.1.0-alpha.8).

## [0.1.0-alpha.6] - 2026-09-28

Published under `alpha`. Carries the unpublished 0.1.0-alpha.5 changes.

- `@grpc/grpc-js` 1.14.5 with its runtime integrity pins.
- The full setup binding stays visible when a host caps tool descriptions.
- Found at publication: a fresh default install with optional dependencies
  selects a newer transitive `@types/node` than the pinned inventory expects,
  and the optional gRPC adapter refuses to load. Core commands are unaffected.
  Fixed in 0.1.0-alpha.8.

## [0.1.0-alpha.5] - not published

Prepared 2026-09-23 and withdrawn during a registry read-only hold; its
changes shipped in 0.1.0-alpha.6.

- Onboarding works when the project declares no contract, and the package's
  network behavior is documented.
- The `doctor` fortune line no longer doubles its punctuation.

## [0.1.0-alpha.4] - 2026-09-22

Published under `alpha`.

- Durable agent setup and a copyable install prompt (`docs/install-prompt.md`)
  that a coding agent can be handed directly.
- Documentation regression checks follow the packaged guides, and the README
  had a voice pass.

## [0.1.0-alpha.3] - 2026-09-22

Published under `alpha`.

- Onboarding asserts the status of its first request instead of assuming it,
  and that request is a bounded, configuration-free read of the public GitHub
  Zen endpoint through the API client, announced by `doctor`.
- Agent guidance ships inside the package, and the verification and capture
  descriptions match what the commands do.
- A compact public package: research material and its dependencies are out;
  the portable setup path is removed; the optional Electron shell is retired.

## [0.1.0-alpha.2] - 2026-09-22

The first public publication to npm, under `alpha`, authorized as an npm-only
release while the source repository stays private. Version set on
2026-09-14; published 2026-09-22.

- Zero dependencies on load: the five protocol adapters are opt-in optional
  packages, exact-pinned and hash-verified before use; core commands run
  without them, and a missing adapter is a named refusal with the install
  command.
- One committed `.sannr/` directory holds the knowledge file, configuration,
  suites, baseline and skills; `migrate` moves an earlier root layout into it.
- Records: graph exports and snapshots go through the same destination guard
  as every other write; evidence locators refuse workstation paths; the usage
  log is capped.
- Output boundaries: repository-controlled strings are escaped before they
  reach a terminal or an HTML report; the preview server is opt-in and
  reports its pid; every output path honors the project boundary.
- Protocol clients: route matching is segment-wise with no regular expression
  compiled from contract text; deadlines inherit a clamped default; declared
  read-only streams need no write flag; payload credentials are refused
  before persistence; GraphQL documents are bounded.
- Cross-repository trust: a publisher is named in the consumer's manifest with
  a reviewed fingerprint; unlisted or mismatched publishers deliver as
  external claims below local observations; claims about other repositories'
  nodes are opt-in; a repository's own lessons are local knowledge; authored
  lessons render into the managed block under a labeled, bounded subsection.
- The low-level `api-request` binary answers `--help` and refuses malformed
  arguments before anything reaches the network.
- The client reads the knowledge file and the contract digest fresh on every
  call, so a long-lived MCP process delivers current notes and confidence.
- Multi-operator assertions evaluate every operator and name the first that
  fails; imported Postman and Bruno assertion chains keep their target;
  the map states its probe coverage instead of implying completeness.
- Release: the consumer CI workflow installs from the registry by default;
  the publish workflow gains an explicit `latest` promotion.

## [0.1.0-alpha.1] - 2026-09-12

A private prerelease on the private repository (a GitHub release with the
alpha ZIP and tarball). Not published to npm.
