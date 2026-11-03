# Security policy

## What this tool does with your data

Sannr runs on your machine and in your CI. It executes HTTP requests
you or your agent ask for, reads and writes files inside the repository
it was run in, spawns MCP servers you name, imports API client exports
you give it, and installs configuration into your coding agent when you
ask it to. The core has no telemetry service. Network-capable commands can contact configured
APIs, OAuth endpoints and redirects, and opt-in integrations such as Postman.
Installing with npm/npx downloads packages from the registry. `doctor` announces
each read before sending it through the client. Without a configured API, it
sends an unauthenticated GET to `https://api.github.com/zen`, an external GitHub
service. With a configured base URL it probes that API instead. `--probe <url>`
selects another GET target; `--offline` omits the API probe. Probe output includes
status, latency and returned rate-limit headers. A bounded onboarding observation
is kept in `.sannr/evidence/onboarding.json`, with first and latest metadata
only. It retains no body or header dump and does not become a verified fact
about the repository's API. `context query --onboarding` reads it without a request.
The probes do not send configured credentials, follow redirects or retry
automatically. The default contacts GitHub, not a Sannr server. Use
`sannr capabilities --json` for the current capability inventory.

API knowledge is stored in the repository; request evidence, registry entries
and other state are stored locally on your machine. Sannr requires no account
or hosted Sannr service and does not upload this memory to Sannr infrastructure.
Your coding agent can read that memory and is governed by its own provider and
data-handling settings.

Design rules that are enforced by tests, not policy:

- **Credentials are configured as environment-variable references.** Captured
  response evidence stays in the local ignored evidence directory; do not commit
  it. Shared knowledge retains field structure and contract-declared enum values.
  Secret-shape checks protect managed outputs, and a detected literal credential
  on the command line is refused with a rotation instruction. Review knowledge
  and feedback files before sharing them; detection is not proof that arbitrary
  user-provided prose contains no sensitive information.
- **Writes stay inside the project.** Every writer resolves and checks
  its target — symbolic and hard links are refused, files the tool did
  not generate are never overwritten, and the write set is computed
  before any write. Writing outside the project requires an explicit
  flag.
- **Imported scripts are never executed.** Test scripts inside Postman,
  Bruno, and Insomnia exports are recognized statically; what cannot be
  translated faithfully is quarantined by name in a loss report.
- **MCP inspection executes nothing by default.** `sannr mcp inspect`
  enumerates a server's declarations; calling a tool requires a
  per-tool opt-in, and a server's own "read-only" claim is recorded as a
  claim, never trusted.
- **Generated API-check CI uses `contents: read`.** Registry mode installs the
  generating CLI's exact version; vendored mode uses a digest-pinned tarball.
  It produces reports without committing changes to your repository.
- **Protocol libraries are optional and pinned.** Core startup uses Node
  built-ins. Optional protocol libraries and their supported transitive files
  are hash-verified before use. npm may install them by default; use
  `--omit=optional --ignore-scripts` when installing a core-only package.
- **Publication is explicit.** The npm workflow requires public source and
  requests provenance for the tagged commit. Verify the actual registry
  attestation and package hash; a configured workflow is not a published attestation.

## Reporting a vulnerability

Email **security@sannr.dev** with a description and, if you
can, a minimal reproduction. Please do not open a public issue for
anything that could expose a user's credentials or files.

You will get an acknowledgement within three business days and a fix
or a mitigation plan within thirty days for confirmed issues. We
credit reporters in the release notes unless they prefer otherwise.

## Scope

In scope: anything that lets Sannr write outside the project it was
run in, leak a credential or response value into a committed or logged
surface, execute an imported script, execute an MCP tool without the
documented opt-in, or be driven to do any of those by a crafted import,
MCP server, or API response.

Out of scope: the security of the APIs you point it at, and of the
coding agents it is installed into.
