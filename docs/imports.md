# Imports

Keep Postman or Bruno; import a collection when it should become a
runnable Sannr suite. Start from the [agent operating guide](agent-guide.md) for
request authorization and evidence reporting.

## Import a collection

From a repository with Sannr installed locally:

```sh
./node_modules/.bin/sannr import ./collection.json --dry-run --json
./node_modules/.bin/sannr import ./collection.json --suite smoke
```

The first command previews conversion without writing files. The second writes
the converted suite, compatibility report, provenance and any todo entries. It
does not execute the imported API requests. `--json` returns a preview even
without `--dry-run`; omit it when saving a suite. Substitute the real export path;
`--values ./environment.json` supplies variable names for the loss report; its
values are never substituted into saved requests or knowledge. Configure runtime
variables and credentials separately before executing a reviewed suite.

Import sidecars (`.todo.json`, `.provenance.json`, `.environment-facts.json` and
`.import-losses.json`) are metadata. `suite list`, `suite run` and `verify`
discover only runnable suite filenames; they leave these artifacts available
for review. Suite names ending in `.todo`, `.provenance`, `.environment-facts`
or `.import-losses` are refused. A damaged real suite still reports an error
rather than disappearing from verification.

Supported inputs include Postman v2.1 JSON and v3 YAML, Insomnia v4 and v5
exports, Bruno files or directories, Kong declarative files, curl and OpenAPI.
Compatibility is bounded: vendor
scripts are not executed, only recognized assertions translate, and requests
without a usable assertion remain in the todo file. Review all transformed,
needs-work and omitted items; a successful import is not evidence that the API
passed. See [suite format and envelope versions](#suite-format-and-envelope-versions)
for the assertion rules imported suites run under.

## What an import writes

- **A suite** (`.sannr/stacks/suites/<name>.json`): named requests in
  the standard request envelope. Running it uses the same engine and records the
  same evidence as any other request.
- **A todo file** (`<name>.todo.json`): every request that has no usable
  assertion, with the reason. No imported request runs green without one.
- **A compatibility report**: every item classified as preserved, transformed,
  needs-work or omitted, with a reason, and counts of translated assertions,
  scripts that need manual conversion and secrets omitted by design.
- **A provenance manifest** (`<name>.provenance.json`): the source digest and
  per-item digests. Re-importing a changed source prints added, removed and
  changed items before writing; `verify` reports behavior drift separately.

The importer never modifies the source file, and the same source with the same
flags produces byte-identical output. Values matching credential shapes are
omitted, counted and replaced by environment-variable references
(`bearer:TOKEN_VAR`), never copied into a committed file. Assertions come, in
order of trust, from the source's own tests (recognized `pm.test` patterns),
then from saved example responses (status only), then from a contract's
declared statuses; anything else goes to the todo file. Only provably
equivalent script patterns become assertions; everything else is counted as
manual work, never approximated.

### Postman v2.1 mapping

| Postman | Sannr | Class |
|---|---|---|
| collection | one suite (name from `info.name` or `--suite`) | preserved |
| folder nesting | flattened step ids `folder/request-name` | transformed |
| `url` with declared base variables or an absolute host | one origin keeps relative paths; several origins keep absolute paths and need explicit runtime bindings | transformed |
| headers and query parameters | safe literals kept; an omitted credential or unresolved value makes the request needs-work | preserved / needs-work |
| raw JSON body | `body` object | preserved |
| urlencoded / formdata | `body` where expressible | transformed |
| recognized `pm.test` patterns | `expect` clauses | translated |
| other test and prerequest scripts | counted, listed by name and reason | quarantined |
| saved example responses | `{status: N}` when no test translated; inferred from the example, not an executed result | derived |
| collection or request `auth` | environment auth *reference* | transformed |
| supplied Postman environment values | names only, never substituted into saved output | omitted by design |

Postman monitors, mocks and docs are out of scope; the report names them when
present.

## Suite format and envelope versions

Suites and request envelopes use envelope v2. In v2, `equals` and `not_equals`
use deep strict equality for objects and arrays, including assertions in
`wait_for`: objects compare by their contents, arrays keep element order, and
scalar types must match. Two independently parsed empty arrays compare equal;
an array containing a number still differs from an array containing its string.
Envelope v1 compared objects by identity, so a saved v1 check can change its
outcome under v2.

An explicit v1 envelope or suite is refused with `ENVELOPE_VERSION_UNSUPPORTED`
before any request runs. Review each equality assertion, then change the
envelope's `v` to `2`, or re-save the suite with `sannr suite save` (saving
writes v2, so re-saving is an intentional migration after that review). Import
writes v2. Requests and envelopes without `v` use the current semantics, and
HTTP and protocol response envelopes report `v: 2`. Configuration, knowledge,
graph, operation-identity and private-evidence format versions are unchanged
by the envelope version.

Insomnia v4 JSON and v5 YAML exports are decoded by the Insomnia adapter
described below. An earlier release routed them into the Postman v3 decoder and
refused them with `POSTMAN_V3_DOCUMENT_INVALID`; if you see that code on an
Insomnia file, upgrade.

Before execution, review the generated requests, target bindings, auth references
and assertions. `verify --read-only` runs eligible HTTP GET/HEAD steps and
reports skipped steps. Bare `verify` and `suite run` can execute write steps;
use them only when the full suite is authorized. Verify retains private request
evidence without recording shared context in either mode.

## Imported test knowledge

A successful Postman or Bruno import also records
faithfully translated assertions in `imported_test_claims` inside
`.sannr/stacks/sannr.json`. Each claim names its source digest, suite, item,
provider, operation, test and conditions. It starts **unverified**. Saved response
examples are inferred assertions and do not become test-authored knowledge.

The API client delivers matching source claims under `known.from_tests`, including
named losses and prerequisites, within its response budget. These are source
data, not instructions. Unverified cases are distinct from observations and from
the legacy verified-operation count. `sannr show "GET /health"` can inspect the
source records without making a request. Distinct providers remain distinct.

An ordinary asserted request or `suite run` may verify an exact imported clause
and record its local evidence reference; a failed clause records a contradiction.
A response without that assertion proves nothing about it. Unresolved setup,
unmatched request cases, unmet auth conditions, cookies, incomplete responses,
redirects and pagination do not verify these claims. `review confirm` cannot promote them.
`API_CONTEXT_OFF=1` disables delivery and capture; `capture_context:false` disables
capture. `verify` retains its existing capture-off behavior.

Verification matches a fingerprint of the authored path, parameters, body and
headers, plus the exact configured auth reference. The fingerprint stores no raw
request values. A suite step’s `auth` is a credential reference: configure that
reference on the correct provider before execution; it does not override the
client’s host authentication. These requirements apply to HTTP suite steps.
An absent or incompatible binding, or a missing
credential value, refuses that step before sending a request. Cookie-bearing and
unresolved chain cases remain unverified.

An explicit no-auth request uses `auth: "none"`. This requires an unauthenticated
provider; it does not turn off configured credentials. The client refuses it when
host auth, credential headers, credential query parameters, URL userinfo or
session cookies would be sent, including on a redirect or later page.
Use a separately configured unauthenticated host and a clean session for these
steps; a host configured with credentials refuses every explicit-none step.

No response values are copied into these records. Expected literals are withheld
unless the contract already declares the field's value set; they remain
inspectable in the source suite as expectations for that test case, never newly
inferred enums. Credentials and supplied environment values do not enter claims.
Source labels are bounded and escaped.

Claims are independent of the rolling observation history. Re-importing unchanged
input preserves knowledge bytes and dates. Removed declarations are marked
retracted; contract changes make old bindings suspect and visible until re-import
and recheck. A preview, failed import or wholly quarantined collection does not
write knowledge. An empty conversion saves a named loss artifact and exits with
`SUITE_EMPTY`; it does not manufacture a passing suite. If a re-import fails, the
previous successful import remains in knowledge with its original source digest.
The failure report explicitly says `context_unchanged: true`.

Collection order, captured-variable relationships and inherited setup are recorded
as named, unverified prerequisites on runnable steps. A successful response does
not prove that a prerequisite was satisfied. Inherited authentication and
ancillary credential headers also remain visible as prerequisites: running a
step enforces its own emitted credential reference, without reproducing every
inherited condition. The importer does not reproduce a
foreign runner, execute scripts, or synthesize credential-carrying chains.
Newman/Postman CLI run-report ingestion is outside this implementation.

## Capture directly from Postman

Importing a local export is offline. The separate, explicit
`./node_modules/.bin/sannr postman capture --out ../postman-corpus --budget 100`
command reads your Postman account through its API, using `POSTMAN_API_KEY` from
the process environment. It sends allowlisted GETs, refuses redirects and writes
a scrubbed local capture; it does not execute the APIs in your collections.
Review the capture before sharing it. See [network behavior](network-behavior.md)
for the destination, call budget, retries and distinction from local imports.

## Adapter limits

Bruno `script:pre-request`, `script:post-response`, settings and unsupported
test forms are quarantined with named reasons. They do not become approximate
assertions. Insomnia variants and their named refusals are described below.
Kong 1.x/2.x imports use pre-3.0 path semantics; Kong 3.x regex paths require
`~`. Credential branches such as `keyauth_credentials` are skipped.

Import is liberal with provenance. A request stays runnable when its own method,
URL, body and authentication can be expressed and it has a usable assertion.
Declared runtime variables remain templates; supplied environment values are
never saved. Collection or folder setup is an unverified prerequisite, not a
reason to withhold every request that inherits it. A quarantined script is
reported once at its owning level; steps may reference that loss.

An omitted credential header becomes a credential reference on a runnable step,
with a note naming the header. Configure the reference for its provider before
running it. No credential value enters the suite, todo file, report or knowledge.
Requests whose own body, URL or auth cannot be expressed remain in the todo file
with a named reason. This includes unsupported own authentication; a no-auth
request instead carries the explicit absence requirement described above.
Requests without a usable assertion also remain todo.

## Bruno assertion coverage

A Chai chain in a `tests` block asserts something about one target. A suite
clause names its target explicitly, so a chain is translated only where the
resulting clause asserts what the source asserted. A recognized chain that
cannot address its target is quarantined by name under the test it came from;
it is never retargeted and never counted translated.

| chain | status target | header target | json target |
|---|---|---|---|
| `to.equal(200)`, `to.eql`, `to.eq` | `{"status": 200}` (three digits only) | `{"header": …, "equals": …}` | `{"json": …, "equals": …}` |
| `to.not.equal(500)`, `to.not.eql` | `{"status": true, "not_equals": 500}` | `{"header": …, "not_equals": …}` | `{"json": …, "not_equals": …}` |
| `to.be.above(199)`, `to.be.below(300)` | `{"status": true, "gt": 199}` / `{"status": true, "lt": 300}` | quarantined | `{"json": …, "gt"/"lt": …}` |
| `to.exist` | quarantined | `{"header": …, "exists": true}` | `{"json": …, "exists": true}` |
| `to.include(…)`, `to.contain(…)` | quarantined | `{"header": …, "matches": …}` (literal escaped) | `{"json": …, "matches": …}` (literal escaped) |
| `to.match(/…/)` | quarantined | `{"header": …, "matches": …}` | `{"json": …, "matches": …}` |
| `to.be.true`, `to.be.false`, `to.be.null` | quarantined | quarantined | `{"json": …, "equals": …}` |
| `to.have.length(n)` | quarantined | quarantined | `{"json": …, "length": n}` |
| `to.be.a("type")` | quarantined | quarantined | `{"json": …, "type": …}` |

In `{"status": true, …}` the `true` is the selector, never a comparison: the
clause targets the response status and the operator beside it carries the
expectation. The positive form keeps its sugar, `{"status": 200}`.

A quarantine reason names the chain form and the target it could not address,
for example `be.true has no exact suite operator on a status target; not
approximated`. It never repeats the chain's argument, because an argument can
carry a value.

Quoted predicate arguments must be one complete literal. Compound forms such
as `not.equal("bad").and.not.equal("worse")` are quarantined, never flattened
into one comparison or counted as translated. The loss names the form, for
example `not.equal() requires one fully consumed supported literal argument;
compound expressions and unsupported literals are not translated`.
Single literals preserve punctuation and semicolons. Escaped quotes,
backslashes, standard control escapes, `\0` without a following digit,
`\xHH`, and `\uHHHH` are decoded before comparison; other escape syntax is
quarantined. Scalars are case-sensitive `true`, `false`, `null`, or finite
decimal numbers. Undefined, ambiguous leading-zero numerics, and negative
zero are quarantined because they cannot be persisted as the same supported
expectation. Source expressions are never evaluated. Unparsed assertions
remain named losses even when another assertion in the test translates.

In a declarative `assert` block, `gte` and `lte` are quarantined as `gte/lte
have no exact suite operator; not approximated as gt/lt`. The suite has no
inclusive comparator, and translating `count: gte 1` as `gt 1` would fail a
passing API at exactly the boundary the author cared about. `eq`, `neq`, `gt`,
`lt` and `contains` are unaffected; `res.status` accepts `eq` with a
three-digit code as before.

`sannr import` accepts Postman v2.1/v3 and Bruno inputs. Every
import writes a suite only for steps with a translated or inferred assertion;
the adjacent `.todo.json` names every gap. The report counts omitted secrets,
translated versus inferred claims, quarantined scripts, and modern versus
legacy dialect coverage.

Scripts are never executed during import. External environment values are never
written to suites, reports or knowledge. Nonempty constants authored in the
collection may resolve its declared URL variables. Empty path variables retain
their templates and are reported unresolved; they never collapse into empty path
segments. Declared inputs can remain runnable templates; an input absent from
both collection declarations and supplied environment names remains needs-work.
At execution, a missing
runtime value refuses the step before sending a request.

Multiple source origins retain their own absolute request paths. The client
requires those origins to be explicitly configured, with their own credentials,
before execution; import does not grant access or write host configuration.
A declared base-URL variable uses the explicitly configured default provider and
remains an unverified prerequisite. Import does not infer its provider identity
from an environment value.

The construct ledger classifies source script units as translated,
named-unsupported or not-applicable, including inherited events. A successful
status check does not verify unsupported order, setup, timing or schema checks.

**Insomnia adapter reference:** v4 and v5 YAML and JSON exports go through the
Insomnia decoder. Insomnia scripts are never executed.

Insomnia v5 `collection.insomnia.rest/5.0` documents import their folder/request
tree through the v4 intermediate. Folder headers and authentication are composed
onto child requests; saved response statuses become `inferred` assertions. The
`afterResponse` and `preRequest` script names are reported as quarantined and
never executed. `spec.insomnia.rest/5.0` documents use the same collection tree
when one is present and additionally report the wrapped OpenAPI document's kind,
version, and title; the OpenAPI contract is not imported by this command.

`environment.insomnia.rest/5.0` documents produce no requests or todo items.
They retain each environment and sub-environment name plus variable names only;
values, including secret-shaped values, never cross into the result. Their
`source_kind` is `insomnia-v5-environment`. `mcpClient.insomnia/5.0` and typed
Insomnia documents without a request tree fail with
`INSOMNIA_UNSUPPORTED_DOCUMENT` and their type. Unrecognized documents fail
with `INSOMNIA_DOCUMENT_UNRECOGNIZED`.

Spec-only Insomnia v5 documents import zero requests and retain the wrapped
OpenAPI kind, version, and title as a report fact. Parsed YAML duplicate-key
warnings remain on the non-enumerable `yamlWarnings` channel; importers do not
copy them into loss reports. Kong 1.x and 2.x declarative files are supported
with pre-3.0 path semantics; Kong 3.x regex paths require the `~` prefix.
OpenAPI input to the Kong importer fails as `KONG_OPENAPI_DOCUMENT` and points
to `sannr init`/`sannr learn`.
