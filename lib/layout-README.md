# Sannr project API knowledge

Sannr is the librarian for this repo's APIs, and this folder is the shelf: the things a teammate or a coding agent found out about the APIs this code talks to, kept beside the code so they don't leave when the person who knew them does. The job is plain: an agent writes a lesson down while it works, and the next one reads it before it starts. There's no account and no Sannr server; these files are all there is, and the paths below follow this project's name and collection settings.

{{LAYOUT_TABLE}}

Commit the knowledge, configuration, this guide, and the skill sources. Keep
credentials in environment variables: configuration stores their names, never
secret values. Recorded knowledge contains field names and types, and only
contract-declared enum values. Captured request and response evidence can contain
private values, so the local evidence directory is excluded by this directory's
own `.gitignore`; do not force-add it.

The instruction pointers in `AGENTS.md` and `CLAUDE.md`, host registrations in
`.mcp.json` and `.codex/`, and CI workflows under `.github/workflows/` remain in
the locations their hosts read. They point back here. Skills here are the
source of truth; the host copies are installed by `{{CLI}} connect`.

Run `{{CLI}} doctor` to inspect the setup, `{{CLI}} show "GET /example"` to read
one operation, and `{{CLI}} migrate --dry-run` to preview an existing installation's
move into named API stacks or a product or collection rename. Inspect the plan,
run `{{CLI}} migrate` with any selected `--name` and `--split` options, then run
`{{CLI}} connect`. Migration refuses conflicting destinations and can be run
again safely. Unassigned knowledge stays in `unsorted`; use
`{{CLI}} stack move --to <stack> "<METHOD /path>"` to file an operation.
The generated guide uses repository-relative paths
so another person can read it on their own machine.
