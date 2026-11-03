# API calls during coding

Use Sannr for agent-issued calls to APIs the repository owns or consumes,
including integrations being added. The boundary is repository relevance:
familiarity, response size and HTTP method do not establish that nothing has
changed. A health check or simple GET belongs on this path too.

| Work | Route through Sannr? |
| --- | --- |
| Explore or test this repo's API | Yes |
| Debug an existing integration | Yes |
| Evaluate an integration explicitly being added | Yes; configure its target |
| Check the configured API's health | Yes |
| Research documentation or download packages | Outside this convention |
| Administer GitHub or CI | Outside, unless that API is the integration being built |
| Application or test-runner runtime traffic | Not intercepted by this convention |

The installed `sannr-request` skill carries this convention to coding agents.
Run `sannr connect` after upgrading to refresh exact generated skills. Locally
edited skills are preserved and reported as different; review the new packaged
skill before choosing `--force-skills`. Host tool lists may need a refresh.
This is an agent convention, not a network interception layer. The optional
Claude hook covers its documented command patterns and configured own bases;
it does not enforce every integration call or every coding host.

## What a call leaves behind

The MCP `api_request` tool and CLI share the client. For HTTP, an explicitly
configured primary base or named integration enables bounded structural context
capture when the request matches its origin/base path and a unique route in
that provider's own bound contract. Configure an integration with
`hosts.<name>.baseUrl` and `hosts.<name>.contract` in `.sannr/config/api-environments.json`;
the contract file resolves relative to that configuration file. Optional
`contractPathPrefix` declares a deployment mount when the contract paths omit it.
See the [binding example](protocols.md#http-context-capture).

For the primary API, `sannr start` / `connect` saves a uniquely discovered local
contract into the selected environment's `contract` field when that environment
has an explicit base URL in a project-local config. CLI suites and MCP then use
the same binding. Multiple candidates require an explicit selection;
`sannr start --contract <path>` saves that choice. Existing bindings and unrelated
environments are preserved. Ambient `API_CONTRACT` / `API_BASE_URL` overrides
remain invocation-local, and a URL override needs its own explicit contract.

Use `upstream: "<name>"` to choose a named integration and `path` for the operation.
Unsupported routing keys such as `host`, `baseUrl` and `url` are refused before
execution, including when a later step in a batch contains one.

Unbound, unmatched and ambiguous routes return a named limited capture receipt
without committing literal URL path values; private execution evidence remains.
The implicit localhost fallback is not an integration declaration. An upstream
never borrows the primary contract or legacy notes. A selected environment's
host entry replaces the top-level entry for that name, so redeclare its contract
when changing the provider. Non-HTTP adapters also capture bounded observations.

`capture_context: false` disables a request's shared context recording, and
`API_CONTEXT_OFF=1` disables context globally. Neither option disables private
execution evidence or the request's other effects. `capture_context: true`
requests HTTP recording but cannot bypass the safe route identity requirement. A `context_capture` receipt
reports the recording result. Disk, capacity or other capture failures remain
visible separately from the API response.

Before writing private response evidence, the client runs the authored-note
secret scanner, also recognizing credential fields such as `client_secret`,
`signing_secret` and `token`. A matching string is replaced with a withheld
marker and a salted SHA-256 hash. `response.body_secrets` records whether
replacement occurred and its count. Each record gets a fresh private salt,
which is not saved; hashes cannot be compared across runs. Opaque credentials
identified by their field are also withheld from echoes and protocol assertion
details in that record. Large sets of credentials cause the whole body to be
withheld so alias scanning stays bounded.

This covers JSON, text, pagination pages and protocol evidence, including
JSON-wrapped strings and canonical UTF-8 base64. Automatic binary evidence is
scanned too: clean bytes stay unchanged; bytes containing a recognized secret
are replaced by a marker, with replacement metadata on the binary receipt.
An explicit `save_to` download keeps the requested bytes unchanged. If those
bytes contain a recognized secret, its receipt says `saved_unredacted: true`
and withholds the unsalted file digest; the automatic run record stays scrubbed.
Assertions still inspect the original response in memory. This is a credential
guard, not general personal-data removal: other response values remain local
private evidence and should not be committed.

Contract warnings on stderr are emitted once per distinct diagnostic during a
client process. Each request retains its own contract diagnostic state, and
`doctor` still reports the contract checks. Closing a warning consumer does not
cancel the request or prevent its evidence from being saved.

When a complete successful client response changes a matched field's observed
type, `context_capture.change_notice` can point to the prior/current observations,
their evidence, and up to eight JSON-pointer paths. Comparisons require the same
provider, environment, operation, endpoint, contract digest and request shape;
HTTP also requires the same response status. Old HTTP observations can supply
status through their exact generated status note, labeled `legacy_note`.
Missing fields, null samples and array members are not compared. This is a cue
to inspect and reconcile context, not a schema verdict or a new lesson: record a
scoped correction with `api_context_record` when the evidence warrants it.
Small response budgets shorten the notice and name omitted details; a requested
budget below the remaining response minimum is reported with `budget_min`.

HTTP failures before a response is received are reported through the existing
error path; this capture bridge does not create a shared observation for them.
The read-only librarian binding admits GET/HEAD only and disables shared
recording, including batches. `sannr verify` disables shared recording for every
executed suite step in both full and `--read-only` mode. Private execution
evidence remains available.

Saved context retains structural samples, outcomes, assertion summaries and
evidence references. It excludes scalar request/response payload values from
shared structural samples. A received response is an observation; only the
assertions actually run support a verification claim. An undocumented required
field, state precondition or rejected integration still needs an explicit,
scoped author note. Automatic capture does not invent that explanation.

On the request path, an assertion whose `matches` pattern is refused by the
regex safety guard reports `ASSERTION_PATTERN_REFUSED`, the guard's `reason`,
and `refused_ops: ["matches"]`. This is an unevaluated assertion, not a mismatch.
The response status and execution evidence remain available. In a clause with
several operators, `op` still names the first failure and `ops` lists every
operator; the refusal stays visible even when an earlier operator mismatched.
Safe patterns retain ordinary match/mismatch results. The pattern and input
limits, and the existing import and suite admission refusals, are unchanged.

For a repository graph, retrieve the relevant operation using `api_context`,
then use `api_context_record` to save a reusable lesson with its provider,
environment and evidence. Use the legacy `sannr note` convention where
appropriate. Shared Git snapshots or CI artifacts carry selected context across
checkouts; routing a call does not automatically publish it to other teams.
See [agent context across repositories](dependency-graph.md).

## Exceptions and limits

Keep existing authorization, credential routing and production write rules.
Choosing the client does not authorize extra API calls. Repository-specific safe
check requirements still apply when their tools are available.

For intended writes to an environment marked `production: true`, set
`API_ALLOW_PRODUCTION_WRITES=1` in the MCP server's launch environment (edit the
host's server configuration, then restart the server in the host), or in your
shell for CLI runs.

If MCP is unavailable, use the Sannr CLI. If a transport is unsupported or a
raw-client comparison is necessary to debug Sannr, disclose the limitation and
use a narrow fallback. An external observation can be captured with explicit
source attribution; it remains an external claim. See
[protocol support and external capture](protocols.md).

This release does not intercept arbitrary process traffic, discover all callers,
continuously detect every API change or establish that saved context reduces
cost. It makes relevant observations and authored lessons retrievable so those
benefits can be evaluated. Missing evidence, unknown callers, stale scope and
unasserted behavior must remain visible to the next agent.
