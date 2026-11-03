# Worked agent examples

These examples are written as complete agent workflows. Each one names its
starting state, action, expected result, and stop condition so the reader does
not have to invent the missing half of the procedure.

All commands use a repository-local installation. Run them from the repository
whose API or integrations are in scope. The API examples use a named `orders`
stack; its environments bind the authorized base URLs, contracts and credential
references described in the [configuration guide](agent-guide.md#configure-the-target-explicitly).

## 1. Finish a fresh project setup

**Starting state:** The user asked you to install or connect Sannr. The package
is already installed as a project dependency. The repository has an OpenAPI
document at `openapi.json`, but no setup files have been reviewed yet.

Preview the changes without writing files or sending API requests:

```sh
./node_modules/.bin/sannr start --dry-run --json
```

Review the named files and conflicts. If they match the user's setup request,
perform setup and bind the real contract:

```sh
./node_modules/.bin/sannr start --contract ./openapi.json --stack orders --json
```

**Expected result:** The JSON distinguishes project setup, API context, and
host activation. Project MCP registrations, installed skills, and managed
repository guidance are created or reported unchanged. A static inventory may
seed `.sannr/<collection>/orders/sannr.json`; no API request runs.

**Stop or continue:** If a generated file conflicts with an edited user file,
stop and report the exact conflict. Do not overwrite it. If the loaded
`api_request` tool description lacks the exact `Setup binding: <id>` returned
by `start`, refresh or restart the coding host and open a fresh task in the same
repository. Tool-name equality alone is insufficient.

## 2. Inspect context before making a call

**Starting state:** Setup is active. The user asks why an order confirmation
sometimes remains in draft. The contract operation is
`POST /orders/{id}/confirm`.

Read the stored operation record first:

```sh
./node_modules/.bin/sannr show "POST /orders/{id}/confirm" --stack orders
```

**Expected result:** Existing contract facts, observations, notes, provenance,
and freshness are displayed. No API request runs.

**Stop or continue:** A fresh, applicable note may answer the question, but it
is still an authored claim. If current behavior must be established, continue
with an authorized asserted request. If the operation identity is absent, check
the actual contract; do not guess a similar route.

## 3. Verify a read-only endpoint

**Starting state:** The user authorized a read against the `orders` stack's
`local` environment. `.sannr/stacks/orders/stack.json` binds that environment
to the correct base URL and contract and contains no literal credentials.

First confirm the selected target:

```sh
./node_modules/.bin/sannr doctor --stack orders --env local
```

Then call the registered `api_request` tool with explicit expectations:

```json
{
  "stack": "orders",
  "environment": "local",
  "method": "GET",
  "path": "/orders/ord_example",
  "fields": ["id", "status", "payment_status"],
  "expect": [
    { "status": 200 },
    { "json": "id", "equals": "ord_example" },
    { "json": "status", "in": ["draft", "confirmed", "cancelled"] }
  ]
}
```

**Expected result:** The response identifies the actual environment and base URL,
reports the transport outcome and each assertion, projects only the requested
fields, and names its evidence. A passing assertion may suppress response data;
that is not missing evidence.

**Stop or continue:** If any assertion fails, report expected versus actual as
returned. Do not convert a transport success into a green verification. If the
tool marks context capture limited, retain that limitation instead of claiming
the observation was written to shared context.

## 4. Perform an authorized write and verify its state

**Starting state:** The user explicitly asked you to create, inspect and delete a disposable order
in the `local` environment. The contract authorizes the operations below. This
authorization does not extend to staging or production.

Call the registered `api_request` tool with one bounded chain:

```json
{
  "stack": "orders",
  "environment": "local",
  "requests": [
    {
      "id": "create",
      "method": "POST",
      "path": "/orders",
      "body": {
        "customer_id": "cus_example",
        "items": [
          { "sku": "sku_example", "quantity": 1 }
        ]
      },
      "expect": [
        { "status": 201 },
        { "json": "status", "equals": "draft" }
      ],
      "capture": {
        "orderId": "id"
      }
    },
    {
      "id": "read-created",
      "method": "GET",
      "path": "/orders/{orderId}",
      "expect": [
        { "status": 200 },
        { "json": "id", "equals": "{orderId}" },
        { "json": "status", "equals": "draft" }
      ]
    }
  ],
  "finally": [
    {
      "id": "cleanup",
      "method": "DELETE",
      "path": "/orders/{orderId}",
      "expect": [{ "status": 204 }]
    }
  ]
}
```

**Expected result:** Captured placeholders interpolate into later paths,
parameters, bodies, headers and `expect`. An exact placeholder in `expect`
preserves its value's type, so `"{orderId}"` compares with the returned ID.
Captures are private by default: the result shows their names and type/length,
and withholds their values throughout step results. Set `reveal_captures: true`
only when those values should appear in the conversation.

`finally` runs even when an earlier assertion or request fails; each cleanup
step is attempted under the same routing, authentication and write policy. A
2xx create supplies its capture even if its assertion failed, so cleanup can
still use it. Report the original failure and every cleanup result. Check
`left_behind` for a create whose captured identifier lacks a matching successful
DELETE; it names the creating step and capture without printing the identifier.
A 401 delete stays on that list. This reports responses, not independent proof
that the remote resource no longer exists.

**Stop or continue:** Do not retry a failed write automatically unless the
operation has an established idempotency mechanism and the user authorized the
retry. A captured value is request-local data; do not copy it into `.sannr/<collection>/orders/sannr.json`.

## 5. Record a reusable undocumented precondition

**Starting state:** An asserted execution established that confirming an order
returns HTTP 200 but leaves the order in draft unless `payment_status` is
`settled`. The contract does not state that precondition. The supporting
evidence identity is available in the request result.

Record the semantic fact immediately:

```sh
./node_modules/.bin/sannr note "POST /orders/{id}/confirm" "returns 200 while status remains draft unless payment_status is settled" --stack orders
```

Read it back as the next agent will see it:

```sh
./node_modules/.bin/sannr show "POST /orders/{id}/confirm" --stack orders
```

**Expected result:** `.sannr/<collection>/orders/sannr.json` contains one authored note on the canonical
operation identity with provenance. The note contains no order ID, credential,
or response body.

**Stop or continue:** If the secret guard refuses the text, rephrase it by
structure rather than weakening the guard. If the contract already states the
fact, do not duplicate it as a note.

## 6. Build a repeatable read-only smoke suite

**Starting state:** The team wants a committed conformance check for `/health`
and `/orders`. Both requests are safe reads. Create `smoke-source.json` with:

```json
{
  "v": 2,
  "requests": [
    {
      "id": "health",
      "stack": "orders",
      "method": "GET",
      "path": "/health",
      "expect": [
        { "status": 200 },
        { "json": "status", "equals": "ok" }
      ]
    },
    {
      "id": "orders",
      "stack": "orders",
      "method": "GET",
      "path": "/orders",
      "expect": [
        { "status": 200 },
        { "json": "data", "exists": true }
      ]
    }
  ]
}
```

Save and execute it against the environment the user named:

```sh
./node_modules/.bin/sannr suite save smoke smoke-source.json
./node_modules/.bin/sannr suite run smoke --env local --json
```

**Expected result:** The canonical suite is saved at
`.sannr/<collection>/suites/smoke.json`. Every step has at least one assertion, and the run
reports every step instead of allowing an assertion-free green result.

**Stop or continue:** Review the generated suite before committing it. Literal
credentials are refused; configure auth through environment references. A red
step remains red even when another step passed.

## 7. Render the footprint without contacting APIs

**Starting state:** The user wants to inspect services, edges, owners, and
shadow routes in the current source tree. They did not ask for live API traffic.

Generate the offline artifact explicitly in static mode:

```sh
./node_modules/.bin/sannr map . --no-execute --out api-footprint.html
```

For a machine-readable static report:

```sh
./node_modules/.bin/sannr audit . --no-execute --json
```

**Expected result:** The HTML is self-contained. The report identifies that
request execution was disabled. Edges and shadow routes can be derived from
files; runtime disagreements and reachability cannot.

**Stop or continue:** Do not describe zero runtime findings as proof that live
servers agree with their contracts. A live map or audit is a separate,
request-executing action and needs an authorized environment.

## 8. Check drift in report-only CI mode

**Starting state:** The team already reviewed and committed an accepted audit
baseline. The task is to report new static drift without sending requests or
turning on enforcement.

```sh
./node_modules/.bin/sannr audit . --ci --no-execute --report-only --summary audit-summary.md
```

**Expected result:** New findings appear in terminal and summary output while
report-only mode exits successfully for findings. Coverage gaps remain named;
missing evidence is not converted into agreement.

**Stop or continue:** Do not regenerate the baseline to erase findings. Fix the
code or contract, or ask the owner to review and deliberately accept the new
state. Removing `--report-only` is a separate enforcement decision.

## 9. Re-run saved conformance probes

**Starting state:** `.sannr/<collection>/suites/smoke.json` is committed and contains only
read-only steps. The user authorized conformance against `staging`.

```sh
./node_modules/.bin/sannr verify smoke --read-only --env staging --json
```

**Expected result:** Each saved assertion is evaluated against staging and drift
is named. An unavailable or skipped operation is not a passing operation.
Eligible HTTP GET/HEAD steps run; writes, protocol adapter steps and reads
dependent on skipped captures are reported as skipped. Verify retains private
evidence without updating shared context, in both full and `--read-only` mode.

**Stop or continue:** Report every failing, skipped, blocked, unsupported,
limited, interrupted, or unasserted entry exactly. Use the returned safe next
action. Do not silently fall back to `local` if `staging` is absent or invalid.

Return to the [Agent operating guide](agent-guide.md) for the evidence model and
action routing. The [API call convention](api-call-policy.md) defines which
agent-issued calls belong through Sannr, and [protocol execution](protocols.md)
covers GraphQL, JSON-RPC, gRPC, WebSocket, upstream bindings, and capture limits.
