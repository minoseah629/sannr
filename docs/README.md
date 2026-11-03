# Sannr documentation

These pages ship inside the package, versioned with the code they describe.
Links are relative, so they work in a checkout, in an installed dependency and
on a documentation site. Prefer the copy installed with your version over a
remembered command.

## Start

- [Quickstart](quickstart.md): from `npx @sannr/sannr connect` to a first
  recorded request and the Workbench in five minutes, with expected output.
- [Install](install.md): setup reference, hosts, pinning, upgrade, repair and
  removal.
- [Copyable install prompt](install-prompt.md): the text to paste into a coding
  agent.
- [Troubleshooting](troubleshooting.md): the setup problems we know about.

## Guides

- [Agent operating guide](agent-guide.md): how an agent retrieves context,
  makes asserted calls, reports evidence and records lessons.
- [Worked agent examples](agent-examples.md): complete scenarios with expected
  outcomes.
- [API stacks](stacks.md): one stack per API, with environments, contracts and
  credential references.
- [Project layout and migration](layout.md): the committed `.sannr/`
  directory, ignored evidence, and moving an older installation.
- [Local operator Workbench](workbench.md): launch, pair, inspect, re-send and
  save; [saved requests](saved-requests.md) for reuse with the browser closed.
- [Imports and loss reports](imports.md): Postman, Insomnia, Bruno, Kong, curl
  and OpenAPI into runnable suites, and the suite envelope format.
- [CI setup](ci.md): the optional review-only workflow.

## Reference

- [API call convention](api-call-policy.md): which calls belong in Sannr and
  what capture records.
- [Protocol execution](protocols.md): HTTP, GraphQL, JSON-RPC, gRPC and
  WebSocket bounds.
- [API discovery and scanner limits](discovery.md).
- [API survey](survey.md): the explicit, portable graph with provenance.
- [Authored note history](note-history.md): supersession, evidence and
  corrections.
- [Session ledger](sessions.md): what each host session did.
- [Knowledge views](view.md): offline HTML snapshots and the API map.
- [MCP inspection](mcp.md): the server, `mcp inspect`, and Workbench presence.
- [Agent context across repositories](dependency-graph.md) and its
  [graph format](dependency-graph-design.md).
- [Changelog](../CHANGELOG.md).

## Policies

- [Privacy](privacy.md): what is stored where, and what leaves the machine.
- [Network behavior](network-behavior.md): every network path, by trigger.
- [Feedback](feedback.md): the optional send, its payload and consent policy.
- [Limitations](limitations.md): what this release does not do.
- [Workbench security](workbench-security.md): pairing, the local boundary
  and its limits.
- [Security policy](../SECURITY.md), [support](../SUPPORT.md),
  [license](../LICENSE) and [trademark](../TRADEMARK.md).
