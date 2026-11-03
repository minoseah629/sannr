# CI setup

`sannr connect --ci` adds a GitHub Actions report workflow to the consumer's
repository, alongside the usual agent wiring. The workflow remains under
`.github/workflows/` and names the `.sannr/` knowledge and configuration paths. It runs on pushes, pull requests,
and a weekly schedule. The job has a 30-minute timeout, read-only repository
permissions, actions pinned to full commit SHAs, and concurrency per ref with
cancel-in-progress enabled.

First review the local code/spec findings and record the accepted baseline:

```sh
sannr audit . --baseline --no-execute
sannr connect --ci
```

Commit `.sannr/<collection>/api-audit-baseline.json` and `.github/workflows/sannr.yml`. Both install
modes keep the audit in report-only mode, write the GitHub step summary, and
make no API requests. The workflow does not rewrite the contract or knowledge
file. Registry mode downloads the engine from npm when the workflow runs.

A finding from a probe that substituted an id listed by a collection names the
collection operation and the field the id was listed at (`for a listed id (GET
/hubs → data[].id)`), never the id, so the baseline and the step summary carry
no value from that response. A finding accepted while the id was printed keeps
its baseline key.

Enforcing mode is off by default; when the report has been clean for a while,
remove only `--report-only` — keep the no-traffic and summary boundaries.

## Choose the engine install mode

The default is **registry**: the generated workflow installs the exact version
of the generating CLI from npm and commits no archive. This explicit command
produces the same artifacts as the default command:

```sh
sannr connect --ci --install registry
```

Its workflow installs the product's exact version read from the generating
CLI's own `package.json`, for example `@sannr/sannr@<version>`, with scripts,
audit, funding messages, and dependency saving disabled. The version is never a
range or `latest`: publishing a later release must not silently change an
existing audit. Generating the workflow neither downloads nor publishes the
package; the pinned release must exist when CI runs.

For a repository whose CI must not reach the registry, choose **vendored**:

```sh
sannr connect --ci --install vendored
```

It self-packs the generating CLI into `.sannr/vendor/sannr-ci.tgz`; commit that file
with the workflow. The workflow installs the engine offline from that tarball,
with lifecycle scripts disabled. It has no npm-registry dependency.

Registry is the default. An explicit `--install` choice keeps its meaning, and
an existing generated workflow is never changed automatically; to change mode,
switch explicitly as described below.

## Switch an owned installation

Changing mode requires an explicit transition. To switch from vendored to
registry:

```sh
sannr connect --ci --install registry --switch-install
```

To switch back:

```sh
sannr connect --ci --install vendored --switch-install
```

Without `--switch-install`, a requested mode change returns
`CI_INSTALL_SWITCH_REQUIRED`. A locally edited or foreign workflow, or a tarball
that differs from its ownership digest, returns `CI_ARTIFACT_CONFLICT` and is
left untouched. Byte-identical reruns in the same mode leave CI artifacts
unchanged. Keep generated artifacts intact while switching; an intentionally
edited workflow belongs to the team and cannot be replaced by this command.

The vendored-to-registry transition removes `.sannr/vendor/sannr-ci.tgz` only after
its SHA-256 matches the prior generated workflow's recorded digest. Inspect the
transition in JSON:

```sh
sannr connect --ci --install registry --switch-install --json
```

The result names `ci.transition` as `vendored-to-registry`, reports
`ci.tarball.action` as `removed`, and includes the matched `sha256` and removal
reason. Switching back reports `registry-to-vendored` and writes a new self-pack.
Review and commit the resulting workflow change and tarball removal or addition
together. Registry mode preserves an unrelated tarball because it owns no archive.
