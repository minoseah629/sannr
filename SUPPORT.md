# Support

Sannr is in public beta. Here is where to go when something is unclear or
broken.

## Before you ask

- [Troubleshooting](docs/troubleshooting.md) covers the setup problems we know
  about: GitHub probe failures on `doctor`, an MCP tool that does not appear
  after restart, a setup binding that does not match, Cursor needing `.cursor/`,
  protected host configuration, an older layout, and a dead Node path after an
  upgrade. A 403 can indicate rate limiting; inspect the returned rate-limit
  metadata before diagnosing it.
- `npx @sannr/sannr doctor` (or `doctor --offline`) reports the state of an
  installation in PASS/WARN/FAIL rows. Include its output, with any private
  paths or hostnames removed, when you report a problem.
- [Limitations](docs/limitations.md) lists what Sannr does not do yet, so you
  can tell a gap from a bug.

## Questions and bug reports

Open an issue at [github.com/sannrhq/sannr/issues](https://github.com/sannrhq/sannr/issues).
Say which version (`npx @sannr/sannr --version`), which host (Claude Code,
Codex, Cursor), the command you ran and what you expected. Do not paste
credentials, response bodies or anything from `.sannr/evidence/`; evidence
files can contain private response data.

The project is maintained by Sterling Chin and contributors. Issues are read
regularly, but there is no guaranteed response time during the beta.

## Feedback from a session

`npx @sannr/sannr feedback` writes a local report about a session: what the tool claimed,
what the agent checked, and three questions for the agent that used it. Nothing
is sent until you say so; `npx @sannr/sannr feedback --send` asks first and submits an
anonymized summary to `https://sannr.dev/api/v1/feedback`. See
[feedback](docs/feedback.md) for exactly what leaves the machine.

## Security

Vulnerabilities go to security@sannr.dev, not the issue tracker. See
[SECURITY.md](SECURITY.md).
