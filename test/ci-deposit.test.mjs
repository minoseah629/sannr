import { LAYOUT } from "../lib/layout.mjs";
import { createFixtureStack, fixtureContextFile } from "./helpers/stack-fixture.mjs";
// WIRED-IN ACCUMULATION (PRD Track C) — capture that does not rely on agent
// goodwill. Two halves, both pinned here before they exist (fail-first):
//
//   1. skill/write-context/SKILL.md — the hard-lined write convention. It
//      mandates the WRITE (record what the spec does not say, with an exact
//      command and structure); tool choice stays free for foreign APIs, while
//      the repository's own API goes through the client (the hook's rule,
//      not this skill's). Distinct from
//      skill/SKILL.md, which is the honest when-to-reach-for-the-tool doc.
//   2. `sannr learn --ci` — the CI deposit: a pipeline run that executes
//      safe reads, promotes what the boundary allows, and writes
//      sannr.json as a committable artifact with NO agent in the loop.
//
//   node --test test/ci-deposit.test.mjs
//
// The load-bearing negatives: a production environment deposits NOTHING (the
// file stays byte-identical), and a dead host must not erase accumulated
// verification the way a plain learn's unreachable-note path does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync,  readFileSync, existsSync } from "node:fs";
import { writeFileSync } from "./helpers/layout-fixture.mjs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { start } from "./fixture-server.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "cli.mjs");

// Exit code AND both streams: the CI tests branch on all three.
const run = (cwd, ...args) => new Promise((res) => {
  execFile("node", [CLI, ...args], { cwd, encoding: "utf8" },
    (err, stdout, stderr) => res({ code: err?.code ?? 0, stdout, stderr }));
});

// Same sandbox as learn-dryrun: one declared enum (tier) so a deposit has both
// a promoted value set and refused fields (id, name) to prove the boundary ran.
function sandbox(origin, { production = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ci-deposit-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "openapi.yaml"), [
    "openapi: 3.0.0",
    "info: { title: fixture, version: '1' }",
    "paths:",
    "  /paginate/page:",
    "    get:",
    "      summary: rows",
    "      responses:",
    "        '200':",
    "          content:",
    "            application/json:",
    "              schema:",
    "                type: object",
    "                properties:",
    "                  data:",
    "                    type: array",
    "                    items:",
    "                      type: object",
    "                      properties:",
    "                        id: { type: integer }",
    "                        name: { type: string }",
    "                        tier: { type: string, enum: [basic, pro] }",
    "",
  ].join("\n"));
  const scope = createFixtureStack(dir, { environment: "ci", baseUrl: origin, contract: "openapi.yaml" });
  const document = scope.document;
  if (production) document.environments.ci.production = true;
  writeFileSync(join(scope.folder, "stack.json"), JSON.stringify(document));
  return dir;
}

const ctxBytes = (dir) => readFileSync(fixtureContextFile(dir));

// --- 1. the hard-lined write skill -----------------------------------------

const WRITE_SKILL = join(ROOT, "skill", "write-context", "SKILL.md");

test("write-context skill exists, distinct from the honest use-skill", () => {
  assert.ok(existsSync(WRITE_SKILL), "skill/write-context/SKILL.md must exist");
  const write = readFileSync(WRITE_SKILL, "utf8");
  const use = readFileSync(join(ROOT, "skill", "SKILL.md"), "utf8");
  const nameOf = (t) => /^name:\s*(\S+)/m.exec(t)?.[1];
  assert.ok(nameOf(write), "the skill carries frontmatter with a name");
  assert.notEqual(nameOf(write), nameOf(use),
    "two skills, two names — the write convention is not the client's skill");
});

test("write-context skill mandates the WRITE with the exact command and structure", () => {
  const text = readFileSync(WRITE_SKILL, "utf8");
  // The mandate itself — a convention, stated as one ("you MUST record").
  assert.match(text, /MUST record/,
    "the skill hard-lines the write; F6c says a suggestion is a no-op");
  // The exact commands, so the write is consistent across agents and sessions.
  assert.match(text, /sannr note "/, "the gotcha command is spelled out verbatim");
  assert.match(text, /sannr verdict /, "the rejected-integration command is spelled out verbatim");
  // The trigger classes the ticket names — an agent must recognise the moment.
  for (const trigger of [/undocumented required field/i, /state precondition/i,
                         /field that lies/i, /rejected/i])
    assert.match(text, trigger, `the skill names the trigger ${trigger}`);
  // One-sentence structure is explicit, not implied.
  assert.match(text, /one sentence/i, "the note format is stated, so writes stay consistent");
});

test("write-context separates authored lessons from automatic repo API observations", () => {
  const text = readFileSync(WRITE_SKILL, "utf8");
  assert.match(text, /\{\{PRODUCT\}\}-request.*convention routes agent-issued calls/s);
  assert.match(text, /APIs and integrations through Sannr, including routine calls and health checks/);
  assert.match(text, /does not infer a reusable\nlesson/);
  assert.match(text, /remains an authored claim/);
  assert.match(text, /observation does not execute the API or independently verify the explanation/);
  assert.match(text, /MUST record/);
  assert.doesNotMatch(text, /tool choice is your judgment|never tells you which tool/);
});

// --- 2. the CI deposit -------------------------------------------------------

test("learn --ci deposits promoted context non-interactively, boundary intact", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await run(dir, "init");
    const { code, stdout } = await run(dir, "learn", "--ci");
    assert.equal(code, 0, "a clean deposit exits 0");
    const out = JSON.parse(stdout);
    assert.equal(out.ci, true, "the run identifies itself as a CI deposit");
    assert.ok(out.wrote?.endsWith(`${LAYOUT.collection}/fixture/sannr.json`), "the artifact path is reported");
    const ctx = JSON.parse(ctxBytes(dir).toString());
    const entry = ctx.operations["GET /paginate/page"];
    // The boundary ran: declared enum values promoted, everything else refused.
    assert.deepEqual([...entry.fields.tier.values].sort(), ["basic", "pro"]);
    assert.ok(entry.withheld >= 1, "refused fields are counted, not silently dropped");
    assert.ok(!/item-\d/.test(ctxBytes(dir).toString()),
      "a refused value never reaches the committed artifact");
  } finally { await f.close(); }
});

test("learn --ci against a production environment writes NOTHING and fails loudly", async () => {
  const f = await start();
  const dir = sandbox(f.origin, { production: true });
  try {
    await run(dir, "init");
    const before = ctxBytes(dir);
    const { code, stderr } = await run(dir, "learn", "--ci");
    assert.notEqual(code, 0, "a production deposit is a misconfiguration, not a quiet no-op");
    assert.match(stderr, /CI_DEPOSIT_PRODUCTION/);
    assert.ok(before.equals(ctxBytes(dir)),
      "production writes nothing — the file is byte-identical");
  } finally { await f.close(); }
});

test("learn --ci against a dead host deposits nothing and never erases verification", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await run(dir, "init");
    await run(dir, "learn");                 // accumulate a real verified entry first
    const before = ctxBytes(dir);
    await f.close();                          // now the host is dead
    const { code, stderr } = await run(dir, "learn", "--ci");
    assert.notEqual(code, 0, "an unreachable service must pull CI's one lever");
    assert.match(stderr, /CI_DEPOSIT_UNREACHABLE/);
    // A plain learn records unreachability INTO the file (verified_at nulled).
    // Right for a human at a terminal; wrong for CI, where a network blip must
    // not destroy accumulated verification in a committed artifact.
    assert.ok(before.equals(ctxBytes(dir)),
      "a blip deposits nothing; it must not erase what previous runs verified");
  } finally { /* already closed */ }
});

test("learn --ci refuses --dry-run: one run cannot both write and not-write", async () => {
  const f = await start();
  const dir = sandbox(f.origin);
  try {
    await run(dir, "init");
    const { code, stderr } = await run(dir, "learn", "--ci", "--dry-run");
    assert.notEqual(code, 0);
    assert.match(stderr, /CI_AND_DRY_RUN/);
  } finally { await f.close(); }
});
