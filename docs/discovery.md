# API discovery

Sannr reads local contracts and recognizable source text. It does not start an
application, import Python modules or execute route registration code to discover
an API. An empty result means the current scan found no supported surface; it
does not prove that the repository has no API.

`init` inventories an OpenAPI contract. `map` and `audit` also scan source for
served APIs and outbound dependencies. `map` makes no API requests by default;
use `audit --no-execute` when you want a static audit. See
[network behavior](network-behavior.md) for execution options.

## Contract selection and filenames

For an existing [stack](stacks.md), its selected environment or stack contract
owns the binding. A nearby document or `API_CONTRACT` does not replace it.

On a fresh repository, `init --contract <file>` selects a document explicitly.
Without that option, selection uses `API_CONTRACT`, an existing environment
contract or stored contract, then these conventional paths:

- `openapi.json`
- `openapi.yaml`
- `openapi.yml`
- `swagger.json`
- `swagger.yaml`
- `docs/openapi.yaml`
- `api/openapi.yaml`

An explicitly selected missing or invalid contract is an error; selection does
not silently substitute another API's document.

The source footprint used by `map` and `audit` has a broader, recursive search:
case-insensitive filenames beginning with `openapi` or `swagger`, ending in
`.json`, `.yaml` or `.yml`. For example, `openapi-public.yaml` qualifies. A
document must parse and contain operations to become a discovered surface.
`API_CONTRACT` alone does not add a custom-named document to this recursive
`audit` inventory. Stack viewports in `map` separately use each stack's bound
contract and knowledge.

## Route styles and present limits

The scanner uses source signatures, not complete framework parsers. Finding a
possible service and extracting its operation paths are separate steps.

| Route style | What the current scanner can recognize |
| --- | --- |
| Python decorators on `app` or `router`, such as `@app.get("/items")` | Literal `get`, `post`, `put`, `patch` and `delete` routes. A literal `APIRouter(prefix="/v1")` can supply a prefix. General `@app.route(...)` registration is not supported. |
| Python `blueprint` or `bp` decorators | These names appear in a route pattern, but ordinary receivers are filtered out by the current identity check. A blueprint-only API is not reliably discovered or extracted. Supply a contract. |
| Express, Hono and Fastify shorthand | Literal calls such as `app.get("/items", handler)` or `router.post(...)`. Some named Express routers, literal mounts and factories are resolved; Hono's literal `.basePath(...)` can supply a prefix. Arbitrary aliases or dynamic registration are not guaranteed. Fastify's object form, such as `{ method: "GET", url: "/items" }`, is not currently delivered as a discovered route. |
| Next route handlers | Exported `function GET(...)`, `POST`, `PUT`, `PATCH` and `DELETE`, optionally `async`, are service signals. The scanner does not derive their route paths from the filesystem. |
| Nest/Spring-style decorators | `@Get(...)`, `@Post(...)`, `@Put(...)`, `@Patch(...)` and `@Delete(...)` are service signals in scanned source files. They do not provide extracted paths. Java files and Spring's usual `@GetMapping` / `@RequestMapping` annotations are not supported. |

Service discovery scans `.py`, `.ts`, `.js`, `.mjs`, `.tsx` and `.jsx` files.
Without a contract, a service needs at least two recognized signature matches.
Those are heuristic counts: overlapping patterns can count the same definition
more than once. They are not a verified endpoint count. The listed method
patterns do not cover `HEAD` or `OPTIONS` routes.

The scan skips dependency, build and hidden directories, limits directory depth,
and ignores source files larger than 400,000 bytes. Fixture/example surfaces are
excluded by default and counted separately; `--include-fixtures` includes them.
Unresolved interpolated paths and dynamic mounts cannot be treated as a complete
inventory.

These Python styles are not supported by route discovery: Starlette route
tables, Django `urlpatterns`, aiohttp registration, Falcon resources, Litestar
bare decorators and raw ASGI dispatch. A recognized literal outbound call may
still produce a dependency footprint without discovering the server's routes.

## Where an API lives in code

`show`, `map` and `view` join the local source scan to each stack's contract
and environments. The result is labeled **declared by code**. It locates source
text; it does not establish that a request ran or raise an operation's evidence
class.

A served route gets `defined_in` only when its discovered service is bound to
the stack's contract. An outbound host and port can match any of the stack's
environments, including staging when production uses a different host. The
matched environment is named. An operation-level `called_from` also needs a
matching HTTP method and canonical path; a host reference by itself stays at
stack level. Parameter names and `:id` / `{id}` spelling normalize for matching,
and trailing slashes are ignored. The stack's operation spelling stays visible;
`map --json` retains the source spelling as `code_path`.

Every discovered file and line is retained within the scanner's existing bounds.
A definition, a request expression, a source binding and a configuration
reference have distinct labels. A URL in `.env` is a configuration reference,
not proof of an executable call. Variable bindings are local to their source
file; another file using the same variable name is not evidence of a shared
binding. Where stacks share a host, an unresolved contract or route identity
stays unresolved rather than being paired by resemblance.

The code index names routes and outbound hosts without a stack, and stack
operations without a matching location. Saved source provenance can identify a
previously recorded file; if it has disappeared, it reads **not found at the
working tree**. A saved file that still exists but is not rediscovered stays a
remembered location. Neither state removes the operation or its knowledge.
Secret-shaped locations read `withheld`, with a count; source contents,
credentials and query values are never included.

Each invocation checks local file identities and reuses a bounded, process-local
snapshot of unchanged source and discovery results. Source edits, additions,
deletions and replacements invalidate the affected snapshot; stack bindings,
contracts and saved knowledge are checked again. The cache writes nothing to
the repository or home directory. These commands make no requests by default.
A resolved named-stack request includes up to five
repository-relative locations for the requested operation in `known.code`,
within its normal result budget. Its `bytes` field reports the UTF-8 size of
that code block, including the field itself. Under a smaller budget the client
may omit locations and report their count. `API_CONTEXT_OFF=1` disables delivery with
the rest of `known`. When current locations exist in the selected environment,
`known.code` omits older `remembered` attribution so it cannot displace those
locations. Read views and saved provenance retain that history.

## When discovery finds nothing

For a portable, explicitly generated graph with provenance, coverage, separate
freshness checks and bounded queries, see the [API survey](survey.md). Its saved
snapshot does not replace the current source/contract lookup described above.

Export your application's OpenAPI document and save it as `openapi.json` at the
repository root. Then `init` can inventory it and `map` / `audit` can discover it
without understanding the application's routing style.

Alternatively, select an existing document by path on a fresh repository:

```sh
API_CONTRACT=./spec/service.json sannr init --agents
sannr map
```

This creates the first stack from the contract; its map viewport uses that
binding. `sannr init --contract ./spec/service.json --agents` is the explicit
command-option equivalent. For another API in a configured repository, use
[`stack add`](stacks.md) with `--contract` instead of overriding another stack.
To include the document in `audit`'s recursive footprint, use a discoverable
`openapi*` or `swagger*` filename.

Contract inventory records declared operations. It does not prove that those
operations work or that the contract covers every runtime route. This guidance
adds no scanner patterns or runtime discovery.
