# Release packaging

This is the maintainers' runbook for building, qualifying and publishing the
`@sannr/sannr` package. It is not part of the npm package.

## Qualify and prepare a release

A release uses an explicit version, such as `0.1.0-beta.1`, and the matching
tag `v0.1.0-beta.1`. Before tagging, run release qualification on the same
source tree (broader than the routine CI safety check):

```sh
npm run test:full
npm run test:truth
SANNR_STRESS_LOCAL=1 npm run test:stress
```

The local stress mode uses fixtures, not the external network matrix. Before
publishing, obtain owner authorization for the full live stress matrix
(`npm run test:stress`); it is not a routine development gate.

Pushing a tag does not publish anything. The manually dispatched release
workflow (`.github/workflows/release.yml`) runs the Node 22 and 24 gates, packs
the tarball, verifies it against the `package.json` `files` allowlist, installs
it with the optional protocol adapters, and prepares a draft GitHub release
with the tarball and SHA-256 checksums. The owner reviews the draft's exact
hash before publishing it. A new workflow build generates a new package build
identity; it is not interchangeable with a previously approved local tarball.

npm publication is a separate owner dispatch (`.github/workflows/publish.yml`).
It requires the exact approved commit and tarball SHA-256, downloads that
existing release asset, checks its checksum and every packaged source byte
against the tag, and runs the cold installation fixture on those bytes. It
never repacks a replacement. A prerelease selects the dist-tag its label names
(`beta.N` uses `beta`, `alpha.N` uses `alpha`, any other label uses `next`),
then also updates `latest` by default under the owner's 2026-10-21 release
policy; a stable release selects `latest`. Disable `promote_latest` only for an
explicitly requested release that should leave `latest` where it is. The
workflow reads back the public tags and fails if an expected tag is missing or
stale. It requires public source for npm provenance and fails explicitly for
private source; it never changes visibility or disables provenance to work
around that.

## npm publication and completion

For a normal owner-authorized beta, `beta` and `latest` must point at the same
approved version. `latest` controls the npm front page and unqualified
installs. It does not change the version's prerelease status or update an
existing exact-version MCP registration. An instruction to leave `latest`
unchanged applies only to that release; record the exception in its receipt.

The checklist applies to both the workflow and a manual npm-only release. The
manual route needs explicit owner publication authorization and the exact
qualified artifact; it does not change repository visibility, create a GitHub
release or git tag, or claim npm provenance. Set these variables to the
approved tarball, package name and version from its build receipt:

```sh
: "${APPROVED_TARBALL:?Set the exact approved tarball path}"
: "${RELEASE_PACKAGE:?Set the package name from its build receipt}"
: "${RELEASE_VERSION:?Set the approved version from its build receipt}"
: "${RELEASE_CHANNEL:?Set beta for a beta.N version, latest for a stable version}"
npm publish "$APPROVED_TARBALL" --tag "$RELEASE_CHANNEL" --access public --ignore-scripts --registry=https://registry.npmjs.org/
npm dist-tag add "$RELEASE_PACKAGE@$RELEASE_VERSION" latest --registry=https://registry.npmjs.org/
npm view "$RELEASE_PACKAGE" dist-tags --json --prefer-online --registry=https://registry.npmjs.org/
```

Skip the second command for a stable release (it already published to
`latest`) or when the owner asked to leave `latest` unchanged. Complete any
separate npm two-factor confirmation for publication and for the tag change.
Changing a tag never requires republishing the tarball.

Before calling the release complete:

1. Read the public registry back. Both the channel tag (for example `beta`) and
   `latest` must equal the approved version unless an exception was recorded. A
   command's success message is not the readback.
2. Download that exact version anonymously from npm and compare its SHA-256
   and build identity with the approved artifact. Retain the receipt.
3. Check fresh public installs on macOS and supported Linux/Node versions with
   an empty cache and isolated home/project. Use a temporary directory outside
   the source checkout, with its own Git and npm project boundaries, so ancestor
   packages and globally installed executables cannot substitute for the release.
   Verify the installed version and actual generated MCP launcher bindings;
   distinguish core-only installs, optional adapters and native host sessions.
4. Open the unversioned npm package page and confirm its header visibly shows
   the intended version. Record the URL and observation. When `latest` was left
   unchanged, verify the version-specific page and report that the default page
   remains on the previous `latest`.
5. Save the registry tags, published digest, actual checks and limits in the
   release receipt.

Registry availability, tags and the website can update at different times. If
one still shows the older version, report that step as pending, recheck with
bounded read-only retries, and keep the approved artifact unchanged. The publish
workflow makes up to five tag readbacks, 75 seconds apart, with a 30-second
request timeout; only exhausted retries report `NPM_TAG_VERIFICATION_PENDING`.
Transient command failures and malformed registry replies also retry. Rerun only
verification, not the whole publishing workflow. Never
republish to refresh the front page, claim completion from an accepted upload,
or ask for new publication approval merely to finish an already authorized tag
change. npm may still require the owner's separate authentication step.

## Local package check

No Homebrew formula is kept in this repository. If a tap is wanted, generate
the formula in the owner's tap from a public release tag and its archive
SHA-256; a formula pinned to a tag that does not exist in the public repository
is worse than none.

1. The owner chooses the release tag and runs the three repository gates.
2. Run `npm pack --pack-destination <temporary-directory>` (the archive is
   `sannr-sannr-<version>.tgz` — the package is `@sannr/sannr`), install it into an
   empty directory with `npm install --omit=optional --ignore-scripts ./sannr-sannr-<version>.tgz`, and verify with
   `./node_modules/.bin/sannr --help`.
3. The owner publishes npm and any Homebrew tap as separate launch acts.

## Optional protocol libraries

GraphQL, gRPC, protobuf and WebSocket libraries are exact-pinned in
`optionalDependencies` and `package-lock.json`. The npm tarball contains no
bundled third-party packages, including no nested duplicate `protobufjs` or
`@types/node`, so it carries no third-party lifecycle scripts to run on install.
The core loads nothing beyond Node. Source CI runs
`npm ci --ignore-scripts --no-audit --no-fund` before testing or packing.

Use `npm install --omit=optional --ignore-scripts` with the local tarball for
an offline core install in an empty npm project. npm attempts optional packages
by default; `--omit=optional` applies to the project's other optional dependencies
too. Protocol adapters are opt-in on use. A missing library refuses with
`PROTOCOL_PACKAGE_MISSING`, its package name and exact install command with
`--ignore-scripts`. The suggested install attempts the other optional packages
by npm's default rules.
Installed adapter files and their transitive libraries are hash-verified before
use. Optional packages installed from the registry are separate from the tarball;
keep lifecycle scripts disabled when installing them.

The shipped dependency inventory in `lib/runtime-dependencies.json` is generated
from the artifact file list returned by `npm pack --dry-run`, not an ambient
`node_modules` tree. Release verification and CI self-packing verify the files
actually present against their SHA-256 inventory; an omitted optional package
does not make the core incomplete. The optional library catalog records hashes
from upstream package artifacts for runtime verification.

The catalog pins exact transitive artifact versions as well as direct adapters.
Consumer npm installs resolve transitive ranges independently of this source
lockfile, so unexpected future transitive versions in the runtime graph are
refused with `PROTOCOL_PACKAGE_INTEGRITY`. Modified runtime files and present
unpinned optional peers take the same refusal.
The reviewed `protobufjs@7.6.6` → `@types/node` → `undici-types` edges are
declarations only: their package files have no executable entrypoint or code,
and the adapter does not load them. The catalog records these separately as
`declarationDependencies`; differences there do not refuse a runtime request.
This is an exact upstream-edge classification, not an exemption for all types
packages. Every file in the executable dependency graph remains hash-checked.
This is a deliberate supported-version boundary;
refreshing hashes requires maintainer review, never automatic acceptance on the
consumer's machine. Recheck a fresh consumer install when refreshing the catalog.

When intentionally updating dependencies, update the lockfile, run a clean
`npm ci --ignore-scripts`, then `node scripts/pin-runtime-dependencies.mjs`.
Review the artifact-derived inventories and rerun package/offline-install tests
before building a distribution. Pinning is an explicit maintenance action,
never a pack-time repair of unexpected dependency bytes.

Before releasing, also run `node scripts/verify-protocol-install.mjs
/path/to/package.tgz /path/to/protocol-install.json`. This installs the exact
tarball into a fresh project with an empty npm cache and optional dependencies
enabled, verifies every adapter tree, executes a loopback gRPC assertion, and
checks that a modified transitive file is refused before another dispatch.
The install reads the public npm registry with lifecycle scripts disabled;
API fixture traffic is loopback only. Run it on macOS and supported Linux Node
versions. The existing omit-optional fixture remains a separate core-only check.

## Cold npx installation fixture

After the release candidate is committed and packed, run:

```sh
node scripts/verify-release-artifact.mjs /path/to/package.tgz APPROVED_SHA256 APPROVED_COMMIT /path/to/SHA256SUMS
node scripts/verify-npx-install.mjs /path/to/package.tgz /path/to/cold-install.json
```

The second command serves the exact tarball from a loopback npm registry and
uses a new HOME, npm cache and project. It omits optional adapters, runs npx
connect and doctor, exercises default, configured and override probe behavior
with controlled fixtures, reads back bounded onboarding metadata, and records
and retrieves an explicitly synthetic author
claim before MCP activation, then launches the generated Claude Code, Codex and
Cursor registrations with a minimal PATH. The receipt keeps actual output and
time to retrieval. This validates configuration and the MCP protocol, not the
coding hosts' trust dialogs or a real public npm install. Run it on macOS and
Linux; retain the exact Node version and named limits.

The npx launcher pins the installed package version and can restore it after a
cache prune. A version upgrade requires rerunning connect and refreshing the host. The installed
skills advertise an exact version for subsequent CLI calls. Repeated `@beta`
commands can select a later published version, so use the printed pinned command
when reproducing an observation.

## Exact-artifact stack qualification

Run the synthetic stack and migration regressions against the installed tarball:

```sh
node scripts/verify-stacks-install.mjs /path/to/package.tgz /path/to/stacks-install.json .
```

This creates an empty consumer project and npm cache, installs the exact local
tarball offline with optional adapters omitted, and copies the named source
tests plus their helpers and synthetic fixtures beside the installed package.
The product code comes entirely from the tarball. It checks first setup,
registration ownership, migration, stack routing and credential separation,
scoped knowledge, map/view counts, delivery caps, and README preservation.
Every selected test must pass without a skip, and every installed product file
must retain its original bytes. The receipt records the archive digest, runtime,
selected test digests and test log digest. Run on macOS and Linux; this remains
separate from public-registry installation and native coding-host activation.
