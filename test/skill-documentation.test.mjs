import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planSkills, planSkillRemoval, projectEntry, removeSkill, serverEntry,
  renderSkill, SKILL_SOURCES, writeText } from "../lib/connect.mjs";

import { NPM_PACKAGE, PRODUCT, SKILL_NAMES } from "../lib/brand.mjs";
import { LAYOUT } from "../lib/layout.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE = SKILL_SOURCES[0];
const sourceBody = readFileSync(SOURCE, "utf8");
const legacyBody = renderSkill(SOURCE).replace("[Agent operating guide](../docs/agent-guide.md).",
  "portable-relative `docs/` tree next to this skill (`docs/README.md`).");
const hosts = [".agents", ".claude"];
const skillPath = (root, host) => join(root, host, "skills", SKILL_NAMES.request, "SKILL.md");
function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sannr-skill-docs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function linkTarget(path) {
  const body = readFileSync(path, "utf8");
  const link = /\[Agent operating guide\]\(([^)]+)\)/.exec(body)?.[1];
  assert.ok(link, `No documentation link in ${path}`);
  assert.ok(!link.startsWith("/"), "documentation guidance must survive moving the repository");
  return resolve(dirname(path), decodeURIComponent(link));
}
function packageSource(root, packageDir = "node_modules/@sannr/sannr") {
  const source = join(root, packageDir, "skill", "SKILL.md");
  writeText(source, sourceBody);
  writeText(join(root, packageDir, "docs", "agent-guide.md"), "# Package documentation\n");
  return source;
}

test("a local tarball installs working documentation links for both hosts and preserves user files", (t) => {
  const fixture = scratch(t), project = join(fixture, "first project");
  mkdirSync(project);
  const env = { ...process.env, SANNR_HOME: join(fixture, "registry"),
    npm_config_cache: join(fixture, "npm-cache"), npm_config_offline: "true" };
  const [pack] = JSON.parse(execFileSync("npm", ["pack", "--json", "--ignore-scripts",
    "--pack-destination", fixture], { cwd: ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  writeFileSync(join(project, "package.json"), '{"name":"first-project","private":true}\n');
  execFileSync("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund",
    "--package-lock=false", join(fixture, pack.filename)],
  { cwd: project, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("git", ["init", "-q"], { cwd: project });
  const cli = (...args) => JSON.parse(execFileSync(join(project, "node_modules", ".bin", "sannr"),
    [...args, "--json"], { cwd: project, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  cli("connect");
  for (const host of hosts) {
    const target = linkTarget(skillPath(project, host));
    assert.equal(target, join(project, "node_modules", "@sannr", "sannr", "docs", "agent-guide.md"));
    assert.ok(existsSync(target));
    assert.ok(!existsSync(join(dirname(skillPath(project, host)), "docs")), "connect copied a duplicate docs tree");
  }
  assert.ok(cli("connect").skills.every((skill) => skill.action === "unchanged"));
  const edited = skillPath(project, ".claude");
  const editedBody = readFileSync(edited, "utf8") + "\nTeam instruction: always assert the response.\n";
  writeFileSync(edited, editedBody);
  const unrelated = join(project, ".agents", "skills", "team", "SKILL.md");
  writeText(unrelated, "# Team skill\n");
  cli("connect");
  assert.equal(readFileSync(edited, "utf8"), editedBody);
  cli("unwire");
  assert.ok(!existsSync(skillPath(project, ".agents")));
  assert.equal(readFileSync(edited, "utf8"), editedBody);
  assert.equal(readFileSync(unrelated, "utf8"), "# Team skill\n");
});

test("connect migrates exact previous documentation guidance without claiming edited copies", (t) => {
  const root = scratch(t), source = packageSource(root);
  writeText(skillPath(root, ".agents"), legacyBody);
  writeText(skillPath(root, ".claude"), `${legacyBody}\nTeam addition.\n`);
  const plans = planSkills(root, { sources: [source] });
  assert.equal(plans.find((p) => p.host === "codex").action, "updated");
  assert.equal(plans.find((p) => p.host === "claude-code").action, "differs");
  const removal = planSkillRemoval(root, [source]);
  assert.equal(removal.find((p) => p.host === "codex").action, "removed");
  assert.equal(removal.find((p) => p.host === "claude-code").action, "left");
});

test("alpha.2 documentation links migrate to the agent guide and remain removable", (t) => {
  const root = scratch(t), source = packageSource(root);
  for (const plan of planSkills(root, { sources: [source] })) {
    const previous = plan.body.replace("[Agent operating guide]", "[API client documentation]")
      .replace(/docs\/agent-guide\.md/g, "docs/README.md");
    writeText(plan.to, previous + (plan.host === "claude-code" ? "\nTeam addition.\n" : ""));
  }
  const upgraded = planSkills(root, { sources: [source] });
  assert.equal(upgraded.find(plan => plan.host === "codex").action, "updated");
  assert.equal(upgraded.find(plan => plan.host === "claude-code").action, "differs");
  const removal = planSkillRemoval(root, [source]);
  assert.equal(removal.find(plan => plan.host === "codex").action, "removed");
  assert.equal(removal.find(plan => plan.host === "claude-code").action, "left");
});

test("previous npx version plus documentation guidance upgrades intact canonical and host skills", (t) => {
  const root = scratch(t);
  const oldOmitted = "The package's command and safety documentation is not available through a portable project-local link. " +
    "Install sannr as a local project dependency, then run connect again to add its portable documentation link.";
  for (const plan of planSkills(root, { sources: [SOURCE], cliName: "npx --yes @sannr/sannr@0.1.0-alpha.2" })) {
    const old = plan.body.replace(/Read `docs\/agent-guide.md` in the installed package[^\n]+/, oldOmitted);
    writeText(plan.to, old + (plan.host === "claude-code" ? "\nTeam addition.\n" : ""));
  }
  const upgrade = planSkills(root, { sources: [SOURCE], cliName: "npx --yes @sannr/sannr@0.1.0-alpha.3" });
  for (const host of ["project", "codex"]) {
    assert.equal(upgrade.find(plan => plan.host === host).action, "updated");
    assert.match(upgrade.find(plan => plan.host === host).body, /@0\.1\.0-alpha\.3/);
  }
  assert.equal(upgrade.find(plan => plan.host === "claude-code").action, "differs");
  for (const plan of planSkillRemoval(root, [SOURCE])) {
    if (plan.action === "absent") continue;
    assert.equal(plan.action, plan.host === "claude-code" ? "left" : "removed");
  }
});

test("nonlocal package docs are explicitly omitted and migrate when installed locally", (t) => {
  const root = scratch(t);
  for (const plan of planSkills(root, { sources: [SOURCE] })) {
    assert.equal(plan.documentationOmitted, true);
    assert.match(plan.documentationRemedy, /local project dependency/);
    assert.match(plan.body, /not available through a portable project-local link/);
    assert.ok(!plan.body.includes(ROOT), "the installed skill contains the developer's machine path");
    assert.doesNotMatch(plan.body, /\[Agent operating guide\]/);
    writeText(plan.to, plan.body);
  }
  const source = packageSource(root);
  for (const plan of planSkills(root, { sources: [source] })) {
    assert.equal(plan.action, "updated");
    assert.equal(plan.documentationOmitted, false);
    writeText(plan.to, plan.body);
    assert.ok(existsSync(linkTarget(plan.to)));
  }
});

test("portable links encode spaces and unwire recognizes its own files if docs later disappear", (t) => {
  const root = scratch(t), source = packageSource(root, "vendor/Sannr alpha");
  for (const plan of planSkills(root, { sources: [source] })) {
    assert.match(plan.body, /Sannr%20alpha\/docs\/agent-guide.md/);
    writeText(plan.to, plan.body);
    assert.ok(existsSync(linkTarget(plan.to)));
  }
  rmSync(join(root, "vendor", "Sannr alpha", "docs"), { recursive: true });
  for (const plan of planSkillRemoval(root, [source]).filter(plan => plan.action !== "absent")) {
    assert.equal(plan.action, "removed");
    removeSkill(plan.to, root);
    assert.ok(!existsSync(plan.to));
  }
});

test("a project link to an outside docs tree is not advertised as portable", (t) => {
  const root = scratch(t), outside = scratch(t), source = packageSource(root);
  const docs = join(dirname(dirname(source)), "docs");
  rmSync(docs, { recursive: true });
  writeText(join(outside, "agent-guide.md"), "# External documentation\n");
  symlinkSync(outside, docs, "dir");
  assert.ok(planSkills(root, { sources: [source] }).every((p) => p.documentationOmitted));
});

test("project registration pins a selected contract for an MCP host's unrelated cwd", (t) => {
  const root = scratch(t);
  const entry = projectEntry(root, { contract: "contracts/service.yaml" });
  assert.equal(entry.env.API_CONTRACT, join(root, "contracts", "service.yaml"));
  assert.equal(projectEntry(root).env.API_CONTRACT, undefined);
  assert.equal(serverEntry().env, undefined);
});

// Exact pre-alpha generated templates. They remain test data, never packaged
// agent guidance, and independently pin the runtime migration digest allowlist.
const previousSkillBodies = {
  "api-request": `---
name: api-request
description: >-
  Reach for this on hard API work, not routine calls. Use it when integrating an
  unfamiliar or badly-documented API, when a request needs to be verified rather
  than eyeballed, when you must chain requests (take a value from one response
  into the next), when polling a long-running operation, or when a response is
  large enough that dumping it would waste context. For a trivial call against an
  API you already understand, curl is fine.
---

# api-request — the arrow in the quiver

For the package's agent-readable command and safety documentation, see the
[API client documentation](../docs/README.md).

This is not a curl replacement and you should not treat it as one. Curl handles
routine HTTP calls. This tool adds structured verification and orchestration for
the integration cases that need them.

Reaching for it on a one-line GET adds a structured envelope without using the
verification or orchestration features. Reach for it when those features matter;
no speed or token-savings result is implied by this selection rule.

## Reach for it when

- **You are integrating an API you do not already know.** It returns the response
  shape, the real values low-cardinality fields take, and any place the server
  disagrees with its own docs. You learn the API by calling it, instead of
  guessing from a spec that may be stale.
- **The result matters and you would otherwise eyeball it.** Say what you expect
  (\`{status: 201}\`, \`{json: "state", equals: "active"}\`) and it checks
  deterministically. A passing check returns no body at all. curl makes you read
  the JSON and hope you read it right.
- **You must chain requests.** Capture a value from one response and feed it into
  the next in a single call: create a resource, capture its id, transition it,
  verify the result. This is the case Postman collection-runs existed for, and it
  is where this tool earns its place.
- **You are polling a long-running operation.** \`wait_for\` polls to the terminal
  state inside one call instead of burning a turn per poll.
- **The response is large.** It summarises past a token budget (count, shape, a
  couple of example records, what was withheld) instead of dumping 50KB into your
  context. Nothing is silently truncated; it always tells you what it left out.
- **You are calling several authenticated APIs.** One instance holds a credential
  per host, routed by the host actually being called, and a credential for one
  host never reaches another.

## Do NOT reach for it when

- The call is a simple GET or POST against an API you already understand and the
  response is small. curl is fine and there is no verification worth the wrapper.
- You just need to check that a server is up.

An agent that uses curl for the routine calls and this tool for the hard ones is
using it correctly. If you find yourself wrapping every one-liner in it, stop.

## How to call it

Call the registered \`api-request\` MCP server's \`api_request\` tool. Codex may
display that qualified as \`api-request/api_request\`. Never put literal
credentials in \`headers\` or \`params\`; configure auth by environment-variable
name in \`api-environments.json\`. Multipart \`files\` reads the named local paths,
and \`save_to\` writes the named destination, so review those paths when the host
asks for approval.

Single request:

\`\`\`json
{ "method": "GET", "path": "/things", "fields": ["id", "status"] }
\`\`\`

Verify without reading the body:

\`\`\`json
{ "method": "POST", "path": "/pieces", "body": {"title": "..."},
  "expect": [{"status": 201}, {"json": "status", "equals": "idea"}] }
\`\`\`

Chain requests in one call (create, capture the id, act on it, verify):

\`\`\`json
{ "requests": [
  { "id": "create", "method": "POST", "path": "/pieces", "body": {"title": "..."},
    "capture": {"pieceId": "id"} },
  { "id": "publish", "method": "POST", "path": "/pieces/{pieceId}/transition",
    "body": {"to": "published"}, "expect": [{"json": "status", "equals": "published"}] }
] }
\`\`\`

Poll a long-running operation to completion:

\`\`\`json
{ "requests": [
  { "method": "GET", "path": "/operations/{opId}",
    "wait_for": {"json": "state", "in": ["succeeded", "failed"], "timeout_ms": 30000} }
] }
\`\`\`

Polling is intentionally limited to GET and HEAD so a retry cannot repeat a
write operation.

The response is the same shape every time, so you never inspect it to learn how to
read it: \`status\`, \`ok\`, \`mode\`, \`assertions\`, \`data\`, and the rest, always
present. Full request and response go to disk, addressable by an evidence id, so
you never carry them in context.

## The honest summary

It provides more structure than curl and adds an envelope to each call. On hard
work — unfamiliar APIs, chained requests, verification, polling, large responses —
pick it for those capabilities. Pick the tool by the task, not by an unmeasured
speed or token claim.
`,
  "sannr-write": `---
name: sannr-write
description: >-
  Load this in any repo that carries sannr.json. It is the team's write
  convention for API knowledge: when you learn something about an API that is
  NOT in its spec, you record it before moving on, the way you would write a
  test before moving on. It tells you exactly when to write, the exact command,
  and the structure of a good entry. It never tells you which tool to make API
  calls with — that stays your judgment.
---

# write-context — record what the spec does not say

You may learn things about this API that its spec does not say. An unwritten
fact is not available to a later session through \`sannr.json\`; whether and how
often it would otherwise be rediscovered is not measured here. This repo's
convention: **when you learn something about an API that is NOT in
its spec, you MUST record it before moving on.** Not at the end of the task —
before moving on, while you still hold the detail. This is a team convention,
like "write a test": nobody asks whether you felt like it.

This skill mandates the WRITE. It is not a tool advertisement: for any API
outside this repository, tool choice is your judgment and no part of this
convention. Calls to this repository's OWN API are the one exception, and it
is not this skill's rule but the repository's: they go through the client
(\`api_request\` over MCP, or the CLI's \`request\`), which records execution
evidence as a side effect, and the hook that \`connect --claude-hook\` installs
denies raw \`curl\`/\`wget\` against the repository's own base URLs. The
convention here is only that the knowledge lands in \`sannr.json\` before you
move on.

## When the write triggers

Any of these is a trigger. The test is always the same: the spec does not say
it, and you now know it.

- **An undocumented required field** — the server 400s without a field the
  contract marks optional or does not list at all.
- **A state precondition** — the call only works when the resource is already
  in some state ("transition requires status=draft first").
- **A field that lies** — the docs say one thing, the server does another
  (a documented enum value that never occurs, a "timestamp" that is a string,
  a pagination cursor that is not opaque after all).
- **A rejected integration and why** — you evaluated an API or endpoint and
  decided NOT to use it. Accepted integrations leave code behind; rejected
  ones leave nothing unless you write the verdict.

Not triggers: things the spec already says (that is what the spec is for),
transient failures (a 503 is weather, not knowledge), and anything containing
a secret (the file is committed; the guard will refuse and you rephrase by
shape: "needs a bearer token from the console", never the token).

## The exact write

**A gotcha** (the first three triggers) is one \`note\`:

\`\`\`
sannr note "<METHOD /path>" "<one sentence>"
\`\`\`

Structure, so every write reads the same three years on:

- The operation is \`METHOD /path\` exactly as the contract spells it
  (\`"POST /orders/{id}/transition"\`) — method uppercase, path with its
  placeholders, nothing else. Never a full URL.
- The note is **one sentence**, present tense, naming the field or status you
  observed, symptom first then cause or fix:
  - \`sannr note "POST /orders" "400s without idempotency_key, which the contract marks optional"\`
  - \`sannr note "GET /users" "returns disabled accounts too; filter on status yourself"\`
  - \`sannr note "GET /orders" "cursor is opaque; decoding it breaks on deploy"\`
- One fact per note. Two facts are two notes.

**A rejected integration** (the fourth trigger) is one \`verdict\`:

\`\`\`
sannr verdict "<what>" --verdict rejected --reason "<one sentence, by shape not value>" --class <class> [--probe api-suites/<name>.json]
\`\`\`

- \`<what>\` names the API or operation evaluated (\`"POST /refunds"\`,
  \`"vendor-x billing API"\`).
- \`--class\` is one of \`measured | documented | priced | structural |
  contextual | judgment\` — it tells the next reader HOW to re-check the
  decision, which prose never does.
- \`--probe\` points at a committed envelope that reproduces the reason, when
  one exists. A verdict with a probe is re-checkable in one command; without
  one it is an opinion with a date on it.
- \`--verdict accepted\` and \`deferred\` exist too; the write is mandatory for
  *rejected*, because rejection is the decision that otherwise leaves no trace.

## Why this is hard-lined

Voluntary mid-task capture has no replicated, checked-in measurement in this
repository, so the convention does not depend on it. The deterministic paths
(the client's friction capture, \`learn --ci\`) catch what a machine can see;
declared and decisional knowledge requires an explicit write, so that is what
the convention mandates. This is a design rule, not a measured adoption result.
`,
};

test("exact previous selection policies migrate across generated documentation variants", (t) => {
  const root = scratch(t), source = packageSource(root, "vendor/Sannr alpha");
  const old = previousSkillBodies["api-request"];
  const paragraph = "For the package's agent-readable command and safety documentation, see the\n" +
    "[API client documentation](../docs/README.md).";
  const portable = "For the package's agent-readable command and safety documentation, see the\n" +
    "[API client documentation](../../../vendor/Sannr%20alpha/docs/README.md).";
  const omitted = "The package's command and safety documentation is not available through a portable project-local link. " +
    "Install sannr as a local project dependency, then run connect again to add its portable documentation link.";
  const currentOmitted = planSkills(root, { sources: [SOURCE] })[0].body
    .match(/Read `docs\/agent-guide.md` in the installed package[^\n]+/)[0];
  for (const body of [old, old.replace("[API client documentation](../docs/README.md).",
    "portable-relative `docs/` tree next to this skill (`docs/README.md`)."),
  old.replace(paragraph, portable), old.replace(paragraph, omitted), old.replace(paragraph, currentOmitted)]) {
    writeText(skillPath(root, ".agents"), body);
    writeText(skillPath(root, ".claude"), `${body}\nTeam addition.\n`);
    const plans = planSkills(root, { sources: [source] });
    assert.equal(plans.find((p) => p.host === "codex").action, "updated");
    assert.equal(plans.find((p) => p.host === "claude-code").action, "differs");
    const removal = planSkillRemoval(root, [source]);
    assert.equal(removal.find((p) => p.host === "codex").action, "removed");
    assert.equal(removal.find((p) => p.host === "claude-code").action, "left");
  }
  writeText(skillPath(root, ".agents"), old.replace(paragraph, portable.replace("vendor/", "other/")));
  assert.equal(planSkills(root, { sources: [source] }).find((p) => p.host === "codex").action,
    "differs", "a team's documentation edit must remain theirs");
});

const preHookWriteBody = previousSkillBodies["sannr-write"].replace(
  `This skill mandates the WRITE. It is not a tool advertisement: for any API
outside this repository, tool choice is your judgment and no part of this
convention. Calls to this repository's OWN API are the one exception, and it
is not this skill's rule but the repository's: they go through the client
(\`api_request\` over MCP, or the CLI's \`request\`), which records execution
evidence as a side effect, and the hook that \`connect --claude-hook\` installs
denies raw \`curl\`/\`wget\` against the repository's own base URLs. The
convention here is only that the knowledge lands in \`sannr.json\` before you
move on.
`,
  `This skill mandates the WRITE, never the USE. Make your API calls with curl,
fetch, api-request, whatever the task wants — tool choice is your judgment and
no part of this convention. The convention is only that the knowledge lands in
\`sannr.json\` before you move on.
`);

test("previous write conventions migrate exact portable, absolute and commandless installs", (t) => {
  const root = scratch(t);
  const oldSource = join(root, "previous-write", "SKILL.md");
  const source = SKILL_SOURCES[1];
  const dest = join(root, ".agents", "skills", "sannr-write", "SKILL.md");
  for (const previous of [previousSkillBodies["sannr-write"], preHookWriteBody]) {
    writeText(oldSource, previous);
    for (const invocation of ["sannr", "./node_modules/.bin/sannr", "node /previous/install/bin/cli.mjs",
      "node '/previous install/bin/cli.mjs'", "node '/previous owner'\\''s install/bin/cli.mjs'", null]) {
      const body = renderSkill(oldSource, invocation);
      writeText(dest, body);
      assert.equal(planSkills(root, { sources: [source] }).find((p) => p.host === "codex").action,
        "updated", `previous invocation ${invocation}`);
      assert.equal(planSkillRemoval(root, [source]).find((p) => p.host === "codex").action,
        "removed", `previous invocation ${invocation}`);
      writeText(dest, body.replace("One fact per note.", "Two facts per note."));
      assert.equal(planSkills(root, { sources: [source] }).find((p) => p.host === "codex").action, "differs");
      assert.equal(planSkillRemoval(root, [source]).find((p) => p.host === "codex").action, "left");
    }
  }
  writeText(dest, renderSkill(oldSource, "./node_modules/.bin/sannr").replace(
    "./node_modules/.bin/sannr note", "sannr note"));
  assert.equal(planSkills(root, { sources: [source] }).find((p) => p.host === "codex").action,
    "differs", "mixed commands must not claim ownership of a team edit");
});

// Exact bytes from e094728:skill/write-context/SKILL.md. Keep this historical
// policy as test data only; connect carries its digests, not another skill.
const observationWriteBody = readFileSync(join(ROOT, "test", "fixtures", "write-context-e094728.txt"), "utf8");

test("observation-era write guidance upgrades and removes exact generated installs for both hosts", (t) => {
  const root = scratch(t), oldSource = join(root, "previous-write", "SKILL.md");
  const source = SKILL_SOURCES[1];
  writeText(oldSource, observationWriteBody);
  assert.equal(createHash("sha256").update(observationWriteBody).digest("hex"),
    "e33f181ac4b52a222303756da06e7a814e28a7b618156a83a6d0612486cc4cd9");
  assert.equal(createHash("sha256").update(renderSkill(oldSource, null)).digest("hex"),
    "f9968e34d01955df77d1c91ec397b5c3e5855f0e7d077ad2a8b4e10d96bc525e");
  for (const invocation of ["sannr", "./node_modules/.bin/sannr", "node /previous/install/bin/cli.mjs",
    "node '/previous install/bin/cli.mjs'", "node '/previous owner'\\''s install/bin/cli.mjs'", null]) {
    const body = renderSkill(oldSource, invocation);
    for (const host of hosts) writeText(join(root, host, "skills", "sannr-write", "SKILL.md"), body);
    const upgrade = planSkills(root, { sources: [source] });
    const removal = planSkillRemoval(root, [source]);
    for (const plan of upgrade.filter(plan => plan.host === "project")) writeText(plan.to, plan.body);
    for (const plan of upgrade.filter(plan => plan.host !== "project")) {
      assert.equal(plan.action, "updated", `${plan.host}: previous invocation ${invocation}`);
      assert.equal(removal.find((p) => p.host === plan.host).action, "removed");
      writeText(plan.to, plan.body);
    }
    assert.ok(planSkills(root, { sources: [source] }).every((plan) => plan.action === "unchanged"));
    for (const plan of planSkillRemoval(root, [source]).filter(plan => plan.action !== "absent")) {
      assert.equal(plan.action, "removed");
      removeSkill(plan.to, root);
      assert.ok(!existsSync(plan.to));
    }
  }
});

test("observation-era migration preserves prose additions, edits and mixed command invocations", (t) => {
  const root = scratch(t), oldSource = join(root, "previous-write", "SKILL.md");
  const source = SKILL_SOURCES[1];
  writeText(oldSource, observationWriteBody);
  for (const invocation of ["./node_modules/.bin/sannr", "node '/previous install/bin/cli.mjs'", null]) {
    const original = renderSkill(oldSource, invocation);
    const edits = [original + "\nTeam instruction: retain service-owner attribution.\n",
      original.replace("One fact per note.", "Two facts per note."),
      ...(invocation ? [original.replace(`${invocation} note`, "sannr note")] : [])];
    for (const body of edits) {
      assert.notEqual(body, original);
      for (const host of hosts) writeText(join(root, host, "skills", "sannr-write", "SKILL.md"), body);
      for (const plan of planSkills(root, { sources: [source] }).filter(plan => plan.host !== "project")) assert.equal(plan.action, "differs");
      for (const plan of planSkillRemoval(root, [source]).filter(plan => plan.action !== "absent")) {
        assert.equal(plan.action, "left");
        assert.equal(readFileSync(plan.to, "utf8"), body);
      }
    }
  }
});

test("historical commandless write templates omit absent new regions but still reject unknown commands", t => {
  const root = scratch(t), oldSource = join(root, "previous-write", "SKILL.md");
  for (const previous of [alpha8WriteBody, observationWriteBody, previousSkillBodies["sannr-write"]]) {
    writeText(oldSource, previous);
    const rendered = renderSkill(oldSource, null);
    assert.match(rendered, /repo-local (?:note|CLI)/);
    assert.doesNotMatch(rendered, /sannr (?:note|review|show|graph) ["-]/);
    writeText(oldSource, previous + '\nsannr unexpected "<unmapped>"\n');
    assert.throws(() => renderSkill(oldSource, null), /outside its commandless rendering map/);
  }
});

test("published alpha.8 write guidance upgrades exact canonical and host installs for every generated invocation", t => {
  const root = scratch(t), oldSource = join(root, "alpha8-write", "SKILL.md"), source = SKILL_SOURCES[1];
  writeText(oldSource, alpha8WriteBody);
  assert.equal(createHash("sha256").update(renderSkill(oldSource, PRODUCT)).digest("hex"),
    "a1b18645fee0a636a3f52b827794b5739ef383c5459fd9cdfacb439ca128323f");
  assert.equal(createHash("sha256").update(renderSkill(oldSource, null)).digest("hex"),
    "1135b5a5e4cec711a71c4aec61c033a553cace4fb15d88e3261ab8ca2e63c954");
  const destinations = [join(root, LAYOUT.skills, SKILL_NAMES.write, "SKILL.md"),
    ...hosts.map(host => join(root, host, "skills", SKILL_NAMES.write, "SKILL.md"))];
  for (const invocation of [PRODUCT, "./node_modules/.bin/" + PRODUCT, "node /previous/install/bin/cli.mjs",
    "node '/previous install/bin/cli.mjs'", "node '/previous owner'\\''s install/bin/cli.mjs'",
    `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.8`, null]) {
    const previous = renderSkill(oldSource, invocation);
    for (const destination of destinations) writeText(destination, previous);
    const upgrades = planSkills(root, { sources: [source], cliName: invocation === null ? null : "./node_modules/.bin/" + PRODUCT });
    assert.equal(upgrades.length, 3);
    assert.ok(upgrades.every(plan => plan.action === "updated"), `invocation ${invocation}: ${upgrades.map(plan => `${plan.host}:${plan.action}`)}`);
    const removal = planSkillRemoval(root, [source]).filter(plan => plan.action !== "absent");
    assert.ok(removal.every(plan => plan.action === "removed"), `exact alpha.8 invocation ${invocation} remains removable`);
    for (const plan of upgrades) {
      assert.match(plan.body, /Never edit the knowledge JSON by hand/);
      assert.match(plan.body, /--supersedes sha256:<full-note-digest>/);
      writeText(plan.to, plan.body);
    }
    assert.ok(planSkills(root, { sources: [source], cliName: invocation === null ? null : "./node_modules/.bin/" + PRODUCT })
      .every(plan => plan.action === "unchanged"));
  }
});

test("alpha.8 migration preserves authored prose, appended rules, changed documentation and mixed invocations", t => {
  const source = SKILL_SOURCES[1];
  for (const invocation of ["./node_modules/.bin/" + PRODUCT, "node '/previous install/bin/cli.mjs'",
    `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.8`, null]) {
    const root = scratch(t), oldSource = join(root, "alpha8-write", "SKILL.md");
    writeText(oldSource, alpha8WriteBody);
    const previous = renderSkill(oldSource, invocation);
    const edited = [previous + "\nTeam instruction: retain historical explanations.\n",
      previous.replace("One fact per note.", "Two facts per note."),
      previous.replace("Preserve older claims and explain contradictions.", "Replace outdated claims without retaining them."),
      previous + "\n[Team documentation](https://example.invalid/author-owned).\n",
      ...(invocation ? [previous.replace(`${invocation} note`, `${PRODUCT} note`)] : []),
      ...(invocation?.startsWith("npx ") ? [previous.replace(`${invocation} graph`, `npx --yes ${NPM_PACKAGE}@0.1.0-alpha.7 graph`)] : [])];
    for (const body of edited) {
      assert.notEqual(body, previous);
      // Host edits remain their own copy. A canonical authored addition remains
      // authoritative rather than being silently overwritten during upgrade.
      for (const host of hosts) writeText(join(root, host, "skills", SKILL_NAMES.write, "SKILL.md"), body);
      assert.ok(planSkills(root, { sources: [source] }).filter(plan => plan.host !== "project")
        .every(plan => plan.action === "differs"));
      assert.ok(planSkillRemoval(root, [source]).filter(plan => plan.action !== "absent")
        .every(plan => plan.action === "left"));
      for (const host of hosts) assert.equal(readFileSync(join(root, host, "skills", SKILL_NAMES.write, "SKILL.md"), "utf8"), body);
    }
    const canonical = join(root, LAYOUT.skills, SKILL_NAMES.write, "SKILL.md");
    const authored = previous + "\nTeam instruction: require a service owner.\n";
    writeText(canonical, authored);
    const plan = planSkills(root, { sources: [source] }).find(plan => plan.host === "project");
    assert.equal(plan.action, "unchanged");
    assert.equal(plan.body, authored);
    assert.equal(planSkillRemoval(root, [source]).find(plan => plan.host === "project").action, "left");
  }
});

// Frozen published alpha.8 source (7c4b575), kept as test data only. Runtime
// ownership uses exact digests; no repository history is needed by this test.
const alpha8WriteBody = "---\nname: {{PRODUCT}}-write\ndescription: >-\n  Load this in any repo that carries {{CONTEXT_PATH}}. It is the team's write\n  convention for API knowledge: retrieve relevant prior context, promptly\n  record reusable behavior or corrections with existing evidence, and check\n  the handoff receipt. Use alongside {{PRODUCT}}-request, which routes repo APIs and\n  integrations through Sannr and records scoped observations.\n---\n\n# {{PRODUCT}}-write — record what the spec does not say\n\n**When you learn reusable API behavior absent from the spec, you MUST record\nit before moving on.** Use this workflow:\n\n1. Retrieve inherited context for the operation and environment before\n   rediscovery. Inspect referenced evidence when useful; saved lessons are\n   scoped claims, not proof of current behavior.\n2. While working on and verifying the requested task, preserve the original API\n   evidence, including responses from a program you run, while it is available.\n3. Promptly record one concise lesson or correction with its existing evidence.\n   Prefer the observation receipt below so Sannr handles identity, scope, time\n   and evidence linkage. Preserve older claims and explain contradictions.\n4. Check that the lesson was saved and any configured snapshot was written.\n   Use the team's Git/CI workflow to deliver it and its referenced evidence;\n   a local save alone does not establish that another repo can retrieve it.\n\nThe `{{PRODUCT}}-request` convention routes agent-issued calls to this repository's\nAPIs and integrations through Sannr, including routine calls and health checks.\nAutomatic capture preserves bounded observations; it does not infer a reusable\nlesson or prove an author's explanation. This skill supplies the explicit write\nthat makes such a lesson available to later agents.\nAutomatic observations already retain response shapes. Avoid a second note that\nmerely repeats those shapes; record the behavioral implication or decision the\nnext agent needs.\n\n## When the write triggers\n\nAny of these is a trigger. The test is always the same: the spec does not say\nit, and you now know it.\n\n- **An undocumented required field** — the server 400s without a field the\n  contract marks optional or does not list at all.\n- **A state precondition** — the call only works when the resource is already\n  in some state (\"transition requires status=draft first\").\n- **A field that lies** — the docs say one thing, the server does another\n  (a documented enum value that never occurs, a \"timestamp\" that is a string,\n  a pagination cursor that is not opaque after all).\n- **A rejected integration and why** — you evaluated an API or endpoint and\n  decided NOT to use it. Accepted integrations leave code behind; rejected\n  ones leave nothing unless you write the verdict.\n\nNot triggers: things the spec already says (that is what the spec is for),\ntransient failures (a 503 is weather, not knowledge), and anything containing\na secret (the file is committed; the guard will refuse and you rephrase by\nshape: \"needs a bearer token from the console\", never the token).\n\n## CLI fallback before restart\n\nIf `api_context` or `api_context_record` is not available in this session, use\nthe installed CLI from the repository root. You do not need to restart before\nrecording or retrieving context. For a repository with graph context:\n\n```sh\nsannr graph context \"<provider-node>\" --operation \"<METHOD /path>\" --environment \"<environment>\" --json\nsannr graph record --observation-id \"<actual observation_id>\" --operation-id \"<actual operation_id>\" --note \"<one supported lesson>\" --json\nsannr graph context \"<provider-node>\" --operation \"<METHOD /path>\" --environment \"<environment>\" --json\n```\n\nUse the actual node, operation, environment and receipt identities. The middle\ncommand uses the same saved observation as `api_context_record`; it does not\nmake another API request. For attributed knowledge without a client receipt,\nuse `sannr graph record \"<provider-node>\" --operation \"<METHOD /path>\" --environment \"<environment>\" --protocol \"http\" --note \"<source attribution and unverified lesson>\" --json`.\nPreserve evidence, scope, and snapshot limitations from the receipt.\n\nFor ordinary HTTP context without a graph manifest, retrieve with\n`sannr show \"<METHOD /path>\"`, record the real lesson with the `note` command\nbelow, then run `show` for that operation again and confirm the saved note.\nAttribute its source in the prose: a local note is an authored claim, not an\nexecuted API observation. These record and retrieval commands send no API\nrequests. Do not make a new request or invent a lesson to demonstrate setup.\nWhen no real contract or API knowledge is available, report what is missing.\n\nWhen an invocation starts with npx, it pins the installed package version and\nmay download the package if absent from the npm cache. The post-restart\n\"Finish {{PRODUCT}} setup\" check still confirms MCP activation separately.\n\n## The exact write\n\nIf the repo exposes `api_context_record`, prefer the successful local\n`context_capture` receipt when recording a lesson from that request:\n\n```json\n{\"observation_id\":\"<actual observation_id>\",\"operation_id\":\"<actual operation_id>\",\"note\":\"One reusable lesson, with its uncertainty.\"}\n```\n\nSannr attaches the saved observation's exact provider, operation, environment,\ncontract identity, original time and evidence. `operation_id` is optional;\ninclude it from the same receipt when available. These are capture identities,\nnot the private evidence run ID. Do not reconstruct evidence paths or override\nscope or time in this form. The tool checks that evidence still matches its\nsaved digest; linking old evidence does not renew its applicability.\n\nA consumer can record knowledge about its declared provider without owning\nthat provider's repo. The explanation remains an authored claim; linking an\nobservation does not execute the API or independently verify the explanation.\nRetrieve the applicable prior context first and state changed assumptions or\ncontradictory evidence explicitly instead of silently rewriting history.\n\nKeep **when** and **where** each claim applies explicit. State what the latest\napplicable observation showed and when; call it current only when its freshness\nsupports that claim. Describe older records in the past tense,\nwith their dates or evidence references when available. Different historical\nresponses do not establish that the current API alternates between behaviors.\nFor example: \"Earlier responses used an offset; the latest staging response\nuses a cursor; the transition date is unknown.\" Claim current variability only\nwhen comparable current requests actually demonstrate it.\n\nDistinguish the configured provider from source code, a test fixture or a local\nserver you started. For example: \"The local test server accepts the new filter;\nthe configured staging provider has not been checked.\" Passing local tests does\nnot establish that a deployed provider runs those bytes. Retain the actual\ntarget and environment of the evidence, and leave deployment equivalence\nunresolved unless supported. Tribal knowledge without execution evidence is\nstill worth recording: attribute it to its source, state what is unverified,\nand keep it an authored claim.\n\nFor a lesson without a local client observation, use the explicit\n`node`, `operation`, `note` form with the actual environment and protocol.\nAttribute tribal or imported knowledge and preserve its original `observed_at`\nwhen known. Imported catalog IDs are not local observation handles. For available\nlocal evidence, including request/response artifacts retained by your program,\npass the actual repository-relative file path, such as\n`{\"path\":\"{{EVIDENCE_PATH}}/run-<id>.json\",\"locator\":\"/response/body/counts\"}`.\nFor client evidence, use the actual run ID returned by `api_request.evidence`\nand its configured evidence directory (normally `{{EVIDENCE_PATH}}/`). Preserve method, target, relevant\nrequest and response details in the original evidence artifact, not in shared\nlesson prose. Do not reconstruct discarded responses or call the API again\njust to obtain an observation handle. The optional locator is a JSON pointer\ninside that file, not a run ID or dotted field name. If recording fails,\ncorrect the reference using the tool's guidance; retain available evidence.\nPreserve missing or changed evidence as a reported limitation. Do not refresh a\ndigest, drop a failing evidence link, or rerun the API merely to repair bookkeeping.\nAn evidence link supports inspection but does not verify the authored claim.\n\nIf the team configures `context.snapshot` in `{{GRAPH_MANIFEST_PATH}}`, recording a\nlesson also refreshes that local Git/CI snapshot. Check the receipt: a saved\nlesson with a failed or limited snapshot is an incomplete handoff. Repair the\ndestination or export limitation without recording the lesson again. Git/CI\ndelivery and sharing referenced evidence remain the team's configured workflow.\n\nFor legacy HTTP context, **a gotcha** (the first three triggers) is one `note`:\n\n```\nsannr note \"<METHOD /path>\" \"<one sentence>\"\n```\n\nStructure, so every write reads the same three years on:\n\n- The operation is `METHOD /path` exactly as the contract spells it\n  (`\"POST /orders/{id}/transition\"`) — method uppercase, path with its\n  placeholders, nothing else. Never a full URL.\n- The note is **one sentence**, naming the field or status and using a tense\n  that matches its evidence, symptom first then a supported cause or fix:\n  - `sannr note \"POST /orders\" \"400s without idempotency_key, which the contract marks optional\"`\n  - `sannr note \"GET /users\" \"returns disabled accounts too; filter on status yourself\"`\n  - `sannr note \"GET /orders\" \"cursor is opaque; decoding it breaks on deploy\"`\n- One fact per note. Two facts are two notes.\n\n**A rejected integration** (the fourth trigger) is one `verdict`:\n\n```\nsannr verdict \"<what>\" --verdict rejected --reason \"<one sentence, by shape not value>\" --class <class> [--probe {{SUITES_PATH}}/<name>.json]\n```\n\n- `<what>` names the API or operation evaluated (`\"POST /refunds\"`,\n  `\"vendor-x billing API\"`).\n- `--class` is one of `measured | documented | priced | structural |\n  contextual | judgment` — it tells the next reader HOW to re-check the\n  decision, which prose never does.\n- `--probe` points at a committed envelope that reproduces the reason, when\n  one exists. A verdict with a probe is re-checkable in one command; without\n  one it is an opinion with a date on it.\n- `--verdict accepted` and `deferred` exist too; the write is mandatory for\n  *rejected*, because rejection is the decision that otherwise leaves no trace.\n\n## Why this is hard-lined\n\nVoluntary mid-task capture has no replicated, checked-in measurement in this\nrepository, so the convention does not depend on it. The deterministic paths\n(the client's structural observations and friction signals, `learn --ci`)\nretain or surface what a machine can see;\ndeclared and decisional knowledge requires an explicit write, so that is what\nthe convention mandates. This is a design rule, not a measured adoption result.\n";
